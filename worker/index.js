import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setWorkspace, moveWorkspace } from './paths.js';
import { LOCAL_IMPLEMENTATIONS, workerInfo } from './tools.js';
import { setFrameSink } from './screen.js';
import { setIndexSink } from './indexer.js';
import { watchForCancel } from './cancel.js';
import { serverTransport } from './serverUrl.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Load worker/.env, then the repo-root .env, without pulling in a dependency. */
function loadEnv() {
  for (const file of [path.join(here, '.env'), path.resolve(here, '../.env')]) {
    if (!fs.existsSync(file)) continue;
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
}

loadEnv();

const SERVER_URL = (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5173}`).replace(/\/$/, '');

// Before the token or any job goes over the wire. See serverUrl.js (SEC-032).
{
  const transport = serverTransport(SERVER_URL, {
    allowInsecure: /^(1|true|yes)$/i.test(process.env.ALLOW_INSECURE_SERVER || ''),
  });
  if (transport.level === 'refuse') {
    console.error(`\n  ${transport.message}\n`);
    process.exit(1);
  }
  if (transport.level === 'warn') console.warn(`\n  ${transport.message}\n`);
}

const WORKSPACE = process.env.WORKSPACE || path.join(os.homedir(), 'AI-Remote-Workspace');
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname() || 'A computer';

/**
 * Where the pending pairing code is left for a co-located app to read.
 *
 * Under `data/`, which is already the folder this project keeps local state in
 * and already git-ignored — a secret that lasts ten minutes should still not be
 * something you can commit by accident.
 */
const PENDING_CODE_FILE = path.resolve(
  process.env.DATA_DIR || path.join(here, '..', 'data'),
  'pending-pairing.json',
);

setWorkspace(WORKSPACE);

/**
 * Get this computer a token, one way or another.
 *
 * Asking somebody to open a web app, find a settings tab, press a button, copy a
 * secret, find a file, paste it in and save was six steps of ceremony before the
 * thing could do anything — and every one of them a place to give up. So the
 * machine asks for a code and prints it, and the person types eight characters
 * into the app they already have open.
 *
 * The direction matters for more than convenience. Nothing here is authenticated,
 * because a computer that has never been paired has nothing to authenticate
 * with; what it gets in return for asking is a code, and a code is worth nothing
 * until somebody who *is* signed in decides this machine is theirs.
 *
 * Once paired, the token is written to worker/.env and this never runs again.
 */
async function pair() {
  const start = await fetch(`${SERVER_URL}/api/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DEVICE_NAME, info: workerInfo() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!start.ok) {
    throw new Error(`the server refused to start pairing (HTTP ${start.status})`);
  }
  const { id, code, expiresInSec } = await start.json();
  publishCode(code, expiresInSec);

  // Measured rather than hard-coded: a box whose right edge does not line up
  // looks like something went wrong, which is the opposite of what this moment
  // should convey.
  const line = `Pairing code:   ${code}`;
  const width = line.length + 12;
  const pad = (text = '') => `  │${text.padStart((width + text.length) / 2).padEnd(width)}│`;

  console.log(`\n  ┌${'─'.repeat(width)}┐`);
  console.log(pad());
  console.log(pad(line));
  console.log(pad());
  console.log(`  └${'─'.repeat(width)}┘\n`);
  console.log(`  Open ${SERVER_URL} on any device — a phone is fine — sign in, and press`);
  console.log('  "Computers" in the header. Enter the code above.\n');
  console.log('  It does not have to be your own account: whoever enters the code gets');
  console.log(`  this computer. Good for ${Math.round(expiresInSec / 60)} minutes. Waiting…\n`);

  const deadline = Date.now() + expiresInSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${SERVER_URL}/api/pair/poll?id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) continue;
    const outcome = await res.json();

    if (outcome.status === 'paired') {
      unpublishCode();
      return outcome;
    }
    if (outcome.status === 'expired' || outcome.status === 'unknown') break;
  }
  unpublishCode();

  throw new Error('nobody claimed this computer in time');
}

