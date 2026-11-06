import { holdingsOf } from '../themes.js';
import crypto from 'node:crypto';
import { isOwner, requirePermission } from '../adminRoles.js';
import { getStore } from '../store/index.js';
import { getPrefs } from '../settings.js';
import { confirmIdentity, clearSession } from '../auth.js';
import { limit as rateLimit } from '../ratelimit.js';
import { redactSecrets } from '../redact.js';
import { audit } from '../audit.js';
import { policyTable } from '../dataRoute.js';
import { forgetMachine } from '../sandbox.js';
import { MEASURED } from '../deidentifyQuality.js';
import { log } from '../util/trace.js';
import { MEMORY_KEY, projectMemoryKey, noteName, MAX_NOTE_CHARS, memoryRefusal, refusalMessage, stampNote } from '../memory.js';
import { normaliseImport, IMPORT_LIMITS } from '../../public/js/import-formats.js';
import { clientError } from '../util/clientError.js';

/**
 * The account's own data: what is remembered, what happened, and the right to
 * take all of it away — export, import, delete.
 *
 * Everything here is scoped by `req.user.id` in the store call itself, the same
 * rule as every other route: an id that arrives in a URL is something a person
 * can type, and is checked against this account before it is used.
 *
 * @param {import('express').Router} api    the authenticated router
 * @param {import('express').Router} admin  the administrators' router
 */
