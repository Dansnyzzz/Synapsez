# RESULT — measured before and after

Every row is a command that was run and an output that was read. Where something
could not be measured it says so; nothing here is interpolated.

Four rounds are recorded. **Round 4** (audit v4 → v5, 2026-11-03) is first, then **Round 3** (audit v3, 2026-10-05); the rounds before them follow unchanged.

**Round 2** is the server/worker audit:
before = `audit/BASELINE.md` 2026-09-09 column, `main` at `3e8273e`; after =
`audit/server-worker-2026-09-09` at `9db11a2` plus the audit documents, measured
2026-09-14. **Round 1** follows unchanged below.

---

# Round 4 — audit v4 → v5, 2026-11-02 → 2026-11-03

Before = `audit/BASELINE.md` section "Vòng v4", `main` at `a7098d1` (tag `backup/pre-optimize-20261102-1701`).
After = branch `optimize/2026-11-02`, first measured at `07f6fff` (84 commits — one per ledger ID, plus i18n and
stamp follow-ups that name their ID), then after each evaluator pass: `e805883`, `555e34f` and `5d2ea98`. Every
row is a command that was run and an output that was read.

## The gate, and what runs outside it

| Thing | Before (`a7098d1`) | After (`07f6fff`) | How measured |
|---|---|---|---|
| `npm run gate` (full) | exit 0, 329 s | **exit 0, 315 s**, stamped 2026-11-03T03:37:46Z | `npm run gate`, log `scratchpad/gate-v5.txt`. The first run on this tree was **red** at the eval step: the system prompt had changed (TOK-003); the 15 cases were re-read, none rests on the two shortened lines, stamp moved in `07f6fff` |
| ✓ in the gate log | 5,611 | **5,724** (+113), **0 ✗** | count of ✓/✗ lines |
| Gate after evaluator pass 1 | — | **exit 0, 304 s, 5,733 ✓, 0 ✗** on `e805883` | log `scratchpad/gate-v5b.txt` |
| Gate after evaluator pass 2 | — | **exit 0, 343 s, 5,738 ✓, 0 ✗** on `555e34f`. The run before it was **red** at typecheck: HAR-016 passed `deadline` to `compact()` without declaring it (one new error each in `agent.js`, `compact.js`); declared in `555e34f`, back to 279/279 | log `scratchpad/gate-v5c.txt` |
| Gate after evaluator pass 3 | — | **exit 0, 286 s, 5,744 ✓, 0 ✗** on `5d2ea98` | log `scratchpad/gate-v5d.txt` |
| Browser suite after pass 2 | — | **exit 0, 0 ✗, 698 s** (batch 9, on `22c8e37`; the pass-3 fixes after it touch server code, tests and the README, no page) | `scratchpad/ui-batch9.txt` |
| `test:hooks` | 168/168 | **168/168** | gate step |
| eval (scripted) | 15/15, `PROMPT_STAMP bc830e108fcb` | **15/15, `101239f2dd8e`** | gate step; the scripted eval checks the conditions for a right answer, not what a model does with them (`--live` costs money — RSN-001) |
| typecheck ratchet | 279 outstanding, ceiling 296 | **279, ceiling 279** (CODE-063 locked the 17 the ceiling still allowed) | gate step; `.typecheck-baseline.json` |
| Skips | 3 environment | **4 lines, all environment**: three "runs in CI on Linux" (no bash / POSIX Python on this machine), one desktop branch that goes through `host.ps1` on Windows. §2 and push gate 1 ask for 0 skips: on this machine that is **not met**; the same checks run in CI (`.github/workflows/ci.yml`, `ubuntu-latest`, `npm test`) on the push | gate log |
| Suites in `npm test` | 50 | **51** (+`quality.test`, QC-001) | `package.json`, counted `node test/` entries |
| `node test/ui.test.mjs` (real Chromium, not in the gate) | exit 0 | **exit 0, 0 ✗, 671 s** (batch 8, after the last UI change); batch 7 had **1 ✗** — a check still reading the connector name from `<strong>`, which UI-012 made a button; selector corrected, batch 8 green | `scratchpad/ui-batch{6,7,8}.txt` |

## Regression checks

| Check | Result |
|---|---|
| `git diff --shortstat backup/pre-optimize-20261102-1701 HEAD` | 85 files, +3,449 / −459, 84 commits |
| `package-lock.json` | **unchanged**. `package.json`: `quality.test` added to `npm test`, and `test:quality` |
| `.env` files in the diff | none |
| New files over 300 KB | none |
| Secret shapes in every added line (Anthropic, OpenRouter, OpenAI, Google, GitHub, Slack, AWS, PEM, Postgres URL with password) | **2 hits, both fixtures** in `test/features.test.mjs:625,629` — a made-up `postgres://app:hunter2@db.internal` and a regex, the input and the check of CODE-065's redaction |

## Measured: tests that failed before their fix

Each of these was run with the fix stashed (`git stash push -- <file>`), then with it:

| ID | Without the fix | With it |
|---|---|---|
| HAR-011 | the person's own panel closed with **4429**, 0 frames, behind 20 sockets that never signed in | 3 frames, not closed |
| HAR-008 | two keys pasted at once: **1 kept** (`…ffff`) | 2 kept |
| HAR-013 | eight keys all 502: **10** failed calls | 5 |
| HAR-009 | — (new function `take`) | six Brave calls at once against a ceiling of 3: exactly 3 go |

## Token cost

| What | Before | After | How measured |
|---|---|---|---|
| Every-turn system prompt, the connections line + skill-creator's index entry (TOK-003) | 503 characters, ≈127 tokens | **306, ≈77** (−50 a turn, for everyone) | character count ÷ 4 — an estimate; live token counts need a provider key (RSN-001) |
| A tool's schema in the estimate (TOK-002) | property names not counted | counted | `test/features.test.mjs` |
| An answered question's result (TOK-004) | shown twice | shown once — **display only**: no extra request ever existed (the answer resumes the paused turn), so this saves no tokens | `test/ui.test.mjs` |
| Effort a model refused (PERF-025) | a 400 and a retry on every step | remembered per model, one 400 per process | `test/features.test.mjs` |

## Ledger reconciliation (Phase 3 step 14)

364 IDs after three evaluator passes, each counted at its last row: **FIXED 337 · CHỜ-CHỦ/TRONG-REPO 9 · CHỜ-CHỦ/NGOÀI-REPO 5 · BLOCKED 3 · DEFERRED 1 · OPEN 0 · IN-PROGRESS 0**, and 9 rows of rounds 1–2 written in their own words (RESOLVED, not a defect, PROPOSED — owner decision). BLOCKED are GAP-005/GAP-006/CODE-021 from round 3: each needs a live-model budget.

## Requirement matrix §0b (Phase 3 step 13)

`ĐẠT` = có bằng chứng chạy được trong repo. Phần chỉ làm được với key thật / chi tiêu thật / thao tác ngoài repo ghi `CHỜ-CHỦ/NGOÀI-REPO` (không chặn push theo §5) — không tính là đã đo.

