import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { runAgent as realRunAgent } from '../agent.js';
import { redactSecrets } from '../redact.js';
import { mentionedBots } from '../../public/js/bot-mentions.js';
import { HANDOFF_CEILING, adminOf } from './team.js';
import { getPrefs } from '../settings.js';
import { translateMessage } from '../i18n/index.js';

/**
 * A group chat's round: what happens after the person writes in a group (owner,
 * 2026-11-09; segments 2026-11-10).
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
 *     person's own @mentions are always answered and are not counted. The ceiling
 *     stops the round where the person can see it, and Continue takes it on.
 *   - **A round runs in segments** (owner, 2026-11-10: three bots researching and
 *     writing a document were cut off at 300 s and nothing ever picked them up). What
 *     the round still has to do — the queue of member turns, the hand-offs spent, who
 *     owes whom an answer — is the group's `pending`, written after every batch. A
 *     segment that runs short of time saves it and asks for the next segment
 *     (`chain`); one that is killed outright leaves it for the heartbeat. A member cut
 *     off mid-step carries on in the next segment from where it stood — its turn is
 *     run again with no second prompt, and the agent loop resumes it — rather than
 *     starting the work over. At most `MAX_SEGMENTS` a message; then the person decides.
 *   - The person can write while the group works: each batch reads what they wrote
 *     since the last, and whom it calls answers in the same round.
 *   - The asker always gets its turn back when its hand-offs end — told who answered,
 *     who passed and who failed — so a round never ends in silence; an admin that
 *     passes on a message nobody else was called for says so.
 *   - Before each batch the round reads the group's model, so changing the chip while
 *     the group works carries on, on the new model.
 *   - One stop ends every member's turn: they all run under one abort signal, and
 *     Stop on the group takes the group's run lease away (server/liveRuns.js).
 *   - A member's turn that stops for the person's yes is not left waiting where
 *     nobody can answer: the group is told, and its next turn moves on (the agent
 *     loop marks the call "not run").
 *   - What a member makes in its turn — a document, a picture — rides on its post.
 *   - No "everyone answers in turn" mode and no idle-relay guard: the ceiling bounds it.
 */

/** A member reads at most this many new group lines in one turn, and this much of each. */
const LINES_SHOWN = 24;
const LINE_CHARS = 4000;
/** A turn is not started with less time than this left in the segment. */
const TURN_FLOOR_MS = 40_000;
/** One segment, inside the function's 300 seconds. */
export const ROUND_BUDGET_MS = 285_000;
/** Segments one message may run before the person is asked to Continue (≈ 38 minutes). */
export const MAX_SEGMENTS = 8;

/**
 * What a group has pending that goes on by itself (spec B.1, B.4): a segment ran short of
 * time ('time'), one is at work ('running'), or Chief or a scheduled task queued a round
 * that has not started yet ('chief', 'task'). The others — 'ceiling', 'segments' — wait
 * for Continue.
 */
export const RESUMABLE = Object.freeze(['time', 'running', 'chief', 'task']);

const PASS = /^\s*\[?PASS\]?\s*\.?\s*$/i;
/**
 * A post that only acknowledges — "Got it", "Thanks!", "On it" — said to another bot.
 * It costs every member a line to read and tells nobody anything, so it is a pass
 * (after dsh-superagent's communication rules, MIT; NOTICE).
 */
const ACK = /^(?:(?:ok(?:ay)?|got it|on it|noted|sure|thanks?|thank you|understood|will do|roger|đã rõ|rõ rồi|ok nhé|cảm ơn|nhận rồi|đã nhận|được rồi|mình làm ngay|đang làm)[\s,.!…]*)+$/iu;
/** A reply that only promises the work ("I'll draft it now."), with no tool used for it. */
const PROMISE = /^(?:i(?:'ll| will| am going to|'m going to)|let me|tôi sẽ|để tôi|mình sẽ|em sẽ)\b/iu;
/** A message that only says "carry on" takes on what waits, rather than starting over. */
const CONTINUE_WORDS = /^\s*(continue|go on|carry on|keep going|tiếp tục|làm tiếp|tiếp đi|tiếp)\s*[.!…]*\s*$/i;

