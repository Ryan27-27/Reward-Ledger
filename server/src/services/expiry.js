import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { postJournal, hashRequest } from './ledger.js';

/**
 * Expire lapsed point lots. Safe to run on several instances at once: each lot is handled under the
 * wallet lock, re-checked, and posted with a deterministic idempotency key (`expire:<lotId>`).
 */
export async function runExpiry({ now = new Date(), batch = 200 } = {}) {
  let expired = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, account_id FROM point_lots WHERE remaining > 0 AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [now, batch]);
    if (!rows.length) break;
    let progressed = 0;
    for (const row of rows) {
      const done = await tx(async (client) => {
        await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [row.account_id]);
        const { rows: [lot] } = await client.query('SELECT * FROM point_lots WHERE id=$1 FOR UPDATE', [row.id]);
        if (!lot || lot.remaining === 0) return false;
        await postJournal(client, {
          kind: 'EXPIRE', walletId: lot.account_id, direction: 'DEBIT', amount: lot.remaining, systemCode: 'EXPIRY',
          idempotencyKey: `expire:${lot.id}`, requestHash: hashRequest('expire', lot.id), lotId: lot.id,
          description: `Points earned on ${new Date(lot.earned_at).toLocaleDateString('en-IN')} expired`, referenceType: 'point_lot', referenceId: lot.id,
        });
        return true;
      }).catch((err) => { logger.error({ err, lot: row.id }, 'expiry failed for lot'); return false; });
      if (done) { expired++; progressed++; }
    }
    if (!progressed) break; // avoid spinning on a lot that keeps failing
  }
  return expired;
}

let timer;
export function startExpiryWorker() {
  const loop = async () => {
    try { const n = await runExpiry(); if (n) logger.info({ lots: n }, 'expired point lots'); }
    catch (err) { logger.error({ err }, 'expiry run failed'); }
    finally { timer = setTimeout(loop, config.expiryPollMs); }
  };
  timer = setTimeout(loop, 5000);
}
export const stopExpiryWorker = () => clearTimeout(timer);
