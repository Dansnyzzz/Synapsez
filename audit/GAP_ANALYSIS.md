# GAP ANALYSIS — Phase 1

Scored 2026-09-10 against `main` + `audit/server-worker-2026-09-09`, HEAD `21236f4`.
Gate green (full) at `4f1cd89`; every change since is markdown.

Each row is `ĐẠT` / `CHƯA ĐẠT` / `N/A` / `[UNKNOWN]`. Every `CHƯA ĐẠT` carries three
things, as the rules require: evidence at `file:line`, what top-tier would concretely
look like, and a ledger ID. Nothing says "cần cải thiện hơn".

---

## A. Độ chính xác & nghiên cứu (`ACC-`)

| # | Mục | Chấm | Bằng chứng | Top-tier trông như thế nào | ID |
|---|---|---|---|---|---|
| A1 | Kết luận quan trọng trích dẫn nguồn cụ thể kèm URL/ID | **ĐẠT** | `research/report.js` enforces markers; every claim carries `S#` ids resolved to URLs | — | — |
| A2 | Đối chiếu chéo ≥2 nguồn | **ĐẠT** | `confidence.js:66-69` — HIGH requires two independent registrable domains **that were opened** | — | — |
| A3 | Nhãn độ tin cậy | **ĐẠT** | HIGH/MEDIUM/LOW from `grade()`, CONFLICTING from the debate | — | — |
| A4 | Dữ liệu real-time lấy qua tool lúc chạy | **ĐẠT** | `gather.js` runs the live four-engine chain per query | — | — |
| A5 | Phản biện nội bộ trước khi chốt | **ĐẠT** *(deep_research only)* | `debate.js` proposer→critic→arbiter | — | — |
| A6 | Phát hiện nguồn mâu thuẫn | **ĐẠT, có điều kiện** | `confidence.js:11-13` states plainly that the grader only counts; CONFLICTING is the arbiter model's judgement, carried through honestly rather than computed | Code-level disagreement detection (claim-level clustering across sources) rather than a model self-report | — (documented limitation, not a defect) |
| A7 | Thang uy tín phù hợp thị trường phục vụ | **CHƯA ĐẠT** | `gather.js:4-7` — `REPUTABLE` is 12 Anglophone outlets, hardcoded; `confidence.js:71` | Source standing configurable per account, so a Vietnamese-market agency can register domestic outlets. VnExpress + Tuổi Trẻ + Thanh Niên, all fetched, should be able to reach HIGH | `ACC-006` |
| A8 | Model không trả lời khi thiếu ngữ cảnh | **CHƯA ĐẠT — nghiêm trọng** | `compact.js:141-165` + `agent.js:796` — after auto-compaction the provider receives the summary and **nothing else**; reproduced by execution | The turn that triggers compaction answers the question that was asked. Summary placed *before* the tail it does not cover | **`ACC-007`** |

## B. Tự động hóa & tool-use (`AUTO-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| B1 | Mỗi tool có timeout, retry có backoff, lỗi tường minh | **ĐẠT** | 30 `fetch` sites, **0** without an abort signal; `execute.js` `DEFAULT_LOCAL_TIMEOUT_MS` + `GRACE_MS`; `classify()` at `providers/index.js:154-174` separates retryable from fatal | — | — |
| B2 | Tool trả structured output, không parse text tự do | **N/A trên đường ra** | Tool results are prose by design — the model is the consumer | — | — |
| B3 | Validate schema đầu ra tool trước khi dùng | **CHƯA ĐẠT** | `openaiCompatible.js:192-199` — a failed argument parse becomes `{__unparsed}`; `grep -rn "__unparsed"` → **1 hit, the write**. `execute.js:172-185` checks the tool *name*, never the input shape | `strict: true` on the OpenAI-compatible tool definitions as `anthropic.js:141-150` already does, and a refusal — not a default-argument run — when arguments do not parse | **`AUTO-005`** |
| B4 | Tác vụ độc lập chạy song song | **ĐẠT** | `util/parallel.js:23`, `MAX_PARALLEL_TOOLS = 4` | — | — |
| B5 | Không còn bước thủ công lẽ ra tự động hóa được | **ĐẠT** | scheduler, workflows, cron, worker job queue | — | — |
| B6 | Có trigger/lịch cho việc lặp lại | **ĐẠT** | `scheduler.js` + `/api/cron/*`, DST-correct | — | — |
| B7 | Job chạy lại idempotent | **CHƯA ĐẠT** | `agent.js:698-735` — resume re-executes outstanding tool calls with no idempotency key; `workflows.js:200-222` and `claimDueTask` both refuse to, on the same kind of path | An idempotency key per tool call, stored with the call, checked before re-execution — so a resumed turn cannot send the same email twice | `AUTO-007` |
| B8 | Trạng thái chạy phản ánh kết quả thật | **CHƯA ĐẠT** | `scheduler.js:178` — `status` starts `'ok'` and only an error event or a throw moves it, so `max_steps` and every non-complete `stop.kind` store `last_status='ok'` | The stored status carries the same vocabulary `providers/stop.js` already produces, so a truncated unattended run is visibly truncated | `AUTO-006` |
| B9 | Huỷ tool thực sự huỷ | **CHƯA ĐẠT** | `execute.js:65-68` — the job is force-completed "Cancelled by the user" while the worker may still be running it | Cancellation propagates to the worker; the model is told what actually happened | `CODE-017` |

