import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** scrypt$N$r$p$salt$hash — memory-hard, no native deps. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64'), KEYLEN, { N: +n, r: +r, p: +p });
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
// Burn the same CPU for unknown users so login timing doesn't reveal which emails exist.
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing-equalisation');

export const generateOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
export const hashOtp = (userId, purpose, context, code) => hmac(config.otpSecret, `${userId}:${purpose}:${context ?? ''}:${code}`);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

export const signAccessToken = (user, sessionId) =>
  jwt.sign({ role: user.role, sid: sessionId }, config.jwtSecret, { subject: user.id, expiresIn: config.accessTtlSec, algorithm: 'HS256' });
export const verifyAccessToken = (token) => jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
