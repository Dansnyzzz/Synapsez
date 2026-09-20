# Clean copy, and a turn that says why it stopped — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copying an answer out of the transcript produces a clean, editable document instead of a black block; assistant turns get a copy button; a turn that hits its step or token budget says so in the transcript and offers a button to carry on.

**Architecture:** One new browser module, `public/js/clipboard.js`, owns everything about "what goes on the clipboard" — the Word-safe document wrapper that already exists inside `viewer.js` moves there unchanged, and a new `cleanHtml()` strips the app's own styling off any DOM subtree. The transcript uses it from two places: a copy button on each assistant turn, and a `copy` event handler that rewrites what Ctrl+C puts on the clipboard. Separately, the two budget exits of the agent loop start sending a `stop` descriptor with `resumable: true`, which the browser draws as a persistent note with a Continue button instead of a toast that disappears.

**Tech Stack:** Plain ES modules, no build step, no new dependencies. Node's built-in test style used in this repo (a hand-rolled `check()` harness, one `.test.mjs` per area). Playwright for the browser suite.

## Global Constraints

- **No new runtime dependencies.** `public/js/` is served raw; anything imported must be a relative path to a file in the repo.
- **Both dictionaries or neither.** Every new key goes in `public/js/locales/en.js` *and* `public/js/locales/vi.js`. `test/i18n.test.mjs` fails the build on a mismatch.
- **Server sentences stay in English at the call site.** `server/i18n/vi.js` already holds `'Stopped after {0} steps. Send a message to continue.'` and the token equivalent — do not reword those two English strings, or their translations stop matching.
- **`stopReason` on the `done` event must keep its current values** (`'max_steps'`, `'token_limit'`). `server/workflows.js:138` reads `stopReason === 'max_steps'` to fail a workflow step. Adding a field is safe; renaming one is not.
- **The viewer's copy behaviour must not change.** Task 1 is a move, not a redesign; `npm run test:ui` covers the viewer.
- **Gate before claiming done:** `npm run check` (lint + typecheck + test + eval + sandbox + hooks) **and** `npm run test:ui`. `check` does not run `test:ui`.
- Work on branch `feat/clean-copy-and-step-limit`, which already exists and holds the spec commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `public/js/clipboard.js` | **New.** Everything about what lands on the clipboard: the Word-safe wrapper, the chrome-stripper, the write-with-fallback. No imports — pure enough to unit-test in Node. |
| `public/js/viewer.js` | Loses its private copies of those helpers; imports them instead. Behaviour unchanged. |
| `public/js/render.js` | `assistantMessage()` grows a copy button and a `markdownOf(node)` accessor; `stopNote()` grows an optional action button. |
| `public/js/app.js` | Wires the assistant copy button, the `copy` event handler, and the Continue button. |
| `public/css/app.css` | Reveals `.msg__actions` on an assistant turn too. |
| `public/js/locales/{en,vi}.js` | `chat.continue`, `stop.max_steps`, `stop.token_limit`. |
| `server/providers/stop.js` | `max_steps` and `token_limit` join `STOP_KINDS`; new `budgetStop()` and `isResumable()`. |
| `server/agent.js` | The two budget exits emit a `stop` descriptor on `done` instead of a throwaway `status`. |
| `server/settings.js` | `maxSteps` default 30 → 60. |
| `test/clipboard.test.mjs` | **New.** The pure parts: `forWord`, `isChromeAttribute`, `CHROME_SELECTOR`. Added to `npm test`. |
| `test/i18n.test.mjs` | New section: every stop kind a person can be shown has a string in both dictionaries. |
| `test/ui.test.mjs` | `cleanHtml` in a real browser; the assistant copy button; the Ctrl+C rewrite. |

---

### Task 1: `public/js/clipboard.js` — one place that decides what a paste looks like

**Files:**
- Create: `public/js/clipboard.js`
- Create: `test/clipboard.test.mjs`
- Modify: `public/js/viewer.js:625-650` (remove the constants and `forWord`), `public/js/viewer.js:651-678` (`copyRich` body), `public/js/viewer.js:713-738` (remove `legacyCopy`), `public/js/viewer.js:1-6` (imports)
- Modify: `package.json:44` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MONO`, `TABLE`, `CELL`, `HEAD` — the inline style strings the viewer's `copyPayload` builds tables with.
  - `forWord(html: string): string` — wraps a fragment in a full HTML document with a charset and a light stylesheet.
  - `CHROME_SELECTOR: string` — CSS selector for nodes that are interface, not content.
  - `isChromeAttribute(name: string): boolean` — true for `class`, `style`, and any `data-*`.
  - `cleanHtml(node: Element | null): string` — a copy of the subtree with chrome removed, as HTML.
  - `legacyCopy(html: string, text: string): boolean`
  - `writeRich({ html, text }: { html: string, text: string }): Promise<'rich' | 'plain' | false>`

- [ ] **Step 1: Write the failing test**

Create `test/clipboard.test.mjs`:

```js
/**
 * What goes on the clipboard — the parts that are pure strings.
 *
 * The bug this file exists for: an answer copied out of the transcript and
 * pasted into Google Docs arrived as a black block with light text, because
 * the browser's own `text/html` carries the computed style of a dark page.
 * The fix is to write the clipboard ourselves, and this checks the two
 * decisions that do not need a DOM — what the wrapper document says, and which
 * attributes count as the app's look rather than the answer's meaning.
 *
 * `cleanHtml` itself needs a real DOM and is checked in `test/ui.test.mjs`.
 *
 *   node test/clipboard.test.mjs
 */
