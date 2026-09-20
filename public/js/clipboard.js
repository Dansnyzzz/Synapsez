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
