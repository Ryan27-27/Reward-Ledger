import crypto from 'node:crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { sha256 } from '../lib/security.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { notifyUser } from './notify.js';
import { counters } from '../metrics.js';

const GENESIS = 'GENESIS';
const EARNING_KINDS = new Set(['EARN', 'REFERRAL', 'GRANT']);
const sysCache = new Map();

export async function systemAccountId(client, code) {
  if (!sysCache.has(code)) {
    const { rows: [r] } = await client.query(`SELECT id FROM accounts WHERE kind='SYSTEM' AND code=$1`, [code]);
    if (!r) throw new Error(`system account ${code} missing`);
    sysCache.set(code, r.id);
  }
  return sysCache.get(code);
}
export const resetSystemCache = () => sysCache.clear();

export function entryHash({ prevHash, accountId, seq, direction, amount, journalId, createdAt }) {
  return sha256([prevHash ?? GENESIS, accountId, seq, direction, amount, journalId, createdAt.toISOString()].join('|'));
}

export const hashRequest = (...parts) => sha256(parts.join('|'));

const MOVEMENT_COPY = {
  EARN:     (d) => ({ title: 'Points credited', reason: d || 'Reward for your payment' }),
  REFERRAL: (d) => ({ title: 'Referral bonus credited', reason: d || 'A friend you referred made their first payment' }),
  GRANT:    (d) => ({ title: 'Points credited', reason: d || 'Goodwill credit from Pointwise' }),
  REDEEM:   (d) => ({ title: 'Points redeemed', reason: d || 'Redemption' }),
  EXPIRE:   (d) => ({ title: 'Points expired', reason: d || 'Points reached their expiry date' }),
  REVERSAL: (d) => ({ title: 'Points reversed', reason: d || 'A previous credit was reversed' }),
  CONVERT:  (d) => ({ title: 'Points converted to cash', reason: d || 'Converted to wallet money' }),
};

/**
 * THE ONLY WRITE PATH INTO THE LEDGER. Must be called inside a transaction (pass the client).
 *
 * Posts one balanced journal between a user's wallet and a system account:
 *   direction CREDIT → wallet +amount,  system account −amount (DEBIT)
 *   direction DEBIT  → wallet −amount,  system account +amount (CREDIT)
 *
 * Concurrency: the wallet row is locked (SELECT … FOR UPDATE) *before* the balance is read, so two
 * concurrent debits serialise and can't both pass the check. The DB CHECK (balance >= 0) is the
 * second line of defence; the deferred balance trigger and immutability triggers are the third.
 */
