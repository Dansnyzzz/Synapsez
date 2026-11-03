/**
 * Control markup a model sometimes writes into its own prose (UX-017).
 *
 * A free model answered the owner (2026-11-02) with a line reading
 * `<system>success</system>` between two paragraphs — the shape of the
 * transcripts it was trained on, not anything this app sends: nothing in the
 * server writes such tags. Shown, it reads as the app talking; kept in the
 * stored turn, the model sees it again next turn and keeps the habit.
 *
 * Narrow on purpose, because an answer about prompts may well mean the tags:
 * only a line that holds nothing but one such pair with a short body goes, and
 * never inside a code block. Mid-sentence, or with a body long enough to be
 * content, it stays.
 *
 * Shared by the browser (what is drawn and copied) and the server (what is
 * stored, so the next turn's history is clean too).
 */

const FENCE = /^\s{0,3}(```|~~~)/;
const STRAY_LINE = /^\s*<(system|system-reminder|tool_result|tool_response|function_results?)>[^<>\n]{0,60}<\/\1>\s*$/i;

/**
 * The text without lines that are only a stray control tag.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutStrayTags(text) {
  const source = String(text ?? '');
  if (!source.includes('</')) return source;
  let fenced = false;
  const kept = [];
  for (const line of source.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && STRAY_LINE.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}
