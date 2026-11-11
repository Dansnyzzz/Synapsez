import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/*
 * Telegram to Chief, on the Telegram connector's page (spec C.3): the switch, the code
 * the person sends the bot to link their own Telegram id, and up to five more ids that
 * may write to Chief. Never a secret: the server keeps only their hashes.
 */

/**
 * @param {HTMLElement} host @param {{ toast: (text: string, kind?: string) => void }} deps
 */
export async function mountTelegramInbound(host, { toast }) {
  let view = /** @type {any} */ (null);
  let busy = false;

  function draw() {
    if (!view) return;
    const bot = view.botUsername ? `@${view.botUsername}` : t('tg.yourBot');
    const link = view.enabled
      ? view.owner
        ? `<p class="tgin__line">${escapeHtml(t('tg.linked', { id: view.owner }))}</p>`
        : `<p class="tgin__line">${escapeHtml(t('tg.link', { bot }))}</p>
           <p class="tgin__code"><code data-tg-code>/start ${escapeHtml(view.startCode || '')}</code> <button class="btn btn--small" type="button" data-tg-copy>${escapeHtml(t('tg.copy'))}</button></p>`
      : '';
    const others = view.enabled
      ? `<form class="tgin__others" data-tg-others>
          <label class="field"><span>${escapeHtml(t('tg.others'))}</span><input class="sinput" data-tg-ids inputmode="numeric" autocomplete="off" value="${escapeHtml((view.others || []).join(', '))}" placeholder="123456789, 987654321" /></label>
          <small class="hint">${escapeHtml(t('tg.othersHint'))}</small>
          <button class="btn btn--small" type="submit">${escapeHtml(t('tg.save'))}</button>
        </form>`
      : '';
    host.innerHTML = `<h4 class="tgin__title">${escapeHtml(t('tg.title'))}</h4>
      <label class="tgin__switch"><input type="checkbox" role="switch" data-tg-on ${view.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''} /><span>${escapeHtml(t('tg.allow'))}</span></label>
      <p class="hint">${escapeHtml(t('tg.hint'))}</p>
      ${link}${others}`;
  }

  host.addEventListener('change', async (event) => {
    const box = /** @type {HTMLInputElement} */ (event.target);
    if (!box.matches('[data-tg-on]')) return;
    busy = true;
    draw();
    try {
      view = { ...view, ...(await api.setTelegramInbound(box.checked)) };
      toast(t(view.enabled ? 'tg.on' : 'tg.off'), 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
    busy = false;
    draw();
    /** @type {HTMLElement | null} */ (host.querySelector('[data-tg-on]'))?.focus();
  });
  host.addEventListener('click', (event) => {
    if (!(/** @type {HTMLElement} */ (event.target).closest('[data-tg-copy]'))) return;
    const code = host.querySelector('[data-tg-code]')?.textContent || '';
    navigator.clipboard?.writeText(code).then(() => toast(t('viewer.copied'), 'ok'), () => {});
  });
  host.addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = /** @type {HTMLInputElement | null} */ (host.querySelector('[data-tg-ids]'));
    const ids = String(field?.value || '').split(/[\s,;]+/).filter(Boolean);
    try {
      view = { ...view, ...(await api.setTelegramOthers(ids)) };
      toast(t('tg.saved'), 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  host.innerHTML = `<p class="hint" role="status">…</p>`;
  try {
    view = await api.telegramInbound();
    draw();
  } catch (err) {
    host.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
  }
}
