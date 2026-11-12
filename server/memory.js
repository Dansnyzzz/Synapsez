import { getStore } from './store/index.js';
import { pluginTools } from '../public/js/plugins.js';
import { TOOLS } from './tools/definitions.js';
import { envelopeSources } from './tools/untrusted.js';

/**
 * What the assistant remembers between conversations, and how it is read back.
 *
 * Notes live in `user_settings`: one JSON object per scope, keyed by note name.
 * `memory` is the account's set, read everywhere; `memory:<projectId>` is a
 * project's own set, read only by that project's conversations. The tools that
 * write them are in tools/cloud.js; this module is everything around them —
 * which set a conversation is talking about, the guard on what may be written,
 * and the block that puts the notes in front of the model at the start of a turn.
 *
 * That last part was missing entirely. The system prompt and every memory tool
 * promised that "a note you leave behind is read into every future
 * conversation", and nothing ever read one in: a new conversation started
 * knowing nothing unless the model happened to call `memory_read` first, which
 * it rarely did because it had been told it did not need to. Memory was a
 * write-only store.
 */

export const MEMORY_KEY = 'memory';
export const projectMemoryKey = (projectId) => `${MEMORY_KEY}:${projectId}`;

/**
 * Which set of notes this conversation is talking about.
 *
 * A project keeps its own notes; a conversation outside every project uses the
 * account's. The account's are underneath a project's, not replaced by them:
 * reads return both, the project's first, and a name in both is the project's —
 * the narrower context is the more specific instruction. Writes go to the
 * narrower of the two, because a project fact saved account-wide leaks into
 * unrelated work, while an account fact saved into a project is merely learned
 * again elsewhere. `scope: 'account'` overrides that for a genuinely general fact.
 */
export async function memoryScope({ userId, chatId, scope = null }) {
  const account = { key: MEMORY_KEY, projectId: null, where: 'this account' };
  if (scope === 'account' || !chatId) return account;

  const chat = await getStore().getChat(userId, chatId).catch(() => null);
  const projectId = chat?.project_id || null;
  if (!projectId) return account;

  const project = await getStore().getProject(userId, projectId).catch(() => null);
  return {
    key: projectMemoryKey(projectId),
    projectId,
    where: project?.name ? `the project "${project.name}"` : 'this project',
    projectName: project?.name || null,
  };
}

/**
 * Both sets, with the narrower one winning a clash — the notes as they stand now.
 *
 * A note the assistant removed stays stored as a marker holding its history, and an
 * event past its date stays until it is pruned; neither is a note the tools can read,
 * change or count (`currentNotes`).
 */
export async function readBothScopes({ userId, chatId }) {
  const store = getStore();
  const here = await memoryScope({ userId, chatId });
  const account = currentNotes((await store.getUserSetting(userId, MEMORY_KEY)) || {});
  if (!here.projectId) return { here, account, project: {}, merged: account };
  const project = currentNotes((await store.getUserSetting(userId, here.key)) || {});
  return { here, account, project, merged: { ...account, ...project } };
}

/**
 * The name of a note, checked once for every memory tool and route.
 *
 * Memory is one JSON object keyed by note name. `__proto__` used as a key sets the
 * object's prototype instead of adding an entry — the note disappears on
 * serialisation while the tool reports it saved — and `constructor` and
 * `prototype` shadow the object's own machinery (CODE-023).
 */
export function noteName(key) {
  const name = String(key ?? '').trim().slice(0, 120);
  if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error(`"${key}" cannot be used as a note name. Pick a plain descriptive name.`);
  }
  return name;
}

/** The largest a single note may grow. A note is read into every conversation. */
export const MAX_NOTE_CHARS = 8_000;

/**
 * A note as it is stored: what it says, who wrote it, where, and what it said
 * before (HAR-002).
 *
 * A note is read into every later conversation, so one the assistant was talked
 * into writing — by a page, an email, a file — keeps steering it long after the
 * page is gone (OWASP ASI06). Notes carried no record of where they came from,
 * so nobody could tell one the person typed from one the assistant saved in the
 * middle of reading a stranger's page, and a bad change could only be deleted,
 * not taken back. Now each carries `by` ('assistant', 'user' or 'import'), the
 * conversation it was saved in, and — when the assistant changed it — the
 * versions it replaced, offered back in Settings → Memory.
 *
 * Only an assistant's change keeps what it replaced (PRV-006). The undo exists
 * for a change the person did not make; a person's own edit is their decision,
 * and keeping the text they just removed — "diabetes" taken out of a note — is
 * the opposite of what an edit is for. Their edit, or an import, keeps no earlier
 * version, and so also clears one an assistant change left behind.
 *
 * `google` marks a note the assistant saved from a conversation holding data
 * from the person's Google account; it is read only into conversations that
 * hold such data too (googleData.js, `withoutGoogleNotes`). The person's own
 * edit or an import carries no mark: what they write is theirs.
 *
 * What it replaced is now a short history rather than one step (owner, 2026-11-12):
 * up to `HISTORY_MAX` earlier versions, newest first, each with when it held
 * (`validFrom`, `invalidAt`), who wrote it and where. Facts change — the client
 * moved, the deadline slipped — and "what did this say in March" is a question
 * the person can now answer in Settings → Memory. The prompt reads only the
 * current version. The same rule as before decides who gets one: only an
 * assistant's change keeps history, and the person's own edit or an import keeps
 * none, clearing what there was (PRV-006).
 *
 * And where it came from, as provenance rather than content: the assistant
 * message's `seq` in that conversation, and — when the conversation had read
 * something from outside before the write — `outside`, the host or the kind of
 * tool it came from (`outsideLabel`), never what it said.
 *
 * `kind` is fact (the default, not stored), preference, rule or event; an event
 * may carry `expires`, after which it leaves the prompt. Kept from `before` when
 * not given, so an edit or an append does not quietly turn a rule into a fact.
 *
 * @param {string} content
 * @param {{ by: 'assistant'|'user'|'import', chatId?: string|null, before?: any, google?: boolean,
 *   kind?: string|null, expires?: string|null, validFrom?: string|null, seq?: number|null, outside?: string|null }} origin
 *   `before` is the stored note this replaces, if any.
 */
