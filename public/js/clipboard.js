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
 * Nodes go before attributes: the selector above matches on `class`, and so
 * does the formula rewrite below it, so removing attributes first would leave
 * nothing to find either of them by.
 *
 * @param {Element|null} node
 * @returns {string}
 */
export function cleanHtml(node) {
  if (!node) return '';
  const clone = /** @type {Element} */ (node.cloneNode(true));

  for (const junk of clone.querySelectorAll(CHROME_SELECTOR)) junk.remove();

  /**
   * A formula, as the source that produced it.
   *
   * KaTeX renders every formula twice — a MathML copy for screen readers and a
   * pile of positioned glyph spans for the eye — and hides the first with
   * nothing but a class. Strip the classes and both become visible: the answer
   * arrives in the document as raw TeX followed by its own characters in the
   * wrong order.
   *
   * The TeX is what survives a paste with its meaning intact. MathML would
   * render as a real equation in Word, but Google Docs — which is where these
   * answers actually go — discards it, and a formula that silently vanishes is
   * worse than one written out.
   *
   * Before the attribute sweep, because the sweep removes the classes these are
   * found by.
   */
  for (const math of clone.querySelectorAll('.katex')) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? math.textContent;
    const display = !!math.closest('.katex-display');
    math.replaceWith(document.createTextNode(display ? `$$${tex}$$` : `$${tex}$`));
  }

  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const name of element.getAttributeNames()) {
      if (isChromeAttribute(name)) element.removeAttribute(name);
    }

    /**
     * This app's own links, as links that work from anywhere.
     *
     * `href` and `src` are kept because they are content — but the transcript's
     * are root-relative (`/api/attachments/…`), and a document is read
     * somewhere that has no idea what this app's origin is. The browser's own
     * serialiser absolutised them; this one has to do it itself, or a pasted
     * attachment link points at nothing. The target is behind a login, which is
     * a far better answer than a dead link.
     *
     * Resolved against `location.origin` rather than the current page's full
     * URL, so this never drags the SPA's own route or query string into a link
     * that never had one — a root-relative path only ever meant "this origin".
     *
     * An in-page anchor (`#section`) is left alone: rewritten against the
     * origin it would become a link back to this app's current route, which is
     * a worse answer than the bare fragment a reader can at least recognise as
     * unresolved. `mailto:` and `data:` need no guard of their own — `URL`
     * already treats a value with its own scheme as absolute and passes it
     * through untouched.
     */
    for (const name of ['href', 'src']) {
      const value = element.getAttribute(name);
      if (!value || value.startsWith('#')) continue;
      try {
        element.setAttribute(name, new URL(value, location.origin).href);
      } catch {
        // A value no URL parser accepts is left exactly as it was found.
      }
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
