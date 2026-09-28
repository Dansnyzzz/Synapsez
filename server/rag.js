/**
 * Semantic search over the user's own documents.
 *
 * The split follows the one the rest of the project already lives by: the files
 * are on the user's machine and never leave it wholesale, but embedding needs an
 * API key, and keys live on the server. So the worker reads, extracts and chunks
 * locally, and sends up only the chunks — text that was going to be searched
 * anyway — while this module turns them into vectors and answers questions
 * about them.
 *
 * Two things are worth being explicit about, because they are choices rather
 * than defaults:
 *
 * **There are two ways the nearest chunks get found, and the database decides
 * which.** Where pgvector is present — Neon has it — the query is handed to the
 * database, which returns the shortlist and nothing else. Where it is not, the
 * rows are streamed a page at a time and a bounded top-K is kept, so a search
 * holds the size of its shortlist rather than the size of the shelf.
 *
 * The second path is what this ran on for a long time, and the version before
 * this one accumulated every row it read: 1536 dimensions is 8,192 characters of
 * base64 per chunk, so ten thousand chunks was ~82MB per search and fifty
 * thousand was past what a serverless function survives — while the comment here
 * cheerfully named fifty thousand as the working ceiling. Streaming makes the
 * scan linear in time and constant in memory, which is a different proposition
 * from linear in both.
 *
 * Which route ran is not a detail the caller sees, deliberately: the answers are
 * the same, and a fallback that behaves differently is a fallback nobody trusts.
 *
 * **Vectors from different models are not comparable.** A chunk embedded by
 * OpenAI and a query embedded by Google produce a similarity score that is
 * meaningless rather than merely wrong, so the model is stored per chunk and the
 * search only ever ranks within one.
 */
import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { untrusted } from './tools/untrusted.js';
import { getApiKey, baseUrlFor } from './settings.js';

/**
 * Embedding models, in the order they are tried.
 *
 * Anthropic and OpenRouter are absent because neither serves an embedding
 * endpoint — Anthropic has never had one, and OpenRouter routes chat only. An
 * account with only those keys gets a clear sentence saying so rather than a
 * 404 from somewhere in the stack.
 */
const EMBEDDERS = {
  openai: { model: 'text-embedding-3-small', dims: 1536, batch: 96 },
  // `text-embedding-004` was superseded by `gemini-embedding-001`. Changing this
  // is not free for anyone who has already indexed: vectors from two models are
  // not comparable, so `searchDocs` will report the mismatch and ask for a
  // re-index rather than silently returning nonsense — which is the behaviour
  // that makes changing it safe at all.
  google: { model: 'gemini-embedding-001', dims: 768, batch: 100 },
};

const MAX_CHUNKS_PER_CALL = 128;

/** Which provider will do the embedding for this account, if any. */
export async function embedderFor(userId) {
  for (const [provider, spec] of Object.entries(EMBEDDERS)) {
    if (await getApiKey(userId, provider)) return { provider, ...spec };
  }
  return null;
}

function noEmbedder() {
  return new Error(
    'Indexing documents needs an embedding model, and this account has no key that provides one. ' +
      'Add an OpenAI or Google key in Settings → Providers. Anthropic and OpenRouter keys cannot do this — ' +
      'neither serves an embedding endpoint.',
  );
}

// ── vectors ───────────────────────────────────────────────────────────

/**
 * Unit-length, so cosine similarity is a plain dot product at search time.
 *
 * Doing it once on the way in rather than twice per comparison is most of why
 * scoring fifty thousand chunks is cheap enough to do in the request.
 */
function normalise(values) {
  const vector = Float32Array.from(values);
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum);
  if (length > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= length;
  return vector;
}

