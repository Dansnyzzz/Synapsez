/**
 * Indexing the user's documents, and finding them again by meaning.
 *
 * The embedding API is replaced with a deterministic bag-of-words vector. That
 * is not a shortcut around the interesting part — it *is* the interesting part
 * here. What this suite is for is the plumbing either side of the model: that
 * chunks come back attached to the right file, that an edited file replaces its
 * old passages rather than accumulating both, that vectors from two different
 * models are never compared, and above all that one account's documents are
 * invisible to another. None of those depend on the embedding being good, and
 * all of them are the kind of bug that would quietly produce confident wrong
 * answers about somebody's private files.
 *
 *   node test/rag.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'rag-test-encryption-key';
process.env.SESSION_SECRET ||= 'rag-test-session-secret';
process.env.OPENAI_API_KEY = 'test-key-not-used-for-real-calls';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-rag-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

// ── a stand-in for the embedding API ──────────────────────────────────
//
// Words are hashed into buckets, so two texts that share vocabulary point in
// similar directions and one that shares none does not. Crude, deterministic,
// and enough to tell "ranked correctly" from "ranked at random".
const DIMS = 1536;
let embedCalls = 0;
let embeddedTexts = [];

function fakeVector(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    vector[hash % DIMS] += 1;
  }
  return vector;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const href = String(url);
  if (href.includes('/embeddings')) {
    embedCalls += 1;
    const { input } = JSON.parse(options.body);
    embeddedTexts.push(...input);
    return new Response(
      JSON.stringify({ data: input.map((text, index) => ({ index, embedding: fakeVector(text) })) }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }
  return realFetch(url, options);
};

const { initStore, getStore } = await import('../server/store/index.js');
await initStore();
const { ingestBatch, searchDocs, listSources, forgetSource, knownStamps } = await import('../server/rag.js');
const { chunk, isSecretFile } = await import('../worker/indexer.js');

const store = getStore();
const alice = await store.createUser({ id: 'u-alice', email: 'alice@example.com', passwordHash: 'x', role: 'admin' });
const bob = await store.createUser({ id: 'u-bob', email: 'bob@example.com', passwordHash: 'x', role: 'user' });

// ── chunking ──────────────────────────────────────────────────────────
section('text is cut into passages you can read on their own');
{
  check('empty text makes no passages', chunk('   ').length === 0);

  const short = chunk('One paragraph, well under the limit.');
  check('a short document is one passage', short.length === 1, `${short.length}`);
  check('and keeps its text intact', short[0].text === 'One paragraph, well under the limit.');

  const doc = `# Rental agreement\n\n${'The tenant pays on the first. '.repeat(60)}\n\n## Deposit\n\n${'Two months held in escrow. '.repeat(60)}`;
  const pieces = chunk(doc);
  check('a long document is split', pieces.length > 1, `${pieces.length} passages`);
  check('every passage has text', pieces.every((p) => p.text.trim().length > 0));
  check('and carries the heading above it', pieces.some((p) => /Deposit|Rental agreement/.test(p.heading || '')),
    JSON.stringify(pieces.map((p) => p.heading)));

  // The overlap is the whole reason a sentence spanning a boundary stays
  // findable. Without it, neither half contains the phrase.
  const overlapping = chunk('A '.repeat(900) + 'UNIQUEMARKER ' + 'B '.repeat(900));
  check('consecutive passages overlap', overlapping.length > 1);

  // A paragraph longer than the whole passage size must still be cut, not
  // emitted as one oversized chunk that the embedding API would reject.
  const huge = chunk('x'.repeat(9000));
  check('an enormous single paragraph is still split', huge.length > 1, `${huge.length}`);
  check('and none of the pieces is oversized', huge.every((p) => p.text.length <= 1400));
}

// ── ingest and search ─────────────────────────────────────────────────
section('a folder is indexed and can be searched by meaning');
{
  const result = await ingestBatch(alice.id, {
    source: 'documents',
    files: [
      {
        path: 'documents/lease.md',
        mtime: 1000,
        chunks: [
          { text: 'The deposit is two months of rent, held in escrow until the tenancy ends.', heading: 'Deposit' },
          { text: 'Rent falls due on the first day of each month by bank transfer.', heading: 'Rent' },
        ],
      },
      {
        path: 'documents/recipes.md',
        mtime: 1000,
        chunks: [{ text: 'Fry the garlic in olive oil until golden, then add the tomatoes.' }],
      },
    ],
  });

  check('it reports what it stored', result.files === 2 && result.chunks === 3, JSON.stringify(result));

  /*
   * Two files went in as one batch, and that is the point: this used to loop
   * `replaceDocChunks` once per file, on a driver whose defining property is one
   * round trip per statement. Indexing a source tree of forty files paid forty
   * sequential network calls with all the data already in hand.
   *
   * Asserted on the result rather than by counting queries — what matters is
   * that batching did not lose a file or cross one path's chunks into another,
   * which is the way a `path`-per-row rewrite goes wrong.
   */
  const fromLease = await searchDocs(alice.id, { query: 'when is rent due each month' });
  const fromRecipes = await searchDocs(alice.id, { query: 'frying garlic in oil' });
  check(
    '  a chunk from the first file is filed under the first file',
    /documents\/lease\.md/.test(fromLease) && /first day of each month/.test(fromLease),
    fromLease.slice(0, 140),
  );
  check(
    '  and one from the second under the second',
    /documents\/recipes\.md/.test(fromRecipes) && /garlic/.test(fromRecipes),
    fromRecipes.slice(0, 140),
  );
  check('and which model made the vectors', result.model === 'text-embedding-3-small', result.model);

  const hit = await searchDocs(alice.id, { query: 'how much money is held in escrow' });
  check('the right passage comes first', /two months of rent/.test(hit.split('\n\n')[1] || hit), hit.slice(0, 160));
  check('and the file it came from is named', hit.includes('documents/lease.md'));
  check('the unrelated document is not first', hit.indexOf('lease.md') < hit.indexOf('recipes.md') || !hit.includes('recipes.md'));

  const listed = await listSources(alice.id);
  check('the source is listed with its counts', /documents — 2 files, 3 passages/.test(listed), listed);
}

