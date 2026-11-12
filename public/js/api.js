/** Thin wrapper over the JSON API, plus the SSE reader for the agent stream. */
import { narrate } from './mirror.js';
import { t, currentLanguage } from './i18n.js';

/**
 * Whether this page is signed in (app.js `start`). Only then does a 401 mean the session
 * ended, and reloading drops back to the gate. On the gate a 401 is an answer — a wrong
 * password, a code asked for — and a reload there wiped what was being typed and never
 * said why; coming back to the tab did the same (owner, 2026-11-10).
 */
let signedIn = false;
/** @param {boolean} on */
export const markSignedIn = (on) => {
  signedIn = !!on;
};

/**
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 * @param {{ signal?: AbortSignal }} [options]
 */
async function request(method, path, body, options = {}) {
  const res = await fetch(path, {
    method,
    signal: options.signal,
    // The language rides on every call, so a message the server writes — an
    // error, a status line — comes back in it. See server/i18n.
    headers: { 'X-Language': currentLanguage(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  // The session cookie is gone or the access code changed. Reloading drops us
  // back to the gate, which is the only useful thing to do here — once signed in.
  if (res.status === 401 && signedIn) {
    location.reload();
    throw new Error(t('session.expired'));
  }
  const text = await res.text();

  /**
   * Not everything that answers this app speaks JSON.
   *
   * The platform in front of it does not: an upload over the host's request
   * limit is refused by the edge with a plain-text `Request Entity Too Large`,
   * before any of our code runs. `JSON.parse` then threw, and what reached the
   * person was `Unexpected token 'R', "Request En"... is not valid JSON` —
   * which says nothing about the file they were trying to send. A proxy error
   * page and a gateway timeout arrive the same way.
   */
  // `any`, because every caller reads a shape of its own off this and the
  // alternative is a type per endpoint for a function that is one `fetch`.
  /** @type {any} */
  let json = {};
  let unparsed = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      unparsed = text;
    }
  }

  if (!res.ok) {
    const err = /** @type {Error & { code?: string, status?: number, email?: string, findings?: any[] }} */ (new Error(json.error || messageFor(res.status, unparsed)));
    // Callers branch on this — e.g. 'totp_required' is a step, not a failure.
    err.code = json.code;
    err.status = res.status;
    // The address a sign-in's "confirm your email" names, so the code box can show it.
    if (typeof json.email === 'string') err.email = json.email;
    // What a safety scan found, when that is why it was refused (a shared skill).
    if (Array.isArray(json.findings)) err.findings = json.findings;
    throw err;
  }
  if (unparsed) {
    // A 200 that is not JSON is a proxy answering instead of the app. Saying
    // so is better than handing the caller an empty object to misread.
    throw Object.assign(new Error(t('error.notTheApp')), { status: res.status });
  }
  return json;
}

/**
 * What to say when the answer did not come from the app.
 *
 * Each of these is a thing the host or a proxy does on its own, and each has a
 * different fix — so the sentence names the fix rather than the status code.
 */
function messageFor(status, body) {
  if (status === 413) return t('error.tooLargeForHost');
  if (status === 504 || status === 524) return t('error.hostTimedOut');
  if (status === 502 || status === 503) return t('error.hostUnavailable');
  // Anything else: the status, plus the first line of whatever answered, which
  // is usually the only clue there is.
  const first = String(body || '').trim().split(/\r?\n/)[0].slice(0, 120);
  return first ? `HTTP ${status} — ${first}` : `HTTP ${status}`;
}

/** Drop empty query params so the URL stays readable. */
const clean = (params = {}) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '' && v !== 'all'));

