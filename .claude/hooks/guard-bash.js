#!/usr/bin/env node
/**
 * PreToolUse guard for Bash / PowerShell calls.
 *
 * CLAUDE.md §2 draws the line plainly: a risk that can happen at any moment must
 * not merely be written down, it has to be enforced by code. A rule in a prompt
 * is a rule the model can talk itself out of at 2am on turn ninety; a non-zero
 * exit code is not.
 *
 * Exit 2 blocks the call and hands stderr back to the model as the reason, which
 * is why every message below says what to do instead rather than just "no".
 *
 * Deliberately narrow. A guard that blocks half of what a developer legitimately
 * types gets switched off within a week, and then it protects nothing at all.
 */

import process from 'node:process';

/**
 * The fence around `main` — its definition, its switch, and how to ask which
 * branch this is — now lives in `branch.js`, because `brief.js` announces the
 * same fact and used to decide it independently. It got it wrong the moment the
 * switch was added: see the header there, and CFG-012.
 *
 * `currentBranch` returns '' when git cannot answer, and every rule below that
 * uses it fails open on that. A guard that blocks because it could not run `git`
 * is a guard that blocks in a worktree, in a fresh clone, and on the day git is
 * slow — which is to say, a guard that gets removed.
 */
import { PROTECTED_BRANCH, mainWritesAllowed, currentBranch } from './branch.js';

/**
 * Does this `git push` write to the protected branch?
 *
 * The first version asked a regex whether the command ended in `main`, which
 * caught `git push origin main` and let `git push origin HEAD:main` straight
 * through — along with `agency-autonomy-spine:main` and `refs/heads/main`. Three
 * ways to do the one thing the rule exists to prevent, and the rule looked fine
 * the whole time. A guard has to be read the way git reads it, not the way the
 * usual command happens to be written.
 *
 * So the refspecs are actually parsed. In `src:dst` it is `dst` that decides;
 * a bare token is both. `:main` deletes the remote branch, which is the same
 * question and a worse answer.
 */
function pushesToProtected(command) {
  const after = /\bgit\s+push\b([^\n|;&]*)/.exec(command)?.[1];
  if (after === undefined) return false;

  return after
    // A trailing comment is not a refspec. `git push origin dev # merge to main
    // later` writes nothing to main, and blocking it is the kind of false
    // positive that gets a guard switched off.
    .split('#')[0]
    .trim()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('-'))
    .some((token) => {
      // `src:dst` — the destination is what gets written. A bare name is both.
      const destination = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token;
      const name = destination.replace(/^\+/, '').replace(/^refs\/heads\//, '');
      return PROTECTED_BRANCH.test(name);
    });
}

/**
 * The command as the shell splits it: `{ text, quoted }` words with their
 * quotes taken off, and a `null` wherever an unquoted `;`, `&`, `|`, newline,
 * `(`, `)` or backtick ends one command — so `(git …)`, `$(git …)` and
 * `` `git …` `` are commands of their own (CFG-036). A PowerShell here-string,
 * `@'…'@` or `@"…"@`, is one quoted word: an apostrophe inside it ends nothing.
 */
