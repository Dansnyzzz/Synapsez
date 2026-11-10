import crypto from 'node:crypto';
import { LIMITS as FILE_LIMITS, classify, mimeFor, oneLine, saveChangedFile, saveGenerated, saveMachineFile } from './attachments.js';
import { getStore } from './store/index.js';
import { exhaust } from './freeTier.js';
import { e2bConfigured, e2bExistingMachine, e2bForgetAccount, e2bMachineFor, e2bScratch, e2bUnavailable } from './e2b.js';
import { rememberPackages, restorePackages, terminalScript, tidyIfDue } from './machineCare.js';
import { log } from './util/trace.js';

/**
 * A private Linux computer in the cloud, one per account.
 *
 * `run_command` runs on the person's own PC, through the worker — which is the
 * right place for their files and the wrong place for "work this out in
 * Python", and does not exist at all for somebody who never paired a machine.
 * This is the other half: a microVM with bash, Python, Node, git and root.
 *
 * **Two places one can run** (owner, 2026-11-02). E2B first (server/e2b.js):
 * twenty at once on its free plan, paused rather than stopped when idle, paid
 * from a one-off credit spread over the months before it lapses. Vercel
 * Sandbox, below, when E2B cannot — no key, the month's share of the credit
 * spent, all twenty running, E2B down — as a stand-in: a different machine,
 * without the usual one's files, which the model is told (`machineNote`).
 *
 * **One per account, kept.** The same machine is found again by name from every
 * conversation, and its disk is snapshotted when it pauses — so what was
 * installed, cloned or saved is there next week, the way a computer is. Only
 * the newest snapshot is kept, for thirty days after it was last used.
 *
 * **The whole internet.** It used to reach package registries only, which
 * stopped exactly the work people wanted it for: calling an API, downloading a
 * dataset, reading a page from code. The risk that fence addressed — a model
 * talked into posting what it has read to somebody's server — is now graded
 * per command instead (see `assessRisk` for `sandbox_run`): a command that
 * uploads, pipes a download into a shell, or destroys asks first, as `run_command`
 * does, and everything else runs.
 *
 * Free on Vercel's Hobby plan within its monthly allotment; past it, creation
 * pauses rather than billing (see docs/sandbox/pricing on vercel.com).
 */

const SESSION_MS = 20 * 60 * 1000;
const COMMAND_MS = 120_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_FILES_IN = 20;
const MAX_FILE_IN_BYTES = 2 * 1024 * 1024;
const MAX_BRING = 6;
const SNAPSHOT_DAYS = 30;
/** The port the cloud browser listens on — see server/cloudBrowser. */
export const BROWSER_PORT = 3000;
/**
 * Where the helper listens when it runs as root on E2B (SBX-013): under 1024,
 * where only root can open a port. On 3000 an ordinary command could take the
 * port while the helper rested: the root start then died on it and fell back to
 * the account, and whatever answered was taken for the helper and handed its key.
 */
export const ROOT_BROWSER_PORT = 843;
/** The port the MCP bridge listens on — see server/mcp/cloud.js. */
export const MCP_PORT = 3100;
/** Every port a machine opens, so neither service waits on a reconfigure. */
const PORTS = [BROWSER_PORT, MCP_PORT];

/**
 * How much of the shared allotment one account, and the whole app, may use a
 * day.
 *
 * Vercel's Hobby plan gives a team — every account on this deployment
 * together — ten machines at once and a few CPU-hours a month. Without a
 * ceiling, one person looping a browser all afternoon spends it for everybody
 * else; the per-account budget keeps that fair, and the app-wide one keeps a
 * busy day from exhausting the month. Both are plain counters in the database
 * (the same table as sign-in throttling), so they hold across instances.
 *
 * The defaults are sized to Hobby: 5 CPU-hours is ~18,000 CPU-seconds a
 * month, ~600 a day, and a browser action costs Chromium roughly one to three
 * — so ~400 actions a day keeps the month from running out in its first week.
 * Raise them with CLOUD_ACTIONS_PER_DAY / CLOUD_ACTIONS_TOTAL_PER_DAY on a
 * paid plan.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
class LimitError extends Error {}
const hours = (ms) => Math.max(1, Math.ceil(ms / 3_600_000));
export function cloudBudgets(env = process.env) {
  // On E2B every second is paid for from the account's own share of the credit
  // (freeTier.js `e2bAccountAllowance`), so these only stop something running away.
  const e2b = e2bConfigured(env);
  return {
    perAccount: Math.max(1, Number(env.CLOUD_ACTIONS_PER_DAY) || (e2b ? 400 : 60)),
    total: Math.max(1, Number(env.CLOUD_ACTIONS_TOTAL_PER_DAY) || (e2b ? 4000 : 400)),
  };
}

/**
 * Count one use of the cloud computer; throws a sentence the model can pass on
 * when a budget is spent. A counter that cannot be reached lets the call
 * through — a database hiccup should not switch the feature off.
 *
 * @param {string} userId
 */
export async function chargeCloud(userId) {
  const store = getStore();
  if (typeof store.hitRateLimit !== 'function') return;
  const { perAccount, total } = cloudBudgets();
  try {
    const mine = await store.hitRateLimit(`cloud:acct:${userId}`, perAccount, DAY_MS);
    if (!mine.allowed) {
      throw new LimitError(
        `This account has used its ${perAccount} cloud-computer actions for today; it opens again in about ${hours(mine.retryAfterMs)}h. ` +
          'Tell the user plainly, and offer what can be done without it.',
      );
    }
    const all = await store.hitRateLimit('cloud:all', total, DAY_MS);
    if (!all.allowed) {
      throw new LimitError(
        `The cloud computers are at today's limit for the whole app; they open again in about ${hours(all.retryAfterMs)}h. ` +
          'Tell the user plainly, and offer what can be done without it.',
      );
    }
  } catch (err) {
    if (err instanceof LimitError) throw err;
  }
}

/**
 * How many new MCP servers one account, and the whole app, may check a day.
 *
 * A check (`checkOnScratch` in mcp/cloud.js) is a fresh machine that installs a
 * package and starts it: a minute or more of two vCPUs, a hundred CPU-seconds
 * or so, where a browser action is one to three. Counted as one action, an
 * account trying command after command could spend a large share of the month.
 * A check happens once per command for everybody — what it finds is shared — so
 * ordinary use never meets this. CLOUD_CHECKS_PER_DAY / CLOUD_CHECKS_TOTAL_PER_DAY.
 */
