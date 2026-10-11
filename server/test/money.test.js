import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, resetDb, startServer, stopServer, signup, makeStaff, fund, key, pool, walletOf, inrOf, treasury, fundTreasury, addMoney, processOutbox, sentLog, config } from './helpers.js';
import { verifyWallet, verifyAll } from '../src/services/ledger.js';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);

const wallet = async (u) => (await api('GET', '/api/money/wallet', { token: u.token })).body;
const pts = async (u) => (await walletOf(u.user.id)).balance;
const otpFor = (email) => [...sentLog].reverse().find((x) => x.to === email && x.template === 'otp').text.match(/use (\d{6})/)[1];
const convert = (u, points, extra = {}, k = key()) => api('POST', '/api/money/convert', { token: u.token, body: { points, ...extra }, headers: { 'Idempotency-Key': k } });
const send = (u, toEmail, amountPaise, extra = {}, k = key()) => api('POST', '/api/money/transfer', { token: u.token, body: { toEmail, amountPaise, ...extra }, headers: { 'Idempotency-Key': k } });
const pay = (u, body, k = key()) => api('POST', '/api/payments', { token: u.token, body, headers: { 'Idempotency-Key': k } });

test('everyone starts with ₹0; adding money credits the wallet and notifies (in-app + email)', async () => {
  const u = await signup();
  assert.equal((await wallet(u)).balance, 0);
  const r = await addMoney(u, 50_000);
  assert.equal(r.status, 201); assert.equal(r.body.balance, 50_000);
  assert.equal((await wallet(u)).balance, 50_000);
  await processOutbox();
  assert.ok(sentLog.some((m) => m.to === u.email && /Money added: \+₹500\.00/.test(m.subject)));
  const n = (await api('GET', '/api/notifications', { token: u.token })).body.notifications;
  assert.ok(n.some((x) => x.type === 'MONEY_CREDITED'));
});

test('top-up limits: per-transaction cap, wallet cap, idempotent retries, strict body', async () => {
  const u = await signup();
  assert.equal((await addMoney(u, config.wallet.maxTopupPaise + 1)).status, 400);
  assert.equal((await addMoney(u, 99)).status, 400);
  const k = key();
  const body = { amountPaise: 10_000 };
  const a = await api('POST', '/api/money/topup', { token: u.token, body, headers: { 'Idempotency-Key': k } });
  const b = await api('POST', '/api/money/topup', { token: u.token, body, headers: { 'Idempotency-Key': k } });
  assert.equal(a.status, 201); assert.equal(b.status, 200);
  assert.equal((await wallet(u)).balance, 10_000); // not 20,000
  assert.equal((await api('POST', '/api/money/topup', { token: u.token, body: { amountPaise: 100, balance: 9e9 }, headers: { 'Idempotency-Key': key() } })).status, 400);
  // fill to the cap, then one more rupee is refused
  assert.equal((await addMoney(u, config.wallet.maxTopupPaise)).status, 201);          // 10,000 + 2,500,000
  assert.equal((await addMoney(u, config.wallet.maxBalancePaise - 2_510_000)).status, 201); // exactly the cap
  const over = await addMoney(u, 100);
  assert.equal(over.status, 409); assert.equal(over.body.error.code, 'WALLET_LIMIT');
});

test('simulated money is OFF unless explicitly allowed (production safety switch)', async () => {
  const u = await signup();
  config.simulatedPayments = false;
  try {
    const t = await addMoney(u, 10_000);
    assert.equal(t.status, 403); assert.equal(t.body.error.code, 'SIMULATION_DISABLED');
    const p = await pay(u, { category: 'SHOPPING', amountPaise: 100_000 });
    assert.equal(p.status, 403);
    assert.equal((await wallet(u)).balance, 0); assert.equal(await pts(u), 0);
  } finally { config.simulatedPayments = true; }
});

test('POINTS → MONEY: 100 points = ₹3, paid from the treasury, in one atomic step', async () => {
  const u = await signup(); await fund(u, 500); await fundTreasury(100_000);
  const t0 = (await treasury()).balance;
  const r = await convert(u, 300);
  assert.equal(r.status, 201);
  assert.equal(r.body.conversion.paise, 900); // 300 points × 3 paise = ₹9
  assert.equal(await pts(u), 200);
  assert.equal((await wallet(u)).balance, 900);
  assert.equal((await treasury()).balance, t0 - 900);
  assert.equal((await verifyWallet((await walletOf(u.user.id)).id)).ok, true);
  assert.equal((await verifyWallet((await inrOf(u.user.id)).id)).ok, true);
  await processOutbox();
  assert.ok(sentLog.some((m) => m.to === u.email && /Points converted to cash: \+₹9\.00/.test(m.subject)));
  assert.ok(sentLog.some((m) => m.to === u.email && /Points converted to cash: −300 points/.test(m.subject)));
});