/**
 * Remember the token, so pairing is a thing that happens once.
 *
 * Written to `worker/.env` rather than held in memory: the whole promise is that
 * you sign in and your computer is simply there, and a machine that needed
 * re-pairing after every reboot would not be that.
 */
function saveToken(token) {
  const file = path.join(here, '.env');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const kept = existing
    .split('\n')
    .filter((line) => !/^\s*WORKER_TOKEN\s*=/.test(line))
    .join('\n')
    .replace(/\n+$/, '');

  const body = `${kept ? `${kept}\n` : ''}\n# Written by the pairing flow. Delete it to pair this computer again.\nWORKER_TOKEN=${token}\n`;
  fs.writeFileSync(file, body.replace(/^\n/, ''), { mode: 0o600 });
  return file;
}

/**
 * Leave the pending code where a co-located app can read it.
 *
 * Reading eight characters off a terminal and typing them into a browser is
 * fine, and mistyping them is also fine — but when the app happens to be running
 * on this same machine, it can simply show the code with a button that copies
 * it. That is the ordinary case for somebody who just ran `npm start`.
 *
 * A file rather than an API call, deliberately. The server has no idea which
 * unclaimed pairing belongs to the person looking at it — that is the whole
 * point of a code — so the only safe way to answer "what is *this* computer's
 * code" is to be on the same disk as the computer asking.
 */
function publishCode(code, expiresInSec) {
  try {
    fs.mkdirSync(path.dirname(PENDING_CODE_FILE), { recursive: true });
    fs.writeFileSync(
      PENDING_CODE_FILE,
      JSON.stringify({
        code,
        name: DEVICE_NAME,
        server: SERVER_URL,
        expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      }),
      { mode: 0o600 },
    );
  } catch {
    // The terminal already has the code; a missing convenience is not a failure.
  }
}

/** The code has been spent or has expired. Nothing should still be offering it. */
function unpublishCode() {
  try {
    fs.rmSync(PENDING_CODE_FILE, { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/** Forget a token the server no longer recognises, so the next start pairs. */
function clearToken() {
  const file = path.join(here, '.env');
  if (!fs.existsSync(file)) return;
  const kept = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*WORKER_TOKEN\s*=/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(file, kept, { mode: 0o600 });
}

/**
 * One worker per computer, and no more.
 *
 * This became necessary the moment starting at login existed: somebody runs
 * `npm run connect` in a terminal, logs out, logs back in, and now two processes
 * hold the *same* device token and both poll the same queue. Nothing corrupts —
 * they share the same disk and the same workspace, so either can answer any job
 * — but every browser tool fights over one browser, both stream frames to the
 * same panel, and `run_background` leaves servers in two processes nobody can
 * account for.
 *
 * A pid file rather than a port or a mutex: it is inspectable, it survives
 * nothing (which is the point), and a pid from a process that has since died is
 * ignored rather than requiring somebody to clean up after a crash.
 */
const LOCK_FILE = path.resolve(
  process.env.DATA_DIR || path.join(here, '..', 'data'),
  'worker.pid',
);

function alreadyRunning() {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))?.pid);
    if (!pid || pid === process.pid) return null;
    // Signal 0 asks "does this process exist and may I signal it" without
    // touching it. EPERM means it exists and belongs to somebody else, which
    // still counts as running.
    try {
      process.kill(pid, 0);
      return pid;
    } catch (err) {
      return err.code === 'EPERM' ? pid : null;
    }
  } catch {
    return null;
  }
}

const running = alreadyRunning();
if (running && !/^(1|true|yes)$/i.test(process.env.WORKER_ALLOW_MULTIPLE ?? '')) {
  console.error(`\n  A worker for this computer is already running (process ${running}).`);
  console.error('  Two of them would fight over the same browser and the same job queue.\n');
  console.error('  Stop that one first, or set WORKER_ALLOW_MULTIPLE=true if you really mean it.\n');
  process.exit(0);
}

