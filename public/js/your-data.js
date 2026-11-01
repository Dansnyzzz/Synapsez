/**
 * Settings → Privacy → Your data → Manage (owner, 2026-11-01, after Claude's).
 *
 * One kind of what this account holds — its conversations, the files the
 * assistant made, the files it sent, the feedback it gave — on a page of its
 * own, with "← Privacy" back. What anybody else can reach is listed on top:
 * a conversation or a made file with a link, an upload inside a shared
 * conversation, feedback sent with a copy of a conversation. The rest is below,
 * searched by name and read a page at a time.
 *
 * A conversation or a made file is made public or private from its Visibility
 * menu — the same share and stop-sharing routes as everywhere else, so the link
 * made here is the link made there. An upload has no link of its own: it is
 * reachable while the conversation it was sent in is shared, and the row says
 * so rather than offering a switch that would really be the conversation's.
 *
 * Built from nodes and `textContent`: names are the person's, and the model's.
 */
import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';
import { toast } from './render.js';
import { openMenu } from './customize.js';
import { humanSize } from './format.js';

const PAGE = 20;

/** Each kind: its two halves, the column that is not the name, and what can be done. */
const KINDS = {
  chats: { visibility: 'switch', open: 'chat' },
  artifacts: { visibility: 'switch', open: 'file' },
  uploads: { visibility: 'fixed', open: 'file' },
  feedback: { visibility: null, open: null },
};

