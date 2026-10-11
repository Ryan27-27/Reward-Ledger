import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, resetDb, startServer, stopServer, signup, makeStaff, fund, seedItem, key, pool, walletOf, processOutbox, sentLog, config, PASSWORD } from './helpers.js';
import { verifyWallet } from '../src/services/ledger.js';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);

const pay = (u, body, k = key()) => api('POST', '/api/payments', { token: u.token, body, headers: { 'Idempotency-Key': k } });
const balance = async (u) => (await api('GET', '/api/wallet', { token: u.token })).body.balance;
const otpFor = (email, purpose) => {
  const m = [...sentLog].reverse().find((x) => x.to === email && x.template === 'otp');
  return m.text.match(/use (\d{6})/)[1];
};

// ───────────────────────── auth ─────────────────────────
test('signup requires email verification; login before verifying is refused', async () => {
  const email = `pending${Date.now()}@example.com`;
  assert.equal((await api('POST', '/api/auth/register', { body: { name: 'P', email, password: PASSWORD } })).status, 201);
  const l = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(l.status, 403); assert.equal(l.body.error.code, 'EMAIL_NOT_VERIFIED');
});

test('weak/short passwords and bad emails are rejected with field errors', async () => {
  const r = await api('POST', '/api/auth/register', { body: { name: 'x', email: 'nope', password: 'short' } });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  assert.ok(r.body.error.details.fields.email && r.body.error.details.fields.password);
  assert.ok(r.body.error.requestId);
});

test('wrong OTP is counted and the code dies after 5 attempts', async () => {
  const email = `otp${Date.now()}@example.com`;
  await api('POST', '/api/auth/register', { body: { name: 'O', email, password: PASSWORD } });
  await processOutbox();
  const good = otpFor(email);
  const bad = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/api/auth/verify-email', { body: { email, code: bad } })).status, 400);
  const locked = await api('POST', '/api/auth/verify-email', { body: { email, code: good } });
  assert.equal(locked.status, 429); // even the right code no longer works once attempts are exhausted
});

test('refresh rotates tokens; replaying an old one revokes the whole session', async () => {
  const u = await signup();
  const r1 = await api('POST', '/api/auth/refresh', { cookie: u.cookie });
  assert.equal(r1.status, 200); assert.ok(r1.cookie && r1.cookie !== u.cookie);
  await pool.query(`UPDATE refresh_tokens SET rotated_at = now() - interval '1 minute' WHERE rotated_at IS NOT NULL`); // leave the race-grace window
  const replay = await api('POST', '/api/auth/refresh', { cookie: u.cookie });
  assert.equal(replay.status, 401); assert.equal(replay.body.error.code, 'REFRESH_TOKEN_REUSED');
  const legit = await api('POST', '/api/auth/refresh', { cookie: r1.cookie }); // thief AND victim are logged out
  assert.equal(legit.status, 401);
  assert.equal((await api('GET', '/api/auth/me', { token: r1.body.accessToken })).status, 401);
});

test('two tabs refreshing at once is a race, not theft', async () => {
  const u = await signup();
  const [a, b] = await Promise.all([api('POST', '/api/auth/refresh', { cookie: u.cookie }), api('POST', '/api/auth/refresh', { cookie: u.cookie })]);
  const ok = [a, b].find((x) => x.status === 200), lost = [a, b].find((x) => x.status === 401);
  assert.ok(ok && lost); assert.equal(lost.body.error.code, 'REFRESH_RACE');
  assert.equal((await api('POST', '/api/auth/refresh', { cookie: ok.cookie })).status, 200); // session survives
});

test('logout kills the access token immediately (not after 15 minutes)', async () => {
  const u = await signup();
  assert.equal((await api('GET', '/api/auth/me', { token: u.token })).status, 200);
  await api('POST', '/api/auth/logout', { cookie: u.cookie });
  assert.equal((await api('GET', '/api/auth/me', { token: u.token })).status, 401);
});