/** This browser's IANA zone, e.g. "Asia/Ho_Chi_Minh". Null if it will not say. */
function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export const api = {
  session: () => request('GET', '/api/session'),
  login: (credentials) => request('POST', '/api/login', credentials),
  register: (details) => request('POST', '/api/register', details),
  /** A new account's email, by the code typed (`email`, `code`) or the link opened (`token`). */
  confirmEmail: (payload) => request('POST', '/api/register/confirm', payload),
  resendConfirmation: (email) => request('POST', '/api/register/resend', { email }),
  logout: () => request('POST', '/api/logout'),
  /** Agreeing to the documents as they are now — `versions` as bootstrap's `consent.current` says them. */
  agree: (versions) => request('POST', '/api/consent', versions),

  /** Themes, the boards and titles (server/themes.js). */
  themes: () => request('GET', '/api/themes'),
  selectTheme: (id) => request('PUT', '/api/themes/selected', { id }),
  ranking: (scope, key) => request('GET', `/api/ranking?${new URLSearchParams(clean({ scope, key }))}`),
  titles: () => request('GET', '/api/titles'),
  equipTitle: (id) => request('PUT', '/api/titles/equipped', { id }),
  adminThemes: () => request('GET', '/api/admin/themes'),
  themePeople: () => request('GET', '/api/admin/themes/people'),
  themeHolders: (id) => request('GET', `/api/admin/themes/${encodeURIComponent(id)}/holders`),
  setThemeBadge: (id, badge) => request('PUT', `/api/admin/themes/${encodeURIComponent(id)}`, badge),
  giveTheme: (id, userId) => request('POST', `/api/admin/themes/${encodeURIComponent(id)}/holders`, { userId }),
  takeTheme: (id, userId) => request('DELETE', `/api/admin/themes/${encodeURIComponent(id)}/holders/${encodeURIComponent(userId)}`),

  /** Settings → Usage: each provider's own figures for the account's keys, and what Synapsez counted. */
  usageReport: () => request('GET', '/api/usage/report'),
  /** The same without the hours: what the warning above the composer needs. */
  usageLimits: () => request('GET', '/api/usage/report?part=limits'),
  /** Settings → System: how full the cloud computer's disk is, and what tidying freed. */
  cloudDisk: () => request('GET', '/api/cloud-computer/disk'),
  /** Where the account is signed in, and signing one device out. */
  sessions: () => request('GET', '/api/account/sessions'),
  signOutDevice: (id) => request('DELETE', `/api/account/sessions/${encodeURIComponent(id)}`),
  /** Give feedback, and an administrator's view of what was sent. */
  feedback: (body) => request('POST', '/api/feedback', body),
  adminFeedback: () => request('GET', '/api/admin/feedback'),
  /** Whether this site's address is safe from spoofing, checked live (server/domainCheck.js). */
  domainCheck: () => request('GET', '/api/admin/domain'),
  // Feedback on one answer, from the thumb beside its copy button (owner, 2026-11-02).
  answerFeedback: (body) => request('POST', '/api/feedback/answer', body),
  // The deployment's free allowances this period (server/freeTier.js).
  freeTier: () => request('GET', '/api/admin/free-tier'),
  feedbackTranscript: (id) => request('GET', `/api/admin/feedback/${encodeURIComponent(id)}/transcript`),
  markFeedbackRead: (id) => request('PUT', `/api/admin/feedback/${encodeURIComponent(id)}/read`),
  deleteFeedback: (id) => request('DELETE', `/api/admin/feedback/${encodeURIComponent(id)}`),

  forgotPassword: (email) => request('POST', '/api/password/forgot', { email }),
  resetPassword: (payload) => request('POST', '/api/password/reset', payload),

  /** `hd` asks the worker for a full-size frame — see the viewer's expand button. */
  screen: (hd = false) => request('GET', `/api/screen${hd ? '?hd=1' : ''}`),
  closeScreen: () => request('POST', '/api/screen/close'),
  screenInput: (event) => request('POST', '/api/screen/input', event),
  /** `driving` also keeps the machine awake: a person's gestures go straight to it and never pass the server to do that. */
  cloudBrowserState: (driving = false) => request('GET', `/api/cloud-browser/state${driving ? '?driving=1' : ''}`),
  /** One gesture, or `{ events: [...] }` — the relay, for when the socket to the machine cannot be opened. */
  cloudBrowserInput: (event) => request('POST', '/api/cloud-browser/input', event),
  closeCloudBrowser: () => request('POST', '/api/cloud-browser/close'),

  projects: ({ archived = false } = {}) =>
    request('GET', `/api/projects${archived ? '?archived=1' : ''}`),
  project: (id) => request('GET', `/api/projects/${id}`),
  createProject: (project) => request('POST', '/api/projects', project),
  updateProject: (id, patch) => request('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),
  // A note is read into every future conversation, so forgetting one is a real
  // action rather than tidying. `scope` says which set it comes out of: a
  // project note and an account note may share a name.
  forgetNote: (projectId, key, scope) =>
    request('DELETE', `/api/projects/${projectId}/memory/${encodeURIComponent(key)}?scope=${scope}`),
  addProjectFile: (id, file) => request('POST', `/api/projects/${id}/files`, file),
  deleteProjectFile: (id, fileId) => request('DELETE', `/api/projects/${id}/files/${fileId}`),

  skills: () => request('GET', '/api/skills'),
  saveSkill: (skill) => request('POST', '/api/skills', skill),
  setSkillEnabled: (id, enabled) => request('PATCH', `/api/skills/${id}`, { enabled }),
  deleteSkill: (id) => request('DELETE', `/api/skills/${id}`),
  // The words the assistant last replaced in a skill, put back (schema 51).
  restoreSkill: (id) => request('POST', `/api/skills/${encodeURIComponent(id)}/restore`),
  // Skills shared to Discover (schema 41): sharing one's own, adding by reference, moderating.
  setSkillShared: (id, shared) => request('PATCH', `/api/skills/${encodeURIComponent(id)}`, { shared }),
  sharedSkills: () => request('GET', '/api/skills/shared'),
  sharedSkill: (id) => request('GET', `/api/skills/shared/${encodeURIComponent(id)}`),
  addSharedSkill: (id) => request('PUT', `/api/skills/added/${encodeURIComponent(id)}`),
  removeAddedSkill: (id) => request('DELETE', `/api/skills/added/${encodeURIComponent(id)}`),
  hideSharedSkill: (id, hidden) => request('PATCH', `/api/admin/skills/${encodeURIComponent(id)}`, { hidden }),

  // A conversation shared by link, and carrying one on (server/routes/chatShare.js).
  shareChat: (id) => request('POST', `/api/chats/${encodeURIComponent(id)}/share`),
  unshareChat: (id) => request('DELETE', `/api/chats/${encodeURIComponent(id)}/share`),
  forkSharedChat: (token) => request('POST', `/api/shared-chat/${encodeURIComponent(token)}/fork`),
  // A public link to a file the assistant made (server/routes/share.js).
  fileShare: (id) => request('GET', `/api/attachments/${encodeURIComponent(id)}/share`),
  shareFile: (id) => request('POST', `/api/attachments/${encodeURIComponent(id)}/share`),
  unshareFile: (id) => request('DELETE', `/api/attachments/${encodeURIComponent(id)}/share`),

  tasks: () => request('GET', '/api/tasks'),
  // The zone travels with the task: "17:00" means the user's five o'clock, not
  // the server's — and on a deployment the server's is UTC.
  createTask: (task) => request('POST', '/api/tasks', { ...task, tz: localZone() }),
  runDueTasks: () => request('POST', '/api/tasks/run-due'),
  setTaskEnabled: (id, enabled) => request('PATCH', `/api/tasks/${id}`, { enabled }),
  /**
   * Change a task. Only the fields given are written; the browser's zone rides
   * along for a new frequency, and a zone chosen in the side panel wins over it.
   */
  updateTask: (id, patch) => request('PATCH', `/api/tasks/${id}`, { tz: localZone(), ...patch }),
  deleteTask: (id) => request('DELETE', `/api/tasks/${id}`),
  task: (id) => request('GET', `/api/tasks/${id}`),
  /**
   * Run one now, whatever its schedule says.
   *
   * The only way a manual task ever runs, and how anybody checks a scheduled
   * one before waiting until morning for it. Slow by nature — it is a whole
   * agent turn — so callers show that something is happening.
   */
  runTask: (id) => request('POST', `/api/tasks/${id}/run`),

  workflows: () => request('GET', '/api/workflows'),
  workflow: (id) => request('GET', `/api/workflows/${id}`),
  // Same reasoning as createTask: the schedule is written in the user's zone.
  createWorkflow: (wf) => request('POST', '/api/workflows', { ...wf, tz: localZone() }),
  updateWorkflow: (id, patch) => request('PATCH', `/api/workflows/${id}`, { tz: localZone(), ...patch }),
  deleteWorkflow: (id) => request('DELETE', `/api/workflows/${id}`),
  // Held open while steps run — the response is what keeps a serverless instance
  // alive long enough to finish one honestly.
  runWorkflow: (id) => request('POST', `/api/workflows/${id}/run`),
  // The Automations page (server/routes/automations.js): Stop for a run in progress, either kind,
  // and the counts its tabs and the rail's badge show.
  stopWorkflow: (id) => request('POST', `/api/workflows/${encodeURIComponent(id)}/stop`),
  stopTask: (id) => request('POST', `/api/tasks/${encodeURIComponent(id)}/stop`),
  autoSummary: () => request('GET', '/api/automations/summary'),

  // The Bot page (server/routes/bots.js): the team, each bot's and group's chat,
  // memory, a group's round (streamed, `runGroup` below) and usage by bot.
  bots: () => request('GET', '/api/bots'),
  createBot: (bot) => request('POST', '/api/bots', bot),
  updateBot: (id, patch) => request('PATCH', `/api/bots/${encodeURIComponent(id)}`, patch),
  deleteBot: (id) => request('DELETE', `/api/bots/${encodeURIComponent(id)}`),
  // `light`: the id alone, for the Bot page, whose home chat reads the messages itself.
  botChat: (id, { incognito = false, light = false } = {}) =>
    request('GET', `/api/bots/${encodeURIComponent(id)}/chat${incognito ? '?incognito=1' : light ? '?light=1' : ''}`),
  botTasks: (id) => request('GET', `/api/bots/${encodeURIComponent(id)}/tasks`),
  addBotTask: (id, task) => request('POST', `/api/bots/${encodeURIComponent(id)}/tasks`, task),
  /** `kind` is 'bots' or 'bot-groups'. */
  botMemory: (kind, id) => request('GET', `/api/${kind}/${encodeURIComponent(id)}/memory`),
  addBotMemory: (kind, id, text) => request('POST', `/api/${kind}/${encodeURIComponent(id)}/memory`, { text }),
  deleteBotMemory: (kind, id, entry) => request('DELETE', `/api/${kind}/${encodeURIComponent(id)}/memory/${encodeURIComponent(entry)}`),
  /** Edit an entry (`{ text }`) or pin it (`{ pinned }`). */
  editBotMemory: (kind, id, entry, patch) => request('PATCH', `/api/${kind}/${encodeURIComponent(id)}/memory/${encodeURIComponent(entry)}`, patch),
  undoBotMemory: (kind, id, ids) => request('POST', `/api/${kind}/${encodeURIComponent(id)}/memory/undo`, { ids }),
  /** Bring back a version a bot or its review replaced or forgot. */
  restoreBotMemory: (kind, id, entry) => request('POST', `/api/${kind}/${encodeURIComponent(id)}/memory/${encodeURIComponent(entry)}/restore`),
  createGroup: (group) => request('POST', '/api/bot-groups', group),
  updateGroup: (id, patch) => request('PATCH', `/api/bot-groups/${encodeURIComponent(id)}`, patch),
  deleteGroup: (id) => request('DELETE', `/api/bot-groups/${encodeURIComponent(id)}`),
  groupChat: (id) => request('GET', `/api/bot-groups/${encodeURIComponent(id)}/chat`),
  stopGroup: (id) => request('POST', `/api/bot-groups/${encodeURIComponent(id)}/stop`),
  /** What is new in a group after line `since`, who is at work, and whether its round goes on. */
  groupLive: (id, since) => request('GET', `/api/bot-groups/${encodeURIComponent(id)}/live?since=${encodeURIComponent(String(since))}`),
  setGroupModel: (id, model) => request('PATCH', `/api/bot-groups/${encodeURIComponent(id)}/model`, { model }),
  /** Empty a bot's or a group's conversation; memory stays (owner, 2026-11-10). */
  resetBot: (id) => request('POST', `/api/bots/${encodeURIComponent(id)}/reset`),
  resetGroup: (id) => request('POST', `/api/bot-groups/${encodeURIComponent(id)}/reset`),
  botUsage: ({ from, to, unit }) => request('GET', `/api/bots/usage?${new URLSearchParams({ from, to, unit, tz: localZone() })}`),
  // Spec B (2026-11-11): what needs the person, read marks, copies, team files, a question aside.
  botAttention: () => request('GET', '/api/bots/attention'),
  readBot: (id) => request('POST', `/api/bots/${encodeURIComponent(id)}/read`),
  readGroup: (id) => request('POST', `/api/bot-groups/${encodeURIComponent(id)}/read`),
  duplicateBot: (id) => request('POST', `/api/bots/${encodeURIComponent(id)}/duplicate`),
  exportBots: () => request('GET', '/api/bots/export'),
  /** `dry`: say what would be added, and add nothing. */
  importBots: (data, { dry = false } = {}) => request('POST', '/api/bots/import', { data, dry }),
  askAside: (id, question, model) => request('POST', `/api/bots/${encodeURIComponent(id)}/aside`, { question, model }),
  botUsageDetail: (id, { from, to }) => request('GET', `/api/bots/${encodeURIComponent(id)}/usage?${new URLSearchParams({ from, to })}`),
  groupTasks: (id) => request('GET', `/api/bot-groups/${encodeURIComponent(id)}/tasks`),
  addGroupTask: (id, task) => request('POST', `/api/bot-groups/${encodeURIComponent(id)}/tasks`, task),
  // Spec C (2026-11-11): a task's webhook, a bot's waits, Telegram to Chief.
  botTaskHook: (taskId) => request('GET', `/api/bot-tasks/${encodeURIComponent(taskId)}/hook`),
  setBotTaskHookFilters: (taskId, filters) => request('PATCH', `/api/bot-tasks/${encodeURIComponent(taskId)}/hook`, { filters }),
  rotateBotTaskHook: (taskId) => request('POST', `/api/bot-tasks/${encodeURIComponent(taskId)}/hook/rotate`),
  testBotTaskHook: (taskId) => request('POST', `/api/bot-tasks/${encodeURIComponent(taskId)}/hook/test`),
  botWaits: (id) => request('GET', `/api/bots/${encodeURIComponent(id)}/waits`),
  closeBotWait: (id, waitId) => request('DELETE', `/api/bots/${encodeURIComponent(id)}/waits/${encodeURIComponent(waitId)}`),
  telegramInbound: () => request('GET', '/api/telegram/inbound'),
  setTelegramInbound: (enabled) => request('POST', '/api/telegram/inbound', { enabled }),
  setTelegramOthers: (ids) => request('PUT', '/api/telegram/inbound/others', { ids }),

  connectors: () => request('GET', '/api/connectors'),
  // Skills: upload (scan first, keep when asked) and the Create a skill draft (owner, 2026-11-01).
  uploadSkills: (files, { save = false } = {}) => request('POST', '/api/skills/upload', { files, save }),
  skillDraft: () => request('GET', '/api/skills/draft'),
  saveSkillDraft: (draft) => request('PUT', '/api/skills/draft', draft),
  deleteSkillDraft: () => request('DELETE', '/api/skills/draft'),
  // Where MCP servers that are programs run, and the Node and Python there.
  mcpEnvironment: ({ check = false } = {}) => request('GET', `/api/mcp/environment${check ? '?check=1' : ''}`),
  // Settings → Connectors: each connector, Google's products apart, with its tools (owner, 2026-11-01).
  connectorCatalog: () => request('GET', '/api/connectors/catalog'),
  disconnectGoogleProduct: (product) => request('DELETE', `/api/connectors/google/${encodeURIComponent(product)}`),
  // Where each entry of the connector directory stands — for the suggestion cards.
  connectorDirectory: () => request('GET', '/api/connectors/directory'),
  connect: (service, token) => request('POST', `/api/connectors/${service}`, { token }),
  disconnect: (service) => request('DELETE', `/api/connectors/${service}`),
  // The + menu's Google Drive picker: find a file, and attach it to the message.
  driveFiles: (q = '') => request('GET', `/api/connectors/google/drive${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  attachDriveFile: (id) => request('POST', `/api/connectors/google/drive/${encodeURIComponent(id)}/attach`),

  // MCP servers — tools from outside this app. Adding one tries it first, so the
  // answer to "did that work" arrives here rather than mid-task tomorrow.
  mcpCatalogue: (q) => request('GET', '/api/mcp/catalogue' + (q ? '?q=' + encodeURIComponent(q) : '')),
  mcpServers: () => request('GET', '/api/mcp'),
  addMcpServer: (body) => request('POST', '/api/mcp', body),
  setMcpEnabled: (id, enabled) => request('PATCH', `/api/mcp/${id}`, { enabled }),
  removeMcpServer: (id) => request('DELETE', `/api/mcp/${id}`),
  /** Approve a server's changed tools as they now are (server/mcp/registry.js `screenTools`). */
  approveMcpTools: (id) => request('POST', `/api/mcp/${id}/approve-tools`),

  // The browser's zone rides along so the server can tell whether the library
  // is fresh as of six this morning *here* — see refreshIfStale.
  models: (params) => request('GET', `/api/models?${new URLSearchParams(clean({ tz: localZone(), ...params }))}`),
  resolveModel: (id) => request('GET', `/api/models/resolve?id=${encodeURIComponent(id)}`),
  refreshModels: () => request('POST', '/api/models/refresh'),

  updateAccount: (patch) => request('PATCH', '/api/account', patch),
  changePassword: (current, next) => request('POST', '/api/account/password', { current, next }),
  usage: () => request('GET', '/api/account/usage'),

  // Memory, the security record, and the account's data (server/routes/account.js).
  memory: () => request('GET', '/api/memory'),
  /** `extra`: the note's `kind` and an event's `expires` (YYYY-MM-DD, '' for none). */
  saveNote: (scope, key, content, extra = {}) =>
    request('PUT', `/api/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`, { content, ...extra }),
  deleteNote: (scope, key) => request('DELETE', `/api/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`),
  undoNote: (scope, key) => request('POST', `/api/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}/undo`),
  /** Bring back one of a note's earlier versions, by its place in the list (0 is the newest). */
  restoreNote: (scope, key, index) => request('POST', `/api/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}/restore`, { index }),
  purgeNoteHistory: (scope, key) => request('DELETE', `/api/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}/history`),
  /** Accept or reject one of the monthly tidy's suggestions (`answer`: 'accept' | 'reject'). */
  answerTidy: (id, answer) => request('POST', `/api/memory/tidy/${encodeURIComponent(id)}/${answer === 'accept' ? 'accept' : 'reject'}`),
  clearMemory: () => request('DELETE', '/api/memory'),
  importMemory: (text) => request('POST', '/api/memory/import', { text }),
  activity: () => request('GET', '/api/account/activity'),
  adminActivity: () => request('GET', '/api/admin/activity'),
  importConversations: (conversations, memory) =>
    request('POST', '/api/account/import', { conversations, ...(memory?.length ? { memory } : {}) }),
  deleteAccount: (password, code) => request('DELETE', '/api/account', { password, code }),

  disableTwoFactor: (password, code) => request('POST', '/api/account/2fa/disable', { password, code }),

  // Just the worker indicator — polled often, so deliberately cheap.
  workerStatus: () => request('GET', '/api/devices/status'),

  devices: () => request('GET', '/api/devices'),
  pairDevice: (code, name) => request('POST', '/api/devices/pair', { code, name }),
  unpairDevice: (id) => request('DELETE', `/api/devices/${id}`),
  setDeviceWorkspace: (id, path) => request('PUT', `/api/devices/${id}/workspace`, { path }),
  enrolmentLink: () => request('POST', '/api/devices/enrolment'),

  modelNews: () => request('GET', `/api/models/news?tz=${encodeURIComponent(localZone() || '')}`),
  decideModelNews: (id, action) => request('POST', '/api/models/news', { id, action }),
  updateUser: (id, patch) => request('PATCH', `/api/admin/users/${id}`, patch),

  users: () => request('GET', '/api/admin/users'),
  deleteUser: (id) => request('DELETE', `/api/admin/users/${id}`),
  setAdmin: (id, permissions) => request('PUT', `/api/admin/admins/${encodeURIComponent(id)}`, { permissions }),
  removeAdmin: (id) => request('DELETE', `/api/admin/admins/${encodeURIComponent(id)}`),
  handOwnership: (id) => request('POST', `/api/admin/admins/${encodeURIComponent(id)}/owner`),

  /**
   * The zone rides along on the first call of every session.
   *
   * The scheduling routes have always sent it per request, but the *tools* —
   * `schedule_task`, `workflow_write` — run inside an agent turn where there is
   * no request to read it from, and were falling back to the server's clock.
   * Recorded once here, it is available to every path that needs to know what
   * "five in the afternoon" means.
   */
  bootstrap: () => {
    const zone = localZone();
    return request('GET', zone ? `/api/bootstrap?tz=${encodeURIComponent(zone)}` : '/api/bootstrap');
  },
  savePrefs: (patch) => request('PUT', '/api/prefs', patch),
  saveKey: (provider, apiKey) => request('PUT', `/api/providers/${provider}/key`, { apiKey }),
  /** A spare, behind the ones already saved — tried in order when one is refused. */
  addKey: (provider, apiKey) => request('POST', `/api/providers/${provider}/keys`, { apiKey }),
  // A key pasted in Settings → Providers: recognised, checked and kept where it belongs (owner, 2026-11-02).
  intakeKey: (provider, apiKey) => request('POST', '/api/providers/intake', { provider, apiKey }),
  useSuggestion: () => request('POST', '/api/providers/suggestion/use'),
  // The suggested models changed: this account's notice, and its answer (owner, 2026-11-10).
  suggestionNotice: () => request('GET', '/api/models/suggestion/notice'),
  suggestionSeen: (version) => request('POST', '/api/models/suggestion/seen', { version }),
  // The two models an administrator suggests to everyone.
  adminRecommended: () => request('GET', '/api/admin/recommended'),
  setRecommended: (body) => request('PUT', '/api/admin/recommended', body),
  removeKey: (provider, position) => request('DELETE', `/api/providers/${provider}/keys/${position}`),

  chats: () => request('GET', '/api/chats'),
  /** The Archive shelf: conversations and projects put away. */
  archived: () => request('GET', '/api/chats/archived'),
  /** Whether scheduled work runs with the web closed — see the route. */
  heartbeat: () => request('GET', '/api/heartbeat'),
  /** `removed`: the oldest conversations deleted to keep the account to its limit (server/chatLimit.js). */
  createChat: (model, projectId, incognito = false) =>
    request('POST', '/api/chats', { model, projectId, ...(incognito ? { incognito: true } : {}) }),
  /**
   * Throw an incognito conversation away as its owner leaves it. `keepalive`,
   * so the request outlives a tab being closed — that is exactly when it is
   * sent — and nothing is read back, because nobody is left to read it.
   */
  discardChat: (id) => {
    try {
      fetch(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true, headers: { 'X-Language': currentLanguage() } }).catch(() => {});
    } catch {
      /* the sweep removes it within a day regardless */
    }
  },
  // `signal`: pressing another conversation cancels this one's answer (`openChat`).
  chat: (id, options) => request('GET', `/api/chats/${id}`, undefined, options),
  searchChats: (q) => request('GET', `/api/chats/search?q=${encodeURIComponent(q)}`),
  updateChat: (id, patch) => request('PATCH', `/api/chats/${id}`, patch),
  deleteChat: (id) => request('DELETE', `/api/chats/${id}`),
  sendMessage: (id, text, attachments, intent, skills) =>
    request('POST', `/api/chats/${id}/messages`, {
      text,
      attachments,
      ...(intent ? { intent } : {}),
      // Picked in the + menu; the server keeps only real ones (`chosenSkills`).
      ...(skills?.length ? { skills } : {}),
    }),
  /**
   * Tell the server to stop, as well as hanging up on it.
   *
   * Aborting the stream closes the socket, which is usually enough. Usually is
   * not what somebody pressing stop is asking for: behind a proxy that buffers,
   * the close can arrive long after the model has finished answering into a page
   * nobody is watching. This takes the run's lease away, which the invocation
   * doing the work notices on its next heartbeat.
   */
  stopChat: (id) => request('POST', `/api/chats/${id}/stop`),
  uploadAttachment: (file) => request('POST', '/api/attachments', file),
  startDirectUpload: (file) => request('POST', '/api/attachments/direct', file),
  finishDirectUpload: (file) => request('POST', '/api/attachments/direct/finish', file),
  /** A file as something the viewer can draw: a document, sheets, slides, text. */
  filePreview: (id) => request('GET', `/api/attachments/${id}/preview`),
  renderOffice: (id) => request('POST', `/api/attachments/${id}/render`, {}),
  privacyOverview: () => request('GET', '/api/privacy/overview'),
  workbook: (id, { sheet = 1, from = 0, rev = null } = {}) => request('GET', `/api/attachments/${id}/workbook?sheet=${sheet}&from=${from}${rev != null ? `&rev=${rev}` : ''}`),
  /** A copy in the account's own Google Drive; answers with its link. */
  saveToDrive: (id) => request('POST', `/api/attachments/${id}/drive`),
  artifactStorageGet: (id, key) => request('GET', '/api/attachments/' + id + '/storage' + (key == null ? '' : '?key=' + encodeURIComponent(key))),
  artifactStorageSet: (id, key, value) => request('PUT', '/api/attachments/' + id + '/storage', { key, value }),
  artifactStorageDelete: (id, key) => request('DELETE', '/api/attachments/' + id + '/storage' + (key == null ? '' : '?key=' + encodeURIComponent(key))),
  fileVersions: (id) => request('GET', `/api/attachments/${id}/versions`),
  fileVersion: (id, revision) => request('GET', `/api/attachments/${id}/versions/${revision}`),
  restoreFileVersion: (id, revision) => request('POST', `/api/attachments/${id}/versions/${revision}/restore`),
  /** Which application this machine would use — null when it cannot be known. */
  fileOpener: (id) => request('GET', `/api/attachments/${id}/opener`),
  /** `how` is 'open' (hand it to the desktop) or 'folder' (just reveal it). */
  openFileOnMachine: (id, how) => request('POST', `/api/attachments/${id}/open`, { how }),
  chatFiles: (id) => request('GET', `/api/chats/${id}/files`),
  /** Everything the assistant has made on this account, newest first. */
  files: () => request('GET', '/api/files'),
  /** Rewrite one by hand — the same road `update_file` takes. */
  updateFile: (id, content, name) => request('PATCH', `/api/attachments/${id}`, { content, name }),
  deleteFile: (id) => request('DELETE', `/api/attachments/${id}`),

  // Settings → Privacy → Your data: what is shared now, one kind's page, and the
  // deletions only that page offers (owner, 2026-11-01).
  dataSummary: () => request('GET', '/api/data'),
  dataList: (kind, { q = '', shared = false, offset = 0, limit = 20 } = {}) =>
    request('GET', `/api/data/${encodeURIComponent(kind)}?${new URLSearchParams({ q, shared: shared ? '1' : '0', offset: String(offset), limit: String(limit) })}`),
  deleteUpload: (id) => request('DELETE', `/api/data/uploads/${encodeURIComponent(id)}`),
  deleteOwnFeedback: (id) => request('DELETE', `/api/data/feedback/${encodeURIComponent(id)}`),
  forgetFeedbackCopy: (id) => request('DELETE', `/api/data/feedback/${encodeURIComponent(id)}/transcript`),
  // An indexed folder, forgotten with every passage of it (owner, 2026-11-12).
  forgetIndexedFolder: (id) => request('DELETE', `/api/data/docs/${encodeURIComponent(id)}`),

  /* The folder on the machine, through the same worker tools the assistant uses. */
  workspace: (path = '.') => request('GET', `/api/workspace?path=${encodeURIComponent(path)}`),
  workspaceFile: (path) => request('GET', `/api/workspace/file?path=${encodeURIComponent(path)}`),
  saveWorkspaceFile: (path, content) => request('PUT', '/api/workspace/file', { path, content }),
  moveWorkspaceFile: (from, to, overwrite = false) =>
    request('POST', '/api/workspace/move', { from, to, overwrite }),
  searchWorkspace: (q, path = '.') =>
    request('GET', `/api/workspace/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(path)}`),
  deleteWorkspaceFile: (path, recursive = false) =>
    request('DELETE', `/api/workspace/file?path=${encodeURIComponent(path)}${recursive ? '&recursive=1' : ''}`),
  /** Change a message and drop what followed it, ready to ask again from there. */
  editMessage: (chatId, messageId, text) =>
    request('PATCH', `/api/chats/${chatId}/messages/${messageId}`, { text }),
  compactChat: (id) => request('POST', `/api/chats/${id}/compact`),
};

/**
 * Run the agent and dispatch server-sent events to `handlers`.
 *
 * Uses fetch + a stream reader rather than EventSource so the request can be a
 * POST (carrying the model and any approval decision) and can be aborted.
 */
/**
 * Which computer this browser is sitting at.
 *
 * A page cannot know what machine it is running on — but it can ask
 * `127.0.0.1`, and the only thing answering there is a worker on this very
 * machine. Sent with each message so the assistant acts on the computer in
 * front of you rather than whichever of your machines checked in most recently.
 *
 * Asked once per tab and remembered, because the answer cannot change while the
 * page is open. Everything about it is best-effort: no worker, a different port,
 * or a browser that refuses the request all mean the same thing — no hint, and
 * the server falls back to what it did before.
 */
const LOCAL_PORT = 8765;
let localDevice;

export async function localDeviceId() {
  if (localDevice !== undefined) return localDevice;

  // Cached for the tab. `sessionStorage` rather than `localStorage`: it is a
  // fact about this machine, and a laptop's answer must never be restored on a
  // desktop from a synced profile.
  const remembered = sessionStorage.getItem('ai-remote-local-device');
  if (remembered) {
    localDevice = remembered || null;
    return localDevice;
  }

  // Short: this runs before the first message and must never be what somebody
  // waits on. A worker on this machine answers in single-digit milliseconds.
  const stop = AbortSignal.timeout(600);
  try {
    const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/whoami`, {
      signal: stop,
      cache: 'no-store',
    });
    const { deviceId } = await res.json();
    localDevice = deviceId || null;
  } catch {
    localDevice = null;
  }
  if (localDevice) sessionStorage.setItem('ai-remote-local-device', localDevice);
  return localDevice;
}