export function checkBudgets(env = process.env) {
  return {
    perAccount: Math.max(1, Number(env.CLOUD_CHECKS_PER_DAY) || 5),
    total: Math.max(1, Number(env.CLOUD_CHECKS_TOTAL_PER_DAY) || 30),
  };
}

/**
 * Count one check of a new MCP server: one of the day's checks, and an action
 * like any other. Throws a sentence to show when either is spent. The checks
 * come first, being the scarcer: a refused check spends no action.
 *
 * @param {string} userId
 */
export async function chargeCloudCheck(userId) {
  const store = getStore();
  if (typeof store.hitRateLimit !== 'function') return;
  const { perAccount, total } = checkBudgets();
  try {
    const mine = await store.hitRateLimit(`cloud:check:${userId}`, perAccount, DAY_MS);
    if (!mine.allowed) {
      throw new LimitError(
        `This account has checked ${perAccount} new MCP servers on the cloud computer today; it can check another in about ${hours(mine.retryAfterMs)}h. ` +
          'A server somebody has already added is still ready at once.',
      );
    }
    const all = await store.hitRateLimit('cloud:check:all', total, DAY_MS);
    if (!all.allowed) {
      throw new LimitError(
        `New MCP servers are at today's limit for the whole app; another can be checked in about ${hours(all.retryAfterMs)}h. ` +
          'A server somebody has already added is still ready at once.',
      );
    }
  } catch (err) {
    if (err instanceof LimitError) throw err;
  }
  await chargeCloud(userId);
}

/**
 * The platform's refusals, in words a person can act on.
 *
 * Starting a machine fails for reasons nobody in the conversation caused —
 * the team's ten are all running, the month's allotment is spent — and the raw
 * API error says so in a way that reads like a bug. Anything unrecognised
 * keeps its own message, with the setup hint that is usually the cause.
 */
export function machineStartError(err) {
  const raw = String(err?.message || err || '');
  const status = Number(err?.response?.status || err?.status || 0);
  if (status === 429 || /concurren|too many|rate.?limit/i.test(raw)) {
    return new Error(
      'Every cloud computer this app may run at once is in use by other people right now. ' +
        'Try again in a few minutes; tell the user it is busy, not broken.',
    );
  }
  if (status === 402 || /quota|allotment|usage limit|limit exceeded|payment|billing/i.test(raw)) {
    return new Error(
      'The cloud computers have used this month\'s free allotment, so none can start until it resets. ' +
        'Tell the user plainly, and offer what can be done without it.',
    );
  }
  return new Error(
    `The cloud computer could not be started: ${raw}. ` +
      'On Vercel this needs OIDC enabled for the project; elsewhere VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.',
  );
}

/**
 * Whether there is anything to start a sandbox with: an E2B key, or Vercel —
 * on Vercel the platform hands the function an OIDC token; elsewhere it takes
 * a token, team and project from the environment. None, and the tool is not
 * offered at all — a model that can see it would promise a computer it cannot
 * have.
 */
export function sandboxConfigured(env = process.env) {
  if (env.SANDBOX_DISABLED === '1') return false;
  return e2bConfigured(env) || vercelConfigured(env);
}

/** Whether a Vercel Sandbox can be started: the stand-in, or the only place when there is no E2B key. */
export function vercelConfigured(env = process.env) {
  if (env.SANDBOX_DISABLED === '1') return false;
  if (env.VERCEL || env.VERCEL_OIDC_TOKEN) return true;
  return !!(env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID);
}

/** Explicit credentials when given; otherwise the SDK finds the OIDC token itself. */
function credentials(env = process.env) {
  if (env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID) {
    return { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID };
  }
  return {};
}

/**
 * The machine's name: the same for every conversation of one account, and
 * nothing anybody could read the account back out of.
 */
export function sandboxName(userId) {
  const digest = crypto.createHash('sha256').update(`machine:${userId}`).digest('hex');
  return `synz-${digest.slice(0, 32)}`;
}

/**
 * A path as the machine will read it: relative ones resolve against the
 * session's own working folder (the SDK does that), absolute ones are taken
 * as given — it is the account's own computer, and every folder on it is theirs.
 *
 * It used to prefix `/vercel/sandbox` and run every command there, which is
 * where the older runtime images kept their work; the current image has no
 * such folder, and every command failed with `chdir /vercel/sandbox: no such
 * file or directory` before it ran.
 */
export function workPath(path) {
  const raw = String(path || '').trim().replace(/\\/g, '/');
  if (!raw) throw new Error('A file needs a path, e.g. "data/input.csv".');
  return raw;
}

const clipOutput = (text) => {
  const s = String(text || '');
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const half = MAX_OUTPUT_CHARS / 2;
  return `${s.slice(0, half)}\n… [${s.length - MAX_OUTPUT_CHARS} characters cut] …\n${s.slice(-half)}`;
};

/** Loaded on first use: most requests never start a machine. */
let sdk = null;
async function loadSdk() {
  if (!sdk) sdk = await import('@vercel/sandbox');
  return sdk;
}

/** @param {string} name  @param {{ signal?: AbortSignal }} [options] */
async function machineFor(name, { signal } = {}) {
  const { Sandbox } = await loadSdk();
  return Sandbox.getOrCreate({
    ...credentials(),
    name,
    timeout: SESSION_MS,
    resources: { vcpus: 2 },
    networkPolicy: 'allow-all',
    // The disk survives a pause, so the account finds its files and installs
    // again next time — only the newest snapshot, kept a month after last use.
    persistent: true,
    keepLastSnapshots: { count: 1, expiration: SNAPSHOT_DAYS * 24 * 60 * 60 * 1000, deleteEvicted: true },
    tags: { app: 'synapsez' },
    // The browser's and the MCP bridge's ports, reachable as https://….vercel.run.
    // Machines made before either existed gain them in `portAddress`.
    ports: PORTS,
    signal,
  });
}

