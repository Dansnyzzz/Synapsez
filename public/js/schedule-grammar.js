/**
 * The words a schedule is kept in, and the pieces a person edits.
 *
 * One module for both sides: the server computes the next run from these
 * words, the browser shows and edits the same words, and both read them with
 * `readCron` and write them with `writeCron`. Two copies of the grammar is how
 * a panel ends up showing a schedule differently from how it runs. No DOM and
 * no translation in here — only the grammar.
 *
 * The forms, oldest first (every one still in a database must keep reading):
 *
 *   "17:00"                         every day at 17:00
 *   "fri 17:00"                     every Friday at 17:00
 *   "weekdays 08:00"                Monday to Friday at 08:00
 *   "monthly 1 08:00"               the 1st of every month at 08:00
 *   "hourly :15"                    every hour at quarter past
 *   "days mon,wed,fri 08:00,18:00"  chosen weekdays ("all" for every day), at one or more times
 *   "monthly 1,15,last 09:00"       chosen days of the month, "last" being the last one
 *   "every 10m"                     every 10 minutes on the clock (:00, :10, :20…)
 *   "every 6h :15"                  every 6 hours on the clock (00:15, 06:15, 12:15, 18:15)
 *   "every 7m @2026-09-28T03:00:00.000Z"   every 7 minutes counted from that instant
 *   "every 23h @2026-09-28T03:00:00.000Z"  every 23 hours counted from that instant
 *   "every 3d 08:00 @2026-09-28"    every third day at 08:00, counted from that date
 *
 * An interval that divides the day evenly is kept on the clock — "every 10
 * minutes" means :00, :10, :20, which is what people expect to see — and one
 * that does not (7 minutes, 23 hours) is counted from a starting instant, which
 * the words carry so it cannot drift from run to run.
 */

export const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WORKWEEK = ['mon', 'tue', 'wed', 'thu', 'fri'];
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Limits, kept here so the form and the server refuse the same things. */
export const LIMITS = {
  // The cloud scheduler is woken every few minutes by an outside pinger; a
  // shorter interval would promise precision the deployment cannot give.
  minutes: { min: 5, max: 1440 },
  hours: { min: 1, max: 168 },
  days: { min: 2, max: 365 },
};

const pad = (n) => String(n).padStart(2, '0');

/** "9:5" or "09:05" → "09:05"; null when it is not a time of day. */
export function normTime(value) {
  const m = HHMM.exec(String(value ?? '').trim());
  return m ? `${pad(m[1])}:${m[2]}` : null;
}

/** Times, deduplicated and in order. */
function timeList(list) {
  const out = [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map(normTime).filter(Boolean))];
  return out.sort();
}

/** Weekday names in week order, from any of "mon", "Monday", "all", "weekdays", "weekend". */
function dayList(list) {
  const words = (Array.isArray(list) ? list : String(list || '').split(',')).map((d) => String(d).trim().toLowerCase());
  const days = new Set();
  for (const w of words) {
    if (w === 'all' || w === 'daily' || w === 'everyday') WEEK.forEach((d) => days.add(d));
    else if (w === 'weekdays') WORKWEEK.forEach((d) => days.add(d));
    else if (w === 'weekend' || w === 'weekends') ['sat', 'sun'].forEach((d) => days.add(d));
    else if (WEEK.includes(w.slice(0, 3))) days.add(w.slice(0, 3));
  }
  return WEEK.filter((d) => days.has(d));
}

/** Days of the month in order, numbers first, "last" last. */
function monthDays(list) {
  const words = Array.isArray(list) ? list : String(list || '').split(',');
  const nums = new Set();
  let last = false;
  for (const w of words) {
    const s = String(w).trim().toLowerCase();
    if (s === 'last') last = true;
    else if (/^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 31) nums.add(Number(s));
  }
  return [...[...nums].sort((a, b) => a - b), ...(last ? ['last'] : [])];
}

