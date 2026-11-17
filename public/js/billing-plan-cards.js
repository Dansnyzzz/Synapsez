import { t, currentLanguage } from './i18n.js';
import { escapeHtml as esc } from './markdown.js';
import { vnd, usd } from './billing-format.js';

/**
 * The drawn parts of the plans sheet (2026-11-17): a card's icon, price block and ticked list, the
 * Team card and the rate line. Pure markup from the data it is given; what a button does, and which
 * period or tab is showing, stays in billing-plans.js.
 */

/** Claude's upgrade page is the model for the layout; the drawings are ours (nothing copied, no external image). */
const VIEW = 'viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** `n` short strokes around a centre, from radius `from` to `to`. */
function rays(n, from, to) {
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    const at = (r) => `${(12 + Math.cos(a) * r).toFixed(2)} ${(12 + Math.sin(a) * r).toFixed(2)}`;
    d += `M${at(from)}L${at(to)}`;
  }
  return `<path d="${d}"/>`;
}

/** A small line drawing per plan that grows richer with the plan: a ring, then rays, then more rays inside a halo. */
export function planIconHtml(id) {
  const body = {
    free: '<circle cx="12" cy="12" r="5"/>',
    plus: `<circle cx="12" cy="12" r="4"/>${rays(4, 7.5, 10.5)}`,
    pro: `<circle cx="12" cy="12" r="4"/>${rays(8, 7.5, 10.5)}<circle cx="12" cy="12" r="0.6"/>`,
    max: `<circle cx="12" cy="12" r="3.5"/>${rays(8, 5.8, 7.4)}${rays(8, 8.6, 10)}<circle cx="12" cy="12" r="11.2"/>`,
  }[id];
  return `<svg class="plans__icon" ${VIEW}>${body ?? ''}</svg>`;
}

const TICK = `<svg class="plans__tick" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

/** What a yearly plan saves against twelve months, in whole percent, worked out from the prices so a change of price cannot leave the badge wrong. */
export function savePercent(plan) {
  const { month, year } = plan?.usdCents || {};
  if (!(month > 0) || !(year > 0)) return 0;
  return Math.max(0, Math.round((1 - year / (month * 12)) * 100));
}

/** The price large with "/ month", then the line saying how it is paid; a yearly plan shows its monthly share large and the year's total beneath. */
export function priceHtml(id, plan, period) {
  const vi = currentLanguage() === 'vi';
  const per = esc(t('billing.per.month'));
  const big = (text) => `<p class="plans__price"><span class="plans__amount">${esc(text)}</span> <span class="plans__per">${per}</span></p>`;
  if (id === 'free') return big(vi ? vnd(0) : usd(0));
  if (!plan?.vnd) return `<p class="plans__price"><span class="plans__amount">—</span></p>`;
  const yearly = period === 'year';
  const share = yearly ? (vi ? vnd(plan.vnd.year / 12) : usd(Math.round(plan.usdCents.year / 12))) : vi ? vnd(plan.vnd.month) : usd(plan.usdCents.month);
  const line = yearly ? t('billing.plans.billedYearly', { amount: vi ? vnd(plan.vnd.year) : usd(plan.usdCents.year) }) : t('billing.plans.billedMonthly');
  // In English the đồng it is billed as stays visible: the order locks that figure.
  const billed = vi ? '' : `<p class="plans__billed">${esc(t('billing.billedAs', { vnd: vnd(plan.vnd[period]) }))}</p>`;
  return `${big(share)}<p class="plans__billed">${esc(line)}</p>${billed}`;
}

/** The "Monthly | Yearly · Save 17%" switch inside a paid card; every card shows the one state. */
export function cardToggleHtml(id, period, pct) {
  const buttons = ['month', 'year']
    .map((p) => `<button type="button" role="radio" data-period="${p}" aria-checked="${p === period}" tabindex="${p === period ? 0 : -1}"><span>${esc(t(`billing.period.${p}`))}</span>${p === 'year' && pct ? `<span class="plans__save">${esc(t('billing.plans.save', { pct }))}</span>` : ''}</button>`)
    .join('');
  return `<div class="plans__toggle" role="radiogroup" aria-label="${esc(t('billing.plans.period'))}" data-for="${id}">${buttons}</div>`;
}

/** The ticked list: a lead-in line for a paid plan ("Everything in Plus, and:"), then one tick per line. */
export function listHtml(id, lines) {
  const lead = id === 'free' ? '' : `<p class="plans__lead">${esc(t(`billing.plans.everything.${id}`))}</p>`;
  return `<hr class="plans__rule">${lead}<ul class="plans__lines">${lines.map((l) => `<li>${TICK}<span>${esc(l)}</span></li>`).join('')}</ul>`;
}

/** The one Team card: what is coming, and the button that asks to be told. The status line is always there so a change in it is announced. */
export function teamCardHtml({ noted, busy }) {
  const items = ['several', 'manage', 'seat'].map((k) => `<li>${TICK}<span>${esc(t(`billing.team.${k}`))}</span></li>`).join('');
  return `<article class="plans__card plans__card--team" aria-labelledby="plan-team-name">
      <h3 id="plan-team-name">${esc(t('billing.team.title'))}</h3>
      <p class="plans__tagline">${esc(t('billing.team.lede'))}</p>
      <ul class="plans__lines">${items}</ul>
      <button type="button" class="btn plans__cta plans__cta--paid" data-team-interest${noted || busy ? ' aria-disabled="true"' : ''}>${esc(t('billing.team.notify'))}</button>
      <p class="plans__muted plans__teamstatus" role="status">${noted ? esc(t('billing.team.noted')) : ''}</p>
    </article>`;
}

/** "06:00" and "16/11/2026" in Vietnam time whatever the interface language: the rate is read at 06:00 there, and one person reads one clock. */
export function rateStamp(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const zone = { timeZone: 'Asia/Ho_Chi_Minh' };
  return {
    time: new Intl.DateTimeFormat('en-GB', { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(when),
    date: new Intl.DateTimeFormat('en-GB', { ...zone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(when),
  };
}
