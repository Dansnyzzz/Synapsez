import { log } from './util/trace.js';
import crypto from 'node:crypto';
import { getStore, isServerless } from './store/index.js';
import { getPrefs } from './settings.js';
import { runAgent, deriveTitle } from './agent.js';
import { redactSecrets } from './redact.js';
// The same predicate the transcript uses to decide whether a reply is whole.
// An unattended run needs it more, not less. See `runTask`.
import { isComplete } from './providers/stop.js';
import { validZone, partsIn, instantOf } from './util/zone.js';
import { readCron, writeCron, readWhen, normTime, LIMITS, WEEK } from '../public/js/schedule-grammar.js';

/**
 * Work that happens without anyone watching.
 *
 * "Summarise the campaign every Friday at 5." The task runs as a normal agent
 * turn in a conversation of its own, so the result is somewhere you can read it
 * and carry on from — not a notification with no context behind it.
 *
 * Schedules are words a person can read, not cron expressions nobody writes
 * correctly: "every 10m", "days mon,wed,fri 08:00,18:00", "monthly last 09:00",
 * "every 23h @<start>". The grammar is in public/js/schedule-grammar.js, shared
 * with the panel that edits it, and every form becomes one search for the next
 * slot on a day that qualifies — see `nextSlot`.
 *
 * It is, however, the *user's* clock. "17:00" used to mean 17:00 wherever the
 * server happened to be standing — UTC on a deployment — so somebody in Vietnam
 * asking for five in the afternoon got midnight, silently, forever. Each task
 * now records the zone it was written in.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// The zone arithmetic lives in util/zone.js, so the model library can ask
// "when was six this morning, where this person is" without importing the
// agent loop that this file needs.
export { validZone };

/**
 * The frequencies the side panel offers, and the short menu the create form
 * and older callers use.
 *
 * `manual` is not a recurrence at all: it stores no cron and no next run, so
 * the due query — `enabled AND next_run_at <= now()` — never matches it, and
 * the task waits for Run now. `once` stores no cron and one next run, which is
 * what retires it after it has run.
 */
export const FREQUENCIES = ['manual', 'once', 'minutes', 'hours', 'hourly', 'daily', 'days', 'weekdays', 'weekly', 'monthly'];

/** The six a menu with nothing else on it offers; see `fromFrequency`. */
const MENU = ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'];

/**
 * Turn a chosen frequency into the schedule the store keeps.
 *
 * The time of day comes from *now*, in the person's own zone, because that is
 * what choosing "Daily" at nine in the morning means. Asking for a time as well
 * would be a second decision for a menu whose whole point is not making one.
 *
 * @returns `{ cron, nextRunAt }` — both null for `manual`.
 */
export function fromFrequency(frequency, { from = new Date(), tz = null } = {}) {
  const choice = String(frequency || '').trim().toLowerCase();
  if (!MENU.includes(choice)) {
    throw new Error(`"${frequency}" is not a frequency. Pick one of: ${MENU.join(', ')}.`);
  }
  if (choice === 'manual') return { cron: null, nextRunAt: null };

  const zone = validZone(tz) ? tz : null;
  const now = zone ? partsIn(from, zone) : { hour: from.getHours(), minute: from.getMinutes(), day: from.getDate() };
  const hh = String(now.hour).padStart(2, '0');
  const mm = String(now.minute).padStart(2, '0');

  const cron =
    choice === 'hourly'
      ? `hourly :${mm}`
      : choice === 'daily'
        ? `${hh}:${mm}`
        : choice === 'weekdays'
          ? `weekdays ${hh}:${mm}`
          : choice === 'weekly'
            ? `${WEEKDAYS[zone ? weekdayIn(from, zone) : from.getDay()]} ${hh}:${mm}`
            : `monthly ${now.day} ${hh}:${mm}`;

  return { cron, nextRunAt: parseSchedule(cron, { from, tz }).nextRunAt };
}

