import { asList } from './validate.js';
/**
 * A question with buttons on it.
 *
 * The assistant could always ask something — write the question in prose and
 * end the turn — but then the person has to read it, work out what shape of
 * answer is wanted, and type it. So in practice it did the other thing: it
 * guessed. Both outcomes are worse than a short list you can press.
 *
 * This file is the part with no network and no DOM in it: what a well-formed
 * question is, and what the answer reads like when it goes back to the model.
 * Both are pure, because both are where this can quietly go wrong — a question
 * with one option is not a question, and an answer the model misreads is worse
 * than no answer at all.
 */

/** More than this in one card and nobody reads to the end. A form may run longer. */
const MAX_QUESTIONS = 6;
/** Fields typed into rather than chosen from. */
const TEXT_KINDS = new Set(['text', 'email']);
/** One option is not a choice; past eight it is a form. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const MAX_LABEL = 120;
const MAX_QUESTION = 300;

const text = (value, cap) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

/**
 * One option, however the model wrote it.
 *
 * A bare string and `{ label, description }` are both natural things for a
 * model to produce, and refusing one of them would mean the tool fails on
 * output that was perfectly clear about what it meant.
 */
function option(raw) {
  if (typeof raw === 'string') return { label: text(raw, MAX_LABEL) };
  const label = text(raw?.label ?? raw?.text ?? raw?.value, MAX_LABEL);
  const description = text(raw?.description ?? raw?.detail ?? '', MAX_LABEL * 2);
  return description ? { label, description } : { label };
}

/**
 * The questions, cleaned, or an error saying what was wrong with them.
 *
 * Throws rather than silently repairing: a card built from a malformed call is
 * shown to a person, and quietly dropping half of it produces a question that
 * reads as complete and is not. The message is written for the model, because
 * the model is what reads a tool error and tries again.
 */
export function normaliseQuestions(input) {
  const raw = asList(input?.questions)
    ? asList(input.questions)
    : // One question passed at the top level, which is what a model writes when
      // it only has one to ask.
      input?.question
      ? [input]
      : [];

  const questions = [];
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    const question = text(entry?.question ?? entry?.title, MAX_QUESTION);
    if (!question) continue;

    /**
     * A field to type into rather than choose from — an email address, a
     * name, a time. What makes a setup form possible: "which frequency" is a
     * choice, "which address" never can be.
     */
    const kind = TEXT_KINDS.has(entry?.kind) ? entry.kind : 'choice';
    if (kind !== 'choice') {
      questions.push({
        question,
        kind,
        options: [],
        multiple: false,
        other: true,
        otherLabel: text(entry?.placeholder ?? entry?.other_label ?? '', MAX_LABEL),
        hint: text(entry?.hint ?? '', MAX_LABEL * 2),
        required: !!entry?.required,
      });
      continue;
    }

    const options = [];
    const seen = new Set();
    // Read in every shape a list arrives in, the same as the argument check — see asList.
    for (const candidate of asList(entry?.options) || []) {
      const cleaned = option(candidate);
      // A duplicate label is two buttons that do the same thing, and the answer
      // would not say which was pressed.
      if (!cleaned.label || seen.has(cleaned.label.toLowerCase())) continue;
      seen.add(cleaned.label.toLowerCase());
      options.push(cleaned);
      if (options.length === MAX_OPTIONS) break;
    }
    if (options.length < MIN_OPTIONS) continue;

    questions.push({
      question,
      kind,
      options,
      multiple: !!entry?.multiple,
      // On by default. The list is the model's guess at the answers; letting
      // somebody say the thing it did not think of is the difference between a
      // question and a quiz.
      other: entry?.other !== false,
      otherLabel: text(entry?.other_label ?? entry?.otherLabel ?? '', MAX_LABEL),
      hint: text(entry?.hint ?? '', MAX_LABEL * 2),
    });
  }

  if (!questions.length) {
    throw new Error(
      'ask_options needs at least one question with two or more distinct options. ' +
        'Pass questions: [{ question, options: ["…", "…"] }].',
    );
  }
  return questions;
}

/**
 * What the model is told the person said.
 *
 * Prose, not JSON. A tool result is text the model reads in the middle of its
 * own reasoning, and "they chose A and B, and added C" is read correctly far
 * more reliably than a structure it has to parse and then describe.
 *
 * The skip case carries an instruction, and it is the important one: an
 * assistant that asks again the question somebody just declined to answer is
 * the behaviour that makes people stop using a thing.
 */
