import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { currentUser, parseCookies } from '../auth.js';
import { faviconFor, cleanHost, siteOf } from '../favicon.js';
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
 * Each as it stood at `shared_at`, like the messages: a file rewritten since is
 * served, and copied into a fork, from its history (`getAttachmentAt`, PRV-011),
 * and a message edited since is stamped with its edit, so the snapshot ends
 * before it — an edit deletes the turns after it anyway — and never shows the
 * edit (`editUserMessage`, PRV-012). Its title too is the one it had when it
 * was shared (`chats.shared_title`, PRV-013); renaming it afterwards renames it
 * for the owner only.
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

/**
 * Publishable tools that read a file by id, and the argument naming it.
 *
 * The id reaches any file on the account — a project shelf's spreadsheet, a file
 * made in another conversation — so a read is published only when the file is
 * the shared conversation's own: sent in it, or made in it by a published tool
 * (PRV-007). Without an id, `read_generated_file` lists this conversation's own
 * files, and `analyze_data` reads data written into the call; both stay public.
 *
 * `update_file` too (PRV-010): it rewrites a made file by id from anywhere on
 * the account, and its call carries the new text while its result names the
 * file — which the visitor could then fetch, and a fork would copy. A rewrite
 * of a file this conversation made is still published. Every publishable tool
 * that takes a `file_id` must be listed here; isolation.test checks it.
 */
const READS_A_FILE = { analyze_data: 'file_id', read_generated_file: 'file_id', update_file: 'file_id' };

/**
 * Which tool calls may be published, decided message by message (PRV-008).
 *
 * A Map from each assistant and tool message to its calls' decisions, by id:
 * `{ name, ok }`. A tool message is judged against the assistant message just
 * before it — the calls it answers — and nothing else. Ids are not unique across
 * a transcript: when a provider sends none, the adapters make one from position
 * and tool name (`gcall_0_read_generated_file` in google.js, `call_analyze_data`
 * in openaiCompatible.js), so two turns' reads share an id and a decision taken
 * for one must never reach the other's result. An id that appears twice in one
 * message is withheld for both.
 */
function publishDecisions(messages) {
  const own = new Set();
  for (const m of messages) {
    for (const a of m.attachments || []) if (a?.id) own.add(String(a.id));
    for (const r of m.results || []) {
      if (PUBLISHABLE_TOOLS.has(r.name) && !READS_A_FILE[r.name] && r.file?.id) own.add(String(r.file.id));
    }
  }
  const byMessage = new Map();
  let calls = new Map();
  for (const m of messages) {
    if (m.role === 'assistant') {
      calls = new Map();
      for (const c of m.toolCalls || []) {
        const file = READS_A_FILE[c.name] ? c.input?.[READS_A_FILE[c.name]] : null;
        const ok = PUBLISHABLE_TOOLS.has(c.name) && !(file && !own.has(String(file)));
        calls.set(c.id, calls.has(c.id) ? { name: c.name, ok: false } : { name: c.name, ok });
      }
      byMessage.set(m, calls);
    } else if (m.role === 'tool') {
      byMessage.set(m, calls);
    }
  }
  return byMessage;
}

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
 * @param {{ placeholder?: string, calls?: Map<string, { name: string, ok: boolean }> }} [options]
 *   `placeholder` replaces a withheld result's text (a copy the model will
 *   read); without it the text is empty and `hidden` says why (a page the
 *   visitor's browser words itself). `calls` is this message's entry in
 *   `publishDecisions`.
 */
function publicMessage(m, { placeholder = '', calls = new Map() } = {}) {
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
        input: calls.get(c.id)?.ok ? c.input : {},
      })),
    };
  }
  if (m.role === 'tool') {
    return {
      id: m.id,
      role: 'tool',
      results: (m.results || []).map((r) => {
        // The call this answers, in the message just before — and the same tool.
        const call = calls.get(r.toolCallId);
        return call?.ok && call.name === r.name && PUBLISHABLE_TOOLS.has(r.name)
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
          : { toolCallId: r.toolCallId, name: r.name, content: placeholder, isError: !!r.isError, ms: r.ms, hidden: true };
      }),
    };
  }
  return null;
}

