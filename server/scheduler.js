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

/**
 * Work that happens without anyone watching.
 *
 * "Summarise the campaign every Friday at 5." The task runs as a normal agent
 * turn in a conversation of its own, so the result is somewhere you can read it
 * and carry on from — not a notification with no context behind it.
 *
 * The clock is deliberately simple: a time of day, optionally pinned to one
 * weekday. Real cron expressions are powerful and almost nobody writes them
 * correctly, and everything this is for is "every day at" or "every Monday at".
 *
 * It is, however, the *user's* clock. "17:00" used to mean 17:00 wherever the
 * server happened to be standing — UTC on a deployment — so somebody in Vietnam
 * asking for five in the afternoon got midnight, silently, forever. Each task
 * now records the zone it was written in.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// The zone arithmetic lives in util/zone.js, so the model library can ask
// "when was six this morning, where this person is" without importing the
// agent loop that this file needs.
export { validZone };

/**
 * Parse "17:00" or "fri 17:00" into the next moment it means.
 *
 * @param tz  IANA zone the time is written in. Omitted, it falls back to the
 *            server's own clock — which is only ever right by luck, so callers
 *            that have the user's zone should pass it.
 * @returns {{ cron: string|null, nextRunAt: string }} cron is null for a
 *   one-off, which is what makes it retire after running.
 */
/**
 * The repeats a person picks from a list, rather than types.
 *
 * The form used to ask for a time in words — "08:00, or fri 16:00" — which is
 * precise, learnable, and something most people get wrong once and then avoid.
 * A menu of six is what anybody expects to choose from, and each of them still
 * has to become a real recurrence: the words below are what `cron` holds, and
 * `parseSchedule` reads them back to work out when the next run is.
 *
 * `manual` is the one that is not a recurrence at all. It stores no cron and no
 * next run, so the due query — `enabled AND next_run_at <= now()` — never
 * matches it, and the task waits for the Run now button.
 */
