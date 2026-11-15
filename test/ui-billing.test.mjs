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
  await page.fill('#bill-name', 'Typed Name');
  await page.click('#plans .checkout__period [data-period="year"]');
  check('what was typed in the form survives choosing Yearly', (await page.inputValue('#bill-name')) === 'Typed Name');
  await page.click('#plans .checkout__period [data-period="month"]');
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

section('what the server only schedules, a late answer, a typed form, a double click');
{
  const puts = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/billing\/subscription/.test(req.url())) puts.push(req.postData());
  });
  await openMenu(page);
  await page.click('.plusmenu--account [data-row="upgrade"]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Current plan');
  await page.click('#plans .plans__period [data-period="year"]');
  await page.click('#plans [data-plan="plus"] [data-pick]');
  await page.waitForSelector('#plans .checkout__lines');
  const sched = await page.evaluate(() => ({
    month: document.querySelector('#plans .checkout__period [data-period="month"]').disabled,
    year: document.querySelector('#plans .checkout__period [data-period="year"]').getAttribute('aria-checked'),
    cont: document.querySelector('#plans [data-continue]').disabled,
    total: document.querySelector('#plans .checkout__total dd').textContent,
  }));
  check('Plus monthly to yearly: the Monthly radio is off (the server only schedules it) and yearly is chosen', sched.month && sched.year === 'true', JSON.stringify(sched));
  check('  Continue is live, for a total that is not 0', !sched.cont && !/^0\s/.test(sched.total), JSON.stringify(sched));
  await page.click('#plans [data-back]');
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]');

  // Closing, or going back, while the order is being made leaves no clock and no poll behind.
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-continue]:not([disabled])');
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
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Current plan');
  check('the plan in force reads "Current plan"; Free offers the change at renewal', (await page.textContent('#plans [data-plan="free"] [data-pick]')).trim() === 'Changes at renewal');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-view="checkout"]');
  const quoted = await page.textContent('#plans .checkout__lines');
  check('an upgrade shows the unused part of Plus as a credit', /credit/i.test(quoted), quoted.replace(/\s+/g, ' '));

  // The status answers are stood in for here: a short payment, then silence until the clock runs out.
  // The status line is one node for the whole wait (a replaced node is often not announced), and focus is left alone.
  let answer = { status: 'pending', receivedVnd: 50000, dueVnd: 50000, plan: 'pro' };
  await page.route('**/api/billing/orders/*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) }) : route.fallback()));
  await page.click('#plans [data-continue]');
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

  // Money taken and given back is its own ending, not "waiting" and not "expired".
  answer = { status: 'refunded', receivedVnd: 0, dueVnd: 0, plan: 'pro' };
  await page.click('#plans [data-back]');
  await page.waitForSelector('#plans .plans__card [data-pick="pro"]:not([disabled])');
  await page.click('#plans [data-plan="pro"] [data-pick]');
  await page.waitForSelector('#plans [data-continue]:not([disabled])');
  await page.click('#plans [data-continue]');
  await page.waitForFunction(() => /balance/.test(document.querySelector('#plans .pay__status')?.textContent || ''), null, { timeout: 9000 }).catch(() => {});
  const refunded = await page.evaluate(() => ({ text: document.querySelector('#plans .pay__status').textContent, timer: document.querySelector('#plans .pay__time').hidden }));
  check('a refunded order ends the wait and says the money went to the balance', /added to your balance/.test(refunded.text) && !/Waiting|Expired/.test(refunded.text) && refunded.timer, refunded.text);
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
    return [...document.querySelectorAll('#plans .plans__preview, #plans .plans__price, #plans .plans__per, #plans .plans__billed, #plans .plans__lines li, #plans .plans__rate, #plans .plans__payg, #plans [data-pick]:not(:disabled):not(.btn--primary)')].map((el) => {
      const a = lum(parse(getComputedStyle(el).color).slice(0, 3));
      const b = lum(backdrop(el));
      return ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
    });
  });
  // The primary buttons are white on the house gradient (see .btn--primary), which one measurement cannot describe, so they are left out.
  check('text on the sheet reads at 4.5:1 or better in the light theme', contrast.length > 8 && Math.min(...contrast) >= 4.5, contrast.map((c) => c.toFixed(1)).join());
  await shot('light');
  await page.keyboard.press('Escape');
}

