import crypto from 'node:crypto';
import { signedImagePath } from '../imageProxy.js';
import { getStore } from '../store/index.js';
import { redactSecrets } from '../redact.js';
import { readSkill, saveSkill } from '../skills.js';
import { runParallel } from '../subagents.js';
import { runDeepResearch } from '../research/index.js';
import { renderChart, scatterSpec } from './chart.js';
import { imageSearchTool } from './images.js';
import { sportsTool } from './sports.js';
import { showCardTool } from './cards.js';
import { runInSandbox } from '../sandbox.js';
import { cloudBrowser } from '../cloudBrowser/index.js';
import { shareFile } from '../routes/share.js';
import { see } from '../vision.js';
import { evaluate } from './calc.js';
import { extractFromPage } from './extract.js';
import { resolveForUser } from '../autoPick.js';
import { parseSchedule } from '../scheduler.js';
import { validZone } from '../util/zone.js';
import { LIBRARY_IMPLEMENTATIONS } from './library.js';
import { GOOGLE_IMPLEMENTATIONS } from './google.js';
import { normaliseSteps } from '../workflows.js';
import { CONNECTOR_CALLS } from '../connectors.js';
import { getPrefs, getApiKey } from '../settings.js';
import { sendEmail, emailBackend, senderName } from '../email.js';
import { composeMessage, KIND_NAMES } from '../mailTemplate.js';
import { safeFetch, readCapped } from '../util/safeFetch.js';
import { searchDocs, listSources, forgetSource } from '../rag.js';
import { createDocument, extensionOf, readOffice } from '../office/index.js';
import { extractPdfText } from '../pdf.js';
import { saveGenerated, liveRevision } from '../attachments.js';
import { record as recordUsage } from '../usage.js';
import { log } from '../util/trace.js';
import { search, formatResults } from '../search.js';
import { untrusted } from './untrusted.js';
import { searchProject } from '../projects.js';
import { normaliseQuestions, answerText, answerSummary } from './askOptions.js';
import {
  MEMORY_KEY, MAX_NOTE_CHARS, memoryScope, readBothScopes, noteName, memoryRefusal, refusalMessage, rankNotes, stampNote,
} from '../memory.js';
// Only to tell a real tool name from one the model invented — see loadToolsTool.
import { TOOLS_BY_NAME } from './definitions.js';
import { dropElements, stripTags } from '../util/markup.js';

/*
 * Which set of notes a conversation means, and what may be written into one,
 * live in server/memory.js — the prompt reads them back from there too, so the
 * rules for writing and the rules for reading cannot drift apart.
 */

/**
 * Whether this conversation may touch memory at all, and if it may, whether
 * sensitive topics are allowed in it.
 *
 * The tools are withheld from an incognito conversation and from an account that
 * switched memory off, so this is the second lock rather than the first: a call
 * that reaches here anyway — a resumed turn, a model that names a tool it saw
 * earlier — is refused rather than quietly obeyed.
 */
async function memoryAllowed(userId, chatId) {
  const prefs = await getPrefs(userId).catch(() => ({}));
  if (prefs.memory === false) {
    throw new Error('Memory is switched off for this account (Settings → Memory), so nothing is saved or read. Tell the user if it matters.');
  }
  if (chatId) {
    const chat = await getStore().getChat(userId, chatId).catch(() => null);
    if (chat?.incognito) {
      throw new Error('This is an incognito conversation: nothing in it is remembered, and saved notes are not used here.');
    }
  }
  return { allowSensitive: prefs.memorySensitive === true };
}

/** Refuse a note the guard rejects, in words the model passes on. */
function guardNote(text, allowed) {
  const refusal = memoryRefusal(text, allowed);
  if (refusal) throw new Error(refusalMessage(refusal));
}

/**
 * Crude but dependency-free HTML → text. Good enough to feed a model.
 *
 * Scripts, styles and comments are cut out by searching forward rather than by
 * lazy regular expressions, and tags are stripped with `[^<>]` — every step
 * here is linear, because the body is a stranger's and arrives at up to 8 MB
 * before anything is clipped (PERF-017; see util/markup.js).
 */
