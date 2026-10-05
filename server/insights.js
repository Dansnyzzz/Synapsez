/**
 * Whether the browser should load Vercel Web Analytics and Speed Insights, and
 * with what.
 *
 * Both are Vercel's own, served from this deployment's origin
 * (`/_vercel/insights/script.js`, `/_vercel/speed-insights/script.js`), free on
 * the Hobby plan within its allowance — Web Analytics 50,000 events a month,
 * Speed Insights 10,000 over a rolling 30 days; past either, collection pauses
 * and nothing is billed (vercel.com/docs/analytics/limits-and-pricing,
 * /docs/speed-insights/limits-and-pricing). Cookieless; a visitor is a hash that
 * lives a day (vercel.com/docs/analytics/privacy-policy).
 *
 * Only on Vercel: anywhere else there is nothing at those paths, and the
 * self-hosted server answers them with the app's own page. The browser decides
 * the rest — it strips the address to its path and stays off entirely when the
 * visitor's browser sends Do Not Track or Global Privacy Control (see
 * public/js/insights.js).
 *
 *   INSIGHTS=off                      neither is loaded
 *   SPEED_INSIGHTS_SAMPLE_RATE=0.5    send half of the speed measurements
 */

/**
 * Vercel's build-time client configuration ("resilient intake"), passed on only
 * when every address in it stays on this origin — the page's policy allows
 * nothing else, and a value that pointed elsewhere would only fail.
 *
 * @param {string | undefined} raw
 */
export function sameOriginClientConfig(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const sameOrigin = (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('..');
  for (const section of ['analytics', 'speedInsights']) {
    const values = parsed[section];
    if (values == null) continue;
    if (typeof values !== 'object' || !Object.values(values).every(sameOrigin)) return null;
  }
  return JSON.stringify({ analytics: parsed.analytics, speedInsights: parsed.speedInsights });
}

/**
 * What `/api/session` tells the browser, or null for "load nothing".
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function insightsConfig(env = process.env) {
  if (!env.VERCEL || String(env.INSIGHTS || '').toLowerCase() === 'off') return null;
  const rate = Number(env.SPEED_INSIGHTS_SAMPLE_RATE);
  return {
    sampleRate: Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 1,
    clientConfig: sameOriginClientConfig(env.VERCEL_OBSERVABILITY_CLIENT_CONFIG),
  };
}
