/**
 * The quick launcher.
 *
 * Two halves, tested differently. The hotkey host is a real Win32 registration,
 * so on Windows this claims a combination for a moment and lets go — the only
 * way to know whether the P/Invoke, the modifier arithmetic and the script's
 * encoding all actually work, and every one of those has already been wrong
 * once. Off Windows those checks are skipped rather than faked, because a green
 * tick for a code path that did not run is worse than an honest gap.
 *
 * The page half is checked against a live server: it must be reachable without
 * a session (you cannot sign in through a window that will not load), it must
 * not leak the app's internals, and the handoff it performs must hit endpoints
 * that exist.
 *
 *   node test/launcher.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'launcher-test-encryption-key';
process.env.SESSION_SECRET ||= 'launcher-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-launcher-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const skip = (label, why) => console.log(`  \x1b[33m–\x1b[0m  skipped: ${label} (${why})`);

// ── the hotkey host ───────────────────────────────────────────────────
section('the hotkey script');
{
  const script = path.join(root, 'scripts', 'hotkey.ps1');
  check('it exists', fs.existsSync(script));

  // Windows PowerShell 5.1 reads a .ps1 without a byte-order mark as ANSI, so a
  // single non-ASCII character silently breaks the string it lives in and the
  // whole file stops parsing. Both halves of that are checked: the mark is
  // present, and there is nothing that needs it.
  const bytes = fs.readFileSync(script);
  check('it carries a UTF-8 byte-order mark', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);

  // The mark itself decodes to U+FEFF, so strip it before asking about the body.
  const text = fs.readFileSync(script, 'utf8').replace(/^\uFEFF/, '');
  const exotic = [...text].filter((ch) => ch.codePointAt(0) > 127);
  check('and is pure ASCII, so it parses under any code page', exotic.length === 0, exotic.join(' '));

  check('the here-string terminator is at column zero', /\n'@\r?\n/.test(text), 'an indented one is a parse error');
}

section('claiming a real key combination');
{
  if (process.platform !== 'win32') {
    skip('RegisterHotKey', `not Windows (${process.platform})`);
  } else {
    const probe = (modifiers, key) =>
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
         path.join(root, 'scripts', 'hotkey.ps1'), '-Modifiers', modifiers, '-Key', key, '-Probe'],
        { windowsHide: true, encoding: 'utf8' },
      );

    // Deliberately obscure, so the machine running the tests is unlikely to have
    // anything already sitting on it.
    const free = probe('ctrl+alt+shift', 'F9');
    check('an unclaimed combination registers', free.status === 0, (free.stderr || '').split('\n')[0]);
    check('and it says which one it took', /ready ctrl\+alt\+shift\+F9/.test(free.stdout || ''), free.stdout);

    // Registering the same key twice from two processes is exactly what happens
    // when another launcher, or an IME, already owns it.
    const nonsense = probe('ctrl+alt+shift', 'NotAKeyAtAll');
    check('an unknown key name fails rather than binding something else', nonsense.status !== 0);
  }
}

// ── choosing a key ────────────────────────────────────────────────────
section('the launcher script');
{
  const source = fs.readFileSync(path.join(root, 'scripts', 'launcher.js'), 'utf8');

  check('it does not default to an alt+space combination', !/LAUNCHER_HOTKEY \|\| 'ctrl\+alt\+Space'/.test(source),
    'IMEs claim those, and a launcher that silently does nothing is worse than one that asks');
  check('it falls back when the key is taken', /FALLBACKS/.test(source));
  check('it opens the launcher page, not the app', /launcher\.html/.test(source));

  // A shared browser profile makes Chrome treat the window as one more window of
  // the running browser: --window-size is ignored and closing it can take the
  // user's real session with it.
  check('the window gets a profile of its own', /--user-data-dir=/.test(source));
  check('and a size', /--window-size=/.test(source));
}

// ── the page ──────────────────────────────────────────────────────────
const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
await initStore();

const PORT = 5202;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

section('the launcher page is reachable and self-contained');
{
  const res = await fetch(`${base}/launcher.html`);
  check('it is served', res.status === 200, `HTTP ${res.status}`);
  const html = await res.text();

  check('it has the input', /id="q"/.test(html));
  // It has to load before the thought that summoned it is gone, so it carries
  // its own styles rather than pulling in the workspace's stylesheet and modules.
  check('it does not pull in the app bundle', !/js\/app\.js/.test(html));
  check('nor the app stylesheet', !/app\.css/.test(html));
  // A launcher that blocks on a CDN is a launcher that does not open on a
  // plane. Every src/href must be same-origin or a data URI — an `xmlns` inside
  // an inline SVG is a namespace name, not a request, so it does not count.
  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const external = references.filter((value) => /^https?:\/\//i.test(value));
  check('and nothing is fetched from another host', external.length === 0, external.join(', '));

  /*
   * No inline script. The page is served under `script-src 'self'`, which
   * refuses one outright — the box used to draw and then do nothing at all,
   * because its whole behaviour lived in a `<script>` the browser would not run.
   */
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)];
  check('it has no inline script for the CSP to refuse', inline.length === 0, `${inline.length} inline`);
  const policy = res.headers.get('content-security-policy') || '';
  check('  and the policy it is served under is the strict one', /script-src 'self'(;|$)/.test(policy), policy.slice(0, 80));
  const scriptRes = await fetch(`${base}/js/launcher.js`);
  check('its script is served from this origin', scriptRes.status === 200, `HTTP ${scriptRes.status}`);
  const script = await scriptRes.text();

  check('it hands off with both the chat and the run flag', /\?chat=\$\{[^}]+\}&run=1/.test(script), 'the app needs to know to pick the run up');
  check('Escape closes it', /Escape/.test(script));
}

section('the endpoints it calls exist');
{
  // Unauthenticated they must refuse, not 404 — a 404 would mean the launcher is
  // posting into thin air and would look identical to a silent failure.
  for (const [method, url] of [
    ['GET', '/api/session'],
    ['POST', '/api/chats'],
    ['POST', '/api/chats/whatever/messages'],
  ]) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    check(`${method} ${url} is a real route`, res.status !== 404, `HTTP ${res.status}`);
  }

  const session = await (await fetch(`${base}/api/session`)).json();
  check('and a signed-out visitor is told so rather than let in', session.authed === false, JSON.stringify(session));
}

section('the app picks the handoff up');
{
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  check("it reads the launcher's chat id", /takeUrlToken\('chat'\)/.test(appJs));
  check('and the run flag', /takeUrlToken\('run'\)/.test(appJs));
  // takeUrlToken strips as it reads, so a reload does not re-run a finished turn.
  check('and strips them from the URL', /history\.replaceState/.test(appJs));
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n\x1b[32mAll launcher checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
