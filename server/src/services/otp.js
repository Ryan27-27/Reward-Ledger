import { config } from '../config.js';
import { generateOtp, hashOtp, safeEqual } from '../lib/security.js';
import { AppError, tooMany } from '../lib/errors.js';
import { tx } from '../db.js';
import { enqueueEmail } from './notify.js';

/** Create + email a one-time code (inside the caller's transaction). Older unused codes are voided. */
export async function issueOtp(client, user, purpose, context = null, contextLabel = null) {
  const { rows: [{ n }] } = await client.query(
    `SELECT count(*)::int AS n FROM otps WHERE user_id=$1 AND purpose=$2 AND created_at > now() - interval '1 hour'`, [user.id, purpose]);
  if (n >= config.otp.maxPerHour) throw tooMany('OTP_RATE_LIMITED', 'Too many codes requested. Try again later.');
  await client.query(`UPDATE otps SET consumed_at=now() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL`, [user.id, purpose]);
  const code = generateOtp();
  await client.query(
    `INSERT INTO otps (user_id, purpose, code_hash, context, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
    [user.id, purpose, hashOtp(user.id, purpose, context, code), context, String(config.otp.ttlMin)]);
  await enqueueEmail(client, {
    userId: user.id, to: user.email, template: 'otp',
    data: { name: user.name, code, purpose, context: contextLabel, ttlMin: config.otp.ttlMin },
  });
}

/**
 * Verify and consume a code. Failed attempts are committed (so brute-forcing is bounded to
 * maxAttempts per code) and the error is thrown only after the commit.
 */
export async function verifyOtp(userId, purpose, code, context = null) {
  const outcome = await tx(async (client) => {
    const { rows: [otp] } = await client.query(
      `SELECT * FROM otps WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId, purpose]);
    if (!otp || new Date(otp.expires_at) < new Date()) return 'OTP_INVALID';
    if (otp.attempts >= config.otp.maxAttempts) return 'OTP_ATTEMPTS_EXCEEDED';
    const ok = safeEqual(otp.code_hash, hashOtp(userId, purpose, context, String(code)));
    if (!ok) {
      await client.query('UPDATE otps SET attempts = attempts + 1 WHERE id=$1', [otp.id]);
      return 'OTP_INVALID';
    }
    await client.query('UPDATE otps SET consumed_at=now() WHERE id=$1', [otp.id]);
    return 'OK';
  });
  if (outcome === 'OTP_ATTEMPTS_EXCEEDED') throw tooMany(outcome, 'Too many wrong attempts. Request a new code.');
  if (outcome !== 'OK') throw new AppError(400, 'OTP_INVALID', 'That code is invalid or has expired');
}
