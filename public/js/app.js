import { api, runAgent } from './api.js';
import { follow } from './mirror.js';
import { createRuns } from './runs.js';
import { makeResizable } from './resize.js';
import { wireCopyButtons, escapeHtml } from './markdown.js';
import { cleanHtml, forWord, writeRich } from './clipboard.js';
import {
  assistantMessage,
  userMessage,
  statusLine,
  toast,
  summariseToolInput,
  revealInStrip,
  summaryDivider,
  stopNote,
  markdownOf,
} from './render.js';
import { createModelBrowser } from './models.js';
import { createScreen } from './screen.js';
import { createViewer } from './viewer.js';
import { shouldAutoPreview } from './autopreview.js';
import { createWorkspace } from './workspace.js';
import { createPages } from './pages.js';
import { createProjectPage, repeatsAs } from './project-page.js';
import { t, applyI18n, adoptLanguage, setLanguage, currentLanguage, LANGUAGES } from './i18n.js';
import { createOnboarding } from './onboarding.js';
import { humanSize, counted } from './format.js';
import { createAttachments } from './attachments.js';
import { createModelNews } from './model-news.js';
import { createDevices } from './devices.js';
import { createTwoFactor } from './two-factor.js';

// Before anything is drawn. The language is guessed from storage and the browser
// at module load, so the first paint is already right rather than a page of
// English that corrects itself a moment later.
applyI18n();
// The header title belongs to the script (it becomes the conversation's name),
// so it is not a data-i18n node — but before any chat opens it says "New chat".
document.getElementById('chat-title').textContent = t('nav.newChat');

/**
 * Opens a document, a spreadsheet, a deck or a running page without leaving the
 * conversation. An edit made in there changes a real file, so whatever is
 * listing files is told to look again.
 */
const viewer = createViewer({
  onChange: () => {
    if (pages.showing() === 'artifacts') pages.refresh();
  },
  /**
   * The rail holds one thing at a time.
   *
   * Opening a file has to open the rail if it was closed — otherwise pressing
   * a document does nothing visible — and has to hide the plan while it is
   * there, because a document and a checklist stacked in a 380px column is
   * neither of them.
   */
  onOpen: () => {
    setDetail(true);
    document.getElementById('app').classList.add('is-filepane');
  },
  onClose: () => document.getElementById('app').classList.remove('is-filepane'),
});

// Named to avoid shadowing the global window.screen.
const screenPanel = createScreen();

/**
 * The five-step guide, shown once to a new account.
 *
 * Wired here rather than inside `start()` because the callbacks reach into the
 * app — the key settings, the model picker, the composer — and those are the
 * things it exists to point at.
 */
const onboarding = createOnboarding({
  providers: () => state.boot?.providers || {},
  isFree: () => attachments.isFree(),
  onOpenKeys: () => openSettings('providers'),
  onPickModel: () => browser.open(state.model),
  onTryPrompt: (text) => setComposerText(text),
  // Nothing to persist here: the guide is marked as seen the moment it opens, not
  // when it is finished. See `markOnboarded`.
  onFinish: () => {},
});

/**
 * Remember that the guide has been shown — at the moment it opens.
 *
 * Recording it on *finish* was wrong, and wrong in the way that shows up in real
 * use: leaving halfway, or simply reloading the page, meant it had never finished,
 * so it opened again on the next visit. Somebody who has read enough of it to
 * close it has been shown it, and being shown it twice is the failure this is
 * meant to avoid.
 *
 * On the account rather than in local storage, so it does not reappear on their
 * phone. If the write fails the guide comes back next time, which is the right way
 * round for a failure nobody noticed.
 */
function markOnboarded() {
  if (state.boot.prefs.onboarded) return;
  state.boot.prefs.onboarded = true;
  api.savePrefs({ onboarded: true }).then(
    (prefs) => {
      state.boot.prefs = prefs;
    },
    () => {
      /* it will be offered once more, which is better than never being offered */
    },
  );
}

const $ = (id) => document.getElementById(id);

const state = {
  boot: null,
  chats: [],
  chatId: null,
  model: null,
  /** The project this conversation belongs to, when it belongs to one. */
  project: null,
  /** How full the model's window is, as last measured by the server. */
  context: null,
  /** Documents the assistant has made in this conversation, newest first. */
  files: [],
};

/**
 * Every conversation this tab is answering. See `public/js/runs.js` for why
 * this is a registry rather than a few fields on `state`.
 */
const runs = createRuns({ currentChatId: () => state.chatId });

/** The run for the conversation on screen, if it has one. */
const runHere = () => runs.here();

/** Whether this run's conversation is the one being looked at right now. */
const onScreen = (run) => runs.onScreen(run);

/**
 * The modes, in the order they are offered: from the one that gets on with it
 * to the one that touches nothing. `plan` sits beside `readonly` because it is
 * read-only with a job attached — look first, then say what you would do.
 */
const POLICIES = ['guarded', 'auto', 'ask', 'plan', 'readonly'];

/**
 * Looked up when drawn, not built at import.
 *
 * These were plain objects of English, which meant two things: the mode chip
 * sitting beside Send was untranslated on a Vietnamese account, and — had they
 * simply been wrapped in `t()` where they stand — they would have been resolved
 * at module load, before `bootstrap` reports the account's language, and then
 * never updated when it did. Functions, so every read is current.
 */
const POLICY_LABEL = (policy) => t(`policy.${policy}.label`);
const POLICY_HINT = (policy) => t(`policy.${policy}.hint`);

/**
 * A picture for each mode, on the chip and beside its row in the menu.
 *
 * Four words in a list are read once and then recognised by shape; the glyph is
 * what you actually navigate by afterwards. Each one says what the mode does
 * rather than how safe it is: a bolt for straight through, a raised palm for
 * stop and ask, a page for plan, an eye for look but do not touch.
 *
 * These are constants, never user input, so they go in as markup.
 */
