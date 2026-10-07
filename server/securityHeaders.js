/**
 * The response headers every page and every API answer carries — one list.
 *
 * Express sets them on everything it serves. On Vercel, though, Express never
 * sees the frontend: `public/` is served straight from the CDN, so the page
 * that matters most — the app itself — went out with no Content-Security-
 * Policy, no frame-ancestors (so it could be framed for clickjacking), no
 * Referrer-Policy and no Permissions-Policy. `vercel.json` now declares the same
 * headers for every non-API path, and `test/deploy.test.mjs` fails if the two
 * lists ever differ, because a policy that is strict on a laptop and absent in
 * production is the kind of gap nobody sees until it is used.
 *
 * The app has no build step and no third-party scripts, so a strict policy
 * costs nothing here and closes the usual holes: an injected `<script>` has
 * nowhere to load from, the page cannot be framed, and a URL is never leaked to
 * another origin through the referrer.
 *
 * `'unsafe-inline'` covers the inline `style=` attributes the UI sets for
 * layout measurements; script-src has no such escape hatch, which is the half
 * that matters.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // The cloud browser's live screen streams from the account's own machine, at
  // an address Vercel gives it under vercel.run.
  "img-src 'self' data: blob: https://*.vercel.run",
  "font-src 'self'",
  // A YouTube link in a reply plays in place, from the no-cookie domain only.
  "frame-src 'self' https://www.youtube-nocookie.com",
  // The cloud browser's live screen and a person's gestures, over one socket
  // straight to the account's machine — never through this app's server.
  "connect-src 'self' wss://*.vercel.run",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Every header but HSTS, which only belongs on a response that came over TLS. */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
};

export const HSTS = 'max-age=15552000; includeSubDomains';