export async function postJournal(client, p) {
  const {
    kind, walletId, direction, amount, systemCode, idempotencyKey, requestHash,
    description = null, referenceType = null, referenceId = null, metadata = {},
    createdBy = null, reversalOf = null, expiresAt = null, lotId = null, preferLotOfJournal = null,
    notify = true,
  } = p;

  if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be a positive integer');

  const { rows: [acct] } = await client.query(`SELECT * FROM accounts WHERE id=$1 AND kind='WALLET' FOR UPDATE`, [walletId]);
  if (!acct) throw notFound('Wallet');
  if (acct.currency !== 'PTS') throw new Error('postJournal is for points wallets; use postMoney for rupees');

  // Idempotency — decided under the wallet lock so two identical concurrent requests can't both proceed.
  const { rows: [existing] } = await client.query(`SELECT * FROM journals WHERE account_id=$1 AND idempotency_key=$2`, [walletId, idempotencyKey]);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
    }
    return { journal: existing, replayed: true, balance: acct.balance };
  }

  const delta = direction === 'CREDIT' ? amount : -amount;
  const newBalance = acct.balance + delta;
  if (newBalance < 0) {
    throw conflict('INSUFFICIENT_BALANCE', `Insufficient points: balance ${acct.balance}, needed ${amount}`, { balance: acct.balance, needed: amount });
  }

  const now = new Date();
  const { rows: [journal] } = await client.query(
    `INSERT INTO journals (kind, account_id, idempotency_key, request_hash, reversal_of, reference_type, reference_id, description, metadata, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [kind, walletId, idempotencyKey, requestHash, reversalOf, referenceType, referenceId, description, metadata, createdBy, now],
  );

  // Counter-leg on the system account (never locked, never chained → no global hot row).
  const sysId = await systemAccountId(client, systemCode);
  await client.query(
    `INSERT INTO ledger_entries (journal_id, account_id, direction, amount, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [journal.id, sysId, direction === 'CREDIT' ? 'DEBIT' : 'CREDIT', amount, now],
  );

  // Wallet leg: sequence number + running balance + hash chained to the previous entry.
  const seq = acct.seq + 1;
  const hash = entryHash({ prevHash: acct.head_hash, accountId: walletId, seq, direction, amount, journalId: journal.id, createdAt: now });
  await client.query(
    `INSERT INTO ledger_entries (journal_id, account_id, direction, amount, seq, balance_after, prev_hash, hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [journal.id, walletId, direction, amount, seq, newBalance, acct.head_hash ?? GENESIS, hash, now],
  );
  await client.query(
    `UPDATE accounts SET balance=$2, seq=$3, head_hash=$4,
       lifetime_earned = lifetime_earned + $5 WHERE id=$1`,
    [walletId, newBalance, seq, hash, direction === 'CREDIT' && EARNING_KINDS.has(kind) ? amount : 0],
  );

  if (direction === 'CREDIT') {
    const exp = expiresAt ?? new Date(new Date(now).setMonth(now.getMonth() + config.rewards.expiryMonths));
    await client.query(
      `INSERT INTO point_lots (account_id, journal_id, initial, remaining, earned_at, expires_at) VALUES ($1,$2,$3,$3,$4,$5)`,
      [walletId, journal.id, amount, now, exp],
    );
  } else {
    await consumeLots(client, walletId, amount, { lotId, preferLotOfJournal });
  }

  counters.journals.inc({ kind, direction });

  if (notify) {
    const copy = MOVEMENT_COPY[kind](description);
    const sign = direction === 'CREDIT' ? '+' : '−';
    await notifyUser(client, acct.user_id, {
      type: direction === 'CREDIT' ? 'POINTS_CREDITED' : 'POINTS_DEBITED',
      title: copy.title,
      body: `${sign}${amount.toLocaleString('en-IN')} points · ${copy.reason} · balance ${newBalance.toLocaleString('en-IN')}`,
      data: { journalId: journal.id, kind, direction, amount, balance: newBalance },
      email: {
        template: 'ledger-movement',
        data: { direction, amount, balance: newBalance, kind, title: copy.title, reason: copy.reason, reference: journal.id, at: now.toISOString() },
      },
    });
  }

  return { journal, replayed: false, balance: newBalance, seq };
}

/** Consume point lots soonest-expiring first (optionally one specific lot, or one preferred lot first). */
async function consumeLots(client, walletId, amount, { lotId, preferLotOfJournal }) {
  const params = [walletId];
  let where = 'account_id=$1 AND remaining>0';
  let order = 'expires_at, earned_at, id';
  if (lotId) { params.push(lotId); where += ` AND id=$${params.length}`; }
  if (preferLotOfJournal) { params.push(preferLotOfJournal); order = `(journal_id = $${params.length}) DESC, ${order}`; }
  const { rows } = await client.query(`SELECT id, remaining FROM point_lots WHERE ${where} ORDER BY ${order} FOR UPDATE`, params);
  let left = amount;
  for (const lot of rows) {
    if (left === 0) break;
    const take = Math.min(lot.remaining, left);
    await client.query('UPDATE point_lots SET remaining = remaining - $2 WHERE id=$1', [lot.id, take]);
    left -= take;
  }
  if (left !== 0) throw new Error(`lot invariant violated for wallet ${walletId}: ${left} points not covered by lots`);
}

/** Post the compensating journal for a previously posted CREDIT. History is never edited. */
export async function reverseJournal(client, { journalId, allowedKinds, createdBy, reason, idempotencyKey }) {
  const { rows: [orig] } = await client.query('SELECT * FROM journals WHERE id=$1', [journalId]);
  if (!orig) throw notFound('Journal');
  if (!allowedKinds.includes(orig.kind)) throw new AppError(400, 'NOT_REVERSIBLE', `A ${orig.kind} journal cannot be reversed this way`);
  const { rows: [entry] } = await client.query(`SELECT direction, amount FROM ledger_entries WHERE journal_id=$1 AND seq IS NOT NULL`, [journalId]);
  if (entry.direction !== 'CREDIT') throw new AppError(400, 'NOT_REVERSIBLE', 'Only credits can be reversed');
  const { rows: [already] } = await client.query('SELECT id FROM journals WHERE reversal_of=$1', [journalId]);
  if (already) throw conflict('ALREADY_REVERSED', 'This entry has already been reversed');
  return postJournal(client, {
    kind: 'REVERSAL', walletId: orig.account_id, direction: 'DEBIT', amount: entry.amount, systemCode: 'ISSUANCE',
    idempotencyKey: idempotencyKey ?? `rev:${journalId}`, requestHash: hashRequest('rev', journalId),
    description: reason, reversalOf: journalId, createdBy, preferLotOfJournal: journalId,
    referenceType: 'journal', referenceId: journalId,
  });
}

// ───────────────────────── reads & audit ─────────────────────────

export async function getStatement(accountId, { before = null, limit = 25 } = {}) {
  const { rows } = await pool.query(
    `SELECT e.seq, e.direction, e.amount, e.balance_after, e.created_at,
            j.id AS journal_id, j.kind, j.description, j.reference_type, j.reference_id,
            EXISTS (SELECT 1 FROM journals r WHERE r.reversal_of = j.id) AS reversed
       FROM ledger_entries e JOIN journals j ON j.id = e.journal_id
      WHERE e.account_id=$1 AND e.seq IS NOT NULL AND ($2::bigint IS NULL OR e.seq < $2)
      ORDER BY e.seq DESC LIMIT $3`,
    [accountId, before, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextBefore: more ? items[items.length - 1].seq : null };
}

/** Replays one wallet's whole history and checks every invariant. The cached balance is never trusted. */
export async function verifyWallet(accountId, db = pool) {
  const { rows: [acct] } = await db.query(`SELECT * FROM accounts WHERE id=$1 AND kind='WALLET'`, [accountId]);
  if (!acct) throw notFound('Wallet');
  const problems = [];
  let prevHash = null, seq = 0, running = 0, count = 0, cursor = 0;
  for (;;) {
    const { rows } = await db.query(
      `SELECT e.*, j.id AS jid FROM ledger_entries e JOIN journals j ON j.id=e.journal_id
        WHERE e.account_id=$1 AND e.seq > $2 ORDER BY e.seq LIMIT 1000`, [accountId, cursor]);
    if (!rows.length) break;
    for (const e of rows) {
      count++;
      seq += 1;
      if (e.seq !== seq) problems.push(`sequence gap: expected ${seq}, found ${e.seq}`);
      if ((e.prev_hash ?? GENESIS) !== (prevHash ?? GENESIS)) problems.push(`entry #${e.seq}: broken link to previous entry`);
      const h = entryHash({ prevHash, accountId, seq: e.seq, direction: e.direction, amount: e.amount, journalId: e.journal_id, createdAt: e.created_at });
      if (h !== e.hash) problems.push(`entry #${e.seq}: hash mismatch (entry was altered)`);
      running += e.direction === 'CREDIT' ? e.amount : -e.amount;
      if (running !== e.balance_after) problems.push(`entry #${e.seq}: running balance ${running} ≠ recorded ${e.balance_after}`);
      prevHash = e.hash;
      cursor = e.seq;
    }
    if (problems.length > 20) break;
  }
  if (running !== acct.balance) problems.push(`cached balance ${acct.balance} ≠ replayed balance ${running}`);
  if (acct.seq !== seq) problems.push(`account sequence ${acct.seq} ≠ ${seq}`);
  if ((acct.head_hash ?? null) !== (prevHash ?? null)) problems.push('account head hash does not match last entry');
  if (acct.currency === 'PTS') {
    const { rows: [lots] } = await db.query('SELECT COALESCE(SUM(remaining),0)::bigint AS s FROM point_lots WHERE account_id=$1', [accountId]);
    if (lots.s !== running) problems.push(`lot total ${lots.s} ≠ balance ${running}`);
  }
  return { ok: problems.length === 0, entries: count, balance: running, problems: problems.slice(0, 20), checkedAt: new Date().toISOString() };
}

