/**
 * A diagram the model describes as { direction, nodes, groups, edges } is checked and laid
 * out by the server, so its arrows connect by construction (owner, 2026-11-17: a pipeline
 * drawing whose arrows pointed at nothing and ran through text). Pure code: no store, no
 * network, no clock.
 *
 *   node test/diagram.test.mjs
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { validateDiagram, ICON_NAMES } = await import('../server/diagram/validate.js');
const { layoutDiagram, chooseDirection, shownSize } = await import('../server/diagram/layout.js');
const { drawingHeightCap, DRAWING_FIT } = await import('../public/js/drawing-fit.js');
const { textWidth, wrapText, TEXT, FIT, measureNode, lineHeight } = await import('../server/diagram/measure.js');
const { renderDiagram, palette, STAND_OUT } = await import('../server/diagram/render.js');
const { ICONS } = await import('../server/diagram/icons.js');
const { checkDiagram, contrast, colour } = await import('../server/widgetCheck.js');
const { translateMessage } = await import('../server/i18n/index.js');

// Every refusal seen below is kept, to prove each reaches a Vietnamese reader translated.
const refusals = [];
const refused = (input) => {
  const out = validateDiagram(input);
  if (!out.ok) refusals.push(out.error);
  return out.ok ? '' : out.error;
};
const valid = (input) => {
  const out = validateDiagram(input);
  if (!out.ok) throw new Error(`fixture refused: ${out.error}`);
  return out.diagram;
};
const nodes = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `Node ${i}`, ...extra }));

// ── geometry helpers for the invariants ──────────────────────────────────────
const EPS = 0.5;
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const onBorder = ([x, y], b) => {
  const inX = x >= b.x - EPS && x <= b.x + b.w + EPS;
  const inY = y >= b.y - EPS && y <= b.y + b.h + EPS;
  const onSide = Math.abs(x - b.x) <= EPS || Math.abs(x - (b.x + b.w)) <= EPS;
  const onTopBottom = Math.abs(y - b.y) <= EPS || Math.abs(y - (b.y + b.h)) <= EPS;
  return (onSide && inY) || (onTopBottom && inX);
};
// Does an axis-parallel segment pass through the open inside of a box (shrunk by EPS)?
const crossesInside = ([x1, y1], [x2, y2], b) => {
  const l = b.x + EPS;
  const r = b.x + b.w - EPS;
  const t = b.y + EPS;
  const btm = b.y + b.h - EPS;
  if (y1 === y2) return y1 > t && y1 < btm && Math.max(x1, x2) > l && Math.min(x1, x2) < r;
  return x1 > l && x1 < r && Math.max(y1, y2) > t && Math.min(y1, y2) < btm;
};

// Fix round 5: a grown pill is drawn round across its short side, and a line into its round end
// runs on to meet the curve, inside the box. The box-level checks read such an end where its line
// crosses the box's edge; onOutline checks the end itself is on what is drawn.
const boxEnd = (pt, next, n) => {
  if (!n || n.kind !== 'pill') return pt;
  const [x, y] = pt;
  const inside = x > n.x + EPS && x < n.x + n.w - EPS && y > n.y + EPS && y < n.y + n.h - EPS;
  if (!inside) return pt;
  if (Math.abs(next[0] - x) < 1e-9) return [x, next[1] < y ? n.y : n.y + n.h];
  return [next[0] < x ? n.x : n.x + n.w, y];
};
function boxed(layout) {
  if (layout.boxed) return layout;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const edges = layout.edges.map((e) => {
    if (e.points.length < 2) return e;
    const pts = e.points.map((q) => [...q]);
    pts[0] = boxEnd(pts[0], pts[1], byId.get(e.from));
    pts[pts.length - 1] = boxEnd(pts.at(-1), pts.at(-2), byId.get(e.to));
    return { ...e, points: pts };
  });
  return { ...layout, edges, boxed: true };
}
// The distance from a point to a rounded rectangle's outline.
const outlineGap = ([x, y], n) => {
  const r = Math.min(n.w, n.h) / 2;
  const cx = Math.min(Math.max(x, n.x + r), n.x + n.w - r);
  const cy = Math.min(Math.max(y, n.y + r), n.y + n.h - r);
  return Math.abs(Math.hypot(x - cx, y - cy) - r);
};

/** Every property a laid-out diagram must have, as a list of what is wrong. */
function problems(drawn) {
  const out = [];
  const layout = boxed(drawn);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  // A pill's arrows end on its drawn outline: never short of its curve, never inside it.
  for (const e of drawn.edges) {
    for (const [pt, id] of [[e.points[0], e.from], [e.points.at(-1), e.to]]) {
      const n = byId.get(id);
      if (n?.kind === 'pill' && outlineGap(pt, n) > 1) out.push(`${e.from}→${e.to} stops ${outlineGap(pt, n).toFixed(1)} off the outline of the pill ${id}`);
    }
  }
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      if (overlapArea(layout.nodes[i], layout.nodes[j]) > 0.01) out.push(`boxes ${layout.nodes[i].id} and ${layout.nodes[j].id} overlap`);
    }
  }
  for (const e of layout.edges) {
    const name = `${e.from}→${e.to}`;
    if (e.points.length < 2) {
      out.push(`${name} has fewer than two points`);
      continue;
    }
    if (!onBorder(e.points[0], byId.get(e.from))) out.push(`${name} does not start on ${e.from}'s border: ${JSON.stringify(e.points[0])}`);
    if (!onBorder(e.points.at(-1), byId.get(e.to))) out.push(`${name} does not end on ${e.to}'s border: ${JSON.stringify(e.points.at(-1))}`);
    for (let k = 1; k < e.points.length; k += 1) {
      const [a, b] = [e.points[k - 1], e.points[k]];
      if (a[0] !== b[0] && a[1] !== b[1]) out.push(`${name} segment ${k} is slanted: ${JSON.stringify([a, b])}`);
      for (const n of layout.nodes) if (crossesInside(a, b, n)) out.push(`${name} segment ${k} runs through ${n.id}`);
    }
    if (e.labelBox) for (const n of layout.nodes) if (overlapArea(e.labelBox, n) > 0.01) out.push(`the label of ${name} covers ${n.id}`);
  }
  const labelled = layout.edges.filter((e) => e.labelBox);
  for (let i = 0; i < labelled.length; i += 1) {
    for (let j = i + 1; j < labelled.length; j += 1) if (overlapArea(labelled[i].labelBox, labelled[j].labelBox) > 0.01) out.push(`the labels of ${labelled[i].from}→${labelled[i].to} and ${labelled[j].from}→${labelled[j].to} overlap`);
  }
  // The text block keeps its padding inside its box, however far the box grew for its arrows.
  for (const n of layout.nodes) {
    const t = n.textBox;
    const padX = TEXT.padding + (n.kind === 'pill' ? TEXT.pillExtra : 0);
    const inside = t.x - n.x >= padX - EPS && n.x + n.w - (t.x + t.w) >= padX - EPS && t.y - n.y >= TEXT.padding - EPS && n.y + n.h - (t.y + t.h) >= TEXT.padding - EPS;
    const fits = n.titleLines.every((l) => textWidth(l, TEXT.titleSize, true) <= t.w + 0.01) && n.lines.every((l) => textWidth(l, TEXT.lineSize) <= t.w + 0.01);
    if (!inside || !fits) out.push(`the text of ${n.id} does not sit inside its box`);
  }
  for (const g of layout.groups) {
    for (const m of layout.nodes.filter((n) => n.group === g.id)) {
      const inside = m.x - g.x >= 16 - EPS && m.y - g.y >= 16 - EPS && g.x + g.w - (m.x + m.w) >= 16 - EPS && g.y + g.h - (m.y + m.h) >= 16 - EPS;
      if (!inside) out.push(`group ${g.id} does not hold ${m.id} with its 16 px margin`);
    }
    for (const n of layout.nodes.filter((x) => x.group !== g.id)) if (overlapArea(g, n) > 0.01) out.push(`group ${g.id} covers ${n.id}, which is not in it`);
    for (const h of layout.groups) if (h !== g && h.id > g.id && overlapArea(g, h) > 0.01) out.push(`groups ${g.id} and ${h.id} overlap`);
  }
  return out;
}
// Each segment of every edge, tagged with its edge, for the checks between edges.
const segmentsOf = (drawn) => boxed(drawn).edges.flatMap((e, ei) => e.points.slice(1).map((p, k) => ({ ei, a: e.points[k], b: p })));
const labelsOverLines = (layout) => {
  const segs = segmentsOf(layout);
  return layout.edges.flatMap((e, ei) => (e.labelBox ? segs.filter((s) => s.ei !== ei && crossesInside(s.a, s.b, e.labelBox)).map(() => `${e.from}→${e.to}`) : []));
};
// Two edges' parallel segments closer than 4 px over more than a pixel read as one thick line.
const sideBySide = (layout) => {
  const segs = segmentsOf(layout);
  const out = [];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const [s, t] = [segs[i], segs[j]];
      const flat = s.a[1] === s.b[1];
      if (s.ei === t.ei || flat !== (t.a[1] === t.b[1])) continue;
      const [across, along] = flat ? [1, 0] : [0, 1];
      const shared = Math.min(Math.max(s.a[along], s.b[along]), Math.max(t.a[along], t.b[along])) - Math.max(Math.min(s.a[along], s.b[along]), Math.min(t.a[along], t.b[along]));
      if (Math.abs(s.a[across] - t.a[across]) < 4 && shared > 1) out.push(`${layout.edges[s.ei].from}→${layout.edges[s.ei].to} and ${layout.edges[t.ei].from}→${layout.edges[t.ei].to}`);
    }
  }
  return out;
};
// Places where one edge's line crosses another's, at right angles, away from both ends.
const crossingsOf = (layout) => {
  const segs = segmentsOf(layout);
  let n = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const [s, t] = [segs[i], segs[j]];
      const flat = s.a[1] === s.b[1];
      if (s.ei === t.ei || flat === (t.a[1] === t.b[1])) continue;
      const [h, v] = flat ? [s, t] : [t, s];
      const [x, y] = [v.a[0], h.a[1]];
      if (x > Math.min(h.a[0], h.b[0]) && x < Math.max(h.a[0], h.b[0]) && y > Math.min(v.a[1], v.b[1]) && y < Math.max(v.a[1], v.b[1])) n += 1;
    }
  }
  return n;
};
const centre = (n) => [n.x + n.w / 2, n.y + n.h / 2];

// A deterministic stand-in for a model's big drawing: seeded, so a failure reproduces.
function bigDiagram(seed, { n = 40, m = 80, groups = 4 } = {}) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const words = ['Cổng API', 'Bộ nhớ đệm', 'Hàng đợi', 'Mô hình', 'Kiểm tra', 'Tóm tắt', 'Ghi nhật ký', 'Lưu trữ'];
  const g = Array.from({ length: groups }, (_, i) => ({ id: `g${i}`, title: `Nhóm ${i + 1}` }));
  const nd = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    title: `${words[i % words.length]} ${i}`,
    lines: rand() < 0.4 ? ['một dòng mô tả ngắn', 'và một dòng nữa dài hơn một chút để phải xuống dòng'].slice(0, 1 + Math.floor(rand() * 2)) : [],
    kind: ['box', 'box', 'box', 'pill', 'note'][Math.floor(rand() * 5)],
    ...(i < groups * 3 ? { group: `g${i % groups}` } : {}),
  }));
  const ed = [];
  for (let k = 0; k < m; k += 1) {
    const a = Math.floor(rand() * n);
    let b = Math.floor(rand() * n);
    if (k % 23 === 0) b = a; // now and then a loop back to itself
    else if (rand() < 0.8 && b < a) b = Math.min(n - 1, a + 1 + Math.floor(rand() * 4)); // mostly forward, some back
    ed.push({ from: `n${a}`, to: `n${b}`, ...(rand() < 0.3 ? { label: ['có', 'không', 'kết quả', 'thử lại sau'][k % 4] } : {}), ...(rand() < 0.2 ? { style: 'dashed' } : {}) });
  }
  return { nodes: nd, groups: g, edges: ed };
}

