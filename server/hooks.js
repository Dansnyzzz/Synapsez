import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getStore, isServerless } from './store/index.js';
import { openSecret, encryptSecret } from './crypto.js';
import { hookContext } from './secretContexts.js';
import { consume as consumeLimit } from './ratelimit.js';
import { log } from './util/trace.js';

/*
 * A bot's task started by a request from outside (spec C.1, after OpenBot's webhooks and
 * dsh-superagent's sources → triggers → gate, MIT).
 *
 * The route id in the URL says which task; the signature proves the sender holds the
 * task's secret. It is checked on the raw bytes, in constant time, before the body is
 * parsed, with a timestamp no more than five minutes off and a delivery id that runs
 * once: a retry of the same delivery is answered "duplicate" and runs nothing. Then the
 * answer is 202 at once and the bot's turn runs behind it (`waitUntil`), started as a
 * 'webhook' turn: the payload reaches the model as untrusted data, and nothing a webhook
 * says can change the team (spec A.1).
 *
 * The secret is stored encrypted, not hashed: an HMAC is checked with the secret itself.
 */

/** The largest body accepted. */
export const HOOK_BODY_MAX = 64 * 1024;
/** How far a request's timestamp may be from now, in seconds. */
export const HOOK_SKEW_S = 300;
/** At most this many JSON-Pointer filters on a route. */
export const HOOK_FILTERS_MAX = 5;
/** Per route: a minute's and a day's ceiling. */
export const HOOK_PER_MINUTE = 30;
export const HOOK_PER_DAY = 500;

/** A new secret, shown to the person once. */
export const newHookSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;
/** A new route id: the URL's last part. */
export const newRouteId = () => crypto.randomBytes(18).toString('base64url');
/**
 * The secret as stored: bound to its account and its route (crypto.js v2).
 * @param {string} secret @param {{ userId: string, routeId: string }} owner
 */
export const sealHookSecret = (secret, { userId, routeId }) => encryptSecret(secret, hookContext(userId, routeId));
/**
 * The secret back, for a route row — or null when it will not open (a key since rotated
 * away, v1 refused, a copy bound to another account). Never "": an HMAC with an empty key
 * is one anybody can make, and `decryptSecret`'s "" for a value that will not open let any
 * such signature through, starting the owner's task (security review, 2026-11-12).
 */
const hookSecretOf = (route) => {
  const opened = openSecret(route.secret_enc, hookContext(route.user_id, route.id));
  return opened.state === 'ok' && opened.value ? opened.value : null;
};
/** Said when a route's secret will not open: nothing it receives can be checked. */
const UNCHECKABLE = Object.freeze({ status: 503, body: { error: 'This hook cannot be checked. Rotate its secret.' } });

/**
 * The signature a sender puts in `X-Synapsez-Signature`: HMAC-SHA256 with the secret over
 * `timestamp.delivery.body`, hex, after "sha256=".
 *
 * @param {string} secret @param {{ timestamp: string | number, delivery: string, body: Buffer | string }} parts
 */
export function signHook(secret, { timestamp, delivery, body }) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${delivery}.`).update(body).digest('hex')}`;
}

/** Whether a signature is the one `signHook` makes, compared in constant time. Never for an empty secret. */
export function signatureMatches(secret, { timestamp, delivery, body, signature }) {
  if (typeof secret !== 'string' || !secret) return false;
  const said = String(signature ?? '').trim();
  const want = Buffer.from(signHook(secret, { timestamp, delivery, body }));
  const got = Buffer.from(said.startsWith('sha256=') ? said : `sha256=${said}`);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** RFC 6901: the value a JSON Pointer names in `doc`, or undefined. */
export function readPointer(doc, pointer) {
  if (pointer === '') return doc;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  let at = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (at === null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, part)) return undefined;
    at = at[part];
  }
  return at;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A route's filters, checked: an exact `type`, and up to five JSON-Pointer equalities on
 * `data`. Throws a plain message the route answers with 400.
 *
 * @param {unknown} input @returns {{ type?: string, match: Array<{ pointer: string, value: unknown }> }}
 */
export function cleanFilters(input) {
  const raw = /** @type {any} */ (input && typeof input === 'object' ? input : {});
  const out = /** @type {{ type?: string, match: Array<{ pointer: string, value: unknown }> }} */ ({ match: [] });
  const type = String(raw.type ?? '').trim();
  if (type) {
    if (type.length > 100) throw Object.assign(new Error('An event type is at most 100 characters.'), { status: 400 });
    out.type = type;
  }
  const match = Array.isArray(raw.match) ? raw.match : [];
  if (match.length > HOOK_FILTERS_MAX) throw Object.assign(new Error(`A hook keeps at most ${HOOK_FILTERS_MAX} filters on its data.`), { status: 400 });
  for (const m of match) {
    const pointer = String(m?.pointer ?? '');
    if (!/^(\/[^/]*){1,10}$/.test(pointer) || pointer.length > 200) throw Object.assign(new Error('A filter names a place in the data like "/repository/name".'), { status: 400 });
    if (JSON.stringify(m?.value ?? null).length > 500) throw Object.assign(new Error('A filter value is at most 500 characters.'), { status: 400 });
    out.match.push({ pointer, value: m?.value ?? null });
  }
  return out;
}

/** Why an event does not run the task under these filters, or null when it does. */
export function filteredOut(filters, event) {
  if (filters?.type && event.type !== filters.type) return `type is "${String(event.type).slice(0, 60)}", not "${filters.type}"`;
  for (const m of filters?.match || []) if (!same(readPointer(event.data, m.pointer), m.value)) return `${m.pointer} does not match`;
  return null;
}

