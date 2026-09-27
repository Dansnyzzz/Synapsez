import { getStore } from '../store/index.js';
import { saveToDrive } from '../tools/google.js';
import { googleGrants } from '../google.js';
import { languageOf, translateMessage } from '../i18n/index.js';
import { saveUpload } from '../attachments.js';
import { createDocument, extensionOf, RUNNABLE } from '../office/index.js';
import {
  withStorageShim,
  listArtifactStorage,
  getArtifactValue,
  setArtifactValue,
  deleteArtifactValue,
} from '../artifactStorage.js';

/**
 * Lifted out of server/app.js — see the note on mountWorkspaceRoutes for why.
 *
 * The routes are unchanged: same handlers, same paths, same order. Only their
 * address in the tree moved.
 *
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function, body: Function }} ctx
 */
export function mountFileRoutes(api, { wrap, body }) {
  // ── photos and files ────────────────────────────────────────────────
  api.post(
    '/attachments',
    wrap(async (req, res) => {
      try {
        const saved = await saveUpload(req.user.id, {
          name: req.body?.name,
          mime: req.body?.mime,
          data: req.body?.data,
        });
        // The bytes are never echoed back — the browser already has the file it
        // just picked, and a round trip of the same megabytes helps nobody.
        res.status(201).json({ attachment: saved });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * The bytes: a thumbnail, a PDF in the viewer's frame, or a download.
   *
   * Three things are decided here rather than by the file itself.
   *
   * **What it is served as.** An uploaded .html or .svg served back with its own
   * content type is a script running on this origin, with this session's cookie
   * — a stored cross-site scripting hole with the app's own hands on it. Only
   * the types that are safe to render are echoed; everything else is served as
   * `application/octet-stream` and forced to download, which is what a person
   * wanted from a .docx anyway.
   *
   * **Whether it may be framed.** The app-wide headers forbid framing entirely,
   * which is right for pages and wrong for the PDF viewer — so this response
   * relaxes `frame-ancestors` to same-origin, and nothing else.
   *
   * **`?download=1`** switches the disposition to an attachment and turns off
   * the inline rendering, which is the Save button in the viewer.
   */
  const INLINE_SAFE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i;

  /**
   * A filename for the `Content-Disposition` header.
   *
   * The plain `filename=` parameter is bytes, not Unicode, so "Báo cáo.docx"
   * either mangles or breaks the header depending on the client. The ASCII
   * fallback goes there and the real name goes in `filename*`, which every
   * browser released this decade prefers.
   */
  const asciiFilename = (name) =>
    String(name)
      .replace(/[\\"]/g, '')
      .replace(/[^ -~]/g, '_') || 'file';

  /**
   * Put a file in the person's own Google Drive.
   *
   * Only when Drive was granted; the account's own token, never a shared one.
   * Answers with the link so the viewer can open the copy straight away.
   */
  api.post(
    '/attachments/:id/drive',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      if (!(await googleGrants(req.user.id)).includes('drive')) {
        return res.status(400).json({
          error: translateMessage('Google Drive is not connected. Connect it in Settings → Connectors.', languageOf(req)),
        });
      }
      try {
        const saved = await saveToDrive(req.user.id, file);
        res.json({ id: saved.id, name: saved.name, link: saved.webViewLink });
      } catch (err) {
        res.status(400).json({ error: translateMessage(String(err.message), languageOf(req)) });
      }
    }),
  );

  api.get(
    '/attachments/:id',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const wantsDownload = req.query.download === '1' || req.query.download === 'true';
      const inline = !wantsDownload && INLINE_SAFE.test(file.mime);

      res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
      /**
       * An upload never changes, so a browser that has it never needs to ask
       * again. A document the assistant wrote does change — `update_file`
       * rewrites it in place, keeping its id — and `immutable` on that is how
       * somebody downloads yesterday's quotation from today's link and never
       * finds out.
       */
      res.setHeader(
        'Cache-Control',
        file.origin === 'generated'
          ? 'private, no-cache, must-revalidate'
          : 'private, max-age=31536000, immutable',
      );
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      // Replaces the page policy for this response: a binary asset has no
      // scripts, styles or images of its own, and the viewer needs to frame it.
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.send(Buffer.from(file.data, 'base64'));
    }),
  );

  /**
   * An artifact, running.
   *
   * This is the one route in the application that deliberately serves something
   * executable, so it is worth being precise about what stops it reaching
   * anything: the response carries `Content-Security-Policy: sandbox
   * allow-scripts` and **not** `allow-same-origin`. That single omission is the
   * whole security model. The page runs in an opaque origin — it has no access
   * to this app's cookies, storage, or API, and a `fetch` from it arrives
   * unauthenticated as a cross-origin request from `null`. It can compute and
   * draw; it cannot reach the account that made it.
   *
   * Everything else is belt and braces: no network at all (`connect-src 'none'`),
   * no framing by anyone but this app, and the viewer sandboxes the iframe a
   * second time from its side.
   *
   * Only files the assistant generated are runnable. An uploaded page is
   * somebody else's HTML and is never executed — see the download route.
   */
  /**
   * Storage for a running artifact.
   *
   * Reached by the *page* through `postMessage` to its parent, never directly —
   * the frame has an opaque origin and `connect-src 'none'`, so it could not call
   * this if it tried. The browser makes the call on its behalf, which is what puts
   * the session cookie on it.
   *
   * The artifact id comes from the URL, and the interface supplies it from the
   * frame it created rather than from anything the page said. A page naming its own
   * storage bucket would be a page that can read another artifact's data.
   */
  api.get(
    '/attachments/:id/storage',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const all = await listArtifactStorage(req.user.id, req.params.id);
      if (req.query.key == null) {
        // The whole bucket, decoded, for `storage.list()`.
        const out = {};
        for (const [key, encoded] of Object.entries(all)) {
          try {
            out[key] = JSON.parse(encoded);
          } catch {
            out[key] = null;
          }
        }
        return res.json({ values: out });
      }
      const raw = await getArtifactValue(req.user.id, req.params.id, String(req.query.key));
      try {
        return res.json({ value: raw == null ? null : JSON.parse(raw) });
      } catch {
        return res.json({ value: null });
      }
    }),
  );

  api.put(
    '/attachments/:id/storage',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      try {
        const count = await setArtifactValue(req.user.id, req.params.id, req.body?.key, req.body?.value);
        return res.json({ ok: true, keys: count });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/attachments/:id/storage',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      // No key means clear the artifact's whole bucket.
      const count = await deleteArtifactValue(req.user.id, req.params.id, req.query.key ?? null);
      res.json({ ok: true, keys: count });
    }),
  );

  api.get(
    '/attachments/:id/run',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      if (file.origin !== 'generated' || !RUNNABLE.has(extensionOf(file.name))) {
        return res.status(400).json({
          error: 'Only a page the assistant wrote can be run. Uploaded files are shown as source.',
        });
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'none'",
          // Inline is the point: an artifact is one self-contained file.
          "script-src 'unsafe-inline' 'unsafe-eval' blob:",
          "style-src 'unsafe-inline'",
          "img-src data: blob:",
          "font-src data:",
          // It computes and draws. It does not call anything.
          "connect-src 'none'",
          "form-action 'none'",
          "frame-ancestors 'self'",
          // No `allow-same-origin`: an opaque origin with no way back here.
          'sandbox allow-scripts allow-modals allow-popups-to-escape-sandbox',
        ].join('; '),
      );
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.send(withStorageShim(Buffer.from(file.data, 'base64').toString('utf8')));
    }),
  );

  /**
   * Rewrite an artifact by hand.
   *
   * The same road `update_file` takes, opened to the person rather than only to
   * the assistant — because "change that one number" should not require asking
   * for it in prose and waiting for a turn.
   */
  api.patch(
    '/attachments/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const file = await store.getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      if (file.origin !== 'generated') {
        return res.status(400).json({ error: 'That file was uploaded, so there is no source to rewrite.' });
      }

      try {
        const built = createDocument({
          format: extensionOf(file.name),
          name: String(req.body?.name || file.name),
          content: String(req.body?.content ?? ''),
        });
        const saved = await store.replaceAttachment(req.user.id, req.params.id, {
          data: built.buffer.toString('base64'),
          bytes: built.buffer.length,
          source: built.source,
          name: built.name,
          mime: built.mime,
        });
        res.json({ file: saved });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/attachments/:id',
    wrap(async (req, res) => {
      const removed = await getStore().deleteGeneratedFile(req.user.id, req.params.id);
      if (!removed) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    }),
  );

  // ── the workspace, from the interface ────────────────────────────────

}
