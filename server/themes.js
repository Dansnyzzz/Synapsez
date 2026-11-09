import { withMarkup } from './pricing.js';
import { getPrefs, setPrefs } from './settings.js';
import { getStore } from './store/index.js';
import { log } from './util/trace.js';

/**
 * Themes, ranking and titles (owner, 2026-11-04).
 *
 * Who holds what and why is decided here. How a theme looks is the browser's
 * (`public/js/scenes.js`), and a test holds the two catalogues together. The
 * contract the browser reads is docs/superpowers/specs/2026-11-04-themes-ranking-contract.md.
 *
 * Administrators hold every theme and are on no board: they can see any look
 * without earning it, and they should not win the prizes they hand out.
 */

/**
 * @typedef {{ kind: string, quarter: number|null, year: number|null }} Badge
 * @typedef {{ id: string, role?: string, created_at?: any }} Account
 * @typedef {{ id: string, from: string, to: string, tokens: number, places: number }} ThemeEvent  an event a theme is the prize of
 */

export const BADGE_KINDS = ['none', 'exclusive_event', 'achievement', 'top_quarter', 'top_year'];

const blank = (kind) => ({ kind, quarter: null, year: null });
const topOf = (year, quarter) => ({ kind: 'top_quarter', quarter, year });
const topYear = (year) => ({ kind: 'top_year', quarter: null, year });

/**
 * The fireworks (owner, 2026-11-06): whoever uses this many tokens between the first
 * and the seventh of January 2027, Vietnam's time, while there are places left. At
 * about 30,000 tokens a request (measured on an empty conversation with the full tool
 * catalogue) that is some seventy requests, ten a day: real use through the week, and
 * within the free tier's 50 a day. A place goes to whoever gets there first, which is
 * why the end of a turn looks as well as the page (`afterTurn`).
 */
export const NEW_YEAR_EVENT = Object.freeze({
  id: 'new-year-2027',
  from: '2027-01-01T00:00:00+07:00',
  to: '2027-01-08T00:00:00+07:00',
  tokens: 2_000_000,
  places: 100,
});

/** The aurora (owner, 2026-11-08): Christmas week to the last night of the year, on the fireworks' terms. */
export const AURORA_EVENT = Object.freeze({
  id: 'aurora-2026',
  from: '2026-12-24T00:00:00+07:00',
  to: '2027-01-01T00:00:00+07:00',
  tokens: 2_000_000,
  places: 100,
});

/** An event's theme is shown this long before it starts (owner, 2026-11-08), and its email goes then. */
export const EVENT_LEAD_MS = 3 * 24 * 3_600_000;

/** When a theme first came out, for those with no date of their own (the sort "newest first"). */
const RELEASED = { first: '2026-11-04T00:00:00+07:00', second: '2026-11-07T00:00:00+07:00' };

/**
 * Display order among locked themes. `tokens` or `spend`: what earns an achievement
 * theme, if that is its badge, each landing on a title of the same size (`TITLES`).
 * Every quarter and year to the end of 2027 has a theme of its own; the two carrying
 * no date are the standing prizes for any period nobody has named one for yet.
 */
export const THEMES = Object.freeze([
  { id: 'default', badge: blank('none') },
  { id: 'cloud-drift', badge: blank('achievement'), tokens: 100_000, released: RELEASED.first },
  { id: 'moon-night', badge: blank('achievement'), tokens: 1_000_000, released: RELEASED.first },
  { id: 'lagoon', badge: blank('achievement'), tokens: 10_000_000, released: RELEASED.first },
  { id: 'firefly-grove', badge: blank('achievement'), tokens: 50_000_000, released: RELEASED.first },
  { id: 'deep-sea', badge: blank('achievement'), tokens: 100_000_000, released: RELEASED.first },
  { id: 'nebula-voyage', badge: blank('achievement'), tokens: 1_000_000_000, released: RELEASED.second },
  { id: 'rainy-cafe', badge: blank('achievement'), spend: 10, released: RELEASED.second },
  { id: 'golden-harbor', badge: blank('achievement'), spend: 100, released: RELEASED.second },
  { id: 'crystal-palace', badge: blank('achievement'), spend: 1_000, released: RELEASED.second },
  { id: 'new-year-fireworks', badge: blank('exclusive_event'), event: NEW_YEAR_EVENT },
  { id: 'aurora-peak', badge: blank('exclusive_event'), event: AURORA_EVENT },
  { id: 'snow-village', badge: topOf(2026, 4) },
  { id: 'tet-spring', badge: topOf(2027, 1) },
  { id: 'phoenix-summer', badge: topOf(2027, 2) },
  { id: 'mid-autumn', badge: topOf(2027, 3) },
  { id: 'maple-river', badge: topOf(2027, 4) },
  { id: 'golden-horse', badge: topYear(2026) },
  { id: 'goat-terrace', badge: topYear(2027) },
  { id: 'sakura-crossing', badge: blank('top_quarter'), released: RELEASED.first },
  { id: 'rose-street', badge: blank('top_year'), released: RELEASED.first },
]);
const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** Earned from lifetime usage. `newcomer` needs nothing: everyone has something to wear. */
export const TITLES = Object.freeze([
  { id: 'newcomer' },
  { id: 'tokens-1m', tokens: 1_000_000 },
  { id: 'tokens-10m', tokens: 10_000_000 },
  { id: 'tokens-100m', tokens: 100_000_000 },
  { id: 'tokens-1b', tokens: 1_000_000_000 },
  { id: 'spend-10', spend: 10 },
  { id: 'spend-100', spend: 100 },
  { id: 'spend-1000', spend: 1_000 },
]);
const TITLE_BY_ID = new Map(TITLES.map((t) => [t.id, t]));

