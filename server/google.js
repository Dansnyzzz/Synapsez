import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { signingRoot } from './secrets.js';

/**
 * Google — Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks, Contacts.
 *
 * Every other connector is a token somebody pastes. Google does not issue one:
 * its APIs are reached through an OAuth consent screen, which needs an
 * application registered to *this deployment* — a client id, a client secret
 * and the redirect address below. So this connector has two halves. The owner
 * of the deployment registers the app once (free, in Google Cloud Console) and
 * sets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; after that each account
 * connects its own Google account by pressing a button and choosing which of
 * the products to allow. Without the two variables the card says how to set
 * them rather than offering a button that cannot work.
 *
 * What is kept, encrypted like every other token: the refresh token, the
 * current access token and when it expires, and the scopes Google actually
 * granted. The last matters because the consent screen lets a person untick a
 * product — the tools offered to the model follow what was granted, not what
 * was asked for, so it is never handed a Gmail tool that can only fail.
 */

/** The products a person can allow, each with the scopes it needs. */
export const GOOGLE_PRODUCTS = {
  gmail: { label: 'Gmail', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  calendar: { label: 'Google Calendar', scopes: ['https://www.googleapis.com/auth/calendar'] },
  drive: { label: 'Google Drive', scopes: ['https://www.googleapis.com/auth/drive'] },
  docs: { label: 'Google Docs', scopes: ['https://www.googleapis.com/auth/documents'] },
  sheets: { label: 'Google Sheets', scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
  forms: {
    label: 'Google Forms',
    scopes: ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'],
  },
  tasks: { label: 'Google Tasks', scopes: ['https://www.googleapis.com/auth/tasks'] },
  contacts: { label: 'Google Contacts', scopes: ['https://www.googleapis.com/auth/contacts.readonly'] },
};

const BASE_SCOPES = ['openid', 'email', 'profile'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL_MS = 10 * 60_000;

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/** Where Google sends the person back. Must be listed on the OAuth client exactly. */
export const redirectUri = (origin) =>
  String(process.env.GOOGLE_REDIRECT_URI || `${origin}/api/connectors/google/callback`).trim();

const stateKey = () => {
  const root = signingRoot();
  // An empty key signs nothing: anybody could compute the signature.
  if (!root) throw new Error('Set SESSION_SECRET — refusing to sign a Google sign-in without one.');
  return root;
};
const sign = (payload) => crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');

/**
 * A `state` that proves the callback belongs to the request that started it.
 *
 * Signed, bound to the account, short-lived, and paired with a nonce kept in a
 * cookie on this browser — so a callback URL somebody else started, or one
 * replayed later, cannot attach *their* Google account to *this* one.
 */
export function makeState(userId, products) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ u: userId, p: products, n: nonce, e: Date.now() + STATE_TTL_MS })).toString(
    'base64url',
  );
  return { state: `${payload}.${sign(payload)}`, nonce };
}

/** The products the state carried, or an error saying why it is not trusted. */
export function readState(state, userId, nonce) {
  const [payload, mac] = String(state || '').split('.');
  if (!payload || !mac) throw new Error('The Google sign-in came back without a valid state. Start again from Settings.');
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('The Google sign-in came back without a valid state. Start again from Settings.');
  }
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (data.u !== userId || !nonce || data.n !== nonce) {
    throw new Error('That Google sign-in was started from another session. Start again from Settings.');
  }
  if (Date.now() > Number(data.e)) throw new Error('The Google sign-in took too long. Start again from Settings.');
  return Array.isArray(data.p) ? data.p : [];
}

/** Product ids from a comma list, keeping only real ones; all of them when none is named. */
export function pickProducts(list) {
  const wanted = String(list || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => GOOGLE_PRODUCTS[s]);
  return wanted.length ? [...new Set(wanted)] : Object.keys(GOOGLE_PRODUCTS);
}

/** The consent-screen address for these products. */
export function authUrl({ userId, products, origin }) {
  const { state, nonce } = makeState(userId, products);
  const scopes = [...BASE_SCOPES, ...products.flatMap((p) => GOOGLE_PRODUCTS[p].scopes)];
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: scopes.join(' '),
    // A refresh token, so a scheduled run at 3am can still reach the inbox.
    access_type: 'offline',
    // Always ask: without it Google omits the refresh token on a reconnect.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return { url: url.toString(), nonce };
}

