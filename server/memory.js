import { getStore } from './store/index.js';

/**
 * What the assistant remembers between conversations, and how it is read back.
 *
 * Notes live in `user_settings`: one JSON object per scope, keyed by note name.
 * `memory` is the account's set, read everywhere; `memory:<projectId>` is a
 * project's own set, read only by that project's conversations. The tools that
 * write them are in tools/cloud.js; this module is everything around them —
 * which set a conversation is talking about, the guard on what may be written,
 * and the block that puts the notes in front of the model at the start of a turn.
 *
 * That last part was missing entirely. The system prompt and every memory tool
 * promised that "a note you leave behind is read into every future
 * conversation", and nothing ever read one in: a new conversation started
 * knowing nothing unless the model happened to call `memory_read` first, which
 * it rarely did because it had been told it did not need to. Memory was a
 * write-only store.
 */

export const MEMORY_KEY = 'memory';
export const projectMemoryKey = (projectId) => `${MEMORY_KEY}:${projectId}`;

/**
 * Which set of notes this conversation is talking about.
 *
 * A project keeps its own notes; a conversation outside every project uses the
 * account's. The account's are underneath a project's, not replaced by them:
 * reads return both, the project's first, and a name in both is the project's —
 * the narrower context is the more specific instruction. Writes go to the
 * narrower of the two, because a project fact saved account-wide leaks into
 * unrelated work, while an account fact saved into a project is merely learned
 * again elsewhere. `scope: 'account'` overrides that for a genuinely general fact.
 */
export async function memoryScope({ userId, chatId, scope = null }) {
  const account = { key: MEMORY_KEY, projectId: null, where: 'this account' };
  if (scope === 'account' || !chatId) return account;

  const chat = await getStore().getChat(userId, chatId).catch(() => null);
  const projectId = chat?.project_id || null;
  if (!projectId) return account;

  const project = await getStore().getProject(userId, projectId).catch(() => null);
  return {
    key: projectMemoryKey(projectId),
    projectId,
    where: project?.name ? `the project "${project.name}"` : 'this project',
    projectName: project?.name || null,
  };
}

/** Both sets, with the narrower one winning a clash. */
export async function readBothScopes({ userId, chatId }) {
  const store = getStore();
  const here = await memoryScope({ userId, chatId });
  const account = (await store.getUserSetting(userId, MEMORY_KEY)) || {};
  if (!here.projectId) return { here, account, project: {}, merged: account };
  const project = (await store.getUserSetting(userId, here.key)) || {};
  return { here, account, project, merged: { ...account, ...project } };
}

/**
 * The name of a note, checked once for every memory tool and route.
 *
 * Memory is one JSON object keyed by note name. `__proto__` used as a key sets the
 * object's prototype instead of adding an entry — the note disappears on
 * serialisation while the tool reports it saved — and `constructor` and
 * `prototype` shadow the object's own machinery (CODE-023).
 */
export function noteName(key) {
  const name = String(key ?? '').trim().slice(0, 120);
  if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error(`"${key}" cannot be used as a note name. Pick a plain descriptive name.`);
  }
  return name;
}

/** The largest a single note may grow. A note is read into every conversation. */
export const MAX_NOTE_CHARS = 8_000;

/* ── what may never be remembered ──────────────────────────────────── */

/**
 * Lower case, accents off, đ as d — so "Chẩn đoán" and "chan doan" are one term.
 * Only for matching; nothing stored is ever folded.
 */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * A whole-word pattern, matched against lower-cased text with its accents on.
 *
 * `\b` is an ASCII notion and does not know where a Vietnamese word ends, so the
 * edges are written as "not a letter or digit" in Unicode terms instead.
 *
 * Accents stay on, deliberately, which is the opposite of what search wants.
 * Folded, "đồng tình" (agree) and "đồng tính" (homosexual) are the same string,
 * and so are "tiền sự" (a criminal record) and "tiền sử" (a medical history) —
 * a guard over folded text would refuse "the client agreed" as a note about
 * sexuality. The notes this guards are written by a model, in properly accented
 * Vietnamese, so nothing is lost by matching them as written.
 */
