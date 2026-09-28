import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * The Workflows shelf.
 *
 * A scheduled task is one instruction. A workflow is several, in order, where
 * each one may depend on what the last produced — and the reason it is a
 * separate thing rather than a longer prompt is that it **keeps its position**.
 * A deployment is cut off at 300 seconds; a workflow interrupted at step three
 * resumes at step three instead of sending the same email a second time.
 *
 * Which makes the per-step state the whole point of this screen. "It didn't
 * arrive" is answered here by naming the step that stopped and what it said,
 * rather than by one status line for a job with four parts.
 *
 * It lives in its own file rather than in `pages.js` because that file is
 * already the shell for three shelves; the shell is reused, the contents are
 * not pasted into it. Everything below is built from strings, and every value
 * that came from a person or a model goes through `escapeHtml`.
 */

/**
 * How a step reads on screen, and what it means.
 *
 * Keys, not sentences: an object literal calling `t()` is evaluated once at
 * import and would freeze this whole shelf in whichever language loaded first.
 */
const STEP_MARK = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✕',
  unknown: '?',
};

const stepLook = (status) => ({
  mark: STEP_MARK[status] || STEP_MARK.pending,
  say: t(`wf.step.${STEP_MARK[status] ? status : 'pending'}`),
});

const RUN_STATES = ['running', 'done', 'failed', 'needs_attention', 'cancelled'];

/** A run's status in words, or the raw status when the server invents a new one. */
const runSay = (status) => (RUN_STATES.includes(status) ? t(`wf.run.${status}`) : status);

const clip = (text, max = 140) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * @param blank      the shell's empty-state renderer
 * @param body       the shelf's container, for binding events after a render
 * @param toast      transient confirmation
 * @param openChat   go to the conversation a run wrote into
 * @param onLeave    close the shelf first
 * @param onDescribe start a blank conversation with a sentence begun
 * @param openForm   the create sheet, owned by the page shell
 * @param reload     re-run the shelf's own load
 */
/**
 * Workflows worth starting from, each one a job the tools here can carry out:
 * several stages where a later one needs what an earlier one found.
 * Getters, for the same reason as `stepLook` — a language switch must reach them.
 */
const IDEAS = ['digest', 'rivals', 'week'].map((key, i) => ({
  get name() {
    return t(`wf.idea.${key}.name`);
  },
  get what() {
    return t(`wf.idea.${key}.what`);
  },
  get when() {
    return t(`wf.idea.${key}.when`);
  },
  get steps() {
    return [1, 2, 3].map((n) => t(`wf.idea.${key}.s${n}`));
  },
  cron: ['08:00', 'mon 09:00', 'fri 16:00'][i],
  mark: ['☀', '◎', '▤'][i],
}));

/**
 * @param ideasHtml     the shell's suggestion buttons, shared with scheduled tasks
 * @param suggestedHtml the same under a "Suggested" heading
 */