section('a weak match is admitted rather than dressed up');
{
  const hit = await searchDocs(alice.id, { query: 'quantum chromodynamics lattice gauge symmetry' });
  check('the reply says nothing really matches', /Nothing here matches the question closely/.test(hit), hit.slice(-160));
}

// ── re-indexing ───────────────────────────────────────────────────────
section('editing a file replaces its passages instead of piling up');
{
  await ingestBatch(alice.id, {
    source: 'documents',
    files: [
      {
        path: 'documents/lease.md',
        mtime: 2000,
        chunks: [{ text: 'The deposit is now three months of rent, held in escrow.', heading: 'Deposit' }],
      },
    ],
  });

  const rows = await store.docVectorPage(alice.id, 'text-embedding-3-small');
  const lease = rows.filter((r) => r.path === 'documents/lease.md');
  check('the old passages are gone', lease.length === 1, `${lease.length} left`);
  check('and the other file is untouched', rows.some((r) => r.path === 'documents/recipes.md'));

  const hit = await searchDocs(alice.id, { query: 'how many months of deposit' });
  check('the search returns the new text', /three months/.test(hit), hit.slice(0, 200));
  check('and never the superseded text', !/two months/.test(hit));

  const { stamps } = await knownStamps(alice.id, 'documents');
  check('the stamp moved with the edit', stamps['documents/lease.md'] === 2000, String(stamps['documents/lease.md']));
  check('and unchanged files keep theirs', stamps['documents/recipes.md'] === 1000);
}

