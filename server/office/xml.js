/**
 * Just enough XML to read an Office document, and to write one.
 *
 * The parts inside a .docx are machine-written XML with no doctype, no entity
 * declarations and no processing instructions worth acting on — so this is a
 * tokenizer over tags and text, not a conformant parser. What it does handle is
 * everything Word, Excel and PowerPoint actually emit: attributes in either
 * quote, self-closing elements, CDATA, comments, and the five predefined
 * entities plus numeric character references.
 *
 * Two deliberate refusals, both security rather than laziness:
 *
 *   **No entity resolution.** `<!DOCTYPE>` is skipped whole and `&anything;`
 *   that is not one of the five is left as written. That is what makes the
 *   billion-laughs expansion and external-entity file reads impossible here
 *   rather than merely unlikely — this parses documents that arrive from
 *   strangers over the internet.
 *
 *   **No namespace resolution.** Elements keep their qualified names, and the
 *   lookups below match on the local half. Word has used the `w:` prefix since
 *   2006 and so has everything that writes files for it, but matching the local
 *   name costs nothing and reads a document from a generator that chose
 *   different prefixes instead of silently finding no text in it.
 */

/* ── reading ────────────────────────────────────────────────────────── */

const ENTITY = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Undo the escaping in a text node or an attribute value. */
export function decodeXml(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values are not characters; leaving the
      // reference as written is more honest than emitting a replacement.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return ENTITY[body] ?? whole;
  });
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(source) {
  const attrs = {};
  if (!source || !source.includes('=')) return attrs;
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(source))) {
    attrs[match[1]] = decodeXml(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Parse a document into a tree.
 *
 * A node is `{ name, attrs, children }`; text arrives as plain strings among the
 * children, which keeps mixed content — a run of text interrupted by a `<w:br/>`
 * — in the order the document wrote it.
 *
 * @returns the root element, or null for a part with no elements at all
 */
export function parseXml(source) {
  const text = String(source ?? '');
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  /** How many of each name are open, so a close tag nothing matches costs one look, not a walk up the stack. */
  const openNames = new Map();
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open === -1) {
      pushText(stack[stack.length - 1], text.slice(at));
      break;
    }
    if (open > at) pushText(stack[stack.length - 1], text.slice(at, open));

    // <!-- comment -->, <![CDATA[…]]>, <!DOCTYPE …>
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open);
      at = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open);
      const body = text.slice(open + 9, end === -1 ? text.length : end);
      // Raw, not decoded: the point of CDATA is that it is not escaped.
      stack[stack.length - 1].children.push(body);
      at = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', open)) {
      // A doctype may carry a bracketed internal subset. Skip past it whole
      // without reading a single declaration out of it.
      let depth = 0;
      let i = open + 2;
      for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '[') depth += 1;
        else if (c === ']') depth -= 1;
        else if (c === '>' && depth <= 0) break;
      }
      at = i + 1;
      continue;
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open);
      at = end === -1 ? text.length : end + 2;
      continue;
    }

    const close = text.indexOf('>', open);
    if (close === -1) break; // truncated document; keep what was already read
    const inner = text.slice(open + 1, close);

    if (inner[0] === '/') {
      const name = inner.slice(1).trim();
      // Unwind to the matching element rather than assuming the document is
      // well-formed: a stray close tag must not pop an ancestor.
      if (openNames.get(name) > 0) {
        for (let i = stack.length - 1; i > 0; i -= 1) {
          const closed = stack[i].name;
          openNames.set(closed, openNames.get(closed) - 1);
          if (closed === name) {
            stack.length = i;
            break;
          }
        }
      }
      at = close + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/[\s]/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    const node = {
      name,
      attrs: space === -1 ? {} : parseAttributes(body.slice(space + 1)),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
      openNames.set(name, (openNames.get(name) || 0) + 1);
    }
    at = close + 1;
  }

  return root.children.find((child) => typeof child !== 'string') || null;
}

function pushText(parent, raw) {
  if (!raw) return;
  parent.children.push(decodeXml(raw));
}

/** The part of a tag name after the namespace prefix: `w:p` → `p`. */
export const localName = (name) => {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
};

const isElement = (node) => node && typeof node === 'object';

/** Direct element children, optionally only those with this local name. */
export function elements(node, name) {
  if (!isElement(node)) return [];
  const found = node.children.filter(isElement);
  return name ? found.filter((child) => localName(child.name) === name) : found;
}

/** The first direct child with this local name, or null. */
export function element(node, name) {
  return elements(node, name)[0] || null;
}

/** Every descendant with this local name, in document order. */
export function* descendants(node, name) {
  if (!isElement(node)) return;
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (localName(child.name) === name) yield child;
    yield* descendants(child, name);
  }
}

/** An attribute by local name, so `w:val` answers to `val`. */
export function attr(node, name) {
  if (!isElement(node)) return undefined;
  const direct = node.attrs[name];
  if (direct !== undefined) return direct;
  for (const key of Object.keys(node.attrs)) {
    if (localName(key) === name) return node.attrs[key];
  }
  return undefined;
}

/**
 * The relationship id on an element — the `r:id` that points at another part.
 *
 * Deliberately not `attr(node, 'id')`. A slide entry is
 * `<p:sldId id="256" r:id="rId2"/>`: it has an id of its own *and* a
 * relationship id, and a lookup by local name finds the wrong one — which
 * silently produces a deck with no slides in it rather than an error.
 */
export function relationshipId(node) {
  if (!isElement(node)) return undefined;
  if (node.attrs['r:id'] !== undefined) return node.attrs['r:id'];
  for (const key of Object.keys(node.attrs)) {
    if (key.includes(':') && localName(key) === 'id') return node.attrs[key];
  }
  return undefined;
}

/** All the text under a node, concatenated in document order. */
export function textOf(node) {
  if (typeof node === 'string') return node;
  if (!isElement(node)) return '';
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

/* ── writing ────────────────────────────────────────────────────────── */

/**
 * Escape a string for an XML text node or attribute value.
 *
 * Apostrophes go too. Attribute values here are always double-quoted so it is
 * not strictly required, but a helper that is safe in one context and not the
 * other is a trap for whoever reaches for it next.
 *
 * Control characters are dropped rather than escaped: XML 1.0 has no way to
 * represent them at all, and a single stray 0x0B in a model's output is the
 * difference between a document that opens and one Word offers to repair.
 */
export function escapeXml(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The declaration every part of an OOXML package starts with. */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
