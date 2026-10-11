import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// bigint columns arrive as strings by default; points and paise are always < 2^53, so use numbers.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30_000 });
pool.on('error', (err) => logger.error({ err }, 'idle pg client error'));

export const query = (text, params) => pool.query(text, params);

/** Run fn inside one DB transaction. Rolls back on any throw. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
    throw err;
  } finally {
    client.release();
  }
}
