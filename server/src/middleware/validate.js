import { z } from 'zod';
import { badRequest } from '../lib/errors.js';

export const idempotencyKey = (req) => {
  const k = req.get('Idempotency-Key');
  if (!k || !/^[A-Za-z0-9_.:-]{8,128}$/.test(k)) {
    throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (8-128 chars: letters, digits, _ . : -) is required');
  }
  return k;
};

export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(10, 'At least 10 characters').max(128, 'At most 128 characters');
export const uuid = z.string().uuid();
export { z };
