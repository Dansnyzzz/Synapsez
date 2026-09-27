import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * Below the plan in the side panel: what this conversation made, and what it
 * is working from.
 *
 * **Outputs** — every file the assistant produced here, newest first; a press
 * opens it in the viewer, the same as its card in the transcript.
 *
 * **Context** — what the assistant can read in this conversation, grouped:
 * the project's sources, connected services, skills, MCP servers. A group
 * with nothing in it is not drawn, and the section is not drawn at all when
 * every group is empty — a heading over nothing is furniture.
 *
 * Its own module because app.js is five thousand lines and this is a
 * self-contained view with one way in (`render`) and clicks as the way out.
 *
 * @param {{ api: any, openFile: (file: {id: string, name?: string}) => void, openSettings: (tab: string) => void }} wiring
 */
export function createRail({ api, openFile, openSettings }) {
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

  /**
   * Draw both sections for the conversation on screen.
   * @param {{ files?: any[], project?: {id: string} | null }} state
   */
  async function render(state) {
    const host = $('rail-extra');
    if (!host) return;
    const files = state.files || [];
    const [acct, projectFiles] = await Promise.all([loadAccount(), loadSources(state.project?.id)]);

    let html = '';
    if (files.length) {
      html += section(
        'outputs',
        t('rail.outputs'),
        files.length,
        files.map((f) => row(`data-open="${escapeHtml(f.id)}"`, isImage(f) ? icon.image : icon.doc, f.name)).join(''),
      );
    }

    const groups = [];
    if (projectFiles.length) {
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.sources'))}</div>${projectFiles
          .map((f) => row(f.attachment_id ? `data-open="${escapeHtml(f.attachment_id)}"` : 'disabled', isImage(f) ? icon.image : icon.doc, f.name))
          .join('')}</div>`,
      );
    }
    if (acct.connectors.length) {
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.connectors'))}</div><div class="railchips">${acct.connectors
          .map(
            (c) =>
              `<button class="railchip" type="button" data-settings="connectors" title="${escapeHtml(c.account || c.label)}">${icon.link}<span>${escapeHtml(c.label)}</span></button>`,
          )
          .join('')}</div></div>`,
      );
    }
    if (acct.skills.length) {
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.skills'))}</div>${acct.skills
          .map((s) => row('data-settings="skills"', icon.skill, s.name))
          .join('')}</div>`,
      );
    }
    if (acct.mcp.length) {
      groups.push(
        `<div class="railgrp"><div class="railgrp__name">${escapeHtml(t('rail.mcp'))}</div>${acct.mcp
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
