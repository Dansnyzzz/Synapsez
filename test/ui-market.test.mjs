/**
 * The market card (public/js/cards.js `marketFigure`), in a real browser.
 *
 * The widgets are made by the server's own finance layer from the recorded
 * answers in test/fixtures/finance — not written by hand — then kept in a
 * conversation as `market_data` results, so what is checked is what a reload
 * draws from what the tool returned. One more is drawn live, as a step completes.
 *
 *   - the title, at least three figures, the session, the source as a link, the
 *     source's credit, and "for reference only"
 *   - a history draws a sparkline in an inline SVG, no library
 *   - the keyboard reaches the card's link
 *   - every word in it readable in the dark and the light theme (4.5:1)
 *   - in Vietnamese, Vietnamese words and Vietnamese numbers
 *
 *   node test/ui-market.test.mjs        (port 5236)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-market-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-market-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.FIN_PACE_SCALE = '0';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-market-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /email \(no provider|^ {2}(to|subject):|confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

let failures = 0;
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/* ── the words the server can send, in both languages ─────────────── */

section('every key the server can put in a card has words in both languages');
{
  const { en } = await import('../public/js/locales/en.js');
  const { vi } = await import('../public/js/locales/vi.js');
  const keys = [
    ...['pre', 'ato', 'continuous', 'break', 'atc', 'plo', 'putthrough', 'closed'].map((s) => `market.session.${s}`),
    ...['live', 'delayed', 'eod'].map((d) => `market.delay.${d}`),
    ...['price', 'reference', 'ceiling', 'floor', 'previousClose', 'high', 'low', 'volume', 'marketCap', 'first', 'last', 'buy', 'sell', 'buyCash', 'buyTransfer', 'rate'].map((k) => `market.row.${k}`),
  ];
  const missing = keys.filter((k) => !en[k] || !vi[k]);
  check('sessions, delays and row names', missing.length === 0, missing.join(', '));
}

/* ── widgets from the server's own code ───────────────────────────── */

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'finance');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const routes = [
  ['stock_prices', 'vndirect-stock-prices.json'],
  ['getByGroup?group=HOSE', [{ symbol: 'FPT' }]],
  ['simple/price', 'coingecko-simple.json'],
  ['/chart/AAPL', 'yahoo-chart-aapl.json'],
];
const fetchImpl = async (url) => {
  for (const [match, answer] of routes) if (String(url).includes(match)) return new Response(JSON.stringify(typeof answer === 'string' ? fixture(answer) : answer), { status: 200 });
  return new Response('{"error":"not recorded"}', { status: 404 });
};

const { initStore, getStore } = await import('../server/store/index.js');
await initStore();
const { marketData } = await import('../server/finance/index.js');
const now = new Date('2026-11-10T07:50:00Z');
const quote = await marketData({ kind: 'quote', market: 'vn', symbols: ['FPT'] }, { now, fetchImpl });
const history = await marketData({ kind: 'history', market: 'us', symbols: ['AAPL'], period: '5d' }, { now, fetchImpl });
const coin = await marketData({ kind: 'crypto', symbols: ['btc'] }, { now, fetchImpl });
if (!quote.widget || !history.widget || !coin.widget) {
  realLog('\n  The finance layer made no widget from the fixtures; nothing to draw.\n');
  process.exit(1);
}

const { createApp } = await import('../server/app.js');
const PORT = 5236;
const server = (await createApp()).listen(PORT);
await new Promise((r) => server.once('listening', r));

const { chromium } = await import('playwright-core');
let browser;
for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
  try {
    browser = await chromium.launch({ ...options, headless: true });
    break;
  } catch {
    /* try the next one */
  }
}
if (!browser) {
  realLog('\n  Skipped: no Chrome, Edge or bundled Chromium to drive.\n');
  server.close();
  process.exit(process.env.CI ? 1 : 0);
}

const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate-username');
await page.fill('#gate-username', 'market.reader');
await page.fill('#gate-email', 'market@test.local');
await page.fill('#gate-password', 'a-long-enough-password');
await page.check('#gate-consent');
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');

const store = getStore();
const me = await store.getUserByEmail('market@test.local');
const setLanguage = async (language) => store.setUserSetting(me.id, 'prefs', { ...(await store.getUserSetting(me.id, 'prefs')), language, onboarded: true });
await setLanguage('en');

