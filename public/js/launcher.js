/**
 * The quick launcher's one box — see public/launcher.html and scripts/launcher.js.
 *
 * A file of its own rather than a `<script>` inside the page, because the app's
 * Content-Security-Policy is `script-src 'self'`: an inline script is exactly
 * what that policy refuses to run, so the box drew and then did nothing at all.
 */
const $ = (id) => document.getElementById(id);
const input = /** @type {HTMLInputElement} */ ($('q'));
const mark = $('mark');
const hint = $('hint');

const say = (text, state = '') => {
  hint.textContent = text;
  mark.dataset.state = state;
};

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// Signed out, the box would take a question and lose it. Say so first.
let authed = false;
try {
  const session = await json('GET', '/api/session');
  authed = !!session.authed;
  $('who').textContent = session.user?.email || '';
} catch {
  say('The app is not running — start it with npm start.', 'error');
}
if (!authed && $('who').textContent === '') {
  say('Sign in first — press Enter to open the app.', 'error');
}

let sending = false;

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending) return;

  if (!authed) {
    location.href = '/';
    return;
  }
  const text = input.value.trim();
  if (!text) return;

  sending = true;
  say('Sending…', 'busy');
  try {
    // Created and posted here, then run over there: the main app owns the
    // streaming, the approval prompts and the plan, and reimplementing any of
    // that in a launcher would mean two of everything.
    const { chat } = await json('POST', '/api/chats', {});
    await json('POST', `/api/chats/${chat.id}/messages`, { text });
    location.href = `/?chat=${encodeURIComponent(chat.id)}&run=1`;
  } catch (err) {
    sending = false;
    say(err.message, 'error');
  }
});

// Esc closes it. A window opened by the OS cannot always close itself, so
// blanking the field is the fallback — the next press of the hotkey then finds
// it empty rather than holding a stale question.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  input.value = '';
  window.close();
});

window.addEventListener('focus', () => input.focus());
input.focus();
