import { vi } from './locales/vi.js';
import { en } from './locales/en.js';

/**
 * Translation, for an app whose customers are not all English speakers.
 *
 * Small on purpose. There is no plural machinery, no message format, no lazy
 * loading — two dictionaries of flat keys, statically imported so the first paint
 * is already in the right language rather than flashing English and then
 * correcting itself.
 *
 * **A missing key is loud.** `t()` returns the key itself and warns once, because
 * the alternative — falling back to English silently — is how half a screen stays
 * untranslated for a year without anybody noticing. Falling back to the *English
 * string* would be worse still: it looks finished.
 */

const LOCALES = { vi, en };
export const LANGUAGES = [
  // `label` in the language itself, `english` beside it for everyone else.
  { id: 'vi', label: 'Tiếng Việt', english: 'Vietnamese' },
  { id: 'en', label: 'English', english: 'English' },
];

const STORAGE_KEY = 'ai-remote-language';

/**
 * Which language to open in, before the server has said anything.
 *
 * The stored answer first, then the browser's own preference, then English. This
 * runs at module load so the markup is translated on the first paint; the account
 * preference arrives with `bootstrap` a moment later and corrects it if it
 * differs, which is one repaint rather than a page of English.
 */
function initialLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES[saved]) return saved;
  } catch {
    // Private mode, or storage disabled. The browser's preference still works.
  }
  const preferred = (navigator.languages || [navigator.language || 'en'])
    .map((tag) => String(tag).toLowerCase().split('-')[0])
    .find((tag) => LOCALES[tag]);
  return preferred || 'en';
}

let current = initialLanguage();
const warned = new Set();

export const currentLanguage = () => current;

/** What a date or a number is written in: the app's language, never the browser's (owner, 2026-11-08: 11/5/2026 on a Vietnamese page). */
export const localeTag = () => (current === 'vi' ? 'vi-VN' : 'en-US');

/** The dictionary for a language, for callers that want to check a key exists. */
export const has = (key) => Object.prototype.hasOwnProperty.call(LOCALES[current] || {}, key);

/**
 * One string.
 *
 * `vars` fills `{name}` placeholders. Nothing is escaped here — the caller decides
 * whether the result is going into `textContent` (safe, and what almost everything
 * does) or into markup.
 */
export function t(key, vars) {
  const dict = LOCALES[current] || {};
  let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;

  if (text == null) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] no "${current}" string for "${key}"`);
    }
    // The key, not the English. An untranslated screen has to look untranslated.
    text = key;
  }

  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Fill every marked node under `root`.
 *
 * Attribute-driven rather than a call per string, so translating a new piece of
 * markup is one attribute and one dictionary entry instead of a trip through
 * app.js. Four attributes cover everything this interface needs:
 *
 *   data-i18n              → textContent
 *   data-i18n-html         → innerHTML, for the few strings with a <strong> in them
 *   data-i18n-placeholder  → placeholder
 *   data-i18n-title        → title, and aria-label when the node has one
 *
 * `data-i18n-html` takes its content from the dictionaries in this repo and never
 * from user input or a server response, which is what makes it safe to assign.
 */
export function applyI18n(root = document) {
  // querySelectorAll is typed as Element, and dataset, placeholder and title
  // live on HTMLElement and HTMLInputElement. The annotations say which kind of
  // node each attribute is only ever put on, which is a fact about the markup
  // worth writing down rather than a cast to quieten the checker.
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n]'))) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n-html]'))) {
    node.innerHTML = t(node.dataset.i18nHtml);
  }
  for (const node of /** @type {NodeListOf<HTMLInputElement>} */ (
    root.querySelectorAll('[data-i18n-placeholder]')
  )) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n-title]'))) {
    const text = t(node.dataset.i18nTitle);
    node.title = text;
    // A button whose only label is an icon carries its name in aria-label; leaving
    // that in English would translate the tooltip and not the screen reader.
    if (node.hasAttribute('aria-label')) node.setAttribute('aria-label', text);
  }
  /**
   * An accessible name with no visible tooltip to hang it on.
   *
   * The loop above only reaches controls that carry a `title`, which is right
   * for icon buttons and useless for a text field: the composer needs a real
   * accessible name (a placeholder is neither exposed as one nor survives the
   * first keystroke) and must not sprout a tooltip to get one.
   */
  for (const node of root.querySelectorAll('[data-i18n-aria-label]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  }
  // An image that means something is described in the reader's language too.
  for (const node of /** @type {NodeListOf<HTMLImageElement>} */ (root.querySelectorAll('[data-i18n-alt]'))) {
    node.alt = t(node.dataset.i18nAlt);
  }
  document.documentElement.lang = current;
}

/**
 * Switch language and repaint.
 *
 * Remembered in this browser as well as on the account: the account preference is
 * what follows somebody to their phone, and the local copy is what makes the next
 * load open correctly instead of in English while `bootstrap` is in flight.
 */
export function setLanguage(language) {
  if (!LOCALES[language] || language === current) return false;
  current = language;
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Not being able to remember it is a smaller problem than not applying it.
  }
  applyI18n();
  return true;
}

/** Adopt the account's stored choice, if it differs from what we guessed. */
export function adoptLanguage(language) {
  if (!language || !LOCALES[language]) return false;
  return setLanguage(language);
}
