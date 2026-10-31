/**
 * The arithmetic behind Settings → Usage (owner, 2026-10-31), kept apart from
 * the drawing so the suites can check it without a browser.
 *
 * The server hands over calls per UTC hour per model (server/usageReport.js);
 * everything here turns them into the person's own week, in their own zone:
 * which day is "today", which hour was the busiest, how this week compares with
 * the last. A week starts on Monday in Vietnamese and on Sunday in English, the
 * way each is printed on a calendar there.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Local midnight of the day `date` falls on. */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** The first day of the week `now` is in: Monday (0 = Sunday … 6 = Saturday by `firstDay`). */
export function startOfWeek(now, firstDay = 1) {
  const d = startOfDay(now);
  const back = (d.getDay() - firstDay + 7) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

/** The seven local days of this week, its first day first. */
export function weekDays(now, firstDay = 1) {
  const start = startOfWeek(now, firstDay);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** Only the rows of one provider — or all of them for the overview. */
export const rowsFor = (rows, provider) => (provider && provider !== 'all' ? rows.filter((r) => r.provider === provider) : rows);

/** Which of the given days (local midnights) an instant falls on, or -1. */
function dayIndex(days, at) {
  const t = new Date(at).getTime();
  for (let i = 0; i < days.length; i += 1) {
    const from = days[i].getTime();
    const next = new Date(days[i]);
    next.setDate(next.getDate() + 1);
    if (t >= from && t < next.getTime()) return i;
  }
  return -1;
}

/** Requests on each of the days. */
export function callsByDay(rows, days) {
  const out = days.map(() => 0);
  for (const row of rows) {
    const i = dayIndex(days, row.at);
    if (i >= 0) out[i] += row.calls;
  }
  return out;
}

/** Requests in each local hour of each day: `grid[day][hour]`. */
export function heatmap(rows, days) {
  const grid = days.map(() => Array.from({ length: 24 }, () => 0));
  for (const row of rows) {
    const i = dayIndex(days, row.at);
    if (i >= 0) grid[i][new Date(row.at).getHours()] += row.calls;
  }
  return grid;
}

/** Each key's share of the requests on the given days, largest first. */
export function shareBy(rows, days, key) {
  const totals = new Map();
  let all = 0;
  for (const row of rows) {
    if (dayIndex(days, row.at) < 0) continue;
    totals.set(row[key], (totals.get(row[key]) || 0) + row.calls);
    all += row.calls;
  }
  return [...totals.entries()]
    .map(([name, calls]) => ({ name, calls, share: all ? calls / all : 0 }))
    .sort((a, b) => b.calls - a.calls);
}

/**
 * Requests so far this week, hour by hour from its first hour, beside the
 * same hours of last week — the pace line and the line it is measured against.
 * `now` cuts this week where it is; last week runs its whole length.
 *
 * @returns {{ thisWeek: number[], lastWeek: number[], hoursIn: number, change: number | null }}
 */
export function pace(rows, now, firstDay = 1) {
  const start = startOfWeek(now, firstDay).getTime();
  const before = start - 7 * DAY;
  const thisWeek = Array.from({ length: 168 }, () => 0);
  const lastWeek = Array.from({ length: 168 }, () => 0);
  for (const row of rows) {
    const t = new Date(row.at).getTime();
    if (t >= start && t < start + 7 * DAY) thisWeek[Math.floor((t - start) / HOUR)] += row.calls;
    else if (t >= before && t < start) lastWeek[Math.floor((t - before) / HOUR)] += row.calls;
  }
  const cumulative = (list) => list.reduce((acc, n) => [...acc, (acc.at(-1) || 0) + n], []);
  const hoursIn = Math.min(168, Math.max(1, Math.floor((new Date(now).getTime() - start) / HOUR) + 1));
  const a = cumulative(thisWeek).slice(0, hoursIn);
  const b = cumulative(lastWeek);
  const then = b[hoursIn - 1] || 0;
  return { thisWeek: a, lastWeek: b, hoursIn, change: then > 0 ? (a.at(-1) - then) / then : null };
}

/** The busiest hour of the given grid, and the part of the day it is in. */
export function busiest(grid) {
  let best = { day: -1, hour: -1, calls: 0 };
  grid.forEach((hours, day) => hours.forEach((calls, hour) => {
    if (calls > best.calls) best = { day, hour, calls };
  }));
  if (best.day < 0) return null;
  const part = best.hour < 5 ? 'night' : best.hour < 12 ? 'morning' : best.hour < 18 ? 'afternoon' : best.hour < 22 ? 'evening' : 'night';
  return { ...best, part };
}

/** The weekday (0 = Sunday) with the most requests across every row given. */
export function usualDay(rows) {
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const row of rows) byWeekday[new Date(row.at).getDay()] += row.calls;
  const most = Math.max(...byWeekday);
  return most > 0 ? byWeekday.indexOf(most) : null;
}

/** The next midnight UTC — when OpenRouter counts free requests from zero again. */
export function nextUtcMidnight(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** The first instant of next month, local — when the deployment's monthly ceiling resets. */
export function nextMonth(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/**
 * The line at the top: how the tightest limit stands. `limits` are
 * `{ used, limit }` pairs the page knows of; none known is said as such.
 *
 * @returns {'unknown' | 'ok' | 'close' | 'out'}
 */
export function standing(limits) {
  const known = limits.filter((l) => l && l.limit > 0);
  if (!known.length) return 'unknown';
  const worst = Math.max(...known.map((l) => l.used / l.limit));
  return worst >= 1 ? 'out' : worst >= 0.8 ? 'close' : 'ok';
}