// The owner's kind of drawing: a pipeline in layers, in Vietnamese, with an aside, a loop and a long edge.
const pipeline = {
  groups: [
    { id: 'client', title: 'Phía người dùng' },
    { id: 'server', title: 'Máy chủ Ephapse' },
    { id: 'data', title: 'Dữ liệu' },
  ],
  nodes: [
    { id: 'user', title: 'Người dùng', kind: 'pill' },
    { id: 'app', title: 'Tầng 1 — Ứng dụng', lines: ['RAPTOR: cây tóm tắt', 'MemGPT, Mem0'], group: 'client' },
    { id: 'gw', title: 'Tầng 2 — Cổng API', lines: ['Nén prompt', 'Định tuyến mô hình theo chi phí và độ trễ'], group: 'server' },
    { id: 'agent', title: 'Vòng lặp tác tử', lines: ['executeTool không bao giờ ném lỗi'], group: 'server' },
    { id: 'cache', title: 'Bộ nhớ đệm', group: 'data' },
    { id: 'db', title: 'Cơ sở dữ liệu', lines: ['Postgres', 'PGlite khi chạy cục bộ'], group: 'data' },
    { id: 'model', title: 'Nhà cung cấp mô hình', kind: 'note' },
    { id: 'done', title: 'Trả lời', kind: 'pill' },
  ],
  edges: [
    { from: 'user', to: 'app', label: 'câu hỏi' },
    { from: 'app', to: 'gw', label: 'prompt đã nén' },
    { from: 'gw', to: 'agent' },
    { from: 'agent', to: 'model', label: 'luồng token', style: 'dashed' },
    { from: 'agent', to: 'cache' },
    { from: 'agent', to: 'db' },
    { from: 'cache', to: 'done' },
    { from: 'model', to: 'done' },
    { from: 'db', to: 'done' },
    { from: 'gw', to: 'done', label: 'trả lời nhanh' },
    { from: 'agent', to: 'agent', label: 'thử lại' },
  ],
};

section('text is measured the way widgetCheck measures it');
{
  const same = (a, b) => Math.abs(a - b) < 1e-9;
  check('0.55 em a letter', same(textWidth('abcd', 10), 22), `${textWidth('abcd', 10)}`);
  check('0.6 em a bold letter', same(textWidth('abcd', 10, true), 24), `${textWidth('abcd', 10, true)}`);
  check('1 em a CJK character, bold or not', same(textWidth('中文', 14, true), 28) && same(textWidth('中文', 14), 28));
  check('a Vietnamese letter is one letter, however it was typed', textWidth('ệ'.normalize('NFD'), 10) === textWidth('ệ', 10), `${textWidth('ệ'.normalize('NFD'), 10)}`);
  const wrapped = wrapText('Định tuyến mô hình theo chi phí và độ trễ, rồi nén prompt trước khi gửi đi', 120, 12.5);
  check('a long line wraps into lines that each fit', wrapped.length > 1 && wrapped.every((l) => textWidth(l, 12.5) <= 120), JSON.stringify(wrapped));
  check('  and loses no word', wrapped.join(' ') === 'Định tuyến mô hình theo chi phí và độ trễ, rồi nén prompt trước khi gửi đi');
  const long = wrapText('x'.repeat(100), 50, 10);
  check('a word longer than the box is broken, not left to run out', long.every((l) => textWidth(l, 10) <= 50) && long.join('') === 'x'.repeat(100), JSON.stringify(long));
  check('the figures the renderer needs are exported', TEXT.titleSize === 14 && TEXT.lineSize === 12.5 && TEXT.padding === 12 && TEXT.minWidth === 120 && TEXT.maxWidth === 260 && TEXT.labelSize === 11.5);
}

section('a diagram is refused with a message naming what to change');
{
  check('something that is not a diagram', /object/.test(refused(null)) && /object/.test(refused('boxes')) && /object/.test(refused([])));
  check('no nodes at all', /nodes/.test(refused({ nodes: [] })) && /nodes/.test(refused({ edges: [] })));
  check('more than 40 nodes, saying 40', /40/.test(refused({ nodes: nodes(41) })), refused({ nodes: nodes(41) }));
  check('  while 40 is fine', validateDiagram({ nodes: nodes(40) }).ok);
  const e81 = { nodes: nodes(2), edges: Array.from({ length: 81 }, () => ({ from: 'n0', to: 'n1' })) };
  check('more than 80 edges, saying 80', /80/.test(refused(e81)), refused(e81));
  check('  while 80 is fine', validateDiagram({ ...e81, edges: e81.edges.slice(0, 80) }).ok);
  const g9 = { nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, title: 'x', group: `g${i}` })), groups: Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, title: `G${i}` })) };
  check('more than 8 groups, saying 8', /\b8\b/.test(refused(g9)), refused(g9));
  check('  while 8 is fine', validateDiagram({ nodes: g9.nodes.slice(0, 8), groups: g9.groups.slice(0, 8) }).ok);
  const badId = refused({ nodes: [{ id: 'has space', title: 'x' }] });
  check('an id with a space, naming the id and the rule', /"has space"/.test(badId) && /letters, digits/.test(badId), badId);
  check('an id longer than 40', /40/.test(refused({ nodes: [{ id: 'a'.repeat(41), title: 'x' }] })));
  check('  while 40 characters is fine', validateDiagram({ nodes: [{ id: 'a'.repeat(40), title: 'x' }] }).ok);
  const dup = refused({ nodes: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] });
  check('a duplicate node id, naming it', /"a"/.test(dup) && /own id/.test(dup), dup);
  const dupG = refused({ nodes: [{ id: 'a', title: 'x', group: 'g' }], groups: [{ id: 'g', title: 'G' }, { id: 'g', title: 'H' }] });
  check('a duplicate group id, naming it', /"g"/.test(dupG) && /own id/.test(dupG), dupG);
  check('a node with no title', /title/.test(refused({ nodes: [{ id: 'a' }] })) && /title/.test(refused({ nodes: [{ id: 'a', title: '   ' }] })));
  const t61 = refused({ nodes: [{ id: 'a', title: 'x'.repeat(61) }] });
  check('a title longer than 60 characters, saying 60', /60/.test(t61) && /61/.test(t61), t61);
  check('  a 60-letter Vietnamese title typed in decomposed form is 60 letters, and fine', validateDiagram({ nodes: [{ id: 'a', title: 'ệ'.repeat(60).normalize('NFD') }] }).ok);
  check('  and 61 of them are refused', /60/.test(refused({ nodes: [{ id: 'a', title: 'ệ'.repeat(61).normalize('NFD') }] })));
  const l7 = refused({ nodes: [{ id: 'a', title: 'x', lines: ['1', '2', '3', '4', '5', '6', '7'] }] });
  check('more than 6 lines, saying 6', /\b6\b/.test(l7), l7);
  const l81 = refused({ nodes: [{ id: 'a', title: 'x', lines: ['ok', 'y'.repeat(81)] }] });
  check('a line longer than 80 characters, saying 80 and which line', /80/.test(l81) && /line 2/.test(l81), l81);
  const nest = refused({ nodes: [{ id: 'a', title: 'x', group: 'inner' }], groups: [{ id: 'outer', title: 'O' }, { id: 'inner', title: 'I', group: 'outer' }] });
  check('a group inside a group', /nest/.test(nest), nest);
  const dir = refused({ direction: 'up', nodes: nodes(1) });
  check('a direction other than auto, right or down', /"auto"/.test(dir) && /"right"/.test(dir) && /"down"/.test(dir), dir);
  const theme = refused({ theme: 'sepia', nodes: nodes(1) });
  check('a theme other than light or dark', /"sepia"/.test(theme) && /"light"/.test(theme) && /"dark"/.test(theme), theme);
  const icon = refused({ nodes: [{ id: 'a', title: 'x', icon: 'robot' }] });
  check('an unknown icon, naming the node and listing every known one', /"a"/.test(icon) && /"robot"/.test(icon) && ICON_NAMES.every((name) => icon.includes(name)), icon);
  const kind = refused({ nodes: [{ id: 'a', title: 'x', kind: 'circle' }] });
  check('a kind other than box, pill or note', /box/.test(kind) && /pill/.test(kind) && /note/.test(kind), kind);
  const style = refused({ nodes: nodes(2), edges: [{ from: 'n0', to: 'n1', style: 'dotted' }] });
  check('a style other than solid or dashed', /solid/.test(style) && /dashed/.test(style), style);
  const unknown = refused({ nodes: [{ id: 'app', title: 'App' }, { id: 'db', title: 'DB' }], edges: [{ from: 'app', to: 'db' }, { from: 'db', to: 'app' }, { from: 'app', to: 'gw' }] });
  check('an edge to an unknown node, naming the edge and the id', unknown.startsWith('edge 3 goes to "gw", which is not a node id'), unknown);
  const from = refused({ nodes: nodes(1), edges: [{ from: 'ghost', to: 'n0' }] });
  check('an edge from an unknown node', /"ghost"/.test(from) && /not a node id/.test(from), from);
  const ng = refused({ nodes: [{ id: 'a', title: 'x', group: 'nowhere' }] });
  check('a node in a group that is not declared', /"nowhere"/.test(ng) && /not a group id/.test(ng), ng);
  const empty = refused({ nodes: nodes(1), groups: [{ id: 'g', title: 'G' }] });
  check('a group nobody is in, saying how to put nodes in it', /"g"/.test(empty) && /"group"/.test(empty), empty);
  check('a label longer than 60 characters', /60/.test(refused({ nodes: nodes(2), edges: [{ from: 'n0', to: 'n1', label: 'z'.repeat(61) }] })));
  check('lines that are not a list of text', /lines/.test(refused({ nodes: [{ id: 'a', title: 'x', lines: [{}] }] })));
  const huge = { nodes: nodes(100000) };
  const t0 = performance.now();
  const hugeError = refused(huge);
  check('a vast input is refused at once, before it is read', /40/.test(hugeError) && performance.now() - t0 < 50, `${(performance.now() - t0).toFixed(1)} ms`);
  const untranslated = [...new Set(refusals)].filter((m) => translateMessage(m, 'vi') === m);
  check(`each of the ${new Set(refusals).size} refusals reads in Vietnamese too`, untranslated.length === 0, untranslated.slice(0, 3).join(' | '));
}

section('what is accepted comes back normalised');
{
  const d = valid({ nodes: [{ id: ' a ', title: '  Tầng   1\n Ứng dụng ', lines: 'RAPTOR\n\n MemGPT ' }, { id: 7, title: 2024 }], edges: [{ from: 'a', to: 7, label: '  ' }] });
  check('direction defaults to auto, and theme to light', d.direction === 'auto' && d.theme === 'light', `${d.direction} ${d.theme}`);
  check('kind defaults to box, group and icon to none', d.nodes[0].kind === 'box' && d.nodes[0].group === null && d.nodes[0].icon === null);
  check('an icon is kept, its case ignored', valid({ nodes: [{ id: 'a', title: 'x', icon: ' Database ' }] }).nodes[0].icon === 'database');
  // The tool's schema turns one text into a list of one, so a line break inside an entry splits it too.
  check('a line with line breaks in a list is that many lines', isDeepStrictEqual(valid({ nodes: [{ id: 'a', title: 'x', lines: ['RAPTOR\nMemGPT', 'Mem0'] }] }).nodes[0].lines, ['RAPTOR', 'MemGPT', 'Mem0']));
  check('strings are trimmed and their spaces collapsed', d.nodes[0].id === 'a' && d.nodes[0].title === 'Tầng 1 Ứng dụng', JSON.stringify(d.nodes[0]));
  check('lines written as one text are split at its line breaks, blanks dropped', isDeepStrictEqual(d.nodes[0].lines, ['RAPTOR', 'MemGPT']), JSON.stringify(d.nodes[0].lines));
  check('a number is taken as text, for an id and a title', d.nodes[1].id === '7' && d.nodes[1].title === '2024' && d.edges[0].to === '7');
  check('style defaults to solid, a blank label to none', d.edges[0].style === 'solid' && d.edges[0].label === null);
  check('groups and edges default to empty lists', isDeepStrictEqual(valid({ nodes: nodes(1) }).groups, []) && isDeepStrictEqual(valid({ nodes: nodes(1) }).edges, []));
  check('the text is in composed form', valid({ nodes: [{ id: 'a', title: 'Tầng'.normalize('NFD') }] }).nodes[0].title === 'Tầng'.normalize('NFC'));
  check('  and the case of a choice does not matter', valid({ direction: 'Down', nodes: [{ id: 'a', title: 'x', kind: 'PILL' }] }).nodes[0].kind === 'pill');
}

