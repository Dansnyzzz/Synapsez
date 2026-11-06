import path from 'node:path';
import { getStore } from './store/index.js';
import { allowance, spend, refund, e2bAccountAllowance, e2bAccountSpend } from './freeTier.js';
import { log } from './util/trace.js';

/**
 * The account's cloud computer on E2B (owner, 2026-11-02) — the first place one
 * is started; Vercel Sandbox stands in when E2B cannot (server/sandbox.js).
 *
 * What the rest of the app needs of a machine is a handful of calls, shaped by
 * the Vercel SDK it was written against: `runCommand`, `writeFiles`,
 * `readFileToBuffer`, `domain`, `extendTimeout` and the like. This file gives an
 * E2B sandbox exactly those, so `sandbox_run`, the Python session, the cloud
 * browser and the MCP bridge run on it unchanged.
 *
 * **Paused, not stopped.** A machine idle for four minutes pauses — memory and
 * disk both kept, kept for as long as anyone likes, and not billed — so the
 * next call finds the Python session's variables and the browser's open pages
 * where they were, which a Vercel machine resting cannot do.
 *
 * **Root, then the account (HAR-001).** The SDK starts every command as
 * `/bin/bash -l -c`, a login shell: run as the account, it would read the
 * account's own ~/.bash_profile and ~/.profile first — files one command talked
 * into it by a web page can write — ahead of every command after, the helper
 * starts with their keys among them. So every command is sent as root, and an
 * ordinary one drops to the account with `setpriv` before it starts, through
 * `bash --noprofile --norc` as on Vercel. Root's own login is not read either
 * (`withoutLoginShell`), and a machine is closed when the app first meets it
 * (`CLOSE_MACHINE`). Root itself (`as_root`) is asked about first, every time
 * (assessRisk).
 *
 * **Paid for before it runs.** E2B bills a machine for every second it is
 * awake, used or not, and the credit is one-off. Each start, resume or
 * extension pays from the month's allowance (freeTier.js `e2b`) for the time
 * it keeps the machine awake; a machine pauses exactly when that time is up, so
 * what is counted is what E2B charges. An allowance that cannot cover it is
 * `E2BOutOfCredit`, and the work goes to the Vercel machine instead.
 */

const SETTING = 'e2bMachine';
const HOME = '/home/user';
const ACCOUNT = 'user';
/**
 * Awake this long after the last thing asked of it, then paused.
 *
 * Paid for whether it is used or not, so this is most of what a short command
 * costs, and the credit is shared. Pausing keeps everything and coming back takes a
 * second, so waiting longer buys little (E2B: about 4 s a GiB to pause, 1 s to resume).
 */
const IDLE_MS = 4 * 60 * 1000;
/** How much past a long command's own limit a machine is kept awake, to hand back what it printed. */
const AWAKE_MARGIN_MS = 30_000;
/** A machine for one MCP check (mcp/cloud.js), deleted after — never paused. */
const SCRATCH_MS = 6 * 60 * 1000;
/** How long a detached start is watched for an early exit; the program itself runs on. */
const WATCH_MS = 10 * 60 * 1000;
/**
 * E2B's prices (docs.e2b.dev/faq/calculate-sandbox-price, 2026-11-02), in
 * thousandths of a dollar a second: $0.000014 a vCPU, $0.0000045 a GiB.
 */
const VCPU_MILLS = 0.014;
const GIB_MILLS = 0.0045;
const TEMPLATE_SIZE_CPU = 2;
const TEMPLATE_SIZE_MEM = 2048;
/** What a machine is assumed to be until it says — the larger guess, so a first start never pays too little. */
const ASSUMED = { cpu: TEMPLATE_SIZE_CPU, memMb: TEMPLATE_SIZE_MEM };
/**
 * A machine's ports open to the person's browser (owner's choice, 2026-11-02).
 * E2B makes them private by default — a request without the
 * `e2b-traffic-access-token` header is refused (live probe, 2026-11-02) — and
 * a browser cannot add a header to the cloud browser's socket or its picture
 * stream. What listens on them checks its own key and short-lived tokens
 * (cloudBrowser/service.mjs `tokenScope`, mcp/bridge.mjs), exactly as on
 * Vercel, whose machine addresses are public too.
 */
const NETWORK = { allowPublicTraffic: true };

/** The month's E2B allowance cannot pay for the time a machine would be awake. */
export class E2BOutOfCredit extends Error {
  constructor() {
    super('The cloud computer has used this month\'s share of its credit.');
    this.name = 'E2BOutOfCredit';
  }
}

/**
 * The SDK itself could not be loaded on this server (SBX-002). Nothing E2B said:
 * no machine can start here until the deployment changes, so the work goes to
 * Vercel, and the reason stays in the server's log rather than in the chat.
 */
export class E2BSdkError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super('The E2B library could not be loaded on this server.', { cause });
    this.name = 'E2BSdkError';
  }
}

/** Whether there is a key to start an E2B machine with. */
export function e2bConfigured(env = process.env) {
  return !!String(env.E2B_API_KEY || '').trim();
}