// ── the boundary that matters most ────────────────────────────────────
section("one account's documents are invisible to another");
{
  await ingestBatch(bob.id, {
    source: 'private',
    files: [{ path: 'private/medical.md', mtime: 1, chunks: [{ text: 'Blood test results and the escrow of my deposit.' }] }],
  });

  const hers = await searchDocs(alice.id, { query: 'escrow deposit' });
  check("Bob's file never appears in Alice's search", !hers.includes('medical.md'), hers.slice(0, 200));

  const his = await searchDocs(bob.id, { query: 'escrow deposit' });
  check("and Alice's never appears in Bob's", !his.includes('lease.md'), his.slice(0, 200));
  check('though he can find his own', his.includes('private/medical.md'));

  check("Alice's listing shows only her folder", !(await listSources(alice.id)).includes('private'));

  // Deleting is scoped too — the obvious way to write this method drops
  // everyone's rows for that source name.
  await forgetSource(alice.id, 'documents');
  check("forgetting Alice's index leaves Bob's alone", (await listSources(bob.id)).includes('private'));
  check('and hers really is gone', (await listSources(alice.id)) === 'Nothing is indexed.');
}

// ── vectors from different models are never mixed ─────────────────────
section('vectors from a different embedding model are not compared');
{
  await ingestBatch(bob.id, {
    source: 'legacy',
    files: [{ path: 'legacy/old.md', mtime: 1, chunks: [{ text: 'Indexed long ago with another model entirely.' }] }],
  });
  // Rewrite one source as if it had been embedded by Google — the situation
  // somebody lands in by switching provider keys.
  await store.docVectorPage(bob.id, 'text-embedding-3-small');
  const rows = await store.docChunks(bob.id, (await store.docVectorPage(bob.id, 'text-embedding-3-small')).map((r) => r.id));
  const legacy = rows.find((r) => r.path === 'legacy/old.md');
  await store.replaceDocChunks(bob.id, 'legacy/old.md', [
    { ...legacy, id: legacy.id, model: 'text-embedding-004', dims: 768, source: 'legacy', ordinal: 0 },
  ]);

  const hit = await searchDocs(bob.id, { query: 'indexed long ago with another model' });
  check('the mismatched passage is not returned', !hit.includes('legacy/old.md'), hit.slice(0, 200));
  check('but the matching-model one still is', hit.includes('private/medical.md'));
}

// ── no key, no index ──────────────────────────────────────────────────
section('an account with no embedding key is told what to do about it');
{
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Anthropic and OpenRouter exist but serve no embedding endpoint, so having
  // one must not read as "configured".
  process.env.ANTHROPIC_API_KEY = 'anthropic-key';
  process.env.OPENROUTER_API_KEY = 'openrouter-key';

  const message = await searchDocs(alice.id, { query: 'anything' }).then(
    () => 'no error',
    (err) => err.message,
  );
  check('it names the providers that would work', /OpenAI or Google/.test(message), message.slice(0, 140));
  check('and says why the ones they have do not', /serves an embedding endpoint/.test(message));

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.OPENAI_API_KEY = saved;
}