export function workflowsView({
  blank,
  ideasHtml = /** @type {(ideas: object[]) => string} */ (() => ''),
  suggestedHtml = /** @type {(ideas: object[]) => string} */ (() => ''),
  body,
  toast,
  openChat,
  onLeave,
  onDescribe = /** @type {(starter?: string, mode?: string) => void} */ (() => onLeave()),
  openForm,
  /** One workflow in the side panel, to change or run. */
  openPane = /** @type {(id: string) => void} */ (() => {}),
  reload,
  onRunStarted = () => {},
}) {
  /**
   * A run continues after the request that started it returns.
   *
   * An invocation stops at its time budget and the next nudge carries on, so a
   * long workflow moves between steps with nothing on screen changing. Without
   * this the shelf shows the state it had when it was opened, and the honest
   * reading of a stale "step 2 of 4" is that the thing has hung.
   *
   * Only while something is actually running, only while the shelf is on
   * screen, and one timer at a time — a poll that outlives its page is a
   * request every few seconds for the rest of the session.
   */
  let poll = null;
  const stopPolling = () => {
    if (poll) clearTimeout(poll);
    poll = null;
  };

  return {
    /** The shell calls this when the shelf is left, so the timer dies with it. */
    onHide: stopPolling,
    get title() {
      return t('wf.title');
    },
    get newLabel() {
      return t('wf.new');
    },
    get orderLabel() {
      return t('pages.sortBy');
    },
    lede: t('wf.lede'),
    orders: [
      { id: 'recent', label: t('wf.order.recent') },
      { id: 'name', label: t('wf.order.name') },
    ],

    load: async () => (await api.workflows()).workflows,

    matches: (wf, q) =>
      `${wf.title} ${(wf.steps || []).map((s) => s.instruction).join(' ')}`.toLowerCase().includes(q),

    sort: (list, by) =>
      [...list].sort((a, b) =>
        by === 'name' ? a.title.localeCompare(b.title) : new Date(b.created_at) - new Date(a.created_at),
      ),

    newMenu: () => [
      {
        label: t('wf.describe'),
        icon: '💬',
        run: () => {
          onDescribe(t('wf.starter'), 'workflow');
          toast(t('wf.describeHint'));
        },
      },
      { label: t('wf.manual'), icon: '⚙', run: () => openForm() },
    ],

    render: (list) => {
      if (!list.length) {
        return blank(workflowMark, t('wf.none'), t('wf.noneHint')) + '<div class="blank__rule"></div>' + ideasHtml(IDEAS);
      }

      return (
        list
        .map((wf) => {
          const run = wf.lastRun;
          const steps = wf.steps || [];
          const state = run?.steps || [];

          const trail = steps
            .map((step, i) => {
              const status = state[i]?.status || 'pending';
              const look = stepLook(status);
              const why = state[i]?.error ? ` — ${clip(state[i].error, 120)}` : '';
              return `
                <li class="wf__step wf__step--${escapeHtml(status)}">
                  <span class="wf__step-mark" aria-hidden="true">${look.mark}</span>
                  <span class="wf__step-text">
                    ${escapeHtml(clip(step.instruction))}
                    <span class="wf__step-say">${escapeHtml(look.say)}${escapeHtml(why)}</span>
                  </span>
                </li>`;
            })
            .join('');

          const attention =
            run?.status === 'needs_attention'
              ? `<p class="wf__flag">${t('wf.interrupted')}</p>`
              : '';

          return `
        <div class="wf${wf.enabled ? '' : ' wf--off'}">
          <div class="wf__head">
            <div>
              <div class="wf__name">${escapeHtml(wf.title)}</div>
              <div class="wf__when">
                ${escapeHtml(wf.cron ? t('wf.everyCron', { cron: wf.cron }) : t('wf.onDemand'))}
                ${wf.enabled ? '' : ` · ${escapeHtml(t('wf.paused'))}`}
                ${run ? ` · ${escapeHtml(t('wf.lastRun', { status: runSay(run.status) }))}` : ` · ${escapeHtml(t('wf.neverRun'))}`}
              </div>
            </div>
            <div class="wf__acts">
              ${run?.chat_id ? `<button class="task__act" data-open="${escapeHtml(run.chat_id)}">${escapeHtml(t('wf.openResult'))}</button>` : ''}
              <button class="task__act" data-toggle="${escapeHtml(wf.id)}" data-on="${!!wf.enabled}">${
                wf.enabled ? t('wf.pause') : t('wf.resume')
              }</button>
              <button class="task__act" data-drop="${escapeHtml(wf.id)}">${escapeHtml(t('wf.remove'))}</button>
              <button class="icon-btn task__edit" data-edit="${escapeHtml(wf.id)}" type="button"
                      title="${escapeHtml(t('wf.edit'))}" aria-label="${escapeHtml(t('wf.edit'))}">✎</button>
            </div>
          </div>
          ${attention}
          <ol class="wf__steps">${trail}</ol>
        </div>`;
        })
        .join('') +
        // Still offered once there are workflows, as scheduled tasks do.
        suggestedHtml(IDEAS)
      );
    },

    wire: () => {
      // Re-wiring happens on every render, so the previous timer goes first or
      // they accumulate one per refresh.
      stopPolling();
      if (body.querySelector('.wf__step--running')) {
        poll = setTimeout(() => {
          poll = null;
          // Only if the shelf is still the thing on screen.
          if (body.isConnected && !body.closest('#page')?.hidden) {
            reload();
            onRunStarted();
          }
        }, 5000);
      }

      for (const button of body.querySelectorAll('[data-open]')) {
        button.addEventListener('click', () => {
          onLeave();
          openChat(button.dataset.open);
        });
      }

      // Changed in the side panel, where Run now also lives — the same as a
      // scheduled task, so the two shelves work one way.
      for (const button of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll('[data-edit]'))) {
        button.addEventListener('click', () => openPane(button.dataset.edit));
      }

      for (const button of body.querySelectorAll('[data-idea]')) {
        button.addEventListener('click', () => openForm(IDEAS[Number(button.dataset.idea)]));
      }

      for (const button of body.querySelectorAll('[data-toggle]')) {
        button.addEventListener('click', async () => {
          await api.updateWorkflow(button.dataset.toggle, { enabled: button.dataset.on !== 'true' });
          reload();
        });
      }

      for (const button of body.querySelectorAll('[data-drop]')) {
        // Two presses, the same as everywhere else on these shelves.
        let ready = false;
        const original = button.textContent;
        button.addEventListener('click', async () => {
          if (!ready) {
            ready = true;
            button.textContent = t('wf.removeConfirm');
            // The same red confirm a scheduled task's Delete shows.
            button.classList.add('is-armed');
            setTimeout(() => {
              ready = false;
              button.textContent = original;
              button.classList.remove('is-armed');
            }, 4000);
            return;
          }
          await api.deleteWorkflow(button.dataset.drop);
          reload();
        });
      }
    },

    onNew: () => openForm(),
  };
}