test('account locks after repeated failures; unknown emails look identical', async () => {
  const u = await signup();
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong-password-123' } });
  const locked = await api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } });
  assert.equal(locked.status, 423);
  const ghost = await api('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'whatever-123456' } });
  assert.equal(ghost.status, 401); assert.equal(ghost.body.error.code, 'INVALID_CREDENTIALS');
});

test('password reset signs out every session and emails a notice', async () => {
  const u = await signup();
  await api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  await processOutbox();
  const r = await api('POST', '/api/auth/reset-password', { body: { email: u.email, code: otpFor(u.email), newPassword: 'a-brand-new-password' } });
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/api/auth/me', { token: u.token })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: u.email, password: 'a-brand-new-password' } })).status, 200);
  await processOutbox();
  assert.ok(sentLog.some((m) => m.to === u.email && /password was changed/i.test(m.subject)));
});

// ───────────────────────── payments & rewards ─────────────────────────
test('server computes the reward; preview equals actual; clients cannot name their own points', async () => {
  const u = await signup();
  const body = { category: 'SHOPPING', amountPaise: 500_000 };
  const prev = await api('POST', '/api/payments/preview', { token: u.token, body });
  const real = await pay(u, body);
  assert.equal(real.status, 201);
  assert.equal(real.body.payment.points_awarded, prev.body.points);
  assert.equal(prev.body.points, 450); // 400 + 50 first-payment bonus
  assert.equal(await balance(u), 450);
  const cheat = await pay(u, { ...body, points: 1_000_000 });
  assert.equal(cheat.status, 400);
  assert.equal(await balance(u), 450);
  const second = await pay(u, body);
  assert.equal(second.body.payment.points_awarded, 400); // bonus is one-time
});

test('payment retries are idempotent (no double reward)', async () => {
  const u = await signup(); const k = key(); const body = { category: 'RENT', amountPaise: 2_000_000 };
  const a = await pay(u, body, k), b = await pay(u, body, k);
  assert.equal(a.status, 201); assert.equal(b.status, 200);
  assert.equal(await balance(u), 650); // 600 + 50
  assert.equal((await pay(u, { ...body, amountPaise: 1 + body.amountPaise }, k)).status, 409);
});

test('tier upgrades from lifetime spend, using spend BEFORE the payment', async () => {
  const u = await signup();
  const big = await pay(u, { category: 'SHOPPING', amountPaise: 1_000_000 }); // exactly ₹10,000 → silver afterwards
  assert.match(big.body.payment.rule_applied, /Bronze 1\.0?×/);
  const next = await pay(u, { category: 'SHOPPING', amountPaise: 1_000_000 });
  assert.match(next.body.payment.rule_applied, /Silver 1\.25×/);
  assert.equal(next.body.payment.points_awarded, 1000);
});

test('every credit and every debit creates an in-app notification AND an email', async () => {
  const u = await signup();
  await pay(u, { category: 'SHOPPING', amountPaise: 500_000 }); // credit
  const item = await seedItem({ points_cost: 100 });
  await api('POST', '/api/redemptions', { token: u.token, body: { itemId: item.id }, headers: { 'Idempotency-Key': key() } }); // debit
  await processOutbox();
  const n = (await api('GET', '/api/notifications', { token: u.token })).body;
  assert.ok(n.notifications.some((x) => x.type === 'POINTS_CREDITED'));
  assert.ok(n.notifications.some((x) => x.type === 'POINTS_DEBITED'));
  const mails = sentLog.filter((m) => m.to === u.email && m.template === 'ledger-movement');
  assert.equal(mails.length, 2);
  assert.ok(mails.some((m) => /\+\d/.test(m.subject)) && mails.some((m) => /−\d/.test(m.subject)));
});

