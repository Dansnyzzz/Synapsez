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
 * @param {{ onAnswer: (answers: { toolCallId: string, given: any[] }) => void, scrollToEnd: () => void }} wiring
 */
export function createQuestionCard({ onAnswer, scrollToEnd }) {
  /* ── a question with buttons on it ──────────────────────────────
   *
   * The turn has stopped on `ask_options` and will not move until this is
   * answered. Everything here is one object: which call is waiting, the
   * questions to draw, which one is showing, and what has been chosen so far.
   * `null` means nothing is being asked, which is also what hides the card.
   * ─────────────────────────────────────────────────────────────── */

  /** @type {{ toolCallId: string, questions: any[], at: number, given: any[] } | null} */
  let asking = null;

  /**
   * The card's own elements, looked up with their real types.
   *
   * `$` hands back `HTMLElement | null`, which is most of the type debt already
   * recorded against this file. Not adding to it: everything below goes through
   * these three, and they say what the element actually is.
   */
  const qEl = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const qBtn = (/** @type {string} */ id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));
  const qOther = () => /** @type {HTMLInputElement} */ (document.getElementById('question-other'));

  /** @param {{ toolCallId: string, questions: any[] }} payload */
  function showQuestion({ toolCallId, questions }) {
    asking = {
      toolCallId,
      questions,
      at: 0,
      // One slot per question, filled in as they are answered. Skipping leaves
      // the slot empty, which is what `answerText` reads as "(skipped)".
      given: questions.map(() => ({ picks: [], other: '' })),
    };
    qEl('question').hidden = false;
    paintQuestion();
    scrollToEnd();

    /**
     * Say it out loud when nobody is looking at the tab.
     *
     * The whole turn is stopped until this is answered, so a person who asked
     * for something long and went to do something else comes back to a run that
     * looks stalled — and has been, for as long as they were away.
     *
     * The browser's own notification rather than the `notify` tool: that one is
     * `local` scope and needs a paired computer awake, so on a phone — which is
     * exactly where somebody has switched apps — it does nothing. Permission is
     * asked for here, at the moment there is something worth sending, rather
     * than on page load, which is the pattern browsers penalise and people
     * refuse on reflex.
     */
    if (typeof window.Notification === 'undefined' || !document.hidden) return;
    const send = () => {
      if (window.Notification.permission !== 'granted' || !document.hidden) return;
      try {
        new window.Notification(t('question.waiting'), { body: questions[0]?.question || '', tag: 'synapse-question' });
      } catch {
        // Some browsers only allow this from a service worker. Nothing is lost:
        // the card is already on screen for whenever they come back.
      }
    };
    if (window.Notification.permission === 'granted') send();
    else if (window.Notification.permission !== 'denied') window.Notification.requestPermission().then(send).catch(() => {});
  }

  function hideQuestion() {
    asking = null;
    qEl('question').hidden = true;
    qOther().value = '';
  }

  /** Whether this question has anything on it yet — what Skip and Next hang on. */
  const answeredHere = () => {
    const slot = asking?.given[asking.at];
    return !!(slot && (slot.picks.length || slot.other.trim()));
  };

  function paintQuestion() {
    if (!asking) return;
    const { questions, at } = asking;
    const q = questions[at];
    const slot = asking.given[at];

    qEl('question-title').textContent = q.question;
    qEl('question-nav').hidden = questions.length < 2;
    qEl('question-count').textContent = `${at + 1}/${questions.length}`;
    qBtn('question-prev').disabled = at === 0;
    qBtn('question-next').disabled = at === questions.length - 1;

    const host = qEl('question-options');
    host.innerHTML = '';
    host.setAttribute('role', q.multiple ? 'group' : 'radiogroup');
    q.options.forEach((/** @type {{ label: string, description?: string }} */ option) => {
      const chosen = slot.picks.includes(option.label);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `question__opt${q.multiple ? ' question__opt--many' : ''}`;
      button.setAttribute('role', q.multiple ? 'checkbox' : 'radio');
      button.setAttribute('aria-checked', String(chosen));
      const mark = document.createElement('span');
      mark.className = 'question__mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '✓';
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
      button.addEventListener('click', () => {
        if (q.multiple) {
          slot.picks = chosen ? slot.picks.filter((/** @type {string} */ p) => p !== option.label) : [...slot.picks, option.label];
        } else {
          // Pressing the chosen one again clears it, so a mis-tap is undoable
          // without a Clear button nobody would find.
          slot.picks = chosen ? [] : [option.label];
        }
        paintQuestion();
      });
      host.append(button);
    });

    const other = qOther();
    other.hidden = !q.other;
    other.placeholder = q.otherLabel || t('question.other');
    other.value = slot.other;

    const last = at === questions.length - 1;
    qBtn('question-go').textContent = answeredHere() ? (last ? t('question.done') : t('question.next')) : t('question.skip');
  }

  qOther().addEventListener('input', (event) => {
    if (!asking) return;
    asking.given[asking.at].other = /** @type {HTMLInputElement} */ (event.target).value;
    const last = asking.at === asking.questions.length - 1;
    qBtn('question-go').textContent = answeredHere() ? (last ? t('question.done') : t('question.next')) : t('question.skip');
  });

  const stepQuestion = (/** @type {number} */ by) => {
    if (!asking) return;
    asking.at = Math.max(0, Math.min(asking.questions.length - 1, asking.at + by));
    paintQuestion();
  };
  qBtn('question-prev').addEventListener('click', () => stepQuestion(-1));
  qBtn('question-next').addEventListener('click', () => stepQuestion(1));

  /**
   * Send what there is and let the turn carry on.
   *
   * Skipping is an answer, not a cancel: the tool result says plainly that the
   * question was declined and tells the model not to ask it again. An assistant
   * that re-asks what you just waved away is the thing that makes people stop
   * using it.
   */
  function sendAnswers() {
    if (!asking) return;
    const answers = { toolCallId: asking.toolCallId, given: asking.given };
    hideQuestion();
    onAnswer(answers);
  }

  qBtn('question-go').addEventListener('click', () => {
    if (!asking) return;
    if (asking.at < asking.questions.length - 1) return stepQuestion(1);
    sendAnswers();
  });
  qBtn('question-dismiss').addEventListener('click', () => {
    // Everything left empty, which reads as skipped for every question.
    if (asking) asking.given = asking.questions.map(() => ({ picks: [], other: '' }));
    sendAnswers();
  });

  return { show: showQuestion, hide: hideQuestion, showing: () => !!asking };
}