export function stampNote(content, { by, chatId = null, before = null, google = false, kind = null, expires = undefined, validFrom = null, seq = null, outside = null }) {
  const now = new Date().toISOString();
  const note = { content, updatedAt: now, by };
  if (chatId) note.chatId = chatId;
  if (by === 'assistant' && seq != null && Number.isFinite(Number(seq))) note.seq = Number(seq);
  if (by === 'assistant' && outside) note.outside = String(outside).slice(0, 80);
  if (google) note.google = true;
  const live = isLive(before) ? before : null;
  const type = kind && NOTE_KINDS.includes(kind) ? kind : kindOf(live);
  if (type !== 'fact') note.kind = type;
  const until = expires !== undefined ? expires : live?.expires || null;
  if (type === 'event' && until) note.expires = until;
  if (validFrom) note.validFrom = validFrom;
  if (by === 'assistant' && before) {
    const past = noteHistory(before);
    const changed = !!live && (live.content !== content || kindOf(live) !== type || (live.expires || null) !== (note.expires || null));
    const history = changed ? [versionOf(live, validFrom || now), ...past] : past;
    if (history.length) note.history = history.slice(0, HISTORY_MAX);
  }
  return note;
}

/* ── kinds, history and provenance (owner, 2026-11-12) ─────────────── */

/**
 * What a note is. A fact is true until it is not; a preference is how the person
 * likes things; a rule is a standing instruction, which the assistant never writes
 * or changes without asking (`changesRule`); an event is true until its date.
 */
export const NOTE_KINDS = ['fact', 'preference', 'rule', 'event'];

/** A note's kind as given by a tool or a route: one of `NOTE_KINDS`, or null for "not said". */
export function noteKind(kind) {
  if (kind === undefined || kind === null || kind === '') return null;
  const type = String(kind).trim().toLowerCase();
  if (!NOTE_KINDS.includes(type)) throw new Error(`A note's kind is one of: ${NOTE_KINDS.join(', ')}.`);
  return type;
}

/** A stored note's kind; a note saved before kinds existed is a fact. */
export const kindOf = (note) => (NOTE_KINDS.includes(note?.kind) ? note.kind : 'fact');

/** A calendar day as YYYY-MM-DD, or null when none was given; refused when it is not a real day. */
export function noteDay(value, what) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`Give ${what} as a date, YYYY-MM-DD.`);
  }
  return text;
}

/** How many earlier versions an assistant's changes keep of one note. */
export const HISTORY_MAX = 5;

/** A note that is there: words, not a marker left where the assistant removed one. */
export const isLive = (note) => !!note && typeof note.content === 'string' && note.removed !== true;

/** An event whose date has passed. Its last day still counts. */
export const isExpired = (note, now = new Date()) =>
  kindOf(note) === 'event' && typeof note?.expires === 'string' && note.expires < now.toISOString().slice(0, 10);

/** The notes as they stand now: live, and no event past its date. */
export function currentNotes(notes, now = new Date()) {
  const out = {};
  for (const [key, note] of Object.entries(notes || {})) if (isLive(note) && !isExpired(note, now)) out[key] = note;
  return out;
}

/** One version of a note, as its history keeps it. */
function versionOf(note, invalidAt) {
  return {
    content: note.content,
    validFrom: note.validFrom || note.updatedAt || null,
    invalidAt,
    by: note.by || null,
    ...(note.chatId ? { chatId: note.chatId } : {}),
    ...(note.seq != null ? { seq: note.seq } : {}),
    ...(note.outside ? { outside: note.outside } : {}),
    ...(note.google ? { google: true } : {}),
    ...(kindOf(note) !== 'fact' ? { kind: note.kind } : {}),
    ...(note.expires ? { expires: note.expires } : {}),
  };
}

/**
 * A note's earlier versions, newest first. A note saved before 2026-11-12 kept one
 * step as `previous`; it is read as a history of one.
 */
