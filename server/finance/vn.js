import { ICT, wallClock } from './clock.js';

/**
 * The Vietnamese market's rules, for labelling an answer correctly (research §5).
 *
 * Read the source's own published figures first — `basicPrice`, `ceilingPrice`,
 * `floorPrice` — and use these only where a source does not say: the exchange
 * rounds, and its rounding is the one that counts.
 *
 * Sessions as stated by DSC "as of September 2026", Monday to Friday,
 * Asia/Ho_Chi_Minh. Public holidays are not known here. Tick sizes for HNX and
 * UPCoM are the commonly cited 100 ₫, not checked against a current exchange
 * document.
 */

export const BOARDS = ['HOSE', 'HNX', 'UPCOM'];

/** The disclaimer every answer carries, in the result's language. */
export const VN_LABEL = { vi: 'chỉ để tham khảo, không phải khuyến nghị đầu tư', en: 'for reference only, not investment advice' };

/** 'HOSE' | 'HNX' | 'UPCOM' from however a source spells it, or null. */
export function normBoard(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'HOSE' || s === 'HSX' || s === 'HCM') return 'HOSE';
  if (s === 'HNX' || s === 'HASTC') return 'HNX';
  if (s === 'UPCOM' || s === 'UPCOM.') return 'UPCOM';
  return null;
}

/**
 * Minutes after midnight in Hanoi: [from, to, session]. Outside them, 'closed'.
 *
 * @type {Record<string, Array<[number, number, string]>>}
 */
const SCHEDULE = {
  HOSE: [[0, 540, 'pre'], [540, 555, 'ato'], [555, 690, 'continuous'], [690, 780, 'break'], [780, 870, 'continuous'], [870, 885, 'atc'], [885, 900, 'putthrough']],
  HNX: [[0, 540, 'pre'], [540, 690, 'continuous'], [690, 780, 'break'], [780, 870, 'continuous'], [870, 885, 'atc'], [885, 900, 'plo']],
  UPCOM: [[0, 540, 'pre'], [540, 690, 'continuous'], [690, 780, 'break'], [780, 900, 'continuous']],
};

/**
 * The session a board is in at an instant: 'pre' | 'ato' | 'continuous' | 'break'
 * | 'atc' | 'plo' | 'putthrough' | 'closed'. A price shown during HOSE's ATO
 * (09:00–09:15) is an indicative auction price, not a trade.
 */
export function sessionAt(board, date = new Date()) {
  const w = wallClock(date, ICT);
  if (w.weekday === 0 || w.weekday === 6) return 'closed';
  const minutes = w.h * 60 + w.mi;
  for (const [from, to, name] of SCHEDULE[normBoard(board) || 'HOSE']) if (minutes >= from && minutes < to) return name;
  return 'closed';
}

/** The trading sessions in which a quote moves. */
export const OPEN_SESSIONS = new Set(['ato', 'continuous', 'atc', 'plo', 'putthrough']);

/** Percent either side of the reference: normal, and on a first trading day (or back after ≥ 25 sessions). */
const BAND_PCT = { HOSE: [7, 20], HNX: [10, 30], UPCOM: [15, 40] };

/** The price band as a fraction: 0.07 | 0.10 | 0.15 (first day 0.20 / 0.30 / 0.40). */
export function band(board, { firstDay = false } = {}) {
  const [normal, first] = BAND_PCT[normBoard(board) || 'HOSE'];
  return (firstDay ? first : normal) / 100;
}

/** The tick (bước giá) at a price, in ₫. */
export function tick(board, price, { instrument = 'stock' } = {}) {
  const b = normBoard(board) || 'HOSE';
  if (b !== 'HOSE') return 100;
  if (instrument === 'etf' || instrument === 'cw') return 10;
  const p = Number(price);
  return p < 10_000 ? 10 : p < 50_000 ? 50 : 100;
}

/**
 * Ceiling and floor from a reference price: the ceiling rounded down to its tick,
 * the floor up to its own — each at the tick of the price it lands on. Whole
 * numbers throughout, so a limit that falls exactly on a tick is not pushed off
 * it by floating point.
 */
export function limits(board, reference, { firstDay = false, instrument = 'stock' } = {}) {
  const ref = Math.round(Number(reference));
  const pct = Math.round(band(board, { firstDay }) * 100);
  const up = ref * (100 + pct);
  const down = ref * (100 - pct);
  const upTick = tick(board, up / 100, { instrument });
  const downTick = tick(board, down / 100, { instrument });
  return { ceiling: Math.floor(up / (100 * upTick)) * upTick, floor: Math.ceil(down / (100 * downTick)) * downTick };
}

/** Change in percent, always against the reference — on UPCoM that is yesterday's average, not its close. */
export function changePct(price, reference) {
  const p = Number(price);
  const r = Number(reference);
  return r ? ((p - r) / r) * 100 : null;
}

/** The index names people use, as the brokers' codes (KBS, Vietcap). */
const INDICES = {
  VNINDEX: 'VNINDEX', 'VN-INDEX': 'VNINDEX', VN30: 'VN30', 'VN30INDEX': 'VN30', VN100: 'VN100',
  HNX: 'HNXIndex', HNXINDEX: 'HNXIndex', 'HNX-INDEX': 'HNXIndex', HNX30: 'HNX30',
  UPCOM: 'HNXUpcomIndex', UPCOMINDEX: 'HNXUpcomIndex', 'UPCOM-INDEX': 'HNXUpcomIndex', HNXUPCOMINDEX: 'HNXUpcomIndex',
  VNMIDCAP: 'VNMIDCAP', VNSMALLCAP: 'VNSMALLCAP', VNALLSHARE: 'VNALLSHARE', VNDIAMOND: 'VNDIAMOND',
};

/** A Vietnamese index's code, or null when the symbol is not one. */
export function vnIndexCode(symbol) {
  return INDICES[String(symbol || '').trim().toUpperCase()] || null;
}
