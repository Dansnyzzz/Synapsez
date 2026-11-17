/**
 * Buying a plan, in a real browser (spec B1, Task 9, 2026-11-14): the Upgrade plan row, the plan
 * line under the account, the plans sheet and the checkout by SePay VietQR — all of it only for an
 * account the server says sees billing (administrators, in preview).
 *
 *   node test/ui-billing.test.mjs
 *   BILLING_SHOTS=folder node test/ui-billing.test.mjs   pictures of what it saw
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-billing-test-encryption-key-long-enough';
process.env.SESSION_SECRET ||= 'ui-billing-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-billing-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'BILLING_MODE', 'SEPAY_API_TOKEN', 'E2B_API_KEY']) delete process.env[name];
process.env.SEPAY_BANK_ACCOUNT = '0123456789';
process.env.SEPAY_BANK_CODE = 'MBBank';
process.env.SEPAY_ACCOUNT_NAME = 'SYNAPSEZ TEST';

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

// The rate source is answered here, so nothing leaves the machine.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, options);
  if (u.host === 'open.er-api.com') {
    return new Response(JSON.stringify({ result: 'success', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { VND: 25_500 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new TypeError('fetch failed');
};

const SHOTS = process.env.BILLING_SHOTS || null;
const { initStore } = await import('../server/store/index.js');
const { periodEnd, renewalEnd } = await import('../server/billing/period.js');
const { addressGroup } = await import('../server/ratelimit.js');
const store = await initStore();
const { createApp } = await import('../server/app.js');
const { hashPassword } = await import('../server/crypto.js');
const { setPrefs } = await import('../server/settings.js');
const PORT = 5246; // 5241 is test/chat-limit.test.mjs's
const server = createApp().listen(PORT);
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

let failures = 0;
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const password = 'a-long-enough-password';
// The first administrator is the owner, who may also simulate a transfer.
await store.createUser({ id: 'u-bill-owner', email: 'owner@test.local', name: 'Owner', username: 'bill.owner', passwordHash: await hashPassword(password), role: 'admin' });
await store.createUser({ id: 'u-bill-member', email: 'member@test.local', name: 'Member', username: 'bill.member', passwordHash: await hashPassword(password), role: 'user' });
for (const id of ['u-bill-owner', 'u-bill-member']) await setPrefs(id, { language: 'en', onboarded: true });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function signIn(context, email) {
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (err) => page.errors.push(err.message));
  await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
  // The QR is SePay's picture; a stand-in answers so the page's own policy is what is tested.
  await page.route('https://qr.sepay.vn/**', (route) => route.fulfill({ contentType: 'image/png', body: PNG }));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gate:not([hidden])');
  await page.fill('#gate-email', email);
  await page.fill('#gate-password', password);
  await page.click('#gate-submit');
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
  return page;
}
const menuRows = (page) => page.evaluate(() => [...document.querySelectorAll('.plusmenu--account > [data-row], .plusmenu--account [data-row]')].map((r) => /** @type {HTMLElement} */ (r).dataset.row));
const openMenu = async (page) => {
  await page.click('#account-button');
  await page.waitForSelector('.plusmenu--account [data-row="settings"]');
};

/* ── a member sees none of it ───────────────────────────────────────── */
section('a member sees no billing at all');
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  context.on('request', (req) => {
    if (/\/api\/billing/.test(req.url())) calls.push(req.url());
  });
  const page = await signIn(context, 'member@test.local');
  await page.waitForTimeout(600);
  await openMenu(page);
  const rows = await menuRows(page);
  check('the account menu has no Upgrade plan row', !rows.includes('upgrade') && rows.includes('changelog'), rows.join());
  check('no plan line under the name', await page.evaluate(() => !document.querySelector('.account__plan') || !document.querySelector('.account__plan').getClientRects().length));
  check('and not one request to a billing route', calls.length === 0, calls.join());
  await context.close();
}

/* ── the administrator: row, line, sheet ───────────────────────────── */
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await signIn(context, 'owner@test.local');
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
// Subscribe is off until the consent box is ticked, afresh for every checkout: these tick it, then wait for the button.
const ready = async (timeout = 30000) => {
  await page.waitForSelector('#plans [data-consent]', { timeout });
  await page.check('#plans [data-consent]');
  await page.waitForSelector('#plans [data-continue]:not([disabled])', { timeout });
};
// Orders are limited to 10 an hour per account and per address (server/ratelimit.js), and this file makes more than that in its one hour:
// a step that has to make an order after the many above clears the owner's two tallies first (the way test/http.test.mjs clears its own).
const freshOrders = async () => {
  for (const bucket of ['billing-order:id:u-bill-owner', `billing-order:ip:${addressGroup('127.0.0.1')}`, `billing-order:ip:${addressGroup('::1')}`]) await store.clearRateLimit(bucket);
};
const subscribe = async () => {
  await ready();
  await page.click('#plans [data-continue]');
};
// Cancelling an order asks once more in the page (never the browser's): the button, then the confirmation's own button.
const cancelOrder = async () => {
  await page.click('#plans [data-cancel]');
  await page.click('#plans [data-ask-confirm]');
};

section('the Upgrade plan row and the plan line');
{
  await page.waitForFunction(() => document.querySelector('.account__plan')?.textContent.trim(), null, { timeout: 8000 }).catch(() => {});
  check('"Free plan" sits under the name', (await page.evaluate(() => document.querySelector('.account__plan')?.textContent.trim())) === 'Free plan');
  check('  and the account button has the plan in its accessible name', /Free plan/.test(await page.getAttribute('#account-button', 'aria-label')));
  await openMenu(page);
  const rows = await menuRows(page);
  check('Upgrade plan is directly above View changelog', rows.indexOf('upgrade') >= 0 && rows.indexOf('upgrade') + 1 === rows.indexOf('changelog'), rows.join());
  check('  and says so', (await page.textContent('.plusmenu--account [data-row="upgrade"]')).includes('Upgrade plan'));
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans[open] .plans__card');
}

section('the plans sheet');
{
  await page.waitForFunction(() => document.querySelectorAll('#plans .plans__card').length === 4);
  const sheet = await page.evaluate(() => {
    const d = document.getElementById('plans');
    return {
      labelled: document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim(),
      cards: [...d.querySelectorAll('.plans__card')].map((c) => c.dataset.plan),
      note: d.querySelector('.plans__preview')?.textContent.trim(),
      radios: [...d.querySelectorAll('.plans__audience [role="radio"]')].map((r) => `${r.dataset.audience}:${r.textContent.trim()}:${r.getAttribute('aria-checked')}`),
      group: d.querySelector('.plans__audience')?.getAttribute('role'),
      periodAtTop: !!d.querySelector('.plans__body > [data-period], .plans__body > .plans__period'),
      cardParts: [...d.querySelectorAll('.plans__card')].map((c) => ({
        id: c.dataset.plan,
        icon: !!c.querySelector('svg.plans__icon[aria-hidden="true"]') && c.querySelector('svg.plans__icon')?.getAttribute('stroke') === 'currentColor',
        shapes: c.querySelector('svg.plans__icon')?.querySelectorAll('circle, path').length,
        tagline: c.querySelector('.plans__tagline')?.textContent.trim(),
        price: c.querySelector('.plans__price')?.textContent.replace(/\s+/g, ' ').trim(),
        billed: [...c.querySelectorAll('.plans__billed')].map((b) => b.textContent.trim()).join(' | '),
        ticks: c.querySelectorAll('.plans__lines li svg[aria-hidden="true"]').length,
        lead: c.querySelector('.plans__lead')?.textContent.trim() || '',
        toggle: !!c.querySelector('.plans__toggle[role="radiogroup"]'),
        terms: c.querySelector('.plans__terms')?.textContent.trim() || '',
        button: c.querySelector('[data-pick]').textContent.trim(),
      })),
      plus: d.querySelector('[data-plan="plus"]').textContent,
      free: d.querySelector('[data-plan="free"] [data-pick]').textContent.trim() + (d.querySelector('[data-plan="free"] [data-pick]').disabled ? ' (disabled)' : ''),
      rate: d.querySelector('.plans__rate')?.textContent,
      link: d.querySelector('.plans__rate a')?.href,
      all: d.textContent,
      save: [...d.querySelectorAll('.plans__toggle [data-period="year"] .plans__save')].map((x) => x.textContent.trim()),
    };
  });
  check('titled "Plans that grow with you", named by aria-labelledby', sheet.labelled === 'Plans that grow with you', sheet.labelled);
  check('four cards: Free, Plus, Pro, Max', sheet.cards.join() === 'free,plus,pro,max', sheet.cards.join());
  check('the preview note is at the top', sheet.note === 'Preview — only administrators see this.', sheet.note);
  check('Individual | Team is the segmented control, Individual first; no month/year at the top', sheet.group === 'radiogroup' && sheet.radios.join() === 'individual:Individual:true,team:Team:false' && !sheet.periodAtTop, sheet.radios.join());
  const byId = Object.fromEntries(sheet.cardParts.map((c) => [c.id, c]));
  check('each card has an icon of its own (line drawing, currentColor, hidden from readers) that grows richer from Free to Max', sheet.cardParts.every((c) => c.icon) && byId.free.shapes < byId.plus.shapes && byId.plus.shapes < byId.pro.shapes && byId.pro.shapes < byId.max.shapes, sheet.cardParts.map((c) => `${c.id}:${c.shapes}`).join());
  check('  and a tagline, a ticked list and the "Everything in … and:" lead-ins', sheet.cardParts.every((c) => c.tagline.length > 8 && c.ticks >= 4) && byId.free.lead === '' && byId.plus.lead === 'Everything in Free, and:' && byId.pro.lead === 'Everything in Plus, and:' && byId.max.lead === 'Everything in Pro, and:', sheet.cardParts.map((c) => `${c.id}:${c.ticks}:${c.lead}`).join(' '));
  check('the toggle is inside each paid card and not the Free one, with the saving worked out from the prices', !byId.free.toggle && byId.plus.toggle && byId.pro.toggle && byId.max.toggle && sheet.save.length === 3 && sheet.save.every((s) => s === 'Save 17%'), sheet.save.join());
  check('monthly: the price per month, then "billed monthly" and the đồng it is billed as', /^\$5 \/ month$/.test(byId.plus.price) && /^billed monthly \| billed as 128,000/.test(byId.plus.billed), `${byId.plus.price} / ${byId.plus.billed}`);
  check('"No commitment · Cancel any time" is under the monthly buttons of the paid plans only', byId.plus.terms === 'No commitment · Cancel any time' && byId.pro.terms === byId.plus.terms && byId.max.terms === byId.plus.terms && byId.free.terms === '', JSON.stringify(sheet.cardParts.map((c) => c.terms)));
  check('English shows USD large and "billed as" in đồng beneath', /\$5\b/.test(sheet.plus) && /billed as 128,000/.test(sheet.plus), sheet.plus.replace(/\s+/g, ' '));
  check('no daily figure anywhere (a month\'s allowance)', !/a day|per day|daily/i.test(sheet.all), '');
  check('the allowance is a month\'s: searches, computer hours, storage', /150 searches a month/.test(sheet.plus) && /4 h of computer time a month/.test(sheet.plus) && /3 GB storage/.test(sheet.plus), sheet.plus.replace(/\s+/g, ' '));
  check('the current plan\'s button is disabled "Current plan"', sheet.free === 'Current plan (disabled)', sheet.free);
  const pct = await page.evaluate(async () => {
    const { savePercent } = await import('/js/billing-plan-cards.js');
    return [savePercent({ usdCents: { month: 1000, year: 9000 } }), savePercent({ usdCents: { month: 500, year: 5000 } }), savePercent({ usdCents: { month: 500, year: 6000 } }), savePercent({})];
  });
  check('the saving is worked out from the prices, not written down (1000/9000 → 25, 500/5000 → 17, no saving → 0)', pct.join() === '25,17,0,0', pct.join());
  check('Plus, on a free account, is "Get Plus"', byId.plus.button === 'Get Plus', byId.plus.button);
  check('the rate is one line in Vietnam time, 24-hour and DD/MM/YYYY', /^Rate updated at \d\d:\d\d, \d\d\/\d\d\/\d{4}/.test((sheet.rate || '').replace(/\s+/g, ' ').trim()), (sheet.rate || '').replace(/\s+/g, ' '));
  check('  with the Exchange Rate API link on the day that is its rate in use', /exchangerate-api\.com/.test(sheet.link || '') && /Rates By Exchange Rate API/.test(sheet.rate), sheet.link);
  check('the pay-as-you-go prices follow', /400/.test(sheet.all) && /1 person/.test(sheet.all));
  await shot('plans');

  await page.click('#plans [data-plan="pro"] .plans__toggle [data-period="year"]');
  const yearly = await page.evaluate(() => {
    const card = (id) => document.querySelector(`#plans [data-plan="${id}"]`);
    return {
      plus: card('plus').querySelector('.plans__price').textContent.replace(/\s+/g, ' '),
      plusBilled: [...card('plus').querySelectorAll('.plans__billed')].map((b) => b.textContent.trim()).join(' | '),
      checked: ['plus', 'pro', 'max'].map((id) => card(id).querySelector('.plans__toggle [data-period="year"]').getAttribute('aria-checked')).join(),
      focusIn: document.activeElement?.closest('[data-plan]')?.dataset.plan + ':' + document.activeElement?.dataset.period,
      terms: document.querySelectorAll('#plans .plans__terms').length,
    };
  });
  check('choosing Yearly in one card switches all three, and the price lines', yearly.checked === 'true,true,true' && /^\$4\.17 \/ month$/.test(yearly.plus) && /^\$50 billed yearly \| billed as 1,275,000/.test(yearly.plusBilled), `${yearly.checked} ${yearly.plus} ${yearly.plusBilled}`);
  check('  focus stays in the card that was pressed', yearly.focusIn === 'pro:year', yearly.focusIn);
  check('  and "No commitment" goes with the month', yearly.terms === 0, String(yearly.terms));
  await page.click('#plans [data-plan="plus"] .plans__toggle [data-period="month"]');
  check('Monthly switches them back', (await page.getAttribute('#plans [data-plan="max"] .plans__toggle [data-period="month"]', 'aria-checked')) === 'true');
}

section('keyboard');
{
  // Everything the sheet offers is reached by Tab, and Tab stays inside it.
  // The tab stops are the visible, enabled controls that are not taken out of the order (a radio is one stop: the checked one).
  const wanted = await page.evaluate(() => [...document.querySelectorAll('#plans button, #plans a[href], #plans input, #plans [tabindex]')].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length).length);
  let outside = 0;
  for (let i = 0; i < wanted + 3; i += 1) {
    await page.keyboard.press('Tab');
    outside += await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 0; // focus left the page for the browser's own bar, as a modal dialog allows
      if (!el.closest('#plans')) return 1;
      el.setAttribute('data-tabseen', '');
      return 0;
    });
  }
  const reached = await page.evaluate(() => document.querySelectorAll('#plans [data-tabseen]').length);
  check('Tab never leaves the dialog', outside === 0, String(outside));
  check('  and reaches every control in it, exactly once each', reached === wanted, `${reached} of ${wanted}`);
  // The radios are one tab stop; arrows move between them.
  await page.focus('#plans [data-plan="plus"] .plans__toggle [aria-checked="true"]');
  await page.keyboard.press('ArrowRight');
  check('arrow keys move between Monthly and Yearly, in the card that has focus', (await page.getAttribute('#plans [data-plan="plus"] .plans__toggle [data-period="year"]', 'aria-checked')) === 'true' && (await page.evaluate(() => document.activeElement?.closest('[data-plan]')?.dataset.plan + ':' + document.activeElement?.dataset.period)) === 'plus:year');
  await page.keyboard.press('ArrowLeft');
  await page.focus('#plans .plans__audience [aria-checked="true"]');
  await page.keyboard.press('ArrowRight');
  check('and between Individual and Team', (await page.getAttribute('#plans [data-audience="team"]', 'aria-checked')) === 'true' && (await page.evaluate(() => document.activeElement?.dataset.audience)) === 'team');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Escape closes the sheet', !(await page.evaluate(() => document.getElementById('plans').open)));
}

