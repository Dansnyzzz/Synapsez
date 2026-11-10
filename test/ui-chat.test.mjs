/**
 * The conversation screen, in a real browser (owner, 2026-11-04):
 *
 *   - deleting a conversation goes home, whatever state it was in
 *   - opening one shows that it is loading, and only the newest press lands
 *   - a long paste becomes a card, and the card gives its words back
 *   - a long message is folded to eight lines
 *   - the writing box has a scrollbar that can be held and dragged
 *   - a question's answer reads from its step, with no second copy beside it
 *
 * Its own file because `test/ui.test.mjs` takes ten minutes and these are worked
 * on in a loop. Slow answers are made with `page.route`, so the order things
 * arrive in is forced rather than lucky.
 *
 *   npm run test:ui
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'ui-chat-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-chat-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-chat-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

const { initStore, getStore } = await import('../server/store/index.js');
await initStore();
const { createApp } = await import('../server/app.js');
const PORT = 5195;
const server = (await createApp()).listen(PORT);
await new Promise((r) => server.once('listening', r));

const { chromium } = await import('playwright-core');

// `--hide-scrollbars` is Playwright's own default, and the scrollbar is a thing
// this suite is here to look at.
let browser;
for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
  try {
    browser = await chromium.launch({ ...options, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
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

const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('pageerror', (err) => realLog(`  \x1b[31m[page error]\x1b[0m ${err.message}\n${String(err.stack || '').split('\n').slice(1, 4).join('\n')}`));

let failures = 0;
const begun = Date.now();
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m  \x1b[2m${Math.round((Date.now() - begun) / 1000)}s\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/* ── getting in ──────────────────────────────────────────────────── */

const closeDialogs = () => page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));

// The new-model announcement arrives whenever the catalogue answers, modal, and
// takes both the pointer and the focus: a run failed on it at a random step.
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate-username');
await page.fill('#gate-username', 'chat.tester');
await page.fill('#gate-email', 'chat@test.local');
await page.fill('#gate-password', 'a-long-enough-password');
await page.check('#gate-consent');
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');
await page.waitForTimeout(1200);
await closeDialogs();

const store = getStore();
const me = await store.getUserByEmail('chat@test.local');

/** A stored conversation, with a question and a reply in it. */
const seed = async (id, title, words = `words of ${title}`) => {
  await store.createChat(me.id, { id, title, model: 'auto' });
  const at = new Date().toISOString();
  await store.appendMessage(me.id, id, { id: `${id}-u`, role: 'user', text: words, createdAt: at });
  await store.appendMessage(me.id, id, { id: `${id}-a`, role: 'assistant', text: `Reply in ${title}`, createdAt: at });
};

const reload = async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(900);
  await closeDialogs();
};

/** What the screen is showing, in one object. */
const view = () =>
  page.evaluate(() => ({
    title: document.getElementById('chat-title').textContent,
    home: !document.getElementById('empty-state').hidden,
    fresh: document.getElementById('app').classList.contains('is-fresh'),
    text: document.getElementById('messages').textContent.slice(0, 80),
    messages: document.querySelectorAll('#messages .msg').length,
    active: [...document.querySelectorAll('.chat-row.is-active')].map((r) => /** @type {HTMLElement} */ (r).dataset.chat),
    rows: [...document.querySelectorAll('.chat-row')].map((r) => /** @type {HTMLElement} */ (r).dataset.chat),
    chevron: !document.getElementById('chat-menu').hidden,
    spinner: !(document.getElementById('chat-loading')?.hidden ?? true),
  }));

const pressRow = (id) => page.click(`.chat-row[data-chat="${id}"] .chat-item`);
const openRow = async (id) => {
  await pressRow(id);
  await page.waitForFunction((want) => document.getElementById('chat-title').textContent === want, (await store.getChat(me.id, id)).title);
  await page.waitForTimeout(250);
};

const pressDelete = async (id) => {
  await page.hover(`.chat-row[data-chat="${id}"]`);
  await page.click(`.chat-row[data-chat="${id}"] .chat-row__menu`);
  await page.waitForTimeout(150);
  await page.click('.menu__item--danger');
  await page.waitForTimeout(100);
  await page.click('.menu__item--danger');
};

/**
 * Hold an answer back until `release`. The request has reached the server when
 * this is holding it, so what is being delayed is only the answer's arrival.
 */
const hold = async (pattern, method = 'GET') => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) return route.continue();
    const response = await route.fetch().catch(() => null);
    await gate;
    if (response) await route.fulfill({ response }).catch(() => {});
    else await route.abort().catch(() => {});
  });
  return {
    release,
    stop: async () => {
      release();
      await page.unroute(pattern);
    },
  };
};

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

const toastSaid = () => page.evaluate(() => [...document.querySelectorAll('#toasts-alert > *, #toasts > *')].map((n) => n.textContent).join(' | '));

/* ── deleting ────────────────────────────────────────────────────── */

