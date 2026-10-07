/**
 * The browser sandbox — a real browser the assistant drives, and the user
 * watches live.
 *
 * Two decisions worth knowing about:
 *
 * **It steers by element reference, not pixels.** Every action is preceded by a
 * numbered snapshot of what is on screen, and the model clicks "7", not a
 * coordinate. Text models are poor at reading pixel positions out of a
 * screenshot and good at picking from a list, so this is far more reliable —
 * and it degrades gracefully when a page shifts under it.
 *
 * **The screenshot is for the human, not the model.** The model reads the
 * snapshot; the frames exist so the user can see exactly what is happening and
 * step in. What they watch really is the same page the assistant is acting on.
 */

const VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT = 45_000;

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { claim, publishFrame, release, watcherPreference } from './screen.js';
import { dataDir } from './paths.js';
// The same address check `download_file` uses, so "reaching off this machine"
// means one thing here rather than three. See `renderPdf`.
import { assertPublic } from '../server/util/safeFetch.js';

/**
 * One browsing session — the tabs, cookies and sign-ins of one conversation.
 *
 * This used to be four variables at the top of the file, which meant one
 * browser for the whole machine. With a single conversation nothing looked
 * wrong; with two, a tab opened in one appeared in the other's `browser_tabs`,
 * a sign-in in one signed the other in, and `browser_close` in either shut both.
 * That is state leaking between pieces of work that have nothing to do with
 * each other.
 *
 * A `BrowserContext` per conversation rather than a browser per conversation:
 * a context has its own cookies, its own `localStorage` and its own tabs —
 * everything an incognito window has — for roughly 20–50MB, against ~250MB for
 * another Chrome process. Five conversations cost about 150MB instead of over a
 * gigabyte of somebody's laptop. What is given up is crash isolation, not
 * session isolation, and session isolation is the thing being asked for.
 */
function newSession(key) {
  return {
    key,
    browser: null,
    context: null,
    page: null,
    screencast: null,
    castingHd: false,
    // Read once per frame would be a round trip into the page; it changes far
    // more slowly than the pixels do.
    lastTitle: '',
    usedAt: Date.now(),
  };
}

const sessions = new Map();

/**
 * Which session a conversation gets — and why only `sandbox` gets its own.
 *
 * `profile` wraps **one** signed-in profile directory, and Chrome holds an
 * exclusive lock on it. Splitting it per conversation would mean a profile
 * each, which destroys the only reason it exists: sign in once, stay signed in.
 *
 * `attach` wraps **one** real Chrome belonging to the user. There is nothing
 * there to split.
 *
 * So: the disposable one is per conversation; the two that wrap a real identity
 * are singular. A sub-agent runs with no `chatId` — it is part of the work
 * already in flight rather than a conversation of its own — so they share one
 * bucket instead of each opening a browser.
 */
const sessionKey = (chatId) => (mode === 'sandbox' ? chatId || 'shared' : 'single');

/**
 * How many conversations may hold a browser at once, and for how long.
 *
 * Both are part of the feature rather than tuning to do later: something that
 * opens a browser per conversation and never closes one eats a machine's memory
 * over an afternoon. The oldest idle session goes when the limit is reached, and
 * a session nobody has touched for ten minutes goes on its own.
 */
const MAX_SESSIONS = Math.min(Math.max(Number(process.env.BROWSER_MAX_SESSIONS) || 6, 1), 24);
const SESSION_IDLE_MS = Math.max(Number(process.env.BROWSER_IDLE_MS) || 10 * 60 * 1000, 30_000);

/** Close whatever has gone cold, then make room if there is still none. */
async function evict() {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.usedAt > SESSION_IDLE_MS) await closeSession(s).catch(() => {});
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!oldest) break;
    await closeSession(oldest).catch(() => {});
  }
}

/** The session for this conversation, opened if it is not there yet. */
async function sessionFor(chatId) {
  const key = sessionKey(chatId);
  let s = sessions.get(key);

  if (!s) {
    await evict();
    s = newSession(key);
    sessions.set(key, s);
  }
  s.usedAt = Date.now();
  return s;
}

/**
 * What is open, for tests and for the worker's own reporting.
 *
 * Exposed because "each conversation gets its own" is a claim that has to be
 * checkable — and because the eviction rules below are the difference between a
 * feature and a memory leak, so something has to be able to watch them work.
 */
export const browserSessions = () =>
  [...sessions.values()].map((s) => ({ key: s.key, open: !!s.page && !s.page.isClosed(), usedAt: s.usedAt }));

/**
 * One Chrome process behind every sandbox session.
 *
 * Contexts are cheap; processes are not. Kept at module scope rather than on a
 * session because every sandbox session shares it — closing one conversation's
 * context must not take the browser down with it.
 */
let sandboxBrowser = null;

/**
 * Which browser the assistant drives — chosen per computer, from the app.
 *
 * `sandbox`  A fresh Chrome with an empty profile. No cookies, no logins,
 *            nothing of yours. The safe default, and useless for anything
 *            behind a sign-in wall.
 *
 * `profile`  A persistent profile of the worker's own, kept on this machine.
 *            You sign in once — through the live panel, watching it happen —
 *            and it is still signed in next week.
 *
 *            Note what this is *not*: your own Chrome profile directory.
 *            Chrome holds an exclusive lock on `User Data` while it is running,
 *            so pointing Playwright at it fails whenever your browser is open,
 *            which is nearly always, and the error says nothing about why. A
 *            separate directory gives almost all of the benefit and cannot
 *            corrupt the profile you actually browse with.
 *
 * `attach`   Your real Chrome, already running, already signed in to
 *            everything — reached over its remote-debugging port. This is the
 *            closest thing here to an extension driving the browser you use,
 *            and the price is that Chrome has to have been started with
 *            `--remote-debugging-port`.
 */
export const BROWSER_MODES = ['sandbox', 'profile', 'attach'];

const DEFAULT_MODE = BROWSER_MODES.includes(process.env.BROWSER_MODE || '')
  ? process.env.BROWSER_MODE
  : 'sandbox';

// `const` since `setBrowserMode` went: the mode is read once from the
// environment at start-up and nothing reassigns it any more.
const mode = DEFAULT_MODE;

/** Where a persistent profile lives. One per machine, beside the other worker state. */
const profileDir = () => path.join(dataDir(), 'browser-profile');

/** The debugging endpoint `attach` dials. */
const CDP_PORT = Number(process.env.BROWSER_CDP_PORT) || 9222;
const cdpEndpoint = () => process.env.BROWSER_CDP_URL || `http://127.0.0.1:${CDP_PORT}`;

/**
 * `browserMode` and `setBrowserMode` were removed here.
 *
 * They existed for a picker in the app that let somebody choose sandbox,
 * profile or attach per computer. That picker was taken out — the answer is
 * always a clean sandbox, and `.env.example` says so where BROWSER_MODE is
 * documented — and the two functions were left behind, exported and called by
 * nothing.
 *
 * The mode is still settable, by `BROWSER_MODE` in the worker's environment,
 * which is read once at start-up. Nothing changes it at runtime any more, so a
 * setter that closes the live browser to adopt a new one had no way to be
 * reached and no caller to reach it.
 */

/**
 * Is there a live context to act in?
 *
 * Not `browser?.isConnected()`, which was the old test and is wrong for two of
 * the three modes: a persistent context has no `Browser` object at all
 * (`launchPersistentContext` returns the context itself), so that test reports
 * "nothing is open" while tabs sit open in front of you.
 */
