/**
 * The browser sandbox, driven the way the assistant drives it.
 *
 * This suite exists because of one bug, and it was a bad one: the page listing
 * and the click path both used the top document only, so on any application
 * that puts its real interface inside an iframe — Salesforce Lightning, most
 * embedded admin consoles, anything with a Visualforce page — the assistant was
 * shown the navigation chrome, told that was the whole page, and left unable to
 * reach a single field of the form it had been asked to fill in. It could not
 * even tell that something was missing.
 *
 * Needs a browser, so it is separate from `npm test`:
 *
 *   npm run test:sandbox
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.WORKSPACE = path.join(os.tmpdir(), `ai-remote-sandbox-test-${process.pid}`);
fs.mkdirSync(process.env.WORKSPACE, { recursive: true });

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

// A page shaped like the ones that broke: chrome in the top document, the form
// in a frame, and a second frame that is present but hidden.
const PAGE = `<!doctype html><title>LogiForce360</title>
  <h1>WELCOME TO LOGIFORCE360</h1>
  <button>Home</button> <button>Quotation</button>
  <iframe src="/form" style="width:900px;height:420px;border:0"></iframe>
  <iframe src="/form" style="display:none"></iframe>`;
const FORM = `<!doctype html><title>New Vessel Schedule: FCL</title>
  <label>Carrier</label><input name="carrier" placeholder="Carrier">
  <label>Vessel</label><input name="vessel" placeholder="Vessel">
  <button>Save</button>
  <p>Required information for the vessel schedule.</p>`;

const server = http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    // Two routes for the isolation checks: one hands out a cookie, the other
    // reports back whichever cookie arrived.
    if (req.url === '/set-cookie') {
      res.setHeader('Set-Cookie', 'who=chatA; Path=/');
      res.end('<title>signed in</title><p>ok</p>');
      return;
    }
    if (req.url === '/read-cookie') {
      res.end('<title>who am i</title><p>cookie:[' + (req.headers.cookie || '') + ']</p>');
      return;
    }
    res.end(req.url === '/form' ? FORM : PAGE);
  })
  .listen(5397);
await new Promise((r) => server.once('listening', r));

let browser;
try {
  const { chromium } = await import('playwright-core');
  for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      browser = await chromium.launch({ ...options, headless: true });
      await browser.close();
      break;
    } catch {
      /* try the next one */
    }
  }
} catch {
  /* handled below */
}
if (!browser) {
  console.log('\n  Skipped: no Chrome, Edge or bundled Chromium to drive.\n');
  server.close();
  // In CI a browser was installed on purpose; not finding one is a failure (CFG-027).
  process.exit(process.env.CI ? 1 : 0);
}

/**
 * Browser tools answer with `{ text, shot }` — the text the model reads, and a
 * thumbnail for the transcript. Unwrapped here rather than at thirty call sites,
 * and tolerant of a plain string so a tool that has nothing to illustrate needs
 * no special case.
 */
const say = (result) => String(result?.text ?? result ?? '');

const { BROWSER_IMPLEMENTATIONS: tools, closeBrowser } = await import('../worker/browser.js');

section('a page whose real interface is inside a frame');
const opened = say(await tools.browser_open({ url: 'http://127.0.0.1:5397/' }));
{
  check('the top document is listed', /\[\d+\] button\s+Home/.test(opened), 'the easy half');

  // The bug, stated as the three things it cost.
  check('so are the fields inside the frame', /\[\d+\] input\s+Carrier/.test(opened) && /\[\d+\] input\s+Vessel/.test(opened), opened.split('\n').slice(3, 12).join(' | '));
  check('and its buttons', /\[\d+\] button\s+Save/.test(opened));
  check('the frame\'s text is readable too', /Required information for the vessel schedule/.test(opened));
  check('and the page says frames are in play', /embedded frame/.test(opened));

  // A hidden frame's contents measure normally inside their own document, so
  // without checking the frame element they arrive as controls nobody can see.
  const carriers = (opened.match(/input\s+Carrier/g) || []).length;
  check('a hidden frame contributes nothing', carriers === 1, `${carriers} Carrier fields listed`);
}

