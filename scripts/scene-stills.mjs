/**
 * Draw every scene and keep a still of it (owner, 2026-11-06).
 *
 * A tile in a list of twenty themes must not paint twenty scenes: it is this picture,
 * made ahead of time, and only the one being looked at moves. A test holds these to
 * the catalogue, so a new or redrawn scene without one fails rather than showing a
 * blank tile.
 *
 *   npm run scenes:stills                 every scene, into server/scenes/assets/
 *   node scripts/scene-stills.mjs --look <folder> [--only id,id] [--at 3,9,27] [--size 1280x720]
 *        full-size frames to look at, drawn the way the app shows them
 */
/* global window, document */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

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
const look = option('--look');
const only = option('--only')?.split(',') || null;
const moments = option('--at')?.split(',').map(Number) || null;
const [viewWidth, viewHeight] = (option('--size') || '1280x720').split('x').map(Number);

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
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: viewWidth, height: viewHeight } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
await page.goto(base);

const ids = await page.evaluate(async () => Object.keys((await import('/js/scenes/catalog.js')).CATALOG));
const wanted = ids.filter((id) => (only ? only.includes(id) : !id.startsWith('pet-')));
const out = look ? path.resolve(look) : path.join(themes, 'assets');
fs.mkdirSync(out, { recursive: true });

/** One moment of one scene, on the page's own thread, returned as bytes. */
const frame = (id, at, width, height, type, quality) =>
  page.evaluate(
    async ({ id, at, width, height, type, quality }) => {
      const { CATALOG } = await import('/js/scenes/catalog.js');
      const facts = CATALOG[id];
      const scene = (await import(`/js/scenes/${facts.module || id}.js`)).default;
      const painted = facts.module ? scene[id] : scene;
      window.__worlds ||= new Map();
      if (!window.__worlds.has(id)) window.__worlds.set(id, painted.build());
      const canvas = document.createElement('canvas');
      canvas.width = facts.width || 480;
      canvas.height = facts.height || 270;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = !!facts.smooth;
      painted.draw(ctx, at ?? facts.still, window.__worlds.get(id));
      const small = document.createElement('canvas');
      small.width = width;
      small.height = height;
      const c = small.getContext('2d');
      c.imageSmoothingEnabled = !!facts.smooth;
      c.imageSmoothingQuality = 'high';
      c.drawImage(canvas, 0, 0, width, height);
      return small.toDataURL(type, quality).split(',')[1];
    },
    { id, at, width, height, type, quality },
  );

let total = 0;
for (const id of wanted) {
  const started = Date.now();
  if (look) {
    for (const at of moments || [null]) {
      const name = `${id}${at === null ? '' : `-t${at}`}.png`;
      fs.writeFileSync(path.join(out, name), Buffer.from(await frame(id, at, viewWidth, viewHeight, 'image/png'), 'base64'));
    }
  } else {
    const bytes = Buffer.from(await frame(id, null, 320, 180, 'image/webp', 0.86), 'base64');
    fs.writeFileSync(path.join(out, `${id}.webp`), bytes);
    total += bytes.length;
  }
  console.log(id, `${Date.now() - started} ms`);
}
if (!look) console.log(`${wanted.length} stills, ${Math.round(total / 1024)} KB`);
if (errors.length) console.log('page errors:', errors.join('\n'));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
