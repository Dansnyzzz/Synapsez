// The boot watchdog: a page that cannot start says so, and offers to fetch the new files.
//
// Why it exists (2026-11-18): www.ephapse.net goes through Cloudflare, whose Browser
// Cache TTL had browsers keep /js/* and /css/* for four hours while index.html was always
// fresh. After the 1.33.1 deploy a returning browser ran the new page with the old app.js,
// which looked for a button the page no longer had, threw, and left both screens hidden:
// a black screen, until a hard reload. The real fix is a Cloudflare setting (see
// docs/domain-security.md); this is the net for anyone caught meanwhile, and after every
// deploy.
//
// A classic script, loaded right after lang-boot.js and before the app module, so it is
// listening before app.js runs and leans on nothing a stale cache may hold: no module, no
// i18n.js (its two languages are its own, picked from the <html lang> lang-boot.js has just
// set), no app.css (the notice styles itself through element style properties, which no
// ordinary stylesheet rule outranks), and no inline script, which `script-src 'self'`
// would refuse.
//
// "Started" is read from the page alone, never from a signal app.js sends, so an app.js
// that works, older or newer than this file, is never taken for one that did not. It never
// reloads on its own: only its button does, once per press.
(function () {
  // How long after DOMContentLoaded the page may take to show a screen. DOMContentLoaded
  // waits for the module graph, so a slow download is not counted, only a slow start.
  // The UI tests shorten it with `data-wait`, read once and kept between 0.5 and 60 s.
  const script = document.currentScript;
  const asked = script ? script.getAttribute('data-wait') : null;
  const wanted = asked === null || asked.trim() === '' ? NaN : Number(asked);
  const LIMIT_MS = Number.isFinite(wanted) ? Math.min(60000, Math.max(500, wanted)) : 12000;
  // After an uncaught error the app may still recover; it has this long to show a screen.
  const GRACE_MS = 1500;
  const FETCH_MS = 8000;
  const MAX_FILES = 300;
  // A press less than a minute ago, and the page failed again: say what else to do.
  const PRESSED = 'ephapse:boot-reload';
  const AGAIN_MS = 60000;
  // The two screens index.html keeps hidden until the app reveals one: #gate (signed out,
  // a first run's setup, a reset or confirmation link, sign-up with its consent tick) and
  // #app (signed in, the documents banner included).
  const SCREENS = ['gate', 'app'];
  // What Resource Timing calls the files worth fetching again. Chrome files a preloaded
  // module under "other" and one only imported under "script"; a stylesheet is "link".
  const KINDS = new Set(['script', 'link', 'css', 'other']);

  const WORDS = {
    vi: {
      title: 'Ephapse vừa được cập nhật',
      text: 'Trình duyệt của bạn còn giữ một phần bản cũ, nên trang chưa mở được.',
      button: 'Tải bản mới',
      hint: 'Hoặc nhấn Ctrl+Shift+R (Mac: ⌘+Shift+R).',
      again: 'Vẫn chưa được — hãy nhấn Ctrl+Shift+R (Mac: ⌘+Shift+R).',
    },
    en: {
      title: 'Ephapse was just updated',
      text: 'Your browser still holds part of the old version, so the page could not start.',
      button: 'Load the new version',
      hint: 'Or press Ctrl+Shift+R (Mac: ⌘+Shift+R).',
      again: 'Still not working — press Ctrl+Shift+R (Mac: ⌘+Shift+R).',
    },
  };

  // The app's own colours (app.css), copied: app.css may be the stale file. Every pair
  // here is 4.5:1 or more (the UI test measures it).
  const COLOURS = {
    dark: { page: '#0b0e11', card: '#151b21', line: '#232d36', text: '#e8eef4', dim: '#9aa8b5', accent: '#a78bfa', onAccent: '#120d24' },
    light: { page: '#f7f9fb', card: '#ffffff', line: '#d9e1e9', text: '#101820', dim: '#4a5866', accent: '#6d4ae0', onAccent: '#ffffff' },
  };
  const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

  let started = false;
  let notice = null;
  let graceTimer = null;
  let limitTimer = null;
  let observer = null;
  let reason = '';
  // Stops the notice following the colour scheme, once it is gone.
  let unpaint = null;

  const whenReady = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  const sameOrigin = (href) => {
    try {
      return new URL(href, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  };

  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;

  function hasStarted() {
    if (document.readyState === 'loading' || !document.body) return false;
    const screens = SCREENS.map((id) => document.getElementById(id));
    // Both gone means the app put its own failure page in their place (boot().catch in
    // app.js): it ran, and says what went wrong in words that name it. Not talked over.
    return screens.some(shown) || screens.every((el) => !el);
  }

  function pressedLately() {
    try {
      const at = Number(sessionStorage.getItem(PRESSED));
      return at > 0 && Date.now() - at < AGAIN_MS;
    } catch (e) {
      return false; // storage refused: the first hint, which is still true
    }
  }

  function forgetPress() {
    try {
      sessionStorage.removeItem(PRESSED);
    } catch (e) {
      /* storage refused: there was nothing kept to forget */
    }
  }

  function settle() {
    started = true;
    clearTimeout(graceTimer);
    clearTimeout(limitTimer);
    if (observer) observer.disconnect();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    // A late start: the notice was up, and the page is fine now.
    if (notice) notice.remove();
    notice = null;
    if (unpaint) unpaint();
    unpaint = null;
    forgetPress();
  }

  function look() {
    if (!started && hasStarted()) settle();
  }

  function decide() {
    if (started || notice) return;
    if (hasStarted()) settle();
    else show();
  }

  function failed(message) {
    if (started || notice || graceTimer) return;
    // For the one console line: never an address's query string.
    reason = String(message || '').replace(/\?\S*/g, '').slice(0, 300);
    graceTimer = setTimeout(() => whenReady(decide), GRACE_MS);
  }

  // Only this site's own scripts: a cross-origin one reports "Script error." with no file,
  // and Google's loader failing is not this page failing to start.
  function onError(event) {
    if (event && event.filename && sameOrigin(event.filename)) failed(event.message);
  }

  function onRejection(event) {
    const why = event ? event.reason : null;
    failed(why && why.message ? why.message : String(why));
  }

  // Everything this page loaded that a stale cache could be holding: its own script and
  // stylesheet tags first, so the cap can never drop them, then what Resource Timing saw,
  // which is where the module graph's imports are.
  function files() {
    const found = new Set();
    const add = (href, scriptsOnly) => {
      if (!href || found.size >= MAX_FILES) return;
      let url;
      try {
        url = new URL(href, location.href);
      } catch (e) {
        return;
      }
      if (url.origin !== location.origin) return;
      if (scriptsOnly && !/\.(js|css)$/i.test(url.pathname)) return;
      url.hash = '';
      found.add(url.href);
    };
    for (const el of Array.from(document.scripts)) add(el.src, false);
    for (const el of Array.from(document.querySelectorAll('link[rel~="stylesheet"], link[rel~="modulepreload"]'))) add(/** @type {HTMLLinkElement} */ (el).href, false);
    let entries = [];
    try {
      entries = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType('resource'));
    } catch (e) {
      /* no Resource Timing: the tags above are still fetched */
    }
    for (const entry of entries) if (KINDS.has(entry.initiatorType)) add(entry.name, true);
    return Array.from(found);
  }

  // The button: every file fetched past the cache, in parallel, eight seconds at most, then
  // one reload. A file that fails is left to the reload.
  function fetchNewFiles(button) {
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    button.style.cursor = 'progress';
    if (notice) notice.setAttribute('aria-busy', 'true');
    try {
      sessionStorage.setItem(PRESSED, String(Date.now()));
    } catch (e) {
      /* storage refused: a second failure shows the first hint again */
    }
    const stop = typeof AbortController === 'function' ? new AbortController() : null;
    const each = files().map((url) =>
      fetch(url, { cache: 'reload', credentials: 'same-origin', signal: stop ? stop.signal : undefined })
        // Read to the end: a body left unread can be cut off before the cache keeps it.
        .then((res) => res.arrayBuffer())
        .catch(() => null),
    );
    let timer = null;
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, FETCH_MS);
    });
    Promise.race([Promise.all(each), late]).then(() => {
      clearTimeout(timer);
      if (stop) stop.abort();
      // The app came up while the files were on their way: the page works, and a reload
      // now would take it away from under the person.
      if (!started) location.reload();
    });
  }

  function isLight() {
    const chosen = document.documentElement.getAttribute('data-theme');
    if (chosen === 'light' || chosen === 'dark') return chosen === 'light';
    return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  // `all` first, so nothing app.css says about a div, a heading or a button reaches these:
  // the root starts from the initial values, its children from what they inherit from it.
  function make(tag, reset, styles) {
    const el = document.createElement(tag);
    el.style.setProperty('all', reset);
    Object.assign(el.style, styles);
    return el;
  }

  function show() {
    if (notice || started || !document.body) return;
    const lang = /^vi\b/i.test(document.documentElement.lang || '') ? 'vi' : 'en';
    const words = WORDS[lang];
    console.warn(reason ? `Ephapse could not start: ${reason}` : 'Ephapse could not start in time.');

    const box = make('div', 'initial', {
      display: 'flex',
      position: 'fixed',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      padding: '24px 16px',
      overflowY: 'auto',
      fontFamily: FONT,
      fontSize: '16px',
      lineHeight: '1.5',
      textAlign: 'center',
      overflowWrap: 'break-word',
    });
    box.id = 'boot-watch';
    box.lang = lang;
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'boot-watch-title');
    box.setAttribute('aria-describedby', 'boot-watch-text boot-watch-hint');

    // `margin: auto` rather than centring the column: a phone held sideways with large
    // text can still scroll to the top of the card.
    const card = make('div', 'unset', {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '420px',
      margin: 'auto',
      padding: '28px 24px 24px',
      borderRadius: '16px',
      borderWidth: '1px',
      borderStyle: 'solid',
    });
    const logo = make('img', 'unset', { display: 'block', width: '48px', height: '48px', margin: '0 auto 16px', borderRadius: '12px' });
    logo.src = '/logo.png';
    logo.alt = '';
    const title = make('h1', 'unset', { display: 'block', margin: '0 0 8px', fontSize: '20px', lineHeight: '1.3', fontWeight: '600' });
    title.id = 'boot-watch-title';
    title.textContent = words.title;
    const text = make('p', 'unset', { display: 'block', margin: '0', fontSize: '15px' });
    text.id = 'boot-watch-text';
    text.textContent = words.text;
    const button = make('button', 'unset', {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      minHeight: '48px',
      margin: '22px 0 0',
      padding: '12px 16px',
      borderRadius: '12px',
      fontSize: '16px',
      fontWeight: '600',
      lineHeight: '1.3',
      cursor: 'pointer',
    });
    button.type = 'button';
    button.id = 'boot-watch-reload';
    button.textContent = words.button;
    const hint = make('p', 'unset', { display: 'block', margin: '14px 0 0', fontSize: '13.5px' });
    hint.id = 'boot-watch-hint';
    hint.textContent = pressedLately() ? words.again : words.hint;

    // Colours by scheme, and again if the scheme changes while the notice is up. The ring
    // is drawn by hand: `all` took the browser's own away, and the button must show focus.
    const paint = () => {
      const c = isLight() ? COLOURS.light : COLOURS.dark;
      box.style.background = c.page;
      box.style.color = c.text;
      box.style.setProperty('color-scheme', c === COLOURS.light ? 'light' : 'dark');
      card.style.background = c.card;
      card.style.borderColor = c.line;
      hint.style.color = c.dim;
      button.style.background = c.accent;
      button.style.color = c.onAccent;
      button.style.outlineColor = c.accent;
    };
    paint();
    const scheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    if (scheme && scheme.addEventListener) {
      scheme.addEventListener('change', paint);
      unpaint = () => scheme.removeEventListener('change', paint);
    }
    button.style.outlineOffset = '3px';
    button.addEventListener('focus', () => {
      button.style.outlineStyle = 'solid';
      button.style.outlineWidth = '2px';
    });
    button.addEventListener('blur', () => {
      button.style.outlineStyle = 'none';
    });
    button.addEventListener('click', () => fetchNewFiles(button));

    card.append(logo, title, text, button, hint);
    box.append(card);
    notice = box;
    document.body.append(box);
    button.focus();
  }

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  whenReady(() => {
    if (started) return;
    if (hasStarted()) {
      settle();
      return;
    }
    // Every reveal is an attribute change on a screen, or the body's children replaced.
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(look);
      for (const id of SCREENS) {
        const el = document.getElementById(id);
        if (el) observer.observe(el, { attributes: true, attributeFilter: ['hidden', 'class'] });
      }
      observer.observe(document.body, { childList: true });
    }
    limitTimer = setTimeout(decide, LIMIT_MS);
  });
})();
