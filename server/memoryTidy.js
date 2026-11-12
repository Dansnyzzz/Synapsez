import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { streamCompletion } from './providers/index.js';
import { priceTurn } from './providers/catalog.js';
import { record as recordUsage } from './usage.js';
import { resolveForUser, AUTO_ID } from './autoPick.js';
import { getPrefs, providerPrivacyFor, maskPersonalFor } from './settings.js';
import { redactSecrets } from './redact.js';
import { log } from './util/trace.js';
import { MEMORY_KEY, MAX_NOTE_CHARS, currentNotes, kindOf, memoryRefusal, removedNote, stampNote } from './memory.js';

/**
 * "Tidy my notes monthly" (owner, 2026-11-12): opt-in consolidation that only ever
 * proposes.
 *
 * Notes are written one at a time, in the middle of other work, so over months a set
 * collects two notes saying the same thing, one that contradicts another, and facts
 * that are plainly over. Once a month, for an account that switched this on, one
 * tool-less call on the free Auto model reads its notes and answers which to merge,
 * which to remove and which disagree. Nothing is changed: the answer becomes a short
 * list in Settings → Memory, and each item is the person's to accept or reject.
 *
 * What it never does, enforced here rather than asked of the model:
 *   - change a note — `proposeTidy` writes only the list (`memoryTidy` in user_settings);
 *   - read an account with memory off;
 *   - send a note saved from Google data — that goes only to models that do not train
 *     on it, and the free Auto model may (googleData.js); such notes are left out;
 *   - propose a merged note that holds what a note may never hold (`memoryRefusal`),
 *     a credential, or more than a note may;
 *   - keep a proposal whose notes changed since: accepting checks each is as it was.
 *
 * An accepted proposal is applied as an assistant's change the person approved, the
 * way an approved `memory_delete` is: the merged-into note keeps what it said in its
 * history, and a removed one leaves its marker, so either can be brought back.
 */

/** Where the list is kept, apart from the notes so nothing reading them ever sees it. */
export const TIDY_KEY = 'memoryTidy';
/** How often an account is looked at. */
export const TIDY_EVERY_DAYS = 30;
const MAX_PROPOSALS = 8;
const NOTE_CLIP = 600;
const TYPES = new Set(['merge', 'remove', 'contradiction']);

const SYSTEM = [
  "You help a person keep the notes an assistant saved about them tidy. You only suggest; the person decides.",
  'Each note has an id in brackets, the place it belongs to, its kind and its words. Suggest, only where it is clearly right:',
  '- "merge": two or more notes in the same place that say related things, with the one note that should replace them;',
  '- "remove": a note that is plainly out of date or says nothing useful;',
  '- "contradiction": notes in the same place that disagree, with the id of the one to keep.',
  'Never combine notes from different places. Never add a fact no note holds, nor keys, passwords or ID numbers. Say why in one short sentence, in the language the notes are written in.',
  `Answer with JSON only: {"proposals": [{"type": "merge", "notes": ["n1", "n2"], "into": "n1", "text": "merged note", "why": "…"}, {"type": "remove", "notes": ["n3"], "why": "…"}, {"type": "contradiction", "notes": ["n4", "n5"], "keep": "n5", "why": "…"}]}. At most ${MAX_PROPOSALS}. {"proposals": []} when the notes are fine.`,
].join('\n');

/** The JSON a tidy call answered, read leniently: a model may wrap it in a fence or a sentence. */
export function parseTidy(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(value?.proposals) ? value.proposals.filter((p) => p && typeof p === 'object') : [];
  } catch {
    return [];
  }
}

/**
 * The notes a tidy may read, numbered: every current note of every place, except
 * those saved from Google data.
 *
 * @returns {{ listed: Array<{ id: string, bucket: string, key: string, note: any }>, held: number }}
 */
function readable(buckets) {
  const listed = [];
  let held = 0;
  for (const { key: bucket, value } of buckets) {
    for (const [key, note] of Object.entries(currentNotes(value || {}))) {
      if (note.google) {
        held += 1;
        continue;
      }
      listed.push({ id: `n${listed.length + 1}`, bucket, key, note });
    }
  }
  return { listed, held };
}

/**
 * One proposal checked against the notes it names, or null when it cannot stand.
 *
 * @param {any} p  as the model answered it
 * @param {Map<string, { bucket: string, key: string, note: any }>} byId
 * @param {{ allowSensitive: boolean }} allowed
 */
