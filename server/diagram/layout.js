/*
 * Where every box and arrow of a diagram goes (owner, 2026-11-17: arrows that pointed at
 * nothing and ran through text, because the model placed each one by hand and could not see
 * the result). The model says what is in the drawing; this decides where, so an arrow starts
 * and ends on a box's edge by construction and never runs through a box.
 *
 * A layered (Sugiyama-style) layout, kept small enough to read:
 *   1. measure — each box sized to its wrapped text (measure.js, the estimate widgetCheck
 *      uses), so the check and the layout agree on what fits;
 *   2. cycles — a depth-first search in input order turns each back edge round for the
 *      layout only; it is still drawn the way it was given, and marked `reversed`;
 *   3. ranks — the longest path from the sources; then a source whose edges all go far
 *      ahead moves up to just before them, so it does not trail a long arrow;
 *   4. stand-ins — an edge across several ranks gets a point-sized dummy in each rank it
 *      passes, with a slot of its own, so the edge goes round the boxes between;
 *   5. order — 4 barycentre sweeps. A group's members (and its own edges' dummies) move as one
 *      block, and groups keep one order in every rank, so a group owns a band across the
 *      ranks it spans and its box never takes in a box that is not in it;
 *   6. across — positions across the ranks are packed, then pulled toward their neighbours
 *      where the gaps leave room;
 *   7. routes — right angles only: out of the side facing the next rank at a port spread
 *      along that side, through each dummy, into the facing side. Each turn between two
 *      ranks has a lane of its own, ordered to cross as little as it can;
 *   8. labels — on the longest straight part, slid along until it touches no box, group
 *      title or other label. Room is kept for each label in the gap its edge starts in, inside
 *      its own box's band, so a place clear of every box, label and line always exists.
 *
 * Coordinates are the drawing's own units; the renderer scales through the viewBox. Pure and
 * deterministic: the same diagram always gives the same layout, which is what makes a redraw
 * reproducible and the tests exact.
 *
 * "auto", the default direction, lays the drawing out both ways and keeps the better shape
 * (owner, 2026-11-17: "flexible adaptive"): see chooseDirection.
 */

import { TEXT, FIT, lineHeight, textWidth, measureNode, measureLabel } from './measure.js';

export const LAYOUT = Object.freeze({
  rankGap: Object.freeze({ right: 72, down: 56 }),
  nodeGap: 24,
  // The visible gap between two groups' boxes, either way (review, 2026-11-18: 8 read as
  // touching). It replaces the plan's 40 between members, which left 8 between the boxes.
  groupGap: 24,
  groupMargin: 16,
  groupTitleInset: 10,
  edgeGap: 12,
  portSpacing: 8,
  laneSpacing: 8,
  laneClearance: 24,
  labelClearance: 8,
  // How far another edge's line keeps from a label (review B7).
  labelLineClear: 10,
  // How far a group's box reaches past the last lane of a loop it holds.
  loopReach: 16,
  margin: 24,
  sweeps: 4,
  balancePasses: 12,
});

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const overlaps = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

// Whether an axis-parallel segment touches a box.
const segmentTouches = ([x1, y1], [x2, y2], box) => {
  if (y1 === y2) return y1 >= box.y && y1 <= box.y + box.h && Math.max(x1, x2) >= box.x && Math.min(x1, x2) <= box.x + box.w;
  return x1 >= box.x && x1 <= box.x + box.w && Math.max(y1, y2) >= box.y && Math.min(y1, y2) <= box.y + box.h;
};

