/**
 * The same conversation, open in two places.
 *
 * One agent loop per conversation is not negotiable — two tabs both appending to
 * one transcript produces a conversation with its turns shuffled together, which
 * is why the run lease exists and why a second tab is refused with a 409. That
 * refusal is correct and it is also, from where the person is sitting, a bug:
 * they opened their own conversation on their laptop while their phone was
 * mid-answer, and it sat there saying nothing.
 *
 * So the tab that holds the run narrates it, and the others listen. The follower
 * never sends anything, never holds the lease, and never writes to the
 * transcript — it draws what it is told and reloads properly when the run ends,
 * which is the point at which the database is the truth again.
 *
 * `BroadcastChannel` is same-origin and in-browser: nothing here crosses the
 * network, so this costs no requests and cannot leak between accounts. It is
 * also why this only helps tabs on one device — a phone and a laptop are still
 * two browsers, and the reload-on-finish is what serves them.
 */
const CHANNEL = 'ai-remote-run';

/** Older browsers, and any context where the API is unavailable, simply opt out. */
const supported = typeof BroadcastChannel === 'function';

let channel = null;
const open = () => {
  if (!supported) return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
};

/**
 * Say what just happened in this run.
 *
 * Called from the owning tab for every stream event. Deliberately fire-and-
 * forget and deliberately unacknowledged: a follower that missed something
 * reloads at the end anyway, and making the owner wait on its audience would put
 * the interface of a tab nobody is watching in the path of the one they are.
 */
/**
 * Prose waiting to be narrated, coalesced.
 *
 * `narrate` is called for every frame of the stream, and a `text` frame is four
 * or five characters — so the owning tab was paying a structured clone and a
 * cross-context dispatch per token, on the hot path, for a feature that helps
 * only the minority with a second tab open. BroadcastChannel offers no way to
 * ask whether anyone is listening, so the cost cannot be skipped outright; it
 * can be made proportionate.
 *
 * Deltas are concatenated and posted at most once a frame. A follower appends
 * what it is given, so one message carrying ten tokens renders identically to
 * ten carrying one. Anything that is not prose flushes the buffer first and goes
 * immediately, because ordering is the one thing a follower cannot repair: a
 * `retry` or a `done` overtaking the text it applies to would leave the wrong
 * words on screen.
 */
let pendingText = null;
let flushQueued = false;

function post(bus, message) {
  try {
    bus.postMessage(message);
  } catch {
    // A payload that will not structured-clone — a DOM node caught in a closure,
    // say. Losing one frame of narration is not worth breaking the run for.
  }
}

function flushText(bus) {
  if (!pendingText) return;
  const buffered = pendingText;
  pendingText = null;
  post(bus, { chatId: buffered.chatId, event: 'text', data: { delta: buffered.delta } });
}

export function narrate(chatId, event, data) {
  const bus = open();
  if (!bus || !chatId) return;

  if (event === 'text' && typeof data?.delta === 'string') {
    // A different conversation's text must not be glued onto this one's.
    if (pendingText && pendingText.chatId !== chatId) flushText(bus);
    pendingText = { chatId, delta: (pendingText?.delta || '') + data.delta };
    if (flushQueued) return;
    flushQueued = true;
    const run = () => {
      flushQueued = false;
      flushText(bus);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
    return;
  }

  flushText(bus);
  post(bus, { chatId, event, data });
}

/**
 * Listen to a run happening in another tab.
 *
 * @param chatId    only events for this conversation are passed on.
 * @param onEvent   (event, data) for each frame.
 * @returns a function that stops listening. Call it when the view changes;
 *   a follower left subscribed to a conversation nobody is looking at would
 *   quietly redraw it forever.
 */
export function follow(chatId, onEvent) {
  const bus = open();
  if (!bus || !chatId) return () => {};

  const listener = (message) => {
    const frame = message?.data;
    if (!frame || frame.chatId !== chatId) return;
    onEvent(frame.event, frame.data);
  };
  bus.addEventListener('message', listener);
  return () => bus.removeEventListener('message', listener);
}

/**
 * Is another tab in this browser already running this conversation?
 *
 * Reopening a conversation that is still answering now walks back into the run
 * rather than watching it from outside, which is right when the tab that
 * started it has gone — a reload, a closed window, another device. It is wrong
 * when that tab is sitting right there: rejoining claims the lease, the live
 * tab is superseded mid-sentence, and the person watching it sees their answer
 * stop for no reason they can see.
 *
 * So ask first. An owner answers, a browser with no other tab open does not,
 * and the wait is short enough that nobody notices it when nothing replies —
 * `postMessage` between tabs is same-process and arrives in a tick or two.
 *
 * Only tabs of this browser can answer, which is exactly the set that needs to
 * be asked: a phone and a laptop cannot supersede each other into a visible
 * mess, because neither is on screen where the other is.
 */
const ASK = 'who-owns';
const OWN = 'owned';

/** Answer "yes, me" while `isOwner(chatId)` says this tab is running it. */
export function answerOwnership(isOwner) {
  const bus = open();
  if (!bus) return () => {};
  const listener = (message) => {
    const frame = message?.data;
    if (frame?.event !== ASK || !frame.chatId) return;
    if (isOwner(frame.chatId)) post(bus, { chatId: frame.chatId, event: OWN });
  };
  bus.addEventListener('message', listener);
  return () => bus.removeEventListener('message', listener);
}

/** @returns whether some other tab said it is running this conversation. */
export function someoneElseIsRunning(chatId, waitMs = 250) {
  const bus = open();
  if (!bus || !chatId) return Promise.resolve(false);

  return new Promise((resolve) => {
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      bus.removeEventListener('message', listener);
      clearTimeout(timer);
      resolve(answer);
    };
    const listener = (message) => {
      const frame = message?.data;
      if (frame?.event === OWN && frame.chatId === chatId) finish(true);
    };
    const timer = setTimeout(() => finish(false), waitMs);
    bus.addEventListener('message', listener);
    post(bus, { chatId, event: ASK });
  });
}

export const __testing = { CHANNEL, supported };
