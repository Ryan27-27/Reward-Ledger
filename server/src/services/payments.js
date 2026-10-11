import crypto from 'node:crypto';
import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { computeReward, CATEGORIES, formatInr } from './rules.js';
import { postJournal, reverseJournal, hashRequest } from './ledger.js';
import { enqueueTopic } from './notify.js';
import { debitWalletForPayment, refundWalletPayment } from './money.js';
import { forbidden } from '../lib/errors.js';

const walletOfUser = async (client, userId, lock = false) => {
  const { rows: [a] } = await client.query(`SELECT * FROM accounts WHERE kind='WALLET' AND currency='PTS' AND user_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [userId]);
  if (!a) throw notFound('Wallet');
  return a;
};

function validateAmount(amountPaise) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) throw new AppError(400, 'INVALID_AMOUNT', 'Minimum payment is ₹1');
  if (amountPaise > config.rewards.maxPaymentPaise) throw new AppError(400, 'AMOUNT_TOO_LARGE', `Maximum payment is ${formatInr(config.rewards.maxPaymentPaise)}`);
}

/**
 * The first-payment bonus (and the referrer's bonus it triggers) needs a payment of at least ₹100, and is paid once.
 * Refunded payments still count as "used", so refund-and-repeat can't farm it, and a ₹1 sign-up payment can't claim it.
 */
async function bonusEligible(db, accountId, amountPaise) {
  if (amountPaise < config.rewards.firstBonusMinPaise) return false;
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM payments WHERE account_id=$1 AND amount_paise >= $2', [accountId, config.rewards.firstBonusMinPaise]);
  return n === 0;
}

/** What WOULD this payment earn? Same code path as the real thing, so preview == actual. */
export async function previewReward(userId, { category, amountPaise }) {
  validateAmount(amountPaise);
  const acct = await walletOfUser(pool, userId);
  return computeReward({ category, amountPaise, lifetimeSpendPaise: acct.lifetime_spend_paise, isFirstPayment: await bonusEligible(pool, acct.id, amountPaise) });
}

/**
 * Payment → reward, atomically. One transaction: lock wallet, compute reward from the server's
 * own rules (the client can never send points), record the payment with its explanation,
 * post the ledger credit. Used by both the simulated checkout and the signed gateway webhook.
 */
export async function createPayment({ userId, category, amountPaise, description = null, idempotencyKey, source = 'SIMULATED', externalRef = null, method = 'EXTERNAL' }) {
  validateAmount(amountPaise);
  // A simulated card/UPI payment mints reward points from nothing, so it only exists where demos are allowed.
  if (method === 'EXTERNAL' && source === 'SIMULATED' && !config.simulatedPayments) throw forbidden('SIMULATION_DISABLED', 'Pay from your wallet, or via the payment gateway');
  if (!CATEGORIES[category]) throw new AppError(400, 'INVALID_CATEGORY', 'Unknown payment category');
  return tx(async (client) => {
    const acct = await walletOfUser(client, userId, true); // serialises payments per wallet
    const { rows: [dup] } = await client.query('SELECT * FROM payments WHERE account_id=$1 AND idempotency_key=$2', [acct.id, idempotencyKey]);
    if (dup) {
      if (dup.category !== category || dup.amount_paise !== amountPaise || dup.method !== method) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different payment');
      return { payment: dup, replayed: true };
    }
    const isFirst = await bonusEligible(client, acct.id, amountPaise);
    const reward = computeReward({ category, amountPaise, lifetimeSpendPaise: acct.lifetime_spend_paise, isFirstPayment: isFirst });

    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO payments (id, account_id, category, amount_paise, description, points_awarded, rule_applied, source, external_ref, idempotency_key, method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, acct.id, category, amountPaise, description, reward.points, reward.explanation, source, externalRef, idempotencyKey, method]);

    // Paying from the rupee wallet: the money leaves the wallet in the SAME transaction as the reward is credited.
    if (method === 'WALLET') {
      const label = `${CATEGORIES[category].label} payment of ${formatInr(amountPaise)}`;
      const w = await debitWalletForPayment(client, { userId, paymentId: id, amountPaise, label });
      await client.query('UPDATE payments SET wallet_journal_id=$2 WHERE id=$1', [id, w.journal.id]);
    }

    if (reward.points > 0) {
      const { journal } = await postJournal(client, {
        kind: 'EARN', walletId: acct.id, direction: 'CREDIT', amount: reward.points, systemCode: 'ISSUANCE',
        idempotencyKey: `pay:${id}`, requestHash: hashRequest('pay', id),
        description: `${CATEGORIES[category].label} payment of ${formatInr(amountPaise)}`,
        referenceType: 'payment', referenceId: id, metadata: { rule: reward.explanation, tier: reward.tier },
      });
      await client.query('UPDATE payments SET reward_journal_id=$2 WHERE id=$1', [id, journal.id]);
    }
    await client.query('UPDATE accounts SET lifetime_spend_paise = lifetime_spend_paise + $2 WHERE id=$1', [acct.id, amountPaise]);

    if (isFirst) {
      const { rows: [u] } = await client.query('SELECT referred_by FROM users WHERE id=$1', [userId]);
      if (u?.referred_by) await enqueueTopic(client, 'REFERRAL_REWARD', { referrerUserId: u.referred_by, refereeUserId: userId });
    }
    const { rows: [payment] } = await client.query('SELECT * FROM payments WHERE id=$1', [id]);
    return { payment, replayed: false, reward };
  });
}

/** Outbox handler: referrer gets a bonus when their friend makes a first payment. Idempotent per referee. */
export async function rewardReferral({ referrerUserId, refereeUserId }) {
  await tx(async (client) => {
    const referrer = await walletOfUser(client, referrerUserId);
    const { rows: [ref] } = await client.query('SELECT name FROM users WHERE id=$1', [refereeUserId]);
    await postJournal(client, {
      kind: 'REFERRAL', walletId: referrer.id, direction: 'CREDIT', amount: config.rewards.referralBonus, systemCode: 'ISSUANCE',
      idempotencyKey: `referral:${refereeUserId}`, requestHash: hashRequest('referral', refereeUserId),
      description: `Referral bonus — ${ref.name} made their first payment`, referenceType: 'user', referenceId: refereeUserId,
    });
  });
}

/** Refund: claw the reward back through a compensating journal. Refused if the points were already spent. */
export async function refundPayment({ paymentId, actorId = null, reason = 'Payment refunded', client: outer = null }) {
  const run = async (client) => {
    const { rows: [p] } = await client.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
    if (!p) throw notFound('Payment');
    if (p.status === 'REFUNDED') return { payment: p, replayed: true };
    const { rows: [acct] } = await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [p.account_id]);
    let result = null;
    if (p.reward_journal_id) {
      result = await reverseJournal(client, {
        journalId: p.reward_journal_id, allowedKinds: ['EARN'], createdBy: actorId, reason: `${reason} (${formatInr(p.amount_paise)})`,
        idempotencyKey: `refund:${p.id}`,
      });
    }
    if (p.method === 'WALLET' && p.wallet_journal_id) {
      const { rows: [{ user_id: userId }] } = await client.query('SELECT user_id FROM accounts WHERE id=$1', [p.account_id]);
      await refundWalletPayment(client, { userId, paymentId: p.id, originalJournalId: p.wallet_journal_id, amountPaise: p.amount_paise, actorId, reason: `${reason} (${formatInr(p.amount_paise)})` });
    }
    await client.query(`UPDATE payments SET status='REFUNDED' WHERE id=$1`, [p.id]);
    await client.query('UPDATE accounts SET lifetime_spend_paise = GREATEST(0, lifetime_spend_paise - $2) WHERE id=$1', [acct.id, p.amount_paise]);
    return { payment: { ...p, status: 'REFUNDED' }, replayed: false, journal: result?.journal };
  };
  return outer ? run(outer) : tx(run);
}

export async function listPayments(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT p.id, p.category, p.amount_paise, p.description, p.status, p.method, p.points_awarded, p.rule_applied, p.created_at
       FROM payments p JOIN accounts a ON a.id = p.account_id WHERE a.user_id=$1 ORDER BY p.created_at DESC LIMIT $2`, [userId, limit]);
  return rows;
}

