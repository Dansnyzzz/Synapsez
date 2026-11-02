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
 *     command and the Python session find first. E2B leaves /usr/local
 *     writable by everyone (mode 777 on a running machine, whatever a build
 *     step sets — live probe, 2026-11-02), so shellFor puts it after the
 *     system's folders, and its own python3 is not the one that runs;
 *   - the cloud browser's own packages, fetched once into the account's npm
 *     cache, so its first start unpacks rather than downloads. Not root's:
 *     with node only in that writable /usr/local, the root start finds no
 *     node it can trust and comes up as the account, by design (shellFor).
 *
 * Run it once, then set E2B_TEMPLATE to the name it prints — on Vercel as well
 * as in .env. Running it again rebuilds the same name.
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

const NAME = 'synapsez-computer';
const cpuCount = Math.max(1, Number(process.env.E2B_TEMPLATE_CPUS) || 2);
const memoryMB = Math.max(512, Number(process.env.E2B_TEMPLATE_MEMORY_MB) || 2048);
const PYTHON = ['numpy', 'pandas', 'matplotlib', 'openpyxl', 'python-docx', 'python-pptx', 'fpdf2', 'pillow', 'requests', 'beautifulsoup4', 'lxml'];

const { DEPS } = await import('../server/cloudBrowser/index.js');
const warm = (folder) =>
  `mkdir -p ${folder} && cd ${folder} && printf '{"private":true}' > package.json && ` +
  `npm install --no-save --no-audit --no-fund --loglevel=error ${DEPS.join(' ')} && cd / && rm -rf ${folder}`;

const { Template, defaultBuildLogger } = await import('e2b');
const template = Template()
  .fromBaseImage()
  .aptInstall(['fonts-noto-core', 'fonts-dejavu-core'], { noInstallRecommends: true })
  .runCmd(
    [
      '/usr/bin/python3 -m pip --version >/dev/null 2>&1 || (apt-get update -q && apt-get install -y -q --no-install-recommends python3-pip)',
      // Debian marks its Python as managed by apt (PEP 668); pip older than that has no such flag.
      `/usr/bin/python3 -m pip install -q --no-cache-dir --break-system-packages ${PYTHON.join(' ')} || /usr/bin/python3 -m pip install -q --no-cache-dir ${PYTHON.join(' ')}`,
    ],
    { user: 'root' },
  )
  .runCmd(warm('/tmp/synz-warm-user'), { user: 'user' });

console.log(`\n  Building ${NAME} (${cpuCount} vCPU, ${memoryMB} MiB) from E2B's base…\n`);
const built = await Template.build(template, NAME, { apiKey: process.env.E2B_API_KEY, cpuCount, memoryMB, onBuildLogs: defaultBuildLogger() });
console.log(`\n  Built ${built.name} (template ${built.templateId}).`);
console.log(`  Now set E2B_TEMPLATE=${NAME} in .env and in the Vercel project's environment variables, then redeploy.\n`);