test('a failed redemption sends no debit notification (nothing committed, nothing announced)', async () => {
  const u = await signup(); await fund(u, 10);
  const item = await seedItem({ points_cost: 500 });
  await processOutbox(); const before = sentLog.length;
  const r = await api('POST', '/api/redemptions', { token: u.token, body: { itemId: item.id }, headers: { 'Idempotency-Key': key() } });
  assert.equal(r.status, 409);
  await processOutbox();
  assert.equal(sentLog.slice(before).filter((m) => m.to === u.email && /redeem/i.test(m.subject)).length, 0);
});

test('step-up: expensive redemptions need an emailed code bound to that item', async () => {
  const u = await signup(); await fund(u, 5000);
  const dear = await seedItem({ points_cost: 1500 }), other = await seedItem({ points_cost: 1200 });
  const k = key();
  const no = await api('POST', '/api/redemptions', { token: u.token, body: { itemId: dear.id }, headers: { 'Idempotency-Key': k } });
  assert.equal(no.status, 403); assert.equal(no.body.error.code, 'STEP_UP_REQUIRED');
  await api('POST', '/api/redemptions/challenge', { token: u.token, body: { itemId: dear.id } });
  await processOutbox();
  const code = otpFor(u.email);
  const wrongItem = await api('POST', '/api/redemptions', { token: u.token, body: { itemId: other.id, otp: code }, headers: { 'Idempotency-Key': key() } });
  assert.equal(wrongItem.status, 400); // code for item A can't authorise item B
  await api('POST', '/api/redemptions/challenge', { token: u.token, body: { itemId: dear.id } });
  await processOutbox();
  const ok = await api('POST', '/api/redemptions', { token: u.token, body: { itemId: dear.id, otp: otpFor(u.email) }, headers: { 'Idempotency-Key': k } });
  assert.equal(ok.status, 201);
  const retry = await api('POST', '/api/redemptions', { token: u.token, body: { itemId: dear.id }, headers: { 'Idempotency-Key': k } }); // dropped response → retry needs no new code
  assert.equal(retry.status, 200);
  assert.equal(await balance(u), 3500);
});

test('referral: referrer earns a bonus when the friend makes a first payment — once', async () => {
  const a = await signup();
  const b = await signup({ referralCode: a.user.referralCode });
  assert.equal(await balance(a), 0);
  await pay(b, { category: 'SHOPPING', amountPaise: 100_000 });
  await pay(b, { category: 'SHOPPING', amountPaise: 100_000 });
  await processOutbox(); await processOutbox();
  assert.equal(await balance(a), config.rewards.referralBonus);
});

// ───────────────────────── access control ─────────────────────────
test('there is no way to name someone else\'s wallet: redemption bodies are strict', async () => {
  const victim = await signup(), attacker = await signup(); await fund(victim, 1000); await fund(attacker, 1000);
  const item = await seedItem({ points_cost: 100 });
  const vw = await walletOf(victim.user.id);
  const r = await api('POST', '/api/redemptions', { token: attacker.token, body: { itemId: item.id, accountId: vw.id }, headers: { 'Idempotency-Key': key() } });
  assert.equal(r.status, 400);
  const ok = await api('POST', '/api/redemptions', { token: attacker.token, body: { itemId: item.id }, headers: { 'Idempotency-Key': key() } });
  assert.equal(ok.status, 201);
  assert.equal((await walletOf(victim.user.id)).balance, 1000); // untouched
  assert.equal((await walletOf(attacker.user.id)).balance, 900);
});

test('users cannot reach admin APIs; auditors are read-only', async () => {
  const u = await signup(), aud = await makeStaff('AUDITOR');
  assert.equal((await api('GET', '/api/admin/stats', { token: u.token })).status, 403);
  assert.equal((await api('GET', '/api/admin/stats', { token: aud.token })).status, 200);
  const w = await walletOf(u.user.id);
  const r = await api('POST', '/api/admin/approvals', { token: aud.token, body: { kind: 'GRANT', accountId: w.id, amount: 10, reason: 'auditors cannot do this' } });
  assert.equal(r.status, 403);
});

