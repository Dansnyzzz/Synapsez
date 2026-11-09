import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUser } from './auth.js';
import { themeAssetAccess } from './themes.js';

/**
 * Each theme's own files — its scene module, its still and, for an event, its moving
 * picture — served at the addresses they always had (`/js/scenes/<id>.js`,
 * `/assets/scenes/<id>.webp|gif`), but from under server/ rather than public/.
 *
 * In public/ they were anybody's before the theme came out: whoever guessed the address
 * saw the aurora a month early (security review, 2026-11-09). Here a theme that is out
 * is everybody's, cached by the CDN for a day; one that is not yet is an administrator's
 * (who sees the whole collection ahead of time) or its holder's, never cached, and a
 * 404 to anyone else — the same answer as a file that does not exist, so the address
 * says nothing about what is coming. The engine, the shared art and the catalogue stay
 * in public/: they hold no theme's look.
 *
 * On Vercel, `vercel.json` sends these two paths to the function, since nothing in
 * public/ answers them any more.
 */
const ROOT = fileURLToPath(new URL('./scenes/', import.meta.url));
/** The shared scene files that stay public (the engine, the art, the catalogue, the pets). */
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.webp': 'image/webp', '.gif': 'image/gif', '.js': 'text/javascript; charset=utf-8' };
const NAME = /^([a-z0-9-]{1,40})(\.webp|\.gif|\.js)$/;

/** @param {import('express').Express} app @param {{ wrap: Function }} deps */
export function mountSceneAssets(app, { wrap }) {
  /** @param {'assets' | 'js'} folder @param {string[]} kinds */
  const serve = (folder, kinds) =>
    wrap(async (req, res, next) => {
      const file = String(req.params.file || '');
      const match = NAME.exec(file);
      const access = match && kinds.includes(match[2]) ? await themeAssetAccess(match[1], { user: () => currentUser(req).catch(() => null) }) : null;
      const missing = () => res.set('Cache-Control', 'no-store').status(404).type('text/plain').send('Not found');
      // Not a theme's file: the engine, the art, the catalogue are in public/; anything else is
      // a missing file, not the app's page.
      if (access === null) return fs.existsSync(path.join(PUBLIC, folder === 'js' ? 'js' : 'assets', 'scenes', path.basename(file))) ? next() : missing();
      if (access === 'none') return missing();
      res.set('Cache-Control', access === 'public' ? 'public, max-age=3600, s-maxage=86400' : 'private, no-store');
      res.type(TYPES[match[2]]);
      res.sendFile(path.join(ROOT, folder, match[0]), (err) => {
        if (err && !res.headersSent) res.status(404).type('text/plain').send('Not found');
      });
    });
  app.get('/assets/scenes/:file', serve('assets', ['.webp', '.gif']));
  app.get('/js/scenes/:file', serve('js', ['.js']));
}
