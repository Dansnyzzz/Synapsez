import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * Settings → Ranking (owner, 2026-11-04): the month's and the year's top three by
 * tokens and by spending, your own place, and the titles you can wear on them.
 *
 * Only an account's name and the title it chose are ever shown. What the boards hold
 * and who is on them is decided in server/themes.js; this only draws it.
 */

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** A title in words: one earned for a place on a board says which board and when. */
export function titleText(title) {
  if (!title) return '';
  if (title.kind === 'award') {
    const when = title.scope === 'year' ? title.key : periodText('month', title.key);
    return t(`ranking.title.${title.board}`, { rank: title.rank, when });
  }
  return t(`ranking.title.${title.id}`);
}

function periodText(scope, key) {
  if (scope === 'year') return String(key);
  const [year, month] = String(key).split('-');
  return `${Number(month)}/${year}`;
}

const tokens = (n) => Number(n || 0).toLocaleString();
const dollars = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @param {{ host: HTMLElement, toast: (text: string, kind?: string) => void, savePrefs: (patch: any) => Promise<any> }} deps
 */
export function createRanking({ host, toast, savePrefs }) {
  let scope = 'month';
  let key = '';
  let loading = 0;

  function boardHtml(name, rows, format) {
    const body = rows.length
      ? rows.map((row) => `<li class="ranking__row${row.isMe ? ' is-me' : ''}">
            <span class="ranking__medal" aria-label="${escapeHtml(t('ranking.place', { n: row.rank }))}">${MEDAL[row.rank] || row.rank}</span>
            <span class="ranking__who"><span class="ranking__name">${escapeHtml(row.name || t('ranking.member'))}${row.isMe ? ` <span class="muted">${escapeHtml(t('ranking.you'))}</span>` : ''}</span>${row.title ? `<span class="ranking__chip">${escapeHtml(titleText(row.title))}</span>` : ''}</span>
            <span class="ranking__value">${escapeHtml(format(row.value))}</span>
          </li>`).join('')
      : `<li class="ranking__empty">${escapeHtml(t('ranking.empty'))}</li>`;
    return `<section class="ranking__board"><h4>${escapeHtml(t(`ranking.board.${name}`))}</h4><ol class="ranking__list">${body}</ol></section>`;
  }

  function placeLine(me) {
    if (me.excluded) return t('ranking.adminExcluded');
    const piece = (rank, value, format) => (rank ? t('ranking.placeLine', { rank, value: format(value) }) : t('ranking.notPlaced'));
    return `${t('ranking.board.tokens')}: ${piece(me.tokens.rank, me.tokens.value, tokens)} · ${t('ranking.board.spend')}: ${piece(me.spend.rank, me.spend.value, dollars)}`;
  }

  function draw(board, titles) {
    const held = titles.titles.filter((title) => title.owned);
    const locked = titles.titles.filter((title) => !title.owned);
    host.innerHTML = `<div class="ranking">
        <div class="ranking__bar">
          <div class="ranking__scope" role="radiogroup" aria-label="${escapeHtml(t('ranking.period'))}">
            ${['month', 'year'].map((name) => `<button type="button" role="radio" aria-checked="${name === board.scope}" data-scope="${name}">${escapeHtml(t(`ranking.scope.${name}`))}</button>`).join('')}
          </div>
          <label class="ranking__pick"><span class="sr-only">${escapeHtml(t('ranking.period'))}</span>
            <select class="sselect" data-period>${board.keys.map((k) => `<option value="${escapeHtml(k)}"${k === board.key ? ' selected' : ''}>${escapeHtml(periodText(board.scope, k))}</option>`).join('')}</select>
          </label>
          <p class="ranking__closes">${escapeHtml(board.settled ? t('ranking.settled') : t('ranking.closes', { when: new Date(board.closes).toLocaleString() }))}</p>
        </div>
        <div class="ranking__boards">
          ${boardHtml('tokens', board.tokens, tokens)}
          ${boardHtml('spend', board.spend, dollars)}
        </div>
        <p class="ranking__me">${escapeHtml(placeLine(board.me))}</p>
        <p class="hint">${escapeHtml(t('ranking.how'))}</p>
        ${board.me.excluded ? '' : `<label class="ranking__anon"><input type="checkbox" data-anon${board.me.anonymous ? ' checked' : ''} /> <span>${escapeHtml(t('ranking.anonymous'))}</span></label>`}

        <h4 class="ranking__sub">${escapeHtml(t('ranking.titles'))}</h4>
        <p class="hint">${escapeHtml(t('ranking.titlesHint'))}</p>
        <div class="ranking__titles" role="radiogroup" aria-label="${escapeHtml(t('ranking.titles'))}">
          <button type="button" class="ranking__title${titles.equipped ? '' : ' is-on'}" role="radio" aria-checked="${!titles.equipped}" data-title="">${escapeHtml(t('ranking.noTitle'))}</button>
          ${held.map((title) => `<button type="button" class="ranking__title${title.id === titles.equipped ? ' is-on' : ''}" role="radio" aria-checked="${title.id === titles.equipped}" data-title="${escapeHtml(title.id)}">${escapeHtml(titleText(title))}</button>`).join('')}
        </div>
        ${locked.length ? `<h4 class="ranking__sub">${escapeHtml(t('ranking.locked'))}</h4><ul class="ranking__locked">${locked.map((title) => `<li><span>${escapeHtml(titleText(title))}</span><span class="muted">${escapeHtml(title.needs?.tokens ? t('ranking.needsTokens', { n: tokens(title.needs.tokens) }) : title.needs?.spend ? t('ranking.needsSpend', { n: dollars(title.needs.spend) }) : '')}</span></li>`).join('')}</ul>` : ''}
      </div>`;
  }

  async function load() {
    loading += 1;
    const mine = loading;
    if (!host.firstElementChild) host.innerHTML = `<p class="hint">${escapeHtml(t('ranking.loading'))}</p>`;
    try {
      const [board, titles] = await Promise.all([api.ranking(scope, key), api.titles()]);
      if (mine !== loading) return;
      scope = board.scope;
      key = board.key;
      draw(board, titles);
    } catch (err) {
      if (mine === loading) host.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    }
  }

  host.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const pickScope = /** @type {HTMLElement|null} */ (target.closest('[data-scope]'));
    if (pickScope && pickScope.dataset.scope !== scope) {
      scope = pickScope.dataset.scope;
      key = '';
      load();
      return;
    }
    const title = /** @type {HTMLElement|null} */ (target.closest('[data-title]'));
    if (title) {
      try {
        await api.equipTitle(title.dataset.title || null);
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
  host.addEventListener('change', async (event) => {
    const target = /** @type {HTMLInputElement} */ (event.target);
    if ('period' in target.dataset) {
      key = target.value;
      load();
    } else if ('anon' in target.dataset) {
      try {
        await savePrefs({ rankAnonymous: target.checked });
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  return { load };
}
