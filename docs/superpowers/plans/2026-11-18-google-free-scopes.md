# Google on free verification only (1.33.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ephapse asks Google only for scopes that pass Google's free review: Gmail becomes send-only (`gmail.send`) and Drive becomes `drive.file`, with the Google Picker letting a person choose the Drive files Ephapse may open.

**Architecture:** `server/google.js` changes the two products' scopes and treats the old wider scopes as still covering the new ones, so connections made before the change keep working until they expire. The Gmail tool keeps only `send`. The whole-Drive search route goes away, and a new route mints a short-lived token that can do nothing but `drive.file`, which the browser hands to the Google Picker. Picked files go through the existing `POST /api/connectors/google/drive/:fileId/attach`.

**Tech Stack:** Node/Express server, plain ES modules in `public/js`, hand-rolled test harness (`test/*.test.mjs`), Playwright UI tests (`test/ui.test.mjs`).

## Global Constraints

- Owner decision (2026-11-18): "full free nhé, còn nếu tốn tiền thì làm như bạn gợi ý". So Ephapse requests no Google *restricted* scope at all. Restricted scopes need a paid yearly CASA assessment.
- Final scope per product (exact strings):
  - gmail → `https://www.googleapis.com/auth/gmail.send`
  - drive → `https://www.googleapis.com/auth/drive.file`
  - All others are unchanged: `calendar`, `documents`, `spreadsheets`, `forms.body` + `forms.responses.readonly`, `tasks`, `contacts.readonly`. Base stays `openid email profile`.
- Google's classes, from Google's own pages, checked 2026-11-18:
  - `gmail.send` is sensitive.
  - `drive.file` is non-sensitive.
  - `gmail.modify`, `gmail.readonly`, `gmail.compose`, `gmail.metadata`, `auth/drive`, `drive.readonly` and `drive.metadata` are restricted. None of them may be requested.
- Older grants still count: a connection whose granted scope string holds `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.compose` or `https://mail.google.com/` counts as granting `gmail.send`. One holding `https://www.googleapis.com/auth/drive` counts as granting `drive.file`.
- Gmail tool actions: exactly `['send']`.
  - No `reply_to_id`: replying needs to read the original, which is restricted.
  - No draft: drafting needs `gmail.compose`, which is restricted.
  - Any other action gets a clear refusal that says Ephapse can only send mail.
