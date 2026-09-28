/**
 * The tools that show things rather than say them, and the machinery under
 * them: image search, sports, ready-made cards, the map, the cloud computer,
 * search depth, and share links.
 *
 * Nothing here reaches the network: every outside service is replaced by a
 * stub that answers in the shape the real one does, so what is pinned is our
 * reading of those shapes and our rules about them — which hosts a picture may
 * come from, what a card refuses, where a sandbox path may point, what a share
 * link serves and under which policy.
 *
 *   node test/features.test.mjs
 */
import http from 'node:http';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};
const throws = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return String(e?.message || e);
  }
};

const { allowedImageUrl, mapTile } = await import('../server/imageProxy.js');
const { openverseItem, commonsItem, imageSearchTool } = await import('../server/tools/images.js');
const { matchOf, sportsTool, __testing: sportsInternals } = await import('../server/tools/sports.js');
const { buildCard, showCardTool, CARD_TYPES } = await import('../server/tools/cards.js');
const { sandboxConfigured, sandboxName, workPath } = await import('../server/sandbox.js');
const { searchDepth } = await import('../server/tools/cloud.js');
const { TOOLS_BY_NAME, availableTools, assessRisk } = await import('../server/tools/definitions.js');

section('a picture is only fetched from the hosts that serve search results and crests');
{
  check('Openverse thumbnails', !!allowedImageUrl('https://api.openverse.org/v1/images/abc/thumb/'));
  check('Wikimedia', !!allowedImageUrl('https://upload.wikimedia.org/wikipedia/commons/a/ab/x.jpg'));
  check('club crests', !!allowedImageUrl('https://r2.thesportsdb.com/images/media/team/badge/x.png'));
  check('not any other host', !allowedImageUrl('https://evil.example/x.png'));
  check('not a look-alike', !allowedImageUrl('https://upload.wikimedia.org.evil.example/x.png'));
  check('not plain http', !allowedImageUrl('http://upload.wikimedia.org/x.png'));
  check('not with credentials or a port', !allowedImageUrl('https://a:b@upload.wikimedia.org/x.png') && !allowedImageUrl('https://upload.wikimedia.org:8443/x.png'));
  check('not garbage', !allowedImageUrl('javascript:alert(1)') && !allowedImageUrl(undefined));
  check('a tile outside the world is refused before anything is sent', (await mapTile(3, 8, 0)) === null && (await mapTile(20, 0, 0)) === null && (await mapTile('1.5', 0, 0)) === null);
}

section('image search reads both collections and keeps only pictures it may show');
{
  const item = openverseItem({
    title: '<b>Ha Long</b> Bay', thumbnail: 'https://api.openverse.org/v1/images/1/thumb/', foreign_landing_url: 'https://flickr.com/p/1',
    creator: 'Someone', license: 'by-sa', license_version: '2.0', width: 800, height: 600, source: 'flickr',
  });
  check('an Openverse result becomes a tile', item?.title === 'Ha Long Bay' && item.license === 'CC BY-SA 2.0' && item.page === 'https://flickr.com/p/1');
  check('one whose picture lives elsewhere is dropped', openverseItem({ thumbnail: 'https://cdn.example/x.jpg', url: 'https://cdn.example/x.jpg' }) === null);
  const commons = commonsItem({
    title: 'File:Halong Bay.jpg',
    imageinfo: [{ thumburl: 'https://upload.wikimedia.org/t/480px-x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:x', width: 10, height: 5, extmetadata: { Artist: { value: '<a>Ann</a>' }, LicenseShortName: { value: 'CC BY 4.0' } } }],
  });
  check('a Commons result too, tags stripped', commons?.title === 'Halong Bay' && commons.creator === 'Ann' && commons.license === 'CC BY 4.0');

  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const body = String(url).includes('openverse')
      ? { results: [] }
      : { query: { pages: { 1: { index: 1, title: 'File:A.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:A.jpg' }] } } } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const out = await imageSearchTool({ query: 'hạ long', count: 40 });
    check('an empty Openverse falls back to Commons', asked.length === 2 && out.widget?.images?.length === 1);
    check('the count is capped', /page_size=12/.test(asked[0]), asked[0]);
    check('the listing is marked as outside text', /^<untrusted/.test(out.content));
    check('no query is refused', /Say what to look for/.test(await throws(() => imageSearchTool({ query: ' ' }))));
  } finally {
    globalThis.fetch = real;
  }
}

