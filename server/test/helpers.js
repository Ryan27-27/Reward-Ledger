process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://pointwise:pointwise@127.0.0.1:5432/pointwise_test';
process.env.WORKERS_ENABLED = 'false';
process.env.STEP_UP_THRESHOLD_POINTS = '1000';

const { pool, tx } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { createUser } = await import('../src/services/auth.js');
const { processOutbox } = await import('../src/services/outbox.js');
const { sentLog } = await import('../src/services/mailer.js');
const { resetSystemCache } = await import('../src/services/ledger.js');
const { config } = await import('../src/config.js');
export { pool, tx, processOutbox, sentLog, config, createUser };

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  resetSystemCache();
  await migrate();
  sentLog.length = 0;
}

let server, base;
export async function startServer() {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
export async function stopServer() {
  await new Promise((r) => server.close(r));
  await pool.end();
}

export async function api(method, path, { token, body, headers = {}, raw, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body || raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers };
}

let n = 0;
export const uniqueEmail = (p = 'user') => `${p}${Date.now()}${n++}@example.com`;
export const PASSWORD = 'correct-horse-battery';
export const key = () => `k-${crypto.randomUUID()}`;

/** Full signup through the real API: register → email OTP (via outbox) → verify → logged in. */
export async function signup(opts = {}) {
  const email = opts.email ?? uniqueEmail();
  const r = await api('POST', '/api/auth/register', { body: { name: opts.name ?? 'Test User', email, password: PASSWORD, referralCode: opts.referralCode } });
  if (r.status !== 201) throw new Error(`register failed ${JSON.stringify(r.body)}`);
  // Parallel signups share the outbox (SKIP LOCKED), so poll until *our* email has been delivered.
  let mail;
  for (let i = 0; i < 40 && !mail; i++) {
    await processOutbox();
    mail = [...sentLog].reverse().find((m) => m.to === email && m.template === 'otp');
    if (!mail) await new Promise((r) => setTimeout(r, 25));
  }
  const code = mail.text.match(/use (\d{6})/)[1];
  const v = await api('POST', '/api/auth/verify-email', { body: { email, code } });
  if (v.status !== 200) throw new Error(`verify failed ${JSON.stringify(v.body)}`);
  return { email, token: v.body.accessToken, user: v.body.user, cookie: v.cookie };
}

export async function makeStaff(role = 'ADMIN') {
  const email = uniqueEmail(role.toLowerCase());
  await tx((c) => createUser(c, { email, name: `${role} Person`, password: PASSWORD, role, verified: true }));
  const l = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  return { email, token: l.body.accessToken, user: l.body.user };
}

export const walletOf = async (userId) => (await pool.query(`SELECT * FROM accounts WHERE kind='WALLET' AND currency='PTS' AND user_id=$1`, [userId])).rows[0];
export const inrOf = async (userId) => (await pool.query(`SELECT * FROM accounts WHERE kind='WALLET' AND currency='INR' AND user_id=$1`, [userId])).rows[0];
export const treasury = async () => (await pool.query(`SELECT * FROM accounts WHERE code='TREASURY'`)).rows[0];

/** Credit an exact number of points straight through the ledger write path (exact balances for tests). */
export async function fund(u, points, expiresAt = null) {
  const { postJournal } = await import('../src/services/ledger.js');
  const w = await walletOf(u.user.id);
  await tx((c) => postJournal(c, { kind: 'GRANT', walletId: w.id, direction: 'CREDIT', amount: points, systemCode: 'ISSUANCE',
    idempotencyKey: key(), requestHash: 'test', description: 'test funding', expiresAt }));
  return w;
}
/** Put money in the reward pool (treasury) the same way production does: a ledger journal from FUNDS_IN. */
export async function fundTreasury(paise) {
  const { postMoney } = await import('../src/services/money.js');
  const { systemAccountId } = await import('../src/services/ledger.js');
  await tx(async (c) => postMoney(c, { kind: 'TREASURY_FUND', idempotencyKey: key(), requestHash: 'test', description: 'test funding',
    legs: [{ accountId: await systemAccountId(c, 'TREASURY'), direction: 'CREDIT', amount: paise }, { accountId: await systemAccountId(c, 'FUNDS_IN'), direction: 'DEBIT', amount: paise }] }));
}
/** Give a member rupees via the real top-up path. */
export async function addMoney(u, paise) {
  return api('POST', '/api/money/topup', { token: u.token, body: { amountPaise: paise }, headers: { 'Idempotency-Key': key() } });
}
export async function seedItem(overrides = {}) {
  const sku = overrides.sku ?? `SKU-${Math.random().toString(36).slice(2, 8)}`;
  const { rows: [item] } = await pool.query(
    `INSERT INTO catalog_items (sku, name, points_cost, stock) VALUES ($1,$2,$3,$4) RETURNING *`,
    [sku, overrides.name ?? 'Test reward', overrides.points_cost ?? 100, overrides.stock ?? null]);
  return item;
}
