import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveInWorkspace, workspace, moveWorkspace, rel, fullDiskAccess } from './paths.js';
import { BROWSER_IMPLEMENTATIONS, browserIsOpen, browserSnapshot, renderPdf, renderImage } from './browser.js';
import { BACKGROUND_IMPLEMENTATIONS } from './background.js';
import { killTree } from './kill.js';

/**
 * Hand a URL or a path to the desktop's default handler, without a shell.
 *
 * This used to be `spawn('cmd', ['/c', 'start', '', target])` on Windows, and
 * that is a command injection. Node does not escape cmd.exe metacharacters: it
 * quotes an argument only when it contains a space, a tab or a quote, so a
 * target like `https://example.com/x&calc` — which passes the `^https?://`
 * test and contains none of those — reached the command line verbatim, and
 * cmd.exe split it at the bare `&` and ran the second half. The model can be
 * talked into calling `open_url` by any page it reads, so the attacker input
 * is a web page, not the user.
 *
 * Quoting the target would work and is fragile: `&` is legitimate and common in
 * real URLs (`?v=x&t=30`), so it cannot simply be rejected, and `%` expansion
 * survives quotes. Removing cmd.exe removes the entire class instead.
 * `rundll32 url.dll,FileProtocolHandler` is what the shell itself calls for a
 * double-click, takes the target as its own argv entry, and never parses it.
 *
 * Control characters are refused outright: nothing legitimate carries them, and
 * a newline is the one thing that could still confuse an argv boundary.
 */
/**
 * @param {string} target
 * @returns {[string, string[]]} the program and its argv, as a tuple rather than
 *   a mixed array — spawn() takes them as separate arguments and a plain array
 *   types both slots as string|string[].
 */
function openCommand(target) {
  // A newline is the one character that could still confuse an argv boundary,
  // and nothing legitimate carries control characters. Checked by code point
  // rather than a regex so the source stays readable ASCII.
  if ([...target].some((ch) => ch.codePointAt(0) < 0x20)) {
    throw new Error('That address contains control characters and was not opened.');
  }
  if (process.platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', target]];
  if (process.platform === 'darwin') return ['open', [target]];
  return ['xdg-open', [target]];
}
import { safeFetch } from '../server/util/safeFetch.js';
import { sniffPicture, viewCopy, PICTURE_EXTENSIONS } from '../server/util/picture.js';
import { DESKTOP_IMPLEMENTATIONS, desktopAllowed } from './desktop.js';
import { SYSTEM_IMPLEMENTATIONS } from './system.js';
import { INDEX_IMPLEMENTATIONS } from './indexer.js';

const MAX_OUTPUT = 60_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', '__pycache__', '.cache']);

const clip = (text) =>
  text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n\n[output truncated — ${text.length - MAX_OUTPUT} more characters]`
    : text;

/** Minimal glob → RegExp. Supports `**`, `*`, `?` and `{a,b}`. */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

async function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, depth + 1);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// ── implementations ───────────────────────────────────────────────────

async function listDir({ path: target = '.' }) {
  const abs = resolveInWorkspace(target);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  if (!entries.length) return `${rel(abs)}/ is empty.`;

  const rows = await Promise.all(
    entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(async (e) => {
        if (e.isDirectory()) return `  ${e.name}/`;
        const stat = await fsp.stat(path.join(abs, e.name)).catch(() => null);
        return `  ${e.name}${stat ? `  (${stat.size} bytes)` : ''}`;
      }),
  );
  return `${rel(abs)}/\n${rows.join('\n')}`;
}

/** Past this a picture is not opened at all — the same ceiling as edit_image. */
const MAX_PICTURE_BYTES = 40 * 1024 * 1024;
/**
 * What a picture may weigh going up as it is, when this machine cannot shrink
 * it: its base64 stays under a serverless function's 4.5MB request limit.
 */
const MAX_PICTURE_POST = 2560 * 1024;

const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * A picture, as a picture (owner, 2026-10-19).
 *
 * `read_file` used to read a PNG as UTF-8 and hand the model a page of
 * replacement characters. It hands over the picture now: the server keeps it,
 * shows it in the run, and has a model that can see read it in the same step
 * — one "Read Figure_4.png", the way Claude's Read works.
 *
 * @returns {Promise<{ text: string, shot: { data: string, mime: string, name: string } } | null>}
 *   null when the bytes are not a picture after all, and it is read as text.
 */
async function readPicture(abs, stat) {
  const bytes = await fsp.readFile(abs);
  const format = sniffPicture(bytes);
  if (!format) return null;
  const copy = await viewCopy(bytes).catch((err) => {
    throw new Error(`${rel(abs)}: ${err.message}`);
  });
  if (!copy) return null;
  if (copy.data.length > MAX_PICTURE_POST) {
    throw new Error(
      `${rel(abs)} is a picture of ${sizeOf(stat.size)} that could not be made smaller on this computer. ` +
        'Make a smaller copy with edit_image and read that.',
    );
  }
  const size = copy.width ? `${copy.width}×${copy.height}, ` : '';
  return {
    text: `${rel(abs)} is a picture (${format.split('/')[1].toUpperCase()}, ${size}${sizeOf(stat.size)}).`,
    shot: { data: copy.data.toString('base64'), mime: copy.mime, name: path.basename(abs) },
  };
}

async function readFile({ path: target, offset = 1, limit = 400 }) {
  const abs = resolveInWorkspace(target);
  const stat = await fsp.stat(abs);
  if (stat.isDirectory()) return listDir({ path: target });
  if (PICTURE_EXTENSIONS.test(abs) && stat.size <= MAX_PICTURE_BYTES) {
    const picture = await readPicture(abs, stat);
    if (picture) return picture;
  }
  if (stat.size > 5_000_000) throw new Error(`${rel(abs)} is ${stat.size} bytes — too large to read.`);

  const lines = (await fsp.readFile(abs, 'utf8')).split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const end = Math.min(lines.length, start + (Number(limit) || 400) - 1);

  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(5)}  ${line}`)
    .join('\n');

  const more = end < lines.length ? `\n\n[${lines.length - end} more lines — read again with offset ${end + 1}]` : '';
  return clip(`${rel(abs)} (${lines.length} lines)\n${body}${more}`);
}

