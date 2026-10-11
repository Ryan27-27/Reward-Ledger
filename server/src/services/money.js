import crypto from 'node:crypto';
import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { entryHash, hashRequest, systemAccountId, postJournal } from './ledger.js';
import { notifyUser } from './notify.js';
import { issueOtp, verifyOtp } from './otp.js';
import { counters } from '../metrics.js';
import { addressOf, vpaOf } from './vpa.js';

const GENESIS = 'GENESIS';
export const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (n) => Number(n).toLocaleString('en-IN');

export async function inrWallet(db, userId, lock = false) {
  const { rows: [a] } = await db.query(
    `SELECT * FROM accounts WHERE kind='WALLET' AND currency='INR' AND user_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [userId]);
  if (!a) throw notFound('Money wallet');
  return a;
}

/**
 * THE ONLY WRITE PATH FOR RUPEES. Multi-leg, double-entry, inside the caller's transaction.
 *
 *  legs: [{ accountId, direction: 'CREDIT'|'DEBIT', amount, title?, reason? }]   (Σ credits must equal Σ debits)
 *
 *  - Member wallets and the TREASURY are locked (FOR UPDATE) in ONE global order (by id) before any balance is
 *    read, so concurrent transfers/payouts serialise and can never deadlock or overdraw.
 *  - Member wallets are hash-chained like the points ledger. The treasury keeps a cached balance with
 *    CHECK (balance >= 0): the reward pool can never pay out more than it holds.
 *  - Other system accounts (FUNDS_IN, MERCHANTS) are never locked — no global hot row.
 *  - Lock-order rule used everywhere: points wallet FIRST, then rupee wallet(s)/treasury in id order.
 */
export async function postMoney(client, p) {
  const {
    kind, legs, idempotencyKey, requestHash, description = null, referenceType = null, referenceId = null,
    metadata = {}, createdBy = null, reversalOf = null, skipLimits = false, enforceDailyLimit = false,
  } = p;

  let sum = 0;
  for (const l of legs) {
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be a positive whole number of paise');
    sum += l.direction === 'CREDIT' ? l.amount : -l.amount;
  }
  if (sum !== 0) throw new Error('postMoney: unbalanced legs');
  const ids = legs.map((l) => l.accountId);
  if (new Set(ids).size !== ids.length) throw new Error('postMoney: duplicate account in legs');

  const { rows: meta } = await client.query('SELECT id, kind, code, currency FROM accounts WHERE id = ANY($1::uuid[])', [ids]);
  if (meta.length !== ids.length) throw notFound('Account');
  if (meta.some((a) => a.currency !== 'INR')) throw new Error('postMoney: only INR accounts');

  const lockIds = meta.filter((a) => a.kind === 'WALLET' || a.code === 'TREASURY').map((a) => a.id).sort();
  const { rows: locked } = await client.query('SELECT * FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [lockIds]);
  const acct = new Map(locked.map((a) => [a.id, a]));

  // Idempotency, decided under the locks (primary account = first leg).
  const { rows: [existing] } = await client.query('SELECT * FROM journals WHERE account_id=$1 AND idempotency_key=$2', [ids[0], idempotencyKey]);
  if (existing) {
    if (existing.request_hash !== requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
    return { journal: existing, replayed: true, balances: Object.fromEntries(locked.map((a) => [a.id, a.balance])) };
  }

  // Business rules, checked before anything is written.
  for (const l of legs) {
    const a = acct.get(l.accountId);
    if (!a) continue; // unlocked system counter
    const isTreasury = a.code === 'TREASURY';
    const next = a.balance + (l.direction === 'CREDIT' ? l.amount : -l.amount);
    if (l.direction === 'DEBIT') {
      if (a.kind === 'WALLET' && a.status === 'FROZEN') throw forbidden('ACCOUNT_FROZEN', 'Your account is frozen. Contact support.');
      if (next < 0) {
        if (isTreasury) throw conflict('PAYOUT_UNAVAILABLE', 'Converting points to cash is temporarily unavailable. Your points are safe — please try again later.');
        throw conflict('INSUFFICIENT_FUNDS', `Insufficient wallet balance: you have ${rupees(a.balance)}, need ${rupees(l.amount)}`, { balance: a.balance, needed: l.amount });
      }
      if (enforceDailyLimit && a.kind === 'WALLET') {
        const { rows: [{ s }] } = await client.query(
          `SELECT COALESCE(SUM(e.amount),0)::bigint AS s FROM ledger_entries e JOIN journals j ON j.id=e.journal_id
            WHERE e.account_id=$1 AND e.direction='DEBIT' AND j.kind IN ('TRANSFER','WALLET_PAY') AND e.created_at > now() - interval '24 hours'`, [a.id]);
        if (s + l.amount > config.wallet.dailyOutboundPaise) {
          throw conflict('DAILY_LIMIT', `Daily spending limit of ${rupees(config.wallet.dailyOutboundPaise)} reached`, { spentToday: s, limit: config.wallet.dailyOutboundPaise });
        }
      }
    } else if (a.kind === 'WALLET' && !skipLimits && next > config.wallet.maxBalancePaise) {
      throw conflict('WALLET_LIMIT', `A wallet can hold at most ${rupees(config.wallet.maxBalancePaise)}`, { maxBalance: config.wallet.maxBalancePaise });
    }
  }

  const now = new Date();
  const { rows: [journal] } = await client.query(
    `INSERT INTO journals (kind, account_id, idempotency_key, request_hash, reversal_of, reference_type, reference_id, description, metadata, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [kind, ids[0], idempotencyKey, requestHash, reversalOf, referenceType, referenceId, description, metadata, createdBy, now]);

  const balances = {};
  for (const l of legs) {
    const a = acct.get(l.accountId);
    if (a?.kind === 'WALLET') {
      const next = a.balance + (l.direction === 'CREDIT' ? l.amount : -l.amount);
      const seq = a.seq + 1;
      const hash = entryHash({ prevHash: a.head_hash, accountId: a.id, seq, direction: l.direction, amount: l.amount, journalId: journal.id, createdAt: now });
      await client.query(
        `INSERT INTO ledger_entries (journal_id, account_id, direction, amount, seq, balance_after, prev_hash, hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [journal.id, a.id, l.direction, l.amount, seq, next, a.head_hash ?? GENESIS, hash, now]);
      await client.query('UPDATE accounts SET balance=$2, seq=$3, head_hash=$4 WHERE id=$1', [a.id, next, seq, hash]);
      balances[a.id] = next;
    } else {
      await client.query(
        `INSERT INTO ledger_entries (journal_id, account_id, direction, amount, created_at) VALUES ($1,$2,$3,$4,$5)`,
        [journal.id, l.accountId, l.direction, l.amount, now]);
      if (a) { // treasury
        const next = a.balance + (l.direction === 'CREDIT' ? l.amount : -l.amount);
        await client.query('UPDATE accounts SET balance=$2 WHERE id=$1', [a.id, next]);
        balances[a.id] = next;
      }
    }
    counters.journals.inc({ kind, direction: l.direction });
  }

  // Every committed credit/debit tells the member (in-app + email, via the outbox).
  for (const l of legs) {
    const a = acct.get(l.accountId);
    if (a?.kind !== 'WALLET' || !l.title) continue;
    const sign = l.direction === 'CREDIT' ? '+' : '−';
    await notifyUser(client, a.user_id, {
      type: l.direction === 'CREDIT' ? 'MONEY_CREDITED' : 'MONEY_DEBITED',
      title: l.title,
      body: `${sign}${rupees(l.amount)} · ${l.reason} · wallet balance ${rupees(balances[a.id])}`,
      data: { journalId: journal.id, kind, direction: l.direction, amount: l.amount, balance: balances[a.id], currency: 'INR' },
      email: { template: 'ledger-movement', data: { currency: 'INR', direction: l.direction, amount: l.amount, balance: balances[a.id], kind, title: l.title, reason: l.reason, reference: journal.id, at: now.toISOString() } },
    });
  }
  return { journal, replayed: false, balances };
}

// ───────────────────────── add money ─────────────────────────

/** Real money arrives via the signed gateway webhook (source 'WEBHOOK'); 'SIMULATED' is the demo button. */
export async function topUp({ userId, amountPaise, idempotencyKey, source = 'SIMULATED', externalRef = null }) {
  if (source === 'SIMULATED' && !config.simulatedPayments) throw forbidden('SIMULATION_DISABLED', 'Adding money requires the payment gateway in this environment');
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) throw new AppError(400, 'INVALID_AMOUNT', 'Minimum amount is ₹1');
  if (amountPaise > config.wallet.maxTopupPaise) throw new AppError(400, 'AMOUNT_TOO_LARGE', `You can add at most ${rupees(config.wallet.maxTopupPaise)} at a time`);
  return tx(async (client) => {
    const w = await inrWallet(client, userId);
    const funds = await systemAccountId(client, 'FUNDS_IN');
    const r = await postMoney(client, {
      kind: 'TOPUP', idempotencyKey: `topup:${idempotencyKey}`, requestHash: hashRequest('topup', amountPaise),
      description: 'Added to wallet', referenceType: externalRef ? 'gateway' : null, referenceId: externalRef,
      legs: [
        { accountId: w.id, direction: 'CREDIT', amount: amountPaise, title: 'Money added', reason: 'Added to your wallet' },
        { accountId: funds, direction: 'DEBIT', amount: amountPaise },
      ],
    });
    return { journal: r.journal, replayed: r.replayed, balance: r.balances[w.id] };
  });
}

// ───────────────────────── pay merchants from the wallet ─────────────────────────

/** Called inside payments.createPayment's transaction (points wallet already locked). */
export async function debitWalletForPayment(client, { userId, paymentId, amountPaise, label }) {
  const w = await inrWallet(client, userId);
  const merchants = await systemAccountId(client, 'MERCHANTS');
  return postMoney(client, {
    kind: 'WALLET_PAY', idempotencyKey: `wpay:${paymentId}`, requestHash: hashRequest('wpay', paymentId), enforceDailyLimit: true,
    description: label, referenceType: 'payment', referenceId: paymentId, createdBy: userId,
    legs: [
      { accountId: w.id, direction: 'DEBIT', amount: amountPaise, title: 'Paid from wallet', reason: label },
      { accountId: merchants, direction: 'CREDIT', amount: amountPaise },
    ],
  });
}

/** Refund of a wallet payment: money returns to the wallet (compensating journal, never an edit). */
export async function refundWalletPayment(client, { userId, paymentId, originalJournalId, amountPaise, actorId, reason }) {
  const w = await inrWallet(client, userId);
  const merchants = await systemAccountId(client, 'MERCHANTS');
  return postMoney(client, {
    kind: 'WALLET_REFUND', idempotencyKey: `wrefund:${paymentId}`, requestHash: hashRequest('wrefund', paymentId), skipLimits: true,
    description: reason, referenceType: 'payment', referenceId: paymentId, reversalOf: originalJournalId, createdBy: actorId,
    legs: [
      { accountId: w.id, direction: 'CREDIT', amount: amountPaise, title: 'Refund received', reason },
      { accountId: merchants, direction: 'DEBIT', amount: amountPaise },
    ],
  });
}

// ───────────────────────── send money (wallet → wallet) ─────────────────────────

const maskName = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0] + '*'.repeat(Math.max(2, w.length - 1))).join(' ');

/**
 * Resolve who is being paid. A payment address (name@pointwise) is the normal way; a verified account email also works.
 * Rule: this is a MEMBER-to-MEMBER transfer. It never creates a payment record, so it can never earn reward points.
 */
export async function findRecipient(user, identifier) {
  const id = String(identifier ?? '').trim().toLowerCase();
  const at = id.lastIndexOf('@');
  let r;
  if (at > 0 && id.slice(at + 1) === config.vpaDomain) {
    ({ rows: [r] } = await pool.query(
      `SELECT u.id, u.name FROM vpas v JOIN users u ON u.id=v.user_id WHERE v.handle=$1 AND u.email_verified_at IS NOT NULL AND u.status='ACTIVE'`, [id.slice(0, at)]));
  } else {
    ({ rows: [r] } = await pool.query(
      `SELECT id, name FROM users WHERE lower(email)=$1 AND email_verified_at IS NOT NULL AND status='ACTIVE'`, [id]));
  }
  if (!r) throw new AppError(404, 'RECIPIENT_NOT_FOUND', `No Pointwise member found for “${id.slice(0, 60)}”`);
  if (r.id === user.id) throw new AppError(400, 'SELF_TRANSFER', "You can't send money to yourself");
  return r;
}
export const lookupRecipient = async (user, identifier) => {
  const r = await findRecipient(user, identifier);
  return { name: maskName(r.name) };
};

function validateTransfer(amountPaise) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) throw new AppError(400, 'INVALID_AMOUNT', 'Minimum transfer is ₹1');
  if (amountPaise > config.wallet.maxTransferPaise) throw new AppError(400, 'AMOUNT_TOO_LARGE', `Maximum per transfer is ${rupees(config.wallet.maxTransferPaise)}`);
}

export async function transfer({ user, to: payee, amountPaise, note, otp, idempotencyKey }) {
  validateTransfer(amountPaise);
  const to = await findRecipient(user, payee);
  const sender = await inrWallet(pool, user.id);
  const key = `transfer:${idempotencyKey}`;
  const reqHash = hashRequest('transfer', to.id, amountPaise, note ?? '');

  // A retry after a dropped response replays without needing a second code.
  const { rows: [prior] } = await pool.query('SELECT * FROM journals WHERE account_id=$1 AND idempotency_key=$2', [sender.id, key]);
  if (prior) {
    if (prior.request_hash !== reqHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different transfer');
    return { journal: prior, replayed: true };
  }
  if (amountPaise >= config.wallet.transferStepUpPaise) {
    if (!otp) throw new AppError(403, 'STEP_UP_REQUIRED', 'Enter the code we emailed you to confirm this transfer');
    await verifyOtp(user.id, 'MONEY', otp, `transfer:${to.id}:${amountPaise}`);
  }
  return tx(async (client) => {
    const receiver = await inrWallet(client, to.id);
    const r = await postMoney(client, {
      kind: 'TRANSFER', idempotencyKey: key, requestHash: reqHash, enforceDailyLimit: true, createdBy: user.id,
      description: `Transfer from ${user.name} to ${to.name}${note ? ` — ${note}` : ''}`, referenceType: 'user', referenceId: to.id, metadata: { note: note ?? null },
      legs: [
        { accountId: sender.id, direction: 'DEBIT', amount: amountPaise, title: 'Money sent', reason: `Sent to ${to.name}${note ? ` — ${note}` : ''}` },
        { accountId: receiver.id, direction: 'CREDIT', amount: amountPaise, title: 'Money received', reason: `From ${user.name}${note ? ` — ${note}` : ''}` },
      ],
    });
    return { journal: r.journal, replayed: r.replayed, balance: r.balances[sender.id] };
  });
}

// ───────────────────────── points → wallet money ─────────────────────────

function validatePoints(points) {
  const block = config.conversion.blockPoints;
  if (!Number.isSafeInteger(points) || points < block || points % block !== 0) {
    throw new AppError(400, 'INVALID_POINTS', `Convert points in multiples of ${block} (minimum ${block})`);
  }
}
export { addressOf };
export const quote = (points) => ({ points, paise: points * config.conversion.paisePerPoint });

export async function startMoneyChallenge(user, input) {
  let ctx, label, required;
  if (input.action === 'convert') {
    validatePoints(input.points);
    required = input.points >= config.rewards.stepUpThreshold;
    ctx = `convert:${input.points}`;
    label = `converting ${fmt(input.points)} points to ${rupees(quote(input.points).paise)}`;
  } else {
    validateTransfer(input.amountPaise);
    const to = await findRecipient(user, input.to);
    required = input.amountPaise >= config.wallet.transferStepUpPaise;
    ctx = `transfer:${to.id}:${input.amountPaise}`;
    label = `sending ${rupees(input.amountPaise)} to ${to.name}`;
  }
  if (!required) return { required: false };
  await tx((client) => issueOtp(client, user, 'MONEY', ctx, label));
  return { required: true, expiresInMin: config.otp.ttlMin };
}

/**
 * Points → rupees. ONE transaction: debit the member's points, debit the TREASURY, credit the member's wallet.
 * If the treasury can't cover it (or the wallet is at its limit) nothing at all is committed.
 */
export async function convertPoints({ user, points, otp, idempotencyKey }) {
  validatePoints(points);
  const { paise } = quote(points);
  const { rows: [pw] } = await pool.query(`SELECT id FROM accounts WHERE kind='WALLET' AND currency='PTS' AND user_id=$1`, [user.id]);
  if (!pw) throw notFound('Wallet');

  const findPrior = async (db) => (await db.query('SELECT * FROM conversions WHERE user_id=$1 AND idempotency_key=$2', [user.id, idempotencyKey])).rows[0];
  const sameOrThrow = (c) => {
    if (c.points !== points) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different conversion');
    return { conversion: c, replayed: true };
  };
  const prior = await findPrior(pool);
  if (prior) return sameOrThrow(prior);

  if (points >= config.rewards.stepUpThreshold) {
    if (!otp) throw new AppError(403, 'STEP_UP_REQUIRED', 'Enter the code we emailed you to confirm this conversion');
    await verifyOtp(user.id, 'MONEY', otp, `convert:${points}`);
  }

  return tx(async (client) => {
    const { rows: [pts] } = await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [pw.id]); // points wallet first
    const again = await findPrior(client);
    if (again) return sameOrThrow(again);
    if (pts.status === 'FROZEN') throw forbidden('ACCOUNT_FROZEN', 'Your account is frozen. Contact support.');

    const { rows: [{ s }] } = await client.query(
      `SELECT COALESCE(SUM(points),0)::bigint AS s FROM conversions WHERE user_id=$1 AND created_at > now() - interval '24 hours'`, [user.id]);
    if (s + points > config.conversion.dailyLimitPoints) {
      throw conflict('DAILY_CONVERSION_LIMIT', `You can convert up to ${fmt(config.conversion.dailyLimitPoints)} points per day`, { convertedToday: s });
    }

    const id = crypto.randomUUID();
    const pj = await postJournal(client, {
      kind: 'CONVERT', walletId: pts.id, direction: 'DEBIT', amount: points, systemCode: 'CONVERTED',
      idempotencyKey: `convert:${idempotencyKey}`, requestHash: hashRequest('convert', points),
      description: `Converted to wallet cash (${rupees(paise)})`, referenceType: 'conversion', referenceId: id, createdBy: user.id,
    });
    const w = await inrWallet(client, user.id);
    const treasury = await systemAccountId(client, 'TREASURY');
    const mj = await postMoney(client, {
      kind: 'CONVERT_CREDIT', idempotencyKey: `convert:${idempotencyKey}`, requestHash: hashRequest('convert', points),
      description: `${fmt(points)} points converted to cash`, referenceType: 'conversion', referenceId: id, createdBy: user.id,
      legs: [
        { accountId: w.id, direction: 'CREDIT', amount: paise, title: 'Points converted to cash', reason: `${fmt(points)} points → ${rupees(paise)}` },
        { accountId: treasury, direction: 'DEBIT', amount: paise },
      ],
    });
    const { rows: [c] } = await client.query(
      `INSERT INTO conversions (id, user_id, points, paise, paise_per_point, points_journal_id, money_journal_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, user.id, points, paise, config.conversion.paisePerPoint, pj.journal.id, mj.journal.id, idempotencyKey]);
    return { conversion: c, replayed: false, pointsBalance: pj.balance, walletBalance: mj.balances[w.id] };
  });
}

// ───────────────────────── reads ─────────────────────────

export async function walletSummary(userId) {
  const w = await inrWallet(pool, userId);
  const vpa = await vpaOf(pool, userId);
  const [{ rows: [out] }, { rows: [conv] }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(e.amount),0)::bigint AS s FROM ledger_entries e JOIN journals j ON j.id=e.journal_id
        WHERE e.account_id=$1 AND e.direction='DEBIT' AND j.kind IN ('TRANSFER','WALLET_PAY') AND e.created_at > now() - interval '24 hours'`, [w.id]),
    pool.query(`SELECT COALESCE(SUM(points),0)::bigint AS s FROM conversions WHERE user_id=$1 AND created_at > now() - interval '24 hours'`, [userId]),
  ]);
  const c = config.conversion, l = config.wallet;
  return {
    balance: w.balance, status: w.status, vpa: vpa?.address ?? null,
    spentToday: out.s,
    limits: { maxBalance: l.maxBalancePaise, maxTopup: l.maxTopupPaise, maxTransfer: l.maxTransferPaise, dailyOutbound: l.dailyOutboundPaise, transferStepUp: l.transferStepUpPaise },
    conversion: { blockPoints: c.blockPoints, paisePerBlock: c.blockPoints * c.paisePerPoint, paisePerPoint: c.paisePerPoint, dailyLimitPoints: c.dailyLimitPoints, convertedToday: conv.s, stepUpPoints: config.rewards.stepUpThreshold },
    simulatedPayments: config.simulatedPayments,
  };
}

export async function treasuryReport() {
  const { rows: [t] } = await pool.query(
    `SELECT a.id, a.balance, COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END),0)::bigint AS derived
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id WHERE a.code='TREASURY' GROUP BY a.id`);
  const [{ rows: [pts] }, { rows: [inr] }, { rows: [conv] }] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(balance),0)::bigint AS s FROM accounts WHERE kind='WALLET' AND currency='PTS'`),
    pool.query(`SELECT COALESCE(SUM(balance),0)::bigint AS s FROM accounts WHERE kind='WALLET' AND currency='INR'`),
    pool.query(`SELECT COALESCE(SUM(paise),0)::bigint AS paise, COALESCE(SUM(points),0)::bigint AS points FROM conversions`),
  ]);
  const liability = pts.s * config.conversion.paisePerPoint; // what the pool would owe if EVERY outstanding point were converted today
  return {
    treasuryPaise: t.balance, ledgerPaise: t.derived, reconciled: t.balance === t.derived,
    memberWalletsPaise: inr.s, pointsOutstanding: pts.s, pointsLiabilityPaise: liability,
    coverage: liability > 0 ? Math.round((t.balance / liability) * 100) / 100 : null,
    lowFunds: liability > 0 && t.balance < liability * 0.2,
    convertedPaise: conv.paise, convertedPoints: conv.points, paisePerPoint: config.conversion.paisePerPoint,
  };
}
