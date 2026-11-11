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
 * creature and the instructions the person writes for it; a group's takes a
 * name, members and an admin. The server checks everything again; this only saves
 * the person a round trip for the plain mistakes.
 *
 * What is saved shows the moment the server says so (owner, 2026-11-10): one request,
 * its answer put in place here and on the Bot page behind, a line saying what happened —
 * rather than waiting while the page read the whole team and its conversation again.
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
 * A change to the team, made and answered: `item` saved (a bot or a group, as the server
 * returned it), or `removed` (its id).
 *
 * @typedef {{ kind: 'bot' | 'group', item?: any, removed?: string }} TeamChange
 */

/**
 * The team with one change in it, as the server now has it. A new one is the newest in the
 * list; an edited one keeps its place and its last message; a deleted bot leaves its groups.
 *
 * @template {{ bots: any[], groups: any[] }} T
 * @param {T} team @param {TeamChange} change
 * @returns {T}
 */
export function mergeTeam(team, change) {
  const key = change.kind === 'group' ? 'groups' : 'bots';
  const list = team[key] || [];
  if (change.removed) {
    const next = { ...team, [key]: list.filter((x) => x.id !== change.removed) };
    if (change.kind === 'bot') next.groups = (team.groups || []).map((g) => (g.members?.includes(change.removed) ? { ...g, members: g.members.filter((m) => m !== change.removed) } : g));
    return next;
  }
  const old = list.find((x) => x.id === change.item.id);
  const item = { ...old, ...change.item, at: old?.at || new Date().toISOString() };
  return { ...team, [key]: old ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item] };
}

/** What a change says, in a line: made, saved or deleted, by name. @param {TeamChange} change @param {boolean} made @param {string} name */
export const changeLine = (change, made, name) =>
  t(`bots.toast.${change.kind}${change.removed ? 'Deleted' : made ? 'Created' : 'Saved'}`, { name });

