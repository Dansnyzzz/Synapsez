import { SERVICES } from './connectors.js';
import { MCP_CATALOGUE } from './mcp/catalogue.js';
import { googleConfigured } from './google.js';
import { getStore } from './store/index.js';
import { getPrefs } from './settings.js';
import { translateMessage } from './i18n/index.js';

/**
 * The connector directory, as the assistant searches it — Claude's connector
 * search (Settings → Capabilities, on by default; owner, 2026-11-01).
 *
 * Claude's works like this: when what somebody asks for needs a service they
 * have not connected, Claude searches the directory, then shows the ones that
 * fit right there in the conversation, each with a Connect button; connected,
 * its tools are there for the rest of the conversation. Only directory entries
 * are ever suggested, never something typed in by hand, and when two could
 * help both are shown, the more useful first.
 *
 * Here the directory is what this app can actually connect: the services in
 * connectors.js (Google by signing in, the rest by a token) and the MCP servers
 * in mcp/catalogue.js. Nothing is connected from a conversation: Connect opens
 * the place in Settings where that one is connected, filled in, and the person
 * finishes it there — the same bargain as Claude's install links, which fill
 * the dialog in and leave the confirming to the person.
 */

/**
 * What each built-in service lets the assistant do, and the words it is found
 * by. `blurb` is the line on the card; server/i18n/vi.js has each one.
 */
const SERVICE_ABOUT = {
  google: {
    blurb: 'Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks and Contacts: search and send mail, find and read files, see and add events.',
    tags: ['email', 'mail', 'gmail', 'inbox', 'drive', 'files', 'calendar', 'meeting', 'schedule', 'event', 'docs', 'document', 'sheets', 'spreadsheet', 'forms', 'survey', 'tasks', 'todo', 'contacts', 'google'],
  },
  github: {
    blurb: 'Repositories, issues, pull requests and code search on GitHub — read them, and open an issue or a pull request.',
    tags: ['code', 'coding', 'repository', 'repo', 'issues', 'pull request', 'git', 'commits', 'developer'],
  },
  notion: {
    blurb: 'Finds and reads the Notion pages you share with it.',
    tags: ['notes', 'docs', 'wiki', 'pages', 'knowledge', 'workspace', 'project'],
  },
  slack: {
    blurb: 'Posts messages to a Slack channel as your bot.',
    tags: ['chat', 'messages', 'team', 'channel', 'post', 'workspace'],
  },
  supadata: {
    blurb: 'Reads the transcript of a YouTube video, so it can be summarised or quoted.',
    tags: ['youtube', 'video', 'transcript', 'subtitles', 'captions'],
  },
  telegram: {
    blurb: 'Sends messages from your own Telegram bot to a chat or a group.',
    tags: ['chat', 'messages', 'notify', 'notification', 'post', 'bot', 'phone'],
  },
  meta_page: {
    blurb: 'Publishes posts to a Facebook Page you manage.',
    tags: ['facebook', 'social', 'post', 'page', 'marketing', 'publish'],
  },
};

/**
 * Whose icon a card shows, fetched through this app's own favicon route — the
 * logos Claude's cards carry, without a copy of anybody's artwork here.
 */
const SITE = {
  google: 'google.com',
  github: 'github.com',
  notion: 'notion.so',
  slack: 'slack.com',
  supadata: 'supadata.ai',
  telegram: 'telegram.org',
  meta_page: 'facebook.com',
  context7: 'context7.com',
  gitnexus: 'github.com',
  repomix: 'repomix.com',
  filesystem: 'modelcontextprotocol.io',
  postgres: 'postgresql.org',
  sentry: 'sentry.io',
  playwright: 'playwright.dev',
  figma: 'figma.com',
  fetch: 'modelcontextprotocol.io',
  'sequential-thinking': 'modelcontextprotocol.io',
};

/** The most a search returns, and the most one card shows — Claude's shows a handful. */
const MAX_FOUND = 8;
export const MAX_SUGGESTED = 4;

/**
 * Every entry, with this account's state: connected (and as whom), paused in
 * the + menu, or not connected. Google is left out where the deployment has no
 * OAuth client — it could only be suggested to fail.
 *
 * @returns {Promise<Array<{ id: string, kind: 'service'|'mcp', name: string, blurb: string, tags: string[], how: 'signin'|'token'|'mcp', connected: boolean, paused: boolean, account: string|null }>>}
 */
