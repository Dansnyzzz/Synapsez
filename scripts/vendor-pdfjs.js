#!/usr/bin/env node
/**
 * Copy pdf.js into public/vendor/pdfjs, where the browser can load it.
 *
 * Same reasoning as `vendor-katex.js`: the page has no build step and a
 * Content-Security-Policy of `script-src 'self'`, so a CDN is out — and on
 * Vercel `public/` is served as static files while `node_modules` is not there
 * at all. The files are copied here and committed, and `test/projects.test.mjs`
 * fails when the copy's version no longer matches the installed package, so
 * upgrading pdfjs without re-running this cannot go unnoticed.
 *
 * What it is *for* is narrow, and worth being clear about: in the browser that
 * is uploading a PDF — to a project's shelf or to the composer — it draws the
 * first page once as a thumbnail, and reads the text of one too large to send
 * (public/js/thumbnail.js, shrink.js). It is not a viewer — the app still hands
 * a PDF to the browser's own reader, which is better than anything this could
 * build. So it is loaded on demand, only by someone adding a PDF.
 *
 * The thumbnail is drawn here rather than on the server so it is made once, by
 * a browser that already has a canvas. The server's own pdfjs (server/pdf.js)
 * draws pages only for a model to look at, onto `@napi-rs/canvas`, and says
 * "cannot look" on a platform where that native module will not load.
 *
 *   node scripts/vendor-pdfjs.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

// The modern build, not `legacy/`: this runs in a browser that already supports
// modules, and the legacy one carries polyfills for browsers that do not.
const dist = path.join(pkgDir, 'build');
const out = path.join(ROOT, 'public', 'vendor', 'pdfjs');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Two files and no more. The viewer, its stylesheet, the character maps and the
// standard fonts are all for *displaying* a document; rendering one page to a
// thumbnail needs none of them.
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(dist, file), path.join(out, file));
}

fs.writeFileSync(path.join(out, 'VERSION'), `${version}\n`);

const size = ['pdf.min.mjs', 'pdf.worker.min.mjs']
  .map((f) => fs.statSync(path.join(out, f)).size)
  .reduce((a, b) => a + b, 0);

console.log(`pdfjs ${version} → public/vendor/pdfjs (${Math.round(size / 1024)}KB, loaded only to thumbnail a PDF)`);
