import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { postJournal, reverseJournal, hashRequest, getStatement } from './ledger.js';
import { refundPayment } from './payments.js';
import { notifyUser, enqueueEmail } from './notify.js';
import { formatInr } from './rules.js';
import { postMoney, treasuryReport } from './money.js';
import { systemAccountId } from './ledger.js';
import { addressOf } from './vpa.js';

/*
 * WHAT ADMINS CAN AND CANNOT DO (by construction, not by policy):
 *  - There is no endpoint that debits, redeems or spends a user's points. Debits come only from
 *    (a) the wallet owner redeeming, (b) the expiry job, and (c) a *compensating reversal* that
 *    was requested by one admin and approved by a different admin.
 *  - Every mutation here is written to an immutable audit log in the same transaction.
 *  - Every credit/debit the user sees — including admin-caused ones — also emails them.
 */

export const audit = (client, actorId, action, target, details = {}, ip = null) =>
  client.query('INSERT INTO admin_audit_log (actor_id, action, target, details, ip) VALUES ($1,$2,$3,$4,$5)', [actorId, action, target, details, ip]);

export async function stats() {
  const [{ rows: [u] }, { rows: [pts] }, { rows: sys }, { rows: [pay] }, { rows: [ap] }, { rows: [ob] }] = await Promise.all([
    pool.query(`SELECT count(*)::int AS users FROM users WHERE role='USER'`),
    pool.query(`SELECT COALESCE(SUM(balance),0)::bigint AS outstanding FROM accounts WHERE kind='WALLET' AND currency='PTS'`),
    pool.query(`SELECT a.code, COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END),0)::bigint AS bal
                  FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id WHERE a.kind='SYSTEM' GROUP BY a.code`),
    pool.query(`SELECT count(*)::int AS n, COALESCE(SUM(amount_paise) FILTER (WHERE status='COMPLETED'),0)::bigint AS volume FROM payments`),
    pool.query(`SELECT count(*)::int AS pending FROM approvals WHERE status='PENDING'`),
    pool.query(`SELECT count(*) FILTER (WHERE status='PENDING')::int AS pending, count(*) FILTER (WHERE status='DEAD')::int AS dead FROM outbox`),
  ]);
  const bal = Object.fromEntries(sys.map((r) => [r.code, r.bal]));
  return {
    users: u.users, pointsOutstanding: pts.outstanding,
    pointsIssued: -(bal.ISSUANCE ?? 0), pointsRedeemed: bal.REDEMPTION ?? 0, pointsExpired: bal.EXPIRY ?? 0, pointsConverted: bal.CONVERTED ?? 0,
    treasuryPaise: bal.TREASURY ?? 0, merchantPaidPaise: bal.MERCHANTS ?? 0,
    payments: pay.n, paymentVolumePaise: pay.volume, pendingApprovals: ap.pending,
    emailQueue: { pending: ob.pending, dead: ob.dead },
  };
}

export async function listUsers({ q = '', limit = 25, offset = 0 }) {
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, a.id AS account_id, a.balance, a.status AS account_status, a.lifetime_spend_paise,
            (SELECT balance FROM accounts m WHERE m.user_id=u.id AND m.currency='INR' AND m.kind='WALLET') AS wallet_paise,
            v.handle AS vpa_handle
       FROM users u JOIN accounts a ON a.user_id=u.id AND a.currency='PTS' AND a.kind='WALLET'
       LEFT JOIN vpas v ON v.user_id=u.id
      WHERE ($1 = '' OR u.email ILIKE $2 OR u.name ILIKE $2 OR v.handle ILIKE $2)
      ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`, [q, like, limit, offset]);
  return rows.map((r) => ({ ...r, vpa: r.vpa_handle ? addressOf(r.vpa_handle) : null }));
}

export async function userDetail(userId) {
  const { rows: [u] } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, a.id AS account_id, a.balance, a.status AS account_status, a.lifetime_spend_paise, a.lifetime_earned,
            (SELECT balance FROM accounts m WHERE m.user_id=u.id AND m.currency='INR' AND m.kind='WALLET') AS wallet_paise
       FROM users u JOIN accounts a ON a.user_id=u.id AND a.currency='PTS' AND a.kind='WALLET' WHERE u.id=$1`, [userId]);
  if (!u) throw notFound('User');
  const statement = await getStatement(u.account_id, { limit: 20 });
  const { rows: payments } = await pool.query(
    `SELECT id, category, amount_paise, status, points_awarded, created_at FROM payments WHERE account_id=$1 ORDER BY created_at DESC LIMIT 10`, [u.account_id]);
  return { ...u, statement: statement.items, payments };
}