/**
 * @param {{
 *   team: any, page: string, id: string | null,
 *   toast: (text: string, kind?: string) => void,
 *   onChanged: (change: TeamChange) => Promise<any>,
 *   openSettings: (tab?: string) => void, openFeedback: () => void, openAutomations: (tab: string) => void,
 * }} deps  `onChanged` puts the change on the Bot page at once and answers with the team read again, or null
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
  /** The page and the one picked on it, so a fresh read redraws the right list. */
  let current = { page: 'bots', id: /** @type {string | null} */ (null) };

  /**
   * A change the server answered: in place here and on the Bot page at once, said in a
   * line. The page reads the team again behind it (ids, colours, the last message), and
   * the list here takes that read — the form being typed in is left as it is.
   *
   * @param {TeamChange} change @param {boolean} made
   */
  function changed(change, made) {
    const name = change.item?.name || (change.kind === 'group' ? team.groups : team.bots).find((x) => x.id === change.removed)?.name || '';
    team = mergeTeam(team, change);
    deps.toast(changeLine(change, made, name), 'ok');
    deps
      .onChanged(change)
      .then((fresh) => {
        if (!fresh || !d.open) return;
        team = fresh;
        drawRows();
      })
      .catch(() => {});
  }

  /** A button that waits for the server: pressed once, it stays down until the answer. @param {HTMLButtonElement | null} button @param {boolean} on */
  function busy(button, on) {
    if (!button) return;
    button.disabled = on;
    button.setAttribute('aria-busy', String(on));
    button.classList.toggle('is-busy', on);
  }

  function select(page, id = null) {
    for (const b of d.querySelectorAll('[data-nav]')) b.setAttribute('aria-current', String(/** @type {HTMLElement} */ (b).dataset.nav === page));
    if (page === 'bots') return drawBots(id);
    if (page === 'groups') return drawGroups(id);
    if (page === 'usage') {
      current = { page, id: null };
      main.innerHTML = `<h3 class="botset__h">${escapeHtml(t('bots.set.usage'))}</h3><div data-usage></div>`;
      return mountUsage(/** @type {HTMLElement} */ (main.querySelector('[data-usage]')), { team });
    }
    return undefined;
  }

  /* ── bots ─────────────────────────────────────────────────────── */

  const botRows = (selected) =>
    team.bots
      .map((b) => `<li><button type="button" class="botset__row${b.id === selected ? ' is-on' : ''}" data-bot="${escapeHtml(b.id)}">${faceHtml(b, 28)}<span><span class="botset__name">${escapeHtml(b.name)}</span>${b.main ? ` <span class="bottag">${escapeHtml(t('bots.mainTag'))}</span>` : ''}<span class="botset__sub">${escapeHtml(b.role || '')}</span></span></button></li>`)
      .join('');

  const groupRows = (selected) =>
    team.groups
      .map((g) => `<li><button type="button" class="botset__row${g.id === selected ? ' is-on' : ''}" data-group="${escapeHtml(g.id)}"><span class="botfaces">${g.members.slice(0, 3).map((m) => faceHtml(botOf(m) || '', 20)).join('')}</span><span><span class="botset__name">${escapeHtml(g.name)}</span><span class="botset__sub">${escapeHtml(g.members.map((m) => botOf(m)?.name).filter(Boolean).join(', '))}</span></span></button></li>`)
      .join('') || `<li class="hint">${escapeHtml(t('bots.g.none'))}</li>`;

  /** The list alone, drawn again from the team as last read: what is being typed stays. */
  function drawRows() {
    const rows = main.querySelector('.botset__list');
    if (!rows || (current.page !== 'bots' && current.page !== 'groups')) return;
    rows.innerHTML = current.page === 'bots' ? botRows(current.id) : groupRows(current.id);
    paintFaces(rows);
  }

  function drawBots(id) {
    const bot = id && id !== 'new' ? botOf(id) : null;
    current = { page: 'bots', id: bot?.id || null };
    const editing = id === 'new' || bot;
    const avatar = bot?.avatar || CREATURE_IDS.find((c) => !team.bots.some((b) => b.avatar === c)) || CREATURE_IDS[0];
    main.innerHTML = `<header class="botset__head"><h3 class="botset__h">${escapeHtml(t('bots.set.bots'))}</h3><button class="btn btn--small" type="button" data-new-bot>${escapeHtml(t('bots.newBot'))}</button></header>
      <ul class="botset__list">${botRows(bot?.id)}</ul>
      ${
        editing
          ? `<form class="botform" data-bot-form novalidate>
        <h4 class="botset__h4">${escapeHtml(bot ? bot.name : t('bots.newBot'))}</h4>
        <label class="field"><span>${escapeHtml(t('bots.f.name'))}</span><input name="name" maxlength="40" required value="${escapeHtml(bot?.name || '')}" /></label>
        <label class="field"><span>${escapeHtml(t('bots.f.role'))}</span><input name="role" maxlength="40" value="${escapeHtml(bot?.role || '')}" /></label>
        <fieldset class="botform__creatures"><legend>${escapeHtml(t('bots.f.creature'))}</legend>
          ${CREATURE_IDS.map((c) => `<label class="botform__creature" title="${escapeHtml(creatureName(c))}"><input type="radio" name="avatar" value="${escapeHtml(c)}" ${c === avatar ? 'checked' : ''} ${bot?.main && c !== avatar ? 'disabled' : ''} />${faceHtml(c, 40)}<span class="sr-only">${escapeHtml(creatureName(c))}</span></label>`).join('')}
        </fieldset>
        <p class="hint botform__note">${escapeHtml(t('bots.f.modelNote'))}</p>
        <label class="field"><span>${escapeHtml(t('bots.f.instructions'))}</span><textarea name="instructions" rows="6" maxlength="4000">${escapeHtml(bot?.instructions || '')}</textarea><small class="hint">${escapeHtml(t('bots.f.instructionsHint'))}</small></label>
        <label class="field"><span>${escapeHtml(t('bots.f.review'))}</span><select name="reviewEvery">${[20, 40, 0].map((n) => `<option value="${n}" ${(bot?.reviewEvery ?? 20) === n ? 'selected' : ''}>${escapeHtml(n ? t('bots.f.reviewEvery', { n }) : t('bots.f.reviewOff'))}</option>`).join('')}</select><small class="hint">${escapeHtml(t('bots.f.reviewHint'))}</small></label>
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
      const save = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
      // A second press while the first is on its way would make the bot twice.
      if (save.disabled) return;
      const data = new FormData(form);
      const error = /** @type {HTMLElement} */ (form.querySelector('[data-error]'));
      const problem = nameProblem(data.get('name'));
      if (problem) {
        error.textContent = t(problem);
        return;
      }
      error.textContent = '';
      const body = { name: data.get('name'), role: data.get('role'), avatar: data.get('avatar'), instructions: data.get('instructions'), reviewEvery: Number(data.get('reviewEvery') ?? 20) };
      busy(save, true);
      try {
        const saved = bot ? await api.updateBot(bot.id, body) : await api.createBot(body);
        changed({ kind: 'bot', item: saved.bot }, !bot);
        drawBots(saved.bot.id);
      } catch (err) {
        error.textContent = err.message;
        busy(save, false);
      }
    });
  }

  /* ── groups ───────────────────────────────────────────────────── */

  function drawGroups(id) {
    const group = id && id !== 'new' ? team.groups.find((g) => g.id === id) : null;
    current = { page: 'groups', id: group?.id || null };
    const editing = id === 'new' || group;
    const members = new Set(group?.members || []);
    main.innerHTML = `<header class="botset__head"><h3 class="botset__h">${escapeHtml(t('bots.set.groups'))}</h3><button class="btn btn--small" type="button" data-new-group>${escapeHtml(t('bots.newGroup'))}</button></header>
      <ul class="botset__list">${groupRows(group?.id)}</ul>
      ${
        editing
          ? `<form class="botform" data-group-form novalidate>
        <h4 class="botset__h4">${escapeHtml(group ? group.name : t('bots.newGroup'))}</h4>
        <label class="field"><span>${escapeHtml(t('bots.g.name'))}</span><input name="name" maxlength="60" required value="${escapeHtml(group?.name || '')}" /></label>
        <fieldset class="botform__members"><legend>${escapeHtml(t('bots.members'))}</legend>
          ${team.bots.map((b) => `<label class="botform__member">${`<input type="checkbox" name="members" value="${escapeHtml(b.id)}" ${members.has(b.id) ? 'checked' : ''} />`}${faceHtml(b, 22)}<span>${escapeHtml(b.name)}</span></label>`).join('')}
        </fieldset>
        <label class="field"><span>${escapeHtml(t('bots.g.notice'))}</span><textarea name="notice" rows="3" maxlength="2000" placeholder="${escapeHtml(t('bots.g.noticePlaceholder'))}">${escapeHtml(group?.notice || '')}</textarea><small class="hint">${escapeHtml(t('bots.g.noticeHint'))}</small></label>
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
      const save = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
      if (save.disabled) return;
      const data = new FormData(form);
      const error = /** @type {HTMLElement} */ (form.querySelector('[data-error]'));
      const picked = data.getAll('members').map(String);
      const admin = String(data.get('admin') || '');
      if (!String(data.get('name') || '').trim()) return void (error.textContent = t('bots.g.needName'));
      if (!picked.length) return void (error.textContent = t('bots.g.needMembers'));
      if (!picked.includes(admin)) return void (error.textContent = t('bots.g.adminMember'));
      error.textContent = '';
      const body = { name: data.get('name'), members: picked, admin, notice: String(data.get('notice') || '').trim() };
      busy(save, true);
      try {
        const saved = group ? await api.updateGroup(group.id, body) : await api.createGroup(body);
        changed({ kind: 'group', item: saved.group }, !group);
        drawGroups(saved.group.id);
      } catch (err) {
        error.textContent = err.message;
        busy(save, false);
      }
    });
  }

  /* ── wiring ───────────────────────────────────────────────────── */

  /** Delete takes a second press within three seconds, on the button itself. */
  const armed = (button, run) => {
    if (button.disabled) return undefined;
    if (button.dataset.armed === '1') return run();
    button.dataset.armed = '1';
    const was = button.textContent;
    button.textContent = t('bots.f.deleteConfirm');
    setTimeout(() => {
      if (button.isConnected && !button.disabled) {
        button.dataset.armed = '';
        button.textContent = was;
      }
    }, 3000);
    return undefined;
  };

  /** @param {HTMLButtonElement} button @param {'bot' | 'group'} kind @param {string} id */
  async function remove(button, kind, id) {
    busy(button, true);
    try {
      await (kind === 'bot' ? api.deleteBot(id) : api.deleteGroup(id));
      changed({ kind, removed: id }, false);
      if (kind === 'bot') drawBots(null);
      else drawGroups(null);
    } catch (err) {
      busy(button, false);
      deps.toast(err.message, 'error');
    }
  }

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
    const delBot = /** @type {HTMLButtonElement | null} */ (target.closest('[data-delete-bot]'));
    if (delBot) return armed(delBot, () => remove(delBot, 'bot', String(delBot.dataset.deleteBot)));
    const delGroup = /** @type {HTMLButtonElement | null} */ (target.closest('[data-delete-group]'));
    if (delGroup) return armed(delGroup, () => remove(delGroup, 'group', String(delGroup.dataset.deleteGroup)));
    return undefined;
  };

  if (!d.open) d.showModal();
  select(deps.page || 'bots', deps.id ?? null);
}
