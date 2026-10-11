import { Router } from 'express';
import { ah } from '../lib/async.js';
import { z, idempotencyKey } from '../middleware/validate.js';
import { vpaOf } from '../services/vpa.js';
import { pool } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { authenticate } from '../middleware/auth.js';
import { limiter, byUser } from '../middleware/rateLimit.js';
import * as money from '../services/money.js';

// A payee is a payment address (riya.demo@pointwise) or, for convenience, a verified account email.
const payee = z.string().trim().toLowerCase().min(3).max(254);
const pickPayee = (b) => b.to ?? b.toEmail ?? (() => { throw badRequest('PAYEE_REQUIRED', 'Enter a payment address or email'); })();

const r = Router();
r.use(authenticate);

r.get('/wallet', ah(async (req, res) => res.json(await money.walletSummary(req.user.id))));
r.get('/vpa', ah(async (req, res) => res.json(await vpaOf(pool, req.user.id))));

r.get('/quote', ah(async (req, res) => {
  const points = z.coerce.number().int().positive().parse(req.query.points);
  res.json(money.quote(points));
}));

// Shows a masked name so the sender can confirm who they're paying — rate-limited against email enumeration.
r.get('/recipient', limiter({ windowMs: 60_000, limit: 15, key: byUser }), ah(async (req, res) => {
  res.json(await money.lookupRecipient(req.user, payee.parse(req.query.to ?? req.query.email)));
}));

r.post('/topup', limiter({ windowMs: 60_000, limit: 20, key: byUser }), ah(async (req, res) => {
  const b = z.object({ amountPaise: z.number().int().positive() }).strict().parse(req.body);
  const out = await money.topUp({ userId: req.user.id, amountPaise: b.amountPaise, idempotencyKey: idempotencyKey(req) });
  res.status(out.replayed ? 200 : 201).json(out);
}));

const challengeBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('convert'), points: z.number().int().positive() }),
  z.object({ action: z.literal('transfer'), to: payee.optional(), toEmail: payee.optional(), amountPaise: z.number().int().positive() }),
]);
r.post('/challenge', limiter({ windowMs: 10 * 60_000, limit: 10, key: byUser }), ah(async (req, res) => {
  const b = challengeBody.parse(req.body);
  res.json(await money.startMoneyChallenge(req.user, b.action === 'transfer' ? { ...b, to: pickPayee(b) } : b));
}));

r.post('/transfer', limiter({ windowMs: 60_000, limit: 10, key: byUser }), ah(async (req, res) => {
  const b = z.object({
    to: payee.optional(), toEmail: payee.optional(), amountPaise: z.number().int().positive(),
    note: z.string().trim().max(80).optional(), otp: z.string().regex(/^\d{6}$/).optional(),
  }).strict().parse(req.body);
  const { toEmail, to, ...rest } = b;
  const out = await money.transfer({ user: req.user, ...rest, to: pickPayee(b), idempotencyKey: idempotencyKey(req) });
  res.status(out.replayed ? 200 : 201).json(out);
}));

r.post('/convert', limiter({ windowMs: 60_000, limit: 10, key: byUser }), ah(async (req, res) => {
  const b = z.object({ points: z.number().int().positive(), otp: z.string().regex(/^\d{6}$/).optional() }).strict().parse(req.body);
  const out = await money.convertPoints({ user: req.user, ...b, idempotencyKey: idempotencyKey(req) });
  res.status(out.replayed ? 200 : 201).json(out);
}));

export default r;
