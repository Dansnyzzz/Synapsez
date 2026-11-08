/**
 * What the checks after an answer said about it ("Source check: corrected 1 citation"),
 * apart from the answer (owner, 2026-11-08, screenshot 11).
 *
 * They are the system speaking, not the model: shown as a note under the reply, never
 * selected or copied with it. The server writes them as the last lines of the text
 * (server/qualityGate.js, `gateNote` and `figureNote`), so an answer stored before this
 * change reads the same way.
 *
 * No imports, so it can be tested without a browser.
 */

const CHECK_LINE = /^\*(?:Source check|Kiểm tra nguồn|Figure check|Kiểm tra số liệu):[^\n]*\*$/u;

/**
 * @param {string} text
 * @returns {{ body: string, notes: string[] }}
 */
export function splitChecks(text) {
  const lines = String(text || '').replace(/\s+$/u, '').split('\n');
  const notes = [];
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (CHECK_LINE.test(last)) {
      notes.unshift(last.slice(1, -1));
      lines.pop();
    } else if (!last && notes.length) {
      lines.pop();
    } else break;
  }
  return { body: notes.length ? lines.join('\n').replace(/\s+$/u, '') : String(text || ''), notes };
}
