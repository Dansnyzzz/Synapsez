/*
 * A diagram as the model describes it — { direction, nodes, groups, edges } — checked before
 * it is laid out (owner, 2026-11-17: arrows that pointed at nothing, because the model wrote
 * every coordinate by hand). The model names what is in the drawing; the server places it.
 *
 * A refusal is written for the model, which reads it and sends the diagram again: it names
 * the node, edge or group by its id (or its position, counted from 1, when the id is the
 * problem) and says what to change. The limits keep a drawing readable and its layout fast:
 * past 40 boxes a drawing is two drawings.
 *
 * Accepted input comes back normalised, so the layout never guesses: defaults filled in,
 * text in composed Unicode (a Vietnamese letter typed as a base and its marks is one letter,
 * for counting and for width) with its whitespace collapsed, and a number taken as text.
 * Pure: no store, no network, no clock.
 *
 * `direction` defaults to "auto": the layout tries both ways and keeps the better-shaped one
 * (layout.js). `theme` is the canvas it is drawn for, and `icon` one of a fixed set
 * (icons.js), so a box can carry a picture without the model drawing one.
 */

import { ICON_NAMES } from './icons.js';

export const LIMITS = Object.freeze({ nodes: 40, edges: 80, groups: 8, id: 40, title: 60, lines: 6, line: 80, label: 60 });
export const DIRECTIONS = Object.freeze(['auto', 'right', 'down']);
export const THEMES = Object.freeze(['light', 'dark']);
export const KINDS = Object.freeze(['box', 'pill', 'note']);
export const STYLES = Object.freeze(['solid', 'dashed']);
export { ICON_NAMES };

// Built from the limit, so the rule and the number in its refusal cannot drift apart.
const ID = new RegExp(`^[A-Za-z0-9_-]{1,${LIMITS.id}}$`);
// How many node ids a refusal lists, so the model can pick the one it meant.
const IDS_SHOWN = 12;

/** A refusal: its message is for the model, and validateDiagram hands it back instead of throwing. */
class DiagramError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (s) => [...s].length;

/** Text from the model — a string or a number — composed, collapsed and trimmed; null for anything else. */
function text(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// A value echoed back in a refusal, cut short so a runaway string does not fill the reply.
const shown = (value) => {
  const s = String(value ?? '');
  return count(s) > 40 ? `${[...s].slice(0, 40).join('')}…` : s;
};

// An enum: missing means the default; case and surrounding spaces do not matter.
const choice = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value.trim().toLowerCase() : String(value);
};

const idOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '');

