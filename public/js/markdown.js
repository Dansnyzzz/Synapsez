/**
 * A small, dependency-free Markdown renderer.
 *
 * Everything is escaped before any markup is generated, so model output can
 * never inject HTML. Supports headings, lists, code fences, inline formatting,
 * blockquotes, tables, links, rules and TeX mathematics — the subset chat models
 * actually emit.
 */
import { t } from './i18n.js';
import { mathHtml } from './math.js';

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A placeholder the source text cannot contain.
 *
 * Inline code is lifted out before emphasis is applied and put back afterwards,
 * which needs a marker to stand in for it. A fixed one is a string a model can
 * simply write — and then its own text addresses somebody else's slot in the
 * array. Nothing escapes (every character was escaped before this runs), but the
 * output is wrong, and "wrong rather than exploitable" is a poor thing to rest
 * on. A token minted per call cannot be guessed by text written beforehand.
 */
const marker = () => `\u0000${Math.random().toString(36).slice(2, 10)}\u0000`;

/**
 * A language name a model puts after inline triple backticks — ```excel =SUM(A1:A3)```
 * — which is a fence's info string written on one line, not part of the code.
 */
const INLINE_LANGUAGE =
  /^(?:excel|formula|sheets|js|javascript|ts|typescript|python|py|sql|bash|sh|shell|powershell|ps1|cmd|json|yaml|yml|html|css|xml|text|txt|plaintext|markdown|md|latex|tex|math|c|cpp|csharp|cs|java|go|rust|php|ruby|r)\s+/i;

/**
 * Pieces of a line that must not be read as Markdown, lifted out first.
 *
 * Code spans follow CommonMark: a run of N backticks is closed by a run of
 * exactly N, so `` ``a ` b`` `` keeps its inner backtick. Mathematics follows
 * Pandoc's rules for `$`, which is what keeps prices from turning into formulas:
 * an opening `$` must be followed by a non-space, a closing one preceded by a
 * non-space and not followed by a digit — so "$5 and $10" stays text while
 * `$x^2$` and `$10 - 2 = 8$` are typeset. `\$` is a literal dollar sign.
 */
function protect(text, hold) {
  return String(text)
    .replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (whole, ticks, body) => {
      let code = body;
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      if (ticks.length >= 3) code = code.replace(INLINE_LANGUAGE, '');
      return hold(`<code>${escapeHtml(code)}</code>`);
    })
    .replace(/\\\$/g, () => hold('$'))
    .replace(/\$\$([\s\S]+?)\$\$/g, (whole, tex) => hold(mathHtml(tex, true)))
    .replace(/\\\[([\s\S]+?)\\\]/g, (whole, tex) => hold(mathHtml(tex, true)))
    .replace(/\\\(([\s\S]+?)\\\)/g, (whole, tex) => hold(mathHtml(tex, false)))
    .replace(/(?<![\\$\w])\$(?=\S)([^$\n]*?[^\s\\$])\$(?![\d$])/g, (whole, tex) =>
      // A bare number between dollars is money written oddly, not a formula.
      /^[\d.,\s]+$/.test(tex) ? whole : hold(mathHtml(tex, false)),
    );
}

function inline(text) {
  const slots = [];
  const token = marker();
  const hold = (html) => {
    slots.push(html);
    return `${token}${slots.length - 1}${token}`;
  };

  // Code and mathematics first, so their contents are not re-processed as
  // emphasis — an underscore in `CF_t` is a subscript, not italics.
  let out = escapeHtml(protect(text, hold));

  out = out
    // The one tag let back through after escaping. A model writes `<br>` to
    // stack lines inside a table cell — GFM has no multi-line cell, so this is
    // the only way — and it turns up in ordinary prose as a hard break too.
    // Done here, after code has been tokenised out above, so a `<br>` written
    // inside inline code stays literal; and only `<br>` is un-escaped, so no
    // other tag rides along.
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*(?!\s)(.+?)(?<!\s)\*/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    // Only http(s) and relative links — no javascript: URLs.
    // And never a slot marker (NUL): "[x](https://a/$y$)" put a formula's span —
    // quotes included — inside the href.
    // eslint-disable-next-line no-control-regex
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)\u0000]+|\/[^\s)\u0000]*)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    // A bare URL stops at a slot marker (NUL), so a formula or code span written
    // straight after a link is not pulled into its href.
    // eslint-disable-next-line no-control-regex
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)\u0000]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const restore = new RegExp(`${token}(\\d+)${token}`, 'g');
  return out.replace(restore, (_, i) => slots[Number(i)] ?? '');
}

function codeBlock(language, body) {
  const label = language || 'text';
  return (
    `<div class="codeblock">` +
    `<div class="codeblock__bar"><span>${escapeHtml(label)}</span>` +
    `<button class="copy-btn" type="button" data-copy>${escapeHtml(t('chat.copy'))}</button></div>` +
    `<pre><code>${escapeHtml(body)}</code></pre>` +
    `</div>`
  );
}

/**
 * One row of a table into its cells.
 *
 * The outer pipes are optional — plenty of models write `a | b | c` with none —
 * so they are stripped if present rather than required. `\|` is an escaped pipe
 * inside a cell and must not split it.
 */
function tableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (/(^|[^\\])\|$/.test(text)) text = text.slice(0, -1);
  return text
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** `|---|:--:|` — the line under a header that makes the rows above it a table. */
function alignments(line) {
  const cells = tableRow(line);
  if (!cells.length || !cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells.map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '',
  );
}