section('sports: a match, a league name, and a card');
{
  const played = matchOf({ strHomeTeam: 'Arsenal', strAwayTeam: 'Chelsea', intHomeScore: '2', intAwayScore: '1', dateEvent: '2026-09-06', strTime: '15:30:00', strStatus: 'FT' });
  check('a played match has its score', played.homeScore === 2 && played.awayScore === 1 && played.time === '15:30');
  const upcoming = matchOf({ strHomeTeam: 'A', strAwayTeam: 'B', intHomeScore: null, intAwayScore: null });
  check('a fixture has none', upcoming.homeScore === null && upcoming.awayScore === null);
  check('leagues are known by the names people use', (await sportsInternals.leagueId('Ngoại hạng Anh')) === 4328 && (await sportsInternals.leagueId('V.League')) === 4803);
  check('an unknown league says which ones it knows', /not a league this knows/.test(await throws(() => sportsInternals.leagueId('Moon League'))));

  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('searchteams')
      ? { teams: [{ idTeam: '1', strTeam: 'Arsenal', strLeague: 'English Premier League', strBadge: 'https://r2.thesportsdb.com/b.png' }] }
      : u.includes('eventslast')
        ? { results: [{ strHomeTeam: 'Arsenal', strAwayTeam: 'Chelsea', intHomeScore: '2', intAwayScore: '1', dateEvent: '2026-09-06', strLeague: 'EPL' }] }
        : { events: null };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const out = await sportsTool({ op: 'team', team: 'Arsenal' });
    check('a team comes back as a scores card', out.widget?.kind === 'card' && out.widget.card.type === 'scores');
    check('with the result in words for the model', /Arsenal 2–1 Chelsea/.test(out.content), out.content.slice(0, 200));
    check('wrapped as outside data', /<untrusted/.test(out.content));
    check('a missing op is refused', /op is team, league, day or player/.test(await throws(() => sportsTool({}))));
  } finally {
    globalThis.fetch = real;
  }
}

section('cards take content, refuse nonsense, and are cut to size');
{
  check('seven kinds', CARD_TYPES.length === 7);
  check('an unknown kind is refused', /type is one of/.test(await throws(() => buildCard('horoscope', {}))));
  check('a recipe needs ingredients and steps', /needs `ingredients` and `steps`/.test(await throws(() => buildCard('recipe', { ingredients: ['x'] }))));
  const quiz = buildCard('quiz', {
    title: 'T',
    questions: [
      { question: 'ok', options: ['a', 'b'], answer: 1 },
      { question: 'answer out of range', options: ['a', 'b'], answer: 5 },
      { question: 'one option', options: ['a'], answer: 0 },
    ],
  });
  check('a quiz keeps only questions that can be answered', quiz.questions.length === 1);
  const cmp = buildCard('comparison', { items: ['A', 'B', 'C'], rows: [{ label: 'price', values: ['1'] }], recommended: 7 });
  check('a short comparison row is padded to every item', cmp.rows[0].values.length === 3);
  check('a recommendation out of range is dropped', cmp.recommended === null);
  const long = buildCard('flashcards', { cards: Array.from({ length: 500 }, (_, i) => ({ front: `f${i}`, back: 'b'.repeat(5000) })) });
  check('long content is cut to size', long.cards.length === 100 && long.cards[0].back.length === 800);
  const steps = buildCard('steps', { steps: ['plain', { title: 'rich', detail: 'more' }] });
  check('steps take strings or objects', steps.steps[0].title === 'plain' && steps.steps[1].detail === 'more');
  const drawn = await showCardTool({ type: 'quiz', card: { questions: [{ question: 'q', options: ['a', 'b'], answer: 0 }] } });
  check('an interactive card tells the model not to give the answers away', /do not give the answers away/.test(drawn.content));
}

section('the cloud computer: offered only where it can start, and fenced to its folder');
{
  check('not configured with nothing set', !sandboxConfigured({}));
  check('on Vercel it is', sandboxConfigured({ VERCEL: '1' }));
  check('elsewhere it needs all three settings', !sandboxConfigured({ VERCEL_TOKEN: 't' }) && sandboxConfigured({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'x', VERCEL_PROJECT_ID: 'p' }));
  check('and can be switched off', !sandboxConfigured({ VERCEL: '1', SANDBOX_DISABLED: '1' }));
  check('one machine per conversation', sandboxName('u', 'c1') === sandboxName('u', 'c1') && sandboxName('u', 'c1') !== sandboxName('u', 'c2'));
  check('its name gives nothing away', !sandboxName('user-123', 'chat-9').includes('user') && /^syn-[0-9a-f]{32}$/.test(sandboxName('a', 'b')));
  check('a relative path lands in the work folder', workPath('out/r.pdf') === '/vercel/sandbox/out/r.pdf');
  check('/tmp is allowed', workPath('/tmp/x') === '/tmp/x');
  check('climbing out is refused', /climbs out/.test(await throws(() => workPath('../../etc/passwd'))));
  check('an absolute path elsewhere is refused', /outside both/.test(await throws(() => workPath('/etc/passwd'))));
  const hidden = availableTools({ context: 0, activated: new Set(['sandbox_run']), hosted: [] });
  const shown = availableTools({ context: 0, activated: new Set(['sandbox_run']), hosted: ['sandbox'] });
  check('hidden from the model where it cannot start', !hidden.some((t) => t.name === 'sandbox_run'));
  check('offered where it can', shown.some((t) => t.name === 'sandbox_run'));
  check('it changes things, so it is not read-only', TOOLS_BY_NAME.sandbox_run.readOnly === false);
}