async function writeFile({ path: target, content }) {
  const abs = resolveInWorkspace(target);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  await fsp.writeFile(abs, String(content ?? ''), 'utf8');
  const lines = String(content ?? '').split('\n').length;
  return `${existed ? 'Overwrote' : 'Created'} ${rel(abs)} (${lines} lines).`;
}

async function editFile({ path: target, old_string, new_string, replace_all = false }) {
  const abs = resolveInWorkspace(target);
  const original = await fsp.readFile(abs, 'utf8');

  if (old_string === new_string) throw new Error('old_string and new_string are identical.');

  const occurrences = original.split(old_string).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `old_string was not found in ${rel(abs)}. Read the file again — the text must match exactly, including indentation.`,
    );
  }
  if (occurrences > 1 && !replace_all) {
    throw new Error(
      `old_string appears ${occurrences} times in ${rel(abs)}. Include more surrounding context to make it unique, or pass replace_all.`,
    );
  }

  const updated = replace_all
    ? original.split(old_string).join(new_string)
    : original.replace(old_string, new_string);
  await fsp.writeFile(abs, updated, 'utf8');
  return `Edited ${rel(abs)} — replaced ${replace_all ? occurrences : 1} occurrence${
    replace_all && occurrences > 1 ? 's' : ''
  }.`;
}

/**
 * Several replacements in one file, in one call.
 *
 * Two things make this worth having over calling `edit_file` in a loop. It is one
 * round trip instead of five — each of which, on a paired machine, is a queue row
 * and a poll cycle. And it is **atomic**: the edits are applied to a string in
 * memory and only written if every one of them matched.
 *
 * That second part is the one that matters. A sequence of separate edits that
 * fails on the fourth leaves the file in a state nobody designed — half-migrated,
 * still compiling perhaps, and now not matching what either the model or the user
 * believes is there. Failing with the file untouched is recoverable; failing
 * halfway is a debugging session.
 */
async function multiEdit({ path: target, edits }) {
  const abs = resolveInWorkspace(target);
  const list = Array.isArray(edits) ? edits : [];
  if (!list.length) throw new Error('Pass at least one edit.');

  const original = await fsp.readFile(abs, 'utf8');
  let working = original;
  const applied = [];

  for (const [i, edit] of list.entries()) {
    const oldString = String(edit?.old_string ?? '');
    const newString = String(edit?.new_string ?? '');
    const where = `Edit ${i + 1} of ${list.length}`;

    if (!oldString) throw new Error(`${where} has an empty old_string. Nothing was written.`);
    if (oldString === newString) {
      throw new Error(`${where} has identical old_string and new_string. Nothing was written.`);
    }

    const occurrences = working.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `${where} did not match ${rel(abs)}. Nothing was written — the file is exactly as it was. ` +
          'Read it again: the text must match exactly, including indentation. ' +
          'Note that earlier edits in this call change what later ones see.',
      );
    }
    if (occurrences > 1 && !edit?.replace_all) {
      throw new Error(
        `${where} matches ${occurrences} places in ${rel(abs)}. Nothing was written. ` +
          'Include more surrounding context to make it unique, or pass replace_all on that edit.',
      );
    }

    working = edit?.replace_all
      ? working.split(oldString).join(newString)
      : working.replace(oldString, newString);
    applied.push(edit?.replace_all ? `${occurrences} occurrences` : '1 occurrence');
  }

  if (working === original) return `${rel(abs)} already said exactly that; nothing changed.`;

  await fsp.writeFile(abs, working, 'utf8');
  return `Edited ${rel(abs)} — ${list.length} edit${list.length === 1 ? '' : 's'} applied (${applied.join(', ')}).`;
}

async function globTool({ pattern, path: target = '.' }) {
  const abs = resolveInWorkspace(target);
  const re = globToRegExp(pattern);

  const hits = [];
  for await (const file of walk(abs)) {
    const relative = path.relative(abs, file).split(path.sep).join('/');
    if (re.test(relative) || re.test(path.basename(file))) {
      const stat = await fsp.stat(file).catch(() => null);
      hits.push({ file: rel(file), mtime: stat?.mtimeMs || 0 });
    }
    if (hits.length > 500) break;
  }
  if (!hits.length) return `No files matched "${pattern}" under ${rel(abs)}/.`;
  return hits
    .sort((a, b) => b.mtime - a.mtime)
    .map((h) => h.file)
    .join('\n');
}

