/**
 * Re-seal every stored credential in the v2 envelope under the key that seals now
 * (crypto.js, owner 2026-11-12) — after the v2 envelope ships, and after every key
 * rotation. Each value is opened with the context it belongs to and sealed again with the
 * same context; nothing else about a row changes. And, for `npm run db:copy` merging an
 * old account into another id, the same values re-bound to the account they now belong to.
 *
 * Writes compare-and-set: a value changed by the app since it was read is left for the
 * next run rather than overwritten. Device pairings are not touched — they live minutes.
 * Reports counts by kind only: never a value, never an account.
 *
 * Where a credential lives, and its context — the same pairs the app seals with:
 *   users.totp_secret                       ['totp', userId]
 *   connectors.token                        ['connector', userId, service]
 *   hook_routes.secret_enc                  ['hook', userId, routeId]
 *   user_settings providerKeys[provider][]  ['provider-key', userId, provider]
 *   user_settings cloudBrowser.key          ['cloud-browser', userId]
 *   user_settings mcpBridge.key             ['mcp-bridge', userId]
 *   mcp_servers.config headersCipher/envCipher ['mcp-config', userId, 'headers'|'env']
 */
import { openSecret, encryptSecret, needsReseal, secretVersion } from './crypto.js';

/**
 * Each table that holds credentials: its rows that may, whose they are, the sealed values in
 * one row (on a working copy that `put` changes), and the compare-and-set write. One list,
 * read by the reseal and by db:copy, so a credential added later is added once.
 *
 * @type {Record<string, Place>}
 */
const SEALED = {
  users: {
    select: 'SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL',
    owner: (row) => row.id,
    fields: (row) => (row.totp_secret ? [{ kind: 'totp', value: row.totp_secret, context: (user) => ['totp', user], put: (sealed) => { row.totp_secret = sealed; } }] : []),
    update: (row, was) => ['UPDATE users SET totp_secret = $2 WHERE id = $1 AND totp_secret = $3 RETURNING id', [row.id, row.totp_secret, was.totp_secret]],
  },
  connectors: {
    select: 'SELECT user_id, service, token FROM connectors WHERE token IS NOT NULL',
    owner: (row) => row.user_id,
    fields: (row) => (row.token ? [{ kind: 'connector', value: row.token, context: (user) => ['connector', user, row.service], put: (sealed) => { row.token = sealed; } }] : []),
    update: (row, was) => ['UPDATE connectors SET token = $3 WHERE user_id = $1 AND service = $2 AND token = $4 RETURNING user_id', [row.user_id, row.service, row.token, was.token]],
  },
  hook_routes: {
    select: 'SELECT id, user_id, secret_enc FROM hook_routes WHERE secret_enc IS NOT NULL',
    owner: (row) => row.user_id,
    fields: (row) => (row.secret_enc ? [{ kind: 'hook', value: row.secret_enc, context: (user) => ['hook', user, row.id], put: (sealed) => { row.secret_enc = sealed; } }] : []),
    update: (row, was) => ['UPDATE hook_routes SET secret_enc = $2 WHERE id = $1 AND secret_enc = $3 RETURNING id', [row.id, row.secret_enc, was.secret_enc]],
  },
  user_settings: {
    select: "SELECT user_id, key, value FROM user_settings WHERE key IN ('providerKeys', 'cloudBrowser', 'mcpBridge')",
    owner: (row) => row.user_id,
    json: 'value',
    fields: (row) => {
      const value = row.value;
      if (!value || typeof value !== 'object') return [];
      if (row.key === 'providerKeys') {
        /** @type {Sealed[]} */
        const out = [];
        for (const [provider, held] of Object.entries(value)) {
          const context = (user) => ['provider-key', user, provider];
          // A single string is how one key per provider was kept before lists.
          if (typeof held === 'string') out.push({ kind: 'provider-key', value: held, context, put: (sealed) => { value[provider] = sealed; } });
          else if (Array.isArray(held)) {
            held.forEach((entry, index) => {
              if (entry?.cipher) out.push({ kind: 'provider-key', value: entry.cipher, context, put: (sealed) => { held[index] = { ...entry, cipher: sealed }; } });
            });
          }
        }
        return out;
      }
      if (row.key !== 'cloudBrowser' && row.key !== 'mcpBridge') return [];
      const kind = row.key === 'cloudBrowser' ? 'cloud-browser' : 'mcp-bridge';
      return value.key ? [{ kind, value: value.key, context: (user) => [kind, user], put: (sealed) => { value.key = sealed; } }] : [];
    },
    update: (row, was) => ['UPDATE user_settings SET value = $3::jsonb WHERE user_id = $1 AND key = $2 AND value = $4::jsonb RETURNING user_id', [row.user_id, row.key, JSON.stringify(row.value), JSON.stringify(was.value)]],
  },
  mcp_servers: {
    select: "SELECT id, user_id, config FROM mcp_servers WHERE config ? 'headersCipher' OR config ? 'envCipher'",
    owner: (row) => row.user_id,
    json: 'config',
    fields: (row) => {
      const config = row.config;
      if (!config || typeof config !== 'object') return [];
      return [['headers', 'headersCipher'], ['env', 'envCipher']]
        .filter(([, field]) => config[field])
        .map(([what, field]) => ({ kind: 'mcp-config', value: config[field], context: (user) => ['mcp-config', user, what], put: (sealed) => { config[field] = sealed; } }));
    },
    update: (row, was) => ['UPDATE mcp_servers SET config = $2::jsonb WHERE id = $1 AND config = $3::jsonb RETURNING id', [row.id, JSON.stringify(row.config), JSON.stringify(was.config)]],
  },
};

