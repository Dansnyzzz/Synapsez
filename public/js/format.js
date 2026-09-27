import { t } from './i18n.js';

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
  if (!cron) return t('freq.manualOnly');
  const hourly = /^hourly\s*:?(\d\d)$/.exec(cron);
  if (hourly) return t('freq.everyHourAt').replace('{m}', hourly[1]);
  const weekdays = /^weekdays\s+(.+)$/.exec(cron);
  if (weekdays) return t('freq.everyWeekdayAt').replace('{time}', weekdays[1]);
  const monthly = /^monthly\s+(\d{1,2})\s+(.+)$/.exec(cron);
  if (monthly) return t('freq.everyMonthOn').replace('{day}', monthly[1]).replace('{time}', monthly[2]);
  const weekly = /^([a-z]{3})\s+(.+)$/.exec(cron);
  if (weekly) return t('freq.everyWeekOn').replace('{day}', t(`day.${weekly[1]}`)).replace('{time}', weekly[2]);
  return t('freq.everyDayAt').replace('{time}', cron);
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
