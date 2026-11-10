import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { DRAWN_IDS } from '../../public/js/mascots/index.js';
import { nameProblem, NAME_MAX } from '../../public/js/bot-mentions.js';

/**
 * Bots: the account's team (owner, 2026-11-09).
 *
 * A bot is a long-lived helper with a name, a role, one of the app's own pixel
 * creatures as its face, a model of its own and instructions the person wrote. It
 * keeps a memory of its own. One of them is the main bot, Chief, made the first time
 * the Bot page opens; Chief is the one that sets the team up — it creates bots and
 * group chats when the person asks it to, so nobody has to fill in a form.
 *
 * The shape follows DS Bot (github.com/Fei2411/DS-Bot, Apache-2.0; NOTICE): a main
 * bot that runs the team, group chats with an admin that answers first, @mentions
 * that hand work on. What changed for a web app many people share: every row is
 * scoped to an account, a bot's chat is an ordinary conversation of this app run by
 * the same agent loop, and a group's round has a hard ceiling on hand-offs because
 * every extra speaker is paid for.
 *
 * This file holds the rules every route and tool share: limits, names, the creature
 * a new bot gets, and Chief.
 */

/** How many of each an account may have. Generous for a team; a stop for a loop that makes bots. */
export const LIMITS = Object.freeze({
  bots: 24,
  groups: 20,
  members: 12,
  role: 40,
  instructions: 4000,
  groupName: 60,
  /** One memory entry: one fact. */
  entry: 300,
  /** Entries a bot, or a group, keeps. */
  entries: 60,
});

/**
 * A group round's hard ceiling on hand-offs: member turns started by a bot's
 * @mention, and the turns where the bot that asked reads what came back. Each one
 * re-reads its whole context, so a loop between two bots would otherwise run until
 * the function's time ran out, on the person's money. DS Bot has no such ceiling
 * (its user sees and stops every bot on their own machine); a hosted app that bills
 * per call keeps one.
 */
export const HANDOFF_CEILING = 6;

/** The creatures a bot may wear, in the order a new bot is given them. */
export const CREATURES = Object.freeze([...DRAWN_IDS]);
export const isCreature = (id) => CREATURES.includes(String(id || ''));

/** Chief's face: the whale the app is known by, in its cosmic form. */
const CHIEF_AVATAR = 'cosmic-whale';

const CHIEF_ROLE = { en: 'Chief of Staff', vi: 'Chánh văn phòng' };

