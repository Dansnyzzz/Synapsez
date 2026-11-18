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

import { TEXT, lineHeight, textWidth, wrapText, measureNode, measureLabel } from './measure.js';

// The shape "auto" aims for, and the most a drawing may shrink to fit the widest it is drawn.
export const FIT = Object.freeze({ aspect: 16 / 10, maxWidth: 1200, minScale: 0.8 });

export const LAYOUT = Object.freeze({
  rankGap: Object.freeze({ right: 72, down: 56 }),
  nodeGap: 24,
  groupGap: 40,
  groupMargin: 16,
  groupTitleInset: 10,
  edgeGap: 12,
  portSpacing: 8,
  laneSpacing: 8,
  laneClearance: 24,
  labelClearance: 8,
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
 * Of a drawing laid out both ways, the one to keep: the one whose box is closer to 16:10,
 * provided it fits 1,200 px wide at a scale of 0.8 or more; otherwise the narrower. Closeness
 * is measured on a log scale, so twice too wide and twice too tall are equally far off. A tie
 * keeps "right", the way a flow is read.
 */
export function chooseDirection(right, down) {
  const off = (l) => Math.abs(Math.log(l.width / l.height / FIT.aspect));
  const fits = (l) => l.width * FIT.minScale <= FIT.maxWidth;
  const closer = off(down) < off(right) ? down : right;
  if (fits(closer)) return closer;
  return down.width < right.width ? down : right;
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
 * @param {Parameters<typeof layoutDiagram>[0]} diagram
 * @param {'right' | 'down'} direction
 */
function layoutOne(diagram, direction) {
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
    return { index, from, to, label, style: e.style || 'solid', loop: from === to, reversed: false, hops: [], loopPorts: [0, 0], loopTurn: null, measured: label ? measureLabel(label) : null, labelGap: 0, labelCross: 0, labelAlong: 0, reserved: null, route: [], labelBox: null };
  });
  const labelAcross = (e) => (right ? e.measured.h : e.measured.w);
  const labelAlong = (e) => (right ? e.measured.w : e.measured.h);
  // Half the room a port needs along its side: 4 px, or half its label and 2 more when the
  // label sits on the line leaving that port — so the label covers no neighbour's line.
  const portHalf = (e, out) => (out && e.label ? labelAcross(e) / 2 + 2 : LAYOUT.portSpacing / 2);
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
    if (e.loop) halvesOf[e.from.index].out.push(portHalf(e, true), portHalf(e, false));
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

  const groups = (diagram.groups || []).map((g, index) => ({ index, id: g.id, title: g.title || '', min: Infinity, max: -Infinity, items: [], stacks: new Map(), slack: new Map(), shift: new Map(), header: 0, inner: 0, size: 0, titleLines: [], titleW: 0, v: null, box: null, titleBox: null }));
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

  // ── sizes along the main axis, and where each group's title goes.
  const mainSize = layers.map((layer) => Math.max(0, ...layer.filter((it) => it.type === 'node').map((it) => mainOf(it.node))));
  const titleLine = lineHeight(TEXT.groupTitleSize);
  for (const g of groups) {
    if (!g.title) continue;
    // The title stays inside its group's first rank, where no lane runs: above the members for
    // "right" (wrapped to that column), beside them for "down" (that row grows to hold it).
    if (right) {
      g.titleLines = wrapText(g.title, mainSize[g.min], TEXT.groupTitleSize, true);
      g.titleW = mainSize[g.min];
      g.header = LAYOUT.groupTitleInset + g.titleLines.length * titleLine;
    } else {
      g.titleLines = wrapText(g.title, TEXT.groupTitleMaxWidth, TEXT.groupTitleSize, true);
      g.titleW = Math.ceil(Math.max(...g.titleLines.map((l) => textWidth(l, TEXT.groupTitleSize, true))));
      g.header = LAYOUT.groupTitleInset + g.titleW;
      mainSize[g.min] = Math.max(mainSize[g.min], Math.ceil(g.titleLines.length * titleLine));
    }
  }

  // ── 6. positions across the ranks.
  const gapBetween = (a, b) => (a.type === 'node' || b.type === 'node' ? LAYOUT.nodeGap : LAYOUT.edgeGap);
  const placeStack = (g, r) => {
    let at = g.header + M + g.shift.get(r);
    const stack = g.stacks.get(r);
    stack.forEach((it, i) => {
      if (i) at += gapBetween(stack[i - 1], it);
      it.offset = at;
      at += it.size;
    });
  };
  for (const g of groups) {
    for (let r = g.min; r <= g.max; r += 1) {
      const stack = layers[r].filter((it) => it.group === g.id && it.type !== 'hold');
      g.stacks.set(r, stack);
      g.items.push(...stack);
      g.inner = Math.max(g.inner, stack.reduce((s, it, i) => s + it.size + (i ? gapBetween(stack[i - 1], it) : 0), 0));
    }
    g.size = g.header + 2 * M + g.inner;
    for (let r = g.min; r <= g.max; r += 1) {
      const used = g.stacks.get(r).reduce((s, it, i, all) => s + it.size + (i ? gapBetween(all[i - 1], it) : 0), 0);
      g.slack.set(r, g.inner - used);
      g.shift.set(r, (g.inner - used) / 2);
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
        const gap = prev.kind === 'block' && kind === 'block' ? LAYOUT.groupGap - 2 * M : prev.kind === 'node' || kind === 'node' ? LAYOUT.nodeGap : LAYOUT.edgeGap;
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

  // ── 7. ports: spread along the side facing the next rank (out) and the previous one (in).
  // Neighbours are their halves apart, the ends their half (or the inset) from the corners, and
  // what is left over is shared evenly. The side was grown to sideNeed, so it always fits.
  const spread = (n, halves) => {
    const k = halves.length;
    if (k === 0) return [];
    const first = Math.max(insetOf(n), halves[0]);
    const last = Math.max(insetOf(n), halves[k - 1]);
    const steps = halves.slice(1).map((t, i) => halves[i] + t);
    const spare = Math.max(0, crossOf(n) - first - last - steps.reduce((s, d) => s + d, 0)) / (k + 1);
    const spots = [n.item.start + first + spare];
    for (const d of steps) spots.push(spots.at(-1) + d + spare);
    return spots;
  };
  for (const n of nodes) {
    const outs = [...n.item.outs].sort((p, q) => centreOf(p.b) - centreOf(q.b) || p.edge.index - q.edge.index);
    // A loop takes the two ports at the far end of the side, so it crosses no other way out.
    const halves = [...outs.map((h) => portHalf(h.edge, true)), ...n.loops.flatMap((e) => [portHalf(e, true), portHalf(e, false)])];
    const spots = spread(n, halves);
    outs.forEach((h, i) => {
      h.s = spots[i];
    });
    n.loops.forEach((e, i) => {
      e.loopPorts = [spots[outs.length + 2 * i], spots[outs.length + 2 * i + 1]];
    });
    const ins = [...n.item.ins].sort((p, q) => centreOf(p.a) - centreOf(q.a) || p.edge.index - q.edge.index);
    const inSpots = spread(n, ins.map((h) => portHalf(h.edge, false)));
    ins.forEach((h, i) => {
      h.t = inSpots[i];
    });
  }
  for (const d of dummies) {
    for (const h of d.outs) h.s = d.start;
    for (const h of d.ins) h.t = d.start;
  }
  // Nearly straight is made straight, so a line never gets a jog too small to read as a turn.
  // Ports are 8 or more apart, so moving one by under 2 keeps it clear of the next.
  for (const e of edges) {
    e.hops.forEach((h, k) => {
      if (Math.abs(h.s - h.t) < 2) h.t = h.s;
      if (k + 1 < e.hops.length) e.hops[k + 1].s = h.t;
    });
  }

  // ── gaps between ranks: room for labels, then one lane per turn.
  const lastHasLoop = nodes.some((n) => n.loops.length && n.rank === maxRank);
  const gapCount = maxRank + (lastHasLoop ? 1 : 0);
  const turns = Array.from({ length: gapCount }, () => []);
  for (const e of edges) {
    if (e.loop) {
      e.loopTurn = { edge: e, s: e.loopPorts[0], t: e.loopPorts[1], loop: true, main: 0 };
      turns[e.from.rank].push(e.loopTurn);
      continue;
    }
    for (const h of e.hops) {
      if (h.s === h.t) continue;
      h.turn = { edge: e, s: h.s, t: h.t, loop: false, main: 0 };
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
    // 4 px between the last label and the first lane, so no lane touches a label.
    labelRoom[g] = along ? along + 4 : 0;
  });
  const C = LAYOUT.laneClearance;
  const gapSize = turns.map((list, g) => Math.max(g < maxRank ? LAYOUT.rankGap[direction] : 0, 2 * C + labelRoom[g] + Math.max(0, list.length - 1) * LAYOUT.laneSpacing));
  const mainStart = [];
  let at = 0;
  for (let r = 0; r <= maxRank; r += 1) {
    mainStart[r] = at;
    at += mainSize[r] + (r < gapCount ? gapSize[r] : 0);
  }
  const gapStart = (g) => mainStart[g] + mainSize[g];
  turns.forEach((list, g) => {
    const ordered = orderTurns(list);
    const from = gapStart(g) + C + labelRoom[g];
    const to = gapStart(g) + gapSize[g] - C;
    ordered.forEach((turn, i) => {
      turn.main = ordered.length === 1 ? (from + to) / 2 : from + ((to - from) * i) / (ordered.length - 1);
    });
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
    const main0 = mainStart[g.min] - M;
    const main1 = mainStart[g.max] + mainSize[g.max] + M;
    const [x, y] = xy([main0, g.v.pos]);
    g.box = right ? { x, y, w: main1 - main0, h: g.size } : { x, y, w: g.size, h: main1 - main0 };
    if (g.titleLines.length) {
      const [tx, ty] = right ? [mainStart[g.min], g.v.pos + LAYOUT.groupTitleInset] : [g.v.pos + LAYOUT.groupTitleInset, mainStart[g.min]];
      g.titleBox = { x: tx, y: ty, w: g.titleW, h: g.titleLines.length * titleLine };
    }
  }

  // ── 8. labels: on the longest straight part, slid along it until it touches nothing.
  const titleBoxes = groups.filter((g) => g.titleBox).map((g) => g.titleBox);
  const segments = edges.flatMap((e) => e.route.slice(1).map((p, k) => ({ edge: e, k, a: e.route[k], b: p })));
  const placed = [];
  const pending = edges.filter((e) => e.label);
  for (const e of pending) {
    const [cx, cy] = xy([gapStart(e.labelGap) + C + e.labelAlong, e.labelCross]);
    e.reserved = { x: cx - e.measured.w / 2, y: cy - e.measured.h / 2, w: e.measured.w, h: e.measured.h };
  }
  // A slot still held for a label not yet placed is as solid as a box: that keeps every
  // label's own slot free for it to fall back on.
  const blocked = (box, e) =>
    nodeBoxes.some((b) => overlaps(box, b, LAYOUT.labelClearance)) ||
    titleBoxes.some((b) => overlaps(box, b, 2)) ||
    placed.some((b) => overlaps(box, b, 2)) ||
    pending.some((o) => o !== e && overlaps(box, o.reserved, 2));
  const crossings = (box, e, k, near = segments) => {
    const grown = { x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 };
    return near.reduce((n, s) => n + (s.edge === e && s.k === k ? 0 : segmentTouches(s.a, s.b, grown) ? 1 : 0), 0);
  };
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
      const band = { x: Math.min(run.a[0], run.b[0]) - w / 2 - 2, y: Math.min(run.a[1], run.b[1]) - h / 2 - 2, w: Math.abs(run.b[0] - run.a[0]) + w + 4, h: Math.abs(run.b[1] - run.a[1]) + h + 4 };
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

  return {
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
}