/** A row to work on: its JSON column parsed and copied, so `put` never changes the row as read. Null when that column is not JSON. */
function working(place, row) {
  const copy = { ...row };
  if (!place.json || copy[place.json] == null) return copy;
  try {
    const raw = copy[place.json];
    copy[place.json] = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
    return copy;
  } catch {
    return null;
  }
}

/** One value: left as it is, sealed again, or not openable — and the new value when sealed again. */
function resealOne(value, context, tally) {
  if (!value) return null;
  if (!needsReseal(value)) {
    tally.current += 1;
    return null;
  }
  const opened = openSecret(value, context);
  if (opened.state !== 'ok') {
    tally.unopenable += 1;
    return null;
  }
  tally.resealed += 1;
  return encryptSecret(opened.value, context);
}

/** Per kind: values left, values sealed again, values no key here opens; rows written, rows changed since they were read. */
const emptyTally = () => ({ current: 0, resealed: 0, unopenable: 0, written: 0, changedMeanwhile: 0 });

/**
 * @param {(text: string, params?: any[]) => Promise<any[]>} query rows back for each statement
 * @param {{ apply?: boolean }} [options] apply: write; otherwise only count
 * @returns {Promise<Record<string, ReturnType<typeof emptyTally>>>}
 */
export async function resealSecrets(query, { apply = false } = {}) {
  /** @type {Record<string, ReturnType<typeof emptyTally>>} */
  const report = {};
  const tally = (kind) => (report[kind] ??= emptyTally());

  for (const place of Object.values(SEALED)) {
    for (const row of await query(place.select)) {
      const copy = working(place, row);
      if (!copy) continue;
      const owner = place.owner(row);
      let kind = null;
      for (const field of place.fields(copy)) {
        const next = resealOne(field.value, field.context(owner), tally(field.kind));
        if (!next) continue;
        field.put(next);
        kind ??= field.kind;
      }
      if (!kind || !apply) continue;
      const [sql, params] = place.update(copy, working(place, row));
      // `written` counts rows: one providerKeys row may hold several keys.
      if ((await query(sql, params)).length) tally(kind).written += 1;
      else tally(kind).changedMeanwhile += 1;
    }
  }
  return report;
}

/** Whose credentials a row of `table` holds, or null for a table that holds none. */
export const credentialOwner = (table, row) => (SEALED[table] ? SEALED[table].owner(row) || null : null);

/**
 * A row moving to an account with another id (db:copy merging an old account into the one
 * with the same email): each v2 value in it opened as the old owner's and sealed again as
 * the new owner's — bound to the old id, it would not open under the new one. v1 values are
 * unbound and stay as they are. A value that will not open here (no ENCRYPTION_KEY, or not
 * the key that sealed it) is left as it was and counted, never dropped. The row comes back
 * in the shape it came in.
 *
 * @param {string} table
 * @param {Record<string, any>} row
 * @param {string} toUser
 * @returns {{ row: Record<string, any>, rebound: number, unopenable: number }}
 */
export function rebindRow(table, row, toUser) {
  const place = SEALED[table];
  const from = place?.owner(row);
  if (!place || !from || from === toUser) return { row, rebound: 0, unopenable: 0 };
  const copy = working(place, row);
  if (!copy) return { row, rebound: 0, unopenable: 0 };
  let rebound = 0;
  let unopenable = 0;
  for (const field of place.fields(copy)) {
    if (secretVersion(field.value).version !== 'v2') continue;
    let opened;
    try {
      opened = openSecret(field.value, field.context(from));
    } catch {
      opened = { state: 'no-key', value: '' };
    }
    if (opened.state !== 'ok') {
      unopenable += 1;
      continue;
    }
    field.put(encryptSecret(opened.value, field.context(toUser)));
    rebound += 1;
  }
  if (!rebound) return { row, rebound, unopenable };
  if (place.json && typeof row[place.json] === 'string') copy[place.json] = JSON.stringify(copy[place.json]);
  return { row: copy, rebound, unopenable };
}

/**
 * Types for the list above (hoisted, so they can sit down here).
 *
 * @typedef {{ kind: string, value: string, context: (owner: string) => string[], put: (sealed: string) => void }} Sealed
 * @typedef {{
 *   select: string,
 *   owner: (row: any) => string,
 *   json?: string,
 *   fields: (row: any) => Sealed[],
 *   update: (row: any, was: any) => [string, any[]],
 * }} Place
 */
