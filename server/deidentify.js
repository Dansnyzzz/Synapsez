/**
 * Personal data kept from the model's provider, and given back on the way out (PRV-003).
 *
 * With `maskPersonal` on (Settings → Memory & privacy), everything this server
 * sends a provider — the system prompt, the conversation, tool results, the text
 * read out of files — has personal data swapped for stable placeholders before
 * it leaves: `<EMAIL_1>`, `<PHONE_1>`, `<ID_1>`, `<ACCOUNT_1>`, `<CARD_1>`,
 * `<PERSON_1>`. What comes back is restored before anyone sees it or any tool
 * runs: the reply as it streams, and every tool call's arguments. So an email
 * is still sent to the right address and the transcript reads as written, while
 * the provider holds only the placeholders.
 *
 * The map lives for one model call, in memory only — never logged, never stored.
 * It is rebuilt from the same transcript on the next step in the same order, so
 * the same value gets the same placeholder and the cached prefix stays the same.
 *
 * What it finds, said plainly because a privacy feature that overstates itself is
 * worse than none: email addresses; Vietnamese phone numbers; a 12-digit CCCD;
 * an ID, passport or bank-account number written after its label ("CMND:",
 * "số tài khoản"); card numbers that pass the Luhn check; and a person's name
 * written after "tên tôi là", "họ và tên", "my name is". A name in the middle of
 * a sentence with no label, an address, or anything identifying by context is
 * not caught — that needs a local language model this deployment does not have.
 * Off by default, so it is somebody's informed choice.
 */

const KINDS = ['EMAIL', 'PHONE', 'ID', 'ACCOUNT', 'CARD', 'PERSON'];