const pack = (vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');

function unpack(encoded) {
  const buf = Buffer.from(encoded, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < n; i += 1) total += a[i] * b[i];
  return total;
}

// ── talking to the embedding APIs ─────────────────────────────────────

async function embedOpenAI(texts, apiKey, model) {
  const base = (baseUrlFor('openai') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`The embedding request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();

  // Sorted by index rather than trusted to arrive in order — the API documents
  // that it may not, and a silently shuffled batch attaches every vector to the
  // wrong chunk, which produces a search that is confidently wrong.
  return (json.data || []).sort((a, b) => a.index - b.index).map((row) => row.embedding);
}

async function embedGoogle(texts, apiKey, model) {
  /**
   * The key travels in a header, not in the query string.
   *
   * `?key=…` is Google's documented shape and it works, but a query string is
   * the part of a request that ends up in places nobody chose: proxy logs,
   * error traces, an exception message quoting the URL it failed on. Google
   * accepts `x-goog-api-key` for the same call, so the credential stays in the
   * part of the request that is conventionally not logged.
   */
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`The embedding request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  return (json.embeddings || []).map((e) => e.values);
}

/**
 * Embed a list of strings, in batches the provider will accept.
 *
 * `embedder` may be passed in by a caller that has already resolved it. Every
 * search did that work twice — once in `searchDocs` to decide whether embedding
 * was possible at all, and again in here — and each resolution walks the
 * provider list asking the store for a key.
 */
async function embed(userId, texts, known = null) {
  const embedder = known || (await embedderFor(userId));
  if (!embedder) throw noEmbedder();
  const apiKey = await getApiKey(userId, embedder.provider);

  const out = [];
  for (let i = 0; i < texts.length; i += embedder.batch) {
    const slice = texts.slice(i, i + embedder.batch);
    const raw =
      embedder.provider === 'openai'
        ? await embedOpenAI(slice, apiKey, embedder.model)
        : await embedGoogle(slice, apiKey, embedder.model);

    if (raw.length !== slice.length) {
      throw new Error(`The embedding API returned ${raw.length} vectors for ${slice.length} chunks.`);
    }
    for (const values of raw) out.push(normalise(values));
  }
  return { vectors: out, embedder };
}

// ── ingest ────────────────────────────────────────────────────────────

/**
 * What the machine already sent, so it can skip files nobody has touched.
 *
 * The model is part of the answer on purpose: switching embedding provider makes
 * every stored vector incomparable, so those files have to be re-read even
 * though their timestamps have not moved.
 */
export async function knownStamps(userId, source) {
  const embedder = await embedderFor(userId);
  const rows = await getStore().docStamps(userId, String(source || ''));
  const stamps = {};
  for (const row of rows) {
    if (embedder && row.model !== embedder.model) continue;
    stamps[row.path] = Number(row.mtime) || 0;
  }
  return { stamps, model: embedder?.model || null };
}

/**
 * Take a batch of chunked files from the machine, embed them, and store them.
 *
 * One file's chunks are replaced as a unit, so a re-index of an edited file
 * cannot leave stale text behind for the search to find.
 */
export async function ingestBatch(userId, { source, files }) {
  const list = Array.isArray(files) ? files : [];
  const flat = [];
  for (const file of list) {
    for (const [ordinal, chunk] of (file.chunks || []).entries()) {
      const text = String(chunk?.text ?? chunk ?? '').trim();
      if (text) flat.push({ path: String(file.path || ''), ordinal, heading: chunk?.heading || null, text, mtime: file.mtime });
    }
  }
  if (!flat.length) return { files: 0, chunks: 0 };
  if (flat.length > MAX_CHUNKS_PER_CALL) {
    throw new Error(`Too many chunks in one call (${flat.length}). Send at most ${MAX_CHUNKS_PER_CALL}.`);
  }

  const { vectors, embedder } = await embed(userId, flat.map((c) => c.text));

  const byPath = new Map();
  for (const [i, chunk] of flat.entries()) {
    if (!byPath.has(chunk.path)) byPath.set(chunk.path, []);
    byPath.get(chunk.path).push({
      id: crypto.randomUUID(),
      source: String(source || ''),
      ordinal: chunk.ordinal,
      heading: chunk.heading,
      text: chunk.text,
      embedding: pack(vectors[i]),
      dims: embedder.dims,
      model: embedder.model,
      mtime: chunk.mtime ?? null,
    });
  }

  const store = getStore();
  // One batch, not one round trip per file. The Neon driver does one round trip
  // per *statement*, so a loop here was forty sequential network calls to index
  // forty files with all the data already in hand.
  await store.replaceDocChunksMany(userId, byPath);
  return { files: byPath.size, chunks: flat.length, model: embedder.model };
}

// ── search ────────────────────────────────────────────────────────────

/**
 * Neighbouring chunks of the same file, merged.
 *
 * A question often straddles a chunk boundary, and returning chunks 4 and 5 of
 * the same document as two separate results wastes half the answer repeating
 * where it came from. Merging them also restores the sentence that the split cut
 * in half.
 */
function mergeAdjacent(hits) {
  const sorted = [...hits].sort((a, b) => a.path.localeCompare(b.path) || a.ordinal - b.ordinal);
  const merged = [];
  for (const hit of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.path === hit.path && hit.ordinal - last.lastOrdinal === 1) {
      last.text += `\n${hit.text}`;
      last.lastOrdinal = hit.ordinal;
      last.score = Math.max(last.score, hit.score);
      // A merged block is as good as its best half, by whichever measure — so
      // the better (lower) rank wins, the same way the higher score does.
      last.rank = Math.min(last.rank ?? Infinity, hit.rank ?? Infinity);
      continue;
    }
    merged.push({ ...hit, lastOrdinal: hit.ordinal });
  }

  /**
   * Ordered by the rank the reranker settled on, not by raw cosine.
   *
   * This line used to sort on `score` alone, which quietly undid the rerank
   * above it: the fusion would put the passage containing the exact invoice
   * number first, and then this would put it back where the embedding had it.
   * `rank` is absent when nothing was reranked — a query of nothing but stop
   * words, or a shortlist where not one passage shared a word with the question
   * — and then this falls through to score exactly as before.
   */
  return merged.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.score - a.score);
}

