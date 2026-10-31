import { t, LANGUAGES, currentLanguage } from './i18n.js';
import { openCascade, closePlus } from './plus-menu.js';

/**
 * The account at the foot of the sidebar, the way Claude's is (owner,
 * 2026-10-26): a letter in a circle and the username, and pressed, a menu —
 *
 *   you@example.com
 *   Settings            Ctrl+Shift+,
 *   Usage               Settings → Usage (2026-10-31)
 *   Language ›          Tiếng Việt · English
 *   Get help            the getting-started guide
 *   Give feedback       to the people who run the deployment
 *   ───
 *   View changelog      what each version changed
 *   Learn more ›        about, the policies, your privacy choices, shortcuts
 *   ───
 *   Log out
 *
 * It took the place of a lone Settings row, which is one of its rows now. The
 * panels are the + menu's (`openCascade`), so the two open, hover, cascade and
 * answer the keyboard the same way, and only one of them is open at a time.
 *
 * @typedef {{ name?: string, username?: string | null, email: string }} User
 * @typedef {{
 *   user: () => User,
 *   openSettings: (tab?: string) => void,
 *   setLanguage: (id: string) => any,
 *   openGuide: () => void,
 *   openAbout: () => void,
 *   openShortcuts: () => void,
 *   openFeedback: () => void,
 *   openChangelog: () => void,
 *   logout: () => any,
 * }} Deps
 */