/**
 * The stored words, as the pieces the editor shows.
 *
 * @returns {{ kind: string, every?: number, minute?: number, anchor?: string|null,
 *   time?: string, times?: string[], days?: string[], monthDays?: Array<number|'last'>, start?: string }}
 *   `kind` is one of manual, minutes, hours, days, weekly, monthly. Unknown words
 *   read as manual rather than throwing: the panel must open whatever is stored.
 */
export function readCron(cron) {
  const text = String(cron || '').trim().toLowerCase();
  if (!text) return { kind: 'manual' };

  let m = /^hourly\s*:?([0-5]\d)$/.exec(text);
  if (m) return { kind: 'hours', every: 1, minute: Number(m[1]), anchor: null };

  m = /^every\s+(\d+)m(?:\s+@(\S+))?$/.exec(text);
  if (m) return { kind: 'minutes', every: Number(m[1]), anchor: m[2] ? m[2].toUpperCase() : null };

  m = /^every\s+(\d+)h(?:\s+:([0-5]\d))?(?:\s+@(\S+))?$/.exec(text);
  if (m) {
    const anchor = m[3] ? m[3].toUpperCase() : null;
    return { kind: 'hours', every: Number(m[1]), minute: m[2] ? Number(m[2]) : anchor ? new Date(anchor).getUTCMinutes() : 0, anchor };
  }

  m = /^every\s+(\d+)d\s+(\S+)\s+@(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (m) return { kind: 'days', every: Number(m[1]), time: normTime(m[2]) || '09:00', start: m[3] };

  m = /^monthly\s+(\S+)\s+(\S+)$/.exec(text);
  if (m) return { kind: 'monthly', monthDays: monthDays(m[1]), times: timeList(m[2]) };

  m = /^weekdays\s+(\S+)$/.exec(text);
  if (m) return { kind: 'weekly', days: [...WORKWEEK], times: timeList(m[1]) };

  m = /^days\s+(\S+)\s+(\S+)$/.exec(text);
  if (m) return { kind: 'weekly', days: dayList(m[1]), times: timeList(m[2]) };

  m = /^([a-z]{3})\s+(\S+)$/.exec(text);
  if (m && WEEK.includes(m[1])) return { kind: 'weekly', days: [m[1]], times: timeList(m[2]) };

  if (/^[\d:,]+$/.test(text) && timeList(text).length) return { kind: 'weekly', days: [...WEEK], times: timeList(text) };

  return { kind: 'manual' };
}

/**
 * The pieces, as the words to keep. Throws a sentence a person can act on when
 * the pieces do not make a schedule. `anchor` is required for an interval that
 * does not divide the day; the caller decides where counting starts.
 */
export function writeCron(parts) {
  const kind = parts?.kind;
  // Whole sentences, one per unit, so each translates as a unit.
  const SAY = {
    minutes: ({ min, max }) => `The number of minutes must be a whole number from ${min} to ${max}.`,
    hours: ({ min, max }) => `The number of hours must be a whole number from ${min} to ${max}.`,
    days: ({ min, max }) => `The number of days must be a whole number from ${min} to ${max}.`,
    minute: () => 'The minute must be a whole number from 0 to 59.',
  };
  const whole = (value, limits, unit) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < limits.min || n > limits.max) throw new Error(SAY[unit](limits));
    return n;
  };

  if (kind === 'minutes') {
    const n = whole(parts.every, LIMITS.minutes, 'minutes');
    if (1440 % n === 0) return `every ${n}m`;
    if (!parts.anchor) throw new Error('An interval that does not divide the day needs a starting time.');
    return `every ${n}m @${new Date(parts.anchor).toISOString()}`;
  }
  if (kind === 'hours') {
    const n = whole(parts.every, LIMITS.hours, 'hours');
    const minute = whole(parts.minute ?? 0, { min: 0, max: 59 }, 'minute');
    if (n === 1) return `hourly :${pad(minute)}`;
    if (24 % n === 0) return `every ${n}h :${pad(minute)}`;
    if (!parts.anchor) throw new Error('An interval that does not divide the day needs a starting time.');
    return `every ${n}h @${new Date(parts.anchor).toISOString()}`;
  }
  if (kind === 'days') {
    const n = whole(parts.every, LIMITS.days, 'days');
    const time = normTime(parts.time);
    if (!time) throw new Error('Give the time as HH:MM — "07:00".');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(parts.start || ''))) throw new Error('Give the first day as YYYY-MM-DD.');
    return `every ${n}d ${time} @${parts.start}`;
  }
  if (kind === 'weekly') {
    const days = dayList(parts.days);
    const times = timeList(parts.times ?? parts.time);
    if (!days.length) throw new Error('Pick at least one day of the week.');
    if (!times.length) throw new Error('Give at least one time as HH:MM — "07:00".');
    if (times.length === 1) {
      if (days.length === 7) return times[0];
      if (days.join() === WORKWEEK.join()) return `weekdays ${times[0]}`;
      if (days.length === 1) return `${days[0]} ${times[0]}`;
    }
    return `days ${days.length === 7 ? 'all' : days.join(',')} ${times.join(',')}`;
  }
  if (kind === 'monthly') {
    const days = monthDays(parts.monthDays ?? parts.day);
    const times = timeList(parts.times ?? parts.time);
    if (!days.length) throw new Error('Pick at least one day of the month.');
    if (!times.length) throw new Error('Give at least one time as HH:MM — "07:00".');
    return `monthly ${days.join(',')} ${times.join(',')}`;
  }
  return null;
}