const isAdmin = (user) => user?.role === 'admin';

/**
 * The periods turn at midnight in Vietnam (owner, 2026-11-08: "00h00, 1/1/2027"), which
 * keeps no summer time, so a fixed offset is exact. A theme for a period appears at the
 * same moment the period's boards start.
 */
export const PERIOD_OFFSET_MS = 7 * 3_600_000;
/** The calendar as Vietnam reads it, through the UTC getters. @param {Date} when */
const local = (when) => new Date(when.getTime() + PERIOD_OFFSET_MS);
/** Midnight in Vietnam on the first of a month. */
const monthStart = (year, month) => new Date(Date.UTC(year, month, 1) - PERIOD_OFFSET_MS);

/**
 * Usage before this does not count: nobody was competing, and nobody should wake up
 * with a prize for it. The first board is the rest of the last quarter of 2026.
 */
export const RANKING_STARTS = monthStart(2026, 10);

/** How far back the period picker reaches. */
const MAX_PERIODS = 24;

export const SCOPES = ['quarter', 'year'];

/** @param {Date} when */
const quarterOf = (when) => Math.floor(local(when).getUTCMonth() / 3) + 1;
/** @param {Date} when */
const yearOf = (when) => local(when).getUTCFullYear();

/** @param {'quarter'|'year'} scope @param {Date} [when] */
export const periodKey = (scope, when = new Date()) => (scope === 'year' ? String(yearOf(when)) : `${yearOf(when)}-Q${quarterOf(when)}`);

/**
 * When a period starts and ends (midnight in Vietnam), from when ranking began at the earliest. Null
 * for anything that is not one.
 *
 * @param {string} scope @param {string} key
 */
export function periodRange(scope, key) {
  const match = scope === 'year' ? /^(\d{4})$/.exec(String(key)) : scope === 'quarter' ? /^(\d{4})-Q([1-4])$/.exec(String(key)) : null;
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 2000 || year > 2200) return null;
  const firstMonth = scope === 'year' ? 0 : (Number(match[2]) - 1) * 3;
  const from = monthStart(year, firstMonth);
  const to = scope === 'year' ? monthStart(year + 1, 0) : monthStart(year, firstMonth + 3);
  return { from: from < RANKING_STARTS ? RANKING_STARTS : from, to };
}

/**
 * The periods that have closed since ranking began, oldest first.
 *
 * @param {Date} [now]
 * @returns {{ scope: 'quarter'|'year', key: string }[]}
 */
export function closedPeriods(now = new Date()) {
  /** @type {{ scope: 'quarter'|'year', key: string }[]} */
  const out = [];
  const start = yearOf(RANKING_STARTS) * 4 + quarterOf(RANKING_STARTS) - 1;
  const current = yearOf(now) * 4 + quarterOf(now) - 1;
  for (let at = start; at < current; at += 1) out.push({ scope: 'quarter', key: `${Math.floor(at / 4)}-Q${(at % 4) + 1}` });
  for (let year = yearOf(RANKING_STARTS); year < yearOf(now); year += 1) out.push({ scope: 'year', key: String(year) });
  return out;
}

/**
 * The periods the picker offers, newest first.
 *
 * @param {'quarter'|'year'} scope @param {Date} [now]
 */
export function periodKeys(scope, now = new Date()) {
  const keys = [periodKey(scope, now), ...closedPeriods(now).filter((p) => p.scope === scope).map((p) => p.key).reverse()];
  return keys.slice(0, MAX_PERIODS);
}

/**
 * One board from the period's rows: highest first, ties to whoever got there
 * first, nobody with nothing on it. `first_at` is what breaks a tie, so the order
 * does not change between two readings.
 *
 * @param {{ id: string, tokens: number, cost: number, first_at?: any }[]} rows
 * @param {'tokens'|'spend'} board
 * @returns {{ id: string, value: number }[]}
 */
