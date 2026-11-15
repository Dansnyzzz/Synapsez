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
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'BILLING_MODE', 'SEPAY_API_TOKEN']) delete process.env[name];
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
const store = await initStore();
const { createApp } = await import('../server/app.js');
const { hashPassword } = await import('../server/crypto.js');
const { setPrefs } = await import('../server/settings.js');
const PORT = 5241;
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

section('the Upgrade plan row and the plan line');
{
  await page.waitForFunction(() => document.querySelector('.account__plan')?.textContent.trim(), null, { timeout: 8000 }).catch(() => {});
  check('"Free plan" sits under the name', (await page.evaluate(() => document.querySelector('.account__plan')?.textContent.trim())) === 'Free plan');
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
      radios: [...d.querySelectorAll('.plans__period [role="radio"]')].map((r) => `${r.dataset.period}:${r.getAttribute('aria-checked')}`),
      group: d.querySelector('.plans__period')?.getAttribute('role'),
      plus: d.querySelector('[data-plan="plus"]').textContent,
      free: d.querySelector('[data-plan="free"] [data-pick]').textContent.trim() + (d.querySelector('[data-plan="free"] [data-pick]').disabled ? ' (disabled)' : ''),
      rate: d.querySelector('.plans__rate')?.textContent,
      link: d.querySelector('.plans__rate a')?.href,
      all: d.textContent,
    };
  });
  check('titled "Plans that grow with you", named by aria-labelledby', sheet.labelled === 'Plans that grow with you', sheet.labelled);
  check('four cards: Free, Plus, Pro, Max', sheet.cards.join() === 'free,plus,pro,max', sheet.cards.join());
  check('the preview note is at the top', sheet.note === 'Preview — only administrators see this.', sheet.note);
  check('Monthly | Yearly is a radio group, monthly first', sheet.group === 'radiogroup' && sheet.radios.join() === 'month:true,year:false', sheet.radios.join());
  check('English shows USD large and "billed as" in đồng beneath', /\$5\b/.test(sheet.plus) && /billed as 128,000/.test(sheet.plus), sheet.plus.replace(/\s+/g, ' '));
  check('no daily figure anywhere (a month\'s allowance)', !/a day|per day|daily/i.test(sheet.all), '');
  check('the allowance is a month\'s: searches, computer hours, storage', /150 searches a month/.test(sheet.plus) && /4 h of computer time a month/.test(sheet.plus) && /3 GB storage/.test(sheet.plus), sheet.plus.replace(/\s+/g, ' '));
  check('the current plan\'s button is disabled "Current plan"', sheet.free === 'Current plan (disabled)', sheet.free);
  check('the rate, its source and the time sit under the cards', /25,500/.test(sheet.rate) && /open\.er-api|Exchange Rate/i.test(sheet.rate), (sheet.rate || '').replace(/\s+/g, ' '));
  check('  with the ExchangeRate-API attribution link', /exchangerate-api\.com/.test(sheet.link || ''), sheet.link);
  check('the pay-as-you-go prices follow', /400/.test(sheet.all) && /1 person/.test(sheet.all));
  await shot('plans');

  await page.click('#plans .plans__period [data-period="year"]');
  const yearly = await page.evaluate(() => ({
    plus: document.querySelector('#plans [data-plan="plus"] .plans__price').textContent.replace(/\s+/g, ' '),
    checked: document.querySelector('#plans .plans__period [data-period="year"]').getAttribute('aria-checked'),
    save: document.querySelector('#plans .plans__period [data-period="year"]').textContent,
  }));
  check('Yearly changes the prices', /\$57\b/.test(yearly.plus) && yearly.checked === 'true', yearly.plus);
  check('  and says "save 5%"', /5%/.test(yearly.save), yearly.save);
  await page.click('#plans .plans__period [data-period="month"]');
}