const svg = (body) =>
  `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const POLICY_ICON = {
  guarded: svg('<path d="M11 2.5 4 11h5l-1 6.5L15 9h-5l1-6.5Z" />'),
  auto: svg('<path d="M2.5 4.5 9 10l-6.5 5.5V4.5Z" /><path d="M10.5 4.5 17 10l-6.5 5.5V4.5Z" />'),
  ask: svg(
    '<path d="M6.6 10.4V5.1a1.3 1.3 0 0 1 2.6 0v3.6" />' +
      '<path d="M9.2 8.7V4a1.3 1.3 0 0 1 2.6 0v4.7" />' +
      '<path d="M11.8 9V5.7a1.3 1.3 0 0 1 2.6 0v5.6c0 3.4-2 5.9-5.1 5.9-2.6 0-4.2-1.4-5.1-3.5L2.8 11a1.3 1.3 0 0 1 2.2-1.4l1.6 2.3" />',
  ),
  plan: svg(
    '<rect x="3.5" y="2.5" width="13" height="15" rx="2.2" />' +
      '<path d="M6.6 6.8h6.8M6.6 10h6.8M6.6 13.2h4.2" />',
  ),
  readonly: svg('<path d="M2 10s3.1-4.8 8-4.8S18 10 18 10s-3.1 4.8-8 4.8S2 10 2 10Z" /><circle cx="10" cy="10" r="2.1" />'),
};

/**
 * How hard the model is asked to think, five steps from cheap to careful.
 *
 * It lives in the mode menu as well as in settings because it is the other half
 * of the same decision: what the assistant is allowed to do, and how much
 * thought it puts into doing it. Reaching one and not the other meant opening a
 * settings sheet to change a number you were already thinking about.
 */
const EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `[id, label]` pairs, translated on every read — see POLICY_LABEL above. */
const efforts = () => EFFORT_IDS.map((id) => [id, t(`effort.${id}`)]);

const SUGGESTIONS = [
  t('suggest.workspace'),
  t('suggest.library'),
  t('suggest.todos'),
  t('suggest.tests'),
];

/* ── boot ──────────────────────────────────────────────────────── */

/** 'signin' | 'signup' | 'forgot' | 'reset' */
let gateMode = 'signin';
let session = null;
let resetToken = null;
/** Set once the server says this account has two-factor turned on. */
let needsTotp = false;

/** Strip a one-time token out of the URL so it is not left in history. */
function takeUrlToken(name) {
  const params = new URLSearchParams(location.search);
  const value = params.get(name);
  if (!value) return null;
  params.delete(name);
  const query = params.toString();
  history.replaceState({}, '', `${location.pathname}${query ? `?${query}` : ''}`);
  return value;
}

async function boot() {
  session = await api.session();

  resetToken = takeUrlToken('reset');
  if (resetToken) {
    gateMode = 'reset';
    showGate();
    return;
  }

  if (!session.authed) return showGate();
  await start();
}

const fail = (message) => {
  $('gate-error').hidden = false;
  $('gate-error').textContent = message;
};
const note = (message) => {
  $('gate-note').hidden = false;
  $('gate-note').textContent = message;
};

/* ── the gate: revealing passwords, remembering who you are ───────── */

/** Where "remember me" keeps the address it is remembering. */
const REMEMBERED_EMAIL = 'ai-remote:remembered-email';

const rememberedEmail = () => {
  try {
    return localStorage.getItem(REMEMBERED_EMAIL) || '';
  } catch {
    return ''; // Private browsing, or storage turned off. Not worth a warning.
  }
};

function rememberEmail(email) {
  try {
    if (email) localStorage.setItem(REMEMBERED_EMAIL, email);
    else localStorage.removeItem(REMEMBERED_EMAIL);
  } catch {
    /* see above */
  }
}

/**
 * Typing a long password blind is how people end up locked out of their own
 * account, so every password box gets an eye. It is a per-field toggle rather
 * than one switch for the form: revealing the box you are typing in should not
 * also uncover a different one.
 */
for (const button of /** @type {NodeListOf<HTMLElement>} */ (
  document.querySelectorAll('[data-reveal]')
)) {
  button.addEventListener('click', () => {
    const input = /** @type {HTMLInputElement} */ ($(button.dataset.reveal));
    setRevealed(input, input.type === 'password');
    input.focus();
    // Put the caret back at the end; switching type sends it to the front in
    // some browsers, which turns "let me check the last character" into a typo.
    const end = input.value.length;
    input.setSelectionRange?.(end, end);
  });
}

/**
 * @param {HTMLInputElement} input  the password box this eye belongs to
 * @param {boolean} revealed
 */
function setRevealed(input, revealed) {
  const button = /** @type {HTMLElement} */ (document.querySelector(`[data-reveal="${input.id}"]`));
  input.type = revealed ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(revealed));
  button.setAttribute('aria-label', revealed ? t('gate.hidePassword') : t('gate.showPassword'));
  button.title = revealed ? t('gate.hidePassword') : t('gate.showPassword');
}

function showGate() {
  $('gate').hidden = false;
  $('app').hidden = true;

  // With no users yet, creating the first account is the obvious default — but
  // it is only a default. Signing in stays one click away, because this screen
  // is also what someone sees if their session simply expired.
  if (session.needsSetup && gateMode === 'signin') gateMode = 'signup';

  const remembered = rememberedEmail();
  $('gate-email').value = remembered;
  $('gate-remember').checked = !!remembered;

  renderGateMode();
  // A remembered address means the only thing left to type is the password.
  if (gateMode === 'reset') $('gate-resetcode').focus();
  else if (remembered && gateMode === 'signin') $('gate-password').focus();
  else $('gate-email').focus();
}

function renderGateMode() {
  // Only treat the deployment as unclaimed while we are offering to claim it.
  // Once someone chooses "sign in", the first-run copy would just be confusing.
  const needsSetup = session.needsSetup && gateMode === 'signup';

  const signup = gateMode === 'signup';
  const forgot = gateMode === 'forgot';
  const reset = gateMode === 'reset';

  $('gate-sub').textContent = reset
    ? t('gate.sub.reset')
    : forgot
      ? t('gate.sub.forgot')
      : needsSetup
        ? t('gate.sub.first')
        : signup
          ? t('gate.sub.signup')
          : t('gate.sub.signin');

  // Reset needs the email (to find the account), the code, and a new password.
  // Following the emailed link fills the token in instead, so the code box hides.
  $('gate-accounts').hidden = false;
  $('gate-newpass').hidden = !reset;
  $('gate-resetcode').hidden = !!resetToken;
  $('gate-name').hidden = !signup;
  $('gate-email').hidden = false;
  $('gate-password-field').hidden = forgot || reset;
  $('gate-totp').hidden = !needsTotp || signup || forgot || reset;
  $('gate-password').autocomplete = signup ? 'new-password' : 'current-password';

  // Only sign-in offers to be remembered. Signing up already leaves you signed
  // in, and the reset screens are one-off errands on somebody else's schedule.
  $('gate-remember-row').hidden = !(gateMode === 'signin');

  // Never carry a revealed password across a mode change — the next screen is
  // often shown to explain something, and a password should not be part of it.
  setRevealed($('gate-password'), false);
  setRevealed($('gate-newpassword'), false);

  $('gate-submit').textContent = reset
    ? t('gate.submit.reset')
    : forgot
      ? t('gate.submit.forgot')
      : signup
        ? t('gate.submit.signup')
        : t('gate.submit.signin');

  // Always offer the other direction. Someone whose session expired lands here
  // too, and on a fresh deployment they would otherwise have no way through.
  // The one exception is a deployment that has closed registration — offering
  // a sign-up that will be refused is worse than not offering it.
  const canSignUp = session.signupOpen !== false || session.needsSetup;
  $('gate-switch').hidden = reset || (!signup && !forgot && !canSignUp);
  $('gate-switch').textContent =
    signup || forgot ? t('gate.switch.toSignin') : t('gate.switch.toSignup');
  $('gate-forgot').hidden = signup || forgot || reset;
}

function setGateMode(mode) {
  gateMode = mode;
  $('gate-error').hidden = true;
  $('gate-note').hidden = true;
  renderGateMode();
}

$('gate-switch').addEventListener('click', async () => {
  const goingToSignIn = gateMode !== 'signin';
  setGateMode(goingToSignIn ? 'signin' : 'signup');

  if (!goingToSignIn) return;

  // Re-check rather than trusting the flag from page load: an account may have
  // been created since — in another tab, or by someone else on this deployment.
  try {
    session = await api.session();
    renderGateMode();
    if (session.needsSetup) {
      note(t('gate.note.firstAccount'));
    }
  } catch {
    // Offline or the server restarted; the form still works, so say nothing.
  }
});

$('gate-forgot').addEventListener('click', () => setGateMode('forgot'));

$('gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('gate-error').hidden = true;
  $('gate-note').hidden = true;
  const submit = $('gate-submit');
  submit.disabled = true;

  try {
    if (gateMode === 'forgot') {
      await api.forgotPassword($('gate-email').value.trim());
      setGateMode('reset');
      // Deliberately identical whether or not the address exists.
      note(t('gate.note.resetSent'));
      submit.disabled = false;
      return;
    } else if (gateMode === 'reset') {
      await api.resetPassword({
        token: resetToken || undefined,
        code: resetToken ? undefined : $('gate-resetcode').value.trim(),
        email: $('gate-email').value.trim(),
        password: $('gate-newpassword').value,
      });
      resetToken = null;
      setGateMode('signin');
      note(t('gate.note.passwordUpdated'));
      submit.disabled = false;
      return;
    } else if (gateMode === 'signup') {
      const result = await api.register({
        name: $('gate-name').value.trim(),
        email: $('gate-email').value.trim(),
        password: $('gate-password').value,
      });
      if (result.emailBackend === 'console') {
        toast(t('gate.note.noMail'));
      }
    } else {
      const email = $('gate-email').value.trim();
      const remember = $('gate-remember').checked;
      await api.login({
        email,
        password: $('gate-password').value,
        code: $('gate-totp').value.trim() || undefined,
        remember,
      });
      // Only once the sign-in worked: remembering an address that was rejected
      // would just prefill the same mistake tomorrow.
      rememberEmail(remember ? email : '');
    }
    $('gate').hidden = true;
    await start();
  } catch (err) {
    // A second factor is a step, not a failure — reveal the box and keep going.
    if (err.code === 'totp_required') {
      needsTotp = true;
      renderGateMode();
      $('gate-totp').value = '';
      $('gate-totp').focus();
      fail(err.message);
    } else {
      needsTotp = false;
      renderGateMode();
      fail(err.message || t('gate.error.generic'));
    }
  } finally {
    submit.disabled = false;
  }
});

async function start() {
  $('app').hidden = false;
  state.boot = await api.bootstrap();

  // The account's choice wins over what was guessed from the browser. One repaint
  // if they differ, none if they agree — which is the common case, because the
  // guess is stored locally the moment it is made.
  adoptLanguage(state.boot.prefs.language);
  state.model = state.boot.prefs.defaultModel;
  refreshModelFacts();

  renderSuggestions();
  renderTopbar();
  renderWorker();
  fillSettings();
  // Where scheduled work actually runs differs between a local run and a
  // deployment, and the shelf says which rather than implying either.
  pages.configure({ localMachine: !!state.boot.runtime?.localMachine });

  // The opening screen is what you land on, so light its sky before anything
  // else decides otherwise. Opening a conversation immediately turns it off.
  setEmpty(true);

  await refreshChats();
  // Never fatal: a sidebar section that could not load is a missing list, not
  // a broken app, and throwing here would take the conversations with it.
  await refreshTasks().catch(() => {});

  /**
   * Keep the worker indicator honest without a websocket.
   *
   * Skipped while the tab is hidden. This fired every twenty seconds for the
   * life of every open tab, foreground or not, to decide the colour of one dot —
   * so a browser left with five background tabs made a request every four
   * seconds to tell nobody anything. Refreshed immediately on return, so the
   * dot is correct by the time it can be looked at.
   */
  setInterval(() => {
    if (!document.hidden) refreshWorker();
  }, 20_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshWorker();
  });

  /**
   * Nudge overdue scheduled tasks along, on a deployment only.
   *
   * Deliberately not awaited — it can take minutes and nothing here depends on
   * it. But it is a real request rather than something kicked off server-side,
   * because a serverless instance is frozen the moment it answers: holding the
   * connection open is what lets the work finish instead of being abandoned
   * halfway through, having already spent the tokens.
   */
  if (state.boot.runtime?.serverless) {
    /**
     * On a timer, not only once at startup.
     *
     * This used to fire exactly once, when the page loaded, and the only other
     * trigger was the daily cron — which on the free plan is all a deployment
     * gets, one tick a day. So a task set for 07:30 ran at 07:30 only if
     * somebody happened to open the app at 07:30; otherwise it waited for the
     * cron, which is what "it only runs again after 24 hours" was.
     *
     * A minute is the resolution a schedule is written at, so it is the
     * resolution worth checking at. The request is cheap when nothing is due —
     * one indexed lookup that returns nothing — and it is skipped entirely
     * while the tab is hidden, because a background tab is not a cron job and
     * pretending otherwise is how a laptop stays warm all night.
     */
    const sweep = () => {
      if (document.hidden) return;
      api.runDueTasks().catch(() => {
        /* best-effort; the daily cron is still the backstop */
      });
    };
    sweep();
    setInterval(sweep, 60_000);
    // And on return, because a tab left closed all morning has a schedule to
    // catch up on and waiting up to a minute to notice reads as nothing
    // happening.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sweep();
    });
  }

  // Arriving from the quick launcher: the conversation exists and the question
  // is already in it, so open it and pick up the run. The ids are stripped from
  // the URL on the way past — a reload should not re-run a finished turn.
  const handoff = takeUrlToken('chat');
  const shouldRun = takeUrlToken('run') === '1';
  if (handoff) {
    try {
      await openChat(handoff);
      if (shouldRun) await stream();
    } catch {
      toast(t('chat.openFailed'), 'error');
    }
  }

  /**
   * The guide, or the model announcement — never both.
   *
   * Two stacked modals on a first visit is worse than either alone, and the guide
   * is the one that matters to somebody who has just arrived: the announcement is
   * news about a catalogue they have not seen yet.
   *
   * Both wait until the app is usable behind them. A modal over a half-drawn
   * interface is a worse first impression than one a beat later.
   */
  if (!state.boot.prefs.onboarded) {
    onboarding.open();
    // Marked now rather than on finish: reloading the page or closing it halfway
    // is not a reason to be shown it all over again tomorrow.
    markOnboarded();
  } else modelNews.check();
}

/* ── chats ─────────────────────────────────────────────────────── */

/**
 * The conversation list, kept current while work runs in the background.
 *
 * A workflow or a scheduled task writes into a conversation nobody opened, from
 * a request this tab did not make, so nothing here would otherwise hear of it:
 * a run was halfway through its second step while the sidebar still said
 * "no conversations yet". So the list refreshes itself — every few seconds
 * while anything in it is running, every half-minute otherwise, never while
 * the tab is hidden, and at once when it comes back.
 *
 * A refresh that changes nothing does not touch the DOM, and none happens while
 * a conversation is being renamed or its menu is open: rebuilding the list
 * under somebody's cursor would throw away what they were typing.
 */
const CHAT_POLL_RUNNING_MS = 5_000;
const CHAT_POLL_IDLE_MS = 30_000;
let chatPoll = null;
let chatSignature = '';

function scheduleChatRefresh() {
  clearTimeout(chatPoll);
  const running = (state.chats || []).some((chat) => chat.running);
  chatPoll = setTimeout(() => {
    if (document.hidden) return scheduleChatRefresh();
    refreshChats({ background: true }).catch(() => scheduleChatRefresh());
  }, running ? CHAT_POLL_RUNNING_MS : CHAT_POLL_IDLE_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.boot) return;
  refreshChats({ background: true }).catch(() => {});
  /**
   * The scheduled list too, on the same moment rather than on a timer of its
   * own.
   *
   * A task is not only made from the form: the assistant schedules its own with
   * `schedule_task`, and a phone can make one while this tab sits open. Both
   * are "created elsewhere" as far as this window is concerned, and coming back
   * to the tab is the cheapest honest moment to find out — a second poll beside
   * the conversations would double the request traffic to keep a short list
   * fresh that nobody is watching while the tab is hidden.
   */
  refreshTasks().catch(() => {});
});

/**
 * Both side panels can be dragged, and put back with a double-click.
 *
 * Wired here rather than in `resize.js` so the module stays about one thing:
 * the behaviour of a handle, not which handles this app happens to have.
 */
makeResizable('sidebar', $('sidebar-grip'));
makeResizable('detail', $('detail-grip'));

const busyWithList = () => !!document.querySelector('#chat-list .chat-item--editing') || !$('row-menu').hidden;

/**
 * The work that runs on its own, listed above the conversations.
 *
 * Its own section because a scheduled task is not a conversation you had: it is
 * something that will happen, and the one thing worth seeing at a glance in a
 * sidebar is what the app is going to do without you. Drawn only when there is
 * at least one, so nobody is shown a heading over nothing.
 *
 * Never fatal. A sidebar section that could not load is a missing list, not a
 * broken app, and throwing here would take the conversations down with it.
 */
async function refreshTasks() {
  const host = $('sidebar-tasks');
  const { tasks } = await api.tasks();
  host.innerHTML = '';
  if (!tasks.length) return;

  host.append(Object.assign(document.createElement('div'), {
    className: 'chats__label',
    textContent: t('nav.scheduled'),
  }));

  for (const task of tasks) {
    const row = document.createElement('div');
    row.className = `chat-row${task.enabled ? '' : ' is-muted'}`;

    const btn = document.createElement('button');
    btn.className = 'chat-item';
    btn.textContent = task.title;
    btn.title = task.title;
    btn.addEventListener('click', () => {
      leavePages();
      pages.showTask(task.id).catch((err) => toast(err.message, 'error'));
    });

    // How often, rather than when next: a list is read for "what is set up
    // here", and the exact next timestamp is on the task's own page.
    const when = document.createElement('span');
    when.className = 'chat-row__when';
    when.textContent = repeatsAs(task);

    row.append(btn, when);
    host.append(row);
  }
}

/**
 * One conversation, as a row.
 *
 * The same row whether it is loose in the list or nested under a project, so
 * the two can never drift into looking like different kinds of thing — which
 * they are not. `nested` only indents it.
 */
function chatRow(chat, { nested = false } = {}) {
  const row = document.createElement('div');
  row.className = `chat-row${chat.id === state.chatId ? ' is-active' : ''}${nested ? ' chat-row--nested' : ''}`;
  // The row says which conversation it is. Nothing in the app needs it yet;
  // everything that wants to find one particular row does — and "the first
  // `.chat-row`" stopped meaning anything the moment projects came first.
  row.dataset.chat = chat.id;

  const btn = document.createElement('button');
  btn.className = 'chat-item';
  btn.textContent = chat.title || t('chat.untitled');
  btn.title = chat.title || t('chat.untitled');
  btn.addEventListener('click', () => openChat(chat.id));

  if (chat.pinned) {
    const pin = document.createElement('span');
    pin.className = 'chat-row__pin';
    pin.textContent = '📌';
    pin.title = t('chat.pinned');
    row.append(pin);
  }

  // A note to yourself that this one is not finished with. Nothing sets it
  // automatically — opening the conversation is what clears it.
  if (chat.unread) {
    const dot = document.createElement('span');
    dot.className = 'chat-row__unread';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', t('chat.unreadAria'));
    dot.title = t('chat.unreadAria');
    row.append(dot);
  }

  // Work happening in here is still tracked — `chat.running` keeps the list
  // refreshing quickly so a title appears as soon as it is written — but it
  // is no longer drawn. A pulsing dot beside a row the green bar had already
  // marked as the open one said nothing the composer's own spinner did not.
  if (chat.running) row.classList.add('is-running');

  const menu = document.createElement('button');
  menu.className = 'chat-row__menu';
  menu.type = 'button';
  menu.textContent = '⋮';
  menu.title = t('chat.more');
  menu.setAttribute('aria-label', t('chat.more'));
  menu.setAttribute('aria-haspopup', 'menu');
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    openRowMenu(chat, menu, btn);
  });

  row.append(btn, menu);
  return row;
}

/** A heading in the sidebar. */
const sidebarLabel = (text) =>
  Object.assign(document.createElement('div'), { className: 'chats__label', textContent: text });

/**
 * Which projects somebody has folded shut.
 *
 * Collapsed rather than open is the thing worth recording, because open is the
 * default: a sidebar that hides conversations until you find the right heading
 * to click is a sidebar that has lost the list it exists to be. Folding one is
 * a deliberate act; the rest stay where you can see them.
 *
 * Remembered across refreshes — the list is redrawn on a poll, and a section
 * that reopened itself every thirty seconds would be unusable. In memory rather
 * than stored: it is where you are, not a setting.
 */
const shutProjects = new Set();

/**
 * How many loose conversations the sidebar shows before offering the rest.
 *
 * Twenty is where a list you glance at becomes a list you scroll. Everything
 * past it is one press away, and in search and the Projects shelf regardless.
 */
const SIDEBAR_CHATS = 20;
let showingAllChats = false;

async function refreshChats({ background = false } = {}) {
  if (background && busyWithList()) return scheduleChatRefresh();
  const { chats, projects = [], groups = [] } = await api.chats();
  state.chats = chats;
  state.projects = projects;
  state.groups = groups;
  scheduleChatRefresh();

  const signature = JSON.stringify([
    state.chatId,
    currentLanguage(),
    [...shutProjects].sort(),
    showingAllChats,
    projects.map((p) => [p.id, p.name]),
    chats.map((c) => [c.id, c.title, c.pinned, c.running, c.project_id, c.unread, c.chat_group]),
  ]);
  if (background && signature === chatSignature) return;
  chatSignature = signature;

  const list = $('chat-list');
  list.innerHTML = '';

  /**
   * A project's conversations live under the project, not in the flat list.
   *
   * Mixed together, a project was a folder you could put things in and then
   * never see the inside of: the shelf knew what was filed where and the
   * sidebar — the thing actually used to move between conversations — did not.
   * So the projects come first, each a heading you can fold, and what is left
   * is everything that belongs to no project.
   */
  const byProject = new Map();
  for (const chat of chats) {
    if (!chat.project_id) continue;
    if (!byProject.has(chat.project_id)) byProject.set(chat.project_id, []);
    byProject.get(chat.project_id).push(chat);
  }

  // Only projects that have something in them. A column of empty headings is
  // the shelf's job, not the sidebar's.
  const filed = projects.filter((project) => byProject.has(project.id));
  if (filed.length) {
    list.append(sidebarLabel(t('nav.projects')));
    for (const project of filed) {
      const open = !shutProjects.has(project.id);
      const head = document.createElement('div');
      head.className = `proj-row${open ? ' is-open' : ''}`;

      const toggle = document.createElement('button');
      toggle.className = 'proj-row__name';
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.innerHTML =
        '<span class="proj-row__mark" aria-hidden="true">' +
        '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">' +
        '<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.5 1.8H16a1.5 1.5 0 0 1 1.5 1.5v6.7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5Z"/></svg></span>';
      toggle.append(Object.assign(document.createElement('span'), { textContent: project.name }));
      toggle.title = project.name;
      toggle.addEventListener('click', () => {
        if (shutProjects.has(project.id)) shutProjects.delete(project.id);
        else shutProjects.add(project.id);
        refreshChats().catch(() => {});
      });

      // The heading opens the project's own page, which is where its
      // instructions, sources and scheduled work are.
      const go = document.createElement('button');
      go.className = 'proj-row__open';
      go.type = 'button';
      go.textContent = '⋮';
      go.title = t('proj.openPage');
      go.setAttribute('aria-label', t('proj.openPage'));
      go.addEventListener('click', (event) => {
        event.stopPropagation();
        leavePages();
        projectPage.open(project.id);
      });

      head.append(toggle, go);
      list.append(head);

      if (open) for (const chat of byProject.get(project.id)) list.append(chatRow(chat, { nested: true }));
    }
  }

  const loose = chats.filter((chat) => !chat.project_id);
  if (!loose.length && !filed.length) {
    list.append(sidebarLabel(t('nav.noConversations')));
    return;
  }

  if (loose.length) {
    list.append(sidebarLabel(t('nav.conversationsLabel')));

    /**
     * Groups, where somebody has made one.
     *
     * A group is a name a person invented, so the set of them is whatever is
     * in use. Ungrouped conversations follow, without a heading of their own —
     * "Ungrouped" over the majority of the list is a label that says nothing.
     */
    const grouped = new Map();
    for (const chat of loose) {
      if (!chat.chat_group) continue;
      if (!grouped.has(chat.chat_group)) grouped.set(chat.chat_group, []);
      grouped.get(chat.chat_group).push(chat);
    }
    for (const name of [...grouped.keys()].sort()) {
      list.append(sidebarLabel(name));
      for (const chat of grouped.get(name)) list.append(chatRow(chat, { nested: true }));
    }

    /**
     * The twenty most recent, and a way to the rest.
     *
     * A sidebar is for getting back to what you were just doing, and past about
     * twenty rows it stops doing that — it becomes a list you scroll rather
     * than a place you glance. The order is by when something was last *said*:
     * pinning, archiving and grouping deliberately do not move a conversation
     * (see `updateChat`), because none of those mean the conversation moved on.
     *
     * Nothing is hidden — "show all" is one press, and everything is in the
     * Projects shelf and in search either way.
     */
    const flat = loose.filter((chat) => !chat.chat_group);
    const shown = showingAllChats ? flat : flat.slice(0, SIDEBAR_CHATS);
    for (const chat of shown) list.append(chatRow(chat));

    if (flat.length > SIDEBAR_CHATS) {
      const more = document.createElement('button');
      more.className = 'chats__more';
      more.type = 'button';
      more.textContent = showingAllChats
        ? t('nav.showFewer')
        : t('nav.showAll').replace('{n}', String(flat.length - SIDEBAR_CHATS));
      more.addEventListener('click', () => {
        showingAllChats = !showingAllChats;
        refreshChats().catch(() => {});
      });
      list.append(more);
    }
  }
}

/* ── the row menu ──────────────────────────────────────────────── */

const rowMenu = $('row-menu');
let closeRowMenu = () => {};

/* `svg` is the one defined near the top of this file — these are the same
   16×16 line drawings the policy chips use, at the same weight. */
const ICON = {
  pin: svg('<path d="M12.5 2.5 17.5 7.5l-2.6 1.2-3.4 3.4-.5 3.4-5.5-5.5 3.4-.5 3.4-3.4Z"/><line x1="7" y1="13" x2="3" y2="17"/>'),
  rename: svg('<path d="M13.5 2.9a1.9 1.9 0 0 1 2.7 2.7L7.8 14 4 15l1-3.8Z"/>'),
  trash: svg('<path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5 6 16.5h8l.5-11"/>'),
  copy: svg('<rect x="7" y="7" width="9.5" height="9.5" rx="1.8"/><path d="M13 4.5H5.3A1.8 1.8 0 0 0 3.5 6.3V14"/>'),
  unread: svg('<path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5S2.5 10 2.5 10Z"/><circle cx="10" cy="10" r="2"/><line x1="3.5" y1="16.5" x2="16.5" y2="3.5"/>'),
  folder: svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.5 1.8H16a1.5 1.5 0 0 1 1.5 1.5v6.7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5Z"/>'),
  unfile: svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.5 1.8H16a1.5 1.5 0 0 1 1.5 1.5v6.7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5Z"/><line x1="4" y1="16" x2="16" y2="4"/>'),
  archive: svg('<rect x="3" y="4" width="14" height="4" rx="1"/><path d="M4.5 8v7A1.5 1.5 0 0 0 6 16.5h8A1.5 1.5 0 0 0 15.5 15V8"/><line x1="8.5" y1="11" x2="11.5" y2="11"/>'),
  window: svg('<rect x="3" y="4.5" width="14" height="11" rx="1.8"/><path d="M3 8h14"/>'),
  clock: svg('<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.6 1.6"/>'),
};

/**
 * One menu element, refilled per row.
 *
 * Deliberately not `prompt()` and `confirm()`, which is what this used to be:
 * browsers suppress those after a few uses and the click then appears to do
 * nothing at all. Renaming happens inline in the row and deleting asks for a
 * second click on the menu item itself, so nothing here depends on the browser
 * agreeing to show a dialog.
 */
/**
 * Everything you can do to one conversation, in one place.
 *
 * Built from a description rather than by hand for each of the two callers —
 * the ⋮ on a sidebar row, and the chevron beside the title — because they are
 * the same list of things and two hand-written copies is how one of them ends
 * up missing "Remove from project" for a year.
 *
 * Whether a conversation is filed under a project decides three of the entries,
 * and that is the only difference between the two menus.
 */
function chatMenuItems(chat, { titleButton = null, onDone = async () => refreshChats() } = {}) {
  const patch = async (body, said) => {
    closeRowMenu();
    try {
      await api.updateChat(chat.id, body);
      await onDone();
      if (said) toast(said);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const items = [];

  if (titleButton === null) {
    // From the title chevron: the conversation is already open, so "schedule
    // something like this" is the useful thing to offer and "rename" reaches
    // the title in place.
    items.push({
      label: t('chat.schedule'),
      icon: ICON.clock,
      run: () => {
        closeRowMenu();
        leavePages();
        pages.newTask({
          project: chat.project_id ? state.projects?.find((p) => p.id === chat.project_id) : null,
          after: async () => refreshTasks().catch(() => {}),
        });
      },
    });
  } else {
    /**
     * A second window on the same conversation.
     *
     * Claude's desktop app offers this and it is genuinely useful here for the
     * same reason: two conversations side by side. It is a real second tab, so
     * the run lease keeps them honest — one drives, the other mirrors.
     */
    items.push({
      label: t('chat.openWindow'),
      icon: ICON.window,
      run: () => {
        closeRowMenu();
        window.open(`${location.pathname}?chat=${encodeURIComponent(chat.id)}`, '_blank', 'noopener');
      },
    });
  }

  items.push({
    label: t('chat.copyId'),
    icon: ICON.copy,
    run: async () => {
      closeRowMenu();
      try {
        await navigator.clipboard.writeText(chat.id);
        toast(t('chat.idCopied'));
      } catch {
        // A browser that refuses the clipboard without a gesture it recognises.
        // Showing the id is a worse answer than nothing at all is.
        toast(chat.id);
      }
    },
  });

  items.push({ separator: true });

  items.push({
    label: chat.pinned ? t('chat.unpin') : t('chat.pin'),
    icon: ICON.pin,
    key: 'P',
    run: () => patch({ pinned: !chat.pinned }),
  });

  if (titleButton !== null) {
    items.push({
      label: t('chat.markUnread'),
      icon: ICON.unread,
      key: 'U',
      run: () => patch({ unread: !chat.unread }),
    });
    items.push({
      label: t('chat.rename'),
      icon: ICON.rename,
      key: 'R',
      run: () => {
        closeRowMenu();
        startRename(chat, titleButton);
      },
    });
  } else {
    items.push({
      label: t('chat.rename'),
      icon: ICON.rename,
      key: 'R',
      run: () => {
        closeRowMenu();
        renameFromTitle(chat);
      },
    });
  }

  items.push({
    label: t('chat.changeProject'),
    icon: ICON.folder,
    submenu: 'project',
    run: () => {},
  });

  // Only offered when there is something to remove it from. An entry that does
  // nothing is worse than an absent one: it is a thing you try and learn from.
  if (chat.project_id) {
    items.push({
      label: t('chat.removeFromProject'),
      icon: ICON.unfile,
      run: () => patch({ projectId: null }, t('chat.removedFromProject')),
    });
  }

  if (titleButton !== null) {
    items.push({ label: t('chat.moveToGroup'), icon: ICON.folder, submenu: 'group', run: () => {} });
  }

  items.push({ separator: true });

  /**
   * Archive before Delete, and they are different things.
   *
   * The distinction matters precisely because they sit together: archiving is
   * what somebody reaches for when they are not sure, and it has to genuinely
   * be reversible or the pair is a trap.
   */
  items.push({
    label: t('chat.archive'),
    icon: ICON.archive,
    key: 'A',
    run: () => patch({ archived: true }, t('chat.archived')),
  });

  items.push({
    label: t('chat.delete'),
    icon: ICON.trash,
    key: 'D',
    danger: true,
    arm: t('action.reallyDelete'),
    run: async () => {
      closeRowMenu();
      try {
        await api.deleteChat(chat.id);
        if (chat.id === state.chatId) {
          state.chatId = null;
          $('messages').innerHTML = '';
          $('chat-title').textContent = t('nav.newChat');
          setEmpty(true);
          hideApproval();
        }
        await refreshChats();
        toast(t('chat.deleted'));
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  });

  return items;
}

/**
 * A second panel beside the menu, for the two entries that open one.
 *
 * Its own element rather than replacing the menu's contents, because both are
 * on screen at once in the design this follows — you can see which project you
 * are moving out of while you choose the one to move into.
 */
const subMenu = (() => {
  const node = document.createElement('div');
  node.className = 'menu menu--sub';
  node.hidden = true;
  node.setAttribute('role', 'menu');
  document.body.append(node);
  return node;
})();

function closeSubMenu() {
  subMenu.hidden = true;
  subMenu.innerHTML = '';
}

/** Put the panel beside the item that opened it, and inside the window. */
function placeSubMenu(anchor) {
  subMenu.hidden = false;
  const box = anchor.getBoundingClientRect();
  const size = subMenu.getBoundingClientRect();
  // Beside the menu if it fits, and flipped to its left if it does not — a
  // panel half off the right edge is how this looks broken on a laptop.
  const right = box.right + 4;
  const left = right + size.width > window.innerWidth - 8 ? box.left - size.width - 4 : right;
  const top = Math.min(box.top, window.innerHeight - size.height - 8);
  subMenu.style.left = `${Math.max(8, left)}px`;
  subMenu.style.top = `${Math.max(8, top)}px`;
}

/**
 * Which project this conversation belongs to.
 *
 * Searchable, and the search doubles as the way to make a new one: typing a
 * name nothing matches offers to create it. That is the whole reason the field
 * says "Search or create" — a separate "New project" entry would be a second
 * road to the same place, and the one nobody uses goes stale.
 */
function openProjectPicker(chat, anchor) {
  closeSubMenu();
  subMenu.innerHTML = '';

  const find = document.createElement('input');
  find.type = 'text';
  find.className = 'menu__find';
  find.placeholder = t('chat.searchOrCreateProject');
  find.setAttribute('aria-label', t('chat.searchOrCreateProject'));
  subMenu.append(find);

  const list = document.createElement('div');
  list.className = 'menu__list';
  subMenu.append(list);

  const move = async (projectId, said) => {
    closeSubMenu();
    closeRowMenu();
    try {
      await api.updateChat(chat.id, { projectId });
      // If that project was folded shut, open it — otherwise the conversation
      // appears to have vanished rather than moved.
      if (projectId) shutProjects.delete(projectId);
      await refreshChats();
      // The open conversation's own header names its project.
      if (chat.id === state.chatId) await openChat(chat.id);
      toast(said);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const paint = () => {
    const needle = find.value.trim();
    const lower = needle.toLowerCase();
    const shown = (state.projects || []).filter((p) => !lower || p.name.toLowerCase().includes(lower));
    list.innerHTML = '';

    for (const project of shown) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'menu__item';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(project.id === chat.project_id));
      row.innerHTML =
        `<span>${escapeHtml(project.name)}</span>` +
        (project.id === chat.project_id ? '<span class="menu__tick">✓</span>' : '');
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        if (project.id === chat.project_id) return closeSubMenu();
        move(project.id, t('chat.movedToProject').replace('{name}', project.name));
      });
      list.append(row);
    }

    // Nothing matched what was typed, so offer to make it. Never for an empty
    // box: "create" with no name is a project called nothing.
    const exact = (state.projects || []).some((p) => p.name.toLowerCase() === lower);
    if (needle && !exact) {
      const make = document.createElement('button');
      make.type = 'button';
      make.className = 'menu__item menu__item--make';
      make.innerHTML = `<span>${escapeHtml(t('chat.createProject').replace('{name}', needle))}</span>`;
      make.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          const { project } = await api.createProject({ name: needle });
          await move(project.id, t('chat.movedToProject').replace('{name}', project.name));
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      list.append(make);
    }

    if (!shown.length && !needle) {
      list.append(Object.assign(document.createElement('p'), {
        className: 'menu__empty',
        textContent: t('chat.noProjects'),
      }));
    }
  };

  paint();
  find.addEventListener('input', paint);
  find.addEventListener('click', (event) => event.stopPropagation());
  find.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeSubMenu();
    }
  });

  placeSubMenu(anchor);
  find.focus();
}

/**
 * Which group this conversation sits under.
 *
 * A group is a name somebody invented, and the set of them is whatever is in
 * use — so this lists what exists and offers to start a new one. There is no
 * empty group to clean up because there is no such thing: moving the last
 * conversation out of a group is what ends it.
 */
function openGroupPicker(chat, anchor) {
  closeSubMenu();
  subMenu.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'menu__list';
  subMenu.append(list);

  const move = async (name) => {
    closeSubMenu();
    closeRowMenu();
    try {
      await api.updateChat(chat.id, { group: name });
      await refreshChats();
      toast(name ? t('chat.movedToGroup').replace('{name}', name) : t('chat.leftGroup'));
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  for (const name of state.groups || []) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'menu__item';
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(name === chat.chat_group));
    row.innerHTML = `<span>${escapeHtml(name)}</span>${name === chat.chat_group ? '<span class="menu__tick">✓</span>' : ''}`;
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      move(name === chat.chat_group ? null : name);
    });
    list.append(row);
  }

  const make = document.createElement('button');
  make.type = 'button';
  make.className = 'menu__item menu__item--make';
  make.innerHTML = `<span>${escapeHtml(t('chat.newGroup'))}</span>`;
  make.addEventListener('click', (event) => {
    event.stopPropagation();
    // Typed in place rather than in a dialog: this is one short name, and a
    // modal for it would be heavier than the thing it is asking for.
    make.innerHTML = '';
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'menu__find';
    field.placeholder = t('chat.groupName');
    field.setAttribute('aria-label', t('chat.groupName'));
    field.addEventListener('click', (e) => e.stopPropagation());
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && field.value.trim()) move(field.value.trim());
      if (e.key === 'Escape') closeSubMenu();
    });
    make.append(field);
    field.focus();
  });
  list.append(make);

  placeSubMenu(anchor);
  /** @type {HTMLElement} */ (list.firstElementChild)?.focus();
}

/** Rename from the title chevron, where there is no row input to grow. */
function renameFromTitle(chat) {
  const next = window.prompt(t('chat.rename'), chat.title || '');
  if (next === null) return;
  const title = next.trim();
  if (!title || title === chat.title) return;
  api
    .updateChat(chat.id, { title })
    .then(async () => {
      if (chat.id === state.chatId) $('chat-title').textContent = title;
      await refreshChats();
    })
    .catch((err) => toast(err.message, 'error'));
}

function openRowMenu(chat, anchor, titleButton) {
  closeRowMenu();

  const item = (spec) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `menu__item${spec.danger ? ' menu__item--danger' : ''}`;
    el.setAttribute('role', 'menuitem');
    el.innerHTML =
      `${spec.icon || ''}<span>${escapeHtml(spec.label)}</span>` +
      (spec.submenu ? '<span class="menu__more" aria-hidden="true">›</span>' : '') +
      (spec.key ? `<span class="menu__key">${spec.key}</span>` : '');
    if (spec.submenu) el.setAttribute('aria-haspopup', 'menu');

    let armed = false;
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      // Two clicks rather than a confirm() the browser might swallow. The label
      // changing in place is also a clearer warning than a dialog you dismiss.
      if (spec.arm && !armed) {
        armed = true;
        el.querySelector('span').textContent = spec.arm;
        return;
      }
      if (spec.submenu === 'project') return openProjectPicker(chat, el);
      if (spec.submenu === 'group') return openGroupPicker(chat, el);
      spec.run(el);
    });
    return el;
  };

  rowMenu.innerHTML = '';
  for (const spec of chatMenuItems(chat, { titleButton })) {
    if (spec.separator) {
      rowMenu.append(Object.assign(document.createElement('div'), { className: 'menu__sep' }));
      continue;
    }
    rowMenu.append(item(spec));
  }

  // Place it beside the button, then pull it back inside the viewport rather
  // than letting it hang off the edge on a short window or a phone.
  rowMenu.hidden = false;
  const box = anchor.getBoundingClientRect();
  const size = rowMenu.getBoundingClientRect();
  const left = Math.min(box.left, window.innerWidth - size.width - 8);
  const below = box.bottom + 6;
  const top = below + size.height > window.innerHeight - 8 ? box.top - size.height - 6 : below;
  rowMenu.style.left = `${Math.max(8, left)}px`;
  rowMenu.style.top = `${Math.max(8, top)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  rowMenu.querySelector('.menu__item')?.focus();

  const onKey = (event) => {
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') return closeRowMenu();

    // Up and Down move between the items. This menu had letter shortcuts and
    // nothing else, so the only way through it was the three letters somebody
    // had to already know about.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = [...rowMenu.querySelectorAll('.menu__item')];
      if (!items.length) return;
      const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const step = event.key === 'ArrowDown' ? 1 : -1;
      event.preventDefault();
      /** @type {HTMLElement} */ (items[(at + step + items.length) % items.length]).focus();
      return;
    }
    /**
     * The letters, matched against what each item says it answers to.
     *
     * This was a map of fixed positions — `{ p: 0, r: 1, d: 3 }` — which was
     * right for a three-item menu and silently wrong the moment the menu grew:
     * `d` stopped meaning Delete and started meaning whatever had landed in
     * slot three. Reading the key off the item itself cannot drift.
     */
    if (event.metaKey || event.ctrlKey) return;
    const hit = [...rowMenu.querySelectorAll('.menu__item')].find(
      (el) => el.querySelector('.menu__key')?.textContent?.toLowerCase() === key,
    );
    if (!hit) return;
    event.preventDefault();
    /** @type {HTMLElement} */ (hit).click();
  };
  // Capture, so a click on the menu itself does not immediately close it. The
  // panel beside it counts as inside: choosing a project is not leaving.
  const onOutside = (event) => {
    if (!rowMenu.contains(event.target) && !subMenu.contains(event.target)) closeRowMenu();
  };

  closeRowMenu = () => {
    closeSubMenu();
    rowMenu.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onOutside);
    window.removeEventListener('resize', closeRowMenu);
    closeRowMenu = () => {};
    // Back to the ⋯ button rather than to <body>, which on a conversation list
    // means restarting from the top of the sidebar.
    if (anchor.isConnected && (!document.activeElement || document.activeElement === document.body)) {
      anchor.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onOutside);
  window.addEventListener('resize', closeRowMenu);
}

