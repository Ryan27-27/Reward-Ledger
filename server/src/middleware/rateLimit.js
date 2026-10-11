import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { tooMany } from '../lib/errors.js';

// In-memory store = per-instance. For multiple instances plug in rate-limit-redis via `store`.
export const limiter = ({ windowMs, limit, key }) =>
  rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
    keyGenerator: key ? (req) => key(req) : undefined,
    handler: (_req, _res, next) => next(tooMany('RATE_LIMITED', 'Too many requests, slow down')),
  });
export const byUser = (req) => req.user?.id ?? req.ip;
