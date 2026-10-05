import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { currentUser, parseCookies } from '../auth.js';
import { faviconFor, cleanHost } from '../favicon.js';
import { proxiedImage, mapTile } from '../imageProxy.js';
import { audit } from '../audit.js';

/**
 * A conversation shared by link.
 *
 * The owner gets a link; anyone who opens it reads the conversation as it was
 * at that moment — no account needed, nothing to type into. To carry it on
 * they sign in, and the conversation is **copied** into their own account,
 * files and all, and continued there. The owner's conversation is never
 * written to by anybody else: a copy is the only way a stranger's next message
 * cannot become part of somebody's record.
 *
 * **A snapshot, not a window.** The link shows what had been said when it was
 * shared (`shared_at`), not what is said in the conversation afterwards — so
 * sharing a finished answer does not quietly publish tomorrow's follow-up.
 * Sharing again moves the snapshot on; taking the link back closes it.
 *
 * **Files.** The page shows pictures and file cards from the conversation, and
 * those are served by routes that need a session. Opening the link sets a
 * cookie holding the token (HttpOnly, path /api, a day), and a gate in front of
 * those routes lets a visitor fetch exactly the files the shared conversation
 * refers to — owned by its owner, named in its messages — and nothing else.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHARE_COOKIE = 'synz_share';

export const newChatShareToken = () => crypto.randomBytes(32).toString('base64url');
export const chatSharePath = (token) => `/share.html?t=${token}`;

/**
 * The tools whose calls and results may be published with a conversation: what
 * they read is the open web, or what they made is the conversation's own work.
 *
 * Everything else read the *account*: saved notes (`memory_*`), other
 * conversations (`search_chats`), project sources (`search_docs`), an inbox, a
 * Drive, a connected service, the person's computer, a signed-in cloud browser.
 * Somebody sharing an answer is sharing the answer, not every private thing the
 * assistant looked at on the way to it — so those steps are published by name
 * only, with their arguments and results left out (PRV-001). A list of what may
 * go, rather than of what may not, so a tool added tomorrow starts private.
 */
export const PUBLISHABLE_TOOLS = new Set([
  'web_search', 'web_fetch', 'extract', 'deep_research', 'image_search', 'encyclopedia', 'read_feed',
  'youtube_transcript', 'world_facts', 'market_data', 'sports', 'place_lookup', 'calculate', 'convert_units',
  'date_calc', 'text_tools', 'analyze_data', 'make_qr', 'chart', 'show_card', 'show_widget', 'create_file',
  'update_file', 'read_generated_file', 'generate_image', 'update_plan', 'ask_options', 'load_tools',
  // Not `look_at`: it reads a browser or desktop step's screenshot as readily as
  // a picture from the web. Not `edit_image`: it works on the person's own disk.
]);

/** What a model reading a carried-on copy is told about a step that was left out. */
const LEFT_OUT = 'Not part of the shared copy: this step read the original account\'s own data.';

/**
 * One message as it may leave the owner's account, or null when it may not.
 *
 * What was said, what the publishable tools did and drew — and none of the
 * machinery. Provider payloads (signatures, raw blocks) stay behind; a summary
 * the model reads in place of older turns is not a message anybody wrote; and
 * reasoning stays behind too, because it is where the model restates whatever it
 * read — a note, an email — on its way to the answer.
 *
 * @param {any} m
 * @param {{ placeholder?: string }} [options]  `placeholder` replaces a
 *   withheld result's text (a copy the model will read); without it the text is
 *   empty and `hidden` says why (a page the visitor's browser words itself).
 */
function publicMessage(m, { placeholder = '' } = {}) {
  if (m.role === 'user') {
    return {
      id: m.id,
      role: 'user',
      text: m.text || '',
      attachments: (m.attachments || []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, bytes: a.bytes })),
    };
  }
  if (m.role === 'assistant') {
    return {
      id: m.id,
      role: 'assistant',
      text: m.text || '',
      toolCalls: (m.toolCalls || []).map((c) => ({
        id: c.id,
        name: c.name,
        input: PUBLISHABLE_TOOLS.has(c.name) ? c.input : {},
      })),
    };
  }
  if (m.role === 'tool') {
    return {
      id: m.id,
      role: 'tool',
      results: (m.results || []).map((r) =>
        PUBLISHABLE_TOOLS.has(r.name)
          ? {
              toolCallId: r.toolCallId,
              name: r.name,
              content: r.content,
              isError: !!r.isError,
              ms: r.ms,
              ...(r.file ? { file: r.file } : {}),
              ...(r.widget ? { widget: r.widget } : {}),
              ...(r.shot ? { shot: r.shot } : {}),
              ...(r.answered ? { answered: r.answered } : {}),
            }
          : { toolCallId: r.toolCallId, name: r.name, content: placeholder, isError: !!r.isError, ms: r.ms, hidden: true },
      ),
    };
  }
  return null;
}