| # | Yêu cầu | Chấm | Bằng chứng |
|---|---|---|---|
| R1 | Audit không bỏ sót, A–Z | ĐẠT (phạm vi v5) | File đổi kể từ `a7098d1` đọc theo lô + agent chuyên đề chỉ đọc (frontend, bảo mật, harness/tài nguyên); file không đổi đã audit ở v2–v4 (`PROGRESS.md`). Không còn `[UNKNOWN]` mở trong ledger v5 |
| R2 | Tối ưu token | ĐẠT | TOK-002 (đếm đúng schema tool), TOK-003 (≈−50 token/lượt cho mọi người, ước tính chars/4), PERF-025 (nhớ mức effort đã hạ → không tốn 1 lượt 400 mỗi bước); đo token thật = CHỜ-CHỦ/NGOÀI-REPO (RSN-001) |
| R3 | Privacy + bảo mật mọi chat | ĐẠT | PRV-014…025, PRV-027, SEC-057…059 và SEC-061…065 FIXED kèm test (SEC-060 = CHỜ-CHỦ/NGOÀI-REPO); `test/memory.test.mjs`, `test/agent.test.mjs`, `test/cloudBrowser.test.mjs` |
| R4 | Mượt, logic, chính xác, sạch | ĐẠT trên nhánh | gate xanh trên nhánh (bảng trên); chạy lại trên `main` đã merge trước khi push — kết quả ghi ở báo cáo push |
| R5 | Real-time, nhanh | ĐẠT (logic) | HAR-012 ngân sách request 240 s + HAR-015 hạn 270 s cho cả lượt, HAR-013 dừng ở 5 lời gọi lỗi, UX-020/021/024; số đo CWV production = CHỜ-CHỦ/NGOÀI-REPO |
| R6 | Phát huy tốt, khắc phục xấu | ĐẠT | ledger v5: mọi dòng FIXED hoặc CHỜ-CHỦ có phương án |
| R7 | Không thu thừa, không truyền thừa cho provider | ĐẠT | PRV-022 (incognito không rơi về Auto), PRV-023 (skill_write không mang dữ liệu Google), PRV-025 (dấu Google giữ khi sửa), `googleData.js` |
| R8 | Ý tưởng tiên tiến có nguồn | ĐẠT | QC-001 vòng sửa chọn lọc (PHẦN XII-B), HAR-013 trần lời gọi lỗi; `REASONING_MAP.md`, `RESOURCE_MAP.md` |
| R9 | Harness + agentic workflow | ĐẠT | HAR-007…013 kèm test (`fallback`, `e2b`, `features`, `cloudBrowser`) |
| R10 | Minh bạch, chính xác | ĐẠT | QC-001 + UX-017 (thẻ `<system>` lạc không lộ ra), CODE-067 (chi phí ghi rõ phần của app) |
| R11 | Gửi provider không lộ | ĐẠT (như v4) | PRV-003 mask (v4); P2–P3 không đổi vòng này |
| R12 | Memory, orchestration, retry, sandbox, state, tool reliability | ĐẠT | SBX-001…005, HAR-008/009/011/013, PRV-024 |
| R13 | Timeout, rate limit, race, edge case | ĐẠT | HAR-008/014 (race nhập key, theo tài khoản; 2 instance serverless vẫn có thể xen — ghi ở ledger), HAR-009 (race trần Brave), CODE-068/UI-005 (race lưu công tắc), HAR-012/013/015 (hạn của lượt) |
| R14 | Không hardcode | ĐẠT | `QUALITY_GATE_ROUNDS`, `PROVIDER_REQUEST_BUDGET_MS`, `E2B_ACCOUNT_SHARE`, `BRAVE_FREE_REQUESTS` qua env, có README |
| R15 | QC trước khi xuất bản | ĐẠT cho trích dẫn | `server/qualityGate.js`, `test/quality.test.mjs`; evaluator tìm ra cổng gỡ nhầm link đúng (tệp đính kèm/memory/project, dấu `**`) → QC-003 FIXED; khẳng định không link → QC-002 |
| R16 | Tự động hóa | ĐẠT (như v4) | không đổi vòng này |
| R17 | Sandbox | ĐẠT trong repo / CHỜ-CHỦ | SBX-001…005 FIXED; SBX-006 (helper khác uid, cần build lại template) và CFG-033 (sandbox agent audit trên Windows cần WSL2) = CHỜ-CHỦ |
| R18 | UI/UX mọi thiết bị | ĐẠT (tự động) | UI-001…018 FIXED; `test/ui.test.mjs` (Chromium thật) xanh. Lưu ý: UI-002/005/006/008/011/012 được ghim bằng kiểm tra mã nguồn trong `features.test` (chứng minh mã có đó, không chứng minh hành vi); UI-003/007/014…017, PERF-024, CODE-069/070 không có test riêng; visual regression nhiều thiết bị thật = CHỜ-CHỦ/NGOÀI-REPO |
| R19 | Tự động tới push `main` | ĐẠT khi push xong | hash push ghi ở báo cáo |
| R20 | Repo public, bảo vệ chất xám | ĐẠT (như v4) | `EXPOSURE.md`; phương án A–D là quyết định của chủ |
| R21 | Tận dụng plugin/skill | ĐẠT | `SKILL_MAP.md` v4/v5 |
| R22 | Hiểu toàn bộ trước khi làm | ĐẠT | 15 file `audit/` + `RESOURCE_MAP.md`, `REASONING_MAP.md` |
| R23 | Logic + tận dụng tài nguyên | ĐẠT | `RESOURCE_MAP.md`; HAR-007 (phần E2B mỗi tài khoản), HAR-009, HAR-013, PERF-024 |
| R24 | Mức suy luận tương đương | ĐẠT trong repo / CHỜ-CHỦ/NGOÀI-REPO | GAP-014 FIXED (OrcaRouter, OpenAI max, thang Gemini tăng dần); ma trận eval effort với key thật = RSN-001; Haiku 4.5 = RSN-002 |
| R25 | Sai thì làm lại phần sai, giữ phần đúng | ĐẠT | `test/quality.test.mjs`: chỉ đơn vị sai bị viết lại, đơn vị đúng giữ nguyên, dừng sau `QUALITY_GATE_ROUNDS` vòng |
| R26 | Không tự chế lọt ra ngoài | ĐẠT cho trích dẫn / CHỜ-CHỦ cho khẳng định không link | `test/quality.test.mjs`: 0 link bịa lọt qua trên bộ case (sửa hoặc gỡ, phần đúng giữ nguyên từng byte). Khẳng định không kèm link chưa được đối chiếu → QC-002 CHỜ-CHỦ/TRONG-REPO |

## Not measured, and why

- Live token, cache hit, cost and latency per request, and the effort × task eval: need provider keys and real spend — RSN-001, CHỜ-CHỦ/NGOÀI-REPO.
- E2B commands end to end on production after SBX-001…005: need the deployment's E2B key — verified by `test/e2b.test.mjs` and by reproducing the `require()` crash locally with `node --no-experimental-require-module`, not live.
- Core Web Vitals and visual regression on real phones: the automated browser suite ran in Chromium only.

## Evaluator (Phase 3 step 6) — giám khảo cùng họ, có thiên lệch tự ưu ái

A fresh read-only `code-reviewer` agent, given the diff, this section, the ledger and §0b. Deterministic checks (gate, tests) take precedence over it.

