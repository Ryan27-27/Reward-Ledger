import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, startServer, stopServer, signup, fund, seedItem, key, pool, tx, walletOf, processOutbox, sentLog } from './helpers.js';
import { verifyWallet, verifyAll, postJournal } from '../src/services/ledger.js';
import { runExpiry } from '../src/services/expiry.js';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);

const redeem = (u, itemId, k = key()) => api('POST', '/api/redemptions', { token: u.token, body: { itemId }, headers: { 'Idempotency-Key': k } });

test('the ledger cannot be edited, deleted or truncated — not even by raw SQL', async () => {
  const u = await signup(); await fund(u, 500);
  await pool.query(`INSERT INTO admin_audit_log (action) VALUES ('TEST')`); // row triggers need a row to fire on
  for (const sql of [
    `UPDATE ledger_entries SET amount = 999999`, `DELETE FROM ledger_entries`, `TRUNCATE ledger_entries`,
    `UPDATE journals SET description = 'hacked'`, `DELETE FROM journals`, `TRUNCATE journals`, `UPDATE admin_audit_log SET action = 'x'`,
  ]) {
    await assert.rejects(pool.query(sql), (e) => e.code === '55000' || e.code === '0A000', sql); // 0A000: FK-referenced tables are un-truncatable even before the trigger fires
  }
});

test('double entry is enforced by the database: an unbalanced journal cannot commit', async () => {
  const u = await signup(); const w = await walletOf(u.user.id);
  await assert.rejects(tx(async (c) => {
    const { rows: [j] } = await c.query(
      `INSERT INTO journals (kind, account_id, idempotency_key, request_hash) VALUES ('GRANT',$1,'unbalanced','x') RETURNING id`, [w.id]);
    await c.query(`INSERT INTO ledger_entries (journal_id, account_id, direction, amount, created_at) VALUES ($1,$2,'CREDIT',50,now())`, [j.id, w.id]);
  }), /unbalanced/);
});

test('balance can never go negative, even if the application check is bypassed', async () => {
  const u = await signup(); const w = await walletOf(u.user.id);
  await assert.rejects(pool.query('UPDATE accounts SET balance = -1 WHERE id=$1', [w.id]), /balance_never_negative/);
});

test('concurrent redemptions cannot double-spend: exactly one of five wins', async () => {
  const u = await signup(); await fund(u, 1000);
  const item = await seedItem({ points_cost: 600 });
  const results = await Promise.all(Array.from({ length: 5 }, () => redeem(u, item.id)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_BALANCE').length, 4);
  assert.equal((await walletOf(u.user.id)).balance, 400);
  assert.equal((await verifyWallet((await walletOf(u.user.id)).id)).ok, true);
});

test('stock cannot be oversold under concurrency', async () => {
  const item = await seedItem({ points_cost: 10, stock: 3 });
  const users = await Promise.all(Array.from({ length: 6 }, async () => { const u = await signup(); await fund(u, 100); return u; }));
  const results = await Promise.all(users.map((u) => redeem(u, item.id)));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.body?.error?.code === 'OUT_OF_STOCK').length, 3);
  assert.equal((await pool.query('SELECT stock FROM catalog_items WHERE id=$1', [item.id])).rows[0].stock, 0);
});

test('idempotency: same key replays the original result; reuse for a different request is a 409', async () => {
  const u = await signup(); await fund(u, 1000);
  const a = await seedItem({ points_cost: 100 }), b = await seedItem({ points_cost: 200 });
  const k = key();
  const first = await redeem(u, a.id, k);
  const second = await redeem(u, a.id, k);
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  assert.equal(second.body.redemption.voucher_code, first.body.redemption.voucher_code);
  assert.equal((await walletOf(u.user.id)).balance, 900);
  const reuse = await redeem(u, b.id, k);
  assert.equal(reuse.status, 409); assert.equal(reuse.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('ten simultaneous identical requests with the same key produce exactly one debit', async () => {
  const u = await signup(); await fund(u, 1000);
  const item = await seedItem({ points_cost: 100 }); const k = key();
  const rs = await Promise.all(Array.from({ length: 10 }, () => redeem(u, item.id, k)));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal((await walletOf(u.user.id)).balance, 900);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM journals WHERE account_id=$1 AND kind='REDEEM'`, [(await walletOf(u.user.id)).id])).rows[0].n, 1);
});

test('tampering with history is detected by the hash chain', async () => {
  const u = await signup(); const w = await fund(u, 300); await fund(u, 200);
  assert.equal((await verifyWallet(w.id)).ok, true);
  await pool.query('ALTER TABLE ledger_entries DISABLE TRIGGER entries_immutable'); // a DBA with superuser rights…
  try {
    await pool.query(`UPDATE ledger_entries SET amount = 301 WHERE account_id=$1 AND seq=1`, [w.id]); // …quietly edits history
  } finally { await pool.query('ALTER TABLE ledger_entries ENABLE TRIGGER entries_immutable'); }
  const r = await verifyWallet(w.id);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /hash mismatch/.test(p)), r.problems.join('; '));
  assert.equal((await verifyAll()).ok, false);
});

test('points expire first-in-first-out, and the audit still reconciles', async () => {
  const u = await signup(); const w = await walletOf(u.user.id);
  const past = new Date(Date.now() - 86_400_000);
  await fund(u, 300, past); await fund(u, 700);
  const item = await seedItem({ points_cost: 200 });
  assert.equal((await redeem(u, item.id)).status, 201); // consumes the soonest-expiring lot first (the expired one)
  assert.equal((await walletOf(u.user.id)).balance, 800);
  const n = await runExpiry();
  assert.ok(n >= 1);
  assert.equal((await walletOf(u.user.id)).balance, 700); // 300 − 200 spent = 100 expired
  const again = await runExpiry(); assert.equal(again, 0); // idempotent
  assert.equal((await verifyWallet(w.id)).ok, true);
  await processOutbox();
  assert.ok(sentLog.some((m) => m.to === u.email && /expired/i.test(m.subject)));
});

test('refusing to overdraw through the service layer too', async () => {
  const u = await signup(); const w = await fund(u, 50);
  await assert.rejects(tx((c) => postJournal(c, { kind: 'REDEEM', walletId: w.id, direction: 'DEBIT', amount: 51, systemCode: 'REDEMPTION', idempotencyKey: key(), requestHash: 'x' })),
    (e) => e.code === 'INSUFFICIENT_BALANCE');
});