section('the rate line: one line, no link unless Exchange Rate API is the source');
{
  const withRate = async (rate) => {
    await page.route('**/api/billing/plans', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, rate } });
    });
    await openMenu(page);
    await page.click('.plusmenu--account [data-row="upgrade"]');
    await page.waitForFunction(() => document.querySelectorAll('#plans .plans__card').length === 4 && !!document.querySelector('#plans .plans__rate'));
    const got = await page.evaluate(() => ({ text: document.querySelector('#plans .plans__rate').textContent.replace(/\s+/g, ' ').trim(), links: document.querySelectorAll('#plans .plans__rate a').length }));
    await page.unroute('**/api/billing/plans');
    await page.keyboard.press('Escape');
    return got;
  };
  // 23:00 UTC is 06:00 the next day in Vietnam, whatever the clock of the machine reading it.
  const frankfurter = await withRate({ rate: 25_736, source: 'frankfurter', at: '2026-11-16T23:00:00.000Z' });
  check('Frankfurter: "Rate updated at 06:00, 17/11/2026", no link', frankfurter.text === 'Rate updated at 06:00, 17/11/2026' && frankfurter.links === 0, JSON.stringify(frankfurter));
  const bank = await withRate({ rate: 25_400, source: 'vietcombank', at: '2026-01-05T17:30:00.000Z' });
  check('Vietcombank: the 24-hour clock across midnight, still no link', bank.text === 'Rate updated at 00:30, 06/01/2026' && bank.links === 0, JSON.stringify(bank));
  const erapi = await withRate({ rate: 25_500, source: 'erapi', at: '2026-11-16T23:00:00.000Z', attribution: 'x' });
  check('Exchange Rate API: the same line, with its link', erapi.text === 'Rate updated at 06:00, 17/11/2026 Rates By Exchange Rate API' && erapi.links === 1, JSON.stringify(erapi));
}

section('the Team tab: coming soon, and "Tell me when it opens" is kept once');
{
  const posts = [];
  const watch = (req) => {
    if (req.method() === 'POST' && /\/api\/billing\/team-interest/.test(req.url())) posts.push(req.url());
  };
  page.on('request', watch);
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card [data-pick]');
  await page.click('#plans [data-audience="team"]');
  const team = await page.evaluate(() => ({
    cards: document.querySelectorAll('#plans .plans__card').length,
    individual: document.querySelectorAll('#plans [data-plan]').length,
    title: document.querySelector('#plans .plans__card--team h3')?.textContent.trim(),
    button: document.querySelector('#plans [data-team-interest]')?.textContent.trim(),
    status: document.querySelector('#plans .plans__teamstatus')?.getAttribute('role'),
    said: document.querySelector('#plans .plans__teamstatus')?.textContent.trim(),
    seg: document.querySelector('#plans [data-audience="team"]')?.getAttribute('aria-checked'),
    rate: !!document.querySelector('#plans .plans__rate'),
  }));
  check('the Team tab is one card, "Team plans are coming soon", with "Tell me when it opens"', team.cards === 1 && team.individual === 0 && team.title === 'Team plans are coming soon' && team.button === 'Tell me when it opens' && team.seg === 'true' && !team.rate, JSON.stringify(team));
  check('  and its status line is a live region that starts empty', team.status === 'status' && team.said === '');
  await shot('team');
  await page.click('#plans [data-team-interest]');
  await page.waitForFunction(() => /Noted/.test(document.querySelector('#plans .plans__teamstatus')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check('pressing it says "Noted — we will tell you by email." in that same status line', (await page.textContent('#plans .plans__teamstatus')) === 'Noted — we will tell you by email.', await page.textContent('#plans .plans__teamstatus'));
  check('  one request, and focus stays on the button', posts.length === 1 && (await page.evaluate(() => document.activeElement?.hasAttribute('data-team-interest'))), String(posts.length));
  // aria-disabled keeps focus where it is; Playwright counts it as disabled, so the press is forced.
  await page.click('#plans [data-team-interest]', { force: true });
  await page.waitForTimeout(300);
  check('a second press makes no second request', posts.length === 1, String(posts.length));
  const kept = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).teamInterest);
  check('the account keeps it', kept === true);
  await page.keyboard.press('Escape');
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card [data-pick]');
  await page.click('#plans [data-audience="team"]');
  check('on a later visit it already says so', (await page.textContent('#plans .plans__teamstatus')) === 'Noted — we will tell you by email.');
  page.off('request', watch);
  await page.click('#plans [data-audience="individual"]');
  check('Individual brings the four cards back', (await page.locator('#plans .plans__card').count()) === 4);
  await page.keyboard.press('Escape');
}

section('a Team press whose answer comes after the sheet was closed and opened again');
{
  // The account is shown as not yet asked, and the answer is held back, so the sheet is closed and opened while it is on its way.
  // The second opening reads the account slowly, so the Team answer lands while that sheet has no data yet.
  let slow = false;
  await page.route('**/api/billing', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (slow) await new Promise((r) => setTimeout(r, 1800));
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), teamInterest: false } });
  });
  let sent = 0;
  await page.route('**/api/billing/team-interest', async (route) => {
    sent += 1;
    await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  const open = async () => {
    await openMenu(page);
    await page.click('.plusmenu--account [data-row="upgrade"]');
    await page.waitForSelector('#plans .plans__card [data-pick]');
    await page.click('#plans [data-audience="team"]');
  };
  // A toast is drawn inside the open dialog, and the sheet's next repaint wipes it: so errors are caught as they are added, not counted afterwards.
  await page.evaluate(() => {
    window.__errorToasts = [];
    new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast--error') && window.__errorToasts.push(n.textContent)))).observe(document.body, { childList: true, subtree: true });
  });
  const errorsBefore = page.errors.length;
  await open();
  await page.click('#plans [data-team-interest]');
  slow = true;
  await page.keyboard.press('Escape');
  await open();
  await page.waitForTimeout(800);
  check('no error toast and no uncaught error, and the new sheet is not told it was answered', sent === 1 && (await page.evaluate(() => window.__errorToasts.length)) === 0 && page.errors.length === errorsBefore && (await page.textContent('#plans .plans__teamstatus')) === '', `sent ${sent} ${await page.evaluate(() => window.__errorToasts.join(' | '))} ${page.errors.slice(errorsBefore).join(' | ')}`);
  await page.unroute('**/api/billing/team-interest');
  await page.unroute('**/api/billing');
  await page.keyboard.press('Escape');
}

section('Get Plus: Configure your plan');
{
  const puts = [];
  const orderPosts = [];
  const watch = (req) => {
    if (req.method() === 'PUT' && /\/api\/billing\/profile/.test(req.url())) puts.push(JSON.parse(req.postData() || '{}'));
    if (req.method() === 'POST' && /\/api\/billing\/orders$/.test(req.url())) orderPosts.push(req.postData());
  };
  page.on('request', watch);
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card [data-pick]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Get Plus');
  await page.click('#plans [data-plan="plus"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"] [data-consent]');
  const first = await page.evaluate(() => {
    const d = document.getElementById('plans');
    const cards = [...d.querySelectorAll('.checkout__period [role="radio"]')].map((r) => ({ period: r.dataset.period, checked: r.getAttribute('aria-checked'), text: r.textContent.replace(/\s+/g, ' ').trim(), badge: r.querySelector('.checkout__badge')?.textContent.trim() || '' }));
    const btn = d.querySelector('[data-continue]');
    const hint = document.getElementById(btn.getAttribute('aria-describedby') || '__none__');
    const consent = d.querySelector('.checkout__consent');
    return {
      title: document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim(),
      heading: d.querySelector('#co-plan')?.textContent.trim(),
      backLabel: d.querySelector('[data-back]')?.getAttribute('aria-label'),
      group: d.querySelector('.checkout__period')?.getAttribute('role'),
      cards,
      form: !!d.querySelector('form[data-profile]'),
      fields: [...d.querySelectorAll('form[data-profile] input')].map((i) => `${i.name}:${d.querySelector(`label[for="${i.id}"]`)?.textContent.trim() || 'NO LABEL'}`),
      method: d.querySelector('.checkout__method')?.textContent.replace(/\s+/g, ' ').trim(),
      lines: d.querySelector('.checkout__lines').textContent.replace(/\s+/g, ' '),
      tax: !!d.querySelector('.checkout__tax'),
      renew: d.querySelector('.checkout__renew')?.textContent.replace(/\s+/g, ' ').trim(),
      all: d.textContent,
      subscribe: btn.textContent.trim(),
      subscribeOff: btn.disabled,
      hint: hint?.textContent.trim() || '',
      consentText: consent?.textContent.replace(/\s+/g, ' ').trim(),
      consentTicked: d.querySelector('[data-consent]').checked,
      terms: consent?.querySelector('a')?.getAttribute('href'),
      note: !!d.querySelector('.plans__preview'),
    };
  });
  const expectDate = (when) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(when);
  check('the dialog is "Configure your plan", with a back arrow named for where it goes', first.title === 'Configure your plan' && first.backLabel === 'Back to plans', JSON.stringify([first.title, first.backLabel]));
  check('two radio cards, monthly chosen; the yearly one carries "Save 17%" and the monthly one does not', first.group === 'radiogroup' && first.cards.length === 2 && first.cards[0].period === 'month' && first.cards[0].checked === 'true' && first.cards[1].checked === 'false' && first.cards[1].badge === 'Save 17%' && first.cards[0].badge === '' && /Plus monthly/.test(first.cards[0].text) && /Billed monthly/.test(first.cards[0].text) && /Plus yearly/.test(first.cards[1].text) && /Billed yearly/.test(first.cards[1].text), JSON.stringify(first.cards));
  check('the billing information is an inline form: seven fields, each labelled', first.form && first.fields.length === 7 && first.fields.every((f) => !f.includes('NO LABEL')) && ['name', 'email', 'country', 'address', 'company', 'tax', 'invoiceName'].every((n) => first.fields.some((f) => f.startsWith(`${n}:`))), first.fields.join());
  check('  with the optional ones marked and no Save button (it is saved with the order)', /Company name \(optional\)/.test(first.fields.join()) && /Other name on the invoice \(optional\)/.test(first.fields.join()) && !/Save/.test(first.all.replace(/Save 17%/g, '')), first.fields.join());
  check('the payment method is VietQR bank transfer through SePay', /Payment method/.test(first.method) && /VietQR/.test(first.method) && /SePay/.test(first.method), first.method);
  check('the summary: plan, the line, Subtotal and Total due today; no tax line without BILLING_TAX_RATE', /Plus/.test(first.heading) && /Plus, Monthly/.test(first.lines) && /Subtotal/.test(first.lines) && /Total due today/.test(first.lines) && /128,000/.test(first.lines) && !first.tax && !/VAT/.test(first.all), `${first.heading} / ${first.lines}`);
  const { en } = await import('../public/js/locales/en.js');
  const { vi } = await import('../public/js/locales/vi.js');
  check('the order locks its rate on the server, but no "locked rate" line is shown, and its words are gone from both languages', !/Locked at|1 USD =/i.test(first.all) && !('billing.checkout.rate' in en) && !('billing.checkout.rate' in vi) && !Object.values(vi).some((v) => /Chốt tỷ giá/.test(v)), '');
  check('the auto-renew box names the real date (a month on, DD/MM/YYYY, Vietnam time) and the QR three days before', first.renew === `Your plan renews on ${expectDate(periodEnd(new Date(), 'month'))} from your balance. If the balance is short, we email you a QR code 3 days before.`, first.renew);
  check('the consent box is not ticked, and its words name the renewal, the Terms and where to cancel', !first.consentTicked && /renews each period from my balance until I cancel/.test(first.consentText) && /Settings → Billing/.test(first.consentText) && first.terms === '/terms.html', `${first.consentText} ${first.terms}`);
  check('Subscribe is off until it is ticked, and says why to a screen reader', first.subscribe === 'Subscribe' && first.subscribeOff && first.hint === 'Tick the box above to subscribe.', JSON.stringify([first.subscribe, first.subscribeOff, first.hint]));
  check('the preview note repeats at checkout', first.note);
  const wide = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    return { form: r('#plans form[data-profile]'), summary: r('#plans .checkout__summary'), cards: r('#plans .checkout__period') };
  });
  check('wide: two columns, the choices and the form on the left, the summary card on the right', wide.summary.left >= wide.form.right - 1 && wide.summary.left > wide.cards.right - 1 && Math.abs(wide.summary.top - wide.cards.top) < 80, JSON.stringify(wide));

  // Radio cards switch the summary, by pointer and by arrow key.
  const total = () => page.textContent('#plans .checkout__total dd');
  const monthTotal = await total();
  await page.click('#plans .checkout__period [data-period="year"]');
  const yearView = await page.evaluate(() => ({ total: document.querySelector('#plans .checkout__total dd').textContent, lines: document.querySelector('#plans .checkout__lines').textContent.replace(/\s+/g, ' '), renew: document.querySelector('#plans .checkout__renew').textContent, checked: document.querySelector('#plans .checkout__period [aria-checked="true"]').dataset.period }));
  check('choosing yearly changes the summary (line, total) and the renewal date to a year on', yearView.checked === 'year' && /Plus, Yearly/.test(yearView.lines) && yearView.total !== monthTotal && /\d,\d{3},000/.test(yearView.total) && yearView.renew.includes(expectDate(periodEnd(new Date(), 'year'))), JSON.stringify(yearView));
  await page.focus('#plans .checkout__period [data-period="year"]');
  await page.keyboard.press('ArrowLeft');
  check('the arrow keys move the choice, and the summary follows', (await page.getAttribute('#plans .checkout__period [data-period="month"]', 'aria-checked')) === 'true' && (await total()) === monthTotal && (await page.evaluate(() => document.activeElement?.dataset?.period)) === 'month');

  // Nothing is sent until the box is ticked, and an empty form says what is missing.
  await page.evaluate(() => document.querySelector('#plans [data-continue]').click());
  await page.waitForTimeout(250);
  check('pressing a disabled Subscribe does nothing', orderPosts.length === 0 && puts.length === 0 && (await page.locator('#plans .pay__qr').count()) === 0);
  await page.focus('#plans [data-consent]');
  await page.keyboard.press('Space');
  check('the consent box is reachable and ticked from the keyboard, and then Subscribe is on', (await page.isChecked('#plans [data-consent]')) && (await page.getAttribute('#plans [data-continue]', 'disabled')) === null);
  await page.click('#plans [data-continue]');
  await page.waitForSelector('#plans form[data-profile] [role="alert"]');
  check('an empty form says what is missing, saves nothing and makes no order', (await page.textContent('#plans form[data-profile] [role="alert"]')).length > 5 && orderPosts.length === 0 && puts.length === 0);
  await page.fill('#bill-name', 'Typed Name');
  await page.click('#plans .checkout__period [data-period="year"]');
  check('what was typed survives choosing yearly, but the box is cleared: it was ticked for another amount', (await page.inputValue('#bill-name')) === 'Typed Name' && !(await page.isChecked('#plans [data-consent]')) && (await page.getAttribute('#plans [data-continue]', 'disabled')) !== null);
  await page.click('#plans .checkout__period [data-period="month"]');
  check('  and going back to the first amount does not bring the tick back', !(await page.isChecked('#plans [data-consent]')));
  await page.fill('#bill-name', 'Nguyen Van A');
  await page.fill('#bill-email', 'a@example.com');
  await page.fill('#bill-country', 'vn');
  await page.fill('#bill-address', '1 Le Loi, Ho Chi Minh City');
  await page.fill('#bill-company', 'ABC Co');
  await page.fill('#bill-tax', '0312345678');
  await page.fill('#bill-invoiceName', 'ABC Accounts');
  await page.check('#plans [data-consent]');
  await shot('checkout');
  await page.click('#plans [data-continue]');
  await page.waitForSelector('#plans .pay__qr img');
  check('Subscribe saves the form with the order: one PUT with every field, then one order', puts.length === 1 && puts[0].name === 'Nguyen Van A' && puts[0].companyName === 'ABC Co' && puts[0].invoiceName === 'ABC Accounts' && puts[0].taxCode === '0312345678' && orderPosts.length === 1, JSON.stringify([puts, orderPosts]));
  const stored = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).profile);
  check('  and the information is kept on the account', stored?.name === 'Nguyen Van A' && stored.country === 'VN' && stored.companyName === 'ABC Co' && stored.invoiceName === 'ABC Accounts', JSON.stringify(stored));
  page.off('request', watch);
}