/**
 * The events of a streamed response, each handed to `onEvent` as it arrives.
 * Shared by the Bot page's two runs (a bot's own chat, a group's round).
 *
 * @param {Response} res @param {(event: string, data: any) => void} onEvent
 */
export async function readEvents(res, onEvent) {
  if (res.status === 401 && signedIn) {
    location.reload();
    throw new Error(t('session.expired'));
  }
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string, status?: number }} */ (new Error(detail.error || t('api.streamFailed', { status: res.status })));
    err.code = detail.code;
    err.status = res.status;
    throw err;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try {
        onEvent(event, JSON.parse(data.join('\n')));
      } catch {
        /* a frame that does not parse is skipped, as the conversation's own reader does */
      }
    }
  }
}

/**
 * Write in a group and follow the round it starts. While another segment holds the
 * group, the line is taken and answered in that round: no stream comes back, and this
 * resolves to `{ joined: true, message }` (owner, 2026-11-10).
 *
 * @returns {Promise<{ joined: boolean, message?: any }>}
 */
export async function runGroup({ groupId, text, runId, model = undefined, signal, onEvent }) {
  const res = await fetch(`/api/bot-groups/${encodeURIComponent(groupId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Language': currentLanguage() },
    // `model`: the header chip's, which every member answers on (owner, 2026-11-10).
    body: JSON.stringify({ text, runId, ...(model ? { model } : {}) }),
    signal,
  });
  if (res.ok && /application\/json/.test(res.headers.get('content-type') || '')) {
    const answer = await res.json();
    return { joined: !!answer.joined, message: answer.message };
  }
  await readEvents(res, onEvent);
  return { joined: false };
}

/** Carry on what a group has waiting — the Continue after the ceiling or a long round — and follow it. */
export async function continueGroup({ groupId, model = undefined, signal, onEvent }) {
  const res = await fetch(`/api/bot-groups/${encodeURIComponent(groupId)}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Language': currentLanguage() },
    body: JSON.stringify({ ...(model ? { model } : {}) }),
    signal,
  });
  await readEvents(res, onEvent);
}