function htmlToText(html) {
  return stripTags(
    dropElements(html, ['script', 'style', 'noscript'])
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n'),
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    /**
     * No spaces hugging a newline, and this line is the whole point.
     *
     * The collapse below it looks for `\n{3,}`, and it was finding almost
     * none — because the rule above turns a blank line's worth of markup into
     * a single space, so a run of empty block elements leaves `\n \n \n \n`
     * rather than `\n\n\n\n`. Every one of those spaces stopped the match, and
     * a page whose layout is built from empty divs — most of them — arrived
     * with hundreds of blank lines intact.
     *
     * They were charged for. This is the text that goes into the prompt, so
     * that whitespace was paid for on the fetch and again on every later step
     * of the turn, and it made the tool card on screen a column of nothing.
     */
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * How much of a response is worth holding in memory — two numbers, because the
 * two kinds of response fail differently.
 *
 * A page can be cut anywhere: the first megabyte of HTML is still a page, and
 * `max_chars` clips it further anyway. A PDF or a .docx cannot be cut at all —
 * each is a container whose index lives at the end, so half a file is not half
 * a document, it is no document. Those have to arrive whole or not at all, and
 * an 8MB ceiling was refusing perfectly ordinary ones: a scanned exam paper or
 * a photo-heavy report is routinely ten or twenty.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DOC_BYTES = 32 * 1024 * 1024;

/**
 * Formats that are worth downloading whole because there is real text inside.
 *
 * The extension is checked as well as the declared type because servers hand
 * out `application/octet-stream` for these constantly — the WordPress upload
 * directory this was first found failing on does exactly that.
 */
const READABLE_DOCS = [
  { format: 'pdf', byType: /\bpdf\b/, byPath: /\.pdf$/ },
  { format: 'docx', byType: /wordprocessingml/, byPath: /\.docx$/ },
  { format: 'xlsx', byType: /spreadsheetml/, byPath: /\.xlsx$/ },
  { format: 'pptx', byType: /presentationml/, byPath: /\.pptx$/ },
];

const documentFormat = (type, pathname) =>
  READABLE_DOCS.find((doc) => doc.byType.test(type) || doc.byPath.test(pathname))?.format || null;

/** What the bytes actually are, whatever the URL and the headers claimed. */
function sniff(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  return null;
}

/**
 * Bytes that are plainly not text. One NUL settles it — no encoding this could
 * plausibly be puts a zero byte in the first few kilobytes of prose.
 */
const looksBinary = (buffer) => buffer.subarray(0, 8192).includes(0);

// `readCapped` lives beside safeFetch, so every tool that fetches can bound its
// read: a chunked response declares no length, and `res.text()` reads gigabytes
// before any later clip gets a chance.

/**
 * Turn a fetched response into text a model can read.
 *
 * @returns `{ text, note }` — `note` is what the thing was, for the header, so
 *   the model knows it is reading a 40-page PDF and not a web page.
 */
async function readBody(buffer, { format, type, host }) {
  const actual = sniff(buffer);

  if (format === 'pdf' || actual === 'pdf') {
    const read = await extractPdfText(buffer);
    if (!read) {
      throw new Error(
        `${host} returned a PDF with no text in it — it is a scan or photographs of pages, so there is nothing to read.`,
      );
    }
    return {
      text: read.text,
      note: `PDF, ${read.pages} page${read.pages === 1 ? '' : 's'}${read.truncated ? ', read in part' : ''}`,
    };
  }

  if (format && actual === 'zip') {
    // The same reader the chat and a project's shelf use, so a .docx linked on
    // a page and the same .docx attached to a message read identically.
    const read = readOffice(format, buffer);
    if (!read.text?.trim()) throw new Error(`${host} returned a ${format} with no text in it.`);
    return { text: read.text, note: format };
  }

  if (looksBinary(buffer)) {
    throw new Error(
      `${host} returned a file of type ${type || 'unknown'}, which is not text and not a document that can be read. ` +
        'Use download_file if the bytes themselves are wanted.',
    );
  }

  const body = buffer.toString('utf8');
  const html = /html|xml/i.test(type) || /^\s*<(!doctype|html)\b/i.test(body);
  return { text: html ? htmlToText(body) : body, note: '', html: html ? body : '' };
}

/** How many of a page's pictures are offered to the model. */
const PAGE_IMAGES = 8;
/** Addresses that are almost never the picture a person wants to see. */
const NOT_A_PHOTO = /(logo|icon|sprite|avatar|badge|pixel|spacer|blank|loader|loading|placeholder|banner-ad|tracking|1x1|emoji|flag)/i;

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
};
const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * The real pictures on a page — its share image first, then the large images
 * in the body — as absolute https addresses with their alt text.
 *
 * So the assistant can show a product photo from the shop page it read, the
 * way a search engine's answer does, instead of describing it. Icons, logos,
 * tracking pixels and anything declared small are left out.
 *
 * @returns {{ url: string, alt: string }[]}
 */
export function pageImages(html, base) {
  const found = [];
  const seen = new Set();
  const add = (raw, alt = '') => {
    const value = decodeEntities(String(raw || '').trim());
    if (!value || value.startsWith('data:')) return;
    let url;
    try {
      url = new URL(value, base);
    } catch {
      return;
    }
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || /\.svg(\?|$)/i.test(url.pathname) || NOT_A_PHOTO.test(url.pathname)) return;
    if (seen.has(url.href)) return;
    seen.add(url.href);
    found.push({ url: url.href, alt: decodeEntities(alt).replace(/[[\]()\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) });
  };

  const head = String(html || '');
  // The share image is captioned with the page's own title.
  // `[^<>]` rather than `[^>]`: a body of a million `<img` with no `>` scanned
  // to the end from each one (PERF-017). Stopping at the next `<` is linear.
  const title = head.match(/<title[^<>]*>([^<]{1,120})/i)?.[1] || '';
  for (const tag of head.match(/<meta\b[^<>]*>/gi) || []) {
    const key = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
    if (key === 'og:image' || key === 'og:image:secure_url' || key === 'twitter:image') add(attr(tag, 'content'), title);
  }
  for (const tag of head.match(/<img\b[^<>]*>/gi) || []) {
    if (found.length >= PAGE_IMAGES * 3) break;
    const width = Number(attr(tag, 'width'));
    const height = Number(attr(tag, 'height'));
    if ((width && width < 120) || (height && height < 120)) continue;
    // Lazy-loading pages keep the real address in a data attribute, and the
    // largest candidate of a srcset is the last one listed.
    const srcset = attr(tag, 'srcset') || attr(tag, 'data-srcset');
    const best = srcset ? srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop() : '';
    add(attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || best || attr(tag, 'src'), attr(tag, 'alt'));
  }
  return found.slice(0, PAGE_IMAGES);
}

/**
 * The pictures, said to the model as addresses it can put in its reply.
 * Signed by this server — see `signedImagePath` — so only these display.
 */
function picturesNote(images) {
  const lines = images
    .map((image) => {
      const path = signedImagePath(image.url);
      return path ? `- ![${image.alt || 'picture'}](${path})` : '';
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return (
    '\n\n[Pictures on this page. When they help — a product, a place, a person, a design — show them in your reply ' +
    'by copying a line as written, ![short caption](address); several on consecutive lines show as a row. ' +
    'Only these exact addresses display.\n' +
    `${lines.join('\n')}]`
  );
}

/** Page default, and the larger one a parsed document gets — see `webFetch`. */
const PAGE_CHARS = 20_000;
const DOC_CHARS = 60_000;

/**
 * Fetch a page or a document and read it to text — the half of `web_fetch` that
 * deep research needs too. Research used to call `web_fetch` itself and keep the
 * first 4,000 characters of what came back, which was the address line, the
 * opening of the untrusted envelope (its closing tag cut off), and the site's
 * navigation: the part of the article that answered the question was usually
 * past the cut. It now takes the whole text and picks the passages that match.
 */
async function fetchReadable(url, { timeoutMs = 30_000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }

  // `safeFetch` rather than `fetch`: the URL comes from a model, and a model
  // reads web pages that can tell it what to fetch next. Every hop is checked
  // against the private address ranges — cloud metadata and the local network
  // are not things this tool is for.
  const res = await safeFetch(parsed, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AI-Remote/1.0)',
      Accept: 'text/html,application/pdf,*/*',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${parsed.host} returned HTTP ${res.status} ${res.statusText}`);

  const type = (res.headers.get('content-type') || '').toLowerCase();
  const format = documentFormat(type, parsed.pathname.toLowerCase());
  const cap = format ? MAX_DOC_BYTES : MAX_BODY_BYTES;

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    // Nothing will read this body; leaving it unread holds the socket open.
    res.body?.destroy?.();
    throw new Error(`${parsed.host} returned ${declared} bytes, which is too large to read.`);
  }

  const { buffer, truncated } = await readCapped(res, cap);
  if (truncated && format) {
    throw new Error(
      `${parsed.host} sent more than ${Math.round(cap / 1024 / 1024)}MB without saying how much was coming, ` +
        'and half a document cannot be opened.',
    );
  }

  const { text, note, html } = await readBody(buffer, { format, type, host: parsed.host });
  return { parsed, text, note, html, truncated, cap };
}

/** The readable text of a page, plain — no envelope, no notes. See `fetchReadable`. */
export async function readPageText(url, { timeoutMs = 15_000 } = {}) {
  return (await fetchReadable(url, { timeoutMs })).text;
}

async function webFetch({ url, max_chars: maxChars }) {
  const { parsed, text, note, html, truncated, cap } = await fetchReadable(url);

  // A document gets a larger default than a page. 20,000 characters is a
  // generous slice of an article and a third of an exam paper, and a model that
  // silently answers from a third of a document is the failure this tool exists
  // to prevent. An explicit `max_chars` still wins, either way.
  const limit = Math.min(Math.max(Number(maxChars) || (note ? DOC_CHARS : PAGE_CHARS), 500), 200_000);
  const clipped = text.slice(0, limit);

  // Both notes go after the clip, never inside the text. Appended to the body
  // they were simply sliced off again — an 8MB page cut at 20,000 characters
  // lost the sentence explaining that it had been cut, which is the one part of
  // it that mattered.
  const notes = [];
  if (text.length > limit) {
    notes.push(`truncated — ${text.length - limit} more characters. Call web_fetch again with a larger max_chars to read the rest.`);
  }
  if (truncated) notes.push(`${parsed.host} kept sending past ${Math.round(cap / 1024 / 1024)}MB, so the rest was never read.`);

  return (
    `# ${parsed.href}${note ? ` (${note})` : ''}\n\n` +
    // Wrapped, because this is the single most likely place for an instruction
    // aimed at the model to enter the conversation. See server/tools/untrusted.js.
    untrusted(parsed.href, clipped) +
    notes.map((line) => `\n\n[${line}]`).join('') +
    // Outside the envelope: the addresses are this server's own signed paths.
    (html ? picturesNote(pageImages(html, parsed.href)) : '')
  );
}

/**
 * A question with buttons on it, answered by the person.
 *
 * The shape here is unusual and worth saying out loud: this implementation
 * never runs on the way *out*. The loop sees `ask_options` in a batch, pauses
 * the turn and asks the browser to draw the card — so by the time anything
 * calls this, somebody has pressed something and the answer is in hand.
 *
 * It still validates the questions a second time, and that is deliberate: it is
 * what turns a malformed call into an ordinary tool error the model can read
 * and correct, rather than a pause waiting for an answer to a question that
 * could not be drawn.
 */
async function askOptionsTool(input, { answers }) {
  const questions = normaliseQuestions(input);
  if (!answers) {
    throw new Error(
      'ask_options ran without the user having answered, which should not happen. ' +
        'Do not retry it; ask in prose instead.',
    );
  }
  // The person's own reading of what they chose, drawn on their side of the
  // conversation; the model reads `answerText`.
  return { content: answerText(questions, answers), answered: answerSummary(questions, answers) };
}

/* ── A video, as words ───────────────────────────────────────────
 *
 * `web_fetch` on a YouTube link returns the chrome of the page and none of the
 * speech: the words are in a caption track the player loads separately, so the
 * honest answer used to be "I cannot watch videos — paste the transcript
 * yourself", which is a chore handed back to the person who asked.
 *
 * This reads the track. It is the page's own data, not a private API, but it is
 * also not a documented one — YouTube can change the shape of it, and when that
 * happens this must fail with a sentence rather than silently return nothing.
 * ─────────────────────────────────────────────────────────────── */

/**
 * The video id, out of whatever shape the address arrived in.
 *
 * A watch URL, a share link, a Shorts link, an embed, or the bare id — people
 * paste all five, and a tool that only understands the first fails on the input
 * somebody actually has in their clipboard.
 */
export function youtubeId(input) {
  const raw = String(input || '').trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') return null;

  const v = url.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const path = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return path ? path[1] : null;
}
/** `184500` ms → `3:04`. Hours only when there are hours. */
function stamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** How often a `[mm:ss]` marker is dropped into the running text, in ms. */
const STAMP_EVERY_MS = 45_000;

/**
 * Caption segments, as readable prose with positions in it.
 *
 * Its own function because it is the part that decides whether a transcript is
 * usable, and the only part that can be checked without a key: a transcript
 * with no positions cannot be cited — "he says it around 3:04" is most of what
 * makes a video quotable — while one with a position on every segment is twice
 * the size and reads like a subtitle file rather than like speech.
 *
 * Segments arrive in milliseconds on `offset`, which is Supadata's shape.
 */
export function transcriptFromSegments(content) {
  const parts = [];
  let nextStamp = 0;
  for (const seg of Array.isArray(content) ? content : []) {
    const said = String(seg?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!said) continue;
    const at = Number(seg?.offset) || 0;
    if (at >= nextStamp) {
      parts.push(`\n[${stamp(at)}] `);
      nextStamp = at + STAMP_EVERY_MS;
    }
    parts.push(`${said} `);
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim();
}

async function youtubeTranscript({ url, lang, max_chars: maxChars }, { userId }) {
  const id = youtubeId(url);
  if (!id) {
    throw new Error(
      `"${url}" is not a YouTube video. Pass a watch, share, Shorts or embed link, or the 11-character video id.`,
    );
  }

  const watch = `https://www.youtube.com/watch?v=${id}`;
  const body = await CONNECTOR_CALLS.supadataTranscript(userId, watch, lang);

  /**
   * A job id instead of words.
   *
   * Supadata answers a long video asynchronously, and the async result is a
   * different shape with a different endpoint behind it. Rather than poll — an
   * agent step that sleeps is an agent step nobody can interrupt — this says
   * what happened and stops, which the model can pass on as a fact.
   */
  if (body?.jobId && !body?.content) {
    throw new Error(
      `Supadata queued video ${id} as a background job rather than answering, which this tool cannot wait for. ` +
        'Try a shorter video.',
    );
  }

  const text = transcriptFromSegments(body?.content);
  if (!text) {
    throw new Error(
      `Supadata returned no captions for video ${id}. The video probably has none — say so rather than retrying.`,
    );
  }

  const limit = Math.min(Math.max(Number(maxChars) || 30_000, 500), 200_000);
  const clipped = text.slice(0, limit);

  const spoken = body?.lang ? `captions: ${body.lang}` : 'captions';
  const notes = [];
  if (text.length > limit) {
    notes.push(
      `truncated — ${text.length - limit} more characters. Call youtube_transcript again with a larger max_chars to read the rest.`,
    );
  }
  if (lang && body?.lang && !String(body.lang).toLowerCase().startsWith(String(lang).toLowerCase().split('-')[0])) {
    notes.push(`no "${lang}" track on this video; this is ${body.lang}.`);
  }

  return (
    `# ${watch}\n${spoken}\n\n` +
    // Wrapped for the same reason a fetched page is: these are somebody else's
    // words arriving in the middle of a conversation, and a video can be
    // scripted to be read by a model rather than by a person.
    untrusted(watch, clipped) +
    notes.map((line) => `\n\n[${line}]`).join('')
  );
}

/**
 * Search, through the chain in `server/search.js`.
 *
 * One engine used to be the whole story, chosen by which key happened to be
 * set — so an expired key or a bad afternoon at one provider took the tool out
 * entirely, and the model had no way to tell that from "there is nothing about
 * this on the web". Now every engine is tried in turn and the answer says which
 * one spoke.
 */
/**
 * @param {{ query: string, count?: number }} input
 * @param {{ userId?: string }} [context]  the tool context; only `userId` is used
 */
/**
 * How far one search goes: how many results, and how many of the top pages
 * are opened and read into the answer.
 *
 * Set by the reasoning level the person chose, because that dial already
 * means "how much care is this worth": on Low a search is a list of links and
 * the model decides what to open; from High up the best few pages come back
 * read, so a thorough answer is not three more steps away. `depth` on the call
 * overrides it either way — a quick check inside a careful job, or a careful
 * look on a fast setting.
 */
const SEARCH_DEPTH = {
  low: { count: 5, read: 0 },
  medium: { count: 8, read: 0 },
  high: { count: 8, read: 2 },
  xhigh: { count: 10, read: 3 },
  max: { count: 12, read: 4 },
};
const EXCERPT_CHARS = 2500;

export function searchDepth(effort, depth) {
  const level = SEARCH_DEPTH[effort] || SEARCH_DEPTH.high;
  if (depth === 'quick') return { count: level.count, read: 0 };
  if (depth === 'thorough') return { count: Math.max(level.count, 10), read: Math.max(level.read, 3) };
  return level;
}

async function webSearch({ query, count, depth }, context = {}) {
  const { userId } = context;
  const prefs = userId ? await getPrefs(userId).catch(() => null) : null;
  const plan = searchDepth(prefs?.effort, depth);
  // `userId` only so the search can be attributed in the log. The keys these
  // engines use are deployment-wide, so nothing else about the call depends on
  // which account made it.
  const found = await search(query, { count: Number(count) || plan.count, userId });
  const listing = formatResults(query, found);
  if (!plan.read || !found.results?.length) return listing;

  // The top pages, read side by side and cut short: enough to answer from,
  // not a whole article each. A page that will not open is skipped, not fatal.
  const top = found.results.slice(0, plan.read);
  const pages = await Promise.all(
    top.map((r) => webFetch({ url: r.url, max_chars: EXCERPT_CHARS }).catch(() => null)),
  );
  const read = pages
    .map((text, i) => (text ? `── Page ${i + 1}: ${top[i].url}\n${text}` : null))
    .filter(Boolean);
  if (!read.length) return listing;
  return (
    `${listing}\n\nThorough search: the top ${read.length} page${read.length === 1 ? ' was' : 's were'} opened and ` +
    `read (first ${EXCERPT_CHARS} characters each). Use web_fetch on one for the rest of it.\n\n${read.join('\n\n')}`
  );
}

/* ── documents the assistant makes ──────────────────────────────────── */

const humanSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/**
 * Write a document and put it in the conversation.
 *
 * The interesting return value is not the sentence — it is the `file`, which
 * travels out through the tool result and becomes a card the user can open and
 * download. The sentence exists so the model knows the id it will need to change
 * the thing later, and knows it does not have to repeat the document into its
 * reply.
 */
/**
 * A name for a file the model forgot to name.
 *
 * Refusing the call cost a whole step — and on a long page, the whole page:
 * the model has to write every byte of `content` again to retry, which is how a
 * 130-question quiz turned into a refusal, a truncated rewrite and a turn that
 * no longer fit the window. The page nearly always names itself.
 */
export function nameForFile({ name, filename, file_name: fileName, title, content }) {
  const given = [name, filename, fileName, title].find((v) => typeof v === 'string' && v.trim());
  if (given) return given.trim();
  const text = String(content || '');
  const heading =
    text.match(/<title[^<>]*>([^<]{1,120})<\/title>/i)?.[1] ||
    text.match(/<h1[^<>]*>([^<]{1,120})<\/h1>/i)?.[1] ||
    text.match(/^#{1,3}\s+(.{1,120})$/m)?.[1];
  return heading ? heading.trim() : 'Document';
}

async function createFileTool({ name, format, content, title, filename, file_name }, { userId, chatId }) {
  const built = createDocument({
    format,
    name: nameForFile({ name, filename, file_name, title, content }),
    content,
    title,
  });
  const saved = await saveGenerated(userId, {
    name: built.name,
    mime: built.mime,
    data: built.buffer.toString('base64'),
    source: built.source,
    chatId,
  });

  return {
    content:
      `Created ${saved.name} (${humanSize(saved.bytes)}). It is in the conversation now — the user can open it ` +
      'in the viewer and download it, so do not paste its contents into your reply. ' +
      `Its id is ${saved.id}; pass that to update_file to change this same file rather than making a second one.`,
    file: { id: saved.id, name: saved.name, mime: saved.mime, kind: saved.kind, bytes: saved.bytes, format: built.format },
  };
}

/**
 * Targeted changes to a file's source: each `find` must appear exactly once,
 * and is replaced by its `replace`. All or nothing — a single edit that does
 * not match leaves the file as it was, and the error says which one.
 */
export function applyEdits(source, edits) {
  let text = String(source);
  edits.forEach((edit, i) => {
    const find = String(edit?.find ?? '');
    if (!find) throw new Error(`Edit ${i + 1} has nothing to find.`);
    const first = text.indexOf(find);
    if (first < 0) {
      throw new Error(
        `Edit ${i + 1} did not match: its find text is not in the file. Read the source with read_generated_file and copy the text exactly.`,
      );
    }
    if (text.indexOf(find, first + 1) >= 0) {
      throw new Error(`Edit ${i + 1} matches more than once. Include more of the surrounding text so it is unique.`);
    }
    text = text.slice(0, first) + String(edit?.replace ?? '') + text.slice(first + find.length);
  });
  return text;
}

async function updateFileTool({ file_id: fileId, content, name, append = false, edits }, { userId }) {
  const store = getStore();
  const existing = await store.getAttachment(userId, fileId);
  if (!existing) throw new Error(`There is no file with the id ${fileId} on this account.`);
  if (existing.origin !== 'generated') {
    throw new Error(`${existing.name} was uploaded by the user, not written by you, so it cannot be rewritten.`);
  }
  /**
   * Changing part of a file without sending the rest of it.
   *
   * A fix to the header of a 40 KB quiz used to mean writing all 40 KB again,
   * and a free model's reply is routinely cut off long before that — leaving
   * arguments that were not JSON and nothing changed. With `edits` only the
   * lines that change travel.
   */
  if (Array.isArray(edits) && edits.length) {
    if (typeof existing.source !== 'string') {
      throw new Error(`${existing.name} has no stored source to edit. Pass the complete content instead.`);
    }
    content = applyEdits(existing.source, edits);
    append = false;
  } else if (typeof content !== 'string') {
    throw new Error('Pass content (the whole new file, or the next part with append) or edits (the parts that change).');
  }
  /**
   * Added to the end rather than replacing.
   *
   * A long page in one call is a single string tens of kilobytes long, and a
   * free model's reply is often cut off before it is finished — leaving
   * arguments that are not JSON and nothing written at all. In parts, each
   * call is small enough to arrive whole, and a cut-off part costs one part.
   */
  if (append && typeof existing.source !== 'string') {
    throw new Error(`${existing.name} has no stored source to add to. Pass the complete content instead.`);
  }
  const whole = append ? `${existing.source}${content}` : content;

  // The format belongs to the file, not to this call: renaming is allowed,
  // and "update it" must never quietly turn a .docx into a .md.
  const format = extensionOf(existing.name);
  const built = createDocument({ format, name: name || existing.name, content: whole });

  const saved = await store.replaceAttachment(userId, fileId, {
    data: built.buffer.toString('base64'),
    bytes: built.buffer.length,
    source: built.source,
    name: built.name,
    mime: built.mime,
  });
  if (!saved) throw new Error('That file could not be updated.');

  return {
    content: Array.isArray(edits) && edits.length
      ? `Made ${edits.length} change${edits.length === 1 ? '' : 's'} to ${saved.name} (${humanSize(saved.bytes)}). Same file, same id — the viewer shows the new version.`
      : append
      ? `Added to ${saved.name}; it is now ${humanSize(saved.bytes)}. Same file, same id — keep appending until it is complete.`
      : `Rewrote ${saved.name} (${humanSize(saved.bytes)}). Same file, same id — the viewer shows the new version.`,
    file: {
      id: saved.id,
      name: saved.name,
      mime: saved.mime,
      kind: saved.kind,
      bytes: saved.bytes,
      format,
      // Bumped so the browser fetches the new bytes rather than the cached ones.
      version: Date.now(),
    },
  };
}

async function readGeneratedFileTool({ file_id: fileId }, { userId, chatId }) {
  const store = getStore();

  if (!fileId) {
    const files = await store.listGeneratedFiles(userId, chatId);
    if (!files.length) return 'No documents have been made in this conversation yet.';
    return files.map((file) => `- ${file.name} (${humanSize(file.bytes)}) — id ${file.id}`).join('\n');
  }

  const file = await store.getAttachment(userId, fileId);
  if (!file) throw new Error(`There is no file with the id ${fileId} on this account.`);
  if (file.origin !== 'generated') throw new Error(`${file.name} was uploaded, so it has no source to read back.`);
  if (!file.source) return `${file.name} has no stored source.`;
  return `--- source of ${file.name} ---\n${file.source}`;
}

/**
 * The drafts of a file, and going back to one.
 *
 * `update_file` keeps the file's id and files the outgoing copy as a version,
 * which the panel has shown since it started doing so. The assistant could not
 * see any of it — so "put the figure back to what it was before" meant
 * reconstructing the document from the conversation and hoping, when the exact
 * bytes were sitting in the database the whole time.
 */
async function fileVersionsTool({ file_id: fileId, revision, restore }, { userId }) {
  const store = getStore();

  const file = await store.getAttachment(userId, fileId);
  if (!file) throw new Error(`There is no file with the id ${fileId} on this account.`);
  if (file.origin !== 'generated') {
    throw new Error(`${file.name} was uploaded, so it has no version history — only files you made do.`);
  }

  const past = await store.listAttachmentVersions(userId, fileId);
  // Numbered like the switcher: one past the newest draft, not by count — the
  // oldest drafts are pruned, so the count stops matching the numbers.
  const live = liveRevision(past);

  if (revision == null) {
    if (!past.length) return `${file.name} has only ever had one version — nothing has been rewritten yet.`;
    return [
      `${file.name} is at v${live}; ${past.length} earlier draft${past.length === 1 ? ' is' : 's are'} kept:`,
      `- v${live} — the current one, ${humanSize(file.bytes)}`,
      ...past.map((v) => `- v${v.revision} — ${humanSize(v.bytes)}, saved ${new Date(v.created_at).toISOString()}`),
      '',
      'Pass revision to read one, and restore: true to put it back.',
    ].join('\n');
  }

  const wanted = Number(revision);
  if (wanted === live) return `v${live} is the current version. read_generated_file gives you its source.`;

  const copy = await store.getAttachmentVersion(userId, fileId, wanted);
  if (!copy) throw new Error(`${file.name} has no v${revision}. It is at v${live}; call without revision to list the drafts kept.`);

  if (!restore) {
    return copy.source
      ? `--- ${file.name} as it was at v${wanted} ---\n${copy.source}`
      : `v${wanted} of ${file.name} is ${humanSize(copy.bytes)} but has no stored source to show.`;
  }

  // Restoring is itself a rewrite, so what it replaces is kept in turn — going
  // backwards is never destructive, which is what makes it safe to offer.
  await store.replaceAttachment(userId, fileId, {
    data: copy.data,
    bytes: copy.bytes,
    source: copy.source,
    name: copy.name,
    mime: copy.mime,
  });
  return `${file.name} is back to what it was at v${wanted}. The copy that was current is kept as v${live}.`;
}

// Notes are per-account: one user's memory must never leak into another's
// context on the next conversation. `noteName` (server/memory.js) is checked by
// every memory tool, so a fifth cannot forget it.

/** A note is read into every conversation, so one may not grow without limit. */
function boundedNote(text) {
  if (text.length <= MAX_NOTE_CHARS) return text;
  throw new Error(
    `That note would be ${text.length.toLocaleString('en')} characters; the limit is ${MAX_NOTE_CHARS.toLocaleString('en')}, ` +
      'because every note is read into every conversation. Keep the facts that will matter later and drop the rest, or split it by subject.',
  );
}

async function memoryWrite({ key, content, scope }, { userId, chatId }) {
  const store = getStore();
  const allowed = await memoryAllowed(userId, chatId);
  const where = await memoryScope({ userId, chatId, scope });

  // A note outlives the conversation it came from and is read back into every
  // future one, so a credential that lands here keeps escaping. Strip them on
  // the way in, and say so rather than silently editing what was asked for.
  const { text, found } = redactSecrets(content);
  guardNote(text, allowed);
  boundedNote(text);

  /*
   * Merged, not read-modify-written — the fix its three neighbours already have.
   *
   * This read the whole memory object, changed one key, and wrote the whole
   * object back. The agent runs up to four tool calls at once, so a
   * `memory_write` on one key beside a `memory_append` on another both read the
   * same object and whichever landed second erased the other — while both
   * reported success, so the model told the user both notes were saved, and the
   * loss surfaced days later with nothing pointing at it (MEDIUM, CODE-023).
   * `memoryAppend` documents exactly this and moved to `mergeUserSetting`;
   * `memoryWrite` was left behind.
   *
   * The key is checked for the same reason it matters in any object used as a
   * map: `__proto__` assigned as a key sets the prototype instead of adding a
   * note, which then vanishes on serialisation while the tool reports it saved.
   */
  const name = noteName(key);
  // What it replaces, kept one step back so a bad write can be undone (HAR-002).
  const before = ((await store.getUserSetting(userId, where.key).catch(() => null)) || {})[name] || null;
  await store.mergeUserSetting(userId, where.key, {
    [name]: stampNote(text, { by: 'assistant', chatId, before }),
  });

  if (!found.length) return `Saved note "${name}" for ${where.where}.`;
  return (
    `Saved note "${name}" for ${where.where}, with ${found.join(' and ')} removed first — notes ` +
    'are long-lived and credentials do not belong in them. Tell the user plainly that this was left out.'
  );
}

/**
 * Read one note, or list what there is.
 *
 * Inside a project the listing is both sets, the project's first and labelled,
 * so the model can see which conventions are local to this work and which are
 * the person's everywhere. A single merged list would hide exactly the
 * distinction the split exists to make.
 */
async function memoryRead({ key }, { userId, chatId }) {
  await memoryAllowed(userId, chatId);
  const { here, account, project, merged } = await readBothScopes({ userId, chatId });

  if (key) {
    const note = Object.hasOwn(merged, key) ? merged[key] : null;
    return typeof note?.content === 'string' ? note.content : `No note saved under "${key}".`;
  }

  const line = (notes, k) => `- ${k}: ${notes[k].content.slice(0, 120)}`;
  if (!here.projectId) {
    const all = Object.keys(account).map((k) => line(account, k));
    return all.length ? all.join('\n') : 'No notes saved yet.';
  }

  const mine = Object.keys(project).map((k) => line(project, k));
  // Only the account notes a project note has not overridden, or the same name
  // appears twice with two bodies and nothing says which one applies.
  const rest = Object.keys(account)
    .filter((k) => !(k in project))
    .map((k) => line(account, k));

  if (!mine.length && !rest.length) return 'No notes saved yet.';
  return [
    mine.length ? `Notes for ${here.where} — these win where they disagree:` : null,
    ...mine,
    rest.length ? `${mine.length ? '\n' : ''}Notes for this account, which apply everywhere:` : null,
    ...rest,
  ]
    .filter((entry) => entry !== null)
    .join('\n');
}

/**
 * Draw something in the transcript.
 *
 * The gap this fills: everything visual the assistant could make was a *file* —
 * something you open in the side panel, keep and download. Perfect for a report,
 * wrong for "here is the shape of what I found", which wants to be four
 * centimetres of picture inside the sentence it belongs to.
 *
 * The markup travels out on the tool result and is therefore stored with the
 * conversation, so reopening it a week later redraws the same picture rather than
 * needing a second source of truth. That is also why there is a size limit: this
 * is read back on every load of the conversation, and a megabyte of inline SVG
 * would be paid for every time.
 *
 * Sandboxed when it is drawn — see `widgetFrame` in render.js. This is markup a
 * model wrote, which is not the same as markup this repository wrote.
 */
const MAX_WIDGET_BYTES = 96 * 1024;

async function showWidgetTool({ title, svg, html }) {
  const caption = String(title || '').trim();
  if (!caption) throw new Error('Give the picture a short title, so it is labelled.');

  const markup = String(svg || html || '').trim();
  if (!markup) throw new Error('Give either `svg` or `html` to draw.');
  if (svg && html) {
    throw new Error('Give `svg` or `html`, not both — they are two different pictures.');
  }
  if (markup.length > MAX_WIDGET_BYTES) {
    throw new Error(
      `That is ${Math.round(markup.length / 1024)}KB of markup, over the ${MAX_WIDGET_BYTES / 1024}KB limit. ` +
        'A widget is re-read every time the conversation is opened. For something this large use `create_file` ' +
        'with format "html", which is a document rather than an inline picture.',
    );
  }
  if (svg && !/^<svg[\s>]/i.test(markup)) {
    throw new Error('`svg` has to start with an <svg> element. Use `html` for anything else.');
  }

  /**
   * Refuse what will not work rather than drawing a blank rectangle.
   *
   * The frame has no network and no parent access, so an external stylesheet or a
   * script tag is not a security problem here — it is simply a thing that will
   * silently do nothing, and a picture that renders empty is the hardest kind of
   * failure to diagnose from the other side.
   */
  if (/<script[\s>]/i.test(markup)) {
    throw new Error('A widget cannot run scripts. Draw the finished picture, or use `create_file` for something interactive.');
  }
  const external = markup.match(/(?:src|href)\s*=\s*["']?(https?:)?\/\//i);
  if (external) {
    throw new Error(
      'A widget cannot fetch anything — no images, fonts or stylesheets from the internet. ' +
        'Inline it, or draw it with shapes and text.',
    );
  }

  return {
    content:
      `Drew "${caption}" in the conversation. The user can see it, so describe what it shows rather than ` +
      'listing the numbers again.',
    widget: { title: caption, markup, kind: svg ? 'svg' : 'html' },
  };
}

/**
 * Add to a note without rewriting it.
 *
 * `memory_write` replaces, which makes a running list expensive and risky to keep:
 * the whole note has to be read back, re-sent and re-saved, and anything the model
 * has forgotten since is quietly lost. Appending is the operation a log actually
 * wants — decisions as they are made, facts as they turn up.
 */
/**
 * A chart from numbers, drawn in code.
 *
 * Goes out through the same widget channel as `show_widget`, so it inherits the
 * sandboxed frame and the sizing — the difference is who drew it. The model is
 * told what it shows rather than what it contains, so the reply describes the
 * picture instead of reciting the numbers a reader can already see.
 */
/**
 * Arithmetic, done rather than recalled.
 *
 * The answer comes back with the expression beside it so the working is on the
 * record: a number in a report should be checkable, and "the model said so" is
 * not a check.
 */
/**
 * Read a page for what was asked, on the account's own model.
 *
 * The page is fetched through the same `web_fetch` path, so it goes through
 * `safeFetch` and cannot be aimed at a private address any more than that one
 * can. What changes is where the text goes: into a call of its own rather than
 * into the conversation.
 */
async function extractTool({ url, what, fields }, { userId, chatId, signal }) {
  const prefs = await getPrefs(userId);
  const entry = await resolveForUser(userId, prefs.defaultModel);
  return extractFromPage({
    url,
    what,
    fields,
    userId,
    entry,
    signal,
    // So the spend lands against the conversation that caused it, the same way
    // an ordinary turn does — this call used to be booked nowhere at all.
    chatId,
    fetchPage: (target) => webFetch({ url: target, max_chars: 60000 }),
  });
}

/**
 * Hand the model tools it did not start the turn with.
 *
 * The work is done by the loop, not here: `runToolCalls` sees this call go
 * through and adds the names to the set that `availableTools` is rebuilt from,
 * so the schemas travel in the *next* request. No provider allows adding tools
 * to a request already in flight, and none needs to.
 *
 * What this returns is therefore only the acknowledgement — but it has to be an
 * honest one. A name that is not deferrable, or not a tool at all, is reported
 * rather than silently accepted, because the alternative is a model that
 * believes it now has something it will never be given and plans around it.
 */
async function loadToolsTool({ names }, { deliverable = null } = {}) {
  const asked = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!asked.length) throw new Error('Give the `names` of the tools to load.');

  /**
   * A name has to be *deliverable*, not merely real.
   *
   * This checked `TOOLS_BY_NAME` alone, so a genuine tool that `availableTools`
   * withholds for this account — a connector that is not linked, a local tool
   * with no worker online, a desktop tool on a machine that has not opted in —
   * was answered "Loaded send_email, you will have it from your next step
   * onward" and then never appeared. The model planned around a capability it
   * was never going to receive, which is exactly what the note on the deferred
   * list says must not happen.
   *
   * `deliverable` is the set the loop is willing to activate, passed in by the
   * caller because only the loop knows this account's worker, connectors and
   * keys. Absent, the old behaviour stands — a caller that cannot say must not
   * have its answers silently narrowed.
   */
  const real = asked.filter((n) => TOOLS_BY_NAME[n]);
  const unknown = asked.filter((n) => !TOOLS_BY_NAME[n]);
  const known = deliverable ? real.filter((n) => deliverable.has(n)) : real;
  const withheld = real.filter((n) => !known.includes(n));

  const notes = [
    unknown.length ? `Not tools, and ignored: ${unknown.join(', ')}.` : '',
    withheld.length
      ? `Not available on this account and not loaded: ${withheld.join(', ')} — the service is not connected, or the computer that runs them is not online. Do not plan around them; say so if the user asks.`
      : '',
  ].filter(Boolean);

  if (!known.length) {
    return (
      `Nothing was loaded. ${notes.join(' ')} ` +
      'Use the names exactly as they appear in the list on this tool, or carry on with what you have.'
    ).trim();
  }

  return (
    `Loaded ${known.join(', ')} — you will have ${known.length === 1 ? 'it' : 'them'} from your next step onward, ` +
    'so make that call then rather than now.' +
    (notes.length ? ` (${notes.join(' ')})` : '')
  );
}

/* ── facts about the world right now ─────────────────────────────── */

/**
 * What a WMO weather code means, in words — Open-Meteo reports the code only.
 * English, because the model says it back in whatever language it is using.
 */
const WEATHER_WORDS = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};
const weatherWord = (code) => WEATHER_WORDS[code] || `weather code ${code}`;

/** The clock in a zone, said the way a person reads it, with the zone named. */
export function describeTime(now, zone) {
  const tz = validZone(zone) ? zone : 'UTC';
  const said = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return `It is ${said} in ${tz} (ISO ${now.toISOString()}).`;
}

/** Current conditions and the next days, from Open-Meteo's forecast payload. */
export function describeWeather(place, data) {
  const c = data?.current || {};
  const u = data?.current_units || {};
  const lines = [
    `Weather in ${place} now (${c.time || 'current'} local): ${weatherWord(c.weather_code)}, ` +
      `${c.temperature_2m}${u.temperature_2m || '°C'} (feels like ${c.apparent_temperature}${u.apparent_temperature || '°C'}), ` +
      `humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} ${u.wind_speed_10m || 'km/h'}, ` +
      `precipitation ${c.precipitation ?? 0} ${u.precipitation || 'mm'}.`,
  ];
  const d = data?.daily;
  if (d?.time?.length) {
    lines.push('Next days:');
    d.time.forEach((day, i) => {
      lines.push(
        `- ${day}: ${weatherWord(d.weather_code?.[i])}, ${d.temperature_2m_min?.[i]}–${d.temperature_2m_max?.[i]}°C, ` +
          `chance of rain ${d.precipitation_probability_max?.[i] ?? '?'}%`,
      );
    });
  }
  lines.push('Source: Open-Meteo (open-meteo.com).');
  return lines.join('\n');
}

/** A conversion from open.er-api.com's table of rates against one base. */
export function describeRate(data, base, quote, amount) {
  const rate = data?.rates?.[quote];
  if (data?.result !== 'success' || !rate) throw new Error(`No rate from ${base} to ${quote}. Use ISO codes like USD, VND, EUR.`);
  const value = amount * rate;
  const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 4 });
  return (
    `${fmt(amount)} ${base} = ${fmt(value)} ${quote} (1 ${base} = ${fmt(rate)} ${quote}), ` +
    `rates updated ${data.time_last_update_utc || 'recently'}. ` +
    'Source: open.er-api.com — a mid-market reference, not what a bank or exchange will quote.'
  );
}

/** JSON from one of the fixed public services above, with a timeout. */
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}.`);
  return res.json();
}

/**
 * Today's date and time, the weather, an exchange rate — looked up, not guessed.
 *
 * A model's sense of "now" is its training cut-off, and the date line in the
 * system prompt is cached for the day and has no clock in it. These three are
 * the questions people ask expecting an exact answer, and each is one call to
 * a free service with no key, so there is nothing to configure.
 *
 * @param {{ kind?: string, location?: string, timezone?: string, base?: string, quote?: string, amount?: number }} input
 * @param {{ userId?: string }} [context]
 */
async function worldFactsTool({ kind, location, timezone, base, quote, amount }, { userId } = {}) {
  if (kind === 'time') {
    const zone = validZone(timezone) ? timezone : (await getPrefs(userId).catch(() => null))?.timezone;
    return describeTime(new Date(), zone);
  }

  if (kind === 'weather') {
    const name = String(location || '').trim();
    if (!name) throw new Error('Say which place — a city name, e.g. "Hanoi" or "Ho Chi Minh City".');
    const geo = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(name)}`,
    );
    const hit = geo?.results?.[0];
    if (!hit) throw new Error(`No place called "${name}" was found. Try the city's English name, e.g. "Ho Chi Minh City".`);
    const forecast = await getJson(
      'https://api.open-meteo.com/v1/forecast?timezone=auto&forecast_days=3' +
        `&latitude=${hit.latitude}&longitude=${hit.longitude}` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    );
    return describeWeather([hit.name, hit.admin1, hit.country].filter(Boolean).join(', '), forecast);
  }

  if (kind === 'exchange_rate') {
    const from = String(base || 'USD').trim().toUpperCase();
    const to = String(quote || 'VND').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw new Error('Currencies are ISO codes: USD, VND, EUR, JPY…');
    const data = await getJson(`https://open.er-api.com/v6/latest/${from}`);
    return describeRate(data, from, to, Number(amount) > 0 ? Number(amount) : 1);
  }

  throw new Error('kind is one of: time, weather, exchange_rate.');
}