/**
 * Make a button ask before it fires, without a browser dialog.
 *
 * `confirm()` looks like the obvious tool and is a trap: browsers suppress it
 * after a few uses in a session, and from then on the destructive button
 * silently does nothing — which is exactly how the conversation menu broke.
 * Changing the label in place is also a clearer warning than a dialog people
 * dismiss by reflex.
 */
function armed(button, warning, run) {
  let ready = false;
  const original = button.textContent;

  const reset = () => {
    ready = false;
    button.textContent = original;
    button.classList.remove('is-armed');
    // Only a live region while it is asking. A button that stays one would
    // announce its own label every time anything rewrote it.
    button.removeAttribute('aria-live');
  };

  button.addEventListener('click', async () => {
    if (!ready) {
      ready = true;
      button.textContent = warning;
      button.classList.add('is-armed');
      /**
       * Say that the button changed its mind.
       *
       * The label going from "Delete" to "Really delete?" is the whole safety
       * mechanism, and it was silent: a screen reader had already announced the
       * button when it was pressed, and changing the text of a control that is
       * not in a live region announces nothing. So the first press appeared to
       * do nothing and the second one deleted.
       *
       * The button becomes its own polite live region while it is armed, which
       * announces the new label without moving focus, and stops being one when
       * it resets so an idle button is not a region for ever.
       */
      button.setAttribute('aria-live', 'polite');
      setTimeout(reset, 5000); // an unanswered warning should not linger
      return;
    }
    reset();
    try {
      await run();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  button.addEventListener('blur', reset);
}

/** Turn the row's title into a text field. Enter commits, Escape abandons. */
function startRename(chat, titleButton) {
  const input = document.createElement('input');
  input.className = 'chat-item chat-item--editing';
  input.value = chat.title || '';
  titleButton.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const title = input.value.trim();
    if (!commit || !title || title === chat.title) return refreshChats();
    try {
      await api.updateChat(chat.id, { title });
      if (chat.id === state.chatId) $('chat-title').textContent = title;
    } catch (err) {
      toast(err.message, 'error');
    }
    await refreshChats();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * Put the conversation back, whatever was standing in for it.
 *
 * Two things can occupy that space — a shelf and one project's page — and they
 * are separate elements, so hiding only the one you happen to be thinking about
 * leaves the other drawn over the transcript. Every route back goes through
 * here rather than remembering both.
 */
function leavePages() {
  projectPage.hide();
  pages.hide();
}

/** The reverse: a shelf or a project page takes the conversation's place. */
function gotoShelf(which) {
  projectPage.hide();
  pages.show(which);
}

/**
 * Take the run off screen without touching it.
 *
 * Navigating away used to *abort* the stream. That was the right fix for a real
 * bug — the handlers appended to `#messages` by name, so the old run's prose,
 * its stop notes, its compaction dividers and its tool cards were grafted into
 * whichever conversation was now on screen — and the wrong shape for the app.
 * Aborting closes the socket, the server sees `res.on('close')` and ends the
 * run, so glancing at another conversation killed the work. What the person saw
 * on their return was a transcript frozen mid-thought, no sign of whether
 * anything was still happening, and then the whole finished answer appearing at
 * once minutes later when something happened to reload it.
 *
 * Now a run owns its own `stage` and every handler draws into that. Detaching
 * the stage removes it from the page and changes nothing else: the fetch stays
 * open, the lease stays held, the model keeps working, and `showStage` puts it
 * back — mid-sentence, still streaming — when they return. Two conversations
 * can be working at once because neither can reach the other's nodes.
 */
function hideRun() {
  runs.hide(runHere());
}

/** Put a run's nodes on screen, if its conversation is the one being shown. */
function showStage(run) {
  runs.show(run, $('messages'));
}

async function openChat(id) {
  hideRun();
  closeSidebar();
  // A conversation replaces whichever shelf was on screen.
  leavePages();
  // Files were staged for the conversation you were in, not this one. Carrying
  // them across would attach a screenshot to a completely unrelated question.
  clearStaged();
  const { chat, messages, pendingApproval, context, project, files } = await api.chat(id);
  state.chatId = id;
  // Not `chat.model`. There is one model for the whole app, so a conversation
  // opened today runs on whatever is chosen today — the stored value is history
  // of what it was created with, not a second setting competing with this one.
  state.model = state.boot.prefs.defaultModel;
  state.project = project || null;
  state.files = files || [];
  renderFilesChip();
  /**
   * Deliberately no `clearQueue()` here.
   *
   * The queue used to be one list on `state`, so arriving in a conversation had
   * to wipe whatever was typed into the last one. It now belongs to the run it
   * was typed into, which is both more correct and the only thing that works
   * with two conversations answering at once: a line queued in one must still
   * be there, and still be deliverable, after a glance at the other.
   * `renderQueue()` below draws whichever list belongs to this conversation.
   */
  // Opening a stored conversation abandons the blank one you were sitting in.
  state.pendingProject = null;
  refreshModelFacts();
  renderProjectChip();

  $('chat-title').textContent = chat.title || t('chat.untitled');
  setEmpty(messages.length === 0);
  renderTopbar();

  const host = $('messages');

  /**
   * Do not read the whole conversation out again.
   *
   * `#messages` is `aria-live="polite"`, which is right for the one thing it is
   * there for — a reply arriving a token at a time while the person waits. It
   * is wrong for this, where the entire transcript is torn down and rebuilt:
   * every message counts as an addition, so opening a chat announced all of it,
   * from the top, every time.
   *
   * `aria-busy` is the mechanism for exactly this. Assistive technology holds
   * off while it is true and takes the finished result as one change, rather
   * than narrating the construction.
   */
  host.setAttribute('aria-busy', 'true');
  host.innerHTML = '';

  // Tool results live in their own message, so index them by call id first.
  const resultsByCallId = new Map();
  for (const m of messages) {
    if (m.role === 'tool') for (const r of m.results || []) resultsByCallId.set(r.toolCallId, r);
  }

  for (const m of messages) {
    if (m.role === 'user') host.append(userMessage(m.text, m.attachments || [], m.id));
    else if (m.role === 'summary') host.append(summaryDivider(m.replaced || 0, m.text));
    else if (m.role === 'assistant') host.append(assistantMessage().hydrate(m, resultsByCallId).node);
  }

  /**
   * If this conversation is mid-answer in this tab, its live nodes go back on
   * the end — still streaming, exactly where they were.
   *
   * This is what makes leaving and coming back free. The run never stopped; its
   * stage was simply not in the document. Appended *after* the stored
   * transcript because that is where it belongs: the turn in flight is the last
   * thing in the conversation.
   *
   * The stored messages above may already include turns this run has finished
   * and persisted — `message` events seal a block and the server writes it — so
   * the stage is pruned of anything now duplicated by the database before it
   * goes back up. Whatever is still streaming has no stored copy yet and stays.
   */
  const live = runs.get(id);
  if (live) {
    for (const node of [...live.stage.children]) {
      if (node !== live.turn?.node) node.remove();
    }
    showStage(live);
  }

  // Built. Anything appended from here — a streaming reply — is announced
  // normally, which is what the live region exists for.
  host.setAttribute('aria-busy', 'false');

  // The composer, the stop button and the status line all describe whatever is
  // happening in *this* conversation, which may be nothing or may be a turn
  // that has been running since before you left.
  setRunning(!!live);
  setStatus(live ? live.status : null);
  renderQueue();

  // Whether this conversation is actually waiting on a yes is a question about
  // the risk rules and the account's policy, both of which live on the server —
  // so it answers it. Deciding here meant showing an approval bar for calls that
  // would never have been gated, under "auto" and "read-only" alike.
  if (pendingApproval?.length) showApproval(pendingApproval);
  else hideApproval();

  // The rail should describe *this* conversation, so rebuild it from the last
  // plan in the transcript rather than leaving the previous chat's steps up.
  const lastPlan = [...messages]
    .reverse()
    .flatMap((m) => m.toolCalls || [])
    .find((c) => c.name === 'update_plan');
  renderProgress(lastPlan?.input?.steps || []);
  renderContext(context);
  // The token line describes the turn that just ran, and no turn has run in
  // this conversation yet — the previous chat's number is not this one's.
  renderUsage({ input: 0, output: 0, cost: 0, priced: false });
  resetDetailAutoOpen();

  await refreshChats();
  scrollToEnd();
}

/**
 * A blank conversation that does not exist yet.
 *
 * Pressing New chat used to create a row immediately, so opening the app and
 * changing your mind left "New chat" in the sidebar forever — and doing it a
 * few times left a column of identical ones. Nothing is stored until the first
 * message; the send path already created the very first conversation that way,
 * so this is the same road for every one after it.
 */
function startBlankChat(project = null) {
  // Same reason as `openChat`: the run carries on, but its nodes come off the
  // page so they are not sitting in the blank conversation now on screen.
  hideRun();
  setRunning(false);
  setStatus(null);
  leavePages();
  clearStaged();
  state.chatId = null;
  state.pendingProject = project;
  state.project = project;
  state.files = [];
  renderContext(null);
  renderProjectChip();
  renderFilesChip();
  // A conversation that does not exist yet cannot have a run, so there is no
  // queue to draw — but the composer may still be showing the last one's.
  renderQueue();

  /**
   * Everything that described the last conversation, cleared.
   *
   * A conversation is its own context on the server — a new one starts with
   * nothing behind it — but the interface was still showing the previous one's
   * numbers: the token count for its last turn, and the plan it was working
   * through. Both only changed once a new turn produced new ones, so a fresh
   * chat looked like a continuation of the old one until you sent something,
   * which is a reasonable thing to conclude from what was on the screen and
   * completely wrong.
   */
  renderUsage({ input: 0, output: 0, cost: 0, priced: false });
  renderProgress([]);
  resetDetailAutoOpen();

  $('messages').innerHTML = '';
  $('status-host').innerHTML = '';
  hideApproval();
  $('chat-title').textContent = project ? t('chat.newIn', { project: project.name }) : t('nav.newChat');
  setEmpty(true);
  // Nothing in the sidebar is selected any more, because what you are looking
  // at is not in it.
  for (const row of document.querySelectorAll('.chat-row.is-active')) row.classList.remove('is-active');
  $('input').focus();
}

$('new-chat').addEventListener('click', () => {
  closeSidebar();
  startBlankChat();
});

/**
 * Say which project this conversation answers under.
 *
 * A grounded answer and an ordinary one look identical on the page, so the one
 * place the difference can live is the header. The count is the useful part:
 * "0 sources" explains an assistant that says it has nothing to go on far
 * better than any error message would.
 */
function renderProjectChip() {
  const chip = $('project-chip');
  const project = state.project;
  chip.hidden = !project;
  if (!project) return;

  chip.textContent = project.name;
  chip.classList.toggle('is-grounded', !!project.grounded);
  chip.title = project.files
    ? t('chat.sourceCount', {
        how: project.grounded ? t('chat.answersFrom') : t('chat.answersFirstFrom'),
        sources: counted(project.files, 'chat.sources'),
        project: project.name,
      })
    : t('chat.noSources', { project: project.name });
}

$('project-chip').addEventListener('click', () => {
  if (state.project) projectPage.open(state.project.id);
});

/**
 * The documents made in this conversation.
 *
 * The card in the transcript is where a file is born and where you look for it
 * five seconds later. An hour and forty turns later it is somewhere above, and
 * scrolling for it is not a feature — hence a chip that always knows.
 */
function renderFilesChip() {
  const chip = $('files-chip');
  const files = state.files || [];
  chip.hidden = !files.length;
  if (!files.length) return;

  chip.textContent = files.length === 1 ? t('chat.filesOne') : t('chat.files', { n: files.length });
  chip.title = files.map((file) => file.name).join('\n');
}

/** Remember a file the run just produced, replacing an earlier version of it. */
/**
 * Hand the sent bubble over to the server's copy, and let the blobs go.
 *
 * The optimistic bubble is drawn from local `blob:` previews, because the
 * server copy is not fetchable until the message exists — that part is
 * deliberate and stays. What was missing is the other half: once the send
 * succeeds those previews are never needed again, and nothing revoked them.
 * `clearStaged`, `clearQueue` and the queue-drop handler all revoke correctly;
 * the *sent* bubble simply kept its URLs, and `openChat` then dropped the nodes
 * with `innerHTML = ''` without touching them. A pasted screenshot is several
 * megabytes pinned for the lifetime of the tab, per message.
 *
 * The images are repointed rather than left blank, so the bubble keeps showing
 * the picture — it is now reading the same bytes back from the server.
 */
function settleAttachments(node, previews, ids) {
  const images = node.querySelectorAll('img.bubble__image');
  previews.forEach((file, i) => {
    if (!file?.preview) return;
    const img = images[i];
    if (img && ids[i]) img.src = `/api/attachments/${ids[i]}`;
    URL.revokeObjectURL(file.preview);
    file.preview = null;
  });
}

function noteFile(file) {
  if (!file?.id) return;
  state.files = [file, ...(state.files || []).filter((other) => other.id !== file.id)];
  renderFilesChip();
  offerPreview(file);
}

/* ── a document opens itself ───────────────────────────────────── */

/**
 * The file the assistant just made, on screen without being asked for.
 *
 * The reason to ask for a report is to read it, and the card in the transcript
 * is one more press between the two. So a document the assistant produces opens
 * in the panel on its own.
 *
 * Doing that naively is worse than not doing it. The rules below are what keep
 * it from becoming a thing people switch off:
 *
 *   - **Once per turn.** Closing it means closed, exactly like the plan panel.
 *     A panel that reappears every time the assistant saves is a fight.
 *   - **The last file, not the first.** A turn that writes a .docx and then an
 *     .html preview of it should end on the .html — so the open is deferred a
 *     moment and the newest arrival wins, rather than flickering through each.
 *   - **A rewrite refreshes rather than pops.** `update_file` on the document
 *     already showing is not a new thing to look at; it is the same thing,
 *     changed, and the panel simply re-reads it.
 *   - **Never on a narrow screen**, where the panel covers the whole window —
 *     burying the conversation mid-turn is not a preview, it is an interruption.
 *   - **Never while an approval is waiting.** That prompt is the thing to read.
 */
let previewedThisRun = false;
let previewTimer = null;
let previewWanted = null;

function resetAutoPreview() {
  previewedThisRun = false;
  clearTimeout(previewTimer);
  previewTimer = null;
  previewWanted = null;
}

/** Everything `shouldAutoPreview` needs to know, read fresh. */
const previewConditions = (file) => ({
  prefOn: state.boot?.prefs?.autoPreview !== false,
  alreadyOpened: previewedThisRun,
  width: window.innerWidth,
  showingId: viewer.showing(),
  fileId: file.id,
  approving: $('approval')?.hidden === false,
  elsewhere: !!pages.showing() || !!projectPage.showing(),
});

function offerPreview(file) {
  // A rewrite of what is already open: the panel re-reads it in place. Not an
  // occasion to open anything, and it happens whatever the setting says —
  // showing a stale rendering of a file that just changed is the one thing
  // this panel exists to prevent.
  if (viewer.showing() === file.id) {
    viewer.reopen();
    return;
  }

  if (!shouldAutoPreview(previewConditions(file)).open) return;

  previewWanted = file;
  clearTimeout(previewTimer);
  // Long enough that a second file written in the same breath replaces this
  // one — a turn that writes a .docx and then an .html preview of it should
  // land on the .html rather than flickering through both — and short enough
  // that it still reads as a consequence of the first.
  previewTimer = setTimeout(() => {
    previewTimer = null;
    const wanted = previewWanted;
    previewWanted = null;
    // Asked again at the moment of opening, not only when the file arrived: an
    // approval prompt, or a panel the user opened in between, changes the answer.
    if (!wanted || !shouldAutoPreview(previewConditions(wanted)).open) return;
    previewedThisRun = true;
    viewer.open({ id: wanted.id, name: wanted.name });
  }, 600);
}

$('files-chip').addEventListener('click', () => {
  const files = state.files || [];
  if (!files.length) return;

  openMenu(
    $('files-menu'),
    $('files-chip'),
    files.map((file) => ({
      label: file.name,
      hint: humanSize(file.bytes || 0),
      run: () => viewer.open({ id: file.id, name: file.name }),
    })),
  );
});

/* ── the shelves: Projects, Artifacts, Scheduled ────────────────── */

/**
 * Pages, not dialogs.
 *
 * A shelf is somewhere you go: you look through what is there and pick one.
 * A sheet floating over the transcript is the wrong shape for that — small,
 * temporary, and implying you were in the middle of something. So these take
 * the place of the conversation until you leave them.
 */
const pages = createPages({
  // A run started from a shelf opens its conversation at once; say so in the list.
  onRunStarted: () => refreshChats({ background: true }).catch(() => {}),
  openProject: (id) => projectPage.open(id),
  openViewer: (id) => viewer.open({ id }),
  openChat: (id) => openChat(id),
  onLeave: () => leavePages(),
  onNewProject: () => openProjectForm(),
  // The sidebar keeps its own short list of scheduled work; a task written
  // anywhere has to reach it.
  onTasksChanged: () => refreshTasks().catch(() => {}),
});

/**
 * One project, on its own page.
 *
 * Opened from the shelf, from the header chip, and straight after creating one
 * — every route into a project lands in the same place, which is the only way
 * "my project" means one thing.
 */
const projectPage = createProjectPage({
  openChat: (id) => openChat(id),
  onBack: () => gotoShelf('projects'),
  // The one form, shared. A second copy on the project page would drift from
  // this one, and the half that drifts is the half nobody is looking at.
  newTask: (options) => pages.newTask(options),
  openTask: (id) => {
    pages.showTask(id).catch((err) => toast(err.message, 'error'));
  },
  startChat: async (project, text) => {
    await newChatInProject(project);
    // Through the same path as everything else that fills the box. This one
    // happened to work — `requestSubmit()` does not care that the button is
    // disabled — but two ways of doing it is how the other one broke.
    setComposerText(text);
    $('composer').requestSubmit();
  },
});

/** The create-a-project form, which the Projects shelf opens. */
function openProjectForm() {
  $('project-form-name').value = '';
  $('project-form-about').value = '';
  $('project-form-error').textContent = '';
  $('project-form').showModal();
  $('project-form-name').focus();
}

$('project-form-cancel').addEventListener('click', () => $('project-form').close());
$('task-form-cancel').addEventListener('click', () => $('task-form').close());

$('project-form-save').addEventListener('click', async () => {
  const name = $('project-form-name').value.trim();
  const error = $('project-form-error');
  if (!name) {
    error.textContent = t('project.namePrompt');
    return;
  }
  try {
    const { project } = await api.createProject({
      name,
      instructions: $('project-form-about').value.trim(),
    });
    $('project-form').close();
    toast(t('proj.created', { name: project.name }));
    // Straight into the new project rather than back to the shelf: you named it
    // because you were about to use it.
    projectPage.open(project.id);
  } catch (err) {
    error.textContent = err.message;
  }
});

$('open-artifacts').addEventListener('click', () => {
  closeSidebar();
  gotoShelf('artifacts');
});

$('open-scheduled').addEventListener('click', () => {
  closeSidebar();
  gotoShelf('scheduled');
});

$('open-workflows').addEventListener('click', () => {
  closeSidebar();
  gotoShelf('workflows');
});

/** The folder on the machine: browse it, edit a file, save it, delete one. */
const workspaceFiles = createWorkspace();

$('open-workspace').addEventListener('click', () => {
  closeSidebar();
  workspaceFiles.open('.');
});

/** A conversation started from inside a project belongs to it from the first word. */
async function newChatInProject(project) {
  // Read the project again rather than trusting what the sheet was showing.
  // A source added a moment ago — or in another tab — would otherwise leave the
  // header claiming the project has nothing on its shelf.
  let summary = project;
  try {
    const fresh = await api.project(project.id);
    summary = {
      id: fresh.project.id,
      name: fresh.project.name,
      grounded: fresh.project.grounded,
      files: fresh.files.length,
    };
  } catch {
    // Offline or deleted underneath us; the sheet's copy still names it.
  }
  startBlankChat(summary);
}

/* ── copying and editing what you said ─────────────────────────── */

/**
 * One listener for the whole transcript rather than two per bubble.
 *
 * Messages arrive in their hundreds over a long conversation and are replaced
 * wholesale whenever one is opened; binding handlers to each would leak a
 * little every time and cost more than the feature is worth.
 */
$('messages').addEventListener('click', async (event) => {
  /**
   * Anything carrying a file id opens it — a chip, a thumbnail, an Open button.
   *
   * Checked before the message actions and before anything else, and skipped
   * for the download link beside it: that is a real navigation the browser
   * handles, and hijacking it would replace a working download with a preview
   * nobody asked for.
   */
  const openable = event.target.closest('[data-file]');
  if (openable && !event.target.closest('a[download]')) {
    event.preventDefault();
    viewer.open({ id: openable.dataset.file });
    return;
  }

  const button = event.target.closest('.msg__action');
  if (!button) return;

  // A button clicked with the pointer keeps focus, which used to leave the row
  // lit after the mouse had gone. `detail` is 0 when the click came from the
  // keyboard, and those want their focus kept — that is how they got here.
  if (event.detail > 0) button.blur();

  const done = () => {
    button.classList.add('is-done');
    setTimeout(() => button.classList.remove('is-done'), 1200);
  };

  /**
   * The assistant's answer, as a document rather than as a screenshot of one.
   *
   * Both flavours go on: a word processor takes the HTML — stripped of this
   * app's dark theme, which is the whole bug — and an editor takes the
   * Markdown the answer was written in.
   */
  const assistant = button.closest('.msg--assistant');
  if (assistant) {
    const wrote = await writeRich({
      html: cleanHtml(assistant.querySelector('.prose')),
      text: markdownOf(assistant),
    });
    if (wrote) done();
    else toast(t('clipboard.failed'), 'error');
    return;
  }

  const message = button.closest('.msg--user');
  const text = message?.querySelector('.bubble__text')?.textContent ?? '';

  if (button.dataset.act === 'copy') {
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      // Denied permission, or an insecure origin. Selecting it is the fallback
      // every browser still allows.
      toast(t('clipboard.failed'), 'error');
    }
    return;
  }

  if (button.dataset.act === 'edit') beginEdit(message, text);
});

/**
 * Dragging across an answer and pressing Ctrl+C.
 *
 * This is how people actually copy — the button is the deliberate path, this
 * is the reflex — and left alone it is the bug: the browser builds `text/html`
 * from the *computed* style of the selection, so a transcript drawn on a dark
 * page pastes into Google Docs as a black block with light text. Typing into
 * it then produces light text on a light background, which reads as a document
 * that cannot be edited.
 *
 * So the clipboard is written here instead, from the same stripped HTML the
 * copy button uses. The plain flavour is the browser's own `toString()`, which
 * is exactly what was selected.
 */
$('messages').addEventListener('copy', (event) => {
  // Copying out of a message being rewritten is the browser's business.
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  if (!$('messages').contains(range.commonAncestorContainer)) return;

  // `cloneContents` gives a fragment; `cleanHtml` wants an element to clone.
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  const html = cleanHtml(holder);
  if (!html) return;

  event.clipboardData?.setData('text/html', forWord(html));
  event.clipboardData?.setData('text/plain', selection.toString());
  event.preventDefault();
});

/**
 * Turn a bubble into a box you can rewrite.
 *
 * Saving does not merely change the words: everything after this message is a
 * reply to a question that is being withdrawn, so it goes, and the conversation
 * is asked again from here. That is what makes it changing your mind rather
 * than tampering with the record — and it is why an assistant turn cannot be
 * edited at all.
 */
function beginEdit(message, text) {
  if (runHere()) {
    toast(t('chat.stopBeforeEdit'), 'error');
    return;
  }
  const id = message.dataset.messageId;
  if (!id) {
    toast(t('chat.stillSaving'), 'error');
    return;
  }
  if (message.classList.contains('is-editing')) return;

  const bubble = message.querySelector('.bubble');
  const previous = bubble.innerHTML;
  message.classList.add('is-editing');

  const box = document.createElement('textarea');
  box.className = 'bubble__edit';
  box.value = text;
  box.rows = Math.min(12, text.split('\n').length + 1);

  const row = document.createElement('div');
  row.className = 'bubble__editrow';
  row.innerHTML =
    `<button class="btn btn--ghost btn--small" type="button" data-edit="cancel">${escapeHtml(t('action.cancel'))}</button>` +
    `<button class="btn btn--primary btn--small" type="button" data-edit="save">${escapeHtml(t('chat.saveAndAsk'))}</button>`;

  bubble.innerHTML = '';
  bubble.append(box, row);
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);

  const cancel = () => {
    message.classList.remove('is-editing');
    bubble.innerHTML = previous;
  };

  const save = async () => {
    const next = box.value.trim();
    if (!next) return toast(t('composer.empty'), 'error');
    if (next === text) return cancel();

    row.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api.editMessage(state.chatId, id, next);
    } catch (err) {
      row.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return toast(err.message, 'error');
    }

    // The server has already dropped what followed; the page has to agree.
    while (message.nextSibling) message.nextSibling.remove();
    message.classList.remove('is-editing');
    bubble.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'bubble__text';
    body.textContent = next;
    bubble.append(body);

    await stream();
  };

  row.addEventListener('click', (event) => {
    const act = event.target.closest('[data-edit]')?.dataset.edit;
    if (act === 'cancel') cancel();
    if (act === 'save') save();
  });

  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel();
    // Enter sends, as it does in the composer; Shift+Enter is a new line.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  });
}

/* ── sending ───────────────────────────────────────────────────── */

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('input');
  const text = input.value.trim();

  // Only the ones that finished uploading. A file still in flight — or one that
  // failed — must not be silently dropped from a message that claims to have it.
  const ready = staged.filter((f) => f.id);
  if (!text && !ready.length) return;
  if (staged.some((f) => !f.id && !f.failed)) {
    toast(t('composer.uploading'));
    return;
  }

  // Held for the optimistic bubble, which needs the local previews: the server
  // copy is not fetchable until it has been sent.
  const sending = ready.map((f) => ({ name: f.name, preview: f.preview, size: f.size }));
  const ids = ready.map((f) => f.id);

  input.value = '';
  autosize(input);
  // Detached rather than cleared, so the object URLs survive for the bubble that
  // is about to use them.
  staged.length = 0;
  renderStaged();
  refreshSendState();
  renderVisionWarning();

  /**
   * Typed while the assistant is still working: it waits.
   *
   * Not for long, though. It used to wait for the whole run, and a run here is
   * a chain of tool calls that can go on for minutes — so a correction typed at
   * step two arrived after step twenty, when it no longer helped anybody. It now
   * goes at the next completed tool call (`handOverMidRun`), which is the first
   * moment the loop is between steps rather than mid-thought.
   *
   * It still queues rather than sending outright, and that gap is the feature:
   * it is the window in which you can read the line back, expand it, or delete
   * it before it goes. "Send now" skips the wait entirely when the step in
   * progress is a slow one.
   */
  const queueing = runHere();
  if (queueing) {
    queueing.queue.push({ text, files: sending, ids });
    renderQueue();
    scrollToEnd();
    return;
  }

  try {
    // Where the conversation actually comes into existence: at the first thing
    // anybody says in it, carrying the project it was started under.
    if (!state.chatId) {
      const { chat } = await api.createChat(state.model, state.pendingProject?.id || null);
      state.chatId = chat.id;
      state.pendingProject = null;
    }
    setEmpty(false);
    const node = userMessage(text, sending);
    $('messages').append(node);
    scrollToEnd();

    const { message } = await api.sendMessage(state.chatId, text, ids);
    if (message?.id) node.dataset.messageId = message.id;
    settleAttachments(node, sending, ids);
    await refreshChats();
    $('chat-title').textContent = state.chats.find((c) => c.id === state.chatId)?.title || t('chat.untitled');

    await stream();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ── what is waiting to be sent ─────────────────────────────────── */

/**
 * The queue, drawn above the composer.
 *
 * Shown rather than merely held: a message that has silently gone nowhere is
 * indistinguishable from one that was lost, and the whole point of waiting is
 * that you can see it waiting.
 */
function renderQueue() {
  const host = $('queue');
  const queue = runHere()?.queue || [];
  host.hidden = queue.length === 0;

  host.innerHTML = queue
    .map(
      (item, i) => `
      <div class="queue__item${item.open ? ' is-open' : ''}">
        <span class="queue__wait" aria-hidden="true"></span>
        <div class="queue__body">
          <p class="queue__text" id="queue-text-${i}">${escapeHtml(
            item.text || `${item.files.length} file${item.files.length === 1 ? '' : 's'}`,
          )}</p>
          <button class="queue__more" data-more="${i}" type="button" hidden
                  aria-expanded="${item.open ? 'true' : 'false'}" aria-controls="queue-text-${i}">${
                    escapeHtml(t(item.open ? 'queue.less' : 'queue.more'))
                  }</button>
        </div>
        <div class="queue__actions">
          ${item.files.length ? `<span class="queue__files">${item.files.length} 📎</span>` : ''}
          <button class="queue__now" data-now="${i}" type="button" data-i18n-title="queue.nowHint" title="${escapeHtml(
            t('queue.nowHint'),
          )}">${escapeHtml(t('queue.now'))}</button>
          <button class="queue__drop" data-drop="${i}" type="button" aria-label="${escapeHtml(
            t('queue.remove'),
          )}" title="${escapeHtml(t('queue.remove'))}">✕</button>
        </div>
      </div>`,
    )
    .join('');

  /**
   * Offer "show more" only when there is more to show.
   *
   * Measured rather than guessed from the character count: whether two lines
   * were enough depends on the width of the window and on the language — the
   * same sentence in Vietnamese runs longer than in English — so the only
   * honest test is whether the clamped box is actually shorter than its content.
   */
  for (const button of host.querySelectorAll('[data-more]')) {
    const item = (runHere()?.queue || [])[Number(button.dataset.more)];
    const text = host.querySelector(`#queue-text-${button.dataset.more}`);
    if (!text) continue;
    button.hidden = !item?.open && text.scrollHeight <= text.clientHeight + 1;
    button.addEventListener('click', () => {
      if (item) item.open = !item.open;
      renderQueue();
    });
  }

  for (const button of host.querySelectorAll('[data-drop]')) {
    button.addEventListener('click', () => {
      const [gone] = (runHere()?.queue || []).splice(Number(button.dataset.drop), 1);
      for (const file of gone?.files || []) if (file.preview) URL.revokeObjectURL(file.preview);
      renderQueue();
    });
  }
  for (const button of host.querySelectorAll('[data-now]')) {
    button.addEventListener('click', async () => {
      const here = runHere();
      const [item] = (here?.queue || []).splice(Number(button.dataset.now), 1);
      renderQueue();
      if (item) await deliver(item, { interrupting: true, run: here });
    });
  }
}

/**
 * Put one queued message into the conversation it was typed into.
 *
 * `run` is the run it is being handed to, when there is one. The bubble goes
 * into that run's stage rather than into `#messages`, because a message handed
 * over mid-run belongs to its own conversation even when the person has since
 * navigated to another — appending it by name would drop somebody's question
 * into a transcript it was never part of.
 */
async function deliver(item, { interrupting = false, run = null, chatId = null } = {}) {
  const target = chatId || run?.chatId || state.chatId;
  const node = userMessage(item.text, item.files);
  if (run) run.stage.append(node);
  else $('messages').append(node);
  if (!run || onScreen(run)) scrollToEnd();
  try {
    const { message } = await api.sendMessage(target, item.text, item.ids);
    // Stamped after the fact: the id only exists once the server has it, and
    // without it the bubble has nothing to edit.
    if (message?.id) node.dataset.messageId = message.id;
    settleAttachments(node, item.files || [], item.ids || []);
    if (interrupting && (!run || onScreen(run))) toast(t('status.queued'));
    return true;
  } catch (err) {
    node.remove();
    if (!run || onScreen(run)) toast(err.message, 'error');
    return false;
  }
}

/**
 * Hand the queue over, now that the turn is done — one message at a time.
 *
 * It used to deliver every waiting message at once and then start a single run
 * to answer all of them. That reads well in a comment and badly in use: two
 * questions typed a minute apart are two questions, and folding them into one
 * turn produces one answer that half-addresses each. Worse, the second question
 * was often written *because* of what the first answer would say, and it was
 * asked before that answer existed.
 *
 * So each queued message gets its own turn, in the order it was typed, and the
 * next one waits for the previous answer to finish. That is what a person doing
 * this by hand would do, and it is what somebody watching the queue drain
 * expects to see.
 *
 * The guard is not decoration. `stream()` calls this from its own `finally`, so
 * without it the loop below would re-enter itself once per queued message; with
 * it the nested call returns immediately and the outer loop stays flat.
 */
let flushing = false;
/**
 * @param queue  the waiting messages — a run's own, so draining one
 *   conversation's queue can never fire it into another.
 * @param chatId the conversation they were typed into.
 */
async function flushQueue(queue, chatId) {
  if (flushing || !queue.length || runs.has(chatId) || state.chatId !== chatId) return;
  flushing = true;
  try {
    // Re-checked every pass rather than snapshotted: an answer can arrive while
    // this is working, the user can delete a queued line, and a stop mid-drain
    // must leave the rest of the queue alone rather than firing it anyway.
    while (queue.length && !runs.has(chatId) && state.chatId === chatId) {
      const [item] = queue.splice(0, 1);
      renderQueue();
      // A message that could not be sent has already told the user why. Carry on
      // to the next rather than stranding the whole queue behind it.
      if (!(await deliver(item, { chatId }))) continue;
      await refreshChats();
      await stream();
    }
  } finally {
    flushing = false;
  }
}

/**
 * Hand the queue over at the next step boundary, rather than at the end of the
 * run.
 *
 * A turn here is not one request — it is a chain of tool calls that can go on
 * for minutes, and waiting for the whole chain meant a correction typed at step
 * two was not read until step twenty, by which point it was usually pointless.
 * The loop already accepts a message mid-run and announces it with `steer`; the
 * only question was when to hand it over.
 *
 * A completed tool call is the right moment. The model is between steps rather
 * than mid-thought, so the message lands where a person would have said it, and
 * the gap between typing and the next step is the window in which the queued
 * line can still be edited away — which is the reason it is still shown at all
 * rather than sent instantly.
 */
let handingOver = false;
async function handOverMidRun(run) {
  if (handingOver || !run.queue.length || !runs.has(run.chatId)) return;
  handingOver = true;
  try {
    /**
     * One message per step boundary, not the whole queue.
     *
     * Emptying it here delivered three separate thoughts into the same step,
     * where the model reads them as one instruction and answers the last. Handing
     * over the oldest and leaving the rest keeps them apart: each gets its own
     * boundary, in the order it was typed, and anything still waiting when the
     * turn ends is drained by `flushQueue` — which now also goes one at a time.
     *
     * It also keeps the editing window open. A line queued behind another is
     * still deletable right up until its own turn, which is the whole reason the
     * queue is shown rather than sent.
     */
    const [item] = run.queue.splice(0, 1);
    renderQueue();
    // No `stream()` here, unlike `flushQueue`: a run is already going, and
    // starting a second one against the same conversation is what the 409 lock
    // exists to refuse.
    await deliver(item, { interrupting: true, run });
  } finally {
    handingOver = false;
  }
}

/**
 * Watch a run that another tab is holding.
 *
 * The 409 is correct — one loop per conversation, or the transcript comes back
 * with its turns shuffled together. What was wrong is what happened next: the
 * tab said "already running somewhere else" and then showed nothing, so the
 * person watching their laptop while their phone answered saw a conversation
 * that appeared to have stopped.
 *
 * This draws the other tab's run as it happens, then reloads from the database
 * when it ends. Nothing is sent, no lease is taken, and nothing is written to
 * the transcript: the reload is what makes it correct, and the narration is what
 * makes the wait bearable.
 *
 * It gives up on its own after a while. A tab left open on a conversation whose
 * owner was closed mid-run would otherwise wait forever for a `done` that is
 * never coming.
 */
const MIRROR_TIMEOUT_MS = 10 * 60_000;

async function mirrorRun(run) {
  const chatId = run.chatId;
  if (!chatId) return;

  setStatus(t('mirror.watching'), run);
  run.turn = assistantMessage();
  run.sealed = false;
  run.stage.append(run.turn.node);
  showStage(run);
  if (onScreen(run)) scrollToEnd();

  // Resolves with a value rather than nothing, purely so the type of `resolve`
  // is inferable — a bare `new Promise((resolve) => …)` needs a JSDoc hint that
  // reads worse than this does.
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(true);
    };
    const timer = setTimeout(finish, MIRROR_TIMEOUT_MS);

    const stop = follow(chatId, (event, data) => {
      // Only the events that draw. Approvals, plans and tool cards belong to the
      // tab that can actually answer them, and half-drawing them here would
      // offer buttons that do nothing.
      if (event === 'text') {
        const turn = nextBlock(run);
        turn.finishThinking();
        turn.appendText(data?.delta || '');
        maybeScroll(run);
      } else if (event === 'message') {
        /**
         * The turn was persisted, so the next prose is a new block.
         *
         * Without this `state.sealed` never became true in a following tab and
         * `nextBlock()` never opened a fresh one — so every step of a
         * multi-step turn concatenated into a single markdown blob, which then
         * corrected itself minutes later on the reload below. Cheap to handle,
         * and the difference between watching a run and watching a smear.
         */
        run.turn?.finishThinking();
        run.sealed = true;
      } else if (event === 'retry') {
        // The provider is restarting this reply on another key: what was shown
        // is being replaced, not continued. A follower that kept the abandoned
        // half would show a duplicated paragraph with no way to tell.
        nextBlock(run).resetText();
      } else if (event === 'status' && data?.phase === 'thinking') {
        setStatus(t('mirror.watching'), run);
      } else if (event === 'done' || event === 'error') {
        finish();
      }
    });
  });

  // The database is the truth again, and it has the turn the other tab wrote —
  // properly, with its tool cards and its message ids.
  setStatus(null, run);
  if (state.chatId === chatId) await openChat(chatId);
}

