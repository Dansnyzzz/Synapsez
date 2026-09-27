import { connectedServices, connect, disconnect } from '../connectors.js';
import { limit as rateLimit } from '../ratelimit.js';
import { languageOf, translateMessage } from '../i18n/index.js';
import { authUrl, finishAuth, googleConfigured, pickProducts, readState } from '../google.js';
import { publicUrlFor } from '../util/net.js';

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
        }));
        res.json({ connectors });
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
          readState(req.query.state, req.user.id, nonce);
          const { products } = await finishAuth({ userId: req.user.id, code: req.query.code, origin: publicUrlFor(req) });
          back({ google: 'connected', products: products.join(',') });
        } catch (err) {
          back({ google: 'error', message: translateMessage(String(err.message), languageOf(req)).slice(0, 300) });
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
          res.json(await connect(req.user.id, req.params.service, req.body?.token));
        } catch (err) {
          res.status(400).json({ error: err.message });
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
