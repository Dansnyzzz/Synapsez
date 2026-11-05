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
 * @typedef {{ kind: string, month: number|null, year: number|null }} Badge
 * @typedef {{ id: string, role?: string, created_at?: any }} Account
 */

export const BADGE_KINDS = ['none', 'exclusive_event', 'achievement', 'top_month', 'top_year'];

const blank = (kind) => ({ kind, month: null, year: null });

/** Display order among locked themes. `tokens`: what earns an achievement theme, if that is its badge. */
export const THEMES = Object.freeze([
  { id: 'default', badge: blank('none') },
  { id: 'cloud-drift', badge: blank('achievement'), tokens: 100_000 },
  { id: 'moon-night', badge: blank('achievement'), tokens: 1_000_000 },
  { id: 'lagoon', badge: blank('achievement'), tokens: 10_000_000 },
  { id: 'firefly-grove', badge: blank('achievement'), tokens: 50_000_000 },
  { id: 'deep-sea', badge: blank('achievement'), tokens: 200_000_000 },
  { id: 'aurora-peak', badge: blank('exclusive_event') },
  { id: 'sakura-crossing', badge: blank('top_month') },
  { id: 'rose-street', badge: blank('top_year') },
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

/** Periods before this are not ranked: nobody was competing, and nobody should wake up with a prize for it. */
export const RANKING_STARTS = '2026-11';

/** How far back the period picker reaches. */
const MAX_PERIODS = 24;

export const SCOPES = ['month', 'year'];
const pad = (n) => String(n).padStart(2, '0');

/** @param {'month'|'year'} scope @param {Date} [when] */
export const periodKey = (scope, when = new Date()) => (scope === 'year' ? String(when.getUTCFullYear()) : `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}`);

/**
 * When a period starts and ends, UTC. Null for anything that is not one.
 *
 * @param {string} scope @param {string} key
 */
export function periodRange(scope, key) {
  const match = scope === 'year' ? /^(\d{4})$/.exec(String(key)) : scope === 'month' ? /^(\d{4})-(\d{2})$/.exec(String(key)) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = scope === 'year' ? 0 : Number(match[2]) - 1;
  if (year < 2000 || year > 2200 || month < 0 || month > 11) return null;
  return { from: new Date(Date.UTC(year, month, 1)), to: scope === 'year' ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, month + 1, 1)) };
}

/**
 * The periods that have closed since ranking began, oldest first.
 *
 * @param {Date} [now]
 * @returns {{ scope: 'month'|'year', key: string }[]}
 */
export function closedPeriods(now = new Date()) {
  /** @type {{ scope: 'month'|'year', key: string }[]} */
  const out = [];
  const [startYear, startMonth] = RANKING_STARTS.split('-').map(Number);
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  for (let at = startYear * 12 + startMonth - 1; at < thisMonth; at += 1) {
    out.push({ scope: 'month', key: `${Math.floor(at / 12)}-${pad((at % 12) + 1)}` });
  }
  for (let year = startYear; year < now.getUTCFullYear(); year += 1) out.push({ scope: 'year', key: String(year) });
  return out;
}

/**
 * The periods the picker offers, newest first.
 *
 * @param {'month'|'year'} scope @param {Date} [now]
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

/** The ceiling of a board: three people win, and only they are named. */
export const TOP = 3;

/** What an award title's id says. */
const AWARD = /^top:(tokens|spend):(month|year):(\d{4}(?:-\d{2})?):([123])$/;

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
  if (kind !== 'top_month' && kind !== 'top_year') return blank(kind);
  const number = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
  const year = number(body?.year);
  const month = kind === 'top_month' ? number(body?.month) : null;
  if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2200)) throw new Error('That is not a year this can use.');
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) throw new Error('A month is a number from 1 to 12.');
  if (month !== null && year === null) throw new Error('Say which year that month is in.');
  return { kind, month, year: kind === 'top_month' && month === null ? null : year };
}

/**
 * Which themes a closing period gives: those carrying exactly that period, or
 * else those carrying "any". An administrator naming a month takes it over from
 * the standing prize, without having to touch the standing prize.
 *
 * @param {Map<string, Badge>} badges
 * @param {'month'|'year'} scope @param {string} key
 * @returns {string[]}
 */