section('the owner\'s pipeline lays out cleanly, both ways');
for (const direction of ['right', 'down']) {
  const layout = layoutDiagram(valid({ ...pipeline, direction }));
  const wrong = problems(layout);
  check(`${direction}: boxes apart, arrows on their borders, at right angles, through no box, labels off boxes and each other, groups whole`, wrong.length === 0, wrong.slice(0, 4).join(' | '));
  // The busy box here (the agent: three ways out and a loop, two of them labelled) is where a
  // label used to land on its neighbours' lines; a labelled port now gets the room.
  check(`${direction}: no label covers another arrow's line`, labelsOverLines(layout).length === 0, labelsOverLines(layout).join(' | '));
  check(`${direction}: no two arrows run side by side closer than 4 px`, sideBySide(layout).length === 0, sideBySide(layout).join(' | '));
  check(`${direction}: a pill keeps round ends the size its text gives`, layout.nodes.filter((n) => n.kind === 'pill').every((n) => n.radius > 0 && n.radius <= Math.min(n.w, n.h) / 2));
  check(`${direction}: every label is placed`, layout.edges.filter((e) => e.label).every((e) => e.labelBox && e.labelLines.length), JSON.stringify(layout.edges.filter((e) => e.label && !e.labelBox).map((e) => e.label)));
  const fits = layout.nodes.every((n) => {
    const room = n.w - 2 * TEXT.padding - (n.kind === 'pill' ? 2 * TEXT.pillExtra : 0) + 0.01;
    return n.w >= 120 && n.w <= 260 && n.titleLines.every((l) => textWidth(l, TEXT.titleSize, true) <= room) && n.lines.every((l) => textWidth(l, TEXT.lineSize) <= room);
  });
  check(`${direction}: every box is 120–260 wide and its text fits inside the padding`, fits);
  const groupTitlesFit = layout.groups.every((g) => g.titleLines.every((l) => textWidth(l, TEXT.groupTitleSize, true) <= g.titleBox.w + 0.01) && overlapArea(g.titleBox, g) >= g.titleBox.w * g.titleBox.h - 0.01);
  check(`${direction}: group titles fit their place inside the group`, groupTitlesFit);
  const titleClear = layout.groups.every((g) => layout.nodes.every((n) => overlapArea(g.titleBox, n) <= 0.01) && layout.edges.every((e) => !e.labelBox || overlapArea(g.titleBox, e.labelBox) <= 0.01));
  check(`${direction}: no box or label covers a group title`, titleClear);
  const titleCrossed = layout.groups.flatMap((g) => layout.edges.filter((e) => e.points.some((p, k) => k > 0 && crossesInside(e.points[k - 1], p, g.titleBox))).map((e) => `${e.from}→${e.to} through ${g.id}`));
  check(`${direction}: no arrow runs through a group title`, titleCrossed.length === 0, titleCrossed.join(' | '));
  const labelsFit = layout.edges.filter((e) => e.labelBox).every((e) => e.labelLines.every((l) => textWidth(l, TEXT.labelSize) <= e.labelBox.w - 2 * TEXT.labelPadding + 0.01));
  check(`${direction}: label text fits its backing`, labelsFit);
  const loop = layout.edges.find((e) => e.from === 'agent' && e.to === 'agent');
  check(`${direction}: a loop back to the same box leaves and returns on that box`, loop.points.length >= 4 && !loop.reversed);
  check(`${direction}: the drawing holds everything with its 24 px margin`, layout.nodes.every((n) => n.x >= 24 - EPS && n.y >= 24 - EPS && n.x + n.w <= layout.width - 24 + EPS && n.y + n.h <= layout.height - 24 + EPS) && layout.groups.every((g) => g.x >= 24 - EPS && g.y >= 24 - EPS && g.x + g.w <= layout.width - 24 + EPS && g.y + g.h <= layout.height - 24 + EPS));
}

section('the same input gives the same layout');
{
  const a = layoutDiagram(valid(pipeline));
  const b = layoutDiagram(valid(structuredClone(pipeline)));
  check('deep-equal twice', isDeepStrictEqual(a, b));
  const big = valid(bigDiagram(7));
  check('  and for a big one too', isDeepStrictEqual(layoutDiagram(big), layoutDiagram(big)));
  check('nodes, edges and groups come back in the order given', a.nodes.map((n) => n.id).join() === pipeline.nodes.map((n) => n.id).join() && a.edges.map((e) => `${e.from}>${e.to}`).join() === pipeline.edges.map((e) => `${e.from}>${e.to}`).join() && a.groups.map((g) => g.id).join() === 'client,server,data');
}

