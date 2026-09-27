import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  loginUser,
  registerUser,
  clearSession,
  currentUser,
  requireAuth,
  requireAdmin,
  requireWorker,
  requireCron,
  signupOpen,
  requestPasswordReset,
  resetPassword,
  changePassword,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  refreshSession,
} from './auth.js';
import { limit as rateLimit, forgive } from './ratelimit.js';
import { publicUrlFor } from './util/net.js';
import { emailBackend } from './email.js';
import { summary as usageSummary, limitFor } from './usage.js';
import { getPrefs, setPrefs, setApiKey, addApiKey, removeApiKey, providerStatus, DEFAULT_PREFS } from './settings.js';
import { getStore, initStore, isServerless } from './store/index.js';
import { RUN_LEASE_STALE_MS } from './store/pg.js';
import { workerStatus, usesInProcessTools, handleIndexPayload } from './localTools.js';
import { publish, subscribe, poll, forget as forgetScreen } from './screenHub.js';
import { PROVIDERS } from './providers/catalog.js';
import {
  browse,
  refreshLibrary,
  refreshIfStale,
  addModelById,
  resolve as resolveModelId,
  auditCatalog,
} from './models.js';
import { TOOLS } from './tools/definitions.js';
import { executeTool } from './tools/execute.js';
import { runAgent } from './agent.js';
import { saveSkill } from './skills.js';
import { addSource } from './projects.js';
import {
  parseSchedule,
  fromFrequency,
  runDueTasks,
  runDueTasksForUser,
  runTaskNow,
  validZone,
  sweep,
} from './scheduler.js';
import { runDueWorkflows } from './workflows.js';
import { redactSecrets } from './redact.js';
import { withTrace, newTraceId, annotate, log, mark, since } from './util/trace.js';
import {
} from './artifactStorage.js';
import {
  startPairing,
  collectPairing,
  claimPairing,
  listDevices,
  revokeDevice,
  setDeviceWorkspace,
  localPairingCode,
  startEnrolment,
  previewEnrolment,
  redeemEnrolment,
} from './devices.js';
import { pendingAnnouncement, decideAnnouncement, markAnnouncementShown } from './modelNews.js';
import {
  keepStepShot,
  LIMITS as ATTACHMENT_LIMITS,
} from './attachments.js';
import { mountWorkspaceRoutes } from './routes/workspace.js';
import { mountMcpRoutes } from './routes/mcp.js';
import { mountChatRoutes } from './routes/chats.js';
import { mountFileRoutes } from './routes/files.js';
import { mountWorkflowRoutes } from './routes/workflows.js';
import { mountConnectorRoutes } from './routes/connectors.js';
import { translateErrors, translateEvent, languageOf } from './i18n/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A provider's failure, in words rather than in JSON.
 *
 * What reached the screen was the raw body — `{"error":{"message":"{\n
 * \"error\": {\n \"code\": 404, …` — nested two deep because Google's SDK puts
 * the response text inside the message of its own error object. Somewhere in
 * there was the one sentence that mattered: *this model is no longer available
 * to new users*. Everything else was punctuation.
 *
 * So the JSON is unwrapped as far as it goes and the innermost message is what
 * is shown, with the model named where the provider named it. A person reading
 * this should be able to tell in one line whether to change the model, top up
 * the account, or wait.
 */
/**
 * Turn a provider failure into something a person can act on — with any
 * credential taken out of it first.
 *
 * The redaction is not belt-and-braces. A provider client that is handed a
 * malformed key reports it by quoting the value back: `Headers.append: "Bearer
 * sk-or-v1-…" is an invalid header value`. That string is emitted to the browser
 * over SSE, stored as a step's error, and read back to the model by
 * `workflow_status` — so one bad key would put itself in the conversation, in
 * the database, and in the next prompt.
 *
 * `redactSecrets` already knew every shape that matters; it was only ever wired
 * to memory writes, which is the one place a secret was *expected* to appear.
 * This is the place it appears by accident, which is the worse one.
 */
/**
 * A failure that means "this model is not there any more".
 *
 * Deliberately wider than a status code. A provider that has retired a model
 * answers 404 with prose — a thank-you for taking part in a preview, a pointer
 * at the successor — and none of it parses as an error; `deprecat` and
 * `retired` and `testing period` are the words those notices actually use.
 * Everything here has been seen in the wild from Google, OpenAI or OpenRouter.
 */
const MODEL_GONE =
  /no longer available|is not found|not found for api version|does not exist|no longer supported|has been (?:retired|deprecated|shut down)|deprecat\w*|testing period/i;

/**
 * The zone to read "six this morning" in: the account's own setting, else the
 * one the browser reported, else none (UTC). Never throws — it only decides
 * whether a refresh is due.
 */
async function zoneOf(req, prefs = null) {
  try {
    const own = (prefs || (await getPrefs(req.user.id)))?.timezone;
    if (own) return own;
  } catch {
    /* fall through to the browser's */
  }
  const asked = typeof req.query?.tz === 'string' ? req.query.tz.slice(0, 64) : '';
  return asked || null;
}

export function readableFailure(error) {
  let message = redactSecrets(String(error?.message || error || 'Something went wrong.')).text;

  // Unwrap as many layers of encoded JSON as the providers have nested.
  for (let depth = 0; depth < 4; depth += 1) {
    const start = message.indexOf('{');
    if (start === -1) break;
    let parsed;
    try {
      parsed = JSON.parse(message.slice(start));
    } catch {
      break;
    }
    const inner = parsed?.error?.message || parsed?.error?.detail || parsed?.message || parsed?.error;
    if (typeof inner !== 'string' || inner === message) break;
    message = inner;
  }

  message = message.replace(/\s+/g, ' ').trim();

  // The one failure worth rewriting: a model that is gone reads as a mistake
  // the user made, and it is not — it is a catalogue entry that expired.
  if (MODEL_GONE.test(message)) {
    const model = /models\/([\w.-]+)/.exec(message)?.[1];
    /**
     * Aggregators announce a withdrawal in the body of the 404 rather than in
     * its status, and they do it chattily: "Thank you for participating in the
     * Stealth Ox Alpha testing period. This model was ZAI's GLM-5.3 Flash. Use
     * it now: https://openrouter.ai/z-ai/glm-5.3-flash". That arrived on screen
     * as a red box, verbatim, in English, in front of somebody who had done
     * nothing but press send — and it repeated on every attempt, because the
     * model is stored on the account and nothing about the message said so.
     *
     * The successor is worth keeping when the notice names one: it is the whole
     * of the useful content, and "pick another model" without it means reading a
     * list of four hundred.
     */
    const successor = /https?:\/\/openrouter\.ai\/(?:models\/)?([\w.\-/:]+)/i.exec(message)?.[1];
    /*
     * Two whole sentences rather than one assembled from parts, because these
     * are read by somebody who may not read English. `server/i18n` matches a
     * message against known shapes, and a shape is a literal with `{0}` holes in
     * it — a sentence built with `.join(' ')` matches nothing and arrives in
     * English. Both shapes below have an entry in `server/i18n/vi.js`.
     */
    const named = model ? `"${model}"` : 'The model this account uses';
    if (successor) {
      return `${named} is no longer available — whoever was serving it withdrew it, and nothing you did caused this. Its provider names "${successor}" as the replacement. Pick another model from the chip in the header.`;
    }
    return `${named} is no longer available — whoever was serving it withdrew it, and nothing you did caused this. Pick another model from the chip in the header.`;
  }

  return message;
}

