/**
 * The drawing guide (owner, 2026-11-17: "tôi muốn bạn cho script thiết kế svg vì sẽ có nhiều
 * loại chứ không cố định", and "flexible adaptive smartest beautiful, chuyên nghiệp … cụ thể
 * hóa"): built-in skills a model reads before it draws, each recipe an SVG skeleton to fill and
 * the arithmetic that places every item.
 *
 * A recipe is only worth having if following it gives a drawing the check passes, so this
 * takes each skeleton out of the skill's own text, fills it the way the text says (at a
 * comfortable size, at the extreme of its adaptive rule, and on the dark canvas, with the
 * palette read from the guide itself), and runs it through the real `checkDiagram`, line
 * check included. Every contrast ratio the guide states is computed again here, and every
 * fact it gives about the `diagram` input and the page is read from the code it describes.
 *
 *   node test/drawing-skills.test.mjs
 */

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { BUILTIN_SKILLS, findBuiltinSkill } = await import('../server/skills/builtin.js');
const { checkDiagram, contrast, colour, LINE_CHECK } = await import('../server/widgetCheck.js');
const { DRAWING_FIT } = await import('../public/js/drawing-fit.js');
const { LIMITS, DIRECTIONS, THEMES, KINDS, STYLES, ICON_NAMES, validateDiagram } = await import('../server/diagram/validate.js');
const { layoutDiagram } = await import('../server/diagram/layout.js');
const { renderDiagram } = await import('../server/diagram/render.js');
const { textWidth } = await import('../server/diagram/measure.js');

const skill = (id) => BUILTIN_SKILLS.find((s) => s.id === id) || null;
const textOf = (id) => skill(id)?.instructions || '';
// A colour the guide does not give reads as no contrast at all, so a missing one fails the check rather than the suite.
const ratio = (a, b) => (colour(a) && colour(b) ? contrast(colour(a), colour(b)) : 0);
const two = (x) => x.toFixed(2);

// What each skill may weigh. The spec (2026-11-17 §"Adaptive and professional") asked for the
// guide at about 7,000 characters and a recipe family at about 9,000; with every skeleton a
// complete drawing (480 to 1,300 characters each, about 4,500 a family) the prose around them was
// cut to the numbers and a family of four came to about 10,200, the family of six to 11,200. Fix
// round 1 (review, 2026-11-19) added what the check cannot see: rooms by line count, the page's
// own background, a call to itself on the last party, colour by kind of item. Read only when one
// applies, so the size is paid on the turns that draw; the description is in every prompt, so it
// stays at 145 characters or fewer. Task 4b (2026-11-19): sequences, four recipes, came to 10,859;
// layouts, six of them, to 13,616, its skeletons alone 5,695. The brief's "about 12,000" would
// cost the arithmetic, so the overrun is reported with a proposed split instead.
const BUDGET = { 'builtin:drawing': 8000, 'builtin:svg-flows': 10750, 'builtin:svg-structures': 12000, 'builtin:svg-sequences': 11100, 'builtin:svg-layouts': 13900 };
const DESCRIPTION = 145;
const RECIPES = {
  'builtin:svg-flows': ['decision', 'loop', 'swimlanes', 'sequence'],
  'builtin:svg-structures': ['tree', 'mindmap', 'pyramid', 'cycle', 'venn', 'stack'],
  'builtin:svg-sequences': ['timeline', 'steps', 'gantt', 'journey'],
  'builtin:svg-layouts': ['compare', 'matrix', 'sides', 'kpi', 'panel', 'labelled'],
};
// A phone's column as the guide gives it ("about 320 px", derived from the CSS, never measured on
// a device). A Narrow fill is drawn 360 wide and judged there, against the page's own floor for
// readable text (DRAWING_FIT.readablePx), since on a phone 12.5 px shows at 11.1.
const PHONE = 320;

section('the drawing skills are on the menu, within their budgets');
{
  // A recipe family added later must be held here too, not slip past with no budget or no fills.
  const family = BUILTIN_SKILLS.map((s) => s.id).filter((id) => id.startsWith('builtin:svg-'));
  check('every builtin:svg-* skill has a budget here and its recipes listed', family.length >= 2 && family.every((id) => id in BUDGET && id in RECIPES), family.filter((id) => !(id in BUDGET && id in RECIPES)).join(', '));
}
for (const [id, budget] of Object.entries(BUDGET)) {
  const s = skill(id);
  check(`${id} is a built-in skill, under the visuals plugin`, !!s && s.plugin === 'visuals');
  if (!s) continue;
  check(`  its description says when to read it in ${DESCRIPTION} characters or fewer (${s.description.length})`, s.description.length <= DESCRIPTION && s.description.length >= 100);
  check(`  its instructions are within ${budget} characters (${s.instructions.length})`, s.instructions.length <= budget && s.instructions.length >= budget * 0.6);
  check('  found by the word after "builtin:" and by its name', findBuiltinSkill(id.split(':')[1])?.id === id && findBuiltinSkill(s.name)?.id === id);
}

section('the guide says which tool, and the diagram as the code takes it');
{
  const g = textOf('builtin:drawing');
  check('it names chart, show_widget with diagram and svg, generate_image and create_file', ['`chart`', '`show_widget`', '`diagram`', '`svg`', '`generate_image`', '`create_file`'].every((w) => g.includes(w)));
  check('  and sends each kind of drawing to the recipe skill that holds it, by name', Object.keys(RECIPES).every((id) => g.includes(`"${skill(id)?.name}"`)));
  const said = (n) => new RegExp(`\\b${n}\\b`).test(g);
  check('every limit of a diagram is the one validate.js enforces', [LIMITS.nodes, LIMITS.edges, LIMITS.groups, LIMITS.id, LIMITS.title, LIMITS.lines, LIMITS.line, LIMITS.label].every(said), JSON.stringify(LIMITS));
  check('  its directions, themes, kinds and styles', [...DIRECTIONS, ...THEMES, ...KINDS, ...STYLES].every((w) => g.includes(w)));
  check('  and all twelve icons, in the order the code lists them', g.includes(ICON_NAMES.join(', ')), ICON_NAMES.join(', '));
  const example = /<!-- example:diagram -->\s*```json\n([^\n]+)\n```/.exec(g)?.[1];
  let input = null;
  try {
    input = JSON.parse(example || '');
  } catch {
    /* reported below */
  }
  check('the diagram example is one line of valid JSON, as show_widget takes it', !!input?.title && !!input?.diagram);
  const v = input ? validateDiagram(input.diagram) : { ok: false, error: 'no example' };
  check('  it is accepted as it stands', v.ok, v.error || '');
  if (v.ok) {
    const svg = renderDiagram(layoutDiagram(v.diagram), { theme: v.diagram.theme, title: input.title });
    const found = checkDiagram(svg);
    check('  and Ephapse lays it out with nothing for the check to find', found.issues.length === 0, found.issues[0] || '');
    check('  it uses a group, a label, a dashed edge, an icon and a kind other than box', v.diagram.groups.length > 0 && v.diagram.edges.some((e) => e.label) && v.diagram.edges.some((e) => e.style === 'dashed') && v.diagram.nodes.some((n) => n.icon) && v.diagram.nodes.some((n) => n.kind !== 'box'));
  }
}

section('the page\'s figures are the page\'s, and the check\'s are the check\'s');
{
  const g = textOf('builtin:drawing');
  check(`the column the guide sizes for is DRAWING_FIT's (${DRAWING_FIT.column} px)`, g.includes(`${DRAWING_FIT.column} px wide`));
  check(`  and the height cap its share of the window (${Math.round(DRAWING_FIT.heightShare * 100)} %, ${Math.round(DRAWING_FIT.heightShare * DRAWING_FIT.window)} px in an ${DRAWING_FIT.window} px window)`, g.includes(`${Math.round(DRAWING_FIT.heightShare * 100)} %`) && g.includes(`${Math.round(DRAWING_FIT.heightShare * DRAWING_FIT.window)} px in an ${DRAWING_FIT.window} px window`));
  check(`an arrow's end counts within ${LINE_CHECK.reach} px of an edge, as the line check reads it`, g.includes(`${LINE_CHECK.reach} px`));
  // The scale a 720-wide canvas of height 560 is shown at, at worst (no refit to its contents):
  // the guide's "12.5 px reads as 12.4" must hold at it, rounded as the guide rounds.
  const worst = Math.min(DRAWING_FIT.column / 720, (DRAWING_FIT.heightShare * DRAWING_FIT.window) / 560);
  check(`a 720 × 560 canvas is shown at ${two(worst)} or larger, so 12.5 px text reads at 12.3 px or more, as the guide says`, 12.5 * worst >= 12.3 && g.includes(`shows at ${worst.toFixed(3)} or more, so 12.5 px text reads at 12.3 px or more`), two(12.5 * worst));
  const image = (await import('../server/tools/definitions.js')).TOOLS.find((t) => t.name === 'generate_image');
  const ratios = String(image?.parameters?.properties?.aspect_ratio?.description || '').match(/\d+:\d+/g) || [];
  const pictures = g.slice(g.indexOf('## 6.'));
  const named = pictures.match(/\b\d+:\d+\b/g) || [];
  check('the picture section names generate_image\'s own aspect_ratio, and only ratios it takes', !!image && pictures.includes('`aspect_ratio`') && ratios.length >= 5 && named.length >= 5 && named.every((r) => ratios.includes(r)), `${named.join(' ')} of ${ratios.join(' ')}`);
  check('the marker the guide defines is the one in every recipe that draws arrows', (() => {
    const marker = /<marker id="ah"[^]*?<\/marker>/.exec(g)?.[0];
    return !!marker && Object.keys(RECIPES).every((id) => [...textOf(id).matchAll(/<marker\b[^]*?<\/marker>/g)].every((m) => m[0] === marker));
  })());
  // The check's messages, and the redraw request, suggest a <tspan> form: the guide quotes that
  // form as it is written (review, Task 4), so a model told it recognises the advice.
  const fs = await import('node:fs');
  const src = (f) => fs.readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
  const told = [src('widgetCheck.js'), src('tools/cloud.js')].map((s) => /<tspan x=… dy="[\d.]+em">/.exec(s)?.[0]);
  check(`the line-break form the check suggests (${told[0]}) is the one the guide quotes`, !!told[0] && told[0] === told[1] && g.includes(`\`${told[0]}\``), told.join(' / '));
  const phoneSaid = /A phone's column is about (\d+) px/.exec(g)?.[1];
  check(`the phone column the Narrow fills are judged at (${PHONE} px) is the guide's`, Number(phoneSaid) === PHONE, phoneSaid);
}

// ── the palette, read from the guide's own tables ─────────────────────────────────────────

