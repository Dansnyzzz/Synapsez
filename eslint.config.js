import js from '@eslint/js';

/**
 * Lint rules, kept deliberately small.
 *
 * There was no config at all — but there *was* an `eslint-disable` comment in
 * server/app.js, which is a nice illustration of how a linter nobody runs
 * quietly becomes decoration.
 *
 * So this is tuned to catch the things that actually shipped in this codebase:
 * an unused import left behind by a refactor, a variable used before it was
 * defined, a name that no longer exists. Style is not policed — the code has a
 * voice, and a formatter arguing with it would be a net loss.
 *
 * Globals are listed by hand rather than pulled from the `globals` package: two
 * short lists are easier to audit than a dependency, and this project has been
 * deliberate about not adding those.
 */

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  Intl: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

const BROWSER_GLOBALS = {
  document: 'readonly',
  window: 'readonly',
  // Two tabs on one conversation talk to each other over this rather than over
  // the network — same-origin, in-browser, no requests. See public/js/mirror.js.
  BroadcastChannel: 'readonly',
  location: 'readonly',
  history: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  // Which computer this browser is on is a fact about the tab, not the account:
  // a laptop's answer must never be restored on a desktop from a synced profile.
  sessionStorage: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  Uint8Array: 'readonly',
  EventSource: 'readonly',
  // The cloud browser's screen and a person's gestures, straight to the machine. See public/js/screen.js.
  WebSocket: 'readonly',
  performance: 'readonly',
  TextDecoderStream: 'readonly',
  AbortController: 'readonly',
  ResizeObserver: 'readonly',
  Intl: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  matchMedia: 'readonly',
  requestAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  getComputedStyle: 'readonly',
  innerHeight: 'readonly',
  innerWidth: 'readonly',
  HTMLElement: 'readonly',
  Element: 'readonly',
  crypto: 'readonly',
  FileReader: 'readonly',
  File: 'readonly',
  Event: 'readonly',
  PointerEvent: 'readonly',
  // Rich copy: several renderings of one thing on the clipboard at once, so
  // pasting into Word keeps the formatting.
  ClipboardItem: 'readonly',
  Image: 'readonly',
};

export default [
  // public/vendor holds third-party builds copied in by scripts/vendor-*.js.
  { ignores: ['node_modules/**', 'data/**', '.vercel/**', 'public/vendor/**'] },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      // An argument you deliberately ignore is fine; a leftover import is not.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // `catch {}` with a comment inside is a choice this codebase makes often
      // and explains every time.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      'require-atomic-updates': 'off',
    },
  },

  {
    files: ['public/**/*.js'],
    languageOptions: { globals: BROWSER_GLOBALS },
  },

  {
    // The worker runs in Node, but parts of it are serialised into a browser
    // page by `page.evaluate` and reference the DOM from there.
    files: ['worker/**/*.js', 'test/**/*.mjs'],
    languageOptions: { globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS } },
  },
];