export function noteHistory(note) {
  if (Array.isArray(note?.history)) return note.history.filter((h) => h && typeof h.content === 'string').slice(0, HISTORY_MAX);
  const p = note?.previous;
  if (typeof p?.content !== 'string') return [];
  return [{
    content: p.content,
    validFrom: p.updatedAt || null,
    invalidAt: note.updatedAt || null,
    by: p.by || null,
    ...(p.chatId ? { chatId: p.chatId } : {}),
    ...(p.google ? { google: true } : {}),
  }];
}

/**
 * What an assistant's delete leaves: a marker holding the note's history, so the
 * person can still see what it said and bring it back. Read by nothing the model
 * sees; the person's own delete removes the whole of it (PRV-006).
 */
export function removedNote(before, { chatId = null, seq = null, outside = null } = {}) {
  const now = new Date().toISOString();
  return {
    removed: true,
    updatedAt: now,
    by: 'assistant',
    ...(chatId ? { chatId } : {}),
    ...(seq != null && Number.isFinite(Number(seq)) ? { seq: Number(seq) } : {}),
    ...(outside ? { outside: String(outside).slice(0, 80) } : {}),
    ...(before?.google ? { google: true } : {}),
    history: [...(isLive(before) ? [versionOf(before, now)] : []), ...noteHistory(before)].slice(0, HISTORY_MAX),
  };
}

/**
 * Where words from outside came from, said without saying what they were: a host
 * for a page, or the kind of tool for anything else. The envelope's own source can
 * be a full address with a query, a file path, a document's title or the command
 * that printed it — any of which can be personal — and this label is stored beside
 * a note and shown back, so only the coarse part is kept.
 *
 * @param {string|null|undefined} source  an envelope's `source` (tools/untrusted.js)
 */
export function outsideLabel(source) {
  let text = String(source ?? '').trim();
  if (!text) return null;
  text = text.replace(/\s*\(read by [^)]*\)\s*$/i, '').replace(/^pictures on\s+/i, '');
  const link = /\bhttps?:\/\/[^\s"<>]+/i.exec(text);
  if (link) {
    try {
      return new URL(link[0]).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return 'a web page';
    }
  }
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(text)) return text.toLowerCase().replace(/^www\./, '');
  const google = /^(Gmail|Google (?:Calendar|Drive|Docs|Sheets|Forms|Tasks|Contacts))\b/.exec(text);
  if (google) return google[1];
  const exact = new Map([
    ['the page in the browser', 'the browser'], ['the page in the cloud browser', 'the cloud browser'], ['the clipboard', 'the clipboard'],
    ['the screen', 'the screen'], ['github', 'GitHub'], ['notion', 'Notion'], ['earlier conversations', 'earlier conversations'],
    ['the indexed documents', 'the indexed documents'], ['project sources', 'project sources'], ['image search', 'image search'],
    ['a search result', 'a search result'], ['research paper abstracts', 'research papers'], ['a research paper', 'research papers'],
    ['code and documentation from the web', 'code documentation'], ['statutes, regulations and court opinions', 'law sources'],
  ]);
  const known = exact.get(text.toLowerCase());
  if (known) return known;
  if (/^project source:/i.test(text)) return 'project sources';
  if (/ search results$/i.test(text)) return `${text.replace(/ search results$/i, '').slice(0, 30)} search`;
  const server = /^the (.{1,40}) server$/.exec(text);
  if (server) return `the ${server[1]} server`;
  if (/^a request to this task from outside the app/i.test(text)) return 'a request from outside the app';
  const output = /^the output of ([a-z][a-z0-9_]{1,40})$/.exec(text);
  if (output) return output[1];
  if (/^the output of /i.test(text)) return 'a command';
  if (/[\\/]|\.[a-z0-9]{1,5}$/i.test(text)) return 'a file';
  return 'an outside source';
}

/**
 * Where the newest words from outside in a conversation came from, as a label, or
 * null when it has read nothing from outside. The same reading as the agent loop's
 * HAR-005 gate (`turnReadOutside`, `lastOutsideSource` in agent.js): the whole
 * conversation, because what a page said two messages ago is still in front of the model.
 *
 * @param {Array<{ role: string, results?: Array<{ content?: unknown }> }>} messages
 */
export function outsideIn(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'tool') continue;
    for (let j = (m.results || []).length - 1; j >= 0; j -= 1) {
      const sources = envelopeSources(String(m.results[j]?.content ?? ''));
      if (sources.length) return outsideLabel(sources[sources.length - 1]) || 'an outside source';
    }
  }
  return null;
}

/**
 * Provenance for a write the assistant is making now in `chatId`: the seq of the
 * assistant message that asked for it (the newest — it is stored before its calls
 * run) and where the conversation last read from outside. Never fails a write: a
 * conversation that cannot be read gives what is known.
 *
 * @returns {Promise<{ seq: number|null, outside: string|null }>}
 */
export async function provenanceFor(userId, chatId) {
  if (!userId || !chatId) return { seq: null, outside: null };
  try {
    const found = await getStore().memoryProvenance(userId, chatId);
    return { seq: found?.seq ?? null, outside: found?.outside ? outsideIn([{ role: 'tool', ...found.outside }]) : null };
  } catch {
    return { seq: null, outside: null };
  }
}

/* ── how much one place may hold ───────────────────────────────────── */