/**
 * The template machines are made from (npm run e2b:template).
 *
 * Named here rather than left to an environment variable. It was asked for in
 * E2B_TEMPLATE, and a deployment without it made machines from E2B's `base`, 512
 * MiB, where Chromium cannot start: every cloud browser call failed, for everybody,
 * for as long as nobody set a setting (owner's screenshots, 2026-11-05).
 */
export const TEMPLATE_NAME = 'synapsez-computer';
/**
 * The size that template is built at. Two gibibytes is what Chromium and a pandas
 * frame together fit in; there is swap on the disk behind it (`CLOSE_MACHINE`).
 */
export const TEMPLATE_SIZE = { cpu: TEMPLATE_SIZE_CPU, memMb: TEMPLATE_SIZE_MEM };
/** Raise it when the template changes: machines made from an older build move to the new one, keeping their files. */
export const BASE_VERSION = 2;
/** After E2B says the template is not there, how long before asking again: `base` works meanwhile. */
const TEMPLATE_RECHECK_MS = 10 * 60_000;
/** Moving to a newer machine: how long each half may take, the most it carries, how long before another try. */
const MOVE_STEP_MS = 120_000;
const MOVE_MAX_BYTES = 3 * 1024 * 1024 * 1024;
const MOVE_RETRY_MS = 60 * 60_000;
/** A few, each a whole machine's memory and disk on E2B's side. */
const MAX_CHECKPOINTS = 3;
let templateMissingAt = 0;
const template = () => {
  const named = String(process.env.E2B_TEMPLATE || '').trim() || TEMPLATE_NAME;
  return named !== 'base' && Date.now() - templateMissingAt < TEMPLATE_RECHECK_MS ? 'base' : named;
};
/**
 * One pip, the one for the Python a command finds first (owner, 2026-11-05).
 *
 * On the PATH a command gets, `python3` is /usr/bin's and `pip` was /usr/local/bin's,
 * which belongs to the image's other Python: pip reported a package installed under
 * /usr/local/lib/python3.11/site-packages, which /usr/bin/python3 never reads, so
 * `requests` said "No module named 'certifi'" with certifi right there in `pip list`.
 * Nothing the account can write: /usr/bin is root's.
 */
export const ONE_PIP = [
  "/usr/bin/printf '#!/bin/sh\\nexec /usr/bin/python3 -m pip \"$@\"\\n' > /usr/bin/pip",
  '/usr/bin/cp /usr/bin/pip /usr/bin/pip3',
  '/usr/bin/chmod 755 /usr/bin/pip /usr/bin/pip3',
  "/usr/bin/printf '[global]\\nbreak-system-packages = true\\nno-cache-dir = true\\n' > /etc/pip.conf",
  '/usr/bin/chmod 644 /etc/pip.conf',
].join(' && ');
const connection = () => ({ apiKey: process.env.E2B_API_KEY });

/**
 * The SDK's ES module build, named outright (SBX-001).
 *
 * `e2b` has no `exports` map, so a bare `import('e2b')` follows `main` to the
 * CommonJS build, and that build require()s chalk 5, which is ES-only. That
 * works only where Node can require() an ES module; Vercel's runtime could not,
 * and every command on the cloud computer failed while loading the SDK. The
 * `.mjs` build imports chalk instead, which works on every runtime.
 *
 * Loaded on first use (most requests never start a machine), and written as a
 * literal so Vercel's file tracer finds the file to ship.
 */
let sdk = null;
async function loadSdk() {
  if (!sdk) {
    try {
      sdk = await import('e2b/dist/index.mjs');
    } catch (err) {
      throw new E2BSdkError(err);
    }
  }
  return sdk;
}

/**
 * Why E2B cannot take this work, if that is what an error says — `credit`,
 * `busy` (its twenty machines are running), `auth`, `down`, or `broken` (its
 * library would not load here) — and null for an error that would follow the
 * work anywhere: a command that failed, a bad path.
 *
 * @param {any} err
 * @returns {'credit' | 'busy' | 'auth' | 'down' | 'broken' | null}
 */
export function e2bUnavailable(err) {
  if (!err) return null;
  const name = String(err.name || '');
  if (name === 'CommandExitError') return null;
  if (name === 'E2BSdkError') return 'broken';
  const status = Number(err.statusCode || err.status || 0);
  const raw = String(err.message || err);
  if (name === 'E2BOutOfCredit' || status === 402) return 'credit';
  /*
   * Busy and down first, whatever their words: "credit spent" closes E2B for the
   * rest of the month (`exhaust`), and a 429 that happens to say "quota" about
   * running machines must not do that.
   */
  if (name === 'RateLimitError' || status === 429) return 'busy';
  if (name === 'ServiceBusyError' || name === 'TimeoutError' || status >= 500) return 'down';
  if (/credit|billing|payment|insufficient (funds|balance|credit)|out of funds/i.test(raw)) return 'credit';
  if (name === 'AuthenticationError' || status === 401 || status === 403) return 'auth';
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(raw)) return 'down';
  return null;
}