export function mountAccountRoutes(api, admin, { wrap }) {
  // ── memory ──────────────────────────────────────────────────────────
  /**
   * Every note on the account — its own and each project's — for Settings →
   * Memory. The project's name travels with its notes so the page can say where
   * each one applies; a project since deleted is named as such rather than
   * hidden, because its notes are still there until somebody removes them.
   */
  api.get(
    '/memory',
    wrap(async (req, res) => {
      const store = getStore();
      const [buckets, projects, archived] = await Promise.all([
        store.listMemoryBuckets(req.user.id),
        store.listProjects(req.user.id),
        store.listProjects(req.user.id, { archived: true }),
      ]);
      const names = new Map([...projects, ...archived].map((p) => [p.id, p.name]));
      const groups = buckets
        .map(({ key, value }) => {
          const projectId = key === MEMORY_KEY ? null : key.slice(MEMORY_KEY.length + 1);
          const notes = Object.entries(value || {})
            .filter(([, note]) => note && typeof note.content === 'string')
            .map(([name, note]) => ({
              key: name,
              content: note.content,
              updatedAt: note.updatedAt || null,
              // Where it came from, and whether there is a change to take back (HAR-002).
              by: note.by || null,
              chatId: note.chatId || null,
              canUndo: typeof note.previous?.content === 'string',
            }))
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
          return {
            scope: projectId ? 'project' : 'account',
            projectId,
            projectName: projectId ? names.get(projectId) || null : null,
            notes,
          };
        })
        .filter((group) => group.notes.length)
        .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'account' ? -1 : 1));
      res.json({ groups });
    }),
  );

  /** The set of notes a URL names, checked against this account. */
  async function bucketFor(req) {
    const where = String(req.params.scope || '');
    if (where === 'account') return MEMORY_KEY;
    const project = await getStore().getProject(req.user.id, where);
    if (project) return projectMemoryKey(project.id);
    // A project that has gone still has notes until they are removed; allow
    // reaching them only when the bucket actually exists on this account.
    const buckets = await getStore().listMemoryBuckets(req.user.id);
    return buckets.some((b) => b.key === projectMemoryKey(where)) ? projectMemoryKey(where) : null;
  }

  /**
   * Correct a note by hand. The person may write what they like about
   * themselves — the guard on sensitive topics is about what the *assistant*
   * decides to keep — but credentials are still taken out, and identifiers are
   * still refused, because the note is still sent to a provider on every turn.
   */
  api.put(
    '/memory/:scope/:key',
    wrap(async (req, res) => {
      const bucket = await bucketFor(req);
      if (!bucket) return res.status(404).json({ error: 'No such project.' });
      let key;
      try {
        key = noteName(req.params.key);
      } catch (err) {
        return res.status(400).json({ error: clientError(err) });
      }
      const { text } = redactSecrets(String(req.body?.content ?? ''));
      if (!text.trim()) return res.status(400).json({ error: 'A note cannot be empty. Delete it instead.' });
      if (text.length > MAX_NOTE_CHARS) {
        return res.status(400).json({ error: `A note can be at most ${MAX_NOTE_CHARS} characters.` });
      }
      const refusal = memoryRefusal(text, { allowSensitive: true });
      if (refusal) return res.status(400).json({ error: refusalMessage(refusal) });
      // A person's own edit keeps no earlier version (PRV-006). What it keeps is
      // the "from Google" mark (PRV-025): an edited note made from someone's mail
      // is still made from it, and without the mark it went to every provider.
      const notes = (await getStore().getUserSetting(req.user.id, bucket)) || {};
      const google = Object.hasOwn(notes, key) && notes[key]?.google === true;
      await getStore().mergeUserSetting(req.user.id, bucket, { [key]: stampNote(text, { by: 'user', google }) });
      res.json({ ok: true });
    }),
  );

  /**
   * Take back the last change to a note (HAR-002): the version it replaced
   * becomes the note again. One step only, and the undone text is not kept —
   * undoing is the person deciding that change should not have happened.
   */
  api.post(
    '/memory/:scope/:key/undo',
    wrap(async (req, res) => {
      const bucket = await bucketFor(req);
      if (!bucket) return res.status(404).json({ error: 'No such project.' });
      const notes = (await getStore().getUserSetting(req.user.id, bucket)) || {};
      const note = Object.hasOwn(notes, req.params.key) ? notes[req.params.key] : null;
      if (!note) return res.status(404).json({ error: 'No such note.' });
      const previous = note.previous;
      if (typeof previous?.content !== 'string') return res.status(400).json({ error: 'There is no earlier version of this note.' });
      await getStore().mergeUserSetting(req.user.id, bucket, {
        [req.params.key]: {
          content: previous.content,
          updatedAt: new Date().toISOString(),
          ...(previous.by ? { by: previous.by } : {}),
          ...(previous.chatId ? { chatId: previous.chatId } : {}),
          ...(previous.google ? { google: true } : {}),
        },
      });
      res.json({ ok: true });
    }),
  );

  api.delete(
    '/memory/:scope/:key',
    wrap(async (req, res) => {
      const bucket = await bucketFor(req);
      if (!bucket) return res.status(404).json({ error: 'No such project.' });
      const notes = (await getStore().getUserSetting(req.user.id, bucket)) || {};
      if (!Object.hasOwn(notes, req.params.key)) return res.status(404).json({ error: 'No such note.' });
      await getStore().removeMemoryNote(req.user.id, bucket, req.params.key);
      res.json({ ok: true });
    }),
  );

  /** Forget everything — every note, everywhere. Asked twice in the browser first. */
  api.delete(
    '/memory',
    wrap(async (req, res) => {
      const removed = await getStore().deleteAllMemory(req.user.id);
      await audit(req, req.user.id, 'memory_cleared', { sets: removed });
      res.json({ ok: true, removed });
    }),
  );

  /**
   * Notes brought in as text — what Claude or ChatGPT says when asked to write
   * out what it remembers. Kept as one account note, appended to if it is there,
   * because splitting somebody else's summary into guessed topics would be
   * inventing structure that was never in it.
   */
  api.post(
    '/memory/import',
    wrap(async (req, res) => {
      const { text } = redactSecrets(String(req.body?.text ?? ''));
      const clean = text.replace(/\r\n/g, '\n').trim();
      if (!clean) return res.status(400).json({ error: 'Paste the text to import.' });
      const prefs = await getPrefs(req.user.id);
      const refusal = memoryRefusal(clean, { allowSensitive: prefs.memorySensitive === true });
      if (refusal) return res.status(400).json({ error: refusalMessage(refusal) });
      const store = getStore();
      const notes = (await store.getUserSetting(req.user.id, MEMORY_KEY)) || {};
      const existing = notes['imported-memory']?.content || '';
      const content = existing ? `${existing}\n\n${clean}` : clean;
      if (content.length > MAX_NOTE_CHARS) {
        return res.status(400).json({ error: `A note can be at most ${MAX_NOTE_CHARS} characters.` });
      }
      await store.mergeUserSetting(req.user.id, MEMORY_KEY, {
        'imported-memory': stampNote(content, { by: 'import', before: notes['imported-memory'] || null }),
      });
      await audit(req, req.user.id, 'data_imported', { notes: 1 });
      res.json({ ok: true });
    }),
  );

  // ── the security record ─────────────────────────────────────────────
  // What the Settings page says about masking and providers: the same to everybody, and held to the facts by tests.
  api.get(
    '/privacy/overview',
    wrap(async (_req, res) => {
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.json({ ...policyTable(), masking: MEASURED });
    }),
  );

  api.get(
    '/account/activity',
    wrap(async (req, res) => {
      res.json({ events: await getStore().listAudit(req.user.id, 60) });
    }),
  );

  admin.get(
    '/activity',
    requirePermission('activity'),
    wrap(async (req, res) => {
      res.json({ events: await getStore().listAuditAll(200) });
    }),
  );

  // ── devices: where the account is signed in (owner, 2026-10-31) ──────
  /**
   * Each sign-in still able to sign a request in — this password's, not
   * expired, not signed out — with the one this request came from marked.
   * What is shown is what the security record keeps: the browser by family and
   * the network, never an address or a place.
   */
  api.get(
    '/account/sessions',
    wrap(async (req, res) => {
      const rows = await getStore().listSessions(req.user.id, req.user.session_epoch);
      res.json({
        sessions: rows.map((s) => ({
          id: s.id,
          agent: s.agent || null,
          network: s.network || null,
          createdAt: s.created_at,
          current: s.id === req.sessionId,
        })),
      });
    }),
  );

  /**
   * Sign one device out. Its cookie stops on its next request. Signing out the
   * device this request came from is signing out here, so its cookie goes too.
   * Scoped by account in the store: another account's id is simply not found.
   */
  api.delete(
    '/account/sessions/:id',
    wrap(async (req, res) => {
      const id = String(req.params.id || '').slice(0, 80);
      if (!(await getStore().revokeSession(req.user.id, id))) return res.status(404).json({ error: 'No such device is signed in.' });
      await audit(req, req.user.id, 'session_revoked', { current: id === req.sessionId });
      if (id === req.sessionId) clearSession(res);
      res.json({ ok: true, signedOutHere: id === req.sessionId });
    }),
  );

  // ── export ──────────────────────────────────────────────────────────
  /**
   * Everything this account holds, as one JSON file, streamed.
   *
   * Streamed because it can be large — a hundred conversations with their tool
   * results, a project's whole shelf of source text — and a hosted function
   * buffers a non-streamed reply into one payload with a ceiling. Written a
   * conversation at a time, so memory is one conversation, not the account.
   *
   * What is left out, deliberately: API keys and connector tokens (secrets are
   * not data the person needs back, and a file of them is a liability); the
   * bytes of uploaded files (named, not embedded — they are downloadable one by
   * one, and base64 would multiply the file); and incognito conversations,
   * which are not part of the record at all.
   *
   * Rate-limited, because it reads the whole account.
   */
  api.get(
    '/account/export',
    rateLimit('export', (req) => req.user?.id),
    wrap(async (req, res) => {
      const store = getStore();
      const userId = req.user.id;
      const [prefs, buckets, skills, active, archived, tasks, workflows, feedback, skillDraft, artifactData, research, mcpServers, holdings] = await Promise.all([
        getPrefs(userId),
        store.listMemoryBuckets(userId),
        store.listSkills(userId),
        store.listProjects(userId),
        store.listProjects(userId, { archived: true }),
        store.listTasks(userId),
        store.listWorkflows(userId),
        store.exportFeedback(userId),
        store.getUserSetting(userId, 'skillDraft'),
        // What an artifact's page saved with window.storage (artifactStorage.js), by artifact (PRV-028).
        store.getUserSetting(userId, 'artifactStorage'),
        store.exportResearchRuns(userId),
        store.listMcpServers(userId),
        holdingsOf(userId, store),
      ]);

      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="synapsez-export-${stamp}.json"`);
      res.setHeader('Cache-Control', 'no-store');

      /*
       * Written with backpressure: a large account streamed faster than the
       * network takes it would otherwise pile up in this function's memory.
       * A visitor who goes away ends the wait as well as the work.
       */
      const write = async (chunk) => {
        if (res.destroyed) throw Object.assign(new Error('the download was cancelled'), { cancelled: true });
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
        }
      };
      const projects = [...active, ...archived];
      const memory = [];
      for (const { key, value } of buckets) {
        const projectId = key === MEMORY_KEY ? null : key.slice(MEMORY_KEY.length + 1);
        for (const [name, note] of Object.entries(value || {})) {
          memory.push({
            scope: projectId ? 'project' : 'account',
            projectId,
            key: name,
            content: String(note?.content ?? ''),
            updatedAt: note?.updatedAt || null,
            // Everything the account holds about a note, the earlier version an
            // assistant change left included (PRV-006): an export that leaves
            // out stored text is not the whole of what is kept.
            by: note?.by || null,
            chatId: note?.chatId || null,
            ...(note?.google === true ? { google: true } : {}),
            ...(typeof note?.previous?.content === 'string'
              ? {
                  previous: {
                    content: note.previous.content,
                    updatedAt: note.previous.updatedAt || null,
                    by: note.previous.by || null,
                    chatId: note.previous.chatId || null,
                  },
                }
              : {}),
          });
        }
      }

      let count = 0;
      try {
        count = await writeExport(write, { store, userId, user: req.user, prefs, memory, skills, tasks, workflows, projects, feedback, skillDraft, artifactData, research, mcpServers, holdings });
      } catch (err) {
        /*
         * Half a JSON file that downloads as "complete" is worse than a failed
         * download: it looks like a backup and will not open. Destroying the
         * response makes the browser say the download failed.
         */
        if (!err?.cancelled) log.error('export failed part way', err);
        res.destroy();
        return;
      }
      res.end();
      await audit(req, userId, 'data_exported', { chats: count, projects: projects.length, notes: memory.length });
    }),
  );

  // ── import ──────────────────────────────────────────────────────────
  /**
   * One batch of conversations from an export — this app's, Claude's or
   * ChatGPT's. The browser reads the file and sends it in batches small enough
   * for a hosted function's body limit; each batch is normalised again here,
   * because the browser is not a place to trust. Each conversation arrives as
   * a new conversation of this account's, with its original times; nothing
   * existing is touched.
   */
  api.post(
    '/account/import',
    rateLimit('import', (req) => req.user?.id),
    wrap(async (req, res) => {
      const incoming = Array.isArray(req.body?.conversations) ? req.body.conversations : [];
      const hasNotes = Array.isArray(req.body?.memory) && req.body.memory.length > 0;
      if (!incoming.length && !hasNotes) {
        return res.status(400).json({ error: 'Nothing to import was sent.' });
      }
      if (incoming.length > 50) return res.status(400).json({ error: 'Send at most 50 conversations at a time.' });

      // The same reader the browser used, over the same shape it produced.
      const { conversations } = incoming.length
        ? normaliseImport({ format: 'synapsez-export', chats: incoming })
        : { conversations: [] };
      const store = getStore();
      let imported = 0;
      let messages = 0;
      for (const c of conversations) {
        const list = c.messages.slice(0, IMPORT_LIMITS.messagesPerConversation).map((m) => ({
          id: crypto.randomUUID(),
          role: m.role,
          text: m.text,
          createdAt: m.createdAt,
        }));
        try {
          await store.importChat(
            req.user.id,
            { id: crypto.randomUUID(), title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt },
            list,
          );
          imported += 1;
          messages += list.length;
        } catch (err) {
          log.error('import: a conversation could not be stored', err);
        }
      }

      // Notes from a Synapsez export travel only in the batch that says so.
      let notes = 0;
      if (Array.isArray(req.body?.memory) && req.body.memory.length) {
        const prefs = await getPrefs(req.user.id);
        const patch = {};
        for (const n of req.body.memory.slice(0, 500)) {
          try {
            const key = noteName(n?.key);
            const { text } = redactSecrets(String(n?.content ?? ''));
            if (!text.trim() || text.length > MAX_NOTE_CHARS) continue;
            if (memoryRefusal(text, { allowSensitive: prefs.memorySensitive === true })) continue;
            patch[key] = stampNote(text, { by: 'import' });
            notes += 1;
          } catch {
            /* an unusable note name: skipped, the rest still come in */
          }
        }
        if (notes) await store.mergeUserSetting(req.user.id, MEMORY_KEY, patch);
      }

      await audit(req, req.user.id, 'data_imported', { chats: imported, messages, notes });
      res.json({ imported, messages, notes, skipped: incoming.length - imported });
    }),
  );

  // ── leaving ─────────────────────────────────────────────────────────
  /**
   * Delete the account and everything in it. The password, and the live code
   * when two-factor is on — a session is what a borrowed laptop has. Every
   * table cascades from the user row, so one statement removes conversations,
   * files, notes, keys, projects, tasks and the security record together.
   *
   * The last administrator of a deployment that has other people on it cannot
   * leave without handing over first: nobody would be left able to manage it.
   */
  api.delete(
    '/account',
    rateLimit('delete-account', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        await confirmIdentity(req.user, { password: req.body?.password, code: req.body?.code });
      } catch (err) {
        return res.status(400).json({ error: clientError(err) });
      }
      const store = getStore();
      if (req.user.role === 'admin') {
        const users = await store.listUsers();
        const admins = users.filter((u) => u.role === 'admin' && !u.suspended_at);
        // The owner chooses who comes next: left to chance, somebody made an
        // administrator to read the feedback would inherit the machine.
        if (users.length > 1 && admins.length > 1 && isOwner(req.user)) {
          return res.status(400).json({
            error: 'You own this deployment. Hand it to another administrator in Settings → People before deleting your account.',
          });
        }
        if (users.length > 1 && admins.length <= 1) {
          return res.status(400).json({
            error: 'You are the only administrator. Make someone else an administrator in Settings → People before deleting your account.',
          });
        }
      }
      log.info('account deleted by its owner');
      await forgetMachine(req.user.id);
      await store.deleteUser(req.user.id);
      clearSession(res);
      res.json({ ok: true });
    }),
  );
}

/** A parameter or flag named for what it holds: a key, token, secret, password or credential. */
const SECRET_NAME = /key|token|secret|passw(or)?d|auth|credential|signature|\bsig\b/i;

/** An MCP server's address with its secrets blanked: a password in it, and any query value so named (PRV-031). */
export function urlWithoutSecrets(raw) {
  let text = raw;
  try {
    const url = new URL(raw);
    // Whatever sits before the @ is a credential, a token used as the user name included (PRV-033).
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const name of [...url.searchParams.keys()]) if (SECRET_NAME.test(name)) url.searchParams.set(name, '[redacted]');
    // A fragment written as parameters (`#access_token=…`) is read the same way (PRV-033).
    if (url.hash.includes('=')) {
      const hash = new URLSearchParams(url.hash.slice(1));
      for (const name of [...hash.keys()]) if (SECRET_NAME.test(name)) hash.set(name, '[redacted]');
      url.hash = hash.toString();
    }
    text = url.toString();
  } catch {
    // Not an address after all: the known shapes below are still blanked.
  }
  return redactSecrets(text).text;
}

/** A header written `Name: value`, with the value blanked when the name says it is a secret. */
const headerWithoutSecret = (text) => {
  const header = /^([\w-]+):\s*\S/.exec(text);
  return header && SECRET_NAME.test(header[1]) ? `${header[1]}: [redacted]` : null;
};

/**
 * One argument's value, or a `--flag=`'s, with its secrets blanked: an address
 * read as the server's own address is (mcp-remote takes it as an argument,
 * PRV-034), a `Name: value` header named for a secret (PRV-033), and any known
 * key shape.
 */
const valueWithoutSecrets = (text) =>
  /^[a-z][\w+.-]*:\/\//i.test(text) ? urlWithoutSecrets(text) : (headerWithoutSecret(text) ?? redactSecrets(text).text);

/**
 * A server's arguments with secrets blanked, in this order (PRV-035): the
 * value after a flag named for a secret (`--token …`), whatever it is unless
 * it starts with `-` (read as the next flag) — an address included, whose
 * secret may sit in its path; then a `--flag=value`,
 * blanked whole when the flag is so named and read as a value otherwise
 * (`--url=…`, `--header=…`); then the argument on its own.
 */
export function argsWithoutSecrets(args) {
  return args.map((arg, i) => {
    const text = String(arg);
    const before = i > 0 ? String(args[i - 1]) : '';
    if (/^--?[\w.-]+$/.test(before) && SECRET_NAME.test(before) && !text.startsWith('-')) return '[redacted]';
    const flag = /^(--?[\w.-]+)=(.*)$/.exec(text);
    if (flag) return SECRET_NAME.test(flag[1]) ? `${flag[1]}=[redacted]` : `${flag[1]}=${valueWithoutSecrets(flag[2])}`;
    return valueWithoutSecrets(text);
  });
}

/**
 * The export's body, a piece at a time through `write` — see the route.
 *
 * @returns how many conversations went into it
 */
async function writeExport(write, { store, userId, user, prefs, memory, skills, tasks, workflows, projects, feedback = [], skillDraft = null, artifactData = null, research = [], mcpServers = [], holdings = { themes: [], titles: [] } }) {
  // The username, a skill's files, the feedback sent (PRV-014), the skill draft
  // kept on the account (PRV-027), what artifacts' pages saved (PRV-028), the
  // deep-research runs and the MCP servers added (PRV-029) are held too, so they
  // are in it — a server's headers and environment, which hold its secrets, are
  // not. Left out, and said so in the README: usage figures, sign-in sessions and
  // the account's activity log, each shown in Settings, and keys and tokens.
  await write(
    `{"format":"synapsez-export","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},` +
      `"account":${JSON.stringify({ name: user.name, username: user.username ?? null, email: user.email, createdAt: user.created_at })},` +
      `"prefs":${JSON.stringify(prefs)},` +
      `"memory":${JSON.stringify(memory)},` +
      `"skills":${JSON.stringify(skills.map((s) => ({ name: s.name, description: s.description, instructions: s.instructions, enabled: s.enabled, files: Array.isArray(s.files) ? s.files : [] })))},` +
      `"skillDraft":${JSON.stringify(skillDraft || null)},` +
      `"artifactData":${JSON.stringify(artifactData || {})},` +
      // The themes and titles the account holds, and since when (server/themes.js).
      `"themes":${JSON.stringify(holdings.themes.map((t) => ({ id: t.theme_id, why: t.grant_kind, month: t.grant_month, year: t.grant_year, since: t.granted_at })))},` +
      `"titles":${JSON.stringify(holdings.titles.map((t) => ({ id: t.title_id, since: t.earned_at })))},` +
      `"research":${JSON.stringify(research.map((r) => ({ chatId: r.chat_id, question: r.question, status: r.status, transcript: r.transcript, sources: r.sources, report: r.report, createdAt: r.created_at, completedAt: r.completed_at })))},` +
      `"mcpServers":${JSON.stringify(
        mcpServers.map((s) => ({
          name: s.name,
          transport: s.config?.transport ?? null,
          command: s.config?.command ?? null,
          // An address or an argument can carry a token: a known key shape, or any
          // value named as a key, token, secret or password (PRV-031) is blanked.
          args: argsWithoutSecrets(Array.isArray(s.config?.args) ? s.config.args : []),
          url: s.config?.url ? urlWithoutSecrets(String(s.config.url)) : null,
          enabled: s.enabled,
          createdAt: s.created_at,
        })),
      )},` +
      `"scheduledTasks":${JSON.stringify(tasks.map((t) => ({ title: t.title, prompt: t.prompt, cron: t.cron, timezone: t.tz, enabled: t.enabled, projectId: t.project_id })))},` +
      `"workflows":${JSON.stringify(workflows.map((w) => ({ title: w.title, steps: w.steps, cron: w.cron, enabled: w.enabled })))},` +
      `"feedback":${JSON.stringify(
        feedback.map((f) => ({
          topic: f.topic_other || f.topic,
          kind: f.kind,
          issue: f.issue ?? null,
          body: f.body,
          affect: f.affect,
          frequency: f.frequency,
          workedBefore: f.worked_before,
          chatTitle: f.chat_title,
          transcript: f.transcript ?? null,
          answer: f.answer ?? null,
          client: f.client || {},
          createdAt: f.created_at,
        })),
      )},` +
      '"projects":[',
  );
  for (const [i, project] of projects.entries()) {
    const files = await store.readProjectFiles(userId, project.id, 500);
    await write(
      `${i ? ',' : ''}${JSON.stringify({
        id: project.id,
        name: project.name,
        instructions: project.instructions,
        grounded: project.grounded,
        archived: !!project.archived_at,
        createdAt: project.created_at,
        sources: files.map((f) => ({ name: f.name, kind: f.kind, pages: f.pages, text: f.text })),
      })}`,
    );
  }
  await write('],"chats":[');

  let count = 0;
  let after = null;
  for (;;) {
    const page = await store.exportChats(userId, { after, limit: 50 });
    if (!page.length) break;
    for (const chat of page) {
      const messages = await store.listMessages(userId, chat.id);
      await write(
        `${count ? ',' : ''}${JSON.stringify({
          title: chat.title,
          created_at: chat.created_at,
          updated_at: chat.updated_at,
          pinned: chat.pinned,
          archived: !!chat.archived_at,
          projectId: chat.project_id,
          group: chat.chat_group,
          messages: messages.map(exportMessage),
        })}`,
      );
      count += 1;
    }
    const last = page[page.length - 1];
    // The database's own text for the time, microseconds and all: a JS Date
    // keeps milliseconds, and a cursor rounded down repeats a row.
    after = { createdAt: last.cursor_at, id: last.id };
    if (page.length < 50) break;
  }
  await write(']}');
  return count;
}

/**
 * One message as the export writes it: what was said, what was attached, which
 * tools ran and what they returned — bounded, because a tool result can be a
 * whole web page and the export is for reading, not for replaying a fetch.
 */
export function exportMessage(m) {
  const out = { role: m.role, created_at: m.createdAt || null };
  if (typeof m.text === 'string' && m.text) out.text = m.text;
  if (Array.isArray(m.attachments) && m.attachments.length) {
    out.attachments = m.attachments.map((a) => ({ name: a?.name || null, kind: a?.kind || null }));
  }
  if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
    out.toolCalls = m.toolCalls.map((c) => ({ name: c?.name, input: c?.input ?? null }));
  }
  if (Array.isArray(m.results) && m.results.length) {
    out.results = m.results.map((r) => ({
      name: r?.name,
      isError: !!r?.isError,
      content: String(r?.content ?? '').slice(0, 20_000),
    }));
  }
  if (m.role === 'summary' && typeof m.text === 'string') out.summary = true;
  return out;
}
