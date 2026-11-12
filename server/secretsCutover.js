import { getStore } from './store/index.js';
import { resealSecrets, cutoverReady } from './secretsReseal.js';
import { currentKeyId, setSecretPolicy } from './crypto.js';
import { log } from './util/trace.js';

/**
 * The move off the v1 envelope, done by the deployment itself (owner, 2026-11-12: "bạn làm
 * full giúp tôi").
 *
 * `npm run secrets:reseal` needs the deployment's database address and key on the machine
 * that runs it; the deployment already has both, so it does the work: the sweep (scheduler.js)
 * seals every stored credential again under the key that seals now — compare-and-set, the
 * app's own writes cannot be undone by it — and counts again. When two counts at least an
 * hour apart both say the cutover is safe (nothing left to seal again, nothing that will not
 * open, nothing changed under the run), v1 is refused from then on: the flag is kept in the
 * database and read by every instance, so no environment variable has to change. Two counts,
 * not one, so values an instance still on the old code wrote during a deploy are found first.
 *
 * Settings → Admin shows where it is, and the owner can let v1 in again (it then stays off
 * until they say otherwise). ENCRYPTION_REFUSE_V1 in the environment still refuses v1 on its
 * own, whatever this says.
 */

const STATE_KEY = 'secrets:cutover';
const POLICY_KEY = 'secrets:refuseV1';
/** How far apart two counts must be. */
const COUNT_EVERY_MS = 3600_000;
/** Clean counts in a row before v1 is refused. */
const SAFE_COUNTS = 2;
/** How long an instance trusts what it read of the policy. */
const POLICY_TTL_MS = 10 * 60_000;

let policyReadAt = 0;

/** Read the deployment's word on v1 into crypto.js. */
export async function loadSecretPolicy(store = getStore()) {
  const policy = (await store.getSetting(POLICY_KEY).catch(() => null)) || {};
  setSecretPolicy({ refuseV1: policy.on === true });
  policyReadAt = Date.now();
  return policy;
}

/** The policy as this instance knows it, read again when it is older than ten minutes. */
export async function refreshSecretPolicy(now = Date.now()) {
  if (now - policyReadAt < POLICY_TTL_MS) return;
  policyReadAt = now;
  await loadSecretPolicy().catch(() => {});
}

/** A count as Settings → Admin shows it: totals by state, never a value or an account. */
const summaryOf = (report) => {
  const total = { current: 0, resealed: 0, unopenable: 0, changedMeanwhile: 0 };
  for (const t of Object.values(report)) for (const k of Object.keys(total)) total[k] += Number(t[k]) || 0;
  return total;
};

/**
 * One step of the move: seal again what is due, count, and refuse v1 once two counts an hour
 * apart are clean. At most one count an hour, across instances — the time is kept in the
 * database.
 *
 * @param {{ now?: number, store?: any }} [options]
 * @returns {Promise<{ status: 'done' | 'held' | 'wait' | 'no-query' | 'not-yet' | 'safe' | 'cut-over', summary?: any }>}
 */
export async function cutoverStep({ now = Date.now(), store = getStore() } = {}) {
  const policy = (await store.getSetting(POLICY_KEY).catch(() => null)) || {};
  if (policy.on === true) return { status: 'done' };
  // The owner let v1 in again: it stays so until they refuse it themselves.
  if (policy.by === 'owner') return { status: 'held' };
  const state = (await store.getSetting(STATE_KEY).catch(() => null)) || {};
  if (state.at && now - Date.parse(state.at) < COUNT_EVERY_MS) return { status: 'wait' };
  if (typeof store.rawQuery !== 'function') return { status: 'no-query' };
  const query = (text, params) => store.rawQuery(text, params);

  await resealSecrets(query, { apply: true });
  const report = await resealSecrets(query);
  const safe = cutoverReady(report);
  const safeCounts = safe ? (Number(state.safeCounts) || 0) + 1 : 0;
  const summary = summaryOf(report);
  const at = new Date(now).toISOString();
  await store.setSetting(STATE_KEY, { at, safe, safeCounts, summary, keyId: currentKeyId() });
  if (!safe) {
    log.info('secrets: moving off v1', { ...summary });
    return { status: 'not-yet', summary };
  }
  if (safeCounts < SAFE_COUNTS) return { status: 'safe', summary };
  await store.setSetting(POLICY_KEY, { on: true, at, by: 'cutover' });
  setSecretPolicy({ refuseV1: true });
  log.info('secrets: every stored credential is in the v2 envelope; v1 is refused from now on');
  return { status: 'cut-over', summary };
}

/** Where the move is, for Settings → Admin. */
export async function cutoverStatus(store = getStore()) {
  const [state, policy] = await Promise.all([store.getSetting(STATE_KEY).catch(() => null), store.getSetting(POLICY_KEY).catch(() => null)]);
  let keyId = null;
  try {
    keyId = currentKeyId();
  } catch {
    /* no key here is said by the startup check */
  }
  return {
    keyId,
    lastCount: state ? { at: state.at || null, safe: !!state.safe, safeCounts: Number(state.safeCounts) || 0, ...(state.summary || {}) } : null,
    refuseV1: { on: policy?.on === true, at: policy?.at || null, by: policy?.by || null },
    envRefuses: /^(1|true|yes|on)$/i.test(String(process.env.ENCRYPTION_REFUSE_V1 || '').trim()),
  };
}

/**
 * The owner's own word: refuse v1, or let it in again. Letting it in holds the automatic
 * move back until they refuse it themselves.
 *
 * @param {boolean} on
 */
export async function setRefuseV1(on, store = getStore()) {
  const value = { on: !!on, at: new Date().toISOString(), by: 'owner' };
  await store.setSetting(POLICY_KEY, value);
  setSecretPolicy({ refuseV1: !!on });
  return value;
}
