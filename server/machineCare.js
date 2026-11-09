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
 * Browsers Playwright downloads (owner, 2026-11-08: "Playwright cache was lost when the
 * machine changed"). Not a package: they go to a folder of their own, ~/.cache/ms-playwright
 * unless PLAYWRIGHT_BROWSERS_PATH says otherwise, which a move leaves behind (e2b.js packs
 * the home without .cache) and a new machine never had. So the install itself is
 * remembered, by launcher and browser names, and run again.
 */
const PLAYWRIGHT_BROWSERS = [
  'chromium', 'chromium-headless-shell', 'chromium-tip-of-tree', 'chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary',
  'msedge', 'msedge-beta', 'msedge-dev', 'msedge-canary', 'firefox', 'firefox-beta', 'webkit', 'ffmpeg',
];
const PLAYWRIGHT_FLAGS = ['--with-deps', '--only-shell', '--no-shell'];
const PLAYWRIGHT_VERSION = '[A-Za-z0-9][A-Za-z0-9.-]*';
const PLAYWRIGHT_INSTALL = new RegExp(
  `^(?:sudo\\s+)?(?:\\w+=\\S+\\s+)*(?:(?:/usr/bin/)?python3?\\s+-m\\s+(playwright)|npx\\s+(?:(?:-y|--yes)\\s+)?(playwright(?:@${PLAYWRIGHT_VERSION})?)|(playwright))` +
    '\\s+(install-deps|install)(?=\\s|$)(.*)$',
);
/** A remembered line, as written by `playwrightLine` and nothing else: checked again when read. */
const PLAYWRIGHT_LINE = new RegExp(
  `^(?:root )?(?:python|playwright|npx(?:@${PLAYWRIGHT_VERSION})?) (?:install|install-deps)` +
    `(?: (?:${PLAYWRIGHT_FLAGS.join('|')}))*(?: (?:${PLAYWRIGHT_BROWSERS.join('|')}))*$`,
);

/**
 * One Playwright install, as the line to remember: launcher, what it installs, browser
 * names. Nothing it does not know: a word that is not a browser's name keeps the whole
 * line out, rather than replaying "install everything" in its place.
 *
 * @param {string} part
 * @returns {string|null}
 */
function playwrightLine(part) {
  const match = PLAYWRIGHT_INSTALL.exec(part);
  if (!match) return null;
  const [, viaPython, viaNpx, , action, tail] = match;
  const flags = [];
  const browsers = [];
  for (const word of String(tail).trim().split(/\s+/).filter(Boolean)) {
    // Asked what it would do, or for help: nothing was installed.
    if (/^(?:--dry-run|--list|-h|--help)$/.test(word)) return null;
    if (PLAYWRIGHT_FLAGS.includes(word)) {
      if (!flags.includes(word)) flags.push(word);
    } else if (word.startsWith('-')) {
      // --force and the like: a replay is about having the browser, not fetching it again.
      continue;
    } else if (PLAYWRIGHT_BROWSERS.includes(word)) {
      if (!browsers.includes(word)) browsers.push(word);
    } else {
      return null;
    }
  }
  const launcher = viaPython ? 'python' : viaNpx ? `npx${viaNpx.slice('playwright'.length)}` : 'playwright';
  return [launcher, action, ...flags, ...browsers].join(' ');
}

/**
 * A remembered Playwright line as the command that runs it again.
 *
 * As root, never npx and never from the home: npx reads the project around the folder it
 * starts in, and the home is the account's, so a package.json or node_modules there would
 * decide what root runs (security review, 2026-11-09). Root runs the system's own
 * Playwright from `/`, Python isolated (`-I`: no user site, no environment, no folder on the
 * path), whatever launcher the line was first run with.
 *
 * @param {string} line @param {{ root?: boolean }} [options]
 */
function playwrightCommand(line, { root = false } = {}) {
  const [launcher, ...rest] = line.split(' ');
  if (root) return `cd / && /usr/bin/python3 -I -m playwright ${rest.join(' ')}`;
  const program = launcher === 'python' ? '/usr/bin/python3 -m playwright' : launcher === 'playwright' ? 'playwright' : `npx --yes playwright${launcher.slice(3)}`;
  return `${program} ${rest.join(' ')}`;
}

/**
 * The packages one command line installs, by what installs them.
 *
 * Only plain names: a name is what gets replayed later without anybody looking,
 * so a URL, a path or a requirements file, which say what they install somewhere
 * else, are left out rather than remembered.
 *
 * @param {string} command
 * @returns {{ pip: string[], apt: string[], npm: string[], playwright: string[] }}
 */
export function packagesIn(command) {
  const found = {
    pip: /** @type {string[]} */ ([]),
    apt: /** @type {string[]} */ ([]),
    npm: /** @type {string[]} */ ([]),
    playwright: /** @type {string[]} */ ([]),
  };
  // Cut at a pipe and at a redirect too: what follows them is another program, or a file.
  for (const raw of String(command || '').split(/&&|\|\||;|\n|\|/)) {
    const part = raw.trim().replace(/^!/, '').replace(/\s*\d?[<>].*$/, '');
    const words = (text) => text.trim().split(/\s+/).filter(Boolean);
    const browsers = playwrightLine(part);
    if (browsers) {
      found.playwright.push(browsers);
      continue;
    }
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
  return {
    pip: list(saved?.pip, PIP_NAME),
    apt: list(saved?.apt, APT_NAME),
    npm: list(saved?.npm, NPM_NAME),
    playwright: list(saved?.playwright, PLAYWRIGHT_LINE),
  };
}

/**
 * Remember what a command that worked installed. A person's own set of tools is
 * theirs; a new machine, when one has to be made, starts with them.
 *
 * System packages only from a command that ran as root, the one way they really install:
 * they go back as root on the next machine, and `apt-get install x; true` exits 0 without it.
 * A Playwright install goes back as whoever ran it, and its system libraries
 * (`--with-deps`, `install-deps`) only as root, for the same reason.
 *
 * @param {string} userId
 * @param {string} command
 * @param {{ asRoot?: boolean }} [options]
 */
export async function rememberPackages(userId, command, { asRoot = false } = {}) {
  const found = packagesIn(command);
  if (!asRoot) found.apt = [];
  found.playwright = asRoot
    ? found.playwright.map((line) => `root ${line}`)
    : found.playwright.filter((line) => !/^\S+ install-deps/.test(line)).map((line) => line.replace(/ --with-deps/g, ''));
  if (!found.pip.length && !found.apt.length && !found.npm.length && !found.playwright.length) return;
  const known = await readPackages(userId);
  let changed = false;
  for (const kind of /** @type {('pip'|'apt'|'npm'|'playwright')[]} */ (['pip', 'apt', 'npm', 'playwright'])) {
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
 * Browsers last, after the pip and npm packages: the Playwright that fetches them may
 * be one of those. Through the same shell as the command that first ran them, so they
 * land where that command's did; on the template (scripts/e2b-template.mjs) Chromium
 * is already in /opt/ms-playwright, and the line finds it there and has nothing to do.
 *
 * @returns {Promise<number>} how many packages are being put back
 */
export async function restorePackages(userId, machine, shellFor) {
  const { pip, apt, npm, playwright } = await readPackages(userId);
  const steps = [];
  // One at a time: a name that no longer exists must not take the others with it.
  for (const name of pip) steps.push(`/usr/bin/python3 -m pip install --user --break-system-packages -q ${name}`);
  for (const name of npm) steps.push(`npm install -g --no-audit --no-fund --loglevel=error ${name}`);
  for (const line of playwright) if (!line.startsWith('root ')) steps.push(playwrightCommand(line));
  const rootSteps = [
    ...(apt.length ? ['apt-get update -q', ...apt.map((name) => `apt-get install -y -q --no-install-recommends ${name}`)] : []),
    ...playwright.filter((line) => line.startsWith('root ')).map((line) => playwrightCommand(line.slice('root '.length), { root: true })),
  ];
  try {
    if (steps.length) {
      await machine.runCommand({ ...shellFor(`(${steps.join('; ')}) > /tmp/synz-restore.log 2>&1`, {}, { userBin: true }), detached: true });
    }
    if (rootSteps.length) {
      await machine.runCommand({
        ...shellFor(`(${rootSteps.join('; ')}) > /tmp/synz-restore-root.log 2>&1`, {}, { root: true }),
        sudo: true,
        detached: true,
      });
    }
  } catch (err) {
    log.warn('cloud computer: packages not restored', { error: String(err?.message || err).slice(0, 160) });
    return 0;
  }
  return pip.length + npm.length + apt.length + playwright.length;
}

/**
 * A disk that looks after itself (owner, 2026-11-08: "auto detect, adaptive, real-time").
 *
 * How full it is is read after every command, which costs one `df`. The tidy itself
 * runs when it is due, or at once when the disk has gone into a fuller tier than the
 * last tidy was for:
 *
 *   below 70%   caches that come back by themselves, `__pycache__`, core dumps, the
 *               account's own scraps in /tmp after twenty minutes, uploads/ after a month;
 *   70–85%      also the rest of ~/.cache and ~/.npm and a project's build caches
 *               (node_modules/.cache, .next/cache, .parcel-cache), a file once nothing has
 *               read or written it for a day; logs over 10 MB cut to their last megabyte;
 *               incoming/ copies after a day, downloads/ after a week;
 *   above 85%   also those caches whatever their age, and large files in /tmp; then the
 *               largest things left in the home folder go to the model, which decides.
 *
 * Nothing else in the working folder is touched: what a person or the model made stays.
 * Never Playwright's or Puppeteer's browsers, which nothing fetches again by itself.
 * Only the account's own files (`-user`), on the home's own disk (`-xdev`), no link
 * followed: `find` follows none, a cache folder that is itself a link is left alone, and
 * `-delete` is never beside a folder that is skipped, since it turns the skipping off.
 */
export const DISK_TIERS = { more: 70, most: 85 };
const TIDY_EVERY_MS = 5 * 60_000;
/** The disk past which the model is told, so it can put away what it no longer needs. */
const DISK_WARN_PERCENT = 80;
/** Neither read nor written for a day. */
const DAY_OLD = '-mmin +1440 -amin +1440';
/** Browsers in ~/.cache: kept at every tier. */
const KEPT_CACHES = '-path ./.cache/ms-playwright -o -path ./.cache/puppeteer';
/**
 * Caches that fill themselves again when wanted: whole entries in them go by age at tier 2 and
 * at any age at tier 3. Named, not everything under ~/.cache: that also holds a Hugging Face
 * login (huggingface/token), Poetry's virtual environments and pre-commit's hooks.
 */
const REGROWING_CACHES = ['.cache/huggingface/hub', '.cache/huggingface/datasets', '.cache/torch/hub', '.cache/matplotlib', '.cache/node-gyp', '.cache/go-build', '.cache/yarn', '.cache/pip', '.cache/uv', '.npm/_npx', '.npm/_cacache']
  .map((path) => `'${path}'`)
  .join(' ');
/** How full the home's disk is, in percent: what every command costs. */
const DISK_CHECK = `df -Pk "$HOME" 2>/dev/null | awk 'NR==2 { sub(/%/, "", $5); print $5 }'`;

/**
 * How hard to tidy at this fullness.
 *
 * @param {number} percent
 * @returns {1|2|3}
 */
export function tidyTier(percent) {
  const full = Number(percent);
  if (!Number.isFinite(full)) return 1;
  return full > DISK_TIERS.most ? 3 : full >= DISK_TIERS.more ? 2 : 1;
}

/**
 * Whether to tidy after this command, and how hard: when it is due, or when the disk is
 * in a fuller tier than the last tidy was for. A disk that has gone down a tier has less
 * to do, which can wait until it is due.
 *
 * @param {{ percent: number, last?: { tier?: number, tidiedAt?: number } | null, now?: number }} state
 * @returns {{ tier: 1|2|3, run: boolean }}
 */
export function tidyPlan({ percent, last = null, now = Date.now() }) {
  const tier = tidyTier(percent);
  const since = Number(last?.tidiedAt) || 0;
  return { tier, run: !since || now - since >= TIDY_EVERY_MS || tier > (Number(last?.tier) || 0) };
}

/**
 * The tidy for one tier, as a script run as the account. Its last lines say how full the
 * disk was before and after (`synz-disk`, percent and kilobytes used, twice), and at the
 * top tier what is largest (`synz-big`, kilobytes, a tab, the path).
 *
 * @param {number} tier
 * @param {{ tmp?: string }} [options]  `tmp`: a test points it at a folder of its own
 */
export function tidyScript(tier, { tmp = '/tmp' } = {}) {
  const level = Math.min(3, Math.max(1, Math.round(Number(tier)) || 1));
  // Above 85% the caches go whatever their age.
  const age = level >= 3 ? '' : ` ${DAY_OLD}`;
  // A whole cache entry by when it last changed: walking a folder, this tidy's own first lines
  // included, reads it and so moves its access time, which would keep every entry young.
  const entryAge = level >= 3 ? '' : ' -mmin +1440';
  const scraps = quoted(tmp);
  const lines = [
    // An empty or root HOME would leave this wherever it started.
    '[ -n "$HOME" ] && [ "$HOME" != / ] && cd -- "$HOME" 2>/dev/null || exit 0',
    'me="$(id -un 2>/dev/null)"; [ -n "$me" ] || exit 0',
    `disk() { df -Pk . 2>/dev/null | awk 'NR==2 { sub(/%/, "", $5); print $5, $3 }'; }`,
    'before="$(disk)"',
    '[ -d .cache ] && [ ! -L .cache ] && rm -rf -- .cache/pip .cache/uv 2>/dev/null',
    '[ -d .npm ] && [ ! -L .npm ] && rm -rf -- .npm/_cacache .npm/_logs 2>/dev/null',
    'rm -rf -- .pytest_cache 2>/dev/null',
    `find . -xdev \\( -path ./.local -o ${KEPT_CACHES} \\) -prune -o -type d \\( -name __pycache__ -o -name .ipynb_checkpoints -o -name .pytest_cache \\) -user "$me" -prune -exec rm -rf -- {} + 2>/dev/null`,
    // Only real core dumps, which are ELF files, and never among what was sent or brought here (security review, 2026-11-09).
    `find . -maxdepth 3 -xdev \\( -path ./.local -o -path ./uploads -o -path ./incoming -o -path ./downloads -o ${KEPT_CACHES} \\) -prune -o -type f \\( -name core -o -name 'core.[0-9]*' \\) -user "$me" -exec sh -c 'for f do [ "$(head -c 4 -- "$f" 2>/dev/null)" = "$(printf '"'"'\\177ELF'"'"')" ] && rm -f -- "$f"; done' sh {} + 2>/dev/null`,
    `find ${scraps} -xdev -mindepth 1 -maxdepth 1 -user "$me" -mmin +20 ! -name 'synz*' ! -name '.*' -exec rm -rf -- {} + 2>/dev/null`,
    // What was sent straight here and left a month. Its row says the file is gone, in those words.
    'find uploads -xdev -type f -user "$me" -mtime +30 -delete 2>/dev/null; find uploads -xdev -mindepth 1 -type d -empty -user "$me" -delete 2>/dev/null',
  ];
  if (level >= 2) {
    lines.push(
      // Caches that fill themselves again, an entry at a time and whole: a file pulled out of one
      // broke npx and Poetry, and took a Hugging Face login with it (review, 2026-11-09).
      `for d in ${REGROWING_CACHES}; do [ -d "$d" ] && [ ! -L "$d" ] && [ ! -L "\${d%%/*}" ] && [ ! -L "\${d%/*}" ] && find "$d" -xdev -mindepth 1 -maxdepth 1 -user "$me"${entryAge} -exec rm -rf -- {} + 2>/dev/null; done`,
      `find . -xdev \\( -path ./.local -o -path ./.cache -o -path ./.npm \\) -prune -o -type f \\( -path '*/node_modules/.cache/*' -o -path '*/.next/cache/*' -o -path '*/.parcel-cache/*' \\) -user "$me"${age} -exec rm -f -- {} + 2>/dev/null`,
      // Logs this machine's own helpers write, trimmed to their last megabyte in place; a log of the
      // person's own, anywhere in their folders, is theirs (review, 2026-11-09).
      `find . -maxdepth 1 -xdev -type f -name nohup.out -size +10M -user "$me" -exec sh -c 'for f do t="$(mktemp)" || continue; tail -c 1048576 -- "$f" > "$t" && cat -- "$t" > "$f"; rm -f -- "$t"; done' sh {} + 2>/dev/null`,
      `find ${scraps} -maxdepth 1 -xdev -type f -name 'synz-*.log' -size +10M -user "$me" -exec sh -c 'for f do t="$(mktemp)" || continue; tail -c 1048576 -- "$f" > "$t" && cat -- "$t" > "$f"; rm -f -- "$t"; done' sh {} + 2>/dev/null`,
      // Copies of the conversation's files, which `bring` puts back, and what the cloud browser downloaded.
      `find incoming -xdev -type f -user "$me" ${DAY_OLD} -delete 2>/dev/null; find incoming -xdev -mindepth 1 -type d -empty -user "$me" -delete 2>/dev/null`,
    );
  }
  if (level >= 3) {
    // Not one still being written: deleting it would free nothing until it closed, and lose it.
    // Large files in /tmp are listed with the largest things, not deleted: one can be a file a conversation still points at.
  }
  lines.push('echo "synz-disk $before $(disk)"');
  if (level >= 3) {
    // Folders two deep and files over 10 MB, largest first.
    lines.push(`{ du -xk -d 2 . 2>/dev/null | awk -F '\\t' '$2 != "."'; find . -xdev -type f -size +10M -user "$me" -printf '%k\\t%p\\n' 2>/dev/null; } | sort -rn | head -10 | sed 's/^/synz-big /'`);
  }
  return lines.join('\n');
}

/**
 * What a tidy said: how full the disk was before and after, how much it freed, and at the
 * top tier what is largest. Null when it said nothing readable.
 *
 * @param {string} out
 * @returns {{ before: number, after: number, freed: number, biggest: { bytes: number, path: string }[] } | null}
 */
export function readTidy(out) {
  const lines = String(out || '').split('\n').map((line) => line.replace(/\r$/, ''));
  const said = /^synz-disk (\d+) (\d+) (\d+) (\d+)\s*$/.exec(lines.find((line) => line.startsWith('synz-disk ')) || '');
  if (!said) return null;
  const [before, usedBefore, after, usedAfter] = said.slice(1).map(Number);
  const biggest = [];
  for (const line of lines) {
    const big = /^synz-big (\d+)\t(.+)$/.exec(line);
    if (big && biggest.length < 10) biggest.push({ bytes: Number(big[1]) * 1024, path: big[2].replace(/^\.\//, '').slice(0, 160) });
  }
  // Something else may have written meanwhile: never less than nothing.
  return { before, after, freed: Math.max(0, usedBefore - usedAfter) * 1024, biggest };
}

const sized = (bytes) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * A sentence for the model when the disk is still getting full after a tidy, else nothing.
 *
 * @param {{ after: number, freed: number, biggest: { bytes: number, path: string }[] }} result
 */
function diskNote({ after, freed, biggest }) {
  if (after < DISK_WARN_PERCENT) return '';
  const tidied = freed ? ` after tidying freed ${sized(freed)}` : '';
  const largest = biggest.length ? ` The largest things in its home folder: ${biggest.map((b) => `${b.path} ${sized(b.bytes)}`).join(', ')}.` : '';
  return `The cloud computer's disk is ${after}% full${tidied}: delete what is no longer needed, and ask the user before deleting their own files.${largest}`;
}

const DISK_SETTING = 'machineDisk';
/** Long enough to hold "today" wherever the person is. */
const FREED_FOR_MS = 48 * 60 * 60_000;
const FREED_KEPT = 300;
/**
 * What each account's disk last said, and when it was last tidied: the plan's memory on
 * this instance. The store keeps the same for the Settings page and for other instances.
 * @type {Map<string, { percent: number, checkedAt: number, tier: number, tidiedAt: number, freed: number[][] }>}
 */
const disks = new Map();

/** A stored record as numbers, whatever the row holds. @param {any} saved */
function diskRecordOf(saved) {
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const freed = Array.isArray(saved?.freed)
    ? saved.freed.filter((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((v) => Number.isFinite(v) && v >= 0))
    : [];
  return { percent: number(saved?.percent), checkedAt: number(saved?.checkedAt), tier: number(saved?.tier), tidiedAt: number(saved?.tidiedAt), freed: freed.slice(-FREED_KEPT) };
}

/** @param {string} userId */
async function diskRecord(userId) {
  let record = disks.get(userId);
  if (!record) {
    record = diskRecordOf(await getStore().getUserSetting(userId, DISK_SETTING).catch(() => null));
    disks.set(userId, record);
    if (disks.size > 2000) disks.delete(disks.keys().next().value);
  }
  return record;
}

/**
 * After a command: look at how full the disk is, and tidy as hard as that says when it
 * is due or a tier has been crossed. The machine is awake anyway. Never fails the
 * command it follows.
 *
 * @param {string} userId
 * @param {any} machine
 * @param {(command: string, env?: Record<string, string>, options?: any) => any} shellFor
 * @param {{ signal?: AbortSignal, now?: number }} [options]
 * @returns {Promise<string>} a sentence for the model when the disk is getting full, else nothing
 */
export async function tidyIfDue(userId, machine, shellFor, { signal, now = Date.now() } = {}) {
  try {
    const record = await diskRecord(userId);
    const checked = await machine.runCommand({ ...shellFor(DISK_CHECK, {}, { userBin: true }), timeoutMs: 10_000, signal });
    const percent = parseInt(String(await checked.stdout()).trim(), 10);
    if (!Number.isFinite(percent)) return '';
    record.percent = percent;
    record.checkedAt = now;
    const plan = tidyPlan({ percent, last: record, now });
    if (!plan.run) return '';
    // Before it runs: one that fails is not tried again after every command.
    record.tidiedAt = now;
    record.tier = plan.tier;
    const done = await machine.runCommand({ ...shellFor(tidyScript(plan.tier), {}, { userBin: true }), timeoutMs: plan.tier > 1 ? 45_000 : 20_000, signal });
    const result = readTidy(await done.stdout());
    if (result) {
      record.percent = result.after;
      record.freed = [...record.freed.filter(([at]) => now - at < FREED_FOR_MS), ...(result.freed > 0 ? [[now, result.freed]] : [])].slice(-FREED_KEPT);
    }
    await getStore().setUserSetting(userId, DISK_SETTING, record).catch(() => {});
    return result ? diskNote(result) : '';
  } catch {
    return '';
  }
}

/**
 * How full this account's disk was when last looked at, and what tidying freed over the
 * last two days, for the Settings page to sum by the person's own "today". This
 * instance's reading when it is newer than the stored one; nothing before a command has run.
 *
 * @param {string} userId
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ percent: number, checkedAt: number, freed: { at: number, bytes: number }[] } | null>}
 */
export async function diskSummary(userId, { now = Date.now() } = {}) {
  const saved = diskRecordOf(await getStore().getUserSetting(userId, DISK_SETTING).catch(() => null));
  const here = disks.get(userId);
  const record = here && here.checkedAt >= saved.checkedAt ? here : saved;
  if (!record.checkedAt) return null;
  return {
    percent: record.percent,
    checkedAt: record.checkedAt,
    freed: record.freed.filter(([at]) => now - at < FREED_FOR_MS).map(([at, bytes]) => ({ at, bytes })),
  };
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
  /** Nothing remembered about any disk: the next call starts afresh. */
  reset() {
    disks.clear();
  },
};