/**
 * A schedule chosen piece by piece — the side panel.
 *
 * Takes the pieces as given and writes the same words `parseSchedule` reads
 * back (see public/js/schedule-grammar.js), so nothing downstream knows which
 * path made the row. The pieces each frequency uses:
 *
 *   once      date "YYYY-MM-DD", time
 *   minutes   every (5–1440)
 *   hours     every (1–168), minute (0–59)       hourly: minute
 *   daily     time, or times [...]
 *   days      every (2–365), time, start "YYYY-MM-DD" (defaults to the next day the time is still ahead)
 *   weekdays  time, or times [...]
 *   weekly    days ["mon", …] or weekday "mon", time or times [...]
 *   monthly   monthDays [1, 15, "last"] or day, time or times [...]
 *
 * An interval that does not divide the day is counted from its next natural
 * start — the next minute, or the next time the clock shows `minute` — and
 * that start is kept in the words, so it cannot drift from run to run.
 *
 * @param {{ frequency?: string, time?: string, times?: string[], weekday?: string, days?: string[],
 *   day?: number|string, monthDays?: Array<number|string>, minute?: number|string, every?: number|string,
 *   date?: string, start?: string }} spec
 * @returns {{ cron: string|null, nextRunAt: string|null }}
 */
export function scheduleFrom(spec, { from = new Date(), tz = null } = {}) {
  const choice = String(spec?.frequency || '').trim().toLowerCase();
  if (!FREQUENCIES.includes(choice)) {
    throw new Error(`"${spec?.frequency}" is not a frequency. Pick one of: ${FREQUENCIES.join(', ')}.`);
  }
  if (choice === 'manual') return { cron: null, nextRunAt: null };
  const zone = validZone(tz) ? tz : null;
  const c = clock(zone);

  if (choice === 'once') {
    const time = normTime(spec.time);
    if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(String(spec.date || ''))) throw new Error('Give a date and a time for a one-off run.');
    const [y, mo, d] = String(spec.date).split('-').map(Number);
    const at = c.at(y, mo, d, Number(time.slice(0, 2)), Number(time.slice(3)));
    if (at <= from) throw new Error('That time has already passed — pick one in the future.');
    return { cron: null, nextRunAt: at.toISOString() };
  }

  const times = spec.times?.length ? spec.times : spec.time ? [spec.time] : [];
  let parts;
  if (choice === 'minutes') parts = { kind: 'minutes', every: Number(spec.every), anchor: nextMinute(from) };
  else if (choice === 'hours' || choice === 'hourly') {
    const minute = Number(spec.minute ?? String(spec.time || '').split(':')[1] ?? 0);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('An hourly repeat needs a minute from 0 to 59.');
    parts = { kind: 'hours', every: choice === 'hourly' ? 1 : Number(spec.every), minute, anchor: nextAtMinute(from, minute, zone) };
  } else if (choice === 'days') {
    const time = normTime(spec.time);
    if (!time) throw new Error('Give the time as HH:MM — "07:00".');
    parts = { kind: 'days', every: Number(spec.every), time, start: spec.start || firstDayAhead(from, time, zone) };
  } else if (choice === 'daily') parts = { kind: 'weekly', days: ['all'], times };
  else if (choice === 'weekdays') parts = { kind: 'weekly', days: ['weekdays'], times };
  else if (choice === 'weekly') parts = { kind: 'weekly', days: spec.days?.length ? spec.days : [spec.weekday], times };
  else parts = { kind: 'monthly', monthDays: spec.monthDays?.length ? spec.monthDays : [spec.day], times };

  const cron = writeCron(parts);
  return { cron, nextRunAt: parseSchedule(cron, { from, tz }).nextRunAt };
}

/** A calendar date as the store keeps it, or null. */
export function validEndDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? text : null;
}

/**
 * Whether a run would fall after the date a repeat was told to stop.
 *
 * Compared as calendar dates in the row's own zone: "until the 30th" includes
 * a run at eleven at night on the 30th, wherever the server is.
 */
export function pastEnd(nextRunAt, endsOn, tz = null) {
  if (!nextRunAt || !endsOn) return false;
  const at = new Date(nextRunAt);
  let year = at.getFullYear();
  let month = at.getMonth() + 1;
  let day = at.getDate();
  if (validZone(tz)) ({ year, month, day } = partsIn(at, tz));
  const local = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return local > endsOn;
}

/**
 * When a task or workflow row should run next after firing now — null once it
 * is a one-off, or once the next run would be past its end date.
 *
 * @param {{ cron?: string|null, tz?: string|null, ends_on?: string|null }} row
 */
export function nextRunOf(row, after = new Date()) {
  if (!row?.cron) return null;
  // A minute past is the floor; parseSchedule then walks forward to the weekday.
  const next = parseSchedule(row.cron, { from: new Date(after.getTime() + 60_000), tz: row.tz || null }).nextRunAt;
  return pastEnd(next, row.ends_on, row.tz) ? null : next;
}