// Drops repeated points and the middle of three in a line, so each segment is one straight run.
function simplify(points) {
  const out = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const before = out.at(-2);
    if (before && ((before[0] === last[0] && last[0] === p[0]) || (before[1] === last[1] && last[1] === p[1]))) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * The order of the turns in one gap, nearest the source side first. A loop back to its own box
 * goes nearest, where nothing else passes. For the rest, putting turn i before turn j costs a
 * crossing when j's way in passes i's turn, another when i's way out passes j's, and much more
 * when the two would run along one line.
 *
 * A greedy pass takes, step by step, the turn that costs least placed next; it can leave two
 * ways side by side that a single move would part (code review, 2026-11-17: about 2 % of small
 * drawings). So each turn is then moved to the place that lowers the total most, until no
 * move helps — O(L²) a pass, as a turn's cost at every place is one running sum.
 */
function orderTurns(list) {
  const loops = list.filter((t) => t.loop);
  const rest = list.filter((t) => !t.loop).sort((p, q) => p.s - q.s || p.t - q.t || p.edge.index - q.edge.index);
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const inside = (v, a, b) => v > Math.min(a, b) && v < Math.max(a, b) && !near(v, a) && !near(v, b);
  // j's way in and i's way out run side by side between the two lanes. Under 4 px apart they
  // read as one line, as bad as being one: worth taking many crossings to avoid (measured: in
  // dense drawings about 1 % more crossings, and far fewer lines side by side). Closer than a
  // port spacing is merely tight.
  const alongside = (i, j) => (Math.abs(j.s - i.t) < 4 ? 100 : Math.abs(j.s - i.t) < LAYOUT.portSpacing ? 10 : 0);
  const cost = (i, j) => (inside(j.s, i.s, i.t) ? 1 : 0) + (inside(i.t, j.s, j.t) ? 1 : 0) + alongside(i, j);
  const n = rest.length;
  // C[i][j]: what turn i placed anywhere before turn j costs.
  const C = rest.map((i, a) => rest.map((j, b) => (a === b ? 0 : cost(i, j))));
  const score = C.map((row, i) => row.reduce((sum, c, j) => sum + c - C[j][i], 0));
  const taken = rest.map(() => false);
  let seq = [];
  for (let step = 0; step < n; step += 1) {
    let best = -1;
    for (let i = 0; i < n; i += 1) if (!taken[i] && (best < 0 || score[i] < score[best])) best = i;
    taken[best] = true;
    seq.push(best);
    for (let i = 0; i < n; i += 1) if (!taken[i]) score[i] -= C[i][best] - C[best][i];
  }
  // Every move lowers a whole-number total, so this ends; the cap only bounds the time.
  for (let pass = 0; pass < 2 * n + 8; pass += 1) {
    let moved = false;
    for (let a = 0; a < seq.length; a += 1) {
      const x = seq[a];
      const others = seq.filter((_, i) => i !== a);
      // x's cost with every other turn after it, then slid one place later at a time.
      let here = others.reduce((sum, y) => sum + C[x][y], 0);
      let best = here;
      let bestAt = 0;
      let current = a === 0 ? here : null;
      for (let p = 0; p < others.length; p += 1) {
        here += C[others[p]][x] - C[x][others[p]];
        if (p + 1 === a) current = here;
        if (here < best) {
          best = here;
          bestAt = p + 1;
        }
      }
      if (best < current) {
        seq = [...others.slice(0, bestAt), x, ...others.slice(bestAt)];
        moved = true;
      }
    }
    if (!moved) break;
  }
  return [...loops, ...seq.map((i) => rest[i])];
}

/**
 * Of a drawing laid out both ways, the one to keep: the one whose text is largest as the page
 * shows it — scaled to the 760 px reply column, or to the 576 px height cap, whichever bites
 * (review, 2026-11-18, replacing "closer to 16:10 if it fits 1,200 at 0.8": a 1,422 px drawing
 * won that way and showed its titles at 7.5 px; fix round 2 added the height). Within 5 % of
 * each other, the box closer to 16:10 wins, on a log scale so twice too wide and twice too
 * tall are equally far off. A tie keeps "right", the way a flow is read.
 */
export function chooseDirection(right, down) {
  const textScale = (l) => Math.min(1, FIT.column / l.width, FIT.height / l.height);
  const off = (l) => Math.abs(Math.log(l.width / l.height / FIT.aspect));
  const [a, b] = [textScale(right), textScale(down)];
  if (Math.abs(a - b) > FIT.near * Math.max(a, b)) return b > a ? down : right;
  return off(down) < off(right) ? down : right;
}

/**
 * @param {{ direction?: string, nodes: Array<{ id: string, title: string, lines?: string[], kind?: string, group?: string | null, icon?: string | null }>, groups?: Array<{ id: string, title?: string }>, edges?: Array<{ from: string, to: string, label?: string | null, style?: string }> }} diagram
 *   a diagram validateDiagram accepted; a direction other than "right" or "down" is "auto"
 */
export function layoutDiagram(diagram) {
  if (diagram.direction === 'right' || diagram.direction === 'down') return layoutOne(diagram, diagram.direction);
  return chooseDirection(layoutOne(diagram, 'right'), layoutOne(diagram, 'down'));
}

/**
 * One direction's layout. In "down" a group's title takes a stretch of its band between the
 * lines into its first rank; where a pass finds none wide enough, the next keeps room for it
 * (fix round 2: a title is never wrapped). The room goes at the band's start, the title at the
 * top left and the first rank moved along, or at its end, the first rank staying put: both are
 * laid out, and the one with fewer bends is kept — the start on a tie, where titles are read.
 *
 * @param {Parameters<typeof layoutDiagram>[0]} diagram
 * @param {'right' | 'down'} direction
 */
function layoutOne(diagram, direction) {
  const first = layoutPass(diagram, direction, new Map());
  if (!first.more.size) return first.layout;
  const settle = (side) => {
    const rooms = new Map();
    for (const [id, ask] of first.more) rooms.set(id, { size: side === 'start' ? ask.full : ask.end, side });
    let out = layoutPass(diagram, direction, rooms);
    if (out.more.size) {
      for (const [id, ask] of out.more) rooms.set(id, { size: ask.full, side });
      out = layoutPass(diagram, direction, rooms);
    }
    return out.layout;
  };
  const bends = (layout) => layout.edges.reduce((sum, e) => sum + e.points.length - 2, 0);
  const atStart = settle('start');
  const atEnd = settle('end');
  return bends(atStart) <= bends(atEnd) ? atStart : atEnd;
}

/**
 * @param {Parameters<typeof layoutDiagram>[0]} diagram
 * @param {'right' | 'down'} direction
 * @param {Map<string, { size: number, side: 'start' | 'end' }>} rooms  room kept for a group's title, by group id
 */
function layoutPass(diagram, direction, rooms) {
  // Ranks run along x for "right", along y for "down"; "main" is that axis and "cross" the other.
  const right = direction === 'right';
  const M = LAYOUT.groupMargin;

  const nodes = diagram.nodes.map((n, index) => {
    const m = measureNode(n);
    const kind = n.kind || 'box';
    // A pill's ends stay as round as its text alone would make them, so a pill grown to take
    // many arrows keeps a straight middle where they arrive.
    const radius = kind === 'pill' ? Math.min(m.w, m.h) / 2 : 8;
    return { index, id: n.id, title: n.title, kind, group: n.group ?? null, icon: n.icon ?? null, w: m.w, h: m.h, textW: m.textW, textH: m.textH, radius, titleLines: m.titleLines, lines: m.lines, rank: 0, mainStart: 0, item: null, loops: [] };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (diagram.edges || []).map((e, index) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    const label = e.label || null;
    return { index, from, to, label, style: e.style || 'solid', loop: from === to, reversed: false, hops: [], loopPorts: [0, 0], loopTurn: null, measured: label ? measureLabel(label) : null, labelGap: 0, labelCross: 0, labelAlong: 0, reserved: null, labelFree: false, route: [], labelBox: null };
  });
  const labelAcross = (e) => (right ? e.measured.h : e.measured.w);
  const labelAlong = (e) => (right ? e.measured.w : e.measured.h);
  // Half the room a port needs along its side: 4 px, or half its label and 6 more when the
  // label sits on the line leaving that port — so a neighbour's line keeps 10 from the label
  // (review B7: 4 + 6).
  const portHalf = (e, out) => (out && e.label ? labelAcross(e) / 2 + LAYOUT.labelLineClear - LAYOUT.portSpacing / 2 : LAYOUT.portSpacing / 2);
  // A loop's two legs stand at least 12 apart, so its turn reads as a loop, not a wobble.
  const loopHalf = (e, out) => Math.max(portHalf(e, out), 6);
  // Ports keep off a side's corners. On a pill they stay where its round end is within about a
  // pixel of the straight edge (6 px into the curve), so an arrow ends on what is drawn.
  const insetOf = (n) => (n.kind === 'pill' ? Math.max(8, n.radius - 6) : 8);
  // How long a side must be for these ports in any order: neighbours are their two halves
  // apart, and an end port is its half (or the corner inset, if more) from the corner. So a
  // label on a line leaving the box stays inside the box's own band, where no other box's line
  // runs — the slot kept for it can then never lie on a line.
  const sideNeed = (halves, inset) => {
    if (!halves.length) return 0;
    const [a, b = a] = [...halves].sort((p, q) => p - q);
    return 2 * halves.reduce((s, t) => s + t, 0) + Math.max(0, inset - a) + Math.max(0, inset - b);
  };
  for (const e of edges) if (e.loop) e.from.loops.push(e);

  // ── 2. cycles: a back edge found depth-first, in input order, is turned round for the layout.
  const outOf = nodes.map(() => []);
  for (const e of edges) if (!e.loop) outOf[e.from.index].push(e);
  const state = nodes.map(() => 0);
  const visit = (v) => {
    state[v] = 1;
    for (const e of outOf[v]) {
      const w = e.to.index;
      if (state[w] === 1) e.reversed = true;
      else if (state[w] === 0) visit(w);
    }
    state[v] = 2;
  };
  for (const n of nodes) if (state[n.index] === 0) visit(n.index);
  const tail = (e) => (e.reversed ? e.to : e.from);
  const head = (e) => (e.reversed ? e.from : e.to);

  // ── 3. ranks: the longest path from the sources, in a topological order kept to input order.
  const succ = nodes.map(() => []);
  const indeg = nodes.map(() => 0);
  for (const e of edges) {
    if (e.loop) continue;
    succ[tail(e).index].push(e);
    indeg[head(e).index] += 1;
  }
  const isSource = indeg.map((d) => d === 0);
  const topo = nodes.filter((n) => indeg[n.index] === 0).map((n) => n.index);
  for (let q = 0; q < topo.length; q += 1) {
    for (const e of succ[topo[q]]) {
      const w = head(e).index;
      indeg[w] -= 1;
      if (indeg[w] === 0) topo.push(w);
    }
  }
  for (const v of topo) for (const e of succ[v]) head(e).rank = Math.max(head(e).rank, nodes[v].rank + 1);
  for (const v of topo) if (isSource[v] && succ[v].length) nodes[v].rank = Math.min(...succ[v].map((e) => head(e).rank)) - 1;
  const maxRank = Math.max(0, ...nodes.map((n) => n.rank));

  // A box with many arrows grows across, so its ports stay at least 8 apart and a label on a
  // line leaving it has room. Past the 260 the text wraps at, too (code review: in "down" a
  // capped hub squeezed its ports and its labels landed on each other's lines); the text block
  // stays its own size, centred, and is given as `textBox`.
  const halvesOf = nodes.map(() => ({ in: [], out: [] }));
  for (const e of edges) {
    if (e.loop) halvesOf[e.from.index].out.push(loopHalf(e, true), loopHalf(e, false));
    else {
      halvesOf[tail(e).index].out.push(portHalf(e, true));
      halvesOf[head(e).index].in.push(portHalf(e, false));
    }
  }
  for (const n of nodes) {
    const need = Math.max(sideNeed(halvesOf[n.index].in, insetOf(n)), sideNeed(halvesOf[n.index].out, insetOf(n)));
    if (right) n.h = Math.max(n.h, need);
    else n.w = Math.max(n.w, need);
  }
  const mainOf = (n) => (right ? n.w : n.h);
  const crossOf = (n) => (right ? n.h : n.w);

  // ── 4. items in ranks: the boxes, the dummies of long edges, and holds for a group's empty ranks.
  const item = (type, rank, size, group, node) => ({ type, rank, size, group, node, ins: [], outs: [], order: 0, offset: 0, start: 0, v: null, near: [] });
  for (const n of nodes) n.item = item('node', n.rank, crossOf(n), n.group, n);
  const dummies = [];
  for (const e of edges) {
    if (e.loop) continue;
    const t = tail(e);
    const h = head(e);
    // An edge inside one group keeps its dummies inside that group's block.
    const group = t.group && t.group === h.group ? t.group : null;
    const chain = [t.item];
    for (let r = t.rank + 1; r < h.rank; r += 1) {
      const d = item('dummy', r, 0, group, null);
      chain.push(d);
      dummies.push(d);
    }
    chain.push(h.item);
    for (let k = 1; k < chain.length; k += 1) {
      const hop = { edge: e, a: chain[k - 1], b: chain[k], s: 0, t: 0, turn: null };
      chain[k - 1].outs.push(hop);
      chain[k].ins.push(hop);
      e.hops.push(hop);
    }
  }

  const groups = (diagram.groups || []).map((g, index) => ({ index, id: g.id, title: g.title || '', min: Infinity, max: -Infinity, items: [], stacks: new Map(), slack: new Map(), shift: new Map(), header: 0, band: 0, room: 0, roomFirst: false, titleAt: 0, inner: 0, size: 0, titleLines: [], titleW: 0, v: null, box: null, titleBox: null }));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  for (const n of nodes) {
    const g = groupById.get(n.group);
    if (!g) continue;
    g.min = Math.min(g.min, n.rank);
    g.max = Math.max(g.max, n.rank);
  }
  const layers = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of nodes) layers[n.rank].push(n.item);
  for (const d of dummies) layers[d.rank].push(d);
  for (const g of groups) {
    for (let r = g.min; r <= g.max; r += 1) if (!layers[r].some((it) => it.group === g.id)) layers[r].push(item('hold', r, 0, g.id, null));
  }

  // ── 5. order within each rank.
  const groupRank = new Map(groups.map((g) => [g.id, g.index]));
  const renumber = (layer) => layer.forEach((it, i) => {
    it.order = i;
  });
  layers.forEach(renumber);
  /** The layer re-sorted by `value`, a group's items kept together and groups in their one order. */
  const arrange = (layer, value) => {
    const units = [];
    const unitOf = new Map();
    for (const it of layer) {
      const key = it.group ?? it;
      let u = unitOf.get(key);
      if (!u) {
        u = { group: it.group, items: [], sum: 0, n: 0, first: it.order };
        unitOf.set(key, u);
        units.push(u);
      }
      u.items.push(it);
      const v = value(it);
      if (v !== null) {
        u.sum += v;
        u.n += 1;
      }
    }
    const keyOf = (u) => (u.n ? u.sum / u.n : mean(u.items.map((it) => it.order)));
    const keys = new Map(units.map((u) => [u, keyOf(u)]));
    units.sort((p, q) => keys.get(p) - keys.get(q) || p.first - q.first);
    const slots = units.map((u, i) => (u.group ? i : -1)).filter((i) => i >= 0);
    const blocks = slots.map((i) => units[i]).sort((p, q) => groupRank.get(p.group) - groupRank.get(q.group));
    slots.forEach((slot, k) => {
      units[slot] = blocks[k];
    });
    const own = (it) => value(it) ?? it.order;
    const out = units.flatMap((u) => (u.group ? [...u.items].sort((a, b) => own(a) - own(b) || a.order - b.order) : u.items));
    renumber(out);
    return out;
  };
  // A barycentre: the mean place of the item's neighbours in the rank just swept. A hold
  // follows its own group there.
  const towards = (r, side) => (it) => {
    if (it.type === 'hold') {
      const kin = layers[r].filter((x) => x.group === it.group);
      return kin.length ? mean(kin.map((x) => x.order)) : null;
    }
    const hops = side === 'in' ? it.ins : it.outs;
    return hops.length ? mean(hops.map((h) => (side === 'in' ? h.a : h.b).order)) : null;
  };
  const regroup = () => {
    const at = new Map(groups.map((g) => [g.id, []]));
    for (const layer of layers) layer.forEach((it) => it.group && at.get(it.group).push(it.order / Math.max(1, layer.length - 1)));
    const placeOf = new Map(groups.map((g) => [g.id, mean(at.get(g.id))]));
    [...groups].sort((p, q) => placeOf.get(p.id) - placeOf.get(q.id) || p.index - q.index).forEach((g, i) => groupRank.set(g.id, i));
    for (let r = 0; r <= maxRank; r += 1) layers[r] = arrange(layers[r], () => null);
  };
  for (let r = 0; r <= maxRank; r += 1) layers[r] = arrange(layers[r], () => null);
  for (let sweep = 0; sweep < LAYOUT.sweeps; sweep += 1) {
    if (sweep % 2 === 0) for (let r = 1; r <= maxRank; r += 1) layers[r] = arrange(layers[r], towards(r - 1, 'in'));
    else for (let r = maxRank - 1; r >= 0; r -= 1) layers[r] = arrange(layers[r], towards(r + 1, 'out'));
    if (groups.length) regroup();
  }

  // Then neighbours swap, or a free box moves across a whole group, wherever that lowers the
  // crossings — counting a line through a group that holds neither of its ends as four, since
  // it reads as belonging there (review B5: a line through "Operations" and across its arrow).
  // Groups keep their one order in every rank, so a group never swaps with a group.
  // Crossings between two ranks are the pairs whose ends come in opposite orders: counted as
  // inversions with a Fenwick tree, O(H log H), since this runs for every swap tried.
  const inversions = (hops, size) => {
    const pairs = hops.map((h) => [h.a.order, h.b.order]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const tree = new Array(size + 2).fill(0);
    let total = 0;
    let seen = 0;
    for (let i = 0; i < pairs.length; ) {
      let j = i;
      while (j < pairs.length && pairs[j][0] === pairs[i][0]) j += 1;
      for (let k = i; k < j; k += 1) {
        let atMost = 0;
        for (let x = pairs[k][1] + 1; x > 0; x -= x & -x) atMost += tree[x];
        total += seen - atMost;
      }
      for (let k = i; k < j; k += 1) {
        for (let x = pairs[k][1] + 1; x <= size + 1; x += x & -x) tree[x] += 1;
        seen += 1;
      }
      i = j;
    }
    return total;
  };
  const gapCost = (r) => {
    if (r < 0 || r >= maxRank) return 0;
    const hops = layers[r].flatMap((it) => it.outs);
    let cost = inversions(hops, layers[r + 1].length);
    for (const G of groups) {
      if (G.min > r || G.max < r + 1) continue;
      const span = (layer) => {
        const at = layer.flatMap((it, i) => (it.group === G.id ? [i] : []));
        return [at[0], at.at(-1)];
      };
      const [a0, a1] = span(layers[r]);
      const [b0, b1] = span(layers[r + 1]);
      for (const h of hops) {
        if (h.edge.from.group === G.id || h.edge.to.group === G.id) continue;
        const side = (o, lo, hi) => (o < lo ? -1 : o > hi ? 1 : 0);
        if (side(h.a.order, a0, a1) !== side(h.b.order, b0, b1)) cost += 4;
      }
    }
    return cost;
  };
  const unitsOf = (layer) => {
    const units = [];
    for (const it of layer) {
      const last = units.at(-1);
      if (last && it.group && last[0].group === it.group) last.push(it);
      else units.push([it]);
    }
    return units;
  };
  // Two neighbours both free, or both of one group, change only the crossings between their own
  // lines when swapped, and no group's: counted on the spot, in place.
  const swapGain = (u, v) => {
    let gain = 0;
    for (const hu of u.ins) for (const hv of v.ins) gain += Math.sign(hu.a.order - hv.a.order);
    for (const hu of u.outs) for (const hv of v.outs) gain += Math.sign(hu.b.order - hv.b.order);
    return gain;
  };
  for (let pass = 0; pass < 6; pass += 1) {
    let improved = false;
    for (let r = 0; r <= maxRank; r += 1) {
      const layer = layers[r];
      for (let i = 0; i + 1 < layer.length; i += 1) {
        const [u, v] = [layer[i], layer[i + 1]];
        if (u.group !== v.group || swapGain(u, v) <= 0) continue;
        layer[i] = v;
        layer[i + 1] = u;
        v.order = i;
        u.order = i + 1;
        improved = true;
      }
      if (!groups.length) continue;
      // A free box and a whole group trade places: every line round the group may change.
      let units = unitsOf(layers[r]);
      for (let i = 0; i + 1 < units.length; i += 1) {
        if (!units[i][0].group === !units[i + 1][0].group) continue;
        const before = gapCost(r - 1) + gapCost(r);
        const old = layers[r];
        const next = [...units.slice(0, i), units[i + 1], units[i], ...units.slice(i + 2)].flat();
        layers[r] = next;
        renumber(next);
        if (gapCost(r - 1) + gapCost(r) < before) {
          improved = true;
          units = unitsOf(layers[r]);
        } else {
          layers[r] = old;
          renumber(old);
        }
      }
    }
    if (!improved) break;
  }

  // ── sizes along the main axis, and where each group's title goes.
  const mainSize = layers.map((layer) => Math.max(0, ...layer.filter((it) => it.type === 'node').map((it) => mainOf(it.node))));
  const titleLine = lineHeight(TEXT.groupTitleSize);
  // A title band: 10 above the title and 10 below it before the members, which then keep
  // their 16 from the sides and the bottom — a header that reads as the group's own.
  const titleBand = (lines) => lines * titleLine + 2 * LAYOUT.groupTitleInset - M;
  // Inside a group, a stand-in's line passes 12 from a box, as two lines pass each other: the
  // group stays as narrow as its widest rank (review C9).
  const gapBetween = (a, b) => (a.type === 'node' && b.type === 'node' ? LAYOUT.nodeGap : LAYOUT.edgeGap);
  for (const g of groups) {
    for (let r = g.min; r <= g.max; r += 1) {
      const stack = layers[r].filter((it) => it.group === g.id && it.type !== 'hold');
      g.stacks.set(r, stack);
      g.items.push(...stack);
      g.inner = Math.max(g.inner, stack.reduce((s, it, i) => s + it.size + (i ? gapBetween(stack[i - 1], it) : 0), 0));
    }
  }
  const usedBy = (stack) => stack.reduce((s, it, i) => s + it.size + (i ? gapBetween(stack[i - 1], it) : 0), 0);
  for (const g of groups) {
    if (!g.title) continue;
    // A group's title is one line, always (fix round 2: "Tầng 2 — Nén ngữ / cảnh" read as two
    // labels): the group grows to hold it instead. It sits in a band across the group's top,
    // above its members (review, 2026-11-18: beside them it left a column of nothing).
    g.titleLines = [g.title];
    g.titleW = Math.ceil(textWidth(g.title, TEXT.groupTitleSize, true));
    if (right) {
      // In "right" the band is part of the stack across, over the first column, where no lane
      // runs: that column widens to hold the title.
      mainSize[g.min] = Math.max(mainSize[g.min], g.titleW);
      g.header = titleBand(1);
    } else {
      // In "down" it is room kept above the first rank, which the lines into that rank cross:
      // the title takes a stretch of the band between them (see the ports), and where a first
      // pass found none, this one keeps room for it at the band's far end.
      g.band = titleBand(1);
      g.room = rooms.get(g.id)?.size || 0;
      g.roomFirst = rooms.get(g.id)?.side === 'start';
      g.inner = Math.max(g.inner, g.titleW, usedBy(g.stacks.get(g.min)) + g.room);
    }
  }

  // ── 6. positions across the ranks.
  const placeStack = (g, r) => {
    // Room kept at the band's start moves the first rank along by that much.
    let at = g.header + M + g.shift.get(r) + (r === g.min && g.roomFirst ? g.room : 0);
    const stack = g.stacks.get(r);
    stack.forEach((it, i) => {
      if (i) at += gapBetween(stack[i - 1], it);
      it.offset = at;
      at += it.size;
    });
  };
  for (const g of groups) {
    g.size = g.header + 2 * M + g.inner;
    for (let r = g.min; r <= g.max; r += 1) {
      const used = usedBy(g.stacks.get(r));
      // Room kept for the title stays clear at the far end of the first rank.
      g.slack.set(r, Math.max(0, g.inner - used - (r === g.min ? g.room : 0)));
      g.shift.set(r, Math.min(g.slack.get(r), (g.inner - used) / 2));
      placeStack(g, r);
    }
  }

  // One variable per free item and one per group block; each rank says which must come first.
  const vars = [];
  const newVar = (size, it, g) => {
    const v = { size, item: it, group: g, pos: 0, preds: [], succs: [], left: 0 };
    vars.push(v);
    return v;
  };
  for (const layer of layers) {
    let prev = null;
    for (const it of layer) {
      const g = it.group ? groupById.get(it.group) : null;
      if (g && !g.v) g.v = newVar(g.size, null, g);
      if (!g) it.v = newVar(it.size, it, null);
      const v = g ? g.v : it.v;
      if (prev && prev.v === v) continue;
      const kind = g ? 'block' : it.type;
      if (prev) {
        const gap = prev.kind === 'block' && kind === 'block' ? LAYOUT.groupGap : prev.kind === 'node' || kind === 'node' ? LAYOUT.nodeGap : LAYOUT.edgeGap;
        prev.v.succs.push({ v, gap });
        v.preds.push({ v: prev.v, gap });
      }
      prev = { v, kind };
    }
  }
  for (const v of vars) v.left = v.preds.length;
  const order = vars.filter((v) => v.left === 0);
  for (let q = 0; q < order.length; q += 1) {
    for (const { v } of order[q].succs) {
      v.left -= 1;
      if (v.left === 0) order.push(v);
    }
  }
  const lowest = (v) => Math.max(-Infinity, ...v.preds.map((p) => p.v.pos + p.v.size + p.gap));
  const highest = (v) => Math.min(Infinity, ...v.succs.map((s) => s.v.pos - v.size - s.gap));
  for (const v of order) v.pos = Math.max(0, lowest(v));

  const startOf = (it) => (it.group ? groupById.get(it.group).v.pos + it.offset : it.v.pos);
  const centreOf = (it) => startOf(it) + it.size / 2;
  for (const layer of layers) for (const it of layer) it.near = [...it.ins.map((h) => h.a), ...it.outs.map((h) => h.b)];
  const backwards = [...order].reverse();
  for (let pass = 0; pass < LAYOUT.balancePasses; pass += 1) {
    for (const v of pass % 2 === 0 ? order : backwards) {
      let desired = v.pos;
      if (v.item) {
        if (!v.item.near.length) continue;
        desired = mean(v.item.near.map(centreOf)) - v.size / 2;
      } else {
        const pulls = v.group.items.flatMap((it) => it.near.filter((nb) => nb.group !== v.group.id).map((nb) => centreOf(nb) - centreOf(it)));
        if (!pulls.length) continue;
        desired = v.pos + mean(pulls);
      }
      v.pos = clamp(desired, lowest(v), highest(v));
    }
    // Inside a block, a rank with fewer members than the widest slides toward its neighbours.
    for (const g of groups) {
      for (let r = g.min; r <= g.max; r += 1) {
        const pulls = g.stacks.get(r).flatMap((it) => it.near.map((nb) => centreOf(nb) - centreOf(it)));
        if (!pulls.length) continue;
        g.shift.set(r, clamp(g.shift.get(r) + mean(pulls), 0, g.slack.get(r)));
        placeStack(g, r);
      }
    }
  }
  for (const layer of layers) for (const it of layer) it.start = startOf(it);

  // A long edge's stand-ins line up, so it runs down one straight channel instead of winding
  // (review B7: an edge of 6 bends round the whole drawing). Each stand-in may move as far as
  // its rank allows without passing or nearing its neighbours; the edge takes the one place
  // all of them can reach that moves them least.
  const room = (d) => {
    const layer = layers[d.rank];
    const i = layer.indexOf(d);
    const g = d.group ? groupById.get(d.group) : null;
    let lo = g ? g.v.pos + g.header + M : -Infinity;
    let hi = g ? g.v.pos + g.size - M : Infinity;
    const extent = (x) => (x.group && x.group !== d.group ? [groupById.get(x.group).v.pos, groupById.get(x.group).v.pos + groupById.get(x.group).size] : [x.start, x.start + x.size]);
    const gapTo = (x) => (d.group ? gapBetween(x, d) : x.type === 'node' && !x.group ? LAYOUT.nodeGap : LAYOUT.edgeGap);
    for (let j = i - 1; j >= 0; j -= 1) {
      if (layer[j].type === 'hold') continue;
      lo = Math.max(lo, extent(layer[j])[1] + gapTo(layer[j]));
      break;
    }
    for (let j = i + 1; j < layer.length; j += 1) {
      if (layer[j].type === 'hold') continue;
      hi = Math.min(hi, extent(layer[j])[0] - gapTo(layer[j]));
      break;
    }
    return [lo, hi];
  };
  const moveTo = (d, x) => {
    if (d.group) d.offset += x - d.start;
    else d.v.pos = x;
    d.start = x;
  };
  for (const e of edges) {
    const chain = e.hops.slice(1).map((h) => h.a);
    if (!chain.length) continue;
    const t = e.hops[0].a;
    const h = e.hops.at(-1).b;
    const rooms = chain.map(room);
    const options = [...chain.map((d) => d.start), centreOf(t), centreOf(h)];
    let best = null;
    for (const x of options) {
      if (!rooms.every(([lo, hi]) => x >= lo - 1e-9 && x <= hi + 1e-9)) continue;
      const cost = chain.reduce((s, d) => s + Math.abs(d.start - x), 0);
      if (best === null || cost < best.cost - 1e-9) best = { x, cost };
    }
    if (best) for (const d of chain) moveTo(d, best.x);
  }

  // ── 7. ports, on the side facing the next rank (out) and the previous one (in).
  // Each port wants to sit opposite the other end of its line, so a line runs straight where
  // the two boxes overlap and never takes a step for nothing (review B3: steps of 4–11 units,
  // a 67-unit Z between centres 4 apart). On a side, ports keep the order of what they lead
  // to, neighbours their two halves apart and the end ones their half (or the inset) from the
  // corners; the side was grown to sideNeed, so they always fit. Placing them as near as that
  // allows to where they want to be is an isotonic fit (pool adjacent violators), clamped.
  const JOG = 12;
  const sides = [];
  const portOf = new Map();
  const addSide = (n, list, lo) => {
    const side = { n, list, lo, hi: n.item.start + crossOf(n) };
    list.forEach((en, i) => {
      en.side = side;
      en.i = i;
      if (en.hop) portOf.set(`${en.end}${en.hop.edge.index}:${en.hop.a.rank}`, en);
    });
    sides.push(side);
  };
  const mid = (h) => (h.a.type === 'node' && h.b.type === 'node' ? (centreOf(h.a) + centreOf(h.b)) / 2 : h.a.type === 'node' ? h.b.start : h.a.start);
  for (const d of dummies) {
    for (const h of d.outs) h.s = d.start;
    for (const h of d.ins) h.t = d.start;
  }
  for (const n of nodes) {
    const outs = [...n.item.outs].sort((p, q) => centreOf(p.b) - centreOf(q.b) || p.edge.index - q.edge.index);
    for (const h of outs) h.s = mid(h);
    // A loop takes the two ports at the far end of the side, so it crosses no other way out.
    const out = [
      ...outs.map((h) => ({ pin: /** @type {number | null} */ (null), corner: /** @type {number | null} */ (null), hop: h, end: 's', half: portHalf(h.edge, true), get: () => h.s, set: (v) => (h.s = v), want: () => h.t })),
      ...n.loops.flatMap((e) => [
        { pin: /** @type {number | null} */ (null), corner: /** @type {number | null} */ (null), hop: null, end: 'l', half: loopHalf(e, true), get: () => e.loopPorts[0], set: (v) => (e.loopPorts[0] = v), want: () => Infinity },
        { pin: /** @type {number | null} */ (null), corner: /** @type {number | null} */ (null), hop: null, end: 'l', half: loopHalf(e, false), get: () => e.loopPorts[1], set: (v) => (e.loopPorts[1] = v), want: () => Infinity },
      ]),
    ];
    addSide(n, out, n.item.start);
    const ins = [...n.item.ins].sort((p, q) => centreOf(p.a) - centreOf(q.a) || p.edge.index - q.edge.index);
    for (const h of ins) h.t = mid(h);
    const into = ins.map((h) => ({ pin: /** @type {number | null} */ (null), corner: /** @type {number | null} */ (null), hop: h, end: 't', half: portHalf(h.edge, false), get: () => h.t, set: (v) => (h.t = v), want: () => h.s }));
    // In "down" the lines into a group's first rank cross its title band: they go where their
    // other end is, and the title takes a stretch of the band between them (fix round 2: kept
    // clear of the title, they stepped aside from lines that could have run straight).
    addSide(n, into, n.item.start);
  }
  // How near a corner a port may sit: its half, unless a pin for a straight line gave up the
  // room its label keeps at the corner — between neighbours, the label keeps its full room.
  const cornerOf = (en) => (typeof en.corner === 'number' ? en.corner : en.half);
  const place = (side) => {
    const { n, list } = side;
    const k = list.length;
    if (!k) return;
    const inset = insetOf(n);
    const off = [0];
    for (let i = 1; i < k; i += 1) off.push(off[i - 1] + list[i - 1].half + list[i].half);
    const L = Math.max(n.item.start + Math.max(inset, cornerOf(list[0])), side.lo + cornerOf(list[0]));
    const U = Math.max(L, side.hi - Math.max(inset, cornerOf(list[k - 1])) - off[k - 1]);
    // A port pinned for a straight line weighs as much as all the rest together, many times.
    const blocks = [];
    list.forEach((en, i) => {
      const pinned = typeof en.pin === 'number';
      const want = pinned ? en.pin : en.want();
      const w = pinned ? 1e6 : 1;
      blocks.push({ sum: w * ((Number.isFinite(want) ? want : side.hi) - off[i]), w, n: 1 });
      while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).w > blocks.at(-1).sum / blocks.at(-1).w) {
        const b = blocks.pop();
        blocks.at(-1).sum += b.sum;
        blocks.at(-1).w += b.w;
        blocks.at(-1).n += b.n;
      }
    });
    let i = 0;
    for (const b of blocks) {
      const y = clamp(b.sum / b.w, L, U);
      for (let j = 0; j < b.n; j += 1, i += 1) list[i].set(y + off[i]);
    }
  };
  for (let round = 0; round < 4; round += 1) for (const side of sides) place(side);
  // An edge between two boxes that overlap across runs straight (fix round 2: lines stepped
  // aside by 30–90 units between boxes sharing most of their width). Both its ends are pinned at
  // one place both sides can hold, and the other ports on each side move round them; a pin
  // that cannot hold, or would unpin an earlier one, is let go.
  const endsOf = (h) => [portOf.get(`s${h.edge.index}:${h.a.rank}`), portOf.get(`t${h.edge.index}:${h.a.rank}`)];
  const reach = (en) => {
    const { n } = en.side;
    return [Math.max(n.item.start + Math.max(insetOf(n), cornerOf(en)), en.side.lo + cornerOf(en)), en.side.hi - Math.max(insetOf(n), cornerOf(en))];
  };
  // A long edge counts too, where its stand-ins share one column: its two ends pin to it.
  const pinnedEdges = [];
  const straight = (e) => e.hops.every((h) => Math.abs(h.s - h.t) < 1e-6);
  for (const e of edges) {
    if (e.loop) continue;
    const first = e.hops[0];
    const last = e.hops.at(-1);
    const [s] = endsOf(first);
    const [, t] = endsOf(last);
    // A line into a titled group's first rank in "down" that crosses where its title goes is
    // tried again past the title, even if it already runs straight.
    const into = last.b.node;
    const g = !right && into.group ? groupById.get(into.group) : null;
    const titleEnd = g && g.titleLines.length && into.rank === g.min ? g.v.pos + M + g.titleW + 8 : null;
    const wasStraight = straight(e);
    const origin = first.s;
    if (!s || !t || (wasStraight && (titleEnd === null || last.t >= titleEnd))) continue;
    // Its stand-ins, if it has any, move to the line where their ranks leave room.
    const stand = e.hops.slice(1).map((h) => h.a);
    const was = stand.map((d) => d.start);
    const standTo = (x) => {
      stand.forEach((d) => moveTo(d, x));
      for (const h of e.hops) {
        if (h.a.type === 'dummy') h.s = h.a.start;
        if (h.b.type === 'dummy') h.t = h.b.start;
      }
    };
    const standFits = (x) => stand.every((d) => {
      const [lo, hi] = room(d);
      return x >= lo - 1e-9 && x <= hi + 1e-9;
    });
    // A labelled end may give up the room kept for its label at the port: the label finds
    // another place along its line ("move the label rather than bend the edge").
    const corners = [s.corner, t.corner];
    let held = false;
    for (const spare of [false, true]) {
      if (spare) {
        if (cornerOf(s) <= LAYOUT.portSpacing / 2 && cornerOf(t) <= LAYOUT.portSpacing / 2) break;
        s.corner = LAYOUT.portSpacing / 2;
        t.corner = LAYOUT.portSpacing / 2;
      }
      const [a0, a1] = reach(s);
      const [b0, b1] = reach(t);
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (lo > hi) continue;
      // Past the title comes first: the line is as straight anywhere it can run, and the
      // title then needs no room kept for it. A line already straight tries nothing else.
      const pastTitle = titleEnd !== null ? [Math.max(last.t, titleEnd)].filter((x) => x <= hi) : [];
      const others = wasStraight ? [] : [...(stand.length ? [stand[0].start] : []), first.s, last.t, (first.s + last.t) / 2];
      const options = [...pastTitle, ...others].map((v) => clamp(v, lo, hi));
      for (const x of [...new Set(options)]) {
        if (stand.length && !standFits(x)) continue;
        if (stand.length) standTo(x);
        s.pin = x;
        t.pin = x;
        place(s.side);
        place(t.side);
        if (straight(e) && pinnedEdges.every(straight)) {
          held = true;
          break;
        }
      }
      if (held) break;
    }
    if (held) {
      pinnedEdges.push(e);
      if (e.label && cornerOf(s) < s.half) e.labelFree = true;
    } else {
      [s.corner, t.corner] = corners;
      s.pin = null;
      t.pin = null;
      if (stand.length) stand.forEach((d, i) => moveTo(d, was[i]));
      for (const h of e.hops) {
        if (h.a.type === 'dummy') h.s = h.a.start;
        if (h.b.type === 'dummy') h.t = h.b.start;
      }
      place(s.side);
      place(t.side);
      // One that ran straight before keeps doing so where it was.
      if (wasStraight) {
        s.pin = origin;
        t.pin = origin;
        place(s.side);
        place(t.side);
        if (straight(e)) pinnedEdges.push(e);
      }
    }
  }
  // The rest settle again round the pinned ones.
  for (let round = 0; round < 2; round += 1) for (const side of sides) place(side);
  // How far a port may move: not past its neighbours' room, nor off its side.
  const windowOf = (en) => {
    const { side, i } = en;
    const { n, list } = side;
    const inset = insetOf(n);
    const lo = i > 0 ? list[i - 1].get() + list[i - 1].half + en.half : Math.max(n.item.start + Math.max(inset, cornerOf(en)), side.lo + cornerOf(en));
    const hi = i < list.length - 1 ? list[i + 1].get() - list[i + 1].half - en.half : side.hi - Math.max(inset, cornerOf(en));
    return [lo, hi];
  };
  const inside = (v, span) => v >= span[0] - 1e-9 && v <= span[1] + 1e-9;
  // A step under 12 is made straight wherever either end can move to meet the other.
  // Where neither end can meet the other, the step is widened to a clear 12 instead: a turn
  // that reads as a turn, not a wobble.
  const straighten = (h) => {
    const d = Math.abs(h.s - h.t);
    if (d === 0 || d >= JOG) return;
    const s = portOf.get(`s${h.edge.index}:${h.a.rank}`);
    const t = portOf.get(`t${h.edge.index}:${h.a.rank}`);
    if (t && inside(h.s, windowOf(t))) h.t = h.s;
    else if (s && inside(h.t, windowOf(s))) h.s = h.t;
    else {
      const [a0, a1] = s ? windowOf(s) : [h.s, h.s];
      const [b0, b1] = t ? windowOf(t) : [h.t, h.t];
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (lo <= hi) {
        h.s = h.t = clamp((h.s + h.t) / 2, lo, hi);
        return;
      }
      const away = (v, from) => [from + JOG, from - JOG].filter((x) => Math.abs(x - v) < JOG + 1e-9).sort((p, q) => Math.abs(p - v) - Math.abs(q - v));
      const tTo = t ? away(h.t, h.s).find((x) => inside(x, windowOf(t))) : undefined;
      if (tTo !== undefined) h.t = tTo;
      else if (s) {
        const sTo = away(h.s, h.t).find((x) => inside(x, windowOf(s)));
        if (sTo !== undefined) h.s = sTo;
      }
    }
  };
  for (const e of edges) for (const h of e.hops) straighten(h);
  // Two different lines never meet end to end (review B4: one edge's stub into a box in line
  // with another's stub out of the box above, 8 units apart, read as a single line). Where a
  // line's way out of one rank and another's way into the next sit under 8 apart, one of them
  // moves — whichever can, without making a step of its own.
  const ok = (h, s, t) => Math.abs(s - t) === 0 || Math.abs(s - t) >= JOG;
  const nudge = (en, away, h) => {
    const [lo, hi] = windowOf(en);
    const now = en.get();
    const other = en.end === 's' ? h.t : h.s;
    const options = [];
    for (let d = LAYOUT.portSpacing; d <= 64; d += 4) options.push(away + d, away - d);
    const fits = options.filter((v) => inside(v, [lo, hi]) && (en.end === 's' ? ok(h, v, other) : ok(h, other, v)));
    if (!fits.length) return false;
    en.set(fits.reduce((best, v) => (Math.abs(v - now) < Math.abs(best - now) ? v : best)));
    return true;
  };
  for (let g = 0; g < maxRank; g += 1) {
    const hopsHere = edges.flatMap((e) => e.hops.filter((h) => h.a.rank === g));
    for (const A of hopsHere) {
      for (const B of hopsHere) {
        if (A === B || Math.abs(A.s - B.t) >= LAYOUT.portSpacing || (A.s === A.t && B.s === B.t)) continue;
        const bPort = portOf.get(`t${B.edge.index}:${B.a.rank}`);
        const aPort = portOf.get(`s${A.edge.index}:${A.a.rank}`);
        if (B.s !== B.t && bPort && nudge(bPort, A.s, B)) continue;
        if (A.s !== A.t && aPort) nudge(aPort, B.t, A);
      }
    }
  }
  // A dummy's hops share its one position.
  for (const e of edges) {
    e.hops.forEach((h, k) => {
      if (k + 1 < e.hops.length) e.hops[k + 1].s = h.t;
    });
  }
  // In "down", where each group's title goes in its band, now the lines into its first rank
  // are known: the leftmost stretch between them that holds it on one line, never across a
  // line. Where none does, the next pass keeps room for it at the band's far end.
  const more = new Map();
  for (const g of groups) {
    g.titleAt = g.v.pos + M;
    if (right || !g.titleLines.length) continue;
    const xs = g.stacks.get(g.min).flatMap((it) => it.ins.map((h) => h.t));
    const lo = g.v.pos + M;
    const hi = g.v.pos + g.size - M;
    const stretches = [];
    let from = lo;
    for (const x of [...xs].sort((p, q) => p - q)) {
      if (x - 8 > from) stretches.push([from, x - 8]);
      from = Math.max(from, x + 8);
    }
    if (hi > from) stretches.push([from, hi]);
    const fits = stretches.find(([a, b]) => b - a >= g.titleW);
    if (fits) {
      g.titleAt = fits[0];
      continue;
    }
    // First ask only for what the band lacks beyond its last line, over the members' far part;
    // if that was not enough, the whole title's width beside the members.
    const lastLine = Math.max(lo, ...xs.map((x) => x + 8));
    const membersEnd = Math.max(...g.stacks.get(g.min).map((it) => it.start + it.size));
    const full = g.titleW + 16;
    const end = g.room ? full : Math.max(16, full - Math.max(0, membersEnd - lastLine));
    if (full > g.room) more.set(g.id, { end, full });
  }

  // ── gaps between ranks: room for labels, then one lane per turn.
  const lastHasLoop = nodes.some((n) => n.loops.length && n.rank === maxRank);
  const gapCount = maxRank + (lastHasLoop ? 1 : 0);
  const turns = Array.from({ length: gapCount }, () => []);
  for (const e of edges) {
    if (e.loop) {
      e.loopTurn = { edge: e, s: e.loopPorts[0], t: e.loopPorts[1], loop: true, main: 0, rel: 0 };
      turns[e.from.rank].push(e.loopTurn);
      continue;
    }
    for (const h of e.hops) {
      if (h.s === h.t) continue;
      h.turn = { edge: e, s: h.s, t: h.t, loop: false, main: 0, rel: 0 };
      turns[h.a.rank].push(h.turn);
    }
  }
  // Each label gets a slot in the gap its edge starts in, on the part of the edge that leaves
  // the box. Labels that would overlap across the ranks take turns along the gap instead
  // (interval partitioning), so no two slots meet and none reaches a box.
  const labelRoom = new Array(gapCount).fill(0);
  const reservedIn = Array.from({ length: gapCount }, () => []);
  for (const e of edges) {
    if (!e.label) continue;
    e.labelGap = e.loop ? e.from.rank : e.hops[0].a.rank;
    e.labelCross = e.loop ? e.loopPorts[0] : e.hops[0].s;
    reservedIn[e.labelGap].push(e);
  }
  reservedIn.forEach((list, g) => {
    const columns = [];
    const lowEnd = (e) => e.labelCross - labelAcross(e) / 2;
    for (const e of [...list].sort((p, q) => lowEnd(p) - lowEnd(q) || p.index - q.index)) {
      let col = columns.find((c) => c.end + 4 <= lowEnd(e));
      if (!col) {
        col = { end: -Infinity, size: 0, members: [] };
        columns.push(col);
      }
      col.end = e.labelCross + labelAcross(e) / 2;
      col.size = Math.max(col.size, labelAlong(e));
      col.members.push(e);
    }
    let along = 0;
    columns.forEach((col, i) => {
      for (const e of col.members) e.labelAlong = along + col.size / 2;
      along += col.size + (i < columns.length - 1 ? 4 : 0);
    });
    // 10 between the last label and the first lane, so no lane runs near a label (review B7).
    labelRoom[g] = along ? along + LAYOUT.labelLineClear : 0;
  });
  const C = LAYOUT.laneClearance;
  // What a gap keeps clear at its ends for the groups either side (review, 2026-11-18): a group
  // starting after it keeps its title band and margin free of lanes; a group ending before it
  // reaches past any loop of its own, so the loop stays inside it; and between the two, the 24
  // every pair of groups keeps.
  // Each only where it applies across: a band or a margin keeps clear of what runs over that
  // group, not of the whole gap (review C9: a gap sized for the widest needs left a group's
  // inside two-thirds empty).
  const ownLoop = (t) => t.loop && t.edge.from.group !== null && groupById.get(t.edge.from.group).max === t.edge.from.rank;
  const over = (lo, hi, G, pad) => hi > G.v.pos - pad && lo < G.v.pos + G.size + pad;
  const spanOf = (e) => [e.labelCross - labelAcross(e) / 2, e.labelCross + labelAcross(e) / 2];
  const step = LAYOUT.laneSpacing;
  // Each lane's place within its gap: loops first, nearest their box, then the rest.
  const plans = turns.map((list, g) => {
    const ordered = orderTurns(list);
    const loops = ordered.filter((t) => t.loop);
    const rest = ordered.filter((t) => !t.loop);
    const ends = groups.filter((G) => G.max === g);
    const starts = groups.filter((G) => G.min === g + 1);
    // How far before the next rank something across [lo, hi] must stop: a lane's corner keeps
    // 24 from a box, and clear of the title band and margin of a group starting there.
    const clearAt = (lo, hi, base) => Math.max(base, ...starts.filter((G) => over(lo, hi, G, 12)).map((G) => M + G.band + 12));
    // Labels start 12 into the gap, enough to keep off the box they leave — 24 where a group
    // ends there, so a label clears that group's border.
    const labels = reservedIn[g];
    const lead = labels.some((e) => ends.some((G) => over(...spanOf(e), G, 4))) ? C : 12;
    const first = labels.length ? Math.max(C, lead + labelRoom[g]) : C;
    loops.forEach((t, i) => {
      t.rel = first + i * step;
    });
    const lastLoop = loops.length ? first + (loops.length - 1) * step : null;
    const reach = loops.some(ownLoop) ? lastLoop + LAYOUT.loopReach : 0;
    const restFirst = lastLoop === null ? first : reach ? reach + LAYOUT.loopReach : lastLoop + step;
    // A lane well clear of every label's span across needs no room kept for the labels.
    const clearOfLabels = (t) =>
      labels.every((e) => {
        const [a, b] = spanOf(e);
        return Math.max(t.s, t.t) < a - LAYOUT.labelLineClear || Math.min(t.s, t.t) > b + LAYOUT.labelLineClear;
      });
    let prev = -Infinity;
    for (const t of rest) {
      t.rel = Math.max(lastLoop === null && clearOfLabels(t) ? C : restFirst, prev + step);
      prev = t.rel;
    }
    const laneNeed = (t) => t.rel + clearAt(Math.min(t.s, t.t), Math.max(t.s, t.t), C);
    const needs = [g < maxRank ? LAYOUT.rankGap[direction] : 0, ...ordered.map(laneNeed)];
    for (const e of labels) needs.push(lead + e.labelAlong + labelAlong(e) / 2 + clearAt(...spanOf(e), 12));
    // Two groups either side of the gap keep 24 between their boxes where they face each other.
    for (const G of ends) {
      const own = reach && nodes.some((n) => n.group === G.id && n.rank === g && n.loops.length);
      for (const H of starts) if (over(G.v.pos, G.v.pos + G.size, H, LAYOUT.groupGap)) needs.push((own ? reach : M) + LAYOUT.groupGap + M + H.band);
    }
    const size = Math.max(...needs);
    // What room is left moves the other lanes off the box they leave, toward the middle.
    const slack = rest.length ? Math.min(...rest.map((t) => size - laneNeed(t))) : 0;
    for (const t of rest) t.rel += slack / 2;
    return { ordered, reach, size, lead };
  });
  const gapSize = plans.map((p) => p.size);
  const mainStart = [];
  let at = 0;
  for (let r = 0; r <= maxRank; r += 1) {
    mainStart[r] = at;
    at += mainSize[r] + (r < gapCount ? gapSize[r] : 0);
  }
  const gapStart = (g) => mainStart[g] + mainSize[g];
  plans.forEach((p, g) => {
    for (const turn of p.ordered) turn.main = gapStart(g) + turn.rel;
  });
  for (const n of nodes) n.mainStart = mainStart[n.rank] + (mainSize[n.rank] - mainOf(n)) / 2;

  // ── routes, as (main, cross) pairs, then turned into x and y.
  const xy = ([main, cross]) => (right ? [main, cross] : [cross, main]);
  for (const e of edges) {
    let pts;
    if (e.loop) {
      const side = e.from.mainStart + mainOf(e.from);
      const lane = e.loopTurn.main;
      pts = [[side, e.loopPorts[0]], [lane, e.loopPorts[0]], [lane, e.loopPorts[1]], [side, e.loopPorts[1]]];
    } else {
      const t = tail(e);
      const h = head(e);
      pts = [[t.mainStart + mainOf(t), e.hops[0].s]];
      for (const hop of e.hops) if (hop.turn) pts.push([hop.turn.main, hop.s], [hop.turn.main, hop.t]);
      pts.push([h.mainStart, e.hops.at(-1).t]);
    }
    e.route = simplify(pts).map(xy);
  }

  // ── boxes, in x and y.
  const boxOf = (n) => {
    const [x, y] = xy([n.mainStart, n.item.start]);
    return { x, y, w: n.w, h: n.h };
  };
  const nodeBoxes = nodes.map(boxOf);
  // The text block, centred in a box that may have grown past it for its arrows.
  const textBoxes = nodes.map((n, i) => ({ x: nodeBoxes[i].x + (n.w - n.textW) / 2, y: nodeBoxes[i].y + (n.h - n.textH) / 2, w: n.textW, h: n.textH }));
  for (const g of groups) {
    // Round its members, not their whole ranks: a short box in a tall rank leaves no gap.
    const members = nodes.filter((n) => n.group === g.id);
    // In "right" the title starts where the first column's members do, kept within that column
    // (where no lane runs, and which was widened to hold it), and the box takes it in too.
    const firstLeft = Math.min(...members.filter((n) => n.rank === g.min).map((n) => n.mainStart));
    const titleMain = right && g.titleLines.length ? clamp(firstLeft, mainStart[g.min], mainStart[g.min] + mainSize[g.min] - g.titleW) : null;
    const main0 = Math.min(...members.map((n) => n.mainStart), titleMain ?? Infinity) - M - g.band;
    // A group holding a loop on its last rank reaches past that loop's lane, so the loop and
    // its label stay inside it (review B6).
    const ownsLoop = nodes.some((n) => n.group === g.id && n.rank === g.max && n.loops.length);
    const membersEnd = Math.max(...members.map((n) => n.mainStart + mainOf(n)), titleMain === null ? -Infinity : titleMain + g.titleW);
    const main1 = ownsLoop && g.max < gapCount && plans[g.max].reach ? Math.max(gapStart(g.max) + plans[g.max].reach, membersEnd + M) : membersEnd + M;
    const [x, y] = xy([main0, g.v.pos]);
    g.box = right ? { x, y, w: main1 - main0, h: g.size } : { x, y, w: g.size, h: main1 - main0 };
    if (g.titleLines.length) {
      const [tx, ty] = right ? [titleMain, g.v.pos + LAYOUT.groupTitleInset] : [g.titleAt, main0 + LAYOUT.groupTitleInset];
      g.titleBox = { x: tx, y: ty, w: g.titleW, h: g.titleLines.length * titleLine };
    }
  }
  // In "down" the lines into a group's first rank cross its title band. Ports keep clear of
  // the title where they can (see the ports above); where one cannot, the title moves along
  // its band to the first place no line runs through.
  const allSegments = edges.flatMap((e) => e.route.slice(1).map((p, k) => [e.route[k], p]));
  for (const g of groups) {
    if (right || !g.titleBox) continue;
    const t = g.titleBox;
    const hit = (x) => allSegments.some(([a, b]) => segmentTouches(a, b, { x: x - 4, y: t.y - 2, w: t.w + 8, h: t.h + 4 }));
    if (!hit(t.x)) continue;
    const candidates = allSegments
      .filter(([a, b]) => a[0] === b[0] && Math.max(a[1], b[1]) >= t.y && Math.min(a[1], b[1]) <= t.y + t.h)
      .map(([a]) => a[0] + 6)
      .filter((x) => x > t.x)
      .sort((p, q) => p - q);
    const free = candidates.find((x) => x + t.w <= g.box.x + g.box.w - M && !hit(x));
    if (free !== undefined) t.x = free;
  }

  // ── 8. labels: on the longest straight part, slid along it until it touches nothing.
  const titleBoxes = groups.filter((g) => g.titleBox).map((g) => g.titleBox);
  const segments = edges.flatMap((e) => e.route.slice(1).map((p, k) => ({ edge: e, k, a: e.route[k], b: p })));
  const placed = [];
  const pending = edges.filter((e) => e.label);
  for (const e of pending) {
    const [cx, cy] = xy([gapStart(e.labelGap) + plans[e.labelGap].lead + e.labelAlong, e.labelCross]);
    e.reserved = { x: cx - e.measured.w / 2, y: cy - e.measured.h / 2, w: e.measured.w, h: e.measured.h };
  }
  // A slot still held for a label not yet placed is as solid as a box: that keeps every
  // label's own slot free for it to fall back on.
  // A label sits wholly inside a group or wholly outside it, never across its border (review B6).
  const groupBoxes = groups.map((g) => g.box);
  const within = (box, g, pad) => box.x >= g.x + pad && box.y >= g.y + pad && box.x + box.w <= g.x + g.w - pad && box.y + box.h <= g.y + g.h - pad;
  const blocked = (box, e) =>
    nodeBoxes.some((b) => overlaps(box, b, LAYOUT.labelClearance)) ||
    titleBoxes.some((b) => overlaps(box, b, 2)) ||
    placed.some((b) => overlaps(box, b, 2)) ||
    pending.some((o) => o !== e && overlaps(box, o.reserved, 2)) ||
    groupBoxes.some((g) => overlaps(box, g, 4) && !within(box, g, 4));
  // Lines that come too near: its own edge's other parts touching it, or another edge's within
  // 10 of it (review B7: a line beside a label reads as that label's).
  // A line through the label costs far more than one merely near it, so a near miss is never
  // traded for a crossing.
  const grow = (box, pad) => ({ x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad });
  const crossings = (box, e, k, near = segments) =>
    near.reduce((n, s) => {
      if (s.edge === e && s.k === k) return n;
      if (segmentTouches(s.a, s.b, grow(box, 1))) return n + 100;
      return n + (s.edge !== e && segmentTouches(s.a, s.b, grow(box, LAYOUT.labelLineClear)) ? 1 : 0);
    }, 0);
  for (const e of edges) {
    if (!e.label) continue;
    const { w, h } = e.measured;
    const runs = e.route
      .slice(1)
      .map((p, k) => ({ k, a: e.route[k], b: p, len: Math.abs(p[0] - e.route[k][0]) + Math.abs(p[1] - e.route[k][1]) }))
      .sort((p, q) => q.len - p.len || p.k - q.k)
      .slice(0, 6);
    let best = null;
    search: for (const run of runs) {
      // Only lines near this run can meet a label slid along it: found once, not per step
      // (code review: a 40-box chain with 41 labelled long edges took up to 350 ms).
      const reach = LAYOUT.labelLineClear + 2;
      const band = { x: Math.min(run.a[0], run.b[0]) - w / 2 - reach, y: Math.min(run.a[1], run.b[1]) - h / 2 - reach, w: Math.abs(run.b[0] - run.a[0]) + w + 2 * reach, h: Math.abs(run.b[1] - run.a[1]) + h + 2 * reach };
      const near = segments.filter((s) => segmentTouches(s.a, s.b, band));
      for (let step = 0; step <= 80; step += 1) {
        // From the middle outward, 4 px at a time, alternately each way.
        const off = (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 4;
        if (Math.abs(off) > run.len / 2) break;
        const f = (run.len / 2 + off) / (run.len || 1);
        const cx = run.a[0] + (run.b[0] - run.a[0]) * f;
        const cy = run.a[1] + (run.b[1] - run.a[1]) * f;
        const box = { x: cx - w / 2, y: cy - h / 2, w, h };
        if (blocked(box, e)) continue;
        const score = crossings(box, e, run.k, near);
        if (!best || score < best.score) best = { box, score };
        if (score === 0) break search;
      }
    }
    // Its own slot sits on the first part of the route, which leaves the box through that gap.
    const slotScore = crossings(e.reserved, e, 0);
    if (!best || slotScore < best.score) best = { box: e.reserved, score: slotScore };
    // Never across a group's border: a slot that is, moves across its own line — which still
    // runs through it — to the nearer side where it clears that border (fix round 2: a line
    // drawn straight near a group's edge took its label with it).
    const straddles = (box) => groupBoxes.some((g) => overlaps(box, g, 4) && !within(box, g, 4));
    if (straddles(best.box)) {
      const key = right ? 'y' : 'x';
      const most = (right ? h : w) / 2 - 4;
      search: for (let d = 2; d <= most; d += 2) {
        for (const sign of [1, -1]) {
          const box = { ...best.box, [key]: best.box[key] + sign * d };
          if (!straddles(box) && !nodeBoxes.some((b) => overlaps(box, b, LAYOUT.labelClearance)) && !placed.some((b) => overlaps(box, b, 2))) {
            best = { box, score: best.score };
            break search;
          }
        }
      }
    }
    e.labelBox = best.box;
    placed.push(best.box);
    pending.splice(pending.indexOf(e), 1);
  }

  // ── fit: everything moved so the content starts at the 24 px margin.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x0, y0, x1, y1) => {
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  };
  for (const b of [...nodeBoxes, ...groups.map((g) => g.box), ...placed]) take(b.x, b.y, b.x + b.w, b.y + b.h);
  for (const e of edges) for (const [x, y] of e.route) take(x, y, x, y);
  const dx = LAYOUT.margin - minX;
  const dy = LAYOUT.margin - minY;
  const move = (b) => (b ? { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h } : null);

  const layout = {
    direction,
    width: maxX - minX + 2 * LAYOUT.margin,
    height: maxY - minY + 2 * LAYOUT.margin,
    nodes: nodes.map((n, i) => ({ id: n.id, ...move(nodeBoxes[i]), radius: n.radius, textBox: move(textBoxes[i]), title: n.title, titleLines: n.titleLines, lines: n.lines, kind: n.kind, group: n.group, icon: n.icon })),
    groups: groups.map((g) => ({ id: g.id, title: g.title, titleLines: g.titleLines, titleBox: move(g.titleBox), ...move(g.box) })),
    edges: edges.map((e) => ({
      from: e.from.id,
      to: e.to.id,
      points: (e.reversed ? [...e.route].reverse() : e.route).map(([x, y]) => [x + dx, y + dy]),
      label: e.label,
      labelLines: e.measured ? e.measured.lines : [],
      labelBox: move(e.labelBox),
      style: e.style,
      reversed: e.reversed,
    })),
  };
  return { layout, more };
}