section('deleting the conversation on screen goes home');
{
  await seed('del-a', 'Delete me');
  await seed('del-b', 'Keep me');
  await reload();
  await openRow('del-a');

  // Held: home must not wait for the server to answer.
  const slow = await hold('**/api/chats/del-a', 'DELETE');
  await pressDelete('del-a');
  await page.waitForTimeout(250);
  const before = await view();
  check('at once, before the server has answered', before.home && before.fresh && before.messages === 0, JSON.stringify(before));
  check('  and its row leaves with it', !before.rows.includes('del-a'), JSON.stringify(before.rows));
  check('  under the blank conversation\'s title', before.title === 'New chat', before.title);
  check('  with nothing of the old one left: no menu on the title, no row lit', !before.chevron && before.active.length === 0, JSON.stringify(before));
  await slow.stop();
  await page.waitForTimeout(500);
  const after = await view();
  check('and its row goes', !after.rows.includes('del-a') && after.rows.includes('del-b'), JSON.stringify(after.rows));
  const focused = await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id}.${document.activeElement?.className}`);
  check('the box is ready to write in', focused.startsWith('TEXTAREA#input'), focused);
}

section('deleting a conversation that is still answering stops it');
{
  await seed('del-run', 'Answering');
  await reload();
  await openRow('del-run');
  const stopped = [];
  const onStop = (request) => {
    if (request.method() === 'POST' && /\/api\/chats\/del-run\/stop$/.test(request.url())) stopped.push(request.url());
  };
  page.on('request', onStop);
  // A turn that never answers: the model would go on spending for as long as it lasted.
  await page.route('**/api/chats/del-run/run', () => {});
  await page.fill('#input', 'go on then');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('stop').hidden);
  await pressDelete('del-run');
  await page.waitForTimeout(400);
  const after = await view();
  check('home', after.home && after.messages === 0 && after.title === 'New chat', JSON.stringify(after));
  check('the server is told to stop it', stopped.length === 1, stopped.join());
  check('and the box no longer offers Stop', await page.evaluate(() => document.getElementById('stop').hidden));
  check('the next message goes into a conversation of its own', await page.evaluate(() => !document.getElementById('send').hidden));
  page.off('request', onStop);
  await page.unroute('**/api/chats/del-run/run');

  // New chat leaves the turn running, as it always has, but not its button.
  await seed('new-run', 'Left running');
  await reload();
  await openRow('new-run');
  const told = [];
  const onLeft = (request) => {
    if (request.method() === 'POST' && /\/api\/chats\/new-run\/stop$/.test(request.url())) told.push(request.url());
  };
  page.on('request', onLeft);
  await page.route('**/api/chats/new-run/run', () => {});
  await page.fill('#input', 'keep going');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('stop').hidden);
  await page.click('#new-chat');
  await page.waitForTimeout(200);
  check('New chat while one answers does not keep its Stop', await page.evaluate(() => document.getElementById('stop').hidden));
  check('  and does not stop it either', told.length === 0, told.join());
  await openRow('new-run');
  check('  coming back, the Stop is there again', await page.evaluate(() => !document.getElementById('stop').hidden));
  page.off('request', onLeft);
  await page.unroute('**/api/chats/new-run/run');
  await reload();
}

section('deleting one that is still loading does not bring it back');
{
  await seed('del-c', 'Loading then deleted');
  await reload();
  const slow = await hold('**/api/chats/del-c');
  await pressRow('del-c');
  await page.waitForTimeout(150);
  await pressDelete('del-c');
  await page.waitForTimeout(350);
  const during = await view();
  check('home once deleted', during.home && during.title === 'New chat', JSON.stringify(during));
  check('  and not still spinning', !during.spinner);
  await slow.stop();
  await page.waitForTimeout(600);
  const landed = await view();
  check('the answer that arrives afterwards is dropped', landed.home && landed.title === 'New chat' && landed.messages === 0, JSON.stringify(landed));
}

section('deleting a conversation that is not on screen leaves the screen alone');
{
  await seed('del-d', 'Open one');
  await seed('del-e', 'Other one');
  await reload();
  await openRow('del-d');
  await pressDelete('del-e');
  await page.waitForTimeout(600);
  const after = await view();
  check('the open one stays open', after.title === 'Open one' && after.messages === 2, JSON.stringify(after));
  check('the other row goes', !after.rows.includes('del-e'));
}

section('a delete the server refuses says so, and the row stays');
{
  await seed('del-f', 'Refused');
  await reload();
  await openRow('del-f');
  await page.route('**/api/chats/del-f', (route) => (route.request().method() === 'DELETE' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"The database is resting"}' }) : route.continue()));
  await pressDelete('del-f');
  await page.waitForTimeout(600);
  const after = await view();
  check('the reason is shown', /The database is resting/.test(await toastSaid()), await toastSaid());
  check('the conversation is still in the list', after.rows.includes('del-f'), JSON.stringify(after.rows));
  await page.unroute('**/api/chats/del-f');
}

section('deleting on the Archive shelf the conversation open behind it');
{
  await seed('del-g', 'Archived then deleted');
  await reload();
  await openRow('del-g');
  await store.updateChat(me.id, 'del-g', { archived: true });
  await page.click('#open-archive');
  await page.waitForSelector('[data-drop-archived="del-g"]');
  await page.click('[data-drop-archived="del-g"]');
  await page.waitForTimeout(150);
  await page.click('[data-drop-archived="del-g"]');
  await page.waitForTimeout(700);
  check('the shelf stays where it was', await page.evaluate(() => !document.getElementById('page').hidden));
  await page.click('#new-chat');
  const after = await view();
  check('and nothing still points at the deleted conversation', after.home && after.messages === 0, JSON.stringify(after));
  check('  the server has none', !(await store.getChat(me.id, 'del-g')));
}

/* ── opening ─────────────────────────────────────────────────────── */

section('pressing a conversation goes to a loading screen at once');
{
  await seed('open-a', 'First');
  await seed('open-b', 'Second');
  await seed('open-c', 'Third');
  await reload();
  await openRow('open-a');

  const slow = await hold('**/api/chats/open-b');
  await pressRow('open-b');
  await page.waitForTimeout(120);
  const during = await view();
  check('a spinner is showing', during.spinner, JSON.stringify(during));
  check('  said in words too, for a screen reader', await page.evaluate(() => {
    const box = document.getElementById('chat-loading');
    return box?.getAttribute('role') === 'status' && /Loading/.test(box.textContent || '');
  }));
  const ring = await page.evaluate(() => {
    const node = document.querySelector('#chat-loading .chat-loading__ring');
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const thread = document.getElementById('thread').getBoundingClientRect();
    return { moving: getComputedStyle(node).animationName !== 'none', middle: Math.abs(box.left + box.width / 2 - (thread.left + thread.width / 2)) < 12, onScreen: box.top > thread.top && box.bottom < thread.bottom };
  });
  check('  a turning ring in the middle of the conversation', ring?.moving && ring?.middle && ring?.onScreen, JSON.stringify(ring));
  check('the last conversation has gone from the screen', during.messages === 0 && !during.text.includes('First'), during.text);
  check('the new one is named at once', during.title === 'Second', during.title);
  check('and its row is lit at once', during.active.join() === 'open-b', during.active.join());
  check('the home screen is not flashed in between', !during.home && !during.fresh, JSON.stringify(during));
  await slow.stop();
  await page.waitForTimeout(500);
  const done = await view();
  check('when it arrives the spinner goes and the messages are there', !done.spinner && done.messages === 2 && done.text.includes('words of Second'), JSON.stringify(done));
}

section('only the newest press lands');
{
  await reload();
  const aborted = [];
  const heard = (request) => {
    if (/\/api\/chats\/open-a$/.test(request.url())) aborted.push(request.failure()?.errorText || '');
  };
  page.on('requestfailed', heard);
  const slow = await hold('**/api/chats/open-a');
  await pressRow('open-a');
  await page.waitForTimeout(120);
  await pressRow('open-c');
  await page.waitForFunction(() => document.getElementById('messages').textContent.includes('words of Third'));
  const third = await view();
  check('the second press arrives while the first is still out', third.title === 'Third' && !third.spinner, JSON.stringify(third));
  await slow.stop();
  await page.waitForTimeout(700);
  const after = await view();
  check('the first answer changes nothing when it comes', after.title === 'Third' && after.text.includes('words of Third') && after.active.join() === 'open-c', JSON.stringify(after));
  check('the first request was cancelled, not merely ignored', aborted.length === 1, JSON.stringify(aborted));
  page.off('requestfailed', heard);
}

section('pressing the same row again while it loads, and three in a row');
{
  await reload();
  const slow = await hold('**/api/chats/open-b');
  await pressRow('open-b');
  await page.waitForTimeout(80);
  await pressRow('open-b');
  await page.waitForTimeout(80);
  check('still loading', (await view()).spinner);
  await slow.stop();
  await page.waitForFunction(() => document.getElementById('messages').textContent.includes('words of Second'));
  const after = await view();
  check('it opens, once', after.messages === 2 && !after.spinner, JSON.stringify(after));

  await pressRow('open-a');
  await pressRow('open-c');
  await pressRow('open-b');
  await page.waitForTimeout(900);
  const raced = await view();
  check('the last of three quick presses is what stays', raced.title === 'Second' && raced.text.includes('words of Second') && raced.messages === 2, JSON.stringify(raced));
}

section('nothing is sent while the conversation is arriving, and nothing typed is lost');
{
  await reload();
  await openRow('open-a');
  await page.fill('#input', 'a thought in progress');
  const posted = [];
  const onPost = (request) => {
    if (request.method() === 'POST' && /\/messages$/.test(request.url())) posted.push(request.url());
  };
  page.on('request', onPost);
  const slow = await hold('**/api/chats/open-b');
  await pressRow('open-b');
  await page.waitForTimeout(120);
  const send = await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.getElementById('send')).disabled);
  check('Send is off', send);
  await page.focus('#input');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check('Enter does not send it to the wrong conversation', posted.length === 0, posted.join());
  check('what was typed is still there', (await page.inputValue('#input')) === 'a thought in progress');
  await slow.stop();
  await page.waitForTimeout(500);
  check('and Send comes back when it has arrived', await page.evaluate(() => !/** @type {HTMLButtonElement} */ (document.getElementById('send')).disabled));
  page.off('request', onPost);
  await page.fill('#input', '');
}

section('a conversation that will not open puts you back');
{
  await reload();
  await openRow('open-a');
  await page.route('**/api/chats/open-b', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }));
  await pressRow('open-b');
  await page.waitForFunction(() => document.getElementById('messages').textContent.includes('words of First'));
  await page.waitForTimeout(200);
  const after = await view();
  check('back in the one you were in', after.title === 'First' && after.active.join() === 'open-a' && after.messages === 2 && !after.spinner, JSON.stringify(after));
  check('and told why', /could not be opened/.test(await toastSaid()), await toastSaid());
  await page.unroute('**/api/chats/open-b');

  // From the blank conversation there is nothing to go back to but itself.
  await page.click('#new-chat');
  await page.waitForTimeout(200);
  await page.route('**/api/chats/open-c', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }));
  await pressRow('open-c');
  await page.waitForTimeout(500);
  const blank = await view();
  check('from a blank conversation, back to a blank one', blank.home && !blank.spinner && blank.title === 'New chat' && blank.active.length === 0, JSON.stringify(blank));
  await page.unroute('**/api/chats/open-c');
}

section('New chat during a load wins');
{
  await reload();
  const slow = await hold('**/api/chats/open-b');
  await pressRow('open-b');
  await page.waitForTimeout(120);
  await page.click('#new-chat');
  await page.waitForTimeout(200);
  const blank = await view();
  check('home, no spinner', blank.home && !blank.spinner, JSON.stringify(blank));
  await slow.stop();
  await page.waitForTimeout(500);
  const after = await view();
  check('and the late answer does not take it away', after.home && after.messages === 0 && after.title === 'New chat', JSON.stringify(after));
}

section('the conversation already on screen never flashes a spinner');
{
  await reload();
  await openRow('open-a');
  const slow = await hold('**/api/chats/open-a');
  await pressRow('open-a');
  await page.waitForTimeout(120);
  const during = await view();
  check('its messages stay up while it refreshes', !during.spinner && during.messages === 2, JSON.stringify(during));
  await slow.stop();
  await page.waitForTimeout(400);
}

section('a press during a slow answer cannot start anything on the wrong conversation');
{
  await seed('pin-a', 'Pinned A', 'the question in A');
  await seed('pin-b', 'Pinned B');
  await reload();
  await openRow('pin-a');
  const runsAsked = [];
  const onRun = (request) => {
    const hit = /\/api\/chats\/([^/]+)\/run$/.exec(request.url());
    if (request.method() === 'POST' && hit) runsAsked.push(hit[1]);
  };
  page.on('request', onRun);
  await page.route('**/run', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no model in this test"}' }));

  // Saved in A, then B pressed before the server has answered the save.
  await page.hover('#messages .msg--user');
  await page.click('#messages .msg--user [data-act="edit"]');
  await page.fill('.bubble__edit', 'the question, rewritten');
  const slowEdit = await hold('**/api/chats/pin-a/messages/**', 'PATCH');
  await page.click('[data-edit="save"]');
  await page.waitForTimeout(120);
  await pressRow('pin-b');
  await page.waitForTimeout(150);
  await slowEdit.stop();
  await page.waitForTimeout(800);
  check('the edited conversation is the one asked again', runsAsked.includes('pin-a'), runsAsked.join());
  check('and the one pressed meanwhile is left alone', !runsAsked.includes('pin-b'), runsAsked.join());
  const onB = await view();
  check('  which is what is on screen', onB.title === 'Pinned B' && onB.text.includes('words of Pinned B') && !onB.text.includes('rewritten'), JSON.stringify(onB));
  page.off('request', onRun);
}

section('a line queued in a conversation waits until that conversation has arrived');
{
  await seed('queue-a', 'Queue A');
  await seed('queue-b', 'Queue B');
  await reload();
  await page.unroute('**/run');
  let finishRun;
  const runHeld = new Promise((resolve) => {
    finishRun = resolve;
  });
  await page.route('**/api/chats/queue-a/run', async (route) => {
    await runHeld;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no model in this test"}' }).catch(() => {});
  });
  await openRow('queue-a');
  await page.fill('#input', 'the first thing');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('stop').hidden);
  await page.fill('#input', 'a line for later');
  await page.click('#send');
  await page.waitForSelector('#queue:not([hidden])');

  // Away, then back, with the answer of the way back held: A's run ends meanwhile.
  await openRow('queue-b');
  const posted = [];
  const onPost = (request) => {
    if (request.method() === 'POST' && /\/queue-a\/messages$/.test(request.url())) posted.push(request.postData() || '');
  };
  page.on('request', onPost);
  const slow = await hold('**/api/chats/queue-a');
  await pressRow('queue-a');
  await page.waitForTimeout(150);
  finishRun();
  await page.waitForTimeout(600);
  check('nothing is posted while the conversation is still arriving', posted.length === 0, posted.join());
  await slow.stop();
  await page.waitForFunction(() => document.getElementById('messages').textContent.includes('a line for later'));
  await page.waitForTimeout(300);
  check('and the line goes once it has, into the page it belongs in', posted.length === 1 && posted[0].includes('a line for later'), posted.join());
  page.off('request', onPost);
  await page.unroute('**/api/chats/queue-a/run');
  await page.route('**/run', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no model in this test"}' }));
}

section('going back after a failed open, and pressing again meanwhile');
{
  await seed('back-a', 'Back A');
  await seed('back-b', 'Back B');
  await seed('back-c', 'Back C');
  await reload();
  await openRow('back-a');
  await page.route('**/api/chats/back-b', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }));
  await page.route('**/api/chats/back-c', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }));
  // The way back to A is slow, and C is pressed during it, and C fails too.
  const slowA = await hold('**/api/chats/back-a');
  await pressRow('back-b');
  await page.waitForTimeout(200);
  await pressRow('back-c');
  await page.waitForTimeout(200);
  await slowA.stop();
  await page.waitForTimeout(600);
  const after = await view();
  check('it still ends in the conversation they really came from', after.title === 'Back A' && after.messages === 2, JSON.stringify(after));
  await page.unroute('**/api/chats/back-b');

  // A shelf opened while a conversation was loading is not closed by its failing.
  let failNow;
  const gate = new Promise((resolve) => {
    failNow = resolve;
  });
  await page.route('**/api/chats/back-b', async (route) => {
    await gate;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }).catch(() => {});
  });
  await pressRow('back-b');
  await page.waitForTimeout(120);
  await page.click('#open-archive');
  await page.waitForTimeout(250);
  failNow();
  await page.waitForTimeout(600);
  check('a shelf opened meanwhile stays open when the load fails', await page.evaluate(() => !document.getElementById('page').hidden));
  await page.unroute('**/api/chats/back-b');
  await page.unroute('**/api/chats/back-c');
  await page.click('#new-chat');
  await page.waitForTimeout(150);
}

/* ── a long paste ────────────────────────────────────────────────── */

/** A paste as the browser delivers it, falling through to the box as the browser would. */
const paste = (selector, text) =>
  page.evaluate(
    ({ selector, text }) => {
      const box = /** @type {HTMLTextAreaElement} */ (document.querySelector(selector));
      box.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      const delivered = box.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      // One insertion and one `input`, as a real paste is. `execCommand` inserts a
      // line at a time, and 2,400 lines took this suite five minutes.
      if (delivered) {
        box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return delivered;
    },
    { selector, text },
  );

const LONG = Array.from({ length: 104 }, (_, i) => `Dòng ${i + 1}: Reviewer comments on the manuscript, line after line of them.`).join('\n');
const uploaded = () => page.waitForFunction(() => !document.querySelector('#attachments .stage__spin') && !!document.querySelector('#attachments .stage--pasted'));

section('a paste this long is a card, as Claude has it');
{
  await reload();
  await page.click('#new-chat');
  await page.waitForTimeout(150);

  await paste('#input', 'x'.repeat(3999));
  const short = await page.evaluate(() => ({ value: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value.length, cards: document.querySelectorAll('#attachments .stage--pasted').length }));
  check('one character under the line stays in the box', short.value === 3999 && short.cards === 0, JSON.stringify(short));
  await page.fill('#input', '');

  await paste('#input', 'y'.repeat(4000));
  await uploaded();
  const atLine = await page.evaluate(() => ({ value: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value.length, cards: document.querySelectorAll('#attachments .stage--pasted').length }));
  check('at the line it is a card, and the box stays empty', atLine.value === 0 && atLine.cards === 1, JSON.stringify(atLine));
  await page.click('#attachments .stage--pasted .stage__remove');

  await paste('#input', '   \n\n'.repeat(1200));
  check('a long run of nothing is not a card', await page.evaluate(() => !document.querySelector('#attachments .stage--pasted')));
  await page.fill('#input', '');

  await page.fill('#input', 'bạn dịch giúp tôi:');
  await paste('#input', LONG);
  await uploaded();
  const card = await page.evaluate(() => {
    const node = document.querySelector('#attachments .stage--pasted');
    const box = node.getBoundingClientRect();
    return {
      typed: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value,
      excerpt: node.querySelector('.stage__excerpt')?.textContent || '',
      badge: node.querySelector('.stage__badge')?.textContent || '',
      viewLabel: node.querySelector('.stage__open')?.getAttribute('aria-label') || '',
      pencil: node.querySelector('.stage__pencil')?.getAttribute('aria-label') || '',
      remove: node.querySelector('.stage__remove')?.getAttribute('aria-label') || '',
      square: Math.abs(box.width - box.height) < 2,
      send: !/** @type {HTMLButtonElement} */ (document.getElementById('send')).disabled,
    };
  });
  check('what was already typed stays typed', card.typed === 'bạn dịch giúp tôi:', card.typed);
  check('the card opens with the first of the words', card.excerpt.startsWith('Dòng 1: Reviewer'), card.excerpt.slice(0, 40));
  check('  and is marked as pasted', card.badge === 'PASTED', card.badge);
  check('  a square tile', card.square);
  check('  every control on it has a name', !!card.viewLabel && !!card.pencil && !!card.remove, JSON.stringify(card));
  check('it can be sent', card.send);
}

section('pressing the card shows the whole of it');
{
  await page.click('#attachments .stage--pasted .stage__open');
  await page.waitForSelector('#pasted-view[open]');
  const shown = await page.evaluate(() => {
    const dialog = document.getElementById('pasted-view');
    return {
      title: dialog.querySelector('h2')?.textContent || '',
      facts: dialog.querySelector('.pasted__facts')?.textContent || '',
      body: dialog.querySelector('.pasted__body')?.textContent || '',
      mono: /mono|consol|courier/i.test(getComputedStyle(dialog.querySelector('.pasted__body')).fontFamily),
      overflowsWindow: dialog.getBoundingClientRect().bottom > window.innerHeight,
    };
  });
  const expectedKb = (new TextEncoder().encode(LONG).length / 1024).toFixed(2);
  check('under its heading', shown.title === 'Pasted content', shown.title);
  check('with its size and its lines', shown.facts.includes(`${expectedKb} KB`) && shown.facts.includes('104 lines'), shown.facts);
  check('and the warning about formatting', /Formatting may be inconsistent/.test(shown.facts), shown.facts);
  check('every word of it', shown.body === LONG, `${shown.body.length} of ${LONG.length}`);
  check('in type where the lines still line up', shown.mono);
  check('inside the window', !shown.overflowsWindow);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const closed = await page.evaluate(() => ({ open: /** @type {HTMLDialogElement} */ (document.getElementById('pasted-view')).open, focus: document.activeElement?.className || '' }));
  check('Escape closes it, and focus goes back to the card', !closed.open && /stage__open/.test(closed.focus), JSON.stringify(closed));
  await page.click('#attachments .stage--pasted .stage__open');
  await page.waitForSelector('#pasted-view[open]');
  await page.mouse.click(8, 8);
  await page.waitForTimeout(100);
  check('so does pressing outside it', await page.evaluate(() => !/** @type {HTMLDialogElement} */ (document.getElementById('pasted-view')).open));
}

section('the pencil puts it in the box to edit');
{
  await page.click('#attachments .stage--pasted .stage__pencil');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    return { value: box.value, cards: document.querySelectorAll('#attachments .stage--pasted').length, focused: document.activeElement === box, caret: box.selectionStart, send: !/** @type {HTMLButtonElement} */ (document.getElementById('send')).disabled };
  });
  check('the card is gone', after.cards === 0);
  check('the words are in the box, after what was typed', after.value === `bạn dịch giúp tôi:\n${LONG}`, `${after.value.length} chars`);
  check('the caret is at the start of what came back', after.focused && after.caret === 'bạn dịch giúp tôi:\n'.length, String(after.caret));
  check('it can be sent from there', after.send);
  await page.fill('#input', '');

  await paste('#input', LONG);
  await uploaded();
  await page.click('#attachments .stage--pasted .stage__pencil');
  await page.waitForTimeout(150);
  const alone = await page.evaluate(() => {
    const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    return { same: box.value, top: box.scrollTop };
  });
  check('alone in the box it reads from the top, as Claude shows it', alone.same === LONG && alone.top === 0, JSON.stringify({ top: alone.top }));
  await page.fill('#input', '');
}

section('the card stops being kept once it is thrown away');
{
  // Asked of the database, not of the network: the first version sent its DELETE
  // to a route that answers 404 for an upload, and "a request went out" passed.
  const texts = async () => (await store.listDataFiles(me.id, { origin: 'upload', query: 'pasted', limit: 100 })).total;
  const before = await texts();
  await paste('#input', LONG);
  await uploaded();
  check('a card waiting to go is stored', (await texts()) === before + 1, `${before} → ${await texts()}`);
  await page.click('#attachments .stage--pasted .stage__remove');
  await page.waitForTimeout(300);
  check('✕ deletes the stored copy', (await texts()) === before, `${before} → ${await texts()}`);
  await paste('#input', LONG);
  await uploaded();
  await page.click('#attachments .stage--pasted .stage__pencil');
  await page.waitForTimeout(300);
  check('and so does the pencil: the words are in the box now', (await texts()) === before, `${before} → ${await texts()}`);
  await page.fill('#input', '');
  // Thrown away while it is still on its way up.
  const slowUpload = await hold('**/api/attachments', 'POST');
  await paste('#input', LONG);
  await page.waitForTimeout(100);
  await page.click('#attachments .stage--pasted .stage__remove');
  await slowUpload.stop();
  await page.waitForTimeout(600);
  check('one thrown away mid-upload is deleted when the upload lands', (await texts()) === before, `${before} → ${await texts()}`);
}

section('a card stays when the conversation changes, as typed words do');
{
  await seed('card-stay', 'Card stays');
  await reload();
  await page.fill('#input', 'typed too');
  await paste('#input', LONG);
  await uploaded();
  await page.click('#new-chat');
  await page.waitForTimeout(200);
  check('New chat keeps it', await page.evaluate(() => document.querySelectorAll('#attachments .stage--pasted').length === 1));
  await openRow('card-stay');
  const after = await page.evaluate(() => ({ cards: document.querySelectorAll('#attachments .stage--pasted').length, typed: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value }));
  check('opening another conversation keeps it, beside what was typed', after.cards === 1 && after.typed === 'typed too', JSON.stringify(after));
  await page.click('#attachments .stage--pasted .stage__open');
  await page.waitForSelector('#pasted-view[open]');
  check('  with every word still in it', (await page.textContent('#pasted-view .pasted__body')) === LONG);
  await page.keyboard.press('Escape');
  await page.click('#attachments .stage--pasted .stage__remove');
  await page.fill('#input', '');
  await page.waitForTimeout(200);

  // A file is a different matter: it was for the conversation it was picked in.
  await page.setInputFiles('#file-input', { name: 'photo.txt', mimeType: 'text/plain', buffer: Buffer.from('a file') });
  await page.waitForFunction(() => document.querySelectorAll('#attachments .stage').length === 1 && !document.querySelector('#attachments .stage__spin'));
  await paste('#input', LONG);
  await uploaded();
  await page.click('#new-chat');
  await page.waitForTimeout(200);
  const left = await page.evaluate(() => ({ all: document.querySelectorAll('#attachments .stage').length, cards: document.querySelectorAll('#attachments .stage--pasted').length }));
  check('a picked file still does not follow you', left.all === 1 && left.cards === 1, JSON.stringify(left));
  await page.click('#attachments .stage--pasted .stage__remove');
  await page.waitForTimeout(150);
}

section('what cannot be a card goes in the box, and is not lost');
{
  await page.fill('#input', '');
  for (let i = 0; i < 6; i += 1) {
    await paste('#input', `${i} ${LONG}`);
    await page.waitForTimeout(40);
  }
  await page.waitForFunction(() => !document.querySelector('#attachments .stage__spin'));
  check('six cards fill a message', await page.evaluate(() => document.querySelectorAll('#attachments .stage--pasted').length === 6));
  const names = await page.evaluate(() => [...document.querySelectorAll('#attachments .stage--pasted')].length);
  await paste('#input', `seventh ${LONG}`);
  const seventh = await page.evaluate(() => /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value);
  check('the seventh paste goes in the box', names === 6 && seventh.startsWith('seventh'), seventh.slice(0, 20));
  await page.fill('#input', '');
  for (let i = 0; i < 6; i += 1) await page.click('#attachments .stage--pasted .stage__remove');
  await page.waitForTimeout(200);

  await page.route('**/api/attachments', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Storage is full"}' }) : route.continue()));
  await paste('#input', LONG);
  await page.waitForSelector('#attachments .stage--pasted.is-failed');
  check('an upload that fails says so on the card', /Storage is full/.test(await page.textContent('#attachments .stage--pasted')));
  check('  and Send stays off for a message with nothing else', await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.getElementById('send')).disabled));
  await page.click('#attachments .stage--pasted .stage__pencil');
  await page.waitForTimeout(150);
  check('  the pencil still gives the words back', (await page.inputValue('#input')) === LONG);

  // Sending something else must not take the failed one with it.
  await page.fill('#input', '');
  await paste('#input', LONG);
  await page.waitForSelector('#attachments .stage--pasted.is-failed');
  await page.route('**/run', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no model in this test"}' }));
  await page.fill('#input', 'a message of its own');
  await page.click('#send');
  await page.waitForSelector('#messages .msg--user');
  await page.waitForTimeout(300);
  check('  a failed card stays when another message is sent', await page.evaluate(() => !!document.querySelector('#attachments .stage--pasted.is-failed')));
  await page.click('#attachments .stage--pasted .stage__pencil');
  await page.waitForTimeout(100);
  check('  and can still be had back', (await page.inputValue('#input')) === LONG);
  await page.unroute('**/api/attachments');
  await page.fill('#input', '');
  await page.click('#new-chat');
  await page.waitForTimeout(150);

  await paste('#input', 'z'.repeat(100_001));
  await uploaded();
  check('past what the model reads, the person is told', /first 100,000 characters/.test(await toastSaid()), await toastSaid());
  await page.click('#attachments .stage--pasted .stage__remove');
  await page.waitForTimeout(100);
}

section('sending a card');
{
  await page.route('**/run', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no model in this test"}' }));
  await page.click('#new-chat');
  await page.waitForTimeout(150);
  await paste('#input', LONG);
  await uploaded();
  await page.click('#send');
  await page.waitForSelector('#messages .msg--user [data-pasted]');
  await page.waitForTimeout(300);
  const sent = await page.evaluate(() => {
    const message = document.querySelector('#messages .msg--user');
    const tile = message.querySelector('[data-pasted]');
    return {
      tag: tile.tagName,
      excerpt: tile.querySelector('.stage__excerpt')?.textContent || '',
      badge: tile.querySelector('.stage__badge')?.textContent || '',
      pencil: !!tile.querySelector('.stage__pencil'),
      bubbleText: message.querySelector('.bubble__text')?.textContent ?? null,
      tray: document.querySelectorAll('#attachments .stage').length,
      title: document.getElementById('chat-title').textContent,
    };
  });
  check('it stays a card on the message', sent.tag === 'BUTTON' && sent.badge === 'PASTED' && sent.excerpt.startsWith('Dòng 1'), JSON.stringify(sent));
  check('  with no pencil: what was sent is sent', !sent.pencil);
  check('  and no empty bubble under it', sent.bubbleText === null, String(sent.bubbleText));
  check('the tray empties', sent.tray === 0);
  check('the conversation is named from the words, not the file', sent.title.startsWith('Dòng 1: Reviewer'), sent.title);

  await page.click('#messages .msg--user [data-pasted]');
  await page.waitForSelector('#pasted-view[open]');
  await page.waitForFunction((want) => document.querySelector('#pasted-view .pasted__body')?.textContent === want, LONG);
  check('pressed, it shows every word', true);
  await page.keyboard.press('Escape');

  const id = await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.chat-row.is-active'))?.dataset.chat);
  await reload();
  await openRow(id);
  await page.waitForFunction(() => document.querySelector('#messages [data-pasted] .stage__excerpt')?.textContent.startsWith('Dòng 1'));
  check('after a reload it is the same card', true);
  await page.click('#messages .msg--user [data-pasted]');
  await page.waitForFunction((want) => document.querySelector('#pasted-view .pasted__body')?.textContent === want, LONG);
  const facts = await page.textContent('#pasted-view .pasted__facts');
  check('and the same words, size and lines', /104 lines/.test(facts), facts);
  await page.keyboard.press('Escape');
}

section('a message that never reached the server comes back to the box');
{
  await page.click('#new-chat');
  await page.waitForTimeout(150);
  await page.fill('#input', 'dịch giúp tôi');
  await paste('#input', LONG);
  await uploaded();
  await page.setInputFiles('#file-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('a file') });
  await page.waitForFunction(() => document.querySelectorAll('#attachments .stage').length === 2 && !document.querySelector('#attachments .stage__spin'));
  await page.route('**/messages', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"The database is resting"}' }) : route.continue()));
  await page.click('#send');
  await page.waitForTimeout(500);
  const failed = await page.evaluate(() => ({
    typed: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value,
    cards: document.querySelectorAll('#attachments .stage--pasted').length,
    files: document.querySelectorAll('#attachments .stage').length,
    ghosts: document.querySelectorAll('#messages .msg--user').length,
    send: !/** @type {HTMLButtonElement} */ (document.getElementById('send')).disabled,
  }));
  check('the words are back', failed.typed === 'dịch giúp tôi', failed.typed);
  check('the card is back, its words still whole', failed.cards === 1, JSON.stringify(failed));
  check('  and the file with it', failed.files === 2, JSON.stringify(failed));
  check('no bubble is left claiming it was sent', failed.ghosts === 0, JSON.stringify(failed));
  check('and it can be sent again', failed.send);
  check('the reason is shown', /The database is resting/.test(await toastSaid()), await toastSaid());
  await page.click('#attachments .stage--pasted .stage__open');
  await page.waitForSelector('#pasted-view[open]');
  check('  the card still opens to every word', (await page.textContent('#pasted-view .pasted__body')) === LONG);
  await page.keyboard.press('Escape');
  await page.unroute('**/messages');
  await page.click('#send');
  await page.waitForSelector('#messages .msg--user [data-pasted]');
  await page.waitForTimeout(300);
  check('sent again it goes, once, with everything', await page.evaluate(() => document.querySelectorAll('#messages .msg--user').length === 1 && document.querySelectorAll('#messages .msg--user .stage').length === 2 && document.querySelectorAll('#attachments .stage').length === 0));
}

section('a queued card that cannot be delivered comes back too');
{
  await seed('queue-fail', 'Queue fail');
  await reload();
  await openRow('queue-fail');
  await page.unroute('**/run');
  await page.route('**/api/chats/queue-fail/run', () => {});
  await page.fill('#input', 'start it');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('stop').hidden);
  await page.fill('#input', 'queued words');
  await paste('#input', LONG);
  await uploaded();
  await page.click('#send');
  await page.waitForSelector('#queue:not([hidden])');
  check('it waits in the queue', await page.evaluate(() => document.querySelectorAll('#attachments .stage--pasted').length === 0));
  await page.route('**/api/chats/queue-fail/messages', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"The database is resting"}' }));
  await page.click('#queue [data-now]');
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => ({
    typed: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value,
    cards: document.querySelectorAll('#attachments .stage--pasted').length,
  }));
  check('Send now failing gives back the words and the card', back.typed === 'queued words' && back.cards === 1, JSON.stringify(back));
  await page.unroute('**/api/chats/queue-fail/messages');
  await page.unroute('**/api/chats/queue-fail/run');
  await page.click('#attachments .stage--pasted .stage__remove');
  await page.fill('#input', '');
  await page.route('**/run', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no model in this test"}' }));
  await reload();
}

section('a card out of view reads nothing until it is scrolled to');
{
  await store.createChat(me.id, { id: 'paste-far', title: 'Far card', model: 'auto' });
  const { saveUpload } = await import('../server/attachments.js');
  const file = await saveUpload(me.id, { name: 'pasted.txt', mime: 'text/plain', data: Buffer.from(`Far away words\n${'x'.repeat(5000)}`).toString('base64') });
  const at = new Date().toISOString();
  const padding = async (from, to) => {
    for (let i = from; i < to; i += 1) {
      await store.appendMessage(me.id, 'paste-far', { id: `far-${i}`, role: 'assistant', text: `A reply\n\n${'long '.repeat(120)}`, createdAt: at });
    }
  };
  // In the middle: opening the conversation glides from the top to the end, past it.
  await padding(0, 20);
  await store.appendMessage(me.id, 'paste-far', { id: 'far-u', role: 'user', text: '', attachments: [{ id: file.id, name: file.name, mime: file.mime, kind: file.kind, bytes: file.bytes }], createdAt: at });
  await padding(20, 40);
  await reload();
  const reads = [];
  const onRead = (request) => {
    if (request.url().includes(file.id)) reads.push(request.url());
  };
  page.on('request', onRead);
  await openRow('paste-far');
  await page.waitForTimeout(500);
  check('scrolled away from it, it has not been fetched', reads.length === 0, reads.join());
  await page.evaluate(() => document.querySelector('#messages [data-pasted]').scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('#messages [data-pasted] .stage__excerpt')?.textContent.startsWith('Far away'));
  check('scrolled to, it reads its words', reads.length === 1, reads.join());
  page.off('request', onRead);
}

section('a card on a shared conversation opens the same way, for somebody signed out');
{
  await store.createChat(me.id, { id: 'share-card', title: 'Shared card', model: 'auto' });
  const { saveUpload } = await import('../server/attachments.js');
  const words = `Shared words\n${'and more of them\n'.repeat(400)}`;
  const file = await saveUpload(me.id, { name: 'pasted.txt', mime: 'text/plain', data: Buffer.from(words).toString('base64') });
  const at = new Date().toISOString();
  await store.appendMessage(me.id, 'share-card', { id: 'share-u', role: 'user', text: lines(20), attachments: [{ id: file.id, name: file.name, mime: file.mime, kind: file.kind, bytes: file.bytes }], createdAt: at });
  await store.appendMessage(me.id, 'share-card', { id: 'share-a', role: 'assistant', text: 'Done.', createdAt: at });
  const { path: link } = await page.evaluate(async () => (await fetch('/api/chats/share-card/share', { method: 'POST' })).json());

  const visitor = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const tab = await visitor.newPage();
  await tab.goto(`http://127.0.0.1:${PORT}${link}`, { waitUntil: 'domcontentloaded' });
  await tab.waitForFunction(() => document.querySelector('[data-pasted] .stage__excerpt')?.textContent.startsWith('Shared words'));
  check('its opening is on the card', true);
  await tab.click('[data-pasted]');
  await tab.waitForFunction((want) => document.querySelector('#pasted-view[open] .pasted__body')?.textContent === want, words);
  check('pressed, it shows every word', true);
  await tab.keyboard.press('Escape');
  const folded = await tab.evaluate(() => {
    const more = /** @type {HTMLElement} */ (document.querySelector('.bubble__more'));
    return { shown: !!more && !more.hidden, label: more?.textContent || '' };
  });
  check('a long message is folded there too', folded.shown && folded.label === 'Show more', JSON.stringify(folded));
  await visitor.close();
}

