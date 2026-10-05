# LOW rollup — repeated findings of one kind, listed in full

The ledger allows a single row for a `LOW` finding that repeats with the same nature across many
files, **on condition that every instance is listed here**. Nothing is dropped; only the place it
is written down changes.

Provenance: every entry below came from a read-only explorer agent with file:line and has **not**
been independently re-verified by the lead auditor. Confirm before acting.

---

## CODE-007 — duplicated client helpers

### `humanSize` — 5 copies
- `public/js/render.js:237`
- `public/js/viewer.js:95`
- `public/js/pages.js:44`
- `public/js/app.js:4045`
- `public/js/workspace.js:24-31` — genuinely differs (adds a bytes case)

The first four are identical.

### Relative-time formatting — 7 functions
- `public/js/pages.js:27-42` — `ago`, i18n-aware
- `public/js/project-page.js:39-52` — `ago`, byte-identical to the above, also i18n-aware
- `public/js/viewer.js:98-107` — `ago`, English only
- `public/js/workspace.js:33-40` — `ago`, takes ms rather than an ISO string
- `public/js/models.js:33-41` — `relative`, English only
- `public/js/app.js:3677-3683` — `relativeAgo`, English only
- `public/js/app.js:2893-2900` — `relativeWhen`, the future-facing variant

### Anchored popup menu — 4 implementations
- `public/js/menu.js:51-118` — dividers, capture-phase outside-click, closes on scroll
- `public/js/app.js:3833-3908` — static headers, node items, `menuitemradio` roles
- `public/js/app.js:637-737` — P/R/D letter shortcuts, inline arm-to-delete
- `public/js/pages.js:118-134` — no positioning at all, placed by CSS

All four re-implement viewport clamping (`menu.js:105-117`, `app.js:702-711`, `app.js:3883-3889`)
with three different pad values.

### Two-press delete confirmation — 5 copies
- `public/js/app.js:748-774` — 5000ms, and the only one that also resets on blur
- `public/js/pages.js:59-83` — 5000ms
- `public/js/workspace.js:43-64` — 5000ms
- `public/js/workflows.js:239-256` — 4000ms, inline
- `public/js/app.js:676-699` — inline inside `openRowMenu`

### `$ = (id) => document.getElementById(id)` — 6 copies
`public/js/app.js:100` · `viewer.js:93` · `workspace.js:22` · `pages.js:25` ·
`project-page.js:21` · `workflows.js:275`

### HTML escaping — 3 implementations, 2 of them unsafe in attribute position
- `public/js/markdown.js:9-16` — `escapeHtml`, correct (escapes quotes)
- `public/js/app.js:2071-2075` — `escapeText`, **does not escape quotes** → see SEC-001 (CRITICAL)
- `public/js/onboarding.js:46-50` — `escape`, **does not escape quotes**

Five client files already import the correct one.

### Byte-identical pairs
- `readAsBase64` — `public/js/project-page.js:55-62` and `public/js/app.js:4049-4056`, including
  the identical doc comment
- `counted()` — `public/js/pages.js:55-56` and `public/js/project-page.js:30`, each carrying its
  own three-line explanation of why it exists
- Token/context formatting — `public/js/models.js:17-22` `fmtContext` and
  `public/js/app.js:3724-3729` `fmtTokens`: identical arithmetic and identical rounding trick,
  differing only in the suffix word

### Plan/step list rendering — 2 copies
- `public/js/render.js:724-735` — in the transcript
- `public/js/app.js:4456-4467` — in the progress rail

Same markup, same done/active mapping, same `aria-current="step"`.

### `clip()` — 2 copies with different defaults
- `public/js/render.js:159` — max 60
- `public/js/workflows.js:41` — max 140

### Escape-key handling — 6 independent document-level listeners
`public/js/menu.js:38-44` (stops propagation) · `viewer.js:921-927` (stops propagation, guards on
an open dialog) · `screen.js:392-394` · `app.js:3891-3893` · `app.js:716` · `pages.js:139-141`

Behaviour is decided by registration order; nothing coordinates them.

### Deliberate duplication — **not** a defect
`public/js/lang-boot.js:11-15` re-implements `i18n.js:34-45`, and the comment explains why: a
module import would be deferred past first paint. Correct as written.

