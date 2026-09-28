import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { webRowHtml } from './webrows.js';

/**
 * Below the plan in the side panel: what this conversation made, and what it
 * is working from.
 *
 * **Outputs** — every file the assistant produced here, newest first; a press
 * opens it in the viewer, the same as its card in the transcript.
 *
 * **Context** — what this conversation has actually used, grouped: the
 * project's sources once it has started, the services, tools, skills and MCP
 * servers its turns called. Not what the account merely has plugged in. A
 * group with nothing in it is not drawn, and the section is not drawn at all
 * when every group is empty — a heading over nothing is furniture.
 *
 * Its own module because app.js is five thousand lines and this is a
 * self-contained view with one way in (`render`) and clicks as the way out.
 *
 * @param {{ api: any, openFile: (file: {id: string, name?: string}) => void, openSettings: (tab: string) => void, openPane: (title: string, html: string) => void }} wiring
 */
export function createRail({ api, openFile, openSettings, openPane }) {
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /** Folded or open, per section, for the session. */
  const folded = { outputs: false, context: false };

  /** Account-wide lists change rarely; fetched once and refreshed on demand. */
  let account = null;
  /** A project's sources, by project id. */
  const sources = new Map();

  const icon = {
    image: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    skill: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Z"/><path d="M8 7h6M8 11h6"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    tool: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z"/></svg>',
    plug: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v4"/></svg>',
  };

  const isImage = (file) => /^image\//.test(file.mime || '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name || '');

  async function loadAccount(force = false) {
    if (account && !force) return account;
    const [connectors, skills, mcp] = await Promise.allSettled([api.connectors(), api.skills(), api.mcpServers()]);
    account = {
      connectors: connectors.status === 'fulfilled' ? (connectors.value.connectors || []).filter((c) => c.connected) : [],
      skills: skills.status === 'fulfilled' ? skills.value.skills || [] : [],
      mcp: mcp.status === 'fulfilled' ? (mcp.value.servers || []).filter((s) => s.enabled) : [],
    };
    return account;
  }

  async function loadSources(projectId) {
    if (!projectId) return [];
    if (sources.has(projectId)) return sources.get(projectId);
    const files = await api
      .project(projectId)
      .then((data) => data.files || [])
      .catch(() => []);
    sources.set(projectId, files);
    return files;
  }

  /** One collapsible section: a header with its count and a chevron. */
  function section(key, title, count, bodyHtml) {
    const open = !folded[key];
    return `
      <section class="railsec" data-rail="${key}">
        <button class="railsec__head" type="button" aria-expanded="${open}" data-fold="${key}">
          <span class="railsec__title">${escapeHtml(title)}</span>
          ${count ? `<span class="railsec__count">${count}</span>` : ''}
          <span class="railsec__chev" aria-hidden="true">⌄</span>
        </button>
        <div class="railsec__body"${open ? '' : ' hidden'}>${bodyHtml}</div>
      </section>`;
  }

  const row = (attrs, iconSvg, label, extra = '') =>
    `<button class="railrow" type="button" ${attrs} title="${escapeHtml(label)}">
       <span class="railrow__icon" aria-hidden="true">${iconSvg}</span>
       <span class="railrow__name">${escapeHtml(label)}</span>${extra}
     </button>`;

  let renders = 0;

  /**
   * Draw both sections for the conversation on screen.
   * @param {{ files?: any[], project?: {id: string} | null, transcript?: any[], liveTools?: any[] }} state
   */
  async function render(state) {
    const host = $('rail-extra');
    if (!host) return;
    const files = state.files || [];
    // Only the newest render may draw: a slow project read for the last
    // conversation used to land after the next one's and show its outputs.
    const mine = ++renders;
    const [acct, projectFiles] = await Promise.all([loadAccount(), loadSources(state.project?.id)]);
    if (mine !== renders) return;

    let html = '';
    if (files.length) {
      html += section(
        'outputs',
        t('rail.outputs'),
        files.length,
        files.map((f) => row(`data-open="${escapeHtml(f.id)}"`, isImage(f) ? icon.image : icon.doc, f.name)).join(''),
      );
    }

    /**
     * Context is what this conversation has actually used — not what the account
     * has plugged in. A blank chat listed every connector, skill and MCP server
     * before anything had run, which read as "the assistant is using these", and
     * after an edit the tools of the turns the edit removed stayed listed. It is
     * derived from the transcript and the calls arriving live, so it is true at
     * every moment and follows an edit.
     */
    const log = toolLog(state.transcript || [], state.liveTools || []);
    const called = new Set(log.map((c) => c.name));
    const started = log.length > 0 || (state.transcript || []).some((m) => m.role === 'user');
    const connectors = acct.connectors.filter((c) => (c.tools || []).some((name) => called.has(name)));
    const connectorTools = new Set(connectors.flatMap((c) => c.tools || []));
    const mcp = acct.mcp.filter((s) => s.prefix && [...called].some((name) => name.startsWith(s.prefix)));
    const read = new Set(log.filter((c) => c.name === 'skill_read').map((c) => String(c.input?.name || '').toLowerCase()));
    const skills = acct.skills.filter((s) => read.has(String(s.name || '').toLowerCase()));

    const groups = [];
    if (started && projectFiles.length) {
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.sources'))}</div>${projectFiles
          .map((f) => row(f.attachment_id ? `data-open="${escapeHtml(f.attachment_id)}"` : 'disabled', isImage(f) ? icon.image : icon.doc, f.name))
          .join('')}</div>`,
      );
    }
    /**
     * Connectors, and the tools this conversation actually used.
     *
     * Web search is as much a source as a linked Drive — it is where the
     * answer's facts came from — so it sits beside them, and a press opens
     * every search, grouped by the message that asked for it.
     */
    // A connector's own tools are shown as the connector, not twice; MCP tools
    // likewise as their server.
    const used = usedKinds(log.filter((c) => !connectorTools.has(c.name) && !c.name.startsWith('mcp__')));
    if (connectors.length || used.length) {
      const connected = connectors.map(
        (c) =>
          `<button class="railchip" type="button" data-settings="connectors" title="${escapeHtml(c.account || c.label)}">${icon.link}<span>${escapeHtml(c.label)}</span></button>`,
      );
      const tools = used.map(
        (u) =>
          `<button class="railchip" type="button" data-tool="${escapeHtml(u.kind)}" title="${escapeHtml(u.label)}">${u.kind === 'web_search' ? icon.globe : icon.tool}<span>${escapeHtml(u.label)}</span></button>`,
      );
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.connectors'))}</div><div class="railchips">${[...connected, ...tools].join('')}</div></div>`,
      );
    }
    if (skills.length) {
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.skills'))}</div>${skills
          .map((s) => row('data-settings="skills"', icon.skill, s.name))
          .join('')}</div>`,
      );
    }
    if (mcp.length) {
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.mcp'))}</div>${mcp
          .map((s) => row('data-settings="mcp"', icon.plug, s.name))
          .join('')}</div>`,
      );
    }
    if (groups.length) html += section('context', t('rail.context'), 0, groups.join(''));

    host.innerHTML = html;
    host.hidden = !html;

    for (const button of host.querySelectorAll('[data-fold]')) {
      button.addEventListener('click', () => {
        const key = /** @type {HTMLElement} */ (button).dataset.fold;
        folded[key] = !folded[key];
        button.setAttribute('aria-expanded', String(!folded[key]));
        const body = /** @type {HTMLElement} */ (button.nextElementSibling);
        body.hidden = folded[key];
      });
    }
    for (const button of host.querySelectorAll('[data-open]')) {
      button.addEventListener('click', () => {
        const id = /** @type {HTMLElement} */ (button).dataset.open;
        const file = files.find((f) => f.id === id) || projectFiles.find((f) => f.attachment_id === id);
        openFile({ id, name: file?.name });
      });
    }
    for (const button of host.querySelectorAll('[data-settings]')) {
      button.addEventListener('click', () => openSettings(/** @type {HTMLElement} */ (button).dataset.settings));
    }
    for (const button of host.querySelectorAll('[data-tool]')) {
      button.addEventListener('click', () => showTool(/** @type {HTMLElement} */ (button).dataset.tool, log));
    }
  }

  /**
   * Every call of one tool in this conversation, in the side panel — one group
   * per message that asked for it, each group folding on a press.
   */
  function showTool(kind, log) {
    const calls = log.filter((c) => kindOf(c.name) === kind);
    const turns = [];
    for (const call of calls) {
      const last = turns[turns.length - 1];
      if (last && last.turn === call.turn) last.calls.push(call);
      else turns.push({ turn: call.turn, asked: call.asked, calls: [call] });
    }
    const title = labelOf(kind);
    const count =
      kind === 'web_search'
        ? t(turns.length === 1 ? 'rail.searchesOne' : 'rail.searches', { n: String(turns.length) })
        : t(calls.length === 1 ? 'rail.usesOne' : 'rail.uses', { n: String(calls.length) });
    const groups = turns
      .slice()
      .reverse()
      .map((group, i) => {
        const results = group.calls.flatMap((c) => (kind === 'web_search' ? parseResults(c.content) : []));
        const body = group.calls
          .map((c) => {
            const hits = kind === 'web_search' ? parseResults(c.content) : [];
            const head = `<div class="toolq">${icon.globe}<span>${escapeHtml(labelInput(c))}</span>${
              hits.length ? `<span class="toolq__n">${escapeHtml(t('rail.results', { n: String(hits.length) }))}</span>` : ''
            }</div>`;
            // The same row as the web card in the reply: icon, title cut to fit, domain.
            const rows = hits.map((h) => webRowHtml({ url: h.url, title: h.title })).join('');
            return head + rows;
          })
          .join('');
        return `<details class="toolgrp"${i === 0 ? ' open' : ''}>
          <summary class="toolgrp__head">
            <span class="toolgrp__asked">${escapeHtml(group.asked || title)}</span>
            <span class="toolgrp__n">${escapeHtml(
              kind === 'web_search' ? t('rail.results', { n: String(results.length) }) : t('rail.uses', { n: String(group.calls.length) }),
            )}</span>
            <span class="toolgrp__chev" aria-hidden="true">⌄</span>
          </summary>
          <div class="toolgrp__body">${body}</div>
        </details>`;
      })
      .join('');
    openPane(title, `<div class="toolpane__count">${escapeHtml(count)}</div>${groups}`);
  }

  return {
    render,
    /** After settings change what is connected, the next draw asks again. */
    forgetAccount: () => {
      account = null;
    },
    forgetSources: (projectId) => sources.delete(projectId),
  };
}

