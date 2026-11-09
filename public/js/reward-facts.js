import { t, localeTag } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * What a theme or a title asks and how many have it, as the owner set it out
 * (2026-11-08): the description, then "- Nhiệm vụ / Điều kiện: …", "- Số lượng: …",
 * then, once it is held, the day it was got. One shape for the Theme page, the
 * Ranking page and the event's email.
 */

const number = (n) => Number(n || 0).toLocaleString(localeTag());
const dollars = (n) => `$${Number(n || 0).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}`;
const day = (iso) => new Date(iso).toLocaleDateString(localeTag());
/** An event's last day: its end is the midnight after it. */
const lastDay = (iso) => day(new Date(new Date(iso).getTime() - 1).toISOString());

/** @typedef {{ label: string, text: string }} Fact */

/**
 * @param {any} theme  a row of GET /api/themes
 * @param {any} [progress]  what this account has used and put in
 * @returns {Fact[]}
 */
export function themeFacts(theme, progress = null) {
  if (!theme || theme.id === 'default') return [];
  const event = theme.event;
  if (event) {
    const facts = [
      { label: t('facts.mission'), text: t('facts.useTokensBetween', { n: number(event.tokens), from: day(event.from), to: lastDay(event.to) }) },
      { label: t('facts.quantity'), text: `${t('facts.places', { n: number(event.places) })} · ${t('facts.placesLeft', { n: number(event.left) })}` },
    ];
    if (!theme.owned && event.state === 'running') facts.push({ label: t('facts.yours'), text: t('facts.eventNow', { used: number(event.used) }) });
    if (!theme.owned && event.state === 'over') facts.push({ label: t('facts.yours'), text: t('facts.eventOver') });
    return facts;
  }
  const asks = theme.asks;
  const holders = { label: t('facts.quantity'), text: t('facts.holders', { n: number(theme.holders) }) };
  if (asks?.tokens) {
    const so = !theme.owned && progress ? ` (${t('facts.soFarTokens', { n: number(progress.tokens) })})` : '';
    return [{ label: t('facts.condition'), text: `${t('facts.useTokens', { n: number(asks.tokens) })}${so}` }, holders];
  }
  if (asks?.deposit) {
    const so = !theme.owned && progress ? ` (${t('facts.soFarDeposit', { n: dollars(progress.deposited) })})` : '';
    return [{ label: t('facts.condition'), text: `${t('facts.deposit', { n: dollars(asks.deposit) })}${so}` }, holders];
  }
  const { kind, quarter, year } = theme.badge || {};
  const top = (text) => [
    { label: t('facts.condition'), text },
    { label: t('facts.quantity'), text: `${t('facts.topPlaces')} · ${t('facts.holders', { n: number(theme.holders) })}` },
  ];
  if (kind === 'top_quarter') return top(quarter && year ? t('facts.topQuarterOf', { quarter, year }) : t('facts.topQuarter'));
  if (kind === 'top_year') return top(year ? t('facts.topYearOf', { year }) : t('facts.topYear'));
  if (kind === 'exclusive_event') return [{ label: t('facts.condition'), text: t('facts.eventOnly') }, holders];
  return [holders];
}

/**
 * @param {any} title  a row of GET /api/titles
 * @param {any} [progress]
 * @returns {Fact[]}
 */
export function titleFacts(title, progress = null) {
  if (!title) return [];
  const asks = title.asks;
  let condition = t('facts.signUp');
  if (asks?.rank) condition = t('facts.rank', { rank: asks.rank });
  else if (asks?.tokens) condition = `${t('facts.useTokens', { n: number(asks.tokens) })}${!title.owned && progress ? ` (${t('facts.soFarTokens', { n: number(progress.tokens) })})` : ''}`;
  else if (asks?.deposit) condition = `${t('facts.deposit', { n: dollars(asks.deposit) })}${!title.owned && progress ? ` (${t('facts.soFarDeposit', { n: dollars(progress.deposited) })})` : ''}`;
  return [
    { label: t('facts.condition'), text: condition },
    { label: t('facts.quantity'), text: t('facts.holders', { n: number(title.holders) }) },
  ];
}

/** The day it was got, for the line under the facts; empty until it is held. */
export const gotLine = (when, kind) => (when ? t(kind === 'title' ? 'facts.gotTitle' : 'facts.gotTheme', { when: day(when) }) : '');

/** @param {Fact[]} facts */
export const factsHtml = (facts) =>
  facts.length ? `<ul class="facts">${facts.map((f) => `<li>- ${escapeHtml(f.label)}: ${escapeHtml(f.text)}</li>`).join('')}</ul>` : '';
