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
 * Addresses in code, a block or a span, are examples, not citations, and are
 * left alone.
 */

/**
 * An address in text, and where it ends (QC-017). A table's `|`, curly quotes and
 * CJK punctuation end it, as does a comma before the next address: read as part of
 * it, they and the word after them made a true link look invented, and went with
 * it. Brackets are part of it only when they balance, so `Foo_(planet)` and
 * `Foo_(other)` are two pages, and the `)` closing a Markdown link is neither.
 */
const URL_RE = /https?:\/\/(?:(?!,https?:\/\/)[^\s<>()[\]"'`|“”‘’«»，。；：！？、）】》（【《]|\([^\s()]*\))+/g;
const FENCE = /^\s{0,3}(```|~~~)/;
/** Inline code, an example as a code block is: `curl https://…` was left as `curl `. */
const CODE_SPAN = /``[^`]*``|`[^`]*`/g;
/** Tracking parameters that change nothing about which page an address is. */
const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;
/**
 * What ends a sentence or a Markdown mark rather than an address: `**…**`,
 * `_…_` and `~~…~~` round a link are emphasis, and read as part of it they
 * made a page a search really returned look invented (QC-003).
 */
const TRAILING = new Set('.,;:!?]}>\'"*_~\\');

/** A string without what ends it from `chars`. A loop: a regex for this took 15 s on a long run of dots in a page. */
function trimEnd(text, chars) {
  let end = text.length;
  while (end > 0 && chars.has(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

const SLASH = new Set('/');

/** A path's words, however they were encoded: `%e1%bb%87`, `%E1%BB%87` and `ệ` are one letter. */
function decodedPath(pathname) {
  const upper = pathname.replace(/%[0-9a-f]{2}/gi, (hex) => hex.toUpperCase());
  try {
    return decodeURI(upper).normalize('NFC');
  } catch {
    return upper;
  }
}

/**
 * An address as compared: no scheme, no `www.`, no fragment or tracking, no
 * trailing slash or punctuation, and however its letters were encoded. The query
 * by its decoded values (QC-017): deleting a tracking parameter re-serialises the
 * rest, which made `?q=a%20b&utm_source=rss` another page from `?q=a%20b`.
 */
export function addressKey(url) {
  const raw = trimEnd(String(url || '').replace(/&amp;/g, '&').normalize('NFC'), TRAILING);
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const query = [...u.searchParams].filter(([name]) => !TRACKING.test(name)).map(([name, value]) => `${name}=${value}`).join('&');
    return `${host}${trimEnd(decodedPath(u.pathname), SLASH)}${query ? `?${query}` : ''}`;
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

/** The fields of a step that reach the model: see `textsIn`. */
const SENT_FIELDS = /^(system|passages|grounded|outgoing|text|content|parts|results)$/;

/**
 * Every string in what a step sent the model (QC-003): the system prompt with
 * the memory notes and project instructions in it, the transcript with the
 * text of attached files and the project's passages. Stored messages alone
 * missed all of those, so a link the person's own file gave was taken for an
 * invention.
 *
 * Only the fields a provider is sent (QC-012): a message's `text`, its parts'
 * and its results' `content`. A result also keeps what was never shown as
 * reading — a drawing's markup, which the model wrote itself, so a figure it
 * drew vouched for the same figure in its answer — and ids and dates of no
 * meaning. A picture's or a document's bytes are not text either.
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
    for (const [key, item] of Object.entries(value)) if (SENT_FIELDS.test(key)) textsIn(item, out, depth + 1, every);
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
 * once each, outside code.
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
    for (const raw of line.replace(CODE_SPAN, ' ').match(URL_RE) || []) {
      const url = trimEnd(raw, TRAILING);
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
  const keys = new Set(flagged.map(addressKey));
  let text = answer;
  let applied = 0;
  let cited = 0;
  let dropped = 0;
  for (const e of edits) {
    const find = typeof e?.find === 'string' ? e.find : '';
    const replace = typeof e?.replace === 'string' ? e.replace : null;
    if (!find || replace == null || find.length > 600) continue;
    // Exactly once, and about a flagged address: an edit cannot reach the parts that were right.
    if (text.indexOf(find) === -1 || text.indexOf(find) !== text.lastIndexOf(find)) continue;
    // The whole address (QC-014): `…/docs/intro` holds `…/docs` as text, and is another page.
    const about = new Set((find.match(URL_RE) || []).map(addressKey).filter((key) => keys.has(key)));
    if (!about.size) continue;
    if (unsourcedLinks(replace, evidence).length) continue;
    text = text.replace(find, () => replace);
    applied += 1;
    // Citing a source read corrects the sentence; keeping only its words takes the links away (QC-011).
    if (replace.match(URL_RE)) cited += 1;
    else dropped += about.size;
  }
  return { text, applied, cited, dropped };
}

/**
 * A link in Markdown, its address taken whole: brackets in it, a title after it,
 * a picture's `!` before it. Its words may hold brackets, `[Report [PDF]](…)`, but
 * not a whole link, so a picture inside a link is its own match. Built so that a
 * line of `[[[[` fails at once at each one, rather than reading on to the end.
 */
const MARKDOWN_LINK = /!?\[((?:[^[\]]|\[[^[\]]*\](?!\())*)\]\(\s*<?(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** `[1]: https://…`, a link's address kept apart from it: flagged, the whole line goes, not only the address. */
const LINK_DEFINITION = /^\s*\[[^\]]+\]:\s*<?(https?:\/\/[^\s>]+)>?(?:\s.*)?$/;
const BARE_ADDRESS = new RegExp(`<?(${URL_RE.source})>?`, 'g');

/**
 * Each address still flagged loses its link, and keeps its words. By the
 * address as compared, whole (QC-014): matched as text, a flagged `…/docs` also
 * took the true `…/docs/intro` with it, on every answer the gate touched, while
 * the same page spelled another way (`www.`, a trailing slash, `utm_source`)
 * kept its live link. Code is an example, and is left as it is.
 *
 * @param {string} answer
 * @param {string[]} flagged
 */
export function unlink(answer, flagged) {
  const keys = new Set(flagged.map(addressKey));
  const isFlagged = (url) => keys.has(addressKey(url));
  let fenced = false;
  return String(answer || '')
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const defined = line.match(LINK_DEFINITION);
      if (defined && isFlagged(defined[1])) return '';
      // Code is set aside and put back, so nothing in it is touched.
      const code = [];
      const open = line.replace(CODE_SPAN, (span) => {
        code.push(span);
        return `\0${code.length - 1}\0`;
      });
      return open
        .replace(MARKDOWN_LINK, (whole, label, url) => (isFlagged(url) ? label : whole))
        .replace(BARE_ADDRESS, (whole, url) => {
          if (!isFlagged(url)) return whole;
          // The full stop that ended the sentence is not part of the address.
          return url.slice(trimEnd(url, TRAILING).length);
        })
        .replace(/\0(\d+)\0/g, (_m, at) => code[at]);
    })
    .join('\n');
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
  let dropped = 0;
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
    fixed += edited.cited;
    dropped += edited.dropped;
    still = stillFlagged(text);
  }
  const left = stillFlagged(text);
  if (left.length) text = unlink(text, left);
  const removed = left.length + dropped;
  const note = gateNote({ fixed, removed }, language);
  return { text: note ? `${text.trimEnd()}\n\n${note}` : text, changed: true, flagged, fixed, removed };
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
 * passed over. A colon after a word is punctuation (`Giá:15.000`); after a digit
 * it is the rest of a time. A space before the percent sign still makes it one.
 */
const FIGURE_RE = /(?<![\p{L}\p{N}_]|[\p{L}\p{N}_][.,/-]|\p{N}:)\d+(?:[.,:/-]\d+)*(?:[ \u00A0]?%)?/gu;
/** Figures in a source, read loosely: `100km` and `12.000đ` hold 100 and 12.000. */
const SOURCE_FIGURE_RE = /\d+(?:[.,:/-]\d+)*/g;
/** What marks a figure the check could not find, in the account's language. */
const unverifiedMark = (language) => (language === 'vi' ? '(chưa kiểm chứng)' : '(unverified)');

/** A date, a time or a range of whole numbers: written with `/`, `:` or `-`, with no decimal in it. */
const isDateLike = (token) => /[/:-]/.test(token) && !/[.,]/.test(token);
/** A range: two figures and one dash, `2020-2024`, `0.5-1.0%`, `15,000-20,000`. */
const RANGE = /^([\d.,]+)-([\d.,]+)\s*%?$/;
/** A whole number, plain or grouped in thousands: `4500`, `4.500`, `1,234,567`. */
const WHOLE_NUMBER = /^\d+$|^\d{1,3}(?:[.,]\d{3})+$/;
/** A decimal, its whole part plain or grouped: `1234.56`, `1,234.56`, `1.234,5`. */
const GROUPED_DECIMAL = /^(\d+|\d{1,3}(?:[.,]\d{3})+)[.,](\d{1,2})$/;
const ZERO = new Set('0');

/**
 * The digit runs of a figure. A date's lose their leading zeros, `03/11/2026`
 * being 3, 11, 2026. A number's keep them (QC-009): stripped, `0.05%` read as
 * `0.5%`, `4.05` as `4.5` and `2,050,000` as `2,500` — ten times wrong, passed
 * as found, which is the very error this check is for.
 */
const runsOf = (token) => {
  const runs = token.match(/\d+/g) || [];
  return isDateLike(token) ? runs.map((run) => run.replace(/^0+(?=\d)/, '')) : runs;
};

/**
 * A number as compared: a decimal's trailing zeros say nothing, so `4.50` is
 * `4.5` and `100.00` is `100`. Three digits after a lone separator are left as
 * they are: `4.500` is four thousand five hundred as often as it is four and a half.
 */
function numberKey(runs) {
  const fraction = runs[1];
  if (runs.length !== 2 || fraction.length === 3 || !fraction.endsWith('0')) return runs.join('.');
  const kept = fraction.replace(/0+$/, '');
  return kept ? `${runs[0]}.${kept}` : runs[0];
}

/**
 * A date as day, month, year, however it was written, so `03/11/2026` is
 * `2026-11-03` and is not `11/03/2026`. Sorted, the runs made a swapped day and
 * month the same date (QC-015). A page in month-first order is therefore marked
 * when restated day-first: the safe way round.
 */
function dateKey(runs) {
  if (runs.length !== 3) return null;
  if (runs[0].length === 4) return `d:${runs[2]}.${runs[1]}.${runs[0]}`;
  return runs[2].length === 4 ? `d:${runs.join('.')}` : null;
}

/**
 * The ways one figure can be written and still be the same one: `4,5` and
 * `4.5`, `1,234,567` and `1234567`, `1,234.56` and `1234.56`, `03/11/2026` and
 * `2026-11-03`. The digits alone count only for a whole number (QC-015): for
 * anything else they made `$12.50` the same as `$1,250`, and `10,000` the same as
 * `$100.00`. A date or a time is kept apart from a decimal (QC-018), or `10:05`
 * passed on a page saying 10.5%, and `3/11` on 3.11%.
 */
function figureKeys(token) {
  const bare = token.replace(/\s*%$/, '');
  const runs = runsOf(bare);
  if (isDateLike(bare)) return [`t:${runs.join('.')}`, dateKey(runs)].filter(Boolean);
  if (WHOLE_NUMBER.test(bare)) return [numberKey(runs), `n:${runs.join('')}`];
  const decimal = bare.match(GROUPED_DECIMAL);
  return decimal ? [numberKey(runs), `v:${decimal[1].replace(/\D/g, '')}.${trimEnd(decimal[2], ZERO)}`] : [numberKey(runs)];
}

/**
 * Every figure the sources hold, as keys — and, on its own, what a date or a
 * range holds: each end of `0.5-1.0%`, and the year in `2026-11-03`. Only the
 * year (QC-018): with every part, a page's date of 2026-11-03 vouched for an
 * invented "11%", and 12/05/2026 for "12 tỷ".
 */
export function figureEvidenceOf(messages, sources = []) {
  const keys = new Set();
  const add = (token) => {
    for (const key of figureKeys(token)) keys.add(key);
  };
  for (const text of [...(messages || []).flatMap((m) => textsOf(m)), ...sources]) {
    for (const token of text.match(SOURCE_FIGURE_RE) || []) {
      add(token);
      const range = token.match(RANGE);
      if (range) {
        add(range[1]);
        add(range[2]);
      } else if (isDateLike(token) && !token.includes(':')) {
        for (const run of runsOf(token)) if (run.length === 4) add(run);
      }
    }
  }
  return keys;
}

/** A figure worth checking: two digits or more, or a percentage. */
const worthChecking = (token) => token.endsWith('%') || token.replace(/\D/g, '').length >= 2;

/** The line a check ends an answer with: it is about the check, not about the world. */
const CHECK_NOTE = /^\*(?:Source check|Kiểm tra nguồn|Figure check|Kiểm tra số liệu):/;
/** A number that only orders what follows: `12.`, `**12.**`, `- 3)`, `> 4.`, and a heading's `## 1.1`. */
const LIST_NUMBER = /^(\s*(?:>\s*)*(?:[-*+]\s+)?(?:\*\*|__)?)(\d+[.)])(?=(?:\*\*|__)?\s)/;
const HEADING_NUMBER = /^(\s*(?:>\s*)*#{1,6}\s+(?:\*\*|__)?)(\d+(?:\.\d+)*[.)]?)(?=(?:\*\*|__)?\s)/;
/** A tag's attributes are markup: `width="640"` says nothing about the world. */
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>/g;
/** A currency's code, written onto its figure: it is not a name like `gpt-5`, and `USD1,300` is a price. */
const CURRENCY_CODE = /\b(?:USD|VND|EUR|GBP|JPY|CNY|KRW|THB|AUD|CAD|SGD)(?=\d)/g;
/**
 * What is written onto a figure: the `đ` of `15.000đ`, the `km/h` of `100km/h`,
 * the rest of `2026-11-03T10:30:00Z`. A mark goes after all of it.
 */
const ATTACHED = String.raw`(?:[\p{L}\p{N}_%]|[:.,/-](?=[\p{L}\p{N}]))*`;
const ATTACHED_UNIT = new RegExp(`^${ATTACHED}`, 'u');
/** The mark, straight after a figure — what is written onto it and a closing `**` aside. */
const MARKED_NEXT = new RegExp(`^${ATTACHED}[*_~]*\\s*\\((?:unverified|chưa kiểm chứng)\\)`, 'iu');

/**
 * Each figure in an answer, where it is, outside code, addresses, footnotes
 * and numbering — where its mark goes, and whether it already has one.
 *
 * Marked means straight after it (QC-010): any "(unverified)" later in the
 * sentence let every figure before it through, and the source check writes
 * that word too.
 *
 * @param {string} answer
 * @returns {{ line: number, after: number, token: string, marked: boolean }[]}
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
      if (fenced || CHECK_NOTE.test(line)) return;
      // Blanked rather than cut, so a position here is a position in the line.
      const blank = (m) => ' '.repeat(m.length);
      const numberless = (_m, lead, number) => lead + blank(number);
      const seen = line
        .replace(URL_RE, blank)
        .replace(CODE_SPAN, blank)
        .replace(HTML_TAG, blank)
        .replace(CURRENCY_CODE, blank)
        .replace(/\[\^?\d+\]/g, blank)
        .replace(LIST_NUMBER, numberless)
        .replace(HEADING_NUMBER, numberless);
      for (const m of seen.matchAll(FIGURE_RE)) {
        const token = m[0];
        if (!worthChecking(token)) continue;
        const end = m.index + token.length;
        // Far enough for any unit and mark, and no further: a long line is read once, not once per figure.
        const rest = line.slice(end, end + 200);
        out.push({ line: n, after: end + (rest.match(ATTACHED_UNIT)?.[0].length || 0), token, marked: MARKED_NEXT.test(rest) });
      }
    });
  return out;
}

/**
 * Whether what was read holds a figure: as written, or a range whose two ends
 * are both there (`2020-2024`, where the page has "2020–2024"). Only a range: a
 * date is its parts together, or `15/03/2026` would pass on a page that says
 * 15 April 2026.
 */
function accountedFigure(token, evidence) {
  const holds = (figure) => figureKeys(figure).some((key) => evidence.has(key));
  if (holds(token)) return true;
  const range = token.match(RANGE);
  return !!range && holds(range[1]) && holds(range[2]);
}

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
  let corrected = 0;
  let marked = 0;
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
    // Corrected means every figure in it is now one that was read; a mark is a mark, whoever wrote it (QC-011).
    const left = figuresIn(replace).filter((f) => !accountedFigure(f.token, evidence));
    if (left.length) marked += left.filter((f) => f.marked).length;
    else corrected += 1;
  }
  return { text, applied, corrected, marked };
}

/** Each unfound, unmarked figure is followed by the mark; nothing else changes. */
export function markFigures(answer, evidence, language = 'en') {
  const lines = String(answer || '').split('\n');
  const marks = figuresIn(answer).filter((f) => !f.marked && !accountedFigure(f.token, evidence));
  // From the end of each line, so a mark does not move the figures before it; one mark to a
  // place, for `30%-40%`, whose two figures end there together.
  let last = null;
  for (const f of marks.reverse()) {
    if (last && last.line === f.line && last.after === f.after) continue;
    lines[f.line] = `${lines[f.line].slice(0, f.after)} ${unverifiedMark(language)}${lines[f.line].slice(f.after)}`;
    last = f;
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
  let markedByModel = 0;
  try {
    const edited = applyFigureEdits(answer, await ask(FIGURE_REPAIR_SYSTEM, prompt), flagged, evidence);
    if (edited?.applied) {
      text = edited.text;
      fixed = edited.corrected;
      markedByModel = edited.marked;
    }
  } catch {
    /* the repair is a courtesy; the marks below still hold */
  }
  const marks = markFigures(text, evidence, language);
  const marked = markedByModel + marks.marked;
  const note = figureNote({ fixed, marked }, language);
  return { text: note ? `${marks.text.trimEnd()}\n\n${note}` : marks.text, changed: true, flagged, fixed, marked };
}