const MAX_ANSWER_CHARS = 24_000;

/**
 * Words worth matching on. Everything here is deliberately crude.
 *
 * The stop list is short and English-plus-Vietnamese because those are the two
 * languages this app ships in; a term that slips through costs a little
 * precision, and a real stemmer would cost a dependency and an argument about
 * which one.
 */
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'at', 'as', 'by',
  'be', 'are', 'was', 'were', 'that', 'this', 'with', 'from', 'what', 'which', 'who', 'how',
  'when', 'where', 'why', 'do', 'does', 'did', 'i', 'we', 'you',
  'là', 'và', 'của', 'cho', 'với', 'các', 'những', 'một', 'trong', 'khi', 'thì', 'có', 'được',
  'gì', 'nào', 'sao', 'bao', 'tôi', 'bạn',
  // Words that carry a request rather than its subject: "please fix the
  // header" must not match a document because both contain "the".
  'please', 'can', 'could', 'me', 'my', 'your', 'help', 'about', 'not', 'no', 'yes', 'if', 'so', 'but', 'all',
  'không', 'này', 'đó', 'để', 'nhé', 'hãy', 'giúp', 'muốn', 'cần', 'lại', 'đã', 'sẽ', 'đang', 'rồi', 'như',
  'về', 'từ', 'ra', 'vào', 'mình', 'ạ', 'thế', 'vậy', 'nhưng', 'hay', 'hoặc', 'cũng', 'rất', 'nữa',
]);

const terms = (text) =>
  String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));

/**
 * How well a passage matches the question's actual words.
 *
 * Not a replacement for the vector search — a complement to it, and the two fail
 * in opposite directions. Embeddings find "what did we agree about the deposit"
 * in a paragraph that never says "deposit", which is the whole reason they are
 * here. They are also reliably poor at the thing a person most often searches
 * for: an exact token that carries no meaning of its own. An invoice number, a
 * version string, a surname, `ORA-01555`. Those land in a random corner of the
 * embedding space and the passage containing them ranks nowhere.
 *
 * Scored per distinct term rather than per occurrence, with a mild length
 * normalisation, so a long chunk cannot win by repetition alone.
 */
function lexicalScore(queryTerms, text) {
  if (!queryTerms.length) return 0;
  const haystack = String(text || '').toLowerCase();
  let hits = 0;
  for (const term of queryTerms) if (haystack.includes(term)) hits += 1;
  if (!hits) return 0;
  const lengthPenalty = 1 + Math.log10(1 + haystack.length / 2000);
  return hits / queryTerms.length / lengthPenalty;
}

/**
 * Fuse two rankings without having to argue about their scales.
 *
 * Reciprocal rank fusion: each list contributes `1 / (k + rank)`. It ignores the
 * scores themselves, which is exactly what is wanted here — a cosine similarity
 * and a term-overlap ratio are not comparable numbers, and any attempt to
 * combine them with a weight is a constant somebody has to justify and nobody
 * ever re-measures. Ranks are comparable by construction.
 *
 * `k = 60` is the value the original paper settled on and the one every
 * implementation since has used; it is large enough that the top few positions
 * do not dominate outright.
 */