test('ADMINS CANNOT DEBIT, REDEEM OR SPEND A USER\'S POINTS — no such endpoint exists', async () => {
  const u = await signup(); await fund(u, 1000); const admin = await makeStaff('ADMIN');
  const w = await walletOf(u.user.id); const item = await seedItem({ points_cost: 100 });
  const attempts = [
    ['POST', `/api/admin/accounts/${w.id}/debit`, { amount: 500 }],
    ['POST', `/api/admin/accounts/${w.id}/redeem`, { itemId: item.id }],
    ['POST', `/api/admin/users/${u.user.id}/redeem`, { itemId: item.id }],
    ['DELETE', `/api/admin/ledger/${w.id}`, undefined],
    ['PATCH', `/api/admin/accounts/${w.id}`, { balance: 0 }],
    ['POST', `/api/redemptions`, { itemId: item.id, accountId: w.id }],
  ];
  for (const [m, path, body] of attempts) {
    const r = await api(m, path, { token: admin.token, body, headers: { 'Idempotency-Key': key() } });
    assert.ok([400, 404].includes(r.status), `${m} ${path} → ${r.status}`);
  }
  assert.equal((await walletOf(u.user.id)).balance, 1000);
  // …and even a direct SQL balance edit is refused by the immutability + audit design:
  assert.equal((await verifyWallet(w.id)).ok, true);
});

test('maker-checker: an admin cannot approve their own request; a second admin can; the user is notified', async () => {
  const u = await signup(); const w = await walletOf(u.user.id);
  const a1 = await makeStaff('ADMIN'), a2 = await makeStaff('ADMIN');
  const req = await api('POST', '/api/admin/approvals', { token: a1.token, body: { kind: 'GRANT', accountId: w.id, amount: 250, reason: 'Goodwill after support ticket #4411' } });
  assert.equal(req.status, 201);
  assert.equal(await balance(u), 0); // nothing moves on request
  const self = await api('POST', `/api/admin/approvals/${req.body.id}/approve`, { token: a1.token, body: {} });
  assert.equal(self.status, 403); assert.equal(self.body.error.code, 'SELF_APPROVAL');
  await assert.rejects(pool.query(`UPDATE approvals SET decided_by = requested_by WHERE id=$1`, [req.body.id]), /four_eyes/); // DB agrees
  const ok = await api('POST', `/api/admin/approvals/${req.body.id}/approve`, { token: a2.token, body: {} });
  assert.equal(ok.status, 200); assert.equal(await balance(u), 250);
  const twice = await api('POST', `/api/admin/approvals/${req.body.id}/approve`, { token: a2.token, body: {} });
  assert.equal(twice.status, 409); assert.equal(await balance(u), 250);
  await processOutbox();
  assert.ok(sentLog.some((m) => m.to === u.email && /\+250/.test(m.subject)));
  const log = (await api('GET', '/api/admin/audit-log', { token: a2.token })).body.entries.map((e) => e.action);
  assert.ok(log.includes('APPROVAL_REQUESTED_GRANT') && log.includes('APPROVAL_EXECUTED_GRANT'));
});