/* ── Task 10: Settings → Billing and the administrators' card ─────────── */
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
const OWNER = 'u-bill-owner';
const text = (selector) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), selector);
const gotoTab = async (p, tab) => {
  if (!(await p.evaluate(() => document.getElementById('settings').open))) {
    await openMenu(p);
    await p.click('.plusmenu--account [data-row="settings"]');
    await p.waitForSelector('#settings[open]');
  }
  await p.click(`#tab-${tab}`);
};
const billingReady = () => page.waitForFunction(() => !!document.querySelector('#billing-panel [data-sec="plan"] h3') && !document.querySelector('#billing-panel [data-loading]'), null, { timeout: 8000 });
const reopenBilling = async () => {
  await page.click('#tab-usage');
  await page.click('#tab-billing');
  await billingReady();
};

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
  await page.waitForSelector('#plans[open] .plans__card');
  check('Adjust plan opens the plans sheet', true);
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
  check('Cancel plan says when the plan ends and offers Keep plan', /Ends \d|Ends [A-Z]/.test(await text('[data-sec="plan"]')) && (await page.locator('[data-keep-plan]').count()) === 1, await text('[data-sec="plan"]'));
  await page.click('[data-keep-plan]');
  await page.waitForFunction(() => !document.querySelector('[data-keep-plan]'));

  puts.length = 0;
  await page.click('#bill-low-on');
  await page.waitForFunction(() => !document.getElementById('bill-low-amount').disabled);
  check('turning the low-balance email on asks for 50,000 by default', puts.length === 1 && puts[0] === '/api/billing/alerts {"lowBalanceVnd":50000}', puts.join(' | '));
  await page.fill('#bill-low-amount', '80000');
  await page.dispatchEvent('#bill-low-amount', 'change');
  await page.waitForTimeout(400);
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
  await page.fill('#bp-email', 'not-an-email');
  await page.click('[data-sec="info"] [data-save-info]');
  await page.waitForFunction(() => !!document.querySelector('[data-sec="info"] [role="alert"]')?.textContent.trim());
  check('what the server refuses is shown beside the form', /valid email/i.test(await text('[data-sec="info"] [role="alert"]')), await text('[data-sec="info"] [role="alert"]'));
  await page.fill('#bp-email', 'b@example.com');
  await page.click('[data-sec="info"] [data-save-info]');
  await page.waitForFunction(() => /b@example\.com/.test(document.querySelector('[data-sec="info"]')?.textContent || '') && !document.querySelector('#bp-name'));
  check('a good save shows the new information and puts focus on Update', await page.evaluate(() => document.activeElement?.hasAttribute('data-edit-info')));
}

