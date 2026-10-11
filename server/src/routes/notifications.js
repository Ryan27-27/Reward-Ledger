import { Router } from 'express';
import { ah } from '../lib/async.js';
import { authenticate } from '../middleware/auth.js';
import { pool } from '../db.js';
import { z } from '../middleware/validate.js';
import { addClient } from '../services/realtime.js';

const r = Router();
r.use(authenticate);

r.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
  res.json({ notifications: rows, unread: n });
}));

r.post('/read-all', ah(async (req, res) => {
  await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
  res.status(204).end();
}));

r.post('/:id/read', ah(async (req, res) => {
  await pool.query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL', [z.string().uuid().parse(req.params.id), req.user.id]);
  res.status(204).end();
}));

// Server-Sent Events: pushes each new notification the moment its ledger transaction commits.
r.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const remove = addClient(req.user.id, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); remove(); });
});

export default r;
