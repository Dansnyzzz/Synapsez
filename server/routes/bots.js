import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { RUN_LEASE_STALE_MS } from '../store/pg.js';
import { getPrefs } from '../settings.js';
import { validZone } from '../util/zone.js';
import { abortHere, holdRun, settledAfterStop, watchLease } from '../liveRuns.js';
import { log } from '../util/trace.js';
import { clientError } from '../util/clientError.js';
import { BotError, CREATURES, LIMITS, HANDOFF_CEILING, botView, groupView, createBot, createGroup, ensureChief, updateBot, updateGroup } from '../bots/team.js';
import { listMemory, remember } from '../bots/memory.js';
import { runGroupRound } from '../bots/rounds.js';

/**
 * The Bot page's routes (owner, 2026-11-09): the team, each bot's and group's
 * conversation, memory, a group's round, and usage by bot.
 *
 * Session auth throughout, on the authenticated router. Every store call is scoped
 * to `req.user.id`; an id in the path only narrows a query that already is, so
 * another account's bot or group is a 404, never a sign that it exists.
 *
 * A bot's own chat needs no route of its own to run: it is a conversation of this
 * app, so the page appends to it and runs it with `/chats/:id/messages` and
 * `/chats/:id/run`, and stops it with `/chats/:id/stop` — the agent loop sees whose
 * it is (server/agent.js). A group is different: its round is one request here,
 * streamed, running its members one after another or together.
 *
 * @param {import('express').Router} api
 * @param {{ wrap: Function, body?: Function, origin?: (req: any) => string | null }} ctx
 */