section('a cycle is drawn, with one edge turned round for the layout');
{
  const layout = layoutDiagram(valid({ nodes: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }, { id: 'C', title: 'C' }], edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' }] }));
  check('it lays out', layout.edges.length === 3 && problems(layout).length === 0, problems(layout).join(' | '));
  check('exactly one edge is marked reversed, the one closing the loop', layout.edges.filter((e) => e.reversed).map((e) => `${e.from}${e.to}`).join() === 'CA');
  const ca = layout.edges.find((e) => e.from === 'C');
  const [cNode, aNode] = ['C', 'A'].map((id) => layout.nodes.find((n) => n.id === id));
  check('  and it is still drawn from C to A', onBorder(ca.points[0], cNode) && onBorder(ca.points.at(-1), aNode));
  const two = layoutDiagram(valid({ nodes: nodes(2), edges: [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n0' }] }));
  check('two boxes pointing at each other lay out, one edge reversed', problems(two).length === 0 && two.edges.filter((e) => e.reversed).length === 1);
}

section('an edge across several ranks goes round the boxes between');
{
  const d = valid({
    nodes: ['A', 'B', 'C', 'D', 'X', 'Y'].map((id) => ({ id, title: `Bước ${id}`, lines: id === 'C' ? ['một hộp cao hơn', 'để chặn đường', 'nếu mũi tên đi thẳng'] : [] })),
    edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'D' }, { from: 'A', to: 'X' }, { from: 'X', to: 'Y' }, { from: 'Y', to: 'D' }, { from: 'A', to: 'D', label: 'đường tắt' }],
  });
  for (const direction of ['right', 'down']) {
    const layout = layoutDiagram({ ...d, direction });
    const ad = layout.edges.find((e) => e.from === 'A' && e.to === 'D');
    const through = layout.nodes.filter((n) => ad.points.some((p, k) => k > 0 && crossesInside(ad.points[k - 1], p, n)));
    check(`${direction}: the edge from rank 0 to rank 3 passes no box`, through.length === 0 && problems(layout).length === 0, through.map((n) => n.id).join() + problems(layout).join(' | '));
  }
}

section('direction decides which way the ranks run');
{
  const chain = valid({ direction: 'right', nodes: nodes(3), edges: [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n2' }] });
  const right = layoutDiagram(chain);
  const down = layoutDiagram({ ...chain, direction: 'down' });
  const [r0, r1, r2] = right.nodes.map(centre);
  const [d0, d1, d2] = down.nodes.map(centre);
  check('right: ranks increase in x, at the gap of 72', r1[0] > r0[0] && r2[0] > r1[0] && right.nodes[1].x - (right.nodes[0].x + right.nodes[0].w) >= 72 - EPS && Math.abs(r0[1] - r1[1]) < EPS);
  check('down: ranks increase in y, not x, at the gap of 56', d1[1] > d0[1] && d2[1] > d1[1] && Math.abs(d0[0] - d1[0]) < EPS && Math.abs(d1[0] - d2[0]) < EPS && down.nodes[1].y - (down.nodes[0].y + down.nodes[0].h) >= 56 - EPS);
  check('a straight chain is drawn with straight arrows', right.edges.every((e) => e.points.length === 2) && down.edges.every((e) => e.points.length === 2));
  const siblings = layoutDiagram(valid({ direction: 'right', nodes: nodes(3), edges: [{ from: 'n0', to: 'n1' }, { from: 'n0', to: 'n2' }] }));
  const [upper, lower] = [siblings.nodes[1], siblings.nodes[2]].sort((p, q) => p.y - q.y);
  const gap = lower.y - (upper.y + upper.h);
  check('two boxes in one rank sit 24 apart', Math.abs(gap - 24) < EPS, `${gap}`);
  check('  and their parent sits between them', Math.abs(centre(siblings.nodes[0])[1] - (centre(upper)[1] + centre(lower)[1]) / 2) < 1);
}

section('groups hold their members and keep others out');
{
  const d = valid({
    groups: [{ id: 'g', title: 'Một nhóm có tiêu đề khá dài để phải xuống dòng ở đây' }, { id: 'h', title: 'Nhóm hai' }],
    nodes: [{ id: 'a', title: 'A', group: 'g' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C', group: 'g' }, { id: 'd', title: 'D', group: 'h' }, { id: 'e', title: 'E', group: 'h' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'd' }, { from: 'd', to: 'e' }, { from: 'e', to: 'c' }],
  });
  for (const direction of ['right', 'down']) {
    const layout = layoutDiagram({ ...d, direction });
    check(`${direction}: each group box holds its members plus 16 px, and no one else, and groups do not overlap`, problems(layout).length === 0, problems(layout).join(' | '));
  }
  // x and z share a group and a rank; y, given between them, must not end up between them.
  const split = valid({
    groups: [{ id: 'g', title: 'G' }],
    nodes: [{ id: 's', title: 'S' }, { id: 'x', title: 'X', group: 'g' }, { id: 'y', title: 'Y' }, { id: 'z', title: 'Z', group: 'g' }],
    edges: [{ from: 's', to: 'x' }, { from: 's', to: 'y' }, { from: 's', to: 'z' }],
  });
  for (const direction of ['right', 'down']) {
    const layout = layoutDiagram({ ...split, direction });
    const axis = direction === 'right' ? 1 : 0;
    const [x, y, z] = ['x', 'y', 'z'].map((id) => centre(layout.nodes.find((n) => n.id === id))[axis]);
    check(`${direction}: members of a group sit together in a rank, not split by another box`, !(y > Math.min(x, z) && y < Math.max(x, z)) && problems(layout).length === 0, `${x} ${y} ${z}`);
  }
  const tiny = layoutDiagram(valid({ direction: 'right', groups: [{ id: 'g', title: 'G' }], nodes: [{ id: 'a', title: 'A', group: 'g' }] }));
  const [g] = tiny.groups;
  const [a] = tiny.nodes;
  const near = (v, want) => Math.abs(v - want) < 0.01;
  check('a lone member sits 16 px inside its group, with the title above it', near(a.x - g.x, 16) && near(g.x + g.w - (a.x + a.w), 16) && a.y - g.y > 16 + g.titleBox.h && near(g.y + g.h - (a.y + a.h), 16));
}

section('labels on a busy box stay off every line (review, fix round 1)');
{
  // A hub with labelled ways out: in "down" a label is wide across its line, and a hub capped
  // at 260 wide once squeezed its ports until its labels lay on each other's lines.
  const label = (i, len) => `nhãn ${i} ${'chữ '.repeat(10)}`.slice(0, len).trim();
  const fan = (k, len, direction) =>
    valid({ direction, nodes: [{ id: 'hub', title: 'Cổng API' }, ...Array.from({ length: k }, (_, i) => ({ id: `t${i}`, title: `Dịch vụ t${i}` }))], edges: Array.from({ length: k }, (_, i) => ({ from: 'hub', to: `t${i}`, label: label(i, len) })) });
  const bad = [];
  for (const k of [2, 3, 4, 5, 6]) {
    for (const len of [8, 14, 20, 30]) {
      for (const direction of ['right', 'down']) {
        const layout = layoutDiagram(fan(k, len, direction));
        const wrong = [...problems(layout), ...labelsOverLines(layout).map((n) => `label of ${n} on a line`)];
        if (wrong.length) bad.push(`${direction} k=${k} len=${len}: ${wrong.slice(0, 2).join(' | ')}`);
      }
    }
  }
  check('fan-outs of 2–6 with labels of 8–30 characters, both ways: no label on a line, no rule broken', bad.length === 0, bad.slice(0, 3).join(' || '));
  for (const direction of ['right', 'down']) {
    const loops = layoutDiagram(valid({ direction, nodes: [{ id: 'p', title: 'Xử lý' }, { id: 'q', title: 'Xong' }], edges: [{ from: 'p', to: 'q' }, ...Array.from({ length: 6 }, (_, i) => ({ from: 'p', to: 'p', label: label(i, 20) }))] }));
    const wrong = [...problems(loops), ...labelsOverLines(loops)];
    check(`${direction}: six labelled loops on one box keep their labels off every line`, wrong.length === 0, wrong.slice(0, 3).join(' | '));
  }
  const wide = layoutDiagram(fan(6, 30, 'down'));
  const hub = wide.nodes[0];
  check('a hub grows past 260 for its labels, but its text stays wrapped at 260 and centred', hub.w > TEXT.maxWidth && hub.textBox.w <= TEXT.maxWidth - 2 * TEXT.padding && Math.abs(hub.textBox.x + hub.textBox.w / 2 - (hub.x + hub.w / 2)) < 0.01, `${hub.w} wide, text ${hub.textBox.w}`);
}

section('small drawings: no two lines side by side, no label on a line (review, fix round 1)');
{
  // 300 seeds of 5–15 boxes, both ways: about 2 % once had two arrows 1–4 px apart, which the
  // lane order now avoids.
  const sides = [];
  const covered = [];
  const broken = [];
  let crossed = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const n = 5 + (seed % 11);
    const d = valid(bigDiagram(seed, { n, m: n + (seed % (n + 1)), groups: Math.min(seed % 4, Math.floor(n / 3)) }));
    for (const direction of ['right', 'down']) {
      const layout = layoutDiagram({ ...d, direction });
      const name = `seed ${seed} ${direction}`;
      sides.push(...sideBySide(layout).map((p) => `${name}: ${p}`));
      covered.push(...labelsOverLines(layout).map((p) => `${name}: ${p}`));
      if (problems(layout).length) broken.push(`${name}: ${problems(layout)[0]}`);
      crossed += crossingsOf(layout);
    }
  }
  check('600 small layouts: no two arrows run side by side closer than 4 px', sides.length === 0, `${sides.length}: ${sides.slice(0, 3).join(' | ')}`);
  check('  no label lies on another arrow\'s line', covered.length === 0, `${covered.length}: ${covered.slice(0, 3).join(' | ')}`);
  check('  and no rule is broken', broken.length === 0, broken.slice(0, 3).join(' | '));
  // The lane order's local search is what keeps arrows from crossing needlessly: the greedy
  // order alone gave 2,246 crossings here, the search 1,446. A ceiling, so it may only fall.
  check('  and their arrows cross each other at most 1,500 times in all', crossed <= 1500, `${crossed}`);
}

section('a big diagram: every rule holds, quickly');
{
  // Each timing is the quickest of 5 runs, against the same 200 ms (review, fix round 5): a busy
  // machine slows some runs and not others, while a real slowdown slows every run, so the
  // quickest still catches it.
  const quickest = (work, runs = 5) => {
    let best = Infinity;
    let value;
    for (let i = 0; i < runs; i += 1) {
      const t = performance.now();
      value = work();
      best = Math.min(best, performance.now() - t);
    }
    return { best, value };
  };
  let worst = 0;
  let labels = 0;
  const broken = [];
  const covering = [];
  for (let seed = 1; seed <= 24; seed += 1) {
    const d = valid(bigDiagram(seed));
    for (const direction of ['right', 'down']) {
      const { best, value: layout } = quickest(() => layoutDiagram({ ...d, direction }));
      worst = Math.max(worst, best);
      const wrong = problems(layout);
      if (wrong.length) broken.push(`seed ${seed} ${direction}: ${wrong.slice(0, 2).join(' | ')}`);
      labels += layout.edges.filter((e) => e.labelBox).length;
      covering.push(...labelsOverLines(layout).map((name) => `seed ${seed} ${direction}: ${name}`));
    }
  }
  check('48 random 40-node, 80-edge drawings (cycles, loops, groups, labels, pills) break no rule', broken.length === 0, broken.slice(0, 3).join(' || '));
  // Without room kept at a labelled port, 136 of these labels covered a neighbour's line.
  check(`  and none of their ${labels} labels covers another arrow's line`, covering.length === 0, `${covering.length}: ${covering.slice(0, 3).join(' | ')}`);
  check('the slowest of them (each the quickest of 5 runs) lays out in under 200 ms', worst < 200, `${worst.toFixed(1)} ms`);
  const cold = bigDiagram(99);
  const once = quickest(() => layoutDiagram(valid(cold))).best;
  check('40 nodes and 80 edges, validated and laid out, in under 200 ms (quickest of 5)', once < 200, `${once.toFixed(1)} ms`);
  // The label search's worst case: 41 labelled edges, each through ~37 ranks of dummies, so
  // every label has long runs to slide along (took up to 350 ms before the search looked only
  // at lines near each run). Task 2's "auto" lays a drawing out twice.
  const chain = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const longEdges = valid({
    nodes: chain.map((id) => ({ id, title: `Bước ${id}` })),
    edges: [...chain.slice(1).map((id, i) => ({ from: chain[i], to: id })), ...Array.from({ length: 41 }, (_, k) => ({ from: `c${k % 3}`, to: `c${39 - (k % 5)}`, label: `đường dài số ${k}` }))],
  });
  // Both ways, as "auto" will: together within the one budget.
  const { best: took, value: both } = quickest(() => ['right', 'down'].map((direction) => layoutDiagram({ ...longEdges, direction })));
  check('a 40-box chain with 41 labelled long edges, laid out both ways, in under 200 ms together (quickest of 5)', took < 200, `${took.toFixed(1)} ms`);
  for (const [i, direction] of ['right', 'down'].entries()) {
    const layout = both[i];
    check(`${direction}: every label of it off every line, no rule broken`, labelsOverLines(layout).length === 0 && problems(layout).length === 0, `${labelsOverLines(layout).length} on lines`);
    // Its crowded gaps are where a lane order once kept two ways 1–2 px apart rather than
    // take a dozen crossings; lines under 4 px apart now count as one line.
    check(`${direction}:   and no two of its arrows run side by side`, sideBySide(layout).length === 0, sideBySide(layout).join(' | '));
  }
}

// ── Task 2: auto direction, icons, the drawing itself ────────────────────────

// The owner's 4-layer pipeline (the screenshot that started this), rebuilt as a diagram: 12
// boxes in 4 layer groups, with icons, pills, an aside, labels, a dashed line and a cycle.
const ownerPipeline = {
  groups: [
    { id: 't1', title: 'Tầng 1 — Ứng dụng' },
    { id: 't2', title: 'Tầng 2 — Nén ngữ cảnh' },
    { id: 't3', title: 'Tầng 3 — Suy luận' },
    { id: 't4', title: 'Tầng 4 — Lưu trữ' },
  ],
  nodes: [
    { id: 'user', title: 'Người dùng', kind: 'pill', icon: 'user' },
    { id: 'raptor', title: 'RAPTOR', lines: ['cây tóm tắt nhiều tầng'], group: 't1', icon: 'document' },
    { id: 'memgpt', title: 'MemGPT, Mem0', lines: ['bộ nhớ dài hạn cho tác tử'], group: 't1', icon: 'chat' },
    { id: 'lingua', title: 'LLMLingua', lines: ['nén prompt 4–20 lần'], group: 't2', icon: 'gear' },
    { id: 'rerank', title: 'Xếp hạng lại', lines: ['giữ đoạn liên quan nhất'], group: 't2', icon: 'search' },
    { id: 'router', title: 'Định tuyến mô hình', lines: ['theo chi phí và độ trễ'], group: 't3', icon: 'server' },
    { id: 'kv', title: 'KV cache', lines: ['dùng lại tiền tố đã tính'], group: 't3', icon: 'cache' },
    { id: 'llm', title: 'Mô hình ngôn ngữ', lines: ['sinh câu trả lời'], group: 't3', icon: 'bolt' },
    { id: 'vec', title: 'CSDL vector', lines: ['tìm theo ngữ nghĩa'], group: 't4', icon: 'database' },
    { id: 'obj', title: 'Kho tài liệu', group: 't4', icon: 'cloud' },
    { id: 'cost', title: 'Nhật ký & đo lường', lines: ['chi phí <mỗi lượt>'], kind: 'note', icon: 'chart' },
    { id: 'answer', title: 'Câu trả lời', kind: 'pill', icon: 'lock' },
  ],
  edges: [
    { from: 'user', to: 'raptor', label: 'câu hỏi' },
    { from: 'user', to: 'memgpt' },
    { from: 'raptor', to: 'lingua', label: 'ngữ cảnh' },
    { from: 'memgpt', to: 'lingua' },
    { from: 'lingua', to: 'rerank', label: 'prompt đã nén' },
    { from: 'rerank', to: 'router' },
    { from: 'router', to: 'kv' },
    { from: 'router', to: 'llm' },
    { from: 'kv', to: 'llm', label: 'tiền tố', style: 'dashed' },
    { from: 'llm', to: 'answer', label: 'luồng token' },
    { from: 'rerank', to: 'vec', label: 'truy vấn', style: 'dashed' },
    { from: 'obj', to: 'vec', label: 'nhúng' },
    { from: 'vec', to: 'rerank' },
    { from: 'llm', to: 'cost', style: 'dashed' },
  ],
};

/**
 * What a demanding reader sees wrong in a laid-out drawing (review, fix round 1), each as a
 * list of findings. Coordinates are the drawing's own units.
 *   jogs        an interior segment under 12: a step for no reason (B3)
 *   meets       an edge's point within 12 of, and in line with, another edge's segment:
 *               two arrows that read as one line (B4)
 *   crossings   two edges crossing (B5)
 *   foreign     a segment through a group that holds neither of its ends (B5)
 *   borders     a label touching a group's border (B6)
 *   loops       a self-loop, or its label, leaving its own group (B6)
 *   bends       an edge with more than 4 bends (B7)
 *   nearLabels  a segment within 10 of another edge's label (B7)
 *   groupGaps   two groups nearer than 24 (C10)
 *   titles      a segment through a group's title (C9)
 */
function quality(drawn) {
  const layout = boxed(drawn);
  const q = { jogs: [], meets: [], crossings: [], foreign: [], borders: [], loops: [], bends: [], nearLabels: [], groupGaps: [], titles: [] };
  const name = (e) => `${e.from}→${e.to}`;
  const segs = layout.edges.map((e) => e.points.slice(1).map((p, k) => [e.points[k], p]));
  const flat = ([a, b]) => Math.abs(a[1] - b[1]) < 0.01;
  const len = ([a, b]) => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
  const lo = (s, ax) => Math.min(s[0][ax], s[1][ax]);
  const hi = (s, ax) => Math.max(s[0][ax], s[1][ax]);
  // Does an axis-parallel segment meet the open box (grown by `pad`)?
  const meetsBox = (s, b, pad = 0) => hi(s, 0) > b.x - pad && lo(s, 0) < b.x + b.w + pad && hi(s, 1) > b.y - pad && lo(s, 1) < b.y + b.h + pad;
  const groupOf = new Map(layout.nodes.map((n) => [n.id, n.group]));
  layout.edges.forEach((e, i) => {
    segs[i].forEach((s, k) => {
      if (k > 0 && k < segs[i].length - 1 && len(s) < 12) q.jogs.push(`${name(e)}: ${len(s).toFixed(1)}`);
    });
    if (e.points.length - 2 > 4) q.bends.push(`${name(e)}: ${e.points.length - 2}`);
    for (const g of layout.groups) {
      if (groupOf.get(e.from) === g.id || groupOf.get(e.to) === g.id) continue;
      if (segs[i].some((s) => hi(s, 0) > g.x + 1 && lo(s, 0) < g.x + g.w - 1 && hi(s, 1) > g.y + 1 && lo(s, 1) < g.y + g.h - 1)) q.foreign.push(`${name(e)} through ${g.id}`);
    }
    for (const g of layout.groups) if (g.titleBox && segs[i].some((s) => meetsBox(s, g.titleBox, 2))) q.titles.push(`${name(e)} through ${g.id}'s title`);
  });
  for (let i = 0; i < layout.edges.length; i += 1) {
    for (let j = 0; j < layout.edges.length; j += 1) {
      if (i === j) continue;
      const [A, B] = [layout.edges[i], layout.edges[j]];
      // An end of A in line with a segment of B, within 12 of it — unless both end on one port.
      const ends = [A.points[0], A.points.at(-1)];
      for (const p of A.points) {
        for (const s of segs[j]) {
          const ax = flat(s) ? 1 : 0;
          if (Math.abs(p[ax] - s[0][ax]) > 0.5) continue;
          const along = 1 - ax;
          const off = Math.max(0, lo(s, along) - p[along], p[along] - hi(s, along));
          const samePort = ends.some((t) => [B.points[0], B.points.at(-1)].some((u) => Math.abs(t[0] - u[0]) < 0.5 && Math.abs(t[1] - u[1]) < 0.5));
          if (off <= 12 && !samePort) {
            q.meets.push(`${name(A)} and ${name(B)} at ${Math.round(p[0])},${Math.round(p[1])}`);
            break;
          }
        }
      }
      if (j > i) {
        for (const s of segs[i]) {
          for (const t of segs[j]) {
            if (flat(s) === flat(t)) continue;
            const [h, v] = flat(s) ? [s, t] : [t, s];
            const [x, y] = [v[0][0], h[0][1]];
            if (x > lo(h, 0) + 0.5 && x < hi(h, 0) - 0.5 && y > lo(v, 1) + 0.5 && y < hi(v, 1) - 0.5) q.crossings.push(`${name(A)} × ${name(B)}`);
          }
        }
      }
    }
    const e = layout.edges[i];
    if (e.labelBox) {
      for (const g of layout.groups) {
        const b = e.labelBox;
        const touches = b.x - 2 < g.x + g.w && b.x + b.w + 2 > g.x && b.y - 2 < g.y + g.h && b.y + b.h + 2 > g.y;
        const inside = b.x - 2 >= g.x && b.y - 2 >= g.y && b.x + b.w + 2 <= g.x + g.w && b.y + b.h + 2 <= g.y + g.h;
        if (touches && !inside) q.borders.push(`"${e.label}" on ${g.id}'s border`);
      }
      layout.edges.forEach((o, j) => {
        if (j !== i && segs[j].some((s) => meetsBox(s, e.labelBox, 10))) q.nearLabels.push(`${name(o)} within 10 of "${e.label}"`);
      });
    }
    if (e.from === e.to && groupOf.get(e.from)) {
      const g = layout.groups.find((x) => x.id === groupOf.get(e.from));
      const within = (p) => p[0] >= g.x + 4 && p[0] <= g.x + g.w - 4 && p[1] >= g.y + 4 && p[1] <= g.y + g.h - 4;
      const box = e.labelBox;
      if (!e.points.every(within) || (box && !(within([box.x, box.y]) && within([box.x + box.w, box.y + box.h])))) q.loops.push(`${name(e)} leaves ${g.id}`);
    }
  }
  for (let i = 0; i < layout.groups.length; i += 1) {
    for (let j = i + 1; j < layout.groups.length; j += 1) {
      const [a, b] = [layout.groups[i], layout.groups[j]];
      const gap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
      if (gap < 24 - 1e-6) q.groupGaps.push(`${a.id}/${b.id}: ${gap.toFixed(1)}`);
    }
  }
  return q;
}
/**
 * Edges that could run straight but bend (fix round 2, item 1): their boxes overlap across by
 * more than the port margin (8 from each corner; on a pill, from where its curve meets the
 * side), and some line across that overlap meets nothing between them — no other box, group
 * that holds neither end, nor another edge's end on either facing side. Labels and group titles
 * are not in the way: they move for a straight line (the ruling: "move the label rather than
 * bend the edge"), so where they ended up says nothing.
 */
function couldBeStraight(drawn) {
  const layout = boxed(drawn);
  const out = [];
  const right = layout.direction === 'right';
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const groupOf = new Map(layout.nodes.map((n) => [n.id, n.group]));
  const lo = (b) => (right ? b.y : b.x);
  const hi = (b) => (right ? b.y + b.h : b.x + b.w);
  const m0 = (b) => (right ? b.x : b.y);
  const m1 = (b) => (right ? b.x + b.w : b.y + b.h);
  const inset = (n) => (n.kind === 'pill' ? Math.max(8, n.radius - 6) : 8);
  for (const e of layout.edges) {
    if (e.from === e.to || e.points.length === 2) continue;
    const [A, B] = [byId.get(e.from), byId.get(e.to)];
    const [first, second] = m0(A) < m0(B) ? [A, B] : [B, A];
    const from = Math.max(lo(A) + inset(A), lo(B) + inset(B));
    const to = Math.min(hi(A) - inset(A), hi(B) - inset(B));
    const [start, end] = [m1(first), m0(second)];
    if (to < from || end <= start) continue;
    const blocks = [...layout.nodes.filter((n) => n !== A && n !== B), ...layout.groups.filter((g) => g.id !== groupOf.get(e.from) && g.id !== groupOf.get(e.to))];
    // A line passing a box keeps 12 from it, as the layout's stand-ins do.
    const taken = blocks.filter((b) => m1(b) > start && m0(b) < end).map((b) => [lo(b) - 12, hi(b) + 12]);
    // Every end on a facing side keeps its order and its room (an end leaving with a label,
    // half the label and 6; a loop's leg at least 6; any other 4): the line's own end can reach
    // only as far as the ends before and after it leave room.
    let [a, b] = [from, to];
    for (const [box, at] of [[first, start], [second, end]]) {
      const ends = [];
      for (const x of layout.edges) {
        x.points.forEach((p, k) => {
          if ((k !== 0 && k !== x.points.length - 1) || Math.abs((right ? p[0] : p[1]) - at) > 0.5) return;
          const across = right ? p[1] : p[0];
          if (across < lo(box) - 0.5 || across > hi(box) + 0.5) return;
          // The label's room is kept where the line leaves in the layout's own direction: the
          // drawn end of an edge turned round to break a cycle.
          const labelled = x.labelBox && k === (x.reversed ? x.points.length - 1 : 0);
          // Fix round 4: any other end keeps 8 (16 between two), and an arrowhead 10.
          const plain = labelled ? (right ? x.labelBox.h : x.labelBox.w) / 2 + 6 : 8;
          const half = k === x.points.length - 1 ? Math.max(plain, 10) : plain;
          ends.push({ across, half, own: x === e, edge: x });
        });
      }
      ends.sort((p, q) => p.across - q.across);
      const i = ends.findIndex((p) => p.own);
      if (i < 0) continue;
      // Neighbours stand 20 apart (a two-way pair 24) where the side is long enough; on a side
      // too short, its length is shared out evenly, never under their two halves (fix round 4).
      const corner = inset(box);
      const least = ends.slice(1).map((p, j) => ends[j].half + p.half);
      const pair = (p, q) => p.edge.from === q.edge.to && p.edge.to === q.edge.from;
      const want = least.map((m, j) => Math.max(m, pair(ends[j], ends[j + 1]) ? 24 : 20));
      const span = hi(box) - Math.max(corner, ends.at(-1).half) - (lo(box) + Math.max(corner, ends[0].half));
      const [sumLeast, sumWant] = [least, want].map((list) => list.reduce((t, v) => t + v, 0));
      const f = sumWant <= span ? 1 : sumWant > sumLeast ? Math.min(1, Math.max(0, (span - sumLeast) / (sumWant - sumLeast))) : 0;
      const gaps = least.map((m, j) => m + f * (want[j] - m));
      const before = gaps.slice(0, i).reduce((t, v) => t + v, 0);
      const after = gaps.slice(i).reduce((t, v) => t + v, 0);
      a = Math.max(a, lo(box) + (i ? Math.max(corner, ends[0].half) : corner) + before);
      b = Math.min(b, hi(box) - (i < ends.length - 1 ? Math.max(corner, ends.at(-1).half) : corner) - after);
    }
    // An edge with both ends in one group runs inside it: within its margin, below its title.
    const own = groupOf.get(e.from) && groupOf.get(e.from) === groupOf.get(e.to) ? layout.groups.find((g) => g.id === groupOf.get(e.from)) : null;
    if (own) {
      const top = own.titleBox && right ? own.titleBox.y + own.titleBox.h + 10 : lo(own) + 16;
      a = Math.max(a, top);
      b = Math.min(b, hi(own) - 16);
    }
    const free = [a, b, ...taken.flatMap(([u, v]) => [u, v])].some((v) => v >= a - 1e-9 && v <= b + 1e-9 && taken.every(([p, q]) => v <= p + 1e-9 || v >= q - 1e-9));
    if (free) out.push(`${e.from}→${e.to}`);
  }
  return out;
}
// Fix round 4: arrowheads into one box closer than `apart` (tips arriving the same way), and
// two edges running side by side closer than `near` for more than 12 units (review: packed at 8,
// pipeline cache→done and db→done ran 8 apart for 32 units; the owner's rerank↔vec cycle was
// two nested hooks 8 apart).
function crowding(drawn, { apart = 20, near = 16 } = {}) {
  const layout = boxed(drawn);
  const heads = [];
  const alongside = [];
  const tips = new Map();
  for (const e of layout.edges) {
    const [p, q] = [e.points.at(-1), e.points.at(-2)];
    const way = `${Math.sign(p[0] - q[0])},${Math.sign(p[1] - q[1])}`;
    if (!tips.has(e.to)) tips.set(e.to, []);
    tips.get(e.to).push({ p, way, e });
  }
  for (const [box, list] of tips) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [a, b] = [list[i], list[j]];
        const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
        if (a.way === b.way && d < apart - 1e-6) heads.push(`into ${box}: ${a.e.from}→${a.e.to} & ${b.e.from}→${b.e.to} ${d.toFixed(1)} apart`);
      }
    }
  }
  const segs = layout.edges.map((e) => e.points.slice(1).map((p, k) => [e.points[k], p]));
  const flat = ([a, b]) => Math.abs(a[1] - b[1]) < 0.01;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      for (const s of segs[i]) {
        for (const t of segs[j]) {
          if (flat(s) !== flat(t)) continue;
          const [ax, along] = flat(s) ? [1, 0] : [0, 1];
          const d = Math.abs(s[0][ax] - t[0][ax]);
          const shared = Math.min(Math.max(s[0][along], s[1][along]), Math.max(t[0][along], t[1][along])) - Math.max(Math.min(s[0][along], s[1][along]), Math.min(t[0][along], t[1][along]));
          if (d < near - 1e-6 && shared > 12) alongside.push(`${layout.edges[i].from}→${layout.edges[i].to} & ${layout.edges[j].from}→${layout.edges[j].to}: ${d.toFixed(1)} apart for ${shared.toFixed(0)}`);
        }
      }
    }
  }
  return { heads, alongside };
}
// The reviewer's 80 dense layouts (fix round 4): 40 boxes, 80 edges, 8 groups, half the edges
// labelled, short and long group titles, both directions.
function denseDiagram(seed, longTitles) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const groups = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, title: longTitles ? `Nhóm ${i + 1} — ${'xử lý ngữ cảnh dài '.repeat(4)}`.slice(0, 60) : `Nhóm ${i + 1}` }));
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `Bước xử lý ${i}`, lines: rand() < 0.5 ? ['một dòng mô tả ngắn'] : [], ...(i < 32 ? { group: `g${Math.floor(i / 4)}` } : {}) }));
  const edges = [];
  for (let k = 0; k < 80; k += 1) {
    const a = Math.floor(rand() * 40);
    let b = Math.floor(rand() * 40);
    if (b <= a) b = Math.min(39, a + 1 + Math.floor(rand() * 6));
    edges.push({ from: `n${a}`, to: `n${b}`, ...(rand() < 0.5 ? { label: `nhãn ${k}` } : {}) });
  }
  return { groups, nodes, edges };
}
// Fix round 5: a line passing outside a group keeps 16 from its border, as it keeps 24 from a
// box (owner auto: vec→rerank ran 8 under Tầng 2's bottom border and read as its edge).
function hugs(drawn, near = 16) {
  const layout = boxed(drawn);
  const out = [];
  for (const e of layout.edges) {
    for (let k = 1; k < e.points.length; k += 1) {
      const [a, b] = [e.points[k - 1], e.points[k]];
      const flat = Math.abs(a[1] - b[1]) < 0.01;
      const [ax, al] = flat ? [1, 0] : [0, 1];
      for (const g of layout.groups) {
        const borders = flat ? [g.y, g.y + g.h] : [g.x, g.x + g.w];
        const [lo, hi] = flat ? [g.x, g.x + g.w] : [g.y, g.y + g.h];
        const inside = a[ax] > borders[0] && a[ax] < borders[1];
        if (inside) continue;
        for (const border of borders) {
          const d = Math.abs(a[ax] - border);
          const shared = Math.min(Math.max(a[al], b[al]), hi) - Math.max(Math.min(a[al], b[al]), lo);
          if (d < near - 1e-6 && shared > 12) out.push(`${e.from}→${e.to} ${d.toFixed(1)} from ${g.id}'s border for ${shared.toFixed(0)}`);
        }
      }
    }
  }
  return out;
}
// Interior steps under `under` units (fix round 4, item 5: 12 read as a wobble; 20 where it fits).
const steps = (layout, under) =>
  layout.edges.flatMap((e) =>
    e.points
      .slice(1)
      .map((p, k) => [e.points[k], p])
      .flatMap(([a, b], k, all) => (k > 0 && k < all.length - 1 && Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) < under - 1e-6 ? [`${e.from}→${e.to}: ${(Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])).toFixed(1)} at ${Math.round(a[0])},${Math.round(a[1])}`] : [])),
  );