/**
 * The schedule half of an edit from the side panel, for a task or a workflow.
 *
 * `schedule` re-times the row from the pieces given; `endsOn` sets or clears
 * the date it stops. An end date before the next run is refused rather than
 * accepted and silently retiring the schedule on its next firing — the panel
 * says so beside the field, which is where the mistake was made.
 *
 * @param {{ schedule?: object, endsOn?: string|null, tz?: string }} body
 * @param {{ tz?: string|null, ends_on?: string|null, next_run_at?: string|Date|null } | null} current
 */
export function schedulePatch(body, current) {
  /** @type {{ cron?: string|null, nextRunAt?: string|null, tz?: string|null, endsOn?: string|null }} */
  const patch = {};
  const tz = validZone(body?.tz) ? body.tz : current?.tz || null;
  if (body?.schedule !== undefined) Object.assign(patch, scheduleFrom(body.schedule, { tz }), { tz });
  if (body?.endsOn !== undefined) {
    if (body.endsOn === null || body.endsOn === '') patch.endsOn = null;
    else {
      const date = validEndDate(body.endsOn);
      if (!date) throw new Error('Give the end date as YYYY-MM-DD.');
      patch.endsOn = date;
    }
  }
  const endsOn = 'endsOn' in patch ? patch.endsOn : current?.ends_on;
  const next = 'nextRunAt' in patch ? patch.nextRunAt : current?.next_run_at;
  if (next && endsOn && pastEnd(next, endsOn, 'tz' in patch ? patch.tz : current?.tz)) {
    throw new Error('That end date is before the next run — pick a later one.');
  }
  return patch;
}

/** Which day of the week an instant falls on, in a given zone. */
function weekdayIn(date, tz) {
  const { year, month, day } = partsIn(date, tz);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Wall-clock arithmetic in the account's zone, or on the server's own clock
 * when there is none (which is only ever right by luck).
 *
 * Calendar days are walked as dates and each time is turned into an instant in
 * the zone, rather than adding 24h to a timestamp: "the same time tomorrow" is
 * a calendar operation, and arithmetic on the instant drifts by an hour across
 * a daylight-saving change.
 */
function clock(zone) {
  return {
    today: (from) =>
      zone
        ? partsIn(from, zone)
        : { year: from.getFullYear(), month: from.getMonth() + 1, day: from.getDate(), hour: from.getHours(), minute: from.getMinutes() },
    at: (year, month, day, hour, minute) =>
      zone ? new Date(instantOf({ year, month, day, hour, minute }, zone)) : new Date(year, month - 1, day, hour, minute, 0, 0),
  };
}

/** The start of the next whole minute after `from`. */
const nextMinute = (from) => new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000).toISOString();

/** The next instant the clock in `zone` shows `minute` past the hour. */
function nextAtMinute(from, minute, zone) {
  const c = clock(zone);
  const p = c.today(from);
  let at = c.at(p.year, p.month, p.day, p.hour, minute);
  if (at <= from) at = new Date(at.getTime() + 3_600_000);
  return at.toISOString();
}

/** Today's date in the zone if `time` is still ahead today, otherwise tomorrow's. */
function firstDayAhead(from, time, zone) {
  const c = clock(zone);
  const p = c.today(from);
  const [h, m] = time.split(':').map(Number);
  const ahead = c.at(p.year, p.month, p.day, h, m) > from ? 0 : 1;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + ahead));
  return d.toISOString().slice(0, 10);
}

/**
 * The first moment after `from` that is one of `slots` (minutes past local
 * midnight) on a day `dayOk` accepts, looking at most `maxDays` ahead.
 *
 * One search for every calendar schedule — daily, chosen weekdays, several
 * times a day, days of the month, the last day, every N days, and intervals
 * kept on the clock — so none of them has its own arithmetic to get wrong.
 */
function nextSlot(from, zone, slots, dayOk, maxDays) {
  const c = clock(zone);
  const t0 = c.today(from);
  const nowMinute = t0.hour * 60 + t0.minute;
  for (let i = 0; i < maxDays; i += 1) {
    const date = new Date(Date.UTC(t0.year, t0.month - 1, t0.day + i));
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!dayOk(y, mo, d, date.getUTCDay())) continue;
    for (const s of slots) {
      // On the first day, skip what the clock has already passed without
      // computing an instant for each: every five minutes is 288 slots a day.
      if (i === 0 && s < nowMinute) continue;
      const at = c.at(y, mo, d, Math.floor(s / 60), s % 60);
      if (at > from) return at;
    }
  }
  return null;
}