/**
 * A machine for one job and nobody's in particular, deleted afterwards.
 *
 * Used to try an MCP server the first time anybody adds it (server/mcp/cloud.js),
 * so the tools it lists can be offered to the next account without that account
 * waiting. Not the adding account's own machine on purpose: that account has
 * root on its machine, and whatever it listed there would be shown to everyone
 * after it. Nothing is kept: no disk, no snapshot.
 *
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function scratchMachine({ signal } = {}) {
  if (e2bConfigured()) {
    /** @type {'credit' | 'busy' | 'auth' | 'down' | 'broken' | null} */
    let declined = e2bAsideFor;
    if (e2bReady()) {
      try {
        return await e2bScratch();
      } catch (err) {
        declined = await setE2bAside(err);
      }
    }
    if (!vercelConfigured()) throw unavailableError(declined);
  }
  const { Sandbox } = await loadSdk();
  try {
    return await Sandbox.create({
      ...credentials(),
      timeout: 6 * 60 * 1000,
      resources: { vcpus: 2 },
      networkPolicy: 'allow-all',
      persistent: false,
      tags: { app: 'synapsez', role: 'mcp-check' },
      ports: [MCP_PORT],
      signal,
    });
  } catch (err) {
    throw machineStartError(err);
  }
}

/** Stop and delete a scratch machine; never throws — it is cleanup. @param {any} machine */
export async function discardMachine(machine) {
  // An E2B machine's stop is a pause, a snapshot of it nobody will resume.
  if (machine?.provider === 'e2b') {
    await machine.delete().catch(() => {});
    return;
  }
  try {
    await machine?.stop?.();
  } catch {
    /* already stopped */
  }
  try {
    await machine?.delete?.();
  } catch {
    /* it expires by itself */
  }
}

/**
 * The https address of one of a machine's ports, opening it on an older machine.
 *
 * @param {any} machine
 * @param {number} port
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function portAddress(machine, port, { signal } = {}) {
  try {
    return machine.domain(port);
  } catch {
    await machine.update({ ports: PORTS }, { signal });
    return machine.domain(port);
  }
}

/** One file off the account's machine, as the account: the path goes as a value, never as a command. */
export async function removeFromMachine(userId, file) {
  const machine = await machineForUser(userId);
  await machine.runCommand({ ...shellFor('rm -f -- "$SYNZ_FILE"', { SYNZ_FILE: file }, { userBin: true }), timeoutMs: 10_000 });
}

/**
 * What was sent straight to a machine, a month on: the row and the bytes together, a few
 * each sweep. A machine that no longer exists is not made again to find nothing on it.
 */
export async function expireMachineUploads(store, { days = 30, limit = 20 } = {}) {
  for (const row of await store.expiredMachineUploads(days, limit)) {
    if (e2bConfigured()) {
      const machine = await e2bExistingMachine(row.user_id).catch(() => null);
      await machine?.runCommand({ ...shellFor('rm -f -- "$SYNZ_FILE"', { SYNZ_FILE: row.source }, { userBin: true }), timeoutMs: 10_000 }).catch(() => {});
    }
    await store.takeUpload(row.user_id, row.id);
  }
}

/** Whatever this account has on a machine, before the account goes. */
export async function forgetMachine(userId) {
  if (e2bConfigured()) await e2bForgetAccount(userId).catch(() => {});
}

/**
 * The account's machine, started or resumed, with the browser port open.
 *
 * @param {string} userId
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function machineForUser(userId, { signal } = {}) {
  let declined = null;
  if (e2bConfigured()) {
    if (!e2bReady()) declined = e2bAsideFor;
    else {
      try {
        const machine = await e2bMachineFor(userId, sandboxName(userId));
        // A machine just made has none of what this account installs. Once: the
        // flag is on the object every caller of this start shares.
        if (machine.fresh) {
          machine.fresh = false;
          await restorePackages(userId, machine, shellFor);
        }
        return machine;
      } catch (err) {
        declined = await setE2bAside(err);
      }
    }
    if (!vercelConfigured()) throw unavailableError(declined);
  }
  let machine;
  try {
    machine = await machineFor(sandboxName(userId), { signal });
  } catch (err) {
    throw machineStartError(err);
  }
  // Standing in for the E2B machine: a different computer, which the model is told.
  if (declined) machine.standIn = true;
  return machine;
}

/**
 * E2B set aside on this instance for a while after it refused for a reason
 * that will not pass in seconds — a key it does not accept, no answer, or a
 * library that will not load here — so each call does not wait on it before
 * going to Vercel. Busy and out of credit are not set aside here: busy may clear
 * by the next call, and the credit is counted in the database, for every
 * instance.
 */
let e2bAsideUntil = 0;
/** @type {'auth' | 'down' | 'broken' | null} */
let e2bAsideFor = null;
const AUTH_ASIDE_MS = 10 * 60_000;
const DOWN_ASIDE_MS = 60_000;
const e2bReady = () => e2bConfigured() && Date.now() >= e2bAsideUntil;

/**
 * Why E2B declined this one, having noted what follows from it; rethrows an
 * error that would follow the work to any machine (a bug, a bad argument).
 *
 * @param {any} err
 */
async function setE2bAside(err) {
  const declined = e2bUnavailable(err);
  if (!declined) throw err;
  // The cause is what the owner needs to read (a library that would not load says why only there).
  const said = err?.cause instanceof Error ? err.cause.message : err?.message || err;
  log.warn('cloud computer: E2B declined, Vercel stands in', { reason: declined, error: String(said).slice(0, 300) });
  // E2B saying its credit is gone is believed for the rest of the month; our own count already knew.
  if (declined === 'credit' && err?.name !== 'E2BOutOfCredit') await exhaust('e2b').catch(() => {});
  if (declined === 'auth' || declined === 'down' || declined === 'broken') {
    e2bAsideUntil = Date.now() + (declined === 'down' ? DOWN_ASIDE_MS : AUTH_ASIDE_MS);
    e2bAsideFor = declined;
  }
  return declined;
}

/**
 * The sentence for no machine at all: E2B declined (now, or when it was set
 * aside) and there is no Vercel to stand in. Busy and spent read as the
 * platform's own refusals always have.
 *
 * @param {'credit' | 'busy' | 'auth' | 'down' | 'broken' | null} declinedNow
 */