const notFound = (err) => /NotFound/.test(String(err?.name || '')) || Number(err?.statusCode) === 404;
const exited = (err) => err?.name === 'CommandExitError';

/** Thousandths of a dollar for keeping a machine of this size awake from `from` to `until`. */
const priceOf = (size, from, until) => Math.ceil(((until - from) / 1000) * (size.cpu * VCPU_MILLS + (size.memMb / 1024) * GIB_MILLS));

/**
 * Pay for keeping a machine awake until `until`, from where it was last paid
 * to. Time already paid for is not paid again. Mutates `paid.paidUntil`.
 * An account's machine is paid from its share of the month too (HAR-007); a
 * scratch machine, which belongs to nobody, from the pool alone.
 *
 * @param {{ cpu: number, memMb: number, paidUntil?: number }} paid
 * @param {number} until
 * @param {string} [userId]
 */
async function payUntil(paid, until, userId) {
  const from = Math.max(Date.now(), Number(paid.paidUntil) || 0);
  if (until <= from) return null;
  const cost = priceOf(paid, from, until);
  const { left } = await allowance('e2b');
  if (cost > left) throw new E2BOutOfCredit();
  if (userId && cost > (await e2bAccountAllowance(userId)).left) throw new E2BOutOfCredit();
  await spend('e2b', cost);
  if (userId) await e2bAccountSpend(userId, cost);
  const before = paid.paidUntil;
  paid.paidUntil = until;
  return { cost, before, userId };
}

/**
 * What `payUntil` took for a start that then did not happen, given back
 * (HAR-010): with E2B's machines all busy, each failed start cost ten minutes
 * of the month's credit, and a few hundred closed E2B for the month.
 *
 * @param {{ paidUntil?: number }} paid
 * @param {{ cost: number, before?: number, userId?: string } | null} receipt
 */
async function giveBack(paid, receipt) {
  if (!receipt) return;
  paid.paidUntil = receipt.before;
  await refund('e2b', receipt.cost);
  if (receipt.userId) await e2bAccountSpend(receipt.userId, -receipt.cost);
}

// The most of a command's output, and of a file, this server takes in (SBX-005).
// The model sees 16k of output (sandbox.js `clipOutput`); a file past 32 MB is
// past what every caller keeps anyway.
const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const READ_CAP_BYTES = 32 * 1024 * 1024;

