/**
 * world_facts: the time, the weather and a rate, said from the services' own
 * payloads. No network here — the live calls are one `fetch` each; what can go
 * wrong is how the answer is read back, and that is all pure.
 *
 *   node test/world.test.mjs
 */
import { describeTime, describeWeather, describeRate } from '../server/tools/cloud.js';
import { TOOLS_BY_NAME, assessRisk } from '../server/tools/definitions.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

section('the time is said in the zone asked for');
{
  // 23:30 UTC on the 26th is already the 27th in Vietnam — the case the old
  // UTC-only date line got wrong every night.
  const at = new Date('2026-09-26T23:30:00Z');
  const vn = describeTime(at, 'Asia/Ho_Chi_Minh');
  check('Vietnam is on the next day', /27 September 2026/.test(vn) && /06:30/.test(vn), vn);
  check('and the zone is named', /Asia\/Ho_Chi_Minh/.test(vn));
  check('a zone that is not one falls back to UTC, and says so', /UTC/.test(describeTime(at, 'Mars/Olympus')));
}

section('the weather reads as words, with its source');
{
  const said = describeWeather('Hanoi, Vietnam', {
    current: { time: '2026-09-27T17:30', temperature_2m: 30.5, apparent_temperature: 36.2, relative_humidity_2m: 77, weather_code: 61, wind_speed_10m: 11.7, precipitation: 0.4 },
    current_units: { temperature_2m: '°C', apparent_temperature: '°C', wind_speed_10m: 'km/h', precipitation: 'mm' },
    daily: { time: ['2026-09-28'], weather_code: [95], temperature_2m_min: [26], temperature_2m_max: [33], precipitation_probability_max: [80] },
  });
  check('a code becomes a word', /light rain/.test(said) && /thunderstorm/.test(said), said.split('\n')[0]);
  check('with the temperature and how it feels', /30\.5°C/.test(said) && /feels like 36\.2°C/.test(said));
  check('the next days, with the chance of rain', /2026-09-28: thunderstorm, 26–33°C, chance of rain 80%/.test(said));
  check('and where it came from', /Open-Meteo/.test(said));
}

section('a rate is converted, and a missing one refused');
{
  const table = { result: 'success', rates: { VND: 25952.1 }, time_last_update_utc: 'Sun, 27 Sep 2026' };
  const said = describeRate(table, 'USD', 'VND', 100);
  check('the amount is multiplied', /100 USD = 2,595,210 VND/.test(said), said);
  check('and labelled a reference, not a quote', /mid-market reference/.test(said));
  let refused = '';
  try {
    describeRate(table, 'USD', 'XYZ', 1);
  } catch (err) {
    refused = err.message;
  }
  check('an unknown currency is an error, not a zero', /No rate from USD to XYZ/.test(refused), refused);
}

/**
 * The owner's screenshot (2026-11-04): USDT→VND refused for not being an ISO code,
 * on a question that had a live answer one free call away.
 */
section('a coin has a rate too');
{
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  const tool = CLOUD_IMPLEMENTATIONS.world_facts;
  const real = globalThis.fetch;
  const asked = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).includes('currency=USDT')) return json({ data: { currency: 'USDT', rates: { VND: '25700.5', USD: '0.999' } } });
      return new Response('nope', { status: 500 });
    };
    const said = await tool({ kind: 'exchange_rate', base: 'usdt', quote: 'vnd', amount: 2 }, {});
    check('USDT to VND is looked up, not refused', /2 USDT = 51,401 VND/.test(said), said);
    check('  from a public source it names', /Coinbase/.test(said) && /not what a given exchange/.test(said));
    check('  without touching the table that has no coins', !asked.some((u) => u.includes('er-api')));

    asked.length = 0;
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).includes('currency=VND')) return json({ data: { currency: 'VND', rates: { USD: '0.00004' } } });
      if (String(url).includes('currency=BTC')) return json({ data: { currency: 'BTC', rates: { VND: '2500000000' } } });
      return new Response('nope', { status: 500 });
    };
    const back = await tool({ kind: 'exchange_rate', base: 'VND', quote: 'BTC', amount: 2_500_000_000 }, {});
    check('a coin as the quote works the other way round', /= 1 BTC/.test(back), back);

    // Coinbase down: the commonest coins still answer.
    globalThis.fetch = async (url) => (String(url).includes('coingecko') ? json({ tether: { vnd: 25685 } }) : new Response('down', { status: 503 }));
    const fallback = await tool({ kind: 'exchange_rate', base: 'USDT', quote: 'VND' }, {});
    check('CoinGecko answers when Coinbase does not', /1 USDT = 25,685 VND/.test(fallback) && /CoinGecko/.test(fallback), fallback);

    // A currency that is really a currency still goes to the table.
    asked.length = 0;
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      return json({ result: 'success', rates: { VND: 25952.1 }, time_last_update_utc: 'today' });
    };
    const fiat = await tool({ kind: 'exchange_rate', base: 'USD', quote: 'VND' }, {});
    check('two real currencies still use the rate table', /mid-market reference/.test(fiat) && asked.length === 1 && asked[0].includes('er-api'), asked.join());

    globalThis.fetch = async () => json({ data: { rates: {} } });
    const nothing = await tool({ kind: 'exchange_rate', base: 'NOSUCHCOIN', quote: 'VND' }, {}).catch((err) => err.message);
    check('something nobody quotes is an error, not a zero', /No rate from NOSUCHCOIN to VND/.test(nothing), nothing);
    const shape = await tool({ kind: 'exchange_rate', base: 'US D!', quote: 'VND' }, {}).catch((err) => err.message);
    check('and what cannot be a code is refused before asking anyone', /ISO codes like USD/.test(shape) && /coin symbols/.test(shape), shape);
  } finally {
    globalThis.fetch = real;
  }
}

section('it runs without asking, because it changes nothing');
{
  const tool = TOOLS_BY_NAME.world_facts;
  check('it is in the catalogue', !!tool);
  check('read-only', tool?.readOnly === true);
  check('so it is graded safe', assessRisk('world_facts', { kind: 'weather' }) === 'safe');
  check('its first sentence stands alone', /^Look up the exact current time and date[^.]*\./.test(tool?.description || ''));
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll world-facts checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