// `public/` is also what Vercel serves straight from its CDN in a zero-config
// project, so on a deployment these static routes are only a local fallback.
const WEB_DIR = path.resolve(here, '../public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  /**
   * Trust exactly one proxy, not the whole chain.
   *
   * `true` trusts every hop in `X-Forwarded-For`, and the leftmost entry of that
   * header is whatever the *client* put there — so `req.ip` became a value the
   * caller chose. That is harmless for logging and fatal for a rate limiter: a
   * new forged address per attempt is an unlimited number of attempts.
   *
   * One hop is the truth for both deployments this app has: Vercel's edge, or a
   * Cloudflare tunnel. With nothing in front, `req.ip` is the socket address and
   * this setting changes nothing.
   */
  app.set('trust proxy', 1);
  // Before the body parser, so the error it raises for an oversized body is
  // translated too — see server/i18n.
  app.use(translateErrors);
  // Attachments arrive as base64 inside the JSON body, and base64 costs a third
  // more than the bytes it carries. Six files at the 5MB-each limit is the worst
  // case this has to accept without a confusing 413.
  app.use(express.json({ limit: '48mb' }));

  /**
   * Baseline response headers.
   *
   * The app has no build step and no third-party scripts, so a strict policy
   * costs nothing here and closes the usual holes: an injected `<script>` has
   * nowhere to load from, the page cannot be framed, and a URL is never leaked
   * to another origin through the referrer.
   *
   * `'unsafe-inline'` covers the inline `style=` attributes the UI sets for
   * layout measurements; script-src has no such escape hatch, which is the half
   * that matters.
   */
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
    // Only over TLS: sending HSTS from a plain-HTTP LAN address would make the
    // phone that saw it refuse to reach the app at all.
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  /**
   * Whether a turn is live in this conversation right now.
   *
   * Measured against the same staleness the lease itself uses, so a route that
   * refuses mid-run and the claim that decides who is running can never
   * disagree — they did, by 45 seconds, and in that window a chat could be
   * claimed by a new run while still refusing message edits.
   */
  const isRunning = (chat) =>
    !!chat?.run_lock_at && Date.now() - new Date(chat.run_lock_at).getTime() < RUN_LEASE_STALE_MS;

  /**
   * What a scheduled run may do without being asked.
   *
   * The same three words the loop already understands, narrowed to the ones a
   * task can sensibly choose: a run at 3am cannot be asked anything, so `ask`
   * means "stop at the first risky step" rather than "prompt", and the form
   * says exactly that. Anything else is ignored and the account default wins,
   * which is the safe direction to fail in.
   */
  const TASK_POLICIES = new Set(['ask', 'guarded', 'auto']);

  /** `req.body` is undefined in Express 5 when no JSON arrived — never assume it. */
  const body = (req) => req.body || {};

  /**
   * One id, in scope for everything this request goes on to do.
   *
   * An agent turn fans out through the loop, the provider adapters, the tool
   * executor, a queue the user's own machine reads, and back — and until this
   * there was nothing to join those records on. Held in `AsyncLocalStorage` so
   * no function underneath has to accept it as a parameter; threading it through
   * forty signatures is how this kind of thing gets half done and abandoned.
   *
   * A caller's own `x-request-id` is honoured so a browser can correlate its
   * side too, but never trusted verbatim: it lands in log lines, and a header is
   * whatever the caller typed.
   */
  app.use((req, res, next) => {
    const supplied = String(req.headers['x-request-id'] || '').replace(/[^\w-]/g, '').slice(0, 64);
    const requestId = supplied || newTraceId();
    res.setHeader('X-Request-Id', requestId);
    withTrace({ requestId, method: req.method, path: req.path }, () => next());
  });

  // Every request waits for the schema to be ready. On Vercel each invocation
  // may be a cold one, so this cannot happen once at startup.
  app.use(wrap(async (req, res, next) => {
    await initStore();
    next();
  }));

  /** The subset of a user row the browser is allowed to see. */
  const publicUser = (user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: !!user.email_verified_at,
    twoFactor: !!user.totp_enabled_at,
    recoveryCodesLeft: Array.isArray(user.recovery_codes) ? user.recovery_codes.length : 0,
  });

  // ── session ─────────────────────────────────────────────────────────
  app.get(
    '/api/session',
    wrap(async (req, res) => {
      const store = getStore();
      const user = await currentUser(req).catch(() => null);
      res.json({
        authed: !!user,
        user: user ? publicUser(user) : null,
        // Drives whether the gate offers "create the first account".
        needsSetup: (await store.countUsers()) === 0,
        signupOpen: signupOpen(),
        emailBackend: emailBackend(),
      });
    }),
  );

  // Throttled on two axes at once — the caller's address and the email being
  // tried — so one person grinding one account cannot lock out an office behind
  // the same address, and a botnet spread across addresses still hits the
  // per-account ceiling.
  app.post(
    '/api/login',
    rateLimit('login', (req) => req.body?.email),
    wrap(async (req, res) => {
      try {
        const user = await loginUser(body(req), req, res);
        if (!user) return res.status(401).json({ error: 'Wrong email or password.' });
        // A correct sign-in clears the tally, so a forgetful morning does not
        // cost somebody their afternoon.
        await forgive(req, 'login', req.body?.email);
        res.json({ user: publicUser(user) });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message, code: err.code });
      }
    }),
  );

  // ── password reset ──────────────────────────────────────────────────
  app.post(
    '/api/password/forgot',
    rateLimit('forgot', (req) => req.body?.email),
    wrap(async (req, res) => {
      // Always the same answer, so this cannot be used to discover who has an
      // account here.
      await requestPasswordReset(req.body?.email, req);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/password/reset',
    rateLimit('reset', (req) => req.body?.email),
    wrap(async (req, res) => {
      try {
        await resetPassword({
          token: req.body?.token,
          code: req.body?.code,
          email: req.body?.email,
          password: req.body?.password,
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── daily model-library refresh ─────────────────────────────────────
  // Called by Vercel Cron, not a browser, so it authenticates with a secret.
  app.get(
    '/api/cron/refresh-models',
    requireCron,
    wrap(async (req, res) => {
      res.json(await refreshLibrary());
    }),
  );

  // Scheduled work, for a deployment with no long-lived process to hold a
  // timer. A local run polls for itself; see server/scheduler.js.
  app.get(
    '/api/cron/run-tasks',
    requireCron,
    wrap(async (req, res) => {
      // Also the deployment's only chance to take the bins out: the local
      // scheduler sweeps on its minute tick, and a deployment has no minute
      // tick. Without this, four tables grow without bound.
      // The 300s ceiling is for the whole invocation, not per phase. Sweeping
      // and then running up to five full agent turns can spend most of it, so
      // what workflows get is what is *left* — handing them a fresh budget is
      // how the function gets killed with a run in mid-step, which is the exact
      // failure workflows exist to avoid.
      const started = Date.now();
      const remaining = () => Math.max(0, 240_000 - (Date.now() - started));

      await sweep().catch(() => {});
      // Tasks get a budget too. Without one they ran until the invocation was
      // killed, which both left a task marked mid-run and guaranteed workflows
      // inherited nothing — the very thing `remaining()` was written to prevent.
      // Two thirds to tasks, so a long queue cannot starve the workflows below.
      const ran = await runDueTasks({ budgetMs: Math.floor(remaining() * 0.66) });

      // Workflows share this heartbeat rather than adding a second cron: the
      // free tier allows one a day, and spending it twice is not an option. A
      // run that does not finish is resumed by the next nudge, not restarted.
      const workflows = await runDueWorkflows({ budgetMs: remaining() }).catch((err) => ({
        started: [],
        advanced: [],
        error: String(err?.message || err).slice(0, 200),
      }));
      res.json({ ran, workflows });
    }),
  );

  app.post(
    '/api/register',
    rateLimit('register'),
    wrap(async (req, res) => {
      try {
        const user = await registerUser(body(req), req, res);
        res.status(201).json({ user: publicUser(user), emailBackend: emailBackend() });
      } catch (err) {
        // A closed deployment is a 403, not a bad request — the client can tell
        // "you may not" from "you got that wrong" and say something useful.
        res.status(err.status || 400).json({ error: err.message });
      }
    }),
  );

  app.post(
    '/api/logout',
    wrap(async (req, res) => {
      // Drop the stored frame on the way out. It is a photograph of the person's
      // actual desktop, and leaving it in the database for the next sign-in to
      // find is not something anybody asked for.
      const user = await currentUser(req).catch(() => null);
      if (user) {
        forgetScreen(user.id);
        await getStore().clearScreen(user.id).catch(() => {});
      }
      clearSession(res);
      res.json({ ok: true });
    }),
  );

  // ── worker relay (bearer token identifies whose computer is calling) ─
  const workerApi = express.Router();
  workerApi.use(requireWorker);

  workerApi.post(
    '/heartbeat',
    wrap(async (req, res) => {
      const { workerId, info } = req.body || {};
      const store = getStore();

      // A paired machine is identified by its device row, so the id it reports
      // is ignored in favour of the one its token proves. Only a legacy worker,
      // paired before devices existed, still names itself.
      const id = req.workerDevice?.id || workerId;
      if (!id) return res.status(400).json({ error: 'workerId is required' });

      await store.heartbeat(req.workerUser.id, id, info || {});
      await store.touchDevice(req.workerUser.id, req.workerDevice?.id, info || {});

      // The reply is how a setting made in the app reaches the machine. There is
      // no inbound connection to push it down, and there does not need to be:
      // the worker is already asking every fifteen seconds.
      const device = req.workerDevice?.id
        ? await store.getDevice(req.workerUser.id, req.workerDevice.id)
        : null;

      res.json({
        ok: true,
        account: req.workerUser.email,
        device: req.workerDevice?.name || null,
        /**
         * Which row this token belongs to.
         *
         * The worker cannot know: it only learns an id during pairing, and a
         * machine that starts with a token already saved skips pairing entirely
         * and keeps the random placeholder it generated at boot. That
         * placeholder was then what it told the browser it was — an id matching
         * no device on the account, so "work on the computer I am sitting at"
         * matched nothing and quietly did nothing at all.
         */
        deviceId: req.workerDevice?.id || null,
        config: { workspace: device?.workspace ?? null },
      });
    }),
  );

  /**
   * Long-poll so the worker reacts in well under a second without hammering the
   * database. Jobs are claimed for this worker's owner only, and — once an
   * account can hold several computers — only those addressed to this one or to
   * no one in particular.
   *
   * **How long to hold depends on whether anybody is waiting.**
   *
   * Holding a request open for 25 seconds is free on a machine you own, and it
   * is the reason a tool call feels instant. On a serverless deployment it is 25
   * seconds of billed execution — and a worker left running overnight repeats it
   * roughly 3,400 hours a month, which is not a rounding error against a free
   * tier, it is the whole allowance spent on an idle laptop.
   *
   * So an account with recent work gets the full hold, because somebody is
   * sitting there watching. An idle account is answered immediately with a
   * `sleepMs` the worker honours, and the function stops running in between.
   *
   * The cost is stated plainly rather than hidden: the *first* tool call after a
   * quiet spell can wait up to `sleepMs` extra. Every call after it is at full
   * speed, since by then the account counts as busy. Set WORKER_IDLE_SLEEP_MS=0
   * to switch the behaviour off entirely.
   */
  const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
  const IDLE_SLEEP_MS = Math.max(
    0,
    Number(process.env.WORKER_IDLE_SLEEP_MS ?? (isServerless() ? 4000 : 0)) || 0,
  );

  workerApi.get(
    '/jobs',
    wrap(async (req, res) => {
      const store = getStore();
      const deviceId = req.workerDevice?.id || null;

      if (IDLE_SLEEP_MS > 0) {
        const lastAt = await store.recentJobAt(req.workerUser.id).catch(() => null);
        const busy = lastAt && Date.now() - lastAt.getTime() < ACTIVE_WINDOW_MS;
        if (!busy) {
          // One claim before sleeping, so a job queued in the gap is not made to
          // wait for the sleep it just missed.
          const job = await store.claimJob(req.workerUser.id, deviceId);
          return res.json(job ? { job } : { job: null, sleepMs: IDLE_SLEEP_MS });
        }
      }

      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && !req.socket.destroyed) {
        const job = await store.claimJob(req.workerUser.id, deviceId);
        if (job) return res.json({ job });
        await new Promise((r) => setTimeout(r, 600));
      }
      res.json({ job: null });
    }),
  );

  // A frame from the account's browser sandbox or desktop mirror. The reply
  // tells the worker whether anyone actually has the panel open, so an
  // unwatched machine stops burning bandwidth on nobody.
  workerApi.post(
    '/screen',
    wrap(async (req, res) => {
      const { frame, ...meta } = req.body || {};
      const { watching } = await publish(req.workerUser.id, frame, meta);
      res.json({ ok: true, watching });
    }),
  );

  // Chunked documents from the machine, on their way to being embedded. The
  // token says whose files these are, and that is the only account they can ever
  // be stored under or searched from.
  workerApi.post(
    '/index',
    wrap(async (req, res) => {
      try {
        res.json(await handleIndexPayload(req.workerUser.id, req.body || {}));
      } catch (err) {
        // The worker turns this into the tool's error text, so it has to say
        // something a person can act on — "add an OpenAI key", not "HTTP 500".
        res.status(400).json({ error: err.message });
      }
    }),
  );

  workerApi.post(
    '/jobs/:id/result',
    wrap(async (req, res) => {
      const { output, error, shot } = req.body || {};
      await getStore().completeJob(req.workerUser.id, req.params.id, {
        // A job the server already closed — cancelled, or timed out and
        // answered — keeps that record. A late result arriving after the stop
        // would otherwise rewrite `cancelled` into `done`.
        onlyIfOpen: true,
        status: error ? 'error' : 'done',
        // The picture is stored as an attachment and referenced by id — never
        // written into this row. A browsing session is dozens of these, and
        // inlining them would put megabytes of base64 into the transcript that
        // gets read back on every reload.
        result: error ? { error } : { output, ...(shot ? { shot: await keepStepShot(req.workerUser.id, shot) } : {}) },
      });
      res.json({ ok: true });
    }),
  );

  /**
   * A running job asks whether it has been called off (AUTO-009).
   *
   * There is no way to push to a worker — every connection is one it opened —
   * so while a job runs it asks here every few seconds, and stops if the answer
   * is no longer `running`. Scoped to the worker's own account: a job id from
   * somebody else's queue answers 404, the same as one that never existed, so
   * this cannot be used to learn whether another account's job is live.
   */
  workerApi.get(
    '/jobs/:id',
    wrap(async (req, res) => {
      const job = await getStore().getJob(req.workerUser.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'No such job.' });
      return res.json({ status: job.status });
    }),
  );

  app.use('/api/worker', workerApi);

  // ── pairing a computer ──────────────────────────────────────────────
  //
  // These two are deliberately unauthenticated, because a computer that has
  // never been paired has nothing to authenticate with. They are also the only
  // unauthenticated endpoints that write anything, so be precise about what they
  // can do: ask to be adopted, and ask whether anyone has adopted them. Neither
  // names an account, reads anything, or has any effect until somebody who *is*
  // signed in types the code into the app.
  app.post(
    '/api/pair/start',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const { id, code, expiresInSec } = await startPairing({
        deviceName: req.body?.name,
        info: req.body?.info,
      });
      res.status(201).json({ id, code, expiresInSec });
    }),
  );

  app.get(
    '/api/pair/poll',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const outcome = await collectPairing(req.query.id);
      // The token is in here exactly once, on the one poll that follows the
      // claim. After that the pairing row is gone and this answers 'unknown'.
      res.json(outcome);
    }),
  );

  /**
   * Redeem a setup link. Unauthenticated because the token *is* the credential —
   * the same reasoning as the two routes above, and the same rate limit.
   *
   * Two phases through one endpoint, and the split is the security design rather
   * than an API convenience. Without `confirm` it answers "this token belongs to
   * someone@example.com" and spends nothing, so the installer can put that name
   * in front of a human before anything happens. An enrolment token travels
   * *toward* a machine, which means it can be handed to somebody who was told it
   * does something else — and the only defence against that is making sure the
   * person at the keyboard is told exactly whose account is about to be given
   * the run of their computer. Answering "no" must not cost them the token.
   */
  app.post(
    '/api/pair/enrol',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const { token, confirm, name, info } = req.body || {};
      try {
        if (!confirm) return res.json(await previewEnrolment(token));

        const { device, token: deviceToken } = await redeemEnrolment(token, { name, info });
        res.status(201).json({ token: deviceToken, deviceId: device.id, name: device.name });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── everything below requires a session ─────────────────────────────
  const api = express.Router();
  api.use(requireAuth);

  api.get(
    '/bootstrap',
    wrap(async (req, res) => {
      const store = getStore();
      const prefs = await getPrefs(req.user.id);

      /**
       * Remember which clock this person keeps.
       *
       * `schedule_task` and `workflow_write` run inside an agent turn, where
       * there is no request carrying a zone, so they fell back to the server's —
       * UTC on a deployment, and seven hours wrong for anyone in Vietnam.
       * Written only when it has actually changed, so the common case is a read.
       */
      const zone = validZone(req.query?.tz) ? String(req.query.tz) : null;
      if (zone && zone !== prefs.timezone) {
        prefs.timezone = zone;
        await setPrefs(req.user.id, { timezone: zone }).catch(() => {});
      }

      const [providers, worker, usage, library] = await Promise.all([
        providerStatus(req.user.id),
        workerStatus(req.user, prefs),
        usageSummary(req.user.id),
        store.modelLibraryStatus(),
      ]);
      res.json({
        user: publicUser(req.user),
        usage: { ...usage, limit: limitFor(req.user) },
        prefs,
        providers,
        providerMeta: PROVIDERS,
        library,
        tools: TOOLS.map(({ name, scope, readOnly, description }) => ({
          name,
          scope,
          readOnly,
          description,
        })),
        worker,
        // So the browser can refuse an oversized file before spending a minute
        // uploading it, and word the refusal the same way the server would.
        attachments: ATTACHMENT_LIMITS,
        runtime: {
          storage: store.kind,
          serverless: isServerless(),
          localMachine: !!store.local,
          // So the Computers tab can print the one command that actually works
          // on this deployment, with its address already filled in.
          publicUrl: publicUrlFor(req),
        },
      });
    }),
  );

  /**
   * Just the worker indicator.
   *
   * The browser polls this every twenty seconds to keep one dot honest. It used
   * to poll `/bootstrap` for that — five queries, the provider table and the
   * model-library status, to decide the colour of a circle.
   *
   * Note the path. Anything under `/api/worker/` belongs to the relay router
   * mounted above, whose first act is to demand a bearer token — so a
   * session-authenticated route living there answers 401 to a browser that is
   * perfectly well signed in, and no route below it is ever reached.
   */
  api.get(
    '/devices/status',
    wrap(async (req, res) => {
      res.json({ worker: await workerStatus(req.user, await getPrefs(req.user.id)) });
    }),
  );

  api.put(
    '/prefs',
    wrap(async (req, res) => {
      const allowed = [
        'defaultModel',
        'effort',
        'maxSteps',
        'toolPolicy',
        'systemPrompt',
        'activeDevice',
        'autoCompact',
        'autoPreview',
        'language',
        'onboarded',
      ];
      const patch = {};
      for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
      if ('autoPreview' in patch) patch.autoPreview = !!patch.autoPreview;
      /**
       * Clearing the box means "whatever the default is", not "thirty".
       *
       * An empty Max-steps field sends `''`, `Number('') === 0` is falsy, and
       * the `||` falls through — so the number written to the account is
       * whatever this literal says. It said 30 long after 30 stopped being the
       * default, which silently halved the ceiling for anyone who cleared it.
       * Taken from `DEFAULT_PREFS` so the two cannot drift again. The 100 is
       * this route's own hard cap and is deliberately a literal.
       */
      if (patch.maxSteps != null) {
        patch.maxSteps = Math.min(Math.max(Number(patch.maxSteps) || DEFAULT_PREFS.maxSteps, 1), 100);
      }
      try {
        res.json(await setPrefs(req.user.id, patch));
      } catch (err) {
        // A rejected language is the caller's mistake, not a server fault.
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.put(
    '/providers/:provider/key',
    wrap(async (req, res) => {
      await setApiKey(req.user.id, req.params.provider, String(req.body?.apiKey || '').trim());
      res.json(await providerStatus(req.user.id));
    }),
  );

  /**
   * A spare key, behind the ones already there.
   *
   * Several keys per provider is not a convenience — it is what keeps a turn
   * from failing when one of them runs out mid-afternoon. They are tried in
   * order; see `streamCompletion`.
   */
  api.post(
    '/providers/:provider/keys',
    wrap(async (req, res) => {
      try {
        await addApiKey(req.user.id, req.params.provider, String(req.body?.apiKey || '').trim());
        res.status(201).json(await providerStatus(req.user.id));
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/providers/:provider/keys/:position',
    wrap(async (req, res) => {
      try {
        // The interface counts from one, the store counts from zero.
        // `Number.parseInt`, not `Number`: `Number('undefined') - 1` is NaN, and
        // NaN passes every range check below it before `splice(NaN, 1)` coerces
        // to `splice(0, 1)` — silently destroying the account's *first* key and
        // answering 200. See the matching guard in `removeApiKey`.
        await removeApiKey(req.user.id, req.params.provider, Number.parseInt(req.params.position, 10) - 1);
        res.json(await providerStatus(req.user.id));
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── the model library ───────────────────────────────────────────────
  api.get(
    '/models',
    wrap(async (req, res) => {
      // Self-healing: if the daily refresh has not landed — or landed before
      // six this morning where this person is — catch up quietly rather than
      // showing a stale list.
      await refreshIfStale({ tz: await zoneOf(req) });
      res.json(
        await browse({
          query: req.query.q,
          family: req.query.family,
          tier: req.query.tier,
          sort: req.query.sort,
          limit: req.query.limit,
          provider: req.query.provider,
        }),
      );
    }),
  );

  api.post(
    '/models',
    wrap(async (req, res) => {
      try {
        // Verified against OpenRouter's live catalogue before it is stored, so
        // a typo cannot poison the shared list for everyone else.
        const model = await addModelById(req.body?.id, req.user.id);
        res.status(201).json({ model });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * What one model can do, for the interface to warn with.
   *
   * The composer needs to know whether the chosen model can be shown a picture
   * *before* somebody attaches one — because about half the catalogue cannot,
   * and sending one anyway does not produce a worse answer, it makes the
   * provider reject the whole request.
   */
  api.get(
    '/models/resolve',
    wrap(async (req, res) => {
      try {
        const entry = await resolveModelId(String(req.query.id || ''));
        res.json({
          model: {
            id: entry.id,
            label: entry.label,
            context: entry.context ?? null,
            vision: entry.vision !== false,
            // So the chip can say "free" and offer the swap. A free model is the
            // default for a new account now, and somebody whose long job stalls
            // on a rate limit deserves to know which kind of model they are on
            // rather than concluding the app is broken.
            isFree: !!entry.tags?.includes('free') || (entry.price?.in === 0 && entry.price?.out === 0),
            maxOutput: entry.maxOutput ?? null,
          },
        });
      } catch (err) {
        res.status(404).json({ error: err.message });
      }
    }),
  );

  /**
   * "There is a new model." Answered on every page load, so it is deliberately
   * cheap and deliberately quiet: null unless there is genuinely something this
   * account has not already been told about and turned down.
   */
  api.get(
    '/models/news',
    wrap(async (req, res) => {
      // The library refreshing itself is what makes this daily. If the cron has
      // not landed since six this morning on this person's clock, catch up
      // first rather than announcing yesterday's news.
      const prefs = await getPrefs(req.user.id);
      await refreshIfStale({ tz: await zoneOf(req, prefs) }).catch(() => {});
      /*
       * News in the tier they use. Somebody on a free model is told about new
       * free models, and not about a paid flagship they have chosen not to pay
       * for; somebody paying is told about paid releases, not about free ones.
       */
      let tier = 'free';
      try {
        const current = prefs.defaultModel;
        if (current && current !== 'auto') {
          const entry = await resolveModelId(current);
          const free = !!entry.tags?.includes('free') || (entry.price?.in === 0 && entry.price?.out === 0);
          tier = free ? 'free' : 'paid';
        }
      } catch {
        /* an unresolvable default is treated as free: the safer thing to suggest */
      }
      res.json({ model: await pendingAnnouncement(req.user.id, { tier }) });
    }),
  );

  api.post(
    '/models/news',
    wrap(async (req, res) => {
      try {
        /**
         * "It is on their screen now" — not a decision, just an acknowledgement.
         *
         * The quiet period used to start when the announcement was *fetched*, so
         * a response nobody saw spent it and the account was never told. The
         * browser reports back once the dialog is actually up.
         */
        if (req.body?.action === 'shown') {
          await markAnnouncementShown(req.user.id);
          return res.json({ ok: true, shown: true });
        }
        const outcome = await decideAnnouncement(req.user.id, req.body?.id, req.body?.action);
        // Taking it means using it — being told about a model and then having to
        // go and find it in a picker is a half-finished feature.
        const prefs = outcome.applied
          ? await setPrefs(req.user.id, { defaultModel: outcome.model.id })
          : await getPrefs(req.user.id);
        res.json({ ...outcome, prefs });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * Which built-in models this account can actually use.
   *
   * Listing is not enough: Google still lists `gemini-2.5-flash` and answers a
   * call to it with "no longer available to new users", which is how a dead
   * model reaches somebody as a wall of JSON halfway through a sentence. So
   * every entry is called with the smallest request the provider accepts —
   * one token in, one token out — with this account's own key.
   */
  api.post(
    '/models/audit',
    wrap(async (req, res) => {
      res.json({ checked: await auditCatalog(req.user.id) });
    }),
  );

  api.post(
    '/models/refresh',
    wrap(async (req, res) => {
      try {
        res.json(await refreshLibrary());
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    }),
  );

  // ── account ─────────────────────────────────────────────────────────
  api.patch(
    '/account',
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
      const updated = await getStore().updateUser(req.user.id, { name });
      res.json({ user: publicUser(updated) });
    }),
  );

  api.post(
    '/account/password',
    wrap(async (req, res) => {
      try {
        await changePassword(req.user, { current: req.body?.current, next: req.body?.next });
        // The change signed out every session, including this one. Re-issue the
        // cookie for the browser that did it, so doing the right thing does not
        // bounce you to the sign-in screen.
        await refreshSession(req, res, req.user.id);
        res.json({ ok: true, signedOutOtherDevices: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.get(
    '/account/usage',
    wrap(async (req, res) => {
      res.json({ ...(await usageSummary(req.user.id)), limit: limitFor(req.user) });
    }),
  );

  // ── two-factor ──────────────────────────────────────────────────────
  api.post(
    '/account/2fa/setup',
    wrap(async (req, res) => {
      const { secret, uri, qr } = await beginTotpSetup(req.user);
      // The secret is returned once so it can be typed in by hand when a camera
      // is not an option; it is stored encrypted either way.
      res.json({ secret, uri, qr });
    }),
  );

  api.post(
    '/account/2fa/confirm',
    rateLimit('totp', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        const codes = await confirmTotpSetup(req.user, req.body?.code);
        res.json({ ok: true, recoveryCodes: codes });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.post(
    '/account/2fa/disable',
    rateLimit('totp', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        await disableTotp(req.user, { password: req.body?.password, code: req.body?.code });
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── the live screen ─────────────────────────────────────────────────
  //
  // Held open, one connection per watching tab. Frames are pushed as they are
  // captured rather than fetched on a timer, which is what lets a video look
  // like a video instead of a slideshow.
  //
  // `hd` is the panel asking for more pixels because it is showing them full
  // screen. It travels back to the worker on the reply to the next frame, which
  // is the one channel that already exists in that direction.
  const wantsHd = (req) => req.query.hd === '1';

  api.get('/screen/live', (req, res) => {
    subscribe(req.user.id, req, res, { hd: wantsHd(req) });
  });

  // The fallback, for serverless (where the frame came from another instance)
  // and for anything without EventSource.
  api.get(
    '/screen',
    wrap(async (req, res) => {
      res.json(await poll(req.user.id, { hd: wantsHd(req) }));
    }),
  );

  /**
   * The user's own click, forwarded into the sandbox.
   *
   * Watching something go wrong and being unable to touch it is worse than not
   * watching, so the panel is not a photograph — you can reach through it.
   * Coordinates are normalised, so a phone showing a scaled mirror still lands
   * where you tapped.
   *
   * Local runs only: reaching the sandbox through the job queue would take a
   * second per click, which is not a pointer, it is a telegram.
   */
  api.post(
    '/screen/input',
    wrap(async (req, res) => {
      if (!usesInProcessTools(req.user)) {
        return res.status(400).json({
          error: 'Driving the sandbox by hand needs the server on the same machine as the browser.',
        });
      }
      try {
        const { userInput } = await import('../worker/browser.js');
        res.json({ ok: true, did: await userInput(req.body || {}) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // Shut the sandbox from the panel. The assistant closing it when it is done
  // is the normal path; this is for when the user simply wants it gone, without
  // having to ask and wait for a turn.
  api.post(
    '/screen/close',
    wrap(async (req, res) => {
      try {
        const output = await executeTool({
          user: req.user,
          name: 'browser_close',
          input: {},
          chatId: null,
        });
        // Nothing is being mirrored any more, so the last frame is not a live
        // view — it is a stale photograph of a page. Drop it.
        forgetScreen(req.user.id);
        await getStore().clearScreen(req.user.id).catch(() => {});
        res.json({ ok: !output.isError, message: output.content });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // ── worker pairing ──────────────────────────────────────────────────
  /**
   * ── the computers on this account ───────────────────────────────────
   *
   * There used to be a second way in here: generate an account-wide token, paste
   * it into a file on the machine, restart. It is gone. One token per account
   * meant adding a second computer silently cut off the first, it took six steps
   * and a text editor, and every one of those steps was a place to give up.
   * Pairing does the same job in eight characters.
   *
   * Tokens issued under the old scheme still authenticate — see
   * `getUserByWorkerToken` — so nothing that was working stops.
   */
  api.get(
    '/devices',
    wrap(async (req, res) => {
      res.json({
        devices: await listDevices(req.user.id),
        // Present only when the app and an unpaired worker are the same machine,
        // which is the ordinary case for somebody who just ran `npm start`. It
        // saves reading eight characters off a terminal and mistyping them.
        localCode: localPairingCode(),
      });
    }),
  );

  /** Adopt the computer showing this code. */
  api.post(
    '/devices/pair',
    rateLimit('pair', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        const { device } = await claimPairing(req.user.id, req.body?.code, { name: req.body?.name });
        // The token itself goes to the computer, never to the browser — it is
        // the machine's credential, not the page's.
        res.status(201).json({ device: { id: device.id, name: device.name } });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * Where this computer should work.
   *
   * Changed from the app rather than by editing a file on the machine and
   * restarting it, which is what it used to take — absurd for a thing whose
   * point is being driven from a phone. The worker adopts it on its next
   * heartbeat, within fifteen seconds.
   */
  api.put(
    '/devices/:id/workspace',
    wrap(async (req, res) => {
      try {
        const device = await setDeviceWorkspace(req.user.id, req.params.id, req.body?.path);
        res.json({ device: { id: device.id, name: device.name, wanted: device.workspace } });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  /**
   * A setup link for a computer that is not paired yet.
   *
   * Returns the whole command rather than just the token, because the command is
   * what somebody actually needs — it contains this deployment's address, and
   * asking a person to assemble it from parts is how the old instructions went
   * wrong in the first place.
   *
   * The token goes in an environment variable, never interpolated into the
   * script body. A script assembled by string-joining a parameter and then piped
   * into `iex` runs whatever that parameter contains.
   */
  api.post(
    '/devices/enrolment',
    rateLimit('pair'),
    wrap(async (req, res) => {
      const { token, expiresInSec } = await startEnrolment(req.user.id);
      const base = publicUrlFor(req);
      // Where the machine gets the code from. Deployments are forks, so this is
      // a setting rather than a constant — but it is the operator's setting, not
      // anything a request can influence.
      const repo = process.env.REPO_URL || 'https://github.com/Dansnyzzz/AI-remote.git';

      res.status(201).json({
        expiresInSec,
        windows:
          `$env:AIR_TOKEN='${token}'; $env:AIR_SERVER='${base}'; $env:AIR_REPO='${repo}'; ` +
          `irm ${base}/setup.ps1 | iex`,
        unix:
          `AIR_TOKEN='${token}' AIR_SERVER='${base}' AIR_REPO='${repo}' ` +
          `bash -c "$(curl -fsSL ${base}/setup.sh)"`,
      });
    }),
  );

  api.delete(
    '/devices/:id',
    wrap(async (req, res) => {
      try {
        const gone = await revokeDevice(req.user.id, req.params.id);
        // Its jobs would otherwise sit pending for a machine that can no longer
        // collect them, and the agent would wait out the full timeout on each.
        await getStore().cancelJobsForDevice(req.user.id, req.params.id);
        res.json({ ok: true, name: gone.name });
      } catch (err) {
        res.status(404).json({ error: err.message });
      }
    }),
  );

  // ── projects ────────────────────────────────────────────────────────
  //
  // Every route resolves the project through the signed-in account, so an id
  // guessed or borrowed from somewhere else finds nothing rather than finding
  // somebody's documents.
  api.get(
    '/projects',
    wrap(async (req, res) => {
      // `?archived=1` asks for the other shelf. Archived projects are never
      // folded into the main list — that is the whole point of archiving one.
      const archived = req.query.archived === '1' || req.query.archived === 'true';
      res.json({ projects: await getStore().listProjects(req.user.id, { archived }) });
    }),
  );

  api.post(
    '/projects',
    wrap(async (req, res) => {
      const name = String(req.body?.name || '').trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: 'A project needs a name.' });
      const project = await getStore().createProject(req.user.id, {
        id: crypto.randomUUID(),
        name,
        instructions: String(req.body?.instructions || '').slice(0, 20_000),
        grounded: req.body?.grounded !== false,
      });
      res.status(201).json({ project });
    }),
  );

  /** The project, its sources and its conversations — one round trip. */
  api.get(
    '/projects/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const project = await store.getProject(req.user.id, req.params.id);
      if (!project) return res.status(404).json({ error: 'No such project.' });
      const [files, chats, tasks, outputs] = await Promise.all([
        store.listProjectFiles(req.user.id, project.id),
        store.listProjectChats(req.user.id, project.id),
        // The work this project does on its own, for its Scheduled list.
        store.listProjectTasks(req.user.id, project.id),
        // And what came out of it: the documents its conversations produced.
        store.listProjectOutputs(req.user.id, project.id),
      ]);

      /**
       * What the assistant has learned here, and what it knows anywhere.
       *
       * This card used to show the account's notes under the honest but
       * unhelpful label "account-wide" — honest because that was all there was,
       * unhelpful because a project is exactly the scale at which a preference
       * means something. "Cite the article number" is true of a law project and
       * false of the slide deck next to it.
       *
       * Both are sent, each marked with where it lives, so the page can say
       * which of these the assistant picked up in *this* room. A project note
       * shadows an account note of the same name — the narrower context wins,
       * the same rule the tools apply — so the list never shows one fact twice
       * with two different bodies.
       */
      const read = async (key, scope) =>
        Object.entries((await store.getUserSetting(req.user.id, key)) || {}).map(([name, note]) => ({
          key: name,
          scope,
          content: String(note?.content ?? ''),
          updatedAt: note?.updatedAt || null,
        }));
      const [accountNotes, projectNotes] = await Promise.all([
        read('memory', 'account'),
        read(`memory:${project.id}`, 'project'),
      ]);
      const shadowed = new Set(projectNotes.map((note) => note.key));
      const memory = [...projectNotes, ...accountNotes.filter((note) => !shadowed.has(note.key))]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 12);

      res.json({ project, files, chats, memory, tasks, outputs });
    }),
  );

  api.patch(
    '/projects/:id',
    wrap(async (req, res) => {
      const patch = {};
      if (req.body?.name != null) {
        const name = String(req.body.name).trim().slice(0, 120);
        if (!name) return res.status(400).json({ error: 'A project needs a name.' });
        patch.name = name;
      }
      if (req.body?.instructions != null) patch.instructions = String(req.body.instructions).slice(0, 20_000);
      if (req.body?.grounded != null) patch.grounded = !!req.body.grounded;
      if (req.body?.pinned != null) patch.pinned = !!req.body.pinned;
      if (req.body?.archived != null) patch.archived = !!req.body.archived;

      const project = await getStore().updateProject(req.user.id, req.params.id, patch);
      if (!project) return res.status(404).json({ error: 'No such project.' });
      res.json({ project });
    }),
  );

  api.delete(
    '/projects/:id',
    wrap(async (req, res) => {
      // The conversations survive: they are a record of work, and deleting a
      // folder should not delete what was said inside it. `ON DELETE SET NULL`
      // simply returns them to the ordinary list.
      await getStore().deleteProject(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  /**
   * Throw away one remembered note.
   *
   * A note is read back into every future conversation, so one that has gone
   * stale is not clutter — it is a wrong fact being repeated. Until this route
   * existed the only way to be rid of one was to ask the assistant to call
   * `memory_delete` and hope it picked the right key, which is an odd thing to
   * have to negotiate about your own notes.
   *
   * `scope` decides which set it comes out of, and it is checked rather than
   * trusted: a project note and an account note can share a name, and deleting
   * the wrong one would quietly remove a preference from every other project.
   * The project is verified against this account first, the same as everywhere
   * else here — the id comes from a browser.
   */
  api.delete(
    '/projects/:id/memory/:key',
    wrap(async (req, res) => {
      const store = getStore();
      const project = await store.getProject(req.user.id, req.params.id);
      if (!project) return res.status(404).json({ error: 'No such project.' });

      const account = req.query.scope === 'account';
      const bucket = account ? 'memory' : `memory:${project.id}`;
      const notes = (await store.getUserSetting(req.user.id, bucket)) || {};
      if (!(req.params.key in notes)) return res.status(404).json({ error: 'No such note.' });

      await store.removeUserSettingKey(req.user.id, bucket, req.params.key);
      res.json({ ok: true });
    }),
  );

  api.post(
    '/projects/:id/files',
    wrap(async (req, res) => {
      try {
        const file = await addSource(req.user.id, req.params.id, req.body || {});
        res.status(201).json({ file });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }),
  );

  api.delete(
    '/projects/:id/files/:fileId',
    wrap(async (req, res) => {
      await getStore().deleteProjectFile(req.user.id, req.params.fileId);
      res.json({ ok: true });
    }),
  );

  // ── skills, schedules, connectors ───────────────────────────────────
  api.get(
    '/skills',
    wrap(async (req, res) => {
      res.json({ skills: await getStore().listSkills(req.user.id) });
    }),
  );

  api.post(
    '/skills',
    wrap(async (req, res) => {
      try {
        res.status(201).json({ skill: await saveSkill(req.user.id, req.body || {}) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.patch(
    '/skills/:id',
    wrap(async (req, res) => {
      const skill = await getStore().setSkillEnabled(req.user.id, req.params.id, !!req.body?.enabled);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      res.json({ skill });
    }),
  );

  api.delete(
    '/skills/:id',
    wrap(async (req, res) => {
      await getStore().deleteSkill(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  api.get(
    '/tasks',
    wrap(async (req, res) => {
      res.json({ tasks: await getStore().listTasks(req.user.id) });
    }),
  );

  /**
   * Run this account's overdue tasks now.
   *
   * Called by the browser on load, on a deployment only, and deliberately not
   * awaited by it — see `runDueTasksForUser`. The request is held open for as
   * long as the work takes because that is precisely what stops a serverless
   * host freezing the instance halfway through a task.
   *
   * Scoped to the caller. A user request must never sweep everybody's queue:
   * that is the cron endpoint's job, and it has its own secret.
   */
  api.post(
    '/tasks/run-due',
    wrap(async (req, res) => {
      if (!isServerless()) {
        // A local run has a timer of its own ticking every minute.
        return res.json({ ran: [], skipped: 'the local scheduler handles this' });
      }
      const ran = await runDueTasksForUser(req.user.id);
      // Same reasoning, scoped to the caller: this is the only thing that moves
      // a half-finished workflow along between one daily cron and the next.
      const workflows = await runDueWorkflows({ userId: req.user.id, limit: 2 }).catch(() => null);
      res.json({ ran, workflows });
    }),
  );

  api.post(
    '/tasks',
    wrap(async (req, res) => {
      try {
        // Check before writing, not after: the old order created the row and
        // *then* returned 400, leaving an empty task scheduled to run forever.
        const prompt = String(req.body?.prompt || '').trim();
        if (!prompt) return res.status(400).json({ error: 'Say what the task should do.' });

        // The browser sends its own zone, because "17:00" means the user's five
        // o'clock. Without it the server's clock decided, which on a deployment
        // is UTC — seven hours out for anyone in Vietnam, silently.
        const tz = validZone(req.body?.tz) ? req.body.tz : null;

        /**
         * Two ways in, because there are two callers.
         *
         * `frequency` is the menu the form offers — manual, hourly, daily,
         * weekdays, weekly, monthly — and is what a person picks. `when` is the
         * written form, which the agent's own `schedule_task` tool uses and
         * which can say things a menu cannot ("fri 16:00"). Neither is going
         * away; a menu that could only express a third of the schedules would
         * be a worse tool, and a text field is a worse form.
         */
        const { cron, nextRunAt } = req.body?.frequency
          ? fromFrequency(req.body.frequency, { tz })
          : parseSchedule(req.body?.when, { once: req.body?.repeat === false, tz });

        // A task filed under a project runs inside it. Checked, so an id from
        // another account cannot attach a run to a shelf it does not own.
        const projectId = req.body?.projectId ? String(req.body.projectId) : null;
        if (projectId && !(await getStore().getProject(req.user.id, projectId))) {
          return res.status(404).json({ error: 'No such project.' });
        }

        // What it may do with nobody watching. Null means the account default.
        const policy = TASK_POLICIES.has(String(req.body?.policy)) ? String(req.body.policy) : null;

        const prefs = await getPrefs(req.user.id);
        const task = await getStore().createTask(req.user.id, {
          id: crypto.randomUUID(),
          title: String(req.body?.title || '').trim() || 'Scheduled task',
          prompt,
          model: req.body?.model || prefs.defaultModel,
          cron,
          nextRunAt,
          tz,
          projectId,
          policy,
        });
        res.status(201).json({ task });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  api.get(
    '/tasks/:id',
    wrap(async (req, res) => {
      const task = await getStore().getTask(req.user.id, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      // The project by name, because the page shows which shelf it answers
      // from and an id tells nobody that.
      const project = task.project_id ? await getStore().getProject(req.user.id, task.project_id) : null;
      res.json({ task, project: project ? { id: project.id, name: project.name } : null });
    }),
  );

  api.patch(
    '/tasks/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const b = req.body || {};

      /**
       * An edit, as well as pause and resume.
       *
       * The frequency is re-timed only when it is sent, and the form sends it
       * only when it was changed: choosing a frequency takes the time of day
       * from now, so re-sending an untouched one would quietly move a 09:00
       * task to whenever it was last saved.
       */
      const patch = {};
      try {
        if (b.title !== undefined) patch.title = String(b.title).trim() || 'Scheduled task';
        if (b.prompt !== undefined) {
          patch.prompt = String(b.prompt).trim();
          if (!patch.prompt) return res.status(400).json({ error: 'Say what the task should do.' });
        }
        if (b.policy !== undefined) patch.policy = TASK_POLICIES.has(String(b.policy)) ? String(b.policy) : null;
        if (b.frequency !== undefined) {
          const tz = validZone(b.tz) ? b.tz : null;
          Object.assign(patch, fromFrequency(b.frequency, { tz }), { tz });
        }
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      let task = Object.keys(patch).length ? await store.updateTask(req.user.id, req.params.id, patch) : null;
      if (b.enabled !== undefined) task = await store.setTaskEnabled(req.user.id, req.params.id, !!b.enabled);
      else if (!Object.keys(patch).length) task = await store.getTask(req.user.id, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ task });
    }),
  );

  /**
   * Run one task now, whatever its schedule says.
   *
   * The only way a manual task ever runs, and the way anybody checks that a
   * scheduled one does what they meant before waiting until morning for it.
   * Held open like `/tasks/run-due`, for the same reason: returning early is
   * what lets a serverless host freeze the instance mid-run.
   */
  api.post(
    '/tasks/:id/run',
    wrap(async (req, res) => {
      const task = await getStore().getTask(req.user.id, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const result = await runTaskNow(task);
      res.json(result);
    }),
  );

  api.delete(
    '/tasks/:id',
    wrap(async (req, res) => {
      await getStore().deleteTask(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  // Lifted into server/routes/workflows.js.
  mountWorkflowRoutes(api, { wrap, body });
  mountConnectorRoutes(api, { wrap });
  mountMcpRoutes(api, { wrap, body });

  // Lifted into server/routes/files.js.
  mountFileRoutes(api, { wrap, body });
  mountWorkspaceRoutes(api, { wrap, body });

  // Lifted into server/routes/chats.js.
  mountChatRoutes(api, { wrap, body, isRunning });

  // ── the agent stream ────────────────────────────────────────────────
  /**
   * Stop whatever is running in this conversation.
   *
   * The browser already aborts its own fetch, which closes the socket and ends
   * the run through `res.on('close')`. This exists because that path is not
   * guaranteed: a proxy that buffers, or a host that holds the connection open
   * after the client has gone, can delay the close indefinitely — and a stop
   * that only *usually* stops is not a stop. It is also the only way to end a
   * run started by a tab that has since been closed.
   *
   * Clearing the lease is the signal. The invocation doing the work finds out on
   * its next heartbeat (15s at the outside) and aborts; a second press is
   * harmless, and so is pressing it when nothing is running.
   */
  api.post(
    '/chats/:id/stop',
    wrap(async (req, res) => {
      const store = getStore();
      if (!(await store.getChat(req.user.id, req.params.id))) {
        return res.status(404).json({ error: 'Chat not found' });
      }
      res.json({ stopped: await store.stopChatRun(req.user.id, req.params.id) });
    }),
  );

  api.post(
    '/chats/:id/run',
    wrap(async (req, res) => {
      const store = getStore();
      const chatId = req.params.id;

      // Checked before the lock, so somebody else's conversation reads as
      // missing rather than as busy — "already running" would be a small,
      // needless confirmation that it exists.
      if (!(await store.getChat(req.user.id, chatId))) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      /**
       * One agent loop per conversation at a time.
       *
       * Two tabs on the same chat used to start two loops that both appended to
       * the same transcript, and the result was a conversation with its turns
       * shuffled together. The lock is a lease in the database, so it holds
       * across serverless instances as well as tabs.
       *
       * The id comes from the *client*, and that detail is what makes this work
       * on a deployment at all. A hosted run is routinely killed at the function
       * timeout, which means the `finally` below never runs and the lease is
       * still held when the browser reconnects a moment later to continue. With
       * a fresh id per request that reconnect is refused by the lock meant to
       * protect it; with a stable one per *run*, the browser re-enters its own
       * lease and a second tab is still kept out.
       */
      const runId = /^[0-9a-f-]{36}$/i.test(String(req.body?.runId || ''))
        ? req.body.runId
        : crypto.randomUUID();

      /**
       * Which holding of the lease this invocation is.
       *
       * A reconnection with the same `runId` is allowed back in — that is what
       * makes resuming work — but it now *supersedes* the invocation it is
       * replacing rather than joining it. The one it replaced fails its next
       * heartbeat and aborts, so only one loop is ever appending to the
       * transcript. See `claimChatRun`.
       */
      const runSeq = await store.claimChatRun(req.user.id, chatId, runId);
      if (!runSeq) {
        return res.status(409).json({
          error: 'This conversation is already running somewhere else. Wait for it, or stop it there.',
          code: 'already_running',
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Stops Vercel's edge and nginx from buffering the stream into one blob.
        'X-Accel-Buffering': 'no',
      });

      /**
       * Losing the browser is not the same as being told to stop.
       *
       * This used to abort the run the moment the socket closed, which made a
       * refresh — or a phone locking itself, or a laptop lid — destroy work that
       * was minutes in. Every step is already written to the database as it
       * happens, so there was never anything technical stopping the loop from
       * finishing; the connection was simply being read as consent to stop, and
       * what came back on return was a conversation frozen mid-thought.
       *
       * The lease is what actually says whether this run is still wanted.
       * `/stop` clears it, and so does another connection claiming it. So a
       * closed socket now asks that question instead of assuming the answer:
       *
       *   - lease gone      → somebody pressed stop. Abort, immediately.
       *   - lease still ours → they navigated away, or the tab died. Keep going,
       *     keep writing steps, and let the heartbeat notice if that changes.
       *   - lease taken      → a reconnection has superseded this invocation.
       *     Abort, and discard the partial text, which is what 'superseded'
       *     means to the loop.
       *
       * The grace window exists because the browser aborts its own fetch
       * *before* it calls `/stop` — deliberately, so the button feels instant —
       * so at the moment this fires the lease is usually still held by a run
       * that is about to be stopped a few milliseconds later.
       */
      const GRACE_AFTER_CLOSE_MS = 2_000;
      const controller = new AbortController();
      res.on('close', () => {
        if (res.writableEnded) return;
        setTimeout(async () => {
          if (controller.signal.aborted) return;
          const chat = await store.getChat(req.user.id, chatId).catch(() => null);
          if (!chat) return controller.abort('stopped');
          // Ours still, under this sequence: nobody has stopped it and nobody
          // has taken it over. Carry on into a socket nobody is reading; the
          // transcript is the output that matters.
          if (chat.run_lock_by === runId && Number(chat.run_lock_seq) === runSeq) {
            log.info('client left, run continues', { runId });
            return;
          }
          controller.abort(chat.run_lock_by ? 'superseded' : 'stopped');
        }, GRACE_AFTER_CLOSE_MS).unref?.();
      });

      // The stream's sentences — errors, status lines, a retry's reason — in
      // the language the browser asked for. See server/i18n.
      const language = languageOf(req);
      /**
       * A line of the stream, or nothing if there is nobody to hear it.
       *
       * `writableEnded` alone was enough while a closed socket ended the run.
       * Now that it does not, this function is called for the whole rest of a
       * turn whose reader has gone — and writing to a destroyed socket throws
       * `ERR_STREAM_DESTROYED`, from inside the agent loop, which would turn a
       * refresh into a failed turn. The two extra checks are the ones that
       * describe a connection the client dropped rather than one we closed.
       */
      const emit = (event, data) => {
        if (res.writableEnded || res.destroyed || res.closed) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(translateEvent(data, language) ?? {})}\n\n`);
        } catch {
          /* the socket went between the check and the write; the step is saved anyway */
        }
      };

      /**
       * Idle SSE connections get culled by proxies. The same tick renews the run
       * lease, so a genuinely long turn keeps its claim while a dead one lets go.
       *
       * It is also how a stop becomes certain rather than likely. Aborting the
       * browser's fetch closes the socket, and `res.on('close')` above catches
       * that — most of the time. Behind a buffering proxy, or on a host that
       * keeps the connection open after the client has gone, it can arrive late
       * or never, and the loop carries on spending money on an answer nobody
       * will read. `/stop` takes the lease away instead; this notices within one
       * tick and aborts for a fact.
       */
      const ping = setInterval(() => {
        emit('ping', { t: Date.now() });
        store
          .touchChatRun(req.user.id, chatId, runId, runSeq)
          .then(async (held) => {
            if (held !== false) return;
            /**
             * Losing the lease means one of two very different things, and the
             * loop has to know which.
             *
             * The stop route clears `run_lock_by`: a person pressed stop, nobody
             * else is writing to this conversation, and keeping the half of the
             * reply they already read is right (CODE-016). A reconnection
             * *claims* the lease instead — `run_lock_by` stays set, to another
             * run or to this run id with a newer sequence — and that invocation
             * is already streaming its own reply. Keeping this one's partial text
             * then would put a stale fragment into the transcript alongside the
             * live answer.
             *
             * That regression was mine: CODE-016 persisted on every abort, and
             * supersession arrives as an abort. The reason travels on the signal
             * so the loop can tell them apart.
             */
            const chat = await store.getChat(req.user.id, chatId).catch(() => null);
            controller.abort(chat?.run_lock_by ? 'superseded' : 'stopped');
          })
          .catch(() => {});
      }, 15_000);

      // Whose turn this is, and which one, on every line the loop emits from
      // here down — including the ones written from inside a tool call.
      annotate({ userId: req.user.id, chatId, runId });
      const started = mark();
      log.info('turn started', { model: req.body?.model || 'default' });

      try {
        await runAgent({
          userId: req.user.id,
          user: req.user,
          chatId,
          modelId: req.body?.model,
          decision: req.body?.decision,
          // The tool-call ids the prompt named when the person answered. A
          // decision is about a specific batch, and until this was sent the
          // server had no way to know whether it still was. See `runAgent`.
          decisionFor: req.body?.decisionFor,
          /**
           * What the person pressed on a question card, if this call is the one
           * resuming a paused question.
           *
           * `{ toolCallId, given: [{ picks, other }] }` — the id is what stops a
           * stale answer from an earlier pause being read as this one's. The
           * labels are checked against the options the model actually offered
           * (see `answerText`), so a hand-made request cannot put words in the
           * user's mouth.
           */
          answers: req.body?.answers,
          // Which computer the browser is sitting at, learned from the worker on
          // that machine. Per request rather than stored: preferences belong to
          // the account, so two machines with the app open would take turns
          // overwriting each other's answer, and both would be wrong half the
          // time. Verified against this account's machines before it is used.
          deviceHint: req.body?.deviceHint,
          emit,
          signal: controller.signal,
        });
      } catch (err) {
        log.error('turn failed', err, { ms: since(started) });
        emit('error', { message: readableFailure(err) });
        emit('done', { stopReason: 'error' });
      } finally {
        log.info('turn ended', { ms: since(started) });
        clearInterval(ping);
        // Released whatever happened, including an abort — holding the lock
        // after the loop has stopped would lock the user out of their own chat.
        // With the sequence, so a superseded invocation finishing late cannot
        // release the lease the reconnection that replaced it now holds.
        await store.releaseChatRun(req.user.id, chatId, runId, runSeq).catch(() => {});
        if (!res.writableEnded) res.end();
      }
    }),
  );


  // ── admin ───────────────────────────────────────────────────────────
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get(
    '/users',
    wrap(async (req, res) => {
      res.json({ users: await getStore().listUsers() });
    }),
  );


  admin.patch(
    '/users/:id',
    wrap(async (req, res) => {
      // Express 5 leaves `req.body` undefined when no JSON body arrived, and
      // `'suspended' in undefined` is a TypeError, not a false — which turned a
      // bodyless PATCH into a 500 rather than a no-op.
      const patchBody = body(req);

      // Guard against an admin locking themselves out or demoting the last one.
      if (req.params.id === req.user.id && ('suspended' in patchBody || patchBody.role === 'user')) {
        return res.status(400).json({ error: 'You cannot suspend or demote yourself.' });
      }
      const patch = {};
      if ('name' in patchBody) patch.name = String(patchBody.name).trim();
      if ('suspended' in patchBody) patch.suspended = !!patchBody.suspended;
      if (patchBody.role === 'admin' || patchBody.role === 'user') patch.role = patchBody.role;
      if ('monthlyTokenLimit' in patchBody) {
        const limit = Number(patchBody.monthlyTokenLimit);
        // 0 or blank means "no limit for this person".
        patch.monthlyTokenLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
      }
      const updated = await getStore().updateUser(req.params.id, patch);
      if (!updated) return res.status(404).json({ error: 'No such account.' });
      res.json({ ok: true });
    }),
  );

  admin.delete(
    '/users/:id',
    wrap(async (req, res) => {
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot delete your own account.' });
      }
      await getStore().deleteUser(req.params.id);
      res.json({ ok: true });
    }),
  );

  api.use('/admin', admin);
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ── static frontend ─────────────────────────────────────────────────
  /**
   * Revalidate rather than cache blind.
   *
   * There is no build step here, so no filename hashing to make a stale asset
   * impossible. With a flat one-hour cache the browser would happily pair a
   * freshly-fetched index.html with an hour-old app.js — and a script wiring an
   * element the new markup no longer has throws at load, leaving a blank page.
   * ETags make each request a cheap 304 instead, and a mismatch cannot happen.
   *
   * On Vercel this code does not serve the frontend at all: `public/` goes to
   * the CDN, where each deployment is atomic and immutable.
   */
  app.use(express.static(WEB_DIR, { extensions: ['html'], maxAge: 0, etag: true }));
  app.get(/.*/, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB_DIR, 'index.html'));
  });

  // Four arguments, and `next` is unused on purpose: Express identifies an error
  // handler by its arity, so dropping the parameter turns this into ordinary
  // middleware that never runs.
  app.use((err, req, res, next) => {
    /**
     * Through the trace logger, not straight to the console.
     *
     * This is the last place an unhandled failure is seen, and it was the one
     * place that threw away the request id. Every other record in a request
     * carries it — `emit` reads it out of the AsyncLocalStorage this file sets
     * up at the top — so the 500 was the single line you could not join to the
     * turn that produced it, which is exactly the line you are looking for.
     *
     * `log.error` also unpacks the error rather than stringifying it, so the
     * name, the status and the first line of the stack are separately
     * searchable instead of buried in one string.
     */
    log.error('unhandled error', err, { method: req.method, path: req.path });
    if (res.headersSent) return res.end();
    res.status(500).json({ error: err?.message || 'Internal error' });
  });

  return app;
}
