# A page that cannot start says so (1.33.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the app cannot start, typically because a browser mixes the new `index.html` with older cached JS after a deploy, the person sees a clear notice with a button that fetches the new files and reloads, instead of a black screen.

**Architecture:** A small classic script, `public/js/boot-watch.js`, loads right after `lang-boot.js` and before the app module. It decides "started" from the DOM alone (a visible top-level screen), so it works with any version of the app. It shows a self-contained notice:
- at once, after an uncaught same-origin script error before start;
- otherwise, after a time limit.

The button re-fetches every same-origin script and stylesheet the page loaded, with `cache: 'reload'`, then reloads. It never reloads by itself.

**Tech Stack:** a plain browser script (no module, no build), the Playwright UI tests in `test/ui.test.mjs`, and the hand-rolled harness.

## Global Constraints

- **The cause, measured live on 2026-11-18:**
  - www.ephapse.net goes through Cloudflare. HTML is served `max-age=0`, but `/js/*` and `/css/*` come back `public, max-age=14400, must-revalidate`. That is Cloudflare's Browser Cache TTL overriding Vercel's own `max-age=0`.
  - After the 1.33.1 deploy, the owner's browser ran the new HTML with the old `app.js`. The old code looked for the removed "What is Ephapse?" button, threw, and left both `#gate` and `#app` hidden: a black screen.
  - A hard reload fixed it.
  - The real fix is the owner's Cloudflare setting ("Respect Existing Headers", or DNS only). This release is the safety net for any visitor in the meantime, and for every future deploy.
- **CSP stays as it is.**
  - `script-src 'self' https://apis.google.com`, so the watchdog is an external file and puts no inline script anywhere.
  - `style-src 'self' 'unsafe-inline'`: the notice styles itself through element `style` properties, so a stale `app.css` cannot break it.
- **It must never false-alarm a working app**, whatever the app's version.
  - "Started" means any top-level screen the app shows has become visible: `#gate`, `#app`, and any other boot screen in `index.html` (find them all).
  - If the app becomes visible after the notice is shown, the notice removes itself.
- **It never reloads on its own**, and never loops. A `sessionStorage` note marks that the button was pressed less than 60 s ago. If start fails again after that, the notice says to press Ctrl+Shift+R (Mac: ⌘+Shift+R) and still offers the button. Every storage access is wrapped in try/catch.
- **Words: Vietnamese and English**, picked from `document.documentElement.lang`, which `lang-boot.js` sets first.
  - **vi:**
    - title "Ephapse vừa được cập nhật";
    - text "Trình duyệt của bạn còn giữ một phần bản cũ, nên trang chưa mở được.";
    - button "Tải bản mới";
    - hint "Hoặc nhấn Ctrl+Shift+R (Mac: ⌘+Shift+R)."
  - **en:**
    - title "Ephapse was just updated";
    - text "Your browser still holds part of the old version, so the page could not start.";
    - button "Load the new version";
    - hint "Or press Ctrl+Shift+R (Mac: ⌘+Shift+R)."
  - **After a second failure:** vi "Vẫn chưa được — hãy nhấn Ctrl+Shift+R (Mac: ⌘+Shift+R)." / en "Still not working — press Ctrl+Shift+R (Mac: ⌘+Shift+R)."
- **Accessible.**
  - `role="alertdialog"` with `aria-labelledby` and `aria-describedby`; focus moves to the button.
  - Contrast ≥ 4.5:1 in light and dark (`prefers-color-scheme`), readable at 360 px, touch target ≥ 44 px.
- **Nothing sensitive is logged.** At most one `console.warn` that names the error message, never URLs with query strings.
- **Repo rules:**
  - Never read, edit or stage `.env` or `.env.example`. No `git stash`. Stage by path.
  - CODE-039: the doc-block count stays at or under 93; prefer `//` comments.
  - LF in git.
  - The product is Ephapse.
  - Do not run `npm run gate`, the full `npm test` or `test/system.test.mjs`. The controller runs them. `node test/ui.test.mjs` is allowed.
- **Release 1.33.2:**
  - update `package.json`, `CHANGELOG.md` and `public/changelog.json` (vi + en);
  - the CHANGELOG owner step: Cloudflare → Caching → Configuration → Browser Cache TTL → "Respect Existing Headers", then Purge Everything. Or set the DNS records to DNS only;
  - add the same to the doc that describes the domain setup (find it: `docs/domain-security.md` or the deploy doc).

---

### Task 1: The boot watchdog

**Files:**
- Create: `public/js/boot-watch.js`.
- Modify: `public/index.html`. Add `<script src="/js/boot-watch.js"></script>` right after the `lang-boot.js` tag (~line 37).
- Modify: `package.json`, `CHANGELOG.md`, `public/changelog.json`, and the domain/deploy doc.
- Test: `test/ui.test.mjs` (a new scenario), plus `test/features.test.mjs` if it pins release facts or the script list.

**Behaviour:**
- **Start** is checked on DOMContentLoaded and on every attribute change of the top-level screens (a MutationObserver on `hidden`/`class`), and stops once started.
- **Error path:** a `window` `error` event whose `filename` is same-origin, or an `unhandledrejection`, before start. After a 1.5 s grace, if still not started, show the notice.
- **Time limit:** 12 s after DOMContentLoaded. The UI test may shorten it through a `data-wait` attribute on the script tag (read once; clamp it to 500–60000 ms).
- **The button:**
  - collect same-origin URLs from `performance.getEntriesByType('resource')` whose `initiatorType` is script, link, css or other and whose path ends `.js` or `.css`, plus `document.scripts` and `link[rel=stylesheet]`. Deduplicate, cap at 300;
  - `fetch(url, { cache: 'reload', credentials: 'same-origin' })` all of them in parallel, with an 8 s overall timeout. Ignore failures;
  - then `location.reload()`.

- [ ] **Step 1:** Write the UI scenario first and watch it fail.
  - **(a) Normal boot:** with `data-wait="800"`, wait 1.5 s. There is no notice and the gate shows.
  - **(b) Broken boot:** `page.route('**/js/app.js')` serves a module that throws at top level.
    - The notice appears in the page's language. It is an alertdialog, focus is on the button, and there is no black screen.
    - Pressing the button sends the same-origin `.js` requests again with a `cache-control: no-cache` request header (the browser adds it for `cache: 'reload'`; record it with `page.on('request')`) and reloads the page.
  - **(c) A late start:** route `app.js` to delay ~1.2 s with `data-wait="500"`. The notice shows, then removes itself when the gate appears.
  - **(d) A second failure within 60 s:** the hint becomes the "Still not working" sentence.
  - Also a features check: `boot-watch.js` sits before `app.js` in `index.html` and holds no `eval`, `innerHTML` or `document.write`.
- [ ] **Step 2:** Build `boot-watch.js` and pass. Take screenshots of the notice (vi/en, light/dark, 360 and 1280 px) into the scratchpad and look at them.
- [ ] **Step 3:** Release notes 1.33.2 and the owner's Cloudflare step. Run the features, i18n and markdown tests, then lint and typecheck.
- [ ] **Step 4:** Commit by path: `fix(boot): a page that cannot start says so and fetches the new files, never a black screen`.
