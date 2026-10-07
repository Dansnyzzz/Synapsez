#!/usr/bin/env node
/**
 * The evidence ledger, and the only thing allowed to write a green stamp.
 *
 * CLAUDE.md §5 lists a Definition of Done and §10 says not to claim a change is
 * finished without having actually run the gate. Both are prose, and prose is
 * the thing a model can talk itself out of on turn ninety of an unattended run.
 * This file is the part that cannot be talked out of: a stamp exists only if the
 * process that wrote it is the process that ran the tests and read their exit
 * codes itself.
 *
 * That constraint is the whole design. The tempting alternative — watch the
 * output of `npm test` go past in a PostToolUse hook and stamp when it "looks
 * like a pass" — is exactly the self-deception the ledger exists to prevent. A
 * suite that printed a tally and then exited 1 looks, in a scrollback, almost
 * identical to one that passed.
 *
 * A stamp expires on its own. It records the commit and a hash of the working
 * tree's dirty set, so the next edit or the next commit invalidates it with no
 * bookkeeping. There is deliberately no time-based expiry: an hour-old stamp on
 * an untouched tree is still true, and a one-second-old stamp on a tree that has
 * changed since is not.
 *
 * Used as a library by the hooks, and as a CLI by the model:
 *
 *   node .claude/hooks/gate.js run [--fast]   run the gate, stamp only if green
 *   node .claude/hooks/gate.js status         print the ledger as JSON
 *   node .claude/hooks/gate.js note <file>    record a file as unverified
 *
 * Nothing here imports anything outside Node's standard library. These run on
 * every matching event, and a hook that needs `npm install` to work is a hook
 * that breaks the session it was meant to protect.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Project root — two levels up from `.claude/hooks/`. */
export const ROOT = path.resolve(HERE, '../..');

/**
 * Where the ledger lives. Overridable so the test suite can run against a
 * temporary directory instead of stamping the real one — a test that reports
 * the working tree as verified would be worse than no test at all.
 */
export function stateDir() {
  return process.env.CLAUDE_GATE_STATE || path.join(ROOT, '.claude', 'state');
}

const ledgerPath = () => path.join(stateDir(), 'gate.json');

/** Never let a missing directory turn into a thrown hook. */
function ensureDir() {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

const EMPTY = { pending: [], lastGreen: null };

export function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    return {
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      lastGreen: parsed.lastGreen && typeof parsed.lastGreen === 'object' ? parsed.lastGreen : null,
    };
  } catch {
    // Absent, unreadable or corrupt all mean the same thing: nothing is proven.
    return { ...EMPTY, pending: [] };
  }
}