section('Continue: the QR, the copy buttons, the countdown');
let orderId = '';
{
  // The order was made by Subscribe at the end of the section above.
  await page.waitForSelector('#plans .pay__qr img');
  const qr = await page.evaluate(() => {
    const d = document.getElementById('plans');
    const img = d.querySelector('.pay__qr img');
    return {
      order: d.dataset.order,
      alt: img.alt,
      src: img.src,
      loaded: img.complete && img.naturalWidth > 0,
      rows: [...d.querySelectorAll('[data-copy]')].map((b) => b.dataset.copy),
      labels: [...d.querySelectorAll('[data-copy]')].map((b) => b.getAttribute('aria-label')),
      timer: d.querySelector('.pay__timer')?.textContent.trim(),
      status: d.querySelector('.pay__status')?.getAttribute('role'),
      statusText: d.querySelector('.pay__status')?.textContent.trim(),
      holder: d.textContent.includes('SYNAPSEZ TEST'),
    };
  });
  orderId = qr.order;
  check('the QR picture has alt text and actually loads (the page\'s policy lets qr.sepay.vn in)', qr.alt.length > 8 && qr.loaded && /^https:\/\/qr\.sepay\.vn\/img\?/.test(qr.src), `${qr.alt} / ${qr.src}`);
  check('bank, account, holder, amount and content each have a copy button', qr.rows.length === 5 && qr.holder, qr.rows.join());
  check('  each named for what it copies', qr.labels.every((l) => l && l.length > 4), qr.labels.join());
  check('a mm:ss countdown from 30 minutes', /^(29|30):\d\d$/.test(qr.timer), qr.timer);
  check('a status line that is announced, and empty while the order waits (no "waiting for your transfer" sentence)', qr.status === 'status' && qr.statusText === '' && !/Waiting for your transfer/i.test(await page.textContent('#plans')), qr.statusText);
  await page.click('#plans [data-copy="content"]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('copy puts the payment content on the clipboard', /^SZ\d{10}$/.test(clip), clip);
  check('  and says so', await page.evaluate(() => /copied/i.test(document.body.textContent)));
  await shot('qr');
}

section('a transfer arrives');
{
  const sim = await page.evaluate(async (id) => {
    const res = await fetch('/api/admin/billing/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: id }) });
    return { status: res.status, body: await res.json() };
  }, orderId);
  check('the owner simulates the transfer', sim.status === 200 && sim.body.outcome, JSON.stringify(sim));
  const started = Date.now();
  await page.waitForFunction(() => /You're on Plus/.test(document.querySelector('#plans .pay__done')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const done = await page.evaluate(() => ({ text: document.querySelector('#plans .pay__done')?.textContent.replace(/\s+/g, ' ').trim(), timer: !!document.querySelector('#plans .pay__timer') }));
  check('within one poll the page says "You\'re on Plus"', /You're on Plus/.test(done.text || ''), `${done.text} (${Date.now() - started} ms)`);
  check('  the countdown is gone', !done.timer);
  await page.waitForFunction(() => document.querySelector('.account__plan')?.textContent.trim() === 'Plus', null, { timeout: 5000 }).catch(() => {});
  check('  and the plan line under the name reads Plus', (await page.textContent('.account__plan')).trim() === 'Plus');
  await shot('done');
  // No poll after it is over.
  let more = 0;
  page.on('request', (req) => {
    if (/\/api\/billing\/orders\//.test(req.url())) more += 1;
  });
  await page.waitForTimeout(6000);
  check('the poll has stopped', more === 0, String(more));
  await page.click('#plans [data-done]');
  check('Done closes the dialog', !(await page.evaluate(() => document.getElementById('plans').open)));
}

section('the saved information comes back, an edit is kept, and the box is ticked afresh each time');
{
  const puts = [];
  const watch = (req) => {
    if (req.method() === 'PUT' && /\/api\/billing\/profile/.test(req.url())) puts.push(JSON.parse(req.postData() || '{}'));
  };
  page.on('request', watch);
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]:not([disabled])');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-consent]');
  const back = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#plans form[data-profile] input')].map((i) => [i.name, i.value])));
  check('a second checkout is prefilled from the saved profile, email included', back.name === 'Nguyen Van A' && back.email === 'a@example.com' && back.country === 'VN' && back.address === '1 Le Loi, Ho Chi Minh City' && back.company === 'ABC Co' && back.tax === '0312345678' && back.invoiceName === 'ABC Accounts', JSON.stringify(back));
  check('  and the consent box is not ticked again just because it was before', !(await page.isChecked('#plans [data-consent]')));
  await page.check('#plans [data-consent]');
  // Focus is read after the sheet's own reload has repainted it (the reload replaces the nodes, so a focus set before it is lost):
  // wait for both answers the back arrow asks for, then a beat for the repaint that follows them.
  const reloaded = Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/billing')), page.waitForResponse((r) => r.url().endsWith('/api/billing/plans'))]);
  await page.click('#plans [data-back]');
  await reloaded;
  await page.waitForTimeout(150);
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]:not([disabled])');
  check('the back arrow returns to the plans sheet, with focus on its title (not lost to the page)', (await page.locator('#plans .plans__cards').count()) === 1 && (await page.locator('#plans [data-view="sheet"]').count()) === 1 && (await page.evaluate(() => document.activeElement?.id)) === 'plans-title', await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-consent]');
  check('a new checkout asks for the consent again', !(await page.isChecked('#plans [data-consent]')) && (await page.getAttribute('#plans [data-continue]', 'disabled')) !== null);
  await page.fill('#bill-address', '2 Tran Hung Dao, Hanoi');
  // The box is unticked while the information is still being saved: no order may follow (the consent is read again after the wait).
  const orders = [];
  const seeOrders = (req) => {
    if (req.method() === 'POST' && /\/api\/billing\/orders$/.test(req.url())) orders.push(req.url());
  };
  page.on('request', seeOrders);
  await page.route('**/api/billing/profile', async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    return route.continue();
  });
  await freshOrders();
  await page.check('#plans [data-consent]');
  await page.click('#plans [data-continue]');
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('#plans [data-consent]').click());
  await page.waitForTimeout(1500);
  await page.unroute('**/api/billing/profile');
  check('unticking the box while the information is being saved stops the order', puts.length === 1 && orders.length === 0 && (await page.locator('#plans .pay__qr').count()) === 0 && !(await page.isChecked('#plans [data-consent]')), JSON.stringify([puts.length, orders.length]));
  check('  and the back arrow is usable again, without ticking anything (it was drawn disabled while the information was saved)', await page.locator('#plans [data-back]').isEnabled());
  check('  with focus on the consent box it was unticked from, not lost to the page', await page.evaluate(() => document.activeElement?.hasAttribute('data-consent')));
  page.off('request', seeOrders);
  await page.check('#plans [data-consent]');
  await page.click('#plans [data-continue]');
  await page.waitForSelector('#plans .pay__qr img');
  check('an edit made at checkout is saved with the order (one PUT, the new address, the rest kept)', puts.length === 1 && puts[0].address === '2 Tran Hung Dao, Hanoi' && puts[0].name === 'Nguyen Van A' && puts[0].companyName === 'ABC Co', JSON.stringify(puts));
  page.off('request', watch);
  await cancelOrder();
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]:not([disabled])');
  await page.keyboard.press('Escape');
}

section('the tick is for an amount: two periods the balance covers are still two amounts');
{
  // A balance that covers both periods makes both "due today" 0 ₫, while what is taken from the balance differs about tenfold: the
  // tick must not follow the shared 0 from one period to the other. A second administrator, so the owner's balance stays as the later sections count it.
  await store.createUser({ id: 'u-bill-rich', email: 'rich@test.local', name: 'Rich', username: 'bill.rich', passwordHash: await hashPassword(password), role: 'admin' });
  await setPrefs('u-bill-rich', { language: 'en', onboarded: true });
  await store.creditBalance('u-bill-rich', 5_000_000, { kind: 'topup', topup: true });
  const richContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const rich = await signIn(richContext, 'rich@test.local');
  await openMenu(rich);
  await rich.click('.plusmenu--account [data-row="upgrade"]');
  await rich.waitForSelector('#plans .plans__card [data-pick="plus"]:not([disabled])');
  await rich.click('#plans [data-plan="plus"] [data-pick]');
  await rich.waitForSelector('#plans [data-consent]');
  const due = () => rich.evaluate(() => document.querySelector('#plans .checkout__total dd')?.textContent.replace(/\s+/g, ' ').trim() || '');
  await rich.check('#plans [data-consent]');
  const monthDue = await due();
  await rich.click('#plans .checkout__period [data-period="year"]');
  const yearDue = await due();
  check('with the balance covering both, each period is due 0 ₫ today', /^0\s/.test(monthDue) && /^0\s/.test(yearDue), JSON.stringify([monthDue, yearDue]));
  check('  yet choosing the other period clears the tick, and Subscribe goes off', !(await rich.isChecked('#plans [data-consent]')) && (await rich.getAttribute('#plans [data-continue]', 'disabled')) !== null);
  await richContext.close();
}

section('the tax line, only when the seller sets a rate');
{
  const lineFor = async () => {
    await openMenu(page);
    await page.click('.plusmenu--account [data-row="upgrade"]');
    await page.waitForSelector('#plans .plans__card [data-pick="pro"]:not([disabled])');
    await page.click('#plans [data-plan="pro"] [data-pick]');
    await page.waitForSelector('#plans [data-consent]');
    return page.evaluate(() => ({ tax: document.querySelector('#plans .checkout__tax')?.textContent.replace(/\s+/g, ' ').trim() || '', subtotal: [...document.querySelectorAll('#plans .checkout__lines > div')].find((r) => /Subtotal/.test(r.textContent))?.querySelector('dd').textContent || '' }));
  };
  const none = await lineFor();
  check('no BILLING_TAX_RATE: no tax line', none.tax === '', JSON.stringify(none));
  await page.keyboard.press('Escape');
  const hadRate = process.env.BILLING_TAX_RATE;
  process.env.BILLING_TAX_RATE = '10';
  let withTax;
  try {
    withTax = await lineFor();
  } finally {
    if (hadRate === undefined) delete process.env.BILLING_TAX_RATE;
    else process.env.BILLING_TAX_RATE = hadRate;
  }
  const sub = Number(withTax.subtotal.replace(/[^\d]/g, ''));
  const part = Math.round((sub * 10) / 110);
  check('BILLING_TAX_RATE=10: "Of which VAT 10%" with the tax inside the subtotal, as the receipt works it out', sub > 0 && withTax.tax.startsWith('Of which VAT 10%') && Number(withTax.tax.replace(/Of which VAT 10%/, '').replace(/[^\d]/g, '')) === part, JSON.stringify(withTax));
  await page.keyboard.press('Escape');
}

section('what the server only schedules, a late answer, a typed form, a double click');
{
  const puts = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/billing\/subscription/.test(req.url())) puts.push(req.postData());
  });
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Switch to Plus yearly');
  const monthly = await page.evaluate(() => ({
    note: document.querySelector('#plans [data-plan="plus"] .plans__note')?.textContent.trim(),
    notes: document.querySelectorAll('#plans .plans__note').length,
    badge: document.querySelector('#plans [data-plan="plus"] .plans__badge')?.textContent.trim(),
    action: document.querySelector('#plans [data-plan="plus"] [data-pick]').dataset.action,
    off: document.querySelector('#plans [data-plan="plus"] [data-pick]').disabled,
  }));
  check('a member on Plus monthly: the Plus card marks it, shows the info box and offers "Switch to Plus yearly" (not disabled)', monthly.note === 'You pay monthly. Pay yearly to save 17%.' && monthly.notes === 1 && monthly.badge === 'Current plan' && monthly.action === 'switch-year' && !monthly.off, JSON.stringify(monthly));
  await page.click('#plans [data-plan="plus"] [data-pick]');
  await page.waitForSelector('#plans .checkout__lines');
  check('  and the button opens the checkout on yearly', (await page.getAttribute('#plans .checkout__period [data-period="year"]', 'aria-checked')) === 'true' && /Yearly/.test(await page.textContent('#plans .checkout__lines')) === true);
  await page.click('#plans [data-back]');
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]');
  await page.click('#plans [data-plan="plus"] .plans__toggle [data-period="year"]');
  await page.click('#plans [data-plan="plus"] [data-pick]');
  await page.waitForSelector('#plans .checkout__lines');
  await page.waitForSelector('#plans [data-consent]');
  await page.check('#plans [data-consent]');
  const sched = await page.evaluate(() => ({
    month: document.querySelector('#plans .checkout__period [data-period="month"]').disabled,
    year: document.querySelector('#plans .checkout__period [data-period="year"]').getAttribute('aria-checked'),
    cont: document.querySelector('#plans [data-continue]').disabled,
    total: document.querySelector('#plans .checkout__total dd').textContent,
    why: document.querySelector('#plans .checkout__period [data-period="month"]').textContent.replace(/\s+/g, ' '),
    named: document.querySelector('#plans .checkout__period [data-period="month"]').getAttribute('aria-labelledby'),
    whyId: document.getElementById(document.querySelector('#plans .checkout__period [data-period="month"]').getAttribute('aria-describedby') || '__none__')?.textContent.trim(),
  }));
  check('  and the disabled card says why, to everyone, not just by being grey', /Changes at renewal/.test(sched.why) && sched.whyId === 'Changes at renewal. Choose it from the plans.' && !sched.named.includes('why'), JSON.stringify(sched));
  check('Plus monthly to yearly: the Monthly radio is off (the server only schedules it) and yearly is chosen', sched.month && sched.year === 'true', JSON.stringify(sched));
  check('  Continue is live, for a total that is not 0', !sched.cont && !/^0\s/.test(sched.total), JSON.stringify(sched));
  await page.click('#plans [data-back]');
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]');

  // Closing, or going back, while the order is being made leaves no clock and no poll behind.
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await ready();
  const calls = [];
  const watch = (req) => calls.push(`${req.method()} ${new URL(req.url()).pathname}`);
  await page.route('**/api/billing/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((r) => setTimeout(r, 1500));
    return route.continue();
  });
  page.on('request', watch);
  await page.click('#plans [data-continue]');
  const backBusy = await page.evaluate(() => document.querySelector('#plans [data-back]').disabled);
  check('Back is off while the order is being made', backBusy);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2200);
  const left = await page.evaluate(() => ({ open: document.getElementById('plans').open, order: document.getElementById('plans').dataset.order || '', pay: !!document.querySelector('#plans .pay') }));
  check('Esc during creation: it stays shut, nothing is drawn on it', !left.open && !left.order && !left.pay, JSON.stringify(left));
  await page.waitForTimeout(6000);
  page.off('request', watch);
  await page.unroute('**/api/billing/orders');
  check('  no status poll runs on the shut dialog, and the order made too late is closed', !calls.some((c) => /^GET \/api\/billing\/orders\/[^/]+$/.test(c)) && calls.filter((c) => /^POST \/api\/billing\/orders\/.+\/cancel$/.test(c)).length === 1, calls.join(' | '));

  // A double click on Confirm changes the plan once, and Keep my plan is one request.
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="free"] [data-pick]')?.textContent.trim() === 'Changes at renewal');
  puts.length = 0;
  await page.click('#plans [data-plan="free"] [data-pick]');
  await page.waitForSelector('#plans [data-confirm]');
  await page.dblclick('#plans [data-confirm]');
  await page.waitForFunction(() => /ends on/i.test(document.querySelector('#plans .plans__scheduled')?.textContent || ''));
  check('the lower plan is confirmed first, then one PUT /subscription', puts.length === 1 && JSON.parse(puts[0]).cancelAtEnd === true, puts.join(' | '));
  check('  a double click raises no error', (await page.evaluate(() => document.querySelectorAll('.toast--error').length)) === 0 && page.errors.length === 0, page.errors.join(' | '));
  puts.length = 0;
  await page.click('#plans [data-withdraw]');
  await page.waitForFunction(() => !document.querySelector('#plans .plans__scheduled'));
  check('Keep my plan withdraws it in one request', puts.length === 1 && puts[0] === '{"cancelAtEnd":false}', puts.join(' | '));
  await page.keyboard.press('Escape');
}