test('conversion rules: blocks of 100, enough points, retries are idempotent', async () => {
  const u = await signup(); await fund(u, 250); await fundTreasury(100_000);
  assert.equal((await convert(u, 150)).body.error.code, 'INVALID_POINTS');
  assert.equal((await convert(u, 50)).body.error.code, 'INVALID_POINTS');
  const tooMany = await convert(u, 300);
  assert.equal(tooMany.status, 409); assert.equal(tooMany.body.error.code, 'INSUFFICIENT_BALANCE');
  const k = key();
  assert.equal((await convert(u, 100, {}, k)).status, 201);
  assert.equal((await convert(u, 100, {}, k)).status, 200);
  assert.equal(await pts(u), 150); assert.equal((await wallet(u)).balance, 300);
  assert.equal((await convert(u, 200, {}, k)).status, 409); // same key, different request
});

test('large conversions need an emailed code bound to the exact amount', async () => {
  const u = await signup(); await fund(u, 5000); await fundTreasury(1_000_000);
  const no = await convert(u, 2000);
  assert.equal(no.status, 403); assert.equal(no.body.error.code, 'STEP_UP_REQUIRED');
  const ch = await api('POST', '/api/money/challenge', { token: u.token, body: { action: 'convert', points: 2000 } });
  assert.equal(ch.body.required, true);
  await processOutbox();
  const wrongAmount = await convert(u, 3000, { otp: otpFor(u.email) });
  assert.equal(wrongAmount.status, 400); // a code for 2,000 can't authorise 3,000
  await api('POST', '/api/money/challenge', { token: u.token, body: { action: 'convert', points: 2000 } });
  await processOutbox();
  const k = key(); const code = otpFor(u.email);
  assert.equal((await convert(u, 2000, { otp: code }, k)).status, 201);
  assert.equal((await convert(u, 2000, {}, k)).status, 200); // retry needs no new code
  assert.equal((await wallet(u)).balance, 6000);
  assert.equal((await api('POST', '/api/money/challenge', { token: u.token, body: { action: 'convert', points: 100 } })).body.required, false);
});

test('THE TREASURY CAN NEVER GO NEGATIVE: with ₹81 in the pool, 5 simultaneous ₹27 conversions → exactly 3 pay out', async () => {
  const t = await treasury();
  const have = t.balance;
  const users = await Promise.all(Array.from({ length: 5 }, async () => { const u = await signup(); await fund(u, 1000); return u; }));
  // drain the pool down to exactly ₹90 by moving the surplus out through a legitimate ledger path
  if (have > 8100) {
    const { postMoney } = await import('../src/services/money.js'); const { systemAccountId } = await import('../src/services/ledger.js'); const { tx } = await import('./helpers.js');
    await tx(async (c) => postMoney(c, { kind: 'WALLET_PAY', idempotencyKey: key(), requestHash: 'x', skipLimits: true, description: 'test drain',
      legs: [{ accountId: await systemAccountId(c, 'TREASURY'), direction: 'DEBIT', amount: have - 8100 }, { accountId: await systemAccountId(c, 'MERCHANTS'), direction: 'CREDIT', amount: have - 8100 }] }));
  } else await fundTreasury(8100 - have);
  assert.equal((await treasury()).balance, 8100);
  // 900 points = ₹27 (below the OTP threshold): 8100 / 2700 = exactly 3 payouts
  const results = await Promise.all(users.map((u) => convert(u, 900)));
  const ok = results.filter((r) => r.status === 201), no = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 3, JSON.stringify(results.map((r) => r.body?.error?.code ?? r.status)));
  assert.ok(no.every((r) => r.body.error.code === 'PAYOUT_UNAVAILABLE'));
  assert.equal((await treasury()).balance, 0);
  // the five losers' points were NOT taken (the whole conversion rolled back)
  for (const [i, r] of results.entries()) assert.equal(await pts(users[i]), r.status === 201 ? 100 : 1000);
  assert.equal((await verifyAll()).ok, true);
});

