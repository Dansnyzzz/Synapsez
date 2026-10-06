import { search as defaultSearch } from '../search.js';
import { STOPWORDS } from '../rag.js';
import { mapWithLimit } from '../util/parallel.js';
import { registrableDomain, RANK_ORDER } from './confidence.js';

/**
 * Which outlets carry the standing that lets two of them make a claim HIGH.
 *
 * This was twelve Anglophone outlets and nothing else. `grade()` awards HIGH
 * only on two independent sources ranked `reputable` or better that were
 * actually opened, and every host not on the list ranks `blog` — so a claim
 * confirmed by VnExpress, Tuổi Trẻ and Thanh Niên, all fetched and read, was
 * capped at MEDIUM, while the same claim from two Reuters pages was HIGH
 * (ACC-006). For an app whose interface ships in Vietnamese and whose clients'
 * questions are largely about a Vietnamese market, the grader was marking down
 * exactly the sources most likely to be right about local facts, and a reader
 * seeing MEDIUM could not tell that apart from thin evidence.
 *
 * Two changes, and they are different kinds of change.
 *
 * `REGIONAL` is a judgement, and it is stated as one: the national wire service
 * (VNA) and the major national dailies and broadcasters, chosen by the same test
 * the comment on `rankSource` gives — does it carry the weight of a wire service
 * or a major outlet, or is it a blog. The owner of a deployment is better placed
 * to make that call than this file is, which is the reason for the second change.
 *
 * `RESEARCH_REPUTABLE_DOMAINS` adds registrable domains, comma-separated, without
 * editing code. A market this list does not know about needs a line in `.env`,
 * not a release.
 */
const GLOBAL = [
  'reuters.com', 'apnews.com', 'bbc.co.uk', 'bbc.com', 'nytimes.com', 'wsj.com',
  'ft.com', 'economist.com', 'nature.com', 'science.org', 'bloomberg.com', 'theguardian.com',
];
const REGIONAL = [
  // Vietnam: the national news agency, then national dailies and broadcasters.
  'vnanet.vn', 'vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'vietnamnet.vn',
  'nhandan.vn', 'vtv.vn', 'vov.vn', 'baochinhphu.vn', 'vneconomy.vn',
];
const configured = () =>
  String(process.env.RESEARCH_REPUTABLE_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
// Read per call rather than frozen at import, so a changed setting takes effect
// without depending on module load order — the import-time freeze this audit
// found twice elsewhere.
const reputable = () => new Set([...GLOBAL, ...REGIONAL, ...configured()]);
/**
 * Anchored to the end of the name (ACC-008). `gov` or `edu` must be the suffix
 * itself — `.gov`, or `.gov.vn` under a country code — and the named bodies
 * must be the whole registrable name or a subdomain of it. It matched fragments:
 * `gov.attacker.com`, `x.edu.attacker.net`, `notarxiv.org` and `fakeeuropa.eu`
 * all ranked primary, so a claim planted on two such hosts counted as two
 * independent primary sources and could be graded HIGH.
 */
/**
 * Which country codes keep a second level for real institutions (ACC-017).
 *
 * `gov.<cc>` and `edu.<cc>` were primary under any country code, and some
 * registries sell those names to anyone — so `x.edu.<cc>` there was a primary
 * source somebody could buy. These are the registries known to restrict the
 * name to government bodies, universities and schools (`ac` and `go` are the
 * same idea in other naming traditions). A country code not listed is not
 * primary: an unlisted real ministry ranks lower than it should, which costs a
 * little confidence; a listed fake would be counted as independent evidence.
 */
const INSTITUTIONAL = {
  gov: new Set(['vn', 'uk', 'au', 'cn', 'in', 'sg', 'my', 'br', 'ar', 'za', 'hk', 'tw', 'ph', 'pk', 'bd', 'tr', 'il', 'ie', 'ng', 'eg', 'sa', 'ae', 'it', 'pl', 'lk', 'np', 'kh', 'la']),
  edu: new Set(['vn', 'au', 'cn', 'sg', 'my', 'br', 'ar', 'hk', 'tw', 'ph', 'pk', 'tr', 'mx', 'co', 'pe', 'eg', 'sa', 'in', 'bd', 'np', 'lk', 'kh', 'la']),
  ac: new Set(['uk', 'jp', 'kr', 'nz', 'za', 'in', 'il', 'th', 'id', 'at', 'cn']),
  go: new Set(['jp', 'kr', 'th', 'id']),
};
const PRIMARY_NAMED = /(^|\.)(europa\.eu|who\.int|arxiv\.org|govt\.nz|gouv\.fr|gc\.ca|gob\.mx|gob\.es)$/;

/** @param {string} host */
function isPrimaryHost(host) {
  // The generic `.gov` and `.edu` are restricted by their registries outright.
  if (/(^|\.)(gov|edu)$/.test(host)) return true;
  const national = /(?:^|\.)(gov|edu|ac|go)\.([a-z]{2})$/.exec(host);
  if (national) return INSTITUTIONAL[national[1]].has(national[2]);
  return PRIMARY_NAMED.test(host);
}
const SOCIAL = /(^|\.)(twitter|x|reddit|facebook|instagram|tiktok|medium)\.com$/;

/**
 * A coarse authority guess from the host — enough to weight evidence, never to
 * trust it blindly.
 *
 * The ranks feed `grade`, which is why the classes are deliberately broad:
 * "does this carry the weight of a wire service or a government, or is it a
 * blog" is a judgement a hostname can support; anything finer would be pretending
 * to a precision the host does not carry. Unknown hosts are `blog`, the cautious
 * default, so an unrecognised source never inflates a confidence score.
 */
export function rankSource(url) {
  const d = registrableDomain(url);
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return d;
    }
  })();
  if (isPrimaryHost(host)) return 'primary';
  if (reputable().has(d)) return 'reputable';
  if (SOCIAL.test(host)) return 'social';
  return 'blog';
}

