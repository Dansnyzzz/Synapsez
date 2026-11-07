import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * The two provider pages with more to say than a bar (owner, 2026-11-06): what
 * Google's AI Studio and OrcaRouter's console draw for a person signed in there.
 *
 * Whose number each one is matters here, and is said. OrcaRouter answers for its
 * whole workspace, from its own records. Google has no API for any of this, so
 * Gemini's page is what Synapsez counted, beside the free tier's limits where they
 * are known and a link to where the project's exact ones are.
 *
 * @typedef {{ count: (n: number) => string, money: (n: number | null) => string, pct: (n: number) => string,
 *   when: (date: Date, options: any) => string, modelShort: (id: string) => string }} Helpers
 */

const AI_STUDIO_LIMITS = 'https://aistudio.google.com/rate-limit';
const AI_STUDIO_USAGE = 'https://aistudio.google.com/usage';

/**
 * A free-tier project's limits as AI Studio showed them on 2026-11-06: requests and
 * input tokens a minute, for the models this app calls. The aliases are what it asks
 * for. Only a guide, which is why the exact figures are one link away: a project on a
 * paid tier has others, and no API says which tier a key is on.
 */
const FREE_LIMITS = {
  'gemini-3.8-flash': { rpm: 5, tpm: 250_000 },
  'gemini-flash-latest': { rpm: 5, tpm: 250_000 },
  'gemini-2.5-flash': { rpm: 5, tpm: 250_000 },
  'gemini-embedding-001': { rpm: 100, tpm: 30_000 },
};

/** A figure against its limit, where there is one. @param {Helpers} h */
const against = (used, limit, h) => (limit ? `${h.count(used)} / ${h.count(limit)}` : h.count(used));

/** How big a number is, in words a person reads at a glance: 16.1M. */
const short = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0);

/** A share of requests, where a fraction of a percent is the whole story. */
const rate = (n) => `${(Math.max(0, Number(n) || 0) * 100).toFixed(1)}%`;

const statusName = (status) => {
  const key = `usage.status.${status}`;
  const said = t(key);
  return said === key ? t('usage.status.other') : said;
};

/**
 * Twenty-eight days of requests, each day's failures on top of its successes, with
 * how each failure was answered listed underneath: Google's "Total API Errors".
 *
 * @param {{ daily?: { day: string, calls: number }[], errors?: { day: string, status: number, calls: number }[] }} detail
 * @param {Helpers} h
 */
