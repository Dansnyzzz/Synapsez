import { t } from './i18n.js';
import { escapeHtml, renderMarkdown } from './markdown.js';

/*
 * "Ask aside" (spec B.6): a card beside a bot's chat for one question about it, answered
 * from the conversation and never kept there or in memory. The tab keeps the last five
 * questions and answers for each bot until it is reloaded — nowhere else.
 */

/** How many questions and answers the card keeps for a bot, for this tab. */
export const ASIDE_KEPT = 5;

/**
 * @param {{ host: HTMLElement, api: any, toast: (text: string, kind?: string) => void, botOf: (id: string) => any, model: () => string | undefined }} deps
 */
export function createAside({ host, api, toast, botOf, model }) {
  /** @type {Map<string, Array<{ q: string, a: string }>>} */
  const kept = new Map();
  let botId = '';
  let asking = false;
  /** What is being typed, kept across a redraw. */
  let draft = '';
  /** Where focus was before the card opened, to go back to. */
  let from = /** @type {HTMLElement | null} */ (null);

  host.className = 'botaside';
  host.hidden = true;

  function draw() {
    const bot = botOf(botId);
    if (!bot) return close();
    const asked = kept.get(botId) || [];
    const list = asked
      .map((x) => `<li class="botaside__qa"><p class="botaside__q">${escapeHtml(x.q)}</p><div class="botaside__a prose">${renderMarkdown(x.a)}</div></li>`)
      .join('');
    host.innerHTML = `<header class="botaside__head">
        <h2 class="botaside__title" id="botaside-title">${escapeHtml(t('bots.aside.title', { name: bot.name }))}</h2>
        <button class="icon-btn" type="button" data-aside-close aria-label="${escapeHtml(t('action.close'))}" title="${escapeHtml(t('action.close'))}">✕</button>
      </header>
      <p class="hint botaside__note">${escapeHtml(t('bots.aside.note'))}</p>
      ${list ? `<ol class="botaside__list" aria-live="polite">${list}</ol>` : ''}
      ${asking ? `<p class="botaside__wait" role="status"><span class="spinner" aria-hidden="true"></span>${escapeHtml(t('bots.aside.thinking', { name: bot.name }))}</p>` : ''}
      <form class="botaside__form" data-aside-form>
        <textarea rows="2" maxlength="2000" required data-aside-text aria-labelledby="botaside-title" placeholder="${escapeHtml(t('bots.aside.placeholder'))}"${asking ? ' disabled' : ''}>${escapeHtml(draft)}</textarea>
        <button class="btn btn--primary btn--small" type="submit"${asking ? ' disabled' : ''}>${escapeHtml(t('bots.aside.ask'))}</button>
      </form>`;
    host.setAttribute('aria-labelledby', 'botaside-title');
    const list2 = host.querySelector('.botaside__list');
    if (list2) list2.scrollTop = list2.scrollHeight;
  }

  function open(id) {
    if (botId !== id) draft = '';
    botId = id;
    from = /** @type {HTMLElement | null} */ (document.activeElement);
    host.hidden = false;
    draw();
    /** @type {HTMLTextAreaElement | null} */ (host.querySelector('[data-aside-text]'))?.focus();
  }

  function close() {
    if (host.hidden) return;
    host.hidden = true;
    host.innerHTML = '';
    from?.focus?.();
  }

  async function ask(question) {
    const id = botId;
    asking = true;
    draft = '';
    draw();
    try {
      const { answer } = await api.askAside(id, question, model());
      const list = [...(kept.get(id) || []), { q: question, a: answer }].slice(-ASIDE_KEPT);
      kept.set(id, list);
    } catch (err) {
      draft = question;
      toast(err.message, 'error');
    } finally {
      asking = false;
      if (botId === id && !host.hidden) {
        draw();
        /** @type {HTMLTextAreaElement | null} */ (host.querySelector('[data-aside-text]'))?.focus();
      }
    }
  }

  host.addEventListener('click', (event) => {
    if (/** @type {HTMLElement} */ (event.target).closest('[data-aside-close]')) close();
  });
  host.addEventListener('input', (event) => {
    const box = /** @type {HTMLElement} */ (event.target);
    if (box.matches('[data-aside-text]')) draft = /** @type {HTMLTextAreaElement} */ (box).value;
  });
  host.addEventListener('submit', (event) => {
    event.preventDefault();
    const box = /** @type {HTMLTextAreaElement | null} */ (host.querySelector('[data-aside-text]'));
    const question = box?.value.trim() || '';
    if (question && !asking) void ask(question);
  });
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    // Enter asks, Shift+Enter is a new line — as the main box does.
    const box = /** @type {HTMLElement} */ (event.target);
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && box.matches('[data-aside-text]')) {
      event.preventDefault();
      host.querySelector('form')?.requestSubmit();
    }
  });

  return {
    open,
    close,
    /** Whether it shows, and for whom. */
    showingFor: () => (host.hidden ? '' : botId),
  };
}