export function rankBoard(rows, board) {
  const value = (row) => (board === 'spend' ? withMarkup(Number(row.cost) || 0) : Number(row.tokens) || 0);
  return [...rows]
    .filter((row) => value(row) > 0)
    .sort((a, b) => value(b) - value(a) || new Date(a.first_at || 0).getTime() - new Date(b.first_at || 0).getTime() || String(a.id).localeCompare(String(b.id)))
    .map((row) => ({ id: row.id, value: value(row) }));
}

/** Three people win. */
export const TOP = 3;
/** Ten are shown (owner, 2026-11-06). */
export const SHOWN = 10;

/** What an award title's id says. */
const AWARD = /^top:(tokens|spend):(quarter|year):(\d{4}(?:-Q[1-4])?):([123])$/;

/** @param {string} board @param {string} scope @param {string} key @param {number} rank */
export const awardId = (board, scope, key, rank) => `top:${board}:${scope}:${key}:${rank}`;

/**
 * A title as the browser draws it, or null for an id that is not one.
 *
 * @param {string} id
 */
export function titleInfo(id) {
  const award = AWARD.exec(String(id || ''));
  if (award) return { id, kind: 'award', board: award[1], scope: award[2], key: award[3], rank: Number(award[4]) };
  return TITLE_BY_ID.has(id) ? { id, kind: 'catalog' } : null;
}

/**
 * A badge as an administrator sent it, checked.
 *
 * @param {any} body
 * @returns {Badge}  throws a sentence for anything else
 */
export function cleanBadge(body) {
  const kind = String(body?.kind ?? '');
  if (!BADGE_KINDS.includes(kind)) throw new Error(`A badge is one of: ${BADGE_KINDS.join(', ')}.`);
  if (kind !== 'top_quarter' && kind !== 'top_year') return blank(kind);
  const number = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
  const year = number(body?.year);
  const quarter = kind === 'top_quarter' ? number(body?.quarter) : null;
  if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2200)) throw new Error('That is not a year this can use.');
  if (quarter !== null && (!Number.isInteger(quarter) || quarter < 1 || quarter > 4)) throw new Error('A quarter is a number from 1 to 4.');
  if (quarter !== null && year === null) throw new Error('Say which year that quarter is in.');
  return { kind, quarter, year: kind === 'top_quarter' && quarter === null ? null : year };
}

/**
 * Which themes a closing period gives: those carrying exactly that period, or
 * else those carrying "any". An administrator naming a quarter takes it over from
 * the standing prize, without having to touch the standing prize.
 *
 * @param {Map<string, Badge>} badges
 * @param {'quarter'|'year'} scope @param {string} key
 * @returns {string[]}
 */
export function rewardThemes(badges, scope, key) {
  const kind = scope === 'year' ? 'top_year' : 'top_quarter';
  const year = Number(String(key).slice(0, 4));
  const quarter = scope === 'quarter' ? Number(String(key).slice(6)) : null;
  const carrying = [...badges].filter(([, b]) => b.kind === kind);
  const exact = carrying.filter(([, b]) => b.year === year && (scope === 'year' || b.quarter === quarter));
  return (exact.length ? exact : carrying.filter(([, b]) => b.year === null)).map(([id]) => id);
}

/** Each theme's badge: an administrator's choice over the catalogue's. */
export async function themeBadges(store = getStore()) {
  const stored = new Map((await store.listThemeBadges()).map((row) => [row.theme_id, row]));
  return new Map(
    THEMES.map((theme) => {
      const row = stored.get(theme.id);
      return [theme.id, row ? { kind: row.kind, quarter: row.quarter ?? null, year: row.year ?? null } : theme.badge];
    }),
  );
}

/** The period's usage, read at most once a minute: a page anyone can open should not be able to walk the table. */
const ROWS_MS = 60_000;
/** @type {Map<string, { at: number, rows: any[] }>} */
const rowsCache = new Map();

