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
// stays at 145 characters or fewer.
const BUDGET = { 'builtin:drawing': 8000, 'builtin:svg-flows': 10750, 'builtin:svg-structures': 12000 };
const DESCRIPTION = 145;
const RECIPES = {
  'builtin:svg-flows': ['decision', 'loop', 'swimlanes', 'sequence'],
  'builtin:svg-structures': ['tree', 'mindmap', 'pyramid', 'cycle', 'venn', 'stack'],
};

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

/**
 * The checker reads only rects as text holders, so text in a circle or a polygon, text beside a
 * shape it does not belong to, a Venn region and a sequence label over a lifeline go unseen
 * (review, fix round 1). Measured here the way the checker measures text: the estimate of
 * measure.js, the box from 0.8 of the size above the baseline to 0.25 below.
 */
function blindSpots(name, svg) {
  const width = Number(/viewBox="0 0 ([\d.]+) /.exec(svg)?.[1] || 720);
  const rootSize = Number(/<svg\b[^>]*font-size="([\d.]+)"/.exec(svg)?.[1] || 16);
  const texts = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map(([, a, body]) => {
    const at = (k) => new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(a)?.[1];
    const size = Number(at('font-size') || rootSize);
    const text = unescapeXml(body);
    const w = textWidth(text, size, /600|bold/.test(at('font-weight') || ''));
    const [x, y] = [Number(at('x')), Number(at('y'))];
    const anchor = at('text-anchor') || 'middle';
    const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    const box = { x0, x1: x0 + w, y0: y - 0.8 * size, y1: y + 0.25 * size };
    return { text, box, corners: [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]], centre: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2] };
  });
  const circles = [...svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"([^>]*)>/g)].map((m) => ({ c: [Number(m[1]), Number(m[2])], r: Number(m[3]), venn: /fill-opacity/.test(m[4]) }));
  const polygons = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => m[1].trim().split(/\s+/).map((p) => p.split(',').map(Number)));
  const lifelines = [...svg.matchAll(/<line x1="([\d.]+)" y1="64" x2="\1"/g)].map((m) => Number(m[1]));
  const found = [];
  const say = (t, what) => found.push(`"${t.text}" ${what}`);
  const inside = (p, c) => c.r - Math.hypot(p[0] - c.c[0], p[1] - c.c[1]);
  const venn = circles.filter((c) => c.venn);
  for (const t of texts) {
    if (t.box.x0 < 24 - 0.5 || t.box.x1 > width - 24 + 0.5) say(t, `runs into the ${Math.round(t.box.x0 < 24 ? t.box.x0 : t.box.x1)} margin`);
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
  return found;
}

const rad = (deg) => (deg * Math.PI) / 180;
const fam = (P, i) => P.fam[i % 6];
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
      return { title, nx: 360 + 240 * Math.cos(t), ny: cy + 168 * Math.sin(t), f: fam(P, i) };
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
      // Each at its recipe's room: a step 25 characters, a question line 13, an exit label 17, an outcome 30.
      { title: 'Nhận hồ sơ vay trực tuyến', pill: true },
      { q: ['Đủ giấy tờ?'], yes: 'Đủ', no: 'Thiếu giấy tờ gốc', outcome: 'Yêu cầu bổ sung trong 5 ngày' },
      { q: ['Điểm tín dụng', 'trên 650?'], yes: 'Đạt', no: 'Dưới ngưỡng', outcome: 'Từ chối và gửi thư giải thích' },
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
};

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
        const shown = Math.min(DRAWING_FIT.column / 720, (DRAWING_FIT.heightShare * DRAWING_FIT.window) / filled.H);
        const { issues, canvas } = checkDiagram(svg);
        const blind = blindSpots(name, svg);
        const ok = !left && !xml && filled.H <= 560 && smallest * shown >= 12 && issues.length === 0 && canvas === theme && blind.length === 0;
        check(`${label}: ${filled.H} tall, smallest text ${num(smallest * shown)} px as shown, nothing for the check to find, nor where it cannot look`, ok,
          [left && `left unfilled: ${left.join(' ')}`, xml, filled.H > 560 && `H ${filled.H}`, smallest * shown < 12 && `text ${num(smallest * shown)} px`, canvas !== theme && `read as ${canvas}`, ...issues, ...blind].filter(Boolean).join(' | '));
        shots.push({ name: `${name}-${size}-${theme}`, svg, theme });
      }
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