/**
 * The most notes one set keeps, and the most characters across them (owner,
 * 2026-11-12). Every note is read into every conversation — the prompt's budget
 * names the ones it cannot quote — so a set that only ever grows ends up as a list
 * of names the model never reads, and contradictions between notes nobody merged.
 * Past either line a new note, or a longer one, is refused with what to do instead:
 * merge or remove first. A change that does not grow the set always goes through,
 * so a full set can still be tidied.
 */
export const MAX_NOTES_PER_SCOPE = 40;
export const MAX_SCOPE_CHARS = 24_000;

/**
 * Why `key` may not take `next` in this set — as the error to throw, said so the
 * model merges or removes first and the person reads it in their language — or null
 * when it may.
 *
 * @param {Record<string, any>} notes  the set as stored
 * @param {string} where  the set, in words ("this account", 'the project "X"')
 * @returns {Error|null}
 */
export function scopeCapRefusal(notes, key, next, where) {
  const now = currentNotes(notes);
  const before = Object.hasOwn(now, key) ? now[key] : null;
  if (before && next.length <= before.content.length) return null;
  const others = Object.entries(now).filter(([name]) => name !== key);
  const chars = others.reduce((sum, [, note]) => sum + note.content.length, 0) + next.length;
  if (!before && others.length + 1 > MAX_NOTES_PER_SCOPE) {
    return new Error(
      `Not saved: ${where} already has ${others.length} notes, and ${MAX_NOTES_PER_SCOPE} is the most one place keeps, because every note is read into every conversation. ` +
        'Merge notes about the same subject into one (memory_write the merged note, then memory_delete the others) or remove ones that are no longer true, then save this.',
    );
  }
  if (chars > MAX_SCOPE_CHARS) {
    return new Error(
      `Not saved: the notes in ${where} would come to ${chars.toLocaleString('en')} characters, past the ${MAX_SCOPE_CHARS.toLocaleString('en')} one place keeps, because every note is read into every conversation. ` +
        'Shorten or merge notes that overlap, or remove ones that are no longer true (memory_read lists them), then save this.',
    );
  }
  return null;
}

/* ── a rule asks first, whatever the policy ────────────────────────── */

/** Said in the approval prompt for a call that writes, changes or removes a rule. */
export const RULE_REASON =
  'This writes or changes a rule — a standing instruction read at the start of every conversation. The assistant never sets or changes one without your yes, whatever the approval setting.';

/**
 * Whether a call writes, changes or removes a rule note (owner, 2026-11-12): a
 * `memory_write` that says `kind: "rule"`, or any memory write to a name that is a
 * rule now. A rule steers every later conversation the way the person's own words
 * do, so it is theirs to set — under every policy, `auto` included.
 *
 * @param {{ name?: string, input?: any }} call
 * @param {Set<string>|null} rules  the rule notes in reach (`ruleNotesInReach`)
 */
export function changesRule(call, rules) {
  if (!MEMORY_WRITE_TOOLS.includes(String(call?.name))) return false;
  if (call.name === 'memory_write' && String(call.input?.kind ?? '').trim().toLowerCase() === 'rule') return true;
  const key = String(call.input?.key ?? '').trim().slice(0, 120);
  return !!key && !!rules?.has(key);
}

/**
 * The names of the rule notes a conversation can reach — read only when the step
 * holds a memory write, so every other step costs nothing. When they cannot be
 * read, every name the step writes is treated as a rule: it asks rather than guesses.
 *
 * @param {string} userId @param {{ project_id?: string|null }|null} chat
 * @param {Array<{ name?: string, input?: any }>} toolCalls
 */
export async function ruleNotesInReach(userId, chat, toolCalls) {
  const writes = (toolCalls || []).filter((c) => MEMORY_WRITE_TOOLS.includes(String(c?.name)));
  if (!writes.length) return new Set();
  try {
    const store = getStore();
    const sets = [await store.getUserSetting(userId, MEMORY_KEY)];
    if (chat?.project_id) sets.push(await store.getUserSetting(userId, projectMemoryKey(chat.project_id)));
    const out = new Set();
    for (const notes of sets) for (const [key, note] of Object.entries(notes || {})) if (isLive(note) && kindOf(note) === 'rule') out.add(key);
    return out;
  } catch {
    return new Set(writes.map((c) => String(c.input?.key ?? '').trim().slice(0, 120)).filter(Boolean));
  }
}

/**
 * The notes a conversation without Google data may read: every one but those
 * marked `google`, and how many were held back so it can be said.
 */
export function withoutGoogleNotes(notes) {
  const kept = {};
  let held = 0;
  for (const [key, note] of Object.entries(notes || {})) {
    if (note?.google) held += 1;
    else kept[key] = note;
  }
  return { kept, held };
}

/** Said to the model where notes were held back, so it does not conclude they are gone. */
export const heldNotesLine = (held) =>
  `(${held} note${held === 1 ? ' was' : 's were'} saved from the person's Google data and ${held === 1 ? 'is' : 'are'} read only into conversations that hold such data; this one does not.)`;

/* ── what may never be remembered ──────────────────────────────────── */

