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
