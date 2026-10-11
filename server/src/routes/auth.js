import { Router } from 'express';
import { ah } from '../lib/async.js';
import { z, email, password } from '../middleware/validate.js';
import { limiter } from '../middleware/rateLimit.js';
import { authenticate } from '../middleware/auth.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { sha256 } from '../lib/security.js';
import * as auth from '../services/auth.js';

const r = Router();
const COOKIE = 'pw_rt';
const cookieOpts = () => ({
  httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/api/auth',
  maxAge: config.refreshTtlDays * 24 * 60 * 60 * 1000,
});
const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const session = (res, { user, accessToken, refreshToken }) => {
  res.cookie(COOKIE, refreshToken, cookieOpts());
  res.json({ accessToken, expiresIn: config.accessTtlSec, user: auth.publicUser(user) });
};

const strict = limiter({ windowMs: 15 * 60_000, limit: 20 });
const otpLimit = limiter({ windowMs: 15 * 60_000, limit: 10 });

r.post('/register', limiter({ windowMs: 60 * 60_000, limit: 10 }), ah(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(80), email, password,
    referralCode: z.string().trim().max(20).optional(),
  }).parse(req.body);
  if (body.password.toLowerCase().includes(body.email.split('@')[0]) && body.email.split('@')[0].length > 3) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid', requestId: req.id, details: { fields: { password: 'Password must not contain your email name' } } } });
  }
  res.status(201).json(await auth.register(body));
}));

r.post('/verify-email', otpLimit, ah(async (req, res) => {
  const body = z.object({ email, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
  session(res, await auth.verifyEmail(body, meta(req)));
}));

r.post('/resend-verification', otpLimit, ah(async (req, res) => {
  await auth.resendVerification(z.object({ email }).parse(req.body).email);
  res.status(202).json({ message: 'If that account needs verification, a new code is on its way.' });
}));

r.post('/login', strict, ah(async (req, res) => {
  session(res, await auth.login(z.object({ email, password: z.string().min(1).max(128) }).parse(req.body), meta(req)));
}));

r.post('/refresh', strict, ah(async (req, res) => {
  try { session(res, await auth.refresh(req.cookies[COOKIE])); }
  catch (err) { if (err.code !== 'REFRESH_RACE') res.clearCookie(COOKIE, { path: '/api/auth' }); throw err; }
}));

r.post('/logout', ah(async (req, res) => {
  const raw = req.cookies[COOKIE];
  if (raw) await pool.query(
    `UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL AND id = (SELECT session_id FROM refresh_tokens WHERE token_hash=$1)`, [sha256(raw)]);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.status(204).end();
}));

r.post('/logout-all', authenticate, ah(async (req, res) => {
  await auth.revokeAllSessions(req.user.id);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.status(204).end();
}));

r.post('/forgot-password', otpLimit, ah(async (req, res) => {
  await auth.forgotPassword(z.object({ email }).parse(req.body).email);
  res.status(202).json({ message: 'If that email is registered, a reset code is on its way.' });
}));

r.post('/reset-password', otpLimit, ah(async (req, res) => {
  const b = z.object({ email, code: z.string().regex(/^\d{6}$/), newPassword: password }).parse(req.body);
  await auth.resetPassword(b);
  res.json({ message: 'Password updated. Please sign in.' });
}));

r.post('/change-password', authenticate, strict, ah(async (req, res) => {
  const b = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).parse(req.body);
  await auth.changePassword(req.user, req.sessionId, b);
  res.json({ message: 'Password changed. Other devices were signed out.' });
}));

r.get('/me', authenticate, ah(async (req, res) => {
  res.json({ user: auth.publicUser(await auth.getUser(req.user.id)) });
}));

r.get('/sessions', authenticate, ah(async (req, res) => {
  res.json({ sessions: await auth.listSessions(req.user.id, req.sessionId) });
}));

r.delete('/sessions/:id', authenticate, ah(async (req, res) => {
  await auth.revokeSession(req.user.id, z.string().uuid().parse(req.params.id));
  res.status(204).end();
}));

export default r;
