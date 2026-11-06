import { getStore } from './store/index.js';
import { log } from './util/trace.js';

/**
 * Looking after an account's cloud computer between jobs (owner, 2026-11-05):
 * what it installed comes back on a new machine, what it no longer needs goes, and
 * a terminal stays open between calls. server/sandbox.js drives these.
 *
 * Kept out of that file because none of it is about running one command, and out of
 * server/e2b.js because it is the same on either kind of machine.
 */

const SETTING = 'machinePackages';
const MAX_PER_KIND = 40;

const PIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?(?:(?:==|>=|<=|~=)[A-Za-z0-9.*+!_-]+)?$/;
const APT_NAME = /^[a-z0-9][a-z0-9+.-]+$/;
const NPM_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._^~-]+)?$/;
const PIP_INSTALL = /^(?:sudo\s+)?(?:(?:\/usr\/bin\/)?python3?\s+-m\s+)?pip3?\s+install\s+(.+)$/;
const APT_INSTALL = /^(?:sudo\s+)?(?:\w+=\S+\s+)*apt(?:-get)?\s+(?:-\S+\s+)*install\s+(.+)$/;
const NPM_INSTALL = /^(?:sudo\s+)?npm\s+(?:install|i|add)\s+(.+)$/;

/**
 * The packages one command line installs, by what installs them.
 *
 * Only plain names: a name is what gets replayed later without anybody looking,
 * so a URL, a path or a requirements file, which say what they install somewhere
 * else, are left out rather than remembered.
 *
 * @param {string} command
 * @returns {{ pip: string[], apt: string[], npm: string[] }}
 */
export function packagesIn(command) {
  const found = { pip: /** @type {string[]} */ ([]), apt: /** @type {string[]} */ ([]), npm: /** @type {string[]} */ ([]) };
  // Cut at a pipe and at a redirect too: what follows them is another program, or a file.
  for (const raw of String(command || '').split(/&&|\|\||;|\n|\|/)) {
    const part = raw.trim().replace(/^!/, '').replace(/\s*\d?[<>].*$/, '');
    const words = (text) => text.trim().split(/\s+/).filter(Boolean);
    let match = PIP_INSTALL.exec(part);
    if (match) {
      for (const word of words(match[1])) {
        if (/^-(r|e|t|c)$|^--(requirement|editable|target|constraint|index-url|extra-index-url|find-links)\b/.test(word)) break;
        if (!word.startsWith('-') && PIP_NAME.test(word)) found.pip.push(word);
      }
      continue;
    }
    match = APT_INSTALL.exec(part);
    if (match) {
      for (const word of words(match[1])) if (!word.startsWith('-') && APT_NAME.test(word)) found.apt.push(word);
      continue;
    }
    match = NPM_INSTALL.exec(part);
    if (match && /(?:^|\s)(?:-g|--global)(?:\s|$)/.test(match[1])) {
      for (const word of words(match[1])) if (!word.startsWith('-') && NPM_NAME.test(word)) found.npm.push(word);
    }
  }
  return found;
}

/** What this account has installed so far, with anything that does not read as a name left out. */
async function readPackages(userId) {
  const saved = await getStore().getUserSetting(userId, SETTING).catch(() => null);
  const list = (values, pattern) => (Array.isArray(values) ? values.filter((v) => typeof v === 'string' && pattern.test(v)) : []);
  return { pip: list(saved?.pip, PIP_NAME), apt: list(saved?.apt, APT_NAME), npm: list(saved?.npm, NPM_NAME) };
}

/**
 * Remember what a command that worked installed. A person's own set of tools is
 * theirs; a new machine, when one has to be made, starts with them.
 *
 * System packages only from a command that ran as root, the one way they really install:
 * they go back as root on the next machine, and `apt-get install x; true` exits 0 without it.
 *
 * @param {string} userId
 * @param {string} command
 * @param {{ asRoot?: boolean }} [options]
 */