async function calculateTool({ expression }) {
  const { value, expression: shown } = evaluate(expression);
  return `${shown} = ${value}`;
}

async function chartTool({ title, type, data, format, x_label: xLabel, y_label: yLabel }) {
  const caption = String(title || '').trim();
  if (!caption) throw new Error('Give the chart a short title, so it is labelled.');
  const axes = { xLabel: String(xLabel || '').trim(), yLabel: String(yLabel || '').trim() };
  const markup = renderChart({ type, title: caption, data, format, ...axes });
  const spec =
    type === 'scatter'
      ? scatterSpec({ data, format, ...axes })
      : { type, format: format || 'number', labels: data.labels, series: data.series };
  return {
    content:
      `Drew the ${type} chart "${caption}" in the conversation. The user can see it, so say what it shows — the ` +
      'comparison, the trend, the outlier — rather than listing the numbers again.',
    // `spec` is what makes it interactive: the browser reads each point's
    // values from it on hover. `markup` stays the picture itself, so anything
    // that only knows how to show an SVG still shows the chart.
    widget: {
      title: caption,
      markup,
      kind: 'chart',
      spec,
    },
  };
}

async function memoryAppend({ key: rawKey, content, scope }, { userId, chatId }) {
  const key = noteName(rawKey);
  const store = getStore();
  const allowed = await memoryAllowed(userId, chatId);
  const where = await memoryScope({ userId, chatId, scope });
  const { text, found } = redactSecrets(content);
  if (!String(text || '').trim()) throw new Error('There is nothing to append.');
  guardNote(text, allowed);

  const memory = (await store.getUserSetting(userId, where.key)) || {};
  const existing = memory[key]?.content || '';
  // A blank line between entries, so an appended list stays readable rather than
  // running together into one paragraph.
  memory[key] = stampNote(boundedNote(existing ? `${existing.replace(/\s+$/, '')}\n\n${text}` : text), {
    by: 'assistant',
    chatId,
    before: memory[key] || null,
  });
  // Merged, not overwritten: the agent runs up to four tool calls at once, so
  // two memory writes in one step both read the same object and a whole-value
  // write meant the second silently erased the first — while both reported
  // success, so the model told the user two notes were saved when one was gone.
  await store.mergeUserSetting(userId, where.key, { [key]: memory[key] });

  const created = existing ? '' : ` (the note did not exist in ${where.where}, so it was created)`;
  if (!found.length) return `Appended to "${key}"${created}.`;
  return (
    `Appended to "${key}"${created}, with ${found.join(' and ')} removed first. ` +
    'Tell the user plainly that this was left out.'
  );
}

