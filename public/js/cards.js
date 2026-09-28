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
import { t } from './i18n.js';

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

  const figure = shell('map', widget.title || t('card.map'));
  const stage = h('div', 'xmap');
  stage.setAttribute('role', 'img');
  stage.setAttribute('aria-label', points.map((p) => p.detail || p.label).join(' · '));
  const tiles = h('div', 'xmap__tiles');
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.setAttribute('class', 'xmap__overlay');
  stage.append(tiles, overlay);

  const all = [...points.map((p) => [Number(p.lat), Number(p.lon)]), ...line];
  let zoom = null;
  let size = { w: 0, h: 0 };

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
    points.forEach((pt, i) => {
      const p = project(Number(pt.lat), Number(pt.lon), zoom);
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'xmap__pin');
      g.setAttribute('transform', `translate(${(p.x - left).toFixed(1)},${(p.y - top).toFixed(1)})`);
      const pin = document.createElementNS(ns, 'path');
      pin.setAttribute('d', 'M0 0 C-2 -6 -9 -10 -9 -17 A9 9 0 1 1 9 -17 C9 -10 2 -6 0 0 Z');
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cy', '-17');
      dot.setAttribute('r', '3.5');
      g.append(pin, dot);
      if (points.length > 1) {
        const n = document.createElementNS(ns, 'text');
        n.setAttribute('y', '-13.5');
        n.setAttribute('text-anchor', 'middle');
        n.textContent = String.fromCharCode(65 + i);
        g.append(n);
      }
      const title = document.createElementNS(ns, 'title');
      title.textContent = pt.detail || pt.label || '';
      g.append(title);
      overlay.append(g);
    });
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
  const legend = h('div', 'xmap__places');
  points.forEach((pt, i) => {
    const row = h('div', 'xmap__place');
    if (points.length > 1) row.append(h('span', 'xmap__letter', String.fromCharCode(65 + i)));
    row.append(h('span', null, pt.label || pt.detail || ''));
    legend.append(row);
  });
  const first = points[0];
  const open = link(
    points.length > 1
      ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${points[0].lat}%2C${points[0].lon}%3B${points[1].lat}%2C${points[1].lon}`
      : `https://www.openstreetmap.org/?mlat=${first.lat}&mlon=${first.lon}#map=15/${first.lat}/${first.lon}`,
    t('card.openMap'),
    'xmap__open',
  );
  const credit = h('span', 'xmap__credit', '© OpenStreetMap');
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

function quiz(card, body) {
  const qs = card.questions;
  const answers = new Array(qs.length).fill(null);
  let at = 0;
  const progress = h('div', 'xquiz__progress');
  const stage = h('div', 'xquiz__stage');
  const nav = h('div', 'xquiz__nav');
  const prev = h('button', 'xbtn', t('card.prev'));
  const next = h('button', 'xbtn xbtn--primary', t('card.next'));
  prev.type = 'button';
  next.type = 'button';
  const score = h('div', 'xquiz__score');
  score.setAttribute('role', 'status');
  nav.append(prev, score, next);

  const paint = () => {
    const q = qs[at];
    progress.textContent = t('card.questionOf', { n: String(at + 1), total: String(qs.length) });
    stage.replaceChildren();
    stage.append(h('p', 'xquiz__q', q.question));
    const options = h('div', 'xquiz__options');
    options.setAttribute('role', 'group');
    q.options.forEach((option, i) => {
      const b = h('button', 'xquiz__opt');
      b.type = 'button';
      b.append(h('span', 'xquiz__key', String.fromCharCode(65 + i)), h('span', null, option));
      const chosen = answers[at];
      if (chosen != null) {
        b.disabled = true;
        if (i === q.answer) b.classList.add('is-right');
        else if (i === chosen) b.classList.add('is-wrong');
      }
      b.addEventListener('click', () => {
        answers[at] = i;
        paint();
      });
      options.append(b);
    });
    stage.append(options);
    if (answers[at] != null) {
      const right = answers[at] === q.answer;
      const verdict = h('p', `xquiz__verdict ${right ? 'is-right' : 'is-wrong'}`, right ? t('card.correct') : t('card.wrong', { answer: q.options[q.answer] }));
      stage.append(verdict);
      if (q.explanation) stage.append(h('p', 'xquiz__why', q.explanation));
    }
    const done = answers.filter((a) => a != null).length;
    const good = answers.filter((a, i) => a === qs[i].answer).length;
    score.textContent = done ? t('card.score', { n: String(good), total: String(done) }) : '';
    prev.disabled = at === 0;
    next.disabled = at === qs.length - 1;
  };
  prev.addEventListener('click', () => {
    at = Math.max(0, at - 1);
    paint();
  });
  next.addEventListener('click', () => {
    at = Math.min(qs.length - 1, at + 1);
    paint();
  });
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

/** The right drawing for a widget of one of these kinds, or null. */
export function richWidget(widget) {
  if (widget?.kind === 'map') return mapFigure(widget);
  if (widget?.kind === 'images') return galleryFigure(widget);
  if (widget?.kind === 'card') return cardFigure(widget);
  return null;
}