/** The roles and families as the guide writes them, per theme. */
function readPalette(g) {
  const rows = [...g.matchAll(/^\| ([a-z][a-z ,()]*?) \| ([^|]+) \| ([^|]+) \|$/gm)];
  const hexes = (cell) => cell.match(/#[0-9A-F]{6}/g) || [];
  const nums = (cell) => (cell.match(/\b\d+\.\d\d\b/g) || []).map(Number);
  const out = { light: { fam: [] }, dark: { fam: [] }, rows: [] };
  for (const [, key, l, d] of rows) {
    const first = key.split(/[ ,]/)[0];
    out.rows.push({ key: first, light: { hex: hexes(l), num: nums(l) }, dark: { hex: hexes(d), num: nums(d) } });
  }
  const canvas = /light \(canvas (#[0-9A-F]{6}), page (#[0-9A-F]{6})\) \| dark \(canvas (#[0-9A-F]{6})\)/.exec(g);
  if (canvas) [out.light.canvas, out.light.page, out.dark.canvas] = [canvas[1], canvas[2], canvas[3]];
  for (const r of out.rows) {
    for (const theme of ['light', 'dark']) {
      const [a, b, c] = r[theme].hex;
      const P = out[theme];
      if (r.key === 'ink' || r.key === 'muted' || r.key === 'line') P[r.key] = a;
      else if (r.key === 'card') [P.card, P.edge] = [a, b];
      else if (r.key === 'ground') [P.ground, P.rule] = [a, b];
      else if (r.key === 'solid') [P.solid, P.onSolid] = [a, b];
      else if (r[theme].hex.length === 3) P.fam.push({ name: r.key, tint: a, stroke: b, inkA: c });
    }
  }
  return out;
}

const guide = textOf('builtin:drawing');
const PAL = readPalette(guide);

section('every contrast the guide states is computed again, and every text pair reads');
{
  const wrong = [];
  for (const r of PAL.rows) {
    for (const theme of ['light', 'dark']) {
      const P = PAL[theme];
      const { hex, num } = r[theme];
      let want = null;
      if (['ink', 'muted', 'line'].includes(r.key)) want = ratio(hex[0], P.canvas);
      else if (r.key === 'card') want = ratio(hex[1], P.canvas);
      else if (r.key === 'solid') want = ratio(hex[1], hex[0]);
      else if (hex.length === 3) want = ratio(hex[2], hex[0]);
      if (want === null) continue;
      if (num.length !== 1 || two(want) !== two(num[0])) wrong.push(`${r.key} ${theme}: says ${num.join('/') || 'nothing'}, is ${two(want)}`);
    }
  }
  check('each ratio in the tables is the WCAG ratio of its pair, to two decimals', PAL.rows.length >= 12 && wrong.length === 0, wrong.join(' | '));
  for (const theme of ['light', 'dark']) {
    const P = PAL[theme];
    check(`${theme}: the canvas, ink, muted, line, card, edge, ground, rule, solid and six families or more were read`, ['canvas', 'ink', 'muted', 'line', 'card', 'edge', 'ground', 'rule', 'solid', 'onSolid'].every((k) => /^#[0-9A-F]{6}$/.test(P[k] || '')) && P.fam.length >= 6, JSON.stringify(Object.keys(P)));
    const low = [
      ['ink on canvas', P.ink, P.canvas], ['muted on canvas', P.muted, P.canvas], ['ink on card', P.ink, P.card], ['muted on card', P.muted, P.card], ['ink on ground', P.ink, P.ground],
      ...P.fam.flatMap((f) => [[`${f.name} ink on its tint`, f.inkA, f.tint], [`muted on ${f.name}`, P.muted, f.tint], [`${f.name} ink on canvas`, f.inkA, P.canvas]]),
    ].filter(([, a, b]) => ratio(a, b) < 4.5);
    check(`  every text pair a recipe uses reads at 4.5:1 or more`, low.length === 0, low.map(([n, a, b]) => `${n} ${two(ratio(a, b))}`).join(' | '));
  }
  // A light drawing on a light page has no paper of its own: it sits on the page's background
  // (review, fix round 1: the old edge was 2.86:1 there). That colour is read from the page's CSS.
  {
    const css = (await import('node:fs')).readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
    const pageBg = [...css.matchAll(/--bg:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toUpperCase()).find((hex) => colour(hex) && contrast(colour(hex), [255, 255, 255]) < 1.2);
    const P = PAL.light;
    check(`the light page the guide names is the page's own background (${pageBg})`, !!P.page && P.page === pageBg, `${P.page} against ${pageBg}`);
    const text = [['ink', P.ink], ['muted', P.muted], ...P.fam.map((f) => [`${f.name} ink`, f.inkA])].filter(([, hex]) => ratio(hex, P.page) < 4.5);
    const lines = [['line', P.line], ['card edge', P.edge], ...P.fam.map((f) => [`${f.name} stroke`, f.stroke])].filter(([, hex]) => Math.min(ratio(hex, P.page), ratio(hex, P.canvas)) < 3);
    check('  on it, every text pair still reads at 4.5:1 and every edge and stroke at 3:1, as the guide says', !!P.page && text.length === 0 && lines.length === 0 && guide.includes(`On the page's ${P.page}`), [...text, ...lines].map(([n, hex]) => `${n} ${two(ratio(hex, P.page))}`).join(' | '));
  }
  const least = (theme, pick) => two(Math.min(...PAL[theme].fam.map(pick)));
  const mutedLine = /Muted on any tint: at least (\d+\.\d\d) light, (\d+\.\d\d) dark\. Strokes against the canvas: at least (\d+\.\d\d) light, (\d+\.\d\d) dark\./.exec(guide);
  check('the least muted-on-tint and stroke-on-canvas the guide states are the computed ones', !!mutedLine
    && mutedLine[1] === least('light', (f) => ratio(PAL.light.muted, f.tint)) && mutedLine[2] === least('dark', (f) => ratio(PAL.dark.muted, f.tint))
    && mutedLine[3] === least('light', (f) => ratio(f.stroke, PAL.light.canvas)) && mutedLine[4] === least('dark', (f) => ratio(f.stroke, PAL.dark.canvas)),
  mutedLine ? mutedLine.slice(1).join(', ') : 'sentence missing');
  // A Venn diagram's circles are the family strokes laid over the canvas at an opacity: the
  // worst place for text is where three of them overlap.
  const venn = /Venn fills are each family's stroke at (\d+) % opacity \(dark (\d+) %\): ink where three overlap reads at least (\d+\.\d\d) light, (\d+\.\d\d) dark\./.exec(guide);
  const over = (theme, op) => {
    const P = PAL[theme];
    let worst = Infinity;
    const six = P.fam.slice(0, 6);
    for (const a of six) for (const b of six) for (const c of six) {
      if (a === b || b === c || a === c) continue;
      const mixed = [a, b, c].reduce((acc, f) => acc.map((v, i) => colour(f.stroke)[i] * op + v * (1 - op)), colour(P.canvas));
      worst = Math.min(worst, contrast(colour(P.ink), mixed));
    }
    return worst;
  };
  check('the Venn overlap ratios it states are computed over every three of the six families', !!venn && two(over('light', Number(venn[1]) / 100)) === venn[3] && two(over('dark', Number(venn[2]) / 100)) === venn[4] && Number(venn[3]) >= 4.5 && Number(venn[4]) >= 4.5, venn ? venn.slice(1).join(', ') : 'sentence missing');
}

// ── the recipes: taken out of the text, filled as the text says, and checked ─────────────────

/** The skeleton after `<!-- recipe:name -->`: the ```svg block that follows it. */
function recipeOf(text, name) {
  return new RegExp(`<!-- recipe:${name} -->\\n\`\`\`svg\\n([^]*?)\\n\`\`\``).exec(text)?.[1] || null;
}

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => String(Math.round(v * 100) / 100);
const fmt = (v) => (typeof v === 'number' ? num(v) : escapeXml(v));

/**
 * Fills a skeleton: `{name}` from the values, each `<!-- each x -->…<!-- /each -->` once per row
 * of `each.x`. A line whose value is null is left out, as the recipes say of a second line.
 */
function fill(skeleton, top, each = {}) {
  const sub = (body, values) =>
    body
      .split('\n')
      .filter((line) => ![...line.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].some((m) => values[m[1]] === null))
      .join('\n')
      .replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (m, k) => (k in values ? fmt(values[k]) : m));
  const blocks = skeleton.replace(/<!-- each (\w+) -->\n([^]*?)<!-- \/each -->\n?/g, (m, name, body) => {
    if (!each[name]) throw new Error(`nothing given for "each ${name}"`);
    return each[name].map((row) => `${sub(body, { ...top, ...row })}\n`).join('');
  });
  return sub(blocks, top);
}

/** Whether markup is well-formed XML: quoted attributes once each, escaped text, tags closed in order, one root. */
function wellFormed(xml) {
  const stack = [];
  let roots = 0;
  let at = 0;
  const body = xml.replace(/<!--[^]*?-->/g, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const between = body.slice(at, m.index);
    if (/[<>]/.test(between) || /&(?!(?:amp|lt|gt|quot|#39);)/.test(between)) return `bad text before ${m[0].slice(0, 30)}`;
    at = m.index + m[0].length;
    const [, closing, name, attrs, self] = m;
    const names = [...attrs.matchAll(/([\w:-]+)=/g)].map((a) => a[1]);
    if (new Set(names).size !== names.length) return `a repeated attribute in <${name}>`;
    if (closing) {
      if (stack.pop() !== name) return `</${name}> closes the wrong tag`;
    } else {
      if (!stack.length) roots += 1;
      if (!self) stack.push(name);
    }
  }
  if (body.slice(at).trim()) return 'text after the root, or a tag that did not parse';
  if (stack.length) return `<${stack.at(-1)}> is never closed`;
  return roots === 1 ? '' : `${roots} roots`;
}

// ── what the check cannot see ───────────────────────────────────────────────────────────────

const unescapeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const toSegment = ([px, py], [ax, ay], [bx, by]) => {
  const [dx, dy] = [bx - ax, by - ay];
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const inPolygon = ([x, y], pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const toBox = ([x, y], b) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));

// WCAG 2 contrast, written out here so this part stands on its own (the reviewer lifts it).
const wcag = (a, b) => {
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [p, q] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (p + 0.05) / (q + 0.05);
};
// The straight stretches of a line, polyline or path (M, L, H, V and their lower-case forms; an
// arc or a curve only moves the pen, since nothing here is drawn along one where text could be).
function stretches(tag, at) {
  const n = (k) => Number(at(k));
  if (tag === 'line') return [[[n('x1'), n('y1')], [n('x2'), n('y2')]]];
  if (tag === 'polyline') {
    const pts = String(at('points') || '').trim().split(/\s+/).map((p) => p.split(',').map(Number));
    return pts.slice(1).map((p, i) => [pts[i], p]);
  }
  const out = [];
  let pen = [0, 0];
  let start = [0, 0];
  for (const [, cmd, args] of String(at('d') || '').matchAll(/([MLHVAZmlhvaz])([^MLHVAZmlhvaz]*)/g)) {
    const v = (args.match(/-?\d*\.?\d+/g) || []).map(Number);
    const go = (p) => {
      out.push([pen, p]);
      pen = p;
    };
    if (cmd === 'M') [pen, start] = [[v[0], v[1]], [v[0], v[1]]];
    else if (cmd === 'L') go([v[0], v[1]]);
    else if (cmd === 'l') go([pen[0] + v[0], pen[1] + v[1]]);
    else if (cmd === 'H' || cmd === 'h') for (const x of v) go([cmd === 'H' ? x : pen[0] + x, pen[1]]);
    else if (cmd === 'V' || cmd === 'v') for (const y of v) go([pen[0], cmd === 'V' ? y : pen[1] + y]);
    else if (cmd === 'A') pen = [v[5], v[6]];
    else if (cmd === 'Z' || cmd === 'z') go(start);
  }
  return out;
}
const crosses = ([a, b], [c, d]) => {
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
};

/**
 * The checker reads only rects as text holders, so text in a circle or a polygon, text beside a
 * shape it does not belong to, a Venn region and a sequence label over a lifeline go unseen
 * (review, fix round 1). Measured here the way the checker measures text: the estimate of
 * measure.js, the box from 0.8 of the size above the baseline to 0.25 below. Task 4b's layouts
 * set text from a card's left edge, beside lines with no arrowhead and in coloured shapes, none
 * of which the checker reads either: where the text stands in its box, what else it touches, a
 * plain line through it, what is behind it, and the drawing's own margins.
 */
function blindSpots(name, svg) {
  const [width, height] = (/viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg) || [0, 720, 560]).slice(1).map(Number);
  const rootSize = Number(/<svg\b[^>]*font-size="([\d.]+)"/.exec(svg)?.[1] || 16);
  const rootInk = /<svg\b[^>]*\sfill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1] || '#000000';
  // The canvas a drawing was drawn for, from its ink: light ink is a dark drawing. A light one also
  // sits on the page's own background, so its text must read on both.
  const canvases = wcag(rootInk, '#FFFFFF') < 4.5 ? ['#0F1720'] : ['#FFFFFF', '#F7F9FB'];
  // Every element in the order it is drawn. Lines in a group that gives them arrowheads are the
  // checker's to judge; the rest are plain lines, which it does not read.
  const els = [];
  let marked = false;
  for (const [, close, tag, a, body] of svg.replace(/<defs>[^]*?<\/defs>/g, '').matchAll(/<(\/?)(g|rect|circle|polygon|polyline|line|path|text)\b([^>]*)>(?:([^<]*)<\/text>)?/g)) {
    if (tag === 'g') {
      marked = !close && /marker-end/.test(a);
      continue;
    }
    const at = (k) => new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(a)?.[1];
    const fill = at('fill');
    const opaque = !!fill && fill !== 'none' && !at('fill-opacity') && !at('opacity');
    const order = els.length;
    if (tag === 'text') {
      const size = Number(at('font-size') || rootSize);
      const text = unescapeXml(body);
      const w = textWidth(text, size, /600|bold/.test(at('font-weight') || ''));
      const [x, y] = [Number(at('x')), Number(at('y'))];
      const anchor = at('text-anchor') || 'middle';
      const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      const box = { x0, x1: x0 + w, y0: y - 0.8 * size, y1: y + 0.25 * size };
      els.push({ tag, order, text, x, y, size, ink: fill || rootInk, box, corners: [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]], centre: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2] });
    } else if (tag === 'rect') {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(at(k) || 0));
      els.push({ tag, order, fill, opaque, box: { x0: x, y0: y, x1: x + w, y1: y + h } });
    } else if (tag === 'circle') {
      const [cx, cy, r] = ['cx', 'cy', 'r'].map((k) => Number(at(k)));
      els.push({ tag, order, fill, opaque, c: [cx, cy], r, venn: !!at('fill-opacity'), box: { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r } });
    } else if (tag === 'polygon') {
      const pts = at('points').trim().split(/\s+/).map((p) => p.split(',').map(Number));
      els.push({ tag, order, fill, opaque, pts, box: { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) } });
    } else if (!marked && !/marker-end/.test(a)) els.push({ tag: 'plain', order, leader: name === 'labelled' && tag === 'path', segs: stretches(tag, at) });
  }
  const texts = els.filter((e) => e.tag === 'text');
  const rects = els.filter((e) => e.tag === 'rect');
  const circles = els.filter((e) => e.tag === 'circle');
  const polygons = els.filter((e) => e.tag === 'polygon').map((e) => e.pts);
  const lifelines = [...svg.matchAll(/<line x1="([\d.]+)" y1="64" x2="\1"/g)].map((m) => Number(m[1]));
  const found = [];
  const say = (t, what) => found.push(`"${t.text}" ${what}`);
  const inside = (p, c) => c.r - Math.hypot(p[0] - c.c[0], p[1] - c.c[1]);
  const venn = circles.filter((c) => c.venn);
  const within = (b, o, pad = 0) => b.x0 >= o.x0 + pad - 0.01 && b.y0 >= o.y0 + pad - 0.01 && b.x1 <= o.x1 - pad + 0.01 && b.y1 <= o.y1 - pad + 0.01;
  const gap = (b, o) => Math.max(o.x0 - b.x1, b.x0 - o.x1, o.y0 - b.y1, b.y0 - o.y1);
  const holds = (e, p) => (e.tag === 'rect' ? p[0] >= e.box.x0 && p[0] <= e.box.x1 && p[1] >= e.box.y0 && p[1] <= e.box.y1 : e.tag === 'circle' ? inside(p, e) >= 0 : e.tag === 'polygon' ? inPolygon(p, e.pts) : false);
  for (const t of texts) {
    if (t.box.x0 < 24 - 0.5 || t.box.x1 > width - 24 + 0.5) say(t, `runs into the ${Math.round(t.box.x0 < 24 ? t.box.x0 : t.box.x1)} margin`);
    if (t.box.y0 < 24 - 0.5 || t.box.y1 > height - 24 + 0.5) say(t, `runs into the margin at y ${Math.round(t.box.y0 < 24 ? t.box.y0 : t.box.y1)}`);
    // Its box, found as the checker finds it (the smallest rect round where it is anchored, or just
    // under one): the text stays 4 px inside it, and 4 px clear of every rect that is not round it.
    let holder = null;
    for (const r of rects) if (t.x >= r.box.x0 && t.x <= r.box.x1 && t.y >= r.box.y0 && t.y <= r.box.y1 + t.size * 0.3 && (!holder || (r.box.x1 - r.box.x0) * (r.box.y1 - r.box.y0) < (holder.box.x1 - holder.box.x0) * (holder.box.y1 - holder.box.y0))) holder = r;
    if (holder && !within(t.box, holder.box, 4)) say(t, `stands ${Math.min(t.box.x0 - holder.box.x0, holder.box.x1 - t.box.x1, t.box.y0 - holder.box.y0, holder.box.y1 - t.box.y1).toFixed(1)} px from its box's edge (4 wanted)`);
    for (const r of rects) if (r !== holder && !(holder && within(holder.box, r.box)) && gap(t.box, r.box) < 4) say(t, `comes within ${gap(t.box, r.box).toFixed(1)} px of a box it is not in`);
    // What is behind it: the last filled shape drawn before it that holds its middle, else the canvas.
    const behind = els.filter((e) => e.order < t.order && e.opaque && /^#[0-9A-Fa-f]{6}$/.test(e.fill) && holds(e, t.centre)).at(-1);
    const least = Math.min(...(behind ? [behind.fill] : canvases).map((bg) => wcag(t.ink, bg)));
    if (least < 4.5) say(t, `reads at ${least.toFixed(2)}:1 on what is behind it (4.5 wanted)`);
    // A Venn region: every corner in exactly the circles its middle is in, 6 px inside each outline.
    if (venn.length) {
      const want = venn.map((c) => inside(t.centre, c) > 0);
      const worst = Math.min(...t.corners.flatMap((p) => venn.map((c, i) => (want[i] ? inside(p, c) : -inside(p, c)))));
      if (worst < 6) say(t, `is ${worst.toFixed(1)} px from a circle's outline (6 wanted)`);
    }
    // Text in a circle or polygon stays 4 px inside it; text outside stays 4 px clear of it.
    for (const c of circles.filter((k) => !k.venn)) {
      if (inside(t.centre, c) > 0) {
        const least = Math.min(...t.corners.map((p) => inside(p, c)));
        if (least < 4) say(t, `is ${least.toFixed(1)} px inside its circle (4 wanted)`);
      } else if (toBox(c.c, t.box) < c.r + 4) say(t, `comes within ${(toBox(c.c, t.box) - c.r).toFixed(1)} px of a circle`);
    }
    for (const pts of polygons) {
      const edges = pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);
      if (inPolygon(t.centre, pts)) {
        const least = Math.min(...t.corners.map((p) => (inPolygon(p, pts) ? Math.min(...edges.map(([a, b]) => toSegment(p, a, b))) : -1)));
        if (least < 4) say(t, `is ${least.toFixed(1)} px inside its shape (4 wanted)`);
      } else {
        let least = Infinity;
        for (const [a, b] of edges) for (let k = 0; k <= 64; k += 1) least = Math.min(least, toBox([a[0] + ((b[0] - a[0]) * k) / 64, a[1] + ((b[1] - a[1]) * k) / 64], t.box));
        if (least < 4) say(t, `comes within ${least.toFixed(1)} px of a shape it is not in`);
      }
    }
    // A sequence label never sits on a lifeline: the dashes would run through its words.
    if (name === 'sequence' && t.box.y0 > 64) for (const x of lifelines) if (t.box.x0 - 4 < x && x < t.box.x1 + 4) say(t, `sits on the lifeline at x ${Math.round(x)}`);
  }
  // Texts never touch: the checker minds only an overlap of 30 % of the smaller.
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const [p, q] = [texts[i].box, texts[j].box];
      if (Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 0.5 && Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) > 0.5) say(texts[i], `touches "${texts[j].text}"`);
    }
  }
  // A plain line, where it shows (not under a filled shape drawn after it), runs through no text.
  const plain = els.filter((e) => e.tag === 'plain');
  for (const line of plain) {
    const covers = els.filter((e) => e.order > line.order && e.opaque && e.tag !== 'text');
    for (const t of texts) {
      const core = { x0: t.box.x0 + 1.5, x1: t.box.x1 - 1.5, y0: t.box.y0 + 1.5, y1: t.box.y1 - 1.5 };
      const hit = line.segs.some(([a, b]) => {
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
        for (let k = 0; k <= steps; k += 1) {
          const p = [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps];
          if (p[0] > core.x0 && p[0] < core.x1 && p[1] > core.y0 && p[1] < core.y1 && !covers.some((e) => holds(e, p))) return true;
        }
        return false;
      });
      if (hit) say(t, 'has a line running through it');
    }
  }
  // Every shape inside the margins (a Venn circle or a ring is measured by its radius).
  for (const e of els.filter((s) => s.box && s.tag !== 'text')) {
    if (e.box.x0 < 24 - 0.5 || e.box.x1 > width - 24 + 0.5 || e.box.y0 < 24 - 0.5 || e.box.y1 > height - 24 + 0.5) found.push(`a ${e.tag} at (${Math.round(e.box.x0)}, ${Math.round(e.box.y0)}) runs into the margin`);
  }
  // A labelled picture's leaders never cross one another.
  const leaders = plain.filter((e) => e.leader);
  for (let i = 0; i < leaders.length; i += 1) {
    for (let j = i + 1; j < leaders.length; j += 1) {
      if (leaders[i].segs.some((s) => leaders[j].segs.some((u) => crosses(s, u)))) found.push(`leaders ${i + 1} and ${j + 1} cross`);
    }
  }
  return found;
}