/**
 * Change one part of a note.
 *
 * The same reasoning as `edit_file` against `write_file`: correcting a phone number
 * in a page of project notes should not mean re-sending the page, and re-sending it
 * from memory is how the other nine facts get subtly rewritten.
 */
async function memoryEdit({ key: rawKey, old_string: oldString, new_string: newString }, { userId, chatId }) {
  const key = noteName(rawKey);
  const store = getStore();
  const allowed = await memoryAllowed(userId, chatId);
  /*
   * Edited where it lives, which is not always where a write would land.
   *
   * A project conversation writes into the project's notes, but it can perfectly
   * well be correcting an account-wide one it just read back — `memory_read`
   * hands it both. Looking only in the project's would report "no such note" for
   * a note the model is quoting, so the search widens and the write follows the
   * note rather than the caller.
   */
  const { here, account, project } = await readBothScopes({ userId, chatId });
  const inProject = here.projectId && Object.hasOwn(project, key);
  const target = inProject ? here.key : MEMORY_KEY;
  const memory = inProject ? project : account;
  const note = Object.hasOwn(memory, key) && typeof memory[key]?.content === 'string' ? memory[key] : null;
  if (!note) {
    const keys = [...new Set([...Object.keys(project), ...Object.keys(account)])];
    throw new Error(
      keys.length ? `No note saved under "${key}". There is: ${keys.join(', ')}.` : `No notes are saved on this account.`,
    );
  }

  const find = String(oldString ?? '');
  if (!find) throw new Error('Give the text to replace.');
  const occurrences = note.content.split(find).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `That text is not in "${key}". Read it back with memory_read first — it must match exactly.`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `That text appears ${occurrences} times in "${key}". Include more surrounding words so it matches once only.`,
    );
  }

  const { text, found } = redactSecrets(String(newString ?? ''));
  guardNote(text, allowed);
  // A function, not the string: `replace` reads `$&` and `` $` `` in a string
  // replacement as patterns, so a note edited to say "costs $&5" came out wrong.
  memory[key] = stampNote(boundedNote(note.content.replace(find, () => text)), { by: 'assistant', chatId, before: note });
  // Only this note, so a concurrent write to a different one is not undone.
  await store.mergeUserSetting(userId, target, { [key]: memory[key] });

  return found.length
    ? `Updated "${key}", with ${found.join(' and ')} removed from the replacement. Say so.`
    : `Updated "${key}".`;
}