/** A word as one shell argument. */
const quote = (word) => `'${String(word).replace(/'/g, `'\\''`)}'`;

/**
 * Where root finds a program it runs as root (SBX-004): folders only root can
 * write. Until a machine is closed (`CLOSE_MACHINE`), `/usr/local` is writable by
 * the account whatever the template set (live probe, 2026-11-02), and the usual
 * root PATH starts there — so a bare `id` or `timeout` in the line below would be
 * whatever the account last put in `/usr/local/sbin`, run as root before every
 * later command.
 */
const ROOT_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The line E2B's root shell is given for one command: the program as
 * root, or dropped to the account first; under `timeout` when it has a limit,
 * so a command past its time stops inside the machine rather than running on
 * unseen. Everything root starts is named by its full path, and a program run
 * as root is looked up on `ROOT_PATH`. So is the account's shell (SBX-008): on
 * the PATH it came with, a `bash` the account left in /usr/local/bin ran ahead of
 * every later command — and `id`, which /etc/profile calls before it sets a PATH
 * — which is what starting with no login files is for (HAR-001). Exported for
 * the probe and the suite.
 *
 * @param {{ cmd: string, args?: string[], sudo?: boolean, seconds?: number }} command
 */
export function commandLine({ cmd, args = [], sudo = false, seconds = 0 }) {
  const program = [cmd, ...args].map(quote).join(' ');
  const limit = seconds > 0 ? `/usr/bin/timeout -k 5 ${Math.ceil(seconds)} ` : '';
  if (sudo) return `exec ${limit}/usr/bin/env PATH=${ROOT_PATH} ${program}`;
  return (
    `exec ${limit}/usr/bin/setpriv --reuid="$(/usr/bin/id -u ${ACCOUNT})" --regid="$(/usr/bin/id -g ${ACCOUNT})" --init-groups ` +
    `/usr/bin/env PATH=${ROOT_PATH} HOME=${HOME} USER=${ACCOUNT} LOGNAME=${ACCOUNT} ${program}`
  );
}

/** A path on the machine: relative ones from the account's home, as the Vercel machine reads them from its working folder. */
const onMachine = (file) => {
  const raw = String(file || '').replace(/\\/g, '/');
  return raw.startsWith('/') ? raw : path.posix.join(HOME, raw);
};

const NO_LOGIN_SHELL = Symbol('synz.noLoginShell');

/**
 * Commands on this machine start without a login shell (SBX-008).
 *
 * The SDK starts every command as `/bin/bash -l -c …`, and every command here
 * goes as root (see `commandLine`) — so root's login ran /etc/profile, which
 * calls `id` by name, and /root/.profile, which calls `mesg`, on a PATH that
 * begins in /usr/local, which E2B leaves writable by everyone. A program an
 * ordinary command put at /usr/local/bin/id ran as root on the next command,
 * any command, with whatever key was in its environment (live, 2026-11-03).
 * The SDK builds that line itself and hands it to `commands.rpc.start`, so the
 * call is rewritten there to `--noprofile --norc`; `commandLine` names every
 * program by its full path and needs no profile. A SDK that no longer has that
 * seam is said in the log, and fails the suite (test/e2b.test.mjs).
 *
 * @param {any} box  the SDK's Sandbox
 * @returns {boolean} whether commands now start without a login shell
 */
export function withoutLoginShell(box) {
  const rpc = box?.commands?.rpc;
  if (!rpc || typeof rpc.start !== 'function') {
    log.warn('e2b: commands still start in a login shell — the SDK changed');
    return false;
  }
  if (rpc[NO_LOGIN_SHELL]) return true;
  const start = rpc.start.bind(rpc);
  rpc.start = (request, options) => {
    const proc = request?.process;
    const args = proc?.args;
    if (proc?.cmd === '/bin/bash' && Array.isArray(args) && args.length === 3 && args[0] === '-l' && args[1] === '-c') {
      return start({ ...request, process: { ...proc, args: ['--noprofile', '--norc', '-c', args[2]] } }, options);
    }
    return start(request, options);
  };
  rpc[NO_LOGIN_SHELL] = true;
  return true;
}

/**
 * What is closed on a machine when the app first meets it (SBX-011).
 *
 * E2B makes every file under /usr/local mode 777 on a running machine, whatever
 * a template set, and gives the account `sudo` with no password. /usr/local is
 * where root's Perl, Python and dynamic linker read from: a module or a library
 * left there by an ordinary command ran as root at the next `apt-get`, and a
 * grading of the words of a command cannot see `s''udo`. So on a running
 * machine, before any command of the account's: /usr/local is root's alone, the
 * account has no sudo (root is `as_root`, which goes through `user: 'root'` and
 * asks the person first), and /etc/inittab, also left open, is closed.
 *
 * What the account's commands find stays as it was: its PATH keeps the system
 * first, so /usr/bin/python3 with its libraries still comes before the other
 * python3 in /usr/local/bin, which being closed would otherwise have put first;
 * and `npm install -g` goes to ~/.local, which is on that PATH — last, so a
 * newer `npm` installed that way does not shadow the image's, and the MCP
 * bridge, which runs without that folder, finds such a program only by `npx`.
 *
 * Holds through a pause and a resume (live, 2026-11-03). Takes about two seconds.
 * A program left in /usr/local before this is not found out: this closes the door
 * on what comes next.
 *
 * Two things are opened here too, both root's to do and neither anything the account
 * could turn against root. One pip (`ONE_PIP`), for a machine from `base`, whose
 * /usr/bin Python may have none, in which case nothing changes. And two gibibytes of
 * swap on the disk (live, 2026-11-06), so a job that goes just past the memory slows
 * down rather than being killed. Neither may stop the rest being closed.
 */
const CLOSE_MACHINE = [
  '/usr/bin/chown -hR root:root /usr/local',
  '/usr/bin/chmod -R go-w /usr/local',
  '{ [ ! -e /etc/inittab ] || /usr/bin/chmod go-w /etc/inittab; }',
  `/usr/bin/sed -i '/^${ACCOUNT}[[:space:]].*NOPASSWD/d' /etc/sudoers`,
  `{ /usr/bin/gpasswd -d ${ACCOUNT} sudo >/dev/null 2>&1 || true; }`,
  `/usr/bin/sed -i 's|PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"|PATH="/usr/bin:/bin:/usr/games:/usr/local/bin:/usr/local/games"|' /etc/profile`,
  '/usr/bin/mkdir -p /usr/local/etc',
  // For npm to read: ${HOME} is npm's own, and is the home of whoever runs it.
  "/usr/bin/printf '%s\\n' 'prefix=${HOME}/.local' > /usr/local/etc/npmrc",
  `{ /usr/bin/python3 -m pip --version >/dev/null 2>&1 && ${ONE_PIP}; true; }`,
  '{ [ -e /swapfile ] || { /usr/bin/fallocate -l 2G /swapfile && /usr/bin/chmod 600 /swapfile && /usr/sbin/mkswap /swapfile >/dev/null; }; /usr/sbin/swapon /swapfile 2>/dev/null; true; }',
].join(' && ');

/**
 * Close a machine, once: the record remembers, and one that could not be closed
 * is tried again the next time it is opened. Never blocks the machine from being
 * used — a failure here leaves it as E2B made it, which is said in the log.
 *
 * @param {any} box  the SDK's Sandbox
 * @param {Record<string, any> | null} [record]  the account's record, where `closed` is kept; none for a scratch machine
 */
async function closeMachine(box, record = null) {
  if (record?.closed) return;
  // Before anything runs as root on it: see `withoutLoginShell`.
  withoutLoginShell(box);
  try {
    await box.commands.run(CLOSE_MACHINE, { user: 'root', timeoutMs: 60_000 });
    if (record) record.closed = true;
  } catch (err) {
    log.warn('e2b: machine not closed', { error: String(err?.message || err).slice(0, 160) });
  }
}

/**
 * An E2B sandbox, in the shape the rest of the app drives a Vercel one.
 *
 * @param {any} box  the SDK's Sandbox
 * @param {{ userId?: string, record?: any }} [owner]  the account and its record; none for a scratch machine
 */
function machine(box, { userId, record } = {}) {
  /** Awake for `ms` from now, paid for first. Only ever longer: a browser session may have asked for more. */
  const stayAwake = async (ms) => {
    if (record) {
      if (Number(record.paidUntil) >= Date.now() + ms) return;
      await payUntil(record, Date.now() + ms, userId);
      await getStore().setUserSetting(userId, SETTING, record);
    }
    await box.setTimeout(ms);
  };
  withoutLoginShell(box);
  return {
    provider: 'e2b',
    sandboxId: box.sandboxId,
    /** Its memory, so what will not fit is said at once rather than after a long wait. */
    memMb: Number(record?.memMb) || 0,
    cpu: Number(record?.cpu) || 0,

    /** @param {{ cmd: string, args?: string[], env?: Record<string, string>, sudo?: boolean, detached?: boolean, timeoutMs?: number, signal?: AbortSignal, onOutput?: (text: string) => void }} command */
    async runCommand({ cmd, args = [], env = {}, sudo = false, detached = false, timeoutMs, signal, onOutput } = /** @type {any} */ ({})) {
      const base = { user: 'root', cwd: HOME, envs: env, signal };
      if (detached) {
        const handle = await box.commands.run(commandLine({ cmd, args, sudo }), { ...base, background: true, timeoutMs: WATCH_MS });
        return {
          // Its end, as an exit code; losing sight of it (the watch timing out) is not its end.
          async wait() {
            try {
              return { exitCode: (await handle.wait()).exitCode };
            } catch (err) {
              if (exited(err)) return { exitCode: err.exitCode };
              throw err;
            }
          },
        };
      }
      const limitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 120_000;
      // A machine pauses sooner than the longest command runs, and nothing is idle about one running.
      if (record && limitMs + AWAKE_MARGIN_MS > IDLE_MS) await stayAwake(limitMs + AWAKE_MARGIN_MS);
      /*
       * Watched as it comes (SBX-005): the SDK keeps all of stdout in one
       * string, so `cat /dev/urandom | base64` grew it in this server's memory
       * until the instance fell over, taking other accounts' requests with it.
       * Past the ceiling the command is stopped, and what came is cut with a note.
       */
      let seen = 0;
      let flooded = false;
      /** @type {any} */
      let handle = null;
      const watch = (data) => {
        onOutput?.(String(data ?? ''));
        seen += Buffer.byteLength(String(data ?? ''));
        if (seen > OUTPUT_CAP_BYTES && !flooded) {
          flooded = true;
          handle?.kill().catch(() => {});
        }
      };
      let done;
      try {
        // Fifteen seconds over the limit inside the machine, so `timeout` speaks first.
        handle = await box.commands.run(commandLine({ cmd, args, sudo, seconds: limitMs / 1000 }), {
          ...base,
          background: true,
          timeoutMs: limitMs + 15_000,
          onStdout: watch,
          onStderr: watch,
        });
        if (flooded) handle.kill().catch(() => {});
        done = await handle.wait();
      } catch (err) {
        // A failing command is an exit code, as on Vercel, not a thrown error.
        if (!exited(err)) throw err;
        done = err;
      }
      const capped = (text) =>
        flooded && text.length > OUTPUT_CAP_BYTES ? `${text.slice(0, OUTPUT_CAP_BYTES)}\n[output passed ${OUTPUT_CAP_BYTES / 1024 / 1024} MB, so the command was stopped]` : text;
      const stdout = capped(String(done.stdout ?? ''));
      const stderr = capped(String(done.stderr ?? ''));
      return { exitCode: done.exitCode, stdout: async () => stdout, stderr: async () => stderr };
    },

    /** @param {{ path: string, content: Buffer }[]} files */
    async writeFiles(files) {
      await box.files.write(
        files.map((f) => ({
          path: onMachine(f.path),
          data: f.content.buffer.slice(f.content.byteOffset, f.content.byteOffset + f.content.byteLength),
        })),
      );
    },

    /**
     * A file on the machine, or null when there is none. Its size is asked
     * first (SBX-005): a read takes the whole file into this server's memory,
     * and a download of several gigabytes would have been read before any
     * check could see it. The caller's deadline goes with the read.
     *
     * @param {{ path: string, signal?: AbortSignal }} file
     */
    async readFileToBuffer({ path: file, signal }) {
      const where = onMachine(file);
      try {
        const info = await box.files.getInfo(where, { signal });
        if (Number(info?.size) > READ_CAP_BYTES) {
          throw new Error(`${file} is too large to read here (${Math.round(Number(info.size) / 1024 / 1024)} MB; the most is ${READ_CAP_BYTES / 1024 / 1024} MB).`);
        }
        return Buffer.from(await box.files.read(where, { format: 'bytes', signal }));
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    /**
     * A file's size, or null when there is none: asked before reading, so a file
     * too large to bring here can be handed over by link instead.
     *
     * @param {string} file
     * @param {{ signal?: AbortSignal }} [options]
     */
    async fileSize(file, { signal } = {}) {
      try {
        return Number((await box.files.getInfo(onMachine(file), { signal }))?.size) || 0;
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    /**
     * A signed address a file can be fetched from directly, from the machine, past
     * this server's size limits. Good while the machine is awake.
     *
     * @param {string} file
     * @param {number} [seconds]
     */
    async downloadUrl(file, seconds = 600) {
      return box.downloadUrl(onMachine(file), { useSignatureExpiration: seconds, user: ACCOUNT });
    },

    /** Where a browser may put one file for a while, signed for that path and this account alone. */
    async uploadUrl(file, seconds = 900) {
      return box.uploadUrl(onMachine(file), { useSignatureExpiration: seconds, user: ACCOUNT });
    },

    /**
     * Keep the machine as it is now, memory and all, to come back to. The oldest of
     * more than a few goes, so a person cannot fill a store nobody sees.
     *
     * @param {string} note
     */
    async saveCheckpoint(note) {
      if (!record) throw new Error('This machine is nobody\'s, so it keeps no checkpoints.');
      const made = await box.createSnapshot();
      const entry = { id: made.snapshotId, note: String(note || '').slice(0, 120), at: Date.now() };
      const kept = [...(Array.isArray(record.checkpoints) ? record.checkpoints : []), entry];
      const { Sandbox } = await loadSdk();
      while (kept.length > MAX_CHECKPOINTS) await Sandbox.deleteSnapshot(kept.shift().id, connection()).catch(() => {});
      record.checkpoints = kept;
      await getStore().setUserSetting(userId, SETTING, record);
      return entry;
    },

    listCheckpoints() {
      return Array.isArray(record?.checkpoints) ? record.checkpoints : [];
    },

    /**
     * Back to a checkpoint: a new machine from it, under this one's name, and this
     * one gone. Paid for like any start.
     *
     * @param {string} id
     */
    async restoreCheckpoint(id) {
      const wanted = this.listCheckpoints().find((c) => c.id === id);
      if (!wanted) throw new Error(`There is no checkpoint ${id} on this computer.`);
      const { Sandbox } = await loadSdk();
      const next = await Sandbox.create(id, { ...connection(), timeoutMs: IDLE_MS, metadata: box.metadata || { app: 'synapsez', machine: record.name }, lifecycle: { onTimeout: 'pause', autoResume: false }, network: NETWORK });
      await box.kill().catch(() => {});
      record.id = next.sandboxId;
      await getStore().setUserSetting(userId, SETTING, record);
      return wanted;
    },

    /** @param {number} port */
    domain(port) {
      return `https://${box.getHost(port)}`;
    },

    // Every port of an E2B machine is reachable already.
    async update() {},

    /** Awake for `ms` from now, paid for first. @param {number} ms */
    async extendTimeout(ms) {
      await stayAwake(ms);
    },

    currentSession() {
      return { cwd: HOME };
    },

    async stop() {
      await box.pause();
    },

    async delete() {
      await box.kill();
    },

    /** The SDK's own sandbox, for moving what is on it to a newer machine. */
    box,
  };
}