const words = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'u');
const lower = (text) => String(text ?? '').normalize('NFC').toLowerCase();

/** Luhn, for telling a card number from an order number that happens to be long. */
function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text) {
  for (const match of String(text).matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (/^(\d)\1+$/.test(digits)) continue;
    if (luhn(digits)) return true;
  }
  return false;
}

/** ISO 13616 mod-97, so a product code shaped like an IBAN is not mistaken for one. */
function hasIban(text) {
  for (const match of String(text).toUpperCase().matchAll(/(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Z0-9])/g)) {
    const iban = match[0].replace(/ /g, '');
    if (iban.length < 15 || iban.length > 34) continue;
    const moved = `${iban.slice(4)}${iban.slice(0, 4)}`;
    let rest = 0;
    for (const ch of moved) {
      const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
    }
    if (rest === 1) return true;
  }
  return false;
}

/**
 * Identifiers a note must never hold, whatever the user asks.
 *
 * The same line Claude draws: a government ID, a passport, a tax number, a bank
 * account or a card is a key to somebody's life rather than a fact about their
 * preferences, and a note is read into every future conversation and sent to a
 * model provider each time. Matched only beside the word that names it, so a
 * bare number — a phone, an invoice, a postcode — is not caught.
 */
/*
 * Words that are ordinary elsewhere are left out on purpose: "tin" is the
 * Vietnamese for news and messages, "swift" is a language, "mst" is a company's
 * tax code on every invoice. Each would refuse notes nobody meant to protect.
 */
const ID_CONTEXT = words([
  'cccd', 'cmnd', 'căn cước(?: công dân)?', 'chứng minh (?:nhân dân|thư)', 'số định danh(?: cá nhân)?', 'hộ chiếu',
  'passport(?: (?:no|number))?', 'ssn', 'social security(?: number)?', 'national id(?: number)?', 'id number',
  'mã số thuế cá nhân', 'tax (?:id|number|file number)', 'giấy phép lái xe', 'bằng lái(?: xe)?', 'gplx',
  'drivers? licen[cs]e(?: number)?', 'số bhxh', 'số bảo hiểm xã hội', 'medicare number', 'nhs number',
]);
const BANK_CONTEXT = words([
  'số tài khoản', 'stk', 'tài khoản ngân hàng', 'account (?:number|no)', 'acct(?: no)?', 'bank account',
  'routing number', 'sort code', 'iban', 'swift code', 'bic code', 'số thẻ', 'card number', 'cvv', 'cvc', 'mã pin', 'pin code',
]);
const NUMBER_AFTER = /^[^\d\n]{0,24}[a-z]?\d[\d .-]{4,}\d/;

function hasLabelledNumber(text, context) {
  const plain = lower(text);
  const re = new RegExp(context.source, 'gu');
  for (const match of plain.matchAll(re)) {
    if (NUMBER_AFTER.test(plain.slice(match.index + match[0].length))) return true;
  }
  return false;
}

const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;

const CRIMINAL = words([
  'tiền án', 'tiền sự', 'án tích', 'từng (?:bị )?(?:đi tù|ngồi tù|kết án)', 'bị kết án', 'criminal record',
  'convicted', 'prison sentence', 'arrest record', 'served time', 'felony',
]);
const IMMIGRATION = words([
  'immigration status', 'visa status', 'undocumented', 'illegal immigrant', 'asylum seeker', 'refugee status',
  'green card status', 'overstayed', 'tình trạng (?:cư trú|nhập cư|thị thực|visa)', 'cư trú bất hợp pháp',
  'nhập cư (?:trái phép|bất hợp pháp)', 'xin tị nạn', 'tị nạn', 'quá hạn visa', 'quá hạn thị thực',
]);

/**
 * Topics that are not stored unless the account has switched them on.
 *
 * Health, beliefs, politics, ethnicity and sexuality are where a remembered
 * detail does the most harm if it surfaces in the wrong place — a work email, a
 * shared screen, a project somebody else can see. Off by default, as Claude has
 * it; Settings → Memory turns them on for somebody who wants the assistant to
 * remember, say, their medication schedule.
 *
 * Phrases rather than single words wherever a word alone is ordinary — "race
 * condition", "std::vector", "the button is disabled", "the Great Depression",
 * "Christian from marketing", "the team voted for option B". Each of those was a
 * candidate here and each would have refused a note about work. Missing an
 * oblique mention is the cheaper error: the prompt and the tool description
 * carry the same rule, and this is the net under them.
 */
