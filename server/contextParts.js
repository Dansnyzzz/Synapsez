import { estimatePromptTokens } from './providers/index.js';

/**
 * What a conversation's context window is spent on, part by part.
 *
 * The gauge said how full the window was and nothing about why (owner,
 * 2026-10-19, with Claude Code's Context panel beside it). A request is the
 * system prompt — with the skills menu, the memory notes and a project's
 * briefing inside it — the tool catalogue, the MCP servers' tools, and the
 * conversation. Only the agent loop holds all of them, so it measures them each
 * step (`promptParts`), keeps the last figures on the conversation
 * (`chats.context_parts`, schema 31), and the gauge shares the window out in
 * those proportions (`contextBreakdown`).
 *
 * Estimates, by the same character rule the provider layer budgets with. The
 * total is the provider's own figure whenever there is one; the parts divide it.
 */

/** More rows than this in one list is a scroll, not a summary; the rest are summed. */
const MAX_ROWS = 24;

const tokensOf = (value) => (value ? estimatePromptTokens({ system: value }) : 0);

const MCP_NAME = /^mcp__(.+?)__/;

/**
 * The named entries of a menu the prompt carries — "- **name** …", with any
 * indented lines under it — and what each costs.
 */
function namedEntries(text) {
  const out = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const head = /^- \*\*(.+?)\*\*/.exec(line);
    if (head) {
      current = { name: head[1], text: line };
      out.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.text += `\n${line}`;
    } else {
      current = null;
    }
  }
  return out.map((entry) => ({ name: entry.name, tokens: tokensOf(entry.text) }));
}

/** The largest first, cut to `MAX_ROWS` with what is left summed into `more`. */
function capped(rows) {
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  const kept = sorted.slice(0, MAX_ROWS);
  const rest = sorted.slice(MAX_ROWS);
  return rest.length ? { rows: kept, more: { count: rest.length, tokens: rest.reduce((n, r) => n + r.tokens, 0) } } : { rows: kept };
}

/**
 * One step's request, part by part — estimated tokens, never the text itself.
 *
 * @param {{ system?: string, skills?: string, memory?: string, project?: string,
 *   tools?: any[], deferred?: any[] }} pieces
 *   `system` is the whole prompt as sent, with the other three inside it;
 *   `tools` what this step offers; `deferred` what waits behind `load_tools`.
 */
export function promptParts(pieces = {}) {
  const { system = '', skills = '', memory = '', project = '', tools = [], deferred = [] } = pieces;
  const own = tools.filter((t) => !MCP_NAME.test(t.name));
  const outside = tools.filter((t) => MCP_NAME.test(t.name));
  const servers = new Map();
  for (const tool of outside) {
    const name = MCP_NAME.exec(tool.name)[1];
    const row = servers.get(name) || { name, tools: 0, tokens: 0 };
    row.tools += 1;
    row.tokens += tokensOf(tool);
    servers.set(name, row);
  }
  const counts = { skills: tokensOf(skills), memory: tokensOf(memory), project: tokensOf(project) };
  return {
    system: Math.max(0, tokensOf(system) - counts.skills - counts.memory - counts.project),
    ...counts,
    tools: tokensOf(own),
    mcp: tokensOf(outside),
    deferred: { tools: deferred.length, tokens: tokensOf(deferred) },
    details: {
      mcp: capped([...servers.values()]),
      skills: capped(namedEntries(skills)),
      memory: capped(namedEntries(memory)),
    },
  };
}

/** The parts of a request, in the order the gauge lists them. */
export const PART_KEYS = ['messages', 'mcp', 'tools', 'system', 'skills', 'memory', 'project'];

/**
 * The window shared out among the parts.
 *
 * @param {{ used: number, context: number, budget: number, provided?: boolean }} info  `measure()`
 * @param {ReturnType<typeof promptParts>|null} parts  the last step's, or null before any
 * @param {number} transcript  the conversation's own estimate (`transcriptTokens`)
 * @returns {null|{ used: number, parts: Record<string, number>|null, reserve: number,
 *   free: number, deferred: any, details: any }}
 *   `reserve` is the room kept for the reply, which the fold triggers short of;
 *   `parts` is null when nothing has been measured yet.
 */
export function contextBreakdown(info, parts, transcript = 0) {
  const context = Number(info?.context) || 0;
  if (!context) return null;
  const reserve = Math.max(0, context - (Number(info.budget) || context));
  if (!parts || typeof parts !== 'object') {
    const used = Number(info.used) || 0;
    return { used, parts: null, reserve, free: Math.max(0, context - used - reserve), deferred: null, details: null };
  }

  const raw = {
    messages: Math.max(0, Number(transcript) || 0),
    mcp: Number(parts.mcp) || 0,
    tools: Number(parts.tools) || 0,
    system: Number(parts.system) || 0,
    skills: Number(parts.skills) || 0,
    memory: Number(parts.memory) || 0,
    project: Number(parts.project) || 0,
  };
  const estimate = PART_KEYS.reduce((sum, key) => sum + raw[key], 0);
  /*
   * A provider's figure is the truth, and the estimates share it out in their
   * proportions. Before the first reply (or after a fold) there is no figure
   * that includes the prompt and the tools, so the estimate is the total.
   */
  const used = info.provided ? Number(info.used) || estimate : Math.max(Number(info.used) || 0, estimate);
  const scale = estimate ? used / estimate : 0;
  const share = (n) => Math.round((Number(n) || 0) * scale);
  const scaledRows = (list) =>
    list && {
      rows: (list.rows || []).map((row) => ({ ...row, tokens: share(row.tokens) })),
      ...(list.more ? { more: { count: list.more.count, tokens: share(list.more.tokens) } } : {}),
    };

  return {
    used,
    parts: Object.fromEntries(PART_KEYS.map((key) => [key, share(raw[key])])),
    reserve,
    free: Math.max(0, context - used - reserve),
    // Not in `used`: these are listed by name only, and cost nothing until loaded.
    deferred: parts.deferred || null,
    details: {
      mcp: scaledRows(parts.details?.mcp),
      skills: scaledRows(parts.details?.skills),
      memory: scaledRows(parts.details?.memory),
    },
  };
}