/** Every machine made for this name, oldest first. */
async function byName(Sandbox, name) {
  const pages = Sandbox.list({ ...connection(), query: { metadata: { machine: name } } });
  const found = [...(await pages.nextItems())];
  while (pages.hasNext) found.push(...(await pages.nextItems()));
  return found.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
}

async function readRecord(userId) {
  const value = await getStore().getUserSetting(userId, SETTING);
  return value && typeof value === 'object' && value.id ? value : null;
}

/** Resume a machine by id, paid for first; null when it no longer exists. */
async function resume(Sandbox, userId, record) {
  const receipt = await payUntil(record, Date.now() + IDLE_MS, userId);
  let box;
  try {
    box = await Sandbox.connect(record.id, { ...connection(), timeoutMs: IDLE_MS });
  } catch (err) {
    await giveBack(record, receipt);
    if (notFound(err)) return null;
    throw err;
  }
  await closeMachine(box, record);
  await getStore().setUserSetting(userId, SETTING, record);
  return machine(box, { userId, record });
}

/**
 * A new machine from the template. E2B not knowing the template is no reason to go
 * without a machine: `base` works for everything but what needs more room, and it
 * is asked for again a few minutes later.
 *
 * @param {any} Sandbox
 * @param {string} name
 * @returns {Promise<{ box: any, base: number }>}
 */
