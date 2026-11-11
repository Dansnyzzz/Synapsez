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
 * Text as search reads it: lower case, no diacritics, "đ" as "d" — so "da nang" finds
 * "Đà Nẵng" with no database extension. Computed here, stored beside the text.
 *
 * @param {unknown} text
 */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/**
 * A note longer than one entry, cut at its sentence ends into entries within the limit
 * (owner, 2026-11-10: a bot's 327-character note was refused, and nothing was kept).
 * Sentences are packed back together while they fit. Null when one sentence alone is
 * longer than an entry: that one is said more briefly, not cut mid-thought.
 *
 * @param {string} text  already composed (NFC) and trimmed
 * @param {number} [max]
 * @returns {string[] | null}
 */
export function splitEntry(text, max = LIMITS.entry) {
  const tidy = (s) => s.replace(/\s+/g, ' ').trim();
  if (tidy(text).length <= max) return [tidy(text)];
  const sentences = text
    .split(/(?<=[.!?;…])\s+|\n+/)
    .map(tidy)
    .filter(Boolean);
  if (sentences.some((s) => s.length > max)) return null;
  const out = [];
  let current = '';
  for (const sentence of sentences) {
    if (!current) current = sentence;
    else if (current.length + 1 + sentence.length <= max) current = `${current} ${sentence}`;
    else {
      out.push(current);
      current = sentence;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Save a note: one entry, or several when it is longer than one and can be cut at its
 * sentence ends. Refused, with a sentence the writer can act on: empty, a sentence too
 * long, a key or password, or the scope is full. A piece already saved is not saved
 * twice. Text is stored composed (NFC), so a Vietnamese mark counts once.
 *
 * @param {string} userId
 * @param {{ botId?: string | null, groupId?: string | null }} scope
 * @param {unknown} text @param {'bot' | 'user'} [source]
 * @param {{ turnId?: string | null }} [options]  the turn that saved it, taken back if that turn fails
 * @returns {Promise<{ saved: boolean, entry: any, entries: any[] }>}
 */
export async function remember(userId, scope, text, source = 'bot', { turnId = null } = {}) {
  const raw = String(text ?? '').normalize('NFC').trim();
  if (!raw) throw new BotError('An entry needs some words.', 400, 'empty');
  const pieces = splitEntry(raw);
  if (!pieces) throw new BotError(`One sentence here is longer than ${LIMITS.entry} characters, the most an entry holds. Say it more briefly.`, 400, 'too_long');
  if (pieces.some((piece) => redactSecrets(piece).text !== piece)) throw new BotError('That looks like a key, token or password, which memory never keeps.', 400, 'secret');
  const store = getStore();
  const have = await store.listBotMemory(userId, scope);
  const same = (a, b) => a.normalize('NFC').toLowerCase() === b.toLowerCase();
  const fresh = pieces.filter((piece) => !have.some((row) => same(row.text, piece)));
  if (have.length + fresh.length > LIMITS.entries) throw new BotError(`This memory is full (${LIMITS.entries} entries). Forget one that is no longer true first.`, 409, 'full');
  const entries = [];
  for (const piece of pieces) {
    const known = have.find((row) => same(row.text, piece));
    if (known) {
      entries.push(known);
      continue;
    }
    const row = await store.addBotMemory(userId, {
      id: crypto.randomUUID(),
      botId: scope.botId || null,
      groupId: scope.groupId || null,
      text: piece,
      textFolded: fold(piece),
      source: source === 'user' ? 'user' : 'bot',
      turnId,
    });
    if (!row) throw new BotError('No such bot or group.', 404, 'not_found');
    entries.push(row);
  }
  return { saved: fresh.length > 0, entry: entries[0], entries };
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