// One conversation, three market_data results, as the agent loop keeps them.
const at = new Date('2026-11-10T07:51:00Z').toISOString();
await store.createChat(me.id, { id: 'c-market', title: 'Markets', model: 'auto' });
const say = (message) => store.appendMessage(me.id, 'c-market', { createdAt: at, ...message });
await say({ id: 'm-u', role: 'user', text: 'FPT, Apple this week, and bitcoin' });
let n = 0;
for (const [input, result] of [
  [{ kind: 'quote', market: 'vn', symbols: ['FPT'] }, quote],
  [{ kind: 'history', market: 'us', symbols: ['AAPL'], period: '5d' }, history],
  [{ kind: 'crypto', symbols: ['btc'] }, coin],
]) {
  n += 1;
  await say({ id: `m-a${n}`, role: 'assistant', text: '', toolCalls: [{ id: `k${n}`, name: 'market_data', input }] });
  await say({ id: `m-t${n}`, role: 'tool', results: [{ toolCallId: `k${n}`, name: 'market_data', content: result.content, widget: result.widget, ms: 30 }] });
}
await say({ id: 'm-end', role: 'assistant', text: 'Here they are.' });

const open = async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
  await page.click('.chat-row[data-chat="c-market"] .chat-item');
  await page.waitForFunction(() => document.getElementById('chat-title')?.textContent === 'Markets');
  await page.waitForTimeout(500);
  // Steps fold once done: open them so the cards are on screen.
  await page.evaluate(() => document.querySelectorAll('#messages details:not([open])').forEach((d) => d.setAttribute('open', '')));
  await page.waitForTimeout(200);
};
await open();

section('a quote card: title, figures, session, source, credit, disclaimer');
{
  const seen = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#messages .xcard--market')];
    const card = cards[0];
    const text = (sel) => card?.querySelector(sel)?.textContent?.trim() || '';
    return {
      cards: cards.length,
      title: text('.xcard__title'),
      value: text('.xmarket__value'),
      change: text('.xmarket__change'),
      rows: [...(card?.querySelectorAll('.xmarket__row') || [])].map((r) => `${r.querySelector('dt')?.textContent}=${r.querySelector('dd')?.textContent}`),
      chip: text('.xmarket__session'),
      source: text('.xmarket__source'),
      link: card?.querySelector('.xmarket__source a')?.getAttribute('href') || '',
      disclaimer: text('.xmarket__disclaimer'),
      coinCredit: cards[2]?.querySelector('.xmarket__credit')?.textContent || '',
      coinCreditLink: cards[2]?.querySelector('.xmarket__credit a')?.getAttribute('href') || '',
    };
  });
  check('three cards drawn from the stored results', seen.cards === 3, String(seen.cards));
  check('the title names the stock and its board', seen.title === 'FPT · HOSE', seen.title);
  check('the price large, in ₫', /50,900 ₫/.test(seen.value), seen.value);
  check('  its change with a sign and an arrow, not colour alone', /▼ −0\.20 %/.test(seen.change), seen.change);
  check('at least three figures: reference, ceiling, floor…', seen.rows.length >= 3 && seen.rows.some((r) => /^Reference=51,000 ₫$/.test(r)) && seen.rows.some((r) => /^Ceiling=54,500 ₫$/.test(r)) && seen.rows.some((r) => /^Floor=47,450 ₫$/.test(r)), seen.rows.join(' | '));
  check('the session, as a chip', seen.chip === 'Put-through', seen.chip);
  check('the source, linked to its site, with the time in the exchange\'s zone and the delay', /^Source: VNDIRECT/.test(seen.source) && seen.link === 'https://www.vndirect.com.vn' && /May be delayed/.test(seen.source) && /(14:46|02:46 PM) GMT\+7/.test(seen.source), seen.source);
  check('"for reference only, not investment advice"', /For reference only, not investment advice/.test(seen.disclaimer));
  check('CoinGecko\'s card carries "Powered by CoinGecko", linked', /Powered by CoinGecko/.test(seen.coinCredit) && seen.coinCreditLink === 'https://www.coingecko.com', seen.coinCredit);
}

section('a history card draws its sparkline, inline');
{
  const spark = await page.evaluate(() => {
    const card = document.querySelectorAll('#messages .xcard--market')[1];
    const svg = card?.querySelector('svg.xmarket__spark');
    const points = svg?.querySelector('polyline')?.getAttribute('points') || '';
    return { svg: !!svg, inline: svg?.closest('figure') === card, points: points.trim().split(/\s+/).length, label: svg?.getAttribute('aria-label') || '', role: svg?.getAttribute('role'), width: svg?.getAttribute('width'), scripts: document.querySelectorAll('script[src*="chart"]').length };
  });
  check('an SVG polyline with a point per close', spark.svg && spark.inline && spark.points === 5, JSON.stringify(spark));
  check('  120 × 32, described for a screen reader', spark.width === '120' && spark.role === 'img' && /^Price from \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/.test(spark.label), spark.label);
  check('  and no chart library loaded for it', spark.scripts === 0);
}