async function makeBox(Sandbox, name) {
  const from = template();
  try {
    const box = await Sandbox.create(from, {
      ...connection(),
      timeoutMs: IDLE_MS,
      metadata: { app: 'synapsez', machine: name },
      lifecycle: { onTimeout: 'pause', autoResume: false },
      network: NETWORK,
    });
    return { box, base: from === 'base' ? 0 : BASE_VERSION };
  } catch (err) {
    if (from === 'base' || !(notFound(err) || /template[^\n]*not found|not found[^\n]*template/i.test(String(err?.message)))) throw err;
    templateMissingAt = Date.now();
    log.warn('e2b: the template is not there, so this machine is from base', { template: from });
    return makeBox(Sandbox, name);
  }
}

/** Whether this machine is from an older template than the one machines are made from now. */
const shouldMove = (record, now = Date.now()) =>
  (Number(record?.base) || 0) < BASE_VERSION && template() !== 'base' && now - (Number(record?.moveTriedAt) || 0) > MOVE_RETRY_MS;

/**
 * Move an account to a machine made from the current template, files and all.
 *
 * A machine's memory is fixed when it is made, and one made from E2B's `base` has
 * 512 MiB for as long as it exists, however it is resumed: the owner's own stayed at
 * 473 MiB, where Chromium cannot start. So making a better template helps nobody who
 * already has a machine until they are brought across.
 *
 * What moves is the account's home, packed and unpacked as the account: nothing of
 * root's is involved, so nothing in it gets to do anything with root's hands. System
 * packages it installed come back from the list kept for that (machineCare.js). The
 * browser's sign-ins, which are root's, do not move; there are none on a machine too
 * small to have started a browser.
 *
 * All or nothing: anything going wrong leaves the old machine exactly as it was,
 * still in use, and it is tried again later.
 *
 * @param {any} Sandbox
 * @param {string} userId
 * @param {string} name
 * @param {any} record
 * @param {any} old  the machine as `machine()` makes it
 * @returns {Promise<any|null>} the new machine, or null when it stayed where it was
 */
