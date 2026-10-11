// Usage:  ADMIN_PASSWORD='...' node scripts/create-admin.js admin@example.com "Jane Admin" [ADMIN|AUDITOR]
// Admin roles are NEVER grantable through the public API; this CLI (or SQL) is the only way.
import crypto from 'node:crypto';
import { tx, pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createUser } from '../src/services/auth.js';

const [email, name = 'Admin', role = 'ADMIN'] = process.argv.slice(2);
if (!email || !['ADMIN', 'AUDITOR'].includes(role)) {
  console.error('usage: node scripts/create-admin.js <email> [name] [ADMIN|AUDITOR]');
  process.exit(1);
}
const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
await migrate();
await tx((c) => createUser(c, { email, name, password, role, verified: true }));
console.log(`Created ${role} ${email}`);
if (!process.env.ADMIN_PASSWORD) console.log(`Generated password (shown once): ${password}`);
await pool.end();
