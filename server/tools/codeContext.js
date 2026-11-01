import { untrusted } from './untrusted.js';
import { search, SEARCH_LEVELS } from '../search.js';

/**
 * `code_context` — working code and documentation for a programming question,
 * the job Claude's `get_code_context_exa` does (owner, 2026-11-01): how a
 * library is actually called, an error's known fix, the shape of an API.
 *
 * Three sources, the best first:
 *   - **Exa**, when the deployment has its key — the same key web_search uses —
 *     asked as Exa's own code tool asks: the passages that match the question
 *     (highlights focused on the query), from anywhere it has indexed code and
 *     documentation, not a fixed list of sites.
 *   - **Stack Overflow**, through the Stack Exchange API: free and keyless, the
 *     questions that match and their best answers, code kept as code.
 *   - Otherwise the ordinary web search, for documentation pages.
 *
 * How many sources, and how hard Exa looks, follow the reasoning level
 * (`SEARCH_LEVELS`, owner 2026-11-02): three on Low, eight on Max.
 *
 * What comes back was written by strangers, so it travels in the untrusted
 * envelope like anything else read from outside: an instruction in an answer
 * is a quote, not an order.
 */

const MAX_CHARS_EACH = 2400;

/** HTML from an answer as plain text, its code blocks fenced and its inline code in backticks. */
export function answerText(html) {
  return String(html || '')
    .replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => `\n\`\`\`\n${entities(code)}\n\`\`\`\n`)
    .replace(/<code>([\s\S]*?)<\/code>/gi, (_, code) => `\`${entities(code)}\``)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => entities(m))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function entities(text) {
  return String(text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

const clip = (text, n = MAX_CHARS_EACH) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * Exa, for code. `fast` on the quick levels and `auto` above — a deep search
 * buys nothing for a snippet. Nothing without the deployment's key.
 */
async function fromExa(query, count, plan, { fetchImpl, signal }) {
  if (!process.env.EXA_API_KEY) return [];
  const res = await fetchImpl('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      type: plan.exa === 'fast' ? 'fast' : 'auto',
      numResults: count,
      contents: { highlights: { query, maxCharacters: MAX_CHARS_EACH }, text: { maxCharacters: 300 } },
    }),
    signal,
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return (body.results || [])
    .filter((r) => r?.url && (r.highlights?.length || r.text))
    .map((r) => ({
      source: 'Exa',
      title: String(r.title || r.url),
      url: String(r.url),
      // Line breaks kept: they are code.
      text: clip(r.highlights?.length ? r.highlights.join('\n…\n') : String(r.text)),
    }));
}

/** Stack Overflow's matching questions and the best answer to each, through the free Stack Exchange API. */
async function fromStackOverflow(query, count, { fetchImpl, signal }) {
  const api = 'https://api.stackexchange.com/2.3';
  const found = await fetchImpl(
    `${api}/search/advanced?${new URLSearchParams({ order: 'desc', sort: 'relevance', q: query, site: 'stackoverflow', pagesize: String(count), answers: '1', filter: 'withbody' })}`,
    { signal },
  );
  if (!found.ok) return [];
  const questions = ((await found.json().catch(() => ({}))).items || []).filter((q) => q?.question_id);
  if (!questions.length) return [];
  const answered = await fetchImpl(
    `${api}/questions/${questions.map((q) => q.question_id).join(';')}/answers?${new URLSearchParams({ order: 'desc', sort: 'votes', site: 'stackoverflow', pagesize: '30', filter: 'withbody' })}`,
    { signal },
  );
  const answers = answered.ok ? (await answered.json().catch(() => ({}))).items || [] : [];
  return questions.flatMap((q) => {
    // The accepted answer, or else the highest voted.
    const best = answers.filter((a) => a.question_id === q.question_id).sort((a, b) => Number(b.is_accepted) - Number(a.is_accepted) || b.score - a.score)[0];
    if (!best) return [];
    return [
      {
        source: 'Stack Overflow',
        title: entities(String(q.title || '')),
        url: String(q.link || ''),
        text: clip(`${best.is_accepted ? 'Accepted answer' : 'Top answer'} (score ${best.score}):\n${answerText(best.body)}`),
      },
    ];
  });
}

/**
 * @param {{ query: string, max_results?: number }} input
 * @param {{ userId?: string, signal?: AbortSignal, fetchImpl?: typeof fetch, plan?: any }} [context]
 */
export async function codeContextTool({ query, max_results }, { userId = null, signal, fetchImpl = fetch, plan = SEARCH_LEVELS.high } = {}) {
  const asked = String(query ?? '').trim().slice(0, 300);
  if (!asked) throw new Error('Say what code or documentation to find — a library and what it should do, or an error message.');
  const count = Math.min(Math.max(Number(max_results) || plan.code || 4, 1), 8);
  // Room for every source asked for, and no more.
  const maxTotal = Math.max(count * MAX_CHARS_EACH, 9_600);
  // Bounded on its own as well as by the turn: a slow source must not hold the turn.
  const limit = AbortSignal.timeout(20_000);
  const timed = signal ? AbortSignal.any([signal, limit]) : limit;

  const [exa, overflow] = await Promise.all([
    fromExa(asked, count, plan, { fetchImpl, signal: timed }).catch(() => []),
    fromStackOverflow(asked, count, { fetchImpl, signal: timed }).catch(() => []),
  ]);
  let found = [...exa, ...overflow];
  // Nothing from either: documentation pages from the ordinary search.
  if (!found.length) {
    const web = await search(`${asked} documentation example`, { count, userId, plan }).catch(() => null);
    found = (web?.results || []).map((r) => ({ source: 'Web', title: String(r.title || r.url), url: String(r.url || ''), text: clip(String(r.snippet || r.content || '')) }));
  }
  if (!found.length) {
    return `Found no code or documentation for "${asked}". Name the library and its version, or try web_search.`;
  }
  let total = 0;
  const blocks = [];
  for (const item of found) {
    const block = `## ${item.title}\n${item.source} · ${item.url}\n\n${item.text}`;
    if (total + block.length > maxTotal) break;
    total += block.length;
    blocks.push(block);
  }
  return {
    content: `Code and documentation for "${asked}" — ${blocks.length} source${blocks.length === 1 ? '' : 's'}:\n${untrusted('code and documentation from the web', blocks.join('\n\n'))}\nCheck an answer against the library's current version before relying on it, and cite the links you use.`,
  };
}
