import crypto from 'node:crypto';
import { classify, saveGenerated } from './attachments.js';

/**
 * A private Linux computer in the cloud, one per account.
 *
 * `run_command` runs on the person's own PC, through the worker — which is the
 * right place for their files and the wrong place for "work this out in
 * Python", and does not exist at all for somebody who never paired a machine.
 * This is the other half: a Vercel Sandbox, a Firecracker microVM with bash,
 * Python, Node, git, root and a 64 GB disk.
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
const DOWNLOAD_BYTES = 10 * 1024 * 1024;
const SNAPSHOT_DAYS = 30;

/**
 * Whether there is anything to start a sandbox with. On Vercel the platform
 * hands the function an OIDC token; elsewhere it takes a token, team and
 * project from the environment. Neither, and the tool is not offered at all —
 * a model that can see it would promise a computer it cannot have.
 */
export function sandboxConfigured(env = process.env) {
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

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
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
    signal,
  });
}

/**
 * Run one command, having written any files first, and hand back what it said
 * — plus, when asked, one file it made, saved into the conversation.
 *
 * @param {{ command?: string, files?: {path: string, content: string}[], download?: string, timeout_seconds?: number, as_root?: boolean }} input
 * @param {{ userId?: string, chatId?: string, signal?: AbortSignal }} [context]
 */
export async function runInSandbox(input, { userId, chatId, signal } = {}) {
  const command = String(input?.command || '').trim();
  const files = Array.isArray(input?.files) ? input.files : [];
  const download = input?.download ? workPath(input.download) : null;
  if (!command && !files.length && !download) {
    throw new Error('Give a `command` to run, `files` to write, or a file to `download`.');
  }
  if (files.length > MAX_FILES_IN) throw new Error(`Write at most ${MAX_FILES_IN} files per call.`);

  const writes = files.map((f) => {
    const content = Buffer.from(String(f?.content ?? ''), 'utf8');
    if (content.length > MAX_FILE_IN_BYTES) throw new Error(`${f?.path} is over 2MB; write it in parts or generate it inside the machine.`);
    return { path: workPath(f?.path), content };
  });

  let machine;
  try {
    machine = await machineFor(sandboxName(userId), { signal });
  } catch (err) {
    throw new Error(
      `The cloud computer could not be started: ${err?.message || err}. ` +
        'On Vercel this needs OIDC enabled for the project; elsewhere VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.',
    );
  }

  const report = [];
  if (writes.length) {
    await machine.writeFiles(writes, { signal });
    report.push(`Wrote ${writes.map((w) => w.path).join(', ')}.`);
  }

  if (command) {
    const seconds = Math.min(300, Math.max(5, Number(input?.timeout_seconds) || COMMAND_MS / 1000));
    const started = Date.now();
    // No `cwd`: the session's own working folder, which is where relative
    // paths in `files` and `download` land too. Root only when asked for —
    // installing a system package — so ordinary work runs as the normal user.
    const done = await machine.runCommand({
      cmd: 'bash',
      args: ['-lc', command],
      sudo: !!input?.as_root,
      timeoutMs: seconds * 1000,
      signal,
    });
    const [out, err] = await Promise.all([done.stdout(), done.stderr()]);
    report.push(
      `$ ${command.length > 300 ? `${command.slice(0, 300)}…` : command}`,
      `exit ${done.exitCode} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
      out ? `stdout:\n${clipOutput(out)}` : 'stdout: (empty)',
      ...(err ? [`stderr:\n${clipOutput(err)}`] : []),
    );
  }

  let file = null;
  if (download) {
    const buffer = await machine.readFileToBuffer({ path: download }, { signal });
    if (!buffer) throw new Error(`${download} does not exist in the machine — check the path with \`ls\`.`);
    if (buffer.length > DOWNLOAD_BYTES) throw new Error(`${download} is over 10MB, too large to hand over.`);
    const name = download.split('/').pop();
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    if (!classify(name, mime)) {
      throw new Error(`${name} is not a kind of file the conversation can show (PDF, image, Office, text, CSV, JSON). Convert it first.`);
    }
    const saved = await saveGenerated(userId, {
      name,
      mime,
      kind: classify(name, mime),
      data: buffer.toString('base64'),
      // Made by a program, not written from words, so there is no source to revise.
      source: null,
      chatId,
    });
    file = { id: saved.id, name: saved.name, mime: saved.mime, kind: saved.kind, bytes: saved.bytes };
    report.push(
      `Handed ${name} to the user — it is in the conversation to open and download. ` +
        `Its id is ${saved.id}; publish_file with that id makes a link to share.`,
    );
  }

  let home = '';
  try {
    home = machine.currentSession?.()?.cwd || '';
  } catch {
    /* an older SDK without sessions; the note just omits the folder */
  }
  report.push(
    `(This account's own cloud computer: it keeps its files and installs between conversations${home ? `; working folder ${home}` : ''}. ` +
      'Full internet access; as_root: true for system packages.)',
  );
  return { content: report.join('\n'), ...(file ? { file } : {}) };
}

export const __testing = { SNAPSHOT_DAYS };
