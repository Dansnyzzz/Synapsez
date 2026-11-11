/**
 * The things a tool result draws that are not charts: a map, a gallery of
 * pictures, and the ready-made cards — recipe, itinerary, comparison, quiz,
 * flashcards, translation, how-to, and a scores card.
 *
 * Every one is built from nodes and `textContent`, never from markup: the words
 * in them are the model's, and the model's words are data. Pictures come from
 * this app's own `/api/image` and `/api/map` routes, never from the sites
 * themselves (see server/imageProxy.js), so the page's image policy stays
 * "this app only".
 */
import { t, has, localeTag } from './i18n.js';
import { createQuizPlan } from './quiz-plan.js';

/** A tag with a class and, optionally, text. */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = String(text);
  return node;
}

/** A picture fetched through the app, so the browser never asks the site itself. */
const viaApp = (url) => `/api/image?u=${encodeURIComponent(String(url || ''))}`;

function shell(kind, title) {
  const figure = h('figure', `widget xcard xcard--${kind}`);
  if (title) figure.append(h('figcaption', 'widget__caption', title));
  return figure;
}

function link(href, text, className = '') {
  const a = h('a', className, text);
  if (/^https?:\/\//i.test(String(href || ''))) {
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return a;
}

/* ── map ──────────────────────────────────────────────────────────── */

const TILE = 256;

/** Web Mercator: longitude/latitude to world pixels at a zoom. */
export function project(lat, lon, zoom) {
  const scale = TILE * 2 ** zoom;
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/** The closest zoom at which every point fits inside `width` × `height`, with a margin. */
export function fitZoom(points, width, height, max = 16) {
  if (points.length < 2) return 14;
  for (let z = max; z > 1; z -= 1) {
    const ps = points.map(([lat, lon]) => project(lat, lon, z));
    const w = Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x));
    const hh = Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y));
    if (w <= width * 0.8 && hh <= height * 0.8) return z;
  }
  return 2;
}