function unavailableError(declinedNow) {
  const declined = declinedNow || e2bAsideFor;
  if (declined === 'busy') return machineStartError({ status: 429 });
  if (declined === 'credit') return machineStartError({ status: 402 });
  if (declined === 'auth') {
    return new Error("The cloud computer could not be started: E2B did not accept this deployment's key (E2B_API_KEY). Tell the user plainly; the owner has to check the key.");
  }
  if (declined === 'broken') {
    return new Error("The cloud computer could not be started: this server could not load its E2B library. Tell the user plainly; the owner has to check the deployment's logs.");
  }
  return new Error('The cloud computer could not be started: E2B is not answering right now. Try again in a few minutes; tell the user it is busy, not broken.');
}

/**
 * A file's bytes from this account's cloud computer, or null when it is not
 * there (2026-10-19) — for `look_at`, which reads a figure where it was made
 * instead of having it handed over as a file card first.
 *
 * @param {string} userId
 * @param {string} path
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Buffer|null>}
 */
export async function readMachineFile(userId, path, { signal } = {}) {
  if (!sandboxConfigured()) {
    throw new Error("This account has no cloud computer, so there is nothing at that path. For a file on the user's own computer, use read_file.");
  }
  await chargeCloud(String(userId));
  const machine = await machineForUser(String(userId), { signal });
  return (await machine.readFileToBuffer({ path: workPath(path) }, { signal })) || null;
}

/**
 * The https address of the machine's browser port, opening it on an older machine.
 *
 * @param {any} machine
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function browserAddress(machine, { signal } = {}) {
  // Every port at once: updating to the browser's alone would close the MCP
  // bridge's on a machine that had both.
  return portAddress(machine, BROWSER_PORT, { signal });
}

/** /etc/profile, for the PATH it sets, read with no home to find the account's own files from (see shellFor). */
const SYSTEM_PROFILE = '_home="$HOME"; HOME=/nonexistent; source /etc/profile >/dev/null 2>&1 || true; HOME="$_home"; unset _home';

/**
 * Where the template keeps a node only root can change (SBX-006,
 * scripts/e2b-template.mjs): the image's own, copied there at build time,
 * before anything of the account's has run. E2B's /usr/local, where the image
 * has it, is writable by everyone on a running machine.
 */
export const ROOT_NODE_DIR = '/opt/synz-node';
/** The system's folders, where root looks first and for the programs its checks run, by full path. */
const ROOT_SYSTEM_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The folders /etc/profile names, learned as nobody with nothing in the
 * environment (SBX-006): /etc/profile puts /usr/local first and runs what
 * /etc/profile.d holds, so read as root it ran whatever the account had put in
 * E2B's writable /usr/local — `stat` included — as root, key in reach. Read as
 * nobody, a planted program runs as nobody and finds no key.
 */
const PROFILE_PATH_AS_NOBODY =
  // With a limit (SBX-012): a planted `id` that sleeps must not hold every root start.
  '_seen="$(/usr/bin/timeout 5 /usr/bin/setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/env -i HOME=/nonexistent /bin/bash --noprofile --norc ' +
  `-c 'source /etc/profile >/dev/null 2>&1; printf %s "$PATH"' 2>/dev/null || true)"`;

/**
 * The template's node, when /opt and everything under ROOT_NODE_DIR are root's
 * alone — a link aside, which only a folder that can be written can change. A
 * check that cannot run (no `find`) prints its error, and the node is not used.
 */
const TRUSTED_NODE =
  `_node=; if [ "$(/usr/bin/stat -Lc %u /opt 2>/dev/null)" = 0 ] && [ -x ${ROOT_NODE_DIR}/bin/node ] && ` +
  `[ -z "$(/usr/bin/find /opt -maxdepth 0 -perm /022 2>&1; /usr/bin/find ${ROOT_NODE_DIR} ! -type l \\( ! -user root -o -perm /022 \\) -print -quit 2>&1)" ]; ` +
  `then _node=${ROOT_NODE_DIR}/bin; fi`;

/**
 * How a command is run: `bash --noprofile --norc -c`, nothing loaded first (HAR-001).
 *
 * It was `bash -lc`, a login shell, which reads ~/.bash_profile and ~/.profile
 * before the command — and the disk is kept between conversations. One command
 * talked into appending to those files ran its payload ahead of every command
 * after it, in every conversation, never shown in any of them — and ahead of
 * the cloud browser's and the MCP bridge's start, with their keys in reach.
 * Now the system profile alone is read (/etc/profile, root's to change, which
 * is where the image puts node on the PATH), never the account's own files;
 * `BASH_ENV` is cleared for the same reason; and the PATH a login profile would
 * have added (~/.local/bin, where `pip install --user` puts things) is set here
 * instead. A tool that needs its own profile runs as `source ~/.profile && …`,
 * in plain view and graded like anything else.
 *
 * The PATH is the system's, with the account's own folders taken out — a
 * `~/.local/bin/node` written by one ordinary command would otherwise run in
 * place of the real one ahead of every later service start, keys in hand. A
 * command the account runs (`userBin`) gets them back at the end, after the
 * system's, so `pip install --user` tools still run and never shadow a system
 * program; a service start (the cloud browser, the MCP bridge) does not.
 *
 * The network stays open and the disk stays kept: both are the product's
 * choice (one computer per account, the whole internet — see the top of this
 * file), and what leaves the machine is graded per command by `assessRisk`.
 * Root (`as_root`) can still change /etc/profile.d — and asks first, every time.
 *
 * **The system profile is read with no home** (`SYSTEM_PROFILE`). E2B's base image
 * ends its /etc/profile with `source ~/.bashrc` and `source ~/.profile` — the
 * account's own files, back in through the system's (found by the live probe,
 * 2026-11-02). So it is read with HOME pointed at /nonexistent, where `~` finds
 * nothing and the account cannot make anything, and HOME is put back after.
 *
 * **As root** (`root: true`, the cloud browser's own start) "can the account
 * write here" is the wrong question to ask with `-w`, which answers for root
 * and is yes everywhere. What is kept is what only root can change: a folder
 * owned by root that neither its group nor anyone else may write. There is no
 * falling back to the PATH as it came — if node is not in such a folder, the
 * start fails and the service comes up as the account instead. The folders are
 * the template's node (ROOT_NODE_DIR), the system's, and those /etc/profile
 * names — read as nobody, never run as root (SBX-006) — and every program the
 * check itself runs is named by its full path.
 *
 * @param {string} command
 * @param {Record<string, string>} [env]
 * @param {{ userBin?: boolean, root?: boolean }} [options]
 */
