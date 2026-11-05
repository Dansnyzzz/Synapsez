import { requirePermission } from '../adminRoles.js';
import { clientError } from '../util/clientError.js';
import { adminThemes, equipTitle, giveTheme, listThemes, listTitles, ranking, selectTheme, setThemeBadge, takeTheme, themePeople } from '../themes.js';

/**
 * Themes, ranking and titles over HTTP. The rules are in server/themes.js; what
 * each answer holds is docs/superpowers/specs/2026-11-04-themes-ranking-contract.md.
 *
 * Nothing here takes an account from the request except the two lines that give
 * and take a theme, and those are behind the `themes` permission.
 *
 * @param {{ api: any, admin: any, wrap: Function, audit: Function }} deps
 */
export function mountThemeRoutes({ api, admin, wrap, audit }) {
  /** A refusal `server/themes.js` said in words, or the usual failure. */
  const answering = (handler) =>
    wrap(async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        if (!err?.status) throw err;
        res.status(err.status).json({ error: clientError(err) });
      }
    });

  api.get('/themes', answering(async (req, res) => res.json(await listThemes(req.user))));

  api.put(
    '/themes/selected',
    answering(async (req, res) => res.json(await selectTheme(req.user, String(req.body?.id ?? '')))),
  );

  api.get(
    '/ranking',
    answering(async (req, res) => {
      const { scope, key } = req.query;
      res.json(await ranking(req.user, { scope: typeof scope === 'string' ? scope : undefined, key: typeof key === 'string' ? key : undefined }));
    }),
  );

  api.get('/titles', answering(async (req, res) => res.json(await listTitles(req.user))));

  api.put(
    '/titles/equipped',
    answering(async (req, res) => {
      const id = req.body?.id;
      if (id !== null && typeof id !== 'string') return res.status(400).json({ error: 'Say which title, or null for none.' });
      res.json(await equipTitle(req.user, id));
    }),
  );

  admin.get('/themes', requirePermission('themes'), answering(async (req, res) => res.json(await adminThemes())));

  // Everyone a theme can be given to, by name, for the search box.
  admin.get('/themes/people', requirePermission('themes'), answering(async (req, res) => res.json(await themePeople())));

  admin.get('/themes/:id/holders', requirePermission('themes'), answering(async (req, res) => res.json(await themePeople(req.params.id))));

  admin.put(
    '/themes/:id',
    requirePermission('themes'),
    answering(async (req, res) => {
      try {
        const saved = await setThemeBadge(req.params.id, req.body, req.user.id);
        await audit(req, req.user.id, 'admin_theme_badge', { theme: req.params.id, ...saved.badge });
        res.json(saved);
      } catch (err) {
        // A bad badge is the sender's: `cleanBadge` says what was wrong in a sentence.
        if (err?.status) throw err;
        res.status(400).json({ error: clientError(err) });
      }
    }),
  );

  admin.post(
    '/themes/:id/holders',
    requirePermission('themes'),
    answering(async (req, res) => {
      await giveTheme(req.params.id, req.body?.userId);
      await audit(req, req.user.id, 'admin_theme_given', { theme: req.params.id, to: String(req.body?.userId || '').slice(0, 80) });
      res.json({ ok: true });
    }),
  );

  admin.delete(
    '/themes/:id/holders/:userId',
    requirePermission('themes'),
    answering(async (req, res) => {
      await takeTheme(req.params.id, req.params.userId);
      await audit(req, req.user.id, 'admin_theme_taken', { theme: req.params.id, from: String(req.params.userId).slice(0, 80) });
      res.json({ ok: true });
    }),
  );
}
