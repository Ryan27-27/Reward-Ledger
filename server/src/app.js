import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { registry, httpDuration } from './metrics.js';
import { originGuard } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import walletRoutes from './routes/wallet.js';
import moneyRoutes from './routes/money.js';
import notificationRoutes from './routes/notifications.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
  }));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cors({ origin: config.corsOrigins, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  app.use(cookieParser());
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(originGuard);

  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => end({ method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode }));
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'database unavailable' }); }
  });
  app.get('/metrics', async (req, res) => {
    if (!config.metricsToken || req.get('authorization') !== `Bearer ${config.metricsToken}`) return res.status(404).end();
    res.set('Content-Type', registry.contentType).send(await registry.metrics());
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/webhooks', webhookRoutes);
  app.use('/api/money', moneyRoutes);
  app.use('/api', walletRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
