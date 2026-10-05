#!/usr/bin/env node
/**
 * Copy Vercel Web Analytics and Speed Insights into public/vendor/vercel, where
 * the browser can load them.
 *
 * Same reasoning as `vendor-katex.js` and `vendor-pdfjs.js`: the page has no
 * build step and a Content-Security-Policy of `script-src 'self'`, and on Vercel
 * `public/` is served as static files while `node_modules` is not there at all.
 * What is copied is each package's framework-free entry (`dist/index.mjs`, a few
 * kilobytes) and its licence. Those entries only add a deferred
 * `<script src="/_vercel/…">` that Vercel itself serves from this same origin, so
 * the policy needs no new host. `test/features.test.mjs` fails when a copy's
 * version no longer matches the installed package.
 *
 * Loaded only on a Vercel deployment, and only when the visitor's browser has
 * not asked not to be tracked — see public/js/insights.js.
 *
 *   node scripts/vendor-insights.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const out = path.join(ROOT, 'public', 'vendor', 'vercel');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const versions = [];
for (const [pkg, name] of [
  ['@vercel/analytics', 'analytics'],
  ['@vercel/speed-insights', 'speed-insights'],
]) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  // The source map is not copied, so its comment goes too — otherwise every open
  // developer console asks for a file that is not there.
  const source = fs.readFileSync(path.join(dir, 'dist', 'index.mjs'), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '');
  fs.writeFileSync(path.join(out, `${name}.mjs`), source);
  fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(out, `${name}.LICENSE`));
  versions.push(`${pkg} ${version}`);
}

// One line per package, so the drift check can read each version back.
fs.writeFileSync(path.join(out, 'VERSION'), `${versions.join('\n')}\n`);
console.log(`${versions.join(', ')} → public/vendor/vercel`);
