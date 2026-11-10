import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { redactSecrets } from '../redact.js';
import { BotError, LIMITS } from './team.js';

/**
 * What a bot remembers, and what a group remembers (owner, 2026-11-09).
 *
 * Two scopes, as in DS Bot: a bot's own memory goes with it into every one of its
 * conversations; a group's memory is read only by its members, only in that group,
 * so what is said in a group stays there. Entries are one short fact each, written
 * by the bot (its `remember` tool) or by the person (the memory panel).
 *
 * Left out of DS Bot's memory: the Markdown files and their topics, the change
 * journal and undo, the review that reads every turn and writes entries itself (one
 * more model call a turn, which a hosted app would bill), and the team-wide memory —
 * this app already has the account's notes (Settings → Memory), which every bot
 * reads as the team's background.
 *
 * Safety: an entry is data, never an instruction — the prompt says so — and one
 * that looks like a key or a password is refused, as the account's notes are.
 */

/** The most of a scope's memory that goes into a prompt, in characters. */
const PROMPT_CHARS = 4000;

/** @param {{ botId?: string | null, groupId?: string | null }} scope */
export async function listMemory(userId, scope) {
  return getStore().listBotMemory(userId, scope);
}

/**
 * Save one entry. Refused, with a sentence the writer can act on: empty, too long,
 * a key or password, already saved, or the scope is full.
 *
 * @param {string} userId
 * @param {{ botId?: string | null, groupId?: string | null }} scope
 * @param {unknown} text @param {'bot' | 'user'} [source]
 */
export async function remember(userId, scope, text, source = 'bot') {
  const entry = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!entry) throw new BotError('An entry needs some words.', 400, 'empty');
  if (entry.length > LIMITS.entry) throw new BotError(`An entry holds one fact, at most ${LIMITS.entry} characters; this one has ${entry.length}. Save it as two.`, 400, 'too_long');
  if (redactSecrets(entry).text !== entry) throw new BotError('That looks like a key, token or password, which memory never keeps.', 400, 'secret');
  const store = getStore();
  const have = await store.listBotMemory(userId, scope);
  if (have.some((row) => row.text.toLowerCase() === entry.toLowerCase())) return { saved: false, entry: have.find((row) => row.text.toLowerCase() === entry.toLowerCase()) };
  if (have.length >= LIMITS.entries) throw new BotError(`This memory is full (${LIMITS.entries} entries). Forget one that is no longer true first.`, 409, 'full');
  const row = await store.addBotMemory(userId, { id: crypto.randomUUID(), botId: scope.botId || null, groupId: scope.groupId || null, text: entry, source: source === 'user' ? 'user' : 'bot' });
  if (!row) throw new BotError('No such bot or group.', 404, 'not_found');
  return { saved: true, entry: row };
}

/**
 * Remove the entry whose text holds `match` (or whose id it is). Refused when no
 * entry or more than one holds it, so a vague word never removes the wrong fact.
 *
 * @param {string} userId @param {{ botId?: string | null, groupId?: string | null }} scope @param {unknown} match
 */
export async function forget(userId, scope, match) {
  const needle = String(match ?? '').trim().toLowerCase();
  if (!needle) throw new BotError('Say which entry to forget.', 400, 'empty');
  const store = getStore();
  const have = await store.listBotMemory(userId, scope);
  const hits = have.filter((row) => row.id === match || row.text.toLowerCase().includes(needle));
  if (!hits.length) throw new BotError('No entry holds those words.', 404, 'not_found');
  if (hits.length > 1) throw new BotError(`${hits.length} entries hold those words; quote more of the one to forget.`, 409, 'ambiguous');
  await store.deleteBotMemory(userId, hits[0].id, scope);
  return hits[0];
}

/**
 * Entries as a prompt section, newest kept when there is more than fits. Marked as
 * what they are: notes, not instructions.
 *
 * @param {{ text: string, created_at?: any }[]} rows @param {string} heading @param {string} about
 */
export function memorySection(rows, heading, about) {
  // Said even when empty: a bot with nothing saved yet still has to know it can save
  // (owner, 2026-11-10: a new bot never wrote its first entry, never having been told).
  if (!rows?.length) return [heading, about, '(Nothing saved yet.)'].join('\n');
  const lines = [];
  let used = 0;
  for (const row of [...rows].reverse()) {
    const day = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '';
    const line = `- ${row.text}${day ? ` (${day})` : ''}`;
    if (used + line.length + 1 > PROMPT_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  const cut = rows.length - lines.length;
  return [heading, about, ...lines, ...(cut ? [`(${cut} older entr${cut === 1 ? 'y' : 'ies'} not shown.)`] : [])].join('\n');
}