/** Hosts cap how long one request may run; the agent loop is resumable. */
const MAX_RESUMES = 25;

async function stream(decision) {
  const chatId = state.chatId;
  if (!chatId) return;

  const run = runs.start(chatId, {
    abort: new AbortController(),
    // One id for the whole run, including every reconnect below. See api.js.
    runId: crypto.randomUUID(),
  });
  if (!run) return;
  setRunning(true);
  hideApproval();
  // A new turn earns one automatic preview. Whatever the last one did — opened
  // a document, or was closed and told not to — has no say over this one.
  resetAutoPreview();

  run.turn = assistantMessage();
  run.stage.append(run.turn.node);
  // The stage goes on screen only if this is the conversation being looked at.
  // Starting a run always is; it stops being so the moment they navigate.
  showStage(run);
  setStatus(t('status.thinking'), run);
  scrollToEnd();

  try {
    for (let resume = 0; resume <= MAX_RESUMES; resume += 1) {
      const outcome = await streamOnce(run, resume === 0 ? decision : undefined);

      // A clean finish, a question for the user, or a deliberate stop.
      if (outcome !== 'cut') break;

      if (resume === MAX_RESUMES) {
        if (onScreen(run)) toast(t('status.paused'));
        break;
      }
      // The host closed the connection mid-run. Every step is already saved,
      // so reconnecting continues from exactly where it stopped.
      setStatus(t('status.reconnecting'), run);
    }
  } catch (err) {
    // 409 means another tab holds this conversation. That is the lock doing its
    // job, not a failure — say which, so nobody goes looking for a bug.
    if (err.code === 'already_running') {
      // Refused because another tab holds the lease — which is the lock doing
      // its job. Rather than sitting silent, watch that tab's run and redraw it
      // here. See mirror.js and `mirrorRun`.
      await mirrorRun(run);
    } else if (err.name !== 'AbortError' && onScreen(run)) {
      toast(err.message || t('status.streamFailed'), 'error');
    }
  } finally {
    runs.finish(chatId);
    setStatus(null, run);
    if (onScreen(run)) setRunning(false);
    // Drop the trailing empty block created by the last `message` event.
    if (run.turn && !run.turn.node.querySelector('.prose, .block, .plan')) run.turn.node.remove();
    run.turn = null;
    run.toolHandles.clear();
    // The assistant has stopped touching the screen, so stop shipping frames of
    // it. Leaves a panel the user opened, or is driving, alone.
    if (onScreen(run)) screenPanel.restIfIdle();
    await refreshChats();

    /**
     * The stage stays where it is.
     *
     * Its nodes are the turn that just finished, and they are correct — the
     * next `openChat` rebuilds the transcript from the database and throws them
     * away. Removing them here instead would blank the answer the person is
     * reading the instant it arrives.
     */

    // Whatever was typed while this was running goes now — including after a
    // stop, which is the other moment somebody means "right, my turn".
    if (run.queue.length) await flushQueue(run.queue, chatId);
  }
}