const glyph = (paths, size = 16) =>
  `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const MORE = glyph('<circle cx="5" cy="10" r=".9" fill="currentColor"/><circle cx="10" cy="10" r=".9" fill="currentColor"/><circle cx="15" cy="10" r=".9" fill="currentColor"/>', 18);
const CHEVRON = glyph('<path d="m6 8 4 4 4-4"/>', 14);
const PREV = glyph('<path d="m12 5-5 5 5 5"/>');
const NEXT = glyph('<path d="m8 5 5 5-5 5"/>');

/** A tag with a class and, optionally, its words. */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = String(text);
  return node;
}

/** "Oct 30, 2026", as this interface's language writes dates. */
const day = (iso) => {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * @param {object} deps
 * @param {(tab: string) => void} deps.selectTab   switch Settings' section
 * @param {(id: string) => void} deps.openChat     close Settings and open a conversation
 * @param {(file: {id: string, name?: string}) => void} deps.openFile  open a file in the viewer
 * @param {(id: string) => Promise<void>} deps.chatDeleted  what the rest of the app does when one goes
 */
export function createYourData(deps) {
  const host = /** @type {HTMLElement} */ (document.getElementById('data-page'));
  /** The kind on screen, its search and page — kept while a menu acts on a row. */
  let view = { kind: 'chats', query: '', offset: 0 };
  let searchTimer = 0;

  /** The count beside each Manage in Privacy: what is shared now. */
  async function paintCounts() {
    try {
      const { shared = {} } = await api.dataSummary();
      for (const node of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-shared-count]'))) {
        const n = Number(shared[node.dataset.sharedCount]) || 0;
        node.textContent = n ? t(node.dataset.sharedCount === 'feedback' ? 'data.countWithCopy' : 'data.countShared', { n }) : '';
      }
    } catch {
      /* the counts are a glance, not a promise; the Manage pages say it in full */
    }
  }

  /** Open one kind's page. */
  function show(kind) {
    if (!KINDS[kind]) return;
    view = { kind, query: '', offset: 0 };
    deps.selectTab('data');
    draw();
  }

  /** The page's frame: both halves, empty until their rows arrive. */
  function draw() {
    const { kind } = view;
    host.replaceChildren();
    const top = h('section', 'data__part');
    top.append(h('h3', 'data__title', t(`data.${kind}.shared`)), h('p', 'data__hint', t(`data.${kind}.sharedHint`)));
    const sharedList = h('div', 'data__list');
    sharedList.dataset.list = 'shared';
    top.append(sharedList);

    const rest = h('section', 'data__part');
    rest.append(h('h3', 'data__title', t(`data.${kind}.rest`)), h('p', 'data__hint', t(`data.${kind}.restHint`)));
    const bar = h('div', 'data__bar');
    const search = /** @type {HTMLInputElement} */ (h('input', 'data__search'));
    search.type = 'search';
    search.autocomplete = 'off';
    const searchLabel = t(kind === 'feedback' ? 'data.searchFeedback' : 'data.searchByName');
    search.placeholder = searchLabel;
    search.setAttribute('aria-label', searchLabel);
    search.value = view.query;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        view.query = search.value;
        view.offset = 0;
        loadRest();
      }, 250);
    });
    const count = h('span', 'data__count');
    count.setAttribute('aria-live', 'polite');
    bar.append(search, count);
    const restList = h('div', 'data__list');
    restList.dataset.list = 'rest';
    const pager = h('div', 'data__pager');
    pager.hidden = true;
    const prev = /** @type {HTMLButtonElement} */ (h('button', 'icon-btn data__page'));
    prev.type = 'button';
    prev.innerHTML = PREV;
    prev.setAttribute('aria-label', t('data.prevPage'));
    prev.addEventListener('click', () => {
      view.offset = Math.max(0, view.offset - PAGE);
      loadRest();
    });
    const next = /** @type {HTMLButtonElement} */ (h('button', 'icon-btn data__page'));
    next.type = 'button';
    next.innerHTML = NEXT;
    next.setAttribute('aria-label', t('data.nextPage'));
    next.addEventListener('click', () => {
      view.offset += PAGE;
      loadRest();
    });
    pager.append(prev, next);
    rest.append(bar, restList, pager);
    host.append(top, rest);
    loadShared();
    loadRest();
  }

  const listOf = (name) => /** @type {HTMLElement | null} */ (host.querySelector(`[data-list="${name}"]`));

  async function loadShared() {
    const kind = view.kind;
    try {
      // Everything shared, up to a hundred: it is the half that matters most.
      const page = await api.dataList(kind, { shared: true, limit: 100 });
      // Another kind opened meanwhile: this answer is not its.
      if (kind !== view.kind) return;
      const list = listOf('shared');
      if (list) list.replaceChildren(page.items.length ? table(kind, page.items, true) : h('p', 'data__empty', t('data.noneShared')));
    } catch (err) {
      listOf('shared')?.replaceChildren(h('p', 'data__empty', err.message));
    }
  }

  async function loadRest() {
    const kind = view.kind;
    const asked = { ...view };
    try {
      const page = await api.dataList(kind, { q: asked.query, offset: asked.offset, limit: PAGE });
      // A slower answer to an older question is not drawn over a newer one.
      if (asked.kind !== view.kind || asked.query !== view.query || asked.offset !== view.offset) return;
      // A page emptied by a deletion steps back one.
      if (!page.items.length && page.total && view.offset) {
        view.offset = Math.max(0, view.offset - PAGE);
        return loadRest();
      }
      const list = listOf('rest');
      if (!list) return;
      list.replaceChildren(page.items.length ? table(kind, page.items, false) : h('p', 'data__empty', t(view.query ? 'data.noMatch' : 'data.noneRest')));
      const count = /** @type {HTMLElement} */ (host.querySelector('.data__count'));
      count.textContent = page.total ? t('data.showing', { from: view.offset + 1, to: view.offset + page.items.length, total: page.total }) : '';
      const pager = /** @type {HTMLElement} */ (host.querySelector('.data__pager'));
      pager.hidden = page.total <= PAGE;
      const [prev, next] = /** @type {NodeListOf<HTMLButtonElement>} */ (pager.querySelectorAll('button'));
      prev.disabled = view.offset === 0;
      next.disabled = view.offset + page.items.length >= page.total;
    } catch (err) {
      listOf('rest')?.replaceChildren(h('p', 'data__empty', err.message));
    }
  }

  /** Both halves again, and the counts in Privacy — after anything changed. */
  function reload() {
    loadShared();
    loadRest();
    paintCounts();
  }

  /* ── the table ──────────────────────────────────────────────────── */

  function table(kind, items, shared) {
    const spec = KINDS[kind];
    const grid = h('div', `dtable${spec.visibility ? '' : ' dtable--two'}`);
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', t(`data.${kind}.${shared ? 'shared' : 'rest'}`));
    const head = h('div', 'dtable__head');
    head.setAttribute('role', 'row');
    const columns = [t(kind === 'feedback' ? 'data.col.feedback' : 'data.col.name'), spec.visibility ? t('data.col.visibility') : null, t(kind === 'feedback' ? 'data.col.sent' : 'data.col.updated'), ''];
    for (const label of columns.filter((c) => c !== null)) {
      const cell = h('span', null, label);
      cell.setAttribute('role', 'columnheader');
      head.append(cell);
    }
    grid.append(head);
    for (const item of items) grid.append(row(kind, item));
    return grid;
  }

  const cell = (className) => {
    const node = h('span', className);
    node.setAttribute('role', 'cell');
    return node;
  };

  function row(kind, item) {
    const spec = KINDS[kind];
    const line = h('div', 'dtable__row');
    line.setAttribute('role', 'row');
    line.dataset.id = item.id;

    const name = cell('dtable__name');
    const label =
      kind === 'feedback'
        ? `${t(`feedback.kind.${item.kind}`)} · ${item.topic === 'other' ? item.topicOther || t('feedback.topic.other') : t(`feedback.topic.${item.topic}`)}`
        : item.name || t('chat.untitled');
    if (spec.open) {
      const open = h('button', 'dtable__link', label);
      /** @type {HTMLButtonElement} */ (open).type = 'button';
      open.addEventListener('click', () => (spec.open === 'chat' ? deps.openChat(item.id) : deps.openFile({ id: item.id, name: item.name })));
      name.append(open);
    } else name.append(h('span', 'dtable__label', label));
    const sub = subline(kind, item);
    if (sub) name.append(h('span', 'dtable__sub', sub));
    line.append(name);

    if (spec.visibility === 'switch') {
      const at = cell('dtable__vis');
      const pill = /** @type {HTMLButtonElement} */ (h('button', `dvis${item.shared ? ' is-public' : ''}`));
      pill.type = 'button';
      pill.setAttribute('aria-haspopup', 'menu');
      pill.setAttribute('aria-label', t('data.visibilityOf', { name: label, state: t(item.shared ? 'data.public' : 'data.private') }));
      pill.innerHTML = `<span class="dvis__state"></span>${CHEVRON}`;
      /** @type {HTMLElement} */ (pill.firstElementChild).textContent = t(item.shared ? 'data.public' : 'data.private');
      pill.addEventListener('click', () =>
        openMenu(pill, [
          { label: t('data.private'), checked: !item.shared, run: () => (item.shared ? setVisibility(kind, item, false) : null) },
          { label: t('data.public'), checked: !!item.shared, run: () => (item.shared ? null : setVisibility(kind, item, true)) },
        ]),
      );
      at.append(pill);
      line.append(at);
    } else if (spec.visibility === 'fixed') {
      const at = cell('dtable__vis');
      const pill = h('span', `dvis dvis--fixed${item.shared ? ' is-public' : ''}`, t(item.shared ? 'data.viaLink' : 'data.private'));
      // Which conversation it goes with, and how to make it private — said, not switched.
      if (item.shared) pill.title = t('data.viaLinkWhy', { chat: item.chatTitle || t('chat.untitled') });
      at.append(pill);
      line.append(at);
    }

    line.append(Object.assign(cell('dtable__when'), { textContent: day(item.updatedAt) }));

    const end = cell('dtable__end');
    const more = /** @type {HTMLButtonElement} */ (h('button', 'icon-btn dtable__more'));
    more.type = 'button';
    more.innerHTML = MORE;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', t('settings.moreFor', { name: label }));
    more.addEventListener('click', () => openMenu(more, actions(kind, item)));
    end.append(more);
    line.append(end);
    return line;
  }

  /** The line under a name: a file's size and its conversation; feedback's own words. */
  function subline(kind, item) {
    if (kind === 'feedback') return [item.body, item.chatTitle ? t('data.withChat', { chat: item.chatTitle }) : ''].filter(Boolean).join(' · ');
    if (kind === 'chats') return '';
    return [humanSize(item.bytes), item.chatTitle ? t('data.inChat', { chat: item.chatTitle }) : ''].filter(Boolean).join(' · ');
  }

  /** The ⋯ menu of one row. */
  function actions(kind, item) {
    const link = item.link ? new URL(item.link, location.origin).href : null;
    const copy = link ? [{ label: t('data.copyLink'), run: () => copyLink(link) }] : [];
    if (kind === 'chats') {
      return [
        ...copy,
        {
          label: t('chat.delete'),
          danger: true,
          confirm: t('action.reallyDelete'),
          run: async () => {
            await api.deleteChat(item.id);
            await deps.chatDeleted(item.id);
            toast(t('chat.deleted'), 'ok');
            reload();
          },
        },
      ];
    }
    if (kind === 'artifacts' || kind === 'uploads') {
      return [
        { label: t('data.open'), run: () => deps.openFile({ id: item.id, name: item.name }) },
        { label: t('data.download'), run: () => download(item) },
        ...copy,
        {
          label: t('data.delete'),
          danger: true,
          confirm: t('action.reallyDelete'),
          run: async () => {
            await (kind === 'artifacts' ? api.deleteFile(item.id) : api.deleteUpload(item.id));
            toast(t('data.deleted'), 'ok');
            reload();
          },
        },
      ];
    }
    return [
      ...(item.shared
        ? [
            {
              label: t('data.forgetCopy'),
              confirm: t('data.reallyForgetCopy'),
              run: async () => {
                await api.forgetFeedbackCopy(item.id);
                toast(t('data.copyForgotten'), 'ok');
                reload();
              },
            },
          ]
        : []),
      {
        label: t('data.delete'),
        danger: true,
        confirm: t('action.reallyDelete'),
        run: async () => {
          await api.deleteOwnFeedback(item.id);
          toast(t('data.deleted'), 'ok');
          reload();
        },
      },
    ];
  }

  /**
   * Public or private. Making one public makes its link and copies it, since a
   * link is what being public is for; making one private takes the link back,
   * and sharing again later makes a new one.
   */
  async function setVisibility(kind, item, on) {
    if (kind === 'chats') {
      if (on) {
        const { path } = await api.shareChat(item.id);
        await copyLink(new URL(path, location.origin).href, 'data.nowPublic');
      } else {
        await api.unshareChat(item.id);
        toast(t('data.nowPrivate'), 'ok');
      }
    } else if (on) {
      const { path } = await api.shareFile(item.id);
      await copyLink(new URL(path, location.origin).href, 'data.nowPublic');
    } else {
      await api.unshareFile(item.id);
      toast(t('data.nowPrivate'), 'ok');
    }
    reload();
  }

  async function copyLink(href, said = 'data.linkCopied') {
    try {
      await navigator.clipboard.writeText(href);
      toast(t(said), 'ok');
    } catch {
      // Some browsers refuse the clipboard outside a direct press: the link is still shown.
      toast(`${t(said === 'data.linkCopied' ? 'data.linkIs' : 'data.nowPublicLinkIs')} ${href}`, 'ok', { ms: 12000 });
    }
  }

  function download(item) {
    const a = document.createElement('a');
    a.href = `/api/attachments/${encodeURIComponent(item.id)}?download=1`;
    a.download = item.name || '';
    document.body.append(a);
    a.click();
    a.remove();
  }

  // Each Manage in Privacy opens its own kind.
  for (const button of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-manage]'))) {
    button.addEventListener('click', () => show(/** @type {string} */ (button.dataset.manage)));
  }

  return { show, paintCounts, reload };
}