/**
 * How many sources a run opens and reads — and the ceiling on how many it will
 * try to get there.
 *
 * Three was the number, and it showed: a run listed 35 sources and read 3, so 32
 * citations were search blurbs and five conclusions in six could only ever be
 * graded LOW. Eight is enough for two or three independent sources per angle
 * of a typical four-to-six-query plan, which is what the grader looks for. A
 * page that will not load is replaced by the next candidate rather than leaving
 * a hole, up to the attempt ceiling — paywalls and 403s are common, and a
 * fixed list of three meant one bad site cost a third of the evidence.
 *
 * Reading costs fetches, not model calls, and each page is cut to the passages
 * that match the question (see `relevantPassages`), so more pages buys accuracy
 * without a matching rise in tokens.
 */
export const READ_TARGET = 8;
const READ_ATTEMPTS = 14;
/** Pages read at once — enough to finish a wave in one slow page's time. */
const READ_CONCURRENCY = 6;
/** Searches at once — the engines rate-limit a burst, so not all six together. */
const SEARCH_CONCURRENCY = 3;
/** Each page's share of the debate's evidence, after relevance selection. */
export const PASSAGE_CHARS = 2_400;
/** The most text from one page that is worth scanning for passages. */
const SCAN_CHARS = 200_000;

/* ── what a page says about the question ─────────────────────────────── */

// Two letters and up: a Vietnamese syllable carries meaning at that length.
const termsOf = (text) =>
  [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (w) => w.length > 1 && !STOPWORDS.has(w),
  );

/**
 * The parts of a page that bear on the question, in the page's own order.
 *
 * A page is mostly not the answer: navigation, a cookie notice, related links,
 * the comments. The first 4,000 characters — what research used to keep — were
 * usually that, and the paragraph with the figure in it was past the cut. Here
 * every paragraph is scored by the question's words it contains (each word once,
 * weighted by how rare it is on this page), with a little extra for a paragraph
 * holding a number, because the facts research is asked to check are so often
 * figures and dates. The best are kept up to the budget and put back in order,
 * joined by `[…]` so nothing reads as continuous that was not.
 *
 * No model call, no dependency — the same kind of lexical scoring the project
 * shelf uses, which is crude and entirely adequate for "which paragraph is this
 * page's answer".
 */
