// ── time in somebody else's zone ──────────────────────────────────────
//
// No dependency needed: `Intl` already knows every zone and every DST rule the
// platform does. The only trick is that it converts one way — instant to wall
// clock — and a schedule needs the other way round.

/** Is this a zone the platform actually recognises? */
export function validZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading in `tz` at a given instant. */
export function partsIn(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const out = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') out[type] = Number(value);
  }
  // Some platforms render midnight as hour 24 under hour12:false.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
export function offsetAt(date, tz) {
  const p = partsIn(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/**
 * A wall-clock reading in `tz` → the instant it names.
 *
 * Two passes, because the offset has to be sampled at the answer rather than at
 * the guess: on the night the clocks move, those are an hour apart and a single
 * pass lands an hour out.
 */
export function instantOf({ year, month, day, hour, minute }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const once = guess - offsetAt(new Date(guess), tz);
  return new Date(guess - offsetAt(new Date(once), tz));
}

/**
 * The most recent moment the clock in `tz` read `hour`:00.
 *
 * "Up to date as of six this morning" is a promise about somebody's own
 * morning, not the server's — a deployment runs on UTC, where six is one in the
 * afternoon in Vietnam. An unknown zone falls back to UTC rather than throwing:
 * the caller is deciding whether to refresh, and that must never fail a page.
 */
export function lastLocalHour(hour, tz, now = new Date()) {
  const zone = validZone(tz) ? tz : 'UTC';
  const p = partsIn(now, zone);
  let at = instantOf({ year: p.year, month: p.month, day: p.day, hour, minute: 0 }, zone);
  if (at.getTime() > now.getTime()) {
    at = instantOf({ year: p.year, month: p.month, day: p.day - 1, hour, minute: 0 }, zone);
  }
  return at;
}
