/**
 * MCP servers in a config file, as Claude Desktop, Cursor and VS Code write
 * them — Extensions → Advanced settings → Install from a config file (owner,
 * 2026-11-01). `mcpServers` (or VS Code's `servers`) by name, each a command
 * with its arguments or a URL, in the shape this app's add route takes. What
 * is neither is left out rather than guessed at.
 *
 * @param {any} json  the parsed file
 * @returns {{ name: string, transport: 'http' | 'stdio', url?: string, headers?: object, command?: string, args?: string[], env?: object }[]}
 */
export function serversInConfig(json) {
  const table = json?.mcpServers || json?.servers || json?.mcp?.servers || {};
  return Object.entries(table && typeof table === 'object' ? table : {})
    .map(([name, server]) => {
      if (server?.url) {
        return { name, transport: /** @type {const} */ ('http'), url: String(server.url), ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}) };
      }
      if (server?.command) {
        return {
          name,
          transport: /** @type {const} */ ('stdio'),
          command: String(server.command),
          args: Array.isArray(server.args) ? server.args.map(String) : [],
          ...(server.env && typeof server.env === 'object' ? { env: server.env } : {}),
        };
      }
      return null;
    })
    .filter(Boolean);
}
