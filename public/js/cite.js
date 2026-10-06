/**
 * The card a citation chip opens.
 *
 * `markdown.js` draws the chip and, hidden inside it, the list of sources it
 * stands for. This module shows that list as a floating card: on hover with a
 * mouse, on a tap on a touch screen, and on Enter or Space from the keyboard. A
 * page source is a link that opens where it was read; a file source only names
 * the file, because the file is already in the conversation.
 *
 * One card for the whole page, positioned against the chip, rather than a card
 * inside every chip: a chip sits in a paragraph inside a scrolling transcript,
 * and an absolutely positioned child there is clipped by the first container
 * with overflow hidden — a table, a code block, the transcript itself.
 *
 * What the reply's text does not carry — a page's title and the search engine's
 * summary of it — is filled in from the searches this tab has already seen
 * (`rememberSearch`, fed by the web card in render.js). A source the tab never
 * saw searched simply shows the name the assistant gave it and its address.
 */
import { t } from './i18n.js';

/** @type {Map<string, { title: string|null, snippet: string|null }>} */
const known = new Map();
const MAX_KNOWN = 600;

/** The same page written with or without a trailing slash or fragment. */
const keyOf = (url) => String(url || '').replace(/#.*$/, '').replace(/\/+$/, '');

function remember(url, { title = null, snippet = null }) {
  const key = keyOf(url);
  if (!key) return;
  const prev = known.get(key);
  known.delete(key);
  known.set(key, { title: prev?.title || title, snippet: prev?.snippet || snippet });
  // Oldest out first: a long session searches a lot, and none of this is precious.
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
}

/**
 * Keep the titles and summaries from a `web_search` result.
 *
 * The format is `formatResults` in server/search.js: a numbered title, the
 * address on the next line, then the summary and an optional "published" line,
 * each indented.
 */
export function rememberSearch(content) {
  const text = String(content || '');
  const entry = /^\s*\d+\.\s+(.+)\n\s+(https?:\/\/\S+)((?:\n {3,}\S.*)*)/gm;
  for (const m of text.matchAll(entry)) {
    const snippet = m[3]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^published \d/.test(line))
      .join(' ')
      .slice(0, 280);
    remember(m[2], { title: m[1].trim().slice(0, 200), snippet: snippet || null });
  }
}

/** Keep the title of a page that was read directly. */
export function rememberPage(url, title) {
  if (title) remember(url, { title: String(title).slice(0, 200) });
}

/** For the tests. */
export const knownSource = (url) => known.get(keyOf(url)) || null;

/**
 * Was this source actually in front of the assistant?
 *
 * A model can name a file nobody gave it or an address it never opened — the
 * citation looks exactly as trustworthy as a real one. So each source is
 * checked against the conversation: the files sent, made and on the project's
 * shelf, and everything the tools read or returned. One that is not there is
 * marked, not removed — "not seen here" is a fact about this conversation, not
 * proof the source is wrong, and the card says it that way.
 *
 * `evidence` is supplied by the app (app.js), because only it knows the
 * conversation on screen: `{ files: string[] | null, text: string }`. `files`
 * is null while something it depends on (a project's shelf) is not loaded yet,
 * and then no file is marked: a false alarm is worse than a missing one.
 */
/** @type {null | (() => { files: string[] | null, text: string })} */
let evidence = null;
export function setCitationEvidence(fn) {
  evidence = fn;
}

const fold = (s) => String(s || '').normalize('NFC').toLowerCase().trim();
/** `slides.pdf.txt`, `slides.pdf` and `slides.txt` are one document. */
const stemOf = (name) => fold(name).replace(/(\.[a-z0-9]{1,5}){1,2}$/, '');

/**
 * The conversation's tool text, folded once (PERF-020).
 *
 * It is every page and file the tools read in the conversation — megabytes on a
 * long one — and it was normalised and lower-cased up to twice per cited file,
 * on every hydrate and every background poll. One audit passes the same text
 * for every citation in it, so remembering the last fold turns that into once.
 */
let lastText = null;
let lastFolded = '';
function foldedText(text) {
  if (text !== lastText) {
    lastText = text;
    lastFolded = fold(text);
  }
  return lastFolded;
}