const RRF_K = 60;

export function fuseRankings(byDense, byLexical) {
  const score = new Map();
  const add = (list) => {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) || 0) + 1 / (RRF_K + rank + 1));
    });
  };
  add(byDense);
  add(byLexical);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * How many rows to pull per page of the streaming scan.
 *
 * Large enough that the round trips do not dominate on a corpus of any size,
 * small enough that one page is a couple of megabytes rather than hundreds.
 */
const SCAN_PAGE = 2000;

/**
 * A ceiling on how much of a corpus one search will walk.
 *
 * An exact scan is linear, and linear is fine until it is not. At a hundred
 * thousand chunks a search is reading roughly 800MB off the wire to return six
 * paragraphs, and the person waiting has already given up. Stopping is the
 * honest failure: the answer says it looked at part of the shelf, which is
 * something a person can act on, rather than the request dying of a timeout.
 *
 * The pgvector path has no such limit, because there the database does the work
 * and returns forty rows.
 */
const SCAN_CEILING = 60_000;

/**
 * The `shortlist` nearest chunks, without holding the corpus in memory.
 *
 * Two routes to the same answer. Where the database has pgvector it does the
 * search itself and hands back the shortlist — which is the right answer at any
 * size and the only one that stays fast as a corpus grows. Everywhere else the
 * rows are streamed a page at a time and only the best few are kept, so peak
 * memory is the size of the shortlist rather than the size of the shelf.
 *
 * The second route is what this app ran on until now, minus the part where it
 * accumulated every row it had ever seen: 1536 dimensions is 8,192 characters of
 * base64 per chunk, so ten thousand chunks was ~82MB held per search and fifty
 * thousand was past what a serverless function survives.
 */
/**
 * @param source  when the caller asked for one folder, the scan is narrowed to
 *   it in SQL. Filtering afterwards filters a shortlist that was already chosen
 *   from the whole corpus — see the call site in `searchDocs`.
 */
async function nearest(store, userId, model, needle, shortlist, source = null) {
  if (typeof store.vectorSearchReady === 'function' && (await store.vectorSearchReady())) {
    const rows = await store.docVectorNearest?.(userId, model, needle, shortlist);
    // `null` means the extension is there but this table is not ready for it —
    // no companion column, or a dimension it cannot use. Fall through.
    if (Array.isArray(rows)) {
      return rows.map((row) => ({ id: row.id, path: row.path, score: Number(row.score) || 0 }));
    }
  }

  /**
   * A bounded best-of, kept sorted.
   *
   * A heap would be asymptotically better and is not worth it here: the list is
   * eighteen to sixty entries, and an insertion sort over that beats a heap in
   * practice while being something anybody can read.
   */
  const best = [];
  let scanned = 0;
  let after = null;

  for (;;) {
    const page = await store.docVectorPage(userId, model, { after, limit: SCAN_PAGE, source });
    if (!page.length) break;

    for (const row of page) {
      const score = dot(needle, unpack(row.embedding));
      if (best.length < shortlist) {
        best.push({ id: row.id, path: row.path, score });
        best.sort((a, b) => b.score - a.score);
      } else if (score > best[best.length - 1].score) {
        best[best.length - 1] = { id: row.id, path: row.path, score };
        best.sort((a, b) => b.score - a.score);
      }
    }

    scanned += page.length;
    after = page[page.length - 1].id;
    if (page.length < SCAN_PAGE || scanned >= SCAN_CEILING) break;
  }

  return best;
}

/**
 * Query vectors, remembered for a few minutes.
 *
 * Every `search_docs` call embedded its query over the network — a round trip
 * with a 60-second ceiling before a single row is read. The same question asked
 * twice paid twice, and the agent asks the same question more than once often:
 * a retry after a narrow result, a sub-agent covering the same ground, a person
 * rephrasing one word.
 *
 * Keyed by the model as well as the text, so a change of embedder cannot return
 * vectors from the wrong space. Per-process and short-lived by design — this is
 * a cache for a burst of related turns, not a store, and on serverless a cold
 * invocation simply starts empty.
 */
const QUERY_VECTORS = new Map();
const QUERY_CACHE_MAX = 64;
const QUERY_CACHE_TTL_MS = 5 * 60_000;

