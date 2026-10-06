import { getStore } from './store/index.js';
import { getApiKeys } from './settings.js';
import { CATALOG, resolveModel } from './providers/catalog.js';
import { log } from './util/trace.js';
import { lastLocalHour } from './util/zone.js';
import { markedPrice } from './pricing.js';
import { AUTO_ROUTER } from './autoPick.js';

const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const ORCAROUTER_MODELS = 'https://api.orcarouter.ai/v1/models';
const STALE_AFTER_MS = 25 * 60 * 60 * 1000; // a day plus the cron's ±59min slop

/**
 * The hour, on each person's own clock, by which the library is expected to be
 * fresh. The cron runs once a day on UTC; this is what makes "today's list"
 * mean today where the person is, and it is when a new-model notice is due.
 */
export const DAILY_REFRESH_HOUR = 6;

/**
 * Where the catalogue is pulled from, and under which provider each source is
 * filed. Both speak the OpenRouter `/models` shape closely enough for one
 * `normalise` to read either — the differences are absorbed there.
 */
const CATALOGUE_SOURCES = [
  { provider: 'openrouter', url: OPENROUTER_MODELS },
  { provider: 'orcarouter', url: ORCAROUTER_MODELS },
];

/**
 * The shared model library.
 *
 * OpenRouter publishes its whole catalogue publicly, so the library refreshes
 * itself once a day rather than making anyone press a button. Anyone can also
 * paste a single model id — it is verified against the same catalogue and then
 * becomes selectable for everyone, which is the point: one person finding a
 * good free model makes it available to the whole deployment.
 */

/** Group a model under the vendor everyone actually thinks in terms of. */
export function familyOf(openRouterId) {
  const vendor = String(openRouterId).split('/')[0].toLowerCase();
  const known = {
    anthropic: 'anthropic',
    openai: 'openai',
    google: 'google',
    'google-vertex': 'google',
    'meta-llama': 'meta',
    mistralai: 'mistral',
    deepseek: 'deepseek',
    qwen: 'qwen',
    'x-ai': 'xai',
    cohere: 'cohere',
    microsoft: 'microsoft',
    nvidia: 'nvidia',
    perplexity: 'perplexity',
  };
  return known[vendor] || vendor || 'other';
}

/** OpenRouter quotes USD per token; the app works in USD per million. */
const perMillion = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n * 1e6 : null;
};

/**
 * Keep only models that answer in plain text.
 *
 * A handful of OpenRouter models emit images or audio. The chat UI has no way
 * to show those, so importing them would just give people options that appear
 * to do nothing. Vision models are kept — they *read* images but still reply in
 * text, which works fine here.
 */
function isTextModel(entry) {
  const out = entry.architecture?.output_modalities;
  if (Array.isArray(out) && out.length) return out.length === 1 && out[0] === 'text';

  // Older entries only carry a "text+image->text" style string.
  const modality = entry.architecture?.modality || entry.modality;
  if (typeof modality === 'string') return modality.split('->')[1]?.trim() === 'text';

  // Nothing to go on: assume text, which is what almost everything is.
  return true;
}

/**
 * Keep only models that can call tools.
 *
 * Agent mode is the whole point of this app, and a model without tool support
 * silently degrades into a chatbot that promises to do things and then does
 * nothing. Offering one in the picker is worse than not listing it at all.
 */
function supportsTools(entry) {
  const params = entry.supported_parameters;
  // Absent field: assume yes rather than hiding a working model on a hunch.
  if (!Array.isArray(params)) return true;
  return params.includes('tools');
}

/**
 * Whether the model can be shown a picture.
 *
 * Roughly half of the catalogue cannot, and the failure mode is not a worse
 * answer — the provider rejects the entire request, which arrives as a bare
 * "not found" with nothing to connect it to the attachment that caused it.
 * Knowing in advance is what lets the picker say so and the request explain
 * itself instead of falling over.
 */
function acceptsImages(entry) {
  const inputs = entry.architecture?.input_modalities;
  if (Array.isArray(inputs)) return inputs.includes('image');

  // Older entries only carry a "text+image->text" style string.
  const modality = entry.architecture?.modality || entry.modality;
  if (typeof modality === 'string') return /image/i.test(modality.split('->')[0] || '');

  return false;
}

