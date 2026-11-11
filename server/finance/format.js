import { sourceLabel } from './http.js';
import { VN_LABEL } from './vn.js';
import { wallClock } from './clock.js';

/**
 * One answer shape for every kind (spec §6): a header line that carries the
 * facts a reader must not lose — source, as-of time in the exchange's zone,
 * delay, unit, adjusted or raw, and "for reference, not advice" — then a compact
 * table, then whatever credit the source's terms ask for. Tool results are re-sent
 * on every remaining step of a turn, so tables are CSV with plain numbers and a
 * history stops at 30 rows.
 *
 * The text is in Vietnamese for the Vietnamese market and English otherwise; the
 * model answers in the person's language either way. The card's words are the
 * browser's (public/js/locales), so `widget` carries keys and numbers, not prose.
 */

const W = {
  vi: {
    reference: 'tham chiếu', ceiling: 'trần', floor: 'sàn', source: 'nguồn', may: 'có thể trễ', dateOnly: 'theo ngày',
    points: 'điểm', adjusted: 'đã điều chỉnh (cổ tức, chia tách, phát hành)', raw: 'giá gốc, chưa điều chỉnh', volumesRaw: 'Khối lượng không điều chỉnh.',
    first: 'đầu kỳ', last: 'cuối kỳ', min: 'thấp nhất', max: 'cao nhất', change: 'thay đổi',
    more: (n) => `${n} dòng trước đó không hiện — hỏi khoảng ngắn hơn, hoặc vẽ biểu đồ.`,
    unavailable: 'tạm thời không lấy được dữ liệu', failed: 'không trả lời', answeredBy: 'trả lời bằng',
    upcom: 'tham chiếu UPCoM = giá bình quân phiên trước', band: 'trần/sàn tính theo biên độ', ato: 'giá 09:00–09:15 là giá dự kiến, chưa phải giá khớp',
    history: 'lịch sử giá', intraday: 'trong phiên', year: 'năm', quarter: 'quý', unit: 'đơn vị', period: 'kỳ',
    published: 'công bố', audited: 'đã kiểm toán', reviewed: 'đã soát xét', unaudited: 'chưa kiểm toán', consolidated: 'hợp nhất', parent: 'riêng/công ty mẹ',
    statement: { income: 'Kết quả kinh doanh', balance: 'Bảng cân đối kế toán', cashflow: 'Lưu chuyển tiền tệ' },
    template: { corporate: 'mẫu doanh nghiệp', bank: 'mẫu ngân hàng', securities: 'mẫu công ty chứng khoán', insurance: 'mẫu bảo hiểm' },
    ratios: 'chỉ số tài chính', profile: 'hồ sơ doanh nghiệp', events: 'sự kiện doanh nghiệp', news: 'tin tức', fund: 'quỹ mở', options: 'chứng quyền / phái sinh niêm yết',
    reference_rate: 'tỷ giá tham chiếu (trung bình), không phải giá ngân hàng', bankCash: 'mua tiền mặt', bankTransfer: 'mua chuyển khoản', bankSell: 'bán',
    gold: 'giá vàng', buy: 'mua', sell: 'bán', luong: '₫/lượng (37,5 g)', macro: 'chỉ tiêu vĩ mô', billion: 'tỷ ₫', exDate: 'GDKHQ', record: 'chốt', pay: 'thanh toán',
  },
  en: {
    reference: 'reference', ceiling: 'ceiling', floor: 'floor', source: 'source', may: 'may be delayed', dateOnly: 'by date',
    points: 'points', adjusted: 'adjusted (dividends, splits, issues)', raw: 'raw, not adjusted', volumesRaw: 'Volumes are not adjusted.',
    first: 'first', last: 'last', min: 'low', max: 'high', change: 'change',
    more: (n) => `${n} earlier rows not shown — ask for a shorter period, or a chart.`,
    unavailable: 'temporarily unavailable', failed: 'failed', answeredBy: 'answered by',
    upcom: "UPCoM's reference is yesterday's average price", band: 'ceiling/floor worked out from the band', ato: 'a price between 09:00 and 09:15 is an auction indication, not a trade',
    history: 'price history', intraday: 'intraday', year: 'year', quarter: 'quarter', unit: 'unit', period: 'period',
    published: 'published', audited: 'audited', reviewed: 'reviewed', unaudited: 'unaudited', consolidated: 'consolidated', parent: 'parent / stand-alone',
    statement: { income: 'Income statement', balance: 'Balance sheet', cashflow: 'Cash flow' },
    template: { corporate: 'corporate template', bank: 'bank template', securities: 'securities-firm template', insurance: 'insurer template' },
    ratios: 'ratios', profile: 'company profile', events: 'corporate actions', news: 'news', fund: 'fund', options: 'options',
    reference_rate: 'reference mid-rate, not a bank quote', bankCash: 'cash buying', bankTransfer: 'transfer buying', bankSell: 'selling',
    gold: 'gold', buy: 'buy', sell: 'sell', luong: '₫ per lượng (37.5 g)', macro: 'economic series', billion: 'billion ₫', exDate: 'ex-date', record: 'record', pay: 'paid',
  },
};