async function moveMachine(Sandbox, userId, name, record, old) {
  /** @type {any} */
  const next = { ...ASSUMED, id: '', paidUntil: record.paidUntil, checkpoints: record.checkpoints };
  let receipt = null;
  /** @type {any} */
  let box = null;
  const file = `/tmp/synz-move-${old.sandboxId}.tgz`;
  try {
    const packed = await old.runCommand({
      cmd: 'bash',
      args: ['--noprofile', '--norc', '-c', `umask 077; tar czf ${file} --warning=no-file-changed --exclude=./.cache --exclude=./.npm -C ${HOME} . ; [ $? -le 1 ]`],
      timeoutMs: MOVE_STEP_MS,
    });
    if (packed.exitCode !== 0) throw new Error(`packing ended with ${packed.exitCode}`);
    const size = await old.fileSize(file);
    if (!size || size > MOVE_MAX_BYTES) throw new Error(`the home folder packs to ${size} bytes`);

    receipt = await payUntil(next, Date.now() + IDLE_MS, userId);
    const made = await makeBox(Sandbox, name);
    box = made.box;
    // The template not being there is no reason to move: the new machine would be no bigger.
    if (!made.base) throw new Error('the template is not there');
    next.base = made.base;
    next.id = box.sandboxId;
    const info = await box.getInfo().catch(() => null);
    if (Number(info?.cpuCount) > 0) next.cpu = Number(info.cpuCount);
    if (Number(info?.memoryMB) > 0) next.memMb = Number(info.memoryMB);
    await closeMachine(box, next);
    const arrived = machine(box, { userId, record: next });
    const unpacked = await arrived.runCommand({
      cmd: 'bash',
      args: ['--noprofile', '--norc', '-c', `curl -fsS --max-time ${Math.floor(MOVE_STEP_MS / 1000) - 5} "$SYNZ_FROM" | tar xzf - -C ${HOME}`],
      env: { SYNZ_FROM: await old.downloadUrl(file) },
      timeoutMs: MOVE_STEP_MS,
    });
    if (unpacked.exitCode !== 0) throw new Error(`unpacking ended with ${unpacked.exitCode}`);

    await getStore().setUserSetting(userId, SETTING, next);
    await old.box.kill().catch(() => {});
    log.info('cloud computer: moved to the current template', { bytes: size, memMb: next.memMb });
    arrived.fresh = true;
    arrived.moved = true;
    return arrived;
  } catch (err) {
    log.warn('cloud computer: not moved, staying on the old machine', { error: String(err?.message || err).slice(0, 200) });
    if (box) await box.kill().catch(() => {});
    await giveBack(next, receipt);
    record.moveTriedAt = Date.now();
    await getStore().setUserSetting(userId, SETTING, record).catch(() => {});
    old.runCommand({ cmd: 'rm', args: ['-f', file], timeoutMs: 10_000 }).catch(() => {});
    return null;
  }
}

