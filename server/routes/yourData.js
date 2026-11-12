import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { removeFromMachine } from '../sandbox.js';
import { chatSharePath } from './chatShare.js';
import { sharePath } from './share.js';

/**
 * Settings → Privacy → Your data (owner, 2026-11-01, after Claude's): what this
 * account holds, kind by kind — its conversations, the files the assistant made,
 * the files it sent, the feedback it gave — with what anybody else can reach
 * listed on its own, above the rest.
 *
 * Only the lists and the two deletions nothing else offered are here. Sharing a
 * conversation or a made file, taking the link back and deleting either are the
 * routes that already do it (chatShare.js, share.js, chats, files.js), so a
 * link made from this page is the same link, audited the same way.
 *
 * And the indexed documents (owner, 2026-11-12, Decree 13): the folders `index_folder`
 * read, with their passages and embeddings, which until then only the assistant could
 * list or forget. Listed by folder and deleted by the person — every passage of that
 * folder, at once. Nothing indexed is reachable by anyone else, so it has no shared half.
 */
const KINDS = new Set(['chats', 'artifacts', 'uploads', 'feedback', 'docs']);

/**
 * An indexed folder's id on this page: its name, hashed. A folder's name can be a path
 * with slashes in it, which does not sit in a URL; and the id is looked up among this
 * account's own folders, so it names nothing anywhere else.
 */
export const docsId = (source) => crypto.createHash('sha256').update(String(source)).digest('hex').slice(0, 32);

/** One row as the page draws it — never a token, only the path the owner may copy. */
function shapeOf(kind, row, shared) {
  if (kind === 'docs') {
    return {
      id: docsId(row.source),
      name: row.source,
      files: Number(row.files) || 0,
      chunks: Number(row.chunks) || 0,
      model: row.model || null,
      updatedAt: row.indexed_at,
    };
  }
  if (kind === 'chats') {
    return {
      id: row.id,
      name: row.title,
      shared: !!row.share_token,
      link: row.share_token ? chatSharePath(row.share_token) : null,
      sharedAt: row.shared_at,
      updatedAt: row.updated_at,
    };
  }
  if (kind === 'feedback') {
    return {
      id: row.id,
      topic: row.topic,
      topicOther: row.topic_other,
      kind: row.kind,
      issue: row.issue || null,
      body: row.body,
      chatTitle: row.chat_title,
      shared,
      updatedAt: row.created_at,
    };
  }
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    bytes: Number(row.bytes) || 0,
    shared: kind === 'artifacts' ? !!row.share_token : shared,
    link: kind === 'artifacts' && row.share_token ? sharePath(row.share_token) : null,
    chatId: row.chat_id,
    chatTitle: row.chat_title,
    updatedAt: row.updated_at,
  };
}

/**
 * The indexed folders, a page of them: searched by name, newest indexed first. A few
 * folders per account at most, so read whole and cut here. None is ever shared.
 *
 * @param {string} userId
 * @param {{ query: string, shared: boolean, offset: number, limit: number }} options
 */
async function indexedFolders(userId, { query, shared, offset, limit }) {
  if (shared) return { total: 0, items: [] };
  const needle = String(query || '').trim().toLowerCase();
  const rows = (await getStore().docSources(userId)).filter((row) => !needle || String(row.source).toLowerCase().includes(needle));
  const from = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  return { total: rows.length, items: rows.slice(from, from + size) };
}

/**
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function }} ctx
 */
export function mountYourDataRoutes(api, { wrap }) {
  /** What is shared now, kind by kind — the count beside each Manage. */
  api.get(
    '/data',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ shared: await getStore().dataSummary(req.user.id) });
    }),
  );

  api.get(
    '/data/:kind',
    wrap(async (req, res) => {
      const kind = String(req.params.kind);
      if (!KINDS.has(kind)) return res.status(404).json({ error: 'Not found' });
      const store = getStore();
      const options = {
        query: String(req.query.q ?? ''),
        shared: req.query.shared === '1',
        offset: Number(req.query.offset) || 0,
        limit: Number(req.query.limit) || 20,
      };
      const page =
        kind === 'docs'
          ? await indexedFolders(req.user.id, options)
          : kind === 'chats'
            ? await store.listDataChats(req.user.id, options)
            : kind === 'feedback'
              ? await store.listDataFeedback(req.user.id, options)
              : await store.listDataFiles(req.user.id, { ...options, origin: kind === 'uploads' ? 'upload' : 'generated' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ total: page.total, items: page.items.map((row) => shapeOf(kind, row, options.shared)) });
    }),
  );

  /**
   * One indexed folder forgotten, by the person (Decree 13): every passage and embedding
   * of it, from this account only. The files on their computer are not touched.
   */
  api.delete(
    '/data/docs/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const folder = (await store.docSources(req.user.id)).find((row) => docsId(row.source) === String(req.params.id));
      if (!folder) return res.status(404).json({ error: 'Not found' });
      const removed = await store.deleteDocs(req.user.id, String(folder.source));
      res.json({ ok: true, removed });
    }),
  );

  /** A file this account sent, gone — from the page and from the conversation it was sent in. */
  api.delete(
    '/data/uploads/:id',
    wrap(async (req, res) => {
      const removed = await getStore().takeUpload(req.user.id, String(req.params.id));
      if (!removed) return res.status(404).json({ error: 'Not found' });
      // Its bytes are on the machine, not here. If the machine cannot be reached the tidy takes them within the month.
      if (removed.origin === 'machine') await removeFromMachine(req.user.id, removed.source).catch(() => {});
      res.json({ ok: true });
    }),
  );

  /** Feedback this account sent, deleted by the one who sent it. */
  api.delete(
    '/data/feedback/:id',
    wrap(async (req, res) => {
      const removed = await getStore().deleteOwnFeedback(req.user.id, String(req.params.id));
      if (!removed) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    }),
  );

  /** The conversation sent with a piece of feedback, taken back; the words stay. */
  api.delete(
    '/data/feedback/:id/transcript',
    wrap(async (req, res) => {
      const removed = await getStore().forgetOwnFeedbackTranscript(req.user.id, String(req.params.id));
      if (!removed) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    }),
  );
}