/**
 * Lower case, accents off, đ as d — so "Chẩn đoán" and "chan doan" are one term.
 * Only for matching; nothing stored is ever folded.
 */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * A whole-word pattern, matched against lower-cased text with its accents on.
 *
 * `\b` is an ASCII notion and does not know where a Vietnamese word ends, so the
 * edges are written as "not a letter or digit" in Unicode terms instead.
 *
 * Accents stay on, deliberately, which is the opposite of what search wants.
 * Folded, "đồng tình" (agree) and "đồng tính" (homosexual) are the same string,
 * and so are "tiền sự" (a criminal record) and "tiền sử" (a medical history) —
 * a guard over folded text would refuse "the client agreed" as a note about
 * sexuality. The notes this guards are written by a model, in properly accented
 * Vietnamese, so nothing is lost by matching them as written.
 */
const words = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'u');
const lower = (text) => String(text ?? '').normalize('NFC').toLowerCase();

/** Luhn, for telling a card number from an order number that happens to be long. */
function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text) {
  for (const match of String(text).matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (/^(\d)\1+$/.test(digits)) continue;
    if (luhn(digits)) return true;
  }
  return false;
}

/** ISO 13616 mod-97, so a product code shaped like an IBAN is not mistaken for one. */
function hasIban(text) {
  for (const match of String(text).toUpperCase().matchAll(/(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Z0-9])/g)) {
    const iban = match[0].replace(/ /g, '');
    if (iban.length < 15 || iban.length > 34) continue;
    const moved = `${iban.slice(4)}${iban.slice(0, 4)}`;
    let rest = 0;
    for (const ch of moved) {
      const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
    }
    if (rest === 1) return true;
  }
  return false;
}

/**
 * Identifiers a note must never hold, whatever the user asks.
 *
 * The same line Claude draws: a government ID, a passport, a tax number, a bank
 * account or a card is a key to somebody's life rather than a fact about their
 * preferences, and a note is read into every future conversation and sent to a
 * model provider each time. Matched only beside the word that names it, so a
 * bare number — a phone, an invoice, a postcode — is not caught.
 */
/*
 * Words that are ordinary elsewhere are left out on purpose: "tin" is the
 * Vietnamese for news and messages, "swift" is a language, "mst" is a company's
 * tax code on every invoice. Each would refuse notes nobody meant to protect.
 */
const ID_CONTEXT = words([
  'cccd', 'cmnd', 'căn cước(?: công dân)?', 'chứng minh (?:nhân dân|thư)', 'số định danh(?: cá nhân)?', 'hộ chiếu',
  'passport(?: (?:no|number))?', 'ssn', 'social security(?: number)?', 'national id(?: number)?', 'id number',
  'mã số thuế cá nhân', 'tax (?:id|number|file number)', 'giấy phép lái xe', 'bằng lái(?: xe)?', 'gplx',
  'drivers? licen[cs]e(?: number)?', 'số bhxh', 'số bảo hiểm xã hội', 'medicare number', 'nhs number',
]);
const BANK_CONTEXT = words([
  'số tài khoản', 'stk', 'tài khoản ngân hàng', 'account (?:number|no)', 'acct(?: no)?', 'bank account',
  'routing number', 'sort code', 'iban', 'swift code', 'bic code', 'số thẻ', 'card number', 'cvv', 'cvc', 'mã pin', 'pin code',
]);
const NUMBER_AFTER = /^[^\d\n]{0,24}[a-z]?\d[\d .-]{4,}\d/;

function hasLabelledNumber(text, context) {
  const plain = lower(text);
  const re = new RegExp(context.source, 'gu');
  for (const match of plain.matchAll(re)) {
    if (NUMBER_AFTER.test(plain.slice(match.index + match[0].length))) return true;
  }
  return false;
}

const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;

const CRIMINAL = words([
  'tiền án', 'tiền sự', 'án tích', 'từng (?:bị )?(?:đi tù|ngồi tù|kết án)', 'bị kết án', 'criminal record',
  'convicted', 'prison sentence', 'arrest record', 'served time', 'felony',
]);
const IMMIGRATION = words([
  'immigration status', 'visa status', 'undocumented', 'illegal immigrant', 'asylum seeker', 'refugee status',
  'green card status', 'overstayed', 'tình trạng (?:cư trú|nhập cư|thị thực|visa)', 'cư trú bất hợp pháp',
  'nhập cư (?:trái phép|bất hợp pháp)', 'xin tị nạn', 'tị nạn', 'quá hạn visa', 'quá hạn thị thực',
]);

/**
 * Topics that are not stored unless the account has switched them on.
 *
 * Health, beliefs, politics, ethnicity and sexuality are where a remembered
 * detail does the most harm if it surfaces in the wrong place — a work email, a
 * shared screen, a project somebody else can see. Off by default, as Claude has
 * it; Settings → Memory turns them on for somebody who wants the assistant to
 * remember, say, their medication schedule.
 *
 * Phrases rather than single words wherever a word alone is ordinary — "race
 * condition", "std::vector", "the button is disabled", "the Great Depression",
 * "Christian from marketing", "the team voted for option B". Each of those was a
 * candidate here and each would have refused a note about work. Missing an
 * oblique mention is the cheaper error: the prompt and the tool description
 * carry the same rule, and this is the net under them.
 */
