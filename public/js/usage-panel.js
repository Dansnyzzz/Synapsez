import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';
import {
  weekDays,
  rowsFor,
  callsByDay,
  heatmap,
  shareBy,
  pace,
  busiest,
  usualDay,
  nextUtcMidnight,
  nextMonth,
  standing,
} from './usage-math.js';

/**
 * Settings → Usage, after Claude's (owner, 2026-10-31): a page per provider the
 * account has a key for — and an overview of them all — each with what is left,
 * when it resets, where the requests went, the week hour by hour, the pace, and
 * the money.
 *
 * Every figure says whose it is. "OpenRouter reports" is OpenRouter's own answer
 * about the account's own key; everything else is what Synapsez counted from its
 * own records, and the page says that rather than dressing a count up as a
 * limit. Nothing here is invented: a provider that does not say what is left is
 * shown without a bar, and a link to where it does say.
 *
 * @typedef {{ load: () => Promise<any>, sessions: () => Promise<any>, signOut: (id: string) => Promise<any>, providers: () => any, meta: () => any, user: () => any }} Deps
 */

const ORDER = ['openrouter', 'google', 'orcarouter', 'anthropic', 'openai'];
/** Where each provider's own figures live, for the line under a provider that reports none. */
const CONSOLE = {
  google: 'https://aistudio.google.com/usage',
  orcarouter: 'https://www.orcarouter.ai/keys',
  openrouter: 'https://openrouter.ai/settings/credits',
};
const LIMITS_DOC = 'https://openrouter.ai/docs/api-reference/limits';