/** Every number in a card candidate, and whether they pass the Luhn check. */
function luhn(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * The detectors, in the order they claim text: an email before the digits in
 * it, a labelled number before the bare patterns that would take part of it.
 * Each `re` is global and Unicode-aware; `ok` filters a match further.
 */
const DETECTORS = [
  { kind: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu },
  {
    kind: 'ID',
    re: /(?<=(?:CMND|CCCD|CMT|căn cước(?: công dân)?|chứng minh(?: nhân dân| thư)?|hộ chiếu|passport|ID card)(?:\s+(?:số|no\.?|number))?\s*[:#.]?\s*)[A-Z]?\d{8,12}(?!\d)/giu,
  },
  {
    kind: 'ACCOUNT',
    re: /(?<=(?:STK|số tài khoản|tài khoản số|số TK|account (?:number|no\.?)|acct(?:\.|ount)? no\.?|IBAN)\s*[:#.]?\s*)\d[\d .-]{4,24}\d(?!\d)/giu,
  },
  { kind: 'CARD', re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu, ok: luhn },
  { kind: 'ID', re: /(?<![\d.])0\d{11}(?![\d.])/gu },
  { kind: 'PHONE', re: /(?<![\d+])(?:\+84|0084|0)[\s.-]?(?:3|5|7|8|9)\d(?:[\s.-]?\d){7}(?!\d)/gu },
  {
    kind: 'PERSON',
    // The label in either case by hand: with the `i` flag \p{Lu} would match a
    // lower-case letter too, and every word after "tôi là" would be a name.
    re: /(?<=(?:[Tt]ên (?:tôi|em|mình|anh|chị|của tôi|của em)? ?là|[Hh]ọ (?:và )?tên|[Hh]ọ tên|[Tt]ôi là|[Mm]y name is|[Ff]ull name)\s*[:]?\s*)\p{Lu}[\p{Ll}]+(?:\s+\p{Lu}[\p{Ll}]+){1,4}/gu,
  },
];

const TOKEN = new RegExp(`(?:<|&lt;)(${KINDS.join('|')})_(\\d+)(?:>|&gt;)`, 'g');

/** Fields that are never words: file bytes, ids, a provider's signed replay. */
const OPAQUE = new Set(['data', 'raw', 'id', 'toolCallId', 'mime', 'signature', 'thumb']);

/**
 * One call's shield: masks what goes out, restores what comes back.
 */
export function createShield() {
  /** value → placeholder, and back, for this call only. */
  const byValue = new Map();
  const byToken = new Map();
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));

  const tokenFor = (kind, value) => {
    const key = `${kind}:${value}`;
    let token = byValue.get(key);
    if (!token) {
      counts[kind] += 1;
      token = `<${kind}_${counts[kind]}>`;
      byValue.set(key, token);
      byToken.set(token, value);
    }
    return token;
  };

  /** A string with every detected value replaced. */
  const maskText = (text) => {
    if (typeof text !== 'string' || !text) return text;
    const hits = [];
    for (const detector of DETECTORS) {
      detector.re.lastIndex = 0;
      for (const m of text.matchAll(detector.re)) {
        const value = m[0];
        if (detector.ok && !detector.ok(value)) continue;
        const start = m.index;
        const end = start + value.length;
        // The first detector to claim a span keeps it.
        if (hits.some((h) => start < h.end && end > h.start)) continue;
        hits.push({ start, end, kind: detector.kind, value });
      }
    }
    if (!hits.length) return text;
    hits.sort((a, b) => a.start - b.start);
    let out = '';
    let at = 0;
    for (const hit of hits) {
      out += text.slice(at, hit.start) + tokenFor(hit.kind, hit.value);
      at = hit.end;
    }
    return out + text.slice(at);
  };

  /**
   * Any structure, every string in it masked; the original is never touched.
   * Not the bytes of a picture or a PDF (base64 — a run of digits in it is not
   * a phone number, and changing one breaks the file), not ids, and not `raw`:
   * a provider's own record of its last reply, replayed as it came — signed, in
   * Anthropic's case — and already holding the placeholders it was sent.
   */
  const maskDeep = (value, key = '') => {
    if (OPAQUE.has(key)) return value;
    if (typeof value === 'string') return maskText(value);
    if (Array.isArray(value)) return value.map((v) => maskDeep(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k);
      return out;
    }
    return value;
  };

  /** A string with every placeholder this call made given back its value. */
  const restoreText = (text) =>
    typeof text === 'string' ? text.replace(TOKEN, (whole, kind, n) => byToken.get(`<${kind}_${n}>`) ?? whole) : text;

  const restoreDeep = (value) => {
    if (typeof value === 'string') return restoreText(value);
    if (Array.isArray(value)) return value.map(restoreDeep);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = restoreDeep(v);
      return out;
    }
    return value;
  };

  /**
   * Restore a stream: a placeholder can arrive split across deltas ("<EMA",
   * "IL_1>"), so a tail that could still become one is held until it can't.
   */
  const restorer = () => {
    let held = '';
    return {
      push(delta) {
        const text = held + String(delta || '');
        const tail = /(?:<|&(?:l(?:t;?)?)?)[A-Z_]*\d*(?:&(?:g(?:t)?)?)?$/.exec(text);
        const cut = tail && tail[0].length < 24 ? tail.index : text.length;
        held = text.slice(cut);
        return restoreText(text.slice(0, cut));
      },
      flush() {
        const rest = held;
        held = '';
        return restoreText(rest);
      },
    };
  };

  /**
   * The request as the provider will see it. Fields that carry no words of the
   * person's (the model, the tools' schemas, numbers) pass as they are.
   */
  const protect = (opts) => ({
    ...opts,
    system: opts.system ? `${maskText(opts.system)}\n\n${NOTE}` : NOTE,
    messages: maskDeep(opts.messages || []),
  });

  return { protect, maskText, restoreText, restoreDeep, restorer, get size() { return byToken.size; } };
}

/** What the model is told when the shield is up. */
const NOTE =
  'Privacy: some values in this conversation are placeholders — <EMAIL_1>, <PHONE_1>, <ID_1>, <ACCOUNT_1>, <CARD_1>, <PERSON_1> and so on. ' +
  'Each stands for the person\'s real detail, which is put back before anything is shown or any tool runs. ' +
  'Where the value is needed, write the placeholder exactly as it appears; never guess or invent the real value.';

export const __testing = { DETECTORS, luhn, NOTE };