const svg = (paths, size = 17) =>
  `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICON = {
  settings: svg('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4"/>'),
  language: svg('<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2 2.9 4.4 2.9 7S12 15 10 17c-2-2-2.9-4.4-2.9-7S8 5 10 3Z"/>'),
  help: svg('<circle cx="10" cy="10" r="7"/><path d="M8 8a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.6"/><circle cx="10" cy="14" r=".4" fill="currentColor"/>'),
  info: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5"/><circle cx="10" cy="6.6" r=".4" fill="currentColor"/>'),
  logout: svg('<path d="M8 3.5H5a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 5 16.5h3"/><path d="M12.5 13.5 16 10l-3.5-3.5M16 10H8"/>'),
  // Claude's three (owner, 2026-10-31): a gauge, a bug, a notebook.
  usage: svg('<circle cx="10" cy="10" r="7"/><path d="M10 10 7.2 6.8M10 3v1.6"/>'),
  feedback: svg('<path d="M7 7.2a3 3 0 0 1 6 0"/><rect x="6" y="7" width="8" height="9.5" rx="4"/><path d="M10 9.5v7M3 10h3M14 10h3M3.5 14.5 6 13.5M16.5 14.5 14 13.5M4 5.5l2.3 1.6M16 5.5l-2.3 1.6"/>'),
  changelog: svg('<rect x="4" y="2.5" width="12" height="15" rx="1.8"/><path d="M7.5 6.5h5M7.5 9.5h5M7.5 12.5h3"/>'),
};

/** Ctrl on Windows and Linux, ⌘ on a Mac — what the shortcuts are pressed with. */
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = MAC ? '⌘' : 'Ctrl';

/**
 * The app's keyboard shortcuts — the ones `shortcutFor` answers to, and the
 * list "Keyboard shortcuts" shows, from one place so the two cannot disagree.
 *
 * Matched by the character a key types (`key`), so a layout that puts "/" or a
 * letter elsewhere still finds it, and the key that sits where "/" does on a
 * US board — "-" on a German one, Ctrl+- being zoom out — is left alone.
 * Settings is the one matched by place (`code`): with Shift held, "," types
 * "<" on one layout and ";" on another, and its place is the same on both.
 * "/" ignores Shift, which some layouts need to type it at all.
 */
export const SHORTCUTS = [
  { id: 'newChat', key: 'o', shift: true, keys: [MOD, 'Shift', 'O'], label: 'shortcuts.newChat' },
  { id: 'search', key: 'k', shift: false, keys: [MOD, 'K'], label: 'shortcuts.search' },
  { id: 'settings', code: 'Comma', shift: true, keys: [MOD, 'Shift', ','], label: 'shortcuts.settings' },
  { id: 'shortcuts', key: '/', shift: null, keys: [MOD, '/'], label: 'shortcuts.list' },
];

/** Keys the app already answers to without a shortcut of its own — listed, not handled here. */
const PLAIN_KEYS = [
  { keys: ['Enter'], label: 'shortcuts.send' },
  { keys: ['Shift', 'Enter'], label: 'shortcuts.newLine' },
  { keys: ['Esc'], label: 'shortcuts.close' },
];

/** The shortcut a key press is, if it is one. */
export function shortcutFor(event) {
  const mod = MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return null;
  const typed = String(event.key || '').toLowerCase();
  return (
    SHORTCUTS.find((s) => (s.shift === null || s.shift === event.shiftKey) && (s.code ? s.code === event.code : s.key === typed))?.id || null
  );
}

const keysOf = (id) => SHORTCUTS.find((s) => s.id === id)?.keys.join('+') || '';

/** What the circle and the line say: the username, else the name, else the address. */
export function accountLabel(user) {
  return String(user?.username || user?.name || String(user?.email || '').split('@')[0] || '?');
}

/** @param {HTMLElement} button @param {User} user */
export function paintAccount(button, user) {
  const label = accountLabel(user);
  const avatar = button.querySelector('.account__avatar');
  const name = button.querySelector('.account__name');
  if (avatar) avatar.textContent = [...label][0]?.toUpperCase() || '?';
  if (name) name.textContent = label;
  // Collapsed to a rail, the circle is all there is: the name is on its tooltip.
  button.title = label;
  button.setAttribute('aria-label', t('account.menuFor', { name: label }));
}

/** @param {HTMLElement} anchor @param {Deps} deps */
export function openAccountMenu(anchor, deps) {
  const user = deps.user();
  const root = openCascade(
    anchor,
    [
      { note: user.email },
      { id: 'settings', label: t('account.settings'), icon: ICON.settings, tag: keysOf('settings'), run: () => deps.openSettings() },
      { id: 'usage', label: t('account.usage'), icon: ICON.usage, run: () => deps.openSettings('usage') },
      { id: 'language', label: t('account.language'), icon: ICON.language, sub: () => languageItems(deps) },
      { id: 'help', label: t('account.help'), icon: ICON.help, run: () => deps.openGuide() },
      { id: 'feedback', label: t('account.feedback'), icon: ICON.feedback, run: () => deps.openFeedback() },
      null,
      { id: 'changelog', label: t('account.changelog'), icon: ICON.changelog, run: () => deps.openChangelog() },
      { id: 'learn', label: t('account.learnMore'), icon: ICON.info, sub: () => learnMoreItems(deps) },
      null,
      { id: 'logout', label: t('account.signOut'), icon: ICON.logout, run: () => deps.logout() },
    ],
    t('account.menu'),
    { className: 'plusmenu--account' },
  );
  // As wide as the account it rises from, as Claude's is; never narrower than
  // its rows, which is all it can be from the rail's circle. Its left edge and
  // its height stay where they were placed.
  if (root) root.node.style.minWidth = `${Math.max(264, anchor.getBoundingClientRect().width)}px`;
}

/** Each language named in itself, so somebody who cannot read this one finds theirs. */
function languageItems(deps) {
  return LANGUAGES.map(({ id, label }) => ({
    label,
    radio: true,
    checked: id === currentLanguage(),
    // Every label in the menu is the old language's: it closes, and what is
    // behind it is drawn again in the new one.
    select: async () => {
      closePlus();
      await deps.setLanguage(id);
    },
  }));
}

/** The pages Claude puts under "Learn more", as far as this app has them. */
function learnMoreItems(deps) {
  const page = (path) => () => window.open(path, '_blank', 'noopener');
  return [
    { id: 'about', label: t('learn.about'), run: () => deps.openAbout() },
    null,
    { id: 'usage', label: t('learn.usage'), external: true, run: page('/usage-policy.html') },
    { id: 'privacy', label: t('learn.privacy'), external: true, run: page('/privacy.html') },
    { id: 'terms', label: t('learn.terms'), external: true, run: page('/terms.html') },
    { id: 'choices', label: t('learn.choices'), run: () => deps.openSettings('memory') },
    null,
    { id: 'shortcuts', label: t('learn.shortcuts'), tag: keysOf('shortcuts'), run: () => deps.openShortcuts() },
  ];
}

/** The shortcuts, as rows of keys and what they do — drawn into the dialog that lists them. */
export function renderShortcuts(list) {
  const row = ({ keys, label }) => {
    const item = document.createElement('li');
    item.className = 'shortcuts__row';
    const what = document.createElement('span');
    what.textContent = t(label);
    const pressed = document.createElement('span');
    pressed.className = 'shortcuts__keys';
    for (const key of keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      pressed.append(kbd);
    }
    item.append(what, pressed);
    return item;
  };
  list.replaceChildren(...SHORTCUTS.map(row), ...PLAIN_KEYS.map(row));
}