## C. Kiến trúc & mở rộng (`ARCH-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| C1 | Thêm agent/tool/khách hàng mới không phải sửa lõi | **ĐẠT** | `new-tool.md` names four fixed edit points; `CLOUD_IMPLEMENTATIONS` / `worker/tools.js` maps | — | — |
| C2 | Cấu hình theo khách hàng tách khỏi logic | **CHƯA ĐẠT** | `gather.js:4-7` — the reputable-domain list is a business rule with no per-account override, no store column, no config | Source standing, tone and house rules configurable per account | `ACC-006` |
| C3 | Không magic number lẽ ra là config | **ĐẠT** | `settings.js`, `LIMITS` exports, named constants throughout | — | — |
| C4 | Provider LLM được trừu tượng hoá | **ĐẠT** | `providers/index.js` `streamOne` switch; five providers, three adapters | — | — |
| C5 | Ranh giới module rõ, không phụ thuộc vòng | **CHƯA ĐẠT** | 3 cycles over 76 modules — `execute→cloud→subagents→execute`, and `agent→execute→cloud→{scheduler,workflows}→agent` | No cycles. Failing that, an explicit test asserting no member evaluates an imported binding at module top level — the property that currently keeps them harmless and that nothing checks | `ARCH-008` |
| C6 | Một bản cài store, không trôi lệch | **ĐẠT** | `pglite.js:4`, `:203-208` — thin driver adapter into `createPgStore`, overrides nothing | — | — |
| C7 | Ghi transcript an toàn khi ghi đồng thời | **CHƯA ĐẠT** | `schema.sql:178` is a plain index; `pg.js:1011` computes `MAX(seq)+1` | Unique `(chat_id, seq)`, reached by backfill-then-constrain — **not** a blind index add | `ARCH-007` |

## D. Hiệu năng & chi phí (`PERF-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| D1 | Cache cho dữ liệu lặp, có TTL và invalidate | **ĐẠT** | RAG query cache (5 min, bounded at 64); project shelf re-rank 70.7ms → 0.6ms with pinned invalidation | — | — |
| D2 | Không gọi LLM cho việc không cần LLM | **ĐẠT** | `roleModel.js` moves compaction/extract/plan to the cheap tier; `calc`, parsers and rankers are code | — | — |
| D3 | Trần ngân sách token / số lời gọi mỗi request | **CHƯA ĐẠT** | `settings.js:11` `maxSteps: 30` is a **count**; grep finds no token or cost bound per request. Distinct from `PERF-003` (monthly quota, closed) | A per-turn token and cost ceiling, enforced between steps, surfaced to the user when hit | `PERF-009` |
| D4 | Streaming khi UX cần | **ĐẠT** | SSE token-by-token from all three adapters | — | — |
| D5 | Chọn model theo độ khó tác vụ | **ĐẠT** | `roleModel.js`, `autoPick.js` | — | — |
| D6 | Output budget đúng cửa sổ của model | **CHƯA ĐẠT** | `providers/index.js:66-71` returns a flat **32,000 unclamped** when an entry has neither `maxOutput` nor `context` — the aggregator path, i.e. OpenRouter/OrcaRouter | The clamp applies on every path; a sparse entry gets a conservative budget, not the largest one | `PERF-010` |
| D7 | Không N+1 trên driver một-round-trip-mỗi-câu | **CHƯA ĐẠT** | `rag.js:239` — `for (…) await store.replaceDocChunks(…)`, one round trip per file. The store method itself is bulk | One call for the whole batch. 40 files should cost one round trip, not 40 | `PERF-012` |
| D8 | Độ trễ end-to-end hợp lý | **[UNKNOWN]** | Never measured — needs a live provider key, and spending the owner's credit was not authorised | — | — |

