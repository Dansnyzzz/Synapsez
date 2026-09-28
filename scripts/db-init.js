import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Reuse the local .env loader so `npm run db:init` works without extra setup.
const envFile = path.resolve(here, '../.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.error('\n  DATABASE_URL is not set — there is no hosted database to initialise.\n');
  console.error('  Running locally you do not need this script: Synapsez starts Postgres');
  console.error('  in-process (PGlite, stored under ./data) and builds the schema on boot.\n');
  process.exit(1);
}

// `initStore()` is what actually builds the store; `getStore()` only hands back
// the one it built and throws if nothing has. Calling the latter first made this
// script fail on its own first line for anyone with a real DATABASE_URL.
const { initStore } = await import('../server/store/index.js');
const store = await initStore();

// A round-trip proves both the schema and the credentials are good.
await store.setSetting('__init_check', { at: new Date().toISOString() });
const check = await store.getSetting('__init_check');

console.log(`\n  Schema is ready on ${store.kind}. Write/read check: ${check ? 'ok' : 'FAILED'}\n`);
process.exit(check ? 0 : 1);