section('a project\'s box takes a card too, and the pencil goes back there');
{
  const project = await store.createProject?.(me.id, { id: 'paste-proj', name: 'Pasted project' });
  await reload();
  await page.click('#open-projects');
  await page.waitForSelector(`[data-project="${project?.id || 'paste-proj'}"]`);
  await page.click(`[data-project="${project?.id || 'paste-proj'}"]`);
  await page.waitForSelector('#project-page-ask');
  await page.waitForTimeout(300);
  await paste('#project-page-ask', LONG);
  await page.waitForSelector('#project-page-attachments .stage--pasted');
  await page.waitForFunction(() => !document.querySelector('#project-page-attachments .stage__spin'));
  check('the card is on the project page', (await page.inputValue('#project-page-ask')) === '');
  await page.click('#project-page-attachments .stage--pasted .stage__pencil');
  await page.waitForTimeout(150);
  check('the pencil fills the project\'s box', (await page.inputValue('#project-page-ask')) === LONG);
  check('  and lights its Send', await page.evaluate(() => !/** @type {HTMLButtonElement} */ (document.getElementById('project-page-send')).disabled));
  await page.fill('#project-page-ask', '');
}

/* ── a long message ─────────────────────────────────────────────── */

const bubble = () =>
  page.evaluate(() => {
    const message = document.querySelector('#messages .msg--user');
    const body = /** @type {HTMLElement} */ (message.querySelector('.bubble__text'));
    const more = /** @type {HTMLElement|null} */ (message.querySelector('.bubble__more'));
    const style = getComputedStyle(body);
    return {
      full: body.textContent,
      height: body.clientHeight,
      lines: body.clientHeight / parseFloat(style.lineHeight),
      fades: style.maskImage !== 'none' || style.webkitMaskImage !== 'none',
      shown: !!more && !more.hidden && more.offsetParent !== null,
      label: more?.textContent || '',
      expanded: more?.getAttribute('aria-expanded') ?? null,
    };
  });