async function grepTool({ pattern, path: target = '.', glob: globFilter, ignore_case = false }) {
  const abs = resolveInWorkspace(target);
  let re;
  try {
    re = new RegExp(pattern, ignore_case ? 'i' : '');
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err.message}`);
  }
  const fileRe = globFilter ? globToRegExp(globFilter) : null;

  const out = [];
  for await (const file of walk(abs)) {
    if (fileRe && !fileRe.test(path.basename(file)) && !fileRe.test(path.relative(abs, file).split(path.sep).join('/')))
      continue;
    let content;
    try {
      const stat = await fsp.stat(file);
      if (stat.size > 2_000_000) continue;
      content = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (content.indexOf('\u0000') !== -1) continue; // binary file

    content.split('\n').forEach((line, i) => {
      if (out.length < 200 && re.test(line)) {
        out.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 300)}`);
      }
    });
    if (out.length >= 200) break;
  }
  if (!out.length) return `No matches for /${pattern}/ under ${rel(abs)}/.`;
  return clip(`${out.length} match${out.length === 1 ? '' : 'es'}\n${out.join('\n')}`);
}

/**
 * End a command and whatever it started.
 *
 * `spawn` with `shell: true` makes the shell the direct child, so killing only
 * the child ends the shell and leaves the program it launched running — on
 * Windows (`cmd.exe`) and, until CODE-030, on Linux and macOS (`/bin/sh`).
 * `killTree` takes the whole tree on every platform; see worker/kill.js.
 */
function terminate(child) {
  killTree(child, 'SIGKILL');
}

/**
 * @param {{ command: string, cwd?: string, timeout_ms?: number }} input
 * @param {{ chatId?: string|null, signal?: AbortSignal }} [context]
 */
function runCommand({ command, cwd = '.', timeout_ms = 120_000 }, { signal } = {}) {
  const abs = resolveInWorkspace(cwd);
  const timeout = Math.min(Math.max(Number(timeout_ms) || 120_000, 1000), 600_000);

  // Called off before it started: do not start it (AUTO-009).
  if (signal?.aborted) {
    return Promise.resolve(`$ ${command}\n\nNot run — the user stopped this before it started.`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: abs,
      shell: true,
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
    });

    let output = '';
    let killed = false;
    let cancelled = false;
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      killed = true;
      terminate(child);
    }, timeout);

    /*
     * The person stopped the turn. Before this, the server stopped waiting and
     * the process ran on regardless; now it is ended, and the result says so
     * rather than reporting whatever exit code the kill produced as a failure of
     * the command itself.
     */
    const onAbort = () => {
      cancelled = true;
      terminate(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start the command: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const header = cancelled
        ? 'Stopped — the user cancelled this while it was running.'
        : killed
          ? `Killed after ${timeout}ms (timeout).`
          : `Exit code ${code}${code === 0 ? '' : ' — the command failed'}.`;
      resolve(clip(`$ ${command}\n(in ${rel(abs)}/)\n\n${output.trim() || '(no output)'}\n\n${header}`));
    });
  });
}

/**
 * Delete a file, or a folder and what is in it.
 *
 * There was no way to do this except `run_command` with `rm` or `del`, which is
 * a shell invocation graded on a pattern list and spelled differently on every
 * platform. A named tool is checked against the workspace like every other file
 * operation, says exactly what it removed, and — being unambiguous about what
 * it does — can be classified as always worth asking about.
 *
 * `recursive` is required for a folder with anything in it. Deleting a tree
 * because a path happened to be a directory is not something to do on a guess.
 */
async function deleteFile({ path: target, recursive = false }) {
  const abs = resolveInWorkspace(target);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat) throw new Error(`There is nothing at ${rel(abs)} to delete.`);

  // The workspace root is the thing everything else is relative to; removing it
  // leaves every subsequent tool call resolving against a folder that is gone.
  if (path.resolve(abs) === path.resolve(workspace())) {
    throw new Error('That is the workspace itself. Deleting it would leave nothing to work in.');
  }

  if (stat.isDirectory()) {
    const inside = await fsp.readdir(abs);
    if (inside.length && !recursive) {
      throw new Error(
        `${rel(abs)} is a folder with ${inside.length} item${inside.length === 1 ? '' : 's'} in it. ` +
          'Pass recursive: true to delete it and everything under it.',
      );
    }
    await fsp.rm(abs, { recursive: true, force: true });
    return `Deleted the folder ${rel(abs)}${inside.length ? ` and ${inside.length} item(s) in it` : ''}.`;
  }

  await fsp.rm(abs, { force: true });
  return `Deleted ${rel(abs)} (${stat.size} bytes).`;
}

/**
 * Rename, or move — which are the same operation.
 *
 * `fs.rename` across two drives fails with EXDEV, so a move that crosses one
 * falls back to copy-then-delete. Both paths go through the workspace check, so
 * neither end can be somewhere it should not be.
 */