section('short payment, expiry, cancel');
{
  // A lower plan is changed at renewal, after a confirm: the sheet says so and nothing is charged.
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Switch to Plus yearly');
  check('the plan in force is marked "Current plan"; Free offers the change at renewal', (await page.textContent('#plans [data-plan="free"] [data-pick]')).trim() === 'Changes at renewal');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"]');
  const quoted = await page.textContent('#plans .checkout__lines');
  check('an upgrade shows the unused part of Plus as a credit', /credit/i.test(quoted), quoted.replace(/\s+/g, ' '));

  // The status answers are stood in for here: a short payment, then silence until the clock runs out.
  // The status line is one node for the whole wait (a replaced node is often not announced), and focus is left alone.
  let answer = { status: 'pending', receivedVnd: 50000, dueVnd: 50000, plan: 'pro' };
  await page.route('**/api/billing/orders/*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) }) : route.fallback()));
  await subscribe();
  await page.waitForSelector('#plans .pay__qr img');
  await page.evaluate(() => { window.__status = document.querySelector('#plans .pay__status'); document.querySelector('#plans [data-copy="content"]').focus(); });
  await page.waitForFunction(() => /Received/.test(document.querySelector('#plans .pay__status')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const short = await page.evaluate(() => ({ text: document.querySelector('#plans .pay__status').textContent.replace(/\s+/g, ' '), src: document.querySelector('#plans .pay__qr img').src }));
  check('a short payment says what arrived and what is still to transfer', /Received 50,000/.test(short.text) && /50,000.*still to transfer/.test(short.text), short.text);
  check('  with a fresh QR for what is left', /amount=50000\b/.test(short.src), short.src);
  answer = { status: 'expired', receivedVnd: 0, dueVnd: 0, plan: 'pro' };
  await page.waitForFunction(() => /Expired/.test(document.querySelector('#plans .pay__status')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const expired = await page.evaluate(() => ({ text: document.querySelector('#plans .pay__status').textContent.replace(/\s+/g, ' '), timer: !!document.querySelector('#plans .pay__timer:not([hidden])') }));
  check('an expired order says any money that arrives goes to the balance', /Expired — any money that arrives goes to your balance/.test(expired.text), expired.text);
  const kept = await page.evaluate(() => ({ same: window.__status === document.querySelector('#plans .pay__status') && window.__status.isConnected, focus: document.activeElement?.dataset?.copy || document.activeElement?.tagName }));
  check('the status line is the same node through short payment and expiry, and focus did not move', kept.same && kept.focus === 'content', JSON.stringify(kept));
  check('  the time left is gone and Back is offered', await page.evaluate(() => document.querySelector('#plans .pay__time').hidden && !!document.querySelector('#plans .pay__foot [data-back]')));

  // Money taken and given back is its own ending, not "waiting" and not "expired". The status above is a stand-in: the order is
  // really still open on the server, and Back now looks for an open order first, so it is closed there the way a real expiry would.
  await store.cancelOrder(await page.evaluate(() => document.getElementById('plans').dataset.order), 'u-bill-owner');
  answer = { status: 'refunded', receivedVnd: 0, dueVnd: 0, plan: 'pro' };
  await page.click('#plans [data-back]');
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]:not([disabled])');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await ready();
  await page.click('#plans [data-continue]');
  await page.waitForFunction(() => /balance/.test(document.querySelector('#plans .pay__status')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const refunded = await page.evaluate(() => ({ text: document.querySelector('#plans .pay__status').textContent, timer: document.querySelector('#plans .pay__time').hidden }));
  check('a refunded order ends the wait and says the money went to the balance', /added to your balance/.test(refunded.text) && !/Waiting|Expired/.test(refunded.text) && refunded.timer, refunded.text);
  await page.unroute('**/api/billing/orders/*');
  await store.cancelOrder(await page.evaluate(() => document.getElementById('plans').dataset.order), 'u-bill-owner');
  await page.click('#plans [data-back]');
  await page.waitForSelector('#plans .plans__card');
  await page.click('#plans [data-plan="max"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"]');
  await subscribe();
  await page.waitForSelector('#plans .pay__qr img');
  const open = await page.evaluate(() => document.getElementById('plans').dataset.order);
  await cancelOrder();
  await page.waitForSelector('#plans .plans__card');
  const cancelled = await page.evaluate(async (id) => (await (await fetch(`/api/billing/orders/${id}`)).json()).status, open);
  check('Cancel closes the order and returns to the plans', cancelled === 'cancelled', cancelled);
  await page.keyboard.press('Escape');
}

section('card columns: four when wide, two when medium, one on a phone');
{
  const lefts = () => page.evaluate(() => new Set([...document.querySelectorAll('#plans .plans__card')].map((c) => Math.round(c.getBoundingClientRect().left))).size);
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card');
  check('wide (1280 px): four columns', (await lefts()) === 4, String(await lefts()));
  for (const width of [800, 700, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    check(`medium (${width} px): exactly two columns, never three plus one`, (await lefts()) === 2, String(await lefts()));
  }
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(200);
  check('phone (360 px): one column', (await lefts()) === 1, String(await lefts()));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press('Escape');
}

section('narrow screens');
{
  await page.setViewportSize({ width: 360, height: 740 });
  await openMenu(page).catch(async () => {
    await page.click('#sidebar-open').catch(() => {});
    await openMenu(page);
  });
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card');
  await page.waitForTimeout(150);
  const narrow = await page.evaluate(() => {
    const d = document.getElementById('plans');
    const body = d.querySelector('.sheet__body');
    const cards = [...d.querySelectorAll('.plans__card')].map((c) => Math.round(c.getBoundingClientRect().left));
    return { page: document.documentElement.scrollWidth <= window.innerWidth, dialog: d.scrollWidth <= d.clientWidth + 1, body: body.scrollWidth <= body.clientWidth + 1, stacked: new Set(cards).size === 1 };
  });
  check('the sheet does not scroll sideways at 360 px', narrow.page && narrow.dialog && narrow.body, JSON.stringify(narrow));
  check('  the cards stack', narrow.stacked, JSON.stringify(narrow));
  await page.click('#plans [data-audience="team"]');
  const narrowTeam = await page.evaluate(() => {
    const body = document.querySelector('#plans .sheet__body');
    return { page: document.documentElement.scrollWidth <= window.innerWidth, body: body.scrollWidth <= body.clientWidth + 1 };
  });
  check('  nor does the Team tab', narrowTeam.page && narrowTeam.body, JSON.stringify(narrowTeam));
  await page.click('#plans [data-audience="individual"]');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"] [data-consent]');
  const checkout = await page.evaluate(() => {
    const d = document.getElementById('plans');
    const body = d.querySelector('.sheet__body');
    return { page: document.documentElement.scrollWidth <= window.innerWidth, body: body.scrollWidth <= body.clientWidth + 1 };
  });
  check('nor does the checkout', checkout.page && checkout.body, JSON.stringify(checkout));
  const phone = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const form = r('#plans form[data-profile]');
    const summary = r('#plans .checkout__summary');
    const fields = [...document.querySelectorAll('#plans form[data-profile] input')].map((i) => i.getBoundingClientRect());
    return { below: summary.top >= form.bottom - 1, sameLeft: Math.abs(summary.left - form.left) < 2, inside: fields.every((f) => f.left >= 0 && f.right <= window.innerWidth), button: r('#plans [data-continue]').right <= window.innerWidth };
  });
  check('  on a phone the summary card goes under the form, every field and the button inside the screen', phone.below && phone.sameLeft && phone.inside && phone.button, JSON.stringify(phone));
  await shot('narrow');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  // The phone's drawer was opened to reach the account; put it away before the desktop layout.
  await page.evaluate(() => document.getElementById('scrim')?.click());
  await page.waitForTimeout(200);
}

section('no exchange rate: nothing can be bought');
{
  await page.route('**/api/billing/plans', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, rate: null, plans: body.plans.map((p) => ({ ...p, vnd: null })) } });
  });
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card');
  const down = await page.evaluate(() => ({
    note: document.querySelector('#plans .plans__rate')?.textContent,
    buy: [...document.querySelectorAll('#plans [data-action="buy"]')].map((b) => b.disabled),
    prices: document.querySelectorAll('#plans .plans__price').length,
  }));
  check('the prices give way to the "rates are down" line, and no buy button works', /exchange rate could not be read/.test(down.note || '') && down.buy.length > 0 && down.buy.every(Boolean) && down.prices === 0, JSON.stringify(down));
  await page.unroute('**/api/billing/plans');
  await page.keyboard.press('Escape');
}

// Both themes: the new text and the two button fills come from theme tokens, so each has to be measured in each.
for (const theme of ['light', 'dark']) {
  section(`${theme} theme`);
  await page.evaluate((name) => document.documentElement.setAttribute('data-theme', name), theme);
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card');
  const contrast = await page.evaluate(() => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const backdrop = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.length === 3 || c[3] > 0.9) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    return [...document.querySelectorAll('#plans .plans__preview, #plans .plans__tagline, #plans .plans__terms, #plans .plans__note, #plans .plans__badge, #plans .plans__lead, #plans [role="radio"], #plans .plans__price, #plans .plans__per, #plans .plans__billed, #plans .plans__lines li, #plans .plans__rate, #plans .plans__payg, #plans [data-pick]:not(:disabled):not(.btn--primary)')].map((el) => {
      const a = lum(parse(getComputedStyle(el).color).slice(0, 3));
      const b = lum(backdrop(el));
      return ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
    });
  });
  // The primary buttons are white on the house gradient (see .btn--primary), which one measurement cannot describe, so they are left out.
  check(`text on the sheet reads at 4.5:1 or better in the ${theme} theme`, contrast.length > 8 && Math.min(...contrast) >= 4.5, contrast.map((c) => c.toFixed(1)).join());
  // The resting state is measured above; hover has its own rules (.btn:hover once painted grey under text of the same lightness).
  // color-mix() is reported as color(srgb 0.9 0.9 0.9), in 0..1, where rgb() is in 0..255.
  const ratio = (c1, c2) => {
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number).slice(0, 3).map((v) => { v = c.startsWith('color(') ? v : v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const a = lum(c1);
    const b = lum(c2);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const hovered = {};
  for (const kind of ['paid', 'free']) {
    const sel = `#plans .plans__cta--${kind}:not(:disabled)`;
    await page.hover(sel);
    await page.waitForTimeout(300);
    const s = await page.evaluate((q) => { const st = getComputedStyle(document.querySelector(q)); return { color: st.color, bg: st.backgroundColor }; }, sel);
    hovered[kind] = Number(ratio(s.color, s.bg).toFixed(1));
  }
  await page.mouse.move(0, 0);
  check(`the paid and Free buttons keep their label readable (4.5:1) on hover in the ${theme} theme`, hovered.paid >= 4.5 && hovered.free >= 4.5, JSON.stringify(hovered));
  // A disabled one keeps its resting fill and label on hover too (.btn:hover is (0,2,0) and used to lighten the fill under the paid label).
  const heldOnHover = {};
  for (const kind of ['paid', 'free']) {
    const sel = `#plans .plans__cta--${kind}`;
    const look = (q) => page.evaluate((s) => { const st = getComputedStyle(document.querySelector(s)); return `${st.color}|${st.backgroundColor}|${st.borderColor}`; }, q);
    await page.evaluate((q) => { document.querySelector(q).disabled = true; }, sel);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    const rest = await look(sel);
    await page.hover(sel);
    await page.waitForTimeout(300);
    heldOnHover[kind] = { rest, hover: await look(sel) };
    await page.evaluate((q) => { document.querySelector(q).disabled = false; }, sel);
  }
  await page.mouse.move(0, 0);
  check(`a disabled paid or Free button keeps its colours on hover in the ${theme} theme`, heldOnHover.paid.rest === heldOnHover.paid.hover && heldOnHover.free.rest === heldOnHover.free.hover, JSON.stringify(heldOnHover));
  await shot(theme);
  await page.keyboard.press('Escape');
}

/* ── Task 10: Settings → Billing and the administrators' card ─────────── */
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
const OWNER = 'u-bill-owner';
// A wait that can fail without throwing, so the check after it counts instead of aborting the run.
const ok = (promise) => promise.then(() => true, () => false);
// Orders are limited to 10 an hour per account (server/ratelimit.js) and this whole file is one hour: the sections above make about 8 and
// the ones below a few more, so the limiter is cleared (freshOrders) before the steps that need to make one. A new one counts against it.
await freshOrders();
const text = (selector) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), selector);
const gotoTab = async (p, tab) => {
  if (!(await p.evaluate(() => document.getElementById('settings').open))) {
    await openMenu(p);
    await p.click('.plusmenu--account [data-row="settings"]');
    await p.waitForSelector('#settings[open]');
  }
  await p.click(`#tab-${tab}`);
};
const billingReady = () => page.waitForFunction(() => !!document.querySelector('#billing-panel [data-sec="plan"] h4') && !document.querySelector('#billing-panel [data-loading]'), null, { timeout: 8000 });
const reopenBilling = async () => {
  await page.click('#tab-usage');
  await page.click('#tab-billing');
  await billingReady();
};

section('the QR keeps its order: closing never ends it, every way in goes back to the same code, a reload too');
let kept = { code: '', amount: '', order: '' };
{
  await freshOrders();
  const notes = () => page.evaluate(() => [...document.querySelectorAll('#toasts .toast, #toasts-alert .toast')].map((n) => n.textContent).filter((x) => /stays open for another/.test(x)));
  const view = () =>
    page.evaluate(() => {
      const d = document.getElementById('plans');
      return { open: d.open, view: d.querySelector('[data-view]')?.dataset.view || '', code: d.querySelector('#pay-content')?.textContent.trim() || '', amount: d.querySelector('#pay-amount')?.textContent.trim() || '', timer: d.querySelector('.pay__timer')?.textContent.trim() || '', cards: d.querySelectorAll('.plans__card').length, order: d.dataset.order || '', status: d.querySelector('.pay__status')?.textContent.trim() ?? null };
    });
  const secs = (clock) => {
    const [m, s] = clock.split(':').map(Number);
    return m * 60 + s;
  };
  const toPay = async () => {
    await openMenu(page);
    await page.click('.plusmenu--account [data-row="upgrade"]');
    await page.waitForSelector('#plans .pay__qr img');
    return view();
  };
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]:not([disabled])');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await subscribe();
  await page.waitForSelector('#plans .pay__qr img');
  const first = await view();
  kept = { code: first.code, amount: first.amount, order: first.order };
  await page.waitForTimeout(2200);
  await page.click('#plans [data-close]');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  // The note is said by the dialog's `close` event, which the browser queues after `open` turns false: wait for the note
  // itself, or it is read a frame early (a wrong red in 2 runs of 10). A note that never comes still fails the checks below.
  await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast, #toasts-alert .toast')].some((n) => /stays open for another/.test(n.textContent)), null, { timeout: 3000 }).catch(() => {});
  const said = await notes();
  const left = said[0] ? secs(said[0].match(/(\d\d:\d\d)/)?.[1] || '00:00') : 0;
  check('closing with an order pending says so once, quietly, and where to reopen it', said.length === 1 && /^Your order stays open for another \d\d:\d\d — reopen it from Settings → Billing\.$/.test(said[0]), said.join(' | '));
  check('  the time in it is what is really left, not the whole 30 minutes', left <= secs(first.timer) - 2 && left >= secs(first.timer) - 9, `${said[0]} / first ${first.timer}`);
  const again = await toPay();
  check('"Upgrade plan" goes straight back to the same QR: the same code and amount, not the plans', again.view === 'pay' && again.code === first.code && again.amount === first.amount && again.order === first.order && again.cards === 0, JSON.stringify(again));
  check('  the clock kept running from the order\'s own deadline (not from 30:00 again)', secs(again.timer) <= secs(first.timer) - 2 && secs(again.timer) > 25 * 60, `${first.timer} -> ${again.timer}`);
  check('  no "waiting" sentence, and the status line is there but empty', again.status === '');
  // A second between the two closes: the same words are not shown twice, and the time left is part of them.
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await page.waitForFunction((first) => [...document.querySelectorAll('#toasts .toast, #toasts-alert .toast')].some((n) => /stays open for another/.test(n.textContent) && n.textContent !== first), said[0], { timeout: 3000 }).catch(() => {});
  check('closing with Esc says it too (a note with the time then left, said once)', (await notes()).filter((n) => n !== said[0]).length === 1, `${(await notes()).join(' | ')} (first: ${said[0]})`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const reloaded = await toPay();
  check('after a reload the same QR comes back: the server holds the order', reloaded.code === first.code && reloaded.amount === first.amount && reloaded.cards === 0 && secs(reloaded.timer) < secs(first.timer), JSON.stringify(reloaded));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);

  // The Billing tab says there is an order, and its button is the way to the QR.
  await gotoTab(page, 'billing');
  await billingReady();
  await page.waitForSelector('#billing-panel [data-sec="pending"]:not([hidden]) [data-pending-left]');
  const card = await page.evaluate(() => {
    const s = document.querySelector('#billing-panel [data-sec="pending"]');
    return { first: document.querySelector('#billing-panel [data-sec]:not([hidden])')?.dataset.sec, heading: s.querySelector('h4')?.textContent.trim(), text: s.textContent.replace(/\s+/g, ' ').trim(), button: s.querySelector('[data-pending-view]')?.textContent.trim(), labelled: s.getAttribute('aria-labelledby') === s.querySelector('h4')?.id };
  });
  check('Settings → Billing shows "Order waiting for payment" first: the plan, the amount, the time left, and "Show QR code"', card.first === 'pending' && card.heading === 'Order waiting for payment' && /Pro · Monthly · [\d,]+\s₫/.test(card.text) && /\d\d:\d\d left/.test(card.text) && card.button === 'Show QR code' && card.labelled, JSON.stringify(card));
  const t1 = await text('[data-pending-left]');
  await page.waitForTimeout(2100);
  check('  and its time left runs down on its own', (await text('[data-pending-left]')) !== t1, t1);
  await page.click('#billing-panel [data-pending-view]');
  await page.waitForSelector('#plans .pay__qr img');
  const fromCard = await view();
  check('"Show QR code" opens the QR sheet on that order', fromCard.code === first.code && fromCard.amount === first.amount, JSON.stringify(fromCard));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await page.click('#billing-panel [data-adjust]');
  await page.waitForSelector('#plans .pay__qr img');
  check('so does "Adjust plan" in the plan card: the order is not lost to a second one', (await view()).code === first.code);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
}