/**
 * One request against the agent endpoint.
 * @returns 'done' · 'waiting' (approval needed) · 'cut' (connection dropped mid-run)
 */
async function streamOnce(run, decision) {
  let outcome = 'cut';
  // Every handler below is scoped to `run`, not to whatever is on screen: this
  // stream keeps arriving after the person has navigated to another
  // conversation, and drawing it into that one is the bug this shape exists to
  // make impossible. `setStatus`, `noteStop` and `maybeScroll` take the run and
  // do nothing visible when it is not the conversation being looked at.
  const block = () => nextBlock(run);

  await runAgent({
      chatId: run.chatId,
      model: state.model,
      decision,
      // The calls the prompt named. Only sent with a decision, because only a
      // decision is about a specific batch. See `approvalFor`.
      decisionFor: decision ? approvalFor : undefined,
      runId: run.runId,
      signal: run.abort.signal,
      handlers: {
        status: ({ phase, name, message, seconds, model, free, stop }) => {
          if (phase === 'compacting') setStatus(t('status.compacting'), run);
          else if (phase === 'thinking') setStatus(t('status.thinking'), run);
          /**
           * The provider has not answered yet, and that is worth saying.
           *
           * "Thinking…" was shown whether the model was producing reasoning
           * tokens or had not been given a slot, and those need different
           * reactions from the person watching: one is working, the other is a
           * queue they may not want to wait in. A free model on a busy
           * aggregator sits unanswered for a minute often enough that the
           * silence reads as a broken app.
           *
           * The count goes up, which is the part that matters — a number that
           * moves is the difference between waiting and wondering.
           */
          else if (phase === 'waiting') {
            setStatus(
              t(free ? 'status.waitingFree' : 'status.waiting')
                .replace('{model}', model || '')
                .replace('{n}', String(seconds ?? 0)),
              run,
            );
          } else if (phase === 'tool') setStatus(t('status.tool').replace('{name}', name), run);
          // A turn that stopped badly but still asked for tools — truncated
          // part-way through writing a call, most often. Drawn into the
          // transcript rather than toasted, because the loop carries on and a
          // toast would be gone before the consequences arrived.
          else if (stop) noteStop({ kind: stop, message }, run);
          else if (message && onScreen(run)) toast(message);
        },
        thinking: ({ delta }) => {
          block().appendThinking(delta);
          maybeScroll(run);
        },
        text: ({ delta }) => {
          const turn = block();
          turn.finishThinking();
          turn.appendText(delta);
          maybeScroll(run);
        },
        // A key gave out mid-answer and another one is picking the reply up
        // from the start. Clear what was written rather than letting the second
        // attempt run on from the tail of the first.
        retry: ({ reason }) => {
          block().resetText();
          if (reason && onScreen(run)) toast(reason);
          setStatus(t('status.restarting'), run);
          maybeScroll(run);
        },
        plan: ({ steps }) => {
          run.turn.setPlan(steps);
          if (onScreen(run)) renderProgress(steps);
        },
        tool_call: (call) => {
          // Deliberately not `block()`: the card belongs to the turn that asked
          // for it, even though that turn is already persisted.
          run.turn.finishThinking();
          run.toolHandles.set(call.id, run.turn.startTool(call));
          setStatus(t('status.tool').replace('{name}', call.name), run);
          // Show the screen the moment the assistant touches the browser or the
          // desktop, rather than making the user go looking for it — but only
          // for the conversation they are actually watching.
          if (onScreen(run) && (call.name.startsWith('browser_') || call.name.startsWith('desktop_'))) {
            setDetail(true);
            screenPanel.wake();
          }
          maybeScroll(run);
        },
        tool_result: (result) => {
          run.toolHandles.get(result.toolCallId)?.complete(result);
          run.toolHandles.delete(result.toolCallId);
          if (result.file && onScreen(run)) noteFile(result.file);
          maybeScroll(run);
          // A step just finished, which is the earliest point the loop can read
          // something new without landing it mid-thought. Deliberately not
          // awaited: this handler drives the transcript, and it must not stall
          // on a network round trip.
          handOverMidRun(run);
        },
        // The model put its whole answer on the reasoning channel and left the
        // reply empty. The server has already moved it; this moves the live
        // view to match, so nobody has to reload to see what was said.
        reasoning_was_reply: ({ text }) => {
          block().adoptThinkingAsReply(text);
          maybeScroll(run);
        },
        message: () => {
          run.turn.finishThinking();
          run.sealed = true;
        },
        steer: ({ text }) => {
          setStatus(null, run);
          if (onScreen(run)) toast(t('status.pickedUp').replace('{text}', `${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`));
        },
        usage: (totals) => { if (onScreen(run)) renderUsage(totals); },
        context: (info) => { if (onScreen(run)) renderContext(info); },
        compacted: ({ replaced, text }) => {
          // Said out loud, because the transcript the model sees has just
          // changed and that is not something to do silently.
          toast(t('status.folded').replace('{n}', String(replaced)));
          // `text` too: `summaryDivider` renders a "Read the summary"
          // disclosure when it is given one, and `openChat` already passes it.
          // Dropping it here made the summary visible after a reload and
          // invisible at the moment it happened — which is exactly when
          // somebody wants to check what was folded away.
          run.stage.append(summaryDivider(replaced, text));
          maybeScroll(run);
        },
        approval_required: ({ toolCalls }) => {
          outcome = 'waiting';
          // A run waiting in a conversation you are not looking at must not
          // interrupt you. The pending batch is persisted server-side, so
          // `openChat` puts the prompt back up the moment you return to it.
          if (onScreen(run)) showApproval(toolCalls);
        },
        error: ({ message }) => {
          outcome = 'done';
          run.turn?.finish();
          if (onScreen(run)) toast(message, 'error');
        },
        done: ({ stop }) => {
          outcome = 'done';
          // Collapse any run of steps still drawn as in progress. Without this a
          // finished turn keeps a spinner for the rest of the conversation.
          run.turn?.finish();
          /**
           * Say when the reply is not actually an answer.
           *
           * `stop.message` is non-null exactly when the turn ended badly — cut
           * off at the output cap, declined by a safety classifier, blocked by
           * a content filter. This event carried that all along and this
           * handler used to drop it, so a truncated reply and a finished one
           * were indistinguishable on screen, and a refusal (which returns no
           * content at all) showed as an empty message with no explanation.
           *
           * Translated from the stable `kind` rather than shown in the server's
           * English, and the server's own sentence is the fallback for a kind
           * this build has no string for yet.
           */
          if (stop?.message) noteStop(stop, run);
        },
      },
    });

  return run.abort.signal.aborted ? 'done' : outcome;
}

/**
 * Draw the reason a reply stopped short, once.
 *
 * Translated from the stable `kind` the server sends rather than from its
 * English sentence — the app is used in Vietnamese, and a warning nobody can
 * read is barely better than no warning. The server's own wording is the
 * fallback for a kind this build has no string for, which is what keeps a newer
 * provider outcome visible instead of silently blank.
 *
 * Guarded against repeats: a truncated turn can report itself on the tool path
 * and again on the way out, and two identical notices side by side read as two
 * separate failures.
 */
function noteStop({ kind, message, detail, resumable }, run) {
  // `t` returns the key itself for a string it does not have — see i18n.js,
  // where that is deliberate so a gap is loud rather than silently English.
  // Here it is the signal to fall back to what the server wrote.
  const key = `stop.${kind}`;
  const translated = t(key);
  // The provider's own explanation is appended rather than folded into the
  // fallback, because the translated sentence wins whenever it exists — and on
  // a refusal, which is where `detail` is populated, it always does. Without
  // this the refusal category never reached anybody.
  const sentence = translated === key ? message : translated;
  const body = sentence && detail ? `${sentence} (${detail})` : sentence;
  if (!body || run.lastStopNote === `${kind}:${body}`) return;
  run.lastStopNote = `${kind}:${body}`;
  run.stage.append(
    stopNote(kind, body, resumable && onScreen(run) ? () => { void stream(); } : null),
  );
  maybeScroll(run);
}

/** The block new prose should go into, starting a fresh one after a save. */
function nextBlock(run) {
  if (run.sealed) {
    run.turn = assistantMessage();
    run.sealed = false;
    run.stage.append(run.turn.node);
  }
  return run.turn;
}

/**
 * Stop, and mean it.
 *
 * Aborting the fetch is the fast half — the page stops rendering immediately.
 * It is not the whole job: closing the socket is only a *hint* to the server,
 * and behind a buffering proxy that hint can arrive after the model has finished
 * answering into a page nobody is watching. So the server is told outright, and
 * it takes the run's lease away.
 *
 * Told after the abort rather than before it, so the button feels instant; and
 * the failure is swallowed, because a stop that reports an error while having
 * visibly stopped is worse than one that quietly did the belt-and-braces half.
 */
$('stop').addEventListener('click', () => {
  // The conversation on screen, not "the run": stop is a button in front of one
  // transcript, and with work possible in several at once it must never reach
  // into a conversation the person is not looking at.
  const run = runHere();
  if (!run) return;
  run.abort.abort();
  api.stopChat(run.chatId).catch(() => {});
  toast(t('composer.stopped'));
});

/* ── approval ──────────────────────────────────────────────────── */

/**
 * Which calls the prompt on screen is actually asking about.
 *
 * The answer used to be a bare word — `allow` — and the server applied it to
 * whatever was outstanding when the resume arrived. Those are the same set
 * almost always, and not always: with the app open in two tabs, a turn started
 * in the second one leaves a *different* batch outstanding, and a click on the
 * first tab's prompt then approves calls nobody was shown. Sending the ids back
 * is what makes the answer be about the question.
 */
let approvalFor = [];

function showApproval(toolCalls) {
  approvalFor = toolCalls.map((c) => c.id);
  const box = $('approval');
  // Say why this one stopped. Under the guarded policy most things do not, so
  // when something does the reason is the whole point of the interruption.
  $('approval-list').innerHTML = toolCalls
    .map(
      (c) =>
        // `c.name` is escaped like every other field on this line. Built-in tool
        // names are safe, but an MCP tool name is chosen by a third-party server
        // the user connected — and this is the approval prompt, the one screen
        // whose whole job is to state accurately what is about to run.
        `<div>${escapeHtml(c.name)} — ${escapeHtml(summariseToolInput(c.name, c.input))}` +
        (c.needsApproval && c.reason ? `<br /><span class="warn-text">${escapeHtml(c.reason)}</span>` : '') +
        '</div>',
    )
    .join('');
  box.hidden = false;
  scrollToEnd();
  /**
   * Put the keyboard where the decision is.
   *
   * The run has halted and nothing further happens until somebody answers, but
   * focus stayed wherever it was — so a keyboard or screen-reader user had to
   * go looking for a prompt they were never told about. Deny is focused rather
   * than Allow: the safe half of an irreversible choice should be the one a
   * stray Return key lands on.
   */
  $('deny').focus();
}

function hideApproval() {
  $('approval').hidden = true;
}

$('allow').addEventListener('click', () => stream('allow'));
$('deny').addEventListener('click', () => stream('deny'));


/* ── topbar, status, worker ────────────────────────────────────── */

function renderTopbar() {
  /**
   * The chevron, and the project it belongs to.
   *
   * Both hidden until there is a stored conversation to act on: a blank one has
   * no id, so pinning or archiving it would be a menu of things that cannot
   * happen.
   */
  const open = state.chats?.find((c) => c.id === state.chatId) || null;
  const chev = $('chat-menu');
  chev.hidden = !open;

  const crumb = $('chat-project');
  const project = open?.project_id ? state.projects?.find((p) => p.id === open.project_id) : null;
  crumb.hidden = !project;
  if (project) {
    crumb.textContent = project.name;
    crumb.title = project.name;
  }

  // The id's last segment reads better than the whole path in a narrow chip.
  const chip = $('model-chip');
  chip.textContent = state.model === 'auto' ? 'Auto' : String(state.model || '').split('/').pop();

  /**
   * Say when the model is a free one.
   *
   * A new account lands on the newest free model rather than a paid flagship, so
   * most people start here without having chosen it. Free models are rate-limited
   * and weaker at chaining tool calls, and the failure that follows — a long job
   * that stops halfway — looks exactly like the app being broken unless something
   * says which kind of model is answering.
   */
  chip.classList.toggle('chip--free', attachments.isFree());
  chip.title = attachments.isFree() ? t('model.free.tooltip', { model: state.model }) : state.model;
  renderPolicy();
}

$('chat-menu').addEventListener('click', (event) => {
  event.stopPropagation();
  const chat = state.chats?.find((c) => c.id === state.chatId);
  // `null` for the title button is what tells `chatMenuItems` this is the
  // chevron rather than a sidebar row — see the two branches there.
  if (chat) openRowMenu(chat, $('chat-menu'), null);
});

$('chat-project').addEventListener('click', () => {
  const chat = state.chats?.find((c) => c.id === state.chatId);
  if (!chat?.project_id) return;
  leavePages();
  projectPage.open(chat.project_id);
});

/**
 * Show or hide the opening screen — and with it, the sky behind it.
 *
 * One function because they are one state. Setting `hidden` on the empty block
 * from three different places and the class from three others is how a drifting
 * nebula ends up animating behind a transcript nobody can read.
 */
function setEmpty(visible) {
  $('empty-state').hidden = !visible;
  // On the shell, not the conversation column: the sky it governs is a backdrop
  // behind the whole app, so the transparent rail and progress panel sit under
  // the same colour the transcript does.
  $('app').classList.toggle('is-fresh', visible);
}

/**
 * The approval policy, in the composer.
 *
 * It decides what happens the moment you press send — whether a command runs or
 * stops and asks — so it belongs beside the button, not three clicks away behind
 * a settings tab where nobody looks until something has already happened.
 */
function renderPolicy() {
  const policy = state.boot.prefs.toolPolicy;
  $('policy-label').textContent = POLICY_LABEL(policy);
  $('policy-chip').title = POLICY_HINT(policy) || '';
  // The glyph changes with the mode. A chip that always showed the same bolt
  // was decoration; one that changes is the fastest way to see where you are.
  $('policy-icon').innerHTML = POLICY_ICON[policy] || '';
  // Only the one that runs everything gets to look like it: an amber control is
  // a reminder, and a reminder that is always on stops being one.
  $('policy-chip').classList.toggle('is-loud', policy === 'auto');
  $('policy-chip').classList.toggle('is-quiet', policy === 'readonly' || policy === 'plan');
}

/** Lives in its own container after the transcript, so it is always last. */
/**
 * Say what is happening, under the transcript.
 *
 * Takes the run it is speaking for. There is one status line and there can be
 * several runs, so a run narrates only while its own conversation is the one on
 * screen — otherwise a tool call in a conversation you left would overwrite the
 * line belonging to the one you are reading. The text is remembered on the run
 * either way, so returning to a conversation restores the line it was showing
 * rather than a blank strip under a transcript that is plainly still working.
 *
 * Called with no run for the plain cases — a toast-like notice about the
 * conversation on screen — which always draw.
 */
function setStatus(text, run = null) {
  if (run) {
    run.status = text;
    if (!onScreen(run)) return;
  }
  const host = $('status-host');
  host.innerHTML = '';
  if (text) host.append(statusLine(text));
}