section('search depth follows the reasoning level');
{
  check('low is links only', searchDepth('low').read === 0);
  check('high reads the top two pages', searchDepth('high').read === 2);
  check('max reads more', searchDepth('max').read > searchDepth('high').read);
  check('an unknown level is treated as the default', searchDepth(undefined).read === searchDepth('high').read);
  check('"quick" overrides a careful setting', searchDepth('max', 'quick').read === 0);
  check('"thorough" overrides a fast one', searchDepth('low', 'thorough').read >= 3);
}

section('publishing asks first; taking a link back does not');
{
  check('publish is sensitive', assessRisk('publish_file', { file_id: 'x' }) === 'sensitive');
  check('unpublish is not', assessRisk('publish_file', { file_id: 'x', unpublish: true }) === 'ordinary');
  check('the showing tools only read', ['image_search', 'sports', 'show_card'].every((n) => assessRisk(n, {}) === 'safe'));
}

section('a share link serves one file, sandboxed, and nothing once taken back');
{
  const db = await PGlite.create();
  const { initStore } = await import('../server/store/index.js');
  const store = await initStore({ driver: { query: async (text, params = []) => (await db.query(text, params)).rows } });
  const { mountPublicShare, mountShareRoutes, withVisitorShim } = await import('../server/routes/share.js');

  const owner = await store.createUser({ id: 'u-1', email: 'o@example.com', passwordHash: 'x', name: 'O', role: 'user' });
  await store.createAttachment(owner.id, {
    id: 'page', name: 'quiz.html', mime: 'text/html', kind: 'text', bytes: 40,
    data: Buffer.from('<html><head></head><body>hi</body></html>').toString('base64'), origin: 'generated', source: 'x', chatId: null,
  });
  await store.createAttachment(owner.id, { id: 'upload', name: 'id.pdf', mime: 'application/pdf', kind: 'document', bytes: 4, data: Buffer.from('%PDF').toString('base64') });

  const app = express();
  const wrap = (h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next);
  mountPublicShare(app, { wrap });
  const api = express.Router();
  api.use((req, res, next) => {
    req.user = { id: req.headers['x-user'] || 'u-1' };
    next();
  });
  mountShareRoutes(api, { wrap });
  app.use('/api', api);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(`${base}/api/attachments/page/share`, { method: 'POST' })).json();
    const again = await (await fetch(`${base}/api/attachments/page/share`, { method: 'POST' })).json();
    check('sharing gives a link', /^\/api\/share\/[A-Za-z0-9_-]{43}$/.test(first.path || ''), first.path);
    check('asking again gives the same link', again.path === first.path);
    const upload = await fetch(`${base}/api/attachments/upload/share`, { method: 'POST' });
    check('an upload cannot be shared', upload.status === 400);

    const open = await fetch(`${base}${first.path}`);
    const csp = open.headers.get('content-security-policy') || '';
    const html = await open.text();
    check('the page opens without signing in', open.status === 200 && html.includes('hi'));
    check('sandboxed, with no way back to the app', /sandbox allow-scripts/.test(csp) && !/allow-same-origin/.test(csp) && /connect-src 'none'/.test(csp), csp);
    check('its storage is the visitor\'s own memory, not the owner\'s', html.includes('window.storage') && !html.includes('postMessage'));
    check('and it is not indexed', /noindex/.test(open.headers.get('x-robots-tag') || ''));

    const guessed = await fetch(`${base}/api/share/${'A'.repeat(43)}`);
    check('a guessed token opens nothing', guessed.status === 404);
    const junk = await fetch(`${base}/api/share/..%2F..%2Fetc`);
    check('a malformed one neither', junk.status === 404);

    await fetch(`${base}/api/attachments/page/share`, { method: 'DELETE' });
    check('taking it back closes the link', (await fetch(`${base}${first.path}`)).status === 404);
    check('the visitor shim goes in the head', withVisitorShim('<html><head><title>t</title></head></html>').indexOf('window.storage') < withVisitorShim('<html><head><title>t</title></head></html>').indexOf('<title>'));
  } finally {
    server.close();
  }
}

console.log(failures === 0 ? '\n\x1b[32mAll feature checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
