import { pool } from '../db.js';
import { config } from '../config.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/security.js';

/**
 * Verifies the JWT AND checks the session/user rows, so logout, "sign out everywhere",
 * suspension and role changes take effect immediately (not after the 15-minute token expiry).
 */
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let claims;
    try { claims = verifyAccessToken(token); } catch { throw unauthorized('Invalid or expired token', 'TOKEN_INVALID'); }
    const { rows: [row] } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.status, u.referral_code, s.revoked_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=$1 AND u.id=$2`, [claims.sid, claims.sub]);
    if (!row || row.revoked_at) throw unauthorized('Session ended', 'SESSION_REVOKED');
    if (row.status !== 'ACTIVE') throw forbidden('ACCOUNT_SUSPENDED', 'This account is suspended');
    req.user = { id: row.id, email: row.email, name: row.name, role: row.role, referralCode: row.referral_code };
    req.sessionId = claims.sid;
    next();
  } catch (err) { next(err); }
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden('FORBIDDEN', 'You do not have permission to do that'));

/** Reject cross-site browser requests: if an Origin header is present on a mutating call it must be allow-listed. */
export function originGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !config.corsOrigins.includes(origin)) return next(forbidden('BAD_ORIGIN', 'Cross-origin request blocked'));
  next();
}