function renderUsage({ input, output, cost, priced, estimated, cacheRead }) {
  // Nothing to report rather than "0 tokens this turn", which reads as a turn
  // that happened and cost nothing.
  if (!input && !output) {
    $('composer-meta').textContent = '';
    return;
  }
  const tokens = t('usage.tokens').replace('{n}', (input + output).toLocaleString());
  // "~$" only when the figure is our own arithmetic. When the provider invoiced
  // the turn — OpenRouter and OrcaRouter both do — the number is exact and the
  // tilde would be understating what we actually know.
  const money = priced
    ? ` · ${estimated ? '~' : ''}$${cost.toFixed(4)} ${t('usage.thisTurn')}`
    : ` ${t('usage.thisTurn')}`;
  // A cache hit is the single biggest lever on an agentic conversation's cost,
  // and it was invisible. Shown only when it was substantial enough to matter.
  const cached =
    cacheRead && input && cacheRead / input >= 0.2
      ? ` · ${t('usage.cached').replace('{n}', String(Math.round((cacheRead / input) * 100)))}`
      : '';
  $('composer-meta').textContent = `${tokens}${money}${cached}`;
}

function setRunning(running) {
  // Which of send and stop is showing depends on both the run and what is in
  // the box, so there is one function that decides it — see refreshSendState.
  // The box itself is never disabled: that would be the one thing that makes
  // changing your mind impossible.
  $('input').disabled = false;
  refreshSendState();
}

async function refreshWorker() {
  try {
    // A dedicated endpoint rather than the whole bootstrap payload: this runs
    // every twenty seconds, per open tab, to decide the colour of one dot.
    const { worker } = await api.workerStatus();
    state.boot.worker = worker;
    renderWorker();
  } catch {
    /* transient — the indicator keeps its last state */
  }
}

/** Whether an address points back at the machine the browser is running on. */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/**
 * How to connect a computer to *this* app, with the address already filled in.
 *
 * This used to be two hard-coded lines of markup ending in `npm start`, and on a
 * deployment that instruction was wrong in a way nobody could see. `npm start`
 * brings up a second copy of the app on the other machine and points the worker
 * at it, so the pairing code shown lands in that machine's own database — while
 * the person types it into a deployment backed by an entirely different one. The
 * code is rejected, correctly, and the message says the code is invalid, which
 * sends everybody looking in the wrong place.
 *
 * So the command is generated, it names this deployment, and it is copyable —
 * because retyping a URL by hand is the other half of the same failure.
 */
function renderConnectSteps() {
  const host = $('connect-steps');
  if (!host) return;

  const url = state.boot.runtime?.publicUrl || '';
  // Serverless is the certain case. A local server reached over a tunnel or a
  // LAN address is the same situation for anyone adding a *different* machine,
  // so it gets the same instruction.
  const remote = !!state.boot.runtime?.serverless || (!!url && !LOOPBACK.test(url));
  const command = remote && url ? `npm run connect -- ${url}` : 'npm start';

  const step = (html) => `<li>${html}</li>`;
  const code = `<code class="connect__cmd">${escapeHtml(command)}</code>`;

  host.innerHTML = [
    step(t('connect.step.clone')),
    step(
      t('connect.step.run', { code }) +
        ` <button class="btn btn--ghost btn--tiny" id="copy-connect" type="button" ` +
        `data-command="${escapeHtml(command)}">${escapeHtml(t('worker.copy'))}</button>`,
    ),
    step(
      remote
        ? t('connect.step.codeRemote')
        : `${t('connect.step.codeLocal')} ${t('connect.step.codeLocalMore')}`,
    ),
  ].join('');
}

/**
 * A one-line setup command for a computer that is not paired yet.
 *
 * Generated on demand rather than shown by default: it carries a live token for
 * this account, and a secret sitting on screen behind a settings tab is a secret
 * somebody will screenshot. It expires, and the panel says when.
 *
 * The warning is not decoration. This token flows *toward* a machine, so it can
 * be passed to somebody who was told it does something else — and the honest
 * thing is to say plainly that pasting it hands the machine over. The installer
 * repeats the same warning with the account named, and refuses to go on without
 * a typed YES.
 */
/**
 * Ask for a setup line and draw it.
 *
 * Wired to two buttons, because there are two doors into "add a computer" and
 * the first version only put this behind one of them. **Computers** in the
 * header is the one people actually press; Settings → Computers is the one that
 * had the button. So the easy path existed and nobody could find it.
 */
async function renderSetupLink(button, host) {
  button.disabled = true;
  try {
    const link = await api.enrolmentLink();
    const minutes = Math.max(1, Math.round((link.expiresInSec || 600) / 60));
    const windows = escapeHtml(link.windows);
    const unix = escapeHtml(link.unix);

    host.hidden = false;
    host.innerHTML =
      `<p class="hint warn-text">${escapeHtml(t('setup.warning'))}</p>` +
      `<label class="device__label">Windows (PowerShell)</label>` +
      `<pre class="setup__cmd" data-copy="${windows}">${windows}</pre>` +
      `<button class="btn btn--ghost btn--tiny" data-copy-setup="windows">${escapeHtml(t('worker.copy'))}</button>` +
      `<label class="device__label">macOS / Linux</label>` +
      `<pre class="setup__cmd" data-copy="${unix}">${unix}</pre>` +
      `<button class="btn btn--ghost btn--tiny" data-copy-setup="unix">${escapeHtml(t('worker.copy'))}</button>` +
      `<p class="hint">${escapeHtml(t('setup.expires').replace('{n}', String(minutes)))}</p>`;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

for (const [buttonId, hostId] of [
  ['make-setup-link', 'setup-link'],
  ['make-setup-link-dialog', 'setup-link-dialog'],
]) {
  $(buttonId)?.addEventListener('click', (event) => renderSetupLink(event.target, $(hostId)));
}

document.addEventListener('click', async (event) => {
  const copySetup = event.target.closest('[data-copy-setup]');
  if (copySetup) {
    const pre = copySetup.previousElementSibling;
    try {
      await navigator.clipboard.writeText(pre?.dataset.copy || pre?.textContent || '');
      copySetup.textContent = t('worker.copied');
      setTimeout(() => {
        copySetup.textContent = t('worker.copy');
      }, 1400);
    } catch {
      toast(t('clipboard.failed'), 'error');
    }
    return;
  }

  const button = event.target.closest('#copy-connect');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.command || '');
    button.textContent = t('worker.copied');
    setTimeout(() => {
      button.textContent = t('worker.copy');
    }, 1400);
  } catch {
    toast(t('clipboard.failed'), 'error');
  }
});

function renderWorker() {
  const { worker } = state.boot;
  renderConnectSteps();
  // One place says whether a computer is connected: the chip in the header. The
  // sidebar used to say it too, which meant two things to keep in step and a
  // status nobody could see without opening the menu.
  renderPairChip();

  const card = $('worker-status-card');
  if (card) {
    // Spell out how far the assistant's reach extends on this machine. These
    // are the two settings that decide it, and neither is obvious from the app.
    const reach = worker.online
      ? [
          worker.info?.fullDisk
            ? t('worker.fullDisk')
            : t('worker.workspaceOnly'),
          worker.info?.desktop
            ? t('worker.desktopOn')
            : t('worker.desktopOff'),
        ].join('<br />')
      : '';

    card.innerHTML = worker.online
      ? `<div class="provider"><div class="provider__head"><span class="provider__name">${escapeHtml(t('worker.connected'))}</span>
           <span class="badge badge--ok">${escapeHtml(t('devices.online'))}</span></div>
           <div class="hint">${escapeHtml(worker.info?.platform || '')} · Node ${escapeHtml(worker.info?.node || '')}<br />
           ${escapeHtml(t('worker.workspaceLabel'))} <code>${escapeHtml(worker.info?.workspace || '')}</code><br />${reach}</div></div>`
      : `<div class="provider"><div class="provider__head"><span class="provider__name">${escapeHtml(t('worker.notConnected'))}</span>
           <span class="badge">${escapeHtml(t('devices.offline'))}</span></div>
           <div class="hint">${
             // "Run a worker" is unhelpful advice when the real reason is that
             // this computer belongs to somebody else's account.
             worker.reason === 'not-the-owner'
               ? escapeHtml(t('worker.notTheOwner'))
               : t('worker.noTools')
           }</div></div>`;
  }
}

/* ── settings ──────────────────────────────────────────────────── */

function openSettings(tab) {
  fillSettings();
  if (tab) selectTab(tab);
  $('settings').showModal();
}

$('open-settings').addEventListener('click', () => openSettings());

