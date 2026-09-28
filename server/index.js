import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { initStore } from './store/index.js';
import { ensureLocalSecrets, assertSecrets } from './secrets.js';
import { startScheduler } from './scheduler.js';
import { lanAddresses } from './util/net.js';
import { closeAllMcp } from './mcp/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader so local runs need no extra dependency. */
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

// Generating these per run would sign everyone out and orphan every stored API
// key on each restart, so they are written to .env the first time.
const { secrets, access } = ensureLocalSecrets(path.resolve(here, '..'));
if (secrets.length) {
  console.log(`\n  Generated ${secrets.join(' and ')} and saved them to .env.`);
}
if (access.length) {
  // This grants the assistant the run of the machine, so say so out loud the
  // one time it is switched on rather than letting it be a silent default.
  console.log(
    `\n  Set ${access.join(' and ')} in .env — the assistant can now reach the whole machine.` +
      '\n  Destructive actions still stop and ask; change the policy in Settings → Behaviour.',
  );
}
assertSecrets();

const port = Number(process.env.PORT) || 5173;

const store = await initStore();

// Scheduled work needs something ticking. A local run has a process that stays
// up, so it polls for itself; a deployment has none, and uses the cron endpoint.
startScheduler();

/**
 * Reap the MCP child processes on the way out.
 *
 * `closeAllMcp` was written and never called — verified by grep across the
 * whole repo. Every stdio MCP server is a child process held in a module-level
 * map keyed by user, and nothing but a settings edit ever removed one. On a
 * local server with `ALLOW_MCP_STDIO=1`, every account that had ever taken a
 * turn left children running until the machine was rebooted, and Ctrl-C
 * orphaned all of them.
 *
 * Registered once, and it lets the default signal behaviour proceed afterwards:
 * this is cleanup, not a reason to refuse to exit.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      closeAllMcp();
    } catch {
      // Going down anyway; a failure to tidy must not stop the exit.
    }
    process.exit(0);
  });
}

createApp().listen(port, '0.0.0.0', () => {
  console.log('\n  Synapsez is running.\n');
  for (const url of [`http://localhost:${port}`, ...lanAddresses(port)]) console.log(`    ${url}`);

  console.log(`\n  Storage: ${store.kind}`);
  console.log('\n  Open the app and create an account — the first one becomes the administrator.');
  console.log('  Everyone signs in with their own email and password.');
  console.log('\n  Open a LAN address on your phone (same Wi-Fi), or run `npm run share`');
  console.log('  for a public HTTPS URL you can reach from anywhere.\n');

  warnAboutUncappedSpend();
});

/**
 * Three permissive defaults that are each reasonable and together are not.
 *
 * Signing up is open unless ALLOW_SIGNUP says otherwise. A provider key in the
 * environment is a shared fallback that any account without its own key spends
 * against. And DEFAULT_MONTHLY_TOKEN_LIMIT is blank in .env.example, so
 * `defaultTokenLimit()` returns null and `checkQuota` lets every turn through.
 *
 * Each of those is documented where it is set. Nothing puts the three together
 * and says what they mean when all of them are true, which is: anyone who finds
 * this address can create an account and spend your money until you notice.
 *
 * No default limit is imposed here. Inventing one would start refusing turns on
 * deployments that work today, and the right number depends on whose key it is.
 * Saying it out loud at boot, once, is the honest version — it is the moment
 * somebody is actually looking at the terminal.
 */
function warnAboutUncappedSpend() {
  const SHARED_KEYS = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY', 'ORCAROUTER_API_KEY',
  ];
  const shared = SHARED_KEYS.filter((name) => process.env[name]);
  const capped = Number(process.env.DEFAULT_MONTHLY_TOKEN_LIMIT) > 0;
  const signupOpen = !/^(0|false|no)$/i.test(process.env.ALLOW_SIGNUP ?? 'true');

  if (!shared.length || capped || !signupOpen) return;

  console.log('  ┌─ Anyone who reaches this address can spend your API credit.');
  console.log(`  │  Shared key in the environment: ${shared.join(', ')}.`);
  console.log('  │  Signing up is open, and no monthly token limit is set, so a new');
  console.log('  │  account spends against that key with no ceiling.');
  console.log('  │');
  console.log('  │  Set ALLOW_SIGNUP=false once your own accounts exist, or');
  console.log('  │  DEFAULT_MONTHLY_TOKEN_LIMIT to a number of tokens per account.');
  console.log('  └─ Neither applies to anyone using their own key.\n');
}