/**
 * The sheet that writes a new workflow. Changing one happens in the side panel
 * (`showScheduleInPane` in pages.js), where each field saves on its own.
 *
 * Steps are one per line in a textarea rather than a list of inputs with add and
 * remove buttons. Reordering four instructions is something a text editor is
 * already good at, and the row-based version is a great deal of interface to
 * maintain for the same result.
 *
 * It lives here rather than in `pages.js` so the whole feature is one file to
 * read — the shell only has to know how to open it.
 */
export function workflowForm({ toast, reload }) {
  const $ = (id) => document.getElementById(id);

  const sheet = () => $('workflow-form');

  /** @param preset a suggestion to start from: `{ name, steps, cron }` */
  function open(preset = null) {
    const workflow = preset ? { title: preset.name, steps: preset.steps.map((instruction) => ({ instruction })), cron: preset.cron } : null;

    $('workflow-form-title').textContent = t('wf.formCreate');
    $('workflow-form-name').value = workflow?.title || '';
    $('workflow-form-steps').value = (workflow?.steps || []).map((s) => s.instruction).join('\n');
    $('workflow-form-when').value = workflow?.cron || '';
    $('workflow-form-repeat').value = workflow?.cron ? 'repeat' : 'once';
    $('workflow-form-error').textContent = '';

    sheet().showModal();
    $('workflow-form-name').focus();
  }

  $('workflow-form-save').addEventListener('click', async () => {
    const button = $('workflow-form-save');
    const error = $('workflow-form-error');
    const steps = $('workflow-form-steps')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // Checked here as well as on the server, because the server's answer to an
    // empty workflow is a 400 and this is a nicer place to hear it.
    if (!steps.length) {
      error.textContent = t('wf.needStep');
      return;
    }

    button.disabled = true;
    try {
      const payload = {
        title: $('workflow-form-name').value.trim(),
        steps,
        when: $('workflow-form-when').value.trim(),
        repeat: $('workflow-form-repeat').value === 'repeat',
      };
      await api.createWorkflow(payload);

      sheet().close();
      toast(t('wf.created'));
      reload();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  $('workflow-form-cancel').addEventListener('click', () => sheet().close());

  return { open };
}

export const workflowMark =
  '<svg viewBox="0 0 40 40" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="4"/><circle cx="9" cy="31" r="4"/><circle cx="31" cy="20" r="4"/><path d="M13 9h8a4 4 0 0 1 4 4v3M13 31h8a4 4 0 0 0 4-4v-3"/></svg>';