export function shellFor(command, env = {}, { userBin = false, root = false } = {}) {
  if (root) {
    const rootPath = [
      PROFILE_PATH_AS_NOBODY,
      TRUSTED_NODE,
      /*
       * Each folder as it really is (no link left to repoint), kept only when it
       * and every folder above it, up to /, are root's and written by nobody
       * else (SBX-010): a root-owned folder under E2B's writable /usr/local can
       * be renamed away by the account and replaced after it is checked.
       */
      `_keep=; IFS=: read -ra _dirs <<< "\${_node:+$_node:}${ROOT_SYSTEM_PATH}\${_seen:+:$_seen}"; for _d in "\${_dirs[@]}"; do case "$_d" in /*) ;; *) continue ;; esac; ` +
        '_d="$(/usr/bin/readlink -f "$_d" 2>/dev/null)" || continue; [ -d "$_d" ] || continue; case ":$_keep:" in *":$_d:"*) continue ;; esac; ' +
        '_p="$_d"; _ok=1; while :; do [ "$(/usr/bin/stat -c %u "${_p:-/}" 2>/dev/null)" = 0 ] || { _ok=; break; }; _m="$(/usr/bin/stat -c %a "${_p:-/}" 2>/dev/null)"; ' +
        'case "${_m: -2}" in *[2367]*) _ok=; break ;; esac; [ -z "$_p" ] && break; _p="${_p%/*}"; done; ' +
        '[ -n "$_ok" ] && _keep="${_keep:+$_keep:}$_d"; done',
      `export PATH="\${_keep:-${ROOT_SYSTEM_PATH}}"`,
      // A root command starts in the account's folder, and `python3 -m pip` would import a `pip` left there (SBX-012).
      'export PYTHONSAFEPATH=1',
      'unset _seen _node _keep _dirs _d _m _p _ok',
    ].join('\n');
    return {
      cmd: 'bash',
      args: ['--noprofile', '--norc', '-c', `${rootPath}\n${command}`],
      env: { ...env, BASH_ENV: '', ENV: '' },
    };
  }
  const systemPath = [
    SYSTEM_PROFILE,
    // Every entry under the account's home, relative, or writable by the account
    // dropped from what the system set — the property that matters is who can
    // put a program there, not where the folder is.
    '_orig="$PATH"; _keep=; _open=; IFS=: read -ra _dirs <<< "$PATH"; for _d in "${_dirs[@]}"; do case "$_d" in "$HOME"*|[!/]*|"") ;; *) if [ -w "$_d" ]; then _open="${_open:+$_open:}$_d"; else _keep="${_keep:+$_keep:}$_d"; fi ;; esac; done',
    `export PATH="\${_keep:-/usr/local/bin:/usr/bin:/bin}${userBin ? ':$HOME/.local/bin:$HOME/bin' : ''}"`,
    // An image that keeps node somewhere the account can write still starts its
    // services: such folders outside home come back first, after the system's,
    // and only then — node still missing — the original PATH, rather than nothing.
    'command -v node >/dev/null 2>&1 || export PATH="$PATH${_open:+:$_open}"',
    'command -v node >/dev/null 2>&1 || export PATH="$PATH:$_orig"',
    'unset _orig _keep _open _dirs _d',
  ].join('\n');
  return {
    cmd: 'bash',
    args: ['--noprofile', '--norc', '-c', `${systemPath}\n${command}`],
    env: { ...env, BASH_ENV: '', ENV: '' },
  };
}

/**
 * A cell's answer, as the model reads it — first of all whether the session it
 * ran in is the one earlier calls built up, because a model that assumes its
 * `df` is still loaded after the machine rested writes code against nothing.
 *
 * @param {{ fresh?: boolean, ended?: boolean, busy?: boolean, output?: string, result?: string | null, error?: string | null }} cell
 * @param {boolean} ran  whether there was code to run, rather than only a reset
 */
export function pythonReport(cell, ran = true) {
  if (cell.busy) return `[Python: ${cell.error || 'the session is still running an earlier cell.'}]`;
  const lines = [
    cell.ended
      ? '[Python: the session ended during this call — nothing from earlier calls is defined any more. The next call starts a new one; load what you need again.]'
      : cell.fresh
        ? '[Python: a new session — nothing from earlier calls is defined (the cloud computer had rested, or the session was reset). Load what you need again.]'
        : '[Python: the same live session — what earlier calls defined is still there.]',
  ];
  if (!ran) return lines.join('\n');
  if (cell.output) lines.push(`output:\n${clipOutput(cell.output)}`);
  if (cell.result != null) lines.push(`Out: ${clipOutput(cell.result)}`);
  if (cell.error) lines.push(`error:\n${clipOutput(cell.error)}`);
  if (!cell.output && cell.result == null && !cell.error) lines.push('(ran; printed nothing)');
  return lines.join('\n');
}

/**
 * What the model is told about the machine under every answer. Its words, not
 * the person's: the screen leaves it out (`forDisplay` in render.js, held to
 * this sentence by test/features).
 *
 * A stand-in (Vercel, while E2B cannot) says so: what was saved on the usual
 * computer is not on this one, and what is made here may not be there later.
 * An E2B computer pauses after four idle minutes, a Vercel one rests after
 * fifteen.
 *
 * @param {string} home  the session's working folder, when the SDK says
 * @param {{ standIn?: boolean, provider?: string, memMb?: number, cpu?: number }} [machine]
 */