const rad = (deg) => (deg * Math.PI) / 180;
const fam = (P, i) => P.fam[i % 6];
// A mind map's branches stand in a ring, so the last is beside the first: in table order (i mod 6),
// except that the seventh of seven takes green (review, Task 4: blue would sit beside the first).
const ringFam = (n, i) => (n % 6 === 1 && i === n - 1 ? (i + 1) % 6 : i % 6);
const colours = (P, f = P.fam[0]) => ({ ink: P.ink, muted: P.muted, line: P.line, card: P.card, edge: P.edge, ground: P.ground, rule: P.rule, solid: P.solid, onSolid: P.onSolid, tint: f.tint, stroke: f.stroke, inkA: f.inkA });
// Two lines centred on y at 13 px (18 apart), or one; null drops the second, as the recipes say.
const pair = (lines, y) => (lines.length === 2 ? { a: y - 4.5, b: y + 13.5 } : { a: y + 4.5, b: null });

// Each filler follows its recipe's arithmetic, given what is to be drawn.
const FILL = {
  decision(P, spine) {
    let y = 24;
    const placed = spine.map((s) => {
      const h = s.q ? 80 : 40;
      const at = { ...s, y, h };
      y += h + 32;
      return at;
    });
    const last = placed.at(-1);
    const H = last.y + last.h + 24;
    const q = P.fam[0];
    return {
      H,
      top: { H, ...colours(P, q) },
      each: {
        link: placed.slice(0, -1).map((s, i) => ({ y1: s.y + s.h, y2: placed[i + 1].y })),
        exit: placed.filter((s) => s.q).map((s) => ({ cy: s.y + 40 })),
        step: placed.filter((s) => !s.q).map((s) => ({ y: s.y, rx: s.pill ? 20 : 8, ty: s.y + 25, title: s.title })),
        question: placed.filter((s) => s.q).map((s) => {
          const cy = s.y + 40;
          const t = pair(s.q, cy);
          return { y: s.y, cy, bottom: s.y + 80, ty1: t.a, ty2: t.b, line1: s.q[0], line2: s.q[1] ?? null, yesY: s.y + 80 + 20.4, noY: cy - 8, oy: cy - 20, oty: cy + 4.5, yes: s.yes, no: s.no, outcome: s.outcome };
        }),
      },
    };
  },
  loop(P, { steps, back, check: question, again, yes, done }) {
    const n = steps.length;
    const w = Math.floor((512 - 32 * n) / n / 8) * 8;
    const x = (i) => 24 + i * (w + 32);
    const dx0 = 24 + n * (w + 32);
    const dcx = dx0 + 80;
    const tcx = x(back) + w / 2;
    return {
      H: 272,
      top: { ...colours(P), dcx, dl: dcx - 80, dr: dcx + 80, tcx, lx: (dcx + tcx) / 2, yx: dcx + 10, px: dcx - 64, line1: question[0], line2: question[1] ?? null, again, yes, done },
      each: {
        link: steps.map((s, i) => ({ x1: x(i) + w, x2: i < n - 1 ? x(i + 1) : dx0 })),
        step: steps.map((title, i) => ({ x: x(i), w, cx: x(i) + w / 2, title })),
      },
    };
  },
  swimlanes(P, { lanes, steps, arrows }) {
    const m = Math.max(...steps.map((s) => s.col)) + 1;
    const w = Math.floor((540 - 24 * (m - 1)) / m);
    const laneY = (i) => 24 + 84 * i;
    const at = steps.map((s) => ({ ...s, x: 140 + s.col * (w + 24), y: laneY(s.lane) + 16, cy: laneY(s.lane) + 42 }));
    const H = 48 + 84 * lanes.length;
    const d = ([a, b]) => {
      const [p, q] = [at[a], at[b]];
      if (p.lane === q.lane) return `M${num(p.x + w)} ${num(p.cy)}H${num(q.x)}`;
      if (p.col === q.col) return q.lane > p.lane ? `M${num(p.x + w / 2)} ${num(p.y + 52)}V${num(q.y)}` : `M${num(p.x + w / 2)} ${num(p.y)}V${num(q.y + 52)}`;
      return `M${num(p.x + w)} ${num(p.cy)}H${num(q.x - 16)}V${num(q.cy)}H${num(q.x)}`;
    };
    return {
      H,
      top: { H, ...colours(P) },
      each: {
        lane: lanes.map((name, i) => {
          const f = fam(P, i);
          const t = pair(name, laneY(i) + 42);
          return { y: laneY(i), hy: laneY(i) + 4, tint: f.tint, inkA: f.inkA, ny1: t.a, ny2: t.b, name1: name[0], name2: name[1] ?? null };
        }),
        arrow: arrows.map((ab) => ({ d: d(ab) })),
        step: at.map((s) => {
          const t = pair(s.text, s.cy);
          return { x: s.x, y: s.y, w, cx: s.x + w / 2, stroke: fam(P, s.lane).stroke, ty1: t.a, ty2: t.b, line1: s.text[0], line2: s.text[1] ?? null };
        }),
      },
    };
  },
  sequence(P, { parties, messages }) {
    const k = parties.length;
    const pitch = 672 / k;
    const w = Math.min(160, pitch - 16);
    const xOf = (i) => 24 + pitch * (i + 0.5);
    const ys = messages.map((_, j) => 104 + 40 * j);
    const yEnd = ys.at(-1) + 24;
    const H = yEnd + 24;
    const labels = messages.map((msg, j) => {
      // On the last party a call to itself turns left, its label mirrored, so it stays on the canvas.
      if (msg.self !== undefined) return msg.self === k - 1 ? { lx: xOf(msg.self) - 36, ly: ys[j] - 4.6, anchor: 'end', label: msg.label } : { lx: xOf(msg.self) + 36, ly: ys[j] - 4.6, anchor: 'start', label: msg.label };
      const right = msg.to > msg.from;
      return { lx: xOf(msg.from) + (right ? 10 : -10), ly: ys[j] - 8, anchor: right ? 'start' : 'end', label: msg.label };
    });
    return {
      H,
      top: { H, ...colours(P) },
      each: {
        party: parties.map((name, i) => ({ x: xOf(i), bx: xOf(i) - w / 2, w, yEnd, name })),
        call: messages.map((msg, j) => ({ msg, y: ys[j] })).filter(({ msg }) => msg.self === undefined && !msg.reply).map(({ msg, y }) => ({ x1: xOf(msg.from), x2: xOf(msg.to), y })),
        reply: messages.map((msg, j) => ({ msg, y: ys[j] })).filter(({ msg }) => msg.reply).map(({ msg, y }) => ({ x1: xOf(msg.from), x2: xOf(msg.to), y })),
        self: messages.map((msg, j) => ({ msg, y: ys[j] })).filter(({ msg }) => msg.self !== undefined).map(({ msg, y }) => ({ x: xOf(msg.self), top: y - 18, out: msg.self === k - 1 ? -28 : 28, back: msg.self === k - 1 ? 28 : -28 })),
        label: labels,
      },
    };
  },
  tree(P, { root, heads }) {
    const k = heads.length;
    const S = 672 / k;
    const w = Math.min(200, S - 16);
    const cx = (i) => 24 + S * (i + 0.5);
    const most = Math.max(0, ...heads.map((h) => h.leaves.length));
    const H = most ? 208 + 40 * most : 192;
    return {
      H,
      top: { H, ...colours(P), bus0: cx(0), bus1: cx(k - 1), root },
      each: {
        drop: heads.map((_, i) => ({ cx: cx(i) })),
        spine: heads.map((h, i) => ({ h, i })).filter(({ h }) => h.leaves.length).map(({ h, i }) => ({ sx: cx(i) - w / 2 + 8, sy: 208 + 40 * (h.leaves.length - 1) })),
        tick: heads.flatMap((h, i) => h.leaves.map((_, j) => ({ sx: cx(i) - w / 2 + 8, y: 208 + 40 * j, lx: cx(i) - w / 2 + 20 }))),
        head: heads.map((h, i) => ({ x: cx(i) - w / 2, w, cx: cx(i), title: h.title, tint: fam(P, i).tint, stroke: fam(P, i).stroke, inkA: fam(P, i).inkA })),
        leaf: heads.flatMap((h, i) => h.leaves.map((name, j) => ({ x: cx(i) - w / 2 + 20, y: 192 + 40 * j, w: w - 20, cx: cx(i) - w / 2 + 20 + (w - 20) / 2, ty: 212.5 + 40 * j, name }))),
      },
    };
  },
  mindmap(P, { centre, branches }) {
    const n = branches.length;
    const w = n <= 8 ? 160 : 128;
    const cy = 212;
    const at = branches.map((title, i) => {
      const t = rad(-90 + (360 * i) / n);
      return { title, nx: 360 + 240 * Math.cos(t), ny: cy + 168 * Math.sin(t), f: P.fam[ringFam(n, i)] };
    });
    return {
      H: 424,
      top: { H: 424, ...colours(P), cy, top: cy - 28, cty: cy + 5.6, centre },
      each: {
        spoke: at.map((b) => ({ nx: b.nx, ny: b.ny, stroke: b.f.stroke })),
        branch: at.map((b) => ({ x: b.nx - w / 2, y: b.ny - 20, w, nx: b.nx, ty: b.ny + 4.5, title: b.title, tint: b.f.tint, stroke: b.f.stroke, inkA: b.f.inkA })),
      },
    };
  },
  pyramid(P, { funnel, bands }) {
    const n = bands.length;
    const hb = n <= 5 ? 56 : 48;
    const d = 216 / n;
    const H = 24 + n * hb + 6 * (n - 1) + 24;
    return {
      H,
      top: { H, ...colours(P) },
      each: {
        band: bands.map((b, i) => {
          const t = funnel ? 336 - i * d : 120 + i * d;
          const bot = funnel ? t - d : t + d;
          const y = 24 + i * (hb + 6);
          const my = y + hb / 2;
          const f = fam(P, 0);
          const notes = pair(b.note, my);
          return { x1: 200 - t / 2, x2: 200 + t / 2, x3: 200 + bot / 2, x4: 200 - bot / 2, y, yb: y + hb, ty: my + 5, my, lx: 200 + (t + bot) / 4 + 8, ny1: notes.a, ny2: notes.b, title: b.title, note1: b.note[0], note2: b.note[1] ?? null, tint: f.tint, stroke: f.stroke, inkA: f.inkA };
        }),
      },
    };
  },
  cycle(P, { hub, caption, steps }) {
    const n = steps.length;
    const [R, r] = n <= 6 ? [168, 52] : [192, 40];
    const cy = 24 + R + r;
    const delta = (2 * Math.asin(r / (2 * R)) * 180) / Math.PI;
    const angle = (i) => -90 + (360 * i) / n;
    const on = (deg) => [360 + R * Math.cos(rad(deg)), cy + R * Math.sin(rad(deg))];
    return {
      H: 2 * cy,
      top: { H: 2 * cy, ...colours(P), R, cty: cy + 5.6, capY: cy + 26, hub, caption },
      each: {
        arc: steps.map((_, i) => {
          const [x1, y1] = on(angle(i) + delta);
          const [x2, y2] = on(angle(i + 1) - delta);
          return { x1, y1, x2, y2 };
        }),
        node: steps.map((lines, i) => {
          const [nx, ny] = on(angle(i));
          const f = fam(P, 0);
          const t = pair(lines, ny);
          return { nx, ny, r, ty1: t.a, ty2: t.b, line1: lines[0], line2: lines[1] ?? null, tint: f.tint, stroke: f.stroke, inkA: f.inkA };
        }),
      },
    };
  },
  venn(P, { sets, regions }, theme) {
    const op = theme === 'dark' ? 0.2 : 0.16;
    const three = sets.length === 3;
    const circles = three ? [[282, 170, 120], [438, 170, 120], [360, 305, 120]] : [[261, 202, 152], [459, 202, 152]];
    const names = three ? [[244, 40], [476, 40], [360, 448]] : [[208, 40], [512, 40]];
    const points = three ? { A: [244, 147], B: [476, 147], C: [360, 349], AB: [360, 146], AC: [301, 249], BC: [419, 249], ABC: [360, 215] } : { A: [208, 202], AB: [360, 202], B: [512, 202] };
    const H = three ? 476 : 378;
    return {
      H,
      top: { H, ...colours(P), op },
      each: {
        set: circles.map(([cx, cy, r], i) => ({ cx, cy, r, stroke: fam(P, i).stroke })),
        name: names.map(([x, y], i) => ({ x, y, name: sets[i], inkA: fam(P, i).inkA })),
        item: Object.entries(regions).flatMap(([key, lines]) => lines.map((item, k) => ({ x: points[key][0], y: points[key][1] - 9 * (lines.length - 1) + 4.5 + 18 * k, item }))),
      },
    };
  },
  stack(P, { layers, bar }) {
    const k = layers.length;
    const hb = k <= 6 ? 64 : 48;
    const w = bar ? 576 : 672;
    const areaW = w - 176;
    const H = 24 + k * hb + 8 * (k - 1) + 24;
    const slate = P.fam[6];
    const barH = k * hb + 8 * (k - 1);
    return {
      H,
      top: { H, ...colours(P) },
      each: {
        layer: layers.map((l, i) => ({ y: 24 + i * (hb + 8), w, h: hb, ty: 24 + i * (hb + 8) + hb / 2 + 5, name: l.name, tint: fam(P, 0).tint, stroke: fam(P, 0).stroke, inkA: fam(P, 0).inkA })),
        chip: layers.flatMap((l, i) => {
          const m = l.chips.length;
          const cw = (areaW - 8 * (m - 1)) / m;
          const y = 24 + i * (hb + 8) + (hb - 32) / 2;
          return l.chips.map((name, j) => ({ x: 184 + j * (cw + 8), y, w: cw, cx: 184 + j * (cw + 8) + cw / 2, ty: y + 20.5, name }));
        }),
        bar: bar ? [{ h: barH, tint: slate.tint, stroke: slate.stroke }] : [],
        word: bar ? bar.map((word, j) => ({ y: 24 + barH / 2 - 9 * (bar.length - 1) + 4.5 + 18 * j, word, inkA: slate.inkA })) : [],
      },
    };
  },
  // ── Task 4b: sequences ──
  timeline(P, { items, vertical, W = 720 }) {
    const f = P.fam[0];
    const dot = (it) => (it.done ? f.stroke : P.card);
    if (vertical) {
      // Down one spine: at x 136, or 104 on a phone's 360.
      const sx = W === 360 ? 104 : 136;
      const H = 32 * items.length + 48;
      return {
        H,
        W,
        top: { H, ...colours(P, f) },
        each: {
          spine: [{ x1: sx, y1: 24, x2: sx, y2: H - 24 }],
          card: [],
          item: items.map((it, i) => ({ dx: sx, dy: 40 + 32 * i, dot: dot(it), tx: sx - 16, ty: 44.5 + 32 * i, anchor: 'end', date: it.date })),
          title: items.map((it, i) => ({ lx: sx + 20, ty: 45 + 32 * i, title: it.title })),
        },
      };
    }
    const half = Math.ceil(items.length / 2);
    const rows = items.length <= 6 ? [items] : [items.slice(0, half), items.slice(half)];
    const s = 672 / rows[0].length;
    const w = Math.min(200, s - 16);
    const H = 24 + 160 * rows.length;
    const placed = rows.flatMap((row, r) => row.map((it, i) => ({ it, sy: 56 + 160 * r, cx: 24 + s * (i + 0.5) })));
    return {
      H,
      top: { H, ...colours(P, f) },
      each: {
        spine: rows.map((_, r) => ({ x1: 24, y1: 56 + 160 * r, x2: 696, y2: 56 + 160 * r })),
        card: placed.map(({ it, sy, cx }) => ({ cx, sy, x: cx - w / 2, y: sy + 24, w, ty: sy + 49, ny1: sy + 71, ny2: it.note[1] === undefined ? null : sy + 89, title: it.title, note1: it.note[0], note2: it.note[1] ?? null, edge: it.now ? f.stroke : P.edge })),
        item: placed.map(({ it, sy, cx }) => ({ dx: cx, dy: sy, dot: dot(it), tx: cx, ty: sy - 18, anchor: 'middle', date: it.date })),
        title: [],
      },
    };
  },
  steps(P, { steps, W = 720 }) {
    const n = steps.length;
    const m = W === 360 ? 2 : n <= 4 ? n : Math.ceil(n / 2);
    const w = Math.floor((W - 48 - 32 * (m - 1)) / m);
    const H = 192 * Math.ceil(n / m) + 8;
    const at = steps.map((s, k) => {
      const [r, c] = [Math.floor(k / m), k % m];
      const x = 24 + c * (w + 32);
      return { ...s, k, r, x, y: 24 + 192 * r, cx: x + w / 2 };
    });
    // In a row, edge to edge; to the next row, down from the last, along the gap, down to the first.
    const d = (a, b) => (a.r === b.r ? `M${num(a.x + w)} ${num(a.y + 32)}H${num(b.x)}` : `M${num(a.cx)} ${num(a.y + 152)}V${num(a.y + 172)}H${num(b.cx)}V${num(b.y)}`);
    return {
      H,
      W,
      top: { H, ...colours(P) },
      each: {
        link: at.slice(0, -1).map((a, k) => ({ d: d(a, at[k + 1]) })),
        step: at.map((s) => ({ x: s.x, y: s.y, w, bx: s.cx - 16, by: s.y + 16, cx: s.cx, ny: s.y + 37, n: String(s.k + 1), ty: s.y + 76, title: s.title, ly1: s.y + 100, ly2: s.lines.length > 1 ? s.y + 118 : null, ly3: s.lines.length > 2 ? s.y + 136 : null, line1: s.lines[0], line2: s.lines[1] ?? null, line3: s.lines[2] ?? null })),
      },
    };
  },
  gantt(P, { head, units, rows, now }) {
    const [f, rose] = [P.fam[0], P.fam[4]];
    const uw = 480 / units.length;
    const gy = 64 + 36 * rows.length;
    const H = now ? gy + 48 : gy + 24;
    const cy = (i) => 82 + 36 * i;
    const X = (t) => 216 + t * uw;
    const which = (key) => rows.map((r, i) => ({ r, i })).filter(({ r }) => r[key] !== undefined);
    return {
      H,
      top: { H, ...colours(P, f), head, gy, rose: rose.stroke, roseInk: rose.inkA },
      each: {
        unit: [...units, null].map((unit, j) => ({ x: X(j), cx: unit === null ? null : X(j) + uw / 2, unit })),
        row: rows.map((r, i) => ({ ty: cy(i) + 4.5, weight: r.phase ? 600 : 400, name: r.name })),
        bar: which('length').map(({ r, i }) => (r.phase ? { x: X(r.start), y: cy(i) - 4, w: r.length * uw, h: 8, rx: 4, fill: f.stroke } : { x: X(r.start), y: cy(i) - 12, w: r.length * uw, h: 24, rx: 6, fill: f.tint })),
        done: which('done').map(({ r, i }) => ({ x: X(r.start), y: cy(i) - 12, w: r.done * r.length * uw })),
        milestone: which('at').map(({ r, i }) => ({ x: X(r.at), t: cy(i) - 9, b: cy(i) + 9, l: X(r.at) - 9, r: X(r.at) + 9, cy: cy(i) })),
        now: now ? [{ x: X(now.at), ly: gy + 20, anchor: X(now.at) > 660 ? 'end' : 'middle', label: now.label }] : [],
      },
    };
  },
  journey(P, { stages, lanes }) {
    const n = stages.length;
    const w = (672 - 8 * (n - 1)) / n;
    const X = (i) => 24 + i * (w + 8);
    let y = 80;
    const placed = lanes.map((lane) => {
      const at = { ...lane, y };
      y += lane.feelings ? 144 : 100;
      return at;
    });
    const H = y + 8;
    const tone = { pain: P.fam[4], idea: P.fam[1] };
    const moodOf = (s) => (s > 0 ? P.fam[1] : s < 0 ? P.fam[4] : P.fam[6]);
    const feel = placed.find((l) => l.feelings);
    const dy = (s) => feel.y + 68 - 16 * s;
    return {
      H,
      top: { H, ...colours(P) },
      each: {
        stage: stages.map((name, i) => ({ x: X(i), xr: X(i) + w - 12, xp: X(i) + w, xn: i ? X(i) + 12 : X(i), cx: X(i) + w / 2, name })),
        lane: placed.map((l) => ({ ly: l.y + 16, lane: l.name })),
        cell: placed.filter((l) => l.cells).flatMap((l) => l.cells.map((lines, i) => {
          const c = tone[l.tone];
          const t = pair(lines, l.y + 56);
          return { x: X(i), y: l.y + 28, w, cx: X(i) + w / 2, fill: c ? c.tint : P.card, rim: c ? c.stroke : P.edge, text: c ? c.inkA : P.ink, ty1: t.a, ty2: t.b, line1: lines[0], line2: lines[1] ?? null };
        })),
        curve: feel ? [{ mid: feel.y + 68, right: 696, points: feel.feelings.map((s, i) => `${num(X(i) + w / 2)},${num(dy(s.s))}`).join(' ') }] : [],
        feeling: feel ? feel.feelings.map((s, i) => ({ cx: X(i) + w / 2, dy: dy(s.s), wy: feel.y + 124, word: s.word, mood: moodOf(s.s).stroke, moodInk: moodOf(s.s).inkA })) : [],
      },
    };
  },
  // ── Task 4b: layouts ──
  compare(P, { points, options, best }) {
    const k = options.length;
    const table = !!points;
    const x0 = table ? 200 : 24;
    const w = ((table ? 496 : 672) - 16 * (k - 1)) / k;
    const rows = Math.max(...options.map((o) => o.values.length));
    const h = 80 + 40 * rows;
    const X = (i) => x0 + i * (w + 16);
    const tone = (v) => (v.tone === 'yes' ? P.fam[1].inkA : v.tone === 'no' ? P.muted : P.ink);
    return {
      H: h + 48,
      top: { H: h + 48, ...colours(P) },
      each: {
        option: options.map((o, i) => {
          const f = fam(P, i);
          const top = i === best;
          return { x: X(i), w, h, rim: top ? P.solid : P.edge, sw: top ? 2 : 1, px: X(i) + 6, pw: w - 12, plate: top ? P.solid : f.tint, on: top ? P.onSolid : f.inkA, cx: X(i) + w / 2, name: o.name, sub: o.sub };
        }),
        rule: table ? Array.from({ length: rows - 1 }, (_, r) => ({ y: 136 + 40 * r })) : [],
        point: table ? points.map((label, r) => ({ ty: 120.5 + 40 * r, label })) : [],
        value: options.flatMap((o, i) => o.values.map((v, r) => ({ vx: table ? X(i) + w / 2 : X(i) + 16, ty: 120.5 + 40 * r, anchor: table ? 'middle' : 'start', value: v.text ?? v, tone: tone(v) }))),
      },
    };
  },
  matrix(P, { quads, axes }) {
    // Top left, top right, bottom left, bottom right: high on the y axis first.
    const at = [[96, 56], [400, 56], [96, 256], [400, 256]];
    return {
      H: 520,
      top: { H: 520, ...colours(P), ...axes },
      each: {
        quadrant: quads.map((q, i) => ({ x: at[i][0], y: at[i][1], tx: at[i][0] + 16, ty: at[i][1] + 30, title: q.title, tint: P.fam[q.fam].tint, stroke: P.fam[q.fam].stroke, inkA: P.fam[q.fam].inkA })),
        item: quads.flatMap((q, i) => q.items.map((item, k) => ({ tx: at[i][0] + 16, ty: at[i][1] + 56 + 20 * k, item: `• ${item}` }))),
      },
    };
  },
  sides(P, { sides, verdict, arrow }) {
    const xs = [24, 380];
    const placed = sides.map((s) => {
      let ty = 116;
      return s.points.map((lines) => {
        const at = { ty, ty2: lines.length > 1 ? ty + 18 : null, lines };
        ty += 28 + 18 * (lines.length - 1);
        return at;
      });
    });
    const last = Math.max(...placed.map((pts) => pts.at(-1).ty2 ?? pts.at(-1).ty));
    const h = last - 2;
    const vy = h + 40;
    const H = verdict ? vy + 72 : h + 48;
    return {
      H,
      top: { H, ...colours(P) },
      each: {
        arrow: arrow ? [{}] : [],
        side: sides.map((s, k) => ({ x: xs[k], h, px: xs[k] + 6, cx: xs[k] + 158, title: s.title, tint: P.fam[s.fam].tint, inkA: P.fam[s.fam].inkA })),
        point: sides.flatMap((s, k) => placed[k].map(({ ty, ty2, lines }) => ({ mx: xs[k] + 24, tx: xs[k] + 40, ty, ty2, mark: s.mark, line1: lines[0], line2: lines[1] ?? null, inkA: P.fam[s.fam].inkA }))),
        verdict: verdict ? [{ vy, vty: vy + 28.5, verdict }] : [],
      },
    };
  },
  kpi(P, { cards, W = 720 }) {
    const m = W === 360 ? 2 : Math.min(4, cards.length);
    const w = (W - 48 - 16 * (m - 1)) / m;
    const H = 152 * Math.ceil(cards.length / m) + 32;
    return {
      H,
      W,
      top: { H, ...colours(P) },
      each: {
        card: cards.map((c, k) => {
          const x = 24 + (k % m) * (w + 16);
          const y = 24 + 152 * Math.floor(k / m);
          const [least, most] = [Math.min(...c.spark), Math.max(...c.spark)];
          const spark = c.spark.map((v, j) => `${num(x + 16 + (j * (w - 32)) / (c.spark.length - 1))},${num(most === least ? y + 116 : y + 124 - (16 * (v - least)) / (most - least))}`).join(' ');
          const tone = c.good === true ? P.fam[1].inkA : c.good === false ? P.fam[4].inkA : P.muted;
          return { x, y, w, dx: x + 20, dy: y + 24, lx: x + 32, ly: y + 28.5, vx: x + 16, vy: y + 72, cy: y + 98, label: c.label, value: c.value, change: c.change, tone, stroke: fam(P, k).stroke, spark };
        }),
      },
    };
  },
  panel(P, { big, say, facts, source }) {
    const f = P.fam[0];
    const s = 672 / facts.length;
    return {
      H: 400,
      top: { H: 400, ...colours(P, f), big, say1: say[0], say2: say[1] ?? null, source },
      each: {
        fact: facts.map((ft, i) => {
          const cx = 24 + s * (i + 0.5);
          const p = ft.share;
          const arc = typeof p === 'number' && p > 0 && p < 1;
          const a = rad(-90 + 360 * (arc ? p : 0));
          return { cx, ring: p === 1 ? f.stroke : f.tint, large: arc ? (p > 0.5 ? 1 : 0) : null, ex: arc ? cx + 40 * Math.cos(a) : null, ey: arc ? 208 + 40 * Math.sin(a) : null, value: ft.value, title: ft.title, line1: ft.lines[0], line2: ft.lines[1] ?? null };
        }),
      },
    };
  },
  labelled(P, { parts, rounds, points }) {
    const f = P.fam[0];
    const paint = { tint: f.tint, stroke: f.stroke, card: P.card, ground: P.ground, edge: P.edge, solid: P.solid };
    // Each side in the order of its points, each label at its point's height or 52 below the one above.
    const callouts = [points.filter((p) => p.px < 360), points.filter((p) => p.px >= 360)].flatMap((list, side) => {
      let above = -Infinity;
      return [...list].sort((a, b) => a.py - b.py).map((p) => {
        const ty = Math.max(p.py + 5, above + 52);
        above = ty;
        return { ...p, ty, ny: ty + 18, y1: ty - 5, ...(side === 0 ? { tx: 216, anchor: 'end', x1: 224, x2: 240 } : { tx: 504, anchor: 'start', x1: 496, x2: 480 }) };
      });
    });
    const bottom = Math.max(...parts.map((p) => p.y + p.h), ...rounds.map((c) => c.cy + c.r));
    const H = Math.max(bottom, ...callouts.map((c) => c.ny + 4)) + 24;
    return {
      H,
      top: { H, ...colours(P, f) },
      each: {
        part: parts.map((p) => ({ ...p, fill: paint[p.fill], rim: paint[p.rim] })),
        round: rounds.map((c) => ({ ...c, fill: paint[c.fill], rim: paint[c.rim] })),
        leader: callouts.map((c) => ({ x1: c.x1, y1: c.y1, x2: c.x2, px: c.px, py: c.py })),
        callout: callouts,
      },
    };
  },
};

