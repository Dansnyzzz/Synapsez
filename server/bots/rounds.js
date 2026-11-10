import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { runAgent as realRunAgent } from '../agent.js';
import { redactSecrets } from '../redact.js';
import { mentionedBots } from '../../public/js/bot-mentions.js';
import { HANDOFF_CEILING, adminOf } from './team.js';

/**
 * A group chat's round: what happens after the person writes in a group (owner,
 * 2026-11-09).
 *
 * Adapted from DS Bot's group chats (NOTICE): a message that calls nobody goes to the
 * admin; "@Name" calls that bot instead, and the bots one message calls start
 * together. A bot hands work to another by writing "@Name" in its reply; the member
 * does the work in its own context for this group and posts the result in the group;
 * then the bot that asked reads what came back and answers. Each member keeps its own
 * conversation per group — its private chat is never read here — and sees only what
 * was said in the group since it last looked.
 *
 * What changed for a hosted app where every turn is paid and a function lives at
 * most five minutes:
 *   - A hard ceiling on hand-offs per message (`HANDOFF_CEILING`): turns a bot's
 *     @mention starts, and the turns where the asker reads what came back. The
 *     person's own @mentions are always answered and are not counted.
 *   - One request runs the whole round and streams it; a round that runs out of the
 *     function's time stops starting turns and says so, rather than being cut off.
 *   - One stop ends every member's turn: they all run under one abort signal, and
 *     Stop on the group takes the group's run lease away (server/liveRuns.js).
 *   - A member's turn that stops for the person's yes is not left waiting where
 *     nobody can answer: the group is told, and its next turn moves on (the agent
 *     loop marks the call "not run").
 *   - No "everyone answers in turn" mode, no idle-relay guard, no reply timeouts and
 *     no late replies posted after the round: the ceiling and the deadline bound it.
 */

/** A member reads at most this many new group lines in one turn, and this much of each. */
const LINES_SHOWN = 24;
const LINE_CHARS = 4000;
/** A turn is not started with less time than this left in the round. */
const TURN_FLOOR_MS = 40_000;
/** The whole round, inside the function's 300 seconds. */
export const ROUND_BUDGET_MS = 285_000;

const PASS = /^\s*\[?PASS\]?\s*\.?\s*$/i;

/** One line of the log, as a member reads it. */
function lineOf(message, nameOf, adminId) {
  const text = String(message.text || '').slice(0, LINE_CHARS);
  if (message.notice) return `(${text})`;
  if (message.role === 'user') return `User: ${text}`;
  const name = nameOf(message.bot) || 'A bot that has been deleted';
  return `${name}${message.bot === adminId ? ' (admin)' : ''}: ${text}`;
}

/**
 * What a member is told when it is called: what is new in the group, why it is
 * called, and how to answer. Written into its own conversation for this group, as
 * the user's turn there.
 */
export function roundPrompt({ group, self, lines, why, together = [], nameOf }) {
  const adminId = adminOf(group);
  const news = lines.filter((m) => m.bot !== self.id);
  const shown = news.slice(-LINES_SHOWN);
  const parts = [`[Group chat "${group.name}"]`];
  parts.push(
    shown.length
      ? `New in the group since you last looked (oldest first)${news.length > shown.length ? `, the last ${shown.length} of ${news.length}` : ''}:\n${shown.map((m) => lineOf(m, nameOf, adminId)).join('\n')}`
      : 'Nothing new in the group since you last looked.',
  );
  parts.push(why);
  if (together.length) parts.push(`Called together with you: ${together.join(', ')}. You answer at the same time and do not see each other's replies until they post.`);
  parts.push(
    'Reply with your message for the group, without your name in front. Do the work in this turn when you are asked to do something, and end with the result, never a promise to do it later. ' +
      'Write "@Name" only when another member must act now. Reply [PASS] alone to stay silent when the message is not for you or you have nothing to add.',
  );
  return parts.join('\n\n');
}