const contextIsLive = (s) => !!s.context && (mode === 'profile' || !!s.browser?.isConnected());

/**
 * Is there a page to act on?
 *
 * Two shapes on purpose. Given a session it answers about that conversation.
 * Given nothing — which is how `workerInfo()` calls it on every heartbeat — it
 * answers "is any conversation browsing", because that is what the indicator in
 * the app reports.
 */
export const browserIsOpen = (s) => {
  const live = (each) => !!each.page && !each.page.isClosed() && contextIsLive(each);
  return s ? live(s) : [...sessions.values()].some(live);
};

/** Whether something is listening on a TCP port here, without connecting to it twice. */
function portOpen(port, host = '127.0.0.1', timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * What this machine can offer, for the picker in the app.
 *
 * Probed on demand rather than on every heartbeat: the answer changes when
 * somebody installs a browser or restarts Chrome with a debugging port, which is
 * rare, and opening a socket every fifteen seconds to re-learn a constant is
 * waste with a battery cost.
 */
let capabilities = { channels: [], profileExists: false, attachable: false, cdpPort: CDP_PORT };

/**
 * The last probe's answer, without doing another one.
 *
 * `workerInfo()` is synchronous and runs on every fifteen-second heartbeat, so
 * it cannot open a socket — and should not: whether Chrome is installed is a
 * constant, and whether a debugging port is open changes when somebody restarts
 * their browser, not between heartbeats.
 */
export const browserSnapshot = () => ({ ...capabilities, mode });

/** Probe again. Called at startup and whenever the chosen mode changes. */
export async function refreshBrowserCapabilities() {
  capabilities = await browserCapabilities().catch(() => capabilities);
  return browserSnapshot();
}

export async function browserCapabilities() {
  const { chromium } = await import('playwright-core');

  const channels = [];
  for (const channel of ['chrome', 'msedge']) {
    try {
      // `executablePath` throws for a channel that is not installed, and
      // answers without launching anything for one that is.
      if (chromium.executablePath({ channel })) channels.push(channel);
    } catch {
      /* not installed */
    }
  }

  let profileExists = false;
  try {
    profileExists = fs.existsSync(profileDir());
  } catch {
    /* an unreadable data dir is the same as no profile for this purpose */
  }

  return {
    mode,
    channels,
    profileExists,
    attachable: await portOpen(CDP_PORT),
    cdpPort: CDP_PORT,
  };
}

/**
 * The flags every mode wants, in one place.
 *
 * Shared rather than duplicated because `launch` and `launchPersistentContext`
 * take the same options, and a window that is parked off-screen in one mode and
 * on top of your work in the other is the kind of difference nobody can explain
 * afterwards.
 */
function launchOptions() {
  /**
   * Headed by default, and unmuted.
   *
   * Headless Chrome has no audio device at all — a video "playing" in it is a
   * silent series of frames, which is exactly the complaint. Sound needs a real
   * window, so that is the default now. Be clear about where the sound comes
   * out: the speakers of the machine running the worker, not the browser tab
   * you are watching from. Streaming audio to a remote viewer would need a
   * WebRTC pipeline that does not exist here.
   */
  /**
   * Headed where there is a screen, headless where there is not.
   *
   * The default used to be headed everywhere, for a good reason — headless
   * Chrome has no audio device, so a video "playing" in it is a silent series of
   * frames. But a headed browser needs somewhere to draw, and on Linux with no X
   * or Wayland session there is nowhere: a CI runner, a headless server, a
   * container. There the old default did not trade sound for anything, it
   * guaranteed the browser would not start at all.
   *
   * So the default follows the machine. Setting BROWSER_HEADLESS still wins
   * either way, and on any desktop nothing changes.
   */
  const hasDisplay =
    process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = /^(1|true|yes)$/i.test(process.env.BROWSER_HEADLESS ?? String(!hasDisplay));
  const args = [
    '--disable-blink-features=AutomationControlled',
    // Without this a clicked video sits on its first frame: Chrome's autoplay
    // policy does not count an automation click as a user gesture.
    '--autoplay-policy=no-user-gesture-required',
    // A window nobody is looking at gets its timers throttled and its frames
    // stopped, which is exactly wrong here — nobody is looking at it *on the
    // desktop*, but someone is watching every frame through the panel.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  // Muting a headless browser changes nothing, so this only really applies to
  // a headed one — where someone might genuinely not want the noise.
  if (headless || /^(1|true|yes)$/i.test(process.env.BROWSER_MUTE ?? '')) args.push('--mute-audio');

  /**
   * Parked off the edge of the desktop, not hidden.
   *
   * The window has to exist for there to be an audio device and a compositor,
   * but having it sit on top of everything is its own problem: it clutters the
   * screen, and — the actual failure people hit — it is easy to close by hand,
   * after which every tool call reports "no page is open".
   *
   * So it is a real window at coordinates no monitor covers. Sound still plays,
   * frames still arrive, and nothing is in the way. Nothing raises it either —
   * see `focusPage`, which used to and was the reason the sandbox appeared to
   * pop up over people's work. Set BROWSER_SHOW=true when you want to watch it
   * directly on the machine.
   */
  if (!headless && !/^(1|true|yes)$/i.test(process.env.BROWSER_SHOW ?? '')) {
    args.push(`--window-position=${-VIEWPORT.width - 400},0`, `--window-size=${VIEWPORT.width},${VIEWPORT.height}`);
  }

  return { headless, args };
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Use a browser the user already has rather than downloading 400MB. Chrome
 * first, then Edge, then whatever Playwright bundled if someone installed it.
 */
const CHANNELS = [{ channel: 'chrome' }, { channel: 'msedge' }, {}];

const noBrowser = (err) =>
  new Error(
    `Could not start a browser. Install Google Chrome or Microsoft Edge. (${err?.message?.split('\n')[0]})`,
  );

/** `sandbox` — a fresh browser with nothing of yours in it. */
async function openSandbox(s) {
  const { chromium } = await import('playwright-core');
  const { headless, args } = launchOptions();

  // One Chrome for every sandbox conversation; a context each. Launching a
  // second process per conversation would cost ~250MB against ~30MB, for an
  // isolation guarantee nobody asked for.
  if (!sandboxBrowser?.isConnected()) {
    let lastError;
    sandboxBrowser = null;
    for (const options of CHANNELS) {
      try {
        sandboxBrowser = await chromium.launch({ ...options, headless, args });
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!sandboxBrowser) throw noBrowser(lastError);
  }

  s.browser = sandboxBrowser;
  s.context = await sandboxBrowser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT });
  return s.context;
}

/**
 * `profile` — a browser of the worker's own that stays signed in.
 *
 * `launchPersistentContext` returns the **context**, not a browser: there is no
 * `Browser` object to ask, which is why `contextIsLive` exists rather than the
 * `browser?.isConnected()` test this file used everywhere before.
 *
 * The viewport is set to null so the page fills the real window; a persistent
 * profile is one somebody signs into by hand through the live panel, and a page
 * letterboxed inside its own window is awkward to use that way.
 */
async function openProfile(s) {
  const { chromium } = await import('playwright-core');
  const { headless, args } = launchOptions();
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });

  let lastError;
  for (const options of CHANNELS) {
    try {
      s.browser = null;
      s.context = await chromium.launchPersistentContext(dir, {
        ...options,
        headless,
        args,
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
      });
      return s.context;
    } catch (err) {
      lastError = err;
    }
  }
  throw noBrowser(lastError);
}