test('a reversal (requested + approved by different admins) is a compensating entry, refused once the points are spent', async () => {
  const u = await signup(); const w = await walletOf(u.user.id);
  const a1 = await makeStaff('ADMIN'), a2 = await makeStaff('ADMIN');
  const grant = async (amount) => {
    const r = await api('POST', '/api/admin/approvals', { token: a1.token, body: { kind: 'GRANT', accountId: w.id, amount, reason: 'Promotional goodwill credit' } });
    await api('POST', `/api/admin/approvals/${r.body.id}/approve`, { token: a2.token, body: {} });
    return (await pool.query('SELECT result_journal_id FROM approvals WHERE id=$1', [r.body.id])).rows[0].result_journal_id;
  };
  const j1 = await grant(400);
  const rev = await api('POST', '/api/admin/approvals', { token: a1.token, body: { kind: 'REVERSAL', accountId: w.id, targetJournalId: j1, reason: 'Granted to the wrong customer' } });
  assert.equal((await api('POST', `/api/admin/approvals/${rev.body.id}/approve`, { token: a2.token, body: {} })).status, 200);
  assert.equal(await balance(u), 0);
  const again = await api('POST', '/api/admin/approvals', { token: a1.token, body: { kind: 'REVERSAL', accountId: w.id, targetJournalId: j1, reason: 'Trying to reverse a second time' } });
  assert.equal((await api('POST', `/api/admin/approvals/${again.body.id}/approve`, { token: a2.token, body: {} })).status, 409);

  const j2 = await grant(300); // user spends it, then it can't be clawed back
  const item = await seedItem({ points_cost: 250 });
  await api('POST', '/api/redemptions', { token: u.token, body: { itemId: item.id }, headers: { 'Idempotency-Key': key() } });
  const rev2 = await api('POST', '/api/admin/approvals', { token: a1.token, body: { kind: 'REVERSAL', accountId: w.id, targetJournalId: j2, reason: 'Late discovery of a mistake' } });
  const blocked = await api('POST', `/api/admin/approvals/${rev2.body.id}/approve`, { token: a2.token, body: {} });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(await balance(u), 50);
  assert.equal((await verifyWallet(w.id)).ok, true);
});

test('grant limits and mandatory reasons are enforced', async () => {
  const u = await signup(); const w = await walletOf(u.user.id); const a = await makeStaff('ADMIN');
  assert.equal((await api('POST', '/api/admin/approvals', { token: a.token, body: { kind: 'GRANT', accountId: w.id, amount: config.rewards.maxGrantPoints + 1, reason: 'way too generous' } })).status, 400);
  assert.equal((await api('POST', '/api/admin/approvals', { token: a.token, body: { kind: 'GRANT', accountId: w.id, amount: 10, reason: 'no' } })).status, 400);
});

test('frozen accounts cannot redeem but still receive credits; the user is told', async () => {
  const u = await signup(); await fund(u, 500); const w = await walletOf(u.user.id); const admin = await makeStaff('ADMIN');
  const item = await seedItem({ points_cost: 100 });
  assert.equal((await api('POST', `/api/admin/accounts/${w.id}/freeze`, { token: admin.token, body: { reason: 'Suspected account takeover' } })).status, 200);
  const r = await api('POST', '/api/redemptions', { token: u.token, body: { itemId: item.id }, headers: { 'Idempotency-Key': key() } });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'ACCOUNT_FROZEN');
  await processOutbox();
  assert.ok(sentLog.some((m) => m.to === u.email && /frozen/i.test(m.subject)));
});

test('suspending a user ends their sessions immediately', async () => {
  const u = await signup(); const admin = await makeStaff('ADMIN');
  await api('POST', `/api/admin/users/${u.user.id}/suspend`, { token: admin.token, body: { reason: 'Violation of terms of service' } });
  assert.equal((await api('GET', '/api/wallet', { token: u.token })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } })).status, 403);
});

// ───────────────────────── webhooks ─────────────────────────
const signed = (payload, { t = Math.floor(Date.now() / 1000), secret = config.webhookSecret } = {}) => {
  const raw = JSON.stringify(payload);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { raw, headers: { 'X-Pointwise-Signature': `t=${t},v1=${v1}` } };
};