- **Pass 1: NEEDS_WORK**, 8 findings. Fixed as new IDs — QC-003, PRV-027, HAR-014 and HAR-015 each with a test run red without the fix; CODE-074's test is a source check over every route file; CODE-075 has none: **QC-003** (the quality gate removed correct links — from attached files, memory notes, project passages, or inside `**…**` — and said so falsely), **PRV-027** (the skill draft is kept on the account, so the export carries it; PRV-014's note that it lived only in the browser was wrong), **HAR-014** (one key intake at a time per account, not per provider), **HAR-015** (a turn deadline for the turn's own model calls — its steps, the quality gate's repair and, after HAR-016, folding; sub-agents and deep research keep their own budgets and do not get it; HAR-012's budget restarted per call), **CODE-074** (12 more raw error texts, and the 500 handler), **CODE-075** (a stale stamp note, a dead CSS rule). This section's overstated figures were corrected: suites 50→51, one TOK-003 figure, TOK-004 not a saving, SEC-060 not FIXED, R4 not yet measured on `main`, skips not 0 here.
- **Pass 2 (a new agent): NEEDS_WORK**, 7 findings. Fixed as new IDs: **QC-004** (QC-003 had made the model's own earlier words a source, so a link it invented in an earlier step passed; now only the system prompt and the messages not the assistant's — an `agent.test` case, red without the fix; its deadline check then looked at the first call only, corrected in pass 3), **CODE-076** (eight more raw texts inside `translateMessage(…)`, an MCP start error, and the 500 handler now says only that the server failed; the source check widened to those shapes), **HAR-016** (a rate-limited key's rest is not waited past the turn deadline — red without the fix; compaction gets the deadline; the README says plainly what the deadline does not bound: a reply already streaming, the 20 s a call gets to start, a turn that outlives the function and is resumed by `server/resume.js`), **PRV-028** (what artifacts' pages saved is in the export; the README's export list completed). Recorded as **QC-005** (CHỜ-CHỦ/TRONG-REPO): a PDF sent as bytes has no text to source a link from. The QC-003 bytes check was rewritten so it can fail. Figures above updated (ledger tally, the gate after each pass).
- **Pass 3 (a new agent): NEEDS_WORK**, 5 findings. Fixed as new IDs, each with a test run red without the fix: **CODE-077** (raw error text in three more shapes — a skill upload's per-file error held in a variable, a failed turn's message over the stream, the workspace's unreadable-preview message; `readableFailure` now applies the shared database test, and the source check flags any value use of `err.message` in a route file), **CODE-078** (CODE-076 had turned the body parser's own 4xx — too large, not JSON — into a 500 "try again"; they keep their status and say what was wrong), **QC-006** (a folded conversation's summary, handed over as the user's but written from the assistant's replies too, is not a source), **PRV-029** (deep-research runs and MCP servers in the export, the latter without headers, environment or token-shaped values; what is left out is said). The deadline check now records every call of a turn and folding is driven with one (`658de83`); `47a479f` [QC-006] also carries the folding check, which sat in the same hunk.
- Recorded, not changed: several UI fixes are pinned by source checks (see R18); commit `6bc8b90` [SEC-058] also carries UX-024's `code: 'rate_limited'` emit in `app.js`, and `3cfc744`, `c65f91a`, `721e011` each cover several IDs — history is not rewritten.

---

# Round 3 — audit v3, 2026-10-04 → 2026-10-05

Before = `audit/BASELINE.md` section "Vòng v3", `main` at `58b1ab4` (tag `backup/pre-optimize-20261005-0736`).
After = branch `optimize/2026-10-05`, first measured at 129 commits, at `f39f419`–`d6d1ea7` (the commits
between them touch `audit/` only), and again after each evaluator pass; 203 commits at `fc9e922`, after the
seventh; 209 at `1186563`, after the eighth. Every row is a command that was run and an output that was read.

## The gate, and what runs outside it

| Thing | Before | After | How measured |
|---|---|---|---|
| `npm run gate` (full) | exit 0, 255 s | **exit 0, 218 s** on `f39f419`; after the first evaluator's follow-ups **224 s** on `12ee0b8`; after the second's **215 s** on `499580f`; after the third's **475 s** on `7726301` (wall time on this machine varies with what else it is doing); after the fourth's **207 s** on `0a24f12`; after the fifth's **203 s** on `00b0ae6`; after the sixth's **214 s** on `5d0fc03`; after the seventh's **224 s** on `fc9e922`; after the eighth's, **red** on `a8cb8f9` (a source check in `features.test` still looked for the line UX-014 had wrapped; fixed in `f63591b`), then **218 s** on `1186563` | `npm run gate`, logs `scratchpad/gate-final{,2,3,4,5,6,7,8,9,10}.log` |
| lint | exit 0 | **exit 0** | gate step 1 |
| `test:hooks` | 168/168 | **168/168** | gate step 2 |
| eval (scripted) | 13/13, `PROMPT_STAMP ecd004bc42ae` | **13/13, same stamp** — the main system prompt did not change | gate step 3; server log `promptVersion=ecd004bc42ae` |
| typecheck ratchet | 315 outstanding, ceiling 315 | **315, ceiling 315** — `.typecheck-baseline.json` did not grow | gate step 4 |
| `npm test` | 4,282 ✓, 1 skip | **4,541 ✓** (`f39f419`), **4,550 ✓** (`12ee0b8`), **4,560 ✓** (`499580f`), **4,568 ✓** (`7726301`), **4,578 ✓** (`0a24f12`), **4,583 ✓** (`00b0ae6`), **4,586 ✓** (`5d0fc03`, and again at `fc9e922` and `1186563`: the last two passes' fixes add browser checks, not suite ones), **0 failures, 2 skips** — both platform-only (CODE-034): `desktop.test` Linux host branch, `cloudBrowser.test` start script under bash. Both run in CI on Linux; this Windows machine has no bash (Git Bash missing) and no WSL distribution | gate step 5 |
| Suites in `npm test` | 47 | **48** (+`egress.test`) | `scripts.test` |
| `npm run test:ui` | — | **exit 0, 909 ✓, 0 failures, 249 s** at `d6d1ea7`; **912 ✓, 0 failures, 256 s** at `12ee0b8` (+3: SEC-050); **913 ✓, 0 failures** at `9b80bd5` (+1: UX-008); **915 ✓, 0 failures** with UX-009 (+2) at `be1ec2b`; **917 ✓, 0 failures** with UX-010 (+2) at `de8c0d7`; **918 ✓, 0 failures** with UX-011 (+1) at `e3373b1`; **920 ✓, 0 failures** with UX-012 (+2) at `41b4b82`; **924 ✓, 0 failures, 281 s** with UX-013 and UX-012's Pause (+4) at `fc9e922`; **927 ✓, 0 failures, 291 s** with UX-014 (+3) on the `pages.js` and `ui.test.mjs` committed in `783d30d` — the commits after it touch no page (real Edge) | `node test/ui.test.mjs` |
| `npm run test:sandbox` | — | **exit 0, 31 ✓** | not in the gate |
| Coverage (c8, `all:true`) | statements 64.09 · branches 75.42 · functions 67.03 · lines 64.09 | **64.87 · 75.95 · 68.45 · 64.87** — up on all four; functions was 0.03 above its threshold and is now 1.45 above | `npm run coverage`, exit 0, 221 s |

## Regression checks

| Check | Result |
|---|---|
| `git diff --shortstat backup/pre-optimize-20261005-0736 HEAD` | 91 files, +5,623 / −357 at `1186563`, 209 commits (includes the vendored Vercel scripts); +5,483 / −357 at `fc9e922`, 203 commits. First measured at 89 files, +4,154 / −312 before the evaluator rounds; 91 files, +4,955 / −324 at `7726301`, 161 commits |
| `package-lock.json` | +87 / −3: `@vercel/analytics`, `@vercel/speed-insights` (then moved to devDependencies, CFG-030: +4/−2 of that), and `qs` 6.16.0 (SEC-048). Never regenerated |
| `.env` files in the diff | none |
| New files over 300 KB | none (the one over is `test/ui.test.mjs`, which already was) |
| Secret shapes in every added line of the branch's commits (129, re-run at 161, at 203 and at 209, `1186563`) | **0** (Anthropic, OpenRouter, OpenAI, OrcaRouter, Google, GitHub, Slack, AWS, PEM, Postgres URL with password) |
| Outbound calls with a timeout (`server/`, `api/`) | **45/45**, unchanged; the one the scan flags, `server/email.js:146`, has its signal at `:161` |
| `console.log/info/debug` in server+api+worker | **unchanged**: 63 on both the tag and the branch by one method (`git grep -c -E "console\.(log\|info\|debug)\("`), and the diff adds or removes no such line. (A first version of this row said 64 → 63, comparing the baseline's count by another method with this one; corrected after the second evaluator pass.) |
| Analytics / APM in code | 0 → **Vercel Web Analytics + Speed Insights** in `public/js/insights.js` (GAP-012, asked for). `@sentry` appears only as a name in the MCP catalogue, as before |
| TODO/FIXME/XXX/HACK in tracked source | **0** |

## End to end, locally (Phase 3 step 3)

A real server (`node server/index.js`, throwaway `DATA_DIR`, port 5199, database URLs and every provider key
blank, secrets and local access defaults passed in so nothing was appended to `.env`), driven over HTTP:

```
server up: true
GET /api/session (anonymous): authed=false insights=null
POST /api/register: 201 cookie=set
GET /api/session (signed in): authed=true email=e2e@example.com
POST /api/chats: created
POST /api/chats/:id/messages: 201
POST /api/chats/:id/run: 200 text/event-stream; charset=utf-8; 4 SSE events; last={"stopReason":"error"}
POST /api/chats/:id/share: /share.html?t=<token>
GET /api/shared-chat/:token (no account): 200 messages=1 signedIn=false
visitor GET /api/favicon/evil.example (not in the chat, SEC-038): 401 (passed on, not fetched)
visitor GET /api/map tile (chat has no map, SEC-038): 401
GET / CSP: script-src 'self' | connect-src 'self'
server log: turn failed … errMsg=No API key for Anthropic. Add one in Settings → Providers. ms=80
```

The turn ends on the readable no-key error by design: there is no provider key on this machine, and spending
one on a test is not this audit's to do. `insights=null` is correct off Vercel.

## Privacy egress (PHẦN V §P8) and the harness (PHẦN VI)

`node test/egress.test.mjs`, all pass:

```
the watch on the network sees more than fetch (HAR-006)
  ✓ a request through node:https is caught, not only fetch — socket egress-probe.example:443
  ✓ and so is a name lookup on its own — dns egress-probe-2.example
a turn with personal data reaches the provider and nothing else
  ✓ the provider receives the message as written (no de-identifying layer yet — PRV-003)
  ✓ no other request, TCP/TLS connection or dns.lookup leaves the process during the turn
  ✓ nothing the process printed carries the personal data
  ✓ nothing in the security record carries it
strict privacy reaches the wire, standard does not
  ✓ a strict account is sent with OpenRouter's no-storage routing
  ✓ a standard account is not
  ✓ the strict request's body asks OpenRouter to keep nothing — {"data_collection":"deny","zdr":true}
  ✓ and the standard one carries no such routing
one account is never answered from another account's results
  ✓ each account read its own / and neither saw the other's
```

The first version of this test watched `fetch` only, while `safeFetch` (web tools, icons, pictures) goes
through `node:http`/`https`; and "strict reaches the wire" read only the dispatcher's argument. Both were
widened after the second evaluator pass (HAR-006): every TCP/TLS connection (`net.Socket#connect`, which
fetch, http, https and tls all use) and every `dns.lookup` is watched — not `dns.resolve*` or UDP, which nothing
on a turn's path calls — a probe proves the watch catches them, and the strict case reads the body the real
adapter sends. (This paragraph said "every socket connection and name lookup" until the fourth evaluator pass.)

It proves where personal data goes and that no log keeps it. It does **not** prove de-identification, because
there is none yet (PRV-003, CHỜ-CHỦ). The H1–H20 harness checks live in `agent`, `fallback`, `workflow`,
`live-runs`, `isolation`, `memory` and `research`, all green inside the gate; the re-score is at the end of
`audit/GAP_ANALYSIS.md`.

## Measured, each a test that failed before its fix

| ID | Before | After |
|---|---|---|
| CODE-042 | a save landing between a delete's read and write was lost: `{"kept":"2"}` | kept: `{"kept":"2","fresh":"3"}`. The first test written (six saves in parallel over HTTP) passed on the old code too, because PGlite runs one query at a time; it was replaced by one that forces the interleaving |
| SEC-038 | a share cookie fetched any icon, allow-listed picture or map tile | off-page requests pass on to the sign-in check (401); four checks fail on the old code |
| PERF-020 | citation matching on a long reply 9,077 ms | **367 ms** |
| PERF-017 | quadratic on hostile feeds and pages | 2–394 ms on 150k–2M-character hostile inputs |
| PERF-016 | a catastrophic regex ran unbounded | stops at **1,008 ms** |
| PERF-021 | a large photo decoded twice at once | the thumbnail is drawn from the 938 KB copy preparing made (real Edge) |
| ACC-013 | white on `#a78bfa` 2.7:1; send buttons 2.9 and 3.4:1 in the light theme | `--on-accent` 6.96 / 5.67 / 5.67 / 9.08:1, computed from the stylesheet by a test |
| CODE-043 | the clipboard restore check could not fail | fails when the probe is still on the clipboard |

## Token cost

Not measured with live usage: no provider key here (as at baseline, `[UNKNOWN]`). What changed is fixed
prompt text, measured by characters:

| Where | Change | Why it is worth it |
|---|---|---|
| Sub-agent system prompt | +≈843 chars (the 659-char untrusted-content rule, one 181-char line, two line breaks), ≈ +210 tokens per sub-agent call | SEC-043: a sub-agent read web pages with no rule telling it a page's instructions are data |
| Compaction prompt | +≈461 chars, ≈ +115 tokens, once per compaction | SEC-040: tool output was summarised as if it were the conversation |
| The summary re-entered after a compaction | +≈104 chars ("The app wrote it, not the user…"), ≈ +26 tokens on **every turn** after a compaction | SEC-040: the summary must not read as the user's words |
| Project sources in the prompt | +51 chars plus the source's name, per source, ≈ +13–20 tokens per source on **every turn** that carries the shelf or its passages | SEC-042: a source's text is wrapped as untrusted |
| `web_fetch` with pictures | ≈ +19 tokens per call | SEC-045: the page's captions sit inside an envelope |
| Effort step-down | up to 3 needless retries per unrelated 400 → none | TOK-001 |

The main *static* system prompt is byte-identical (`PROMPT_STAMP` unchanged), so its cache prefix is unaffected.
The two per-turn rows above sit after it; they are small, fixed per source or per summary, and stable from
turn to turn, so they cache with the rest of that turn's prefix. (Corrected after the Phase 3 evaluator: the
first version of this table overstated the sub-agent row as ≈ +280 tokens and left out the two per-turn rows.)

## Ledger reconciliation

| Total | FIXED | CHỜ-CHỦ (in repo) | CHỜ-CHỦ (outside repo) | DEFERRED | BLOCKED | OPEN | IN-PROGRESS |
|---|---|---|---|---|---|---|---|
| 115 | 94 | 15 | 2 | 4 | 0 | **0** | **0** |

(74 rows from Phases 1–2; four raised by the evaluator's first pass, eight by its second, four by its third,
six by its fourth, six by its fifth, five by its sixth, four by its seventh, one by its eighth, three by its
ninth — below. Counted from the ledger by a script, not by hand.)

No CRITICAL or HIGH is open. The 21 not fixed are 7 MEDIUM (PRV-003, HAR-001, HAR-005, PERF-022, SEC-049,
CFG-032, LAW-001) and 14 LOW: 17 CHỜ-CHỦ with the reason and the options in the row, and four DEFERRED —
ACC-017 (a judgement on which country domains keep `edu`/`gov` for real institutions) and three narrow
schedule-panel cases the ninth pass left as "could be better" (UX-015, UX-016, CODE-062), each with its reason.

## The fresh-context evaluator

**First pass: `NEEDS_WORK`.** A read-only reviewer that had not seen the work sampled 15 FIXED rows and the
analytics addition; 13 held. Two findings blocked, five did not. Every one was acted on, back in Phase 2 under
new IDs, each with a test that fails on the code before it:

| Finding | Disposition |
|---|---|
| HAR-002's one-step undo kept the text a person removed by their own edit, and the export left it out | **PRV-006** `3a773b5`: only an assistant's change keeps what it replaced; the person's edit keeps nothing and clears it; the export carries it; Settings says so (en, vi) |
| PRV-001 still published `analyze_data` by `file_id` and `read_generated_file`, which read any file on the account | **PRV-007** `4fb2530`: such a read is published only when its file was sent or made in the shared conversation |
| SEC-041 covered signed-in visitors only; a signed-out one was still copied a stranger's conversation after signing in | **SEC-050** `0588530`: only the shared page's own button earns a copy; a bare link is shown. Proven in real Edge |
| A stale comment, laid out as the CODE-039 pattern | **CODE-049** `80588d7` |
| This file's token table overstated one row and left out two per-turn costs | corrected above, with the measurements |
| `.claude/settings.json` was edited by the agent (CFG-026: deny reading `.env.*`) | kept — it only narrows what the agent may read — and named in the hand-over for the owner, who may restore `.env.example` (CFG-024) and would then want to allow that one name |
| The hosted `script.js` Vercel serves was not checked | outside the repository; the app passes it only the trimmed address, and nothing else the page holds |

**Second pass (a new reviewer, no memory of the first): `NEEDS_WORK`.** It re-checked the four new rows and
a different sample (SEC-036/037/041/042/044/046, CODE-031, HAR-003, CFG-026, PERF-016/017, GAP-012), which
held, and found one blocking flaw and seven smaller ones. All acted on:

| Finding | Disposition |
|---|---|
| PRV-007 decided publication by tool-call id, and ids repeat in a transcript (the adapters invent `gcall_0_<tool>` / `call_<tool>` when a provider sends none); the result side had dropped the tool-name check | **PRV-008** `383ff2d`: decided per message, a result judged only against the call just before it, twin ids withheld, the name checked; three checks fail on the PRV-007 code |
| The egress test watched `fetch` only, and "strict reaches the wire" read only the dispatcher's argument | **HAR-006** `3ccd8e7`: sockets and name lookups watched, a probe proves it; the real adapter's body checked |
| GAP_ANALYSIS scored "secrets outside the repo" as passing, though only the Read tool is denied | re-scored MỘT PHẦN; the shell side needs a hook → **CFG-032**, CHỜ-CHỦ |
| This file's logging-call row said 64 → 63 | corrected: unchanged, measured one way on both sides |
| A test cut `boot()` at a function SEC-050 removed, and so checked the whole file | **CODE-050** `2e7c612` |
| SEC-050 never cleared a bare link's key when the button was used later in the tab | **UX-008** `9b80bd5`, proven in real Edge |
| The Vercel insight packages sat in `dependencies` | **CFG-030** `bc5c01d`, lockfile +4/−2 |
| PRV-006's export left out the earlier version's conversation id | **PRV-009** `b699b4a` |
| CODE-046 was FIXED with one site left for the owner | split out as **CFG-031**, CHỜ-CHỦ |

**Third pass (another new reviewer): `NEEDS_WORK`.** Its first attempt died on the account's session rate limit
before reporting and was re-run. It confirmed PRV-008's per-message logic against the transcripts the store
really holds (resumed runs, interleaved messages, a tool message with no call before it, the fork and the
visitor gate) and held the sample PERF-018/019/021, CODE-035/036/043, ACC-013/016, CFG-029, SEC-048, CODE-047.
It found:

| Finding | Disposition |
|---|---|
| `update_file` is publishable and rewrites a made file by id from anywhere on the account — its text, its file (fetchable, copied by a fork), and a later read of that file all got through | **PRV-010** `879438d`: guarded like the reads; a test now fails if any publishable tool taking a `file_id` is left unguarded |
| UX-007 held only for chips in earlier messages; a chip in the reply being written is redrawn every frame | **UX-009** `be1ec2b`: the card finds its chip again in the same prose; real Edge, fails on the previous code |
| `latestWins` dropped the queued save when the one before it failed | **CODE-051** `7f15dcf` |
| The CHANGELOG said every fix has a failing-first test (not so for comment, README, settings and CI fixes); PERF-019 "capped before decoding"; a CSS comment said 7:1 for 6.96:1; "every name lookup" for `dns.lookup`; this file's diff and lockfile figures were stale; a README default predating the branch | **CODE-052** `4e60f60`, and the figures above |

**Fourth pass (another new reviewer): `NEEDS_WORK`.** It went through all 28 publishable tools and the whole
share path end to end, and held the sample SEC-039/040, CODE-033/040/041/044/045, ACC-014/015, PERF-020,
UX-005/006, CFG-027, HAR-002 and GAP-012's server half. It found:

| Finding | Disposition |
|---|---|
| A shared conversation's messages are a snapshot but its files were read live: a rewrite after sharing reached visitors and forks (older than this branch) | **PRV-011** `9a708fd`: served and forked as they stood at `shared_at`, from the file's version history; no schema change; fails on the previous code |
| RESULT.md still made the egress claim CODE-052 had narrowed in the test; GAP filed ACC-008 under accessibility; the changelog did not name PRV-010 | **CODE-053** `6f50c7a` |
| `insights.js` accepted `"/\evil.example"` as same-origin | **SEC-051** `9f6931d`: decided by the URL parser |
| The Repeat timer could reopen the old schedule after moving on | **UX-010** `de8c0d7`. Its browser test found worse: the choice was lost when the panel closed, and switching schedules could save the new one's fields into the old row. A pending choice is now saved before the panel goes |
| The assistant's own reply could still put a `USER:` line before the summariser | **SEC-052** `4a7d99a` |
| The storage test's safety rested on empty variables reaching its child process | **CODE-054** `9896f0f`: a report-only run must show the temporary database first; and probed: on Windows an empty variable does reach the child |

**Fifth pass (another new reviewer): `NEEDS_WORK`.** It held PRV-011 against every write to a file and its
history (the prune, a restore, a rename, uploads, thumbnails), held SEC-051/052, CODE-053/054, the sample
CODE-038/039, ACC-009..012, PRV-004, CODE-048, and found no regression in its skim of the whole diff. It found:

| Finding | Disposition |
|---|---|
| UX-010 read the panel's fields from the shared panel body: a save in flight could still put the next schedule's fields into the old row; after a close the card was never refreshed; after a switch the old title could be written over the new panel | **UX-011** `e3373b1`: each schedule drawn into its own element; the card check fails on the previous code (real Edge) |
| A shared conversation's messages were not a snapshot either: editing one after sharing rewrote it in place under its first timestamp (older than this branch); this file and the changelog claimed the opposite | **PRV-012** `6d17c57`: an edit is stamped with its own time, so the shared copy ends before the edited message (the edit already deletes the turns after it) and never shows the edit; the claims now say so, with the one exception, the title (**PRV-013**, CHỜ-CHỦ: needs a column) |
| `getAttachmentAt` returned the live file with no moment, and compared times in JS | **CODE-055** `2e91871` |
| A lone CR or U+2028/U+2029 escaped the transcript's quoting | **SEC-053** `9e81771` |
| `(gov\|edu)\.[a-z]{2}` admits names under open country domains | **ACC-017**, DEFERRED with its reason |

**Sixth pass (another new reviewer): `NEEDS_WORK`.** It found no remaining cross-account or outside-the-
conversation leak on the share path and no regression in its skim of the whole diff; PRV-012 held against
every reader of a message's time. Three narrow findings and two smaller ones:

| Finding | Disposition |
|---|---|
| A file's history was filed with a time cut to the millisecond, so a rewrite in the share's own millisecond could be taken for the snapshot — and CODE-055's comment said it could not | **CODE-056** `2e9b564`: filed inside the database, uncut; older rows taken only a millisecond clear of the moment |
| A tool call's arguments in the compaction transcript kept U+2028/U+2029 raw | **SEC-054** `31fc494` |
| Reopening a schedule did not wait for the flushed save, so the old Repeat could be shown and saved back; a save failing off screen was silent; the editor's Pause/Resume reopened a closed panel | **UX-012** `41b4b82`, real Edge, both checks fail on the previous code |
| A hand edit to a note read the note first for nothing | **CODE-057** `b4bc7db` |
| The changelog promised more than PRV-012 does (an edit removes the later turns from the copy) | **CODE-058** `c31d604` |
| Unsharing clears the cache on one instance only | already **CODE-032**, CHỜ-CHỦ |
| Push gate 1 says "0 skip" | the gate table states the two platform skips plainly rather than ticking it |

**Seventh pass (another new reviewer): `NEEDS_WORK`.** It held all five rows from the sixth pass — CODE-056
against every time involved (each is the database's own `NOW()`), SEC-054, UX-012, CODE-057, CODE-058 —
re-read the whole share path and found no new way out of the account or the conversation, re-parsed the
ledger, and re-ran the secret scan over every added line (0). One finding blocked, a claim; four did not:

| Finding | Disposition |
|---|---|
| The changelog said every fix to code has a test that fails without it; CODE-057 has none, nor had UX-012's Pause/Resume | **CODE-059** `973042b`: the exception is named; Pause/Resume has a test now (below), which fails on the code before UX-012 (`closed:false`) |
| UX-012 waited only for a save still in its pause: once the timer had sent it, a reopen fetched the old row again; and an open that finished late drew over a later open or a close | **UX-013** `e0a85ff`: an open waits for saves already sent too, and only the latest open or close draws. Real Edge: on the previous code exactly the two new checks fail (`shown:"weekly"`, `closed:false`) |
| CODE-056's second check could not fail without the fix (it compared whole milliseconds) | **CODE-060** `7ccd19e`: the file's time has a sub-millisecond part; in a throwaway worktree, with only the INSERT..SELECT reverted, that check fails (`uncut:false`) |
| This file's commit count and the diff and secret-scan figures stopped at 161 commits | updated above, at `fc9e922` |
| Two comments wrong since before the branch (`pg.js` "files two rows"; `compact()`'s JSDoc had lost `signal`) | **CODE-061** `d4c17a6` |

**Eighth pass (another new reviewer): `NEEDS_WORK`.** It held CODE-059/060/061 and the audit record (the
counts; the changelog's one named exception — no other FIXED code row lacks a test that fails without it),
and UX-013 for the same schedule, the delete flow and the card and list opens. One finding blocked: a
regression UX-013 had made.

| Finding | Disposition |
|---|---|
| UX-013 made an open wait for every save in flight, any schedule's. Change the Repeat, open another schedule while that save is out: the Repeat timer, answered first, reopened the schedule just left, and the other one was dropped — the changelog said the opposite. Pause/Resume had the same shape (older) | **UX-014** `783d30d`, `f63591b`: an open waits only for its own schedule's requests; the timer and Pause/Resume reopen only if nothing opened or closed since. A second schedule in the browser test: on the UX-013 code exactly the two new checks fail (the panel stays on the schedule left) |
| A `latestWins` run queued behind the one on the wire, and a Pause/Resume request, were not waited for | in UX-014: both count now |
| An open can wait without limit on a stalled request | narrowed by UX-014 to the schedule's own requests. `api.js` has no client-side timeout for any request — app-wide, older than this branch, and not taken up here |
| The secret-scan figure depends on the patterns used | they are listed in that row; the reviewer's own scan found only test placeholders |

**Ninth pass (another new reviewer): `PASS`.** It walked the schedule panel as a whole — the same schedule,
another one, close, the Repeat pause, a save in flight, a queued save, Pause/Resume, delete, a failed save,
workflows as well as tasks — and found no sequence that loses a choice made before an open, saves into the
wrong row, or pulls the panel back to a schedule that was left; traced that the two new UX-014 checks fail on
the UX-013 code and that the second schedule's card changes no earlier check; and re-measured every figure in
`604e155` (commits, diff, lockfile, ledger, test counts) and the secret scan. It ran nothing. Not blocking:

| Finding | Disposition |
|---|---|
| An edit made in the old view while the same schedule's open is fetching is drawn over, and the next edit writes the old value back (older than the branch) | **UX-015**, DEFERRED with its reason: needs a design (the old view `inert` while an open waits, or fetching again when a request for the same schedule went out meanwhile), not another patch |
| A flushed save that fails before the next schedule has drawn reports into the old view's status line, which is then replaced: no toast | **UX-016**, DEFERRED, same reason; rarer since UX-014 |
| A save landing after a switch calls the new schedule's `paneAfter`; the timer's and toggle's reopen leave a fetch failure unhandled (older than the branch) | **CODE-062**, DEFERRED, same reason |
| Two parts of UX-014 have no check that fails without them: the toggle's `sent(key, …)` (only a reopen of the *same* schedule right after Pause/Resume would show it) and the queued `latestWins` run (guarded by the source check in `features.test`) | recorded here. The changelog claims neither separately; UX-014's main change has two checks that fail without it |

Phase 3 ends here, after nine passes.

## Phase 4 — merge, push, production

| Step | Result |
|---|---|
| `origin/main` before the merge | `58b1ab4` = the branch's merge base (nothing to pull) |
| `git merge --no-ff optimize/2026-10-05` | `ba85616`, no conflict; `git diff optimize/2026-10-05 main` empty |
| `npm run gate` on `main` | **green (full), 213 s**, 4,586 ✓, 0 failures, the same two platform skips; hooks 168/168, eval 13/13, typecheck 315/315 |
| `git push origin main` | `58b1ab4..ba85616`, no force |
| Production smoke (`scratchpad/prod-smoke.mjs`, GET/HEAD only, no account, no data sent), after 53 s | the new deployment serving (`/api/session` carries `insights`, `{"sampleRate":1,"clientConfig":null}` — only this branch's code answers with it); `GET /` 200; CSP `script-src 'self'`, `connect-src 'self'`, `frame-ancestors` present; `/_vercel/insights/script.js`, `/_vercel/speed-insights/script.js`, both vendored modules and `/js/insights.js` 200 `application/javascript`; a made-up share token 404; `/api/favicon` without a session 401 (SEC-038) |
| Rollback | not needed |

## Not measured, and why

- Live token use, cache hit rate, cost and latency per turn: needs a provider key and real requests (§6).
- Whether Vercel Analytics and Speed Insights record visits: they are switched on in the Vercel dashboard
  (Project → Analytics / Speed Insights → Enable), which is outside the repository. The scripts are served.
- The two Linux-only test branches on this machine: no bash, no WSL distribution; installing one is outside the
  repository. They run in CI on every push.
- The Windows-only `.ps1` checks in CI: CI is Linux only (CFG-028, CHỜ-CHỦ). They run here, in every gate.

## Mistakes made during the work

- SEC-039's code landed in `7ba763b` under a ledger-commit title; `d266ed1` holds the right message. A quoting
  failure in PowerShell; every commit since went through a message file.
- `612daa8` carried the CODE-048 ledger row cut off at its first double quote (PowerShell 5.1 splits arguments
  there); `143be92` writes it whole, from a file.
- `keyStep` (CODE-038) was first placed between `chartFigure` and its JSDoc, which dropped `chartFigure`'s
  parameter types; `lendableUnder` (PRV-005) did the same to `visionEngines`. Both found by the CODE-039 scan and
  moved in `d58d92a`.
- A first CI-comment fix (CODE-046) said the type-check count lives in `scripts/typecheck.js`; it lives in
  `.typecheck-baseline.json`. Caught before commit.
- While checking CODE-054 by hand, `scripts/storage.js` was run in report-only mode from PowerShell with
  `$env:DATABASE_URL = ''` meant to blank it. In PowerShell that *deletes* the variable, so the script's `.env`
  loader was free to fill it: had `.env` named a real database, the report — which opens the store, and so
  applies pending migrations — would have reached it. It reported the local PGlite file; nothing else was
  touched. The test itself passes empty values from Node, which, probed, do reach a child on Windows.
- `8139c0e` holds the seventh pass's audit record (this file and PROGRESS.md) under CODE-059's changelog title:
  the new message was written in the same batch of tool calls as the commit, the write was refused, and the
  commit took the message file as it stood. Left as it is rather than rewriting the branch; the commit after it
  says so. From here the message file is written, and read back, before the commit runs.
- UX-012's first version waited only for a save still in its pause, and its own browser check passed because
  that check reopened within the pause. The seventh evaluator found the case it missed, the save already sent
  (UX-013); the new checks hold the request back past the pause. UX-013 then waited for *every* save, and
  the eighth found that this pulled a person who opened another schedule back to the one they had left
  (UX-014). Each fix here was tested only on the case it was written for; the suite had one schedule, so
  "another schedule" was never tried until UX-014 added a second.
- UX-014 was committed after lint, the type-check and the browser suite, without `npm test`; the gate went red
  on a source check that still looked for the line it had wrapped (`f63591b`). The gate is what caught it.
- Each evaluator pass after the first found something the previous round's own checks had passed: the share
  path three times over (PRV-007 by id, PRV-008 by repeated id, PRV-010 by a tool missed from the list), and
  claims in this file that ran ahead of the evidence. Read-only review by a reviewer that had not seen the work
  earned its place every time.

---

# Round 2 — server/ + worker/, 2026-09-09 → 2026-09-14

## The gate, and what runs outside it

| Thing | Before | After | How measured |
|---|---|---|---|
| `npm run gate` | green | **green (full)**, re-run after the last code commit | `npm run gate` → "Gate green (full)" |
| `npm run lint` | 0 problems | **0 problems** | inside the gate |
| Suites in `npm test` | 31 | **31**, all pass | `scripts.test.split('&&').length`; gate |
| `npm run test:hooks` | 128 checks | **168 checks** | "All 168 hook checks passed." |
| `npm run eval` (scripted) | 13/13 | **13/13** | "All 13 cases passed." — `--live` not run |
| `npm run test:ui` | — | **exit 0, 498 checks, 0 failures** | real Chromium; the one "skip" in the log is a check named "skipping closes it" |
| `npm run test:sandbox` | — | **exit 0, 31 checks** | run by hand; not in the gate |
| Gate stamp integrity | head + dirty hash | **content fingerprint** — a docs commit no longer expires a stamp; a code change always does (`CFG-018`, `CFG-020`) | hooks.test.mjs |

## Type checking

| | Before | After |
|---|---|---|
| Real `tsc` errors | 363 | **362** |
| Recorded ceiling | 363 | **362** — moved down once, never up |
| Errors above the ceiling | 0 | 0 |

Every type error the Phase 2 work introduced along the way (four times) was fixed
with a real JSDoc contract, not by re-recording the baseline.

## Coverage — the first re-measurement since 2026-09-02

| | 2026-09-02 | 2026-09-14 | How |
|---|---|---|---|
| Statements / lines | 57.81% | **61.06%** (28,058 / 45,944) | `npm run coverage` (c8 over all 31 suites), exit 0 |
| Branches | 74.28% | **75.21%** (4,090 / 5,438) | same |
| Functions | 68.59% | **75.32%** (800 / 1,062) | same |

The first attempt this round stopped at suite 3 with ENOTEMPTY — a clean-up race,
not a failed check. That was fixed as `CODE-029` and the run repeated; the numbers
above are from the repeat.

## Size

| | Before | After | How |
|---|---|---|---|
| Tracked files | 243 | **250** | `git ls-files \| wc -l` |
| Lines of code | 76,108 | **80,300** | same filter as BASELINE |
| `server/app.js` | 1,663 | 1,708 | `wc -l` |
| HTTP route handlers | 111 | **112** — `GET /api/worker/jobs/:id`, the cancellation poll | one regex applied to `git show` of both revisions |
| `SCHEMA_VERSION` | 17 | **18** — `chats.next_seq` (`ARCH-007`) | `pg.js` |
| Commits on the branch past `3e8273e` | — | 77 commits, 78 files, +6,437 / −1,071 | `git rev-list --count`, `git diff --shortstat` at `9db11a2` |

## Token cost per turn

| | Before | After | How |
|---|---|---|---|
| Tool catalogue @128k | 48 tools, 6,896 tok | **48 tools, 6,896 tok** | `availableTools(...)`, `JSON.stringify().length/4` |
| @40k / @8k | 4,401 / 4,325 | **4,401 / 4,325** | same |
| System prompt: no worker / worker+desktop / read-only | `[UNKNOWN]` on 09-09 | **1,791 / 3,592 / 1,231** | `buildSystemPrompt(v).length/4` |

No per-turn token regression from anything added. New ceilings bound spend
instead: a per-turn token limit on shared keys (`PERF-009`), a cautious output
budget for sparse catalogue entries (`PERF-010`, `PERF-013`).

## Measured security and correctness — each a test that failed before its fix

| ID | Before | After | How |
|---|---|---|---|
| SEC-015/019 | browser, file, shell, GitHub, Notion output reached the model as trusted text | enveloped at one choke point | isolation.test.mjs |
| SEC-016 | MCP http transport re-opened DNS rebinding | pinned lookup, manual redirects | mcp.test.mjs |
| SEC-023 | readonly/plan ran an unoffered `delete_file` with no prompt | refused at execution | agent.test.mjs |
| SEC-025 | a dangling link wrote outside the workspace | refused | workspace.test.mjs |
| SEC-026 | a sub-agent ran tools it was never offered | refused | agent.test.mjs |
| SEC-029 | one bad MCP tool, or two same-slug servers, failed every turn | 10 names for 5 tools → 5 | mcp.test.mjs, negative control on HEAD |
| SEC-030 | unlimited unapproved sends under `auto` | five per turn | agent.test.mjs |
| SEC-031 | a copied key went to the provider | redacted, model told | isolation.test.mjs |
| SEC-032 | worker accepted plain http to the internet | refused before pairing | `SERVER_URL=http://example.com node worker/index.js` → exit 1 |
| ACC-007 | after compaction the model saw only the summary | summary + recent turns + the question | agent.test.mjs |
| AUTO-007/008 | resume re-ran a started `send_email`; a superseded run could still write | not re-run; aborted as superseded | agent.test.mjs |
| AUTO-009 | cancelling a tool left the process running | worker polls, kills the tree | system.test.mjs — a 30 s command ends in under 10 s |
| ARCH-009 | a failed PGlite schema replay left half a schema | rolled back | schema.test.mjs, negative control on HEAD |
| GAP-008 | `generate_image` called an endpoint shut down 2026-08-17 | current model, shape checked against installed SDK types | cloud unit test with a stand-in client — **not run live** |

## Ledger reconciliation

`audit/ISSUE_LEDGER.md`, counted by script over every row: **143 rows, no duplicate
IDs, 0 OPEN.**

| Status | Count |
|---|---|
| FIXED | 123 |
| DOWNGRADED (with the reason in the row) | 11 |
| RESOLVED | 3 |
| DUPLICATE (kept, never deleted) | 1 |
| BLOCKED — need something only the owner can authorise | 3 — `GAP-005`, `GAP-006`, `CODE-021` |
| PROPOSED — features for the owner to decide | 2 — `GAP-010`, `GAP-011` |

`audit/GAP_ANALYSIS.md` re-score: ĐẠT **31 → 51**, CHƯA ĐẠT **22 → 1** (H3, proposed
as `GAP-011`), one `[UNKNOWN]` (latency, needs a live key).

## Not measured, and why

- **End-to-end latency, LLM calls and tokens per real request, `eval:live`.** Need a
  live provider key; spending the owner's credit was never authorised.
- **The new image path against Google.** Same reason. The request and response
  shape were checked against the installed `@google/genai` type declarations only.
- **About six worker-agent findings that never arrived.** Not reconstructed from
  memory; a bounded re-scan of `worker/` stands in for them and is labelled as such
  in the ledger.

## Regression checks

| Check | Result | How |
|---|---|---|
| Diff against the safety net | 79 files, +6,679 / −1,071. **No lockfile, no `.env`, no deleted file.** One rename, `claude.md` → `CLAUDE.md` (`CFG-016`). `.env.example` changed only in comments and blank variable names | `git diff --stat` / `--name-status backup/pre-optimize-20260909-2011..HEAD` |
| Skipped tests | **One, platform-conditional:** `desktop.test.mjs` skips window listing, clicking and typing through the Node host on Windows, because Windows desktop control goes through `worker/desktop/host.ps1`. It runs on macOS and Linux (CI is ubuntu). Nothing was skipped to make a run pass | gate log, every `–` line read |
| `.typecheck-baseline.json` | **shrank** 363 → 362 | file diff |
| Secrets in the new commits | **0 real.** Two scanner hits, both deliberate fake fixtures in `test/http.test.mjs` that test the redactor itself (`sk-or-v1-0123456789abcdef…`, `postgres://user:hunter2@db.example`) | patterns for `sk-`, `AIza`, `gh*_`, `xox*`, `AKIA`, private keys, credentialed URLs, env assignments with values, personal email domains, over `git log -p` of every new commit and message |
| The app, running | **passes** — output below | `node server/index.js` on a throwaway `DATA_DIR`, port 5199, database and provider-key variables blanked so no hosted database or paid API could be reached |

```
GET  /api/session (anonymous)      200  {"authed":false}
POST /api/register                 201  {"role":"admin"}
GET  /api/session                  200  {"authed":true}
GET  /api/bootstrap                200  {"toolPolicy":"guarded","keys":10}
POST /api/projects                 201  {"id":true}
GET  /api/projects                 200  {"count":1}
GET  /api/mcp                      200  {"servers":0}
POST /api/mcp (private http)       400  {"error":"That server did not start: 127.0.0.1 is a private address. This tool o"}
GET  /api/admin/users              200  {"users":1}
GET  /api/worker/jobs/x (no token) 401
POST /api/logout                   200
GET  /api/session (after logout)   200  {"authed":false}
server log lines: 15, error-looking lines: 0
```

`CMD_RUN_LOCAL` itself (`npm start` → `scripts/launch.js`) was not used for this: it
opens the real data directory, and `test/schema.test.mjs` records the day a second
process on that directory destroyed its conversations. The server entry it launches
is the one exercised above. No model turn was sent — that needs a live key.

## Corrections to this audit's own findings

| ID | First said | Measured |
|---|---|---|
| E11 (Phase 1) | Path containment **ĐẠT** | Wrong: a dangling link walked out until `SEC-025` |
| SEC-024 | Backend agent's F2 | F2 was sub-agent nesting, fixed as `SEC-026`; SEC-024's own content stays DOWNGRADED |
| ACC-007 | HIGH | **CRITICAL** — after compaction the model got the summary and nothing else, not even the question |
| SEC-018 | 2 unredacted log sites | **10** |
| CODE-020 | uncoerced `bigint` is a bug | real at the boundary, harmless at the only consumer — DOWNGRADED |
| PERF-011 | `upsertModels`/`replaceDocChunks` are N+1 and non-transactional | wrong on both counts; the one real residual became `PERF-012` |
| CODE-028 (store F5) | `updateUser` role unvalidated is a hole | its only role-carrying caller whitelists first — DOWNGRADED |
| PERF-014 (store F6) | `listUsers` correlated subqueries are slow | both index-backed, admin-only — DOWNGRADED |
| SEC-031 (F8c) | three read-only tools graded too loosely | one real (`clipboard_read`); `extract` and `browser_hover` are the same class as tools already accepted |
| PERF-010 | fixed | bypassed through `resolveModel`; really fixed by `PERF-013` |
| CFG-019 | first narrowing fixed it | it did not (`pending.length === 0` still swallowed reports); the second change, approved by the owner, did |

## Mistakes made during the work

- **"Gate green" was reported as if it meant "CI green", and it did not.** Every gate run in this round was on Windows. CI (ubuntu) had been red since 2026-09-02 — first on a hook check that assumes Windows paths (`CFG-022`), then on this round's own cancellation fix, which killed only the shell on Linux (`CODE-030`). Nobody looked at CI until the owner pushed and GitHub emailed. Logged as `CFG-023`; the handover table ticked gates 1 and 2 on local evidence only.
- The shell and the edit tool collapse a doubled backslash, and it bit five times:
  a raw NUL written into `server/agent.js` (`CODE-022`, now guarded by a test),
  regexes that silently lost their escapes, and a newline escape that became a
  literal line break. Each was caught by reading the bytes back, never by a check
  passing.
- A `String.replace` whose replacement contained `` $` `` spliced the whole file
  into itself (`server/mcp/registry.js`). Caught by lint's duplicate-declaration
  error before any commit; redone with function replacers.
- `git stash push --keep-index` was used mid-edit and captured a broken test file;
  dropped after confirming the staged work survived in the index.
- `CODE-016` introduced a regression (a superseded run persisted partial text) that
  its own suite did not catch at first; fixed with an abort reason.
- `PERF-010`'s fix was bypassed through `resolveModel`, found later as `PERF-013`.
- Three commits carry two IDs each (`9b3ffc2`, `9a0ba2a`, `3e72a86`), and `16de288` bundled two; recorded in the ledger.
- One gate run went red with the failing step not captured and was green on an
  unchanged re-run. Recorded rather than explained away.

---

# Round 1 — 2026-09-03 → 2026-09-04

Before = `6d10ae4`, the commit this audit started from.
After = `integrate/2026-09-04`, merged with `origin/main`.

---

## The gate

| Thing | Before | After | How measured |
|---|---|---|---|
| `npm run gate` scope | lint, test, test:hooks | lint, hooks, **eval**, **typecheck**, test | `.claude/hooks/gate.js` STEPS.full |
| Gate verdict | **green while typecheck was red** | green, and typecheck is in it | `gate.js status` → `verified:true`; `node scripts/typecheck.js` |
| `test:ui` | **skipped itself — no browser installed** | **runs; exit 0, 0 failures** | `npm run test:ui` |
| `test:sandbox` | skipped itself | runs; exit 0 | `npm run test:sandbox` |
| Suites in `npm test` | 31 (documented as "24" in 5 places) | 31, and the docs no longer name a number | `p.scripts.test.split('&&').length` |
| Hook checks | 114 | **128** — the protected-branch rules can now be *granted*, not only removed | `npm run test:hooks` |

The first row is the one that mattered. A stamp reading `verified: true` over a
tree CI would reject is worse than no stamp, and it is what let seven type errors
sit in a staged working tree unnoticed.

## Type checking

| | Before | After |
|---|---|---|
| Real `tsc` errors | 436 | 397 |
| Recorded ceiling | 429 | **397** |
| Errors above the ceiling | **+7** | 0 |
| `server/app.js` | 11 | **0** |

The ceiling moved **down** 32, never up. Every reduction came from fixing a real
contract — four functions that destructured arguments without saying which were
optional — rather than from re-recording the baseline to swallow a failure.

## Size

| | Before | After |
|---|---|---|
| `server/app.js` | 2,838 lines, ~93 routes in one file | **1,663** |
| `server/routes/` | did not exist | 6 modules, 1,296 lines |
| `public/js/app.js` | 4,787 | **4,154** — split **13.5%**, not fully; see below |
| `public/js/` client modules | 20 | 24 |

The client split is **partial and is reported as partial**. Four self-contained
sections came out — attachments, devices, model news, two-factor: 647 lines. Two
that the finding also named did not: `the gate` (317 lines) and `MCP servers`
(557) each borrow 25 identifiers from module scope and both read and write shared
mutable state, so moving them is a decision about who owns that state, not a cut
and paste. `ARCH-005` records this rather than closing on the easy 13.5%.

## Interface language

| | Before | After |
|---|---|---|
| Hardcoded English strings in `public/js` | **90** by the first scanner | **0** by that same scanner — **the scanner was wrong** |
| Same thing, measured properly | **138 candidates** | **38 — and every one of the 38 is markup, CSS or a string no person sees** |
| Locale keys | 412 | **670** |
| English/Vietnamese key parity | — | 670 = 670, no key in one and missing from the other |
| The sign-in gate | **no `gate.*` keys at all** | fully translated |

Reported as "~200 strings". The first scanner said 90; those 90 were fixed and
the same scanner then said 0, which is how this table came to claim the interface
was fully translated. It is not. Asking the instrument that defined a set whether
the set is empty is not a measurement, and the "0" stood in this file for three
days.

A second scanner — strips tags, CSS and `${}` interpolations from each literal,
then asks whether what is left is prose — finds **138**. Those 138 were worked
through: 100 translated, and the remaining **38 read one by one and classified**
— ~28 class lists, CSS, SVG and CSP markup; 8 `autopreview.js` decision reasons
that a pure function returns and nothing renders; 1 `postMessage` error for an
operation the page cannot send; 1 HTML comment used as a DOM marker. Logged as
**GAP-002** and now closed.

Two real bugs came out of the sweep, neither of which any test caught:
`loadTasks` bound its map parameter to `t`, shadowing the translator across the
entire scheduled-tasks block, and `workflows.js` built two label maps as object
literals at import — the same import-time freeze that `CODE-007` fixed in
`render.js`, sitting in a second file the whole time.

## Measured performance

| | Before | After | How |
|---|---|---|---|
| Project-shelf re-rank, per turn | 70.7 ms | **0.6 ms** | 2.4M-character shelf, 40 files, `process.hrtime.bigint()` around `selectSources` |
| RAG query embedding | one network round trip per search | cached 5 min, keyed by provider+model+text | counting stub in `rag.test.mjs` |

## Measured security

| | Before | After | How |
|---|---|---|---|
| XSS via attachment filename | **live** — rendered span gained an `onmouseover` attribute | inert | Chromium: `getAttributeNames()` before and after |
| `launch_app` metacharacters | **`notepad&ver` ran `ver`** | argv only, no shell | `spawnSync` with `echo` in place of `start` |
| Widget outbound requests | **3 beacons fired per render** (img, SVG image, CSS url) | **0** | Chromium with requests intercepted |
| stdio MCP server | any signed-in account | administrator only | `http.test.mjs`: 403 for a user, 200 for an admin |
| API keys in URLs | 2 (Google embed + probe) | 0 | both files read with comments stripped |

## Schema

| | Before | After |
|---|---|---|
| `SCHEMA_VERSION` | 16 | **17** |
| Indexes on hot predicates | 4 missing | added |
| Pairing code uniqueness | documented as needed, not attempted | partial unique index + backfill |

Verified against a real PGlite database: all five indexes present, version 17
stored, a duplicate unclaimed code refused, a claimed one still accepted.

---

## What is not measured, and why

**End-to-end latency and LLM calls per request.** Needs a live provider key.
Not run — spending the owner's credit was never authorised, and a number
invented here would be worse than none.

**Whether the interface suite covers what it appears to.** It passes, and it now
genuinely runs, but its coverage is not itself measured. Its value was
demonstrated rather than estimated: the first time it could run it caught two
real regressions this audit had introduced and every other check had missed.

**`.c8rc.json` coverage.** Recorded 2026-09-02 at 57.81/74.28/68.59 and not
re-measured; instrumenting every suite roughly doubles a run that is already
minutes long, and nothing in this audit changed which files are exercised.

---

## Corrections to this audit's own findings

Six findings were wrong or overstated, and were corrected against evidence
rather than quietly dropped. They are listed because an audit that only reports
what it got right is not an audit.

| ID | Claimed | Measured |
|---|---|---|
| PERF-002 | 16,900 tokens fixed per turn | **~10,500** — I sized `TOOLS`, not what a turn sends; deferral already cuts a 128k-window turn to 48 tools |
| ARCH-001 | pgvector probe wastes a round trip | probe already checks the column; no waste — an unrealised optimisation, not a defect |
| EXP-001/002 | prompts and catalogue leaked to the browser | **no system prompt reaches the client**; what is there is UI copy and display logic |
| CODE-011 | 2 empty catches, 1 TODO | 1 real; the others were PowerShell inside a template string and a user-facing example prompt |
| CODE-005 | 50 console.log with no logger | 2 on a request path; the rest are CLI banners |
| GAP-001 | ~200 hardcoded strings | 90 |
| GAP-001 (again) | "90 → 0, fully translated" | **~130 were still untranslated.** The 0 came from re-running the scanner that had defined the 90. Logged as GAP-002 |
| ARCH-005 | app.js is 4,677 lines | 4,787 when the work started; now 4,140 — a 13.5% split, not the six-way one the finding described |

## Mistakes made during the work

- A regex-based script cut through `#model-search`'s placeholder because the
  attribute contains a literal `>`. Caught by reading the diff line by line.
- `git checkout --theirs` was used to resolve fourteen merge conflicts, which
  takes whole files and would have discarded 557 lines of other people's work in
  `pg.js` alone. Caught by measuring what the other side had changed; the
  attempt was thrown away and redone hunk by hunk.
- `.typecheck-baseline.json` was tightened to 416 and left out of the commit, so
  the tree advertised 419 while the working copy enforced 416. Caught by
  `git status` after the gate went green.
- Lint results were being read as `npx eslint . | tail -3; echo $?`, which
  reports **tail's** exit status. Every "lint=0" from that pattern was
  meaningless. The gate was never fooled.