async function moveFile({ from, to, overwrite = false }) {
  const source = resolveInWorkspace(from);
  const target = resolveInWorkspace(to);

  if (path.resolve(source) === path.resolve(target)) return `${rel(source)} is already where it is.`;
  if (!fs.existsSync(source)) throw new Error(`There is nothing at ${rel(source)} to move.`);

  /**
   * Refusing to overwrite by default is the difference between renaming a file
   * and losing one: `mv a.txt b.txt` where b.txt matters is not recoverable.
   *
   * The exception is the file itself. Windows and macOS are case-insensitive,
   * so renaming `readme.md` to `README.md` finds a file already at the
   * destination — the very one being renamed — and refusing that would make a
   * capitalisation fix impossible on the two platforms people actually hit it
   * on. Identity is checked by inode rather than by lower-casing the path,
   * because that is true on every filesystem rather than on the ones guessed at.
   */
  if (fs.existsSync(target) && !overwrite) {
    const same = (() => {
      try {
        const a = fs.statSync(source);
        const b = fs.statSync(target);
        return a.ino === b.ino && a.dev === b.dev && a.ino !== 0;
      } catch {
        return false;
      }
    })();
    if (!same) throw new Error(`${rel(target)} already exists. Pass overwrite: true to replace it.`);
  }
  // Moving a folder into itself produces an infinite path and takes the folder
  // with it, which no filesystem call will stop you doing.
  const inside = path.relative(source, target);
  if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
    throw new Error(`${rel(target)} is inside ${rel(source)}, so that move would consume itself.`);
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(source, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Across drives there is no rename, only a copy and a delete.
    await fsp.cp(source, target, { recursive: true, force: !!overwrite });
    await fsp.rm(source, { recursive: true, force: true });
  }

  const renamed = path.dirname(source) === path.dirname(target);
  return renamed
    ? `Renamed ${path.basename(source)} to ${path.basename(target)}.`
    : `Moved ${rel(source)} to ${rel(target)}.`;
}

/**
 * Fetch a URL and put the bytes on disk.
 *
 * `web_fetch` reads a page and hands back text, which is the right tool for
 * reading and useless for a file: an image, a spreadsheet somebody linked, a
 * release archive, a font. There was no way to get any of those onto the machine
 * except `run_command` with curl, which is a shell invocation graded on a pattern
 * list and spelled differently on every platform.
 *
 * Through `safeFetch`, so the private address ranges are refused here exactly as
 * they are for `web_fetch` — the URL comes from a model, and a model reads pages
 * that tell it what to fetch next. A router's admin panel is not a download.
 *
 * The size is checked twice: the declared length before reading a byte, and the
 * real total while streaming, because `Content-Length` is a claim rather than a
 * fact and a server that lies about it should not be able to fill the disk.
 */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/**
 * @param {{ url: string, path?: string, overwrite?: boolean, max_bytes?: number }} input
 * @param {{ chatId?: string|null, signal?: AbortSignal }} [context]
 */
async function downloadFile({ url, path: target, overwrite = false, max_bytes: maxBytes }, { signal } = {}) {
  const limit = Math.min(Math.max(Number(maxBytes) || MAX_DOWNLOAD_BYTES, 1024), MAX_DOWNLOAD_BYTES);

  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }

  // Where it lands. Falling back to the URL's own filename is what makes this
  // usable in one call; a name is still better, because a URL ending in "/latest"
  // gives nothing to write.
  const fallback = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || 'download';
  const abs = resolveInWorkspace(target || fallback);

  if (fs.existsSync(abs) && !overwrite) {
    throw new Error(`${rel(abs)} already exists. Pass overwrite: true to replace it, or choose another path.`);
  }

  const res = await safeFetch(parsed, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Remote/1.0)', Accept: '*/*' },
    // Whichever comes first: the three-minute ceiling, or the person stopping
    // the turn (AUTO-009). Before, only the ceiling could end a download.
    signal: signal ? AbortSignal.any([AbortSignal.timeout(180_000), signal]) : AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${parsed.host} returned HTTP ${res.status} ${res.statusText}`);

  // Rounded to whole megabytes this read "0MB, over the 0MB limit" for anything
  // small — a message that tells nobody anything. Say the bytes.
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${n.toLocaleString()} bytes`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(
      `${parsed.host} says that file is ${size(declared)}, over the ${size(limit)} limit for this call. ` +
        'Raise max_bytes if you meant to fetch something that large.',
    );
  }
  if (!res.body) throw new Error(`${parsed.host} sent no body.`);

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const handle = await fsp.open(abs, 'w');
  let written = 0;
  try {
    for await (const chunk of res.body) {
      written += chunk.length;
      if (written > limit) {
        // Stop and clean up rather than leaving a truncated file that looks whole.
        throw new Error(
          `The download passed the ${size(limit)} limit, so it was stopped and the partial file removed.`,
        );
      }
      await handle.write(chunk);
    }
  } catch (err) {
    await handle.close();
    await fsp.rm(abs, { force: true });
    throw err;
  }
  await handle.close();

  const type = (res.headers.get('content-type') || '').split(';')[0] || 'unknown type';
  return `Downloaded ${parsed.href} to ${rel(abs)} — ${written.toLocaleString()} bytes, ${type}.`;
}

/**
 * A real PDF, printed by the browser on this machine.
 *
 * The app has told people for a long time to open a document and use their
 * browser's Print → Save as PDF, because generating one server-side would need a
 * PDF engine and would get the fonts wrong. The reasoning held; the conclusion
 * did not, because the sandbox *is* a browser and it is on this machine. Printing
 * through it means the system's own fonts, so Vietnamese diacritics come out
 * right — which was the actual reason for the advice.
 */