- Picker environment variables (exact names): `GOOGLE_PICKER_API_KEY` (a browser key, public by design, restricted by the owner in Google Cloud) and `GOOGLE_PROJECT_NUMBER` (the Picker's app id).
- Picker token: minted from the stored refresh token with `scope=https://www.googleapis.com/auth/drive.file` in the refresh request.
  - It is handed to the browser only if Google's returned `scope` holds `drive.file` and nothing besides `drive.file`, `openid`, `email`, `profile`, `https://www.googleapis.com/auth/userinfo.email` and `https://www.googleapis.com/auth/userinfo.profile`.
  - Otherwise the route refuses, and no token leaves the server.
  - It is never written over the stored access token.
  - The response carries `Cache-Control: no-store`.
- The Content-Security-Policy additions are `https://apis.google.com` in `script-src` and `https://docs.google.com` in `frame-src`.
  - Add any further Google origin only if a real Chrome run shows it is blocked.
  - The CSP is changed in both `server/securityHeaders.js` and `vercel.json`, and the two stay identical.
  - `Referrer-Policy: no-referrer` and `Cross-Origin-Opener-Policy: same-origin` stay as they are.
- Release: **1.33.1** (`package.json`, `CHANGELOG.md`, `public/changelog.json` in vi and en). The diagrams branch keeps 1.34.0.
- Repo rules:
  - Never read, edit or stage `.env` or `.env.example`; document new variables in `docs/google.md`.
  - Never use `git stash`.
  - Stage by explicit path. Never stage `.claude/AUDIT_RULES.md`, `.claude/audit-annex/`, `.vscode/` or `Exa Deep Research-3.4.1-v1/`.
  - Every `new Error('…')` text and every person-visible server sentence has a `server/i18n/vi.js` entry.
  - CODE-039: the doc-block count is at its ceiling (93). Never put two `/** */` blocks back to back, and never put a banner comment straight above a `/** */`. Prefer `//` comments for new notes.
  - Files are LF in git. Never leave mixed line endings or a lone CR; check with Node after editing.
  - The product's name is Ephapse; the scan test fails on the old name.
  - Do not run `npm run gate`, the full `npm test`, or `test/system.test.mjs`, which uses the system clipboard while another branch is testing. Run the targeted test files only; the controller runs the full gate.

---

### Task 1: Server — scopes, send-only Gmail, Drive-only Picker token, CSP

**Files:**
- Modify: `server/google.js`
  - `GOOGLE_PRODUCTS` (lines 28-39).
  - `grantedProducts`, so the older wider scopes count.
  - Add an exported `pickerToken(userId)` beside `accessToken`.
- Modify: `server/tools/google.js`
  - `gmailTool` (from line 133) keeps `send` only and drops reply/draft/search/read/modify/trash/labels and any helper left unused.
  - Remove `listDriveFiles` (line 743) if nothing else uses it.
- Modify: `server/tools/definitions.js`
  - `gmail` tool (~line 2438): `action` enum `['send']`, with parameters and description to match.
  - `google_drive` (~line 2502): the description says it sees only files the person picked in Ephapse's Drive picker, or files Ephapse created or uploaded. Its search finds only those.
- Modify: `server/routes/connectors.js`
  - Remove `GET /connectors/google/drive` (line ~223).
  - Add `GET /connectors/google/picker`.
- Modify: `server/securityHeaders.js`, `vercel.json`: the CSP additions above.
- Modify: `server/i18n/vi.js`: entries for every new error or sentence.
- Modify: anything else that names the removed Gmail actions or the old scopes. Grep for `gmail.modify`, `auth/drive'`, `driveFiles`, `listDriveFiles`, `'search','read','send'`, and the eval cases in `test/eval/`.
- Test: `test/google.test.mjs`, the tool tests that cover Gmail and Drive, the CSP header test, and `test/features.test.mjs` / `test/ui.test.mjs` fixture scope strings that only need the new names.

**Interfaces:**
- Produces, for Task 2:
  - `GET /api/connectors/google/picker`, signed in, `rateLimit('drive', …)`, the same `withDrive` check.
    - 200: `{ token: string, apiKey: string, appId: string, expiresAt: number }`.
    - 503: `{ error, code: 'picker_not_set_up' }` when either environment variable is missing.
    - 400: `{ error }` for a Google refusal or a too-wide token. Every error is translated with `translateMessage(…, languageOf(req))`.
  - `POST /api/connectors/google/drive/:fileId/attach` is unchanged.

- [ ] **Step 1: Failing tests first**
  - The scope string built for ticked products holds `gmail.send` and `drive.file`, and never `gmail.modify` or `auth/drive"`.
  - `grantedProducts` counts `gmail.modify` → gmail and `auth/drive` → drive.
  - The Gmail tool's definition offers exactly `['send']`. Calling it with `action: 'search'` returns the send-only refusal.
  - Picker route:
    - (a) Missing environment variables give 503 with `code: 'picker_not_set_up'`.
    - (b) The token request carries `scope=https://www.googleapis.com/auth/drive.file`. A response with scope `https://www.googleapis.com/auth/drive.file openid` gives 200 and `Cache-Control: no-store`, and the stored access token is unchanged.
    - (c) A response whose scope also holds `https://www.googleapis.com/auth/calendar` gives 400, and the token string appears nowhere in the response body.
    - (d) No Drive grant gives the existing 400.
  - `GET /api/connectors/google/drive` is gone (404).
  - The CSP from `securityHeaders.js` equals the one in `vercel.json` and contains both new origins.
  - Use the existing fetch-stubbing pattern in `test/google.test.mjs`.
- [ ] **Step 2:** Run the tests and watch them fail for the stated reasons.
- [ ] **Step 3:** Implement. Keep the surviving send path exactly as it is today, including subject/attachment handling and the encoded header.
- [ ] **Step 4:** Run the targeted test files until green, then `npm run lint` and `npm run typecheck`. The typecheck ceiling is 269 and the baseline 255; do not raise it.
- [ ] **Step 5:** Commit, staging by path: `feat(google): send-only Gmail, drive.file, a Drive-only token for the Picker`.

### Task 2: Browser Picker, copy, owner guide, release 1.33.1

**Files:**
- Create: `public/js/google-picker.js`, a single exported `openDrivePicker({ language, onPicked, onError })`.
  - Loads `https://apis.google.com/js/api.js` once, via a created `<script>` element; no inline script.
  - Runs `gapi.load('picker', …)`, then fetches `/api/connectors/google/picker` through `public/js/api.js` (add `api.drivePicker()`; remove `driveFiles`).
  - Builds the Picker with:
    - `new google.picker.DocsView(google.picker.ViewId.DOCS)` in `google.picker.DocsViewMode.LIST`, with `setSelectFolderEnabled(false)`;
    - `enableFeature(google.picker.Feature.MULTISELECT_ENABLED)`;
    - `setOAuthToken`, `setDeveloperKey`, `setAppId`;
    - `setLocale('vi' | 'en')`, `setOrigin(location.origin)`, and a callback.
  - On `google.picker.Action.PICKED`, it attaches each file through the existing `api.attachDriveFile(id)` and hands the attachments to `onPicked`. On `CANCEL` it does nothing.
  - On 503 `picker_not_set_up`, `onError` shows a translated note.
- Modify: `public/js/plus-menu.js`
  - The Google Drive item (line ~298) opens the Picker straight away, with no sub-panel and no search box.
  - Remove `driveSearch` and its strings and CSS if they become unused. Keep the existing order and icon, and keep the menu keyboard-reachable.
  - Picked files land exactly where the old Drive search put them: the same attachment chips and the same `DRIVE_ORIGIN` flow.
- Modify: i18n strings (vi + en) for the Drive item and the notes.
- Modify: `public/js/connector-catalog.js` and every page that describes what the Gmail or Drive connection can do: Gmail is "send mail only"; Drive covers "files you pick in Ephapse or that Ephapse creates".
- Modify: `public/privacy.html`, both the vi (line ~87) and en (line ~204) lists.
  - `gmail.send`: send mail you ask for; Ephapse cannot read, search or change mail.
  - `drive.file`: only files you pick or Ephapse creates.
  - Narrowing what is collected needs no re-consent. Follow the repo's existing rule for whether a text change bumps the policy version, and report what you did.
- Modify: `docs/google.md`, the owner's guide, in English like the rest of the file:
  - a scopes table (scope, Google class, what it is used for);
  - the exact list to paste in Google Auth Platform → Data Access → "Manually add scopes":
    - `openid`
    - `https://www.googleapis.com/auth/userinfo.email`
    - `https://www.googleapis.com/auth/userinfo.profile`
    - `https://www.googleapis.com/auth/drive.file`
    - `https://www.googleapis.com/auth/gmail.send`
    - `https://www.googleapis.com/auth/calendar`
    - `https://www.googleapis.com/auth/documents`
    - `https://www.googleapis.com/auth/spreadsheets`
    - `https://www.googleapis.com/auth/forms.body`
    - `https://www.googleapis.com/auth/forms.responses.readonly`
    - `https://www.googleapis.com/auth/tasks`
    - `https://www.googleapis.com/auth/contacts.readonly`
  - Picker setup:
    - enable the "Google Picker API";
    - create an API key with Application restriction "Websites" `https://www.ephapse.net/*` and `https://docs.google.com/*`, and API restriction "Google Picker API" only;
    - the project number from IAM & Admin → Settings;
    - set `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER` in Vercel.
  - "Publish app" under Audience.
  - The verification submission, with:
    - one ready-to-paste English justification per sensitive scope, saying what Ephapse does with it, that it is used only when the person asks, and the Limited Use statement;
    - a demo-video shot list: the consent screen showing the app name and the scopes, then each sensitive scope in use in the app, then the Drive Picker.
  - Remove every instruction that names a restricted scope. Update the "What the assistant can then do" and "In the + menu" sections.
- Modify: the public contact address (owner, 2026-11-18: "thay mail cá nhân … full"). The owner's personal Gmail address, the only `mailto:` on these lines, becomes `support@ephapse.net`, both the `mailto:` and the visible text. Today there are exactly 7, all on main:
  - `public/privacy.html` lines 37 and 177;
  - `public/terms.html` lines 34 and 101;
  - `public/usage-policy.html` lines 53 and 80;
  - `docs/legal/danh-gia-chuyen-du-lieu.md` line 72.
  - Add a scan in `test/features.test.mjs` beside the old-name scan that fails if that personal address's local part appears in any tracked file. Build the needle from two string pieces so the test file itself does not contain it.
  - A changed contact address is not a material change: no re-consent, and no version bump unless the repo's existing rule forces one (report it).
- Modify: `package.json` (1.33.1), `CHANGELOG.md`, `public/changelog.json` (vi + en).
  - Say plainly that Gmail can now only send, and that Drive opens files you pick.
  - People connected before the change keep working until their connection ends. Reconnecting gives the narrower access.
  - Update `test/features.test.mjs` if it pins release facts.
- Test: `test/ui.test.mjs`.
  - Replace the Drive-search scenario (around lines 10726-10929). Serve a fake `https://apis.google.com/js/api.js` with `page.route` that defines `gapi.load` and a minimal `google.picker` whose `build().setVisible(true)` immediately calls the callback with `{ action: 'picked', docs: [{ id: 'f-1', name: 'Plan.pdf' }] }`.
  - Stub `/api/connectors/google/picker` and the attach route, and assert the attachment chip appears.
  - Also cover the 503 note, and a cancel that leaves nothing attached.
- Check in a real browser (required): run the app locally and open the Picker in real Chrome (the repo's Playwright) against the real `https://apis.google.com/js/api.js`, with a dummy key and token.
  - Record every CSP violation in the console.
  - Add an origin to the CSP (both files) only if it is shown blocked.
  - The Picker will report a bad key. That is expected; what matters is that nothing is blocked by our CSP.
  - Put the measured list in the report.

- [ ] **Step 1:** Write the UI test changes and watch them fail.
- [ ] **Step 2:** Build `google-picker.js` and the + menu change, and pass.
- [ ] **Step 3:** Update the copy, privacy page, docs and release notes. Run the i18n and features tests and the rename scan.
- [ ] **Step 4:** Do the real-Chrome CSP check and fold in any measured origin.
- [ ] **Step 5:** Run the targeted UI test, `npm run lint` and `npm run typecheck`, then commit, staging by path: `feat(google): Drive opens through the Google Picker; guide and 1.33.1 notes`.

### Task 3: A public home page Google can read, and no sexual imagery from the picture tool

Google's branding review came back on 2026-11-18 with this, quoted from the owner's screenshot:

> "Your application is not compliant with the Google APIs Terms of Service. We were unable to confirm your app's compliance. Please update your home page to clearly outline your application's purpose and ensure it does not use Google APIs for AI NCII (AI-generated Non-Consensual Intimate Imagery), then retry."

Why Google asks:
- `generate_image` calls Google's Gemini API (`server/tools/cloud.js` ~2956-3018) to make pictures.
- `/` shows only a sign-in card. Both `#gate` and `#app` are `hidden` until JS runs, and the description sits behind the "What is Ephapse?" toggle (`public/index.html` ~180-195).

So a reader without JS, or a quick human look, finds no purpose and no statement.

**Files:**
- Create: `public/about.html`, a static public home page, no JS, styled like `public/privacy.html` (same CSS tokens, light/dark, 760px column, 16px gutter, readable at 360px wide).
  - **Language:** English first (it is the page Google's reviewers read), then Vietnamese, with a "Tiếng Việt" link at the top and `lang` attributes on each half.
  - **`<head>`:** `<title>Ephapse — AI assistant workspace</title>`, a meta description, `<link rel="canonical" href="https://www.ephapse.net/about.html">`, `og:title`, `og:description` and `og:url`. No JSON-LD and no script.
  - **Sections, each in both languages:**
    1. **What Ephapse is.** An AI assistant workspace at www.ephapse.net. You chat with the AI model you choose. It works with your files, searches the web, runs code on a private cloud computer, makes documents, slides, spreadsheets, diagrams and pictures, and, only if you connect them, works with your Google account and other services. A plain "Open Ephapse" link goes to `/`.
    2. **How Ephapse uses Google user data.** One line per product, matching the 1.33.1 scopes exactly:
       - Gmail: sends an email you ask it to send; it never reads, searches or changes your mailbox.
       - Drive: only files you pick in Ephapse's Google Drive picker, or files Ephapse creates for you.
       - Calendar, Docs, Sheets, Forms, Tasks and Contacts: what each tool does, from `server/tools/definitions.js`.
       - A Limited Use statement in the same words as `public/privacy.html`'s Google section: used only to provide the features you ask for, not used to train AI models, not sold, not used for ads, people do not read it except as that section allows.
       - A link to the privacy policy's Google section.
    3. **Pictures and safety.**
       - Ephapse can make a picture with Google's Gemini API when a user asks for one.
       - It never makes sexual, nude or intimate images of anyone. It never makes AI-generated non-consensual intimate imagery (AI NCII) or "deepfake" sexual content of real people.
       - Such requests are refused before anything is sent to Google.
       - Ephapse does not use Google APIs or Google user data to create, edit or share such imagery.
       - The Usage Policy forbids it, and accounts that try may be suspended.
       - Links to `/usage-policy.html` and to the report address.
    4. **Contact.** `support@ephapse.net`, plus links to Privacy, Terms and Usage Policy.
- Modify: `public/index.html` gate foot (~180-195).
  - The "What is Ephapse?" control becomes a plain link to `/about.html`, with the same label and place and its `data-i18n` key kept.
  - The hidden `#gate-about` paragraph and its toggle code go. Its content now lives on the page.
  - Remove the dead JS, CSS and i18n keys for the toggle, and update any UI test that pressed it.
- Modify: `public/usage-policy.html`, the vi list (~line 35) and the en list (~line 65).
  - Add one bullet after the child-abuse bullet:
    - vi: "Tạo, sửa hay chia sẻ hình ảnh, video hay âm thanh tình dục, khoả thân hoặc riêng tư của một người thật khi họ không đồng ý — kể cả nội dung do AI tạo ("deepfake", NCII). Công cụ tạo ảnh của Ephapse từ chối mọi ảnh tình dục hay khoả thân."
    - en: "Make, edit or share sexual, nude or intimate images, video or audio of a real person without their consent — including AI-generated ("deepfake") content (NCII). Ephapse's picture tool refuses every sexual or nude image."
  - Add a dated note in both languages, beside the existing rename note: "Clarified 18 November 2026: the ban on non-consensual intimate imagery is spelled out; nothing that was allowed before is now forbidden." Use the vi equivalent for the Vietnamese half.
  - The policy version and re-consent stay as they are. This is a clarification, because illegal content and harassment were already banned. If the repo's legal-version tests force a bump, report it and stop for a ruling rather than bumping.
- Modify: `server/tools/cloud.js` `generateImageTool`. Before any Google call, refuse prompts asking for sexual or nude content.
  - Use a small word-boundary list in English and Vietnamese, in its own module `server/imageSafety.js`, exporting `sexualImageRequest(prompt) → boolean`. For example:
    - en: nude, naked, nudity, nsfw, porn, pornographic, sex, sexual, sexy, erotic, explicit, topless, undress, undressed, lingerie, deepfake;
    - vi: khoả thân, khỏa thân, lõa thể, loã thể, lõa lồ, khiêu dâm, gợi dục, tình dục, cởi đồ, cởi quần áo, 18+.
  - Match accent-insensitively for Vietnamese (NFD with combining marks stripped), and lower-case.
  - Use word boundaries, so "Essex", "Sussex" and "sextant" pass.
  - The refusal is a clear tool result that tells the model to tell the user plainly that Ephapse does not make sexual or nude images, under the Usage Policy. Give it a vi.js entry.
  - Also set the Gemini request's safety settings to the strictest supported level for sexual content (`HARM_CATEGORY_SEXUALLY_EXPLICIT`: `BLOCK_LOW_AND_ABOVE`). Check the current Gemini image API docs (Context7 or ai.google.dev) for the exact field and whether the image model accepts it, and say what you found. If the endpoint rejects the field, leave it out and report.
  - The tool description in `server/tools/definitions.js` gets one sentence: it never makes sexual, nude or intimate images of anyone, so the model should refuse such asks without calling it.
- Modify: `docs/google.md` (Task 2 has written the owner's guide). Add a short "Branding review: home page and AI NCII" section:
  - set Branding → Application home page to `https://www.ephapse.net/about.html`;
  - then, under "Branding verification issues", choose "I have fixed the issues", with a paste-ready English note naming the page, the image refusal and the usage-policy line.
- Modify: `CHANGELOG.md` and `public/changelog.json` (vi + en) 1.33.1 entry: add the home page and the picture rule.
- Test:
  - `test/image-safety.test.mjs` (new):
    - refusals in English and Vietnamese, with and without accents;
    - "Essex", "Sussex" and "sextant" pass;
    - `generateImageTool` refuses before any network call (stub fetch, count 0).
  - `test/features.test.mjs`:
    - `about.html` exists, has no `<script`, names Gmail send-only and Drive picked-files, contains "NCII", links privacy/terms/usage-policy, and has `support@ephapse.net`;
    - the usage policy has the NCII bullet in both languages.
  - Add the new test file to the npm test chain the way the others are listed.

- [ ] Step 1: Failing tests (image safety, features checks).
- [ ] Step 2: Build `imageSafety.js`, the tool guard and the safety setting; pass.
- [ ] Step 3: Write `about.html`, the gate link, the usage-policy bullet, the docs and the notes. Run the features, i18n and server-i18n tests, the rename scan and lint/typecheck.
- [ ] Step 4: Commit by path: `feat(home): a public page that says what Ephapse is, and no sexual imagery from the picture tool`.
