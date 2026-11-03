/**
 * The quality gate on a finished answer (QC-001, owner 2026-11-02).
 *
 * The owner asked for a gate that catches what is wrong in an answer and has
 * the model redo that part — only that part — so what was right stays exactly
 * as it was. No gate makes a model incapable of inventing things; what this one
 * does is check the one kind of invention that can be checked without trusting
 * another model's opinion of it:
 *
 *   1. Detect, deterministically: a web address in the answer that nothing in
 *      the conversation accounts for — not in what the person wrote, not in any
 *      page, search result or file a tool brought back. An address the model
 *      wrote from memory is the commonest fabrication a reader acts on (they
 *      click it), and checking it needs no judgement.
 *   2. Repair, narrowly: one short call asks the model for find-and-replace
 *      edits to the sentences holding those addresses — cite a source it did
 *      read, or keep the words and drop the link. An edit is applied only if
 *      its `find` is in the answer exactly once, holds a flagged address, and
 *      its `replace` brings no new unsourced address. Everything else in the
 *      answer is byte for byte what was streamed.
 *   3. Fall back, deterministically: any flagged address still there loses its
 *      link (the words stay), and a line says what the check did — so the
 *      person sees that it ran and what it changed.
 *
 * Addresses inside code blocks are examples, not citations, and are left alone.
 */

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;
const FENCE = /^\s{0,3}(```|~~~)/;
/** Tracking parameters that change nothing about which page an address is. */
const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;
/**
 * What ends a sentence or a Markdown mark rather than an address: `**…**`,
 * `_…_` and `~~…~~` round a link are emphasis, and read as part of it they
 * made a page a search really returned look invented (QC-003).
 */
const TRAILING = /[.,;:!?)\]}>'"*_~\\]+$/;

/** An address as compared: no scheme, no `www.`, no fragment or tracking, no trailing slash or punctuation. */
export function addressKey(url) {
  const raw = String(url || '').replace(TRAILING, '');
  try {
    const u = new URL(raw);
    for (const name of [...u.searchParams.keys()]) if (TRACKING.test(name)) u.searchParams.delete(name);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const rest = `${u.pathname.replace(/\/+$/, '')}${u.search}`;
    return `${host}${rest}`;
  } catch {
    return raw.toLowerCase();
  }
}

const hostOf = (key) => key.split('/')[0].split('?')[0];

/** The text of a message a reader could have taken an address from. */
function textsOf(message) {
  const out = [];
  if (message?.role === 'user' && message.text) out.push(String(message.text));
  for (const r of message?.results || []) if (r?.content && !r.isError) out.push(String(r.content));
  // What a tool was asked to open is something the conversation named, not something invented.
  for (const c of message?.toolCalls || []) {
    for (const v of Object.values(c?.input || {})) if (typeof v === 'string' && /^https?:\/\//.test(v)) out.push(v);
  }
  return out;
}

/**
 * Every string in what a step sent the model (QC-003): the system prompt with
 * the memory notes and project instructions in it, the transcript with the
 * text of attached files and the project's passages. Stored messages alone
 * missed all of those, so a link the person's own file gave was taken for an
 * invention. A picture's or a document's bytes are not text and are skipped.
 *
 * @param {any} value
 * @returns {string[]}
 */
export function textsIn(value, out = [], depth = 0) {
  if (depth > 12 || value == null) return out;
  if (typeof value === 'string') {
    if (value.length <= 2_000_000 && value.includes('http')) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) textsIn(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) if (!/^(data|base64|bytes|image)$/i.test(key)) textsIn(item, out, depth + 1);
  }
  return out;
}

/**
 * Every address the conversation holds, as keys, and the hosts they are on.
 *
 * @param {any[]} messages  the stored conversation
 * @param {string[]} [sources]  what else the model was shown — `textsIn` of what was sent
 */
export function evidenceOf(messages, sources = []) {
  const keys = new Set();
  const hosts = new Set();
  const texts = [...(messages || []).flatMap((m) => textsOf(m)), ...sources];
  for (const text of texts) {
    for (const url of text.match(URL_RE) || []) {
      const key = addressKey(url);
      keys.add(key);
      hosts.add(hostOf(key));
    }
  }
  return { keys, hosts };
}

/** Whether the conversation accounts for an address: the page itself, or — for a bare site address — its site. */
function accountedFor(url, evidence) {
  const key = addressKey(url);
  if (evidence.keys.has(key)) return true;
  // "https://vnexpress.net" for a site whose pages were read is the site, not an invention.
  return !key.includes('/') && evidence.hosts.has(hostOf(key));
}

/**
 * The addresses in an answer that nothing in the conversation accounts for,
 * once each, outside code blocks.
 *
 * @param {string} answer
 * @param {{ keys: Set<string>, hosts: Set<string> }} evidence
 * @returns {string[]}
 */
export function unsourcedLinks(answer, evidence) {
  const found = new Map();
  let fenced = false;
  for (const line of String(answer || '').split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const raw of line.match(URL_RE) || []) {
      const url = raw.replace(TRAILING, '');
      if (!accountedFor(url, evidence) && !found.has(addressKey(url))) found.set(addressKey(url), url);
    }
  }
  return [...found.values()];
}

/**
 * The model's edits, applied where they are safe; null for an answer that would
 * not parse or held nothing usable.
 *
 * @param {string} answer
 * @param {string} reply  the model's JSON
 * @param {string[]} flagged
 * @param {{ keys: Set<string>, hosts: Set<string> }} evidence
 */
export function applyEdits(answer, reply, flagged, evidence) {
  let parsed;
  try {
    const json = String(reply || '').match(/\{[\s\S]*\}/)?.[0];
    parsed = json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
  const edits = Array.isArray(parsed?.edits) ? parsed.edits.slice(0, 20) : [];
  let text = answer;
  let applied = 0;
  for (const e of edits) {
    const find = typeof e?.find === 'string' ? e.find : '';
    const replace = typeof e?.replace === 'string' ? e.replace : null;
    if (!find || replace == null || find.length > 600) continue;
    // Exactly once, and about a flagged address: an edit cannot reach the parts that were right.
    if (text.indexOf(find) === -1 || text.indexOf(find) !== text.lastIndexOf(find)) continue;
    if (!flagged.some((url) => find.includes(url))) continue;
    if (unsourcedLinks(replace, evidence).length) continue;
    text = text.replace(find, () => replace);
    applied += 1;
  }
  return { text, applied };
}

/** Each address still flagged loses its link, and keeps its words. */
export function unlink(answer, flagged) {
  let text = answer;
  for (const url of flagged) {
    const at = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text
      .replace(new RegExp(`\\[([^\\]]*)\\]\\(${at}[^)]*\\)`, 'g'), (_m, label) => label)
      .replace(new RegExp(`<?${at}>?`, 'g'), '');
  }
  return text;
}

/** What the gate says it did, in the account's language. */
export function gateNote({ fixed, removed }, language = 'en') {
  const vi = language === 'vi';
  const parts = [];
  if (fixed) parts.push(vi ? `sửa ${fixed} chỗ trích dẫn` : `corrected ${fixed} citation${fixed === 1 ? '' : 's'}`);
  if (removed) parts.push(vi ? `bỏ ${removed} liên kết không có trong nguồn nào đã đọc` : `removed ${removed} link${removed === 1 ? '' : 's'} not found in any source read`);
  if (!parts.length) return '';
  // Stars, not underscores: the chat's Markdown reads only *…* as emphasis.
  return vi ? `*Kiểm tra nguồn: đã ${parts.join(', ')}.*` : `*Source check: ${parts.join('; ')}.*`;
}

const REPAIR_SYSTEM =
  'You correct one thing in an answer you wrote: web addresses that are in no source. ' +
  'Reply with JSON only: {"edits":[{"find":"…","replace":"…"}]}.';

/**
 * How many repair rounds before the fall-back (AUDIT_RULES v5 V8): each is one
 * call, only while flagged addresses remain, and a round that changes nothing
 * ends it — the same request again would get the same answer.
 * QUALITY_GATE_ROUNDS, 1–3.
 */
export const repairRounds = (env = process.env) => Math.max(1, Math.min(3, Number(env.QUALITY_GATE_ROUNDS) || 2));

/**
 * The gate, run on a finished answer.
 *
 * @param {{
 *   answer: string,
 *   messages: any[],
 *   sources?: string[],
 *   moreSources?: (() => Promise<string[]>) | null,
 *   language?: string,
 *   ask: (system: string, prompt: string) => Promise<string>,
 *   rounds?: number,
 * }} input  `ask` makes a repair call and returns the model's text; `rounds` caps them.
 *   `moreSources` is what the model was shown that costs something to read as
 *   text — a PDF it was handed as a file (QC-005) — asked for once, and only
 *   when an address is flagged.
 * @returns {Promise<{ text: string, changed: boolean, flagged: string[], fixed: number, removed: number }>}
 */
export async function checkAnswer({ answer, messages, sources = [], moreSources = null, language = 'en', ask, rounds = repairRounds() }) {
  let evidence = evidenceOf(messages, sources);
  let flagged = unsourcedLinks(answer, evidence);
  if (flagged.length && moreSources) {
    const more = await Promise.resolve()
      .then(moreSources)
      .catch(() => []);
    if (more?.length) {
      evidence = evidenceOf(messages, [...sources, ...more]);
      flagged = unsourcedLinks(answer, evidence);
    }
  }
  if (!flagged.length) return { text: answer, changed: false, flagged, fixed: 0, removed: 0 };

  const read = [...evidence.keys].slice(0, 30).map((k) => `- https://${k}`).join('\n') || '- (none)';
  const promptFor = (text, still) =>
    [
      'Answer:',
      '<<<',
      text,
      '>>>',
      '',
      'These addresses are in the answer but in nothing the user gave and no page or result read in this conversation:',
      ...still.map((u) => `- ${u}`),
      '',
      'Sources that were read (cite one of these only if it supports the same sentence):',
      read,
      '',
      'For each sentence holding one of those addresses: replace the address with a source that was read, or keep the words, drop the link and add "(unverified)".',
      'Change nothing else. Each "find" is copied exactly from the answer and is at most one sentence.',
    ].join('\n');
  // What is still flagged, checked again over the whole answer after each patch.
  const stillFlagged = (text) => unsourcedLinks(text, evidence).filter((u) => flagged.some((f) => addressKey(f) === addressKey(u)));

  let text = answer;
  let fixed = 0;
  let still = flagged;
  for (let round = 0; round < rounds && still.length; round += 1) {
    let edited = null;
    try {
      edited = applyEdits(text, await ask(REPAIR_SYSTEM, promptFor(text, still)), still, evidence);
    } catch {
      /* the repair is a courtesy; the fall-back below still holds */
    }
    if (!edited?.applied) break;
    text = edited.text;
    fixed += edited.applied;
    still = stillFlagged(text);
  }
  const left = stillFlagged(text);
  if (left.length) text = unlink(text, left);
  const note = gateNote({ fixed, removed: left.length }, language);
  return { text: note ? `${text.trimEnd()}\n\n${note}` : text, changed: true, flagged, fixed, removed: left.length };
}