const SENSITIVE = [
  {
    topic: 'health',
    re: words([
      'diagnos(?:ed|is|es)', 'medical (?:condition|history|record)', 'chronic (?:illness|pain|disease)', 'clinical depression',
      'depressed', 'anxiety disorder', 'panic attacks?', 'bipolar(?: disorder)?', 'schizophreni\\p{L}*', 'adhd', 'autis(?:m|tic)',
      'cancer', 'tumou?r', 'diabet(?:es|ic)', 'hiv', 'pregnan(?:t|cy)', 'miscarriage', 'abortion',
      'medication', 'prescri(?:bed|ption)', 'antidepressants?', 'therapist', 'psychotherapy', 'mental (?:health|illness)',
      'eating disorder', 'addiction', 'chẩn đoán', 'bệnh (?:lý|án|nền|tim|tiểu đường|ung thư|trầm cảm|mãn tính|tâm thần)',
      'ung thư', 'tiểu đường', 'trầm cảm', 'rối loạn (?:lo âu|lưỡng cực|ăn uống)', 'tự kỷ', 'mang thai', 'có thai',
      'sảy thai', 'phá thai', 'uống thuốc', 'đơn thuốc', 'thuốc chống trầm cảm', 'sức kh(?:ỏ|o)e tâm thần', 'tiền sử bệnh',
      'nghiện (?:rượu|ma túy|ma tuý)', 'cai nghiện', 'trị liệu tâm lý',
    ]),
  },
  {
    topic: 'religion',
    re: words([
      'religio(?:n|us)', 'christianity', 'catholic', 'protestant', 'muslim', 'islam(?:ic)?', 'buddhis(?:m|t)', 'hindu(?:ism)?',
      'jewish', 'judaism', 'atheis(?:m|t)', 'agnostic', 'tôn giáo', 'theo đạo', 'công giáo', 'phật giáo', 'đạo phật',
      'đạo thiên chúa', 'đạo tin lành', 'hồi giáo', 'cao đài', 'ho(?:à|ò)a hảo', 'vô thần',
    ]),
  },
  {
    topic: 'politics',
    re: words([
      'political (?:view|views|belief|beliefs|party|affiliation|opinion|opinions|leaning)', 'party member',
      'communist party', 'democratic party', 'republican party', 'trade union member',
      'quan điểm chính trị', 'đảng viên', 'đảng phái', 'ủng hộ đảng', 'chính kiến', 'xu hướng chính trị',
    ]),
  },
  {
    topic: 'ethnicity',
    re: words([
      'ethnicity', 'ethnic (?:origin|background|group|minority)', 'racial', 'sắc tộc', 'chủng tộc', 'người dân tộc',
      'dân tộc (?:thiểu số|kinh|hoa|tày|thái|khmer|mường|h\'?mông|nùng|chăm)',
    ]),
  },
  {
    topic: 'sexuality',
    re: words([
      // "gay gắt" is harsh and "gay go" is difficult — ordinary Vietnamese.
      'sexual orientation', 'gay(?! gắt| go| cấn)', 'lesbian', 'bisexual', 'pansexual', 'asexual', 'transgender', 'trans (?:man|woman)',
      'non-?binary', 'lgbt\\p{L}*', 'queer', 'sex life', 'gender identity', 'đồng tính', 'song tính', 'chuyển giới',
      'xu hướng tính dục', 'bản dạng giới',
    ]),
  },
];

/** Topic names as the interface and the tool results say them. */
export const SENSITIVE_TOPICS = SENSITIVE.map((s) => s.topic);