## E. Bảo mật (`SEC-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| E1 | Không secret trong code/client/lịch sử git | **ĐẠT** | No `.env*` tracked or ever committed; 0 hardcoded key patterns; the two historical `.fuse_hidden` files read and found benign | — | — |
| E2 | Không secret trong log | **CHƯA ĐẠT** | `util/trace.js:102-107` emits `errMsg: error.message` unredacted; **10** `log.error` call sites, several unpacking provider errors. `readableFailure` redacts the same string on the way to the browser | `redactSecrets` on the log path too — one choke point, as the response path already has | `SEC-018` |
| E3 | Input validate trước khi vào tool/exec | **CHƯA ĐẠT** | `execute.js:172-185` validates the tool name only — see B3 | — | `AUTO-005` |
| E4 | Chống prompt injection từ nội dung web | **CHƯA ĐẠT — nghiêm trọng** | `untrusted()` has **5** call sites; the local/worker branch of `executeTool` wraps nothing, so `browser_look` delivers a page as trusted text while `web_fetch` on the same URL is enveloped. GitHub/Notion likewise | Every path carrying content the model did not author is enveloped, without exception, and the envelope is applied at the choke point rather than per-tool | `SEC-015`, `SEC-019` |
| E5 | Rate limit + giới hạn quyền cho lời gọi ra ngoài | **ĐẠT, có ghi chú** | `ratelimit.js` on auth routes, DB-backed, `trust proxy` at one hop. It fails open by design and logs nothing when it does | A log line when the limiter is bypassed, so the window is visible afterwards | `SEC-020` |
| E6 | Endpoint có auth đúng mức | **ĐẠT** | Routes re-read this round; `/api/pair/poll` is deliberately unauthenticated and safe (UUID-keyed, one-time, TTL, rate-limited) | — | — |
| E7 | SSRF — mọi fetch model nhắm được đi qua `safeFetch` | **CHƯA ĐẠT** | `mcp/client.js:357` calls `assertPublic` and **discards the records it returns**; `:247` then uses bare `fetch`. `safeFetch.js:96-108` documents this exact TOCTOU as the reason pinning exists | Every outbound hop pinned to the address that was checked, MCP included | `SEC-016` |
| E8 | Không tool phá hoại nào bị chấm `ordinary` | **CHƯA ĐẠT** | `definitions.js:1892-1895` — the shell regex omits `python`, `node`, `perl`, `ruby`, `mshta`, `wscript`, `cscript`, and misses `zsh` | Grade by *what the target can do*, not by a name list; unknown executables default to sensitive | `SEC-017` |
| E9 | Repo public — không prompt/khoá trong `public/` | **ĐẠT** | Re-checked: no system prompt reaches the client (`EXP-001` downgraded on evidence) | — | — |
| E10 | Repo public — không file `TUYỆT ĐỐI KHÔNG` bị track | **ĐẠT** | `data/` never committed; no customer data tracked | — | — |
| E11 | Ranh giới chứa đường dẫn | **ĐẠT** | `worker/paths.js:84-110` — `path.relative` not `startsWith`; realpath of the deepest existing ancestor; absolute/UNC/drive-relative all refused. `set_workspace` moves the boundary but is `ALWAYS_SENSITIVE` | — | — |
| E12 | Tenancy | **ĐẠT** | Store scoped by `user_id` throughout; `screenHub` rooms keyed per account; `localTools` sinks owner-bound; `deviceHint` matched against the account's own machines | — | — |

## F. Chất lượng code & vận hành (`CODE-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| F1 | Có test cho logic lõi | **ĐẠT, có lỗ** | 31 suites, 142 hook checks, 13 eval cases. But `activeTranscript` — the function `ACC-007` lives in — is covered by **nothing** | A failing test for `ACC-007` written before the fix | `ACC-007` |
| F2 | Log đủ để debug, có trace id | **ĐẠT** | `util/trace.js` AsyncLocalStorage; every line in a turn carries the request id | — | — |
| F3 | Không trùng lặp logic lớn | **ĐẠT** | `CODE-007` rollup closed; `branch.js` now holds the one definition of the git fence | — | — |
| F4 | Tài liệu khớp code | **CHƯA ĐẠT** | `migrate.md:12` says schema 12, it is 17; `ship.md:65` says "twenty-four suites", it is 31 across 5 steps; `api-conventions` says every route is in `app.js`, six groups moved to `routes/`; `README.md:1598` says four providers, there are five | Every stated number checked against the code, and the spelled form grepped as well as the digits | `CODE-012`, `CFG-015`, `CODE-013`, `CODE-014`, `CODE-015` |
| F5 | Lỗi có phân loại retryable vs fatal | **ĐẠT** | `classify()` at `providers/index.js:154-174` — status before message text, 429 rests the key, 401/402/403 kill it, 5xx/408 retry with backoff | — | — |
| F6 | Không mất công việc đã trả tiền | **CHƯA ĐẠT** | `agent.js:943` persists the assistant message only after the stream ends; Stop or a mid-stream death discards text the user watched arrive, and the next turn re-sends and re-bills | Streamed text persisted incrementally, so a stop keeps what was produced | `CODE-016` |

## G. Trải nghiệm đầu ra (`UX-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| G1 | Output nhất quán, đạt chuẩn giao khách hàng | **ĐẠT** | `skills/builtin.js` carries the document conventions per format, loaded only when they apply | — | — |
| G2 | Tuỳ biến theo khách hàng qua config | **ĐẠT một phần** | User skills, project briefings and `prefs.systemPrompt` exist; source standing does not — see C2 | — | `ACC-006` |
| G3 | Phân tách kết luận chắc chắn vs giả định | **ĐẠT** | Confidence labels on research output; the untrusted envelope marks what the model did not author — where it is applied (see E4) | — | — |
| G4 | Trạng thái tiến trình + lỗi dễ hiểu | **ĐẠT, có lỗ** | SSE `status` phases, `stopNote` for truncation/refusal, approval bar with `aria-live`. But every `toast(err.message)` is server-authored English — the server has no locale | Error codes, or an account-language header, so a Vietnamese user gets Vietnamese failures | carried from the i18n round — still open, no ID assigned yet |
| G5 | Accessibility | **ĐẠT** | `ACC-002…005`, `UX-001…004` all closed: 19 controls named, tablists real, menus focus-managed, keyboard trap gone, contrast raised | — | — |