/** Minutes past midnight, from "HH:MM". */
const minuteOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** A fixed step counted from an anchor: the first multiple after `from`. */
function afterAnchor(anchorIso, stepMs, from) {
  const anchor = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchor)) throw new Error('That schedule has no valid starting time.');
  if (from.getTime() < anchor) return new Date(anchor);
  return new Date(anchor + (Math.floor((from.getTime() - anchor) / stepMs) + 1) * stepMs);
}

const INVALID = 'Give a time as HH:MM, optionally with a weekday first — "17:00" or "fri 17:00".';

/**
 * The words a schedule is kept in, or typed as, and the next moment they mean.
 *
 * Accepts every stored form (see public/js/schedule-grammar.js), what a person
 * or a model types — "every 10 minutes", "mỗi 23 giờ", "mon,wed 08:00,18:00",
 * "monthly last 09:00" — and a one-off date, "2026-10-01 09:00".
 *
 * @param tz    IANA zone the times are written in; without it the server's own clock
 * @param once  run it once at the next such moment rather than repeating
 * @returns {{ cron: string|null, nextRunAt: string }} cron is null for a
 *   one-off, which is what makes it retire after running.
 */
export function parseSchedule(input, { once = false, from = new Date(), tz = null } = {}) {
  const zone = validZone(tz) ? tz : null;
  let text = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');

  // A date and a time is always a single run.
  const oneOff = /^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}:\d{2})$/.exec(text);
  if (oneOff) {
    const time = normTime(oneOff[2]);
    if (!time) throw new Error(INVALID);
    const [y, mo, d] = oneOff[1].split('-').map(Number);
    const at = clock(zone).at(y, mo, d, Number(time.slice(0, 2)), Number(time.slice(3)));
    if (at <= from) throw new Error('That time has already passed — pick one in the future.');
    return { cron: null, nextRunAt: at.toISOString() };
  }

  // Typed words become the canonical ones, with any starting point they need.
  const typed = readWhen(text);
  if (typed) {
    if (typed.kind === 'minutes') typed.anchor = nextMinute(from);
    if (typed.kind === 'hours') {
      const minute = typed.minute ?? (typed.every === 1 || 24 % typed.every === 0 ? 0 : clock(zone).today(from).minute);
      typed.minute = minute;
      typed.anchor = nextAtMinute(from, minute, zone);
    }
    if (typed.kind === 'days') {
      const t0 = clock(zone).today(from);
      typed.time ||= `${String(t0.hour).padStart(2, '0')}:${String(t0.minute).padStart(2, '0')}`;
      typed.time = normTime(typed.time);
      if (!typed.time) throw new Error(INVALID);
      if (typed.every === 1) Object.assign(typed, { kind: 'weekly', days: ['all'], times: [typed.time] });
      else typed.start = firstDayAhead(from, typed.time, zone);
    }
    text = writeCron(typed);
  }

  const s = readCron(text);
  let next = null;

  if (s.kind === 'minutes') {
    if (!Number.isInteger(s.every) || s.every < LIMITS.minutes.min || s.every > LIMITS.minutes.max) {
      throw new Error(`Every ${LIMITS.minutes.min} minutes is the shortest repeat — a shorter one cannot be kept to.`);
    }
    if (s.anchor) next = afterAnchor(s.anchor, s.every * 60_000, from);
    else {
      const slots = Array.from({ length: 1440 / s.every }, (_, i) => i * s.every);
      next = nextSlot(from, zone, slots, () => true, 2);
    }
  } else if (s.kind === 'hours') {
    if (!Number.isInteger(s.every) || s.every < LIMITS.hours.min || s.every > LIMITS.hours.max) {
      throw new Error(`The number of hours must be a whole number from ${LIMITS.hours.min} to ${LIMITS.hours.max}.`);
    }
    if (s.anchor) next = afterAnchor(s.anchor, s.every * 3_600_000, from);
    else {
      const slots = Array.from({ length: 24 / s.every }, (_, i) => i * s.every * 60 + s.minute);
      next = nextSlot(from, zone, slots, () => true, 2);
    }
  } else if (s.kind === 'days') {
    const [sy, sm, sd] = s.start.split('-').map(Number);
    const start = Date.UTC(sy, sm - 1, sd);
    const dayOk = (y, mo, d) => {
      const gap = Math.round((Date.UTC(y, mo - 1, d) - start) / 86_400_000);
      return gap >= 0 && gap % s.every === 0;
    };
    // Far enough to reach a start that is still ahead, then two whole cycles.
    const t0 = clock(zone).today(from);
    const lead = Math.max(0, Math.round((start - Date.UTC(t0.year, t0.month - 1, t0.day)) / 86_400_000));
    next = nextSlot(from, zone, [minuteOf(s.time)], dayOk, lead + s.every * 2 + 2);
  } else if (s.kind === 'weekly') {
    if (!s.days?.length || !s.times?.length) throw new Error(INVALID);
    const wanted = new Set(s.days);
    next = nextSlot(from, zone, s.times.map(minuteOf), (y, mo, d, dow) => wanted.has(WEEK[(dow + 6) % 7]), 8);
  } else if (s.kind === 'monthly') {
    if (!s.monthDays?.length || !s.times?.length) throw new Error('A monthly task needs a time as HH:MM — "monthly 1 08:00".');
    const days = new Set(s.monthDays);
    const lastOf = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
    // Up to fourteen months ahead: the 31st skips the months that have none
    // rather than firing on the 1st of the next.
    next = nextSlot(from, zone, s.times.map(minuteOf), (y, mo, d) => days.has(d) || (days.has('last') && d === lastOf(y, mo)), 430);
  } else {
    throw new Error(INVALID);
  }

  if (!next) throw new Error(`Could not find a time matching "${input}".`);
  // Kept in the canonical words — "9:05" as "09:05", an anchor as a proper ISO instant.
  return { cron: once ? null : writeCron(s) || text, nextRunAt: next.toISOString() };
}

