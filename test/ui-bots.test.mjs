/**
 * The Bot page in a real browser, against the real server and a stand-in provider
 * that answers by model name (owner, 2026-11-09).
 *
 * Chief is there on the first visit; asked, it makes a bot and a group chat, shown
 * as event lines under a "Thought it through" row; in the group the admin hands work
 * on with @Name and the member posts back, each bubble with its face and its name in
 * its colour; typing @ offers the members; the details panel shows the model, memory
 * and usage; Bot settings has Bots, Group chats and Usage; Stop stops every member.
 * And the page that was called Bot is Automations now.
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
const asked = [];
let callN = 0;
function script(model, messages) {
  const last = messages.at(-1);
  const lastUser = textOf([...messages].reverse().find((m) => m.role === 'user'));
  if (model === 'chief') {
    if (last?.role === 'tool') return { text: 'Done. It is ready.' };
    if (/make a writer/i.test(lastUser)) return { think: 'The user wants a writer; I will create one.', tool: { name: 'create_bot', args: { name: 'Writer', role: 'Editor', instructions: 'Draft blog posts.', creature: 'seahorse' } } };
    if (/make a group/i.test(lastUser)) return { tool: { name: 'create_group', args: { name: 'Blog', members: ['Writer'] } } };
    if (/\[Group chat/.test(lastUser)) return /What you handed on is back/.test(lastUser) ? { text: 'Summary: the draft is in.' } : { text: '@Writer please draft the first post.' };
    return { think: 'Greeting.', text: 'Hello, I am Chief.' };
  }
  if (model === 'writer') return { text: 'Draft ready: Ten things about tea.' };
  return { text: 'ok' };
}
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const model = String(body.model);
    const record = { model, closedAt: 0, finished: false };
    asked.push(record);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const end = (finish) => {
      record.finished = true;
      send({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (model === 'slow') {
      let n = 0;
      const timer = setInterval(() => send({ choices: [{ delta: { content: `w${(n += 1)} ` } }] }), 80);
      res.on('close', () => {
        clearInterval(timer);
        if (!record.finished) record.closedAt = Date.now();
      });
      return;
    }
    const answer = script(model, body.messages || []);
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
const sendText = async (text) => {
  await page.fill('#bot-page [data-input]', text);
  await page.press('#bot-page [data-input]', 'Enter');
};
const idle = () => page.waitForFunction(() => !document.querySelector('#bot-page [data-send]')?.classList.contains('is-stop'), null, { timeout: 20_000 });

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
section('Chief is there on the first visit');
{
  await page.click('#open-bots');
  await page.waitForSelector('#bot-page:not([hidden]) .botchief');
  const seen = await page.evaluate(() => ({
    name: document.querySelector('.botchief__name')?.textContent.trim(),
    role: document.querySelector('.botchief__role')?.textContent.trim(),
    pill: document.querySelector('.botchat__pill')?.textContent.trim(),
    placeholder: document.querySelector('#bot-page [data-input]')?.getAttribute('placeholder'),
    hash: location.hash,
    thread: !document.getElementById('thread')?.hidden,
  }));
  check('the Chief card, tagged Chief of Staff', seen.name === 'Chief' && seen.role === 'Chief of Staff', JSON.stringify(seen));
  check('  open in the middle, with "Message Chief"', /Chief/.test(seen.pill || '') && seen.placeholder === 'Message Chief');
  check('  the address says where', /^#bot\/b\//.test(seen.hash), seen.hash);
  check('  and the conversation is out of the way', !seen.thread);
  await page.waitForFunction(() => !!getComputedStyle(document.querySelector('.botchief__face')).backgroundImage.includes('data:image'), null, { timeout: 8000 }).catch(() => {});
  check('Chief wears its creature, drawn in pixels', await page.evaluate(() => getComputedStyle(document.querySelector('.botchief__face')).backgroundImage.includes('data:image/png')));
  const me = await store.getUserByEmail('bots@test.local');
  chiefId = (await store.listBots(me.id)).find((b) => b.is_main).id;
  await store.updateBot(me.id, chiefId, { model: 'openai/chief' });
}

section('asked, Chief makes a bot and a group');
{
  await sendText('Please make a writer for my blog');
  await idle();
  await page.waitForFunction(() => /Created/.test(document.querySelector('#bot-page [data-log]')?.textContent || ''), null, { timeout: 10_000 }).catch(() => {});
  const seen = await page.evaluate(() => ({
    thought: [...document.querySelectorAll('.botthought summary')].map((s) => s.textContent.trim()),
    event: document.querySelector('.botevent')?.textContent.replace(/\s+/g, ' ').trim(),
    face: !!document.querySelector('.botevent .botface'),
    rows: [...document.querySelectorAll('.botrow__name')].map((n) => n.textContent.trim()),
  }));
  check('a "Thought it through" row, folded', seen.thought.includes('Thought it through'), JSON.stringify(seen.thought));
  check('a "Created Writer" event line with its face', /Created\s*Writer/.test(seen.event || '') && seen.face, seen.event);
  check('Writer is in the list on the left', seen.rows.includes('Writer'), seen.rows.join());
  const me = await store.getUserByEmail('bots@test.local');
  const writer = (await store.listBots(me.id)).find((b) => b.name === 'Writer');
  await store.updateBot(me.id, writer.id, { model: 'openai/writer' });
  await sendText('Now make a group with Writer');
  await idle();
  // The list is read again before the conversation is, so wait for the event line itself.
  await page.waitForFunction(() => /Created group/.test(document.querySelector('#bot-page [data-log]')?.textContent || ''), null, { timeout: 10_000 }).catch(() => {});
  const group = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.botrow__name')].map((n) => n.textContent.trim()), event: [...document.querySelectorAll('.botevent')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()) }));
  check('"Created group Blog", and the group in the list', group.rows.includes('Blog') && group.event.some((e) => /Created group\s*Blog/.test(e)), JSON.stringify(group));
  if (process.env.BOT_SHOTS) await page.screenshot({ path: path.join(process.env.BOT_SHOTS, 'bots-chief.png') });
}

section('a group chat: @ offers the members, the admin hands on, the member posts back');
{
  await page.click('.botrow:has-text("Blog")');
  await page.waitForFunction(() => /Blog/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  await page.fill('#bot-page [data-input]', 'Hi @Wr');
  await page.press('#bot-page [data-input]', 'End');
  await page.dispatchEvent('#bot-page [data-input]', 'input');
  await page.waitForSelector('#bot-page [data-picker]:not([hidden])', { timeout: 4000 }).catch(() => {});
  const offered = await page.evaluate(() => [...document.querySelectorAll('.atpick__name')].map((n) => n.textContent.trim()));
  check('typing @ offers the members whose name fits', offered.length === 1 && offered[0] === 'Writer', offered.join());
  await page.press('#bot-page [data-input]', 'Enter');
  const filled = await page.inputValue('#bot-page [data-input]');
  check('  Enter picks it', filled === 'Hi @Writer ', JSON.stringify(filled));
  await page.fill('#bot-page [data-input]', 'Can we get a first post?');
  await page.press('#bot-page [data-input]', 'Enter');
  await idle();
  await page.waitForFunction(() => document.querySelectorAll('#bot-page .botmsg--member').length >= 3, null, { timeout: 15_000 }).catch(() => {});
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll('#bot-page .botmsg--member')].map((m) => ({
      name: m.querySelector('.botmsg__name')?.textContent.trim(),
      admin: m.querySelector('.bottag')?.textContent.trim() || '',
      face: !!m.querySelector('.botmsg__face'),
      text: m.querySelector('.botmsg__bubble')?.textContent.trim(),
      mention: m.querySelector('.botmention')?.textContent.trim() || '',
      color: getComputedStyle(m.querySelector('.botmsg__name')).color,
    })),
  );
  check('Chief, the admin, answered first, tagged Admin', seen[0]?.name === 'Chief' && seen[0].admin === 'Admin', JSON.stringify(seen[0]));
  check('  its @Writer is drawn as a mention', seen[0]?.mention === '@Writer', seen[0]?.mention);
  check('Writer posted its work, with its face', seen[1]?.name === 'Writer' && seen[1].face && /Draft ready/.test(seen[1].text || ''), JSON.stringify(seen[1]));
  check('  its name in its own colour', seen[1]?.color && seen[1].color !== seen[0]?.color, `${seen[0]?.color} / ${seen[1]?.color}`);
  check('Chief answered what came back', seen[2]?.name === 'Chief' && /Summary/.test(seen[2].text || ''), JSON.stringify(seen[2]));
  if (process.env.BOT_SHOTS) await page.screenshot({ path: path.join(process.env.BOT_SHOTS, 'bots-group.png') });
}

section('the details panel: model, memory, usage');
{
  await page.click('.botchief');
  await page.waitForFunction(() => /Chief/.test(document.querySelector('.botchat__pill')?.textContent || ''));
  await page.click('.botchat__pill');
  await page.waitForSelector('#bot-page [data-details]:not([hidden]) [data-model]', { timeout: 8000 }).catch(() => {});
  const seen = await page.evaluate(() => ({
    expanded: document.querySelector('.botchat__pill')?.getAttribute('aria-expanded'),
    name: document.querySelector('.botdetails__name')?.textContent.trim(),
    role: document.querySelector('.botdetails__role')?.textContent.trim(),
    model: /** @type {HTMLSelectElement} */ (document.querySelector('[data-model]'))?.value,
    link: document.querySelector('[data-act="edit-bot"]')?.textContent.trim(),
    memory: document.querySelector('[data-act="memory"]')?.textContent.replace(/\s+/g, ' ').trim(),
    usage: document.querySelector('.botusage')?.textContent.replace(/\s+/g, ' ').trim(),
  }));
  check('it opens beside the conversation, said on the pill', seen.expanded === 'true' && seen.name === 'Chief' && seen.role === 'Chief of Staff', JSON.stringify(seen));
  check('  the model the bot runs on', seen.model === 'openai/chief', seen.model);
  check('  "Add instructions in Bot settings"', seen.link === 'Add instructions in Bot settings', seen.link);
  check('  memory with its count and Manage', /^0 entries\s*Manage/.test(seen.memory || ''), seen.memory);
  check('  usage: tokens and the cache hit rate', /^Chief\s*[\d.,]+K? tok · Cache hit \d+%/.test(seen.usage || ''), seen.usage);
  await page.click('[data-act="memory"]');
  await page.fill('[data-memory-text]', 'The user writes in British English');
  await page.press('[data-memory-text]', 'Enter');
  await page.waitForFunction(() => /^1 entry/.test(document.querySelector('[data-act="memory"]')?.textContent.trim() || ''), null, { timeout: 8000 }).catch(() => {});
  const after = await page.evaluate(() => ({ count: document.querySelector('[data-act="memory"]')?.textContent.trim(), entry: document.querySelector('.botmemory__text')?.textContent.trim() }));
  check('an entry added there is kept', /^1 entry/.test(after.count || '') && after.entry === 'The user writes in British English', JSON.stringify(after));
  if (process.env.BOT_SHOTS) await page.screenshot({ path: path.join(process.env.BOT_SHOTS, 'bots-details.png') });
}

