import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { weekDays, rowsFor, callsByDay, heatmap, shareBy, pace, busiest, usualDay, standing, knownLimits, tightest, project } from './usage-math.js';

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
 * @typedef {{ load: () => Promise<any>, sessions: () => Promise<any>, signOut: (id: string) => Promise<any>, providers: () => any, meta: () => any, user: () => any, onReport?: (report: any) => void, openKeys?: () => void }} Deps
 */

/** How often an open page asks again on its own, so what it shows keeps up with the turns. */
const LIVE_EVERY_MS = 60_000;

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
const resetAt = (date) => when(date, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const timeOf = (date) => when(date, new Date(date).toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
/** Where more of a limit can be had: credit raises the free requests to 1,000 a day; a key's own cap is set on its page. */
export const MORE = { free: 'https://openrouter.ai/settings/credits', cap: 'https://openrouter.ai/settings/keys' };

/**
 * An own OpenRouter key by its place and the last characters of it: "Key 1
 * (…7a41)" — or "Key 1, …7a41" inside a sentence that is already in brackets.
 */
export function keyLabel(index, providers, { inline = false } = {}) {
  const raw = providers?.openrouter?.keys?.[index]?.hint || '';
  // The hint already reads "…7a41".
  const hint = raw ? (raw.startsWith('…') ? raw : `…${raw}`) : '';
  return t('usage.keyN', { n: String(index + 1), hint: hint ? (inline ? `, ${hint}` : ` (${hint})`) : '' });
}

/**
 * A limit by name, as a sentence uses it: "today's free requests on OpenRouter".
 * The key is named only when there are several, where it tells them apart.
 *
 * @param {{ kind: string, index?: number }} limit
 * @param {any} providers  the account's provider status, for the keys' hints
 * @param {number} keys  how many own OpenRouter keys there are
 */
export function limitName(limit, providers, keys) {
  const key = keys > 1 && limit.index != null ? ` (${keyLabel(limit.index, providers, { inline: true })})` : '';
  return t(`usage.name.${limit.kind}`, { key });
}

/** How much of a limit, in its own unit: requests, dollars or tokens. */
export function limitAmount(limit, value) {
  return limit.unit === 'usd' ? money(value) : count(value);
}

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

  const keyName = (index) => keyLabel(index, deps.providers());

  const ownKeys = () => (view.report?.live?.openrouter || []).length;

  /** The bar for one limit: its name, when it resets, how much is used — amber from 80%, red at the limit. */
  function limitBar(l) {
    const label = l.kind === 'free' ? t('usage.freeToday', { key: keyName(l.index) }) : l.kind === 'cap' ? t('usage.keyLimit', { key: keyName(l.index) }) : t('usage.sharedMonth');
    const sub = l.to ? t('usage.resets', { when: resetAt(l.to) }) : l.interval ? t(`usage.interval.${l.interval}`) : t('usage.noReset');
    return bar({ label, sub, used: l.used, limit: l.limit, note: t('usage.ofLimit', { used: limitAmount(l, l.used), limit: limitAmount(l, l.limit) }) });
  }

  /** What the page says instead of a bar: a key that did not answer, a provider that reports no allowance. */
  function limitNotes(scope) {
    const out = [];
    if (scope === 'all' || scope === 'openrouter') {
      for (const live of view.report.live?.openrouter || []) {
        if (!live.ok) out.push(`<p class="usage__note">${escapeHtml(t(live.reason === 'rejected' ? 'usage.keyRejected' : 'usage.keyQuiet', { key: keyName(live.index) }))}</p>`);
      }
    }
    if (scope !== 'all' && scope !== 'openrouter') {
      out.push(`<p class="usage__note">${escapeHtml(t('usage.noAllowance', { provider: deps.meta()?.[scope]?.label || scope }))} <a href="${CONSOLE[scope] || '#'}" target="_blank" rel="noopener">${escapeHtml(t('usage.openConsole'))} ↗</a></p>`);
    }
    return out.join('');
  }

  /**
   * The line at the top, after Claude's "On track. You should reach this
   * week's reset with room to spare.": where the tightest limit stands, and —
   * at the pace of its period so far — whether it lasts until it resets.
   */
  function headline(known) {
    const worst = tightest(known);
    if (!worst) return { text: t(`usage.standing.${standing(known)}`), tone: '' };
    const now = new Date();
    const name = limitName(worst, deps.providers(), ownKeys());
    const share = worst.used / worst.limit;
    const resets = worst.to ? t('usage.head.resets', { when: resetAt(worst.to) }) : '';
    if (share >= 1) return { text: `${t('usage.head.out', { limit: name })}${resets ? ` ${resets}` : ''}`, tone: 'out', limit: worst };
    const ahead = project(worst, now);
    if (share >= 0.8) {
      const pace = ahead?.runsOut ? ` ${t('usage.head.paceOut', { time: timeOf(ahead.runsOut) })}` : '';
      return { text: `${t('usage.head.close', { pct: pct(share), limit: name })}${pace}${resets ? ` ${resets}` : ''}`, tone: 'close', limit: worst };
    }
    if (ahead?.runsOut) return { text: t('usage.head.willRunOut', { limit: name, time: timeOf(ahead.runsOut), when: worst.to ? resetAt(worst.to) : '' }), tone: 'close', limit: worst };
    if (ahead) return { text: t('usage.head.onTrack'), tone: '' };
    return { text: t('usage.standing.ok'), tone: '' };
  }

  /**
   * The line under it: which model most of this week's requests went to, and —
   * when it is also most of the week's cost — that a lighter one would make the
   * credit last. The same week for both: the report's rows go back two weeks,
   * not to the start of the month. Said only with enough requests for a share
   * to mean something.
   */
  function insight(rows) {
    const days = weekDays(new Date(), firstDay());
    const share = shareBy(rows, days, 'model');
    const total = share.reduce((n, s) => n + s.calls, 0);
    if (total < 3 || !share.length) return '';
    const top = share[0];
    const name = String(top.name).replace(/^[^/]+\//, '');
    let text = t('usage.insight.model', { model: name, pct: pct(top.share) });
    const week = rows.filter((r) => new Date(r.at) >= days[0]);
    const cost = week.reduce((n, r) => n + (r.cost || 0), 0);
    const mine = week.filter((r) => r.model === top.name).reduce((n, r) => n + (r.cost || 0), 0);
    if (cost >= 0.01 && mine / cost >= 0.6) text += ` ${t('usage.insight.cost', { pct: pct(mine / cost) })}`;
    return text;
  }

  /** What to do about a limit nearly or wholly used: get more of it, or stop riding the shared one. */
  function moreOf(limit) {
    if (!limit) return '';
    if (limit.kind === 'shared') return deps.openKeys ? `<div class="usage__actions"><button type="button" class="btn btn--small" data-open-keys>${escapeHtml(t('usage.addOwnKey'))}</button></div>` : '';
    return `<div class="usage__actions"><a class="btn btn--small" href="${MORE[limit.kind]}" target="_blank" rel="noopener">${escapeHtml(t('usage.getMore'))} ↗</a></div>`;
  }

  /** The resets the page knows of, soonest first, each once. */
  function resets(known) {
    const seen = new Set();
    const list = known
      .filter((l) => l.to)
      .map((l) => ({ at: l.to, what: l.kind === 'free' ? t('usage.resetFree') : l.kind === 'cap' ? t('usage.resetBudget', { key: keyName(l.index) }) : t('usage.resetShared') }))
      .filter((r) => !seen.has(r.what) && seen.add(r.what))
      .sort((a, b) => a.at - b.at);
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
    return `${rows}<p class="usage__muted usage__device-hint">${escapeHtml(t('usage.signOutHint'))}</p>`;
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
    // One control with two faces, as Claude draws it — and room between it and what it switches.
    const switcher = `<div class="usage__views" role="group" aria-label="${escapeHtml(t('usage.viewAs'))}"><button type="button" data-week-view="grid" aria-pressed="${!table}" aria-label="${escapeHtml(t('usage.asGrid'))}" title="${escapeHtml(t('usage.asGrid'))}">${ICON.chart}</button><button type="button" data-week-view="table" aria-pressed="${table}" aria-label="${escapeHtml(t('usage.asTable'))}" title="${escapeHtml(t('usage.asTable'))}">${ICON.table}</button></div>`;
    const hourName = (h) => when(new Date(2026, 0, 1, h), { hour: 'numeric' });
    // The scale is one piece: on a phone it moves under the line whole, not a square at a time.
    const legend = `<div class="usage__legend"><p class="usage__muted">${escapeHtml(t('usage.heatHint'))}</p><span class="usage__scale"><span class="usage__muted">0</span>${[0, 1, 2, 3, 4, 5].map((l) => `<span class="usage__cell l${l}"></span>`).join('')}<span class="usage__muted">${count(max)}</span></span></div>`;
    // Claude's table: a row a day, a column an hour, every count — in a box of
    // its own that scrolls both ways, the day and the hour staying in view.
    const body = table
      ? `<div class="usage__tablewrap" role="region" aria-label="${escapeHtml(t('usage.asTable'))}" tabindex="0"><table class="usage__hours"><thead><tr><th scope="col">${escapeHtml(t('usage.day'))}</th>${grid[0]
          .map((_, h) => `<th scope="col">${escapeHtml(hourName(h))}</th>`)
          .join('')}</tr></thead><tbody>${days
          .map((d, i) => `<tr><th scope="row">${escapeHtml(when(d, { weekday: 'long' }))}</th>${grid[i].map((n) => `<td${n ? '' : ' class="is-zero"'}>${count(n)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>${legend}`
      : `<div class="usage__heat" role="img" aria-label="${escapeHtml(said)}">${days
          .map(
            (d, i) =>
              `<span class="usage__heat-day">${escapeHtml(when(d, { weekday: 'short', day: 'numeric' }))}</span>${grid[i]
                .map((n, h) => `<span class="usage__cell l${level(n)}" title="${escapeHtml(`${when(d, { weekday: 'short', day: 'numeric' })} ${String(h).padStart(2, '0')}:00 — ${count(n)}`)}"></span>`)
                .join('')}`,
          )
          .join('')}<span></span>${[0, 6, 12, 18].map((h) => `<span class="usage__heat-hour" style="grid-column:${h + 2} / span 6">${escapeHtml(hourName(h))}</span>`).join('')}</div>${legend}`;
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
    const known = knownLimits(view.report, view.scope);
    const head = headline(known);
    const said = insight(rows);
    const notes = limitNotes(view.scope);
    // A repaint replaces the table; whoever was scrolled along it stays where they were.
    const box = /** @type {HTMLElement | null} */ (host.querySelector('.usage__tablewrap'));
    const scrolled = box ? [box.scrollLeft, box.scrollTop] : null;
    host.innerHTML = `<div class="usage">
      ${tabs.length > 2 ? segmented('scope', tabs, view.scope) : ''}
      <div class="usage__lead">
        <p class="usage__head${head.tone ? ` is-${head.tone}` : ''}">${escapeHtml(head.text)}</p>
        ${said ? `<p class="usage__muted usage__insight">${escapeHtml(said)}</p>` : ''}
        ${head.tone ? moreOf(head.limit) : ''}
      </div>
      <div class="usage__limits">${known.map(limitBar).join('')}${notes}${known.length || notes ? '' : `<p class="usage__muted">${escapeHtml(t('usage.noLimitsKnown'))}</p>`}</div>
      <section><h4>${escapeHtml(t('usage.resetsTitle'))}</h4>${resets(known)}</section>
      <section><h4>${escapeHtml(t('usage.whereTitle'))}</h4>${segmented('where', [['model', t(view.scope === 'all' ? 'usage.byProvider' : 'usage.byModel')], ['device', t('usage.byDevice')]], view.where)}<div class="usage__where">${view.where === 'device' ? byDevice() : byModel(view.scope, rows)}</div></section>
      <section><h4>${escapeHtml(t('usage.weekTitle'))}</h4>${segmented('week', [['grid', t('usage.thisWeek')], ['pace', t('usage.pace')]], view.week)}<div class="usage__week">${view.week === 'pace' ? paceChart(rows) : thisWeek(rows)}</div></section>
      <section><h4>${escapeHtml(t('usage.creditsTitle'))}</h4>${credits(view.scope)}</section>
      <footer class="usage__foot"><span class="usage__muted">${escapeHtml(t('usage.updated', { when: when(new Date(view.loadedAt), { hour: 'numeric', minute: '2-digit', second: '2-digit' }) }))}</span><button type="button" class="icon-btn" data-refresh aria-label="${escapeHtml(t('usage.refresh'))}" title="${escapeHtml(t('usage.refresh'))}">${ICON.refresh}</button><a href="${LIMITS_DOC}" target="_blank" rel="noopener">${escapeHtml(t('usage.learnLimits'))}</a></footer>
    </div>`;
    const again = /** @type {HTMLElement | null} */ (host.querySelector('.usage__tablewrap'));
    if (again && scrolled) [again.scrollLeft, again.scrollTop] = scrolled;
  }

  let loading = null;
  async function load() {
    // Asked twice at once — a tab opened as the minute came round — one request.
    if (loading) return loading;
    view.error = '';
    if (!view.report) paint();
    loading = (async () => {
      try {
        view.report = await deps.load();
        view.loadedAt = Date.now();
        deps.onReport?.(view.report);
      } catch (err) {
        // A page already showing figures keeps them; only a first load shows the failure.
        if (!view.report) view.error = err.message || t('usage.failed');
      }
      paint();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  // While the page is on screen, it keeps up on its own: asked again each
  // minute, and as soon as it is looked at after longer than that.
  const visible = () => document.visibilityState === 'visible' && !!host.offsetParent;
  const stale = () => Date.now() - view.loadedAt >= LIVE_EVERY_MS;
  setInterval(() => {
    if (view.report && visible() && stale()) load();
  }, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (view.report && visible() && stale()) load();
  });

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
    else if (target.hasAttribute('data-open-keys')) {
      deps.openKeys?.();
      return;
    } else if (target.hasAttribute('data-refresh')) {
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