export async function connectorDirectory(userId) {
  const store = getStore();
  const [rows, servers, prefs] = await Promise.all([
    store.listConnectors(userId).catch(() => []),
    store.listMcpServers(userId).catch(() => []),
    getPrefs(userId).catch(() => ({})),
  ]);
  const linked = new Map(rows.map((r) => [r.service, r.account ?? null]));
  const paused = new Set(Array.isArray(prefs.connectorsOff) ? prefs.connectorsOff : []);

  const services = Object.entries(SERVICE_ABOUT)
    .filter(([id]) => id !== 'google' || googleConfigured())
    .filter(([id]) => id === 'google' || SERVICES[id])
    .map(([id, about]) => ({
      id,
      kind: /** @type {const} */ ('service'),
      name: id === 'google' ? 'Google' : SERVICES[id].label,
      blurb: about.blurb,
      tags: about.tags,
      how: /** @type {'signin'|'token'} */ (id === 'google' ? 'signin' : 'token'),
      connected: linked.has(id),
      paused: linked.has(id) && paused.has(id),
      account: linked.get(id) ?? null,
    }));

  /*
   * An MCP server counts as this entry once it is added under the entry's name —
   * the name the Connect form fills in — or at the same address or command.
   */
  const sameServer = (entry, row) => {
    const config = row.config || {};
    if (String(row.name || '').toLowerCase() === entry.id) return true;
    if (entry.url && config.url === entry.url) return true;
    return !!entry.command && config.command === entry.command && JSON.stringify(config.args || []) === JSON.stringify(entry.args || []);
  };
  /*
   * `mcp:` before a server's id: GitHub and Notion are both a service here and a
   * server in the catalogue, and the model has to be able to say which it means.
   */
  const mcp = MCP_CATALOGUE.map((entry) => {
    const row = servers.find((s) => sameServer(entry, s));
    return {
      id: `mcp:${entry.id}`,
      kind: /** @type {const} */ ('mcp'),
      name: entry.label,
      blurb: entry.blurb,
      tags: entry.tags || [],
      how: /** @type {const} */ ('mcp'),
      connected: !!row,
      paused: !!row && (row.enabled === false || paused.has(row.id)),
      account: null,
    };
  });
  return [...services, ...mcp];
}

/**
 * The entries that fit a phrase, best first — forgiving, as the catalogue's
 * own search is: a name or id is worth most, a tag next, a word in the line
 * least. Nothing asked lists the services, then the servers.
 */
export function rankConnectors(entries, query, limit = MAX_FOUND) {
  const words = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
  if (!words.length) return entries.slice(0, limit);
  return entries
    .map((entry) => {
      const name = `${entry.id} ${entry.name}`.toLowerCase();
      const text = `${name} ${entry.blurb} ${entry.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (name.includes(word)) score += 3;
        else if (entry.tags.some((tag) => tag.includes(word) || word.includes(tag))) score += 2;
        else if (text.includes(word)) score += 1;
      }
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}

/** How an entry reads to the model: one line, its id first so it can be suggested by it. */
function line(entry) {
  const state = entry.connected
    ? entry.paused
      ? 'connected but paused in the + menu — they can switch it back on there'
      : `connected${entry.account ? ` as ${entry.account}` : ''} — its tools are yours to use`
    : `not connected — ${entry.how === 'signin' ? 'they sign in with Google' : entry.how === 'token' ? 'they paste a token' : 'an MCP server they add'}`;
  return `- ${entry.id} — ${entry.name}: ${entry.blurb} [${state}]`;
}

/** `search_connectors` — the directory searched, said in lines the model can pick from. */
export async function searchConnectorsTool({ query }, { userId }) {
  const found = rankConnectors(await connectorDirectory(userId), query);
  if (!found.length) {
    return `Nothing in the connector directory fits "${String(query || '').trim()}". Say so if it matters, and carry on with what you have.`;
  }
  return (
    `Connectors that fit "${String(query || '').trim()}", best first:\n${found.map(line).join('\n')}\n\n` +
    'To offer ones that are not connected, call suggest_connectors with their ids (the most useful first, at most four): ' +
    'the person sees each with a Connect button. Do not say you have reached a service that is not connected.'
  );
}

/**
 * `suggest_connectors` — the card. Ids not in the directory are dropped, not
 * guessed at; a connected one is shown as connected, never as a button.
 */
export async function suggestConnectorsTool({ ids, reason }, { userId }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim().toLowerCase()).filter(Boolean))];
  const directory = await connectorDirectory(userId);
  const items = wanted
    .map((id) => directory.find((entry) => entry.id === id))
    .filter(Boolean)
    .slice(0, MAX_SUGGESTED);
  if (!items.length) {
    throw new Error(`None of those is in the connector directory (${wanted.join(', ') || 'no ids given'}). Call search_connectors first and use the ids it gives.`);
  }
  const prefs = await getPrefs(userId).catch(() => ({}));
  const language = prefs.language || 'en';
  const open = items.filter((entry) => !entry.connected);
  return {
    content:
      `Showed ${items.map((entry) => entry.name).join(', ')} with ${open.length ? 'a Connect button' : 'their state'}. ` +
      (open.length
        ? 'Connecting happens in Settings, where they finish it; once they say it is done its tools are there — carry on from where you were. Until then, do not act as though it were connected.'
        : 'They are already connected, so use their tools.'),
    widget: {
      kind: 'connectors',
      title: String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      items: items.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        blurb: translateMessage(entry.blurb, language),
        site: SITE[entry.id.replace(/^mcp:/, '')] || null,
        how: entry.how,
        connected: entry.connected,
        paused: entry.paused,
      })),
    },
  };
}

export const __testing = { SERVICE_ABOUT, MAX_FOUND };