export const FREQUENCIES = ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'];

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
  if (!FREQUENCIES.includes(choice)) {
    throw new Error(`"${frequency}" is not a frequency. Pick one of: ${FREQUENCIES.join(', ')}.`);
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

/** Which day of the week an instant falls on, in a given zone. */
function weekdayIn(date, tz) {
  const { year, month, day } = partsIn(date, tz);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function parseSchedule(input, { once = false, from = new Date(), tz = null } = {}) {
  const text = String(input || '').trim().toLowerCase();

  /**
   * The menu's own vocabulary, read back.
   *
   * `advance` re-parses whatever is in `cron` to find the next run, so every
   * word `fromFrequency` can write has to be understood here — otherwise a
   * task fires once and then throws in the scheduler, where nobody sees it.
   */
  const hourly = /^hourly\s*:?([0-5]\d)$/.exec(text);
  if (hourly) {
    const minute = Number(hourly[1]);
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setMinutes(minute);
    // Minutes and hours are the same length in every zone, so this one needs no
    // calendar walk: the next occurrence is at most an hour away.
    if (next <= from) next.setTime(next.getTime() + 3_600_000);
    return { cron: `hourly :${hourly[1]}`, nextRunAt: next.toISOString() };
  }

  const monthly = /^monthly\s+(\d{1,2})\s+(.+)$/.exec(text);
  if (monthly) {
    const wanted = Math.min(31, Math.max(1, Number(monthly[1])));
    const at = TIME.exec(monthly[2].trim());
    if (!at) throw new Error('A monthly task needs a time as HH:MM — "monthly 1 08:00".');
    const zone = validZone(tz) ? tz : null;
    const today = zone ? partsIn(from, zone) : { year: from.getFullYear(), month: from.getMonth() + 1, day: from.getDate() };

    // Up to fourteen months, because a task asking for the 31st skips the
    // months that do not have one rather than firing on the 1st of the next.
    for (let ahead = 0; ahead < 14; ahead += 1) {
      const month = today.month - 1 + ahead;
      const year = today.year + Math.floor(month / 12);
      const m = ((month % 12) + 12) % 12;
      // Day 0 of the following month is the last day of this one.
      if (wanted > new Date(Date.UTC(year, m + 1, 0)).getUTCDate()) continue;
      const when = { year, month: m + 1, day: wanted, hour: Number(at[1]), minute: Number(at[2]) };
      const instant = zone ? new Date(instantOf(when, zone)) : new Date(year, m, wanted, when.hour, when.minute, 0, 0);
      if (instant > from) return { cron: `monthly ${wanted} ${at[0]}`, nextRunAt: instant.toISOString() };
    }
    throw new Error(`Could not find a day ${wanted} in the next year.`);
  }

  // Monday to Friday at a fixed time: five weekly rules, so take the soonest.
  const weekdays = /^weekdays\s+(.+)$/.exec(text);
  if (weekdays) {
    const at = weekdays[1].trim();
    if (!TIME.test(at)) throw new Error('A weekdays task needs a time as HH:MM — "weekdays 08:00".');
    const soonest = ['mon', 'tue', 'wed', 'thu', 'fri']
      .map((day) => parseSchedule(`${day} ${at}`, { from, tz }).nextRunAt)
      .sort()[0];
    return { cron: `weekdays ${at}`, nextRunAt: soonest };
  }

  const parts = text.split(/\s+/);
  const time = parts.pop() || '';
  const day = parts.pop() || '';

  const match = TIME.exec(time);
  if (!match) {
    throw new Error('Give a time as HH:MM, optionally with a weekday first — "17:00" or "fri 17:00".');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  let weekday = -1;
  if (day) {
    weekday = WEEKDAYS.indexOf(day.slice(0, 3));
    if (weekday < 0) throw new Error(`"${day}" is not a weekday. Use mon, tue, wed, thu, fri, sat or sun.`);
  }

  const cron = once ? null : weekday >= 0 ? `${WEEKDAYS[weekday]} ${time}` : time;
  const zone = validZone(tz) ? tz : null;

  if (!zone) {
    // Server-local fallback, unchanged, for callers with no zone to offer.
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hour, minute);
    if (next <= from) next.setDate(next.getDate() + 1);
    if (weekday >= 0) {
      while (next.getDay() !== weekday) next.setDate(next.getDate() + 1);
    }
    return { cron, nextRunAt: next.toISOString() };
  }

  // Walk the calendar in the user's own zone rather than adding 24h to a
  // timestamp: "the same time tomorrow" is a calendar operation, and arithmetic
  // on the instant drifts by an hour across a daylight-saving change.
  const today = partsIn(from, zone);
  const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day));

  for (let i = 0; i < 8; i += 1) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const date = cursor.getUTCDate();
    const at = instantOf({ year, month, day: date, hour, minute }, zone);

    if (at > from && (weekday < 0 || cursor.getUTCDay() === weekday)) {
      return { cron, nextRunAt: at.toISOString() };
    }
    cursor.setUTCDate(date + 1);
  }

  // Unreachable for any real weekday — eight days always contains one of each.
  throw new Error(`Could not find a time matching "${input}" in ${zone}.`);
}

/** When a repeating task should run again after firing now. */
function advance(cron, after = new Date(), tz = null) {
  if (!cron) return null;
  // A minute past is the floor; parseSchedule then walks forward to the weekday.
  const from = new Date(after.getTime() + 60_000);
  return parseSchedule(cron, { from, tz }).nextRunAt;
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
      emit(event, data) {
        // Stored in last_status and shown in the interface, so a key quoted
        // back by a provider must not survive the trip.
        if (event === 'error') status = `error: ${redactSecrets(String(data?.message)).text.slice(0, 200)}`;
        else if (event === 'done') ending = data?.stop?.kind || data?.stopReason || null;
        // A scheduled run that stops to ask is stopped for good: the prompt goes
        // nowhere, because nobody is watching a run that happens at 3am.
        else if (event === 'approval_required') waitingForApproval = true;
      },
    });
  } catch (err) {
    status = `error: ${redactSecrets(String(err?.message)).text.slice(0, 200)}`;
  }

  status = unattendedStatus(status, ending, waitingForApproval);

  await store.finishTask(task.id, { status, chatId, nextRunAt: advance(task.cron, new Date(), task.tz) });
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
  const next = advance(task.cron, new Date(), task.tz);
  if (next) await getStore().finishTask(task.id, { status: task.last_status ?? null, chatId: task.last_chat ?? null, nextRunAt: next });
  return runTask(task);
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
