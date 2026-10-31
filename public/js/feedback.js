import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * Give feedback, the way Claude asks for it (owner, 2026-10-31): first what it
 * is about — a list of the app's parts, or anything typed — then its kind, then
 * what happened; on the second page how much it matters, how often, whether it
 * worked before, and, only if switched on, which conversation to include.
 *
 * It goes to the people who run this deployment (server/routes/feedback.js),
 * never to a model, and the note above the button says exactly what is sent.
 *
 * @typedef {{ chats: () => { id: string, title?: string }[], currentChat: () => string | null, send: (body: any) => Promise<any>, done: () => void, version: () => Promise<string>, language: () => string }} Deps
 */

const svg = (paths) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** The parts of the app, in Claude's order, each with the glyph its own place in the app uses. */
export const TOPICS = [
  ['files', svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.3l1.6 1.8h7.1A1.5 1.5 0 0 1 17.5 7.8v6.7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5Z"/>')],
  ['connectors', svg('<rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="11" width="6" height="6" rx="1.2"/><path d="M14 3v6M11 6h6"/><rect x="3" y="11" width="6" height="6" rx="1.2"/>')],
  ['web', svg('<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2 2.9 4.4 2.9 7S12 15 10 17c-2-2-2.9-4.4-2.9-7S8 5 10 3Z"/>')],
  ['scheduled', svg('<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.6 1.6"/>')],
  ['projects', svg('<path d="M6 3.5h8M4.2 6.5h11.6"/><rect x="2.5" y="9.5" width="15" height="7.5" rx="2"/>')],
  ['artifacts', svg('<rect x="2.5" y="6.5" width="11" height="11" rx="2.2"/><path d="M6.5 6.5V4.7a2.2 2.2 0 0 1 2.2-2.2h6.6a2.2 2.2 0 0 1 2.2 2.2v6.6a2.2 2.2 0 0 1-2.2 2.2h-1.8"/>')],
  ['workflows', svg('<path d="M3.5 5.5l1.5 1.5 2.5-3M10 5.5h6.5M3.5 13.5h4M10 13.5h6.5"/><circle cx="5.5" cy="13.5" r="1.6"/>')],
  ['cloud', svg('<rect x="2.5" y="3.5" width="15" height="10" rx="1.6"/><path d="M7 17h6M10 13.5V17"/>')],
  ['interface', svg('<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M7 3.5v13"/>')],
  ['limits', svg('<path d="M4 16V10M8.7 16V5M13.3 16v-7M18 16H2"/>')],
  ['behaviour', svg('<path d="M10 3v14M5 17h10M4 6h12"/><path d="M4 6l-2 5a2.6 2.6 0 0 0 4 0Zm12 0-2 5a2.6 2.6 0 0 0 4 0Z"/>')],
  ['refusal', svg('<path d="M10 2.5 16.5 5v4.6c0 3.8-2.7 6.7-6.5 7.9-3.8-1.2-6.5-4.1-6.5-7.9V5Z"/><path d="M10 7v3.5"/><circle cx="10" cy="13" r=".4" fill="currentColor"/>')],
];
const OTHER_ICON = svg('<path d="M13.5 2.9a1.9 1.9 0 0 1 2.7 2.7L7.8 14 4 15l1-3.8Z"/>');
const KINDS = ['bug', 'performance', 'feature'];
const AFFECT = ['minor', 'workaround', 'blocks'];
const FREQUENCY = ['rare', 'weekly', 'daily'];
const WORKED = ['worked', 'unknown', 'never'];
const CHEVRON = (dir) => svg(dir === 'left' ? '<path d="m12 5-5 5 5 5"/>' : '<path d="m8 5 5 5-5 5"/>');
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
const shortcut = `<span class="fb__keys"><kbd>${MOD}</kbd><kbd>⏎</kbd></span>`;

/**
 * What people sent, for an administrator in Settings → People: newest first,
 * unread marked, each one's conversation folded under it when they included one.
 *
 * @param {HTMLElement} host
 * @param {any[]} items  `GET /api/admin/feedback`
 * @param {(date: Date) => string} when
 */
export function renderFeedbackList(host, items, when) {
  if (!items.length) {
    host.innerHTML = `<p class="hint">${escapeHtml(t('feedback.admin.none'))}</p>`;
    return;
  }
  host.innerHTML = `<div class="fbadmin">${items
    .map((f) => {
      const who = f.username || f.name || f.email;
      const about = f.topic === 'other' ? f.topic_other || t('feedback.topic.other') : t(`feedback.topic.${f.topic}`);
      const tags = [t(`feedback.kind.${f.kind}`), about, t(`feedback.affect.${f.affect}`), f.frequency ? t(`feedback.frequency.${f.frequency}`) : null, f.worked_before ? t(`feedback.worked.${f.worked_before}`) : null].filter(Boolean);
      const transcript = f.transcript?.messages?.length
        ? `<details class="fbadmin__chat"><summary>${escapeHtml(t('feedback.admin.chat', { title: f.chat_title || t('chat.untitled'), n: String(f.transcript.messages.length) }))}</summary>${f.transcript.messages
            .map((m) => `<p class="fbadmin__line"><strong>${escapeHtml(t(m.role === 'user' ? 'feedback.admin.user' : 'feedback.admin.assistant'))}</strong> ${escapeHtml(m.text)}</p>`)
            .join('')}</details>`
        : '';
      return `<article class="fbadmin__item${f.read_at ? '' : ' is-unread'}" data-feedback="${escapeHtml(f.id)}">
        <header><strong>${escapeHtml(who)}</strong> <span class="muted">· ${escapeHtml(f.email)} · ${escapeHtml(when(new Date(f.created_at)))}</span></header>
        <p class="fbadmin__tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</p>
        <p class="fbadmin__body">${escapeHtml(f.body)}</p>
        ${transcript}
        <p class="muted">${escapeHtml([f.client?.version, f.client?.language, f.client?.browser].filter(Boolean).join(' · '))}</p>
        <div class="fbadmin__actions">${f.read_at ? '' : `<button type="button" class="btn btn--ghost btn--small" data-feedback-read="${escapeHtml(f.id)}">${escapeHtml(t('feedback.admin.markRead'))}</button>`}<button type="button" class="btn btn--ghost btn--small" data-feedback-delete="${escapeHtml(f.id)}">${escapeHtml(t('action.remove'))}</button></div>
      </article>`;
    })
    .join('')}</div>`;
}

/** @param {Deps} deps */
export function createFeedback(deps) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet fb';
  dialog.id = 'feedback';
  dialog.setAttribute('aria-labelledby', 'feedback-title');
  document.body.append(dialog);

  /** Focus the first element matching, if there is one. */
  const focusOn = (selector) => /** @type {HTMLElement | null} */ (dialog.querySelector(selector))?.focus();

  /** @type {{ page: number, topic: string | null, other: string, kind: string | null, body: string, affect: string | null, frequency: string | null, worked: string | null, include: boolean, chatId: string | null, picking: boolean, sending: boolean }} */
  let s;
  const reset = () => {
    s = { page: 1, topic: null, other: '', kind: null, body: '', affect: null, frequency: null, worked: null, include: false, chatId: deps.currentChat(), picking: false, sending: false };
  };

  const topicLabel = () => (s.topic === 'other' ? s.other : t(`feedback.topic.${s.topic}`));
  const firstDone = () => !!(s.topic && s.kind && s.body.trim());

  const chips = (name, values, chosen, required = false) =>
    `<div class="fb__chips" role="radiogroup" aria-required="${required}">${values
      .map((v) => `<button type="button" role="radio" class="fb__chip" data-${name}="${v}" aria-checked="${chosen === v}">${escapeHtml(t(`feedback.${name}.${v}`))}</button>`)
      .join('')}</div>`;

  function pageOne() {
    const about = s.topic
      ? `<div class="fb__chosen"><span>${escapeHtml(topicLabel())}</span><button type="button" class="fb__change" data-change>${escapeHtml(t('feedback.change'))}</button></div>`
      : `<div class="fb__topics">${TOPICS.map(([id, icon]) => `<button type="button" class="fb__topic" data-topic="${id}"><span class="fb__icon">${icon}</span>${escapeHtml(t(`feedback.topic.${id}`))}</button>`).join('')}
          <div class="fb__topic fb__topic--other"><span class="fb__icon">${OTHER_ICON}</span><input type="text" id="fb-other" maxlength="200" placeholder="${escapeHtml(t('feedback.topic.other'))}" aria-label="${escapeHtml(t('feedback.topic.other'))}" value="${escapeHtml(s.other)}" /><button type="button" class="icon-btn" data-other aria-label="${escapeHtml(t('feedback.useOther'))}" ${s.other.trim() ? '' : 'disabled'}>${CHEVRON('right')}</button></div>
        </div>`;
    const kind = s.topic ? `<h3 class="fb__q">${escapeHtml(t('feedback.kindQ'))} <span class="fb__req" aria-hidden="true">*</span></h3>${chips('kind', KINDS, s.kind, true)}` : '';
    const text = s.kind
      ? `<textarea id="fb-body" class="fb__text" rows="5" maxlength="5000" placeholder="${escapeHtml(t(s.kind === 'feature' ? 'feedback.placeholderFeature' : 'feedback.placeholder'))}" aria-label="${escapeHtml(t('feedback.describe'))}">${escapeHtml(s.body)}</textarea>`
      : '';
    return `<h3 class="fb__q">${escapeHtml(t('feedback.aboutQ'))} <span class="fb__req" aria-hidden="true">*</span></h3>${about}${kind}${text}`;
  }

  function pageTwo() {
    const chats = deps.chats();
    const chosen = chats.find((c) => c.id === s.chatId) || chats[0] || null;
    if (chosen && !s.chatId) s.chatId = chosen.id;
    const include = s.affect
      ? `<div class="fb__include">
          <div class="fb__include-head">
            <div><p class="fb__strong">${escapeHtml(t('feedback.include'))}</p>${s.include ? `<p class="fb__muted">${escapeHtml(t('feedback.includeHint'))}</p>` : ''}</div>
            <button type="button" class="fb__switch" role="switch" aria-checked="${s.include}" data-include aria-label="${escapeHtml(t('feedback.include'))}" ${chats.length ? '' : 'disabled'}></button>
          </div>
          ${
            s.include && chosen
              ? `<div class="fb__pick"><button type="button" class="fb__pick-btn" data-pick aria-haspopup="listbox" aria-expanded="${s.picking}">${escapeHtml(chosen.title || t('chat.untitled'))}${svg('<path d="m6 8 4 4 4-4"/>')}</button>
                 ${s.picking ? `<ul class="fb__list" role="listbox" aria-label="${escapeHtml(t('feedback.include'))}">${chats.slice(0, 20).map((c) => `<li role="option" tabindex="-1" aria-selected="${c.id === chosen.id}" data-chat="${escapeHtml(c.id)}">${escapeHtml(c.title || t('chat.untitled'))}${c.id === chosen.id ? '<span class="fb__check" aria-hidden="true">✓</span>' : ''}</li>`).join('')}</ul>` : ''}</div>`
              : ''
          }
          <p class="fb__note">${escapeHtml(t(s.include ? 'feedback.noteWith' : 'feedback.note'))} <button type="button" class="fb__link" data-whats-included aria-expanded="false">${escapeHtml(t('feedback.whatsIncluded'))}</button></p>
          <p class="fb__muted fb__included" hidden>${escapeHtml(t('feedback.included'))}</p>
        </div>`
      : '';
    return `<h3 class="fb__q">${escapeHtml(t('feedback.affectQ'))} <span class="fb__req" aria-hidden="true">*</span></h3>${chips('affect', AFFECT, s.affect, true)}
      <h3 class="fb__q">${escapeHtml(t('feedback.frequencyQ'))}</h3>${chips('frequency', FREQUENCY, s.frequency)}
      <h3 class="fb__q">${escapeHtml(t('feedback.workedQ'))}</h3>${chips('worked', WORKED, s.worked)}
      ${include}`;
  }

  function paint() {
    const one = s.page === 1;
    const canNext = firstDone();
    const pager = `<div class="fb__pager"><button type="button" class="icon-btn" data-prev ${one ? 'disabled' : ''} aria-label="${escapeHtml(t('action.back'))}">${CHEVRON('left')}</button><span>${escapeHtml(t('feedback.page', { n: String(s.page) }))}</span><button type="button" class="icon-btn" data-next ${one && canNext ? '' : 'disabled'} aria-label="${escapeHtml(t('feedback.next'))}">${CHEVRON('right')}</button></div>`;
    const actions = one
      ? canNext
        ? `<button type="button" class="btn fb__go" data-next>${escapeHtml(t('feedback.next'))} ${shortcut}</button>`
        : ''
      : `<button type="button" class="btn btn--ghost" data-prev>${escapeHtml(t('action.back'))}</button><button type="button" class="btn fb__go" data-submit ${s.affect && !s.sending ? '' : 'disabled'}>${escapeHtml(t('feedback.submit'))} ${shortcut}</button>`;
    dialog.innerHTML = `<form method="dialog" class="fb__head"><h2 id="feedback-title">${escapeHtml(t('feedback.title'))}</h2><button class="icon-btn" value="close" aria-label="${escapeHtml(t('action.close'))}">✕</button></form>
      <div class="fb__body">${one ? pageOne() : pageTwo()}</div>
      <div class="fb__foot">${pager}<span class="fb__spacer"></span>${actions}</div>`;
  }

  /** Repaint, keeping the caret where somebody was typing. */
  function repaint(focusId) {
    const active = /** @type {HTMLInputElement | null} */ (document.activeElement);
    const keep = focusId || (dialog.contains(active) ? active?.id : '');
    const at = active?.selectionStart ?? null;
    paint();
    const again = /** @type {HTMLInputElement | null} */ (keep ? dialog.querySelector(`#${keep}`) : null);
    if (again) {
      again.focus();
      if (at != null && again.setSelectionRange) again.setSelectionRange(at, at);
    }
  }

  async function submit() {
    if (!s.affect || s.sending) return;
    s.sending = true;
    paint();
    try {
      await deps.send({
        topic: s.topic,
        topicOther: s.topic === 'other' ? s.other : undefined,
        kind: s.kind,
        body: s.body,
        affect: s.affect,
        frequency: s.frequency || undefined,
        workedBefore: s.worked || undefined,
        chatId: s.include ? s.chatId : undefined,
        language: deps.language(),
        version: await deps.version(),
      });
      dialog.close();
      deps.done();
    } catch {
      s.sending = false;
      paint();
    }
  }

  const goNext = () => {
    if (s.page === 1 && firstDone()) {
      s.page = 2;
      repaint();
      focusOn('[data-affect]');
    }
  };

  dialog.addEventListener('input', (event) => {
    const el = /** @type {HTMLInputElement} */ (event.target);
    if (el.id === 'fb-body') {
      const had = firstDone();
      s.body = el.value;
      // The Next button appears once there are words — repainted only then, so typing stays smooth.
      if (had !== firstDone()) repaint('fb-body');
    } else if (el.id === 'fb-other') {
      const had = !!s.other.trim();
      s.other = el.value;
      if (had !== !!s.other.trim()) repaint('fb-other');
    }
  });

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (s.page === 1) goNext();
      else submit();
      return;
    }
    const el = /** @type {HTMLElement} */ (event.target);
    if (event.key === 'Enter' && el.id === 'fb-other' && s.other.trim()) {
      event.preventDefault();
      s.topic = 'other';
      repaint();
    }
    if (event.key === 'Escape' && s.picking) {
      event.preventDefault();
      s.picking = false;
      repaint();
      focusOn('[data-pick]');
    }
    // ↑ ↓ move through the conversations, Enter picks one.
    if (s.picking && el.matches?.('li[data-chat]')) {
      const options = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('li[data-chat]')]);
      const at = options.indexOf(el);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        options[(at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        el.click();
      }
    }
  });

  dialog.addEventListener('click', (event) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('button, li[data-chat]'));
    if (!el) return;
    const d = el.dataset;
    if (d.topic) {
      s.topic = d.topic;
      repaint();
      focusOn('[data-kind]');
    } else if (el.hasAttribute('data-other')) {
      if (!s.other.trim()) return;
      s.topic = 'other';
      repaint();
      focusOn('[data-kind]');
    } else if (el.hasAttribute('data-change')) {
      s.topic = null;
      repaint();
      focusOn('[data-topic]');
    } else if (d.kind) {
      s.kind = d.kind;
      repaint();
      focusOn('#fb-body');
    } else if (d.affect) {
      s.affect = d.affect;
      repaint();
    } else if (d.frequency) {
      s.frequency = d.frequency;
      repaint();
    } else if (d.worked) {
      s.worked = d.worked;
      repaint();
    } else if (el.hasAttribute('data-include')) {
      s.include = !s.include;
      repaint();
      focusOn('[data-include]');
    } else if (el.hasAttribute('data-pick')) {
      s.picking = !s.picking;
      repaint();
      focusOn('li[aria-selected="true"]');
    } else if (d.chat) {
      s.chatId = d.chat;
      s.picking = false;
      repaint();
      focusOn('[data-pick]');
    } else if (el.hasAttribute('data-whats-included')) {
      const more = /** @type {HTMLElement | null} */ (dialog.querySelector('.fb__included'));
      if (more) {
        more.hidden = !more.hidden;
        el.setAttribute('aria-expanded', String(!more.hidden));
      }
    } else if (el.hasAttribute('data-next')) goNext();
    else if (el.hasAttribute('data-prev')) {
      s.page = 1;
      repaint();
    } else if (el.hasAttribute('data-submit')) submit();
  });

  return {
    open() {
      reset();
      paint();
      dialog.showModal();
      focusOn('[data-topic]');
    },
  };
}