/**
 * Whether the model reasons before it answers — and so whether the effort dial
 * means anything to it.
 *
 * Read from what the aggregator says the model accepts, not guessed from its
 * name. The adapter used to guess (`o1`, `gpt-5`, "thinking" in the id), which
 * missed DeepSeek R1, Qwen 3, GLM, gpt-oss and every Claude and Gemini reached
 * through OpenRouter — most of the reasoning models in the library, all of
 * which then ignored the dial entirely. Null when the source does not say.
 */
export function reasonsFor(entry) {
  const params = entry?.supported_parameters;
  if (!Array.isArray(params)) return null;
  return params.includes('reasoning') || params.includes('include_reasoning') || params.includes('reasoning_effort');
}

/**
 * The most output tokens this model will actually produce, when it says.
 *
 * Worth reading rather than assuming, because the assumption was wrong for a
 * eighth of the catalogue: every request asked for 32000 whatever the model was,
 * and `ai21/jamba-large-1.7` stops at 4096, `amazon/nova-lite-v1` at 5120, the
 * Qwen 3 family at 8192, DeepSeek at 16000. Asking a provider for more than it
 * has already published is at best ignored and at worst refused.
 *
 * Null when OpenRouter does not say, which is a real answer — see `resolveModel`,
 * which derives a conservative figure from the context length instead of
 * reaching for a constant.
 */
function maxOutputOf(entry) {
  // OpenRouter nests this under `top_provider`; OrcaRouter puts it at the top
  // level. Reading both keeps one function honest for two aggregators.
  const stated = Number(entry.top_provider?.max_completion_tokens ?? entry.max_completion_tokens);
  return Number.isFinite(stated) && stated > 0 ? stated : null;
}

/**
 * When the provider stops serving this model, as an ISO instant, or null.
 *
 * OpenRouter publishes `expiration_date` as a bare day ("2026-09-25") — the
 * "Going away September 25" on its model page — and a free variant's end date
 * is how a free model stops being free. Read as the start of that day in UTC,
 * the earliest reading of it: leaving a model in the Free list for an extra day
 * risks a turn that fails, or worse, one that is billed.
 */
export function expiryOf(entry) {
  const raw = entry?.expiration_date ?? entry?.expires_at ?? entry?.deprecation_date ?? null;
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  const when = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
  return Number.isFinite(when) ? new Date(when).toISOString() : null;
}

function normalise(entry, provider = 'openrouter') {
  let priceIn = perMillion(entry.pricing?.prompt);
  let priceOut = perMillion(entry.pricing?.completion);
  // OrcaRouter prices a free model as `{request:"0"}` with no per-token cost,
  // where OpenRouter uses prompt/completion = 0. Read the request form as free
  // and as zero price, so it badges and sorts like any other free model instead
  // of being mistaken for paid and dropped from the Free tab.
  const requestPrice = Number(entry.pricing?.request);
  if (priceIn == null && priceOut == null && Number.isFinite(requestPrice) && requestPrice === 0) {
    priceIn = 0;
    priceOut = 0;
  }
  // Free is decided by the price and only by the price. The `:free` suffix in
  // the id is a naming convention, and a naming convention is not a promise —
  // trusting it would let a rename upstream quietly bill somebody.
  const isFree = priceIn === 0 && priceOut === 0;

  return {
    id: `${provider}/${entry.id}`,
    provider,
    model: entry.id,
    family: familyOf(entry.id),
    label: entry.name || entry.id,
    description: entry.description ? String(entry.description).slice(0, 600) : null,
    context: entry.context_length ?? entry.top_provider?.context_length ?? null,
    maxOutput: maxOutputOf(entry),
    priceIn,
    priceOut,
    isFree,
    vision: acceptsImages(entry),
    reasoning: reasonsFor(entry),
    // `created` is a unix timestamp of when the model was published.
    releasedAt: entry.created ? new Date(entry.created * 1000).toISOString() : null,
    expiresAt: expiryOf(entry),
  };
}