/** @param {any} input */
function read(input) {
  if (!isObject(input)) throw new DiagramError('A diagram is an object: { direction, nodes, groups, edges }.');

  const direction = choice(input.direction, 'auto');
  if (!DIRECTIONS.includes(direction)) throw new DiagramError(`direction is "${shown(input.direction)}": use "auto", "right" or "down".`);
  const theme = choice(input.theme, 'light');
  if (!THEMES.includes(theme)) throw new DiagramError(`theme is "${shown(input.theme)}": use "light" or "dark".`);

  // Counts first, so a vast input is refused before any of it is read.
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new DiagramError('A diagram needs nodes: a list of at least one { id, title }.');
  if (input.nodes.length > LIMITS.nodes) {
    throw new DiagramError(`A diagram has at most ${LIMITS.nodes} nodes, and this one has ${input.nodes.length}: merge some, or split it into two drawings.`);
  }
  const rawEdges = input.edges ?? [];
  if (!Array.isArray(rawEdges)) throw new DiagramError('edges must be a list of { from, to }.');
  if (rawEdges.length > LIMITS.edges) {
    throw new DiagramError(`A diagram has at most ${LIMITS.edges} edges, and this one has ${rawEdges.length}: keep the ones that matter, or split it into two drawings.`);
  }
  const rawGroups = input.groups ?? [];
  if (!Array.isArray(rawGroups)) throw new DiagramError('groups must be a list of { id, title }.');
  if (rawGroups.length > LIMITS.groups) throw new DiagramError(`A diagram has at most ${LIMITS.groups} groups, and this one has ${rawGroups.length}: merge some.`);

  const groups = [];
  const groupIds = new Set();
  rawGroups.forEach((raw, i) => {
    if (!isObject(raw)) throw new DiagramError(`group ${i + 1} is not an object: write { id, title }.`);
    const id = idOf(raw.id);
    if (!ID.test(id)) throw new DiagramError(`group ${i + 1} has the id "${shown(raw.id)}": an id is 1 to ${LIMITS.id} letters, digits, "_" or "-".`);
    if (groupIds.has(id)) throw new DiagramError(`group ${i + 1} reuses the id "${id}": every group needs its own id.`);
    // A group carrying a parent, or groups of its own, is a nesting the layout cannot draw.
    if ((raw.group ?? '') !== '' || (raw.parent ?? '') !== '' || (Array.isArray(raw.groups) && raw.groups.length)) {
      throw new DiagramError(`group "${id}" is inside another group: groups do not nest, so put its nodes in one group.`);
    }
    const title = text(raw.title) ?? '';
    if (count(title) > LIMITS.title) throw new DiagramError(`the title of group "${id}" has ${count(title)} characters: keep it to ${LIMITS.title}.`);
    groupIds.add(id);
    groups.push({ id, title });
  });

  const nodes = [];
  const nodeIds = new Set();
  input.nodes.forEach((raw, i) => {
    if (!isObject(raw)) throw new DiagramError(`node ${i + 1} is not an object: write { id, title }.`);
    const id = idOf(raw.id);
    if (!ID.test(id)) throw new DiagramError(`node ${i + 1} has the id "${shown(raw.id)}": an id is 1 to ${LIMITS.id} letters, digits, "_" or "-".`);
    if (nodeIds.has(id)) throw new DiagramError(`node ${i + 1} reuses the id "${id}": every node needs its own id.`);
    nodeIds.add(id);

    const title = text(raw.title);
    if (!title) throw new DiagramError(`node "${id}" needs a title.`);
    if (count(title) > LIMITS.title) throw new DiagramError(`the title of node "${id}" has ${count(title)} characters: keep it to ${LIMITS.title}.`);

    // A text with line breaks is taken as its lines, alone or in the list (the tool's schema
    // turns one text into a list of one); blank ones are dropped.
    const rawLines = raw.lines ?? [];
    const listed = typeof rawLines === 'string' ? [rawLines] : rawLines;
    if (!Array.isArray(listed) || listed.some((l) => text(l) === null)) throw new DiagramError(`lines of node "${id}" must be a list of short texts.`);
    const lines = listed.flatMap((l) => String(l).split(/\r?\n/)).map(text).filter(Boolean);
    if (lines.length > LIMITS.lines) throw new DiagramError(`node "${id}" has ${lines.length} lines: keep it to ${LIMITS.lines}, or split the box in two.`);
    lines.forEach((line, k) => {
      if (count(line) > LIMITS.line) throw new DiagramError(`line ${k + 1} of node "${id}" has ${count(line)} characters: keep each line to ${LIMITS.line}.`);
    });

    const kind = choice(raw.kind, 'box');
    if (!KINDS.includes(kind)) throw new DiagramError(`node "${id}" has kind "${shown(raw.kind)}": use "box", "pill" or "note".`);

    // Refused rather than dropped, with the whole set: a model that guessed one name learns them all.
    const icon = choice(raw.icon, null);
    if (icon !== null && !ICON_NAMES.includes(icon)) {
      throw new DiagramError(`node "${id}" has the icon "${shown(raw.icon)}": use one of ${ICON_NAMES.join(', ')}, or leave icon out.`);
    }

    const group = idOf(raw.group) || null;
    if (group !== null && !groupIds.has(group)) {
      throw new DiagramError(`node "${id}" is in group "${shown(raw.group)}", which is not a group id: add it to groups, or leave group out.`);
    }
    nodes.push({ id, title, lines, kind, group, icon });
  });

  const known = [...nodeIds];
  const list = `${known.slice(0, IDS_SHOWN).join(', ')}${known.length > IDS_SHOWN ? ', …' : ''}`;
  const edges = rawEdges.map((raw, i) => {
    if (!isObject(raw)) throw new DiagramError(`edge ${i + 1} is not an object: write { from, to }.`);
    const from = idOf(raw.from);
    if (!nodeIds.has(from)) throw new DiagramError(`edge ${i + 1} comes from "${shown(raw.from)}", which is not a node id. Node ids: ${list}.`);
    const to = idOf(raw.to);
    if (!nodeIds.has(to)) throw new DiagramError(`edge ${i + 1} goes to "${shown(raw.to)}", which is not a node id. Node ids: ${list}.`);
    const style = choice(raw.style, 'solid');
    if (!STYLES.includes(style)) throw new DiagramError(`edge ${i + 1} has style "${shown(raw.style)}": use "solid" or "dashed".`);
    let label = null;
    if (raw.label !== undefined && raw.label !== null) {
      label = text(raw.label);
      if (label === null) throw new DiagramError(`the label of edge ${i + 1} must be text.`);
      // Not one of the published limits: a label is a few words on an arrow, and a long one
      // would push the ranks apart. Same ceiling as a title.
      if (count(label) > LIMITS.label) throw new DiagramError(`the label of edge ${i + 1} has ${count(label)} characters: keep it to ${LIMITS.label}.`);
      label ||= null;
    }
    return { from, to, label, style };
  });

  // A group with no members has nowhere to be drawn — most often its members were listed on
  // the group instead of each node naming its group.
  for (const g of groups) {
    if (!nodes.some((n) => n.group === g.id)) throw new DiagramError(`group "${g.id}" has no nodes: put "group": "${g.id}" on the nodes that belong in it.`);
  }

  return { direction, theme, nodes, groups, edges };
}

/**
 * The diagram normalised, or what to change. Never throws for bad input: a refusal comes back
 * as `error`, worded for the model.
 *
 * @param {unknown} input
 * @returns {{ ok: true, diagram: { direction: string, theme: string, nodes: Array<{ id: string, title: string, lines: string[], kind: string, group: string | null, icon: string | null }>, groups: Array<{ id: string, title: string }>, edges: Array<{ from: string, to: string, label: string | null, style: string }> } } | { ok: false, error: string }}
 */
export function validateDiagram(input) {
  try {
    return { ok: true, diagram: read(input) };
  } catch (err) {
    if (err instanceof DiagramError) return { ok: false, error: err.message };
    throw err;
  }
}