/**
 * `attach` — your own Chrome, already running and already signed in.
 *
 * Three things here would each break somebody's browser if done the obvious way:
 *
 *   **No `newContext()`.** On a CDP connection that opens an *incognito* context
 *   — no cookies, no sessions — which throws away the only reason to attach.
 *   The existing context is used instead.
 *
 *   **No `newPage()` into a fresh context**, for the same reason.
 *
 *   **Nothing is closed on the way out.** See `closeBrowser`: these are the
 *   user's tabs and the user's browser, and this code borrowed them.
 */
async function openAttached(s) {
  const { chromium } = await import('playwright-core');
  const endpoint = cdpEndpoint();

  try {
    s.browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    /**
     * Say something the reader can act on *from where they are*.
     *
     * This used to end with "switch this computer to the profile or sandbox
     * browser in Settings → Computers" — and then that setting was removed, so
     * the message sent people looking for a control that no longer exists.
     * `attach` is now reachable only by setting BROWSER_MODE on this machine,
     * so that is what the way out has to name.
     */
    throw new Error(
      `No browser is listening on ${endpoint}. This computer is set to drive your own Chrome ` +
        `(BROWSER_MODE=attach in worker/.env), which needs Chrome started with ` +
        `--remote-debugging-port=${CDP_PORT} — quit it completely first, or the flag is ignored. ` +
        `To go back to a clean sandbox instead, remove BROWSER_MODE from worker/.env and restart ` +
        `the worker. (${err?.message?.split('\n')[0]})`,
    );
  }

  const existing = s.browser.contexts();
  if (!existing.length) {
    // A Chrome with a debugging port but no context is one that is shutting
    // down. Say so, rather than opening an incognito window and calling it
    // the user's browser.
    await s.browser.close().catch(() => {});
    s.browser = null;
    throw new Error(`Chrome at ${endpoint} has no open window to work in. Open a tab and try again.`);
  }

  s.context = existing[0];
  return s.context;
}

/**
 * The context outlives any one tab.
 *
 * Keeping it separate from `page` is what makes tabs possible at all: a second
 * tab is another page in the same context, sharing cookies and session. It also
 * fixes the thing that made this feel broken — asking for a news site while
 * music was playing used to navigate the only tab there was, killing the audio.
 */
async function ensureContext(s) {
  if (contextIsLive(s)) return s.context;

  s.context = null;
  s.browser = null;

  if (mode === 'profile') await openProfile(s);
  else if (mode === 'attach') await openAttached(s);
  else await openSandbox(s);

  // A page opened by the site itself — target="_blank", window.open — is a tab
  // the user would see appear, so treat it as one and follow it.
  s.context.on('page', (opened) => {
    opened.setDefaultTimeout(20_000);
  });

  /**
   * Adopt a tab that is already there rather than opening another one.
   *
   * Both non-sandbox modes start with pages in hand, for different reasons, and
   * both were leaving a stray tab behind without this.
   *
   *   `attach`   the person's own tabs, and acting on one of them is the entire
   *              point — opening a new window in front of what they were
   *              reading is the opposite of what was asked for.
   *
   *   `profile`  a persistent context always opens with one `about:blank`. The
   *              first `browser_open` would make a second tab and leave the
   *              blank one sitting in `browser_tabs` forever, where the model
   *              has to reason about a tab that means nothing.
   */
  if (mode !== 'sandbox' && !browserIsOpen(s)) {
    const open = s.context.pages().filter((p) => !p.isClosed());
    if (open.length) await focusPage(s, open[0]);
  }

  return s.context;
}

/**
 * Make this tab the one being acted on and mirrored.
 *
 * **Nothing is brought to the front, and that is the fix.**
 *
 * This used to call `page.bringToFront()` on every tab switch, on the belief —
 * stated in a comment here for a long time — that "Chrome only screencasts the
 * tab it considers active". That belief is wrong, and it was the entire cause of
 * the sandbox popping up over whatever the user was doing: bringing a tab forward
 * activates the window it lives in, and on Windows an activated window takes the
 * keyboard with it. Every lookup the assistant did stole the cursor mid-sentence.
 *
 * Measured rather than assumed. With a screencast running on a *background* tab,
 * against a Chrome window that is not the foreground window:
 *
 *     active tab      rAF advanced 272 frames · screencast 270 frames
 *     background tab  rAF advanced 268 frames · screencast 266 frames
 *
 * Identical, and `document.hidden` reads `false` throughout — starting a
 * screencast on a target is itself what keeps that target rendering, so the
 * activation bought nothing and cost the user their focus. Animation, video and
 * audio all continue.
 *
 * So the window is never raised. It stays parked off the edge of the desktop
 * where `launch` puts it, sound still comes out of the machine's speakers, and
 * the frames still arrive.
 */
async function focusPage(s, next) {
  if (s.page === next) return s.page;
  s.page = next;
  s.page.setDefaultTimeout(20_000);
  await startScreencast(s);
  return s.page;
}

/** Every open tab, in the order Chrome has them. */
function tabs(s) {
  if (!contextIsLive(s)) return [];
  return s.context.pages().filter((p) => !p.isClosed());
}

/**
 * The open tabs, for the panel's tab strip.
 *
 * Titles are not read here: `page.title()` is a round trip into the page and
 * this is called on every frame. The URL's host is enough to tell one tab from
 * another at a glance, and the active tab's real title is already in the bar
 * above. Anything more would cost a promise per tab per repaint.
 */
function tabSummary(s) {
  return tabs(s).map((p, i) => {
    let host = '';
    try {
      host = new URL(p.url()).host.replace(/^www\./, '');
    } catch {
      host = 'new tab';
    }
    return { index: i + 1, host, active: p === s.page };
  });
}

/**
 * Let go of one conversation's browser.
 *
 * **In `attach` mode this must not close anything.** The context holds the
 * user's tabs and the browser is the one they are using; closing either would
 * take down their work because a tool call finished. Attached means borrowed —
 * the screencast stops, the connection is dropped, and their Chrome carries on
 * exactly as it was.
 *
 * **In `sandbox` mode only the context closes.** The Chrome process is shared
 * by every conversation, so closing it here would shut the browser of every
 * other conversation that happens to be using one. It goes when the last
 * session does — see `closeBrowser`.
 */
async function closeSession(s) {
  await stopScreencast(s);
  sessions.delete(s.key);

  const borrowed = mode === 'attach';
  const held = { browser: s.browser, context: s.context };
  s.context = null;
  s.page = null;
  s.browser = null;

  if (streaming === s) {
    streaming = null;
    release('browser');
  }

  if (borrowed) {
    // `close()` on a CDP connection disconnects this client without touching
    // the browser it was talking to — the tabs stay open, which is the point.
    try {
      await held.browser?.close();
    } catch {
      /* already disconnected */
    }
    return;
  }

  try {
    await held.context?.close();
  } catch {
    /* already gone */
  }

  // In `profile` mode the persistent context *is* the browser, so closing it
  // above already stopped the process. In `sandbox` the process is shared, and
  // is only shut once nothing is left holding it.
  if (mode === 'sandbox' && !sessions.size && sandboxBrowser) {
    const done = sandboxBrowser;
    sandboxBrowser = null;
    await done.close().catch(() => {});
  }
}

