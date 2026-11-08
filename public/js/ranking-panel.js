import { api } from './api.js';
import { t, localeTag } from './i18n.js';
import { titleFacts, factsHtml, gotLine } from './reward-facts.js';
import { latestOnly } from './latest.js';
import { escapeHtml } from './markdown.js';
import { playInFrame } from './scenes.js';
import { LOCK } from './themes-panel.js';

/**
 * Settings → Ranking (owner, 2026-11-04; by quarter from 2026-11-06): the quarter's
 * and the year's top ten by tokens and by spending, your own place, and the titles.
 *
 * The first three of a board win, and each wears its own colour. Only an account's
 * name and the title it chose are ever shown. What the boards hold and who is on them
 * is decided in server/themes.js; this only draws it.
 *
 * A title is pressed like a theme: the panel beside the list shows it at once, its
 * creature moving, what it is and what earns it. One the account holds is worn by the
 * same press, and only the last of a run of presses is saved. One it does not hold is
 * dimmed, and can still be looked at.
 */

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** Each title's creature: a scene in the catalogue, the harder to earn the more there is to it. */
const CREATURES = {
  newcomer: 'pet-minnow',
  'tokens-1m': 'pet-jelly',
  'tokens-10m': 'pet-manta',
  'tokens-100m': 'pet-seadragon',
  'tokens-1b': 'pet-cosmic-whale',
  'spend-10': 'pet-seahorse',
  'spend-100': 'pet-jade-turtle',
  'spend-1000': 'pet-gold-whale',
};
const PLACE_CREATURES = { 1: 'pet-koi-dragon', 2: 'pet-silver-marlin', 3: 'pet-bronze-dolphin' };

/** The creature a title shows. @param {any} title */
export const creatureOf = (title) => (title?.kind === 'award' || title?.kind === 'rank' ? PLACE_CREATURES[title.rank] : CREATURES[title?.id]) || null;

/** A title in words: one earned for a place on a board says which board and when. */
export function titleText(title) {
  if (!title) return '';
  if (title.kind === 'award') {
    const when = title.scope === 'year' ? title.key : periodText('quarter', title.key);
    return t(`ranking.title.${title.board}`, { rank: title.rank, when });
  }
  if (title.kind === 'rank') return t('ranking.title.place', { rank: title.rank });
  return t(`ranking.title.${title.id}`);
}

function periodText(scope, key) {
  if (scope === 'year') return String(key);
  const [year, quarter] = String(key).split('-');
  return `${quarter}/${year}`;
}

