import crypto from 'node:crypto';
import { riskReason } from '../tools/definitions.js';
import { resolveForUser } from '../autoPick.js';
import { getStore } from '../store/index.js';
import { verifyOwned } from '../attachments.js';
import { deriveTitle, needsApproval as pendingApproval } from '../agent.js';
import { normaliseQuestions, askLayout } from '../tools/askOptions.js';
import { compact as compactChat, measure as measureContext } from '../compact.js';

/** The share of the window a conversation must use before it can be folded by hand. */
export const MIN_MANUAL_COMPACT = 0.25;
import { getPrefs } from '../settings.js';
import { languageOf, translateMessage } from '../i18n/index.js';

/**
 * Lifted out of server/app.js — see the note on mountWorkspaceRoutes for why.
 *
 * The routes are unchanged: same handlers, same paths, same order. Only their
 * address in the tree moved.
 *
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function, body: Function, isRunning: Function }} ctx
 */
export function mountChatRoutes(api, { wrap, body, isRunning }) {
  // ── chats ───────────────────────────────────────────────────────────
  api.get(
    '/chats',
    wrap(async (req, res) => {
      const store = getStore();
      /**
       * The sidebar's whole picture in one request.
       *
       * It lists a project's conversations under the project rather than mixed
       * into one flat list, so it needs the projects as well — and the groups,
       * which are only the distinct names in use. Three round trips for one
       * list that is fetched on every load, and on a poll while anything runs,
       * is the kind of cost that is invisible until the bill.
       */
      /**
       * Sequential, deliberately.
       *
       * `Promise.all` reads as the obvious thing and is wrong here: the local
       * store is PGlite, which is one connection, and three statements issued
       * at once against it come back as `could not open file`. The saving it
       * would buy is not the database's time anyway — it is the HTTP hop to a
       * hosted Postgres, and that is already paid once for the whole request
       * rather than once per query.
       */
      const chats = await store.listChats(req.user.id);
      const projects = await store.listProjects(req.user.id);
      const groups = await store.listChatGroups(req.user.id);
      res.json({
        chats,
        // Only what a sidebar heading needs. The shelf has its own route for
        // the rest, and sending file counts and instructions here would be
        // paying for them on every poll.
        projects: projects.map((p) => ({ id: p.id, name: p.name, pinned: p.pinned })),
        groups,
      });
    }),
  );

  /**
   * The Archive shelf: conversations and projects put away, in one request.
   * Registered before `/chats/:id` so "archived" is never read as an id.
   */
  api.get(
    '/chats/archived',
    wrap(async (req, res) => {
      const store = getStore();
      const chats = await store.listArchivedChats(req.user.id);
      const projects = await store.listProjects(req.user.id, { archived: true });
      res.json({
        chats,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          archived_at: p.archived_at,
          updated_at: p.updated_at,
          file_count: p.file_count,
          chat_count: p.chat_count,
        })),
      });
    }),
  );

  api.post(
    '/chats',
    wrap(async (req, res) => {
      const prefs = await getPrefs(req.user.id);
      const store = getStore();

      // A conversation may only be filed under a project of your own — the id
      // comes from a browser, and an id is a thing somebody can type.
      const projectId = req.body?.projectId ? String(req.body.projectId) : null;
      if (projectId && !(await store.getProject(req.user.id, projectId))) {
        return res.status(404).json({ error: 'No such project.' });
      }
      // An incognito conversation remembers nothing, and a project is a place
      // that remembers — its notes, its sources, its history. The pair is a
      // contradiction, so it is refused rather than half-honoured.
      const incognito = req.body?.incognito === true;
      if (incognito && projectId) {
        return res.status(400).json({ error: 'An incognito conversation cannot be part of a project.' });
      }

      const chat = await store.createChat(req.user.id, {
        id: crypto.randomUUID(),
        title: String(req.body?.title || 'New chat').slice(0, 200),
        model: req.body?.model || prefs.defaultModel,
        projectId,
        incognito,
      });
      res.status(201).json({ chat });
    }),
  );

  // Declared before `/chats/:id`, or Express reads "search" as a chat id.
  api.get(
    '/chats/search',
    wrap(async (req, res) => {
      const query = String(req.query.q || '').trim();
      if (query.length < 2) return res.json({ chats: [] });
      res.json({ chats: await getStore().searchChats(req.user.id, query) });
    }),
  );

  api.get(
    '/chats/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });

      const messages = await store.listMessages(req.user.id, req.params.id);

      /**
       * Whether reopening this conversation should show the approval bar.
       *
       * The browser used to decide this on its own and got it wrong: it marked
       * every trailing tool call as needing a yes, including under policies
       * where the server would never have asked. The risk rules live on the
       * server, so the answer does too.
       */
      const last = messages[messages.length - 1];
      let pending = null;
      /**
       * A turn paused on a question, drawn again on the way back in.
       *
       * The card was only ever sent when a run started, so a reload or a visit
       * to another conversation left the turn waiting on a form nobody could see.
       * Asked before approval, as the loop does.
       */
      let question = null;
      const asking = last?.role === 'assistant' ? last.toolCalls?.find((c) => c.name === 'ask_options') : null;
      if (asking) {
        try {
          const questions = normaliseQuestions(asking.input);
          question = { toolCallId: asking.id, questions, ...askLayout(asking.input, questions) };
        } catch {
          /* malformed: the resume path reports it when the turn goes on */
        }
      }
      if (!question && last?.role === 'assistant' && last.toolCalls?.length) {
        const prefs = await getPrefs(req.user.id);
        const gated = pendingApproval(last.toolCalls, prefs.toolPolicy);
        if (gated.length) {
          pending = last.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            input: c.input,
            needsApproval: gated.some((p) => p.id === c.id),
            reason: translateMessage(riskReason(c.name, c.input), languageOf(req)),
          }));
        }
      }

      // How full the window is, so the gauge is right the moment a conversation
      // opens rather than only after the next turn.
      let context = null;
      try {
        // The account's model, not the one stored on the conversation — the gauge
        // has to be measured against the window the next turn will actually use.
        const entry = await resolveForUser(req.user.id, (await getPrefs(req.user.id)).defaultModel);
        context = measureContext(messages, entry);
      } catch {
        /* an unresolvable model is the model picker's problem, not the gauge's */
      }

      // Which project this conversation answers under. The header says so:
      // "grounded in six documents" is not something to have to remember.
      let project = null;
      if (chat.project_id) {
        const found = await store.getProject(req.user.id, chat.project_id);
        if (found) {
          const files = await store.listProjectFiles(req.user.id, found.id);
          // `pinned` travels because the header chip uses it to decide whether
          // to draw at all: a pinned project is already named in the sidebar,
          // and two buttons carrying the same word is one too many.
          project = {
            id: found.id,
            name: found.name,
            grounded: found.grounded,
            pinned: !!found.pinned,
            files: files.length,
          };
        }
      }

      // Everything the assistant made here, so reopening a conversation brings
      // the documents back with it rather than leaving them buried in the
      // transcript at the point they were written.
      const files = await store.listGeneratedFiles(req.user.id, req.params.id);

      /**
       * Whether a turn is still going in this conversation, and under which id.
       *
       * The id is the part that matters. A run holds a lease keyed by it, and a
       * request carrying the same id is let back into that lease rather than
       * refused by it — which is how a turn survives the function timeout on a
       * hosted deployment. The browser knew its own id for as long as the tab
       * lived and lost it on reload, so after a refresh there was no way to
       * rejoin: the work went on writing steps into the database and the page
       * sat there blank, looking broken.
       *
       * Handing it back closes that gap. The page reopens, sees a live run,
       * reconnects with its id, and carries on watching the same turn — steps
       * and all — rather than starting a second one or showing nothing.
       */
      const running = isRunning(chat) ? { runId: chat.run_lock_by } : null;

      // A scheduled task or a workflow writing into it. There is no stream to
      // join for those — they run on the server with nobody attached — so the
      // page follows the transcript as each step is saved instead.
      const background = !running && (await store.chatHasBackgroundRun(req.user.id, req.params.id));

      res.json({ chat, messages, pendingApproval: pending, pendingQuestion: question, context, project, files, running, background });
    }),
  );

  /** Just the files, for refreshing the shelf without reloading a conversation. */
  api.get(
    '/chats/:id/files',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      res.json({ files: await store.listGeneratedFiles(req.user.id, req.params.id) });
    }),
  );

  api.patch(
    '/chats/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const patch = {};
      for (const key of ['title', 'model']) {
        if (key in (req.body || {})) patch[key] = req.body[key];
      }
      // Boolean columns: anything else was a database error and a 500.
      for (const key of ['pinned', 'unread', 'archived']) {
        if (key in (req.body || {})) patch[key] = !!req.body[key];
      }

      /**
       * Moving a conversation into a project, or out of one.
       *
       * `null` is meaningful — it is "Remove from project" — so this is checked
       * for presence rather than truthiness. A project id is verified against
       * this account before it is written: without that, a conversation could
       * be filed under somebody else's shelf and would then be answered from
       * their sources.
       */
      if ('projectId' in (req.body || {})) {
        const projectId = req.body.projectId ? String(req.body.projectId) : null;
        if (projectId && !(await store.getProject(req.user.id, projectId))) {
          return res.status(404).json({ error: 'No such project.' });
        }
        // Same contradiction as at creation: moving an incognito conversation
        // into a project would file it somewhere that keeps things.
        if (projectId) {
          const current = await store.getChat(req.user.id, req.params.id);
          if (current?.incognito) {
            return res.status(400).json({ error: 'An incognito conversation cannot be part of a project.' });
          }
        }
        patch.projectId = projectId;
      }

      // A group is a name somebody invented, so it is trimmed and bounded and
      // otherwise taken as written. Empty means "no group".
      if ('group' in (req.body || {})) {
        const name = String(req.body.group ?? '').trim().slice(0, 80);
        patch.group = name || null;
      }

      const chat = await store.updateChat(req.user.id, req.params.id, patch);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      res.json({ chat });
    }),
  );

  api.delete(
    '/chats/:id',
    wrap(async (req, res) => {
      await getStore().deleteChat(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  api.post(
    '/chats/:id/messages',
    wrap(async (req, res) => {
      const store = getStore();
      const chatId = req.params.id;
      const chat = await store.getChat(req.user.id, chatId);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });

      const text = String(req.body?.text || '').trim();

      let files;
      try {
        // Ownership checked here, not trusted: the ids come from the browser.
        files = await verifyOwned(req.user.id, req.body?.attachments);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      // A photo on its own is a perfectly good message — "what is this?" is
      // implied, and demanding a caption first would be pedantry.
      if (!text && !files.length) {
        return res.status(400).json({ error: 'Type something, or attach a file.' });
      }

      // Written from "Describe it to the assistant" on the Workflows or the
      // Scheduled shelf — which of the two it is for. See `INTENT_NOTES`.
      const intent = ['workflow', 'schedule'].includes(req.body?.intent) ? req.body.intent : null;

      const message = {
        id: crypto.randomUUID(),
        role: 'user',
        text,
        ...(files.length ? { attachments: files } : {}),
        ...(intent ? { intent } : {}),
      };
      await store.appendMessage(req.user.id, chatId, message);
      await store.attachToChat(req.user.id, chatId, files.map((f) => f.id));

      // The first message doubles as the title until the user renames it.
      const existing = await store.listMessages(req.user.id, chatId);
      if (existing.length === 1 || chat.title === 'New chat') {
        const title = text || files.map((f) => f.name).join(', ');
        await store.updateChat(req.user.id, chatId, { title: deriveTitle(title) });
      }
      res.status(201).json({ message });
    }),
  );

  /**
   * Edit something you said, and ask again from there.
   *
   * Refused mid-run: the messages after this one are about to be deleted, and
   * deleting them out from under a run in progress would leave the agent
   * writing into a conversation that no longer has a place for it.
   */
  api.patch(
    '/chats/:id/messages/:messageId',
    wrap(async (req, res) => {
      const store = getStore();
      const chat = await store.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      if (isRunning(chat)) {
        return res.status(409).json({
          error:
            'This conversation is still answering, so it cannot be rewritten underneath itself. Press Stop above the composer, then try again.',
        });
      }

      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'A message cannot be empty.' });

      try {
        const message = await store.editUserMessage(req.user.id, req.params.id, req.params.messageId, text);
        if (!message) return res.status(404).json({ error: 'Message not found' });
        res.json({ message });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }),
  );

  /**
   * Fold the older turns up now, rather than waiting for the ceiling.
   *
   * The automatic one runs when the window is nearly full; this is for choosing
   * the moment yourself — finishing one piece of work and wanting a clean slate
   * without losing what was decided.
   */
  api.post(
    '/chats/:id/compact',
    wrap(async (req, res) => {
      const store = getStore();
      const chatId = req.params.id;
      const chat = await store.getChat(req.user.id, chatId);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      /**
       * Not while a turn is running.
       *
       * The message-edit route has always refused mid-run, for exactly the
       * reason this one needed to and did not: writing a summary between an
       * assistant turn and the tool message answering it means the next turn's
       * `activeTranscript` slices from the summary, and that assistant turn plus
       * its results vanish from what the model sees.
       */
      if (isRunning(chat)) {
        return res.status(409).json({
          error:
            'This conversation is still answering, so it cannot be rewritten underneath itself. Press Stop above the composer, then try again.',
        });
      }

      const prefs = await getPrefs(req.user.id);
      const messages = await store.listMessages(req.user.id, chatId);
      // The account's model. Folding a conversation up has to be measured and
      // performed against the window the next turn will run in. Through
      // resolveForUser so Auto expands to the free model it would actually pick.
      const entry = await resolveForUser(req.user.id, prefs.defaultModel);

      /**
       * Not until there is something worth folding.
       *
       * Pressed again straight after a fold, it summarised the three turns
       * since — a model call to save almost nothing, and one more "summarised"
       * line in the transcript each time. A quarter of the window is the floor.
       */
      if (measureContext(messages, entry).ratio < MIN_MANUAL_COMPACT) {
        return res.status(400).json({
          error: 'This conversation uses under 25% of the window, so there is nothing worth folding yet.',
        });
      }

      try {
        const summary = await compactChat({
          userId: req.user.id,
          chatId,
          entry,
          prefs,
          messages,
        });
        if (!summary) {
          return res.status(400).json({ error: 'There is not enough here yet to be worth folding up.' });
        }
        res.json({
          summary: { id: summary.id, text: summary.text, replaced: summary.replaced },
          context: measureContext([...messages, summary], entry),
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

}
