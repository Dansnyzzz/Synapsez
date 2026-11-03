import { connectedServices, disconnect } from '../connectors.js';
import { intakeToken } from '../keyIntake.js';
import { limit as rateLimit } from '../ratelimit.js';
import { languageOf, translateMessage } from '../i18n/index.js';
import { authUrl, finishAuth, googleConfigured, googleGrants, pickProducts, readState, dropGoogleProduct, GOOGLE_PRODUCTS } from '../google.js';
import { getStore } from '../store/index.js';
import { getPrefs } from '../settings.js';
import { needsApproval } from '../agent.js';
import { listDriveFiles, driveFileForAttachment } from '../tools/google.js';
import { saveUpload, LIMITS } from '../attachments.js';
import { publicUrlFor } from '../util/net.js';
import { TOOLS } from '../tools/definitions.js';
import { DRIVE_ORIGIN } from '../googleData.js';
import { connectorDirectory } from '../connectorDirectory.js';
import { productIcon } from '../favicon.js';
import { clientError } from '../util/clientError.js';

/**
 * Connecting a third-party account — GitHub, Notion, Slack and the rest.
 *
 * These sat physically after the workflow routes in app.js and travelled with
 * them when that group was lifted out, which put connector routes in a file
 * called workflows.js. They have nothing to do with workflows, so they are
 * their own module: a filename that lies is worse than one more file.
 *
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function }} ctx
 */