section('the keyboard reaches the card\'s link');
{
  // From the step card just before it (its summary is the last thing the keyboard stops on), one Tab.
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#messages .xcard--market')?.previousElementSibling?.querySelector('summary'))?.focus());
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => ({ cls: document.activeElement?.className || '', href: document.activeElement?.getAttribute('href') || '', inCard: !!document.activeElement?.closest('.xcard--market') }));
  check('Tab from the card lands on its source link', focused.inCard && /xmarket__link/.test(focused.cls) && focused.href === 'https://www.vndirect.com.vn', JSON.stringify(focused));
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check('  and shows where it is', ring !== 'none', ring);
}

section('every word in the card is readable, dark and light (4.5:1)');
{
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.waitForTimeout(150);
    const worst = await page.evaluate(() => {
      const parse = (text) => {
        const s = String(text || '').trim();
        const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (hex) {
          const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
          return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
        }
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return { r, g, b, a };
      };
      const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      // What is behind an element: every coloured layer above the page, laid over the page's own colour.
      const behind = (el) => {
        const layers = [];
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c && c.a > 0) layers.push(c);
          if (c && c.a >= 1) break;
        }
        let base = parse(getComputedStyle(document.documentElement).getPropertyValue('--bg')) || { r: 255, g: 255, b: 255, a: 1 };
        for (const layer of layers.reverse()) base = over(layer, base);
        return base;
      };
      const card = document.querySelector('#messages .xcard--market');
      const texts = [...card.querySelectorAll('.xcard__title, .xmarket__value, .xmarket__change, .xmarket__row dt, .xmarket__row dd, .xmarket__foot p, .xmarket__link, .xmarket__session')];
      let low = { ratio: 99, what: '' };
      for (const el of texts) {
        const bg = behind(el);
        const fg = over(parse(getComputedStyle(el).color), bg);
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        if (ratio < low.ratio) low = { ratio: Math.round(ratio * 100) / 100, what: `${el.className || el.tagName} "${el.textContent.trim().slice(0, 20)}"` };
      }
      return { ...low, count: texts.length };
    });
    check(`${theme}: the faintest text still reads at 4.5:1 or better`, worst.ratio >= 4.5 && worst.count > 8, `${worst.ratio} — ${worst.what} (${worst.count} checked)`);
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });
}

section('in Vietnamese: Vietnamese words and numbers');
{
  await setLanguage('vi');
  await open();
  const vi = await page.evaluate(() => {
    const card = document.querySelector('#messages .xcard--market');
    return { value: card?.querySelector('.xmarket__value')?.textContent || '', rows: [...(card?.querySelectorAll('.xmarket__row dt') || [])].map((n) => n.textContent), chip: card?.querySelector('.xmarket__session')?.textContent || '', foot: card?.querySelector('.xmarket__disclaimer')?.textContent || '' };
  });
  check('50.900 ₫, tham chiếu, trần, sàn', /50\.900 ₫/.test(vi.value) && vi.rows.includes('Tham chiếu') && vi.rows.includes('Trần') && vi.rows.includes('Sàn'), JSON.stringify(vi));
  check('  the session and the disclaimer too', vi.chip === 'Thỏa thuận' && /không phải khuyến nghị đầu tư/.test(vi.foot), `${vi.chip} / ${vi.foot}`);
  await setLanguage('en');
}

section('drawn live, as the step completes');
{
  await open();
  const live = await page.evaluate(async (widget) => {
    const src = document.querySelector('script[src*="/js/app.js"]')?.src.replace('app.js', 'render.js') || '/js/render.js';
    const { assistantMessage } = await import(src);
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);
    const step = turn.startTool({ id: 'live-1', name: 'market_data', input: { kind: 'crypto', symbols: ['btc'] } });
    step.complete({ content: 'BTC', widget, ms: 12 });
    await new Promise((r) => setTimeout(r, 300));
    turn.node.querySelectorAll('details:not([open])').forEach((d) => d.setAttribute('open', ''));
    const card = turn.node.querySelector('.xcard--market');
    return { drawn: !!card, title: card?.querySelector('.xcard__title')?.textContent || '' };
  }, coin.widget);
  check('a market_data result with a widget draws its card at once', live.drawn && /BTC/.test(live.title), JSON.stringify(live));
}

check('no script error on any of it', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
realLog(failures === 0 ? '\n\x1b[32mAll market card checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