async function memoryDelete({ key: rawKey }, { userId, chatId }) {
  const store = getStore();
  const key = noteName(rawKey);
  await memoryAllowed(userId, chatId);
  // Same reasoning as `memoryEdit`: the note is deleted where it actually is.
  // Own keys only — `"toString" in {}` is true, and would "delete" a note that
  // was never there.
  const { here, account, project } = await readBothScopes({ userId, chatId });
  const inProject = here.projectId && Object.hasOwn(project, key);
  if (!inProject && !Object.hasOwn(account, key)) {
    const keys = [...new Set([...Object.keys(project), ...Object.keys(account)])];
    throw new Error(
      keys.length
        ? `No note saved under "${key}". The notes in reach here are: ${keys.join(', ')}.`
        : `No note saved under "${key}" — there are no notes in reach here at all.`,
    );
  }

  // Removes the one entry in SQL rather than writing back a copy of the object
  // that happens to be missing it — which would undo anything saved meanwhile.
  await store.removeUserSettingKey(userId, inProject ? here.key : MEMORY_KEY, key);
  const scope = inProject ? ` from ${here.where}` : '';
  return `Deleted the note "${key}"${scope}. It will not be read into future conversations any more.`;
}

/**
 * Find the notes about something, rather than reading every note.
 *
 * The prompt carries as many notes as fit its budget and names the rest; this is
 * how one of the named ones is found by what it is about. Cheap on purpose —
 * notes are short and the words somebody asks with are nearly always in them.
 */
async function memorySearch({ query, limit }, { userId, chatId }) {
  await memoryAllowed(userId, chatId);
  const wanted = String(query ?? '').trim();
  if (!wanted) throw new Error('Say what to look for.');
  const { here, account, project } = await readBothScopes({ userId, chatId });
  const row = (scope) => ([key, note]) => ({
    key,
    scope,
    content: String(note?.content ?? ''),
    updatedAt: note?.updatedAt || null,
  });
  const notes = [
    ...Object.entries(project).map(row('project')),
    ...Object.entries(account).filter(([key]) => !(key in project)).map(row('account')),
  ];
  if (!notes.length) return 'No notes saved yet.';

  const hits = rankNotes(notes, wanted, limit);
  if (!hits.length) {
    const names = notes.map((n) => n.key);
    return `No note matches "${wanted}". The notes there are: ${names.slice(0, 80).join(', ')}${names.length > 80 ? ', …' : ''}.`;
  }
  return hits
    .map((n) => {
      const where = n.scope === 'project' ? ` — ${here.where}` : '';
      const date = n.updatedAt ? ` (${String(n.updatedAt).slice(0, 10)})` : '';
      const body = n.content.length > 1500 ? `${n.content.slice(0, 1500)}… [memory_read "${n.key}" for the rest]` : n.content;
      return `- ${n.key}${where}${date}: ${body}`;
    })
    .join('\n');
}

/**
 * The words of a recall query worth matching on — at most five, two letters or more.
 *
 * Stop words go first, or "what did we say about the deposit" would require
 * every message to contain "what", "did" and "we".
 */
const RECALL_STOP = new Set([
  'the', 'and', 'what', 'did', 'we', 'say', 'said', 'about', 'that', 'this', 'with', 'for', 'from', 'was', 'were', 'our',
  'you', 'me', 'my', 'last', 'time', 'chat', 'conversation', 'talked', 'discussed',
  'chúng', 'ta', 'mình', 'đã', 'nói', 'về', 'cái', 'gì', 'lần', 'trước', 'hôm', 'cuộc', 'trò', 'chuyện', 'những', 'các', 'của', 'và', 'là',
]);
const recallTerms = (text) =>
  [...new Set(String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u))]
    .filter((w) => w.length > 1 && !RECALL_STOP.has(w))
    .slice(0, 5);

