# BASELINE — measured before any change

## Vòng v3 — 2026-10-04, `main` @ `58b1ab4`, cây sạch

Đo trước khi sửa bất cứ thứ gì trong vòng v3. Đây là cột Phase 3 phải so sánh.

| Chỉ số | Cách đo | Giá trị | Nhãn |
|---|---|---|---|
| `npm run gate` (full) | chạy thật, log `scratchpad/gate-baseline.log` | **exit 0, 255 s**, stamp `2026-10-04T15:50:09Z` trên `58b1ab4` | [FACT] |
| lint | bước 1 của gate | exit 0 | [FACT] |
| test:hooks | bước 2 | **168/168** | [FACT] |
| eval (scripted) | bước 3 | **13/13**, PROMPT_STAMP `ecd004bc42ae` | [FACT] |
| typecheck thật | bước 4 | **315 lỗi treo, trần 315**, 39 file (vòng trước @6e526f1: 349 / 43 file → co 34) | [FACT] `.typecheck-baseline.json` |
| `npm test` | bước 5 | exit 0 · **4.282 dấu ✓** trong log · **1 skip**: `desktop.test.mjs` "window listing, clicking and typing (those go through host.ps1 on Windows)" | [FACT] |
| Suite trong `npm test` | `scripts.test.split('&&')` | 47 (trên 50 file `*.test.mjs`; `ui`, `sandbox` chạy trong CI; xem CODE- về `capabilities`) | [FACT] |
| coverage | `npm run coverage` (c8, `all:true`), exit 0 | **statements 64.09% (46175/72042) · branches 75.42% · functions 67.03% · lines 64.09%** — ngưỡng `.c8rc.json` 56/73/67/56; functions chỉ hơn ngưỡng 0,03 điểm | [FACT] `scratchpad/coverage-baseline.log` |
| Lời gọi LLM / request, token input/cache/output, cache hit, chi phí, độ trễ, TTFT | cần key thật + request thật | **[UNKNOWN]** — máy này không có key provider trong env của agent (`.env` bị chặn đọc, đúng luật); bảng `usage` production không truy cập được từ repo; đo bằng dữ liệu người dùng thật bị cấm (§6). Đo được tĩnh: xem `audit/RESULT.md` mục token theo code. | [UNKNOWN] |
| Điểm gửi dữ liệu ra ngoài (fetch/safeFetch/https.request) trong `server/`+`api/` | `scratchpad/fetch-scan.mjs` | **45 lời gọi**, 45/45 có `signal`/timeout (1 cảnh báo giả: `server/email.js:146`, signal ở `:161`) | [FACT] |
| Host bên ngoài nhận dữ liệu | grep `https://` trong `server/` | xem `audit/DATAFLOW.md` | [FACT] |
| Điểm log nội dung | grep `console.log/info/debug` server+api+worker | 64 dòng (phần lớn `worker/` CLI); `console.warn/error` trong server: 2 | [FACT]; phân loại nội dung → DATAFLOW |
| Analytics/APM/error tracker trong code | grep Sentry/posthog/gtag/@vercel/analytics | **0 SDK** (chỉ tên Sentry trong catalogue MCP) | [FACT] |
| Secret hardcode (hình dạng key) | regex `sk-ant-/sk-or-/sk-proj-/sk-orca-…`, `AIza…`, `ghp_…`, `xoxb-/xoxp-…`, PEM | **0** | [FACT] |
| TODO/FIXME/XXX/HACK | grep | 1 | [FACT] |
| Prod | `HEAD https://synapsez.vercel.app/` | 200, CSP đúng `vercel.json`, `X-Vercel-Cache: HIT` | [FACT] |

---

Two baselines are kept. The 2026-09-03 column is the one the earlier audit round
was measured against; the 2026-09-09 column is this session's re-measurement and
is the one Phase 2 and Phase 3 must be compared to. Nothing here is estimated
unless the row says so.

**2026-09-09 state:** branch `main`, HEAD `3e8273e`, **working tree clean**.
`gate.js status` → `verified: true`, `current: true`, `scope: full`, stamped
against `3e8273e`. Every green below was re-run by hand this session rather than
read off that stamp.

---

## The gate

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| `npm run gate` scope | `.claude/hooks/gate.js:270-282` (`STEPS.full`) | lint + test + test:hooks | **lint + test:hooks + eval + typecheck + test** | `[FACT]` |
| `npm run check` scope | `package.json:19` | six steps | lint + typecheck + test + eval + test:sandbox + test:hooks | `[FACT]` |
| Gate stamp | `node .claude/hooks/gate.js status` | `verified:true` over a red typecheck | `verified:true`, and typecheck is inside the gate | `[FACT]` |
| **Is the gate real?** | compare scope against CI | **NO — stamped green over 7 type errors** | **YES.** The one remaining honest gap is `test:ui` + `test:sandbox`, which need a browser and are run in CI only. The stamp says `full`, not `everything`, for exactly that reason. | `[FACT]` |
| `npm run lint` | `npx eslint .` | 0 problems, exit 0 | **0 problems, exit 0** | `[FACT]` |
| `npm test` | run to completion | pass, exit 0 | **pass, exit 0** | `[FACT]` |
| Suites in `npm test` | `p.scripts.test.split('&&').length` | 31 | **31** | `[FACT]` |
| `npm run test:hooks` | run | 114 checks | **128 checks, exit 0** | `[FACT]` |
| `npm run eval` | run | — | **13/13 cases pass, exit 0** (scripted; `--live` not run) | `[FACT]` |