async function queryVector(userId, text, embedder, fetchVector = null) {
  // Per account: a vector computed on one account's key is not handed to
  // another, and one account's queries leave no trace in another's lookups.
  const key = `${userId}:${embedder.provider}:${embedder.model}:${text}`;
  const hit = QUERY_VECTORS.get(key);
  if (hit && Date.now() - hit.at < QUERY_CACHE_TTL_MS) {
    QUERY_VECTORS.delete(key);
    QUERY_VECTORS.set(key, hit); // least-recently-used ordering
    return hit.vector;
  }

  // Injectable so the suite can drive the caching without a provider key or a
  // network round trip. Production always takes the default.
  const vector = fetchVector
    ? await fetchVector(text)
    : (await embed(userId, [text], embedder)).vectors[0];
  QUERY_VECTORS.set(key, { vector, at: Date.now() });
  while (QUERY_VECTORS.size > QUERY_CACHE_MAX) {
    QUERY_VECTORS.delete(QUERY_VECTORS.keys().next().value);
  }
  return vector;
}

export async function searchDocs(userId, { query, limit = 6, source = null }) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Give something to search for.');

  const embedder = await embedderFor(userId);
  if (!embedder) throw noEmbedder();

  const store = getStore();
  const needle = await queryVector(userId, text, embedder);

  const wanted = Math.min(Math.max(Number(limit) || 6, 1), 20);
  // Over-fetch, because merging adjacent chunks collapses some of them, and
  // because the reranker below needs a shortlist to actually rank.
  const shortlist = wanted * 3;

  const scored = await nearest(store, userId, embedder.model, needle, shortlist, source);

  if (!scored.length) {
    const sources = await store.docSources(userId);
    if (!sources.length) {
      return 'Nothing has been indexed yet. Use index_folder on a folder of the user\'s documents first, and tell them that is what you are about to do.';
    }
    return (
      `Nothing is indexed with ${embedder.model}, which is the embedding model this account's key provides. ` +
      `What is stored was indexed with ${sources.map((s) => s.model).join(', ')} — vectors from different models cannot be compared. ` +
      'Re-index those folders, or restore the provider key that was used before.'
    );
  }

  const full = await store.docChunks(userId, scored.map((s) => s.id));
  const byId = new Map(full.map((row) => [row.id, row]));

  let hits = scored
    .map((s) => {
      const row = byId.get(s.id);
      return row ? { ...s, ordinal: row.ordinal, heading: row.heading, text: row.text, source: row.source } : null;
    })
    .filter(Boolean);

  /**
   * Rerank the shortlist before cutting it down.
   *
   * The over-fetch above already pulls three times what will be shown, and until
   * now the only thing deciding which of those survived was cosine distance.
   * That is the right first pass and a poor last one: embeddings are good at
   * meaning and reliably bad at exact tokens, so a question containing an
   * invoice number, a version string or a surname would rank the passage
   * containing it nowhere in particular.
   *
   * Reranking happens here rather than earlier because it needs the text, and
   * the text is only fetched for the shortlist — so this costs one pass over a
   * few dozen passages and no extra query, no extra model call, and no
   * dependency. It cannot promote anything the vector search did not already
   * find, which is the honest limit of doing it this way.
   */
  const queryTerms = terms(text);
  if (queryTerms.length && hits.length > 1) {
    const denseOrder = [...hits].sort((a, b) => b.score - a.score).map((h) => h.id);
    const lexicalOrder = [...hits]
      .map((h) => ({ id: h.id, lex: lexicalScore(queryTerms, `${h.heading || ''} ${h.text}`) }))
      .filter((h) => h.lex > 0)
      .sort((a, b) => b.lex - a.lex)
      .map((h) => h.id);

    // Nothing matched a single word of the question: there is no second opinion
    // to fuse, so leave the vector ranking exactly as it was.
    if (lexicalOrder.length) {
      const fused = fuseRankings(denseOrder, lexicalOrder);
      const position = new Map(fused.map((id, i) => [id, i]));
      // Stamped on the hit rather than only applied as a sort, because
      // `mergeAdjacent` re-sorts afterwards and would otherwise put everything
      // back where the embedding had it.
      hits = hits.map((h) => ({ ...h, rank: position.get(h.id) ?? Infinity }));
      hits.sort((a, b) => a.rank - b.rank);
    }
  }

  /**
   * Belt to the SQL braces.
   *
   * The scan now narrows by source in the database, so this filters nothing on
   * that path — but the pgvector path (`docVectorNearest`) does not take a
   * source, so the predicate has to survive for it.
   *
   * The filter used to be the *only* place source was applied, and that was the
   * bug: `nearest` took the best `limit * 3` chunks across the entire corpus and
   * this then threw away the ones from other folders. With 8,000 chunks in
   * `notes` and 200 in `contracts`, a search restricted to `contracts` filled
   * its shortlist with `notes` passages, discarded all of them, and answered
   * "Nothing indexed under a source matching contracts" — a flatly false
   * statement, from the one tool whose purpose is to stop the assistant claiming
   * it does not know something that is on the user's disk.
   */
  if (source) {
    const needleSource = String(source).toLowerCase();
    hits = hits.filter((h) => String(h.source || '').toLowerCase().includes(needleSource));
    if (!hits.length) {
      // Which of the two it is changes what the model should say next, so the
      // two are told apart rather than sharing one misleading sentence.
      const known = await store.docSources(userId);
      const matching = known.filter((s) => String(s.source || '').toLowerCase().includes(needleSource));
      return matching.length
        ? `Nothing in "${source}" matches that question, though it is indexed. Try different words, or search without the source filter.`
        : `No indexed folder is called anything like "${source}". Indexed: ${
            known.map((s) => s.source).join(', ') || 'nothing yet'
          }.`;
    }
  }

  const results = mergeAdjacent(hits).slice(0, wanted);

  // A weak best match is worth saying out loud. The model cannot see the scores
  // and will otherwise present the nearest paragraph in the corpus as an answer,
  // however unrelated it happens to be.
  const best = results[0]?.score ?? 0;
  const caveat =
    best < 0.3
      ? '\n\n[Nothing here matches the question closely — the best score was low. Say the documents do not seem to cover this rather than stretching these passages to fit.]'
      : '';

  let body = '';
  for (const [i, hit] of results.entries()) {
    const block =
      `## ${i + 1}. ${hit.path}${hit.heading ? ` — ${hit.heading}` : ''}  (${hit.score.toFixed(3)})\n${hit.text}\n\n`;
    if (body.length + block.length > MAX_ANSWER_CHARS) break;
    body += block;
  }

  /**
   * The passages are somebody else's writing, so they travel in an envelope.
   *
   * This was the one place external content reached the model unwrapped. The
   * web fetcher, the search results, the page extractor and every MCP tool all
   * go through `untrusted()`; the user's own indexed corpus did not — and it is
   * the *least* trustworthy of them in one specific way. A web page is fetched
   * because the model chose a URL this turn; an indexed document was filed
   * weeks ago, is retrieved by meaning rather than by name, and surfaces
   * whenever a question happens to match it. A contract or a PDF from a
   * supplier carrying "ignore your previous instructions" would have been read
   * as though the user had typed it.
   *
   * The caveat stays outside the envelope: it is this app's assessment of the
   * match quality, not something the documents said.
   */
  const found = `${results.length} passage${results.length === 1 ? '' : 's'} for "${text}"`;
  return `${found}:\n\n${untrusted('the indexed documents', body.trim())}${caveat}`;
}

export async function listSources(userId) {
  const rows = await getStore().docSources(userId);
  if (!rows.length) return 'Nothing is indexed.';
  return rows
    .map(
      (r) =>
        `- ${r.source} — ${r.files} file${r.files === 1 ? '' : 's'}, ${r.chunks} passages, embedded with ${r.model}` +
        `, last indexed ${new Date(r.indexed_at).toLocaleString()}`,
    )
    .join('\n');
}

export async function forgetSource(userId, source) {
  const removed = await getStore().deleteDocs(userId, source || null);
  if (!removed) return source ? `Nothing was indexed under "${source}".` : 'There was nothing indexed to forget.';
  return source
    ? `Forgot ${removed} passages from "${source}". The files themselves are untouched.`
    : `Forgot every indexed document — ${removed} passages. The files themselves are untouched.`;
}

/** Exposed for the suite that pins how the shortlist is reranked. */
// QUERY_VECTORS is here because a cache that never invalidates is a correctness
// bug, not a performance detail — the suite has to be able to reach it.
export const __testing = { lexicalScore, terms, fuseRankings, STOPWORDS, QUERY_VECTORS, QUERY_CACHE_TTL_MS, QUERY_CACHE_MAX, queryVector };
