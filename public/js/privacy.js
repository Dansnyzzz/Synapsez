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
import { t, localeTag } from './i18n.js';
import { normaliseImport, batchesOf } from './import-formats.js';

const $ = (id) => document.getElementById(id);
const checked = (id) => /** @type {HTMLInputElement} */ ($(id)).checked;

const glyph = (paths) =>
  `<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const PENCIL = glyph('<path d="M13.5 2.9a1.9 1.9 0 0 1 2.7 2.7L7.8 14 4 15l1-3.8Z"/>');
const UNDO = glyph('<path d="M7 7H13a4 4 0 0 1 0 8H8"/><path d="M9.5 4.5 7 7l2.5 2.5"/>');
const BIN = glyph('<path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6"/>');

/** A date as this browser writes dates, with the time when it is today. */
function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString(localeTag());
}

/**
 * @param {object} deps
 * @param {any} deps.state                    the app's shared state
 * @param {(button: HTMLElement, warning: string, run: () => Promise<void>) => void} deps.armed
 *   the two-press confirm every destructive button here uses
 * @param {() => void} [deps.onImported]  redraw the sidebar once conversations arrive
 * @param {(patch: Record<string, any>) => Promise<any>} [deps.savePrefs]
 *   save in the order pressed (app.js savePrefsInOrder), so the last switch wins (UI-005)
 */
export function createPrivacy({ state, armed, onImported, savePrefs = api.savePrefs }) {
  /* ── the switches ────────────────────────────────────────────────── */

  function fillMemory() {
    const prefs = state.boot?.prefs || {};
    /** @type {HTMLInputElement} */ ($('memory-on')).checked = prefs.memory !== false;
    /** @type {HTMLInputElement} */ ($('memory-sensitive')).checked = prefs.memorySensitive === true;
    /** @type {HTMLInputElement} */ ($('memory-tidy')).checked = prefs.memoryTidy === true;
    /** @type {HTMLInputElement} */ ($('chat-search')).checked = prefs.chatSearch !== false;
    /** @type {HTMLSelectElement} */ ($('retention')).value = String(prefs.retentionDays || 0);
    /** @type {HTMLSelectElement} */ ($('provider-privacy')).value = prefs.providerPrivacy === 'strict' ? 'strict' : 'standard';
    /** @type {HTMLInputElement} */ ($('mask-personal')).checked = prefs.maskPersonal === true;
    /** @type {HTMLInputElement} */ ($('action-monitor')).checked = prefs.actionMonitor === true;
    // Two-factor accounts are asked for a code to leave; others are not.
    $('leave-code').hidden = !state.boot?.user?.twoFactor;
  }

  /**
   * Each switch and choice saves the moment it changes, as Claude's do. The
   * three in Memory say so there; the three in Privacy, there. A change the
   * server refuses is put back.
   *
   * @type {Record<string, { status: string, patch: () => Record<string, any> }>}
   */
  const SAVED_ON_CHANGE = {
    'memory-on': { status: 'memory-saved', patch: () => ({ memory: checked('memory-on') }) },
    'memory-sensitive': { status: 'memory-saved', patch: () => ({ memorySensitive: checked('memory-sensitive') }) },
    'memory-tidy': { status: 'memory-saved', patch: () => ({ memoryTidy: checked('memory-tidy') }) },
    'chat-search': { status: 'memory-saved', patch: () => ({ chatSearch: checked('chat-search') }) },
    retention: { status: 'memory-status', patch: () => ({ retentionDays: Number(/** @type {HTMLSelectElement} */ ($('retention')).value) || 0 }) },
    'provider-privacy': { status: 'memory-status', patch: () => ({ providerPrivacy: /** @type {HTMLSelectElement} */ ($('provider-privacy')).value }) },
    'mask-personal': { status: 'memory-status', patch: () => ({ maskPersonal: checked('mask-personal') }) },
    'action-monitor': { status: 'memory-status', patch: () => ({ actionMonitor: checked('action-monitor') }) },
  };
  for (const [id, { status, patch }] of Object.entries(SAVED_ON_CHANGE)) {
    $(id).addEventListener('change', async () => {
      try {
        // In order: two switches flipped within one round trip were sent side by
        // side, and whichever answer came back last was taken as the settings.
        state.boot.prefs = await savePrefs(patch());
        $(status).textContent = t('status.saved');
        setTimeout(() => ($(status).textContent = ''), 2000);
      } catch (err) {
        fillMemory();
        toast(err.message, 'error');
      }
    });
  }

  // "Start import", as Claude's: the box to paste into, folded away until asked for.
  $('memory-import-open').addEventListener('click', () => {
    const box = $('memory-import-box');
    box.hidden = !box.hidden;
    $('memory-import-open').setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) $('memory-import-text').focus();
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

  /** A day as this browser writes days. */
  const dayOf = (iso) => {
    const date = iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(localeTag()) : '';
  };

  /**
   * Where a note was saved and what the conversation had read from outside first
   * (owner, 2026-11-12) — a host or a kind of tool, never what it said — so a note
   * saved while reading a stranger's page can be told at a glance.
   */
  const savedLine = (saved) => {
    if (!saved?.chatId) return '';
    const where = saved.chatTitle ? t('memory.savedIn', { chat: saved.chatTitle }) : t('memory.savedInGone');
    return saved.outside ? `${where} ${t('memory.afterReading', { source: saved.outside })}` : where;
  };

  /** Its kind, when it is not a plain fact, and an event's date. */
  const kindBadge = (note) => {
    const parts = [];
    if (note.kind && note.kind !== 'fact') parts.push(`<span class="note__kind note__kind--${escapeHtml(note.kind)}">${escapeHtml(t(`memory.kind.${note.kind}`))}</span>`);
    if (note.expires) parts.push(`<span class="note__kind${note.expired ? ' is-past' : ''}">${escapeHtml(t(note.expired ? 'memory.ended' : 'memory.until', { date: dayOf(note.expires) }))}</span>`);
    return parts.join('');
  };

  /** The versions an assistant's changes kept, each with when it held, and a way to bring one back. */
  const historyHtml = (note) => {
    if (!note.history?.length) return '';
    const rows = note.history
      .map((v, i) => {
        const span = [dayOf(v.validFrom), dayOf(v.invalidAt)].filter(Boolean).join(' – ');
        const meta = [origin(v.by), span, savedLine(v.saved)].filter(Boolean).join(' · ');
        return `<li class="note__version"><div class="note__version-text">${escapeHtml(v.content)}</div>
          <div class="note__version-meta">${escapeHtml(meta)}</div>
          <button class="btn btn--small" type="button" data-note-restore="${i}" aria-label="${escapeHtml(t('memory.restoreLabel', { key: note.key }))}">${escapeHtml(t('memory.restore'))}</button></li>`;
      })
      .join('');
    return `<details class="note__history"${note.removed ? ' open' : ''}>
      <summary>${escapeHtml(t('memory.history', { count: note.history.length }))}</summary>
      <ol class="note__versions">${rows}</ol>
      ${note.removed ? '' : `<button class="btn btn--small btn--ghost" type="button" data-note-purge>${escapeHtml(t('memory.purgeHistory'))}</button>`}
    </details>`;
  };

  /**
   * The monthly tidy's suggestions (owner, 2026-11-12): each says what it would do and
   * why, and waits for Accept or Reject. Nothing is changed until the person accepts.
   */
  function paintTidy(tidy) {
    const box = $('memory-tidy-list');
    const list = tidy?.proposals || [];
    if (!list.length) {
      box.innerHTML = '';
      return;
    }
    const names = (keys) => keys.map((k) => `“${k}”`).join(', ');
    const what = (p) =>
      p.type === 'merge'
        ? t('memory.tidyMerge', { notes: names(p.keys), into: p.into })
        : p.type === 'contradiction'
          ? t('memory.tidyContradiction', { notes: names(p.keys), keep: p.keep })
          : t('memory.tidyRemove', { notes: names(p.keys) });
    box.innerHTML = `<h3 class="settings__title">${escapeHtml(t('memory.tidyTitle'))}</h3>
      <ul class="tidy">${list
        .map(
          (p) => `<li class="tidy__item" data-tidy="${escapeHtml(p.id)}">
            <p class="tidy__what">${escapeHtml(what(p))}${p.scope === 'project' && p.projectName ? ` <span class="tidy__where">${escapeHtml(t('memory.groupProject', { name: p.projectName }))}</span>` : ''}</p>
            ${p.why ? `<p class="tidy__why">${escapeHtml(p.why)}</p>` : ''}
            ${p.text ? `<blockquote class="tidy__text">${escapeHtml(p.text)}</blockquote>` : ''}
            <div class="tidy__acts">
              <button class="btn btn--small btn--primary" type="button" data-tidy-accept>${escapeHtml(t('memory.tidyAccept'))}</button>
              <button class="btn btn--small btn--ghost" type="button" data-tidy-reject>${escapeHtml(t('memory.tidyReject'))}</button>
            </div>
          </li>`,
        )
        .join('')}</ul>`;
    for (const item of box.querySelectorAll('[data-tidy]')) {
      const id = /** @type {HTMLElement} */ (item).dataset.tidy;
      for (const [selector, answer] of [['[data-tidy-accept]', 'accept'], ['[data-tidy-reject]', 'reject']]) {
        item.querySelector(selector).addEventListener('click', async () => {
          try {
            await api.answerTidy(id, answer);
            toast(t(answer === 'accept' ? 'memory.tidyAccepted' : 'memory.tidyRejected'), 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
          loadMemory();
        });
      }
    }
  }

  async function loadMemory() {
    const host = $('memory-list');
    host.setAttribute('aria-busy', 'true');
    try {
      const { groups, tidy } = await api.memory();
      paintTidy(tidy);
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
          // Claude's rows: the note's name, what it says, when, and — on the row
          // under the pointer or the keyboard — edit and delete.
          return `<div class="note-group">
            <h4 class="note-group__head">${escapeHtml(title)}</h4>
            ${group.notes
              .map((note) => {
                // Removed by the assistant: read into nothing, kept for the person to bring back or delete.
                const body = note.removed ? t('memory.removed') : note.content;
                const saved = savedLine(note.saved);
                return `<div class="note${note.removed ? ' is-removed' : ''}${note.expired ? ' is-past' : ''}" data-scope="${escapeHtml(scopeOf(group))}" data-key="${escapeHtml(note.key)}" data-kind="${escapeHtml(note.kind || 'fact')}" data-expires="${escapeHtml(note.expires || '')}">
                  <span class="note__key">${escapeHtml(note.key)}${kindBadge(note)}</span>
                  <div class="note__body" title="${escapeHtml(body)}">${escapeHtml(body)}</div>
                  <span class="note__date">${escapeHtml([origin(note.by), when(note.updatedAt)].filter(Boolean).join(' · '))}</span>
                  <div class="note__actions">
                    ${note.removed ? '' : `<button class="icon-btn" type="button" data-note-edit aria-label="${escapeHtml(t('memory.editLabel', { key: note.key }))}" title="${escapeHtml(t('memory.edit'))}">${PENCIL}</button>`}
                    ${note.canUndo ? `<button class="icon-btn" type="button" data-note-undo aria-label="${escapeHtml(t(note.removed ? 'memory.bringBack' : 'memory.undo'))}" title="${escapeHtml(t(note.removed ? 'memory.bringBack' : 'memory.undoHint'))}">${UNDO}</button>` : ''}
                    <button class="icon-btn" type="button" data-note-delete aria-label="${escapeHtml(t('action.delete'))}" title="${escapeHtml(t('action.delete'))}">${BIN}</button>
                  </div>
                  ${saved ? `<p class="note__saved">${escapeHtml(saved)}</p>` : ''}
                  ${historyHtml(note)}
                </div>`;
              })
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

    // An earlier version back; the ones after it go (owner, 2026-11-12).
    for (const button of card.querySelectorAll('[data-note-restore]')) {
      button.addEventListener('click', async () => {
        try {
          await api.restoreNote(scope, key, Number(/** @type {HTMLElement} */ (button).dataset.noteRestore));
          toast(t('memory.restored', { key }), 'ok');
          loadMemory();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
    // The earlier versions deleted, the note kept — asked twice, as every delete here is.
    const purge = /** @type {HTMLButtonElement | null} */ (card.querySelector('[data-note-purge]'));
    if (purge) {
      armed(purge, t('memory.reallyPurge'), async () => {
        await api.purgeNoteHistory(scope, key);
        toast(t('memory.historyPurged', { key }));
        loadMemory();
      });
    }

    card.querySelector('[data-note-edit]')?.addEventListener('click', () => {
      const body = /** @type {HTMLElement} */ (card.querySelector('.note__body'));
      const field = document.createElement('textarea');
      field.className = 'note__edit';
      field.value = body.textContent || '';
      field.setAttribute('aria-label', t('memory.editLabel', { key }));
      body.replaceWith(field);
      // Its kind, and an event's last day, beside the words (owner, 2026-11-12).
      const extra = document.createElement('div');
      extra.className = 'note__edit-kind';
      const kindId = `note-kind-${Math.random().toString(36).slice(2, 8)}`;
      const dateId = `${kindId}-until`;
      extra.innerHTML =
        `<label for="${kindId}">${escapeHtml(t('memory.kindLabel'))}</label>` +
        `<select id="${kindId}" data-note-kind>${['fact', 'preference', 'rule', 'event']
          .map((k) => `<option value="${k}"${card.dataset.kind === k ? ' selected' : ''}>${escapeHtml(t(`memory.kind.${k}`))}</option>`)
          .join('')}</select>` +
        `<label for="${dateId}" data-note-until-label>${escapeHtml(t('memory.expiresLabel'))}</label>` +
        `<input type="date" id="${dateId}" data-note-until value="${escapeHtml(card.dataset.expires || '')}" />`;
      field.after(extra);
      const kindBox = /** @type {HTMLSelectElement} */ (extra.querySelector('[data-note-kind]'));
      const untilBox = /** @type {HTMLInputElement} */ (extra.querySelector('[data-note-until]'));
      const showUntil = () => {
        const event = kindBox.value === 'event';
        untilBox.hidden = !event;
        /** @type {HTMLElement} */ (extra.querySelector('[data-note-until-label]')).hidden = !event;
      };
      kindBox.addEventListener('change', showUntil);
      showUntil();
      field.focus();
      const actions = card.querySelector('.note__actions');
      actions.innerHTML =
        `<button class="btn btn--primary" type="button" data-note-save>${escapeHtml(t('action.save'))}</button>` +
        `<button class="btn btn--ghost" type="button" data-note-cancel>${escapeHtml(t('action.cancel'))}</button>`;
      actions.querySelector('[data-note-cancel]').addEventListener('click', () => loadMemory());
      actions.querySelector('[data-note-save]').addEventListener('click', async () => {
        try {
          const event = kindBox.value === 'event';
          await api.saveNote(scope, key, field.value, { kind: kindBox.value, expires: event ? untilBox.value : '' });
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
    // An agreement since 2026-10-26 covers the terms and the usage policy too;
    // one from before said yes to the privacy notice alone, and says so.
    const kind = event.kind === 'consent_given' && detail.terms ? 'consent_given_all' : event.kind;
    const what = t(`activity.${kind}`, {
      provider: detail.provider || detail.service || '',
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