async function exportPdf({ path: target, html, url, landscape = false }) {
  if (!html && !url) throw new Error('Give either `html` to print or a `url` to print from.');
  if (html && url) throw new Error('Give `html` or `url`, not both — they are two different pages.');

  const name = String(target || 'document.pdf');
  const abs = resolveInWorkspace(/\.pdf$/i.test(name) ? name : `${name}.pdf`);

  const bytes = await renderPdf({ html, url, landscape });
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, bytes);

  return (
    `Wrote ${rel(abs)} — ${bytes.length.toLocaleString()} bytes, printed by the browser on this machine ` +
    `(so accents and non-Latin text are correct). ${url ? `Source: ${url}` : 'Source: the markup you supplied'}.`
  );
}

/**
 * Change a picture that is already on disk.
 *
 * The companion to `generate_image`, which makes one and cannot touch it
 * afterwards. Resizing a photo before it goes in a document, cropping a
 * screenshot, turning a 4MB PNG into a 200KB JPEG — ordinary work that previously
 * needed a shell command and an image tool the machine may not have.
 *
 * Done through the browser's canvas rather than by adding `sharp`: a native module
 * with per-platform binaries is a real dependency, and this project keeps nine on
 * purpose. See `renderImage`.
 */
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
};

async function editImage({
  path: target,
  output,
  width,
  height,
  crop,
  rotate = 0,
  flip,
  format,
  quality = 0.9,
}) {
  const source = resolveInWorkspace(target);
  const stat = await fsp.stat(source).catch(() => null);
  if (!stat) throw new Error(`There is no file at ${rel(source)}.`);
  if (stat.isDirectory()) throw new Error(`${rel(source)} is a folder, not an image.`);
  if (stat.size > 40 * 1024 * 1024) {
    throw new Error(`${rel(source)} is ${(stat.size / 1048576).toFixed(1)}MB, which is too large to load into a canvas.`);
  }

  const sourceExt = path.extname(source).slice(1).toLowerCase();
  const sourceMime = IMAGE_MIME[sourceExt];
  if (!sourceMime) {
    throw new Error(
      `${rel(source)} does not look like an image this can read (${sourceExt || 'no extension'}). ` +
        `Readable: ${Object.keys(IMAGE_MIME).join(', ')}.`,
    );
  }

  // Nothing asked for is nothing to do, and silently rewriting the file would be
  // a change the user did not request.
  if (!width && !height && !crop && !rotate && !flip && !format) {
    throw new Error(
      'Say what to change: width, height, crop, rotate, flip, or format. ' +
        'With none of them this would only re-encode the file in place.',
    );
  }

  const wanted = String(format || (sourceExt === 'jpg' ? 'jpeg' : sourceExt)).toLowerCase();
  const encodeAs = wanted === 'jpg' ? 'jpeg' : wanted;
  if (!['png', 'jpeg', 'webp'].includes(encodeAs)) {
    throw new Error(`Cannot write "${format}". A canvas encodes png, jpeg and webp.`);
  }

  const result = await renderImage({
    data: (await fsp.readFile(source)).toString('base64'),
    mime: sourceMime,
    width: Number(width) || 0,
    height: Number(height) || 0,
    crop: crop || null,
    rotate: Number(rotate) || 0,
    flip: flip || null,
    format: encodeAs,
    quality: Math.min(Math.max(Number(quality) || 0.9, 0.1), 1),
  });

  // Default to writing beside the original with the new extension, rather than
  // over it: an irreversible resize of somebody's only copy is not a default.
  const extension = encodeAs === 'jpeg' ? 'jpg' : encodeAs;
  const destination = output
    ? resolveInWorkspace(/\.[a-z0-9]+$/i.test(output) ? output : `${output}.${extension}`)
    : resolveInWorkspace(
        path.join(path.dirname(target), `${path.basename(target, path.extname(target))}-edited.${extension}`),
      );

  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, result.buffer);

  // Say what really happened. A browser that cannot encode webp hands back a PNG
  // without complaining, and reporting the request rather than the result is how
  // somebody ends up with a .webp file that is not one.
  const asked = `image/${encodeAs}`;
  const note = result.mime !== asked ? ` This browser could not encode ${encodeAs}, so it is ${result.mime}.` : '';

  return (
    `Wrote ${rel(destination)} — ${result.width}×${result.height}, ` +
    `${result.buffer.length.toLocaleString()} bytes (${result.mime}). ` +
    `The original was ${result.from.width}×${result.from.height}, ${stat.size.toLocaleString()} bytes, and is untouched.${note}`
  );
}

/* ── what the file browser in the interface needs ─────────────────────── */

/**
 * Search across the files, for the browser.
 *
 * `grep` exists and is written for a model to read — a flat list of
 * `path:line: text`. The browser needs to group by file, count, and open one,
 * so this returns the same search as structure. It is the same walk and the
 * same limits; only the shape of the answer differs.
 */