function shellWords(command) {
  const words = [];
  let word = null;
  let quoted = false;
  let quote = '';
  const end = () => {
    if (word !== null) words.push({ text: word, quoted });
    word = null;
    quoted = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else word += ch;
    } else if (ch === '@' && (command[i + 1] === "'" || command[i + 1] === '"') && command[i + 2] === '\n') {
      const close = command.indexOf(`\n${command[i + 1]}@`, i + 2);
      const stop = close < 0 ? command.length : close;
      end();
      words.push({ text: command.slice(i + 3, stop), quoted: true });
      i = close < 0 ? command.length : close + 2;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      word ??= '';
    } else if (/[;&|\n()`]/.test(ch)) {
      end();
      words.push(null);
    } else if (/\s/.test(ch)) {
      end();
    } else {
      word = (word ?? '') + ch;
    }
  }
  end();
  return words;
}

// Options of git itself, before its subcommand, that take the next word as their value.
const GIT_VALUE_OPTIONS = /^(-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;
// commit's short options that take a value — the rest of their group, or the next word.
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't']);
const COMMIT_VALUE_LONG = /^--(message|file|reuse-message|reedit-message|author|date|template|fixup|squash|trailer|cleanup)$/;

/**
 * Does this command run a git step past the repo's hooks (CFG-034…036)?
 *
 * Read the way git reads it, as `pushesToProtected` reads a push: git's own
 * options skipped to find the subcommand, and the value of `-m`, `-F` and the
 * like skipped as data — so a message that names the flag is not the flag,
 * while `git commit "--no-verify"` (quotes the shell takes off) still is.
 * Blocked: `--no-verify` and every prefix git would take for it (`--no-veri`
 * on; shorter ones are ambiguous with `--no-verbose`), and for `commit`, `-n`
 * in a group of short flags — read a letter at a time, as git does, so `-Ft
 * -n` is `-F t` and then `-n`, and `-mnote` is the message "note". A quoted
 * word with spaces that is not such a value is read again as a command
 * (`bash -c "git …"`), and so is an alias defined on the spot with `-c`.
 */
export function skipsHooks(command, depth = 0) {
  if (depth > 3) return false;
  const words = shellWords(String(command || ''));
  const values = new Set();
  const text = (k) => (words[k] ? words[k].text : null);
  for (let start = 0; start < words.length; start += 1) {
    if (!words[start] || !/(^|[\\/])git(\.exe)?$/i.test(words[start].text)) continue;
    let i = start + 1;
    while (text(i)?.startsWith('-')) {
      if (!GIT_VALUE_OPTIONS.test(text(i))) {
        i += 1;
        continue;
      }
      values.add(i + 1);
      const alias = /^alias\.[^=]+=(.+)$/s.exec(text(i + 1) || '');
      if (text(i) === '-c' && alias && skipsHooks(`git ${alias[1]}`, depth + 1)) return true;
      i += 2;
    }
    const sub = text(i);
    if (!/^(commit|push|merge|rebase|am|cherry-pick|revert|pull)$/.test(sub || '')) continue;
    for (let j = i + 1; text(j) !== null; j += 1) {
      const word = text(j);
      const name = word.split('=')[0];
      if (name.length >= '--no-veri'.length && '--no-verify'.startsWith(name)) return true;
      if (sub !== 'commit') continue;
      if (/^-[a-zA-Z]/.test(word) && !word.startsWith('--')) {
        for (let k = 1; k < word.length; k += 1) {
          if (word[k] === 'n') return true;
          if (COMMIT_VALUE_SHORT.has(word[k])) {
            if (k === word.length - 1) values.add((j += 1));
            break;
          }
        }
      } else if (COMMIT_VALUE_LONG.test(word)) {
        values.add((j += 1));
      }
    }
  }
  return words.some((w, k) => w?.quoted && /\s/.test(w.text) && !values.has(k) && skipsHooks(w.text, depth + 1));
}

/**
 * The command with heredoc *bodies* removed, so rules match commands and not data.
 *
 * Every rule below tests the raw text, which means a word inside something being
 * *written to a file* reads exactly like a word being *run*. This blocked two
 * genuinely read-only calls during the audit that produced this change: a `grep`
 * whose search pattern contained the words, and a `cat > file <<'EOF'` whose
 * document body mentioned publishing to a registry. Neither was a command.
 *
 * That is the failure mode this file's own header warns about — a guard that
 * blocks what a developer legitimately types gets switched off, and then it
 * protects nothing.
 *
 * Only heredoc bodies are stripped, and only between the delimiter that opens
 * one and the line that closes it. Quoted strings are deliberately left alone:
 * `bash -c "git push origin main"` is a real command inside quotes, and removing
 * quoted text would be a genuine hole rather than a cosmetic one.
 *
 * The residual gap, stated plainly: a heredoc can write a script that is run
 * afterwards, and that run is not caught here. It never was — `bash script.sh`
 * does not name what is inside the script — so this narrows false positives
 * without widening what actually gets through.
 */
export function withoutHeredocs(command) {
  const text = String(command || '');
  // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` — the delimiter is what closes it.
  const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

  let out = '';
  let at = 0;
  let match;
  while ((match = opener.exec(text))) {
    const tag = match[2];
    // The body starts on the line after the line the opener sits on.
    const lineEnd = text.indexOf('\n', opener.lastIndex);
    if (lineEnd === -1) break;

    const close = new RegExp(`^\\s*${tag}\\s*$`, 'm');
    const rest = text.slice(lineEnd + 1);
    const found = close.exec(rest);
    if (!found) break;

    out += text.slice(at, lineEnd + 1);
    at = lineEnd + 1 + found.index + found[0].length;
    opener.lastIndex = at;
  }
  return out + text.slice(at);
}

/** Each rule is [pattern-or-predicate, why]. `why` is read by the model, so it must be actionable. */
const RULES = [
  [
    /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/,
    'Recursive force-delete. Delete the specific paths you mean, or ask the user to run it themselves.',
  ],
  [
    // `--force-with-lease` must survive this, or the guard blocks the exact fix
    // its own message recommends — so `--force` needs the lookahead. `\b` alone
    // does not do it: the boundary matches at the hyphen.
    /\bgit\s+push\b[^\n|;&]*\s(--force(?!-with-lease)|-f)\b/,
    'Force-push rewrites published history. Use --force-with-lease, and only on a branch you own.',
  ],
  [
    /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)\b/,
    'This throws away uncommitted work irreversibly. Stash it first (git stash -u), then decide.',
  ],
  [
    /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    'Dropping a table or database destroys user data. Write a migration in server/store/schema.sql instead.',
  ],
  [
    /\bTRUNCATE\s+/i,
    'TRUNCATE empties a table with no undo. If this is a test fixture, scope it to the test database.',
  ],
  [
    // The local Postgres cluster lives here. Deleting it destroys every local
    // account, chat and stored key, and none of it is anywhere else.
    /\b(rm|rmdir|del|Remove-Item)\b[^\n|;&]*\bdata[\\/](pgdata|owner\.pid)/i,
    'data/pgdata is the local Postgres cluster — every account, chat and encrypted key lives there. Deleting it is not recoverable.',
  ],
  [
    /\b(rm|del|Remove-Item)\b[^\n|;&]*(^|[\s"'\\/])\.env(\s|$|["'])/i,
    '.env holds SESSION_SECRET and ENCRYPTION_KEY. Losing ENCRYPTION_KEY makes every stored provider key permanently undecryptable.',
  ],
  [
    // Naming the protected branch as a destination reaches it from any branch.
    // Matched by parsing the refspecs rather than by pattern — see
    // `pushesToProtected`, and the three commands that walked past the pattern.
    (command) => !mainWritesAllowed() && pushesToProtected(command),
    'This pushes to the protected branch. Push the feature branch instead, and let the user decide what lands on main. '
      + '(The owner can lift this by setting AI_REMOTE_ALLOW_MAIN=1 in .claude/settings.json under `env`.)',
  ],
  [
    /\bnpm\s+publish\b/,
    'This package is private and unpublished. Publishing it would push the whole workspace to the public registry.',
  ],
  [
    /**
     * Cutting a release is publishing, and it was not covered.
     *
     * `npm publish` was blocked and everything beside it was not. Three
     * installed skills drive exactly these commands — `claude-mem:version-bump`
     * tags, releases and publishes; `superpowers:finishing-a-development-branch`
     * decides how work integrates; `gitnexus-work` gates its own commits — and a
     * decision recorded in `audit/SKILL_MAP.md` is a note, not a guard. CLAUDE.md
     * §2 is explicit that a risk which can happen at any moment belongs in code
     * rather than in prose.
     *
     * `git tag` is deliberately still allowed: this audit's own safety net is a
     * backup tag, and a local tag publishes nothing. Pushing one does, and that
     * is what `--tags` covers.
     */
    /\b(gh\s+(release|pr\s+merge)|npm\s+version|git\s+push[^\n|;&]*--tags)\b/,
    'Cutting or publishing a release is the owner\'s call, not an automated step. '
      + 'Local work and `git tag` are fine; announcing it is not. Say it is ready instead.',
  ],
  [
    /\bvercel\s+(deploy|--prod|env\s+rm)\b/,
    'Deploying or removing production env vars is the user\'s call, not an automated step. Ask first.',
  ],
  [
    // CFG-034: skipping the repo's own checks. No git hook exists today, but the
    // day one does, this flag is how an agent would walk past it — and the
    // owner's rules forbid it outright. Parsed, not matched — see `skipsHooks`.
    (command) => skipsHooks(command),
    'Skipping the repo\'s hooks (--no-verify) is not allowed. Fix what the hook reports and commit again.',
  ],
];

/**
 * Rules that apply only while HEAD is on `main` or `master`.
 *
 * The working agreement for an unattended run is: change code, run the gate,
 * commit — on a branch of its own. Merging, pushing and deploying stay with the
 * user. Written down, that agreement lasts until the first turn that finds it
 * inconvenient; here, it is an exit code.
 *
 * Note what is *not* here. Pushing a feature branch is not blocked — it is
 * simply absent from the allowlist in settings.json, so it asks. Blocking is for
 * what should never happen unattended; asking is for what needs a human present.
 */
const BRANCH_RULES = [
  [
    /\bgit\s+commit\b/,
    'This would commit straight onto the protected branch. Create a branch first (git checkout -b <name>), commit there, and let the user decide what lands.',
  ],
  [
    /\bgit\s+merge\b/,
    'Merging into the protected branch is the user\'s call. Leave the work on its branch and say it is ready.',
  ],
  [
    /\bgit\s+push\b/,
    'Pushing the protected branch publishes history the user has not reviewed. Push a feature branch instead — that asks rather than blocks.',
  ],
];

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  let rawCommand = '';
  let cwd = process.cwd();
  try {
    const payload = JSON.parse(raw || '{}');
    // Bash uses `command`; the PowerShell tool uses the same field name.
    rawCommand = String(payload.tool_input?.command || '');
    cwd = String(payload.cwd || process.cwd());
  } catch {
    // A guard that crashes on unexpected input must fail open, not wedge every
    // shell call in the session.
    process.exit(0);
  }

  /**
   * Every refusal also says what to do if the match was data rather than a
   * command (CFG-021).
   *
   * This guard reads command text. It cannot tell `rm -rf build` from a
   * sentence *about* `rm -rf` being written into a file by `node -e` or
   * `printf`, and there is no safe way to teach it: `node -e "…execSync('rm -rf
   * ~')"` is a real command inside quotes, and so is `bash -c "…"`. Stripping
   * quoted text would open exactly the door the rules exist to close, so the
   * rules are not loosened. Heredoc bodies are the one case that is
   * unambiguously data, and those are already removed (CFG-002).
   *
   * What was wrong was the dead end. Refused twice during this audit while
   * writing documentation about these very rules, the only useful next step was
   * to use the Edit or Write tool — which is the right way to put text in a file
   * anyway, and never passes through this hook. Saying so turns a false
   * positive into a direction instead of into pressure to switch the guard off.
   */
  const refuse = (why) => {
    process.stderr.write(
      `Blocked by .claude/hooks/guard-bash.js\n\n${why}\n\n`
        + 'If this command only writes text that mentions these words into a file, it is data, not a command — '
        + 'but this guard reads command text and cannot tell the difference. Write the file with the Edit or '
        + 'Write tool instead; do not rephrase the command to get past the match.\n',
    );
    process.exit(2);
  };

  // Rules read the command with heredoc *bodies* removed. See `withoutHeredocs`.
  const command = withoutHeredocs(rawCommand);

  // Most rules are a pattern; one needs to read the command the way git does,
  // so a rule may also be a predicate.
  for (const [rule, why] of RULES) {
    const hit = typeof rule === 'function' ? rule(command) : rule.test(command);
    if (hit) refuse(why);
  }

  // Only ask git which branch this is once something git-shaped has been typed —
  // most commands are not, and a subprocess on every shell call is a tax paid
  // all day for a rule that applies to a handful of them.
  if (!mainWritesAllowed() && /\bgit\s+(commit|merge|push)\b/.test(command)) {
    const branch = currentBranch(cwd);
    if (PROTECTED_BRANCH.test(branch)) {
      for (const [pattern, why] of BRANCH_RULES) {
        if (pattern.test(command)) refuse(`On branch \`${branch}\`. ${why}`);
      }
    }
  }

  process.exit(0);
});
