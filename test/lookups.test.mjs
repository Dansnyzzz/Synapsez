/**
 * What can be looked up, and several at once in one call (owner, 2026-11-05).
 * Each free service is played by a stand-in that answers as it does, so this checks
 * what is asked of it and what is said from its answer; nothing here goes out.
 *
 *   node test/lookups.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};
const fails = async (promise, pattern) => promise.then(() => false, (err) => pattern.test(String(err.message)));

process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-the-lookups-suite';
const facts = await import('../server/tools/facts.js');
const references = await import('../server/tools/references.js');

const HANOI = { name: 'Hanoi', admin1: 'Hà Nội', country: 'Vietnam', latitude: 21.02, longitude: 105.84, timezone: 'Asia/Bangkok', elevation: 12, population: 8053663 };
/** @type {string[]} */
const asked = [];
const answers = (url) => {
  asked.push(url);
  if (url.includes('geocoding-api')) return /nowhere/.test(url) ? { results: [] } : /tokyo/i.test(url) ? { results: [{ ...HANOI, name: 'Tokyo', country: 'Japan', timezone: 'Asia/Tokyo', admin1: 'Tokyo' }] } : { results: [HANOI] };
  if (url.includes('air-quality-api')) return { current: { time: '2026-11-06T10:00', european_aqi: 75, us_aqi: 150, pm2_5: 55.2, pm10: 80, ozone: 40, nitrogen_dioxide: 30, uv_index: 4 } };
  if (url.includes('daily=sunrise')) return { timezone: 'Asia/Bangkok', daily: { time: ['2026-11-06'], sunrise: ['2026-11-06T06:03'], sunset: ['2026-11-06T17:21'], daylight_duration: [40680] } };
  if (url.includes('date.nager.at')) return [{ date: '2026-01-01', localName: 'Tết Dương lịch', name: "New Year's Day" }, { date: '2026-09-02', localName: 'Quốc khánh', name: 'National Day' }];
  if (url.includes('fields=cca2')) return [{ cca2: 'VN' }];
  if (url.includes('restcountries')) return [{ name: { common: 'Vietnam', official: 'Socialist Republic of Vietnam' }, cca2: 'VN', capital: ['Hanoi'], population: 97338583, area: 331212, region: 'Asia', subregion: 'South-Eastern Asia', languages: { vie: 'Vietnamese' }, currencies: { VND: { name: 'Vietnamese đồng', symbol: '₫' } }, timezones: ['UTC+07:00'], idd: { root: '+8', suffixes: ['4'] }, tld: ['.vn'], car: { side: 'right' } }];
  if (url.includes('earthquake.usgs.gov')) return { metadata: { title: 'USGS Significant Earthquakes' }, features: [{ properties: { mag: 6.1, place: 'near Tokyo', time: Date.UTC(2026, 10, 5, 3, 4) } }] };
  if (url.includes('wikipedia.org/w/rest.php')) return { pages: [{ key: 'Ha_Noi' }] };
  if (url.includes('page/summary')) return { title: 'Hà Nội', description: 'thủ đô', extract: 'Hà Nội là thủ đô.', content_urls: { desktop: { page: 'https://vi.wikipedia.org/wiki/Ha_Noi' } } };
  if (url.includes('wbsearchentities')) return { search: [{ id: 'Q1858', label: 'Hanoi', description: 'capital of Vietnam' }] };
  if (url.includes('wbgetentities') && url.includes('props=claims')) return { entities: { Q1858: { claims: { P17: [{ rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q881' } } } }], P1082: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: '+8053663' } } } }], P571: [{ rank: 'deprecated', mainsnak: { datavalue: { value: { time: '+1000' } } } }] } } } };
  if (url.includes('wbgetentities')) return { entities: { Q881: { labels: { en: { value: 'Vietnam' } } } } };
  if (url.includes('wiktionary')) return { en: [{ language: 'English', partOfSpeech: 'Noun', definitions: [{ definition: 'A <b>thing</b> &amp; more' }] }] };
  if (url.includes('openlibrary')) return { docs: [{ title: 'Truyện Kiều', author_name: ['Nguyễn Du'], first_publish_year: 1820, edition_count: 9, key: '/works/OL1W' }] };
  if (url.includes('crossref')) return { message: { items: [{ title: ['Attention'], author: [{ given: 'A', family: 'V' }], issued: { 'date-parts': [[2017]] }, 'container-title': ['NIPS'], URL: 'https://doi.org/x', 'is-referenced-by-count': 9 }] } };
  throw new Error(`nobody answers ${url}`);
};
const getJson = async (url) => answers(url);

section('facts about the world');
{
  check('a place is found', (await facts.geocode('Hanoi', getJson)).label === 'Hanoi, Hà Nội, Vietnam');
  check('  and no place says so, helpfully', await fails(facts.geocode('nowhere', getJson), /No place called "nowhere"/));
  check('  and none at all asks which', await fails(facts.geocode('', getJson), /Say which place/));
  const air = await facts.airQuality('Hanoi', getJson);
  check('the air, in words and numbers', /European AQI 75 \(poor\)/.test(air) && /PM2\.5 55\.2/.test(air) && /Open-Meteo/.test(air), air);
  const sun = await facts.sunTimes('Hanoi', '2026-11-06', getJson);
  check('sunrise and sunset', /sunrise 06:03, sunset 17:21/.test(sun) && /11 h 18 min/.test(sun), sun);
  check('  and a date goes into the question', asked.some((u) => u.includes('start_date=2026-11-06')));
  check('  and something that is not a date does not', !asked.some((u) => u.includes('start_date=garbage')) && /sunrise/.test(await facts.sunTimes('Hanoi', 'garbage', getJson)));

  const moon = facts.moonPhase(new Date(Date.UTC(2026, 10, 24, 12)));
  check('the moon, with no service at all: full on 24 November 2026', /full moon/.test(moon) && /(9\d|100)% lit/.test(moon), moon);
  check('  and new on 9 November 2026', /new moon/.test(facts.moonPhase(new Date(Date.UTC(2026, 10, 9, 12)))), facts.moonPhase(new Date(Date.UTC(2026, 10, 9, 12))));
  check('  and it says how far to trust it', /good to about a day/.test(moon));

  const holidays = await facts.publicHolidays('Vietnam', 2026, getJson, new Date(Date.UTC(2026, 5, 1)));
  check('public holidays, by a country\'s name', /Public holidays in VN, 2026/.test(holidays) && /2026-09-02: Quốc khánh \(National Day\)/.test(holidays), holidays);
  check('  past ones marked', /2026-01-01 \(past\)/.test(holidays));
  check('  and it says what the list leaves out', /lunar-calendar/.test(holidays));
  const byCode = await facts.publicHolidays('vn', 2026, getJson);
  check('  or by its code, asking nothing to find it', /Public holidays in VN/.test(byCode));

  const country = await facts.countryFacts('Vietnam', getJson);
  check('a country', /capital Hanoi/.test(country) && /population 97,338,583/.test(country) && /Vietnamese đồng \(VND, ₫\)/.test(country) && /\+84/.test(country) && /Drives on the right/.test(country), country);
  const quakes = await facts.earthquakes('week', getJson);
  check('earthquakes', /M6\.1 near Tokyo/.test(quakes) && /USGS/.test(quakes), quakes);
  check('  the window asked for', asked.some((u) => u.includes('significant_week')));
  check('where a place is', /21\.02, 105\.84, 12 m above sea level/.test(await facts.elevation('Hanoi', getJson)));
}

section('clock times');
{
  const now = new Date(Date.UTC(2026, 10, 6, 3, 0));
  const here = await facts.timeBetween({ location: 'Hanoi' }, getJson, now);
  check('the time in a place', /10:00/.test(here) && /Asia\/Bangkok/.test(here), here);
  const both = await facts.timeBetween({ location: 'Hanoi', to: 'Tokyo' }, getJson, now);
  check('and in another at the same moment', /10:00/.test(both) && /12:00/.test(both), both);
  const moved = await facts.timeBetween({ location: 'Hanoi', to: 'Tokyo', at: '09:30' }, getJson, now);
  check('a clock time read in another place', /09:30/.test(moved) && /11:30/.test(moved), moved);
  const dated = await facts.timeBetween({ location: 'Asia/Tokyo', to: 'America/New_York', at: '2026-07-01 09:00' }, getJson, now);
  check('summer time counts', /20:00/.test(dated), dated);
  const winter = await facts.timeBetween({ location: 'Asia/Tokyo', to: 'America/New_York', at: '2026-12-01 09:00' }, getJson, now);
  check('  and winter time', /19:00/.test(winter), winter);
  check('a time that is not one is refused', await fails(facts.timeBetween({ location: 'Hanoi', at: 'noonish' }, getJson, now), /HH:MM/));
  check('no place at all is refused', await fails(facts.timeBetween({}, getJson, now), /Say which place/));
}

section('references');
{
  const context = { getJson, getText: async () => '<feed><entry><id>http://arxiv.org/abs/1706.03762</id><title>Attention\n Is All</title><summary>We propose</summary><published>2017-06-12T00:00:00Z</published><author><name>Vaswani</name></author></entry></feed>' };
  const wiki = await references.wikipedia('Hà Nội', '', context);
  check('Wikipedia, Vietnamese for a Vietnamese question', /Hà Nội là thủ đô/.test(wiki.text) && asked.some((u) => u.includes('vi.wikipedia.org')));
  const data = await references.wikidata('Hanoi', 'en', context);
  check('Wikidata: exact facts, things by their names', /country: Vietnam/.test(data.text) && /population: 8,053,663/.test(data.text), data.text);
  check('  and not what Wikidata itself marks as wrong', !/founded/.test(data.text));
  const word = await references.wiktionary('thing', 'en', context);
  check('Wiktionary, without its markup', /English noun: A thing & more/.test(word.text), word.text);
  const book = await references.openLibrary('Kieu', '', context);
  check('a book', /Truyện Kiều — Nguyễn Du \(1820\)/.test(book.text), book.text);
  const paper = await references.crossref('attention', '', context);
  check('a paper', /Attention — A V \(2017\), NIPS, cited 9 times/.test(paper.text), paper.text);
  const pre = await references.arxiv('attention', '', context);
  check('a preprint, its title on one line', /Attention Is All — Vaswani \(2017-06-12\)/.test(pre.text), pre.text);
  check('every one says where it came from', [wiki, data, word, book, paper, pre].every((r) => /Source:/.test(r.text)));
}

const memory = await PGlite.create();
const { initStore } = await import('../server/store/index.js');
const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });
await store.createUser({ id: 'u-look', email: 'look@example.com', passwordHash: 'x', name: 'L', role: 'user' });
const user = await store.getUserById('u-look');
const { executeTool } = await import('../server/tools/execute.js');
const { answerEach } = await import('../server/tools/cloud.js');
const run = (name, input) => executeTool({ user, name, input, chatId: null });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('open.er-api.com')) return new Response(JSON.stringify({ result: 'success', rates: { VND: 26000, EUR: 0.9 }, time_last_update_utc: 'today' }), { status: 200 });
  try {
    return new Response(JSON.stringify(answers(target)), { status: 200 });
  } catch {
    return new Response('{}', { status: 500 });
  }
};

section('several at once, one call');
{
  const both = await run('world_facts', { requests: [{ kind: 'exchange_rate', base: 'USD', quote: 'VND' }, { kind: 'moon' }, { kind: 'air_quality', location: 'Hanoi' }] });
  check('all of them, in order', !both.isError && both.content.indexOf('26') < both.content.indexOf('moon') && both.content.indexOf('moon') < both.content.indexOf('AQI'), both.content.slice(0, 300));
  const part = await run('world_facts', { requests: [{ kind: 'air_quality', location: 'nowhere' }, { kind: 'moon' }] });
  check('one that fails says so in its place and leaves the rest', !part.isError && /Could not find that: No place called "nowhere"/.test(part.content) && /moon/.test(part.content), part.content.slice(0, 200));
  const none = await run('world_facts', { requests: [{ kind: 'air_quality', location: 'nowhere' }] });
  check('all of them failing is the call failing', none.isError && /No place called/.test(none.content), none.content);
  const many = await answerEach(Array.from({ length: 20 }, (_, i) => i), async (i) => String(i));
  check('at most twelve, and it says so', /^0\n\n1/.test(many) && /8 more were not asked/.test(many), many.slice(-60));
  const merged = await answerEach(['a', 'b'], async (q) => ({ content: q, chats: [{ id: 'c1', title: 'x' }, { id: `c-${q}`, title: q }] }));
  check('conversations found twice are one', merged.chats.map((c) => c.id).join() === 'c1,c-a,c-b', JSON.stringify(merged.chats));

  const world = await run('world_facts', { kind: 'country', country: 'Vietnam' });
  check('each new kind through the tool', /capital Hanoi/.test(world.content), world.content);
  const unknown = await run('world_facts', { kind: 'horoscope' });
  check('an unknown kind says what there is', unknown.isError && /convert_time/.test(unknown.content) && /holidays/.test(unknown.content), unknown.content);

  const encyclopedia = await run('encyclopedia', { queries: ['Hà Nội', 'Huế'] });
  check('references in one call', !encyclopedia.isError && (encyclopedia.content.match(/Hà Nội là thủ đô/g) || []).length === 2, encyclopedia.content.slice(0, 200));
  const source = await run('encyclopedia', { query: 'Hanoi', source: 'wikidata' });
  check('from the source asked for', /Q1858/.test(source.content), source.content.slice(0, 200));
  check('what comes back is marked as somebody else\'s words', /<untrusted/.test(source.content));
  const noSource = await run('encyclopedia', { query: 'x', source: 'tarot' });
  check('a source that is not one goes to the encyclopedia rather than failing', !noSource.isError && /Hà Nội/.test(noSource.content), noSource.content.slice(0, 120));

  const chats = await run('search_chats', { queries: ['một', 'hai'] });
  check('conversations in one call', !chats.isError, chats.content.slice(0, 120));
  const notes = await run('memory_search', { queries: ['một', 'hai'] });
  check('notes in one call', !notes.isError, notes.content.slice(0, 120));
}
globalThis.fetch = realFetch;

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll lookup checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