export async function rememberPackages(userId, command, { asRoot = false } = {}) {
  const found = packagesIn(command);
  if (!asRoot) found.apt = [];
  if (!found.pip.length && !found.apt.length && !found.npm.length) return;
  const known = await readPackages(userId);
  let changed = false;
  for (const kind of /** @type {('pip'|'apt'|'npm')[]} */ (['pip', 'apt', 'npm'])) {
    for (const name of found[kind]) {
      if (known[kind].includes(name) || known[kind].length >= MAX_PER_KIND) continue;
      known[kind].push(name);
      changed = true;
    }
  }
  if (changed) await getStore().setUserSetting(userId, SETTING, known).catch(() => {});
}

/**
 * Start putting an account's packages on a machine just made. In the background,
 * with what it says in a log: nobody should wait for it, and a package that no
 * longer exists must not stop the rest. Names only, each checked as it was saved
 * and again as it is read here, so nothing here is more than a word on a line.
 *
 * @param {string} userId
 * @param {any} machine
 * @param {(command: string, env?: Record<string, string>, options?: any) => any} shellFor
 * @returns {Promise<number>} how many packages are being put back
 */
export async function restorePackages(userId, machine, shellFor) {
  const { pip, apt, npm } = await readPackages(userId);
  const steps = [];
  // One at a time: a name that no longer exists must not take the others with it.
  for (const name of pip) steps.push(`/usr/bin/python3 -m pip install --user --break-system-packages -q ${name}`);
  for (const name of npm) steps.push(`npm install -g --no-audit --no-fund --loglevel=error ${name}`);
  try {
    if (steps.length) {
      await machine.runCommand({ ...shellFor(`(${steps.join('; ')}) > /tmp/synz-restore.log 2>&1`, {}, { userBin: true }), detached: true });
    }
    if (apt.length) {
      await machine.runCommand({
        ...shellFor(`(apt-get update -q; ${apt.map((name) => `apt-get install -y -q --no-install-recommends ${name}`).join('; ')}) > /tmp/synz-restore-root.log 2>&1`, {}, { root: true }),
        sudo: true,
        detached: true,
      });
    }
  } catch (err) {
    log.warn('cloud computer: packages not restored', { error: String(err?.message || err).slice(0, 160) });
    return 0;
  }
  return pip.length + npm.length + apt.length;
}

/**
 * What goes without anybody asking: caches that come back by themselves, and the
 * account's own scraps in /tmp once nothing has touched them for a while. Nothing
 * under the working folder a person could have meant to keep. The last line says
 * how full the disk is.
 */
export const TIDY_SCRIPT = [
  'cd "$HOME" 2>/dev/null || exit 0',
  'rm -rf .cache/pip .cache/uv .npm/_cacache .npm/_logs .pytest_cache 2>/dev/null',
  "find . -type d \\( -name __pycache__ -o -name .ipynb_checkpoints -o -name .pytest_cache \\) -not -path './.local/*' -prune -exec rm -rf {} + 2>/dev/null",
  "find . -maxdepth 3 -type f \\( -name 'core' -o -name 'core.[0-9]*' \\) -delete 2>/dev/null",
  "find /tmp -mindepth 1 -maxdepth 1 -user \"$(id -un)\" -mmin +20 ! -name 'synz*' ! -name '.*' -exec rm -rf {} + 2>/dev/null",
  // What was sent straight here and left a month. Its row says the file is gone, in those words.
  'find uploads -type f -mtime +30 -delete 2>/dev/null; find uploads -mindepth 1 -type d -empty -delete 2>/dev/null',
  "df -P \"$HOME\" 2>/dev/null | awk 'NR==2 { print $5 }'",
].join('\n');

const TIDY_EVERY_MS = 5 * 60_000;
/** The disk past which the model is told, so it can put away what it no longer needs. */
const DISK_WARN_PERCENT = 80;
/** @type {Map<string, number>} */
const lastTidied = new Map();

/**
 * Tidy this account's machine if it has not been for a while, the machine being
 * awake anyway. Never fails the command it follows.
 *
 * @param {string} userId
 * @param {any} machine
 * @param {(command: string, env?: Record<string, string>, options?: any) => any} shellFor
 * @param {{ signal?: AbortSignal, now?: number }} [options]
 * @returns {Promise<string>} a sentence for the model when the disk is getting full, else nothing
 */
