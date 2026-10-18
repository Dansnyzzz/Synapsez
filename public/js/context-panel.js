import { t } from './i18n.js';

/**
 * What the context window is spent on, drawn in the gauge's popover (owner,
 * 2026-10-19, after Claude Code's Context panel).
 *
 * Laid out across rather than down, as asked: one bar split into the parts,
 * the parts in two columns under it, and the three that have parts of their
 * own — MCP servers, memory notes, skills — opening in place. Every name in it
 * (a note, a server, a skill) is somebody's own text, so it is set as text,
 * never as markup.
 *
 * The figures come from the server (server/contextParts.js): estimates per
 * part, sharing out the provider's own total whenever there is one.
 */

/** The parts in the order they sit on the bar and in the list. */
const PARTS = ['messages', 'mcp', 'tools', 'system', 'skills', 'memory', 'project'];

/** 20,900 → "20.9K", 1,000,000 → "1M", 163 → "163". */
export function fmtTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  const short = (x, unit) => `${Number(x.toFixed(1))}${unit}`;
  if (n >= 1_000_000) return short(n / 1_000_000, 'M');
  if (n >= 1000) return short(n / 1000, 'K');
  return String(n);
}

/** A share of the window as people read one: "2.1%", "<0.1%", "0%". */
function pct(part, whole) {
  if (!whole || !part) return '0%';
  const value = (part / whole) * 100;
  return value < 0.1 ? '<0.1%' : `${Number(value.toFixed(1))}%`;
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/** One entry under the bar: its colour, its name, its size, its share. */
function legendRow(tone, label, tokens, context) {
  const row = node('li', 'ctx__key');
  // Whole, for a name cut short on a narrow screen, with the share a phone hides.
  row.title = `${label}: ${fmtTokens(tokens)} (${pct(tokens, context)})`;
  row.append(
    node('span', `ctx__swatch ctx--${tone}`),
    node('span', 'ctx__name', label),
    node('span', 'ctx__num', fmtTokens(tokens)),
    node('span', 'ctx__pct', pct(tokens, context)),
  );
  return row;
}

/**
 * A part that opens: its name and count, then one row per entry.
 *
 * @param {{ rows?: Array<{ name: string, tokens: number, tools?: number }>, more?: { count: number, tokens: number } }|null} list
 */
function fold(title, count, list, perRow = null) {
  const rows = list?.rows || [];
  if (!rows.length) return null;
  const wrap = node('details', 'ctx__fold');
  const head = node('summary', 'ctx__foldhead');
  head.append(node('span', 'ctx__foldname', title), node('span', 'ctx__foldcount', count));
  const body = node('ul', 'ctx__rows');
  for (const row of rows) {
    const item = node('li', 'ctx__row');
    item.append(node('span', 'ctx__rowname', row.name));
    item.append(node('span', 'ctx__rowmeta', perRow ? perRow(row) : ''));
    item.append(node('span', 'ctx__num', fmtTokens(row.tokens)));
    body.append(item);
  }
  if (list.more?.count) {
    const item = node('li', 'ctx__row ctx__row--more');
    item.append(node('span', 'ctx__rowname', t('context.more.rest', { n: list.more.count })), node('span', 'ctx__rowmeta', ''), node('span', 'ctx__num', fmtTokens(list.more.tokens)));
    body.append(item);
  }
  wrap.append(head, body);
  return wrap;
}

/**
 * The panel itself.
 *
 * @param {{ used: number, context: number, breakdown?: any }} info  what the gauge was given
 */
export function contextPanel(info) {
  const context = Number(info?.context) || 0;
  const breakdown = info?.breakdown || null;
  const used = Number(breakdown?.used ?? info?.used) || 0;
  const reserve = Number(breakdown?.reserve) || 0;
  const parts = breakdown?.parts || null;

  const panel = node('section', 'ctx');
  panel.setAttribute('aria-label', t('context.title'));

  const head = node('div', 'ctx__head');
  head.append(
    node('span', 'ctx__title', t('context.title')),
    node('span', 'ctx__used', t('context.usedPct', { percent: Math.round(context ? (used / context) * 100 : 0) })),
    node('span', 'ctx__total', t('context.ofTotal', { used: fmtTokens(used), total: fmtTokens(context) })),
  );
  panel.append(head);

  // What is drawn, in order: the measured parts (or "used" as one piece before
  // anything was measured), the free track, and the reply's room at the end.
  const pieces = parts
    ? PARTS.filter((key) => parts[key] > 0).map((key) => ({ key, tokens: parts[key], label: t(`context.part.${key}`) }))
    : used > 0
      ? [{ key: 'used', tokens: used, label: t('context.part.used') }]
      : [];
  const free = Math.max(0, context - used - reserve);

  const bar = node('div', 'ctx__bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute(
    'aria-label',
    [...pieces, { label: t('context.part.reserve'), tokens: reserve }, { label: t('context.part.free'), tokens: free }]
      .map((piece) => `${piece.label} ${fmtTokens(piece.tokens)}`)
      .join(', '),
  );
  for (const piece of pieces) {
    const seg = node('span', `ctx__seg ctx--${piece.key}`);
    seg.style.width = `${Math.min(100, (piece.tokens / (context || 1)) * 100)}%`;
    bar.append(seg);
  }
  bar.append(node('span', 'ctx__seg ctx__seg--free'));
  if (reserve) {
    const room = node('span', 'ctx__seg ctx--reserve');
    room.style.width = `${Math.min(100, (reserve / (context || 1)) * 100)}%`;
    bar.append(room);
  }
  panel.append(bar);

  const legend = node('ul', 'ctx__legend');
  for (const piece of pieces) legend.append(legendRow(piece.key, piece.label, piece.tokens, context));
  if (reserve) legend.append(legendRow('reserve', t('context.part.reserve'), reserve, context));
  legend.append(legendRow('free', t('context.part.free'), free, context));
  panel.append(legend);

  if (!parts) {
    panel.append(node('p', 'ctx__note', t('context.notMeasured')));
    return panel;
  }

  const details = breakdown.details || {};
  const servers = details.mcp?.rows || [];
  const folds = [
    fold(
      t('context.part.mcp'),
      t('context.more.mcpCount', { servers: servers.length, tools: servers.reduce((n, s) => n + (Number(s.tools) || 0), 0) }),
      details.mcp,
      (row) => t('context.serverTools', { n: row.tools || 0 }),
    ),
    fold(t('context.more.memory'), t('context.more.count', { n: (details.memory?.rows?.length || 0) + (details.memory?.more?.count || 0) }), details.memory),
    fold(t('context.part.skills'), t('context.more.count', { n: (details.skills?.rows?.length || 0) + (details.skills?.more?.count || 0) }), details.skills),
  ].filter(Boolean);
  if (folds.length) {
    const more = node('div', 'ctx__more');
    more.append(...folds);
    panel.append(more);
  }
  if (breakdown.deferred?.tools) {
    panel.append(node('p', 'ctx__note', t('context.deferred', { n: breakdown.deferred.tools, tokens: fmtTokens(breakdown.deferred.tokens) })));
  }
  panel.append(node('p', 'ctx__note', t('context.estimated')));
  return panel;
}