async function searchWorkspace({ query, path: target = '.', glob: globFilter, ignore_case: ignoreCase = true }) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Search for what?');

  const abs = resolveInWorkspace(target);
  // A plain string, not a pattern: somebody typing `a.b` into a search box
  // means those three characters, and a regular expression would quietly match
  // half the file.
  const needle = ignoreCase ? text.toLowerCase() : text;
  const fileRe = globFilter ? globToRegExp(globFilter) : null;

  const files = [];
  let matches = 0;
  let scanned = 0;

  for await (const file of walk(abs)) {
    if (files.length >= 100 || matches >= 500) break;
    const name = path.relative(abs, file).split(path.sep).join('/');
    if (fileRe && !fileRe.test(name) && !fileRe.test(path.basename(file))) continue;

    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }
    if (stat.size > 2_000_000) continue;

    let content;
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue; // a binary file has no lines to show
    scanned += 1;

    const hits = [];
    content.split('\n').forEach((line, i) => {
      if (hits.length >= 20 || matches >= 500) return;
      const hay = ignoreCase ? line.toLowerCase() : line;
      const at = hay.indexOf(needle);
      if (at === -1) return;
      hits.push({ line: i + 1, at, text: line.length > 400 ? `${line.slice(0, 400)}…` : line });
      matches += 1;
    });

    if (hits.length) files.push({ path: rel(file), hits });
  }

  return JSON.stringify({ query: text, scanned, matches, truncated: matches >= 500, files });
}

/**
 * A folder, as data rather than as a paragraph.
 *
 * `list_dir` exists and is written for a model to read: a heading, indented
 * names, sizes in brackets. Parsing that back into a file tree would be a
 * regular expression against prose, and it would break the first time somebody
 * improved the wording. This returns JSON and is never offered to the model,
 * which already has the readable one.
 */
async function browseWorkspace({ path: target = '.' }) {
  const abs = resolveInWorkspace(target);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat) throw new Error(`There is no folder at ${rel(abs)}.`);
  if (!stat.isDirectory()) throw new Error(`${rel(abs)} is a file, not a folder.`);

  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const listed = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(abs, entry.name);
      // `lstat` rather than `stat`: a broken symlink should appear in the
      // listing as what it is, not throw and take the whole folder with it.
      const info = await fsp.lstat(full).catch(() => null);
      return {
        name: entry.name,
        dir: entry.isDirectory(),
        size: info?.isFile() ? info.size : null,
        modified: info ? info.mtimeMs : null,
        link: !!info?.isSymbolicLink(),
      };
    }),
  );

  // Folders first, then by name — the order every file manager uses, because it
  // is the order people scan in.
  listed.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

  return JSON.stringify({
    path: rel(abs),
    absolute: abs,
    root: rel(abs) === '.',
    workspace: workspace(),
    entries: listed,
  });
}

/** How much of a file the editor will take. Past this it is not a text file. */
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/**
 * One file, for editing.
 *
 * Refuses binaries rather than showing mojibake somebody might then save over
 * the original — a NUL byte in the first few kilobytes is the same test every
 * editor uses, and it is right often enough to be worth more than a guess at
 * the extension.
 */
async function readWorkspaceFile({ path: target }) {
  const abs = resolveInWorkspace(target);
  const stat = await fsp.stat(abs);
  if (stat.isDirectory()) throw new Error(`${rel(abs)} is a folder.`);
  if (stat.size > MAX_EDITABLE_BYTES) {
    throw new Error(`${rel(abs)} is ${Math.round(stat.size / 1024)}KB — too large to edit here.`);
  }

  const buffer = await fsp.readFile(abs);
  if (buffer.subarray(0, 8000).includes(0)) {
    throw new Error(`${rel(abs)} is a binary file, so there is nothing to edit.`);
  }

  return JSON.stringify({
    path: rel(abs),
    absolute: abs,
    content: buffer.toString('utf8'),
    bytes: stat.size,
    modified: stat.mtimeMs,
  });
}

/**
 * Hand something to the desktop and let the OS decide which app opens it —
 * the same thing double-clicking does. This is what turns "play me that video"
 * into something the user actually sees.
 */
function openUrl({ target }) {
  const value = String(target || '').trim();
  if (!value) throw new Error('Nothing to open.');

  const isWeb = /^https?:\/\//i.test(value);
  // A local path still goes through the workspace check; a URL does not have one.
  const resolved = isWeb ? value : resolveInWorkspace(value);

  if (!isWeb && !fs.existsSync(resolved)) {
    throw new Error(`There is nothing at ${rel(resolved)} to open.`);
  }
  if (!isWeb && !/^[a-z]:[\\/]|^\//i.test(value) && !fs.existsSync(resolved)) {
    throw new Error(`"${value}" is neither an http(s) URL nor a path that exists.`);
  }

  return new Promise((resolve, reject) => {
    // Each platform has its own "open with the default app" command. On Windows
    // `start` needs an empty title argument first, or a quoted target is taken
    // as the window title and nothing opens.
    const [command, args] = openCommand(resolved);

    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => reject(new Error(`Could not open it: ${err.message}`)));
    child.on('spawn', () => {
      // Let it outlive this call — the browser or player stays open after the
      // tool returns.
      child.unref();
      resolve(
        `Opened ${isWeb ? value : rel(resolved)} on the user's screen. ` +
          'You cannot see it from here, so tell them what you opened and ask if it is the right one.',
      );
    });
  });
}

/**
 * Work somewhere else from now on.
 *
 * Only moves where relative paths resolve — it does not widen what the assistant
 * may reach. With `FILE_ACCESS` unset the tools stay confined to whatever this
 * points at, which is the whole reason moving it is useful: it is how you grant
 * access to one project rather than to the disk.
 */
function setWorkspaceTool({ path: target }) {
  const previous = workspace();
  const now = moveWorkspace(target);
  if (now === previous) return `Already working in ${now}.`;

  return (
    `Workspace moved from ${previous} to ${now}.\n` +
    'Relative paths resolve there now. Call list_dir to see what is in it.'
  );
}