section('Bot settings: Bots, Group chats, Usage');
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
  }));
  check('a bot\'s form: its name and the eleven creatures, its own picked', form.name === 'Writer' && form.creature === 'seahorse' && form.creatures === 11, JSON.stringify(form));
  await page.fill('#bot-settings input[name="role"]', 'Senior editor');
  await page.click('#bot-settings [data-bot-form] button[type="submit"]');
  await page.waitForTimeout(600);
  const me = await store.getUserByEmail('bots@test.local');
  check('  saving changes it', (await store.listBots(me.id)).find((b) => b.name === 'Writer')?.role === 'Senior editor');
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
  check('totals: tokens, cache hit rate, output, calls', usage.tiles.join('|') === 'Last 7 days|Cache hit rate|Output|Calls' && /tokens$/.test(usage.big || ''), JSON.stringify(usage.tiles));
  check('tokens over time, stacked, by bot or by model', usage.bars > 0 && usage.by.join('|') === 'By bot|By model', String(usage.bars));
  check('bots ranked by what they spent', usage.bots.includes('Chief') && usage.bots.includes('Writer'), usage.bots.join());
  await page.click('#bot-settings [data-by="model"]');
  await page.waitForTimeout(400);
  check('  and switched to models', await page.evaluate(() => document.querySelector('#bot-settings [data-by="model"]')?.getAttribute('aria-selected') === 'true'));
  if (process.env.BOT_SHOTS) await page.screenshot({ path: path.join(process.env.BOT_SHOTS, 'bots-usage.png') });
  await page.click('#bot-settings [data-nav="scheduled"]');
  await page.waitForTimeout(700);
  const auto = await page.evaluate(() => ({ dialog: !!document.querySelector('#bot-settings[open]'), hash: location.hash, title: document.getElementById('page-title')?.textContent.trim() }));
  check('"Scheduled tasks" goes to the Automations page', !auto.dialog && auto.hash === '#automations/scheduled' && auto.title === 'Automations', JSON.stringify(auto));
}

