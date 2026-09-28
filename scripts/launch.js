import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLocalSecrets } from '../server/secrets.js';
import { parseLaunchArgs, planWorkerEnv, isLocalServer } from './lib/workerLink.js';

/**
 * One command, everything at once.
 *
 * `npm start` brings up every piece you have configured, in a single terminal:
 *
 *   • the web app          — always, unless --no-server
 *   • the machine worker   — when WORKER_TOKEN is set, so a hosted deployment
 *                            can reach this computer at the same time
 *   • a Cloudflare tunnel  — with --tunnel, for a public URL
 *
 * They are independent, so running all three together is the normal case rather
 * than a special one: the local app serves you here, the worker serves the
 * deployment your phone talks to, and the tunnel exposes the local app.
 *
 * `npm run connect -- https://your-app.vercel.app` is the other shape: no local
 * app at all, just this computer offering itself to a deployment. See
 * `lib/workerLink.js` for why the address is remembered and why changing it
 * throws the old token away.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function loadEnvFile(file) {
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

// worker/.env is loaded second so a value set there wins for the worker's own
// settings without leaking into the server's.
loadEnvFile(path.join(root, '.env'));
const workerEnv = {};
const workerEnvFile = path.join(root, 'worker', '.env');
if (fs.existsSync(workerEnvFile)) {
  for (const raw of fs.readFileSync(workerEnvFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) workerEnv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

let args;
try {
  args = parseLaunchArgs(process.argv.slice(2));
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  console.error('  Examples:');
  console.error('    npm start                                      the app on this machine');
  console.error('    npm run connect -- https://your-app.vercel.app  this machine, driven by a deployment\n');
  process.exit(1);
}

const wantTunnel = args.tunnel || /^(1|true)$/i.test(process.env.TUNNEL || '');
const wantServer = args.wantServer;
const port = process.env.PORT || 5173;

/**
 * Remember where this computer was told to report.
 *
 * Written before anything starts, so the worker's own env-file read picks it up
 * and so the next run needs no argument at all. `planWorkerEnv` also decides
 * whether the stored token survives — a token is only valid on the server that
 * minted it, and carrying one across a change of address produces a 401 and a
 * misleading "no longer paired" message.
 */
let announceLink = null;
if (args.server) {
  const before = fs.existsSync(workerEnvFile) ? fs.readFileSync(workerEnvFile, 'utf8') : '';
  const plan = planWorkerEnv(before, args.server);

  if (plan.changed) {
    fs.mkdirSync(path.dirname(workerEnvFile), { recursive: true });
    fs.writeFileSync(workerEnvFile, plan.text, { mode: 0o600 });
  }
  workerEnv.SERVER_URL = args.server;
  if (plan.droppedToken) {
    delete workerEnv.WORKER_TOKEN;
    delete process.env.WORKER_TOKEN;
  }
  announceLink = plan;
}

const workerToken = workerEnv.WORKER_TOKEN || process.env.WORKER_TOKEN;
const workerServer =
  args.server || workerEnv.SERVER_URL || process.env.SERVER_URL || `http://localhost:${port}`;
const remoteWorker = !isLocalServer(workerServer);

/**
 * The worker comes up unless you say otherwise.
 *
 * It used to require a token, or a flag, or a remote SERVER_URL — which meant
 * that on a plain `npm start` there was no worker, so no pairing code, so no way
 * to add this computer from a phone without first knowing to pass `--pair`.
 * Knowing to pass a flag is precisely the thing somebody setting this up for the
 * first time does not know.
 *
 * So it always runs. With a token it connects; without one it offers a code and
 * waits. Both are useful, neither needs explaining, and `--no-worker` is there
 * for anyone who genuinely wants the app on its own.
 */
const wantWorker = args.wantWorker;

// ── preflight ─────────────────────────────────────────────────────────
//
// Fail on the things that produce a confusing error three seconds later.