export function relevantPassages(text, terms, budget = PASSAGE_CHARS) {
  const body = String(text || '').slice(0, SCAN_CHARS).replace(/\r\n/g, '\n').trim();
  if (body.length <= budget) return body;

  const paragraphs = body
    .split(/\n{2,}|\n(?=[-*•#]|\d+[.)]\s)/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter((p) => p.length >= 40);
  if (!paragraphs.length) return body.slice(0, budget);

  const lowered = paragraphs.map((p) => p.toLowerCase());
  const df = new Map(terms.map((t) => [t, lowered.filter((p) => p.includes(t)).length]));
  const scored = paragraphs.map((p, i) => {
    let score = 0;
    for (const t of terms) {
      const seen = df.get(t) || 0;
      if (seen && lowered[i].includes(t)) score += Math.log(1 + paragraphs.length / seen);
    }
    if (score > 0 && /\d/.test(p)) score *= 1.15;
    // A very long block is often a dump of links or a table of contents.
    if (p.length > 1500) score *= 0.8;
    return { i, p, score };
  });

  const best = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  // Nothing on the page shares a word with the question: its opening is the
  // honest fallback, labelled as such by the caller's "read" flag staying true.
  if (!best.length) return body.slice(0, budget);

  const keep = [];
  let used = 0;
  for (const s of best) {
    const room = budget - used - 5;
    if (room < 120) break;
    let piece = s.p;
    if (piece.length > room) {
      // A later, shorter match may still fit; only the best one is ever cut.
      if (keep.length) continue;
      piece = `${piece.slice(0, room - 1)}…`;
    }
    keep.push({ ...s, p: piece });
    used += piece.length + 5;
  }
  keep.sort((a, b) => a.i - b.i);
  let out = '';
  let previous = -2;
  for (const k of keep) {
    if (out) out += k.i === previous + 1 ? '\n\n' : '\n\n[…]\n\n';
    else if (k.i > 0) out += '[…]\n\n';
    out += k.p;
    previous = k.i;
  }
  return out;
}

/* ── which pages to open ─────────────────────────────────────────────── */

/**
 * The order in which sources are worth opening.
 *
 * By standing first (a government page before a blog), then by how many of the
 * plan's queries found the same page — several angles landing on one source is
 * evidence it is central — then by how high it ranked in the search that found
 * it. Then spread across sites: one page per registrable domain until every
 * domain has had a turn, because HIGH needs two *independent* sources and three
 * pages of one outlet are one source three times.
 */
export function readingOrder(ledger, findings) {
  const hits = new Map();
  const position = new Map();
  const perQuery = new Map();
  for (const f of findings) {
    if (!f.id) continue;
    hits.set(f.id, (hits.get(f.id) || 0) + 1);
    const seen = perQuery.get(f.query) || 0;
    perQuery.set(f.query, seen + 1);
    if (!position.has(f.id)) position.set(f.id, seen);
  }
  const ranked = [...ledger.keys()].sort((a, b) => {
    const sa = ledger.get(a);
    const sb = ledger.get(b);
    return (
      (RANK_ORDER[sb.rank] ?? 0) - (RANK_ORDER[sa.rank] ?? 0) ||
      (hits.get(b) || 0) - (hits.get(a) || 0) ||
      (position.get(a) ?? 99) - (position.get(b) ?? 99)
    );
  });

  const order = [];
  const taken = new Set();
  for (let perDomain = 1; order.length < ranked.length; perDomain += 1) {
    const counts = new Map();
    for (const id of order) {
      const d = registrableDomain(ledger.get(id).url);
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    let added = false;
    for (const id of ranked) {
      if (taken.has(id)) continue;
      const d = registrableDomain(ledger.get(id).url);
      if ((counts.get(d) || 0) >= perDomain) continue;
      counts.set(d, (counts.get(d) || 0) + 1);
      order.push(id);
      taken.add(id);
      added = true;
    }
    if (!added) break;
  }
  return order;
}

/** A read that gives up on its own clock, whatever the reader does. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the page took too long to load')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Open the best sources and keep what they actually say about the question.
 *
 * In waves: as many as are still wanted, in parallel; a page that fails is
 * replaced by the next in the reading order, until the target is met, the
 * attempt ceiling is reached, or the clock says the debate needs the time.
 *
 * Failures are recorded on the source rather than dropped, because "the page
 * would not load" and "the page does not say" are different answers and the
 * grader has to be able to tell them apart.
 */
async function readSources(ledger, findings, readPage, { terms, target, deadline, timeoutMs }) {
  if (typeof readPage !== 'function') return;
  const queue = readingOrder(ledger, findings);
  let read = 0;
  let tried = 0;

  while (read < target && tried < READ_ATTEMPTS && queue.length) {
    if (deadline && Date.now() >= deadline) break;
    const wave = queue.splice(0, Math.min(target - read, READ_ATTEMPTS - tried));
    tried += wave.length;
    const left = deadline ? Math.max(1_000, deadline - Date.now()) : timeoutMs;
    await mapWithLimit(wave, READ_CONCURRENCY, async (id) => {
      const source = ledger.get(id);
      try {
        const text = await withTimeout(Promise.resolve(readPage(source.url)), Math.min(timeoutMs, left));
        const body = relevantPassages(text, terms);
        if (body) {
          source.body = body;
          source.read = true;
          read += 1;
        } else {
          source.readError = 'the page returned nothing';
        }
      } catch (err) {
        source.readError = String(err?.message || 'the page could not be read').slice(0, 160);
      }
    });
  }
}

/**
 * Run every query and fold the results into one ledger, deduped by url so a
 * source cited twice does not count as two independent ones. Each source keeps
 * a stable `S#` id that the draft cites and the report lists.
 *
 * The searches run three at a time rather than one after another — six queries
 * in series was most of a run's wall clock — and are folded in the plan's order
 * afterwards, so the ids do not depend on which engine answered first.
 *
 * A search that throws does not stop the run — it becomes a finding that records
 * why, so a missing engine reads as "this angle found nothing" rather than
 * taking the whole question down with it.
 *
 * `search` is injectable and defaults to the real four-engine chain. `question`
 * is the question itself, whose words choose each page's passages along with
 * the queries'. `deadline` is the epoch ms after which no new page is opened, so
 * the debate keeps the time it needs. The ledger maps `S#` to
 * `{url, rank, title, published, snippet, body?, read?}`.
 *
 * @param {string[]} queries
 * @param {{
 *   search?: (query: string, options?: any) => Promise<any>,
 *   readPage?: (url: string) => Promise<string>,
 *   userId?: string|null, question?: string, deadline?: number|null, target?: number, timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{ ledger: Map<string, any>, findings: Array<{ id: string|null, query: string, snippet: string }> }>}
 */
export async function gatherEvidence(
  queries,
  { search = defaultSearch, readPage, userId = null, question = '', deadline = null, target = READ_TARGET, timeoutMs = 15_000 } = {},
) {
  const ledger = new Map();
  const byUrl = new Map();
  const findings = [];
  let n = 0;

  const answers = await mapWithLimit(queries, SEARCH_CONCURRENCY, async (query) => {
    try {
      return { query, out: await search(query, { userId }) };
    } catch (err) {
      return { query, error: err };
    }
  });

  for (const { query, out, error } of answers) {
    if (error) {
      findings.push({ id: null, query, snippet: `(search failed: ${error.message})` });
      continue;
    }
    for (const r of out?.results || []) {
      if (!r?.url) continue;
      let id = byUrl.get(r.url);
      if (!id) {
        id = `S${(n += 1)}`;
        byUrl.set(r.url, id);
        ledger.set(id, {
          url: r.url,
          rank: rankSource(r.url),
          title: r.title || undefined,
          published: r.published || undefined,
          snippet: r.snippet || '',
        });
      }
      findings.push({ id, query, snippet: r.snippet });
    }
  }

  const terms = termsOf([question, ...queries].join(' '));
  await readSources(ledger, findings, readPage, { terms, target, deadline, timeoutMs });

  return { ledger, findings };
}
