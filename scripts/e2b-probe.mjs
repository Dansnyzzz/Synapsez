/**
 * The E2B cloud computer, checked on E2B itself (owner, 2026-11-02).
 *
 * `test/e2b.test.mjs` drives a stand-in SDK, so it proves what this app asks
 * of E2B and nothing about what E2B does. This asks the real thing the
 * questions the design rests on — whose login files a command reads, whether a
 * command past its time stops, whether a program started in the background
 * outlives the call that started it, whether a paused machine comes back with
 * its programs and files — on one scratch machine and one paused one, both
 * killed at the end whatever happens. It spends about two cents of the credit.
 *
 *   npm run e2b:probe              the platform checks
 *   npm run e2b:probe -- --browser and Chromium as the cloud browser starts it (about two minutes more)
 *
 * Reads E2B_API_KEY (and E2B_TEMPLATE) from the environment or .env, and
 * never prints it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.indexOf('=') < 0) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    if (!(key in process.env)) process.env[key] = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  }
}
if (!process.env.E2B_API_KEY) {
  console.log('\n  E2B_API_KEY is not set. Put it in .env (E2B_API_KEY=e2b_…) or the environment, then run this again.\n');
  process.exit(1);
}

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const said = async (done) => `${(await done.stdout()).trim()}${(await done.stderr()).trim() ? ` [stderr: ${(await done.stderr()).trim().slice(0, 200)}]` : ''}`;

const { Sandbox } = await import('e2b');
const { e2bScratch } = await import('../server/e2b.js');
const { shellFor } = await import('../server/sandbox.js');
const template = String(process.env.E2B_TEMPLATE || '').trim() || 'base';
const machines = [];
const started = Date.now();

try {
  section(`a scratch machine from "${template}"`);
  const machine = await e2bScratch();
  machines.push(machine);
  check('made', !!machine.sandboxId, machine.sandboxId);
  const info = await Sandbox.getInfo(machine.sandboxId, { apiKey: process.env.E2B_API_KEY }).catch((e) => ({ error: e.message }));
  check('its size is known, for what it costs', Number(info.cpuCount) > 0 && Number(info.memoryMB) > 0, `${info.cpuCount} vCPU, ${info.memoryMB} MiB`);

  const run = (command, options = {}) => machine.runCommand({ ...shellFor(command, {}, { userBin: true }), timeoutMs: 30_000, ...options });

  section('who a command runs as (HAR-001)');
  const who = await run('echo "$(id -un) $(id -u) $HOME $PWD"');
  check('an ordinary command is the account, at home', /^user \d+ \/home\/user \/home\/user$/.test((await who.stdout()).trim()), await said(who));
  const root = await machine.runCommand({ ...shellFor('id -un'), sudo: true, timeoutMs: 30_000 });
  check('as_root is root', (await root.stdout()).trim() === 'root', await said(root));

  // Plant what a page could talk a command into, then see whether it runs.
  await run(`for f in ~/.bash_profile ~/.profile ~/.bashrc; do echo 'touch /tmp/planted-$(basename $f)' >> $f; done`);
  await run('true');
  await machine.runCommand({ ...shellFor('exec node -e 0'), detached: true });
  await new Promise((r) => setTimeout(r, 1500));
  const planted = await machine.runCommand({ ...shellFor('ls /tmp | grep planted || echo none'), sudo: true, timeoutMs: 30_000 });
  check("the account's own login files run before none of our commands", (await planted.stdout()).trim() === 'none', await said(planted));
  const raw = await Sandbox.connect(machine.sandboxId, { apiKey: process.env.E2B_API_KEY });
  await raw.commands.run('true', { user: 'user' }).catch(() => {});
  const rawPlanted = await raw.commands.run('ls /tmp | grep planted || echo none', { user: 'root' });
  check('  (and E2B run plainly as the account would have run them — why every command goes as root)', rawPlanted.stdout.trim() !== 'none', rawPlanted.stdout.trim().replace(/\n/g, ' '));

  section('what the template put there');
  // E2B leaves /usr/local, where node is, writable by everyone; a root start must not run that node.
  const rootNode = await machine.runCommand({ ...shellFor('command -v node || echo none', {}, { root: true }), sudo: true, timeoutMs: 30_000 });
  const local = await machine.runCommand({ ...shellFor('stat -c %a /usr/local/bin'), sudo: true, timeoutMs: 30_000 });
  const writable = /[2367]$/.test((await local.stdout()).trim());
  check('a root start never runs a node the account could have replaced', !writable || (await rootNode.stdout()).trim() === 'none', `/usr/local/bin ${(await local.stdout()).trim()} · root finds ${(await rootNode.stdout()).trim()}`);
  const py = await run('python3 -c "import numpy, pandas, matplotlib, openpyxl, docx, pptx, fpdf, PIL, requests, bs4, lxml; print(\'ok\')" 2>&1 | tail -1');
  check(template === 'base' ? 'Python libraries (base: not expected)' : 'the Python the assistant reaches for is already installed', template === 'base' || (await py.stdout()).trim() === 'ok', (await py.stdout()).trim().slice(0, 160));
  const fonts = await run('fc-list 2>/dev/null | grep -ciE "noto|dejavu" || echo 0');
  check(template === 'base' ? 'fonts (base: not expected)' : 'fonts for Vietnamese pages are there', template === 'base' || Number((await fonts.stdout()).trim()) > 0, (await fonts.stdout()).trim());

  section('time limits, failures, files');
  const t0 = Date.now();
  const slow = await run('sleep 20', { timeoutMs: 2_000 });
  check('a command past its time is stopped inside the machine', slow.exitCode === 124 && Date.now() - t0 < 15_000, `exit ${slow.exitCode} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const failed = await run('echo partial; echo boom >&2; exit 3');
  check('a failing command is its exit code and output', failed.exitCode === 3 && (await failed.stdout()).trim() === 'partial' && (await failed.stderr()).trim() === 'boom', `exit ${failed.exitCode}`);
  await machine.writeFiles([{ path: 'probe/in.txt', content: Buffer.from('xin chào') }]);
  check('a file written is read back, relative to home', String(await machine.readFileToBuffer({ path: '/home/user/probe/in.txt' })) === 'xin chào');
  check('  and a missing one is null', (await machine.readFileToBuffer({ path: 'probe/none.txt' })) === null);
  const owner = await run('stat -c %U /home/user/probe/in.txt');
  check('  owned by the account', (await owner.stdout()).trim() === 'user', await said(owner));

  section('a program started in the background, and its port');
  await machine.runCommand({ ...shellFor('cd /tmp && exec python3 -m http.server 3000'), detached: true });
  // Opened to the person's browser (server/e2b.js NETWORK): no E2B traffic token, which a browser cannot send.
  let page = null;
  let status = 0;
  for (let i = 0; i < 20 && !page; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    page = await fetch(`${machine.domain(3000)}/`, { signal: AbortSignal.timeout(5_000) }).then((r) => ((status = r.status), r.ok ? r : null), () => null);
  }
  check("its port answers over https, as the person's browser will ask — no E2B token", !!page, `${machine.domain(3000)} → ${status}`);
  // The watch on a background start ends; the program must not end with it.
  await raw.commands
    .run('sleep 600', { user: 'user', background: true, timeoutMs: 3_000 })
    .then((handle) => void handle.wait().catch(() => {}))
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 6_000));
  const alive = await machine.runCommand({ ...shellFor('pgrep -f "sleep 600" >/dev/null && echo alive || echo gone'), sudo: true, timeoutMs: 30_000 });
  check('a background program outlives the stream that watched it', (await alive.stdout()).trim() === 'alive', await said(alive));

  section('paused, and resumed with its memory');
  const paused = await Sandbox.create(template, { apiKey: process.env.E2B_API_KEY, timeoutMs: 5 * 60_000, metadata: { app: 'synapsez', role: 'probe' }, lifecycle: { onTimeout: 'pause', autoResume: false } });
  machines.push({ delete: () => paused.kill() });
  await paused.commands.run('echo kept > /home/user/kept.txt; nohup sleep 900 >/dev/null 2>&1 &', { user: 'user' });
  await paused.pause();
  const back = await Sandbox.connect(paused.sandboxId, { apiKey: process.env.E2B_API_KEY, timeoutMs: 60_000 });
  const after = await back.commands.run('cat /home/user/kept.txt; pgrep -x sleep >/dev/null && echo running || echo stopped', { user: 'user' });
  check('its files and its running programs are there after a pause', /kept\s+running/.test(after.stdout), after.stdout.trim().replace(/\n/g, ' '));

  if (process.argv.includes('--browser')) {
    section('Chromium, the way the cloud browser starts it');
    const install = await machine.runCommand({
      ...shellFor('mkdir -p ~/b && cd ~/b && printf \'{"private":true}\' > package.json && npm install --no-save --no-audit --no-fund --loglevel=error playwright-core@1.63.0 @sparticuz/chromium@153.0.0 2>&1 | tail -3'),
      timeoutMs: 240_000,
    });
    check('its packages install', install.exitCode === 0, await said(install));
    const script = [
      "import chromium from '@sparticuz/chromium';",
      "import { chromium as pw } from 'playwright-core';",
      'const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });',
      'const page = await browser.newPage();',
      "await page.setContent('<title>Tiếng Việt</title><p>ok</p>');",
      'console.log(await page.title());',
      'await browser.close();',
    ].join('\n');
    await machine.writeFiles([{ path: 'b/launch.mjs', content: Buffer.from(script) }]);
    const launched = await machine.runCommand({ cmd: 'bash', args: ['--noprofile', '--norc', '-c', 'cd ~/b && node launch.mjs 2>&1 | tail -5'], env: { VERCEL: '1', AWS_LAMBDA_JS_RUNTIME: 'nodejs22.x' }, timeoutMs: 120_000 });
    check('Chromium starts and renders a page', (await launched.stdout()).includes('Tiếng Việt'), await said(launched));
  }
} catch (err) {
  check('the probe ran to the end', false, `${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 300)}`);
} finally {
  for (const m of machines) await Promise.resolve(m.delete()).catch(() => {});
  console.log(`\n  Both machines killed. ${((Date.now() - started) / 1000).toFixed(0)}s of machine time.`);
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll E2B probe checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