## H. Tối đa hoá năng lực model (`GAP-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| H1 | Structured output / tool-calling thay vì parse text | **ĐẠT một phần** | Tool-calling throughout; `anthropic.js:141-150` sets `strict: true`. `openaiCompatible.js:153` does not — see B3 | — | `AUTO-005` |
| H2 | Context nạp đủ và không dư; chiến lược cắt/nén | **CHƯA ĐẠT** | The strategy exists and is well designed — `COMPACT_AT` 0.82, `KEEP_RECENT` 8, chained summaries — and it is **wired up wrongly**: the tail it keeps never reaches the model | The design as written: summary, then the tail | **`ACC-007`** |
| H3 | Model tự kiểm tra trước khi trả kết quả quan trọng | **CHƯA ĐẠT** | `debate.js` does proposer/critic/arbiter for `deep_research` only; the main agent loop has no self-check step at any point | A verification pass before an expensive or irreversible answer, as the research pipeline already demonstrates is worth it | *(no ID — deliberate design space, raised as a creative gap below)* |
| H4 | Prompt tách khỏi code, versioned, A/B được | **CHƯA ĐẠT** | `agent.js:34-330` builds 4,922–14,369 chars from JS literals; `grep PROMPT_VERSION\|prompts/` → 0 hits | Prompts as versioned data with an id recorded on each turn, so two variants can run side by side and the eval can attribute a change | `GAP-003` |
| H5 | Eval bộ case cố định | **ĐẠT một phần** | `test/eval/` 13 cases in the gate, deterministic, no key needed. `eval:live` is implemented and **has never been run** | The live run in a nightly, so prompt edits are measured rather than assumed | `GAP-003` |
| H6 | Chi phí cố định mỗi lượt được quản lý | **ĐẠT** | Deferral cuts a 128k turn from 13,326 to **6,896** est. tokens of catalogue; `firstSentence` trimming below 40k; `cache_control: ephemeral` on the system block | — | — |

---

## Điểm tổng

| Nhóm | ĐẠT | ĐẠT một phần / có ghi chú | CHƯA ĐẠT | [UNKNOWN] |
|---|---|---|---|---|
| A Độ chính xác | 5 | 1 | 2 | 0 |
| B Tool-use | 4 | 0 (1 N/A) | 4 | 0 |
| C Kiến trúc | 4 | 0 | 3 | 0 |
| D Hiệu năng | 4 | 0 | 3 | 1 |
| E Bảo mật | 6 | 1 | 5 | 0 |
| F Chất lượng | 3 | 2 | 2 | 0 |
| G Đầu ra | 3 | 2 | 0 | 0 |
| H Năng lực model | 2 | 2 | 3 | 0 |
| **Tổng** | **31** | **8** | **22** | **1** |

The single `[UNKNOWN]` is end-to-end latency, and it stays that way: it needs a live
provider key, and spending the owner's credit was never authorised. A number invented
here would be worse than none.

## Ba điều đáng chú ý về hình dạng của kết quả này

**Phần lớn cái sai không phải do thiếu hiểu biết — mà là một cơ chế đúng bị nối sai chỗ.**
`ACC-007`: the compaction design is careful and its own doc line states the invariant;
the summary is simply appended where the invariant says it must not be. `SEC-016`:
`assertPublic` was rewritten to return its records *specifically* so callers could pin,
and one caller throws them away. `SEC-015`: the untrusted envelope was extended to
`search_docs` on the stated grounds that it was the only unenveloped path; the whole
worker branch was never wrapped. `PERF-010`: the clamp exists and is skipped.
`CFG-018`: the docs exemption was built and stops at the commit boundary.

**Cái vá rồi mở lại chiếm tỷ lệ cao hơn cái chưa từng vá.** Four of this round's
findings are re-openings of classes this repo has already closed once, at a different
door. That is an argument for fixing at choke points rather than at call sites.

**Bốn trong bốn claim của agent mà tôi kiểm sâu đều lệch.** Two up (`ACC-007` High→Critical,
`SEC-018` 2 sites→10), two down (`CODE-020` and `PERF-011` downgraded to non-defects).
The `Prov` column is not bureaucracy; it is the difference between an audit and a rumour.

---

## Re-score — Phase 3, 2026-09-14

Re-judged against the tree at `013c916` (gate green, full). The Phase 1 table above
is kept as it was scored; this section is what is true now. A row moves only when
every ID it cites is `FIXED` in `ISSUE_LEDGER.md` (checked by script, not by eye), or
when this round found the Phase 1 verdict itself was wrong.

