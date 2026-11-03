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
export function textsIn(value, out = [], depth = 0, every = false) {
  if (depth > 12 || value == null) return out;
  if (typeof value === 'string') {
    // Only what could hold an address, unless `every` — the figure check reads all of it (QC-002).
    if (value.length <= 2_000_000 && (every || value.includes('http'))) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) textsIn(item, out, depth + 1, every);
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) if (!/^(data|base64|bytes|image)$/i.test(key)) textsIn(item, out, depth + 1, every);
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

/*
 * The figure check (QC-002, owner 2026-11-03) — off unless `prefs.figureCheck`.
 *
 * A figure is the next invention a reader acts on after a link: a price, a
 * rate, a date. After a turn that read the web, each figure in the answer —
 * two digits or more, a percentage, a date — is looked for in what was read,
 * the same way an address is: found, it passes with no call and no model's
 * opinion; found nowhere, its sentence goes back once to be corrected from a
 * source or marked "(unverified)", and whatever is still unfound is marked.
 * A figure worked out from the sources (a sum, a change) is in none of them
 * either and is marked too: this check cannot tell arithmetic from invention,
 * which is why it is a choice, not the default. Not checked: names, which no
 * rule tells from words, and figures written in words ("five").
 */

/**
 * A figure in an answer: digits not glued to a word before them (`gpt-5`,
 * `v1.25`, `H2O` are names) — nor the tail of such a name once its head was
 * passed over.
 */
const FIGURE_RE = /(?<![\p{L}\p{N}_]|[\p{L}\p{N}_][.,:/-])\d+(?:[.,:/-]\d+)*%?/gu;
/** Figures in a source, read loosely: `100km` and `12.000đ` hold 100 and 12.000. */
const SOURCE_FIGURE_RE = /\d+(?:[.,:/-]\d+)*/g;
/** What marks a figure the check could not find, in either language. */
const UNVERIFIED_RE = /\((?:unverified|chưa kiểm chứng)\)/i;
const unverifiedMark = (language) => (language === 'vi' ? '(chưa kiểm chứng)' : '(unverified)');

/** The digit runs of a figure, without leading zeros: `03/11/2026` is 3, 11, 2026. */
const runsOf = (token) => (token.match(/\d+/g) || []).map((run) => run.replace(/^0+(?=\d)/, ''));

/**
 * The ways one figure can be written and still be the same one: `4,5` and
 * `4.5`, `1,234,567` and `1234567`, `03/11/2026` and `2026-11-03`.
 */
function figureKeys(token) {
  const runs = runsOf(token);
  const keys = [runs.join('.')];
  if (/[/:-]/.test(token)) keys.push(`d:${[...runs].sort().join('.')}`);
  else if (runs.join('').length >= 4) keys.push(`n:${runs.join('')}`);
  return keys;
}

/** Every figure the sources hold, as keys. */
export function figureEvidenceOf(messages, sources = []) {
  const keys = new Set();
  for (const text of [...(messages || []).flatMap((m) => textsOf(m)), ...sources]) {
    for (const token of text.match(SOURCE_FIGURE_RE) || []) for (const key of figureKeys(token)) keys.add(key);
  }
  return keys;
}

/** A figure worth checking: two digits or more, or a percentage. */
const worthChecking = (token) => token.endsWith('%') || token.replace(/\D/g, '').length >= 2;

/**
 * Each figure in an answer, where it is, outside code, addresses and list
 * numbers — and whether its sentence already says it is unverified.
 *
 * @param {string} answer
 * @returns {{ line: number, start: number, end: number, token: string, marked: boolean }[]}
 */