function requestsAndErrors(detail, h) {
  const days = new Map();
  const dayKey = (iso) => String(iso).slice(0, 10);
  const today = new Date();
  for (let back = 27; back >= 0; back -= 1) {
    const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
    days.set(dayKey(at.toISOString()), { at, ok: 0, bad: 0 });
  }
  for (const row of detail.daily || []) if (days.has(dayKey(row.day))) days.get(dayKey(row.day)).ok += row.calls;
  const byStatus = new Map();
  for (const row of detail.errors || []) {
    if (days.has(dayKey(row.day))) days.get(dayKey(row.day)).bad += row.calls;
    byStatus.set(row.status, (byStatus.get(row.status) || 0) + row.calls);
  }
  const rows = [...days.values()];
  const ok = rows.reduce((n, d) => n + d.ok, 0);
  const bad = rows.reduce((n, d) => n + d.bad, 0);
  if (!ok && !bad) return `<p class="usage__muted">${escapeHtml(t('usage.detail.nothing'))}</p>`;
  const most = Math.max(1, ...rows.map((d) => d.ok + d.bad));
  const bars = rows
    .map((d) => {
      const name = h.when(d.at, { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
      const line = t('usage.detail.dayLine', { day: name, ok: h.count(d.ok), bad: h.count(d.bad) });
      const part = (n, kind) => (n ? `<span class="${kind}" style="height:${Math.max(2, Math.round((n / most) * 100))}%"></span>` : '');
      return `<div class="usage__mday" title="${escapeHtml(line)}" aria-label="${escapeHtml(line)}" role="img">${part(d.bad, 'is-bad')}${part(d.ok, 'is-ok')}</div>`;
    })
    .join('');
  const first = h.when(rows[0].at, { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
  const last = h.when(rows.at(-1).at, { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
  const statuses = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
  return `<div class="usage__month">${bars}</div>
    <div class="usage__axis"><span>${escapeHtml(first)}</span><span>${escapeHtml(last)}</span></div>
    <p class="usage__key"><span><i></i>${escapeHtml(t('usage.detail.ok'))}</span><span><i class="is-bad"></i>${escapeHtml(t('usage.detail.failed'))}</span></p>
    <p>${escapeHtml(t('usage.detail.rate', { pct: h.pct(ok / (ok + bad)), n: h.count(ok + bad) }))}</p>
    ${statuses.length ? `<div class="usage__tablebox"><table class="usage__models"><thead><tr><th scope="col">${escapeHtml(t('usage.detail.failed'))}</th><th scope="col">${escapeHtml(t('usage.detail.calls'))}</th></tr></thead><tbody>${statuses.map(([status, calls]) => `<tr><td>${status ? `${status} ` : ''}${escapeHtml(statusName(status))}</td><td>${h.count(calls)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

/**
 * Gemini's page: limits by model, then requests and errors.
 *
 * @param {any} report @param {Helpers} h
 */
export function geminiDetail(report, h) {
  const detail = report.detail?.google;
  if (!detail) return '';
  const rows = [...(detail.models || [])].sort((a, b) => b.calls - a.calls);
  const table = rows.length
    ? `<div class="usage__tablebox"><table class="usage__models"><thead><tr>${['model', 'calls'].map((k) => `<th scope="col">${escapeHtml(t(`usage.detail.${k}`))}</th>`).join('')}<th scope="col">RPM</th><th scope="col">TPM</th><th scope="col">${escapeHtml(t('usage.detail.input'))}</th><th scope="col">${escapeHtml(t('usage.detail.output'))}</th></tr></thead><tbody>${rows
        .map((row) => {
          const name = h.modelShort(row.model);
          const limit = FREE_LIMITS[name];
          return `<tr><td>${escapeHtml(name)}</td><td>${h.count(row.calls)}</td><td>${against(row.peakRpm, limit?.rpm, h)}</td><td>${against(row.peakTpm, limit?.tpm, h)}</td><td>${escapeHtml(short(row.input))}</td><td>${escapeHtml(short(row.output))}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : `<p class="usage__muted">${escapeHtml(t('usage.detail.nothing'))}</p>`;
  return `<section><h4>${escapeHtml(t('usage.gemini.limitsTitle'))}</h4>
      <p class="usage__muted">${escapeHtml(t('usage.gemini.limitsHint'))}</p>
      ${table}
      <div class="usage__actions"><a class="btn btn--ghost btn--small" href="${AI_STUDIO_LIMITS}" target="_blank" rel="noopener">${escapeHtml(t('usage.gemini.openLimits'))} ↗</a><a class="btn btn--ghost btn--small" href="${AI_STUDIO_USAGE}" target="_blank" rel="noopener">${escapeHtml(t('usage.gemini.openUsage'))} ↗</a></div>
    </section>
    <section><h4>${escapeHtml(t('usage.detail.requestsTitle'))}</h4>${requestsAndErrors(detail, h)}<p class="usage__muted">${escapeHtml(t('usage.detail.counted'))}</p></section>`;
}

/**
 * OrcaRouter's page: the workspace as OrcaRouter reports it, then what was counted here.
 *
 * @param {any} report @param {Helpers} h
 */
export function orcaDetail(report, h) {
  const live = (report.live?.orcarouter || []).find((row) => row.ok);
  const metrics = (report.live?.orcarouter || []).find((row) => row.ok && row.metrics)?.metrics;
  const refused = (report.live?.orcarouter || []).some((row) => row.metricsRefused);
  const tile = (label, value) => `<div class="usage__tile"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  const seconds = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
  const money = live
    ? [
        live.balance != null ? tile(t('usage.orca.wallet'), h.money(live.balance)) : '',
        live.spendable != null ? tile(t('usage.orca.spendable'), h.money(live.spendable)) : '',
        live.spent != null ? tile(t('usage.orca.spent'), h.money(live.spent)) : '',
      ].join('')
    : '';
  const stats = metrics
    ? [
        tile(t('usage.orca.spend'), h.money(metrics.spend)),
        tile(t('usage.orca.tokens'), short(metrics.tokens)),
        tile(t('usage.orca.requests'), h.count(metrics.requests ?? 0)),
        tile(t('usage.orca.latency'), seconds(metrics.avgLatencyMs)),
        tile(t('usage.orca.p99'), seconds(metrics.p99Ms)),
        tile(t('usage.orca.errors'), rate(metrics.errorRate)),
      ].join('')
    : '';
  const models = metrics?.models?.length
    ? `<div class="usage__tablebox"><table class="usage__models"><thead><tr><th scope="col">${escapeHtml(t('usage.detail.model'))}</th><th scope="col">${escapeHtml(t('usage.detail.calls'))}</th><th scope="col">${escapeHtml(t('usage.orca.tokens'))}</th><th scope="col">${escapeHtml(t('usage.orca.spend'))}</th><th scope="col">${escapeHtml(t('usage.orca.p50'))}</th><th scope="col">${escapeHtml(t('usage.orca.p95'))}</th><th scope="col">${escapeHtml(t('usage.orca.errors'))}</th></tr></thead><tbody>${metrics.models
        .map((row) => `<tr><td>${escapeHtml(h.modelShort(row.model))}</td><td>${h.count(row.requests ?? 0)}</td><td>${escapeHtml(short(row.tokens))}</td><td>${h.money(row.spend ?? 0)}</td><td>${seconds(row.p50)}</td><td>${seconds(row.p95)}</td><td>${rate(row.errorRate)}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '';
  const counted = report.detail?.orcarouter;
  return `<section><h4>${escapeHtml(t('usage.orca.title'))}</h4>
      ${money || stats ? `<div class="usage__tiles">${money}${stats}</div>` : ''}
      ${models}
      ${refused ? `<p class="usage__note">${escapeHtml(t('usage.orca.refused'))}</p>` : ''}
    </section>
    ${counted ? `<section><h4>${escapeHtml(t('usage.detail.requestsTitle'))}</h4>${requestsAndErrors(counted, h)}<p class="usage__muted">${escapeHtml(t('usage.detail.counted'))}</p></section>` : ''}`;
}