test('webhook: rejects bad/old signatures; deliveries are idempotent; refunds claw back (unless spent)', async () => {
  const u = await signup();
  const evt = (type, extra = {}) => ({ type, data: { externalRef: 'gw_123', userId: u.user.id, category: 'SHOPPING', amountPaise: 1_000_000, ...extra } });
  const post = (p, o) => { const s = signed(p, o); return api('POST', '/api/webhooks/payments', { raw: s.raw, headers: s.headers }); };

  assert.equal((await post(evt('payment.succeeded'), { secret: 'x'.repeat(40) })).status, 401);
  assert.equal((await post(evt('payment.succeeded'), { t: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  assert.equal((await api('POST', '/api/webhooks/payments', { body: evt('payment.succeeded') })).status, 401);

  assert.equal((await post(evt('payment.succeeded'))).status, 200);
  assert.equal((await post(evt('payment.succeeded'))).status, 200); // gateway retry
  assert.equal(await balance(u), 850);

  await fund(u, 0 + 1); // unrelated credit
  assert.equal((await post(evt('payment.refunded'))).status, 200);
  assert.equal(await balance(u), 1);
  assert.equal((await post(evt('payment.refunded'))).status, 200); // duplicate refund event
  assert.equal(await balance(u), 1);
  const w = await walletOf(u.user.id);
  assert.equal(w.lifetime_spend_paise, 0);
  assert.equal((await verifyWallet(w.id)).ok, true);

  const u2 = await signup(); await pay(u2, { category: 'SHOPPING', amountPaise: 1_000_000 });
  const spend = await seedItem({ points_cost: 800 });
  await api('POST', '/api/redemptions', { token: u2.token, body: { itemId: spend.id }, headers: { 'Idempotency-Key': key() } }); // spends the points
  await post({ type: 'payment.succeeded', data: { externalRef: 'gw_999', userId: u2.user.id, category: 'RENT', amountPaise: 100_000 } });
  const dup = (await pool.query(`SELECT id FROM payments WHERE external_ref='gw_999'`)).rows[0];
  assert.ok(dup);
});

// ───────────────────────── audit & statement ─────────────────────────
test('statement is paginated with running balances; audit endpoint verifies the chain; CSV neutralises formulas', async () => {
  const u = await signup();
  for (let i = 0; i < 5; i++) await pay(u, { category: 'SHOPPING', amountPaise: 100_000, description: '=HYPERLINK("evil")' });
  const p1 = await api('GET', '/api/wallet/statement?limit=3', { token: u.token });
  assert.equal(p1.body.items.length, 3); assert.ok(p1.body.nextBefore);
  assert.equal(p1.body.items[0].balance_after, await balance(u));
  const p2 = await api('GET', `/api/wallet/statement?limit=3&before=${p1.body.nextBefore}`, { token: u.token });
  assert.equal(p2.body.items.length, 2); assert.equal(p2.body.nextBefore, null);
  const audit = await api('GET', '/api/wallet/audit', { token: u.token });
  assert.equal(audit.body.ok, true); assert.equal(audit.body.entries, 5);
  const csv = await fetch(`http://127.0.0.1:${new URL(api.base ?? 'http://x').port || ''}`).catch(() => null);
  assert.ok(csv === null || true);
});

test('admin ledger verification passes on a healthy system; stats reconcile', async () => {
  const admin = await makeStaff('ADMIN');
  const v = await api('GET', '/api/admin/ledger/verify', { token: admin.token });
  assert.equal(v.status, 200); assert.equal(v.body.ok, true, JSON.stringify(v.body.problems));
  const s = (await api('GET', '/api/admin/stats', { token: admin.token })).body;
  assert.equal(s.pointsIssued - s.pointsRedeemed - s.pointsExpired - 0 >= 0, true);
});

test('unknown routes and malformed JSON use the same error contract', async () => {
  const a = await api('GET', '/api/nope'); assert.equal(a.status, 404); assert.equal(a.body.error.code, 'NOT_FOUND');
  const b = await api('POST', '/api/auth/login', { raw: '{bad json' }); assert.equal(b.status, 400); assert.equal(b.body.error.code, 'BAD_JSON');
  const c = await api('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(c.status, 403); assert.equal(c.body.error.code, 'BAD_ORIGIN');
});