const SESSIONS = {
  vi: { pre: 'trước giờ mở cửa', ato: 'phiên mở cửa (ATO)', continuous: 'phiên liên tục', break: 'nghỉ trưa', atc: 'phiên đóng cửa (ATC)', plo: 'phiên sau giờ (PLO)', putthrough: 'giao dịch thỏa thuận', closed: 'đã đóng cửa' },
  en: { pre: 'before the open', ato: 'opening auction (ATO)', continuous: 'continuous session', break: 'lunch break', atc: 'closing auction (ATC)', plo: 'post-close (PLO)', putthrough: 'put-through', closed: 'closed' },
};

export const words = (lang) => W[lang] || W.en;
export const disclaimer = (lang) => (lang === 'vi' ? VN_LABEL.vi : VN_LABEL.en);
export const sessionWord = (lang, session) => (SESSIONS[lang] || SESSIONS.en)[session] || session;

/** A number for reading: Vietnamese or English separators, `digits` decimals at most. */
export function fmt(value, lang, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(value));
}

/** A change in percent with its sign: "+1,20 %" / "-0.20%". */
export function pct(value, lang) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  const v = Number(value);
  const n = new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${n}${lang === 'vi' ? ' %' : '%'}`;
}

/** Decimals a price needs: none for ₫, two for most else. */
const digitsFor = (unit) => (unit === 'VND' ? 0 : 2);
const unitWord = (unit, lang) => (unit === 'VND' ? '₫' : unit === 'points' ? words(lang).points : unit || '');

const ZONES = { 'Asia/Ho_Chi_Minh': 'ICT', 'Asia/Bangkok': 'ICT', 'America/New_York': 'ET', UTC: 'UTC' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "10/11 14:12 ICT" (vi) or "10 Nov 14:12 ET" (en), in the exchange's own zone; the date alone for a daily figure. */
export function asOfText(iso, zone = 'UTC', lang = 'en', { dateOnly = false } = {}) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const tz = zone || 'UTC';
  // Built from the wall clock, not Intl's date styles, which spell vi-VN's short date "10-11".
  const w = wallClock(date, tz);
  const two = (n) => String(n).padStart(2, '0');
  const day = lang === 'vi' ? `${two(w.d)}/${two(w.m)}` : `${w.d} ${MONTHS[w.m - 1]}`;
  if (dateOnly) return `${day}${lang === 'vi' ? '/' : ' '}${w.y}`;
  const name = ZONES[tz] || new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || tz;
  return `${day} ${two(w.h)}:${two(w.mi)} ${name}`;
}

/** The note after an answer's sources: who failed on the way, who answered. */
export function fallbackNote(failed, answeredBy, lang) {
  if (!failed?.length) return '';
  const w = words(lang);
  return `(${failed.map((f) => `${sourceLabel(f.source)} ${w.failed}: ${f.message}`).join('; ')} — ${w.answeredBy} ${sourceLabel(answeredBy)}.)`;
}

/** "FPT: temporarily unavailable — VNDIRECT: …; KBS: …" */
export function unavailable(label, failed, lang) {
  const w = words(lang);
  const why = (failed || []).map((f) => `${sourceLabel(f.source)}: ${f.message}`).join('; ');
  return `${label}: ${w.unavailable}${why ? ` — ${why}` : ' — no source is switched on for this.'}`;
}

/* ── quote ──────────────────────────────────────────────────────── */

/**
 * One header line per quote. On the Vietnamese market the change is against the
 * reference, never the previous close, and the session is the one the board is in
 * now.
 */
export function quoteLine(q, { lang, session }) {
  const w = words(lang);
  const unit = q.unit;
  const digits = digitsFor(unit);
  const change = q.reference ? ((q.price - q.reference) / q.reference) * 100 : q.changePct;
  const parts = [
    [q.symbol, q.board || q.exchange].filter(Boolean).join(' · '),
    `${fmt(q.price, lang, digits)} ${unitWord(unit, lang)}${change !== null && change !== undefined ? ` (${pct(change, lang)}${q.changeWindow === '24h' ? ' 24h' : ''})` : ''}`,
  ];
  if (q.also) parts.push(`${fmt(q.also.price, lang, q.also.currency === 'VND' ? 0 : 2)} ${unitWord(q.also.currency, lang)}`);
  if (q.reference) parts.push(`${w.reference} ${fmt(q.reference, lang, digits)}`);
  if (q.ceiling) parts.push(`${w.ceiling} ${fmt(q.ceiling, lang, digits)}`);
  if (q.floor) parts.push(`${w.floor} ${fmt(q.floor, lang, digits)}`);
  if (session) parts.push(sessionWord(lang, session));
  parts.push(asOfText(q.asOf, q.zone, lang, { dateOnly: q.dateOnly }));
  parts.push(q.delay === 'live' ? 'live' : w.may);
  parts.push(`${w.source} ${sourceLabel(q.source)}`);
  const notes = [];
  if (q.board === 'UPCOM' && q.reference) notes.push(w.upcom);
  if (q.bandComputed) notes.push(w.band);
  if (session === 'ato' && q.board === 'HOSE') notes.push(w.ato);
  return `${parts.filter(Boolean).join(' · ')}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/**
 * The card for one quote, or for several (one row each).
 *
 * @param {any[]} quotes
 * @param {{ lang: string, session?: string, attribution?: string[] }} options
 */