export async function verifyAll() {
  const problems = [];
  const { rows: bad } = await pool.query(
    `SELECT journal_id FROM ledger_entries GROUP BY journal_id
      HAVING SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) <> 0 LIMIT 5`);
  for (const b of bad) problems.push(`journal ${b.journal_id} is unbalanced`);
  const { rows: [tot] } = await pool.query(`SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::bigint AS s FROM ledger_entries`);
  if (tot.s !== 0) problems.push(`ledger as a whole does not sum to zero (${tot.s})`);
  // The treasury keeps a cached balance (it is balance-checked on every payout) — it must equal the replayed ledger.
  const { rows: [t] } = await pool.query(
    `SELECT a.balance, COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END),0)::bigint AS derived
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id WHERE a.code='TREASURY' GROUP BY a.id`);
  if (t && t.balance !== t.derived) problems.push(`treasury cached balance ${t.balance} ≠ ledger ${t.derived}`);
  const { rows: wallets } = await pool.query(`SELECT id FROM accounts WHERE kind='WALLET'`);
  let walletsBad = 0;
  for (const w of wallets) {
    const r = await verifyWallet(w.id);
    if (!r.ok) { walletsBad++; problems.push(`wallet ${w.id}: ${r.problems[0]}`); }
  }
  return { ok: problems.length === 0, wallets: wallets.length, walletsFailing: walletsBad, problems: problems.slice(0, 20), checkedAt: new Date().toISOString() };
}

export const newId = () => crypto.randomUUID();