/** Whether a normalised model or a stored row has reached its end date. */
export function hasExpired(model, now = Date.now()) {
  const at = model?.expiresAt ?? model?.expires_at ?? null;
  return at != null && new Date(at).getTime() <= now;
}

async function fetchCatalogue(url, label) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error(`${label} returned an unexpected shape.`);
  return json.data;
}

/** The OpenRouter catalogue alone — the one `addModelById` still checks against. */
const fetchOpenRouterCatalogue = () => fetchCatalogue(OPENROUTER_MODELS, 'OpenRouter');

/**
 * Pull every catalogue source and upsert the union. Safe to run repeatedly.
 *
 * The sources are fetched independently: OrcaRouter being slow or down must not
 * cost the OpenRouter refresh, and the other way round. A source that fails is
 * logged and skipped, so the library keeps whatever it already had for that
 * provider rather than being emptied. Ids are provider-prefixed, so the two
 * never collide in the upsert.
 */
export async function refreshLibrary() {
  const settled = await Promise.allSettled(
    CATALOGUE_SOURCES.map(async ({ provider, url }) => {
      const entries = await fetchCatalogue(url, provider);
      /*
       * A model already past its end date is not imported, even if the source
       * still lists it for a day or two afterwards — so it also falls to the
       * prune below, rather than lingering in the Free list.
       */
      return entries
        .filter((e) => isTextModel(e) && supportsTools(e))
        .map((e) => normalise(e, provider))
        .filter((m) => m.model && !hasExpired(m));
    }),
  );

  const models = [];
  /** Sources that actually answered, with everything they listed. */
  const answered = [];
  settled.forEach((result, i) => {
    const { provider } = CATALOGUE_SOURCES[i];
    if (result.status === 'fulfilled') {
      models.push(...result.value);
      answered.push({ provider, ids: result.value.map((m) => m.id) });
    } else log.error('catalogue refresh failed', result.reason, { provider });
  });

  // Every source failing is a real failure — surface it so `refreshIfStale` can
  // keep the old library rather than stamping it as freshly, emptily refreshed.
  if (!models.length && settled.every((r) => r.status === 'rejected')) {
    throw new Error(settled.map((r) => r.reason?.message).join('; ') || 'No catalogue source answered.');
  }

  await getStore().upsertModels(models);

  /**
   * And forget what the source has stopped listing.
   *
   * A refresh used to be additive only, so the library was a record of every
   * model that had ever existed rather than of the ones that answer today.
   * Withdrawn models stayed in the picker indefinitely, and the account unlucky
   * enough to have one as its default could not send a message at all — every
   * request came back as the provider's 404.
   *
   * Only for a source that answered, and only when it listed something. A
   * provider that is down returns nothing or throws, and reading that as "every
   * model has been withdrawn" would empty the library on an outage — the one
   * failure worse than the one being fixed.
   */
  let dropped = 0;
  for (const { provider, ids } of answered) {
    if (!ids.length) continue;
    const gone = await getStore().pruneMissingModels(provider, ids);
    if (gone) log.info('models withdrawn upstream, removed', { provider, count: gone });
    dropped += gone;
  }

  const status = await getStore().modelLibraryStatus();
  return { imported: models.length, dropped, ...status };
}

/**
 * Refresh in the background if the library looks stale, and never let that
 * failure surface to the caller — a slow or down OpenRouter must not stop
 * someone opening the model picker.
 */
/**
 * @param {{ tz?: string|null, now?: Date }} [options]  `tz` is the asking
 *   person's zone. With one, the library also counts as stale when it was last
 *   refreshed before six this morning *their* time — so whoever opens the app
 *   first after their morning gets today's catalogue, prices and discounts,
 *   whatever hour the UTC cron happened to run.
 */
