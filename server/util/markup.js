/**
 * Pieces of HTML and XML found by searching forward, never by backtracking.
 *
 * The pages and feeds these read are chosen by the model, or by whoever wrote
 * the page it is reading, and they arrive whole — up to 8 MB of HTML, 2 MB of
 * a feed — before anything is clipped. A lazy regular expression such as
 * `/<!--[\s\S]*?-->/g` or `/<item\b[\s\S]*?<\/item>/gi` is quadratic on input
 * built to defeat it: a body of a million `<!--` with no `-->` sends it from
 * every one of them to the end of the text, which is 10^12 steps on the
 * request's own thread (PERF-017). Each function here walks the text once.
 */

/**
 * ASCII letters lowered and nothing else touched. `String#toLowerCase` can
 * change a string's length ("İ" becomes two code units), and every index found
 * in the lowered copy has to land on the same character in the original.
 */
export const asciiLower = (text) => String(text).replace(/[A-Z]+/g, (run) => run.toLowerCase());

const NAME_CHAR = /[a-z0-9_]/;

/**
 * Where `<name` opens a tag at or after `from` in already-lowered text — not
 * `<names` or `<name_x` — or -1. Each call starts where the last one stopped.
 */
export function openAt(lower, name, from = 0) {
  const needle = `<${asciiLower(name)}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1 && NAME_CHAR.test(lower[at + needle.length] || '')) at = lower.indexOf(needle, at + 1);
  return at;
}

/**
 * The text with every `start … end` span replaced by a space. An opening with
 * no end is left as it is, as the regular expression it replaces left it.
 */
function dropSpans(text, lower, findStart, end) {
  let out = '';
  let from = 0;
  for (;;) {
    const start = findStart(from);
    if (start === -1) return out + text.slice(from);
    const close = lower.indexOf(end, start + 1);
    if (close === -1) return out + text.slice(from);
    out += `${text.slice(from, start)} `;
    from = close + end.length;
  }
}

/** Each named element taken out with everything inside it, then every comment. */
export function dropElements(html, names) {
  let text = String(html);
  for (const name of names) {
    const lower = asciiLower(text);
    text = dropSpans(text, lower, (from) => openAt(lower, name, from), `</${asciiLower(name)}>`);
  }
  const lower = asciiLower(text);
  return dropSpans(text, lower, (from) => lower.indexOf('<!--', from), '-->');
}

/**
 * Every `<name …>…</name>` for any of `names`, in document order, as the
 * original text. Stops at the first one that never closes: nothing after it can.
 */
export function elementSpans(text, names) {
  const src = String(text);
  const lower = asciiLower(src);
  const next = new Map(names.map((name) => [name, openAt(lower, name, 0)]));
  const out = [];
  let from = 0;
  for (;;) {
    let name = null;
    for (const candidate of names) {
      let at = next.get(candidate);
      if (at !== -1 && at < from) {
        at = openAt(lower, candidate, from);
        next.set(candidate, at);
      }
      if (at !== -1 && (name === null || at < next.get(name))) name = candidate;
    }
    if (name === null) return out;
    const start = next.get(name);
    const end = lower.indexOf(`</${asciiLower(name)}>`, start);
    if (end === -1) return out;
    from = end + name.length + 3;
    out.push(src.slice(start, from));
  }
}

/** What is inside the first `<name …>…</name>`, or ''. */
export function firstInner(block, name) {
  const src = String(block);
  const lower = asciiLower(src);
  const open = openAt(lower, name, 0);
  if (open === -1) return '';
  const gt = lower.indexOf('>', open);
  if (gt === -1) return '';
  const close = lower.indexOf(`</${asciiLower(name)}>`, gt + 1);
  return close === -1 ? '' : src.slice(gt + 1, close);
}

/** The value of `attr="…"` on the first `<name …>` tag, or ''. */
export function firstAttr(block, name, attr) {
  const src = String(block);
  const lower = asciiLower(src);
  const open = openAt(lower, name, 0);
  if (open === -1) return '';
  const gt = lower.indexOf('>', open);
  const tag = lower.slice(open, gt === -1 ? undefined : gt);
  const key = tag.indexOf(`${asciiLower(attr)}="`);
  if (key === -1) return '';
  const valueStart = open + key + attr.length + 2;
  const valueEnd = src.indexOf('"', valueStart);
  return valueEnd === -1 || (gt !== -1 && valueEnd > gt) ? '' : src.slice(valueStart, valueEnd);
}

/**
 * Tags removed, linearly: `[^<>]` cannot run past the next `<`, so a body of
 * a million `<` with no `>` costs one step each instead of one pass each.
 */
export const stripTags = (text, replacement = ' ') => String(text).replace(/<[^<>]*>/g, replacement);