export function quoteWidget(quotes, { lang, session, attribution = [] }) {
  const q = quotes[0];
  const many = quotes.length > 1;
  const rows = many
    ? quotes.map((x) => ({ label: x.symbol, value: x.price, unit: x.unit, sub: x.reference ? ((x.price - x.reference) / x.reference) * 100 : x.changePct ?? null }))
    : [
        { key: 'price', value: q.price, unit: q.unit },
        ...(q.also ? [{ key: 'price', value: q.also.price, unit: q.also.currency }] : []),
        ...(q.reference ? [{ key: 'reference', value: q.reference, unit: q.unit }] : q.previousClose ? [{ key: 'previousClose', value: q.previousClose, unit: q.unit }] : []),
        ...(q.ceiling ? [{ key: 'ceiling', value: q.ceiling, unit: q.unit }] : []),
        ...(q.floor ? [{ key: 'floor', value: q.floor, unit: q.unit }] : []),
        ...(q.high !== undefined && q.high !== null ? [{ key: 'high', value: q.high, unit: q.unit }] : []),
        ...(q.low !== undefined && q.low !== null ? [{ key: 'low', value: q.low, unit: q.unit }] : []),
        ...(q.volume ? [{ key: 'volume', value: q.volume }] : []),
        ...(q.marketCap ? [{ key: 'marketCap', value: q.marketCap, unit: q.unit }] : []),
      ];
  const change = q.reference ? ((q.price - q.reference) / q.reference) * 100 : q.changePct;
  return {
    kind: 'market',
    view: 'quote',
    lang,
    title: many ? quotes.map((x) => x.symbol).join(' · ') : [q.symbol, q.board || q.exchange].filter(Boolean).join(' · '),
    rows,
    ...(!many && change !== null && change !== undefined ? { change: { pct: change, window: q.changeWindow || null } } : {}),
    ...(!many && Array.isArray(q.series) && q.series.length > 1 ? { series: q.series } : {}),
    ...(session ? { session } : {}),
    source: sourceLabel(q.source),
    attribution,
    asOf: q.asOf,
    zone: q.zone,
    ...(q.dateOnly ? { dateOnly: true } : {}),
    delay: q.delay || 'delayed',
    disclaimer: disclaimer(lang),
  };
}

/* ── history ────────────────────────────────────────────────────── */

const csvNum = (v, digits) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : String(Math.round(Number(v) * 10 ** digits) / 10 ** digits));