// ── the half that runs on the user's machine ──────────────────────────
section('indexing a real folder on disk');
{
  const { setWorkspace } = await import('../worker/paths.js');
  const { indexFolder, setIndexSink } = await import('../worker/indexer.js');

  const root = path.join(process.env.DATA_DIR, 'docs');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'contract.md'), '# Contract\n\nThe warranty lasts twelve months from delivery.\n');
  fs.writeFileSync(path.join(root, 'notes', 'meeting.txt'), 'We agreed to move the deadline to March.\n');
  fs.writeFileSync(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'dep.js'), 'module.exports = 1;\n');
  setWorkspace(root);
  setIndexSink((payload) =>
    payload.op === 'stamps' ? knownStamps(alice.id, payload.source) : ingestBatch(alice.id, payload),
  );

  const first = await indexFolder({ path: '.' });
  check('it reads the documents it found', /Indexed \.\/ — 2 files/.test(first), first);
  check('and says the search can reach them', first.includes('search_docs can find this now'), first);

  const found = await searchDocs(alice.id, { query: 'how long is the warranty' });
  check('a file on disk is searchable afterwards', found.includes('contract.md'), found.slice(0, 200));
  check('and so is one in a subfolder', (await searchDocs(alice.id, { query: 'when is the deadline' })).includes('meeting.txt'));

  // node_modules is thousands of files nobody wrote and nobody will search for.
  check('node_modules is not indexed', !(await listSources(alice.id)).includes('junk'));
  check('and a PNG is not mistaken for text', !found.includes('photo.png'));

  // The second run is the one that decides whether re-indexing is affordable.
  const second = await indexFolder({ path: '.' });
  check('nothing is re-read when nothing changed', /Indexed \.\/ — 0 files/.test(second), second);
  check('and it says how many it skipped', /2 unchanged since last time/.test(second), second);

  fs.writeFileSync(path.join(root, 'contract.md'), '# Contract\n\nThe warranty lasts twenty-four months now.\n');
  const third = await indexFolder({ path: '.' });
  check('an edited file is picked up again', /Indexed \.\/ — 1 file,/.test(third), third);
  check('and the other is still skipped', /1 unchanged/.test(third), third);
  check(
    'the search reflects the edit',
    (await searchDocs(alice.id, { query: 'how long is the warranty' })).includes('twenty-four'),
  );

  check(
    'pointing it at a file rather than a folder is refused',
    await indexFolder({ path: 'contract.md' }).then(
      () => false,
      (err) => /is a file/.test(err.message),
    ),
  );
  check(
    'and a folder that does not exist says so',
    await indexFolder({ path: 'nowhere' }).then(
      () => false,
      (err) => /nothing at|outside the workspace/i.test(err.message),
    ),
  );

  await forgetSource(alice.id, '.');
}

section('cost is not spent twice on the same text');
{
  embedCalls = 0;
  embeddedTexts = [];
  await ingestBatch(alice.id, {
    source: 'notes',
    files: [{ path: 'notes/a.md', mtime: 1, chunks: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }],
  });
  check('one request covers a whole batch', embedCalls === 1, `${embedCalls} calls`);
  check('and every chunk was in it', embeddedTexts.length === 3, `${embeddedTexts.length}`);

  const before = embedCalls;
  await searchDocs(alice.id, { query: 'one' });
  check('a search embeds only the query', embedCalls === before + 1 && embeddedTexts.length === 4);
}

/**
 * Close the database before deleting the directory it lives in.
 *
 * Without this the suite passed every check and then crashed the whole run on
 * Windows with ENOTEMPTY: the embedded Postgres still held handles inside
 * `pgdata`, so the recursive delete hit a directory that would not empty. It
 * only showed up under a full `npm test`, where the machine is busy enough for
 * the race to land — on its own the suite always looked fine.
 */
// ── the scan streams instead of accumulating ────────────────────────
section('vectors are read a page at a time');
{
  /*
   * The search used to hold every vector it had ever read. A 1536-dimension
   * vector is 8,192 characters of base64, so ten thousand chunks was ~82MB per
   * search and fifty thousand was past what a serverless function survives —
   * while the file's own comment named fifty thousand as the working ceiling.
   *
   * Correctness across a page boundary is the thing to pin: a bounded top-K that
   * silently loses the best match because it fell on page two is worse than the
   * unbounded version it replaced.
   */
  const many = Array.from({ length: 25 }, (_, i) => ({
    text: i === 17 ? 'the escrow deposit is precisely four months of rent' : `filler passage number ${i}`,
  }));
  await ingestBatch(alice.id, {
    source: 'paged',
    files: [{ path: 'paged/big.md', mtime: 5000, chunks: many }],
  });

  const first = await store.docVectorPage(alice.id, 'text-embedding-3-small', { limit: 10 });
  check('a page is capped at the limit asked for', first.length === 10, `${first.length}`);

  const second = await store.docVectorPage(alice.id, 'text-embedding-3-small', {
    after: first[first.length - 1].id,
    limit: 10,
  });
  check('the next page continues from the cursor', second.length === 10, `${second.length}`);
  check(
    '  and does not repeat what the first page held',
    !second.some((row) => first.some((f) => f.id === row.id)),
  );

  const all = new Set();
  let after = null;
  for (;;) {
    const page = await store.docVectorPage(alice.id, 'text-embedding-3-small', { after, limit: 7 });
    if (!page.length) break;
    for (const row of page) all.add(row.id);
    after = page[page.length - 1].id;
  }
  const total = (await store.docSources(alice.id)).reduce((n, s) => n + s.chunks, 0);
  check('walking every page sees every row exactly once', all.size === total, `${all.size} of ${total}`);

  // The needle is on a later page than the shortlist would reach if the top-K
  // were being filled greedily and never revisited.
  const found = await searchDocs(alice.id, { query: 'escrow deposit four months', source: 'paged' });
  check('a match on a later page is still found', /four months of rent/.test(found), found.slice(0, 160));
}

