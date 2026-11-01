/**
 * Account security — the second factor, and changing your password.
 *
 * Lifted out of `app.js` whole. Both things here are the same job from the
 * user's side (make this account harder to take) and neither is referenced from
 * anywhere else, so `renderTwoFactor` is the only handle the settings sheet
 * needs back.
 *
 * The English that was hardcoded in these lines while it lived in `app.js` is
 * now in the dictionaries with the rest — see `twofa.*`.
 */

import { api } from './api.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

const val = (id) => /** @type {HTMLInputElement} */ ($(id)).value;

/**
 * @param {object} deps
 * @param {any} deps.state               the app's shared state object
 * @param {() => void} deps.fillSettings  redraw the sheet once the account changes
 */
export function createTwoFactor({ state, fillSettings }) {
  /**
   * Two-factor is no longer offered (owner, 2026-11-01): there is no way to
   * set it up from here. An account that turned it on before still signs in
   * with its code, so for that account alone the row is shown — to turn it off.
   */
  function renderTwoFactor() {
    const me = state.boot.user;
    const card = $('twofa-card');
    $('twofa-row').hidden = !me.twoFactor;

    if (me.twoFactor) {
      card.innerHTML = `
      <div class="provider">
        <div class="provider__head">
          <span class="provider__name">${escapeHtml(t('twofa.enabled'))}</span>
          <span class="badge badge--ok">${escapeHtml(
            t('twofa.recoveryLeft', { count: me.recoveryCodesLeft }),
          )}</span>
        </div>
        <div class="hint">${escapeHtml(t('twofa.requiredEveryTime'))}</div>
        <div class="provider__row">
          <input type="password" id="twofa-password" placeholder="${escapeHtml(t('account.yourPassword'))}" aria-label="${escapeHtml(t('account.yourPassword'))}" autocomplete="current-password" />
          <input type="text" id="twofa-off-code" placeholder="${escapeHtml(t('twofa.code'))}" aria-label="${escapeHtml(t('twofa.code'))}" inputmode="numeric" autocomplete="one-time-code" />
          <button class="btn btn--ghost" id="twofa-disable" type="button">${escapeHtml(t('twofa.turnOff'))}</button>
        </div>
      </div>`;
      $('twofa-disable').addEventListener('click', async () => {
        try {
          await api.disableTwoFactor(val('twofa-password'), val('twofa-off-code').trim());
          state.boot = await api.bootstrap();
          fillSettings();
          toast(t('account.totpOff'));
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      return;
    }
    card.replaceChildren();
  }

  $('save-password').addEventListener('click', async () => {
    const button = /** @type {HTMLButtonElement} */ ($('save-password'));
    button.disabled = true;
    try {
      const { signedOutOtherDevices } = await api.changePassword(val('current-password'), val('new-password'));
      /** @type {HTMLInputElement} */ ($('current-password')).value = '';
      /** @type {HTMLInputElement} */ ($('new-password')).value = '';
      toast(signedOutOtherDevices ? t('account.passwordUpdatedAll') : t('account.passwordUpdated'));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  return { renderTwoFactor };
}
