import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

// userId -> Set<res>. Postgres LISTEN/NOTIFY fans events out to every API instance, and pg_notify
// inside the ledger transaction means an event is only ever delivered for committed data.
const clients = new Map();
let listener, stopped = false;

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  return () => { clients.get(userId)?.delete(res); if (!clients.get(userId)?.size) clients.delete(userId); };
}

export async function startRealtime() {
  stopped = false;
  const connect = async () => {
    if (stopped) return;
    listener = new pg.Client({ connectionString: config.databaseUrl });
    listener.on('error', (err) => { logger.warn({ err }, 'realtime listener error'); setTimeout(connect, 2000); });
    listener.on('end', () => { if (!stopped) setTimeout(connect, 2000); });
    listener.on('notification', (msg) => {
      try {
        const { userId, notification } = JSON.parse(msg.payload);
        for (const res of clients.get(userId) ?? []) res.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
      } catch (err) { logger.warn({ err }, 'bad realtime payload'); }
    });
    try { await listener.connect(); await listener.query('LISTEN pw_notifications'); }
    catch (err) { logger.warn({ err }, 'realtime connect failed, retrying'); setTimeout(connect, 2000); }
  };
  await connect();
}

export async function stopRealtime() {
  stopped = true;
  for (const set of clients.values()) for (const res of set) res.end();
  clients.clear();
  await listener?.end().catch(() => {});
}