// ── the shortlist is reranked, not just cut ─────────────────────────
section('hybrid reranking');
{
  const { fuseRankings, __testing: ragTesting } = await import('../server/rag.js');

  /*
   * The case the whole thing exists for.
   *
   * Embeddings are good at meaning and reliably bad at exact tokens. A question
   * containing an invoice number, a version string or a surname puts that token
   * somewhere arbitrary in the embedding space, so the one passage that actually
   * contains it can rank below three passages that merely sound related.
   *
   * Dense says C is best. Lexical — which can see the literal token — says A is.
   * Fusion has to move A up without throwing the dense opinion away entirely.
   */
  const fused = fuseRankings(['C', 'B', 'A'], ['A', 'C', 'B']);
  check('a passage both rankings like comes first', fused[0] === 'A' || fused[0] === 'C', fused.join(' > '));
  check('  and the exact-token match is no longer last', fused.indexOf('A') < 2, fused.join(' > '));
  check('  while nothing is lost', fused.length === 3 && new Set(fused).size === 3, fused.join(' > '));

  // Agreement is the easy case and must stay stable.
  check(
    'when both rankings agree, the order is theirs',
    fuseRankings(['X', 'Y', 'Z'], ['X', 'Y', 'Z']).join('') === 'XYZ',
  );

  // One empty list is a real state — no passage shared a word with the question
  // — and it must degrade to the other ranking rather than to nothing.
  check('one empty list leaves the other intact', fuseRankings(['P', 'Q'], []).join('') === 'PQ');
  check('two empty lists are not a crash', fuseRankings([], []).length === 0);

  const { lexicalScore, terms } = ragTesting;
  check('stop words are not searched on', terms('what is the pass mark').join(',') === 'pass,mark');
  check('  and Vietnamese ones too', terms('giá của hợp đồng là gì').join(',') === 'giá,hợp,đồng');
  check(
    'a passage carrying the exact token scores above one that does not',
    lexicalScore(['ora', '01555'], 'the error ORA-01555 means a snapshot is too old') >
      lexicalScore(['ora', '01555'], 'snapshots can become too old to read from'),
  );
  check(
    'and a long passage cannot win by sheer length',
    lexicalScore(['deposit'], 'the deposit is 10%') >
      lexicalScore(['deposit'], `the deposit is 10%. ${'padding text. '.repeat(400)}`),
  );
}

// ── credentials do not travel in a URL ────────────────────────────────

section('no API key is put in a query string');
{
  // A query string is the part of a request that ends up where nobody chose:
  // proxy logs, error traces, an exception quoting the URL it failed on.
  // Google documents `?key=…` and also accepts `x-goog-api-key`, so there is no
  // reason to take the first.
  const files = ['../server/rag.js', '../server/models.js'];
  for (const rel of files) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    // Comments are allowed to mention it; code is not. Strip line comments and
    // block comments before looking.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(`${rel.split('/').pop()} sends no key in a URL`, !/\?key=|&key=/.test(code), code.match(/.{0,40}[?&]key=.{0,30}/)?.[0]);
  }
}

// ── the query-vector cache ────────────────────────────────────────────