const QUALITY_KINDS = ['jogs', 'meets', 'crossings', 'foreign', 'borders', 'loops', 'bends', 'nearLabels', 'groupGaps', 'titles', 'straight', 'wraps', 'hugs'];
// Counts over the 600 random small layouts after fix round 2, as ceilings, so its gains stay
// (fix round 2, item 3; before round 1 they were jogs 1,322, meets 174, crossings 1,446,
// foreign 522, borders 247, loops 346, bends 582, near labels 1,205, group gaps 224; before
// round 2, could-be-straight 155).
// Fix round 4 locked the counts after it (they were jogs 154, meets 62, crossings 1,224, bends
// 172, near labels 38, straight 77 after round 2). Crossings rose by 8: ports 20 apart do not
// always reach the place across a crossing would be avoided from. "straight" now judges each end
// by the spacing the layout keeps (20 apart where the side allows, 16 at least).
// Fix round 5: lines within 16 of a group border they pass outside of, 550 after round 4, are
// counted ("hugs"). Pills reserve exactly what their ports need, which cost 4 jogs (37 → 41);
// keeping 16 from group borders moved two meets (20 → 22), both at a loop's leg.
const SWEEP_CEILING = { jogs: 41, meets: 22, crossings: 1232, foreign: 270, borders: 0, loops: 0, bends: 139, nearLabels: 1, groupGaps: 0, titles: 0, straight: 70, wraps: 0, hugs: 8 };
// How much of a group is empty: its area less its members'.
const emptyShare = (layout, g) => 1 - layout.nodes.filter((n) => n.group === g.id).reduce((s, n) => s + n.w * n.h, 0) / (g.w * g.h);