/** An error a person can act on, with the status a route answers it with. */
export class BotError extends Error {
  /** @param {string} message @param {number} [status] @param {string} [code] */
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NAME_WORDS = {
  'bots.name.empty': 'A bot needs a name.',
  'bots.name.long': `A bot's name is at most ${NAME_MAX} characters.`,
  'bots.name.chars': 'A bot\'s name cannot contain @, `, < or > or a line break.',
  'bots.name.reserved': 'That word stands for the user or for everyone in a chat, so it cannot be a bot\'s name.',
};

/** A name, checked and trimmed; throws a BotError a person can read. @param {unknown} name */
export function cleanName(name) {
  const problem = nameProblem(name);
  if (problem) throw new BotError(NAME_WORDS[problem], 400, 'bad_name');
  return String(name).trim().replace(/\s+/g, ' ');
}

/** @param {unknown} text @param {number} max @param {string} what */
export function cleanText(text, max, what) {
  const value = String(text ?? '').trim();
  if (value.length > max) throw new BotError(`${what} is at most ${max} characters.`, 400, 'too_long');
  return value;
}

/** A model id as the picker writes them, or null for the account's own. @param {unknown} model */
export function cleanModel(model) {
  if (model === null || model === undefined || model === '') return null;
  const id = String(model).trim();
  if (!/^[\w.:/@+-]{1,200}$/.test(id)) throw new BotError('That is not a model id.', 400, 'bad_model');
  return id;
}

/** The creature for a bot: the one asked for if it exists, else the first the team does not wear yet. */
export function pickCreature(asked, taken = []) {
  if (isCreature(asked)) return String(asked);
  const used = new Set(taken);
  return CREATURES.find((id) => !used.has(id) && id !== CHIEF_AVATAR) || CREATURES[Math.floor(Math.random() * CREATURES.length)];
}

/** The colours a creature can come in: as drawn, then eleven turns of the wheel. */
export const HUES = Object.freeze([0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);

/**
 * The colour for a creature a bot is to wear (owner, 2026-11-10): as drawn when no other
 * bot of the account wears it, otherwise one picked at random from those no bot wearing
 * it has, so no two bots in an account look alike. Chief keeps the cosmic whale as drawn.
 *
 * @param {string} creature @param {{ avatar: string, hue?: number }[]} others  the account's other bots
 * @param {() => number} [random]
 */
export function pickHue(creature, others, random = Math.random) {
  const taken = new Set(others.filter((b) => b.avatar === creature).map((b) => Number(b.hue) || 0));
  if (!taken.has(0)) return 0;
  const free = HUES.filter((h) => !taken.has(h));
  if (!free.length) return 0;
  return free[Math.floor(random() * free.length)];
}

/**
 * Give any bot that looks like another of the account's (the same creature in the same
 * colour) a colour of its own. Bots made before schema 43 could share one; Chief is
 * never the one recoloured. Returns whether anything changed.
 *
 * @param {string} userId
 */
export async function distinctFaces(userId) {
  const store = getStore();
  const bots = await store.listBots(userId);
  const seen = [];
  let changed = false;
  for (const bot of [...bots].sort((a, b) => Number(!!b.is_main) - Number(!!a.is_main))) {
    const clash = seen.some((o) => o.avatar === bot.avatar && (Number(o.hue) || 0) === (Number(bot.hue) || 0));
    if (clash) {
      const hue = pickHue(bot.avatar, seen);
      await store.updateBot(userId, bot.id, { hue });
      seen.push({ ...bot, hue });
      changed = true;
    } else seen.push(bot);
  }
  return changed;
}

/**
 * The account's main bot, made now if it has none: Chief, Chief of Staff, the
 * cosmic whale, on the account's own model. Safe to call from two tabs at once
 * (the store's unique index decides).
 *
 * @param {string} userId @param {{ language?: string }} [prefs]
 */
export async function ensureChief(userId, prefs = {}) {
  const store = getStore();
  return store.ensureMainBot(userId, {
    id: crypto.randomUUID(),
    name: 'Chief',
    role: CHIEF_ROLE[prefs.language === 'vi' ? 'vi' : 'en'],
    avatar: CHIEF_AVATAR,
    model: null,
    instructions: '',
  });
}

/**
 * A new bot, checked. `by` is who asked: the person (a form) or a bot's id (Chief's
 * tool) — said in the error, so a model reads why it was refused.
 *
 * @param {string} userId
 * @param {{ name: unknown, role?: unknown, instructions?: unknown, avatar?: unknown, model?: unknown }} input
 */
export async function createBot(userId, input) {
  const store = getStore();
  const name = cleanName(input.name);
  const role = cleanText(input.role, LIMITS.role, 'A role');
  const instructions = cleanText(input.instructions, LIMITS.instructions, 'Instructions');
  const model = cleanModel(input.model);
  const bots = await store.listBots(userId);
  if (bots.length >= LIMITS.bots) throw new BotError(`An account keeps at most ${LIMITS.bots} bots. Delete one first.`, 409, 'too_many');
  if (bots.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new BotError(`There is already a bot called ${name}.`, 409, 'name_taken');
  const avatar = pickCreature(input.avatar, bots.map((b) => b.avatar));
  const hue = pickHue(avatar, bots);
  const bot = await store.createBot(userId, { id: crypto.randomUUID(), name, role, instructions, avatar, model, hue });
  if (!bot) throw new BotError(`There is already a bot called ${name}.`, 409, 'name_taken');
  return bot;
}

/**
 * Change a bot, checked. Only the fields given change.
 *
 * @param {string} userId @param {string} id
 * @param {{ name?: unknown, role?: unknown, instructions?: unknown, avatar?: unknown, model?: unknown }} input
 */
export async function updateBot(userId, id, input) {
  const store = getStore();
  const patch = {};
  if (input.name !== undefined) patch.name = cleanName(input.name);
  if (input.role !== undefined) patch.role = cleanText(input.role, LIMITS.role, 'A role');
  if (input.instructions !== undefined) patch.instructions = cleanText(input.instructions, LIMITS.instructions, 'Instructions');
  if (input.model !== undefined) patch.model = cleanModel(input.model);
  if (input.avatar !== undefined) {
    if (!isCreature(input.avatar)) throw new BotError('That is not one of the creatures.', 400, 'bad_avatar');
    patch.avatar = String(input.avatar);
    const current = await store.getBot(userId, id);
    // Chief keeps the cosmic whale (owner, 2026-11-10). The form sends the one it wears with every save.
    if (current?.is_main && current.avatar !== patch.avatar) throw new BotError('Chief keeps the cosmic whale.', 400, 'chief_avatar');
    if (current && current.avatar !== patch.avatar) {
      const others = (await store.listBots(userId)).filter((b) => b.id !== id);
      patch.hue = pickHue(patch.avatar, others);
    }
  }
  if (patch.name) {
    const other = await store.getBotByName(userId, patch.name);
    if (other && other.id !== id) throw new BotError(`There is already a bot called ${patch.name}.`, 409, 'name_taken');
  }
  const before = patch.name ? await store.getBot(userId, id) : null;
  try {
    const bot = await store.updateBot(userId, id, patch);
    if (!bot) throw new BotError('No such bot.', 404, 'not_found');
    if (before && before.name !== bot.name) await sayRenamed(userId, bot, before.name).catch(() => {});
    return bot;
  } catch (err) {
    if (err?.code === '23505' || /duplicate key|unique/i.test(String(err?.message))) throw new BotError(`There is already a bot called ${patch.name}.`, 409, 'name_taken');
    throw err;
  }
}

/**
 * A new group chat, checked: a name, at least one bot, at most `LIMITS.members`, all
 * the account's. The admin is one of the members — the one asked for, or the first.
 *
 * @param {string} userId
 * @param {{ name: unknown, members: unknown, admin?: unknown }} input  member and admin ids
 */
export async function createGroup(userId, input) {
  const store = getStore();
  const name = cleanText(input.name, LIMITS.groupName, 'A group name');
  if (!name) throw new BotError('A group chat needs a name.', 400, 'bad_name');
  const [bots, groups] = await Promise.all([store.listBots(userId), store.listBotGroups(userId)]);
  if (groups.length >= LIMITS.groups) throw new BotError(`An account keeps at most ${LIMITS.groups} group chats.`, 409, 'too_many');
  if (groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new BotError(`There is already a group called ${name}.`, 409, 'name_taken');
  const own = new Set(bots.map((b) => b.id));
  const members = [...new Set(Array.isArray(input.members) ? input.members.map(String) : [])].filter((id) => own.has(id));
  if (!members.length) throw new BotError('A group chat needs at least one of your bots in it.', 400, 'no_members');
  if (members.length > LIMITS.members) throw new BotError(`A group chat holds at most ${LIMITS.members} bots.`, 400, 'too_many_members');
  const admin = members.includes(String(input.admin || '')) ? String(input.admin) : members[0];
  const group = await store.createBotGroup(userId, { id: crypto.randomUUID(), name, adminBotId: admin, members });
  if (!group) throw new BotError(`There is already a group called ${name}.`, 409, 'name_taken');
  const nameOf = (botId) => bots.find((b) => b.id === botId)?.name || '';
  await sayInGroup(userId, group, [['made', { members, admin }, `Group chat made with ${members.map(nameOf).join(', ')}; ${nameOf(admin)} is the admin.`]]).catch(() => {});
  return group;
}

/**
 * Change a group: its name, its members, its admin. The admin stays one of the
 * members; removing the admin hands the role to the first who stays.
 *
 * @param {string} userId @param {string} id
 * @param {{ name?: unknown, members?: unknown, admin?: unknown }} input
 */
export async function updateGroup(userId, id, input) {
  const store = getStore();
  const group = await store.getBotGroup(userId, id);
  if (!group) throw new BotError('No such group chat.', 404, 'not_found');
  const patch = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name, LIMITS.groupName, 'A group name');
    if (!name) throw new BotError('A group chat needs a name.', 400, 'bad_name');
    const groups = await store.listBotGroups(userId);
    if (groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) throw new BotError(`There is already a group called ${name}.`, 409, 'name_taken');
    patch.name = name;
  }
  let members = group.members;
  if (input.members !== undefined) {
    const own = new Set((await store.listBots(userId)).map((b) => b.id));
    members = [...new Set(Array.isArray(input.members) ? input.members.map(String) : [])].filter((m) => own.has(m));
    if (!members.length) throw new BotError('A group chat needs at least one of your bots in it.', 400, 'no_members');
    if (members.length > LIMITS.members) throw new BotError(`A group chat holds at most ${LIMITS.members} bots.`, 400, 'too_many_members');
    patch.members = members;
  }
  if (input.admin !== undefined) {
    if (!members.includes(String(input.admin))) throw new BotError('The admin has to be one of the group\'s bots.', 400, 'bad_admin');
    patch.adminBotId = String(input.admin);
  } else if (patch.members && !members.includes(group.admin_bot_id)) {
    patch.adminBotId = members[0];
  }
  const updated = await store.updateBotGroup(userId, id, patch);
  if (updated) {
    const bots = await store.listBots(userId);
    const nameOf = (botId) => bots.find((b) => b.id === botId)?.name || '';
    /** @type {[string, Record<string, unknown>, string][]} */
    const lines = [];
    if (patch.name && patch.name !== group.name) lines.push(['renamed', { name: patch.name }, `The group is now called ${patch.name}.`]);
    const had = new Set(group.members || []);
    const has = new Set(updated.members || members);
    for (const m of has) if (!had.has(m)) lines.push(['joined', { bot: m, name: nameOf(m) }, `${nameOf(m)} joined the group.`]);
    for (const m of had) if (!has.has(m)) lines.push(['left', { bot: m, name: nameOf(m) }, `${nameOf(m)} left the group.`]);
    const admin = adminOf({ ...updated, members: [...has] });
    if (admin && admin !== adminOf(group)) lines.push(['admin', { bot: admin, name: nameOf(admin) }, `${nameOf(admin)} is the admin now.`]);
    await sayInGroup(userId, updated, lines).catch(() => {});
  }
  return updated;
}

/**
 * Delete a bot (never Chief), said in each group it was in, with who answers there now
 * when it was that group's admin (owner, 2026-11-10).
 *
 * @param {string} userId @param {{ id: string, name: string }} bot
 */
export async function removeBot(userId, bot) {
  const store = getStore();
  const groups = (await store.listBotGroups(userId)).filter((g) => (g.members || []).includes(bot.id));
  if (!(await store.deleteBot(userId, bot.id))) return false;
  const bots = await store.listBots(userId);
  const nameOf = (botId) => bots.find((b) => b.id === botId)?.name || '';
  for (const g of groups) {
    const left = (g.members || []).filter((m) => m !== bot.id);
    /** @type {[string, Record<string, unknown>, string][]} */
    const lines = [['deleted', { bot: bot.id, name: bot.name }, `${bot.name} was deleted, and left the group.`]];
    if (adminOf(g) === bot.id && left.length) lines.push(['admin', { bot: left[0], name: nameOf(left[0]) }, `${nameOf(left[0])} is the admin now.`]);
    await sayInGroup(userId, g, lines).catch(() => {});
  }
  return true;
}

/** What the browser is given of a bot: everything but the account id. @param {any} row */
export function botView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    avatar: row.avatar,
    hue: Number(row.hue) || 0,
    instructions: row.instructions,
    main: !!row.is_main,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** @param {any} row */
export function groupView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    admin: row.admin_bot_id || null,
    members: Array.isArray(row.members) ? row.members : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Who answers a group's plain message: its admin, or its first member when it has none. @param {any} group */
export const adminOf = (group) => (group?.admin_bot_id && (group.members || []).includes(group.admin_bot_id) ? group.admin_bot_id : group?.members?.[0] || null);

/**
 * What changed in a group, said in its own log (owner, 2026-11-10), as DS Bot says
 * "Created [face] Writer": made, a bot that joined or left, a new name, a new admin. The
 * words are what the members read of it (rounds.js `lineOf`); the page draws the line from
 * `notice` and `params`, in the person's language and with the faces.
 *
 * @param {string} userId @param {{ id: string, name: string }} group
 * @param {[string, Record<string, unknown>, string][]} lines  kind, params, words
 */
export async function sayInGroup(userId, group, lines) {
  if (!lines.length) return;
  const store = getStore();
  const log = await store.botChat(userId, { groupId: group.id, title: group.name });
  if (!log) return;
  for (const [notice, params, text] of lines) await store.appendMessage(userId, log.id, { id: crypto.randomUUID(), role: 'assistant', notice, text, params });
}

/** A bot's new name, said in every group it is in. @param {string} userId @param {any} bot @param {string} from */
async function sayRenamed(userId, bot, from) {
  const groups = (await getStore().listBotGroups(userId)).filter((g) => (g.members || []).includes(bot.id));
  for (const g of groups) await sayInGroup(userId, g, [['botRenamed', { bot: bot.id, from, name: bot.name }, `${from} is now called ${bot.name}.`]]);
}
