import { getStore } from '../store/index.js';
import { executeTool } from '../tools/execute.js';
import { previewOf, mediaOf, liveRevision } from '../attachments.js';

/**
 * The workspace routes, lifted out of server/app.js.
 *
 * app.js had grown to 2,838 lines holding every route in the application, which
 * makes it the file every change touches and every merge conflicts in. This is
 * the first group to come out, and it was chosen because it is the most
 * self-contained: it reaches for only two things from the app's own scope,
 * `wrap` and `body`, and everything else it needs it defines itself.
 *
 * Nothing about the routes changed in the move. They are the same handlers on
 * the same paths in the same order, and the suites that cover them —
 * workspace.test.mjs and attachments.test.mjs — were not touched either, which
 * is what makes them worth anything here.
 *
 * @param {import('express').Router} api  the authenticated router — everything
 *   here is already behind requireAuth
 * @param {{ wrap: Function, body: Function }} ctx  the two helpers app.js
 *   builds per request: `wrap` forwards a rejected promise to the error
 *   handler, `body` is `req.body` with Express 5's undefined guarded
 */
export function mountWorkspaceRoutes(api, { wrap, body }) {
  /* ── the workspace, from the interface ──────────────────────────────
   *
   * The assistant has been able to read, write and edit files on the user's
   * machine since the beginning; the person sitting in front of it could only
   * ask. These routes close that gap, and they close it through exactly the
   * same door: every one runs a worker tool, so the workspace confinement, the
   * symlink resolution and the per-account queue scoping are inherited rather
   * than reimplemented. There is no second path to somebody's disk.
   *
   * What is deliberately *not* inherited is the approval policy. That exists to
   * gate what the assistant does on its own initiative; a person pressing Save
   * in their own file browser has already decided.
   */
  const workspaceTool = async (req, name, input) => {
    /*
     * `raw` for the same reason the approval policy is not inherited above: the
     * reader here is a person looking at their own file browser, not the model.
     * `executeTool` puts an untrusted envelope round anything carrying bytes the
     * app did not write, which is right when the model is reading it and wrong
     * here — `workspaceJson` below parses this string, and an envelope makes it
     * unparseable.
     */
    const { content, isError } = await executeTool({ user: req.user, name, input, raw: true });
    if (isError) throw Object.assign(new Error(content), { status: 400 });
    return content;
  };

  /** A worker tool that answers in JSON, parsed. */
  const workspaceJson = async (req, name, input) => {
    const raw = await workspaceTool(req, name, input);
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(raw || 'The worker returned something unreadable.'), { status: 502 });
    }
  };

  const workspaceRoute = (handler) =>
    wrap(async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    });

  api.get(
    '/workspace',
    workspaceRoute(async (req, res) => {
      res.json(await workspaceJson(req, 'fs_browse', { path: String(req.query.path || '.') }));
    }),
  );

  api.get(
    '/workspace/file',
    workspaceRoute(async (req, res) => {
      res.json(await workspaceJson(req, 'fs_read_text', { path: String(req.query.path || '') }));
    }),
  );

  /** Save, or create — `write_file` makes the parent folders either way. */
  api.put(
    '/workspace/file',
    workspaceRoute(async (req, res) => {
      const path = String(req.body?.path || '').trim();
      if (!path) throw Object.assign(new Error('Which file?'), { status: 400 });
      const message = await workspaceTool(req, 'write_file', { path, content: String(req.body?.content ?? '') });
      res.json({ ok: true, message });
    }),
  );

  /** Rename, or move — the same operation, and the same tool. */
  api.post(
    '/workspace/move',
    workspaceRoute(async (req, res) => {
      const from = String(req.body?.from || '').trim();
      const to = String(req.body?.to || '').trim();
      if (!from || !to) throw Object.assign(new Error('Move what, and where to?'), { status: 400 });
      const message = await workspaceTool(req, 'move_file', { from, to, overwrite: !!req.body?.overwrite });
      res.json({ ok: true, message });
    }),
  );

  /** Search across the files, grouped by the file each hit is in. */
  api.get(
    '/workspace/search',
    workspaceRoute(async (req, res) => {
      const query = String(req.query.q || '').trim();
      if (!query) throw Object.assign(new Error('Search for what?'), { status: 400 });
      res.json(
        await workspaceJson(req, 'fs_search', {
          query,
          path: String(req.query.path || '.'),
          glob: req.query.glob ? String(req.query.glob) : undefined,
        }),
      );
    }),
  );

  api.delete(
    '/workspace/file',
    workspaceRoute(async (req, res) => {
      const path = String(req.query.path || '').trim();
      if (!path) throw Object.assign(new Error('Which file?'), { status: 400 });
      const message = await workspaceTool(req, 'delete_file', {
        path,
        recursive: req.query.recursive === '1',
      });
      res.json({ ok: true, message });
    }),
  );

  /** Everything the assistant has made on this account, newest first. */
  api.get(
    '/files',
    wrap(async (req, res) => {
      res.json({ files: await getStore().listAllGeneratedFiles(req.user.id, 200) });
    }),
  );

  /**
   * A file as something the browser can draw.
   *
   * Word, Excel and PowerPoint are read on the server and handed over as
   * structure — headings and runs, sheets of cells, slides of bullets — rather
   * than as a file the browser has no way to open. It is the same reading the
   * model is given, which is the point: what you can see and what it knows are
   * one thing, so "it says something different from what I am looking at" cannot
   * happen quietly.
   */
  api.get(
    '/attachments/:id/preview',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const meta = {
        id: file.id,
        name: file.name,
        mime: file.mime,
        kind: file.kind,
        bytes: file.bytes,
        origin: file.origin || 'upload',
        createdAt: file.created_at,
        // Only for something the assistant wrote: the Markdown it was built
        // from, so the viewer can show and edit the source rather than a
        // rendering of it.
        source: file.origin === 'generated' ? file.source || null : null,
      };

      try {
        res.json({ file: meta, preview: await previewOf(file) });
      } catch (err) {
        // A corrupt or password-protected document is an answer, not a 500 —
        // the viewer says what happened and still offers the download.
        res.json({ file: meta, preview: { kind: 'unreadable', message: err.message } });
      }
    }),
  );

  /**
   * Open a conversation's file on the machine, or show it in a folder.
   *
   * A document the assistant made lives here, not on anybody's disk, so the
   * worker is asked to write it out first and then hand it to the desktop —
   * which is what "Open in Word" has to mean when the file was never local.
   *
   * The approval policy is deliberately not consulted: that gates what the
   * assistant does on its own initiative, and this is a person pressing a
   * button about a file already open in front of them. What *is* enforced,
   * on the worker, is that a program is never handed to the shell.
   */
  api.post(
    '/attachments/:id/open',
    workspaceRoute(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const how = req.body?.how === 'folder' ? 'folder' : 'open';
      res.json(
        // `data` is already base64 in the store, which is what the worker wants.
        await workspaceJson(req, 'fs_reveal', { name: file.name, data: file.data, how }),
      );
    }),
  );

  /**
   * One picture out of a document.
   *
   * The preview's `<img src>` points here. Same ownership check as everything
   * else — an id from somebody else's account finds nothing — and the same
   * locked-down policy as the other binary route: a figure out of a stranger's
   * .docx is served as bytes with no scripts, styles or frames of its own.
   */
  api.get(
    '/attachments/:id/media/:index',
    wrap(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const picture = mediaOf(file, req.params.index);
      if (!picture) return res.status(404).json({ error: 'No such picture in this document.' });

      res.setHeader('Content-Type', picture.contentType);
      // The document itself may be rewritten, but picture *n* of the copy that
      // produced this preview never changes — and the preview is re-fetched
      // whenever it does.
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(picture.data);
    }),
  );

  /**
   * The earlier drafts of a file the assistant wrote.
   *
   * Listed newest-first with the current one at the top, so the switcher can be
   * drawn from a single response. `?revision=` shows one of them; POST restores
   * it, which is itself a rewrite and so files the current copy as yet another
   * version — going back is never destructive.
   */
  api.get(
    '/attachments/:id/versions',
    wrap(async (req, res) => {
      const store = getStore();
      const file = await store.getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });

      const past = await store.listAttachmentVersions(req.user.id, file.id);
      const live = liveRevision(past);
      res.json({
        current: live,
        versions: [
          { revision: live, name: file.name, bytes: file.bytes, createdAt: file.created_at, live: true },
          ...past.map((v) => ({
            revision: v.revision,
            name: v.name,
            bytes: v.bytes,
            createdAt: v.created_at,
            live: false,
          })),
        ],
      });
    }),
  );

  api.get(
    '/attachments/:id/versions/:revision',
    wrap(async (req, res) => {
      const past = await getStore().getAttachmentVersion(req.user.id, req.params.id, req.params.revision);
      if (!past) return res.status(404).json({ error: 'There is no such version of this file.' });

      const meta = {
        id: past.attachment_id,
        name: past.name,
        mime: past.mime,
        kind: past.kind,
        bytes: past.bytes,
        origin: 'generated',
        createdAt: past.created_at,
        source: past.source || null,
        revision: past.revision,
      };
      try {
        // A distinct id for the parse cache. Sharing the live file's id would
        // leave an old draft's text cached against it, and the next question
        // about the document would be answered from the version somebody
        // happened to look at.
        res.json({ file: meta, preview: await previewOf({ ...past, id: `${past.attachment_id}#v${past.revision}` }) });
      } catch (err) {
        res.json({ file: meta, preview: { kind: 'unreadable', message: err.message } });
      }
    }),
  );

  /** Put an earlier draft back, as a new one. Nothing is lost either way. */
  api.post(
    '/attachments/:id/versions/:revision/restore',
    wrap(async (req, res) => {
      const store = getStore();
      const past = await store.getAttachmentVersion(req.user.id, req.params.id, req.params.revision);
      if (!past) return res.status(404).json({ error: 'There is no such version of this file.' });

      const file = await store.replaceAttachment(req.user.id, req.params.id, {
        data: past.data,
        bytes: past.bytes,
        source: past.source,
        name: past.name,
        mime: past.mime,
      });
      if (!file) return res.status(404).json({ error: 'Not found' });
      res.json({ file });
    }),
  );

  /** Which application would open it — so the button can say so beforehand. */
  api.get(
    '/attachments/:id/opener',
    workspaceRoute(async (req, res) => {
      const file = await getStore().getAttachment(req.user.id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      res.json(await workspaceJson(req, 'fs_describe', { name: file.name }));
    }),
  );

}