export function mountBotRoutes(api, { wrap, origin = () => null }) {
  /** A BotError's own status and words; anything else is the app's to log. */
  const fail = (res, err) => {
    // A BotError's sentence is the route's own refusal; `clientError` passes it on and blanks anything else.
    if (err instanceof BotError) return res.status(err.status).json({ error: clientError(err), code: err.code });
    throw err;
  };
  const running = (row) => !!row?.run_lock_at && new Date(row.run_lock_at).getTime() > Date.now() - RUN_LEASE_STALE_MS;

  /**
   * The whole team: bots (Chief first, made now if this is the first visit), group
   * chats, the last thing said in each, and which are working. One read for the
   * list on the left; the page asks again after anything changes.
   */
  api.get(
    '/bots',
    wrap(async (req, res) => {
      const store = getStore();
      const prefs = await getPrefs(req.user.id).catch(() => ({}));
      await ensureChief(req.user.id, prefs);
      const [bots, groups, previews] = await Promise.all([store.listBots(req.user.id), store.listBotGroups(req.user.id), store.botPreviews(req.user.id)]);
      const last = (key, id) => previews.find((p) => p[key] === id) || null;
      const preview = (p) => (p && p.text ? { text: String(p.text).slice(0, 160), role: p.role, bot: p.author || null, at: p.updated_at } : null);
      res.json({
        bots: bots.map((b) => {
          const p = last('bot_id', b.id);
          return { ...botView(b), last: preview(p), at: p?.updated_at || b.updated_at, running: running(p) };
        }),
        groups: groups.map((g) => {
          const p = last('bot_group_id', g.id);
          return { ...groupView(g), last: preview(p), at: p?.updated_at || g.updated_at, running: running(p) };
        }),
        creatures: CREATURES,
        limits: { ...LIMITS, handoffs: HANDOFF_CEILING },
      });
    }),
  );

  api.post(
    '/bots',
    wrap(async (req, res) => {
      try {
        const bot = await createBot(req.user.id, req.body || {});
        res.status(201).json({ bot: botView(bot) });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  api.patch(
    '/bots/:id',
    wrap(async (req, res) => {
      const b = req.body || {};
      try {
        const bot = await updateBot(req.user.id, req.params.id, { name: b.name, role: b.role, instructions: b.instructions, avatar: b.avatar, model: b.model });
        res.json({ bot: botView(bot) });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  /** Chief is changed, never deleted: the team needs someone to ask. */
  api.delete(
    '/bots/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      if (bot.is_main) return res.status(409).json({ error: 'Chief runs the team, so it can be changed but not deleted.', code: 'main_bot' });
      await store.deleteBot(req.user.id, bot.id);
      res.json({ ok: true });
    }),
  );

  /** A bot's own chat: its id, made the first time, and what is in it. */
  api.get(
    '/bots/:id/chat',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      const chat = await store.botChat(req.user.id, { botId: bot.id, title: bot.name });
      if (!chat) return res.status(404).json({ error: 'No such bot.' });
      res.json({ chatId: chat.id, running: running(chat), messages: await store.listMessages(req.user.id, chat.id) });
    }),
  );

  /* ── memory: a bot's, and a group's ─────────────────────────────── */

  const memoryRoutes = (path, scopeOf, exists) => {
    api.get(
      `${path}/memory`,
      wrap(async (req, res) => {
        if (!(await exists(req))) return res.status(404).json({ error: 'Not found.' });
        const rows = await listMemory(req.user.id, scopeOf(req));
        res.json({ entries: rows.map((r) => ({ id: r.id, text: r.text, source: r.source, createdAt: r.created_at })) });
      }),
    );
    api.post(
      `${path}/memory`,
      wrap(async (req, res) => {
        if (!(await exists(req))) return res.status(404).json({ error: 'Not found.' });
        try {
          const { saved, entry } = await remember(req.user.id, scopeOf(req), req.body?.text, 'user');
          res.status(saved ? 201 : 200).json({ saved, entry: { id: entry.id, text: entry.text, source: entry.source, createdAt: entry.created_at } });
        } catch (err) {
          fail(res, err);
        }
      }),
    );
    api.delete(
      `${path}/memory/:entry`,
      wrap(async (req, res) => {
        const gone = await getStore().deleteBotMemory(req.user.id, req.params.entry, scopeOf(req));
        if (!gone) return res.status(404).json({ error: 'No such entry.' });
        res.json({ ok: true });
      }),
    );
  };
  memoryRoutes('/bots/:id', (req) => ({ botId: req.params.id }), async (req) => !!(await getStore().getBot(req.user.id, req.params.id)));
  memoryRoutes('/bot-groups/:id', (req) => ({ groupId: req.params.id }), async (req) => !!(await getStore().getBotGroup(req.user.id, req.params.id)));

  /* ── group chats ───────────────────────────────────────────────── */

  api.post(
    '/bot-groups',
    wrap(async (req, res) => {
      try {
        const group = await createGroup(req.user.id, req.body || {});
        res.status(201).json({ group: groupView(group) });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  api.patch(
    '/bot-groups/:id',
    wrap(async (req, res) => {
      const b = req.body || {};
      try {
        const group = await updateGroup(req.user.id, req.params.id, { name: b.name, members: b.members, admin: b.admin });
        res.json({ group: groupView(group) });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  api.delete(
    '/bot-groups/:id',
    wrap(async (req, res) => {
      const gone = await getStore().deleteBotGroup(req.user.id, req.params.id);
      if (!gone) return res.status(404).json({ error: 'No such group chat.' });
      res.json({ ok: true });
    }),
  );

  /** A group's log: what the person reads. */
  api.get(
    '/bot-groups/:id/chat',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const chat = await store.botChat(req.user.id, { groupId: group.id, title: group.name });
      res.json({ chatId: chat.id, running: running(chat), messages: await store.listMessages(req.user.id, chat.id) });
    }),
  );

  /**
   * Stop a group's round: every member's turn in it. The round holds the log's run
   * lease; taking it away ends the round here at once and on another instance
   * within the watch's two seconds, and all its members run under that one signal.
   */
  api.post(
    '/bot-groups/:id/stop',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const chat = await store.botChat(req.user.id, { groupId: group.id, title: group.name });
      const stopped = await store.stopChatRun(req.user.id, chat.id);
      abortHere(req.user.id, chat.id);
      res.json({ stopped });
    }),
  );

  /**
   * Write in a group and run its round, streamed as server-sent events: `post` for
   * each line the group gains, `member_start` / `member_text` / `member_tool` /
   * `member_end` while a bot works, `done` at the end.
   */
  api.post(
    '/bot-groups/:id/run',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'Type something to send to the group.' });
      if (text.length > 20_000) return res.status(400).json({ error: 'That message is too long for a group chat.' });
      const chat = await store.botChat(req.user.id, { groupId: group.id, title: group.name });
      await settledAfterStop(store, req.user.id, chat.id);
      const runId = /^[0-9a-f-]{36}$/i.test(String(req.body?.runId || '')) ? req.body.runId : crypto.randomUUID();
      const runSeq = await store.claimChatRun(req.user.id, chat.id, runId);
      if (!runSeq) return res.status(409).json({ error: 'This group is already answering. Wait for it, or stop it.', code: 'already_running' });

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const emit = (event, data) => {
        if (res.writableEnded || res.destroyed || res.closed) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
        } catch {
          /* the socket went; the round's lines are saved anyway */
        }
      };
      const controller = new AbortController();
      const letGo = holdRun(req.user.id, chat.id, controller);
      const lease = watchLease({ store, userId: req.user.id, chatId: chat.id, runId, seq: runSeq, controller, onRenew: () => emit('ping', { t: Date.now() }) });
      // A closed socket is not a stop (the round's lines are written as they come); the lease decides.
      res.on('close', () => {
        if (!res.writableEnded) void lease.check();
      });
      try {
        const result = await runGroupRound({ user: req.user, groupId: group.id, text, emit, signal: controller.signal, origin: origin(req) });
        emit('done', result);
      } catch (err) {
        log.error('group round failed', err);
        emit('error', { message: err instanceof BotError ? clientError(err) : 'The group could not answer. Try again in a moment.' });
        emit('done', { stopReason: 'error' });
      } finally {
        lease.stop();
        letGo();
        await store.releaseChatRun(req.user.id, chat.id, runId, runSeq).catch(() => {});
        await store.clearRunStop(req.user.id, chat.id).catch(() => {});
        if (!res.writableEnded) res.end();
      }
    }),
  );

  /* ── usage by bot ───────────────────────────────────────────────── */

  /**
   * What the bots spent between two instants, by bucket (in the person's zone), bot
   * and model — Bot settings → Usage, and the details panel's line. At most 400 days.
   */
  api.get(
    '/bots/usage',
    wrap(async (req, res) => {
      const from = new Date(String(req.query.from || ''));
      const to = new Date(String(req.query.to || ''));
      const unit = String(req.query.unit || 'day');
      const tz = String(req.query.tz || 'UTC');
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) return res.status(400).json({ error: 'Give a range: from and to.' });
      if (to.getTime() - from.getTime() > 400 * 86_400_000) return res.status(400).json({ error: 'A range is at most 400 days.' });
      if (!['hour', 'day', 'week', 'month'].includes(unit)) return res.status(400).json({ error: 'The unit is hour, day, week or month.' });
      if (!validZone(tz)) return res.status(400).json({ error: 'That is not a time zone.' });
      const rows = await getStore().botUsage(req.user.id, { from, to, unit, tz });
      res.json({
        unit,
        rows: rows.map((r) => ({
          bucket: r.bucket,
          bot: r.bot_id,
          model: r.model,
          input: Number(r.input_tokens || 0),
          output: Number(r.output_tokens || 0),
          cacheRead: Number(r.cache_read_tokens || 0),
          calls: Number(r.calls || 0),
        })),
      });
    }),
  );
}
