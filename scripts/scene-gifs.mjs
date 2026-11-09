/**
 * An event theme's preview that moves for ever, for the top of its announcement
 * email (owner, 2026-11-08). Drawn the way the stills are (scripts/scene-stills.mjs),
 * a few seconds of the scene, its end faded into its start so the loop has no seam.
 *
 *   npm run scenes:gifs                    every event theme, into server/scenes/assets/
 *   node scripts/scene-gifs.mjs --only aurora-peak --seconds 4 --fps 12 --width 480
 */
/* global window, document */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { encodeGif } from './gif-encode.mjs';
import { THEMES } from '../server/themes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
/** Each theme's own files live under server/ since 2026-11-09 (server/sceneAssets.js), at the same addresses. */
const themes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/scenes');
/** Where a path is served from: a theme's file under server/scenes, anything else under public. @param {string} pathname */
const fileFor = (pathname) => {
  const own = /^\/(js|assets)\/scenes\/([a-z0-9-]+\.(?:js|webp|gif))$/.exec(pathname);
  const there = own ? path.join(themes, own[1], own[2]) : null;
  return there && fs.existsSync(there) ? there : path.join(root, pathname);
};
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = option('--only')?.split(',') || null;
const seconds = Number(option('--seconds')) || 4;
const fps = Number(option('--fps')) || 12;
const width = Number(option('--width')) || 480;
const height = Math.round((width * 9) / 16);
/** How much of the loop's end is faded into its start. */
const FADE = 0.25;

const TYPES = { '.js': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>scenes</title><body style="margin:0;background:#000"></body>');
    return;
  }
  const file = fileFor(url.pathname);
  if (!(file.startsWith(root) || file.startsWith(themes)) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
await page.goto(`http://127.0.0.1:${server.address().port}`);

const wanted = THEMES.filter((theme) => theme.event && (!only || only.includes(theme.id))).map((theme) => theme.id);
const frames = Math.round(seconds * fps);
const fade = Math.round(frames * FADE);

for (const id of wanted) {
  const started = Date.now();
  // The frames, and as many again past the end to fade into the start.
  const raw = await page.evaluate(
    async ({ id, count, fps, width, height }) => {
      const { CATALOG } = await import('/js/scenes/catalog.js');
      const facts = CATALOG[id];
      const scene = (await import(`/js/scenes/${facts.module || id}.js`)).default;
      const painted = facts.module ? scene[id] : scene;
      const world = painted.build();
      const canvas = document.createElement('canvas');
      canvas.width = facts.width || 480;
      canvas.height = facts.height || 270;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = !!facts.smooth;
      const small = document.createElement('canvas');
      small.width = width;
      small.height = height;
      const c = small.getContext('2d', { willReadFrequently: true });
      c.imageSmoothingEnabled = !!facts.smooth;
      c.imageSmoothingQuality = 'high';
      const out = [];
      for (let i = 0; i < count; i += 1) {
        painted.draw(ctx, facts.still + i / fps, world);
        c.drawImage(canvas, 0, 0, width, height);
        const data = c.getImageData(0, 0, width, height).data;
        let text = '';
        for (let k = 0; k < data.length; k += 0x8000) text += String.fromCharCode(...data.subarray(k, k + 0x8000));
        out.push(window.btoa(text));
      }
      return out;
    },
    { id, count: frames + fade, fps, width, height },
  );
  const rgba = raw.map((b64) => new Uint8ClampedArray(Buffer.from(b64, 'base64')));
  // The start fades in from what follows the end, so the last frame leads into the first.
  const loop = rgba.slice(0, frames).map((frame, k) => {
    if (k >= fade) return frame;
    const tail = rgba[frames + k];
    const a = k / fade;
    const mixed = new Uint8ClampedArray(frame.length);
    for (let i = 0; i < frame.length; i += 1) mixed[i] = tail[i] * (1 - a) + frame[i] * a;
    return mixed;
  });
  const gif = encodeGif({ width, height, frames: loop, delayMs: 1000 / fps });
  const file = path.join(themes, 'assets', `${id}.gif`);
  fs.writeFileSync(file, gif);
  console.log(id, `${Math.round(gif.length / 1024)} KB`, `${Date.now() - started} ms`);
}
if (errors.length) console.log('page errors:', errors.join('\n'));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
