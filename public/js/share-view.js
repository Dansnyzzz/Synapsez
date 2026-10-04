/**
 * A conversation shared by link, drawn read-only.
 *
 * The same renderer the app uses — so a shared answer looks exactly like the
 * one its owner saw, charts, cards and file tiles included — with no composer.
 * Files are fetched through the share cookie the data request sets (see
 * server/routes/chatShare.js); a tile opens its file in a new tab.
 *
 * To carry the conversation on: signed out, sign in first (the app picks the
 * link up again afterwards); signed in, it is copied into your account and
 * opened there. The owner of the conversation is simply taken to it.
 */
import { t, applyI18n, currentLanguage } from './i18n.js';
import { userMessage, assistantMessage } from './render.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t') || '';

applyI18n();

/** Carry on: copy into this account (or open one's own), then go there. */
async function carryOn(button) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/shared-chat/${encodeURIComponent(token)}/fork`, {
      method: 'POST',
      headers: { 'X-Language': currentLanguage() },
    });
    if (res.status === 401) {
      location.href = `/?continue=${encodeURIComponent(token)}`;
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    location.href = `/?chat=${encodeURIComponent(body.chatId)}`;
  } catch (err) {
    button.disabled = false;
    $('share-note').textContent = String(err.message || err);
  }
}

async function show() {
  const res = await fetch(`/api/shared-chat/${encodeURIComponent(token)}`, { headers: { 'X-Language': currentLanguage() } }).catch(() => null);
  const thread = $('share-thread');
  if (!res || !res.ok) {
    thread.replaceChildren(Object.assign(document.createElement('p'), { className: 'sharepage__loading', textContent: t('sharechat.gone') }));
    $('share-title').textContent = t('sharechat.goneTitle');
    return;
  }
  const data = await res.json();
  document.title = `${data.title} · Synapsez`;
  $('share-title').textContent = data.title || t('sharechat.untitled');
  const when = data.sharedAt ? new Date(data.sharedAt).toLocaleString(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }) : '';
  $('share-meta').textContent = t('sharechat.meta', { when });

  const results = new Map();
  for (const m of data.messages) if (m.role === 'tool') for (const r of m.results || []) results.set(r.toolCallId, r);
  thread.replaceChildren();
  for (const m of data.messages) {
    if (m.role === 'user') thread.append(userMessage(m.text, m.attachments || [], m.id, m.createdAt));
    else if (m.role === 'assistant') {
      const turn = assistantMessage();
      thread.append(turn.node);
      turn.hydrate(m, results);
    }
  }
  // Reading only: the copy and edit controls belong to the owner's app.
  for (const node of thread.querySelectorAll('.msg__action[data-act="edit"], .filecard__btn[data-no-open]')) node.remove();

  const go = $('share-go');
  const viewer = data.viewer || {};
  go.textContent = viewer.isOwner ? t('sharechat.openOwn') : viewer.signedIn ? t('sharechat.carryOn') : t('sharechat.signIn');
  $('share-note').textContent = viewer.isOwner ? t('sharechat.ownerNote') : viewer.signedIn ? t('sharechat.copyNote') : t('sharechat.signInNote');
  go.addEventListener('click', () => {
    if (!viewer.signedIn) {
      location.href = `/?continue=${encodeURIComponent(token)}`;
      return;
    }
    carryOn(go);
  });
  $('share-foot').hidden = false;
}

// A file tile or card opens the file itself, in a new tab.
document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const file = target.closest?.('[data-file]');
  if (!file || target.closest('a[download], [data-no-open]')) return;
  event.preventDefault();
  window.open(`/api/attachments/${encodeURIComponent(/** @type {HTMLElement} */ (file).dataset.file)}`, '_blank', 'noopener');
});

show();