/**
 * Does a table begin on this line?
 *
 * Asked in three places, not one. A table was only recognised at the top of the
 * block loop, which meant it was invisible to the paragraph gatherer and the
 * list-item gatherer below — so a table written directly under a line of text,
 * with no blank line between, was swallowed into that paragraph and printed as
 * raw pipes. Models write exactly that, constantly.
 *
 * The cell counts must agree, which is what stops an ordinary sentence
 * containing a pipe from turning the line under it into a table header.
 */
function tableAt(lines, i) {
  const head = lines[i];
  if (!head || !head.includes('|')) return false;
  const aligns = alignments(lines[i + 1] || '');
  return !!aligns && aligns.length === tableRow(head).length;
}

/** An opening code fence, indented or not: ``````lang``. */
const FENCE_OPEN = /^(\s*)```(\S*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
/** A display-maths block starting on its own line: `$$` or `\[`. */
const MATH_OPEN = /^\s*(\$\$|\\\[)/;

/**
 * A fenced code block from `lines[i]`, which must be an opening fence.
 *
 * Indentation is allowed and removed: a model writes a fence indented under a
 * bullet, and requiring column 0 is how that code used to be swallowed into the
 * bullet's text as a string of backticks.
 */
function readFence(lines, i) {
  const [, indent, language] = lines[i].match(FENCE_OPEN);
  const body = [];
  let j = i + 1;
  while (j < lines.length && !FENCE_CLOSE.test(lines[j])) {
    body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
    j += 1;
  }
  return { html: codeBlock(language, body.join('\n')), next: j + 1 };
}

/**
 * A display formula from `lines[i]`: everything up to the closing `$$` or `\]`,
 * which may be on the same line. Returns null when the line only starts with the
 * delimiter mid-sentence and never closes, so it stays ordinary text.
 */
function readMathBlock(lines, i) {
  const opener = lines[i].match(MATH_OPEN)[1];
  const closer = opener === '$$' ? '$$' : '\\]';
  const first = lines[i].trimStart().slice(opener.length);
  const sameLine = first.indexOf(closer);
  if (sameLine !== -1) {
    // Only a block when nothing follows the formula; otherwise it is inline.
    if (first.slice(sameLine + closer.length).trim()) return null;
    return { html: mathHtml(first.slice(0, sameLine), true), next: i + 1 };
  }
  const body = [first];
  for (let j = i + 1; j < lines.length; j += 1) {
    const at = lines[j].indexOf(closer);
    if (at !== -1) {
      if (lines[j].slice(at + closer.length).trim()) return null;
      body.push(lines[j].slice(0, at));
      return { html: `<div class="math-block">${mathHtml(body.join('\n'), true)}</div>`, next: j + 1 };
    }
    if (!lines[j].trim()) return null;
    body.push(lines[j]);
  }
  return null;
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const html = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (FENCE_OPEN.test(line)) {
      const block = readFence(lines, i);
      html.push(block.html);
      i = block.next;
      continue;
    }

    // A formula on lines of its own
    if (MATH_OPEN.test(line)) {
      const block = readMathBlock(lines, i);
      if (block) {
        html.push(block.html.startsWith('<div') ? block.html : `<div class="math-block">${block.html}</div>`);
        i = block.next;
        continue;
      }
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
      html.push('<hr />');
      i += 1;
      continue;
    }

    // Table: a header row followed by a |---|---| separator
    if (tableAt(lines, i)) {
      const head = tableRow(line);
      const aligns = alignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(tableRow(lines[i++]));
      const at = (c) => (aligns[c] ? ` style="text-align:${aligns[c]}"` : '');
      html.push(
        '<table><thead><tr>' +
          head.map((cell, c) => `<th${at(c)}>${inline(cell)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map(
              (row) =>
                // Padded to the header width. A short row silently dropping its
                // last column is worse than an empty cell, because the table
                // still looks right.
                `<tr>${head.map((_, c) => `<td${at(c)}>${inline(row[c] ?? '')}</td>`).join('')}</tr>`,
            )
            .join('') +
          '</tbody></table>',
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        // A bullet's text, with any code block or formula written under it kept
        // inside the same bullet, in order.
        const parts = [];
        let text = lines[i].replace(re, '');
        const flush = () => {
          if (text.trim()) parts.push(inline(text));
          text = '';
        };
        i += 1;
        // Absorb wrapped continuation lines into the same bullet — but not a
        // table starting under it, which is a block of its own.
        while (i < lines.length && lines[i].trim() && !bullet.test(lines[i]) && !numbered.test(lines[i]) && !tableAt(lines, i)) {
          if (FENCE_OPEN.test(lines[i])) {
            // An unindented fence ends the list; an indented one belongs to it.
            if (!/^\s/.test(lines[i])) break;
            flush();
            const block = readFence(lines, i);
            parts.push(block.html);
            i = block.next;
            continue;
          }
          const block = MATH_OPEN.test(lines[i]) ? readMathBlock(lines, i) : null;
          if (block) {
            flush();
            parts.push(block.html);
            i = block.next;
            continue;
          }
          text += `${text ? ' ' : ''}${lines[i].trim()}`;
          i += 1;
        }
        flush();
        items.push(`<li>${parts.join('')}</li>`);
      }
      html.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // Paragraph: gather until a blank line or a block-level construct.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_OPEN.test(lines[i]) &&
      !(MATH_OPEN.test(lines[i]) && para.length && readMathBlock(lines, i)) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^([-*_])\1{2,}\s*$/.test(lines[i].trim()) &&
      !tableAt(lines, i) &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    html.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return html.join('');
}

/** Delegated copy-to-clipboard for every rendered code block. */
export function wireCopyButtons(root) {
  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      btn.textContent = t('worker.copied');
      setTimeout(() => {
        btn.textContent = t('chat.copy');
      }, 1400);
    } catch {
      btn.textContent = t('devices.pressCtrlC');
    }
  });
}