/**
 * Run one task to completion in its own conversation.
 *
 * Errors are recorded rather than thrown: a scheduler that dies because one
 * task failed stops running every other task too.
 */
/**
 * What a finished unattended run should say about itself.
 *
 * Separated from `runTask` because it is the part worth pinning and `runTask`
 * needs a store, an account and a live model to drive. The rule is small and
 * the consequence is not: `last_status` is the only signal an unattended run
 * produces — nobody watched the stream, and the transcript is read only if
 * something prompts you to look. `ok` is what stops anybody looking.
 *
 * @param status  what the run already decided — an `error:` line wins, because
 *                it says more than any of this can.
 * @param ending  the normalised stop kind from `providers/stop.js`.
 * @param waiting whether the run halted to ask for an approval.
 */
export function unattendedStatus(status, ending, waiting) {
  if (String(status).startsWith('error:')) return status;
  // A prompt raised at 3am goes nowhere. The run is over, not pending.
  if (waiting) return 'stopped: waiting for an approval nobody was there to give';
  if (ending && !isComplete(ending)) return `stopped: ${ending}`;
  return status;
}

async function runTask(task) {
  const store = getStore();
  const user = await store.getUserById(task.user_id);
  // The account was deleted between the claim and now. Retire the task rather
  // than leaving it to be re-claimed and fail identically every hour.
  if (!user) {
    await store.finishTask(task.id, { status: 'error: account no longer exists', chatId: null, nextRunAt: null });
    return { taskId: task.id, status: 'orphaned', chatId: null };
  }

  const prefs = await getPrefs(user.id);

  /**
   * One conversation per task, not one per run.
   *
   * An hourly task made twenty-four conversations a day. Each run now adds to
   * the one the last run wrote, so the sidebar holds the task once and its
   * history reads top to bottom; a task that has never run, or whose
   * conversation was deleted, gets a fresh one.
   */
  const reuse = task.last_chat && (await store.getChat(user.id, task.last_chat)) ? task.last_chat : null;
  const chatId = reuse || crypto.randomUUID();

  /**
   * `ok` has to be earned, not assumed.
   *
   * This opened at `ok` and only an `error` event or a throw moved it. Nothing
   * else did — so a run that exhausted its step budget, or came back
   * `truncated`, `refused` or `filtered`, or halted for an approval nobody was
   * there to give, was recorded as a success. `last_status` is the **only**
   * signal an unattended run produces: there is no `emit` consumer, nobody
   * watched the stream, and the transcript is only read if something prompts
   * you to look. Saying `ok` is what stops anybody looking.
   *
   * The vocabulary already exists — `providers/stop.js` was written to give
   * this app one word for how a reply ended, and `isComplete` is its own
   * predicate for "the reply in front of the user is whole". The interactive
   * transcript uses it. The unattended path, where it matters more, did not.
   */
  let status = 'ok';
  let ending = null;
  let waitingForApproval = false;

  try {
    if (!reuse) {
      await store.createChat(user.id, {
        id: chatId,
        title: deriveTitle(task.title) || task.title,
        model: task.model || prefs.defaultModel,
        // A task made inside a project runs inside it: same standing
        // instructions, same shelf. Without this, "summarise this week's filings"
        // answered from nothing at all — which is worse than failing, because it
        // looks like it worked.
        projectId: task.project_id || null,
      });
    }
    await store.appendMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'user',
      text: task.prompt,
    });
    // Known from the start, so the conversation shows as running in the sidebar.
    await store.markTaskChat(task.id, chatId);

    // No `emit` consumer here — nobody is watching. The transcript in the
    // database is the output, which is the point: it is waiting when you look.
    await runAgent({
      userId: user.id,
      user,
      chatId,
      modelId: task.model || prefs.defaultModel,
      // What this run may do unwatched. The task's own choice where it made
      // one, the account's default otherwise — see `policyFor` in the loop.
      policy: task.policy || null,
      unattended: true,
      emit(event, data) {
        // Stored in last_status and shown in the interface, so a key quoted
        // back by a provider must not survive the trip.
        if (event === 'error') status = `error: ${redactSecrets(String(data?.message)).text.slice(0, 200)}`;
        else if (event === 'done') ending = data?.stop?.kind || data?.stopReason || null;
        // A scheduled run that stops to ask is stopped for good: the prompt goes
        // nowhere, because nobody is watching a run that happens at 3am.
        else if (event === 'approval_required' || event === 'question_required') waitingForApproval = true;
      },
    });
  } catch (err) {
    status = `error: ${redactSecrets(String(err?.message)).text.slice(0, 200)}`;
  }

  status = unattendedStatus(status, ending, waitingForApproval);

  // Only a task that had a schedule can run out of one; a manual task has
  // no next run and stays on.
  const retire = !!(task.cron || task.next_run_at);
  await store.finishTask(task.id, { status, chatId, nextRunAt: nextRunOf(task), retire });
  return { taskId: task.id, status, chatId };
}

