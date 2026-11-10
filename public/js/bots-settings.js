import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { faceHtml, paintFaces, creatureName, CREATURE_IDS } from './bot-avatar.js';
import { nameProblem } from './bot-mentions.js';
import { mountUsage } from './bots-usage.js';

/**
 * Bot settings (owner, 2026-11-09): Bots, Group chats and Usage, as DS Bot's
 * settings have them (NOTICE), and links — not copies — to what this app already has:
 * Connectors (Settings), Scheduled tasks (the Automations page) and Feedback.
 *
 * One dialog, made the first time it opens. A bot's form takes a name, a role, a
 * creature, a model and the instructions the person writes for it; a group's takes a
 * name, members and an admin. The server checks everything again; this only saves
 * the person a round trip for the plain mistakes.
 */

/** @type {HTMLDialogElement | null} */
let dialog = null;

const NAV = [
  { id: 'bots', label: 'bots.set.bots' },
  { id: 'groups', label: 'bots.set.groups' },
  { id: 'connectors', label: 'rail.connectors', link: true },
  { id: 'scheduled', label: 'bots.scheduled', link: true },
  { id: 'usage', label: 'bots.set.usage' },
  { id: 'feedback', label: 'bots.set.feedback', link: true },
];

/**
 * @param {{
 *   team: any, page: string, id: string | null,
 *   toast: (text: string, kind?: string) => void,
 *   onChanged: () => Promise<void>,
 *   openSettings: (tab?: string) => void, openFeedback: () => void, openAutomations: (tab: string) => void,
 * }} deps
 */