const SENSITIVE = [
  {
    topic: 'health',
    re: words([
      'diagnos(?:ed|is|es)', 'medical (?:condition|history|record)', 'chronic (?:illness|pain|disease)', 'clinical depression',
      'depressed', 'anxiety disorder', 'panic attacks?', 'bipolar(?: disorder)?', 'schizophreni\\p{L}*', 'adhd', 'autis(?:m|tic)',
      'cancer', 'tumou?r', 'diabet(?:es|ic)', 'hiv', 'pregnan(?:t|cy)', 'miscarriage', 'abortion',
      'medication', 'prescri(?:bed|ption)', 'antidepressants?', 'therapist', 'psychotherapy', 'mental (?:health|illness)',
      'eating disorder', 'addiction', 'chẩn đoán', 'bệnh (?:lý|án|nền|tim|tiểu đường|ung thư|trầm cảm|mãn tính|tâm thần)',
      'ung thư', 'tiểu đường', 'trầm cảm', 'rối loạn (?:lo âu|lưỡng cực|ăn uống)', 'tự kỷ', 'mang thai', 'có thai',
      'sảy thai', 'phá thai', 'uống thuốc', 'đơn thuốc', 'thuốc chống trầm cảm', 'sức kh(?:ỏ|o)e tâm thần', 'tiền sử bệnh',
      'nghiện (?:rượu|ma túy|ma tuý)', 'cai nghiện', 'trị liệu tâm lý',
    ]),
  },
  {
    topic: 'religion',
    re: words([
      'religio(?:n|us)', 'christianity', 'catholic', 'protestant', 'muslim', 'islam(?:ic)?', 'buddhis(?:m|t)', 'hindu(?:ism)?',
      'jewish', 'judaism', 'atheis(?:m|t)', 'agnostic', 'tôn giáo', 'theo đạo', 'công giáo', 'phật giáo', 'đạo phật',
      'đạo thiên chúa', 'đạo tin lành', 'hồi giáo', 'cao đài', 'ho(?:à|ò)a hảo', 'vô thần',
    ]),
  },
  {
    topic: 'politics',
    re: words([
      'political (?:view|views|belief|beliefs|party|affiliation|opinion|opinions|leaning)', 'party member',
      'communist party', 'democratic party', 'republican party', 'trade union member',
      'quan điểm chính trị', 'đảng viên', 'đảng phái', 'ủng hộ đảng', 'chính kiến', 'xu hướng chính trị',
    ]),
  },
  {
    topic: 'ethnicity',
    re: words([
      'ethnicity', 'ethnic (?:origin|background|group|minority)', 'racial', 'sắc tộc', 'chủng tộc', 'người dân tộc',
      'dân tộc (?:thiểu số|kinh|hoa|tày|thái|khmer|mường|h\'?mông|nùng|chăm)',
    ]),
  },
  {
    topic: 'sexuality',
    re: words([
      // "gay gắt" is harsh and "gay go" is difficult — ordinary Vietnamese.
      'sexual orientation', 'gay(?! gắt| go| cấn)', 'lesbian', 'bisexual', 'pansexual', 'asexual', 'transgender', 'trans (?:man|woman)',
      'non-?binary', 'lgbt\\p{L}*', 'queer', 'sex life', 'gender identity', 'đồng tính', 'song tính', 'chuyển giới',
      'xu hướng tính dục', 'bản dạng giới',
    ]),
  },
];

/** Topic names as the interface and the tool results say them. */
export const SENSITIVE_TOPICS = SENSITIVE.map((s) => s.topic);

/**
 * Why this text may not be saved as a note, or null when it may.
 *
 * Two tiers, as Claude has them. Identifiers are refused always, even when the
 * user asks — "remember my passport number" is exactly the request that must not
 * be honoured, because the note outlives the moment and travels to a provider on
 * every turn. Sensitive topics are refused unless the account has switched them
 * on. The model is told which it was and what to say, so the refusal reaches the
 * person rather than being quietly worked around.
 *
 * A filter over words, not an understanding of them: it misses what is said
 * obliquely, and it will occasionally stop a harmless note that names a topic in
 * passing. Both are acceptable here — the first is what the tool description and
 * the prompt also forbid, and the second costs one rephrased note.
 *
 * @returns {{ kind: 'identifier'|'sensitive', what: string } | null}
 */
export function memoryRefusal(text, { allowSensitive = false } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  if (hasCardNumber(raw)) return { kind: 'identifier', what: 'a payment card number' };
  if (hasIban(raw)) return { kind: 'identifier', what: 'a bank account number (IBAN)' };
  if (SSN.test(raw)) return { kind: 'identifier', what: 'a social security number' };
  if (hasLabelledNumber(raw, ID_CONTEXT)) return { kind: 'identifier', what: 'an identity document number' };
  if (hasLabelledNumber(raw, BANK_CONTEXT)) return { kind: 'identifier', what: 'a bank or card number' };

  const plain = lower(raw);
  if (CRIMINAL.test(plain)) return { kind: 'identifier', what: 'a criminal record' };
  if (IMMIGRATION.test(plain)) return { kind: 'identifier', what: 'immigration status' };

  if (!allowSensitive) {
    for (const { topic, re } of SENSITIVE) if (re.test(plain)) return { kind: 'sensitive', what: topic };
  }
  return null;
}

