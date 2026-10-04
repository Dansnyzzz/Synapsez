import { streamAnthropic } from './anthropic.js';
import { streamOpenAICompatible } from './openaiCompatible.js';
import { streamGoogle } from './google.js';
import {
  getApiKeys,
  baseUrlFor,
  rememberWorkingKey,
  markKeyLimited,
  markKeyDead,
  keyRestingUntil,
  liftKeyRest,
  providerPrivacyFor,
} from '../settings.js';
import { resolveModel, PROVIDERS } from './catalog.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const ORCAROUTER_BASE = 'https://api.orcarouter.ai/v1';

/**
 * Both aggregators use the same attribution headers as OpenRouter — a referer
 * and a title identifying the app. Harmless where they are ignored.
 */
function routerHeaders() {
  const referer = process.env.PUBLIC_URL || 'https://github.com/';
  return { 'HTTP-Referer': referer, 'X-Title': 'Synapsez' };
}

/** One provider's stream, for one key. */
async function* streamOne(entry, common) {
  switch (entry.provider) {
    case 'anthropic':
      yield* streamAnthropic(common);
      return;
    case 'openai':
      yield* streamOpenAICompatible(common);
      return;
    case 'openrouter':
      yield* streamOpenAICompatible({ ...common, baseURL: OPENROUTER_BASE, headers: routerHeaders(), markCache: true, router: 'openrouter' });
      return;
    case 'orcarouter':
      yield* streamOpenAICompatible({ ...common, baseURL: ORCAROUTER_BASE, headers: routerHeaders(), router: 'orcarouter' });
      return;
    case 'google':
      yield* streamGoogle(common);
      return;
    default:
      throw new Error(`Unsupported provider "${entry.provider}"`);
  }
}

/**
 * How many output tokens to ask this model for.
 *
 * Every adapter used to default to 32000 and nothing ever passed anything else,
 * so a request to `ai21/jamba-large-1.7` (4096) or `amazon/nova-lite-v1` (5120)
 * asked for several times what the provider had already published as its limit —
 * and a request to `openai/gpt-4` asked for four times its entire 8191-token
 * window. Forty-five of the models in the catalogue cap below 32000.
 *
 * Decided here rather than in each adapter because this is the one place that
 * holds the resolved catalogue entry, so the three adapters cannot drift.
 *
 * Also kept inside the window: `max_tokens` and the prompt share the context, so
 * asking for an output larger than the whole window cannot be satisfied whatever
 * the model's own cap says.
 */
export function outputBudget(entry, promptTokens = 0) {
  const stated = Number(entry?.maxOutput);
  const wanted = Number.isFinite(stated) && stated > 0 ? stated : 32_000;

  const context = Number(entry?.context);
  /**
   * An entry that states neither figure gets the cautious number, not the
   * optimistic one.
   *
   * This returned `wanted` — a flat 32,000, unclamped — which is precisely the
   * hard-coded value `.claude/commands/new-provider.md` forbids, and for the
   * reason it gives: `openai/gpt-4` has an 8,191-token **total** window, so
   * asking it for 32,000 output asks for four times everything it has. The
   * clamp below exists and is right; it was simply skipped on the one path
   * where nothing is known.
   *
   * First-party catalogue entries carry both fields, so this never fired for
   * them. Sparse metadata is what arrives from the aggregators — OpenRouter and
   * OrcaRouter — which are the two providers this app is built around, so the
   * path with no information is the path most likely to be taken.
   *
   * 4,096 because it is the smallest ceiling in common use and fits inside
   * every window this app has seen. A reply cut short is a visible, recoverable
   * disappointment; a request rejected for asking beyond the model's total
   * window is a turn that produces nothing at all.
   */
  if (!Number.isFinite(context) || context <= 0) {
    return Number.isFinite(stated) && stated > 0 ? wanted : 4_096;
  }

  /**
   * Leave the prompt somewhere to live — the prompt actually being sent, not a
   * token placeholder for it.
   *
   * This subtracted a flat 1024, so a model whose published output cap is 90%
   * of its window (OpenRouter lists several free ones that way: 235,929 of
   * 262,144) was asked for 235,929 output tokens on top of an 80,000-token
   * conversation, and the provider refused the whole turn with a 400 — on a
   * conversation the gauge rightly called half full. Compaction could never
   * help: the overflow was the reply's reservation, not the transcript.
   */
  const room = context - Math.max(0, Number(promptTokens) || 0) - 1024;
  return Math.max(256, Math.min(wanted, context - 1024, Math.max(1024, room)));
}

