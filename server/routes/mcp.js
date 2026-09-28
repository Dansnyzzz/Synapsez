import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { sealConfig, forgetMcp, probeMcpServer, mcpStatus, slugify } from '../mcp/registry.js';
import { searchCatalogue } from '../mcp/catalogue.js';
import { languageOf, translateMessage } from '../i18n/index.js';

/**
 * Lifted out of server/app.js — see the note on mountWorkspaceRoutes for why.
 *
 * The routes are unchanged: same handlers, same paths, same order. Only their
 * address in the tree moved.
 *
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function, body: Function }} ctx
 */
export function mountMcpRoutes(api, { wrap, body }) {
  /* ── MCP servers ──────────────────────────────────────────────────────
   *
   * The one thing to keep in mind reading these: a stdio MCP server is an
   * arbitrary program, and these routes are how it gets named. So the command
   * comes from a signed-in person typing it into their own settings, every row is
   * scoped by `req.user.id`, and nothing the model produces reaches here. A model
   * that could add an MCP server would have a shell with no prompt in front of it.
   */
  /**
   * Servers worth suggesting.
   *
   * The panel asks for a command, and somebody who has never seen an MCP server
   * has nothing to type. This is the list that turns that into a button — every
   * entry a real install command, several of them read off this machine's own
   * Claude Code plugin cache rather than remembered from documentation.
   */
  api.get(
    '/mcp/catalogue',
    wrap(async (req, res) => {
      const language = languageOf(req);
      const servers = searchCatalogue(req.query.q, Number(req.query.limit) || 12).map((server) => ({
        ...server,
        blurb: translateMessage(server.blurb, language),
      }));
      res.json({ servers });
    }),
  );

  api.get(
    '/mcp',
    wrap(async (req, res) => {
      const rows = await getStore().listMcpServers(req.user.id);
      // `config` may hold encrypted secrets; the browser gets the shape and never
      // the ciphertext, the same rule the provider keys follow.
      const servers = rows.map((row) => ({
        id: row.id,
        name: row.name,
        // What its tools are called, so the side panel can tell which server a
        // call in a conversation came from. The registry's rule, not a copy.
        prefix: `mcp__${slugify(row.name)}__`,
        enabled: row.enabled !== false,
        transport: row.config?.transport === 'http' ? 'http' : 'stdio',
        command: row.config?.command ?? null,
        args: row.config?.args ?? [],
        url: row.config?.url ?? null,
        hasHeaders: !!row.config?.headersCipher,
        hasEnv: !!row.config?.envCipher,
        createdAt: row.created_at,
      }));

      // What is actually reachable right now, and why not when it is not. Asked
      // for here rather than remembered, because "it worked when I added it" is
      // exactly the state that goes stale.
      const status = await mcpStatus(req.user.id).catch(() => ({ servers: [] }));
      const language = languageOf(req);
      res.json({
        servers,
        status: status.servers.map((s) => (s.error ? { ...s, error: translateMessage(s.error, language) } : s)),
      });
    }),
  );

  api.post(
    '/mcp',
    wrap(async (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Give the server a name.' });

      /**
       * Two servers must not slug to the same prefix.
       *
       * Tools are advertised as `mcp__<slug>__<tool>`, so "Figma" and "Figma!"
       * both become `figma` — and the registry used to connect both, store both
       * under one key, and push both sets of tools with identical names. A tool list
       * containing duplicate names is rejected outright by Anthropic and OpenAI,
       * so **every message in every conversation** then failed until one server
       * was removed. `callMcpTool` routes by the same slug, so whichever
       * connection survived also received calls meant for the other.
       *
       * Checked here because this is where a person can still be told why.
       * `mcpTools` also refuses the later of two colliding rows, for rows saved
       * before this check existed.
       */
      const slug = slugify(name);
      if (!slug) {
        return res.status(400).json({ error: 'That name has no letters or digits in it — give it a plain name.' });
      }
      const existing = await getStore().listMcpServers(req.user.id);
      const clash = existing.find((row) => slugify(row.name) === slug);
      if (clash) {
        return res.status(400).json({
          error: `"${name}" and the server you already have called "${clash.name}" would both be addressed as "${slug}", and their tools would collide. Pick a name that differs by more than punctuation.`,
        });
      }

      const transport = req.body?.transport === 'http' ? 'http' : 'stdio';

      /**
       * A stdio server is administrator-only, whatever ALLOW_MCP_STDIO says.
       *
       * `api.use(requireAuth)` is the only guard on this router, so this route
       * was reachable by *any* signed-in account — and a stdio server is not a
       * URL, it is "spawn this program on the server". The child inherits the
       * server's whole environment, ENCRYPTION_KEY included, which is the key
       * every account's stored provider keys are encrypted under. One ordinary
       * account could therefore read every other account's credentials.
       *
       * The env flag was carrying this alone, and it is the wrong shape for it:
       * it answers "is this machine allowed to spawn things", not "is this
       * person allowed to decide what". Both questions have to be yes.
       *
       * Nothing is lost on the deployment the flag was written for. .env.example
       * says to set it only on a single-owner machine you trust, and on such a
       * machine the owner is the administrator. http servers are unaffected:
       * they are screened for private addresses and spawn nothing.
       */
      if (transport === 'stdio' && req.user?.role !== 'admin') {
        return res.status(403).json({
          error:
            'A stdio server runs a program on this server with access to everyone’s stored keys, so only an administrator can add one. An http server works for any account.',
        });
      }

      const config = { transport };
      if (transport === 'stdio') {
        config.command = String(req.body?.command || '').trim();
        if (!config.command) return res.status(400).json({ error: 'Give the command that starts the server.' });
        config.args = Array.isArray(req.body?.args) ? req.body.args.map(String) : [];
        if (req.body?.env && typeof req.body.env === 'object') config.env = req.body.env;
      } else {
        config.url = String(req.body?.url || '').trim();
        try {
          const parsed = new URL(config.url);
          if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme');
        } catch {
          return res.status(400).json({ error: 'Give an http(s) URL for the server.' });
        }
        if (req.body?.headers && typeof req.body.headers === 'object') config.headers = req.body.headers;
      }

      /**
       * Try it before storing it.
       *
       * Saving a server that cannot start puts a permanent error into somebody's
       * settings for them to discover later, mid-task. Failing here means the
       * message arrives while they are still looking at the thing they typed.
       */
      let probe;
      try {
        probe = await probeMcpServer(config);
      } catch (err) {
        return res.status(400).json({ error: `That server did not start: ${err.message}` });
      }

      const saved = await getStore().saveMcpServer(req.user.id, {
        id: req.body?.id || crypto.randomUUID(),
        name,
        config: sealConfig(config),
        enabled: req.body?.enabled !== false,
      });
      // The cached connections are keyed by slug, and the set has changed.
      forgetMcp(req.user.id);

      return res.status(201).json({
        server: { id: saved.id, name: saved.name, enabled: saved.enabled },
        found: probe,
      });
    }),
  );

  api.patch(
    '/mcp/:id',
    wrap(async (req, res) => {
      const existing = await getStore().getMcpServer(req.user.id, req.params.id);
      if (!existing) return res.status(404).json({ error: 'No such MCP server.' });

      /**
       * Switching a stdio server back on is the same act as adding one — only a
       * server that is enabled is ever connected (see registry.js) — so it needs
       * the same check. Without it, a row created before that rule existed could
       * be disabled and re-enabled straight past it.
       */
      const enabling = req.body?.enabled !== false;
      if (enabling && existing.config?.transport !== 'http' && req.user?.role !== 'admin') {
        return res.status(403).json({
          error:
            'A stdio server runs a program on this server with access to everyone’s stored keys, so only an administrator can switch one on.',
        });
      }

      const updated = await getStore().setMcpServerEnabled(req.user.id, req.params.id, req.body?.enabled !== false);
      forgetMcp(req.user.id);
      return res.json({ server: { id: updated.id, name: updated.name, enabled: updated.enabled } });
    }),
  );

  api.delete(
    '/mcp/:id',
    wrap(async (req, res) => {
      await getStore().deleteMcpServer(req.user.id, req.params.id);
      forgetMcp(req.user.id);
      res.json({ ok: true });
    }),
  );

}