/** The tool result for a refused note — said so the model tells the person. */
export function refusalMessage(refusal) {
  if (refusal.kind === 'identifier') {
    return (
      `Not saved: the note contains ${refusal.what}. Notes never hold identity, passport, tax, bank or card numbers, ` +
      'criminal records or immigration status — not even when the user asks, because a note is read into every future ' +
      'conversation. Save the useful part without that detail if there is one, and tell the user plainly what was left out and why.'
    );
  }
  return (
    `Not saved: the note is about ${refusal.what}, a sensitive topic, and remembering sensitive topics is switched off ` +
    'for this account. Tell the user that, and that they can switch it on in Settings → Memory. Do not save it another way.'
  );
}

/* ── reading the notes back into a turn ────────────────────────────── */

/**
 * How much of the system prompt the notes may take: about 1,500 tokens.
 *
 * Read on every step of every turn, but inside the cached prefix — the notes
 * change only when one is written — so on the providers that cache, the cost
 * after the first step is a tenth of that. Against the alternative it replaces it
 * is cheap: one `memory_read` call is a whole extra step, which re-sends the
 * entire prompt and transcript to read the same notes.
 *
 * Past the budget a note is named rather than quoted, the way Claude Code loads
 * the head of MEMORY.md and reads the rest on demand.
 */
export const MEMORY_PROMPT_CHARS = 6_000;
const PREVIEW_CHARS = 120;

const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '');