async function periodRows(scope, key, store) {
  const cacheKey = `${scope}:${key}`;
  const held = rowsCache.get(cacheKey);
  if (held && Date.now() - held.at < ROWS_MS) return held.rows;
  const range = periodRange(scope, key);
  const rows = range ? await store.rankingRows(range.from, range.to) : [];
  rowsCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

/** The quarter this instance last settled up to, so an ordinary read costs no query. */
let settledThrough = null;
/** After a failure, how long before another read may try again: a broken period must not cost every page its aggregates. */
const SETTLE_RETRY_MS = 5 * 60_000;
let settleFailedAt = 0;

/**
 * Give out one closed period's prizes.
 *
 * Prizes first and the mark last, and every write safe to repeat: two instances
 * doing this at once, or one cut off half way, end up in the same place.
 *
 * @param {'quarter'|'year'} scope @param {string} key
 */
export async function settlePeriod(scope, key, { store = getStore() } = {}) {
  const range = periodRange(scope, key);
  if (!range) return;
  const rows = await store.rankingRows(range.from, range.to);
  const badges = await themeBadges(store);
  const prizes = rewardThemes(badges, scope, key);
  const grant = { kind: scope === 'year' ? 'top_year' : 'top_quarter', year: Number(key.slice(0, 4)), quarter: scope === 'quarter' ? Number(key.slice(6)) : null };
  for (const board of /** @type {('tokens'|'spend')[]} */ (['tokens', 'spend'])) {
    const shown = rankBoard(rows, board).slice(0, SHOWN);
    for (const [i, person] of shown.entries()) {
      const rank = i + 1;
      await store.saveBoardRow(scope, key, board, rank, person.id, person.value);
      if (rank > TOP) continue;
      await store.grantTitle(person.id, awardId(board, scope, key, rank));
      for (const themeId of prizes) await store.grantTheme(person.id, themeId, grant);
    }
  }
  await store.markPeriodSettled(scope, key);
}

/** Close whatever has closed. Runs on the first read of a new quarter, on any instance. */
export async function settleClosed({ store = getStore(), now = new Date() } = {}) {
  const stamp = periodKey('quarter', now);
  if (settledThrough === stamp || Date.now() - settleFailedAt < SETTLE_RETRY_MS) return;
  // A prize that cannot go out yet is no reason for somebody's Theme page not to open.
  try {
    const done = new Set((await store.listSettledPeriods()).map((row) => `${row.scope}:${row.period}`));
    for (const { scope, key } of closedPeriods(now)) {
      if (!done.has(`${scope}:${key}`)) await settlePeriod(scope, key, { store });
    }
    settledThrough = stamp;
    settleFailedAt = 0;
  } catch (err) {
    settleFailedAt = Date.now();
    log.error('ranking period could not be settled', err);
  }
}

/**
 * What the boards call somebody: the name they go by, never what they sign in with.
 * A username or an email's first half on a public list is half of a login, and is what
 * a name is by default when none was given (auth.js), so those read as "A member".
 *
 * @param {{ name?: string|null, username?: string|null, email?: string|null } | undefined} person
 */
function publicName(person) {
  const name = String(person?.name || '').trim();
  const same = name.toLowerCase();
  if (!name || same === String(person?.username || '').toLowerCase() || same === String(person?.email || '').split('@')[0].toLowerCase()) return null;
  return name;
}

/**
 * When a theme comes out, for the person who has not got it: an event's three days
 * before it starts, a period's own at its first midnight (owner, 2026-11-08: Q2 is not
 * shown in Q1), the rest on the day they were drawn. Null means it has always been out.
 *
 * @param {any} theme @param {Badge} badge
 * @returns {Date|null}
 */
export function appearsAt(theme, badge) {
  if (theme.event) return new Date(new Date(theme.event.from).getTime() - EVENT_LEAD_MS);
  if (badge.kind === 'top_quarter' && badge.year && badge.quarter) return monthStart(badge.year, (badge.quarter - 1) * 3);
  if (badge.kind === 'top_year' && badge.year) return monthStart(badge.year, 0);
  return theme.released ? new Date(theme.released) : null;
}

/**
 * The sponsor titles and their themes count money put in here, not spent at a provider (owner,
 * 2026-11-08). A title with no mark is everybody's (newcomer); a theme with none is earned by
 * nothing, so an administrator making a prize an achievement does not hand it to everyone.
 */
const earnedBy = (thing, life, deposited, { title = false } = {}) => (thing.tokens ? life.tokens >= thing.tokens : thing.spend ? deposited >= thing.spend : title);

/** A worn title as the boards show it: a sponsor's only with the money behind it. */
function wornTitle(id, deposited) {
  const entry = TITLE_BY_ID.get(id);
  return entry?.spend && deposited < entry.spend ? null : titleInfo(id);
}

/**
 * Whether a held row still counts: a sponsor title or theme given for spending at a
 * provider, before the rule was money put in, waits for a top-up. Kept, not deleted.
 */
const stillHeld = (thing, row, deposited) => !(thing?.spend && deposited < thing.spend && (!row?.grant_kind || (row.grant_kind === 'achievement' && !row.by_hand)));

/**
 * An event's place, if this person has earned one and there is one left. Worked out
 * from what they used inside the event's dates, so nothing has to watch the week.
 *
 * @param {Account} user @param {ThemeEvent} event @param {any} store @param {Date} now
 * @returns {Promise<boolean>} whether they hold a place now
 */
async function claimEvent(user, event, store, now) {
  if (isAdmin(user) || now < new Date(event.from)) return false;
  // A place taken is theirs whenever they next look, even if the grant that should have
  // followed it was cut short and the week has since ended.
  if ((await store.eventPlaceOf(event.id, user.id)) !== null) return true;
  if (now >= new Date(event.to)) return false;
  const used = await store.usageTokensBetween(user.id, new Date(event.from), new Date(event.to));
  if (used < event.tokens) return false;
  return (await store.claimEventPlace(event.id, user.id, event.places)) !== null;
}

/**
 * Give this person what their usage has earned. Asked when they look, so nothing
 * has to watch every account; an earned thing is kept, so pruning old usage can
 * never take one away.
 *
 * @param {Account} user
 * @param {any} store
 * @param {Date} [now]
 */
async function syncEarned(user, store, now = new Date()) {
  const [life, deposited] = await Promise.all([store.lifetimeUsage(user.id), store.topUpTotal ? store.topUpTotal(user.id) : 0]);
  const heldTitles = await store.listUserTitles(user.id);
  const titles = new Set(heldTitles.map((row) => row.title_id));
  let changed = false;
  /** What this look gave, newest-hardest last: worn at once (owner, 2026-11-08). */
  const newly = { titles: /** @type {string[]} */ ([]), themes: /** @type {string[]} */ ([]) };
  for (const title of TITLES) {
    if (earnedBy(title, life, deposited, { title: true }) && !titles.has(title.id)) {
      await store.grantTitle(user.id, title.id);
      newly.titles.push(title.id);
      changed = true;
    }
  }
  const badges = await themeBadges(store);
  const heldThemes = await store.listUserThemes(user.id);
  // One an administrator took back stays taken: the usage that earned it is still there.
  const taken = await store.listRevokedThemes(user.id);
  const themes = new Set([...heldThemes, ...taken].map((row) => row.theme_id));
  for (const theme of THEMES) {
    if (themes.has(theme.id)) continue;
    if (theme.event) {
      if (await claimEvent(user, theme.event, store, now)) {
        await store.grantTheme(user.id, theme.id, blank('exclusive_event'));
        newly.themes.push(theme.id);
        changed = true;
      }
      continue;
    }
    if (!earnedBy(theme, life, deposited) || badges.get(theme.id)?.kind !== 'achievement') continue;
    await store.grantTheme(user.id, theme.id, blank('achievement'));
    newly.themes.push(theme.id);
    changed = true;
  }
  // The newest thing earned is put on, a newcomer's first title excepted (it is everybody's).
  const wear = {};
  const worn = TITLE_BY_ID.get((await getPrefs(user.id)).equippedTitle);
  if (worn?.spend && deposited < worn.spend) wear.equippedTitle = null;
  const title = newly.titles.filter((id) => id !== 'newcomer').at(-1);
  if (title) wear.equippedTitle = title;
  if (newly.themes.length) wear.sceneTheme = newly.themes.at(-1);
  if (Object.keys(wear).length) await setPrefs(user.id, wear).catch((err) => log.error('earned, not worn', err));
  return {
    badges,
    newly: { ...newly, worn: wear },
    progress: { tokens: life.tokens, spend: withMarkup(life.cost), deposited },
    heldThemes: changed ? await store.listUserThemes(user.id) : heldThemes,
    heldTitles: changed ? await store.listUserTitles(user.id) : heldTitles,
  };
}

/** Each account's next mark, so the end of a turn asks the database once and gives only on crossing it. */
const nextMark = new Map();
const MARKS = [...new Set([...TITLES, ...THEMES].map((t) => t.tokens).filter(Boolean))].sort((a, b) => a - b);

/**
 * The end of a turn, during an event's week: a person who gets there with the page
 * open, and looks only after the week is over, got there all the same. Costs nothing
 * on any other day of the year.
 *
 * @param {Account} user @param {{ store?: any, now?: Date }} [options]
 */
export async function afterTurn(user, { store = getStore(), now = new Date() } = {}) {
  const running = THEMES.some((theme) => theme.event && now >= new Date(theme.event.from) && now < new Date(theme.event.to));
  if (!running) {
    // Anything earned by usage is earned at the end of a turn, not at the next page load
    // (owner, 2026-11-08): one sum a turn, and the rest only when a mark is crossed.
    const { tokens } = await store.lifetimeUsage(user.id);
    const mark = nextMark.get(user.id);
    if (mark !== undefined && tokens < mark) return null;
    const { newly } = await syncEarned(user, store, now);
    nextMark.set(user.id, MARKS.find((m) => m > tokens) ?? Infinity);
    if (nextMark.size > 5000) nextMark.delete(nextMark.keys().next().value);
    return newly.titles.length || newly.themes.length ? newly : null;
  }
  const { newly } = await syncEarned(user, store, now);
  return newly.titles.length || newly.themes.length ? newly : null;
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** How many of an event's places are left, for an email that is nobody's in particular. */
export async function eventStandingFor(event, store, now = new Date()) {
  const taken = await store.eventPlacesTaken(event.id);
  return { left: Math.max(0, event.places - taken), state: now < new Date(event.from) ? 'soon' : now < new Date(event.to) ? 'running' : 'over' };
}

/**
 * What an event asks and how it stands, for the page that says so.
 *
 * @param {Account} user @param {ThemeEvent} event @param {any} store @param {Date} now
 */
async function eventStanding(user, event, store, now) {
  const running = now >= new Date(event.from) && now < new Date(event.to);
  const [taken, used] = await Promise.all([
    store.eventPlacesTaken(event.id),
    running ? store.usageTokensBetween(user.id, new Date(event.from), new Date(event.to)) : 0,
  ]);
  return { from: event.from, to: event.to, tokens: event.tokens, places: event.places, left: Math.max(0, event.places - taken), used, state: now < new Date(event.from) ? 'soon' : running ? 'running' : 'over' };
}

/**
 * The Theme page: held themes first, newest first; then locked ones in catalogue order.
 *
 * @param {Account} user
 * @param {{ store?: any, now?: Date }} [options]
 */
export async function listThemes(user, { store = getStore(), now = new Date() } = {}) {
  await settleClosed({ store, now });
  const { badges, heldThemes, progress } = await syncEarned(user, store, now);
  const held = new Map(heldThemes.map((row) => [row.theme_id, row]));
  const admin = isAdmin(user);
  const holders = new Map((await store.themeHolderCounts()).map((row) => [row.theme_id, Number(row.holders)]));
  const rows = await Promise.all(
    THEMES.map(async (theme) => {
      const row = held.get(theme.id);
      const badge = badges.get(theme.id) || theme.badge;
      const out = appearsAt(theme, badge);
      // Not out yet: an administrator sees the whole collection ahead of time, nobody else does (owner, 2026-11-08).
      if (!admin && !row && out && out > now) return null;
      const owned = admin || theme.id === 'default' || (!!row && stillHeld(theme, row, progress.deposited));
      const earns = !owned && badge.kind === 'achievement';
      return {
        id: theme.id,
        badge,
        owned,
        released: out ? out.toISOString() : null,
        holders: theme.spend ? await store.topUpHolders(theme.spend) : holders.get(theme.id) || 0,
        grantedAt: theme.id === 'default' ? iso(user.created_at) : owned ? iso(row?.granted_at) : null,
        grant: row ? { kind: row.grant_kind, quarter: row.grant_quarter ?? null, year: row.grant_year ?? null } : null,
        // What earns it, said whether or not it is held: the page describes every theme the same way.
        asks: theme.tokens ? { tokens: theme.tokens } : theme.spend ? { deposit: theme.spend } : null,
        event: theme.event ? await eventStanding(user, theme.event, store, now) : null,
        needs: earns && theme.tokens ? { tokens: theme.tokens } : earns && theme.spend ? { deposit: theme.spend } : !owned && theme.event ? { event: await eventStanding(user, theme.event, store, now) } : null,
      };
    }),
  ).then((all) => all.filter(Boolean));
  const time = (row) => (row.grantedAt ? new Date(row.grantedAt).getTime() : 0);
  // Stable: an administrator's blanket access stays in catalogue order.
  const themes = [...rows.filter((r) => r.owned).sort((a, b) => time(b) - time(a)), ...rows.filter((r) => !r.owned)];
  const prefs = await getPrefs(user.id);
  const selected = themes.some((t) => t.id === prefs.sceneTheme && t.owned) ? prefs.sceneTheme : 'default';
  return { selected, isAdmin: admin, themes, progress };
}

/** An error the route says as it is. */
const refuse = (status, message) => Object.assign(new Error(message), { status });

/**
 * Whether this account holds a theme, for wearing it. The only question the save
 * asks, so a press does not wait on everything the page draws: what a read of the
 * page would earn or settle is the read's to do.
 */
async function holdsTheme(user, id, store) {
  if (id === 'default' || isAdmin(user)) return true;
  const row = (await store.listUserThemes(user.id)).find((held) => held.theme_id === id);
  if (!row) return false;
  const theme = THEME_BY_ID.get(id);
  return !theme?.spend || stillHeld(theme, row, await store.topUpTotal(user.id));
}

/** @param {Account} user @param {string} id */
export async function selectTheme(user, id, { store = getStore() } = {}) {
  if (!THEME_BY_ID.has(id)) throw refuse(400, 'There is no such theme.');
  if (!(await holdsTheme(user, id, store))) throw refuse(403, 'You do not hold that theme yet.');
  await setPrefs(user.id, { sceneTheme: id });
  return { selected: id };
}

/**
 * Titles: held first, newest first; then the catalogue's locked ones.
 *
 * @param {Account} user
 */
export async function listTitles(user, { store = getStore() } = {}) {
  await settleClosed({ store });
  const { heldTitles, progress } = await syncEarned(user, store);
  const admin = isAdmin(user);
  const counts = new Map((await store.titleHolderCounts()).map((row) => [row.title_id, Number(row.holders)]));
  /** How many hold it, the sponsors' counted from top-ups like the titles themselves. */
  const holdersOf = async (title) => {
    const entry = TITLE_BY_ID.get(title.id);
    if (entry?.spend) return store.topUpHolders(entry.spend);
    return counts.get(title.kind === 'award' || title.kind === 'rank' ? `rank-${title.rank}` : title.id) || 0;
  };
  /** What a title asks, said whether or not it is held. */
  const asksOf = (title) => {
    const entry = TITLE_BY_ID.get(title.id);
    if (title.kind === 'award' || title.kind === 'rank') return { rank: title.rank };
    return entry?.tokens ? { tokens: entry.tokens } : entry?.spend ? { deposit: entry.spend } : null;
  };
  const held = heldTitles
    .map((row) => ({ ...titleInfo(row.title_id), owned: true, earnedAt: iso(row.earned_at), needs: null }))
    // A sponsor title given for spending at a provider waits for a top-up (owner, 2026-11-08).
    .filter((t) => t.id && (admin || stillHeld(TITLE_BY_ID.get(t.id), {}, progress.deposited)))
    .sort((a, b) => new Date(b.earnedAt || 0).getTime() - new Date(a.earnedAt || 0).getTime());
  const heldIds = new Set(held.map((t) => t.id));
  const rest = TITLES.filter((t) => !heldIds.has(t.id)).map((t) => ({
    id: t.id,
    kind: 'catalog',
    owned: admin,
    earnedAt: null,
    needs: admin ? null : t.tokens ? { tokens: t.tokens } : t.spend ? { deposit: t.spend } : null,
  }));
  // Each place's title, to be looked at: the real ones name a board and a period, and only exist once won.
  const won = new Set(held.filter((t) => t.kind === 'award').map((t) => t.rank));
  const places = [1, 2, 3].filter((rank) => !won.has(rank)).map((rank) => ({ id: `rank-${rank}`, kind: 'rank', rank, owned: false, earnedAt: null, needs: { rank } }));
  for (const title of [...held, ...rest, ...places]) {
    title.asks = asksOf(title);
    title.holders = await holdersOf(title);
  }
  const prefs = await getPrefs(user.id);
  const titles = [...held, ...rest, ...places];
  const equipped = titles.some((t) => t.id === prefs.equippedTitle && t.owned) ? prefs.equippedTitle : null;
  return { equipped, titles, progress };
}

/** @param {Account} user @param {string|null} id */
export async function equipTitle(user, id, { store = getStore() } = {}) {
  if (id === null) {
    await setPrefs(user.id, { equippedTitle: null });
    return { equipped: null };
  }
  // Only what the save needs, like a theme's: a press does not wait on the whole page.
  const title = titleInfo(id);
  if (!title) throw refuse(400, 'There is no such title.');
  const entry = TITLE_BY_ID.get(id);
  const held = (await store.listUserTitles(user.id)).some((row) => row.title_id === id) && (!entry?.spend || stillHeld(entry, {}, await store.topUpTotal(user.id)));
  if (!held && !(isAdmin(user) && title.kind === 'catalog')) throw refuse(403, 'You have not earned that title yet.');
  await setPrefs(user.id, { equippedTitle: id });
  return { equipped: id };
}

/**
 * One period's boards.
 *
 * A closed period reads what was given out, so a board cannot change after the
 * prizes went: not by an account being deleted, not by old usage being pruned. An
 * account's name and title are read as they are now, because that is theirs to
 * change; only its name is ever shown, and not even that if they asked.
 *
 * @param {Account} user
 * @param {{ scope?: string, key?: string, store?: any, now?: Date }} [options]
 */
export async function ranking(user, { scope = 'quarter', key, store = getStore(), now = new Date() } = {}) {
  if (!SCOPES.includes(scope)) throw refuse(400, 'A ranking is by quarter or by year.');
  const period = /** @type {'quarter'|'year'} */ (scope);
  const keys = periodKeys(period, now);
  const wanted = key === undefined || key === '' ? keys[0] : String(key);
  if (!keys.includes(wanted)) throw refuse(400, 'There is no ranking for that period.');
  await settleClosed({ store, now });
  const range = periodRange(period, wanted);
  const settled = wanted !== keys[0];
  const rows = await periodRows(period, wanted, store);
  const live = { tokens: rankBoard(rows, 'tokens'), spend: rankBoard(rows, 'spend') };
  const kept = settled ? await store.settledBoard(period, wanted) : [];
  const top = (board) =>
    settled
      ? kept.filter((r) => r.board === board && r.user_id).sort((a, b) => a.rank - b.rank).map((r) => ({ id: r.user_id, rank: r.rank, value: Number(r.value) }))
      : live[board].slice(0, SHOWN).map((r, i) => ({ ...r, rank: i + 1 }));
  const boards = { tokens: top('tokens'), spend: top('spend') };
  const people = new Map((await store.boardPeople([...new Set([...boards.tokens, ...boards.spend].map((r) => r.id))])).map((p) => [p.id, p]));
  const draw = (r) => {
    const person = people.get(r.id);
    const shown = person?.prefs?.rankAnonymous !== true;
    return {
      rank: r.rank,
      name: shown ? publicName(person) : null,
      title: wornTitle(person?.prefs?.equippedTitle, Number(person?.deposited) || 0),
      value: r.value,
      isMe: r.id === user.id,
    };
  };
  const excluded = isAdmin(user);
  const place = (board) => {
    const at = live[board].findIndex((r) => r.id === user.id);
    return excluded ? { rank: null, value: 0 } : { rank: at < 0 ? null : at + 1, value: at < 0 ? 0 : live[board][at].value };
  };
  const prefs = await getPrefs(user.id);
  return {
    scope: period,
    key: wanted,
    keys,
    closes: iso(range?.to),
    settled,
    tokens: boards.tokens.map(draw),
    spend: boards.spend.map(draw),
    me: { excluded, anonymous: prefs.rankAnonymous === true, tokens: place('tokens'), spend: place('spend') },
  };
}

/** The administration list: each theme, its badge, and how many hold it. */
export async function adminThemes({ store = getStore() } = {}) {
  const badges = await themeBadges(store);
  const counts = new Map((await store.themeHolderCounts()).map((row) => [row.theme_id, Number(row.holders)]));
  return { themes: THEMES.map((t) => ({ id: t.id, badge: badges.get(t.id), holders: t.id === 'default' ? null : counts.get(t.id) || 0 })) };
}

/**
 * Who a theme can be given to, and who holds this one: names only. Someone trusted
 * to hand out a look has no need of everyone's email.
 *
 * @param {string} [themeId]
 */
export async function themePeople(themeId, { store = getStore() } = {}) {
  const shown = (row) => ({ id: row.id, name: row.username || row.name || null });
  if (!themeId) return { people: (await store.listPeopleNames()).map(shown) };
  if (!THEME_BY_ID.has(themeId)) throw refuse(400, 'There is no such theme.');
  return { holders: (await store.themeHolders(themeId)).map((row) => ({ ...shown(row), grantedAt: iso(row.granted_at) })) };
}

/** @param {string} id @param {any} body @param {string} by */
export async function setThemeBadge(id, body, by, { store = getStore() } = {}) {
  if (!THEME_BY_ID.has(id)) throw refuse(400, 'There is no such theme.');
  const badge = cleanBadge(body);
  if (id === 'default' && badge.kind !== 'none') throw refuse(400, 'The default theme carries no badge: everybody has it.');
  await store.setThemeBadge(id, badge, by);
  return { badge };
}

/** An administrator giving a theme by hand. It is recorded as what the theme is now called. */
export async function giveTheme(id, userId, { store = getStore() } = {}) {
  if (!THEME_BY_ID.has(id) || id === 'default') throw refuse(400, 'That theme cannot be given.');
  const target = await store.getUserById(String(userId || ''));
  if (!target) throw refuse(404, 'There is no such account.');
  const badge = (await themeBadges(store)).get(id);
  await store.grantTheme(target.id, id, { ...(badge.kind === 'none' ? blank('exclusive_event') : badge), byHand: true });
}

/** An administrator taking one back. Whoever wore it falls back to the default on their next look. */
export async function takeTheme(id, userId, { store = getStore() } = {}) {
  if (!THEME_BY_ID.has(id) || id === 'default') throw refuse(400, 'That theme cannot be taken back.');
  await store.revokeTheme(String(userId || ''), id);
}

/** What someone's account holds, for the copy of their data they can download. */
export async function holdingsOf(userId, store = getStore()) {
  const [themes, titles, places, answers] = await Promise.all([
    store.listUserThemes(userId),
    store.listUserTitles(userId),
    store.exportEventPlaces(userId),
    store.exportOutcomes(userId),
  ]);
  return { themes, titles, places, answers };
}

export const __testing = {
  reset() {
    rowsCache.clear();
    settledThrough = null;
    settleFailedAt = 0;
  },
};
