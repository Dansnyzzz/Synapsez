import { t } from './i18n.js';
import { readCron } from './schedule-grammar.js';

/**
 * The small formatters more than one screen needs.
 *
 * Each of these existed in several files at once — `humanSize` in five,
 * `readAsBase64` and `counted` in two apiece — and the copies had begun to
 * drift, which is the cost that makes duplication worth removing rather than
 * the duplication itself.
 */

/**
 * Bytes as something a person reads.
 *
 * This is `workspace.js`'s version, which was the outlier and the better one.
 * The four identical copies elsewhere returned `Math.max(1, …)` KB for
 * everything below a megabyte, so a 40-byte file read as "1 KB", and they
 * returned "NaN KB" for a null size rather than nothing at all.
 *
 * So unifying them does change what is shown in those four places: small files
 * now say "512 B" instead of "1 KB", and a missing size shows nothing instead
 * of NaN. Both are the answer the old code was trying to give.
 */
export const humanSize = (bytes) =>
  bytes == null
    ? ''
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} B`;

/**
 * A count and its noun, as one translated phrase.
 *
 * Not `${n} ${one}${n === 1 ? '' : 's'}`: that bakes an English pluralisation
 * rule into the formatter, and Vietnamese does not inflect the noun at all. The
 * translation owns the whole phrase and this only chooses which of the two to
 * ask for.
 */
export const counted = (n, key) => (n === 1 ? t(`${key}One`) : t(key)).replace('{n}', String(n));

/**
 * A task's recurrence, in words.
 *
 * The `cron` column holds what the scheduler reads — `hourly :30`, `weekdays
 * 09:00`, `mon 16:00` — which is exactly the vocabulary a person should never
 * be shown. Null is not "unknown": it is a task that only ever runs when the
 * button is pressed, and saying so is the whole point of the manual option.
 *
 * Here rather than on the project page it was written for, because the
 * transcript's schedule card needs the same words — and the transcript
 * importing the project page would pull a whole screen in for one function.
 */
export function repeatsAs(task) {
  const cron = String(task?.cron || '').trim();
  if (!cron) return task?.next_run_at || task?.nextRunAt ? t('sched.once') : t('freq.manualOnly');
  const s = readCron(cron);
  const list = (items) => items.join(', ');
  const dayName = (d) => t(`day.${d}`);
  const two = (n) => String(n).padStart(2, '0');
  if (s.kind === 'minutes') return t('freq.everyNMinutes', { n: String(s.every) });
  if (s.kind === 'hours') {
    if (s.every === 1) return t('freq.everyHourAt').replace('{m}', two(s.minute));
    return s.anchor ? t('freq.everyNHours', { n: String(s.every) }) : t('freq.everyNHoursAt', { n: String(s.every), m: two(s.minute) });
  }
  if (s.kind === 'days') return t('freq.everyNDaysAt', { n: String(s.every), time: s.time });
  if (s.kind === 'monthly') {
    const days = s.monthDays.map((d) => (d === 'last' ? t('freq.lastDay') : String(d)));
    return t('freq.everyMonthOn').replace('{day}', list(days)).replace('{time}', list(s.times));
  }
  if (s.kind === 'weekly') {
    const time = list(s.times);
    if (s.days.length === 7) return t('freq.everyDayAt').replace('{time}', time);
    if (s.days.join() === 'mon,tue,wed,thu,fri') return t('freq.everyWeekdayAt').replace('{time}', time);
    if (s.days.length === 1) return t('freq.everyWeekOn').replace('{day}', dayName(s.days[0])).replace('{time}', time);
    return t('freq.onDaysAt', { days: list(s.days.map(dayName)), time });
  }
  return t('freq.manualOnly');
}

/**
 * A stored schedule taken apart into the fields the side panel edits.
 *
 * The inverse of `scheduleFrom` on the server, through the same grammar
 * (schedule-grammar.js), so whatever the panel shows is what it would save.
 * `frequency` is what the menu shows: a weekly schedule on all seven days is
 * "daily", on Monday to Friday "weekdays", an interval of one hour "hourly".
 *
 * @returns {{ frequency: string, every: number, minute: number, time: string, times: string[],
 *   days: string[], monthDays: Array<number|'last'>, start: string|null, anchored: boolean }}
 */
export function cronParts(cron) {
  const s = readCron(cron);
  const base = { frequency: 'manual', every: 1, minute: 0, time: '09:00', times: ['09:00'], days: ['mon'], monthDays: [1], start: null, anchored: false };
  if (s.kind === 'minutes') return { ...base, frequency: 'minutes', every: s.every, anchored: !!s.anchor };
  if (s.kind === 'hours') return { ...base, frequency: s.every === 1 ? 'hourly' : 'hours', every: s.every, minute: s.minute ?? 0, anchored: !!s.anchor };
  if (s.kind === 'days') return { ...base, frequency: 'days', every: s.every, time: s.time, times: [s.time], start: s.start };
  if (s.kind === 'monthly') return { ...base, frequency: 'monthly', monthDays: s.monthDays, time: s.times[0], times: s.times };
  if (s.kind === 'weekly') {
    const frequency = s.days.length === 7 ? 'daily' : s.days.join() === 'mon,tue,wed,thu,fri' ? 'weekdays' : 'weekly';
    return { ...base, frequency, days: s.days, time: s.times[0], times: s.times };
  }
  return base;
}

/** A File as base64, without the `data:…;base64,` preamble the server does not want. */
export function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('format.couldNotRead', { name: file.name })));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}
