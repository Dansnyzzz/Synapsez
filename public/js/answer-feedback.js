import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * Feedback on one answer (owner, 2026-11-02), as Claude asks for it from the
 * button beside an answer's copy button: what kind of problem — from a list,
 * optional — and what was unsatisfying — in words, optional. It goes to the
 * people who run this deployment with the conversation and that turn as it
 * ran (server/routes/feedback.js, `/feedback/answer`), so they can see exactly
 * what went wrong; the line above Submit says so before anything is sent.
 *
 * @typedef {{ chatId: string, messageId: string | null, incognito: boolean, button: HTMLElement | null }} Target
 * @typedef {{ send: (body: any) => Promise<{ included?: boolean }>, version: () => Promise<string>, language: () => string, done: (included: boolean) => void, failed: (message: string) => void }} Deps
 */

/** Claude's list, in its order — the server holds the same (ANSWER_ISSUES). */
export const ANSWER_ISSUES = [
  'ui_bug', 'overactive_refusal', 'poor_image', 'not_followed', 'not_factual', 'incomplete',
  'thought_process', 'should_search', 'memory', 'report_content', 'usage_policy', 'other',
];

const CHEVRON =
  '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>';

/** @param {Deps} deps */
export function createAnswerFeedback(deps) {
  const dialog = document.createElement('dialog');
  dialog.className = 'afb';
  dialog.id = 'answer-feedback';
  dialog.setAttribute('aria-labelledby', 'afb-title');
  document.body.append(dialog);

  /** @type {Target | null} */
  let target = null;
  /** @type {string | null} */
  let issue = null;
  let active = 0;
  let sending = false;
  // The Escape that shut the list, so the `cancel` it may bring does not shut the dialog too.
  let listJustShut = false;

  const $ = (selector) => /** @type {HTMLElement} */ (dialog.querySelector(selector));
  const options = () => /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('[role="option"]')]);

  function paint() {
    dialog.innerHTML = `
      <h2 class="afb__title" id="afb-title">${escapeHtml(t('answerFeedback.title'))}</h2>
      <p class="afb__label" id="afb-issue-label">${escapeHtml(t('answerFeedback.issueQ'))}</p>
      <div class="afb__select">
        <button type="button" class="afb__pick" id="afb-pick" aria-haspopup="listbox" aria-expanded="false" aria-controls="afb-list" aria-labelledby="afb-issue-label afb-pick">
          <span class="afb__value is-empty" id="afb-value">${escapeHtml(t('answerFeedback.select'))}</span>${CHEVRON}
        </button>
        <ul class="afb__list" id="afb-list" role="listbox" tabindex="-1" aria-labelledby="afb-issue-label" hidden>
          ${ANSWER_ISSUES.map((id) => {
            const label = t(`answerFeedback.issue.${id}`);
            return `<li role="option" id="afb-opt-${id}" data-issue="${id}" aria-selected="false" title="${escapeHtml(label)}">${escapeHtml(label)}</li>`;
          }).join('')}
        </ul>
      </div>
      <label class="afb__label" for="afb-details">${escapeHtml(t('answerFeedback.detailsQ'))}</label>
      <textarea class="afb__text" id="afb-details" rows="4" maxlength="5000" placeholder="${escapeHtml(t('answerFeedback.placeholder'))}"></textarea>
      <p class="afb__note">${escapeHtml(t(target?.incognito ? 'answerFeedback.noteIncognito' : 'answerFeedback.note'))} <a href="/privacy.html" target="_blank" rel="noopener noreferrer">${escapeHtml(t('answerFeedback.learnMore'))}</a></p>
      <div class="afb__actions">
        <button type="button" class="btn btn--ghost" data-cancel>${escapeHtml(t('action.cancel'))}</button>
        <button type="button" class="btn afb__submit" data-submit>${escapeHtml(t('answerFeedback.submit'))}</button>
      </div>`;
  }

  /** The list open or shut; open, it takes the focus and lights the chosen one. */
  function setOpen(open) {
    const list = $('#afb-list');
    const pick = $('#afb-pick');
    list.hidden = !open;
    pick.setAttribute('aria-expanded', String(open));
    if (open) {
      active = Math.max(0, issue ? ANSWER_ISSUES.indexOf(issue) : 0);
      light();
      list.focus();
    } else {
      list.removeAttribute('aria-activedescendant');
    }
  }

  function light() {
    const list = $('#afb-list');
    options().forEach((option, i) => option.classList.toggle('is-active', i === active));
    const option = options()[active];
    if (!option) return;
    list.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  }

  function choose(id) {
    issue = id;
    for (const option of options()) option.setAttribute('aria-selected', String(option.dataset.issue === id));
    const value = $('#afb-value');
    value.textContent = t(`answerFeedback.issue.${id}`);
    value.classList.remove('is-empty');
    setOpen(false);
    $('#afb-pick').focus();
  }

  async function submit() {
    if (!target || sending) return;
    sending = true;
    const button = /** @type {HTMLButtonElement} */ ($('[data-submit]'));
    button.disabled = true;
    try {
      const sent = await deps.send({
        chatId: target.chatId,
        messageId: target.messageId || undefined,
        issue: issue || undefined,
        details: /** @type {HTMLTextAreaElement} */ ($('#afb-details')).value,
        language: deps.language(),
        version: await deps.version(),
      });
      target.button?.classList.add('is-sent');
      target.button?.setAttribute('aria-pressed', 'true');
      dialog.close();
      deps.done(sent?.included !== false);
    } catch (err) {
      button.disabled = false;
      deps.failed(err.message);
    } finally {
      sending = false;
    }
  }

  dialog.addEventListener('click', (event) => {
    const el = /** @type {HTMLElement} */ (event.target);
    const option = /** @type {HTMLElement | null} */ (el.closest('[role="option"]'));
    if (option) return choose(option.dataset.issue);
    if (el.closest('#afb-pick')) return setOpen($('#afb-list').hidden);
    if (el.closest('[data-cancel]')) return dialog.close();
    if (el.closest('[data-submit]')) return submit();
    // Anywhere else shuts the list, as a native select does.
    if (!el.closest('.afb__select') && !$('#afb-list').hidden) setOpen(false);
  });

  dialog.addEventListener('mousemove', (event) => {
    const option = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[role="option"]'));
    if (!option) return;
    const at = options().indexOf(option);
    if (at !== active) {
      active = at;
      options().forEach((o, i) => o.classList.toggle('is-active', i === active));
      $('#afb-list').setAttribute('aria-activedescendant', option.id);
    }
  });

  dialog.addEventListener('keydown', (event) => {
    const list = $('#afb-list');
    const inList = !list.hidden && document.activeElement === list;
    if (inList) {
      const last = ANSWER_ISSUES.length - 1;
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        active = Math.min(last, Math.max(0, active + step));
        light();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        active = event.key === 'Home' ? 0 : last;
        light();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose(ANSWER_ISSUES[active]);
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        // Escape shuts the list, not the dialog — `cancel` may still follow this key.
        if (event.key === 'Escape') {
          event.preventDefault();
          listJustShut = true;
          // Only for the cancel this very key brings, never a later Escape.
          setTimeout(() => (listJustShut = false), 50);
        }
        setOpen(false);
        $('#afb-pick').focus();
      }
      return;
    }
    if (document.activeElement?.id === 'afb-pick' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setOpen(true);
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });

  // Escape with the list open shuts the list; the dialog stays.
  dialog.addEventListener('cancel', (event) => {
    if (listJustShut || !$('#afb-list')?.hidden) {
      event.preventDefault();
      listJustShut = false;
      setOpen(false);
      $('#afb-pick').focus();
    }
  });

  dialog.addEventListener('close', () => {
    target?.button?.focus();
    target = null;
  });

  return {
    /** @param {Target} about */
    open(about) {
      target = about;
      issue = null;
      sending = false;
      paint();
      dialog.showModal();
      $('#afb-pick').focus();
    },
  };
}