/** One line of the log, as a member reads it. */
function lineOf(message, nameOf, adminId) {
  const files = (message.files || []).map((f) => f.name).filter(Boolean);
  const text = `${String(message.text || '')}${files.length ? ` [files: ${files.join(', ')}]` : ''}`.slice(0, LINE_CHARS);
  if (message.notice) return `(${text})`;
  if (message.role === 'user') return `User: ${text}`;
  const name = nameOf(message.bot) || 'A bot that has been deleted';
  return `${name}${message.bot === adminId ? ' (admin)' : ''}${message.ask ? ' (asking the user)' : ''}: ${text}`;
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
  // The group's standing note, from the user, at the top of every turn (owner, 2026-11-10).
  if (String(group.notice || '').trim()) parts.push(`Group notice (the user wrote it; follow it here):\n${String(group.notice).trim()}`);
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

/** What the bot that handed work on is told when it comes back. */
function reportWhy(report, nameOf) {
  const names = (ids) => (ids || []).map(nameOf).filter(Boolean).join(', ');
  const said = [];
  if (report.answered?.length) said.push(`${names(report.answered)} posted above.`);
  if (report.passed?.length) said.push(`${names(report.passed)} gave no answer — do not wait for ${report.passed.length === 1 ? 'it' : 'them'}.`);
  if (report.failed?.length) said.push(`${names(report.failed)} could not answer.`);
  if (report.paused?.length) said.push(`${names(report.paused)} ${report.paused.length === 1 ? 'is' : 'are'} paused by the user and took no part: hand ${report.paused.length === 1 ? 'it' : 'them'} nothing until the user resumes ${report.paused.length === 1 ? 'it' : 'them'}.`);
  return `What you handed on is back: ${said.join(' ') || 'nobody answered.'} Answer with what came of it — for the user, or hand on the next step with @Name.`;
}

/**
 * Run a segment of a group's round: for the message the person just wrote, or —
 * `resume` — from what the group has pending.
 *
 * @param {{
 *   user: { id: string } & Record<string, any>,
 *   groupId: string,
 *   text?: string,
 *   emit: (event: string, data: any) => void,
 *   signal: AbortSignal,
 *   deadlineAt?: number,
 *   runAgent?: typeof realRunAgent,
 *   origin?: string | null,
 *   model?: string,
 *   resume?: boolean,
 *   fresh?: boolean,
 *   chain?: ((userId: string, groupId: string) => void) | null,
 *   floorMs?: number,
 * }} options  `model`: the header chip's, which every member answers on; `resume`: carry
 *   on what is pending; `fresh`: the person pressed Continue, so the ceiling and the
 *   segments start again; `chain`: ask for the next segment (once, when this one runs
 *   short of time)
 * @returns {Promise<{ stopReason: string, turns: number, handoffs: number, pending: boolean }>}
 */
export async function runGroupRound({ user, groupId, text = '', emit, signal, deadlineAt = Date.now() + ROUND_BUDGET_MS, runAgent = realRunAgent, origin = null, model = undefined, resume = false, fresh = false, chain = null, floorMs = TURN_FLOOR_MS }) {
  const store = getStore();
  const userId = user.id;
  let group = await store.getBotGroup(userId, groupId);
  if (!group) throw Object.assign(new Error('No such group chat.'), { status: 404 });
  const log = await store.botChat(userId, { groupId, title: group.name });
  const bots = await store.listBots(userId);
  const members = bots.filter((b) => (group.members || []).includes(b.id));
  const byId = new Map(bots.map((b) => [b.id, b]));
  const nameOf = (id) => byId.get(id)?.name;

  const said = String(text ?? '').trim();
  const waiting = group.pending && ['ceiling', 'segments'].includes(group.pending.reason);
  // A round still working between two segments (or one a killed invocation left): what
  // the person writes joins it — the queue goes on, and the scan answers their line.
  const working = group.pending && RESUMABLE.includes(group.pending.reason);
  let joining = false;
  if (!resume && said && working) {
    resume = true;
    joining = true;
  }
  // "Continue" in words takes on what waits; any other message lets it go.
  if (!resume && said && waiting && CONTINUE_WORDS.test(said)) {
    resume = true;
    fresh = true;
  }

  /** @type {any} */
  let state;
  if (resume) {
    if (!group.pending) return { stopReason: 'end_turn', turns: 0, handoffs: 0, pending: false };
    state = structuredClone(group.pending);
    state.queue ||= [];
    state.owed ||= {};
    state.called ||= [];
    state.working = [];
    if (fresh) {
      state.handoffs = 0;
      state.segments = 0;
    }
  } else {
    if (!model && group.model) model = group.model;
    state = { messageId: null, queue: [], handoffs: 0, segments: 0, model: model || null, reason: 'running', owed: {}, working: [], called: [], lastSeq: -1 };
  }
  let lastSeq = Number.isFinite(Number(state.lastSeq)) ? Number(state.lastSeq) : -1;

  const save = async (patch = {}) => {
    Object.assign(state, patch, { lastSeq, at: new Date().toISOString() });
    await store.setGroupPending(userId, groupId, state);
  };
  /**
   * Writes one line into the group's log, and tells the page. `lastSeq` is moved only
   * by the scan for the person's lines below: a post of the round's own can land after
   * a line the person wrote a moment before it, and must not hide that line.
   */
  const post = async (message) => {
    const saved = await store.appendMessage(userId, log.id, { id: crypto.randomUUID(), ...message });
    emit('post', { message: saved });
    return saved;
  };
  const notice = (kind, words, params = {}) => post({ role: 'assistant', notice: kind, text: words, params });

  /*
   * A question a member asked the person (`ask_person`) that nothing they wrote has answered
   * yet: their plain line answers it, so it goes to that member first, not the admin.
   */
  let asker = null;
  if (said && !resume) {
    const history = await store.listMessages(userId, log.id);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const m = history[i];
      if (m.role === 'user' && !m.notice) break;
      if (m.ask && m.bot && members.some((b) => b.id === m.bot)) {
        asker = m.bot;
        break;
      }
    }
  }

  /** The person's line this segment wrote itself: already in the queue, not news to the scan. */
  let ownLine = null;
  if (said) {
    const line = await post({ role: 'user', text: said });
    // Joining a round, the line is news like any other the person wrote: the scan queues whom it calls.
    ownLine = joining ? null : line?.id || null;
    // A new round reads the person's lines from its own on: what came before was answered before.
    if (!resume && Number.isFinite(Number(line?.seq))) lastSeq = Number(line.seq);
    if (!resume) {
      state.messageId = line?.id || null;
      const named = mentionedBots(said, members);
      const admin = adminOf(group);
      state.queue = named.length
        ? named.map((b) => ({ botId: b.id, by: null, report: null, person: 'named' }))
        : asker
          ? [{ botId: asker, by: null, report: null, person: 'answer' }]
          : admin
            ? [{ botId: admin, by: null, report: null, person: 'admin' }]
            : [];
      state.called = state.queue.map((q) => ({ bot: q.botId, how: 'called' }));
    }
  }
  if (!resume && model) await store.setGroupModel(userId, groupId, model);

  if ((state.segments || 0) >= MAX_SEGMENTS) {
    await notice('segments', 'The group has worked on this for a long while. Press Continue to let it carry on.');
    await save({ reason: 'segments' });
    return { stopReason: 'segments', turns: 0, handoffs: state.handoffs || 0, pending: true };
  }
  state.segments = (state.segments || 0) + 1;
  await save({ reason: 'running' });

  let turns = 0;
  let stopReason = 'end_turn';
  /** Hand-offs the ceiling did not start: what Continue takes on. */
  const dropped = [];
  let ceilingSaid = false;

  /** Why a member is called, in one or two sentences. */
  const whyFor = (item, self) => {
    const parts = [];
    if (item.by) parts.push(`${nameOf(item.by) || 'A member'} handed this to you with @${self.name}. Do it, and reply with the result for the group.`);
    if (item.report) parts.push(reportWhy(item.report, nameOf));
    if (!parts.length) {
      if (item.person === 'named') parts.push(`The user called you with @${self.name}. Answer them.`);
      else if (item.person === 'answer') parts.push("You asked the user a question in the group; their answer is the newest line. Carry on with it.");
      else if (item.person === 'admin') parts.push('The user wrote to the group and you are its admin: answer, or hand the work to the member who should do it with @Name.');
      else if (item.person === 'chief') parts.push(`${nameOf(item.from) || "The user's main bot"} wrote the newest line to the group for the user. Do what it asks, or hand the work to the member who should do it with @Name, and reply with the result for the group.`);
      else if (item.person === 'task') parts.push("The user's scheduled task for this group posted the newest line. Do it and reply with the result for the group; reply [PASS] when there is nothing worth saying this time.");
      else parts.push('Carry on.');
    }
    return parts.join(' ');
  };

  /**
   * Who started a member's turn: the person's own call; a scheduled task's ('task'); or a
   * bot — a hand-off, the turn reading what came back, or Chief writing to the group.
   */
  const originOf = (item) => (item.by || item.report || !item.person || item.person === 'chief' ? 'handoff' : item.person === 'task' ? 'task' : 'person');

  /** Who this message called and how each went, for the strip above the box (spec B.3). */
  const mark = (botId, how) => {
    state.called ||= [];
    const have = state.called.find((c) => c.bot === botId);
    if (have) have.how = how;
    else state.called.push({ bot: botId, how });
  };

  const setWorking = async (botId, tool) => {
    state.working = (state.working || []).filter((w) => w.bot !== botId);
    if (tool !== null) state.working.push({ bot: botId, tool: tool || '', since: new Date().toISOString() });
    await save().catch(() => {});
  };

  /**
   * One member's turn. Resolves to what it posted, if anything, and how it went:
   * answered, passed, failed, waiting (for a yes), unfinished (cut off by the
   * segment's end — the next segment carries it on), gone (no longer a member), or
   * paused (the person paused it, so it sits rounds out — spec B.5).
   */
  async function memberTurn(item, together) {
    const self = byId.get(item.botId);
    if (!self || !(group.members || []).includes(self.id)) return { message: null, outcome: 'gone' };
    // A paused bot sits rounds out (spec B.5): the group is told, and it counts as passing.
    if (self.paused_at) {
      await notice('paused', `${self.name} is paused.`, { bot: self.id });
      return { message: null, outcome: 'paused' };
    }
    const chat = await store.botChat(userId, { botId: self.id, groupId, title: `${self.name} · ${group.name}` });
    const since = new Date(Date.now() - 1000);
    if (!item.resume) {
      const current = await store.getBotGroup(userId, groupId);
      const seen = Number(current?.seen?.[self.id] ?? -1);
      const lines = await store.messagesSince(userId, log.id, seen);
      await store.appendMessage(userId, chat.id, {
        id: crypto.randomUUID(),
        role: 'user',
        text: roundPrompt({ group, self, lines, why: whyFor(item, self), together, nameOf }),
        // Who started this turn, for the tools only a person's turn may run, and whether
        // other bots' words are in it (server/agent.js, owner 2026-11-10).
        origin: originOf(item),
        groupLines: lines.some((m) => m.role === 'assistant' && m.bot && m.bot !== self.id && !m.notice),
      });
      // From here on a cut-off continues this turn rather than prompting it again.
      item.resume = true;
      item.seenTo = lines.length ? Number(lines.at(-1).seq) : null;
      item.since = since.toISOString();
    }
    mark(self.id, 'working');
    await setWorking(self.id, '');

    emit('member_start', { bot: self.id });
    let waitingForYes = false;
    let failed = '';
    try {
      await runAgent({
        userId,
        user,
        chatId: chat.id,
        // The header chip's model, the same for every member (owner, 2026-11-10); nothing decided or answered yet.
        modelId: state.model || undefined,
        decision: undefined,
        decisionFor: undefined,
        answers: undefined,
        deviceHint: undefined,
        // Nobody can answer a question card or press Connect inside a group.
        unattended: true,
        turnOrigin: originOf(item),
        origin,
        signal,
        deadlineAt,
        emit: (event, data) => {
          if (event === 'text') emit('member_text', { bot: self.id, delta: data?.delta || '' });
          else if (event === 'thinking') emit('member_thinking', { bot: self.id });
          else if (event === 'tool_call') {
            emit('member_tool', { bot: self.id, name: data?.name || '' });
            void setWorking(self.id, data?.name || '');
          } else if (event === 'approval_required') waitingForYes = true;
          else if (event === 'error') failed = String(data?.message || 'error');
        },
      });
    } catch (err) {
      failed = String(err?.message || err);
    }
    emit('member_end', { bot: self.id });
    await setWorking(self.id, null);
    if (signal.aborted) return { message: null, outcome: 'aborted' };
    if (waitingForYes) {
      await notice('approval', `${self.name} stopped: what it wanted to do next needs your yes, and nobody can give it in a group. Ask it in its own chat, or change what runs without asking in Settings.`, { bot: self.id });
      return { message: null, outcome: 'waiting' };
    }
    const after = await store.messagesSince(userId, chat.id, -1);
    const reply = [...after].reverse().find((m) => m.role === 'assistant' && String(m.text || '').trim());
    const lastUser = [...after].reverse().find((m) => m.role === 'user');
    const answer = reply && lastUser && reply.seq > lastUser.seq ? String(reply.text).trim() : '';
    const made = await store.listMadeFiles(userId, chat.id, item.since || since.toISOString()).catch(() => []);
    if (!answer && !made.length) {
      // Cut off by this segment's end rather than failed: the next segment carries it on.
      if (Date.now() > deadlineAt - floorMs) return { message: null, outcome: 'unfinished' };
      if (failed) {
        await notice('failed', `${self.name} could not answer: ${redactSecrets(failed).text.slice(0, 200)}`, { bot: self.id });
        return { message: null, outcome: 'failed' };
      }
    }
    // Only a promise, no tool used, asked by another bot: once more, to do it now.
    const used = after.some((m) => m.role === 'assistant' && lastUser && m.seq > lastUser.seq && m.toolCalls?.length);
    if (answer && !made.length && !used && item.by && !item.retried && PROMISE.test(answer) && answer.split(/\s+/).length <= 40 && state.handoffs < HANDOFF_CEILING) {
      state.handoffs += 1;
      await store.appendMessage(userId, chat.id, { id: crypto.randomUUID(), role: 'user', text: 'You only said what you will do. Do it now, in this turn, and reply with the result.', origin: originOf(item) });
      return memberTurn({ ...item, retried: true, seenTo: item.seenTo, since: item.since || since.toISOString() }, together);
    }
    if (item.seenTo != null) await store.markGroupSeen(userId, groupId, self.id, item.seenTo);
    if (!made.length && (!answer || PASS.test(answer) || (item.by && ACK.test(answer)))) return { message: null, outcome: 'passed' };
    // A model that echoes the transcript's "Name: " in front of its reply.
    const clean = (PASS.test(answer) ? '' : answer).replace(new RegExp(`^${self.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\(admin\\))?\\s*:\\s*`, 'i'), '');
    const files = made.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: Number(f.bytes) || 0 }));
    const message = await post({ role: 'assistant', text: clean || files.map((f) => `📎 ${f.name}`).join('\n'), bot: self.id, ...(item.by ? { by: item.by } : {}), ...(files.length ? { files } : {}) });
    return { message, outcome: 'answered' };
  }

  while (true) {
    if (signal.aborted) break;
    const current = await store.getBotGroup(userId, groupId);
    if (!current) break;
    group = current;
    // What the person wrote since the last batch: whom it calls answers in this round, uncounted.
    for (const line of await store.messagesSince(userId, log.id, lastSeq)) {
      lastSeq = Math.max(lastSeq, Number(line.seq));
      if (line.role !== 'user' || line.notice || line.id === ownLine || !String(line.text || '').trim()) continue;
      const named = mentionedBots(line.text, members);
      const targets = named.length ? named.map((b) => b.id) : adminOf(group) ? [adminOf(group)] : [];
      for (const botId of targets) {
        if (!state.queue.some((q) => q.botId === botId && !q.resume)) {
          state.queue.push({ botId, by: null, report: null, person: named.length ? 'named' : 'admin' });
          mark(botId, 'called');
        }
      }
    }
    if (!state.queue.length) break;
    if (Date.now() > deadlineAt - floorMs) {
      // Short of time: what is left waits for the next segment, which is asked for now.
      stopReason = 'time';
      await save({ reason: 'time' });
      emit('paused', { reason: 'time' });
      try {
        chain?.(userId, groupId);
      } catch {
        /* the heartbeat picks it up */
      }
      return { stopReason, turns, handoffs: state.handoffs, pending: true };
    }
    // The chip's model now: a change while the group works is the next batch's model.
    if (group.model) state.model = group.model;

    // Hand-offs past the ceiling wait for Continue; the person's own calls never do.
    const batch = [];
    for (const item of state.queue) {
      const counts = (item.by || item.report) && !item.counted;
      if (counts && state.handoffs >= HANDOFF_CEILING) {
        dropped.push(item);
        continue;
      }
      if (counts) {
        state.handoffs += 1;
        item.counted = true;
      }
      batch.push(item);
    }
    if (dropped.length && !ceilingSaid) {
      ceilingSaid = true;
      stopReason = 'handoff_ceiling';
      await notice('ceiling', `Stopped handing work on: ${HANDOFF_CEILING} hand-offs is the most one message starts. Press Continue to carry on.`, { n: HANDOFF_CEILING });
    }
    state.queue = batch;
    if (!batch.length) break;
    await save({ reason: 'running' });

    const names = batch.map((item) => nameOf(item.botId)).filter(Boolean);
    const results = await Promise.all(batch.map((item) => memberTurn(item, names.filter((n) => n !== nameOf(item.botId)))));
    turns += batch.length;
    if (signal.aborted) break;

    // What comes next: the unfinished first, as they were; then whoever the posts
    // called; then the bots whose hand-offs have all come back.
    /** @type {any[]} */
    const next = [];
    const add = (entry) => {
      const have = next.find((q) => q.botId === entry.botId && !q.resume);
      if (!have) next.push(entry);
      else if (entry.report && !have.report) have.report = entry.report;
    };
    results.forEach((r, i) => {
      if (r.outcome === 'unfinished') next.push(batch[i]);
      const how = { answered: 'answered', passed: 'passed', gone: 'passed', failed: 'failed', waiting: 'waiting', paused: 'paused' }[r.outcome];
      if (how) mark(batch[i].botId, how);
    });
    for (const r of results) {
      if (!r.message) continue;
      for (const bot of mentionedBots(r.message.text, members)) if (bot.id !== r.message.bot) add({ botId: bot.id, by: r.message.bot, report: null });
    }
    batch.forEach((item, i) => {
      const r = results[i];
      if (!item.by || r.outcome === 'unfinished' || r.outcome === 'aborted') return;
      const owed = (state.owed[item.by] ||= { answered: [], passed: [], failed: [], paused: [] });
      const kind = r.outcome === 'answered' ? 'answered' : r.outcome === 'passed' || r.outcome === 'gone' ? 'passed' : r.outcome === 'paused' ? 'paused' : 'failed';
      (owed[kind] ||= []);
      if (!owed[kind].includes(item.botId)) owed[kind].push(item.botId);
    });
    for (const [asker, owed] of Object.entries(state.owed)) {
      if (next.some((q) => q.by === asker) || dropped.some((q) => q.by === asker)) continue;
      add({ botId: asker, by: null, report: owed });
      delete state.owed[asker];
    }
    // The admin, the only one the person's message reached, passed: say so.
    const only = batch.length === 1 ? batch[0] : null;
    if (only && only.person === 'admin' && !only.by && !only.report && results[0].outcome === 'passed' && !next.length) {
      await notice('nobody', 'Nobody answered. Call a member with @Name to ask them.');
    }
    for (const q of next) if (!q.resume) mark(q.botId, 'called');
    state.queue = next;
    await save({ reason: 'running' });
  }

  if (signal.aborted) {
    await store.setGroupPending(userId, groupId, null).catch(() => {});
    await notice('stopped', 'Stopped.').catch(() => {});
    return { stopReason: 'aborted', turns, handoffs: state.handoffs, pending: false };
  }
  if (dropped.length) {
    state.queue = dropped;
    await save({ reason: 'ceiling', working: [] });
    return { stopReason: 'handoff_ceiling', turns, handoffs: state.handoffs, pending: true };
  }
  await store.setGroupPending(userId, groupId, null);
  if (state.notify?.chatId) await tellStarter(userId, state.notify, group).catch(() => {});
  return { stopReason, turns, handoffs: state.handoffs, pending: false };
}

