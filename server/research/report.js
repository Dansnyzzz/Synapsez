import { grade } from './confidence.js';

/** The S# ids a line cites, in order. */
export function markerIds(text) {
  return [...String(text || '').matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
}

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
 * @param claims [{ text, conflicting? }] — text carries the `[S#]` markers
 * @param ledger Map<id, { url, rank, title, published }>
 * @param status complete | budget | failed | aborted
 */
export function buildReport({ question, claims, ledger, status }) {
  const lines = [`# ${question}`, ''];
  if (status === 'budget') {
    lines.push('_Stopped at its token or time limit; this is what was gathered so far._', '');
  }

  lines.push('## Conclusions', '');
  for (const claim of claims || []) {
    const ids = markerIds(claim.text);
    const label = claim.conflicting ? 'CONFLICTING' : ids.length ? grade(ids, ledger) : 'LOW — no source';
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
       * few that were actually opened are the ones a HIGH confidence rests on,
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
        'a source listed but not opened can support MEDIUM at best._',
    );
  }
  return lines.join('\n');
}