export function machineNote(home, { standIn = false, provider = '', memMb = 0, cpu = 0 } = {}) {
  const opening = standIn
    ? "(A stand-in cloud computer for this account: its usual one is unavailable right now, so what was saved or installed there is not here, and what is made here may not be there later"
    : "(This account's own cloud computer: it keeps its files and installs between conversations";
  const size = memMb ? `${cpu ? `${cpu} vCPU, ` : ''}${memMb >= 1024 ? `${Math.round(memMb / 102.4) / 10} GiB` : `${memMb} MiB`} of memory. ` : '';
  return (
    `${opening}${home ? `; working folder ${home}` : ''}. ${size}` +
    'Full internet access; as_root: true for system packages. ' +
    (provider === 'e2b'
      ? 'After about four idle minutes it pauses and comes back as it was, the Python session and running programs included.)'
      : 'The Python session keeps its variables while the computer is awake — about fifteen idle minutes.)')
  );
}

/**
 * What the model is told it put in front of the person — the figures a cell
 * drew, the file it handed over. The person has the card itself, so the screen
 * leaves these out too.
 *
 * @param {{ name: string, id: string }[]} pictures
 */
export function figuresNote(pictures) {
  return `Showed the user ${pictures.length === 1 ? 'the figure' : `${pictures.length} figures`} in the conversation: ${pictures.map((p) => `${p.name} (id ${p.id})`).join(', ')}.`;
}

/**
 * A file left on the machine has no public link: one would wake the account's computer,
 * on its credit, for whoever holds the address. It used to be told publish_file would
 * make one, was refused as "uploaded", and told the owner a zip could not be handed
 * over at all (owner, 2026-11-08).
 *
 * @param {string} name @param {string} id @param {{ removed?: boolean, atPath?: string }} [options]
 */
export function handedNote(name, id, { removed = false, atPath = '' } = {}) {
  return (
    `Handed ${oneLine(name)} to the user — it is in the conversation to open and download. Its id is ${id}` +
    (atPath
      ? `. It stays on the cloud computer at ${oneLine(atPath)}, being too large to keep in the conversation: its download works as long as it stays there, and it cannot have a public link.`
      : '; publish_file with that id makes a link to share.') +
    (removed ? " It has been taken off the cloud computer, being in the conversation now: `bring` puts it back if it is needed." : '')
  );
}

/** An exit code that says more than a number, in words the model can act on. */
export function exitMeaning(code, memMb = 0) {
  if (code === 137) return `(exit 137: the command was killed, most often for running out of memory${memMb ? ` — this computer has ${memMb} MiB` : ''}. Work in smaller pieces, or say so.)`;
  if (code === 124) return '(exit 124: it ran past its time limit. timeout_seconds goes up to 300; start anything longer in the background.)';
  return '';
}

/**
 * Hand one file on the machine to the person.
 *
 * Any kind of file: a zip is as good an answer as a chart. Past what the conversation
 * can hold it stays on the machine and the person gets a link to it instead. Once
 * something is in the conversation it comes off the machine unless `keep` says not
 * to, so a disk does not fill with copies of what has already been handed over.
 *
 * Whatever goes wrong is said beside what the command printed. It used to be thrown,
 * and the whole answer was the one sentence about the file: the command had run, and
 * what it said about why it made no file was gone (owner, 2026-11-05, screenshot 5).
 *
 * @param {any} machine
 * @param {{ path: string, keep?: boolean, replaces?: string|null, userId: string, chatId?: string|null, signal?: AbortSignal }} request
 * @returns {Promise<{ file?: any, note: string, failed?: boolean }>}
 */
async function handOver(machine, { path, keep = false, replaces = null, userId, chatId, signal }) {
  const name = path.split('/').pop();
  const mime = mimeFor(name);
  const size = machine.fileSize ? await machine.fileSize(path, { signal }) : undefined;
  if (size === null) return { failed: true, note: await missingFileNote(machine, path, signal) };
  if (size !== undefined && size > FILE_LIMITS.maxBytes) {
    if (!machine.downloadUrl) return { failed: true, note: `${path} is ${Math.round(size / 1024 / 1024)} MB, too large to keep in the conversation, and this computer cannot give a link to it. Make it smaller or split it.` };
    const where = await keptAside(machine, path, signal);
    const saved = await saveMachineFile(userId, { name, mime, bytes: size, path: where, chatId });
    return { file: { id: saved.id, name: saved.name, mime: saved.mime, kind: saved.kind, bytes: saved.bytes }, note: handedNote(name, saved.id, { atPath: where }) };
  }
  const buffer = await machine.readFileToBuffer({ path, signal });
  if (!buffer) return { failed: true, note: await missingFileNote(machine, path, signal) };
  if (buffer.length > FILE_LIMITS.maxBytes) return { failed: true, note: `${path} is ${Math.round(buffer.length / 1024 / 1024)} MB, too large to keep in the conversation, and this computer cannot give a link to it. Make it smaller or split it.` };
  let saved;
  if (replaces) {
    const earlier = await getStore().getAttachment(userId, replaces);
    if (!earlier) return { failed: true, note: `${name} was not handed over: there is no file with the id ${replaces} on this account.` };
    const copy = earlier.origin === 'generated' ? earlier : (await getStore().findDerivedFile(userId, replaces)) || earlier;
    saved = await saveChangedFile(userId, copy, buffer, { chatId, name: copy.name });
  } else {
    saved = await saveGenerated(userId, {
      name,
      mime,
      kind: classify(name, mime),
      data: buffer.toString('base64'),
      // Made by a program, not written from words, so there is no source to revise.
      source: null,
      chatId,
    });
  }
  let removed = false;
  if (!keep) {
    const gone = await machine.runCommand({ ...shellFor('rm -f -- "$SYNZ_FILE"', { SYNZ_FILE: path }, { userBin: true }), timeoutMs: 10_000, signal }).catch(() => null);
    removed = gone?.exitCode === 0;
  }
  return { file: { id: saved.id, name: saved.name, mime: saved.mime, kind: saved.kind, bytes: saved.bytes }, note: handedNote(name, saved.id, { removed }) };
}

/**
 * Folders the disk tidy clears by itself: `/tmp` after twenty minutes, the copies
 * `bring` puts in `incoming/` after a day, and what the cloud browser downloaded
 * after a week.
 */
const CLEARED = /^(?:\/tmp\/|(?:\.\/|~\/|\/home\/[^/]+\/)?(?:incoming|downloads)\/)/;