| Row | Phase 1 | Now | Why it moved, or why it did not |
|---|---|---|---|
| A7, C2, G2 | CHƯA ĐẠT / một phần | **ĐẠT** | `ACC-006` FIXED — regional national press carries standing; `RESEARCH_REPUTABLE_DOMAINS` extends it |
| A8, F1, H2 | CHƯA ĐẠT / có lỗ | **ĐẠT** | `ACC-007` FIXED — the summary records the seq it covers; recent turns and the question survive |
| B3, E3 | CHƯA ĐẠT | **ĐẠT** | `AUTO-005` FIXED — a truncated call is refused, not run on defaults; `GAP-004` validates arguments server-side for every provider |
| B7 | CHƯA ĐẠT | **ĐẠT** | `AUTO-007` FIXED — started non-read-only calls are not re-run on resume |
| B8 | CHƯA ĐẠT | **ĐẠT** | `AUTO-006` FIXED |
| B9 | CHƯA ĐẠT | **ĐẠT** | `CODE-017` + `AUTO-009` FIXED — cancellation reaches the worker and kills the process tree |
| C5 | CHƯA ĐẠT | **ĐẠT, có ghi chú** | `ARCH-008` guarded, not removed: a test loads each cycle member first. The cycles still exist |
| C7 | CHƯA ĐẠT | **ĐẠT** | `ARCH-007` FIXED — schema 18 `next_seq` |
| D3 | CHƯA ĐẠT | **ĐẠT** | `PERF-009` FIXED — per-turn token ceiling on shared keys |
| D6 | CHƯA ĐẠT | **ĐẠT** | `PERF-010` + `PERF-013` FIXED — the second closed the first fix's bypass |
| D7 | CHƯA ĐẠT | **ĐẠT** | `PERF-012` FIXED |
| D8 | [UNKNOWN] | **[UNKNOWN]** | Unchanged: needs a live key and authorised spend |
| E2 | CHƯA ĐẠT | **ĐẠT** | `SEC-018` FIXED |
| E4 | CHƯA ĐẠT | **ĐẠT** | `SEC-015`, `SEC-019` FIXED at one choke point; `SEC-031` adds redaction for the clipboard |
| E5 | có ghi chú | **ĐẠT, có ghi chú** | `SEC-020` FIXED (the bypass is logged); fail-open stays by design. `SEC-030` adds a per-turn outbound ceiling under `auto` |
| E7 | CHƯA ĐẠT | **ĐẠT** | `SEC-016` FIXED; `SEC-029` hardens what MCP servers can put in a request |
| E8 | CHƯA ĐẠT | **ĐẠT** | `SEC-017`, `SEC-027` FIXED |
| E11 | ĐẠT | **ĐẠT — Phase 1 was wrong** | A dangling link walked out of the workspace until `SEC-025`. The row said ĐẠT while that was true; it is ĐẠT now |
| E (new) | — | — | Found this round and FIXED, no Phase 1 row to move: `SEC-026` sub-agent offered-set, `SEC-028` re-pairing residue, `SEC-032` plain-http worker transport |
| F4 | CHƯA ĐẠT | **ĐẠT** | `CODE-012`–`CODE-015`, `CFG-015` FIXED; `CODE-027` fixed a drift this round introduced |
| F6 | CHƯA ĐẠT | **ĐẠT** | `CODE-016` FIXED |
| G4 | có lỗ | **ĐẠT, có lỗ** | Now has an ID: `GAP-010`, **PROPOSED** — a feature for the owner to decide |
| H1 | một phần | **ĐẠT một phần** | Arguments are validated server-side (`GAP-004`); the provider `strict` flag on OpenAI-compatible routes is `GAP-006`, **BLOCKED** on live verification |
| H3 | CHƯA ĐẠT | **CHƯA ĐẠT** | Now has an ID: `GAP-011`, **PROPOSED** — design space, not built unasked |
| H4 | CHƯA ĐẠT | **ĐẠT một phần** | `GAP-003` FIXED: prompts carry a version fingerprint the eval pins. A/B is `GAP-005`, **BLOCKED** on a live budget |
| H5 | một phần | **ĐẠT một phần** | `eval:live` still never run — same blocker as D8 |

### Điểm tổng — Phase 3

| Nhóm | ĐẠT | ĐẠT một phần / có ghi chú | CHƯA ĐẠT | [UNKNOWN] |
|---|---|---|---|---|
| A Độ chính xác | 7 | 1 | 0 | 0 |
| B Tool-use | 8 | 0 (1 N/A) | 0 | 0 |
| C Kiến trúc | 6 | 1 | 0 | 0 |
| D Hiệu năng | 7 | 0 | 0 | 1 |
| E Bảo mật | 11 | 1 | 0 | 0 |
| F Chất lượng | 6 | 0 | 0 | 0 |
| G Đầu ra | 4 | 1 | 0 | 0 |
| H Năng lực model | 2 | 3 | 1 | 0 |
| **Tổng** | **51** | **7** | **1** | **1** |