section('keyboard');
{
  // Everything the sheet offers is reached by Tab, and Tab stays inside it.
  const wanted = await page.evaluate(() => [...document.querySelectorAll('#plans button, #plans a[href], #plans input, #plans [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length).length);
  const seen = new Set();
  for (let i = 0; i < wanted + 4; i += 1) {
    await page.keyboard.press('Tab');
    seen.add(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'BROWSER'; // focus left the page for the browser's own bar, as a modal dialog allows
      return el.closest('#plans') ? `${el.tagName}:${el.dataset.pick ?? el.dataset.period ?? el.getAttribute('aria-label') ?? el.textContent.slice(0, 12)}:${el.closest('.plans__card')?.dataset.plan ?? ''}` : 'OUTSIDE';
    }));
  }
  check('Tab never leaves the dialog', !seen.has('OUTSIDE'), [...seen].join(' | '));
  check('  and reaches the periods, every enabled button and the link', seen.size >= wanted - 1, `${seen.size} of ${wanted}`);
  // The radios are one tab stop; arrows move between them.
  await page.focus('#plans .plans__period [aria-checked="true"]');
  await page.keyboard.press('ArrowRight');
  check('arrow keys move between Monthly and Yearly', (await page.getAttribute('#plans .plans__period [data-period="year"]', 'aria-checked')) === 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Escape closes the sheet', !(await page.evaluate(() => document.getElementById('plans').open)));
}

section('Get Plus: the first time asks who is buying');
{
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForSelector('#plans .plans__card [data-pick]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Get Plus');
  await page.click('#plans [data-plan="plus"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"]');
  const first = await page.evaluate(() => ({
    form: !!document.querySelector('#plans form[data-profile]'),
    summary: !!document.querySelector('#plans .checkout__summary'),
    fields: [...document.querySelectorAll('#plans form[data-profile] input')].map((i) => `${i.id}:${document.querySelector(`label[for="${i.id}"]`)?.textContent.trim() || 'NO LABEL'}`),
    continueDisabled: document.querySelector('#plans [data-continue]').disabled,
    lines: document.querySelector('#plans .checkout__lines').textContent.replace(/\s+/g, ' '),
    note: !!document.querySelector('#plans .plans__preview'),
    balanceBox: !!document.querySelector('#plans [data-use-balance]'),
    labelled: document.getElementById(document.getElementById('plans').getAttribute('aria-labelledby'))?.textContent.trim(),
  }));
  check('the billing-information form is there, labelled field by field', first.form && !first.summary && first.fields.length === 5 && first.fields.every((f) => !f.includes('NO LABEL')), first.fields.join());
  check('Continue waits until it is saved', first.continueDisabled);
  check('the lines show the price and Total due today', /Plus/.test(first.lines) && /Total due today/.test(first.lines) && /128,000/.test(first.lines), first.lines);
  check('the preview note repeats at checkout', first.note);
  check('the dialog is named for the checkout', /Checkout/i.test(first.labelled || ''), first.labelled);

  await page.click('#plans [data-save-profile]');
  await page.waitForSelector('#plans [role="alert"]');
  check('an empty form says what is missing and saves nothing', (await page.textContent('#plans [role="alert"]')).length > 5);
  await page.fill('#bill-name', 'Nguyen Van A');
  await page.fill('#bill-email', 'a@example.com');
  await page.fill('#bill-country', 'vn');
  await page.fill('#bill-address', '1 Le Loi, Ho Chi Minh City');
  await page.fill('#bill-tax', '0312345678');
  await page.click('#plans [data-save-profile]');
  await page.waitForSelector('#plans .checkout__summary');
  const saved = await page.evaluate(() => ({
    text: document.querySelector('#plans .checkout__summary').textContent.replace(/\s+/g, ' '),
    update: !!document.querySelector('#plans [data-update-profile]'),
    form: !!document.querySelector('#plans form[data-profile]'),
    continueDisabled: document.querySelector('#plans [data-continue]').disabled,
  }));
  check('after saving, the saved summary with Update', saved.update && !saved.form && /Nguyen Van A/.test(saved.text) && /VN/.test(saved.text), saved.text);
  check('  and Continue is open', !saved.continueDisabled);
  const stored = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).profile);
  check('the information is kept on the account', stored?.name === 'Nguyen Van A' && stored.country === 'VN', JSON.stringify(stored));
  await shot('checkout');
  await page.click('#plans [data-update-profile]');
  check('Update brings the form back, filled in', (await page.inputValue('#bill-name')) === 'Nguyen Van A');
  await page.click('#plans [data-save-profile]');
  await page.waitForSelector('#plans .checkout__summary');
}

