/**
 * "@Name" in a group chat: who a message calls (owner, 2026-11-09).
 *
 * One rule, read by both sides: the server decides with it who answers a message,
 * and the page colours the same names in the bubbles, so the bot the person sees
 * called is the bot that is called. Pure, so both import it.
 *
 * The idea — one shared reading of "@Name", longest names first, an address or a
 * code span is not a call — follows DS Bot's group chats (NOTICE); the code is
 * this app's own.
 *
 * Read as a call:
 *   - "@" followed by a bot's whole name, in any case. A name may hold spaces, so
 *     the longest name that fits wins: "@Writer Two" is Writer Two, not Writer.
 *   - Not when a letter, digit or one of `_ . /` stands right before the "@"
 *     (an e-mail address, "medium.com/@writer"), nor when the name runs on into a
 *     longer word ("@Writers" does not call Writer), or a file ("@Docs.md").
 *   - Not inside `code`, a ```fenced block``` or a Markdown [link](…), which are quoted.
 */

/**
 * Right after the name, a letter, digit, `_ - / \`, or a dot followed by a letter or
 * digit, means a longer word, a path or a file ("@Docs.md"); a dot that ends the
 * sentence ("…to you, @Coder.") does not.
 */
const RUNS_ON = /^(?:[\p{L}\p{N}_\-/\\]|\.[\p{L}\p{N}])/u;
/** A letter, digit or `_ . /` right before "@" means an address. */
const ADDRESS = /[\p{L}\p{N}_./]/u;
/**
 * Quoted text: fenced blocks, inline code, and Markdown links — a link's words are an
 * anchor on the page, which never colours a name inside one, so the server does not
 * read one there either (DS Bot study, 2026-11-10).
 */
const QUOTED = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g;

/** What a bot cannot be called, so that "@" always reads one way. */
export const RESERVED_NAMES = Object.freeze(['all', 'everyone', 'user', 'you', 'me']);

/** The longest a bot's name may be. */
export const NAME_MAX = 40;

/**
 * What is wrong with a bot's name, as a key of the dictionary, or null when it is fine.
 *
 * @param {unknown} name
 * @returns {null | 'bots.name.empty' | 'bots.name.long' | 'bots.name.chars' | 'bots.name.reserved'}
 */
export function nameProblem(name) {
  const text = String(name ?? '').trim();
  if (!text) return 'bots.name.empty';
  if (text.length > NAME_MAX) return 'bots.name.long';
  if (/[@`\r\n\t<>]/.test(text)) return 'bots.name.chars';
  if (RESERVED_NAMES.includes(text.toLowerCase())) return 'bots.name.reserved';
  return null;
}

/**
 * Every "@Name" in `text`, in order, as `{ start, end, bot }`.
 *
 * @template {{ name: string }} B
 * @param {string} text @param {B[]} bots
 * @returns {{ start: number, end: number, bot: B }[]}
 */
export function mentionSpans(text, bots) {
  const value = String(text ?? '');
  const quoted = [...value.matchAll(QUOTED)].map((m) => [m.index, m.index + m[0].length]);
  const inQuote = (at) => quoted.some(([a, b]) => at >= a && at < b);
  const byLength = [...bots].filter((b) => b?.name).sort((a, b) => b.name.length - a.name.length);
  const out = [];
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if ((at > 0 && ADDRESS.test(value[at - 1])) || inQuote(at)) continue;
    const bot = byLength.find((b) => {
      const word = value.slice(at + 1, at + 1 + b.name.length);
      return word.toLowerCase() === b.name.toLowerCase() && !RUNS_ON.test(value.slice(at + 1 + b.name.length));
    });
    if (!bot) continue;
    const end = at + 1 + bot.name.length;
    out.push({ start: at, end, bot });
    at = end - 1;
  }
  return out;
}

/**
 * The bots `text` calls, each once, in the order first called.
 *
 * @template {{ id: string, name: string }} B
 * @param {string} text @param {B[]} bots
 * @returns {B[]}
 */
export function mentionedBots(text, bots) {
  const seen = new Set();
  const out = [];
  for (const { bot } of mentionSpans(text, bots)) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    out.push(bot);
  }
  return out;
}

/**
 * The "@" being typed at the caret, for the picker: the text after it, or null
 * when the caret is not in one.
 *
 * @param {string} text @param {number} caret
 * @returns {{ start: number, query: string } | null}
 */
export function atQuery(text, caret) {
  const before = String(text ?? '').slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && ADDRESS.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // A picker for a name, which is short and on one line.
  if (query.length > NAME_MAX || /[\n@`]/.test(query)) return null;
  return { start: at, query };
}
