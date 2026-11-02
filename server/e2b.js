import path from 'node:path';
import { getStore } from './store/index.js';
import { allowance, spend } from './freeTier.js';

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
 * **Paused, not stopped.** A machine idle for ten minutes pauses — memory and
 * disk both kept, kept for as long as anyone likes, and not billed — so the
 * next call finds the Python session's variables and the browser's open pages
 * where they were, which a Vercel machine resting cannot do.
 *
 * **Root, then the account (HAR-001).** E2B starts every command as
 * `/bin/bash -l -c`, a login shell: run as the account, it would read the
 * account's own ~/.bash_profile and ~/.profile first — files one command talked
 * into it by a web page can write — ahead of every command after, the helper
 * starts with their keys among them. So every command is sent as root, whose
 * login files only root can change, and an ordinary one drops to the account
 * with `setpriv` before it starts, through `bash --noprofile --norc` as on
 * Vercel. Root itself (`as_root`) is asked about first, every time (assessRisk).
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
/** Awake this long after the last thing asked of it, then paused. */
const IDLE_MS = 10 * 60 * 1000;
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
/** What a machine is assumed to be until it says — the larger guess, so a first start never pays too little. */
const ASSUMED = { cpu: 2, memMb: 2048 };
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

/** The template machines are made from: the owner's own (npm run e2b:template), or E2B's base. */
const template = () => String(process.env.E2B_TEMPLATE || '').trim() || 'base';
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
 *
 * @param {{ cpu: number, memMb: number, paidUntil?: number }} paid
 * @param {number} until
 */
async function payUntil(paid, until) {
  const from = Math.max(Date.now(), Number(paid.paidUntil) || 0);
  if (until <= from) return;
  const cost = priceOf(paid, from, until);
  const { left } = await allowance('e2b');
  if (cost > left) throw new E2BOutOfCredit();
  await spend('e2b', cost);
  paid.paidUntil = until;
}

/** A word as one shell argument. */
const quote = (word) => `'${String(word).replace(/'/g, `'\\''`)}'`;

/**
 * The line E2B's root login shell is given for one command: the program as
 * root, or dropped to the account first; under `timeout` when it has a limit,
 * so a command past its time stops inside the machine rather than running on
 * unseen. Exported for the probe and the suite.
 *
 * @param {{ cmd: string, args?: string[], sudo?: boolean, seconds?: number }} command
 */
export function commandLine({ cmd, args = [], sudo = false, seconds = 0 }) {
  const program = [cmd, ...args].map(quote).join(' ');
  const limit = seconds > 0 ? `timeout -k 5 ${Math.ceil(seconds)} ` : '';
  if (sudo) return `exec ${limit}${program}`;
  return (
    `exec ${limit}setpriv --reuid="$(id -u ${ACCOUNT})" --regid="$(id -g ${ACCOUNT})" --init-groups ` +
    `env HOME=${HOME} USER=${ACCOUNT} LOGNAME=${ACCOUNT} ${program}`
  );
}

/** A path on the machine: relative ones from the account's home, as the Vercel machine reads them from its working folder. */
const onMachine = (file) => {
  const raw = String(file || '').replace(/\\/g, '/');
  return raw.startsWith('/') ? raw : path.posix.join(HOME, raw);
};

/**
 * An E2B sandbox, in the shape the rest of the app drives a Vercel one.
 *
 * @param {any} box  the SDK's Sandbox
 * @param {{ userId?: string, record?: any }} [owner]  the account and its record; none for a scratch machine
 */
function machine(box, { userId, record } = {}) {
  return {
    provider: 'e2b',
    sandboxId: box.sandboxId,

    /** @param {{ cmd: string, args?: string[], env?: Record<string, string>, sudo?: boolean, detached?: boolean, timeoutMs?: number, signal?: AbortSignal }} command */
    async runCommand({ cmd, args = [], env = {}, sudo = false, detached = false, timeoutMs, signal } = /** @type {any} */ ({})) {
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
      let done;
      try {
        // Fifteen seconds over the limit inside the machine, so `timeout` speaks first.
        done = await box.commands.run(commandLine({ cmd, args, sudo, seconds: limitMs / 1000 }), { ...base, timeoutMs: limitMs + 15_000 });
      } catch (err) {
        // A failing command is an exit code, as on Vercel, not a thrown error.
        if (!exited(err)) throw err;
        done = err;
      }
      const stdout = String(done.stdout ?? '');
      const stderr = String(done.stderr ?? '');
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

    /** @param {{ path: string }} file */
    async readFileToBuffer({ path: file }) {
      try {
        return Buffer.from(await box.files.read(onMachine(file), { format: 'bytes' }));
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    /** @param {number} port */
    domain(port) {
      return `https://${box.getHost(port)}`;
    },

    // Every port of an E2B machine is reachable already.
    async update() {},

    /** Awake for `ms` from now, paid for first. @param {number} ms */
    async extendTimeout(ms) {
      if (record) {
        await payUntil(record, Date.now() + ms);
        await getStore().setUserSetting(userId, SETTING, record);
      }
      await box.setTimeout(ms);
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
  await payUntil(record, Date.now() + IDLE_MS);
  try {
    const box = await Sandbox.connect(record.id, { ...connection(), timeoutMs: IDLE_MS });
    await getStore().setUserSetting(userId, SETTING, record);
    return machine(box, { userId, record });
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function open(userId, name) {
  const { Sandbox } = await loadSdk();
  const known = await readRecord(userId);
  if (known) {
    const resumed = await resume(Sandbox, userId, known);
    if (resumed) return resumed;
  }
  // No record, or one for a machine that is gone: one made by another instance may be there under the name.
  const [existing] = await byName(Sandbox, name);
  if (existing) {
    const resumed = await resume(Sandbox, userId, { ...ASSUMED, ...(known?.id === existing.sandboxId ? known : {}), id: existing.sandboxId, paidUntil: known?.paidUntil });
    if (resumed) return resumed;
  }

  const record = { ...ASSUMED, id: '', paidUntil: known?.paidUntil };
  await payUntil(record, Date.now() + IDLE_MS);
  let box = await Sandbox.create(template(), {
    ...connection(),
    timeoutMs: IDLE_MS,
    metadata: { app: 'synapsez', machine: name },
    lifecycle: { onTimeout: 'pause', autoResume: false },
    network: NETWORK,
  });
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
  await getStore().setUserSetting(userId, SETTING, record);
  return machine(box, { userId, record });
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

/** A machine for one job and nobody's, killed when its time is up — paid for whole, first. */
export async function e2bScratch() {
  const { Sandbox } = await loadSdk();
  await payUntil({ ...ASSUMED }, Date.now() + SCRATCH_MS);
  const box = await Sandbox.create(template(), { ...connection(), timeoutMs: SCRATCH_MS, metadata: { app: 'synapsez', role: 'mcp-check' }, network: NETWORK });
  return machine(box);
}

export const __testing = {
  SETTING,
  /** A stand-in for the `e2b` SDK, so the suites can drive a machine without one. */
  useSdk(fake) {
    sdk = fake;
  },
  loadSdk,
};
