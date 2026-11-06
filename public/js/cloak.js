/**
 * Settings → Privacy → How your data travels (owner, 2026-11-05).
 *
 * The whole of what "data cloaking" and "chain-of-thought monitoring" mean and what is done
 * about them here, on one page, in the words of docs/research/2026-11-04-data-cloaking-cot-monitorability.md.
 * The figures and the provider table come from the server, because a test holds those to
 * what was measured and read (`MEASURED`, `PROVIDER_POLICIES`). Nothing here is the person's
 * except their three choices, so it can be read at any time and costs one request.
 *
 * Built from nodes and `textContent`: a sentence with `<EMAIL_…>` in it is words, not markup.
 */
import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';

/** The eight things the word is used for, in the order of how much they matter here. */
const MEANINGS = ['placeholders', 'zdr', 'stealth', 'reasoning', 'tee', 'image', 'poison', 'seo'];
const NOT_CAUGHT = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
const WILL_NOT = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
const HERE = ['h1', 'h2', 'h3', 'h4', 'h5'];
const STEPS = ['s1', 's2', 's3', 's4', 's5'];

/** What the research found, each beside where it can be read. */
const FINDINGS = [
  { id: 'f1', source: 'https://arxiv.org/abs/2503.11926', label: 'OpenAI, arXiv 2503.11926' },
  { id: 'f2', source: 'https://arxiv.org/abs/2503.11926', label: 'OpenAI, arXiv 2503.11926' },
  { id: 'f3', source: 'https://arxiv.org/abs/2505.05410', label: 'Anthropic, arXiv 2505.05410' },
  { id: 'f4', source: 'https://arxiv.org/abs/2512.18311', label: 'OpenAI, arXiv 2512.18311' },
  { id: 'f5', source: 'https://arxiv.org/abs/2603.05706', label: 'arXiv 2603.05706' },
  { id: 'f6', source: 'https://arxiv.org/abs/2507.11473', label: 'arXiv 2507.11473' },
];

/** A tag with a class and, optionally, its words. */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = String(text);
  return node;
}

function link(url, words) {
  const a = h('a', 'cloak__link', words);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
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

/** "6 Nov 2026", as this interface writes dates. */
const dated = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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

  function meanings() {
    const node = section('cloak.meanings.title');
    node.append(
      h('p', '', t('cloak.meanings.lede')),
      table(
        [t('cloak.col.meaning'), t('cloak.col.how'), t('cloak.col.here')],
        MEANINGS.map((id) => [t(`cloak.m.${id}.name`), t(`cloak.m.${id}.how`), t(`cloak.m.${id}.here`)]),
      ),
    );
    return node;
  }

  function hiding(masking) {
    const node = section('cloak.mask.title');
    node.append(list('ol', STEPS, 'cloak.mask'));
    node.append(h('h5', 'cloak__sub', t('cloak.measure.title')));
    node.append(h('p', '', t('cloak.measure.lede', { samples: masking.samples, clean: masking.clean, date: dated(masking.date) })));
    node.append(
      table(
        [t('cloak.col.kind'), t('cloak.col.caught'), t('cloak.col.right'), t('cloak.col.samples')],
        Object.entries(masking.kinds).map(([kind, f]) => [t(`route.kind.${kind}`), percent(f.recall), percent(f.precision), f.samples]),
      ),
    );
    node.append(h('h5', 'cloak__sub', t('cloak.miss.title')), list('ul', NOT_CAUGHT, 'cloak.miss'));
    return node;
  }

  function travels(data) {
    const node = section('cloak.policy.title');
    node.append(h('p', '', t('cloak.policy.lede', { date: dated(data.checked) })));
    node.append(
      table(
        [t('cloak.col.provider'), t('cloak.col.says'), t('cloak.col.source')],
        data.policies.map((p) => [t(`cloak.provider.${p.provider}`), t(`cloak.policy.${p.provider}`), link(p.source, t('cloak.read'))]),
      ),
    );
    return node;
  }

  function reasoning() {
    const node = section('cloak.cot.title');
    node.append(h('p', '', t('cloak.cot.lede')));
    const findings = h('ul', 'cloak__list');
    for (const { id, source, label } of FINDINGS) {
      const item = h('li', '', `${t(`cloak.cot.${id}`)} `);
      item.append(link(source, label));
      findings.append(item);
    }
    node.append(findings);
    node.append(h('h5', 'cloak__sub', t('cloak.here.title')), list('ul', HERE, 'cloak.here'));
    return node;
  }

  function monitor() {
    const node = section('cloak.monitor.title');
    node.append(h('p', '', t('cloak.monitor.how')), h('p', '', t('cloak.monitor.limits')));
    return node;
  }

  function refusals() {
    const node = section('cloak.not.title');
    node.append(list('ul', WILL_NOT, 'cloak.not'));
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
      h('p', 'settings__lede', t('cloak.lede')),
      settingsNow(),
      meanings(),
      hiding(data.masking),
      travels(data),
      reasoning(),
      monitor(),
      refusals(),
    );
  }

  return { load };
}
