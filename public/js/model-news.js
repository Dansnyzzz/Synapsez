/**
 * "A new model has arrived" — the one-off announcement.
 *
 * Lifted out of `app.js` whole. Self-contained by nature: it owns one dialog,
 * asks one question, and the only thing the rest of the app does with it is
 * call `check()` once after sign-in.
 */

import { api } from './api.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/** A context window as a person would say it, or null when it is not published. */
const fmtTokens = (n) => {
  if (!n) return null;
  if (n >= 1e6) return t('news.tokensM', { n: (n / 1e6).toFixed(n % 1e6 ? 1 : 0) });
  if (n >= 1e3) return t('news.tokensK', { n: Math.round(n / 1e3) });
  return t('news.tokens', { n });
};

/**
 * @param {object} deps
 * @param {any} deps.state                     the app's shared state object
 * @param {() => void} deps.renderTopbar       the model chip shows the new default
 * @param {() => void} deps.refreshModelFacts  vision and free-ness change with the model
 */
export function createModelNews({ state, renderTopbar, refreshModelFacts }) {
  const newsDialog = /** @type {HTMLDialogElement} */ ($('model-news'));

  /**
   * Tell somebody about a model worth knowing about, once.
   *
   * Deliberately a modal rather than a toast: it asks a question, and the two
   * answers do different things. Deliberately detailed, too — "a new model is
   * available" is not enough to decide with, so it carries who made it, when they
   * released it, how much context it holds, what it costs, and what it is for.
   */
  function showModelNews(model) {
    $('news-vendor').textContent = model.vendor || model.family || '';
    $('news-title').textContent = model.label;
    $('news-id').textContent = model.id;

    const unstated = t('news.unstated');
    const facts = [
      [t('news.madeBy'), model.vendor || model.family],
      [
        t('news.released'),
        model.releasedAt
          ? new Date(model.releasedAt).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : unstated,
      ],
      [t('news.contextWindow'), fmtTokens(model.context) || unstated],
      [
        t('news.price'),
        model.isFree
          ? t('news.priceFree')
          : model.price
            ? t('news.priceRate', { in: model.price.in, out: model.price.out })
            : t('news.unpublished'),
      ],
      [t('news.runsOn'), t('news.yourKey')],
    ];

    $('news-facts').innerHTML = facts
      .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(String(value))}</dd>`)
      .join('');

    $('news-description').textContent = model.description || '';
    $('news-description').hidden = !model.description;

    $('news-note').textContent = model.isFree ? t('news.free') : t('news.billed');

    const decide = async (action) => {
      const apply = /** @type {HTMLButtonElement} */ ($('news-apply'));
      const decline = /** @type {HTMLButtonElement} */ ($('news-decline'));
      apply.disabled = true;
      decline.disabled = true;
      try {
        const { prefs } = await api.decideModelNews(model.id, action);
        state.boot.prefs = prefs;
        if (action === 'apply') {
          state.model = prefs.defaultModel;
          renderTopbar();
          refreshModelFacts();
          toast(t('news.nowDefault', { model: model.label }));
        }
        newsDialog.close();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        apply.disabled = false;
        decline.disabled = false;
      }
    };

    $('news-apply').onclick = () => decide('apply');
    $('news-decline').onclick = () => decide('decline');

    // Dismissing with Escape is not an answer, so it would come back next visit.
    // Closing without deciding is a fair thing to want, so let it — and treat it
    // as "not now", which is what it plainly means.
    newsDialog.addEventListener(
      'cancel',
      (event) => {
        event.preventDefault();
        decide('decline');
      },
      { once: true },
    );

    newsDialog.showModal();
  }

  /**
   * Look again at six in the morning, this device's time, if the app is still
   * open then — that is when the library is refreshed for this person, and a
   * tab left open overnight should hear about a release the same morning as
   * one opened fresh. A few random minutes on top, so a deployment's worth of
   * tabs does not arrive in the same second.
   */
  let morning = null;
  function scheduleMorning(check) {
    clearTimeout(morning);
    const now = new Date();
    const next = new Date(now);
    next.setHours(6, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const wait = next.getTime() - now.getTime() + Math.floor(Math.random() * 5 * 60_000);
    morning = setTimeout(() => {
      void check();
    }, wait);
  }

  return {
    /** Ask the server whether there is anything to announce, and announce it. */
    async check() {
      scheduleMorning(() => this.check());
      try {
        const { model } = await api.modelNews();
        if (!model) return;
        showModelNews(model);
        // Only now is the twenty-hour quiet period spent — see markAnnouncementShown.
        // Not awaited: the dialog is up either way, and a failed acknowledgement
        // should mean being told again, not losing the dialog.
        api.decideModelNews(model.id, 'shown').catch(() => {});
      } catch {
        /* never worth interrupting a session over */
      }
    },
  };
}