$('language').addEventListener('change', async (event) => {
  const language = /** @type {HTMLInputElement} */ (event.target).value;
  if (!setLanguage(language)) return;
  // Anything drawn from script rather than from markup has to be rebuilt: the
  // chips, the mode menu labels and the conversation list are not `data-i18n`
  // nodes, so `applyI18n` cannot reach them.
  renderTopbar();
  renderPolicy();
  onboarding.refresh();
  try {
    state.boot.prefs = await api.savePrefs({ language });
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ── MCP servers ───────────────────────────────────────────────────
 *
 * Tools from outside this app. Two things this panel has to get right:
 *
 *   **Trying before saving.** The server is started and asked what it offers
 *   before the row is written, so "that did not work" arrives while somebody is
 *   still looking at what they typed rather than halfway through a task tomorrow.
 *
 *   **Saying when one has stopped working.** A server that started last week and
 *   does not start today is the common case — a package removed, a token
 *   expired — and its tools simply vanish. The status shown here is read live on
 *   every visit for that reason.
 */

/** Split a command line into a program and its arguments, respecting quotes. */
function splitCommand(line) {
  const parts = String(line || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const clean = parts.map((p) => p.replace(/^["']|["']$/g, ''));
  return { command: clean[0] || '', args: clean.slice(1) };
}

/** `Name: value` per line → an object. Blank lines and stray text are skipped. */
function parseHeaders(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const cut = line.indexOf(':');
    if (cut < 1) continue;
    const name = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

function renderMcp({ servers, status }) {
  const host = $('mcp-list');
  if (!servers.length) {
    host.innerHTML = `<p class="hint">${escapeHtml(t('mcp.none'))}</p>`;
    return;
  }

  const live = new Map((status || []).map((s) => [s.id, s]));

  host.innerHTML = servers
    .map((server) => {
      const state = live.get(slugForMcp(server.name));
      const reach = server.enabled === false
        ? `<span class="tag">${escapeHtml(t('mcp.off'))}</span>`
        : state?.error
          ? `<span class="tag tag--warn">${escapeHtml(t('mcp.broken'))}</span>`
          : state
            ? `<span class="tag tag--free">${escapeHtml(t('mcp.tools', { n: state.tools }))}</span>`
            : '';

      const where = server.transport === 'http'
        ? server.url
        : [server.command, ...(server.args || [])].join(' ');

      return `
        <div class="provider">
          <div class="provider__head">
            <strong>${escapeHtml(server.name)}</strong> ${reach}
          </div>
          <div class="hint" style="word-break:break-all">${escapeHtml(where || '')}</div>
          ${state?.error ? `<div class="hint" style="color:var(--warn)">${escapeHtml(state.error)}</div>` : ''}
          <div class="row">
            <button class="btn btn--ghost" data-mcp-toggle="${escapeHtml(server.id)}" type="button">
              ${escapeHtml(server.enabled === false ? t('mcp.enable') : t('mcp.disable'))}
            </button>
            <button class="btn btn--ghost" data-mcp-remove="${escapeHtml(server.id)}" type="button">
              ${escapeHtml(t('mcp.remove'))}
            </button>
          </div>
        </div>`;
    })
    .join('');

  for (const btn of host.querySelectorAll('[data-mcp-toggle]')) {
    btn.addEventListener('click', async () => {
      const server = servers.find((s) => s.id === btn.dataset.mcpToggle);
      try {
        await api.setMcpEnabled(server.id, server.enabled === false);
        await loadMcp();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  for (const btn of host.querySelectorAll('[data-mcp-remove]')) {
    btn.addEventListener('click', async () => {
      try {
        await api.removeMcpServer(btn.dataset.mcpRemove);
        await loadMcp();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
}

/** The same slug the server derives tool names from, so statuses line up. */
const slugForMcp = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'server';

/**
 * The suggestions strip.
 *
 * Pressing one fills the form in rather than connecting: the command is the thing
 * somebody should see before it runs on their machine, and a one-press "install"
 * would hide exactly the step worth reading.
 */
async function loadMcpCatalogue() {
  const host = $('mcp-catalogue');
  try {
    const { servers } = await api.mcpCatalogue();
    host.innerHTML = servers
      .map(
        (s) => `
        <button class="mcp-cat__item" type="button" data-mcp-preset="${escapeHtml(s.id)}">
          <span class="mcp-cat__name">${escapeHtml(s.label)}</span>
          <span class="mcp-cat__blurb">${escapeHtml(s.blurb)}</span>
          ${s.needs ? `<span class="mcp-cat__needs">${escapeHtml(t('mcp.needs'))}</span>` : ''}
        </button>`,
      )
      .join('');

    for (const btn of host.querySelectorAll('[data-mcp-preset]')) {
      btn.addEventListener('click', () => {
        const preset = servers.find((s) => s.id === btn.dataset.mcpPreset);
        $('mcp-name').value = preset.id;
        $('mcp-transport').value = preset.transport;
        $('mcp-transport').dispatchEvent(new Event('change'));
        if (preset.transport === 'http') {
          $('mcp-url').value = preset.url || '';
          $('mcp-headers').value = preset.needs?.header ? `${preset.needs.header}: ` : '';
        } else {
          $('mcp-command').value = [preset.command, ...(preset.args || [])].join(' ');
        }
        // Everything the entry knows that the form cannot show: an argument it
        // still needs, a token, or where it has to be running.
        const notes = [preset.argsHint, preset.needs?.why, preset.note].filter(Boolean);
        $('mcp-status').textContent = notes.length ? notes.join('  ') : t('mcp.presetReady', { name: preset.label });
        $('mcp-name').focus();
      });
    }
  } catch {
    // A suggestions list that will not load is not worth an error: the form under
    // it works perfectly well without it.
    host.innerHTML = '';
  }
}
async function loadMcp() {
  try {
    renderMcp(await api.mcpServers());
  } catch (err) {
    $('mcp-list').innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
  }
}

$('mcp-transport').addEventListener('change', (event) => {
  const http = event.target.value === 'http';
  $('mcp-stdio-field').hidden = http;
  $('mcp-http-field').hidden = !http;
});

$('mcp-add').addEventListener('click', async () => {
  const status = $('mcp-status');
  const name = $('mcp-name').value.trim();
  if (!name) {
    status.textContent = t('mcp.needName');
    return;
  }

  const transport = $('mcp-transport').value === 'http' ? 'http' : 'stdio';
  const body = { name, transport };
  if (transport === 'stdio') {
    const { command, args } = splitCommand($('mcp-command').value);
    if (!command) {
      status.textContent = t('mcp.needCommand');
      return;
    }
    Object.assign(body, { command, args });
  } else {
    body.url = $('mcp-url').value.trim();
    body.headers = parseHeaders($('mcp-headers').value);
  }

  const button = $('mcp-add');
  button.disabled = true;
  // Starting a server can mean npx fetching a package, which is not instant.
  status.textContent = t('mcp.trying');
  try {
    const { found } = await api.addMcpServer(body);
    status.textContent = t('mcp.added', { n: found?.tools?.length || 0 });
    $('mcp-name').value = '';
    $('mcp-command').value = '';
    $('mcp-url').value = '';
    $('mcp-headers').value = '';
    await loadMcp();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('open-onboarding').addEventListener('click', () => {
  $('settings').close();
  onboarding.open();
});
$('policy-chip').addEventListener('click', () => {
  const current = state.boot.prefs.toolPolicy;
  openMenu(
    $('policy-menu'),
    $('policy-chip'),
    [
      { static: true, label: t('policy.menuTitle') },
      ...POLICIES.map((policy) => ({
        label: POLICY_LABEL(policy),
        hint: POLICY_HINT(policy),
        icon: POLICY_ICON[policy],
        active: policy === current,
        async run() {
          if (policy === current) return;
          state.boot.prefs = await api.savePrefs({ toolPolicy: policy });
          renderPolicy();
          toast(`${POLICY_LABEL(policy)}.`);
        },
      })),
      { node: effortRow() },
    ],
  );
});

/**
 * The effort dial, at the foot of the mode menu.
 *
 * Five steps, drawn as five dots rather than a row of words: it is a scale, and
 * a scale should look like one. Changing it saves immediately and leaves the
 * menu open — you are usually adjusting it against the mode you just picked,
 * and a menu that vanished after each nudge would make that a chore.
 */
function effortRow() {
  const row = document.createElement('div');
  row.className = 'menu__foot';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('settings.effort'));

  const name = document.createElement('span');
  name.className = 'menu__foot-name';
  const dots = document.createElement('div');
  dots.className = 'effort-dots';

  const paint = () => {
    const current = state.boot.prefs.effort;
    const index = EFFORT_IDS.indexOf(current);
    name.textContent = t('effort.named', { level: effortLabel(current) });
    for (const [i, dot] of [...dots.children].entries()) {
      dot.classList.toggle('is-on', i === index);
      dot.classList.toggle('is-under', i < index);
      dot.setAttribute('aria-checked', String(i === index));
    }
  };

  for (const [value, label] of efforts()) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'effort-dot';
    dot.setAttribute('role', 'radio');
    dot.setAttribute('aria-label', label);
    dot.title = label;
    dot.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (state.boot.prefs.effort === value) return;
      try {
        state.boot.prefs = await api.savePrefs({ effort: value });
        paint();
        toast(t('effort.set', { level: label }));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    dots.append(dot);
  }

  row.append(name, dots);
  paint();
  return row;
}

/** Falls back to High, which is what an account with no answer stored gets. */
const effortLabel = (value) => (efforts().find(([v]) => v === value) || efforts()[2])[1];

/**
 * The chip opens the picker, and only the picker.
 *
 * There were two listeners on this element. This one opened Settings on the
 * Models tab; the one beside `createModelBrowser` opens the model browser for
 * the conversation. Both fired, so pressing the chip stacked the browser on top
 * of a Settings sheet — and Settings → Models shows the **account default**,
 * which is a different value from the conversation's own model.
 *
 * That is the reported bug, in one press: two different model names on screen at
 * once, one of them labelled "Default model". Picking from the browser set the
 * conversation, the sheet behind it went on showing the default, and the two
 * looked like they disagreed because they were answering different questions.
 *
 * Settings → Models is still reachable from the sidebar, where the account-wide
 * settings belong.
 */

/** Every settings tab, typed as what it is: a button, not a bare Element. */
const settingsTabs = () =>
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.tab'));

function selectTab(name) {
  for (const tab of settingsTabs()) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    /**
     * The state a screen reader reads, alongside the class the eye reads.
     *
     * These carried `role="tab"` and nothing else — no aria-selected, so ten
     * tabs were announced and none of them said which one you were on. The
     * roving tabindex is the other half: only the selected tab is in the tab
     * order, so Tab moves past the whole strip rather than through ten stops,
     * which is what the arrow keys below are for.
     */
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) revealInStrip(tab);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  }
}

/**
 * Left and right move between tabs, Home and End jump to the ends.
 *
 * This is the half of the tab pattern that cannot be expressed in markup, and
 * without it `role="tablist"` promises a keyboard behaviour that is not there.
 */
function moveTab(from, step) {
  const tabs = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.sheet__tabs .tab')]);
  if (!tabs.length) return;
  const at = tabs.indexOf(from);
  const next =
    step === 'home' ? tabs[0]
    : step === 'end' ? tabs[tabs.length - 1]
    : tabs[(at + step + tabs.length) % tabs.length];
  if (!next) return;
  selectTab(next.dataset.tab);
  next.focus();
}

for (const tab of settingsTabs()) {
  tab.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    const step =
      event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowLeft' ? -1
      : event.key === 'Home' ? 'home'
      : event.key === 'End' ? 'end'
      : null;
    if (step === null) return;
    event.preventDefault();
    moveTab(tab, step);
  });

  tab.addEventListener('click', () => {
    selectTab(tab.dataset.tab);
    // Reaching a server takes a moment, so this is done when the tab is opened
    // rather than every time Settings is.
    if (tab.dataset.tab === 'mcp') {
      loadMcp();
      if (!$('mcp-catalogue').childElementCount) loadMcpCatalogue();
    }
  });
}

function fillSettings() {
  const { prefs, providers, providerMeta } = state.boot;

  /**
   * Say whose key is paying.
   *
   * This used to branch on `status.fromEnv`, a field the server has never
   * returned — so the whole "from environment" path was dead and somebody
   * quietly spending the deployment's shared key saw exactly the same green
   * badge as somebody paying their own bill. `shared` is the real field.
   */
  /**
   * The keys, and their spares.
   *
   * A provider holds a list rather than a key: they are tried in order, and the
   * first one that is not refused answers. That is the difference between a key
   * running out at eleven costing a moment and costing the rest of the day —
   * so the list is shown as a list, with the order it will actually be used in.
   *
   * The key itself is never here. The last four characters and the date are
   * enough to tell one from another, which is the only thing this screen has to
   * help you do.
   */
  const keyRow = (provider, entry, spare) => `
    <div class="keyrow">
      <span class="keyrow__no">${entry.position}</span>
      <span class="keyrow__hint">${escapeHtml(entry.hint || t('keys.saved'))}</span>
      <span class="keyrow__when">${entry.addedAt ? escapeHtml(relativeWhen(entry.addedAt)) : ''}</span>
      ${entry.position === 1 && spare ? `<span class="keyrow__badge">${escapeHtml(t('devices.inUse'))}</span>` : ''}
      <button class="keyrow__drop" data-drop-key="${escapeHtml(provider)}" data-position="${entry.position}"
              type="button" aria-label="${escapeHtml(t('keys.removeAria', { position: entry.position }))}">✕</button>
    </div>`;

  $('provider-list').innerHTML = Object.entries(providerMeta)
    .map(([key, meta]) => {
      const status = providers[key] || {};
      const keys = status.keys || [];
      const label = status.own
        ? keys.length > 1
          ? t('keys.count', { n: keys.length })
          : t('keys.yours')
        : status.shared
          ? t('keys.shared')
          : t('keys.notSet');

      return `
        <div class="provider">
          <div class="provider__head">
            <span class="provider__name">${escapeHtml(meta.label)}</span>
            <span class="badge ${status.own ? 'badge--ok' : ''}">${escapeHtml(label)}</span>
          </div>
          ${
            status.shared
              ? `<div class="hint">${t('keys.sharedFallback', { envVar: `<code>${escapeHtml(status.envVar || '')}</code>` })}</div>`
              : ''
          }
          ${keys.length ? `<div class="keylist">${keys.map((entry) => keyRow(key, entry, keys.length > 1)).join('')}</div>` : ''}
          <div class="provider__row">
            <input type="password" placeholder="${escapeHtml(meta.keyHint)}" data-key="${escapeHtml(key)}" autocomplete="off" />
            <button class="btn btn--ghost" data-save-key="${escapeHtml(key)}" type="button">
              ${escapeHtml(keys.length ? t('keys.add') : t('action.save'))}
            </button>
          </div>
          <div class="hint">
            <a href="${escapeHtml(meta.console)}" target="_blank" rel="noopener">${escapeHtml(t('keys.getOne'))}</a>
            ${
              keys.length > 1
                ? ` · ${escapeHtml(t('keys.triedInOrder'))}`
                : keys.length
                  ? ` · ${escapeHtml(t('keys.addFallback'))}`
                  : ''
            }
          </div>
        </div>`;
    })
    .join('');

  for (const btn of document.querySelectorAll('[data-save-key]')) {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.saveKey;
      const input = document.querySelector(`[data-key="${provider}"]`);
      const value = input.value.trim();
      const existing = (providers[provider]?.keys || []).length;

      try {
        // Adding when there is one already, replacing when there is not — and
        // an empty box on a provider with no keys still means "clear it", which
        // is what the hint under an empty provider has always said.
        state.boot.providers = existing && value ? await api.addKey(provider, value) : await api.saveKey(provider, value);
        input.value = '';
        // Step 2 of the guide says whether a key exists. It is open behind this
        // sheet, so telling somebody to paste a key they have just pasted would
        // be the guide arguing with them.
        onboarding.refresh();
        toast(t(value ? 'keys.savedFor' : 'keys.removedFor', { provider: providerMeta[provider].label }));
        fillSettings();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-drop-key]')) {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.dropKey;
      try {
        state.boot.providers = await api.removeKey(provider, Number(btn.dataset.position));
        toast(t('keys.removedFrom', { provider: providerMeta[provider].label }));
        fillSettings();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // The model is not filled in here either: it lives on the header chip, for
  // the same reason mode and effort live on the composer chip.
  //
  // Mode and effort are not here: they live on the composer chip, which saves
  // them on the spot. Nothing to fill in, and nothing to fall out of step.
  $('max-steps').value = prefs.maxSteps;
  $('auto-compact').value = prefs.autoCompact === false ? 'off' : 'on';
  $('auto-preview').value = prefs.autoPreview === false ? 'off' : 'on';
  $('system-prompt').value = prefs.systemPrompt || '';
  // Per-browser, not per-account — so it is read back from storage, not prefs.
  $('theme').value = storedTheme();

  /**
   * Language is per-account, unlike the theme.
   *
   * The theme belongs to the screen you are looking at; the language belongs to
   * the person. Somebody who reads Vietnamese reads it on their phone too, and
   * having to set it again on every device would be the wrong half of the
   * distinction.
   */
  const languages = $('language');
  if (!languages.children.length) {
    // Each language named in itself, so somebody who cannot read the current
    // interface can still find their own.
    languages.innerHTML = LANGUAGES.map(
      ({ id, label, english }) =>
        `<label class="lang-choice__item" lang="${id}">` +
        `<input type="radio" name="language" value="${id}" />` +
        `<span class="lang-choice__native">${escapeHtml(label)}</span>` +
        `<span class="lang-choice__english" lang="en">${escapeHtml(english)}</span>` +
        `</label>`,
    ).join('');
  }
  for (const radio of /** @type {NodeListOf<HTMLInputElement>} */ (languages.querySelectorAll('input'))) {
    radio.checked = radio.value === currentLanguage();
  }

  const me = state.boot.user;
  $('account-card').innerHTML = `
    <div class="provider">
      <div class="provider__head">
        <span class="provider__name">${escapeHtml(me.name || me.email)}</span>
        <span class="badge ${me.role === 'admin' ? 'badge--ok' : ''}">${escapeHtml(me.role === 'admin' ? t('role.admin') : t('role.member'))}</span>
      </div>
      <div class="hint">${escapeHtml(me.email)}</div>
    </div>`;
  $('account-name').value = me.name || '';
  renderTwoFactor();
  renderUsagePanel($('usage-card'), state.boot.usage);

  $('tab-admin').hidden = me.role !== 'admin';
  if (!$('tab-admin').hidden) loadAdmin();

  // These three each hit the network, so they load alongside rather than
  // blocking the sheet from opening. A failure in one must not blank the rest.
  for (const load of [loadSkills, loadTasks, loadConnectors, loadDevices]) {
    load().catch((err) => console.error('[settings]', err.message));
  }

  renderWorker();
}

/* ── skills, schedules, connectors ─────────────────────────────── */

const relativeWhen = (iso) => {
  const then = new Date(iso);
  const mins = Math.round((then - Date.now()) / 60000);
  if (mins < 0) return 'overdue';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 60 * 24) return `in ${Math.round(mins / 60)}h`;
  return then.toLocaleString();
};

async function loadSkills() {
  const { skills } = await api.skills();
  $('skill-list').innerHTML = skills.length
    ? `<div class="rows">${skills
        .map(
          (s) => `<div class="rows__item">
            <span class="grow">${escapeHtml(s.name)}
              <span class="muted">· ${escapeHtml(s.description)}${
                s.used_count ? ` · ${escapeHtml(t('skills.used', { n: s.used_count }))}` : ''
              }</span>
            </span>
            <button data-skill-toggle="${escapeHtml(s.id)}" data-on="${!!s.enabled}">${
              escapeHtml(s.enabled ? t('mcp.disable') : t('mcp.enable'))
            }</button>
            <button data-skill-del="${escapeHtml(s.id)}">${escapeHtml(t('action.remove'))}</button>
          </div>`,
        )
        .join('')}</div>`
    : `<p class="hint">${escapeHtml(t('skills.empty'))}</p>`;

  for (const btn of $('skill-list').querySelectorAll('[data-skill-toggle]')) {
    btn.addEventListener('click', async () => {
      await api.setSkillEnabled(btn.dataset.skillToggle, btn.dataset.on !== 'true');
      loadSkills();
    });
  }
  for (const btn of $('skill-list').querySelectorAll('[data-skill-del]')) {
    armed(btn, t('action.reallyRemove'), async () => {
      await api.deleteSkill(btn.dataset.skillDel);
      loadSkills();
    });
  }
}

$('skill-save').addEventListener('click', async () => {
  const status = $('skill-status');
  try {
    const { skill } = await api.saveSkill({
      name: $('skill-name').value,
      description: $('skill-description').value,
      instructions: $('skill-instructions').value,
    });
    status.textContent = t('skills.savedNamed', { name: skill.name });
    $('skill-name').value = '';
    $('skill-description').value = '';
    $('skill-instructions').value = '';
    loadSkills();
  } catch (err) {
    status.textContent = err.message;
  }
});

async function loadTasks() {
  const { tasks } = await api.tasks();
  $('task-list').innerHTML = tasks.length
    ? `<div class="rows">${tasks
        // Named `task`, not `t` — the parameter used to shadow the translator,
        // which is why every string in this block stayed English.
        .map((task) => {
          const when = task.cron ? t('tasks.everyCron', { cron: escapeHtml(task.cron) }) : t('tasks.once');
          const last = task.last_status
            ? ` · ${t('tasks.last', { status: escapeHtml(task.last_status).slice(0, 40) })}`
            : '';
          return `<div class="rows__item">
            <span class="grow">${escapeHtml(task.title)}
              <span class="muted">· ${when} · ${
                task.enabled
                  ? escapeHtml(t('tasks.next', { when: relativeWhen(task.next_run_at) }))
                  : escapeHtml(t('tasks.paused'))
              }${last}</span>
            </span>
            ${
              task.last_chat
                ? `<button data-task-open="${escapeHtml(task.last_chat)}">${escapeHtml(t('tasks.openResult'))}</button>`
                : ''
            }
            <button data-task-toggle="${escapeHtml(task.id)}" data-on="${!!task.enabled}">${escapeHtml(
              task.enabled ? t('tasks.pause') : t('tasks.resume'),
            )}</button>
            <button data-task-del="${escapeHtml(task.id)}">${escapeHtml(t('action.remove'))}</button>
          </div>`;
        })
        .join('')}</div>`
    : `<p class="hint">${escapeHtml(t('tasks.empty'))}</p>`;

  for (const btn of $('task-list').querySelectorAll('[data-task-toggle]')) {
    btn.addEventListener('click', async () => {
      await api.setTaskEnabled(btn.dataset.taskToggle, btn.dataset.on !== 'true');
      loadTasks();
    });
  }
  for (const btn of $('task-list').querySelectorAll('[data-task-open]')) {
    btn.addEventListener('click', () => {
      $('settings').close();
      openChat(btn.dataset.taskOpen);
    });
  }
  for (const btn of $('task-list').querySelectorAll('[data-task-del]')) {
    armed(btn, t('action.reallyRemove'), async () => {
      await api.deleteTask(btn.dataset.taskDel);
      loadTasks();
    });
  }
}

$('task-save').addEventListener('click', async () => {
  const status = $('task-status');
  try {
    const { task } = await api.createTask({
      title: $('task-title').value,
      prompt: $('task-prompt').value,
      when: $('task-when').value,
      repeat: $('task-repeat').checked,
    });
    status.textContent = t('tasks.scheduled', { when: relativeWhen(task.next_run_at) });
    $('task-title').value = '';
    $('task-prompt').value = '';
    loadTasks();
  } catch (err) {
    status.textContent = err.message;
  }
});

async function loadConnectors() {
  const { connectors } = await api.connectors();
  $('connector-list').innerHTML = connectors
    .map(
      (c) => `<div class="provider">
        <div class="provider__head">
          <span class="provider__name">${escapeHtml(c.label)}</span>
          <span class="badge ${c.connected ? 'badge--ok' : ''}">${
            c.connected ? escapeHtml(c.account || t('connectors.connected')) : escapeHtml(t('connectors.notConnected'))
          }</span>
        </div>
        <div class="hint">${escapeHtml(c.help)}</div>
        <div class="provider__row">
          <input type="password" data-token="${escapeHtml(c.id)}" placeholder="${escapeHtml(c.placeholder)}" autocomplete="off" />
          <button data-connect="${escapeHtml(c.id)}">${escapeHtml(c.connected ? t('connectors.replace') : t('mcp.add'))}</button>
          ${c.connected ? `<button data-disconnect="${escapeHtml(c.id)}">${escapeHtml(t('connectors.disconnect'))}</button>` : ''}
        </div>
      </div>`,
    )
    .join('');

  for (const btn of $('connector-list').querySelectorAll('[data-connect]')) {
    btn.addEventListener('click', async () => {
      const service = btn.dataset.connect;
      const field = $('connector-list').querySelector(`[data-token="${service}"]`);
      btn.disabled = true;
      try {
        const { account } = await api.connect(service, field.value);
        toast(t('connectors.connectedAs', { account }));
        loadConnectors();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }
  for (const btn of $('connector-list').querySelectorAll('[data-disconnect]')) {
    armed(btn, t('connectors.reallyDisconnect'), async () => {
      await api.disconnect(btn.dataset.disconnect);
      loadConnectors();
    });
  }
}

/* ── account ───────────────────────────────────────────────────── */

function renderUsagePanel(host, usage) {
  const { month, byModel, limit } = usage;
  const pct = limit ? Math.min(100, Math.round((month.tokens / limit) * 100)) : 0;
  const level = pct >= 100 ? 'is-full' : pct >= 80 ? 'is-high' : '';

  host.innerHTML =
    `<div class="provider">
      <div class="provider__head">
        <span class="provider__name">${escapeHtml(t('usage.tokens', { n: month.tokens.toLocaleString() }))}</span>
        <span class="badge">${escapeHtml(t('usage.calls', { n: month.calls }))} · $${month.cost.toFixed(4)}</span>
      </div>
      ${
        limit
          ? `<div class="meter"><div class="meter__fill ${level}" style="width:${pct}%"></div></div>
             <div class="hint">${escapeHtml(t('usage.sharedLimit', { pct, limit: limit.toLocaleString() }))}</div>`
          : `<div class="hint">${escapeHtml(t('usage.noLimit'))}</div>`
      }
    </div>` +
    (byModel.length
      ? `<div class="rows">${byModel
          .map(
            (m) => `<div class="rows__item">
              <span class="grow">${escapeHtml(m.model)}
                <span class="muted">· ${m.calls} calls</span>
              </span>
              <span class="muted">${(
                Number(m.input_tokens) + Number(m.output_tokens)
              ).toLocaleString()} tok</span>
            </div>`,
          )
          .join('')}</div>`
      : `<p class="hint">${escapeHtml(t('usage.empty'))}</p>`);
}

$('save-name').addEventListener('click', async () => {
  try {
    const { user } = await api.updateAccount({ name: $('account-name').value.trim() });
    state.boot.user = user;
    fillSettings();
    toast(t('account.nameUpdated'));
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ── two-factor ────────────────────────────────────────────────── */

const { renderTwoFactor } = createTwoFactor({ state, fillSettings: () => fillSettings() });

/* ── admin ─────────────────────────────────────────────────────── */

async function loadAdmin() {
  try {
    const { users } = await api.users();

    $('user-list').innerHTML = `<div class="rows">${users
      .map((u) => {
        const tags = [
          t('admin.chatCount', { n: u.chat_count }),
          t('admin.tokensThisMonth', { n: Number(u.tokens_this_month || 0).toLocaleString() }),
          u.has_worker ? t('admin.workerPaired') : null,
          u.email_verified_at ? null : t('admin.unconfirmed'),
          u.suspended_at ? t('admin.suspended') : null,
          u.monthly_token_limit ? t('admin.limit', { n: Number(u.monthly_token_limit).toLocaleString() }) : null,
        ].filter(Boolean);

        const self = u.id === state.boot.user.id;
        return `<div class="rows__item">
          <span class="grow">${escapeHtml(u.name || u.email)}
            <span class="muted">· ${escapeHtml(u.email)} · ${tags.join(' · ')}</span>
          </span>
          ${
            self
              ? `<span class="muted">${escapeHtml(t('admin.you'))}</span>`
              : `<button data-limit-user="${escapeHtml(u.id)}">${escapeHtml(t('admin.limitButton'))}</button>
                 <button data-suspend-user="${escapeHtml(u.id)}" data-suspended="${!!u.suspended_at}">
                   ${escapeHtml(u.suspended_at ? t('admin.unsuspend') : t('admin.suspend'))}
                 </button>
                 <button data-del-user="${escapeHtml(u.id)}">${escapeHtml(t('action.remove'))}</button>`
          }
        </div>`;
      })
      .join('')}</div>`;

    for (const btn of document.querySelectorAll('[data-del-user]')) {
      armed(btn, t('action.reallyRemove'), async () => {
        await api.deleteUser(btn.dataset.delUser);
        loadAdmin();
      });
    }
    for (const btn of document.querySelectorAll('[data-suspend-user]')) {
      btn.addEventListener('click', async () => {
        try {
          await api.updateUser(btn.dataset.suspendUser, { suspended: btn.dataset.suspended !== 'true' });
          loadAdmin();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
    // An inline field rather than prompt(), for the same reason as everything
    // else here: a suppressed dialog is indistinguishable from a dead button.
    for (const btn of document.querySelectorAll('[data-limit-user]')) {
      btn.addEventListener('click', () => {
        const field = document.createElement('input');
        field.type = 'number';
        field.min = '0';
        field.className = 'chat-item--editing';
        field.style.width = '9rem';
        field.placeholder = t('admin.limitPlaceholder');
        field.title = t('admin.tokenLimit');
        btn.replaceWith(field);
        field.focus();

        let settled = false;
        const finish = async (commit) => {
          if (settled) return;
          settled = true;
          if (!commit) return loadAdmin();
          try {
            await api.updateUser(btn.dataset.limitUser, { monthlyTokenLimit: Number(field.value) || 0 });
          } catch (err) {
            toast(err.message, 'error');
          }
          loadAdmin();
        };
        field.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') finish(true);
          if (event.key === 'Escape') finish(false);
        });
        field.addEventListener('blur', () => finish(true));
      });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('logout').addEventListener('click', async () => {
  await api.logout();
  location.reload();
});

/* ── model browser ─────────────────────────────────────────────── */

/**
 * There is one model, and two windows onto it.
 *
 * The header chip and Settings → Models are the same setting seen from two
 * places, so they cannot disagree — which is the whole point. Before this, the
 * chip was a *per-conversation* model and Settings was the *account default*:
 * two different values, two different labels, both on screen at once, and no way
 * to tell from looking that they were answering different questions. It read as a
 * bug every time, because in practice nobody wanted two.
 *
 * So a pick is a pick, wherever it is made: it is saved once, to the account, and
 * both places are repainted from it. Conversations follow it — including ones
 * opened later, which is why `openChat` no longer reads a stored model.
 *
 * The trade is real and worth stating: a conversation can no longer be pinned to
 * its own model. That was the cost of the two values, and it is what buys never
 * having to work out which of two numbers is the live one.
 */
const browser = createModelBrowser({
  onPick: async (modelId) => {
    // Repaint first: the press should feel immediate, and this is a preference
    // rather than something that can be refused halfway.
    const previous = state.model;
    state.model = modelId;
    renderTopbar();
    refreshModelFacts();

    try {
      state.boot.prefs = await api.savePrefs({ defaultModel: modelId });
      toast(t('model.switched', { model: modelId.split('/').pop() }));
    } catch (err) {
      // Put it back rather than leaving the chip claiming something that was
      // never stored — that is exactly the disagreement this change removes.
      state.model = previous;
      renderTopbar();
      refreshModelFacts();
      toast(err.message, 'error');
    }
  },
});

// The one way in to the picker, now that Settings no longer carries a second
// copy of the same control.
$('model-chip').addEventListener('click', () => browser.open(state.model));

$('save-behaviour').addEventListener('click', async () => {
  try {
    state.boot.prefs = await api.savePrefs({
      maxSteps: Number($('max-steps').value),
      autoCompact: $('auto-compact').value !== 'off',
      autoPreview: $('auto-preview').value !== 'off',
      systemPrompt: $('system-prompt').value,
    });
    renderTopbar();
    $('behaviour-status').textContent = t('status.saved');
    setTimeout(() => ($('behaviour-status').textContent = ''), 2000);
  } catch (err) {
    toast(err.message, 'error');
  }
});


/* ── your computers ────────────────────────────────────────────── */

const devices = createDevices({
  state,
  refreshWorker: () => refreshWorker(),
  armed,
});
const { renderPairChip, loadDevices } = devices;

/* ── a new model has arrived ───────────────────────────────────── */

const modelNews = createModelNews({
  state,
  renderTopbar: () => renderTopbar(),
  refreshModelFacts: () => refreshModelFacts(),
});

/* ── small menus ───────────────────────────────────────────────── */

let closeMenu = () => {};

/**
 * A popup anchored to the thing that opened it.
 *
 * The conversation row menu grew its own version of this first; this is the
 * general one, used by the context gauge and the approval policy. Same rules:
 * no browser dialogs, Escape closes, a click outside closes, and it is pulled
 * back inside the viewport rather than hanging off the edge on a phone.
 */
function openMenu(host, anchor, items) {
  closeMenu();
  host.innerHTML = '';

  for (const item of items) {
    if (item.static) {
      const head = document.createElement('div');
      head.className = 'menu__head';
      head.textContent = item.label;
      host.append(head);
      continue;
    }

    // A whole element, handed over as-is: the effort row at the foot of the
    // mode menu adjusts a setting without choosing anything, so it must not be
    // a menu item that closes on click.
    if (item.node) {
      host.append(item.node);
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu__item${item.active ? ' is-active' : ''}`;
    // Choosing between modes is a radio group; the context gauge's menu is a
    // list of actions. Only the first kind gets a checked state to announce.
    const choice = item.active !== undefined;
    button.setAttribute('role', choice ? 'menuitemradio' : 'menuitem');
    if (choice) button.setAttribute('aria-checked', String(!!item.active));
    button.innerHTML =
      // `item.icon` is our own markup, never anything typed by a person.
      (item.icon ? `<span class="menu__icon">${item.icon}</span>` : '') +
      `<span class="menu__body"><span>${escapeHtml(item.label)}</span>` +
      (item.hint ? `<span class="menu__hint">${escapeHtml(item.hint)}</span>` : '') +
      '</span>' +
      (item.active ? '<span class="menu__check" aria-hidden="true">✓</span>' : '');

    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeMenu();
      try {
        await item.run();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    host.append(button);
  }

  host.hidden = false;
  const box = anchor.getBoundingClientRect();
  const size = host.getBoundingClientRect();
  const left = Math.min(box.left, window.innerWidth - size.width - 8);
  const below = box.bottom + 8;
  const top = below + size.height > window.innerHeight - 8 ? box.top - size.height - 8 : below;
  host.style.left = `${Math.max(8, left)}px`;
  host.style.top = `${Math.max(8, top)}px`;

  const onKey = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  const onOutside = (event) => {
    if (!host.contains(event.target) && event.target !== anchor) closeMenu();
  };

  /**
   * Put focus back on the button that opened this.
   *
   * The menu never focused anything on open and never restored anything on
   * close, so a keyboard user pressing the policy chip got a menu they could
   * only reach by carrying on tabbing forward through the document — and
   * closing it left focus wherever that had ended up. `aria-haspopup="menu"`
   * on the chip promised a state that nothing ever set.
   */
  anchor.setAttribute('aria-expanded', 'true');
  host.querySelector('button:not([disabled])')?.focus();

  closeMenu = () => {
    host.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onOutside);
    window.removeEventListener('resize', closeMenu);
    closeMenu = () => {};
    if (anchor.isConnected && (!document.activeElement || document.activeElement === document.body)) {
      anchor.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onOutside);
  window.addEventListener('resize', closeMenu);
}

/* ── how full the window is ────────────────────────────────────── */

/**
 * The context gauge.
 *
 * Every turn re-sends the whole conversation, so a long one eventually stops
 * fitting — and until now nothing said so until it failed. A ring rather than a
 * number because the shape reads without being read: a quarter full is obviously
 * fine, and the number only starts mattering when it is nearly full, which is
 * exactly when it appears.
 */
const RING = 2 * Math.PI * 13; // r=13 in the SVG

function renderContext(info) {
  state.context = info || null;
  const gauge = $('context-gauge');

  if (!info?.context) {
    gauge.hidden = true;
    return;
  }

  const ratio = Math.min(1, Math.max(0, info.ratio ?? 0));
  const percent = Math.round(ratio * 100);

  gauge.hidden = false;
  gauge.querySelector('.gauge__fill').style.strokeDasharray = `${RING * ratio} ${RING}`;
  // The number joins in only once it is worth knowing. The class goes with it:
  // without a number the control is a circle, with one it is a pill, and the
  // padding each needs is different.
  const showNumber = ratio >= 0.5;
  $('context-percent').textContent = showNumber ? `${percent}%` : '';
  gauge.classList.toggle('has-number', showNumber);
  gauge.classList.toggle('is-warm', ratio >= 0.6);
  gauge.classList.toggle('is-hot', ratio >= 0.85);

  const used = Math.round(info.used / 1000);
  const total = Math.round(info.budget / 1000);
  gauge.title = t(info.exact ? 'context.gauge' : 'context.gaugeEstimated', { percent, used, total });
}

const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));

$('context-gauge').addEventListener('click', () => {
  const info = state.context;
  if (!info) return;
  const percent = Math.round((info.ratio ?? 0) * 100);

  openMenu($('context-menu'), $('context-gauge'), [
    {
      label: t('context.menuUsed', { percent, used: fmtK(info.used), total: fmtK(info.budget) }),
      static: true,
    },
    {
      label: state.boot.prefs.autoCompact === false ? t('compact.turnOn') : t('compact.turnOff'),
      hint:
        state.boot.prefs.autoCompact === false
          ? t('compact.onHint')
          : t('compact.offHint'),
      async run() {
        state.boot.prefs = await api.savePrefs({ autoCompact: state.boot.prefs.autoCompact === false });
        toast(
          state.boot.prefs.autoCompact
            ? t('compact.isOn')
            : t('compact.isOff'),
        );
      },
    },
    {
      label: t('compact.now'),
      hint: t('compact.nowHint'),
      async run() {
        if (!state.chatId) return toast(t('compact.nothing'));
        toast(t('compact.working'));
        const { summary, context } = await api.compactChat(state.chatId);
        renderContext(context);
        toast(t('chat.summarised', { n: summary.replaced }));
        await openChat(state.chatId);
      },
    },
  ]);
});

/* ── photos and files ──────────────────────────────────────────── */

/**
 * Staging, uploading and the vision warning all live in `attachments.js`.
 * Created here rather than at the top of the file because it needs the model
 * browser and the onboarding guide, and those are built further up.
 */
const attachments = createAttachments({
  state,
  refreshSendState: () => refreshSendState(),
  renderTopbar: () => renderTopbar(),
  onboarding,
  openModelBrowser: (model) => browser.open(model),
});
const { staged, renderStaged, clearStaged, refreshModelFacts, renderVisionWarning } = attachments;

/* ── appearance ────────────────────────────────────────────────── */

/**
 * Dark, light, or whatever the operating system says.
 *
 * Kept in localStorage rather than in preferences on the server, because it is a
 * property of the screen you are looking at: a phone in the sun and a desk at
 * midnight want different answers from the same account.
 *
 * "system" removes the attribute entirely rather than writing a value, which is
 * what lets the `prefers-color-scheme` rules in app.css take over — including
 * when the OS switches at sunset while the page is still open.
 */
const THEME_KEY = 'ai-remote:theme';

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'dark' || choice === 'light') root.dataset.theme = choice;
  else delete root.dataset.theme;

  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private browsing refuses storage; the choice still holds this session */
  }
}

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

// Applied at import time, before the app renders, so a light-theme user never
// sees a dark flash on the way in.
applyTheme(storedTheme());

$('theme').addEventListener('change', (event) => applyTheme(event.target.value));

/* ── layout plumbing ───────────────────────────────────────────── */

function renderSuggestions() {
  $('suggestions').innerHTML = '';
  for (const text of SUGGESTIONS) {
    const btn = document.createElement('button');
    btn.className = 'suggestion';
    btn.type = 'button';
    btn.textContent = text;
    // Through `setComposerText`, so the send button lights up. Doing it by hand
    // here is what made a pressed suggestion look like nothing had happened.
    btn.addEventListener('click', () => setComposerText(text));
    $('suggestions').append(btn);
  }
}

const input = $('input');
function autosize(node) {
  node.style.height = 'auto';
  node.style.height = `${node.scrollHeight}px`;
}
/**
 * Light the send button only when pressing it would do something.
 *
 * A button that is always green stops meaning "ready" and becomes decoration.
 * Grey while there is nothing to send, and green the moment there is, makes the
 * control answer the question you were about to ask it.
 */
/**
 * One button at a time: send, or stop.
 *
 * Both used to sit there together while a turn ran, and the pair asked a
 * question nobody wanted: two similar round buttons side by side, one of which
 * ends the work. The composer already knows which one you mean. With something
 * typed you mean send — queued into the running turn, which is why send stays
 * live mid-run rather than being disabled. With the box empty during a run
 * there is nothing to send, so the only thing that button could be for is stop.
 *
 * The placeholder carries the same fact in words, because a changed glyph is
 * easy to miss: while a turn is running it says what sending will actually do,
 * which is queue rather than send.
 */
function refreshSendState() {
  const ready = input.value.trim().length > 0 || staged.some((f) => f.id);
  const running = !!runHere();

  // Empty and working: the button in that corner is stop. Anything else: send.
  const showStop = running && !ready;

  $('send').hidden = showStop;
  $('send').classList.toggle('is-ready', ready);
  $('send').disabled = !ready;
  // Say what pressing it does now, since mid-run it does not send but queue.
  $('send').title = running ? t('composer.queue') : t('composer.send');

  $('stop').hidden = !showStop;

  input.placeholder = running ? t('composer.placeholderRunning') : t('composer.placeholder');
}

/**
 * Put text in the composer, from anywhere that is not typing.
 *
 * There is one function for this because there were two callers doing it by hand
 * and both had the same bug: setting `.value` from script fires no `input` event,
 * so `refreshSendState` never ran, and the send button stayed grey **and
 * disabled**. Pressing a suggestion appeared to do nothing, then pressing send
 * appeared to do nothing either — which reads as a broken app rather than a
 * missing line of code.
 *
 * Anything that fills the box goes through here.
 */
function setComposerText(text) {
  input.value = String(text ?? '');
  autosize(input);
  refreshSendState();
  input.focus();
  // Put the caret at the end, so typing continues the sentence rather than
  // landing in front of it.
  input.setSelectionRange(input.value.length, input.value.length);
}

input.addEventListener('input', () => {
  autosize(input);
  refreshSendState();
});
// The box starts empty, so the button starts grey. Setting it here rather than
// in the markup keeps one rule for the state instead of two that can disagree.
refreshSendState();

input.addEventListener('keydown', (event) => {
  // Enter sends on desktop; on touch keyboards it should insert a newline.
  const touch = matchMedia('(hover: none)').matches;
  if (event.key === 'Enter' && !event.shiftKey && !touch) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

const thread = $('thread');

/** True while the reader is at the end, so new output should follow them down. */
let pinned = true;
thread.addEventListener('scroll', () => {
  pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
});

/**
 * Keep the transcript's bottom padding equal to the dock's real height.
 *
 * The composer grows as you type and the approval bar comes and goes, so a
 * fixed number would either hide the newest message behind the box or leave a
 * hole under it. Measuring is the only version that stays right.
 */
{
  const dock = $('dock');
  const main = document.querySelector('.main');

  /**
   * How wide this browser's scrollbar is, so the dock can stop short of it.
   *
   * The dock is painted over the transcript and a classic scrollbar lives
   * inside the transcript's own box, so a dock reaching the right edge covers
   * the thumb — most visibly when the conversation is long, the thumb is short
   * and it is sitting at the bottom, which is precisely when somebody is
   * looking for it. Zero on the overlay scrollbars macOS and phones use, so
   * there is nothing to subtract there and nothing to look wrong.
   */
  const measureScrollbar = () => {
    const width = Math.max(0, Math.round(thread.offsetWidth - thread.clientWidth));
    main.style.setProperty('--sb-w', `${width}px`);
  };

  const observer = new ResizeObserver(() => {
    const follow = pinned;
    main.style.setProperty('--dock-h', `${Math.round(dock.offsetHeight)}px`);
    measureScrollbar();
    // Growing the padding pushes content up; stay at the end if we were there.
    if (follow) thread.scrollTop = thread.scrollHeight;
  });
  observer.observe(dock);
  // And on the thread itself: a conversation that grows past one screen gains a
  // scrollbar, which is a change in width nothing else would notice.
  observer.observe(thread);
  measureScrollbar();
}
function scrollToEnd() {
  pinned = true;
  requestAnimationFrame(() => thread.scrollTo({ top: thread.scrollHeight }));
}
/**
 * Keep the transcript pinned to the bottom, at most once a frame.
 *
 * Called from six stream handlers, so it ran on every `thinking` and every
 * `text` delta — and reading `scrollHeight` immediately after writing markup
 * forces a synchronous reflow of the whole transcript. Write, read, write, read,
 * per token, on the longest DOM in the app: textbook layout thrash, and it
 * compounded the per-token re-parse in `render.js` rather than merely adding to
 * it.
 *
 * Batched onto the same frame as the repaint, so the measurement happens once,
 * after the DOM has settled, instead of once per token before it has.
 */
let scrollQueued = false;
function maybeScroll(run = null) {
  // A run drawing into a detached stage has nothing to scroll to, and stealing
  // the view for a conversation that is not on screen would be worse than not
  // following at all.
  if (run && !onScreen(run)) return;
  if (!pinned || scrollQueued) return;
  scrollQueued = true;
  const apply = () => {
    scrollQueued = false;
    // Re-checked: the user may have scrolled up in the meantime, and stealing
    // the view back from somebody reading is worse than not following.
    if (pinned) thread.scrollTop = thread.scrollHeight;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
  else setTimeout(apply, 16);
}

/* ── the detail rail ───────────────────────────────────────────── */

const DETAIL_KEY = 'ai-remote:detail';

function setDetail(open) {
  $('app').classList.toggle('is-detail', open);
  $('detail-toggle').setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem(DETAIL_KEY, open ? '1' : '0');
  } catch {
    /* private browsing refuses storage; the toggle still works this session */
  }
}

$('detail-toggle').addEventListener('click', () => {
  setDetail(!$('app').classList.contains('is-detail'));
});
$('detail-close').addEventListener('click', () => setDetail(false));

try {
  if (localStorage.getItem(DETAIL_KEY) === '1') setDetail(true);
} catch {
  /* no storage, no memory — closed is the right default */
}

/** Auto-open the rail once per run, so closing it stays closed. */
let detailShownForRun = false;
function resetDetailAutoOpen() {
  detailShownForRun = false;
}

/**
 * Show the plan beside the conversation as it is worked through.
 *
 * The same steps still appear inline in the transcript, because that is the
 * record of what happened; this is the live view of where things stand, which
 * is a different question and wants to stay put rather than scroll away.
 */
function renderProgress(steps) {
  const list = $('progress-steps');
  const items = Array.isArray(steps) ? steps : [];

  $('progress-empty').hidden = items.length > 0;

  // This rail rewrites itself as the work moves and said nothing to a screen
  // reader. Announced politely so the current step is read when it changes
  // without cutting across whatever is already being spoken.
  list.setAttribute('aria-live', 'polite');

  list.innerHTML = items
    .map((s) => {
      const cls = s.status === 'done' ? 'is-done' : s.status === 'in_progress' ? 'is-active' : '';
      const mark = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▸' : '○';
      // The mark is decorative: aria-current carries the same fact, and read
      // aloud the glyph is just a shape.
      return (
        `<li class="${cls}"${s.status === 'in_progress' ? ' aria-current="step"' : ''}>` +
        `<span aria-hidden="true">${mark}</span><span>${escapeHtml(s.title)}</span></li>`
      );
    })
    .join('');

  const done = items.filter((s) => s.status === 'done').length;
  // Was `${done} of ${items.length}`, which put an English "of" in the middle of
  // a Vietnamese interface. The separator belongs to the language, not the code.
  $('progress-count').textContent = items.length
    ? t('chat.planCount', { done, total: items.length })
    : '';

  // A plan is the assistant saying "this will take a while" — worth showing
  // without being asked, but only the first time, so closing it stays closed.
  if (items.length && !detailShownForRun) {
    detailShownForRun = true;
    setDetail(true);
  }
}

function openSidebar() {
  $('app').classList.add('is-open');
  $('scrim').hidden = false;
}
function closeSidebar() {
  $('app').classList.remove('is-open');
  $('scrim').hidden = true;
}
$('sidebar-open').addEventListener('click', openSidebar);
$('sidebar-close').addEventListener('click', closeSidebar);
$('scrim').addEventListener('click', closeSidebar);

/* ── collapsing the sidebar to a rail ──────────────────────────── */

const RAIL_KEY = 'ai-remote:rail';

function setRail(collapsed) {
  $('app').classList.toggle('is-rail', collapsed);

  // Open, the header's own button does the closing and the logo goes back to
  // being a logo — disabled rather than merely unstyled, so it cannot be
  // clicked or tabbed to while it looks inert.
  //
  // Collapsed, the rail has no header edge to hang a button on, so the mark
  // takes the job back. `aria-label` but deliberately no `title` there: the
  // native tooltip appears below the cursor a moment later, a second and
  // differently-placed explanation of a control that already explains itself by
  // swapping in the panel glyph the instant you point at it.
  const toggle = $('sidebar-toggle');
  toggle.disabled = !collapsed;
  if (collapsed) {
    toggle.setAttribute('aria-label', t('action.expandMenu'));
    toggle.setAttribute('aria-expanded', 'false');
  } else {
    // Not a control in this state; leaving the words on it would have a screen
    // reader announce a collapse button that is not the one you can press.
    toggle.removeAttribute('aria-label');
    toggle.removeAttribute('aria-expanded');
  }

  try {
    localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
  } catch {
    // Private browsing refuses storage; the toggle still works for this session.
  }
}

const toggleRail = () => setRail(!$('app').classList.contains('is-rail'));
$('sidebar-toggle').addEventListener('click', toggleRail);
$('sidebar-collapse').addEventListener('click', toggleRail);

// Restore before anything paints, so it does not visibly snap shut on load.
try {
  // Called either way, not only when collapsed. It is what sets the toggle's
  // label and expanded state, so skipping it in the ordinary case left the
  // control unnamed to a screen reader for the whole session.
  setRail(localStorage.getItem(RAIL_KEY) === '1');
} catch {
  setRail(false); // no storage, no memory — expanded is the right default
}

/* ── searching conversations ───────────────────────────────────── */

const searchDialog = $('search');
let searchDebounce = null;

/** The stored body is JSONB, so trim it back to something readable. */
function snippetAround(raw, query) {
  if (!raw) return '';
  const text = String(raw)
    .replace(/\\n/g, ' ')
    .replace(/[{}[\]"]/g, ' ')
    .replace(/\b(id|role|type|text|content|seq)\b\s*:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 140);
  return `${at > 30 ? '…' : ''}${text.slice(Math.max(0, at - 30), at + 110)}…`;
}

async function runSearch() {
  const query = $('search-input').value.trim();
  const results = $('search-results');
  $('search-clear').hidden = !query;

  if (query.length < 2) {
    results.innerHTML = `<p class="hint">${escapeHtml(t('search.tooShort'))}</p>`;
    return;
  }

  results.innerHTML = `<p class="hint">${escapeHtml(t('search.searching'))}</p>`;
  let chats;
  try {
    ({ chats } = await api.searchChats(query));
  } catch (err) {
    results.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!chats.length) {
    results.innerHTML = `<p class="hint">${escapeHtml(t('search.noMatch', { query }))}</p>`;
    return;
  }

  results.innerHTML = chats
    .map((c) => {
      const snippet = snippetAround(c.snippet, query);
      return `<button class="model-card" data-chat="${escapeHtml(c.id)}" type="button">
        <span class="model-card__main">
          <span class="model-card__name">${escapeHtml(c.title || t('chat.untitled'))}</span>
          ${snippet ? `<span class="model-card__meta">${escapeHtml(snippet)}</span>` : ''}
        </span>
      </button>`;
    })
    .join('');

  for (const btn of results.querySelectorAll('[data-chat]')) {
    btn.addEventListener('click', () => {
      searchDialog.close();
      openChat(btn.dataset.chat);
    });
  }
}

$('open-search').addEventListener('click', () => {
  closeSidebar();
  searchDialog.showModal();
  $('search-input').value = '';
  $('search-clear').hidden = true;
  $('search-results').innerHTML = `<p class="hint">${escapeHtml(t('search.lede'))}</p>`;
  // Opening the on-screen keyboard the instant a sheet appears is jarring on a
  // phone, so only autofocus where there is a real keyboard.
  if (!matchMedia('(hover: none)').matches) $('search-input').focus();
});

$('search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 200);
});

$('search-clear').addEventListener('click', () => {
  $('search-input').value = '';
  $('search-input').focus();
  runSearch();
});

$('open-projects').addEventListener('click', () => {
  closeSidebar();
  gotoShelf('projects');
});

wireCopyButtons(document.body);

/**
 * Scrollbars that show themselves only while they are being used.
 *
 * The CSS hides the thumb at rest and shows it on hover; this adds the other
 * half — visible while the region is actually moving, gone a moment after it
 * stops. That is what makes it disappear when you reach the end of the
 * transcript and let go, instead of leaving a grey stripe down a dark page for
 * as long as the pointer happens to be over the text.
 *
 * `passive`, because this only ever adds a class and must never be a reason a
 * scroll janks.
 */
for (const region of document.querySelectorAll('.scroll-quiet')) {
  let idle = null;
  region.addEventListener(
    'scroll',
    () => {
      region.classList.add('is-scrolling');
      clearTimeout(idle);
      idle = setTimeout(() => region.classList.remove('is-scrolling'), 700);
    },
    { passive: true },
  );
}

boot().catch((err) => {
  /**
   * `textContent`, not `innerHTML`.
   *
   * This replaces the entire document, so anything that reached the message
   * would run with the session's full authority — and the message is not ours:
   * it can carry text from a server response. A failure page is the worst place
   * in the app to be lenient about markup, and it was the last unescaped sink
   * left in it.
   */
  const pre = document.createElement('pre');
  pre.style.padding = '24px';
  pre.style.color = '#ff6b6b';
  pre.textContent = err?.message || String(err);
  document.body.replaceChildren(pre);
});
