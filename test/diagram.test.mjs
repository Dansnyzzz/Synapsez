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

const { validateDiagram } = await import('../server/diagram/validate.js');
const { layoutDiagram } = await import('../server/diagram/layout.js');
const { textWidth, wrapText, TEXT } = await import('../server/diagram/measure.js');
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
  check('a direction other than right or down', /"right"/.test(dir) && /"down"/.test(dir), dir);
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
  check('direction defaults to right', d.direction === 'right');
  check('kind defaults to box, group to none', d.nodes[0].kind === 'box' && d.nodes[0].group === null);
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
  const chain = valid({ nodes: nodes(3), edges: [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n2' }] });
  const right = layoutDiagram(chain);
  const down = layoutDiagram({ ...chain, direction: 'down' });
  const [r0, r1, r2] = right.nodes.map(centre);
  const [d0, d1, d2] = down.nodes.map(centre);
  check('right: ranks increase in x, at the gap of 72', r1[0] > r0[0] && r2[0] > r1[0] && right.nodes[1].x - (right.nodes[0].x + right.nodes[0].w) >= 72 - EPS && Math.abs(r0[1] - r1[1]) < EPS);
  check('down: ranks increase in y, not x, at the gap of 56', d1[1] > d0[1] && d2[1] > d1[1] && Math.abs(d0[0] - d1[0]) < EPS && Math.abs(d1[0] - d2[0]) < EPS && down.nodes[1].y - (down.nodes[0].y + down.nodes[0].h) >= 56 - EPS);
  check('a straight chain is drawn with straight arrows', right.edges.every((e) => e.points.length === 2) && down.edges.every((e) => e.points.length === 2));
  const siblings = layoutDiagram(valid({ nodes: nodes(3), edges: [{ from: 'n0', to: 'n1' }, { from: 'n0', to: 'n2' }] }));
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
  const tiny = layoutDiagram(valid({ groups: [{ id: 'g', title: 'G' }], nodes: [{ id: 'a', title: 'A', group: 'g' }] }));
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

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