/** A window of text around the first place any of the words appears. */
function excerpt(text, terms, width = 320) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (body.length <= width) return body;
  const lowered = body.toLowerCase();
  const at = terms.map((t) => lowered.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? '…' : ''}${body.slice(start, start + width)}${start + width < body.length ? '…' : ''}`;
}

/**
 * Look back through earlier conversations — Claude's chat search.
 *
 * Notes hold what the assistant decided was worth keeping; this reaches what it
 * did not think to keep. Scoped like Claude's: from inside a project, only that
 * project's conversations; from outside, only conversations outside every
 * project. Never this conversation, never an incognito one, and only what the
 * person and the assistant said — not tool output.
 *
 * What comes back is still somebody's earlier words, so it travels in the same
 * envelope as anything else read from outside this turn: an instruction found in
 * an old conversation is a quote, not an order.
 */
async function searchChatsTool({ query, limit }, { userId, chatId }) {
  const prefs = await getPrefs(userId).catch(() => ({}));
  if (prefs.chatSearch === false) {
    throw new Error('Searching earlier conversations is switched off for this account (Settings → Memory). Say so if it matters.');
  }
  const store = getStore();
  const chat = chatId ? await store.getChat(userId, chatId).catch(() => null) : null;
  if (chat?.incognito) {
    throw new Error('This is an incognito conversation, so earlier conversations are not searched from it.');
  }
  const scope = { projectId: chat?.project_id || null, excludeChatId: chatId || null };
  const wanted = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const where = scope.projectId ? 'in this project' : 'outside projects';

  const terms = recallTerms(query);
  if (!terms.length) {
    const recent = await store.recentChats(userId, { ...scope, limit: wanted });
    if (!recent.length) return `There are no earlier conversations ${where}.`;
    const body = recent
      .map((c) => `- "${c.title}" (${new Date(c.updated_at).toISOString().slice(0, 10)})${c.opening ? `: ${excerpt(c.opening, [], 200)}` : ''}`)
      .join('\n');
    return `The ${recent.length} most recent conversation${recent.length === 1 ? '' : 's'} ${where}:\n${untrusted('earlier conversations', body)}`;
  }

  let rows = await store.recallChats(userId, { ...scope, terms, mode: 'all' });
  let loose = false;
  if (!rows.length && terms.length > 1) {
    rows = await store.recallChats(userId, { ...scope, terms, mode: 'any' });
    loose = rows.length > 0;
  }
  if (!rows.length) return `No earlier conversation ${where} mentions ${terms.map((t) => `"${t}"`).join(' and ')}.`;

  const chats = new Map();
  for (const row of rows) {
    if (!chats.has(row.id)) {
      if (chats.size >= wanted) continue;
      chats.set(row.id, { title: row.title, updated: row.updated_at, lines: [] });
    }
    const entry = chats.get(row.id);
    if (entry.lines.length < 2) entry.lines.push(`  ${row.role === 'user' ? 'They said' : 'You said'}: ${excerpt(row.text, terms)}`);
  }
  const body = [...chats.values()]
    .map((c) => `- "${c.title}" (${new Date(c.updated).toISOString().slice(0, 10)})\n${c.lines.join('\n')}`)
    .join('\n');
  const note = loose ? ' (no conversation had every word, so these have some of them)' : '';
  return `${chats.size} earlier conversation${chats.size === 1 ? '' : 's'} ${where}${note}:\n${untrusted('earlier conversations', body)}`;
}

/**
 * Fewer steps than this is not a plan, and drawing one anyway is the failure
 * this guards against: the list is resent *in full* on every update, so a
 * one-item list means the whole job is one step. A checklist above a two-line
 * answer makes a small request look like a project and puts furniture between
 * the user and what they asked for.
 *
 * Two is deliberately permissive rather than three. The prompt asks the model to
 * judge where the line is, and a mechanism that overrules a defensible judgement
 * is worse than one that only catches what is unarguable.
 */
export const PLAN_MIN_STEPS = 2;

/**
 * The plan as the user should actually see it.
 *
 * Normalised rather than trusted, because the interface renders this directly
 * and both of these are cheap for a model to get wrong:
 *
 *   **Exactly one `in_progress`.** The tool description asks for it and models
 *   still mark three things as started at once. Somebody reading the panel to
 *   find out where you are then cannot, which is the only reason the panel
 *   exists. First one wins; the rest go back to pending.
 *
 *   **A status outside the enum**, or a step with no title, would otherwise
 *   render as a blank row or an unstyled one.
 *
 * Exported because the agent loop emits the event and this tool answers the
 * model — if those two normalised differently, the user and the model would be
 * looking at different plans.
 */
export function normalisePlan(steps) {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({
      title: s.title.trim(),
      status: ['pending', 'in_progress', 'done'].includes(s.status) ? s.status : 'pending',
      // What the step involves, shown when a task is added and beside the step
      // being worked on. Optional; cut to a size a side panel can hold.
      ...(typeof s.detail === 'string' && s.detail.trim() ? { detail: s.detail.trim().slice(0, 600) } : {}),
    }));

  let running = false;
  for (const step of list) {
    if (step.status !== 'in_progress') continue;
    if (running) step.status = 'pending';
    running = true;
  }

  return list;
}

/**
 * The plan is a UI affordance — the useful output is the event the agent loop
 * emits, so the model only needs a short acknowledgement back.
 */
async function updatePlan({ steps }) {
  const list = normalisePlan(steps);

  // Said back plainly rather than silently ignored. A model that gets "Plan
  // updated" for a plan nobody drew will keep sending it, and will describe a
  // checklist the user cannot see.
  if (list.length < PLAN_MIN_STEPS) {
    return (
      'No plan was shown — a checklist needs at least two steps to earn its space, ' +
      'and a job this short is quicker to simply do. Carry on and answer directly.'
    );
  }

  const done = list.filter((s) => s.status === 'done').length;
  const running = list.find((s) => s.status === 'in_progress');
  return (
    `Plan updated (${done}/${list.length} done)` +
    (running ? `, now on "${running.title}".` : '.')
  );
}

// ── skills, delegation, schedules, connected services ─────────────────

async function skillRead({ name }, { userId }) {
  return readSkill(userId, name);
}

async function skillWrite({ name, description, instructions }, { userId }) {
  const saved = await saveSkill(userId, { name, description, instructions });
  return `Saved the skill "${saved.name}". It will be offered to you in future conversations.`;
}

async function runParallelTool({ tasks }, { user, chatId, signal }) {
  return runParallel({ user, chatId, tasks, signal });
}

async function deepResearchTool({ question }, { userId, user, chatId, signal }) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Give a question to research.');
  const { content } = await runDeepResearch({
    question: q,
    userId,
    user,
    chatId,
    signal,
    // The research pass reads its best sources rather than trusting the search
    // engine's blurb. Passed in from here because the reader lives in this file
    // and importing it the other way would close a cycle. It is the same guarded
    // reader `web_fetch` uses — safeFetch, so a page cannot redirect the run at
    // the local network or the cloud metadata service — returning plain text,
    // from which research picks the passages that match the question.
    deps: { readPage: (target) => readPageText(target, { timeoutMs: 15_000 }) },
  });
  return content;
}

/* ── work that already exists ───────────────────────────────────────
 *
 * Asking twice for the same standing job is an ordinary thing to do. You set up
 * a Monday summary three weeks ago, you have forgotten, and you ask again — or
 * you ask for "the same but at eight", which reads to a model as a fresh
 * request. Both used to produce a second job beside the first, and two jobs
 * doing the same work are worse than one in every way that shows up later: the
 * summary arrives twice, cancelling one leaves the other running, and neither
 * the user nor the model can tell which is which.
 *
 * Nothing here decides anything. It finds the near-match, declines to create the
 * duplicate, and hands the model what is already there together with an
 * instruction to put the choice in front of the user as buttons — keep it,
 * change it, add a second one anyway, or drop the idea. A duplicate is sometimes
 * genuinely wanted; what is never wanted is one made silently.
 */

/** Words that carry meaning, for comparing two titles somebody wrote by hand. */
const titleWords = (value) =>
  new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1),
  );

/**
 * How alike two titles are, 0 to 1 — shared words over the smaller set.
 *
 * Against the smaller rather than the union, so "Monday summary" scores 1
 * against "Monday summary of my field": the same job described at two lengths,
 * which is the case this exists to catch.
 */
function titleOverlap(a, b) {
  const left = titleWords(a);
  const right = titleWords(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** Alike enough that a second one is more likely a mistake than a plan. */
const LOOKS_DUPLICATE = 0.7;

const findDuplicate = (existing, title, describe) =>
  existing
    .map((row) => ({ row, score: titleOverlap(title, describe(row)) }))
    .filter((hit) => hit.score >= LOOKS_DUPLICATE)
    .sort((a, b) => b.score - a.score)[0]?.row || null;

/**
 * What the model is told when it has asked for something that already exists.
 *
 * Written at the model, because the model is the only reader: it says what was
 * found, that nothing was created, and exactly what to do next. The four answers
 * are spelled out so that four different models produce the same four buttons
 * rather than each inventing its own set.
 */
const askBeforeDuplicating = (kind, summary) =>
  [
    'This already exists, so nothing was created. Here is what is already set up:',
    '',
    summary,
    '',
    'Show the user what is there — its title, when it runs, and what it does — then call ask_options with ' +
      'exactly these four answers, written in their language: keep it as it is; change this one to what they ' +
      `just asked for; create a second ${kind} as well; cancel. Do not choose for them, and do not create ` +
      'anything until they have pressed one.',
  ].join('\n');

/**
 * What the transcript draws for standing work that was just set up — or that
 * turned out to be set up already.
 *
 * A sentence was all a schedule ever produced: "Scheduled 'Monday summary' for
 * mon 08:00. First run: …". Correct, and gone the moment it scrolled away, with
 * no way from there to the thing itself — changing the time meant finding the
 * Scheduled shelf, finding the row, and opening it. The card says the same
 * facts at a glance (how often, which zone, when next) and ends in a pill that
 * opens the task, which is where adjusting it happens.
 *
 * Carried on the tool result like `file` and `widget`, so reopening the
 * conversation redraws it from the transcript. `existing` marks the duplicate
 * case: the card is then the thing the model is asking about, drawn above the
 * question so the person can see what they are being asked to keep or change.
 */
function scheduleCard(kind, row, { existing = false } = {}) {
  return {
    kind,
    id: row.id,
    title: row.title,
    cron: row.cron || null,
    nextRunAt: row.next_run_at || null,
    tz: row.tz || null,
    enabled: row.enabled !== false,
    steps: kind === 'workflow' && Array.isArray(row.steps) ? row.steps.length : undefined,
    endsOn: row.ends_on || null,
    // What it will do, so the card can say so under its facts: a task's
    // instructions, or a workflow's steps in order. Clipped — the card is a
    // summary, and the panel it opens holds the whole of it.
    prompt: kind === 'task' && row.prompt ? String(row.prompt).slice(0, 600) : undefined,
    stepList:
      kind === 'workflow' && Array.isArray(row.steps)
        ? row.steps
            .slice(0, 8)
            .map((step) => String(typeof step === 'string' ? step : step?.instruction ?? step?.prompt ?? '').slice(0, 160))
        : undefined,
    existing,
  };
}

/** Said to the model beside every card, so it confirms rather than recites. */
const CARD_SHOWN =
  'The user can see a card with these details and a button that opens it to adjust, so confirm in one ' +
  'sentence rather than listing them again.';

/**
 * "17:00" means the user's five o'clock, not the server's.
 *
 * The HTTP routes have always taken the zone from the browser. This tool had
 * no way to, so `parseSchedule` fell back to the server clock — UTC on a
 * deployment — and a task set for five in the afternoon in Vietnam fired at
 * midnight, silently, for ever. The zone is recorded on the account at
 * bootstrap now, so the tool path and the route path finally agree.
 *
 * The confirmation is rendered in that same zone. It previously used the
 * server's, so it stated a time that was not the one that would fire — which is
 * worse than saying nothing, because it looks like it has been checked.
 */
async function scheduleTaskTool({ title, prompt, when, repeat = true, confirmed }, { userId }) {
  const store = getStore();

  /*
   * Already set up? Then say so rather than setting it up twice.
   *
   * `confirmed` is how the model gets past this after the user has pressed
   * "create a second one as well" — a flag it may only set having actually
   * asked, which is why the message above tells it so in those words.
   */
  if (!confirmed) {
    const clash = findDuplicate(await store.listTasks(userId), title, (task) => task.title);
    if (clash) {
      const when_ = clash.cron ? `repeats ${clash.cron}` : 'runs once';
      const next = clash.next_run_at ? new Date(clash.next_run_at).toISOString() : 'unknown';
      return {
        schedule: scheduleCard('task', clash, { existing: true }),
        content: askBeforeDuplicating(
          'scheduled task',
          [
            `- "${clash.title}" — id ${clash.id}`,
            `    ${when_}${clash.enabled ? '' : ' (paused)'}, next run ${next}`,
            `    it asks: ${String(clash.prompt || '').replace(/\s+/g, ' ').slice(0, 200)}`,
            '',
            'To change it rather than add another, call cancel_task with that id and schedule_task again, or',
            'leave it alone entirely. To add a second one, call schedule_task again with confirmed: true.',
          ].join('\n'),
        ),
      };
    }
  }

  const prefs = await getPrefs(userId);
  const tz = prefs.timezone || null;
  const { cron, nextRunAt } = parseSchedule(when, { once: repeat === false, tz });

  const task = await store.createTask(userId, {
    id: crypto.randomUUID(),
    title,
    prompt,
    model: prefs.defaultModel,
    cron,
    nextRunAt,
    tz,
  });

  const at = new Date(task.next_run_at).toLocaleString('en-GB', tz ? { timeZone: tz } : undefined);
  const where = tz ? ` (${tz})` : ' — server time, because this account has not told us its timezone';
  return {
    schedule: scheduleCard('task', task),
    content: cron
      ? `Scheduled "${title}" for ${cron}. First run: ${at}${where}. ${CARD_SHOWN}`
      : `Scheduled "${title}" to run once at ${at}${where}. ${CARD_SHOWN}`,
  };
}

async function listTasksTool(_input, { userId }) {
  const tasks = await getStore().listTasks(userId);
  if (!tasks.length) return 'Nothing is scheduled on this account.';

  return [
    'Scheduled work on this account:',
    '',
    ...tasks.map((t) => {
      const when = t.cron ? `repeats ${t.cron}` : 'runs once';
      const next = t.next_run_at ? new Date(t.next_run_at).toISOString() : 'unknown';
      const last = t.last_run_at
        ? `last run ${new Date(t.last_run_at).toISOString()} (${t.last_status || 'no status'})`
        : 'never run';
      return [
        `- ${t.title} — id ${t.id}`,
        `    ${when}${t.enabled ? '' : ' (disabled)'}, next ${next}, ${last}`,
        `    prompt: ${String(t.prompt || '').replace(/\s+/g, ' ').slice(0, 160)}`,
      ].join('\n');
    }),
    '',
    'Pass an id to cancel_task to delete one.',
  ].join('\n');
}

async function cancelTaskTool({ id }, { userId }) {
  const store = getStore();
  // Checked first so a wrong id says so, rather than reporting success for a
  // delete that matched nothing — which is how somebody ends up believing a
  // daily job was stopped while it keeps running.
  const tasks = await store.listTasks(userId);
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    throw new Error(
      tasks.length
        ? `There is no scheduled task with the id "${id}". Call list_tasks to see what is there.`
        : 'There is nothing scheduled on this account to cancel.',
    );
  }

  await store.deleteTask(userId, id);
  return `Deleted the scheduled task "${task.title}". It will not run again.`;
}

/**
 * Create, change or delete a workflow.
 *
 * One tool for three verbs because the catalogue is charged against every
 * request's context window; see the note beside the definition.
 */
async function workflowWriteTool({ action, id, title, steps, when, repeat, enabled, confirmed }, { userId }) {
  const store = getStore();

  if (action === 'delete') {
    // Checked first, the same way cancel_task is: reporting success for a delete
    // that matched nothing is how somebody comes to believe a job was stopped
    // while it keeps running.
    const workflow = id ? await store.getWorkflow(userId, id) : null;
    if (!workflow) throw new Error(`There is no workflow with the id "${id}". Call workflow_status to see them.`);
    await store.deleteWorkflow(userId, id);
    return `Deleted the workflow "${workflow.title}". It will not run again.`;
  }

  if (action === 'update') {
    const existing = id ? await store.getWorkflow(userId, id) : null;
    if (!existing) throw new Error(`There is no workflow with the id "${id}". Call workflow_status to see them.`);

    const patch = {};
    if (title !== undefined) patch.title = String(title).trim() || existing.title;
    if (steps !== undefined) patch.steps = normaliseSteps(steps);
    if (enabled !== undefined) patch.enabled = Boolean(enabled);
    if (when !== undefined) {
      // In the account's zone, as on create — without it "08:00" became 08:00 UTC.
      const tz = (await getPrefs(userId)).timezone || null;
      if (when) Object.assign(patch, parseSchedule(when, { once: repeat === false, tz }));
      else Object.assign(patch, { cron: null, nextRunAt: null });
    }

    const updated = await store.updateWorkflow(userId, id, patch);
    const schedule = updated.cron ? `repeats ${updated.cron}` : 'runs by hand';
    return {
      schedule: scheduleCard('workflow', updated),
      content: `Updated "${updated.title}" — ${updated.steps.length} step(s), ${schedule}${updated.enabled ? '' : ', paused'}. ${CARD_SHOWN}`,
    };
  }

  /*
   * The same guard as `schedule_task`, for the same reason: a workflow asked
   * for twice runs its steps twice, and two copies of a job that files
   * documents or sends mail is the kind of duplicate somebody discovers from
   * the other end.
   */
  if (!confirmed) {
    const clash = findDuplicate(await store.listWorkflows(userId), title, (row) => row.title);
    if (clash) {
      const steps = Array.isArray(clash.steps) ? clash.steps : [];
      // A stored step is `{ instruction }` (see `normaliseSteps`); a bare string
      // is accepted too, so a row written before that shape still reads. Without
      // this the list said "1. [object Object]" for every step it had.
      const stepText = (step) => (typeof step === 'string' ? step : step?.instruction ?? step?.prompt ?? '');
      return {
        schedule: scheduleCard('workflow', clash, { existing: true }),
        content: askBeforeDuplicating(
          'workflow',
          [
            `- "${clash.title}" — id ${clash.id}`,
            `    ${clash.cron ? `repeats ${clash.cron}` : 'runs by hand'}${clash.enabled ? '' : ' (paused)'}, ${steps.length} step(s)`,
            ...steps
              .slice(0, 6)
              .map((step, i) => `    ${i + 1}. ${String(stepText(step)).replace(/\s+/g, ' ').slice(0, 120)}`),
            '',
            'To change it rather than add another, call workflow_write with action: "update" and that id.',
            'To add a second one, call workflow_write again with confirmed: true.',
          ].join('\n'),
        ),
      };
    }
  }

  const ordered = normaliseSteps(steps);
  const prefs = await getPrefs(userId);
  // The account's own zone, for the same reason as `schedule_task` above.
  const tz = prefs.timezone || null;
  const schedule = when
    ? parseSchedule(when, { once: repeat === false, tz })
    : { cron: null, nextRunAt: null };

  const workflow = await store.createWorkflow(userId, {
    id: crypto.randomUUID(),
    title: String(title || '').trim() || 'Workflow',
    steps: ordered,
    model: prefs.defaultModel,
    cron: schedule.cron,
    nextRunAt: schedule.nextRunAt,
    tz,
  });

  const first = workflow.next_run_at
    ? new Date(workflow.next_run_at).toLocaleString('en-GB', tz ? { timeZone: tz } : undefined)
    : null;
  return {
    schedule: scheduleCard('workflow', workflow),
    content: [
      `Created the workflow "${workflow.title}" with ${ordered.length} step(s). Id ${workflow.id}.`,
      first ? `First run: ${first}${schedule.cron ? ` (repeats ${schedule.cron})` : ''}.` : 'It runs when asked, not on a clock.',
      'Each step runs in order in one conversation, and a step that is interrupted is never repeated automatically.',
      CARD_SHOWN,
    ].join(' '),
  };
}

/** What is set up, and how the last run of each went — step by step. */
async function workflowStatusTool({ id }, { userId }) {
  const store = getStore();
  const workflows = id
    ? [await store.getWorkflow(userId, id)].filter(Boolean)
    : await store.listWorkflows(userId);

  if (!workflows.length) {
    return id ? `There is no workflow with the id "${id}".` : 'There are no workflows on this account.';
  }

  const lines = [];
  for (const wf of workflows) {
    const [run] = await store.listWorkflowRuns(userId, wf.id, 1);
    const schedule = wf.cron ? `repeats ${wf.cron}` : 'runs by hand';
    lines.push(`- ${wf.title} — id ${wf.id}`);
    lines.push(`    ${schedule}${wf.enabled ? '' : ' (paused)'}, ${wf.steps.length} step(s)`);

    if (!run) {
      lines.push('    never run');
      continue;
    }

    lines.push(`    last run ${new Date(run.started_at).toISOString()} — ${run.status}`);
    for (const [i, step] of (run.steps || []).entries()) {
      const detail = step.error ? ` — ${String(step.error).replace(/\s+/g, ' ').slice(0, 160)}` : '';
      lines.push(`      ${i + 1}. ${step.status}${detail}`);
    }
    if (run.status === 'needs_attention') {
      lines.push('    This one is waiting for a person. Nothing is repeated until it is dealt with.');
    }
  }

  return ['Workflows on this account:', '', ...lines].join('\n');
}

/**
 * Search the documents this conversation can read.
 *
 * In a project, that is first of all the project's own sources — files
 * uploaded there never went into the folder index, so searching only that
 * told the model "nothing has been indexed" in a project holding the very
 * document it was asked about. The shelf answers first; the folder index is
 * added when there is one, and its absence is not reported as an error when
 * the shelf already answered.
 */
async function searchDocsTool({ query, limit, source }, { userId, chatId }) {
  const chat = chatId ? await getStore().getChat(userId, chatId) : null;
  const fromProject = chat?.project_id ? await searchProject(userId, chat.project_id, query, limit) : null;
  if (!fromProject) return searchDocs(userId, { query, limit, source });

  const shelf = untrusted('project sources', fromProject);
  const indexed = await searchDocs(userId, { query, limit, source }).catch(() => null);
  if (!indexed || /^Nothing (has been )?indexed|^Nothing is indexed/.test(indexed)) return shelf;
  return `${shelf}\n\nFrom the indexed folders:\n${indexed}`;
}

async function listIndexedTool(_input, { userId }) {
  return listSources(userId);
}

async function forgetDocsTool({ source }, { userId }) {
  return forgetSource(userId, source);
}

async function githubTool({ path, params }, { userId }) {
  return CONNECTOR_CALLS.githubCall(userId, path, params);
}

async function githubWriteTool({ path, method, body }, { userId }) {
  return CONNECTOR_CALLS.githubWrite(userId, path, method, body);
}

/**
 * Send an email as the deployment.
 *
 * Reuses the transport the app already has for confirmation codes, so there is
 * nothing new to configure — and nothing new to get wrong about credentials.
 *
 * The console backend is the case that matters. With neither Resend nor SMTP set
 * up, `sendEmail` prints to the server log and returns successfully, which is
 * right for a password-reset code during development and completely wrong here:
 * an assistant that says "I have emailed the client" when nothing left the
 * building is worse than one that cannot send email at all. So that case is
 * reported as the failure it is.
 */
/**
 * The account's language and zone. The message's own language wins — the
 * recipient reads the footer, not the sender (see detectLanguage) — and the
 * account's is the fallback for a body too short to tell.
 */
async function accountMailPrefs(user) {
  const prefs = user?.id ? await getPrefs(user.id).catch(() => null) : null;
  return { language: prefs?.language || 'en', timeZone: prefs?.timezone || '' };
}

/** How many people one call may write to. More than this is a mailing list. */
const MAX_RECIPIENTS = 10;

/**
 * Who a message goes to, as the account asked.
 *
 * `to` may be one address, several separated by commas or semicolons, or a
 * list. Left empty, it is the account's own registered address — "email it to
 * me" is the most common request, and the model should not have to know or
 * guess the address to honour it.
 */
function recipientsFor(to, user) {
  const raw = Array.isArray(to) ? to : String(to ?? '').split(/[,;\n]/);
  const list = [...new Set(raw.map((a) => String(a).trim()).filter(Boolean).map((a) => a.replace(/^.*<([^>]+)>\s*$/, '$1').trim()))];
  if (!list.length) {
    if (!user?.email) throw new Error('Give the address to send to — this account has no email of its own on record.');
    return [user.email];
  }
  // Deliberately loose. A real address parser rejects valid addresses, and the
  // provider is the one that actually knows — this is only here to catch a model
  // passing a name or an empty string.
  const bad = list.find((a) => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a));
  if (bad) throw new Error(`"${bad}" is not an email address.`);
  if (list.length > MAX_RECIPIENTS) {
    throw new Error(`That is ${list.length} recipients; ${MAX_RECIPIENTS} is the limit for one email.`);
  }
  return list;
}

/** How far back an identical email counts as "already sent". */
const RESEND_WINDOW_MS = 20 * 60_000;

const sendKey = (recipients, subject) =>
  `${[...recipients].map((a) => a.toLowerCase()).sort().join(',')}|${String(subject || '').trim().toLowerCase()}`;

/**
 * When this conversation already had the same email accepted, recently.
 *
 * The same message went out twice: a workflow step told to "put it all in an
 * email" sent it, and the next step, "send the email", sent it again — or a run
 * started by hand overlapped the scheduled one. The conversation itself is the
 * record, so it is read rather than a second table kept: an earlier
 * `send_email` call to the same people with the same subject, whose result says
 * the mail server accepted it. The window is short enough that an hourly job
 * still sends every hour.
 */
async function alreadySent({ userId, chatId, user, recipients, subject }) {
  if (!userId || !chatId) return null;
  let messages;
  try {
    messages = await getStore().listMessages(userId, chatId);
  } catch {
    return null; // nothing to read is not a reason to refuse a send
  }
  const since = Date.now() - RESEND_WINDOW_MS;
  const wanted = sendKey(recipients, subject);
  const calls = new Map();
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const c of m.toolCalls || []) if (c.name === 'send_email') calls.set(c.id, c);
    } else if (m.role === 'tool' && new Date(m.createdAt).getTime() >= since) {
      for (const r of m.results || []) {
        const call = calls.get(r.toolCallId);
        if (!call || r.isError || !/accepted an email/.test(String(r.content))) continue;
        let to;
        try {
          to = recipientsFor(call.input?.to, user);
        } catch {
          continue;
        }
        if (sendKey(to, call.input?.subject) === wanted) return m.createdAt;
      }
    }
  }
  return null;
}

/**
 * @param {{ to?: string | string[], subject?: string, body?: string, html?: string, kind?: string, resend?: boolean }} input
 * @param {{ user?: { id?: string, email?: string, name?: string }, userId?: string, chatId?: string | null }} context
 */
async function sendEmailTool({ to, subject, body, html, kind, resend }, { user, userId, chatId } = {}) {
  const recipients = recipientsFor(to, user);
  const line = String(subject || '').trim();
  if (!line) throw new Error('An email with no subject line reads as spam. Give it one.');
  const text = String(body || '').trim();
  if (!text && !html) throw new Error('There is nothing to send — give a body.');

  if (resend !== true) {
    const when = await alreadySent({ userId: userId || user?.id, chatId, user, recipients, subject: line });
    if (when) {
      throw new Error(
        `This exact email — to ${recipients.join(', ')}, subject "${line}" — was already accepted by the mail server ` +
          'a few minutes ago in this conversation, so it was NOT sent again. Treat the send as done and carry on. ' +
          'Only if the user explicitly asked for a second copy, call again with resend: true.',
      );
    }
  }

  if (emailBackend() === 'console') {
    throw new Error(
      'No mail provider is configured on this deployment, so nothing can actually be sent — it would only be ' +
        'printed to the server log. Tell the user plainly that the email was NOT sent, and that the deployment needs ' +
        'GMAIL_USER and GMAIL_APP_PASSWORD (or RESEND_API_KEY, or SMTP_HOST) set for this tool to work. Do not claim to have sent it.',
    );
  }

  /*
   * Sent as the business: its name and mailbox on the From line, replies to it,
   * and the person named — never their own address — at the foot. Not their
   * name on the From line — see fromHeader for why that went to spam.
   *
   * The body is Markdown, laid out by mailTemplate.js as a finished email —
   * header, title, sections, lists, tables, footer — with a plain-text twin,
   * because a message with both parts is what an ordinary mail client sends.
   * An `html` body the model wrote itself is sent as given.
   */
  const account = await accountMailPrefs(user);
  const composed = text
    ? composeMessage({
        brand: senderName(),
        subject: line,
        markdown: text,
        // A name only: the person's own address is never printed in the message.
        sender: user?.name ? { name: user.name } : null,
        // A kind the model named is used as given; anything else is inferred.
        kind: KIND_NAMES.includes(String(kind)) ? String(kind) : 'auto',
        language: account.language,
        timeZone: account.timeZone,
      })
    : null;
  const result = await sendEmail({
    to: recipients,
    subject: line,
    text: composed?.text,
    html: html || composed?.html,
    // Replies come back to the business. EMAIL_REPLY_TO names a different
    // mailbox for them (support@…); the person's own address is not used, so it
    // never appears in a header either.
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
  });
  // `sendEmail` never throws — a failed password-reset mail must not break the
  // request — so a refusal from the provider arrives here as `ok: false`, and
  // reporting it as sent would be exactly the lie this tool exists not to tell.
  if (!result?.ok) {
    throw new Error(`The email was NOT sent: the mail provider refused it (${result?.error || 'no reason given'}). Say so plainly.`);
  }
  const accepted = result.accepted?.length ? result.accepted : recipients;
  const refused = result.rejected || [];
  const evidence = [
    result.messageId ? `Message-ID ${result.messageId}` : '',
    result.response ? `server reply: ${String(result.response).slice(0, 160)}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return (
    `The mail server accepted an email${composed ? ` (laid out as: ${composed.kind.replace('_', ' ')})` : ''} to ${accepted.join(', ')} with the subject "${line}"` +
    `; replies come back to ${process.env.EMAIL_REPLY_TO || `the ${senderName()} mailbox`}.` +
    `${refused.length ? ` It REFUSED ${refused.join(', ')} — say that those did not get it.` : ''}` +
    `${evidence ? ` (${evidence})` : ''} ` +
    'Accepted is not the same as delivered: if it does not arrive, it is in Spam, Promotions or All Mail, or a bounce ' +
    "is waiting in the sending mailbox. Say that it was accepted by the mail server, and that it cannot be recalled."
  );
}