try {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  // Best effort: a lock file left behind by a killed process is already handled
  // by the liveness check above, so failing to remove it is not worth reporting.
  process.on('exit', () => {
    try {
      const held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (held?.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
    } catch {
      /* nothing to clean up */
    }
  });
} catch {
  // An unwritable data directory should not stop the worker doing its job; it
  // only means the next one cannot tell that this one is here.
}

let TOKEN = process.env.WORKER_TOKEN || '';
let WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * Keep asking until somebody adopts this computer.
 *
 * Not `process.exit(1)`, which is what it used to do. A code lasts ten minutes;
 * the person meant to type it may be in another room, or asleep, or have gone to
 * make tea. Quitting because nobody was quick enough turns "leave it running and
 * pair it when you get a moment" into "start it again and be quicker this time",
 * which is a strange thing to ask of a program whose whole job is waiting.
 *
 * Each round asks for a **fresh** code. They are single-use and short-lived, so
 * a code that was shown, expired, and reused would be exactly the loose end this
 * is meant not to leave.
 */
async function pairUntilAdopted() {
  for (;;) {
    try {
      return await pair();
    } catch (err) {
      console.error(`\n  Not paired yet: ${err.message}`);
      console.error(`  Asking for a new code. (server: ${SERVER_URL})\n`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (!TOKEN) {
  const paired = await pairUntilAdopted();
  TOKEN = paired.token;
  // The device id doubles as the worker id, so presence and identity are one row
  // rather than two things that have to be kept in step.
  WORKER_ID = paired.deviceId || WORKER_ID;
  const file = saveToken(TOKEN);
  console.log(`  Paired as "${paired.name || DEVICE_NAME}". Token saved to ${file}\n`);
}

/**
 * Rebuilt on every re-pair, so a machine that is adopted again carries on rather
 * than authenticating with a token somebody has just revoked.
 */
let authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/**
 * Start over, because this computer is no longer paired.
 *
 * Somebody removed it in the app, or the token was rotated. The old advice was
 * "delete a line from a file and run this again", which is a chore, and one that
 * has to be done at the machine — the exact thing pairing exists to avoid. It
 * simply asks for a new code instead, and prints it.
 */
async function repair() {
  console.log('\n  Asking to be paired again…\n');
  clearToken();

  /**
   * Nothing from the last account carries over to the next (SEC-028).
   *
   * This only swapped the token. The worker process kept everything it held for
   * the previous account: the background commands and their output, readable by
   * the next account through `run_background_logs`; and the sandbox browser's
   * sessions, with the cookies of whatever that account had signed into. A
   * machine unpaired from one account and adopted by another — a shared office
   * computer, a laptop moved from a personal account to a work one — handed the
   * second the first's logins.
   *
   * Cleared before the new pairing, so there is no moment where the new token
   * and the old state coexist. The persistent `profile` browser mode keeps its
   * on-disk profile on purpose: it is opted into on this machine, by its owner,
   * through the environment, and deleting it here would destroy that choice.
   */
  // Imported here, the way `shutdown` imports them, rather than at the top.
  const [{ forgetAllBackground }, { closeBrowser }] = await Promise.all([
    import('./background.js'),
    import('./browser.js'),
  ]);
  await forgetAllBackground().catch((err) => console.log(`  (could not stop background commands: ${err?.message || err})`));
  await closeBrowser().catch((err) => console.log(`  (could not close the browser: ${err?.message || err})`));

  const paired = await pairUntilAdopted();
  TOKEN = paired.token;
  WORKER_ID = paired.deviceId || WORKER_ID;
  authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  saveToken(TOKEN);
  console.log(`  Paired again as "${paired.name || DEVICE_NAME}".\n`);
}

// Frames from the browser sandbox and the desktop mirror both come through
// here, and go to the server, which hands them to whichever tab has the screen
// panel open.
setFrameSink(async (payload) => {
  const res = await fetch(`${SERVER_URL}/api/worker/screen`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(payload),
    // A frame is worth less than the one behind it: if this one cannot be
    // delivered promptly there is no value in holding the connection for it.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.ok ? res.json() : { watching: false };
});

/**
 * Chunked documents on their way to be embedded.
 *
 * The same shape of hop as the screen frames: this machine has the files and the
 * server has the API key, so the text goes up and the vectors come back as rows
 * in a table. Only the folder somebody named is ever walked.
 */
setIndexSink((payload) => post('/api/worker/index', payload));

/**
 * A read of one small resource — today, only a job's status while it runs.
 * Returns null on any failure rather than throwing: see `watchForCancel`, where
 * an unreachable server must never read as a cancellation.
 */
async function get(pathname) {
  try {
    const res = await fetch(`${SERVER_URL}${pathname}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function post(pathname, body) {
  const res = await fetch(`${SERVER_URL}${pathname}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Surface the server's own sentence when it sent one. These reach the model
    // as the tool's error, and "add an OpenAI key in Settings" is actionable in
    // a way that "HTTP 400" is not.
    const body = await res.text().catch(() => '');
    let stated = '';
    try {
      stated = JSON.parse(body)?.error || '';
    } catch {
      /* not JSON — fall back to the raw body below */
    }
    throw new Error(stated || `${pathname} → HTTP ${res.status} ${body}`);
  }
  return res.json();
}

async function runJob(job) {
  const impl = LOCAL_IMPLEMENTATIONS[job.tool];
  const label = job.tool === 'run_command' ? `run_command: ${job.input?.command}` : job.tool;
  console.log(`  → ${label}`);

  if (!impl) {
    await post(`/api/worker/jobs/${job.id}/result`, {
      error: `This worker does not implement "${job.tool}".`,
    }).catch(() => {});
    return;
  }
  /*
   * Listen for a stop while this runs. See `worker/cancel.js`: the server marks a
   * cancelled job closed, and without asking the worker never found out.
   */
  const controller = new AbortController();
  const stopWatching = watchForCancel(job.id, controller, {
    getStatus: async (id) => (await get(`/api/worker/jobs/${id}`))?.status ?? null,
  });

  try {
    /**
     * Which conversation this belongs to, and whether it has been called off.
     *
     * The browser tools use `chatId` to keep one conversation's tabs, cookies and
     * sign-ins away from another's — see `sessionFor` in browser.js. `signal` is
     * aborted when the person stops the turn; `run_command` stops its process on
     * it. Every other implementation ignores what it does not read, which is why
     * adding either needed no changes anywhere else.
     */
    const output = await impl(job.input || {}, { chatId: job.chatId ?? null, signal: controller.signal });
    if (controller.signal.aborted) {
      // The server has already closed this job and stopped waiting; posting a
      // result now would only overwrite the record of the cancellation.
      console.log(`  ■ ${job.tool} (cancelled)`);
      return;
    }

    /**
     * Two shapes, and the second one is new.
     *
     * Most tools answer with a string. The browser and desktop tools answer with
     * `{ text, shot }`: the text is what the model reads, and the shot is a small
     * picture of what the screen looked like when the step finished, for the
     * person watching. Kept optional so a tool that has nothing to illustrate —
     * which is most of them — needs no changes at all.
     */
    const structured = output && typeof output === 'object' && !Array.isArray(output);
    await post(`/api/worker/jobs/${job.id}/result`, {
      output: String((structured ? output.text : output) ?? ''),
      ...(structured && output.shot ? { shot: output.shot } : {}),
    });
    console.log(`  ✓ ${job.tool}`);
  } catch (err) {
    // A tool that stopped because it was cancelled throws on the way out. The
    // server already closed the job; say nothing rather than overwrite that.
    if (controller.signal.aborted) {
      console.log(`  ■ ${job.tool} (cancelled)`);
      return;
    }
    // Reporting the failure can itself fail — the server may have gone away
    // mid-job. Swallowing that is right: the agent times the job out and says
    // so, whereas an unhandled rejection here takes the whole worker down and
    // every other job with it.
    await post(`/api/worker/jobs/${job.id}/result`, { error: err?.message || String(err) }).catch(
      () => {},
    );
    console.log(`  ✗ ${job.tool}: ${err?.message || err}`);
  } finally {
    stopWatching();
  }
}

let online = false;

/** Whether the server has told us which device row this token belongs to. */
let identityConfirmed = false;

/**
 * Adopt settings chosen in the app.
 *
 * The reply to a heartbeat is the only channel there is — nothing on the
 * internet connects inward to this machine — and it is enough, because the
 * worker is already asking every fifteen seconds. So "work in D:\projects
 * instead" is something you type on a phone and this picks up, rather than
 * something that needs a file edited here and the process restarted.
 *
 * A bad path is reported and then left alone. Changing where the assistant works
 * is not worth stopping the worker over, and repeating the complaint every
 * fifteen seconds would bury everything else.
 */
let appliedWorkspace = null;
let workspaceComplaint = '';

function applyConfig(config) {
  const wanted = config?.workspace || null;
  if (wanted === appliedWorkspace) return;

  if (!wanted) {
    // Handed back to whatever this machine was started with.
    appliedWorkspace = null;
    workspaceComplaint = '';
    setWorkspace(WORKSPACE);
    console.log(`  Workspace reset to ${WORKSPACE}`);
    return;
  }

  try {
    const now = moveWorkspace(wanted);
    appliedWorkspace = wanted;
    workspaceComplaint = '';
    console.log(`  Workspace is now ${now}`);
  } catch (err) {
    if (workspaceComplaint !== err.message) {
      workspaceComplaint = err.message;
      console.error(`  Cannot use that workspace: ${err.message}`);
    }
  }
}

async function heartbeat() {
  try {
    const res = await post('/api/worker/heartbeat', {
      workerId: WORKER_ID,
      // `workerInfo()` reports the workspace actually in use, so the app shows
      // where the assistant really is rather than where it was asked to be.
      info: { ...workerInfo(), workspaceError: workspaceComplaint || undefined },
    });
    /**
     * Learn which device row this token belongs to.
     *
     * A machine that starts with a token already saved never goes through
     * pairing, so `WORKER_ID` keeps the random placeholder generated at boot —
     * and that placeholder is what the local identity endpoint was handing to
     * the browser. It matched no device on the account, so the whole "act on the
     * computer I am sitting at" feature silently did nothing on every machine
     * except one that had *just* been paired.
     */
    if (res?.deviceId) {
      WORKER_ID = res.deviceId;
      identityConfirmed = true;
    }

    applyConfig(res?.config);

    if (!online) {
      online = true;
      // The server tells us which account this token belongs to — worth showing,
      // so you can see at a glance whose assistant can drive this machine.
      console.log(`  Connected${res?.account ? ` as ${res.account}` : ''}.`);
    }
  } catch (err) {
    if (online) console.log(`  Lost connection: ${err.message}`);
    online = false;
  }
}

/**
 * How many jobs may be in flight at once.
 *
 * The agent issues independent tool calls together and waits for all of them, so
 * running them strictly one after another turned every parallel fan-out back
 * into a queue — and a single `browser_wait 30` stalled the calls beside it into
 * the server's timeout.
 *
 * Not unbounded, though: these are real processes on somebody's computer, and
 * six simultaneous `npm install`s is its own kind of rude.
 */
const MAX_CONCURRENT_JOBS = Math.min(Math.max(Number(process.env.WORKER_CONCURRENCY) || 4, 1), 12);

/**
 * Ceilings for every request this worker makes.
 *
 * There were none, and the poll below is the one that mattered. A socket that
 * is dropped without an RST — a laptop suspended, a tunnel torn down, a NAT
 * table forgetting the mapping — leaves `fetch` pending forever. `pollLoop` is
 * a single `for(;;)` with nothing watching it, so the worker would go deaf and
 * stay deaf, while `workerStatus` on the server still reported it online from
 * the last heartbeat. Every tool call then waits out its own timeout instead.
 *
 * The poll is deliberately the long one: the server holds each request open for
 * about 25 seconds, so anything shorter would abort healthy polls and turn a
 * cheap long-poll into a busy loop. 45s leaves generous headroom and still
 * bounds the failure.
 */
const POLL_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;
let inFlight = 0;

/**
 * Poll for work. The server holds each request open for up to ~25s, so this is
 * effectively push with none of the inbound-firewall problems: nothing on the
 * internet ever connects to this machine.
 */
async function pollLoop() {
  let unauthorised = false;

  for (;;) {
    // Back off rather than claiming work there is no capacity to start: a job
    // claimed and left sitting is one the server is already timing.
    if (inFlight >= MAX_CONCURRENT_JOBS) {
      await new Promise((r) => setTimeout(r, 120));
      continue;
    }

    try {
      const res = await fetch(`${SERVER_URL}/api/worker/jobs`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      if (res.status === 401) {
        // A token belongs to one computer on one account, so a rejection means
        // this machine was unpaired in the app. Rather than telling somebody to
        // go and edit a file *on this machine* — the errand pairing exists to
        // remove — it simply offers a fresh code and waits to be adopted again.
        if (!unauthorised) {
          unauthorised = true;
          console.log('\n  This computer is no longer paired.');
          await repair();
        }
        /**
         * Wait before asking again.
         *
         * `unauthorised` is only cleared by a *successful* poll, so if the token
         * `repair()` obtained is rejected too — revoked again, or the pairing
         * never completed — this `continue` re-fetched immediately, with no
         * delay at all. An unthrottled request loop against the server, which on
         * a hosted deployment is billed invocations at the fastest rate the
         * network allows.
         */
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      unauthorised = false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { job, sleepMs } = await res.json();

      /**
       * The server can ask to be left alone for a moment.
       *
       * It does that when this account has had no work for a while, and it is
       * asking for a concrete reason: on a hosted deployment the long poll is
       * billed execution time, and a worker idling overnight would spend a whole
       * free tier on nothing. Honoured rather than ignored, because the server
       * is the only side that can see whether anybody is waiting.
       */
      if (!job && sleepMs > 0) {
        await new Promise((r) => setTimeout(r, Math.min(Number(sleepMs) || 0, 30_000)));
        continue;
      }

      if (job) {
        // Not awaited: the point is to go straight back for the next job while
        // this one runs. `runJob` reports its own outcome and never throws.
        inFlight += 1;
        runJob(job)
          .catch((err) => console.log(`  ✗ ${job.tool}: ${err?.message || err}`))
          .finally(() => {
            inFlight -= 1;
          });
      }
    } catch (err) {
      /**
       * A poll that timed out is the ordinary case, not a fault.
       *
       * The server holds the request open and may simply have had nothing to
       * say; the ceiling is here to stop a dead socket hanging forever, not to
       * report anything. Treating it like a failure would print a line every
       * 45 seconds on an idle machine and mark a perfectly healthy worker
       * offline, so it goes straight back round — which is what the request
       * would have done had it returned empty.
       */
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') continue;

      if (online) console.log(`  Poll failed: ${err.message}`);
      online = false;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

console.log('\n  Synapsez worker\n');
console.log(`    server:    ${SERVER_URL}`);
console.log(`    computer:  ${DEVICE_NAME}`);
console.log(`    workspace: ${WORKSPACE}`);
console.log(`    device id: ${WORKER_ID}\n`);
console.log('  The assistant can now read, write and run commands inside that workspace.');
console.log('  Stop this process to cut off local access instantly.\n');

/**
 * Take the background commands down with the worker.
 *
 * They are spawned without `detached`, which on POSIX means a Ctrl-C reaches the
 * whole process group — but not on Windows, where killing a parent leaves its
 * children running. A dev server nobody can see, holding a port nobody can trace,
 * is exactly what `run_background` promises not to leave behind — so they are
 * stopped explicitly rather than relied on to die.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} — stopping background commands…`);
  /**
   * The desktop host and its camera belong in here too, and were missing.
   *
   * `stopDesktop` existed and was exported and called by nothing, so Ctrl-C
   * stopped the background commands and the browser and left the PowerShell
   * host and the screen-capture process running — the capture one still
   * grabbing the whole desktop several times a second, for a worker that had
   * exited. That is precisely the "process nobody remembers to stop" this
   * function was written to prevent, one import short of doing it.
   */
  const [{ stopAllBackground }, { closeBrowser }, { stopDesktop }] = await Promise.all([
    import('./background.js'),
    import('./browser.js'),
    import('./desktop.js'),
  ]);
  await stopAllBackground().catch(() => {});
  await closeBrowser().catch(() => {});
  await stopDesktop().catch(() => {});
  console.log('  Local access is cut off.\n');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

/**
 * Learn what browsers this machine has before the first heartbeat, so the
 * picker in the app is populated the moment the computer appears rather than
 * fifteen seconds later. Never fatal: not being able to answer the question is
 * a smaller problem than not starting.
 */
/**
 * Tell the page in front of you which computer it is sitting at.
 *
 * The problem this solves: with a laptop and a desktop both paired and both
 * online, the assistant picked whichever had the most recent heartbeat — so you
 * would sit at the laptop, say "open that file", and watch nothing happen
 * because it opened on the machine at home.
 *
 * A browser cannot learn which computer it is running on. It can, however, ask
 * `127.0.0.1`, and the only thing that answers there is a worker on this very
 * machine. So the worker answers with its device id and the page passes it along
 * with each message.
 *
 * Three constraints, each closing a hole, and none of them optional:
 *
 *   **Loopback only.** Bound to 127.0.0.1, not 0.0.0.0 — nothing else on the
 *   network can ask, which matters on cafe wifi.
 *
 *   **It cannot be told to do anything.** One route, GET, returning an
 *   identifier. There is no verb here to abuse even if something did reach it.
 *
 *   **CORS names one origin: the deployment this worker answers to.** With `*`,
 *   every site on the internet could quietly learn that you run Synapsez and
 *   what your machine is called — a fingerprinting signal handed out for free.
 *
 * If the port is taken or the browser refuses the request, nothing breaks: the
 * page simply does not send a hint and the old behaviour stands.
 */
async function startLocalIdentity() {
  if (/^(0|false|no)$/i.test(process.env.WORKER_LOCAL_PORT ?? '')) return;
  const port = Number(process.env.WORKER_LOCAL_PORT) || 8765;

  const { createServer } = await import('node:http');

  const server = createServer((req, res) => {
    const origin = req.headers.origin || '';
    // One origin, matched exactly. Not a prefix test: `https://evil.com/?x=`
    // starting with the right characters is exactly the trick a prefix invites.
    if (origin && origin === SERVER_URL) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // Chrome blocks a public page reaching loopback unless the preflight is
      // answered with this. Without it the whole feature silently does nothing.
      if (req.headers['access-control-request-private-network']) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== 'GET' || !req.url.startsWith('/whoami')) {
      res.statusCode = 404;
      return res.end();
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Null until the server has confirmed which row this token belongs to. An
    // unconfirmed id is the boot-time placeholder, which matches no device on
    // the account — and a hint that matches nothing is worse than no hint,
    // because it looks like the feature working.
    res.end(JSON.stringify({ deviceId: identityConfirmed ? WORKER_ID : null, name: DEVICE_NAME }));
  });

  server.on('error', (err) => {
    // Almost always EADDRINUSE, and almost always a second worker or another
    // program on the port. Worth one line, never worth stopping over.
    console.log(`  Local identity is off (${err.code || err.message}). The app will still work.`);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`  This computer identifies itself at http://127.0.0.1:${port}`);
  });
}

await startLocalIdentity().catch(() => {});

await import('./browser.js')
  .then((m) => m.refreshBrowserCapabilities())
  .catch(() => {});

await heartbeat();
setInterval(heartbeat, 15_000);
pollLoop();
