import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { toast, revealInStrip } from './render.js';
import { parseQuery, familyLabel } from './search.js';

/**
 * The model browser.
 *
 * Search is parsed rather than passed straight through, so a query like
 * "free claude >200k <$1" filters on tier, family, context and price at once
 * and only the leftover words go to the database as text. That is the whole
 * "smart search" trick — no index, no ranking model, just reading intent out
 * of the words people already type.
 */

const fmtContext = (n) => {
  if (!n) return null;
  if (n >= 1e6) return t('models.contextM', { n: (n / 1e6).toFixed(n % 1e6 ? 1 : 0) });
  if (n >= 1e3) return t('models.contextK', { n: Math.round(n / 1e3) });
  return t('models.context', { n });
};

const fmtPrice = (price) => {
  if (!price) return null;
  const round = (n) => (n >= 1 ? n.toFixed(2) : n.toFixed(3).replace(/0+$/, ''));
  return t('models.pricePer1M', { in: round(price.in), out: round(price.out) });
};

/** Released within the last 45 days gets a "new" tag. */
const isRecent = (iso) => !!iso && Date.now() - new Date(iso).getTime() < 45 * 86_400_000;

const relative = (iso) => {
  if (!iso) return '';
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return t('models.today');
  if (days === 1) return t('when.yesterday');
  if (days < 30) return t('time.daysShort', { n: days });
  if (days < 365) return t('models.monthsAgo', { n: Math.round(days / 30) });
  return t('models.yearsAgo', { n: Math.round(days / 365) });
};