/** The transcript as a visitor sees it — see `publicMessage`. */
export function publicTranscript(messages, options = {}) {
  return messages.map((m) => publicMessage(m, options)).filter(Boolean);
}

/** Every file a transcript refers to: what was sent, what was made, what a step saw. */
export function referencedFiles(messages) {
  const ids = new Set();
  for (const m of messages) {
    for (const a of m.attachments || []) if (a?.id) ids.add(a.id);
    for (const r of m.results || []) {
      if (r?.file?.id) ids.add(r.file.id);
      if (r?.shot?.id) ids.add(r.shot.id);
    }
  }
  return ids;
}

/** The shared chat and the files it may serve, remembered a minute per token. */
const gateCache = new Map();
async function sharedScope(token) {
  const hit = gateCache.get(token);
  if (hit && hit.until > Date.now()) return hit.scope;
  const store = getStore();
  const chat = TOKEN.test(token || '') ? await store.getSharedChat(token) : null;
  // The files of the published transcript, not of the stored one: a picture a
  // withheld step produced (a screenshot of a signed-in page) is not the visitor's to fetch.
  const scope = chat
    ? { chat, files: referencedFiles(publicTranscript(await store.listSharedMessages(chat.id, chat.shared_at))) }
    : null;
  if (gateCache.size > 500) gateCache.delete(gateCache.keys().next().value);
  gateCache.set(token, { scope, until: Date.now() + 60_000 });
  return scope;
}

const INLINE_SAFE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i;
const asciiFilename = (name) => String(name).replace(/[\\"]/g, '').replace(/[^ -~]/g, '_') || 'file';

/**
 * Routes that need no session: the shared page's data, and the gate that lets
 * its visitor fetch the files and pictures it shows.
 *
 * @param {import('express').Express} app
 */
export function mountPublicChatShare(app, { wrap }) {
  app.get(
    '/api/shared-chat/:token',
    wrap(async (req, res) => {
      const token = String(req.params.token || '');
      const scope = TOKEN.test(token) ? await sharedScope(token) : null;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (!scope) return res.status(404).json({ error: 'This link does not exist, or was taken back.' });

      const messages = publicTranscript(await getStore().listSharedMessages(scope.chat.id, scope.chat.shared_at));
      const viewer = await currentUser(req).catch(() => null);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader(
        'Set-Cookie',
        `${SHARE_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`,
      );
      res.json({
        title: scope.chat.title,
        sharedAt: scope.chat.shared_at,
        messages,
        viewer: viewer ? { signedIn: true, isOwner: viewer.id === scope.chat.user_id } : { signedIn: false, isOwner: false },
      });
    }),
  );

  /**
   * Files, pictures, icons and map tiles, for a visitor with no session.
   *
   * A signed-in request goes straight on to the ordinary routes. A visitor is
   * served only what the shared conversation refers to: an attachment must be
   * the owner's and named in the transcript; icons, search pictures and map
   * tiles are the proxies the page's cards draw with, which a share-cookie
   * holder may use and nobody else.
   */
  /*
   * Signed in or not, a reader of the link sees its files (CODE-031). This used
   * to step aside for any session, so somebody signed in to their own account
   * reached the ordinary routes, which look files up under *their* id — and every
   * picture and file card on the shared page was a broken tile. Only the owner
   * is sent on: their own routes already serve them everything.
   */
  const visitorScope = async (req) => {
    const token = parseCookies(req.headers.cookie)[SHARE_COOKIE];
    const scope = token ? await sharedScope(token) : null;
    if (!scope) return null;
    const viewer = await currentUser(req).catch(() => null);
    return viewer && viewer.id === scope.chat.user_id ? null : scope;
  };
  const sendPicture = (res, picture) => {
    res.setHeader('Content-Type', picture.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(picture.data);
  };

  app.get(
    ['/api/attachments/:id', '/api/attachments/:id/thumb'],
    wrap(async (req, res, next) => {
      const scope = await visitorScope(req);
      if (!scope || !scope.files.has(req.params.id)) return next();
      const store = getStore();
      if (req.path.endsWith('/thumb')) {
        const thumb = await store.getAttachmentThumb(scope.chat.user_id, req.params.id);
        const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(thumb || '');
        if (!m) return res.status(404).json({ error: 'Not found' });
        return sendPicture(res, { type: m[1], data: Buffer.from(m[2], 'base64') });
      }
      const file = await store.getAttachment(scope.chat.user_id, req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const inline = req.query.download !== '1' && INLINE_SAFE.test(file.mime);
      res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(Buffer.from(file.data, 'base64'));
    }),
  );

  app.get(
    '/api/favicon/:host',
    wrap(async (req, res, next) => {
      if (!(await visitorScope(req))) return next();
      const host = cleanHost(req.params.host);
      const icon = host ? await faviconFor(host) : null;
      if (!icon) return res.status(404).json({ error: 'Not found' });
      sendPicture(res, icon);
    }),
  );
  app.get(
    '/api/image',
    wrap(async (req, res, next) => {
      if (!(await visitorScope(req))) return next();
      const picture = await proxiedImage(req.query.u, req.query.s);
      if (!picture) return res.status(404).json({ error: 'Not found' });
      sendPicture(res, picture);
    }),
  );
  app.get(
    '/api/map/:z/:x/:y',
    wrap(async (req, res, next) => {
      if (!(await visitorScope(req))) return next();
      const tile = await mapTile(req.params.z, req.params.x, req.params.y);
      if (!tile) return res.status(404).json({ error: 'Not found' });
      sendPicture(res, tile);
    }),
  );
}

/**
 * The owner's side — share, share again, stop — and the signed-in visitor's:
 * carry the conversation on in a copy of their own.
 *
 * @param {import('express').Router} api  the authenticated router
 */
export function mountChatShareRoutes(api, { wrap }) {
  api.post(
    '/chats/:id/share',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      // A link outlives the conversation's own day-long life and can be copied
      // anywhere — the opposite of what incognito promised.
      if (chat.incognito) {
        return res.status(400).json({ error: 'An incognito conversation cannot be shared.' });
      }
      // The same link every time; sharing again only moves the snapshot on.
      const shared = await store.setChatShare(req.user.id, chat.id, chat.share_token || newChatShareToken());
      gateCache.delete(shared.token);
      await audit(req, req.user.id, 'chat_shared');
      res.json({ shared: true, path: chatSharePath(shared.token), sharedAt: shared.sharedAt });
    }),
  );

  api.delete(
    '/chats/:id/share',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      await store.setChatShare(req.user.id, chat.id, null);
      if (chat.share_token) {
        gateCache.delete(chat.share_token);
        await audit(req, req.user.id, 'chat_unshared');
      }
      res.json({ shared: false });
    }),
  );

  api.post(
    '/shared-chat/:token/fork',
    wrap(async (req, res) => {
      const result = await forkSharedChat(req.user.id, String(req.params.token || ''));
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result);
    }),
  );
}