section('Stop ends every member\'s turn');
{
  const me = await store.getUserByEmail('bots@test.local');
  const { createBot, createGroup } = await import('../server/bots/team.js');
  const a = await createBot(me.id, { name: 'Slow One', role: 's', model: 'openai/slow' });
  const b = await createBot(me.id, { name: 'Slow Two', role: 's', model: 'openai/slow' });
  const g = await createGroup(me.id, { name: 'Slowpokes', members: [a.id, b.id] });
  await page.goto(`http://127.0.0.1:${PORT}/#bot/g/${g.id}`);
  await page.waitForFunction(() => /Slowpokes/.test(document.querySelector('.botchat__pill')?.textContent || ''), null, { timeout: 15_000 });
  await sendText('@Slow One and @Slow Two, go');
  await page.waitForFunction(() => document.querySelectorAll('#bot-page .botworking').length === 2, null, { timeout: 10_000 }).catch(() => {});
  const working = await page.evaluate(() => [...document.querySelectorAll('#bot-page .botworking__who')].map((n) => n.textContent.trim()));
  check('both say they are working', working.length === 2 && working.every((w) => /is working/.test(w)), working.join(' | '));
  const pressed = Date.now();
  await page.click('#bot-page [data-send].is-stop');
  await idle();
  const slow = asked.filter((x) => x.model === 'slow');
  const waitFrom = Date.now();
  while (slow.some((x) => !x.closedAt) && Date.now() - waitFrom < 3000) await new Promise((r) => setTimeout(r, 50));
  check('both provider calls were cut off', slow.length === 2 && slow.every((x) => x.closedAt > 0 && x.closedAt - pressed < 2000), slow.map((x) => x.closedAt - pressed).join());
  await page.waitForTimeout(500);
  check('the group says it stopped, and nothing says it is working', /Stopped\./.test(await logText()) && (await page.evaluate(() => document.querySelectorAll('#bot-page .botworking').length)) === 0);
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

section('leaving, and an old Bot link');
{
  await page.goto(`http://127.0.0.1:${PORT}/#bot/scheduled`);
  await page.waitForSelector('#auto-tabs:not([hidden])', { timeout: 15_000 }).catch(() => {});
  const seen = await page.evaluate(() => ({ bots: !document.getElementById('bot-page').hidden, title: document.getElementById('page-title')?.textContent.trim(), hash: location.hash }));
  check('an old #bot/scheduled link opens Automations, not the Bot page', !seen.bots && seen.title === 'Automations' && seen.hash === '#automations/scheduled', JSON.stringify(seen));
  await page.click('#open-bots');
  await page.waitForSelector('#bot-page:not([hidden])');
  await page.click('#new-chat');
  await page.waitForTimeout(400);
  const left = await page.evaluate(() => ({ bots: !document.getElementById('bot-page').hidden, thread: !document.getElementById('thread').hidden, hash: location.hash }));
  check('New chat leaves the Bot page and its address', !left.bots && left.thread && !/^#bot/.test(left.hash), JSON.stringify(left));
}

section('nothing went wrong in the page');
check('no errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));

await browser.close();
await new Promise((r) => server.close(r));
provider.closeAllConnections?.();
provider.close();
realLog(failures === 0 ? '\n\x1b[32mThe Bot page holds, in a real browser.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
