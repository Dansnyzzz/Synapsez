import { getStore } from './store/index.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { GOOGLE_PRODUCTS, googleConfigured, googleGrants, disconnectGoogle } from './google.js';

/**
 * Connectors — the assistant reaching services you already use.
 *
 * These are **token-based**, and that is a deliberate limit rather than a
 * shortcut. GitHub, Notion and Slack all issue a token you can create yourself,
 * paste once, and revoke from their side whenever you like — the same shape as
 * the provider API keys this app already handles, with no redirect flow, no
 * client secret, and nothing to register.
 *
 * Google's services (Gmail, Drive, Calendar and the rest) do not work that way:
 * they need a full OAuth consent flow with a registered application and a
 * redirect URI, which cannot be done from a token box. That flow lives in
 * google.js, and appears here only as one more card in the list.
 *
 * Tokens are encrypted at rest with the same key as everything else and are
 * never returned to the browser, only ever used server-side.
 */

export const SERVICES = {
  github: {
    label: 'GitHub',
    help: 'Settings → Developer settings → Personal access tokens → Fine-grained tokens.',
    placeholder: 'github_pat_… or ghp_…',
    async verify(token) {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`GitHub rejected that token (HTTP ${res.status}).`);
      const me = await res.json();
      return me.login;
    },
  },
  notion: {
    label: 'Notion',
    help: 'notion.so/my-integrations → New integration → Internal Integration Secret. Then share the pages you want it to see with that integration.',
    placeholder: 'ntn_… or secret_…',
    async verify(token) {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Notion rejected that token (HTTP ${res.status}).`);
      const me = await res.json();
      return me.bot?.owner?.user?.name || me.name || 'integration';
    },
  },
  slack: {
    label: 'Slack',
    help: 'api.slack.com/apps → your app → OAuth & Permissions → Bot User OAuth Token.',
    placeholder: 'xoxb-…',
    async verify(token) {
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => ({}));
      // Slack answers 200 with ok:false, so the status code alone proves nothing.
      if (!body.ok) throw new Error(`Slack rejected that token (${body.error || 'unknown error'}).`);
      return body.user || body.team || 'bot';
    },
  },
  /**
   * Telegram, which is the easiest of these by a distance.
   *
   * A bot token from a conversation with @BotFather — no app to register, no
   * review, no redirect URI, and the token does not expire. For a Vietnamese
   * audience it is also the messaging platform that will actually answer, which
   * is the only test that matters for a connector.
   */
  /**
   * Reading a YouTube video as words.
   *
   * A connector rather than something built in, and the reason is worth
   * recording: YouTube's own caption endpoint no longer serves a server. The
   * page still lists the tracks, and fetching one returns HTTP 200 with an
   * empty body — verified against three videos, including manually captioned
   * ones, from a residential address as well as a datacentre. The open-source
   * front-ends that used to proxy it (Invidious, Piped) are blocked too; every
   * public instance tried answered 500, 403, or an HTML error page.
   *
   * So the words have to be bought from somebody who solves that problem, and
   * that means a key, and a key means this is a connector — which also buys the
   * property that matters most: `youtube_transcript` carries `needs:
   * 'supadata'`, so an account without a key is never shown the tool at all.
   * It cannot promise a video summary it has no way to produce.
   */
  supadata: {
    label: 'YouTube transcripts (Supadata)',
    help:
      'supadata.ai → sign up → Dashboard → API key. The free plan is 100 transcripts a month and takes no card. ' +
      'Only needed to read videos; everything else works without it.',
    placeholder: 'sd_…',
    async verify(token) {
      /**
       * Asked with a URL that is deliberately not a video.
       *
       * There is no documented endpoint for "is this key good", and the
       * transcript endpoint costs a credit — spending one of a hundred to
       * check a key somebody just pasted is a poor trade. A bad request with
       * a good key and a bad request with a bad key come back differently,
       * and that difference is the whole test: 401 and 403 are the key, and
       * anything else means the key got far enough to be told the URL was
       * wrong.
       *
       * Deliberately forgiving in the other direction. If Supadata changes
       * what it answers here, the failure mode is a key accepted that later
       * turns out to be wrong — which the tool reports in full when it is
       * used — rather than a good key refused at the door with no way past.
       */
      const res = await fetch('https://api.supadata.ai/v1/transcript?url=not-a-video', {
        headers: { 'x-api-key': token },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Supadata rejected that key (HTTP ${res.status}).`);
      }
      return 'Supadata';
    },
  },
  telegram: {
    label: 'Telegram',
    help: 'Message @BotFather on Telegram → /newbot → it gives you a token. Then message your bot once, or add it to a group, so it has somewhere to post.',
    placeholder: '123456789:AA…',
    async verify(token) {
      const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, {
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) throw new Error(`Telegram rejected that token (${body.description || `HTTP ${res.status}`}).`);
      return body.result?.username ? `@${body.result.username}` : 'bot';
    },
  },
  /**
   * A Facebook Page, posting as the Page.
   *
   * This one has real friction and it is worth stating rather than hiding: the
   * token has to be a **Page** access token, obtained through an app the user
   * creates. A short-lived one works and then stops working in an hour, which is
   * the kind of failure that looks like the app breaking — so `verify` reads the
   * token's own expiry and refuses a short-lived one outright.
   */
  meta_page: {
    label: 'Facebook Page',
    help:
      'developers.facebook.com → create an app → Graph API Explorer → select your Page → grant pages_manage_posts and ' +
      'pages_read_engagement → then use the Access Token Debugger to "Extend" it into a long-lived Page token. ' +
      'A short-lived token is refused here, because it would stop working within the hour.',
    placeholder: 'EAAG…',
    async verify(token) {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        throw new Error(`Facebook rejected that token (${body.error?.message || `HTTP ${res.status}`}).`);
      }

      /**
       * Refuse a token that is about to die.
       *
       * `expires_at: 0` is what a never-expiring Page token reports. Anything else
       * inside a day is a token that will work in this dialog and fail tomorrow,
       * which is exactly the "half-working" outcome this file already refuses to
       * ship for Google.
       */
      const debug = await fetch(
        `https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(20_000) },
      )
        .then((r) => r.json())
        .catch(() => null);

      const expires = debug?.data?.expires_at;
      if (typeof expires === 'number' && expires > 0) {
        const daysLeft = (expires * 1000 - Date.now()) / 86_400_000;
        if (daysLeft < 1) {
          throw new Error(
            `That token expires in under a day (${new Date(expires * 1000).toISOString()}), so it would stop working almost immediately. ` +
              'Use the Access Token Debugger to extend it into a long-lived Page token first.',
          );
        }
      }
      if (debug?.data?.type && debug.data.type !== 'PAGE') {
        throw new Error(
          `That is a ${debug.data.type} token, not a Page token. Posting as a Page needs a Page token — pick your Page in the Graph API Explorer first.`,
        );
      }

      return body.name || body.id || 'page';
    },
  },
};

/** Verify before storing, so a bad paste fails now rather than mid-task later. */
export async function connect(userId, service, token) {
  const spec = SERVICES[service];
  if (!spec) throw new Error(`No connector called "${service}".`);

  const clean = String(token || '').trim();
  if (!clean) throw new Error('Paste the token.');

  const account = await spec.verify(clean);
  await getStore().saveConnector(userId, service, encryptSecret(clean), account);
  return { service, account };
}

export async function disconnect(userId, service) {
  // Google's grant is revoked on Google's side too, not only forgotten here.
  if (service === 'google') return disconnectGoogle(userId);
  await getStore().deleteConnector(userId, service);
}

export async function connectedServices(userId) {
  const rows = await getStore().listConnectors(userId);
  const connected = new Set(rows.map((r) => r.service));
  const tokens = Object.entries(SERVICES).map(([id, spec]) => ({
    id,
    label: spec.label,
    help: spec.help,
    placeholder: spec.placeholder,
    connected: connected.has(id),
    account: rows.find((r) => r.service === id)?.account ?? null,
  }));

  /**
   * Google first, and a different kind of card: a button and a choice of
   * products rather than a token box. `configured` is false until the
   * deployment has its OAuth client, and the card then says how to set it up.
   */
  const granted = connected.has('google') ? await googleGrants(userId) : [];
  const google = {
    id: 'google',
    label: 'Google',
    oauth: true,
    configured: googleConfigured(),
    help: googleConfigured()
      ? 'Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks and Contacts. Tick what the assistant may use, then sign in with Google.'
      : 'Not set up on this deployment yet. The owner creates a free OAuth client in Google Cloud Console and sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — see docs/google.md.',
    placeholder: '',
    connected: connected.has('google'),
    account: rows.find((r) => r.service === 'google')?.account ?? null,
    products: Object.entries(GOOGLE_PRODUCTS).map(([id, spec]) => ({ id, label: spec.label, granted: granted.includes(id) })),
  };
  return [google, ...tokens];
}

async function tokenFor(userId, service) {
  const row = await getStore().getConnector(userId, service);
  if (!row) {
    throw new Error(
      `${SERVICES[service]?.label || service} is not connected. The user can connect it in Settings → Connectors.`,
    );
  }
  return decryptSecret(row.token);
}

/**
 * Which connectors this account has — as prose for the system prompt, and as ids
 * for deciding which tools to offer at all.
 *
 * Both from one query. The tool filter needs the ids because a connector tool
 * whose service is not linked can only fail: `slack_post` used to be advertised
 * to every account, so the model could promise to post to a Slack that had never
 * been connected, and its schema was paid for on every request regardless.
 */
export async function connectorSummary(userId) {
  const rows = await getStore().listConnectors(userId);
  const ids = rows.map((r) => r.service);
  // Google is one connection but several grants: each product the person
  // allowed is its own id, so a Gmail tool is offered only when Gmail was.
  let googleProducts = [];
  if (ids.includes('google')) {
    googleProducts = await googleGrants(userId).catch(() => []);
    ids.push(...googleProducts.map((p) => `google_${p}`));
  }
  const label = (r) =>
    r.service === 'google'
      ? `Google — ${googleProducts.map((p) => GOOGLE_PRODUCTS[p].label).join(', ') || 'no products'}`
      : SERVICES[r.service]?.label || r.service;
  return {
    ids,
    summary: rows.length ? rows.map((r) => `${label(r)}${r.account ? ` (${r.account})` : ''}`).join(', ') : null,
  };
}

// ── the calls the tools make ──────────────────────────────────────────

const clip = (text, max = 20_000) =>
  text.length > max ? `${text.slice(0, max)}\n\n[truncated — ${text.length - max} more characters]` : text;

/**
 * Pin a model-supplied API path to one host.
 *
 * This used to accept a full URL when it began with "http", which meant the
 * model could be talked into sending the user's GitHub token to any server on
 * the internet — and it can be talked into things, because it reads web pages
 * that contain instructions. A token in an `Authorization` header only ever
 * belongs on the host it was issued for.
 */
function githubUrl(path) {
  const given = String(path || '').trim();
  if (!given.startsWith('/')) {
    throw new Error(
      `Give a GitHub API path beginning with "/", such as "/repos/owner/name/issues" — not "${given.slice(0, 60)}".`,
    );
  }
  const url = new URL(given, 'https://api.github.com');
  // A path like "//evil.com/x" parses as a host, not a path. Checking after
  // resolution catches that, and anything else the parser reads differently.
  if (url.origin !== 'https://api.github.com') {
    throw new Error('That path does not stay on api.github.com.');
  }
  return url;
}

async function githubCall(userId, path, params) {
  const url = githubUrl(path);
  const token = await tokenFor(userId, 'github');
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    // No redirects: GitHub does not need them here, and following one is how the
    // header this request carries ends up somewhere it was never meant to go.
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body.slice(0, 300)}`);
  return clip(body);
}