export function answerText(questions, answers) {
  const lines = [];
  let answeredAny = false;

  questions.forEach((q, index) => {
    const given = answers?.[index] ?? {};
    const picks = (Array.isArray(given.picks) ? given.picks : [])
      .map((p) => text(p, MAX_LABEL))
      .filter(Boolean)
      // Only labels that were actually offered, so a client cannot put words in
      // the person's mouth by posting something that was never on screen.
      .filter((p) => q.options.some((o) => o.label === p));
    const other = text(given.other, MAX_LABEL * 2);

    if (!picks.length && !other) {
      lines.push(`Q: ${q.question}\nA: (skipped)`);
      return;
    }

    if (q.kind === 'email' && !EMAIL.test(other)) {
      answeredAny = true;
      lines.push(`Q: ${q.question}\nA: "${other}" — this does not look like an email address; check it with the user before using it.`);
      return;
    }
    if (q.kind && q.kind !== 'choice') {
      answeredAny = true;
      lines.push(`Q: ${q.question}\nA: "${other}"`);
      return;
    }

    answeredAny = true;
    const said = [...picks.map((p) => `"${p}"`)];
    if (other) said.push(`and in their own words: "${other}"`);
    lines.push(`Q: ${q.question}\nA: ${said.join(', ')}`);
  });

  const head = answeredAny
    ? 'The user answered:'
    : 'The user skipped the question rather than answering.';
  const tail = answeredAny
    ? 'Carry on with what they chose. Do not ask this again.'
    : 'Carry on with your own best judgement, and do not ask this again — they have already declined once.';

  return `${head}\n\n${lines.join('\n\n')}\n\n${tail}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The answer as the person would have written it, for the transcript.
 *
 * The model reads `answerText`; the person sees this — one line per question,
 * "Frequency: Daily · Email: an@x.com" — in a bubble on their side of the
 * conversation, so a setup filled in through a form reads back like something
 * they said rather than disappearing into a collapsed step.
 */
export function answerSummary(questions, answers) {
  const parts = [];
  questions.forEach((q, index) => {
    const given = answers?.[index] ?? {};
    const picks = (Array.isArray(given.picks) ? given.picks : []).filter((p) => q.options.some((o) => o.label === p));
    const other = text(given.other, MAX_LABEL * 2);
    const said = [...picks, other].filter(Boolean).join(', ');
    if (said) parts.push(`${q.question.replace(/[?？:：]\s*$/, '')}: ${said}`);
  });
  return parts.join('\n');
}

/**
 * How the card is drawn: one question at a time, or everything at once as a
 * form with a single submit button ("Continue setup"). A form when the model
 * asks for one, or when any field is typed into — a text box alone on a page
 * of its own is a worse form than the same box among the choices it belongs to.
 */
export function askLayout(input, questions) {
  const preview = previewOf(input?.preview);
  const form = input?.style === 'form' || !!preview || questions.some((q) => q.kind && q.kind !== 'choice');
  return {
    form,
    title: text(input?.title ?? '', MAX_QUESTION),
    submitLabel: text(input?.submit_label ?? input?.submitLabel ?? '', 40),
    ...(preview ? { preview } : {}),
  };
}

/**
 * What is about to be set up, drawn above the fields that confirm it.
 *
 * The second of the two steps: the first form collected preferences; this
 * shows the result — name, when, what it covers — marked not active yet,
 * with only what is still missing (usually the address) and a Confirm
 * button. Seeing the thing before it exists is what makes confirming it a
 * decision rather than a formality.
 */
function previewOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, MAX_LABEL);
  if (!title) return null;
  const list = (value, max) =>
    (Array.isArray(value) ? value : [])
      .map((v) => text(v, MAX_LABEL * 2))
      .filter(Boolean)
      .slice(0, max);
  return {
    title,
    subtitle: text(raw.subtitle, MAX_LABEL),
    badge: text(raw.badge, 30),
    rows: list(raw.rows, 6),
    points: list(raw.points, 8),
  };
}

export const __testing = { MAX_QUESTIONS, MIN_OPTIONS, MAX_OPTIONS };
