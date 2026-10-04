/**
 * Cards drawn in the conversation from structured data: a recipe, a trip, a
 * comparison, a quiz, flashcards, a translation, a how-to.
 *
 * `show_widget` can draw any of these, and does it differently every time,
 * however well the model manages that turn — the same problem `chart` solved
 * for numbers. Here the model supplies the content and the browser draws it
 * with one design, in the app's own theme, working in both languages and at
 * phone width. The quiz and the flashcards are also *interactive*, which a
 * picture in a sandboxed frame cannot be.
 *
 * The browser builds every card from text nodes (public/js/cards.js), never
 * from markup, so nothing here needs escaping — but everything is still cut to
 * size, because the card is stored with the conversation and re-read on every
 * load.
 */

import { asList, unwrapLists } from './validate.js';

export const CARD_TYPES = ['recipe', 'itinerary', 'comparison', 'quiz', 'flashcards', 'translation', 'steps'];

/** What a model calls each type when it does not use the name. */
const TYPE_ALIASES = {
  flashcard: 'flashcards',
  cards: 'flashcards',
  trip: 'itinerary',
  travel: 'itinerary',
  compare: 'comparison',
  table: 'comparison',
  howto: 'steps',
  how_to: 'steps',
  guide: 'steps',
  instructions: 'steps',
  test: 'quiz',
  mcq: 'quiz',
  multiple_choice: 'quiz',
  translate: 'translation',
};

const MAX_TEXT = 1200;
const MAX_LIST = 60;

/** The text of a value that may be a string, a number or `{ text: … }`. */
const textOf = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  for (const k of ['text', 'label', 'title', 'value', 'option', 'content', 'name', 'answer']) {
    if (typeof v[k] === 'string' || typeof v[k] === 'number') return String(v[k]);
  }
  return '';
};
const str = (v, max = MAX_TEXT) => textOf(v).replace(/\s+$/g, '').slice(0, max).trim();
/**
 * A list, in any of the shapes a list arrives in — see `asList` — or, for an
 * object keyed by letters (`{ A: "…", B: "…" }`), its values in order.
 */
const list = (v, max = MAX_LIST) => {
  const direct = asList(v);
  if (direct) return direct.slice(0, max);
  if (v && typeof v === 'object') return Object.values(v).slice(0, max);
  if (typeof v === 'string' && v.includes('\n')) return v.split('\n').map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')).filter((s) => s.trim()).slice(0, max);
  return [];
};
const strings = (v, max) => list(v, max).map((s) => str(s)).filter(Boolean);
/** The first field present under any of these names. */
const pick = (o, ...names) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  return undefined;
};

/** "A.", "(b)", "3)" at the start of an option — the label, not the answer. */
const LABEL = /^\s*(?:\(?([A-Fa-f])[.)]|\(?([1-6])[.)])\s+/;

/**
 * Which option is right, from however the model said it.
 *
 * The schema asks for an index from 0, and models also send the letter ("B"),
 * the option's own text, `"1"`, or a 1-based number with a lettered option
 * list. Each is unambiguous given the options; anything else is no answer.
 */
function answerIndex(raw, options) {
  if (raw === undefined || raw === null || raw === '') return -1;
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : -1;
  const s = String(textOf(raw)).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const letter = /^\(?([A-Fa-f])\)?[.):]?$/.exec(s) || /^(?:option|answer|đáp án)\s+([A-Fa-f])\b/i.exec(s);
  if (letter) return letter[1].toUpperCase().charCodeAt(0) - 65;
  const plain = (x) => x.replace(LABEL, '').trim().toLowerCase();
  const byText = options.findIndex((o) => plain(o) === plain(s));
  if (byText >= 0) return byText;
  const lead = LABEL.exec(s);
  if (lead?.[1]) return lead[1].toUpperCase().charCodeAt(0) - 65;
  return -1;
}

function need(ok, message) {
  if (!ok) throw new Error(message);
}

