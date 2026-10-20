# Getting-started guide with videos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 5-step guide with a 6-step guide whose every sentence is sourced, each step illustrated by a short video recorded automatically from the real app in vi and en.

**Architecture:** `public/js/onboarding.js` renders six steps around a shared media slot (`<video>` + poster + Pause/Play). Copy lives in the locales. `scripts/record-onboarding.mjs` drives the real app in headless Chrome (Playwright `recordVideo`), trims and compresses each clip with Playwright's bundled ffmpeg (VP8/WebM), and writes `public/onboarding/{vi,en}/step-N.{webm,jpg}`. Tests pin each fact to the code it describes.

**Tech Stack:** vanilla browser JS, Playwright-core 1.62 (`recordVideo`), Playwright's ffmpeg-1011 (libvpx VP8 encoder, webm muxer), the repo's hand-rolled test harness.

Spec: `docs/superpowers/specs/2026-10-20-onboarding-videos-design.md`.

## Global Constraints

- Six steps, in this order: what it does · API key · model and free limits · cloud computer · how free the assistant is · first task.
- No device-pairing step; never "on your computer" — the cloud computer does that work.
- Facts exactly as the spec's table: OpenRouter free 20/min, 50/day, 1,000/day after ≥10 credits bought; extra keys/accounts do not raise it; several keys per provider tried in order; Auto when a model fails on every key; providers Anthropic, OpenAI, Google Gemini, OpenRouter, OrcaRouter; cloud computer 60 actions/day per account, 400/day per app (defaults); five policy levels; a suggestion goes into the composer, it is not sent.
- Video: muted, loop, only the current step plays, a Pause/Play button always present, no autoplay under `prefers-reduced-motion`, poster shown first, text complete without the video.
- Clips ≤ 600KB each, ≤ 8MB in total; paths `public/onboarding/{vi,en}/step-{1..6}.{webm,jpg}` (deterministic — no manifest).
- Every string in both `en.js` and `vi.js`; Vietnamese is the primary copy.

---

### Task 1: The copy, and the facts pinned to the code

**Files:** `public/js/locales/vi.js`, `public/js/locales/en.js` (replace every `onb.*` key), `test/features.test.mjs`, `test/i18n.test.mjs`.

**Produces:** keys `onb.{1..6}.title` and the per-step keys used by Task 2: `onb.1.body, onb.1.a, onb.1.b, onb.1.c, onb.1.d` · `onb.2.body, onb.2.recommend, onb.2.many, onb.2.open, onb.2.done, onb.2.pending, onb.2.safety` · `onb.3.free, onb.3.paid, onb.3.limits, onb.3.keys, onb.3.fallback, onb.3.gemini, onb.3.change, onb.3.note` · `onb.4.body, onb.4.a, onb.4.b, onb.4.c, onb.4.limit` · `onb.5.body, onb.5.note` (the five levels come from `policy.*.label` / `policy.*.hint`) · `onb.6.body, onb.6.try1..6, onb.6.note, onb.6.finish` · `onb.video.pause, onb.video.play, onb.video.label`.

- [ ] Write the failing tests: `i18n.test.mjs` step loop to 6; `features.test.mjs` section "the getting-started guide says only what is true":
  - every provider label in `catalog.js` appears in `onb.2.many` (vi and en), and no other provider name does;
  - `onb.4.limit` contains `cloudBudgets({}).perAccount` and `.total`;
  - `onb.3.limits` contains `20`, `50`, `1.000`/`1,000`;
  - no `onb.*` string (vi or en) says "máy tính của bạn"/"your computer" or "chạy luôn"/"runs straight";
  - `onb.6.try1..6` are six distinct strings.
- [ ] Run, see them fail; write the copy; run, see them pass; commit.

### Task 2: The guide itself

**Files:** `public/js/onboarding.js` (rewrite), `public/index.html` (dialog markup: stepper + media slot), `public/css/app.css` (replace `.onb*`), `public/js/app.js` (`createOnboarding` call: `POLICIES` passed in).

**Consumes:** Task 1 keys; `POLICY_LABEL`, `POLICY_HINT`, `POLICIES` from app.js (passed as `policies: () => POLICIES.map((p) => ({ label: POLICY_LABEL(p), hint: POLICY_HINT(p) }))`).

**Produces:** `#onboarding` with `#onb-steps` (six `li.onb__dot`, `.is-current`, `.is-done`), `#onb-media` (`video.onb__video` + `button#onb-play` toggling `aria-pressed`), `#onb-body`; `.onb__try` buttons (six); `#onb-keys`, `#onb-model` as before.

Behaviour: `media(step)` sets `poster=/onboarding/{lang}/step-N.jpg`, `src=/onboarding/{lang}/step-N.webm`, `muted`, `loop`, `playsInline`, `preload="metadata"`; plays unless reduced motion or the person paused; a failed load keeps the poster; closing the dialog pauses; ←/→ move between steps when focus is not in a text box. Step 5 lists `policies()` (all five). Step 6's buttons call `onTryPrompt` and close.

- [ ] Update `test/ui.test.mjs` onboarding sections first (6 steps, five levels match `#policy-menu` items, six suggestions into the composer, `#onb-play` toggles and the video pauses, reduced motion does not autoplay); run them in the slice harness, see them fail; implement; pass; commit.

### Task 3: Recording the videos

**Files:** `scripts/record-onboarding.mjs` (new), `package.json` (`"onboarding:record": "node scripts/record-onboarding.mjs"`), `public/onboarding/{vi,en}/step-{1..6}.{webm,jpg}` (generated), `test/features.test.mjs` (assets exist, within budget).

Scenes (each in its own browser context with `recordVideo: { dir, size: { width: 1280, height: 800 } }`, a demo account signed in, language set through `localStorage['ai-remote-language']`, the guide dismissed by `prefs.onboarded`):

1. A user message and an answer drawn with `userMessage` / `assistantMessage`: a web-search card, a commands card with a Python run and a figure, a Word file card.
2. Settings → Providers: type a key into `[data-key="openrouter"]`, press `[data-save-key="openrouter"]`, then add a second key — the list shows "1, 2 · tried in order".
3. The model chip → the model browser, Auto highlighted.
4. A `sandbox_run` commands card (Python, a chart) and a `cloud_browser` run with step screenshots.
5. `#policy-chip` → `#policy-menu`, the pointer passes over all five levels.
6. Type a suggestion into `#input`, then the answer drawn as in scene 1.

A fake pointer (`div#rec-cursor`, CSS transition) moves to each target before a real `click`. Each clip: the lead-in before the scene's first frame is cut with ffmpeg `-ss`, re-encoded `-c:v libvpx -b:v 450k -crf 28 -an`; the poster is `page.screenshot({ type: 'jpeg', quality: 78 })` at the scene's key moment.

- [ ] Write the asset test (fails: no files); write the script; run `npm run onboarding:record`; look at every poster and a few frames; the asset test passes; commit the script and the clips.

### Task 4: Verify and ship

- [ ] `npm run gate` green; `npm run test:ui` green; screenshots of the guide at 1280 and 390, light and dark, looked at.
- [ ] Merge `--no-ff` to `main`, push; update memory (and correct the Neon cause: the cron pinger, not a worker).