/**
 * Make a picture.
 *
 * Through Google's Gemini image model, on the account's own Google key — see
 * `IMAGE_MODEL` and `requestImages` below for the model, the request shape, and
 * why it is no longer Imagen.
 *
 * OpenAI can also do this and is deliberately not wired up. One verified path is
 * worth more than two half-checked ones, and the error below names exactly what
 * to add rather than failing vaguely.
 *
 * The result goes into the conversation as a file, the same way `create_file`
 * works, so it appears as something to look at and download rather than a wall of
 * base64 in the transcript.
 */
/**
 * The image model, and why it is not the one this used to name.
 *
 * `generate_image` called `ai.models.generateImages` with `imagen-4.0-generate-001`.
 * Google's own model page says the Imagen 4 standard, ultra and fast endpoints
 * "are deprecated and will be shut down on August 17, 2026", and recommends
 * migrating to Gemini 3.1 Flash Image (https://ai.google.dev/gemini-api/docs/models/imagen,
 * read 2026-09-14). That date had passed when this was found: with no
 * `IMAGE_MODEL` override, the tool was calling an endpoint that no longer exists,
 * for every account (GAP-008).
 *
 * The replacement is a different API — Interactions rather than `generateImages`,
 * one image per request, bytes on `output_image.data` — confirmed against the
 * `@google/genai` 2.20.0 type declarations installed here, not assumed from the
 * docs alone. It has not been run against a live key: no key is available to this
 * audit, and spending the owner's credit to prove it was not authorised.
 */
const IMAGE_MODEL = 'gemini-3.1-flash-image';

/**
 * Ask for `count` images and gather what came back.
 *
 * Separated from the tool so the request shape and the reading of the response can
 * be pinned with a stand-in client — the real one needs a key and costs money per
 * call. One interaction per image, sent together, because this API returns one.
 *
 * @returns {Promise<{ images: Array<{ data: string, mime: string }>, usage: { input: number, output: number }, refusal: string|null }>}
 */
export async function requestImages(client, { model, prompt, count, aspectRatio }) {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () =>
      client.interactions.create({
        model,
        input: prompt,
        response_format: { type: 'image', ...(aspectRatio ? { aspect_ratio: String(aspectRatio) } : {}) },
        // Nothing about a picture request needs to be kept on Google's side.
        store: false,
      })),
  );

  const images = [];
  const usage = { input: 0, output: 0 };
  let refusal = null;
  let failure = null;
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      failure = failure || outcome.reason;
      continue;
    }
    const interaction = outcome.value || {};
    usage.input += Number(interaction.usage?.total_input_tokens) || 0;
    usage.output += Number(interaction.usage?.total_output_tokens) || 0;
    const image = interaction.output_image;
    if (image?.data) {
      images.push({ data: image.data, mime: image.mime_type || 'image/png' });
    } else if (!refusal) {
      // A model that declines usually says why in text, or in the errors list.
      refusal = interaction.errors?.[0]?.message || interaction.output_text || null;
    }
  }
  // Every request failing outright is an error to report, not an empty result.
  if (!images.length && !refusal && failure) throw failure;
  return { images, usage, refusal };
}

