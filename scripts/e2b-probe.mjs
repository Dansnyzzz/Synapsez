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
 *   npm run e2b:probe -- --base    and everything a machine is meant to come with, used for real
 *   npm run e2b:probe -- --browser and Chromium as the cloud browser starts it (about two minutes more)
 *   node scripts/e2b-probe.mjs --render <file> <folder>   LibreOffice's drawing of a file, as pictures, nothing else
 *   node scripts/e2b-probe.mjs --upload-cors   whether a browser on another site may put a file on a machine directly
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

// Whether a page on this app's own address can reach a signed upload link. Only a real browser can say:
// the question is what the machine answers to a cross-site request, preflight included.
if (process.argv.includes('--upload-cors')) {
  const http = await import('node:http');
  const { chromium } = await import('playwright-core');
  const { e2bScratch } = await import('../server/e2b.js');
  const machine = await e2bScratch({ ms: 180_000, internet: false, role: 'probe' });
  const site = http.createServer((_req, res) => res.end('<!doctype html><title>probe</title>')).listen(0, '127.0.0.1');
  await new Promise((r) => site.once('listening', r));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const place = 'uploads/ab12cd34/Báo cáo (1).bin';
    const url = await machine.uploadUrl(place);
    console.log('  signed link host:', new URL(url).host, '· params:', [...new URL(url).searchParams.keys()].join(', '));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${site.address().port}/`);
    const size = 6 * 1024 * 1024;
    const started = Date.now();
    const result = await page.evaluate(
      async ([target, bytes]) => {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(bytes).fill(65)], { type: 'application/octet-stream' }), 'probe-upload.bin');
        try {
          const res = await fetch(target, { method: 'POST', body: form });
          return { status: res.status, body: (await res.text()).slice(0, 300) };
        } catch (err) {
          return { error: String(err) };
        }
      },
      [url, size],
    );
    console.log(`  cross-site POST of ${size} bytes in ${Date.now() - started} ms:`, JSON.stringify(result));
    console.log('  size on the machine:', await machine.fileSize(place).catch((err) => `unknown: ${err.message}`));
  } finally {
    await browser.close();
    site.close();
    await machine.box?.kill().catch(() => {});
  }
  process.exit(0);
}

// A look at what LibreOffice makes of one file, to compare with real Office and our own drawing.
const renderAt = process.argv.indexOf('--render');
if (renderAt >= 0) {
  const file = process.argv[renderAt + 1];
  const folder = process.argv[renderAt + 2];
  const { e2bScratch } = await import('../server/e2b.js');
  const machine = await e2bScratch({ ms: 120_000, internet: false, role: 'probe' });
  try {
    await machine.writeFiles([{ path: `/tmp/in/${path.basename(file)}`, content: fs.readFileSync(file) }]);
    const began = Date.now();
    const done = await machine.runCommand({
      cmd: 'bash',
      args: ['--noprofile', '--norc', '-c', `export PATH=/usr/bin:/bin:/usr/local/bin; cd /tmp/in && HOME=/tmp/in soffice --headless --norestore --convert-to pdf --outdir /tmp/out '${path.basename(file)}' >/dev/null 2>&1; cd /tmp/out && pdftoppm -r 80 -png *.pdf page; ls`],
      timeoutMs: 100_000,
    });
    const names = String(await done.stdout()).trim().split('\n').filter((n) => n.endsWith('.png'));
    fs.mkdirSync(folder, { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(folder, `lo-${name}`), await machine.readFileToBuffer({ path: `/tmp/out/${name}` }));
    console.log(`  LibreOffice: ${names.length} page(s) in ${((Date.now() - began) / 1000).toFixed(1)}s`);
  } finally {
    await machine.delete().catch(() => {});
  }
  process.exit(0);
}

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const said = async (done) => `${(await done.stdout()).trim()}${(await done.stderr()).trim() ? ` [stderr: ${(await done.stderr()).trim().slice(0, 200)}]` : ''}`;

const { Sandbox } = await import('e2b');
const { e2bScratch, __testing } = await import('../server/e2b.js');
const { shellFor, ROOT_NODE_DIR, ROOT_BROWSER_PORT } = await import('../server/sandbox.js');
const { startScript } = await import('../server/cloudBrowser/index.js');
const { TEMPLATE_NAME } = await import('../server/e2b.js');
const { tidyScript, readTidy, terminalScript, packagesIn } = await import('../server/machineCare.js');
const template = String(process.env.E2B_TEMPLATE || '').trim() || TEMPLATE_NAME;
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
  // E2B leaves /usr/local, where the image's node is, writable by everyone; a root start must not run that node.
  const rootNode = await machine.runCommand({ ...shellFor('command -v node || echo none', {}, { root: true }), sudo: true, timeoutMs: 30_000 });
  const local = await machine.runCommand({ ...shellFor('stat -c %a /usr/local/bin'), sudo: true, timeoutMs: 30_000 });
  const writable = /[2367]$/.test((await local.stdout()).trim());
  const rootFinds = (await rootNode.stdout()).trim();
  check('a root start never runs a node the account could have replaced', !writable || !rootFinds.startsWith('/usr/local'), `/usr/local/bin ${(await local.stdout()).trim()} · root finds ${rootFinds}`);
  // SBX-006: the template's own node, which only root can change, so the cloud browser's helper can run as root.
  check(template === 'base' ? "  root's node (base: the image's, which closing /usr/local made root's)" : "  root's node is the template's own, in a folder only root can change (SBX-006)", template === 'base' ? rootFinds === '/usr/local/bin/node' : rootFinds === `${ROOT_NODE_DIR}/bin/node`, rootFinds);
  const into = await run(`touch ${ROOT_NODE_DIR}/bin/planted 2>/dev/null && echo wrote || echo refused`);
  check('  which the account cannot write into', template === 'base' || (await into.stdout()).trim() === 'refused', await said(into));
  const py = await run('python3 -c "import numpy, pandas, matplotlib, openpyxl, docx, pptx, fpdf, PIL, requests, bs4, lxml; print(\'ok\')" 2>&1 | tail -1');
  check(template === 'base' ? 'Python libraries (base: not expected)' : 'the Python the assistant reaches for is already installed', template === 'base' || (await py.stdout()).trim() === 'ok', (await py.stdout()).trim().slice(0, 160));
  const fonts = await run('fc-list 2>/dev/null | grep -ciE "noto|dejavu" || echo 0');
  check(template === 'base' ? 'fonts (base: not expected)' : 'fonts for Vietnamese pages are there', template === 'base' || Number((await fonts.stdout()).trim()) > 0, (await fonts.stdout()).trim());

  section('the machine, closed when the app first meets it (SBX-011)');
  const closed = await run("/usr/bin/stat -c '%a %U' /usr/local /usr/local/bin /usr/local/bin/node; touch /usr/local/bin/planted 2>/dev/null && echo wrote || echo refused; touch /usr/local/share/planted.pm 2>/dev/null && echo wrote || echo refused; /usr/bin/sudo -n /usr/bin/id -u 2>/dev/null || echo no-sudo; id -nG");
  const closedSaid = (await closed.stdout()).trim().split('\n');
  check('/usr/local is root\'s alone, and the account cannot write there', closedSaid.slice(0, 3).every((l) => /^755 root$/.test(l)) && closedSaid[3] === 'refused' && closedSaid[4] === 'refused', closedSaid.slice(0, 5).join(' · '));
  check('  the account has no sudo', closedSaid[5] === 'no-sudo' && !/\bsudo\b/.test(closedSaid[6]), closedSaid.slice(5).join(' · '));
  const tools = await run('for t in python3 pip3 node npm; do command -v $t; done; python3 -V; npm config get prefix');
  const toolsSaid = (await tools.stdout()).trim().split('\n');
  check("  and what its commands find is as it was: the system's python3, node and npm, npm -g in its own folder", toolsSaid[0] === '/usr/bin/python3' && toolsSaid[2] === '/usr/local/bin/node' && toolsSaid[3] === '/usr/local/bin/npm' && toolsSaid[5] === '/home/user/.local', toolsSaid.join(' · '));

  // SBX-013: the helper's port as root, which an ordinary command must not be able to take first.
  const lowPort = await run(`node -e "require('net').createServer().on('error',(e)=>{console.log(e.code);process.exit()}).listen(${ROOT_BROWSER_PORT},()=>{console.log('bound');process.exit()})"`);
  check("  and it cannot open the helper's port", (await lowPort.stdout()).trim() === 'EACCES', (await lowPort.stdout()).trim());
  // envd answers on the machine itself; without its token it must not act for root.
  const envd = await run("for u in 'files?path=/etc/shadow&username=root' 'health'; do /usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code} ' \"http://localhost:49983/$u\"; done");
  check('  nor have the machine\'s own agent read a root file for it', (await envd.stdout()).trim() === '401 204', (await envd.stdout()).trim());

  section('on a machine that could not be closed, what an ordinary command leaves in /usr/local does not run as root (SBX-007..010)');
  // Opened again as E2B leaves it, and filled by the account. Each writes who ran it, one
  // log per uid: fs.protected_regular stops root appending to another uid's file in /tmp.
  const PLANTED = ['id', 'mesg', 'sh', 'dnf', 'stat', 'find', 'readlink', 'bash', 'env', 'setpriv', 'timeout', 'sudo', 'apt-get', 'npm', 'grep', 'sed', 'cat', 'mkdir', 'chmod', 'chown'];
  const planter = PLANTED.map((name) => `/usr/bin/rm -f /usr/local/bin/${name}; /usr/bin/printf '#!/bin/sh\\necho "$(/usr/bin/id -u) ${name}" >> "/tmp/ran.$(/usr/bin/id -u).log"\\nfor d in /usr/bin /bin /usr/sbin /sbin; do [ -x "$d/${name}" ] && exec "$d/${name}" "$@"; done\\n' > /usr/local/bin/${name}; /usr/bin/chmod 755 /usr/local/bin/${name}`).join('; ');
  const asRoot = (command, options = {}) => machine.runCommand({ ...shellFor(command, {}, { root: true }), sudo: true, timeoutMs: 30_000, ...options });
  await asRoot('/usr/bin/chmod -R a+rwX /usr/local');
  await run(planter);
  // Root's log only: the read's own /etc/profile runs as nobody, by design.
  const rootRan = async () => {
    const log = await asRoot('/usr/bin/sort -u /tmp/ran.0.log 2>/dev/null | /usr/bin/tr "\\n" " "; /usr/bin/rm -f /tmp/ran.*.log');
    return (await log.stdout()).trim();
  };
  await raw.commands.run('true', { user: 'root' });
  const asLogin = await rootRan();
  check("  (E2B's own login shell does run them as root — so what they are put there for is real)", /\bid\b/.test(asLogin), asLogin);
  await run('true');
  const afterOrdinary = await rootRan();
  check('an ordinary command runs none of them as root (SBX-008)', afterOrdinary === '', afterOrdinary);
  await asRoot('true');
  const afterRoot = await rootRan();
  check('  nor does a root command (SBX-007, SBX-008, SBX-010)', afterRoot === '', afterRoot);
  const started = await machine.runCommand({ ...shellFor(startScript(`probe-${Date.now()}`, { root: true }), { SYNZ_SERVICE: Buffer.from('process.exit(0)').toString('base64'), SYNZ_KERNEL: '', SYNZ_KEY: 'probe' }, { root: true }), sudo: true, timeoutMs: 180_000 });
  const afterStart = await rootRan();
  // The template's node is root's whatever happens to /usr/local; on base root then trusts no node, and stops before its install.
  check(template === 'base' ? "  nor does the cloud browser's root start, which finds no node it trusts and stops (SBX-009)" : "  nor does the cloud browser's real root start, its install included (SBX-009)", afterStart === '' && started.exitCode === (template === 'base' ? 127 : 0), `exit ${started.exitCode}${afterStart ? ` · ${afterStart}` : ''}`);
  // npm is a link in the image, which the planting took the place of.
  await asRoot(`/usr/bin/rm -f ${PLANTED.map((name) => `/usr/local/bin/${name}`).join(' ')} /tmp/ran.*.log; /usr/bin/ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm`);
  await asRoot(__testing.CLOSE_MACHINE);
  // A root command starts in the account's folder.
  await run("mkdir -p ~/pip && echo 'print(\"planted\")' > ~/pip/__main__.py");
  const fromHome = await asRoot('/usr/bin/python3 -m pip --version 2>&1');
  check('a root command imports nothing the account left in the folder it starts in (SBX-012)', !(await fromHome.stdout()).includes('planted'), (await fromHome.stdout()).trim().slice(0, 80));
  await run('rm -rf ~/pip');

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
  await paused.commands.run(__testing.CLOSE_MACHINE, { user: 'root' });
  await paused.commands.run('echo kept > /home/user/kept.txt; nohup sleep 900 >/dev/null 2>&1 &', { user: 'user' });
  await paused.pause();
  const back = await Sandbox.connect(paused.sandboxId, { apiKey: process.env.E2B_API_KEY, timeoutMs: 60_000 });
  const after = await back.commands.run('cat /home/user/kept.txt; pgrep -x sleep >/dev/null && echo running || echo stopped', { user: 'user' });
  check('its files and its running programs are there after a pause', /kept\s+running/.test(after.stdout), after.stdout.trim().replace(/\n/g, ' '));
  const stayed = await back.commands.run("/usr/bin/stat -c '%a %U' /usr/local/bin; /usr/bin/sudo -n /usr/bin/id -u 2>/dev/null || echo no-sudo", { user: 'user' });
  check('  and it comes back closed (SBX-011)', stayed.stdout.trim().replace(/\n/g, ' ') === '755 root no-sudo', stayed.stdout.trim().replace(/\n/g, ' '));

  if (process.argv.includes('--base')) {
    await machine.box?.setTimeout?.(10 * 60_000);
    /** @param {string} line @param {{ root?: boolean, timeoutMs?: number, onOutput?: (text: string) => void }} [options] */
    const run = async (line, { root: asRoot = false, timeoutMs = 90_000, onOutput } = {}) => {
      const done = await machine.runCommand({ ...shellFor(line, {}, asRoot ? { root: true } : { userBin: true }), sudo: asRoot, timeoutMs, ...(onOutput ? { onOutput } : {}) });
      return { code: done.exitCode, out: String(await done.stdout()).trim(), err: String(await done.stderr()).trim() };
    };
    section('how big it is');
    const free = await run("free -m | awk 'NR==2 { print $2 \" MiB memory, \" $7 \" available\" }'; df -m ~ | awk 'NR==2 { print $2 \" MiB disk, \" $4 \" free\" }'; nproc");
    console.log(`    ${free.out.replace(/\n/g, ' · ')}`);
    check('at least two gibibytes, where Chromium starts', Number(info.memoryMB) >= 2048, `${info.memoryMB} MiB`);

    section('every tool, with nothing installed first');
    const tools = {
      ffmpeg: 'ffmpeg -version | head -1',
      ffprobe: 'ffprobe -version | head -1',
      zip: 'zip -v | sed -n 2p',
      unzip: 'unzip -v | head -1',
      sqlite3: 'sqlite3 --version',
      soffice: 'soffice --version',
      pdftoppm: 'pdftoppm -v 2>&1 | head -1',
      tmux: 'tmux -V',
      jq: 'jq --version',
      ripgrep: 'rg --version | head -1',
      git: 'git --version',
      node: 'node -v',
      python: 'python3 --version',
      'claude (coding agent)': 'claude --version',
      'codex (coding agent)': 'codex --version',
      'amp (coding agent)': 'amp --version',
    };
    for (const [name, line] of Object.entries(tools)) {
      const got = await run(line);
      check(name, got.code === 0 && !!got.out, got.out.slice(0, 80) || got.err.slice(0, 160));
    }
    const libs = ['numpy', 'pandas', 'scipy', 'sklearn', 'statsmodels', 'sympy', 'matplotlib', 'seaborn', 'plotly', 'openpyxl', 'xlsxwriter', 'docx', 'pptx', 'fpdf', 'reportlab', 'pypdf', 'pdfplumber', 'PIL', 'cv2', 'pydub', 'requests', 'httpx', 'certifi', 'bs4', 'lxml', 'yaml', 'markdown', 'jinja2', 'tabulate', 'tqdm', 'playwright'];
    const imported = await run(`python3 - <<'PY'\nimport importlib\nbad = []\nfor name in ${JSON.stringify(libs)}:\n    try:\n        importlib.import_module(name)\n    except Exception as e:\n        bad.append(f"{name}: {e}")\nprint('; '.join(bad) or 'all imported')\nPY`);
    check(`${libs.length} Python libraries import`, imported.out === 'all imported', imported.out.slice(0, 300) || imported.err.slice(0, 300));

    section('pip, the bug that cost an afternoon');
    const which = await run('command -v python3; command -v pip; pip --version');
    check('pip belongs to the python3 a command finds', /\/usr\/bin\/python3/.test(which.out) && /\/usr\/bin\/pip/.test(which.out) && /python 3/i.test(which.out), which.out.replace(/\n/g, ' · '));
    const asUser = await run('pip install -q cowsay 2>&1 | tail -2; python3 -c "import cowsay; print(cowsay.__file__)"');
    check('installed as the account, it imports', asUser.code === 0 && /cowsay/.test(asUser.out), asUser.out.slice(-200));
    const asRootPip = await run('pip install -q pyfiglet 2>&1 | tail -2; echo done', { root: true });
    const seen = await run('python3 -c "import pyfiglet; print(pyfiglet.__file__)"');
    check('installed as root, the account imports it', seen.code === 0 && /pyfiglet/.test(seen.out), `${asRootPip.out.slice(-80)} → ${seen.out || seen.err.slice(-160)}`);
    check('and either is remembered for a new machine', packagesIn('pip install -q cowsay && apt-get install -y sl').pip[0] === 'cowsay');

    section('files, for real');
    await machine.writeFiles([{ path: 'probe-vi.py', content: Buffer.from(`from fpdf import FPDF
pdf = FPDF()
pdf.add_page()
pdf.add_font("DejaVu", "", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
pdf.set_font("DejaVu", "", 14)
pdf.multi_cell(0, 8, "Tiếng Việt có dấu: phở bò, bún chả, chữ ký, hoá đơn")
pdf.output("probe-vi.pdf")
from docx import Document
d = Document()
d.add_heading("Báo cáo tiếng Việt", 1)
d.add_paragraph("Doanh thu tăng 12%")
d.save("probe.docx")
from pptx import Presentation
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0])
s.shapes.title.text = "Trang trình bày"
p.save("probe.pptx")
`) }]);
    const madeFiles = await run('python3 probe-vi.py && pdftotext probe-vi.pdf - | head -2');
    check('a Vietnamese PDF keeps its accents', /Tiếng Việt có dấu/.test(madeFiles.out), madeFiles.out.slice(0, 120) || madeFiles.err.slice(-200));
    for (const file of ['probe.docx', 'probe.pptx']) {
      const began = Date.now();
      const converted = await run(`soffice --headless --convert-to pdf ${file} >/dev/null 2>&1; pdftoppm -r 60 -jpeg ${file.replace(/\.\w+$/, '.pdf')} page && ls page* | wc -l; rm -f page*`, { timeoutMs: 120_000 });
      check(`LibreOffice draws ${file}`, converted.code === 0 && Number(converted.out) >= 1, `${converted.out} page(s), ${((Date.now() - began) / 1000).toFixed(1)}s`);
    }
    const media = await run('ffmpeg -loglevel error -f lavfi -i sine=frequency=440:duration=1 -y probe.mp3 && ffprobe -v error -show_entries format=duration -of csv=p=0 probe.mp3 && zip -q probe.zip probe.mp3 probe.docx && unzip -l probe.zip | tail -1 && sqlite3 :memory: "select 40+2"');
    check('ffmpeg, zip and sqlite3 do their work', media.code === 0 && /42$/.test(media.out), media.out.replace(/\n/g, ' · '));
    const clone = await run('git clone -q --depth 1 https://github.com/octocat/Hello-World.git probe-clone && ls probe-clone && rm -rf probe-clone', { timeoutMs: 60_000 });
    check('git clone over the internet', clone.code === 0 && /README/.test(clone.out), clone.err.slice(-120));

    section('a browser from Python, on the same machine');
    await machine.writeFiles([{ path: 'probe-pw.py', content: Buffer.from(`from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content("<title>Tiếng Việt</title><h1>ok</h1>")
    print(page.title())
    page.screenshot(path="probe-pw.png")
    b.close()
