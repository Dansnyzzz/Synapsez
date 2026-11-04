/**
 * One model, reached through either router.
 *
 * OpenRouter and OrcaRouter list many of the same models under nearly the same
 * names. What differs is the spelling: the maker's name (`x-ai` and `grok`,
 * `moonshotai` and `kimi`) and how a free variant is marked (`…:free` and
 * `…-free`). This is the one place that knows those spellings, for the two jobs
 * that need them: filling in what one router's list leaves blank about a model
 * (models.js), and suggesting a model through whichever router a person holds a
 * key for (recommend.js).
 */

/** The routers a model can be reached through, as `shared_models.provider` names them. */
export const ROUTERS = ['openrouter', 'orcarouter'];

/** A maker's name on OpenRouter → its name on OrcaRouter. Everything else is spelled alike. */
const MAKER = { 'x-ai': 'grok', moonshotai: 'kimi' };
const MAKER_BACK = Object.fromEntries(Object.entries(MAKER).map(([open, orca]) => [orca, open]));

const FREE_MARK = /(?::free|-free)$/i;

/** Whether a router's own id (no provider in front) is a free variant, by its spelling. */
export const isFreeSpelling = (model) => FREE_MARK.test(String(model || ''));

/**
 * What a router's own id comes to once its spelling is set aside: the same text
 * for `x-ai/grok-4:free` and `grok/grok-4-free`. Free and paid variants of one
 * model share it, which is what lets one lend the other its facts.
 */
export function canonicalModel(model) {
  const bare = String(model || '').trim().toLowerCase().replace(FREE_MARK, '');
  const slash = bare.indexOf('/');
  if (slash <= 0) return bare;
  const maker = bare.slice(0, slash);
  return `${MAKER[maker] || maker}/${bare.slice(slash + 1)}`;
}

/** A model's id on the given router, in that router's spelling. Null for an id with no maker. */
function spell(model, router, free) {
  const bare = String(model || '').trim().replace(FREE_MARK, '');
  const slash = bare.indexOf('/');
  if (slash <= 0) return null;
  const maker = bare.slice(0, slash).toLowerCase();
  const name = bare.slice(slash + 1);
  const on = router === 'orcarouter' ? MAKER[maker] || maker : MAKER_BACK[maker] || maker;
  const mark = free ? (router === 'orcarouter' ? '-free' : ':free') : '';
  return `${router}/${on}/${name}${mark}`;
}

/**
 * Where a stored id (`openrouter/deepseek/x:free`) could be reached, on each
 * router: the same variant, free stays free and paid stays paid, so a suggestion
 * never turns into a bill. The id given comes back unchanged under its own router.
 *
 * @returns {Record<string, string>} provider → stored id; empty for anything that is not a router's model
 */
export function routesOf(id) {
  const text = String(id || '');
  const slash = text.indexOf('/');
  const provider = slash > 0 ? text.slice(0, slash) : '';
  if (!ROUTERS.includes(provider)) return {};
  const model = text.slice(slash + 1);
  const free = isFreeSpelling(model);
  const routes = {};
  for (const router of ROUTERS) {
    const spelled = router === provider ? text : spell(model, router, free);
    if (spelled) routes[router] = spelled;
  }
  return routes;
}
