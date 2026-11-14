/**
 * How full the paid services are (spec B1, Task 7; owner, 2026-11-13): the cloud computer machines running against E2B's limit
 * of concurrent ones, and the database against the size the plan includes. Shown to the billing administrator so the margin on
 * pay-as-you-go is not sold past what the deployment can carry. The E2B key is read here, on the server, and goes nowhere else.
 *
 * What is remembered is one public number for the deployment (not anybody's data), for a minute, per key: a page that polls
 * does not become a poll of E2B. Any failure is `null` (unknown), never an error and never an old number made to look current.
 */
import { envKeyOf } from '../keyPool.js';
import { log } from '../util/trace.js';

const LIST = 'https://api.e2b.app/v2/sandboxes';
const CACHE_MS = 60_000;
const PAGES = 10;
/** key -> { at, running }: one entry, replaced when the key changes. */
let kept = null;

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Sandboxes in state `running`, following the paging; null when E2B cannot be asked or does not answer well. */
async function runningMachines(key) {
  let count = 0;
  let token = null;
  for (let page = 0; page < PAGES; page += 1) {
    const url = new URL(LIST);
    url.searchParams.set('state', 'running');
    url.searchParams.set('limit', '100');
    if (token) url.searchParams.set('nextToken', token);
    const res = await fetch(url, { headers: { 'X-API-KEY': key, Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    // Asked for running ones only, and counted as such again: a response that ignored the filter must not inflate the figure.
    count += rows.filter((row) => row?.state === 'running').length;
    token = res.headers.get('x-next-token');
    if (!token) return count;
  }
  return count;
}

/**
 * @param {{ bytes: number | null, env?: NodeJS.ProcessEnv, now?: number }} input `bytes` is the database's size, read by the caller
 * @returns {Promise<{ machines: { running: number | null, limit: number }, database: { bytes: number | null, includedBytes: number } }>}
 */
export async function capacityOf({ bytes, env = process.env, now = Date.now() }) {
  const limit = positive(env.E2B_CONCURRENT_LIMIT, 20);
  const includedBytes = Math.round(positive(env.DATABASE_INCLUDED_GB, 8) * 1e9);
  const database = { bytes: bytes ?? null, includedBytes };
  const key = envKeyOf('e2b');
  if (!key) return { machines: { running: null, limit }, database };
  if (kept && kept.key === key && now - kept.at < CACHE_MS) return { machines: { running: kept.running, limit }, database };
  let running = null;
  try {
    running = await runningMachines(key);
  } catch (err) {
    // The message of a failed fetch can name the address, never the key (it travels in a header); only the kind of failure is kept.
    log.warn('E2B could not be asked how many machines are running', { error: String(err?.name || 'error') });
  }
  kept = { key, at: now, running };
  return { machines: { running, limit }, database };
}