/**
 * Run one task immediately, regardless of when it was next due.
 *
 * The only way a manual task ever runs, and how anybody checks a scheduled one
 * does what they meant without waiting until morning. It goes through the same
 * `runTask` as the scheduler so there is exactly one description of what a run
 * is — a second path would drift, and the one that drifts is always the one
 * nobody is watching.
 */
export async function runTaskNow(task) {
  /**
   * A run by hand does not make the schedule fire again a moment later.
   *
   * `next_run_at` is very often already in the past — that is what being due
   * means — and `runTask` sets it forward from *now* when it finishes, so this
   * mostly sorts itself out. Mostly is not good enough: if the manual run fails
   * before it gets there, the old, passed time is still sitting in the row and
   * the next sweep starts the whole thing again automatically. Moving it first
   * means the worst case is a skipped occurrence rather than a surprise repeat
   * of a job that sends email.
   */
  // The claim both moves the schedule on and takes the lease, in one statement.
  // It used to clear the lease instead, which let this run start beside one the
  // cron was already holding.
  const claimed = await getStore().claimTask(task.user_id, task.id, { nextRunAt: nextRunOf(task) });
  if (!claimed) return { taskId: task.id, status: 'busy', chatId: task.last_chat ?? null };
  return runTask(claimed);
}

/**
 * Run everything that is due. Returns what it ran, so a cron endpoint can
 * report it and a test can assert on it.
 */
export async function runDueTasks({ limit = 5, userId = null, budgetMs = null } = {}) {
  const ran = [];
  const started = Date.now();

  /**
   * Stop claiming when there is no room left to finish one.
   *
   * `limit` alone is a count, and a count is the wrong unit here: each task is a
   * whole agent turn of up to `maxSteps` steps, and five of those cannot fit in
   * a 300-second invocation. The route below this already computes a budget and
   * threaded it into `runDueWorkflows` while handing tasks none at all — so the
   * tasks ran until the function was killed, and whatever was left of the
   * budget for workflows was nothing.
   *
   * Checked *before* claiming rather than after, because a claim marks the task
   * as running and starts its lease. Claiming one there is no time to run is how
   * a task ends up needing a person to look at it for no reason.
   */
  const roomLeft = () => budgetMs == null || Date.now() - started < budgetMs;

  for (let i = 0; i < limit && roomLeft(); i += 1) {
    const task = await getStore().claimDueTask(new Date().toISOString(), userId);
    if (!task) break;
    ran.push(await runTask(task));
  }
  return ran;
}

