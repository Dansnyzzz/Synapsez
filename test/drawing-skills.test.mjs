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

const skill = (id) => BUILTIN_SKILLS.find((s) => s.id === id) || null;
const textOf = (id) => skill(id)?.instructions || '';
// A colour the guide does not give reads as no contrast at all, so a missing one fails the check rather than the suite.
const ratio = (a, b) => (colour(a) && colour(b) ? contrast(colour(a), colour(b)) : 0);
const two = (x) => x.toFixed(2);

// What each skill may weigh. The spec (2026-11-17 §"Adaptive and professional") asked for the
// guide at about 7,000 characters and a recipe family at about 9,000; with every skeleton a
// complete drawing (480 to 1,300 characters each, about 4,500 a family) the prose around them was
// cut to the numbers and a family of four came to about 10,200, the family of six to 11,200. Read
// only when one applies, so the size is paid on the turns that draw; the description is in every
// prompt, so it stays short.
const BUDGET = { 'builtin:drawing': 7500, 'builtin:svg-flows': 10500, 'builtin:svg-structures': 11500 };
const RECIPES = {
  'builtin:svg-flows': ['decision', 'loop', 'swimlanes', 'sequence'],
  'builtin:svg-structures': ['tree', 'mindmap', 'pyramid', 'cycle', 'venn', 'stack'],
};

section('the drawing skills are on the menu, within their budgets');
for (const [id, budget] of Object.entries(BUDGET)) {
  const s = skill(id);
  check(`${id} is a built-in skill`, !!s);
  if (!s) continue;
  check(`  its description is at most 200 characters, near 170 (${s.description.length})`, s.description.length <= 200 && s.description.length >= 120);
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
  const canvas = /light \(canvas (#[0-9A-F]{6})\) \| dark \(canvas (#[0-9A-F]{6})\)/.exec(g);
  if (canvas) [out.light.canvas, out.dark.canvas] = [canvas[1], canvas[2]];
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
    const w = Math.floor((552 - 24 * (m - 1)) / m);
    const laneY = (i) => 24 + 84 * i;
    const at = steps.map((s) => ({ ...s, x: 128 + s.col * (w + 24), y: laneY(s.lane) + 16, cy: laneY(s.lane) + 42 }));
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
      if (msg.self !== undefined) return { lx: xOf(msg.self) + 36, ly: ys[j] - 4.6, anchor: 'start', label: msg.label };
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
        self: messages.map((msg, j) => ({ msg, y: ys[j] })).filter(({ msg }) => msg.self !== undefined).map(({ msg, y }) => ({ x: xOf(msg.self), top: y - 18 })),
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
          const f = fam(P, i);
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
          const f = fam(P, i);
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
        layer: layers.map((l, i) => ({ y: 24 + i * (hb + 8), w, h: hb, ty: 24 + i * (hb + 8) + hb / 2 + 5, name: l.name, tint: fam(P, i).tint, stroke: fam(P, i).stroke, inkA: fam(P, i).inkA })),
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
        { self: 2, label: '3. Kiểm tra tồn kho' },
        { from: 2, to: 3, label: '4. Yêu cầu trừ tiền' },
        { from: 3, to: 2, label: '5. Đã trừ tiền', reply: true },
        { from: 2, to: 1, label: '6. Đơn đã thanh toán', reply: true },
        { from: 1, to: 0, label: '7. Hiện biên nhận', reply: true },
      ],
    },
    extreme: {
      parties: ['Khách', 'Web', 'API', 'Kho', 'Cổng TT', 'Email'],
      messages: [
        { from: 0, to: 1, label: '1. Đặt hàng' },
        { from: 1, to: 2, label: '2. POST /đơn' },
        { from: 2, to: 3, label: '3. Giữ hàng' },
        { from: 3, to: 2, label: '4. Đã giữ', reply: true },
        { from: 2, to: 4, label: '5. Trừ tiền' },
        { self: 4, label: '6. Xác thực OTP' },
        { from: 4, to: 2, label: '7. Thành công', reply: true },
        { from: 2, to: 5, label: '8. Gửi hoá đơn' },
        { from: 5, to: 0, label: '9. Email hoá đơn' },
        { from: 2, to: 1, label: '10. Đơn xong', reply: true },
        { from: 1, to: 0, label: '11. Cảm ơn bạn', reply: true },
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
    comfortable: { hub: 'PDCA', caption: 'Mỗi vòng một tháng', steps: [['1. Lập kế', 'hoạch'], ['2. Thực', 'hiện'], ['3. Kiểm', 'tra'], ['4. Cải tiến']] },
    extreme: { hub: 'Vòng đời sản phẩm', caption: 'Lặp lại mỗi quý', steps: [['Ý tưởng'], ['Thiết kế'], ['Làm mẫu'], ['Thử'], ['Đo'], ['Học'], ['Sửa'], ['Ra mắt']] },
  },
  venn: {
    comfortable: { sets: ['Nhóm Thiết kế', 'Nhóm Kỹ thuật'], regions: { A: ['Nghiên cứu người dùng', 'Bản vẽ giao diện', 'Hệ thống màu'], AB: ['Bản mẫu', 'Kiểm thử'], B: ['Máy chủ', 'Cơ sở dữ liệu', 'Triển khai', 'Giám sát'] } },
    extreme: {
      sets: ['Kỹ năng', 'Đam mê', 'Thị trường cần'],
      regions: { A: ['Kế toán', 'Phân tích'], B: ['Âm nhạc', 'Du lịch'], C: ['Chăm sóc người già'], AB: ['Sở thích'], AC: ['Nghề'], BC: ['Sứ mệnh'], ABC: ['Ikigai'] },
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
        const ok = !left && !xml && filled.H <= 560 && smallest * shown >= 12 && issues.length === 0 && canvas === theme;
        check(`${label}: ${filled.H} tall, smallest text ${num(smallest * shown)} px as shown, nothing for the check to find`, ok,
          [left && `left unfilled: ${left.join(' ')}`, xml, filled.H > 560 && `H ${filled.H}`, smallest * shown < 12 && `text ${num(smallest * shown)} px`, canvas !== theme && `read as ${canvas}`, ...issues].filter(Boolean).join(' | '));
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
