/**
 * Small things every adapter needs: numbers that arrive as strings (KBS's latest
 * row, Vietcombank's rates), text that arrives as HTML (company summaries), and
 * the date spellings the sources each insist on.
 */

/** A finite number from a number or a numeric string ("1719.23", "1,000.00"); null for '', '-', null, NaN. */
export function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/,/g, '');
  if (!text || text === '-' || text === '.') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", sup2: '²', sup3: '³', deg: '°', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** HTML as plain text: tags gone, the common entities decoded, spaces collapsed, cut at a word near `max`. */
export function plainText(html, max = 400) {
  const text = String(html || '')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(Number(dec)))
    .replace(/&([a-z0-9]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

const safeChar = (code) => (Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ');

/** "YYYY-MM-DD" → "DD-MM-YYYY" (KBS). */
export const dmyDash = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
/** "YYYY-MM-DD" → "YYYYMMDD" (Vietcap). */
export const compact = (iso) => iso.slice(0, 10).replace(/-/g, '');
/** "YYYY-MM-DD" of a Date in UTC. */
export const isoDay = (date) => new Date(date).toISOString().slice(0, 10);
/** Unix seconds of "YYYY-MM-DD" at midnight UTC. */
export const unixDay = (iso) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 1000);

/** A finite number, or else throw — for the one figure an answer cannot do without. */
export function required(value, what, SourceErrorClass, source) {
  const n = num(value);
  if (n === null) throw new SourceErrorClass(source, `${what} was missing from the answer.`);
  return n;
}
