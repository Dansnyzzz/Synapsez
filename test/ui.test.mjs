/**
 * Interface regression suite — the real app, in a real browser.
 *
 * Separate from `npm test` because it needs Chrome and a listening server, and
 * the tenancy suite must stay fast enough to run constantly. It earns its keep:
 * every check below was written against a bug that shipped.
 *
 *   npm run test:ui
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'ui-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-test');
// A folder for the workspace browser to actually browse.
process.env.WORKSPACE = path.join(os.tmpdir(), 'ai-remote-ui-workspace');
fs.rmSync(process.env.WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(path.join(process.env.WORKSPACE, 'src'), { recursive: true });
fs.writeFileSync(path.join(process.env.WORKSPACE, 'readme.md'), '# Ghi ch\u00fa\n\nM\u1ed9t d\u00f2ng.\n');
removeTemp(process.env.DATA_DIR);

// Quiet the console-email fallback; a confirmation code per signup is noise here.
const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

const PORT = 5194;
/**
 * Build the schema before serving, the way `server/index.js` does.
 *
 * `createApp()` deliberately does not: on a serverless deployment every
 * invocation may be cold, so the wait belongs in a per-request guard rather than
 * at startup. Locally, `server/index.js` awaits `initStore()` before it listens —
 * and this suite was not, so the very first request paid for the entire PGlite
 * DDL run. That is **21 seconds** on a fresh data directory, inside a 30-second
 * navigation timeout, which made the suite fail on how many modules the page
 * happens to import rather than on anything it is testing.
 */
const { initStore } = await import('../server/store/index.js');
await initStore();

const { createApp } = await import('../server/app.js');
const server = (await createApp()).listen(PORT);
await new Promise((r) => server.once('listening', r));

const { chromium } = await import('playwright-core');

/**
 * Whatever browser this machine has.
 *
 * Chrome and Edge first, because on a developer's machine one of them is
 * already there and needs no download. The bundled build last — it only exists
 * if somebody ran `playwright install`, which is exactly what CI does, so
 * without this fallback the whole suite skipped itself on every CI run and
 * reported success for having tested nothing.
 */
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
  realLog('\n  Skipped: no Chrome, Edge or bundled Chromium to drive.');
  realLog('  Run `npx playwright-core install chromium` to enable this suite.\n');
  server.close();
  // In CI a browser was installed on purpose; not finding one is a failure,
  // not a reason to report success for having tested nothing (CFG-027).
  process.exit(process.env.CI ? 1 : 0);
}

const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
// An uncaught error in the page is said out loud: a check that fails because a
// handler threw otherwise reads as the feature simply not being there.
page.on('pageerror', (err) => console.log(`  \x1b[31m[page error]\x1b[0m ${err.message}\n${String(err.stack || '').split('\n').slice(1, 4).join('\n')}`));

/**
 * Open a project by name, from the Projects shelf.
 *
 * Tests add projects of their own, so "the first card" stopped identifying
 * anything in particular the moment a second section did.
 */
const openProjectNamed = async (name) => {
  await page.evaluate((wanted) => {
    const card = [...document.querySelectorAll('#page-body [data-project]')].find((c) =>
      c.textContent.includes(wanted),
    );
    /** @type {HTMLElement} */ (card)?.click();
  }, name);
  await page.waitForTimeout(1200);
};

let failures = 0;
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Every element that can actually scroll, and in which direction.
 *
 * Containers that hide their scrollbar (the chip rows) scroll sideways by
 * design and are not counted; a *visible* bar is what this is looking for.
 */
const SCROLLERS = (selector = 'body') => {
  const out = [];
  for (const el of document.querySelectorAll(`${selector} *`)) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const style = getComputedStyle(el);
    const barHidden = style.scrollbarWidth === 'none';
    const canY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
    const canX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2;
    if (canY || (canX && !barHidden)) {
      out.push({ id: el.id || '', cls: `${el.className}`.slice(0, 40), y: canY, x: canX && !barHidden });
    }
  }
  return out;
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);

section('signing in');
await page.fill('#gate-email', 'ui@test.local');
await page.fill('#gate-password', 'a-long-enough-password');
check('the gate asks for no invite code', !(await page.$('#gate-invite')));

// A password you cannot read is how people lock themselves out of a new
// account on the first try, so the eye has to be there and has to work.
await page.click('[data-reveal="gate-password"]');
check('the eye reveals the password', (await page.getAttribute('#gate-password', 'type')) === 'text');
await page.click('[data-reveal="gate-password"]');
check('and hides it again', (await page.getAttribute('#gate-password', 'type')) === 'password');
check(
  'signing up is not offered "remember me" — it already signs you in',
  await page.isHidden('#gate-remember-row'),
);

// LAW-001: agreeing to the privacy notice is a tick of the person's own.
check('signing up asks for agreement to the privacy notice, with a link to it', (await page.isVisible('#gate-consent-row')) && (await page.getAttribute('#gate-consent-row a', 'href')) === '/privacy.html');
await page.click('#gate-submit');
await page.waitForTimeout(600);
const unticked = await page.evaluate(() => ({ error: !document.getElementById('gate-error').hidden, stillGate: !!document.getElementById('gate-form') && !document.getElementById('model-chip')?.offsetParent }));
check('  and does not go ahead without the tick', unticked.error && unticked.stillGate, JSON.stringify(unticked));
await page.check('#gate-consent');
await page.click('#gate-submit');
await page.waitForTimeout(1600);
check('the app opened', await page.isVisible('#model-chip'));
{
  const { getStore } = await import('../server/store/index.js');
  const me = await getStore().getUserByEmail('ui@test.local');
  const consented = (await getStore().listAudit(me.id, 50)).find((e) => e.kind === 'consent_given');
  check('  and the agreement is in the security record, with the notice\'s version', consented?.detail?.notice === 'privacy-2026-10-06', JSON.stringify(consented?.detail));
}

/**
 * The guide is the first thing a new account meets, and then it is gone.
 *
 * Asserted here rather than later because "on the very first sign-in" is the
 * whole claim, and it cannot be re-tested once the account has answered. It is a
 * modal, so everything behind it is inert — which is why the rest of this suite
 * dismisses it first, exactly as a person would.
 */
section('a new account is shown the guide, once');
{
  await page.waitForTimeout(1200);
  const first = await page.evaluate(() => ({
    open: !!document.getElementById('onboarding')?.open,
    step: document.getElementById('onb-step')?.textContent.trim() || '',
    // The new-model announcement is also a modal. Two on a first visit is worse
    // than either alone, so the guide wins and the news waits.
    news: !!document.querySelector('#model-news[open]'),
  }));
  check('the guide opens on a first sign-in', first.open === true);
  check('at step 1', /1/.test(first.step), first.step);
  check('and the model announcement does not stack on top of it', first.news === false);

  // Skipping is an answer, and it has to stick.
  await page.click('#onb-skip');
  await page.waitForTimeout(700);
  check('skipping closes it', !(await page.$('#onboarding[open]')));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('and it does not come back after a reload', !(await page.$('#onboarding[open]')));
  // With the guide answered, the newest model in the list may be announced —
  // once. Answered here, the way a person would, before anything is pressed.
  if (await page.$('#model-news[open]')) {
    const title = await page.evaluate(() => document.getElementById('news-title').textContent.trim());
    check('after the guide, one new model is announced', !!title, title);
    await page.click('#news-decline');
    await page.waitForTimeout(800);
  }
  check('leaving the app usable', await page.isVisible('#model-chip'));
  /**
   * Pressing a suggestion has to arm the send button.
   *
   * This was broken in two places for the same reason: setting `.value` from script
   * fires no `input` event, so the button stayed grey **and disabled**. Pressing a
   * suggestion looked like nothing happened, and pressing send then also did
   * nothing — which reads as a broken app rather than a missing line.
   */
  const idle = await page.evaluate(() => ({
    ready: document.getElementById('send').classList.contains('is-ready'),
    disabled: document.getElementById('send').disabled,
  }));
  check('the send button starts unlit', !idle.ready && idle.disabled);

  await page.click('#suggestions .suggestion');
  await page.waitForTimeout(400);
  const armed = await page.evaluate(() => ({
    typed: document.getElementById('input').value.trim(),
    ready: document.getElementById('send').classList.contains('is-ready'),
    disabled: document.getElementById('send').disabled,
    caretAtEnd: document.getElementById('input').selectionStart === document.getElementById('input').value.length,
  }));
  check('pressing a suggestion fills the box', armed.typed.length > 0, armed.typed.slice(0, 40));
  check('and lights the send button', armed.ready === true, 'a grey button reads as "this does not work"');
  check('and enables it, so pressing it actually sends', armed.disabled === false);
  check('with the caret after the text', armed.caretAtEnd === true);

  await page.evaluate(() => {
    const box = document.getElementById('input');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

section('the newest model is announced once, not caught up on');
{
  // The notice is the top of the model list in this account's tier — one
  // model, never a queue of the month's releases. Once answered, a reload
  // shows nothing until something newer arrives.
  await page.waitForTimeout(2500);
  check('the answered announcement stays answered', !(await page.$('#model-news[open]')));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('and it does not come back on reload', !(await page.$('#model-news[open]')));
}

section('the chat window is fixed, only the transcript scrolls');
// Enough content to overflow, without needing a model or an API key.
await page.evaluate(() => {
  const thread = document.getElementById('thread');
  for (let i = 0; i < 40; i += 1) {
    const d = document.createElement('div');
    d.style.padding = '18px';
    d.textContent = `message ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}`;
    thread.appendChild(d);
  }
});
await page.waitForTimeout(300);

const shell = await page.evaluate(() => {
  const scrolls = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2) {
      scrolls.push(el.id || `${el.tagName.toLowerCase()}.${`${el.className}`.slice(0, 20)}`);
    }
  }
  const root = document.documentElement;
  return {
    pageOverflow: root.scrollHeight - root.clientHeight,
    appHeight: Math.round(document.getElementById('app').getBoundingClientRect().height),
    viewport: window.innerHeight,
    scrolls,
    composerVisible: document.getElementById('composer').getBoundingClientRect().bottom <= window.innerHeight + 1,
    topbarVisible: document.querySelector('.topbar').getBoundingClientRect().top >= -1,
  };
});
check('the page itself does not scroll', shell.pageOverflow <= 1, `${shell.pageOverflow}px`);
check('the shell is exactly one screen tall', Math.abs(shell.appHeight - shell.viewport) <= 1);
check('the transcript is what scrolls', shell.scrolls.join() === 'thread', shell.scrolls.join(' ') || 'nothing');
check('the composer stays on screen', shell.composerVisible);
check('the header stays on screen', shell.topbarVisible);

section('the send button answers "will this do anything"');
{
  const idle = await page.evaluate(() => {
    const btn = document.getElementById('send');
    const box = btn.getBoundingClientRect();
    return {
      ready: btn.classList.contains('is-ready'),
      disabled: btn.disabled,
      // Round, not a rounded rectangle.
      round: Math.abs(box.width - box.height) < 2 && parseFloat(getComputedStyle(btn).borderRadius) >= box.width / 2 - 1,
      background: getComputedStyle(btn).backgroundColor,
    };
  });
  check('it is round', idle.round, `${idle.background}`);
  check('and unlit while the box is empty', !idle.ready, 'a permanently green button stops meaning "ready"');
  check('and does nothing if pressed', idle.disabled);

  await page.fill('#input', 'hello');
  await page.waitForTimeout(200);
  const typed = await page.evaluate(() => {
    const btn = document.getElementById('send');
    return {
      ready: btn.classList.contains('is-ready'),
      disabled: btn.disabled,
      background: getComputedStyle(btn).backgroundColor,
    };
  });
  check('typing lights it', typed.ready, typed.background);
  check('and enables it', !typed.disabled);
  check('and the colour really changed', typed.background !== idle.background, `${idle.background} → ${typed.background}`);

  await page.fill('#input', '   ');
  await page.waitForTimeout(200);
  check(
    'whitespace alone does not count',
    await page.evaluate(() => !document.getElementById('send').classList.contains('is-ready')),
  );
  await page.fill('#input', '');
}

section('no ASSISTANT label');
{
  // In a two-party conversation where one side is in a bubble on the right and
  // the other is not, captioning every reply says nothing anyone did not know.
  const labelled = await page.evaluate(() => {
    const wrap = document.createElement('div');
    document.body.append(wrap);
    return document.querySelectorAll('.msg__role').length;
  });
  check('no role captions in the transcript', labelled === 0, `${labelled} found`);
  check('and none in the renderer', !(await page.$('.msg--assistant .msg__role')));
}

section('attaching photos and files');
{
  const composer = await page.evaluate(() => {
    const attach = document.getElementById('attach');
    const input = document.getElementById('file-input');
    const strip = document.getElementById('attachments');
    const box = document.querySelector('.composer__box');
    const kids = [...box.children].map((c) => c.id || c.className);
    return {
      hasButton: !!attach,
      hasInput: !!input,
      multiple: input?.multiple,
      accept: input?.accept || '',
      stripHidden: strip?.hidden,
      // The + belongs on the left of the text, the way every chat box does it.
      buttonFirst: kids.indexOf('attach') < kids.indexOf('input'),
      stripAboveBox: !!document.querySelector('.composer > #attachments'),
    };
  });
  check('there is a + button', composer.hasButton);
  check('on the left of the text box', composer.buttonFirst);
  check('it takes several files', composer.multiple === true);
  check('images among them', /image\//.test(composer.accept), composer.accept.slice(0, 40));
  check('and PDFs', /application\/pdf/.test(composer.accept));
  check('the preview strip is above the box, not inside it', composer.stripAboveBox);
  check('and hidden until something is attached', composer.stripHidden === true);

  // Drive a real file through the real picker.
  await page.setInputFiles('#file-input', {
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('container GCXU6471654'),
  });
  await page.waitForTimeout(1200);

  const staged = await page.evaluate(() => {
    const strip = document.getElementById('attachments');
    return {
      shown: !strip.hidden,
      count: strip.querySelectorAll('.stage').length,
      name: strip.querySelector('.stage__name')?.textContent,
      type: strip.querySelector('.stage__type')?.textContent,
      text: strip.textContent,
      removable: !!strip.querySelector('.stage__remove'),
      sendReady: document.getElementById('send').classList.contains('is-ready'),
    };
  });
  check('the preview appears', staged.shown && staged.count === 1, `${staged.count} shown`);
  check('naming the file', staged.name === 'note.txt', staged.name);
  check('and its type', staged.type === 'TXT', staged.type);
  // The size told nobody anything worth the room.
  check('without a size', !/\d+\s?(B|KB|MB)\b/.test(staged.text || ''), staged.text);
  check('a file alone lights the send button', staged.sendReady, 'a photo with no caption is a complete message');
  check('and it can be removed', staged.removable);

  await page.click('.stage__remove');
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => ({
    hidden: document.getElementById('attachments').hidden,
    sendReady: document.getElementById('send').classList.contains('is-ready'),
  }));
  check('removing it hides the strip', cleared.hidden);
  check('and unlights send again', !cleared.sendReady);

  // An image gets a thumbnail rather than an extension badge.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.setInputFiles('#file-input', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForTimeout(1200);
  const picture = await page.evaluate(() => {
    const tile = document.querySelector('#attachments .stage');
    return { image: !!tile?.querySelector('.stage__img'), words: tile?.querySelector('.stage__name')?.textContent || '' };
  });
  check('an image is shown as itself', picture.image, 'not an extension badge');
  check('  with no name or size beside it', !picture.words, picture.words);

  // Pressing it opens it to draw on; Save sends the drawing in its place.
  await page.click('#attachments .stage__open');
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => ({
    open: !!document.querySelector('dialog.sketch[open]'),
    colors: document.querySelectorAll('.sketch__color').length,
    tools: [...document.querySelectorAll('.sketch__tool')].map((b) => b.textContent.trim()),
    undoOff: document.querySelector('.sketch [data-k="undo"]').disabled,
  }));
  check('pressing the picture opens the editor', opened.open);
  check('  with colours, a pen and text', opened.colors === 7 && opened.tools.length === 2, JSON.stringify(opened));
  check('  and nothing to undo yet', opened.undoOff);
  const box = await page.$eval('.sketch__canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.8, box.y + box.h * 0.8, { steps: 5 });
  await page.mouse.up();
  const drew = await page.evaluate(() => !document.querySelector('.sketch [data-k="undo"]').disabled);
  check('a stroke can be undone', drew);
  await page.click('.sketch [data-k="undo"]');
  const redoable = await page.evaluate(() => !document.querySelector('.sketch [data-k="redo"]').disabled);
  check('  and redone', redoable);
  await page.click('.sketch [data-k="redo"]');

  // ACC-016: the colours and tools work from the keyboard, and text can be placed without a pointer.
  await page.focus('.sketch__color[aria-checked="true"]');
  await page.keyboard.press('ArrowRight');
  const stepped = await page.evaluate(() => {
    const on = document.querySelector('.sketch__color[aria-checked="true"]');
    return {
      label: on?.getAttribute('aria-label') || '',
      focused: document.activeElement === on,
      stops: [...document.querySelectorAll('.sketch__color')].filter((b) => /** @type {HTMLElement} */ (b).tabIndex === 0).length,
      group: document.querySelector('.sketch__colors')?.getAttribute('aria-label') || '',
    };
  });
  check('an arrow key moves the colour, named in words', stepped.focused && !/^#/.test(stepped.label) && !!stepped.label, JSON.stringify(stepped));
  check('  in a named group that is one Tab stop', stepped.stops === 1 && !!stepped.group, JSON.stringify(stepped));
  await page.focus('.sketch__tool[data-tool="pen"]');
  await page.keyboard.press('ArrowRight');
  await page.focus('.sketch__canvas');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const typing = await page.evaluate(() => document.activeElement?.classList.contains('sketch__type'));
  check('with Text chosen, Enter on the picture opens a text box', typing);
  await page.keyboard.type('Hi');
  await page.keyboard.press('Enter');
  const written = await page.evaluate(() => ({
    undo: !document.querySelector('.sketch [data-k="undo"]').disabled,
    back: document.activeElement?.classList.contains('sketch__canvas'),
  }));
  check('  and Enter writes it, with focus back on the picture', written.undo && written.back, JSON.stringify(written));

  await page.click('.sketch [data-k="save"]');
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(() => ({
    closed: !document.querySelector('dialog.sketch[open]'),
    tiles: document.querySelectorAll('#attachments .stage').length,
    failed: !!document.querySelector('#attachments .stage.is-failed'),
    title: document.querySelector('#attachments .stage')?.getAttribute('title') || '',
  }));
  check('saving closes it and keeps one picture, now the drawing', saved.closed && saved.tiles === 1 && !saved.failed, JSON.stringify(saved));
  check('  sent as a PNG', /\.png$/.test(saved.title), saved.title);
  await page.click('.stage__remove');
  await page.waitForTimeout(300);

  // A tall picture with a transparent ground — a diagram exported from a
  // drawing tool. The canvas used to spill down over the colours and tools, so
  // every press on them drew a dot on the picture instead.
  const { createCanvas } = await import('@napi-rs/canvas');
  const tall = createCanvas(600, 2400);
  const draw = tall.getContext('2d');
  draw.strokeStyle = '#111111';
  draw.lineWidth = 8;
  draw.strokeRect(100, 100, 400, 2200);
  await page.setInputFiles('#file-input', { name: 'so-do.png', mimeType: 'image/png', buffer: tall.toBuffer('image/png') });
  await page.waitForTimeout(1200);
  const tile = await page.evaluate(() => getComputedStyle(document.querySelector('#attachments .stage__img')).backgroundColor);
  check('a transparent picture waits above the composer on white', tile === 'rgb(255, 255, 255)', tile);
  await page.click('#attachments .stage__open');
  await page.waitForTimeout(800);
  const layout = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.sketch__canvas'));
    const pixel = [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data];
    return { canvasBottom: box('.sketch__canvas').bottom, colorsTop: box('.sketch__colors').top, pixel };
  });
  check('the picture stays above the colours', layout.canvasBottom <= layout.colorsTop + 1, JSON.stringify(layout));
  check('  and its transparent ground is drawn white', layout.pixel.join(',') === '255,255,255,255', layout.pixel.join(','));
  const pressAt = async (selector) => {
    const r = await page.$eval(selector, (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(150);
  };
  await pressAt('.sketch__color[data-color="#3fcf74"]');
  await pressAt('.sketch__tool[data-tool="text"]');
  const chosen = await page.evaluate(() => ({
    color: document.querySelector('.sketch__color[aria-checked="true"]')?.getAttribute('data-color'),
    tool: document.querySelector('.sketch__tool[aria-checked="true"]')?.getAttribute('data-tool'),
    drew: !document.querySelector('.sketch [data-k="undo"]').disabled,
  }));
  check('a colour can be chosen by pressing it', chosen.color === '#3fcf74', JSON.stringify(chosen));
  check('  and Text by pressing it', chosen.tool === 'text', JSON.stringify(chosen));
  check('  without either press drawing on the picture', !chosen.drew, JSON.stringify(chosen));
  await page.click('.sketch [data-k="back"]');
  await page.waitForTimeout(300);
  await page.click('.stage__remove');
  await page.waitForTimeout(300);
}

section('the approval policy sits beside send');
{
  const placed = await page.evaluate(() => {
    const actions = document.querySelector('.composer__actions');
    const order = [...actions.children].map((c) => c.id);
    const policy = document.getElementById('policy-chip');
    const send = document.getElementById('send');
    return {
      insideComposer: !!actions.querySelector('#policy-chip'),
      order,
      // Immediately to the left of the send button, not floating elsewhere.
      leftOfSend: policy.getBoundingClientRect().right <= send.getBoundingClientRect().left + 1,
      sameRow: Math.abs(
        policy.getBoundingClientRect().top - send.getBoundingClientRect().top,
      ) < 6,
      label: policy.textContent.trim(),
      notInTopbar: !document.querySelector('.topbar #policy-chip'),
    };
  });
  check('it is in the composer', placed.insideComposer, placed.order.join(', '));
  check('to the left of send', placed.leftOfSend);
  check('on the same row', placed.sameRow);
  check('and no longer duplicated in the header', placed.notInTopbar);
  check('it names the current policy', /guarded|auto|ask|read/i.test(placed.label), placed.label);

  await page.click('#policy-chip');
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => {
    const m = document.getElementById('policy-menu');
    const box = m.getBoundingClientRect();
    return {
      open: !m.hidden,
      items: [...m.querySelectorAll('.menu__item')].length,
      hasHints: [...m.querySelectorAll('.menu__hint')].length,
      icons: [...m.querySelectorAll('.menu__icon svg')].length,
      effortDots: [...m.querySelectorAll('.effort-dot')].length,
      marksCurrent: !!m.querySelector('.menu__item.is-active'),
      onScreen: box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
    };
  });
  check('clicking it opens the choices', menu.open);
  check('all five of them', menu.items === 5, `${menu.items}`);
  check('each explaining what it does', menu.hasHints === 5, `${menu.hasHints}`);
  check('and each carrying its own glyph', menu.icons === 5, `${menu.icons}`);
  check('with the current one marked', menu.marksCurrent);
  check('the effort dial rides along', menu.effortDots === 5, `${menu.effortDots}`);
  check('and it stays on screen', menu.onScreen);

  // Choosing one has to actually take effect, not just close the menu.
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('#policy-menu .menu__item')];
    items.find((i) => /auto/i.test(i.textContent))?.click();
  });
  await page.waitForTimeout(900);
  const after = await page.evaluate(async () => ({
    label: document.getElementById('policy-label').textContent,
    loud: document.getElementById('policy-chip').classList.contains('is-loud'),
    saved: (await (await fetch('/api/bootstrap')).json()).prefs.toolPolicy,
    // There is no second copy of this control any more. One setting, one home.
    duplicateInSettings: !!document.getElementById('tool-policy'),
    duplicateEffort: !!document.getElementById('effort'),
  }));
  check('the choice takes', /auto/i.test(after.label), after.label);
  check('the one that runs everything looks like it', after.loud, 'an always-amber control stops being a warning');
  check('and it is saved, not just shown', after.saved === 'auto', after.saved);
  check('settings does not repeat the mode picker', !after.duplicateInSettings);
  check('nor the effort picker', !after.duplicateEffort);

  // Put it back so later checks see the default.
  await page.evaluate(async () => {
    await fetch('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolPolicy: 'guarded' }),
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
}

section('the context gauge');
{
  const gauge = await page.evaluate(() => {
    const g = document.getElementById('context-gauge');
    return {
      exists: !!g,
      // Hidden until there is a conversation to measure — a ring at zero on an
      // empty chat is a question nobody asked.
      hiddenWhenEmpty: g?.hidden,
      isRing: !!g?.querySelector('.gauge__fill'),
      // It measures the message you are about to send, so it lives where you
      // are writing it — next to the attach button, not up in the header.
      inComposer: !!document.querySelector('.composer__box #context-gauge'),
      notInTopbar: !document.querySelector('.topbar #context-gauge'),
      nextToAttach:
        document.getElementById('attach')?.nextElementSibling?.id === 'context-gauge',
    };
  });
  check('there is a gauge', gauge.exists);
  check('drawn as a ring', gauge.isRing);
  check('in the composer', gauge.inComposer);
  check('immediately beside the attach button', gauge.nextToAttach);
  check('and no longer in the header', gauge.notInTopbar);
  check(
    'and hidden until there is something to measure',
    gauge.hiddenWhenEmpty === true,
    'a ring at zero on an empty chat is a question nobody asked',
  );

  // The colours are read one at a time with a pause, because the stroke is
  // transitioned — reading it the instant the class changes returns the colour
  // it is leaving, not the one it is going to.
  const paint = async (ratio) => {
    await page.evaluate((r) => {
      const g = document.getElementById('context-gauge');
      const fill = g.querySelector('.gauge__fill');
      g.hidden = false;
      fill.style.strokeDasharray = `${2 * Math.PI * 13 * r} ${2 * Math.PI * 13}`;
      g.classList.toggle('is-warm', r >= 0.6);
      g.classList.toggle('is-hot', r >= 0.85);
    }, ratio);
    await page.waitForTimeout(450);
    return page.evaluate(() => getComputedStyle(document.querySelector('.gauge__fill')).stroke);
  };

  const calm = await paint(0.2);
  const warm = await paint(0.7);
  const hot = await paint(0.95);
  check('a quarter full is the accent colour', calm !== warm, calm);
  check('past two-thirds it goes amber', warm !== calm && warm !== hot, warm);
  check('and nearly full it goes red', hot !== warm, hot);
  check(
    'the ring fills rather than jumping',
    await page.evaluate(() =>
      /stroke-dasharray/.test(getComputedStyle(document.querySelector('.gauge__fill')).transitionProperty),
    ),
    'that is what makes it read as a gauge',
  );

  /**
   * A circle inside a not-quite-circle.
   *
   * The padding used to lean right to leave room for a number that is absent
   * most of the time, and the row stretches its controls to a common height —
   * so the quiet state came out 36 wide by 38 tall with the ring 6px from one
   * edge and 10px from the other. Nobody can name that, everybody can see it.
   */
  const box = async (withNumber) => {
    await page.evaluate((show) => {
      const g = document.getElementById('context-gauge');
      g.hidden = false;
      document.getElementById('context-percent').textContent = show ? '65%' : '';
      g.classList.toggle('has-number', show);
    }, withNumber);
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const g = document.getElementById('context-gauge');
      const b = g.getBoundingClientRect();
      const s = g.querySelector('svg').getBoundingClientRect();
      // Whatever it is sitting next to — the attach button, since it moved into
      // the composer. Two round controls of different diameters side by side is
      // the kind of thing you cannot name but can see.
      const sibling = document.getElementById('attach').getBoundingClientRect();
      return {
        w: Math.round(b.width),
        h: Math.round(b.height),
        left: +(s.left - b.left).toFixed(1),
        right: +(b.right - s.right).toFixed(1),
        top: +(s.top - b.top).toFixed(1),
        bottom: +(b.bottom - s.bottom).toFixed(1),
        matchesRow: Math.abs(b.height - sibling.height) < 1,
      };
    });
  };

  const quiet = await box(false);
  check('with no number the gauge is square', quiet.w === quiet.h, `${quiet.w}x${quiet.h}`);
  check('the same size as the buttons beside it', quiet.matchesRow);
  check('with the ring dead centre', quiet.left === quiet.right && quiet.top === quiet.bottom, JSON.stringify(quiet));


  /**
   * Now the real path: a conversation with something in it.
   *
   * The gauge is driven from a server measurement, and its menu refuses to open
   * without one — a menu that says "0% of ?" would be worse than no menu. So
   * this sends a message and reopens the chat, which is where the measurement
   * comes from.
   */
  await page.click('#new-chat');
  await page.waitForTimeout(900);
  await page.fill('#input', 'a message long enough to measure');
  await page.click('#send');
  await page.waitForTimeout(2500);
  await page.click('.chat-item');
  await page.waitForTimeout(1600);

  const live = await page.evaluate(() => {
    const g = document.getElementById('context-gauge');
    return {
      shown: !g.hidden,
      title: g.title,
      dash: g.querySelector('.gauge__fill').style.strokeDasharray,
      number: document.getElementById('context-percent').textContent,
      label: g.getAttribute('aria-label'),
    };
  });
  check('a real conversation shows the gauge', live.shown);
  check('with the numbers in the tooltip', /tokens/.test(live.title || ''), live.title);
  check('and the ring drawn to a real value', !!live.dash, live.dash);
  // The ring and its colour say it; a percentage beside it said it twice.
  check('with no percentage printed beside the ring', live.number === '', JSON.stringify(live.number));
  check('  which a screen reader still hears', /%/.test(live.label || ''), live.label);

  await page.click('#context-gauge');
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => {
    const m = document.getElementById('context-menu');
    return {
      open: !m.hidden,
      head: m.querySelector('.menu__head')?.textContent,
      actions: [...m.querySelectorAll('.menu__item')].map((i) => i.textContent.split('\n')[0].trim()),
      nowDisabled: /** @type {HTMLButtonElement | undefined} */ ([...m.querySelectorAll('.menu__item')].find((i) => /compact now/i.test(i.textContent || '')))?.disabled,
    };
  });
  check('clicking it says how full, in numbers', menu.open && /used/.test(menu.head || ''), menu.head);
  check('and offers to fold the earlier turns now', menu.actions.some((a) => /compact now/i.test(a)), menu.actions.join(' | '));
  check('and to turn the automatic one off', menu.actions.some((a) => /auto-compact/i.test(a)), menu.actions.join(' | '));
  // A two-message conversation is nowhere near a quarter of the window.
  check('"compact now" waits until a quarter of the window is used', menu.nowDisabled === true);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes it', await page.evaluate(() => document.getElementById('context-menu').hidden));
}

/**
 * Folding up is shown as a bar that fills and ends, not as a block in the
 * transcript — and nothing is sent into a transcript being rewritten.
 */
section('compacting is a bar, and sending waits for it');
{
  const out = await page.evaluate(async () => {
    // Drive the same events a run sends, through a stub stream, by calling the
    // bar the way the handlers do: phase 'compacting' then 'compacted'.
    const bar = document.getElementById('compact-bar');
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    // The bar is private to app.js; reach it through its markup and the
    // composer's own behaviour.
    return { exists: !!bar, hidden: bar?.hidden, role: bar?.getAttribute('role'), inputThere: !!input };
  });
  check('there is a progress bar for compacting', out.exists && out.role === 'progressbar', JSON.stringify(out));
  check('  hidden while nothing is being compacted', out.hidden === true);
  const drawn = await page.evaluate(() => document.querySelectorAll('#messages .compacted').length);
  check('no summary block is drawn in the transcript', drawn === 0, String(drawn));
}

section('the menu closes from its own edge, and reopens from the logo');
{
  // Open: an ordinary close button at the far right of the header, where every
  // panel keeps one. The logo is a logo and nothing else.
  const open = await page.evaluate(() => {
    const head = document.querySelector('.sidebar__head');
    const collapse = document.getElementById('sidebar-collapse');
    const brand = document.getElementById('sidebar-toggle');
    const headBox = head.getBoundingClientRect();
    const box = collapse.getBoundingClientRect();
    return {
      visible: !!box.width && getComputedStyle(collapse).display !== 'none',
      atTheRightEdge: headBox.right - box.right < 4,
      pastTheLogo: box.left > brand.getBoundingClientRect().right - 1,
      labelled: collapse.getAttribute('aria-label'),
      logoIsInert: brand.disabled,
      logoSaysNothing: !brand.getAttribute('aria-label'),
    };
  });
  check('there is a close button while the menu is open', open.visible);
  check('at the far right of the header', open.atTheRightEdge);
  check('not folded into the logo', open.pastTheLogo);
  check('and it says what it does', /collapse/i.test(open.labelled || ''), open.labelled);
  check('the logo is not a control here', open.logoIsInert);
  check('so it announces nothing to a screen reader', open.logoSaysNothing);

  // A disabled button still matches :hover, so the swap has to be off too —
  // otherwise the open menu's logo flickers into a glyph that does nothing.
  await page.hover('#sidebar-toggle');
  await page.waitForTimeout(350);
  const hoveredOpen = await page.evaluate(() => ({
    toggle: Number(getComputedStyle(document.querySelector('.brand__toggle')).opacity),
    mark: Number(getComputedStyle(document.querySelector('.brand__mark')).opacity),
  }));
  check('hovering the logo does not swap in a glyph', hoveredOpen.toggle < 0.1, String(hoveredOpen.toggle));
  check('the mark stays put', hoveredOpen.mark > 0.9, String(hoveredOpen.mark));

  const wide = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
  await page.click('#sidebar-collapse');
  await page.waitForTimeout(500);
  const collapsed = await page.evaluate(() => {
    const brand = document.getElementById('sidebar-toggle');
    return {
      width: document.querySelector('.sidebar').getBoundingClientRect().width,
      isRail: document.getElementById('app').classList.contains('is-rail'),
      closeGone: getComputedStyle(document.getElementById('sidebar-collapse')).display === 'none',
      logoLive: !brand.disabled,
      // A native tooltip appears below the cursor a moment later — a second,
      // differently-placed explanation of a control that already explains
      // itself by swapping its own icon.
      noNativeTooltip: !brand.getAttribute('title'),
      labelled: !!brand.getAttribute('aria-label'),
    };
  });
  check('clicking it collapses the sidebar', collapsed.width < wide - 100, `${Math.round(wide)} → ${Math.round(collapsed.width)}`);
  check('and it is collapsed', collapsed.isRail);
  check('the close button goes with it — the rail has no edge to hold one', collapsed.closeGone);
  check('so the logo takes the job back', collapsed.logoLive);
  check('with no native tooltip to appear underneath', collapsed.noNativeTooltip);
  check('but a name for a screen reader', collapsed.labelled);

  // Collapsed, the two icons occupy the same square: one replaces the other.
  const stacked = await page.evaluate(() => {
    const mark = document.querySelector('.brand__mark').getBoundingClientRect();
    const toggle = document.querySelector('.brand__toggle').getBoundingClientRect();
    return {
      overlapX: Math.abs(mark.left + mark.width / 2 - (toggle.left + toggle.width / 2)) < 8,
      overlapY: Math.abs(mark.top + mark.height / 2 - (toggle.top + toggle.height / 2)) < 8,
      toggleHidden: Number(getComputedStyle(document.querySelector('.brand__toggle')).opacity) === 0,
    };
  });
  check('the two icons share one square', stacked.overlapX && stacked.overlapY, JSON.stringify(stacked));
  check('and the glyph is invisible until pointed at', stacked.toggleHidden);

  await page.hover('#sidebar-toggle');
  await page.waitForTimeout(350);
  const hovered = await page.evaluate(() => ({
    toggle: Number(getComputedStyle(document.querySelector('.brand__toggle')).opacity),
    mark: Number(getComputedStyle(document.querySelector('.brand__mark')).opacity),
  }));
  check('hovering brings the glyph up', hovered.toggle > 0.9, String(hovered.toggle));
  check('and takes the logo away, in the same place', hovered.mark < 0.1, String(hovered.mark));

  await page.click('#sidebar-toggle');
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
  check('and clicking it brings the menu back', Math.abs(back - wide) < 2, `${Math.round(back)}`);
}

section('the panels move rather than snap');
{
  const eased = await page.evaluate(() => {
    const app = getComputedStyle(document.getElementById('app'));
    return {
      property: app.transitionProperty,
      duration: app.transitionDuration,
    };
  });
  // Both panels are grid columns, so one transition covers the sidebar folding
  // to a rail and the detail rail sliding in — they cannot get out of step.
  check('the shell animates its columns', /grid-template-columns/.test(eased.property), eased.property);
  check('over a real duration', parseFloat(eased.duration) > 0.1, eased.duration);
}

section('connecting a computer is not offered anywhere');
{
  // The cloud computer and the sandbox replaced a paired machine (2026-10-04),
  // so the sidebar pill, the header chip and Settings → Computers all went.
  const said = await page.evaluate(() => ({
    inSidebar: !!document.getElementById('worker-pill'),
    inHeader: !!document.getElementById('pair-chip'),
    inSettings: !!document.getElementById('open-pair') || !!document.querySelector('.tab[data-tab="worker"]'),
  }));
  check('the sidebar carries no worker pill', !said.inSidebar);
  check('the header carries no pairing chip', !said.inHeader);
  check('and Settings has no Computers tab', !said.inSettings);
}

/**
 * The openers are glass on the accent, not four grey tiles.
 *
 * They sit on the one screen in the app with something behind it — a violet
 * sky — and were painted with a named surface colour thinned to 62%, which is
 * an opaque grey made paler: still grey, and still flat against the thing it
 * was covering. Glass is a wash you see through, a blur so what is behind it is
 * actually there, and a lit edge.
 */
section('the openers on a blank screen are glass with a lit edge');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(600);

  const look = await page.evaluate(() => {
    const el = document.querySelector('#suggestions .suggestion');
    if (!el) return null;
    const s = getComputedStyle(el);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-dim').trim();
    return {
      count: document.querySelectorAll('#suggestions .suggestion').length,
      background: s.backgroundColor,
      backgroundImage: s.backgroundImage,
      blur: s.backdropFilter || s.webkitBackdropFilter,
      borderColor: s.borderColor,
      accent,
    };
  });
  check('there are four of them', look?.count === 4, `${look?.count}`);
  // A background you can see through: an alpha channel, not a solid.
  check(
    'the pane is translucent rather than painted',
    /rgba\([^)]+,\s*0?\.\d+\)/.test(look.background),
    look.background,
  );
  check('with a real blur behind it', /blur\(/.test(look.blur || ''), look.blur);
  // The lit edge along the cut, which is what stops translucency reading as a
  // washed-out rectangle.
  check('and a highlight along the top edge', /gradient/.test(look.backgroundImage || ''), look.backgroundImage);
  // At rest the edge is glass; the neon belongs to the one being pointed at.
  check('at rest the edge is quiet glass, not the accent', !/124, 92, 255/.test(look.borderColor), look.borderColor);
  await page.hover('#suggestions .suggestion:nth-child(2)');
  await page.waitForTimeout(250);
  const lit = await page.evaluate(() =>
    [...document.querySelectorAll('#suggestions .suggestion')].map((el) => getComputedStyle(el).boxShadow !== 'none'),
  );
  check('pointing at one lights that one', lit[1] === true, JSON.stringify(lit));
  check('  and only that one', lit.filter(Boolean).length === 1, JSON.stringify(lit));
  await page.mouse.move(0, 0);

  const glass = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.composer__box'));
    return { bg: s.backgroundColor, blur: s.backdropFilter || s.webkitBackdropFilter };
  });
  check('the composer is glass, not an opaque grey', /rgba\([^)]+,\s*0?\.\d+\)/.test(glass.bg), glass.bg);
  check('  with a blur behind it', /blur\(/.test(glass.blur || ''), glass.blur);
}

section('the opening screen has a sky, and only the opening screen');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(900);

  const fresh = await page.evaluate(() => {
    const galaxy = document.getElementById('galaxy');
    const s = getComputedStyle(galaxy);
    return {
      lit: document.getElementById('app').classList.contains('is-fresh'),
      opacity: Number(s.opacity),
      visibility: s.visibility,
      // Decorative: it must never eat a click or be read out as content.
      inert: s.pointerEvents === 'none' && galaxy.getAttribute('aria-hidden') === 'true',
      behind: Number(s.zIndex) < Number(getComputedStyle(document.getElementById('thread')).zIndex),
      drifting: getComputedStyle(document.querySelector('.galaxy__cloud')).animationPlayState,
      stars: document.querySelectorAll('.galaxy__stars').length,
      // The page must not gain a scrollbar because a decorative layer is
      // wider than the window it sits in.
      pageWide: document.body.scrollWidth > window.innerWidth + 1,
    };
  });
  // Not `=== 1`: it fades in over most of a second, so a strict compare here
  // tests the stopwatch rather than the behaviour.
  check('an empty conversation gets one', fresh.lit && fresh.opacity > 0.9, JSON.stringify(fresh));
  check('it drifts', fresh.drifting === 'running');
  check('with stars at two depths', fresh.stars === 2, `${fresh.stars}`);
  check('it sits behind everything you can touch', fresh.behind);
  check('and cannot be touched or heard', fresh.inert);
  check('and it does not widen the page', !fresh.pageWide);

  await page.fill('#input', 'hello');
  await page.click('#send');
  await page.waitForTimeout(1500);
  const busy = await page.evaluate(() => ({
    lit: document.getElementById('app').classList.contains('is-fresh'),
    opacity: Number(getComputedStyle(document.getElementById('galaxy')).opacity),
    // Faded out is not enough — an animation nobody can see is just a warm
    // laptop, so it has to actually stop.
    drifting: getComputedStyle(document.querySelector('.galaxy__cloud')).animationPlayState,
  }));
  check('the moment there is something to read, it goes', !busy.lit && busy.opacity === 0, JSON.stringify(busy));
  check('and stops animating rather than idling unseen', busy.drifting === 'paused');
}

section('projects: instructions and sources a conversation inherits');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  const rail = await page.evaluate(() => ({
    label: document.getElementById('open-projects')?.querySelector('.rail__label')?.textContent,
    // The model picker moved to the header chip and Settings → Models; the
    // sidebar slot goes to the thing you come back to across days.
    modelLibraryGone: !document.getElementById('open-library'),
    pickerStillReachable: !!document.getElementById('model-chip'),
  }));
  check('the sidebar offers Projects', rail.label === 'Projects', rail.label);
  check('in place of the model library', rail.modelLibraryGone);
  check('which is still one press away on the header chip', rail.pickerStillReachable);

  // Projects is a page now, and making one goes through the form on it.
  await page.click('#open-projects');
  await page.waitForTimeout(700);
  await page.click('#page-new');
  await page.waitForTimeout(500);
  await page.fill('#project-form-name', 'UI project');
  await page.click('#project-form-save');
  await page.waitForTimeout(1200);

  // Left unpinned for now. The header-chip checks below need a project the
  // sidebar is *not* naming, and pinning happens there once they are done.

  // Creating one lands *in* it, on its own page — you named it because you were
  // about to use it, not to admire it on a shelf.
  const opened = await page.evaluate(() => ({
    onPage: !document.getElementById('project-page').hidden,
    shelfGone: document.getElementById('page').hidden,
    crumb: document.getElementById('project-page-crumb').textContent,
    name: document.getElementById('project-page-name').textContent,
    asks: document.getElementById('project-page-ask').placeholder,
    cards: [...document.querySelectorAll('#project-page-side .panel-card__name')].map((n) => n.textContent),
  }));
  check('creating one opens its page', opened.onPage && opened.shelfGone, JSON.stringify(opened));
  check('titled with its name', opened.name === 'UI project', opened.name);
  check('under a breadcrumb back to the shelf', opened.crumb === 'UI project', opened.crumb);
  check('with a composer, not a form', opened.asks === 'How can I help you today?', opened.asks);
  check(
    'and what it knows down the side',
    JSON.stringify(opened.cards) === JSON.stringify(['Instructions', 'Memory', 'Context', 'Scheduled']),
    JSON.stringify(opened.cards),
  );
  /**
   * Output is in the work column, not this one.
   *
   * The right-hand side is what the work *reads from* — instructions, memory,
   * the shelf of sources. A finished report is not a source; it is the point.
   * So it sits between the composer and the conversations that produced it.
   */
  check(
    'and what it produced is in the work column',
    await page.evaluate(() => !!document.getElementById('project-page-outputs')),
  );

  /**
   * Memory belongs to the project now, with the account's underneath it.
   *
   * It used to be one flat set per account, and the card said so — honest, and
   * useless, because a project is exactly the scale at which a preference means
   * anything: "cite the article number" is true of a law project and false of
   * the deck beside it. Pooled together they contradict each other. The card
   * has to say which of these was learned *here*, or the split is invisible and
   * might as well not exist.
   */
  const honest = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#project-page-side .panel-card')];
    const memory = cards.find((c) => c.querySelector('.panel-card__name')?.textContent === 'Memory');
    return { tag: memory?.querySelector('.panel-card__tag')?.textContent, say: memory?.textContent || '' };
  });
  check('the memory card is scoped to this project', honest.tag === 'this project', honest.tag);
  check('and the empty state says what it will learn here', /this project/i.test(honest.say), honest.say.slice(0, 140));

  /**
   * And what the project has produced.
   *
   * A shelf listed the documents put *in* and nothing of what came out, so a
   * report written last Tuesday lived only in the transcript of whichever
   * conversation wrote it.
   */
  const output = await page.evaluate(() => {
    const host = document.getElementById('project-page-outputs');
    return { there: !!host, empty: (host?.textContent || '').trim() };
  });
  check('there is somewhere for what the project made', output.there);
  // Nothing yet, so nothing is drawn: a heading over an empty box is furniture,
  // and the composer above it is what a new project is actually for.
  check('and a project that has made nothing shows no heading at all', output.empty === '', output.empty);

  /**
   * The notes can be opened in full, and thrown away.
   *
   * The card is a glance — each note clipped to a line. A note is read into
   * every future conversation, so a stale one is a wrong fact being repeated,
   * and the only way to be rid of one used to be asking the assistant to delete
   * it and hoping it picked the right key.
   */
  await page.click('#pp-view-memory');
  await page.waitForTimeout(400);
  const sheet = await page.evaluate(() => {
    const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('memory-sheet'));
    return { open: dialog.open, say: dialog.textContent || '' };
  });
  check('View memory opens the sheet', sheet.open);
  check('which says so when there is nothing in it yet', /Nothing remembered yet/i.test(sheet.say), sheet.say.slice(0, 120));
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  // The Context menu offers only what exists here. Claude's has GitHub and
  // Drive; an entry that opens an apology is worse than no entry.
  await page.click('#pp-add-source');
  await page.waitForTimeout(300);
  const sources = await page.evaluate(() =>
    [...document.querySelectorAll('.cardmenu button')].map((b) => b.textContent.trim()),
  );
  check('adding context offers a file', sources.some((s) => /Upload from device/.test(s)), sources.join(' | '));
  check('or text pasted in', sources.some((s) => /Add text content/.test(s)));
  check('and nothing this app cannot do', !sources.some((s) => /GitHub|Drive/i.test(s)), sources.join(' | '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // A source has to be something that can be quoted, so a picture is refused at
  // the moment it is added rather than sitting in the list looking like
  // knowledge that is never once consulted.
  const added = await page.evaluate(async () => {
    const id = (await (await fetch('/api/projects')).json()).projects[0].id;
    const b64 = (s) => btoa(s);
    const post = (body) =>
      fetch(`/api/projects/${id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const text = await post({ name: 'rules.md', mime: 'text/markdown', data: b64('The pass mark is 5.0.') });
    // A tiny 1×1 GIF, so the shelf has a real picture with a real thumbnail.
    const image = await post({
      name: 'photo.gif',
      mime: 'image/gif',
      data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    });
    const junk = await post({ name: 'archive.zip', mime: 'application/zip', data: b64('PK') });
    return { text: text.status, image: image.status, file: image.body.file, junk: junk.status };
  });
  check('a text source is taken', added.text === 201, `${added.text}`);
  // A picture used to be refused here. It is kept now — half the library can
  // see, and a diagram on the shelf is worth more to those models than the
  // paragraph describing it. It carries no text, so it never competes for the
  // passage budget the quotable sources share.
  check('and so is a picture', added.image === 201, `${added.image}`);
  check('marked as one', added.file?.kind === 'image', added.file?.kind);
  check('keeping the file it came from, so it can be opened and downloaded', !!added.file?.attachment_id);
  check('and the picture the browser drew of it', /^data:image\//.test(added.file?.thumb || ''), added.file?.thumb?.slice(0, 24));
  check('a kind nothing can read is still refused', added.junk === 400, `${added.junk}`);

  // Typing into the composer starts the conversation, carrying the first
  // message with it — nothing exists until it is sent.
  await page.fill('#project-page-ask', 'what is the pass mark');
  await page.waitForTimeout(200);
  check(
    'send lights up once there is something to send',
    !(await page.evaluate(() => document.getElementById('project-page-send').disabled)),
  );
  await page.click('#project-page-send');
  await page.waitForTimeout(2500);

  /**
   * One name for the project, and it is the breadcrumb.
   *
   * There used to be a chip on the right of the header as well. For a pinned
   * project the sidebar already said the name; for an unpinned one the
   * breadcrumb already said it — and being a breadcrumb, it also goes there.
   * Two buttons carrying the same word, in the row that has to hold the title.
   */
  const crumb = await page.evaluate(() => {
    const el = document.getElementById('chat-project');
    return { shown: !el.hidden, text: el.textContent, chipGone: !document.getElementById('project-chip') };
  });
  check('a chat started in a project says so', crumb.shown && crumb.text === 'UI project', JSON.stringify(crumb));
  check('and says it once', crumb.chipGone, JSON.stringify(crumb));

  /**
   * Pinning is what the rest of this suite needs — the sidebar sections further
   * down reach this project through the tree on the left — so it goes on here
   * and stays on.
   */
  const pinnedIt = await page.evaluate(async () => {
    const { projects } = await (await fetch('/api/projects')).json();
    const mine = projects.find((p) => p.name === 'UI project');
    if (!mine) return { found: false };
    const res = await fetch(`/api/projects/${mine.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    const after = await (await fetch('/api/projects')).json();
    return { found: true, status: res.status, pinned: !!after.projects.find((p) => p.id === mine.id)?.pinned };
  });
  check('pinning it works at all', pinnedIt.pinned === true, JSON.stringify(pinnedIt));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  const reopened = await page.evaluate(async (name) => {
    // Back into the project's conversation, which is now filed under it in the
    // sidebar — the only way in, and the thing being tested. The project row is
    // open already, so it is deliberately not clicked: that toggles, and
    // folding it would hide the very conversation being reached for.
    const row = [...document.querySelectorAll('.proj-row__name')].find((n) => n.textContent.includes(name));
    document.querySelector('.chat-row--nested .chat-item')?.click();
    await new Promise((r) => setTimeout(r, 900));
    return { inSidebar: !!row, crumb: document.getElementById('chat-project').textContent };
  }, 'UI project');
  check('a pinned project is in the sidebar', reopened.inSidebar);
  check('and the breadcrumb still names it', reopened.crumb === 'UI project', JSON.stringify(reopened));

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(1200);
  check(
    'an ordinary conversation carries no such claim',
    await page.evaluate(() => document.getElementById('chat-project').hidden),
  );
}

section('copying and editing what you said');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(400);
  await page.fill('#input', 'the question as first asked');
  await page.click('#send');
  await page.waitForTimeout(2200);

  const bubble = '#messages .msg--user';
  const idle = await page.evaluate((sel) => {
    const m = document.querySelector(sel);
    const actions = m?.querySelector('.msg__actions');
    return {
      hasId: !!m?.dataset.messageId,
      acts: [...(m?.querySelectorAll('.msg__action') || [])].map((b) => b.dataset.act).join(','),
      // The buttons fade; the row stays, because it also carries the time.
      opacity: actions?.querySelector('.msg__action') ? Number(getComputedStyle(actions.querySelector('.msg__action')).opacity) : null,
      // Reserved space, not display:none — a transcript that shifts under the
      // pointer as you move down it is unusable.
      height: actions ? Math.round(actions.getBoundingClientRect().height) : 0,
    };
  }, bubble);
  check('a sent message knows its own id', idle.hasId, 'without it there is nothing to edit');
  check('it offers copy and edit', idle.acts === 'copy,edit', idle.acts);
  check('invisible while you are not pointing at it', idle.opacity === 0, `${idle.opacity}`);
  check('but keeping its space', idle.height > 0, `${idle.height}px`);

  await page.hover(bubble);
  await page.waitForTimeout(350);
  const shown = await page.evaluate(
    (sel) => Number(getComputedStyle(document.querySelector(`${sel} .msg__actions .msg__action`)).opacity),
    bubble,
  );
  check('and appearing when you do', shown === 1, `${shown}`);

  /**
   * And going away again afterwards.
   *
   * A clicked button keeps focus, so a `:focus-within` reveal left the row lit
   * on that message after the pointer had moved on — visible controls on a
   * message nobody was pointing at.
   */
  await page.click(`${bubble} [data-act="copy"]`);
  await page.mouse.move(20, 20);
  await page.waitForTimeout(500);
  const afterCopy = await page.evaluate((sel) => {
    const m = document.querySelector(sel);
    return {
      opacity: Number(getComputedStyle(m.querySelector('.msg__actions .msg__action')).opacity),
      stillFocused: m.contains(document.activeElement),
    };
  }, bubble);
  check('they go once the pointer leaves, even after a copy', afterCopy.opacity === 0, `${afterCopy.opacity}`);
  check('and the button does not keep focus from a click', !afterCopy.stillFocused);

  // Keyboard focus is a different matter: that is how somebody without a mouse
  // gets to them at all, so it still reveals the row.
  const byKeyboard = await page.evaluate((sel) => {
    const button = document.querySelector(`${sel} .msg__action`);
    button.focus();
    // Playwright's .focus() does not set :focus-visible, so ask the browser
    // whether the rule would match rather than reading the computed opacity.
    return { rule: !!document.querySelector(`${sel}:has(.msg__action:focus-visible), ${sel}:focus-within`) };
  }, bubble);
  check('but a keyboard user can still reach them', byKeyboard.rule);

  await page.hover(bubble);
  await page.click(`${bubble} [data-act="edit"]`);
  await page.waitForTimeout(400);
  const editing = await page.evaluate((sel) => {
    const box = document.querySelector(`${sel} .bubble__edit`);
    return { open: !!box, value: box?.value, buttons: document.querySelectorAll(`${sel} [data-edit]`).length };
  }, bubble);
  check('editing opens a box holding what you wrote', editing.open && editing.value === 'the question as first asked', editing.value);
  check('with a way out and a way on', editing.buttons === 2);
  // Nothing changed, nothing to save: re-asking the same words re-runs the turn for nothing.
  const saveOff = await page.evaluate((sel) => document.querySelector(`${sel} [data-edit="save"]`).disabled, bubble);
  check('Save and ask again waits for a change', saveOff);
  await page.fill(`${bubble} .bubble__edit`, 'the question as first asked!');
  const saveOn = await page.evaluate((sel) => !document.querySelector(`${sel} [data-edit="save"]`).disabled, bubble);
  check('  and is enabled by one', saveOn);

  // With an address in it, because the commonest edit is fixing the sentence
  // *around* a link — and the rebuilt bubble used to come back as plain text,
  // so saving a correction was how you broke the URL you had just pasted.
  const rewritten = 'see https://example.com/paper.pdf as it should have been';
  await page.fill(`${bubble} .bubble__edit`, rewritten);
  await page.click('[data-edit="save"]');
  await page.waitForTimeout(2500);

  const after = await page.evaluate(async () => {
    const { chats } = await (await fetch('/api/chats')).json();
    const full = await (await fetch(`/api/chats/${chats[0].id}`)).json();
    const body = document.querySelector('#messages .msg--user .bubble__text');
    const link = body?.querySelector('a');
    return {
      onScreen: body?.textContent,
      href: link?.getAttribute('href') || '',
      target: link?.getAttribute('target') || '',
      stored: full.messages.filter((m) => m.role === 'user').map((m) => m.text),
      total: full.messages.length,
    };
  });
  check('saving rewrites the message', after.onScreen === rewritten, after.onScreen);
  check('and stores the new wording', after.stored.join('|') === rewritten, after.stored.join('|'));
  check('the address in it is still a link afterwards', after.href === 'https://example.com/paper.pdf', after.href);

  // When it was sent, beside its copy button, in this device's own time zone —
  // and, like the buttons, only while you are pointing at the message.
  await page.mouse.move(20, 20);
  await page.waitForTimeout(350);
  const stamp = await page.evaluate(() => {
    const time = document.querySelector('#messages .msg--user .msg__actions .msg__time');
    if (!time) return null;
    const at = new Date(time.getAttribute('datetime'));
    return {
      text: time.textContent,
      tooltip: time.title,
      recent: Math.abs(Date.now() - at.getTime()) < 10 * 60_000,
      year: String(new Date().getFullYear()),
      opacity: getComputedStyle(time).opacity,
    };
  });
  check('a sent message says when it was sent', !!stamp?.recent && stamp.text.includes(stamp.year), JSON.stringify(stamp));
  check('  hidden while you are not pointing at it', stamp?.opacity === '0', stamp?.opacity);
  await page.hover('#messages .msg--user');
  await page.waitForTimeout(350);
  const hovered = await page.evaluate(() => getComputedStyle(document.querySelector('#messages .msg--user .msg__actions .msg__time')).opacity);
  check('  and shown with the buttons when you do', hovered === '1', hovered);
  check('  with the full date and the time zone on its tooltip', /\d{2}:\d{2}:\d{2}/.test(stamp?.tooltip || ''), stamp?.tooltip);
  check('and still opens away from the conversation', after.target === '_blank', after.target);
  // `textContent` has to read back exactly what was typed, or copying and
  // re-editing the bubble would hand back something the person did not write.
  check('while the text reads back unchanged', after.onScreen === rewritten);
  // Everything after it was a reply to a question that has been withdrawn.
  check('with everything that followed dropped', after.total === 1, `${after.total} messages left`);

  const assistant = await page.evaluate(() => !!document.querySelector('#messages .msg--assistant .msg__action'));
  check('an assistant turn offers no edit — that would be forging the record', !assistant);
}

section('a conversation nobody spoke in is not history');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  const before = await page.evaluate(async () => (await (await fetch('/api/chats')).json()).chats.length);

  // Press New chat three times and walk away. This used to leave three
  // identical "New chat" rows in the sidebar forever.
  for (let i = 0; i < 3; i += 1) {
    await page.click('#new-chat');
    await page.waitForTimeout(250);
  }

  const idle = await page.evaluate(async () => ({
    stored: (await (await fetch('/api/chats')).json()).chats.length,
    rows: document.querySelectorAll('#chat-list .chat-row').length,
    // Nothing in the sidebar is selected, because what you are looking at is
    // not in it yet.
    selected: document.querySelectorAll('#chat-list .chat-row.is-active').length,
    title: document.getElementById('chat-title').textContent,
    blank: !document.getElementById('empty-state').hidden,
  }));
  check('opening a blank chat stores nothing', idle.stored === before, `${before} → ${idle.stored}`);
  check('and adds no row to the sidebar', idle.rows === before, `${idle.rows}`);
  check('with nothing shown as selected', idle.selected === 0);
  check('the screen is a fresh one', idle.blank && idle.title === 'New chat', idle.title);

  // The first message is what brings it into existence.
  await page.fill('#input', 'the first thing said');
  await page.click('#send');
  await page.waitForTimeout(2000);

  const saved = await page.evaluate(async () => ({
    stored: (await (await fetch('/api/chats')).json()).chats.length,
    rows: document.querySelectorAll('#chat-list .chat-row').length,
  }));
  check('speaking in it saves it', saved.stored === before + 1, `${saved.stored}`);
  check('and it appears in the sidebar', saved.rows === before + 1, `${saved.rows}`);
}

section('there is no chat/agent toggle');
check('the toggle is gone', !(await page.$('#mode-toggle')));

section('the composer floats over the transcript');
const dock = await page.evaluate(() => {
  const composer = document.getElementById('composer').getBoundingClientRect();
  const thread = document.getElementById('thread');
  const box = thread.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(thread).paddingBottom);
  const dockH = document.getElementById('dock').offsetHeight;
  return {
    // The transcript runs the full height; the composer sits on top of it.
    threadReachesBottom: Math.abs(box.bottom - composer.bottom) < 2,
    composerInside: composer.bottom <= window.innerHeight + 1,
    padding: pad,
    dockH,
    gradientIgnoresClicks: getComputedStyle(document.getElementById('dock')).pointerEvents === 'none',
  };
});
check('the transcript extends under the composer', dock.threadReachesBottom);
check('the composer is on screen', dock.composerInside);
check('the dock does not block scrolling', dock.gradientIgnoresClicks);
check(
  'bottom padding matches the dock height',
  dock.padding >= dock.dockH && dock.padding <= dock.dockH + 20,
  `pad ${Math.round(dock.padding)} vs dock ${dock.dockH}`,
);

section('progress and the screen live in a side rail');
check('the rail exists', !!(await page.$('#detail')));
check('the screen panel is inside it', await page.evaluate(() => !!document.querySelector('#detail #screen')));
check('and not above the conversation', await page.evaluate(() => !document.querySelector('.main #screen')));

const railClosed = await page.evaluate(() => !document.getElementById('app').classList.contains('is-detail'));
check('it starts closed', railClosed);
await page.click('#detail-toggle');
await page.waitForTimeout(400);
const railOpen = await page.evaluate(() => {
  const detail = document.getElementById('detail').getBoundingClientRect();
  const thread = document.getElementById('thread').getBoundingClientRect();
  return {
    open: document.getElementById('app').classList.contains('is-detail'),
    width: Math.round(detail.width),
    // Beside the conversation, not on top of it.
    besideNotOver: detail.left >= thread.right - 2,
    onScreen: detail.right <= window.innerWidth + 1,
  };
});
check('the toggle opens it', railOpen.open, `${railOpen.width}px wide`);
check('it sits beside the conversation', railOpen.besideNotOver);
check('it stays on screen', railOpen.onScreen);

// A plan should fill it in and count itself off — drawn by the real module,
// with a turning ring for the step in progress and dashed rings for the rest.
await page.evaluate(async () => {
  const { normalisePlan, planItemHtml } = await import('/js/plan.js');
  const list = document.getElementById('progress-steps');
  // Four "in progress" is what a careless model sends; one is what is drawn.
  const steps = normalisePlan([
    { title: 'Read the spec', status: 'done' },
    { title: 'Write the code', status: 'in_progress', detail: 'The parser first, then the tests.' },
    { title: 'Run the tests', status: 'in_progress' },
    { title: 'Ship it', status: 'pending' },
  ]);
  list.innerHTML = steps.map((s) => planItemHtml(s, { withDetail: s.status === 'in_progress' })).join('');
  list.classList.add('is-live');
  document.getElementById('progress-count').textContent = '1 of 4';
});
await page.waitForTimeout(200);
const steps = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#progress-steps li')];
  const ring = document.querySelector('#progress-steps .pmark--active');
  return {
    classes: items.map((e) => e.className.replace('pstep ', '')),
    active: items.filter((e) => e.classList.contains('is-active')).length,
    dashed: document.querySelectorAll('#progress-steps .pmark--pending').length,
    turning: ring ? getComputedStyle(ring).animationName : '',
    detail: document.querySelector('#progress-steps .is-active .pstep__detail')?.textContent || '',
  };
});
check('steps render with their state', steps.classes.join() === 'is-done,is-active,is-pending,is-pending', steps.classes.join());
check('  exactly one in progress, however many the model claimed', steps.active === 1);
check('  the waiting ones as dashed rings', steps.dashed === 2, String(steps.dashed));
check('  the running one turning while the turn is live', steps.turning === 'spin', steps.turning);
check('  with what it involves under its title', /parser first/.test(steps.detail), steps.detail);
await page.evaluate(() => document.getElementById('progress-steps').classList.remove('is-live'));
check(
  '  and still once the turn has ended',
  (await page.evaluate(() => getComputedStyle(document.querySelector('#progress-steps .pmark--active')).animationName)) === 'none',
);
check('and are counted', (await page.textContent('#progress-count')) === '1 of 4');

await page.click('#detail-close');

/**
 * A long queued message must not carry its own controls off the screen.
 *
 * This shipped: `.queue__item` was a grid whose middle column was `1fr`, and a
 * grid item's automatic minimum is its min-content width — so one pasted
 * paragraph grew the row to 1729px inside a 780px composer and pushed "Send
 * now" and the delete button around 900px past the right edge of the window.
 * Both were rendered the entire time and neither could be clicked, which is
 * indistinguishable from their not existing, and is how it was reported.
 */
section('a long queued message stays inside the composer');
{
  const LONG =
    'đảm bảo tất cả các file này sẽ xóa vì tôi không train AI nữa: 1. Cache & file tạm thời ' +
    'AI/ML (khoảng 20+ GB) các file .arrow trong cache (625MB-6.4GB mỗi file) và toàn bộ thư mục ' +
    'huggingface, torch hub, cùng mọi checkpoint đã tải về trước đó không còn dùng đến nữa.';

  const box = await page.evaluate((text) => {
    const host = document.getElementById('queue');
    host.hidden = false;
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    // The same shape `renderQueue` builds. Injected rather than driven, because
    // queueing needs a running turn and that needs a provider key.
    host.innerHTML =
      '<div class="queue__item">' +
      '<span class="queue__wait" aria-hidden="true"></span>' +
      '<div class="queue__body">' +
      `<p class="queue__text" id="queue-text-0">${esc(text)}</p>` +
      '<button class="queue__more" data-more="0" type="button">Show more</button>' +
      '</div>' +
      '<div class="queue__actions">' +
      '<button class="queue__now" type="button">Send now</button>' +
      '<button class="queue__drop" type="button" aria-label="Remove">✕</button>' +
      '</div></div>';

    const r = (sel) => {
      const el = document.querySelector(sel);
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) };
    };
    const text0 = document.getElementById('queue-text-0');
    const clampedH = text0.clientHeight;
    const fullH = text0.scrollHeight;

    document.querySelector('.queue__item').classList.add('is-open');
    const openedH = document.getElementById('queue-text-0').clientHeight;

    return {
      viewport: window.innerWidth,
      item: r('.queue__item'),
      composer: r('.composer__box'),
      now: r('.queue__now'),
      drop: r('.queue__drop'),
      clampedH,
      fullH,
      openedH,
    };
  }, LONG);

  const onScreen = (b) => b.right <= box.viewport && b.left >= 0;
  check('the row does not outgrow the composer', box.item.right <= box.composer.right + 1, `${box.item.right} vs ${box.composer.right}`);
  check('"Send now" is reachable', onScreen(box.now), `right ${box.now.right} of ${box.viewport}`);
  check('and so is the delete button', onScreen(box.drop), `right ${box.drop.right} of ${box.viewport}`);
  check('the text is clamped rather than shown whole', box.clampedH < box.fullH, `${box.clampedH}px of ${box.fullH}px`);
  check('and opening it shows more', box.openedH > box.clampedH, `${box.openedH}px`);
}
await page.waitForTimeout(300);
check('closing works', await page.evaluate(() => !document.getElementById('app').classList.contains('is-detail')));

section('the screen panel says which browser you are looking at');
const labelled = await page.evaluate(() => {
  // The panel lives in the detail rail, so the rail has to be open for any of
  // it to be visible at all.
  document.getElementById('app').classList.add('is-detail');
  const panel = document.getElementById('screen');
  panel.hidden = false;
  // Pretend a sandbox frame arrived, then a desktop one.
  const badge = document.getElementById('screen-source');
  const closeBtn = document.getElementById('screen-stop');
  return { hasBadge: !!badge, hasClose: !!closeBtn };
});
check('there is a source badge', labelled.hasBadge);
check('and a way to close the sandbox yourself', labelled.hasClose);

// Taking the controls is off until asked for: a stray click while reading
// should not land in a page the assistant is midway through using.
const drive = await page.evaluate(() => {
  const btn = document.getElementById('screen-drive');
  return { exists: !!btn, pressed: btn?.getAttribute('aria-pressed'), focusable: document.getElementById('screen-img')?.tabIndex };
});
check('there is a take-control button', drive.exists);
check('control starts off', drive.pressed === 'false');

// The panel is a browser window somebody else is driving, so it has the row a
// browser has — and above the picture, where a browser puts it.
const chrome = await page.evaluate(() => {
  const nav = document.getElementById('screen-nav');
  const img = document.getElementById('screen-img');
  return {
    exists: !!nav,
    buttons: ['screen-back', 'screen-forward', 'screen-reload'].filter((id) => document.getElementById(id)).length,
    // Navigation is not behind "take control": watching a wrong turn with no
    // way to press Back is a strange kind of helplessness.
    outsideDriveMode: !document.getElementById('screen').classList.contains('is-driving'),
    // 4 is DOCUMENT_POSITION_FOLLOWING: the picture comes after the row.
    aboveThePicture: nav && img ? !!(nav.compareDocumentPosition(img) & 4) : false,
    urlInside: !!nav?.querySelector('#screen-url'),
  };
});
// The sandbox has always had real tabs; the panel only ever showed the focused
// one, so a second page read as the first one disappearing.
const strip = await page.evaluate(() => {
  const el = document.getElementById('screen-tabs');
  const nav = document.getElementById('screen-nav');
  return {
    exists: !!el,
    hiddenWithOneTab: el?.hidden !== false,
    aboveTheAddress: el && nav ? !!(el.compareDocumentPosition(nav) & 4) : false,
  };
});
check('the panel has a tab strip', strip.exists);
check('hidden while there is only one tab', strip.hiddenWithOneTab, 'a tab strip with one tab is furniture');
check('and it sits above the address row', strip.aboveTheAddress);

check('the panel has an address row', chrome.exists);
check('with back, forward and reload', chrome.buttons === 3, `${chrome.buttons}`);
check('above the page, where a browser keeps it', !!chrome.aboveThePicture);
check('and the address in it', chrome.urlInside);
check('usable without taking control first', chrome.outsideDriveMode);
check('the frame can receive keys once driving', drive.focusable === 0);

await page.click('#screen-drive');
await page.waitForTimeout(200);
const driving = await page.evaluate(() => ({
  pressed: document.getElementById('screen-drive').getAttribute('aria-pressed'),
  marked: document.getElementById('screen').classList.contains('is-driving'),
}));
check('it toggles on', driving.pressed === 'true');
check('and says so visibly', driving.marked);

// The chart that would not pan. An <img> is draggable by default, so pressing
// on the mirror and pulling started a native image drag and the gesture was
// never ours to forward.
const dragging = await page.evaluate(async () => {
  const img = /** @type {HTMLImageElement} */ (document.getElementById('screen-img'));
  // A frame to drag on. With no picture the image is hidden (the panel shows
  // its "no picture yet" line instead), and there is nothing to drag.
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 200 });
  img.src = canvas.toDataURL('image/png');
  await img.decode().catch(() => {});
  const style = getComputedStyle(img);
  // Does a real press-move-release reach the page as a drag rather than being
  // eaten by the browser's own image dragging?
  let started = false;
  const spy = () => { started = true; };
  img.addEventListener('dragstart', spy);
  const box = img.getBoundingClientRect();
  const at = (dx) => ({
    bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1,
    clientX: box.left + box.width / 2 + dx, clientY: box.top + box.height / 2,
  });
  img.dispatchEvent(new PointerEvent('pointerdown', at(0)));
  img.dispatchEvent(new PointerEvent('pointermove', at(120)));
  const midDrag = document.getElementById('screen').classList.contains('is-dragging');
  img.dispatchEvent(new PointerEvent('pointerup', at(120)));
  img.removeEventListener('dragstart', spy);
  return {
    nativeDragBlocked: style.webkitUserDrag === 'none' || style.userSelect === 'none',
    startedNativeDrag: started,
    midDrag,
    settled: !document.getElementById('screen').classList.contains('is-dragging'),
    cursor: style.cursor,
  };
});
check('the picture is not natively draggable', dragging.nativeDragBlocked, 'otherwise the gesture never reaches us');
check(
  'with no picture the frame says so instead of showing a broken image',
  await page.evaluate(() => {
    const img = document.getElementById('screen-img');
    const held = img.getAttribute('src');
    img.removeAttribute('src');
    const empty = getComputedStyle(document.querySelector('.screen__empty')).display !== 'none' && getComputedStyle(img).display === 'none';
    if (held) img.setAttribute('src', held);
    return empty;
  }),
);
check('a press and pull registers as a drag', dragging.midDrag, 'the panel marks itself while the gesture is live');
check('and the mark is cleared on release', dragging.settled);
check('the cursor invites it', /grab/.test(dragging.cursor), dragging.cursor);

await page.click('#screen-drive');

section('the screen panel expands to fill the window');
{
  // It was `grid-template-rows: auto 1fr` over four children, so the `1fr`
  // landed on the tab strip and the picture had no room at all: pressing the
  // expand button made the thing you wanted to see disappear.
  const before = await page.evaluate(() => document.querySelector('.screen__frame').getBoundingClientRect().height);
  await page.click('#screen-expand');
  await page.waitForTimeout(250);

  const expanded = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    const frame = panel.querySelector('.screen__frame');
    const bar = panel.querySelector('.screen__bar').getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    const img = document.getElementById('screen-img').getBoundingClientRect();
    return {
      marked: panel.classList.contains('is-expanded'),
      frameHeight: box.height,
      panelHeight: panel.getBoundingClientRect().height,
      viewport: innerHeight,
      barVisible: bar.height > 0,
      bottom: box.bottom,
      imageWithinFrame: img.height <= box.height + 1 && img.width <= box.width + 1,
    };
  });

  check('the panel is marked expanded', expanded.marked);
  check('it fills the window', Math.abs(expanded.panelHeight - expanded.viewport) < 2,
    `${expanded.panelHeight} vs ${expanded.viewport}`);
  check('the picture gets the space, not the tab strip', expanded.frameHeight > before,
    `${before}px → ${expanded.frameHeight}px`);
  check('and most of the window', expanded.frameHeight > expanded.viewport * 0.6, `${expanded.frameHeight}px`);
  check('the bar is still there to close it with', expanded.barVisible);
  check('nothing hangs off the bottom', expanded.bottom <= expanded.viewport + 1, `${expanded.bottom}`);
  check('and the picture fits inside its frame', expanded.imageWithinFrame, 'never cropped, never overflowing');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const collapsed = await page.evaluate(() =>
    document.getElementById('screen').classList.contains('is-expanded'));
  check('Escape puts it back', !collapsed);
}

/**
 * Driving the cloud browser goes straight to the machine (owner, 2026-10-07).
 *
 * It lagged because every gesture was a request through the server, and it
 * could not scroll sideways because only `deltaY` was ever sent. The machine's
 * socket is played here by Playwright; everything on the page side — the app
 * opening the panel for a cloud step, the state call, the socket, the frames,
 * the gestures — is the real code.
 */
section('the cloud browser is driven over a socket straight to the machine');
{
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(128, 80);
  const g = canvas.getContext('2d');
  g.fillStyle = '#2050e0';
  g.fillRect(0, 0, 128, 80);
  const jpeg = canvas.toBuffer('image/jpeg');

  const said = [];
  let socket = null;
  await page.routeWebSocket('wss://sb-ui.vercel.run/live', (ws) => {
    socket = ws;
    ws.onMessage((message) => {
      const note = JSON.parse(String(message));
      said.push(note);
      if (note.t === 'auth') {
        ws.send(JSON.stringify({ t: 'meta', title: 'Đề cương', url: 'https://decuongmonhoc.example/x', tabs: [] }));
        ws.send(jpeg);
      }
    });
  });
  const relayed = [];
  await page.route('**/api/cloud-browser/state*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        open: true,
        stream: 'https://sb-ui.vercel.run/stream?t=view.1.x',
        live: { url: 'wss://sb-ui.vercel.run/live', token: 'drive.123.sig', expiresAt: Date.now() + 60_000 },
        title: 'x',
        url: 'https://decuongmonhoc.example/x',
        tabs: [],
      }),
    }),
  );
  await page.route('**/api/cloud-browser/input', async (route) => {
    relayed.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"title":"x","url":"https://x/","tabs":[]}' });
  });
  await page.route('**/api/chats/*/run', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body:
        'event: tool_call\ndata: {"id":"cb1","name":"cloud_browser","input":{"action":"open","url":"https://decuongmonhoc.example/x"}}\n\n' +
        'event: tool_result\ndata: {"toolCallId":"cb1","name":"cloud_browser","content":"Page: x","ms":900}\n\n' +
        'event: done\ndata: {"stopReason":"end_turn"}\n\n',
    }),
  );

  // A fresh page, as the model-switch check does, so no earlier turn is still
  // holding the composer; then driving first, so the panel stays awake after
  // this short turn ends.
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    document.getElementById('app').classList.add('is-detail');
    document.getElementById('screen').hidden = false;
  });
  await page.click('#screen-drive');
  await page.fill('#input', 'mở đề cương');
  await page.press('#input', 'Enter');
  const waitFor = async (test, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await test()) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await waitFor(() => said.some((n) => n.t === 'ack'), 12_000);
  const auth = said.find((n) => n.t === 'auth');
  const where = await page.evaluate(() => document.getElementById('screen-source').textContent);
  check('a cloud step opens the socket with the drive token — sent inside it, never in the address', auth?.token === 'drive.123.sig' && auth.width > 0 && auth.height > 0, `${JSON.stringify(auth)} · panel: ${where} · errors: ${pageErrors.join(' | ').slice(0, 300)}`);
  const painted = await page.evaluate(() => ({
    src: document.getElementById('screen-img').getAttribute('src') || '',
    title: document.getElementById('screen-title').textContent,
    live: document.getElementById('screen-live').classList.contains('is-live'),
  }));
  check('  a frame from it is painted, and acknowledged so the next can come', painted.src.startsWith('blob:') && said.some((n) => n.t === 'ack') && painted.live, painted.src.slice(0, 30));
  check('  and the page\'s title arrives over it too', painted.title === 'Đề cương', painted.title);

  const box = await page.evaluate(() => {
    const r = document.getElementById('screen-img').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const inputs = () => said.filter((n) => n.t === 'input').map((n) => n.e);
  said.length = 0;
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(160, 0);
  await waitFor(() => inputs().some((e) => e.type === 'wheel'));
  const sideways = inputs().find((e) => e.type === 'wheel');
  check('a sideways wheel goes as a sideways scroll', sideways?.deltaX > 0 && sideways.deltaY === 0, JSON.stringify(sideways));
  said.length = 0;
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Shift');
  await waitFor(() => inputs().some((e) => e.type === 'wheel'));
  const shifted = inputs().find((e) => e.type === 'wheel');
  check('  and Shift turns a plain wheel sideways, as browsers do', shifted?.deltaX === 120 && shifted.deltaY === 0, JSON.stringify(shifted));

  said.length = 0;
  await page.mouse.move(box.x - 40, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y, { steps: 4 });
  await page.mouse.up();
  await waitFor(() => inputs().some((e) => e.type === 'up'));
  const kinds = inputs().map((e) => e.type);
  check('pressing, moving and releasing travel as they happen, so selecting text works', kinds[0] === 'move' || kinds.includes('down'), kinds.join(','));
  check('  in order: down, moves, up', kinds.indexOf('down') < kinds.lastIndexOf('move') && kinds.lastIndexOf('move') < kinds.indexOf('up'), kinds.join(','));

  said.length = 0;
  await page.mouse.dblclick(box.x, box.y);
  await waitFor(() => inputs().filter((e) => e.type === 'down').length >= 2);
  const counts = inputs().filter((e) => e.type === 'down').map((e) => e.count);
  check('a double click is a double click on the page — a word selected', counts.join(',') === '1,2', counts.join(','));

  said.length = 0;
  await page.keyboard.type('ư');
  await page.keyboard.insertText('Việt Nam');
  await page.keyboard.press('Control+KeyA');
  await page.keyboard.press('Backspace');
  await waitFor(() => inputs().some((e) => e.key === 'Backspace'));
  const typed = inputs();
  check('typing goes as text, accents and composed words whole', typed.some((e) => e.type === 'text' && e.text === 'ư') && typed.some((e) => e.type === 'text' && e.text === 'Việt Nam'), JSON.stringify(typed));
  check('  shortcuts and named keys as presses', typed.some((e) => e.type === 'key' && e.key === 'Control+a') && typed.some((e) => e.type === 'key' && e.key === 'Backspace'), JSON.stringify(typed));
  check('none of it went through the server', relayed.length === 0, `${relayed.length} relayed`);

  await page.keyboard.press('Escape');
  check('Escape gives the controls back', await page.evaluate(() => document.getElementById('screen-drive').getAttribute('aria-pressed') === 'false'));
  check('  and the machine is told the person stopped driving', said.some((n) => n.t === 'view' && n.driving === false));

  // A browser that cannot have the socket: the relay, batched.
  socket?.close();
  await page.waitForTimeout(400);
  await page.unroute('**/api/chats/*/run');
  await page.unroute('**/api/cloud-browser/input');
  await page.unroute('**/api/cloud-browser/state*');
  await page.route('**/api/cloud-browser/input', async (route) => {
    relayed.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"title":"x","url":"https://x/","tabs":[]}' });
  });
  await page.route('**/api/cloud-browser/state*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ open: true, stream: 'https://sb-ui.vercel.run/stream?t=view.2.y', live: { url: 'wss://sb-ui.vercel.run/live-refused', token: 'drive.9.z' }, title: 'x', url: 'https://x/', tabs: [] }) }),
  );
  await page.routeWebSocket('wss://sb-ui.vercel.run/live-refused', (ws) => ws.close({ code: 1006 }));
  await page.click('#screen-drive');
  await page.waitForTimeout(1500);
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(90, 0);
  // The move goes first, in a batch of its own; the wheel follows once that one is answered.
  await waitFor(() => relayed.flatMap((body) => body.events || []).some((e) => e.type === 'wheel'), 6000);
  const viaRelay = relayed.flatMap((body) => body.events || []);
  check('when the socket is refused, gestures go through the server instead — batched, sideways part kept', viaRelay.some((e) => e.type === 'wheel' && e.deltaX > 0), JSON.stringify(relayed).slice(0, 200));
  await page.keyboard.press('Escape');
  await page.unroute('**/api/cloud-browser/input');
  await page.unroute('**/api/cloud-browser/state*');
  await page.evaluate(() => {
    document.getElementById('screen').hidden = true;
  });
}

section('the conversation row menu');
// It used to call prompt(), which browsers suppress after a few uses — the
// click then silently did nothing at all.
await page.evaluate(() => {
  window.__dialogs = 0;
  for (const fn of ['prompt', 'confirm', 'alert']) {
    window[fn] = () => {
      window.__dialogs += 1;
      return null;
    };
  }
});
await page.click('#new-chat');
await page.waitForTimeout(900);
const hasRow = await page.$('.chat-row__menu');
check('a conversation row exists', !!hasRow);

await page.click('.chat-row__menu');
await page.waitForTimeout(300);
const menu = await page.evaluate(() => {
  const el = document.getElementById('row-menu');
  const box = el.getBoundingClientRect();
  return {
    open: !el.hidden,
    items: [...el.querySelectorAll('.menu__item span:first-of-type')].map((s) => s.textContent),
    keys: [...el.querySelectorAll('.menu__key')].map((s) => s.textContent),
    onScreen: box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
    usedBrowserDialog: window.__dialogs > 0,
  };
});
check('the menu opens', menu.open);
/*
 * The menu grew from three entries to everything you can do to one
 * conversation — the same list the chevron beside the title offers, built from
 * one description so the two cannot drift apart. "Remove from project" is here
 * because this conversation is filed under one; it is left out entirely when
 * there is nothing to remove it from, since an entry that does nothing is
 * worse than an absent one — it is a thing you try and learn from.
 */
check(
  'it offers everything you can do to a conversation',
  menu.items.join(',') ===
    // "Copy share link" replaced "Copy session ID": it shares the conversation
    // by link (server/routes/chatShare.js) rather than copying an internal id.
    'Open in new window,Copy share link,Pin,Mark as unread,Rename,Change project,Remove from project,Move to group,Archive,Delete',
  menu.items.join(' '),
);
check('with shortcut letters on the ones that have them', menu.keys.join('') === 'PURAD', menu.keys.join(''));
check('it stays on screen', menu.onScreen);
check('no browser dialog was used', !menu.usedBrowserDialog);

// Delete must take two clicks, so a mis-click cannot destroy a conversation.
await page.click('.menu__item--danger');
await page.waitForTimeout(200);
const armed = await page.evaluate(() => ({
  stillOpen: !document.getElementById('row-menu').hidden,
  label: document.querySelector('.menu__item--danger span').textContent,
}));
check('deleting arms rather than fires', armed.stillOpen && /really/i.test(armed.label), armed.label);

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape closes it', await page.evaluate(() => document.getElementById('row-menu').hidden));

// Renaming happens in the row itself. Picked by what it says rather than by
// position: the menu has grown once already, and a fixed index is how a test
// starts silently exercising whatever landed in that slot.
await page.click('.chat-row__menu');
await page.waitForTimeout(250);
await page.evaluate(() => {
  const hit = [...document.querySelectorAll('#row-menu .menu__item')].find(
    (el) => el.querySelector('span')?.textContent === 'Rename',
  );
  hit?.click();
});
await page.waitForTimeout(250);
check('rename edits in place', !!(await page.$('.chat-item--editing')));
await page.fill('.chat-item--editing', 'Renamed by the test');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const titles = await page.$$eval('.chat-item', (els) => els.map((e) => e.textContent.trim()));
check('the new title stuck', titles.includes('Renamed by the test'), titles.join(' | ').slice(0, 60));

section('the model dialog scrolls in exactly one place');
await page.click('#model-chip');
await page.waitForTimeout(1400);

// Scoped to the dialog: the transcript behind it scrolls too, correctly.
const scrollers = await page.evaluate(SCROLLERS, '#models');
check('one scrolling region, not several', scrollers.length === 1, `${scrollers.length} found`);
check('and it is the model list', scrollers[0]?.id === 'model-results', scrollers[0]?.id || 'none');
check('nothing has a horizontal scrollbar', !scrollers.some((s) => s.x));

// A grid column sized to max-content once made this 4054px wide inside a 658px
// dialog, which is what put a horizontal bar under the whole sheet.
const fit = await page.evaluate(() => {
  const d = document.getElementById('models');
  const search = document.getElementById('model-search').getBoundingClientRect();
  return {
    overflowX: d.scrollWidth - d.clientWidth,
    overflowY: d.scrollHeight - d.clientHeight,
    searchInside: search.right <= d.getBoundingClientRect().right + 1,
  };
});
check('the dialog does not overflow horizontally', fit.overflowX <= 1, `${fit.overflowX}px`);
check('the dialog does not overflow vertically', fit.overflowY <= 1, `${fit.overflowY}px`);
check('the search box stays inside the dialog', fit.searchInside);

section('choosing a model by provider');
const providers = await page.$$eval('#provider-filter .seg__btn', (els) => els.map((e) => e.dataset.provider));
check(
  'every provider is offered',
  providers.join() === 'all,anthropic,openai,google,openrouter,orcarouter',
  providers.join(' '),
);

/**
 * `auto` is not a provider's model and is deliberately in every list.
 *
 * It is the "I don't know which model is strong" answer, resolved per turn to
 * the best free model the account can run, and `renderResults` puts it above
 * everything on every tab except Paid. Filtering it out here is the difference
 * between testing the provider filter and testing that the Auto card exists —
 * which the check below does directly, so that it cannot quietly disappear.
 */
const AUTO = 'auto';

for (const [provider, pattern] of [
  ['anthropic', /^anthropic\//],
  ['openai', /^openai\//],
  ['google', /^google\//],
]) {
  await page.click(`#provider-filter [data-provider="${provider}"]`);
  await page.waitForTimeout(500);
  const view = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('[data-model]')].map((e) => e.dataset.model),
    chipsHidden: document.getElementById('vendor-row').hidden,
  }));
  const own = view.ids.filter((id) => id !== AUTO);
  check(
    `${provider} shows only its own models`,
    own.length > 0 && own.every((id) => pattern.test(id)),
    `${own.length} models${own.find((id) => !pattern.test(id)) ? `, stray ${own.find((id) => !pattern.test(id))}` : ''}`,
  );
  // Auto runs on an OpenRouter key, so it is offered only where OpenRouter's models are.
  check(`${provider} does not offer Auto`, !view.ids.includes(AUTO), view.ids.slice(0, 3).join(','));
  check(`${provider} hides the vendor chips`, view.chipsHidden === true);
}

await page.click('#provider-filter [data-provider="openrouter"]');
await page.waitForTimeout(800);
const library = await page.evaluate(() => ({
  ids: [...document.querySelectorAll('[data-model]')].map((e) => e.dataset.model),
  chipsHidden: document.getElementById('vendor-row').hidden,
}));
const libraryOwn = library.ids.filter((id) => id !== AUTO);
check('OpenRouter offers Auto', library.ids.includes(AUTO));
check('and not the free router a second time as a row', !library.ids.includes('openrouter/openrouter/free'));
check(
  'OpenRouter shows the library and nothing built in',
  libraryOwn.length > 0 && libraryOwn.every((id) => id.startsWith('openrouter/')),
  `${libraryOwn.length} models${
    libraryOwn.find((id) => !id.startsWith('openrouter/'))
      ? `, stray ${libraryOwn.find((id) => !id.startsWith('openrouter/'))}`
      : ''
  }`,
);
check('OpenRouter brings the vendor chips back', library.chipsHidden === false);

// The chip you tap should land in the middle of its strip, not against the edge
// it came from — the neighbours you might pick next are the whole point of a
// row that scrolls.
{
  const strip = await page.evaluate(() => {
    const bar = document.getElementById('family-filter');
    const chips = [...bar.querySelectorAll('.chip-btn')];
    return { scrolls: bar.scrollWidth > bar.clientWidth + 2, count: chips.length };
  });
  if (!strip.scrolls) {
    realLog(`  ·  the vendor strip fits this viewport (${strip.count} chips) — nothing to centre`);
  } else {
    // A chip from the middle of a long strip has room to reach the centre, so
    // this is where "centred" is actually provable rather than merely allowed.
    const mid = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#family-filter .chip-btn')];
      return chips[Math.min(4, chips.length - 1)].dataset.family;
    });
    await page.click(`#family-filter [data-family="${mid}"]`);
    await page.waitForTimeout(800);
    const middle = await page.evaluate(() => {
      const bar = document.getElementById('family-filter');
      const el = bar.querySelector('.chip-btn.is-active');
      const b = bar.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return { off: Math.round(e.left + e.width / 2 - (b.left + b.width / 2)) };
    });
    check('the vendor you pick lands in the middle of the strip', Math.abs(middle.off) < 24, `${middle.off}px off centre`);

    const last = await page.evaluate(
      () => [...document.querySelectorAll('#family-filter .chip-btn')].pop().dataset.family,
    );
    await page.click(`#family-filter [data-family="${last}"]`);
    await page.waitForTimeout(800);
    const where = await page.evaluate(() => {
      const bar = document.getElementById('family-filter');
      const el = bar.querySelector('.chip-btn.is-active') || bar.querySelector('.chip-btn');
      const b = bar.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return {
        off: Math.round(e.left + e.width / 2 - (b.left + b.width / 2)),
        atEnd: bar.scrollLeft >= bar.scrollWidth - bar.clientWidth - 2,
        inside: e.left >= b.left - 1 && e.right <= b.right + 1,
      };
    });
    // The last chip cannot reach the middle, so the rule there is "clamped to
    // the end and fully visible" rather than "centred".
    check('picking a vendor off the edge brings it fully into view', where.inside, JSON.stringify(where));
    check('and the strip stops at its end rather than scrolling past', where.atEnd, JSON.stringify(where));
  }
}

// "Anthropic + Free" is legitimately empty. Saying why beats shrugging.
await page.click('#provider-filter [data-provider="anthropic"]');
await page.click('#tier-filter [data-tier="free"]');
await page.waitForTimeout(500);
const empty = await page.textContent('#model-results .hint').catch(() => '');
check('an empty combination explains itself', /no free models/i.test(empty || ''), (empty || '').slice(0, 60));

section('appearance');
{
  // Declared in the markup for a long time — `data-theme`, `color-scheme:
  // dark light` — and never actually written, so the switch pointed at nothing.
  const before = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    attr: document.documentElement.dataset.theme ?? null,
  }));

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.waitForTimeout(150);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForTimeout(150);
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  check('light and dark are actually different', light !== dark, `${light} vs ${dark}`);
  check('light really is light', /^rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)$/.test(light), light);
  check('dark really is dark', /^rgb\(1?[0-9]?[0-9], /.test(dark), dark);
  check('the toggle exists in settings', !!(await page.$('#theme')));
  check('and offers a system option', await page.$eval('#theme', (s) => !!s.querySelector('[value="system"]')));

  await page.evaluate((value) => {
    if (value) document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  }, before.attr);
}

/**
 * The chip and Settings are one setting, and must never show two values.
 *
 * This is the bug as reported: Settings read `google/gemini-pro-latest` while the
 * header chip on the conversation read `gemini-flash-latest`. Two causes, both
 * real. The chip had **two** click listeners — one opened Settings → Models, the
 * other opened the picker — so pressing it stacked the picker over a sheet
 * showing a different value. And a conversation carried its own stored model, so
 * even once the sheet was closed the two were genuinely different numbers.
 *
 * There is one model now, and — since the duplicate field was removed from
 * Settings → Models — exactly one control for it. The surest way for two places
 * to disagree is for there to be two places, so what is checked here is that the
 * second one is gone and that the remaining one survives a reload and an old
 * conversation being reopened.
 */
section('the model is one setting, with one control');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);

  // Pressing the chip must open exactly one thing. Two listeners used to fire.
  await page.click('#model-chip');
  await page.waitForTimeout(1000);
  const opened = await page.evaluate(() =>
    [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id));
  check('the chip opens the picker and nothing else', opened.join() === 'models', opened.join(' ') || 'nothing');

  // An earlier section leaves the tier filter on "free", under which no built-in
  // model matches; the picker keeps one state object for the whole page life.
  await page.click('#tier-filter [data-tier="all"]');
  await page.waitForTimeout(400);
  await page.click('#provider-filter [data-provider="google"]');
  await page.waitForTimeout(700);
  const viaChip = await page.$eval('[data-model]', (el) => el.dataset.model);
  await page.click(`[data-model="${viaChip}"]`);
  await page.waitForTimeout(1000);

  check('the chip shows what was picked', await page.evaluate(
    (m) => document.getElementById('model-chip').title.includes(m), viaChip), viaChip);

  // Settings has no Models tab any more: the chip is the one way to choose a
  // model, and the tab's place is taken by Languages.
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  const settingsPanel = await page.evaluate(() => ({
    field: !!document.getElementById('default-model-display'),
    button: !!document.getElementById('pick-default-model'),
    modelsTab: !!document.querySelector('.tab[data-tab="models"]'),
    languagesTab: !!document.querySelector('.tab[data-tab="languages"]'),
    tasksTab: !!document.querySelector('.tab[data-tab="tasks"]') || !!document.getElementById('panel-tasks'),
  }));
  check('Settings no longer carries a second copy of the model', !settingsPanel.field);
  check('nor a second way to change it', !settingsPanel.button);
  check('the Models tab is gone', !settingsPanel.modelsTab);
  check('and Languages has taken its place', settingsPanel.languagesTab);
  // The same rule for schedules: the Scheduled page is where they are made and
  // changed, and a second copy in Settings was the owner's "dư thừa".
  check('Settings has no Scheduled tab either', !settingsPanel.tasksTab);

  // PRV-003: hiding personal details from the provider is one switch, saved to the account.
  {
    const { getStore } = await import('../server/store/index.js');
    const { getPrefs } = await import('../server/settings.js');
    const me = await getStore().getUserByEmail('ui@test.local');
    await page.click('#tab-memory');
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => /** @type {HTMLInputElement} */ (document.getElementById('mask-personal'))?.checked);
    await page.check('#mask-personal');
    await page.click('#save-memory-prefs');
    await page.waitForTimeout(800);
    const saved = (await getPrefs(me.id)).maskPersonal;
    check('Settings offers to hide personal details from the provider, off at first', before === false, String(before));
    check('  and the switch is saved to the account', saved === true, String(saved));
    await page.uncheck('#mask-personal');
    await page.click('#save-memory-prefs');
    await page.waitForTimeout(600);
  }

  // The reload is what used to expose the disagreement.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.click('.chat-item');
  await page.waitForTimeout(1500);

  const reloaded = await page.evaluate(() => document.getElementById('model-chip').title);
  check('after a reload the chip still shows it', reloaded.includes(viaChip), reloaded);
  check(
    'and reopening an older conversation shows the same model, not a stored one',
    reloaded.includes(viaChip),
    reloaded,
  );

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

/**
 * A model that has gone moves the account to Auto, and the interface says so
 * (server/modelRetirement.js). Before this the chip went on naming a model the
 * picker no longer listed, and every message failed.
 */
section('a model that has gone: the chip moves to Auto, and the person is told');
{
  const { setPrefs, getPrefs } = await import('../server/settings.js');
  const { getStore } = await import('../server/store/index.js');
  const me = await getStore().getUserByEmail('ui@test.local');
  const kept = (await getPrefs(me.id)).defaultModel;
  const seen = () =>
    page.evaluate(() => ({
      chip: document.getElementById('model-chip')?.textContent?.trim() || '',
      told: [...document.querySelectorAll('#toasts-alert > *, #toasts > *')].map((n) => n.textContent).join(' | '),
    }));

  // Moved while the person was away — by a scheduled run overnight, say.
  await setPrefs(me.id, { defaultModel: 'auto', modelNotice: { from: 'space-bunny-alpha', at: new Date().toISOString() } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const atOpen = await seen();
  check('a move made while away shows Auto on the chip', atOpen.chip === 'Auto', atOpen.chip);
  check('  and says which model went', /space-bunny-alpha/.test(atOpen.told), atOpen.told);
  await page.waitForTimeout(800);
  check('  once: the notice is cleared after it is shown', (await getPrefs(me.id)).modelNotice == null);

  // Moved in the middle of a turn: the server's `model_switched`.
  await setPrefs(me.id, { defaultModel: kept, modelNotice: null });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.route('**/api/chats/*/run', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'event: model_switched\ndata: {"from":"Lab Live","to":"auto"}\n\nevent: done\ndata: {"stopReason":"end_turn"}\n\n',
    }),
  );
  await page.fill('#input', 'still there?');
  await page.press('#input', 'Enter');
  await page.waitForTimeout(2500);
  await page.unroute('**/api/chats/*/run');
  const midTurn = await seen();
  check('a switch in the middle of a turn moves the chip to Auto', midTurn.chip === 'Auto', midTurn.chip);
  check('  and names the model that went', /Lab Live/.test(midTurn.told), midTurn.told);

  await setPrefs(me.id, { defaultModel: kept, modelNotice: null });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
}

/**
 * Many tabs in the sandbox must be reachable.
 *
 * The strip had `overflow-x: auto` with the scrollbar hidden on both engines, so
 * with five tabs open it genuinely scrolled and nothing said so — the tabs past
 * the right-hand edge simply did not appear to exist.
 */
section('the sandbox tab strip can be scrolled to');
{
  const strip = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    const bar = document.getElementById('screen-tabs');
    panel.hidden = false;
    bar.hidden = false;
    bar.innerHTML = '';
    for (let i = 1; i <= 8; i += 1) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `screen__tab${i === 1 ? ' is-active' : ''}`;
      b.textContent = `averylongtabhost-${i}.example.com`;
      bar.append(b);
    }
    const style = getComputedStyle(bar);
    return {
      overflows: bar.scrollWidth > bar.clientWidth + 2,
      overflowX: style.overflowX,
      // `none` is what hid it. Anything else means there is a bar to grab.
      scrollbarWidth: style.scrollbarWidth,
      canScroll: (() => {
        bar.scrollLeft = 9999;
        const moved = bar.scrollLeft > 0;
        bar.scrollLeft = 0;
        return moved;
      })(),
    };
  });

  check('eight tabs overflow the strip', strip.overflows, 'otherwise there is nothing to prove');
  check('the strip scrolls horizontally', strip.overflowX === 'auto' || strip.overflowX === 'scroll', strip.overflowX);
  check('and the scrollbar is no longer hidden', strip.scrollbarWidth !== 'none', strip.scrollbarWidth);
  check('so the tabs past the edge can be reached', strip.canScroll);

  await page.evaluate(() => {
    document.getElementById('screen-tabs').innerHTML = '';
    document.getElementById('screen-tabs').hidden = true;
    document.getElementById('screen').hidden = true;
  });
}

/**
 * The guide a new account sees, and the language it speaks.
 *
 * Two things worth pinning. It has to appear **once** — a guide that comes back
 * after being dismissed has stopped being help — and it must not appear over the
 * new-model announcement, because two stacked modals on a first visit is worse
 * than either alone.
 */
section('the getting-started guide');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);

  // This account has been through the app already, so the guide is dismissed by
  // now. Reopening it from Settings is the path somebody actually uses.
  await page.click('#open-settings');
  await page.waitForTimeout(400);
  await page.click('.tab[data-tab="behaviour"]');
  await page.waitForTimeout(300);
  check('Settings offers the guide again', await page.isVisible('#open-onboarding'));

  await page.click('#open-onboarding');
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => ({
    open: document.getElementById('onboarding').open,
    others: [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id),
    step: document.getElementById('onb-step').textContent.trim(),
    title: document.querySelector('#onb-body .onb__title')?.textContent.trim() || '',
    backHidden: document.getElementById('onb-back').hidden,
  }));
  check('the guide opens', opened.open === true);
  check('and it is the only thing open', opened.others.join() === 'onboarding', opened.others.join(' '));
  check('it starts at step 1 of 5', /1/.test(opened.step) && /5/.test(opened.step), opened.step);
  check('with a title', opened.title.length > 0, opened.title);
  check('and no Back button on the first step', opened.backHidden === true);

  // Walk all five steps. Each one has to render something.
  const titles = [opened.title];
  for (let i = 2; i <= 5; i += 1) {
    await page.click('#onb-next');
    await page.waitForTimeout(350);
    const at = await page.evaluate(() => ({
      step: document.getElementById('onb-step').textContent.trim(),
      title: document.querySelector('#onb-body .onb__title')?.textContent.trim() || '',
      body: document.getElementById('onb-body').textContent.trim().length,
      backHidden: document.getElementById('onb-back').hidden,
    }));
    check(`step ${i} renders`, at.title.length > 0 && at.body > 40, `${at.title} (${at.body} chars)`);
    check(`step ${i} can be gone back from`, at.backHidden === false);
    titles.push(at.title);
  }
  check('all five steps are different', new Set(titles).size === 5, titles.join(' | '));

  /**
   * Step 2 tracks whether a key exists, in both directions.
   *
   * This account has none yet, so it has to say so and offer the way to fix it.
   * Then a key is saved — through the interface, the way somebody would — and the
   * step has to notice **while it is still open behind the settings sheet**. A
   * guide that tells you to paste a key you have just pasted is a guide arguing
   * with you.
   */
  await page.click('#onb-back');
  await page.click('#onb-back');
  await page.click('#onb-back');
  await page.waitForTimeout(400);
  const noKey = await page.evaluate(() => ({
    step: document.getElementById('onb-step').textContent.trim(),
    todo: !!document.querySelector('#onb-body .onb__state.is-todo'),
    prompts: !!document.getElementById('onb-keys'),
  }));
  check('back reaches step 2', /2/.test(noKey.step), noKey.step);
  check('step 2 says there is no key yet', noKey.todo === true);
  check('and offers the way to add one', noKey.prompts === true);

  // Follow that button, save a key, and come back to the guide still open behind.
  await page.click('#onb-keys');
  await page.waitForTimeout(600);
  check('it opens the key settings', await page.isVisible('#provider-list'));
  await page.fill('[data-key="openrouter"]', 'sk-or-v1-ui-test-key');
  await page.click('[data-save-key="openrouter"]');
  await page.waitForTimeout(900);
  await page.evaluate(() => document.getElementById('settings').close());
  await page.waitForTimeout(500);

  const withKey = await page.evaluate(() => ({
    open: !!document.getElementById('onboarding')?.open,
    step: document.getElementById('onb-step').textContent.trim(),
    done: !!document.querySelector('#onb-body .onb__state.is-done'),
    prompts: !!document.getElementById('onb-keys'),
  }));
  check('the guide is still open behind the sheet', withKey.open === true);
  check('still on step 2', /2/.test(withKey.step), withKey.step);
  check('and it now sees the key that was just saved', withKey.done === true);
  check('so it stops asking for one', withKey.prompts === false);

  // Step 4 hands a sentence to the composer and closes.
  await page.click('#onb-next');
  await page.click('#onb-next');
  await page.waitForTimeout(400);
  const tries = await page.$$eval('#onb-body .onb__try', (els) => els.map((e) => e.textContent.trim()));
  check('step 4 offers something to try', tries.length === 3, tries.length + ' suggestions');
  await page.click('#onb-body .onb__try');
  await page.waitForTimeout(500);
  const handed = await page.evaluate(() => ({
    closed: !document.getElementById('onboarding').open,
    typed: document.getElementById('input').value.trim(),
  }));
  check('pressing one closes the guide', handed.closed === true);
  check('and puts the question in the composer', handed.typed.length > 0, handed.typed);

  await page.evaluate(() => {
    document.getElementById('input').value = '';
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

section('the interface speaks Vietnamese');
{
  await page.click('#open-settings');
  await page.waitForTimeout(400);
  await page.click('.tab[data-tab="languages"]');
  await page.waitForTimeout(300);

  const offered = await page.$$eval('#language input[name="language"]', (els) => els.map((e) => e.value));
  check('both languages are offered', offered.join() === 'vi,en', offered.join(' '));

  const before = await page.evaluate(() => ({
    newChat: document.querySelector('#new-chat .rail__label').textContent.trim(),
    lang: document.documentElement.lang,
  }));

  await page.check('#language input[value="vi"]');
  await page.waitForTimeout(700);

  const after = await page.evaluate(() => ({
    newChat: document.querySelector('#new-chat .rail__label').textContent.trim(),
    settings: document.querySelector('#open-settings .rail__label').textContent.trim(),
    languagesTab: document.querySelector('.tab[data-tab="languages"]').textContent.trim(),
    placeholder: document.getElementById('input').placeholder,
    lang: document.documentElement.lang,
    // The screens the user reported in English: the model picker and the rest
    // of Settings. Read from markup that is not on screen, which is fine —
    // applyI18n fills every node whether its dialog is open or not.
    pickerTitle: document.querySelector('#models .sheet__head h2').textContent.trim(),
    pickerSearch: document.getElementById('model-search').placeholder,
    freeFilter: document.querySelector('#tier-filter [data-tier="free"]').textContent.trim(),
    behaviourHint: document.querySelector('#behaviour-elsewhere strong').textContent.trim(),
  }));
  check('the model picker title is Vietnamese', after.pickerTitle === 'Chọn model', after.pickerTitle);
  check('and its search box', /^Tìm/.test(after.pickerSearch), after.pickerSearch.slice(0, 30));
  check('and its price filter', after.freeFilter === 'Miễn phí', after.freeFilter);
  check('and a hint with markup inside keeps its markup', after.behaviourHint === 'Chế độ và mức suy luận', after.behaviourHint);
  check('the sidebar changes language', after.newChat !== before.newChat, `${before.newChat} → ${after.newChat}`);
  check('and it is actually Vietnamese', /Cuộc trò chuyện/.test(after.newChat), after.newChat);
  check('settings label too', /Cài đặt/.test(after.settings), after.settings);
  check('the settings tabs too', /Ngôn ngữ/.test(after.languagesTab), after.languagesTab);
  check('and the composer placeholder', /Hỏi bất cứ điều gì/.test(after.placeholder), after.placeholder.slice(0, 40));
  check('the document language is stamped', after.lang === 'vi', after.lang);
  check('no untranslated key leaked through', !/^[a-z]+\.[a-z]+/i.test(after.newChat), after.newChat);

  /**
   * The four openers on the blank screen change with everything else.
   *
   * They were a module-level `const` of four `t()` calls, evaluated once at
   * import time — so they froze in whichever language the page loaded in, and
   * switching language repainted the whole interface around four English
   * sentences that only corrected themselves on a reload. That is also the
   * screen somebody is most likely to be looking at while changing it, being
   * the one with nothing else on it.
   */
  const openers = await page.evaluate(() =>
    [...document.querySelectorAll('#suggestions .suggestion')].map((b) => b.textContent.trim()),
  );
  check('there are four openers', openers.length === 4, `${openers.length}`);
  check('and they are Vietnamese now, without a reload', openers.every((s) => /[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(s)), openers.join(' | '));
  check('none is a leaked key', !openers.some((s) => /^suggest\./.test(s)), openers.join(' | '));

  /**
   * And the sidebar's own headings, which are appended by script.
   *
   * "Conversations" and "Projects" are built by `refreshChats` rather than
   * carried on `data-i18n` nodes, so `applyI18n` could not reach them: an
   * English "CONVERSATIONS" stood over an otherwise Vietnamese sidebar until
   * the list happened to refresh for some unrelated reason.
   */
  const headings = await page.evaluate(() =>
    [...document.querySelectorAll('#chat-list .chats__label')].map((n) => n.textContent.trim()),
  );
  check(
    'the sidebar headings are Vietnamese too, without a reload',
    headings.length > 0 && !headings.some((h) => /^(CONVERSATIONS|PROJECTS)$/i.test(h)),
    headings.join(' | '),
  );

  // It has to survive a reload — that is what "per account" means.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const kept = await page.evaluate(() => ({
    newChat: document.querySelector('#new-chat .rail__label').textContent.trim(),
    lang: document.documentElement.lang,
  }));
  check('the choice survives a reload', /Cuộc trò chuyện/.test(kept.newChat), kept.newChat);
  check('and the stamp with it', kept.lang === 'vi', kept.lang);

  // Back to English so later sections read the labels they expect.
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await page.click('.tab[data-tab="languages"]');
  await page.waitForTimeout(300);
  await page.check('#language input[value="en"]');
  await page.waitForTimeout(700);
  const restored = await page.evaluate(() => document.querySelector('#new-chat .rail__label').textContent.trim());
  check('and switching back to English works', restored === 'New chat', restored);

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

section('no third-party requests');
{
  // A self-hosted app that announces every page load to a CDN is not
  // self-hosted, and the Content-Security-Policy would block it anyway.
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  check('no external stylesheets', !/<link[^>]+href="https?:\/\//i.test(html));
  check('no external scripts', !/<script[^>]+src="https?:\/\//i.test(html));
  check('no font CDN preconnect', !/fonts\.(googleapis|gstatic)\.com/i.test(html));
}

section('a chosen tab scrolls itself into view');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#open-settings');
  await page.waitForTimeout(500);

  const strip = await page.evaluate(() => {
    const tabs = document.querySelector('#settings .sheet__tabs');
    return { scrolls: tabs.scrollWidth > tabs.clientWidth + 2, left: tabs.scrollLeft };
  });
  check('the tab strip is wider than the sheet', strip.scrolls, 'otherwise there is nothing to prove');
  check('and starts at the left', strip.left < 5, `${strip.left}px`);

  /** Is the tab fully inside the visible part of its strip? */
  const visible = (name) =>
    page.evaluate((tab) => {
      const strip = document.querySelector('#settings .sheet__tabs');
      const el = document.querySelector(`.tab[data-tab="${tab}"]`);
      const s = strip.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return { inside: e.left >= s.left - 1 && e.right <= s.right + 1, scrollLeft: strip.scrollLeft };
    }, name);

  // The last tab is off the right-hand edge to begin with — that is the bug.
  const beforeLast = await visible('admin');
  await page.click('.tab[data-tab="account"]');
  await page.waitForTimeout(600);
  const afterRight = await visible('account');
  check('clicking a tab near the right brings it into view', afterRight.inside, JSON.stringify(afterRight));
  check('by scrolling right', afterRight.scrollLeft > beforeLast.scrollLeft, `${beforeLast.scrollLeft} → ${afterRight.scrollLeft}`);

  // And back the other way.
  await page.click('.tab[data-tab="providers"]');
  await page.waitForTimeout(600);
  const afterLeft = await visible('providers');
  check('and going back scrolls left again', afterLeft.inside && afterLeft.scrollLeft < afterRight.scrollLeft, JSON.stringify(afterLeft));

  /**
   * Arriving at a tab because something else selected it.
   *
   * This is the case from the report: the panel changed and the tab that was now
   * lit sat outside the visible strip, so it looked as though nothing had been
   * chosen. Driven by scrolling the strip away first and then selecting a tab at
   * the other end — which is what a button that jumps to a settings tab does.
   */
  await page.evaluate(() => {
    document.querySelector('#settings .sheet__tabs').scrollLeft = 9999;
  });
  await page.waitForTimeout(200);
  const scrolledAway = await visible('providers');
  check('a tab can start off-screen', !scrolledAway.inside, JSON.stringify(scrolledAway));

  await page.click('.tab[data-tab="providers"]');
  await page.waitForTimeout(600);
  const broughtBack = await visible('providers');
  check('and selecting it brings it back into view', broughtBack.inside, JSON.stringify(broughtBack));

  /**
   * Not merely inside — centred.
   *
   * Scrolling the minimum leaves the tab you picked pinned against the edge it
   * came from, with the neighbours you might pick next still hidden behind it.
   * A tab from the middle of the strip has room to be centred; the ends stay
   * clamped, which is the other half of the rule.
   */
  const offset = (tab) =>
    page.evaluate((name) => {
      const strip = document.querySelector('#settings .sheet__tabs');
      const el = document.querySelector(`.tab[data-tab="${name}"]`);
      const s = strip.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      return {
        off: Math.round(e.left + e.width / 2 - (s.left + s.width / 2)),
        atStart: strip.scrollLeft < 2,
        atEnd: strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 2,
      };
    }, tab);

  await page.click('.tab[data-tab="skills"]');
  await page.waitForTimeout(700);
  const centred = await offset('skills');
  const clamped = centred.atStart || centred.atEnd;
  check(
    'a chosen tab is centred, or clamped when the strip is out of room',
    Math.abs(centred.off) < 24 || clamped,
    `${centred.off}px off centre${clamped ? ' (strip at its limit)' : ''}`,
  );

  await page.click('.tab[data-tab="providers"]');
  await page.waitForTimeout(700);
  const first = await offset('providers');
  check('but the first tab stays against its own edge', first.atStart, JSON.stringify(first));
}

section('the Settings tabs no longer include Computers');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#open-settings');
  await page.waitForTimeout(400);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.sheet__tabs .tab')].map((b) => b.dataset.tab));
  check('no worker tab', !tabs.includes('worker'), tabs.join(', '));
  check('no pairing sheet in the page', !(await page.$('#pair')));
  check('no "generate worker token" button', !(await page.$('#gen-worker-token')));
  await page.evaluate(() => document.getElementById('settings').close());
  await page.waitForTimeout(200);
}

section('the new-model modal');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(200);

  const shape = await page.evaluate(() => {
    const dialog = document.getElementById('model-news');
    if (!dialog) return null;
    // Fill it the way the app does, then open it and measure.
    document.getElementById('news-title').textContent = 'Claude Fictional 9';
    document.getElementById('news-vendor').textContent = 'Claude';
    document.getElementById('news-id').textContent = 'openrouter/anthropic/claude-fictional-9';
    document.getElementById('news-facts').innerHTML =
      '<dt>Made by</dt><dd>Claude</dd><dt>Released</dt><dd>1 August 2026</dd>' +
      '<dt>Context window</dt><dd>500K tokens</dd><dt>Price</dt><dd>$4 in · $20 out per 1M tokens</dd>';
    document.getElementById('news-description').textContent = 'A model invented by the test suite.';
    dialog.showModal();

    const box = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      // Centred is the whole point: a corner toast is dismissed by reflex.
      centredX: Math.abs(box.left + box.width / 2 - window.innerWidth / 2) < 3,
      centredY: Math.abs(box.top + box.height / 2 - window.innerHeight / 2) < 3,
      onScreen: box.top >= -1 && box.bottom <= window.innerHeight + 1,
      buttons: [...dialog.querySelectorAll('.news__actions button')].map((b) => b.id),
      facts: dialog.querySelectorAll('#news-facts dt').length,
      overflowX: dialog.scrollWidth - dialog.clientWidth,
    };
  });

  check('the modal exists', !!shape);
  check('it opens', shape?.open === true);
  check('centred horizontally', shape?.centredX === true);
  check('centred vertically', shape?.centredY === true);
  check('and fits on screen', shape?.onScreen === true);
  check('with exactly two answers', shape?.buttons.length === 2, (shape?.buttons || []).join(', '));
  check(
    'apply and decline',
    shape?.buttons.includes('news-apply') && shape?.buttons.includes('news-decline'),
    (shape?.buttons || []).join(', '),
  );
  check('the details are spelled out', shape?.facts >= 4, `${shape?.facts} facts`);
  check('and it does not scroll sideways', shape?.overflowX <= 1, `${shape?.overflowX}px`);

  await page.evaluate(() => document.getElementById('model-news').close());
}

section('the change-password form is reachable');
{
  const box = await page.evaluate(() => {
    const el = document.getElementById('password-block');
    return { exists: !!el, hidden: el?.hidden ?? null };
  });
  check('#password-block exists', box.exists);
  check('and is not hidden', box.hidden === false, `hidden=${box.hidden}`);
}

section('the settings sheet');
// Close whatever is open rather than pressing Escape and hoping: more than one
// dialog can be stacked, and a click on the page behind them never lands.
await page.evaluate(() => {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
});
await page.waitForTimeout(300);
await page.click('#open-settings');
await page.waitForTimeout(900);
check('the settings sheet opened', await page.evaluate(() => !!document.getElementById('settings')?.open));
section('the composer row is level');
{
  // The attach button sat visibly high in its circle. It was the character "+":
  // a glyph is centred on the font's maths axis, which is not the middle of the
  // line box, so the box was centred correctly and the ink inside it was not.
  const row = await page.evaluate(() => {
    const centre = (el) => {
      const box = el.getBoundingClientRect();
      return box.height ? box.top + box.height / 2 : null;
    };
    const attach = document.getElementById('attach');
    const send = document.getElementById('send') || document.querySelector('.icon-btn--send');
    const text = document.getElementById('input');
    return {
      drawn: !!attach.querySelector('svg'),
      noGlyph: attach.textContent.trim() === '',
      attach: centre(attach),
      send: send ? centre(send) : null,
      textCentre: centre(text),
      textHeight: text.getBoundingClientRect().height,
      attachHeight: attach.getBoundingClientRect().height,
    };
  });

  check('the plus is drawn, not typed', row.drawn && row.noGlyph, 'a text glyph cannot be centred reliably');
  check('the attach and send buttons share a centre line',
    row.send === null || Math.abs(row.attach - row.send) <= 1, `${row.attach} vs ${row.send}`);
  check('and the writing box is the same height as them',
    Math.abs(row.textHeight - row.attachHeight) <= 1, `${row.textHeight} vs ${row.attachHeight}`);
  check('so the whole row sits on one line',
    Math.abs(row.attach - row.textCentre) <= 1.5, `${row.attach} vs ${row.textCentre}`);
}

section('scrollbars are not part of the furniture');
{
  const quiet = await page.evaluate(() => {
    const thread = document.getElementById('thread');
    // The thumb is a `::-webkit-scrollbar-thumb`, so that is what has to be
    // asked. Reading `scrollbarColor` off the element tested the *other*
    // mechanism — and passed while the visible scrollbar was Chrome's own.
    const before = getComputedStyle(thread, '::-webkit-scrollbar-thumb').backgroundColor;
    thread.dispatchEvent(new Event('scroll'));
    return {
      marked: thread.classList.contains('scroll-quiet'),
      chatsMarked: document.getElementById('chat-list').classList.contains('scroll-quiet'),
      restingColour: before,
      showsWhileScrolling: thread.classList.contains('is-scrolling'),
      // Setting either standard property makes Chromium drop every
      // ::-webkit-scrollbar rule on the element and draw its own Fluent
      // scrollbar instead — steppers and all. Declaring both alongside the
      // pseudo-elements is what put arrow buttons on the transcript.
      standardPropsLeftAlone: getComputedStyle(thread).scrollbarColor === 'auto'
        && getComputedStyle(thread).scrollbarWidth === 'auto',
      steppers: getComputedStyle(thread, '::-webkit-scrollbar-button').display,
    };
  });

  check('the transcript uses the quiet scrollbar', quiet.marked);
  check('and so does the conversation list', quiet.chatsMarked);
  // Computed style resolves `transparent` to rgba(0, 0, 0, 0); both spellings
  // mean the same nothing.
  check(
    'at rest there is no grey trough',
    /transparent|rgba\(0, 0, 0, 0\)/.test(quiet.restingColour),
    quiet.restingColour,
  );
  check('it appears while you are scrolling', quiet.showsWhileScrolling);
  check('and it has no stepper arrows on it', quiet.steppers === 'none', quiet.steppers);
  check(
    'because the styled scrollbar is the one being drawn',
    quiet.standardPropsLeftAlone,
    'scrollbar-color/-width must stay `auto` in Chromium or the custom bar is discarded',
  );

  // And goes again once the scrolling stops — which is what makes it vanish at
  // the end of the transcript rather than sitting there.
  await page.waitForTimeout(900);
  const settled = await page.evaluate(() =>
    document.getElementById('thread').classList.contains('is-scrolling'));
  check('and goes when it stops', !settled);
}

/**
 * An artifact, actually running.
 *
 * Nothing else in this suite proves the feature: the server can serve the right
 * bytes with the right policy and the page can still fail to execute, which is
 * the only thing anybody cares about. So this makes one, opens it, and reads
 * back what its own script wrote into the DOM.
 */
section('artifacts');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  const made = await page.evaluate(async () => {
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { chat } = await res.json();
    return { chat: chat.id };
  });

  // Made through the tool, because that is the path a real turn takes — the
  // browser has no way to create one and should not have.
  const { executeTool } = await import('../server/tools/execute.js');
  const { initStore } = await import('../server/store/index.js');
  const store = await initStore();
  const owner = await store.getUserByEmail('ui@test.local').catch(() => null);

  if (!owner) {
    check('an account to attribute the artifact to', false, 'ui@test.local not found');
  } else {
    const page1 = [
      '<!doctype html><html><body>',
      '<h1 id="out">not run</h1>',
      `<script>document.getElementById("out").textContent = "ran " + (2 + 3);</${'script'}>`,
      '</body></html>',
    ].join('');

    // A picture the assistant made — dark lines on a transparent ground — and
    // the screenshot a browser step keeps for the assistant to look back at.
    const { createCanvas } = await import('@napi-rs/canvas');
    const drawn = createCanvas(200, 120);
    const pen = drawn.getContext('2d');
    pen.strokeStyle = '#111111';
    pen.lineWidth = 6;
    pen.strokeRect(20, 20, 160, 80);
    const pictureBytes = drawn.toBuffer('image/png');
    await store.createAttachment(owner.id, {
      id: 'shelf-picture',
      name: 'so-do.png',
      mime: 'image/png',
      kind: 'image',
      bytes: pictureBytes.length,
      data: pictureBytes.toString('base64'),
      origin: 'generated',
      chatId: made.chat,
    });
    const { keepStepShot } = await import('../server/attachments.js');
    const stepShot = await keepStepShot(owner.id, { data: pictureBytes.toString('base64'), mime: 'image/png' });

    const result = await executeTool({
      user: owner,
      chatId: made.chat,
      name: 'create_file',
      input: { name: 'thu-nghiem', format: 'html', content: page1 },
    });
    check('the assistant can make a page', result.isError === false, result.content?.slice(0, 60));

    // Open it through the shelf, which is the way somebody would find it.
    await page.click('#open-artifacts');
    await page.waitForTimeout(1200);
    const pictures = await page.evaluate((stepId) => {
      const card = document.querySelector('.card--artifact[data-file="shelf-picture"]');
      const img = /** @type {HTMLImageElement | null} */ (card?.querySelector('.card__peek--image img') || null);
      return {
        shown: !!img && img.complete && img.naturalWidth > 0,
        ground: img ? getComputedStyle(img.parentElement).backgroundColor : '',
        step: !!document.querySelector(`.card--artifact[data-file="${stepId}"]`),
        steps: [...document.querySelectorAll('.card--artifact .card__name')].filter((n) => /^step-\d+\.jpg$/.test(n.textContent || '')).length,
      };
    }, stepShot?.id || '');
    check('a picture on the shelf shows itself, not a file icon', pictures.shown, JSON.stringify(pictures));
    check('  on white, so a transparent one reads', pictures.ground === 'rgb(255, 255, 255)', pictures.ground);
    check('a step screenshot is not on the shelf', !!stepShot?.id && !pictures.step && pictures.steps === 0, JSON.stringify(pictures));

    const listed = await page.evaluate(() => ({
      open: !document.getElementById('page').hidden,
      title: document.getElementById('page-title').textContent.trim(),
      count: document.querySelectorAll('.card--artifact').length,
      first: document.querySelector('.card--artifact .card__name')?.textContent || '',
      peek: document.querySelector('.card__peek')?.textContent?.trim() || '',
    }));
    check('the shelf opens from the menu bar', listed.open && listed.title === 'Artifacts', listed.title);
    check('and lists it', listed.count >= 1 && /thu-nghiem\.html/.test(listed.first), `${listed.count}: ${listed.first}`);
    check(
      'showing a window onto what is in it',
      /doctype|html|out/i.test(listed.peek),
      'a row of identical file icons tells you nothing about which document is which',
    );

    await page.click('.card--artifact');
    await page.waitForTimeout(1200);

    const running = await page.evaluate(() => {
      const frame = document.querySelector('#viewer-body iframe');
      return {
        framed: !!frame,
        sandbox: frame?.getAttribute('sandbox') || '',
        src: frame?.getAttribute('src') || '',
        tabs: [...document.querySelectorAll('#viewer-tabs .fmode')].map((t) => t.getAttribute('aria-label')),
      };
    });
    check('it opens running, not as source', running.framed && /\/run/.test(running.src), running.src);
    check('in a sandbox with no same-origin', /allow-scripts/.test(running.sandbox) && !/allow-same-origin/.test(running.sandbox), running.sandbox);
    check('with its code one press away', running.tabs.includes('Code'), running.tabs.join(', '));

    /*
     * The proof: what the page's own script wrote.
     *
     * Waited for rather than slept on. A fixed pause read the frame before it
     * had finished loading roughly one run in three — which is worse than a
     * failing test, because a suite that fails at random teaches people to
     * re-run it until it is green and then to ignore it when it is not.
     */
    let text = null;
    for (let i = 0; i < 40 && text !== 'ran 5'; i += 1) {
      const frame = page.frames().find((f) => /\/run/.test(f.url()));
      text = frame
        ? await frame.evaluate(() => document.getElementById('out')?.textContent).catch(() => null)
        : null;
      if (text !== 'ran 5') await page.waitForTimeout(150);
    }
    check('and the script inside it actually ran', text === 'ran 5', String(text));

    await page.click('#viewer-close');
    // No dialog to close. Artifacts became a shelf — `#open-artifacts` calls
    // `gotoShelf('artifacts')`, and this section checks `#page` above — but the
    // `<dialog id="artifacts">` it replaced was left in index.html, and this
    // line went on closing it. An already-closed dialog closes silently, so the
    // line passed for as long as the dead markup survived and threw the moment
    // it was removed. Nothing here needs the shelf shut: the checks below read
    // `#settings`, and the next section opens the shelves itself.
    await page.waitForTimeout(200);
  }
}

const settingsScrollers = await page.evaluate(SCROLLERS, '#settings');
check('at most one scrolling region', settingsScrollers.length <= 1, `${settingsScrollers.length} found`);
check('nothing scrolls sideways', !settingsScrollers.some((s) => s.x));

/**
 * The shelves: Projects, Artifacts, Scheduled.
 *
 * Pages rather than dialogs, sharing one header. What this checks is that each
 * one takes the place of the conversation, draws its own tools, and comes back
 * to the transcript when you leave — the three things a page has to do that a
 * sheet did not.
 */
section('the shelves');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  for (const [rail, title, action] of [
    ['#open-projects', 'Projects', 'New project'],
    ['#open-artifacts', 'Artifacts', 'New artifact'],
    ['#open-workflows', 'Workflows', 'New workflow'],
    ['#open-scheduled', 'Scheduled tasks', 'New task'],
  ]) {
    await page.click(rail);
    await page.waitForTimeout(700);

    const shown = await page.evaluate(() => ({
      page: !document.getElementById('page').hidden,
      thread: !document.getElementById('thread').hidden,
      dock: !document.getElementById('dock').hidden,
      title: document.getElementById('page-title').textContent.trim(),
      action: document.getElementById('page-new').textContent.trim(),
      sort: document.getElementById('page-sort').textContent.replace(/\s+/g, ' ').trim(),
      serif: /serif/i.test(getComputedStyle(document.getElementById('page-title')).fontFamily),
    }));

    check(`${title} opens as a page`, shown.page && !shown.thread, JSON.stringify(shown).slice(0, 80));
    check('  with the conversation and its composer out of the way', !shown.dock);
    check('  titled', shown.title === title, shown.title);
    check('  with its own action', shown.action === action, shown.action);
    check('  and a way to order it', shown.sort.length > 0, shown.sort);
    check('  the title is the one serif in the app', shown.serif, 'a shelf is a place you arrive at');
  }

  // The empty states are what somebody sees first, so they have to say
  // something rather than being a blank rectangle.
  const empty = await page.evaluate(() => ({
    ring: !!document.querySelector('.blank__ring'),
    say: document.querySelector('.blank__say')?.textContent || '',
    ideas: document.querySelectorAll('.idea').length,
  }));
  check('an empty shelf explains itself', /No scheduled tasks/.test(empty.say), empty.say);
  check('with something to press', empty.ideas >= 3, `${empty.ideas} suggestions`);
  check('and a mark rather than a bare space', empty.ring);

  // Every suggestion has to be a thing this application can really do.
  const ideas = await page.evaluate(() =>
    [...document.querySelectorAll('.idea__name')].map((n) => n.textContent.trim()),
  );
  check(
    'the suggestions are this app\'s, not a screenshot of somebody else\'s',
    !ideas.some((name) => /inbox|calendar|meeting/i.test(name)),
    ideas.join(', '),
  );

  // Manual setup opens the form from the screenshot.
  await page.click('#page-new');
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => ({
    open: !document.getElementById('page-new-menu').hidden,
    items: [...document.querySelectorAll('#page-new-menu button')].map((b) => b.textContent.trim()),
  }));
  check('New task offers both ways in', menu.open && menu.items.length === 2, menu.items.join(' / '));

  await page.click('#page-new-menu button:last-child');
  await page.waitForTimeout(500);
  const form = await page.evaluate(() => ({
    open: document.getElementById('task-form').open,
    // `when` is gone: a time typed in words is precise, learnable, and
    // something most people get wrong once and then avoid. The frequency and
    // the permissions are menus now, and each says what it does at 3am.
    fields: ['task-form-name', 'task-form-prompt', 'task-form-repeat', 'task-form-policy'].every((id) =>
      document.getElementById(id),
    ),
    gone: !document.getElementById('task-form-when'),
    frequencies: [...document.querySelectorAll('#task-form-repeat option')].map((o) => o.value),
    policies: [...document.querySelectorAll('#task-form-policy option')].map((o) => o.value),
    // Manual to begin with: the one choice that cannot surprise somebody at
    // three in the morning.
    starts: document.getElementById('task-form-repeat').value,
    says: document.getElementById('task-form-freq-say').textContent.trim(),
  }));
  check('and the form opens with what it needs', form.open && form.fields);
  check('the written time field is gone', form.gone);
  check(
    'six frequencies, manual among them',
    JSON.stringify(form.frequencies) === JSON.stringify(['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly']),
    form.frequencies.join(','),
  );
  check(
    'and three things a run may be allowed to do',
    JSON.stringify(form.policies) === JSON.stringify(['ask', 'guarded', 'auto']),
    form.policies.join(','),
  );
  check('it starts manual', form.starts === 'manual', form.starts);
  check('and says what that means', /Run now/.test(form.says), form.says);
  await page.evaluate(() => document.getElementById('task-form').close());

  // A suggestion fills the form in rather than making an empty one.
  await page.click('.idea');
  await page.waitForTimeout(500);
  const filled = await page.evaluate(() => ({
    name: document.getElementById('task-form-name').value,
    prompt: document.getElementById('task-form-prompt').value.length,
  }));
  check('a suggestion arrives filled in', filled.name.length > 0 && filled.prompt > 40, `${filled.name}, ${filled.prompt} chars`);
  await page.evaluate(() => document.getElementById('task-form').close());

  // Changing a task happens in the panel beside the list, not in that form.
  await page.evaluate(() =>
    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pencil check', prompt: 'Say hello.', frequency: 'manual' }),
    }),
  );
  await page.click('#open-scheduled');
  await page.waitForTimeout(900);
  // Start with the side area closed: that is where one close used to take two.
  const sideWasOpen = await page.evaluate(() => {
    const open = document.getElementById('app').classList.contains('is-detail');
    if (open) document.getElementById('detail-close').click();
    return open;
  });
  await page.click('.task__edit');
  await page.waitForTimeout(900);
  const edit = await page.evaluate(() => ({
    pane: !document.getElementById('taskpane').hidden,
    title: document.getElementById('taskpane-title').textContent.trim(),
    modal: document.getElementById('task-form').open,
    pencil: !!document.getElementById('taskpane-edit'),
  }));
  check('a task\'s pencil opens the side panel', edit.pane && edit.title === 'Pencil check', JSON.stringify(edit));
  check('  not the form', !edit.modal);
  check('  and the panel has no pencil of its own — every field is edited in place', !edit.pencil);
  await page.click('#taskpane-close');
  await page.waitForTimeout(300);
  check(
    'one close puts the side area back — the plan does not appear behind it',
    await page.evaluate(() => !document.getElementById('app').classList.contains('is-detail')),
  );
  // Left as found, for the sections after this one.
  if (sideWasOpen) await page.click('#detail-toggle');

  // And back to the conversation.
  await page.click('#new-chat');
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({
    page: !document.getElementById('page').hidden,
    thread: !document.getElementById('thread').hidden,
  }));
  check('starting a chat leaves the shelf', !back.page && back.thread, JSON.stringify(back));
  // Context is what a conversation used; a blank one has used nothing.
  check('a blank chat lists no context', !(await page.$('#rail-extra [data-rail="context"]')));
}

/**
 * Searching a shelf, and the ⋮ on one of its cards.
 *
 * The search bug was two affordances at once: a round magnifier with nothing
 * left to do, sitting beside a box that read as a second, different search.
 * Pressing the icon has to *become* the field and clearing has to give it back.
 */
section('a workflow shows the state of every step');
{
  /*
   * The reason this screen exists. A scheduled task reports one status line for
   * a job with four parts, so "it didn't arrive" has no answer; a workflow has
   * to name the step that stopped. Checked in the real DOM because the whole
   * value is in what is on screen.
   */
  const made = await page.evaluate(async () => {
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Monday sales pack',
        steps: ['Pull last week numbers', 'Chart them', 'Email the team'],
      }),
    });
    return { status: res.status, body: await res.json() };
  });
  check('a workflow can be created', made.status === 201, `${made.status}`);

  await page.click('#open-workflows');
  await page.waitForTimeout(700);

  const shelf = await page.evaluate(() => {
    const card = document.querySelector('.wf');
    const steps = [...document.querySelectorAll('.wf__step')];
    return {
      cards: document.querySelectorAll('.wf').length,
      name: card?.querySelector('.wf__name')?.textContent.trim() || '',
      when: card?.querySelector('.wf__when')?.textContent.replace(/\s+/g, ' ').trim() || '',
      steps: steps.length,
      first: steps[0]?.querySelector('.wf__step-text')?.textContent.replace(/\s+/g, ' ').trim() || '',
      marks: steps.every((s) => (s.querySelector('.wf__step-mark')?.textContent || '').trim().length > 0),
      words: steps.every((s) => /waiting|running|done|failed|interrupted/.test(s.textContent)),
      acts: [...(card?.querySelectorAll('.wf__acts button') || [])].map((b) => b.textContent.trim()),
    };
  });

  check('the shelf shows it', shelf.cards === 1, `${shelf.cards} cards`);
  check('  named', shelf.name === 'Monday sales pack', shelf.name);
  check('  and says it runs on demand', /press it/.test(shelf.when), shelf.when);
  check('  every step is drawn', shelf.steps === 3, `${shelf.steps}`);
  check('  in the order they were written', /Pull last week numbers/.test(shelf.first), shelf.first);
  // Colour alone would leave the state unreadable to anyone who cannot separate
  // the red one from the green one, so each step carries a mark and a word.
  check('  each carries a mark, not only a colour', shelf.marks);
  check('  and says its state in words', shelf.words);
  // The same buttons as a scheduled task: pause, delete, and a pencil.
  check('  with the same actions as a scheduled task', shelf.acts.includes('Pause') && shelf.acts.includes('Remove') && shelf.acts.includes('✎'), shelf.acts.join(','));

  await page.click('.wf .task__edit');
  await page.waitForTimeout(900);
  const pane = await page.evaluate(() => ({
    open: !document.getElementById('taskpane').hidden,
    title: document.getElementById('taskpane-title').textContent.trim(),
    steps: /** @type {HTMLTextAreaElement} */ (document.querySelector('#taskpane-body [data-s="steps"]'))?.value || '',
    run: !!document.querySelector('#taskpane-body [data-s="run"]'),
    sheet: !!document.getElementById('workflow-form')?.open,
  }));
  check('the pencil opens the side panel', pane.open && pane.title === 'Monday sales pack', JSON.stringify(pane).slice(0, 80));
  check('  not a sheet over the page', !pane.sheet);
  check('  with the steps editable in place, one per line', pane.steps.split('\n').length === 3, JSON.stringify(pane.steps));
  check('  and Run now there, as for a task', pane.run);

  await page.click('#taskpane-close');
}

section('a shelf is searched from one field, not two');
{
  await page.click('#open-projects');
  await page.waitForTimeout(800);

  const shut = await page.evaluate(() => ({
    icon: !document.getElementById('page-search-open').hidden,
    field: !document.getElementById('page-search-box').hidden,
  }));
  check('the magnifier is what you see first', shut.icon && !shut.field, JSON.stringify(shut));

  await page.click('#page-search-open');
  await page.waitForTimeout(300);
  const openState = await page.evaluate(() => {
    const box = document.getElementById('page-search-box');
    const at = box.getBoundingClientRect();
    return {
      icon: !document.getElementById('page-search-open').hidden,
      field: !box.hidden,
      focused: document.activeElement === document.getElementById('page-search'),
      mark: !!box.querySelector('.find__mark'),
      clear: !!box.querySelector('.find__clear'),
      // Inside the row, not overflowing it — the misalignment in the report.
      inside: at.right <= document.getElementById('page').getBoundingClientRect().right + 1,
      placeholder: document.getElementById('page-search').placeholder,
    };
  });
  check('pressing it replaces it with the field', openState.field && !openState.icon, JSON.stringify(openState));
  check('  which is already focused', openState.focused);
  check('  carries the magnifier inside it', openState.mark);
  check('  and a way to clear it', openState.clear);
  check('  sits inside the header row', openState.inside);
  check('  and says what it searches', /projects/i.test(openState.placeholder), openState.placeholder);

  await page.fill('#page-search', 'zzzz-nothing-matches');
  await page.waitForTimeout(300);
  check(
    'typing filters the shelf',
    /No project matches/.test(await page.evaluate(() => document.getElementById('page-body').textContent)),
  );

  await page.click('#page-search-clear');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({
    icon: !document.getElementById('page-search-open').hidden,
    field: !document.getElementById('page-search-box').hidden,
    cards: document.querySelectorAll('[data-project]').length,
  }));
  check('clearing gives the magnifier back', closed.icon && !closed.field, JSON.stringify(closed));
  check('and the shelf with it', closed.cards >= 1, `${closed.cards} cards`);

  // The ⋮ on a card. Hidden until the card is under the pointer, because a menu
  // button on every card is furniture on a shelf made for scanning.
  const resting = await page.evaluate(() => {
    const more = document.querySelector('[data-more]');
    return { exists: !!more, colour: getComputedStyle(more).color };
  });
  check('every card carries a ⋮', resting.exists);
  check('  invisible until wanted', /rgba\(0, 0, 0, 0\)|transparent/.test(resting.colour), resting.colour);

  await page.hover('[data-project]');
  await page.waitForTimeout(200);
  const hovered = await page.evaluate(() => getComputedStyle(document.querySelector('[data-more]')).color);
  check('  and there on hover', !/rgba\(0, 0, 0, 0\)|transparent/.test(hovered), hovered);

  await page.click('[data-more]');
  await page.waitForTimeout(300);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.cardmenu button')].map((b) => b.dataset.label),
  );
  // Pinning is what puts a project in the sidebar, and this one was pinned at
  // the top of the suite so the sidebar checks have something to find — so the
  // menu offers the way back out. Either word proves the toggle is on the menu.
  check('it offers the pin toggle', items.includes('Pin') || items.includes('Unpin'), items.join(' / '));
  check('  Edit details', items.includes('Edit details'));
  check('  Archive', items.includes('Archive'));
  check('  and Delete', items.includes('Delete'));
  check(
    '  with Delete set apart',
    await page.evaluate(() => !!document.querySelector('.cardmenu button.is-danger') && !!document.querySelector('.cardmenu hr')),
  );
  check(
    '  and the menu clear of its card',
    await page.evaluate(() => getComputedStyle(document.querySelector('.cardmenu')).position === 'fixed'),
    'absolute inside a card gets clipped by it',
  );

  /**
   * Pinning, and what a pin is for: first place, whatever the ordering — and
   * now also a row in the sidebar.
   *
   * This project arrives already pinned, because the sidebar checks earlier in
   * the suite need it there. So the toggle is exercised from where it actually
   * is: off, then on again. Both directions, which is more than this covered
   * before.
   */
  await page.click('.cardmenu [data-label="Unpin"]');
  await page.waitForTimeout(900);
  check(
    'unpinning clears the mark',
    await page.evaluate(() => !document.querySelector('.card__pin')),
  );

  await page.hover('[data-project]');
  await page.click('[data-more]');
  await page.waitForTimeout(300);
  await page.click('.cardmenu [data-label="Pin"]');
  await page.waitForTimeout(900);
  check(
    'pinning marks the card',
    await page.evaluate(() => !!document.querySelector('.card__pin')),
  );
  check(
    'and pins it to the front',
    await page.evaluate(
      () => document.querySelectorAll('[data-project]')[0]?.querySelector('.card__pin') !== null,
    ),
  );

  // Archiving takes it off this shelf and puts it on the other one.
  const before = await page.evaluate(() => document.querySelectorAll('[data-project]').length);
  await page.hover('[data-project]');
  await page.click('[data-more]');
  await page.waitForTimeout(300);
  await page.click('.cardmenu [data-label="Archive"]');
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => document.querySelectorAll('[data-project]').length);
  check('archiving takes it off the shelf', after === before - 1, `${before} → ${after}`);

  await page.click('#page-sort');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    [...document.querySelectorAll('#page-sort-menu button')].find((b) => /Archived/.test(b.textContent)).click();
  });
  await page.waitForTimeout(900);
  const archived = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-project]').length,
    pill: document.getElementById('page-sort').textContent.replace(/\s+/g, ' ').trim(),
  }));
  check('and onto the archived one', archived.cards === 1, `${archived.cards}`);
  check('  which says so rather than "Sort by Archived"', archived.pill === 'Archived', archived.pill);

  // Put it back, so the rest of the run sees the shelf it expects.
  await page.hover('[data-project]');
  await page.click('[data-more]');
  await page.waitForTimeout(300);
  await page.click('.cardmenu [data-label="Restore"]');
  await page.waitForTimeout(900);
  check(
    'an archived project can come back',
    await page.evaluate(() => document.querySelectorAll('[data-project]').length === 0),
    'it left the archived shelf',
  );
}

/**
 * The Archive shelf, which took the Workspace slot in the sidebar.
 *
 * "Archived. It is out of the list, not deleted" used to be a promise with no
 * place to keep it — nothing listed an archived conversation again. What this
 * proves is the round trip: archive from the menu, find it on the shelf, and
 * Restore puts it back in the sidebar.
 */
section('the Archive shelf');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  check('the sidebar has Archive where Workspace was', !!(await page.$('#open-archive')) && !(await page.$('#open-workspace')));

  const made = await page.evaluate(async () => {
    const post = async (url, body, method = 'POST') =>
      (await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const { chat } = await post('/api/chats', {});
    await post(`/api/chats/${chat.id}`, { title: 'Ôn thi chương 1' }, 'PATCH');
    await post(`/api/chats/${chat.id}`, { archived: true }, 'PATCH');
    return chat.id;
  });

  await page.click('#open-archive');
  await page.waitForTimeout(900);
  const shelf = await page.evaluate((id) => ({
    title: document.getElementById('page-title').textContent,
    row: !!document.querySelector(`[data-archived="${id}"]`),
    newHidden: document.getElementById('page-new').hidden,
  }), made);
  check('it opens as a shelf', /Archive|Lưu trữ/.test(shelf.title), shelf.title);
  check('listing the archived conversation', shelf.row);
  check('with no New button — nothing is made here', shelf.newHidden);

  // Pressing anywhere on the card opens the conversation; the title is not a
  // grey button of its own.
  check('the title is plain text, not a button', await page.evaluate((id) => !document.querySelector(`[data-archived="${id}"] .task__name`)?.closest('button'), made));
  await page.click(`[data-archived="${made}"] .task__when`);
  await page.waitForTimeout(900);
  const opened = await page.evaluate(() => ({
    onPage: !document.getElementById('page').hidden,
    title: document.getElementById('chat-title').textContent,
  }));
  check('pressing the card opens the conversation', !opened.onPage && /Ôn thi chương 1/.test(opened.title), JSON.stringify(opened));
  await page.click('#open-archive');
  await page.waitForTimeout(900);

  await page.click(`[data-restore="${made}"]`);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(async (id) => ({
    onShelf: !!document.querySelector(`[data-archived="${id}"]`),
    // An empty conversation is never listed in the sidebar, so ask the chat itself.
    listed: (await (await fetch(`/api/chats/${id}`)).json()).chat?.archived_at === null,
  }), made);
  check('Restore takes it off the shelf', !after.onShelf);
  check('and it is no longer archived', after.listed);
}

section('the sandbox, full screen');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    document.getElementById('screen').hidden = false;
    // The screen lives in the panel, so the panel is opened here on purpose.
    // It used to be left open as a side effect of an earlier file preview;
    // closing a preview now hands the panel back shut if it was shut.
    if (!document.getElementById('app').classList.contains('is-detail')) document.getElementById('detail-toggle').click();
  });
  await page.waitForTimeout(200);

  await page.click('#screen-expand');
  await page.waitForTimeout(400);

  const full = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    const box = panel.getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const middle = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    // Whatever is drawn where the sidebar sits: the panel, or the sidebar
    // through it.
    const overSidebar = sidebar
      ? document.elementFromPoint(sidebar.left + sidebar.width / 2, sidebar.top + sidebar.height / 2)
      : null;
    return {
      parent: panel.parentElement?.tagName,
      covers: box.width === window.innerWidth && box.height === window.innerHeight,
      onTopInMiddle: !!middle && panel.contains(middle),
      onTopOverSidebar: !!overSidebar && panel.contains(overSidebar),
    };
  });

  check('it leaves the rail it normally lives in', full.parent === 'BODY', full.parent);
  check('and covers the whole window', full.covers);
  check('nothing is drawn over the middle of it', full.onTopInMiddle);
  check('not even the sidebar', full.onTopOverSidebar, 'the bug: the rail is a stacking context, so z-index lost');

  // And back, into exactly the place it came from.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => {
    const panel = document.getElementById('screen');
    return {
      parent: panel.parentElement?.className || '',
      expanded: panel.classList.contains('is-expanded'),
    };
  });
  check('Escape brings it back', !back.expanded);
  check('to the rail it came from', /detail__body/.test(back.parent), back.parent);

  await page.evaluate(() => {
    document.getElementById('screen').hidden = true;
  });
}

/**
 * Opening a document without leaving the conversation.
 *
 * The thing being proved is that a Word file and a spreadsheet — neither of
 * which a browser can render — arrive on screen as a page and as a grid. The
 * files are built here rather than kept as fixtures, so the writer and the
 * reader are both under test and nobody has to diff a binary.
 */
section('the file viewer');
{
  const { writeDocx } = await import('../server/office/docx.js');
  const { writeXlsx } = await import('../server/office/xlsx.js');
  const { markdownToBlocks } = await import('../server/office/markdown.js');
  const { MIME_FOR } = await import('../server/office/index.js');

  const docx = writeDocx({
    blocks: markdownToBlocks('# Biên bản họp\n\nNội dung **quan trọng**.\n\n- Điểm một\n- Điểm hai'),
    title: 'Biên bản',
  }).toString('base64');
  const xlsx = writeXlsx({
    sheets: [{ name: 'Chi phí', rows: [['Hạng mục', 'Số tiền'], ['Vận chuyển', 1250000]] }],
  }).toString('base64');

  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  // Straight through the API: the composer's file picker cannot be driven
  // without a real file on disk, and what is being tested is downstream of it.
  const made = await page.evaluate(
    async ([word, sheet, wordMime, sheetMime]) => {
      const post = async (url, body) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return res.json();
      };
      const a = await post('/api/attachments', { name: 'bien-ban.docx', mime: wordMime, data: word });
      const b = await post('/api/attachments', { name: 'chi-phi.xlsx', mime: sheetMime, data: sheet });
      const { chat } = await post('/api/chats', {});
      await post(`/api/chats/${chat.id}/messages`, {
        text: 'xem giúp hai file này',
        attachments: [a.attachment.id, b.attachment.id],
      });
      return { chat: chat.id, kinds: [a.attachment.kind, b.attachment.kind] };
    },
    [docx, xlsx, MIME_FOR.docx, MIME_FOR.xlsx],
  );
  check('both files upload as office documents', made.kinds.join(',') === 'office,office', made.kinds.join(','));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  // By id rather than "the first row": projects are listed above the loose
  // conversations now, so the first one is whichever happens to sort there.
  await page.click(`.chat-row[data-chat="${made.chat}"]`);
  await page.waitForTimeout(700);

  const chips = await page.$$('.msg__files .stage');
  check('each file is a tile, as it was waiting to be sent', chips.length === 2, `${chips.length} found`);
  const placed = await page.evaluate(() => {
    const tile = document.querySelector('.msg__files .stage');
    return {
      button: tile?.tagName === 'BUTTON',
      outsideBubble: !tile?.closest('.bubble'),
      named: tile?.querySelector('.stage__name')?.textContent,
      type: tile?.querySelector('.stage__type')?.textContent,
      size: /\d+\s?(B|KB|MB)\b/.test(document.querySelector('.msg__files')?.textContent || ''),
    };
  });
  check('  above the bubble, not inside it', placed.outsideBubble, JSON.stringify(placed));
  check('  named, with its type and no size', placed.named === 'bien-ban.docx' && placed.type === 'DOCX' && !placed.size, JSON.stringify(placed));
  check('and the tiles are buttons, because they open', placed.button);

  // What the panel was doing before the file borrowed it, to check it is
  // handed back the same way.
  const railWas = await page.evaluate(() => document.getElementById('app').classList.contains('is-detail'));
  await chips[0].click();
  await page.waitForTimeout(900);
  const covered = await page.evaluate(() => {
    const extra = document.getElementById('rail-extra');
    return { outputsHidden: !extra || !extra.getClientRects().length };
  });
  check('the file sits over the Outputs and Context lists, not under them', covered.outputsHidden, JSON.stringify(covered));
  const word = await page.evaluate(() => {
    const pane = document.getElementById('filepane');
    const box = pane.getBoundingClientRect();
    const thread = document.getElementById('thread').getBoundingClientRect();
    return {
      open: !pane.hidden,
      // Beside the conversation, not over it: the whole point of the change.
      besideIt: box.left >= thread.right - 2 && thread.width > 100,
      railOpen: document.getElementById('app').classList.contains('is-detail'),
      planHidden: !document.querySelector('#progress-steps')?.getClientRects().length,
      title: document.getElementById('viewer-title').textContent,
      kind: document.getElementById('viewer-kind').textContent,
      heading: document.querySelector('#viewer-body .doc h1')?.textContent || '',
      bold: !!document.querySelector('#viewer-body .doc strong'),
      items: document.querySelectorAll('#viewer-body .doc li').length,
    };
  });
  check('clicking one opens the panel', word.open);
  check('beside the conversation, not over it', word.besideIt, JSON.stringify(word).slice(0, 110));
  check('opening the rail if it was shut', word.railOpen);
  check('and standing the plan down while it is there', word.planHidden, 'two things in a 380px column is neither');
  check('titled with the filename', word.title === 'bien-ban.docx', word.title);
  check('with what it is beside the name', /DOCX/.test(word.kind), word.kind);
  check('the Word document is drawn as a page', word.heading === 'Biên bản họp', word.heading);
  check('with its formatting', word.bold && word.items === 2, `${word.items} list items`);

  // Full size, and the bug that made it worth testing: the rail has a
  // transform, so a `fixed` child of it is positioned against the rail rather
  // than the window and drew underneath the sidebar.
  await page.click('#viewer-expand');
  await page.waitForTimeout(300);
  const full = await page.evaluate(() => {
    const pane = document.getElementById('filepane');
    const box = pane.getBoundingClientRect();
    const mid = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return {
      parent: pane.parentElement.tagName,
      covers: box.width >= window.innerWidth - 1 && box.height >= window.innerHeight - 1,
      onTop: pane.contains(mid),
      overSidebar: pane.contains(document.elementFromPoint(40, window.innerHeight / 2)),
    };
  });
  check('⤢ gives it the whole window', full.covers, JSON.stringify(full));
  check('  by leaving the rail it lives in', full.parent === 'BODY');
  check('  with nothing drawn over it', full.onTop);
  check('  not even the sidebar', full.overSidebar, 'the rail is a stacking context, so z-index alone loses');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(
    'Escape brings it back to the rail',
    await page.evaluate(() => {
      const pane = document.getElementById('filepane');
      return !pane.hidden && pane.parentElement.tagName !== 'BODY';
    }),
  );

  await page.click('#viewer-close');
  await page.waitForTimeout(300);
  check(
    'closing it lets go of the document',
    await page.evaluate(
      () =>
        document.getElementById('filepane').hidden &&
        document.getElementById('viewer-body').children.length === 0,
    ),
  );
  check(
    'and gives the rail back to the plan',
    await page.evaluate(() => !document.getElementById('app').classList.contains('is-filepane')),
  );
  check(
    '  as it was found: shut if it was shut, open on the progress if it was open',
    (await page.evaluate(() => document.getElementById('app').classList.contains('is-detail'))) === railWas,
    `was ${railWas}`,
  );

  // And the other way round: open the panel first, then a file, then close it.
  await page.evaluate(() => {
    if (!document.getElementById('app').classList.contains('is-detail')) document.getElementById('detail-toggle').click();
  });
  (await page.$$('.msg__files .stage'))[0].click();
  await page.waitForTimeout(700);
  await page.click('#viewer-close');
  await page.waitForTimeout(300);
  check(
    'with the panel open beforehand, closing the file leaves it open on the progress',
    await page.evaluate(() => {
      const app = document.getElementById('app');
      return app.classList.contains('is-detail') && !app.classList.contains('is-filepane') && !!document.querySelector('.detail__head')?.getClientRects().length;
    }),
  );

  (await page.$$('.msg__files .stage'))[1].click();
  await page.waitForTimeout(900);
  const sheet = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#viewer-body .grid td')].map((td) => td.textContent);
    return {
      grid: !!document.querySelector('#viewer-body .grid'),
      columns: [...document.querySelectorAll('#viewer-body .grid thead th')].map((th) => th.textContent),
      cells,
      numberAligned: !!document.querySelector('#viewer-body .grid td.is-number'),
      action: document.getElementById('viewer-do').textContent.trim(),
    };
  });
  check('a spreadsheet is drawn as a grid', sheet.grid);
  check('with column letters', sheet.columns.join('') === 'AB', sheet.columns.join(''));
  check('the values in it', sheet.cells.includes('Vận chuyển') && sheet.cells.includes('1250000'), sheet.cells.join('|'));
  check('numbers set apart from text', sheet.numberAligned);

  /**
   * The one button, and the arrow beside it.
   *
   * What the button says depends on the machine on the other end: this app runs
   * its worker tools in-process when it is a local install, so on a desktop
   * with Excel installed the button really does say "Open in Excel" — resolved
   * from the file association, not guessed from the extension.
   *
   * The check is that the button and the machine agree. Asserting a fixed
   * label would only prove which software the test runner happens to have.
   */
  const opener = await page.evaluate(async () => {
    // The id from the chip that was just clicked. /api/files lists what the
    // assistant made, and these two were uploaded.
    const id = [...document.querySelectorAll('.msg__files .stage')][1].dataset.file;
    return (await fetch(`/api/attachments/${id}/opener`)).json();
  });
  check(
    'the button offers what this machine can actually do',
    opener.launchable ? /^Open/.test(sheet.action) : sheet.action === 'Download',
    `${sheet.action} — launchable: ${opener.launchable}, app: ${opener.app}`,
  );
  check(
    '  naming the application when it can be resolved',
    !opener.app || sheet.action === `Open in ${opener.app}`,
    sheet.action,
  );

  await page.click('#viewer-more');
  await page.waitForTimeout(300);
  const more = await page.evaluate(() =>
    [...document.querySelectorAll('.cardmenu button')].map((b) => b.dataset.label),
  );
  check('and something to print, which is how a PDF gets made', more.some((l) => /Print/.test(l)), more.join(' / '));
  check('  a way to reveal it on the disk', more.includes('Show in folder'), more.join(' / '));
  check('  and the download it is no longer leading with', more.includes('Download'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const scrollers = await page.evaluate(SCROLLERS, '#filepane');
  check('one scrolling region inside the viewer', scrollers.length <= 1, `${scrollers.length} found`);

  /**
   * What a print — and therefore a Save as PDF — actually contains.
   *
   * There is no PDF writer on the server, so this is the road to one, and it is
   * only a road if the page that comes out is the document rather than the
   * application around it. Checked by emulating print media, which is as close
   * as a test can get to the print dialog.
   */
  // Printing expands the panel first, because the print rules isolate a child
  // of <body> and the panel normally lives three levels down in the rail.
  await page.evaluate(() => {
    document.getElementById('viewer-expand').click();
    document.body.classList.add('is-printing');
  });
  // The dark theme, where the bug was: its text colours are near-white.
  await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
  await page.waitForTimeout(200);
  const printed = await page.evaluate(() => {
    // Asked as "is it laid out", not "what is its display" — a computed style
    // is the element's own, and reports `flex` quite happily from inside an
    // ancestor that is `display: none`.
    const shown = (selector) => {
      const el = document.querySelector(selector);
      return !!el && el.getClientRects().length > 0;
    };
    return {
      document: shown('#viewer-body'),
      sidebar: shown('.sidebar'),
      composer: shown('.composer'),
      chrome: shown('#filepane .filepane__bar'),
      background: getComputedStyle(document.getElementById('filepane')).backgroundColor,
      // The colour of the words themselves. White text on white paper printed
      // a 37-page document that looked blank in the preview.
      ink: [...document.querySelectorAll('#viewer-body h1, #viewer-body h2, #viewer-body p, #viewer-body td, #viewer-body li')]
        .slice(0, 6)
        .map((node) => getComputedStyle(node).color),
    };
  });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => document.body.classList.remove('is-printing'));

  check('printing keeps the document', printed.document);
  check('and leaves the app behind', !printed.sidebar && !printed.composer, JSON.stringify(printed));
  check('including the viewer\'s own buttons', !printed.chrome);
  check('on white, not on the dark theme', /255, 255, 255/.test(printed.background), printed.background);
  const dark = (rgb) => {
    const [r, g, b] = (rgb.match(/\d+/g) || []).map(Number);
    return r + g + b < 3 * 110;
  };
  check('in dark ink, so the words show on paper', printed.ink.length > 0 && printed.ink.every(dark), printed.ink.join(' | '));

  /**
   * The bug that made Save as PDF useless: page one and nothing else.
   *
   * An expanded panel is `position: fixed` with `height: 100dvh` — pinned to
   * the viewport, and a viewport is one page. Everything after the first
   * screenful was silently dropped, and every `overflow` in the chain clipped
   * whatever was left. Measured rather than eyeballed: the panel must be
   * static, and it must be as tall as its contents.
   */
  await page.evaluate(() => document.body.classList.add('is-printing'));
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(200);
  const layout = await page.evaluate(() => {
    const pane = document.getElementById('filepane');
    const body = document.getElementById('viewer-body');
    const style = getComputedStyle(pane);
    return {
      position: style.position,
      overflow: getComputedStyle(body).overflowY,
      // How tall the panel is against how tall its contents are. Clipped to the
      // window, the first is a screenful and the second is the document.
      paneHeight: Math.round(pane.getBoundingClientRect().height),
      contentHeight: body.scrollHeight,
      viewport: window.innerHeight,
    };
  });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => document.body.classList.remove('is-printing'));

  /*
   * Save as PDF, end to end: the button builds a clean copy of the document in
   * a frame of its own and prints that. The report was a 37-page preview with
   * nothing on any page, from printing the live app; here the copy the button
   * prints is put through Chrome's real PDF pipeline and its words read back.
   */
  {
    await page.evaluate(() => document.body.classList.remove('is-printing'));
    await page.emulateMedia({ media: 'screen' });
    const screenText = (await page.evaluate(() => document.getElementById('viewer-body').innerText)).replace(/\s+/g, ' ').trim();
    await page.evaluate(() => {
      window.__printCopy = null;
      new window.MutationObserver((changes, observer) => {
        for (const change of changes) {
          for (const node of change.addedNodes) {
            if (node.tagName === 'IFRAME' && node.srcdoc) {
              window.__printCopy = node.srcdoc;
              observer.disconnect();
            }
          }
        }
      }).observe(document.body, { childList: true });
    });
    // A menu left open by the check before would be closed by this click.
    if (!(await page.isVisible('[data-label="Save as PDF"]'))) await page.click('#viewer-more');
    await page.waitForSelector('[data-label="Save as PDF"]', { state: 'visible', timeout: 5000 });
    await page.click('[data-label="Save as PDF"]');
    await page.waitForTimeout(800);
    const copy = await page.evaluate(() => window.__printCopy);
    check('Save as PDF builds a copy of just the document', !!copy && !/class="sidebar|id="app"/.test(copy), copy ? `${copy.length} chars` : 'no copy');
    const titled = /<title>([^<]*)<\/title>/.exec(copy || '')?.[1] || '';
    check('  named after the file, which is what the PDF is called', titled.length > 0 && !/Synapsez/.test(titled), titled);

    let pdfText = '';
    if (copy) {
      const paperContext = await browser.newContext();
      const paper = await paperContext.newPage();
      await paper.setContent(copy);
      const pdf = await paper.pdf({ format: 'A4' });
      await paperContext.close();
      const { extractPdfText } = await import('../server/pdf.js');
      pdfText = ((await extractPdfText(pdf))?.text || '').replace(/\s+/g, ' ').trim();
    }
    const sample = screenText.split(' ').filter((w) => w.length > 4).slice(0, 4);
    check(
      '  and the PDF carries the document\'s words',
      sample.length > 0 && sample.every((w) => pdfText.includes(w)),
      `looked for ${sample.join(', ')} in "${pdfText.slice(0, 120)}"`,
    );
  }

  check('the panel is not pinned to one screen', layout.position === 'static', layout.position);
  check('  nor clipping what did not fit', layout.overflow === 'visible', layout.overflow);
  check(
    '  so every page of a long document prints',
    layout.paneHeight >= layout.contentHeight - 4,
    `panel ${layout.paneHeight}px vs content ${layout.contentHeight}px (window ${layout.viewport}px)`,
  );

  await page.click('#viewer-close');
  await page.waitForTimeout(200);

  // Editing the words leaves the files where they were: they were never part of
  // the sentence, and the server keeps them on the message.
  const sent = '.msg--user:has(.msg__files)';
  await page.hover(sent);
  await page.click(`${sent} [data-act="edit"]`);
  await page.waitForTimeout(300);
  const whileEditing = await page.evaluate((sel) => document.querySelectorAll(`${sel} .msg__files .stage`).length, sent);
  check('while the words are edited, the files stay on screen', whileEditing === 2, `${whileEditing} tiles`);
  await page.fill(`${sent} .bubble__edit`, 'xem giúp hai file này, kỹ hơn');
  await page.click(`${sent} [data-edit="save"]`);
  await page.waitForTimeout(1500);
  const afterEdit = await page.evaluate(async (chatId) => {
    const full = await (await fetch(`/api/chats/${chatId}`)).json();
    const user = full.messages.find((m) => m.role === 'user');
    return {
      tiles: document.querySelectorAll('.msg--user .msg__files .stage').length,
      stored: (user?.attachments || []).length,
      text: user?.text,
    };
  }, made.chat);
  check('  and after saving, on screen and on the message', afterEdit.tiles === 2 && afterEdit.stored === 2 && /kỹ hơn/.test(afterEdit.text || ''), JSON.stringify(afterEdit));
}

/**
 * A document the assistant makes opens itself.
 *
 * The rules that decide it are unit-tested in test/autopreview.test.mjs, where
 * they can be stated one at a time. What only a browser can show is that the
 * setting is really on the page, really saved, and really read back — and that
 * the wiring between the stream and the panel has not been quietly removed,
 * which is checked against the source rather than by faking a model turn.
 */
section('a new document opens itself');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });

  await page.click('#open-settings');
  await page.waitForTimeout(500);

  const setting = await page.evaluate(() => {
    const el = document.getElementById('auto-preview');
    return {
      there: !!el,
      value: el?.value,
      options: [...(el?.options || [])].map((o) => o.value),
      label: document.querySelector('label[for="auto-preview"]')?.textContent?.trim(),
    };
  });
  check('there is a setting for it', setting.there);
  check('  on by default', setting.value === 'on', setting.value);
  check('  with a way to turn it off', setting.options.join(',') === 'on,off', setting.options.join(','));
  check('  named for what it governs', /document/i.test(setting.label || ''), setting.label);

  const off = await page.evaluate(async () => {
    document.getElementById('auto-preview').value = 'off';
    document.getElementById('save-behaviour').click();
    await new Promise((r) => setTimeout(r, 800));
    return (await (await fetch('/api/bootstrap')).json()).prefs.autoPreview;
  });
  check('  turning it off is saved to the account', off === false, String(off));

  const on = await page.evaluate(async () => {
    document.getElementById('auto-preview').value = 'on';
    document.getElementById('save-behaviour').click();
    await new Promise((r) => setTimeout(r, 800));
    return (await (await fetch('/api/bootstrap')).json()).prefs.autoPreview;
  });
  check('  and turning it back on is too', on === true, String(on));

  await page.evaluate(() => document.getElementById('settings').close());
  await page.waitForTimeout(200);

  /**
   * The wiring, read rather than driven.
   *
   * Driving it would mean standing up a fake model to produce a real turn, or
   * exporting a hook from app.js for the test to call — one is a second HTTP
   * server's worth of machinery, the other is production code that exists only
   * for a test. Both are worse than asserting that the three lines connecting
   * the stream to the panel are still there.
   */
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  check(
    'a file arriving from the stream is offered to the panel',
    /noteFile\(result\.file\)/.test(app) && /function noteFile[\s\S]{0,400}offerPreview\(file\)/.test(app),
    'tool_result → noteFile → offerPreview',
  );
  check(
    '  the decision goes through the tested policy',
    /shouldAutoPreview\(previewConditions\(/.test(app),
    'so the rules cannot drift away from test/autopreview.test.mjs',
  );
  check(
    '  and every turn starts with a clean slate',
    /setRunning\(true\);[\s\S]{0,200}resetAutoPreview\(\)/.test(app),
    'otherwise closing it once would silence it forever',
  );
  check(
    '  while a rewrite refreshes what is open instead of popping',
    /viewer\.showing\(\) === file\.id[\s\S]{0,200}viewer\.reopen\(\)/.test(app),
  );
}

/**
 * The guide is shown once, and "once" means once — not once per completion.
 *
 * It used to be recorded as seen only when it was *finished*, so reloading the page
 * halfway, or closing the tab and coming back, meant it had never finished and it
 * opened again. That is exactly the complaint: it reappears on a later visit to an
 * account that has already been set up.
 *
 * Now it is marked the moment it opens. This checks the case that was broken:
 * reload while it is on screen, having pressed nothing at all.
 */
section('the guide does not come back after a mid-way reload');
{
  // A second account, because the first has already answered and cannot be asked
  // again — and this is a claim about the first sight of it.
  await page.evaluate(() => document.getElementById('logout')?.click());
  await page.waitForTimeout(1200);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  await page.click('#gate-switch').catch(() => {});
  await page.waitForTimeout(400);
  await page.fill('#gate-name', 'Người mới');
  await page.fill('#gate-email', 'nguoi-moi@example.com');
  await page.fill('#gate-password', 'mot-mat-khau-dai');
  await page.check('#gate-consent');
  await page.click('#gate-submit');
  await page.waitForTimeout(2600);

  check('the new account is shown the guide', !!(await page.$('#onboarding[open]')));

  // Reload with the guide still open and nothing pressed. This is the case that
  // used to bring it back.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  check('and after a reload it is gone', !(await page.$('#onboarding[open]')));
  check('the app is usable', await page.isVisible('#model-chip'));

  // Once more, because "gone" has to keep meaning gone.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);
  check('and still gone on the visit after that', !(await page.$('#onboarding[open]')));

  // But it is still reachable on purpose — dismissed is not deleted.
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await page.click('.tab[data-tab="behaviour"]');
  await page.waitForTimeout(300);
  await page.click('#open-onboarding');
  await page.waitForTimeout(600);
  check('and can still be opened deliberately', !!(await page.$('#onboarding[open]')));
  await page.click('#onb-skip');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.waitForTimeout(300);
}

/**
 * A run of steps, drawn the way somebody reads it.
 *
 * Exercised in a real browser because that is the only honest way to check DOM
 * that is built by hand: the module is imported into the live page and driven
 * directly, so what is asserted is what would actually be on screen.
 *
 * Every check here is a mistake that is easy to make and invisible in review —
 * a run that never collapses keeps a spinner forever; a run that swallows the
 * prose between two activities claims a structure the turn does not have.
 */
section('a run of browser steps reads as one piece of work');
{
  const run = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.body.append(turn.node);

    const step = (name, input, result) => turn.startTool({ id: name, name, input }).complete(result);

    step('browser_open', { url: 'https://vercel.com/dashboard' }, { content: 'ok', ms: 900 });
    step('browser_click', { ref: 7, description: 'Deploy' }, { content: 'ok', ms: 120 });
    step('browser_wait', { seconds: 3 }, { content: 'ok', ms: 3000 });

    const card = turn.node.querySelector('.steps');
    const first = card.querySelector('.step');

    const snapshot = {
      grouped: turn.node.querySelectorAll('.steps').length,
      steps: card.querySelectorAll('.step').length,
      title: card.querySelector('.steps__title').textContent,
      tally: card.querySelector('.steps__tally').textContent,
      firstVerb: first.querySelector('.step__verb').textContent,
      firstDetail: first.querySelector('.step__detail').textContent,
      openWhileWorking: card.open,
      // A raw tool name anywhere in the summary means a verb is missing.
      noRawNames: !/browser_/.test(card.querySelector('summary').textContent),
    };

    // Prose is the boundary between two activities. Steps after it belong to a
    // new run, and the old one is finished.
    turn.appendText('Deployed it.');
    step('browser_look', {}, { content: 'ok', ms: 40 });

    snapshot.afterProse = turn.node.querySelectorAll('.steps').length;
    snapshot.firstCollapsed = !card.open;
    snapshot.firstSpinnerGone = !card.querySelector('.spinner');

    // A tool from outside the family also ends the run — `read_file` between two
    // browser actions really is a change of activity.
    step('read_file', { path: 'a.txt' }, { content: 'ok', ms: 10 });
    snapshot.afterOutsider = turn.node.querySelectorAll('.steps').length;
    snapshot.plainToolStillACard = turn.node.querySelectorAll('.tool').length;

    turn.finish();
    snapshot.allCollapsed = [...turn.node.querySelectorAll('.steps')].every((n) => !n.open);
    snapshot.noSpinnersLeft = turn.node.querySelectorAll('.steps .spinner').length === 0;

    turn.node.remove();
    return snapshot;
  });

  check('three browser calls make one card', run.grouped === 1, `${run.grouped}`);
  check('holding all three steps', run.steps === 3, `${run.steps}`);
  check('labelled as a run', /browser|trình duyệt/i.test(run.title), run.title);
  check('with a count', /3/.test(run.tally), run.tally);
  check('and no raw tool names in it', run.noRawNames);
  check('the first step reads as a sentence', !!run.firstVerb && !/_/.test(run.firstVerb), run.firstVerb);
  check('naming what it acted on', run.firstDetail === 'vercel.com/dashboard', run.firstDetail);
  check('the run is open while it works', run.openWhileWorking === true);

  check('prose starts a new run', run.afterProse === 2, `${run.afterProse}`);
  check('and collapses the finished one', run.firstCollapsed === true);
  check('taking its spinner with it', run.firstSpinnerGone === true);

  check('a tool from outside the family ends the run too', run.afterOutsider === 2, `${run.afterOutsider}`);
  check('and is still drawn as its own card', run.plainToolStillACard === 1, `${run.plainToolStillACard}`);

  check('finishing the turn closes everything', run.allCollapsed === true);
  check('and leaves nothing spinning', run.noSpinnersLeft === true);
}

/**
 * A browsing session across model steps is one card (owner, 2026-10-07).
 *
 * Every model step is a block of its own, so eight actions with a line of
 * reasoning before each drew eight "Used the browser · 1 step" cards — and each
 * kept spinning beside the finished answer, because only the last block was
 * ever told the turn had ended. Here: three blocks, live, then the same turn
 * rebuilt from storage, must draw one card whose mark follows its own steps.
 */
section('browser steps across model steps are one card, and each settles when it is done');
{
  const live = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const host = document.createElement('div');
    document.body.append(host);
    const block = () => {
      const turn = assistantMessage();
      host.append(turn.node);
      return turn;
    };
    const pending = (card) => !!card.querySelector(':scope > summary > .mark--pending');
    const out = {};

    const b1 = block();
    b1.appendThinking('I will open the syllabus.');
    b1.finishThinking();
    const open = b1.startTool({ id: 'c1', name: 'cloud_browser', input: { action: 'open', url: 'https://decuongmonhoc.tdtu.edu.vn/x' } });
    const card = host.querySelector('.steps');
    out.spinsWhileRunning = pending(card);
    open.complete({ content: 'Page: x', ms: 800 });
    // The answer has not arrived; the step has. Its card must not spin on.
    out.settledBeforeTheTurnEnds = !pending(card);

    const b2 = block();
    b2.appendThinking('Now the login field.');
    out.thoughtInsideTheCard = !!card.querySelector('.step--thought .think') && b2.node.querySelector('.msg__body').childElementCount === 0;
    b2.finishThinking();
    const fill = b2.startTool({ id: 'c2', name: 'cloud_browser', input: { action: 'fill', ref: 3, value: 'TestMSSV123' } });
    out.cards = host.querySelectorAll('.steps').length;
    out.spinsAgainForTheNewStep = pending(card);
    const fillRow = [...card.querySelectorAll('.step:not(.step--thought)')].pop();
    out.fillVerb = fillRow.querySelector('.step__verb').textContent;
    out.fillDetail = fillRow.querySelector('.step__detail')?.textContent || '';
    fill.complete({ content: 'no element', isError: true, ms: 0 });
    out.tally = card.querySelector('.steps__tally').textContent;
    out.partial = card.classList.contains('steps--partial') && !card.classList.contains('steps--error');
    out.tickAfterOneFailure = card.querySelector(':scope > summary > .mark').textContent === '✓';

    const b3 = block();
    b3.appendThinking('Done, now the answer.');
    // As the app's `text` handler does: the reasoning settles when the reply begins.
    b3.finishThinking();
    b3.appendText('Here is the translation.');
    out.answerThoughtLeftTheCard = !card.querySelector('.step--thought .think__text')?.textContent.includes('now the answer') && !!b3.node.querySelector('.msg__body > .think');
    out.foldedWhenTheAnswerCame = !card.open;
    out.stepsInCard = card.querySelectorAll('.step:not(.step--thought)').length;
    out.thoughtsInCard = card.querySelectorAll('.step--thought').length;
    b3.finish();
    out.noSpinners = host.querySelectorAll('.mark--pending, .steps .spinner').length === 0;
    host.remove();
    return out;
  });

  check('the card spins while its step runs', live.spinsWhileRunning === true);
  check('  and settles the moment the step is done, before the answer arrives', live.settledBeforeTheTurnEnds === true);
  check('the reasoning before the next step is a row inside the card, not a card of its own', live.thoughtInsideTheCard === true);
  check('the next model step\'s browser action joins the same card', live.cards === 1, `${live.cards} cards`);
  check('  which spins again while that step runs', live.spinsAgainForTheNewStep === true);
  check('a step reads as the action it was — `fill` drawn as typing, with what was typed', /^(Type|Gõ)$/.test(live.fillVerb) && /#3 ← “TestMSSV123”/.test(live.fillDetail), `${live.fillVerb} | ${live.fillDetail}`);
  check('one failed step of two: a tick, with the failure counted — not a red title over a green tick', live.tickAfterOneFailure && live.partial && /1 (failed|lỗi)/.test(live.tally), live.tally);
  check('the reasoning that led to the answer stands before the answer, outside the card', live.answerThoughtLeftTheCard === true);
  check('  and the card folds when the answer comes, holding both steps and the one thought between them', live.foldedWhenTheAnswerCame && live.stepsInCard === 2 && live.thoughtsInCard === 1, `${live.stepsInCard} steps, ${live.thoughtsInCard} thoughts`);
  check('nothing is left spinning', live.noSpinners === true);

  const stored = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const host = document.createElement('div');
    document.body.append(host);
    const results = new Map([
      ['s1', { toolCallId: 's1', content: 'Page: x', ms: 700 }],
      ['s2', { toolCallId: 's2', content: 'Page: x', ms: 500 }],
      ['s3', { toolCallId: 's3', content: 'Page: y', ms: 400 }],
    ]);
    const messages = [
      { thinking: 'Open it.', toolCalls: [{ id: 's1', name: 'cloud_browser', input: { action: 'open', url: 'https://x.example' } }] },
      { thinking: 'Scroll for the rest.', toolCalls: [{ id: 's2', name: 'cloud_browser', input: { action: 'scroll_down' } }] },
      { thinking: 'Read part 2.', toolCalls: [{ id: 's3', name: 'cloud_browser', input: { action: 'read', page: 2 } }] },
      { thinking: 'Answer now.', text: 'Bản dịch:' },
    ];
    messages.forEach((m, i) => {
      const turn = assistantMessage();
      host.append(turn.node);
      turn.hydrate(m, results, { endsTurn: i === messages.length - 1 });
    });
    const cards = host.querySelectorAll('.steps');
    const out = {
      cards: cards.length,
      steps: cards[0]?.querySelectorAll('.step:not(.step--thought)').length,
      thoughts: cards[0]?.querySelectorAll('.step--thought').length,
      folded: !cards[0]?.open,
      verbs: [...(cards[0]?.querySelectorAll('.step:not(.step--thought) .step__verb') || [])].map((n) => n.textContent),
      scrollDetail: cards[0]?.querySelectorAll('.step:not(.step--thought) .step__detail')[1]?.textContent,
      answerHasItsThought: !!host.lastElementChild.querySelector('.msg__body > .think'),
    };
    // A person's message between two runs is a break: the next run is a card of its own.
    const user = document.createElement('div');
    user.className = 'msg msg--user';
    host.append(user);
    const after = assistantMessage();
    host.append(after.node);
    after.hydrate({ toolCalls: [{ id: 's4', name: 'cloud_browser', input: { action: 'look' } }] }, new Map([['s4', { toolCallId: 's4', content: 'ok' }]]), { endsTurn: true });
    out.cardsAfterAPersonSpoke = host.querySelectorAll('.steps').length;
    host.remove();
    return out;
  });

  check('a stored session rebuilds as the same one card', stored.cards === 1 && stored.steps === 3 && stored.thoughts === 2, JSON.stringify(stored));
  check('  folded, as history', stored.folded === true);
  check('  with each row named by its action', stored.verbs.length === 3 && stored.verbs.every((v) => !/cloud|đám mây/i.test(v)), stored.verbs.join(', '));
  check('  `scroll_down` drawn as a scroll down', /^(down|xuống)$/.test(stored.scrollDetail || ''), stored.scrollDetail);
  check('  and the answer keeps its own reasoning', stored.answerHasItsThought === true);
  check('a run after the person speaks is a card of its own', stored.cardsAfterAPersonSpoke === 2, `${stored.cardsAfterAPersonSpoke}`);
}

/**
 * Formulas are typeset, under the page's own Content-Security-Policy.
 *
 * The renderer's side is covered in markdown-math.test.mjs; what only a browser
 * can prove is that KaTeX loads from public/vendor, is allowed by the CSP, finds
 * its fonts, and replaces the placeholders written before it arrived.
 */
/**
 * A run in the background appears in the sidebar without anyone reloading.
 *
 * A workflow was halfway through its steps while the list said "no
 * conversations yet": the conversation existed, the page never asked again.
 * Here the run is started behind the page's back, straight in the store, the
 * way a cron-driven run would be.
 */
section('work running in the background shows up in the conversation list');
{
  const store = await initStore();
  // Whoever the page is signed in as by now — an earlier section switches
  // accounts, and a run for anyone else would rightly never appear here.
  const signedIn = await page.evaluate(async () => (await (await fetch('/api/session')).json()).user);
  const user = await store.getUserByEmail(signedIn.email);
  await store.createWorkflow(user.id, { id: 'wf-live', title: 'Chuỗi việc nền', steps: [{ instruction: 'a' }] });
  await store.createChat(user.id, { id: 'c-live', title: 'Chuỗi việc nền', model: 'm' });
  await store.createWorkflowRun(user.id, { id: 'r-live', workflowId: 'wf-live', chatId: 'c-live', status: 'running', steps: [] });

  // Coming back to the tab is one of the moments the list refreshes.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(2000);
  const shown = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#chat-list .chat-row')].find((r) => r.textContent.includes('Chuỗi việc nền'));
    return { listed: !!row, running: !!row?.classList.contains('is-running'), dot: !!row?.querySelector('.chat-row__live') };
  });
  check('the conversation a run just opened is listed', shown.listed);
  check('and the page knows it is running', shown.running);
  // The dot this used to draw was removed: it sat beside the bar that already
  // marks the open row, and duplicated the composer's own spinner.
  check('without drawing a second indicator beside the row', !shown.dot);

  // While something runs, the list checks again within seconds on its own —
  // that faster poll is what the flag is still for, so a title written by a
  // background run appears without anyone reloading.
  await store.saveWorkflowRun('r-live', { status: 'done', finished: true });
  await store.appendMessage(user.id, 'c-live', { id: 'm-live', role: 'user', text: 'a' });
  await page.waitForTimeout(7000);
  const after = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#chat-list .chat-row')].find((r) => r.textContent.includes('Chuỗi việc nền'));
    return { listed: !!row, running: !!row?.classList.contains('is-running') };
  });
  check('when the run finishes the mark goes, by itself', after.listed && !after.running, JSON.stringify(after));
}

/**
 * Reloading mid-answer no longer throws the answer away.
 *
 * What used to happen, and what the report was: a turn was running, the page
 * was refreshed — or the conversation was left and reopened — and everything
 * vanished. The transcript came back frozen at the last saved step with no
 * spinner, no progress and nothing saying whether anything was still
 * happening, so it read as a crash; and sending again was refused, because the
 * lease was still held by a run the page could no longer see.
 *
 * Both halves are fixed. The server keeps working when the browser leaves — a
 * closed socket now asks the lease whether the run is still wanted instead of
 * assuming it is not — and the page, on opening a conversation, is told the run
 * id it needs to walk back into that same run rather than starting a second.
 *
 * The run here is planted in the store, the way the previous section plants a
 * workflow: a real turn needs a provider key, and what is on trial is the
 * page's behaviour when it meets one, not the model's.
 */
section('searching and reading the web is one card of sites, like Claude\'s');
{
  const store = await initStore();
  const signedIn = await page.evaluate(async () => (await (await fetch('/api/session')).json()).user);
  const user = await store.getUserByEmail(signedIn.email);
  await store.createChat(user.id, { id: 'c-web', title: 'Tin hôm nay', model: 'm' });
  await store.appendMessage(user.id, 'c-web', { id: 'w-u', role: 'user', text: 'tin mới nhất hôm nay' });
  const long = 'Giá vàng hôm nay 28/9/2026: Thế giới hạ sâu, vàng SJC giảm tới 1 triệu/lượng và còn nhiều biến động mạnh trong phiên chiều';
  await store.appendMessage(user.id, 'c-web', {
    id: 'w-a',
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'w1', name: 'web_search', input: { query: 'tin tức mới nhất hôm nay 28/9/2026', count: 3 } },
      { id: 'w2', name: 'web_fetch', input: { url: 'https://vietnamnet.vn/gia-vang-hom-nay-2559407.html' } },
      { id: 'w3', name: 'read_feed', input: { url: 'https://vnexpress.net/rss/tin-moi-nhat.rss' } },
    ],
  });
  await store.appendMessage(user.id, 'c-web', {
    id: 'w-t',
    role: 'tool',
    results: [
      {
        toolCallId: 'w1',
        name: 'web_search',
        content: `3 results.\n\n<untrusted source="search">\n1. Trực tiếp ASIAD 2026 hôm nay, 28/9\n   https://vietnamnet.vn/truc-tiep-asiad-2026-2559401.html\n2. ${long}\n   https://vietnamnet.vn/gia-vang-hom-nay-2559407.html\n3. Thời tiết hôm nay 28/9\n   https://voh.com.vn/thoi-tiet-28-9.html\n</untrusted>`,
      },
      { toolCallId: 'w2', name: 'web_fetch', content: '# https://vietnamnet.vn/gia-vang-hom-nay-2559407.html\n\n<untrusted source="x">\nGiá vàng hôm nay\nNội dung...\n</untrusted>' },
      { toolCallId: 'w3', name: 'read_feed', content: '<untrusted source="https://vnexpress.net/rss/tin-moi-nhat.rss">\nTin mới nhất - VnExpress RSS — 46 items, newest 10:\n1. A\n</untrusted>' },
    ],
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('.chat-row[data-chat="c-web"]');
  await page.waitForTimeout(900);
  // Folded once the turn is over; opened to read.
  await page.click('.block.web > summary');
  await page.waitForTimeout(300);
  const card = await page.evaluate(() => {
    const node = document.querySelector('.block.web');
    const rows = [...(node?.querySelectorAll('.webrow') || [])];
    const list = node?.querySelector('.web__list');
    return {
      cards: document.querySelectorAll('.block.web').length,
      separate: document.querySelectorAll('.block.tool').length,
      title: node?.querySelector('.web__title')?.textContent,
      query: node?.querySelector('.web__query')?.textContent,
      rows: rows.map((r) => ({
        href: r.getAttribute('href'),
        title: r.querySelector('.webrow__title')?.textContent,
        site: r.querySelector('.webrow__site')?.textContent,
        icon: r.querySelector('.webrow__icon')?.getAttribute('src'),
        cls: r.className,
      })),
      json: /"query"|"url"/.test(node?.textContent || ''),
      sideways: list ? list.scrollWidth > list.clientWidth + 1 : true,
      background: node ? getComputedStyle(node).backgroundColor : '',
    };
  });
  check('one card for the whole run, not a card per call', card.cards === 1 && card.separate === 0, JSON.stringify({ cards: card.cards, separate: card.separate }));
  check('  saying it searched, with the query beside it', /web|web/i.test(card.title || '') && card.query === 'tin tức mới nhất hôm nay 28/9/2026', `${card.title} | ${card.query}`);
  check('  a row per site, the page it read being the same row as its result', card.rows.length === 4, JSON.stringify(card.rows.map((r) => r.href)));
  const gold = card.rows.find((r) => r.href === 'https://vietnamnet.vn/gia-vang-hom-nay-2559407.html');
  check('  each row points at the exact page, not the homepage', !!gold && /is-read/.test(gold.cls), JSON.stringify(gold));
  check('  with the site as a domain, and its icon from this app', gold?.site === 'vietnamnet.vn' && gold?.icon === '/api/favicon/vietnamnet.vn', JSON.stringify(gold));
  check('  a feed named by its own title', card.rows.some((r) => r.title === 'Tin mới nhất - VnExpress RSS'), JSON.stringify(card.rows.map((r) => r.title)));
  check('  no raw arguments on show', !card.json);
  check('  and a long title is cut, not scrolled sideways', !card.sideways);
  check('  transparent, a border and nothing else', /rgba\(0, 0, 0, 0\)|transparent/.test(card.background), card.background);
}

section('reopening a conversation mid-answer rejoins it rather than blanking');
{
  const store = await initStore();
  const signedIn = await page.evaluate(async () => (await (await fetch('/api/session')).json()).user);
  const user = await store.getUserByEmail(signedIn.email);

  await store.createChat(user.id, { id: 'c-midrun', title: 'Đang trả lời dở', model: 'm' });
  await store.appendMessage(user.id, 'c-midrun', { id: 'm-midrun', role: 'user', text: 'a long question' });
  // The turn the closed tab left behind, still holding its lease.
  const runId = 'cccccccc-dddd-eeee-ffff-000000000000';
  await store.claimChatRun(user.id, 'c-midrun', runId);

  const told = await page.evaluate(async () => {
    const res = await fetch('/api/chats/c-midrun');
    return (await res.json()).running;
  });
  check('the page can find out a conversation is still answering', !!told, JSON.stringify(told));
  check('and is given the id it needs to rejoin', told?.runId === 'cccccccc-dddd-eeee-ffff-000000000000', JSON.stringify(told));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  /**
   * What is asserted is the request, not the spinner.
   *
   * With no provider key configured the rejoined turn fails within a few
   * milliseconds, so anything read off the DOM a moment later has already
   * settled back to idle — a test of how fast the failure was, not of whether
   * the page rejoined. The run id on the wire is the thing that cannot be
   * faked: it was planted in the store, the page was never told it by anything
   * but the server, and sending it is precisely what re-enters the lease rather
   * than starting a second turn.
   */
  const opened = await page.evaluate(async () => {
    const seen = [];
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (/\/run$/.test(url) && init?.body) {
        try {
          seen.push({ url, runId: JSON.parse(init.body).runId });
        } catch {
          /* a body that is not JSON is not the call being watched for */
        }
      }
      return realFetch(input, init);
    };

    const row = [...document.querySelectorAll('#chat-list .chat-row')].find((r) => r.textContent.includes('Đang trả lời dở'));
    row?.querySelector('.chat-item')?.click();
    await new Promise((r) => setTimeout(r, 2500));
    window.fetch = realFetch;
    return {
      found: !!row,
      // What the question already produced is on screen, rebuilt from the saved
      // transcript — not a blank page under a spinner, which is what this used
      // to be while the run went on writing steps nobody could see.
      said: document.querySelector('#messages .msg--user')?.textContent?.includes('a long question'),
      runs: seen,
    };
  });
  check('the conversation is reachable from the sidebar', opened.found);
  check('what was already said is on screen', opened.said === true, JSON.stringify(opened.runs));
  check('opening it rejoins the turn rather than leaving it stranded', opened.runs.length === 1, JSON.stringify(opened.runs));
  check(
    'and it rejoins the run that was already going, not a new one',
    opened.runs[0]?.runId === 'cccccccc-dddd-eeee-ffff-000000000000',
    JSON.stringify(opened.runs),
  );

  await store.stopChatRun(user.id, 'c-midrun');
}

/**
 * Setting up standing work leaves a card you can act on.
 *
 * A schedule came back as one sentence — correct, gone the moment it scrolled
 * away, and leading nowhere: changing the time meant finding the Scheduled
 * shelf, finding the row, opening it. The card says how often, in which zone
 * and when next, and its pill opens the task itself.
 *
 * Planted in the store, the way the sections around it plant a run: a real
 * turn needs a provider key, and what is on trial is what the page draws from a
 * transcript that carries a schedule — which is also exactly what a reopened
 * conversation is rebuilt from.
 */
/**
 * What a project made, as a row of pages.
 *
 * A grid of filenames said a project had made nine things and nothing about
 * which was which. The row shows each one — the page running, the document's
 * first lines — newest on the left, scrolled sideways, with an arrow only on
 * a side that has more.
 */
section('what a project made is a row of pages, newest first');
{
  const store = await initStore();
  const signedIn = await page.evaluate(async () => (await (await fetch('/api/session')).json()).user);
  const user = await store.getUserByEmail(signedIn.email);
  await store.createProject(user.id, { id: 'p-out', name: 'Output shelf' });
  await store.createChat(user.id, { id: 'c-out', title: 'Made things here', model: 'm', projectId: 'p-out' });
  await store.appendMessage(user.id, 'c-out', { id: 'm-out', role: 'user', text: 'make things' });
  // A fold, which the transcript must not draw as a block among the turns.
  await store.appendMessage(user.id, 'c-out', { id: 'm-sum', role: 'summary', text: 'Folded summary text', replaced: 12, covers: 0 });
  // One web search, answered, so Context lists it and its panel has something to show.
  await store.appendMessage(user.id, 'c-out', { id: 'm-ws', role: 'assistant', text: '', toolCalls: [{ id: 'ws1', name: 'web_search', input: { query: 'ESMC Dresden groundbreaking' } }] });
  await store.appendMessage(user.id, 'c-out', { id: 'm-wr', role: 'tool', results: [{ toolCallId: 'ws1', name: 'web_search', isError: false, content: '2 results from Exa.\n\n1. ESMC breaks ground in Dresden\n   https://pr.tsmc.com/english/news/3169\n   snippet\n\n2. TSMC Dresden fab\n   https://www.digitimes.com/news/a1\n   snippet' }] });
  for (let i = 0; i < 7; i += 1) {
    const page_ = i % 2 === 0;
    await store.createAttachment(user.id, {
      id: `o-${i}`,
      name: page_ ? `page-${i}.html` : `report-${i}.md`,
      mime: page_ ? 'text/html' : 'text/markdown',
      kind: 'text',
      bytes: 120,
      data: Buffer.from(page_ ? `<h1>Page ${i}</h1>` : `# Report ${i}\n\nThe body of report ${i}.`).toString('base64'),
      origin: 'generated',
      chatId: 'c-out',
    });
    await new Promise((r) => setTimeout(r, 30));
  }

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await page.evaluate(async () => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    const row = [...document.querySelectorAll('#chat-list .chat-row')].find((r) => r.textContent.includes('Made things here'));
    /** @type {HTMLElement | null} */ (row?.querySelector('.chat-item'))?.click();
    await new Promise((r) => setTimeout(r, 1200));
    /** @type {any} */ (window).__foldsDrawn = document.querySelectorAll('#messages .compacted').length;
    const railRows = [...document.querySelectorAll('#rail-extra [data-rail="outputs"] .railrow')];
    /** @type {any} */ (window).__rail = {
      rows: railRows.length,
      first: railRows[0]?.textContent?.trim(),
      count: document.querySelector('#rail-extra .railsec__count')?.textContent,
      // Every section's list has the panel's scroll, not one of its own that cut
      // the last row of tools in half.
      ownScroll: [...document.querySelectorAll('#rail-extra .railsec__body')].map((b) => getComputedStyle(b).maxHeight).filter((h) => h !== 'none'),
    };
    // Incognito says so in its banner; the dock around the composer gets no frame.
    document.body.classList.add('is-incognito');
    const dock = getComputedStyle(/** @type {HTMLElement} */ (document.querySelector('.composer')));
    /** @type {any} */ (window).__incognitoFrame = `${dock.borderTopStyle} ${dock.borderTopWidth}`;
    document.body.classList.remove('is-incognito');
    const chip = /** @type {HTMLElement | null} */ (document.querySelector('#rail-extra [data-tool="web_search"]'));
    chip?.click();
    await new Promise((r) => setTimeout(r, 200));
    const group = /** @type {HTMLDetailsElement | null} */ (document.querySelector('#toolpane .toolgrp'));
    const info = {
      chip: !!chip,
      open: !document.getElementById('toolpane').hidden,
      groups: document.querySelectorAll('#toolpane .toolgrp').length,
      hits: document.querySelectorAll('#toolpane .webrow').length,
      folded: false,
      // The panel's own ground, as the progress panel has — not a grey card.
      ground: getComputedStyle(/** @type {HTMLElement} */ (document.getElementById('toolpane'))).backgroundColor,
    };
    /** @type {HTMLElement | null} */ (group?.querySelector('summary'))?.click();
    info.folded = group ? !group.open : false;
    document.getElementById('toolpane-close')?.click();
    /** @type {any} */ (window).__search = info;
    document.getElementById('chat-project')?.click();
    await new Promise((r) => setTimeout(r, 1800));
  });
  const first = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#project-page-outputs .outcard')];
    const navs = [...document.querySelectorAll('#project-page-outputs .outrail__nav')];
    return {
      count: cards.length,
      firstName: cards[0]?.querySelector('.outcard__name')?.textContent,
      prevHidden: navs[0]?.hidden,
      nextHidden: navs[1]?.hidden,
      frame: !!cards[0]?.querySelector('iframe.outcard__frame'),
    };
  });
  check('a fold is not drawn in the transcript', (await page.evaluate(() => /** @type {any} */ (window).__foldsDrawn)) === 0);
  const railed = await page.evaluate(() => /** @type {any} */ (window).__rail);
  const searched = /** @type {any} */ (await page.evaluate(() => /** @type {any} */ (window).__search));
  check('a web search the conversation used is listed as a connector', searched?.chip === true, JSON.stringify(searched));
  check('  and opens every search, grouped by the message that asked', searched?.groups === 1 && searched?.hits === 2, JSON.stringify(searched));
  check('  each group folds on a press', searched?.folded === true, JSON.stringify(searched));
  check('  on the panel\'s own ground, not a grey card', searched?.ground === 'rgba(0, 0, 0, 0)', String(searched?.ground));
  check('no list in the side panel scrolls on its own', railed?.ownScroll?.length === 0, JSON.stringify(railed?.ownScroll));
  const frame = await page.evaluate(() => /** @type {any} */ (window).__incognitoFrame);
  check('an incognito conversation draws no frame around the composer', /^none /.test(String(frame)), String(frame));
  check('the side panel lists what this conversation made', railed?.rows === 7 && railed?.count === '7', JSON.stringify(railed));
  check('  newest first', /page-6/.test(railed?.first || ''), railed?.first);
  check('every output is a card in one row', first.count === 7, String(first.count));
  check('newest on the left', first.firstName === 'page-6.html', first.firstName);
  check('no left arrow at the start', first.prevHidden === true);
  check('a right arrow while there is more', first.nextHidden === false, JSON.stringify(first));
  check('a page shows itself, running', first.frame);

  await page.click('#project-page-outputs .outrail__nav[data-dir="1"]');
  await page.waitForTimeout(900);
  const moved = await page.evaluate(() => {
    const navs = [...document.querySelectorAll('#project-page-outputs .outrail__nav')];
    const doc = document.querySelector('#project-page-outputs .outcard__doctitle')?.textContent || '';
    return { prevHidden: navs[0]?.hidden, doc };
  });
  check('after scrolling, the left arrow appears', moved.prevHidden === false);
  check('a document shows its opening lines', /Report \d/.test(moved.doc), moved.doc);

  await page.hover('#project-page-outputs .outcard');
  await page.waitForTimeout(400);
  const lifted = await page.evaluate(
    () => getComputedStyle(/** @type {Element} */ (document.querySelector('#project-page-outputs .outcard'))).transform,
  );
  check('a card lifts under the pointer', lifted !== 'none', lifted);
  await page.screenshot({ path: (process.env.TEMP || '.') + '/shot-rail.png' });

  await page.click('#project-page-outputs .outcard');
  await page.waitForTimeout(1200);
  check('pressing one opens it', await page.evaluate(() => !document.getElementById('filepane').hidden && /report|page/.test(document.getElementById('viewer-title').textContent || '')));
}

section('a schedule set up in a conversation is a card that opens it');
{
  const store = await initStore();
  const signedIn = await page.evaluate(async () => (await (await fetch('/api/session')).json()).user);
  const user = await store.getUserByEmail(signedIn.email);

  const task = await store.createTask(user.id, {
    id: 't-card',
    title: 'Bản tin sáng',
    prompt: 'Tóm tắt tin buổi sáng',
    cron: 'weekdays 07:30',
    nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    tz: 'Asia/Ho_Chi_Minh',
  });
  await store.createChat(user.id, { id: 'c-sched', title: 'Lịch bản tin', model: 'm' });
  await store.appendMessage(user.id, 'c-sched', { id: 'm-s1', role: 'user', text: 'mỗi sáng tóm tắt tin' });
  await store.appendMessage(user.id, 'c-sched', {
    id: 'm-s2',
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'call-s', name: 'schedule_task', input: { title: task.title, when: '07:30' } }],
  });
  await store.appendMessage(user.id, 'c-sched', {
    id: 'm-s3',
    role: 'tool',
    results: [
      {
        toolCallId: 'call-s',
        name: 'schedule_task',
        content: 'Scheduled.',
        isError: false,
        schedule: {
          kind: 'task',
          id: task.id,
          title: task.title,
          cron: task.cron,
          nextRunAt: task.next_run_at,
          tz: task.tz,
          enabled: true,
          prompt: task.prompt,
          existing: false,
        },
      },
    ],
  });
  // A second schedule further down the same conversation, for moving from one
  // schedule to another (UX-014). Every check below that means the first card
  // finds it first.
  const other = await store.createTask(user.id, {
    id: 't-card2',
    title: 'Bản tin tối',
    prompt: 'Tóm tắt tin buổi tối',
    cron: '19:00',
    nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    tz: 'Asia/Ho_Chi_Minh',
  });
  await store.appendMessage(user.id, 'c-sched', {
    id: 'm-s4',
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'call-s2', name: 'schedule_task', input: { title: other.title, when: '19:00' } }],
  });
  await store.appendMessage(user.id, 'c-sched', {
    id: 'm-s5',
    role: 'tool',
    results: [
      {
        toolCallId: 'call-s2',
        name: 'schedule_task',
        content: 'Scheduled.',
        isError: false,
        schedule: {
          kind: 'task',
          id: other.id,
          title: other.title,
          cron: other.cron,
          nextRunAt: other.next_run_at,
          tz: other.tz,
          enabled: true,
          prompt: other.prompt,
          existing: false,
        },
      },
    ],
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  const drawn = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('#chat-list .chat-row')].find((r) => r.textContent.includes('Lịch bản tin'));
    row?.querySelector('.chat-item')?.click();
    await new Promise((r) => setTimeout(r, 1800));
    const card = document.querySelector('#messages .schedcard');
    return {
      found: !!row,
      card: !!card,
      facts: card?.querySelector('.schedcard__rows')?.textContent || '',
      name: card?.querySelector('.schedcard__name')?.textContent || '',
      state: card?.querySelector('.schedcard__state')?.textContent || '',
      content: card?.querySelector('.schedcard__content')?.textContent || '',
      // The pill sits under the card, not inside its border.
      pillOutside: !!card?.querySelector(':scope > .schedcard__pill') && !card?.querySelector('.schedcard__box .schedcard__pill'),
      pill: card?.querySelector('.schedcard__pill')?.textContent || '',
    };
  });
  check('the conversation opens', drawn.found);
  check('the schedule is drawn as a card, rebuilt from the transcript', drawn.card, JSON.stringify(drawn));
  check('saying how often in words, not scheduler syntax', !/weekdays 07:30/.test(drawn.facts) && /07:30/.test(drawn.facts), drawn.facts);
  check('and in which zone', /Asia\/Ho_Chi_Minh/.test(drawn.facts), drawn.facts);
  check('with a pill naming the task', drawn.pill.includes('Bản tin sáng'), drawn.pill);
  check('the card names it and says it is on', drawn.name === 'Bản tin sáng' && drawn.state.length > 0, JSON.stringify(drawn));
  check('and says what it will do', drawn.content.includes('Tóm tắt tin buổi sáng'), drawn.content);
  check('the pill is under the card, not inside it', drawn.pillOutside);

  const detailWasOpen = await page.evaluate(() => document.getElementById('app').classList.contains('is-detail'));
  await page.click('#messages .schedcard__pill');
  await page.waitForTimeout(1200);
  const opened = await page.evaluate(() => ({
    inPane: !document.getElementById('taskpane').hidden && !!document.querySelector('#taskpane .spane'),
    conversation: !document.getElementById('thread').hidden,
    title: document.getElementById('taskpane-title')?.textContent || '',
  }));
  // Beside the conversation, not instead of it.
  check('pressing the pill opens the task in the side panel', opened.inPane, JSON.stringify(opened));
  check('and the conversation stays on screen', opened.conversation);
  check('the right task', opened.title === 'Bản tin sáng', opened.title);

  // The panel is an editor: what it shows is what the row holds.
  const shown = await page.evaluate(() => {
    const v = (name) => /** @type {HTMLSelectElement} */ (document.querySelector(`#taskpane [data-s="${name}"]`))?.value;
    const visible = (sel) => !document.querySelector(`#taskpane ${sel}`)?.closest('[hidden]');
    return {
      frequency: v('frequency'),
      time: /** @type {HTMLInputElement} */ (document.querySelector('#taskpane [data-t]'))?.value,
      tz: v('tz'),
      ends: v('ends'),
      daysShown: visible('[data-day]'),
      timeShown: visible('[data-t]'),
      prompt: v('prompt'),
      state: document.querySelector('#taskpane .spane__state')?.textContent.trim(),
      label: !!document.querySelector('#taskpane .spane__kicker'),
    };
  });
  check('the panel shows the repeat, time and zone the task has',
    shown.frequency === 'weekdays' && shown.time === '07:30' && shown.tz === 'Asia/Ho_Chi_Minh', JSON.stringify(shown));
  check('  only the fields that repeat uses', shown.timeShown && !shown.daysShown, JSON.stringify(shown));
  check('  and the instructions, editable', shown.prompt === 'Tóm tắt tin buổi sáng', shown.prompt);
  check('  with one state, not a label and a badge', !!shown.state && !shown.label, JSON.stringify(shown));

  // Changing the time saves it, and the card in the conversation follows.
  await page.fill('#taskpane [data-t]', '07:00');
  await page.dispatchEvent('#taskpane [data-t]', 'change');
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(async () => ({
    cron: (await (await fetch('/api/tasks/t-card')).json()).task?.cron,
    status: document.querySelector('#taskpane [data-s="status"]')?.textContent || '',
    card: document.querySelector('#messages .schedcard__rows')?.textContent || '',
  }));
  check('choosing a time in the panel saves it', saved.cron === 'weekdays 07:00', JSON.stringify(saved));
  check('  and says so', saved.status.length > 0, saved.status);
  check('  and the card beside it says the new time', /07:00/.test(saved.card) && !/07:30/.test(saved.card), saved.card);

  // Weekly brings the days up, starting from one; more days and times can be added.
  await page.selectOption('#taskpane [data-s="frequency"]', 'weekly');
  await page.waitForTimeout(1500);
  const weekly = await page.evaluate(async () => ({
    cron: (await (await fetch('/api/tasks/t-card')).json()).task?.cron,
    frequency: /** @type {HTMLSelectElement} */ (document.querySelector('#taskpane [data-s="frequency"]')).value,
    daysShown: !document.querySelector('#taskpane [data-day]')?.closest('[hidden]'),
  }));
  check('switching to weekly shows the days and saves one of them', weekly.daysShown && weekly.frequency === 'weekly' && /^[a-z]{3} 07:00$/.test(weekly.cron || ''), JSON.stringify(weekly));
  await page.click('#taskpane [data-day="fri"]');
  await page.waitForTimeout(900);
  await page.click('#taskpane [data-add-time]');
  await page.waitForTimeout(1200);
  const twice = await page.evaluate(async () => (await (await fetch('/api/tasks/t-card')).json()).task?.cron);
  check('  a second day and a second time are both kept', twice === 'days mon,fri 07:00,08:00', String(twice));

  // Every 15 minutes, with a real next run rather than "not scheduled".
  await page.selectOption('#taskpane [data-s="frequency"]', 'minutes');
  await page.waitForTimeout(1500);
  await page.fill('#taskpane [data-s="everyMinutes"]', '15');
  await page.dispatchEvent('#taskpane [data-s="everyMinutes"]', 'change');
  await page.waitForTimeout(1200);
  const often = await page.evaluate(async () => ({
    task: (await (await fetch('/api/tasks/t-card')).json()).task,
    next: document.querySelector('#taskpane [data-s="next"]')?.textContent || '',
  }));
  check('every 15 minutes is kept on the clock', often.task?.cron === 'every 15m', String(often.task?.cron));
  check('  with its next run set, within a quarter of an hour', !!often.task?.next_run_at && new Date(often.task.next_run_at) - Date.now() <= 15 * 60_000 + 60_000, String(often.task?.next_run_at));

  // Back to weekly for the end date below.
  await page.selectOption('#taskpane [data-s="frequency"]', 'weekly');
  await page.waitForTimeout(1500);
  await page.selectOption('#taskpane [data-s="ends"]', 'date');
  await page.fill('#taskpane [data-s="endsOn"]', '2999-12-31');
  await page.dispatchEvent('#taskpane [data-s="endsOn"]', 'change');
  await page.waitForTimeout(1000);
  const ended = await page.evaluate(async () => (await (await fetch('/api/tasks/t-card')).json()).task?.ends_on);
  check('an end date set in the panel is kept', ended === '2999-12-31', String(ended));

  // UX-010: changing the repeat and leaving within the pause. The change is saved
  // on the way out, and the panel is not reopened behind the person's back.
  const cronBefore = await page.evaluate(async () => (await (await fetch('/api/tasks/t-card')).json()).task?.cron);
  const cardBefore = await page.evaluate(() => document.querySelector('#messages .schedcard__rows')?.textContent || '');
  await page.selectOption('#taskpane [data-s="frequency"]', 'daily');
  await page.click('#taskpane-close');
  await page.waitForTimeout(1500);
  const movedOn = await page.evaluate(async () => ({
    closed: document.getElementById('taskpane').hidden,
    cron: (await (await fetch('/api/tasks/t-card')).json()).task?.cron,
    card: document.querySelector('#messages .schedcard__rows')?.textContent || '',
  }));
  check('a repeat changed just before closing the panel is still saved (UX-010)', !!movedOn.cron && movedOn.cron !== cronBefore, `${cronBefore} → ${movedOn.cron}`);
  check('  and the panel is not reopened behind the person\'s back', movedOn.closed, JSON.stringify(movedOn));
  // UX-011: and the card in the conversation follows, though its panel is gone.
  check('  the schedule card in the conversation shows the change too (UX-011)', movedOn.card !== cardBefore && movedOn.card.length > 0, `${cardBefore} → ${movedOn.card}`);
  // Back to where the checks below expect to start: the task open in the panel.
  await page.click('#messages .schedcard__pill');
  await page.waitForTimeout(1200);

  // UX-012: the same schedule opened again within the pause, while its save is
  // slow to land, shows the choice — not the old value, ready to be saved back.
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await page.selectOption('#taskpane [data-s="frequency"]', 'weekly');
  await page.click('#messages .schedcard__pill');
  await page.waitForTimeout(2500);
  await page.unroute('**/api/tasks/t-card');
  const reopened = await page.evaluate(async () => ({
    shown: /** @type {HTMLSelectElement} */ (document.querySelector('#taskpane [data-s="frequency"]'))?.value,
    cron: (await (await fetch('/api/tasks/t-card')).json()).task?.cron,
  }));
  check('reopened within the pause, the panel shows the choice just made (UX-012)', reopened.shown === 'weekly', JSON.stringify(reopened));

  // And a save that fails once its panel has gone says so where it can be seen.
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save the schedule (test).' }) });
    } else await route.continue();
  });
  await page.selectOption('#taskpane [data-s="frequency"]', 'daily');
  await page.click('#taskpane-close');
  await page.waitForTimeout(1200);
  await page.unroute('**/api/tasks/t-card');
  const told = await page.evaluate(() => [...document.querySelectorAll('#toasts-alert > *, #toasts > *')].map((n) => n.textContent).join(' | '));
  check('  and a save that fails after the panel closed is said in a toast', /Could not save the schedule \(test\)/.test(told), told);
  await page.click('#messages .schedcard__pill');
  await page.waitForTimeout(1200);

  // UX-013: opened again after the pause, while the save it ended with is still
  // on its way — the open waits for that too, not only for a save not yet sent.
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.selectOption('#taskpane [data-s="frequency"]', 'daily');
  await page.waitForTimeout(1000);
  await page.click('#messages .schedcard__pill');
  await page.waitForTimeout(2500);
  await page.unroute('**/api/tasks/t-card');
  const inFlight = await page.evaluate(async () => ({
    shown: /** @type {HTMLSelectElement} */ (document.querySelector('#taskpane [data-s="frequency"]'))?.value,
    cron: (await (await fetch('/api/tasks/t-card')).json()).task?.cron,
  }));
  check('reopened while its save is still on the way, the panel shows the choice too (UX-013)', inFlight.shown === 'daily', JSON.stringify(inFlight));

  // And closed while that open is still waiting, the panel stays closed: the
  // open that was waiting does not draw itself back over the close.
  await page.route('**/api/tasks/t-card', async (route) => {
    await new Promise((r) => setTimeout(r, route.request().method() === 'PATCH' ? 1500 : 600));
    await route.continue();
  });
  await page.selectOption('#taskpane [data-s="frequency"]', 'weekly');
  await page.waitForTimeout(1000);
  await page.click('#messages .schedcard__pill');
  await page.click('#taskpane-close');
  await page.waitForTimeout(3000);
  await page.unroute('**/api/tasks/t-card');
  const stayed = await page.evaluate(async () => ({
    closed: document.getElementById('taskpane').hidden,
    cron: (await (await fetch('/api/tasks/t-card')).json()).task?.cron,
  }));
  check('  and closed while that open waits, it stays closed (UX-013)', stayed.closed, JSON.stringify(stayed));
  check('  with the choice saved all the same', !!stayed.cron && stayed.cron !== inFlight.cron, `${inFlight.cron} → ${stayed.cron}`);

  // UX-012's Pause: pressed just before closing, it is kept, and the panel is
  // not reopened over the close when the answer comes back.
  await page.click('#messages .schedcard__pill');
  await page.waitForTimeout(1200);
  const enabledBefore = await page.evaluate(async () => (await (await fetch('/api/tasks/t-card')).json()).task?.enabled);
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await page.click('#taskpane [data-s="toggle"]');
  await page.click('#taskpane-close');
  await page.waitForTimeout(1800);
  await page.unroute('**/api/tasks/t-card');
  const paused = await page.evaluate(async () => ({
    closed: document.getElementById('taskpane').hidden,
    enabled: (await (await fetch('/api/tasks/t-card')).json()).task?.enabled,
  }));
  check('Pause pressed just before closing is kept, and the panel stays closed (UX-012)', paused.closed && paused.enabled === !enabledBefore, `${enabledBefore} → ${JSON.stringify(paused)}`);
  await page.click('#messages .schedcard__pill');
  await page.waitForTimeout(1200);

  // UX-014: another schedule opened while the save is on its way is the one
  // shown. Its open does not wait on the first schedule's save, and the Repeat
  // timer, answered before the other schedule has drawn, does not reopen the
  // schedule just left.
  const pillOf = (n) => page.evaluate((i) => /** @type {HTMLElement} */ ([...document.querySelectorAll('#messages .schedcard__pill')][i]).click(), n);
  const cronBeforeMove = await page.evaluate(async () => (await (await fetch('/api/tasks/t-card')).json()).task?.cron);
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.route('**/api/tasks/t-card2', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  await page.selectOption('#taskpane [data-s="frequency"]', 'daily');
  await page.waitForTimeout(1000);
  await pillOf(1);
  await page.waitForTimeout(3500);
  await page.unroute('**/api/tasks/t-card');
  await page.unroute('**/api/tasks/t-card2');
  const moved = await page.evaluate(async () => ({
    open: !document.getElementById('taskpane').hidden,
    title: document.getElementById('taskpane-title')?.textContent || '',
    cron: (await (await fetch('/api/tasks/t-card')).json()).task?.cron,
  }));
  check('another schedule opened while a save is on its way is the one shown (UX-014)', moved.open && moved.title === 'Bản tin tối', JSON.stringify(moved));
  check('  and the change made before leaving is saved', !!moved.cron && moved.cron !== cronBeforeMove, `${cronBeforeMove} → ${moved.cron}`);

  // And Pause/Resume pressed just before opening another schedule does not
  // pull the panel back when its answer comes.
  await pillOf(0);
  await page.waitForTimeout(1200);
  const enabledBeforeMove = await page.evaluate(async () => (await (await fetch('/api/tasks/t-card')).json()).task?.enabled);
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await page.route('**/api/tasks/t-card2', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.click('#taskpane [data-s="toggle"]');
  await pillOf(1);
  await page.waitForTimeout(2500);
  await page.unroute('**/api/tasks/t-card');
  await page.unroute('**/api/tasks/t-card2');
  const toggledAway = await page.evaluate(async () => ({
    title: document.getElementById('taskpane-title')?.textContent || '',
    enabled: (await (await fetch('/api/tasks/t-card')).json()).task?.enabled,
  }));
  check('  and so is one opened just after Pause/Resume, which is kept (UX-014)', toggledAway.title === 'Bản tin tối' && toggledAway.enabled === !enabledBeforeMove, `${enabledBeforeMove} → ${JSON.stringify(toggledAway)}`);
  await pillOf(0);
  await page.waitForTimeout(1200);

  // UX-015: the schedule on screen is held still while it is fetched again, so
  // an edit made in it then cannot be drawn over by the older row.
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  let heldSaves = 0;
  const countSaves = (request) => {
    if (request.method() === 'PATCH' && /\/api\/tasks\/t-card$/.test(request.url())) heldSaves += 1;
  };
  page.on('request', countSaves);
  await pillOf(0);
  await page.waitForTimeout(200);
  const held = await page.evaluate(() => {
    const view = /** @type {HTMLElement | null} */ (document.querySelector('#taskpane-body > div'));
    const box = view?.querySelector('[data-s="toggle"]')?.getBoundingClientRect();
    return { inert: !!view?.inert, busy: view?.getAttribute('aria-busy'), x: box ? box.x + box.width / 2 : 0, y: box ? box.y + box.height / 2 : 0 };
  });
  // Pressed in the old view with the pointer, as a person would while the
  // reopen loads. (A script's `element.click()` is not a person: the platform
  // runs it on an inert element all the same.)
  await page.mouse.click(held.x, held.y);
  await page.waitForTimeout(1800);
  page.off('request', countSaves);
  await page.unroute('**/api/tasks/t-card');
  const released = await page.evaluate(() => !(/** @type {HTMLElement | null} */ (document.querySelector('#taskpane-body > div')))?.inert);
  check('a schedule being fetched again is held still (UX-015)', held.inert && held.busy === 'true' && held.x > 0, JSON.stringify(held));
  check('  so nothing pressed in it then is saved behind the redraw', heldSaves === 0, `${heldSaves} saves`);
  check('  and the redrawn one can be used again', released);

  // The hold comes off when the open that set it is done, even when that open
  // was overtaken: here by another schedule whose fetch fails, so nothing is
  // drawn over the held view and it would have stayed frozen.
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.route('**/api/tasks/t-card2', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not load the schedule (hold test).' }) });
    } else await route.continue();
  });
  await pillOf(0);
  await page.waitForTimeout(150);
  await pillOf(1);
  await page.waitForTimeout(1800);
  await page.unroute('**/api/tasks/t-card');
  await page.unroute('**/api/tasks/t-card2');
  const overtaken = await page.evaluate(() => {
    const view = /** @type {HTMLElement | null} */ (document.querySelector('#taskpane-body > div'));
    return { schedule: view?.dataset.schedule, inert: !!view?.inert, busy: view?.getAttribute('aria-busy') };
  });
  check('  and a hold whose open was overtaken does not leave the panel frozen', overtaken.schedule === 'task:t-card' && !overtaken.inert && !overtaken.busy, JSON.stringify(overtaken));
  await pillOf(0);
  await page.waitForTimeout(1200);

  // CODE-062: the Repeat timer's reopen that cannot fetch the schedule says so,
  // rather than failing where nobody sees.
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not load the schedule (CODE-062 test).' }) });
    } else await route.continue();
  });
  const unseen = [];
  const onPageError = (err) => unseen.push(String(err?.message || err));
  page.on('pageerror', onPageError);
  await page.selectOption('#taskpane [data-s="frequency"]', 'weekly');
  await page.waitForTimeout(2200);
  page.off('pageerror', onPageError);
  await page.unroute('**/api/tasks/t-card');
  const toldReopen = await page.evaluate(() => [...document.querySelectorAll('#toasts-alert > *, #toasts > *')].map((n) => n.textContent).join(' | '));
  check('a reopen that cannot fetch the schedule says so in a toast (CODE-062)', /Could not load the schedule \(CODE-062 test\)/.test(toldReopen), toldReopen);
  check('  and leaves nothing unhandled', !unseen.some((m) => /CODE-062 test/.test(m)), unseen.join(' | '));
  await pillOf(0);
  await page.waitForTimeout(1200);

  // UX-016: a choice flushed on the way to another schedule, failing before that
  // one has drawn, used to report into a view about to be replaced.
  await page.route('**/api/tasks/t-card', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save the schedule (UX-016 test).' }) });
    } else await route.continue();
  });
  await page.route('**/api/tasks/t-card2', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.selectOption('#taskpane [data-s="frequency"]', 'daily');
  await pillOf(1);
  await page.waitForTimeout(2200);
  await page.unroute('**/api/tasks/t-card');
  await page.unroute('**/api/tasks/t-card2');
  const toldSwitch = await page.evaluate(() => [...document.querySelectorAll('#toasts-alert > *, #toasts > *')].map((n) => n.textContent).join(' | '));
  check('a save that fails while the next schedule is on its way is said in a toast (UX-016)', /Could not save the schedule \(UX-016 test\)/.test(toldSwitch), toldSwitch);
  await pillOf(0);
  await page.waitForTimeout(1200);

  await page.click('#taskpane-close');
  check('its close button gives the panel back', await page.evaluate(() => document.getElementById('taskpane').hidden));
  // The side area was closed before the task opened, so one close ends both —
  // not the task, then the plan it had been covering.
  const detailNow = await page.evaluate(() => document.getElementById('app').classList.contains('is-detail'));
  check('one close, not two: the side area is left as it was found', detailNow === detailWasOpen, `before ${detailWasOpen}, after ${detailNow}`);

  await store.deleteTask(user.id, task.id);
  await store.deleteTask(user.id, other.id);
}

/**
 * A step says what it did, and keeps the exact call for whoever opens it.
 *
 * Every tool outside the browser and desktop families used to draw its own
 * function name and a blob of JSON — `skill_read {"name":"Writing a Word
 * document"}` — in the middle of a transcript that is otherwise in sentences.
 * `test/i18n.test.mjs` proves every tool in the catalogue now has a verb; this
 * proves the words come out right for the arguments a model actually sends,
 * including the ones it gets wrong, and that nothing was lost in the move.
 */
section('a tool step reads as a sentence, with the call still inside it');
{
  const words = await page.evaluate(async () => {
    const { describeStep } = await import('/js/render.js');
    const said = (name, input) => describeStep(name, input);
    return {
      skill: said('skill_read', { name: 'Writing a Word document' }),
      command: said('run_command', { command: 'npm test' }).detail,
      page: said('web_fetch', { url: 'https://www.pv-magazine.com/2026/04/23/eu-moves' }).detail,
      query: said('web_search', { query: 'luật thương mại quốc tế' }).detail,
      deep: said('read_file', { path: 'a/very/long/workspace/path/that/goes/on/and/on/and/on/report-final.docx' }).detail,
      missing: said('read_file', {}).detail,
      mistyped: said('load_tools', { names: 'web_fetch' }).verb,
      nulled: said('grep', { pattern: null }).verb,
      unknown: said('invented_tool', { a: 1 }).verb,
    };
  });

  check('a skill read is "Read a guide", not "skill_read"', words.skill.verb === 'Read a guide', words.skill.verb);
  check('and the skill it read is the detail', words.skill.detail === 'Writing a Word document', words.skill.detail);
  check('a command shows the command', words.command === 'npm test', words.command);
  check('a page shows its host and path, not the scheme', words.page === 'pv-magazine.com/2026/04/23/eu-moves', words.page);
  check('a search shows the query, Vietnamese intact', words.query === 'luật thương mại quốc tế', words.query);
  // A long path is clipped from the front: the filename is the half anybody is
  // reading for, and clipping from the end is what removes it.
  check('a long path keeps its filename', /report-final\.docx$/.test(words.deep), words.deep);
  check('and says it was clipped', words.deep.startsWith('…'), words.deep);
  // The model chooses these arguments, so every shape it can get wrong has to
  // land somewhere sane rather than throwing inside the transcript renderer.
  check('a missing argument is blank, not "undefined"', words.missing === '', words.missing);
  check('a wrongly-typed argument does not throw', words.mistyped === 'Loaded more tools', words.mistyped);
  check('and neither does a null one', words.nulled === 'Searched in files', words.nulled);
  check('a tool nobody has named yet still renders', words.unknown === 'invented_tool', words.unknown);

  // The other half of the bargain: the function name and its arguments moved
  // inside the card rather than going away.
  const card = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    const host = turn.node;
    document.body.append(host);
    const handle = turn.startTool({ id: 'c1', name: 'skill_read', input: { name: 'Writing a Word document' } });
    handle.complete({ content: 'the guide', ms: 2 });
    const block = host.querySelector('.block.tool');
    const out = {
      headline: block?.querySelector('.tool__name')?.textContent,
      badge: !!block?.querySelector('.tool__fn'),
      fn: block?.querySelector('.tool__call')?.title,
      args: block?.querySelector('.tool__args')?.textContent,
      result: block?.querySelector('.block__body > pre')?.textContent,
    };
    host.remove();
    return out;
  });

  check('the card is headlined in words', card.headline === 'Read a guide', card.headline);
  // The grey name badge was removed at the user's request (it repeated the
  // headline); the exact name stays reachable on the tooltip.
  check('no grey name badge in the card', !card.badge);
  check('the real tool name is still on it, as the tooltip', card.fn === 'skill_read', card.fn);
  check('with the arguments it was given', /Writing a Word document/.test(card.args || ''), card.args);
  check('and the result is still there', card.result === 'the guide', card.result);
}

/**
 * The whole answer arrived on the reasoning channel. `server/agent.js` moves it
 * before storing, so a reload is already right; this is the live view catching
 * up, which is what the person watching the turn actually sees.
 */
section('pages read in consecutive steps share one card, and a failure is red');
{
  const got = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const host = document.createElement('div');
    document.body.append(host);
    const step = () => {
      const m = assistantMessage();
      host.append(m.node);
      return m;
    };
    const read = (m, url, ok) =>
      m.startTool({ name: 'web_fetch', input: { url } }).complete({ content: ok ? 'Page' : 'x.test returned HTTP 403', isError: !ok });
    // Each saved step is its own block, exactly as a live turn and a reload draw it.
    read(step(), 'https://x.test/a', false);
    read(step(), 'https://x.test/b', false);
    read(step(), 'https://x.test/c', false);
    const first = host.querySelectorAll('details.block.web').length;
    const card = host.querySelector('details.block.web');
    const mark = card?.querySelector('.web__mark .mark');
    const rows = card?.querySelectorAll('.webrow').length;
    const tip = card?.querySelector('.webrow.is-failed')?.title || '';
    // A reasoning card between is a real break: a new card.
    const t = step();
    t.appendThinking('Try the site directly.');
    t.finishThinking();
    read(t, 'https://x.test/d', true);
    const after = host.querySelectorAll('details.block.web').length;
    const markColour = getComputedStyle(mark).color;
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const dangerColour = getComputedStyle(probe).color;
    probe.remove();
    host.remove();
    return { first, rows, tip, after, markColour, dangerColour };
  });
  check('three reads in three steps are one card', got.first === 1 && got.rows === 3, JSON.stringify(got));
  check('a reasoning card between them starts a new one', got.after === 2, String(got.after));
  check('a card where every read failed is marked in red', got.markColour === got.dangerColour, `${got.markColour} vs ${got.dangerColour}`);
  check('and a failed page says why on hover', /HTTP 403/.test(got.tip), got.tip);
}

section('the reasoning card: a window on the newest lines, or the whole of it');
{
  const card = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    const host = document.createElement('div');
    host.style.width = '420px';
    host.append(turn.node);
    document.body.append(host);
    for (let i = 1; i <= 30; i += 1) turn.appendThinking(`Line ${i} of the reasoning.\n`);
    const node = host.querySelector('.think');
    const body = node.querySelector('.think__body');
    const head = node.querySelector('.think__head');
    const folded = {
      live: node.classList.contains('is-live'),
      short: body.clientHeight < body.scrollHeight,
      atEnd: body.scrollHeight - body.scrollTop - body.clientHeight < 4,
      glowing: node.querySelectorAll('.think__new').length > 0,
      expanded: head.getAttribute('aria-expanded'),
    };
    head.click();
    const open = { full: body.clientHeight >= body.scrollHeight - 1, expanded: head.getAttribute('aria-expanded') };
    head.click();
    turn.finishThinking();
    const done = {
      live: node.classList.contains('is-live'),
      tick: node.querySelector('.think__head .mark')?.textContent,
      glowing: node.querySelectorAll('.think__new').length,
      text: node.querySelector('.think__text').textContent.split('\n').filter(Boolean).length,
      atEnd: body.scrollHeight - body.scrollTop - body.clientHeight < 4,
    };
    host.remove();
    return { folded, open, done };
  });
  check('while thinking it is marked live', card.folded.live);
  check('folded, it is a short window', card.folded.short);
  check('showing the newest lines', card.folded.atEnd);
  check('with the words just arrived glowing', card.folded.glowing);
  check('and says it is folded', card.folded.expanded === 'false');
  check('opened, the whole trace shows', card.open.full && card.open.expanded === 'true', JSON.stringify(card.open));
  check('finished, it is ticked and no longer live', !card.done.live && card.done.tick === '✓', JSON.stringify(card.done));
  check('nothing is left glowing', card.done.glowing === 0);
  check('no words were lost settling the glow', card.done.text === 30, String(card.done.text));
  check('and folded again it rests on the last lines', card.done.atEnd);
}

section('a chat begun from a shelf says what it is setting up');
{
  const mode = await page.evaluate(async () => {
    const chip = document.getElementById('composer-mode');
    return { exists: !!chip, hidden: chip?.hidden };
  });
  check('the chip is in the composer, and hidden by default', mode.exists && mode.hidden === true, JSON.stringify(mode));
}

section('an answer that arrived as reasoning is shown as the answer');
{
  const shown = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    const host = turn.node;
    document.body.append(host);
    turn.appendThinking('Không, tôi không thể tạo 100 câu.');
    const hadBlock = !!host.querySelector('.think');
    turn.adoptThinkingAsReply('Không, tôi không thể tạo 100 câu.');
    const out = {
      hadBlock,
      stillFolded: !!host.querySelector('.think'),
      prose: host.querySelector('.prose')?.textContent?.trim(),
    };
    host.remove();
    return out;
  });

  check('it started out folded into the reasoning block', shown.hadBlock);
  check('the block is gone afterwards', !shown.stillFolded);
  check('and the answer is the reply', shown.prose === 'Không, tôi không thể tạo 100 câu.', shown.prose);
}

/**
 * Two conversations can answer at once, and leaving one does not kill it.
 *
 * Switching conversation used to abort the stream — which closes the socket,
 * which the server takes as "stop this run". So a glance at another chat killed
 * the work, and coming back showed a transcript frozen mid-thought that lurched
 * to the finished answer minutes later when something happened to reload it.
 *
 * A run now owns its own `stage` and every handler draws into that, so going
 * elsewhere only detaches an element. These checks are against the registry
 * that holds them, which is where the rule lives.
 */
/**
 * A project's shelf shows what is on it.
 *
 * It used to be a list of filenames: a project with four PDFs told you it had
 * four PDFs and nothing about which was the rubric. Every source now keeps the
 * file it came from — the bytes used to be read once and dropped — so a card
 * can show a picture, a press can open it, and the original can be handed back.
 */
section('a project source is a card you can open');
{
  /*
   * Its own project, on whichever account is signed in by now — an earlier
   * section switches accounts, and another account's project is rightly
   * invisible here.
   */
  await page.evaluate(async () => {
    const made = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shelf project' }),
    }).then((r) => r.json());
    const id = made.project.id;
    const post = (body) =>
      fetch(`/api/projects/${id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    await post({ name: 'rules.md', mime: 'text/markdown', data: btoa('The pass mark is 5.0.') });
    await post({
      name: 'diagram.gif',
      mime: 'image/gif',
      data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      // What `thumbnail.js` would have drawn, standing in for it: this is a
      // real browser, but Playwright cannot put a file through the picker here.
      thumb:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    });
  });

  // Through the interface rather than by calling `open()` directly: the shelf
  // is drawn when a project page opens, and that is the path being tested.
  await page.click('#open-projects');
  await page.waitForTimeout(900);
  await openProjectNamed('Shelf project');

  const drawn = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll('.shelf .card')];
    return {
      cards: cards.length,
      withPictures: cards.filter((c) => c.querySelector('.card__shot img')).length,
      badges: cards.map((c) => c.querySelector('.card__badge')?.textContent).filter(Boolean),
      // Nothing is selectable until somebody asks for it.
      barBeforePicking: !!document.querySelector('.shelf__bar'),
    };
  });

  check('every source on the shelf is a card', drawn.cards >= 2, JSON.stringify(drawn));
  check('the picture shows its picture', drawn.withPictures >= 1, `${drawn.withPictures}`);
  check('and every card says what kind it is', drawn.badges.length === drawn.cards, drawn.badges.join(','));
  // A row of checkboxes standing over a shelf nobody is editing is a hazard
  // offered to somebody who came to read.
  check('nothing offers to delete until asked', !drawn.barBeforePicking);

  const picking = await page.evaluate(async () => {
    const tick = document.querySelector('.shelf .card .card__tick');
    tick?.click();
    await new Promise((r) => setTimeout(r, 250));
    const bar = document.querySelector('.shelf__bar');
    const one = {
      bar: !!bar,
      count: bar?.querySelector('.shelf__count')?.textContent?.trim(),
      picked: document.querySelectorAll('.shelf .card.is-picked').length,
    };

    document.getElementById('pp-select-all')?.click();
    await new Promise((r) => setTimeout(r, 250));
    const all = {
      count: document.querySelector('.shelf__count')?.textContent?.trim(),
      picked: document.querySelectorAll('.shelf .card.is-picked').length,
      cards: document.querySelectorAll('.shelf .card').length,
    };

    document.getElementById('pp-end-select')?.click();
    await new Promise((r) => setTimeout(r, 250));
    return { one, all, closed: !document.querySelector('.shelf__bar') };
  });

  check('ticking one starts a selection', picking.one.bar && picking.one.picked === 1, JSON.stringify(picking.one));
  check('and the bar counts it', /1/.test(picking.one.count || ''), picking.one.count);
  check('select-all takes the whole shelf', picking.all.picked === picking.all.cards, JSON.stringify(picking.all));
  check('and closing puts it away without deleting anything', picking.closed);

  const preview = await page.evaluate(async () => {
    const card = [...document.querySelectorAll('.shelf .card')].find((c) => c.querySelector('.card__shot img'));
    card?.querySelector('.card__open')?.click();
    await new Promise((r) => setTimeout(r, 1200));
    const dialog = document.getElementById('source-view');
    const out = {
      open: dialog?.open === true,
      name: document.getElementById('source-view-name')?.textContent,
      big: !!dialog?.querySelector('.sourceview__figure img'),
      // The download is a real link with `download`, so the browser saves the
      // file instead of navigating away from the project.
      href: dialog?.querySelector('.sourceview__get')?.getAttribute('href'),
      saves: dialog?.querySelector('.sourceview__get')?.hasAttribute('download'),
    };
    dialog?.close();
    return out;
  });

  check('pressing a card opens it large', preview.open && preview.big, JSON.stringify(preview));
  check('titled with the file name', !!preview.name, preview.name);
  check('and the original is one press away', /^\/api\/attachments\//.test(preview.href || ''), preview.href);
  check('as a download rather than a navigation', preview.saves);
}

/**
 * A project's own scheduled work, and its file browser.
 *
 * Both hang off the project page built in the section above, which has already
 * created "Shelf project" on whichever account is signed in by now.
 */
/**
 * A project's conversations live under the project.
 *
 * Mixed into one flat list, a project was a folder you could put things in and
 * then never see the inside of: the shelf knew what was filed where, and the
 * sidebar — the thing actually used to move between conversations — did not.
 */
/**
 * A sidebar you glance at, and a scrollbar you can see.
 *
 * Two things that only go wrong once there is enough in the app to go wrong
 * with: a conversation list past about twenty rows stops being something you
 * glance at, and the dock painted over the transcript covered the one thing
 * that says where you are in a long one.
 */
/**
 * A file too big to send is shrunk rather than refused.
 *
 * There are two ceilings and only one is ours: the host refuses a request body
 * over about 4.5MB at the edge, before any of our code runs, with a plain-text
 * `Request Entity Too Large`. Base64 inflates bytes by a third on the way out,
 * so the real ceiling on a file was never the number the app printed — and what
 * reached the person was `Unexpected token 'R', "Request En"... is not valid
 * JSON`, which says nothing about the file they picked.
 */
/**
 * Both side panels can be dragged, and put back.
 *
 * A panel you can drag is a panel you can drag somewhere useless, so the way
 * back has to be as easy as the way out — hunting for the original width by eye
 * is a worse problem than the one dragging solved.
 */
section('the side panels can be dragged, and double-clicked back');
{
  const app = '.app';
  const widthOf = (name) =>
    page.evaluate(
      (n) => parseFloat(getComputedStyle(document.querySelector('.app')).getPropertyValue(n)),
      name === 'sidebar' ? '--sidebar-w' : '--detail-w',
    );

  const before = await widthOf('sidebar');
  check('the sidebar starts at its default', before === 288, `${before}`);

  const grip = await page.$('#sidebar-grip');
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  const dragged = await widthOf('sidebar');
  check('dragging its edge makes it wider', dragged > before + 60, `${before} → ${dragged}`);

  // And it is remembered, because somebody who widened it meant to.
  const saved = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('ai-remote:panel-widths') || '{}');
    } catch {
      return {};
    }
  });
  check('and remembered for next time', Math.round(saved.sidebar || 0) === Math.round(dragged), JSON.stringify(saved));

  await page.dblclick('#sidebar-grip');
  await page.waitForTimeout(250);
  const reset = await widthOf('sidebar');
  check('double-clicking puts it back', reset === 288, `${reset}`);

  // It cannot be dragged to nothing, or to swallow the window.
  const clamped = await page.evaluate(() => {
    const el = document.querySelector('.app');
    const grip = document.getElementById('sidebar-grip');
    const rect = grip.getBoundingClientRect();
    const send = (type, x) =>
      grip.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: rect.top + 10, button: 0, pointerId: 1 }));
    send('pointerdown', rect.left);
    send('pointermove', rect.left - 4000);
    send('pointerup', rect.left - 4000);
    return parseFloat(getComputedStyle(el).getPropertyValue('--sidebar-w'));
  });
  check('and never past its minimum', clamped >= 180, `${clamped}`);

  await page.dblclick('#sidebar-grip');
  await page.waitForTimeout(200);

  // A separator a keyboard cannot reach is one more thing that works for most
  // people rather than everybody.
  const reachable = await page.evaluate(() => {
    const grip = document.getElementById('sidebar-grip');
    return { role: grip.getAttribute('role'), focusable: grip.tabIndex >= 0, labelled: !!grip.getAttribute('aria-label') };
  });
  check('the handle is a separator a keyboard can reach', reachable.role === 'separator' && reachable.focusable, JSON.stringify(reachable));
  check('and it says what it is', reachable.labelled);

  void app;
}

/**
 * The accent moved from one flat green to a gradient that drifts.
 *
 * One line kept its old colours on purpose — the opening question is the first
 * thing anybody sees and it was already right — so it is held in tokens of its
 * own, where a future change to the accent cannot drag it along by accident.
 */
section('the accent is a galaxy, except where it should not be');
{
  const paint = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const heading = document.querySelector('.empty h2');
    return {
      accent: root.getPropertyValue('--accent').trim(),
      galaxy: root.getPropertyValue('--galaxy').trim(),
      welcome: root.getPropertyValue('--welcome-1').trim(),
      headingPaint: heading ? getComputedStyle(heading).backgroundImage : '',
    };
  });

  // The two greens the accent used to be — one per theme. Which of them is in
  // play depends on the browser's own setting, which the suite does not fix.
  const OLD_GREENS = { '#5ee6a8': '94, 230, 168', '#10855a': '16, 133, 90' };

  check('there is a gradient to wear', /linear-gradient/.test(paint.galaxy), paint.galaxy.slice(0, 60));
  check('and the flat accent is no longer the old green', !(paint.accent in OLD_GREENS), paint.accent);
  check('the welcome keeps the colour it had', paint.welcome in OLD_GREENS, paint.welcome);
  // Read off the element rather than the token: what matters is that the
  // heading is still painted in the old green, however that is arranged.
  check(
    'and is still painted with it',
    paint.headingPaint.includes(OLD_GREENS[paint.welcome] || '\u0000'),
    paint.headingPaint.slice(0, 90),
  );

  /*
   * One ring on the composer, not two. Focus landed on the textarea, which took
   * the global `:focus-visible` outline — a hard rectangle inside the rounded
   * box that already had a glow of its own.
   */
  // Focused directly rather than clicked: by this point in the suite a sheet
  // or a shelf may be over the composer, and what is being checked is the focus
  // styling, not whether the box is reachable by pointer right now.
  await page.evaluate(() => document.getElementById('input')?.focus());
  await page.waitForTimeout(200);
  const rings = await page.evaluate(() => {
    const field = document.getElementById('input');
    const box = field.closest('.composer__box');
    return {
      focused: document.activeElement === field,
      outline: getComputedStyle(field).outlineStyle,
      // The ring is a masked layer over the glass, lit while focused.
      ringPaint: getComputedStyle(box, '::before').backgroundImage,
      ringLit: getComputedStyle(box, '::before').opacity,
      // The rule itself, for the case where focus cannot land here because a
      // sheet from an earlier section is over the composer.
      rule: [...document.styleSheets]
        .flatMap((sheet) => {
          try {
            return [...sheet.cssRules];
          } catch {
            return [];
          }
        })
        .filter((r) => r.selectorText === '.composer__box::before')
        .map((r) => r.cssText)
        .join(''),
    };
  });
  check('the field inside draws no second outline', rings.outline === 'none', rings.outline);
  check(
    'while the rounded box wears the gradient',
    rings.focused
      ? /gradient/.test(rings.ringPaint) && rings.ringLit === '1'
      : /var\(--galaxy\)|gradient/.test(rings.rule),
    rings.focused
      ? `${rings.ringPaint.slice(0, 60)} at opacity ${rings.ringLit}`
      : `not focused; rule says ${rings.rule.slice(0, 60)}`,
  );
}

section('a citation chip opens its list of sources');
{
  const out = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const { rememberSearch } = await import('/js/cite.js');
    rememberSearch('1. Files API - Upload and Manage Workspace Files\n   https://openrouter.ai/a\n   The maximum file size is 100 MiB.');
    const host = document.createElement('div');
    host.className = 'prose';
    // Pinned on top: the app fills the viewport, so a node appended to the end
    // of the body is below the fold, where a mouse cannot reach it.
    host.style.cssText = 'position:fixed;top:80px;left:80px;z-index:2000;width:600px;background:var(--bg)';
    host.innerHTML = renderMarkdown(
      'Giới hạn. ([OpenRouter](https://openrouter.ai/a), [OpenRouter](https://openrouter.ai/b), [Reddit](https://reddit.com/r/x), [Tong_hop.docx])',
    );
    document.body.append(host);
    const chip = host.querySelector('.cite');
    const rect = chip.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, marks: chip.querySelectorAll('.cite__marks > *').length, text: chip.textContent.replace(/\s+/g, ' ') };
  });
  check('one mark per site or file kind', out.marks === 3, String(out.marks));

  // Level with the words around it — with a logo, with none that loaded, and
  // a bare file citation. It sat a few pixels low when its baseline came from
  // a logo that failed to load.
  const level = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const host = document.createElement('div');
    host.className = 'prose';
    host.style.cssText = 'position:fixed;top:300px;left:80px;z-index:2000;width:900px';
    host.innerHTML = renderMarkdown(
      [
        'Chữ trước ([Library of Congress TOC](https://no-such-host.invalid/toc)) chữ sau.',
        '',
        'Chữ trước [SLIDE-DTTC_Gốc.txt, tr.32–46] chữ sau.',
        '',
        'Chữ trước ([OpenRouter](https://openrouter.ai/a)) chữ sau.',
      ].join('\n'),
    );
    document.body.append(host);
    await new Promise((r) => setTimeout(r, 600));
    const out = [...host.querySelectorAll('p')].map((p) => {
      const chip = p.querySelector('.cite').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(p.firstChild);
      const text = range.getBoundingClientRect();
      return Math.round(((chip.top + chip.bottom) / 2 - (text.top + text.bottom) / 2) * 10) / 10;
    });
    host.remove();
    return out;
  });
  check('the chip is centred on its line of text', level.every((d) => Math.abs(d) <= 1), `offsets ${level.join(', ')}px`);

  await page.mouse.move(out.x, out.y);
  await page.waitForSelector('.cite-pop:not([hidden])', { timeout: 2000 }).catch(() => null);
  const card = await page.evaluate(() => {
    const pop = document.querySelector('.cite-pop');
    return {
      open: !!pop && !pop.hidden,
      items: pop?.querySelectorAll('.cite-item').length,
      links: [...(pop?.querySelectorAll('a.cite-item') || [])].map((a) => a.getAttribute('href')),
      title: pop?.querySelector('.cite-item__title')?.textContent,
      snippet: pop?.querySelector('.cite-item__snip')?.textContent,
      fileIsLink: !!pop?.querySelector('a.cite-item--file'),
    };
  });
  check('hovering opens the card', card.open);
  check('listing all four sources', card.items === 4, String(card.items));
  check('the pages link to where they were read', card.links.join() === 'https://openrouter.ai/a,https://openrouter.ai/b,https://reddit.com/r/x', card.links.join());
  check('with the title the search gave', card.title === 'Files API - Upload and Manage Workspace Files', card.title);
  check('and its summary', card.snippet === 'The maximum file size is 100 MiB.', card.snippet);
  check('a file is named, not linked', !card.fileIsLink);

  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => document.querySelector('.cite-pop')?.hidden);
  check('moving away closes it', closed === true);

  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('.prose .cite')?.closest('.prose')?.remove());

  // UX-007: a pinned card follows its chip when the transcript scrolls under it,
  // and goes only when the chip leaves the view.
  const scroll = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const box = document.createElement('div');
    box.className = 'prose';
    box.style.cssText = 'position:fixed;top:80px;left:80px;z-index:2000;width:600px;height:300px;overflow:auto;background:var(--bg)';
    box.innerHTML = `${renderMarkdown('Một câu. ([OpenRouter](https://openrouter.ai/a))')}<div style="height:2000px"></div>`;
    document.body.append(box);
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    box.querySelector('.cite').click();
    await frame();
    const pop = /** @type {HTMLElement} */ (document.querySelector('.cite-pop'));
    const before = pop.getBoundingClientRect().top;
    box.scrollTop = 20;
    await frame();
    const after = { open: !pop.hidden, moved: Math.round(before - pop.getBoundingClientRect().top) };
    box.scrollTop = 600;
    await frame();
    const gone = pop.hidden;
    box.remove();
    return { ...after, gone };
  });
  check('a pinned card stays open while the transcript scrolls a little', scroll.open, JSON.stringify(scroll));
  check('  moving with its chip', scroll.moved === 20, JSON.stringify(scroll));
  check('  and closes once the chip has scrolled out of view', scroll.gone, JSON.stringify(scroll));

  // UX-009: in the reply being written, the prose is rewritten every frame and the
  // chip with it. A pinned card follows the chip that replaced it, and closes only
  // once no chip at that place cites the same sources.
  const streaming = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:80px;left:80px;z-index:2000;width:600px;height:300px;overflow:auto;background:var(--bg)';
    const prose = document.createElement('div');
    prose.className = 'prose';
    box.append(prose);
    document.body.append(box);
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const said = 'Một câu. ([OpenRouter](https://openrouter.ai/a))';
    prose.innerHTML = `${renderMarkdown(said)}<div style="height:2000px"></div>`;
    prose.querySelector('.cite').click();
    await frame();
    const pop = /** @type {HTMLElement} */ (document.querySelector('.cite-pop'));
    // The next streamed frame: the same words and more, drawn afresh.
    prose.innerHTML = `${renderMarkdown(`${said} Câu tiếp theo đang được viết`)}<div style="height:2000px"></div>`;
    box.scrollTop = 10;
    await frame();
    const kept = { open: !pop.hidden, expanded: prose.querySelector('.cite')?.getAttribute('aria-expanded') };
    // A frame where that citation is no longer there.
    prose.innerHTML = `${renderMarkdown('Một câu khác, không trích dẫn.')}<div style="height:2000px"></div>`;
    box.scrollTop = 20;
    await frame();
    const gone = pop.hidden;
    box.remove();
    return { ...kept, gone };
  });
  check('a card pinned on the reply being written survives its repaint (UX-009)', streaming.open && streaming.expanded === 'true', JSON.stringify(streaming));
  check('  and closes once that citation is no longer there', streaming.gone, JSON.stringify(streaming));

  // A source the conversation cannot account for is marked, on the chip and in the card.
  const audit = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const { setCitationEvidence, auditCitations } = await import('/js/cite.js');
    setCitationEvidence(() => ({ files: ['TESTBANK-DTTC.pdf'], text: '' }));
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('Có [TESTBANK-DTTC.pdf]. Và [Chap099-bia.pdf, tr.4].');
    document.body.append(host);
    auditCitations(host);
    const [real, invented] = host.querySelectorAll('.cite');
    const out = {
      realMarked: real.classList.contains('cite--unseen'),
      inventedMarked: invented.classList.contains('cite--unseen'),
      warning: invented.querySelector('.cite-item__warn')?.textContent || '',
      dot: getComputedStyle(invented, '::after').backgroundColor,
    };
    host.remove();
    // Hand the check back to nothing: later sections draw replies of their own.
    setCitationEvidence(null);
    return out;
  });
  check('a file that was given is not marked', !audit.realMarked);
  check('one nobody gave is', audit.inventedMarked);
  check('and its card says so in words', audit.warning.length > 20, audit.warning);
  check('with a dot on the chip', audit.dot && audit.dot !== 'rgba(0, 0, 0, 0)', audit.dot);
}

section('an oversized upload is made to fit, or refused in words');
{
  const out = await page.evaluate(async () => {
    const { prepareUpload, MAX_UPLOAD_BYTES } = await import('/js/shrink.js');

    /** A real JPEG of a given pixel size, as a File. */
    const photo = async (edge) => {
      const canvas = document.createElement('canvas');
      canvas.width = edge;
      canvas.height = edge;
      const ctx = canvas.getContext('2d');
      // Noise rather than a flat fill: a solid colour compresses to nothing and
      // would never exercise the size path at all.
      const image = ctx.createImageData(edge, edge);
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = Math.random() * 255;
        image.data[i + 1] = Math.random() * 255;
        image.data[i + 2] = Math.random() * 255;
        image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 1));
      return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    };

    const small = new File([new Uint8Array(1024)], 'notes.txt', { type: 'text/plain' });
    const untouched = await prepareUpload(small);

    const big = await photo(4000);
    const shrunk = big.size > MAX_UPLOAD_BYTES ? await prepareUpload(big) : null;

    // Something nothing can shrink honestly: a .pptx is already a zip.
    const deck = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1024)], 'slides.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    let refused = null;
    try {
      await prepareUpload(deck);
    } catch (err) {
      refused = err.message;
    }

    // PERF-021: the big photo is shrunk first, and its thumbnail drawn from the shrunk copy.
    const { preparedWithThumb } = await import('/js/shrink.js');
    const { thumbnailFor } = await import('/js/thumbnail.js');
    // The thumbnail being handed the shrunk copy is the proof of order: that
    // copy does not exist until preparing has finished.
    const seen = [];
    const [readyBig, drawnBig] = await preparedWithThumb(big, async (f) => {
      seen.push({ size: f.size, type: f.type });
      return thumbnailFor(f);
    });

    const bytesOf = (b64) => Math.floor((b64.length * 3) / 4);
    return {
      oneAtATime: seen.length === 1 && seen[0].size === atob(readyBig.data).length && seen[0].size < big.size && seen[0].type === 'image/jpeg',
      seen,
      thumbDrawn: /^data:image\/jpeg;base64,/.test(drawnBig?.thumb || ''),
      limit: MAX_UPLOAD_BYTES,
      // A small file is passed through: nothing is re-encoded for the sake of
      // it, because a 200KB PNG through a JPEG round trip comes out worse.
      untouchedName: untouched.name,
      untouchedNote: untouched.note,
      bigBytes: big.size,
      shrunkTo: shrunk ? bytesOf(shrunk.data) : null,
      shrunkName: shrunk?.name,
      shrunkKind: shrunk?.note?.kind,
      refused,
    };
  });

  check('a file that already fits is passed through', out.untouchedName === 'notes.txt' && out.untouchedNote === null, out.untouchedName);
  check('the test photo really is over the limit', out.bigBytes > out.limit, `${out.bigBytes} > ${out.limit}`);
  check('an oversized photo is re-encoded to fit', out.shrunkTo !== null && out.shrunkTo <= out.limit, `${out.shrunkTo}`);
  check('and says it was resized', out.shrunkKind === 'image', String(out.shrunkKind));
  check('under a name that matches what was sent', out.shrunkName === 'photo.jpg', out.shrunkName);
  check('its thumbnail is drawn from the shrunk copy, not by decoding the original again (PERF-021)', out.oneAtATime, JSON.stringify(out.seen));
  check('  and is still drawn', out.thumbDrawn);
  // Nothing can shrink a deck honestly, so the refusal names the file, its
  // size, what fits, and what to do — rather than a JSON parse error.
  check('what cannot be shrunk is refused in words', /slides\.pptx/.test(out.refused || ''), out.refused);
  check('naming the limit', /MB/.test(out.refused || ''), out.refused);

  /*
   * And a non-JSON error from the edge reads as what it is. This is the exact
   * body a host returns when it refuses an oversized request.
   */
  const spoken = await page.evaluate(async () => {
    const real = window.fetch;
    window.fetch = async () => new Response('Request Entity Too Large', { status: 413 });
    try {
      const { api } = await import('/js/api.js');
      await api.chats();
      return 'no error at all';
    } catch (err) {
      return err.message;
    } finally {
      window.fetch = real;
    }
  });
  check('a plain-text 413 is not a JSON parse error', !/JSON/.test(spoken), spoken);
  check('it says the request was too large', /too large/i.test(spoken), spoken);
}

section('the sidebar stays a list you can glance at');
{
  // Twenty-five loose conversations, which is past where a list stops being
  // scannable and starts being something you scroll.
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(
        (r) => r.json(),
      );
    for (let i = 0; i < 25; i += 1) {
      const { chat } = await post('/api/chats', {});
      await post(`/api/chats/${chat.id}/messages`, { text: `filler ${i}` });
    }
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);

  const list = await page.evaluate(() => {
    const el = document.getElementById('chat-list');
    const label = el.querySelector('.chats__label');
    const style = label ? getComputedStyle(label) : null;
    return {
      rows: el.querySelectorAll('.chat-row').length,
      more: el.querySelector('.chats__more')?.textContent,
      scrolls: el.scrollHeight > el.clientHeight + 1,
      /**
       * The heading scrolls away with its own section, and paints nothing.
       *
       * This pair used to assert the opposite: `position: sticky` plus a
       * background opaque enough that rows could not be read through the
       * letters as they passed underneath. That was right while the sidebar
       * had a surface of its own.
       *
       * It does not any more — the galaxy is behind it — so the background the
       * stickiness required was a band of flat colour laid over the sky, there
       * at rest, when there was nothing underneath to hide. Translucent made it
       * grey, opaque made it black, and both were a stripe the owner could see
       * and did not want.
       *
       * So the stickiness went, which removes the reason for the background
       * rather than hunting for a colour that disappears. The cost was named
       * and accepted: scrolled deep into a long list there is no heading
       * pinned above you saying which section you are in. These two checks now
       * hold that decision in place — if either starts failing, someone has
       * put the band back.
       */
      sticky: style?.position,
      transparent: style?.backgroundColor === 'rgba(0, 0, 0, 0)',
    };
  });

  check('it scrolls once there is more than fits', list.scrolls);
  check('the headings scroll away with their section', list.sticky !== 'sticky', String(list.sticky));
  check('and paint no band over the galaxy behind them', list.transparent, String(list.sticky));
  // Twenty of the loose ones, plus whatever is nested under a project — those
  // are not part of the flat list this caps.
  check('at most twenty loose conversations are listed', list.rows <= 24, `${list.rows}`);
  check('with a way to the rest', /View all/.test(list.more || ''), list.more);

  const all = await page.evaluate(async () => {
    document.querySelector('.chats__more')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const el = document.getElementById('chat-list');
    return { rows: el.querySelectorAll('.chat-row').length, more: el.querySelector('.chats__more')?.textContent };
  });
  check('which shows them all', all.rows > list.rows, `${list.rows} → ${all.rows}`);
  check('and offers to fold them back', /fewer/i.test(all.more || ''), all.more);

  /*
   * The transcript's scrollbar is not covered by the composer's gradient.
   *
   * The dock is painted over the thread and a classic scrollbar lives inside
   * the thread's own box, so a dock reaching the right edge hid the thumb —
   * most visibly when the conversation is long and the thumb is short and
   * sitting at the bottom, which is exactly when somebody looks for it.
   */
  const gap = await page.evaluate(() => {
    const thread = document.getElementById('thread');
    const dock = document.getElementById('dock');
    const bar = Math.round(thread.offsetWidth - thread.clientWidth);
    return {
      bar,
      // Zero on the overlay scrollbars macOS and phones use, where there is
      // nothing to uncover and nothing to inset.
      clear: bar === 0 || Math.round(thread.getBoundingClientRect().right - dock.getBoundingClientRect().right) >= bar,
    };
  });
  check('the dock stops short of the transcript scrollbar', gap.clear, `scrollbar ${gap.bar}px`);
}

section('the sidebar files a project\'s conversations under it');
{
  const made = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
        r.json(),
      );
    const { project } = await post('/api/projects', { name: 'Filed work' });
    // Pinned, because that is what puts a project in the sidebar now — an
    // unpinned one lives on the Projects shelf and nowhere else. This whole
    // section is about how the sidebar files conversations under a project, so
    // it needs one that is actually there.
    await fetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    const { chat } = await post('/api/chats', { projectId: project.id });
    await post(`/api/chats/${chat.id}/messages`, { text: 'inside the project' });
    const { chat: loose } = await post('/api/chats', {});
    await post(`/api/chats/${loose.id}/messages`, { text: 'outside any project' });
    return { project: project.id, name: project.name, filed: chat.id, loose: loose.id };
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);

  const shelf = await page.evaluate((ids) => {
    const list = document.getElementById('chat-list');
    const headings = [...list.querySelectorAll('.chats__label')].map((n) => n.textContent);
    const projectRow = [...list.querySelectorAll('.proj-row__name')].map((n) => n.textContent.trim());
    const filed = list.querySelector(`.chat-row[data-chat="${ids.filed}"]`);
    const loose = list.querySelector(`.chat-row[data-chat="${ids.loose}"]`);
    return {
      headings,
      projectRow,
      // The filed one is nested under its project heading; the loose one is not.
      filedNested: filed?.classList.contains('chat-row--nested'),
      looseNested: loose?.classList.contains('chat-row--nested'),
      // Open by default: a sidebar that hides conversations until you find the
      // right heading to click has lost the list it exists to be.
      filedVisible: !!filed,
      // And the project's heading comes before the ordinary conversations.
      projectFirst: headings.indexOf('Projects') < headings.indexOf('Conversations'),
    };
  }, made);

  check('projects get their own heading', shelf.headings.includes('Projects'), shelf.headings.join(','));
  check('above the ordinary conversations', shelf.projectFirst, shelf.headings.join(','));
  check('the project is listed by name', shelf.projectRow.includes('Filed work'), shelf.projectRow.join(','));
  check('its conversation is open by default', shelf.filedVisible);
  check('and nested under it', shelf.filedNested === true);
  check('while one in no project is not', shelf.looseNested === false);

  // Folding a project shut is a deliberate act, and it sticks across a refresh.
  await page.evaluate(() => document.querySelector('.proj-row__name')?.click());
  await page.waitForTimeout(600);
  const folded = await page.evaluate(
    (ids) => ({
      gone: !document.querySelector(`.chat-row[data-chat="${ids.filed}"]`),
      stillListed: !!document.querySelector('.proj-row'),
      said: document.querySelector('.proj-row__name')?.getAttribute('aria-expanded'),
    }),
    made,
  );
  check('folding a project hides its conversations', folded.gone);
  check('without hiding the project', folded.stillListed);
  check('and says so for a screen reader', folded.said === 'false', folded.said);

  await page.evaluate(() => document.querySelector('.proj-row__name')?.click());
  await page.waitForTimeout(600);

  /*
   * The chevron beside the title offers the same list as the row's ⋮, built
   * from one description — two hand-written copies is how one of them ends up
   * missing "Remove from project" for a year.
   */
  await page.evaluate((ids) => document.querySelector(`.chat-row[data-chat="${ids.filed}"] .chat-item`)?.click(), made);
  await page.waitForTimeout(900);

  const header = await page.evaluate(() => ({
    crumb: document.getElementById('chat-project')?.textContent,
    crumbShown: document.getElementById('chat-project')?.hidden === false,
    chevron: document.getElementById('chat-menu')?.hidden === false,
  }));
  check('an open project conversation names its project in the header', header.crumbShown && header.crumb === 'Filed work', header.crumb);
  check('and offers a menu beside the title', header.chevron);

  await page.click('#chat-menu');
  await page.waitForTimeout(350);
  const chev = await page.evaluate(() => ({
    items: [...document.querySelectorAll('#row-menu .menu__item span:first-of-type')].map((n) => n.textContent),
  }));
  // Schedule rather than "Open in new window": the conversation is already
  // open, so the useful offer is work like this, later.
  check('the title menu leads with Schedule', chev.items[0] === 'Schedule', chev.items.join(' '));
  check('and can take it out of its project', chev.items.includes('Remove from project'), chev.items.join(' '));

  // Change project opens a searchable panel beside the menu, with a tick on
  // the one it is already in.
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll('#row-menu .menu__item')].find(
      (el) => el.querySelector('span')?.textContent === 'Change project',
    );
    hit?.click();
  });
  await page.waitForTimeout(400);

  const picker = await page.evaluate(() => {
    const sub = document.querySelector('.menu--sub');
    const rows = [...(sub?.querySelectorAll('.menu__item') || [])].map((el) => el.querySelector('span')?.textContent);
    const find = sub?.querySelector('.menu__find');
    return {
      open: sub && !sub.hidden,
      rows,
      placeholder: find?.getAttribute('placeholder'),
      ticked: [...(sub?.querySelectorAll('.menu__item') || [])]
        .filter((el) => el.getAttribute('aria-checked') === 'true')
        .map((el) => el.querySelector('span')?.textContent),
    };
  });
  check('Change project opens a panel beside the menu', picker.open);
  check('listing the projects', picker.rows.includes('Filed work'), picker.rows.join(','));
  check('with a tick on the one it is in', picker.ticked.join(',') === 'Filed work', picker.ticked.join(','));
  check('and a box that searches or creates', /create/i.test(picker.placeholder || ''), picker.placeholder);

  // Typing a name nothing matches offers to make it — one road to a new
  // project rather than two, so neither goes stale.
  const offered = await page.evaluate(async () => {
    const find = document.querySelector('.menu--sub .menu__find');
    find.value = 'Somewhere else';
    find.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll('.menu--sub .menu__item span:first-of-type')].map((n) => n.textContent);
  });
  check('a name nothing matches offers to create it', offered.some((n) => /Somewhere else/.test(n)), offered.join(' | '));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

section('a project schedules its own work, and can find its own files');
{
  const made = await page.evaluate(async () => {
    const projects = (await (await fetch('/api/projects')).json()).projects;
    const project = projects.find((p) => p.name === 'Shelf project') || projects[0];
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Daily digest',
        prompt: 'Say what changed.',
        frequency: 'manual',
        policy: 'ask',
        projectId: project.id,
        tz: 'Asia/Ho_Chi_Minh',
      }),
    });
    return { ok: res.status === 201, id: (await res.json()).task?.id, project: project.id };
  });
  check('a task can be filed under the project', made.ok);

  // Re-open the project so its Scheduled section is drawn with the new task.
  await page.click('#open-projects');
  await page.waitForTimeout(700);
  await openProjectNamed('Shelf project');

  const side = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#project-page-side .panel-card__name')].map((n) => n.textContent),
    rows: [...document.querySelectorAll('.ptask')].map((r) => ({
      name: r.querySelector('.ptask__name')?.textContent,
      when: r.querySelector('.ptask__when')?.textContent,
      state: r.querySelector('.ptask__state')?.textContent,
    })),
    finder: !!document.getElementById('pp-find-source'),
    add: !!document.getElementById('pp-add-task'),
  }));

  check('the project has a Scheduled section', side.cards.includes('Scheduled'), side.cards.join(','));
  check('with the task in it', side.rows[0]?.name === 'Daily digest', JSON.stringify(side.rows));
  // "Manual only" is a real answer rather than a blank: nothing happens until
  // somebody presses Run now.
  check('saying it only runs by hand', side.rows[0]?.when === 'Manual only', side.rows[0]?.when);
  check('and that it is on', side.rows[0]?.state === 'Active', side.rows[0]?.state);
  check('there is a way to add another', side.add);

  // Pressing it opens the task on its own page.
  await page.click('.ptask');
  await page.waitForTimeout(900);
  const detail = await page.evaluate(() => ({
    title: document.getElementById('page-title')?.textContent,
    state: document.querySelector('.taskpage__state')?.textContent?.trim(),
    run: !!document.querySelector('#page-body [data-task="run"]'),
    drop: !!document.querySelector('#page-body [data-task="drop"]'),
    edit: !!document.querySelector('#page-body [data-task="edit"]'),
    labels: [...document.querySelectorAll('.taskpage__facts dt')].map((d) => d.textContent),
    prompt: document.querySelector('.taskpage__prompt')?.textContent,
    project: document.querySelector('#page-body [data-task="project"]')?.textContent,
    // A page about one thing has nothing to sort and no second one to make.
    quiet: document.getElementById('page-new')?.hidden === true,
  }));

  check('a task opens on its own page', detail.title === 'Daily digest', detail.title);
  check('marked active', detail.state === 'Active', detail.state);
  check('with the instructions it will follow', detail.prompt === 'Say what changed.', detail.prompt);
  check('the project it answers from', detail.project === 'Shelf project', detail.project);
  check('how often it repeats and what it may do', detail.labels.includes('Repeats') && detail.labels.includes('Permissions'), detail.labels.join(','));
  check('a way to run it now', detail.run);
  check('a way to delete it', detail.drop);
  check('and a pencil to edit it', detail.edit);
  check('and no shelf furniture on a page about one thing', detail.quiet);

  /*
   * Scheduled work is not listed in the sidebar: a handful of tasks pushed the
   * conversation history off the screen. It lives on the Scheduled page.
   */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(900);
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll('.sidebar .chat-item')].some((b) => b.textContent === 'Daily digest'),
  );
  check('scheduled work does not crowd the conversation list', listed === false);

  // And the shelf can be searched when it has outgrown being browsed.
  await page.click('#open-projects');
  await page.waitForTimeout(700);
  await openProjectNamed('Shelf project');
  await page.click('#pp-find-source');
  await page.waitForTimeout(500);

  const browse = await page.evaluate(async () => {
    const dialog = document.getElementById('context-browse');
    const rows = () => [...document.querySelectorAll('.browse__row')].map((r) => r.textContent);
    const before = rows();

    const find = document.getElementById('context-browse-find');
    find.value = 'diagram';
    find.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    const filtered = rows();

    document.querySelector('.browse__row')?.click();
    await new Promise((r) => setTimeout(r, 200));
    const view = {
      name: document.querySelector('.browse__name')?.textContent,
      picture: !!document.querySelector('.browse__figure img'),
      href: document.querySelector('.browse__view a')?.getAttribute('href'),
      saves: document.querySelector('.browse__view a')?.hasAttribute('download'),
    };

    const out = { open: dialog?.open === true, before, filtered, view, count: document.getElementById('context-browse-count')?.textContent };
    dialog?.close();
    return out;
  });

  check('the magnifier opens a searchable list', browse.open && browse.before.length >= 2, JSON.stringify(browse.before));
  check('counting what is on the shelf', /item/.test(browse.count || ''), browse.count);
  check('typing narrows it', browse.filtered.length === 1 && /diagram/.test(browse.filtered[0]), browse.filtered.join(','));
  check('choosing one shows it', browse.view.name === 'diagram.gif' && browse.view.picture, JSON.stringify(browse.view));
  check('with the original one press away', /^\/api\/attachments\//.test(browse.view.href || '') && browse.view.saves, browse.view.href);
}

section('a run survives leaving its conversation, and two can run at once');
{
  const out = await page.evaluate(async () => {
    const { createRuns } = await import('/js/runs.js');
    let open = 'a';
    const runs = createRuns({ currentChatId: () => open });
    const host = document.createElement('div');
    document.body.append(host);

    const a = runs.start('a');
    a.stage.append(Object.assign(document.createElement('p'), { textContent: 'half an answer' }));
    runs.show(a, host);
    const drawnWhileOpen = host.textContent;

    // Look at another conversation. The run carries on; only its nodes leave.
    runs.hide(a);
    open = 'b';
    const afterLeaving = { inHost: host.textContent, stillRunning: runs.has('a') };

    // And a second conversation starts answering while the first still is.
    const b = runs.start('b');
    b.stage.append(Object.assign(document.createElement('p'), { textContent: 'a different answer' }));
    runs.show(b, host);
    const both = { count: runs.size, shown: host.textContent };

    // The first run kept streaming into its own stage the whole time.
    a.stage.append(Object.assign(document.createElement('p'), { textContent: ' and the rest' }));
    const leakedIntoB = host.textContent.includes('and the rest');

    // Come back to it.
    runs.hide(b);
    open = 'a';
    runs.show(runs.get('a'), host);

    const result = {
      drawnWhileOpen,
      afterLeaving,
      both,
      leakedIntoB,
      onReturn: host.textContent,
      queuesAreSeparate: runs.get('a').queue !== runs.get('b').queue,
      secondRunRefused: runs.start('a') === null,
    };
    host.remove();
    return result;
  });

  check('a running conversation draws while it is on screen', out.drawnWhileOpen === 'half an answer', out.drawnWhileOpen);
  check('leaving takes its nodes off the page', out.afterLeaving.inHost === '', out.afterLeaving.inHost);
  check('but the run is still going', out.afterLeaving.stillRunning);
  check('a second conversation can answer at the same time', out.both.count === 2, String(out.both.count));
  check('and only its own words are on screen', out.both.shown === 'a different answer', out.both.shown);
  // The bug this whole shape exists to prevent: one conversation's stream
  // appending into the transcript of another.
  check('what the first run kept writing never reached the second', !out.leakedIntoB);
  check('coming back shows everything it wrote while away', out.onReturn === 'half an answer and the rest', out.onReturn);
  check('each conversation keeps its own queue', out.queuesAreSeparate);
  // Within one conversation there is still exactly one loop; the caller queues.
  check('a second run in the same conversation is refused', out.secondRunRefused);
}

/**
 * One moving indicator per turn, not four.
 *
 * A turn can have a reasoning block, a run of steps and two tool cards open at
 * once, and each drew its own spinning ring while the status line under the
 * transcript was already saying, in words, which one was working.
 */
section('a working card is marked, not animated');
{
  const marks = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.body.append(turn.node);

    turn.appendThinking('mulling it over');
    const handle = turn.startTool({ id: 'c1', name: 'deep_research', input: { question: 'why' } });

    const working = {
      spinners: turn.node.querySelectorAll('.spinner').length,
      pending: turn.node.querySelectorAll('.mark--pending').length,
    };

    handle.complete({ content: 'found it', ms: 10 });
    turn.finishThinking();
    const done = {
      spinners: turn.node.querySelectorAll('.spinner').length,
      pending: turn.node.querySelectorAll('.mark--pending').length,
      ticks: [...turn.node.querySelectorAll('.mark')].filter((m) => m.textContent === '✓').length,
    };

    turn.node.remove();
    return { working, done };
  });

  check('a card in progress spins nothing', marks.working.spinners === 0, String(marks.working.spinners));
  check('it is marked as waiting instead', marks.working.pending === 2, String(marks.working.pending));
  check('finishing turns both marks into ticks', marks.done.ticks === 2, JSON.stringify(marks.done));
  check('and leaves nothing waiting', marks.done.pending === 0, String(marks.done.pending));
}

section('mathematics in a reply is drawn as mathematics');
{
  const failed = [];
  const onFail = (request) => {
    if (request.url().includes('/vendor/katex/')) failed.push(request.url());
  };
  page.on('requestfailed', onFail);
  const math = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const { loadMath } = await import('/js/math.js');
    const host = document.createElement('div');
    host.className = 'prose';
    document.body.append(host);
    const source = 'Công thức $\\frac{\\text{CF}_t}{(1+r)^t}$ và\n\n$$\\text{NPV} = \\sum_{t=1}^{5} PV_t - I_0$$';
    host.innerHTML = renderMarkdown(source);
    const pendingBefore = host.querySelectorAll('.math.is-pending').length;
    const loaded = await loadMath();
    await document.fonts.ready;
    const out = {
      pendingBefore,
      loaded,
      pendingAfter: host.querySelectorAll('.math.is-pending').length,
      typeset: host.querySelectorAll('.katex').length,
      display: host.querySelectorAll('.katex-display').length,
      fonts: [...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded'),
    };
    host.remove();
    return out;
  });
  page.off('requestfailed', onFail);
  check('a formula waits as a placeholder until KaTeX arrives', math.pendingBefore === 2, `${math.pendingBefore}`);
  check('KaTeX loads under the CSP', math.loaded === true);
  check('and every placeholder is typeset', math.pendingAfter === 0 && math.typeset === 2, `${math.pendingAfter} pending, ${math.typeset} typeset`);
  check('the $$ formula is a display formula', math.display === 1, `${math.display}`);
  check('its fonts load', math.fonts === true);
  check('nothing under /vendor/katex failed to load', failed.length === 0, failed.join(' '));
}

section('the sidebar lists pinned projects and no others');
{
  const made = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(
        (r) => r.json(),
      );
    // A project with a real conversation in it, left unpinned.
    const { project } = await post('/api/projects', { name: 'Unpinned work' });
    const { chat } = await post('/api/chats', { projectId: project.id });
    await post(`/api/chats/${chat.id}/messages`, { text: 'filed but not pinned' });
    return { project: project.id, chat: chat.id };
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);

  const hidden = await page.evaluate(
    (ids) => ({
      named: [...document.querySelectorAll('.proj-row__name')].map((n) => n.textContent),
      row: !!document.querySelector(`.chat-row[data-chat="${ids.chat}"]`),
      nested: !!document.querySelector(`.chat-row[data-chat="${ids.chat}"]`)?.classList.contains('chat-row--nested'),
    }),
    made,
  );

  /**
   * The rule this section exists for.
   *
   * Every project holding a conversation used to be listed here, so the
   * sidebar grew a second copy of the Projects page above the list it exists
   * to be — and the conversations underneath pushed the recent ones off the
   * screen. Pinning already means "this is what I am working on"; it decides
   * this too.
   */
  check('an unpinned project is not in the sidebar', !hidden.named.some((n) => /Unpinned work/.test(n)), hidden.named.join(','));
  /**
   * Its conversations still are, though — and that is the correction.
   *
   * The heading is filtered, not the work. This section used to assert the
   * opposite, and the two rules together lost conversations outright: the
   * heading list takes only pinned projects, the conversation list took only
   * chats with no project at all, and a conversation filed under an unpinned
   * project fell between them and appeared nowhere in the sidebar. The only
   * route back to it was Projects → the project → its list, which is not
   * something anybody would think to do to find a chat from this morning.
   *
   * Filing something is not hiding it.
   */
  check('but its conversations are, in the ordinary list', hidden.row === true);
  check('unnested, because no heading above them claims them', hidden.nested === false);
  // And the pinned one from earlier is still there, so this is a filter and
  // not the section quietly disappearing.
  check('while a pinned one still is', hidden.named.some((n) => /Filed work/.test(n)), hidden.named.join(','));

  // Pinning it puts it there, which is the way back for anyone who wants it.
  await page.evaluate(
    (ids) =>
      fetch(`/api/projects/${ids.project}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      }),
    made,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const shown = await page.evaluate(() => [...document.querySelectorAll('.proj-row__name')].map((n) => n.textContent));
  check('and pinning it is what brings it back', shown.some((n) => /Unpinned work/.test(n)), shown.join(','));
}

/* ── a question with buttons on it ──────────────────────────────
 *
 * The turn stops on `ask_options` and does not move until this is answered, so
 * what the card hands back *is* the user's answer as far as the model is
 * concerned. Driven directly rather than through a model: the point is what
 * pressing things produces, and a real model would make that the least
 * reliable part of the test rather than the thing under it.
 * ─────────────────────────────────────────────────────────────── */

section('a question card collects an answer');
{
  const out = await page.evaluate(async () => {
    const { createQuestionCard } = await import('/js/question.js');
    /** @type {any} */
    let sent = null;
    const card = createQuestionCard({ onAnswer: (a) => { sent = a; }, scrollToEnd: () => {} });

    card.show({
      toolCallId: 'q1',
      questions: [
        { question: 'Lĩnh vực nào?', options: [{ label: 'Tài chính' }, { label: 'AI' }, { label: 'Vận hành' }], multiple: true, other: true, otherLabel: 'Thêm lĩnh vực' },
        { question: 'Dài bao nhiêu?', options: [{ label: 'Ngắn' }, { label: 'Dài' }], multiple: false, other: false, otherLabel: '' },
      ],
    });

    const opts = () => [...document.querySelectorAll('#question-options .question__opt')];
    const go = () => /** @type {HTMLButtonElement} */ (document.getElementById('question-go'));
    const firstShown = {
      visible: !document.getElementById('question').hidden,
      title: document.getElementById('question-title').textContent,
      count: document.getElementById('question-count').textContent,
      options: opts().length,
      // Nothing chosen yet, so the way on is Skip rather than Next.
      goLabel: go().textContent,
      otherShown: !document.getElementById('question-otherrow').hidden,
      role: document.getElementById('question-options').getAttribute('role'),
    };

    // Two of three, because this question takes several.
    opts()[0].click();
    opts()[1].click();
    const afterTwo = {
      checked: opts().filter((o) => o.getAttribute('aria-checked') === 'true').length,
      goLabel: go().textContent,
    };

    // Pressing a chosen one again clears it — a mis-tap has to be undoable.
    opts()[1].click();
    const afterUndo = opts().filter((o) => o.getAttribute('aria-checked') === 'true').length;
    opts()[1].click();

    const other = /** @type {HTMLInputElement} */ (document.getElementById('question-other'));
    other.value = 'quản trị rủi ro';
    other.dispatchEvent(new window.Event('input', { bubbles: true }));
    const sendShown = !document.getElementById('question-send').hidden;

    // On to the second question.
    go().click();
    const second = {
      title: document.getElementById('question-title').textContent,
      count: document.getElementById('question-count').textContent,
      role: document.getElementById('question-options').getAttribute('role'),
      otherShown: !document.getElementById('question-otherrow').hidden,
      goLabel: go().textContent,
    };

    // One of these, on the last question: choosing it is answering it.
    const numbered = opts().map((o) => o.querySelector('.question__mark')?.textContent).join(',');
    opts()[1].click();
    return { firstShown, afterTwo, afterUndo, sendShown, second, numbered, sent, gone: document.getElementById('question').hidden };
  });

  check('the card comes up with the question on it', out.firstShown.visible && out.firstShown.title === 'Lĩnh vực nào?', out.firstShown.title);
  check('numbered so you know how many there are', out.firstShown.count === '1/2', out.firstShown.count);
  check('with every option drawn', out.firstShown.options === 3, String(out.firstShown.options));
  // Skip, not Next: nothing has been chosen, so the honest label is the one
  // that says you can move on without answering.
  check('and Skip while nothing is chosen', out.firstShown.goLabel === 'Skip', out.firstShown.goLabel);
  check('a question taking several says so to a screen reader', out.firstShown.role === 'group', out.firstShown.role);

  check('two can be chosen at once', out.afterTwo.checked === 2, String(out.afterTwo.checked));
  check('and the way on becomes Next', out.afterTwo.goLabel === 'Next', out.afterTwo.goLabel);
  check('pressing a chosen one again clears it', out.afterUndo === 1, String(out.afterUndo));

  check('Next moves to the second question', out.second.title === 'Dài bao nhiêu?', out.second.title);
  check('and the count follows', out.second.count === '2/2', out.second.count);
  check('a one-of-these question is a radiogroup', out.second.role === 'radiogroup', out.second.role);
  check('its free-text box is hidden when the model turned it off', out.second.otherShown === false);
  check('a one-of-these question is numbered', out.numbered === '1,2', out.numbered);
  check('typing your own answer brings up its send arrow', out.sendShown === true);

  check('answering hands back the call it belongs to', out.sent?.toolCallId === 'q1', JSON.stringify(out.sent?.toolCallId));
  check('with both choices from the first question', out.sent?.given?.[0]?.picks?.join(',') === 'Tài chính,AI', JSON.stringify(out.sent?.given?.[0]));
  check('what was typed alongside them', out.sent?.given?.[0]?.other === 'quản trị rủi ro', out.sent?.given?.[0]?.other);
  check('and the single choice from the second', out.sent?.given?.[1]?.picks?.join(',') === 'Dài', JSON.stringify(out.sent?.given?.[1]));
  check('the card goes once it is answered', out.gone === true);
}

section('your own words, sent from the pencil row, and the number keys');
{
  const out = await page.evaluate(async () => {
    const { createQuestionCard } = await import('/js/question.js');
    /** @type {any[]} */
    const sent = [];
    const card = createQuestionCard({ onAnswer: (a) => { sent.push(a); }, scrollToEnd: () => {} });
    card.show({ toolCallId: 'q3', questions: [{ question: 'Gửi cho ai?', options: [{ label: 'Khách hàng' }, { label: 'Đồng nghiệp' }], multiple: false, other: true, otherLabel: '' }] });
    const other = /** @type {HTMLInputElement} */ (document.getElementById('question-other'));
    const inList = !!document.querySelector('#question-options #question-otherrow');
    other.value = 'bản thân tôi';
    other.dispatchEvent(new window.Event('input', { bubbles: true }));
    /** @type {HTMLButtonElement} */ (document.getElementById('question-send')).click();

    card.show({ toolCallId: 'q4', questions: [{ question: 'Q?', options: [{ label: 'a' }, { label: 'b' }], multiple: false, other: true, otherLabel: '' }] });
    document.getElementById('question').dispatchEvent(new window.KeyboardEvent('keydown', { key: '2', bubbles: true }));
    return { sent, inList };
  });
  check('the pencil row is the last row of the list', out.inList);
  check('its send arrow answers with what was typed', out.sent[0]?.given?.[0]?.other === 'bản thân tôi' && !out.sent[0].given[0].picks.length, JSON.stringify(out.sent[0]));
  check('pressing 2 chooses the second option', out.sent[1]?.given?.[0]?.picks?.join() === 'b', JSON.stringify(out.sent[1]));
}

section('a setup form asks everything at once, with one button');
{
  const out = await page.evaluate(async () => {
    const { createQuestionCard } = await import('/js/question.js');
    /** @type {any} */
    let sent = null;
    const card = createQuestionCard({ onAnswer: (a) => { sent = a; }, scrollToEnd: () => {} });
    card.show({
      toolCallId: 'f1',
      form: true,
      title: 'Bạn muốn gửi email theo cách nào?',
      submitLabel: 'Tiếp tục thiết lập',
      questions: [
        { question: 'Tần suất nhận bản tin', kind: 'choice', options: [{ label: 'Hằng ngày' }, { label: 'Hằng tuần' }], multiple: false, other: false, otherLabel: '' },
        { question: 'Email người nhận', kind: 'email', options: [], multiple: false, other: true, otherLabel: 'you@example.com', hint: 'Có thể để trống', required: true },
      ],
    });
    const go = /** @type {HTMLButtonElement} */ (document.getElementById('question-go'));
    const sections = document.querySelectorAll('#question-options .qform__sec').length;
    const label = go.textContent;
    const title = document.getElementById('question-title').textContent;
    /** @type {HTMLButtonElement} */ (document.querySelector('.qform__opts .question__opt')).click();
    go.click();
    const blockedEmpty = sent === null;
    const email = /** @type {HTMLInputElement} */ (document.querySelector('input[data-field="1"]'));
    email.value = 'not-an-address';
    email.dispatchEvent(new window.Event('input', { bubbles: true }));
    go.click();
    const blockedBad = sent === null;
    email.value = 'an@example.com';
    email.dispatchEvent(new window.Event('input', { bubbles: true }));
    go.click();
    const firstSent = sent;
    const firstGone = document.getElementById('question').hidden;
    card.show({ toolCallId: 'f2', form: true, submitLabel: 'Xác nhận', preview: { title: 'AI Intelligence Daily', subtitle: 'Bản tin AI mỗi ngày', badge: 'Chưa kích hoạt', rows: ['Hằng ngày 7:00'], points: ['Mô hình AI mới'] }, questions: [{ question: 'Email', kind: 'email', options: [], multiple: false, other: true, otherLabel: '' }] });
    const preview = { name: document.querySelector('.qform__preview .schedcard__name')?.textContent, badge: document.querySelector('.qform__preview .schedcard__state')?.textContent };
    /** @type {HTMLButtonElement} */ (document.getElementById('question-dismiss')).click();
    return { sections, label, title, blockedEmpty, blockedBad, sent: firstSent, preview, gone: firstGone };
  });
  check('every question is on the page at once', out.sections === 2, String(out.sections));
  check("under the form's own title", out.title === 'Bạn muốn gửi email theo cách nào?', out.title);
  check('with the button the model named', out.label === 'Tiếp tục thiết lập', out.label);
  check('a required address cannot be left out', out.blockedEmpty);
  check('nor be something that is not an address', out.blockedBad);
  check('filled in, it sends choices and typed values together', out.sent?.given?.[0]?.picks?.join() === 'Hằng ngày' && out.sent?.given?.[1]?.other === 'an@example.com', JSON.stringify(out.sent));
  check('and goes', out.gone);
  check('a confirm step shows what will be set up, not active yet', out.preview?.name === 'AI Intelligence Daily' && out.preview?.badge === 'Chưa kích hoạt', JSON.stringify(out.preview));
}

section("an answer reads back as the person's own bubble");
{
  const out = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.body.append(turn.node);
    turn.startTool({ id: 'a1', name: 'ask_options', input: { questions: [] } }).complete({
      content: 'The user answered',
      ms: 2,
      answered: 'Tần suất: Hằng ngày\nEmail: an@example.com',
    });
    const text = turn.node.querySelector('.answerbubble')?.textContent || '';
    turn.node.remove();
    return { text };
  });
  check('the answer is drawn in the transcript', /Tần suất: Hằng ngày/.test(out.text) && /an@example\.com/.test(out.text), out.text);
}

section('skipping a question is an answer, not a cancel');
{
  const out = await page.evaluate(async () => {
    const { createQuestionCard } = await import('/js/question.js');
    /** @type {any} */
    let sent = null;
    const card = createQuestionCard({ onAnswer: (a) => { sent = a; }, scrollToEnd: () => {} });
    card.show({
      toolCallId: 'q2',
      questions: [
        { question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }], multiple: false, other: true, otherLabel: '' },
        { question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }], multiple: false, other: true, otherLabel: '' },
      ],
    });
    // The ✕ walks away from all of them at once.
    /** @type {HTMLButtonElement} */ (document.getElementById('question-dismiss')).click();
    return { sent, gone: document.getElementById('question').hidden };
  });

  /**
   * The turn is waiting on this, so walking away still has to send something —
   * an empty answer, which the server reads as "(skipped)" and turns into an
   * instruction not to ask again. Sending nothing at all would leave the run
   * holding its lease forever.
   */
  check('dismissing still sends an answer', out.sent?.toolCallId === 'q2', JSON.stringify(out.sent));
  check('one slot per question, all empty', out.sent?.given?.length === 2 && out.sent.given.every((g) => !g.picks.length && !g.other), JSON.stringify(out.sent?.given));
  check('and the card goes', out.gone === true);
}

section('a step that acted on an address says so as a link');
{
  const card = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);
    // Not a web tool — those are rows in the web card — but any other step
    // that takes an address still carries it as a link on its own card.
    const handle = turn.startTool({
      id: 'c1',
      name: 'download_file',
      input: { url: 'https://edenai.co/post/top-free-image-generation-tools?utm=1' },
    });

    const summary = turn.node.querySelector('.tool summary');
    const link = summary?.querySelector('a.tool__arg');
    const before = { href: link?.getAttribute('href') || '', shown: link?.textContent || '' };

    // Following the link must not also unfold the card: the whole point is to
    // get to the page without reading the raw call and result.
    const details = turn.node.querySelector('details.tool');
    link?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const openedByLink = details.open;

    // And the link survives the card being redrawn when the call finishes.
    handle.complete({ content: 'ok', ms: 57, isError: false });
    const after = turn.node.querySelector('.tool summary a.tool__arg');
    const out = {
      ...before,
      openedByLink,
      afterHref: after?.getAttribute('href') || '',
      tick: turn.node.querySelector('.tool summary .mark')?.textContent || '',
    };
    turn.node.remove();
    return out;
  });

  check('the whole address is the target', card.href === 'https://edenai.co/post/top-free-image-generation-tools?utm=1', card.href);
  // Shortened for reading — the full thing is on the hover title.
  check('a readable form of it is what shows', card.shown.length > 0 && !card.shown.startsWith('https://'), card.shown);
  check('clicking it does not unfold the card', card.openedByLink === false);
  check('and it is still a link once the call finishes', card.afterHref === card.href, card.afterHref);
  check('with the tick beside it', card.tick === '✓', card.tick);

  // A page the web card read: the row is the link, and it lives in the body,
  // so following it can never fold or unfold the card.
  const row = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);
    const url = 'https://edenai.co/post/top-free-image-generation-tools?utm=1';
    const handle = turn.startTool({ id: 'c1w', name: 'web_fetch', input: { url } });
    const pending = turn.node.querySelector('.web__list a.webrow')?.classList.contains('is-pending');
    handle.complete({ content: 'ok', ms: 57, isError: false });
    const link = turn.node.querySelector('.web__list a.webrow');
    const out = {
      pending,
      href: link?.getAttribute('href') || '',
      read: link?.classList.contains('is-read'),
      inSummary: !!turn.node.querySelector('.web summary a'),
    };
    turn.node.remove();
    return out;
  });
  check('a fetched page is a row while it loads', row.pending === true);
  check('its row goes to the exact address', row.href === 'https://edenai.co/post/top-free-image-generation-tools?utm=1', row.href);
  check('and says it was read', row.read === true);
  check('with no link in the header to click by mistake', row.inSummary === false);
}

section('a query is not pretending to be a link');
{
  const search = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);
    turn.startTool({ id: 'c2', name: 'web_search', input: { query: 'best free image API' } });
    const summary = turn.node.querySelector('.web summary');
    const out = { anchors: summary.querySelectorAll('a').length, arg: summary.querySelector('.web__query')?.textContent || '' };
    turn.node.remove();
    return out;
  });
  // There is no single page a search went to, so there is nothing to follow.
  check('a search step has no link on it', search.anchors === 0, String(search.anchors));
  check('but still says what was searched for', search.arg.includes('best free image API'), search.arg);
}

section('copying an answer out does not carry the dark theme with it');
{
  // The stripper, against the exact shapes the transcript produces: a code
  // block with its Copy button, a table, a heading with a class on it.
  const { stripped, origin } = await page.evaluate(async () => {
    const { cleanHtml } = await import('/js/clipboard.js');
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="prose" data-message-id="m1">' +
      '<h2 class="h" style="background:#111;color:#eee">Chênh lệch lãi suất</h2>' +
      '<table><tr><th>Năm</th><td>2026</td></tr></table>' +
      '<p>Xem <a href="https://example.com/a">nguồn</a>.</p>' +
      '<p>Tệp <a href="/api/attachments/f1?download=1">báo cáo.xlsx</a>.</p>' +
      '<p>Xem <a href="#section-2">mục 2</a> và <a href="mailto:a@b.com">liên hệ</a>.</p>' +
      '<div class="codeblock"><div class="codeblock__bar"><span>js</span>' +
      '<button class="copy-btn" data-copy>Copy</button></div><pre><code>x=1</code></pre></div>' +
      '</div>';
    return { stripped: cleanHtml(host), origin: location.origin };
  });

  check('no class survives', !stripped.includes('class='), stripped.slice(0, 160));
  check('no inline style survives', !stripped.includes('style='), stripped.slice(0, 160));
  check('no data- attribute survives', !stripped.includes('data-'), stripped.slice(0, 160));
  check('the Copy button is gone', !stripped.includes('Copy</button>'));
  check('the heading is still a heading', stripped.includes('<h2>Chênh lệch lãi suất</h2>'));
  check('the table is still a table', stripped.includes('<th>Năm</th>') && stripped.includes('<td>2026</td>'));
  check('the source link survives', stripped.includes('href="https://example.com/a"'));

  /**
   * Nothing empty hanging off either end.
   *
   * A reply that finishes with a blank paragraph, or a selection dragged past
   * the last line, pasted a run of empty blocks under the text — which in a
   * document is a page of whitespace and in a box that grows to fit its
   * content is a screen-high empty composer with two lines at the top.
   */
  const edges = await page.evaluate(async () => {
    const { cleanHtml } = await import('/js/clipboard.js');
    const host = document.createElement('div');
    host.innerHTML = '<p> </p><p></p><h2>Kết luận</h2><p>Giữa</p><p></p><p>Cuối</p><p>  </p><div></div>';
    const withTable = document.createElement('div');
    withTable.innerHTML = '<p>Có bảng</p><table><tr><td></td></tr></table>';
    return { trimmed: cleanHtml(host), table: cleanHtml(withTable) };
  });

  check('no empty block at the start', edges.trimmed.startsWith('<h2>'), edges.trimmed.slice(0, 60));
  check('none at the end either', edges.trimmed.endsWith('Cuối</p>'), edges.trimmed.slice(-60));
  // Only the edges: a blank line the author put between two paragraphs is
  // their spacing, and none of this function's business.
  check('but one in the middle is left alone', edges.trimmed.includes('<p></p>'), edges.trimmed);
  check('and an empty table is content, not padding', edges.table.includes('<table>'), edges.table);
  check('the code is still there', stripped.includes('x=1'));
  // The browser's own serialiser absolutised these; ours has to, or the
  // attachment link in a pasted report points at whatever host opens it.
  check(
    'this app’s own link is made absolute, not left root-relative',
    stripped.includes(`href="${origin}/api/attachments/f1?download=1"`),
    stripped.slice(0, 400),
  );
  // Rewriting these against the origin would turn a harmless in-page anchor
  // into a link back at this app's current route, and would be a no-op on the
  // scheme-carrying ones anyway — both are left exactly as written.
  check('an in-page anchor is left alone, not turned into a link back at this app', stripped.includes('href="#section-2"'), stripped.slice(0, 400));
  check('a mailto: link is untouched', stripped.includes('href="mailto:a@b.com"'), stripped.slice(0, 400));
}

section('a formula travels as its source, not as both halves of KaTeX');
{
  /**
   * KaTeX draws every formula twice — a MathML copy for screen readers, a pile
   * of positioned glyph spans for the eye — and hides the first with a class
   * and nothing else. `cleanHtml` strips classes, so without a deliberate
   * rewrite a pasted answer carries the TeX *and* the glyphs, in that order,
   * the second lot scrambled because their layout was class-driven too. This
   * is the one content type the whole branch exists to carry into a report.
   */
  const maths = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const { loadMath } = await import('/js/math.js');
    const { cleanHtml } = await import('/js/clipboard.js');
    await loadMath();

    const host = document.createElement('div');
    host.className = 'prose';
    host.innerHTML = renderMarkdown(
      'Giá trị hiện tại của một dòng tiền là $PV = \\frac{CF}{1+r}$, nên cả dự án là\n\n' +
      '$$NPV = \\sum_{t=1}^{n} PV_t - I_0$$\n\nvới $I_0$ là vốn bỏ ra ban đầu.',
    );
    document.body.append(host);
    const typeset = host.querySelectorAll('.katex').length;
    const out = cleanHtml(host);
    host.remove();
    return { out, typeset };
  });

  const count = (hay, needle) => hay.split(needle).length - 1;

  check('the fixture really was typeset by KaTeX', maths.typeset === 3, String(maths.typeset));
  check(
    'the inline formula arrives once, as its TeX',
    count(maths.out, 'PV = \\frac{CF}{1+r}') === 1,
    maths.out.slice(0, 200),
  );
  check(
    'the display formula arrives once, marked as display',
    count(maths.out, '$$NPV = \\sum_{t=1}^{n} PV_t - I_0$$') === 1,
    maths.out.slice(0, 300),
  );
  check('no MathML goes with it — Google Docs drops it', !maths.out.includes('<math'), maths.out.slice(0, 200));
  check('and no annotation element is left behind', !maths.out.includes('annotation'), maths.out.slice(0, 200));
  check('the Vietnamese prose around it is intact', maths.out.includes('vốn bỏ ra ban đầu'), maths.out.slice(0, 200));
}

section('the assistant’s answer has a copy button');
{
  const state = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);

    const before = !!turn.node.querySelector('.msg__actions');
    turn.appendText('## Kết luận\n\nUSD giảm giá so với EUR.');
    turn.flushText();

    const { markdownOf } = await import('/js/render.js');
    return {
      before,
      after: !!turn.node.querySelector('.msg__action[data-act="copy"]'),
      markdown: markdownOf(turn.node),
      rendered: turn.node.querySelector('.prose')?.innerHTML ?? '',
    };
  });

  // A turn that only ran tools has nothing to copy, so it gets no button.
  check('no button before there is prose', state.before === false);
  check('a copy button once there is', state.after);
  check('the Markdown behind it is kept', state.markdown.includes('## Kết luận'), state.markdown);
  check('and it rendered as a heading', state.rendered.includes('<h2>'), state.rendered.slice(0, 120));
}

section('an assistant action only copies when it actually is the copy button');
{
  /**
   * The user branch of this same click handler has always checked
   * `dataset.act === 'copy'` before writing to the clipboard; the assistant
   * branch treated *any* `.msg__action` inside `.msg--assistant` as one. Only
   * a copy button is ever rendered there today, so nothing has broken yet —
   * this pins the guard so a second assistant action, whenever one is added,
   * cannot copy by accident just for sitting in the same row.
   */
  const result = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);
    turn.appendText('some prose to copy');
    turn.flushText();

    // A hypothetical second action beside the real copy button.
    const actions = turn.node.querySelector('.msg__actions');
    const decoy = document.createElement('button');
    decoy.className = 'msg__action';
    decoy.type = 'button';
    decoy.dataset.act = 'bogus';
    actions.append(decoy);

    let calls = 0;
    const realWrite = navigator.clipboard.write?.bind(navigator.clipboard);
    const realWriteText = navigator.clipboard.writeText?.bind(navigator.clipboard);
    navigator.clipboard.write = async () => { calls += 1; };
    navigator.clipboard.writeText = async () => { calls += 1; };

    decoy.click();
    await new Promise((r) => setTimeout(r, 80));
    const afterDecoy = calls;

    turn.node.querySelector('.msg__action[data-act="copy"]').click();
    await new Promise((r) => setTimeout(r, 80));
    const afterCopy = calls;

    navigator.clipboard.write = realWrite;
    navigator.clipboard.writeText = realWriteText;
    turn.node.remove();

    return { afterDecoy, afterCopy };
  });

  check('a non-copy action on an assistant turn never touches the clipboard', result.afterDecoy === 0, String(result.afterDecoy));
  check('while the real copy button still does', result.afterCopy > 0, String(result.afterCopy));
}

section('a turn that ran out of room says so, and offers the way on');
{
  const note = await page.evaluate(async () => {
    const { stopNote } = await import('/js/render.js');
    let pressed = 0;
    const resumable = stopNote('max_steps', 'Dừng ở đây vì…', () => { pressed += 1; });
    const refused = stopNote('refused', 'Từ chối.');
    document.body.append(resumable, refused);
    resumable.querySelector('.stopnote__go')?.click();
    return {
      refusedHasButton: !!refused.querySelector('button'),
      pressed,
      goneAfterPress: !resumable.isConnected,
    };
  });

  check('a budget stop offers Continue', note.pressed === 1);
  check('a refusal does not', note.refusedHasButton === false);
  // A second press would start a second run and be refused by the run lock.
  check('and the note goes once it is pressed', note.goneAfterPress);
}

section('a stale Continue button does not outlive the note it belongs to');
{
  /**
   * The case the section above does not cover: the user hits the step
   * ceiling, gets the note with its button, and instead of pressing it types
   * something else. Two more turns finish. The old note is still sitting
   * mid-transcript with a live button whose sentence says "carry on from
   * exactly here" — and pressing it now would start a run from the
   * conversation's *current* end, far from where the button sits.
   *
   * `openChat` already handles leaving the conversation entirely — it rebuilds
   * `#messages` from scratch. What is new here is staying put: `stream()`
   * itself has to clear a stale button the moment a fresh run starts, while
   * leaving the note's sentence in place as a true record of what happened.
   */
  const made = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(
        (r) => r.json(),
      );
    const { chat } = await post('/api/chats', {});
    await post(`/api/chats/${chat.id}/messages`, { text: 'first question' });
    return chat.id;
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.click(`.chat-row[data-chat="${made}"]`);
  await page.waitForTimeout(500);

  // Stand in for the note a finished run would have left behind.
  await page.evaluate(async () => {
    const { stopNote } = await import('/js/render.js');
    document
      .getElementById('messages')
      .append(stopNote('max_steps', 'Dừng ở đây vì hết bước.', () => {}));
  });

  await page.fill('#input', 'keep going anyway');
  await page.click('#send');
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => ({
    lineStillThere: [...document.querySelectorAll('.stopnote__line')].some(
      (l) => l.textContent === 'Dừng ở đây vì hết bước.',
    ),
    // The old note's button, not any button: the new run may leave a note of
    // its own (here it fails for want of a key), and that one rightly has one.
    buttonGone: ![...document.querySelectorAll('.stopnote')].find((n) => n.textContent.includes('Dừng ở đây vì hết bước.'))?.querySelector('.stopnote__go'),
  }));

  check('the note itself is kept — it is still a true record of what happened', after.lineStillThere);
  check('but its Continue button is cleared the moment a new run starts', after.buttonGone);
  // The run that just failed (no key in the suite) leaves a way on of its own.
  check('a run that failed partway offers Continue', await page.evaluate(() => !!document.querySelector('.stopnote--interrupted .stopnote__go')));
}

section('the Ctrl+C path itself produces a clean payload, not just cleanHtml in isolation');
{
  // The plan's sections above cover `cleanHtml` directly but never exercise the
  // `copy` listener in app.js. Build a real selection across an assistant
  // turn's prose inside #messages, then drive the handler with a real event
  // carrying a real DataTransfer — the way a person pressing Ctrl+C actually does.
  //
  // `Selection.toString()` only returns rendered text, so this needs the
  // transcript actually on screen — a page left showing Projects or Settings
  // by an earlier section would make the selection read as empty regardless of
  // what the listener does, which would be testing the harness, not the app.
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  await page.click('#new-chat');
  await page.waitForTimeout(500);

  const result = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);
    turn.appendText('## Kết luận\n\nUSD giảm giá so với EUR, theo dữ liệu quý này.');
    turn.flushText();

    const prose = turn.node.querySelector('.prose');
    const range = document.createRange();
    range.selectNodeContents(prose);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();

    // The event must be dispatched on a node INSIDE #messages so it bubbles to
    // the delegated listener there.
    const dt = new window.DataTransfer();
    const event = new window.ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    prose.dispatchEvent(event);

    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    selection.removeAllRanges();
    turn.node.remove();
    return { html, text, selectedText, defaultPrevented: event.defaultPrevented };
  });

  check('the payload carries the charset meta Word needs', result.html.includes('<meta charset="utf-8">'), result.html.slice(0, 140));
  check('no class attribute survives the real listener', !result.html.includes('class='), result.html.slice(0, 200));
  check('no inline style survives it either', !result.html.includes('style='), result.html.slice(0, 200));
  check('the Vietnamese text is carried across intact', result.html.includes('USD giảm giá so với EUR'), result.html.slice(0, 240));
  check('the plain-text flavour is exactly what was selected', result.text === result.selectedText && result.text.length > 0, result.text.slice(0, 120));
  check('the default copy was suppressed in favour of the rewritten one', result.defaultPrevented === true);
}

section('copying out of a message being edited is not intercepted');
{
  // `beginEdit` turns a user bubble into a box matching input, textarea or
  // [contenteditable]. The listener has to recognise that shape and get out of
  // the way, or editing breaks in a way nobody would connect back to this change.
  //
  // The two checks below only mean something if the *only* variable between
  // them is where the event is dispatched — so both fire against one real
  // Selection over real prose inside #messages, built the same way section (a)
  // above builds one. A textarea's own internal selection is a separate model
  // that `window.getSelection()` never sees, so setting it here would leave
  // this passing for the wrong reason (nothing selected) rather than the right
  // one (the guard fired) — a bug this section shipped with once already.
  const result = await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'msg msg--user is-editing';

    const prose = document.createElement('div');
    prose.className = 'prose';
    prose.textContent = 'nội dung đã gửi, còn nguyên trên màn hình trong khi ô sửa đang mở';
    host.append(prose);

    const box = document.createElement('textarea');
    box.className = 'bubble__edit';
    box.value = 'nội dung đang sửa dở';
    host.append(box);

    document.getElementById('messages').append(host);

    const range = document.createRange();
    range.selectNodeContents(prose);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const fire = (target) => {
      const dt = new window.DataTransfer();
      const event = new window.ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return { html: dt.getData('text/html'), defaultPrevented: event.defaultPrevented };
    };

    // The guard under test: the same selection, dispatched from inside the
    // editing box. Guard A — `event.target.closest('input, textarea,
    // [contenteditable]')` — is the only thing that can make this come back
    // empty, because the selection itself is real and non-collapsed.
    const fromBox = fire(box);
    // The control, with nothing changed but the target: the exact same
    // selection, dispatched from the prose that is *not* being edited. If this
    // one also came back empty, the pair would prove nothing about the guard —
    // it would only mean the selection itself was empty.
    const fromProse = fire(prose);

    host.remove();
    selection.removeAllRanges();
    return { fromBox, fromProse };
  });

  check(
    'firing from inside the editing box, the handler puts nothing of its own on the clipboard',
    result.fromBox.html === '',
    JSON.stringify(result.fromBox),
  );
  check('and leaves the browser free to do its own thing there', result.fromBox.defaultPrevented === false);
  // The control: same selection, fired outside the box — this has to produce a
  // real payload, or the two checks above are not testing the guard at all.
  check(
    'control — the identical selection, fired outside the box, is not swallowed the same way',
    result.fromProse.html !== '' && result.fromProse.defaultPrevented === true,
    JSON.stringify(result.fromProse),
  );
}

section('an abandoned draft cannot be handed to the copy button');
{
  // A provider that restarts a reply on another key calls resetText(), and the
  // turn's Markdown lives in a WeakMap. If a stale entry survived, the copy
  // button would hand someone a paragraph the model abandoned, with nothing on
  // screen to say so.
  const result = await page.evaluate(async () => {
    const { assistantMessage, markdownOf } = await import('/js/render.js');
    const turn = assistantMessage();
    document.getElementById('messages').append(turn.node);

    turn.appendText('first draft');
    turn.flushText();
    const afterFirst = {
      markdown: markdownOf(turn.node),
      hasButton: !!turn.node.querySelector('.msg__actions'),
    };

    turn.resetText();
    const afterReset = {
      markdown: markdownOf(turn.node),
      hasButton: !!turn.node.querySelector('.msg__actions'),
    };

    turn.appendText('second draft');
    turn.flushText();
    const afterSecond = {
      markdown: markdownOf(turn.node),
      hasButton: !!turn.node.querySelector('.msg__actions'),
    };

    turn.node.remove();
    return { afterFirst, afterReset, afterSecond };
  });

  check(
    'the first draft is kept, with a copy button',
    result.afterFirst.markdown.includes('first draft') && result.afterFirst.hasButton,
    JSON.stringify(result.afterFirst),
  );
  check('resetting clears the Markdown behind it', result.afterReset.markdown === '', result.afterReset.markdown);
  check('and takes the copy button with it', result.afterReset.hasButton === false);
  check(
    'the second draft replaces it rather than piling on top',
    result.afterSecond.markdown.includes('second draft') && !result.afterSecond.markdown.includes('first draft'),
    result.afterSecond.markdown,
  );
  check('and the copy button is back', result.afterSecond.hasButton === true);
}

section('a chart can be read by hovering, like any charting tool');
{
  const { renderChart } = await import('../server/tools/chart.js');
  const spec = {
    type: 'line',
    format: 'number',
    labels: ['1', '2', '3', '4'],
    series: [
      { name: 'Classical (x)', values: [1, 2, 3, 4] },
      { name: 'Quantum (2^x)', values: [2, 4, 8, 16] },
    ],
  };
  const markup = renderChart({ type: spec.type, title: 'Growth', data: spec });
  const read = await page.evaluate(
    async ({ markup, spec }) => {
      const { widgetNode } = await import('/js/render.js');
      const node = widgetNode({ title: 'Growth', markup, kind: 'chart', spec });
      document.getElementById('thread').append(node);
      const stage = node.querySelector('.chart__stage');
      const hit = node.querySelector('.hit[data-i="2"]');
      hit?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
      const tip = node.querySelector('.chart__tip');
      const hovered = { shown: !tip.hidden, text: tip.textContent, guide: node.querySelector('.chart__guide')?.style.display };
      stage.focus();
      stage.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const keyed = tip.textContent;
      const legend = node.querySelector('.legend-item[data-s="1"]');
      legend.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
      const afterToggle = {
        off: legend.classList.contains('is-off'),
        line: node.querySelector('polyline[data-s="1"]').classList.contains('is-off'),
        tip: tip.textContent,
      };
      const out = {
        inline: node.querySelector('svg') !== null && !node.querySelector('iframe'),
        hovered,
        keyed,
        afterToggle,
        table: node.querySelector('table.sr-only')?.textContent || '',
      };
      node.remove();
      return out;
    },
    { markup, spec },
  );
  check('the chart is drawn in the page, not a frame', read.inline);
  check('hovering a column shows its values', read.hovered.shown && /3/.test(read.hovered.text) && /8/.test(read.hovered.text), read.hovered.text);
  check('  with a guide line through it', read.hovered.guide === '', String(read.hovered.guide));
  check('the arrow keys move along the labels', /16/.test(read.keyed), read.keyed);
  check('the legend sets a series aside', read.afterToggle.off && read.afterToggle.line);
  check('  and the tooltip stops listing it', !/Quantum/.test(read.afterToggle.tip), read.afterToggle.tip);
  check('a screen reader gets the numbers as a table', /Quantum/.test(read.table) && /16/.test(read.table));

  // Markup that is not a chart falls back to the sandboxed frame rather than
  // being inserted into the page.
  const fallback = await page.evaluate(async () => {
    const { widgetNode } = await import('/js/render.js');
    const node = widgetNode({ title: 'x', markup: '<div onclick="x">not svg</div>', kind: 'chart', spec: { labels: [], series: [] } });
    return !!node.querySelector('iframe');
  });
  check('markup that is not a chart is not put in the page', fallback);
}

section('a picture in a frame sits on the conversation, not on a white slab');
{
  const framed = await page.evaluate(async () => {
    const { widgetNode } = await import('/js/render.js');
    const node = widgetNode({
      title: 'Diagram',
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="10" y="50" fill="#fff">hi</text></svg>',
      kind: 'svg',
    });
    const frame = node.querySelector('iframe');
    frame.loading = 'eager';
    // The load of the picture itself — not the blank document every frame
    // starts with, which is "complete" before the srcdoc is even read.
    const loaded = new Promise((r) => {
      frame.addEventListener('load', r, { once: true });
      setTimeout(r, 3000);
    });
    document.getElementById('thread').append(node);
    await loaded;
    const inner = frame.contentDocument;
    const out = {
      schemeOut: frame.style.colorScheme,
      schemeIn: inner ? getComputedStyle(inner.documentElement).colorScheme : '',
      barHidden: inner ? getComputedStyle(inner.documentElement).scrollbarWidth : '',
      tools: node.querySelectorAll('.media-tools__btn').length,
      toolsHidden: getComputedStyle(node.querySelector('.media-tools')).opacity,
    };
    node.remove();
    return out;
  });
  // A frame whose scheme differs from the page's is painted opaque — white in
  // a dark page, under light text. Matching them keeps it transparent.
  check('the frame declares the scheme the page is in', !!framed.schemeOut && framed.schemeIn === framed.schemeOut, `${framed.schemeOut} / ${framed.schemeIn}`);
  check('no scrollbar is drawn through a picture', framed.barHidden === 'none', framed.barHidden);
  check('copy and download are there', framed.tools === 2, String(framed.tools));
  check('  out of sight until the picture is pointed at', framed.toolsHidden === '0', framed.toolsHidden);

  // A chart drawn before charts carried their numbers is ours, so it goes in
  // the page too — never into the white frame.
  const { renderChart } = await import('../server/tools/chart.js');
  const old = renderChart({ type: 'pie', title: 'Old', data: { labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] } });
  const oldChart = await page.evaluate(async (markup) => {
    const { widgetNode } = await import('/js/render.js');
    const node = widgetNode({ title: 'Old', markup, kind: 'svg' }, 'chart');
    return { inline: !!node.querySelector('svg') && !node.querySelector('iframe'), tools: node.querySelectorAll('.media-tools__btn').length };
  }, old);
  check('an older chart is drawn in the page as well', oldChart.inline);
  check('  with copy and download', oldChart.tools === 2);
}

section('pinning a project puts it in the sidebar at once');
{
  const shown = await page.evaluate(async () => {
    const made = await (
      await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pinned right away' }) })
    ).json();
    const id = made.project?.id;
    await fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });
    // What the pin buttons do after their request: tell the sidebar.
    document.dispatchEvent(new globalThis.CustomEvent('projects-changed'));
    await new Promise((r) => setTimeout(r, 900));
    const listed = [...document.querySelectorAll('#chat-list .proj-row')].some((row) => row.textContent.includes('Pinned right away'));
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    document.dispatchEvent(new globalThis.CustomEvent('projects-changed'));
    await new Promise((r) => setTimeout(r, 900));
    const gone = ![...document.querySelectorAll('#chat-list .proj-row')].some((row) => row.textContent.includes('Pinned right away'));
    return { listed, gone };
  });
  check('a pinned project appears without opening anything else', shown.listed);
  check('  even before it holds a conversation', shown.listed);
  check('  and leaves when it is deleted', shown.gone);
}

section('"describe it to the assistant" starts a new conversation');
{
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  });
  // Something open first, so going back to it would be visible.
  await page.click('.chat-item').catch(() => {});
  await page.waitForTimeout(800);
  await page.click('#open-scheduled');
  await page.waitForTimeout(700);
  const ring = await page.evaluate(() => {
    const r = document.querySelector('.blank__ring');
    return r ? getComputedStyle(r).backgroundColor : null;
  });
  check('the empty-state mark has no grey disc behind it', ring === null || ring === 'rgba(0, 0, 0, 0)', String(ring));
  await page.click('#page-new');
  await page.waitForTimeout(200);
  await page.click('#page-new-menu [data-pick="0"]');
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    page: !document.getElementById('page').hidden,
    title: document.getElementById('chat-title').textContent.trim(),
    typed: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')).value,
    active: !!document.querySelector('.chat-row.is-active'),
  }));
  check('the shelf closes', !after.page);
  check('onto a new conversation, not the last one', after.title === 'New chat' && !after.active, `${after.title} / active row: ${after.active}`);
  check('  with the sentence begun', /^Set up a scheduled job/.test(after.typed), after.typed);
  await page.evaluate(() => {
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    input.value = '';
    input.dispatchEvent(new Event('input'));
  });
}

section('a long tool call shows a card while it is still being written');
{
  const draft = await page.evaluate(async () => {
    const { assistantMessage } = await import('/js/render.js');
    const turn = assistantMessage();
    document.body.append(turn.node);
    const handle = turn.draftTool('create_file');
    handle.progress(20 * 1024);
    const card = turn.node.querySelector('.tool--draft');
    const out = { headline: card?.querySelector('.tool__name')?.textContent, size: card?.querySelector('.tool__time')?.textContent };
    handle.remove();
    out.gone = !turn.node.querySelector('.tool--draft');
    out.grouped = turn.draftTool('browser_click') === null;
    turn.node.remove();
    return out;
  });
  check('the card says what is being made', !!draft.headline && draft.headline !== 'create_file', draft.headline);
  check('  and how much of it has arrived', /20\.0 KB/.test(draft.size || ''), draft.size);
  check('  and goes when the real card takes over', draft.gone);
  check('a small grouped step gets no draft card', draft.grouped);
}

section('the empty composer is one straight line, however narrow');
{
  const narrow = await page.evaluate(async () => {
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
    const box = /** @type {HTMLElement} */ (document.querySelector('.composer__box'));
    const seen = [];
    const watch = new globalThis.MutationObserver(() => seen.push(input.placeholder.slice(0, 24)));
    watch.observe(input, { attributes: true, attributeFilter: ['placeholder'] });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const wide = { h: input.getBoundingClientRect().height, placeholder: input.placeholder, w: input.clientWidth };
    box.style.width = '430px';
    await new Promise((r) => setTimeout(r, 1200));
    const tight = { h: input.getBoundingClientRect().height, placeholder: input.placeholder, w: input.clientWidth };
    box.style.width = '';
    await new Promise((r) => setTimeout(r, 1200));
    watch.disconnect();
    return { wide, tight, restored: input.placeholder, seen };
  });
  check('it does not grow to fit a wrapped hint', Math.abs(narrow.tight.h - narrow.wide.h) < 1, `${narrow.wide.h} → ${narrow.tight.h}`);
  check(
    'the hint shortens when the full one would not fit',
    narrow.tight.placeholder.length < narrow.wide.placeholder.length,
    `${narrow.tight.placeholder} — field ${narrow.wide.w}px → ${narrow.tight.w}px — changes: ${narrow.seen.join(' | ')}`,
  );
  check('and comes back when there is room', narrow.restored === narrow.wide.placeholder, narrow.restored);
}

section('a bare ?continue= link is shown after signing in, never copied (SEC-050)');
{
  // A fresh, signed-out browser: somebody whose session has expired.
  const token = 'tokBareContinueLink0000000000000000000000_0';
  const visit = async (pressed, { bareFirst = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const tab = await context.newPage();
    const forks = [];
    tab.on('request', (req) => {
      if (/\/api\/shared-chat\/[^/]+\/fork$/.test(req.url())) forks.push(req.url());
    });
    if (bareFirst) {
      // A bare link opened earlier in the same tab, and left at the sign-in screen.
      await tab.goto(`http://127.0.0.1:${PORT}/?continue=tokEarlierBareLink000000000000000000000_00`, { waitUntil: 'domcontentloaded' });
      await tab.waitForTimeout(400);
    }
    if (pressed) {
      // What the shared page's own button does before it sends the visitor here.
      await tab.goto(`http://127.0.0.1:${PORT}/share.html?t=${token}`, { waitUntil: 'domcontentloaded' });
      await tab.evaluate((t) => sessionStorage.setItem('synapsez:continue-shared', t), token);
    }
    await tab.goto(`http://127.0.0.1:${PORT}/?continue=${token}`, { waitUntil: 'domcontentloaded' });
    await tab.waitForTimeout(600);
    await tab.fill('#gate-email', 'ui@test.local');
    await tab.fill('#gate-password', 'a-long-enough-password');
    await tab.click('#gate-submit');
    await tab.waitForTimeout(2500);
    const where = new URL(tab.url());
    await context.close();
    return { path: where.pathname, t: where.searchParams.get('t'), forks: forks.length };
  };
  const bare = await visit(false);
  check('a link nobody pressed opens the shared page after sign-in', bare.path === '/share.html' && bare.t === token, JSON.stringify(bare));
  check('  and asks for no copy', bare.forks === 0, JSON.stringify(bare));
  const pressed = await visit(true);
  check('the shared page\'s own button still carries it on after sign-in', pressed.forks === 1 && pressed.path === '/', JSON.stringify(pressed));
  const after = await visit(true, { bareFirst: true });
  check('  even after a bare link was opened earlier in the same tab (UX-008)', after.forks === 1 && after.path === '/', JSON.stringify(after));
}

await browser.close();
server.close();
removeTemp(process.env.DATA_DIR);

realLog(
  failures
    ? `\n\x1b[31m${failures} interface check(s) failed.\x1b[0m\n`
    : '\n\x1b[32mAll interface checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
