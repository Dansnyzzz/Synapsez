/**
 * Your computers — pairing, and what each paired machine is allowed to touch.
 *
 * Lifted out of `app.js` whole. Everything here is about one dialog and the
 * header chip that opens it; the rest of the app needs exactly two things from
 * it, so that is all this hands back.
 *
 * The English that was hardcoded in these lines while it lived in `app.js` is
 * now in the dictionaries with the rest — see `devices.*` and `time.*`.
 */

import { api } from './api.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/** How long ago, in the coarsest unit that still says something useful. */
const relativeAgo = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minAgo', { n: mins });
  if (mins < 60 * 24) return t('time.hoursAgo', { n: Math.round(mins / 60) });
  return new Date(iso).toLocaleDateString();
};

/**
 * @param {object} deps
 * @param {any} deps.state                        the app's shared state object
 * @param {() => Promise<any>} deps.refreshWorker re-read which machine is live
 * @param {(button: any, warning: string, run: () => Promise<any>) => void} deps.armed
 *        the two-press confirm used everywhere destructive in this app
 */
export function createDevices({ state, refreshWorker, armed }) {
  const pairDialog = /** @type {HTMLDialogElement} */ ($('pair'));

  function openPair() {
    pairDialog.showModal();
    $('pair-status').textContent = '';
    loadDevices();
    if (!matchMedia('(hover: none)').matches) $('pair-code').focus();
  }

  /** The header chip says at a glance whether anything is connected. */
  function renderPairChip() {
    const worker = state.boot?.worker;
    const online = !!worker?.online;
    const count = worker?.machines?.length || 0;

    let label;
    if (!online) label = t('devices.add');
    // The app is running on the machine it works on, so there is nothing to pair
    // for *this* account — but somebody else can still pair a computer of theirs.
    else if (worker.local) label = t('devices.thisOne');
    else if (count > 1) label = t('devices.countComputers', { count });
    else label = worker.activeName || t('devices.computer');

    // The chip carries no dot: the label above already says whether anything
    // is connected, and by name when something is.
    $('pair-chip').classList.toggle('is-online', online);
    $('pair-chip-label').textContent = label;
    $('pair-chip').title = online ? t('devices.yours') : t('devices.none');
  }

  /**
   * The code this machine is offering, when the app happens to be running on it.
   *
   * Eight characters is not much to retype, but it is enough to get wrong — and
   * when the terminal showing them is on the same screen as the browser, making
   * somebody read across is a small indignity with an obvious fix.
   */
  function renderLocalCode(local) {
    const box = $('pair-offer');
    box.hidden = !local;
    if (!local) return;

    $('pair-offer-code').textContent = local.code;
    $('pair-offer-note').textContent = local.name
      ? t('devices.waitingAs', { name: local.name })
      : t('devices.waiting');
  }

  async function loadDevices() {
    const { devices, localCode } = await api.devices();
    renderLocalCode(localCode);
    const host = $('device-list');
    const activeId = state.boot.worker?.activeId ?? null;

    if (!devices.length) {
      host.innerHTML = `<p class="hint">${escapeHtml(t('devices.noneYet'))}</p>`;
      return;
    }

    host.innerHTML = `${devices
      .map((d) => {
        const facts = [
          d.platform,
          d.desktop ? t('devices.desktopOn') : null,
          // The reach and the root are different questions, and the answer to the
          // first decides what the second is worth: confined to the folder, or
          // free of it.
          d.fullDisk ? t('devices.wholeDisk') : t('devices.confined'),
          d.online ? null : t('devices.lastSeen', { when: d.lastSeen ? relativeAgo(d.lastSeen) : t('devices.never') }),
        ]
          .filter(Boolean)
          .map(escapeHtml)
          .join(' · ');

        // Asked for but not adopted: either the machine has not checked in yet, or
        // the folder is not there. Say which rather than showing a path that is
        // quietly not in use.
        const pending = d.wanted && d.workspace && d.wanted !== d.workspace;
        // Already escaped, and the only markup the sentence carries — so the
        // dictionary entry stays plain prose a translator can read.
        const where = `<code>${escapeHtml(d.workspace)}</code>`;

        return `<div class="provider" data-device="${escapeHtml(d.id)}">
        <div class="provider__head">
          <span class="provider__name">
            <span class="dot ${d.online ? 'is-online' : 'is-offline'}"></span>
            ${escapeHtml(d.name)}
            ${d.id === activeId ? `<span class="tag">${escapeHtml(t('devices.inUse'))}</span>` : ''}
          </span>
          <span class="badge ${d.online ? 'badge--ok' : ''}">${escapeHtml(
            d.online ? t('devices.online') : t('devices.offline'),
          )}</span>
        </div>
        <div class="hint">${facts}</div>

        <label class="device__label" for="ws-${escapeHtml(d.id)}">${escapeHtml(t('devices.workingFolder'))}</label>
        <div class="provider__row">
          <input id="ws-${escapeHtml(d.id)}" type="text" spellcheck="false"
                 value="${escapeHtml(d.wanted || d.workspace || '')}"
                 placeholder="D:\\projects" data-ws="${escapeHtml(d.id)}" />
          <button class="btn btn--ghost" data-ws-save="${escapeHtml(d.id)}" type="button">${escapeHtml(
            t('action.save'),
          )}</button>
        </div>
        <p class="hint" data-ws-status="${escapeHtml(d.id)}">${
          d.workspaceError
            ? `<span class="warn-text">${escapeHtml(d.workspaceError)}</span>`
            : pending
              ? t('devices.workingInPending', { path: where })
              : d.workspace
                ? t('devices.workingIn', { path: where })
                : t('devices.willReport')
        }</p>

        <div class="row">
          ${
            d.online && d.id !== activeId
              ? `<button class="btn btn--ghost" data-use-device="${escapeHtml(
                  d.id,
                )}" type="button">${escapeHtml(t('devices.workOnThis'))}</button>`
              : ''
          }
          <button class="btn btn--ghost" data-unpair="${escapeHtml(d.id)}" type="button">${escapeHtml(
            t('devices.unpair'),
          )}</button>
        </div>
      </div>`;
      })
      .join('')}
    ${
      /**
       * Say which rule is deciding, and offer the way back.
       *
       * Pinning a machine is deliberate and has to stick — software that quietly
       * overrides an explicit choice is a worse bug than choosing the wrong
       * machine. But a pin made last month is invisible, and the symptom is a
       * file opening on a computer in another building. So the state is stated,
       * and clearing it is one button.
       */
      state.boot.prefs?.activeDevice
        ? `<p class="hint">${escapeHtml(t('devices.pinned'))}
             <button class="btn btn--ghost btn--tiny" id="unpin-device" type="button">${escapeHtml(t('devices.unpin'))}</button></p>`
        : devices.filter((d) => d.online).length > 1
          ? `<p class="hint">${escapeHtml(t('devices.followsYou'))}</p>`
          : ''
    }`;

    for (const btn of /** @type {NodeListOf<HTMLButtonElement>} */ (host.querySelectorAll('[data-ws-save]'))) {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.wsSave;
        const field = /** @type {HTMLInputElement} */ (host.querySelector(`[data-ws="${id}"]`));
        const status = host.querySelector(`[data-ws-status="${id}"]`);
        btn.disabled = true;
        try {
          await api.setDeviceWorkspace(id, field.value.trim());
          status.textContent = field.value.trim() ? t('devices.moved') : t('devices.revertedToOwn');
          // Long enough for a heartbeat to land and report where it really is.
          setTimeout(loadDevices, 16_000);
        } catch (err) {
          status.textContent = err.message;
        } finally {
          btn.disabled = false;
        }
      });
    }

    host.querySelector('#unpin-device')?.addEventListener('click', async () => {
      try {
        state.boot.prefs = await api.savePrefs({ activeDevice: null });
        await refreshWorker();
        await loadDevices();
        toast(t('devices.unpinned'));
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-use-device]'))) {
      btn.addEventListener('click', async () => {
        try {
          state.boot.prefs = await api.savePrefs({ activeDevice: btn.dataset.useDevice });
          await refreshWorker();
          await loadDevices();
          toast(t('devices.switched'));
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    // Unpairing cuts a machine off mid-task if one is running, so it asks twice.
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-unpair]'))) {
      armed(btn, t('devices.reallyUnpair'), async () => {
        const { name } = await api.unpairDevice(btn.dataset.unpair);
        toast(t('devices.unpaired', { name }));
        await refreshWorker();
        await loadDevices();
      });
    }
  }

  $('pair-chip').addEventListener('click', () => openPair());
  $('open-pair').addEventListener('click', () => {
    /** @type {HTMLDialogElement} */ ($('settings')).close();
    openPair();
  });

  $('pair-copy').addEventListener('click', async () => {
    const label = $('pair-copy-label');
    try {
      await navigator.clipboard.writeText($('pair-offer-code').textContent);
      label.textContent = t('devices.copied');
      setTimeout(() => {
        label.textContent = t('devices.copy');
      }, 1600);
    } catch {
      // Refused, usually because the page is not on a secure origin. Selecting it
      // for them is the next best thing.
      const range = document.createRange();
      range.selectNodeContents($('pair-offer-code'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      label.textContent = t('devices.pressCtrlC');
    }
  });

  $('pair-submit').addEventListener('click', async () => {
    const field = /** @type {HTMLInputElement} */ ($('pair-code'));
    const status = $('pair-status');
    const submit = /** @type {HTMLButtonElement} */ ($('pair-submit'));
    const code = field.value.trim();
    if (!code) return;

    submit.disabled = true;
    status.textContent = t('devices.pairing');
    try {
      const { device } = await api.pairDevice(code);
      field.value = '';
      status.textContent = t('devices.added', { name: device.name });
      toast(t('devices.nowYours', { name: device.name }));
      await loadDevices();
      // The machine polls every two seconds; give it a moment, then show it live.
      setTimeout(async () => {
        await refreshWorker();
        await loadDevices();
        renderPairChip();
      }, 3000);
    } catch (err) {
      status.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  // Typing the code is the whole interaction, so Enter should finish it.
  $('pair-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('pair-submit').click();
    }
  });

  return { renderPairChip, loadDevices, openPair };
}