export function checkProposal(p, byId, allowed) {
  const type = String(p.type || '');
  if (!TYPES.has(type)) return null;
  const ids = [...new Set((Array.isArray(p.notes) ? p.notes : []).map(String))].slice(0, 6);
  const named = ids.map((id) => byId.get(id)).filter(Boolean);
  if (named.length !== ids.length || !named.length) return null;
  if (new Set(named.map((n) => n.bucket)).size !== 1) return null;
  if (type !== 'remove' && named.length < 2) return null;
  const why = redactSecrets(String(p.why ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()).text.slice(0, 300);
  const out = {
    id: crypto.randomUUID(),
    type,
    bucket: named[0].bucket,
    keys: named.map((n) => n.key),
    // As each note stood when this was proposed: accepting checks it still does.
    seen: Object.fromEntries(named.map((n) => [n.key, n.note.updatedAt || null])),
    why,
  };
  if (type === 'merge') {
    const into = byId.get(String(p.into ?? ''));
    const text = String(p.text ?? '').normalize('NFC').trim();
    if (!into || !out.keys.includes(into.key) || !text || text.length > MAX_NOTE_CHARS) return null;
    if (redactSecrets(text).text !== text || memoryRefusal(text, allowed)) return null;
    return { ...out, into: into.key, text };
  }
  if (type === 'contradiction') {
    const keep = byId.get(String(p.keep ?? ''));
    if (!keep || !out.keys.includes(keep.key)) return null;
    return { ...out, keep: keep.key };
  }
  return out;
}

/**
 * Look at one account's notes and keep what the model proposes. Never throws, and
 * never changes a note.
 *
 * @param {{ userId: string, stream?: typeof streamCompletion, resolve?: typeof resolveForUser, now?: Date }} options
 * @returns {Promise<{ status: 'off' | 'memory_off' | 'too_few' | 'no_model' | 'privacy' | 'proposed' | 'failed', proposals?: number, held?: number }>}
 */
export async function proposeTidy({ userId, stream = streamCompletion, resolve = resolveForUser, now = new Date() }) {
  try {
    const store = getStore();
    const prefs = await getPrefs(userId);
    if (prefs.memoryTidy !== true) return { status: 'off' };
    if (prefs.memory === false) return { status: 'memory_off' };
    // Looked at now whatever comes of it, so a failure waits a month rather than retrying every hour.
    await store.mergeUserSetting(userId, TIDY_KEY, { at: now.toISOString() });
    const buckets = await store.listMemoryBuckets(userId);
    const { listed, held } = readable(buckets);
    if (listed.length < 2) return { status: 'too_few', held };
    const entry = await resolve(userId, AUTO_ID);
    if (!entry) return { status: 'no_model' };
    /*
     * What the person chose not to share is not shared (owner, 2026-11-12). Strict provider
     * privacy — "only providers that neither keep nor train on what is sent" — is enforced on
     * OpenRouter's routing alone (providers/index.js), so a tidy for a strict account goes
     * only that way, and asks for it outright: a model with no such endpoint refuses, and
     * the tidy does not run. Hiding personal details, when switched on, applies here as on
     * every call. Notes saved from Google data are never in the list at all (`readable`).
     */
    const privacy = await providerPrivacyFor(userId);
    if (privacy === 'strict' && entry.provider !== 'openrouter') return { status: 'privacy' };
    const maskPersonal = await maskPersonalFor(userId);
    const [projects, archived] = await Promise.all([store.listProjects(userId), store.listProjects(userId, { archived: true })]);
    const names = new Map([...projects, ...archived].map((p) => [p.id, p.name]));
    const place = (bucket) => (bucket === MEMORY_KEY ? 'everywhere' : `project "${names.get(bucket.slice(MEMORY_KEY.length + 1)) || 'deleted'}"`);
    const lines = listed.map(({ id, bucket, key, note }) => `[${id}] (${place(bucket)}, ${kindOf(note)}) ${key}: ${redactSecrets(note.content).text.replace(/\s+/g, ' ').slice(0, NOTE_CLIP)}`);

    let said = '';
    let spent = null;
    for await (const ev of stream({ userId, entry, system: SYSTEM, messages: [{ id: 'tidy', role: 'user', text: `<notes>\n${lines.join('\n')}\n</notes>` }], tools: [], effort: 'low', maxTokens: 1500, signal: AbortSignal.timeout(40_000), privacy, maskPersonal })) {
      if (ev.type === 'text') said += ev.delta ?? '';
      else if (ev.type === 'done') spent = ev.usage || null;
    }
    if (spent) await recordUsage(userId, { chatId: null, model: entry.id, usage: spent, costUsd: priceTurn(entry, spent)?.usd || 0, role: 'memory_tidy' }).catch(() => {});

    const byId = new Map(listed.map((n) => [n.id, n]));
    const allowed = { allowSensitive: prefs.memorySensitive === true };
    const proposals = parseTidy(said)
      .map((p) => checkProposal(p, byId, allowed))
      .filter(Boolean)
      .slice(0, MAX_PROPOSALS)
      .map((p) => ({ ...p, createdAt: now.toISOString() }));
    // The new list replaces the old: a month on, the notes are not what they were.
    await store.mergeUserSetting(userId, TIDY_KEY, { at: now.toISOString(), model: entry.id, proposals });
    return { status: 'proposed', proposals: proposals.length, held };
  } catch (err) {
    log.error('a memory tidy failed', err);
    return { status: 'failed' };
  }
}

/**
 * The accounts due a look — switched on, memory on, not looked at for a month — a few
 * at a time, from the sweep. Each is one call on the free model, so the number is small.
 *
 * @param {{ now?: Date, limit?: number, stream?: typeof streamCompletion, resolve?: typeof resolveForUser }} [options]
 * @returns {Promise<Array<{ userId: string, status: string }>>}
 */
export async function tidyDueAccounts({ now = new Date(), limit = 2, stream = streamCompletion, resolve = resolveForUser } = {}) {
  const store = getStore();
  const since = new Date(now.getTime() - TIDY_EVERY_DAYS * 86_400_000).toISOString();
  const due = await store.memoryTidyDue(since, limit);
  const done = [];
  for (const userId of due) done.push({ userId, ...(await proposeTidy({ userId, stream, resolve, now })) });
  return done;
}

/**
 * The proposals that still stand: every note each names is there and as it was.
 *
 * @param {any} tidy  the stored list
 * @param {Array<{ key: string, value: any }>} buckets
 */
export function standingProposals(tidy, buckets) {
  const sets = new Map(buckets.map((b) => [b.key, currentNotes(b.value || {})]));
  return (Array.isArray(tidy?.proposals) ? tidy.proposals : []).filter((p) => {
    const notes = sets.get(p.bucket);
    return !!notes && p.keys.every((k) => Object.hasOwn(notes, k) && (notes[k].updatedAt || null) === (p.seen?.[k] ?? null));
  });
}

/**
 * Accept one proposal: applied as an assistant's change the person approved — the
 * note merged into keeps its history, a note removed leaves its marker — so either
 * can be brought back from Settings → Memory. Refused when its notes changed since.
 *
 * @returns {Promise<'applied' | 'gone' | 'changed'>}
 */
export async function acceptProposal(userId, id) {
  const store = getStore();
  const tidy = (await store.getUserSetting(userId, TIDY_KEY)) || {};
  const proposal = (tidy.proposals || []).find((p) => p.id === id);
  if (!proposal) return 'gone';
  const stored = (await store.getUserSetting(userId, proposal.bucket)) || {};
  const [still] = standingProposals({ proposals: [proposal] }, [{ key: proposal.bucket, value: stored }]);
  if (!still) {
    await dropProposals(userId, (p) => p.id === id);
    return 'changed';
  }
  const removing = proposal.type === 'merge' ? proposal.keys.filter((k) => k !== proposal.into) : proposal.type === 'contradiction' ? proposal.keys.filter((k) => k !== proposal.keep) : proposal.keys;
  if (proposal.type === 'merge') {
    const before = stored[proposal.into];
    await store.mergeUserSetting(userId, proposal.bucket, { [proposal.into]: stampNote(proposal.text, { by: 'assistant', before, kind: kindOf(before) }) });
  }
  for (const key of removing) await store.removeMemoryNote(userId, proposal.bucket, key, removedNote(stored[key]));
  // This one, and any other naming a note it changed — those notes are not what they were.
  const touched = new Set(proposal.keys);
  await dropProposals(userId, (p) => p.id === id || (p.bucket === proposal.bucket && p.keys.some((k) => touched.has(k))));
  return 'applied';
}

/** Reject one proposal: it goes, and nothing else changes. */
export async function rejectProposal(userId, id) {
  return dropProposals(userId, (p) => p.id === id);
}

async function dropProposals(userId, which) {
  const store = getStore();
  const tidy = (await store.getUserSetting(userId, TIDY_KEY)) || {};
  const before = Array.isArray(tidy.proposals) ? tidy.proposals : [];
  const proposals = before.filter((p) => !which(p));
  if (proposals.length !== before.length) await store.mergeUserSetting(userId, TIDY_KEY, { proposals });
  return before.length - proposals.length;
}
