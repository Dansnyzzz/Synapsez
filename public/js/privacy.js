/**
 * Memory, privacy and the account's own data — Settings → Memory & privacy,
 * and the "Your data", activity and delete sections of Settings → Account.
 *
 * Kept out of app.js because none of it is referenced from anywhere else: the
 * settings sheet calls `fillMemory`, `loadMemory`, `loadActivity` and
 * `loadAdminActivity`, and everything else here is wiring for those panels.
 */

import { api } from './api.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';
import { t } from './i18n.js';
import { normaliseImport, batchesOf } from './import-formats.js';

const $ = (id) => document.getElementById(id);
const checked = (id) => /** @type {HTMLInputElement} */ ($(id)).checked;

/** A date as this browser writes dates, with the time when it is today. */
function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString();
}

/**
 * @param {object} deps
 * @param {any} deps.state                    the app's shared state
 * @param {(button: HTMLElement, warning: string, run: () => Promise<void>) => void} deps.armed
 *   the two-press confirm every destructive button here uses
 * @param {() => void} [deps.onImported]  redraw the sidebar once conversations arrive
 */
export function createPrivacy({ state, armed, onImported }) {
  /* ── the switches ────────────────────────────────────────────────── */

  function fillMemory() {
    const prefs = state.boot?.prefs || {};
    /** @type {HTMLInputElement} */ ($('memory-on')).checked = prefs.memory !== false;
    /** @type {HTMLInputElement} */ ($('memory-sensitive')).checked = prefs.memorySensitive === true;
    /** @type {HTMLInputElement} */ ($('chat-search')).checked = prefs.chatSearch !== false;
    /** @type {HTMLSelectElement} */ ($('retention')).value = String(prefs.retentionDays || 0);
    /** @type {HTMLSelectElement} */ ($('provider-privacy')).value = prefs.providerPrivacy === 'strict' ? 'strict' : 'standard';
    /** @type {HTMLInputElement} */ ($('mask-personal')).checked = prefs.maskPersonal === true;
    // Two-factor accounts are asked for a code to leave; others are not.
    $('leave-code').hidden = !state.boot?.user?.twoFactor;
  }

  $('save-memory-prefs').addEventListener('click', async () => {
    const button = /** @type {HTMLButtonElement} */ ($('save-memory-prefs'));
    button.disabled = true;
    try {
      state.boot.prefs = await api.savePrefs({
        memory: checked('memory-on'),
        memorySensitive: checked('memory-sensitive'),
        chatSearch: checked('chat-search'),
        retentionDays: Number(/** @type {HTMLSelectElement} */ ($('retention')).value) || 0,
        providerPrivacy: /** @type {HTMLSelectElement} */ ($('provider-privacy')).value,
        maskPersonal: checked('mask-personal'),
      });
      $('memory-status').textContent = t('status.saved');
      setTimeout(() => ($('memory-status').textContent = ''), 2000);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  /* ── the notes ───────────────────────────────────────────────────── */

  /** A group's address in the API: `account`, or the project's id. */
  const scopeOf = (group) => (group.scope === 'account' ? 'account' : group.projectId);

  /**
   * Who wrote a note, so one the assistant saved while reading somebody else's
   * page can be told from one the person typed (HAR-002). Notes saved before
   * this was recorded say nothing rather than guessing.
   */
  const origin = (by) =>
    by === 'assistant' ? t('memory.byAssistant') : by === 'user' ? t('memory.byYou') : by === 'import' ? t('memory.byImport') : '';

  async function loadMemory() {
    const host = $('memory-list');
    host.setAttribute('aria-busy', 'true');
    try {
      const { groups } = await api.memory();
      if (!groups.length) {
        host.innerHTML = `<p class="hint">${escapeHtml(t('memory.empty'))}</p>`;
        return;
      }
      host.innerHTML = groups
        .map((group) => {
          const title =
            group.scope === 'account'
              ? t('memory.groupAccount')
              : group.projectName
                ? t('memory.groupProject', { name: group.projectName })
                : t('memory.groupGone');
          return `<div class="note-group">
            <h4 class="note-group__head">${escapeHtml(title)}</h4>
            ${group.notes
              .map(
                (note) => `<div class="note" data-scope="${escapeHtml(scopeOf(group))}" data-key="${escapeHtml(note.key)}">
                  <div class="note__head">
                    <span class="note__key">${escapeHtml(note.key)}</span>
                    <span class="note__date">${escapeHtml([origin(note.by), when(note.updatedAt)].filter(Boolean).join(' · '))}</span>
                  </div>
                  <div class="note__body">${escapeHtml(note.content)}</div>
                  <div class="note__actions">
                    <button class="btn btn--ghost" type="button" data-note-edit>${escapeHtml(t('memory.edit'))}</button>
                    ${note.canUndo ? `<button class="btn btn--ghost" type="button" data-note-undo title="${escapeHtml(t('memory.undoHint'))}">${escapeHtml(t('memory.undo'))}</button>` : ''}
                    <button class="btn btn--ghost" type="button" data-note-delete>${escapeHtml(t('action.delete'))}</button>
                  </div>
                </div>`,
              )
              .join('')}
          </div>`;
        })
        .join('');
      for (const card of host.querySelectorAll('.note')) wireNote(/** @type {HTMLElement} */ (card));
    } catch (err) {
      host.innerHTML = '';
      toast(err.message, 'error');
    } finally {
      host.setAttribute('aria-busy', 'false');
    }
  }

  function wireNote(card) {
    const scope = card.dataset.scope;
    const key = card.dataset.key;
    const remove = /** @type {HTMLButtonElement} */ (card.querySelector('[data-note-delete]'));
    armed(remove, t('memory.reallyDelete'), async () => {
      await api.deleteNote(scope, key);
      toast(t('memory.deleted', { key }));
      loadMemory();
    });

    // Take back the last change — the note goes back to what it said before it.
    card.querySelector('[data-note-undo]')?.addEventListener('click', async () => {
      try {
        await api.undoNote(scope, key);
        toast(t('memory.undone', { key }), 'ok');
        loadMemory();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    card.querySelector('[data-note-edit]').addEventListener('click', () => {
      const body = /** @type {HTMLElement} */ (card.querySelector('.note__body'));
      const field = document.createElement('textarea');
      field.className = 'note__edit';
      field.value = body.textContent || '';
      field.setAttribute('aria-label', t('memory.editLabel', { key }));
      body.replaceWith(field);
      field.focus();
      const actions = card.querySelector('.note__actions');
      actions.innerHTML =
        `<button class="btn btn--primary" type="button" data-note-save>${escapeHtml(t('action.save'))}</button>` +
        `<button class="btn btn--ghost" type="button" data-note-cancel>${escapeHtml(t('action.cancel'))}</button>`;
      actions.querySelector('[data-note-cancel]').addEventListener('click', () => loadMemory());
      actions.querySelector('[data-note-save]').addEventListener('click', async () => {
        try {
          await api.saveNote(scope, key, field.value);
          toast(t('memory.saved', { key }), 'ok');
          loadMemory();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  armed($('memory-clear'), t('memory.reallyClear'), async () => {
    const { removed } = await api.clearMemory();
    toast(removed ? t('memory.cleared') : t('memory.empty'));
    loadMemory();
  });

  $('memory-import').addEventListener('click', async () => {
    const field = /** @type {HTMLTextAreaElement} */ ($('memory-import-text'));
    if (!field.value.trim()) return toast(t('memory.importEmpty'), 'error');
    try {
      await api.importMemory(field.value);
      field.value = '';
      toast(t('memory.imported'), 'ok');
      loadMemory();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* ── import ──────────────────────────────────────────────────────── */

  /**
   * Read the file here, send it up in batches.
   *
   * The file can be hundreds of megabytes of somebody's history; a hosted
   * function takes a few megabytes per request. So the browser reads it,
   * recognises which export it is, and sends conversations fifty at a time,
   * saying how far it has got. The server reads each batch again with the same
   * function — the browser is not trusted to have done it.
   */
  $('data-import-file').addEventListener('change', async (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const status = $('data-import-status');
    let data;
    try {
      status.textContent = t('data.reading', { name: file.name });
      data = JSON.parse(await file.text());
    } catch {
      status.textContent = '';
      return toast(t('data.notJson'), 'error');
    }
    let parsed;
    try {
      parsed = normaliseImport(data);
    } catch (err) {
      status.textContent = '';
      return toast(err.message, 'error');
    }
    if (!parsed.conversations.length && !parsed.memory.length) {
      status.textContent = '';
      return toast(t('data.nothing'), 'error');
    }

    const batches = batchesOf(parsed.conversations);
    // A file of notes and no conversations is still one request.
    if (!batches.length) batches.push([]);
    let imported = 0;
    let notes = 0;
    try {
      for (const [i, batch] of batches.entries()) {
        status.textContent = t('data.progress', { done: imported, total: parsed.conversations.length });
        // Notes ride with the first batch only, so they are written once.
        const memory = i === 0 ? parsed.memory : [];
        if (!batch.length && !memory.length) continue;
        const result = await api.importConversations(batch, memory);
        imported += result.imported || 0;
        notes += result.notes || 0;
      }
      status.textContent = t('data.done', { n: imported, notes });
      toast(t('data.done', { n: imported, notes }), 'ok');
      // The sidebar lists what came in.
      onImported?.();
    } catch (err) {
      status.textContent = t('data.partial', { n: imported });
      toast(err.message, 'error');
    }
  });

  /* ── the security record ─────────────────────────────────────────── */

  function activityLine(event, withAccount = false) {
    const detail = event.detail || {};
    const what = t(`activity.${event.kind}`, {
      provider: detail.provider || '',
      n: String(detail.chats ?? detail.notes ?? ''),
    });
    const who = withAccount && event.email ? `${event.name || event.email} · ` : '';
    const where = [event.agent, event.network].filter(Boolean).join(' · ');
    return `<div class="rows__item">
      <span class="grow">${escapeHtml(who)}${escapeHtml(what)}
        ${where ? `<span class="activity__where">· ${escapeHtml(where)}</span>` : ''}
      </span>
      <span class="activity__when">${escapeHtml(when(event.created_at))}</span>
    </div>`;
  }

  async function loadActivity() {
    const host = $('activity-list');
    try {
      const { events } = await api.activity();
      host.innerHTML = events.length
        ? `<div class="rows">${events.map((e) => activityLine(e)).join('')}</div>`
        : `<p class="hint">${escapeHtml(t('activity.empty'))}</p>`;
    } catch (err) {
      host.innerHTML = '';
      toast(err.message, 'error');
    }
  }

  async function loadAdminActivity() {
    const host = $('admin-activity');
    try {
      const { events } = await api.adminActivity();
      host.innerHTML = events.length
        ? `<div class="rows">${events.map((e) => activityLine(e, true)).join('')}</div>`
        : `<p class="hint">${escapeHtml(t('activity.empty'))}</p>`;
    } catch (err) {
      host.innerHTML = '';
      toast(err.message, 'error');
    }
  }

  /* ── leaving ─────────────────────────────────────────────────────── */

  armed($('leave-account'), t('leave.really'), async () => {
    const password = /** @type {HTMLInputElement} */ ($('leave-password')).value;
    const code = /** @type {HTMLInputElement} */ ($('leave-code')).value.trim();
    if (!password) {
      toast(t('leave.needPassword'), 'error');
      return;
    }
    await api.deleteAccount(password, code);
    // Nothing is left to show; the gate is where a signed-out visitor belongs.
    location.reload();
  });

  return { fillMemory, loadMemory, loadActivity, loadAdminActivity };
}