/** Run a bot's own chat, which is an ordinary conversation of this app (server/agent.js reads whose it is). */
export async function runBotChat({ chatId, runId, signal, onEvent, decision = undefined }) {
  const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Language': currentLanguage() },
    // `decision`: the person's Allow or Deny for the calls a step stopped on, with their ids.
    body: JSON.stringify({ runId, ...(decision || {}) }),
    signal,
  });
  await readEvents(res, onEvent);
}

export async function runAgent({ chatId, model, handoff, decision, decisionFor, answers, runId, signal, handlers }) {
  const deviceHint = await localDeviceId().catch(() => null);

  const res = await fetch(`/api/chats/${chatId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Language': currentLanguage() },
    // `runId` stays the same across every reconnect of one run, so resuming a
    // turn the host cut short re-enters its own lock instead of being refused by
    // it. A different tab generates a different id and is still kept out.
    body: JSON.stringify({ model, handoff, decision, decisionFor, answers, runId, deviceHint }),
    signal,
  });

  if (res.status === 401 && signedIn) {
    location.reload();
    throw new Error(t('session.expired'));
  }
  if (!res.ok || !res.body) {
    // The refusal carries a reason — a 409 from the run lock, say — and losing
    // it to a generic "HTTP 409" is how a deliberate answer looks like a bug.
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail.error || t('api.streamFailed', { status: res.status }));
    err.code = detail.code;
    err.status = res.status;
    throw err;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line.
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;

      let payload;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      /**
       * Say it out loud as well as acting on it.
       *
       * One agent loop per conversation is not negotiable — two tabs appending
       * to one transcript shuffles its turns together — so a second tab is
       * refused with a 409. Correct, and from where the person is sitting also a
       * bug: they opened their own conversation on the laptop while the phone
       * was mid-answer and it sat there saying nothing.
       *
       * The tab holding the run narrates it here, at the one place every event
       * already passes through, so nothing else in the loop has to know that
       * anybody is listening.
       */
      narrate(chatId, event, payload);
      handlers[event]?.(payload);
    }
  }
}