export function mapFigure(widget) {
  const points = (Array.isArray(widget?.points) ? widget.points : [])
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lon)))
    .slice(0, 20);
  if (!points.length) return null;
  const line = (Array.isArray(widget?.line) ? widget.line : []).filter((p) => Array.isArray(p) && p.length >= 2);
  /*
   * A nearby search: numbered pins, the spot it was centred on as a dot of its
   * own, and the places listed beside the map — name, what it is, how far,
   * when it is open — the way a map app shows the results of a search.
   */
  const listed = widget?.list === true;
  const center = Number.isFinite(Number(widget?.center?.lat)) && Number.isFinite(Number(widget?.center?.lon)) ? widget.center : null;
  const mark = (i) => (listed ? String(i + 1) : String.fromCharCode(65 + i));

  const figure = shell('map', widget.title || t('card.map'));
  if (listed) figure.classList.add('xmap-list');
  const stage = h('div', 'xmap');
  const tiles = h('div', 'xmap__tiles');
  /*
   * The picture is the tile layer, not the whole stage (ACC-011). The zoom
   * buttons live in the stage, and a `role="img"` around them made them
   * presentational — a screen reader could not find or press them. The places
   * are named here and listed again, in words, under the map.
   */
  tiles.setAttribute('role', 'img');
  tiles.setAttribute('aria-label', points.map((p) => p.detail || p.label).join(' · '));
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.setAttribute('class', 'xmap__overlay');
  overlay.setAttribute('aria-hidden', 'true');
  stage.append(tiles, overlay);

  const all = [...points.map((p) => [Number(p.lat), Number(p.lon)]), ...(center ? [[Number(center.lat), Number(center.lon)]] : []), ...line];
  let zoom = null;
  let size = { w: 0, h: 0 };
  /** The place whose row is pointed at or focused, drawn on top and larger. */
  let lit = -1;
  /*
   * The lit pin larger and on top of the others, where it can be seen. Only the
   * pins change: redrawing the whole map on every hover replaced its tiles too,
   * and each pass along the list flickered the map and asked for them again.
   */
  const relight = () => {
    for (const g of overlay.querySelectorAll('.xmap__pin')) {
      const on = Number(g.getAttribute('data-i')) === lit;
      g.classList.toggle('is-lit', on);
      if (on) overlay.append(g);
    }
  };

  const draw = () => {
    const { w, h: height } = size;
    if (!w || !height) return;
    if (zoom == null) zoom = fitZoom(all, w, height);
    const ps = all.map(([lat, lon]) => project(lat, lon, zoom));
    const cx = (Math.min(...ps.map((p) => p.x)) + Math.max(...ps.map((p) => p.x))) / 2;
    const cy = (Math.min(...ps.map((p) => p.y)) + Math.max(...ps.map((p) => p.y))) / 2;
    const left = cx - w / 2;
    const top = cy - height / 2;
    const count = 2 ** zoom;

    tiles.replaceChildren();
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty += 1) {
      if (ty < 0 || ty >= count) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx += 1) {
        const wrapped = ((tx % count) + count) % count;
        const img = h('img', 'xmap__tile');
        img.alt = '';
        img.decoding = 'async';
        img.src = `/api/map/${zoom}/${wrapped}/${ty}`;
        img.style.left = `${tx * TILE - left}px`;
        img.style.top = `${ty * TILE - top}px`;
        tiles.append(img);
      }
    }

    overlay.setAttribute('viewBox', `0 0 ${w} ${height}`);
    overlay.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    if (line.length >= 2) {
      const path = document.createElementNS(ns, 'polyline');
      path.setAttribute('class', 'xmap__line');
      path.setAttribute('points', line.map(([lat, lon]) => {
        const p = project(lat, lon, zoom);
        return `${(p.x - left).toFixed(1)},${(p.y - top).toFixed(1)}`;
      }).join(' '));
      overlay.append(path);
    }
    if (center) {
      const c = project(Number(center.lat), Number(center.lon), zoom);
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'xmap__here');
      g.setAttribute('transform', `translate(${(c.x - left).toFixed(1)},${(c.y - top).toFixed(1)})`);
      const halo = document.createElementNS(ns, 'circle');
      halo.setAttribute('r', '11');
      halo.setAttribute('class', 'xmap__here-halo');
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('r', '5.5');
      const title = document.createElementNS(ns, 'title');
      title.textContent = center.label || '';
      g.append(halo, dot, title);
      overlay.append(g);
    }
    points.forEach((pt, i) => {
      const p = project(Number(pt.lat), Number(pt.lon), zoom);
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'xmap__pin');
      g.setAttribute('data-i', String(i));
      g.setAttribute('transform', `translate(${(p.x - left).toFixed(1)},${(p.y - top).toFixed(1)})`);
      const pin = document.createElementNS(ns, 'path');
      pin.setAttribute('d', 'M0 0 C-2 -6 -9 -10 -9 -17 A9 9 0 1 1 9 -17 C9 -10 2 -6 0 0 Z');
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cy', '-17');
      // Room for a number to be read inside it, where the pins are numbered.
      dot.setAttribute('r', listed ? '6' : '3.5');
      g.append(pin, dot);
      if (points.length > 1 || listed) {
        const n = document.createElementNS(ns, 'text');
        n.setAttribute('y', '-13.5');
        n.setAttribute('text-anchor', 'middle');
        n.textContent = mark(i);
        g.append(n);
      }
      const title = document.createElementNS(ns, 'title');
      title.textContent = pt.detail || pt.label || '';
      g.append(title);
      overlay.append(g);
    });
    relight();
  };

  const observer = new ResizeObserver(([entry]) => {
    size = { w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) };
    draw();
  });
  observer.observe(stage);

  const controls = h('div', 'xmap__controls');
  const zoomBy = (delta, label) => {
    const b = h('button', 'xmap__zoom', delta > 0 ? '+' : '−');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => {
      zoom = Math.max(2, Math.min(18, (zoom ?? 12) + delta));
      draw();
    });
    return b;
  };
  controls.append(zoomBy(1, t('card.zoomIn')), zoomBy(-1, t('card.zoomOut')));
  stage.append(controls);

  const foot = h('div', 'xmap__foot');
  const legend = h(listed ? 'ol' : 'div', listed ? 'xmap__results' : 'xmap__places');
  points.forEach((pt, i) => {
    if (listed) {
      // Each result: its number on the map, its name (to OpenStreetMap), what
      // it is and how far, and where. Pointing at it lights its pin.
      const row = h('li', 'xmap__result');
      const name = link(pt.url, pt.label || pt.detail || '', 'xmap__result-name');
      row.append(h('span', 'xmap__letter', mark(i)));
      const body = h('div', 'xmap__result-body');
      body.append(name);
      if (pt.meta) body.append(h('span', 'xmap__result-meta', String(pt.meta)));
      if (pt.address) body.append(h('span', 'xmap__result-addr', String(pt.address)));
      row.append(body);
      const light = (on) => {
        lit = on ? i : -1;
        relight();
      };
      row.addEventListener('pointerenter', () => light(true));
      row.addEventListener('pointerleave', () => light(false));
      row.addEventListener('focusin', () => light(true));
      row.addEventListener('focusout', () => light(false));
      legend.append(row);
      return;
    }
    const row = h('div', 'xmap__place');
    if (points.length > 1) row.append(h('span', 'xmap__letter', mark(i)));
    row.append(h('span', null, pt.label || pt.detail || ''));
    legend.append(row);
  });
  // A route opens as directions, by the way it was asked for; anything else, centred on the map.
  const engine = { walking: 'fossgis_osrm_foot', cycling: 'fossgis_osrm_bike' }[widget?.mode] || 'fossgis_osrm_car';
  const focus = center || points[0];
  const open = link(
    !listed && points.length > 1
      ? `https://www.openstreetmap.org/directions?engine=${engine}&route=${points[0].lat}%2C${points[0].lon}%3B${points[1].lat}%2C${points[1].lon}`
      : `https://www.openstreetmap.org/?mlat=${focus.lat}&mlon=${focus.lon}#map=15/${focus.lat}/${focus.lon}`,
    t('card.openMap'),
    'xmap__open',
  );
  const credit = h('span', 'xmap__credit', '© OpenStreetMap');
  if (listed) {
    // Beside the map where there is room, under it where there is not (CSS).
    const body = h('div', 'xmap__body');
    const side = h('div', 'xmap__side');
    side.append(legend);
    body.append(stage, side);
    foot.append(open, credit);
    figure.append(body, foot);
    return figure;
  }
  foot.append(legend, open, credit);
  figure.append(stage, foot);
  return figure;
}