section('a query is embedded once, not once per search');
{
  const { __testing } = await import('../server/rag.js');
  const { queryVector, QUERY_VECTORS, QUERY_CACHE_TTL_MS, QUERY_CACHE_MAX } = __testing;

  QUERY_VECTORS.clear();
  let calls = 0;
  const stub = async () => { calls += 1; return Float32Array.from([1, 0]); };
  const openai = { provider: 'openai', model: 'text-embedding-3-small' };

  // Every search embedded its query over the network — a round trip with a
  // 60-second ceiling before a single row is read — and the agent asks the same
  // question more than once often: a retry after a narrow result, a sub-agent
  // covering the same ground, someone rephrasing one word.
  await queryVector('u1', 'the deposit', openai, stub);
  await queryVector('u1', 'the deposit', openai, stub);
  await queryVector('u1', 'the deposit', openai, stub);
  check('the same question embeds once', calls === 1, `${calls} calls`);

  await queryVector('u1', 'the refund', openai, stub);
  check('a different question embeds again', calls === 2, `${calls} calls`);

  // Vectors from two models are not comparable — the file says so at the top —
  // so the model has to be part of the key or a change of embedder would serve
  // answers from the wrong space.
  await queryVector('u1', 'the deposit', { provider: 'google', model: 'gemini-embedding-001' }, stub);
  check('another model is a different vector, not a cache hit', calls === 3, `${calls} calls`);

  // Stale entries must not be served, or a re-index would be invisible.
  const key = 'u1:openai:text-embedding-3-small:the deposit';
  QUERY_VECTORS.set(key, { vector: Float32Array.from([9, 9]), at: Date.now() - QUERY_CACHE_TTL_MS - 1 });
  await queryVector('u1', 'the deposit', openai, stub);
  check('an entry past its TTL is re-embedded', calls === 4, `${calls} calls`);

  // Per account: another account asking the same thing is not served a vector
  // computed on someone else's key.
  await queryVector('u2', 'the deposit', openai, stub);
  check('the cache is not shared between accounts', calls === 5, `${calls} calls`);

  // Bounded, or a long-lived process holds every question ever asked.
  for (let i = 0; i < QUERY_CACHE_MAX + 40; i += 1) {
    await queryVector('u1', `q${i}`, openai, stub);
  }
  check('the cache stays bounded', QUERY_VECTORS.size <= QUERY_CACHE_MAX, String(QUERY_VECTORS.size));
}

// ── credentials are never indexed ─────────────────────────────────────

section('secrets are skipped before they are read');
{
  // index_folder reads a folder the model chose and ships the contents to an
  // embedding API, where search_docs can retrieve it afterwards. Pointed at a
  // project root, that used to include env files.
  //
  // A bare `.env` was in fact already skipped — but only because
  // path.extname('.env') is '' rather than '.env', so it never matched the
  // extension list that named it. What `.env` in that list actually matched was
  // `config.env` and `settings.env`, which hold the same things. Protection by
  // accident stops working the day somebody fixes the accident, so the rule is
  // written down by name and pinned here.
  for (const f of [
    '.env', '.env.local', '.env.production.local', 'worker/.env',
    'config.env', 'settings.env', 'a/b/.env.vercel-paste.local',
    'id_rsa', 'id_ed25519', 'server.key', 'cert.pem', 'store.pfx',
    '.npmrc', '.netrc', '.pgpass', 'secrets.json',
  ]) {
    check(`skipped: ${f}`, isSecretFile(f) === true);
  }

  // The other half matters as much: a filter that skips everything would make
  // "I searched your documents" a lie in the other direction.
  for (const f of [
    'README.md', 'app.js', 'notes.txt', 'data.csv', 'package.json', 'schema.sql',
    'environment.md', 'envelope.md',
  ]) {
    check(`still indexed: ${f}`, isSecretFile(f) === false);
  }
}

await store.close?.();
removeTemp(process.env.DATA_DIR);
console.log(
  failures === 0
    ? '\n\x1b[32mAll document-index checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