/**
 * Roughly how many tokens a request's prompt is, before anybody has counted.
 *
 * Divided by three rather than four: Vietnamese, code and JSON all run denser
 * than English prose, and an estimate that is too low is the one that fails —
 * it asks for an output that no longer fits. An inline picture is counted at a
 * flat rate rather than by the length of its base64, which would call a
 * screenshot several hundred thousand tokens.
 *
 * @param {{ system?: unknown, messages?: unknown, tools?: unknown }} [request]
 */
export function estimatePromptTokens({ system, messages, tools } = {}) {
  let chars = 0;
  let pictures = 0;
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.length > 4000 && (value.startsWith('data:') || /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 4000)))) {
        pictures += 1;
      } else {
        chars += value.length;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(system);
  walk(messages);
  walk(tools);
  return Math.ceil(chars / 3) + pictures * 1500;
}

/**
 * The window and the input, read off a provider's "maximum context length"
 * refusal, so the same request can be sent again asking for less.
 *
 * OpenRouter: "This endpoint's maximum context length is 262144 tokens. However,
 * you requested about 316800 tokens (71928 of text input, 1445 of image input,
 * 7498 of tool input, 235929 in the output)."
 * OpenAI: "This model's maximum context length is 128000 tokens. However, you
 * requested 140000 tokens (20000 in the messages, 120000 in the completion)."
 */
export function contextRefusal(error) {
  const message = String(error?.message || '');
  const window = message.match(/maximum context length is (\d+)/i);
  const asked = message.match(/requested (?:about )?(\d+) tokens/i);
  const output = message.match(/(\d+) (?:in the output|in the completion)/i);
  if (!window || !asked || !output) return null;
  const context = Number(window[1]);
  const input = Number(asked[1]) - Number(output[1]);
  if (!(context > 0) || !(input >= 0)) return null;
  return { context, input, output: Number(output[1]) };
}

/** The longest we will hold one request open waiting for a limit to lift. */
const MAX_WAIT_MS = 60_000;

/** Beyond a day, a header is lying or a clock is wrong. */
const MAX_SANE_WAIT_MS = 24 * 3600_000;

/**
 * A header off an SDK error, whichever shape the SDK chose.
 *
 * The Anthropic and OpenAI SDKs both attach the response headers, but one hands
 * back a `Headers` instance and the other a plain object, and header names
 * arrive in whatever case the server used.
 */
function headerOf(error, name) {
  const bag = error?.headers || error?.response?.headers;
  if (!bag) return null;
  if (typeof bag.get === 'function') return bag.get(name) ?? null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(bag)) {
    if (String(key).toLowerCase() === wanted) return value == null ? null : String(value);
  }
  return null;
}

/**
 * How long the provider says to wait, in milliseconds.
 *
 * Returned in full rather than clamped: the caller needs the difference between
 * "twenty seconds" and "tomorrow morning". One is worth waiting for inside the
 * request; the other is worth recording and saying out loud.
 */
