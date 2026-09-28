/**
 * Every piece of visible English in the page markup that nothing translates.
 *
 * A key set in sync proves nothing about a label that was never given a key —
 * that is how the model picker and half of Settings stayed English under a
 * Vietnamese account. This walks `index.html` and reports each text node,
 * placeholder, title, aria-label and alt that is not covered by a `data-i18n*`
 * attribute on itself or an ancestor.
 *
 * Deliberately exempt:
 *   - `data-i18n-js` — the script owns that node's text and translates it.
 *   - brand names and sample values, which read the same in every language.
 */
const BRANDS = new Set(['Synapsez', 'Anthropic', 'OpenAI', 'Google', 'OpenRouter', 'OrcaRouter']);
const SAMPLES = new Set([
  'you@example.com',
  'ABCD-2K7M',
  'figma',
  'https://example.com/mcp',
  'Authorization: Bearer …',
  'npx -y @modelcontextprotocol/server-filesystem D:\\work',
]);

const VOID = new Set(['input', 'img', 'br', 'meta', 'link', 'hr', 'source', 'area', 'wbr']);
const hasWords = (s) => /[A-Za-z]{2}/.test(s);
const attr = (attrs, name) => (attrs.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
const marked = (attrs, name) => new RegExp(`\\s${name}(=|\\s|$|/)`).test(attrs);

export function untranslatedMarkup(html) {
  const source = html.replace(/\r\n/g, '\n');
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  const found = [];
  const stack = [];
  const re =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<head[\s\S]*?<\/head>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<(\/?)([a-zA-Z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(source))) {
    const [, closing, rawTag, attrs = '', text] = m;
    if (rawTag) {
      const tag = rawTag.toLowerCase();
      if (closing) {
        while (stack.length && stack.pop().tag !== tag);
        continue;
      }
      const owned = marked(attrs, 'data-i18n-js');
      const covered = owned || marked(attrs, 'data-i18n') || marked(attrs, 'data-i18n-html');
      const inherited = stack.some((e) => e.covered);

      const checks = [
        ['placeholder', ['data-i18n-placeholder']],
        ['title', ['data-i18n-title']],
        ['aria-label', ['data-i18n-title', 'data-i18n-aria-label']],
        ['alt', ['data-i18n-alt']],
      ];
      for (const [name, markers] of checks) {
        const value = attr(attrs, name);
        if (!value || !hasWords(value) || SAMPLES.has(value) || owned) continue;
        if (markers.some((marker) => marked(attrs, marker))) continue;
        found.push(`line ${lineOf(m.index)}: ${name}="${value}"`);
      }
      if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, covered });
      void inherited;
    } else if (text && hasWords(text)) {
      if (stack.some((e) => e.covered)) continue;
      const clean = text.trim().replace(/\s+/g, ' ');
      if (BRANDS.has(clean)) continue;
      found.push(`line ${lineOf(m.index)}: "${clean}"`);
    }
  }
  return found;
}
