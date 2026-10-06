#!/usr/bin/env node
/**
 * Copy Tesseract's Vietnamese and English models into server/assets/tessdata.
 *
 * Left alone, tesseract.js fetches them from jsdelivr the first time each
 * process reads a picture — on a serverless deployment, on every cold start:
 * five seconds of a turn spent downloading, and a turn that fails outright on a
 * day the CDN does not answer. Shipped with the server they are read from disk,
 * which is the whole point of an OCR that needs no one's permission.
 *
 * `4.0.0_best_int` is the set tesseract.js itself chooses for the LSTM engine
 * (the only one this app loads): the accurate models, quantised, 4.2 MB for both
 * languages. `test/features.test.mjs` fails when the copy no longer matches the
 * installed packages, so an upgrade cannot leave a stale model behind.
 *
 *   node scripts/vendor-tessdata.js
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// The one list of languages, so the models shipped are the ones the server reads.
import { LANGS } from '../server/ocr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SET = '4.0.0_best_int';
const out = path.join(ROOT, 'server', 'assets', 'tessdata');

// Emptied first, as the katex and pdfjs copies are: a language taken off the
// list would otherwise stay in the repository and in every deployment.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const manifest = {};
for (const lang of LANGS) {
  const pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const file = `${lang}.traineddata.gz`;
  const bytes = fs.readFileSync(path.join(pkgDir, SET, file));
  fs.writeFileSync(path.join(out, file), bytes);
  manifest[lang] = { package: version, set: SET, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
fs.writeFileSync(path.join(out, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Tesseract models (${LANGS.join(', ')}, ${SET}) copied to server/assets/tessdata`);