export function mountConnectorRoutes(api, { wrap }) {
    api.get(
      '/connectors',
      wrap(async (req, res) => {
        const language = languageOf(req);
        const connectors = (await connectedServices(req.user.id)).map((c) => ({
          ...c,
          help: translateMessage(c.help, language),
          placeholder: translateMessage(c.placeholder, language),
          // The tools that reach this service, so the side panel can list a
          // connector only when a conversation actually used it. Read from the
          // catalogue's own `needs`, so a new tool cannot be missed here.
          tools: TOOLS.filter((t) => t.needs === c.id || (c.id === 'google' && String(t.needs || '').startsWith('google_'))).map(
            (t) => t.name,
          ),
        }));
        res.json({ connectors });
      }),
    );

    /**
     * Settings → Connectors as Claude's page has them (owner, 2026-11-01): each
     * Google product its own connector, beside GitHub, Notion, Slack, YouTube
     * transcripts and Telegram — where each stands, and what its tools do: each
     * action, and whether it runs at once or asks first under this account's
     * approval policy (`needsApproval`, the rule a turn obeys). Facebook Page is
     * listed only for an account that already has it connected.
     */
    const SERVICE_ORDER = ['github', 'notion', 'slack', 'supadata', 'telegram'];
    api.get(
      '/connectors/catalog',
      wrap(async (req, res) => {
        const userId = req.user.id;
        const [rows, prefs, granted, services] = await Promise.all([
          getStore().listConnectors(userId),
          getPrefs(userId).catch(() => ({})),
          googleGrants(userId).catch(() => []),
          connectedServices(userId),
        ]);
        // Where a token comes from, or what setting Google up takes — said on the page.
        const language = languageOf(req);
        const help = (id) => {
          const known = services.find((c) => c.id === id);
          return { help: translateMessage(known?.help || '', language), placeholder: known?.placeholder || '' };
        };
        const linked = new Map(rows.map((r) => [r.service, r]));
        const off = new Set(Array.isArray(prefs.connectorsOff) ? prefs.connectorsOff : []);
        const policy = prefs.toolPolicy || 'guarded';
        const asks = (name, input) => needsApproval([{ id: 'catalog', name, input }], policy).length > 0;
        const toolsFor = (need) =>
          TOOLS.filter((t) => t.needs === need).flatMap((t) => {
            const actions = t.parameters?.properties?.action?.enum;
            return Array.isArray(actions)
              ? actions.map((action) => ({ name: action, tool: t.name, asks: asks(t.name, { action }) }))
              : [{ name: t.name, tool: t.name, asks: asks(t.name, {}) }];
          });
        const google = Object.keys(GOOGLE_PRODUCTS).map((product) => ({
          id: `google:${product}`,
          configured: googleConfigured(),
          connected: granted.includes(product),
          paused: granted.includes(product) && off.has('google'),
          account: granted.includes(product) ? linked.get('google')?.account || null : null,
          tools: toolsFor(`google_${product}`),
          ...help('google'),
        }));
        const tokens = [...SERVICE_ORDER, ...(linked.has('meta_page') ? ['meta_page'] : [])].map((id) => ({
          id,
          configured: true,
          connected: linked.has(id),
          paused: linked.has(id) && off.has(id),
          account: linked.get(id)?.account || null,
          tools: toolsFor(id),
          ...help(id),
        }));
        res.json({ policy, entries: [...google, ...tokens] });
      }),
    );

    /** A Google product's own logo, through this app (favicon.js `productIcon`). */
    api.get(
      '/connectors/icon/:product',
      wrap(async (req, res) => {
        const icon = await productIcon(String(req.params.product));
        if (!icon) return res.status(404).json({ error: 'Not found' });
        res.setHeader('Content-Type', icon.type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(icon.data);
      }),
    );

    /** One Google product disconnected — the last one disconnects Google, revoking the grant. */
    api.delete(
      '/connectors/google/:product',
      wrap(async (req, res) => {
        try {
          res.json({ products: await dropGoogleProduct(req.user.id, String(req.params.product)) });
        } catch (err) {
          res.status(400).json({ error: translateMessage(clientError(err), languageOf(req)) });
        }
      }),
    );

    /**
     * Where each entry of the connector directory stands for this account —
     * so a suggestion card drawn last week says "Connected" once it is, and a
     * card just pressed says so the moment Settings closes (owner, 2026-11-01).
     */
    api.get(
      '/connectors/directory',
      wrap(async (req, res) => {
        const entries = await connectorDirectory(req.user.id);
        res.json({ entries: entries.map(({ id, kind, connected, paused }) => ({ id, kind, connected, paused })) });
      }),
    );

    /**
     * Google: off to the consent screen, and back.
     *
     * Plain navigations rather than fetches — the browser has to *go* to
     * Google — which the session cookie (SameSite=Lax) survives in both
     * directions. The nonce cookie ties the callback to this browser; the
     * signed state ties it to this account and this moment.
     */
    const NONCE_COOKIE = 'g_oauth';
    const nonceCookie = (value, maxAge) =>
      `${NONCE_COOKIE}=${value}; Path=/api/connectors/google; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`;

    api.get(
      '/connectors/google/start',
      rateLimit('connect', (req) => req.user?.id),
      wrap(async (req, res) => {
        if (!googleConfigured()) {
          return res.status(400).json({
            error: translateMessage(
              'Google is not set up on this deployment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.',
              languageOf(req),
            ),
          });
        }
        const { url, nonce } = authUrl({
          userId: req.user.id,
          products: pickProducts(req.query.products),
          origin: publicUrlFor(req),
        });
        res.setHeader('Set-Cookie', nonceCookie(nonce, 600));
        res.redirect(302, url);
      }),
    );

    api.get(
      '/connectors/google/callback',
      wrap(async (req, res) => {
        const nonce = /(?:^|;\s*)g_oauth=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1] || '';
        res.setHeader('Set-Cookie', nonceCookie('', 0));
        const back = (params) => res.redirect(302, `/?${new URLSearchParams(params).toString()}`);
        if (req.query.error) return back({ google: 'denied' });
        try {
          const asked = readState(req.query.state, req.user.id, nonce);
          const { products } = await finishAuth({ userId: req.user.id, code: req.query.code, origin: publicUrlFor(req), products: asked });
          back({ google: 'connected', products: products.join(',') });
        } catch (err) {
          // The reason travels in a cookie only this origin can set, not in the
          // URL: `/?google=error&message=…` was a link anyone could send that put
          // their own words in this app's error toast.
          const reason = encodeURIComponent(translateMessage(clientError(err), languageOf(req)).slice(0, 300));
          res.append('Set-Cookie', `g_err=${reason}; Path=/; Max-Age=60; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
          back({ google: 'error' });
        }
      }),
    );

    /**
     * The + menu's "Add from Google Drive" (owner, 2026-10-14): find a file in
     * the person's Drive, and attach it to the message being written.
     *
     * Only with Drive granted — asking without it would be a 403 from Google
     * in words nobody can act on. Attaching goes through `saveUpload`, the same
     * door every upload uses, so a Drive file obeys the same size and type rules
     * as a file picked from the computer, and becomes this account's attachment.
     */
    const withDrive = async (req, res) => {
      if ((await googleGrants(req.user.id).catch(() => [])).includes('drive')) return true;
      res.status(400).json({
        error: translateMessage('Google Drive is not connected. Connect Google in Settings → Connectors and allow Drive.', languageOf(req)),
      });
      return false;
    };

    api.get(
      '/connectors/google/drive',
      rateLimit('drive', (req) => req.user?.id),
      wrap(async (req, res) => {
        if (!(await withDrive(req, res))) return;
        try {
          res.json({ files: await listDriveFiles(req.user.id, typeof req.query.q === 'string' ? req.query.q : '') });
        } catch (err) {
          res.status(400).json({ error: translateMessage(clientError(err), languageOf(req)) });
        }
      }),
    );

    api.post(
      '/connectors/google/drive/:fileId/attach',
      rateLimit('drive', (req) => req.user?.id),
      wrap(async (req, res) => {
        if (!(await withDrive(req, res))) return;
        try {
          const file = await driveFileForAttachment(req.user.id, req.params.fileId, { maxBytes: LIMITS.maxBytes });
          // Marked as from Drive: the conversation it is sent in then goes only
          // to models that do not train on it (googleData.js).
          res.status(201).json({ attachment: await saveUpload(req.user.id, { ...file, origin: DRIVE_ORIGIN }) });
        } catch (err) {
          res.status(400).json({ error: translateMessage(clientError(err), languageOf(req)) });
        }
      }),
    );

    api.post(
      '/connectors/:service',
      // Each attempt makes an outbound call to a third party to verify the token;
      // without a ceiling this endpoint is a free proxy for hammering their API.
      rateLimit('connect', (req) => req.user?.id),
      wrap(async (req, res) => {
        try {
          // Recognised by its shape (keyIntake.js, owner 2026-11-02): another
          // connector's token is connected where it belongs, a provider's key
          // is kept among the providers — and the answer says where it went.
          const saved = await intakeToken(req.user.id, req.params.service, req.body?.token);
          res.json({ service: saved.kind === 'service' ? saved.id : req.params.service, account: saved.account ?? null, saved });
        } catch (err) {
          res.status(400).json({ error: translateMessage(clientError(err), languageOf(req)) });
        }
      }),
    );

    api.delete(
      '/connectors/:service',
      wrap(async (req, res) => {
        await disconnect(req.user.id, req.params.service);
        res.json({ ok: true });
      }),
    );
}