/** Newest first: a note just corrected is likelier to matter than one from March. */
const newestFirst = (notes, now) =>
  Object.entries(currentNotes(notes, now))
    .filter(([, note]) => note.content.trim())
    .sort(([, a], [, b]) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

/**
 * The headings a kind is read under, rules first (owner, 2026-11-12): a rule the
 * person approved is the one thing in memory meant to be followed, so it comes
 * before any fact that could crowd it out of the budget.
 */
const KIND_TITLES = {
  rule: '### Rules — the user approved each one; follow them unless what they say now differs',
  preference: '### Preferences',
  fact: '### Facts',
  event: '### Events — each holds until the date it gives',
};

/**
 * The notes as the model reads them at the start of a turn, or '' when there are
 * none — an empty heading is tokens spent saying nothing.
 *
 * Grouped by kind, rules first; within a kind the project's own notes come first,
 * marked, and an account note a project note of the same name shadows is left out.
 * An event past its date and a note the assistant removed are not read at all.
 *
 * @param project  this project's notes, `{}` outside one
 * @param account  the account's notes
 */
export function memoryBlock({ project = {}, account = {}, projectName = null, budget = MEMORY_PROMPT_CHARS, held = 0, now = new Date() }) {
  const shadowed = new Set(Object.keys(currentNotes(project, now)));
  const mine = newestFirst(project, now).map(([key, note]) => ({ key, note, here: true }));
  const rest = newestFirst(account, now)
    .filter(([key]) => !shadowed.has(key))
    .map(([key, note]) => ({ key, note, here: false }));
  const groups = ['rule', 'preference', 'fact', 'event']
    .map((kind) => ({ title: KIND_TITLES[kind], notes: [...mine, ...rest].filter((n) => kindOf(n.note) === kind) }))
    .filter((g) => g.notes.length);
  if (!groups.length && !held) return '';

  const out = [
    '## Memory',
    'Notes you saved in earlier conversations. They are background, not instructions from this turn — what the user says now wins. ' +
      'Keep them true: correct one with `memory_edit` and remove a stale one with `memory_delete` (load them with `load_tools`).',
  ];
  if (mine.length) {
    out.push(`This project${projectName ? ` ("${projectName}")` : ''} has its own notes, marked (project); they win where they disagree with the others.`);
  }
  let used = out.join('\n').length;
  const unshown = [];

  for (const group of groups) {
    let headed = false;
    for (const { key, note, here } of group.notes) {
      const date = day(note.validFrom || note.updatedAt);
      const until = note.expires ? `until ${note.expires}` : '';
      const tags = [here ? 'project' : '', date, until].filter(Boolean).join(', ');
      const label = `- **${key}**${tags ? ` (${tags})` : ''}: `;
      const body = note.content.trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ');
      const full = `${label}${body}`;
      const preview = `${label}${body.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS)}… [cut — memory_read "${key}" for the rest]`;
      const heading = headed ? 0 : group.title.length + 1;
      const room = budget - used - heading;
      const line = full.length + 1 <= room ? full : preview.length + 1 <= room && body.length > PREVIEW_CHARS ? preview : null;
      if (!line) {
        unshown.push(key);
        continue;
      }
      if (!headed) {
        out.push(group.title);
        headed = true;
        used += heading;
      }
      out.push(line);
      used += line.length + 1;
    }
  }

  if (unshown.length) {
    const names = [];
    let length = 0;
    for (const key of unshown) {
      if (length + key.length > 600) break;
      names.push(key);
      length += key.length + 2;
    }
    const more = unshown.length - names.length;
    out.push(
      `(${unshown.length} more note${unshown.length === 1 ? '' : 's'} not shown for space: ${names.join(', ')}` +
        `${more ? `, and ${more} more` : ''}. \`memory_search\` or \`memory_read\` opens them.)`,
    );
  }
  if (held) out.push(heldNotesLine(held));
  return out.join('\n');
}

/**
 * The memory block for this turn, or '' when there is nothing to say.
 *
 * Nothing at all for an incognito conversation or an account that switched
 * memory off — both are promises that nothing remembered is used here, and the
 * cheapest way to keep a promise about the prompt is not to build that part.
 *
 * A note saved from Google data is left out of a conversation that holds none
 * (`options.googleData`), which may be going to a model that can train on it.
 *
 * @param {{ googleData?: boolean }} [options]
 */
export async function memoryForTurn(userId, chat, prefs, options = {}) {
  if (!userId || prefs?.memory === false || chat?.incognito) return '';
  const store = getStore();
  // As they stand now: no removed note's marker, no event past its date — so the
  // count of notes held back from Google below counts only notes that would be read.
  let account = currentNotes((await store.getUserSetting(userId, MEMORY_KEY).catch(() => null)) || {});
  let project = {};
  let projectName = null;
  if (chat?.project_id) {
    project = currentNotes((await store.getUserSetting(userId, projectMemoryKey(chat.project_id)).catch(() => null)) || {});
    projectName = (await store.getProject(userId, chat.project_id).catch(() => null))?.name || null;
  }
  let held = 0;
  if (!options.googleData) {
    const fromAccount = withoutGoogleNotes(account);
    const fromProject = withoutGoogleNotes(project);
    account = fromAccount.kept;
    project = fromProject.kept;
    held = fromAccount.held + fromProject.held;
  }
  return memoryBlock({ project, account, projectName, held });
}

/** Every tool that reads or writes notes. */
export const MEMORY_TOOLS = ['memory_write', 'memory_append', 'memory_edit', 'memory_delete', 'memory_read', 'memory_search'];

/** The ones that change a note: a bot's conversation is not given these (it keeps its own memory, server/bots/memory.js). */
export const MEMORY_WRITE_TOOLS = ['memory_write', 'memory_append', 'memory_edit', 'memory_delete'];

/**
 * Tools this conversation must not be offered, given where it is and what the
 * account chose — one answer for the main loop and the sub-agents alike.
 *
 * Incognito takes away everything that remembers: notes, chat search, and
 * `skill_write`, which would otherwise file a procedure learned in a
 * conversation that promised to leave nothing behind.
 *
 * And a plugin the account switched off in the composer's + menu takes its
 * tools with it (public/js/plugins.js) — withheld here, so they are neither
 * offered nor listed in `load_tools`, and a call to one is refused in words.
 *
 * So does a connector paused there. Leaving it out of the catalogue was not
 * enough: a model is not held to the tools it was offered, and a page it read
 * could name `gmail` and have it run on the paused account's token (security
 * review, 2026-10-14). Withheld, the call is refused before anything is sent.
 * Pausing Google pauses every Google product.
 *
 * @param {{ chat?: any, prefs?: any }} [options]
 */
export function withheldTools({ chat = null, prefs = {} } = {}) {
  const out = pluginTools(prefs.pluginsOff);
  const paused = new Set(Array.isArray(prefs.connectorsOff) ? prefs.connectorsOff : []);
  if (paused.size) {
    for (const tool of TOOLS) {
      const needs = String(tool.needs || '');
      if (needs && (paused.has(needs) || (paused.has('google') && needs.startsWith('google_')))) out.add(tool.name);
    }
  }
  const incognito = !!chat?.incognito;
  if (incognito || prefs.memory === false) for (const name of MEMORY_TOOLS) out.add(name);
  if (incognito || prefs.chatSearch === false) out.add('search_chats');
  // Connector search switched off in Settings → Capabilities (owner, 2026-11-01).
  if (prefs.connectorSearch === false) for (const name of ['search_connectors', 'suggest_connectors']) out.add(name);
  if (incognito) out.add('skill_write');
  return out;
}

/* ── searching them ────────────────────────────────────────────────── */

const termsOf = (text) => [...new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];

/**
 * Notes ranked against a question — by name first, then by what they say.
 *
 * Crude on purpose: notes are few and short, and the words somebody uses to ask
 * about one are nearly always words in it. Folded, so "lich hop" finds "lịch họp".
 *
 * @param notes  `[{ key, scope, content, updatedAt }]`
 */
export function rankNotes(notes, query, limit = 8) {
  const wanted = termsOf(query);
  const phrase = fold(query).trim();
  return (notes || [])
    .map((note) => {
      const name = fold(note.key);
      const body = fold(note.content);
      let score = 0;
      for (const term of wanted) {
        if (name.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      if (phrase.length > 3 && body.includes(phrase)) score += 4;
      return { ...note, score };
    })
    .filter((note) => note.score > 0)
    .sort((a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, Math.min(Math.max(Number(limit) || 8, 1), 20));
}