/** A summary line, then at most 30 rows (the newest), as CSV. */
export function historyText(h, { lang, label, failed, intraday = false }) {
  const w = words(lang);
  const digits = digitsFor(h.unit);
  const bars = h.bars;
  const first = bars[0];
  const last = bars.at(-1);
  const lo = bars.reduce((a, b) => (b.l ?? b.c) < (a.l ?? a.c) ? b : a, bars[0]);
  const hi = bars.reduce((a, b) => (b.h ?? b.c) > (a.h ?? a.c) ? b : a, bars[0]);
  const head = [
    label,
    `${intraday ? w.intraday : w.history} ${h.interval || '1d'}`,
    h.adjusted ? w.adjusted : w.raw,
    unitWord(h.unit, lang),
    `${first.t.slice(0, 16)} → ${last.t.slice(0, 16)}`,
    `${w.source} ${sourceLabel(h.source)}`,
    disclaimer(lang),
  ].join(' · ');
  const change = first.c ? ((last.c - first.c) / first.c) * 100 : null;
  const summary = `${w.first} ${fmt(first.c, lang, digits)} · ${w.last} ${fmt(last.c, lang, digits)} · ${w.min} ${fmt(lo.l ?? lo.c, lang, digits)} (${lo.t.slice(0, 10)}) · ${w.max} ${fmt(hi.h ?? hi.c, lang, digits)} (${hi.t.slice(0, 10)}) · ${w.change} ${pct(change, lang)}`;
  const shown = bars.slice(-30);
  const columns = lang === 'vi' ? 'ngày,mở,cao,thấp,đóng,KL' : 'date,open,high,low,close,volume';
  const lines = [head];
  if (h.adjusted) lines.push(w.volumesRaw);
  if (h.note) lines.push(h.note);
  if (failed?.length) lines.push(fallbackNote(failed, h.source, lang));
  lines.push(summary, columns, ...shown.map((b) => [b.t.slice(0, intraday ? 16 : 10), csvNum(b.o, digits), csvNum(b.h, digits), csvNum(b.l, digits), csvNum(b.c, digits), csvNum(b.v, 0)].join(',')));
  if (bars.length > shown.length) lines.push(w.more(bars.length - shown.length));
  return lines.join('\n');
}

export function historyWidget(h, { lang, label, attribution = [] }) {
  const first = h.bars[0];
  const last = h.bars.at(-1);
  const step = Math.max(1, Math.ceil(h.bars.length / 120));
  return {
    kind: 'market',
    view: 'history',
    lang,
    title: label,
    rows: [
      { key: 'last', value: last.c, unit: h.unit, sub: last.t.slice(0, 10) },
      { key: 'first', value: first.c, unit: h.unit, sub: first.t.slice(0, 10) },
      { key: 'high', value: Math.max(...h.bars.map((b) => b.h ?? b.c)), unit: h.unit },
      { key: 'low', value: Math.min(...h.bars.map((b) => b.l ?? b.c)), unit: h.unit },
    ],
    change: { pct: first.c ? ((last.c - first.c) / first.c) * 100 : null, window: null },
    series: h.bars.filter((_, i) => i % step === 0 || i === h.bars.length - 1).map((b) => ({ t: b.t, c: b.c })),
    adjusted: !!h.adjusted,
    source: sourceLabel(h.source),
    attribution,
    asOf: last.t,
    zone: h.zone,
    dateOnly: !/T/.test(last.t),
    delay: 'eod',
    disclaimer: disclaimer(lang),
  };
}

/* ── statements, ratios, profile, events, news ──────────────────── */

/** A big amount scaled to read: VND in billions, other currencies in millions. */
function scaleFor(unit, lang) {
  if (unit === 'VND') return { div: 1e9, label: words(lang).billion };
  return { div: 1e6, label: lang === 'vi' ? `triệu ${unit}` : `million ${unit}` };
}