/**
 * Let go of everything — used when the mode changes and at shutdown.
 *
 * A session opened as a sandbox is not the signed-in profile somebody has just
 * asked for, so carrying any of them across a mode change would quietly do the
 * work in the wrong browser while the interface said otherwise.
 */
export async function closeBrowser() {
  for (const s of [...sessions.values()]) await closeSession(s).catch(() => {});
  if (sandboxBrowser) {
    const done = sandboxBrowser;
    sandboxBrowser = null;
    await done.close().catch(() => {});
  }
}

// ── frames ────────────────────────────────────────────────────────────

/**
 * Chrome's own screencast, rather than a screenshot on a timer.
 *
 * The difference is not small: a screenshot loop caps out around 2 frames a
 * second and spends most of its time rasterising pages that have not changed,
 * while the screencast is driven by the compositor — it fires when the page
 * actually repaints, at up to 40 frames a second, and costs nothing at all
 * while the page sits still. A playing video looks like a playing video.
 */
/**
 * Send the newest frame, and only the newest.
 *
 * This is what makes the mirror feel live rather than merely fast. Chrome
 * screencasts on every repaint and the ack goes back immediately, so frames
 * keep arriving whether or not the previous one has finished its trip to the
 * server — and each one is an HTTP round trip carrying ~90KB. Awaiting them in
 * order builds a queue, and a queue of frames is not a slow video: it is a
 * *delayed* one, drifting further behind the real page with every repaint,
 * which is exactly what "it lags" means.
 *
 * So there is no queue. One request is in flight at a time; anything that
 * arrives while it is out replaces whatever was waiting. Frames get dropped
 * under load, which is the correct thing to drop — nobody wants to watch the
 * page as it was four seconds ago.
 */
let inFlight = false;
let queued = null;

async function publishLatest(payload) {
  queued = payload;
  if (inFlight) return;

  inFlight = true;
  try {
    while (queued) {
      const next = queued;
      queued = null;
      await publishFrame(next);
      // Only the session that owns the panel can change its resolution.
      if (streaming) applyPreference(streaming);
    }
  } finally {
    inFlight = false;
  }
}

/** How many pixels to capture, and how hard to compress them. */
function castOptions(s, hd) {
  const scale = hd ? Number(process.env.SCREEN_HD_SCALE) || 2 : 1;
  return {
    format: 'jpeg',
    // Full screen on a 2K monitor is a 1280-wide frame stretched to twice its
    // size, which is the blur. Asked for at the real size, it is not.
    quality: hd ? Number(process.env.SCREEN_HD_QUALITY) || 72 : Number(process.env.SCREEN_QUALITY) || 58,
    maxWidth: Math.round(VIEWPORT.width * scale),
    maxHeight: Math.round(VIEWPORT.height * scale),
    // Every frame by default. The screencast already fires only on repaint, so
    // skipping frames on top of that means a page that paints once — which is
    // most pages — streams nothing at all.
    everyNthFrame: Math.max(1, Number(process.env.SCREEN_EVERY_NTH) || 1),
  };
}

/**
 * Which session currently owns the live panel.
 *
 * There is one screen to watch, so one session streams at a time: whichever
 * acted most recently. `screen.js` already knows how to hand the channel over,
 * so that is reused rather than a second mechanism built beside it.
 */
let streaming = null;

/**
 * Follow the panel between its two sizes.
 *
 * Restarting a screencast is cheap and changing its parameters is not possible
 * any other way, so this happens on the frame *after* somebody presses expand —
 * one frame of the old size, then the new one.
 */
function applyPreference(s) {
  const wanted = !!watcherPreference().hd;
  if (wanted === s.castingHd || !s.screencast) return;
  s.castingHd = wanted;
  s.screencast.send('Page.startScreencast', castOptions(s, wanted)).catch(() => {});
}

async function startScreencast(s) {
  await stopScreencast(s);

  // Taking the panel from whichever conversation had it. Without this, two
  // conversations browsing at once would both push frames and the viewer would
  // see them interleaved.
  if (streaming && streaming !== s) await stopScreencast(streaming).catch(() => {});
  streaming = s;
  await claim('browser', () => stopScreencast(s));

  const cdp = await s.page.context().newCDPSession(s.page);
  // Without Page.enable the screencast starts but delivers exactly one frame.
  await cdp.send('Page.enable');

  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    // Acknowledge first and unconditionally: Chrome stops sending until the
    // previous frame is acked, so a slow sink would otherwise end the stream.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    publishLatest({
      frame: data,
      source: 'browser',
      url: s.page?.url() ?? '',
      title: s.lastTitle,
      tabs: tabSummary(s),
      width: metadata?.deviceWidth || VIEWPORT.width,
      height: metadata?.deviceHeight || VIEWPORT.height,
    });
  });

  s.castingHd = !!watcherPreference().hd;
  await cdp.send('Page.startScreencast', castOptions(s, s.castingHd));

  s.screencast = cdp;
}

/**
 * Publish one frame directly.
 *
 * Insurance for the still-page case: the screencast is driven by repaints, and
 * a page that has finished loading produces none. Without this the user would
 * watch an action complete and see nothing change, because nothing did.
 */
