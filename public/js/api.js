/** Thin wrapper over the JSON API, plus the SSE reader for the agent stream. */
import { narrate } from './mirror.js';
import { t, currentLanguage } from './i18n.js';

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    // The language rides on every call, so a message the server writes — an
    // error, a status line — comes back in it. See server/i18n.
    headers: { 'X-Language': currentLanguage(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  // The session cookie is gone or the access code changed. Reloading drops us
  // back to the gate, which is the only useful thing to do here.
  if (res.status === 401) {
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
    const err = new Error(json.error || messageFor(res.status, unparsed));
    // Callers branch on this — e.g. 'totp_required' is a step, not a failure.
    err.code = json.code;
    err.status = res.status;
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
  logout: () => request('POST', '/api/logout'),

  forgotPassword: (email) => request('POST', '/api/password/forgot', { email }),
  resetPassword: (payload) => request('POST', '/api/password/reset', payload),

  /** `hd` asks the worker for a full-size frame — see the viewer's expand button. */
  screen: (hd = false) => request('GET', `/api/screen${hd ? '?hd=1' : ''}`),
  closeScreen: () => request('POST', '/api/screen/close'),
  screenInput: (event) => request('POST', '/api/screen/input', event),

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

  connectors: () => request('GET', '/api/connectors'),
  connect: (service, token) => request('POST', `/api/connectors/${service}`, { token }),
  disconnect: (service) => request('DELETE', `/api/connectors/${service}`),

  // MCP servers — tools from outside this app. Adding one tries it first, so the
  // answer to "did that work" arrives here rather than mid-task tomorrow.
  mcpCatalogue: (q) => request('GET', '/api/mcp/catalogue' + (q ? '?q=' + encodeURIComponent(q) : '')),
  mcpServers: () => request('GET', '/api/mcp'),
  addMcpServer: (body) => request('POST', '/api/mcp', body),
  setMcpEnabled: (id, enabled) => request('PATCH', `/api/mcp/${id}`, { enabled }),
  removeMcpServer: (id) => request('DELETE', `/api/mcp/${id}`),

  // The browser's zone rides along so the server can tell whether the library
  // is fresh as of six this morning *here* — see refreshIfStale.
  models: (params) => request('GET', `/api/models?${new URLSearchParams(clean({ tz: localZone(), ...params }))}`),
  resolveModel: (id) => request('GET', `/api/models/resolve?id=${encodeURIComponent(id)}`),
  refreshModels: () => request('POST', '/api/models/refresh'),

  updateAccount: (patch) => request('PATCH', '/api/account', patch),
  changePassword: (current, next) => request('POST', '/api/account/password', { current, next }),
  usage: () => request('GET', '/api/account/usage'),

  startTwoFactor: () => request('POST', '/api/account/2fa/setup'),
  confirmTwoFactor: (code) => request('POST', '/api/account/2fa/confirm', { code }),
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
  removeKey: (provider, position) => request('DELETE', `/api/providers/${provider}/keys/${position}`),

  chats: () => request('GET', '/api/chats'),
  createChat: (model, projectId) => request('POST', '/api/chats', { model, projectId }),
  chat: (id) => request('GET', `/api/chats/${id}`),
  searchChats: (q) => request('GET', `/api/chats/search?q=${encodeURIComponent(q)}`),
  updateChat: (id, patch) => request('PATCH', `/api/chats/${id}`, patch),
  deleteChat: (id) => request('DELETE', `/api/chats/${id}`),
  sendMessage: (id, text, attachments, intent) =>
    request('POST', `/api/chats/${id}/messages`, { text, attachments, ...(intent ? { intent } : {}) }),
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
  /** A file as something the viewer can draw: a document, sheets, slides, text. */
  filePreview: (id) => request('GET', `/api/attachments/${id}/preview`),
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

export async function runAgent({ chatId, model, decision, decisionFor, answers, runId, signal, handlers }) {
  const deviceHint = await localDeviceId().catch(() => null);

  const res = await fetch(`/api/chats/${chatId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Language': currentLanguage() },
    // `runId` stays the same across every reconnect of one run, so resuming a
    // turn the host cut short re-enters its own lock instead of being refused by
    // it. A different tab generates a different id and is still kept out.
    body: JSON.stringify({ model, decision, decisionFor, answers, runId, deviceHint }),
    signal,
  });

  if (res.status === 401) {
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