// What each recipe is filled with: a comfortable drawing, and the extreme its adaptive rule allows.
const SAMPLES = {
  decision: {
    comfortable: [
      { title: 'Nhận đơn hàng', pill: true },
      { title: 'Kiểm tra thông tin' },
      { q: ['Còn hàng', 'trong kho?'], yes: 'Có', no: 'Không', outcome: 'Báo hết hàng cho khách' },
      { title: 'Đóng gói và in nhãn' },
      { q: ['Thanh toán', 'thành công?'], yes: 'Có', no: 'Không', outcome: 'Gửi lại link thanh toán' },
      { title: 'Giao cho vận chuyển', pill: true },
    ],
    extreme: [
      // Each at its recipe's room: a step 25 characters, a question 13 then 12, an exit label 17, an outcome 30.
      { title: 'Nhận hồ sơ vay trực tuyến', pill: true },
      { q: ['Đủ giấy tờ?'], yes: 'Đủ', no: 'Thiếu giấy tờ gốc', outcome: 'Yêu cầu bổ sung trong 5 ngày' },
      { q: ['Điểm tín dụng', 'đạt mức 650?'], yes: 'Đạt', no: 'Dưới ngưỡng', outcome: 'Từ chối và gửi thư giải thích' },
      { q: ['Vay dưới', '500 triệu?'], yes: 'Dưới', no: 'Từ 500 triệu', outcome: 'Chuyển hội đồng tín dụng' },
      { title: 'Giải ngân trong 48 giờ', pill: true },
    ],
  },
  loop: {
    comfortable: { steps: ['Viết bản nháp', 'Gửi duyệt', 'Chỉnh sửa'], back: 1, check: ['Đạt yêu', 'cầu chưa?'], again: 'Chưa đạt — tối đa 3 vòng', yes: 'Đạt', done: 'Xuất bản' },
    extreme: { steps: ['Thu thập', 'Làm sạch', 'Chạy thử', 'Đánh giá'], back: 1, check: ['Đủ chính', 'xác chưa?'], again: 'Dưới 95 %: làm sạch lại dữ liệu', yes: 'Đủ', done: 'Triển khai' },
  },
  swimlanes: {
    comfortable: {
      lanes: [['Khách', 'hàng'], ['Cửa hàng'], ['Kho']],
      steps: [
        { lane: 0, col: 0, text: ['Đặt hàng'] },
        { lane: 1, col: 1, text: ['Xác nhận đơn'] },
        { lane: 2, col: 2, text: ['Đóng gói và', 'xuất kho'] },
        { lane: 0, col: 3, text: ['Nhận hàng'] },
      ],
      arrows: [[0, 1], [1, 2], [2, 3]],
    },
    extreme: {
      lanes: [['Khách', 'hàng'], ['Bán hàng'], ['Kế toán'], ['Kho'], ['Vận', 'chuyển'], ['Chăm sóc']],
      steps: [
        { lane: 0, col: 0, text: ['Đặt hàng'] },
        { lane: 1, col: 0, text: ['Báo giá'] },
        { lane: 1, col: 1, text: ['Chốt đơn'] },
        { lane: 2, col: 2, text: ['Xuất hoá', 'đơn'] },
        { lane: 3, col: 3, text: ['Đóng gói'] },
        { lane: 4, col: 3, text: ['Giao', 'hàng'] },
        { lane: 5, col: 4, text: ['Hỏi thăm'] },
        { lane: 0, col: 4, text: ['Đánh giá'] },
      ],
      arrows: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
    },
  },
  sequence: {
    comfortable: {
      parties: ['Người dùng', 'Ứng dụng', 'Máy chủ', 'Ngân hàng'],
      messages: [
        { from: 0, to: 1, label: '1. Bấm thanh toán' },
        { from: 1, to: 2, label: '2. Tạo đơn' },
        { self: 2, label: '3. Kiểm tồn kho' },
        { from: 2, to: 3, label: '4. Yêu cầu trừ tiền' },
        { from: 3, to: 2, label: '5. Đã trừ tiền', reply: true },
        { from: 2, to: 1, label: '6. Đơn đã thanh toán', reply: true },
        { from: 1, to: 0, label: '7. Hiện biên nhận', reply: true },
      ],
    },
    extreme: {
      parties: ['Khách', 'Web', 'API', 'Kho', 'Cổng TT', 'Email'],
      // Labels at the room six parties leave: 13 characters a message, 9 a call to itself, one of
      // them on the last party, where it turns left (review, fix round 1).
      messages: [
        { from: 0, to: 1, label: '1. Đặt hàng' },
        { from: 1, to: 2, label: '2. POST /đơn' },
        { from: 2, to: 3, label: '3. Giữ hàng' },
        { from: 3, to: 2, label: '4. Đã giữ', reply: true },
        { from: 2, to: 4, label: '5. Trừ tiền' },
        { self: 4, label: '6. Mã OTP' },
        { from: 4, to: 2, label: '7. Thành công', reply: true },
        { from: 2, to: 5, label: '8. Hoá đơn' },
        { self: 5, label: '9. Ký số' },
        { from: 5, to: 0, label: '10. Gửi email' },
        { from: 2, to: 1, label: '11. Đơn xong', reply: true },
      ],
    },
  },
  tree: {
    comfortable: {
      root: 'Công ty Ánh Dương',
      heads: [
        { title: 'Kinh doanh', leaves: ['Bán lẻ', 'Doanh nghiệp', 'Xuất khẩu'] },
        { title: 'Vận hành', leaves: ['Kho vận', 'Mua hàng'] },
        { title: 'Công nghệ', leaves: ['Sản phẩm', 'Hạ tầng', 'Dữ liệu', 'Bảo mật'] },
      ],
    },
    extreme: {
      root: 'Tập đoàn Sao Mai',
      heads: ['Kinh doanh', 'Vận hành', 'Công nghệ', 'Tài chính', 'Nhân sự'].map((title, i) => ({
        title,
        // Ten characters, a leaf's room at five heads.
        leaves: Array.from({ length: 8 }, (_, j) => `Tổ ${i + 1}.${j + 1} Bắc`),
      })),
    },
  },
  mindmap: {
    comfortable: { centre: 'Ra mắt sản phẩm', branches: ['Khách hàng mục tiêu', 'Giá và gói', 'Kênh bán', 'Truyền thông', 'Ngân sách', 'Lịch trình'] },
    // Seven: the last beside the first, so it takes green rather than blue again.
    seven: { centre: 'Chuyến đi Đà Lạt', branches: ['Lịch trình', 'Đi lại', 'Chỗ ở', 'Ăn uống', 'Ngân sách', 'Hành lý', 'Thời tiết'] },
    extreme: { centre: 'Kế hoạch năm 2027', branches: ['Doanh thu', 'Khách hàng', 'Sản phẩm', 'Thương hiệu', 'Nhân sự', 'Tuyển dụng', 'Đào tạo', 'Công nghệ', 'Tài chính', 'Rủi ro'] },
  },
  pyramid: {
    comfortable: {
      funnel: false,
      bands: [
        { title: 'Tự thể hiện', note: ['Sáng tạo, phát huy hết khả năng'] },
        { title: 'Được tôn trọng', note: ['Ghi nhận, vị thế, tự tin'] },
        { title: 'Xã hội', note: ['Gia đình, bạn bè, thuộc về một nhóm'] },
        { title: 'An toàn', note: ['Việc làm ổn định, sức khoẻ,', 'nơi ở an toàn'] },
      ],
    },
    extreme: {
      funnel: true,
      bands: [
        { title: 'Truy cập', note: ['12.400 lượt (100 %)'] },
        { title: 'Xem hàng', note: ['7.900 lượt (64 %)'] },
        { title: 'Thêm giỏ', note: ['3.100 lượt (25 %)'] },
        { title: 'Thanh toán', note: ['1.800 lượt (15 %)'] },
        { title: 'Mua hàng', note: ['1.420 đơn (11 %)', 'giá trị trung bình 640.000 đ'] },
        { title: 'Mua lại', note: ['510 khách (4 %)'] },
        { title: 'Giới thiệu', note: ['130 khách (1 %)'] },
      ],
    },
  },
  cycle: {
    comfortable: { hub: 'PDCA', caption: 'Một vòng mỗi tháng, đo cuối kỳ', steps: [['1. Lập kế', 'hoạch'], ['2. Thực', 'hiện'], ['3. Kiểm', 'tra'], ['4. Cải tiến']] },
    extreme: { hub: 'Vòng đời sản phẩm', caption: 'Lặp lại mỗi quý', steps: [['Ý tưởng'], ['Thiết kế'], ['Làm mẫu'], ['Thử'], ['Đo'], ['Học'], ['Sửa'], ['Ra mắt']] },
  },
  venn: {
    // Four lines in every region, each region's longest line at its room (24, 11, 24).
    comfortable: { sets: ['Nhóm Thiết kế', 'Nhóm Kỹ thuật'], regions: { A: ['Nghiên cứu người dùng', 'Bản vẽ giao diện', 'Hệ thống màu và kiểu chữ', 'Hướng dẫn thương hiệu'], AB: ['Bản mẫu', 'Kiểm thử', 'Sửa lỗi', 'Đánh giá UX'], B: ['Máy chủ', 'Cơ sở dữ liệu', 'Triển khai', 'Giám sát và cảnh báo'] } },
    extreme: {
      sets: ['Kỹ năng', 'Đam mê', 'Thị trường cần'],
      // The most lines each region holds, the longest at its room: 4 alone (17, 17, 23), 3 in a pair (6), 1 in the middle (6).
      regions: { A: ['Kế toán', 'Phân tích số liệu', 'Viết báo cáo', 'Thuyết trình'], B: ['Âm nhạc', 'Du lịch', 'Nấu ăn', 'Chụp ảnh'], C: ['Chăm sóc người cao tuổi', 'Giáo dục trẻ em', 'Năng lượng sạch', 'Y tế cộng đồng'], AB: ['Viết', 'blog', 'nấu ăn'], AC: ['Nghề', 'tư vấn', 'thuế'], BC: ['Sứ', 'mệnh', 'xã hội'], ABC: ['Ikigai'] },
    },
  },
  stack: {
    comfortable: {
      layers: [
        { name: 'Giao diện', chips: ['Web', 'Ứng dụng di động', 'Trang quản trị'] },
        { name: 'API', chips: ['REST', 'Webhook'] },
        { name: 'Dịch vụ', chips: ['Đơn hàng', 'Thanh toán', 'Kho', 'Thông báo'] },
        { name: 'Dữ liệu', chips: ['PostgreSQL', 'Redis', 'Lưu tệp'] },
      ],
      bar: ['Bảo', 'mật'],
    },
    extreme: {
      layers: ['Người dùng', 'Giao diện', 'Cổng API', 'Dịch vụ', 'Hàng đợi', 'Dữ liệu', 'Hạ tầng', 'Mạng'].map((name, i) => ({ name, chips: Array.from({ length: 5 }, (_, j) => `Phần ${i + 1}.${j + 1}`) })),
      bar: null,
    },
  },
  // ── Task 4b. The extremes hold every text kind at its stated room, in Vietnamese. ──
  timeline: {
    comfortable: {
      items: [
        { date: 'Tháng 1/2027', title: 'Khởi động', note: ['Chốt phạm vi', 'và đội ngũ'], done: true },
        { date: 'Tháng 3/2027', title: 'Thiết kế', note: ['Bản mẫu và', 'thử với khách'], done: true },
        { date: 'Tháng 5/2027', title: 'Bản beta', note: ['200 khách', 'dùng thử'], now: true },
        { date: 'Tháng 8/2027', title: 'Ra mắt', note: ['Toàn quốc,', 'web và app'] },
        { date: 'Tháng 12/2027', title: 'Mở rộng', note: ['Thêm 3 thị', 'trường mới'] },
      ],
    },
    // Two rows of 6: a date 12 characters, a title 8, a note 10 a line.
    extreme: {
      items: [
        { date: 'Tháng 1/2026', title: 'Ý tưởng', note: ['Phỏng vấn', '40 khách'], done: true },
        { date: 'Tháng 2/2026', title: 'Thiết kế', note: ['Bản vẽ và', 'luồng mua'], done: true },
        { date: 'Tháng 3/2026', title: 'Làm mẫu', note: ['Chạy được', 'luồng đầu'], done: true },
        { date: 'Tháng 4/2026', title: 'Bản beta', note: ['Mời 50 hộ', 'dùng thử'], done: true },
        { date: 'Tháng 5/2026', title: 'Kiểm thử', note: ['Sửa 90 lỗi', 'trước khi'], done: true },
        { date: 'Tháng 6/2026', title: 'Ra mắt', note: ['Toàn quốc'], now: true },
        { date: 'Tháng 7/2026', title: 'Đo lường', note: ['Đo tỷ lệ', 'giữ chân'] },
        { date: 'Tháng 8/2026', title: 'Cải tiến', note: ['Thêm tính', 'năng nhóm'] },
        { date: 'Tháng 9/2026', title: 'Mở rộng', note: ['Hà Nội và', 'Đà Nẵng'] },
        { date: 'Th. 10/2026', title: 'Gọi vốn', note: ['Vòng A với', '3 quỹ'] },
        { date: 'Th. 11/2026', title: 'Bản 2.0', note: ['Viết lại', 'ứng dụng'] },
        { date: 'Th. 12/2026', title: 'Tổng kết', note: ['Kế hoạch', 'năm tới'] },
      ],
    },
    // Sixteen down one spine: a date 12, a title 64.
    vertical: {
      vertical: true,
      items: [
        ['Tháng 3/2011', 'Ba người mở xưởng in nhỏ ở quận 3'], ['2012', 'Khách hàng doanh nghiệp đầu tiên'], ['2013', 'Chuyển sang in kỹ thuật số'],
        ['2014', 'Mở chi nhánh thứ hai ở Đà Nẵng, tuyển thêm 40 kỹ sư và nhân viên'], ['2015', 'Ra mắt trang đặt in trực tuyến'], ['2016', 'Đạt 10.000 đơn hàng một năm'],
        ['2017', 'Nhà máy mới ở Bình Dương'], ['2018', 'Chứng nhận ISO 9001'], ['2019', 'Ứng dụng đặt in trên điện thoại'], ['2020', 'Giao trong ngày ở 5 thành phố'],
        ['2021', 'In bao bì thân thiện môi trường'], ['2022', 'Xuất khẩu sang Nhật Bản'], ['2023', 'Đạt 1 triệu khách hàng'], ['2024', 'Mở văn phòng ở Singapore'],
        ['2025', 'Gọi vốn vòng B'], ['Tháng 6/2026', 'Hôm nay: 420 nhân viên, 3 nhà máy'],
      ].map(([date, title], i) => ({ date, title, done: i < 15 })),
    },
    // A phone: 360 wide, the spine at x 104: a date 8, a title 25.
    narrow: {
      vertical: true,
      W: 360,
      items: [
        ['T1/2026', 'Phỏng vấn 40 khách'], ['T2/2026', 'Bản vẽ luồng mua hàng'], ['T3/2026', 'Bản mẫu chạy được'], ['T4/2026', 'Ra mắt bản beta cho khách'], ['T5/2026', 'Sửa 90 lỗi'],
        ['T6/2026', 'Ra mắt toàn quốc'], ['T8/2026', 'Thêm tính năng nhóm'], ['T9/2026', 'Mở văn phòng ở Đà Nẵng'], ['T10/2026', 'Gọi vốn vòng A, ba quỹ'], ['T12/2026', 'Tổng kết năm'],
      ].map(([date, title], i) => ({ date, title, done: i < 6 })),
    },
  },
  steps: {
    // Three a row: a title 21, a line 24.
    comfortable: {
      steps: [
        { title: 'Tải ứng dụng', lines: ['Tìm "Sổ Chi Tiêu" trên', 'App Store hoặc CH Play'] },
        { title: 'Tạo tài khoản', lines: ['Nhập email và mật khẩu,', 'rồi xác nhận qua thư'] },
        { title: 'Kết nối ngân hàng', lines: ['Chọn ngân hàng của bạn', 'và đăng nhập một lần là', 'xong, không cần nhập lại'] },
      ],
    },
    // Eight in two rows of 4: a title 14, three lines of 16.
    extreme: {
      steps: [
        { title: 'Chuẩn bị hồ sơ', lines: ['Giấy tờ tuỳ thân', 'của người đại', 'diện và các bên'] },
        { title: 'Điền mẫu đơn', lines: ['Theo mẫu của Sở', 'Kế hoạch và Đầu', 'tư nơi có trụ sở'] },
        { title: 'Nộp hồ sơ', lines: ['Nộp trực tuyến', 'qua cổng dịch vụ', 'công quốc gia'] },
        { title: 'Đóng lệ phí', lines: ['Chuyển khoản phí', '50.000 đồng và', 'giữ biên lai'] },
        { title: 'Nhận kết quả', lines: ['Sau 3 ngày làm', 'việc, qua email', 'và tại Sở'] },
        { title: 'Khắc con dấu', lines: ['Tự chọn mẫu dấu', 'và nơi khắc'] },
        { title: 'Mở tài khoản', lines: ['Tài khoản ngân', 'hàng mang tên', 'doanh nghiệp'] },
        { title: 'Khai thuế đầu', lines: ['Nộp tờ khai đầu', 'tiên trong 30', 'ngày'] },
      ],
    },
    // A phone: 360 wide, two a row (w 140): a title 13, a line 16.
    narrow: {
      W: 360,
      steps: [
        { title: 'Tải ứng dụng', lines: ['Từ App Store', 'hoặc CH Play'] },
        { title: 'Tạo tài khoản', lines: ['Email, mật khẩu', 'và mã xác nhận'] },
        { title: 'Bật thông báo', lines: ['Để biết khi nào', 'có hoá đơn mới', 'cần thanh toán'] },
        { title: 'Mời bạn bè', lines: ['Chia sẻ mã mời', 'để cùng nhận ưu', 'đãi tháng đầu'] },
      ],
    },
  },
  gantt: {
    comfortable: {
      head: 'Nửa đầu năm 2027',
      units: ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6'],
      rows: [
        { phase: true, name: 'Thiết kế', start: 0, length: 2 },
        { name: 'Nghiên cứu khách hàng', start: 0, length: 1, done: 1 },
        { name: 'Thiết kế giao diện', start: 0.5, length: 1.5, done: 0.6 },
        { phase: true, name: 'Xây dựng', start: 2, length: 3 },
        { name: 'Lập trình', start: 2, length: 2.5, done: 0.2 },
        { name: 'Kiểm thử', start: 4, length: 1 },
        { name: 'Ra mắt', at: 5 },
      ],
      now: { at: 2.5, label: 'Hôm nay' },
    },
    // Twelve weeks, twelve rows: a task 24, a phase 22, the head 24, a week's label 4; today past 660.
    extreme: {
      head: 'Ngày đầu từng tuần, 2027',
      units: ['1/3', '8/3', '15/3', '22/3', '29/3', '5/4', '12/4', '19/4', '26/4', '3/5', '10/5', '17/5'],
      rows: [
        { phase: true, name: 'Giai đoạn 1: Thiết kế', start: 0, length: 4 },
        { name: 'Phỏng vấn 20 khách hàng', start: 0, length: 2, done: 1 },
        { name: 'Thiết kế giao diện mới', start: 1.5, length: 2.5, done: 1 },
        { phase: true, name: 'Giai đoạn 2: Làm và đo', start: 4, length: 6 },
        { name: 'Viết nội dung trang chủ', start: 4, length: 2, done: 1 },
        { name: 'Kết nối cổng thanh toán', start: 5, length: 3, done: 0.7 },
        { name: 'Kiểm thử trên điện thoại', start: 7, length: 2, done: 0.3 },
        { name: 'Chạy thử với 50 khách', start: 8.5, length: 1.5 },
        { phase: true, name: 'Giai đoạn 3: Ra mắt', start: 10, length: 2 },
        { name: 'Sửa lỗi và hoàn thiện', start: 10, length: 1.5 },
        { name: 'Quảng cáo trên mạng', start: 10.5, length: 1.5 },
        { name: 'Ra mắt chính thức', at: 11 },
      ],
      now: { at: 11.5, label: 'Hôm nay' },
    },
  },
  journey: {
    comfortable: {
      stages: ['Nhận biết', 'Cân nhắc', 'Mua hàng', 'Sử dụng', 'Giới thiệu'],
      lanes: [
        { name: 'Khách làm gì', cells: [['Thấy quảng', 'cáo trên mạng'], ['So giá ba', 'cửa hàng'], ['Đặt qua app,', 'trả góp 0 %'], ['Dùng hằng ngày'], ['Kể với bạn bè']] },
        { name: 'Cảm xúc', feelings: [{ s: 1, word: 'Tò mò' }, { s: -1, word: 'Phân vân' }, { s: 0, word: 'Hồi hộp' }, { s: -2, word: 'Bực vì chờ lâu' }, { s: 2, word: 'Hài lòng' }] },
        { name: 'Điểm nghẽn', tone: 'pain', cells: [['Quảng cáo', 'quá chung'], ['Không rõ', 'phí giao'], ['Chờ 5 ngày', 'mới có hàng'], ['Thiếu hướng', 'dẫn dùng'], ['Không có', 'mã giới thiệu']] },
      ],
    },
    // Six stages, three lanes and the feelings (H 532): a stage 8, a cell 11 a line, a word 13.
    extreme: {
      stages: ['Biết đến', 'Tìm hiểu', 'Đặt mua', 'Chờ hàng', 'Dùng thử', 'Lan toả'],
      lanes: [
        { name: 'Khách làm gì', cells: [['Xem video', 'trên mạng'], ['So giá ba', 'cửa hàng'], ['Đặt qua app', 'trả góp 0 %'], ['Hỏi đơn đã', 'đi tới đâu'], ['Mở hộp, cài', 'đặt máy'], ['Viết đánh', 'giá 5 sao']] },
        { name: 'Cảm xúc', feelings: [{ s: 1, word: 'Tò mò' }, { s: -1, word: 'Phân vân giá' }, { s: 1, word: 'Yên tâm' }, { s: -2, word: 'Sốt ruột' }, { s: 2, word: 'Vui, dễ dùng' }, { s: 2, word: 'Tự hào kể lại' }] },
        { name: 'Điểm nghẽn', tone: 'pain', cells: [['Quảng cáo', 'quá chung'], ['Không rõ', 'phí ship'], ['Mã giảm giá', 'bị lỗi'], ['Chờ 5 ngày', 'mới có hàng'], ['Sách hướng', 'dẫn khó đọc'], ['Không có', 'quà tặng']] },
        { name: 'Cơ hội', tone: 'idea', cells: [['Video ngắn,', 'dễ chia sẻ'], ['Bảng giá rõ', 'ngay đầu'], ['Kiểm tra mã', 'khi nhập'], ['Gửi mã theo', 'dõi đơn'], ['Video cài', 'đặt 1 phút'], ['Thưởng khi', 'giới thiệu']] },
      ],
    },
  },
  compare: {
    comfortable: {
      points: ['Giá mỗi tháng', 'Số người dùng', 'Dung lượng', 'Hỗ trợ', 'Xuất báo cáo', 'Dùng thử'],
      best: 1,
      options: [
        { name: 'Cơ bản', sub: 'cho một người', values: ['99.000 đ', '1', '5 GB', 'Qua email', { text: '—', tone: 'no' }, '14 ngày'] },
        { name: 'Đội nhóm', sub: 'nhiều người chọn', values: ['249.000 đ', 'Tối đa 10', '100 GB', 'Trong ngày', { text: '✓ Có', tone: 'yes' }, '30 ngày'] },
        { name: 'Doanh nghiệp', sub: 'cho công ty lớn', values: ['Theo báo giá', 'Không giới hạn', '1 TB', 'Đội riêng 24/7', { text: '✓ Có', tone: 'yes' }, '30 ngày'] },
      ],
    },
    // Four options, ten rows: a point 20, a name 9, a sub 11, a value 12.
    extreme: {
      points: ['Giá mỗi tháng', 'Số người dùng', 'Dung lượng lưu trữ', 'Hỗ trợ khách hàng', 'Xuất báo cáo', 'Đăng nhập một lần', 'Lịch sử phiên bản', 'Quyền quản trị viên', 'Kết nối với ứng dụng', 'Thời gian dùng thử'],
      best: 2,
      options: ['Khởi đầu', 'Cơ bản', 'Đội nhóm', 'Toàn diện'].map((name, i) => ({
        name,
        sub: ['miễn phí', '99.000 đ/th', '249.000/th', 'Gọi báo giá'][i],
        values: [
          ['0 đ', '99.000 đ', '249.000 đ', 'Theo báo giá'][i], ['1', 'Tối đa 3', 'Tối đa 10', 'Vô hạn'][i], ['1 GB', '5 GB', '100 GB', '1 TB'][i], ['Diễn đàn', 'Qua email', 'Trong ngày', 'Trong 2 giờ'][i],
          ...[[0, 0, 1, 1], [0, 0, 0, 1], [0, 1, 1, 1], [0, 0, 1, 1]].map((row) => (row[i] ? { text: '✓ Có', tone: 'yes' } : { text: '—', tone: 'no' })),
          ['5 ứng dụng', '20 ứng dụng', 'Vô hạn', 'Vô hạn'][i], ['—', '14 ngày', '30 ngày', '30 ngày'][i],
        ],
      })),
    },
    // Cards, no points column, three of them: a name 21, a sub 25, a value 25.
    cards: {
      points: null,
      best: 1,
      options: [
        { name: 'Gói tự làm', sub: 'Phù hợp người làm tự do', values: ['✓ Mẫu hoá đơn có sẵn', '✓ Lưu 30 ngày lịch sử', '— Không có hỗ trợ riêng'] },
        { name: 'Gói cửa hàng nhỏ', sub: 'Cửa hàng có 1–5 nhân viên', values: ['✓ Bán hàng tại quầy', '✓ Kết nối máy in hoá đơn', '✓ Hỗ trợ email trong 2h'] },
        { name: 'Gói chuỗi cửa hàng', sub: 'Mọi điểm bán, một sổ sách', values: ['✓ Báo cáo theo từng điểm', '✓ Phân quyền nhân viên', '✓ Người hỗ trợ riêng 24/7'] },
      ],
    },
  },
  matrix: {
    comfortable: {
      axes: { yName: 'Tác động ↑', yHigh: 'Cao', yLow: 'Thấp', xLow: 'Thấp', xHigh: 'Cao', xName: 'Công sức →' },
      quads: [
        { title: 'Làm ngay', fam: 1, items: ['Email nhắc giỏ hàng bỏ quên', 'Nút đặt lại đơn cũ', 'Ảnh sản phẩm rõ hơn'] },
        { title: 'Lên kế hoạch', fam: 0, items: ['Ứng dụng di động riêng', 'Chương trình khách thân thiết'] },
        { title: 'Giao bớt', fam: 3, items: ['Trả lời bình luận', 'Đăng bài định kỳ', 'Cập nhật giá'] },
        { title: 'Bỏ qua', fam: 6, items: ['Làm lại toàn bộ logo', 'Kênh TikTok thứ hai'] },
      ],
    },
    // Seven items a quadrant, the longest 34 characters after its "• ": every room at its limit.
    extreme: {
      axes: { yName: 'Tác động tới doanh thu quý tới (↑ cao)', yHigh: 'Rất cao', yLow: 'Rất thấp', xLow: 'Thấp: làm trong một tuần, một người', xHigh: 'Cao: cần cả đội, hơn một quý mới xong', xName: 'Công sức bỏ ra, tính bằng số người nhân với số tuần làm, từ thấp đến cao →' },
      quads: [
        { title: 'Làm ngay: nhanh mà hiệu quả cao', fam: 1, items: ['Email nhắc khách bỏ quên giỏ hàng', 'Thêm nút đặt lại đơn cũ trên app', 'Rút gọn biểu mẫu thanh toán, 3 ô', 'Hiện phí giao hàng ngay trang đầu', 'Ảnh sản phẩm chụp lại, nền trắng', 'Mã giảm giá cho lần mua thứ hai', 'Trả lời tin nhắn trong vòng 1 giờ'] },
        { title: 'Lên kế hoạch: đáng đầu tư dài', fam: 0, items: ['Ứng dụng di động riêng cho khách', 'Chương trình khách hàng thân thiết', 'Kho hàng thứ hai ở miền Trung', 'Giao hàng trong 2 giờ ở Hà Nội', 'Tự động gợi ý sản phẩm phù hợp', 'Thanh toán trả góp qua thẻ tín', 'Kết nối với sàn thương mại điện'] },
        { title: 'Giao bớt: cần làm, ít tác động', fam: 3, items: ['Trả lời bình luận trên mạng xã hội', 'Đăng bài đều đặn mỗi tuần hai lần', 'Cập nhật giá theo đối thủ mỗi tuần', 'Gửi bản tin tháng cho khách cũ', 'Chụp ảnh hậu trường cho fanpage', 'Lọc đánh giá spam trên trang bán', 'Sắp xếp lại danh mục trên website'] },
        { title: 'Bỏ qua: tốn công, ít lợi ích', fam: 6, items: ['Làm lại toàn bộ logo và nhận diện', 'Mở thêm kênh TikTok thứ hai riêng', 'Tự viết phần mềm kế toán nội bộ', 'Dịch website sang năm thứ tiếng', 'Mở cửa hàng thật ở trung tâm', 'Tổ chức sự kiện ra mắt rất lớn', 'Thiết kế lại bao bì cho mọi dòng'] },
      ],
    },
  },
  sides: {
    comfortable: {
      verdict: 'Nên làm, nếu giữ được 2 ngày văn phòng mỗi tuần để cả nhóm gặp nhau',
      sides: [
        { title: 'Ưu điểm', fam: 1, mark: '+', points: [['Bớt 1 giờ đi lại mỗi ngày'], ['Tiết kiệm tiền thuê văn phòng'], ['Tuyển được người ở tỉnh khác'], ['Tập trung hơn khi làm việc sâu']] },
        { title: 'Nhược điểm', fam: 4, mark: '−', points: [['Khó trao đổi nhanh khi gặp lỗi'], ['Người mới hoà nhập chậm hơn'], ['Ranh giới giờ làm bị mờ đi']] },
      ],
    },
    // Before and after, with the arrow: twelve one-line points (the most a verdict leaves room
    // for), two-line points on the right; a title 29, a point 36 a line, the verdict 83.
    extreme: {
      arrow: true,
      verdict: 'Nên chuyển hẳn sang phần mềm: sau 3 tháng đã hoàn vốn nhờ bớt 2 ngày công mỗi tháng',
      sides: [
        { title: 'Trước khi có phần mềm kế toán', fam: 6, mark: '•', points: [
          ['Đối chiếu sổ ngân hàng mất 2 ngày'], ['Nhập tay từng hoá đơn vào bảng tính'], ['Báo cáo tháng xong vào ngày mùng 10'], ['Sai số liệu khi copy giữa các file'],
          ['Không biết tồn kho thật cuối ngày'], ['Mỗi chi nhánh giữ một file riêng'], ['Tìm hoá đơn cũ mất cả buổi sáng'], ['Kế toán nghỉ là không ai làm thay'],
          ['Không có lịch sử ai đã sửa số liệu'], ['Thuế cuối năm phải làm thêm giờ'], ['Giám đốc chờ số liệu để quyết định'], ['Khách hỏi công nợ phải hẹn hôm sau'],
        ] },
        { title: 'Sau 3 tháng dùng phần mềm', fam: 1, mark: '•', points: [
          ['Đối chiếu ngân hàng tự động mỗi đêm,', 'chỉ còn duyệt các khoản lệch'], ['Hoá đơn điện tử tự vào sổ'], ['Báo cáo tháng có ngay ngày mùng 1'],
          ['Một sổ chung cho cả ba chi nhánh,', 'phân quyền theo từng người'], ['Tồn kho cập nhật theo từng đơn'], ['Tìm mọi hoá đơn trong vài giây'],
          ['Ghi lại ai sửa gì, lúc nào'], ['Tờ khai thuế lập sẵn từ sổ sách'], ['Công nợ khách xem ngay trên di động'],
        ] },
      ],
    },
  },
  kpi: {
    comfortable: {
      cards: [
        { label: 'Doanh thu T11', value: '1,24 tỷ', change: '▲ 9 % so với T10', good: true, spark: [0.82, 0.9, 0.95, 1.02, 1.1, 1.24] },
        { label: 'Đơn hàng', value: '3.480', change: '▲ 5 % so với T10', good: true, spark: [3010, 3150, 3100, 3290, 3310, 3480] },
        { label: 'Tiền quảng cáo', value: '96 tr', change: '▼ 8 % so với T10', good: true, spark: [120, 115, 110, 108, 104, 96] },
        { label: 'Tỷ lệ hoàn hàng', value: '4,1 %', change: '▲ 0,6 điểm', good: false, spark: [3.2, 3.4, 3.3, 3.6, 3.5, 4.1] },
      ],
    },
    // Twelve in three rows of 4: a label 15, a value 7, a change 16.
    extreme: {
      cards: [
        ['Doanh thu tháng', '1,24 tỷ', '▲ 7 % so với T10', true], ['Lợi nhuận gộp', '412 tr', '▲ 9 % so với T10', true], ['Đơn hàng', '3.480', '▲ 5 % so với T10', true], ['Giá trị đơn TB', '356.000', '▲ 6 % so với T10', true],
        ['Khách hàng mới', '1.120', '▲ 8 % so với T10', true], ['Khách quay lại', '41 %', '▲ 3 điểm so T10', true], ['Chi phí QC', '96 tr', '▼ 8 % so với T10', true], ['Chi phí một đơn', '27.600', '▼ 4 % so với T10', true],
        ['Tỷ lệ hoàn hàng', '4,1 %', '▲ 0,6 điểm', false], ['Thời gian giao', '67 giờ', 'không đổi', null], ['Điểm hài lòng', '4,6/5', '▲ 0,2 so với T10', true], ['Tồn kho chậm', '182 tr', '▲ 5 % so với T10', false],
      ].map(([label, value, change, good], k) => ({ label, value, change, good, spark: Array.from({ length: 6 }, (_, j) => (good === null ? 1 : 1 + ((j * (k + 3)) % 5) + j)) })),
    },
    // A phone: 360 wide, two a row (w 148): a label 13, a value 6, a change 15.
    narrow: {
      W: 360,
      cards: [
        ['Doanh thu T11', '1,2 tỷ', '▲ 12 % so T10', true], ['Đơn hàng', '3.480', '▲ 5 % so T10', true], ['Chi phí QC', '96 tr', '▼ 8 % so T10', true],
        ['Khách quay về', '41 %', '▲ 3 điểm so T10', true], ['Tỷ lệ hoàn', '4,1 %', '▲ 0,6 điểm', false], ['Ngày giao TB', '2,8', 'không đổi', null],
      ].map(([label, value, change, good]) => ({ label, value, change, good, spark: [3, 4, 3, 5, 6, 7] })),
    },
  },
  panel: {
    comfortable: {
      big: '62 %',
      say: ['khách mua lần hai trong vòng 30 ngày', 'khi được nhắc bằng email cá nhân'],
      facts: [
        { share: 0.62, value: '62 %', title: 'Mua lần hai', lines: ['trong 30 ngày, có email', 'nhắc theo tên khách'] },
        { share: 0.35, value: '35 %', title: 'Không có email nhắc', lines: ['cùng kỳ năm ngoái'] },
        { share: 0.81, value: '81 %', title: 'Mở email nhắc', lines: ['trong 24 giờ đầu'] },
      ],
      source: 'Nguồn: dữ liệu 1.200 đơn hàng của cửa hàng, tháng 7 đến tháng 10/2026',
    },
    // Four facts, one whole (100 %), one not a share: the big number 6, the statement 45 a line,
    // a ring's value 6, a title 17, a line 20, the source 96.
    extreme: {
      big: '1,2 tỷ',
      say: ['doanh thu thêm mỗi quý nhờ nhắc khách mua lại', 'bằng email và tin nhắn theo tên từng người'],
      facts: [
        { share: 0.625, value: '62,5 %', title: 'Mua lần hai sau', lines: ['email nhắc cá nhân', 'trong vòng 30 ngày'] },
        { share: 1, value: '100 %', title: 'Đơn có mã giảm', lines: ['đều dùng hết mã', 'trước khi hết hạn'] },
        { share: 0.35, value: '35 %', title: 'Mở tin nhắn Zalo', lines: ['trong giờ đầu tiên'] },
        { share: null, value: '4,8/5', title: 'Điểm hài lòng', lines: ['trên 860 lượt chấm', 'của khách mua lại'] },
      ],
      source: 'Nguồn: 1.200 đơn và 860 phiếu khảo sát khách hàng của cửa hàng, từ tháng 7 đến tháng 10/2026',
    },
  },
  labelled: {
    // A phone, six parts named.
    comfortable: {
      parts: [
        { x: 300, y: 24, w: 120, h: 240, rx: 20, fill: 'tint', rim: 'stroke' },
        { x: 308, y: 48, w: 104, h: 184, rx: 4, fill: 'card', rim: 'edge' },
        { x: 316, y: 64, w: 88, h: 32, rx: 6, fill: 'tint', rim: 'stroke' },
        { x: 340, y: 244, w: 40, h: 6, rx: 3, fill: 'stroke', rim: 'stroke' },
        { x: 420, y: 80, w: 4, h: 32, rx: 2, fill: 'stroke', rim: 'stroke' },
      ],
      rounds: [{ cx: 360, cy: 36, r: 4, fill: 'stroke', rim: 'stroke' }],
      points: [
        { px: 330, py: 80, name: 'Thông báo', note: 'Tin mới, vuốt để xem' },
        { px: 320, py: 180, name: 'Màn hình cảm ứng', note: '6,1 inch, chạm hai lần' },
        { px: 350, py: 247, name: 'Thanh vuốt', note: 'Vuốt lên để về trang chủ' },
        { px: 364, py: 36, name: 'Camera trước', note: '12 MP, mở khoá bằng mặt' },
        { px: 424, py: 96, name: 'Nút nguồn', note: 'Giữ 3 giây để tắt' },
        { px: 420, py: 200, name: 'Khung nhôm', note: 'Chống nước IP68' },
      ],
    },
    // A web page's areas, five a side, each name 22 and note 27.
    extreme: {
      parts: [
        { x: 248, y: 24, w: 224, h: 360, rx: 8, fill: 'card', rim: 'edge' },
        { x: 260, y: 36, w: 200, h: 16, rx: 8, fill: 'ground', rim: 'edge' },
        { x: 260, y: 64, w: 200, h: 24, rx: 4, fill: 'tint', rim: 'stroke' },
        { x: 260, y: 96, w: 200, h: 80, rx: 4, fill: 'tint', rim: 'stroke' },
        { x: 280, y: 148, w: 160, h: 16, rx: 8, fill: 'card', rim: 'edge' },
        { x: 260, y: 184, w: 56, h: 128, rx: 4, fill: 'ground', rim: 'edge' },
        { x: 324, y: 184, w: 64, h: 60, rx: 4, fill: 'card', rim: 'stroke' },
        { x: 396, y: 184, w: 64, h: 60, rx: 4, fill: 'card', rim: 'stroke' },
        { x: 324, y: 252, w: 64, h: 60, rx: 4, fill: 'card', rim: 'stroke' },
        { x: 396, y: 252, w: 64, h: 60, rx: 4, fill: 'card', rim: 'stroke' },
        { x: 260, y: 320, w: 200, h: 52, rx: 4, fill: 'tint', rim: 'stroke' },
      ],
      rounds: [{ cx: 272, cy: 76, r: 6, fill: 'stroke', rim: 'stroke' }],
      points: [
        { px: 300, py: 44, name: 'Thanh địa chỉ website', note: 'Tên miền riêng, khoá HTTPS' },
        { px: 272, py: 76, name: 'Logo của cửa hàng', note: 'Bấm vào để về trang chủ' },
        { px: 300, py: 120, name: 'Ảnh lớn đầu trang chủ', note: 'Một câu nói rõ bạn bán gì' },
        { px: 288, py: 248, name: 'Cột bộ lọc ở phía trái', note: 'Lọc theo giá, cỡ và màu sắc' },
        { px: 300, py: 346, name: 'Chân trang thông tin', note: 'Địa chỉ, giờ mở cửa, số máy' },
        { px: 440, py: 76, name: 'Menu chính của trang', note: 'Tối đa năm mục, ngắn gọn rõ' },
        { px: 420, py: 156, name: 'Ô tìm kiếm sản phẩm', note: 'Gợi ý ngay khi gõ chữ đầu' },
        { px: 428, py: 214, name: 'Thẻ sản phẩm nổi bật', note: 'Ảnh, giá, nút thêm vào giỏ' },
        { px: 428, py: 282, name: 'Thẻ sản phẩm mới về', note: 'Nhãn "Mới" trong 7 ngày đầu' },
        { px: 440, py: 346, name: 'Liên kết chính sách', note: 'Đổi trả và bảo hành' },
      ],
    },
  },
};