section('Cancel this order: bottom right, red outline, and it asks first, in the page, before it does anything');
{
  // Read from the store: the status route answers a given order once a second at most.
  const orderStatus = async (id) => (await store.getOrder(id))?.status;
  const dialogs = [];
  const onDialog = (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  };
  page.on('dialog', onDialog);
  await page.click('#billing-panel [data-pending-view]');
  await page.waitForSelector('#plans .pay__qr img');
  const look = await page.evaluate(() => {
    const btn = document.querySelector('#plans [data-cancel]');
    const cs = getComputedStyle(btn);
    const probe = document.createElement('i');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    const b = btn.getBoundingClientRect();
    const body = document.querySelector('#plans .sheet__body').getBoundingClientRect();
    const qr = document.querySelector('#plans .pay__qr').getBoundingClientRect();
    return { border: cs.borderTopColor, color: cs.color, width: cs.borderTopWidth, bg: cs.backgroundColor, danger, right: body.right - b.right, leftHalf: b.left > body.left + body.width / 2, belowQr: b.top > qr.bottom, text: btn.textContent.trim() };
  });
  check('the button is "Cancel this order", bottom right (under the QR, at the right edge)', look.text === 'Cancel this order' && look.leftHalf && look.belowQr && look.right < 40, JSON.stringify(look));
  check('  with a red outline (the theme\'s danger colour, 1px or more) and no fill', look.border === look.danger && look.color === look.danger && parseFloat(look.width) >= 1 && /rgba\(0, 0, 0, 0\)|transparent/.test(look.bg), JSON.stringify(look));
  for (const theme of ['dark', 'light']) {
    await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme);
    const ratio = await page.evaluate(() => {
      const rgb = (c) => c.match(/[\d.]+/g).map(Number).slice(0, 3);
      const lum = (c) => {
        const [r, g, b] = rgb(c).map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = getComputedStyle(document.querySelector('#plans [data-cancel]')).color;
      const bg = getComputedStyle(document.getElementById('plans')).backgroundColor;
      const a = lum(fg);
      const b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    check(`  and it reads at 4.5:1 or better in the ${theme} theme`, ratio >= 4.5, ratio.toFixed(2));
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

  // Pressing it only asks.
  await page.click('#plans [data-cancel]');
  const ask = await page.evaluate(() => {
    const a = document.querySelector('#plans [data-ask]');
    const named = (attr) => document.getElementById(a?.getAttribute(attr) || '')?.textContent.trim();
    return { role: a?.getAttribute('role'), label: named('aria-labelledby'), desc: named('aria-describedby'), text: a?.querySelector('p')?.textContent.replace(/\s+/g, ' ').trim(), focus: document.activeElement?.textContent.trim(), buttons: [...(a?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()) };
  });
  check('pressing it opens a labelled alert dialog in the page, with the safe answer first and focused', ask.role === 'alertdialog' && ask.label === 'Cancel this order?' && /already transferred/.test(ask.desc || '') && ask.buttons.join() === 'Keep the order,Cancel the order' && ask.focus === 'Keep the order', JSON.stringify(ask));
  check('  its words are the spec\'s, and the browser\'s own confirm was never used', ask.text === 'Cancel this order? If you have already transferred, do not cancel — money that arrives later is still added to your balance.' && dialogs.length === 0, `${ask.text} / ${dialogs.join()}`);
  check('  and nothing is cancelled by pressing it', (await orderStatus(kept.order)) === 'pending');

  // Tab stays between the two answers.
  await page.keyboard.press('Tab');
  const second = await page.evaluate(() => document.activeElement?.textContent.trim());
  await page.keyboard.press('Tab');
  const wrapped = await page.evaluate(() => document.activeElement?.textContent.trim());
  check('Tab moves between the two answers and wraps (it does not wander off behind the question)', second === 'Cancel the order' && wrapped === 'Keep the order', `${second} / ${wrapped}`);

  // Esc closes the question only.
  await page.keyboard.press('Escape');
  const afterEsc = await page.evaluate(() => ({ open: document.getElementById('plans').open, ask: !!document.querySelector('#plans [data-ask]'), view: document.querySelector('#plans [data-view]')?.dataset.view, focus: document.activeElement?.hasAttribute('data-cancel') }));
  check('Esc closes the question and only that: the QR sheet stays, focus returns to Cancel this order', afterEsc.open && !afterEsc.ask && afterEsc.view === 'pay' && afterEsc.focus, JSON.stringify(afterEsc));
  check('  and the order is still pending', (await orderStatus(kept.order)) === 'pending');

  // "Keep the order" answers as Esc did.
  await page.click('#plans [data-cancel]');
  await page.click('#plans [data-ask-keep]');
  const afterKeep = await page.evaluate(() => ({ open: document.getElementById('plans').open, ask: !!document.querySelector('#plans [data-ask]'), focus: document.activeElement?.hasAttribute('data-cancel') }));
  check('"Keep the order" closes the question, keeps the sheet, and focus returns to the button that asked', afterKeep.open && !afterKeep.ask && afterKeep.focus && (await orderStatus(kept.order)) === 'pending', JSON.stringify(afterKeep));

  // Only the confirmation's own button cancels.
  const stays = () => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((n) => n.textContent).filter((x) => /stays open/.test(x)));
  const notesBefore = await stays();
  await page.click('#plans [data-cancel]');
  await page.click('#plans [data-ask-confirm]');
  await page.waitForSelector('#plans .plans__card');
  check('"Cancel the order" cancels it: the order is cancelled and the sheet is back at the plans', (await orderStatus(kept.order)) === 'cancelled' && (await page.locator('#plans [data-view="sheet"]').count()) === 1);
  check('  and the browser\'s own confirm was still never used', dialogs.length === 0, dialogs.join());
  page.off('dialog', onDialog);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await page.waitForSelector('#billing-panel [data-sec="pending"][hidden]', { state: 'attached' });
  check('the Billing card is gone with the order', await page.evaluate(() => document.querySelector('#billing-panel [data-sec="pending"]').hidden));
  check('  and focus is on something in the Billing tab, not lost to the page, now that the button that opened the sheet is gone', await page.evaluate(() => !!document.activeElement?.closest('#billing-panel')), await page.evaluate(() => document.activeElement?.tagName));
  const afterNotes = await stays();
  check('an order that was cancelled leaves no new "stays open" note behind', afterNotes.every((n) => notesBefore.includes(n)), afterNotes.join(' | '));
}

section('a top-up resumes the same way, and an order that ended opens the plans as before');
{
  await freshOrders();
  await gotoTab(page, 'billing');
  await billingReady();
  await page.click('[data-add-credits]');
  await page.fill('#bill-amount', '100000');
  await page.click('[data-topup-go]');
  await page.waitForSelector('#plans .pay__qr img');
  const topup = await page.evaluate(() => ({ code: document.querySelector('#plans #pay-content')?.textContent.trim(), order: document.getElementById('plans').dataset.order }));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await page.waitForSelector('#billing-panel [data-sec="pending"]:not([hidden]) [data-pending-view]');
  const card = await text('#billing-panel [data-sec="pending"]');
  check('the Billing card names a top-up, with its amount', /Top-up · 100,000\s₫/.test(card) && /Show QR code/.test(card), card);
  await page.click('#billing-panel [data-pending-view]');
  await page.waitForSelector('#plans .pay__qr img');
  check('"Show QR code" returns to the top-up\'s own code', (await page.textContent('#plans #pay-content')).trim() === topup.code);
  await page.click('#plans [data-cancel]');
  await page.click('#plans [data-ask-confirm]');
  await page.waitForSelector('#plans .plans__card');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await page.evaluate(() => document.getElementById('settings').close());
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card [data-pick]');
  check('with nothing open any more, "Upgrade plan" opens the plans sheet as it always did', (await page.locator('#plans .pay__qr').count()) === 0 && (await page.locator('#plans .plans__card').count()) === 4);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await freshOrders();
}

section('one guarded way into an order: a failed read refuses, Try again resumes, /plans failing alone refuses nothing, the QR says why it is back');
{
  await freshOrders();
  const posts = [];
  const watch = (req) => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/billing/orders') posts.push(req.postData()); };
  const unreadable = (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Billing is busy.' }) }) : route.fallback());
  const pendingIds = async () => (await store.listOrders({ userId: OWNER, status: 'pending', limit: 50 })).map((o) => o.id);
  const addCredits = async (amount) => {
    await page.click('[data-add-credits]');
    await page.fill('#bill-amount', String(amount));
    await page.click('[data-topup-go]');
  };
  const closeSheet = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('plans').open);
  };
  const shown = () => page.evaluate(() => ({ code: document.querySelector('#plans #pay-content')?.textContent.trim() ?? null, order: document.getElementById('plans').dataset.order, note: document.querySelector('#plans [data-pay-note]')?.textContent.trim() ?? null }));
  const NOTE = 'You already have an order waiting — pay or cancel it before starting a new one.';
  await gotoTab(page, 'billing');
  await billingReady();
  page.on('request', watch);

  // Nothing open, the account unreadable.
  await page.route('**/api/billing', unreadable);
  await addCredits(100000);
  await page.waitForSelector('#plans[open] [data-retry]');
  check('Add credits with the account unreadable refuses: the failure and Try again, and no order is made', posts.length === 0 && (await pendingIds()).length === 0 && /busy/.test(await text('#plans .plans__error')), `${posts.length}`);
  await page.unroute('**/api/billing');
  await page.click('#plans [data-retry]');
  await page.waitForSelector('#plans .pay__qr img');
  const first = await shown();
  check('Try again goes through the same door and, with the read working, makes the one order (no line: nothing was open)', posts.length === 1 && (await pendingIds()).join() === first.order && first.note === null, JSON.stringify(first));
  await closeSheet();

  // An order open, the account unreadable: refuse, then Try again resumes the same QR.
  await page.route('**/api/billing', unreadable);
  await addCredits(200000);
  await page.waitForSelector('#plans[open] [data-retry]');
  check('with an order open and the account unreadable, Add credits refuses too: nothing new is made and the open order is untouched', posts.length === 1 && (await pendingIds()).join() === first.order && (await page.locator('#plans .pay__qr').count()) === 0);
  await page.unroute('**/api/billing');
  await page.click('#plans [data-retry]');
  await page.waitForSelector('#plans .pay__qr img');
  const again = await shown();
  check('Try again goes to the QR of the order that is open: the same code, and no second order', again.order === first.order && again.code === first.code && posts.length === 1 && (await pendingIds()).length === 1, JSON.stringify(again));
  check('  and says why it is back', again.note === NOTE, String(again.note));
  await closeSheet();

  // The prices failing alone refuse nothing: a top-up asks only for the account.
  await page.route('**/api/billing/plans', unreadable);
  await addCredits(200000);
  await page.waitForSelector('#plans .pay__qr img');
  const viaPrices = await shown();
  check('with /plans failing alone, Add credits still goes to the open order', viaPrices.order === first.order && posts.length === 1 && viaPrices.note === NOTE, JSON.stringify(viaPrices));
  await store.cancelOrder(first.order, OWNER);
  await closeSheet();
  await addCredits(100000);
  await page.waitForSelector('#plans .pay__qr img');
  const second = await shown();
  check('  and with nothing open it still makes its order', posts.length === 2 && second.order !== first.order && second.note === null, JSON.stringify(second));
  await page.unroute('**/api/billing/plans');
  await closeSheet();

  // Upgrade plan and the card's own button, with the order open.
  await page.evaluate(() => document.getElementById('settings').close());
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .pay__qr img');
  const viaUpgrade = await shown();
  check('Upgrade plan with an order open shows its QR and says why', viaUpgrade.order === second.order && viaUpgrade.note === NOTE, JSON.stringify(viaUpgrade));
  await closeSheet();
  await page.evaluate(() => document.getElementById('settings').close());
  await page.route('**/api/billing', unreadable);
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans[open] [data-retry]');
  check('Upgrade plan with the account unreadable shows the failure with Try again, not the plans', (await page.locator('#plans .plans__card').count()) === 0);
  await page.unroute('**/api/billing');
  await page.click('#plans [data-retry]');
  await page.waitForSelector('#plans .pay__qr img');
  check('  and Try again goes to the open order, not to the plans', (await shown()).order === second.order);
  await closeSheet();
  await gotoTab(page, 'billing');
  await billingReady();
  await page.waitForSelector('#billing-panel [data-sec="pending"]:not([hidden]) [data-pending-view]');
  await page.click('#billing-panel [data-pending-view]');
  await page.waitForSelector('#plans .pay__qr img');
  const viaCard = await shown();
  check('the Billing card\'s own "Show QR code" says nothing: it asked for this order', viaCard.order === second.order && viaCard.note === null, JSON.stringify(viaCard));
  await closeSheet();

  // The server's backstop: a part-paid order is never shut by a new one. The page hides the order from its first read, so the guard lets
  // the order through and the 409 is what it meets; it then shows what the server said and offers the open order.
  await store.addOrderReceived(second.order, 40000);
  let hide = 1;
  await page.route('**/api/billing', async (route) => {
    if (route.request().method() !== 'GET' || hide <= 0) return route.fallback();
    hide -= 1;
    const res = await route.fetch();
    return route.fulfill({ response: res, json: { ...(await res.json()), pending: null } });
  });
  const before = posts.length;
  await addCredits(200000);
  await page.waitForSelector('#plans .pay__qr img');
  const viaConflict = await shown();
  check('a part-paid order met as a 409: the open order\'s QR comes back, with the line, and nothing was made', posts.length === before + 1 && viaConflict.order === second.order && viaConflict.note === NOTE && (await pendingIds()).join() === second.order, JSON.stringify(viaConflict));
  await page.unroute('**/api/billing');
  await store.cancelOrder(second.order, OWNER);
  await closeSheet();
  page.off('request', watch);
  await freshOrders();
}

section('the Billing card follows its order: Add credits while one is open, paid or cancelled elsewhere, a clock that runs ahead, Settings closed');
{
  await freshOrders();
  const requests = [];
  const seen = (req) => {
    const u = new URL(req.url());
    if (req.method() === 'GET' && (u.pathname === '/api/billing' || u.pathname.startsWith('/api/billing/orders/'))) requests.push(u.pathname);
  };
  const topUp = async (amount) => {
    await page.click('[data-add-credits]');
    await page.fill('#bill-amount', String(amount));
    await page.click('[data-topup-go]');
    await page.waitForSelector('#plans .pay__qr img');
    return page.evaluate(() => ({ code: document.querySelector('#plans #pay-content')?.textContent.trim(), order: document.getElementById('plans').dataset.order }));
  };
  const openCount = async () => (await store.listOrders({ userId: OWNER, status: 'pending', limit: 50 })).length;
  const card = () => page.evaluate(() => !document.querySelector('#billing-panel [data-sec="pending"]').hidden);
  await gotoTab(page, 'billing');
  await billingReady();
  const one = await topUp(100000);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  const before = await openCount();
  const two = await topUp(200000);
  const after = await openCount();
  check('"Add credits" with an order open goes back to that order\'s QR: the same code, and no second order is made', two.code === one.code && two.order === one.order && after === before, JSON.stringify([one, two, before, after]));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await page.waitForSelector('#billing-panel [data-sec="pending"]:not([hidden])');

  // Cancelled somewhere else (another device, the owner of the account): the card ends on its own, within a poll or two.
  await store.cancelOrder(one.order, OWNER);
  const gone = await ok(page.waitForSelector('#billing-panel [data-sec="pending"][hidden]', { state: 'attached', timeout: 14000 }));
  check('an order that ends while the sheet is shut ends its card within a poll or two, without a press', gone && !(await card()));

  // A browser clock that runs ahead of the server's: the server still offers the order, the card must not read for ever.
  const forged = { id: 'skewed-order', kind: 'topup', plan: null, period: null, code: 'SZ0000000000', totalVnd: 100000, status: 'pending', expiresAt: new Date(Date.now() - 5000).toISOString(), receivedVnd: 0, dueVnd: 100000, qr: { image: 'https://qr.sepay.vn/img?acc=1&bank=B&amount=100000&des=SZ0000000000', bank: 'B', account: '1', holder: 'H', amount: 100000, content: 'SZ0000000000' } };
  await page.route('**/api/billing', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...(await response.json()), pending: forged } });
  });
  page.on('request', seen);
  await page.click('#tab-usage');
  await page.click('#tab-billing');
  await billingReady();
  await page.waitForTimeout(6000);
  const reads = requests.filter((p) => p === '/api/billing').length;
  check('with the clock past the order\'s end and the server still offering it, the tab reads at most twice (the open and one more), not for ever', reads >= 1 && reads <= 2, String(reads));
  check('  and the card is not left claiming time that has passed', !(await card()));
  page.off('request', seen);
  await page.unroute('**/api/billing');

  // Settings shut: nothing keeps asking.
  await page.click('#tab-usage');
  await page.click('#tab-billing');
  await billingReady();
  const live = await topUp(100000);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await page.waitForSelector('#billing-panel [data-sec="pending"]:not([hidden])');
  await page.evaluate(() => document.getElementById('settings').close());
  requests.length = 0;
  page.on('request', seen);
  await page.waitForTimeout(7000);
  check('once Settings is closed no request goes out for the card (no status question, no read)', requests.length === 0, requests.join());
  page.off('request', seen);
  await store.cancelOrder(live.order, OWNER);
  await freshOrders();
}

