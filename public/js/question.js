import { t } from './i18n.js';

/**
 * A question the assistant is waiting on, with buttons instead of a blank line
 * to type into.
 *
 * Its own module for two reasons. It is a self-contained piece of interface
 * with one way in and one way out — a question arrives, an answer leaves — and
 * app.js is already five thousand lines. And it can be driven directly from
 * a test this way, which is the only way to check that pressing things
 * produces the right answer without a model on the other end.
 *
 * Two layouts:
 *
 *   **Steps** — one question at a time, the way a picker reads: numbered rows,
 *   a single choice answers and moves on, and a last row with a pencil where
 *   somebody types what the list did not think of, with a send arrow that
 *   appears once there is something to send. Arrow keys and Enter work, and so
 *   do the number keys.
 *
 *   **Form** — every question at once with one button at the foot ("Continue
 *   setup"): the shape for setting something up, where the frequency, the
 *   address and the language belong on one page rather than three.
 *
 * @param {{ onAnswer: (answers: { toolCallId: string, given: any[] }) => void, scrollToEnd: () => void }} wiring
 */
export function createQuestionCard({ onAnswer, scrollToEnd }) {
  /** @type {{ toolCallId: string, questions: any[], at: number, given: any[], form: boolean, title: string, submitLabel: string, focus: number } | null} */
  let asking = null;

  const qEl = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const qBtn = (/** @type {string} */ id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));
  // Held once: the pencil row is moved into the list on every paint, and the
  // list is cleared on every paint, so a lookup by id afterwards would miss it.
  const otherRow = /** @type {HTMLElement} */ (document.getElementById('question-otherrow'));
  const otherInput = /** @type {HTMLInputElement} */ (document.getElementById('question-other'));
  const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById('question-send'));
  const qOther = () => otherInput;

  /** @param {{ toolCallId: string, questions: any[], form?: boolean, title?: string, submitLabel?: string }} payload */
  function showQuestion({ toolCallId, questions, form = false, title = '', submitLabel = '' }) {
    asking = {
      toolCallId,
      questions,
      at: 0,
      // One slot per question, filled in as they are answered. Skipping leaves
      // the slot empty, which is what `answerText` reads as "(skipped)".
      given: questions.map(() => ({ picks: [], other: '' })),
      form: !!form,
      title,
      submitLabel,
      focus: -1,
    };
    qEl('question').hidden = false;
    qEl('question').classList.toggle('question--form', !!form);
    paintQuestion();
    scrollToEnd();
    // So the arrow and number keys reach it without a click first.
    if (!form) qEl('question').focus({ preventScroll: true });

    /**
     * Say it out loud when nobody is looking at the tab.
     *
     * The whole turn is stopped until this is answered, so a person who asked
     * for something long and went to do something else comes back to a run that
     * looks stalled. The browser's own notification, asked for here — at the
     * moment there is something worth sending — rather than on page load.
     */
    if (typeof window.Notification === 'undefined' || !document.hidden) return;
    const send = () => {
      if (window.Notification.permission !== 'granted' || !document.hidden) return;
      try {
        new window.Notification(t('question.waiting'), { body: title || questions[0]?.question || '', tag: 'synapse-question' });
      } catch {
        // Some browsers only allow this from a service worker. The card is
        // already on screen for whenever they come back.
      }
    };
    if (window.Notification.permission === 'granted') send();
    else if (window.Notification.permission !== 'denied') window.Notification.requestPermission().then(send).catch(() => {});
  }

  function hideQuestion() {
    asking = null;
    qEl('question').hidden = true;
    qEl('question').classList.remove('question--form');
    qOther().value = '';
    sendButton.hidden = true;
  }

  /** Whether this question has anything on it yet — what Skip and Next hang on. */
  const answeredHere = () => {
    const slot = asking?.given[asking.at];
    return !!(slot && (slot.picks.length || slot.other.trim()));
  };

  const goLabel = () => {
    if (!asking) return '';
    if (asking.form) return asking.submitLabel || t('question.continue');
    const last = asking.at === asking.questions.length - 1;
    return answeredHere() ? (last ? t('question.done') : t('question.next')) : t('question.skip');
  };

  /** One option row: a number (or a tick box when several may be chosen), and the words. */
  function optionRow(q, slot, option, index, onPick) {
    const chosen = slot.picks.includes(option.label);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `question__opt${q.multiple ? ' question__opt--many' : ''}`;
    button.setAttribute('role', q.multiple ? 'checkbox' : 'radio');
    button.setAttribute('aria-checked', String(chosen));
    button.dataset.index = String(index);
    const mark = document.createElement('span');
    mark.className = 'question__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = q.multiple ? '✓' : String(index + 1);
    const label = document.createElement('span');
    label.className = 'question__label';
    label.textContent = option.label;
    if (option.description) {
      const desc = document.createElement('span');
      desc.className = 'question__desc';
      desc.textContent = option.description;
      label.append(desc);
    }
    button.append(mark, label);
    button.addEventListener('click', () => onPick(option, chosen));
    return button;
  }

  /** Choose, un-choose, or add — the same rule in both layouts. */
  function pick(q, slot, option, chosen) {
    if (q.multiple) {
      slot.picks = chosen ? slot.picks.filter((/** @type {string} */ p) => p !== option.label) : [...slot.picks, option.label];
    } else {
      // Pressing the chosen one again clears it, so a mis-tap is undoable
      // without a Clear button nobody would find.
      slot.picks = chosen ? [] : [option.label];
    }
  }

  function paintQuestion() {
    if (!asking) return;
    if (asking.form) return paintForm();
    const { questions, at } = asking;
    const q = questions[at];
    const slot = asking.given[at];

    qEl('question-title').textContent = q.question;
    qEl('question-nav').hidden = questions.length < 2;
    qEl('question-count').textContent = `${at + 1}/${questions.length}`;
    qBtn('question-prev').disabled = at === 0;
    qBtn('question-next').disabled = at === questions.length - 1;
    qEl('question-keys').hidden = false;

    const host = qEl('question-options');
    // Out of the list before it is cleared, so the row survives the repaint.
    host.after(otherRow);
    host.innerHTML = '';
    host.setAttribute('role', q.multiple ? 'group' : 'radiogroup');
    q.options.forEach((/** @type {{ label: string, description?: string }} */ option, index) => {
      host.append(
        optionRow(q, slot, option, index, (opt, chosen) => {
          pick(q, slot, opt, chosen);
          // One of these: choosing is answering, so move on — the way a picker
          // behaves. Several: stay, so more can be added.
          if (!q.multiple && slot.picks.length) {
            slot.other = '';
            return advance();
          }
          paintQuestion();
        }),
      );
    });

    // The last row: the answer the list did not think of, typed in place.
    const row = otherRow;
    row.hidden = !q.other;
    const other = qOther();
    other.placeholder = q.otherLabel || t('question.other');
    other.value = slot.other;
    sendButton.hidden = !slot.other.trim();
    host.append(row);

    asking.focus = Math.min(asking.focus, q.options.length - 1);
    paintFocus();
    qBtn('question-go').textContent = goLabel();
  }

  /** Every question at once, with one button at the foot. */
  function paintForm() {
    if (!asking) return;
    const { questions } = asking;
    qEl('question-title').textContent = asking.title || t('question.formTitle');
    qEl('question-nav').hidden = true;
    qEl('question-keys').hidden = true;
    otherRow.hidden = true;

    const host = qEl('question-options');
    // Out of the list before it is cleared, so the row survives the repaint.
    host.after(otherRow);
    host.innerHTML = '';
    host.setAttribute('role', 'group');
    questions.forEach((q, index) => {
      const slot = asking.given[index];
      const section = document.createElement('div');
      section.className = 'qform__sec';
      const head = document.createElement('div');
      head.className = 'qform__q';
      head.textContent = q.question;
      head.id = `qform-q-${index}`;
      section.append(head);

      if (q.kind && q.kind !== 'choice') {
        const input = document.createElement('input');
        input.className = 'qform__input';
        input.type = q.kind === 'email' ? 'email' : 'text';
        input.placeholder = q.otherLabel || '';
        input.required = !!q.required;
        input.value = slot.other;
        input.dataset.field = String(index);
        input.setAttribute('aria-labelledby', head.id);
        input.addEventListener('input', () => {
          slot.other = input.value;
          input.setCustomValidity('');
        });
        section.append(input);
      } else {
        const list = document.createElement('div');
        list.className = 'qform__opts';
        list.setAttribute('role', q.multiple ? 'group' : 'radiogroup');
        list.setAttribute('aria-labelledby', head.id);
        q.options.forEach((/** @type {{ label: string }} */ option, i) => {
          list.append(
            optionRow(q, slot, option, i, (opt, chosen) => {
              pick(q, slot, opt, chosen);
              paintForm();
            }),
          );
        });
        section.append(list);
        if (q.other) {
          const extra = document.createElement('input');
          extra.className = 'qform__input qform__input--other';
          extra.type = 'text';
          extra.placeholder = q.otherLabel || t('question.other');
          extra.value = slot.other;
          extra.setAttribute('aria-label', extra.placeholder);
          extra.addEventListener('input', () => {
            slot.other = extra.value;
          });
          section.append(extra);
        }
      }
      if (q.hint) {
        const hint = document.createElement('div');
        hint.className = 'qform__hint';
        hint.textContent = q.hint;
        section.append(hint);
      }
      host.append(section);
    });
    qBtn('question-go').textContent = goLabel();
  }

  /** The keyboard's place in the list, drawn. */
  function paintFocus() {
    const rows = [...qEl('question-options').querySelectorAll('.question__opt')];
    rows.forEach((row, i) => row.classList.toggle('is-focus', i === asking?.focus));
  }

  const stepQuestion = (/** @type {number} */ by) => {
    if (!asking) return;
    asking.at = Math.max(0, Math.min(asking.questions.length - 1, asking.at + by));
    asking.focus = -1;
    paintQuestion();
  };
  qBtn('question-prev').addEventListener('click', () => stepQuestion(-1));
  qBtn('question-next').addEventListener('click', () => stepQuestion(1));

  /** On to the next question, or send them all if that was the last. */
  function advance() {
    if (!asking) return;
    if (asking.at < asking.questions.length - 1) return stepQuestion(1);
    sendAnswers();
  }

  qOther().addEventListener('input', (event) => {
    if (!asking) return;
    const value = /** @type {HTMLInputElement} */ (event.target).value;
    asking.given[asking.at].other = value;
    sendButton.hidden = !value.trim();
    qBtn('question-go').textContent = goLabel();
  });

  /** Their own words, sent: for a one-of-these question they replace any pick. */
  function sendOther() {
    if (!asking) return;
    const q = asking.questions[asking.at];
    const slot = asking.given[asking.at];
    if (!slot.other.trim()) return;
    if (!q.multiple) slot.picks = [];
    advance();
  }
  sendButton.addEventListener('click', sendOther);
  qOther().addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      sendOther();
    }
  });

  /**
   * Arrows move, Enter chooses, 1–9 choose directly — the picker keys people
   * already know. Only while the card is up and not while typing in a field.
   */
  qEl('question').addEventListener('keydown', (event) => {
    if (!asking || asking.form) return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.tagName === 'INPUT') return;
    const rows = /** @type {HTMLButtonElement[]} */ ([...qEl('question-options').querySelectorAll('.question__opt')]);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = asking.focus + (event.key === 'ArrowDown' ? 1 : -1);
      if (next >= rows.length && !otherRow.hidden) {
        asking.focus = rows.length;
        paintFocus();
        qOther().focus();
        return;
      }
      asking.focus = Math.max(0, Math.min(rows.length - 1, next));
      paintFocus();
      rows[asking.focus]?.focus();
    } else if (event.key === 'Enter' && target.tagName !== 'BUTTON' && asking.focus >= 0 && rows[asking.focus]) {
      event.preventDefault();
      rows[asking.focus].click();
    } else if (/^[1-9]$/.test(event.key) && rows[Number(event.key) - 1]) {
      event.preventDefault();
      rows[Number(event.key) - 1].click();
    }
  });

  /**
   * Send what there is and let the turn carry on.
   *
   * Skipping is an answer, not a cancel: the tool result says plainly that the
   * question was declined and tells the model not to ask it again.
   */
  function sendAnswers() {
    if (!asking) return;
    const answers = { toolCallId: asking.toolCallId, given: asking.given };
    hideQuestion();
    onAnswer(answers);
  }

  /** A form checks its own fields — a required address, one that is not an address — before it goes. */
  function formValid() {
    for (const input of /** @type {HTMLInputElement[]} */ ([...qEl('question-options').querySelectorAll('input[data-field]')])) {
      if (input.type === 'email' && input.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value.trim())) {
        input.setCustomValidity(t('question.badEmail'));
      }
      if (!input.checkValidity()) {
        input.reportValidity();
        return false;
      }
    }
    return true;
  }

  qBtn('question-go').addEventListener('click', () => {
    if (!asking) return;
    if (asking.form) {
      if (formValid()) sendAnswers();
      return;
    }
    advance();
  });
  qBtn('question-dismiss').addEventListener('click', () => {
    // Everything left empty, which reads as skipped for every question.
    if (asking) asking.given = asking.questions.map(() => ({ picks: [], other: '' }));
    sendAnswers();
  });

  return { show: showQuestion, hide: hideQuestion, showing: () => !!asking };
}
