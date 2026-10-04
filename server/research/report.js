import { grade } from './confidence.js';
import { STOPWORDS } from '../rag.js';

/** The S# ids a line cites, in order. */
export function markerIds(text) {
  return [...String(text || '').matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
}

/* ── does the cited page actually say it? ─────────────────────────────── */

/** Letters only Vietnamese uses — enough to tell a Vietnamese sentence from an English one. */
const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu;
const isVietnamese = (text) => (String(text).match(VIETNAMESE) || []).length >= 3;

/** Numbers with three digits or more, separators removed: years, amounts, counts. */
const figures = (text) =>
  [...String(text || '').matchAll(/\d[\d.,\s]*\d/g)]
    .map((m) => m[0].replace(/\D/g, ''))
    .filter((digits) => digits.length >= 3);

const words = (text) =>
  [...new Set(String(text || '').toLowerCase().replace(/\[S\d+\]/g, ' ').split(/[^\p{L}\p{N}]+/u))].filter(
    (w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w),
  );

/**
 * Whether a claim can be found in a page it cites — the job Claude's citation
 * agent does with a model, done here with arithmetic.
 *
 * Two tests, and the second only where it means something. Every figure in the
 * claim of three digits or more — a year, a price, a count — must appear in the
 * page, whatever language either is in; a number is the same in both, and a
 * figure the page never states is the commonest way a confident summary is
 * wrong. And when claim and page are in the same language, a good share of the
 * claim's words must be on the page too. Across languages the word test is
 * skipped: a Vietnamese conclusion drawn from an English page shares no words
 * with it and is not wrong for that.
 *
 * Only pages that were read are checked — a search blurb is too short to judge
 * anything against, and those citations are capped at MEDIUM already.
 *
 * @returns 'supported' | 'unsupported' | 'unchecked'
 */
export function citationSupport(claim, sources) {
  const read = sources.filter((s) => s?.read && s.body);
  if (!read.length) return 'unchecked';
  const numbers = figures(claim);
  const claimWords = words(claim);
  const claimVi = isVietnamese(claim);
  let judged = false;
  for (const s of read) {
    const page = String(s.body);
    const pageDigits = page.replace(/[^\d]/g, ' ').replace(/\s+/g, ' ');
    const flat = ` ${page.replace(/(\d)[.,\s](?=\d)/g, '$1')} `;
    const numbersOk = numbers.every((n) => flat.includes(n) || pageDigits.includes(n));
    const sameLanguage = claimVi === isVietnamese(page);
    if (!numbers.length && !sameLanguage) continue;
    judged = true;
    if (!numbersOk) continue;
    if (!sameLanguage || claimWords.length < 3) return 'supported';
    const lower = page.toLowerCase();
    const shared = claimWords.filter((w) => lower.includes(w)).length;
    if (shared / claimWords.length >= 0.35) return 'supported';
  }
  return judged ? 'unsupported' : 'unchecked';
}

/** One step down, for a claim its pages do not bear out. */
const LOWER = { HIGH: 'MEDIUM', MEDIUM: 'LOW', LOW: 'LOW' };

/**
 * Assemble the final report, and make the citation rule real rather than merely
 * requested.
 *
 * Every claim is graded from the markers it actually carries; a claim with no
 * `[S#]` marker is labelled `LOW — no source` instead of passing as ordinary
 * prose. This is the difference between telling the model "please don't
 * hallucinate" (which does nothing) and a system that can *see* when it did:
 * the uncited sentence still appears, but it appears flagged, so a reader — or
 * an audit — can tell what rests on evidence from what does not.
 *
 * Then the cited pages are checked for the claim itself (see
 * `citationSupport`). A claim whose read sources do not bear it out drops one
 * grade and says why — never the other way: this can only lower a label.
 *
 * @param claims [{ text, conflicting? }] — text carries the `[S#]` markers
 * @param ledger Map<id, { url, rank, title, published, body?, read? }>
 * @param status complete | budget | failed | aborted
 */
export function buildReport({ question, claims, ledger, status }) {
  const lines = [`# ${question}`, ''];
  if (status === 'budget') {
    lines.push('_Stopped at its token or time limit; this is what was gathered so far._', '');
  }

  let unsupported = 0;
  lines.push('## Conclusions', '');
  for (const claim of claims || []) {
    const ids = markerIds(claim.text);
    let label = claim.conflicting ? 'CONFLICTING' : ids.length ? grade(ids, ledger) : 'LOW — no source';
    if (ids.length && !claim.conflicting) {
      const support = citationSupport(claim.text, ids.map((id) => ledger.get(id)).filter(Boolean));
      if (support === 'unsupported') {
        unsupported += 1;
        label = `${LOWER[label] || label} — the cited page does not state this as written`;
      }
    }
    lines.push(`- ${claim.text}  \n  _confidence: ${label}_`);
  }
  if (!claims || !claims.length) lines.push('_No conclusion could be drawn from the evidence gathered._');

  lines.push('', '## Sources', '');
  if (ledger.size === 0) {
    lines.push('_No sources were found. Treat every conclusion above as unverified._');
  } else {
    for (const [id, s] of ledger) {
      /**
       * Say whether the page was opened.
       *
       * A citation that looks identical whether the page was read or merely
       * listed in a search result invites the reader to assume the first. The
       * ones that were actually opened are the ones a HIGH confidence rests on,
       * and the reader is entitled to know which those are.
       */
      const how = s.body ? 'read' : s.readError ? `not read — ${s.readError}` : 'search result only';
      lines.push(
        `- **${id}** ${s.title || s.url} — ${s.url}${s.published ? ` (${s.published})` : ''} _(${how})_`,
      );
    }

    const readCount = [...ledger.values()].filter((s) => s.body).length;
    lines.push(
      '',
      `_${readCount} of ${ledger.size} source${ledger.size === 1 ? '' : 's'} ${readCount === 1 ? 'was' : 'were'} opened and read. ` +
        'Confidence is HIGH only where two independent sources of standing were read and agreed; ' +
        'a source listed but not opened can support MEDIUM at best.' +
        (unsupported
          ? ` ${unsupported} conclusion${unsupported === 1 ? '' : 's'} cited a page that does not state it as written, and ${unsupported === 1 ? 'was' : 'were'} marked down._`
          : '_'),
    );
  }
  return lines.join('\n');
}
