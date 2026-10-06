/**
 * Page views and page speed, measured by Vercel — never more than a page's path.
 *
 * Vercel Web Analytics and Speed Insights (packages @vercel/analytics and
 * @vercel/speed-insights, vendored in public/vendor/vercel by
 * scripts/vendor-insights.js). Both add a deferred script that Vercel serves
 * from this same origin, so the page's `script-src 'self'` / `connect-src 'self'`
 * policy covers them unchanged.
 *
 * Three promises, each kept here rather than hoped for:
 *
 *  - **Only a path leaves.** This app keeps tokens in the address — a password
 *    reset (`?reset=`), a shared conversation (`?t=`, `?continue=`), which chat
 *    is open (`?chat=`). Every event is cut to origin and path before it is sent.
 *  - **Nothing at all when the browser asks not to be tracked** — Global Privacy
 *    Control or Do Not Track.
 *  - **Nothing off Vercel.** The server says whether it is on Vercel
 *    (`/api/session` → `insights`, see server/insights.js); a self-hosted copy
 *    never loads either script.
 *
 * And one economy: the free plan counts events, and the app rewrites its own
 * address (it removes those tokens with `history.replaceState`), which the
 * analytics script reports as another page view of the same page. One view per
 * path per load is sent; the rest are dropped here.
 */

/** `origin + pathname` of an address, or null for one that is not an address. */
export function pathOnly(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Whether this browser has asked not to be tracked.
 *
 * @param {{ globalPrivacyControl?: boolean, doNotTrack?: string | null } | undefined} [nav]
 * @param {{ doNotTrack?: string | null } | undefined} [win]
 */
export function trackingRefused(nav = /** @type {any} */ (globalThis.navigator), win = /** @type {any} */ (globalThis.window)) {
  return nav?.globalPrivacyControl === true || nav?.doNotTrack === '1' || nav?.doNotTrack === 'yes' || win?.doNotTrack === '1';
}

/** Web Analytics' `beforeSend`: path only, one page view per path per load. */
export function analyticsFilter() {
  let lastView = null;
  return (event) => {
    const url = pathOnly(event?.url);
    if (!url) return null;
    if (event.type === 'pageview') {
      if (url === lastView) return null;
      lastView = url;
    }
    return { ...event, url };
  };
}

/** Speed Insights' `beforeSend`: path only. */
export function speedFilter() {
  return (data) => {
    const url = pathOnly(data?.url);
    return url ? { ...data, url } : null;
  };
}

let started = false;
const VENDOR = '../vendor/vercel/';

/**
 * Start both, once, if the server said this deployment measures and the browser
 * has not said no. Never throws: measuring is not worth breaking the page for.
 *
 * @param {{ sampleRate?: number, clientConfig?: string | null } | null | undefined} config
 */
export async function startInsights(config) {
  if (started || !config || trackingRefused()) return;
  started = true;
  try {
    // Built specifiers, so the type checker leaves the vendored third-party code
    // alone; the browser resolves them exactly as it would literals.
    const [{ inject }, { injectSpeedInsights }] = await Promise.all([
      import(`${VENDOR}analytics.mjs`),
      import(`${VENDOR}speed-insights.mjs`),
    ]);
    const shared = config.clientConfig || undefined;
    inject({ mode: 'production', debug: false, beforeSend: analyticsFilter() }, shared);
    injectSpeedInsights({ debug: false, sampleRate: config.sampleRate || 1, beforeSend: speedFilter() }, shared);
  } catch {
    /* an ad blocker, an offline moment — the app works the same without it */
  }
}