/**
 * Why this text may not be saved as a note, or null when it may.
 *
 * Two tiers, as Claude has them. Identifiers are refused always, even when the
 * user asks — "remember my passport number" is exactly the request that must not
 * be honoured, because the note outlives the moment and travels to a provider on
 * every turn. Sensitive topics are refused unless the account has switched them
 * on. The model is told which it was and what to say, so the refusal reaches the
 * person rather than being quietly worked around.
 *
 * A filter over words, not an understanding of them: it misses what is said
 * obliquely, and it will occasionally stop a harmless note that names a topic in
 * passing. Both are acceptable here — the first is what the tool description and
 * the prompt also forbid, and the second costs one rephrased note.
 *
 * @returns {{ kind: 'identifier'|'sensitive', what: string } | null}
 */
export function memoryRefusal(text, { allowSensitive = false } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  if (hasCardNumber(raw)) return { kind: 'identifier', what: 'a payment card number' };
  if (hasIban(raw)) return { kind: 'identifier', what: 'a bank account number (IBAN)' };
  if (SSN.test(raw)) return { kind: 'identifier', what: 'a social security number' };
  if (hasLabelledNumber(raw, ID_CONTEXT)) return { kind: 'identifier', what: 'an identity document number' };
  if (hasLabelledNumber(raw, BANK_CONTEXT)) return { kind: 'identifier', what: 'a bank or card number' };

  const plain = lower(raw);
  if (CRIMINAL.test(plain)) return { kind: 'identifier', what: 'a criminal record' };
  if (IMMIGRATION.test(plain)) return { kind: 'identifier', what: 'immigration status' };

  if (!allowSensitive) {
    for (const { topic, re } of SENSITIVE) if (re.test(plain)) return { kind: 'sensitive', what: topic };
  }
  return null;
}

/** The tool result for a refused note — said so the model tells the person. */
export function refusalMessage(refusal) {
  if (refusal.kind === 'identifier') {
    return (
      `Not saved: the note contains ${refusal.what}. Notes never hold identity, passport, tax, bank or card numbers, ` +
      'criminal records or immigration status — not even when the user asks, because a note is read into every future ' +
      'conversation. Save the useful part without that detail if there is one, and tell the user plainly what was left out and why.'
    );
  }
  return (
    `Not saved: the note is about ${refusal.what}, a sensitive topic, and remembering sensitive topics is switched off ` +
    'for this account. Tell the user that, and that they can switch it on in Settings → Memory. Do not save it another way.'
  );
}

/* ── reading the notes back into a turn ────────────────────────────── */

/**
 * How much of the system prompt the notes may take: about 1,500 tokens.
 *
 * Read on every step of every turn, but inside the cached prefix — the notes
 * change only when one is written — so on the providers that cache, the cost
 * after the first step is a tenth of that. Against the alternative it replaces it
 * is cheap: one `memory_read` call is a whole extra step, which re-sends the
 * entire prompt and transcript to read the same notes.
 *
 * Past the budget a note is named rather than quoted, the way Claude Code loads
 * the head of MEMORY.md and reads the rest on demand.
 */
export const MEMORY_PROMPT_CHARS = 6_000;
const PREVIEW_CHARS = 120;

const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '');