/**
 * Chief's own chat hears once when a round it started has ended (spec B.1): one line, in
 * the person's language, naming the group.
 */
async function tellStarter(userId, notify, group) {
  const prefs = await getPrefs(userId).catch(() => /** @type {any} */ ({}));
  const text = translateMessage(`${group.name} is done — see the group.`, prefs?.language === 'vi' ? 'vi' : 'en');
  await getStore().appendMessage(userId, notify.chatId, { id: crypto.randomUUID(), role: 'assistant', text, groupDone: group.id });
}

/**
 * Queue a round that runs by itself (spec B.1, B.4): Chief writing to a group for the
 * person (`by`: Chief's id, reason 'chief'), or a group's scheduled task (reason 'task').
 * Writes the line, queues the members it names or else the admin, and saves the group's
 * `pending`; whoever calls this then starts it (`continueGroup`, or `chainNext`).
 * Refused while the group is at work or has a round waiting to start.
 *
 * @param {{ userId: string, groupId: string, text: string, reason: 'chief' | 'task', by?: string | null, notify?: { chatId: string } | null }} options
 * @returns {Promise<{ started: boolean, why?: 'gone' | 'busy' | 'empty' | 'nobody', messageId?: string }>}
 */
export async function startPendingRound({ userId, groupId, text, reason, by = null, notify = null }) {
  const store = getStore();
  const group = await store.getBotGroup(userId, groupId);
  if (!group) return { started: false, why: 'gone' };
  if (group.pending && RESUMABLE.includes(group.pending.reason)) return { started: false, why: 'busy' };
  const said = String(text ?? '').trim();
  if (!said) return { started: false, why: 'empty' };
  const bots = await store.listBots(userId);
  const members = bots.filter((b) => (group.members || []).includes(b.id));
  const named = mentionedBots(said, members);
  const admin = adminOf(group);
  const targets = named.length ? named.map((b) => b.id) : admin ? [admin] : [];
  if (!targets.length) return { started: false, why: 'nobody' };
  const log = await store.botChat(userId, { groupId, title: group.name });
  const line = await store.appendMessage(
    userId,
    log.id,
    by ? { id: crypto.randomUUID(), role: 'assistant', bot: by, text: said, via: reason } : { id: crypto.randomUUID(), role: 'user', text: said, origin: 'task' },
  );
  const queue = targets.map((botId) => ({ botId, by: null, report: null, person: reason, ...(by ? { from: by } : {}) }));
  await store.setGroupPending(userId, groupId, {
    messageId: line?.id || null,
    queue,
    handoffs: 0,
    segments: 0,
    model: group.model || null,
    reason,
    owed: {},
    working: [],
    called: queue.map((q) => ({ bot: q.botId, how: 'called' })),
    lastSeq: Number.isFinite(Number(line?.seq)) ? Number(line.seq) : -1,
    notify,
    at: new Date().toISOString(),
  });
  return { started: true, messageId: line?.id };
}
