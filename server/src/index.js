import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { startOutboxWorker, stopOutboxWorker } from './services/outbox.js';
import { startExpiryWorker, stopExpiryWorker } from './services/expiry.js';
import { startRealtime, stopRealtime } from './services/realtime.js';

if (config.autoMigrate) await migrate();

const server = createApp().listen(config.port, () => logger.info({ port: config.port, env: config.env }, 'Pointwise API listening'));
await startRealtime();
if (config.workersEnabled) { startOutboxWorker(); startExpiryWorker(); }

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down');
  stopOutboxWorker(); stopExpiryWorker();
  await stopRealtime();
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
