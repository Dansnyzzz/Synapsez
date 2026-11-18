/**
 * A diagram the model describes as { direction, nodes, groups, edges } is checked and laid
 * out by the server, so its arrows connect by construction (owner, 2026-11-17: a pipeline
 * drawing whose arrows pointed at nothing and ran through text). Pure code: no store, no
 * network, no clock.
 *
 *   node test/diagram.test.mjs
 */
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { validateDiagram, ICON_NAMES } = await import('../server/diagram/validate.js');
const { layoutDiagram, chooseDirection } = await import('../server/diagram/layout.js');
const { textWidth, wrapText, TEXT, measureNode, lineHeight } = await import('../server/diagram/measure.js');
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

/** Every property a laid-out diagram must have, as a list of what is wrong. */
function problems(layout) {
  const out = [];
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
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
    // A pill's arrows arrive where its round end is within about a pixel of the straight edge.
    for (const [p, id] of [[e.points[0], e.from], [e.points.at(-1), e.to]]) {
      const n = byId.get(id);
      if (n.kind !== 'pill') continue;
      const onSide = Math.abs(p[0] - n.x) <= EPS || Math.abs(p[0] - (n.x + n.w)) <= EPS;
      const along = onSide ? p[1] - n.y : p[0] - n.x;
      const reach = n.radius - 6;
      if (along < reach - EPS || along > (onSide ? n.h : n.w) - reach + EPS) out.push(`${name} meets the pill ${id} on its curve`);
    }
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
const segmentsOf = (layout) => layout.edges.flatMap((e, ei) => e.points.slice(1).map((p, k) => ({ ei, a: e.points[k], b: p })));
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
  let worst = 0;
  let labels = 0;
  const broken = [];
  const covering = [];
  for (let seed = 1; seed <= 24; seed += 1) {
    const d = valid(bigDiagram(seed));
    for (const direction of ['right', 'down']) {
      const t0 = performance.now();
      const layout = layoutDiagram({ ...d, direction });
      worst = Math.max(worst, performance.now() - t0);
      const wrong = problems(layout);
      if (wrong.length) broken.push(`seed ${seed} ${direction}: ${wrong.slice(0, 2).join(' | ')}`);
      labels += layout.edges.filter((e) => e.labelBox).length;
      covering.push(...labelsOverLines(layout).map((name) => `seed ${seed} ${direction}: ${name}`));
    }
  }
  check('48 random 40-node, 80-edge drawings (cycles, loops, groups, labels, pills) break no rule', broken.length === 0, broken.slice(0, 3).join(' || '));
  // Without room kept at a labelled port, 136 of these labels covered a neighbour's line.
  check(`  and none of their ${labels} labels covers another arrow's line`, covering.length === 0, `${covering.length}: ${covering.slice(0, 3).join(' | ')}`);
  check('the slowest of them lays out in under 200 ms', worst < 200, `${worst.toFixed(1)} ms`);
  const cold = bigDiagram(99);
  const t0 = performance.now();
  layoutDiagram(valid(cold));
  const once = performance.now() - t0;
  check('40 nodes and 80 edges, validated and laid out, in under 200 ms', once < 200, `${once.toFixed(1)} ms`);
  // The label search's worst case: 41 labelled edges, each through ~37 ranks of dummies, so
  // every label has long runs to slide along (took up to 350 ms before the search looked only
  // at lines near each run). Task 2's "auto" lays a drawing out twice.
  const chain = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const longEdges = valid({
    nodes: chain.map((id) => ({ id, title: `Bước ${id}` })),
    edges: [...chain.slice(1).map((id, i) => ({ from: chain[i], to: id })), ...Array.from({ length: 41 }, (_, k) => ({ from: `c${k % 3}`, to: `c${39 - (k % 5)}`, label: `đường dài số ${k}` }))],
  });
  // Both ways, as "auto" will: together within the one budget.
  const t1 = performance.now();
  const both = ['right', 'down'].map((direction) => layoutDiagram({ ...longEdges, direction }));
  const took = performance.now() - t1;
  check('a 40-box chain with 41 labelled long edges, laid out both ways, in under 200 ms together', took < 200, `${took.toFixed(1)} ms`);
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

section('"auto" lays a drawing out both ways and keeps the better shape');
{
  const chain = (k) => ({ nodes: nodes(k), edges: Array.from({ length: k - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })) });
  const long = layoutDiagram(valid(chain(8)));
  check('a long chain goes down', long.direction === 'down', `${long.direction} ${Math.round(long.width)}×${Math.round(long.height)}`);
  const fan = { nodes: nodes(7), edges: Array.from({ length: 6 }, (_, i) => ({ from: 'n0', to: `n${i + 1}` })) };
  const wide = layoutDiagram(valid(fan));
  check('a wide, shallow one (one box fanning out to six) goes right', wide.direction === 'right', `${wide.direction} ${Math.round(wide.width)}×${Math.round(wide.height)}`);
  check('  and is exactly the layout that direction gives', isDeepStrictEqual(wide, layoutDiagram({ ...valid(fan), direction: 'right' })) && isDeepStrictEqual(long, layoutDiagram({ ...valid(chain(8)), direction: 'down' })));
  const off = (l) => Math.abs(Math.log(l.width / l.height / 1.6));
  const both = ['right', 'down'].map((direction) => layoutDiagram({ ...valid(pipeline), direction }));
  const auto = layoutDiagram(valid(pipeline));
  const closer = off(both[1]) < off(both[0]) ? 'down' : 'right';
  check('the owner\'s pipeline takes the one closer to 16:10', auto.direction === closer, `${auto.direction}: right ${off(both[0]).toFixed(2)} off, down ${off(both[1]).toFixed(2)} off`);
  // The rule itself, on boxes only.
  const box = (width, height, tag) => ({ width, height, tag });
  check('closer to 16:10 wins when it fits 1,200 at 0.8', chooseDirection(box(1000, 900, 'r'), box(800, 500, 'd')).tag === 'd');
  check('  a closer one too wide even at 0.8 loses to the narrower', chooseDirection(box(1600, 1000, 'r'), box(700, 2000, 'd')).tag === 'd' && chooseDirection(box(700, 2000, 'r'), box(1600, 1000, 'd')).tag === 'r');
  check('  1,500 wide still fits (1,200 at 0.8)', chooseDirection(box(1500, 940, 'r'), box(400, 2000, 'd')).tag === 'r');
  check('  when neither fits, the narrower', chooseDirection(box(3000, 1900, 'r'), box(2000, 400, 'd')).tag === 'd');
  check('  and a tie keeps right', chooseDirection(box(800, 500, 'r'), box(800, 500, 'd')).tag === 'r');
  check('"right" and "down" still force their way', layoutDiagram(valid({ ...chain(8), direction: 'right' })).direction === 'right' && layoutDiagram(valid({ ...fan, direction: 'down' })).direction === 'down');
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
  check('each label sits on a backing in the canvas colour, exactly its label box', labelled.every((e) => rects.some((r) => Math.abs(r.x - e.labelBox.x) < 0.01 && Math.abs(r.y - e.labelBox.y) < 0.01 && Math.abs(r.w - e.labelBox.w) < 0.01 && /fill="#FFFFFF"/.test(r.rest))));
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
    }
  }
  check('a card stands out from every group tint, both themes: fill at least 1.25:1, edge at least 2:1', STAND_OUT.fill >= 1.25 && STAND_OUT.edge >= 2 && faint.length === 0, faint.slice(0, 4).join(' | '));
  const [r, g, b] = colour(palette('dark').accents[3].fill);
  check('the dark amber group reads amber, not olive: red clearly over green, green over blue', r - g >= 4 && g > b, palette('dark').accents[3].fill);
  check('the dark canvas is the page\'s own dark paper', palette('dark').canvas === '#0F1720');
  check('eight accents, as many as a diagram may have groups, none repeated', new Set(palette().accents.map((a) => a.accent)).size === 8 && new Set(palette('dark').accents.map((a) => a.accent)).size === 8);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