/** The transcript as a visitor sees it — see `publicMessage`. */
export function publicTranscript(messages, options = {}) {
  const decisions = publishDecisions(messages);
  return messages.map((m) => publicMessage(m, { ...options, calls: decisions.get(m) })).filter(Boolean);
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

const ADDRESS = /https?:\/\/[^\s"'<>`)\]]+/gi;
const SIGNED_PICTURE = /\/api\/image\?u=([^&\s"'<>)\]]+)/g;

/** The video id the page's video card is drawn for (public/js/markdown.js `youtubeId`), or null. */
function youtubeId(url) {
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(url.pathname)?.[1] || null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** A map widget's places and route, as the page centres them (public/js/cards.js `mapFigure`). */
function mapPlaces(widget) {
  const points = (Array.isArray(widget.points) ? widget.points : [])
    .map((p) => [Number(p?.lat), Number(p?.lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
    .slice(0, 20);
  const line = (Array.isArray(widget.line) ? widget.line : [])
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([lat, lon]) => [Number(lat), Number(lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  return points.length ? [...points, ...line] : [];
}

/**
 * What a published transcript draws from elsewhere: the sites whose icons it
 * shows, the pictures it shows, and where its maps are (SEC-038).
 *
 * The share cookie lets somebody with no account use the icon, picture and map
 * proxies — to draw this page, and only that. A cookie anybody can mint by
 * sharing a conversation of their own was otherwise an anonymous fetcher for
 * every site's icon and every map tile there is.
 */
export function drawnFrom(messages) {
  const sites = new Set();
  const pictures = new Set();
  const maps = [];
  const read = (text) => {
    // A gallery's or a scores card's picture is a whole value of its widget.
    if (/^https?:\/\//i.test(text) && text.length <= 4096) pictures.add(text);
    for (const [, encoded] of text.matchAll(SIGNED_PICTURE)) {
      try {
        pictures.add(decodeURIComponent(encoded));
      } catch {
        /* not an address the page could have drawn either */
      }
    }
    for (const [address] of text.matchAll(ADDRESS)) {
      let url;
      try {
        url = new URL(address);
      } catch {
        continue;
      }
      const host = cleanHost(url.hostname);
      if (host) sites.add(siteOf(host));
      const video = youtubeId(url);
      if (video) pictures.add(`https://i.ytimg.com/vi/${video}/hqdefault.jpg`);
    }
  };
  const walk = (value) => {
    if (typeof value === 'string') read(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const m of messages) {
    walk(m);
    for (const r of m.results || []) {
      if (r?.widget?.kind !== 'map') continue;
      const places = mapPlaces(r.widget);
      if (places.length) maps.push(places);
    }
  }
  return { sites, pictures, maps };
}

const TILE = 256;
/**
 * How far from a map's centre its tiles can be drawn, in pixels at any zoom. The
 * map is 300px tall and as wide as the column; this allows a window several
 * times wider. Its zoom buttons keep the centre where it is (cards.js), so this
 * bounds every tile a shared map can ask for.
 */
const MAP_REACH_X = 1600;
const MAP_REACH_Y = 600;

/** Web Mercator, as public/js/cards.js `project`. */
function project(lat, lon, zoom) {
  const scale = TILE * 2 ** zoom;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

/** Whether one of these maps draws tile `z/x/y`. */
export function mapShows(maps, z, x, y) {
  const [zoom, col, row] = [z, x, y].map(Number);
  if (![zoom, col, row].every(Number.isInteger) || zoom < 0 || zoom > 19) return false;
  const world = TILE * 2 ** zoom;
  return maps.some((places) => {
    const ps = places.map(([lat, lon]) => project(lat, lon, zoom));
    const cx = (Math.min(...ps.map((p) => p.x)) + Math.max(...ps.map((p) => p.x))) / 2;
    const cy = (Math.min(...ps.map((p) => p.y)) + Math.max(...ps.map((p) => p.y))) / 2;
    // Columns wrap round the world on the page, so the nearest copy counts.
    let dx = Math.abs(col * TILE + TILE / 2 - cx) % world;
    dx = Math.min(dx, world - dx);
    return dx <= MAP_REACH_X + TILE && Math.abs(row * TILE + TILE / 2 - cy) <= MAP_REACH_Y + TILE;
  });
}

/**
 * The shared chat and the files it may serve, remembered a minute per token.
 *
 * What is remembered is the expensive part — the published transcript and the
 * files it names. Whether the link still stands is asked every time, one
 * lookup on a unique index (CODE-032): taking a link back cleared this cache
 * only on the instance that took it, and every other warm instance went on
 * serving the conversation's files for up to a minute. A link shared again has
 * a new `shared_at`, so a remembered scope from before is not reused either.
 */
const gateCache = new Map();
async function sharedScope(token) {
  const store = getStore();
  const chat = TOKEN.test(token || '') ? await store.getSharedChat(token) : null;
  const hit = gateCache.get(token);
  if (!chat) {
    gateCache.delete(token);
    return null;
  }
  if (hit?.scope && hit.until > Date.now() && String(hit.scope.chat.shared_at) === String(chat.shared_at)) return hit.scope;
  // The files of the published transcript, not of the stored one: a picture a
  // withheld step produced (a screenshot of a signed-in page) is not the visitor's to fetch.
  const published = chat ? publicTranscript(await store.listSharedMessages(chat.id, chat.shared_at)) : null;
  const scope = published ? { chat, files: referencedFiles(published), drawn: drawnFrom(published) } : null;
  if (gateCache.size > 500) gateCache.delete(gateCache.keys().next().value);
  gateCache.set(token, { scope, until: Date.now() + 60_000 });
  return scope;
}

// The same raster formats as the signed-in file route (files.js): none can carry a script.
const INLINE_SAFE = /^(image\/(png|jpe?g|webp|gif|avif|bmp|x-icon|vnd\.microsoft\.icon)|application\/pdf)$/i;
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
   * Files, pictures, icons and map tiles, for anyone reading the link who is not
   * its owner — signed in or not.
   *
   * The owner goes straight on to the ordinary routes, which already serve them
   * everything. Anybody else is served only what the shared conversation refers
   * to: an attachment must be the owner's and named in the transcript; an icon
   * must be for a site it names, a picture one it shows, a map tile one of its
   * maps draws (`drawnFrom`). Anything else is passed on, so a signed-in reader
   * still gets their own.
   *
   * Signed-in readers used to be stepped aside for too (CODE-031): the ordinary
   * routes look files up under *their* id, so every picture and file card on the
   * shared page was a broken tile.
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
      // As it stood when the link was made, like the messages (PRV-011).
      const file = await store.getAttachmentAt(scope.chat.user_id, req.params.id, scope.chat.shared_at);
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
      const scope = await visitorScope(req);
      const host = cleanHost(req.params.host);
      if (!scope || !host || !scope.drawn.sites.has(siteOf(host))) return next();
      const icon = await faviconFor(host);
      if (!icon) return res.status(404).json({ error: 'Not found' });
      sendPicture(res, icon);
    }),
  );
  app.get(
    '/api/image',
    wrap(async (req, res, next) => {
      const scope = await visitorScope(req);
      if (!scope || !scope.drawn.pictures.has(String(req.query.u ?? ''))) return next();
      const picture = await proxiedImage(req.query.u, req.query.s);
      if (!picture) return res.status(404).json({ error: 'Not found' });
      sendPicture(res, picture);
    }),
  );
  app.get(
    '/api/map/:z/:x/:y',
    wrap(async (req, res, next) => {
      const scope = await visitorScope(req);
      if (!scope || !mapShows(scope.drawn.maps, req.params.z, req.params.x, req.params.y)) return next();
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
    // The file as it was when the link was made, not as it is now (PRV-011).
    const file = await store.getAttachmentAt(chat.user_id, oldId, chat.shared_at);
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

export const __testing = { gateCache, TOKEN, READS_A_FILE };
