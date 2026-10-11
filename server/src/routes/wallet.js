import { Router } from 'express';
import { ah } from '../lib/async.js';
import { z, idempotencyKey } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { limiter, byUser } from '../middleware/rateLimit.js';
import { pool } from '../db.js';
import { config } from '../config.js';
import { notFound } from '../lib/errors.js';
import { getStatement, verifyWallet } from '../services/ledger.js';
import { tierProgress, publicRules, CATEGORIES } from '../services/rules.js';
import * as payments from '../services/payments.js';
import * as redemptions from '../services/redemptions.js';

const r = Router();

r.get('/rewards/rules', (_req, res) => res.json({ ...publicRules(), firstPaymentBonusMinPaise: config.rewards.firstBonusMinPaise }));

r.use(['/wallet', '/payments', '/catalog', '/redemptions'], authenticate); // scoped, so unknown /api paths 404 instead of 401

const currencyOf = (req) => (req.query.currency === 'INR' ? 'INR' : 'PTS');
async function myWallet(userId, currency = 'PTS') {
  const { rows: [a] } = await pool.query(`SELECT * FROM accounts WHERE kind='WALLET' AND currency=$2 AND user_id=$1`, [userId, currency]);
  if (!a) throw notFound('Wallet');
  return a;
}

r.get('/wallet', ah(async (req, res) => {
  const a = await myWallet(req.user.id);
  const [{ rows: [exp] }, { rows: [ref] }] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(remaining),0)::bigint AS points, MIN(expires_at) AS first
                  FROM point_lots WHERE account_id=$1 AND remaining>0 AND expires_at <= now() + interval '30 days'`, [a.id]),
    pool.query(`SELECT count(*)::int AS n FROM users WHERE referred_by=$1`, [req.user.id]),
  ]);
  res.json({
    balance: a.balance, status: a.status, lifetimeEarned: a.lifetime_earned, lifetimeSpendPaise: a.lifetime_spend_paise,
    tier: tierProgress(a.lifetime_spend_paise),
    expiringSoon: exp.points > 0 ? { points: exp.points, firstExpiry: exp.first } : null,
    referral: { code: req.user.referralCode, referred: ref.n, bonusPoints: config.rewards.referralBonus },
    stepUpThreshold: config.rewards.stepUpThreshold,
  });
}));

r.get('/wallet/statement', ah(async (req, res) => {
  const q = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  const a = await myWallet(req.user.id, currencyOf(req));
  res.json(await getStatement(a.id, { before: q.before ?? null, limit: q.limit }));
}));

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
r.get('/wallet/statement.csv', limiter({ windowMs: 60_000, limit: 6, key: byUser }), ah(async (req, res) => {
  const a = await myWallet(req.user.id, currencyOf(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pointwise-statement.csv"');
  res.write('seq,date,type,kind,description,points,balance_after,reference\n');
  let before = null;
  for (let page = 0; page < 50; page++) {
    const { items, nextBefore } = await getStatement(a.id, { before, limit: 100 });
    for (const e of items) {
      res.write([e.seq, new Date(e.created_at).toISOString(), e.direction, e.kind, e.description,
        e.direction === 'CREDIT' ? e.amount : -e.amount, e.balance_after, e.journal_id].map(csvCell).join(',') + '\n');
    }
    if (!nextBefore) break;
    before = nextBefore;
  }
  res.end();
}));

r.get('/wallet/audit', limiter({ windowMs: 60_000, limit: 20, key: byUser }), ah(async (req, res) => {
  const a = await myWallet(req.user.id, currencyOf(req));
  res.json(await verifyWallet(a.id));
}));

// ───── payments ─────
const paymentBody = z.object({
  category: z.enum(Object.keys(CATEGORIES)),
  amountPaise: z.number().int().positive(),
  description: z.string().trim().max(120).optional(),
  method: z.enum(['EXTERNAL', 'WALLET']).default('EXTERNAL'), // WALLET = pay from your rupee balance
}).strict(); // .strict(): a stray `points` field is rejected — clients can never name their own reward

r.post('/payments/preview', ah(async (req, res) => {
  const b = paymentBody.pick({ category: true, amountPaise: true }).parse(req.body);
  res.json(await payments.previewReward(req.user.id, b));
}));

r.post('/payments', limiter({ windowMs: 60_000, limit: 30, key: byUser }), ah(async (req, res) => {
  const b = paymentBody.parse(req.body);
  const out = await payments.createPayment({ userId: req.user.id, ...b, idempotencyKey: idempotencyKey(req) });
  res.status(out.replayed ? 200 : 201).json(out);
}));

r.get('/payments', ah(async (req, res) => res.json({ payments: await payments.listPayments(req.user.id) })));

// ───── catalog & redemptions ─────
r.get('/catalog', ah(async (_req, res) => res.json({ items: await redemptions.listCatalog() })));

r.post('/redemptions/challenge', limiter({ windowMs: 10 * 60_000, limit: 10, key: byUser }), ah(async (req, res) => {
  const { itemId } = z.object({ itemId: z.string().uuid() }).parse(req.body);
  res.json(await redemptions.startChallenge(req.user, itemId));
}));

r.post('/redemptions', limiter({ windowMs: 60_000, limit: 10, key: byUser }), ah(async (req, res) => {
  const b = z.object({ itemId: z.string().uuid(), otp: z.string().regex(/^\d{6}$/).optional() }).strict().parse(req.body);
  const out = await redemptions.redeem({ user: req.user, ...b, idempotencyKey: idempotencyKey(req) });
  res.status(out.replayed ? 200 : 201).json(out);
}));

r.get('/redemptions', ah(async (req, res) => res.json({ redemptions: await redemptions.listRedemptions(req.user.id) })));

export default r;
