import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { extensionOf, RUNNABLE } from '../office/index.js';

/**
 * A link to something the assistant made, that opens without signing in.
 *
 * "Publish this page and give me a link" is the whole feature: a quiz to send a
 * class, a dashboard to show a colleague, a report to forward. The link is a
 * secret — 32 random bytes, shown only to the owner — and taking it back clears
 * it, after which the old address answers 404 like any address that never was.
 *
 * **What a visitor can reach.** Exactly the one file, never anything beside it.
 * A page is served under `Content-Security-Policy: sandbox allow-scripts` and
 * **not** `allow-same-origin`, the same bargain as the in-app runner: it runs in
 * an opaque origin, so it cannot read this app's cookies or call its API, and it
 * has no network. Its `window.storage` is kept in the visitor's own memory for
 * the visit — a shared page must not be able to read, or write, the owner's
 * saved values.
 *
 * Only files the assistant generated can be shared. An upload is somebody's own
 * document, and publishing it is not something a tool call should be able to do.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// The same raster formats as the signed-in file route (files.js): none can carry a script.
const INLINE_SAFE = /^(image\/(png|jpe?g|webp|gif|avif|bmp|x-icon|vnd\.microsoft\.icon)|application\/pdf)$/i;
const TEXTUAL = /^text\/|^application\/(json|xml|javascript)$/i;

export const newShareToken = () => crypto.randomBytes(32).toString('base64url');

/** Where a token is served — relative, so it is right on any host. */
export const sharePath = (token) => `/api/share/${token}`;

/**
 * `window.storage` for a shared page: the same promise-based interface the
 * in-app shim offers, backed by memory for this visit only. The page cannot
 * tell the difference except that nothing outlives the tab — which is the
 * point.
 */
const VISITOR_SHIM = `<script>
(function () {
  var mem = {};
  function done(v) { return Promise.resolve(v); }
  window.storage = {
    get: function (k) { return done(Object.prototype.hasOwnProperty.call(mem, String(k)) ? mem[String(k)] : null); },
    set: function (k, v) { mem[String(k)] = v; return done(true); },
    delete: function (k) { delete mem[String(k)]; return done(true); },
    list: function () { return done(Object.assign({}, mem)); },
    clear: function () { mem = {}; return done(true); }
  };
  try { localStorage.getItem('x'); } catch (err) {
    var local = {};
    var shim = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(local, String(k)) ? local[String(k)] : null; },
      setItem: function (k, v) { local[String(k)] = String(v); },
      removeItem: function (k) { delete local[String(k)]; },
      clear: function () { local = {}; },
      key: function (i) { return Object.keys(local)[i] || null; }
    };
    Object.defineProperty(shim, 'length', { get: function () { return Object.keys(local).length; } });
    try { Object.defineProperty(window, 'localStorage', { value: shim, configurable: true }); } catch (ignored) {}
  }
})();
</script>`;

export function withVisitorShim(html) {
  const text = String(html ?? '');
  const head = text.match(/<head[^>]*>/i);
  return head ? text.replace(head[0], `${head[0]}${VISITOR_SHIM}`) : `${VISITOR_SHIM}${text}`;
}

const asciiFilename = (name) =>
  String(name)
    .replace(/[\\"]/g, '')
    .replace(/[^ -~]/g, '_') || 'file';

/**
 * The owner's side: make a link, read it back, take it away.
 *
 * @param {import('express').Router} api  the authenticated router
 */
export function mountShareRoutes(api, { wrap }) {
  api.get(
    '/attachments/:id/share',
    wrap(async (req, res) => {
      const store = getStore();
      const file = await store.getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const token = await store.getAttachmentShare(req.user.id, req.params.id);
      res.json({ shared: !!token, path: token ? sharePath(token) : null });
    }),
  );

  api.post(
    '/attachments/:id/share',
    wrap(async (req, res) => {
      const result = await shareFile(req.user.id, req.params.id);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ shared: true, path: result.path });
    }),
  );

  api.delete(
    '/attachments/:id/share',
    wrap(async (req, res) => {
      const token = await getStore().setAttachmentShare(req.user.id, req.params.id, null);
      if (token === undefined) return res.status(404).json({ error: 'Not found' });
      res.json({ shared: false });
    }),
  );
}

/**
 * Share a file, reusing its link when it already has one — asking twice must
 * not break the first link somebody already sent round.
 */
export async function shareFile(userId, id) {
  const store = getStore();
  const file = await store.getAttachment(userId, id);
  if (!file) return { status: 404, error: 'Not found' };
  if (file.origin !== 'generated') {
    return { status: 400, error: 'Only something the assistant made can be shared by link. Uploaded files stay private.' };
  }
  const existing = await store.getAttachmentShare(userId, id);
  if (existing) return { path: sharePath(existing), file };
  const token = await store.setAttachmentShare(userId, id, newShareToken());
  return { path: sharePath(token), file };
}

/**
 * The visitor's side: one route, no session, the token as the only key.
 *
 * @param {import('express').Express} app
 */
export function mountPublicShare(app, { wrap }) {
  app.get(
    '/api/share/:token',
    wrap(async (req, res) => {
      const token = String(req.params.token || '');
      const file = TOKEN.test(token) ? await getStore().getSharedAttachment(token) : null;
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!file) {
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        return res.status(404).type('text/plain').send('This link does not exist, or was taken back.');
      }

      const bytes = Buffer.from(file.data, 'base64');
      const wantsDownload = req.query.download === '1';

      if (!wantsDownload && RUNNABLE.has(extensionOf(file.name))) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader(
          'Content-Security-Policy',
          [
            "default-src 'none'",
            "script-src 'unsafe-inline' 'unsafe-eval' blob:",
            "style-src 'unsafe-inline'",
            'img-src data: blob:',
            'font-src data:',
            "connect-src 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
            'sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads',
          ].join('; '),
        );
        return res.send(withVisitorShim(bytes.toString('utf8')));
      }

      const inline = !wantsDownload && (INLINE_SAFE.test(file.mime) || TEXTUAL.test(file.mime));
      res.setHeader(
        'Content-Type',
        inline ? (TEXTUAL.test(file.mime) ? 'text/plain; charset=utf-8' : file.mime) : 'application/octet-stream',
      );
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      // No `sandbox` here: Chrome refuses to open a PDF in a sandboxed document,
      // and a picture or a PDF runs nothing of its own for it to contain.
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.send(bytes);
    }),
  );
}