/**
 * Run a group's round for the message the person just wrote.
 *
 * @param {{
 *   user: { id: string } & Record<string, any>,
 *   groupId: string,
 *   text: string,
 *   emit: (event: string, data: any) => void,
 *   signal: AbortSignal,
 *   deadlineAt?: number,
 *   runAgent?: typeof realRunAgent,
 *   origin?: string | null,
 *   model?: string,
 * }} options  `model`: the header chip's, which every member answers on
 * @returns {Promise<{ stopReason: string, turns: number, handoffs: number }>}
 */
export async function runGroupRound({ user, groupId, text, emit, signal, deadlineAt = Date.now() + ROUND_BUDGET_MS, runAgent = realRunAgent, origin = null, model = undefined }) {
  const store = getStore();
  const userId = user.id;
  const group = await store.getBotGroup(userId, groupId);
  if (!group) throw Object.assign(new Error('No such group chat.'), { status: 404 });
  const log = await store.botChat(userId, { groupId, title: group.name });
  const bots = await store.listBots(userId);
  const members = bots.filter((b) => (group.members || []).includes(b.id));
  const byId = new Map(bots.map((b) => [b.id, b]));
  const nameOf = (id) => byId.get(id)?.name;

  /** Writes one line into the group's log, and tells the page. */
  const post = async (message) => {
    const saved = await store.appendMessage(userId, log.id, { id: crypto.randomUUID(), ...message });
    emit('post', { message: saved });
    return saved;
  };
  const notice = (kind, words, params = {}) => post({ role: 'assistant', notice: kind, text: words, params });

  const said = String(text ?? '').trim();
  if (said) await post({ role: 'user', text: said });

  // Who answers the person: those named, else the admin.
  const named = mentionedBots(said, members);
  const admin = adminOf(group);
  let queue = (named.length ? named.map((b) => b.id) : admin ? [admin] : []).map((botId) => ({ botId, by: null, report: null }));
  let turns = 0;
  let handoffs = 0;
  let stopReason = 'end_turn';
  let ceilingSaid = false;

  /** One member's turn. Resolves to what it posted (or null), and whether it stopped for a yes. */
  async function memberTurn(item, together) {
    const self = byId.get(item.botId);
    if (!self || !(group.members || []).includes(self.id)) return null;
    const chat = await store.botChat(userId, { botId: self.id, groupId, title: `${self.name} · ${group.name}` });
    const fresh = await store.getBotGroup(userId, groupId);
    const seen = Number(fresh?.seen?.[self.id] ?? -1);
    const lines = await store.messagesSince(userId, log.id, seen);
    const why = item.report
      ? `What you handed on is back: ${item.report.map(nameOf).filter(Boolean).join(', ')} posted above. Answer with what came of it — for the user, or hand on the next step with @Name.`
      : item.by
        ? `${nameOf(item.by) || 'A member'} handed this to you with @${self.name}. Do it, and reply with the result for the group.`
        : said
          ? named.length
            ? `The user called you with @${self.name}. Answer them.`
            : 'The user wrote to the group and you are its admin: answer, or hand the work to the member who should do it with @Name.'
          : 'Carry on.';
    await store.appendMessage(userId, chat.id, { id: crypto.randomUUID(), role: 'user', text: roundPrompt({ group, self, lines, why, together, nameOf }) });
    if (lines.length) await store.markGroupSeen(userId, groupId, self.id, lines.at(-1).seq);

    emit('member_start', { bot: self.id });
    let waiting = false;
    let failed = '';
    try {
      await runAgent({
        userId,
        user,
        chatId: chat.id,
        // The header chip's model, the same for every member (owner, 2026-11-10); nothing decided or answered yet.
        modelId: model,
        decision: undefined,
        decisionFor: undefined,
        answers: undefined,
        deviceHint: undefined,
        // Nobody can answer a question card or press Connect inside a group.
        unattended: true,
        origin,
        signal,
        deadlineAt,
        emit: (event, data) => {
          if (event === 'text') emit('member_text', { bot: self.id, delta: data?.delta || '' });
          else if (event === 'thinking') emit('member_thinking', { bot: self.id });
          else if (event === 'tool_call') emit('member_tool', { bot: self.id, name: data?.name || '' });
          else if (event === 'approval_required') waiting = true;
          else if (event === 'error') failed = String(data?.message || 'error');
        },
      });
    } catch (err) {
      failed = String(err?.message || err);
    }
    emit('member_end', { bot: self.id });
    if (signal.aborted) return null;
    if (waiting) {
      await notice('approval', `${self.name} stopped: what it wanted to do next needs your yes, and nobody can give it in a group. Ask it in its own chat, or change what runs without asking in Settings.`, { bot: self.id });
      return null;
    }
    const after = await store.messagesSince(userId, chat.id, -1);
    const reply = [...after].reverse().find((m) => m.role === 'assistant' && String(m.text || '').trim());
    const lastUser = [...after].reverse().find((m) => m.role === 'user');
    const answer = reply && lastUser && reply.seq > lastUser.seq ? String(reply.text).trim() : '';
    if (!answer) {
      if (failed) await notice('failed', `${self.name} could not answer: ${redactSecrets(failed).text.slice(0, 200)}`, { bot: self.id });
      return null;
    }
    if (PASS.test(answer)) return null;
    // A model that echoes the transcript's "Name: " in front of its reply.
    const clean = answer.replace(new RegExp(`^${self.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\(admin\\))?\\s*:\\s*`, 'i'), '');
    return post({ role: 'assistant', text: clean, bot: self.id, ...(item.by ? { by: item.by } : {}) });
  }

  while (queue.length) {
    if (signal.aborted) break;
    if (Date.now() > deadlineAt - TURN_FLOOR_MS) {
      await notice('time', 'Out of time for this message. Write again to carry on.');
      stopReason = 'time';
      break;
    }
    // Hand-offs past the ceiling are dropped, once said; the person's own calls never are.
    const batch = [];
    for (const item of queue) {
      const counts = item.by || item.report;
      if (counts && handoffs >= HANDOFF_CEILING) {
        if (!ceilingSaid) {
          ceilingSaid = true;
          await notice('ceiling', `Stopped handing work on: ${HANDOFF_CEILING} hand-offs is the most one message starts. Write again to carry on.`, { n: HANDOFF_CEILING });
        }
        stopReason = 'handoff_ceiling';
        continue;
      }
      if (counts) handoffs += 1;
      batch.push(item);
    }
    if (!batch.length) break;
    const names = batch.map((item) => nameOf(item.botId)).filter(Boolean);
    const posts = await Promise.all(batch.map((item) => memberTurn(item, names.filter((n) => n !== nameOf(item.botId)))));
    turns += batch.length;
    if (signal.aborted) break;

    // What comes next: whoever the posts called, then the bots whose hand-offs came back.
    const next = [];
    const queued = new Set();
    const add = (entry) => {
      if (queued.has(entry.botId)) return;
      queued.add(entry.botId);
      next.push(entry);
    };
    posts.forEach((message, i) => {
      if (!message) return;
      for (const bot of mentionedBots(message.text, members)) if (bot.id !== message.bot) add({ botId: bot.id, by: message.bot, report: null });
    });
    /** @type {Map<string, string[]>} */
    const back = new Map();
    batch.forEach((item, i) => {
      if (!item.by || !posts[i]) return;
      back.set(item.by, [...(back.get(item.by) || []), item.botId]);
    });
    for (const [asker, from] of back) add({ botId: asker, by: null, report: from });
    queue = next;
  }

  if (signal.aborted) {
    stopReason = 'aborted';
    await notice('stopped', 'Stopped.').catch(() => {});
  }
  return { stopReason, turns, handoffs };
}