section('a mind map\'s neighbours never share a family, all the way round');
{
  // Its branches stand in a ring, so the last sits beside the first (review, Task 4).
  const clash = [];
  for (let n = 3; n <= 10; n += 1) for (let i = 0; i < n; i += 1) if (ringFam(n, i) === ringFam(n, (i + 1) % n)) clash.push(`${n} branches: ${i + 1} and ${((i + 1) % n) + 1}`);
  check('from 3 to 10 branches, every two side by side differ', clash.length === 0, clash.join(', '));
  const said = textOf('builtin:svg-structures');
  check('  and the recipe says the seventh of seven takes green', /with 7 the seventh takes green/.test(said) && PAL.light.fam[ringFam(7, 6)]?.name === 'green');
}

section('every recipe gives what a recipe must, and its skeleton fills into a drawing the check passes');
const shots = [];
for (const [id, names] of Object.entries(RECIPES)) {
  const text = textOf(id);
  for (const name of names) {
    const skeleton = recipeOf(text, name);
    check(`${id} ${name}: a skeleton between its markers`, !!skeleton);
    if (!skeleton) continue;
    // The recipe's text runs from its marker to the next recipe's heading.
    const start = text.lastIndexOf('\n## ', text.indexOf(`<!-- recipe:${name} -->`));
    const end = text.indexOf('\n## ', text.indexOf(`<!-- recipe:${name} -->`));
    const own = text.slice(start, end < 0 ? text.length : end);
    const parts = ['Use it', 'Many', 'Long text', 'Narrow', 'Dark', 'Polish', 'Pitfalls'];
    const missing = parts.filter((p) => !own.includes(`${p}`));
    check('  it says when to use it, the arithmetic, the four adaptive rules, the polish and the pitfalls', missing.length === 0 && /[=×+]/.test(own), missing.join(', '));
    check('  the skeleton is a whole drawing on the 720 canvas, in system-ui', skeleton.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 ') && skeleton.includes('font-family="system-ui, sans-serif"') && skeleton.endsWith('</svg>'));
    check('  nothing turned or slanted, so every position can be checked', !/rotate|skew|matrix/.test(skeleton));
    const arrows = /marker-end/.test(skeleton);
    check(`  ${arrows ? 'exactly one <marker>, in <defs>' : 'no arrowheads, so no marker'}`, arrows ? (skeleton.match(/<marker\b/g) || []).length === 1 && /<defs><marker\b/.test(skeleton) : !/<marker\b/.test(skeleton));
    for (const [size, sample] of Object.entries(SAMPLES[name] || {})) {
      for (const theme of ['light', 'dark']) {
        const label = `  ${size}, ${theme}`;
        let svg = '';
        let filled;
        try {
          filled = FILL[name](PAL[theme], sample, theme);
          svg = fill(skeleton, filled.top, filled.each);
          // A Narrow fill is the same skeleton drawn 360 wide.
          if (filled.W && filled.W !== 720) svg = svg.replace('viewBox="0 0 720 ', `viewBox="0 0 ${filled.W} `);
        } catch (err) {
          check(`${label}: filled`, false, err.message);
          continue;
        }
        const left = svg.match(/\{[A-Za-z][A-Za-z0-9]*\}/g);
        const xml = wellFormed(svg);
        const sizes = [13, ...[...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]))];
        const smallest = Math.min(...sizes);
        // The scale it is shown at, at worst: the whole canvas, fitted into the column and the
        // height cap of an 800 px window. The page fits it to what is drawn, which is no larger.
        const phone = filled.W === 360;
        const shown = Math.min((phone ? PHONE : DRAWING_FIT.column) / (filled.W || 720), (DRAWING_FIT.heightShare * DRAWING_FIT.window) / filled.H);
        const floor = phone ? DRAWING_FIT.readablePx : 12;
        const { issues, canvas } = checkDiagram(svg);
        const blind = blindSpots(name, svg);
        const ok = !left && !xml && filled.H <= 560 && smallest * shown >= floor && issues.length === 0 && canvas === theme && blind.length === 0;
        check(`${label}: ${phone ? '360 wide, ' : ''}${filled.H} tall, smallest text ${num(smallest * shown)} px as shown${phone ? ' on a phone' : ''}, nothing for the check to find, nor where it cannot look`, ok,
          [left && `left unfilled: ${left.join(' ')}`, xml, filled.H > 560 && `H ${filled.H}`, smallest * shown < floor && `text ${num(smallest * shown)} px`, canvas !== theme && `read as ${canvas}`, ...issues, ...blind].filter(Boolean).join(' | '));
        shots.push({ name: `${name}-${size}-${theme}`, svg, theme });
      }
    }
  }
}