61 rows (the Phase 1 total of 62 double-counted B2's N/A). Phase 1 → Phase 3:
ĐẠT 31 → 51, CHƯA ĐẠT 22 → 1.

What is left is not hidden in "một phần": the one `CHƯA ĐẠT` (H3) and G4's hole
are features awaiting a decision; H1/H4/H5 and D8 each wait on something only the
owner can authorise — a live key and spend. None of those is claimed as done.

---

# VÒNG v3 — Phase 1 (2026-10-05) · chấm theo AUDIT_RULES v3 PHẦN II/IV/V/VI

Nhãn: ĐẠT / CHƯA ĐẠT / MỘT PHẦN / N/A / [UNKNOWN]. Mỗi CHƯA ĐẠT có ID ledger (mục "VÒNG v3").
Bằng chứng là `file:line` đã mở trong vòng này hoặc đã kiểm ở vòng trước và file không đổi kể từ `6e526f1`.

## A–H (tóm tắt, chỉ mục có thay đổi so với v2)

| Mục | Kết quả | Bằng chứng / ID |
|---|---|---|
| A Độ chính xác: nguồn + link, nhãn tin cậy, "không biết" hợp lệ | ĐẠT | `server/research/*` proposer/critic/arbiter + `citationSupport` (CHANGELOG 2026-10-04); system prompt "Cite as you go" (`agent.js` diff) |
| A Dữ liệu real-time có timestamp + nguồn | ĐẠT | `world_facts` "rates updated …, Source: open.er-api.com" (`tools/cloud.js:1168-1170`) |
| B Tool-use: timeout mọi lời gọi ngoài | ĐẠT | 45/45 `fetch/safeFetch` có signal (`audit/BASELINE.md` v3) |
| B Retry backoff + lỗi tường minh | ĐẠT | `providers/index.js:201-202,381-526` (retry-after, phân loại, key resting) |
| B Idempotent / chống chạy lại tác dụng phụ | ĐẠT | `agent.js:870-891` `resumableCalls` + `startedCalls` |
| C Provider trừu tượng hoá | ĐẠT | một cửa `streamCompletion` (`providers/index.js:381`); ngoại lệ duy nhất: tạo ảnh Gemini `tools/cloud.js:2303` |
| D Cache có TTL | ĐẠT | favicon 6 h miss / 500 mục (`favicon.js:18-21`), image 24 MB LRU (`imageProxy.js:76-90`), privacy 60 s (`settings.js:196-197`) |
| E Bảo mật — LLM01 prompt injection gián tiếp | **CHƯA ĐẠT** | `SEC-035` (sandbox_run không bọc), `SEC-034` (favicon exfil) |
| E LLM02 lộ thông tin nhạy cảm | **CHƯA ĐẠT** | `PRV-001` (link chia sẻ công bố kết quả tool riêng tư), `SEC-034` |
| E LLM06 / ASI02 quyền quá mức của tool | **MỘT PHẦN** | `SEC-036` (sandbox đọc được hồ sơ trình duyệt), `HAR-001` |
| E ASI06 memory poisoning | **MỘT PHẦN** | `HAR-002` |
| E Secret trong code/log/bundle/lịch sử | ĐẠT | 0 hình dạng key (BASELINE v3); `trace.js` `cleanFields` redact mọi field |
| E Secret ngoài repo nhưng agent đọc được | **CHƯA ĐẠT** | `CFG-026` |
| E Secret at rest | **MỘT PHẦN** | API key mã hoá; khoá cloud browser không (`SEC-037`) |
| E Rate limit + auth endpoint mới | ĐẠT | export/import/delete-account có `rateLimit` (`routes/account.js:188,265,338`); public share chỉ token 256-bit (`share.js:29`, `chatShare.js:33`) |
| F Log có trace id, không nội dung user | ĐẠT | `util/trace.js` (AsyncLocalStorage), email không log địa chỉ trên Vercel (`email.js:216-220`) |
| F Lỗi retryable/fatal | ĐẠT | `providers/index.js` `classify` |
| G Đầu ra: tiến trình + lỗi dễ hiểu | ĐẠT | `progress.js`; `readableFailure` dịch lỗi data-policy (`app.js` diff) |
| H Prompt versioned + eval cố định | ĐẠT | `test/eval/run.mjs:57,265-315` PROMPT_STAMP |

## I — Token (T1–T15)

| # | Kết quả | Bằng chứng / ID |
|---|---|---|
| T1 thứ tự tĩnh → động | ĐẠT | system tĩnh, memory (đổi khi ghi), project, ngày cuối cùng (`agent.js:405-426`) |
| T2 không timestamp/id trong phần tĩnh | ĐẠT | chỉ *ngày* theo múi giờ (`agent.js:420-425`), comment ghi rõ lý do cache |
| T3 cache breakpoint | ĐẠT (Anthropic) / [UNKNOWN] hit rate thật | `providers/anthropic.js:73,137`; OpenRouter→Claude dùng root `cache_control` (`openaiCompatible.js:298`); hit rate cần key thật |
| T4 TTL theo mẫu truy cập | ĐẠT | `ephemeral` (5 phút) cho chat liên tục |
| T5 định tuyến theo độ khó | MỘT PHẦN | `server/roleModel.js` (compaction/extract/plan → model nhỏ, chỉ khi rẻ hơn chứng minh được) — v2 |
| T6 việc code làm được không gọi LLM | ĐẠT | `calculate`, lịch âm, đơn vị, `schedule-grammar.js` là code thuần |
| T7 Batch API cho việc không real-time | CHƯA ĐẠT — chấp nhận | Hobby + free model; Batch API không có trên OpenRouter free. Không mở ID (không có hành động khả thi miễn phí) |
| T8 `max_tokens` theo tác vụ | ĐẠT | `outputBudget` (`providers/index.js:67,392`) |
| T9 cửa sổ trượt + compaction | ĐẠT | `compact.js:88,163` `measure`/`shouldCompact` |
| T10 cắt kết quả tool | ĐẠT | `MAX_OUTPUT_CHARS` sandbox 16k (`sandbox.js:33,173-178`), web 20k mặc định |
| T11 just-in-time | ĐẠT | memory quá ngân sách → chỉ nêu tên, `memory_read` khi cần (`memory.js:330-405`) |
| T12 chỉ nạp tool cần | ĐẠT | `load_tools` + tool hoãn (`definitions.js:175`) |
| T13 cache tầng ứng dụng tách theo user | ĐẠT | memo đọc lặp theo **lượt** (`agent.js` `repeatedRead`); cache favicon/ảnh là nội dung công khai, khoá theo URL. Rủi ro khoá: `CODE-033` (tiềm ẩn) |
| T14 chống request trùng | ĐẠT | lease một-writer-mỗi-chat → 409 (`app.js:1914-1915`) |
| T15 trần token | ĐẠT | `turnLimit` (`agent.js:1451`), `DEFAULT_MONTHLY_TOKEN_LIMIT` (`index.js:114`), `MAX_RESEARCH_PER_TURN` |
| Dashboard token/chi phí/cache-hit theo route | MỘT PHẦN | usage line + bảng `usage` có `role`; không có dashboard theo route |

## J — Privacy (P0–P8)

| Lớp | Kết quả | Bằng chứng / ID |
|---|---|---|
| P0 không thu thập thừa | ĐẠT (trước GAP-012) | 0 analytics; audit IP /24, UA họ trình duyệt (`audit.js:27-64`); log redact |
| P1 hợp đồng provider | MỘT PHẦN | strict OpenRouter có (`openaiCompatible.js:319-327`); Gemini free tier train; OrcaRouter [UNKNOWN] → `PRV-004`, `PRV-005` |
| P2 khử định danh | **CHƯA ĐẠT** | `PRV-003` (CHỜ-CHỦ) |
| P3 định tuyến theo độ nhạy, không hạ cấp | **CHƯA ĐẠT** | `PRV-002`, `PRV-005`; không có route self-host/TEE (CHỜ-CHỦ, chi phí) |
| P4 lưu trữ & kênh | MỘT PHẦN | TLS + HSTS; key mã hoá; nội dung chat không mã hoá tầng ứng dụng; `SEC-037` |
| P5 quyền user | MỘT PHẦN | xoá/xuất/nhập/incognito/retention có (`routes/account.js`); thông báo provider thiếu → `PRV-004` |
| P6 cá nhân hoá không xâm phạm | MỘT PHẦN | memory xem/sửa/xoá được, guard nhạy cảm; thiếu provenance → `HAR-002` |
| P7 pháp lý VN | **[cần luật sư]** | `LAW-001` (CHỜ-CHỦ/NGOÀI-REPO) |
| P8 test egress | **CHƯA ĐẠT** | không có test chặn payload ra provider với PII giả; P2 chưa có nên test chỉ có thể khẳng định *đích* và *log*, không khẳng định khử định danh → viết trong Phase 2 (`HAR-003`) |

## K — Harness (H1–H20)

| # | Cơ chế | Test | Kết quả |
|---|---|---|---|
| H1 timeout + huỷ lan truyền | `stallGuard`, `AbortSignal.any` (`cloudBrowser/index.js:112-119`), signal mọi fetch | `agent.test`, `search.test` ("a download stops on the signal") | ĐẠT |
| H2 429 retry-after, trần | `providers/index.js:201-202,340-345,524` | `fallback.test` | ĐẠT |
| H3 retryable vs fatal | `classify` | `fallback.test` | ĐẠT |
| H4 provider sập, không hạ cấp privacy | key resting/dead; **fallback vision hạ cấp** | — | MỘT PHẦN (`PRV-005`, `PRV-002`) |
| H5 hallucination | citations, `citationSupport`, research arbiter | `research.test` | ĐẠT |
| H6 tác dụng phụ trùng | `startedCalls` + `resumableCalls` (`agent.js:848-891`) | `agent.test` | ĐẠT |
| H7 race | lease `claimChatRun`/`touchChatRun` (`resume.js:57-78`), `claimTask` | `live-runs.test`, `workflow.test` | ĐẠT |
| H8 crash giữa chừng | mỗi bước ghi DB + `resumeCutOffTurns` (`resume.js`) | `workflow.test` | ĐẠT |
| H9 vòng lặp/chạy quá | `maxSteps` ≤100, `turnLimit`, `MAX_RESEARCH_PER_TURN`, `repeatedRead`, `OUTBOUND_PER_TURN` (`agent.js:739-776`) | `agent.test` | ĐẠT |
| H10 tràn context | `compact.js` | `agent.test`/`features.test` | ĐẠT |
| H11 injection gián tiếp | `untrusted()` + `EXTERNAL_OUTPUT` | `isolation.test` | **CHƯA ĐẠT** (`SEC-035`, `SEC-034`) |
| H12 memory poisoning | guard + khung "background" | `memory.test` | MỘT PHẦN (`HAR-002`) |
| H13 stream đứt | `retry` event; lease cho phép quay lại | `agent.test` | ĐẠT |
| H14 sandbox | microVM Firecracker, 2 vCPU, timeout ≤300 s; **mạng mở, đĩa bền** | `cloudBrowser.test` | MỘT PHẦN (`HAR-001`, `SEC-036`) |
| H15 state | DB là nguồn sự thật; RAM chỉ là gợi ý (`settings.js` cursor/resting) | `live-runs.test` | ĐẠT |
| H16 observability | trace id ALS; **không có span OpenTelemetry GenAI** | — | MỘT PHẦN (`HAR-004`) |
| H17 orchestration | workflow tất định + agent + sub-agent | `workflow.test` | ĐẠT |
| H18 hành động không đảo ngược | `ALWAYS_SENSITIVE`, `OUTBOUND`, `publish_file` sensitive (`definitions.js:2862-2866`) | `isolation.test` | ĐẠT |
| H19 đổi model | PROMPT_STAMP + eval 13 case; id model theo alias (`anthropic/claude-opus-5`) | `eval` | MỘT PHẦN — chưa ghim phiên bản model cụ thể (ghi nhận, không mở ID: alias là chủ ý của catalog) |
| H20 dữ liệu real-time cũ | `world_facts` ghi thời điểm cập nhật + nguồn | `world.test` | ĐẠT |

## M — Ý tưởng (PHẦN VII) — chấm nhanh

| # | Trạng thái | Ghi chú |
|---|---|---|
| I1 Privacy Gateway một cửa | một nửa | cửa duy nhất đã có (`streamCompletion`); thiếu P2 → `PRV-003` |
| I3 evaluator ngữ cảnh mới | làm ở Phase 3 | |
| I4 action ledger | có (`startedCalls`) | |
| I5 run state machine | có (lease + `run_lock_by`, workflow runs) | |
| I6 OTel GenAI | `HAR-004` | |
| I7 bố cục prompt theo cache | có | |
| I10 red-team OWASP trong CI | một phần — `isolation.test`; thêm test cho SEC-034/035 ở Phase 2 | |
| I11 memory provenance | `HAR-002` | |
| I12 bảng minh bạch | một phần — Activity log (`privacy.js`) | |


---

# VÒNG v3 — Phase 3: chấm lại (2026-10-05, nhánh `optimize/2026-10-05`)

Chỉ liệt kê mục **đổi trạng thái** so với bảng Phase 1 ở trên. Mục không nêu = giữ nguyên.
Mỗi dòng trỏ về ID ledger đã FIXED (commit trong ledger) hoặc lý do còn lại.

| Mục | Phase 1 | Phase 3 | Vì sao |
|---|---|---|---|
| E LLM01 injection gián tiếp | CHƯA ĐẠT | **ĐẠT** | SEC-035/043/044 (sandbox, sub-agent, research vào `EXTERNAL_OUTPUT`), SEC-040 (compaction trích dẫn kết quả tool), SEC-042 (nguồn project bọc), SEC-045 (chú thích ảnh trong envelope), SEC-039 (chấm rủi ro trên tham số đã chuẩn hoá) |
| E LLM02 lộ thông tin nhạy cảm | CHƯA ĐẠT | **ĐẠT** | PRV-001 (link chia sẻ chỉ công bố tool công khai), SEC-034 (favicon chỉ tên đăng ký), SEC-038 (proxy cho khách chỉ vẽ trang đó), SEC-041, SEC-046 |
| E LLM06/ASI02 quyền tool | MỘT PHẦN | MỘT PHẦN | SEC-036 FIXED (sandbox chạm hồ sơ trình duyệt → hỏi); còn HAR-001 (mạng sandbox mở) CHỜ-CHỦ |
| E ASI06 memory poisoning | MỘT PHẦN | **ĐẠT** | HAR-002: mỗi ghi chú mang `by`/`chatId`, một bước hoàn tác, giao diện cho xem nguồn |
| E Secret ngoài repo agent đọc được | CHƯA ĐẠT | **ĐẠT** | CFG-026 (deny `Read(./.env.*)`, `Read(./worker/.env.*)`) |
| E Secret at rest | MỘT PHẦN | **ĐẠT** | SEC-037 (khoá cloud browser niêm phong bằng `encryptSecret`) — nội dung chat vẫn không mã hoá tầng ứng dụng, chấm ở P4 |
| P0 không thu thập thừa | ĐẠT (trước GAP-012) | **ĐẠT** (sau GAP-012) | analytics chỉ gửi origin + path, không cookie, tắt khi GPC/DNT, không nạp ngoài Vercel; `features.test` khẳng định token trong query/hash không đi ra |
| P3 không hạ cấp | CHƯA ĐẠT | MỘT PHẦN | PRV-002 (lỗi đọc cài đặt → strict), PRV-005 (vision dưới strict chỉ OpenRouter/OCR); vẫn không có route self-host/TEE |
| P5 quyền user | MỘT PHẦN | MỘT PHẦN | PRV-004 FIXED (nói rõ provider nào giữ gì); còn thiếu "xem bản đã khử định danh" vì chưa có P2 |
| P6 cá nhân hoá không xâm phạm | MỘT PHẦN | **ĐẠT** | HAR-002 (provenance + rollback) |
| P8 test egress | CHƯA ĐẠT | MỘT PHẦN | HAR-003: `test/egress.test.mjs` khẳng định đích (một cửa, strict → ZDR) và log/telemetry không chứa PII giả; không khẳng định khử định danh vì P2 chưa có (PRV-003 CHỜ-CHỦ) |
| H4 provider sập, không hạ cấp privacy | MỘT PHẦN | **ĐẠT** | PRV-002, PRV-005 |
| H11 injection gián tiếp | CHƯA ĐẠT | **ĐẠT** | như LLM01 |
| H12 memory poisoning | MỘT PHẦN | **ĐẠT** | HAR-002 |
| H14 sandbox | MỘT PHẦN | MỘT PHẦN | SEC-036 FIXED; HAR-001 CHỜ-CHỦ |
| Hiệu năng (PHẦN II D, ngoài bảng trên) | — | cải thiện đo được | PERF-016 regex có trần 1 s; PERF-017 HTML/feed tuyến tính (2–394 ms trên đầu vào thù địch); PERF-018/019 trần pixel OCR/PDF; PERF-020 9077 → 367 ms; PERF-021 không giải mã đôi |
| Tiếp cận (WCAG) | — | cải thiện | ACC-008..016: tương phản `--on-accent` ≥ 5.67:1 mọi theme, vòng focus cho nút nhập, share không đọc cả hội thoại, trình vẽ dùng được bằng bàn phím (đã chạy trong trình duyệt thật) |

**Còn lại không đổi và vì sao:** P2 khử định danh (PRV-003), P7 pháp lý (LAW-001), H16 OTel (HAR-004),
T5 định tuyến theo độ khó (MỘT PHẦN, v2), T7 Batch (chấp nhận), dashboard theo route (MỘT PHẦN) — đều
là CHỜ-CHỦ hoặc đã ghi là chấp nhận ở Phase 1.