/**
 * Copy a shared conversation into this account, so it can be carried on.
 *
 * Its files are copied too, under new ids, and every reference in the
 * transcript is rewritten to them — so the copy is wholly the new owner's, and
 * nothing they do (edit, delete, rewrite a file) can reach back into the
 * original. The owner opening their own link is sent to the conversation
 * itself rather than to a copy of it.
 */
export async function forkSharedChat(userId, token) {
  const store = getStore();
  const chat = TOKEN.test(token) ? await store.getSharedChat(token) : null;
  if (!chat) return { status: 404, error: 'This link does not exist, or was taken back.' };
  if (chat.user_id === userId) return { chatId: chat.id, own: true };

  // The copy is made from what the link publishes, never from the stored
  // transcript: carrying a conversation on must not hand a stranger the steps
  // the shared page leaves out, or the reasoning it does not show.
  const messages = publicTranscript(await store.listSharedMessages(chat.id, chat.shared_at), { placeholder: LEFT_OUT });
  const newChatId = crypto.randomUUID();
  await store.createChat(userId, { id: newChatId, title: chat.title, model: null });

  const moved = new Map();
  for (const oldId of referencedFiles(messages)) {
    const file = await store.getAttachment(chat.user_id, oldId);
    if (!file) continue;
    const id = crypto.randomUUID();
    await store.createAttachment(userId, {
      id,
      name: file.name,
      mime: file.mime,
      kind: file.kind,
      bytes: file.bytes,
      data: file.data,
      origin: file.origin,
      source: file.source,
      chatId: newChatId,
    });
    moved.set(oldId, id);
  }
  const swap = (ref) => (ref?.id && moved.has(ref.id) ? { ...ref, id: moved.get(ref.id) } : ref);

  for (const m of messages) {
    const { id: _oldId, seq: _seq, createdAt: _createdAt, ...rest } = m;
    const copy = { ...rest, id: crypto.randomUUID() };
    if (Array.isArray(copy.attachments)) copy.attachments = copy.attachments.map(swap);
    if (Array.isArray(copy.results)) {
      copy.results = copy.results.map((r) => ({ ...r, ...(r.file ? { file: swap(r.file) } : {}), ...(r.shot ? { shot: swap(r.shot) } : {}) }));
    }
    await store.appendMessage(userId, newChatId, copy);
  }
  return { chatId: newChatId, own: false, messages: messages.length, files: moved.size };
}

export const __testing = { gateCache, TOKEN };