/**
 * Catch-up for a deployment whose cron cannot fire often enough.
 *
 * Vercel's free tier allows one cron a day, which is not a scheduler: a task set
 * for this afternoon would otherwise wait until tomorrow. So opening the app
 * also nudges the queue along, for that account only.
 *
 * The awkward part is *where* this runs. The obvious version — kick it off
 * during `/bootstrap` and let the response go — does not work on a serverless
 * host: the instance is frozen once the response is sent, so a task could be
 * abandoned halfway through, having created its conversation, spent the tokens,
 * and written no answer. Worse, it would be re-run later and do it all again.
 *
 * So the browser calls this on its own endpoint and simply does not wait for the
 * reply. The request staying open is what keeps the function alive long enough
 * to finish honestly, and nobody is watching the response either way.
 *
 * @param userId  whose tasks — never a sweep of everybody's from a user request
 */
export async function runDueTasksForUser(userId, { limit = 2 } = {}) {
  if (!userId) return [];

  /**
   * Reap this account's stalled tasks before claiming any more.
   *
   * `reapStalledTasks` lived only inside `sweep()`, and on a deployment `sweep`
   * runs only from the cron — once a day on Vercel's free tier. So a task whose
   * invocation was killed mid-run stayed marked `running` for up to
   * twenty-four hours, holding a lease, neither retried nor reported to the
   * person waiting on it.
   *
   * This path already exists to nudge an account's queue when the app is
   * opened, which is a far better cadence. Scoped to the caller, because the
   * route above is explicit that a user request must never sweep everybody's
   * queue — the cron does that, and it has its own secret.
   *
   * Never fatal: failing to tidy is not a reason to refuse to run the work.
   */
  await getStore().reapStalledTasks(userId).catch(() => {});

  return runDueTasks({ limit, userId });
}

/**
 * Everything that has to be thrown away, in one place.
 *
 * Each of these had a function written for it and — for three of the four —
 * nothing that ever called it. That is the quiet kind of bug: the code reads as
 * though the tidying happens, the tables grow anyway, and nobody notices until
 * a database is unaccountably large.
 *
 *   rate_limits   expired throttle counters
 *   pairings      codes nobody claimed
 *   attachments   files picked, then thought better of, and never sent
 *   tool_jobs     the arguments and full output of every tool call ever made
 *
 * Failures are swallowed on purpose: housekeeping must never be the reason a
 * scheduler stops running work.
 */
export async function sweep() {
  const store = getStore();
  await Promise.allSettled([
    store.pruneRateLimits(),
    store.prunePairings(),
    store.pruneOrphanAttachments(),
    store.pruneFinishedJobs(),
    // Both write a few kilobytes per run and nothing was removing either. The
    // list above exists because three of its four pruners had been written and
    // never called; adding a fifth without calling it would be the same bug with
    // a different name.
    store.pruneWorkflowRuns(),
    store.pruneResearchRuns(),
    // One row per model call per role, never removed — and `checkQuota` sums a
    // whole month of them before every single turn.
    store.pruneUsageEvents(),
    // A task whose invocation was killed mid-run is stopped for a person rather
    // than left to re-claim itself every hour for ever.
    store.reapStalledTasks(),
  ]);
}

let timer = null;

/**
 * Poll for due work on a locally-run server.
 *
 * Serverless gets nothing here — there is no process to keep a timer in, so a
 * deployment schedules through the cron endpoint instead. A minute of latency
 * is irrelevant for something scheduled hours ahead.
 */
export function startScheduler() {
  if (timer || isServerless()) return;
  timer = setInterval(() => {
    runDueTasks().catch((err) => log.error('scheduled tasks failed', err));
    // Caught, like the line above it. `Promise.allSettled` absorbs the query
    // failures inside `sweep`, but a missing store method — a store that has
    // drifted from this file — would throw before reaching it, and an
    // unhandled rejection every sixty seconds takes the process down on Node.
    sweep().catch((err) => log.error('sweep failed', err));
  }, 60_000);
  timer.unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
