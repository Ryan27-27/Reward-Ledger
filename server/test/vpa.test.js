import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, startServer, stopServer, signup, key, pool, walletOf, inrOf, addMoney, config } from './helpers.js';
import { verifyWallet, verifyAll } from '../src/services/ledger.js';
import { backfillVpas, sanitize } from '../src/services/vpa.js';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);

const wallet = async (u) => (await api('GET', '/api/money/wallet', { token: u.token })).body;
const pts = async (u) => (await walletOf(u.user.id)).balance;
const send = (u, to, amountPaise, k = key()) => api('POST', '/api/money/transfer', { token: u.token, body: { to, amountPaise }, headers: { 'Idempotency-Key': k } });
const pay = (u, body) => api('POST', '/api/payments', { token: u.token, body, headers: { 'Idempotency-Key': key() } });

test('every member gets a unique payment address at registration', async () => {
  const a = await signup({ name: 'Riya Demo' }), b = await signup({ name: 'Riya Demo' }); // same name twice
  const wa = await wallet(a), wb = await wallet(b);
  assert.equal(wa.vpa, 'riya.demo@pointwise');
  assert.notEqual(wb.vpa, wa.vpa); assert.match(wb.vpa, /^riya\.demo\d+@pointwise$/);
  assert.equal((await api('GET', '/api/money/vpa', { token: a.token })).body.address, wa.vpa);
  assert.match(wa.vpa.split('@')[0], /^[a-z0-9][a-z0-9._-]{2,29}$/);
});

test('handles are sanitised and reserved names are never handed out', async () => {
  assert.equal(sanitize('José  Álvarez!!'), 'jose.alvarez');
  assert.equal(sanitize('  ..__x'), '');           // too short → falls back to the email name
  const admin = await signup({ name: 'Admin' });
  assert.notEqual((await wallet(admin)).vpa.split('@')[0], 'admin');
  const weird = await signup({ name: '🙂🙂' });     // nothing usable in the name → uses the email local part
  assert.match((await wallet(weird)).vpa, /^[a-z0-9]+@pointwise$/);
});

test('pay by payment address: lookup is masked, case-insensitive, and unknown / own addresses are refused', async () => {
  const a = await signup({ name: 'Asha Sender' }), b = await signup({ name: 'Bala Receiver' }); await addMoney(a, 100_000);
  const addr = (await wallet(b)).vpa;
  const look = await api('GET', `/api/money/recipient?to=${encodeURIComponent(addr.toUpperCase())}`, { token: a.token });
  assert.equal(look.status, 200); assert.match(look.body.name, /^B\*+ R\*+$/);
  assert.equal((await send(a, addr.toUpperCase(), 25_000)).status, 201);
  assert.equal((await wallet(b)).balance, 25_000);
  assert.equal((await send(a, 'nobody.here@pointwise', 1000)).body.error.code, 'RECIPIENT_NOT_FOUND');
  assert.equal((await send(a, (await wallet(a)).vpa, 1000)).body.error.code, 'SELF_TRANSFER');
  assert.equal((await send(a, b.email, 1000)).status, 201); // email still works
  assert.equal((await api('POST', '/api/money/transfer', { token: a.token, body: { amountPaise: 1000 }, headers: { 'Idempotency-Key': key() } })).body.error.code, 'PAYEE_REQUIRED');
});

test('suspended or unverified members cannot be paid', async () => {
  const a = await signup(), b = await signup(); await addMoney(a, 10_000);
  await pool.query(`UPDATE users SET status='SUSPENDED' WHERE id=$1`, [b.user.id]);
  assert.equal((await send(a, (await pool.query('SELECT handle FROM vpas WHERE user_id=$1', [b.user.id])).rows[0].handle + '@pointwise', 1000)).body.error.code, 'RECIPIENT_NOT_FOUND');
});