function waitFrom(error, now = Date.now()) {
  const sane = (ms) => (Number.isFinite(ms) && ms > 0 && ms <= MAX_SANE_WAIT_MS ? Math.round(ms) : null);

  // `Retry-After` is either a number of seconds or an HTTP date.
  const after = headerOf(error, 'retry-after');
  if (after != null && String(after).trim() !== '') {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return sane(seconds * 1000);
    const when = Date.parse(String(after));
    if (Number.isFinite(when)) return sane(when - now);
  }

  // `X-RateLimit-Reset` has no agreed unit. OpenRouter sends epoch
  // milliseconds, others send epoch seconds, and a few send a plain duration —
  // so tell them apart by magnitude rather than by trusting the name.
  const reset = Number(headerOf(error, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    if (reset > 1e12) return sane(reset - now);
    if (reset > 1e9) return sane(reset * 1000 - now);
    return sane(reset * 1000);
  }

  return null;
}

const DEAD_KEY =
  /invalid[ _-]?api[ _-]?key|incorrect api key|unauthorized|no such key|out of credit|insufficient|billing/;
/**
 * The provider broke off, or sent an error in the middle of a stream it had
 * started. OpenRouter does this — an `error` event inside the SSE, surfaced by
 * the SDK with no HTTP status ("JSON error injected into SSE stream") — and
 * with no status it used to fall through to FATAL, ending the turn on a
 * hiccup that the next attempt would not have had.
 */
/*
 * "Provider returned an empty response" is OpenRouter saying the model behind
 * it sent nothing back — common on free models under load, and gone on the
 * next attempt. Missing from this list it was graded FATAL, and every one of
 * them ended the turn with a Continue button.
 */
const TRANSIENT =
  /timeout|timed out|econnreset|econnrefused|socket hang up|fetch failed|network|sse|stream|overloaded|upstream|provider returned error|terminated|premature|unexpected end|bad gateway|service unavailable|internal server error|stalled|empty response|empty completion|no content|returned nothing|no choices/;

/**
 * What a failure says about the key that produced it.
 *
 * The version this replaced answered one question — "would another key have
 * done any better?" — and answered it the same way for a rate limit as for an
 * empty wallet. They are not the same. A 429 usually wants a few seconds and
 * the *same* key; a 402 wants a different key and will never want that one
 * again. Grading them alike is what turned a momentary limit on a single-key
 * account into a hard failure with nothing to fall back to.
 *
 * - `RATE_LIMITED` — this key, later. `retryAfterMs` when the provider said.
 * - `KEY_DEAD`     — this key, never again this run. Try the next one.
 * - `UPSTREAM`     — the provider stumbled. Same key, after a pause.
 * - `FATAL`        — broken in a way every key shares. Report it and stop:
 *                    walking five keys turns one clear error into five slow ones.
 */
function classify(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status) || 0;
  const message = String(error?.message || '').toLowerCase();
  const retryAfterMs = waitFrom(error);

  // Status first. Plenty of 429 bodies say "quota", and reading that as a spent
  // key is exactly the misgrading this function exists to stop.
  // "quota" with no status attached is almost always a limit rather than a
  // spent key, so it rests this key and moves on rather than condemning it for
  // the life of the process on the strength of one vague sentence.
  if (status === 429 || (!status && /rate limit|too many requests|quota/.test(message))) {
    return { kind: 'RATE_LIMITED', retryAfterMs };
  }
  if ([401, 402, 403].includes(status) || (!status && DEAD_KEY.test(message))) {
    return { kind: 'KEY_DEAD', retryAfterMs: null };
  }
  if (status === 408 || status >= 500 || (!status && TRANSIENT.test(message))) {
    return { kind: 'UPSTREAM', retryAfterMs };
  }
  return { kind: 'FATAL', retryAfterMs: null };
}

/** Wait, but give up the moment the caller does. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How long a provider may go silent before the attempt is given up.
 *
 * A free model on a busy aggregator sometimes accepts the request and then
 * sends nothing — no error, no close — and the turn hung until somebody gave
 * up on it. Longer before the first word (a queue is normal there) than
 * between words (once it is talking, a long silence means it has stopped).
 * A stall is graded like any other provider hiccup: retried, and if it keeps
 * happening, reported — which is what puts a Continue button in front of the
 * person instead of a spinner.
 */
const STALL_FIRST_MS = Number(process.env.STREAM_STALL_FIRST_MS) || 150_000;
const STALL_BETWEEN_MS = Number(process.env.STREAM_STALL_MS) || 90_000;