async function generateImageTool({ prompt, name, aspect_ratio: aspectRatio, count }, { userId, chatId }) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Describe the image you want.');

  const key = await getApiKey(userId, 'google');
  if (!key) {
    throw new Error(
      'Making pictures needs a Google API key, and this account has none. Tell the user to add one in ' +
        'Settings → Providers → Google Gemini. Their OpenRouter key cannot do this — image models are not part of ' +
        'that catalogue here.',
    );
  }

  const wanted = Math.min(Math.max(Number(count) || 1, 1), 4);
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: key });
  const model = process.env.IMAGE_MODEL || IMAGE_MODEL;

  const { images, usage, refusal } = await requestImages(ai, { model, prompt: text, count: wanted, aspectRatio });

  /*
   * Booked, which it never was (CODE-024). One call makes up to four pictures on
   * the account's own Google key, and nothing recorded it: an account making many
   * images looked free on the usage page, and a monthly limit set by an admin did
   * not count this spend at all. The Interactions API reports tokens for image
   * output, so what is recorded is the provider's own figure — no per-image price
   * is guessed here.
   */
  if (usage.input || usage.output) {
    // `costUsd` 0 on purpose: the tokens are the provider's own figure and count
    // against the monthly limit, while a dollar amount would need a price table
    // entry for this model that nothing here has verified.
    await recordUsage(userId, { chatId, model: `google/${model}`, usage, costUsd: 0, role: 'image' }).catch((err) =>
      log.error('image usage not recorded', err, { model }));
  }

  if (!images.length) {
    // A refusal is not an empty result, and reporting it as one would have the
    // model try again with the same prompt.
    throw new Error(
      refusal
        ? `Google declined to make that image: ${refusal}`
        : 'Google returned no image and gave no reason. Try describing it differently.',
    );
  }

  const base = String(name || text).replace(/[\\/:*?"<>|]/g, '-').slice(0, 60).trim() || 'image';
  const saved = [];
  for (const [index, image] of images.entries()) {
    const { mime } = image;
    const extension = mime.includes('jpeg') ? 'jpg' : mime.split('/')[1] || 'png';
    const file = await saveGenerated(userId, {
      name: `${base}${images.length > 1 ? ` ${index + 1}` : ''}.${extension}`,
      mime,
      data: image.data,
      chatId,
    });
    saved.push(file);
  }

  const first = saved[0];
  return {
    content:
      `Made ${saved.length} image${saved.length === 1 ? '' : 's'}: ${saved.map((f) => f.name).join(', ')}. ` +
      `${saved.length === 1 ? 'It is' : 'They are'} in the conversation now — the user can see and download ` +
      // Imagen returned an `enhancedPrompt`; the Interactions API has no such field,
      // so the line that reported it is gone rather than left reading undefined.
      `${saved.length === 1 ? 'it' : 'them'}, so do not try to describe the pixels back to them.`,
    file: { id: first.id, name: first.name, mime: first.mime, kind: first.kind, bytes: first.bytes },
  };
}

async function telegramSendTool({ chat_id: chatIdArg, text }, { userId }) {
  return CONNECTOR_CALLS.telegramSend(userId, chatIdArg, text);
}

async function metaPagePostTool({ message, link }, { userId }) {
  return CONNECTOR_CALLS.metaPagePost(userId, message, link);
}

async function notionSearchTool({ query }, { userId }) {
  return CONNECTOR_CALLS.notionSearch(userId, query);
}

async function slackPostTool({ channel, text }, { userId }) {
  return CONNECTOR_CALLS.slackPost(userId, channel, text);
}

const LOOK_MAX_BYTES = 12 * 1024 * 1024;
/** A whole textbook is 20–40MB; the pages asked for are rendered from it, never all of it. */
const LOOK_MAX_PDF_BYTES = 48 * 1024 * 1024;
const LOOK_FETCH_MS = 90_000;
/** A file name from a URL, readable, and never a throw over a stray %. */
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const LOOKABLE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i;

/** The newest picture or PDF sent in this conversation, or null. */
async function latestLookable(userId, chatId) {
  const messages = await getStore().listMessages(userId, chatId).catch(() => []);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const files = messages[i].attachments || [];
    for (let j = files.length - 1; j >= 0; j -= 1) {
      const file = files[j];
      if (file?.id && (file.kind === 'image' || file.kind === 'document' || /^image\/|pdf/i.test(String(file.mime || '')))) {
        return { id: file.id, name: file.name, kind: file.kind === 'image' || /^image\//i.test(String(file.mime || '')) ? 'image' : 'document' };
      }
    }
  }
  return null;
}

/** Whether the model this conversation runs on can see pictures. */
async function chatModelSees(userId, chatId) {
  try {
    const chat = await getStore().getChat(userId, chatId);
    const prefs = await getPrefs(userId);
    const entry = await resolveForUser(userId, chat?.model || prefs.defaultModel);
    return entry?.vision === true;
  } catch {
    return false;
  }
}

/**
 * Look at a picture or a PDF page on demand, with a model that can see.
 *
 * The tool form of `lendEyes`: for a screenshot a browser step just took, an
 * image or a PDF on the web, a particular page of a long document, or a
 * question about a picture the model was only given a reading of. Any model
 * can call it; for one that cannot see it is the only way to look at all.
 */
async function lookAtTool({ file_id: fileId, url, pages, question }, { userId, chatId, signal }) {
  const ask = String(question || '').trim();
  const wantPages = Array.isArray(pages) ? pages.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 8) : null;
  let source;
  let item;

  if (fileId) {
    const row = await getStore().getAttachment(userId, String(fileId));
    if (!row) throw new Error(`There is no file ${fileId} in this account.`);
    if (row.kind !== 'image' && row.kind !== 'document') {
      throw new Error(`${row.name} is not a picture or a PDF — read it with read_generated_file or as text instead.`);
    }
    source = row.name;
    item = row.kind === 'image' ? { images: [{ mime: row.mime, data: row.data, name: row.name }] } : { pdf: { data: row.data, name: row.name, pages: wantPages } };
  } else if (url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error(`"${url}" is not a valid URL.`);
    }
    /*
     * A textbook PDF on a slow university server is the ordinary case, not the
     * edge: 30 seconds and 12MB failed it with a bare "aborted" and the model
     * retried the same thing. A PDF gets longer and more room; the turn's own
     * Stop still cancels at once.
     */
    const timer = AbortSignal.timeout(LOOK_FETCH_MS);
    const both = signal ? AbortSignal.any([signal, timer]) : timer;
    const host = parsed.host;
    const slow = () =>
      new Error(
        `${host} took more than ${LOOK_FETCH_MS / 1000}s to send that file, so it was stopped. The server is slow or the file is very large — ` +
          'try once more, or look for another copy (a publisher or library page), or read it as text with web_fetch.',
      );
    let res;
    try {
      // The same guard as web_fetch: public addresses only, every hop checked.
      res = await safeFetch(parsed, { headers: { Accept: 'image/*,application/pdf;q=0.9,*/*;q=0.5' }, signal: both });
    } catch (err) {
      if (timer.aborted && !signal?.aborted) throw slow();
      throw err;
    }
    if (res.status === 404) throw new Error(`${host} has no file at that address (HTTP 404). Check the link, and that spaces are written %20.`);
    if (!res.ok) throw new Error(`${host} returned HTTP ${res.status}.`);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // Some servers label a PDF as a download; the address and the bytes say what it is.
    const isPdf = type === 'application/pdf' || ((type === 'application/octet-stream' || type === 'binary/octet-stream' || !type) && /\.pdf$/i.test(parsed.pathname));
    if (!isPdf && !LOOKABLE.test(type)) throw new Error(`That address is ${type || 'not a picture'}, not an image or a PDF — use web_fetch for a page.`);
    const cap = isPdf ? LOOK_MAX_PDF_BYTES : LOOK_MAX_BYTES;
    let buffer;
    let truncated;
    try {
      ({ buffer, truncated } = await readCapped(res, cap));
    } catch (err) {
      if (timer.aborted && !signal?.aborted) throw slow();
      throw err;
    }
    if (truncated) {
      throw new Error(
        `That file is over ${Math.round(cap / 1024 / 1024)}MB, too large to look at whole. ` +
          (isPdf ? 'Search for the chapter or page you need as its own file, or read it as text with web_fetch.' : 'Find a smaller version of the picture.'),
      );
    }
    source = parsed.href;
    const data = buffer.toString('base64');
    item = isPdf ? { pdf: { data, name: safeDecode(parsed.pathname.split('/').pop() || '') || 'document.pdf', pages: wantPages } } : { images: [{ mime: type, data, name: parsed.href }] };
  } else {
    /*
     * Neither given: "what is this picture?" about the one just attached. The
     * call used to fail outright, a red card on the commonest question there
     * is. The newest picture or PDF in the conversation is what was meant.
     */
    const latest = chatId ? await latestLookable(userId, chatId) : null;
    if (!latest) throw new Error('Give a `file_id` (an attachment, a made file or a step screenshot) or a `url` of an image or PDF.');
    // A model that can see already has the picture in front of it; a second
    // model reading it again is time and money spent on nothing.
    if (latest.kind === 'image' && (await chatModelSees(userId, chatId))) {
      return (
        `${latest.name || 'The picture'} is attached to this conversation and you can see it — it is already in front of you. ` +
        'Answer from the picture itself. (look_at is for an image or PDF by url, particular pages of a PDF, or a step screenshot.)'
      );
    }
    return lookAtTool({ file_id: latest.id, url: undefined, pages, question }, { userId, chatId, signal });
  }

  const { text, model } = await see({ userId, chatId, ...item, question: ask, signal });
  // The reading is of somebody else's picture, so it is outside content too.
  return untrusted(`${source} (read by ${model})`, text);
}

/**
 * The address the app is reached at, for a link the model hands over. Stated
 * wins; on Vercel the production domain is known without asking; otherwise
 * the path alone, which the interface turns into a full link.
 */
export function appOrigin(origin = null, env = process.env) {
  const stated = String(env.PUBLIC_URL || '').trim();
  if (stated) return stated.replace(/\/+$/, '');
  /*
   * The address the person is on, read from the request that started the turn.
   * Ahead of Vercel's production domain on purpose: that variable named
   * `ai-remote-amber.vercel.app`, a domain that no longer reached a deployment,
   * so every published link opened Vercel's 404 while the app itself was being
   * used at another address. Only an http(s) origin is taken.
   */
  const seen = String(origin || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/\s]+$/i.test(seen)) return seen;
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return '';
}

/** Publish something the assistant made as a link anyone can open. */
async function publishFileTool({ file_id: fileId, unpublish }, { userId, origin = null }) {
  const id = String(fileId || '').trim();
  if (!id) throw new Error('Give the `file_id` of a file you made — create_file returns it.');
  if (unpublish) {
    const gone = await getStore().setAttachmentShare(userId, id, null);
    if (gone === undefined) throw new Error(`There is no file ${id} made in this account.`);
    return 'The link is taken back; anyone who opens it now gets "not found".';
  }
  const shared = await shareFile(userId, id);
  if (shared.error) throw new Error(shared.status === 404 ? `There is no file ${id} made in this account.` : shared.error);
  // A scheduled run has no request of its own: the address this account last
  // used the app at stands in (stored by `rememberOrigin` in app.js).
  const seen = origin || (await getStore().getSetting(`origin:${userId}`).catch(() => null));
  const url = `${appOrigin(seen)}${shared.path}`;
  return (
    `Published ${shared.file.name}: ${url}\n` +
    'Anyone with this link can open it without signing in — a page runs sandboxed, with no access to the account. ' +
    'Give the user the link. They can take it back from the file card, or you can with unpublish.'
  );
}

export const CLOUD_IMPLEMENTATIONS = {
  create_file: createFileTool,
  update_file: updateFileTool,
  read_generated_file: readGeneratedFileTool,
  file_versions: fileVersionsTool,
  web_fetch: webFetch,
  ask_options: askOptionsTool,
  youtube_transcript: youtubeTranscript,
  load_tools: loadToolsTool,
  web_search: webSearch,
  show_widget: showWidgetTool,
  chart: chartTool,
  calculate: calculateTool,
  world_facts: worldFactsTool,
  // The everyday toolbox — dates, units, markets, places, feeds, text, tables,
  // QR codes, any API, the encyclopedia. See library.js.
  ...LIBRARY_IMPLEMENTATIONS,
  ...GOOGLE_IMPLEMENTATIONS,
  extract: extractTool,
  memory_write: memoryWrite,
  memory_read: memoryRead,
  memory_append: memoryAppend,
  memory_edit: memoryEdit,
  memory_delete: memoryDelete,
  memory_search: memorySearch,
  search_chats: searchChatsTool,
  update_plan: updatePlan,
  skill_read: skillRead,
  skill_write: skillWrite,
  run_parallel: runParallelTool,
  deep_research: deepResearchTool,
  schedule_task: scheduleTaskTool,
  list_tasks: listTasksTool,
  cancel_task: cancelTaskTool,
  workflow_write: workflowWriteTool,
  workflow_status: workflowStatusTool,
  search_docs: searchDocsTool,
  list_indexed: listIndexedTool,
  forget_docs: forgetDocsTool,
  github: githubTool,
  github_write: githubWriteTool,
  notion_search: notionSearchTool,
  slack_post: slackPostTool,
  telegram_send: telegramSendTool,
  meta_page_post: metaPagePostTool,
  send_email: sendEmailTool,
  generate_image: generateImageTool,
  image_search: imageSearchTool,
  sports: sportsTool,
  show_card: showCardTool,
  sandbox_run: (input, context) => runInSandbox(input, context),
  cloud_browser: (input, context) => cloudBrowser(input, context),
  publish_file: publishFileTool,
  look_at: lookAtTool,
};