/** Whether a cited file is one the conversation had, given what it had. */
export function fileWasSeen(name, { files, text }) {
  if (!files) return true;
  const want = fold(name);
  const stem = stemOf(name);
  if (files.some((f) => fold(f) === want || stemOf(f) === stem)) return true;
  // A file a tool read or listed: named in its result, the index, the machine.
  const haystack = foldedText(text);
  return haystack.includes(want) || (stem.length >= 4 && haystack.includes(stem));
}

/** Whether a cited address was searched, read, or given in the conversation. */
export function pageWasSeen(url, { text }) {
  const key = keyOf(url);
  if (known.has(key)) return true;
  const bare = key.replace(/^https?:\/\//, '');
  return String(text || '').includes(bare);
}

/** Mark what the conversation cannot account for, in one chip's card or a whole reply. */
export function auditCitations(root) {
  if (!evidence || !root) return;
  let seen;
  try {
    seen = evidence();
  } catch {
    return;
  }
  for (const item of root.querySelectorAll('.cite-item[data-file], a.cite-item[data-url]')) {
    const ok = item.hasAttribute('data-file')
      ? fileWasSeen(item.getAttribute('data-file'), seen)
      : pageWasSeen(item.getAttribute('data-url'), seen);
    item.classList.toggle('is-unseen', !ok);
    let warn = item.querySelector(':scope > .cite-item__warn');
    if (!ok && !warn) {
      warn = document.createElement('span');
      warn.className = 'cite-item__warn';
      warn.textContent = t(item.hasAttribute('data-file') ? 'cite.unseenFile' : 'cite.unseenPage');
      item.append(warn);
    } else if (ok && warn) warn.remove();
  }
  // A chip whose card holds an unseen source says so before it is opened.
  for (const chip of root.matches?.('.cite') ? [root] : root.querySelectorAll('.cite')) {
    chip.classList.toggle('cite--unseen', !!chip.querySelector('.cite__card .is-unseen'));
  }
}

let pop = null;
/** @type {HTMLElement|null} */
let current = null;
/** Opened by a click or a key, so moving the mouse away does not close it. */
let pinned = false;
let showTimer = 0;
let hideTimer = 0;
/** Where the open card's chip sits: its prose, its place there, and what it cites. */
let anchor = null;

/**
 * The open card's chip — found again if a streaming reply has repainted it.
 *
 * While a reply streams, its prose is rewritten every frame, so the chip a card
 * was pinned on is replaced by an identical one; a card that only checked
 * `isConnected` closed on the next scroll, and UX-007's fix held only for chips
 * in earlier messages (UX-009). The prose element itself survives — only what is
 * inside it is replaced — so the chip is the one at the same place there, citing
 * the same sources. Null when there is no such chip any more.
 */
function stillCurrent() {
  if (!current) return null;
  if (current.isConnected) return current;
  const again = anchor?.host?.isConnected ? anchor.host.querySelectorAll('.cite')[anchor.index] : null;
  if (!again || (again.getAttribute('aria-label') || '') !== anchor.label) return null;
  current = /** @type {HTMLElement} */ (again);
  current.setAttribute('aria-expanded', 'true');
  return current;
}

function popover() {
  if (pop) return pop;
  pop = document.createElement('div');
  pop.className = 'cite-pop';
  pop.setAttribute('role', 'dialog');
  pop.hidden = true;
  pop.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  pop.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && !pinned) scheduleHide();
  });
  document.body.append(pop);
  return pop;
}

/** Titles and summaries the reply did not carry, from what the tab has seen. */
function enrich(root) {
  for (const item of root.querySelectorAll('a.cite-item[data-url]')) {
    const info = known.get(keyOf(item.getAttribute('data-url')));
    if (!info) continue;
    if (info.title) item.querySelector('.cite-item__title').textContent = info.title;
    if (info.snippet) item.querySelector('.cite-item__snip').textContent = info.snippet;
  }
}