section('and they can actually be acted on');
{
  const ref = Number(/\[(\d+)\] input\s+Vessel/.exec(opened)?.[1]);
  check('the field has a number', Number.isInteger(ref), `${ref}`);

  const typed = say(await tools.browser_type({ ref, text: 'COSCO EXCELLENCE' }));
  check('typing into it works', /Typed into \[\d+\]/.test(typed), typed.split('\n')[0]);

  // The value has to be in the frame, not merely reported as typed.
  const listing = say(await tools.browser_look({}));
  check('and the value lands in the frame', /COSCO EXCELLENCE/.test(listing), 'the listing reads the field back');

  let refused = null;
  await tools.browser_click({ ref: 999 }).catch((err) => (refused = err.message));
  check('a number that is not on the page is refused, not guessed', /no element \[999\]/.test(refused || ''), refused);
}

section('the numbering is one sequence across the whole page');
{
  const listing = say(await tools.browser_look({}));
  const refs = [...listing.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const unique = new Set(refs);
  // Numbering per-document would restart at 1 inside the frame, and two
  // elements answering to [1] is how a click lands on the wrong control.
  check('every number appears once', unique.size === refs.length, `${refs.length} refs, ${unique.size} distinct`);
  check('and they run in order from 1', refs[0] === 1 && refs[refs.length - 1] === refs.length, refs.join(','));
}

section('opening a page keeps the one that was open');
{
  // The old default reused the tab, so a lookup destroyed whatever was already
  // there — a half-filled form, a video somebody was listening to — and the
  // model had to remember to prevent it every single time.
  const opened = say(await tools.browser_open({ url: 'http://127.0.0.1:5397/form' }));
  check('a second page opens beside the first', /2 open/.test(opened), opened.split('\n')[0]);

  const list = say(await tools.browser_tabs({}));
  check('both tabs are there', (list.match(/\[\d+\]/g) || []).length === 2, list.replace(/\n/g, ' '));
  check('and the new one has focus', /\[2\]\s*←/.test(list), list.replace(/\n/g, ' '));

  // Still possible to say "reuse this one" when the page is finished with.
  const replaced = say(await tools.browser_open({ url: 'http://127.0.0.1:5397/', replace_tab: true }));
  check('replace_tab reuses the current tab', !/3 open/.test(replaced), replaced.split('\n')[0]);
  const after = say(await tools.browser_tabs({}));
  check('so the count does not grow', (after.match(/\[\d+\]/g) || []).length === 2);

  await tools.browser_switch({ tab: 1 });
  const back = say(await tools.browser_tabs({}));
  check('and switching back works', /\[1\]\s*←/.test(back), back.replace(/\n/g, ' '));
}

/**
 * The mirror keeps working without the window ever being raised.
 *
 * `focusPage` used to call `page.bringToFront()` on every tab switch, on the
 * belief — written into a comment here for a long time — that "Chrome only
 * screencasts the tab it considers active". It does not, and that call was the
 * whole reason the sandbox appeared to pop up over whatever the user was doing:
 * raising a tab activates its window, and on Windows an activated window takes
 * the keyboard with it. Every lookup stole the cursor mid-sentence.
 *
 * This is the check that makes removing it safe: frames have to keep arriving for
 * the tab being acted on even while a *different* tab is the one Chrome considers
 * active. If this ever fails, the panel has gone blank and the popup is not the
 * thing to put back — a screencast that follows the acted-on target is.
 */
section('the mirror follows the acted-on tab without raising the window');
{
  const { setFrameSink } = await import('../worker/screen.js');

  let frames = 0;
  let lastUrl = '';
  setFrameSink(async ({ url }) => {
    frames += 1;
    if (url) lastUrl = url;
  });

  // Two tabs. The second is the one Chrome considers active, because it was
  // opened last and nothing brings anything forward any more.
  await tools.browser_open({ url: 'http://127.0.0.1:5397/' });
  await tools.browser_open({ url: 'http://127.0.0.1:5397/form' });

  // Act on the *first* one, which is now a background tab.
  frames = 0;
  await tools.browser_switch({ tab: 1 });
  await tools.browser_look({});
  check('frames arrive for a tab that is not the active one', frames > 0, `${frames} frames`);
  check('and they are frames of that tab', !/\/form$/.test(lastUrl), lastUrl || 'no url seen');

  // Reading and clicking a background tab has to work too, or "the mirror is
  // live" would be true and useless.
  const listing = say(await tools.browser_look({}));
  check('a background tab can still be read', /LOGIFORCE360/i.test(listing), listing.split('\n')[1] || '');

  frames = 0;
  await tools.browser_scroll({ direction: 'down', amount: 1 });
  check('and acting on it still produces frames', frames > 0, `${frames} frames`);

  await tools.browser_close_tab({ tab: 2 });
}

/**
 * One conversation's browsing must not be another's.
 *
 * Everything above this point drives a single conversation, which is exactly
 * how the leak survived: with one chat there is nothing to leak into. With two,
 * a tab opened in one appeared in the other's `browser_tabs`, a sign-in in one
 * signed the other in, and `browser_close` in either shut both.
 */
section('each conversation browses on its own');
{
  const { browserSessions } = await import('../worker/browser.js');
  const at = (chatId) => ({ chatId });

  await tools.browser_open({ url: 'http://127.0.0.1:5397/' }, at('chat-A'));
  await tools.browser_open({ url: 'http://127.0.0.1:5397/form' }, at('chat-B'));

  const a = say(await tools.browser_tabs({}, at('chat-A')));
  const b = say(await tools.browser_tabs({}, at('chat-B')));

  check('one conversation does not see the other tabs', !/Save|Vessel/.test(a), a.replace(/\n/g, ' ').slice(0, 90));
  check('and the other does not see the first', !/LOGIFORCE360/.test(b), b.replace(/\n/g, ' ').slice(0, 90));
  check('while each still sees its own', /5397/.test(a) && /5397/.test(b));

  check(
    'each conversation has a session of its own',
    !!browserSessions().find((s) => s.key === 'chat-A') && !!browserSessions().find((s) => s.key === 'chat-B'),
  );

  /**
   * Cookies are the half that matters for sign-ins, and they live on the context
   * rather than the tab — so this is what "signed in over there does not sign me
   * in over here" actually rests on. Proved rather than assumed: separate tabs
   * say nothing by themselves about separate credentials.
   */
  const read = (t) => (/cookie:\[([^\]]*)\]/.exec(t) || [])[1] ?? '';
  await tools.browser_open({ url: 'http://127.0.0.1:5397/set-cookie' }, at('chat-A'));
  const carriedByA = read(
    say(await tools.browser_open({ url: 'http://127.0.0.1:5397/read-cookie', replace_tab: true }, at('chat-A'))),
  );
  const carriedByB = read(say(await tools.browser_open({ url: 'http://127.0.0.1:5397/read-cookie' }, at('chat-B'))));

  check('a cookie set in one conversation is carried there', /who=chatA/.test(carriedByA), carriedByA || '(none)');
  check('and is not carried into the other', !/who=chatA/.test(carriedByB), carriedByB || '(none)');

  const same = say(await tools.browser_tabs({}, at('chat-A')));
  check('coming back to a conversation finds it as it was', /5397/.test(same));

  // Closing is per conversation too. This was the loudest symptom: finishing in
  // one chat shut the browser somebody was still using in another.
  await tools.browser_close({}, at('chat-A'));
  const survivor = say(await tools.browser_tabs({}, at('chat-B')));
  check('closing one leaves the other open', /5397/.test(survivor), survivor.replace(/\n/g, ' ').slice(0, 90));

  // A sub-agent has no chatId. It is part of work already in flight rather than
  // a conversation, so they share one bucket instead of each opening a browser.
  await tools.browser_open({ url: 'http://127.0.0.1:5397/' }, { chatId: null });
  await tools.browser_open({ url: 'http://127.0.0.1:5397/' }, {});
  const shared = browserSessions().filter((s) => s.key === 'shared');
  check('sub-agents share a single bucket', shared.length === 1, `${shared.length}`);
}

await closeBrowser();
server.close();
fs.rmSync(process.env.WORKSPACE, { recursive: true, force: true });
console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll sandbox checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
