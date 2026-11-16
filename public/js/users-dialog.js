import { t, localeTag } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';

/*
 * The accounts of a deployment, as Settings → People shows them: the ten busiest this month on the page,
 * the rest a page at a time in a full-screen dialog. One row renderer serves both, so what a row says and
 * what its buttons do cannot drift between the two places.
 */

const PAGE_SIZE = 20;

/**
 * The rows for these accounts, from the point of view of the administrator looking at them.
 *
 * @param {any[]} users
 * @param {any} me  state.boot.user: its id, whether it is the owner, and what it may do
 */
export function userRowsHtml(users, me) {
  const perms = new Set(me.permissions || []);
  return `<div class="rows">${users
    .map((u) => {
      const tags = [
        t('admin.chatCount', { n: u.chat_count }),
        t('admin.tokensThisMonth', { n: Number(u.tokens_this_month || 0).toLocaleString(localeTag()) }),
        u.has_worker ? t('admin.workerPaired') : null,
        u.email_verified_at ? null : t('admin.unconfirmed'),
        u.suspended_at ? t('admin.suspended') : null,
        u.monthly_token_limit ? t('admin.limit', { n: Number(u.monthly_token_limit).toLocaleString(localeTag()) }) : null,
      ].filter(Boolean);

      const self = u.id === me.id;
      // What this administrator may do to that account. The server decides; this
      // only leaves out the buttons it would refuse.
      const touchable = !self && !u.is_owner && (u.role !== 'admin' || me.isOwner);
      const role = u.is_owner ? t('admins.owner') : u.role === 'admin' ? t('role.admin') : null;
      return `<div class="rows__item">
          <span class="grow">${escapeHtml(u.name || u.email)}
            <span class="muted">· ${escapeHtml(u.email)} · ${escapeHtml(tags.join(' · '))}</span>
            ${role ? `<span class="admins__tag">${escapeHtml(role)}</span>` : ''}
          </span>
          ${
            self
              ? `<span class="muted">${escapeHtml(t('admin.you'))}</span>`
              : `${
                  touchable && perms.has('users')
                    ? `<button type="button" data-limit-user="${escapeHtml(u.id)}">${escapeHtml(t('admin.limitButton'))}</button>
                 <button type="button" data-suspend-user="${escapeHtml(u.id)}" data-suspended="${!!u.suspended_at}">
                   ${escapeHtml(u.suspended_at ? t('admin.unsuspend') : t('admin.suspend'))}
                 </button>`
                    : ''
                }${touchable && perms.has('delete_users') ? `<button type="button" data-del-user="${escapeHtml(u.id)}">${escapeHtml(t('action.remove'))}</button>` : ''}`
          }
        </div>`;
    })
    .join('')}</div>`;
}

/**
 * Make the buttons of rows drawn by `userRowsHtml` work. `reload` runs after anything that changed an account, and
 * is what puts the new state on screen.
 *
 * @param {HTMLElement} host
 * @param {{ api: any, armed: Function, reload: () => any }} deps
 */
export function wireUserRows(host, { api, armed, reload }) {
  for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-del-user]'))) {
    armed(btn, t('action.reallyRemove'), async () => {
      await api.deleteUser(btn.dataset.delUser);
      reload();
    });
  }
  for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-suspend-user]'))) {
    btn.addEventListener('click', async () => {
      try {
        await api.updateUser(btn.dataset.suspendUser, { suspended: btn.dataset.suspended !== 'true' });
        reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  // An inline field rather than prompt(), for the same reason as everything
  // else here: a suppressed dialog is indistinguishable from a dead button.
  for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-limit-user]'))) {
    btn.addEventListener('click', () => {
      const field = document.createElement('input');
      field.type = 'number';
      field.min = '0';
      field.className = 'chat-item--editing users__limit';
      field.placeholder = t('admin.limitPlaceholder');
      field.title = t('admin.tokenLimit');
      field.setAttribute('aria-label', t('admin.tokenLimit'));
      btn.replaceWith(field);
      field.focus();

      let settled = false;
      const finish = async (commit) => {
        if (settled) return;
        settled = true;
        if (!commit) return reload();
        try {
          await api.updateUser(btn.dataset.limitUser, { monthlyTokenLimit: Number(field.value) || 0 });
        } catch (err) {
          toast(err.message, 'error');
        }
        reload();
      };
      field.addEventListener('keydown', (event) => {
        // Esc here leaves the field, not the dialog around it.
        if (event.key === 'Escape') event.preventDefault();
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      });
      field.addEventListener('blur', () => finish(true));
    });
  }
}