function place(chip, card) {
  const gap = 6;
  const rect = chip.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 16);
  card.style.width = `${width}px`;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const height = card.offsetHeight;
  // Below the chip, unless that runs off the screen and above does not.
  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - 8 && rect.top - gap - height >= 8) top = rect.top - gap - height;
  card.style.left = `${left}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

function show(chip, { pin = false } = {}) {
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  const card = popover();
  if (current !== chip) {
    current?.setAttribute('aria-expanded', 'false');
    current = chip;
    const host = chip.closest('.prose') || chip.parentElement;
    anchor = { host, index: [...(host?.querySelectorAll('.cite') || [])].indexOf(chip), label: chip.getAttribute('aria-label') || '' };
    // Checked again now, not only when the reply finished: a project's shelf
    // or a tool's result may have arrived since.
    auditCitations(chip);
    card.innerHTML = chip.querySelector('.cite__card')?.innerHTML || '';
    card.setAttribute('aria-label', chip.getAttribute('aria-label') || '');
    enrich(card);
    card.scrollTop = 0;
  }
  pinned = pinned || pin;
  card.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  place(chip, card);
}

function hide() {
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  current?.setAttribute('aria-expanded', 'false');
  current = null;
  anchor = null;
  pinned = false;
  if (pop) pop.hidden = true;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  // Long enough to cross the gap from the chip to the card.
  hideTimer = window.setTimeout(hide, 220);
}

if (typeof document !== 'undefined') {
  const chipOf = (target) => /** @type {HTMLElement|null} */ (target?.closest?.('.cite'));

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    // A streaming reply repaints its prose every frame, so the chip a card was
    // opened from can be replaced under it: found again if it is still there
    // (UX-009), and a card for a chip that is gone is a card pointing at nothing.
    if (current && !stillCurrent()) hide();
    const chip = chipOf(event.target);
    if (!chip) return;
    clearTimeout(hideTimer);
    if (current === chip) return;
    if (pinned) return;
    clearTimeout(showTimer);
    showTimer = window.setTimeout(() => show(chip), 120);
  });

  document.addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'mouse') return;
    const chip = chipOf(event.target);
    if (!chip || chip.contains(/** @type {Node} */ (event.relatedTarget))) return;
    clearTimeout(showTimer);
    if (current === chip && !pinned) scheduleHide();
  });

  document.addEventListener('click', (event) => {
    const chip = chipOf(event.target);
    if (chip) {
      event.preventDefault();
      stillCurrent();
      // A tap opens it and a second tap closes it. With a mouse the hover has
      // usually opened it already, so the click only makes it stay.
      if (current === chip && pinned) hide();
      else show(chip, { pin: true });
      return;
    }
    if (pop && !pop.hidden && !pop.contains(/** @type {Node} */ (event.target))) hide();
  });

  document.addEventListener('keydown', (event) => {
    const chip = chipOf(event.target);
    if (chip && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      show(chip, { pin: true });
      /** @type {HTMLElement|null} */ (pop?.querySelector('a.cite-item'))?.focus();
      return;
    }
    if (event.key === 'Escape' && current) {
      const back = current;
      hide();
      back.focus();
    }
  });

  /**
   * The transcript moving under a card — a person scrolling, or the view
   * following a reply as it streams — moves the card with its chip. Closing it
   * on every scroll shut a card somebody had just pinned at the next streamed
   * line (UX-007). It goes once its chip has gone, or left the part of the
   * page that scrolled.
   */
  let following = 0;
  document.addEventListener('scroll', (event) => {
    if (!pop || pop.hidden || pop.contains(/** @type {Node} */ (event.target)) || following) return;
    const scroller = event.target instanceof Element ? event.target : null;
    following = requestAnimationFrame(() => {
      following = 0;
      if (!pop || pop.hidden || !current) return;
      const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const live = stillCurrent();
      const chip = live?.getBoundingClientRect();
      if (!live || !chip.height || chip.bottom <= view.top || chip.top >= view.bottom) hide();
      else place(live, pop);
    });
  }, true);
  window.addEventListener('resize', hide);

  // A site with no icon shows no broken image. One listener, because the chip
  // is drawn as markup and an inline handler would need a CSP hole.
  document.addEventListener(
    'error',
    (event) => {
      const img = /** @type {HTMLElement} */ (event.target);
      if (img?.matches?.('img[data-cite-icon]')) img.classList.add('is-bare');
    },
    true,
  );
}
