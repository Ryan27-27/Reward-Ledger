import { Router } from 'express';
import { ah } from '../lib/async.js';
import { z, uuid } from '../middleware/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { limiter, byUser } from '../middleware/rateLimit.js';
import * as admin from '../services/admin.js';
import { verifyAll, verifyWallet } from '../services/ledger.js';
import { treasuryReport } from '../services/money.js';

const r = Router();
r.use(authenticate);
const read = requireRole('ADMIN', 'AUDITOR'); // AUDITOR is strictly read-only
const write = requireRole('ADMIN');
r.use(limiter({ windowMs: 60_000, limit: 120, key: byUser }));

r.get('/stats', read, ah(async (_req, res) => res.json(await admin.stats())));

r.get('/users', read, ah(async (req, res) => {
  const q = z.object({ q: z.string().max(100).default(''), limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  res.json({ users: await admin.listUsers(q) });
}));
r.get('/users/:id', read, ah(async (req, res) => res.json(await admin.userDetail(uuid.parse(req.params.id)))));
r.get('/wallets/:id/verify', read, ah(async (req, res) => res.json(await verifyWallet(uuid.parse(req.params.id)))));

const reason = z.object({ reason: z.string().trim().min(10, 'Give a reason (10+ characters)').max(300) });
r.post('/accounts/:id/freeze', write, ah(async (req, res) => {
  const { reason: why } = reason.parse(req.body);
  res.json(await admin.setAccountFrozen(req.user, uuid.parse(req.params.id), true, why, req.ip));
}));
r.post('/accounts/:id/unfreeze', write, ah(async (req, res) => {
  const { reason: why } = reason.parse(req.body);
  res.json(await admin.setAccountFrozen(req.user, uuid.parse(req.params.id), false, why, req.ip));
}));
r.post('/users/:id/suspend', write, ah(async (req, res) => {
  const { reason: why } = reason.parse(req.body);
  res.json(await admin.setUserSuspended(req.user, uuid.parse(req.params.id), true, why, req.ip));
}));
r.post('/users/:id/reinstate', write, ah(async (req, res) => {
  const { reason: why } = reason.parse(req.body);
  res.json(await admin.setUserSuspended(req.user, uuid.parse(req.params.id), false, why, req.ip));
}));

// ── maker-checker ──
const approvalBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('GRANT'), accountId: uuid, amount: z.number().int().positive(), reason: reason.shape.reason }),
  z.object({ kind: z.literal('REVERSAL'), accountId: uuid, targetJournalId: uuid, reason: reason.shape.reason }),
  z.object({ kind: z.literal('TREASURY_FUND'), amountPaise: z.number().int().positive(), reason: reason.shape.reason }),
  z.object({ kind: z.literal('REFUND_PAYMENT'), accountId: uuid, targetPaymentId: uuid, reason: reason.shape.reason }),
]);
r.post('/approvals', write, ah(async (req, res) => res.status(201).json(await admin.createApproval(req.user, approvalBody.parse(req.body), req.ip))));
r.get('/approvals', read, ah(async (req, res) => {
  const status = z.enum(['PENDING', 'EXECUTED', 'REJECTED']).optional().parse(req.query.status);
  res.json({ approvals: await admin.listApprovals({ status: status ?? null }) });
}));
r.post('/approvals/:id/approve', write, ah(async (req, res) =>
  res.json(await admin.decideApproval(req.user, uuid.parse(req.params.id), { approve: true, note: z.string().max(300).optional().parse(req.body?.note) }, req.ip))));
r.post('/approvals/:id/reject', write, ah(async (req, res) =>
  res.json(await admin.decideApproval(req.user, uuid.parse(req.params.id), { approve: false, note: z.string().max(300).optional().parse(req.body?.note) }, req.ip))));

r.get('/treasury', read, ah(async (_req, res) => res.json(await treasuryReport())));

r.get('/audit-log', read, ah(async (req, res) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  res.json({ entries: await admin.listAuditLog(q) });
}));
r.get('/ledger/verify', read, limiter({ windowMs: 60_000, limit: 5, key: byUser }), ah(async (_req, res) => res.json(await verifyAll())));

// ── catalog ──
const item = z.object({
  sku: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/), name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(), emoji: z.string().max(8).optional(),
  pointsCost: z.number().int().positive().max(10_000_000), stock: z.number().int().min(0).nullable().optional(), active: z.boolean().optional(),
});
r.get('/catalog', read, ah(async (_req, res) => res.json({ items: await admin.listCatalogAdmin() })));
r.post('/catalog', write, ah(async (req, res) => res.status(201).json(await admin.createCatalogItem(req.user, item.parse(req.body), req.ip))));
r.patch('/catalog/:id', write, ah(async (req, res) =>
  res.json(await admin.updateCatalogItem(req.user, uuid.parse(req.params.id), item.omit({ sku: true }).partial().strict().parse(req.body), req.ip))));

export default r;