section('a member has no Billing tab, and a link to it lands elsewhere');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  ctx.on('request', (req) => {
    if (/\/api\/(admin\/)?billing/.test(req.url())) calls.push(req.url());
  });
  const member = await signIn(ctx, 'member@test.local');
  await openMenu(member);
  await member.click('.plusmenu--account [data-row="settings"]');
  await member.waitForSelector('#settings[open]');
  check('the tab is hidden for a member', await member.evaluate(() => document.getElementById('tab-billing')?.hidden === true));
  await member.evaluate(() => document.getElementById('settings').close());
  await member.goto(`http://127.0.0.1:${PORT}/#settings/billing`, { waitUntil: 'domcontentloaded' });
  await member.reload({ waitUntil: 'domcontentloaded' });
  await member.waitForSelector('#model-chip');
  await member.waitForTimeout(800);
  const landed = await member.evaluate(() => ({ open: document.getElementById('settings').open, panel: document.getElementById('panel-billing')?.classList.contains('is-active') === true }));
  check('#settings/billing does not show the Billing panel', !landed.panel, JSON.stringify(landed));
  await member.evaluate(() => document.getElementById('settings')?.close?.());
  check('a member makes no billing request at all, not even from the link', calls.length === 0, calls.join());
  await ctx.close();
}

section('the Billing tab: after Usage, with the plan and the balance');
await gotoTab(page, 'usage');
{
  const order = await page.evaluate(() => [...document.querySelectorAll('#settings .sheet__tabs .tab')].filter((t) => !t.hidden).map((t) => t.dataset.tab));
  check('Billing sits right after Usage', order.indexOf('billing') === order.indexOf('usage') + 1 && order.includes('billing'), order.join());
  await page.click('#tab-billing');
  await billingReady();
  const plan = await text('#billing-panel [data-sec="plan"]');
  check('the preview note is at the top', /Preview — only administrators see this/.test(await text('#billing-panel')));
  check('the Plan card names the plan and when it renews, from the balance', /Plus/.test(plan) && /Renews .+ from your balance/.test(plan), plan);
  check('Total available starts at 0', /Total available/.test(await text('[data-sec="credits"]')) && /^0\s/.test(await text('[data-sec="credits"] .bill__total-amount')), await text('[data-sec="credits"] .bill__total-amount'));
  check('the Payment method says bank transfer by QR and that nothing is charged automatically', /bank transfer/i.test(await text('[data-sec="payment"]')) && /nothing is charged automatically/i.test(await text('[data-sec="payment"]')), await text('[data-sec="payment"]'));
  check('This period has a row for searches, cloud computer and storage', (await page.locator('[data-sec="period"] [data-kind]').count()) === 3 && /free/i.test(await text('[data-sec="period"]')));
  check('no daily figure anywhere on the tab', !/a day|per day|daily/i.test(await text('#billing-panel')));
  await shot('billing-tab');
}

