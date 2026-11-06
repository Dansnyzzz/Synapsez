/**
 * Build the E2B template the cloud computers are made from (owner, 2026-11-02).
 *
 * E2B's `base` works as it is; this one is the same Debian with what the
 * assistant reaches for most already there, so no machine spends its first
 * minutes — billed by the second — installing it:
 *
 *   - room: 2 vCPU and 2 GiB, where a Chromium page and a pandas frame both
 *     fit (`base` has 512 MiB);
 *   - fonts for Vietnamese and other accented or non-Latin pages;
 *   - the Python the system prompt points at — data, charts, Word, Excel,
 *     PowerPoint, PDF (fpdf2), web pages — for /usr/bin/python3, the one a
 *     command and the Python session find first. Nothing a build step closes
 *     holds: E2B leaves /usr/local at mode 777 and the account with `sudo` on a
 *     running machine, whatever is set here (live probe, 2026-11-02). The app
 *     closes those when it first meets a machine (server/e2b.js `CLOSE_MACHINE`);
 *   - a node only root can change (SBX-006): the image's own node and npm,
 *     copied at build time — before anything of the account's has run — into
 *     /opt/synz-node, owned by root and written by nobody else, which holds
 *     even on a machine that could not be closed. shellFor uses it when /opt
 *     and the whole folder are root's, and the cloud browser's helper runs as
 *     root with it, the sign-ins out of reach;
 *   - the cloud browser's own packages, fetched once into root's npm cache and
 *     the account's (the root start falls back to the account's), so a first
 *     start unpacks rather than downloads;
 *   - everything a person new to all this would otherwise be told to install
 *     (owner, 2026-11-05): ffmpeg, zip, sqlite3, LibreOffice with a first start
 *     already done, poppler, tmux; Playwright with its Chromium; the coding agents.
 *     On disk they cost nothing while they are not running, and a machine pays by
 *     the second for what it spends installing. Past the disk what is left is a
 *     person's own; past the memory the model says so or uses a tool instead;
 *   - one `pip` (the owner's "pip path bug"). The image has two Pythons, and on the
 *     PATH a command gets, `python3` is /usr/bin's while `pip` was /usr/local/bin's:
 *     pip said a package was installed and Python could not import it.
 *
 * Run it after changing this file, and raise BASE_VERSION in server/e2b.js: machines
 * made from an older build move to the new one, keeping their files. The name is in
 * server/e2b.js too, so nothing has to be set anywhere; E2B_TEMPLATE overrides it.
 *
 *   npm run e2b:template
 *
 * A bigger machine costs more a minute (server/e2b.js prices each by its own
 * size), so the size is a choice: E2B_TEMPLATE_CPUS / E2B_TEMPLATE_MEMORY_MB.
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

const { TEMPLATE_NAME: NAME, TEMPLATE_SIZE, ONE_PIP } = await import('../server/e2b.js');
const cpuCount = Math.max(1, Number(process.env.E2B_TEMPLATE_CPUS) || TEMPLATE_SIZE.cpu);
const memoryMB = Math.max(512, Number(process.env.E2B_TEMPLATE_MEMORY_MB) || TEMPLATE_SIZE.memMb);
const PYTHON = [
  // Numbers and charts.
  'numpy', 'pandas', 'scipy', 'scikit-learn', 'statsmodels', 'sympy', 'matplotlib', 'seaborn', 'plotly',
  // Office and PDF.
  'openpyxl', 'xlsxwriter', 'python-docx', 'python-pptx', 'fpdf2', 'reportlab', 'pypdf', 'pdfplumber',
  // Pictures and sound.
  'pillow', 'opencv-python-headless', 'pydub',
  // The web and text.
  'requests', 'httpx', 'certifi', 'beautifulsoup4', 'lxml', 'pyyaml', 'markdown', 'jinja2', 'tabulate', 'tqdm', 'playwright',
];
const SYSTEM = [
  'fonts-noto-core', 'fonts-dejavu-core', 'fonts-liberation', 'fonts-crosextra-carlito', 'fonts-crosextra-caladea',
  'ffmpeg', 'zip', 'unzip', 'sqlite3', 'poppler-utils', 'tmux', 'jq', 'ripgrep',
  'libreoffice-core', 'libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress',
];
/** Coding agents, for somebody with their own key. They do nothing until started, and need that key to start. */
const AGENTS = ['@anthropic-ai/claude-code', '@openai/codex', '@sourcegraph/amp'];
/** One folder for everybody: a browser fetched into one account's cache is not there for the next. */
const BROWSERS = '/opt/ms-playwright';