section('a long message shows its first eight lines');
{
  await seed('fold-30', 'Thirty lines', lines(30));
  await seed('fold-8', 'Eight lines', lines(8));
  await seed('fold-9', 'Nine lines', lines(9));
  await seed('fold-wrap', 'One long line', 'word '.repeat(900));
  await reload();

  await openRow('fold-8');
  let shape = await bubble();
  check('eight lines fit, and offer nothing', Math.round(shape.lines) === 8 && !shape.shown && !shape.fades, JSON.stringify({ ...shape, full: undefined }));

  await openRow('fold-9');
  shape = await bubble();
  check('nine lines are cut to eight', Math.round(shape.lines) === 8 && shape.shown, JSON.stringify({ ...shape, full: undefined }));

  await openRow('fold-wrap');
  shape = await bubble();
  check('wrapped lines count, not only line breaks', Math.round(shape.lines) === 8 && shape.shown, JSON.stringify({ ...shape, full: undefined }));

  await openRow('fold-30');
  shape = await bubble();
  check('thirty lines are cut to eight', Math.round(shape.lines) === 8, String(shape.lines));
  check('  fading out at the foot', shape.fades);
  check('  with Show more', shape.shown && shape.label === 'Show more' && shape.expanded === 'false', JSON.stringify({ label: shape.label, expanded: shape.expanded }));
  check('  every word still in the page, for copy and for edit', shape.full === lines(30));

  const top = await page.evaluate(() => document.getElementById('thread').scrollTop);
  await page.click('#messages .msg--user .bubble__more');
  await page.waitForTimeout(100);
  shape = await bubble();
  check('Show more opens all of it', Math.round(shape.lines) === 30 && !shape.fades, String(shape.lines));
  check('  and becomes Show less', shape.label === 'Show less' && shape.expanded === 'true', shape.label);
  await page.waitForTimeout(500);
  const landed = await page.evaluate(() => document.getElementById('thread').scrollTop);
  check('  without the page jumping to the end of it', Math.abs(landed - top) < 2, `${top} → ${landed}`);

  await page.focus('#messages .msg--user .bubble__more');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  shape = await bubble();
  check('Show less, from the keyboard, folds it again', Math.round(shape.lines) === 8 && shape.label === 'Show more' && shape.fades, JSON.stringify({ ...shape, full: undefined }));
}