/* ── handing a conversation's file to the desktop ─────────────────────
 *
 * A document the assistant made lives on the server, not on this machine. To
 * open it in Word — or show it in a folder — it has to exist here first, so
 * this writes it into one predictable place and then does what a double-click
 * would do.
 *
 * The folder is *outside* the workspace on purpose. The workspace is the
 * assistant's; this is a downloads tray, and dropping files into somebody's
 * project directory because they pressed "Open" would be a surprise.
 */

/**
 * Where files from a conversation land on this machine.
 *
 * `FILES_DIR` overrides it, for the same reason `DATA_DIR` overrides the data
 * directory: a test has to be able to point this somewhere disposable. Without
 * that the suite wrote into the real tray on whatever machine ran it — and then
 * deleted the folder afterwards, taking with it whatever the person had opened
 * from a conversation and left there. A test suite must not be able to reach
 * the user's files at all, so the reach is removed rather than the deletion.
 */
export function filesFolder() {
  if (process.env.FILES_DIR) return path.resolve(process.env.FILES_DIR);
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'AI Remote', 'files');
}

/**
 * Extensions the OS must not be asked to launch.
 *
 * Everything here either *is* a program or is a document format whose default
 * handler executes it. A model can be talked into writing any of them, and
 * "Open" is one click with no confirmation behind it — so the launch path
 * refuses them by name rather than trusting that nobody will ask.
 *
 * Showing one in a folder stays allowed: revealing a file runs nothing.
 */
const NEVER_LAUNCH = new Set([
  'exe', 'com', 'scr', 'pif', 'msi', 'msp', 'msc', 'cpl', 'dll', 'drv', 'sys',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'lnk', 'url', 'scf', 'inf', 'reg', 'chm', 'jar', 'application', 'gadget',
  'sh', 'bash', 'zsh', 'command', 'app', 'pkg', 'dmg', 'run', 'appimage', 'deb', 'rpm',
]);

const safeName = (name) =>
  String(name || 'file')
    .replace(/[\\/]/g, '-')
    // Reserved on Windows. A colon is the dangerous one: it does not fail, it
    // silently writes an alternate data stream nobody can see. Control
    // characters go the same way, checked by code point rather than by a
    // regular expression with unprintables sitting inside it.
    .split('')
    .map((char) => ('<>:"|?*'.includes(char) || char.codePointAt(0) < 0x20 ? '-' : char))
    .join('')
    .replace(/^\.+/, '')
    .slice(0, 180) || 'file';

/**
 * Which application the OS would use, by name, or null when it cannot be known
 * cheaply.
 *
 * The button says "Open in Word" in the screenshots, and it should only say
 * that when Word is really what will open. Windows can be asked; the answer is
 * cached because it involves spawning `reg` and it does not change while the
 * app is running. Everywhere else the button just says "Open" — better than
 * naming an application the user may not have installed.
 */
const appCache = new Map();

const APP_NAMES = {
  'winword.exe': 'Word',
  'excel.exe': 'Excel',
  'powerpnt.exe': 'PowerPoint',
  'notepad.exe': 'Notepad',
  'wordpad.exe': 'WordPad',
  'soffice.exe': 'LibreOffice',
  'acrord32.exe': 'Acrobat Reader',
  'acrobat.exe': 'Acrobat',
  'msedge.exe': 'Edge',
  'chrome.exe': 'Chrome',
  'firefox.exe': 'Firefox',
  'photos.exe': 'Photos',
  'code.exe': 'VS Code',
};

function reg(args) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('reg', args, { windowsHide: true });
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

async function defaultApp(extension) {
  if (process.platform !== 'win32' || !extension) return null;
  const ext = `.${extension.toLowerCase()}`;
  if (appCache.has(ext)) return appCache.get(ext);

  let name = null;
  try {
    // The per-user choice wins over the machine association, which is what the
    // shell itself honours — reading only HKCR reports the app Windows would
    // have used before the user changed it.
    const chosen = await reg([
      'query',
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
      '/v',
      'ProgId',
    ]);
    const progid =
      chosen.match(/ProgId\s+REG_SZ\s+(\S+)/i)?.[1] ||
      (await reg(['query', `HKCR\\${ext}`, '/ve'])).match(/REG_SZ\s+(\S+)/i)?.[1];

    if (progid) {
      const command = await reg(['query', `HKCR\\${progid}\\shell\\open\\command`, '/ve']);
      const line = command.match(/REG_(?:SZ|EXPAND_SZ)\s+(.*)/i)?.[1] || '';
      const exe = line.match(/"([^"]+\.exe)"/i)?.[1] || line.match(/(\S+\.exe)/i)?.[1];
      if (exe) {
        const base = path.basename(exe).toLowerCase();
        name = APP_NAMES[base] || path.basename(exe, path.extname(exe));
      }
    }
  } catch {
    // Any failure here is cosmetic: the button falls back to "Open".
  }

  appCache.set(ext, name);
  return name;
}

/**
 * Put a file from a conversation on this machine, then open it or show it.
 *
 * Not offered to the model. This is the interface's button, pressed by the
 * person sitting at the machine about a file they are already looking at —
 * which is why it does not go through the approval policy, and why it writes
 * outside the workspace.
 */
