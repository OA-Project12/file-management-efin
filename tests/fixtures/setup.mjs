import { readFile } from 'node:fs/promises';
import pg from 'pg';
// No defaults and no .env.local: refuse anything except a disposable local database.
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost', 'postgres'].includes(url.hostname) || url.pathname !== '/efin_security') {
  throw new Error('Use a disposable local database named efin_security');
}
const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
try { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }
finally { await pool.end(); }
console.log('Synthetic security fixtures initialized.');