const tokens = (n) => Number(n || 0).toLocaleString(localeTag());
const dollars = (n) => `$${Number(n || 0).toLocaleString(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @param {{ host: HTMLElement, toast: (text: string, kind?: string) => void, savePrefs: (patch: any) => Promise<any> }} deps
 */
export function createRanking({ host, toast, savePrefs }) {
  let scope = 'quarter';
  let key = '';
  let loading = 0;
  /** @type {any} */
  let titles = null;
  /** What the panel beside the list is showing. '' is wearing none. */
  let looking = null;
  /** What the server last agreed is being worn, to go back to if a save is refused. */
  let worn = null;
  let stopCreature = null;

  function boardHtml(name, rows, format) {
    const body = rows.length
      ? rows.map((row) => `<li class="ranking__row${row.rank <= 3 ? ` is-place-${row.rank}` : ''}${row.isMe ? ' is-me' : ''}">
            <span class="ranking__medal" aria-label="${escapeHtml(t('ranking.place', { n: row.rank }))}">${MEDAL[row.rank] || row.rank}</span>
            <span class="ranking__who"><span class="ranking__name">${escapeHtml(row.name || t('ranking.member'))}${row.isMe ? ` <span class="muted">${escapeHtml(t('ranking.you'))}</span>` : ''}</span>${row.title ? `<span class="ranking__chip">${escapeHtml(titleText(row.title))}</span>` : ''}</span>
            <span class="ranking__value">${escapeHtml(format(row.value))}</span>
          </li>`).join('')
      : `<li class="ranking__empty">${escapeHtml(t('ranking.empty'))}</li>`;
    return `<section class="ranking__board"><h4>${escapeHtml(t(`ranking.board.${name}`))}</h4><ol class="ranking__list">${body}</ol></section>`;
  }

  function placeLine(me) {
    const piece = (rank, value, format) => (rank ? t('ranking.placeLine', { rank, value: format(value) }) : t('ranking.notPlaced'));
    return `${t('ranking.board.tokens')}: ${piece(me.tokens.rank, me.tokens.value, tokens)} · ${t('ranking.board.spend')}: ${piece(me.spend.rank, me.spend.value, dollars)}`;
  }

  function paintBoards(board) {
    const box = host.querySelector('.ranking__top');
    if (!box) return;
    box.innerHTML = `<div class="ranking__bar">
        <div class="ranking__scope" role="radiogroup" aria-label="${escapeHtml(t('ranking.period'))}">
          ${['quarter', 'year'].map((name) => `<button type="button" role="radio" aria-checked="${name === board.scope}" data-scope="${name}">${escapeHtml(t(`ranking.scope.${name}`))}</button>`).join('')}
        </div>
        <label class="ranking__pick"><span class="sr-only">${escapeHtml(t('ranking.period'))}</span>
          <select class="sselect" data-period>${board.keys.map((k) => `<option value="${escapeHtml(k)}"${k === board.key ? ' selected' : ''}>${escapeHtml(periodText(board.scope, k))}</option>`).join('')}</select>
        </label>
        <p class="ranking__closes">${escapeHtml(board.settled ? t('ranking.settled') : t('ranking.closes', { when: new Date(board.closes).toLocaleString(localeTag()) }))}</p>
      </div>
      <div class="ranking__boards">
        ${boardHtml('tokens', board.tokens, tokens)}
        ${boardHtml('spend', board.spend, dollars)}
      </div>
      ${board.me.excluded ? '' : `<p class="ranking__me">${escapeHtml(placeLine(board.me))}</p>
      <label class="ranking__anon"><input type="checkbox" data-anon${board.me.anonymous ? ' checked' : ''} /> <span>${escapeHtml(t('ranking.anonymous'))}</span></label>`}`;
  }

  function paintDetail(title) {
    const box = host.querySelector('.ranking__detail');
    if (!box) return;
    stopCreature?.();
    stopCreature = null;
    const creature = creatureOf(title);
    if (!title || !creature) {
      box.innerHTML = `<div class="ranking__stage ranking__stage--none"><img src="/assets/mascot/idle.gif" alt="" decoding="async" /></div>
        <h4 class="themes__title">${escapeHtml(t('ranking.noTitle'))}</h4>
        <p class="themes__desc">${escapeHtml(t('ranking.noTitleDesc'))}</p>`;
      return;
    }
    // The owner's shape: the creature, what earns it and how many have it, then the day it was got.
    const said = title.owned ? gotLine(title.earnedAt, 'title') : '';
    box.innerHTML = `<div class="ranking__stage${title.owned ? '' : ' is-locked'}">${title.owned ? '' : `<span class="themes__lock">${LOCK}</span>`}</div>
      <h4 class="themes__title">${escapeHtml(titleText(title))}</h4>
      <p class="ranking__petname">${escapeHtml(t(`ranking.pet.${creature}.name`))}</p>
      <p class="themes__desc">${escapeHtml(t(`ranking.pet.${creature}.desc`))}</p>
      ${factsHtml(titleFacts(title, titles?.progress))}
      ${said ? `<p class="themes__standing">${escapeHtml(said)}</p>` : ''}`;
    stopCreature = playInFrame(/** @type {HTMLElement} */ (box.querySelector('.ranking__stage')), creature);
  }

  function chipHtml(title) {
    const on = title.id === titles.equipped;
    return `<button type="button" class="ranking__title${on ? ' is-on' : ''}${title.owned ? '' : ' is-locked'}${title.id === looking ? ' is-looking' : ''}" aria-pressed="${on}" data-title="${escapeHtml(title.id)}" data-owned="${title.owned}">${escapeHtml(titleText(title))}</button>`;
  }

  function paintTitles() {
    const box = host.querySelector('.ranking__chips');
    if (!box || !titles) return;
    const none = `<button type="button" class="ranking__title${titles.equipped ? '' : ' is-on'}${looking === '' ? ' is-looking' : ''}" aria-pressed="${!titles.equipped}" data-title="" data-owned="true">${escapeHtml(t('ranking.noTitle'))}</button>`;
    box.innerHTML = none + titles.titles.map(chipHtml).join('');
  }

  /** On the chips as they stand, so a press does not rebuild what is under the pointer. */
  function markTitles() {
    for (const chip of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('.ranking__title'))) {
      const id = chip.dataset.title || '';
      const on = id === (titles.equipped || '');
      chip.classList.toggle('is-on', on);
      chip.classList.toggle('is-looking', id === looking);
      chip.setAttribute('aria-pressed', String(on));
    }
  }

  const saver = latestOnly((id) => api.equipTitle(id || null), {
    landed: (answer) => {
      worn = answer.equipped ?? null;
    },
    failed: (err) => {
      titles.equipped = worn;
      markTitles();
      toast(err.message, 'error');
    },
  });

  function press(id) {
    const title = titles.titles.find((row) => row.id === id) || null;
    looking = id;
    paintDetail(title);
    if (id && !title?.owned) {
      markTitles();
      return;
    }
    titles.equipped = id || null;
    markTitles();
    void saver.push(id);
  }

  function ensureSkeleton() {
    if (host.querySelector('.ranking')) return;
    host.innerHTML = `<div class="ranking">
        <div class="ranking__top"><p class="hint">${escapeHtml(t('ranking.loading'))}</p></div>
        <h4 class="ranking__sub">${escapeHtml(t('ranking.titles'))}</h4>
        <p class="hint">${escapeHtml(t('ranking.titlesHint'))}</p>
        <div class="ranking__titles">
          <div class="ranking__chips" role="group" aria-label="${escapeHtml(t('ranking.titles'))}"></div>
          <aside class="ranking__detail" aria-live="polite"></aside>
        </div>
      </div>`;
  }

  async function loadBoards() {
    loading += 1;
    const mine = loading;
    try {
      const board = await api.ranking(scope, key);
      if (mine !== loading) return;
      scope = board.scope;
      key = board.key;
      paintBoards(board);
    } catch (err) {
      const box = host.querySelector('.ranking__top');
      if (mine === loading && box) box.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    }
  }

  /** Which visit to the page this is: an answer to an earlier one has nothing to draw on. */
  let visit = 0;

  async function load() {
    const here = (visit += 1);
    ensureSkeleton();
    const boards = loadBoards();
    try {
      const asked = saver.asked();
      const answer = await api.titles();
      // A save since this was asked knows better than an answer that may have been read before it landed.
      if (titles && !saver.sure(asked)) answer.equipped = titles.equipped;
      else worn = answer.equipped ?? null;
      titles = answer;
      if (looking === null) looking = titles.equipped || '';
      // Left while it was on its way: drawing now would start a creature nothing would stop.
      if (here === visit) {
        paintTitles();
        paintDetail(titles.titles.find((row) => row.id === looking) || null);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    await boards;
  }

  host.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const pickScope = /** @type {HTMLElement|null} */ (target.closest('[data-scope]'));
    if (pickScope) {
      if (pickScope.dataset.scope === scope) return;
      scope = pickScope.dataset.scope;
      key = '';
      for (const button of host.querySelectorAll('[data-scope]')) button.setAttribute('aria-checked', String(button === pickScope));
      void loadBoards();
      return;
    }
    const title = /** @type {HTMLElement|null} */ (target.closest('[data-title]'));
    if (title && titles) press(title.dataset.title || '');
  });
  host.addEventListener('change', async (event) => {
    const target = /** @type {HTMLInputElement} */ (event.target);
    if ('period' in target.dataset) {
      key = target.value;
      void loadBoards();
    } else if ('anon' in target.dataset) {
      try {
        await savePrefs({ rankAnonymous: target.checked });
        void loadBoards();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  return {
    load,
    /** Leaving the page: nothing on it should keep drawing. */
    leave() {
      stopCreature?.();
      stopCreature = null;
      looking = null;
    },
  };
}
