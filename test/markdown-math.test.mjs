/**
 * Mathematics and code in a reply, on the shapes a model actually wrote.
 *
 * From a real conversation about NPV: formulas arrived as `$\frac{…}{…}$` and
 * `$$\text{NPV} = …$$` and were printed as backslashes and braces, and an
 * Excel formula written as a fenced block indented under a bullet was swallowed
 * into the bullet's text as a string of backticks.
 *
 * KaTeX is not loaded in Node, so a formula comes out as its placeholder — the
 * element the browser typesets, carrying the source. That placeholder is the
 * contract checked here; the typesetting itself is KaTeX's and is checked in the
 * browser suite.
 *
 *   node test/markdown-math.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { renderMarkdown, escapeHtml } from '../public/js/markdown.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
function check(what, ok, note = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${what}${note ? ` — ${note}` : ''}`);
}

const BT = '`';
const FENCE = BT.repeat(3);
const pending = (html, tex, display) =>
  html.includes(`class="math is-pending${display ? ' math--display' : ''}" data-tex="${escapeHtml(tex)}"`);

section('TeX is typeset rather than printed as backslashes');
{
  const inlineFormula = renderMarkdown('công thức $\\frac{\\text{CF}_t}{(1+r)^t}$ rồi.');
  check('inline $…$ becomes a formula', pending(inlineFormula, '\\frac{\\text{CF}_t}{(1+r)^t}', false), inlineFormula);
  check('and its underscores are not read as italics', !inlineFormula.includes('<em>'), inlineFormula);

  const display = renderMarkdown('- **NPV:** $$\\text{NPV} = 9298.18 - 0$$');
  check('$$…$$ inside a bullet is a display formula', pending(display, '\\text{NPV} = 9298.18 - 0', true), display);
  check('and the bold before it still renders', display.includes('<strong>NPV:</strong>'), display);

  const block = renderMarkdown(['$$', '\\sum_{t=1}^{5} PV_t', '$$'].join('\n'));
  check('$$ on lines of its own is a formula block', block.startsWith('<div class="math-block">') && pending(block, '\\sum_{t=1}^{5} PV_t', true), block);

  const oneLineBlock = renderMarkdown(['Trước', '', '$$ a^2 + b^2 = c^2 $$', '', 'Sau'].join('\n'));
  check('a one-line $$ block is a block', oneLineBlock.includes('<div class="math-block">') && pending(oneLineBlock, 'a^2 + b^2 = c^2', true), oneLineBlock);

  const brackets = renderMarkdown('so \\(x^2\\) and \\[y = mx + b\\]');
  check('\\(…\\) is inline maths', pending(brackets, 'x^2', false), brackets);
  check('\\[…\\] is display maths', pending(brackets, 'y = mx + b', true), brackets);

  const money = renderMarkdown('It costs $5 and $10 in total.');
  check('prices are not mistaken for a formula', !money.includes('math') && money.includes('$5 and $10'), money);
  const arithmetic = renderMarkdown('so $10135.01 - 2000 = 8135.01$ here');
  check('an equation between dollars is a formula', pending(arithmetic, '10135.01 - 2000 = 8135.01', false), arithmetic);
  check('a bare number between dollars stays text', !renderMarkdown('between $100$ and more').includes('math'));
  check('an escaped dollar is a dollar', renderMarkdown('pay \\$5 then \\$6').includes('pay $5 then $6'));
  check('code keeps its dollars', renderMarkdown(`run ${BT}echo $HOME $PATH${BT}`).includes('<code>echo $HOME $PATH</code>'));
  check('a fenced block keeps its dollars', renderMarkdown([FENCE, 'x = $a + $b', FENCE].join('\n')).includes('x = $a + $b'));

  const hostile = renderMarkdown('$\\text{<img src=x onerror=alert(1)>}$ and $$<script>x</script>$$');
  check('a formula cannot carry markup through', !hostile.includes('<img') && !hostile.includes('<script'), hostile);

  const unclosed = renderMarkdown('$$\\text{still streaming');
  check('an unfinished formula mid-stream is left as text', !unclosed.includes('math') && unclosed.includes('still streaming'), unclosed);
}

section('a code block written under a bullet stays a code block');
{
  const html = renderMarkdown(
    [
      '- Công thức NPV đúng chuẩn là:',
      `  ${FENCE}excel`,
      '  =NPV(B1, C5:G5) + B5',
      `  ${FENCE}`,
      `  *(Nếu B5 là số âm thì thay bằng ${BT}-B5${BT}).*`,
      '- Bước tiếp theo',
    ].join('\n'),
  );
  check('the code is a real code block', html.includes('<pre><code>=NPV(B1, C5:G5) + B5</code></pre>'), html);
  check('labelled with its language', html.includes('<span>excel</span>'));
  check('inside the bullet it belongs to', html.includes('<li>Công thức NPV đúng chuẩn là:<div class="codeblock">'), html);
  check(
    'the note under it stays in that bullet',
    html.includes('</div><em>(Nếu B5 là số âm thì thay bằng <code>-B5</code>).</em></li>'),
    html,
  );
  check('the next bullet is its own', html.includes('<li>Bước tiếp theo</li>'));
  check('no stray backticks are left', !html.includes(BT), html);

  const multiline = renderMarkdown(['1. Mở Excel', `   ${FENCE}`, '   =A1', '   =A2', `   ${FENCE}`].join('\n'));
  check('the indent is removed from every line of the code', multiline.includes('<code>=A1\n=A2</code>'), multiline);
}

section('inline code follows CommonMark');
{
  const oneLine = renderMarkdown(`Chỉ cần: ${FENCE}excel =SUM(C6:G6) + B6${FENCE} là xong`);
  check('triple backticks on one line are inline code, minus the language', oneLine.includes('<code>=SUM(C6:G6) + B6</code>'), oneLine);
  const nested = renderMarkdown(`use ${BT}${BT} a ${BT} b ${BT}${BT} here`);
  check('a double-backtick span keeps a single backtick inside', nested.includes(`<code>a ${BT} b</code>`), nested);
  check('an ordinary span still works', renderMarkdown(`a ${BT}x_y${BT} b`).includes('<code>x_y</code>'));
}

section('the vendored KaTeX is the installed one');
{
  const require = createRequire(import.meta.url);
  const installed = JSON.parse(fs.readFileSync(require.resolve('katex/package.json'), 'utf8')).version;
  const root = path.join(import.meta.dirname, '..', 'public', 'vendor', 'katex');
  const vendored = fs.existsSync(path.join(root, 'VERSION')) ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() : '';
  check('public/vendor/katex matches package.json — run scripts/vendor-katex.js after an upgrade', vendored === installed, `${vendored} vs ${installed}`);
  for (const file of ['katex.min.js', 'katex.min.css']) check(`${file} is there`, fs.existsSync(path.join(root, file)));
  const css = fs.readFileSync(path.join(root, 'katex.min.css'), 'utf8');
  const fonts = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
  const missing = fonts.filter((f) => !fs.existsSync(path.join(root, f)));
  check('every font the stylesheet names is there', fonts.length > 0 && missing.length === 0, missing.slice(0, 3).join(', '));
}

section('a formula never lands inside a link address');
{
  // The slot for "$y$" is NUL-delimited; the link rule used to accept it, and
  // the formula's markup — its quotes with it — ended up inside href="…".
  const html = renderMarkdown('[x](https://a.com/$y$) và tiếp');
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  // eslint-disable-next-line no-control-regex -- the slot marker is exactly what must not appear
  check('no href holds markup', hrefs.every((h) => !/[<>\u0000]/.test(h)), JSON.stringify(hrefs));
  check('  and the link text is not lost', />x</.test(html) || /\[x\]/.test(html), html.slice(0, 160));
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll markdown maths checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