// Every room a sequences or layouts recipe states, filled to the letter, as the review filled
// Task 4's (review, fix round 1: stated rooms overflowed at their maximum): each text exactly as
// long as its room, at every count the recipe gives a figure for, each at its most lines and rows.
section('every room a sequences or layouts recipe states holds a text exactly that long');
{
  const chars = (n) => {
    const s = 'Đủ chữ thử nghiệm '.repeat(Math.ceil(n / 9) + 1).slice(0, n);
    return s.endsWith(' ') ? `${s.slice(0, -1)}ạ` : s;
  };
  const times = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const ganttAt = (u, roomUnit) => ({
    head: chars(24),
    units: times(u, () => chars(roomUnit)),
    rows: times(11, (i) => (i % 4 === 0 ? { phase: true, name: chars(22), start: 0, length: u / 2 } : { name: chars(24), start: (i % u) / 2, length: 1, done: 0.5 })).concat([{ name: chars(24), at: u / 2 }]),
    now: { at: u - 0.25, label: 'Hôm nay' },
  });
  const journeyAt = (n, [stage, cell, word]) => ({
    stages: times(n, () => chars(stage)),
    lanes: [
      { name: chars(40), cells: times(n, () => [chars(cell), chars(cell)]) },
      { name: chars(40), feelings: times(n, (i) => ({ s: [2, -2, 0, 1, -1, 2][i], word: chars(word) })) },
      { name: chars(40), tone: 'pain', cells: times(n, () => [chars(cell), chars(cell)]) },
      { name: chars(40), tone: 'idea', cells: times(n, () => [chars(cell), chars(cell)]) },
    ],
  });
  const compareAt = (k, table, [name, sub, value]) => ({
    points: table ? times(10, () => chars(20)) : null,
    best: 1,
    options: times(k, () => ({ name: chars(name), sub: chars(sub), values: times(10, () => chars(value)) })),
  });
  const kpiAt = (n, [label, value, change], W) => ({ W, cards: times(n, (k) => ({ label: chars(label), value: chars(value), change: chars(change), good: [true, false, null][k % 3], spark: [1, 3, 2, 5, 4, 6] })) });
  const panelAt = (k, [title, line]) => ({ big: chars(6), say: [chars(45), chars(45)], facts: times(k, (i) => ({ share: [0.62, 1, null, 0.35][i], value: chars(6), title: chars(title), lines: [chars(line), chars(line)] })), source: chars(96) });
  const ROOMS = {
    timeline: [
      ['6 a row, 12 in two rows: a date 12, a title 8, a note 10', { items: times(12, (i) => ({ date: chars(12), title: chars(8), note: [chars(10), chars(10)], done: i < 5 })) }],
      ['4 a row: a date 19, a title 15, a note 17', { items: times(8, () => ({ date: chars(19), title: chars(15), note: [chars(17), chars(17)] })) }],
      ['3 a row: a title 20, a note 24', { items: times(3, () => ({ date: chars(19), title: chars(20), note: [chars(24), chars(24)] })) }],
      ['16 down the spine: a date 12, a title 64', { vertical: true, items: times(16, () => ({ date: chars(12), title: chars(64) })) }],
      ['a phone, 16: a date 8, a title 25', { vertical: true, W: 360, items: times(16, () => ({ date: chars(8), title: chars(25) })) }],
    ],
    steps: [
      ['2: a title 35, a line 41', { steps: times(2, () => ({ title: chars(35), lines: times(3, () => chars(41)) })) }],
      ['3: a title 21, a line 24', { steps: times(3, () => ({ title: chars(21), lines: times(3, () => chars(24)) })) }],
      ['8 in rows of 4: a title 14, a line 16', { steps: times(8, () => ({ title: chars(14), lines: times(3, () => chars(16)) })) }],
      ['a phone, 4: a title 13, a line 16', { W: 360, steps: times(4, () => ({ title: chars(13), lines: times(3, () => chars(16)) })) }],
    ],
    gantt: [[4, 16], [6, 10], [8, 7], [12, 4]].map(([u, room]) => [`${u} units, 12 rows: a unit ${room}, a task 24, a phase 22, the head 24`, ganttAt(u, room)]),
    journey: [[3, [22, 27, 29]], [4, [15, 19, 21]], [5, [11, 14, 16]], [6, [8, 11, 13]]].map(([n, r]) => [`${n} stages, 3 lanes and the feelings: a stage ${r[0]}, a cell ${r[1]}, a word ${r[2]}`, journeyAt(n, r)]),
    compare: [[3, true, [14, 17, 18]], [4, true, [9, 11, 12]], [3, false, [21, 25, 25]], [4, false, [14, 17, 17]]].map(([k, table, r]) => [`${k} ${table ? 'in a table' : 'cards'}, 10 rows: a name ${r[0]}, a sub ${r[1]}, a value ${r[2]}${table ? ', a point 20' : ''}`, compareAt(k, table, r)]),
    matrix: [['7 items of 36 a quadrant, a title 31, the axes 8, 40, 40 and 77', {
      axes: { yName: chars(40), yHigh: chars(8), yLow: chars(8), xLow: chars(40), xHigh: chars(40), xName: chars(77) },
      quads: [1, 0, 3, 6].map((f) => ({ title: chars(31), fam: f, items: times(7, () => chars(34)) })),
    }]],
    sides: [
      ['12 one-line points a side and the verdict: a title 29, a point 36, the verdict 83', { arrow: true, verdict: chars(83), sides: [1, 4].map((f) => ({ title: chars(29), fam: f, mark: '+', points: times(12, () => [chars(36)]) })) }],
      ['two-line points of 36, no verdict', { sides: [6, 1].map((f) => ({ title: chars(29), fam: f, mark: '•', points: times(8, () => [chars(36), chars(36)]) })) }],
    ],
    kpi: [
      ['2 a row: a label 39, a value 17, a change 39', kpiAt(2, [39, 17, 39])],
      ['3 a row: a label 23, a value 10, a change 24', kpiAt(3, [23, 10, 24])],
      ['12 in rows of 4: a label 15, a value 7, a change 16', kpiAt(12, [15, 7, 16])],
      ['a phone, 6 two a row: a label 13, a value 6, a change 15', kpiAt(6, [13, 6, 15], 360)],
    ],
    panel: [[2, [37, 43]], [3, [23, 27]], [4, [17, 20]]].map(([k, r]) => [`${k} facts: a title ${r[0]}, a line ${r[1]}; the number 6, the statement 45, a value 6, the source 96`, panelAt(k, r)]),
    labelled: [['5 a side: a name 22, a note 27', { ...SAMPLES.labelled.extreme, points: SAMPLES.labelled.extreme.points.map((p) => ({ ...p, name: chars(22), note: chars(27) })) }]],
  };
  for (const [name, list] of Object.entries(ROOMS)) {
    const id = Object.keys(RECIPES).find((k) => RECIPES[k].includes(name));
    const skeleton = recipeOf(textOf(id), name);
    for (const [what, sample] of list) {
      let svg = '';
      let filled = { H: 0 };
      try {
        filled = FILL[name](PAL.light, sample, 'light');
        svg = fill(skeleton, filled.top, filled.each);
        if (filled.W && filled.W !== 720) svg = svg.replace('viewBox="0 0 720 ', `viewBox="0 0 ${filled.W} `);
      } catch (err) {
        check(`${name}, ${what}`, false, err.message);
        continue;
      }
      const found = [...checkDiagram(svg).issues, ...blindSpots(name, svg)];
      check(`${name}, ${what} (H ${filled.H})`, filled.H <= 560 && found.length === 0, found.slice(0, 4).join(' | '));
      shots.push({ name: `rooms-${name}-${what.split(':')[0].replace(/[^a-z0-9]+/gi, '-')}`, svg, theme: 'light' });
    }
  }
}