test('a member can never convert the same points twice in parallel', async () => {
  const u = await signup(); await fund(u, 500); await fundTreasury(1_000_000);
  const rs = await Promise.all(Array.from({ length: 5 }, () => convert(u, 500)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(await pts(u), 0); assert.equal((await wallet(u)).balance, 1500);
});

test('daily conversion limit is enforced', async () => {
  const u = await signup(); await fund(u, 60_000); await fundTreasury(5_000_000);
  const lim = config.conversion.dailyLimitPoints;
  // use the service directly with OTP bypass by staying under the step-up via many small conversions is slow; instead lower the threshold
  const old = config.rewards.stepUpThreshold; config.rewards.stepUpThreshold = 10_000_000;
  try {
    assert.equal((await convert(u, lim)).status, 201);
    const more = await convert(u, 100);
    assert.equal(more.status, 409); assert.equal(more.body.error.code, 'DAILY_CONVERSION_LIMIT');
  } finally { config.rewards.stepUpThreshold = old; }
});

test('PAY FROM WALLET: money leaves the wallet, points are earned, atomically; insufficient funds changes nothing', async () => {
  const u = await signup(); await addMoney(u, 100_000); // ₹1,000
  const ok = await pay(u, { category: 'SHOPPING', amountPaise: 60_000, method: 'WALLET' });
  assert.equal(ok.status, 201);
  assert.equal((await wallet(u)).balance, 40_000);
  assert.equal(await pts(u), ok.body.payment.points_awarded); // 8 pts/₹100 × ₹600 = 48 + 50 bonus
  assert.equal(ok.body.payment.points_awarded, 98);
  const before = await pts(u);
  const broke = await pay(u, { category: 'SHOPPING', amountPaise: 90_000, method: 'WALLET' });
  assert.equal(broke.status, 409); assert.equal(broke.body.error.code, 'INSUFFICIENT_FUNDS');
  assert.equal((await wallet(u)).balance, 40_000); assert.equal(await pts(u), before); // no points for a failed payment
  assert.equal((await pool.query(`SELECT count(*)::int n FROM payments WHERE account_id=$1`, [(await walletOf(u.user.id)).id])).rows[0].n, 1);
});

test('wallet payments are idempotent and parallel double-submits can only pay once', async () => {
  const u = await signup(); await addMoney(u, 100_000);
  const k = key(); const body = { category: 'RECHARGE', amountPaise: 30_000, method: 'WALLET' };
  const rs = await Promise.all(Array.from({ length: 6 }, () => pay(u, body, k)));
  assert.ok(rs.every((r) => [200, 201].includes(r.status)));
  assert.equal((await wallet(u)).balance, 70_000);
  const par = await Promise.all(Array.from({ length: 4 }, () => pay(u, { category: 'RENT', amountPaise: 50_000, method: 'WALLET' }))); // 4 different keys, only ₹700 left
  assert.equal(par.filter((r) => r.status === 201).length, 1);
  assert.equal((await wallet(u)).balance, 20_000);
});

test('refunding a wallet payment returns the money and claws the points back', async () => {
  const u = await signup(); await addMoney(u, 100_000); const admin1 = await makeStaff('ADMIN'), admin2 = await makeStaff('ADMIN');
  const p = await pay(u, { category: 'SHOPPING', amountPaise: 50_000, method: 'WALLET' });
  assert.equal((await wallet(u)).balance, 50_000);
  const w = await walletOf(u.user.id);
  const req = await api('POST', '/api/admin/approvals', { token: admin1.token, body: { kind: 'REFUND_PAYMENT', accountId: w.id, targetPaymentId: p.body.payment.id, reason: 'Merchant cancelled the order' } });
  assert.equal(req.status, 201);
  assert.equal((await api('POST', `/api/admin/approvals/${req.body.id}/approve`, { token: admin2.token, body: {} })).status, 200);
  assert.equal((await wallet(u)).balance, 100_000); assert.equal(await pts(u), 0);
  for (const c of [w, await inrOf(u.user.id)]) assert.equal((await verifyWallet(c.id)).ok, true);
});

test('SEND MONEY: moves rupees wallet→wallet, both sides notified, ledgers verify', async () => {
  const a = await signup({ name: 'Asha Sender' }), b = await signup({ name: 'Bala Receiver' }); await addMoney(a, 100_000);
  const lookup = await api('GET', `/api/money/recipient?email=${encodeURIComponent(b.email)}`, { token: a.token });
  assert.equal(lookup.status, 200); assert.match(lookup.body.name, /^B\*+ R\*+$/); // masked, not the real name
  const r = await send(a, b.email, 25_000, { note: 'lunch' });
  assert.equal(r.status, 201); assert.equal(r.body.balance, 75_000);
  assert.equal((await wallet(b)).balance, 25_000);
  await processOutbox();
  assert.ok(sentLog.some((m) => m.to === a.email && /Money sent: −₹250\.00/.test(m.subject)));
  assert.ok(sentLog.some((m) => m.to === b.email && /Money received: \+₹250\.00/.test(m.subject)));
  for (const u of [a, b]) assert.equal((await verifyWallet((await inrOf(u.user.id)).id)).ok, true);
  const st = await api('GET', '/api/wallet/statement?currency=INR', { token: b.token });
  assert.equal(st.body.items[0].amount, 25_000); assert.equal(st.body.items[0].balance_after, 25_000);
});

test('send money safety: no self-transfer, unknown recipient, limits, strict body, no overdraft under parallel sends', async () => {
  const a = await signup(), b = await signup(); await addMoney(a, 100_000);
  assert.equal((await send(a, a.email, 1000)).body.error.code, 'SELF_TRANSFER');
  assert.equal((await send(a, 'nobody@example.com', 1000)).body.error.code, 'RECIPIENT_NOT_FOUND');
  assert.equal((await send(a, b.email, 50)).status, 400);
  assert.equal((await send(a, b.email, 150_000)).body.error.code, 'INSUFFICIENT_FUNDS');
  assert.equal((await api('POST', '/api/money/transfer', { token: a.token, body: { toEmail: b.email, amountPaise: 1000, fromUserId: 'x' }, headers: { 'Idempotency-Key': key() } })).status, 400);
  const rs = await Promise.all(Array.from({ length: 6 }, () => send(a, b.email, 30_000))); // only ₹1,000 → 3 succeed
  assert.equal(rs.filter((r) => r.status === 201).length, 3);
  assert.equal((await wallet(a)).balance, 10_000); assert.equal((await wallet(b)).balance, 90_000);
  const total = (await wallet(a)).balance + (await wallet(b)).balance;
  assert.equal(total, 100_000); // money is conserved
});

test('opposite-direction transfers at the same moment never deadlock', async () => {
  const a = await signup(), b = await signup(); await addMoney(a, 100_000); await addMoney(b, 100_000);
  const rs = await Promise.all([...Array.from({ length: 5 }, () => send(a, b.email, 1000)), ...Array.from({ length: 5 }, () => send(b, a.email, 1000))]);
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal((await wallet(a)).balance + (await wallet(b)).balance, 200_000);
});

test('large transfers need an emailed code bound to recipient AND amount; daily outbound limit holds', async () => {
  const a = await signup(), b = await signup(), c = await signup(); await addMoney(a, 2_500_000); await addMoney(a, 2_500_000);
  assert.equal((await send(a, b.email, 300_000)).body.error.code, 'STEP_UP_REQUIRED');
  await api('POST', '/api/money/challenge', { token: a.token, body: { action: 'transfer', toEmail: b.email, amountPaise: 300_000 } });
  await processOutbox();
  const code = otpFor(a.email);
  assert.equal((await send(a, c.email, 300_000, { otp: code })).status, 400); // code was for b, not c
  await api('POST', '/api/money/challenge', { token: a.token, body: { action: 'transfer', toEmail: b.email, amountPaise: 300_000 } });
  await processOutbox();
  assert.equal((await send(a, b.email, 300_000, { otp: otpFor(a.email) })).status, 201);
  // the daily outbound cap counts everything sent in the last 24h
  const oldLimit = config.wallet.dailyOutboundPaise; config.wallet.dailyOutboundPaise = 400_000; // ₹4,000
  try {
    assert.equal((await send(a, b.email, 100_000)).status, 201);           // ₹3,000 + ₹1,000 = ₹4,000 → exactly at the limit
    const over = await send(a, b.email, 100);                               // one more ₹1 tips it over
    assert.equal(over.status, 409); assert.equal(over.body.error.code, 'DAILY_LIMIT');
  } finally { config.wallet.dailyOutboundPaise = oldLimit; }
});

test('frozen members cannot spend, send or convert — but can still receive', async () => {
  const u = await signup(), friend = await signup(); await addMoney(u, 50_000); await addMoney(friend, 10_000); await fund(u, 500); await fundTreasury(100_000);
  const admin = await makeStaff('ADMIN'); const w = await walletOf(u.user.id);
  await api('POST', `/api/admin/accounts/${w.id}/freeze`, { token: admin.token, body: { reason: 'Suspected account takeover' } });
  assert.equal((await send(u, friend.email, 1000)).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await pay(u, { category: 'RENT', amountPaise: 10_000, method: 'WALLET' })).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await convert(u, 100)).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await send(friend, u.email, 1000)).status, 201); // receiving is allowed
});