import { forWord, isChromeAttribute, CHROME_SELECTOR } from '../public/js/clipboard.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

section('the wrapper document is what Word and Google Docs need');
{
  const html = forWord('<h2>Chênh lệch lãi suất</h2><p>Đã dừng sau 30 bước.</p>');

  // Without this, Word guesses Latin-1 and every diacritic becomes mojibake.
  check('it declares utf-8', html.includes('<meta charset="utf-8">'), html.slice(0, 60));
  check('Vietnamese survives it whole', html.includes('Chênh lệch lãi suất'));
  check('and so does the body text', html.includes('Đã dừng sau 30 bước.'));

  // The whole point: a document pasted out of a dark app is black-on-black
  // unless the payload says otherwise.
  check('text is black', html.includes('color:#000'), html.slice(0, 200));
  check('no dark background travels with it', !/background:\s*#(0|1|2)/i.test(html));
  check('tables get visible borders', html.includes('border:1px solid #999'));
  check('it is a whole document, not a fragment', html.startsWith('<html>') && html.endsWith('</html>'));
}

section('what counts as the app’s chrome rather than the answer');
{
  check('class is chrome', isChromeAttribute('class'));
  check('style is chrome', isChromeAttribute('style'));
  check('any data- attribute is chrome', isChromeAttribute('data-message-id') && isChromeAttribute('data-copy'));
  // These carry meaning a reader wants in their document.
  check('href is not chrome', !isChromeAttribute('href'));
  check('colspan is not chrome', !isChromeAttribute('colspan'));
  check('src is not chrome', !isChromeAttribute('src'));

  // The selector is matched against the real class names the transcript uses.
  // If one is renamed and this is not, copy quietly starts carrying buttons.
  for (const needed of ['button', '.copy-btn', '.msg__actions', '.step__shot']) {
    check(`${needed} is stripped`, CHROME_SELECTOR.includes(needed), CHROME_SELECTOR);
  }
}

console.log(
  failures
    ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
    : '\n\x1b[32mAll clipboard checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node test/clipboard.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` — `public/js/clipboard.js` does not exist yet.

- [ ] **Step 3: Write the module**

Create `public/js/clipboard.js`:

```js
/**
 * What goes on the clipboard.
 *
 * The browser's own copy is a rendering of *this page*: it carries the computed
 * style of every node in the selection, which on a dark transcript means a dark
 * background and light text. Google Docs and Word honour what they are given,
 * so an answer pasted into a report arrived as a black block that looked broken
 * and read as uneditable — light text on a light page once you typed into it.
 *
 * So the app writes the clipboard itself. Two flavours go on at once and the
 * application receiving the paste picks: `text/html` for a word processor,
 * `text/plain` for an editor. The HTML is stripped of everything that is this
 * app's look and wrapped in a document that states its own, light, defaults.
 *
 * Nothing is imported here on purpose. These decisions are the part worth
 * testing, and a module with no dependencies can be tested in Node without a
 * browser — see `test/clipboard.test.mjs`.
 */

/* ── the look a pasted document arrives with ───────────────────── */

export const MONO = 'font-family:Consolas,monospace;font-size:10pt;white-space:pre-wrap';
export const TABLE = 'border-collapse:collapse;font-family:Calibri,sans-serif;font-size:11pt';
export const CELL = 'border:1px solid #999;padding:4px 8px;';
export const HEAD = 'background:#f0f0f0;font-weight:bold;text-align:left';

/**
 * A whole HTML document, not a fragment.
 *
 * Word decides the encoding from the clipboard payload, and a bare fragment
 * with no charset arrives as Latin-1 — which turns every Vietnamese diacritic
 * into mojibake. The style block carries the parts of a readable document that
 * survive a paste; anything structural is already inline, because Word ignores
 * a stylesheet it cannot resolve.
 */
export const forWord = (html) =>
  '<html><head><meta charset="utf-8"><style>' +
  'body{font-family:Calibri,sans-serif;font-size:11pt;color:#000}' +
  'h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}' +
  'h1,h2,h3,h4{font-family:Calibri,sans-serif;color:#000;margin:12pt 0 6pt}' +
  `table{${TABLE}}th,td{${CELL}}th{${HEAD}}` +
  'blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:12pt;color:#444}' +
  `pre,code{${MONO}}` +
  '</style></head><body>' +
  html +
  '</body></html>';

/* ── stripping this app off a piece of it ──────────────────────── */

/**
 * Nodes that are interface rather than content.
 *
 * A code block's Copy button, the row of actions under a turn, the thumbnail
 * of a screenshot: all of them are things to press, and a document made of
 * pressed things is not what anybody meant to carry off.
 */
export const CHROME_SELECTOR = 'button, .copy-btn, .msg__actions, .step__shot';

/**
 * Attributes that describe how this app draws something, not what it means.
 *
 * `class` and `style` are the two that carry the dark theme. `data-*` is this
 * app's own bookkeeping — a message id, a file id — and is meaningless in a
 * document. Everything else stays: `href` is a source, `colspan` is table
 * structure, `src` is a picture.
 */
export const isChromeAttribute = (name) => name === 'class' || name === 'style' || name.startsWith('data-');

/**
 * A subtree as HTML, with this app stripped off it.
 *
 * Works on a clone, so nothing on screen is touched — the node being copied is
 * usually the answer the person is still reading.
 *
 * Nodes go before attributes: the selector above matches on `class`, so
 * removing attributes first would leave nothing to find the buttons by.
 *
 * @param {Element|null} node
 * @returns {string}
 */
export function cleanHtml(node) {
  if (!node) return '';
  const clone = /** @type {Element} */ (node.cloneNode(true));

  for (const junk of clone.querySelectorAll(CHROME_SELECTOR)) junk.remove();

  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const name of element.getAttributeNames()) {
      if (isChromeAttribute(name)) element.removeAttribute(name);
    }
  }

  return clone.innerHTML;
}

/* ── putting it there ──────────────────────────────────────────── */

/**
 * Select real nodes off-screen and let the browser do the copy.
 *
 * The fallback for any refusal of the async clipboard — an older browser, a
 * permission denied, a page that is not the active tab. It is given the bare
 * fragment rather than the wrapped document, because `innerHTML` on a live
 * element drops `<head>` and the stylesheet with it.
 */
export function legacyCopy(html, text) {
  const host = document.createElement('div');
  host.setAttribute('contenteditable', 'true');
  // Off-screen rather than hidden: `display:none` cannot be selected.
  host.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap';
  if (html) host.innerHTML = html;
  else host.textContent = text;
  document.body.appendChild(host);

  const range = document.createRange();
  range.selectNodeContents(host);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  selection.removeAllRanges();
  host.remove();
  return ok;
}

/**
 * Put both flavours of one thing on the clipboard.
 *
 * `html` is a *fragment*; the document wrapper is applied here so there is
 * exactly one place that decides what a pasted document looks like.
 *
 * @param {{html: string, text: string}} payload
 * @returns {Promise<'rich'|'plain'|false>} which flavour made it, or false
 */
export async function writeRich({ html, text }) {
  if (!html && !text) return false;
  try {
    if (html && window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([forWord(html)], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return 'rich';
    }
    await navigator.clipboard.writeText(text);
    return 'plain';
  } catch {
    return legacyCopy(html, text) ? 'rich' : false;
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node test/clipboard.test.mjs
```

Expected: `All clipboard checks passed.`

- [ ] **Step 5: Point the viewer at the module**

In `public/js/viewer.js`, add to the imports at the top (after the `markdown.js` line):

```js
import { MONO, TABLE, CELL, HEAD, writeRich } from './clipboard.js';
```

Delete these from `viewer.js`, now that they live in `clipboard.js`:
- the four `const MONO/TABLE/CELL/HEAD` declarations (lines 625-628)
- the `forWord` comment block and arrow function (lines 630-650)
- the whole `legacyCopy` function and its one-line comment (lines 713-738)

Replace the body of `copyRich` (lines 651-678) with:

```js
  async function copyRich() {
    // A picture has no text in it. Copying the image itself is what somebody
    // pressing Copy on a photograph meant.
    if (current.preview.kind === 'image') return copyImage();

    const { html, text } = copyPayload();
    if (!text && !html) return toast(t('viewer.nothingToCopy'), 'error');

    const wrote = await writeRich({ html, text });
    if (wrote === 'rich') toast(t('viewer.copiedRich'));
    else if (wrote === 'plain') toast(t('viewer.copied'));
    else toast(t('viewer.copyRefused'), 'error');
  }
```

- [ ] **Step 6: Add the suite to `npm test`**

In `package.json`, in the `"test"` script, insert `node test/clipboard.test.mjs && ` immediately before `node test/markdown.test.mjs`.

- [ ] **Step 7: Check nothing broke**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all pass. If `typecheck` complains that `cleanHtml` may return `Node` rather than `Element`, the cast in the code above is what answers it — make sure it was copied in.

- [ ] **Step 8: Commit**

```bash
git add public/js/clipboard.js public/js/viewer.js test/clipboard.test.mjs package.json
git commit -m "refactor(clipboard): one module decides what a paste looks like

The Word-safe wrapper lived in a closure inside the file viewer, so only an
attachment could be copied cleanly. Moved out whole, with the stripper the
transcript needs beside it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: A copy button on the assistant's answer

**Files:**
- Modify: `public/js/render.js:731-1157` (`assistantMessage`), and its export list
- Modify: `public/js/app.js:5` (imports), `public/js/app.js:2097-2137` (the transcript click listener)
- Modify: `public/css/app.css:1987-2002`

**Interfaces:**
- Consumes: `cleanHtml`, `writeRich` from Task 1.
- Produces: `markdownOf(node: Element): string` exported from `render.js` — the raw Markdown of the assistant turn rendered into `node`, or `''`.

- [ ] **Step 1: Add the raw-text register to `render.js`**

Near the top of `public/js/render.js`, below the imports:

```js
/**
 * The Markdown behind each assistant turn, keyed by the turn's own node.
 *
 * The copy button is served by one delegated listener on the whole transcript,
 * so it has a DOM node and needs the source that produced it. A WeakMap rather
 * than a `data-` attribute: an answer runs to tens of thousands of characters,
 * and a second copy of every one of them in the DOM is memory spent for
 * nothing. It also lets go by itself when a transcript is rebuilt.
 */
const RAW = new WeakMap();

/** The Markdown an assistant turn was rendered from. */
export const markdownOf = (node) => RAW.get(node) ?? '';
```

- [ ] **Step 2: Keep the register current**

Inside `assistantMessage()`, `rawText` is assigned in three places. Update each so the map follows it.

In `appendText`, the first line becomes two:

```js
    appendText(delta) {
      rawText += delta;
      RAW.set(wrap, rawText);
```

In `resetText`, immediately after `rawText = '';`:

```js
      RAW.delete(wrap);
```

- [ ] **Step 3: Grow the actions row when there is prose to copy**

Still inside `assistantMessage()`, add this helper above the `api` object:

```js
  /**
   * The copy button, added the moment there is prose worth copying.
   *
   * Not drawn up front: a turn that only ran tools has nothing to put on the
   * clipboard, and a button that copies an empty string is worse than no
   * button. Added once — `appendText` runs per delta.
   */
  function ensureActions() {
    if (wrap.querySelector(':scope > .msg__actions')) return;
    const actions = el('div', 'msg__actions');
    actions.innerHTML =
      `<button class="msg__action" type="button" data-act="copy" title="${escapeHtml(t('chat.copy'))}" aria-label="${escapeHtml(t('chat.copy'))}">` +
      '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6">' +
      '<rect x="7" y="7" width="9.5" height="9.5" rx="2" /><path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" />' +
      '</svg></button>';
    wrap.append(actions);
  }
```

Call it from `appendText`, in the branch that creates `prose`:

```js
      if (!prose) {
        closeGroup();
        prose = el('div', 'prose');
        body.append(prose);
        ensureActions();
      }
```

And remove it in `resetText`, beside the `prose.remove()`:

```js
      wrap.querySelector(':scope > .msg__actions')?.remove();
```

- [ ] **Step 4: Reveal it in CSS**

In `public/css/app.css`, extend the two reveal rules so an assistant turn behaves like a user one. Replace:

```css
.msg--user:hover .msg__actions {
  opacity: 1;
}
```

with:

```css
.msg--user:hover .msg__actions,
.msg--assistant:hover .msg__actions {
  opacity: 1;
}
```

and replace:

```css
.msg--user:has(.msg__action:focus-visible) .msg__actions {
  opacity: 1;
}
```

with:

```css
.msg--user:has(.msg__action:focus-visible) .msg__actions,
.msg--assistant:has(.msg__action:focus-visible) .msg__actions {
  opacity: 1;
}
```

- [ ] **Step 5: Wire the click**

In `public/js/app.js`, add to the imports at the top:

```js
import { cleanHtml, writeRich } from './clipboard.js';
```

and add `markdownOf` to the existing `render.js` import list.

In the `$('messages')` click listener, replace the block from `const button = event.target.closest('.msg__action');` down to the `if (button.dataset.act === 'edit')` line with:

```js
  const button = event.target.closest('.msg__action');
  if (!button) return;

  // A button clicked with the pointer keeps focus, which used to leave the row
  // lit after the mouse had gone. `detail` is 0 when the click came from the
  // keyboard, and those want their focus kept — that is how they got here.
  if (event.detail > 0) button.blur();

  const done = () => {
    button.classList.add('is-done');
    setTimeout(() => button.classList.remove('is-done'), 1200);
  };

  /**
   * The assistant's answer, as a document rather than as a screenshot of one.
   *
   * Both flavours go on: a word processor takes the HTML — stripped of this
   * app's dark theme, which is the whole bug — and an editor takes the
   * Markdown the answer was written in.
   */
  const assistant = button.closest('.msg--assistant');
  if (assistant) {
    const wrote = await writeRich({
      html: cleanHtml(assistant.querySelector('.prose')),
      text: markdownOf(assistant),
    });
    if (wrote) done();
    else toast(t('clipboard.failed'), 'error');
    return;
  }

  const message = button.closest('.msg--user');
  const text = message?.querySelector('.bubble__text')?.textContent ?? '';

  if (button.dataset.act === 'copy') {
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      // Denied permission, or an insecure origin. Selecting it is the fallback
      // every browser still allows.
      toast(t('clipboard.failed'), 'error');
    }
    return;
  }

  if (button.dataset.act === 'edit') beginEdit(message, text);
```

- [ ] **Step 6: Check it**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all pass. `test/i18n.test.mjs` sees the new `t('chat.copy')` call in `render.js` — that key already exists in both dictionaries, so it stays green.

- [ ] **Step 7: Commit**

```bash
git add public/js/render.js public/js/app.js public/css/app.css
git commit -m "feat(chat): copy the assistant's answer, as a document

The answer is the thing people carry off into a report, and it was the one
turn in the transcript with no way to take it. Copies the rendered answer
without this app's dark theme on it, and the Markdown beside it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Selecting by hand and pressing Ctrl+C

**Files:**
- Modify: `public/js/app.js` (immediately after the transcript click listener added in Task 2)

**Interfaces:**
- Consumes: `cleanHtml`, `forWord` from Task 1.
- Produces: nothing other modules use.

- [ ] **Step 1: Add the handler**

In `public/js/app.js`, directly below the `$('messages').addEventListener('click', …)` block, add:

```js
/**
 * Dragging across an answer and pressing Ctrl+C.
 *
 * This is how people actually copy — the button is the deliberate path, this
 * is the reflex — and left alone it is the bug: the browser builds `text/html`
 * from the *computed* style of the selection, so a transcript drawn on a dark
 * page pastes into Google Docs as a black block with light text. Typing into
 * it then produces light text on a light background, which reads as a document
 * that cannot be edited.
 *
 * So the clipboard is written here instead, from the same stripped HTML the
 * copy button uses. The plain flavour is the browser's own `toString()`, which
 * is exactly what was selected.
 */
$('messages').addEventListener('copy', (event) => {
  // Copying out of a message being rewritten is the browser's business.
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  if (!$('messages').contains(range.commonAncestorContainer)) return;

  // `cloneContents` gives a fragment; `cleanHtml` wants an element to clone.
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  const html = cleanHtml(holder);
  if (!html) return;

  event.clipboardData?.setData('text/html', forWord(html));
  event.clipboardData?.setData('text/plain', selection.toString());
  event.preventDefault();
});
```

Add `forWord` to the `clipboard.js` import line added in Task 2:

```js
import { cleanHtml, forWord, writeRich } from './clipboard.js';
```

- [ ] **Step 2: Check it**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "fix(chat): selecting an answer and copying it no longer carries the dark theme

The browser builds text/html from the computed style of the selection, so a
transcript on a dark page pasted into Google Docs as a black block that looked
uneditable. The clipboard is written here instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The server says a budget ran out, and that it can carry on

**Files:**
- Modify: `server/providers/stop.js:44-59`
- Modify: `server/agent.js:1077-1085` (the token branch), `server/agent.js:1367-1373` (the step branch)
- Modify: `server/settings.js:11`
- Modify: `public/js/locales/en.js:72`, `public/js/locales/vi.js:204`
- Modify: `test/i18n.test.mjs` (new section)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `STOP_KINDS` additionally contains `'max_steps'` and `'token_limit'`.
  - `isResumable(kind: string): boolean` exported from `server/providers/stop.js`.
  - `budgetStop(kind: string, message: string): {kind: string, raw: string, message: string, detail: null, resumable: true}` exported from `server/providers/stop.js`.
  - The `done` stream event for both budget exits now carries `stop` alongside the unchanged `stopReason`.

- [ ] **Step 1: Write the failing test**

In `test/i18n.test.mjs`, add this section immediately before the final `console.log(...)` block:

```js
/**
 * Every reason a reply can stop short has a sentence in both languages.
 *
 * `noteStop` in app.js looks up `stop.<kind>` with the kind computed at
 * runtime, so the "strings the script builds" section above cannot see it — a
 * computed key is skipped rather than guessed at. Without this check a new
 * stop kind reaches the transcript as the literal text `stop.max_steps`.
 *
 * Only the kinds that mean the reply is *not* finished: `end_turn`,
 * `tool_use` and `stop_sequence` are never drawn.
 */
section('every way a reply can stop short has a sentence');
{
  const { STOP_KINDS, isComplete } = await import('../server/providers/stop.js');
  const shown = STOP_KINDS.filter((kind) => !isComplete(kind));

  check('there are kinds to check', shown.length > 0, shown.join(', '));
  const missing = shown.filter((kind) => !(`stop.${kind}` in vi) || !(`stop.${kind}` in en));
  check('and each one has a string in both languages', missing.length === 0, missing.join(', '));

  // The two budget exits are the ones a person can act on, so they must exist
  // as kinds at all — a typo here would silently fall back to `stop.unknown`.
  check('running out of steps is one of them', shown.includes('max_steps'));
  check('running out of tokens is another', shown.includes('token_limit'));
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node test/i18n.test.mjs
```

Expected: FAIL — `running out of steps is one of them` and `running out of tokens is another`, because `STOP_KINDS` has neither.

- [ ] **Step 3: Teach `stop.js` the two budgets**

In `server/providers/stop.js`, extend the exported list and add the two helpers below `isComplete`:

```js
export const STOP_KINDS = [
  'end_turn',
  'tool_use',
  'truncated',
  'refused',
  'filtered',
  'recitation',
  'stop_sequence',
  'max_steps',
  'token_limit',
  'unknown',
];

/** The kinds that mean the reply in front of the user is whole. */
const COMPLETE = new Set(['end_turn', 'tool_use', 'stop_sequence']);

/** Whether this outcome left the user with a finished answer. */
export const isComplete = (kind) => COMPLETE.has(kind);

/**
 * The kinds that stopped for want of budget rather than because anything went
 * wrong — so the same turn, unchanged, carries on if it is asked to.
 *
 * This is the distinction the interface needs to decide whether offering a
 * Continue button is honest. A reply blocked by a content filter must not get
 * one: pressing it would produce the same refusal.
 */
const RESUMABLE = new Set(['max_steps', 'token_limit']);

/** Whether a turn that stopped this way can simply be told to carry on. */
export const isResumable = (kind) => RESUMABLE.has(kind);

/**
 * The `stop` descriptor for a turn that ran out of a budget.
 *
 * Shaped exactly like `normaliseStop`'s result so the browser has one thing to
 * read, with `resumable` added. These do not come from a provider — they are
 * this server's own limits — so `raw` is the kind itself.
 */
export function budgetStop(kind, message) {
  return { kind, raw: kind, message, detail: null, resumable: isResumable(kind) };
}
```

- [ ] **Step 4: Add the two strings, in both languages**

In `public/js/locales/en.js`, after `'stop.unknown'`:

```js
  'stop.max_steps':
    'Stopped here because this turn used all the tool steps it is allowed. Nothing went wrong — press Continue to carry on from exactly here, or raise the limit in Settings → Behaviour.',
  'stop.token_limit':
    'Stopped here because this turn used all the tokens it is allowed. Nothing went wrong — press Continue to carry on from exactly here, or raise the limit in Settings → Behaviour.',
```

In `public/js/locales/vi.js`, after `'stop.unknown'`:

```js
  'stop.max_steps':
    'Dừng ở đây vì lượt này đã dùng hết số bước công cụ được phép. Không có gì hỏng — bấm Tiếp tục để chạy tiếp từ đúng chỗ này, hoặc nâng giới hạn trong Cài đặt → Hành vi.',
  'stop.token_limit':
    'Dừng ở đây vì lượt này đã dùng hết số token được phép. Không có gì hỏng — bấm Tiếp tục để chạy tiếp từ đúng chỗ này, hoặc nâng giới hạn trong Cài đặt → Hành vi.',
```

- [ ] **Step 5: Run the i18n test and watch it pass**

```bash
node test/i18n.test.mjs
```

Expected: `All ... checks passed.` — every non-complete kind now has a string on both sides.

- [ ] **Step 6: Send the descriptor from the loop**

`server/agent.js` does not import from `./providers/stop.js` today — it only reads the `stop`
object the provider layer hands back. Add the import directly below line 5
(`import { streamCompletion } from './providers/index.js';`):

```js
import { budgetStop } from './providers/stop.js';
```

Replace the token-budget branch (around line 1077):

```js
    // Checked before the next request, not after: the point is not to send it.
    if (turnLimit && turnTokens >= turnLimit) {
      /**
       * Said on `done`, not as a passing status line.
       *
       * It used to be a `status` event, which the browser shows as a toast —
       * gone in three seconds, leaving a turn that appears to have stopped for
       * no reason. It is the opposite of passing information: the one thing
       * somebody needs to know about this turn is why it is not finished.
       */
      const stop = budgetStop(
        'token_limit',
        `Stopped after ${turnTokens.toLocaleString()} tokens in this turn. Send a message to continue.`,
      );
      emit('done', { stopReason: 'token_limit', stop });
      return;
    }
```

Replace the step-budget exit at the end of the loop (around line 1367):

```js
  // `stopReason` keeps its value: server/workflows.js reads it to fail a step
  // that ran out of room, and the browser reads `stop` to offer the way on.
  const stop = budgetStop('max_steps', `Stopped after ${prefs.maxSteps} steps. Send a message to continue.`);
  emit('done', { stopReason: 'max_steps', stop });
}
```

Both English sentences are unchanged from what is there now, so their entries in `server/i18n/vi.js:18-20` keep matching.

- [ ] **Step 7: Raise the default budget**

In `server/settings.js`, line 11:

```js
  /**
   * How many tool steps one turn may take.
   *
   * Thirty was a guess made before anything used the research tools, and a
   * real question — "look into this project and tell me what you find" — burns
   * fifteen to twenty-five searches and fetches before it has anything to say.
   * Hitting the ceiling mid-answer was the single most common way a turn
   * ended. Sixty covers that work; the hard cap in `server/app.js` is 100 for
   * anyone who wants more.
   *
   * This is the default for a *new* account. An account that already has prefs
   * stored keeps the number it has — Settings → Behaviour is where it changes.
   */
  maxSteps: 60,
```

- [ ] **Step 8: Check the whole server side**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all pass, including `test/server-i18n.test.mjs` (the two English sentences still have their Vietnamese entries) and `test/workflow.test.mjs` (`stopReason` unchanged).

- [ ] **Step 9: Commit**

```bash
git add server/providers/stop.js server/agent.js server/settings.js public/js/locales/en.js public/js/locales/vi.js test/i18n.test.mjs
git commit -m "fix(agent): a turn that runs out of budget says so where it can be read

Running out of steps or tokens ended the turn behind a three-second toast, so
a long piece of research appeared to stop for no reason. It travels on 'done'
as a stop descriptor now, marked resumable, and the default step budget goes
from thirty to sixty.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The note in the transcript, and the Continue button

**Files:**
- Modify: `public/js/render.js` (`stopNote`)
- Modify: `public/js/app.js` (`noteStop`, and the `done` handler at ~2812)
- Modify: `public/css/app.css` (beside the existing `.stopnote` rules)
- Modify: `public/js/locales/en.js`, `public/js/locales/vi.js`

**Interfaces:**
- Consumes: `stop.resumable` from Task 4.
- Produces: `stopNote(kind: string, text: string, onContinue?: (() => void) | null): HTMLElement` — the third argument, when given, draws a button that calls it.

- [ ] **Step 1: Give `stopNote` an action**

In `public/js/render.js`, replace `stopNote` with:

```js
export function stopNote(kind, text, onContinue = null) {
  const wrap = el('div', `stopnote stopnote--${kind || 'unknown'}`);
  wrap.setAttribute('role', 'status');
  const line = el('div', 'stopnote__line');
  line.textContent = text;
  wrap.append(line);

  /**
   * The way on, where the explanation is.
   *
   * Only for the stops that really can carry on — see `isResumable` on the
   * server. Offering it on a refusal would be a button that reproduces the
   * refusal, which is worse than no button.
   *
   * It removes itself before handing over: a second press would start a second
   * run against the same conversation, which the run lock refuses with a 409
   * and which reads as the button being broken.
   */
  if (onContinue) {
    const go = el('button', 'stopnote__go');
    go.type = 'button';
    go.textContent = t('chat.continue');
    go.addEventListener('click', () => {
      wrap.remove();
      onContinue();
    });
    wrap.append(go);
  }

  return wrap;
}
```

- [ ] **Step 2: Add the label, in both languages**

`public/js/locales/en.js`, beside `'chat.edit'`:

```js
  'chat.continue': 'Continue',
```

`public/js/locales/vi.js`, beside `'chat.edit'`:

```js
  'chat.continue': 'Tiếp tục',
```

- [ ] **Step 3: Style the button**

In `public/css/app.css`, immediately after the existing `.stopnote__line` rule, add:

```css
/* The way on, where the explanation is — see stopNote(). */
.stopnote__go {
  display: inline-block;
  margin-top: 8px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.14s, border-color 0.14s;
}
.stopnote__go:hover {
  border-color: var(--accent);
  color: var(--text);
}
```

`.stopnote` (line 3815) is an ordinary block with padding, so `inline-block` puts the
button on its own line under the sentence with no layout change to the note itself.
`--max_steps` and `--token_limit` get no colour rule of their own, so they inherit the
amber `.stopnote` default — which is the right reading: worth noticing, not an error.

- [ ] **Step 4: Pass the handler through `noteStop`**

In `public/js/app.js`, change the signature and the final lines of `noteStop`:

```js
function noteStop({ kind, message, detail, resumable }, run) {
```

and replace its last two statements:

```js
  run.stage.append(
    stopNote(kind, body, resumable && onScreen(run) ? () => { void stream(); } : null),
  );
  maybeScroll(run);
```

`onScreen(run)` guards the button rather than the note: the note is a record of what happened and belongs in every copy of the transcript, but a button that starts a run belongs only in the conversation somebody is looking at.

- [ ] **Step 5: Check the note is drawn at all**

The `done` handler already reads `stop?.message`, and Task 4 now sends one — no change needed there. Confirm by reading `public/js/app.js` around line 2812 that the handler is:

```js
          if (stop?.message) noteStop(stop, run);
```

If it destructures fewer fields than `noteStop` now expects, it does not matter: the whole `stop` object is passed through.

- [ ] **Step 6: Check it**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all pass. `test/i18n.test.mjs` picks up the literal `t('chat.continue')` in `render.js` and finds it in both dictionaries.

- [ ] **Step 7: Commit**

```bash
git add public/js/render.js public/js/app.js public/css/app.css public/js/locales/en.js public/js/locales/vi.js
git commit -m "feat(chat): a turn that stopped for room offers the way on

The explanation stays in the transcript instead of vanishing with a toast, and
carries a Continue button that resumes the turn from exactly where it stopped
— no 'continue' message typed into the conversation, and none stored in it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Prove it in a real browser, then run the whole gate

**Files:**
- Modify: `test/ui.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: Write the browser checks**

In `test/ui.test.mjs`, add this block immediately before `await browser.close();` at the end of
the file. It uses the `page`, `section()` and `check()` already defined at lines 78 and 97-98 —
the same style as every section above it.

```js
section('copying an answer out does not carry the dark theme with it');
{
  // The stripper, against the exact shapes the transcript produces: a code
  // block with its Copy button, a table, a heading with a class on it.
  const stripped = await page.evaluate(async () => {
    const { cleanHtml } = await import('/js/clipboard.js');
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="prose" data-message-id="m1">' +
      '<h2 class="h" style="background:#111;color:#eee">Chênh lệch lãi suất</h2>' +
      '<table><tr><th>Năm</th><td>2026</td></tr></table>' +
      '<p>Xem <a href="https://example.com/a">nguồn</a>.</p>' +
      '<div class="codeblock"><div class="codeblock__bar"><span>js</span>' +
      '<button class="copy-btn" data-copy>Copy</button></div><pre><code>x=1</code></pre></div>' +
      '</div>';
    return cleanHtml(host);
  });

  check('no class survives', !stripped.includes('class='), stripped.slice(0, 160));
  check('no inline style survives', !stripped.includes('style='), stripped.slice(0, 160));
  check('no data- attribute survives', !stripped.includes('data-'), stripped.slice(0, 160));
  check('the Copy button is gone', !stripped.includes('Copy</button>'));
  check('the heading is still a heading', stripped.includes('<h2>Chênh lệch lãi suất</h2>'));
  check('the table is still a table', stripped.includes('<th>Năm</th>') && stripped.includes('<td>2026</td>'));
  check('the source link survives', stripped.includes('href="https://example.com/a"'));
  check('the code is still there', stripped.includes('x=1'));
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
```

- [ ] **Step 2: Run the browser suite**

```bash
npm run test:ui
```

Expected: every check above passes, and every pre-existing check still passes — especially the viewer's copy checks, which is what proves Task 1's move changed nothing.

- [ ] **Step 3: Run the full gate**

```bash
npm run check
```

Expected: lint, typecheck, the whole `npm test` run, the eval suite, the sandbox suite and the hooks suite all pass. Read the output — do not assume.

- [ ] **Step 4: Read the diff line by line**

```bash
git diff main...HEAD
```

Look for: a leftover `console.log`, an unused import in `viewer.js` (`escapeHtml` is still used by `copyPayload` — check before removing anything), a `data-` attribute left on the clipboard path, and any English string that reached the interface without a Vietnamese twin.

- [ ] **Step 5: Commit**

```bash
git add test/ui.test.mjs
git commit -m "test(ui): the copy path and the budget note, in a real browser

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Handover notes for whoever reports this finished

Say these plainly rather than leaving them to be discovered:

1. **The new `maxSteps` default only reaches new accounts.** Preferences are stored as one blob, so an existing account keeps its 30. The owner must open **Settings → Behaviour → "Số bước công cụ tối đa mỗi lượt"** and raise it — up to 100.
2. **The budget note lives in the open page.** Reload and it is gone, exactly like every other stop note. That was a deliberate scope decision, not an oversight.
3. **A selection that cuts through the middle of a table** pastes as a partial table. That is what `cloneContents` gives, and it matches what the browser did before.
4. **`npm run check` does not run `test:ui`.** If only `check` was run, say so — do not call the browser work verified.
