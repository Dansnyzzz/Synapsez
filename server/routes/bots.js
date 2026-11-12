import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { RUN_LEASE_STALE_MS } from '../store/pg.js';
import { getPrefs } from '../settings.js';
import { validZone } from '../util/zone.js';
import { abortHere, holdRun, settledAfterStop, watchLease } from '../liveRuns.js';
import { log } from '../util/trace.js';
import { clientError } from '../util/clientError.js';
import { BotError, CREATURES, LIMITS, HANDOFF_CEILING, botView, groupView, createBot, createGroup, distinctFaces, duplicateBot, ensureChief, removeBot, updateBot, updateGroup } from '../bots/team.js';
import { exportTeam, importTeam } from '../bots/porting.js';
import { askAside } from '../bots/aside.js';
import { cleanFilters, newHookSecret, newRouteId, sealHookSecret, sendTestHook } from '../hooks.js';
import { disableTelegram, enableTelegram, setTelegramOthers, telegramView } from '../telegramInbound.js';
import { limit as rateLimit } from '../ratelimit.js';
import { withMarkup } from '../pricing.js';
import { needsApproval } from '../agent.js';
import { taskState } from '../../public/js/automation-status.js';
import { listMemory, pin, remember, restoreVersion, undoForget } from '../bots/memory.js';
import { runGroupRound, RESUMABLE } from '../bots/rounds.js';
import { chainNext } from '../bots/continue.js';
import { nextRunOf, parseSchedule } from '../scheduler.js';

/**
 * A bot that was paused is resumed: the runs it missed are let go, and each of its tasks
 * goes on from its next time after now (spec B.5) rather than all at once.
 *
 * @param {string} userId @param {string} botId
 */
