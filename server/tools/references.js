/**
 * Looking something up in more than one reference (owner, 2026-11-05: "the same for
 * the encyclopedia"). All free and keyless. `source` says which: Wikipedia for what a
 * thing is, Wikidata for its exact facts, Wiktionary for a word, Open Library for a
 * book, Crossref and arXiv for a paper. Each answers in a few lines with its link.
 */

const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const languageFor = (query, lang) => (/^[a-z]{2,3}$/.test(String(lang || '')) ? lang : VIETNAMESE.test(query) ? 'vi' : 'en');
const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

export async function wikipedia(query, lang, { getJson }) {
  const language = languageFor(query, lang);
  const host = `https://${language}.wikipedia.org`;
  const found = await getJson(`${host}/w/rest.php/v1/search/title?limit=1&q=${encodeURIComponent(query)}`);
  const page = found?.pages?.[0];
  if (!page) throw new Error(`Wikipedia (${language}) has no article matching "${query}".`);
  const summary = await getJson(`${host}/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`);
  const link = summary?.content_urls?.desktop?.page || `${host}/wiki/${encodeURIComponent(page.key)}`;
  return { link, text: `${summary.title}${summary.description ? ` — ${summary.description}` : ''}\n\n${summary.extract || '(no summary)'}\n\nSource: ${link}` };
}

/** The properties most questions about a person, a place or a company are after. */
const WIKIDATA_PROPERTIES = {
  P569: 'born',
  P570: 'died',
  P19: 'place of birth',
  P27: 'citizenship',
  P106: 'occupation',
  P39: 'position held',
  P17: 'country',
  P131: 'located in',
  P36: 'capital',
  P1082: 'population',
  P2046: 'area',
  P571: 'founded',
  P112: 'founded by',
  P159: 'headquarters',
  P169: 'chief executive',
  P452: 'industry',
  P856: 'website',
};

export async function wikidata(query, lang, { getJson }) {
  const language = languageFor(query, lang);
  const api = 'https://www.wikidata.org/w/api.php?format=json&origin=*';
  const found = await getJson(`${api}&action=wbsearchentities&limit=1&language=${language}&uselang=${language}&search=${encodeURIComponent(query)}`);
  const hit = found?.search?.[0];
  if (!hit) throw new Error(`Wikidata has nothing matching "${query}".`);
  const data = await getJson(`${api}&action=wbgetentities&props=claims|labels|descriptions&languages=${language}|en&ids=${hit.id}`);
  const entity = data?.entities?.[hit.id];
  const wanted = [];
  const ids = new Set();
  for (const [property, label] of Object.entries(WIKIDATA_PROPERTIES)) {
    const statements = (entity?.claims?.[property] || []).filter((c) => c.rank !== 'deprecated').slice(0, 4);
    if (!statements.length) continue;
    const values = statements.map((c) => c.mainsnak?.datavalue?.value).filter((v) => v !== undefined);
    for (const v of values) if (v?.id) ids.add(v.id);
    wanted.push({ label, values });
  }
  const names = new Map();
  if (ids.size) {
    const labels = await getJson(`${api}&action=wbgetentities&props=labels&languages=${language}|en&ids=${[...ids].slice(0, 45).join('|')}`);
    for (const [id, e] of Object.entries(labels?.entities || {})) names.set(id, e?.labels?.[language]?.value || e?.labels?.en?.value || id);
  }
  const say = (v) => {
    if (v?.id) return names.get(v.id) || v.id;
    if (v?.time) return String(v.time).replace(/^\+/, '').slice(0, 10).replace(/-00(-00)?$/, '');
    if (v?.amount) return Number(v.amount).toLocaleString('en');
    return String(v?.text ?? v);
  };
  const link = `https://www.wikidata.org/wiki/${hit.id}`;
  const lines = wanted.map(({ label, values }) => `${label}: ${values.map(say).join(', ')}`);
  return { link, text: `${hit.label}${hit.description ? ` — ${hit.description}` : ''}\n${lines.join('\n') || '(no facts of the usual kinds)'}\n\nSource: ${link}` };
}