section('folding back up keeps your place');
{
  await seed('fold-far', 'Long and last', lines(120));
  await reload();
  await openRow('fold-far');
  await page.click('#messages .msg--user .bubble__more');
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const more = document.querySelector('#messages .msg--user .bubble__more');
    more.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.waitForTimeout(120);
  await page.click('#messages .msg--user .bubble__more');
  await page.waitForTimeout(700);
  const place = await page.evaluate(() => {
    const message = document.querySelector('#messages .msg--user .bubble').getBoundingClientRect();
    const thread = document.getElementById('thread').getBoundingClientRect();
    return { top: message.top, bottom: message.bottom, threadTop: thread.top, threadBottom: thread.bottom };
  });
  check('the message you folded is still on screen', place.bottom > place.threadTop && place.top < place.threadBottom, JSON.stringify(place));
}

section('editing a folded message');
{
  await openRow('fold-30');
  await page.hover('#messages .msg--user');
  await page.click('#messages .msg--user [data-act="edit"]');
  await page.waitForSelector('.bubble__edit');
  check('the box holds all of it', (await page.inputValue('.bubble__edit')) === lines(30));
  await page.click('[data-edit="cancel"]');
  await page.waitForTimeout(150);
  let shape = await bubble();
  check('cancelled, it is folded again', Math.round(shape.lines) === 8 && shape.shown, JSON.stringify({ ...shape, full: undefined }));
  await page.click('#messages .msg--user .bubble__more');
  await page.waitForTimeout(100);
  shape = await bubble();
  check('  and its button still works', Math.round(shape.lines) === 30 && shape.label === 'Show less', String(shape.lines));
}

