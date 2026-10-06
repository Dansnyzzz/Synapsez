import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { initStore } from '../server/store/index.js';

/**
 * How much room stored files take, and how much of it nothing can reach.
 *
 *   node scripts/storage.js                  deletes no file (but see below: it migrates)
 *   node scripts/storage.js --apply          delete the unreachable files, after you type "delete"
 *   node scripts/storage.js --apply --yes    the same with no question, for a script that means it
 *   DATABASE_URL=postgres://… node scripts/storage.js    a deployment's database
 *
 * "Unreachable" is two things, both explained in `storageReport` (server/store/pg.js):
 * files still labelled with a conversation that was deleted, and uploads older
 * than a day that were never sent and sit on no project's shelf. The daily sweep
 * removes both from now on; this is for what built up before it did, and for
 * seeing the numbers.
 *
 * Opening the store applies pending schema changes, as `schema-status.js`
 * explains — pointing this at production brings that database up to date too.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The same minimal .env loader `server/index.js` uses. */
function loadEnvFile() {
  const file = path.resolve(here, '../.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const apply = process.argv.includes('--apply');
const store = await initStore();

const size = (bytes) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function print(report, title) {
  const free = report.detached.bytes + report.unsent.bytes;
  console.log(`\n  ${bold(title)}  ${dim(`(${store.kind})`)}\n`);
  console.log(`  Database in total              ${size(report.databaseBytes)}`);
  console.log(`  Stored files                   ${report.files.count} · ${size(report.files.bytes)}`);
  console.log(`  Earlier drafts of files        ${size(report.versionsBytes)}`);
  console.log('');
  console.log(`  Of a deleted conversation      ${report.detached.count} · ${size(report.detached.bytes)}`);
  console.log(`  Never sent, on no shelf        ${report.unsent.count} · ${size(report.unsent.bytes)}`);
  console.log(`  ${bold('Can be freed')}                   ${bold(size(free))}`);
  if (report.lostOriginals) {
    console.log(
      dim(
        `\n  ${report.lostOriginals} project source(s) have lost their original file (the old sweep removed it).\n` +
          '  Their text is still on the shelf and still answers questions; they are left alone.\n' +
          '  Upload the file again if you want to open or download it.',
      ),
    );
  }
  console.log('');
}

/** Where this is pointed — a host and database name, never the credentials in the URL. */
function target() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return 'the local database';
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return 'the database in DATABASE_URL';
  }
}

/**
 * Deleting reaches every account's files at once and cannot be undone, so it
 * is asked for in words first (CODE-044; CLAUDE.md §6). `--yes` is the
 * deliberate way past the question; with no terminal to ask in and no `--yes`,
 * nothing is deleted.
 */
async function confirmed(count) {
  if (process.argv.includes('--yes')) return true;
  if (!process.stdin.isTTY) {
    console.log('  --apply deletes across every account. Run it in a terminal to confirm, or add --yes. Nothing was deleted.\n');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Delete ${count} file(s) from ${target()}, across every account? Type "delete" to go on: `);
  rl.close();
  if (answer.trim() === 'delete') return true;
  console.log('  Nothing was deleted.\n');
  return false;
}

const before = await store.storageReport();
const waiting = before.detached.count + before.unsent.count;
print(before, apply ? 'Before' : 'Storage — preview, nothing deleted');

if (apply && waiting && (await confirmed(waiting))) {
  const gone = await store.pruneUnreachableFiles();
  console.log(`  Deleted ${gone.detached} file(s) of deleted conversations and ${gone.unsent} never-sent upload(s).`);
  print(await store.storageReport(), 'After');
  console.log(dim('  Postgres reuses the freed space for new rows; the database size shrinks only after a VACUUM FULL.\n'));
} else if (!apply && waiting > 0) {
  console.log(dim('  Run again with --apply to delete them.\n'));
}

await store.close?.();
process.exit(0);
