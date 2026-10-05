#!/usr/bin/env node
/**
 * Copy KaTeX into public/vendor/katex, where the browser can load it.
 *
 * The page has no build step and a Content-Security-Policy of `script-src
 * 'self'`, so a CDN is out and so is importing from node_modules at runtime —
 * on Vercel, `public/` is served as static files and node_modules is not. The
 * files are copied here and committed; `test/markdown-math.test.mjs` fails when the
 * copy's version no longer matches the installed package, so upgrading KaTeX
 * without re-running this cannot go unnoticed.
 *
 * Only what a modern browser fetches is copied: the minified script, the
 * `font-display: swap` stylesheet (text is readable while fonts load), and the
 * WOFF2 fonts, with the older WOFF/TTF fallbacks removed from the stylesheet so
 * nothing points at a file that is not there.
 *
 *   node scripts/vendor-katex.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('katex/package.json'));
const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const dist = path.join(pkgDir, 'dist');
const out = path.join(ROOT, 'public', 'vendor', 'katex');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

fs.copyFileSync(path.join(dist, 'katex.min.js'), path.join(out, 'katex.min.js'));

const css = fs
  .readFileSync(path.join(dist, 'katex-swap.min.css'), 'utf8')
  // `src:url(a.woff2) format("woff2"),url(a.woff) format("woff"),url(a.ttf) format("truetype")`
  .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '');
fs.writeFileSync(path.join(out, 'katex.min.css'), css);

let fonts = 0;
for (const name of fs.readdirSync(path.join(dist, 'fonts'))) {
  if (!name.endsWith('.woff2')) continue;
  fs.copyFileSync(path.join(dist, 'fonts', name), path.join(out, 'fonts', name));
  fonts += 1;
}

const license = ['LICENSE', 'LICENSE.txt'].map((n) => path.join(pkgDir, n)).find((p) => fs.existsSync(p));
if (license) fs.copyFileSync(license, path.join(out, 'LICENSE'));
fs.writeFileSync(path.join(out, 'VERSION'), `${version}\n`);

console.log(`KaTeX ${version}: script, stylesheet and ${fonts} fonts copied to public/vendor/katex`);