export function openBotSettings(deps) {
  let { team } = deps;
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'sheet botset';
    dialog.id = 'bot-settings';
    dialog.setAttribute('aria-labelledby', 'bot-settings-title');
    document.body.append(dialog);
  }
  const d = dialog;
  d.innerHTML = `<div class="botset__frame">
      <nav class="botset__nav" aria-label="${escapeHtml(t('bots.set.title'))}">
        <h2 class="botset__title" id="bot-settings-title">${escapeHtml(t('bots.set.title'))}</h2>
        ${NAV.map((n) => `<button type="button" class="botset__navitem" data-nav="${n.id}">${escapeHtml(t(n.label))}${n.link ? ' <span aria-hidden="true">↗</span>' : ''}</button>`).join('')}
      </nav>
      <section class="botset__main scroll-quiet" data-main aria-live="polite"></section>
      <button class="icon-btn botset__close" type="button" data-close aria-label="${escapeHtml(t('action.close'))}" title="${escapeHtml(t('action.close'))}">✕</button>
    </div>`;
  const main = /** @type {HTMLElement} */ (d.querySelector('[data-main]'));
  const botOf = (id) => team.bots.find((b) => b.id === id) || null;

  const refresh = async () => {
    await deps.onChanged();
    team = await api.bots();
  };

  function select(page, id = null) {
    for (const b of d.querySelectorAll('[data-nav]')) b.setAttribute('aria-current', String(/** @type {HTMLElement} */ (b).dataset.nav === page));
    if (page === 'bots') return drawBots(id);
    if (page === 'groups') return drawGroups(id);
    if (page === 'usage') {
      main.innerHTML = `<h3 class="botset__h">${escapeHtml(t('bots.set.usage'))}</h3><div data-usage></div>`;
      return mountUsage(/** @type {HTMLElement} */ (main.querySelector('[data-usage]')), { team });
    }
    return undefined;
  }

  /* ── bots ─────────────────────────────────────────────────────── */

  function drawBots(id) {
    const bot = id && id !== 'new' ? botOf(id) : null;
    const rows = team.bots
      .map((b) => `<li><button type="button" class="botset__row${b.id === bot?.id ? ' is-on' : ''}" data-bot="${escapeHtml(b.id)}">${faceHtml(b, 28)}<span><span class="botset__name">${escapeHtml(b.name)}</span>${b.main ? ` <span class="bottag">${escapeHtml(t('bots.mainTag'))}</span>` : ''}<span class="botset__sub">${escapeHtml(b.role || '')}</span></span></button></li>`)
      .join('');
    const editing = id === 'new' || bot;
    const avatar = bot?.avatar || CREATURE_IDS.find((c) => !team.bots.some((b) => b.avatar === c)) || CREATURE_IDS[0];
    main.innerHTML = `<header class="botset__head"><h3 class="botset__h">${escapeHtml(t('bots.set.bots'))}</h3><button class="btn btn--small" type="button" data-new-bot>${escapeHtml(t('bots.newBot'))}</button></header>
      <ul class="botset__list">${rows}</ul>
      ${
        editing
          ? `<form class="botform" data-bot-form novalidate>
        <h4 class="botset__h4">${escapeHtml(bot ? bot.name : t('bots.newBot'))}</h4>
        <label class="field"><span>${escapeHtml(t('bots.f.name'))}</span><input name="name" maxlength="40" required value="${escapeHtml(bot?.name || '')}" /></label>
        <label class="field"><span>${escapeHtml(t('bots.f.role'))}</span><input name="role" maxlength="40" value="${escapeHtml(bot?.role || '')}" /></label>
        <fieldset class="botform__creatures"><legend>${escapeHtml(t('bots.f.creature'))}</legend>
          ${CREATURE_IDS.map((c) => `<label class="botform__creature" title="${escapeHtml(creatureName(c))}"><input type="radio" name="avatar" value="${escapeHtml(c)}" ${c === avatar ? 'checked' : ''} />${faceHtml(c, 40)}<span class="sr-only">${escapeHtml(creatureName(c))}</span></label>`).join('')}
        </fieldset>
        <p class="hint botform__note">${escapeHtml(t('bots.f.modelNote'))}</p>
        <label class="field"><span>${escapeHtml(t('bots.f.instructions'))}</span><textarea name="instructions" rows="6" maxlength="4000">${escapeHtml(bot?.instructions || '')}</textarea><small class="hint">${escapeHtml(t('bots.f.instructionsHint'))}</small></label>
        <p class="botform__error" role="alert" data-error></p>
        <div class="botform__acts">
          <button class="btn btn--primary" type="submit">${escapeHtml(t('action.save'))}</button>
          ${bot && !bot.main ? `<button class="btn btn--danger" type="button" data-delete-bot="${escapeHtml(bot.id)}">${escapeHtml(t('bots.f.delete'))}</button>` : ''}
          ${bot?.main ? `<small class="hint">${escapeHtml(t('bots.f.chiefNoDelete'))}</small>` : ''}
        </div></form>`
          : `<p class="hint">${escapeHtml(t('bots.f.pick'))}</p>`
      }`;
    paintFaces(main);
    /** @type {HTMLInputElement | null} */ (main.querySelector('input[name="name"]'))?.focus();
    const form = /** @type {HTMLFormElement | null} */ (main.querySelector('[data-bot-form]'));
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const error = /** @type {HTMLElement} */ (form.querySelector('[data-error]'));
      const problem = nameProblem(data.get('name'));
      if (problem) {
        error.textContent = t(problem);
        return;
      }
      const body = { name: data.get('name'), role: data.get('role'), avatar: data.get('avatar'), instructions: data.get('instructions') };
      try {
        const saved = bot ? await api.updateBot(bot.id, body) : await api.createBot(body);
        await refresh();
        deps.toast(t('bots.saved'));
        drawBots(saved.bot.id);
      } catch (err) {
        error.textContent = err.message;
      }
    });
  }

  /* ── groups ───────────────────────────────────────────────────── */

  function drawGroups(id) {
    const group = id && id !== 'new' ? team.groups.find((g) => g.id === id) : null;
    const rows = team.groups
      .map((g) => `<li><button type="button" class="botset__row${g.id === group?.id ? ' is-on' : ''}" data-group="${escapeHtml(g.id)}"><span class="botfaces">${g.members.slice(0, 3).map((m) => faceHtml(botOf(m)?.avatar || '', 20)).join('')}</span><span><span class="botset__name">${escapeHtml(g.name)}</span><span class="botset__sub">${escapeHtml(g.members.map((m) => botOf(m)?.name).filter(Boolean).join(', '))}</span></span></button></li>`)
      .join('');
    const editing = id === 'new' || group;
    const members = new Set(group?.members || []);
    main.innerHTML = `<header class="botset__head"><h3 class="botset__h">${escapeHtml(t('bots.set.groups'))}</h3><button class="btn btn--small" type="button" data-new-group>${escapeHtml(t('bots.newGroup'))}</button></header>
      <ul class="botset__list">${rows || `<li class="hint">${escapeHtml(t('bots.g.none'))}</li>`}</ul>
      ${
        editing
          ? `<form class="botform" data-group-form novalidate>
        <h4 class="botset__h4">${escapeHtml(group ? group.name : t('bots.newGroup'))}</h4>
        <label class="field"><span>${escapeHtml(t('bots.g.name'))}</span><input name="name" maxlength="60" required value="${escapeHtml(group?.name || '')}" /></label>
        <fieldset class="botform__members"><legend>${escapeHtml(t('bots.members'))}</legend>
          ${team.bots.map((b) => `<label class="botform__member">${`<input type="checkbox" name="members" value="${escapeHtml(b.id)}" ${members.has(b.id) ? 'checked' : ''} />`}${faceHtml(b, 22)}<span>${escapeHtml(b.name)}</span></label>`).join('')}
        </fieldset>
        <label class="field"><span>${escapeHtml(t('bots.g.admin'))}</span><select name="admin">${team.bots.map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === (group?.admin || team.bots.find((x) => x.main)?.id) ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}</select><small class="hint">${escapeHtml(t('bots.g.adminHint'))}</small></label>
        <p class="botform__error" role="alert" data-error></p>
        <div class="botform__acts">
          <button class="btn btn--primary" type="submit">${escapeHtml(t('action.save'))}</button>
          ${group ? `<button class="btn btn--danger" type="button" data-delete-group="${escapeHtml(group.id)}">${escapeHtml(t('bots.g.delete'))}</button>` : ''}
        </div></form>`
          : `<p class="hint">${escapeHtml(t('bots.g.pick'))}</p>`
      }`;
    paintFaces(main);
    /** @type {HTMLInputElement | null} */ (main.querySelector('input[name="name"]'))?.focus();
    const form = /** @type {HTMLFormElement | null} */ (main.querySelector('[data-group-form]'));
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const error = /** @type {HTMLElement} */ (form.querySelector('[data-error]'));
      const picked = data.getAll('members').map(String);
      const admin = String(data.get('admin') || '');
      if (!String(data.get('name') || '').trim()) return void (error.textContent = t('bots.g.needName'));
      if (!picked.length) return void (error.textContent = t('bots.g.needMembers'));
      if (!picked.includes(admin)) return void (error.textContent = t('bots.g.adminMember'));
      const body = { name: data.get('name'), members: picked, admin };
      try {
        const saved = group ? await api.updateGroup(group.id, body) : await api.createGroup(body);
        await refresh();
        deps.toast(t('bots.saved'));
        drawGroups(saved.group.id);
      } catch (err) {
        error.textContent = err.message;
      }
    });
  }

  /* ── wiring ───────────────────────────────────────────────────── */

  /** Delete takes a second press within three seconds, on the button itself. */
  const armed = (button, run) => {
    if (button.dataset.armed === '1') return run();
    button.dataset.armed = '1';
    const was = button.textContent;
    button.textContent = t('bots.f.deleteConfirm');
    setTimeout(() => {
      if (button.isConnected) {
        button.dataset.armed = '';
        button.textContent = was;
      }
    }, 3000);
    return undefined;
  };

  d.onclick = async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === d || target.closest('[data-close]')) return d.close();
    const nav = /** @type {HTMLElement | null} */ (target.closest('[data-nav]'));
    if (nav) {
      const page = String(nav.dataset.nav);
      if (page === 'connectors') return (d.close(), deps.openSettings('connectors'));
      if (page === 'scheduled') return (d.close(), deps.openAutomations('scheduled'));
      if (page === 'feedback') return (d.close(), deps.openFeedback());
      return select(page);
    }
    const b = /** @type {HTMLElement | null} */ (target.closest('[data-bot]'));
    if (b) return drawBots(b.dataset.bot || null);
    const g = /** @type {HTMLElement | null} */ (target.closest('[data-group]'));
    if (g) return drawGroups(g.dataset.group || null);
    if (target.closest('[data-new-bot]')) return drawBots('new');
    if (target.closest('[data-new-group]')) return drawGroups('new');
    const delBot = /** @type {HTMLElement | null} */ (target.closest('[data-delete-bot]'));
    if (delBot)
      return armed(delBot, async () => {
        try {
          await api.deleteBot(delBot.dataset.deleteBot);
          await refresh();
          deps.toast(t('bots.deleted'));
          drawBots(null);
        } catch (err) {
          deps.toast(err.message, 'error');
        }
      });
    const delGroup = /** @type {HTMLElement | null} */ (target.closest('[data-delete-group]'));
    if (delGroup)
      return armed(delGroup, async () => {
        try {
          await api.deleteGroup(delGroup.dataset.deleteGroup);
          await refresh();
          deps.toast(t('bots.deleted'));
          drawGroups(null);
        } catch (err) {
          deps.toast(err.message, 'error');
        }
      });
    return undefined;
  };

  if (!d.open) d.showModal();
  select(deps.page || 'bots', deps.id ?? null);
}