async function pushStill(s) {
  if (!browserIsOpen(s)) return;
  try {
    const shot = await s.page.screenshot({ type: 'jpeg', quality: Number(process.env.SCREEN_QUALITY) || 55 });
    await publishFrame({
      frame: shot.toString('base64'),
      source: 'browser',
      url: s.page.url(),
      title: s.lastTitle,
      tabs: tabSummary(s),
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
  } catch {
    /* a frame is never worth failing the action that produced it */
  }
}

async function stopScreencast(s) {
  if (!s.screencast) return;
  const cdp = s.screencast;
  s.screencast = null;
  try {
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
  } catch {
    /* the page is already gone, which is the same outcome */
  }
}

// ── looking at the page ───────────────────────────────────────────────

/**
 * Tag every interactive element in the viewport with a number and report it.
 * Runs in the page, so it sees what a person would see.
 */
const SNAPSHOT = (offset = 0) => {
  const SELECTOR =
    'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="textbox"],[role="checkbox"],[role="menuitem"],[contenteditable="true"],[onclick]';

  /**
   * Wipe the previous numbering before laying down a new one.
   *
   * Only what is in the viewport gets numbered, so a page that has scrolled
   * leaves its old tags behind on elements above the fold. Two elements then
   * answer to `[3]`, `locator(...).first()` picks whichever comes first in the
   * document — the stale one — and the click lands on something the model was
   * never looking at. Not a near miss: a different, real, clickable control.
   */
  for (const stale of document.querySelectorAll('[data-air-ref]')) {
    stale.removeAttribute('data-air-ref');
  }

  const elements = [];
  let index = offset;

  for (const el of document.querySelectorAll(SELECTOR)) {
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    if (box.bottom < 0 || box.top > innerHeight) continue;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;

    index += 1;
    el.setAttribute('data-air-ref', String(index));

    /**
     * What the control is, and separately what is in it.
     *
     * These used to be one string with the placeholder ahead of the value — so
     * a field with a placeholder reported its placeholder forever, whatever you
     * typed. Filling a form then became guesswork: the model could not read
     * back its own work, could not tell an empty field from a full one, and
     * would retype into fields that were already correct.
     */
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.innerText) ||
      el.getAttribute('name') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);

    let value = '';
    if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : 'unchecked';
    else if (tag === 'select') value = el.options?.[el.selectedIndex]?.text || '';
    else if (tag === 'input' || tag === 'textarea') value = el.value || '';
    else if (el.isContentEditable) value = el.innerText || '';

    elements.push({
      ref: index,
      tag,
      type,
      label,
      value: String(value).replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    next: index,
    text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim(),
  };
};

/** How much of a page the model is shown before it has to scroll or narrow. */
const MAX_ELEMENTS = 140;
const MAX_TEXT = 5_000;

/**
 * Every frame that is actually on screen, the main one first.
 *
 * A hidden iframe's contents still measure normally inside their own document,
 * so without checking the frame element itself the listing fills up with
 * controls nobody can see — Lightning keeps a good number of those around.
 */
async function visibleFrames(s) {
  const out = [s.page.mainFrame()];
  for (const frame of s.page.frames()) {
    if (frame === s.page.mainFrame() || frame.isDetached()) continue;
    try {
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      if (box && box.width > 4 && box.height > 4) out.push(frame);
    } catch {
      // Detached between listing the frames and asking about one. Skip it:
      // anything it held is gone from the page too.
    }
  }
  return out;
}

/**
 * Read the page, including everything inside its frames.
 *
 * This was the single worst bug in the sandbox. `document.querySelectorAll` in
 * the top document does not cross an iframe boundary, and neither does
 * `page.locator` — so on any application that puts its real interface in a
 * frame, the assistant was shown the navigation chrome and nothing else. It
 * could not see the form it was asked to fill in, could not click a control
 * inside it, and had no way to tell that anything was missing. Salesforce
 * Lightning does exactly this with record modals and Visualforce pages, which
 * is why it kept failing there and nowhere obvious.
 *
 * Numbering runs across the frames as one sequence, so `[7]` means one thing on
 * the page rather than one thing per document.
 */
async function snapshotAll(s) {
  const frames = await visibleFrames(s);
  const elements = [];
  const texts = [];
  let offset = 0;
  let url = s.page.url();
  let title = '';

  for (const frame of frames) {
    let snap;
    try {
      snap = await frame.evaluate(SNAPSHOT, offset);
    } catch {
      continue; // navigated away mid-read; the next look will catch it
    }
    if (frame === s.page.mainFrame()) {
      url = snap.url;
      title = snap.title;
      if (snap.text) texts.push(snap.text);
    } else if (snap.text) {
      // Named, because a model that cannot tell chrome from content will try to
      // "go back" to text that is sitting inside the panel in front of it.
      texts.push(`--- inside frame: ${snap.title || snap.url} ---\n${snap.text}`);
    }
    elements.push(...snap.elements);
    offset = snap.next;
  }

  const text = texts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    url,
    title,
    frames: frames.length,
    elements: elements.slice(0, MAX_ELEMENTS),
    hidden: Math.max(0, elements.length - MAX_ELEMENTS),
    text: text.slice(0, MAX_TEXT),
    clipped: text.length > MAX_TEXT,
  };
}

function describe(snapshot, note) {
  const lines = [];
  if (note) lines.push(note, '');
  lines.push(`Page: ${snapshot.title || '(untitled)'}`, `URL: ${snapshot.url}`);
  if (snapshot.frames > 1) {
    lines.push(`This page has ${snapshot.frames - 1} embedded frame(s); their contents are listed below too.`);
  }
  lines.push('');

  if (snapshot.elements.length) {
    lines.push('Things you can act on (use the number as `ref`, and `= …` is what is in it now):');
    for (const e of snapshot.elements) {
      const kind = e.type ? `${e.tag}/${e.type}` : e.tag;
      const filled = e.value ? `  = ${JSON.stringify(e.value)}` : '';
      lines.push(`  [${e.ref}] ${kind}  ${e.label || '(no label)'}${filled}`);
    }
    // Silently cutting the list is how a model concludes a control does not
    // exist and starts inventing a way around it.
    if (snapshot.hidden) {
      lines.push(
        `  … and ${snapshot.hidden} more not listed. Scroll to bring the part you want into view, then look again.`,
      );
    }
    lines.push('');
  } else {
    lines.push('No interactive elements are visible. Try scrolling.', '');
  }

  lines.push('Visible text:', snapshot.text || '(none)');
  if (snapshot.clipped) lines.push('', '[text truncated — scroll for the rest]');
  return lines.join('\n');
}

/** Snapshot, capture a frame, and describe the result to the model. */
/**
 * A small picture of the page as this step left it.
 *
 * Separate from `pushStill` above, which feeds the live panel and is thrown away
 * the instant the next frame arrives. This one is kept: it goes back with the
 * tool result, is stored, and is still there when somebody scrolls up tomorrow
 * to see what happened.
 *
 * Small on purpose. A run of a dozen browser steps is a dozen of these, and the
 * point is a strip you can take in at a glance rather than a dozen full-width
 * screenshots to scroll past — with the storage cost that would imply.
 *
 * Never worth failing a step over: a missing illustration is a smaller problem
 * than an action that reports an error it did not have.
 */
const SHOT_WIDTH = 320;
const SHOT_MAX_BYTES = 40 * 1024;

async function thumbnail(s) {
  if (!browserIsOpen(s)) return null;

  let cdp = null;
  try {
    /**
     * Through CDP rather than `page.screenshot`, for one reason: `clip.scale`.
     * Playwright does not expose it, so its screenshot comes back at full
     * viewport size and would have to be resized afterwards — which here would
     * mean opening a canvas page in the user's own browser, in `attach` mode, to
     * shrink a picture. Chrome will simply render it small if asked.
     */
    cdp = await s.page.context().newCDPSession(s.page);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: Math.min(Math.max(Number(process.env.STEP_SHOT_QUALITY) || 45, 10), 90),
      captureBeyondViewport: false,
      clip: {
        x: 0,
        y: 0,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        scale: SHOT_WIDTH / VIEWPORT.width,
      },
    });

    if (!data) return null;
    // base64 carries 3 bytes in every 4 characters.
    if ((data.length * 3) / 4 > SHOT_MAX_BYTES) return null;
    return { mime: 'image/jpeg', data };
  } catch {
    return null;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

/**
 * What the model reads, plus what the person watching sees.
 *
 * Returns an object rather than a string. The worker's job runner understands
 * both shapes — see `runJob` — so tools that have nothing to illustrate carry on
 * returning plain text.
 */
async function report(s, note) {
  // A moment for the page to settle after an action before we look at it.
  await s.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await s.page.waitForTimeout(350);

  const snapshot = await snapshotAll(s);
  s.lastTitle = snapshot.title || '';
  await pushStill(s);
  return { text: describe(snapshot, note), shot: await thumbnail(s) };
}

/**
 * Resolve a ref to exactly one element, or say why not.
 *
 * Searched frame by frame, because the numbers are laid down frame by frame and
 * `page.locator` cannot see into one. A ref matching two elements should never
 * happen now that each snapshot clears its own document first, but "should
 * never happen" is how the last version of this bug was described too — and the
 * failure mode is pressing the wrong button on somebody else's screen. Refusing
 * is cheap; guessing is not.
 */
async function elementFor(s, ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('`ref` must be one of the numbers from the latest page listing.');
  }

  for (const frame of await visibleFrames(s)) {
    const target = frame.locator(`[data-air-ref="${n}"]`);
    const count = await target.count().catch(() => 0);
    if (count === 1) return target.first();
    if (count > 1) {
      throw new Error(
        `[${ref}] matches ${count} elements, which means the listing is stale. Call browser_look again.`,
      );
    }
  }

  throw new Error(
    `There is no element [${ref}] on the page now. Call browser_look again — the page may have changed.`,
  );
}