section('Add credits: a failed order can be tried again, and the same amount is asked');
{
  await page.click('[data-add-credits]');
  check('the form opens with three presets and focus in the amount box', (await page.locator('[data-preset]').count()) === 3 && (await page.evaluate(() => document.activeElement?.id)) === 'bill-amount');
  await page.fill('#bill-amount', '10');
  await page.click('[data-topup-go]');
  check('an amount under the smallest is refused in words, on the box', /100,000/.test(await text('#bill-amount-err')) && (await page.getAttribute('#bill-amount', 'aria-invalid')) === 'true', await text('#bill-amount-err'));
  await page.fill('#bill-amount', '');
  await page.focus('#bill-amount');
  await page.keyboard.type('e');
  await page.click('[data-topup-go]');
  check('letters in the amount box say so (badInput)', /number/i.test(await text('#bill-amount-err')), await text('#bill-amount-err'));
  await page.fill('#bill-amount', '5000000');
  await page.click('[data-topup-go]');
  check('an amount that would take the balance past the ceiling is refused', /1,000,000/.test(await text('#bill-amount-err')), await text('#bill-amount-err'));
  await page.click('[data-preset="100000"]');
  check('a preset fills the box', (await page.inputValue('#bill-amount')) === '100000');

  const bodies = [];
  let failNext = true;
  await page.route('**/api/billing/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    bodies.push(route.request().postData());
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Bank transfer is busy.' }) });
    }
    return route.fallback();
  });
  await page.click('[data-topup-go]');
  await page.waitForSelector('#plans[open] [data-retry]');
  check('the failure is said inside the sheet', /busy/.test(await text('#plans .plans__error')), await text('#plans .plans__error'));
  await page.click('#plans [data-retry]');
  await page.waitForSelector('#plans .pay__qr img');
  await page.unroute('**/api/billing/orders');
  check('Try again made the top-up again, for the same amount', bodies.length === 2 && bodies.every((b) => JSON.parse(b).kind === 'topup' && JSON.parse(b).amountVnd === 100000), bodies.join(' | '));
  const topupOrder = await page.evaluate(() => document.getElementById('plans').dataset.order);
  const sim = await page.evaluate(async (id) => (await fetch('/api/admin/billing/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: id }) })).status, topupOrder);
  check('the owner plays the bank', sim === 200);
  await page.waitForFunction(() => /added to your balance/.test(document.querySelector('#plans .pay__done')?.textContent || ''), null, { timeout: 9000 });
  await page.click('#plans [data-done]');
  await page.waitForFunction(() => /^100,000\s/.test(document.querySelector('[data-sec="credits"] .bill__total-amount')?.textContent.trim() || ''), null, { timeout: 5000 }).catch(() => {});
  check('with the tab still open, the Total available shows the top-up (the sheet told the tab)', /^100,000\s/.test(await text('[data-sec="credits"] .bill__total-amount')), await text('[data-sec="credits"] .bill__total-amount'));
  const tx = await text('[data-sec="tx"]');
  check('Recent transactions lists it, with the balance after', /Top-up/.test(tx) && /\+100,000/.test(tx) && /Balance 100,000/.test(tx), tx);
}

section('Recent transactions: chips, paging, and a charge that nets to nothing');
{
  await page.route('**/api/billing/transactions*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const url = new URL(route.request().url());
    if (url.searchParams.get('kind') !== 'usage') return route.fulfill({ response: res, json: body });
    const day = '2026-11-14';
    const entries = [
      { id: 9001, kind: 'usage', category: 'search', day, units: 0, deltaVnd: 0, ref: null, note: null, createdAt: new Date().toISOString(), balanceAfterVnd: 100000 },
      { id: 9000, kind: 'usage', category: 'search', day, units: 2, deltaVnd: -800, ref: null, note: null, createdAt: new Date().toISOString(), balanceAfterVnd: 99200 },
    ];
    return route.fulfill({ response: res, json: { entries, next: null } });
  });
  await page.click('[data-chip="usage"]');
  await page.waitForFunction(() => document.querySelector('[data-chip="usage"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('[data-sec="tx"] .bill__tx li').length > 0);
  check('a usage row of 0 units is not listed, the one that charged is', (await page.locator('[data-sec="tx"] .bill__tx li').count()) === 1 && /−800/.test(await text('[data-sec="tx"] .bill__tx')), await text('[data-sec="tx"] .bill__tx'));
  await page.unroute('**/api/billing/transactions*');
  await page.click('[data-chip="topup"]');
  await page.waitForFunction(() => document.querySelector('[data-chip="topup"]')?.getAttribute('aria-pressed') === 'true');
  check('the Top-ups chip lists top-ups only', (await page.locator('[data-sec="tx"] .bill__tx li').count()) >= 1 && !/Plan/.test(await text('[data-sec="tx"] .bill__tx')));
  check('the chips are a labelled group of toggle buttons', (await page.getAttribute('[data-sec="tx"] [role="group"]', 'aria-label')) !== null && (await page.locator('[data-chip]').count()) === 4);
  await page.click('[data-chip="all"]');
}

section('Redeem a promo code');
{
  const made = await page.evaluate(async () => (await fetch('/api/admin/billing/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'WELCOME2026', creditVnd: 20000, maxUses: 5 }) })).status);
  check('the owner made a code', made === 201);
  await page.fill('#bill-promo', 'nonsense1');
  await page.click('[data-redeem]');
  await page.waitForFunction(() => /did not work/.test(document.querySelector('#bill-promo-msg')?.textContent || ''));
  check('a code that does not work says so, in an alert', (await page.getAttribute('#bill-promo-msg', 'role')) === 'alert');
  await page.fill('#bill-promo', 'welcome2026');
  await page.click('[data-redeem]');
  await page.waitForFunction(() => /^120,000\s/.test(document.querySelector('[data-sec="credits"] .bill__total-amount')?.textContent.trim() || ''), null, { timeout: 5000 }).catch(() => {});
  check('a good code adds its credit to the Total available', /^120,000\s/.test(await text('[data-sec="credits"] .bill__total-amount')), await text('[data-sec="credits"] .bill__total-amount'));
  check('  and says how much', /20,000/.test(await text('#bill-promo-msg')), await text('#bill-promo-msg'));
  check('  and the box is empty again', (await page.inputValue('#bill-promo')) === '');
}

section('Plan: adjust, auto-renew, cancel and keep, the low-balance email');
{
  await page.click('[data-adjust]');
  check('Adjust plan opens the plans sheet', await ok(page.waitForSelector('#plans[open] .plans__card', { timeout: 5000 })));
  await page.keyboard.press('Escape');
  check('Esc puts focus back on the button that opened it', await page.evaluate(() => document.activeElement?.hasAttribute('data-adjust')));

  const puts = [];
  const watchPuts = (req) => {
    if (req.method() === 'PUT' && /\/api\/billing\//.test(req.url())) puts.push(`${new URL(req.url()).pathname} ${req.postData()}`);
  };
  page.on('request', watchPuts);
  await page.click('#bill-autorenew');
  await page.waitForFunction(() => /Auto-renew is off/.test(document.querySelector('[data-sec="plan"]')?.textContent || ''));
  check('the Auto-renew switch is one PUT, and the line says it is off', puts.length === 1 && puts[0] === '/api/billing/subscription {"autoRenew":false}', puts.join(' | '));
  check('  the switch kept focus through the redraw', await page.evaluate(() => document.activeElement?.id === 'bill-autorenew'));
  await page.click('#bill-autorenew');
  await page.waitForFunction(() => /from your balance/.test(document.querySelector('[data-sec="plan"]')?.textContent || ''));
  await page.click('[data-cancel-plan]');
  await page.waitForFunction(() => /Ends /.test(document.querySelector('[data-sec="plan"]')?.textContent || '') && !!document.querySelector('[data-keep-plan]'));
  check('Cancel plan hands focus to Keep plan, which took its place', await page.evaluate(() => document.activeElement?.hasAttribute('data-keep-plan')));
  check('Cancel plan says when the plan ends and offers Keep plan', /Ends \d|Ends [A-Z]/.test(await text('[data-sec="plan"]')) && (await page.locator('[data-keep-plan]').count()) === 1, await text('[data-sec="plan"]'));
  await page.click('[data-keep-plan]');
  await page.waitForFunction(() => !document.querySelector('[data-keep-plan]'));

  puts.length = 0;
  await page.click('#bill-low-on');
  await page.waitForFunction(() => !document.getElementById('bill-low-amount').disabled);
  check('turning the low-balance email on asks for 50,000 by default', puts.length === 1 && puts[0] === '/api/billing/alerts {"lowBalanceVnd":50000}', puts.join(' | '));
  const thresholdSaved = page.waitForResponse((r) => r.request().method() === 'PUT' && /billing\/alerts/.test(r.url()));
  await page.fill('#bill-low-amount', '80000');
  await page.dispatchEvent('#bill-low-amount', 'change');
  await thresholdSaved;
  check('a new threshold is saved', puts.length === 2 && puts[1] === '/api/billing/alerts {"lowBalanceVnd":80000}', puts.join(' | '));
  check('the sentence that a transfer cannot be charged automatically is there', /cannot be charged automatically/i.test(await text('[data-sec="alerts"]')));
  page.off('request', watchPuts);
  await reopenBilling();
  check('the choice is still there when the tab is reopened', (await page.isChecked('#bill-low-on')) && (await page.inputValue('#bill-low-amount')) === '80000');
}

section('Billing information');
{
  const info = await text('[data-sec="info"]');
  check('the information saved at checkout is shown', /Nguyen Van A/.test(info) && /a@example\.com/.test(info), info);
  await page.click('[data-sec="info"] [data-edit-info]');
  check('Update opens a labelled form, filled in', (await page.inputValue('#bp-name')) === 'Nguyen Van A' && !!(await page.textContent('label[for="bp-name"]')));
  check('  with the company name and the other invoice name too, so saving here cannot erase them', (await page.inputValue('#bp-company')) === 'ABC Co' && (await page.inputValue('#bp-invoiceName')) === 'ABC Accounts' && !!(await page.textContent('label[for="bp-company"]')) && !!(await page.textContent('label[for="bp-invoiceName"]')));
  await page.fill('#bp-email', 'not-an-email');
  await page.click('[data-sec="info"] [data-save-info]');
  await page.waitForFunction(() => !!document.querySelector('[data-sec="info"] [role="alert"]')?.textContent.trim());
  check('what the server refuses is shown beside the form', /valid email/i.test(await text('[data-sec="info"] [role="alert"]')), await text('[data-sec="info"] [role="alert"]'));
  check('  and focus lands on those words, not on the page behind', await page.evaluate(() => document.activeElement?.id === 'bp-err'));
  await page.fill('#bp-email', 'b@example.com');
  await page.click('[data-sec="info"] [data-save-info]');
  await page.waitForFunction(() => /b@example\.com/.test(document.querySelector('[data-sec="info"]')?.textContent || '') && !document.querySelector('#bp-name'));
  check('a good save shows the new information and puts focus on Update', await page.evaluate(() => document.activeElement?.hasAttribute('data-edit-info')));
  const kept = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).profile);
  check('  and the company and invoice names are shown and still kept', /ABC Co/.test(await text('[data-sec="info"]')) && /ABC Accounts/.test(await text('[data-sec="info"]')) && kept.companyName === 'ABC Co' && kept.invoiceName === 'ABC Accounts' && kept.email === 'b@example.com', JSON.stringify(kept));
}

section('a plan in grace: Renew now, the date instead of a clock, and no late cancel of a shared renewal order');
{
  const sub = await store.getSubscription(OWNER);
  const day = 86_400_000;
  await store.saveSubscription({ ...sub, status: 'active', autoRenew: false, cancelAtEnd: false, nextPlan: null, nextPeriod: null, periodStart: new Date(Date.now() - 31 * day), periodEnd: new Date(Date.now() - day) });
  await reopenBilling();
  const grace = await text('[data-sec="plan"]');
  check('with auto-renew off, the Plan card says "renew now to keep Plus" (credit alone would not renew it)', /In grace until .+ — renew now to keep Plus/.test(grace) && !/add credit/.test(grace), grace);
  check('  and offers Renew now', (await page.locator('[data-renew]').count()) === 1);
  await page.click('[data-adjust]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Renew');
  check('the sheet\'s button for the plan in force reads Renew, and is on', await page.evaluate(() => !document.querySelector('#plans [data-plan="plus"] [data-pick]').disabled));
  await page.keyboard.press('Escape');

  // The one guarded way in, from a plan button (openCheckout): an order open elsewhere is shown first, with the line that says why, and a
  // read that fails refuses instead of carrying on to the checkout.
  await freshOrders();
  const unreadable = (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Billing is busy.' }) }) : route.fallback());
  const orderPosts = [];
  const countPosts = (req) => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/billing/orders') orderPosts.push(req.postData()); };
  const open = await page.evaluate(async () => (await (await fetch('/api/billing/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'topup', amountVnd: 100000 }) })).json()).order.id);
  page.on('request', countPosts);
  await page.route('**/api/billing', unreadable);
  await page.click('[data-renew]');
  await page.waitForSelector('#plans[open] [data-retry]');
  check('a plan button with the account unreadable refuses: the failure and Try again, no checkout, no order', (await page.locator('#plans [data-view="checkout"]').count()) === 0 && orderPosts.length === 0 && /busy/.test(await text('#plans .plans__error')));
  await page.unroute('**/api/billing');
  await page.click('#plans [data-retry]');
  await page.waitForSelector('#plans .pay__qr img');
  check('Try again from it goes to the order that is open (not the checkout), with the line that says why', (await page.evaluate(() => document.getElementById('plans').dataset.order)) === open && /already have an order waiting/.test(await text('#plans [data-pay-note]')) && orderPosts.length === 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);
  await store.cancelOrder(open, 'u-bill-owner');
  await page.route('**/api/billing', unreadable);
  await page.click('[data-renew]');
  await page.waitForSelector('#plans[open] [data-retry]');
  await page.unroute('**/api/billing');
  await page.click('#plans [data-retry]');
  check('with nothing open, Try again from a plan button opens the checkout it was for', await ok(page.waitForSelector('#plans [data-view="checkout"] [data-consent]', { timeout: 8000 })));
  page.off('request', countPosts);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('plans').open);

  // Esc while a renewal order is being made must not cancel it: it is the one the period shares.
  const calls = [];
  const watch = (req) => calls.push(`${req.method()} ${new URL(req.url()).pathname}`);
  await page.route('**/api/billing/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((r) => setTimeout(r, 1200));
    return route.continue();
  });
  page.on('request', watch);
  await page.click('[data-renew]');
  await ready();
  // Auto-renew is off here: the page must not promise a renewal the server will not make, and says when the plan ends instead.
  const offWords = await page.evaluate(() => ({ box: document.querySelector('#plans .checkout__renew')?.textContent.replace(/\s+/g, ' ').trim(), consent: document.querySelector('#plans .checkout__consent')?.textContent.replace(/\s+/g, ' ').trim() }));
  check('with auto-renew off, the box says when the plan ends and where to turn renewal on, and the consent has no renewal clause', /^Your plan ends on \d\d\/\d\d\/\d{4}\. Turn on auto-renew in Settings → Billing to renew it from your balance\.$/.test(offWords.box) && offWords.consent === 'I agree to pay the amount above today, under the Terms.' && !/renew/.test(offWords.consent), JSON.stringify(offWords));
  check('before any renewal order exists, the checkout offers the choice of using the balance', (await page.locator('#plans [data-use-balance]').count()) === 1 && (await page.locator('#plans [data-fixed-balance]').count()) === 0);
  await page.click('#plans [data-continue]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2200);
  page.off('request', watch);
  await page.unroute('**/api/billing/orders');
  check('the renewal order made after Esc is left open for the period', !calls.some((c) => /\/cancel$/.test(c)) && calls.some((c) => c === 'POST /api/billing/orders'), calls.join(' | '));

  await page.click('[data-renew]');
  await ready();
  const fixed = await page.evaluate(() => ({ box: document.querySelectorAll('#plans [data-use-balance]').length, note: document.querySelector('#plans [data-fixed-balance]')?.textContent.trim() || '', total: document.querySelector('#plans .checkout__total dd')?.textContent.trim() || '' }));
  check('once the renewal order exists, the checkout does not offer a choice the order ignores, and says what it does', fixed.box === 0 && /uses your balance/.test(fixed.note), JSON.stringify(fixed));
  await page.click('#plans [data-continue]');
  await page.waitForSelector('#plans .pay__qr img');
  check('the total the checkout showed is the amount the QR asks for', fixed.total.replace(/\s/g, '') === (await text('#plans #pay-amount')).replace(/\s/g, ''), `${fixed.total} / ${await text('#plans #pay-amount')}`);
  const timer = await text('#plans .pay__time');
  check('a renewal good for days shows a date and time, not 4319:59', !/\d{3,}:\d\d/.test(timer) && !/^.*\b\d{2}:\d\d\b.*\b\d{2}:\d\d\b/.test(timer) && /until/i.test(timer) && /20\d\d/.test(timer), timer);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#plans:not([open])', { state: 'attached' }).catch(() => {});

  // The order is made and its price locked: reading it needs no exchange rate, so Renew stays on when the rate source is down.
  await page.route('**/api/billing/plans', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, rate: null, plans: body.plans.map((p) => ({ ...p, vnd: null })) } });
  });
  await page.click('[data-adjust]');
  await page.waitForSelector('#plans [data-plan="plus"] [data-pick]');
  check('with no rate but a locked renewal order, Renew is still on', await page.evaluate(() => !document.querySelector('#plans [data-plan="plus"] [data-pick]').disabled));
  // The rate source being down also fails the quote for the period that has no locked order; the checkout must carry on with the one that has.
  await page.route('**/api/billing/quote', (route) => (JSON.parse(route.request().postData() || '{}').period === 'year' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"No exchange rate."}' }) : route.fallback()));
  await page.click('#plans [data-plan="plus"] [data-pick]');
  check('  and its checkout opens, ready to continue, with the locked price', (await ok(ready(5000))) && /128,000/.test(await text('#plans .checkout__lines')), await text('#plans .checkout__lines'));
  await page.unroute('**/api/billing/quote');
  await page.unroute('**/api/billing/plans');
  await page.keyboard.press('Escape');
}

section('a plan in grace with a downgrade scheduled: Renew now is the scheduled plan, never the one that ran');
{
  const sub = await store.getSubscription(OWNER);
  const day = 86_400_000;
  await store.saveSubscription({ ...sub, plan: 'pro', period: 'month', status: 'active', autoRenew: true, cancelAtEnd: false, nextPlan: 'plus', nextPeriod: 'month', paidVnd: 206000, periodStart: new Date(Date.now() - 31 * day), periodEnd: new Date(Date.now() - day) });
  await reopenBilling();
  const line = await text('[data-sec="plan"]');
  check('with auto-renew on the line says add credit, and names Plus (what renews), not Pro', /In grace until .+ — add credit to keep Plus/.test(line) && !/keep Pro/.test(line), line);
  await page.click('[data-renew]');
  await page.waitForSelector('#plans [data-view="checkout"] .checkout__lines');
  await ready();
  const co = await page.evaluate(() => ({ title: document.querySelector('#plans #co-plan')?.textContent.trim(), renew: document.querySelector('#plans .checkout__renew')?.textContent || '', period: document.querySelector('#plans .checkout__period [aria-checked="true"]')?.dataset.period, lines: document.querySelector('#plans .checkout__lines')?.textContent.replace(/\s+/g, ' ') }));
  check('Renew now opens the checkout for Plus, monthly, at the full price', co.title === 'Plus plan' && co.period === 'month' && /128,000/.test(co.lines), JSON.stringify(co));
  // A renewal continues the old period, so its date is the end of the NEXT period counted from the old end, not a month from today.
  const was = await store.getSubscription(OWNER);
  const expectRenews = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(renewalEnd(was.anchorAt ?? was.periodStart, was.periodEnd, 'month'));
  check('  and the renewal date is when the continued period ends, in Vietnam time', co.renew.includes(expectRenews), `${co.renew} / ${expectRenews}`);
  await page.keyboard.press('Escape');
  await page.click('[data-adjust]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Renew');
  const cards = await page.evaluate(() => ({ plus: document.querySelector('#plans [data-plan="plus"] [data-pick]').textContent.trim(), pro: document.querySelector('#plans [data-plan="pro"] [data-pick]').textContent.trim(), proOff: document.querySelector('#plans [data-plan="pro"] [data-pick]').disabled, lit: [...document.querySelectorAll('#plans .plans__card.is-current')].map((c) => c.dataset.plan).join() }));
  check('one card is highlighted: the renewal terms (Plus), not the plan that ran', cards.lit === 'plus', cards.lit);
  check('the sheet offers Renew on Plus, and the plan that ran is only the current one (not a way to renew it)', cards.plus === 'Renew' && cards.pro === 'Current plan' && cards.proOff, JSON.stringify(cards));
  await page.keyboard.press('Escape');
  // No exchange rate and no locked renewal order for these terms: nothing to renew at, so the button is off.
  await page.route('**/api/billing/plans', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, rate: null, plans: body.plans.map((p) => ({ ...p, vnd: null })) } });
  });
  await page.click('[data-adjust]');
  await page.waitForSelector('#plans [data-plan="plus"] [data-pick]');
  check('with no rate and no locked renewal order, Renew is off', await page.evaluate(() => document.querySelector('#plans [data-plan="plus"] [data-pick]').disabled));
  await page.unroute('**/api/billing/plans');
  await page.keyboard.press('Escape');
  // Put it back as it was (auto-renew off, Plus): with auto-renew on, the next read would renew it from the balance the later sections count.
  await store.saveSubscription(sub);
}

section('Receipts and the PDF');
{
  // A real transfer has a receipt; one assigned by an administrator is made here the way the card does it.
  const row = await store.recordTransfer({ dedupe: 'ref:UNM-ASSIGN', amountVnd: 75000, outcome: 'unmatched', via: 'webhook', content: 'CK tien <b>nha</b>', gateway: 'MBBank', accountNumber: '0123456789' });
  await store.recordTransfer({ dedupe: 'ref:UNM-RETURN', amountVnd: 33000, outcome: 'unmatched', via: 'webhook', content: 'chuyen nham', gateway: 'ACB', accountNumber: '0123456789' });
  check('two unmatched transfers are waiting', !!row);
  await page.click('#tab-admin');
  await page.waitForFunction(() => document.querySelectorAll('#admin-billing [data-transfer]').length === 2, null, { timeout: 8000 });
  const card = await text('#admin-billing');
  check('it counts the accounts that asked to hear when Team opens', (await text('#admin-billing [data-adm="team-interest"]')).includes('1'), await text('#admin-billing [data-adm="team-interest"]'));
  check('the card shows the mode and the rate', /preview/i.test(await text('#admin-billing [data-adm="mode"]')) && /25,500/.test(await text('#admin-billing [data-adm="rate"]')), await text('#admin-billing [data-adm="rate"]'));
  check('the money in the last 30 days, the month\'s cost and margin are drawn', /Plans/.test(card) && /Pay as you go/.test(card) && /Top-ups/.test(card) && /Real cost/.test(card) && /Margin/.test(card) && /Balances held/.test(card), card.slice(0, 300));
  check('the unmatched content is shown as text, not as markup', (await page.locator('#admin-billing [data-transfer] b').count()) === 0 && /<b>nha<\/b>/.test(card));
  check('failed e-invoices are not mentioned while there are none', !/e-invoices/i.test(card));

  const toAssign = page.locator('#admin-billing [data-transfer]', { hasText: '75,000' });
  await toAssign.locator('[data-assign-email]').fill('nobody@test.local');
  await toAssign.locator('[data-assign]').click();
  check('an email that matches no account is said, next to the row', await ok(page.waitForFunction(() => [...document.querySelectorAll('#admin-billing [data-transfer] [role="alert"]')].some((a) => /No account has that email/.test(a.textContent || '')), null, { timeout: 5000 })));
  await page.locator('#admin-billing [data-transfer]', { hasText: '75,000' }).locator('[data-assign-email]').fill('owner@test.local');
  await page.locator('#admin-billing [data-transfer]', { hasText: '75,000' }).locator('[data-assign]').click();
  await page.waitForFunction(() => document.querySelectorAll('#admin-billing [data-transfer]').length === 1, null, { timeout: 6000 });
  const balance = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).balance.vnd);
  check('Assign credits the named account', balance >= 195000, String(balance));

  const keep = page.locator('#admin-billing [data-transfer]').first().locator('[data-dismiss]');
  await keep.click();
  check('Mark returned asks again on the first press and has not acted', (await page.locator('#admin-billing [data-transfer]').count()) === 1 && /sure|really/i.test((await keep.textContent()) || ''), (await keep.textContent()) || '');
  await keep.click();
  check('the second press marks it returned', await ok(page.waitForFunction(() => document.querySelectorAll('#admin-billing [data-transfer]').length === 0, null, { timeout: 6000 })));
  check('  and focus lands on the list heading, not on the page behind', await page.evaluate(() => document.activeElement?.id === 'adm-h-transfers'), await page.evaluate(() => document.activeElement?.tagName));

  // Someone who goes elsewhere while it is being done is not pulled back to the heading.
  await store.recordTransfer({ dedupe: 'ref:UNM-RETURN-2', amountVnd: 12000, outcome: 'unmatched', via: 'webhook', content: 'chuyen nham 2', gateway: 'ACB', accountNumber: '0123456789' });
  await page.click('#tab-usage');
  await page.click('#tab-admin');
  await page.waitForSelector('#admin-billing [data-transfer]');
  await page.route(/\/api\/admin\/billing\/transfers\/\d+\/dismiss/, async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    return route.continue();
  });
  const slow = page.locator('#admin-billing [data-transfer] [data-dismiss]').first();
  await slow.click();
  await slow.click();
  await page.focus('#settings-search');
  check('  a person who moved on while it was done keeps their place (focus is not taken back)', await ok(page.waitForFunction(() => document.querySelectorAll('#admin-billing [data-transfer]').length === 0, null, { timeout: 6000 })) && (await page.evaluate(() => document.activeElement?.id === 'settings-search')), await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
  await page.unroute(/\/api\/admin\/billing\/transfers\/\d+\/dismiss/);

  await page.click('#tab-billing');
  await billingReady();
  check('money assigned by hand starts the 12 months: the balance has an expiry date', /Expires/.test(await text('[data-sec="credits"]')), await text('[data-sec="credits"]'));
  const links = await page.evaluate(() => [...document.querySelectorAll('[data-sec="receipts"] a')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() })));
  check('the receipt for the assigned money is listed with Download PDF', links.length >= 1 && /Download PDF/.test(links[0].text), JSON.stringify(links));
  const type = await page.evaluate(async (href) => { const r = await fetch(href); return `${r.status} ${r.headers.get('content-type')}`; }, links[0]?.href);
  check('the link answers application/pdf', /^200 application\/pdf/.test(type), type);
}

section('the administrators\' card: capacity, orders, promo codes, simulate');
{
  await page.click('#tab-admin');
  await page.waitForSelector('#admin-billing [data-adm="mode"]');
  const real = await page.evaluate(() => document.querySelector('#admin-billing [data-cap="machines"]')?.dataset.level);
  check('with no E2B key the machines are "unknown", not zero', real === 'unknown', real);

  // The four states, from figures the server could give: green, 75% amber, 90% red, unknown.
  const CARD_FIGURES = /\/api\/admin\/billing(\?|$)/;
  const cases = [
    { machines: { running: 3, limit: 20 }, database: { bytes: 1e9, includedBytes: 8e9 }, level: ['ok', 'ok'] },
    { machines: { running: 15, limit: 20 }, database: { bytes: 6e9, includedBytes: 8e9 }, level: ['warn', 'warn'] },
    { machines: { running: 18, limit: 20 }, database: { bytes: 7.5e9, includedBytes: 8e9 }, level: ['bad', 'bad'] },
    { machines: { running: null, limit: 20 }, database: { bytes: null, includedBytes: 8e9 }, level: ['unknown', 'unknown'] },
  ];
  for (const c of cases) {
    await page.route(CARD_FIGURES, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, capacity: { machines: c.machines, database: c.database } } });
    });
    await page.click('#tab-usage');
    await page.click('#tab-admin');
    await page.waitForFunction((lv) => document.querySelector('#admin-billing [data-cap="machines"]')?.dataset.level === lv, c.level[0], { timeout: 6000 });
    const got = await page.evaluate(() => ({ m: document.querySelector('#admin-billing [data-cap="machines"]').dataset.level, d: document.querySelector('#admin-billing [data-cap="database"]').dataset.level, said: document.querySelector('#admin-billing [data-adm="capacity"]').textContent.replace(/\s+/g, ' ') }));
    const sentence = c.level[0] === 'ok' || c.level[0] === 'unknown' ? true : /E2B Pro/.test(got.said) && /disk|storage/i.test(got.said);
    check(`capacity ${c.level[0]}: machines and database levels${c.level[0] === 'ok' || c.level[0] === 'unknown' ? '' : ', with what to buy'}`, got.m === c.level[0] && got.d === c.level[1] && sentence, JSON.stringify(got));
    await page.unroute(CARD_FIGURES);
  }
  await page.click('#tab-usage');
  await page.click('#tab-admin');
  await page.waitForSelector('#admin-billing [data-order-row]');
  check('recent orders are listed, with the account', (await page.locator('#admin-billing [data-order-row]').count()) >= 1 && /owner@test\.local/.test(await text('#admin-billing [data-order-row]')));

  await page.fill('#adm-promo-code', 'SPRING2026');
  await page.fill('#adm-promo-credit', '10000');
  await page.fill('#adm-promo-uses', '3');
  await page.click('[data-promo-create]');
  await page.waitForSelector('#admin-billing [data-promo-row="SPRING2026"]');
  check('a promo code is made from the form and listed', /10,000/.test(await text('[data-promo-row="SPRING2026"]')));
  await page.fill('#adm-promo-code', 'short');
  await page.click('[data-promo-create]');
  check('a code the server refuses says why', await ok(page.waitForFunction(() => /8 to 32/.test(document.querySelector('#adm-promo-msg')?.textContent || ''), null, { timeout: 5000 })));
  const off = page.locator('[data-promo-row="SPRING2026"] [data-promo-disable]');
  await off.click();
  const asked = ((await off.textContent()) || '').trim();
  const stillOn = await page.evaluate(async () => (await (await fetch('/api/admin/billing/promos')).json()).promos.find((p) => p.code === 'SPRING2026')?.active);
  check('the first press on Switch off asks in its own words (not "mark returned") and has switched nothing off', /Really switch this code off/.test(asked) && !/returned/i.test(asked) && stillOn === true, `${asked} / active=${stillOn}`);
  await off.click();
  check('the second press switches it off, and the row reads Switched off', await ok(page.waitForFunction(() => /Switched off/.test(document.querySelector('[data-promo-row="SPRING2026"]')?.textContent || ''), null, { timeout: 5000 })));
  check('  and focus lands on the Promo codes heading', await page.evaluate(() => document.activeElement?.id === 'adm-h-promos'), await page.evaluate(() => document.activeElement?.tagName));

  // The renewal order made earlier is covered by the balance by now (the server says "nothing left to pay"), so a fresh top-up is played.
  const topup = await page.evaluate(async () => (await (await fetch('/api/billing/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'topup', amountVnd: 100000 }) })).json()).order.id);
  await page.click('#tab-usage');
  await page.click('#tab-admin');
  await page.waitForSelector('#adm-sim-order option[value]:not([value=""])', { state: 'attached' });
  const before = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).balance.vnd);
  await page.selectOption('#adm-sim-order', topup);
  await page.click('[data-simulate]');
  await page.waitForFunction(() => !!document.querySelector('#adm-sim-msg')?.textContent.trim(), null, { timeout: 6000 });
  check('the simulation says what came of it in a sentence, not a raw word', /Simulated: the top-up was credited/.test(await text('#adm-sim-msg')), await text('#adm-sim-msg'));
  const after = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).balance.vnd);
  check('Simulate a transfer plays the bank for a pending order: the top-up is credited', after === before + 100000, `${before} -> ${after}`);
}