test('TREASURY GOVERNANCE: funding the pool needs a second admin; admins cannot touch it otherwise; members cannot see it', async () => {
  const a1 = await makeStaff('ADMIN'), a2 = await makeStaff('ADMIN'), u = await signup(), aud = await makeStaff('AUDITOR');
  const before = (await treasury()).balance;
  const req = await api('POST', '/api/admin/approvals', { token: a1.token, body: { kind: 'TREASURY_FUND', amountPaise: 500_000, reason: 'Monthly rewards budget top-up' } });
  assert.equal(req.status, 201);
  assert.equal((await treasury()).balance, before); // nothing moves on request
  assert.equal((await api('POST', `/api/admin/approvals/${req.body.id}/approve`, { token: a1.token, body: {} })).body.error.code, 'SELF_APPROVAL');
  assert.equal((await api('POST', `/api/admin/approvals/${req.body.id}/approve`, { token: a2.token, body: {} })).status, 200);
  assert.equal((await treasury()).balance, before + 500_000);
  const big = await api('POST', '/api/admin/approvals', { token: a1.token, body: { kind: 'TREASURY_FUND', amountPaise: config.wallet.maxTreasuryFundPaise + 1, reason: 'Way too large of a deposit' } });
  assert.equal(big.status, 400);
  // there is no endpoint to withdraw from, or edit, the treasury
  for (const [m, p, body] of [['POST', '/api/admin/treasury/withdraw', { amountPaise: 1 }], ['PATCH', '/api/admin/treasury', { balance: 0 }], ['POST', '/api/admin/treasury/debit', { amountPaise: 1 }]]) {
    assert.ok([400, 404].includes((await api(m, p, { token: a1.token, body })).status), `${m} ${p}`);
  }
  assert.equal((await api('GET', '/api/admin/treasury', { token: u.token })).status, 403);
  assert.equal((await api('POST', '/api/admin/approvals', { token: aud.token, body: { kind: 'TREASURY_FUND', amountPaise: 1000, reason: 'auditors cannot do this' } })).status, 403);
  const rep = (await api('GET', '/api/admin/treasury', { token: aud.token })).body;
  assert.equal(rep.reconciled, true); assert.equal(rep.treasuryPaise, before + 500_000);
});