/**
 * Where a file too large for the conversation is kept. Its card downloads it from the
 * machine for as long as it is there, so one in a folder the tidy clears is moved first
 * to `handed/` in the home, under a name of its own if that one is taken; otherwise the
 * card would point at nothing twenty minutes on (security review, 2026-11-09). The path
 * goes as a value, never as a command. A move that fails leaves it where it was.
 *
 * @param {any} machine @param {string} path @param {AbortSignal} [signal]
 */
export async function keptAside(machine, path, signal) {
  if (!CLEARED.test(path) || !machine.runCommand) return path;
  const script =
    'mkdir -p -- "$HOME/handed" && n="$(basename -- "$SYNZ_FILE")" && t="$HOME/handed/$n" && ' +
    '{ [ ! -e "$t" ] || t="$HOME/handed/$(date +%s)-$n"; } && mv -n -- "$SYNZ_FILE" "$t" && [ -e "$t" ] && printf "%s" "$t"';
  const moved = await machine.runCommand({ ...shellFor(script, { SYNZ_FILE: path }, { userBin: true }), timeoutMs: 30_000, signal }).catch(() => null);
  if (moved?.exitCode !== 0) return path;
  const to = String(await moved.stdout()).trim().split('\n').pop() || '';
  return to.startsWith('/') && !/[\r\n]/.test(to) ? to : path;
}

/** The file was not made, and what is in the folder it was expected in, which is usually why. */
async function missingFileNote(machine, path, signal) {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  const listing = await machine
    .runCommand({ ...shellFor('ls -la -- "$SYNZ_DIR" 2>&1 | head -40', { SYNZ_DIR: folder }, { userBin: true }), timeoutMs: 10_000, signal })
    .then((done) => done.stdout())
    .catch(() => '');
  return `${path} was not handed over: it does not exist on the computer, so the command above did not make it there.${listing ? `\nIn ${folder}:\n${String(listing).trim()}` : ''}`;
}

/**
 * Run one command, having written any files first, and hand back what it said
 * — plus, when asked, one file it made, saved into the conversation. Python for
 * the conversation's live session runs after the command, in the same folder.
 *
 * @param {{ command?: string, python?: string, python_reset?: boolean, files?: {path: string, content: string}[], download?: string, keep?: boolean, replaces?: string, bring?: string[], expose_port?: number, terminal?: any, checkpoint?: any, timeout_seconds?: number, as_root?: boolean }} input
 * @param {{ userId?: string, chatId?: string, signal?: AbortSignal, onProgress?: (text: string) => void }} [context]
 */