section('Recent transactions: a page of nothing but hidden rows does not leave Load more with nothing to draw');
{
  await page.click('#tab-billing');
  await billingReady();
  const asked = [];
  await page.route('**/api/billing/transactions*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('kind') !== 'usage') return route.fallback();
    asked.push(url.searchParams.get('before') || '-');
    const day = '2026-11-14';
    const zero = (id) => ({ id, kind: 'usage', category: 'search', day, units: 0, deltaVnd: 0, ref: null, note: null, createdAt: new Date().toISOString(), balanceAfterVnd: 1 });
    const real = { id: 40, kind: 'usage', category: 'search', day, units: 3, deltaVnd: -1200, ref: null, note: null, createdAt: new Date().toISOString(), balanceAfterVnd: 2 };
    const body = !url.searchParams.get('before') ? { entries: [zero(90), zero(89)], next: 89 } : { entries: [real], next: null };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.click('[data-chip="usage"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-sec="tx"] .bill__tx li').length === 1, null, { timeout: 6000 }).catch(() => {});
  await page.unroute('**/api/billing/transactions*');
  check('the next page is read until a row worth showing arrives, so the list is drawn', (await page.locator('[data-sec="tx"] .bill__tx li').count()) === 1 && asked.join() === '-,89', asked.join());
  check('  and there is no Load more left with nothing behind it', (await page.locator('[data-more]').count()) === 0);
  await page.click('[data-chip="all"]');

  // The guard on how many pages are read looking for a row: past it, Load more stays (there may be more), it does not say there is nothing.
  const pages = [];
  await page.route('**/api/billing/transactions*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('kind') !== 'usage') return route.fallback();
    const before = Number(url.searchParams.get('before')) || 10_000;
    pages.push(before);
    const zero = { id: before - 1, kind: 'usage', category: 'search', day: '2026-11-14', units: 0, deltaVnd: 0, ref: null, note: null, createdAt: new Date().toISOString(), balanceAfterVnd: 1 };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [zero], next: before - 1 }) });
  });
  await page.click('[data-chip="usage"]');
  await page.waitForSelector('[data-more]:not([disabled])', { timeout: 8000 }).catch(() => {});
  await page.unroute('**/api/billing/transactions*');
  check('when 25 pages hold nothing worth showing, reading stops there and Load more is still offered', pages.length === 25 && (await page.locator('[data-more]').count()) === 1 && (await page.locator('[data-sec="tx"] .bill__tx').count()) === 0, String(pages.length));
  await page.click('[data-chip="all"]');

  const levels = await page.evaluate(() => ({ panel: [...document.querySelectorAll('#billing-panel [data-sec] > h4')].length, h3: document.querySelectorAll('#billing-panel h3, #admin-billing h3').length, admin: document.querySelectorAll('#admin-billing h4').length }));
  check('the cards\' headings are one level (h4) under the section heading, here and in the card', levels.panel === 8 && levels.h3 === 0 && levels.admin >= 5, JSON.stringify(levels));
}

section('Load more: a read in between does not make the next Load more repeat rows');
{
  const row = (id) => ({ id, kind: 'topup', category: null, day: '2026-11-14', units: 0, deltaVnd: 1000, ref: null, note: null, createdAt: new Date().toISOString(), balanceAfterVnd: 1000 });
  const ids = (from, n) => Array.from({ length: n }, (_, i) => row(from - i));
  await page.route('**/api/billing/transactions*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('kind')) return route.fallback();
    const before = Number(url.searchParams.get('before')) || 0;
    const body = !before ? { entries: ids(300, 20), next: 281 } : before === 281 ? { entries: ids(280, 20), next: 261 } : { entries: ids(260, 20), next: null };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.click('#tab-usage');
  await page.click('#tab-billing');
  await billingReady();
  await page.waitForFunction(() => document.querySelectorAll('[data-sec="tx"] .bill__tx li').length === 20, null, { timeout: 6000 });
  await page.click('[data-more]');
  await page.waitForFunction(() => document.querySelectorAll('[data-sec="tx"] .bill__tx li').length === 40, null, { timeout: 6000 });
  // Something that reads everything again (a promo code that does not work) puts the list back to its first page.
  await page.fill('#bill-promo', 'nonsense2');
  await page.click('[data-redeem]');
  await page.waitForFunction(() => /did not work/.test(document.querySelector('#bill-promo-msg')?.textContent || ''), null, { timeout: 6000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-sec="tx"] .bill__tx li').length === 20, null, { timeout: 4000 }).catch(() => {});
  check('after a read the list is the first page again, and Load more is on', (await page.locator('[data-sec="tx"] .bill__tx li').count()) === 20 && (await page.isEnabled('[data-more]')));
  await page.click('[data-more]');
  await page.waitForFunction(() => document.querySelectorAll('[data-sec="tx"] .bill__tx li').length >= 40, null, { timeout: 6000 }).catch(() => {});
  const shown = await page.evaluate(() => [...document.querySelectorAll('[data-sec="tx"] .bill__tx li')].map((li) => li.dataset.tx));
  check('Load more then, no row is drawn twice', shown.length === 40 && new Set(shown).size === shown.length, `${shown.length} rows, ${new Set(shown).size} different`);
  await page.unroute('**/api/billing/transactions*');
}

section('keyboard, names and 360 px');
{
  await page.click('#tab-billing');
  await billingReady();
  const unnamed = await page.evaluate(() => {
    const name = (el) => (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || '').trim();
    return [...document.querySelectorAll('#billing-panel input, #billing-panel button, #billing-panel select, #billing-panel a[href]')].filter((el) => !name(el)).map((el) => el.outerHTML.slice(0, 80));
  });
  check('every control on the tab has a name', unnamed.length === 0, unnamed.join(' | '));
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#billing-panel button, #billing-panel input, #billing-panel a[href]')].filter((e) => !e.disabled && e.getClientRects().length && e.tabIndex < 0).length);
  check('nothing on the tab is taken out of the keyboard order', tabs === 0, String(tabs));
  await page.focus('[data-add-credits]');
  await page.keyboard.press('Enter');
  check('Enter on Add credits opens the form and moves focus to the amount', (await page.evaluate(() => document.activeElement?.id)) === 'bill-amount');
  await page.focus('[data-view-usage]');
  await page.keyboard.press('Enter');
  check('View usage moves focus to the This period heading', await page.evaluate(() => document.activeElement?.closest('[data-sec="period"]') !== null));

  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(200);
  const narrow = async () => page.evaluate(() => {
    const body = document.querySelector('#settings .settings__body');
    const edge = body.getBoundingClientRect().right;
    const wide = [...body.querySelectorAll('*')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > edge + 1).slice(0, 3).map((el) => el.tagName + '.' + el.className);
    return { page: document.documentElement.scrollWidth <= window.innerWidth, body: body.scrollWidth <= body.clientWidth + 1, wide };
  });
  const tab = await narrow();
  check('the Billing tab does not scroll sideways at 360 px', tab.page && tab.body, JSON.stringify(tab));
  await page.click('#tab-admin');
  await page.waitForSelector('#admin-billing [data-adm="mode"]');
  // The People list above the card (user rows) is older and is not this card's to answer for: only what the card draws is measured.
  const adm = await page.evaluate(() => {
    const card = document.getElementById('admin-billing');
    const edge = card.closest('.settings__body').getBoundingClientRect().right;
    const wide = [...card.querySelectorAll('*')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > edge + 1).slice(0, 3).map((el) => el.tagName + '.' + el.className);
    return { card: card.scrollWidth <= card.clientWidth + 1, wide };
  });
  check('nor does the administrators\' card', adm.card && adm.wide.length === 0, JSON.stringify(adm));
  await shot('billing-admin-narrow');
  await page.setViewportSize({ width: 1280, height: 900 });
}

// Safari before 17 knows no `:popover-open` (and has no Popover API), before 15.6 no `:modal`: a pseudo-class the engine does not
// know makes matches() and querySelectorAll() throw a SyntaxError. toast() asked both on every call, so with Settings open the
// second toast threw at its caller and the caller's own next line never ran (final review, 2026-11-15). Members see it.
const olderEngine = ({ noPopoverApi, unknown }) => {
  const pattern = new RegExp(unknown);
  for (const proto of [Element.prototype, globalThis.Document.prototype, globalThis.DocumentFragment.prototype]) {
    for (const name of ['matches', 'querySelector', 'querySelectorAll', 'closest']) {
      const real = proto[name];
      if (typeof real !== 'function') continue;
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value(selector, ...rest) {
          if (pattern.test(String(selector))) throw new globalThis.DOMException(`'${selector}' is not a valid selector.`, 'SyntaxError');
          return real.call(this, selector, ...rest);
        },
      });
    }
  }
  if (noPopoverApi) for (const name of ['showPopover', 'hidePopover', 'togglePopover']) delete HTMLElement.prototype[name];
};
for (const [label, engine] of [
  ['neither :popover-open nor :modal is known', { noPopoverApi: false, unknown: ':popover-open|:modal' }],
  ['Safari 16: no Popover API, no :popover-open', { noPopoverApi: true, unknown: ':popover-open' }],
]) {
  section(`toasts with a modal open in an older engine (${label})`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(olderEngine, engine);
  const old = await signIn(ctx, 'member@test.local');
  await openMenu(old);
  await old.click('.plusmenu--account [data-row="settings"]');
  await old.waitForSelector('#settings[open]');
  /** Raise each toast, then say whether the call returned and whether each one is drawn on top where it can be read. */
  const raise = (messages) => old.evaluate(async (list) => {
    const { toast } = await import('/js/render.js');
    const ran = list.map(([message, kind]) => {
      try {
        toast(message, kind);
        return true;
      } catch (err) {
        return String(err?.message || err);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const shown = list.map(([message]) => {
      const node = [...document.getElementsByClassName('toast')].find((n) => n.textContent === message);
      if (!node) return null;
      const region = node.parentElement;
      const was = [region.style.pointerEvents, node.style.pointerEvents];
      region.style.pointerEvents = 'auto';
      node.style.pointerEvents = 'auto';
      const box = node.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      [region.style.pointerEvents, node.style.pointerEvents] = was;
      return { onTop: at === node || node.contains(at), top: Math.round(box.top), parent: region.parentElement?.id || region.parentElement?.tagName };
    });
    return { ran, shown };
  }, messages);
  const inSettings = await raise([['Older engine, first', 'error'], ['Older engine, second', 'error'], ['Older engine, a notice', 'info']]);
  check('every toast() call returns, so the code after it runs', inSettings.ran.every((r) => r === true), JSON.stringify(inSettings.ran));
  check('  and every toast is drawn on top of Settings, near the top', inSettings.shown.every((s) => s?.onTop === true && s.top >= 0 && s.top < 200), JSON.stringify(inSettings.shown));
  await old.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('settings')).close());
  await old.waitForTimeout(200);
  const after = await raise([['Older engine, after closing', 'info']]);
  check('  closed, the next toast is in the page and on top', after.ran[0] === true && after.shown[0]?.onTop === true && after.shown[0].parent === 'BODY', JSON.stringify(after));
  check('  and no page error was raised, the close included', old.errors.length === 0, old.errors.join(' | '));
  await ctx.close();
}

section('an administrator without the billing permission sees the tab but no card, and asks nothing of the card');
{
  await store.createUser({ id: 'u-bill-helper', email: 'helper@test.local', name: 'Helper', username: 'bill.helper', passwordHash: await hashPassword(password), role: 'admin' });
  await store.setAdminPermissions('u-bill-helper', ['users']);
  await setPrefs('u-bill-helper', { language: 'en', onboarded: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  ctx.on('request', (req) => {
    if (/\/api\/admin\/billing/.test(req.url())) calls.push(req.url());
  });
  const helper = await signIn(ctx, 'helper@test.local');
  await openMenu(helper);
  await helper.click('.plusmenu--account [data-row="settings"]');
  await helper.waitForSelector('#settings[open]');
  check('the Billing tab is there for any administrator', await helper.evaluate(() => document.getElementById('tab-billing').hidden === false));
  await helper.click('#tab-admin');
  await helper.waitForTimeout(600);
  const hidden = await helper.evaluate(() => { const el = document.querySelector('#panel-admin [data-needs="billing"]'); return !!el && el.hidden; });
  check('the Billing card is hidden', hidden);
  check('and its figures were never asked for', calls.length === 0, calls.join());
  await ctx.close();
}

section('light theme: the tab and the card read at 4.5:1');
{
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const measure = (root) => page.evaluate((rootSelector) => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const backdrop = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.length === 3 || c[3] > 0.9) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const panel = document.querySelector(rootSelector);
    return [...panel.querySelectorAll('.plans__muted, .bill__total-label, .bill__total-amount, .bill__name, .bill__line, .bill__tx-amt, .bill__kindhead, .bill__receipts a, .adm__facts dt, .adm__facts dd, .adm__hint, .adm__caphead, .adm__status, .btn:not(:disabled):not(.btn--primary), .plans__error')]
      .filter((el) => el.getClientRects().length && el.textContent.trim())
      .map((el) => {
        const a = lum(parse(getComputedStyle(el).color).slice(0, 3));
        const b = lum(backdrop(el));
        return [(Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), el.className];
      });
  }, root);
  await page.click('#tab-billing');
  await billingReady();
  const tab = await measure('#billing-panel');
  check('the Billing tab reads at 4.5:1 or better', tab.length > 8 && tab.every(([c]) => c >= 4.5), tab.filter(([c]) => c < 4.5).map(([c, n]) => `${c.toFixed(1)} ${n}`).join(' | '));
  await shot('billing-light');
  await page.click('#tab-admin');
  await page.waitForSelector('#admin-billing [data-adm="mode"]');
  const card = await measure('#admin-billing');
  check('the administrators\' card reads at 4.5:1 or better', card.length > 8 && card.every(([c]) => c >= 4.5), card.filter(([c]) => c < 4.5).map(([c, n]) => `${c.toFixed(1)} ${n}`).join(' | '));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
}

await page.evaluate(() => document.getElementById('settings').close());
check('no uncaught page errors', page.errors.length === 0, page.errors.join(' | '));
await browser.close();
server.close();
realLog(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