section('copying takes the words without the button');
{
  await openRow('fold-30');
  const copied = await page.evaluate(() => {
    const more = document.querySelector('#messages .msg--user .bubble__more');
    return { select: getComputedStyle(more).userSelect, inWords: !!more.closest('.bubble__text') };
  });
  check('the button cannot be dragged into a selection, and is outside the words', copied.select === 'none' && !copied.inWords, JSON.stringify(copied));
}

section('a narrower window can make a message long');
{
  await seed('fold-narrow', 'Depends on width', 'word '.repeat(90));
  await reload();
  await openRow('fold-narrow');
  const wide = await bubble();
  await page.setViewportSize({ width: 420, height: 860 });
  await page.waitForTimeout(250);
  const narrow = await bubble();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(250);
  const back = await bubble();
  check('fits when wide', !wide.shown, JSON.stringify({ ...wide, full: undefined }));
  check('gets Show more when narrow', narrow.shown, JSON.stringify({ ...narrow, full: undefined }));
  check('and loses it again', !back.shown && !back.fades, JSON.stringify({ ...back, full: undefined }));
}

/* ── the writing box ────────────────────────────────────────────── */

section('the writing box has a scrollbar you can hold');
{
  await page.click('#new-chat');
  await page.waitForTimeout(150);
  const facts = () =>
    page.evaluate(() => {
      const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
      const style = getComputedStyle(box);
      return {
        overflow: style.overflowY,
        width: style.scrollbarWidth,
        bar: box.offsetWidth - box.clientWidth,
        spills: box.scrollHeight > box.clientHeight + 1,
        track: getComputedStyle(box, '::-webkit-scrollbar-track').backgroundColor,
        arrows: getComputedStyle(box, '::-webkit-scrollbar-button').display,
        top: box.scrollTop,
      };
    });

  let now = await facts();
  check('empty, there is no bar', now.bar === 0, JSON.stringify(now));
  await page.fill('#input', 'one line');
  now = await facts();
  check('a line of words, no bar', now.bar === 0 && !now.spills, JSON.stringify(now));
  await page.fill('#input', lines(5));
  now = await facts();
  check('a few lines grow the box, no bar', now.bar === 0 && !now.spills, JSON.stringify(now));

  await page.fill('#input', lines(120));
  now = await facts();
  check('past the box\'s height the bar is there', now.bar > 0 && now.spills && now.overflow === 'auto', JSON.stringify(now));
  check('  Chromium is left to draw the app\'s own', now.width === 'auto', now.width);
  check('  on a clear track', now.track === 'rgba(0, 0, 0, 0)', now.track);
  check('  with no arrows', now.arrows === 'none', now.arrows);

  const box = await page.evaluate(() => {
    const r = document.getElementById('input').getBoundingClientRect();
    return { right: r.right, top: r.top, bottom: r.bottom };
  });
  await page.evaluate(() => {
    document.getElementById('input').scrollTop = 0;
  });
  await page.mouse.move(box.right - 4, box.top + 12);
  await page.mouse.down();
  await page.mouse.move(box.right - 4, box.bottom - 12, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  now = await facts();
  check('dragging the thumb moves the words', now.top > 100, String(now.top));

  await page.evaluate(() => {
    const el = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  });
  await page.focus('#input');
  const atEnd = (await facts()).top;
  await page.keyboard.type('x');
  await page.waitForTimeout(50);
  now = await facts();
  check('typing at the end does not throw you back to the top', now.top >= atEnd - 30, `${atEnd} → ${now.top}`);

  await page.fill('#input', '');
  now = await facts();
  check('emptied, the box is one line with no bar again', now.bar === 0, JSON.stringify(now));

  /*
   * Words that fitted, and then the box got smaller. The box is set to the height
   * the words had when last typed, and `overflow: hidden` until they spill — so
   * with nothing asking again, what spilled was out of reach: no bar, no wheel.
   */
  const reachable = () =>
    page.evaluate(() => {
      const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
      return { fits: box.scrollHeight <= box.clientHeight + 1, scrolls: getComputedStyle(box).overflowY === 'auto', height: box.clientHeight, whole: box.scrollHeight };
    });
  const words = 'word '.repeat(90);
  await page.fill('#input', words);
  const wide = await reachable();
  check('words that fit have no bar', wide.fits && !wide.scrolls, JSON.stringify(wide));
  await page.setViewportSize({ width: 620, height: 860 });
  await page.waitForTimeout(250);
  const narrow = await reachable();
  check('a narrower window grows the box to fit them', narrow.fits && narrow.height > wide.height, JSON.stringify(narrow));
  await page.setViewportSize({ width: 620, height: 300 });
  await page.waitForTimeout(250);
  const short = await reachable();
  check('a shorter window, where they cannot all fit, gives them a bar', !short.fits && short.scrolls, JSON.stringify(short));
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(250);
  const restored = await reachable();
  check('and back, the bar goes and the box fits again', restored.fits && !restored.scrolls && restored.height === wide.height, JSON.stringify(restored));
  await page.fill('#input', '');
}

/* ── a question and its answer ─────────────────────────────────── */

section('an answer reads from the question\'s step, with no bubble beside it');
{
  const out = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const answer = (content, extra = {}) => {
      const turn = assistantMessage();
      document.body.append(turn.node);
      turn.startTool({ id: 'q1', name: 'ask_options', input: { questions: [{ question: 'Laptop giá bao nhiêu?', options: [{ label: '25 triệu' }, { label: '30 triệu' }] }] } }).complete({ content, ms: 2, ...extra });
      const block = turn.node.querySelector('.block.tool');
      const shown = {
        bubble: !!turn.node.querySelector('.answerbubble'),
        folded: block?.tagName === 'DETAILS' && !block.open,
        call: block?.querySelector('.tool__call')?.textContent || '',
        said: [...(block?.querySelectorAll('pre') || [])].map((p) => p.textContent).join('\n'),
      };
      turn.node.remove();
      return shown;
    };
    return {
      answered: answer('The user answered:\n\nQ: Laptop giá bao nhiêu?\nA: "25 triệu"\n\nCarry on with what they chose. Do not ask this again.'),
      // A turn stored before today still carries the old field. It draws nothing.
      stored: answer('The user answered:\n\nQ: x\nA: "y"\n\nCarry on with what they chose. Do not ask this again.', { answered: 'x: y' }),
      skipped: answer('The user skipped the question rather than answering.\n\nQ: x\nA: (skipped)\n\nCarry on with your own best judgement, and do not ask this again — they have already declined once.'),
    };
  });
  check('no bubble of the person\'s words', !out.answered.bubble, JSON.stringify(out.answered));
  check('  nor from a turn stored with the old field', !out.stored.bubble);
  check('the row is folded like any other tool', out.answered.folded);
  check('opened, it has the call', out.answered.call.includes('Laptop giá bao nhiêu?'), out.answered.call.slice(0, 60));
  check('  and the result', out.answered.said.includes('A: "25 triệu"'), out.answered.said.slice(0, 80));
  check('  without the instruction written for the model', !/Carry on with what they chose/.test(out.answered.said), out.answered.said.slice(-60));
  check('a skipped question says so, the same way', /skipped the question/.test(out.skipped.said) && !/Carry on with your own/.test(out.skipped.said), out.skipped.said.slice(-60));
}

