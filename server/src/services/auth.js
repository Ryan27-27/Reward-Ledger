import { pool, tx } from '../db.js';
import { config } from '../config.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, sha256, randomToken, randomCode, signAccessToken,
} from '../lib/security.js';
import { AppError, conflict, forbidden, unauthorized, notFound } from '../lib/errors.js';
import { issueOtp, verifyOtp } from './otp.js';
import { enqueueEmail } from './notify.js';
import { assignVpa } from './vpa.js';

export const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, referralCode: u.referral_code, emailVerified: !!u.email_verified_at });

/** Create user + wallet in one transaction. `verified` is for seeding/CLI only. */
export async function createUser(client, { email, name, password, referralCode = null, role = 'USER', verified = false }) {
  const passwordHash = await hashPassword(password);
  let referredBy = null;
  if (referralCode) {
    const { rows: [r] } = await client.query('SELECT id FROM users WHERE referral_code=$1', [String(referralCode).toUpperCase()]);
    referredBy = r?.id ?? null; // an unknown code is silently ignored
  }
  try {
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, name, password_hash, role, referral_code, referred_by, email_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6, $7) RETURNING *`,
      [email.trim(), name.trim(), passwordHash, role, randomCode(8), referredBy, verified ? new Date() : null]);
    // Two wallets per member: points (PTS) and rupees (INR, starts at ₹0).
    await client.query(`INSERT INTO accounts (kind, user_id, currency) VALUES ('WALLET', $1, 'PTS'), ('WALLET', $1, 'INR')`, [user.id]);
    await assignVpa(client, user); // every member gets a payment address, e.g. riya.demo@pointwise
    return user;
  } catch (err) {
    if (err.code === '23505' && /users_email_uq/.test(err.constraint ?? '')) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
}

export async function register(input) {
  return tx(async (client) => {
    const user = await createUser(client, input);
    await issueOtp(client, user, 'VERIFY_EMAIL');
    return { email: user.email };
  });
}

export async function resendVerification(email) {
  // Always succeeds from the caller's point of view (no account enumeration).
  await tx(async (client) => {
    const { rows: [u] } = await client.query('SELECT * FROM users WHERE lower(email)=lower($1) AND email_verified_at IS NULL', [email]);
    if (u) await issueOtp(client, u, 'VERIFY_EMAIL');
  }).catch((e) => { if (e.code !== 'OTP_RATE_LIMITED') throw e; });
}

async function startSession(client, user, { ip, userAgent }) {
  const { rows: [s] } = await client.query(`INSERT INTO sessions (user_id, ip, user_agent) VALUES ($1,$2,$3) RETURNING id`, [user.id, ip, (userAgent || '').slice(0, 300)]);
  const refresh = randomToken();
  await client.query(
    `INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
    [s.id, sha256(refresh), String(config.refreshTtlDays)]);
  return { accessToken: signAccessToken(user, s.id), refreshToken: refresh, sessionId: s.id };
}

export async function verifyEmail({ email, code }, meta) {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  if (!u) throw new AppError(400, 'OTP_INVALID', 'That code is invalid or has expired');
  await verifyOtp(u.id, 'VERIFY_EMAIL', code);
  return tx(async (client) => {
    const { rows: [user] } = await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id=$1 RETURNING *', [u.id]);
    return { user, ...(await startSession(client, user, meta)) };
  });
}

export async function login({ email, password }, meta) {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  if (u?.locked_until && new Date(u.locked_until) > new Date()) {
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }
  const ok = await verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) {
    if (u) {
      await pool.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END WHERE id=$1`,
        [u.id, config.login.maxFailures, String(config.login.lockMinutes)]);
    }
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (!u.email_verified_at) throw forbidden('EMAIL_NOT_VERIFIED', 'Please verify your email first');
  if (u.status !== 'ACTIVE') throw forbidden('ACCOUNT_SUSPENDED', 'This account is suspended');
  return tx(async (client) => {
    await client.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
    return { user: u, ...(await startSession(client, u, meta)) };
  });
}

/** Rotate a refresh token. Replaying an already-rotated token (outside the race window) kills the session. */
export async function refresh(rawToken) {
  if (!rawToken) throw unauthorized('No refresh token', 'NO_REFRESH_TOKEN');
  const result = await tx(async (client) => {
    const { rows: [rt] } = await client.query(
      `SELECT rt.*, s.user_id, s.revoked_at AS session_revoked FROM refresh_tokens rt
         JOIN sessions s ON s.id = rt.session_id WHERE rt.token_hash=$1 FOR UPDATE OF rt`, [sha256(rawToken)]);
    if (!rt || rt.session_revoked || new Date(rt.expires_at) < new Date()) return { fail: 'INVALID_REFRESH_TOKEN' };
    if (rt.rotated_at) {
      const age = (Date.now() - new Date(rt.rotated_at).getTime()) / 1000;
      if (age < config.refreshReuseGraceSec) return { fail: 'REFRESH_RACE' }; // two tabs refreshing at once — not theft
      await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [rt.session_id]);
      return { fail: 'REFRESH_TOKEN_REUSED' };
    }
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1', [rt.user_id]);
    if (user.status !== 'ACTIVE') return { fail: 'INVALID_REFRESH_TOKEN' };
    await client.query('UPDATE refresh_tokens SET rotated_at=now() WHERE id=$1', [rt.id]);
    const next = randomToken();
    await client.query(
      `INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
      [rt.session_id, sha256(next), String(config.refreshTtlDays)]);
    await client.query('UPDATE sessions SET last_used_at=now() WHERE id=$1', [rt.session_id]);
    return { user, accessToken: signAccessToken(user, rt.session_id), refreshToken: next };
  });
  if (result.fail) throw unauthorized('Session expired, please sign in again', result.fail);
  return result;
}

export const revokeSession = (userId, sessionId) =>
  pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [sessionId, userId]);
export const revokeAllSessions = (userId, exceptId = null) =>
  pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [userId, exceptId]);

export async function listSessions(userId, currentId) {
  const { rows } = await pool.query(
    `SELECT id, ip, user_agent, created_at, last_used_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY last_used_at DESC`, [userId]);
  return rows.map((r) => ({ ...r, current: r.id === currentId }));
}

export async function forgotPassword(email) {
  await tx(async (client) => {
    const { rows: [u] } = await client.query(`SELECT * FROM users WHERE lower(email)=lower($1) AND email_verified_at IS NOT NULL AND status='ACTIVE'`, [email]);
    if (u) await issueOtp(client, u, 'RESET_PASSWORD');
  }).catch((e) => { if (e.code !== 'OTP_RATE_LIMITED') throw e; });
}

export async function resetPassword({ email, code, newPassword }) {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  if (!u) throw new AppError(400, 'OTP_INVALID', 'That code is invalid or has expired');
  await verifyOtp(u.id, 'RESET_PASSWORD', code);
  const hash = await hashPassword(newPassword);
  await tx(async (client) => {
    await client.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1', [u.id, hash]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [u.id]);
    await enqueueEmail(client, { userId: u.id, template: 'password-changed', data: {} });
  });
}

export async function changePassword(user, sessionId, { currentPassword, newPassword }) {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [user.id]);
  if (!(await verifyPassword(currentPassword, u.password_hash))) throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  const hash = await hashPassword(newPassword);
  await tx(async (client) => {
    await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, hash]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND id <> $2', [u.id, sessionId]);
    await enqueueEmail(client, { userId: u.id, template: 'password-changed', data: {} });
  });
}

export async function getUser(id) {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  if (!u) throw notFound('User');
  return u;
}