test('PAYING EACH OTHER IN A LOOP EARNS NOTHING: 60 transfers back and forth → zero points, money conserved', async () => {
  const a = await signup(), b = await signup(); await addMoney(a, 100_000); await addMoney(b, 100_000);
  const [va, vb] = [(await wallet(a)).vpa, (await wallet(b)).vpa];
  for (let i = 0; i < 20; i++) { await send(a, vb, 50_000); await send(b, va, 50_000); await send(a, vb, 30_000); }
  await Promise.all([...Array.from({ length: 10 }, () => send(a, vb, 1_000)), ...Array.from({ length: 10 }, () => send(b, va, 1_000))]); // opposing, simultaneous
  assert.equal(await pts(a), 0); assert.equal(await pts(b), 0);
  assert.equal((await wallet(a)).balance + (await wallet(b)).balance, 200_000);
  const ids = [(await walletOf(a.user.id)).id, (await walletOf(b.user.id)).id];
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int n FROM journals WHERE account_id = ANY($1) AND kind IN ('EARN','REFERRAL','GRANT')`, [ids]);
  assert.equal(n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM payments WHERE account_id = ANY($1)`, [ids])).rows[0].n, 0);
  for (const u of [a, b]) assert.equal((await verifyWallet((await inrOf(u.user.id)).id)).ok, true);
});

test('the database itself refuses to mint reward points outside a payment', async () => {
  const u = await signup(); const w = await walletOf(u.user.id);
  await assert.rejects(pool.query(`INSERT INTO journals (kind, account_id, idempotency_key, request_hash) VALUES ('EARN',$1,'sneaky','x')`, [w.id]), /earn_needs_payment/);
  await assert.rejects(pool.query(`INSERT INTO journals (kind, account_id, idempotency_key, request_hash, reference_type) VALUES ('EARN',$1,'sneaky2','x','user')`, [w.id]), /earn_needs_payment/);
});

test('no free-money cycle: spending and converting back always returns far less than was spent', async () => {
  const u = await signup(); await addMoney(u, 2_000_000);
  const { fundTreasury } = await import('./helpers.js'); await fundTreasury(5_000_000);
  const r = await pay(u, { category: 'SHOPPING', amountPaise: 1_000_000, method: 'WALLET' }); // ₹10,000 at the best base rate
  const earned = r.body.payment.points_awarded;                                               // 800 + 50 bonus
  const cashBack = earned * config.conversion.paisePerPoint;
  assert.ok(cashBack < 1_000_000 * 0.01, `cash value of rewards ${cashBack} should be < 1% of spend`);
  assert.equal(earned, 850);
});

test('first-payment bonus needs a real payment: ₹1 sign-up payments earn no bonus and trigger no referral', async () => {
  const ref = await signup(); const friend = await signup({ referralCode: ref.user.referralCode });
  const tiny = await pay(friend, { category: 'SHOPPING', amountPaise: 100 }); // ₹1
  assert.equal(tiny.body.payment.points_awarded, 0);
  const prev = await api('POST', '/api/payments/preview', { token: friend.token, body: { category: 'SHOPPING', amountPaise: 20_000 } });
  assert.equal(prev.body.bonus, 50); // the bonus is still available for a qualifying payment
  const { processOutbox } = await import('./helpers.js'); await processOutbox();
  assert.equal(await pts(ref), 0);
  const real = await pay(friend, { category: 'SHOPPING', amountPaise: 20_000 }); // ₹200
  assert.equal(real.body.payment.points_awarded, 16 + 50);
  await processOutbox(); await processOutbox();
  assert.equal(await pts(ref), config.rewards.referralBonus);
  const again = await pay(friend, { category: 'SHOPPING', amountPaise: 20_000 });
  assert.equal(again.body.payment.points_awarded, 16); // bonus only once
});

test('existing members without an address get one on the next start (backfill is idempotent)', async () => {
  const u = await signup();
  await pool.query('DELETE FROM vpas WHERE user_id=$1', [u.user.id]);
  assert.equal(await backfillVpas(), 1);
  assert.equal(await backfillVpas(), 0);
  assert.match((await wallet(u)).vpa, /@pointwise$/);
  assert.equal((await verifyAll()).ok, true);
});