/* ── what the tools did, read from the transcript ───────────────────── */

/** Tools that fetch the outside world, shown under their own names. */
const KINDS = {
  web_search: 'rail.tool.web_search',
  web_fetch: 'rail.tool.web_fetch',
  deep_research: 'rail.tool.deep_research',
};
const kindOf = (name) => (KINDS[name] ? name : String(name || ''));
const labelOf = (kind) => (KINDS[kind] ? t(KINDS[kind]) : t(`step.${kind}`) === `step.${kind}` ? kind : t(`step.${kind}`));

/** Tools not worth listing as a source: bookkeeping, not reading. */
const QUIET = new Set(['update_plan', 'load_tools', 'ask_options', 'memory_write', 'memory_append', 'skill_read']);

/**
 * Every tool call in the conversation, each with the message that led to it.
 *
 * Built from the stored transcript plus the calls of a run still in flight,
 * so a search appears here the moment it finishes, not after a reload.
 */
export function toolLog(messages, live = []) {
  const out = [];
  const results = new Map();
  for (const m of messages) if (m.role === 'tool') for (const r of m.results || []) results.set(r.toolCallId, r.content);
  let turn = 0;
  let asked = '';
  for (const m of messages) {
    if (m.role === 'user') {
      turn += 1;
      asked = String(m.text || '').slice(0, 140);
    }
    if (m.role !== 'assistant') continue;
    for (const c of m.toolCalls || []) {
      out.push({ id: c.id, name: c.name, input: c.input || {}, content: results.get(c.id) || '', turn, asked });
    }
  }
  const seen = new Set(out.map((c) => c.id));
  for (const c of live) if (!seen.has(c.id)) out.push({ ...c, turn: c.turn ?? turn + 1, asked: c.asked ?? asked });
  return out;
}

/** The distinct tools used, most used first, without the bookkeeping ones. */
export function usedKinds(log) {
  const counts = new Map();
  for (const c of log) {
    if (QUIET.has(c.name)) continue;
    const kind = kindOf(c.name);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n, label: labelOf(kind) }));
}

/** What a call was asked for, in a line. */
const labelInput = (c) =>
  String(c.input?.query || c.input?.url || c.input?.question || c.input?.path || c.input?.name || c.name).slice(0, 160);

/**
 * The results a web search returned, from the text the model was given:
 * numbered lines, a title then its address. See formatResults on the server.
 */
export function parseResults(content) {
  const hits = [];
  const text = String(content || '');
  const line = /^\s*\d+\.\s+(.+)\n\s+(https?:\/\/\S+)/gm;
  let m;
  while ((m = line.exec(text)) && hits.length < 25) {
    let host = '';
    try {
      host = new URL(m[2]).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    hits.push({ title: m[1].trim(), url: m[2], host });
  }
  return hits;
}