section('a plan in grace: Renew now, the date instead of a clock, and no late cancel of a shared renewal order');
{
  const sub = await store.getSubscription(OWNER);
  const day = 86_400_000;
  await store.saveSubscription({ ...sub, status: 'active', autoRenew: false, cancelAtEnd: false, nextPlan: null, nextPeriod: null, periodStart: new Date(Date.now() - 31 * day), periodEnd: new Date(Date.now() - day) });
  await reopenBilling();
  const grace = await text('[data-sec="plan"]');
  check('the Plan card says "In grace until … add credit to keep Plus"', /In grace until .+ — add credit to keep Plus/.test(grace), grace);
  check('  and offers Renew now', (await page.locator('[data-renew]').count()) === 1);
  await page.click('[data-adjust]');
  await page.waitForFunction(() => document.querySelector('#plans [data-plan="plus"] [data-pick]')?.textContent.trim() === 'Renew');
  check('the sheet\'s button for the plan in force reads Renew, and is on', await page.evaluate(() => !document.querySelector('#plans [data-plan="plus"] [data-pick]').disabled));
  await page.keyboard.press('Escape');

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
  await page.waitForSelector('#plans [data-continue]:not([disabled])');
  await page.click('#plans [data-continue]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2200);
  page.off('request', watch);
  await page.unroute('**/api/billing/orders');
  check('the renewal order made after Esc is left open for the period', !calls.some((c) => /\/cancel$/.test(c)) && calls.some((c) => c === 'POST /api/billing/orders'), calls.join(' | '));

  await page.click('[data-renew]');
  await page.waitForSelector('#plans [data-continue]:not([disabled])');
  await page.click('#plans [data-continue]');
  await page.waitForSelector('#plans .pay__qr img');
  const timer = await text('#plans .pay__time');
  check('a renewal good for days shows a date and time, not 4319:59', !/\d{3,}:\d\d/.test(timer) && !/^.*\b\d{2}:\d\d\b.*\b\d{2}:\d\d\b/.test(timer) && /until/i.test(timer) && /20\d\d/.test(timer), timer);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#plans:not([open])', { state: 'attached' }).catch(() => {});
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
  check('the card shows the mode and the rate', /preview/i.test(await text('#admin-billing [data-adm="mode"]')) && /25,500/.test(await text('#admin-billing [data-adm="rate"]')), await text('#admin-billing [data-adm="rate"]'));
  check('the money in the last 30 days, the month\'s cost and margin are drawn', /Plans/.test(card) && /Pay as you go/.test(card) && /Top-ups/.test(card) && /Real cost/.test(card) && /Margin/.test(card) && /Balances held/.test(card), card.slice(0, 300));
  check('the unmatched content is shown as text, not as markup', (await page.locator('#admin-billing [data-transfer] b').count()) === 0 && /<b>nha<\/b>/.test(card));
  check('failed e-invoices are not mentioned while there are none', !/e-invoices/i.test(card));

  const toAssign = page.locator('#admin-billing [data-transfer]', { hasText: '75,000' });
  await toAssign.locator('[data-assign-email]').fill('nobody@test.local');
  await toAssign.locator('[data-assign]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#admin-billing [data-transfer] [role="alert"]')].some((a) => /No account has that email/.test(a.textContent || '')));
  check('an email that matches no account is said, next to the row', true);
  await page.locator('#admin-billing [data-transfer]', { hasText: '75,000' }).locator('[data-assign-email]').fill('owner@test.local');
  await page.locator('#admin-billing [data-transfer]', { hasText: '75,000' }).locator('[data-assign]').click();
  await page.waitForFunction(() => document.querySelectorAll('#admin-billing [data-transfer]').length === 1, null, { timeout: 6000 });
  const balance = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).balance.vnd);
  check('Assign credits the named account', balance >= 195000, String(balance));

  const keep = page.locator('#admin-billing [data-transfer]').first().locator('[data-dismiss]');
  await keep.click();
  check('Mark returned asks again on the first press and has not acted', (await page.locator('#admin-billing [data-transfer]').count()) === 1 && /sure|really/i.test((await keep.textContent()) || ''), (await keep.textContent()) || '');
  await keep.click();
  await page.waitForFunction(() => document.querySelectorAll('#admin-billing [data-transfer]').length === 0, null, { timeout: 6000 });
  check('the second press marks it returned', true);

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
  await page.waitForFunction(() => /8 to 32/.test(document.querySelector('#adm-promo-msg')?.textContent || ''));
  check('a code the server refuses says why', true);
  const off = page.locator('[data-promo-row="SPRING2026"] [data-promo-disable]');
  await off.click();
  await off.click();
  await page.waitForFunction(() => /Switched off|Off/i.test(document.querySelector('[data-promo-row="SPRING2026"]')?.textContent || ''));
  check('Disable is two presses and then the code reads as switched off', true);

  // The renewal order made earlier is covered by the balance by now (the server says "nothing left to pay"), so a fresh top-up is played.
  const topup = await page.evaluate(async () => (await (await fetch('/api/billing/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'topup', amountVnd: 100000 }) })).json()).order.id);
  await page.click('#tab-usage');
  await page.click('#tab-admin');
  await page.waitForSelector('#adm-sim-order option[value]:not([value=""])', { state: 'attached' });
  const before = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).balance.vnd);
  await page.selectOption('#adm-sim-order', topup);
  await page.click('[data-simulate]');
  await page.waitForFunction(() => !!document.querySelector('#adm-sim-msg')?.textContent.trim(), null, { timeout: 6000 });
  check('the simulation says what came of it', /Simulated: /.test(await text('#adm-sim-msg')), await text('#adm-sim-msg'));
  const after = await page.evaluate(async () => (await (await fetch('/api/billing')).json()).balance.vnd);
  check('Simulate a transfer plays the bank for a pending order: the top-up is credited', after === before + 100000, `${before} -> ${after}`);
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
