/**
 * The Bot page in a real browser, against the real server and a stand-in provider
 * that answers as whichever bot its prompt names (owner, 2026-11-09 and 2026-11-10).
 *
 * Chief is there on the first visit. A bot's chat is the home chat itself — the same
 * transcript and box, moved into the page: what is written shows at once, thinking
 * streams as it comes, the theme shows through. Asked, Chief makes a bot and a group;
 * in the group the admin hands work on with @Name and the member posts back, each with
 * its face and its name in its colour; typing @ in the box offers the members; the
 * details panel has no model of its own (every bot answers on the chip's model), its
 * memory, usage and its own scheduled tasks; incognito in the top bar holds with a
 * bot; Bot settings has Bots, Group chats and Usage; Stop stops every member. And the
 * page that was called Bot is Automations now.
 *
 *   node test/ui-bots.test.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-bots-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-bots-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-bots-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};
console.info = () => {};

const textOf = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text || '').join('') : '');
/** Which bot is speaking, from the prompt's first line. */
const whoOf = (system) => (/You are ([\w ]+?), one of the user's bots/.exec(system)?.[1] || '').toLowerCase();
const asked = [];
let callN = 0;
function script(who, messages) {
  const last = messages.at(-1);
  const lastUser = textOf([...messages].reverse().find((m) => m.role === 'user'));
  if (who === 'chief') {
    if (last?.role === 'tool') return /make a writer/i.test(lastUser) ? { slowThink: true, text: 'Done. It is ready.' } : { text: 'Done. It is ready.' };
    if (/make a writer/i.test(lastUser)) return { think: 'The user wants a writer; I will create one.', tool: { name: 'create_bot', args: { name: 'Writer', role: 'Editor', instructions: 'Draft blog posts.', creature: 'seahorse' } } };
    if (/make a group/i.test(lastUser)) return { tool: { name: 'create_group', args: { name: 'Blog', members: ['Writer'] } } };
    if (/\[Group chat/.test(lastUser)) return /What you handed on is back/.test(lastUser) ? { text: 'Summary: the draft is in.' } : { text: '@Writer please draft the first post.' };
    if (/think slowly/i.test(lastUser)) return { slowThink: true, text: 'Here is the slow answer.' };
    return { think: 'Greeting.', text: 'Hello, I am Chief.' };
  }
  if (who === 'writer') return { text: 'Draft ready: Ten things about tea.' };
  return { text: 'ok' };
}
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const model = String(body.model);
    const system = textOf((body.messages || []).find((m) => m.role === 'system'));
    const who = whoOf(system);
    const record = { model, who, closedAt: 0, finished: false };
    asked.push(record);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const end = (finish) => {
      record.finished = true;
      send({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (/^slow (one|two)$/.test(who)) {
      let n = 0;
      const timer = setInterval(() => send({ choices: [{ delta: { content: `w${(n += 1)} ` } }] }), 80);
      res.on('close', () => {
        clearInterval(timer);
        if (!record.finished) record.closedAt = Date.now();
      });
      return;
    }
    const answer = script(who, body.messages || []);
    // Reasoning that comes a piece at a time, over a second and a half, before the answer.
    if (answer.slowThink) {
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        send({ choices: [{ delta: { reasoning: `Thinking step ${n}. ` } }] });
        if (n === 6) {
          clearInterval(timer);
          send({ choices: [{ delta: { content: answer.text } }] });
          end('stop');
        }
      }, 250);
      return;
    }
    if (answer.think) send({ choices: [{ delta: { reasoning: answer.think } }] });
    if (answer.tool) {
      callN += 1;
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${callN}`, type: 'function', function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] } }] });
      return end('tool_calls');
    }
    send({ choices: [{ delta: { content: answer.text } }] });
    return end('stop');
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { createApp } = await import('../server/app.js');
const { hashPassword } = await import('../server/crypto.js');
const { setApiKey, setPrefs } = await import('../server/settings.js');

const PORT = 5235;
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
  provider.close();
  process.exit(process.env.CI ? 1 : 0);
}

let failures = 0;
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const password = 'a-long-enough-password';
await store.createUser({ id: 'u-bots', email: 'bots@test.local', name: 'Bots', username: 'ui.bots', passwordHash: await hashPassword(password), role: 'user' });
await setApiKey('u-bots', 'openai', 'sk-test-key');
await setPrefs('u-bots', { language: 'en', onboarded: true, qualityGate: false, defaultModel: 'openai/plain' });

const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate:not([hidden])');
await page.fill('#gate-email', 'bots@test.local');
await page.fill('#gate-password', password);
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));

const logText = () => page.evaluate(() => document.querySelector('#bot-page [data-log]')?.textContent || '');
const messagesText = () => page.evaluate(() => document.getElementById('messages')?.textContent || '');
/** Written in the home chat's own box, lent to the Bot page. */
const sendText = async (text) => {
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
};
const idle = () => page.waitForFunction(() => document.getElementById('stop')?.hidden !== false, null, { timeout: 20_000 }).catch(() => {});
// Every line that pops up, kept to be read later (owner, 2026-11-10: a line for what is made or deleted).
await page.evaluate(() => {
  window.__toasts = [];
  const keep = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) window.__toasts.push(n.textContent);
  });
  for (const id of ['toasts', 'toasts-alert']) keep.observe(document.getElementById(id), { childList: true });
});
const toasted = () => page.evaluate(() => window.__toasts || []);
/** The alpha of a computed colour: rgba(), or color(srgb … / a), or 1. */
const alphaOf = (css) => Number((/\/\s*([\d.]+)\s*\)$/.exec(css) || /rgba\([^)]*,\s*([\d.]+)\)$/.exec(css) || [])[1] ?? 1);
const chatAsks = [];
page.on('request', (r) => {
  if (/\/api\/bots\/[^/]+\/chat/.test(r.url())) chatAsks.push(r.url());
});
const me = await store.getUserByEmail('bots@test.local');

section('the rail: Automations under the clock, and Bot beside it');
{
  const rail = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.rail__item')].map((b) => b.id);
    return {
      auto: items.indexOf('open-automations'),
      bots: items.indexOf('open-bots'),
      archive: items.indexOf('open-archive'),
      autoLabel: document.querySelector('#open-automations .rail__label')?.textContent.trim(),
      botLabel: document.querySelector('#open-bots .rail__label')?.textContent.trim(),
      clock: !!document.querySelector('#open-automations circle[r="6.4"]'),
    };
  });
  check('Automations keeps the clock', rail.autoLabel === 'Automations' && rail.clock, JSON.stringify(rail));
  check('Bot is its own item, after it', rail.botLabel === 'Bot' && rail.bots === rail.auto + 1 && rail.archive === rail.bots + 1, JSON.stringify(rail));
}

let chiefId = '';
section("Chief is there on the first visit, in the home chat's own view");
{
  await page.click('#open-bots');
  await page.waitForSelector('#bot-page:not([hidden]) .botchief');
  await page.waitForFunction(() => document.getElementById('thread')?.parentElement?.matches('.botchat__home'), null, { timeout: 8000 }).catch(() => {});
  const seen = await page.evaluate(() => ({
    name: document.querySelector('.botchief__name')?.textContent.trim(),
    role: document.querySelector('.botchief__role')?.textContent.trim(),
    pill: document.querySelector('.botchat__pill')?.textContent.trim(),
    placeholder: document.getElementById('input')?.getAttribute('placeholder'),
    title: document.getElementById('chat-title')?.textContent.trim(),
    hash: location.hash,
    threadHere: document.getElementById('thread')?.parentElement?.matches('.botchat__home'),
    dockHere: document.getElementById('dock')?.parentElement?.matches('.botchat__home'),
    page: getComputedStyle(document.getElementById('bot-page')).backgroundColor,
    model: !!document.querySelector('#bot-page [data-model]'),
  }));
  check('the Chief card, tagged Chief of Staff', seen.name === 'Chief' && seen.role === 'Chief of Staff', JSON.stringify(seen));
  check('  its chat in the middle is the home chat itself: its transcript and its box', seen.threadHere && seen.dockHere, JSON.stringify(seen));
  check('  the box says "Message Chief", the title bar says Chief', seen.placeholder === 'Message Chief' && seen.title === 'Chief', `${seen.placeholder} / ${seen.title}`);
  check('  the theme shows through: the page has no background of its own', /rgba\(0, 0, 0, 0\)|transparent/.test(seen.page), seen.page);
  check('  the address says where', /^#bot\/b\//.test(seen.hash), seen.hash);
  await page.waitForFunction(() => !!getComputedStyle(document.querySelector('.botchief__face')).backgroundImage.includes('data:image'), null, { timeout: 8000 }).catch(() => {});
  check('Chief wears its creature, drawn in pixels', await page.evaluate(() => getComputedStyle(document.querySelector('.botchief__face')).backgroundImage.includes('data:image/png')));
  chiefId = (await store.listBots(me.id)).find((b) => b.is_main).id;

  // Chief alone, its chat empty: the first-run card, not a blank box (spec B.7).
  await page.waitForSelector('.botfirst', { timeout: 8000 }).catch(() => {});
  const first = await page.evaluate(() => ({
    goals: [...document.querySelectorAll('.botfirst [data-goal]')].map((g) => g.dataset.goal),
    checked: [...document.querySelectorAll('.botfirst [data-goal]:checked')].map((g) => g.dataset.goal),
    drafts: document.querySelectorAll('.botfirst [data-draft]').length,
  }));
  check('the first-run card offers four goals, writing ticked, one bot to make', first.goals.join() === 'write,research,code,personal' && first.checked.join() === 'write' && first.drafts === 1, JSON.stringify(first));
  await page.fill('.botfirst [data-draft="write"] [data-field="name"]', 'Scribe');
  await page.check('.botfirst [data-goal="research"]');
  const two = await page.evaluate(() => ({ drafts: document.querySelectorAll('.botfirst [data-draft]').length, kept: document.querySelector('.botfirst [data-draft="write"] [data-field="name"]')?.value, note: /group with Chief/.test(document.querySelector('.botfirst')?.textContent || '') }));
  check('  ticking another adds its bot, keeps what was typed, and says they will share a group', two.drafts === 2 && two.kept === 'Scribe' && two.note, JSON.stringify(two));
  await page.click('[data-act="first-skip"]');
  check('  "Not now" puts it away', await page.evaluate(() => document.querySelector('[data-first]')?.hidden === true));
}

section('what is written shows at once, and thinking streams as it comes');
{
  const before = asked.length;
  await page.fill('#input', 'Please think slowly about it');
  const pressed = Date.now();
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => /Please think slowly about it/.test(document.getElementById('messages')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
  const shownAfter = Date.now() - pressed;
  check('the message is on screen at once, before any answer', shownAfter < 1500 && /Please think slowly/.test(await messagesText()), `${shownAfter} ms`);
  await page.waitForFunction(() => /Thinking step 2/.test(document.querySelector('#messages .think__text')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const live = await page.evaluate(() => ({ think: document.querySelector('#messages .think__text')?.textContent || '', answer: /Here is the slow answer/.test(document.getElementById('messages')?.textContent || '') }));
  check('the thinking streams while the model is still at it, before the answer', /Thinking step 2/.test(live.think) && !live.answer, JSON.stringify(live).slice(0, 160));
  await idle();
  await page.waitForFunction(() => /Here is the slow answer/.test(document.getElementById('messages')?.textContent || ''), null, { timeout: 10_000 }).catch(() => {});
  check('  then the answer', /Here is the slow answer/.test(await messagesText()));
  check("  on the top bar's model, as every bot is", asked.slice(before).every((x) => x.model === 'plain'), asked.slice(before).map((x) => x.model).join());
  const chev = await page.evaluate(() => {
    const head = document.querySelector('#messages .think__head');
    const chevron = head?.querySelector('.think__chev');
    if (!head || !chevron) return null;
    const middle = (r) => r.top + r.height / 2;
    const closed = Math.abs(middle(chevron.getBoundingClientRect()) - middle(head.getBoundingClientRect()));
    head.click();
    return { closed, svg: !!chevron.querySelector('svg') };
  });
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => {
    const head = document.querySelector('#messages .think__head');
    const chevron = head?.querySelector('.think__chev');
    const middle = (r) => r.top + r.height / 2;
    return { open: head?.closest('.think')?.classList.contains('is-open'), off: chevron && head ? Math.abs(middle(chevron.getBoundingClientRect()) - middle(head.getBoundingClientRect())) : 99 };
  });
  check('the reasoning chevron is drawn, and stays in the middle of its row when opened', !!chev?.svg && opened.open && chev.closed < 3 && opened.off < 3, JSON.stringify({ chev, opened }));
}

section('asked, Chief makes a bot and a group');
{
  await sendText('Please make a writer for my blog');
  // In the list while Chief is still at work, not once the whole turn is over.
  const early = await page
    .waitForFunction(() => [...document.querySelectorAll('.botrow__name')].some((n) => n.textContent.trim() === 'Writer') && document.getElementById('stop')?.hidden === false, null, { timeout: 8000 })
    .then(() => true, () => false);
  check('the bot Chief makes is in the list the moment it is made, while the turn goes on', early);
  await idle();
  await page.waitForFunction(() => !!document.querySelector('#messages .stepface[data-filled] .botface'), null, { timeout: 5000 }).catch(() => {});
  const stepFace = await page.evaluate(() => {
    const slot = document.querySelector('#messages .stepface[data-filled]');
    return { name: slot?.dataset.faceName, creature: slot?.querySelector('.botface')?.dataset.creature, before: slot?.nextElementSibling?.textContent.trim() };
  });
  check('  and its step wears its face, left of its name', stepFace.name === 'Writer' && stepFace.creature === 'seahorse' && stepFace.before === 'Writer', JSON.stringify(stepFace));
  await page.waitForFunction(() => [...document.querySelectorAll('.botrow__name')].some((n) => n.textContent.trim() === 'Writer'), null, { timeout: 10_000 }).catch(() => {});
  const seen = await page.evaluate(() => ({
    step: /Created a bot/.test(document.getElementById('messages')?.textContent || ''),
    rows: [...document.querySelectorAll('.botrow__name')].map((n) => n.textContent.trim()),
  }));
  check('making a bot reads as a step, in words', seen.step, JSON.stringify(seen));
  check('Writer is in the list on the left', seen.rows.includes('Writer'), seen.rows.join());
  await page.waitForFunction(() => (window.__toasts || []).includes('Created the bot Writer.'), null, { timeout: 5000 }).catch(() => {});
  check('  and a line says it was made', (await toasted()).includes('Created the bot Writer.'), JSON.stringify(await toasted()));
  await sendText('Now make a group with Writer');
  await idle();
  await page.waitForFunction(() => [...document.querySelectorAll('.botrow__name')].some((n) => n.textContent.trim() === 'Blog'), null, { timeout: 10_000 }).catch(() => {});
  const group = await page.evaluate(() => [...document.querySelectorAll('.botrow__name')].map((n) => n.textContent.trim()));
  check('the group is in the list', group.includes('Blog'), group.join());
  await page.waitForFunction(() => (window.__toasts || []).includes('Created the group chat Blog.'), null, { timeout: 5000 }).catch(() => {});
  check('  and a line says so', (await toasted()).includes('Created the group chat Blog.'), JSON.stringify(await toasted()));
  if (process.env.BOT_SHOTS) await page.screenshot({ path: path.join(process.env.BOT_SHOTS, 'bots-chief.png') });
}

section('a group chat: the same box, @ offers the members, the admin hands on, the member posts back');
{
  await page.click('.botrow:has-text("Blog")');
  await page.waitForFunction(() => /Blog/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  const layout = await page.evaluate(() => ({
    dock: document.getElementById('dock')?.parentElement?.matches('.botchat__home'),
    thread: document.getElementById('thread')?.hidden,
    log: !document.querySelector('#bot-page [data-log]')?.hidden,
  }));
  check('the group borrows the box alone, over its own log', layout.dock && layout.thread && layout.log, JSON.stringify(layout));
  await page.fill('#input', 'Hi @Wr');
  await page.press('#input', 'End');
  await page.dispatchEvent('#input', 'input');
  await page.waitForSelector('#bot-page [data-picker]:not([hidden])', { timeout: 4000 }).catch(() => {});
  const offered = await page.evaluate(() => [...document.querySelectorAll('.atpick__name')].map((n) => n.textContent.trim()));
  check('typing @ offers the members whose name fits', offered.length === 1 && offered[0] === 'Writer', offered.join());
  await page.press('#input', 'Enter');
  const filled = await page.inputValue('#input');
  check('  Enter picks it, and sends nothing', filled === 'Hi @Writer ', JSON.stringify(filled));
  // The name that will call Writer, bold in its colour, over the box's own letters (owner, 2026-11-10).
  await page.waitForTimeout(60);
  const bold = await page.evaluate(() => {
    const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    const lay = /** @type {HTMLElement | null} */ (document.querySelector('.mentionlay'));
    const at = /** @type {HTMLElement | null} */ (lay?.querySelector('.mentionlay__at'));
    const a = getComputedStyle(box);
    const b = lay ? getComputedStyle(lay) : null;
    const boxAt = box.getBoundingClientRect();
    const layAt = lay?.getBoundingClientRect();
    return {
      on: box.classList.contains('has-mentions'),
      clear: a.color,
      words: lay?.textContent?.replace('\u200b', ''),
      value: box.value,
      name: at?.textContent,
      stroke: at ? parseFloat(getComputedStyle(at).getPropertyValue('-webkit-text-stroke-width')) : 0,
      same: !!b && a.fontSize === b.fontSize && a.lineHeight === b.lineHeight && a.fontFamily === b.fontFamily && a.paddingTop === b.paddingTop && a.paddingLeft === b.paddingLeft,
      off: layAt ? Math.max(Math.abs(layAt.left - boxAt.left - box.clientLeft), Math.abs(layAt.top - boxAt.top - box.clientTop), Math.abs(layAt.width - box.clientWidth)) : 99,
    };
  });
  check('  the name that will call Writer is bold in the box, in its colour', bold.on && bold.name === '@Writer' && bold.stroke > 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(bold.clear), JSON.stringify(bold));
  check('    drawn in the box\'s own type, exactly over its letters', bold.same && bold.words === bold.value && bold.off < 1, JSON.stringify(bold));
  // Owner, 2026-11-11: opening a group moves the box, which blurs it; the close that blur
  // asked for 150 ms later shut the picker the person had just opened by typing "@".
  await page.fill('#input', '');
  await page.evaluate(() => {
    const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    box.blur();
    box.focus();
  });
  await page.fill('#input', 'Hey @Wr');
  await page.dispatchEvent('#input', 'input');
  await page.waitForTimeout(300);
  const stays = await page.evaluate(() => ({ open: !document.querySelector('#bot-page [data-picker]')?.hidden, names: document.querySelectorAll('.atpick__name').length }));
  check('  a blur the box came back from does not shut the picker a moment later', stays.open && stays.names === 1, JSON.stringify(stays));
  await page.press('#input', 'Escape');
  await page.fill('#input', 'Can we get a first post?');
  // Timed in the page, from the key to the line: the driver's own round trips are not the page's speed.
  await page.evaluate(() => {
    const log = document.querySelector('#bot-page [data-log]');
    const probe = { from: 0, ms: -1 };
    window.__lineAt = probe;
    document.getElementById('input').addEventListener('keydown', () => (probe.from ||= performance.now()), { once: true, capture: true });
    new MutationObserver((_, watch) => {
      if (probe.from && /Can we get a first post/.test(log.textContent)) {
        probe.ms = Math.round(performance.now() - probe.from);
        watch.disconnect();
      }
    }).observe(log, { childList: true, subtree: true, characterData: true });
  });
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => /Can we get a first post/.test(document.querySelector('#bot-page [data-log]')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
  const lineMs = await page.evaluate(() => window.__lineAt?.ms ?? -1);
  check('what was written is in the group at once', lineMs >= 0 && lineMs < 500 && /Can we get a first post/.test(await logText()), `${lineMs} ms`);
  check('  a box with no name in it is as it was, nothing laid under it', await page.evaluate(() => !document.querySelector('.mentionlay') && !document.getElementById('input').classList.contains('has-mentions')));
  await idle();
  await page.waitForFunction(() => document.querySelectorAll('#bot-page .botline--bot').length >= 3, null, { timeout: 15_000 }).catch(() => {});
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll('#bot-page .botline--bot')].map((m) => ({
      name: m.querySelector('.botmsg__name')?.textContent.trim(),
      admin: m.querySelector('.bottag')?.textContent.trim() || '',
      face: !!m.querySelector('.botmsg__face'),
      text: m.querySelector('.msg__body')?.textContent.trim(),
      mention: m.querySelector('.botmention')?.textContent.trim() || '',
      color: getComputedStyle(m.querySelector('.botmsg__name')).color,
    })),
  );
  // As the home chat draws them (owner, 2026-11-10): a bot's reply over the theme with no bubble, the person's in the home bubble.
  const look = await page.evaluate(() => {
    const reply = document.querySelector('#bot-page .botline--bot .msg__body');
    const mine = document.querySelector('#bot-page .msg--user .bubble');
    const home = document.createElement('div');
    home.className = 'msg msg--user';
    home.innerHTML = '<div class="bubble">x</div>';
    document.getElementById('messages')?.append(home);
    const homeBubble = getComputedStyle(home.querySelector('.bubble')).backgroundColor;
    home.remove();
    return {
      oldBubbles: document.querySelectorAll('#bot-page .botmsg__bubble').length,
      replyBack: reply ? getComputedStyle(reply).backgroundColor : 'none',
      mineBack: mine ? getComputedStyle(mine).backgroundColor : 'none',
      homeBubble,
    };
  });
  check('the group draws its lines as the home chat does: no bubble behind a reply', look.oldBubbles === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(look.replyBack), JSON.stringify(look));
  check("  and the person's line in the home chat's own bubble", look.mineBack === look.homeBubble, JSON.stringify(look));
  check('Chief, the admin, answered first, tagged Admin', seen[0]?.name === 'Chief' && seen[0].admin === 'Admin', JSON.stringify(seen[0]));
  check('  its @Writer is drawn as a mention', seen[0]?.mention === '@Writer', seen[0]?.mention);
  check('Writer posted its work, with its face', seen[1]?.name === 'Writer' && seen[1].face && /Draft ready/.test(seen[1].text || ''), JSON.stringify(seen[1]));
  check('  its name in its own colour', seen[1]?.color && seen[1].color !== seen[0]?.color, `${seen[0]?.color} / ${seen[1]?.color}`);
  check('Chief answered what came back', seen[2]?.name === 'Chief' && /Summary/.test(seen[2].text || ''), JSON.stringify(seen[2]));
  if (process.env.BOT_SHOTS) await page.screenshot({ path: path.join(process.env.BOT_SHOTS, 'bots-group.png') });
}

section('the details panel: no model of its own, memory, usage, its own scheduled tasks');
{
  await page.click('.botchief');
  await page.waitForFunction(() => /Chief/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  await page.click('.botchat__pill');
  await page.waitForSelector('#bot-page [data-details]:not([hidden]) [data-act="memory"]', { timeout: 8000 }).catch(() => {});
  const seen = await page.evaluate(() => ({
    expanded: document.querySelector('.botchat__pill')?.getAttribute('aria-expanded'),
    name: document.querySelector('.botdetails__name')?.textContent.trim(),
    role: document.querySelector('.botdetails__role')?.textContent.trim(),
    model: !!document.querySelector('#bot-page [data-details] select'),
    link: document.querySelector('[data-act="edit-bot"]')?.textContent.trim(),
    memory: document.querySelector('[data-act="memory"]')?.textContent.replace(/\s+/g, ' ').trim(),
    usage: document.querySelector('.botusage')?.textContent.replace(/\s+/g, ' ').trim(),
    tasks: document.querySelector('[data-act="task-add"]')?.textContent.trim(),
    dots: /…/.test(document.querySelector('#bot-page [data-details]')?.textContent || ''),
  }));
  check('it opens beside the conversation, said on the pill', seen.expanded === 'true' && seen.name === 'Chief' && seen.role === 'Chief of Staff', JSON.stringify(seen));
  const motion = await page.evaluate(() => {
    const pageEl = document.getElementById('bot-page');
    const panel = document.querySelector('#bot-page [data-details]');
    const chev = document.querySelector('.botchat__pill .botchat__chev');
    return {
      grid: getComputedStyle(pageEl).transitionProperty,
      panel: getComputedStyle(panel).transitionProperty,
      chev: chev ? getComputedStyle(chev).transform : 'none',
      width: Math.round(panel.getBoundingClientRect().width),
    };
  });
  check('  it slides and fades in, the pill\'s arrow turned', /grid-template-columns/.test(motion.grid) && /transform/.test(motion.panel) && /opacity/.test(motion.panel) && motion.chev !== 'none' && motion.width >= 300, JSON.stringify(motion));
  const asks = [];
  const count = (r) => {
    if (/\/api\/(bots|bot-groups)\/[^/]+\/(memory|tasks)|\/api\/bots\/usage/.test(r.url())) asks.push(r.url());
  };
  page.on('request', count);
  await page.click('[data-act="memory"]');
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => ({
    expanded: document.querySelector('[data-act="memory"]')?.getAttribute('aria-expanded'),
    chev: (() => { const c = document.querySelector('[data-act="memory"] .botcard__chev'); return c ? getComputedStyle(c).transform : 'none'; })(),
    shown: !!document.querySelector('.botmemory-fold.is-open [data-memory-text]'),
    spinner: !!document.querySelector('#bot-page [data-details] .botloading'),
  }));
  page.off('request', count);
  check('Manage opens the memory where it is: no request, no spinner, the arrow turned down', opened.expanded === 'true' && opened.shown && !opened.spinner && asks.length === 0 && opened.chev !== 'none', JSON.stringify({ ...opened, asks }));
  await page.click('[data-act="memory"]');
  await page.waitForTimeout(300);
  check('  and closes again', (await page.evaluate(() => document.querySelector('[data-act="memory"]')?.getAttribute('aria-expanded'))) === 'false');
  check("  no model of the bot's own: it answers on the top bar's", !seen.model);
  check('  "Add instructions in Bot settings"', seen.link === 'Add instructions in Bot settings', seen.link);
  check('  memory with its count and Manage', /^0 entries\s*Manage/.test(seen.memory || ''), seen.memory);
  check('  usage: tokens and the cache hit rate', /^Chief\s*[\d.,]+K? tok · Cache hit \d+%/.test(seen.usage || ''), seen.usage);
  check('  and its own scheduled tasks, with a way to add one; no row of dots anywhere', seen.tasks === 'Add one ›' && !seen.dots, JSON.stringify({ tasks: seen.tasks, dots: seen.dots }));
  await page.click('[data-act="memory"]');
  await page.fill('[data-memory-text]', 'The user writes in British English');
  await page.press('[data-memory-text]', 'Enter');
  await page.waitForFunction(() => /^1 entry/.test(document.querySelector('[data-act="memory"]')?.textContent.trim() || ''), null, { timeout: 8000 }).catch(() => {});
  const after = await page.evaluate(() => ({ count: document.querySelector('[data-act="memory"]')?.textContent.trim(), entry: document.querySelector('.botmemory__text')?.textContent.trim() }));
  check('an entry added there is kept', /^1 entry/.test(after.count || '') && after.entry === 'The user writes in British English', JSON.stringify(after));
  // Pin, edit, forget and Undo, where the entry is (owner, 2026-11-10).
  await page.click('.botmemory__list li [data-pin]');
  await page.waitForFunction(() => document.querySelector('.botmemory__list li')?.classList.contains('is-pinned'), null, { timeout: 5000 }).catch(() => {});
  check('an entry can be pinned there', await page.evaluate(() => document.querySelector('.botmemory__list li')?.classList.contains('is-pinned')));
  check('  and the server keeps the pin', (await store.listBotMemory(me.id, { botId: chiefId }))[0]?.pinned === true);
  await page.click('.botmemory__list li [data-edit]');
  await page.fill('.botmemory__list li [data-edit-text]', 'The user writes in Australian English');
  await page.press('.botmemory__list li [data-edit-text]', 'Enter');
  await page.waitForFunction(() => /Australian/.test(document.querySelector('.botmemory__text')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const edited = (await store.listBotMemory(me.id, { botId: chiefId }))[0];
  check('  edited in place, one entry still', edited?.text === 'The user writes in Australian English' && (await store.listBotMemory(me.id, { botId: chiefId })).length === 1, edited?.text);
  await page.click('.botmemory__list li [data-forget]');
  await page.click('.botmemory__list li [data-forget]');
  await page.waitForSelector('[data-undo-forget]', { timeout: 5000 }).catch(() => {});
  check('forgotten, it offers Undo where it was', !!(await page.$('[data-undo-forget]')) && (await store.listBotMemory(me.id, { botId: chiefId })).length === 0);
  await page.click('[data-undo-forget]');
  await page.waitForFunction(() => /Australian/.test(document.querySelector('.botmemory__text')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check('  and Undo brings it back', (await store.listBotMemory(me.id, { botId: chiefId })).length === 1);
  await store.updateBotMemory(me.id, edited.id, { botId: chiefId }, { text: 'The user writes in British English', textFolded: 'the user writes in british english' });
  await page.click('[data-act="task-add"]');
  await page.fill('[data-task-title]', 'Morning digest');
  await page.fill('[data-task-prompt]', 'Sum up the news for me.');
  await page.fill('[data-task-when]', '07:00');
  await page.click('[data-task-add] button[type="submit"]');
  await page.waitForFunction(() => /Morning digest/.test(document.querySelector('.bottasks')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('a scheduled task added there is listed with the bot', /Morning digest/.test(await page.evaluate(() => document.querySelector('.bottasks')?.textContent || '')));
  const tasks = await store.listTasks(me.id);
  check('  and not with the account\'s own on Automations', !tasks.some((t) => t.title === 'Morning digest') && (await store.listTasks(me.id, { botId: chiefId })).some((t) => t.title === 'Morning digest'));
  if (process.env.BOT_SHOTS) await page.screenshot({ path: path.join(process.env.BOT_SHOTS, 'bots-details.png') });
  await page.click('[data-act="close-details"]');
  await page.waitForTimeout(400);
  check('closing it slides it away and takes it out of the page', await page.evaluate(() => document.querySelector('#bot-page [data-details]')?.hidden === true));
}

section('incognito in the top bar holds with a bot');
{
  const own = await page.evaluate(() => document.querySelector('#messages')?.textContent?.includes('Please think slowly'));
  const toggle = await page.evaluate(() => ({ shown: !document.getElementById('incognito-toggle')?.hidden }));
  check('the incognito switch is there on the Bot page', toggle.shown && own, JSON.stringify(toggle));
  await page.click('#incognito-toggle');
  await page.waitForFunction(() => !document.getElementById('incognito-banner')?.hidden, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const secret = await page.evaluate(() => ({ banner: !document.getElementById('incognito-banner')?.hidden, empty: !/Please think slowly/.test(document.getElementById('messages')?.textContent || '') }));
  check('  on: an empty conversation with Chief that is not kept', secret.banner && secret.empty, JSON.stringify(secret));
  await page.click('#incognito-toggle');
  await page.waitForFunction(() => /Please think slowly/.test(document.getElementById('messages')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('  off: back in Chief\'s own chat', /Please think slowly/.test(await messagesText()) && (await page.evaluate(() => document.getElementById('incognito-banner')?.hidden)));
}

section('Reset asks once more, empties the conversation and keeps the memory');
{
  await page.click('.botchief');
  await page.waitForFunction(() => /Chief/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  await page.click('.botchat__pill');
  await page.waitForSelector('#bot-page [data-details]:not([hidden]) [data-act="reset"]', { timeout: 8000 }).catch(() => {});
  const chiefChat = (await store.botChat(me.id, { botId: chiefId, title: 'Chief' })).id;
  check('Chief has a conversation to reset', (await store.listMessages(me.id, chiefChat)).length > 0);
  await page.click('[data-act="reset"]');
  await page.waitForSelector('dialog.botconfirm[open]', { timeout: 3000 }).catch(() => {});
  const asked = await page.evaluate(() => document.querySelector('dialog.botconfirm[open]')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check('Reset asks once more, saying what goes and what stays', /Reset the conversation with Chief\?/.test(asked) && /deleted for good/.test(asked) && /memory/.test(asked), asked);
  await page.click('dialog.botconfirm [value="cancel"]');
  await page.waitForTimeout(200);
  check('  Cancel keeps everything', (await store.listMessages(me.id, chiefChat)).length > 0);
  await page.click('[data-act="reset"]');
  await page.waitForSelector('dialog.botconfirm[open]', { timeout: 3000 }).catch(() => {});
  await page.click('dialog.botconfirm [value="reset"]');
  await page.waitForFunction(() => !(document.getElementById('messages')?.textContent || '').trim() || !document.querySelector('#messages .msg'), null, { timeout: 8000 }).catch(() => {});
  const fresh = await store.botChat(me.id, { botId: chiefId, title: 'Chief' });
  check('  Reset empties the conversation', fresh.id !== chiefChat && (await store.listMessages(me.id, fresh.id)).length === 0);
  check('  and keeps the memory', (await store.listBotMemory(me.id, { botId: chiefId })).some((m) => m.text === 'The user writes in British English'));
  await page.click('[data-act="close-details"]');
}

section('Bot settings: Bots, Group chats, Usage; a creature in use comes in another colour');
{
  await page.click('#bot-page [data-act="settings"]');
  await page.waitForSelector('#bot-settings[open]');
  const nav = await page.evaluate(() => [...document.querySelectorAll('#bot-settings .botset__navitem')].map((b) => b.textContent.replace('↗', '').trim()));
  check('its pages, and links to what the app has', nav.join('|') === 'Bots|Group chats|Connectors|Scheduled tasks|Usage|Feedback', nav.join('|'));
  await page.click('#bot-settings [data-bot] >> text=Writer');
  const form = await page.evaluate(() => ({
    name: /** @type {HTMLInputElement} */ (document.querySelector('#bot-settings input[name="name"]'))?.value,
    creature: /** @type {HTMLInputElement} */ (document.querySelector('#bot-settings input[name="avatar"]:checked'))?.value,
    creatures: document.querySelectorAll('#bot-settings input[name="avatar"]').length,
    model: !!document.querySelector('#bot-settings select[name="model"]'),
    note: document.querySelector('#bot-settings .botform__note')?.textContent.trim(),
  }));
  check("a bot's form: its name and the eleven creatures, its own picked, and no model", form.name === 'Writer' && form.creature === 'seahorse' && form.creatures === 11 && !form.model && /top bar/.test(form.note || ''), JSON.stringify(form));
  await page.fill('#bot-settings input[name="role"]', 'Senior editor');
  await page.click('#bot-settings [data-bot-form] button[type="submit"]');
  await page.waitForTimeout(600);
  check('  saving changes it', (await store.listBots(me.id)).find((b) => b.name === 'Writer')?.role === 'Senior editor');
  check('  and a line says it was saved', (await toasted()).includes('Saved Writer.'), JSON.stringify(await toasted()));

  // The team read made slow on purpose: what is saved or deleted still shows the moment its
  // own request answers, on the page and in the dialog (owner, 2026-11-10).
  await page.route('**/api/bots', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  const rowShows = (name, where) => page.waitForFunction(([n, w]) => [...document.querySelectorAll(w)].some((x) => x.textContent.trim() === n), [name, where], { timeout: 6000 }).then(() => true, () => false);
  await page.click('#bot-settings [data-nav="bots"]');
  await page.click('#bot-settings [data-new-bot]');
  await page.fill('#bot-settings input[name="name"]', 'Editor');
  let began = Date.now();
  // Twice, fast: one bot, not two.
  await page.evaluate(() => {
    const save = /** @type {HTMLButtonElement} */ (document.querySelector('#bot-settings [data-bot-form] button[type="submit"]'));
    save.click();
    save.click();
  });
  const onPage = await rowShows('Editor', '.botrow__name');
  const madeIn = Date.now() - began;
  const inDialog = await page.evaluate(() => [...document.querySelectorAll('#bot-settings .botset__name')].some((n) => n.textContent.trim() === 'Editor'));
  check('a new bot is on the page and in the dialog the moment it is saved, not after the team is read', onPage && inDialog && madeIn < 1500, `${madeIn} ms`);
  check('  saved twice in a hurry, it is made once', (await store.listBots(me.id)).filter((b) => b.name === 'Editor').length === 1);
  check('  and a line says it was made', (await toasted()).includes('Created the bot Editor.'), JSON.stringify(await toasted()));
  await page.click('#bot-settings [data-delete-bot]');
  began = Date.now();
  await page.click('#bot-settings [data-delete-bot]');
  const gone = await page.waitForFunction(() => ![...document.querySelectorAll('.botrow__name')].some((n) => n.textContent.trim() === 'Editor'), null, { timeout: 6000 }).then(() => true, () => false);
  const goneIn = Date.now() - began;
  check('deleted, it leaves the page at once', gone && goneIn < 1500, `${goneIn} ms`);
  check('  and a line says it was deleted', (await toasted()).includes('Deleted the bot Editor.'), JSON.stringify(await toasted()));
  await page.click('#bot-settings [data-nav="groups"]');
  await page.click('#bot-settings [data-new-group]');
  await page.fill('#bot-settings input[name="name"]', 'Desk');
  await page.check(`#bot-settings input[name="members"][value="${chiefId}"]`);
  began = Date.now();
  await page.click('#bot-settings [data-group-form] button[type="submit"]');
  const groupShows = await rowShows('Desk', '.botrow__name');
  const groupIn = Date.now() - began;
  check('a new group chat is on the page at once too', groupShows && groupIn < 1500, `${groupIn} ms`);
  check('  and a line says it was made', (await toasted()).includes('Created the group chat Desk.'), JSON.stringify(await toasted()));
  // Opened behind the dialog, the group says in the middle of its log what happens to it.
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('bot-settings')).close());
  await page.click('.botrow:has-text("Desk")');
  await page.waitForFunction(() => /Desk/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  await page.waitForFunction(() => /Group chat made with/.test(document.querySelector('#bot-page [data-log]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const madeLine = await page.evaluate(() => {
    const n = [...document.querySelectorAll('#bot-page .botnotice')].find((x) => /Group chat made with/.test(x.textContent || ''));
    return { text: n?.textContent.trim(), faces: n?.querySelectorAll('.botface').length, align: n ? getComputedStyle(n).textAlign : '' };
  });
  check('the group says it was made, and with whom, each by face, in the middle', madeLine.text === 'Group chat made with Chief.' && madeLine.faces === 1 && madeLine.align === 'center', JSON.stringify(madeLine));
  await page.click('#bot-page [data-act="settings"]');
  await page.waitForSelector('#bot-settings[open]');
  await page.click('#bot-settings [data-nav="groups"]');
  await page.click('#bot-settings [data-group] >> text=Desk');
  const writerId = (await store.listBots(me.id)).find((b) => b.name === 'Writer').id;
  await page.check(`#bot-settings input[name="members"][value="${writerId}"]`);
  began = Date.now();
  await page.click('#bot-settings [data-group-form] button[type="submit"]');
  const joined = await page
    .waitForFunction(() => [...document.querySelectorAll('#bot-page .botnotice')].some((n) => n.textContent.trim() === 'Writer joined the group.' && n.querySelector('.botface')), null, { timeout: 5000 })
    .then(() => true, () => false);
  const joinedIn = Date.now() - began;
  check('  a bot added in settings is said in the open group at once, by face', joined && joinedIn < 1500, `${joinedIn} ms`);
  await page.click('#bot-settings [data-delete-group]');
  await page.click('#bot-settings [data-delete-group]');
  await page.waitForFunction(() => (window.__toasts || []).includes('Deleted the group chat Desk.'), null, { timeout: 5000 }).catch(() => {});
  check('  deleted, a line says so', (await toasted()).includes('Deleted the group chat Desk.') && !(await store.listBotGroups(me.id)).some((g) => g.name === 'Desk'), JSON.stringify(await toasted()));
  await page.unroute('**/api/bots');
  await page.click('#bot-settings [data-nav="usage"]');
  await page.waitForSelector('#bot-settings .botuse__tiles', { timeout: 8000 }).catch(() => {});
  const usage = await page.evaluate(() => ({
    ranges: [...document.querySelectorAll('#bot-settings [data-range]')].map((b) => b.textContent.trim()),
    selected: document.querySelector('#bot-settings [data-range][aria-selected="true"]')?.textContent.trim(),
    tiles: [...document.querySelectorAll('#bot-settings .botuse__k')].map((k) => k.textContent.trim()),
    big: document.querySelector('#bot-settings .botuse__tile--big .botuse__v')?.textContent.trim(),
    bars: document.querySelectorAll('#bot-settings .botuse__chart rect').length,
    bots: [...document.querySelectorAll('#bot-settings .botuse__rows')[0]?.querySelectorAll('.botuse__label > span:first-child') || []].map((n) => n.textContent.trim()),
    by: [...document.querySelectorAll('#bot-settings [data-by]')].map((b) => b.textContent.trim()),
  }));
  check('ranges from 24 hours to 12 months, and Custom; 7 days first', usage.ranges.join('|') === '24 hours|7 days|30 days|12 weeks|12 months|Custom' && usage.selected === '7 days', usage.ranges.join('|'));
  check('totals: tokens, cost, cache hit rate, output, calls', usage.tiles.join('|') === 'Last 7 days|Cost|Cache hit rate|Output|Calls' && /tokens$/.test(usage.big || ''), JSON.stringify(usage.tiles));
  const cmp = await page.evaluate(() => ({ line: document.querySelector('#bot-settings [data-compare]')?.textContent.trim(), cost: document.querySelector('#bot-settings [data-cost]')?.textContent.trim() }));
  check('  the total says how it compares with the span before, and the cost is in dollars', /on the 7 days before|Nothing in the span before/.test(cmp.line || '') && /^\$\d/.test(cmp.cost || ''), JSON.stringify(cmp));
  check('tokens over time, stacked, by bot or by model', usage.bars > 0 && usage.by.join('|') === 'By bot|By model', String(usage.bars));
  check('bots ranked by what they spent', usage.bots.includes('Chief') && usage.bots.includes('Writer'), usage.bots.join());
  await page.click('#bot-settings .botuse__open:has-text("Chief")');
  await page.waitForSelector('#bot-settings .botuse__drill', { timeout: 6000 }).catch(() => {});
  const drill = await page.evaluate(() => ({ heads: [...document.querySelectorAll('#bot-settings .botuse__drill h4')].map((h) => h.textContent.trim()), expanded: document.querySelector('#bot-settings .botuse__open[aria-expanded="true"]')?.textContent.includes('Chief') }));
  check("a bot's row opens what it spent: by kind, model, who started it, what made the calls", drill.expanded && ['Tokens by kind', 'Models', 'Who started its turns', 'What made the calls'].every((h) => drill.heads.includes(h)), JSON.stringify(drill));
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('bot-settings')).close());
  // Two more seahorses: three bots, three colours.
  const { createBot } = await import('../server/bots/team.js');
  await createBot(me.id, { name: 'Twin', role: 't', avatar: 'seahorse' });
  await createBot(me.id, { name: 'Triplet', role: 't', avatar: 'seahorse' });
  await page.click('#open-bots');
  await page.waitForFunction(() => document.querySelectorAll('.botrow').length >= 4, null, { timeout: 8000 }).catch(() => {});
  const tints = await page.evaluate(() => [...document.querySelectorAll('.botrow')].filter((r) => /Writer|Twin|Triplet/.test(r.textContent || '')).map((r) => r.querySelector('.botface')?.style.filter || 'none'));
  check('three bots wearing the seahorse wear it in three colours', tints.length === 3 && new Set(tints).size === 3, tints.join(' | '));
}

section('the left side is a light pane over the theme; a bot opened again is not asked for twice');
{
  const shade = await page.evaluate(() => ({
    list: getComputedStyle(document.querySelector('.botlist')).backgroundColor,
    open: getComputedStyle(document.querySelector('.botrow.is-open, .botchief.is-open')).backgroundColor,
  }));
  check('the list is a thin wash, and the one open a light one, not a grey slab', alphaOf(shade.list) <= 0.3 && alphaOf(shade.open) <= 0.15, JSON.stringify(shade));
  const writerId = (await store.listBots(me.id)).find((b) => b.name === 'Writer').id;
  await page.click('.botrow:has-text("Writer")');
  await page.waitForFunction(() => /Writer/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  await page.click('.botchief');
  await page.waitForFunction(() => /Chief/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  const before = chatAsks.filter((u) => u.includes(writerId)).length;
  await page.click('.botrow:has-text("Writer")');
  await page.waitForFunction(() => /Writer/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  await page.waitForTimeout(300);
  const asks = chatAsks.filter((u) => u.includes(writerId));
  check("a bot's chat is asked for by its id alone, without its messages", asks.length > 0 && asks.every((u) => /[?&]light=1/.test(u)), asks.join(' '));
  check('  and opening it again goes straight to it', asks.length === before, `${before} then ${asks.length}`);
}

section("Stop ends every member's turn");
{
  const { createBot, createGroup } = await import('../server/bots/team.js');
  const a = await createBot(me.id, { name: 'Slow One', role: 's' });
  const b = await createBot(me.id, { name: 'Slow Two', role: 's' });
  const g = await createGroup(me.id, { name: 'Slowpokes', members: [a.id, b.id] });
  await page.goto(`http://127.0.0.1:${PORT}/#bot/g/${g.id}`);
  await page.waitForFunction(() => /Slowpokes/.test(document.querySelector('.botchat__pill')?.textContent || ''), null, { timeout: 15_000 });
  await sendText('@Slow One and @Slow Two, go');
  await page.waitForFunction(() => document.querySelectorAll('#bot-page .botworking').length === 2, null, { timeout: 10_000 }).catch(() => {});
  const working = await page.evaluate(() => [...document.querySelectorAll('#bot-page .botworking')].map((n) => ({ who: n.querySelector('.botworking__who')?.textContent.trim(), ring: !!n.querySelector('.spinner') })));
  check('both say they are working, each with a ring', working.length === 2 && working.every((w) => w.ring), JSON.stringify(working));
  await page.evaluate(() => {
    window.__ring = document.querySelector('#bot-page .botworking .spinner');
  });
  await page.waitForTimeout(700);
  const ring = await page.evaluate(() => ({
    same: document.querySelector('#bot-page .botworking .spinner') === window.__ring && window.__ring?.isConnected,
    words: document.querySelector('#bot-page .botworking__text')?.textContent || '',
  }));
  check('  the ring is one element while words stream in, so it turns without a jump', ring.same && /w\d+ w\d+/.test(ring.words), JSON.stringify(ring));
  await page.waitForSelector('#stop:not([hidden])', { timeout: 5000 }).catch(() => {});
  const pressed = Date.now();
  await page.click('#stop');
  await idle();
  const slow = asked.filter((x) => /^slow/.test(x.who));
  const waitFrom = Date.now();
  while (slow.some((x) => !x.closedAt) && Date.now() - waitFrom < 3000) await new Promise((r) => setTimeout(r, 50));
  check("the box's own Stop cut both provider calls off", slow.length === 2 && slow.every((x) => x.closedAt > 0 && x.closedAt - pressed < 2000), slow.map((x) => x.closedAt - pressed).join());
  await page.waitForTimeout(500);
  check('the group says it stopped, and nothing says it is working', /Stopped\./.test(await logText()) && (await page.evaluate(() => document.querySelectorAll('#bot-page .botworking').length)) === 0);
}

section('a round running elsewhere is followed live; Continue carries one on; a file shows where it was made');
{
  const crypto = await import('node:crypto');
  const { createBot, createGroup } = await import('../server/bots/team.js');
  const helper = (await store.listBots(me.id)).find((b) => b.name === 'Writer') || (await createBot(me.id, { name: 'Writer', role: 'Editor' }));
  const desk = await createGroup(me.id, { name: 'Elsewhere', members: [helper.id] });
  const log = await store.botChat(me.id, { groupId: desk.id, title: desk.name });
  // Another invocation holds the group and has work in hand.
  const runId = crypto.randomUUID();
  const seq = await store.claimChatRun(me.id, log.id, runId);
  await store.appendMessage(me.id, log.id, { id: crypto.randomUUID(), role: 'user', text: 'Start on it' });
  await store.setGroupPending(me.id, desk.id, { queue: [], handoffs: 0, segments: 1, reason: 'running', owed: {}, working: [{ bot: helper.id, tool: 'web_search', since: new Date().toISOString() }], lastSeq: 0, at: new Date().toISOString() });
  await page.goto(`http://127.0.0.1:${PORT}/#bot/g/${desk.id}`);
  await page.waitForFunction(() => /Elsewhere/.test(document.querySelector('.botchat__pill')?.textContent || ''), null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('#bot-page .botworking').length === 1, null, { timeout: 5000 }).catch(() => {});
  check('opening a group another invocation works on shows who is at work', (await page.evaluate(() => document.querySelectorAll('#bot-page .botworking').length)) === 1);
  const made = await store.createAttachment(me.id, { id: crypto.randomUUID(), name: 'Plan.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document', bytes: 2048, data: 'eA==', origin: 'generated', chatId: log.id });
  await store.appendMessage(me.id, log.id, { id: crypto.randomUUID(), role: 'assistant', bot: helper.id, text: 'Here is the plan.', files: [{ id: made.id, name: 'Plan.docx', mime: made.mime, size: 2048 }] });
  const appeared = await page.waitForFunction(() => /Here is the plan/.test(document.querySelector('#bot-page [data-log]')?.textContent || ''), null, { timeout: 5000 }).then(() => true, () => false);
  check('  a line it posts shows here within a couple of seconds, with no reload', appeared);
  const card = await page.evaluate(() => {
    const line = [...document.querySelectorAll('#bot-page .botline--bot')].find((n) => /Here is the plan/.test(n.textContent));
    return { card: !!line?.querySelector('.filecard'), name: line?.querySelector('.filecard__name')?.textContent || '' };
  });
  check('  the document it made is on its post, to open or download', card.card && card.name === 'Plan.docx', JSON.stringify(card));
  await store.setGroupPending(me.id, desk.id, null);
  await store.releaseChatRun(me.id, log.id, runId, seq);
  await page.waitForFunction(() => document.querySelectorAll('#bot-page .botworking').length === 0, null, { timeout: 6000 }).catch(() => {});
  check('  when it is done, nothing says it is working', (await page.evaluate(() => document.querySelectorAll('#bot-page .botworking').length)) === 0);

  // The ceiling stopped a round: its notice carries Continue.
  await store.appendMessage(me.id, log.id, { id: crypto.randomUUID(), role: 'assistant', notice: 'ceiling', text: 'Stopped handing work on.', params: { n: 6 } });
  await store.setGroupPending(me.id, desk.id, { queue: [{ botId: helper.id, by: null, report: null, person: 'named' }], handoffs: 6, segments: 1, reason: 'ceiling', owed: {}, working: [], lastSeq: 99, at: new Date().toISOString() });
  await page.reload();
  await page.waitForFunction(() => /Elsewhere/.test(document.querySelector('.botchat__pill')?.textContent || ''), null, { timeout: 15_000 });
  await page.waitForSelector('#bot-page [data-act="continue"]', { timeout: 5000 }).catch(() => {});
  const go = await page.$('#bot-page [data-act="continue"]');
  check('a round stopped at the ceiling offers Continue', !!go);
  if (go) await go.click();
  await page.waitForFunction(() => /Draft ready/.test(document.querySelector('#bot-page [data-log]')?.textContent || ''), null, { timeout: 15_000 }).catch(() => {});
  check('  pressing it carries the round on', /Draft ready/.test(await logText()));
  await idle();
  check('  and Continue is gone once it ran', !(await page.$('#bot-page [data-act="continue"]')));
}

section('on a phone: the list, then the conversation, and back');
{
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/#bot`);
  await page.waitForSelector('#bot-page:not([hidden]) .botchief', { timeout: 15_000 });
  await page.waitForTimeout(500);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('the page opens on the list, and nothing runs off the side', wide && (await page.evaluate(() => getComputedStyle(document.querySelector('.botchat')).display === 'none')));
  await page.click('.botrow:has-text("Blog")');
  await page.waitForTimeout(400);
  const chatting = await page.evaluate(() => ({ list: getComputedStyle(document.querySelector('.botlist')).display, chat: getComputedStyle(document.querySelector('.botchat')).display, back: getComputedStyle(document.querySelector('.botchat__back')).display }));
  check('opening one shows the conversation alone, with a way back', chatting.list === 'none' && chatting.chat === 'flex' && chatting.back !== 'none', JSON.stringify(chatting));
  await page.click('.botchat__back');
  await page.waitForTimeout(300);
  check('  and back goes to the list', await page.evaluate(() => getComputedStyle(document.querySelector('.botlist')).display !== 'none'));
  await page.setViewportSize({ width: 1360, height: 880 });
}

section('needs you, unread, pins, the row menu, pause, who is called, ask aside, quiet runs, team files (spec B)');
{
  // An earlier section loaded the page again: the record of what popped up starts again here.
  await page.evaluate(() => {
    if (window.__toasts) return;
    window.__toasts = [];
    const keep = new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) window.__toasts.push(n.textContent);
    });
    for (const id of ['toasts', 'toasts-alert']) keep.observe(document.getElementById(id), { childList: true });
  });
  const bots = await store.listBots(me.id);
  const writer = bots.find((b) => b.name === 'Writer');
  const blog = (await store.listBotGroups(me.id)).find((g) => g.name === 'Blog');
  const reread = async () => {
    await page.evaluate(() => (location.hash = '#bot'));
    await page.click('#open-bots');
    await page.waitForSelector('#bot-page:not([hidden]) .botrow');
    await page.waitForTimeout(500);
  };

  // A scheduled run of Writer's that failed, and a line from Blog nobody has read — with Writer open, not Blog.
  await page.click(`[data-row="bot:${writer.id}"]`);
  await page.waitForTimeout(300);
  const feed = await store.createTask(me.id, { id: 'task-feed', title: 'Feed', prompt: 'Check the feed', cron: '08:00', nextRunAt: new Date(Date.now() + 3600_000).toISOString(), botId: writer.id });
  await store.finishTask(feed.id, { status: 'failed: The feed is down.', chatId: null, nextRunAt: new Date(Date.now() + 3600_000).toISOString() });
  const log = await store.botChat(me.id, { groupId: blog.id, title: 'Blog' });
  await store.markChatRead(me.id, log.id);
  await store.appendMessage(me.id, log.id, { id: 'unread-line', role: 'assistant', bot: writer.id, text: 'A new draft is up.' });
  await reread();
  const seen = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.botneeds .botneed')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    count: document.querySelector('.botneeds__n')?.textContent,
    writerNeeds: !!document.querySelector('[data-row^="bot:"] .botmark--needs'),
    blogUnread: !!document.querySelector('[data-row^="group:"] .botmark--unread'),
  }));
  check('Needs you lists the failed run, with Retry, and counts it', seen.rows.length === 1 && /Feed failed: The feed is down\./.test(seen.rows[0]) && /Retry/.test(seen.rows[0]) && seen.count === '1', JSON.stringify(seen));
  check('  the bot it belongs to wears the amber mark', seen.writerNeeds);
  check('a group with a line nobody read wears the unread dot', seen.blogUnread);
  await page.click(`[data-row="group:${blog.id}"]`);
  await page.waitForFunction(() => !document.querySelector('[data-row^="group:"] .botmark--unread'), null, { timeout: 5000 }).catch(() => {});
  check('  opening it reads it', !(await page.evaluate(() => !!document.querySelector('[data-row^="group:"] .botmark--unread'))));
  await page.waitForTimeout(600);
  check('  and the server knows', (await store.botPreviews(me.id)).find((p) => p.chat_id === log.id)?.unread === false);

  // Who the message called, while the group works (followed from the server).
  await store.setGroupPending(me.id, blog.id, { reason: 'running', queue: [], working: [], called: [{ bot: writer.id, how: 'answered' }, { bot: chiefId, how: 'called' }], at: new Date().toISOString() });
  await page.click(`[data-row="bot:${writer.id}"]`);
  await page.click(`[data-row="group:${blog.id}"]`);
  await page.waitForSelector('.botcalled__chip', { timeout: 6000 }).catch(() => {});
  const chips = await page.evaluate(() => [...document.querySelectorAll('.botcalled__chip')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
  check('who the message called shows above the box, with how each went', chips.some((c) => /Writer\s*answered/.test(c)) && chips.some((c) => /Chief\s*called/.test(c)), JSON.stringify(chips));
  await store.setGroupPending(me.id, blog.id, null);
  await page.waitForFunction(() => !document.querySelector('.botcalled__chip'), null, { timeout: 6000 }).catch(() => {});
  check('  and goes when it is done', !(await page.evaluate(() => !!document.querySelector('.botcalled__chip'))));

  // The row menu, from the keyboard.
  await page.focus(`[data-row="bot:${writer.id}"]`);
  await page.keyboard.press('Shift+F10');
  await page.waitForSelector('[data-row-menu]:not([hidden])', { timeout: 3000 }).catch(() => {});
  const menu = await page.evaluate(() => ({
    items: [...document.querySelectorAll('[data-row-menu] [role="menuitem"]')].map((b) => b.dataset.rowAct),
    focused: document.activeElement?.dataset?.rowAct,
  }));
  check('Shift+F10 opens the row menu with its focus on the first item', menu.items.join() === 'open,settings,pin,pause,duplicate,export,delete' && menu.focused === 'open', JSON.stringify(menu));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  check('  arrows move through it', (await page.evaluate(() => document.activeElement?.dataset?.rowAct)) === 'pin');
  await page.keyboard.press('Escape');
  check('  Escape shuts it and gives focus back to the row', await page.evaluate((id) => document.querySelector('[data-row-menu]').hidden && document.activeElement?.dataset?.row === `bot:${id}`, writer.id));
  await page.click(`[data-row-more="bot:${writer.id}"]`);
  await page.click('[data-row-act="pin"]');
  await page.waitForSelector(`[data-row="bot:${writer.id}"] .botrow__pin`, { timeout: 5000 }).catch(() => {});
  check('Pin puts it first, marked', await page.evaluate((id) => document.querySelector('.botlist__rows [data-row]')?.dataset.row === `bot:${id}` && !!document.querySelector(`[data-row="bot:${id}"] .botrow__pin`), writer.id));

  // Pause: said in its chat, and the box keeps what is typed.
  await page.click(`[data-row-more="bot:${writer.id}"]`);
  await page.click('[data-row-act="pause"]');
  await page.waitForSelector(`[data-row="bot:${writer.id}"] .bottag--paused`, { timeout: 5000 }).catch(() => {});
  await page.click(`[data-row="bot:${writer.id}"]`);
  await page.waitForSelector('[data-paused]:not([hidden])', { timeout: 5000 }).catch(() => {});
  const before = (await store.listMessages(me.id, (await store.botChat(me.id, { botId: writer.id, title: 'Writer' })).id)).length;
  await page.fill('#input', 'Are you there?');
  await page.press('#input', 'Enter');
  await page.waitForTimeout(500);
  const paused = await page.evaluate(() => ({ bar: document.querySelector('[data-paused]')?.textContent || '', box: document.getElementById('input').value }));
  check('a paused bot says so above the box', /Writer is paused/.test(paused.bar), paused.bar);
  const said = await toasted();
  check('  and does not send: the words stay in the box', paused.box === 'Are you there?' && said.some((x) => /Writer is paused/.test(x)), JSON.stringify({ box: paused.box, toasts: said.slice(-3) }));
  const writerChat = await store.botChat(me.id, { botId: writer.id, title: 'Writer' });
  check('  nothing reached its chat', (await store.listMessages(me.id, writerChat.id)).length === before);
  await page.click('[data-act="resume-open"]');
  await page.waitForSelector('[data-paused][hidden]', { state: 'attached', timeout: 5000 }).catch(() => {});
  check('Resume brings it back', await page.evaluate(() => document.querySelector('[data-paused]')?.hidden === true));
  await page.fill('#input', '');

  // A scheduled run with nothing new folds away.
  await store.appendMessage(me.id, writerChat.id, { id: 'quiet-q', role: 'user', text: 'Check the feed', origin: 'task', quiet: true });
  await store.appendMessage(me.id, writerChat.id, { id: 'quiet-a', role: 'assistant', text: 'Checked: nothing new.', quiet: true });
  await page.click(`[data-row="group:${blog.id}"]`);
  await page.click(`[data-row="bot:${writer.id}"]`);
  await page.waitForSelector('.quietrun', { timeout: 6000 }).catch(() => {});
  const fold = await page.evaluate(() => ({ head: document.querySelector('.quietrun__head')?.textContent, open: document.querySelector('.quietrun')?.open, holds: /nothing new\./.test(document.querySelector('.quietrun__body')?.textContent || '') }));
  check('a quiet scheduled run is folded under one closed line', fold.head === 'Scheduled run · nothing new' && fold.open === false && fold.holds, JSON.stringify(fold));

  // Ask aside: answered, kept nowhere.
  const lines = (await store.listMessages(me.id, writerChat.id)).length;
  await page.click('[data-act="aside"]');
  await page.waitForSelector('.botaside [data-aside-text]', { timeout: 4000 }).catch(() => {});
  await page.fill('.botaside [data-aside-text]', 'What did you draft last?');
  await page.press('.botaside [data-aside-text]', 'Enter');
  await page.waitForSelector('.botaside__a', { timeout: 10_000 }).catch(() => {});
  const aside = await page.evaluate(() => ({ q: document.querySelector('.botaside__q')?.textContent, a: document.querySelector('.botaside__a')?.textContent?.trim() }));
  check('a question asked aside is answered in the card', aside.q === 'What did you draft last?' && /Draft ready/.test(aside.a || ''), JSON.stringify(aside));
  check('  and nothing is added to the conversation', (await store.listMessages(me.id, writerChat.id)).length === lines);
  await page.keyboard.press('Escape');
  check('  Escape shuts the card', await page.evaluate(() => document.querySelector('[data-aside]')?.hidden === true));

  // Retry from Needs you runs the task again.
  await page.click('.botneed--retry .botneed__act');
  await page.waitForFunction(() => !document.querySelector('.botneed--retry'), null, { timeout: 5000 }).catch(() => {});
  const retried = { line: await page.evaluate(() => !!document.querySelector('.botneed--retry')), toasts: (await toasted()).slice(-3) };
  check('Retry runs it again, and the line goes', !retried.line && retried.toasts.some((x) => /Running Feed again/.test(x)), JSON.stringify(retried));
  await store.deleteTask(me.id, 'task-feed');

  // A colour chosen in the bot's form (spec B.5).
  await page.click(`[data-row-more="bot:${writer.id}"]`);
  await page.click('[data-row-act="settings"]');
  await page.waitForSelector('#bot-settings .botform__hues', { timeout: 5000 }).catch(() => {});
  const hues = await page.evaluate(() => document.querySelectorAll('#bot-settings .botform__hues input[name="hue"]').length);
  check('the bot form offers twelve colours', hues === 12, String(hues));
  await page.click('#bot-settings .botform__hue:has(input[value="210"])');
  await page.click('#bot-settings [data-bot-form] button[type="submit"]');
  await page.waitForTimeout(700);
  check('  the chosen one is kept', Number((await store.getBot(me.id, writer.id)).hue) === 210, String((await store.getBot(me.id, writer.id)).hue));
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('bot-settings'))?.close());

  // A team file, pasted from another assistant: checked first, then added.
  await page.click('[data-act="new"]');
  await page.click('[data-act="team-files"]');
  await page.waitForSelector('dialog.botport[open]', { timeout: 4000 }).catch(() => {});
  await page.fill('.botport [data-port-text]', 'Sure:\n```json\n{"format":"synapsez-bots/1","bots":[{"name":"Pasted","role":"Notes","memory":["Prefers tea."]}]}\n```');
  await page.click('.botport [data-port="check"]');
  await page.waitForSelector('.botport__plan', { timeout: 5000 }).catch(() => {});
  const plan = await page.evaluate(() => document.querySelector('.botport__plan')?.textContent.replace(/\s+/g, ' ').trim());
  check('a pasted answer is read and what it adds is shown first', /Bot Pasted/.test(plan || '') && !(await store.listBots(me.id)).some((b) => b.name === 'Pasted'), plan);
  await page.click('.botport [data-port="add"]');
  await page.waitForFunction(() => /added/.test(document.querySelector('.botport__plan')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.botrow__name:text("Pasted")', { timeout: 5000 }).catch(() => {});
  check('  Add adds it, and the list shows it', (await store.listBots(me.id)).some((b) => b.name === 'Pasted') && (await page.evaluate(() => [...document.querySelectorAll('.botrow__name')].some((n) => /Pasted/.test(n.textContent)))));
  await page.evaluate(() => document.querySelector('dialog.botport')?.close());
}

section('triggers from outside: a webhook task, its secret once, a test; waits as chips; Telegram on its page (spec C)');
{
  const writer = (await store.listBots(me.id)).find((b) => b.name === 'Writer');
  await page.click(`[data-row="bot:${writer.id}"]`);
  if (await page.evaluate(() => document.querySelector('[data-details]')?.hidden !== false)) await page.click('.botchat__pill');
  await page.waitForSelector('[data-details] [data-act="task-add"]', { timeout: 8000 }).catch(() => {});
  await page.click('[data-details] [data-act="task-add"]');
  await page.waitForSelector('[data-task-trigger]', { timeout: 5000 }).catch(() => {});
  await page.fill('[data-task-title]', 'On deploy');
  await page.fill('[data-task-prompt]', 'Say what was deployed.');
  await page.selectOption('[data-task-trigger]', 'hook');
  check('choosing "when a request arrives" puts away the schedule', await page.evaluate(() => document.querySelector('[data-task-when]')?.hidden === true));
  await page.click('[data-task-add] button[type="submit"]');
  await page.waitForSelector('.bothook__once', { timeout: 8000 }).catch(() => {});
  const once = await page.evaluate(() => [...document.querySelectorAll('.bothook__once code')].map((c) => c.textContent));
  check('the address and the secret are shown once', /\/api\/hooks\/[\w-]+$/.test(once[0] || '') && /^whsec_/.test(once[1] || ''), JSON.stringify(once));
  const made = (await store.listTasks(me.id, { botId: writer.id })).find((x) => x.title === 'On deploy');
  const route = await store.getHookRouteForTask(me.id, made.id);
  check('  and only its encrypted form is kept', !!route && !String(route.secret_enc).includes(once[1] || 'x'));
  await page.click('[data-hook-dismiss]');
  await page.waitForFunction(() => !document.querySelector('.bothook__once'), null, { timeout: 5000 }).catch(() => {});
  check('  Done puts it away for good', !(await page.evaluate(() => !!document.querySelector('.bothook__once'))));
  await page.click(`[data-hook-open="${made.id}"]`);
  await page.waitForSelector('.bothook__panel', { timeout: 6000 }).catch(() => {});
  await page.click(`[data-hook-test="${made.id}"]`);
  await page.waitForFunction(() => /Ran|Accepted|Failed/.test(document.querySelector('.bothook__receipts')?.textContent || ''), null, { timeout: 15_000 }).catch(() => {});
  const receipts = await page.evaluate(() => document.querySelector('.bothook__receipts')?.textContent.replace(/\s+/g, ' ').trim());
  check('Send a test goes through the same door and is listed', /Ran|Accepted/.test(receipts || ''), receipts);
  check('  the panel never shows the secret', !(await page.evaluate((s) => document.querySelector('.bothook__panel')?.textContent.includes(s), once[1] || 'whsec_')));

  // A wait as a chip above the box, closed with ✕.
  await store.addBotWait(me.id, { id: 'wait-ui-1', botId: writer.id, request: 'Tell me when it ships', note: 'Check the release page' });
  const blogRow = await page.evaluate(() => document.querySelector('[data-row^="group:"]')?.dataset.row);
  await page.click(`[data-row="${blogRow}"]`);
  await page.click(`[data-row="bot:${writer.id}"]`);
  await page.waitForSelector('[data-waits] .botwait', { timeout: 6000 }).catch(() => {});
  check('a bot\'s open wait is a chip above its box', /Check the release page/.test(await page.evaluate(() => document.querySelector('[data-waits]')?.textContent || '')));
  await page.click('[data-wait-close="wait-ui-1"]');
  await page.waitForFunction(() => !document.querySelector('[data-waits] .botwait'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  check('  ✕ closes it', !(await page.evaluate(() => !!document.querySelector('[data-waits] .botwait'))) && !(await store.listBotWaits(me.id, writer.id)).some((w) => w.id === 'wait-ui-1'));
  await store.deleteTask(me.id, made.id);

  // Telegram to Chief, on the Telegram connector's page (read only: turning it on would call Telegram).
  const { encryptSecret } = await import('../server/crypto.js');
  await store.saveConnector(me.id, 'telegram', encryptSecret('123456:TEST'), '@test_bot');
  // Settings → Connectors → Telegram, as a person gets there.
  await page.click('#account-button');
  await page.waitForTimeout(250);
  await page.click('.plusmenu--account [data-row="settings"]');
  await page.click('#tab-connectors');
  await page.waitForSelector('#connector-list [data-open-connector="telegram"]', { timeout: 8000 }).catch(() => {});
  await page.locator('#connector-list [data-open-connector="telegram"] .cname').click();
  await page.waitForSelector('#tg-inbound [data-tg-on]', { timeout: 10_000 }).catch(() => {});
  const tgView = await page.evaluate(() => ({ title: document.querySelector('#tg-inbound h4')?.textContent, on: document.querySelector('#tg-inbound [data-tg-on]')?.checked, role: document.querySelector('#tg-inbound [data-tg-on]')?.getAttribute('role') }));
  check('the Telegram page offers "Let me message Chief from Telegram", off', tgView.title === 'Message Chief from Telegram' && tgView.on === false && tgView.role === 'switch', JSON.stringify(tgView));
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
}

section('a first run makes its bots and their group, asking no model (spec B.7)');
{
  await store.createUser({ id: 'u-first', email: 'first@test.local', name: 'First', username: 'ui.first', passwordHash: await hashPassword(password), role: 'user' });
  await setApiKey('u-first', 'openai', 'sk-test-key');
  await setPrefs('u-first', { language: 'en', onboarded: true, qualityGate: false, defaultModel: 'openai/plain' });
  const fresh = await browser.newPage({ viewport: { width: 1360, height: 880 } });
  fresh.on('pageerror', (err) => pageErrors.push(`first: ${err.message}`));
  await fresh.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
  await fresh.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await fresh.waitForSelector('#gate:not([hidden])');
  await fresh.fill('#gate-email', 'first@test.local');
  await fresh.fill('#gate-password', password);
  await fresh.click('#gate-submit');
  await fresh.waitForSelector('#model-chip');
  await fresh.waitForTimeout(600);
  await fresh.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
  await fresh.click('#open-bots');
  await fresh.waitForSelector('.botfirst', { timeout: 8000 }).catch(() => {});
  const calls = asked.length;
  await fresh.check('.botfirst [data-goal="research"]');
  await fresh.click('[data-act="first-create"]');
  await fresh.waitForSelector('.botrow', { timeout: 8000 }).catch(() => {});
  await fresh.waitForTimeout(500);
  const firstUser = await store.getUserByEmail('first@test.local');
  const made = (await store.listBots(firstUser.id)).map((b) => b.name).sort();
  const groups = await store.listBotGroups(firstUser.id);
  check('Create makes the bots it showed', made.join() === 'Chief,Researcher,Writer', made.join());
  check('  and puts them in one group with Chief as its admin', groups.length === 1 && groups[0].members.length === 3 && groups[0].admin_bot_id === (await store.listBots(firstUser.id)).find((b) => b.is_main).id, JSON.stringify(groups.map((g) => g.name)));
  check('  without asking a model anything', asked.length === calls, `${asked.length - calls} calls`);
  check('  and the card is gone', await fresh.evaluate(() => document.querySelector('[data-first]')?.hidden === true));
  await fresh.close();
}

section('leaving, and an old Bot link');
{
  await page.goto(`http://127.0.0.1:${PORT}/#bot/scheduled`);
  await page.waitForSelector('#auto-tabs:not([hidden])', { timeout: 15_000 }).catch(() => {});
  const seen = await page.evaluate(() => ({ bots: !document.getElementById('bot-page').hidden, title: document.getElementById('page-title')?.textContent.trim(), hash: location.hash }));
  check('an old #bot/scheduled link opens Automations, not the Bot page', !seen.bots && seen.title === 'Automations' && seen.hash === '#automations/scheduled', JSON.stringify(seen));
  const listed = await page.evaluate(() => document.getElementById('page-body')?.textContent || '');
  check("  where a bot's own scheduled task is not listed", !/Morning digest/.test(listed));
  await page.click('#open-bots');
  await page.waitForSelector('#bot-page:not([hidden])');
  await page.waitForFunction(() => document.getElementById('thread')?.parentElement?.matches('.botchat__home'), null, { timeout: 8000 }).catch(() => {});
  await page.click('#new-chat');
  await page.waitForTimeout(400);
  const left = await page.evaluate(() => ({
    bots: !document.getElementById('bot-page').hidden,
    thread: !document.getElementById('thread').hidden,
    home: document.getElementById('thread')?.parentElement?.matches('.main') && document.getElementById('dock')?.parentElement?.matches('.main'),
    placeholder: document.getElementById('input')?.getAttribute('placeholder'),
    hash: location.hash,
  }));
  check('New chat leaves the Bot page, and the transcript and box go back home', !left.bots && left.thread && left.home && !/^#bot/.test(left.hash) && !/Chief/.test(left.placeholder || ''), JSON.stringify(left));
}

section('nothing went wrong in the page');
check('no errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));

await browser.close();
await new Promise((r) => server.close(r));
provider.closeAllConnections?.();
provider.close();
realLog(failures === 0 ? '\n\x1b[32mThe Bot page holds, in a real browser.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