export async function runInSandbox(input, { userId, chatId, signal, onProgress } = {}) {
  const command = String(input?.command || '').trim();
  const python = typeof input?.python === 'string' ? input.python : '';
  const resetPython = input?.python_reset === true;
  const files = Array.isArray(input?.files) ? input.files : [];
  const download = input?.download ? workPath(input.download) : null;
  const bring = Array.isArray(input?.bring) ? input.bring.map(String).filter(Boolean) : [];
  const port = Number(input?.expose_port) || 0;
  const terminal = input?.terminal && typeof input.terminal === 'object' ? input.terminal : null;
  const checkpoint = input?.checkpoint && typeof input.checkpoint === 'object' ? input.checkpoint : null;
  if (!command && !python.trim() && !resetPython && !files.length && !download && !bring.length && !port && !terminal && !checkpoint) {
    throw new Error('Give a `command` to run, `python` for the live session, `files` to write, or a file to `download`.');
  }
  if (files.length > MAX_FILES_IN) throw new Error(`Write at most ${MAX_FILES_IN} files per call.`);
  if (bring.length > MAX_BRING) throw new Error(`Bring at most ${MAX_BRING} files per call.`);
  if (port && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new Error('expose_port is a port from 1024 to 65535.');
  // Before anything starts, so a mistyped action costs no machine.
  const terminalLine = terminal ? terminalScript(terminal) : null;

  const writes = files.map((f) => {
    const content = Buffer.from(String(f?.content ?? ''), 'utf8');
    if (content.length > MAX_FILE_IN_BYTES) throw new Error(`${f?.path} is over 2MB; write it in parts or generate it inside the machine.`);
    return { path: workPath(f?.path), content };
  });

  await chargeCloud(String(userId));
  const seconds = Math.min(300, Math.max(5, Number(input?.timeout_seconds) || COMMAND_MS / 1000));
  // Python alone goes straight to the machine's helper; the control API — a
  // shared, rate-limited thing — is only asked for what needs it.
  let machine = writes.length || command || download || bring.length || port || terminal || checkpoint ? await machineForUser(String(userId), { signal }) : null;

  const report = [];
  if (machine?.moved) {
    machine.moved = false;
    report.push("This account's cloud computer has just moved to a bigger one: its files came along, and what it had installed is being put back in the background.");
  }
  if (bring.length) report.push(await bringFiles(machine, bring, { userId: String(userId), signal }));
  if (writes.length) {
    await machine.writeFiles(writes, { signal });
    report.push(`Wrote ${writes.map((w) => w.path).join(', ')}.`);
  }
  if (checkpoint) {
    report.push(await useCheckpoint(machine, checkpoint));
    // A restore is another machine: whatever comes next in this call runs on that one.
    if (checkpoint.action === 'restore') machine = await machineForUser(String(userId), { signal });
  }

  if (command) {
    const started = Date.now();
    // No `cwd`: the session's own working folder, which is where relative
    // paths in `files` and `download` land too. Root only when asked for —
    // installing a system package — so ordinary work runs as the normal user.
    // As root, the shell keeps only folders root alone can write (SBX-004): the
    // account's branch would put E2B's account-writable /usr/local/bin first.
    const asRoot = !!input?.as_root;
    const done = await machine.runCommand({
      ...shellFor(command, {}, asRoot ? { root: true } : { userBin: true }),
      sudo: asRoot,
      timeoutMs: seconds * 1000,
      signal,
      ...(onProgress ? { onOutput: onProgress } : {}),
    });
    const [out, err] = await Promise.all([done.stdout(), done.stderr()]);
    const meaning = exitMeaning(done.exitCode, machine.memMb);
    report.push(
      `$ ${command.length > 300 ? `${command.slice(0, 300)}…` : command}`,
      `exit ${done.exitCode} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
      out ? `stdout:\n${clipOutput(out)}` : 'stdout: (empty)',
      ...(err ? [`stderr:\n${clipOutput(err)}`] : []),
      ...(meaning ? [meaning] : []),
    );
    // What a person added stays theirs: a new machine starts with it.
    if (done.exitCode === 0) await rememberPackages(String(userId), command, { asRoot }).catch(() => {});
  }

  if (terminalLine) {
    const done = await machine.runCommand({ ...shellFor(terminalLine, {}, { userBin: true }), timeoutMs: 60_000, signal });
    const [out, err] = await Promise.all([done.stdout(), done.stderr()]);
    const shown = String(out || '').trim();
    report.push(
      done.exitCode === 0
        ? `Terminal "${terminal.name || 'main'}":\n${shown ? clipOutput(shown) : '(nothing on its screen yet)'}`
        : `Terminal "${terminal.name || 'main'}" did not answer (exit ${done.exitCode}): ${clipOutput(String(err || out || 'it is not open; start it first.'))}`,
    );
  }

  /*
   * The live session. Its figures are pictures the person asked for, so they
   * are kept as the conversation's files — the first one drawn as the card,
   * the rest named so the model can refer to them.
   */
  const pictures = [];
  if (python.trim() || resetPython) {
    const { runPythonCell } = await import('./cloudBrowser/index.js');
    const cell = await runPythonCell(String(userId), { chatId, code: python, reset: resetPython, timeoutMs: seconds * 1000, signal });
    report.push(pythonReport(cell, !!python.trim()));
    const images = (Array.isArray(cell.images) ? cell.images : []).slice(0, 4);
    for (const [i, data] of images.entries()) {
      const saved = await saveGenerated(userId, { name: `figure-${i + 1}.png`, mime: 'image/png', kind: 'image', data, source: null, chatId });
      pictures.push({ id: saved.id, name: saved.name, mime: saved.mime, kind: saved.kind, bytes: saved.bytes });
    }
    if (pictures.length) report.push(figuresNote(pictures));
  }

  let file = null;
  let handOverFailed = false;
  if (download) {
    const handed = await handOver(machine, { path: download, keep: input?.keep === true, replaces: input?.replaces ? String(input.replaces) : null, userId: String(userId), chatId, signal });
    report.push(handed.note);
    file = handed.file || null;
    handOverFailed = !!handed.failed;
  }

  if (port) {
    const address = await portAddress(machine, port, { signal });
    report.push(`Port ${port} is reachable at ${address} by anyone with that address, while something is listening on it and the computer is awake. Give the person the address.`);
  }

  // The machine is awake anyway, so this costs next to nothing.
  if (machine) {
    const disk = await tidyIfDue(String(userId), machine, shellFor, { signal });
    if (disk) report.push(disk);
  }

  let home = '';
  try {
    home = machine?.currentSession?.()?.cwd || '';
  } catch {
    /* an older SDK without sessions; the note just omits the folder */
  }
  report.push(machineNote(home, { standIn: !!machine?.standIn, provider: machine?.provider || '', memMb: machine?.memMb || 0, cpu: machine?.cpu || 0 }));
  const shown = file || pictures[0] || null;
  return { content: report.join('\n'), ...(shown ? { file: shown } : {}), ...(handOverFailed ? { isError: true } : {}) };
}

/**
 * Files from the conversation, onto the machine, each under its own name: how a
 * program there gets at something the person attached. A file from the person's
 * Google Drive stays out (googleData.js): E2B is not somewhere Google's terms let
 * it go for work the person did not specifically ask to have done there.
 *
 * @param {any} machine
 * @param {string[]} ids
 * @param {{ userId: string, signal?: AbortSignal }} context
 */
async function bringFiles(machine, ids, { userId, signal }) {
  const store = getStore();
  const writes = [];
  for (const id of ids) {
    const row = await store.getAttachment(userId, id);
    if (!row) throw new Error(`There is no file with the id ${id} on this account.`);
    if (row.origin === 'google_drive') throw new Error(`${row.name} came from Google Drive, which stays off the cloud computer. Read it with read_file or look_at instead.`);
    if (!row.data) throw new Error(`${row.name} is on the cloud computer already, at ${row.source || 'its own path'}.`);
    writes.push({ path: workPath(`incoming/${String(row.name).replace(/[/\\]/g, '_')}`), content: Buffer.from(row.data, 'base64') });
  }
  await machine.writeFiles(writes, { signal });
  return `Put ${writes.map((w) => w.path).join(', ')} on the cloud computer.`;
}

/**
 * Save the machine as it is, list what was saved, or go back to it.
 *
 * @param {any} machine
 * @param {{ action?: string, id?: string, note?: string }} checkpoint
 */
async function useCheckpoint(machine, checkpoint) {
  if (!machine.saveCheckpoint) throw new Error('This computer cannot keep checkpoints.');
  const action = String(checkpoint.action || 'list');
  const when = (c) => new Date(c.at).toISOString().slice(0, 16).replace('T', ' ');
  if (action === 'save') {
    const made = await machine.saveCheckpoint(checkpoint.note);
    return `Saved a checkpoint of the computer, memory and disk: ${made.id}. checkpoint: {action: "restore", id} goes back to it.`;
  }
  if (action === 'restore') {
    const back = await machine.restoreCheckpoint(String(checkpoint.id || ''));
    return `The computer is back as it was at ${when(back)}: what changed since is gone. Other programs running then are running again.`;
  }
  if (action === 'list') {
    const kept = machine.listCheckpoints();
    return kept.length ? `Checkpoints kept:\n${kept.map((c) => `- ${c.id} (${when(c)})${c.note ? `: ${c.note}` : ''}`).join('\n')}` : 'No checkpoint has been saved.';
  }
  throw new Error('A checkpoint\'s action is save, list or restore.');
}

export const __testing = {
  SNAPSHOT_DAYS,
  /** A stand-in for @vercel/sandbox, so the suites can drive a start without a machine. */
  useSdk(fake) {
    sdk = fake;
  },
  /** E2B no longer set aside, so a suite can show one refusal after another. */
  clearE2bAside() {
    e2bAsideUntil = 0;
    e2bAsideFor = null;
  },
};