function writeLedger(ledger) {
  if (!ensureDir()) return false;
  try {
    fs.writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** A git command that returns '' rather than throwing when git is unavailable. */
function git(args) {
  try {
    const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
    return run.status === 0 ? String(run.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

export const head = () => git(['rev-parse', 'HEAD']);
export const branch = () => git(['rev-parse', '--abbrev-ref', 'HEAD']);

/**
 * Did anything a test run depends on change between that commit and this one?
 *
 * `dirtyHash` already filters uncommitted changes through `isSource`, so editing
 * a README does not expire the stamp. Committing that README did — because
 * `current` also compared `head()` raw, and a commit hash knows nothing about
 * what is inside it. The exemption held right up to the moment you saved your
 * work, and then evaporated.
 *
 * That is not a small annoyance in a repository like this one. An audit commits
 * documentation constantly, and this cost four full runs of every suite in a
 * single session, for markdown. The comment on `NOT_SOURCE` says
 * exactly where that leads: it is how a gate earns its way into being switched
 * off.
 *
 * Unknown means changed. If git cannot answer — the stamped commit was rebased
 * away, amended, or is on a branch that no longer exists — this returns true and
 * the gate is re-proved. The cost of being wrong that way is minutes; the cost
 * of being wrong the other way is a green stamp over code nothing has run.
 */
function sourceChangedSince(from) {
  if (!from) return true;

  let run;
  try {
    run = spawnSync('git', ['diff', '--name-only', `${from}..HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch {
    return true;
  }
  if (!run || run.status !== 0) return true;

  return String(run.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some(isSource);
}

/**
 * A fingerprint of everything git considers changed, tracked or not. Cheaper and
 * more honest than hashing file contents: it moves the moment anything in the
 * tree does, which is precisely when a stamp stops meaning anything.
 */
/**
 * A fingerprint of the *source* that is uncommitted, ignoring everything a test
 * run does not depend on.
 *
 * This used to hash the whole of `git status --porcelain`, which quietly
 * contradicted `isSource` twenty lines below — and `isSource` exists precisely
 * to say that a README is not worth the full suite. So `note()` honoured the
 * exemption and this did not: writing one line of documentation expired the
 * stamp and demanded a full re-run, which is the exact behaviour the comment on
 * NOT_SOURCE warns turns a gate into something people switch off.
 *
 * The path is taken from each porcelain line after the two status characters,
 * with the rename arrow handled — `R  old -> new` is a change to `new`.
 */
export function dirtyHash() {
  const relevant = git(['status', '--porcelain'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const entry = line.slice(2).trim();
      const target = entry.includes(' -> ') ? entry.split(' -> ').pop() : entry;
      // Quoted when the name has spaces or non-ASCII; the quotes are not part
      // of the path and would defeat the extension test.
      return isSource(target.replace(/^"(.*)"$/, '$1'));
    })
    .sort()
    .join('\n');

  return crypto.createHash('sha256').update(relevant).digest('hex').slice(0, 16);
}

/**
 * Paths that changing does not invalidate a test run. Documentation and the
 * ledger's own state are the obvious cases — demanding the full suite for a
 * typo fix in a README is how a gate earns its way into being switched off.
 */
const NOT_SOURCE = [
  /^\.claude[\\/]state[\\/]/i,
  /^docs[\\/]/i,
  /\.(md|markdown|txt|png|jpe?g|gif|svg|ico|webp|pdf)$/i,
  /^\.gitignore$/i,
  /^LICENSE$/i,
];

export function isSource(rel) {
  if (!rel) return false;

  /**
   * Outside the project is not project source — including on another drive.
   *
   * `startsWith('..')` is the right test on one filesystem, and silently the
   * wrong one on Windows across two. `path.relative('D:\\AI remote', 'C:\\Users
   * \\…\\scratch.mjs')` cannot express the hop as `..`, so it returns the
   * absolute `C:\Users\…` instead — which does not start with `..`, so this
   * said yes.
   *
   * The consequence was live in this repository: editing a scratch file under
   * the system temp directory put it in the pending list, and `verify-stop`
   * then refused a completion claim over an "unproven" file the suites could
   * never prove, because it is not part of the project. A guard that cries wolf
   * is the guard people switch off — the same argument NOT_SOURCE is built on.
   *
   * Both platforms' rules are asked, not only the one this runs on (CFG-022).
   * On Linux `path.isAbsolute` does not know a drive letter, so a Windows path
   * read as a relative file name and this said yes — which failed the hook
   * suite on every CI run since 2026-09-09 while every local run, on Windows,
   * passed. No file in this repository is named like a drive.
   */
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.startsWith('..')) return false;

  return !NOT_SOURCE.some((re) => re.test(rel));
}

/** Record a file as changed-but-unproven. Returns the relative path, or ''. */
export function note(file) {
  let rel;
  try {
    rel = path.relative(ROOT, path.resolve(ROOT, file));
  } catch {
    return '';
  }
  if (!isSource(rel)) return '';

  const ledger = readLedger();
  if (!ledger.pending.some((p) => p.file === rel)) {
    ledger.pending.push({ file: rel, at: new Date().toISOString() });
    // A run that touches hundreds of files does not need hundreds of names in
    // the reminder; the count is what matters past the first handful.
    if (ledger.pending.length > 50) ledger.pending = ledger.pending.slice(-50);
    writeLedger(ledger);
  }
  return rel;
}

/**
 * Write the green stamp. Only ever called after a real, successful run.
 *
 * `tested` is the fingerprint taken **before** the suites started, and passing it
 * is what makes the stamp honest. This used to call `dirtyHash()` here, at the
 * end — so a file edited while the suites were running was recorded as covered
 * by a run that never saw it. The window is however long the gate takes, which
 * is minutes, and an agent working alongside it will happily fill that.
 *
 * Recording what was tested rather than what is on disk now means `status()`
 * compares the two and reports "no longer matches this tree", which is exactly
 * right: the run was real, it just does not describe the tree any more.
 */
export function stamp(scope, tested = dirtyHash(), content = contentHash()) {
  const ledger = readLedger();
  ledger.lastGreen = { at: new Date().toISOString(), head: head(), dirty: tested, content, scope };
  ledger.pending = [];
  writeLedger(ledger);
  return ledger.lastGreen;
}

/**
 * A fingerprint of what the source *is*, wherever it happens to live.
 *
 * `head` + `dirtyHash` describe where content sits — committed, or modified in
 * the working tree — and that is the wrong question. The normal workflow here is
 * edit, run the gate, commit. The gate fingerprints the files while they are
 * dirty; the commit moves the identical bytes into HEAD; and both halves of the
 * old `current` then report a change. The stamp was discarded immediately after
 * the only run that ever covered the code, and every piece of work paid for a
 * second full run over byte-identical content. That happened five times in one
 * audit before it was measured (CFG-020); CFG-018 had closed only the half where
 * the commit touched documentation.
 *
 * So this hashes content, not location: every source file git tracks or would
 * add, as its blob hash on disk, paired with its path. Committing changes
 * nothing here. Editing, adding, deleting or renaming a source file changes it.
 * `.gitignore`d files are out, which is right — nothing the suites run is
 * ignored — and documentation is out through `isSource`, the same exemption
 * `dirtyHash` honours.
 *
 * '' means git could not answer, and `status()` treats '' as "cannot prove".
 * Unknown is never allowed to read as unchanged.
 */
export function contentHash() {
  const listing = git(['ls-files', '--cached', '--others', '--exclude-standard']);
  if (!listing) return '';

  const files = [...new Set(listing.split('\n').map((line) => line.trim()).filter(Boolean))]
    .filter(isSource)
    // A file deleted from disk but still in the index would make hash-object
    // fail the whole batch. Its absence is itself a change, and dropping it from
    // the list is how that change shows up in the fingerprint.
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    .sort();
  if (!files.length) return '';

  let run;
  try {
    run = spawnSync('git', ['hash-object', '--stdin-paths'], {
      cwd: ROOT,
      input: files.join('\n'),
      encoding: 'utf8',
      timeout: 30_000,
    });
  } catch {
    return '';
  }
  if (!run || run.status !== 0) return '';

  const blobs = String(run.stdout || '').trim().split('\n');
  if (blobs.length !== files.length) return '';

  const hash = crypto.createHash('sha256');
  files.forEach((rel, i) => hash.update(`${rel}\0${blobs[i]}\n`));
  return hash.digest('hex').slice(0, 16);
}

/**
 * The question every consumer actually asks: is what is on disk right now backed
 * by a run that happened?
 *
 * `verified` requires the full gate. A `--fast` stamp is genuine evidence that
 * lint and the hook suite passed, and is reported as such, but it is not
 * evidence that the the full suite did — so it does not satisfy a claim that
 * a piece of work is finished.
 */
export function status() {
  const ledger = readLedger();
  const g = ledger.lastGreen;
  /**
   * The stamp is current while nothing a test depends on has moved.
   *
   * Both halves now ask the same question. `dirtyHash` asks it of the working
   * tree and `sourceChangedSince` asks it of the commits in between; before, the
   * second half compared commit hashes and a documentation commit was
   * indistinguishable from a rewrite of the agent loop.
   */
  const current = !g
    ? false
    : g.content
      // A stamp that recorded content is judged on content. Commits, branch
      // switches that land on identical files, and documentation all leave it
      // standing; any change to source does not.
      ? g.content === contentHash()
      // Stamps written before `content` existed keep the older rule rather than
      // being silently upgraded to a guarantee they never recorded.
      : g.dirty === dirtyHash() && (g.head === head() || !sourceChangedSince(g.head));
  const clean = ledger.pending.length === 0;

  return {
    pending: ledger.pending,
    lastGreen: g,
    branch: branch(),
    /** The stamp still describes the tree as it stands. */
    current,
    /** Full gate, still current, nothing edited since. */
    verified: current && clean && g.scope === 'full',
    /** Lint + hooks only — real, but not the whole gate. */
    fastOnly: current && clean && g.scope === 'fast',
  };
}

/* ---------------------------------------------------------------- CLI ----- */

/**
 * The gate itself, in the order that fails cheapest first.
 *
 * `full` has to match what CI blocks a merge on, or the stamp says something CI
 * will later contradict. It did not: it ran lint, the suites and the hook tests,
 * and skipped type-checking entirely — so a tree with seven type errors CI would
 * reject was stamped `verified: true`, which is the one thing this file exists to
 * make impossible. `npm run check` had always included it; the gate had not.
 *
 * `eval` is here for the same reason and costs seconds: it is deterministic, needs
 * no key, and asserts that the agent is still *able* to choose well — that the
 * right tool is on offer, that the rule telling it to stop at a sign-in page is
 * still in the prompt.
 *
 * Two of CI's steps are deliberately still out: `test:ui` and `test:sandbox` both
 * need a real browser and skip themselves without one, and a step that silently
 * passes by not running is worse here than a step that is honestly absent. CI
 * installs Chromium explicitly and runs them there. That gap is the reason the
 * green stamp says `full` rather than `everything`.
 */
const STEPS = {
  fast: [
    ['run', 'lint'],
    ['run', 'test:hooks'],
  ],
  full: [
    ['run', 'lint'],
    ['run', 'test:hooks'],
    ['run', 'eval'],
    ['run', 'typecheck'],
    ['test'],
  ],
};

function runGate(fast) {
  const scope = fast ? 'fast' : 'full';
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // What is about to be tested, captured before a single suite runs. See
  // `stamp`: recording this at the end instead would certify whatever happened
  // to be on disk when the run finished, edits included.
  const tested = dirtyHash();
  const testedContent = contentHash();

  for (const args of STEPS[scope]) {
    process.stdout.write(`\n[1m› npm ${args.join(' ')}[0m\n`);
    const run = spawnSync(npm, args, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 20 * 60_000,
      shell: process.platform === 'win32',
    });

    if (run.status !== 0) {
      process.stdout.write(
        `\n[31mGate red at \`npm ${args.join(' ')}\` (exit ${run.status}).[0m\n` +
          'Nothing was stamped. Fix the failure and run the gate again — do not\n' +
          'describe this change as finished until it is green.\n',
      );
      return 1;
    }
  }

  const green = stamp(scope, tested, testedContent);
  process.stdout.write(
    `\n[32mGate green (${scope}).[0m Stamped at ${green.at} on ${green.head.slice(0, 7) || 'no commit'}.\n` +
      (fast
        ? 'This was the fast gate: lint and the hook suite only. A claim that the\n' +
          'work is finished still needs the full run.\n'
        : ''),
  );
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === 'run') return runGate(rest.includes('--fast'));

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(status(), null, 2)}\n`);
    return 0;
  }

  if (cmd === 'note') {
    const rel = note(rest[0] || '');
    process.stdout.write(rel ? `noted ${rel}\n` : 'not a source file; nothing noted\n');
    return 0;
  }

  process.stdout.write('usage: gate.js run [--fast] | status | note <file>\n');
  return cmd ? 1 : 0;
}

// Only act as a CLI when invoked directly, so importing this from a hook is free
// of side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