async function open(userId, name) {
  const { Sandbox } = await loadSdk();
  const known = await readRecord(userId);
  if (known) {
    const resumed = await resume(Sandbox, userId, known);
    if (resumed) {
      if (!shouldMove(known)) return resumed;
      return (await moveMachine(Sandbox, userId, name, known, resumed)) || resumed;
    }
  }
  // No record, or one for a machine that is gone: one made by another instance may be there under the name.
  const [existing] = await byName(Sandbox, name);
  if (existing) {
    const found = { ...ASSUMED, ...(known?.id === existing.sandboxId ? known : {}), id: existing.sandboxId, paidUntil: known?.paidUntil };
    const resumed = await resume(Sandbox, userId, found);
    if (resumed) {
      if (!shouldMove(found)) return resumed;
      return (await moveMachine(Sandbox, userId, name, found, resumed)) || resumed;
    }
  }

  /** @type {any} */
  const record = { ...ASSUMED, id: '', paidUntil: known?.paidUntil };
  const receipt = await payUntil(record, Date.now() + IDLE_MS, userId);
  /** @type {any} */
  let box;
  try {
    const made = await makeBox(Sandbox, name);
    box = made.box;
    record.base = made.base;
  } catch (err) {
    await giveBack(record, receipt);
    throw err;
  }
  /*
   * Two instances making this account's machine at once each find none and make
   * one. Whichever was made first is the account's; a later one is killed at once,
   * before anything is put on it.
   */
  const [oldest] = await byName(Sandbox, name).catch(() => []);
  if (oldest && oldest.sandboxId !== box.sandboxId) {
    await box.kill().catch(() => {});
    box = await Sandbox.connect(oldest.sandboxId, { ...connection(), timeoutMs: IDLE_MS });
  }
  record.id = box.sandboxId;
  try {
    const info = await box.getInfo();
    if (Number(info?.cpuCount) > 0) record.cpu = Number(info.cpuCount);
    if (Number(info?.memoryMB) > 0) record.memMb = Number(info.memoryMB);
  } catch {
    /* priced at the larger guess until it says */
  }
  await closeMachine(box, record);
  await getStore().setUserSetting(userId, SETTING, record);
  const made = machine(box, { userId, record });
  // A machine with nothing of this account's on it yet: see sandbox.js `machineForUser`.
  made.fresh = true;
  return made;
}

/** Starts in progress on this instance, by account, so parallel calls share one. */
const starting = new Map();

/**
 * The account's E2B machine, resumed or made, and paid for until it next
 * pauses. Throws `E2BOutOfCredit` when the month's allowance cannot pay, and
 * the SDK's own errors otherwise (see `e2bUnavailable`).
 *
 * @param {string} userId
 * @param {string} name  the account's machine name (sandbox.js `sandboxName`)
 */
export async function e2bMachineFor(userId, name) {
  if (!starting.has(userId)) starting.set(userId, open(userId, name).finally(() => starting.delete(userId)));
  return starting.get(userId);
}

/** The account's machine if it has one, resumed. Never makes one: for what is only tidying up. */
export async function e2bExistingMachine(userId) {
  const known = await readRecord(userId);
  if (!known?.id) return null;
  const { Sandbox } = await loadSdk();
  return resume(Sandbox, userId, known);
}

/** An account's machine and its checkpoints, gone with the account: E2B keeps a paused one for ever. */
export async function e2bForgetAccount(userId) {
  const known = await readRecord(userId);
  if (!known) return;
  const { Sandbox } = await loadSdk();
  if (known.id) await Sandbox.kill(known.id, connection()).catch((err) => log.warn('cloud computer: not deleted with its account', { error: String(err?.message || err).slice(0, 160) }));
  for (const checkpoint of Array.isArray(known.checkpoints) ? known.checkpoints : []) {
    await Sandbox.deleteSnapshot(checkpoint.id, connection()).catch(() => {});
  }
}

/**
 * A machine for one job and nobody's, killed when its time is up — paid for whole, first.
 *
 * @param {{ ms?: number, userId?: string, internet?: boolean, role?: string }} [options]
 *   `userId`: whose share pays for it, for a job somebody asked for.
 *   `internet: false`: for a stranger's file, which then has nowhere to call.
 */
export async function e2bScratch({ ms = SCRATCH_MS, userId, internet = true, role = 'mcp-check' } = {}) {
  const { Sandbox } = await loadSdk();
  await payUntil({ ...ASSUMED }, Date.now() + ms, userId);
  const options = { ...connection(), timeoutMs: ms, metadata: { app: 'synapsez', role }, network: NETWORK, ...(internet ? {} : { allowInternetAccess: false }) };
  /** @type {any} */
  let box;
  try {
    box = await Sandbox.create(template(), options);
  } catch (err) {
    if (template() === 'base' || !(notFound(err) || /template[^\n]*not found|not found[^\n]*template/i.test(String(err?.message)))) throw err;
    templateMissingAt = Date.now();
    box = await Sandbox.create('base', options);
  }
  await closeMachine(box);
  return machine(box);
}

export const __testing = {
  SETTING,
  CLOSE_MACHINE,
  /** E2B asked about the template again on the next start. */
  forgetMissingTemplate() {
    templateMissingAt = 0;
  },
  /** A stand-in for the `e2b` SDK, so the suites can drive a machine without one. */
  useSdk(fake) {
    sdk = fake;
  },
  loadSdk,
};