section('the fills are judged, not waved through');
{
  // The same decision flow, its first exit stopped 40 px short of the outcome it points at, and
  // a question line pushed over the step above it: the check must find both.
  const good = shots.find((s) => s.name === 'decision-comfortable-light')?.svg || '';
  const short = good.replace(/(<path d="M300 [\d.]+H)440"/, '$1400"');
  check('an arrow stopped short of its box is caught', short !== good && checkDiagram(short).issues.some((i) => /points at nothing/.test(i)), checkDiagram(short).issues[0] || 'nothing found');
  const crowded = good.replace(/(<text x="200" y=")([\d.]+)(" font-weight="600" fill="#1E40AF">)/, (m, a, y, b) => `${a}${Number(y) - 40}${b}`);
  check('a text pushed onto another is caught', crowded !== good && checkDiagram(crowded).issues.length > 0, checkDiagram(crowded).issues[0] || 'nothing found');
  // Where the checker cannot look (review, fix round 1), the geometry above must catch the same
  // faults the reviewer drew: a call to itself on the last party not turned left, a Venn line
  // past its room, a caption long enough to reach a stage, a label over a lifeline.
  const svgOf = (n) => shots.find((s) => s.name === n)?.svg || '';
  const seq = svgOf('sequence-extreme-light');
  const unturned = seq.replace(/(<text x=")([\d.]+)(" y="[\d.]+" text-anchor=")end(" font-size="12.5">9\. Ký số<\/text>)/, (m, a, x, b, c) => `${a}${Number(x) + 72}${b}start${c}`);
  check('  a call to itself on the last party, not turned left, is caught', unturned !== seq && blindSpots('sequence', unturned).some((f) => /margin/.test(f)), blindSpots('sequence', unturned)[0] || 'nothing found');
  const wide = seq.replace('>1. Đặt hàng<', '>1. Đặt hàng qua ứng dụng<');
  check('  a message label longer than its room, over the next lifeline, is caught', wide !== seq && blindSpots('sequence', wide).some((f) => /lifeline/.test(f)), blindSpots('sequence', wide)[0] || 'nothing found');
  const venn = svgOf('venn-extreme-light');
  // The bottom line, where the circle narrows, is the one the room is set by.
  const over = venn.replace('>Y tế cộng đồng<', '>Y tế cộng đồng và môi trường<');
  check('  a Venn line past its region\'s room is caught', over !== venn && blindSpots('venn', over).some((f) => /circle's outline/.test(f)), blindSpots('venn', over)[0] || 'nothing found');
  const cyc = svgOf('cycle-comfortable-light');
  const long = cyc.replace('>Một vòng mỗi tháng, đo cuối kỳ<', '>Một vòng mỗi tháng, đo và họp đánh giá cuối kỳ với cả nhóm<');
  check('  a caption long enough to reach a stage is caught', long !== cyc && blindSpots('cycle', long).some((f) => /circle/.test(f)), blindSpots('cycle', long)[0] || 'nothing found');
  // Task 4b's: each fault below passes the checker, and each must be caught here.
  const probe = (label, base, broken, name, want) => {
    const found = blindSpots(name, broken);
    check(`  ${label}`, !!base && broken !== base && checkDiagram(broken).issues.length === 0 && found.some((f) => want.test(f)), found[0] || 'nothing found');
  };
  const kpi = svgOf('kpi-extreme-light');
  probe('a card\'s label past its room runs off the card\'s right edge', kpi, kpi.replace('>Doanh thu tháng<', '>Doanh thu tháng này<'), 'kpi', /from its box's edge/);
  const table = svgOf('compare-extreme-light');
  probe('a point past its room reaches the first option\'s card', table, table.replace('>Kết nối với ứng dụng<', '>Kết nối với ứng dụng khác<'), 'compare', /of a box it is not in/);
  const journey = svgOf('journey-extreme-light');
  probe('a feeling\'s word moved onto the dashed line has a line through it', journey, journey.replace(/(<text x="[\d.]+" y=")[\d.]+(" fill="#9F1239">Sốt ruột<)/, '$1252.5$2'), 'journey', /line running through/);
  const tl = svgOf('timeline-extreme-light');
  probe('a date past its room touches the next one', tl, tl.replace('>Tháng 3/2026<', '>Tháng Ba năm 2026 nay<'), 'timeline', /touches/);
  const plain = svgOf('journey-comfortable-light');
  probe('a stage name on its family\'s strong stroke, not its tint, reads too faintly', plain, plain.replace('fill="#DBEAFE" stroke="#2563EB"/>', 'fill="#2563EB" stroke="#2563EB"/>'), 'journey', /reads at/);
  const plan = svgOf('gantt-extreme-light');
  probe('a milestone moved to the plan\'s last line (x 696) runs into the margin', plan, plan.replace(/<polygon points="[^"]+"/, (m) => m.replace(/(\d+(?:\.\d+)?),/g, (n, x) => `${Number(x) + 40},`)), 'gantt', /polygon .* margin/);
  const page = svgOf('labelled-extreme-light');
  const ends = [...page.matchAll(/<path d="M224 [\d.]+H240L([\d.]+ [\d.]+)"/g)].map((m) => m[1]);
  probe('two leaders sent to each other\'s points cross', page, ends.length > 3 ? page.replace(`L${ends[2]}"`, 'L@"').replace(`L${ends[3]}"`, `L${ends[2]}"`).replace('L@"', `L${ends[3]}"`) : '', 'labelled', /cross/);
}

// The filled drawings, for a person to look at: `node test/drawing-skills.test.mjs --out <dir>`.
const outAt = process.argv.indexOf('--out');
if (outAt > 0 && process.argv[outAt + 1]) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(process.argv[outAt + 1], { recursive: true });
  for (const s of shots) fs.writeFileSync(path.join(process.argv[outAt + 1], `${s.name}.svg`), s.svg);
  console.log(`\n  wrote ${shots.length} drawings to ${process.argv[outAt + 1]}`);
}

console.log(failures === 0 ? '\n\x1b[32mAll drawing-skill checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