export async function setAccountFrozen(actor, accountId, frozen, reason, ip) {
  return tx(async (client) => {
    const { rows: [owner] } = await client.query(`SELECT user_id FROM accounts WHERE id=$1 AND kind='WALLET'`, [accountId]);
    if (!owner) throw notFound('Account');
    // Freezing a member freezes BOTH their wallets (points and rupees): no redeeming, converting, paying or sending.
    const { rows: [a] } = await client.query(
      `UPDATE accounts SET status=$2 WHERE user_id=$1 AND kind='WALLET' RETURNING id, user_id, status`, [owner.user_id, frozen ? 'FROZEN' : 'ACTIVE']);
    await audit(client, actor.id, frozen ? 'ACCOUNT_FROZEN' : 'ACCOUNT_UNFROZEN', accountId, { reason }, ip);
    await notifyUser(client, a.user_id, {
      type: 'ACCOUNT_STATUS', title: frozen ? 'Rewards account frozen' : 'Rewards account reactivated', body: reason,
      email: { template: 'account-status', data: { status: frozen ? 'frozen' : 'reactivated', reason } },
    });
    return a;
  });
}

export async function setUserSuspended(actor, userId, suspended, reason, ip) {
  if (userId === actor.id) throw new AppError(400, 'CANNOT_SELF_SUSPEND', 'You cannot suspend yourself');
  return tx(async (client) => {
    const { rows: [u] } = await client.query(`UPDATE users SET status=$2 WHERE id=$1 RETURNING id, status`, [userId, suspended ? 'SUSPENDED' : 'ACTIVE']);
    if (!u) throw notFound('User');
    if (suspended) await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    await audit(client, actor.id, suspended ? 'USER_SUSPENDED' : 'USER_REINSTATED', userId, { reason }, ip);
    await enqueueEmail(client, { userId, template: 'account-status', data: { status: suspended ? 'suspended' : 'reinstated', reason } });
    return u;
  });
}

// ─────────────── maker-checker approvals ───────────────