`) }]);
    const pw = await run('python3 probe-pw.py 2>&1 | tail -3 && ls -la probe-pw.png | wc -l', { timeoutMs: 120_000 });
    check('Playwright with its Chromium runs and takes a picture', /Tiếng Việt/.test(pw.out), pw.out.slice(-240));

    section('what lasts between calls');
    const out = [];
    await run(terminalScript({ action: 'start', name: 'probe', text: 'python3', wait_seconds: 1 }));
    await run(terminalScript({ action: 'send', name: 'probe', text: 'x = 6 * 7', wait_seconds: 1 }));
    const screen = await run(terminalScript({ action: 'send', name: 'probe', text: 'print(x)', wait_seconds: 1 }));
    check('a terminal keeps its program between calls', /\b42\b/.test(screen.out), screen.out.slice(-160) || screen.err.slice(-160));
    await run(terminalScript({ action: 'stop', name: 'probe' }));
    const streamed = await run('for i in 1 2 3; do echo line$i; sleep 1; done', { onOutput: (text) => out.push(text) });
    check('what a command prints arrives as it prints', out.length >= 3 && streamed.out.includes('line3'), `${out.length} pieces`);

    section('reaching it from outside');
    await machine.writeFiles([{ path: 'probe-link.txt', content: Buffer.from('from the machine') }]);
    const link = await machine.downloadUrl('probe-link.txt');
    const fetched = await fetch(link).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String(e) }));
    check('a signed link hands over a file, past this server', fetched.status === 200 && fetched.text === 'from the machine', `${fetched.status} ${fetched.text.slice(0, 80)}`);
    await machine.runCommand({ ...shellFor('cd ~ && exec python3 -m http.server 18080', {}, { userBin: true }), detached: true });
    await new Promise((r) => setTimeout(r, 2500));
    const served = await fetch(machine.domain(18080)).then((r) => r.status).catch((e) => String(e));
    check('a port it opens has a public address', served === 200, String(served));

    section('a checkpoint');
    await machine.writeFiles([{ path: 'probe-check.txt', content: Buffer.from('before') }]);
    const snapshot = await machine.box.createSnapshot();
    check('saved', !!snapshot?.snapshotId, snapshot?.snapshotId);
    const fromIt = await Sandbox.create(snapshot.snapshotId, { apiKey: process.env.E2B_API_KEY, timeoutMs: 120_000, metadata: { app: 'synapsez', role: 'probe' } });
    machines.push({ delete: () => fromIt.kill() });
    const kept = await fromIt.commands.run('cat /home/user/probe-check.txt', { user: 'user' });
    check('a machine made from it finds the file', kept.stdout.trim() === 'before', kept.stdout.trim());
    await Sandbox.deleteSnapshot(snapshot.snapshotId, { apiKey: process.env.E2B_API_KEY }).catch(() => {});

    section('room behind the memory');
    const swap = await run('fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; free -m | tail -1', { root: true });
    console.log(`    swap: ${swap.out || swap.err.slice(-160)}`);
    // The fullest tier, which does the most: on a probe machine there is nothing of anybody's to lose.
    const tidied = await run(tidyScript(3), { timeoutMs: 60_000 });
    const read = readTidy(tidied.out);
    check('tidying says how full the disk was before and after, and what is largest', !!read && read.biggest.length > 0, tidied.out.slice(-300));
  }

  if (process.argv.includes('--browser')) {
    section('Chromium, the way the cloud browser starts it');
    const install = await machine.runCommand({
      ...shellFor('mkdir -p ~/b && cd ~/b && printf \'{"private":true}\' > package.json && npm install --no-save --no-audit --no-fund --ignore-scripts --loglevel=error playwright-core@1.63.0 @sparticuz/chromium@153.0.0 2>&1 | tail -3; exit ${PIPESTATUS[0]}'),
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
    const launched = await machine.runCommand({ ...shellFor('cd ~/b && node launch.mjs 2>&1 | tail -5', { VERCEL: '1', AWS_LAMBDA_JS_RUNTIME: 'nodejs22.x' }, { userBin: true }), timeoutMs: 120_000 });
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
