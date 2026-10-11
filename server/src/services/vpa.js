import crypto from 'node:crypto';
import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const RESERVED = new Set(['admin', 'administrator', 'support', 'help', 'pointwise', 'treasury', 'root', 'system', 'merchant', 'merchants',
  'official', 'security', 'billing', 'payments', 'payment', 'wallet', 'rewards', 'refund', 'refunds', 'finance', 'staff', 'team', 'null', 'undefined']);

export const addressOf = (handle) => `${handle}@${config.vpaDomain}`;

/** "Riya Demo" → "riya.demo" ; always matches the DB format check or returns ''. */
export function sanitize(text) {
  let h = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').replace(/[._-]{2,}/g, (m) => m[0]).replace(/^[^a-z0-9]+/, '').slice(0, 22).replace(/[^a-z0-9]+$/, '');
  if (h.length < 3) h = '';
  return h;
}
const digits = (n) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');

/** Allocate a unique handle for a user (inside the caller's transaction). Collision-safe under concurrency. */
export async function assignVpa(client, user) {
  let base = sanitize(user.name) || sanitize(String(user.email).split('@')[0]) || 'user';
  if (RESERVED.has(base)) base = `${base}${digits(3)}`;
  for (let i = 0; i < 14; i++) {
    const handle = i === 0 ? base : `${base}${digits(i < 6 ? 2 : 4)}`;
    const { rows: [r] } = await client.query(
      'INSERT INTO vpas (user_id, handle) VALUES ($1,$2) ON CONFLICT (handle) DO NOTHING RETURNING handle', [user.id, handle]);
    if (r) return r.handle;
  }
  throw new Error('could not allocate a payment address');
}

/** Existing members created before payment addresses existed get one on the next start-up. Idempotent. */
export async function backfillVpas() {
  const { rows } = await pool.query('SELECT u.id, u.name, u.email FROM users u LEFT JOIN vpas v ON v.user_id=u.id WHERE v.id IS NULL ORDER BY u.created_at');
  for (const u of rows) await tx((c) => assignVpa(c, u));
  if (rows.length) logger.info({ count: rows.length }, 'assigned payment addresses to existing members');
  return rows.length;
}

export async function vpaOf(db, userId) {
  const { rows: [r] } = await db.query('SELECT handle FROM vpas WHERE user_id=$1', [userId]);
  return r ? { handle: r.handle, address: addressOf(r.handle) } : null;
}