const { DEPS } = await import('../server/cloudBrowser/index.js');
const { ROOT_NODE_DIR } = await import('../server/sandbox.js');
const warm = (folder) =>
  `mkdir -p ${folder} && cd ${folder} && printf '{"private":true}' > package.json && ` +
  `npm install --no-save --no-audit --no-fund --loglevel=error ${DEPS.join(' ')} && cd / && rm -rf ${folder}`;

// The image's node and npm, wherever it keeps them, copied whole: a link would
// still lead back into /usr/local. One command, so the names set first hold.
const rootNode = [
  'NODE="$(readlink -f "$(command -v node)")" && NPM="$(dirname "$NODE")/../lib/node_modules/npm" && test -x "$NODE" && test -f "$NPM/bin/npm-cli.js"',
  `rm -rf ${ROOT_NODE_DIR} && install -d -m 755 -o root -g root ${ROOT_NODE_DIR} ${ROOT_NODE_DIR}/bin ${ROOT_NODE_DIR}/lib ${ROOT_NODE_DIR}/lib/node_modules`,
  `cp "$NODE" ${ROOT_NODE_DIR}/bin/node && cp -R "$NPM" ${ROOT_NODE_DIR}/lib/node_modules/npm`,
  `ln -s ../lib/node_modules/npm/bin/npm-cli.js ${ROOT_NODE_DIR}/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js ${ROOT_NODE_DIR}/bin/npx`,
  `chown -R root:root ${ROOT_NODE_DIR} && chmod -R u+rwX,go+rX,go-w ${ROOT_NODE_DIR} && chmod 755 /opt`,
  `${ROOT_NODE_DIR}/bin/node -v && PATH=${ROOT_NODE_DIR}/bin:/usr/bin:/bin ${ROOT_NODE_DIR}/bin/npm -v`,
].join(' && ');

const { Template, defaultBuildLogger } = await import('e2b');
const template = Template()
  .fromBaseImage()
  .aptInstall(SYSTEM, { noInstallRecommends: true })
  .runCmd(
    [
      '/usr/bin/python3 -m pip --version >/dev/null 2>&1 || (apt-get update -q && apt-get install -y -q --no-install-recommends python3-pip)',
      // Debian marks its Python as managed by apt (PEP 668); pip older than that has no such flag.
      `/usr/bin/python3 -m pip install -q --no-cache-dir --break-system-packages ${PYTHON.join(' ')} || /usr/bin/python3 -m pip install -q --no-cache-dir ${PYTHON.join(' ')}`,
      ONE_PIP,
      // For every command: /etc/profile reads this folder, and is what a command's shell reads (shellFor).
      `printf 'export PLAYWRIGHT_BROWSERS_PATH=${BROWSERS}\\n' > /etc/profile.d/synz-browsers.sh && chmod 644 /etc/profile.d/synz-browsers.sh`,
      `PLAYWRIGHT_BROWSERS_PATH=${BROWSERS} /usr/bin/python3 -m playwright install --with-deps chromium && chmod -R a+rX ${BROWSERS}`,
      rootNode,
      `npm install -g --no-audit --no-fund --loglevel=error ${AGENTS.join(' ')}`,
    ],
    { user: 'root' },
  )
  .runCmd(`PATH=${ROOT_NODE_DIR}/bin:/usr/bin:/bin && ${warm('/tmp/synz-warm-root')}`, { user: 'root' })
  .runCmd(warm('/tmp/synz-warm-user'), { user: 'user' })
  // Its first start writes a profile and a font cache, about ten seconds that every conversion would otherwise wait.
  .runCmd("cd /tmp && echo warm > synz-warm.txt && soffice --headless --convert-to pdf synz-warm.txt >/dev/null 2>&1; rm -f synz-warm.txt synz-warm.pdf; true", { user: 'user' });

console.log(`\n  Building ${NAME} (${cpuCount} vCPU, ${memoryMB} MiB) from E2B's base…\n`);
const built = await Template.build(template, NAME, { apiKey: process.env.E2B_API_KEY, cpuCount, memoryMB, onBuildLogs: defaultBuildLogger() });
console.log(`\n  Built ${built.name} (template ${built.templateId}).`);