const SHAPES = {
  recipe(c) {
    const out = {
      servings: str(c.servings, 40),
      time: str(c.time, 60),
      ingredients: strings(c.ingredients),
      steps: strings(c.steps),
      tips: strings(c.tips, 12),
    };
    need(out.ingredients.length && out.steps.length, 'A recipe needs `ingredients` and `steps`, each a list of strings.');
    return out;
  },
  itinerary(c) {
    const days = list(c.days, 31)
      .map((d) => ({
        label: str(d?.label, 80),
        items: list(d?.items, 20)
          .map((it) => ({ time: str(it?.time, 30), title: str(it?.title, 160), detail: str(it?.detail, 400), place: str(it?.place, 160) }))
          .filter((it) => it.title),
      }))
      .filter((d) => d.label && d.items.length);
    need(days.length, 'An itinerary needs `days`: [{ label, items: [{ time, title, detail, place }] }].');
    return { days };
  },
  comparison(c) {
    const items = strings(c.items, 6);
    need(items.length >= 2, 'A comparison needs at least two `items` — the things compared.');
    const rows = list(c.rows, 30)
      .map((r) => ({ label: str(r?.label, 80), values: list(r?.values, items.length).map((v) => str(v, 300)) }))
      .filter((r) => r.label);
    need(rows.length, 'A comparison needs `rows`: [{ label, values: [one per item] }].');
    for (const r of rows) while (r.values.length < items.length) r.values.push('');
    const best = Number.isInteger(c.recommended) && c.recommended >= 0 && c.recommended < items.length ? c.recommended : null;
    return { items, rows, verdict: str(c.verdict, 600), recommended: best };
  },
  quiz(c) {
    const problems = [];
    const questions = list(pick(c, 'questions', 'items', 'quiz'), 50)
      .map((q, i) => {
        const options = strings(pick(q, 'options', 'choices', 'answers', 'alternatives'), 6);
        const answer = answerIndex(pick(q, 'answer', 'correct', 'correct_answer', 'correctAnswer', 'answer_index', 'correctIndex', 'correct_index', 'correct_option'), options);
        const out = { question: str(pick(q, 'question', 'q', 'prompt', 'text'), 600), options, answer, explanation: str(pick(q, 'explanation', 'why', 'reason', 'rationale'), 600) };
        if (!out.question) problems.push(`question ${i + 1} has no text`);
        else if (options.length < 2) problems.push(`question ${i + 1} has ${options.length} option(s), needs 2–6`);
        else if (!(answer >= 0 && answer < options.length)) problems.push(`question ${i + 1}'s answer is not an index from 0 to ${options.length - 1}`);
        return out;
      })
      .filter((q) => q.question && q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length);
    need(
      questions.length,
      'A quiz needs `questions`: [{ question, options: [2–6 strings], answer: index of the right option from 0, explanation }]' +
        (problems.length ? ` — ${problems.slice(0, 3).join('; ')}.` : '.'),
    );
    return { questions };
  },
  flashcards(c) {
    const cards = list(pick(c, 'cards', 'flashcards', 'items'), 100)
      .map((k) => ({ front: str(pick(k, 'front', 'term', 'question', 'word', 'q'), 400), back: str(pick(k, 'back', 'definition', 'answer', 'meaning', 'a'), 800) }))
      .filter((k) => k.front && k.back);
    need(cards.length, 'Flashcards need `cards`: [{ front, back }].');
    return { cards };
  },
  translation(c) {
    const out = {
      from: str(c.source_lang ?? c.from, 40),
      to: str(c.target_lang ?? c.to, 40),
      source: str(c.source, 4000),
      translation: str(c.translation, 4000),
      pronunciation: str(c.pronunciation, 800),
      notes: strings(c.notes, 10),
    };
    need(out.source && out.translation, 'A translation card needs `source` and `translation`.');
    return out;
  },
  steps(c) {
    const steps = list(c.steps, 40)
      .map((s) => (typeof s === 'string' ? { title: str(s, 300), detail: '' } : { title: str(s?.title, 300), detail: str(s?.detail, 1000) }))
      .filter((s) => s.title);
    need(steps.length, 'A how-to needs `steps`: [{ title, detail }] or a list of strings.');
    return { steps, note: str(c.note, 600) };
  },
};

/**
 * The card, checked and cut to size — or an error that says what to fix.
 * @param {string} type
 * @param {any} data  whatever the model sent; nothing about it is assumed
 */
export function buildCard(type, data = {}) {
  const wanted = String(type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const kind = CARD_TYPES.includes(wanted) ? wanted : TYPE_ALIASES[wanted];
  need(kind, `type is one of: ${CARD_TYPES.join(', ')}.`);
  /** @type {any} */
  let input = data;
  // The card sent as its own JSON text, which some models do for a nested object.
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = {};
    }
  }
  input = input && typeof input === 'object' && !Array.isArray(input) ? unwrapLists(input) : {};
  return { type: kind, title: str(input.title, 160), subtitle: str(input.subtitle, 240), ...SHAPES[kind](input) };
}

/** @param {{ type?: string, card?: object }} input */
export async function showCardTool(input) {
  // The card's fields put beside `type` instead of inside `card` are the same card.
  const { type: asked, card, ...rest } = input || {};
  const built = buildCard(String(asked || ''), card ?? rest);
  const type = built.type;
  const interactive = type === 'quiz' || type === 'flashcards';
  return {
    content:
      `Drew the ${type} card${built.title ? ` "${built.title}"` : ''} in the conversation.` +
      (interactive
        ? ' The user answers or flips it there — do not give the answers away in your reply.'
        : ' Do not repeat its contents; add only what the card does not say.'),
    widget: { kind: 'card', title: built.title || type, card: built },
  };
}