export async function refreshIfStale({ tz = null, now = new Date() } = {}) {
  const status = await getStore().modelLibraryStatus();
  const refreshed = status.refreshedAt ? new Date(status.refreshedAt).getTime() : 0;
  const age = refreshed ? now.getTime() - refreshed : Infinity;
  const beforeMorning = tz ? refreshed < lastLocalHour(DAILY_REFRESH_HOUR, tz, now).getTime() : false;
  if (age < STALE_AFTER_MS && !beforeMorning) return status;

  // One refresh at a time per instance: the first page loads after six each
  // morning arrive together, and each used to fetch and prune the whole library.
  refreshing ??= refreshLibrary().finally(() => {
    refreshing = null;
  });
  try {
    return await refreshing;
  } catch (err) {
    log.error('model library refresh failed', err);
    return status;
  }
}

/** The refresh in flight, shared by everyone who asks while it runs. */
let refreshing = null;

/**
 * Add one model by id, verifying it exists first. Accepts what people actually
 * paste: a bare id, our prefixed id, or a full openrouter.ai URL.
 */
export async function addModelById(rawId, userId) {
  const cleaned = String(rawId || '')
    .trim()
    .replace(/^https?:\/\/openrouter\.ai\/(models\/)?/i, '')
    .replace(/^openrouter\//i, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');

  if (!cleaned || !cleaned.includes('/')) {
    throw new Error(
      'Enter an OpenRouter model id such as "inclusionai/ling-3.0-flash:free", or paste its page URL.',
    );
  }

  const entries = await fetchOpenRouterCatalogue();
  const match = entries.find((e) => e.id.toLowerCase() === cleaned.toLowerCase());
  if (!match) {
    throw new Error(`OpenRouter has no model called "${cleaned}". Check the id and try again.`);
  }
  if (!isTextModel(match)) {
    throw new Error(
      `"${cleaned}" returns ${match.architecture?.output_modalities?.join(' and ') || 'non-text'} output, which this app cannot display. Only text models can be added.`,
    );
  }
  if (!supportsTools(match)) {
    throw new Error(
      `"${cleaned}" cannot call tools, so it would not be able to do anything in Agent mode — only talk about it. Pick a model whose OpenRouter page lists "tools" support.`,
    );
  }

  const model = { ...normalise(match), addedBy: userId };
  await getStore().upsertModels([model]);
  return model;
}

/**
 * Turn a model id into something the provider layer can run, consulting the
 * shared library for anything that is not a built-in.
 */
export async function resolve(id) {
  if (CATALOG.some((m) => m.id === id)) return resolveModel(id);
  const store = getStore();
  const row = await store.getSharedModel(id);
  if (row && !hasExpired(row)) return resolveModel(id, row);

  /**
   * The model has gone — past its end date, or no longer listed at all.
   *
   * A free period ends, a stealth preview closes, a provider withdraws a
   * model; every account that chose it would otherwise fail on every turn with
   * the provider's 404 — and so would every scheduled task and workflow on it.
   * It moves to the free router, and carries `retiredFrom` so the turn says so
   * out loud. Never to the paid version of the same model: that would start
   * billing somebody without asking. The account itself is moved to Auto by
   * `settleAccountModel` (modelRetirement.js) — this is the per-turn net.
   *
   * "No longer listed" needs the library to know the provider: a row missing
   * from an empty library (a first deploy) is not a withdrawal. A `:free` id is
   * taken as gone even then, as it always was — free variants are what end.
   */
  const label = row?.label || String(id).replace(/^(openrouter|orcarouter)\//, '');
  if (row) return { ...AUTO_ROUTER, retiredFrom: label };
  const provider = String(id).split('/')[0];
  if (provider === 'openrouter' && /:free$/.test(String(id))) return { ...AUTO_ROUTER, retiredFrom: label };
  if (CATALOGUE_SOURCES.some((source) => source.provider === provider)) {
    const known = await store.listSharedModels({ provider, limit: 1 }).catch(() => []);
    if (known.length) return { ...AUTO_ROUTER, retiredFrom: label };
  }
  return resolveModel(id, null);
}

/**
 * The picker's data: built-in first-party models plus the shared library,
 * already filtered and sorted by the database.
 */
export async function browse(filters) {
  const store = getStore();
  const [shared, families, status] = await Promise.all([
    store.listSharedModels(filters),
    store.modelFamilies(),
    store.modelLibraryStatus(),
  ]);

  return {
    // Every price here is what the person pays: the provider's rate plus this
    // service's share (see pricing.js). The stored rate stays the provider's.
    builtin: CATALOG.map((m) => (m.price ? { ...m, price: markedPrice(m.price) } : m)),
    models: shared.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      family: m.family,
      label: m.label,
      description: m.description,
      context: m.context ? Number(m.context) : null,
      price: m.price_in == null ? null : markedPrice({ in: Number(m.price_in), out: Number(m.price_out) }),
      isFree: m.is_free,
      vision: !!m.vision,
      releasedAt: m.released_at,
      // Shown as "Going away <date>" in the picker, the way OpenRouter does.
      expiresAt: m.expires_at ? new Date(m.expires_at).toISOString() : null,
    })),
    families: families.map((f) => ({ family: f.family, count: f.count, free: f.free })),
    status,
  };
}

