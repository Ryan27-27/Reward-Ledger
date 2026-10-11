import { pool } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { counters } from '../metrics.js';
import { sendTemplated } from './mailer.js';

const handlers = {
  EMAIL: (payload) => sendTemplated(payload),
  REFERRAL_REWARD: async (payload) => (await import('./payments.js')).rewardReferral(payload),
};

/** Deliver due outbox rows. SKIP LOCKED lets several API instances run workers safely. */
export async function processOutbox(limit = 20) {
  const client = await pool.connect();
  let processed = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM outbox WHERE status='PENDING' AND next_attempt_at <= now()
        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    for (const row of rows) {
      try {
        await handlers[row.topic](row.payload);
        await client.query(`UPDATE outbox SET status='SENT', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`, [row.id]);
        counters.outbox.inc({ topic: row.topic, result: 'sent' });
      } catch (err) {
        const attempts = row.attempts + 1;
        const dead = attempts >= config.outboxMaxAttempts;
        const delaySec = Math.min(3600, 2 ** attempts * 5); // 10s, 20s, 40s … capped at 1h
        await client.query(
          `UPDATE outbox SET attempts=$2, status=$3, last_error=$4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id=$1`,
          [row.id, attempts, dead ? 'DEAD' : 'PENDING', String(err.message).slice(0, 500), String(delaySec)]);
        counters.outbox.inc({ topic: row.topic, result: dead ? 'dead' : 'retry' });
        logger.warn({ err, outboxId: row.id, attempts }, 'outbox delivery failed');
      }
      processed++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'outbox batch failed');
  } finally {
    client.release();
  }
  return processed;
}

let timer;
export function startOutboxWorker() {
  const loop = async () => {
    try { while ((await processOutbox()) > 0); } finally { timer = setTimeout(loop, config.outboxPollMs); }
  };
  timer = setTimeout(loop, 500);
}
export const stopOutboxWorker = () => clearTimeout(timer);