// ── the tools ─────────────────────────────────────────────────────────

async function browserOpen({ url, replace_tab: replaceTab, new_tab: newTab }, job) {
  const s = await sessionFor(job?.chatId);
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('Give a full http(s) URL, for example https://www.youtube.com.');
  }

  const ctx = await ensureContext(s);
  // A new tab unless told otherwise. Reusing the one tab is how a video the
  // user was listening to got closed to make room for a news site, and how a
  // half-filled form vanished to look something up — and the model had to
  // remember to prevent it every time. `new_tab` is still honoured so an older
  // habit does not become an error.
  /**
   * A blank tab is not a tab worth keeping.
   *
   * A persistent profile always opens with one `about:blank`, and an attached
   * Chrome often has one too. Without this, the first `browser_open` puts a
   * page beside it and the blank one stays in `browser_tabs` for the rest of
   * the session — a tab the model has to reason about that means nothing, and
   * one the user watches accumulate.
   */
  const blankHere = browserIsOpen(s) && /^about:blank$|^chrome:\/\/newtab/.test(s.page.url());
  const reuse = replaceTab === true || newTab === false || blankHere;
  if (!reuse || !browserIsOpen(s)) await focusPage(s, await ctx.newPage());

  await s.page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  const count = tabs(s).length;
  return report(s, `Opened ${target}${count > 1 ? ` in a new tab (${count} open)` : ''}.`);
}

/**
 * Connect first when the browser is somebody else's.
 *
 * In `sandbox` and `profile` modes, "nothing is open" is the truth until the
 * assistant opens something, and launching a browser merely to answer *"what is
 * open?"* would be a surprising side effect of a read.
 *
 * `attach` is the opposite case, and getting this wrong made the mode look
 * broken: the tabs exist already — they are the reason the mode exists — but
 * nothing had connected to Chrome yet, so `browser_tabs` answered "No tabs are
 * open" and `browser_look` answered "No page is open. Use browser_open first."
 * against a browser with a dozen tabs in front of the user. The model would
 * then dutifully open a *new* tab, which is precisely what attaching is meant
 * to avoid.
 */
async function ensureAttached(s) {
  if (mode !== 'attach' || contextIsLive(s)) return;
  await ensureContext(s);
}

async function browserTabs(input, job) {
  const s = await sessionFor(job?.chatId);
  await ensureAttached(s);
  const open = tabs(s);
  if (!open.length) return 'No tabs are open.';

  const titles = await Promise.all(
    open.map(async (p, i) => {
      const title = await p.title().catch(() => '');
      return `  [${i + 1}]${p === s.page ? ' ←' : '  '} ${title || '(untitled)'}\n       ${p.url()}`;
    }),
  );
  return ['Open tabs (← is the one you are acting on):', '', ...titles].join('\n');
}

async function browserSwitch({ tab }, job) {
  const s = await sessionFor(job?.chatId);
  const open = tabs(s);
  const index = Number(tab);
  if (!Number.isInteger(index) || index < 1 || index > open.length) {
    throw new Error(`There is no tab ${tab}. Call browser_tabs to see what is open.`);
  }
  await focusPage(s, open[index - 1]);
  return report(s, `Switched to tab ${index}.`);
}

async function browserCloseTab({ tab }, job) {
  const s = await sessionFor(job?.chatId);
  const open = tabs(s);
  const index = tab == null ? open.indexOf(s.page) + 1 : Number(tab);
  if (!Number.isInteger(index) || index < 1 || index > open.length) {
    throw new Error(`There is no tab ${tab}. Call browser_tabs to see what is open.`);
  }

  // Attached to the user's own Chrome, the last tab is not ours to close: on
  // most platforms closing it takes the whole browser with it, and everything
  // they had open goes too.
  if (mode === 'attach' && open.length === 1) {
    throw new Error(
      'That is the only tab open in the user\'s own browser, and closing it would quit their ' +
        'browser. Leave it open, or ask them to close it themselves.',
    );
  }

  const closing = open[index - 1];
  await closing.close().catch(() => {});
  const left = tabs(s);
  if (!left.length) {
    s.page = null;
    return 'Closed the last tab. The sandbox has nothing open now.';
  }
  if (closing === s.page) await focusPage(s, left[0]);
  return report(s, `Closed tab ${index}. ${left.length} still open.`);
}

async function browserLook(input, job) {
  const s = await sessionFor(job?.chatId);
  await ensureAttached(s);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  return report(s, 'Current page:');
}

async function browserClick({ ref, description }, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(s, ref);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 15_000 });
  return report(s, `Clicked [${ref}]${description ? ` (${description})` : ''}.`);
}

async function browserType({ ref, text, submit = false }, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(s, ref);
  await target.click({ timeout: 15_000 }).catch(() => {});
  await target.fill(String(text ?? ''), { timeout: 15_000 });
  if (submit) await s.page.keyboard.press('Enter');
  return report(s, `Typed into [${ref}]${submit ? ' and pressed Enter' : ''}.`);
}

async function browserPress({ key }, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  await s.page.keyboard.press(String(key || 'Enter'));
  return report(s, `Pressed ${key}.`);
}

/**
 * Back and forward, for the model.
 *
 * The panel has had these for the person watching; the model had to re-open a
 * remembered URL, which is not the same act — it discards the scroll position and
 * cannot reach a page that was arrived at by clicking.
 *
 * `goBack` resolves to null when there is nothing in the history, which is worth
 * saying rather than reporting a move that did not happen.
 */
async function browserBack(input, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const response = await s.page
    .goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    .catch(() => null);
  if (!response) return report(s, 'There was nothing to go back to; the page has not moved.');
  return report(s, 'Went back.');
}

async function browserForward(input, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const response = await s.page
    .goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    .catch(() => null);
  if (!response) return report(s, 'There was nothing to go forward to; the page has not moved.');
  return report(s, 'Went forward.');
}

/**
 * Set a native dropdown.
 *
 * Clicking a `<select>` does not open anything a subsequent click can reach — the
 * option list is drawn by the operating system, not by the page — so without this
 * a form with a dropdown in it could not be completed at all.
 *
 * Matched on the visible label first, because that is what the listing shows and
 * therefore what the model has to work from, then on the underlying value.
 */
async function browserSelect({ ref, value }, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(s, ref);
  const wanted = String(value ?? '');

  await target.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await target.selectOption({ label: wanted }, { timeout: 10_000 });
  } catch {
    try {
      await target.selectOption({ value: wanted }, { timeout: 10_000 });
    } catch {
      // Say what the choices actually are. "Timed out" tells the model nothing it
      // can act on, and guessing a second time is what it would do instead.
      const options = await target
        .evaluate((el) => [...(el.options || [])].map((o) => o.text.trim()).filter(Boolean))
        .catch(() => []);
      throw new Error(
        options.length
          ? `[${ref}] has no option "${wanted}". The choices are: ${options.join(' · ')}.`
          : `[${ref}] is not a dropdown, so there is nothing to select. Use browser_click or browser_type.`,
      );
    }
  }
  return report(s, `Chose "${wanted}" in [${ref}].`);
}