export function createModelBrowser({ onPick }) {
  const dialog = document.getElementById('models');
  const searchInput = document.getElementById('model-search');
  const clearButton = document.getElementById('model-search-clear');
  const results = document.getElementById('model-results');
  const familyBar = document.getElementById('family-filter');
  const vendorRow = document.getElementById('vendor-row');
  const sortSelect = document.getElementById('model-sort');
  const statusLabel = document.getElementById('library-status');

  const state = {
    // Which API the model runs on, and therefore which of your keys pays for
    // it — the distinction people actually care about when picking.
    provider: 'all',
    tier: 'all',
    family: 'all',
    sort: 'new',
    query: '',
    current: null,
    builtin: [],
  };
  let debounce = null;

  /** The shared library is the aggregators; the rest are first-party keys. */
  const LIBRARY = new Set(['openrouter', 'orcarouter']);
  const isLibrary = (provider) => provider === 'all' || LIBRARY.has(provider);

  async function load() {
    const parsed = parseQuery(state.query);

    // Words in the box beat the buttons, so typing "free" just works.
    const tier = parsed.tier || state.tier;
    const family = parsed.family || state.family;
    const { provider } = state;

    results.innerHTML = `<p class="hint">${escapeHtml(t('common.loading'))}</p>`;

    let data;
    try {
      // Ask the server for one aggregator's models directly when a specific one
      // is selected, so a row limit cannot leave the tab empty by filling the
      // page with the other aggregator's newer models.
      const libraryProvider = isLibrary(provider) && provider !== 'all' ? provider : undefined;
      data = await api.models({ q: parsed.text, tier, family, sort: state.sort, provider: libraryProvider });
    } catch (err) {
      results.innerHTML = `<p class="hint">${escapeHtml(t('models.loadFailed', { error: err.message }))}</p>`;
      return;
    }

    state.builtin = data.builtin;
    renderFamilies(data.families, family);
    renderStatus(data.status, provider);

    // Vendor chips describe families inside the OpenRouter catalogue, so they
    // mean nothing while a first-party provider is selected.
    vendorRow.hidden = !isLibrary(provider);

    // Context and price are client-side because they come from the parsed query
    // rather than the filter controls.
    let models = isLibrary(provider) ? data.models : [];
    // 'all' shows every aggregator's models together; a specific one shows only
    // its own — the library holds both OpenRouter and OrcaRouter now.
    if (provider !== 'all' && isLibrary(provider)) models = models.filter((m) => m.provider === provider);
    if (parsed.minContext) models = models.filter((m) => (m.context || 0) >= parsed.minContext);
    if (parsed.maxPrice != null) {
      models = models.filter((m) => m.isFree || (m.price && m.price.in <= parsed.maxPrice));
    }

    // Selecting an aggregator means the library alone; the built-ins run on your
    // own Anthropic, OpenAI or Google key and are a different thing entirely.
    const builtin = isLibrary(provider)
      ? []
      : matchingBuiltins(data.builtin, { ...parsed, tier, family, provider });

    renderResults(builtin, models, tier, provider);
  }

  /** First-party models are not in the shared library, so filter them here. */
  function matchingBuiltins(builtin, { text, tier, family, provider, minContext, maxPrice }) {
    return builtin.filter((m) => {
      if (tier === 'free') return false; // none of the first-party models are free
      if (provider && provider !== 'all' && m.provider !== provider) return false;
      if (family && family !== 'all' && m.provider !== family) return false;
      if (minContext && (m.context || 0) < minContext) return false;
      if (maxPrice != null && !(m.price && m.price.in <= maxPrice)) return false;
      if (text) {
        const haystack = `${m.id} ${m.label}`.toLowerCase();
        if (!text.toLowerCase().split(/\s+/).every((w) => haystack.includes(w))) return false;
      }
      return true;
    });
  }

  function renderFamilies(families, active) {
    const chips = [{ family: 'all', count: null }, ...families];
    familyBar.innerHTML = chips
      .map((f) => {
        const label =
          f.family === 'all'
            ? t('models.allVendors')
            : `${familyLabel(f.family)}${f.count ? ` <span class="muted">${f.count}</span>` : ''}`;
        return `<button class="chip-btn ${f.family === active ? 'is-active' : ''}"
                        data-family="${escapeHtml(f.family)}" type="button">${label}</button>`;
      })
      .join('');

    // Only hint at scrolling when there is something past the edge.
    familyBar.classList.toggle('is-scrollable', familyBar.scrollWidth > familyBar.clientWidth + 2);

    // Whichever vendor is selected should be visible, including when the list
    // is rebuilt after a search and the active chip lands off the right edge.
    revealInStrip(familyBar.querySelector('.chip-btn.is-active'));

    for (const btn of familyBar.querySelectorAll('[data-family]')) {
      btn.addEventListener('click', () => {
        revealInStrip(btn);
        state.family = btn.dataset.family;
        // Clear a vendor word from the box so the chip is not fighting it.
        const parsed = parseQuery(state.query);
        if (parsed.family) {
          state.query = parsed.text;
          searchInput.value = state.query;
        }
        load();
      });
    }
  }

  const PROVIDER_LABEL = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    openrouter: 'OpenRouter',
    orcarouter: 'OrcaRouter',
  };

  function renderStatus(status, provider) {
    // The counts describe the shared library, so saying them while a first-party
    // provider is selected would be describing the wrong thing.
    if (provider && !isLibrary(provider)) {
      statusLabel.textContent = t('models.billedToKey', { provider: PROVIDER_LABEL[provider] });
      return;
    }
    statusLabel.textContent = status.total
      ? t('models.libraryStatus', {
          total: status.total.toLocaleString(),
          free: status.free.toLocaleString(),
          when: relative(status.refreshedAt),
        })
      : t('models.empty');
  }

  function card(model, isBuiltin) {
    const tags = [];
    if (model.isFree) tags.push(`<span class="tag tag--free">${escapeHtml(t('models.tagFree'))}</span>`);
    if (isRecent(model.releasedAt)) tags.push(`<span class="tag tag--new">${escapeHtml(t('models.tagNew'))}</span>`);
    // The one capability that fails loudly rather than quietly: send a picture
    // to a model without it and the provider rejects the whole request.
    if (model.vision !== false) tags.push(`<span class="tag tag--vision">${escapeHtml(t('models.seesImages'))}</span>`);
    if (isBuiltin) tags.push(`<span class="tag">${escapeHtml(t('models.tagBuiltIn'))}</span>`);
    // The provider has announced an end date — OpenRouter's "Going away". Said
    // before it happens, so nobody builds a daily job on a model with a week left.
    if (model.expiresAt) {
      const day = new Date(model.expiresAt).toLocaleDateString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
      tags.push(`<span class="tag tag--ending">${escapeHtml(t('models.goingAway', { day }))}</span>`);
    }

    const meta = [
      fmtContext(model.context),
      model.isFree ? t('models.noCost') : fmtPrice(model.price),
      model.releasedAt ? t('models.released', { when: relative(model.releasedAt) }) : null,
    ]
      .filter(Boolean)
      .join(' · ');

    return `
      <button class="model-card ${model.id === state.current ? 'is-current' : ''}"
              data-model="${escapeHtml(model.id)}" type="button">
        <span class="model-card__main">
          <span class="model-card__name">${escapeHtml(model.label)} ${tags.join(' ')}</span>
          <span class="model-card__id">${escapeHtml(model.id)}</span>
          ${meta ? `<span class="model-card__meta">${escapeHtml(meta)}</span>` : ''}
        </span>
      </button>`;
  }

  /**
   * The "I don't know which model is strong" answer, always at the top.
   *
   * It is a real, selectable id (`auto`) resolved per turn to the best free
   * model the account can run, so it goes through the same click handler as any
   * card. Hidden only on the Paid tab, where a free-only choice would be noise.
   */
  function autoCardHtml() {
    return (
      `<div class="model-group__label">${escapeHtml(t('models.automatic'))}</div>` +
      `<button class="model-card ${state.current === 'auto' ? 'is-current' : ''}" data-model="auto" type="button">` +
      `<span class="model-card__main">` +
      `<span class="model-card__name">${escapeHtml(t('models.autoName'))}</span>` +
      `<span class="model-card__meta">${escapeHtml(t('models.autoMeta'))}</span>` +
      `</span></button>`
    );
  }

  function renderResults(builtin, models, tier, provider) {
    const sections = [];
    if (tier !== 'paid') sections.push(autoCardHtml());

    if (!builtin.length && !models.length) {
      // Say *why* it is empty. "Anthropic + Free" matches nothing for a real
      // reason, and a generic "nothing matched" would leave people hunting.
      const why =
        tier === 'free' && provider && !isLibrary(provider)
          ? t('models.noFreeHere', { provider: PROVIDER_LABEL[provider] })
          : t('models.noMatch');
      results.innerHTML = sections.join('') + `<p class="hint">${escapeHtml(why)}</p>`;
      return;
    }

    if (builtin.length) {
      const heading =
        provider && provider !== 'all'
          ? t('models.onYourKey', { provider: PROVIDER_LABEL[provider] })
          : t('models.builtIn');
      sections.push(
        `<div class="model-group__label">${escapeHtml(heading)}</div>` +
          builtin.map((m) => card(m, true)).join(''),
      );
    }

    // Free and paid are split apart rather than interleaved: people are almost
    // always looking for one or the other, not a mix.
    if (tier === 'all') {
      const free = models.filter((m) => m.isFree);
      const paid = models.filter((m) => !m.isFree);
      if (free.length) {
        sections.push(
          `<div class="model-group__label">${escapeHtml(t('models.free'))} · ${free.length}</div>` + free.map((m) => card(m)).join(''),
        );
      }
      if (paid.length) {
        sections.push(
          `<div class="model-group__label">${escapeHtml(t('models.paid'))} · ${paid.length}</div>` + paid.map((m) => card(m)).join(''),
        );
      }
    } else if (models.length) {
      sections.push(
        `<div class="model-group__label">${escapeHtml(tier === 'free' ? t('models.free') : t('models.paid'))} · ${models.length}</div>` +
          models.map((m) => card(m)).join(''),
      );
    }

    results.innerHTML = sections.join('');

    for (const btn of results.querySelectorAll('[data-model]')) {
      btn.addEventListener('click', () => {
        dialog.close();
        onPick(btn.dataset.model);
      });
    }
  }

  // ── wiring ───────────────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    clearButton.hidden = !state.query;
    clearTimeout(debounce);
    debounce = setTimeout(load, 180);
  });

  clearButton.addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    clearButton.hidden = true;
    searchInput.focus();
    load();
  });

  for (const btn of document.querySelectorAll('#tier-filter [data-tier]')) {
    btn.addEventListener('click', () => {
      revealInStrip(btn);
      state.tier = btn.dataset.tier;
      for (const other of document.querySelectorAll('#tier-filter .seg__btn')) {
        other.classList.toggle('is-active', other === btn);
        // The class says which filter is on to the eye; aria-pressed is the
        // half a screen reader can hear. These are toggles in a group, not
        // tabs — the markup used to claim role="tablist" over children that
        // were never role="tab", which announced a pattern nothing implemented.
        other.setAttribute('aria-pressed', String(other === btn));
      }
      load();
    });
  }

  for (const btn of document.querySelectorAll('#provider-filter [data-provider]')) {
    btn.addEventListener('click', () => {
      // This row scrolls sideways on a phone, so the provider you just picked
      // must not end up off the edge of the strip that shows it is picked.
      revealInStrip(btn);
      state.provider = btn.dataset.provider;
      for (const other of document.querySelectorAll('#provider-filter .seg__btn')) {
        other.classList.toggle('is-active', other === btn);
        // The class says which filter is on to the eye; aria-pressed is the
        // half a screen reader can hear. These are toggles in a group, not
        // tabs — the markup used to claim role="tablist" over children that
        // were never role="tab", which announced a pattern nothing implemented.
        other.setAttribute('aria-pressed', String(other === btn));
      }
      // A vendor chip is meaningless outside the library, and leaving a stale
      // one selected would silently filter the next OpenRouter view.
      if (!isLibrary(state.provider)) state.family = 'all';
      load();
    });
  }

  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    load();
  });

  document.getElementById('refresh-library').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = t('models.refreshing');
    try {
      const status = await api.refreshModels();
      toast(t('models.libraryUpdated', { total: status.total.toLocaleString() }));
      await load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = t('models.refreshNow');
    }
  });

  return {
    open(currentModelId) {
      state.current = currentModelId;
      dialog.showModal();
      load();
      // Opening the on-screen keyboard the instant a sheet appears is jarring
      // on a phone, so only autofocus where there is a real keyboard.
      if (!matchMedia('(hover: none)').matches) searchInput.focus();
    },
  };
}