section('Continue: the QR, the copy buttons, the countdown');
let orderId = '';
{
  await page.click('#plans [data-continue]');
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
  check('a status line that is announced', qr.status === 'status' && /waiting/i.test(qr.statusText), qr.statusText);
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

section('short payment, expiry, cancel');
{
  // A lower plan is changed at renewal, after a confirm: the sheet says so and nothing is charged.
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Current plan');
  check('the plan in force reads "Current plan"; Free offers the change at renewal', (await page.textContent('#plans [data-plan="free"] [data-pick]')).trim() === 'Changes at renewal');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"]');
  const quoted = await page.textContent('#plans .checkout__lines');
  check('an upgrade shows the unused part of Plus as a credit', /credit/i.test(quoted), quoted.replace(/\s+/g, ' '));

  // The status answers are stood in for here: a short payment, then silence until the clock runs out.
  let answer = { status: 'pending', receivedVnd: 50000, dueVnd: 50000, plan: 'pro' };
  await page.route('**/api/billing/orders/*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) }) : route.fallback()));
  await page.click('#plans [data-continue]');
  await page.waitForSelector('#plans .pay__qr img');
  await page.waitForFunction(() => /Received/.test(document.querySelector('#plans .pay__status')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const short = await page.evaluate(() => ({ text: document.querySelector('#plans .pay__status').textContent.replace(/\s+/g, ' '), src: document.querySelector('#plans .pay__qr img').src }));
  check('a short payment says what arrived and what is left', /Received 50,000/.test(short.text) && /to go/.test(short.text), short.text);
  check('  with a fresh QR for what is left', /amount=50000\b/.test(short.src), short.src);
  answer = { status: 'expired', receivedVnd: 0, dueVnd: 0, plan: 'pro' };
  await page.waitForFunction(() => /Expired/.test(document.querySelector('#plans .pay__status')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const expired = await page.evaluate(() => ({ text: document.querySelector('#plans .pay__status').textContent.replace(/\s+/g, ' '), timer: !!document.querySelector('#plans .pay__timer:not([hidden])') }));
  check('an expired order says any money that arrives goes to the balance', /Expired — any money that arrives goes to your balance/.test(expired.text), expired.text);
  await page.unroute('**/api/billing/orders/*');
  await page.click('#plans [data-back]');
  await page.waitForSelector('#plans .plans__card');
  await page.click('#plans [data-plan="max"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"]');
  await page.click('#plans [data-continue]');
  await page.waitForSelector('#plans .pay__qr img');
  const open = await page.evaluate(() => document.getElementById('plans').dataset.order);
  await page.click('#plans [data-cancel]');
  await page.waitForSelector('#plans .plans__card');
  const cancelled = await page.evaluate(async (id) => (await (await fetch(`/api/billing/orders/${id}`)).json()).status, open);
  check('Cancel closes the order and returns to the plans', cancelled === 'cancelled', cancelled);
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
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"]');
  const checkout = await page.evaluate(() => {
    const d = document.getElementById('plans');
    const body = d.querySelector('.sheet__body');
    return { page: document.documentElement.scrollWidth <= window.innerWidth, body: body.scrollWidth <= body.clientWidth + 1 };
  });
  check('nor does the checkout', checkout.page && checkout.body, JSON.stringify(checkout));
  await shot('narrow');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  // The phone's drawer was opened to reach the account; put it away before the desktop layout.
  await page.evaluate(() => document.getElementById('scrim')?.click());
  await page.waitForTimeout(200);
}

section('light theme');
{
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
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
    return [...document.querySelectorAll('#plans .plans__preview, #plans .plans__price, #plans .plans__rate, #plans [data-pick]:not(:disabled):not(.btn--primary)')].map((el) => {
      const a = lum(parse(getComputedStyle(el).color).slice(0, 3));
      const b = lum(backdrop(el));
      return ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
    });
  });
  // The primary buttons are white on the house gradient (see .btn--primary), which one measurement cannot describe, so they are left out.
  check('text on the sheet reads at 4.5:1 or better in the light theme', contrast.length > 3 && Math.min(...contrast) >= 4.5, contrast.map((c) => c.toFixed(1)).join());
  await shot('light');
  await page.keyboard.press('Escape');
}

check('no uncaught page errors', page.errors.length === 0, page.errors.join(' | '));
await browser.close();
server.close();
realLog(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
