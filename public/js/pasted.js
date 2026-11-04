/**
 * A long paste: a card above the box instead of a wall of text inside it.
 *
 * The way Claude does it (owner, 2026-11-04). What Anthropic has not published is
 * where the line is; a measurement from outside puts it at 3,863 characters, and
 * "about 4,000" is the figure people repeat, so 4,000 it is — one constant.
 *
 * On the way out a card is an ordinary text attachment, which the server already
 * inlines into the prompt for every provider (`toParts` in server/attachments.js)
 * — so a message that is nothing but a card still reaches the model, and whoever
 * reads the conversation later can open it. The name is what marks it as pasted,
 * the same way Claude's are `paste.txt`: no schema to change, and a person's own
 * file that happens to be called this only looks a little different.
 *
 * `server/attachments.js` has its own copy of `PASTED_NAME`, because the browser
 * cannot import the server. A test holds them to the same answer.
 */
import { t, currentLanguage } from './i18n.js';
import { newestOnly } from './serial.js';

export const PASTE_CARD_CHARS = 4000;
/** Where `toParts` cuts a text file. A card past this is told so when it is pasted. */
export const MODEL_READS_CHARS = 100_000;
/** More than a tile can show, and few enough that drawing one costs nothing. */
const EXCERPT_CHARS = 260;
const PASTED_NAME = /^pasted(?:-\d+)?\.txt$/i;

export const isPastedName = (name) => PASTED_NAME.test(String(name || ''));

/** The first free name, so a model told about two can tell them apart. */
export function pastedName(taken = []) {
  const names = new Set(taken.map((name) => String(name).toLowerCase()));
  if (!names.has('pasted.txt')) return 'pasted.txt';
  let n = 2;
  while (names.has(`pasted-${n}.txt`)) n += 1;
  return `pasted-${n}.txt`;
}

/** Line endings as a text box has them, so the pencil gives back exactly what is counted. */
export const tidyPaste = (text) => String(text ?? '').replace(/\r\n?/g, '\n');

/** A run of nothing but blank lines is not worth a card: it goes in the box, where it can be seen to be nothing. */
export const isLongPaste = (text) => text.length >= PASTE_CARD_CHARS && /\S/.test(text);

export const pastedExcerpt = (text) => String(text ?? '').trimStart().slice(0, EXCERPT_CHARS);

/** The line under the heading, and the card's spoken name: "13.45 KB", "104 lines". */
export function pastedFacts(text) {
  const words = String(text ?? '');
  const count = words.split('\n').length;
  return {
    size: `${(new TextEncoder().encode(words).length / 1024).toFixed(2)} KB`,
    lines: count === 1 ? t('pasted.oneLine') : t('pasted.lines', { n: count.toLocaleString(currentLanguage()) }),
  };
}

/**
 * The words of one already sent. An upload never changes and the owner's route
 * says so (`immutable`), so reading the same card twice costs the browser nothing
 * and there is no second cache to keep here. A share visitor asks again each time.
 */
export async function readPasted(id) {
  const res = await fetch(`/api/attachments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ── the window that shows the whole of it ───────────────────────── */

/** @type {{ dialog: HTMLDialogElement, facts: HTMLElement, body: HTMLElement } | null} */
let view = null;
const newestRead = newestOnly();

/**
 * Made when first wanted, and from here rather than in the page's markup: the
 * shared-conversation page draws these cards too, and has its own HTML.
 */
function viewParts() {
  if (view) return view;
  const dialog = document.createElement('dialog');
  dialog.id = 'pasted-view';
  dialog.className = 'sheet pasted';
  dialog.setAttribute('aria-labelledby', 'pasted-title');

  const head = document.createElement('div');
  head.className = 'pasted__head';
  const title = document.createElement('h2');
  title.id = 'pasted-title';
  const close = document.createElement('button');
  close.className = 'icon-btn';
  close.type = 'button';
  close.textContent = '✕';
  close.addEventListener('click', () => dialog.close());
  head.append(title, close);

  const facts = document.createElement('p');
  facts.className = 'pasted__facts';
  const body = document.createElement('pre');
  body.className = 'pasted__body';
  // Long enough to scroll, and a scroller the keyboard cannot reach is one half of people cannot read.
  body.tabIndex = 0;
  dialog.append(head, facts, body);

  // A press outside lands on the dialog itself: its backdrop belongs to it.
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (event.target === dialog && !inside) dialog.close();
  });
  // The browser puts focus back where it was — unless that card has been redrawn away meanwhile.
  dialog.addEventListener('close', () => {
    if (document.activeElement === document.body) document.getElementById('input')?.focus({ preventScroll: true });
  });

  document.body.append(dialog);
  view = { dialog, facts, body };
  return view;
}

function openView() {
  const parts = viewParts();
  // Each time, not once: the language can change between two openings.
  parts.dialog.querySelector('h2').textContent = t('pasted.title');
  parts.dialog.querySelector('.icon-btn').setAttribute('aria-label', t('action.close'));
  if (!parts.dialog.open) parts.dialog.showModal();
  return parts;
}

function fill(parts, text) {
  const { size, lines } = pastedFacts(text);
  parts.facts.textContent = [size, lines, t('pasted.format')].join(' • ');
  parts.body.textContent = text;
}

/** Words the browser already has: a card still waiting to be sent. */
export function showPasted(text) {
  newestRead();
  fill(openView(), text);
}

/** A card on a sent message: the window opens at once, and the words follow. */
export async function showStoredPasted(id) {
  const current = newestRead();
  const parts = openView();
  parts.facts.textContent = t('pasted.loading');
  parts.body.textContent = '';
  try {
    const text = await readPasted(id);
    if (current()) fill(parts, text);
  } catch {
    if (current()) parts.facts.textContent = t('pasted.failed');
  }
}