async function* stallGuard(events, { first = STALL_FIRST_MS, between = STALL_BETWEEN_MS } = {}) {
  const it = events[Symbol.asyncIterator]();
  let heard = false;
  for (;;) {
    const limit = heard ? between : first;
    let timer;
    const stalled = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The provider stopped sending (stalled for ${Math.round(limit / 1000)}s).`)),
        limit,
      );
    });
    let next;
    try {
      next = await Promise.race([it.next(), stalled]);
    } catch (err) {
      // Let the underlying request go, rather than leaving it open.
      it.return?.().catch?.(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (next.done) return;
    heard = true;
    yield next.value;
  }
}

/** How long to pause before trying a stumbling provider again. */
const backoff = (attempt) => Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

/** Attempts at one key when it is the provider rather than the key at fault. */
const UPSTREAM_TRIES = 3;

/** Passes over the key list. More than one only because a wait can earn a key back. */
const ROUNDS = 3;

/**
 * One streaming interface over every provider, and every key they have.
 *
 * An account can hold several keys per provider, and they are tried in order
 * until one answers. That is the whole point of holding more than one: a key
 * that runs out at eleven should cost a moment, not the rest of the day.
 *
 * Three separate questions decide what happens when one fails. The version this
 * replaced ran them together into a single boolean, which is why a rate limit
 * on a one-key account went straight to a hard failure.
 *
 * **What kind of failure was it** — `classify`. A rate limit wants time, a dead
 * key wants a different key, a 500 wants the same key a moment later, and a
 * malformed request wants reporting rather than four more attempts.
 *
 * **What had already come out** — counted per kind rather than flagged. A
 * failure before the first word of prose can be retried invisibly, and most
 * can: the model was still thinking, or still announcing a tool call. Only
 * prose somebody has actually read makes a restart visible, and then it is
 * announced with a `retry` event so the half-sentence is cleared rather than
 * being written over or grown a duplicate. Resuming instead of restarting would
 * be better still, and is not available: assistant prefill returns 400 on every
 * Anthropic model in the catalogue, and is honoured inconsistently behind
 * OpenRouter. One predictable path beats two that differ by provider.
 *
 * **Whether anything else could work** — a key known to be resting is skipped
 * rather than probed, because on OpenRouter a failed request still spends the
 * day's allowance. When every key is resting and the soonest is close, waiting
 * is the answer; when it is hours away, saying so is.
 *
 * Yields: {type:'text'|'thinking', delta} · {type:'tool_call_start', id, name}
 *       · {type:'tool_call_progress', id, name, chars}
 *       · {type:'notice', text} · {type:'retry', reason}
 *       · {type:'done', stopReason, toolCalls, usage, raw?}
 */
export async function* streamCompletion(opts) {
  const { streamOne: injected, sleep, ...rest } = opts;
  const entry = opts.entry;
  const provider = entry.provider;
  const label = PROVIDERS[provider]?.label || provider;
  const { userId, signal } = opts;
  const dispatch = injected || streamOne;
  const wait = sleep || pause;

  let refused = null;
  // Worked out once: the prompt does not change between keys or attempts.
  let maxTokens = opts.maxTokens ?? outputBudget(entry, estimatePromptTokens(opts));
  // Only OpenRouter takes a per-request data policy; see `providerPrivacy`.
  const privacy = provider === 'openrouter' ? (opts.privacy ?? (await providerPrivacyFor(userId))) : 'standard';
  let shrunk = false;

  for (let round = 0; round < ROUNDS; round += 1) {
    const keys = await getApiKeys(userId, provider);

    if (!keys.length) {
      // Nothing usable. Whether that is a missing key or a resting one changes
      // what there is to say, and getting it wrong sends somebody to Settings
      // to fix a key that was never broken.
      const all = await getApiKeys(userId, provider, { includeResting: true });
      if (!all.length) throw new Error(`No API key for ${label}. Add one in Settings → Providers.`);

      const until = keyRestingUntil(userId, provider);
      const left = until == null ? null : until - Date.now();
      if (left != null && left <= MAX_WAIT_MS && round < ROUNDS - 1) {
        yield {
          type: 'notice',
          text: `${label}: every key is rate limited. Waiting ${Math.ceil(left / 1000)}s.`,
        };
        await wait(Math.max(0, left), signal);
        liftKeyRest(userId, provider, until);
        continue;
      }
      throw new Error(
        until
          ? `${label}: every key is rate limited until ${new Date(until).toLocaleTimeString()}.`
          : `${label}: every key was refused${refused ? ` (${refused})` : ''}.`,
      );
    }

    for (const { key, index, shared } of keys) {
      const which = shared ? 'the deployment key' : `key ${index + 1}`;
      const common = {
        ...rest,
        apiKey: key,
        model: entry.model,
        entry,
        privacy,
        baseURL: baseUrlFor(provider),
        // Whatever this model actually produces and the window still has room
        // for, rather than the 32000 every adapter used to fall back to.
        maxTokens,
      };

      for (let attempt = 0; attempt < UPSTREAM_TRIES; attempt += 1) {
        // Counted rather than flagged. "Something came out" lumps a discarded
        // thinking delta in with a paragraph somebody is reading, and only one
        // of those makes a restart visible.
        const emitted = { text: 0, thinking: 0, toolCalls: 0 };
        let failure = null;

        try {
          for await (const event of stallGuard(dispatch(entry, common))) {
            if (event.type === 'text') emitted.text += 1;
            else if (event.type === 'thinking') emitted.thinking += 1;
            else if (event.type === 'tool_call_start') emitted.toolCalls += 1;
            yield event;
          }
          // This one worked; start here next time rather than rediscovering the
          // dead keys ahead of it on every turn.
          if (!shared) rememberWorkingKey(userId, provider, index);
          return;
        } catch (err) {
          failure = err;
        }

        // They pressed stop. This is not a failure to grade, and none of the
        // recovery below applies: retrying now would be carrying on with work
        // somebody has just asked to end. Which SDK's wording an abort arrives
        // in should not decide that, so it is settled here rather than left to
        // whether `classify` recognises the message.
        if (signal?.aborted) throw failure;

        /**
         * Refused for asking too much room, which the provider has just
         * measured for us. Asked again once, for what fits, before the first
         * word — so nobody sees anything but a reply. Only when the prompt
         * itself leaves no room is it an error, and then it says so plainly.
         */
        const overflow = !emitted.text && !emitted.toolCalls ? contextRefusal(failure) : null;
        if (overflow && !shrunk) {
          const fits = overflow.context - overflow.input - 512;
          if (fits >= 1024 && fits < maxTokens) {
            shrunk = true;
            maxTokens = fits;
            common.maxTokens = fits;
            attempt -= 1;
            continue;
          }
          if (fits < 1024) {
            throw new Error(
              `${label}: this conversation (${overflow.input} tokens) no longer fits this model's ` +
                `${overflow.context}-token window. Compact it, start a new one, or pick a model with a larger window.`,
            );
          }
        }

        const { kind, retryAfterMs } = classify(failure);

        // Broken in a way every key shares. Walking the rest turns one clear
        // error into five slow ones — but a reader still deserves to know the
        // others were tried at all.
        const giveUp = () => {
          if (refused) failure.message = `${failure.message} (${refused})`;
          return failure;
        };
        if (kind === 'FATAL') throw giveUp();

        refused = `${which} was refused: ${failure.message}`;

        if (kind === 'UPSTREAM') {
          // The provider stumbled rather than the key being wrong, so it is the
          // same key that wants trying, a moment later.
          if (attempt < UPSTREAM_TRIES - 1) {
            if (emitted.text) {
              yield {
                type: 'retry',
                reason: `${label}: the provider dropped that reply; starting it again.`,
              };
            }
            await wait(retryAfterMs ?? backoff(attempt), signal);
            continue;
          }
          // Out of patience. Every key on this account reaches the same servers,
          // so the next one will fail identically and slowly.
          throw giveUp();
        }

        if (kind === 'RATE_LIMITED') {
          markKeyLimited(userId, provider, index, Date.now() + (retryAfterMs ?? MAX_WAIT_MS));
        } else if (kind === 'KEY_DEAD') {
          markKeyDead(userId, provider, index);
        }

        // Said out loud rather than swallowed: a fallback that nobody can see is
        // indistinguishable from the first key having worked, right up until the
        // bill or the outage says otherwise.
        yield { type: 'notice', text: `${label}: ${which} was refused, trying the next one.` };
        if (emitted.text) {
          yield {
            type: 'retry',
            reason: `${label}: ${which} stopped mid-answer; starting that reply again.`,
          };
        }
        break;
      }
    }
  }

  throw new Error(`${label}: every key was refused${refused ? ` (${refused})` : ''}.`);
}

export { resolveModel, PROVIDERS };

/** Exposed for the suite that pins which failures are worth another key. */
export const __testing = { stallGuard, classify, waitFrom, headerOf, outputBudget, estimatePromptTokens, contextRefusal };