export async function createApproval(actor, input, ip) {
  const { kind, reason } = input;
  return tx(async (client) => {
    let accountId = input.accountId;
    let amount = null, targetJournal = null, targetPayment = null;
    if (kind === 'TREASURY_FUND') {
      amount = input.amountPaise;
      if (amount > config.wallet.maxTreasuryFundPaise) throw new AppError(400, 'AMOUNT_TOO_LARGE', `A single funding request is limited to ${formatInr(config.wallet.maxTreasuryFundPaise)}`);
      accountId = await systemAccountId(client, 'TREASURY');
    } else {
      const { rows: [acct] } = await client.query(`SELECT id FROM accounts WHERE id=$1 AND kind='WALLET' AND currency='PTS'`, [accountId]);
      if (!acct) throw notFound('Account');
    }

    if (kind === 'GRANT') {
      amount = input.amount;
      if (amount > config.rewards.maxGrantPoints) throw new AppError(400, 'GRANT_TOO_LARGE', `A single grant is limited to ${config.rewards.maxGrantPoints} points`);
    } else if (kind === 'REVERSAL') {
      const { rows: [j] } = await client.query(
        `SELECT j.id, j.kind, j.account_id, e.amount FROM journals j JOIN ledger_entries e ON e.journal_id=j.id AND e.seq IS NOT NULL WHERE j.id=$1`, [input.targetJournalId]);
      if (!j || j.account_id !== accountId) throw notFound('Journal for this account');
      if (j.kind !== 'GRANT') throw new AppError(400, 'NOT_REVERSIBLE', 'Only manual grants can be reversed here. Payment rewards are reversed by refunding the payment.');
      targetJournal = j.id; amount = j.amount;
    } else if (kind === 'REFUND_PAYMENT') {
      const { rows: [p] } = await client.query('SELECT id, account_id, status, points_awarded FROM payments WHERE id=$1', [input.targetPaymentId]);
      if (!p || p.account_id !== accountId) throw notFound('Payment for this account');
      if (p.status !== 'COMPLETED') throw conflict('ALREADY_REFUNDED', 'Payment is already refunded');
      targetPayment = p.id; amount = p.points_awarded || null;
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO approvals (kind, account_id, amount, target_journal_id, target_payment_id, reason, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [kind, accountId, amount, targetJournal, targetPayment, reason, actor.id]);
    await audit(client, actor.id, `APPROVAL_REQUESTED_${kind}`, row.id, { accountId, amount, reason }, ip);
    return row;
  });
}

export async function listApprovals({ status = null, limit = 50 }) {
  const { rows } = await pool.query(
    `SELECT ap.*, u.email AS user_email, u.name AS user_name, rq.email AS requested_by_email, dc.email AS decided_by_email
       FROM approvals ap JOIN accounts a ON a.id=ap.account_id LEFT JOIN users u ON u.id=a.user_id
       JOIN users rq ON rq.id=ap.requested_by LEFT JOIN users dc ON dc.id=ap.decided_by
      WHERE ($1::text IS NULL OR ap.status=$1) ORDER BY ap.created_at DESC LIMIT $2`, [status, limit]);
  return rows;
}

export async function decideApproval(actor, id, { approve, note }, ip) {
  return tx(async (client) => {
    const { rows: [ap] } = await client.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE', [id]);
    if (!ap) throw notFound('Approval');
    if (ap.status !== 'PENDING') throw conflict('ALREADY_DECIDED', `This request is already ${ap.status.toLowerCase()}`);
    if (ap.requested_by === actor.id) throw forbidden('SELF_APPROVAL', 'You cannot decide your own request — a different admin must');

    if (!approve) {
      await client.query(`UPDATE approvals SET status='REJECTED', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [id, actor.id, note ?? null]);
      await audit(client, actor.id, `APPROVAL_REJECTED_${ap.kind}`, id, { note }, ip);
      return { ...ap, status: 'REJECTED' };
    }

    let journalId = null;
    if (ap.kind === 'GRANT') {
      const { journal } = await postJournal(client, {
        kind: 'GRANT', walletId: ap.account_id, direction: 'CREDIT', amount: ap.amount, systemCode: 'ISSUANCE',
        idempotencyKey: `approval:${ap.id}`, requestHash: hashRequest('approval', ap.id),
        description: ap.reason, createdBy: actor.id, referenceType: 'approval', referenceId: ap.id,
        metadata: { requestedBy: ap.requested_by, approvedBy: actor.id },
      });
      journalId = journal.id;
    } else if (ap.kind === 'REVERSAL') {
      const { journal } = await reverseJournal(client, {
        journalId: ap.target_journal_id, allowedKinds: ['GRANT'], createdBy: actor.id, reason: `Reversal: ${ap.reason}`, idempotencyKey: `approval:${ap.id}`,
      });
      journalId = journal.id;
    } else if (ap.kind === 'TREASURY_FUND') {
      // Moves real money INTO the reward pool (in production: after the company's bank transfer is confirmed).
      const funds = await systemAccountId(client, 'FUNDS_IN');
      const r = await postMoney(client, {
        kind: 'TREASURY_FUND', idempotencyKey: `approval:${ap.id}`, requestHash: hashRequest('approval', ap.id),
        description: ap.reason, createdBy: actor.id, referenceType: 'approval', referenceId: ap.id,
        legs: [{ accountId: ap.account_id, direction: 'CREDIT', amount: ap.amount }, { accountId: funds, direction: 'DEBIT', amount: ap.amount }],
      });
      journalId = r.journal.id;
    } else if (ap.kind === 'REFUND_PAYMENT') {
      const r = await refundPayment({ paymentId: ap.target_payment_id, actorId: actor.id, reason: `Refund approved: ${ap.reason}`, client });
      journalId = r.journal?.id ?? null;
    }
    await client.query(
      `UPDATE approvals SET status='EXECUTED', decided_by=$2, decided_at=now(), decision_note=$3, result_journal_id=$4 WHERE id=$1`,
      [id, actor.id, note ?? null, journalId]);
    await audit(client, actor.id, `APPROVAL_EXECUTED_${ap.kind}`, id, { journalId, amount: ap.amount, requestedBy: ap.requested_by }, ip);
    return { ...ap, status: 'EXECUTED', result_journal_id: journalId };
  });
}

export async function listAuditLog({ limit = 50, offset = 0 }) {
  const { rows } = await pool.query(
    `SELECT l.id, l.action, l.target, l.details, l.ip, l.created_at, u.email AS actor_email
       FROM admin_audit_log l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  return rows;
}

// ─────────────── catalog ───────────────

export async function listCatalogAdmin() {
  const { rows } = await pool.query('SELECT * FROM catalog_items ORDER BY created_at DESC');
  return rows;
}

export async function createCatalogItem(actor, v, ip) {
  return tx(async (client) => {
    try {
      const { rows: [item] } = await client.query(
        `INSERT INTO catalog_items (sku, name, description, emoji, points_cost, stock, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [v.sku, v.name, v.description ?? '', v.emoji ?? '🎁', v.pointsCost, v.stock ?? null, v.active ?? true]);
      await audit(client, actor.id, 'CATALOG_CREATED', item.id, { sku: v.sku, pointsCost: v.pointsCost }, ip);
      return item;
    } catch (err) {
      if (err.code === '23505') throw conflict('SKU_TAKEN', 'A reward with this SKU already exists');
      throw err;
    }
  });
}

export async function updateCatalogItem(actor, id, v, ip) {
  const cols = { name: 'name', description: 'description', emoji: 'emoji', pointsCost: 'points_cost', stock: 'stock', active: 'active' };
  const sets = [], params = [id];
  for (const [k, col] of Object.entries(cols)) if (k in v) { params.push(v[k]); sets.push(`${col}=$${params.length}`); }
  if (!sets.length) throw new AppError(400, 'NOTHING_TO_UPDATE', 'No fields to update');
  return tx(async (client) => {
    const { rows: [item] } = await client.query(`UPDATE catalog_items SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params);
    if (!item) throw notFound('Reward');
    await audit(client, actor.id, 'CATALOG_UPDATED', id, v, ip);
    return item;
  });
}
export { formatInr, treasuryReport };
