/**
 * Exchange clocks. Vietnam is UTC+7 all year; New York moves with daylight
 * saving, so both are read through Intl rather than a fixed offset.
 *
 * Yahoo reports Vietnam's zone as Asia/Bangkok — the same offset, so the same clock.
 */
export const ICT = 'Asia/Ho_Chi_Minh';
export const NEW_YORK = 'America/New_York';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall clock in a zone at an instant: { y, m (1–12), d, h, mi, s, weekday (0 = Sunday) }. */
export function wallClock(date, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date instanceof Date ? date : new Date(date))
      .map((p) => [p.type, p.value]),
  );
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second, weekday: WEEKDAYS.indexOf(parts.weekday) };
}

/** The instant (ms) a wall-clock time in a zone is — corrected twice, which settles across a DST change. */
export function instantAt(y, m, d, h, mi, zone) {
  const wanted = Date.UTC(y, m - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(new Date(guess), zone);
    guess = wanted - (Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - guess);
  }
  return guess;
}

/**
 * The next Monday-to-Friday `h:mi` in a zone strictly after `now` (ms). Public
 * holidays are not known here: on one, the next answer is simply asked for again.
 */
export function nextWeekdayAt(now, zone, h, mi) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const w = wallClock(new Date(at), zone);
  for (let i = 0; i < 9; i += 1) {
    const day = new Date(Date.UTC(w.y, w.m - 1, w.d + i));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const t = instantAt(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, zone);
    if (t > at) return t;
  }
  return at + 24 * 3_600_000;
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function dayIn(date, zone) {
  const w = wallClock(date, zone);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}