## Type checking

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| Real `tsc` errors | `npx tsc -p jsconfig.json --noEmit \| grep -c "error TS"` | 436 | **363** | `[FACT]` |
| Recorded ceiling | `.typecheck-baseline.json` `total` | 429 | **363** | `[FACT]` |
| Errors above the ceiling | subtraction | **+7 (gate was lying)** | **0** | `[FACT]` |
| Files holding frozen errors | count of `files` keys | — | **43** | `[FACT]` |
| Ratchet verdict | `node scripts/typecheck.js` | red | **green — "363 outstanding (ceiling 363)"** | `[FACT]` |

The ratchet still swallows 363 real errors. It is honest about that — it fails
only when the number rises — but a green typecheck here means "no worse", not
"clean". `strictNullChecks` is not on; enabling it was measured at 1,979 errors
and is a project of its own.

## Size

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| Tracked files | `git ls-files \| wc -l` | 223 | **243** | `[FACT]` |
| Lines of code (tracked, code only) | `git ls-files \| grep -E '\.(js\|mjs\|css\|html\|sql\|ps1\|sh)$' \| xargs wc -l` | 72,880 | **76,108** | `[FACT]` |
| `server/app.js` | `wc -l` | 2,838 | **1,663** | `[FACT]` |
| `server/routes/` | `ls` | did not exist | **6 modules** | `[FACT]` |
| `public/js/app.js` | `wc -l` | 4,787 | **4,154** | `[FACT]` |
| HTTP route handlers | grep over `server/app.js` + `server/routes/*.js` | ~93 | **104** | `[FACT]` |
| `SCHEMA_VERSION` | `server/store/pg.js:189` | 16 | **17** | `[FACT]` |
| Providers | `Object.keys(PROVIDERS)` | 4 | **5** — anthropic, openai, google, openrouter, orcarouter | `[FACT]` |
| Locale keys | `Object.keys()` on each locale | 412 | **670 en / 670 vi, at parity** | `[FACT]` |

## Token cost per turn

Measured with `availableTools({ workerOnline:true, desktopOnline:true, context })`
and `JSON.stringify(...).length / 4`. The estimate divisor is the repo's own.

| Window | Tools offered | Est. tokens |
|---|---|---|
| whole `TOOLS` array (not what a turn sends) | 93 | 13,326 |
| 200,000 | 48 | **6,896** |
| 128,000 | 48 | **6,896** |
| 40,000 | 48 | 4,401 |
| 16,000 | 47 | 4,325 |
| 8,000 | 47 | 4,325 |

Deferral is real and it works: a 128k turn pays 6,896 rather than 13,326, a 48%
saving. Note the *count* barely moves below 40k — the saving there comes from
`firstSentence` description trimming, not from dropping tools.

`[UNKNOWN]` — the system prompt half of the per-turn cost was not re-measured
this session; the 2026-09-03 figures were 1,791 tok with no worker and 3,614 with
worker+desktop.

## Hygiene

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| `.env*` tracked or in history | `git ls-files`, `git log --all --diff-filter=A` | none | **none — only `.env.example`, values blank** | `[FACT]` |
| Hardcoded secret patterns | grep for `sk-`, `AIza`, `ghp_`, `xox`, credentialed URLs | 0 | **0** in `.env.example`; full-tree scan not re-run this session | `[FACT]` / `[UNKNOWN]` |
| `fetch(` call sites | scan of `server/ api/ worker/` | 30 | **30** | `[FACT]` |
| …without an abort signal | per-site scan, one hit read by hand | 3 | **0** — the single scanner hit (`server/mcp/client.js:247`) carries `signal: AbortSignal.timeout(timeoutMs)` 12 lines below the call | `[FACT]` |
| Empty `catch {}` | grep | 2 | **3** — not re-classified; the 2026-09-03 count found 2 of 3 to be grep artefacts | `[INFER]`, needs a read |
| `TODO/FIXME/HACK/XXX` | grep | 1 | **2** | `[FACT]` |
| `console.log` in `server/ api/ worker/` | grep | 50 | **58** | `[FACT]` — mostly CLI banners; 2 request-path sites were moved to the trace logger under `CODE-005` |
| Coverage | `.c8rc.json`, recorded 2026-09-02 | 57.81 / 74.28 / 68.59 | **not re-run** | `[UNKNOWN]` |

## Still not measured, and why

| Chỉ số | Nhãn |
|---|---|
| LLM calls per typical request | `[UNKNOWN]` — needs a live provider key |
| Token in/out per request | `[UNKNOWN]` — same |
| End-to-end latency (median of 3) | `[UNKNOWN]` — same. Spending the owner's credit has not been authorised, and a number invented here would be worse than none |
| External API calls per request | `[UNKNOWN]` — depends on which tools the model chooses |
| Repo visibility, read from the API | `[UNKNOWN]` — `gh` is not installed on this machine. The owner's statement that it is PUBLIC is taken as given |