test('every rupee is accounted for: wallets + treasury + system counters sum to zero; full verification passes', async () => {
  const admin = await makeStaff('ADMIN');
  const v = await api('GET', '/api/admin/ledger/verify', { token: admin.token });
  assert.equal(v.body.ok, true, JSON.stringify(v.body.problems));
  const { rows: [{ s }] } = await pool.query(`SELECT COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END),0)::bigint s
    FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE a.currency='INR'`);
  assert.equal(s, 0); // double-entry across the whole rupee ledger
  const st = (await api('GET', '/api/admin/stats', { token: admin.token })).body;
  assert.ok(st.pointsConverted > 0 && st.treasuryPaise >= 0);
});

test('webhook can credit a wallet top-up exactly once (real-money path)', async () => {
  const u = await signup();
  const evt = { type: 'wallet.topup.succeeded', data: { externalRef: 'topup_777', userId: u.user.id, amountPaise: 20_000 } };
  const post = () => { const raw = JSON.stringify(evt); const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', config.webhookSecret).update(`${t}.${raw}`).digest('hex');
    return api('POST', '/api/webhooks/payments', { raw, headers: { 'X-Pointwise-Signature': `t=${t},v1=${v1}` } }); };
  assert.equal((await post()).status, 200); assert.equal((await post()).status, 200);
  assert.equal((await wallet(u)).balance, 20_000);
});