/* ── the plan, as Claude's Progress panel draws it ──────────────────
 *
 * Owner, 2026-11-09, screenshots 2 to 7: a line down the list instead of a blue
 * band, the step it is on with at most two before it and what is to come, the
 * rest behind "N earlier steps", the last two once it is done, and "Step 2 of 7"
 * in the heading. Driven by a stand-in model that sends one plan update per
 * step, each held back until the panel has been looked at, so every state is
 * seen while the run is really live.
 */

const http = await import('node:http');
const { setApiKey, setPrefs } = await import('../server/settings.js');
/** Screenshots to compare with the owner's, when asked for: `PROGRESS_SHOTS=<dir>`. */
const progressShot = async (name) => {
  if (!process.env.PROGRESS_SHOTS) return;
  fs.mkdirSync(process.env.PROGRESS_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.PROGRESS_SHOTS, `${name}.png`) }).catch((err) => realLog(`  (no screenshot: ${err.message})`));
};
const until = async (test, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await page.waitForTimeout(60);
  }
  return false;
};

const SIX = ['Read the brief', 'Gather the numbers', 'Check the sources', 'Draft the summary', 'Review the draft', 'Send it'];
const STATUS = { d: 'done', r: 'in_progress', p: 'pending' };
const planOf = (states) =>
  SIX.map((title, i) => ({ title, status: STATUS[states[i]], ...(states[i] === 'r' ? { detail: `Now: ${title.toLowerCase()}.` } : {}) }));