const locale = () => (currentLanguage() === 'vi' ? 'vi-VN' : 'en-US');
const firstDay = () => (currentLanguage() === 'vi' ? 1 : 0);
const pct = (n) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
const money = (n) => (n == null ? '—' : new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n < 1 && n > 0 ? 4 : 2 }).format(n));
const count = (n) => new Intl.NumberFormat(locale()).format(n);
const when = (date, opts) => new Intl.DateTimeFormat(locale(), opts).format(date);
const resetAt = (date) => when(date, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** The bar the page draws for any limit: a label and its sub-line, the fill, the share used. */
function bar({ label, sub = '', used, limit, note = '' }) {
  const share = limit > 0 ? used / limit : 0;
  const tone = share >= 1 ? ' is-out' : share >= 0.8 ? ' is-close' : '';
  return `<div class="usage__limit">
    <div class="usage__limit-text"><span class="usage__limit-label">${escapeHtml(label)}</span>${sub ? `<span class="usage__limit-sub">${escapeHtml(sub)}</span>` : ''}</div>
    <div class="usage__bar${tone}" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.min(used, limit)}"><span style="width:${pct(share)}"></span></div>
    <span class="usage__pct">${escapeHtml(note || t('usage.used', { pct: pct(share) }))}</span>
  </div>`;
}

const segmented = (name, options, current) =>
  `<div class="usage__seg" role="tablist">${options
    .map(([id, label]) => `<button type="button" role="tab" data-${name}="${id}" aria-selected="${id === current}">${escapeHtml(label)}</button>`)
    .join('')}</div>`;

/** @param {HTMLElement} host @param {Deps} deps */
export function createUsagePanel(host, deps) {
  const view = { scope: 'all', where: 'model', week: 'grid', weekTable: false, report: null, sessions: null, loadedAt: 0, error: '' };

  /** The providers this page has a tab for: the account's own keys, and any it used through the shared key. */
  function scopes() {
    const status = deps.providers() || {};
    const meta = deps.meta() || {};
    const used = new Set((view.report?.hours || []).map((h) => h.provider));
    const list = ORDER.filter((p) => status[p]?.own || used.has(p));
    return [['all', t('usage.overview')], ...list.map((p) => [p, meta[p]?.label || p])];
  }

  const keyName = (index) => {
    const key = deps.providers()?.openrouter?.keys?.[index];
    // The hint already reads "…7a41".
    return t('usage.keyN', { n: String(index + 1), hint: key?.hint ? ` (${key.hint.startsWith('…') ? key.hint : `…${key.hint}`})` : '' });
  };

  /** Every limit the page knows for the scope, as bars, and what they mean for the line at the top. */
  function limits(scope) {
    const out = [];
    const report = view.report;
    const now = new Date();
    if (scope === 'all' || scope === 'openrouter') {
      for (const live of report.live?.openrouter || []) {
        if (!live.ok) {
          out.push({ html: `<p class="usage__note">${escapeHtml(t(live.reason === 'rejected' ? 'usage.keyRejected' : 'usage.keyQuiet', { key: keyName(live.index) }))}</p>` });
          continue;
        }
        if (live.freeToday) {
          out.push({
            used: live.freeToday.used,
            limit: live.freeToday.limit,
            html: bar({
              label: t('usage.freeToday', { key: keyName(live.index) }),
              sub: t('usage.resets', { when: resetAt(nextUtcMidnight(now)) }),
              used: live.freeToday.used,
              limit: live.freeToday.limit,
              note: t('usage.ofLimit', { used: count(live.freeToday.used), limit: count(live.freeToday.limit) }),
            }),
          });
        }
        const cap = live.budget || (live.limit ? { limit: live.limit.amount, spent: live.limit.amount - (live.limit.remaining ?? live.limit.amount), resetsAt: null, interval: live.limit.reset } : null);
        if (cap && cap.limit > 0) {
          out.push({
            used: cap.spent ?? 0,
            limit: cap.limit,
            html: bar({
              label: t('usage.keyLimit', { key: keyName(live.index) }),
              sub: cap.resetsAt ? t('usage.resets', { when: resetAt(new Date(cap.resetsAt)) }) : cap.interval ? t(`usage.interval.${cap.interval}`) : t('usage.noReset'),
              used: cap.spent ?? 0,
              limit: cap.limit,
              note: t('usage.ofLimit', { used: money(cap.spent ?? 0), limit: money(cap.limit) }),
            }),
          });
        }
      }
    }
    // The deployment's own monthly ceiling, which is only spent on its shared key.
    const shared = report.sharedKey?.openrouter && report.sharedLimit > 0 && (scope === 'all' || scope === 'openrouter');
    if (shared) {
      out.push({
        used: report.month.tokens,
        limit: report.sharedLimit,
        html: bar({
          label: t('usage.sharedMonth'),
          sub: t('usage.resets', { when: when(nextMonth(now), { day: 'numeric', month: 'short' }) }),
          used: report.month.tokens,
          limit: report.sharedLimit,
          note: t('usage.ofLimit', { used: count(report.month.tokens), limit: count(report.sharedLimit) }),
        }),
      });
    }
    if (scope !== 'all' && scope !== 'openrouter') {
      out.push({ html: `<p class="usage__note">${escapeHtml(t('usage.noAllowance', { provider: deps.meta()?.[scope]?.label || scope }))} <a href="${CONSOLE[scope] || '#'}" target="_blank" rel="noopener">${escapeHtml(t('usage.openConsole'))} ↗</a></p>` });
    }
    return out;
  }

  /** The resets the page knows of, soonest first. */
  function resets(scope) {
    const now = new Date();
    const list = [];
    if ((scope === 'all' || scope === 'openrouter') && (view.report.live?.openrouter || []).some((l) => l.ok && l.freeToday)) {
      list.push({ at: nextUtcMidnight(now), what: t('usage.resetFree') });
    }
    for (const live of view.report.live?.openrouter || []) {
      if ((scope === 'all' || scope === 'openrouter') && live.ok && live.budget?.resetsAt) list.push({ at: new Date(live.budget.resetsAt), what: t('usage.resetBudget', { key: keyName(live.index) }) });
    }
    if (view.report.sharedKey?.openrouter && view.report.sharedLimit > 0 && (scope === 'all' || scope === 'openrouter')) list.push({ at: nextMonth(now), what: t('usage.resetShared') });
    list.sort((a, b) => a.at - b.at);
    if (!list.length) return `<p class="usage__strong">${escapeHtml(t('usage.noResets'))}</p><p class="usage__muted">${escapeHtml(t('usage.noResetsHint'))}</p>`;
    return `<ul class="usage__resets">${list.map((r) => `<li><span>${escapeHtml(r.what)}</span><span class="usage__muted">${escapeHtml(when(r.at, { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</span></li>`).join('')}</ul>`;
  }

  /** "By model": this week's requests by day, then each model's — or each provider's — share. */
  function byModel(scope, rows) {
    const days = weekDays(new Date(), firstDay());
    const perDay = callsByDay(rows, days);
    const most = Math.max(1, ...perDay);
    const today = new Date().toDateString();
    const columns = days
      .map((d, i) => {
        const h = perDay[i] ? Math.max(4, Math.round((perDay[i] / most) * 100)) : 3;
        const label = when(d, { weekday: 'short' });
        return `<div class="usage__day${d.toDateString() === today ? ' is-today' : ''}"><div class="usage__col" style="height:${h}%" title="${escapeHtml(`${label}: ${count(perDay[i])}`)}"></div><span>${escapeHtml(label)}</span></div>`;
      })
      .join('');
    const share = shareBy(rows, days, scope === 'all' ? 'provider' : 'model');
    const name = (n) => (scope === 'all' ? deps.meta()?.[n]?.label || n : String(n).replace(/^[^/]+\//, ''));
    const lines = share.length
      ? share
          .slice(0, 8)
          .map((s) => `<div class="usage__limit"><div class="usage__limit-text"><span class="usage__limit-label" title="${escapeHtml(s.name)}">${escapeHtml(name(s.name))}</span><span class="usage__limit-sub">${escapeHtml(t('usage.requests', { n: count(s.calls) }))}</span></div><div class="usage__bar"><span style="width:${pct(s.share)}"></span></div><span class="usage__pct">${pct(s.share)}</span></div>`)
          .join('')
      : `<p class="usage__muted">${escapeHtml(t('usage.nothingThisWeek'))}</p>`;
    return `<p class="usage__muted">${escapeHtml(t('usage.shareThisWeek'))}</p><div class="usage__days">${columns}</div>${lines}`;
  }

  /** "By device": every sign-in of this password still able to sign in, each signed out on its own. */
  function byDevice() {
    if (!view.sessions) return `<p class="usage__muted">${escapeHtml(t('common.loading'))}</p>`;
    const rows = view.sessions
      .map(
        (s) => `<div class="usage__device">
          <div class="usage__limit-text">
            <span class="usage__limit-label">${escapeHtml(s.agent || t('usage.unknownBrowser'))}${s.network ? ` <span class="usage__muted">· ${escapeHtml(s.network)}</span>` : ''}${s.current ? ` <span class="usage__badge">${escapeHtml(t('usage.thisDevice'))}</span>` : ''}</span>
            <span class="usage__limit-sub">${escapeHtml(t('usage.signedIn', { when: when(new Date(s.createdAt), { day: 'numeric', month: 'short' }) }))}</span>
          </div>
          ${s.current ? '' : `<button type="button" class="btn btn--ghost btn--small" data-sign-out="${escapeHtml(s.id)}">${escapeHtml(t('usage.signOut'))}</button>`}
        </div>`,
      )
      .join('');
    return `${rows}<p class="usage__muted">${escapeHtml(t('usage.signOutHint'))}</p>`;
  }

  /** "This week": the line about it, then the grid of hours — or the same as a table. */
  function thisWeek(rows) {
    const days = weekDays(new Date(), firstDay());
    const grid = heatmap(rows, days);
    const top = busiest(grid);
    const usual = usualDay(rows);
    const weekday = (n) => when(new Date(2026, 0, 4 + n), { weekday: 'long' }); // 4 Jan 2026 is a Sunday
    const said = top
      ? `${t('usage.heaviest', { when: t('usage.when', { day: when(days[top.day], { weekday: 'long' }), part: t(`usage.part.${top.part}`) }) })}${usual != null ? ` ${t('usage.usually', { day: weekday(usual) })}` : ''}`
      : t('usage.nothingThisWeek');
    const max = Math.max(1, ...grid.flat());
    const level = (n) => (n === 0 ? 0 : Math.min(5, Math.ceil((n / max) * 5)));
    const table = view.weekTable;
    const switcher = `<div class="usage__views"><button type="button" data-week-view="grid" aria-pressed="${!table}" aria-label="${escapeHtml(t('usage.asGrid'))}" title="${escapeHtml(t('usage.asGrid'))}">${ICON.chart}</button><button type="button" data-week-view="table" aria-pressed="${table}" aria-label="${escapeHtml(t('usage.asTable'))}" title="${escapeHtml(t('usage.asTable'))}">${ICON.table}</button></div>`;
    const body = table
      ? `<table class="usage__table"><thead><tr><th>${escapeHtml(t('usage.day'))}</th><th>${escapeHtml(t('usage.requestsLabel'))}</th><th>${escapeHtml(t('usage.busiestHour'))}</th></tr></thead><tbody>${days
          .map((d, i) => {
            const hours = grid[i];
            const total = hours.reduce((a, b) => a + b, 0);
            const peak = total ? hours.indexOf(Math.max(...hours)) : -1;
            return `<tr><td>${escapeHtml(when(d, { weekday: 'short', day: 'numeric' }))}</td><td>${count(total)}</td><td>${peak < 0 ? '—' : `${String(peak).padStart(2, '0')}:00`}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : `<div class="usage__heat" role="img" aria-label="${escapeHtml(said)}">${days
          .map(
            (d, i) =>
              `<span class="usage__heat-day">${escapeHtml(when(d, { weekday: 'short', day: 'numeric' }))}</span>${grid[i]
                .map((n, h) => `<span class="usage__cell l${level(n)}" title="${escapeHtml(`${when(d, { weekday: 'short', day: 'numeric' })} ${String(h).padStart(2, '0')}:00 — ${count(n)}`)}"></span>`)
                .join('')}`,
          )
          .join('')}<span></span>${[0, 6, 12, 18].map((h) => `<span class="usage__heat-hour" style="grid-column:${h + 2} / span 6">${escapeHtml(when(new Date(2026, 0, 1, h), { hour: 'numeric' }))}</span>`).join('')}</div>
        <div class="usage__legend"><p class="usage__muted">${escapeHtml(t('usage.heatHint'))}</p><span class="usage__muted">0</span>${[1, 2, 3, 4, 5].map((l) => `<span class="usage__cell l${l}"></span>`).join('')}<span class="usage__muted">${count(max)}</span></div>`;
    return `<p>${escapeHtml(said)}</p>${switcher}${body}`;
  }

  /** "Pace": this week so far beside last week, as a line — requests, cumulative. */
  function paceChart(rows) {
    const now = new Date();
    const p = pace(rows, now, firstDay());
    const top = Math.max(1, p.lastWeek.at(-1) || 0, p.thisWeek.at(-1) || 0);
    const W = 640;
    const H = 200;
    const x = (i) => 40 + (i / 167) * (W - 60);
    const y = (n) => H - 24 - (n / top) * (H - 44);
    const line = (list) => list.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('');
    // Not `pct`, which stops at 100: two and a half times last week is 150% more.
    const whole = (n) => count(Math.round(Math.abs(n) * 100));
    const said = p.change == null ? t('usage.paceNew') : p.change >= 0 ? t('usage.paceMore', { pct: whole(p.change) }) : t('usage.paceLess', { pct: whole(p.change) });
    const days = weekDays(now, firstDay());
    const ticks = days.map((d, i) => `<text x="${x(i * 24 + 12).toFixed(1)}" y="${H - 4}" text-anchor="middle">${escapeHtml(when(d, { weekday: 'short' }))}</text>`).join('');
    const end = p.thisWeek.length - 1;
    // Near the right edge the label goes to the dot's left, or it runs off the chart.
    const late = x(end) > W - 140;
    const labelX = late ? x(end) - 8 : x(end) + 8;
    return `<p>${escapeHtml(said)}</p><p class="usage__muted">${escapeHtml(t('usage.paceHint'))}</p>
      <svg class="usage__pace" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(said)}">
        <line x1="40" x2="${W - 20}" y1="${y(top)}" y2="${y(top)}" class="usage__grid"/><line x1="40" x2="${W - 20}" y1="${y(top / 2)}" y2="${y(top / 2)}" class="usage__grid"/><line x1="40" x2="${W - 20}" y1="${y(0)}" y2="${y(0)}" class="usage__grid"/>
        <text x="34" y="${y(top) + 4}" text-anchor="end">${count(top)}</text><text x="34" y="${y(0) + 4}" text-anchor="end">0</text>
        <path d="${line(p.lastWeek)}" class="usage__usual"/>
        <path d="${line(p.thisWeek)}L${x(end).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z" class="usage__area"/>
        <path d="${line(p.thisWeek)}" class="usage__now"/>
        <circle cx="${x(end).toFixed(1)}" cy="${y(p.thisWeek.at(-1)).toFixed(1)}" r="4" class="usage__dot"/>
        <text x="${labelX.toFixed(1)}" y="${(y(p.thisWeek.at(-1)) + (late ? 18 : 4)).toFixed(1)}" text-anchor="${late ? 'end' : 'start'}" class="usage__label">${escapeHtml(t('usage.thisWeekN', { n: count(p.thisWeek.at(-1)) }))}</text>
        <text x="${W - 20}" y="${(y(p.lastWeek.at(-1)) - 6).toFixed(1)}" text-anchor="end" class="usage__label usage__label--usual">${escapeHtml(t('usage.lastWeekN', { n: count(p.lastWeek.at(-1) || 0) }))}</text>
        ${ticks}
      </svg>`;
  }

  /** The money: what OpenRouter says each key spent and has left, and what Synapsez estimates for the rest. */
  function credits(scope) {
    const parts = [];
    if (scope === 'all' || scope === 'openrouter') {
      for (const live of view.report.live?.openrouter || []) {
        if (!live.ok) continue;
        parts.push(`<div class="usage__credit">
          <p class="usage__strong">${escapeHtml(keyName(live.index))}</p>
          <div class="usage__spend">
            <div><span class="usage__muted">${escapeHtml(t('usage.spentToday'))}</span><strong>${money(live.spend.today)}</strong></div>
            <div><span class="usage__muted">${escapeHtml(t('usage.spentWeek'))}</span><strong>${money(live.spend.week)}</strong></div>
            <div><span class="usage__muted">${escapeHtml(t('usage.spentMonth'))}</span><strong>${money(live.spend.month)}</strong></div>
          </div>
          ${live.limit ? `<p>${escapeHtml(t('usage.keyLimitLine', { left: money(live.limit.remaining), limit: money(live.limit.amount) }))}</p>` : `<p class="usage__muted">${escapeHtml(t('usage.noKeyLimit'))}</p>`}
          ${live.neverPaid === true ? `<p class="usage__muted">${escapeHtml(t('usage.neverPaid'))}</p>` : ''}
        </div>`);
      }
      parts.push(`<div class="usage__actions"><a class="btn btn--ghost btn--small" href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener">${escapeHtml(t('usage.buyCredits'))} ↗</a><span class="usage__muted">${escapeHtml(t('usage.autoTopUp'))}</span></div>`);
    }
    const rows = rowsFor(view.report.hours, scope).filter((r) => new Date(r.at) >= new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const estimate = rows.reduce((n, r) => n + (r.cost || 0), 0);
    parts.push(`<p>${escapeHtml(t('usage.estimate', { cost: money(estimate), n: count(rows.reduce((n, r) => n + r.calls, 0)) }))}</p><p class="usage__muted">${escapeHtml(t('usage.estimateHint'))}</p>`);
    return parts.join('');
  }

  function paint() {
    if (view.error) {
      host.innerHTML = `<p class="usage__note">${escapeHtml(view.error)}</p><button type="button" class="btn btn--ghost btn--small" data-refresh>${escapeHtml(t('usage.retry'))}</button>`;
      return;
    }
    if (!view.report) {
      host.innerHTML = `<p class="usage__muted">${escapeHtml(t('common.loading'))}</p>`;
      return;
    }
    const tabs = scopes();
    if (!tabs.some(([id]) => id === view.scope)) view.scope = 'all';
    const rows = rowsFor(view.report.hours, view.scope);
    const known = limits(view.scope);
    const state = standing(known.filter((l) => l.limit != null));
    const head = t(`usage.standing.${state}`);
    host.innerHTML = `<div class="usage">
      ${tabs.length > 2 ? segmented('scope', tabs, view.scope) : ''}
      <p class="usage__head">${escapeHtml(head)}</p>
      <div class="usage__limits">${known.map((l) => l.html).join('') || `<p class="usage__muted">${escapeHtml(t('usage.noLimitsKnown'))}</p>`}</div>
      <section><h4>${escapeHtml(t('usage.resetsTitle'))}</h4>${resets(view.scope)}</section>
      <section><h4>${escapeHtml(t('usage.whereTitle'))}</h4>${segmented('where', [['model', t(view.scope === 'all' ? 'usage.byProvider' : 'usage.byModel')], ['device', t('usage.byDevice')]], view.where)}<div class="usage__where">${view.where === 'device' ? byDevice() : byModel(view.scope, rows)}</div></section>
      <section><h4>${escapeHtml(t('usage.weekTitle'))}</h4>${segmented('week', [['grid', t('usage.thisWeek')], ['pace', t('usage.pace')]], view.week)}<div class="usage__week">${view.week === 'pace' ? paceChart(rows) : thisWeek(rows)}</div></section>
      <section><h4>${escapeHtml(t('usage.creditsTitle'))}</h4>${credits(view.scope)}</section>
      <footer class="usage__foot"><span class="usage__muted">${escapeHtml(t('usage.updated', { when: when(new Date(view.loadedAt), { hour: 'numeric', minute: '2-digit' }) }))}</span><button type="button" class="icon-btn" data-refresh aria-label="${escapeHtml(t('usage.refresh'))}" title="${escapeHtml(t('usage.refresh'))}">${ICON.refresh}</button><a href="${LIMITS_DOC}" target="_blank" rel="noopener">${escapeHtml(t('usage.learnLimits'))}</a></footer>
    </div>`;
  }

  async function load() {
    view.error = '';
    paint();
    try {
      view.report = await deps.load();
      view.loadedAt = Date.now();
    } catch (err) {
      view.error = err.message || t('usage.failed');
    }
    paint();
  }

  async function loadSessions() {
    try {
      view.sessions = (await deps.sessions()).sessions || [];
    } catch {
      view.sessions = [];
    }
    paint();
  }

  host.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target).closest('button');
    if (!target) return;
    if (target.dataset.scope) view.scope = target.dataset.scope;
    else if (target.dataset.where) {
      view.where = target.dataset.where;
      if (view.where === 'device') loadSessions();
    } else if (target.dataset.week) view.week = target.dataset.week;
    else if (target.dataset.weekView) view.weekTable = target.dataset.weekView === 'table';
    else if (target.hasAttribute('data-refresh')) {
      load();
      if (view.where === 'device') loadSessions();
      return;
    } else if (target.dataset.signOut) {
      target.disabled = true;
      try {
        await deps.signOut(target.dataset.signOut);
        await loadSessions();
      } catch {
        target.disabled = false;
      }
      return;
    } else return;
    paint();
  });

  return { load, paint };
}

const svg = (paths) => `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  chart: svg('<path d="M4 16V9M8.7 16V4M13.3 16v-5M18 16H2"/>'),
  table: svg('<rect x="3" y="3.5" width="14" height="13" rx="1.8"/><path d="M3 8h14M3 12.3h14M8 3.5v13"/>'),
  refresh: svg('<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16 3.5v3.2h-3.2"/>'),
};
