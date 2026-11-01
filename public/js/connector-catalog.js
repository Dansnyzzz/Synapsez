/**
 * The connectors Settings → Connectors shows, as Claude's directory does
 * (owner, 2026-11-01): every Google product its own connector, then GitHub,
 * Notion, Slack, YouTube transcripts and Telegram — and a Facebook Page only
 * for an account that already connected one.
 *
 * What each is, who makes it and where its documentation is lives here; the
 * words a person reads are the locales' (`conn.<key>.tagline`, `.about`), and
 * where each stands — connected, its tools and which of them ask first — is the
 * server's (`/api/connectors/catalog`). Nothing here is a count or a rating:
 * Synapsez has no usage figures to rank by, and does not invent them.
 *
 * @typedef {{
 *   id: string, key: string, name: string, by: string, byUrl: string, site: string,
 *   category: 'files' | 'mail' | 'calendar' | 'data' | 'contacts' | 'dev' | 'notes' | 'messaging' | 'video' | 'social',
 *   api: string, docs: string, privacy: string, signIn: 'google' | 'token', product?: string,
 * }} Connector
 */

/** @type {Connector[]} */
export const CONNECTORS = [
  { id: 'google:drive', key: 'gdrive', product: 'drive', name: 'Google Drive', by: 'Google', byUrl: 'https://workspace.google.com/products/drive/', site: 'drive.google.com', category: 'files', api: 'https://www.googleapis.com/drive/v3', docs: 'https://developers.google.com/workspace/drive/api', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'google:gmail', key: 'gmail', product: 'gmail', name: 'Gmail', by: 'Google', byUrl: 'https://workspace.google.com/products/gmail/', site: 'mail.google.com', category: 'mail', api: 'https://gmail.googleapis.com/gmail/v1', docs: 'https://developers.google.com/workspace/gmail/api', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'google:calendar', key: 'gcalendar', product: 'calendar', name: 'Google Calendar', by: 'Google', byUrl: 'https://workspace.google.com/products/calendar/', site: 'calendar.google.com', category: 'calendar', api: 'https://www.googleapis.com/calendar/v3', docs: 'https://developers.google.com/workspace/calendar/api', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'google:docs', key: 'gdocs', product: 'docs', name: 'Google Docs', by: 'Google', byUrl: 'https://workspace.google.com/products/docs/', site: 'docs.google.com', category: 'files', api: 'https://docs.googleapis.com/v1', docs: 'https://developers.google.com/workspace/docs/api', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'google:sheets', key: 'gsheets', product: 'sheets', name: 'Google Sheets', by: 'Google', byUrl: 'https://workspace.google.com/products/sheets/', site: 'sheets.google.com', category: 'data', api: 'https://sheets.googleapis.com/v4', docs: 'https://developers.google.com/workspace/sheets/api', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'google:forms', key: 'gforms', product: 'forms', name: 'Google Forms', by: 'Google', byUrl: 'https://workspace.google.com/products/forms/', site: 'forms.google.com', category: 'data', api: 'https://forms.googleapis.com/v1', docs: 'https://developers.google.com/workspace/forms/api', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'google:tasks', key: 'gtasks', product: 'tasks', name: 'Google Tasks', by: 'Google', byUrl: 'https://workspace.google.com/products/tasks/', site: 'tasks.google.com', category: 'calendar', api: 'https://tasks.googleapis.com/tasks/v1', docs: 'https://developers.google.com/workspace/tasks', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'google:contacts', key: 'gcontacts', product: 'contacts', name: 'Google Contacts', by: 'Google', byUrl: 'https://contacts.google.com/', site: 'contacts.google.com', category: 'contacts', api: 'https://people.googleapis.com/v1', docs: 'https://developers.google.com/people', privacy: 'https://policies.google.com/privacy', signIn: 'google' },
  { id: 'github', key: 'github', name: 'GitHub', by: 'GitHub', byUrl: 'https://github.com', site: 'github.com', category: 'dev', api: 'https://api.github.com', docs: 'https://docs.github.com/rest', privacy: 'https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement', signIn: 'token' },
  { id: 'notion', key: 'notion', name: 'Notion', by: 'Notion', byUrl: 'https://www.notion.com', site: 'notion.so', category: 'notes', api: 'https://api.notion.com/v1', docs: 'https://developers.notion.com', privacy: 'https://www.notion.com/notion/privacy', signIn: 'token' },
  { id: 'slack', key: 'slack', name: 'Slack', by: 'Slack', byUrl: 'https://slack.com', site: 'slack.com', category: 'messaging', api: 'https://slack.com/api', docs: 'https://api.slack.com', privacy: 'https://slack.com/trust/privacy/privacy-policy', signIn: 'token' },
  { id: 'supadata', key: 'youtube', name: 'YouTube transcripts', by: 'Supadata', byUrl: 'https://supadata.ai', site: 'youtube.com', category: 'video', api: 'https://api.supadata.ai/v1', docs: 'https://docs.supadata.ai', privacy: 'https://supadata.ai/privacy', signIn: 'token' },
  { id: 'telegram', key: 'telegram', name: 'Telegram', by: 'Telegram', byUrl: 'https://telegram.org', site: 'telegram.org', category: 'messaging', api: 'https://api.telegram.org', docs: 'https://core.telegram.org/bots/api', privacy: 'https://telegram.org/privacy', signIn: 'token' },
  { id: 'meta_page', key: 'facebook', name: 'Facebook Page', by: 'Meta', byUrl: 'https://www.facebook.com', site: 'facebook.com', category: 'social', api: 'https://graph.facebook.com', docs: 'https://developers.facebook.com/docs/pages-api', privacy: 'https://www.facebook.com/privacy/policy', signIn: 'token' },
];

export const CONNECTOR_BY_ID = new Map(CONNECTORS.map((c) => [c.id, c]));

/**
 * The kinds a connector can be, in the order the filter lists them.
 * @type {Connector['category'][]}
 */
export const CATEGORIES = ['files', 'mail', 'calendar', 'data', 'contacts', 'dev', 'notes', 'messaging', 'video', 'social'];

/** The ones worth showing beside one: the same kind first, then its family (Google's), at most six. */
export function relatedTo(connector, shown = CONNECTORS) {
  const others = shown.filter((c) => c.id !== connector.id);
  const same = others.filter((c) => c.category === connector.category);
  const family = others.filter((c) => c.signIn === connector.signIn && c.by === connector.by && !same.includes(c));
  const rest = others.filter((c) => !same.includes(c) && !family.includes(c));
  return [...same, ...family, ...rest].slice(0, 6);
}