/* ── gallery ──────────────────────────────────────────────────────── */

export function galleryFigure(widget) {
  const images = (Array.isArray(widget?.images) ? widget.images : []).filter((i) => i?.thumb).slice(0, 12);
  if (!images.length) return null;
  const figure = shell('images', widget.title || t('card.images'));
  const grid = h('div', 'xgallery');
  for (const [i, image] of images.entries()) {
    const tile = link(image.page, null, 'xgallery__item');
    tile.title = [image.title, image.creator, image.license].filter(Boolean).join(' · ');
    const img = h('img', 'xgallery__img');
    img.src = viaApp(image.thumb);
    img.alt = image.title || `${widget.title || ''} ${i + 1}`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => tile.classList.add('is-missing'));
    const cap = h('span', 'xgallery__cap');
    cap.append(h('span', 'xgallery__n', String(i + 1)), h('span', 'xgallery__title', image.title));
    if (image.license) cap.append(h('span', 'xgallery__lic', image.license));
    tile.append(img, cap);
    grid.append(tile);
  }
  figure.append(grid);
  return figure;
}

/* ── the cards ────────────────────────────────────────────────────── */

function heading(text) {
  return h('h4', 'xcard__h', text);
}

function recipe(card, body) {
  const meta = h('div', 'xcard__chips');
  if (card.servings) meta.append(h('span', 'xchip', `${t('card.servings')}: ${card.servings}`));
  if (card.time) meta.append(h('span', 'xchip', `${t('card.time')}: ${card.time}`));
  if (meta.childElementCount) body.append(meta);
  const cols = h('div', 'xrecipe');
  const ing = h('div', 'xrecipe__col');
  ing.append(heading(t('card.ingredients')));
  const list = h('ul', 'xcheck');
  for (const item of card.ingredients) {
    const li = h('li');
    const label = h('label');
    const box = h('input');
    box.type = 'checkbox';
    label.append(box, h('span', null, item));
    li.append(label);
    list.append(li);
  }
  ing.append(list);
  const steps = h('div', 'xrecipe__col');
  steps.append(heading(t('card.method')));
  const ol = h('ol', 'xsteps');
  for (const step of card.steps) ol.append(h('li', null, step));
  steps.append(ol);
  cols.append(ing, steps);
  body.append(cols);
  if (card.tips?.length) {
    body.append(heading(t('card.tips')));
    const ul = h('ul', 'xtips');
    for (const tip of card.tips) ul.append(h('li', null, tip));
    body.append(ul);
  }
}

function itinerary(card, body) {
  for (const day of card.days) {
    const section = h('section', 'xday');
    section.append(h('h4', 'xday__label', day.label));
    const ol = h('ol', 'xtimeline');
    for (const item of day.items) {
      const li = h('li', 'xtimeline__item');
      if (item.time) li.append(h('span', 'xtimeline__time', item.time));
      const text = h('div', 'xtimeline__text');
      text.append(h('div', 'xtimeline__title', item.title));
      if (item.place) {
        text.append(link(`https://www.openstreetmap.org/search?query=${encodeURIComponent(item.place)}`, `📍 ${item.place}`, 'xtimeline__place'));
      }
      if (item.detail) text.append(h('div', 'xtimeline__detail', item.detail));
      li.append(text);
      ol.append(li);
    }
    section.append(ol);
    body.append(section);
  }
}