/** A delivery's receipt key: the route and the sender's delivery id. */
export const receiptKey = (routeId, delivery) => crypto.createHash('sha256').update(`hook\u0000${routeId}\u0000${delivery}`).digest('hex');

const header = (headers, name) => String(headers?.[name] ?? headers?.[name.toLowerCase()] ?? '').trim();

/**
 * One request to a hook, from its raw bytes to its answer. The run, when there is one,
 * is started by `start` and not awaited.
 *
 * @param {{ routeId: string, raw: Buffer, headers: Record<string, any>, req?: any, now?: number,
 *   start?: (job: { route: any, event: any, key: string }) => void }} request
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function acceptHook({ routeId, raw, headers, req = null, now = Date.now(), start = startHookRun }) {
  const store = getStore();
  if (req) {
    const blocked = await consumeLimit(req, 'hook-ip');
    if (blocked) return { status: blocked.status || 429, body: { error: 'Too many requests from this address.' } };
  }
  const route = /^[\w-]{10,64}$/.test(String(routeId)) ? await store.getHookRoute(routeId) : null;
  if (!route) return { status: 404, body: { error: 'No such hook.' } };
  for (const [suffix, limit, windowMs] of [['min', HOOK_PER_MINUTE, 60_000], ['day', HOOK_PER_DAY, 86_400_000]]) {
    const hit = await store.hitRateLimit?.(`hook:${route.id}:${suffix}`, limit, windowMs).catch(() => null);
    if (hit && !hit.allowed) return { status: 429, body: { error: `This hook takes at most ${limit} requests a ${suffix === 'min' ? 'minute' : 'day'}.` } };
  }
  const timestamp = header(headers, 'x-synapsez-timestamp');
  const delivery = header(headers, 'x-synapsez-delivery');
  const signature = header(headers, 'x-synapsez-signature');
  const ts = Number(timestamp);
  if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now / 1000 - ts) > HOOK_SKEW_S) return { status: 401, body: { error: 'The timestamp is missing or more than five minutes off.' } };
  if (!/^[\w.:-]{1,100}$/.test(delivery)) return { status: 400, body: { error: 'X-Synapsez-Delivery needs an id of letters, digits, ".", ":", "_" or "-".' } };
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
  if (body.length > HOOK_BODY_MAX) return { status: 413, body: { error: 'A hook body is at most 64 KB.' } };
  let secret;
  try {
    secret = hookSecretOf(route);
  } catch {
    secret = null;
  }
  if (!secret) return UNCHECKABLE;
  if (!signatureMatches(secret, { timestamp, delivery, body, signature })) return { status: 401, body: { error: 'The signature does not match.' } };

  // Only now is the body read.
  let event;
  try {
    event = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'The body is not JSON.' } };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || !event.type.trim() || event.type.length > 100) {
    return { status: 400, body: { error: 'The body is { "type": "…", "occurredAt"?: "…", "data"?: … }.' } };
  }
  const key = receiptKey(route.id, delivery);
  const first = await store.addHookReceipt({ key, userId: route.user_id, routeId: route.id, source: 'hook', deliveryId: delivery, status: 'accepted' });
  if (!first) return { status: 200, body: { duplicate: true, delivery } };
  const skip = !route.task_enabled ? 'the task is paused' : route.bot_paused_at ? 'the bot is paused' : filteredOut(route.filters || {}, event);
  if (skip) {
    await store.setHookReceipt(key, { status: 'ignored', reason: skip });
    return { status: 200, body: { ignored: skip, delivery } };
  }
  start({ route, event: { type: event.type.trim(), occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt.slice(0, 40) : null, data: event.data ?? null }, key });
  return { status: 202, body: { accepted: true, delivery } };
}

/** The run behind a 202: the task's turn, and its receipt told how it went. */
export async function runHookJob({ route, event, key }) {
  const store = getStore();
  try {
    const { runHookTask } = await import('./scheduler.js');
    const result = await runHookTask(route.user_id, route.task_id, event);
    const ok = /^ok\b/.test(String(result?.status || ''));
    await store.setHookReceipt(key, { status: ok ? 'ran' : result?.status === 'busy' ? 'busy' : 'failed', reason: ok ? null : String(result?.status || 'failed') });
  } catch (err) {
    log.error('a hook run failed', err, { routeId: route.id });
    await store.setHookReceipt(key, { status: 'failed', reason: String(err?.message || err).slice(0, 200) }).catch(() => {});
  }
}

/** Start it after the answer: held open by `waitUntil` on Vercel, left running elsewhere. */
export function startHookRun(job) {
  const work = runHookJob(job);
  if (isServerless()) waitUntil(work);
}

/**
 * A test delivery from the server itself, signed with the route's own secret ("Gửi thử").
 *
 * @param {{ userId: string, taskId: string, start?: (job: any) => void }} options
 */
export async function sendTestHook({ userId, taskId, start = startHookRun }) {
  const store = getStore();
  const route = await store.getHookRouteForTask(userId, taskId);
  if (!route) return { status: 404, body: { error: 'This task has no hook.' } };
  const body = Buffer.from(JSON.stringify({ type: 'test', occurredAt: new Date().toISOString(), data: { test: true, note: 'A test sent from Synapsez.' } }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const delivery = `test-${crypto.randomUUID()}`;
  // A secret that will not open is said, never signed over as "" and reported a success.
  const secret = hookSecretOf(route);
  if (!secret) return UNCHECKABLE;
  const signature = signHook(secret, { timestamp, delivery, body });
  return acceptHook({ routeId: route.id, raw: body, headers: { 'x-synapsez-timestamp': timestamp, 'x-synapsez-delivery': delivery, 'x-synapsez-signature': signature }, start });
}
