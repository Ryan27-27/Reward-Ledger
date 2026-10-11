import { Router } from 'express';
import { ah } from '../lib/async.js';
import { config } from '../config.js';
import { hmac, safeEqual } from '../lib/security.js';
import { unauthorized } from '../lib/errors.js';
import { z } from '../middleware/validate.js';
import { handleWebhookEvent } from '../services/payments.js';
import { CATEGORIES } from '../services/rules.js';

const r = Router();

/**
 * Payment-gateway webhook. Header:  X-Pointwise-Signature: t=<unix seconds>,v1=<hex hmac-sha256("<t>.<raw body>")>
 * The timestamp must be within 5 minutes (replay protection). Delivery is idempotent by externalRef.
 */
r.post('/payments', ah(async (req, res) => {
  const header = req.get('X-Pointwise-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) throw unauthorized('Bad signature', 'BAD_SIGNATURE');
  const expected = hmac(config.webhookSecret, `${t}.${req.rawBody?.toString('utf8') ?? ''}`);
  if (!safeEqual(expected, parts.v1)) throw unauthorized('Bad signature', 'BAD_SIGNATURE');

  const evt = z.object({
    type: z.enum(['payment.succeeded', 'payment.refunded', 'wallet.topup.succeeded']),
    data: z.object({
      externalRef: z.string().min(1).max(100),
      userId: z.string().uuid().optional(),
      category: z.enum(Object.keys(CATEGORIES)).optional(),
      amountPaise: z.number().int().positive().optional(),
      description: z.string().max(120).optional(),
    }),
  }).parse(req.body);
  if (evt.type === 'wallet.topup.succeeded' && !(evt.data.userId && evt.data.amountPaise)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'userId and amountPaise are required', requestId: req.id } });
  }
  if (evt.type === 'payment.succeeded' && !(evt.data.userId && evt.data.category && evt.data.amountPaise)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'userId, category and amountPaise are required', requestId: req.id } });
  }
  await handleWebhookEvent(evt);
  res.json({ received: true });
}));

export default r;