/* ── does this model actually work with my key ──────────────────────── */

/**
 * Listing a model and being allowed to call it are different questions.
 *
 * Google's `ListModels` still returns `gemini-2.5-flash` long after it stopped
 * accepting new keys — a call to it comes back 404 "no longer available to new
 * users". So the catalogue cannot be audited by reading a list: every entry has
 * to be *called*, with the smallest request the provider will accept, using the
 * key the account actually holds.
 *
 * One token in, one token out, per model. That is a fraction of a cent for an
 * answer that is otherwise discovered halfway through somebody's work.
 */
const PROBES = {
  async anthropic(key, model, signal) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal,
    });
    return res;
  },
  async openai(key, model, signal) {
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_completion_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal,
    });
  },
  async google(key, model, signal) {
    // In a header rather than `?key=`: a query string lands in proxy logs and
    // error traces, and this probe exists to be run when something is already
    // going wrong. Same call, same result — see embedGoogle in rag.js.
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal,
    });
  },
  async openrouter(key, model, signal) {
    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal,
    });
  },
};

/** The provider's own reason, rather than a status code nobody can act on. */
async function reasonFrom(res) {
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    const message = json?.error?.message || json?.error?.detail || json?.message || '';
    return String(message).split('\n')[0].slice(0, 200) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Check every built-in model against the keys this account holds.
 *
 * @returns `[{ id, provider, label, state, reason }]` where `state` is
 *   'ok' · 'gone' · 'refused' · 'no key' · 'unreachable'
 */
export async function auditCatalog(userId, { timeoutMs = 20_000 } = {}) {
  const byProvider = new Map();
  for (const entry of CATALOG) {
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider).push(entry);
  }

  const results = [];

  for (const [provider, entries] of byProvider) {
    const [key] = await getApiKeys(userId, provider).catch(() => []);
    if (!key) {
      for (const entry of entries) {
        results.push({ ...summarise(entry), state: 'no key', reason: `No ${provider} key on this account.` });
      }
      continue;
    }

    // In parallel: they are independent, and a serial pass over a dozen models
    // is a button somebody presses once and never again.
    const checked = await Promise.all(
      entries.map(async (entry) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await PROBES[provider](key.key, entry.model, controller.signal);
          if (res.ok) return { ...summarise(entry), state: 'ok', reason: '' };

          const reason = await reasonFrom(res);
          // 404 and "no longer available" are the model being gone; 401/402/429
          // are the key, and saying which is the difference between changing a
          // model and topping up an account.
          const gone = res.status === 404 || /not found|no longer available|does not exist|deprecat/i.test(reason);
          return { ...summarise(entry), state: gone ? 'gone' : 'refused', reason };
        } catch (err) {
          return {
            ...summarise(entry),
            state: 'unreachable',
            reason: err.name === 'AbortError' ? 'Timed out.' : err.message,
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    results.push(...checked);
  }

  return results;
}

const summarise = (entry) => ({
  id: entry.id,
  provider: entry.provider,
  model: entry.model,
  label: entry.label,
});

/** Exposed for the suite that pins how each aggregator's /models shape is read. */
export const __testing = { normalise, maxOutputOf, acceptsImages, expiryOf, hasExpired };
