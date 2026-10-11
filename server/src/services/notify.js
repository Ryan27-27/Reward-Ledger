import { config } from '../config.js';

/**
 * Called INSIDE a DB transaction. Writes the in-app notification and (optionally) queues an email
 * in the transactional outbox, then pg_notify()s — which Postgres only delivers if the
 * transaction commits. So every committed ledger movement has exactly one notification.
 */
export async function notifyUser(client, userId, { type, title, body, data = {}, email = null }) {
  const { rows: [n] } = await client.query(
    `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, type, title, body, data, created_at`,
    [userId, type, title, body, data],
  );
  if (email) await enqueueEmail(client, { userId, ...email });
  await client.query('SELECT pg_notify($1, $2)', ['pw_notifications', JSON.stringify({ userId, notification: n })]);
  return n;
}

/** email = { template, data, to? } ; `to` defaults to the user's address. */
export async function enqueueEmail(client, { userId, to, template, data }) {
  let address = to;
  let name = data?.name;
  if (!address) {
    const { rows: [u] } = await client.query('SELECT email, name FROM users WHERE id=$1', [userId]);
    address = u.email;
    name = name ?? u.name;
  }
  await client.query(`INSERT INTO outbox (topic, payload) VALUES ('EMAIL', $1)`, [
    { to: address, template, data: { ...data, name, appUrl: config.appUrl } },
  ]);
}

export async function enqueueTopic(client, topic, payload) {
  await client.query('INSERT INTO outbox (topic, payload) VALUES ($1,$2)', [topic, payload]);
}