export async function wiktionary(query, lang, { getJson }) {
  const word = String(query).trim().toLowerCase();
  const language = languageFor(word, lang);
  const data = await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`);
  const keys = Object.keys(data || {});
  if (!keys.length) throw new Error(`Wiktionary has no entry for "${query}".`);
  const order = [language, 'en', ...keys.filter((k) => k !== language && k !== 'en')].filter((k) => data[k]);
  const lines = [];
  for (const key of order.slice(0, 2)) {
    for (const part of (data[key] || []).slice(0, 4)) {
      const senses = (part.definitions || []).slice(0, 4).map((d) => stripTags(d.definition)).filter(Boolean);
      if (senses.length) lines.push(`${part.language} ${String(part.partOfSpeech || '').toLowerCase()}: ${senses.join('; ')}`);
    }
  }
  const link = `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
  return { link, text: `${word}\n${lines.join('\n') || '(no definitions)'}\n\nSource: ${link}` };
}

export async function openLibrary(query, _lang, { getJson }) {
  const data = await getJson(`https://openlibrary.org/search.json?limit=5&fields=title,author_name,first_publish_year,edition_count,key,isbn&q=${encodeURIComponent(query)}`);
  const docs = data?.docs || [];
  if (!docs.length) throw new Error(`Open Library has no book matching "${query}".`);
  const link = `https://openlibrary.org${docs[0].key}`;
  const lines = docs.map((b) => `${b.title}${b.author_name?.length ? ` — ${b.author_name.slice(0, 3).join(', ')}` : ''}${b.first_publish_year ? ` (${b.first_publish_year})` : ''}, ${b.edition_count || 1} edition(s) — https://openlibrary.org${b.key}`);
  return { link, text: `${lines.join('\n')}\n\nSource: Open Library` };
}

export async function crossref(query, _lang, { getJson }) {
  const data = await getJson(`https://api.crossref.org/works?rows=5&select=title,author,issued,container-title,DOI,URL,is-referenced-by-count&query=${encodeURIComponent(query)}`);
  const items = data?.message?.items || [];
  if (!items.length) throw new Error(`Crossref has no paper matching "${query}".`);
  const lines = items.map((w) => {
    const who = (w.author || []).slice(0, 3).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ');
    const year = w.issued?.['date-parts']?.[0]?.[0];
    return `${(w.title || ['(untitled)'])[0]}${who ? ` — ${who}` : ''}${year ? ` (${year})` : ''}${w['container-title']?.[0] ? `, ${w['container-title'][0]}` : ''}, cited ${w['is-referenced-by-count'] ?? 0} times — ${w.URL || `https://doi.org/${w.DOI}`}`;
  });
  return { link: items[0].URL || '', text: `${lines.join('\n')}\n\nSource: Crossref` };
}

export async function arxiv(query, _lang, { getText }) {
  const xml = await getText(`https://export.arxiv.org/api/query?max_results=5&sortBy=relevance&search_query=all:${encodeURIComponent(query)}`);
  const entries = [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  if (!entries.length) throw new Error(`arXiv has no paper matching "${query}".`);
  const field = (entry, tag) => stripTags(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1] || '').replace(/\s+/g, ' ').trim();
  const lines = entries.map((entry) => {
    const who = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 3).map((m) => m[1]).join(', ');
    return `${field(entry, 'title')} — ${who} (${field(entry, 'published').slice(0, 10)}) — ${field(entry, 'id')}\n  ${field(entry, 'summary').slice(0, 300)}`;
  });
  return { link: field(entries[0], 'id'), text: `${lines.join('\n')}\n\nSource: arXiv` };
}

export const REFERENCE_SOURCES = { wikipedia, wikidata, wiktionary, openlibrary: openLibrary, crossref, arxiv };
