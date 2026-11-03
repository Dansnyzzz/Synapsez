/**
 * Tests for the hooks themselves.
 *
 * A guard nobody tested is a guard that fails open on the day it matters, and
 * these are the files least likely to be exercised by hand — you only find out
 * a pattern was wrong by watching something destructive go through.
 *
 * The payloads live in this file rather than on a command line deliberately:
 * typing them into a shell trips the very guard under test.
 *
 *   node .claude/hooks/hooks.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

let passed = 0;
let failed = 0;

const BLOCK = 2;
const ALLOW = 0;

/**
 * A ledger of its own, in a temp directory.
 *
 * The gate hooks read and write `.claude/state/`, and a test that stamped the
 * real one would report the working tree as verified when nothing had run —
 * which is precisely the lie the whole mechanism exists to prevent. So every
 * gate-aware hook here is pointed somewhere disposable.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gate-'));
const ledgerFile = path.join(sandbox, 'gate.json');
const gateEnv = { ...process.env, CLAUDE_GATE_STATE: sandbox };

const writeLedger = (ledger) => fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
const clearLedger = () => {
  try {
    fs.rmSync(ledgerFile);
  } catch {
    /* already absent */
  }
};

/** Run a hook with a payload and assert the exit code. */
function check(hook, payload, expected, what, env = process.env) {
  const run = spawnSync(process.execPath, [path.join(here, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: root,
    timeout: 90_000,
    env,
  });

  const got = run.status;
  const ok = got === expected;
  const verdict = (code) => (code === BLOCK ? 'blocked' : 'allowed');

  if (ok) {
    passed += 1;
    console.log(`  [32m✓[0m  ${what} — ${verdict(got)}`);
  } else {
    failed += 1;
    console.log(
      `  [31m✗[0m  ${what} — expected ${verdict(expected)}, got ${verdict(got)}` +
        `${run.stderr ? `\n       ${run.stderr.trim().split('\n').join('\n       ')}` : ''}`,
    );
  }
  return run;
}

/** Assert something that is not an exit code. */
function is(condition, what, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  [32m✓[0m  ${what}`);
  } else {
    failed += 1;
    console.log(`  [31m✗[0m  ${what}${detail ? `\n       ${detail}` : ''}`);
  }
}

const bash = (command) => ({ tool_input: { command } });
const write = (file_path) => ({ cwd: root, tool_input: { file_path } });

/**
 * Which branch the guard should believe it is on.
 *
 * Declared here rather than beside the branch section further down, because the
 * push checks below need it too and did not have it. Without a branch injected
 * they read the *real* one, so `git push origin feature` — a command that has
 * nothing to do with the protected branch — was blocked whenever the suite ran
 * on `main`, and `npm run check` could never be green there.
 *
 * That is worse than an ordinary flaky test. The whole premise of this ledger
 * is that only a green gate may stamp work as verified, so a gate that cannot
 * go green on the default branch disables the mechanism it exists to enforce.
 */
const onBranch = (name) => ({
  ...process.env,
  CLAUDE_GUARD_BRANCH: name,
  /*
   * Pinned off, not merely absent.
   *
   * `AI_REMOTE_ALLOW_MAIN` lifts every protected-branch rule, and this repo sets
   * it in `.claude/settings.json`, so it is in `process.env` when the gate runs
   * the suite. Spreading the environment therefore handed the switch to the very
   * tests that exist to prove the switch is off — thirteen checks flipped from
   * blocked to allowed in one go, and the suite would have reported the rules as
   * working while measuring nothing.
   *
   * Which is the same fault as the `CLAUDE_GUARD_BRANCH` note above: a test that
   * reads ambient state tests the machine it happens to run on. Both halves are
   * fixed the same way — state the condition, do not inherit it.
   */
  AI_REMOTE_ALLOW_MAIN: '',
});

console.log('\n[1mguard-bash[0m');
check('guard-bash.js', bash('npm test'), ALLOW, 'an ordinary command runs');
// Both name a feature branch as the destination, so they must run whatever
// branch the suite itself happens to be checked out on. See `onBranch`.
check('guard-bash.js', bash('git push origin feature'), ALLOW, 'a normal push runs', onBranch('feature/x'));
check(
  'guard-bash.js',
  bash('git push --force-with-lease origin feature'),
  ALLOW,
  '--force-with-lease is the safe form',
  onBranch('feature/x'),
);
check('guard-bash.js', bash('npm install express'), ALLOW, 'installing a package runs');

check('guard-bash.js', bash(['rm', '-rf', 'build'].join(' ')), BLOCK, 'recursive force-delete');
check('guard-bash.js', bash(['rm', '-fr', 'build'].join(' ')), BLOCK, 'the flags in the other order');
check('guard-bash.js', bash(['git', 'push', '--force', 'origin', 'main'].join(' ')), BLOCK, 'force-push');
check('guard-bash.js', bash(['git', 'push', '-f', 'origin', 'main'].join(' ')), BLOCK, 'the short form of it');
// CFG-034, CFG-035: skipping the repo's hooks, however it is spelled — and nothing that merely mentions it.
const noVerify = ['--no', 'verify'].join('-');
check('guard-bash.js', bash(`git commit -m x ${noVerify}`), BLOCK, 'committing past the hooks');
check('guard-bash.js', bash(`git push ${noVerify} origin feature`), BLOCK, '  pushing past them', onBranch('feature/x'));
check('guard-bash.js', bash('git commit -qn -m x'), BLOCK, '  -n among the short flags of commit');
for (const spelled of ['git commit -m x -n', 'git commit -F msg -n', 'git commit --amend -n', 'git commit -C HEAD -n', 'git -c a=b commit -n', 'git -C . commit -n', `git commit ${noVerify.slice(0, -1)}`, `git commit ${noVerify.slice(0, -2)}`, `git commit "${noVerify}"`]) {
  check('guard-bash.js', bash(spelled), BLOCK, `  ${spelled.replace(noVerify, 'the flag')}`);
}
check('guard-bash.js', bash('git commit -q -F msg.txt'), ALLOW, '  while an ordinary commit runs');
check('guard-bash.js', bash('git commit -m "the -n flag is not used here"'), ALLOW, '  and a message that names the flag is not the flag');
check('guard-bash.js', bash(`git commit -m "never use ${noVerify}"`), ALLOW, '  in either spelling');
check('guard-bash.js', bash('git log -n 5'), ALLOW, '  nor is -n to another command');
check('guard-bash.js', bash(['git', 'reset', '--hard'].join(' ')), BLOCK, 'discarding uncommitted work');
check('guard-bash.js', bash(`psql -c "${['DROP', 'TABLE', 'users'].join(' ')}"`), BLOCK, 'dropping a table');
check('guard-bash.js', bash(`psql -c "${['TRUNCATE', 'chats'].join(' ')}"`), BLOCK, 'truncating one');
check('guard-bash.js', bash(['rm', '-r', 'data/pgdata'].join(' ')), BLOCK, 'deleting the local cluster');
check('guard-bash.js', bash(['npm', 'publish'].join(' ')), BLOCK, 'publishing a private package');

/*
 * Cutting a release is publishing, and only `npm publish` was covered.
 *
 * Three installed skills drive exactly these commands — one tags, releases and
 * publishes; one decides how a finished branch integrates; one gates its own
 * commits. A decision recorded in a document is a note, not a guard, and
 * CLAUDE.md §2 is explicit that a risk which can happen at any moment belongs
 * in code.
 *
 * Split into tokens like the rules above, because writing them whole in this
 * file would trip the guard when the suite itself is read by one.
 */
check('guard-bash.js', bash(['gh', 'release', 'create', 'v1.2.0'].join(' ')), BLOCK, 'cutting a github release');
check('guard-bash.js', bash(['gh', 'pr', 'merge', '4', '--squash'].join(' ')), BLOCK, 'merging a pull request');
check('guard-bash.js', bash(['npm', 'version', 'patch'].join(' ')), BLOCK, 'bumping the version');
check('guard-bash.js', bash(['git', 'push', '--tags', 'origin', 'feature'].join(' ')), BLOCK, 'pushing tags');
// A local tag publishes nothing, and this audit's own safety net is one.
check('guard-bash.js', bash(['git', 'tag', 'backup/pre-optimize-x'].join(' ')), ALLOW, 'tagging locally is fine');
check('guard-bash.js', bash(['gh', 'pr', 'view', '4'].join(' ')), ALLOW, 'and reading a pull request is too');

/*
 * A refusal must say what to do when the match was text, not a command (CFG-021).
 *
 * The rules are not loosened — a quoted string can be a real command, so there is
 * no safe way to strip one. What changed is the dead end: writing a file whose
 * *contents* mention a blocked command gets pointed at the Edit tool, rather than
 * leaving rephrasing-until-it-passes as the only visible option.
 */
{
  const writesText = bash(`node -e "require('fs').writeFileSync('notes.md', 'never run ${['npm', 'publish'].join(' ')} here')"`);
  const run = check('guard-bash.js', writesText, BLOCK, 'text that names a blocked command is still refused — the rule is not loosened');
  is(/Edit or\s+Write tool/.test(run.stderr || ''), '  but the refusal says to write the file with the Edit tool instead');
  is(/do not rephrase/i.test(run.stderr || ''), '  and not to rephrase around the match');
}

console.log('\n[1mguard-write[0m');
check('guard-write.js', write('server/app.js'), ALLOW, 'ordinary source is editable');
check('guard-write.js', write('test/deploy.test.mjs'), ALLOW, 'so are tests');
check('guard-write.js', write('data/samples/Bao gia.csv'), ALLOW, 'and the sample fixtures');
check('guard-write.js', write(path.join(root, 'README.md')), ALLOW, 'an absolute path inside the project');
check('guard-write.js', write('../elsewhere/notes.md'), ALLOW, 'outside the project is not our business');

check('guard-write.js', write('data/pgdata/postgresql.conf'), BLOCK, 'the live Postgres cluster');
check('guard-write.js', write('data/pending-pairing.json'), BLOCK, 'runtime state under data/');
check('guard-write.js', write('.env'), BLOCK, 'the file holding ENCRYPTION_KEY');
check('guard-write.js', write('worker/.env'), BLOCK, "the worker's copy");
check('guard-write.js', write('package-lock.json'), BLOCK, 'a generated lockfile');
check('guard-write.js', write('node_modules/express/index.js'), BLOCK, 'a dependency in place');

console.log('\n[1mlint-changed[0m');
check('lint-changed.js', write('README.md'), ALLOW, 'markdown is not linted');
check('lint-changed.js', write('server/app.js'), ALLOW, 'a clean source file passes');

/* ---------------------------------------------------------------------------
 * The branch rules.
 *
 * The branch is injected rather than read from git, so these test the rule and
 * not whichever branch the suite happens to be run on.
 * ------------------------------------------------------------------------- */

console.log('\n[1mguard-bash · protected branch[0m');

check('guard-bash.js', bash('git commit -m "x"'), BLOCK, 'committing on main', onBranch('main'));
check('guard-bash.js', bash('git commit -m "x"'), BLOCK, 'committing on master', onBranch('master'));
check('guard-bash.js', bash('git commit -m "x"'), ALLOW, 'committing on a feature branch', onBranch('feature/x'));
check('guard-bash.js', bash('git merge feature/x'), BLOCK, 'merging into main', onBranch('main'));
check('guard-bash.js', bash('git merge feature/x'), ALLOW, 'merging on a feature branch', onBranch('feature/x'));
check('guard-bash.js', bash('git push origin HEAD'), BLOCK, 'pushing while on main', onBranch('main'));
check('guard-bash.js', bash('git push origin feature/x'), ALLOW, 'pushing a feature branch', onBranch('feature/x'));
check('guard-bash.js', bash('git push origin main'), BLOCK, 'naming it from another branch', onBranch('feature/x'));

/*
 * The three forms that walked straight past the first version of this rule.
 *
 * It matched a regex ending in the branch name, so `git push origin main` was
 * caught and the `HEAD:` form was not — nor the branch-to-branch refspec, nor
 * the full ref. The rule looked correct the entire time, which is the only
 * reason each of these is worth its own line.
 *
 * Built by joining fragments, for the reason at the top of this file: written
 * out whole, these strings trip the guard that is under test the moment the
 * command reaches a shell.
 */
const push = (...parts) => bash(['git', 'push', ...parts].join(' '));

check('guard-bash.js', push('origin', 'HEAD:ma' + 'in'), BLOCK, 'the HEAD: form is the same act', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'feature/x:ma' + 'in'), BLOCK, 'so is branch-to-branch', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'refs/heads/ma' + 'in'), BLOCK, 'so is the full ref', onBranch('feature/x'));
check('guard-bash.js', push('-u', 'origin', 'ma' + 'in'), BLOCK, 'flags do not hide it', onBranch('feature/x'));
check('guard-bash.js', push('origin', ':ma' + 'in'), BLOCK, 'deleting it remotely is worse, not better', onBranch('feature/x'));

// And the other direction. A rule that catches too much is a rule that gets
// switched off, and then it protects nothing at all.
check('guard-bash.js', push('origin', 'ma' + 'in-page'), ALLOW, 'a branch that merely starts with it is fine', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'ma' + 'in:feature/x'), ALLOW, 'pushing it somewhere else does not write it', onBranch('feature/x'));
check('guard-bash.js', push('origin', 'dev', '# merge to ma' + 'in later'), ALLOW, 'nor does mentioning it in a comment', onBranch('feature/x'));
// The regression that started this file: the safe form must survive.
check(
  'guard-bash.js',
  bash('git push --force-with-lease origin feature/x'),
  ALLOW,
  '--force-with-lease still runs on a feature branch',
  onBranch('feature/x'),
);
check('guard-bash.js', bash('git status'), ALLOW, 'reading status on main', onBranch('main'));

/* ---------------------------------------------------------------------------
 * The owner's switch: AI_REMOTE_ALLOW_MAIN.
 *
 * Every check above is the negative control for this section — with the switch
 * unset they all still block, which is what makes "it allows things now" mean
 * something. A permission flag with no test proving it is *off* by default is
 * how a guard quietly stops guarding.
 *
 * Read alongside the note on `mainWritesAllowed` in guard-bash.js for why this
 * is an environment variable and not something the model can put in a command:
 * the hook is spawned by Claude Code before any shell runs, so an inline
 * assignment never reaches it.
 * ------------------------------------------------------------------------- */

console.log('\n\x1b[1mguard-bash · the owner\'s switch\x1b[0m');

/** Branch, plus the switch set to `value`. */
const opened = (branch, value = '1') => ({ ...onBranch(branch), AI_REMOTE_ALLOW_MAIN: value });

check('guard-bash.js', push('origin', 'ma' + 'in'), ALLOW, 'it lifts the push to main', opened('feature/x'));
check('guard-bash.js', push('origin', 'HEAD:ma' + 'in'), ALLOW, 'including the HEAD: form', opened('feature/x'));
check('guard-bash.js', bash('git push origin HEAD'), ALLOW, 'and pushing while on main', opened('main'));
check('guard-bash.js', bash('git commit -m "x"'), ALLOW, 'it lifts committing on main', opened('main'));
check('guard-bash.js', bash('git merge feature/x'), ALLOW, 'and merging into it', opened('main'));

// What it must never lift. None of these is branch protection, and an owner
// saying "you may land work on main" is not saying "you may rewrite history".
check(
  'guard-bash.js',
  bash(['git', 'push', '--force', 'origin', 'main'].join(' ')),
  BLOCK,
  'force-push is still refused',
  opened('feature/x'),
);
check('guard-bash.js', bash(['git', 'reset', '--hard'].join(' ')), BLOCK, 'so is discarding work', opened('main'));
check('guard-bash.js', bash(['rm', '-rf', 'build'].join(' ')), BLOCK, 'so is recursive delete', opened('main'));
check('guard-bash.js', bash(['npm', 'publish'].join(' ')), BLOCK, 'so is publishing', opened('main'));
check(
  'guard-bash.js',
  bash(`psql -c "${['DROP', 'TABLE', 'users'].join(' ')}"`),
  BLOCK,
  'so is dropping a table',
  opened('main'),
);

// Only a deliberate yes counts. Anything else reads as "not set", so a stray
// `AI_REMOTE_ALLOW_MAIN=0` left in a settings file does not silently open it.
check('guard-bash.js', push('origin', 'ma' + 'in'), BLOCK, '0 does not open it', opened('feature/x', '0'));
check('guard-bash.js', push('origin', 'ma' + 'in'), BLOCK, 'nor does an empty value', opened('feature/x', ''));
check('guard-bash.js', push('origin', 'ma' + 'in'), BLOCK, 'nor does anything else', opened('feature/x', 'maybe'));
check('guard-bash.js', push('origin', 'ma' + 'in'), ALLOW, 'true opens it', opened('feature/x', 'true'));

/* ---------------------------------------------------------------------------
 * The ledger and the completion gate.
 * ------------------------------------------------------------------------- */

console.log('\n[1mledger[0m');
clearLedger();
check('ledger.js', write('server/agent.js'), ALLOW, 'recording a changed source file', gateEnv);
{
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  is(
    ledger.pending.some((p) => p.file.endsWith('agent.js')),
    'the file lands in the ledger as unproven',
    JSON.stringify(ledger.pending),
  );
}
check('ledger.js', write('README.md'), ALLOW, 'documentation is not source', gateEnv);
{
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  is(!ledger.pending.some((p) => p.file.endsWith('README.md')), 'and does not demand a test run');
}

console.log('\n[1mverify-stop[0m');
const { head, dirtyHash } = await import('./gate.js');
const stop = (last, extra = {}) => ({
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: last,
  ...extra,
});
const unproven = {
  pending: [{ file: 'server/agent.js', at: '2026-09-01T00:00:00Z' }],
  lastGreen: null,
};

writeLedger(unproven);
check('verify-stop.js', stop('Đã sửa xong và tất cả test đều pass.'), BLOCK, 'a completion claim with unproven changes', gateEnv);
check('verify-stop.js', stop('All tests pass now.'), BLOCK, 'the same claim in English', gateEnv);
check('verify-stop.js', stop('Here is how server/agent.js dispatches tools.'), ALLOW, 'an ordinary answer is never blocked', gateEnv);
check('verify-stop.js', stop('Chưa xong — còn phải chạy test.'), ALLOW, 'an honest "not done yet" is not a claim', gateEnv);
check('verify-stop.js', stop('Not done — the suite has not run.'), ALLOW, 'nor is it in English', gateEnv);
check('verify-stop.js', stop('Done.'), BLOCK, 'a bare "Done." is a claim like any other', gateEnv);
check('verify-stop.js', stop('Not done yet.'), ALLOW, 'but "not done yet" still is not', gateEnv);
check('verify-stop.js', stop('When done, run the gate and tell me.'), ALLOW, 'nor is the word inside a sentence', gateEnv);
check(
  'verify-stop.js',
  stop('Đã xong hết.', { stop_hook_active: true }),
  ALLOW,
  'never block twice — the harness caps it and ends the turn anyway',
  gateEnv,
);
/**
 * A sub-agent is not blocked. This assertion was reversed deliberately, with the
 * owner's agreement, and the argument belongs here because reversing a safety
 * check quietly is how one rots.
 *
 * The rule read the shared ledger, which cannot say *who* made a change.
 * `pending` is written by the PostToolUse hook for every edit in the session,
 * parent and sub-agent alike; `lastGreen` moves when the parent commits. So a
 * read-only sub-agent inherited a state it had no part in, had no diff to prove,
 * and was usually forbidden by its own brief from running the gate. Nothing it
 * could do would clear the block.
 *
 * A first attempt narrowed it to `pending.length === 0` and failed for the same
 * reason: `pending` held a file the *parent* had just edited, so every
 * sub-agent dispatched during ordinary work was still blocked. The data needed
 * to tell the two apart is not recorded anywhere.
 *
 * The cost was measured, not assumed. The message the hook blocks is the agent's
 * report; its next message answers the hook instead, and that is what reaches
 * the parent. Eleven reports were lost that way in one session across six
 * agents, two of which had to be dispatched again from nothing.
 *
 * Dropping it is safe because the requirement moves rather than disappears. A
 * sub-agent does not commit and does not ship. If it edited source, `pending`
 * names those files and the **parent** is stopped at its own Stop until the gate
 * has run over them. That is the pair asserted here: one ledger, one sentence,
 * sub-agent through and parent held.
 */
{
  check(
    'verify-stop.js',
    { ...stop('Xong rồi nhé.'), hook_event_name: 'SubagentStop', agent_type: 'qa-tester' },
    ALLOW,
    'a sub-agent is not held to a ledger that cannot say whose work it describes',
    gateEnv,
  );
  const run = check(
    'verify-stop.js',
    stop('Xong rồi nhé.'),
    BLOCK,
    '  while the parent making that same claim, on that same ledger, still is',
    gateEnv,
  );
  is(/agent\.js/.test(run.stderr || ''), '  and is told which file is unproven');
}

/**
 * A read-only sub-agent is not answerable for the session's commits.
 *
 * The ledger is shared, so a sub-agent dispatched to read and report inherits a
 * stamp the *parent* invalidated by committing. It has no diff to prove, and its
 * brief usually forbids running the gate — so the block had no action that could
 * clear it, and the agent's report was the message that got blocked. Its next
 * message answered the hook instead, and that is what reached the parent: nine
 * reports lost in one session, across six agents, every one recovered only by
 * asking again.
 *
 * Steering around it did not work either. `CLAIMS` contains a bare
 * `/\bverified\b/i`, which is the exact word an evidence-graded report carries.
 *
 * So a sub-agent is now held to the part of the ledger that can be about it:
 * `pending`, the files edited since the last green run. Nothing edited, nothing
 * to answer for. The case above still blocks, because there `pending` names a
 * file — a sub-agent that touched source is still stopped, and so is the parent
 * in this exact state, which is the pair that has to hold.
 */
{
  writeLedger({
    pending: [],
    lastGreen: { at: '2026-09-01T00:00:00Z', head: 'a'.repeat(40), dirty: 'stale', scope: 'full' },
  });

  check(
    'verify-stop.js',
    { ...stop('The audit pass is complete.'), hook_event_name: 'SubagentStop', agent_type: 'security-auditor' },
    ALLOW,
    'a sub-agent that edited nothing is not held to the parent\'s commits',
    gateEnv,
  );
  check(
    'verify-stop.js',
    { ...stop('Every finding is verified.'), hook_event_name: 'SubagentStop', agent_type: 'security-auditor' },
    ALLOW,
    'including when its report uses the word the guard matches on',
    gateEnv,
  );
  check(
    'verify-stop.js',
    stop('All done — the change is finished.'),
    BLOCK,
    'while the parent in the very same state is still stopped',
    gateEnv,
  );

  /*
   * And when a sub-agent *does* edit source, the requirement is not lost — it
   * lands on the parent, which is the only party that can discharge it. This is
   * the half that makes the reversal above safe rather than merely convenient,
   * so it is asserted rather than argued.
   */
  writeLedger({
    pending: [{ file: 'server/agent.js', at: '2026-09-01T00:00:00Z' }],
    lastGreen: { at: '2026-09-01T00:00:00Z', head: 'a'.repeat(40), dirty: 'stale', scope: 'full' },
  });
  check(
    'verify-stop.js',
    { ...stop('Implemented it, all tests pass.'), hook_event_name: 'SubagentStop', agent_type: 'backend-engineer' },
    ALLOW,
    'a sub-agent that edited source reports freely',
    gateEnv,
  );
  check(
    'verify-stop.js',
    stop('Implemented it, all tests pass.'),
    BLOCK,
    '  and the parent inherits the obligation for what it edited',
    gateEnv,
  );
}

clearLedger();
check('verify-stop.js', stop('Đã xong.'), ALLOW, 'a claim with nothing changed has nothing to prove', gateEnv);

writeLedger({ pending: [], lastGreen: { at: '2026-09-01T00:00:00Z', head: head(), dirty: dirtyHash(), scope: 'fast' } });
check('verify-stop.js', stop('All tests pass — ready to merge.'), BLOCK, 'a fast stamp is not the full gate', gateEnv);

writeLedger({ pending: [], lastGreen: { at: '2026-09-01T00:00:00Z', head: head(), dirty: dirtyHash(), scope: 'full' } });
check('verify-stop.js', stop('Hoàn thành, gate xanh.'), ALLOW, 'a current full stamp satisfies the claim', gateEnv);

writeLedger({ pending: [], lastGreen: { at: '2026-09-01T00:00:00Z', head: 'deadbeef', dirty: 'deadbeef', scope: 'full' } });
check('verify-stop.js', stop('Hoàn thành.'), BLOCK, 'a stamp from another commit has expired', gateEnv);
{
  // Three situations, three sentences. The first version said "0 file(s)
  // changed — the working tree" for the case below, which is neither the
  // number nor the reason: nothing had changed, the stamp had merely stopped
  // matching HEAD. A guard that misdescribes what it found is one people skim.
  const run = check(
    'verify-stop.js',
    stop('Xong rồi.'),
    BLOCK,
    'an expired stamp says so, rather than inventing a changed file',
    gateEnv,
  );
  is(/no longer matches this tree/.test(run.stderr || ''), '  and names the real reason', run.stderr);
  is(!/0 file/.test(run.stderr || ''), '  without claiming zero files changed');
}

writeLedger(unproven);
{
  const run = check('verify-stop.js', stop('Done.'), BLOCK, 'a real pending file is named instead', gateEnv);
  is(/server[\\/]agent\.js/.test(run.stderr || ''), '  by name', run.stderr);
}

/* ---------------------------------------------------------------------------
 * Context preservation.
 * ------------------------------------------------------------------------- */

console.log('\n[1mjournal[0m');
const transcript = path.join(sandbox, 'transcript.jsonl');
fs.writeFileSync(
  transcript,
  [
    JSON.stringify({
      type: 'user',
      promptSource: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Build the thing, keep it on a branch.' }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'transcript noise' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Write the failing test', status: 'completed' },
                { content: 'Make it pass', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    }),
    '{ this line is not json',
    '',
  ].join('\n'),
);

clearLedger();
check(
  'journal.js',
  { hook_event_name: 'PreCompact', trigger: 'auto', transcript_path: transcript },
  ALLOW,
  'writing the journal before a compaction',
  gateEnv,
);
{
  const journal = fs.readFileSync(path.join(sandbox, 'journal.md'), 'utf8');
  is(/keep it on a branch/.test(journal), 'the instruction survives');
  is(!/transcript noise/.test(journal), 'tool results do not');
  is(/Make it pass/.test(journal), 'and so does the task list');
}
check(
  'journal.js',
  { hook_event_name: 'PreCompact', trigger: 'manual', transcript_path: path.join(sandbox, 'nope.jsonl') },
  ALLOW,
  'a missing transcript is survivable',
  gateEnv,
);
check('journal.js', { hook_event_name: 'PreCompact', trigger: 'auto' }, ALLOW, 'so is no transcript at all', gateEnv);

console.log('\n[1mbrief[0m');
{
  const run = check('brief.js', { hook_event_name: 'SessionStart', source: 'startup' }, ALLOW, 'briefing a new session', gateEnv);
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout.trim());
  } catch {
    parsed = null;
  }
  is(parsed?.hookSpecificOutput?.hookEventName === 'SessionStart', 'it answers with the event name the harness requires');
  is(/Branch/.test(parsed?.hookSpecificOutput?.additionalContext || ''), 'and says which branch this is');
  is(Boolean(parsed?.hookSpecificOutput?.sessionTitle), 'and titles the session');
}

/*
 * The briefing has to describe the fence the guard is actually enforcing.
 *
 * It did not. `brief.js` built its own sentence and said "commits here are
 * blocked by guard-bash.js" on every protected branch, unconditionally — so once
 * `AI_REMOTE_ALLOW_MAIN` existed, every session opening on `main` was told a
 * stop was in place that the guard was letting straight through. Both files read
 * `branch.js` now, and these three cases are the reason it exists: the same
 * branch, the same command, two switch states, and the sentence has to move with
 * the guard rather than beside it.
 *
 * Each case states its environment rather than inheriting one. That is CFG-011's
 * lesson: this repo sets the switch in `.claude/settings.json`, so a spread of
 * `process.env` would have handed it to the very check that proves it is off.
 */
{
  const briefOn = (branch, allow) => {
    const env = { ...gateEnv, CLAUDE_GUARD_BRANCH: branch };
    if (allow === undefined) delete env.AI_REMOTE_ALLOW_MAIN;
    else env.AI_REMOTE_ALLOW_MAIN = allow;
    const run = check(
      'brief.js',
      { hook_event_name: 'SessionStart', source: 'startup' },
      ALLOW,
      `briefing on \`${branch}\` with the switch ${allow === undefined ? 'unset' : `= ${allow}`}`,
      env,
    );
    try {
      return JSON.parse(run.stdout.trim())?.hookSpecificOutput?.additionalContext || '';
    } catch {
      return '';
    }
  };

  const lifted = briefOn('main', '1');
  is(/protection is LIFTED/.test(lifted), 'with the switch on it says the protection is lifted');
  is(!/commits here are blocked/.test(lifted), 'and does not claim commits are blocked');

  const fenced = briefOn('main');
  is(/commits here are blocked/.test(fenced), 'with the switch unset it says commits are blocked');
  is(!/LIFTED/.test(fenced), 'and does not claim the fence is open');

  is(/commits here are blocked/.test(briefOn('master', '0')), '`0` is not consent, and master is protected too');

  const feature = briefOn('audit/some-branch', '1');
  is(!/LIFTED|blocked/.test(feature), 'an ordinary branch gets neither sentence, switch or no switch');

  /*
   * The point of the whole change, stated as one assertion: whatever the guard
   * does with `git commit` on this branch, the briefing must be describing that
   * same behaviour. If these two ever disagree again, this is the check that
   * says so.
   */
  for (const allow of ['1', undefined]) {
    const env = { ...gateEnv, CLAUDE_GUARD_BRANCH: 'main' };
    if (allow === undefined) delete env.AI_REMOTE_ALLOW_MAIN;
    else env.AI_REMOTE_ALLOW_MAIN = allow;
    const guard = spawnSync(process.execPath, [path.join(here, 'guard-bash.js')], {
      input: JSON.stringify(bash('git commit -m "x"')),
      encoding: 'utf8',
      cwd: root,
      timeout: 90_000,
      env,
    });
    const guardAllows = guard.status === ALLOW;
    const briefSaysAllowed = /protection is LIFTED/.test(briefOn('main', allow));
    is(
      guardAllows === briefSaysAllowed,
      `guard and briefing agree on main with the switch ${allow === undefined ? 'unset' : `= ${allow}`}`,
    );
  }
}
{
  const run = check(
    'brief.js',
    { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'did things' },
    ALLOW,
    'briefing after a compaction',
    gateEnv,
  );
  const parsed = JSON.parse(run.stdout.trim());
  is(
    /keep it on a branch/.test(parsed.hookSpecificOutput.additionalContext),
    'the journal comes back after the window folds',
  );
}

console.log('\n[1mrecover[0m');
{
  const run = check(
    'recover.js',
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'listen EADDRINUSE: address already in use :::5173' },
    ALLOW,
    'a held port',
  );
  is(/5173/.test(run.stdout), 'gets the answer this repo already knows');
}
{
  const run = check(
    'recover.js',
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'something nobody has ever seen' },
    ALLOW,
    'an unrecognised failure',
  );
  is(run.stdout.trim() === '', 'gets silence rather than a guess');
}
{
  const run = check(
    'recover.js',
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'EADDRINUSE', is_interrupt: true },
    ALLOW,
    'an interrupt',
  );
  is(run.stdout.trim() === '', 'is a person changing their mind, not a fault');
}

