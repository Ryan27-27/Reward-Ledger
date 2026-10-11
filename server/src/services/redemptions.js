import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { randomCode } from '../lib/security.js';
import { postJournal, hashRequest } from './ledger.js';
import { issueOtp, verifyOtp } from './otp.js';

export async function listCatalog() {
  const { rows } = await pool.query(
    `SELECT id, sku, name, description, emoji, points_cost, stock FROM catalog_items WHERE active ORDER BY points_cost`);
  return rows.map((r) => ({ ...r, soldOut: r.stock !== null && r.stock <= 0 }));
}

export const needsStepUp = (item) => item.points_cost >= config.rewards.stepUpThreshold;

/** Step-up: high-value redemptions need a fresh emailed code, bound to the specific item. */
export async function startChallenge(user, itemId) {
  const { rows: [item] } = await pool.query('SELECT * FROM catalog_items WHERE id=$1 AND active', [itemId]);
  if (!item) throw notFound('Item');
  if (!needsStepUp(item)) return { required: false };
  await tx((client) => issueOtp(client, user, 'REDEEM', item.id, item.name));
  return { required: true, expiresInMin: config.otp.ttlMin };
}

/**
 * Redeem. The wallet is ALWAYS the authenticated user's own — there is no accountId in the request,
 * so there is structurally no way to spend someone else's points (no IDOR), and admins have no
 * redemption endpoint at all.
 */
export async function redeem({ user, itemId, otp, idempotencyKey }) {
  const { rows: [acct0] } = await pool.query(`SELECT id FROM accounts WHERE kind='WALLET' AND currency='PTS' AND user_id=$1`, [user.id]);
  if (!acct0) throw notFound('Wallet');

  // Replay first: a retry after a dropped response must not need a second OTP.
  const prior = await findByKey(pool, acct0.id, idempotencyKey);
  if (prior) return sameItemOrThrow(prior, itemId);

  const { rows: [item0] } = await pool.query('SELECT * FROM catalog_items WHERE id=$1 AND active', [itemId]);
  if (!item0) throw notFound('Item');
  if (needsStepUp(item0)) {
    if (!otp) throw new AppError(403, 'STEP_UP_REQUIRED', 'Enter the code we emailed you to confirm this redemption');
    await verifyOtp(user.id, 'REDEEM', otp, item0.id);
  }

  return tx(async (client) => {
    const { rows: [acct] } = await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [acct0.id]);
    const again = await findByKey(client, acct.id, idempotencyKey);
    if (again) return sameItemOrThrow(again, itemId);
    if (acct.status === 'FROZEN') throw forbidden('ACCOUNT_FROZEN', 'Your rewards account is frozen. Contact support.');

    // Atomic stock decrement: no overselling even under concurrency.
    const { rows: [item] } = await client.query(
      `UPDATE catalog_items SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - 1 END
        WHERE id=$1 AND active AND (stock IS NULL OR stock > 0) RETURNING *`, [itemId]);
    if (!item) throw conflict('OUT_OF_STOCK', 'This reward is sold out');

    const { journal } = await postJournal(client, {
      kind: 'REDEEM', walletId: acct.id, direction: 'DEBIT', amount: item.points_cost, systemCode: 'REDEMPTION',
      idempotencyKey: `redeem:${idempotencyKey}`, requestHash: hashRequest('redeem', itemId),
      description: `Redeemed ${item.name}`, referenceType: 'catalog_item', referenceId: item.id, createdBy: user.id,
    });
    const voucher = `PW-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
    const { rows: [r] } = await client.query(
      `INSERT INTO redemptions (account_id, item_id, points_spent, voucher_code, journal_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [acct.id, item.id, item.points_cost, voucher, journal.id, idempotencyKey]);
    return { redemption: r, item: { name: item.name, emoji: item.emoji }, balance: acct.balance - item.points_cost, replayed: false };
  });
}

async function findByKey(db, accountId, key) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, c.name, c.emoji FROM redemptions r JOIN catalog_items c ON c.id=r.item_id WHERE r.account_id=$1 AND r.idempotency_key=$2`, [accountId, key]);
  return r;
}
function sameItemOrThrow(r, itemId) {
  if (r.item_id !== itemId) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different redemption');
  return { redemption: r, item: { name: r.name, emoji: r.emoji }, replayed: true };
}

export async function listRedemptions(userId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.points_spent, r.voucher_code, r.created_at, c.name, c.emoji
       FROM redemptions r JOIN accounts a ON a.id=r.account_id JOIN catalog_items c ON c.id=r.item_id
      WHERE a.user_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [userId]);
  return rows;
}
