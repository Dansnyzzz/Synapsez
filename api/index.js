import { createApp } from '../server/app.js';
import { assertSecrets } from '../server/secrets.js';

/**
 * The Vercel entrypoint. Its Node runtime calls the default export as a plain
 * (req, res) handler, which is exactly what an Express app is.
 *
 * A hosted filesystem is read-only, so the secrets a local run generates for
 * itself cannot be generated here — they have to be set in the dashboard.
 *
 * The check is deliberately *not* a bare throw at import time. A module that
 * throws while loading gives Vercel nothing to invoke, and the visitor gets an
 * unexplained platform error page while the actual reason sits in a log nobody
 * has opened yet. Catching it and answering every request with the missing
 * variable named turns "the deployment is broken" into "add SESSION_SECRET and
 * redeploy", which is a question somebody can act on.
 */
let misconfigured = null;
try {
  const legacy = assertSecrets();
  // SEC-047: it works, and one value cannot be rotated in two halves.
  if (legacy.length) {
    console.warn(
      `[ai-remote] ${legacy.join(' and ')} come from ACCESS_TOKEN. Set them separately — rotating one value ` +
        'to sign everyone out would also make every stored API key unreadable.',
    );
  }
} catch (err) {
  misconfigured = err.message;
  console.error('[ai-remote] refusing to start:', err.message);
}

const app = misconfigured
  ? (req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          error: 'This deployment is not configured yet.',
          detail: misconfigured,
          fix: 'Vercel → Project → Settings → Environment Variables, then redeploy.',
        }),
      );
    }
  : createApp();

export default app;