async function notionSearch(userId, query) {
  const token = await tokenFor(userId, 'notion');
  const res = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: String(query ?? ''), page_size: 20 }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Notion ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);

  const results = (body.results || []).map((r) => {
    const title =
      r.properties?.title?.title?.[0]?.plain_text ||
      r.properties?.Name?.title?.[0]?.plain_text ||
      r.title?.[0]?.plain_text ||
      '(untitled)';
    return `- ${title} — ${r.url || r.id}`;
  });
  return results.length ? results.join('\n') : 'Nothing matched. Note that Notion only returns pages shared with the integration.';
}

async function slackPost(userId, channel, text) {
  const token = await tokenFor(userId, 'slack');
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Slack refused: ${body.error || 'unknown error'}`);
  return `Posted to ${channel}.`;
}

/**
 * Writing to GitHub, not just reading it.
 *
 * `github` is read-only and graded as safe, which is right — listing issues is
 * not a decision. But it meant the assistant could read a repository all day and
 * could not open an issue, leave a comment or raise a pull request, so anything
 * that ended in "and file that" ended in asking the user to do it by hand.
 *
 * A separate tool rather than a `method` argument on the existing one, because the
 * approval policy grades by tool: reading has to stay unprompted, and writing has
 * to be something the user can be asked about.
 */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

async function githubWrite(userId, path, method, body) {
  const verb = String(method || 'POST').toUpperCase();
  if (!WRITE_METHODS.has(verb)) {
    throw new Error(`"${method}" is not a write method. Use POST, PATCH, PUT or DELETE — reading is what \`github\` is for.`);
  }

  const url = githubUrl(path);
  const token = await tokenFor(userId, 'github');

  const res = await fetch(url, {
    method: verb,
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    // GitHub's own message names the missing scope, which is the one thing the
    // model can act on — a bare status code would send it round the loop again.
    throw new Error(`GitHub ${res.status} on ${verb} ${url.pathname}: ${text.slice(0, 400)}`);
  }
  return clip(text || `${verb} ${url.pathname} succeeded (${res.status}, no body).`);
}

