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

export const CARD_TYPES = ['recipe', 'itinerary', 'comparison', 'quiz', 'flashcards', 'translation', 'steps'];

const MAX_TEXT = 1200;
const MAX_LIST = 60;

const str = (v, max = MAX_TEXT) => String(v ?? '').replace(/\s+$/g, '').slice(0, max).trim();
const list = (v, max = MAX_LIST) => (Array.isArray(v) ? v.slice(0, max) : []);
const strings = (v, max) => list(v, max).map((s) => str(s)).filter(Boolean);

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
    const questions = list(c.questions, 50)
      .map((q) => {
        const options = strings(q?.options, 6);
        const answer = Number(q?.answer);
        return { question: str(q?.question, 600), options, answer, explanation: str(q?.explanation, 600) };
      })
      .filter((q) => q.question && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
    need(questions.length, 'A quiz needs `questions`: [{ question, options: [2–6], answer: index of the right option from 0, explanation }].');
    return { questions };
  },
  flashcards(c) {
    const cards = list(c.cards, 100)
      .map((k) => ({ front: str(k?.front, 400), back: str(k?.back, 800) }))
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
  need(CARD_TYPES.includes(type), `type is one of: ${CARD_TYPES.join(', ')}.`);
  /** @type {any} */
  const input = data && typeof data === 'object' ? data : {};
  return { type, title: str(input.title, 160), subtitle: str(input.subtitle, 240), ...SHAPES[type](input) };
}

/** @param {{ type?: string, card?: object }} input */
export async function showCardTool({ type, card }) {
  const built = buildCard(String(type || ''), card);
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
