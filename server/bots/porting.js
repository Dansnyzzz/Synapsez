import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { redactSecrets } from '../redact.js';
import { parseSchedule } from '../scheduler.js';
import { validZone } from '../util/zone.js';
import { BotError, LIMITS, createBot, createGroup, freeName, isCreature } from './team.js';
import { remember } from './memory.js';

/*
 * A team to and from a file (spec B.5): `synapsez-bots/1`, JSON.
 *
 * What goes out: each bot (name, role, creature, colour, instructions, memory review,
 * its memory and its scheduled tasks), each group (name, notice, members, admin, its
 * memory and tasks). Never a conversation, a key, an account id or a model choice.
 * Members and admins are named by a key local to the file, so a renamed import still
 * finds them.
 *
 * What comes in is the same shape, or less of it — an answer pasted from another
 * assistant (the migrate prompt) may be only bots with memory. It is checked as the
 * person's own typing would be: every memory entry through the same check that keeps
 * keys and passwords out of memory (an entry that fails is listed, not kept), the
 * instructions and task prompts with any secret struck out, a task imported paused.
 * A name already in use gets " (2)". Each bot or group is added whole or not at all:
 * one that fails part-way is taken back out, and the rest still come in.
 */

export const FORMAT = 'synapsez-bots/1';

/** At most this many memory entries come in for one bot or group: the migrate prompt asks for 60. */
const IMPORT_ENTRIES = 120;
/** And this many tasks. */
const IMPORT_TASKS = 20;

const text = (value, max) => String(value ?? '').normalize('NFC').trim().slice(0, max);
const struck = (value) => redactSecrets(value).text;

/**
 * The account's team as a file.
 *
 * @param {string} userId
 */
export async function exportTeam(userId) {
  const store = getStore();
  const [bots, groups, tasks] = await Promise.all([store.listBots(userId), store.listBotGroups(userId), store.listTeamTasks(userId)]);
  const keyOf = new Map(bots.map((b, i) => [b.id, `b${i + 1}`]));
  const memoryOf = async (scope) => (await store.listBotMemory(userId, scope)).map((e) => ({ text: e.text, ...(e.pinned ? { pinned: true } : {}) }));
  const tasksOf = (pick) =>
    tasks.filter(pick).map((t) => ({ title: t.title, prompt: t.prompt, ...(t.cron ? { when: t.cron } : {}), ...(t.tz ? { tz: t.tz } : {}), missed: t.missed || 'once' }));
  return {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    bots: await Promise.all(
      bots.map(async (b) => ({
        key: keyOf.get(b.id),
        name: b.name,
        role: b.role || '',
        creature: b.avatar,
        hue: Number(b.hue) || 0,
        instructions: b.instructions || '',
        reviewEvery: b.review_every ?? 20,
        ...(b.is_main ? { main: true } : {}),
        memory: await memoryOf({ botId: b.id }),
        tasks: tasksOf((t) => t.bot_id === b.id),
      })),
    ),
    groups: await Promise.all(
      groups.map(async (g) => ({
        name: g.name,
        notice: g.notice || '',
        members: (g.members || []).map((id) => keyOf.get(id)).filter(Boolean),
        ...(g.admin_bot_id && keyOf.has(g.admin_bot_id) ? { admin: keyOf.get(g.admin_bot_id) } : {}),
        memory: await memoryOf({ groupId: g.id }),
        tasks: tasksOf((t) => t.bot_group_id === g.id),
      })),
    ),
  };
}

/**
 * Read what the person gave: the object, or JSON text — fenced in ``` as another
 * assistant would answer — with anything around it.
 *
 * @param {unknown} data
 * @returns {{ bots: any[], groups: any[] }}
 */
