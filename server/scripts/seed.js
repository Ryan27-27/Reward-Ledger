// Demo data for local development. Refuses to run in production.
import { tx, pool } from '../src/db.js';
import { config } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { createUser } from '../src/services/auth.js';
import { createPayment } from '../src/services/payments.js';
import { postMoney } from '../src/services/money.js';
import { systemAccountId } from '../src/services/ledger.js';

if (config.isProd) { console.error('Refusing to seed in production'); process.exit(1); }
const PASSWORD = process.env.SEED_PASSWORD || 'Pointwise#2026';
await migrate();

const upsert = async (u) => {
  const { rows: [ex] } = await pool.query('SELECT id FROM users WHERE lower(email)=lower($1)', [u.email]);
  return ex ?? tx((c) => createUser(c, { ...u, password: PASSWORD, verified: true }));
};
await upsert({ email: 'admin@pointwise.dev', name: 'Asha Admin', role: 'ADMIN' });
await upsert({ email: 'admin2@pointwise.dev', name: 'Dev Approver', role: 'ADMIN' }); // second admin for maker-checker
await upsert({ email: 'auditor@pointwise.dev', name: 'Ira Auditor', role: 'AUDITOR' });
const demo = await upsert({ email: 'demo@pointwise.dev', name: 'Riya Demo' });

const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM payments p JOIN accounts a ON a.id=p.account_id WHERE a.user_id=$1', [demo.id]);
if (n === 0) {
  const pays = [['RENT', 1_800_000], ['SHOPPING', 249_900], ['CREDIT_CARD_BILL', 1_250_000], ['RECHARGE', 59_900], ['SHOPPING', 899_900]];
  for (const [i, [category, amountPaise]] of pays.entries()) {
    await createPayment({ userId: demo.id, category, amountPaise, description: 'Seed payment', idempotencyKey: `seed-${i}-${category}` });
  }
}

// Reward pool (the "root account"): ₹1,00,000 so conversions can be paid out in the demo.
await tx(async (c) => postMoney(c, {
  kind: 'TREASURY_FUND', idempotencyKey: 'seed-treasury', requestHash: 'seed-treasury', description: 'Seed funding',
  legs: [{ accountId: await systemAccountId(c, 'TREASURY'), direction: 'CREDIT', amount: 10_000_000 }, { accountId: await systemAccountId(c, 'FUNDS_IN'), direction: 'DEBIT', amount: 10_000_000 }],
}));

const items = [
  ['COFFEE-100', 'Café voucher ₹100', 'Redeem at partner cafés', '☕', 200, null],
  ['MOVIE-2', 'Movie tickets ×2', 'Any weekday show', '🎬', 800, 100],
  ['AMZ-500', 'Shopping voucher ₹500', 'Valid on partner stores', '🛍️', 1500, 50],
  ['FLIGHT-2K', 'Flight credit ₹2,000', 'Domestic flights', '✈️', 5000, 10],
  ['CHARITY-100', 'Donate ₹100 to charity', 'We match your donation', '💚', 100, null],
];
for (const [sku, name, description, emoji, points_cost, stock] of items) {
  await pool.query(
    `INSERT INTO catalog_items (sku,name,description,emoji,points_cost,stock) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sku) DO NOTHING`,
    [sku, name, description, emoji, points_cost, stock]);
}
console.log(`Seeded. All demo accounts use password: ${PASSWORD}\n  demo@pointwise.dev (user) · admin@pointwise.dev / admin2@pointwise.dev (admins) · auditor@pointwise.dev`);
await pool.end();