export function statementText(s, { lang, failed }) {
  const w = words(lang);
  const scale = scaleFor(s.unit, lang);
  const meta = s.periods
    .map((p) => {
      const bits = [p.published ? `${w.published} ${p.published}` : '', p.audited ? w[p.audited] || p.audited : '', p.consolidated === true ? w.consolidated : p.consolidated === false ? w.parent : ''].filter(Boolean);
      return bits.length ? `${p.label}: ${bits.join(', ')}` : '';
    })
    .filter(Boolean);
  const lines = [
    [s.symbol, (w.statement[s.kind] || s.kind), s.period === 'quarter' ? w.quarter : w.year, `${w.unit}: ${scale.label}`, s.template ? w.template[s.template] || s.template : '', `${w.source} ${sourceLabel(s.source)}`, disclaimer(lang)].filter(Boolean).join(' · '),
  ];
  if (meta.length) lines.push(meta.join(' · '));
  if (s.note) lines.push(s.note);
  if (failed?.length) lines.push(fallbackNote(failed, s.source, lang));
  lines.push(`${w.period},${s.periods.map((p) => p.label.replace(/,/g, ' ')).join(',')}`);
  for (const l of s.lines.slice(0, 15)) {
    const name = String((lang === 'vi' ? l.label_vi : l.label_en) || l.label_en || l.code).replace(/,/g, ' ').trim();
    const perShare = l.unit && l.unit !== 'USD' && l.unit !== 'VND';
    const isEps = /EPS|per share|trên cổ phiếu/i.test(name) || perShare;
    lines.push(`${name}${perShare ? ` (${l.unit})` : ''},${l.values.map((v) => (v === null ? '' : isEps ? csvNum(v, 2) : csvNum(v / scale.div, 1))).join(',')}`);
  }
  return lines.join('\n');
}