const MIN_NODE = 20;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < MIN_NODE) {
  console.error(`\n  Synapsez needs Node ${MIN_NODE} or newer. This is Node ${process.versions.node}.`);
  console.error('  Install a current version from nodejs.org and try again.\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(root, 'node_modules', 'express'))) {
  console.error('\n  Dependencies are not installed yet.\n');
  console.error('    npm install\n');
  console.error('  Then run this again.\n');
  process.exit(1);
}

const ANSI = { green: '32', cyan: '36', yellow: '33', dim: '90' };
const colour = (code, text) => `[${code}m${text}[0m`;

const children = [];
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Prefix each child's output so several processes in one terminal stay legible. */
function pipe(child, label, code) {
  const tag = colour(code, label.padEnd(6));
  const forward = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(line.trim() ? `${tag} ${line}\n` : '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}

function run(file, label, code, env = {}) {
  const child = spawn(process.execPath, [file], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(child, label, code);
  child.on('exit', (exitCode) => {
    if (exitCode && !shuttingDown) {
      console.error(`\n  ${label} exited with code ${exitCode}. Stopping everything.\n`);
      shutdown();
    }
  });
  children.push(child);
  return child;
}

// ── what is about to run ──────────────────────────────────────────────

console.log(`\n  ${colour(ANSI.green, 'Synapsez')}\n`);
if (wantServer) console.log(`    web app   http://localhost:${port}`);
if (wantWorker) {
  const where = remoteWorker ? workerServer : 'this machine (local app)';
  console.log(`    computer  ${where}${workerToken ? '' : colour(ANSI.yellow, '  — pairing')}`);
} else if (wantServer) {
  console.log(`    ${colour(ANSI.dim, 'computer  the app runs your tools directly')}`);
}
if (wantTunnel) console.log('    tunnel    starting…');
console.log('');

/**
 * Say what changed, and why, before the pairing box appears.
 *
 * Without this the user sees a request for a fresh code with no explanation and
 * reasonably concludes something is broken. The token was thrown away on
 * purpose, and one sentence is the difference between a deliberate step and an
 * apparent fault.
 */
if (announceLink?.droppedToken) {
  console.log(`  This computer was paired to ${announceLink.previous}.`);
  console.log('  A token only works on the server that issued it, so it has been cleared.');
  console.log('  Pair again below — it takes one code.\n');
} else if (announceLink?.changed) {
  console.log(`  Saved ${workerServer} to worker/.env. Future runs need no address.\n`);
}

if (!wantServer && !wantWorker) {
  console.error('  Nothing to run: --no-server, and no computer to connect.\n');
  console.error('  Add --pair to pair this machine with a deployment, or set SERVER_URL');
  console.error('  in worker/.env to point it at one.\n');
  process.exit(1);
}

/**
 * Pairing against a deployment that has not been named is the failure this whole
 * change exists to remove, so it is caught here rather than ten seconds later as
 * an invalid code. Only when there is no app on this machine to pair *with*:
 * a plain `npm start` pairs the local worker to the local app, which is correct.
 */
if (!wantServer && !remoteWorker && !workerToken) {
  console.error('  This computer has nowhere to report to.\n');
  console.error('  Name the deployment you want it to answer to:\n');
  console.error('    npm run connect -- https://your-app.vercel.app\n');
  console.error('  The address is on the Computers tab of that deployment, under Settings.\n');
  process.exit(1);
}

// ── the web app ───────────────────────────────────────────────────────
if (wantServer) {
  const { secrets, access } = ensureLocalSecrets(root);
  if (secrets.length) {
    console.log(`  Generated ${secrets.join(' and ')} and saved them to .env.`);
  }
  if (access.length) {
    console.log(`  Set ${access.join(' and ')} in .env — the assistant can reach this whole machine.`);
    console.log('  Destructive actions still stop and ask; change that in Settings → Behaviour.');
  }
  if (secrets.length || access.length) console.log('');
  run(path.join(root, 'server', 'index.js'), 'server', ANSI.green);
}

// ── the machine worker ────────────────────────────────────────────────
// Runs alongside the app rather than instead of it. Pointed at a deployment it
// lets your phone drive this computer through the hosted URL; pointed at
// localhost it simply keeps the queue path warm.
if (wantWorker) {
  const env = { ...workerEnv, SERVER_URL: workerServer };
  // Only set it when there is one. An empty string would look like a token to
  // the worker and stop it pairing — which is the whole point of running it
  // without one.
  if (workerToken) env.WORKER_TOKEN = workerToken;

  // Give the server a moment to bind so the worker's first poll succeeds.
  setTimeout(
    () => run(path.join(root, 'worker', 'index.js'), 'worker', ANSI.cyan, env),
    wantServer && !remoteWorker ? 2500 : 0,
  );
}

// ── the public URL ────────────────────────────────────────────────────
if (wantTunnel) {
  const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  // cloudflared buries the public URL in a lot of log noise; pull it out and
  // show it on its own so it is not missed.
  let announced = false;
  const watch = (chunk) => {
    const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !announced) {
      announced = true;
      console.log(`\n  ${colour(ANSI.yellow, 'Public URL')}  ${match[0]}`);
      console.log('  Open it on your phone from anywhere. Ctrl+C stops everything.\n');
    }
  };
  tunnel.stdout.on('data', watch);
  tunnel.stderr.on('data', watch);

  tunnel.on('error', () => {
    console.error('\n  Could not start cloudflared — is it installed?');
    console.error('    Windows  winget install Cloudflare.cloudflared');
    console.error('    macOS    brew install cloudflared');
    console.error('  Everything else is still running; only the public URL is missing.\n');
  });
  children.push(tunnel);
}