async function revealFile({ name, data, how = 'open' }) {
  const filename = safeName(name);
  const extension = path.extname(filename).replace('.', '').toLowerCase();

  /**
   * Only `open` is refused, and that is deliberate rather than an oversight.
   *
   * Revealing an executable does write it to disk and put it under the user's
   * cursor, which is most of the distance to running it — a fair objection. But
   * blocking reveal as well would leave a file the assistant produced with no
   * way to reach it at all, and would contradict the sentence below, which
   * offers "Show in folder" as the way through. A refusal with no alternative
   * is how people learn to work around a guard rather than with it.
   *
   * The line held here is the one the operating system draws: this will not
   * hand a program to the shell to execute. Opening it is then a deliberate act
   * by the person sitting at the machine, about a file they asked to see, with
   * the extension visible in front of them.
   */
  if (how === 'open' && NEVER_LAUNCH.has(extension)) {
    throw new Error(
      `.${extension} files are programs, or are opened by something that runs them. ` +
        'This will not hand one to the operating system. Use "Show in folder" and open it yourself if you meant to.',
    );
  }

  const folder = filesFolder();
  await fsp.mkdir(folder, { recursive: true });
  const target = path.join(folder, filename);
  await fsp.writeFile(target, Buffer.from(String(data || ''), 'base64'));

  /**
   * Explorer does not parse its command line the way everything else does.
   *
   * It reads the raw string rather than going through `CommandLineToArgvW`, and
   * `spawn` quotes any argument containing a space — so `/select,C:\…\AI Remote\
   * files\x.docx` arrived as one quoted token, the switch was never recognised,
   * and Explorer opened its default folder instead. The symptom was a window
   * opening on Documents every single time, which looks like the feature half
   * working and is why it went unnoticed.
   *
   * `windowsVerbatimArguments` hands the line over untouched, with the path
   * quoted the way Explorer documents. Verified by reading back the location of
   * the window it opens.
   */
  const verbatim = process.platform === 'win32' && how === 'folder';
  const [command, args] =
    how === 'folder'
      ? process.platform === 'win32'
        ? ['explorer.exe', [`/select,"${target}"`]]
        : process.platform === 'darwin'
          ? ['open', ['-R', target]]
          : ['xdg-open', [folder]]
      : openCommand(target);

  const app = how === 'open' ? await defaultApp(extension) : null;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    child.on('error', (err) => reject(new Error(`Could not open it: ${err.message}`)));
    child.on('spawn', () => {
      // It outlives this call: Word stays open after the tool returns.
      child.unref();
      /**
       * Say so when what was just revealed is a program.
       *
       * `open` refuses these outright. `folder` does not, and should not — the
       * file has to be reachable somehow — but it does write the thing to disk
       * and highlight it under the cursor, which is far enough that the person
       * deserves to be told what they are looking at rather than left to read
       * the extension off the filename.
       */
      resolve(
        JSON.stringify({
          path: target,
          folder,
          app,
          how,
          ...(NEVER_LAUNCH.has(extension)
            ? { warning: `This is a .${extension} file — a program. Opening it runs it. Only do that if you know where it came from.` }
            : {}),
        }),
      );
    });
  });
  // `explorer.exe /select` exits 1 even when it worked, so the exit code is
  // deliberately not waited on — spawning is the whole success condition.
}

/** Which application would open this, for a button that has to say so first. */
async function describeFile({ name }) {
  const extension = path.extname(safeName(name)).replace('.', '').toLowerCase();
  return JSON.stringify({
    app: NEVER_LAUNCH.has(extension) ? null : await defaultApp(extension),
    launchable: !NEVER_LAUNCH.has(extension),
    folder: filesFolder(),
  });
}

export const LOCAL_IMPLEMENTATIONS = {
  set_workspace: setWorkspaceTool,
  ...BROWSER_IMPLEMENTATIONS,
  ...DESKTOP_IMPLEMENTATIONS,
  ...SYSTEM_IMPLEMENTATIONS,
  ...INDEX_IMPLEMENTATIONS,
  ...BACKGROUND_IMPLEMENTATIONS,
  download_file: downloadFile,
  export_pdf: exportPdf,
  edit_image: editImage,
  open_url: openUrl,
  list_dir: listDir,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  multi_edit: multiEdit,
  glob: globTool,
  grep: grepTool,
  run_command: runCommand,
  delete_file: deleteFile,
  move_file: moveFile,
  // Not offered to the model — the interface's file browser uses these, and the
  // model has `list_dir` and `read_file`, which are written to be read.
  fs_browse: browseWorkspace,
  fs_read_text: readWorkspaceFile,
  fs_search: searchWorkspace,
  fs_reveal: revealFile,
  fs_describe: describeFile,
};

export function workerInfo() {
  return {
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    workspace: workspace(),
    fullDisk: fullDiskAccess(),
    shell: process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/sh',
    hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
    browserOpen: browserIsOpen(),
    // Which browser the assistant drives here, and what this machine could
    // offer instead. Reported so the picker in the app can say "Chrome is not
    // installed" or "nothing is listening on the debugging port" rather than
    // showing a choice that will fail the moment it is used.
    browser: browserSnapshot(),
    // Whether this machine has agreed to be driven directly. The server uses it
    // to decide whether the desktop tools exist at all for this account.
    desktop: desktopAllowed(),
  };
}