export function ratiosText(r, { lang, failed }) {
  const w = words(lang);
  const lines = [[r.symbol, w.ratios, r.asOf, `${w.source} ${sourceLabel(r.source)}`, disclaimer(lang)].filter(Boolean).join(' · ')];
  if (r.note) lines.push(r.note);
  if (failed?.length) lines.push(fallbackNote(failed, r.source, lang));
  for (const i of r.items) {
    const name = lang === 'vi' ? i.label_vi : i.label_en;
    const value = i.kind === 'fraction' ? `${fmt(i.value * 100, lang, 2)}${lang === 'vi' ? ' %' : '%'}` : i.kind === 'money' ? (r.currency === 'VND' ? `${fmt(i.value / 1e9, lang, 0)} ${w.billion}` : `${fmt(i.value / 1e9, lang, 2)} bn ${r.currency || ''}`.trim()) : fmt(i.value, lang, 2);
    lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}

/** Any flat object as "key: value" lines, skipping the empty and the bookkeeping. */
export function profileText(p, { lang, failed, title }) {
  const w = words(lang);
  const skip = new Set(['source', 'attribution', 'symbol']);
  const lines = [[p.symbol || title, w.profile, `${w.source} ${sourceLabel(p.source)}`, disclaimer(lang)].filter(Boolean).join(' · ')];
  if (failed?.length) lines.push(fallbackNote(failed, p.source, lang));
  for (const [key, value] of Object.entries(p)) {
    if (skip.has(key) || value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    const shown = typeof value === 'number' ? (/Owned|Limit|freeFloat/.test(key) && value <= 1 ? `${fmt(value * 100, lang, 2)}${lang === 'vi' ? ' %' : '%'}` : fmt(value, lang, 2)) : Array.isArray(value) ? value.join(', ') : String(value);
    lines.push(`${key}: ${shown}`);
  }
  return lines.join('\n');
}

export function eventsText(list, { lang, failed, label, source }) {
  const w = words(lang);
  const lines = [[label, w.events, `${w.source} ${sourceLabel(source)}`, disclaimer(lang)].join(' · ')];
  if (failed?.length) lines.push(fallbackNote(failed, source, lang));
  for (const e of list.slice(0, 12)) {
    const title = (lang === 'vi' ? e.title_vi : e.title_en) || e.title_en || e.title_vi || e.code;
    const dates = [e.exDate ? `${w.exDate} ${e.exDate}` : '', e.recordDate ? `${w.record} ${e.recordDate}` : '', e.payDate ? `${w.pay} ${e.payDate}` : ''].filter(Boolean).join(' · ');
    lines.push(`${e.date} · ${e.code} · ${title}${dates ? ` · ${dates}` : ''}${e.url ? ` · ${e.url}` : ''}`);
  }
  return lines.join('\n');
}

export function newsText(list, { lang, failed, label, source }) {
  const w = words(lang);
  const lines = [[label, w.news, `${w.source} ${sourceLabel(source)}`, disclaimer(lang)].join(' · ')];
  if (failed?.length) lines.push(fallbackNote(failed, source, lang));
  for (const n of list.slice(0, 8)) lines.push(`${n.date ? `${n.date} · ` : ''}${n.title}${n.publisher ? ` — ${n.publisher}` : ''} · ${n.url}`);
  return lines.join('\n');
}

export function fundText(f, { lang, failed }) {
  const w = words(lang);
  const lines = [[f.code, f.name, w.fund, `${w.source} ${sourceLabel(f.source)}`, disclaimer(lang)].filter(Boolean).join(' · ')];
  if (failed?.length) lines.push(fallbackNote(failed, f.source, lang));
  if (f.nav !== undefined && f.nav !== null) lines.push(`NAV: ${fmt(f.nav, lang, 2)} ${unitWord(f.currency, lang)}${f.asOf ? ` (${f.asOf.slice(0, 10)})` : ''}`);
  for (const key of ['manager', 'type', 'category', 'family']) if (f[key]) lines.push(`${key}: ${f[key]}`);
  if (f.managementFee !== undefined && f.managementFee !== null) lines.push(`managementFee: ${fmt(f.managementFee, lang, 2)}${lang === 'vi' ? ' %' : '%'}`);
  if (f.returns?.length) lines.push(`returns: ${f.returns.map((r) => `${r.window} ${pct(r.pct, lang)}`).join(' · ')}`);
  if (f.holdings?.length) lines.push(`holdings: ${f.holdings.map((h) => `${h.code}${h.pct !== null && h.pct !== undefined ? ` ${fmt(h.pct, lang, 2)}%` : ''}`).join(', ')}`);
  return lines.join('\n');
}

export function optionsText(o, { lang, failed }) {
  const w = words(lang);
  const lines = [[o.symbol, w.options, o.expiry, o.price !== null && o.price !== undefined ? `${fmt(o.price, lang, 2)} ${o.currency}` : '', `${w.source} ${sourceLabel(o.source)}`, w.may, disclaimer(lang)].filter(Boolean).join(' · ')];
  if (failed?.length) lines.push(fallbackNote(failed, o.source, lang));
  if (o.expiries?.length) lines.push(`expiries: ${o.expiries.join(', ')}`);
  for (const [side, list] of [['calls', o.calls], ['puts', o.puts]]) {
    if (!list?.length) continue;
    lines.push(`${side}: strike,last,bid,ask,volume,openInterest,iv`);
    for (const c of list) lines.push([c.strike, c.last, c.bid, c.ask, c.volume, c.openInterest, c.iv === null ? '' : csvNum(c.iv, 3)].join(','));
  }
  return lines.join('\n');
}

/** Covered warrants or index futures listed on the Vietnamese market (codes only). */
export function listingText(list, { lang, failed, label }) {
  const w = words(lang);
  return [[label, w.options, `${w.source} Vietcap`, disclaimer(lang)].join(' · '), ...(failed?.length ? [fallbackNote(failed, 'vietcap', lang)] : []), list.slice(0, 60).join(', ') + (list.length > 60 ? ` … (+${list.length - 60})` : '')].join('\n');
}

/* ── fx, gold, macro, screen ────────────────────────────────────── */

export function fxText(result, { lang, failed }) {
  const w = words(lang);
  const rates = result.rates;
  const bank = rates.some((r) => /^bank/.test(r.kind));
  const lines = [];
  if (bank) {
    const base = rates[0].base;
    const by = (kind) => rates.find((r) => r.kind === kind)?.rate;
    lines.push(`${base}/VND · ${w.bankCash} ${fmt(by('bank-cash'), lang, 2)} · ${w.bankTransfer} ${fmt(by('bank-transfer'), lang, 2)} · ${w.bankSell} ${fmt(by('bank-sell'), lang, 2)} · ${rates[0].updated ? asOfText(rates[0].updated, 'Asia/Ho_Chi_Minh', lang) : rates[0].date} · ${w.source} ${sourceLabel(result.source)} · ${disclaimer(lang)}`);
  } else {
    for (const r of rates) lines.push(`${r.base}/${r.quote} · ${fmt(r.rate, lang, r.rate > 100 ? 2 : 6)} · ${w.reference_rate} · ${r.date} · ${w.source} ${sourceLabel(result.source)} · ${disclaimer(lang)}`);
  }
  if (failed?.length) lines.push(fallbackNote(failed, result.source, lang));
  return lines.join('\n');
}

export function fxWidget(result, { lang, attribution = [] }) {
  const rates = result.rates;
  const bank = rates.some((r) => /^bank/.test(r.kind));
  const KEYS = { 'bank-cash': 'buyCash', 'bank-transfer': 'buyTransfer', 'bank-sell': 'sell', reference: 'rate' };
  return {
    kind: 'market',
    view: 'fx',
    lang,
    title: bank ? `${rates[0].base}/VND` : rates.map((r) => `${r.base}/${r.quote}`).join(' · '),
    rows: rates.map((r) => (bank ? { key: KEYS[r.kind], value: r.rate, unit: 'VND' } : { label: `${r.base}/${r.quote}`, key: 'rate', value: r.rate, unit: r.quote })),
    source: sourceLabel(result.source),
    attribution,
    asOf: rates[0].updated || rates[0].date,
    zone: 'Asia/Ho_Chi_Minh',
    dateOnly: !rates[0].updated,
    delay: bank ? 'delayed' : 'eod',
    disclaimer: disclaimer(lang),
  };
}

export function goldText(rows, { lang, failed, source }) {
  const w = words(lang);
  if (source === 'sjc') {
    const lines = [[`SJC · ${w.gold}`, w.luong, asOfText(rows[0].asOf, 'Asia/Ho_Chi_Minh', lang), `${w.source} SJC`, disclaimer(lang)].join(' · ')];
    if (failed?.length) lines.push(fallbackNote(failed, 'sjc', lang));
    for (const r of rows.slice(0, 12)) lines.push(`${r.name}${r.branch ? ` · ${r.branch}` : ''} · ${w.buy} ${fmt(r.buy, lang, 0)} · ${w.sell} ${fmt(r.sell, lang, 0)}`);
    return lines.join('\n');
  }
  const lines = rows.map((q) => `${q.name} (${q.symbol}) · ${fmt(q.price, lang, 2)} ${q.unit} (${pct(q.changePct, lang)}) · ${asOfText(q.asOf, q.zone, lang)} · ${w.may} · ${w.source} ${sourceLabel(q.source)} · ${disclaimer(lang)}`);
  if (failed?.length) lines.push(fallbackNote(failed, 'yahoo', lang));
  return lines.join('\n');
}

export function goldWidget(rows, { lang, source, attribution = [] }) {
  if (source === 'sjc') {
    const main = rows[0];
    return {
      kind: 'market',
      view: 'gold',
      lang,
      title: main.name,
      rows: [
        { key: 'buy', value: main.buy, unit: 'VND', sub: main.branch },
        { key: 'sell', value: main.sell, unit: 'VND', sub: main.branch },
        ...rows.slice(1, 4).map((r) => ({ label: r.name, value: r.sell, unit: 'VND', sub: r.branch })),
      ],
      perUnit: 'lượng',
      source: 'SJC',
      attribution,
      asOf: main.asOf,
      zone: 'Asia/Ho_Chi_Minh',
      delay: 'delayed',
      disclaimer: disclaimer(lang),
    };
  }
  const q = rows[0];
  return { ...quoteWidget([q], { lang, attribution }), view: 'gold', title: q.name };
}

export function macroText(m, { lang, failed }) {
  const w = words(lang);
  const lines = [[m.country, m.indicator, m.unit ? `${w.unit}: ${m.unit}` : '', `${w.source} ${sourceLabel(m.source)}`, disclaimer(lang)].filter(Boolean).join(' · ')];
  if (failed?.length) lines.push(fallbackNote(failed, m.source, lang));
  lines.push(m.points.slice(0, 12).map((p) => `${p.date}: ${fmt(p.value, lang, 2)}`).join(' · '));
  return lines.join('\n');
}

export function screenText(s, { lang, failed }) {
  const w = words(lang);
  const lines = [[`US · ${s.label} (${s.tag})`, s.period, `${w.unit}: ${lang === 'vi' ? 'triệu USD' : 'million USD'}`, s.companies ? `${s.companies} filers` : '', `${w.source} SEC EDGAR`, disclaimer(lang)].filter(Boolean).join(' · ')];
  if (failed?.length) lines.push(fallbackNote(failed, 'sec', lang));
  s.rows.forEach((r, i) => lines.push(`${i + 1}. ${r.name} · ${fmt(r.value / 1e6, lang, 1)} · ${r.end}`));
  return lines.join('\n');
}