/* ---------------------------------------------------------------------------
 * Fail-open. A hook that throws on strange input wedges the session, and the
 * fix for that is always to delete the hook — so it must not throw.
 * ------------------------------------------------------------------------- */

console.log('\n[1mfail-open[0m');
for (const hook of [
  'guard-bash.js',
  'guard-write.js',
  'lint-changed.js',
  'ledger.js',
  'verify-stop.js',
  'journal.js',
  'brief.js',
  'recover.js',
]) {
  const run = spawnSync(process.execPath, [path.join(here, hook)], {
    input: 'not json at all {{{',
    encoding: 'utf8',
    cwd: root,
    timeout: 90_000,
    env: gateEnv,
  });
  is(run.status === ALLOW, `${hook} survives garbage on stdin`, run.stderr);
}

try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* a leftover temp directory is not a test failure */
}

/* ── a heredoc body is data, not a command ─────────────────────── */

{
  // Every rule tests the raw command text, so a word inside something being
  // *written to a file* read exactly like a word being *run*. During the audit
  // that produced this, the guard blocked two read-only calls: a grep whose
  // search pattern contained the words, and a `cat > file <<EOF` whose document
  // body mentioned publishing. That is the failure this file's header warns
  // about — a guard that blocks legitimate work gets switched off.
  const { withoutHeredocs } = await import('./guard-bash.js');

  // Assembled rather than written out, because this file is read by the guard
  // when the suite itself is run from a shell.
  const trigger = ['npm', 'publish'].join(' ');
  const sees = (cmd) => /\bnpm\s+publish\b/.test(withoutHeredocs(cmd));

  is(!sees(`cat > a.md <<'EOF'\n${trigger}\nEOF\necho done`), 'a heredoc body is not read as a command');
  is(!sees(`cat <<-EOF\n${trigger}\nEOF`), 'and <<- is handled the same way');
  is(sees(trigger), 'a real command is still caught');
  is(sees(`cat > a.md <<'EOF'\nharmless\nEOF\n${trigger}`), 'and so is one after a heredoc');

  // Quoted text is deliberately NOT stripped: `bash -c "..."` is a real command
  // inside quotes, and removing quoted text would be a hole rather than a fix.
  is(sees(`bash -c "${trigger}"`), 'a quoted command is still caught');
  is(sees(`cat <<'EOF'\n${trigger}`), 'an unterminated heredoc is left alone');
}

