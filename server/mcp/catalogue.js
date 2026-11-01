/**
 * MCP servers worth suggesting, so plugging one in is a button rather than
 * research.
 *
 * The problem this solves: the MCP panel asks for a command, and somebody who has
 * never seen one has no idea what to type. Every entry here is a real server with
 * a real install command, so the panel can offer a list and fill the field in.
 *
 * **Where these came from.** The first three were read off this machine's own
 * Claude Code plugin cache — the `.mcp.json` files under
 * `~/.claude/plugins/cache` — so they are the exact commands already working here
 * rather than something remembered from documentation. The rest are the official
 * reference servers.
 *
 * Nothing here is installed or run by adding it to this file. The user still
 * presses Connect, the command is still tried before it is stored, and every tool
 * a server offers still stops for approval. This is a list of suggestions, and
 * that is all it is.
 *
 * `needs` names an environment variable or header the server wants. Said out loud
 * rather than discovered when the first call fails.
 */
export const MCP_CATALOGUE = [
  /* ── found installed on this machine ──────────────────────────────── */
  {
    id: 'context7',
    label: 'Context7',
    by: 'Upstash',
    blurb:
      'Up-to-date documentation for any library or framework, fetched on demand. Stops the assistant answering from a stale memory of an API that has changed.',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    needs: { header: 'Authorization', why: 'Optional. Without a key it works but is rate-limited. Get one at context7.com.' },
    tags: ['docs', 'coding'],
  },
  {
    id: 'gitnexus',
    label: 'GitNexus',
    by: 'GitNexus',
    blurb:
      'Builds a graph of a codebase, so questions like "what calls this" and "what breaks if I change it" are answered from the code rather than guessed.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'gitnexus@latest', 'mcp'],
    tags: ['coding', 'analysis'],
  },
  {
    id: 'repomix',
    label: 'Repomix',
    by: 'Repomix',
    blurb:
      'Packs a whole repository into one file a model can read at once. Useful for a review or an audit, where the shape of everything matters more than any one file.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'repomix@latest', '--mcp'],
    tags: ['coding', 'analysis'],
  },

  /* ── the official reference servers ───────────────────────────────── */
  {
    id: 'filesystem',
    label: 'Filesystem',
    by: 'Model Context Protocol',
    blurb:
      'Reads and writes files under folders you name. Note this app already has its own file tools; this is for reaching a folder outside the workspace on purpose.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    argsHint: 'Add the folders it may touch, e.g. D:\\work',
    tags: ['files'],
  },
  {
    id: 'github',
    label: 'GitHub',
    by: 'Model Context Protocol',
    blurb:
      "GitHub's own server: issues, pull requests, code search, actions. Wider than this app's built-in `github` tool, which is the REST API by hand.",
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    needs: { env: 'GITHUB_PERSONAL_ACCESS_TOKEN', why: 'A fine-grained personal access token from GitHub → Settings → Developer settings.' },
    tags: ['coding', 'project'],
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    by: 'Model Context Protocol',
    blurb: 'Runs read-only queries against a Postgres database and reads its schema. For answering questions from real data.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    argsHint: 'Add the connection string, e.g. postgresql://user:pass@host/db',
    tags: ['data'],
  },
  {
    id: 'sentry',
    label: 'Sentry',
    by: 'Sentry',
    blurb: 'Reads errors and stack traces from Sentry, so a bug report can start from what actually happened rather than a description of it.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server'],
    needs: { env: 'SENTRY_AUTH_TOKEN', why: 'Sentry → Settings → Auth Tokens.' },
    tags: ['monitoring'],
  },
  {
    id: 'playwright',
    label: 'Playwright',
    by: 'Microsoft',
    blurb:
      "Browser automation with an accessibility-tree view of the page. This app's own sandbox does the same job; use this when you want Playwright's own tooling.",
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    tags: ['browser', 'testing'],
  },
  {
    id: 'figma',
    label: 'Figma',
    by: 'Figma',
    blurb: 'Reads a Figma file: frames, layers, styles and measurements. For turning a design into markup without eyeballing a screenshot.',
    transport: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    note: 'Runs inside the Figma desktop app — enable it in Figma → Preferences → Enable local MCP server.',
    tags: ['design'],
  },
  {
    id: 'notion',
    label: 'Notion',
    by: 'Notion',
    blurb: "Notion's own server — richer than this app's `notion_search`, which only finds pages.",
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    tags: ['docs', 'project'],
  },
  {
    id: 'fetch',
    label: 'Fetch',
    by: 'Model Context Protocol',
    blurb: 'Fetches a URL and converts it to Markdown. Overlaps this app\'s `web_fetch`; worth it for the cleaner conversion on documentation sites.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    tags: ['web'],
  },
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    by: 'Model Context Protocol',
    blurb: 'A structured scratchpad for working through a hard problem in steps, revising earlier ones as it goes.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    tags: ['reasoning'],
  },
];

/**
 * Find suggestions for a phrase.
 *
 * Deliberately forgiving: matched against the label, the id, the blurb and the
 * tags, so "database" finds Postgres and "design" finds Figma without anybody
 * having to know what the server is called.
 */
export function searchCatalogue(query, limit = 8) {
  const text = String(query || '').toLowerCase().trim();
  if (!text) return MCP_CATALOGUE.slice(0, limit);

  const words = text.split(/\s+/).filter(Boolean);
  const scored = MCP_CATALOGUE.map((entry) => {
    const haystack = `${entry.id} ${entry.label} ${entry.blurb} ${(entry.tags || []).join(' ')}`.toLowerCase();
    // The label matching is worth more than a word buried in a description.
    let score = 0;
    for (const word of words) {
      if (entry.id.includes(word) || entry.label.toLowerCase().includes(word)) score += 3;
      else if ((entry.tags || []).some((tag) => tag.includes(word))) score += 2;
      else if (haystack.includes(word)) score += 1;
    }
    return { entry, score };
  })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((row) => row.entry);
}