/** Hover, for menus that only exist while the pointer is on them. */
async function browserHover({ ref }, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const target = await elementFor(s, ref);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.hover({ timeout: 10_000 });
  return report(s, `Hovering over [${ref}]. Anything that only appears on hover is in the listing below.`);
}

async function browserScroll({ direction = 'down', amount = 1 }, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const steps = Math.min(Math.max(Number(amount) || 1, 1), 10);
  const delta = (direction === 'up' ? -1 : 1) * VIEWPORT.height * 0.85 * steps;
  await s.page.mouse.wheel(0, delta);
  await s.page.waitForTimeout(400);
  return report(s, `Scrolled ${direction}.`);
}

async function browserWait({ seconds = 3 }, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) throw new Error('No page is open. Use browser_open first.');
  const wait = Math.min(Math.max(Number(seconds) || 3, 1), 30);
  // Nothing to pump here any more — the screencast pushes frames on its own
  // clock, so a video plays at video speed while this simply waits.
  await s.page.waitForTimeout(wait * 1000);
  return report(s, `Waited ${wait} seconds while the user watched.`);
}

/**
 * Say what actually happened.
 *
 * This used to report "Closed the browser" unconditionally, including when
 * there was no sandbox at all — which is exactly how someone ends up staring at
 * a page in their own Chrome that they were told had been closed. The sandbox
 * and the user's browser are different programs, and only one of them is ours
 * to shut.
 */
async function browserClose(input, job) {
  const s = await sessionFor(job?.chatId);
  if (!browserIsOpen(s)) {
    return (
      'There was no sandbox open, so nothing was closed.\n\n' +
      'If the user is looking at a page you opened with `open_url`, that is their own browser — ' +
      'you cannot close it from here. Either ask them to close the tab, or use the desktop tools ' +
      'to close that window for them if they would rather you did it.'
    );
  }
  const borrowed = mode === 'attach';
  // This conversation's browser, not every conversation's. `closeBrowser` shuts
  // all of them and belongs to shutdown and mode changes — calling it here meant
  // finishing in one chat closed a browser somebody was still using in another.
  await closeSession(s);
  return borrowed
    ? 'Let go of the user\'s browser. Their tabs are untouched and still open — this only stopped ' +
        'driving them, and the screen panel will stop updating.'
    : 'Closed the sandbox browser for this conversation. The screen panel will stop updating.';
}

/**
 * Let the person watching reach into the page.
 *
 * Dispatched through CDP rather than Playwright's helpers because these are raw
 * coordinates from a click on an image, not a located element — and because the
 * events have to be indistinguishable from a real mouse to the page.
 *
 * Coordinates arrive normalised (0–1) so the panel does not need to know the
 * viewport, and a phone showing a scaled-down mirror still lands in the right
 * place.
 */
export async function userInput({ type, x, y, toX, toY, button = 'left', key, text, deltaX, deltaY }) {
  const s = await sessionFor(null);
  if (!browserIsOpen(s)) throw new Error('Nothing is open in the sandbox.');
  const cdp = await s.page.context().newCDPSession(s.page);
  try {
    const toPixels = (value, extent) => Math.round(Math.min(Math.max(Number(value) || 0, 0), 1) * extent);
    const px = toPixels(x, VIEWPORT.width);
    const py = toPixels(y, VIEWPORT.height);

    /**
     * A press, a path, and a release — as one call.
     *
     * Not three. A chart is panned by holding the button down and moving, and a
     * page only believes that if it sees the moves *between* the two ends: send
     * press and release alone and TradingView reads a click on empty canvas and
     * does nothing. Sending each mousemove as its own request would be a round
     * trip per pixel over a link that may be a phone on mobile data, and the
     * gesture would arrive as a stutter of unrelated jumps.
     *
     * So the browser sends where the drag started and where it ended, and the
     * path is drawn here, next to the page, where the steps cost nothing.
     */
    if (type === 'drag') {
      const tx = toPixels(toX, VIEWPORT.width);
      const ty = toPixels(toY, VIEWPORT.height);

      // `buttons: 1` on every event of the gesture. Without the bitmask a page
      // that listens for pointer events sees moves with no button held and
      // treats the whole thing as hovering.
      const held = { button: 'left', buttons: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, clickCount: 1, ...held });

      // Enough steps that momentum-based interfaces read it as a movement, and
      // few enough that the whole gesture is over in well under a second.
      const steps = 24;
      for (let i = 1; i <= steps; i += 1) {
        // Ease out, so the path ends the way a hand does rather than stopping
        // dead at full speed — kinetic scrolling reads the last few moves.
        const t = 1 - (1 - i / steps) ** 2;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(px + (tx - px) * t),
          y: Math.round(py + (ty - py) * t),
          ...held,
        });
        await new Promise((r) => setTimeout(r, 8));
      }

      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: tx,
        y: ty,
        clickCount: 1,
        button: 'left',
        buttons: 0,
      });
      await pushStill(s);
      return 'dragged';
    }

    if (type === 'click') {
      for (const eventType of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: eventType,
          x: px,
          y: py,
          button,
          clickCount: 1,
        });
      }
      return 'clicked';
    }
    if (type === 'move') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      return 'moved';
    }
    if (type === 'scroll') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: px,
        y: py,
        // Sideways too: a wide table or a timetable scrolls across, and this
        // was hard-coded to 0 (owner, 2026-10-07).
        deltaX: Math.max(-3000, Math.min(3000, Number(deltaX) || 0)),
        deltaY: Number(deltaY) || 0,
      });
      return 'scrolled';
    }
    if (type === 'text') {
      await s.page.keyboard.insertText(String(text ?? ''));
      return 'typed';
    }
    if (type === 'key') {
      await s.page.keyboard.press(String(key || 'Enter'));
      return 'pressed';
    }
    // Navigation, so the panel is a browser window rather than a picture of
    // one. Watching an assistant take a wrong turn and being unable to press
    // Back is a strange kind of helplessness.
    if (type === 'back') {
      await s.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await pushStill(s);
      return 'back';
    }
    if (type === 'forward') {
      await s.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await pushStill(s);
      return 'forward';
    }
    if (type === 'reload') {
      await s.page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await pushStill(s);
      return 'reloaded';
    }
    // Switching tabs from the strip. The assistant reads whichever tab is
    // focused on its next look, so this moves it too — which is the point:
    // "look at this one instead" is a thing you should be able to say by
    // pressing a tab rather than by typing a sentence.
    if (type === 'tab') {
      const open = tabs(s);
      const index = Number(key);
      if (!Number.isInteger(index) || index < 1 || index > open.length) {
        throw new Error(`There is no tab ${key}.`);
      }
      await focusPage(s, open[index - 1]);
      await pushStill(s);
      return `tab ${index}`;
    }
    throw new Error(`Unknown input "${type}".`);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * A real PDF, printed by the browser that is already here.
 *
 * The app has always told people to open a document in the viewer and use their
 * browser's Print → Save as PDF, on the grounds that generating one server-side
 * would need a PDF engine and would get the fonts wrong. That reasoning was
 * sound; the conclusion was not, because there is a browser on this machine
 * already and it is the same browser the advice was pointing at.
 *
 * Verified rather than assumed: `page.pdf()` is documented as headless-only and
 * is not. Printed from a headed Chrome on this machine it produces a 35KB A4
 * document with Vietnamese diacritics intact, which is the whole reason to print
 * through a browser rather than compose one by hand.
 *
 * Rendered in its own tab in the sandbox, so the person watching sees the page
 * being printed rather than a file appearing from nowhere. The tab is closed
 * afterwards whatever happens — a print job must not leave litter behind.
 */