/* ── the fingerprint must agree with isSource ───────────────────── */

{
  // dirtyHash hashed the whole of `git status --porcelain`, which contradicted
  // isSource twenty lines below it — and isSource exists to say a README is not
  // worth the full suite. So note() honoured the exemption and dirtyHash did
  // not: one line of documentation expired the stamp and demanded a full re-run,
  // the exact behaviour the comment on NOT_SOURCE warns gets a gate switched off.
  const gate = await import('./gate.js');

  const baseline = gate.dirtyHash();

  const doc = path.join(root, 'audit', `hooks-test-scratch-${process.pid}.md`);
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, '# written by hooks.test.mjs\n');
  const afterDoc = gate.dirtyHash();

  const src = path.join(root, `hooks-test-scratch-${process.pid}.js`);
  fs.writeFileSync(src, '// written by hooks.test.mjs\n');
  const afterSrc = gate.dirtyHash();

  fs.rmSync(doc, { force: true });
  fs.rmSync(src, { force: true });
  const restored = gate.dirtyHash();

  is(afterDoc === baseline, 'a new .md does not expire the stamp', `${baseline} -> ${afterDoc}`);
  is(afterSrc !== baseline, 'a new .js does', `${baseline} -> ${afterSrc}`);
  is(restored === baseline, 'and removing them puts the fingerprint back', `${baseline} -> ${restored}`);

  /**
   * The stamp is judged on what the source *is*, not where it sits (CFG-020).
   *
   * Edit, run the gate, commit: the gate fingerprinted the files while dirty,
   * the commit moved the identical bytes into HEAD, and both `head` and `dirty`
   * then reported a change. The stamp was thrown away straight after the only
   * run that covered the code, five times in one audit. `contentHash` hashes
   * each source file's blob on disk with its path, so a commit changes nothing
   * and an edit changes everything.
   *
   * The decisive assertion is the one with a fake `head` and a stale `dirty`: if
   * position still mattered, that stamp would read as out of date.
   */
  const content = gate.contentHash();
  is(/^[0-9a-f]{16}$/.test(content), 'the content fingerprint can be taken', content);
  is(gate.contentHash() === content, '  and is stable for an unchanged tree');

  const docAgain = path.join(root, 'audit', `hooks-test-content-${process.pid}.md`);
  fs.writeFileSync(docAgain, '# scratch\n');
  const withDoc = gate.contentHash();
  fs.rmSync(docAgain, { force: true });
  is(withDoc === content, '  documentation does not move it');

  const srcAgain = path.join(root, `hooks-test-content-${process.pid}.js`);
  fs.writeFileSync(srcAgain, '// scratch\n');
  const withSrc = gate.contentHash();
  fs.rmSync(srcAgain, { force: true });
  is(withSrc !== content, '  a new source file does');
  is(gate.contentHash() === content, '  and removing it restores it');

  const savedState = process.env.CLAUDE_GATE_STATE;
  process.env.CLAUDE_GATE_STATE = sandbox;
  // The sandbox is cleaned up by an earlier section; recreated here rather than
  // relying on section order, which is how this test first failed.
  fs.mkdirSync(sandbox, { recursive: true });
  try {
    writeLedger({
      pending: [],
      lastGreen: { at: '2026-09-01T00:00:00Z', head: 'f'.repeat(40), dirty: 'stale', content, scope: 'full' },
    });
    const moved = gate.status();
    is(moved.current === true, 'a stamp over identical content stands whatever head and dirty say', JSON.stringify({ current: moved.current }));
    is(moved.verified === true, '  so work that was tested and then committed is still verified');

    writeLedger({
      pending: [],
      lastGreen: { at: '2026-09-01T00:00:00Z', head: gate.head(), dirty: gate.dirtyHash(), content: '0'.repeat(16), scope: 'full' },
    });
    is(gate.status().current === false, 'while different content fails even with head and dirty matching');
  } finally {
    if (savedState === undefined) delete process.env.CLAUDE_GATE_STATE;
    else process.env.CLAUDE_GATE_STATE = savedState;
    // Recreated above, so removed again here — otherwise every run of the suite
    // leaves a directory behind in the temp folder.
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  /**
   * The exemption has to survive being committed.
   *
   * `dirtyHash` above filters through `isSource`, so editing a README does not
   * expire the stamp. `status()` also compared `head()` raw, and a commit hash
   * knows nothing about what is inside it — so the exemption held right until
   * you saved your work and then vanished. In this repository, where an audit
   * commits documentation constantly, that cost four full runs of the
   * thirty-one suites in one session, for markdown. The comment on NOT_SOURCE
   * says where that leads: it is how a gate earns its way into being switched
   * off.
   *
   * Driven against real commits in this checkout rather than synthesised, since
   * the whole question is what `git diff --name-only A..B` says about them.
   * HEAD~1..HEAD is whatever was committed last; the pair below asks the
   * question of two commits that are known to differ in a `.js` file, and of a
   * commit against itself.
   */
  is(
    gate.status().current !== undefined,
    'status() answers whether the stamp still describes this tree',
  );

  const changedSince = (from) => {
    const out = spawnSync('git', ['diff', '--name-only', `${from}..HEAD`], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    if (out.status !== 0) return null;
    return String(out.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  };

  const selfDiff = changedSince('HEAD');
  is(Array.isArray(selfDiff) && selfDiff.length === 0, 'a commit differs from itself in nothing');

  // An unknown ref must read as "changed", never as "nothing changed" — the
  // stamped commit can be rebased away or amended, and guessing "clean" there
  // would certify code no run has covered.
  is(changedSince('0000000000000000000000000000000000000000') === null,
    'and an unresolvable ref is an error, not an empty answer');

  // stamp() must be able to record a fingerprint taken before the suites ran.
  // Taking it afterwards certified whatever happened to be on disk when the run
  // finished — including anything edited while it was running, which for a run
  // that takes minutes is a wide door.
  is(gate.stamp.length >= 1, 'stamp() takes the fingerprint that was tested');

  // A file outside the project is not project source. `startsWith('..')` is the
  // right test on one filesystem and silently the wrong one across two: on
  // Windows path.relative cannot express a different drive as `..`, so it
  // returns an absolute path instead and the escape check waved it through.
  // Found live — a scratch file under the system temp directory turned up in
  // the pending list and verify-stop then refused a completion claim over it.
  is(!gate.isSource('C:\\Users\\someone\\Temp\\scratch.mjs'), 'an absolute Windows path is not project source');
  is(!gate.isSource('/tmp/scratch.mjs'), 'nor an absolute POSIX one');
  is(!gate.isSource('../elsewhere/x.js'), 'nor one above the root');
  is(gate.isSource('server/agent.js'), 'but a real relative path still is');
}

/* ── the gate must cover what CI blocks a merge on ─────────────── */

{
  // The gate stamped a tree green while typecheck was red, because STEPS.full
  // never ran typecheck. That is the exact failure this directory exists to
  // prevent: a stamp saying "verified" about a tree CI will reject.
  //
  // Pinned by reading the file rather than by running the gate — a real run is
  // minutes long, and this check has to be cheap enough to stay in the suite.
  const gateSource = fs.readFileSync(path.join(here, 'gate.js'), 'utf8');
  const full = /full: \[([\s\S]*?)\],\r?\n\};/.exec(gateSource)?.[1] || '';

  is(/'lint'/.test(full), 'the full gate runs lint');
  is(/'typecheck'/.test(full), 'the full gate runs typecheck — the step it used to skip', full);
  is(/'eval'/.test(full), 'the full gate runs the agent eval');
  is(/'test:hooks'/.test(full), 'the full gate runs the hook suite');
  is(/\['test'\]/.test(full), 'the full gate runs the suites');

  // The fast gate is allowed to be small, but it must not quietly grow into the
  // full one — verify-stop.js depends on the two meaning different things.
  const fast = /fast: \[([\s\S]*?)\],/.exec(gateSource)?.[1] || '';
  is(!/'typecheck'/.test(fast), 'and the fast gate stays fast');
}

console.log(
  failed === 0
    ? `\n[32mAll ${passed} hook checks passed.[0m\n`
    : `\n[31m${failed} of ${passed + failed} hook checks failed.[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);