// The reviewer's third fixture (fix round 1): four groups, every kind of box, all but two icons.
const iconsFixture = {
  groups: [{ id: 'edge', title: 'Edge' }, { id: 'svc', title: 'Services' }, { id: 'data', title: 'Data' }, { id: 'ops', title: 'Operations' }],
  nodes: [
    { id: 'u', title: 'Customer', icon: 'user', kind: 'pill' },
    { id: 'cdn', title: 'CDN', lines: ['static assets'], icon: 'cloud', group: 'edge' },
    { id: 'gw', title: 'API gateway', lines: ['rate limits', 'auth check'], icon: 'server', group: 'edge' },
    { id: 'auth', title: 'Auth', icon: 'lock', group: 'svc' },
    { id: 'search', title: 'Search', icon: 'search', group: 'svc' },
    { id: 'chat', title: 'Chat service', lines: ['streams replies'], icon: 'chat', group: 'svc' },
    { id: 'cache', title: 'Redis cache', icon: 'cache', group: 'data' },
    { id: 'db', title: 'Postgres', icon: 'database', group: 'data' },
    { id: 'docs', title: 'Object store', icon: 'document', group: 'data' },
    { id: 'jobs', title: 'Workers', icon: 'gear', group: 'ops' },
    { id: 'events', title: 'Event bus', icon: 'bolt', group: 'ops' },
    { id: 'metrics', title: 'Metrics', icon: 'chart', group: 'ops' },
    { id: 'note', title: 'Nightly backups', kind: 'note' },
  ],
  edges: [
    { from: 'u', to: 'cdn' }, { from: 'cdn', to: 'gw', label: 'HTTPS' }, { from: 'gw', to: 'auth' }, { from: 'gw', to: 'search' }, { from: 'gw', to: 'chat' },
    { from: 'search', to: 'cache', label: 'hit' }, { from: 'chat', to: 'db' }, { from: 'chat', to: 'events', style: 'dashed' }, { from: 'events', to: 'jobs' },
    { from: 'jobs', to: 'docs' }, { from: 'jobs', to: 'metrics', style: 'dashed' }, { from: 'db', to: 'note', style: 'dashed' },
  ],
};

/** Whether markup is well-formed XML: quoted attributes, escaped text, every tag closed in order, one root. */
function wellFormed(xml) {
  const stack = [];
  let roots = 0;
  let at = 0;
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const between = xml.slice(at, m.index);
    if (/[<>]/.test(between) || /&(?!(?:amp|lt|gt|quot|#39);)/.test(between)) return `bad text before ${m[0].slice(0, 30)}`;
    at = m.index + m[0].length;
    const [, closing, name, , self] = m;
    if (closing) {
      if (stack.pop() !== name) return `</${name}> closes the wrong tag`;
    } else {
      if (!stack.length) roots += 1;
      if (!self) stack.push(name);
    }
  }
  if (at !== xml.length) return 'text after the root, or a tag that did not parse';
  if (stack.length) return `<${stack.at(-1)}> is never closed`;
  return roots === 1 ? '' : `${roots} roots`;
}
const pathPoints = (d) => [...d.matchAll(/([ML])(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[2]), Number(m[3])]);
const drawOf = (input, options) => {
  const diagram = valid(input);
  const layout = layoutDiagram(diagram);
  return { diagram, layout, svg: renderDiagram(layout, { theme: diagram.theme, ...options }) };
};

section('"auto" lays a drawing out both ways and keeps the one the page shows best');
{
  const chain = (k) => ({ nodes: nodes(k), edges: Array.from({ length: k - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })) });
  const long = layoutDiagram(valid(chain(8)));
  check('a long chain goes down: going right its titles would show under 11 px', long.direction === 'down', `${long.direction} ${Math.round(long.width)}×${Math.round(long.height)}`);
  const short = layoutDiagram(valid(chain(3)));
  check('a short chain goes right: readable either way, and shorter on the page', short.direction === 'right', `${short.direction} ${Math.round(short.width)}×${Math.round(short.height)}`);
  const fan = { nodes: nodes(7), edges: Array.from({ length: 6 }, (_, i) => ({ from: 'n0', to: `n${i + 1}` })) };
  const wide = layoutDiagram(valid(fan));
  check('one box fanning out to six goes down: readable either way, and shorter on the page', wide.direction === 'down', `${wide.direction} ${Math.round(wide.width)}×${Math.round(wide.height)}`);
  check('  and each is exactly the layout that direction gives', isDeepStrictEqual(short, layoutDiagram({ ...valid(chain(3)), direction: 'right' })) && isDeepStrictEqual(long, layoutDiagram({ ...valid(chain(8)), direction: 'down' })) && isDeepStrictEqual(wide, layoutDiagram({ ...valid(fan), direction: 'down' })));
  // Fix round 3: judged by the page's own rule (public/js/drawing-fit.js) — its column (710 px, fix round 4) of
  // an 800 px window, a narrow drawing grown up to twice, the 72 % height cap, which a server-
  // laid-out diagram's titles never shrink under 11 px for. Worked out here from that module.
  const render = fs.readFileSync(new URL('../public/js/render.js', import.meta.url), 'utf8');
  check('the page sizes drawings by the shared rule, and passes a diagram\'s readable scale from its widget', /import \{[^}]*\bdrawingHeightCap\b[^}]*\} from '\.\/drawing-fit\.js'/.test(render) && /fitDrawing\(drawing, widget\.readableScale\)/.test(render) && /drawingHeightCap\(\{/.test(render) && !/innerHeight \|\| view\?\.innerHeight \|\| 800\) \* 0\.72/.test(render) && FIT.column === DRAWING_FIT.column && FIT.window === DRAWING_FIT.window && FIT.readablePx === 11);
  const onPage = (l) => {
    const across = Math.min(2, DRAWING_FIT.column / l.width);
    const cap = drawingHeightCap({ windowHeight: 800, viewWidth: l.width, viewHeight: l.height, shownWidth: l.width * across, readableScale: 11 / TEXT.titleSize });
    const scale = Math.min(across, cap / l.height);
    return { title: TEXT.titleSize * scale, height: l.height * scale };
  };
  const shownBefore = { owner: 6.2, icons: 7.5, pipeline: 8.7 };
  for (const [name, input] of [['owner', ownerPipeline], ['icons', iconsFixture], ['pipeline', pipeline]]) {
    const auto = layoutDiagram(valid(input));
    const p = onPage(auto);
    check(`${name}: auto's titles show at 11 px or more in the ${DRAWING_FIT.column} px column of an 800 px window (was ${shownBefore[name]})`, p.title >= 11 - 1e-9, `${auto.direction}: ${p.title.toFixed(1)} px, ${Math.round(p.height)} px tall`);
    const other = layoutDiagram({ ...valid(input), direction: auto.direction === 'right' ? 'down' : 'right' });
    const q = onPage(other);
    check(`${name}:   and of the ways that read, the shorter on the page (within 5 %)`, q.title < 11 - 1e-9 || p.height <= q.height * 1.05 + 1e-9, `${auto.direction} ${Math.round(p.height)} px against ${other.direction} ${Math.round(q.height)} px (${q.title.toFixed(1)} px titles)`);
    check(`${name}:   shownSize agrees with the page's rule`, Math.abs(shownSize(auto).title - p.title) < 1e-9 && Math.abs(shownSize(auto).height - p.height) < 1e-9);
  }
  // The rule itself, on boxes only.
  const box = (width, height, tag) => ({ width, height, tag });
  check('readable beats unreadable: 897 wide beats 1,422 wide', chooseDirection(box(1422, 511, 'r'), box(897, 991, 'd')).tag === 'd');
  check('  however tall: 600 × 1,400 (readable, taller) beats 1,000 × 300 (titles 9.9 px)', chooseDirection(box(1000, 300, 'r'), box(600, 1400, 'd')).tag === 'd');
  check('  both readable: the shorter on the page wins', chooseDirection(box(900, 560, 'r'), box(760, 500, 'd')).tag === 'r' && chooseDirection(box(700, 120, 'r'), box(400, 260, 'd')).tag === 'r');
  check('  neither readable: the larger titles win', chooseDirection(box(1600, 400, 'r'), box(1400, 900, 'd')).tag === 'd');
  check('  within 5 % on the page, the shape closer to 16:10 decides', chooseDirection(box(760, 470, 'r'), box(760, 476, 'd')).tag === 'd');
  check('  and a tie keeps right', chooseDirection(box(800, 500, 'r'), box(800, 500, 'd')).tag === 'r');
  check('"right" and "down" still force their way', layoutDiagram(valid({ ...chain(8), direction: 'right' })).direction === 'right' && layoutDiagram(valid({ ...fan, direction: 'right' })).direction === 'right');
}

