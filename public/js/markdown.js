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

/**
 * Citations: where a sentence came from, as a small chip after it.
 *
 * The assistant is asked (see "Cite as you go" in server/agent.js) to end a
 * sourced sentence with the source in parentheses — a page as
 * `([OpenRouter](https://…))`, a file as `([Chap005.pdf])`, several at once
 * separated by commas. That is ordinary Markdown on purpose: copied out, mailed,
 * or read by anything else it is still a readable link in brackets, and a model
 * that ignores the convention loses nothing. Parentheses are what separate a
 * citation from a link that is part of the sentence ("see [the docs](…)").
 *
 * Runs over escaped text, so the pieces are already HTML-safe. Consecutive
 * citations merge into one chip — "OpenRouter +3" — whose card lists all of them.
 */
const CITE_WEB = String.raw`\[([^\[\]\n]{1,80})\]\((https?:\/\/[^\s)\u0000]+)\)`;
const CITE_FILE = String.raw`\[([^\[\]\n\/\\]{1,120}?\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|rtf|odt|json|html?|png|jpe?g|gif|webp))\]`;
const CITE_ONE = `(?:${CITE_WEB}|${CITE_FILE})`;
const CITE_GROUP = String.raw`\(\s*${CITE_ONE}(?:\s*[,;]\s*${CITE_ONE})*\s*\)`;
const CITE_RUN = new RegExp(`${CITE_GROUP}(?:\\s*${CITE_GROUP})*`, 'gi');
const CITE_ITEM = new RegExp(CITE_ONE, 'gi');

/** `&amp;` back to `&`, for reading a host out of an already-escaped address. */
const unescapeUrl = (url) => url.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

function hostOf(escapedUrl) {
  try {
    return new URL(unescapeUrl(escapedUrl)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** More distinct marks than this and the chip stops being small. */
const MAX_MARKS = 5;

const GLOBE_MARK =
  '<svg class="cite__icon cite__icon--glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';

/** Kinds of file that share an icon: a .doc and a .docx are both Word. */
function fileFamily(ext) {
  if (ext === 'PDF') return 'pdf';
  if (/^(DOCX?|ODT|RTF)$/.test(ext)) return 'doc';
  if (/^(XLSX?|CSV|TSV)$/.test(ext)) return 'sheet';
  if (/^PPTX?$/.test(ext)) return 'slides';
  if (/^(PNG|JPG|GIF|WEBP)$/.test(ext)) return 'image';
  return 'text';
}

/** A file's icon: a page with a folded corner, coloured and lettered by its kind. */
function fileMark(ext) {
  const family = fileFamily(ext);
  const letter = { pdf: 'P', doc: 'W', sheet: 'X', slides: 'P', image: '', text: '' }[family];
  const inner =
    family === 'image'
      ? '<circle cx="9" cy="13" r="1.6" fill="#fff"/><path d="M6 19l4-4 3 3 2-2 3 3z" fill="#fff"/>'
      : letter
        ? `<text x="12" y="18" text-anchor="middle" font-size="9" font-weight="700" font-family="system-ui,sans-serif" fill="#fff">${letter}</text>`
        : '<path d="M8 12h8M8 15h8M8 18h5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>';
  return (
    `<svg class="cite__icon cite__file cite__file--${family}" viewBox="0 0 24 24">` +
    '<path d="M5 2h10l5 5v15H5z" fill="currentColor"/><path d="M15 2v5h5" fill="#fff" fill-opacity=".45"/>' +
    `${inner}</svg>`
  );
}

const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase().replace(/^JPEG$/, 'JPG');

/** One run of citations, already escaped, as its chip. */
function citeChip(run) {
  const items = [];
  for (const m of run.matchAll(CITE_ITEM)) {
    if (m[2]) items.push({ kind: 'web', label: m[1].trim(), url: m[2], host: hostOf(m[2]) });
    else items.push({ kind: 'file', name: m[3].trim(), ext: extOf(m[3]) });
  }
  // A repeated source is one source.
  const seen = new Set();
  const unique = items.filter((it) => {
    const key = it.kind === 'web' ? it.url : it.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const [first] = unique;

  const favicon = (host) =>
    host ? `<img class="cite__icon" src="/api/favicon/${encodeURIComponent(host)}" alt="" loading="lazy" decoding="async" data-cite-icon>` : '';

  /**
   * Every distinct source's mark, side by side, so the chip says at a glance
   * which sites and which kinds of file are behind it: one logo per site (two
   * OpenRouter pages are one OpenRouter logo) and one icon per file type. The
   * `+N` after the name counts sources, not logos — "OpenRouter +3" is four
   * sources however many of them share a site.
   */
  const marks = [];
  const marked = new Set();
  for (const it of unique) {
    const key = it.kind === 'web' ? `w:${it.host}` : `f:${fileFamily(it.ext)}`;
    if (marked.has(key)) continue;
    marked.add(key);
    marks.push(it.kind === 'web' ? favicon(it.host) || GLOBE_MARK : fileMark(it.ext));
  }
  const shown = marks.slice(0, MAX_MARKS).join('');
  const head =
    `<span class="cite__marks" aria-hidden="true">${shown}</span>` +
    (first.kind === 'web'
      ? `<span class="cite__name">${first.label || first.host}</span>`
      : `<span class="cite__name cite__name--file">${first.ext}</span>`);
  const more = unique.length > 1 ? `<span class="cite__more">+${unique.length - 1}</span>` : '';

  const card = unique
    .map((it) =>
      it.kind === 'web'
        ? `<a class="cite-item" href="${it.url}" target="_blank" rel="noopener noreferrer" data-url="${it.url}">` +
          `<span class="cite-item__site">${favicon(it.host)}<span>${it.host || it.label}</span></span>` +
          `<span class="cite-item__title">${it.label}</span>` +
          `<span class="cite-item__snip"></span>` +
          `<span class="cite-item__url">${it.url}</span></a>`
        : `<span class="cite-item cite-item--file">` +
          `<span class="cite-item__site">${fileMark(it.ext)}<span>${it.ext}</span></span>` +
          `<span class="cite-item__title">${it.name}</span></span>`,
    )
    .join('');

  const names = unique.map((it) => (it.kind === 'web' ? it.label || it.host : it.name)).join(', ');
  return (
    `<span class="cite" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false" ` +
    `aria-label="${escapeHtml(t('cite.sources'))}: ${names}">${head}${more}` +
    `<span class="cite__card" hidden>${card}</span></span>`
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

  // Citations before emphasis and links, and held, so an underscore or an
  // asterisk in an address is not turned into italics inside the chip.
  out = out.replace(CITE_RUN, (run) => hold(citeChip(run)));

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