function figuresIn(answer) {
  const out = [];
  let fenced = false;
  String(answer || '')
    .split('\n')
    .forEach((line, n) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      // Blanked rather than cut, so a position here is a position in the line.
      const blank = (m) => ' '.repeat(m.length);
      const seen = line
        .replace(URL_RE, blank)
        .replace(/`[^`]*`/g, blank)
        .replace(/\[\d+\]/g, blank)
        .replace(/^(\s*)(\d+[.)])(?=\s)/, (_m, lead, marker) => lead + blank(marker));
      for (const m of seen.matchAll(FIGURE_RE)) {
        const token = m[0];
        if (!worthChecking(token)) continue;
        const end = m.index + token.length;
        const stop = line.slice(end).search(/[.!?…](?:\s|$)/);
        const rest = stop === -1 ? line.slice(end) : line.slice(end, end + stop + 1);
        out.push({ line: n, start: m.index, end, token, marked: UNVERIFIED_RE.test(rest) });
      }
    });
  return out;
}

const accountedFigure = (token, evidence) => figureKeys(token).some((key) => evidence.has(key));

/**
 * The figures in an answer that nothing read holds and nothing marks, once each.
 *
 * @param {string} answer
 * @param {Set<string>} evidence  `figureEvidenceOf`
 * @returns {string[]}
 */
export function unsourcedFigures(answer, evidence) {
  const found = new Set();
  for (const f of figuresIn(answer)) if (!f.marked && !accountedFigure(f.token, evidence)) found.add(f.token);
  return [...found];
}

/**
 * The model's edits to flagged figures, applied where they are safe: `find`
 * once in the answer and holding a flagged figure, `replace` bringing no new
 * unfound figure and no address `find` did not have.
 */
export function applyFigureEdits(answer, reply, flagged, evidence) {
  let parsed;
  try {
    const json = String(reply || '').match(/\{[\s\S]*\}/)?.[0];
    parsed = json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
  const edits = Array.isArray(parsed?.edits) ? parsed.edits.slice(0, 20) : [];
  const unfound = (s) => new Set(figuresIn(s).filter((f) => !accountedFigure(f.token, evidence)).map((f) => f.token));
  let text = answer;
  let applied = 0;
  for (const e of edits) {
    const find = typeof e?.find === 'string' ? e.find : '';
    const replace = typeof e?.replace === 'string' ? e.replace : null;
    if (!find || replace == null || find.length > 600) continue;
    if (text.indexOf(find) === -1 || text.indexOf(find) !== text.lastIndexOf(find)) continue;
    if (!flagged.some((token) => find.includes(token))) continue;
    const before = unfound(find);
    if ([...unfound(replace)].some((token) => !before.has(token))) continue;
    const links = new Set(find.match(URL_RE) || []);
    if ((replace.match(URL_RE) || []).some((url) => !links.has(url))) continue;
    text = text.replace(find, () => replace);
    applied += 1;
  }
  return { text, applied };
}

/** Each unfound, unmarked figure is followed by the mark; nothing else changes. */
export function markFigures(answer, evidence, language = 'en') {
  const lines = String(answer || '').split('\n');
  const marks = figuresIn(answer).filter((f) => !f.marked && !accountedFigure(f.token, evidence));
  // From the end of each line, so a mark does not move the figures before it.
  for (const f of marks.reverse()) {
    lines[f.line] = `${lines[f.line].slice(0, f.end)} ${unverifiedMark(language)}${lines[f.line].slice(f.end)}`;
  }
  return { text: lines.join('\n'), marked: marks.length };
}

/** What the figure check says it did. */
export function figureNote({ fixed, marked }, language = 'en') {
  const vi = language === 'vi';
  const parts = [];
  if (fixed) parts.push(vi ? `sửa ${fixed} chỗ` : `corrected ${fixed}`);
  if (marked) parts.push(vi ? `đánh dấu ${marked} số liệu không có trong nguồn đã đọc` : `marked ${marked} figure${marked === 1 ? '' : 's'} not found in any source read`);
  if (!parts.length) return '';
  return vi ? `*Kiểm tra số liệu: đã ${parts.join(', ')}.*` : `*Figure check: ${parts.join('; ')}.*`;
}

const FIGURE_REPAIR_SYSTEM =
  'You correct one thing in an answer you wrote: figures that are in no source that was read. ' +
  'Reply with JSON only: {"edits":[{"find":"…","replace":"…"}]}.';

/** The most of the sources the repair call is shown — a bound on what it costs (QC-002). */
const FIGURE_SOURCE_CHARS = 24_000;

/**
 * The figure check, run on a finished answer: one repair call at most, and
 * only when a figure is found nowhere.
 *
 * @param {{
 *   answer: string,
 *   messages: any[],
 *   sources?: string[],
 *   moreSources?: (() => Promise<string[]>) | null,
 *   language?: string,
 *   ask: (system: string, prompt: string) => Promise<string>,
 * }} input  as `checkAnswer`'s; `sources` here is every string shown, not only those holding an address
 * @returns {Promise<{ text: string, changed: boolean, flagged: string[], fixed: number, marked: number }>}
 */
export async function checkFigures({ answer, messages, sources = [], moreSources = null, language = 'en', ask }) {
  let evidence = figureEvidenceOf(messages, sources);
  let flagged = unsourcedFigures(answer, evidence);
  if (flagged.length && moreSources) {
    const more = await Promise.resolve()
      .then(moreSources)
      .catch(() => []);
    if (more?.length) {
      evidence = figureEvidenceOf(messages, [...sources, ...more]);
      flagged = unsourcedFigures(answer, evidence);
    }
  }
  if (!flagged.length) return { text: answer, changed: false, flagged, fixed: 0, marked: 0 };

  // The repair is shown the tool results themselves, newest first, up to FIGURE_SOURCE_CHARS:
  // what a reader would check the figure against.
  const results = (messages || [])
    .flatMap((m) => (m?.results || []).filter((r) => r?.content && !r.isError).map((r) => String(r.content)))
    .reverse();
  let room = FIGURE_SOURCE_CHARS;
  const shown = [];
  for (const text of results) {
    if (room <= 0) break;
    shown.push(text.slice(0, room));
    room -= text.length;
  }
  const prompt = [
    'Answer:',
    '<<<',
    answer,
    '>>>',
    '',
    'These figures are in the answer but in nothing the user gave and no page or result read in this conversation:',
    ...flagged.slice(0, 20).map((f) => `- ${f}`),
    '',
    'What was read:',
    '<<<',
    shown.join('\n\n---\n\n') || '(nothing)',
    '>>>',
    '',
    `For each sentence holding one of those figures: correct the figure to what a source above says, or keep it and put "${unverifiedMark(language)}" right after it — a figure worked out from the sources included.`,
    'Change nothing else. Each "find" is copied exactly from the answer and is at most one sentence.',
  ].join('\n');

  let text = answer;
  let fixed = 0;
  try {
    const edited = applyFigureEdits(answer, await ask(FIGURE_REPAIR_SYSTEM, prompt), flagged, evidence);
    if (edited?.applied) {
      text = edited.text;
      fixed = edited.applied;
    }
  } catch {
    /* the repair is a courtesy; the marks below still hold */
  }
  const marked = markFigures(text, evidence, language);
  const note = figureNote({ fixed, marked: marked.marked }, language);
  return { text: note ? `${marked.text.trimEnd()}\n\n${note}` : marked.text, changed: true, flagged, fixed, marked: marked.marked };
}
