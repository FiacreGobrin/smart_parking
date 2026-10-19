// Starts a throwaway local PostgreSQL (embedded-postgres) for development and tests when no Neon
// database is configured. Data lives in backend/.localdb. NOT for production.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.localdb', import.meta.url));
const port = Number(process.env.LOCAL_DB_PORT || 54329);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true });

if (!fs.existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
await pg.start();
for (const name of ['smartparking', 'smartparking_test']) {
  try { await pg.createDatabase(name); } catch { /* already exists */ }
}
console.log(`Local PostgreSQL ready on port ${port}`);
console.log(`DATABASE_URL=postgresql://postgres:postgres@localhost:${port}/smartparking`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