function comparison(card, body) {
  const scroll = h('div', 'xcompare');
  const table = h('table', 'xcompare__table');
  const head = h('tr');
  head.append(h('th'));
  card.items.forEach((name, i) => {
    const th = h('th', i === card.recommended ? 'is-best' : '', name);
    th.scope = 'col';
    if (i === card.recommended) th.append(h('span', 'xcompare__badge', t('card.recommended')));
    head.append(th);
  });
  const thead = h('thead');
  thead.append(head);
  const tbody = h('tbody');
  for (const row of card.rows) {
    const tr = h('tr');
    const th = h('th', null, row.label);
    th.scope = 'row';
    tr.append(th);
    row.values.forEach((v, i) => tr.append(h('td', i === card.recommended ? 'is-best' : '', v)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
  body.append(scroll);
  if (card.verdict) body.append(h('p', 'xcard__verdict', card.verdict));
}

/**
 * A quiz the way Quizizz runs one (UX-022, owner 2026-11-02): twenty at a time,
 * the missed ones again for two more rounds, any still missed carried into the
 * next set's — and it can be started over, or the missed ones tried again, as
 * often as the person likes. The order is quiz-plan.js; this draws it.
 */
function quiz(card, body) {
  const qs = card.questions;
  const everyQuestion = qs.map((_, i) => i);
  let plan = createQuizPlan(everyQuestion);
  /** The option picked for the question on screen; null until it is answered. */
  let chosen = null;
  const progress = h('div', 'xquiz__progress');
  const stage = h('div', 'xquiz__stage');
  const nav = h('div', 'xquiz__nav');
  const restart = h('button', 'xbtn', t('card.restart'));
  const next = h('button', 'xbtn xbtn--primary', t('card.next'));
  restart.type = 'button';
  next.type = 'button';
  const score = h('div', 'xquiz__score');
  score.setAttribute('role', 'status');
  nav.append(restart, score, next);

  const begin = (order) => {
    plan = createQuizPlan(order);
    chosen = null;
    paint();
    /** @type {HTMLElement|null} */ (stage.querySelector('button'))?.focus();
  };

  const paintEnd = () => {
    const { firstTryRight, asked, missed } = plan.summary();
    progress.textContent = '';
    stage.replaceChildren(
      h('p', 'xquiz__q', t('card.quizDone', { n: String(firstTryRight), total: String(asked) })),
      h('p', 'xquiz__why', missed.length ? t('card.stillMissed', { n: String(missed.length) }) : t('card.allLearned')),
    );
    if (missed.length) {
      const again = h('button', 'xbtn xbtn--primary', t('card.retryMissed'));
      again.type = 'button';
      again.addEventListener('click', () => begin(missed));
      stage.append(again);
    }
    score.textContent = '';
    next.hidden = true;
  };

  const paint = () => {
    const now = plan.current();
    if (!now) return paintEnd();
    next.hidden = false;
    const q = qs[now.index];
    const where = t('card.questionOf', { n: String(now.n), total: String(now.total) });
    progress.textContent =
      now.round > 0
        ? `${t('card.redoRound', { round: String(now.round), rounds: String(now.rounds) })} · ${where}`
        : now.sets > 1
          ? `${where} · ${t('card.setOf', { n: String(now.set + 1), total: String(now.sets) })}`
          : where;
    stage.replaceChildren();
    stage.append(h('p', 'xquiz__q', q.question));
    const options = h('div', 'xquiz__options');
    options.setAttribute('role', 'group');
    q.options.forEach((option, i) => {
      const b = h('button', 'xquiz__opt');
      b.type = 'button';
      b.append(h('span', 'xquiz__key', String.fromCharCode(65 + i)), h('span', null, option));
      if (chosen != null) {
        b.disabled = true;
        if (i === q.answer) b.classList.add('is-right');
        else if (i === chosen) b.classList.add('is-wrong');
      }
      b.addEventListener('click', () => {
        chosen = i;
        plan.answer(i === q.answer);
        paint();
        // The pressed option is gone with the repaint; focus goes to the
        // verdict, which is read out, rather than falling to the top of the
        // page (ACC-012).
        /** @type {HTMLElement|null} */ (stage.querySelector('.xquiz__verdict'))?.focus();
      });
      options.append(b);
    });
    stage.append(options);
    if (chosen != null) {
      const right = chosen === q.answer;
      const verdict = h('p', `xquiz__verdict ${right ? 'is-right' : 'is-wrong'}`, right ? t('card.correct') : t('card.wrong', { answer: q.options[q.answer] }));
      verdict.tabIndex = -1;
      stage.append(verdict);
      if (q.explanation) stage.append(h('p', 'xquiz__why', q.explanation));
    }
    const { firstTryRight, asked } = plan.summary();
    score.textContent = asked ? t('card.score', { n: String(firstTryRight), total: String(asked) }) : '';
    next.disabled = chosen == null;
  };
  next.addEventListener('click', () => {
    if (chosen == null) return;
    plan.advance();
    chosen = null;
    paint();
    /** @type {HTMLElement|null} */ (stage.querySelector('button'))?.focus();
  });
  restart.addEventListener('click', () => begin(everyQuestion));
  body.append(progress, stage, nav);
  paint();
}

function flashcards(card, body) {
  let order = card.cards.map((_, i) => i);
  let at = 0;
  let flipped = false;
  const face = h('button', 'xflash');
  face.type = 'button';
  const count = h('div', 'xflash__count');
  count.setAttribute('role', 'status');
  const nav = h('div', 'xquiz__nav');
  const prev = h('button', 'xbtn', t('card.prev'));
  const shuffle = h('button', 'xbtn', t('card.shuffle'));
  const next = h('button', 'xbtn xbtn--primary', t('card.next'));
  for (const b of [prev, shuffle, next]) b.type = 'button';
  nav.append(prev, shuffle, next);

  const paint = () => {
    const c = card.cards[order[at]];
    face.classList.toggle('is-back', flipped);
    face.replaceChildren(h('span', 'xflash__side', flipped ? t('card.back') : t('card.front')), h('span', 'xflash__text', flipped ? c.back : c.front));
    face.setAttribute('aria-label', `${flipped ? c.back : c.front} — ${t('card.flip')}`);
    count.textContent = `${at + 1} / ${order.length}`;
    prev.disabled = at === 0;
    next.disabled = at === order.length - 1;
  };
  face.addEventListener('click', () => {
    flipped = !flipped;
    paint();
  });
  prev.addEventListener('click', () => {
    at -= 1;
    flipped = false;
    paint();
  });
  next.addEventListener('click', () => {
    at += 1;
    flipped = false;
    paint();
  });
  shuffle.addEventListener('click', () => {
    order = order.map((i) => [Math.random(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    at = 0;
    flipped = false;
    paint();
  });
  body.append(face, h('p', 'xflash__hint', t('card.flipHint')), count, nav);
  paint();
}

function translation(card, body) {
  const grid = h('div', 'xtrans');
  const side = (lang, text, primary) => {
    const box = h('div', `xtrans__side${primary ? ' is-target' : ''}`);
    box.append(h('div', 'xtrans__lang', lang || ''), h('p', 'xtrans__text', text));
    return box;
  };
  const target = side(card.to, card.translation, true);
  const copy = h('button', 'xbtn xtrans__copy', t('card.copy'));
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(card.translation);
      copy.textContent = t('card.copied');
      setTimeout(() => (copy.textContent = t('card.copy')), 1500);
    } catch {
      /* the text is still there to select */
    }
  });
  target.append(copy);
  if (card.pronunciation) target.append(h('p', 'xtrans__say', card.pronunciation));
  grid.append(side(card.from, card.source, false), target);
  body.append(grid);
  if (card.notes?.length) {
    body.append(heading(t('card.notes')));
    const ul = h('ul', 'xtips');
    for (const n of card.notes) ul.append(h('li', null, n));
    body.append(ul);
  }
}

function steps(card, body) {
  const ol = h('ol', 'xhowto');
  for (const s of card.steps) {
    const li = h('li', 'xhowto__step');
    li.append(h('div', 'xhowto__title', s.title));
    if (s.detail) li.append(h('div', 'xhowto__detail', s.detail));
    ol.append(li);
  }
  body.append(ol);
  if (card.note) body.append(h('p', 'xcard__verdict', card.note));
}

function crest(url) {
  const img = h('img', 'xscore__crest');
  img.alt = '';
  img.loading = 'lazy';
  if (url) img.src = viaApp(url);
  else img.hidden = true;
  img.addEventListener('error', () => (img.hidden = true));
  return img;
}

function scores(card, body) {
  if (card.table?.length) {
    const scroll = h('div', 'xcompare');
    const table = h('table', 'xtable');
    const head = h('tr');
    for (const label of ['#', t('card.team'), t('card.played'), t('card.won'), t('card.drawn'), t('card.lost'), t('card.gd'), t('card.pts')]) {
      head.append(h('th', null, label));
    }
    const thead = h('thead');
    thead.append(head);
    const tbody = h('tbody');
    for (const r of card.table) {
      const tr = h('tr');
      tr.append(h('td', 'xtable__rank', r.rank));
      const team = h('td', 'xtable__team');
      team.append(crest(r.badge), h('span', null, r.team));
      tr.append(team);
      for (const v of [r.played, r.won, r.drawn, r.lost, r.gd > 0 ? `+${r.gd}` : r.gd]) tr.append(h('td', null, v));
      tr.append(h('td', 'xtable__pts', r.points));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    scroll.append(table);
    body.append(scroll);
  }
  for (const section of card.sections || []) {
    if (!section.matches?.length) continue;
    const label = { last: t('card.results'), next: t('card.fixtures'), day: t('card.matches') }[section.heading] || '';
    if (label) body.append(heading(label));
    for (const m of section.matches) {
      const row = h('div', 'xscore');
      const home = h('div', 'xscore__side xscore__side--home');
      home.append(h('span', 'xscore__name', m.home), crest(m.homeBadge));
      const mid = h('div', 'xscore__mid');
      mid.append(h('span', 'xscore__result', m.homeScore == null ? (m.time || 'vs') : `${m.homeScore} – ${m.awayScore}`));
      mid.append(h('span', 'xscore__when', [m.date, m.homeScore == null ? '' : m.status].filter(Boolean).join(' · ')));
      const away = h('div', 'xscore__side');
      away.append(crest(m.awayBadge), h('span', 'xscore__name', m.away));
      row.append(home, mid, away);
      if (m.league || m.venue) row.append(h('div', 'xscore__meta', [m.league, m.venue].filter(Boolean).join(' · ')));
      body.append(row);
    }
  }
  body.append(h('p', 'xcard__source', 'TheSportsDB'));
}

const DRAW = { recipe, itinerary, comparison, quiz, flashcards, translation, steps, scores };

export function cardFigure(widget) {
  const card = widget?.card;
  const draw = card && DRAW[card.type];
  if (!draw) return null;
  const figure = shell(card.type, null);
  const head = h('div', 'xcard__head');
  if (card.badge) head.append(crest(card.badge));
  const titles = h('div');
  titles.append(h('div', 'xcard__title', card.title || t(`card.type.${card.type}`)));
  if (card.subtitle) titles.append(h('div', 'xcard__sub', card.subtitle));
  head.append(titles, h('span', 'xcard__kind', t(`card.type.${card.type}`)));
  const body = h('div', 'xcard__body');
  try {
    draw(card, body);
  } catch {
    return null;
  }
  figure.append(head, body);
  return figure;
}

/* ── connectors to connect ────────────────────────────────────────── */


/**
 * What one suggested connector's button says: Connect, Connected, or — for a
 * connection paused in the + menu — Turn on. Connected is not a button any
 * more, only the state.
 *
 * @param {HTMLButtonElement} button
 * @param {{ name?: string, connected?: boolean, paused?: boolean }} state
 */
export function paintConnectorButton(button, { name = '', connected = false, paused = false }) {
  const done = connected && !paused;
  button.classList.toggle('is-connected', done);
  button.disabled = done;
  button.textContent = t(done ? 'consug.connected' : paused ? 'consug.turnOn' : 'consug.connect');
  button.setAttribute('aria-label', t(done ? 'consug.connectedName' : paused ? 'consug.turnOnName' : 'consug.connectName', { name }));
}

/**
 * The connectors the assistant found for what is being asked, each with a
 * Connect button — Claude's connector search (owner, 2026-11-01).
 *
 * The row carries the kind and the id and nothing else: one listener on the
 * transcript opens the place in Settings where that one is connected (app.js),
 * and Settings closing asks where each stands, so the card says "Connected"
 * once it is — on a reload too. Icons come through this app's favicon route,
 * and a letter stands in when there is none.
 */
function connectorsFigure(widget) {
  const items = (Array.isArray(widget.items) ? widget.items : []).filter((item) => item?.id && item?.name).slice(0, 4);
  if (!items.length) return null;
  const figure = h('figure', 'widget consug');
  if (widget.title) figure.append(h('figcaption', 'consug__why', widget.title));
  const list = h('div', 'consug__list');
  for (const item of items) {
    const row = h('div', 'consug__row');
    row.dataset.connectorKind = item.kind === 'mcp' ? 'mcp' : 'service';
    row.dataset.connectorId = String(item.id);
    row.dataset.connectorName = String(item.name);
    const icon = h('span', 'consug__icon');
    const letter = () => {
      icon.replaceChildren(String(item.name).trim().charAt(0).toUpperCase());
      icon.classList.add('is-letter');
    };
    if (item.site) {
      const img = h('img');
      img.src = `/api/favicon/${encodeURIComponent(String(item.site))}`;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', letter, { once: true });
      icon.append(img);
    } else letter();
    const text = h('div', 'consug__text');
    text.append(h('p', 'consug__name', item.name));
    if (item.blurb) text.append(h('p', 'consug__blurb', item.blurb));
    const button = /** @type {HTMLButtonElement} */ (h('button', 'consug__connect'));
    button.type = 'button';
    paintConnectorButton(button, item);
    row.append(icon, text, button);
    list.append(row);
  }
  figure.append(list);
  return figure;
}

/* ── market data (server/finance) ──────────────────────────────── */

/** Where each source's own pages are, so its name in the footer is a way to it. */
const SOURCE_SITES = {
  'Yahoo Finance': 'https://finance.yahoo.com',
  VNDIRECT: 'https://www.vndirect.com.vn',
  KBS: 'https://www.kbsec.com.vn',
  Vietcap: 'https://www.vietcap.com.vn',
  'SEC EDGAR': 'https://www.sec.gov/edgar',
  CoinGecko: 'https://www.coingecko.com',
  SJC: 'https://sjc.com.vn',
  Vietcombank: 'https://www.vietcombank.com.vn',
  'World Bank': 'https://data.worldbank.org',
  FRED: 'https://fred.stlouisfed.org',
  ECB: 'https://data.ecb.europa.eu',
  Frankfurter: 'https://frankfurter.dev',
  'ExchangeRate-API': 'https://www.exchangerate-api.com',
  FMarket: 'https://fmarket.vn',
};

/** A price or figure in the app's language: no decimals for ₫ and volumes, two for the rest. */
function marketNumber(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const digits = unit === 'VND' || unit == null ? 0 : Math.abs(n) < 10 ? 4 : 2;
  const text = new Intl.NumberFormat(localeTag(), { maximumFractionDigits: digits }).format(n);
  if (unit === 'VND') return `${text} ₫`;
  if (unit === 'points') return `${text} ${t('market.points')}`;
  return unit ? `${text} ${unit}` : text;
}

/** "+1,20 %" with its sign, never colour alone. */
function marketChange(pct) {
  const n = Number(pct);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${new Intl.NumberFormat(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n))} %`;
}

/** When, in the exchange's own zone; the date alone for a daily figure. */
function marketWhen(iso, zone, dateOnly) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return String(iso || '');
  /** @type {Intl.DateTimeFormatOptions} */
  const options = dateOnly ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  try {
    return new Intl.DateTimeFormat(localeTag(), { ...options, ...(zone ? { timeZone: zone } : {}) }).format(date);
  } catch {
    return new Intl.DateTimeFormat(localeTag(), options).format(date);
  }
}

/** A line of the closes, 120 × 32, drawn by hand — no chart library for twenty points. */
function sparkline(series, up) {
  const points = (series || []).map((p) => Number(p?.c)).filter((c) => Number.isFinite(c));
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 32');
  svg.setAttribute('width', '120');
  svg.setAttribute('height', '32');
  svg.setAttribute('class', `xmarket__spark ${up ? 'is-up' : 'is-down'}`);
  svg.setAttribute('role', 'img');
  const first = series.find((p) => Number.isFinite(Number(p?.c)));
  const last = [...series].reverse().find((p) => Number.isFinite(Number(p?.c)));
  svg.setAttribute('aria-label', t('market.spark', { from: String(first?.t || '').slice(0, 10), to: String(last?.t || '').slice(0, 10) }));
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('points', points.map((c, i) => `${((i / (points.length - 1)) * 118 + 1).toFixed(1)},${(30 - ((c - min) / span) * 28).toFixed(1)}`).join(' '));
  svg.append(line);
  return svg;
}

/**
 * A market card: the numbers, a sparkline for a series, the session, and a
 * footer with the source, its credit and "for reference only" — so a source's
 * terms are met even when the model's sentence drops them. Every word is the
 * browser's (locales); the widget carries keys and numbers.
 */
export function marketFigure(widget) {
  const rows = Array.isArray(widget?.rows) ? widget.rows : [];
  if (!rows.length) return null;
  const figure = h('figure', 'widget xcard xcard--market');
  figure.setAttribute('aria-label', String(widget.title || t('market.kind')));
  const head = h('div', 'xcard__head');
  const titles = h('div');
  titles.append(h('div', 'xcard__title', widget.title || t('market.kind')));
  if (widget.adjusted !== undefined) titles.append(h('div', 'xcard__sub', t(widget.adjusted ? 'market.adjusted' : 'market.raw')));
  head.append(titles);
  const chip = widget.session && has(`market.session.${widget.session}`) ? t(`market.session.${widget.session}`) : has(`market.delay.${widget.delay}`) ? t(`market.delay.${widget.delay}`) : '';
  if (chip) head.append(h('span', `xcard__kind xmarket__session${widget.session ? ` is-${widget.session}` : ''}`, chip));
  const body = h('div', 'xcard__body');

  const change = widget.change && Number.isFinite(Number(widget.change.pct)) ? Number(widget.change.pct) : null;
  const labelOf = (row) => row.label || (row.key && has(`market.row.${row.key}`) ? t(`market.row.${row.key}`) : row.key || '');
  // One instrument: its first figure large, with its change. Several: a list, one row each.
  const main = rows[0];
  const single = !!main.key && !main.label;
  if (single) {
    const top = h('div', 'xmarket__top');
    const price = h('div', 'xmarket__price');
    if (main.key !== 'price') price.append(h('span', 'xmarket__what', labelOf(main)));
    price.append(h('span', 'xmarket__value', marketNumber(main.value, main.unit)));
    if (widget.perUnit === 'lượng') price.append(h('span', 'xmarket__per', t('market.perLuong')));
    if (change != null) {
      const moved = h('span', `xmarket__change ${change >= 0 ? 'is-up' : 'is-down'}`, `${change >= 0 ? '▲' : '▼'} ${marketChange(change)}${widget.change.window === '24h' ? ` (${t('market.window24h')})` : ''}`);
      moved.setAttribute('aria-label', `${t('market.change')} ${marketChange(change)}`);
      price.append(moved);
    }
    top.append(price);
    const spark = sparkline(widget.series, change == null ? true : change >= 0);
    if (spark) top.append(spark);
    body.append(top);
  }

  const list = h('dl', 'xmarket__rows');
  for (const row of rows.slice(single ? 1 : 0, 12)) {
    const label = labelOf(row);
    const item = h('div', 'xmarket__row');
    item.append(h('dt', null, label));
    const dd = h('dd', null, row.key === 'volume' ? marketNumber(row.value, null) : marketNumber(row.value, row.unit));
    if (row.sub != null && row.sub !== '') {
      const sub = typeof row.sub === 'number' ? marketChange(row.sub) : String(row.sub);
      dd.append(h('span', `xmarket__sub${typeof row.sub === 'number' ? (row.sub >= 0 ? ' is-up' : ' is-down') : ''}`, sub));
    }
    item.append(dd);
    list.append(item);
  }
  if (list.childElementCount) body.append(list);

  const foot = h('div', 'xmarket__foot');
  const source = h('p', 'xmarket__source');
  const site = SOURCE_SITES[String(widget.source || '')];
  const name = site ? link(site, widget.source, 'xmarket__link') : h('span', null, widget.source || '');
  source.append(document.createTextNode(`${t('market.source')} `), name);
  const when = marketWhen(widget.asOf, widget.zone, widget.dateOnly);
  const delay = has(`market.delay.${widget.delay}`) ? t(`market.delay.${widget.delay}`) : '';
  source.append(document.createTextNode([when, delay].filter(Boolean).map((s) => ` · ${s}`).join('')));
  foot.append(source);
  for (const credit of Array.isArray(widget.attribution) ? widget.attribution : []) {
    const line = h('p', 'xmarket__credit');
    const url = String(credit).match(/https?:\/\/\S+/)?.[0];
    if (url) {
      line.append(document.createTextNode(String(credit).slice(0, String(credit).indexOf(url))), link(url.replace(/[.,)]+$/, ''), url.replace(/^https?:\/\//, '').replace(/[.,)/]+$/, ''), 'xmarket__link'));
    } else if (/^Powered by CoinGecko$/.test(String(credit))) {
      line.append(link('https://www.coingecko.com', credit, 'xmarket__link'));
    } else line.textContent = String(credit);
    foot.append(line);
  }
  foot.append(h('p', 'xmarket__disclaimer', t('market.disclaimer')));
  body.append(foot);
  figure.append(head, body);
  return figure;
}

/** The right drawing for a widget of one of these kinds, or null. */
export function richWidget(widget) {
  if (widget?.kind === 'market') return marketFigure(widget);
  if (widget?.kind === 'map') return mapFigure(widget);
  if (widget?.kind === 'images') return galleryFigure(widget);
  if (widget?.kind === 'card') return cardFigure(widget);
  if (widget?.kind === 'connectors') return connectorsFigure(widget);
  return null;
}