/**
 * Words a person or a model typed — "every 10 minutes", "mỗi 23 giờ",
 * "mon,wed 08:00", "monthly last 09:00" — as schedule pieces, or null when it
 * is not one of these. The server turns the pieces into canonical words.
 */
export function readWhen(input) {
  const text = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let m = /^(?:every|mỗi) (\d+) ?(?:m|min|mins|minute|minutes|phút|p)$/.exec(text);
  if (m) return { kind: 'minutes', every: Number(m[1]) };
  m = /^(?:every|mỗi) (\d+) ?(?:h|hr|hrs|hour|hours|giờ|tiếng)(?: (?:at )?:?([0-5]\d))?$/.exec(text);
  if (m) return { kind: 'hours', every: Number(m[1]), minute: m[2] ? Number(m[2]) : null };
  m = /^(?:every|mỗi) (\d+) ?(?:d|day|days|ngày)(?: (?:at )?(\d{1,2}:\d{2}))?$/.exec(text);
  if (m) return { kind: 'days', every: Number(m[1]), time: m[2] || null };
  m = /^daily ([\d:, ]+)$/.exec(text);
  if (m) return { kind: 'weekly', days: [...WEEK], times: timeList(m[1].replace(/ /g, '')) };
  m = /^((?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|weekends?)(?:,(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*) ([\d:,]+)$/.exec(text.replace(/, /g, ','));
  if (m && (m[1].includes(',') || m[2].includes(',') || /^weekend/.test(m[1]))) return { kind: 'weekly', days: dayList(m[1]), times: timeList(m[2]) };
  m = /^weekdays ([\d:,]+)$/.exec(text);
  if (m && m[1].includes(',')) return { kind: 'weekly', days: [...WORKWEEK], times: timeList(m[1]) };
  m = /^monthly ((?:\d{1,2}|last)(?:,(?:\d{1,2}|last))*) ([\d:,]+)$/.exec(text.replace(/, /g, ','));
  if (m && (m[1].includes(',') || m[1] === 'last' || m[2].includes(','))) return { kind: 'monthly', monthDays: monthDays(m[1]), times: timeList(m[2]) };
  m = /^([\d:]+(?:,[\d:]+)+)$/.exec(text.replace(/, /g, ','));
  if (m) return { kind: 'weekly', days: [...WEEK], times: timeList(m[1]) };
  return null;
}