/** Which products a granted-scope string covers — all of a product's scopes, or it is not granted. */
export function grantedProducts(scope) {
  const have = new Set(String(scope || '').split(/\s+/).filter(Boolean));
  return Object.entries(GOOGLE_PRODUCTS)
    .filter(([, spec]) => spec.scopes.every((s) => have.has(s)))
    .map(([id]) => id);
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      ...params,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

async function readRow(userId) {
  const row = await getStore().getConnector(userId, 'google');
  if (!row) return null;
  try {
    return { row, data: JSON.parse(decryptSecret(row.token)) };
  } catch {
    return null;
  }
}

const save = (userId, data, account) => getStore().saveConnector(userId, 'google', encryptSecret(JSON.stringify(data)), account);

/** Trade the code for tokens and keep them. */
export async function finishAuth({ userId, code, origin }) {
  const { ok, body } = await tokenRequest({ code: String(code || ''), redirect_uri: redirectUri(origin), grant_type: 'authorization_code' });
  if (!ok || !body.access_token) {
    throw new Error(`Google refused the sign-in (${body.error_description || body.error || 'no token'}).`);
  }
  // A reconnect that only added a product may come back without a refresh
  // token; the one already held stays good.
  const previous = await readRow(userId);
  const refresh = body.refresh_token || previous?.data?.refresh || null;
  if (!refresh) {
    throw new Error('Google did not give a refresh token, so scheduled runs could not reach it. Disconnect and connect again.');
  }

  const who = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${body.access_token}` },
    signal: AbortSignal.timeout(20_000),
  })
    .then((r) => r.json())
    .catch(() => ({}));

  const data = {
    access: body.access_token,
    refresh,
    exp: Date.now() + Number(body.expires_in || 3600) * 1000,
    scope: body.scope || '',
  };
  await save(userId, data, who.email || 'Google');
  return { account: who.email || 'Google', products: grantedProducts(data.scope) };
}

/** The products this account has granted, for the tool filter and the settings card. */
export async function googleGrants(userId) {
  const found = await readRow(userId);
  return found ? grantedProducts(found.data.scope) : [];
}

/** A live access token, refreshed when it is about to run out. */
async function accessToken(userId) {
  const found = await readRow(userId);
  if (!found) throw new Error('Google is not connected. The user can connect it in Settings → Connectors.');
  const { row, data } = found;
  if (data.access && Number(data.exp) - 60_000 > Date.now()) return data.access;

  const { ok, body } = await tokenRequest({ refresh_token: data.refresh, grant_type: 'refresh_token' });
  if (!ok || !body.access_token) {
    throw new Error(
      'Google access has expired or been revoked. Reconnect Google in Settings → Connectors.',
    );
  }
  const next = { ...data, access: body.access_token, exp: Date.now() + Number(body.expires_in || 3600) * 1000 };
  if (body.scope) next.scope = body.scope;
  await save(userId, next, row.account);
  return next.access;
}

/**
 * One call to a Google API, as the account.
 *
 * @param {string} url  a full https://*.googleapis.com address — only Google's
 *   own hosts, so a model-shaped URL can never carry the token elsewhere.
 * @param {{ method?: string, query?: Record<string, any>, json?: any, body?: any, headers?: Record<string, string>, raw?: boolean }} [options]
 */
export async function googleApi(userId, url, options = {}) {
  const { method = 'GET', query, json, body, headers = {}, raw = false } = options;
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/(^|\.)googleapis\.com$/.test(target.hostname)) {
    throw new Error('Only Google API addresses can be called with the Google token.');
  }
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) target.searchParams.append(k, String(item));
    else target.searchParams.set(k, String(v));
  }
  const token = await accessToken(userId);
  const res = await fetch(target, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const message = detail?.error?.message || detail?.error_description || '';
    const reason = detail?.error?.errors?.[0]?.reason || detail?.error?.status || '';
    if (res.status === 403 && /insufficient|scope|PERMISSION_DENIED/i.test(`${reason} ${message}`)) {
      throw new Error(
        'Google has not given this app access to that. Reconnect Google in Settings → Connectors and allow it.',
      );
    }
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(`${reason} ${message}`)) {
      throw new Error(
        `That Google API is not switched on for this app. The deployment owner enables it in Google Cloud Console → APIs & Services (${message.slice(0, 160)}).`,
      );
    }
    throw new Error(`Google answered HTTP ${res.status}${message ? `: ${message.slice(0, 300)}` : ''}.`);
  }
  if (raw) return res;
  if (res.status === 204) return {};
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** Forget the tokens, and tell Google so the grant stops existing on its side too. */
export async function disconnectGoogle(userId) {
  const found = await readRow(userId);
  if (found?.data?.refresh) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(found.data.refresh)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  await getStore().deleteConnector(userId, 'google');
}

export const __testing = { sign };