export async function renderPdf({ html, url, landscape = false }) {
  /**
   * Checked before a browser is started, not after a tab is open.
   *
   * This was the only url-taking tool on this machine that checked nothing.
   * `browserOpen` requires `^https?://`; `download_file` goes through
   * `safeFetch`, which refuses every private range. This went straight to
   * `goto` with whatever the model supplied, and `assessRisk` grades
   * `export_pdf` `ordinary` — so under the default policy it ran with no
   * prompt. `file:///C:/Users/…/.env` rendered somebody's secrets into a PDF
   * inside the workspace, where `read_file` picks it up;
   * `http://169.254.169.254/` did the same for cloud metadata on a hosted
   * worker.
   *
   * The scheme test is what closes the local-file read outright. `assertPublic`
   * is a mitigation and not a guarantee, and it is worth being exact about why:
   * it resolves the name, and Playwright then resolves it again when it
   * connects. That is the same time-of-check gap `safeFetch` closes by pinning
   * the socket, and there is no equivalent hook in the browser — so a
   * one-second-TTL rebind is still reachable. It stops every static private
   * target, which is what is actually aimed at.
   *
   * Up here rather than beside the `goto` so a refusal costs nothing: no
   * browser started, no tab opened, no tab to clean up.
   */
  const target = url ? String(url).trim() : '';
  if (target) {
    if (!/^https?:\/\//i.test(target)) {
      throw new Error('Printing needs a full http(s) URL. To print your own markup, pass `html` instead.');
    }
    await assertPublic(new URL(target));
  }

  const s = await sessionFor(null);
  const ctx = await ensureContext(s);
  const sheet = await ctx.newPage();

  try {
    if (target) {
      await sheet.goto(target, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    } else {
      await sheet.setContent(String(html ?? ''), { waitUntil: 'load', timeout: NAV_TIMEOUT });
    }
    // Web pages are written for screens and often hide print styling; asking for
    // the screen rendering is what makes the output look like the page.
    await sheet.emulateMedia({ media: 'screen' });
    return await sheet.pdf({
      format: 'A4',
      landscape: !!landscape,
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await sheet.close().catch(() => {});
    // Printing must not steal the tab the assistant was working in.
    const left = tabs(s);
    if (s.page?.isClosed?.() && left.length) await focusPage(s, left[0]);
  }
}

/**
 * Resize, crop, rotate and re-encode a picture — in the browser that is here.
 *
 * The alternative was `sharp`, which means a native module with prebuilt binaries
 * per platform and per Node version: a real dependency, in a project that has nine
 * and uses `playwright-core` rather than `playwright` precisely to avoid that kind
 * of weight. A canvas does all of this and is already installed.
 *
 * Two things worth knowing about the implementation. The work happens inside the
 * page rather than here, because that is where the decoder and the encoder live.
 * And the source arrives as a data URI rather than a file:// URL — a page loaded
 * from `about:blank` cannot read the local disk, and giving it that ability to save
 * one base64 round trip would be a poor trade.
 */
export async function renderImage({ data, mime, width, height, crop, rotate = 0, flip, format = 'png', quality = 0.9 }) {
  const s = await sessionFor(null);
  const ctx = await ensureContext(s);
  const sheet = await ctx.newPage();

  try {
    const result = await sheet.evaluate(
      async (job) => {
        const image = new Image();
        image.src = `data:${job.mime};base64,${job.data}`;
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('The bytes are not an image this browser can decode.'));
        });

        // Crop first: everything after it is measured against the piece that was
        // kept, which is what somebody asking to "crop then resize" means.
        const sx = Math.max(0, Math.min(job.crop?.x ?? 0, image.naturalWidth - 1));
        const sy = Math.max(0, Math.min(job.crop?.y ?? 0, image.naturalHeight - 1));
        const sw = Math.max(1, Math.min(job.crop?.width ?? image.naturalWidth - sx, image.naturalWidth - sx));
        const sh = Math.max(1, Math.min(job.crop?.height ?? image.naturalHeight - sy, image.naturalHeight - sy));

        /**
         * A missing dimension keeps the aspect ratio.
         *
         * Asking for `width: 800` and getting an 800×(original height) image is a
         * squashed picture, and it is never what anybody meant.
         */
        let tw = job.width || 0;
        let th = job.height || 0;
        if (tw && !th) th = Math.round((sh * tw) / sw);
        else if (th && !tw) tw = Math.round((sw * th) / sh);
        else if (!tw && !th) {
          tw = sw;
          th = sh;
        }

        // A quarter turn swaps the canvas's dimensions; a half turn does not.
        const turn = ((Math.round(job.rotate / 90) * 90) % 360 + 360) % 360;
        const swap = turn === 90 || turn === 270;
        const canvas = document.createElement('canvas');
        canvas.width = swap ? th : tw;
        canvas.height = swap ? tw : th;

        const paint = canvas.getContext('2d');
        // JPEG has no alpha, so a transparent PNG converted to one would come out
        // with black where it was see-through unless something is put behind it.
        if (job.format === 'jpeg') {
          paint.fillStyle = '#ffffff';
          paint.fillRect(0, 0, canvas.width, canvas.height);
        }
        paint.imageSmoothingQuality = 'high';

        paint.translate(canvas.width / 2, canvas.height / 2);
        if (turn) paint.rotate((turn * Math.PI) / 180);
        if (job.flip === 'horizontal') paint.scale(-1, 1);
        else if (job.flip === 'vertical') paint.scale(1, -1);
        paint.drawImage(image, sx, sy, sw, sh, -tw / 2, -th / 2, tw, th);

        const type = `image/${job.format}`;
        const url = canvas.toDataURL(type, job.quality);
        return {
          data: url.split(',')[1],
          // What actually came out, which is not always what was asked for: a
          // browser that cannot encode webp silently hands back a PNG.
          mime: url.slice(5, url.indexOf(';')),
          width: canvas.width,
          height: canvas.height,
          from: { width: image.naturalWidth, height: image.naturalHeight },
        };
      },
      { data, mime, width, height, crop, rotate, flip, format, quality },
    );

    return { ...result, buffer: Buffer.from(result.data, 'base64') };
  } finally {
    await sheet.close().catch(() => {});
    const left = tabs(s);
    if (s.page?.isClosed?.() && left.length) await focusPage(s, left[0]);
  }
}

export const BROWSER_IMPLEMENTATIONS = {
  browser_open: browserOpen,
  browser_tabs: browserTabs,
  browser_switch: browserSwitch,
  browser_close_tab: browserCloseTab,
  browser_look: browserLook,
  browser_click: browserClick,
  browser_type: browserType,
  browser_press: browserPress,
  browser_back: browserBack,
  browser_forward: browserForward,
  browser_select: browserSelect,
  browser_hover: browserHover,
  browser_scroll: browserScroll,
  browser_wait: browserWait,
  browser_close: browserClose,
};