async function telegramSend(userId, chatId, text) {
  const token = await tokenFor(userId, 'telegram');
  const target = String(chatId ?? '').trim();
  if (!target) {
    throw new Error(
      'Which chat? Telegram needs a chat id — a number, or "@channelname" for a public channel. ' +
        'A bot cannot start a conversation, so the user has to message it first.',
    );
  }

  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: target, text: String(text ?? ''), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    throw new Error(
      `Telegram refused: ${body.description || `HTTP ${res.status}`}. ` +
        (/chat not found/i.test(body.description || '')
          ? 'A bot can only message someone who has messaged it first, or a group it has been added to.'
          : ''),
    );
  }
  return `Sent to ${target}.`;
}

async function metaPagePost(userId, message, link) {
  const token = await tokenFor(userId, 'meta_page');
  const params = new URLSearchParams({ message: String(message ?? ''), access_token: token });
  if (link) params.set('link', String(link));

  const res = await fetch('https://graph.facebook.com/v21.0/me/feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`Facebook refused: ${body.error?.message || `HTTP ${res.status}`}`);
  }
  return `Posted to the Page. Post id ${body.id}. This is public — say what was posted.`;
}

/**
 * A video's captions, from Supadata.
 *
 * Returns the raw segments — `{ text, offset, duration, lang }`, offsets in
 * milliseconds — and leaves the shaping to the tool. The split is deliberate:
 * this file owns the credential and the request, and `cloud.js` owns what a
 * transcript should look like when a model reads it.
 */
async function supadataTranscript(userId, url, lang) {
  const token = await tokenFor(userId, 'supadata');
  const ask = new URL('https://api.supadata.ai/v1/transcript');
  ask.searchParams.set('url', String(url ?? ''));
  if (lang) ask.searchParams.set('lang', String(lang));

  const res = await fetch(ask, {
    headers: { 'x-api-key': token },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // Supadata's own sentence, not a code. "This video has no transcript" and
    // "you are out of credits" need different things from the person reading,
    // and a bare HTTP 4xx tells them neither.
    const said = body?.message || body?.error || `HTTP ${res.status}`;
    throw new Error(`Supadata could not read that video: ${said}`);
  }
  return body;
}

export const CONNECTOR_CALLS = {
  githubCall,
  githubWrite,
  notionSearch,
  slackPost,
  telegramSend,
  metaPagePost,
  supadataTranscript,
};
export const __testing = { githubUrl, WRITE_METHODS };