section('icons: twelve of them, each drawn, an unknown one refused');
{
  check('the twelve the spec names', ICON_NAMES.join() === 'user,server,database,cloud,cache,gear,document,chat,lock,chart,search,bolt', ICON_NAMES.join());
  const plain = measureNode({ title: 'Cơ sở dữ liệu', lines: ['Postgres'] });
  const pictured = measureNode({ title: 'Cơ sở dữ liệu', lines: ['Postgres'], icon: 'database' });
  check('a box with an icon is 22 px taller (16 and a 6 px gap) and no wider', pictured.textH - plain.textH === TEXT.iconSize + TEXT.iconGap && pictured.w === plain.w, `${pictured.textH - plain.textH}`);
  const wrong = [];
  for (const name of ICON_NAMES) {
    const { layout, svg } = drawOf({ groups: [{ id: 'g', title: 'Nhóm' }], nodes: [{ id: 'a', title: `Biểu tượng ${name}`, icon: name, group: 'g' }, { id: 'b', title: 'Đích' }], edges: [{ from: 'a', to: 'b' }] });
    const [n] = layout.nodes;
    const g = new RegExp(`<g transform="translate\\(([\\d.]+) ([\\d.]+)\\) scale\\(0\\.67\\)"[^>]*stroke="${palette().accents[0].ink}"[^>]*>${ICONS[name].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</g>`).exec(svg);
    const issues = checkDiagram(svg).issues;
    if (!g) wrong.push(`${name}: not drawn in its group's accent`);
    else if (Math.abs(Number(g[1]) + 8 - (n.textBox.x + n.textBox.w / 2)) > 0.01 || Math.abs(Number(g[2]) - n.textBox.y) > 0.01) wrong.push(`${name}: not centred at the top of the text`);
    if (wellFormed(svg)) wrong.push(`${name}: ${wellFormed(svg)}`);
    if (issues.length) wrong.push(`${name}: ${issues[0]}`);
  }
  check('every icon renders: in its group\'s accent, centred above the title, well-formed, nothing for the check to find', wrong.length === 0, wrong.slice(0, 3).join(' | '));
  check('an unknown icon is refused, with the known ones listed', ICON_NAMES.every((name) => refused({ nodes: [{ id: 'a', title: 'x', icon: 'spaceship' }] }).includes(name)));
}

section('the drawing: well-formed, escaped, one marker, every edge where the layout put it');
{
  const { layout, svg } = drawOf({ ...pipeline, direction: 'right' }, { title: 'Luồng "A" & <B>' });
  check('well-formed XML', wellFormed(svg) === '', wellFormed(svg));
  check('one <svg> with its namespace, a viewBox fitted to the layout and system-ui', /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" id="d[0-9a-z]+" viewBox="0 0 [\d.]+ [\d.]+"/.test(svg) && svg.includes(`viewBox="0 0 ${Math.round(layout.width * 100) / 100} ${Math.round(layout.height * 100) / 100}"`) && svg.includes('font-family: system-ui, sans-serif') && svg.endsWith('</svg>'));
  // Review E13: a kept .svg pasted inline elsewhere styles only itself.
  const rootId = /^<svg [^>]*id="(d[0-9a-z]+)"/.exec(svg)?.[1];
  const css = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] || '';
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
  check('every style rule is scoped under the drawing\'s own id', !!rootId && selectors.length >= 6 && selectors.every((s) => s.startsWith(`#${rootId} `)), selectors.join(' | '));
  // Review E14: only the icon set's own keys are icons; "constructor" is on every object.
  const odd = layoutDiagram(valid({ nodes: [{ id: 'a', title: 'A' }] }));
  odd.nodes[0].icon = 'constructor';
  const oddSvg = renderDiagram(odd);
  check('a node whose icon names an inherited property draws no icon, and no source text', !/native code|function/.test(oddSvg) && !/<g transform=/.test(oddSvg), oddSvg.slice(0, 80));
  check('wider than 1,200, it is shown 1,200 wide and scaled through the viewBox', layout.width > 1200 && svg.includes('width="1200"') && svg.includes(`height="${Math.round((layout.height * 1200) / layout.width)}"`), `${Math.round(layout.width)} wide`);
  check('the caption is its accessible name, escaped', svg.includes('aria-label="Luồng &quot;A&quot; &amp; &lt;B&gt;"'));
  check('exactly one <marker>', (svg.match(/<marker\b/g) || []).length === 1);
  const paths = [...svg.matchAll(/<path d="(M[^"]*)"([^>]*)\/>/g)].filter((m) => /marker-end/.test(m[2]));
  const matches = layout.edges.every((e, i) => {
    const got = pathPoints(paths[i]?.[1] || '');
    return got.length === e.points.length && got.every(([x, y], k) => Math.abs(x - e.points[k][0]) < 0.01 && Math.abs(y - e.points[k][1]) < 0.01);
  });
  check('one path per edge, M…L…, each through exactly its points', paths.length === layout.edges.length && matches && paths.every((m) => /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/.test(m[1])));
  check('  each ending in the one marker', paths.every((m) => /marker-end="url\(#a[0-9a-z]+\)"/.test(m[2])));
  check('  dashed exactly where the edge says so, at 5/4', layout.edges.every((e, i) => /stroke-dasharray="5 4"/.test(paths[i][2]) === (e.style === 'dashed')));

  const escaped = drawOf({ nodes: [{ id: 'a', title: 'A < B & "C"', lines: ["it's <b>"] }, { id: 'b', title: 'D' }], edges: [{ from: 'a', to: 'b', label: 'x & y' }] }).svg;
  check('titles, lines and labels are escaped: <, & and "', escaped.includes('A &lt; B &amp; &quot;C&quot;') && escaped.includes('it&#39;s &lt;b&gt;') && escaped.includes('x &amp; y') && !escaped.includes('A < B') && wellFormed(escaped) === '', wellFormed(escaped));
  check('the same layout gives the same markup', renderDiagram(layout) === renderDiagram(layoutDiagram(valid({ ...structuredClone(pipeline), direction: 'right' }))));

  // Kinds: a pill fully rounded, a note lighter (dashed, no shadow, muted title).
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"([^>]*)\/>/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], rx: +m[5], rest: m[6] }));
  const rectOf = (n) => rects.find((r) => Math.abs(r.x - n.x) < 0.01 && Math.abs(r.y - n.y) < 0.01 && Math.abs(r.w - n.w) < 0.01);
  const pills = layout.nodes.filter((n) => n.kind === 'pill');
  // A pill grown for many arrows keeps the round ends its text gave it (layout.js), so its
  // arrows still land on the straight part; one that did not grow is round end to end.
  const user = layout.nodes.find((n) => n.id === 'user');
  check('a pill is drawn with the layout\'s radius, and one that kept its size is fully rounded', pills.length === 2 && pills.every((n) => Math.abs(rectOf(n).rx - n.radius) < 0.01) && Math.abs(2 * rectOf(user).rx - Math.min(user.w, user.h)) < 0.01);
  const note = layout.nodes.find((n) => n.kind === 'note');
  check('a note is lighter: a dashed border, no shadow, its title in muted ink', /stroke-dasharray/.test(rectOf(note).rest) && !/filter/.test(rectOf(note).rest) && svg.includes(`class="u" x="${Math.round((note.textBox.x + note.textBox.w / 2) * 100) / 100}"`));
  check('a box is a card: an 8 px radius and the soft shadow', layout.nodes.filter((n) => n.kind === 'box').every((n) => rectOf(n).rx === 8 && /filter="url\(#s/.test(rectOf(n).rest)));
  check('the shadow is the spec\'s: 6 % opacity, 1 px down, a 3 px blur', /<feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#0F172A" flood-opacity="0.06"\/>/.test(svg));
  const labelled = layout.edges.filter((e) => e.labelBox);
  check('each label sits on a backing exactly its label box', labelled.every((e) => rects.some((r) => Math.abs(r.x - e.labelBox.x) < 0.01 && Math.abs(r.y - e.labelBox.y) < 0.01 && Math.abs(r.w - e.labelBox.w) < 0.01)));
  // Review C11: the backing is the colour behind it — its group's fill inside a group, the
  // canvas outside — so no white patch sits on a tint.
  const backingWrong = [];
  for (const theme of ['light', 'dark']) {
    for (const input of [pipeline, ownerPipeline, iconsFixture]) {
      const { layout: l, svg: s } = drawOf({ ...input, theme });
      const P = palette(theme);
      for (const e of l.edges.filter((x) => x.labelBox)) {
        const b = e.labelBox;
        const gi = l.groups.findIndex((g) => b.x >= g.x && b.y >= g.y && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h);
        const want = gi >= 0 ? P.accents[gi].fill : P.canvas;
        const rect = new RegExp(`<rect x="${Math.round(b.x * 100) / 100}" y="${Math.round(b.y * 100) / 100}" width="[\\d.]+" height="[\\d.]+" rx="4" fill="(#[0-9A-F]{6})"`).exec(s);
        if (!rect || rect[1] !== want) backingWrong.push(`${theme} "${e.label}": ${rect?.[1]} for ${want}`);
      }
    }
  }
  check('a label\'s backing is its group\'s fill inside a group, the canvas outside', backingWrong.length === 0, backingWrong.slice(0, 3).join(' | '));
  const accents = palette().accents;
  check('each group is tinted in its own accent, its title in that accent\'s dark shade', layout.groups.every((g, i) => rects.some((r) => Math.abs(r.x - g.x) < 0.01 && r.rest.includes(`fill="${accents[i].fill}"`) && r.rest.includes(`stroke="${accents[i].edge}"`)) && svg.includes(`fill="${accents[i].ink}">${g.titleLines[0]}</text>`)));

  // Text: drawn from its text box, centred across it and down it, however far the box grew.
  const texts = [...svg.matchAll(/<text class="([tul])" x="([\d.]+)" y="([\d.]+)">/g)].map((m) => ({ x: +m[2], y: +m[3] }));
  const hub = layoutDiagram(valid({ direction: 'down', nodes: [{ id: 'hub', title: 'Cổng API' }, ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, title: `Dịch vụ t${i}` }))], edges: Array.from({ length: 6 }, (_, i) => ({ from: 'hub', to: `t${i}`, label: `nhãn ${i} khá dài để phải mở rộng` })) }));
  const hubText = [...renderDiagram(hub).matchAll(/<text class="t" x="([\d.]+)" y="([\d.]+)">Cổng API<\/text>/g)][0];
  const [h] = hub.nodes;
  check('a box grown wide for its arrows keeps its title at the centre of its text box', h.w > TEXT.maxWidth && Math.abs(Number(hubText[1]) - (h.x + h.w / 2)) < 0.01, `${h.w} wide`);
  const inside = layout.nodes.every((n) => {
    const own = texts.filter((t) => Math.abs(t.x - (n.textBox.x + n.textBox.w / 2)) < 0.01 && t.y > n.textBox.y && t.y < n.textBox.y + n.textBox.h + 0.01);
    return own.length === n.titleLines.length + n.lines.length;
  });
  check('every line of every box has its baseline inside that box\'s text box', inside);
  const grown = layoutDiagram(valid({ direction: 'right', nodes: [{ id: 'p', title: 'Một' }, ...Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, title: `Đích ${i}` }))], edges: Array.from({ length: 5 }, (_, i) => ({ from: 'p', to: `q${i}`, label: `nhánh ${i}` })) }));
  const [p] = grown.nodes;
  const baselineAt = Number(/<text class="t" x="[\d.]+" y="([\d.]+)">Một<\/text>/.exec(renderDiagram(grown))[1]);
  const middle = baselineAt - lineHeight(TEXT.titleSize) / 2 - TEXT.titleSize * 0.35 + lineHeight(TEXT.titleSize) / 2;
  check('a box grown tall for its arrows keeps its text centred down it', p.h > 2 * TEXT.padding + p.textBox.h + 10 && Math.abs(middle - (p.y + p.h / 2)) < 0.01, `${p.h} tall, text ${p.textBox.h}`);
}

section('nothing for the drawing check to find, in either theme, any direction');
{
  const found = [];
  for (const theme of ['light', 'dark']) {
    for (const direction of ['auto', 'right', 'down']) {
      for (const [name, input] of [['owner\'s 4-layer pipeline', ownerPipeline], ['pipeline', pipeline]]) {
        const { svg } = drawOf({ ...input, direction, theme });
        const { issues, canvas } = checkDiagram(svg);
        if (issues.length || canvas !== theme || wellFormed(svg)) found.push(`${name} ${direction} ${theme}: ${issues[0] || wellFormed(svg) || `canvas ${canvas}`}`);
      }
    }
  }
  check('the owner\'s 12-box pipeline and the 8-box one: no issues, the canvas read as the theme', found.length === 0, found.slice(0, 3).join(' | '));
  check('  (the 12-box one has twelve boxes)', ownerPipeline.nodes.length === 12);
  const swept = [];
  for (let seed = 1; seed <= 40; seed += 1) {
    const n = 5 + (seed % 11);
    const d = valid(bigDiagram(seed, { n, m: n + (seed % (n + 1)), groups: Math.min(seed % 4, Math.floor(n / 3)) }));
    for (const theme of ['light', 'dark']) {
      const svg = renderDiagram(layoutDiagram({ ...d, theme }), { theme });
      const { issues } = checkDiagram(svg);
      if (issues.length || wellFormed(svg)) swept.push(`seed ${seed} ${theme}: ${issues[0] || wellFormed(svg)}`);
    }
  }
  for (const seed of [3, 11]) {
    const svg = renderDiagram(layoutDiagram(valid(bigDiagram(seed))));
    if (checkDiagram(svg).issues.length || wellFormed(svg)) swept.push(`big seed ${seed}: ${checkDiagram(svg).issues[0] || wellFormed(svg)}`);
  }
  check('80 random small drawings in both themes and two 40-box ones: clean and well-formed', swept.length === 0, swept.slice(0, 3).join(' | '));
}