/**
 * The full list, a page at a time. The server pages (`GET /api/admin/users?page&size`), so a deployment with
 * thousands of accounts never sends them all to answer for twenty.
 *
 * @param {{ api: any, me: any | (() => any), armed: Function, onChanged: () => any }} deps
 *   `onChanged` redraws what is behind the dialog (the ten busiest); `me` may be a function because the signed-in account's
 *   record is replaced when the app re-reads its bootstrap.
 */
export function createUsersDialog({ api, me, armed, onChanged }) {
  /** @type {HTMLDialogElement | null} */
  let dialog = null;
  let page = 1;
  let total = 0;
  // Bumped by every request: an answer that arrives after a newer one was asked for is for a page nobody is on.
  let ticket = 0;
  const who = () => (typeof me === 'function' ? me() : me);
  const pages = () => Math.max(1, Math.ceil(total / PAGE_SIZE));
  const $ = (selector) => /** @type {HTMLElement} */ (dialog.querySelector(selector));

  function ensure() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'users-all';
    dialog.className = 'sheet users-all';
    dialog.setAttribute('aria-labelledby', 'users-all-title');
    dialog.innerHTML = `<div class="sheet__head"><h2 id="users-all-title" tabindex="-1">${escapeHtml(t('admin.allTitle'))}</h2><button type="button" class="icon-btn" data-close aria-label="${escapeHtml(t('action.close'))}">✕</button></div>
      <div class="users-all__pager">
        <button type="button" class="btn btn--ghost btn--small" data-users-prev aria-label="${escapeHtml(t('admin.prevPage'))}">←</button>
        <span class="users-all__page" data-users-page role="status" aria-live="polite"></span>
        <button type="button" class="btn btn--ghost btn--small" data-users-next aria-label="${escapeHtml(t('admin.nextPage'))}">→</button>
      </div>
      <div class="sheet__body users-all__body" data-users-rows></div>`;
    document.body.append(dialog);
    dialog.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (target.closest('[data-close]')) dialog.close();
      else if (target.closest('[data-users-prev]')) go(page - 1);
      else if (target.closest('[data-users-next]')) go(page + 1);
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // In a field the arrows move the caret: they are the field's, not the list's.
      const el = /** @type {HTMLElement} */ (event.target);
      if (el.closest?.('input, textarea, select, [contenteditable]')) return;
      event.preventDefault();
      go(page + (event.key === 'ArrowRight' ? 1 : -1));
    });
    // The page behind this is what the person came from: put them back on the button that opened it. It is looked up, not
    // remembered, because an action in here redraws the ten behind it, and the button with it.
    dialog.addEventListener('close', () => document.getElementById('users-see-all')?.focus());
    return dialog;
  }

  function paintPager() {
    $('[data-users-page]').textContent = t('admin.page', { n: String(page), m: String(pages()) });
    // aria-disabled, not disabled: pressing → on the last page must not throw focus away with the button.
    $('[data-users-prev]').setAttribute('aria-disabled', String(page <= 1));
    $('[data-users-next]').setAttribute('aria-disabled', String(page >= pages()));
  }

  async function load() {
    const mine = ++ticket;
    const rows = $('[data-users-rows]');
    rows.setAttribute('aria-busy', 'true');
    try {
      const found = await api.users({ page, size: PAGE_SIZE });
      if (mine !== ticket) return;
      total = found.total ?? found.users.length;
      // The last account of the last page was removed: the page is gone, so show the one before.
      if (!found.users.length && page > 1) {
        page = pages();
        return load();
      }
      rows.innerHTML = userRowsHtml(found.users, who());
      wireUserRows(rows, { api, armed, reload });
      paintPager();
      rows.scrollTop = 0;
    } catch (err) {
      if (mine === ticket) toast(err.message, 'error');
    } finally {
      if (mine === ticket) rows.removeAttribute('aria-busy');
    }
  }

  function go(next) {
    if (next < 1 || next > pages() || next === page) return;
    page = next;
    paintPager();
    void load();
  }

  /** After an account changed: this page again, and the ten behind it. */
  async function reload() {
    await Promise.all([load(), onChanged()]);
  }

  return {
    async open() {
      // Built afresh each time: the words are in the language of the moment, and the language can change between opens.
      dialog?.remove();
      dialog = null;
      ensure();
      page = 1;
      dialog.querySelector('[data-users-rows]').replaceChildren();
      paintPager();
      if (!dialog.open) dialog.showModal();
      $('#users-all-title').focus();
      await load();
    },
  };
}
