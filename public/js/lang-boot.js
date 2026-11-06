/**
 * Set the document language before anything else runs.
 *
 * `i18n.js` already does this — but it is an ES module at the bottom of a graph
 * eleven imports deep, so it runs well after the body has been parsed. First
 * paint is exactly when somebody using a screen reader starts reading, and until
 * then the document claimed `lang="en"` over Vietnamese text. A screen reader
 * acts on that: it applies English pronunciation rules to Vietnamese words,
 * which lands closer to unintelligible than to accented.
 *
 * Deliberately not a module and deliberately duplicating a few lines of
 * `initialLanguage`. A module would be deferred, which puts it back after the
 * parse; importing the real thing would pull the whole locale graph into the
 * critical path to set one attribute. The duplication is four lines and the two
 * copies agree on one storage key, which is the part that has to match.
 */
(function () {
  const KEY = 'ai-remote-language';
  const SUPPORTED = { en: true, vi: true };

  function preferred() {
    const tags = navigator.languages || [navigator.language || 'en'];
    for (let i = 0; i < tags.length; i += 1) {
      const base = String(tags[i]).toLowerCase().split('-')[0];
      if (SUPPORTED[base]) return base;
    }
    return 'en';
  }

  try {
    const saved = localStorage.getItem(KEY);
    document.documentElement.lang = SUPPORTED[saved] ? saved : preferred();
  } catch (e) {
    // Private mode, or storage disabled outright. The browser's own preference
    // is still readable, and if even that fails the markup's `lang` stands —
    // a page that refuses to render over the language of its labels would be a
    // far worse bug than the one this exists to fix.
    try {
      document.documentElement.lang = preferred();
    } catch (ignored) {
      /* nothing left to try */
    }
  }
})();

/**
 * The theme this browser last wore, before first paint: only the attribute that gives
 * the app its panes. Without this, a scene flashed the plain page on every reload,
 * until the modules behind themes-panel.js had loaded. Light or dark is the person's
 * own setting, whichever scene is up (owner, 2026-11-06).
 */
(function () {
  try {
    const scene = localStorage.getItem('synapsez:scene');
    if (scene) document.documentElement.dataset.scene = scene;
  } catch (e) {
    /* storage refused: the plain page until the app has asked the server */
  }
})();
