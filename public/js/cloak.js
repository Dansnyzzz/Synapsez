/**
 * Settings → Privacy → Where your data goes (owner, 2026-11-05; cut to two parts 2026-11-08).
 *
 * The person's own three choices, and what the mask catches: measured when the page is
 * opened, by the shield that is running (server/deidentifyQuality.js), with what it hid in
 * this account's own conversations over thirty days beside it, counted, never shown.
 *
 * Built from nodes and `textContent`: a sentence with `<EMAIL_…>` in it is words, not markup.
 */
import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';

const NOT_CAUGHT = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

/** A tag with a class and, optionally, its words. */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = String(text);
  return node;
}

/** A table that scrolls inside its own box on a phone rather than widening the page. */
function table(headers, rows) {
  const box = h('div', 'cloak__table');
  const grid = h('table');
  const head = h('tr');
  for (const words of headers) {
    const th = h('th', '', words);
    th.scope = 'col';
    head.append(th);
  }
  const thead = h('thead');
  thead.append(head);
  const tbody = h('tbody');
  for (const row of rows) {
    const tr = h('tr');
    for (const cell of row) {
      const td = h('td');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = String(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  grid.append(thead, tbody);
  box.append(grid);
  return box;
}

const list = (tag, ids, prefix) => {
  const node = h(tag, 'cloak__list');
  for (const id of ids) node.append(h('li', '', t(`${prefix}.${id}`)));
  return node;
};

const percent = (share) => `${Math.round(share * 100)}%`;

/** "14:32, 8/11/2026": when it was measured, on the person's own clock. */
const measuredAt = (iso) =>
  new Date(iso).toLocaleString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric', year: 'numeric' });

/**
 * @param {object} deps
 * @param {any} deps.state  the app's shared state, for the account's own choices
 */
export function createCloakPage({ state }) {
  const host = () => document.getElementById('cloak-page');

  function section(titleKey) {
    const node = h('section', 'cloak__section');
    node.append(h('h4', 'cloak__title', t(titleKey)));
    return node;
  }

  function settingsNow() {
    const prefs = state.boot?.prefs || {};
    const node = section('cloak.now.title');
    const row = (key, on) => {
      const line = h('div', 'cloak__now');
      line.append(h('span', '', t(key)), h('span', on ? 'cloak__state is-on' : 'cloak__state', t(on ? 'cloak.on' : 'cloak.off')));
      return line;
    };
    node.append(
      row('cloak.now.mask', prefs.maskPersonal === true),
      row('cloak.now.strict', prefs.providerPrivacy === 'strict'),
      row('cloak.now.monitor', prefs.actionMonitor === true),
      h('p', 'cloak__note', t('cloak.now.change')),
    );
    return node;
  }

  function hiding(masking, mine) {
    const node = section('cloak.measure.title');
    node.append(h('p', '', t('cloak.measure.live', { samples: masking.samples, clean: masking.clean, when: measuredAt(masking.measuredAt) })));
    node.append(
      table(
        [t('cloak.col.kind'), t('cloak.col.caught'), t('cloak.col.right'), t('cloak.col.samples')],
        Object.entries(masking.kinds).map(([kind, f]) => [t(`route.kind.${kind}`), percent(f.recall), percent(f.precision), f.samples]),
      ),
    );
    // What was really hidden for this account: counts, because there is no answer key to score real text against.
    node.append(h('h5', 'cloak__sub', t('cloak.mine.title')));
    const counted = Object.entries(mine?.kinds || {});
    if (counted.length) {
      node.append(table([t('cloak.col.kind'), t('cloak.col.hidden')], counted.map(([kind, n]) => [t(`route.kind.${kind}`), n])));
      node.append(h('p', 'cloak__note', t('cloak.mine.note')));
    } else {
      node.append(h('p', 'cloak__note', t(state.boot?.prefs?.maskPersonal === true ? 'cloak.mine.none' : 'cloak.mine.off')));
    }
    node.append(h('h5', 'cloak__sub', t('cloak.miss.title')), list('ul', NOT_CAUGHT, 'cloak.miss'));
    return node;
  }

  async function load() {
    const page = host();
    if (!page) return;
    page.replaceChildren(h('p', 'cloak__note', t('cloak.loading')));
    let data;
    try {
      data = await api.privacyOverview();
    } catch (err) {
      page.replaceChildren(h('p', 'cloak__note', err.message));
      return;
    }
    page.replaceChildren(
      h('h3', 'settings__title', t('cloak.title')),
      settingsNow(),
      hiding(data.masking, data.mine),
    );
  }

  return { load };
}