export function readTeamFile(data) {
  let value = data;
  if (typeof value === 'string') {
    const raw = value.trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : raw.slice(Math.max(0, raw.indexOf('{')), raw.lastIndexOf('}') + 1);
    try {
      value = JSON.parse(body);
    } catch {
      throw new BotError('That is not a team file: it does not read as JSON.', 400, 'bad_file');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotError('That is not a team file.', 400, 'bad_file');
  const file = /** @type {any} */ (value);
  if (file.format && file.format !== FORMAT) throw new BotError(`This app reads ${FORMAT} files; that one is ${String(file.format).slice(0, 40)}.`, 400, 'bad_format');
  const bots = Array.isArray(file.bots) ? file.bots.filter((b) => b && typeof b === 'object') : [];
  const groups = Array.isArray(file.groups) ? file.groups.filter((g) => g && typeof g === 'object') : [];
  if (!bots.length && !groups.length) throw new BotError('That file has no bots and no groups in it.', 400, 'empty_file');
  if (bots.length > LIMITS.bots || groups.length > LIMITS.groups) throw new BotError(`A team file holds at most ${LIMITS.bots} bots and ${LIMITS.groups} groups.`, 400, 'too_many');
  return { bots, groups };
}

/**
 * What an import would add, or adds (`apply`), item by item.
 *
 * @param {string} userId
 * @param {unknown} data
 * @param {{ apply?: boolean }} [options]
 * @returns {Promise<{ items: Array<{ kind: 'bot' | 'group' | 'chief', name: string, as: string, memory: number, tasks: number, refused: string[], added?: boolean, error?: string }> }>}
 */
export async function importTeam(userId, data, { apply = false } = {}) {
  const store = getStore();
  const file = readTeamFile(data);
  const have = await store.listBots(userId);
  const groupsHave = await store.listBotGroups(userId);
  const chief = have.find((b) => b.is_main) || null;
  const takenBots = new Set(have.map((b) => b.name));
  const takenGroups = new Set(groupsHave.map((g) => g.name));
  /** File key (or name) → this account's bot id, as bots are added. */
  const idOf = new Map();
  const items = [];

  const entriesOf = (list) =>
    (Array.isArray(list) ? list : [])
      .slice(0, IMPORT_ENTRIES)
      .map((e) => (typeof e === 'string' ? { text: e } : e && typeof e === 'object' ? e : null))
      .filter(Boolean)
      .map((e) => ({ text: text(e.text, 2000), pinned: !!e.pinned }))
      .filter((e) => e.text);
  const tasksOf = (list) => (Array.isArray(list) ? list : []).slice(0, IMPORT_TASKS).filter((t) => t && typeof t === 'object');

  /** Memory in, through the same door as typing it: a secret is refused, a long note split. */
  const addMemory = async (scope, entries, refused) => {
    let n = 0;
    for (const e of entries) {
      try {
        const { entries: rows } = await remember(userId, scope, e.text, 'user');
        if (e.pinned) for (const row of rows) await store.updateBotMemory(userId, row.id, scope, { pinned: true, pinnedBy: 'user' });
        n += rows.length;
      } catch (err) {
        // What was refused is named, never echoed: a key in it stays struck out.
        const shown = struck(e.text);
        refused.push(`${shown.slice(0, 60)}${shown.length > 60 ? '…' : ''} — ${err instanceof BotError ? err.message : 'not kept'}`);
      }
    }
    return n;
  };
  /** Tasks in, paused: nothing runs until the person turns it on. */
  const addTasks = async (owner, tasks, refused) => {
    let n = 0;
    for (const t of tasks) {
      const title = text(t.title, 120);
      const prompt = struck(text(t.prompt, 8000));
      if (!title || !prompt) continue;
      const tz = validZone(t.tz) ? t.tz : null;
      let when = { cron: null, nextRunAt: null };
      try {
        if (t.when) when = parseSchedule(String(t.when), { tz });
      } catch {
        refused.push(`${title} — its schedule "${String(t.when).slice(0, 40)}" does not read`);
        continue;
      }
      await store.createTask(userId, { id: crypto.randomUUID(), title, prompt, model: null, cron: when.cron, nextRunAt: when.nextRunAt, tz, ...owner, missed: t.missed === 'skip' ? 'skip' : 'once', enabled: false });
      n += 1;
    }
    return n;
  };

  for (const [i, b] of file.bots.entries()) {
    const key = text(b.key, 40) || `#${i}`;
    const wanted = text(b.name, 200) || `Bot ${i + 1}`;
    const memory = entriesOf(b.memory);
    const tasks = tasksOf(b.tasks);
    // The file's Chief is this account's Chief: its memory and tasks join the one here.
    if (b.main && chief) {
      idOf.set(key, chief.id);
      idOf.set(wanted.toLowerCase(), chief.id);
      const item = { kind: /** @type {const} */ ('chief'), name: wanted, as: chief.name, memory: memory.length, tasks: tasks.length, refused: [] };
      if (apply) {
        item.memory = await addMemory({ botId: chief.id }, memory, item.refused);
        item.tasks = await addTasks({ botId: chief.id }, tasks, item.refused);
        item.added = true;
      }
      items.push(item);
      continue;
    }
    const as = freeName(wanted, takenBots);
    takenBots.add(as);
    const item = { kind: /** @type {const} */ ('bot'), name: wanted, as, memory: memory.length, tasks: tasks.length, refused: [] };
    items.push(item);
    if (!apply) continue;
    let made = null;
    try {
      made = await createBot(userId, { name: as, role: text(b.role, LIMITS.role), instructions: struck(text(b.instructions, LIMITS.instructions)), avatar: isCreature(b.creature) ? b.creature : undefined });
      const hue = Number(b.hue);
      const review = Number(b.reviewEvery);
      await store.updateBot(userId, made.id, { ...(Number.isFinite(hue) && hue % 30 === 0 && hue >= 0 && hue < 360 ? { hue } : {}), ...([0, 20, 40].includes(review) ? { reviewEvery: review } : {}) });
      item.memory = await addMemory({ botId: made.id }, memory, item.refused);
      item.tasks = await addTasks({ botId: made.id }, tasks, item.refused);
      idOf.set(key, made.id);
      idOf.set(wanted.toLowerCase(), made.id);
      item.added = true;
    } catch (err) {
      // All of this bot or none of it: what it brought goes with it.
      if (made) await store.deleteBot(userId, made.id).catch(() => {});
      item.added = false;
      item.error = err instanceof BotError ? err.message : 'It could not be added.';
    }
  }

  for (const [i, g] of file.groups.entries()) {
    const wanted = text(g.name, LIMITS.groupName) || `Group ${i + 1}`;
    const as = freeName(wanted, takenGroups).slice(0, LIMITS.groupName);
    takenGroups.add(as);
    const memory = entriesOf(g.memory);
    const tasks = tasksOf(g.tasks);
    const item = { kind: /** @type {const} */ ('group'), name: wanted, as, memory: memory.length, tasks: tasks.length, refused: [] };
    items.push(item);
    if (!apply) continue;
    const memberOf = (ref) => idOf.get(text(ref, 200)) || idOf.get(text(ref, 200).toLowerCase()) || null;
    const members = [...new Set((Array.isArray(g.members) ? g.members : []).map(memberOf).filter(Boolean))];
    let made = null;
    try {
      if (!members.length) throw new BotError('None of its members came in.', 400, 'no_members');
      const admin = memberOf(g.admin);
      made = await createGroup(userId, { name: as, members, ...(admin && members.includes(admin) ? { admin } : {}), notice: struck(text(g.notice, LIMITS.notice)) });
      item.memory = await addMemory({ groupId: made.id }, memory, item.refused);
      item.tasks = await addTasks({ botGroupId: made.id }, tasks, item.refused);
      item.added = true;
    } catch (err) {
      if (made) await store.deleteBotGroup(userId, made.id).catch(() => {});
      item.added = false;
      item.error = err instanceof BotError ? err.message : 'It could not be added.';
    }
  }
  return { items };
}