---

## CODE-008 — dead code

### Provably unreferenced (client)
- `public/index.html:823-832` — the entire artifacts dialog. Both its ids are referenced by no
  JavaScript in the repo; it was replaced by the artifacts shelf reached from `app.js:1219`.
  Includes a permanently visible "Loading…" hint.
- `public/js/i18n.js:53` — exported `has`, never imported anywhere
- `public/js/menu.js:21` — `closeMenu` is exported but all three importers take only `openMenu`
- `public/js/mirror.js:122` — `__testing` export with no test importing it
- `public/js/app.js:2683-2693` — an 11-line doc comment describing a function that no longer
  exists

### Exported but used only internally (wider surface than necessary)
- `public/js/render.js:164` `describeStep`, `:212` `stepFamily`

### Provably unreferenced (worker / scripts)
- `worker/screen.js:30` `isWatched`, `:31` `activeSource`, `:80` `unwatchedFor`
- `worker/browser.js:174` `browserMode`, `:185` `setBrowserMode`, `:262` `browserCapabilities`
- `worker/desktop.js:67` `desktopRunning`
- `worker/desktop.js:179` `stopDesktop` — **not merely dead: a process leak.** See AUTO-003.
- `worker/background.js:214` `__testing`
- `scripts/autostart.js:33` `TASK_NAME`, `:272` `autostartFor`, `:277` `__testing`
- `scripts/lib/workerLink.js:106` `parseEnvText`

### Server
- `server/store/pg.js:2334-2336` `deleteSharedModel` — zero callers anywhere in `server/`. It
  deletes from a globally shared table with no role check. Harmless today; a trap for whoever
  wires it up.

---

## Related observations that are not duplication or dead code

- `public/js/screen.js:172-178` — a `setInterval` running for the life of the page. The comment at
  `:169-171` records that a previous `unref()` "did nothing at all"; the interval is still
  unconditional and merely returns early.
- `scripts/lib/workerLink.js:177` — `isLocalServer` is a regex over the literal host, so
  `http://127.0.0.2` or an IPv4-mapped IPv6 loopback reads as remote.
- `server/research/confidence.js:28-36` — `registrableDomain` treats `a.co.uk` and `b.co.uk` as one
  domain. The comment argues this errs safe by under-counting independence, which is correct.


---

# Vòng v3 (2026-10-05)

Unlike the entries above, every instance here was re-read by the lead auditor before it was acted on.

## CODE-046 — comments that say something no longer true

| Where | Said | True now | State |
|---|---|---|---|
| `scripts/vendor-katex.js:8` | `test/markdown.test.mjs` checks the vendored version | the check is in `test/markdown-math.test.mjs:108-111` | fixed |
| `scripts/vendor-pdfjs.js:12-21` | pdfjs is loaded only by the project page; a server cannot have a canvas | the composer (`attachments.js`) and `shrink.js` load it too; `server/pdf.js` draws pages onto `@napi-rs/canvas` | fixed |
| `.github/workflows/ci.yml:30` | "the 429 pre-existing errors" | the ceiling is 315, in `.typecheck-baseline.json` | fixed, without a number that drifts |
| `test/capabilities.test.mjs:144` | the project "keeps nine" dependencies | `package.json` has 15 | fixed, without a number |
| `.claude/hooks/gate.js:116` | "the thirty-one suites" | `npm test` runs 48 | **CHỜ-CHỦ** — `.claude/hooks` is the owner's to change (AUDIT_RULES); a one-word comment edit, nothing else |

## CODE-039 — a doc block cut off from its code

The four the ledger named are fixed, and two more this branch had introduced (`public/js/chart.js`
`keyStep`, `server/vision.js` `lendableUnder`). The same pattern — two doc blocks back to back —
occurs 93 times across `public/js`, `server`, `worker` and `scripts`. Some are fine (a section
banner before a function's doc; `public/js/pages.js:795` is a comment before an inline cast). They
were not re-placed one by one: forty files of comment moves is the mass edit the rules rule out.
`test/features.test.mjs` holds the count at 93 as a ceiling that may only come down.