/** One plan update per step of the run, then the answer. */
const SCRIPT = ['rppppp', 'dddrpp', 'ddddrp', 'dddddr', 'dddddd'];
const arrived = [];
const held = [];
const planner = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const finish = (reason) => {
      say({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 60, completion_tokens: 12 } });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    // Anything that is not a step of the run (no tools offered) is answered and not counted.
    if (!Array.isArray(body.tools) || !body.tools.length) {
      say({ choices: [{ delta: { content: 'ok' } }] });
      return finish('stop');
    }
    const i = arrived.length;
    arrived.push(true);
    if (i > 0) await new Promise((resolve) => (held[i] = resolve));
    if (i < SCRIPT.length) {
      say({ choices: [{ delta: { tool_calls: [{ index: 0, id: `plan-${i}`, type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ steps: planOf(SCRIPT[i]) }) } }] } }] });
      return finish('tool_calls');
    }
    say({ choices: [{ delta: { content: 'All six steps are done.' } }] });
    return finish('stop');
  });
});
await new Promise((r) => planner.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${/** @type {any} */ (planner.address()).port}/v1`;
await setApiKey(me.id, 'openai', 'sk-test-planner-key');
await setPrefs(me.id, { language: 'en', onboarded: true, toolPolicy: 'auto', qualityGate: false, defaultModel: 'openai/planner' });
await reload();

/** What the Progress panel shows, in one object. */
const progress = () =>
  page.evaluate(() => {
    const list = document.getElementById('progress-steps');
    const items = [...list.querySelectorAll('li')];
    const fold = document.getElementById('progress-fold');
    const active = list.querySelector('.is-active');
    const line = (node) => {
      const after = getComputedStyle(node, '::after');
      return after.content !== 'none' && after.content !== 'normal' && after.width === '2px' && after.backgroundColor !== 'rgba(0, 0, 0, 0)';
    };
    return {
      titles: items.map((li) => li.querySelector('.pstep__title')?.textContent || ''),
      states: items.map((li) => (li.classList.contains('is-done') ? 'd' : li.classList.contains('is-active') ? 'r' : 'p')).join(''),
      count: document.getElementById('progress-count').textContent,
      fold: fold.hidden ? null : fold.textContent.trim(),
      expanded: fold.getAttribute('aria-expanded'),
      chevron: !!fold.querySelector('svg'),
      foldTag: fold.tagName,
      foldLine: !fold.hidden && line(fold),
      current: items.filter((li) => li.getAttribute('aria-current') === 'step').map((li) => li.querySelector('.pstep__title')?.textContent),
      detail: active?.querySelector('.pstep__detail')?.textContent || '',
      activeBackground: active ? getComputedStyle(active).backgroundColor : null,
      activeWeight: active ? getComputedStyle(active).fontWeight : null,
      activeColour: active ? getComputedStyle(active).color : null,
      textColour: getComputedStyle(document.body).color,
      lines: items.map(line),
      live: list.classList.contains('is-live'),
      turning: active ? getComputedStyle(active.querySelector('.pmark--active')).animationName : null,
      lastTick: !!items.at(-1)?.querySelector('.pmark--done'),
    };
  });
const pressFold = async () => {
  await page.click('#progress-fold');
  await page.waitForTimeout(120);
};

section('Progress: the step it is on, a line down the list, no blue band');
{
  // The sections above answer every run with "no model in this test"; this one has a model.
  await page.unroute('**/run');
  // From the home screen: the sections above leave a project's page or a paste behind.
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(900);
  await closeDialogs();
  await page.evaluate(() => document.getElementById('new-chat')?.click());
  await page.waitForTimeout(300);
  await page.fill('#input', 'Write me the summary, in six steps');
  await page.keyboard.press('Enter');
  const first = await until(async () => arrived.length >= 2 && (await progress()).count === 'Step 1 of 6');
  let p = await progress();
  const seen = first ? '' : JSON.stringify({ arrived: arrived.length, count: p.count, url: page.url(), chip: await page.textContent('#model-chip'), view: await view(), toasts: await toastSaid() }).slice(0, 600);
  check('the first update draws the plan, live', first && p.live, seen);
  check('"Step 1 of 6" beside the title', p.count === 'Step 1 of 6', p.count);
  check('nothing done yet: every step, no button', p.titles.length === 6 && p.fold === null, `${p.titles.length} ${p.fold}`);
  await progressShot('1-first-step');

  held[1]();
  await until(async () => (await progress()).count === 'Step 4 of 6');
  p = await progress();
  check('"1 earlier step", singular, over the two before the current step (screenshot 2)', p.fold === '1 earlier step', String(p.fold));
  check('  it is a real button, folded', p.foldTag === 'BUTTON' && p.expanded === 'false', `${p.foldTag} ${p.expanded}`);
  check('  shown: the two finished, the current, and what is to come (screenshot 4)', p.states === 'ddrpp' && p.titles[0] === 'Gather the numbers', `${p.states} ${p.titles[0]}`);
  check('the current step is marked for a screen reader', p.current.join() === 'Draft the summary', p.current.join());
  check('its ring turns while the run is live', p.turning === 'spin', p.turning);
  check('no blue band behind it any more', p.activeBackground === 'rgba(0, 0, 0, 0)', p.activeBackground);
  check('  its words still bold and in the text colour', Number(p.activeWeight) >= 500 && p.activeColour === p.textColour, `${p.activeWeight} ${p.activeColour} vs ${p.textColour}`);
  check('  and what it involves still under it', p.detail === 'Now: draft the summary.', p.detail);
  check('a line runs from the button down every step but the last', p.foldLine && p.lines.slice(0, -1).every(Boolean) && p.lines.at(-1) === false, `${p.foldLine} ${p.lines}`);
  await progressShot('2-one-earlier');

  held[2]();
  await until(async () => (await progress()).count === 'Step 5 of 6');
  p = await progress();
  check('"2 earlier steps" as the run moves on', p.fold === '2 earlier steps' && p.states === 'ddrp' && p.titles[0] === 'Check the sources', `${p.fold} ${p.states} ${p.titles[0]}`);

  await pressFold();
  p = await progress();
  check('pressed, every step shows (screenshot 5)', p.titles.length === 6 && p.states === 'ddddrp', p.states);
  check('  and the button says "Hide earlier steps" with its chevron', p.fold === 'Hide earlier steps' && p.chevron && p.expanded === 'true', `${p.fold} ${p.chevron} ${p.expanded}`);
  check('  focus stays on it', await page.evaluate(() => document.activeElement?.id === 'progress-fold'));
  await progressShot('3-expanded');
  if (process.env.PROGRESS_SHOTS) {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await progressShot('3-expanded-dark');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }

  held[3]();
  await until(async () => (await progress()).count === 'Step 6 of 6');
  p = await progress();
  check('on the last step it stays open, as it was left', p.titles.length === 6 && p.fold === 'Hide earlier steps' && p.states === 'dddddr', `${p.fold} ${p.states}`);
  await pressFold();
  p = await progress();
  check('folded again: the recent three, "3 earlier steps"', p.fold === '3 earlier steps' && p.states === 'ddr' && p.expanded === 'false', `${p.fold} ${p.states}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  check('the keyboard opens it too', (await progress()).fold === 'Hide earlier steps');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);

  held[4]();
  await until(async () => (await progress()).states === 'dd');
  p = await progress();
  check('finished: only the last two, "4 earlier steps" (screenshot 6)', p.fold === '4 earlier steps' && p.titles.join() === 'Review the draft,Send it', `${p.fold} ${p.titles}`);
  check('  the last one ticked', p.lastTick);
  check('  and no step is "current" any more', p.current.length === 0, p.current.join());
  check('  the heading at the end', p.count === 'Step 6 of 6', p.count);

  held[5]();
  await until(async () => !(await progress()).live);
  p = await progress();
  check('the run ends and the plan stays as it was', !p.live && p.states === 'dd' && p.fold === '4 earlier steps', `${p.live} ${p.states}`);
  await progressShot('4-finished');
  await pressFold();
  p = await progress();
  check('pressed, the whole process (screenshot 7)', p.titles.length === 6 && p.states === 'dddddd' && p.fold === 'Hide earlier steps', `${p.states} ${p.fold}`);
  await progressShot('5-finished-expanded');
  await pressFold();
}

section('Progress: in Vietnamese, and after a reload');
{
  await page.click('#account-button');
  await page.waitForTimeout(150);
  await page.click('.plusmenu--account [data-row="settings"]');
  await page.waitForSelector('#settings[open]');
  await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('#language input[value="vi"]')).click());
  await page.waitForTimeout(300);
  await closeDialogs();
  let p = await progress();
  check('"Bước 6 trên 6"', p.count === 'Bước 6 trên 6', p.count);
  check('"4 bước trước đó"', p.fold === '4 bước trước đó', String(p.fold));
  await pressFold();
  p = await progress();
  check('"Ẩn bước trước đó" once pressed', p.fold === 'Ẩn bước trước đó', String(p.fold));
  await progressShot('6-vietnamese');
  await pressFold();

  // A reload rebuilds the plan from what was stored, folded the same way.
  await reload();
  const chatId = (await store.listChats(me.id)).find((c) => /six steps/i.test(c.title || ''))?.id;
  if (chatId) await page.click(`.chat-row[data-chat="${chatId}"] .chat-item`);
  await until(async () => (await progress()).count === 'Bước 6 trên 6');
  p = await progress();
  check('reopened: still the last two, still folded', p.states === 'dd' && p.fold === '4 bước trước đó', `${p.states} ${p.fold}`);

  await page.click('#account-button');
  await page.waitForTimeout(150);
  await page.click('.plusmenu--account [data-row="settings"]');
  await page.waitForSelector('#settings[open]');
  await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('#language input[value="en"]')).click());
  await page.waitForTimeout(300);
  await closeDialogs();
  check('and back in English', (await progress()).count === 'Step 6 of 6');
}

section('Progress: reduced motion keeps the ring still');
{
  const steps = await page.evaluate(async () => {
    const { planItemHtml } = await import('/js/plan.js');
    return planItemHtml({ title: 'Turning', status: 'in_progress' });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await page.evaluate((html) => {
    const list = document.getElementById('progress-steps');
    const before = list.innerHTML;
    const live = list.classList.contains('is-live');
    list.innerHTML = html;
    list.classList.add('is-live');
    const name = getComputedStyle(list.querySelector('.pmark--active')).animationName;
    list.innerHTML = before;
    list.classList.toggle('is-live', live);
    return name;
  }, steps);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check('no turning for someone who asked for less motion', still === 'none', still);
}
planner.close();

/* ── done ───────────────────────────────────────────────────────── */

await browser.close();
server.close();
removeTemp(process.env.DATA_DIR);

realLog(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
