/**
 * What the model is told stays true to the code (spec A.10, after dsh-superagent's
 * model-surface tests; owner 2026-11-10).
 *
 * A prompt that names a tool the role does not have, or states a limit the code does
 * not keep, sends the model the wrong way and nothing else notices. So:
 *   - every tool name a bot's prompt or a bot tool's description mentions is a tool
 *     that bot is offered (or one of the app's own, which every turn has);
 *   - every number a bot tool's description states as a limit is the constant's;
 *   - each role's prompt and tools stay within a budget, measured when this was
 *     written plus a margin, so they do not grow by accident.
 *
 *   node test/model-surface.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'model-surface-test-key';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-model-surface-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const store = await initStore({ driver: { query: async (text, params = []) => (await db.query(text, params)).rows } });
const { botPersona } = await import('../server/bots/prompt.js');
const { botTools } = await import('../server/bots/tools.js');
const { LIMITS, HANDOFF_CEILING } = await import('../server/bots/team.js');
const { TOOLS } = await import('../server/tools/definitions.js');

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const id = () => crypto.randomUUID();
const user = await store.createUser({ id: id(), role: 'user', name: 'Surface', email: 'surface@test.local', passwordHash: 'x' });
const chief = await store.createBot(user.id, { id: id(), name: 'Chief', role: 'Chief of Staff', avatar: 'cosmic-whale', isMain: true });
const writer = await store.createBot(user.id, { id: id(), name: 'Writer', role: 'Editor', avatar: 'minnow', instructions: 'Draft blog posts.' });
const group = await store.createBotGroup(user.id, { id: id(), name: 'Desk', adminBotId: chief.id, members: [chief.id, writer.id] });

const roles = {
  chief: { bot: chief, chat: await store.botChat(user.id, { botId: chief.id, title: 'Chief' }) },
  member: { bot: writer, chat: await store.botChat(user.id, { botId: writer.id, title: 'Writer' }) },
  'member in a group': { bot: writer, chat: await store.botChat(user.id, { botId: writer.id, groupId: group.id, title: 'Writer · Desk' }) },
};

const appTools = new Set(TOOLS.map((t) => t.name));
/** Words in snake_case that are not tools, which a prompt may say. */
const NOT_TOOLS = new Set(['web_page']);

section('a tool a bot is told about is a tool it has');
for (const [role, { bot, chat }] of Object.entries(roles)) {
  const persona = await botPersona(user.id, chat);
  const tools = botTools(bot);
  const offered = new Set([...tools.map((t) => t.name), ...appTools]);
  const said = [persona.intro, persona.section, ...tools.map((t) => t.description), ...tools.flatMap((t) => Object.values(t.parameters?.properties || {}).map((p) => p.description || ''))].join('\n');
  const named = [...new Set([...said.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]))].filter((w) => !NOT_TOOLS.has(w));
  const unknown = named.filter((w) => !offered.has(w));
  check(`${role}: every tool its prompt and tools name exists`, unknown.length === 0, unknown.join(', '));
  if (role === 'member') {
    const mainOnly = ['create_bot', 'create_group', 'update_group'].filter((n) => tools.some((t) => t.name === n));
    check('  and a member is not offered what only Chief may do', mainOnly.length === 0, mainOnly.join());
  }
}

section('a limit a description states is the one the code keeps');
{
  const tools = botTools(chief);
  const text = (name) => {
    const tool = tools.find((t) => t.name === name);
    return [tool?.description || '', ...Object.values(tool?.parameters?.properties || {}).map((p) => p.description || '')].join(' ');
  };
  const numbersIn = (s) => [...s.matchAll(/at most (\d[\d,]*)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const known = new Set([LIMITS.entry, LIMITS.notice, LIMITS.role, LIMITS.instructions, LIMITS.entries, HANDOFF_CEILING]);
  for (const t of tools) {
    const stated = numbersIn(text(t.name));
    const wrong = stated.filter((n) => !known.has(n));
    check(`${t.name}: "at most N" is a real limit`, wrong.length === 0, wrong.join(', '));
  }
  check('remember says the entry limit the code keeps', numbersIn(text('remember')).includes(LIMITS.entry), text('remember').slice(0, 160));
  check('create_group says the notice limit the code keeps', numbersIn(text('create_group')).includes(LIMITS.notice));
}

section('each role stays within its size');
{
  // Measured 2026-11-11 with nothing saved, plus a margin. Raise on purpose, not by accident.
  // Chief 8800 → 9400 on purpose (spec B): post_to_group and the interview rule, measured 9216.
  const BUDGET = { chief: 9400, member: 5750, 'member in a group': 6250 };
  for (const [role, { bot, chat }] of Object.entries(roles)) {
    const persona = await botPersona(user.id, chat);
    const size = persona.intro.length + persona.section.length + JSON.stringify(botTools(bot).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;
    check(`${role}: ${size} characters, within ${BUDGET[role]}`, size <= BUDGET[role], String(size));
  }
}

console.log(failures === 0 ? '\n\x1b[32mAll model-surface checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
