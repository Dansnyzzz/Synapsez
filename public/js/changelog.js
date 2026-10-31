import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * What's new — View changelog in the account menu, after Claude's (owner,
 * 2026-10-31): the newest version's date and number, and what it brought, made
 * better and fixed. The number is a button: pressed, it lists every version, and
 * picking one shows that one.
 *
 * The words are public/changelog.json, in both languages; test/features holds
 * its newest entry to the version package.json says the app is.
 */

const SECTIONS = ['new', 'improved', 'fixed'];

/** The changelog, read once per page. */
let reading = null;
const readLog = () =>
  (reading ||= fetch('/changelog.json', { cache: 'no-cache' })
    .then((res) => res.json())
    .catch(() => {
      reading = null;
      return { entries: [] };
    }));

/** The version the app is — the changelog's newest, which test/features holds to package.json. */
export async function appVersion() {
  return (await readLog()).entries?.[0]?.version || '';
}

export function createChangelog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet whatsnew';
  dialog.id = 'changelog';
  dialog.setAttribute('aria-labelledby', 'changelog-title');
  document.body.append(dialog);

  /** @type {{ entries: any[] } | null} */
  let log = null;
  let shown = 0;
  let picking = false;

  const lang = () => (currentLanguage() === 'vi' ? 'vi' : 'en');
  const longDate = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Intl.DateTimeFormat(lang() === 'vi' ? 'vi-VN' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d));
  };

  function paint() {
    const head = `<form method="dialog" class="whatsnew__head"><h2 id="changelog-title">${escapeHtml(t('changelog.title'))}</h2><button class="icon-btn" value="close" aria-label="${escapeHtml(t('action.close'))}">✕</button></form>`;
    if (!log) {
      dialog.innerHTML = `${head}<div class="whatsnew__body"><p class="whatsnew__muted">${escapeHtml(t('common.loading'))}</p></div>`;
      return;
    }
    const entry = log.entries[shown];
    const versions = picking
      ? `<ul class="whatsnew__versions" role="listbox" aria-label="${escapeHtml(t('changelog.versions'))}">${log.entries
          .map((e, i) => `<li role="option" tabindex="-1" data-version="${i}" aria-selected="${i === shown}"><span>${escapeHtml(e.version)}</span><span class="whatsnew__muted">${escapeHtml(longDate(e.date))}</span></li>`)
          .join('')}</ul>`
      : '';
    const sections = SECTIONS.filter((s) => (entry[s]?.[lang()] || []).length)
      .map((s) => `<h3 class="whatsnew__section">${escapeHtml(t(`changelog.${s}`))}</h3><ul class="whatsnew__list">${entry[s][lang()].map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`)
      .join('');
    dialog.innerHTML = `${head}<div class="whatsnew__body">
      <div class="whatsnew__date"><h3>${escapeHtml(longDate(entry.date))}</h3>
        <div class="whatsnew__pick"><button type="button" class="whatsnew__version" data-pick aria-haspopup="listbox" aria-expanded="${picking}" aria-label="${escapeHtml(t('changelog.pickVersion', { version: entry.version }))}">${escapeHtml(entry.version)}</button>${versions}</div>
      </div>
      ${sections}
    </div>`;
  }

  const focusOn = (selector) => /** @type {HTMLElement | null} */ (dialog.querySelector(selector))?.focus();

  dialog.addEventListener('click', (event) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-pick], [data-version]'));
    if (!el) return;
    if (el.hasAttribute('data-pick')) {
      picking = !picking;
      paint();
      focusOn(picking ? 'li[aria-selected="true"]' : '[data-pick]');
    } else {
      shown = Number(el.dataset.version) || 0;
      picking = false;
      paint();
      focusOn('[data-pick]');
    }
  });

  dialog.addEventListener('keydown', (event) => {
    const el = /** @type {HTMLElement} */ (event.target);
    if (!picking) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      picking = false;
      paint();
      focusOn('[data-pick]');
      return;
    }
    if (!el.matches?.('li[data-version]')) return;
    const options = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('li[data-version]')]);
    const at = options.indexOf(el);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      options[(at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el.click();
    }
  });

  return {
    async open() {
      shown = 0;
      picking = false;
      paint();
      dialog.showModal();
      if (!log) log = await readLog();
      if (!log.entries.length) {
        dialog.querySelector('.whatsnew__body').innerHTML = `<p class="whatsnew__muted">${escapeHtml(t('changelog.none'))}</p>`;
        return;
      }
      paint();
      focusOn('[data-pick]');
    },
  };
}