export async function tidyIfDue(userId, machine, shellFor, { signal, now = Date.now() } = {}) {
  if (now - (lastTidied.get(userId) || 0) < TIDY_EVERY_MS) return '';
  lastTidied.set(userId, now);
  if (lastTidied.size > 2000) lastTidied.delete(lastTidied.keys().next().value);
  try {
    const done = await machine.runCommand({ ...shellFor(TIDY_SCRIPT, {}, { userBin: true }), timeoutMs: 20_000, signal });
    const percent = parseInt(String(await done.stdout()).trim(), 10);
    return percent >= DISK_WARN_PERCENT ? `The cloud computer's disk is ${percent}% full: delete what is no longer needed.` : '';
  } catch {
    return '';
  }
}

const SPECIAL_KEY = /^(?:C-[a-z]|M-[a-z]|Enter|Tab|BTab|Escape|Up|Down|Left|Right|BSpace|DC|PageUp|PageDown|Home|End|Space|F(?:[1-9]|1[0-2]))$/;
/** A word as one shell argument. */
const quoted = (word) => `'${String(word).replace(/'/g, `'\\''`)}'`;

/**
 * A terminal that stays open between calls, for what expects to be typed at: a REPL,
 * an installer asking questions, top, vim.
 *
 * Through tmux rather than a pseudo-terminal held open by this server, which ends
 * with the request that opened it: every call here is a new one, and tmux keeps the
 * session on the machine, through a pause as well, and draws the screen as text.
 *
 * @param {{ action?: string, name?: string, text?: string, keys?: string[], wait_seconds?: number }} terminal
 * @returns {string} the shell line
 */
export function terminalScript(terminal) {
  const action = String(terminal?.action || 'read');
  const name = String(terminal?.name || 'main');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error('A terminal\'s name is letters, digits, - and _.');
  const missing = "command -v tmux >/dev/null 2>&1 || { echo 'tmux is not installed on this computer: as_root, apt-get install -y tmux.'; exit 127; }";
  const session = quoted(name);
  const wait = Math.min(30, Math.max(0, Number(terminal?.wait_seconds ?? 1) || 0));
  // The screen and what scrolled off it, without the blank rows under the last line.
  const screen = `sleep ${wait}; tmux capture-pane -t ${session} -p -S -300 2>/dev/null | sed -e :a -e '/^\\n*$/{$d;N;ba' -e '}'`;
  const typed = String(terminal?.text ?? '');
  const type = typed ? `tmux send-keys -t ${session} -l -- ${quoted(typed)} && tmux send-keys -t ${session} Enter` : '';
  switch (action) {
    case 'start':
      return [missing, `tmux has-session -t ${session} 2>/dev/null || tmux new-session -d -s ${session} -x 120 -y 40`, type, screen].filter(Boolean).join('\n');
    case 'send':
      if (!typed) throw new Error('Say what to type, in `text`.');
      return [missing, `tmux has-session -t ${session} || exit 1`, type, screen].join('\n');
    case 'keys': {
      const keys = Array.isArray(terminal?.keys) ? terminal.keys.map(String) : [];
      if (!keys.length || !keys.every((key) => SPECIAL_KEY.test(key))) {
        throw new Error('`keys` names special keys, such as C-c, Enter, Up, Tab or Escape.');
      }
      return [missing, `tmux has-session -t ${session} || exit 1`, `tmux send-keys -t ${session} ${keys.join(' ')}`, screen].join('\n');
    }
    case 'read':
      return [missing, `tmux has-session -t ${session} || exit 1`, screen].join('\n');
    case 'list':
      return [missing, "tmux list-sessions 2>/dev/null || echo 'No terminal is open.'"].join('\n');
    case 'stop':
      return [missing, `tmux kill-session -t ${session}`, `echo ${quoted(`Closed the terminal ${name}.`)}`].join('\n');
    default:
      throw new Error('A terminal\'s action is start, send, keys, read, list or stop.');
  }
}

export const __testing = {
  /** Tidy on the next call, whenever the last one was. */
  reset() {
    lastTidied.clear();
  },
};