section('both themes keep text at 4.5:1');
{
  const short = [];
  for (const theme of ['light', 'dark']) {
    const P = palette(theme);
    const pairs = [
      ['title on a card', P.ink, P.card],
      ['lines on a card', P.muted, P.card],
      ['title on a pill', P.ink, P.pill],
      ['a note\'s text', P.muted, P.note],
      ['a label on its backing', P.muted, P.canvas],
      ...P.accents.flatMap((a, i) => [
        [`group ${i + 1}'s title on its tint`, a.ink, a.fill],
        [`group ${i + 1}'s icon on a card`, a.ink, P.card],
        // A label inside a group sits on that group's tint (review C11).
        [`a label on group ${i + 1}'s tint`, P.muted, a.fill],
      ]),
    ];
    for (const [what, fg, bg] of pairs) {
      const ratio = contrast(colour(fg), colour(bg));
      if (ratio < 4.5) short.push(`${theme}: ${what} ${ratio.toFixed(2)}:1`);
    }
  }
  check('every text pair, light and dark, at least 4.5:1 (computed, not remembered)', short.length === 0, short.join(' | '));
  // Review D12: dark cards measured 1.00–1.05:1 against their group and vanished.
  const faint = [];
  for (const theme of ['light', 'dark']) {
    const P = palette(theme);
    for (const [i, a] of P.accents.entries()) {
      for (const [what, fill, edge] of [['card', P.card, P.cardEdge], ['pill', P.pill, P.pillEdge]]) {
        const f = contrast(colour(fill), colour(a.fill));
        const e = contrast(colour(edge), colour(a.fill));
        if (f < STAND_OUT.fill) faint.push(`${theme} ${what} fill on group ${i + 1}: ${f.toFixed(2)}:1`);
        if (e < STAND_OUT.edge) faint.push(`${theme} ${what} edge on group ${i + 1}: ${e.toFixed(2)}:1`);
      }
      const n = contrast(colour(P.noteEdge), colour(a.fill));
      if (n < STAND_OUT.edge) faint.push(`${theme} note edge on group ${i + 1}: ${n.toFixed(2)}:1`);
      // Fix round 4: a group stands off the canvas too (dark tints were 1.11:1 and barely showed).
      const g = contrast(colour(a.fill), colour(P.canvas));
      if (g < 1.2) faint.push(`${theme} group ${i + 1} on the canvas: ${g.toFixed(2)}:1`);
    }
  }
  check('a card stands out from every group tint, both themes: fill at least 1.25:1, edge at least 2:1; every group at least 1.2:1 off the canvas', STAND_OUT.fill >= 1.25 && STAND_OUT.edge >= 2 && faint.length === 0, faint.slice(0, 4).join(' | '));
  const [r, g, b] = colour(palette('dark').accents[3].fill);
  check('the dark amber group reads amber, not olive: red clearly over green, green over blue', r - g >= 4 && g > b, palette('dark').accents[3].fill);
  check('the dark canvas is the page\'s own dark paper', palette('dark').canvas === '#0F1720');
  check('eight accents, as many as a diagram may have groups, none repeated', new Set(palette().accents.map((a) => a.accent)).size === 8 && new Set(palette('dark').accents.map((a) => a.accent)).size === 8);
}

section('the reviewer\'s three drawings read cleanly, every way (fix round 1)');
{
  for (const [name, input] of [['owner', ownerPipeline], ['pipeline', pipeline], ['icons', iconsFixture]]) {
    for (const direction of ['auto', 'right', 'down']) {
      const layout = layoutDiagram(valid({ ...input, direction }));
      const q = quality(layout);
      for (const kind of QUALITY_KINDS.filter((k) => k in q)) check(`${name} ${direction} (${layout.direction}): no ${kind}`, q[kind].length === 0, q[kind].slice(0, 3).join(' | '));
      // Fix round 2: an edge whose boxes overlap, with nothing in the way, runs straight; and a
      // group's title is one line, the group widened for it where it must be.
      const bent = couldBeStraight(layout);
      check(`${name} ${direction}: every edge that could run straight does`, bent.length === 0, bent.join(' | '));
      const wrapped = layout.groups.filter((g) => g.titleLines.length > 1).map((g) => `${g.id}: ${g.titleLines.join(' / ')}`);
      check(`${name} ${direction}: no group title wraps`, wrapped.length === 0, wrapped.join(' | '));
      // Widened for its title, a group still holds it, 10 in from its edges at the least.
      const outside = layout.groups.filter((g) => g.titleBox && !(g.titleBox.x >= g.x + 10 - 1e-6 && g.titleBox.y >= g.y + 10 - 1e-6 && g.titleBox.x + g.titleBox.w <= g.x + g.w - 10 + 1e-6 && g.titleBox.y + g.titleBox.h <= g.y + g.h - 10 + 1e-6)).map((g) => g.id);
      check(`${name} ${direction}: every group title sits inside its group`, outside.length === 0, outside.join(', '));
      // Fix round 4: arrowheads into one box stand 20 apart; no two edges run alongside closer
      // than 16 for more than 12 (pipeline cache→done / db→done were 8 apart for 32; the owner's
      // rerank↔vec cycle two nested hooks 8 apart); and no step is under 20 (icons chat→db, owner
      // user→raptor, user→memgpt and router→llm were 12).
      const crowd = crowding(layout);
      check(`${name} ${direction}: arrowheads into one box at least 20 apart`, crowd.heads.length === 0, crowd.heads.slice(0, 3).join(' | '));
      check(`${name} ${direction}: no two edges alongside closer than 16 for more than 12`, crowd.alongside.length === 0, crowd.alongside.slice(0, 3).join(' | '));
      check(`${name} ${direction}: no line within 16 of a group border it passes outside of`, hugs(layout).length === 0, hugs(layout).slice(0, 3).join(' | '));
      check(`${name} ${direction}: no step under 20`, steps(layout, 20).length === 0, steps(layout, 20).slice(0, 3).join(' | '));
      check(`${name} ${direction}: still every Task 1 rule`, problems(layout).length === 0 && labelsOverLines(layout).length === 0 && sideBySide(layout).length === 0, [...problems(layout), ...labelsOverLines(layout), ...sideBySide(layout)].slice(0, 2).join(' | '));
    }
  }
  // Review C9: groups were 22–28 % full (72–78 % empty), a title column beside the members and
  // nothing in it. Now the title is a band across the top, a group hugs its members, and a gap
  // keeps room for a group's title only where that group is.
  //
  // t4 is the exception, and pinned where it is: its two boxes sit either side of the gap
  // between ranks 3 and 4, which carries three lines from t2 to t4 and keeps them clear of t3's
  // title band. In a layered layout that gap is shared by the whole rank, so t4 cannot close it
  // without breaking the ranks' alignment (fix round 1 report: a concern for the controller).
  //
  // Fix round 2 widened t2 and t3: a title is one line now, top left, and the lines into their
  // first rank run straight, so the first rank moves along past the title (t2: a
  // 158-wide title beside two lines into a 155-wide box). Pinned where they are, as ceilings.
  const auto = layoutDiagram(valid(ownerPipeline));
  const empty = (layout) => layout.groups.map((g) => `${g.id} ${(100 * emptyShare(layout, g)).toFixed(1)}%`).join(' ');
  const limit = { t1: 0.55, t2: 0.72, t3: 0.7, t4: 0.66 };
  check('owner, as auto draws it: t1 at most 55 % empty, t2 72 %, t3 70 %, t4 66 % (were 52/73/72/78)', auto.groups.every((g) => emptyShare(auto, g) <= limit[g.id]), empty(auto));
  console.log(`    owner right, not what auto draws: ${empty(layoutDiagram(valid({ ...ownerPipeline, direction: 'right' })))}`);
}

section('a pill grown for its arrows is still a pill (fix round 5)');
{
  // Pipeline "right": "Trả lời" takes four arrowheads 20 apart and grew to 120 × 91 (103 in
  // round 4, with 2 more reserved per port). Drawn with its old radius it read as a rounded
  // square; now it is round across its short side, and every line runs on to meet its curve.
  const layout = layoutDiagram(valid({ ...pipeline, direction: 'right' }));
  const done = layout.nodes.find((n) => n.id === 'done');
  const svg = renderDiagram(layout, { title: 'x' });
  const rect = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/g)].find((m) => Math.abs(+m[1] - done.x) < 0.01 && Math.abs(+m[2] - done.y) < 0.01);
  check(`the grown pill is drawn round across its short side: ${Math.round(done.w)} × ${Math.round(done.h)}, rx ${rect?.[5]}`, done.h > 43 && rect && Math.abs(+rect[5] - Math.min(done.w, done.h) / 2) < 0.01 && Math.abs(done.radius - Math.min(done.w, done.h) / 2) < 1e-9);
  check('  a pill reserves exactly what its arrowheads need: 3 gaps of 20 and its two insets', done.h <= 3 * 20 + 2 * Math.max(8, 43 / 2 - 6) + 1e-6, `${done.h.toFixed(1)}`);
  const ends = layout.edges.filter((e) => e.to === 'done').map((e) => outlineGap(e.points.at(-1), done));
  check('  and each of its four arrows ends on the curve that is drawn, within a pixel', ends.length === 4 && ends.every((g) => g <= 1), ends.map((g) => g.toFixed(2)).join(', '));
}

section("the reviewer's 80 dense drawings: arrowheads apart (fix round 4)");
{
  // 40 boxes, 80 edges, 8 groups, both directions: arrowheads into one box under 12 apart were
  // 1,093 at 63a6e59 and 2,745 at f73680a, with ports packed 8 apart against a 7-unit head. The
  // ruling's ceiling is 1,093; a head now keeps 10 to itself either side, so it is 0.
  let close = 0;
  let near = 0;
  let along = 0;
  let short = 0;
  for (const longTitles of [false, true]) {
    for (let seed = 1; seed <= 20; seed += 1) {
      const d = valid(denseDiagram(seed, longTitles));
      for (const direction of ['right', 'down']) {
        const layout = layoutDiagram({ ...d, direction });
        close += crowding(layout, { apart: 12 }).heads.length;
        const c = crowding(layout);
        near += c.heads.length;
        along += c.alongside.length;
        short += steps(layout, 20).length;
      }
    }
  }
  console.log(`    80 dense layouts: heads under 12 apart ${close} (was 2,745), under 20 ${near} (was 4,385), edges alongside ${along} (was 11,274), steps under 20 ${short} (was 1,199)`);
  check(`80 dense layouts: arrowheads into one box under 12 apart at most 1,093 (ruling), and 0 now: ${close}`, close === 0);
  check(`  under 20 apart: 0 (${near})`, near === 0);
}

section('random drawings: the same findings, counted, no worse than after fix round 5');
{
  const counts = Object.fromEntries(QUALITY_KINDS.map((k) => [k, 0]));
  for (let seed = 1; seed <= 300; seed += 1) {
    const n = 5 + (seed % 11);
    const d = valid(bigDiagram(seed, { n, m: n + (seed % (n + 1)), groups: Math.min(seed % 4, Math.floor(n / 3)) }));
    for (const direction of ['right', 'down']) {
      const layout = layoutDiagram({ ...d, direction });
      const q = { ...quality(layout), straight: couldBeStraight(layout), wraps: layout.groups.filter((g) => g.titleLines.length > 1), hugs: hugs(layout) };
      for (const kind of QUALITY_KINDS) counts[kind] += q[kind].length;
    }
  }
  console.log(`    600 small layouts: ${QUALITY_KINDS.map((k) => `${k} ${counts[k]}`).join(', ')}`);
  for (const kind of QUALITY_KINDS) check(`600 small layouts: ${kind} no more than after fix round 5 (${SWEEP_CEILING[kind]})`, counts[kind] <= SWEEP_CEILING[kind], `${counts[kind]}`);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