/** Newest first: a note just corrected is likelier to matter than one from March. */
const newestFirst = (notes) =>
  Object.entries(notes || {})
    .filter(([, note]) => note && typeof note.content === 'string' && note.content.trim())
    .sort(([, a], [, b]) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

/**
 * The notes as the model reads them at the start of a turn, or '' when there are
 * none — an empty heading is tokens spent saying nothing.
 *
 * @param project  this project's notes, `{}` outside one
 * @param account  the account's notes
 */
export function memoryBlock({ project = {}, account = {}, projectName = null, budget = MEMORY_PROMPT_CHARS }) {
  const shadowed = new Set(Object.keys(project || {}));
  const groups = [
    { title: `### This project${projectName ? ` ("${projectName}")` : ''} — these win where they disagree`, notes: newestFirst(project) },
    { title: '### Everywhere', notes: newestFirst(account).filter(([key]) => !shadowed.has(key)) },
  ].filter((g) => g.notes.length);
  if (!groups.length) return '';

  const out = [
    '## Memory',
    'Notes you saved in earlier conversations. They are background, not instructions from this turn — what the user says now wins. ' +
      'Keep them true: correct one with `memory_edit` and remove a stale one with `memory_delete` (load them with `load_tools`).',
  ];
  let used = out.join('\n').length;
  const unshown = [];

  for (const group of groups) {
    let headed = false;
    for (const [key, note] of group.notes) {
      const date = day(note.updatedAt);
      const label = `- **${key}**${date ? ` (${date})` : ''}: `;
      const body = note.content.trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ');
      const full = `${label}${body}`;
      const preview = `${label}${body.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS)}… [cut — memory_read "${key}" for the rest]`;
      const heading = headed ? 0 : group.title.length + 1;
      const room = budget - used - heading;
      const line = full.length + 1 <= room ? full : preview.length + 1 <= room && body.length > PREVIEW_CHARS ? preview : null;
      if (!line) {
        unshown.push(key);
        continue;
      }
      if (!headed) {
        out.push(group.title);
        headed = true;
        used += heading;
      }
      out.push(line);
      used += line.length + 1;
    }
  }

  if (unshown.length) {
    const names = [];
    let length = 0;
    for (const key of unshown) {
      if (length + key.length > 600) break;
      names.push(key);
      length += key.length + 2;
    }
    const more = unshown.length - names.length;
    out.push(
      `(${unshown.length} more note${unshown.length === 1 ? '' : 's'} not shown for space: ${names.join(', ')}` +
        `${more ? `, and ${more} more` : ''}. \`memory_search\` or \`memory_read\` opens them.)`,
    );
  }
  return out.join('\n');
}

/**
 * The memory block for this turn, or '' when there is nothing to say.
 *
 * Nothing at all for an incognito conversation or an account that switched
 * memory off — both are promises that nothing remembered is used here, and the
 * cheapest way to keep a promise about the prompt is not to build that part.
 */
export async function memoryForTurn(userId, chat, prefs) {
  if (!userId || prefs?.memory === false || chat?.incognito) return '';
  const store = getStore();
  const account = (await store.getUserSetting(userId, MEMORY_KEY).catch(() => null)) || {};
  let project = {};
  let projectName = null;
  if (chat?.project_id) {
    project = (await store.getUserSetting(userId, projectMemoryKey(chat.project_id)).catch(() => null)) || {};
    projectName = (await store.getProject(userId, chat.project_id).catch(() => null))?.name || null;
  }
  return memoryBlock({ project, account, projectName });
}

/** Every tool that reads or writes notes. */
export const MEMORY_TOOLS = ['memory_write', 'memory_append', 'memory_edit', 'memory_delete', 'memory_read', 'memory_search'];

/**
 * Tools this conversation must not be offered, given where it is and what the
 * account chose — one answer for the main loop and the sub-agents alike.
 *
 * Incognito takes away everything that remembers: notes, chat search, and
 * `skill_write`, which would otherwise file a procedure learned in a
 * conversation that promised to leave nothing behind.
 *
 * @param {{ chat?: any, prefs?: any }} [options]
 */
export function withheldTools({ chat = null, prefs = {} } = {}) {
  const out = new Set();
  const incognito = !!chat?.incognito;
  if (incognito || prefs.memory === false) for (const name of MEMORY_TOOLS) out.add(name);
  if (incognito || prefs.chatSearch === false) out.add('search_chats');
  if (incognito) out.add('skill_write');
  return out;
}

/* ── searching them ────────────────────────────────────────────────── */

const termsOf = (text) => [...new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];

/**
 * Notes ranked against a question — by name first, then by what they say.
 *
 * Crude on purpose: notes are few and short, and the words somebody uses to ask
 * about one are nearly always words in it. Folded, so "lich hop" finds "lịch họp".
 *
 * @param notes  `[{ key, scope, content, updatedAt }]`
 */
export function rankNotes(notes, query, limit = 8) {
  const wanted = termsOf(query);
  const phrase = fold(query).trim();
  return (notes || [])
    .map((note) => {
      const name = fold(note.key);
      const body = fold(note.content);
      let score = 0;
      for (const term of wanted) {
        if (name.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      if (phrase.length > 3 && body.includes(phrase)) score += 4;
      return { ...note, score };
    })
    .filter((note) => note.score > 0)
    .sort((a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, Math.min(Math.max(Number(limit) || 8, 1), 20));
}