/** Signed gateway webhook events. Duplicate deliveries are harmless (idempotent by external reference). */
export async function handleWebhookEvent(evt) {
  if (evt.type === 'payment.succeeded') {
    const { userId, externalRef, category, amountPaise, description } = evt.data;
    const { rows: [existing] } = await pool.query('SELECT id FROM payments WHERE external_ref=$1', [externalRef]);
    if (existing) return { duplicate: true };
    return createPayment({ userId, category, amountPaise, description, idempotencyKey: `wh:${externalRef}`, source: 'WEBHOOK', externalRef });
  }
  if (evt.type === 'payment.refunded') {
    const { rows: [p] } = await pool.query('SELECT id FROM payments WHERE external_ref=$1', [evt.data.externalRef]);
    if (!p) throw notFound('Payment');
    return refundPayment({ paymentId: p.id, reason: 'Refunded by payment gateway' });
  }
  if (evt.type === 'wallet.topup.succeeded') {
    const { topUp } = await import('./money.js');
    return topUp({ userId: evt.data.userId, amountPaise: evt.data.amountPaise, idempotencyKey: `wh:${evt.data.externalRef}`, source: 'WEBHOOK', externalRef: evt.data.externalRef });
  }
  throw new AppError(400, 'UNKNOWN_EVENT', `Unsupported event type ${evt.type}`);
}