export function rewardThemes(badges, scope, key) {
  const kind = scope === 'year' ? 'top_year' : 'top_month';
  const year = Number(String(key).slice(0, 4));
  const month = scope === 'month' ? Number(String(key).slice(5, 7)) : null;
  const carrying = [...badges].filter(([, b]) => b.kind === kind);
  const exact = carrying.filter(([, b]) => b.year === year && (scope === 'year' || b.month === month));
  return (exact.length ? exact : carrying.filter(([, b]) => b.year === null)).map(([id]) => id);
}

/** Each theme's badge: an administrator's choice over the catalogue's. */
export async function themeBadges(store = getStore()) {
  const stored = new Map((await store.listThemeBadges()).map((row) => [row.theme_id, row]));
  return new Map(
    THEMES.map((theme) => {
      const row = stored.get(theme.id);
      return [theme.id, row ? { kind: row.kind, month: row.month ?? null, year: row.year ?? null } : theme.badge];
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

/** The month this instance last settled up to, so an ordinary read costs no query. */
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
 * @param {'month'|'year'} scope @param {string} key
 */
export async function settlePeriod(scope, key, { store = getStore() } = {}) {
  const range = periodRange(scope, key);
  if (!range) return;
  const rows = await store.rankingRows(range.from, range.to);
  const badges = await themeBadges(store);
  const prizes = rewardThemes(badges, scope, key);
  const grant = { kind: scope === 'year' ? 'top_year' : 'top_month', year: Number(key.slice(0, 4)), month: scope === 'month' ? Number(key.slice(5, 7)) : null };
  for (const board of /** @type {('tokens'|'spend')[]} */ (['tokens', 'spend'])) {
    const top = rankBoard(rows, board).slice(0, TOP);
    for (const [i, winner] of top.entries()) {
      const rank = i + 1;
      await store.saveBoardRow(scope, key, board, rank, winner.id, winner.value);
      await store.grantTitle(winner.id, awardId(board, scope, key, rank));
      for (const themeId of prizes) await store.grantTheme(winner.id, themeId, grant);
    }
  }
  await store.markPeriodSettled(scope, key);
}

/** Close whatever has closed. Runs on the first read of a new month, on any instance. */
export async function settleClosed({ store = getStore(), now = new Date() } = {}) {
  const stamp = periodKey('month', now);
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
 * Give this person what their usage has earned. Asked when they look, so nothing
 * has to watch every account; an earned thing is kept, so pruning old usage can
 * never take one away.
 *
 * @param {Account} user
 */
async function syncEarned(user, store) {
  const life = await store.lifetimeUsage(user.id);
  const spent = withMarkup(life.cost);
  const heldTitles = await store.listUserTitles(user.id);
  const titles = new Set(heldTitles.map((row) => row.title_id));
  let changed = false;
  for (const title of TITLES) {
    const earned = title.tokens ? life.tokens >= title.tokens : title.spend ? spent >= title.spend : true;
    if (earned && !titles.has(title.id)) {
      await store.grantTitle(user.id, title.id);
      changed = true;
    }
  }
  const badges = await themeBadges(store);
  const heldThemes = await store.listUserThemes(user.id);
  // One an administrator took back stays taken: the usage that earned it is still there.
  const taken = await store.listRevokedThemes(user.id);
  const themes = new Set([...heldThemes, ...taken].map((row) => row.theme_id));
  for (const theme of THEMES) {
    if (!theme.tokens || badges.get(theme.id)?.kind !== 'achievement' || life.tokens < theme.tokens || themes.has(theme.id)) continue;
    await store.grantTheme(user.id, theme.id, blank('achievement'));
    changed = true;
  }
  return {
    badges,
    heldThemes: changed ? await store.listUserThemes(user.id) : heldThemes,
    heldTitles: changed ? await store.listUserTitles(user.id) : heldTitles,
  };
}

const iso = (value) => (value ? new Date(value).toISOString() : null);
const isAdmin = (user) => user?.role === 'admin';

/**
 * The Theme page: held themes first, newest first; then locked ones in catalogue order.
 *
 * @param {Account} user
 */
export async function listThemes(user, { store = getStore() } = {}) {
  await settleClosed({ store });
  const { badges, heldThemes } = await syncEarned(user, store);
  const held = new Map(heldThemes.map((row) => [row.theme_id, row]));
  const admin = isAdmin(user);
  const rows = THEMES.map((theme) => {
    const row = held.get(theme.id);
    const owned = admin || theme.id === 'default' || !!row;
    const badge = badges.get(theme.id) || theme.badge;
    return {
      id: theme.id,
      badge,
      owned,
      grantedAt: theme.id === 'default' ? iso(user.created_at) : iso(row?.granted_at),
      grant: row ? { kind: row.grant_kind, month: row.grant_month ?? null, year: row.grant_year ?? null } : null,
      needs: !owned && badge.kind === 'achievement' && theme.tokens ? { tokens: theme.tokens } : null,
    };
  });
  const time = (row) => (row.grantedAt ? new Date(row.grantedAt).getTime() : 0);
  // Stable: an administrator's blanket access stays in catalogue order.
  const themes = [...rows.filter((r) => r.owned).sort((a, b) => time(b) - time(a)), ...rows.filter((r) => !r.owned)];
  const prefs = await getPrefs(user.id);
  const selected = themes.some((t) => t.id === prefs.sceneTheme && t.owned) ? prefs.sceneTheme : 'default';
  return { selected, isAdmin: admin, themes };
}

/** An error the route says as it is. */
const refuse = (status, message) => Object.assign(new Error(message), { status });

/** @param {Account} user @param {string} id */
export async function selectTheme(user, id, { store = getStore() } = {}) {
  if (!THEME_BY_ID.has(id)) throw refuse(400, 'There is no such theme.');
  const { themes } = await listThemes(user, { store });
  if (!themes.find((t) => t.id === id)?.owned) throw refuse(403, 'You do not hold that theme yet.');
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
  const { heldTitles } = await syncEarned(user, store);
  const admin = isAdmin(user);
  const held = heldTitles
    .map((row) => ({ ...titleInfo(row.title_id), owned: true, earnedAt: iso(row.earned_at), needs: null }))
    .filter((t) => t.id)
    .sort((a, b) => new Date(b.earnedAt || 0).getTime() - new Date(a.earnedAt || 0).getTime());
  const heldIds = new Set(held.map((t) => t.id));
  const rest = TITLES.filter((t) => !heldIds.has(t.id)).map((t) => ({
    id: t.id,
    kind: 'catalog',
    owned: admin,
    earnedAt: null,
    needs: admin ? null : t.tokens ? { tokens: t.tokens } : t.spend ? { spend: t.spend } : null,
  }));
  const prefs = await getPrefs(user.id);
  const titles = [...held, ...rest];
  const equipped = titles.some((t) => t.id === prefs.equippedTitle && t.owned) ? prefs.equippedTitle : null;
  return { equipped, titles };
}

/** @param {Account} user @param {string|null} id */
export async function equipTitle(user, id, { store = getStore() } = {}) {
  if (id === null) {
    await setPrefs(user.id, { equippedTitle: null });
    return { equipped: null };
  }
  const { titles } = await listTitles(user, { store });
  const title = titles.find((t) => t.id === id);
  if (!title) throw refuse(400, 'There is no such title.');
  if (!title.owned) throw refuse(403, 'You have not earned that title yet.');
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
export async function ranking(user, { scope = 'month', key, store = getStore(), now = new Date() } = {}) {
  if (!SCOPES.includes(scope)) throw refuse(400, 'A ranking is by month or by year.');
  const period = /** @type {'month'|'year'} */ (scope);
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
      : live[board].slice(0, TOP).map((r, i) => ({ ...r, rank: i + 1 }));
  const boards = { tokens: top('tokens'), spend: top('spend') };
  const people = new Map((await store.boardPeople([...new Set([...boards.tokens, ...boards.spend].map((r) => r.id))])).map((p) => [p.id, p]));
  const draw = (r) => {
    const person = people.get(r.id);
    const shown = person?.prefs?.rankAnonymous !== true;
    return {
      rank: r.rank,
      name: shown ? person?.username || person?.name || null : null,
      title: titleInfo(person?.prefs?.equippedTitle),
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
  await store.grantTheme(target.id, id, badge.kind === 'none' ? blank('exclusive_event') : badge);
}

/** An administrator taking one back. Whoever wore it falls back to the default on their next look. */
export async function takeTheme(id, userId, { store = getStore() } = {}) {
  if (!THEME_BY_ID.has(id) || id === 'default') throw refuse(400, 'That theme cannot be taken back.');
  await store.revokeTheme(String(userId || ''), id);
}

/** What someone's account holds, for the copy of their data they can download. */
export async function holdingsOf(userId, store = getStore()) {
  const [themes, titles] = await Promise.all([store.listUserThemes(userId), store.listUserTitles(userId)]);
  return { themes, titles };
}

export const __testing = {
  reset() {
    rowsCache.clear();
    settledThrough = null;
    settleFailedAt = 0;
  },
};
