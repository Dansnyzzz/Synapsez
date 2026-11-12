/**
 * What each stored credential is bound to (crypto.js v2): whose it is, what it is for, and —
 * for the ones handed to a server — where it is sent. One place, read by the app where it
 * seals and opens and by the reseal (secretsReseal.js), so the two can never disagree about a
 * context: a mismatch would make the reseal quietly break every credential of that kind.
 *
 * Where a secret goes is part of its binding (security review, 2026-11-12): bound only to the
 * owner, an MCP server's headers stayed openable after someone with write access to the
 * database pointed the same row at their own host — and the app then sent them there. Bound
 * to the address too, the moved row no longer opens, so nothing is sent. Every writer of
 * these rows seals again from the plaintext with the address it saves, so an honest edit of
 * the address re-binds.
 */

/**
 * Where an MCP server's secrets go: its URL, or the program and arguments that receive its
 * environment, and where that program runs.
 *
 * @param {{ transport?: string, url?: string, command?: string, args?: unknown[], place?: string } | null | undefined} config
 */
export function mcpDestination(config) {
  if (!config || typeof config !== 'object') return 'none';
  if (config.command || config.transport === 'stdio') {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    return `stdio:${config.place || 'local'}:${JSON.stringify([String(config.command || ''), ...args])}`;
  }
  return `http:${String(config.url || '')}`;
}

/** An MCP server's sealed headers ('headers') or environment ('env'). */
export const mcpConfigContext = (userId, part, config) => ['mcp-config', userId, part === 'headers' ? 'headers' : 'env', mcpDestination(config)];

/** The cloud browser service's key, bound to the address it drives. */
export const cloudBrowserContext = (userId, url) => ['cloud-browser', userId, `url:${String(url || '')}`];

/** The MCP bridge's key on the account's cloud computer, bound to its address. */
export const mcpBridgeContext = (userId, url) => ['mcp-bridge', userId, `url:${String(url || '')}`];