async function skipPausedRuns(userId, botId) {
  const store = getStore();
  const now = Date.now();
  for (const task of await store.listTasks(userId, { botId })) {
    if (!task.enabled || !task.next_run_at || new Date(task.next_run_at).getTime() > now) continue;
    await store.updateTask(userId, task.id, { nextRunAt: nextRunOf(task) });
  }
}

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
      // Bots made before schema 43 could look alike: the second gets a colour of its own.
      await distinctFaces(req.user.id).catch((err) => log.warn('bot faces not told apart', { err: err?.message }));
      const [bots, groups, previews] = await Promise.all([store.listBots(req.user.id), store.listBotGroups(req.user.id), store.botPreviews(req.user.id)]);
      const last = (key, id) => previews.find((p) => p[key] === id) || null;
      const preview = (p) => (p && p.text ? { text: String(p.text).slice(0, 160), role: p.role, bot: p.author || null, at: p.updated_at } : null);
      res.json({
        bots: bots.map((b) => {
          const p = last('bot_id', b.id);
          return { ...botView(b), last: preview(p), at: p?.updated_at || b.updated_at, running: running(p), unread: !!p?.unread };
        }),
        groups: groups.map((g) => {
          const p = last('bot_group_id', g.id);
          // A round between two segments is still running; who is at work names the row's line.
          const between = !!g.pending && RESUMABLE.includes(g.pending.reason);
          const busy = running(p) || between;
          return { ...groupView(g), last: preview(p), at: p?.updated_at || g.updated_at, running: busy, working: busy ? (g.pending?.working || []).map((w) => w.bot) : [], unread: !!p?.unread };
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
        const before = b.paused === false ? await getStore().getBot(req.user.id, req.params.id) : null;
        const bot = await updateBot(req.user.id, req.params.id, { name: b.name, role: b.role, instructions: b.instructions, avatar: b.avatar, reviewEvery: b.reviewEvery, hue: b.hue, pinned: b.pinned, paused: b.paused });
        // Resumed: the runs it missed while paused are let go, and its tasks go on from now (spec B.5).
        if (before?.paused_at) await skipPausedRuns(req.user.id, bot.id).catch((err) => log.warn('a resumed bot kept its missed runs', { err: err?.message }));
        res.json({ bot: botView(bot) });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  /**
   * What waits for the person (spec B.2), one row each: a bot's question or a step that
   * needs their yes in its own chat, a group's question to them, a round stopped at the
   * hand-off ceiling or after its long run (Continue), a scheduled run that failed or
   * stopped for a yes. Healthy is an empty list.
   */
  api.get(
    '/bots/attention',
    wrap(async (req, res) => {
      const store = getStore();
      const [seen, groups, tasks, prefs] = await Promise.all([store.botAttention(req.user.id), store.listBotGroups(req.user.id), store.listTeamTasks(req.user.id), getPrefs(req.user.id).catch(() => ({}))]);
      const items = [];
      const waitingChats = new Set();
      for (const w of seen.waiting) {
        const calls = Array.isArray(w.tool_calls) ? w.tool_calls : [];
        const asking = calls.find((c) => c?.name === 'ask_options');
        const held = w.held && typeof w.held === 'object' ? Object.keys(w.held) : [];
        if (asking) {
          const q = asking.input?.questions?.[0]?.question || asking.input?.question || '';
          items.push({ kind: 'question', bot: w.bot_id, chatId: w.chat_id, text: String(q).slice(0, 200) });
        } else if (needsApproval(calls, prefs.toolPolicy).length || held.length) {
          items.push({ kind: 'approval', bot: w.bot_id, chatId: w.chat_id, text: calls.map((c) => c?.name).filter(Boolean).join(', ').slice(0, 200) });
        } else continue;
        waitingChats.add(w.chat_id);
      }
      for (const a of seen.asks) items.push({ kind: 'question', group: a.group_id, bot: a.bot, text: String(a.text || '').slice(0, 200) });
      for (const g of groups) if (g.pending && ['ceiling', 'segments'].includes(g.pending.reason)) items.push({ kind: 'ceiling', group: g.id });
      // A bot still waiting on something after a day (spec C.2).
      const dayAgo = Date.now() - 86_400_000;
      for (const w of await store.listBotWaits(req.user.id)) if (new Date(w.created_at).getTime() < dayAgo) items.push({ kind: 'wait', bot: w.bot_id, waitId: w.id, text: String(w.note).slice(0, 200) });
      for (const t of tasks) {
        const state = taskState(t);
        // A run stopped for a yes is the waiting step above, when its chat says so already.
        if (!state.attention || !['failed', 'needs'].includes(state.run || '') || (t.last_chat && waitingChats.has(t.last_chat))) continue;
        items.push({ kind: 'failed', taskId: t.id, bot: t.bot_id || null, group: t.bot_group_id || null, chatId: t.last_chat || null, text: t.title, reason: String(t.last_status || '').replace(/^(failed|error|stopped):\s*/, '').slice(0, 300) });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ items });
    }),
  );

  /** The person has read a bot's own chat, or a group's, to its end: its unread mark goes (spec B.3). */
  api.post(
    '/bots/:id/read',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      const chat = await store.botChat(req.user.id, { botId: bot.id, title: bot.name });
      res.json({ ok: !!chat && (await store.markChatRead(req.user.id, chat.id)) });
    }),
  );
  api.post(
    '/bot-groups/:id/read',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const chat = await store.botChat(req.user.id, { groupId: group.id, title: group.name });
      res.json({ ok: !!chat && (await store.markChatRead(req.user.id, chat.id)) });
    }),
  );

  /** A copy of a bot, its memory with it, its tasks paused (spec B.5). */
  api.post(
    '/bots/:id/duplicate',
    wrap(async (req, res) => {
      try {
        const prefs = await getPrefs(req.user.id).catch(() => ({}));
        const made = await duplicateBot(req.user.id, req.params.id, prefs.language === 'vi' ? 'vi' : 'en');
        res.status(201).json({ bot: botView(made.bot), memory: made.memory, tasks: made.tasks });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  /** The team as a file, `synapsez-bots/1` (spec B.5): no conversations, no keys. */
  api.get(
    '/bots/export',
    wrap(async (req, res) => {
      const file = await exportTeam(req.user.id);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `attachment; filename="synapsez-bots-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(file);
    }),
  );

  /**
   * A team file in (spec B.5): `dry` says what it would add; otherwise each bot and group
   * is added whole or not at all, and the answer says which, with what was refused.
   */
  api.post(
    '/bots/import',
    rateLimit('team-file', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        const result = await importTeam(req.user.id, req.body?.data, { apply: req.body?.dry !== true });
        res.status(req.body?.dry === true ? 200 : 201).json(result);
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  /**
   * A question to a bot, asked aside (spec B.6): answered from its conversation in one
   * call with no tools, and never kept — the conversation and its memory stay as they were.
   */
  api.post(
    '/bots/:id/aside',
    rateLimit('aside', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        const model = typeof req.body?.model === 'string' ? req.body.model.slice(0, 200) : null;
        res.json(await askAside({ user: req.user, botId: req.params.id, question: req.body?.question, model }));
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  /**
   * One bot's spending over a range, opened from its row on the Usage page (spec B.8): by
   * kind of token, model, group, who started the turn, and what made the call. Cost at
   * the price charged.
   */
  api.get(
    '/bots/:id/usage',
    wrap(async (req, res) => {
      const from = new Date(String(req.query.from || ''));
      const to = new Date(String(req.query.to || ''));
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) return res.status(400).json({ error: 'Give a range: from and to.' });
      if (to.getTime() - from.getTime() > 400 * 86_400_000) return res.status(400).json({ error: 'A range is at most 400 days.' });
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      const d = await store.botUsageDetail(req.user.id, bot.id, { from, to });
      const charged = (row) => ({ ...row, cost: withMarkup(Number(row.cost || 0)) });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ...d, models: d.models.map(charged), roles: d.roles.map(charged) });
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
      // Said in each group it was in (team.js removeBot).
      await removeBot(req.user.id, bot);
      res.json({ ok: true });
    }),
  );

  /*
   * A bot's own scheduled tasks (owner, 2026-11-10): made here or by the bot in its
   * chat, run in its chat as it, and listed only here — Automations keeps the
   * account's own. Pausing, running and deleting one go through /tasks/:id as any.
   */
  api.get(
    '/bots/:id/tasks',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      res.json({ tasks: await store.listTasks(req.user.id, { botId: bot.id }) });
    }),
  );
  api.post(
    '/bots/:id/tasks',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      const title = String(req.body?.title ?? '').trim().slice(0, 120);
      const prompt = String(req.body?.prompt ?? '').trim();
      if (!title || !prompt) return res.status(400).json({ error: 'A scheduled task needs a name and what to do.' });
      if (prompt.length > 8000) return res.status(400).json({ error: 'That is too long for a scheduled task.' });
      const prefs = await getPrefs(req.user.id).catch(() => ({}));
      const tz = validZone(req.body?.tz) ? req.body.tz : validZone(prefs.timezone) ? prefs.timezone : null;
      // Started by a signed request rather than a clock (spec C.1): no schedule, a route and a secret.
      if (req.body?.trigger === 'hook') {
        const task = await store.createTask(req.user.id, { id: crypto.randomUUID(), title, prompt, model: null, cron: null, nextRunAt: null, tz, botId: bot.id, trigger: 'hook' });
        if (!task) return res.status(404).json({ error: 'No such bot.' });
        const secret = newHookSecret();
        const routeId = newRouteId();
        const route = await store.createHookRoute(req.user.id, { id: routeId, taskId: task.id, secretEnc: sealHookSecret(secret, { userId: req.user.id, routeId }) });
        // Shown this once; only its encrypted form is kept.
        return res.status(201).json({ task, hook: { url: hookUrl(req, route.id), secret } });
      }
      let when;
      try {
        when = parseSchedule(req.body?.when, { once: req.body?.repeat === false, tz });
      } catch (err) {
        return res.status(400).json({ error: clientError(err) });
      }
      const task = await store.createTask(req.user.id, { id: crypto.randomUUID(), title, prompt, model: null, cron: when.cron, nextRunAt: when.nextRunAt, tz, botId: bot.id, missed: req.body?.missed });
      if (!task) return res.status(404).json({ error: 'No such bot.' });
      res.status(201).json({ task });
    }),
  );

  /* ── a task's webhook (spec C.1): only the person, never a bot ─────── */

  /** Where a hook is: the deployment's public address, then the one this request came to. */
  const hookUrl = (req, routeId) => `${publicBase(req)}/api/hooks/${routeId}`;
  const publicBase = (req) => String(process.env.PUBLIC_URL || origin(req) || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')).replace(/\/+$/, '');
  const hookOf = async (req, res) => {
    const store = getStore();
    const task = await store.getTask(req.user.id, req.params.id);
    const route = task ? await store.getHookRouteForTask(req.user.id, task.id) : null;
    if (!route) res.status(404).json({ error: 'This task has no hook.' });
    return route;
  };
  /** Its address, filters and the last deliveries — never its secret. */
  api.get(
    '/bot-tasks/:id/hook',
    wrap(async (req, res) => {
      const route = await hookOf(req, res);
      if (!route) return;
      const receipts = await getStore().listHookReceipts(req.user.id, route.id, 20);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ url: hookUrl(req, route.id), filters: route.filters || {}, rotatedAt: route.rotated_at, receipts: receipts.map((r) => ({ delivery: r.delivery_id, status: r.status, reason: r.reason, at: r.at })) });
    }),
  );
  api.patch(
    '/bot-tasks/:id/hook',
    wrap(async (req, res) => {
      const route = await hookOf(req, res);
      if (!route) return;
      let filters;
      try {
        filters = cleanFilters(req.body?.filters);
      } catch (err) {
        return res.status(err.status || 400).json({ error: clientError(err) });
      }
      const saved = await getStore().setHookFilters(req.user.id, route.task_id, filters);
      res.json({ filters: saved?.filters || filters });
    }),
  );
  /** A new secret, at once: the old one stops working now. Shown this once. */
  api.post(
    '/bot-tasks/:id/hook/rotate',
    wrap(async (req, res) => {
      const route = await hookOf(req, res);
      if (!route) return;
      const secret = newHookSecret();
      await getStore().rotateHookRoute(req.user.id, route.task_id, sealHookSecret(secret, { userId: req.user.id, routeId: route.id }));
      res.json({ url: hookUrl(req, route.id), secret });
    }),
  );
  /** "Gửi thử": a signed test event from the server, through the same door as any. */
  api.post(
    '/bot-tasks/:id/hook/test',
    wrap(async (req, res) => {
      const route = await hookOf(req, res);
      if (!route) return;
      const answer = await sendTestHook({ userId: req.user.id, taskId: route.task_id });
      res.status(answer.status === 202 || answer.status === 200 ? 200 : answer.status).json(answer.body);
    }),
  );

  /* ── a bot's waits (spec C.2) ─────────────────────────────────────── */
  api.get(
    '/bots/:id/waits',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      const waits = await store.listBotWaits(req.user.id, bot.id);
      res.json({ waits: waits.map((w) => ({ id: w.id, request: w.request, note: w.note, createdAt: w.created_at })) });
    }),
  );
  /** The person closes one (the ✕ on its chip). */
  api.delete(
    '/bots/:id/waits/:wait',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      const closed = await store.closeBotWait(req.user.id, req.params.wait, { botId: bot.id, outcome: 'closed by the user' });
      if (!closed) return res.status(404).json({ error: 'No such wait.' });
      res.json({ ok: true });
    }),
  );

  /* ── Telegram to Chief (spec C.3) ─────────────────────────────────── */
  api.get(
    '/telegram/inbound',
    wrap(async (req, res) => {
      const store = getStore();
      const [row, connected] = await Promise.all([store.getTelegramInbound(req.user.id), store.getConnector(req.user.id, 'telegram')]);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ connected: !!connected, ...telegramView(row) });
    }),
  );
  api.post(
    '/telegram/inbound',
    rateLimit('connect', (req) => req.user?.id),
    wrap(async (req, res) => {
      try {
        const row = req.body?.enabled ? await enableTelegram(req.user.id, { base: publicBase(req) }) : await disableTelegram(req.user.id);
        res.json(telegramView(row));
      } catch (err) {
        res.status(err.status || 400).json({ error: clientError(err) });
      }
    }),
  );
  api.put(
    '/telegram/inbound/others',
    wrap(async (req, res) => {
      try {
        res.json(telegramView(await setTelegramOthers(req.user.id, req.body?.ids)));
      } catch (err) {
        res.status(err.status || 400).json({ error: clientError(err) });
      }
    }),
  );

  /** A group's own scheduled tasks (spec B.4): each run is a round, shown in the group's details only. */
  api.get(
    '/bot-groups/:id/tasks',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      res.json({ tasks: await store.listTasks(req.user.id, { groupId: group.id }) });
    }),
  );
  api.post(
    '/bot-groups/:id/tasks',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const title = String(req.body?.title ?? '').trim().slice(0, 120);
      const prompt = String(req.body?.prompt ?? '').trim();
      if (!title || !prompt) return res.status(400).json({ error: 'A scheduled task needs a name and what to do.' });
      if (prompt.length > 8000) return res.status(400).json({ error: 'That is too long for a scheduled task.' });
      const prefs = await getPrefs(req.user.id).catch(() => ({}));
      const tz = validZone(req.body?.tz) ? req.body.tz : validZone(prefs.timezone) ? prefs.timezone : null;
      let when;
      try {
        when = parseSchedule(req.body?.when, { once: req.body?.repeat === false, tz });
      } catch (err) {
        return res.status(400).json({ error: clientError(err) });
      }
      const task = await store.createTask(req.user.id, { id: crypto.randomUUID(), title, prompt, model: null, cron: when.cron, nextRunAt: when.nextRunAt, tz, botGroupId: group.id, missed: req.body?.missed });
      if (!task) return res.status(404).json({ error: 'No such group chat.' });
      res.status(201).json({ task });
    }),
  );

  /** A bot's own chat: its id, made the first time, and what is in it. */
  api.get(
    '/bots/:id/chat',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      // Incognito (the top bar's switch): a fresh conversation, not kept, its memory neither read nor written.
      if (req.query.incognito === '1') {
        const fresh = await store.incognitoBotChat(req.user.id, bot.id, bot.name);
        if (!fresh) return res.status(404).json({ error: 'No such bot.' });
        return res.json({ chatId: fresh.id, running: false, messages: [], incognito: true });
      }
      const chat = await store.botChat(req.user.id, { botId: bot.id, title: bot.name });
      if (!chat) return res.status(404).json({ error: 'No such bot.' });
      // `?light=1`: the id alone — the Bot page's home chat reads the messages itself (2026-11-10).
      if (req.query.light === '1') return res.json({ chatId: chat.id, running: running(chat) });
      res.json({ chatId: chat.id, running: running(chat), messages: await store.listMessages(req.user.id, chat.id) });
    }),
  );

  /* ── memory: a bot's, and a group's ─────────────────────────────── */

  const memoryRoutes = (path, scopeOf, exists) => {
    /**
     * The entries that hold, each with the versions a bot or a review replaced, and the
     * ones a bot or a review forgot — with where each was saved (owner, 2026-11-12,
     * schema 50): the conversation by its title, and the host or the kind of tool it
     * had last read from outside. One query for the titles, not one per entry.
     */
    api.get(
      `${path}/memory`,
      wrap(async (req, res) => {
        if (!(await exists(req))) return res.status(404).json({ error: 'Not found.' });
        const store = getStore();
        const [rows, closed] = await Promise.all([listMemory(req.user.id, scopeOf(req)), store.listBotMemoryHistory(req.user.id, scopeOf(req))]);
        const titles = await store.chatTitles(req.user.id, [...rows, ...closed].map((r) => r.chat_id).filter(Boolean));
        const chainOf = (r) => r.chain_id || r.id;
        const view = (r) => ({
          id: r.id,
          text: r.text,
          source: r.source,
          createdAt: r.created_at,
          pinned: !!r.pinned,
          pinnedBy: r.pinned_by || null,
          validFrom: r.valid_from || r.created_at,
          invalidAt: r.invalid_at || null,
          closedBy: r.closed_by || null,
          saved: r.chat_id ? { chatId: r.chat_id, chatTitle: titles.get(r.chat_id) ?? null, seq: r.message_seq == null ? null : Number(r.message_seq), outside: r.outside_from || null } : null,
        });
        const open = new Set(rows.map(chainOf));
        const earlier = new Map();
        for (const c of closed) earlier.set(chainOf(c), [...(earlier.get(chainOf(c)) || []), view(c)]);
        const forgotten = [...earlier.entries()].filter(([chain]) => !open.has(chain)).map(([, versions]) => ({ ...versions[0], history: versions.slice(1) }));
        res.json({ entries: rows.map((r) => ({ ...view(r), history: earlier.get(chainOf(r)) || [] })), forgotten });
      }),
    );
    /** Bring back a version a bot or a review replaced or forgot; what came after it goes. */
    api.post(
      `${path}/memory/:entry/restore`,
      wrap(async (req, res) => {
        if (!(await exists(req))) return res.status(404).json({ error: 'Not found.' });
        try {
          const row = await restoreVersion(req.user.id, scopeOf(req), req.params.entry);
          res.json({ entry: { id: row.id, text: row.text, source: row.source, createdAt: row.created_at, pinned: !!row.pinned, pinnedBy: row.pinned_by || null } });
        } catch (err) {
          fail(res, err);
        }
      }),
    );
    api.post(
      `${path}/memory`,
      wrap(async (req, res) => {
        if (!(await exists(req))) return res.status(404).json({ error: 'Not found.' });
        try {
          const { saved, entries } = await remember(req.user.id, scopeOf(req), req.body?.text, 'user');
          const view = (e) => ({ id: e.id, text: e.text, source: e.source, createdAt: e.created_at });
          // A long note may become several entries (cut at its sentence ends): all of them, the first as `entry`.
          res.status(saved ? 201 : 200).json({ saved, entry: view(entries[0]), entries: entries.map(view) });
        } catch (err) {
          fail(res, err);
        }
      }),
    );
    /** Edit an entry's words, or pin it (the person's pin, which a bot cannot take away). */
    api.patch(
      `${path}/memory/:entry`,
      wrap(async (req, res) => {
        if (!(await exists(req))) return res.status(404).json({ error: 'Not found.' });
        try {
          const scope = scopeOf(req);
          let row = null;
          if (typeof req.body?.text === 'string') row = (await remember(req.user.id, scope, req.body.text, 'user', { replace: req.params.entry })).entry;
          if (typeof req.body?.pinned === 'boolean') row = await pin(req.user.id, scope, req.params.entry, req.body.pinned, 'user');
          if (!row) return res.status(400).json({ error: 'Say what to change: text or pinned.' });
          res.json({ entry: { id: row.id, text: row.text, source: row.source, createdAt: row.created_at, pinned: !!row.pinned, pinnedBy: row.pinned_by || null } });
        } catch (err) {
          fail(res, err);
        }
      }),
    );
    /**
     * The person's delete: soft, so that Undo brings it back for a few minutes, then gone
     * for good (FORGOTTEN_KEEP_MS) — with every earlier version of it (PRV-006, schema 50).
     */
    api.delete(
      `${path}/memory/:entry`,
      wrap(async (req, res) => {
        const gone = await getStore().softDeleteBotMemory(req.user.id, req.params.entry, scopeOf(req));
        if (!gone) return res.status(404).json({ error: 'No such entry.' });
        res.json({ ok: true, undo: [req.params.entry] });
      }),
    );
    api.post(
      `${path}/memory/undo`,
      wrap(async (req, res) => {
        if (!(await exists(req))) return res.status(404).json({ error: 'Not found.' });
        const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, 50);
        res.json({ restored: await undoForget(req.user.id, ids) });
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
        const group = await updateGroup(req.user.id, req.params.id, { name: b.name, members: b.members, admin: b.admin, notice: b.notice, pinned: b.pinned });
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
      // Running: a segment holds it now, or it is between two (owner, 2026-11-10); `pending` says what waits.
      const pending = group.pending || null;
      res.json({
        chatId: chat.id,
        running: running(chat) || (!!pending && RESUMABLE.includes(pending.reason)),
        pending: pending ? { reason: pending.reason } : null,
        called: pending && RESUMABLE.includes(pending.reason) ? pending.called || [] : [],
        messages: await store.listMessages(req.user.id, chat.id),
      });
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
      // What was waiting goes too: a segment asked for before the stop finds nothing to carry on.
      await store.setGroupPending(req.user.id, group.id, null);
      res.json({ stopped });
    }),
  );

  /**
   * Reset a conversation (owner, 2026-11-10): a bot's own chat, or a group's log with
   * every member's conversation for it. The rows are deleted, files and all, to free the
   * space; memory, instructions, members and scheduled tasks stay. Not while it runs —
   * or, for a group, while its round is between two segments: Stop first.
   */
  api.post(
    '/bots/:id/reset',
    wrap(async (req, res) => {
      const store = getStore();
      const bot = await store.getBot(req.user.id, req.params.id);
      if (!bot) return res.status(404).json({ error: 'No such bot.' });
      const chat = await store.botChat(req.user.id, { botId: bot.id, title: bot.name });
      if (running(chat)) return res.status(409).json({ error: 'This bot is answering. Stop it first, then reset.', code: 'running' });
      const removed = await store.resetConversation(req.user.id, { botId: bot.id });
      res.json({ reset: true, removed });
    }),
  );
  api.post(
    '/bot-groups/:id/reset',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const chat = await store.botChat(req.user.id, { groupId: group.id, title: group.name });
      if (running(chat) || (group.pending && RESUMABLE.includes(group.pending.reason))) {
        return res.status(409).json({ error: 'This group is answering. Stop it first, then reset.', code: 'running' });
      }
      const removed = await store.resetConversation(req.user.id, { groupId: group.id });
      res.json({ reset: true, removed });
    }),
  );

  /**
   * Stream one segment of a group's round as server-sent events: `post` for each line
   * the group gains, `member_start` / `member_text` / `member_tool` / `member_end`
   * while a bot works, `paused` when the segment hands the rest to the next one
   * (the page then follows the group with `live`), `done` at the end. The segment
   * holds the log's run lease; the next one is asked for only once it has let go.
   */
  async function streamRound(req, res, { group, chat, runId, runSeq, text = '', resume = false, fresh = false, model }) {
    const store = getStore();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const emit = (event, data) => {
      if (res.writableEnded || res.destroyed || res.closed) return;
      try {
        res.write('event: ' + event + '\ndata: ' + JSON.stringify(data ?? {}) + '\n\n');
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
    let wantNext = false;
    try {
      const result = await runGroupRound({
        user: req.user,
        groupId: group.id,
        text,
        emit,
        signal: controller.signal,
        origin: origin(req),
        model,
        resume,
        fresh,
        chain: () => {
          wantNext = true;
        },
      });
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
    // After the lease is free: the next segment takes it at once.
    if (wantNext) chainNext(req.user.id, group.id);
  }

  /** The chip's model as the request sends it, or undefined. */
  const modelOf = (req) => (typeof req.body?.model === 'string' && /^[\w./:@-]{1,200}$/.test(req.body.model) ? req.body.model : undefined);

  /**
   * Write in a group and run its round. While another segment holds the group, the
   * line is written and that segment answers it (owner, 2026-11-10: writing while the
   * group works) — `{ joined: true }`, no stream.
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
      const model = modelOf(req);
      const runId = /^[0-9a-f-]{36}$/i.test(String(req.body?.runId || '')) ? req.body.runId : crypto.randomUUID();
      const runSeq = await store.claimChatRun(req.user.id, chat.id, runId);
      if (!runSeq) {
        const message = await store.appendMessage(req.user.id, chat.id, { id: crypto.randomUUID(), role: 'user', text });
        if (model) await store.setGroupModel(req.user.id, group.id, model);
        return res.json({ joined: true, message });
      }
      await streamRound(req, res, { group, chat, runId, runSeq, text, model });
    }),
  );

  /** Carry on what the group has waiting: the person's Continue, after the ceiling or a long round. */
  api.post(
    '/bot-groups/:id/continue',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      if (!group.pending) return res.status(409).json({ error: 'There is nothing waiting to carry on.', code: 'nothing_pending' });
      const chat = await store.botChat(req.user.id, { groupId: group.id, title: group.name });
      await settledAfterStop(store, req.user.id, chat.id);
      const runId = crypto.randomUUID();
      const runSeq = await store.claimChatRun(req.user.id, chat.id, runId);
      if (!runSeq) return res.status(409).json({ error: 'This group is already answering. Wait for it, or stop it.', code: 'already_running' });
      const fresh = ['ceiling', 'segments'].includes(group.pending.reason);
      await streamRound(req, res, { group, chat, runId, runSeq, resume: true, fresh, model: modelOf(req) });
    }),
  );

  /**
   * What is new in a group since `since` (a line's seq), who is at work and whether the
   * round goes on — for a page that did not start the segment running now: another
   * tab, the page opened again, a segment in a new invocation.
   */
  api.get(
    '/bot-groups/:id/live',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const chat = await store.botChat(req.user.id, { groupId: group.id, title: group.name });
      const since = Number.isFinite(Number(req.query?.since)) ? Number(req.query.since) : -1;
      const pending = group.pending || null;
      const held = running(chat);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        running: held || (!!pending && RESUMABLE.includes(pending.reason)),
        messages: await store.messagesSince(req.user.id, chat.id, since),
        working: held ? pending?.working || [] : [],
        // Whom the person's message called and how each went: the strip above the box (spec B.3).
        called: pending && RESUMABLE.includes(pending.reason) ? pending.called || [] : [],
        pending: pending ? { reason: pending.reason } : null,
      });
    }),
  );

  /** The chip changed while a group is open: its next batch answers on that model. */
  api.patch(
    '/bot-groups/:id/model',
    wrap(async (req, res) => {
      const store = getStore();
      const group = await store.getBotGroup(req.user.id, req.params.id);
      if (!group) return res.status(404).json({ error: 'No such group chat.' });
      const model = modelOf(req);
      if (!model) return res.status(400).json({ error: 'That is not a model id.' });
      await store.setGroupModel(req.user.id, group.id, model);
      res.json({ model });
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
      // The same span just before, for "+18% on the 7 days before" (spec B.8).
      const span = to.getTime() - from.getTime();
      const [rows, before] = await Promise.all([getStore().botUsage(req.user.id, { from, to, unit, tz }), getStore().botUsageTotal(req.user.id, { from: new Date(from.getTime() - span), to: from })]);
      res.json({
        unit,
        before: { tokens: before.tokens, cost: withMarkup(before.cost) },
        rows: rows.map((r) => ({
          bucket: r.bucket,
          bot: r.bot_id,
          model: r.model,
          input: Number(r.input_tokens || 0),
          output: Number(r.output_tokens || 0),
          cacheRead: Number(r.cache_read_tokens || 0),
          calls: Number(r.calls || 0),
          // At the price charged, since it is billed (spec B.8).
          cost: withMarkup(Number(r.cost || 0)),
        })),
      });
    }),
  );
}
