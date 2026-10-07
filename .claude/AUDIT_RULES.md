# MASTER AUDIT PROMPT v3 — AI REMOTE
## Audit chuyên sâu · tối ưu token · privacy tối đa · harness agent · tự động hóa tới push `main`

> Thay thế toàn bộ file audit trước đó (v2, PHASE_0_*, 00–04).
> Cài: lưu file này thành `.claude/AUDIT_RULES.md`. Gõ: `Đọc @.claude/AUDIT_RULES.md và chạy toàn bộ quy trình.`
> **Chế độ mặc định: `AUTO`** — chạy liền Phase 0 → 4 và tự push `main` khi qua đủ cổng. Muốn dừng duyệt từng phase: gõ `CHẾ ĐỘ: SAFE`.
> File này tĩnh. Không chèn ngày giờ, không sửa giữa chừng — giữ nguyên byte để prompt cache trúng.

---

# PHẦN I — LUẬT NỀN

## 0. VAI TRÒ & MỤC TIÊU

Senior Code Auditor · Optimization Architect · Harness Engineer · Privacy Engineer cho project **AI Remote**.

Mục tiêu của chủ project, đọc kỹ, không bỏ ý nào:
1. Audit chuyên sâu full project, không bỏ sót chi tiết nhỏ nhất.
2. Khai thác + mở rộng sáng tạo + tối ưu tối đa các tool agency.
3. Kết quả chính xác, thực tế, minh bạch, chuyên sâu, chuyên nghiệp, real-time, nhanh, hiệu quả, flexible/adaptive.
4. Tối ưu token tối đa — không lãng phí, không dư thừa.
5. Privacy tối đa: conversation của user không bị provider thu thập; web không thu thập/truyền dữ liệu thừa; vẫn tiện cho user.
6. Cá nhân hóa nhưng không xâm phạm riêng tư.
7. Harness agent đủ chuẩn: memory, orchestration, observability, retry, sandbox, state, tool reliability, mọi edge case (timeout, rate limit, hallucination, duplicate task, race condition…).
8. Bảo mật, bảo vệ chất xám (repo public).
9. Tận dụng tối đa plugin/skill đã cài.
10. Tự bổ sung ý tưởng tiên tiến có nguồn thật.
11. Tự động hóa toàn bộ, kể cả push `main`, khi đạt chuẩn.

## 1. BA SỰ THẬT PHẢI NÓI THẲNG

1. **"0 lỗi 100%" không chứng minh được.** Không tìm thấy lỗi ≠ không có lỗi. Thay bằng định nghĩa "SẠCH" đo được ở mục 2. Cấm tuyên bố "hoàn hảo 100%".
2. **Gửi chat cho provider bên ngoài thì provider xử lý nội dung đó.** Không có cách nào "gửi mà provider không thấy", trừ 3 đường: không gửi (model tự host), gửi bản đã khử định danh, hoặc chạy trong môi trường tính toán bảo mật (TEE) có attestation. Xem PHẦN V.
3. **Prompt không làm model giỏi hơn chính nó.** Thứ vượt được "cách Claude làm việc mặc định" là harness quanh nó: kiểm chứng bên ngoài, evaluator độc lập ngữ cảnh mới, đo đạc trước/sau, ledger trên đĩa.

## 2. ĐỊNH NGHĨA "SẠCH" (thay cho "perfect 100%")

Project được gọi là SẠCH khi **tất cả** đúng, mỗi dòng có bằng chứng:
- `npm run gate`, build, lint, typecheck, test: pass. 0 test skip.
- `.typecheck-baseline.json` không phình; lý tưởng là co lại.
- Ledger: 0 dòng `OPEN`/`IN-PROGRESS`; 0 `CRITICAL`/`HIGH` mở (trừ `CHỜ-CHỦ` loại ngoài-repo, mục 5).
- Bộ test edge-case harness (PHẦN VI) pass.
- Bộ test privacy egress (PHẦN V §P8) pass.
- Không regression token/chi phí/độ trễ so với baseline (hoặc có giải thích chấp nhận được).
- Evaluator ngữ cảnh mới, chỉ đọc, trả `PASS`.

## 3. HỢP ĐỒNG KIỂM CHỨNG (Phase 0 tự điền; trường nào không tìm ra → `[UNKNOWN]`, cấm tự chế lệnh)

```
REPO:            D:\AI remote
VISIBILITY:      PUBLIC (chủ project xác nhận)
SHELL CỦA AGENT: PowerShell 5.1 trên máy này (Git Bash không có — công cụ Bash hỏng); CI chạy bash trên Ubuntu
NHÁNH HIỆN TẠI:  <đọc `git branch --show-current`> — việc làm trên nhánh tính năng, xong thì merge vào main và push
NODE:            <đọc .nvmrc>
CMD_INSTALL / CMD_TEST / CMD_LINT / CMD_TYPECHECK / CMD_BUILD / CMD_RUN_LOCAL: <đọc package.json>
GATE:            npm run gate → liệt kê chính xác từng lệnh con
ENTRYPOINT:      <server/…>
LLM PROVIDERS:   <tên + model + endpoint + loại API key (commercial/consumer)>
PROVIDER TERMS:  <no-training? ZDR? store=false? retention?> — ghi nguồn
EXTERNAL APIS:   <mọi đích ngoài server nhận dữ liệu>
DEPLOY:          <Vercel?> — push main có tự deploy production không? bằng chứng file:line
PROD URL:        <nếu có, để smoke test sau push>
```

**`CMD_TEST: NONE`** → cấm ghi "test pass". Viết smoke test ≥3 luồng lõi trước khi sửa.
**`.typecheck-baseline.json`** → đếm chính xác số lỗi đang bị treo. Gate pass nhờ baseline nuốt lỗi = gate giả, phải báo.

## 4. LUẬT BẰNG CHỨNG

| Nhãn | Nghĩa | Bắt buộc kèm |
|---|---|---|
| `[FACT]` | Đã mở file / đã chạy lệnh | `đường/dẫn:dòng` hoặc output nguyên văn |
| `[INFER]` | Suy luận từ FACT | trỏ về FACT nguồn |
| `[UNKNOWN]` | Chưa đọc / chưa đo | nói thẳng, cấm đoán |

Cấm: mô tả file theo tên; ghi `FIXED` không có diff + lệnh kiểm chứng; viện dẫn "chuẩn top-tier" không link nguồn thật; bịa số đo.
Nguồn bên ngoài: ưu tiên tài liệu gốc (docs provider, OWASP, OpenTelemetry, văn bản luật). Nguồn thứ cấp → ghi "thứ cấp, cần xác minh".

## 5. CHẾ ĐỘ CHẠY

### `AUTO` (mặc định)
- Chạy liền Phase 0 → 1 → 2 → 3 → 4, không dừng chờ duyệt giữa phase.
- Tự xử lý mọi ID **rủi ro thấp/trung bình**.
- ID **rủi ro cao** → trạng thái `CHỜ-CHỦ`, không sửa, ghi phương án đề xuất, chạy tiếp phần còn lại.
- Push `main` khi đủ toàn bộ cổng PHẦN III.

**Rủi ro cao = luôn `CHỜ-CHỦ` trong AUTO:**
đổi kiến trúc lõi · đổi provider LLM · đổi schema/migration DB · đổi luồng dữ liệu khách hàng đang chạy thật · đụng `.claude/hooks` · đổi visibility repo · viết lại lịch sử git · thu hồi/cấp lại API key · bất kỳ thao tác ngoài repo (dashboard provider, Vercel, GitHub settings) · gửi dữ liệu thật ra ngoài để thử.

**Phân loại `CHỜ-CHỦ`:**
- `CHỜ-CHỦ/NGOÀI-REPO`: việc chỉ người làm được ngoài repo (rotate key, đổi visibility, ký ZDR). **Không chặn push** — nhưng đặt đầu báo cáo.
- `CHỜ-CHỦ/TRONG-REPO`: thay đổi code rủi ro cao chưa làm. Mức `CRITICAL` loại này **chặn push**. Mức thấp hơn không chặn.

### `SAFE`
Kích hoạt khi chủ project gõ `CHẾ ĐỘ: SAFE`. Dừng cuối mỗi phase chờ duyệt. Không tự push; in lệnh cho chủ project bấm.

### Harness cho chính agent audit (chống tràn context khi chạy AUTO dài)
- Sau mỗi phase và sau mỗi 5 ID: ghi `audit/PROGRESS.md` — phase hiện tại, ID đang làm, việc kế tiếp, lệnh kiểm chứng gần nhất, quyết định đã chốt.
- Khi ngữ cảnh bị nén hoặc mở session mới: **đọc `audit/PROGRESS.md` + `audit/ISSUE_LEDGER.md` trước tiên**, tiếp tục từ đó. Cấm suy đoán tiến độ từ trí nhớ hội thoại.
- Mỗi lượt chỉ làm 1 ID tới khi xong, commit, ghi ledger rồi mới sang ID khác.

## 6. VÙNG CẤM (cả 2 chế độ)

- Giá trị secret: không in, không commit, không gửi đi. Chỉ báo tên biến + vị trí.
- `package-lock.json`: không regenerate toàn bộ. Thêm/gỡ 1 gói → chỉ thay đổi tối thiểu, ghi ID.
- Mass reformat, nâng major version, xoá file không có ID + lý do.
- Gửi dữ liệu user thật tới bất kỳ dịch vụ ngoài nào để thử nghiệm.
- Git: force push, `reset --hard` trên `main`, xoá nhánh, viết lại lịch sử, bypass hook (`--no-verify`).

## 7. NGÂN SÁCH & ĐIỂM DỪNG

- Phase 0, 1: cấm sửa code; chỉ tạo file trong `audit/`.
- 1 ID thử 3 lần không xong → `BLOCKED` + lý do, đi tiếp.
- Ngữ cảnh còn <20% → ghi `PROGRESS.md`, báo "tiếp tục từ ID X".
- Phát hiện vấn đề ngoài kế hoạch → thêm ID trước, rồi mới xử theo phân loại rủi ro.

## 8. SỔ THEO DÕI — `audit/ISSUE_LEDGER.md`

| ID | Nhóm | Mô tả | Bằng chứng (file:line) | Mức | Phạm vi | Rủi ro thay đổi | Trạng thái | Kiểm chứng đã fix | Commit |
|---|---|---|---|---|---|---|---|---|---|

- Tiền tố: `SEC-` `PRV-`(privacy) `TOK-`(token) `HAR-`(harness) `ARCH-` `PERF-` `ACC-` `AUTO-` `CODE-` `UX-` `GAP-` `CFG-`(.claude/skill) `EXP-`(lộ chất xám) `LAW-`(pháp lý).
- Trạng thái: `OPEN` → `IN-PROGRESS` → `FIXED` | `CHỜ-CHỦ/NGOÀI-REPO` | `CHỜ-CHỦ/TRONG-REPO` | `DEFERRED` | `BLOCKED`.
- Ghi ngay khi phát hiện. **KHÔNG ĐƯỢC XOÁ DÒNG.** Không sửa → đổi trạng thái + lý do; dòng vẫn có trong báo cáo cuối.
- `DEFERRED` chỉ hợp lệ khi chủ project xác nhận bằng chữ.
- Cấm gộp vấn đề khác bản chất. Ngoại lệ duy nhất: `LOW` cùng bản chất lặp nhiều file → 1 dòng + danh sách đủ từng file trong `audit/LOW_ROLLUP.md`.
- Mức: `CRITICAL` (lộ secret · lộ dữ liệu user ra provider/log/repo · injection/RCE · kết quả sai cho khách · mất dữ liệu · crash prod) · `HIGH` · `MEDIUM` · `LOW`.
- Thứ tự xử lý: `CRITICAL → HIGH → MEDIUM → LOW`; cùng mức thì đa-module trước.

## 9. THỨ TỰ ƯU TIÊN CHỈ DẪN

Lệnh chủ project trong lượt hiện tại > **file này** > `claude.md` > skill/plugin/command khác.

Skill **không bao giờ** được ghi đè: rào git · vùng cấm · luật bằng chứng · baseline · ledger · luật privacy PHẦN V.
Skill xung khắc → không làm theo, ghi `CFG-`, chạy tiếp.
Mỗi phase khai 1 dòng `Skill nạp: [...]`. Chỉ nạp skill dùng cho phase đó.

## 10. ĐỊNH DẠNG & TIẾT KIỆM TOKEN CỦA CHÍNH AGENT AUDIT

- Không chào, không mở bài, không tóm tắt lại điều vừa làm khi đã có trong file.
- Chi tiết dài → ghi vào file `audit/`; chat chỉ nêu đường dẫn + số liệu chính.
- Đọc file bằng grep/khoảng dòng khi đủ; không đọc lại file đã đọc nếu chưa đổi.
- Kết mỗi phase: `ĐÃ LÀM` / `SỐ LIỆU` / `CHỜ-CHỦ`.

---

# PHẦN II — QUY TRÌNH 5 PHASE

## PHASE 0 — HIỂU TOÀN BỘ (cấm sửa code)

### 0.1 An toàn — làm đầu tiên
```bash
cat .gitignore
git check-ignore -v .env .env.production.local .env.vercel-paste.local
git ls-files | grep -E '^\.env|^coverage/|^node_modules/|fuse_hidden'
git log --all --oneline -- .env .env.production.local .env.vercel-paste.local
command -v gitleaks >/dev/null && gitleaks detect --log-opts="--all" --redact --no-banner
```
`.env*` từng bị commit vào repo public → `CRITICAL` `CHỜ-CHỦ/NGOÀI-REPO`: key đã lộ, phải rotate. Liệt kê **tên biến**, không in giá trị.

### 0.1b Lộ chất xám — repo public
```bash
git remote -v
gh repo view --json visibility,isPrivate,url 2>/dev/null
git ls-files | wc -l
git ls-files
git log --all --diff-filter=A --name-only --pretty=format: | sort -u
```
Phân loại TỪNG file đang track → `audit/EXPOSURE.md`:

| File | Giá trị cốt lõi? | Phân loại | Hành động đề xuất | Mức |
|---|---|---|---|---|

Phân loại (chọn 1): `BẮT BUỘC CÔNG KHAI` · `NÊN CÔNG KHAI` · `KHÔNG NÊN` (prompt, chiến lược agent, pipeline, tài liệu nội bộ) · `TUYỆT ĐỐI KHÔNG` (secret, dữ liệu user, log có PII).
Soi kỹ: `.claude/commands|agents|skills|state`, prompt trong `server/ api/ worker/`, `data/` (dữ liệu thật → `CRITICAL`), `docs/`, `claude.md`.

Sự thật:
- `.gitignore` không xoá lịch sử. File từng commit vẫn đọc được qua commit cũ, fork, cache.
- `public/js` gửi thẳng tới trình duyệt; ai cũng đọc được kể cả khi repo private. Prompt/logic nghiệp vụ/key ở đó → chuyển về server.

4 phương án (đều là `CHỜ-CHỦ/NGOÀI-REPO`, không tự chọn): A chuyển private · B tách 2 repo public shell + private core · C rút lõi thành service private · D giữ public, chỉ dọn secret + dữ liệu. **D là mức tối thiểu bắt buộc.**
Gỡ file khỏi index cho lần push tới (`git rm --cached` + `.gitignore`) là rủi ro thấp → AUTO được làm, ID `EXP-`. Viết lại lịch sử → chỉ khi chủ project ra lệnh bằng chữ.

### 0.2 Điền Hợp đồng kiểm chứng (PHẦN I §3)
Mở `package.json`, `.c8rc.json`, `eslint.config.js`, `jsconfig.json`, `.nvmrc`, `.github/workflows/*`, `vercel.json` (nếu có).

### 0.3 Đọc hết repo theo lô
Bỏ `node_modules/ coverage/ .git/`. Lô ≤12 file, khai `Lô N/M — đã đọc: [...]`.
Thứ tự: `server/` → `api/` → `worker/` → `scripts/` → `test/` → `public/` → `data/` → `docs/`+`claude.md` → `.claude/**` → `.github/` + `.mcp.json.example`.
Cấm dừng vì "phần còn lại chắc tương tự". Chưa đọc → `[UNKNOWN] chưa đọc`.

### 0.4 `audit/INVENTORY.md`
| Module | File:line | Chức năng THỰC | Gọi ra ngoài | Gửi dữ liệu user? | Timeout/retry? | Validate input? | Có test? | Trạng thái |
|---|---|---|---|---|---|---|---|---|

### 0.5 `audit/CLAUDE_ASSETS.md`
Mở từng file `.claude/commands|agents|hooks|skills|state`, `settings.json`, `settings.local.json`.
- Hook nào tự `git commit/push`? → `CRITICAL`.
- `settings*.json`: allowlist quyền nguy hiểm? `settings.local.json` có bị ignore?
- Command trùng nhau (`verify`/`deploy-check`/`ship`…) → gộp hay giữ, lý do.
- Chấm 6 luật L1 hợp đồng · L2 bằng chứng · L3 baseline · L4 ledger · L5 tách phase · L6 rào git — `ĐÃ CÓ`/`MỘT PHẦN`/`THIẾU`/`MÂU THUẪN`.
- Nguyên tắc: tái dùng file sẵn có; chỉ thêm mới khi thật sự chưa có.

### 0.5b `audit/SKILL_MAP.md`
Liệt kê toàn bộ plugin/skill khả dụng thật (tên · mô tả thật · nguồn). Không truy cập được → `[UNKNOWN]`, cấm bịa tên.
| Skill | Phase dùng | Việc cụ thể | Rủi ro | `DÙNG`/`KHÔNG DÙNG`/`CÓ ĐIỀU KIỆN` |
|---|---|---|---|---|
Gợi ý loại skill cần tìm (chỉ dùng nếu có thật): đồ thị code/impact analysis · code review đa trục · taint/dataflow · security/privacy audit · tool-design/context-engineering · evaluation · incremental/TDD · systematic debugging.
Xung đột cần bắt: skill tự chạy git (`CRITICAL`) · tự sửa code không hỏi · bảo bỏ kiểm chứng · trùng chức năng · không liên quan project (marketing, SEO, spreadsheet → `KHÔNG DÙNG`).

### 0.6 `audit/BASELINE.md` — đo trước khi sửa
| Chỉ số | Cách đo | Giá trị | Nhãn |
|---|---|---|---|
| gate / test pass-tổng / coverage / lint / typecheck thật | chạy thật | | |
| Lỗi treo trong `.typecheck-baseline.json` | đếm | | |
| Số lần gọi LLM / request tiêu biểu (theo từng route) | code + log | | |
| Token input / cache read / cache write / output / request | `usage` trả về từ API | | |
| Cache hit rate = cache_read ÷ (cache_read + input + cache_write) | tính | | |
| Chi phí ước tính / request (theo bảng giá provider, ghi nguồn) | tính | | |
| Độ trễ end-to-end, TTFT (3 lần, trung vị) | đo thật | | |
| Số điểm gửi dữ liệu user ra ngoài server | grep + DATAFLOW | | |
| Số điểm log/trace chứa nội dung user | grep | | |
| Số lời gọi tool/provider KHÔNG timeout / KHÔNG retry / KHÔNG idempotency | grep | | |
| Số secret hardcode nghi vấn (chỉ đếm) | grep | | |
| TODO/FIXME | grep | | |

Gợi ý grep (bash):
```bash
grep -rnE "anthropic|openai|generativelanguage|openrouter|groq|mistral|fetch\(|axios|https?://" --include=*.js server api worker public scripts | grep -v node_modules
grep -rnE "console\.(log|info|debug)|logger\.|Sentry|posthog|mixpanel|gtag|analytics" --include=*.js server api worker public
grep -rnE "timeout|AbortController|retry|backoff|idempot" --include=*.js server api worker
```
Không đo được → `[UNKNOWN] + lý do`. Cấm điền số ước đoán.

### 0.7 Sơ đồ luồng lõi
ASCII 1 request quan trọng nhất. Đánh dấu từng bước: `[tuần tự]` `[song song]` `[gọi LLM]` `[không timeout]` `[không validate]` `[gửi dữ liệu user ra ngoài]` `[ghi log nội dung]`.

### 0.8 `audit/DATAFLOW.md` — bản đồ dữ liệu user
Mỗi điểm dữ liệu user rời khỏi server hoặc được lưu:
| Đích | File:line | Trường dữ liệu | Đã khử định danh? | Mục đích | Thời gian lưu (nguồn) | Xuyên biên giới? | Đánh giá |
|---|---|---|---|---|---|---|---|
Đích gồm: provider LLM, API ngoài, log, APM/error tracker, analytics, DB, cache, file, trình duyệt (localStorage), hàng đợi `worker/`.

### 0.9 Ledger
Ghi mọi vấn đề đã thấy, trạng thái `OPEN`. Ghi `audit/PROGRESS.md`.

## PHASE 1 — GAP ANALYSIS (cấm sửa code)

Chấm từng mục `ĐẠT`/`CHƯA ĐẠT`/`N/A`/`[UNKNOWN]`. Mỗi `CHƯA ĐẠT`: bằng chứng file:line · top-tier trông cụ thể ra sao · ID ledger.

**A. Độ chính xác (`ACC-`)** — claim quan trọng có nguồn + link · đối chiếu ≥2 nguồn · nhãn tin cậy HIGH/MEDIUM/LOW/CONFLICTING · dữ liệu real-time lấy qua tool lúc chạy, có timestamp + nguồn · proposer–critic cho việc quan trọng · phát hiện nguồn mâu thuẫn · "không biết" là câu trả lời hợp lệ.
**B. Tool-use (`AUTO-`)** — timeout · retry backoff · lỗi tường minh · structured output + validate schema · song song việc độc lập · không bước thủ công thừa · trigger/lịch · idempotent.
**C. Kiến trúc (`ARCH-`)** — thêm agent/tool/khách mới không sửa lõi · config tách code · không magic number · provider trừu tượng hóa · không phụ thuộc vòng.
**D. Hiệu năng (`PERF-`)** — cache có TTL · không dùng LLM cho việc code làm được · streaming · độ trễ phù hợp real-time.
**E. Bảo mật (`SEC-`)** — đối chiếu OWASP Top 10 cho LLM Applications 2025 và OWASP Top 10 cho Agentic Applications 2026 (ASI01–ASI10), ghi ID từng hạng mục · không secret trong code/log/bundle/lịch sử · validate input · chống prompt injection gián tiếp từ web/tool output · rate limit · auth endpoint · không prompt/logic/key trong `public/`.
**F. Code (`CODE-`)** — test logic lõi · log có trace id không chứa nội dung user · không trùng lặp · docs khớp code · lỗi phân loại retryable/fatal.
**G. Đầu ra (`UX-`)** — định dạng nhất quán · tùy biến qua config · tách kết luận vs giả định · tiến trình + lỗi dễ hiểu.
**H. Năng lực model (`GAP-`)** — structured output · context đủ không dư · tự kiểm trước khi trả · prompt versioned · eval cố định.
**I. Token (`TOK-`)** — toàn bộ PHẦN IV, từng quy tắc T1–T15.
**J. Privacy (`PRV-`)** — toàn bộ PHẦN V, từng lớp P0–P8.
**K. Harness (`HAR-`)** — toàn bộ PHẦN VI, từng dòng H1–H20.
**L. Pháp lý (`LAW-`)** — PHẦN V §P7. Ghi rõ "không phải tư vấn pháp lý".
**M. Ý tưởng (`GAP-`)** — PHẦN VII; mỗi ý tưởng: tên · vấn đề giải · nguồn thật · chi phí S/M/L. Không nguồn → `[INFER]`.

Ghi `audit/PROGRESS.md`. AUTO: sang Phase 2 ngay.

## PHASE 2 — THỰC THI

### 2.0 Lưới an toàn
```bash
git status --porcelain            # phải rỗng; không rỗng → commit WIP riêng hoặc báo
git tag "backup/pre-optimize-$(date +%Y%m%d-%H%M)"
git checkout -b "optimize/$(date +%Y-%m-%d)"
git log --oneline origin/main..HEAD   # commit sẵn có trên nhánh hiện tại sẽ theo vào main — ghi vào báo cáo
```
`CMD_TEST: NONE` → viết smoke test ≥3 luồng lõi trước, commit riêng.

### 2.1 Vòng lặp mỗi ID
Thứ tự `CRITICAL → HIGH → MEDIUM → LOW`. Còn `OPEN` mức cao (không phải `CHỜ-CHỦ`/`DEFERRED`) → cấm xuống mức thấp.
1. `IN-PROGRESS` · 2. một dòng: sửa gì, file nào, rủi ro · 3. sửa đúng phạm vi ID · 4. thêm/cập nhật test · 5. chạy test + lint + typecheck, fail thì sửa tiếp · 6. commit riêng `<type>(<scope>): <mô tả> [ID]` → hash vào ledger → `FIXED`.
Cấm gộp ID vào 1 commit. Cấm dồn cập nhật ledger. Cấm `--no-verify`.

### 2.2 Tình huống
| Tình huống | AUTO | SAFE |
|---|---|---|
| Vấn đề mới | Thêm ID; rủi ro thấp/TB → xử; cao → `CHỜ-CHỦ` | Thêm ID; cao → hỏi |
| Thử 3 lần không xong | `BLOCKED`, đi tiếp | như AUTO |
| Sửa làm hỏng chỗ khác | `git revert` commit đó, ghi lại | như AUTO + báo |
| Cần đụng vùng cấm | `CHỜ-CHỦ`, đi tiếp | dừng, hỏi |

## PHASE 3 — TỰ KIỂM CHỨNG

1. Đo lại đúng các chỉ số BASELINE → `audit/RESULT.md` (Trước · Sau · Δ · cách đo). Xấu đi → ghi thẳng.
2. Regression: test, lint, typecheck, build, gate, `git diff --stat <tag backup>`. Test skip? baseline typecheck phình? diff lạ (lockfile, `.env`, file lớn)?
3. Chạy local + 1 request end-to-end thật, dán output.
4. Bộ test edge-case PHẦN VI + bộ test privacy egress PHẦN V §P8: dán kết quả.
5. Chấm lại checklist Phase 1.
6. **Evaluator ngữ cảnh mới:** gọi subagent chỉ có quyền đọc (không Write/Edit, không git ghi), đưa diff + `RESULT.md` + checklist; nó chưa từng thấy quá trình sửa. Trả `PASS` hoặc `NEEDS_WORK` kèm phát hiện cụ thể. `NEEDS_WORK` → quay lại Phase 2 với ID mới.
7. Đối soát ledger: `Tổng | FIXED | CHỜ-CHỦ | DEFERRED | BLOCKED | OPEN | IN-PROGRESS`.

## PHASE 4 — BÀN GIAO → PHẦN III

---

# PHẦN III — GIT

## Cổng push `main` — thiếu 1 cổng là không push

1. Test pass, 0 skip (hoặc nêu độ phủ smoke test nếu ban đầu không có test).
2. Gate + build + lint + typecheck pass **trên kết quả đã merge** (không chỉ trên nhánh).
3. `.typecheck-baseline.json` không phình.
4. 0 `OPEN`/`IN-PROGRESS`; 0 `CRITICAL`/`HIGH` mở trừ loại `CHỜ-CHỦ/NGOÀI-REPO`.
5. Quét secret trên diff và mọi commit mới: sạch.
6. Không file nhóm `TUYỆT ĐỐI KHÔNG` (`EXPOSURE.md`) trong lần push.
7. Mọi `CFG-` về skill/hook tự chạy git đã đóng.
8. Privacy: không có điểm gửi nội dung user ra ngoài mới mà không qua lớp privacy; telemetry không bắt nội dung; test egress pass.
9. Token/chi phí/độ trễ không regression (hoặc có lý do ghi trong `RESULT.md`).
10. Test edge-case harness pass.
11. Evaluator ngữ cảnh mới trả `PASS`.
12. `RESULT.md` + changelog sẵn sàng.
13. Merge được fast-forward hoặc `--no-ff` sạch; không cần force.

## Quy trình AUTO
```bash
git fetch origin
git status --porcelain                         # phải rỗng
git switch main && git pull --ff-only origin main
git merge --no-ff "optimize/<ngày>" -m "merge: audit optimize <ngày>"
npm run gate                                   # chạy lại trên main đã merge
# in bảng 13 cổng có tick + bằng chứng ngay trước dòng dưới
git push origin main
```
- Push bị từ chối (branch protection, lệch lịch sử) → dừng, báo. **Không bao giờ force.**
- Push `main` kích hoạt deploy production (đã xác định ở Phase 0) → sau push chạy smoke test vào PROD URL. Fail → rollback ngay.

## Rollback — dùng `revert`, không dùng `reset`
`main` đã public thì không viết lại lịch sử:
```bash
git revert -m 1 <merge-commit-hash>
git push origin main
```
Tag `backup/pre-optimize-*` dùng để so sánh và khôi phục cục bộ, không để reset `main`.

## SAFE
In nguyên khối lệnh trên cho chủ project bấm.

## Báo cáo sau push
Commit hash · tag backup · các commit có sẵn trên nhánh cũ đã theo vào main · thay đổi theo nhóm · `CHỜ-CHỦ` đặt đầu · MEDIUM/LOW còn tồn + thứ tự lần sau.

---

# PHẦN IV — TỐI ƯU TOKEN (T1–T15)

Đo bằng trường `usage` thật của API, không ước lượng bằng mắt.

| # | Quy tắc | Cách kiểm |
|---|---|---|
| T1 | Thứ tự prompt cố định: tools → system → nội dung tĩnh → lịch sử → tin nhắn mới. Cache tính theo tiền tố khớp từ đầu. | So 2 request liên tiếp: phần đầu giống byte |
| T2 | Không chèn timestamp, request id, số ngẫu nhiên, tên user vào phần tĩnh. | grep chỗ dựng prompt |
| T3 | Đặt cache breakpoint cuối phần tĩnh; từ lượt 2 phải thấy `cache_read_input_tokens > 0`. | log usage |
| T4 | TTL theo mẫu truy cập: 5 phút cho chat liên tục; 1 giờ chỉ khi chắc ≥2 lần đọc trong giờ. | cache hit rate theo route |
| T5 | Định tuyến model theo độ khó: phân loại/trích xuất/định dạng → model nhỏ; suy luận sâu → model lớn. | bảng route → model |
| T6 | Việc code làm được (parse, tính, lọc, regex, format) không gọi LLM. | grep |
| T7 | Việc không cần real-time (báo cáo định kỳ, xử lý hàng loạt) → Batch API. | danh sách job |
| T8 | `max_tokens` theo loại tác vụ; output dạng schema ngắn; cấm model lặp lại input. | config |
| T9 | Lịch sử hội thoại: cửa sổ trượt + compaction khi vượt ngưỡng; không gửi full lịch sử mỗi lượt. | đo token theo độ dài hội thoại |
| T10 | Kết quả tool: cắt trường thừa, phân trang, tóm trước khi trả model. | so kích thước |
| T11 | Just-in-time: lưu tham chiếu, chỉ tải nội dung khi cần; không nhồi toàn bộ tài liệu. | |
| T12 | Chỉ nạp tool cần cho tác vụ; mô tả tool ngắn, không trùng. | đếm tool/request |
| T13 | Cache ở tầng ứng dụng cho tác vụ tất định, có TTL; **khóa cache phải tách theo user** — không bao giờ trả kết quả của user A cho user B. | test 2 user |
| T14 | Chống request trùng (double-click, retry phía client) bằng idempotency key → không trả phí 2 lần. | test bấm 2 lần |
| T15 | Trần ngân sách token/chi phí theo request, user, ngày; vượt → dừng có thông báo rõ. | test vượt trần |

Dashboard bắt buộc: token/request, chi phí/request, cache hit rate, theo route.

---

# PHẦN V — PRIVACY TỐI ĐA KHI VẪN DÙNG PROVIDER (P0–P8)

Mục tiêu: user chat bình thường, tiện như cũ; provider nhận ít nhất có thể; web không giữ thừa.
Chỉ có một cửa duy nhất gọi provider: **Privacy Gateway** ở server. Mọi đường khác gọi thẳng provider = `PRV-` `CRITICAL`.

| Lớp | Việc | Giới hạn phải nói thật |
|---|---|---|
| **P0 Không thu thập thừa** | Mặc định không lưu nội dung chat, hoặc lưu mã hóa có TTL. Không analytics/APM/error tracker nào nhận nội dung. Telemetry chỉ metadata (token, độ trễ, mã lỗi); bắt nội dung tắt. | Lỗi debug khó hơn → dùng trace id + tái hiện cục bộ |
| **P1 Hợp đồng provider** | Chỉ dùng API key thương mại, không tài khoản consumer. Xác minh no-training. Xin ZDR nếu đủ điều kiện. OpenAI: `store=false`. Ghi rõ ngoại lệ an toàn (lưu để chống lạm dụng) vào trang privacy. | ZDR vẫn có ngoại lệ pháp lý/chống lạm dụng; cần đọc điều khoản gốc |
| **P2 Khử định danh có đảo ngược** | Trước khi gửi: phát hiện PII → thay token ổn định (`<PERSON_1>`, `<PHONE_1>`, `<EMAIL_1>`, `<ID_1>`) → gửi → nhận → khôi phục. Bảng ánh xạ chỉ trong bộ nhớ theo phiên; không log, không ghi đĩa. Tiếng Việt: regex CCCD 12 số, SĐT VN, email, STK; tên người Việt (kết hợp regex + danh sách + model NER chạy cục bộ). Đánh giá bằng bộ test PII tiếng Việt có nhãn: đo recall. | Không che được nội dung nhạy cảm không phải PII; ngữ cảnh vẫn có thể giúp tái định danh |
| **P3 Định tuyến theo độ nhạy** | Phân loại độ nhạy **cục bộ** (cấm gọi LLM ngoài để phân loại). Thấp → provider + P1 + P2. Cao → model mở tự host, hoặc dịch vụ confidential inference trong TEE có remote attestation (xác minh attestation thật, không tin quảng cáo). Fallback khi provider sập **chỉ sang đích có mức privacy bằng hoặc cao hơn** — không bao giờ hạ cấp. | Model tự host thường yếu hơn; TEE tốn chi phí, phụ thuộc chuỗi tin cậy phần cứng |
| **P4 Lưu trữ & kênh** | TLS. Mã hóa lúc lưu. Khóa theo user để xóa = hủy khóa (crypto-shredding) `[INFER]`. Cache tách theo user. Không lưu nội dung user ở `localStorage` trình duyệt nếu không cần. | |
| **P5 Quyền user** | Trang privacy nói đúng sự thật: gửi cho provider nào, giữ bao lâu, ngoại lệ gì. Nút xóa, nút xuất dữ liệu. Chế độ "riêng tư cao" (ép P3 mức cao). Tùy chọn xem bản đã khử định danh được gửi đi. | |
| **P6 Cá nhân hóa không xâm phạm** | Hồ sơ cá nhân hóa lưu ở server của mình, mã hóa, user xem/sửa/xóa được. Mỗi request chỉ nạp thuộc tính cần; khử định danh trước khi gửi. Memory có nguồn gốc (provenance), kiểm trước khi ghi, có rollback. | |
| **P7 Pháp lý Việt Nam** | Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 (hiệu lực 01/01/2026) và nghị định hướng dẫn. Gửi chat user Việt Nam tới provider đặt ở nước ngoài → kiểm nghĩa vụ chuyển dữ liệu xuyên biên giới, đồng ý hợp lệ, thông báo xử lý, quyền chủ thể dữ liệu. Ghi `LAW-` cho từng khoảng trống. **Không phải tư vấn pháp lý; cần luật sư xác nhận.** | |
| **P8 Test egress (bắt buộc pass trước push)** | Gửi request chứa PII giả (tên, SĐT, CCCD, email giả) → chặn bắt payload đi ra provider (mock) → khẳng định không còn PII gốc; response trả user đã khôi phục đúng. Kiểm log/telemetry không chứa PII giả. Kiểm 2 user không đọc được cache của nhau. | |

---

# PHẦN VI — HARNESS AGENT (H1–H20)

Mỗi dòng phải có: cơ chế trong code (file:line) + test tự động chứng minh.

| # | Edge case | Cơ chế bắt buộc | Test chứng minh |
|---|---|---|---|
| H1 | Timeout | Timeout từng tool + tổng request; hủy lan truyền (AbortController) | tool giả treo → hủy đúng hạn, báo lỗi rõ |
| H2 | Rate limit 429/529 | Đọc `retry-after`; backoff mũ + jitter; trần số lần; hàng đợi + token bucket phía mình theo provider | mock 429 liên tiếp → không vượt trần, không bão retry |
| H3 | Lỗi tạm thời vs vĩnh viễn | Phân loại; chỉ retry lỗi retryable | mock 400 → không retry |
| H4 | Provider sập | Circuit breaker; fallback chỉ sang đích cùng/ cao hơn mức privacy | mock 5xx kéo dài → breaker mở, fallback đúng |
| H5 | Hallucination | Structured output + validate schema; claim phải trỏ nguồn đã truy xuất; nhãn tin cậy; evaluator; được phép trả "không biết" | câu hỏi không có dữ liệu → không bịa |
| H6 | Duplicate task | Idempotency key xác định từ ngữ cảnh `{run_id}:{step}:{tool}`, **không** băm nội dung; action ledger + ràng buộc UNIQUE | gửi cùng job 2 lần / retry giữa chừng → tác dụng phụ 1 lần |
| H7 | Race condition | Optimistic locking (version); lease có TTL cho job; một writer cho mỗi conversation; transaction | 2 worker cùng job → chỉ 1 chạy |
| H8 | Crash giữa chừng | Checkpoint trạng thái sau mỗi bước; resume; nhật ký tác dụng phụ; saga bù trừ cho tác vụ nhiều bước | kill process giữa bước → resume không lặp |
| H9 | Vòng lặp/chạy quá | Trần bước, trần token, trần thời gian; phát hiện lặp hành động | agent giả lặp → dừng đúng trần |
| H10 | Tràn context | Compaction có kiểm soát; ghi chú cấu trúc ra ngoài; đo mất mát sau nén | hội thoại dài → không mất dữ kiện then chốt |
| H11 | Prompt injection gián tiếp | Nội dung web/tool là dữ liệu, không là lệnh; tool nguy hiểm cần xác nhận; allowlist | trang web chứa "bỏ qua chỉ dẫn" → không đổi hành vi |
| H12 | Memory poisoning | Ghi memory có kiểm, provenance, không tự nạp output agent vào memory tin cậy, snapshot/rollback | ghi memory độc → bị chặn/rollback |
| H13 | Stream đứt | Resume hoặc báo rõ; UI không treo | ngắt mạng giữa stream |
| H14 | Sandbox | Chạy code/lệnh: cô lập, không mạng mặc định, giới hạn CPU/RAM/thời gian, FS chỉ đọc. **Có exec mà không sandbox → `CRITICAL`** | lệnh độc trong sandbox không thoát |
| H15 | State | Một nguồn sự thật; job là máy trạng thái rõ (queued/running/succeeded/failed/cancelled); không giữ state quan trọng chỉ trong RAM (serverless mất RAM giữa lần gọi) | restart → state còn |
| H16 | Observability | Trace id xuyên suốt; span theo quy ước OpenTelemetry GenAI; bắt nội dung **tắt** mặc định; metric độ trễ/token/lỗi/chi phí | trace 1 request đủ cây span, không có nội dung user |
| H17 | Orchestration | Ưu tiên workflow tất định khi được; agent khi cần linh hoạt; subagent cô lập ngữ cảnh; song song việc độc lập | |
| H18 | Hành động không đảo ngược | Gửi email/khách, thanh toán, xóa dữ liệu → cổng xác nhận người | |
| H19 | Đổi model/provider | Ghim phiên bản model; chạy eval cố định trước khi đổi | eval regression |
| H20 | Dữ liệu real-time cũ | Mọi dữ liệu thời gian thực mang timestamp + nguồn; quá hạn → làm mới hoặc gắn cờ | dữ liệu quá hạn bị gắn cờ |

---

# PHẦN VII — Ý TƯỞNG NÂNG CẤP (Phase 1 chấm, AUTO làm cái rủi ro thấp)

| # | Ý tưởng | Giải quyết | Nguồn | Chi phí |
|---|---|---|---|---|
| I1 | Privacy Gateway một cửa (P0–P3) | Rò dữ liệu user ra provider | Mẫu anonymize → LLM → deanonymize (Presidio) | M |
| I2 | Router độ nhạy + chế độ "riêng tư cao" (self-host/TEE) | Dữ liệu nhạy cảm cao | OpenPcc, nhà cung cấp confidential inference | L |
| I3 | Evaluator ngữ cảnh mới, chỉ đọc | Agent tự chấm "xong" sai | anthropics/cwc-long-running-agents | S |
| I4 | Action ledger + idempotency key xác định | Tác dụng phụ lặp | bài về idempotency cho agent | S–M |
| I5 | Run state machine + checkpoint/resume | Crash, serverless mất state | durable execution | M |
| I6 | Tracing OpenTelemetry GenAI, nội dung tắt | Không nhìn thấy hệ thống | opentelemetry.io | S |
| I7 | Bố cục prompt theo cache + dashboard hit rate | Tốn token | docs prompt caching | S |
| I8 | Làn Batch cho việc không real-time | Chi phí | tài liệu giá provider | S |
| I9 | Router model theo độ khó | Chi phí + độ trễ | `[INFER]` | S |
| I10 | Bộ red-team theo OWASP LLM 2025 + Agentic 2026 chạy trong CI | Injection, tool misuse, memory poisoning | OWASP GenAI Security Project | M |
| I11 | Memory có provenance + rollback | Memory poisoning | OWASP ASI06 | M |
| I12 | Bảng minh bạch cho user: đã gửi gì, cho ai, xóa được | Niềm tin + nghĩa vụ pháp lý | `[INFER]` + Luật 91/2025 | M |
| I13 | Bộ eval vàng + chạy khi đổi prompt/model | Chất lượng trôi | context engineering | M |
| I14 | Kho prompt có version, tách khỏi code, private | Bảo vệ chất xám + A/B | `[INFER]` | S |

---

# PHẦN VIII — BÁO CÁO CUỐI

1. `CHỜ-CHỦ` — đặt đầu tiên, nhất là `NGOÀI-REPO` (rotate key, visibility, ZDR, pháp lý)
2. Tổng quan: số file đã đọc / tổng, số vấn đề theo mức
3. Ledger đầy đủ — bảng full, không tóm tắt
4. Bảng Trước/Sau (`RESULT.md`): token, chi phí, cache hit, độ trễ, lỗi, egress, test
5. Kết quả 13 cổng + evaluator
6. Đã sửa theo nhóm · DEFERRED/BLOCKED + lý do
7. Rủi ro còn lại — nói thẳng
8. Git: nhánh, tag, commit, push hash, deploy + smoke test
9. 3 việc ưu tiên tiếp theo

---

# PHẦN IX — NGUỒN THAM CHIẾU (Phase 1 phải mở bản gốc để xác minh trước khi áp dụng)

Harness & context
- Anthropic — Effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic — Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic — Harness design for long-running application development: https://www.anthropic.com/engineering/harness-design-long-running-apps
- Anthropic — Harness primitives (evaluator chỉ đọc): https://github.com/anthropics/cwc-long-running-agents
- Danh mục harness engineering: https://github.com/ai-boost/awesome-harness-engineering

Token
- Claude prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Cache + Batch cộng dồn (thứ cấp): https://technspire.com/en/blog/anthropic-prompt-caching-pricing-mechanics

Privacy provider
- Anthropic API & data retention: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- Claude Code data usage: https://code.claude.com/docs/en/data-usage
- OpenAI data controls: https://developers.openai.com/api/docs/guides/your-data
- Ngoại lệ ZDR (thứ cấp, cần xác minh): https://securityboulevard.com/2026/09/zero-data-retention-what-every-ai-provider-actually-promises-you/

Khử định danh & confidential inference
- Presidio trong pipeline LLM (thứ cấp): https://pasqualepillitteri.it/en/news/5538/microsoft-presidio-pii-data-protection-ai
- Haystack PresidioTextCleaner: https://docs.haystack.deepset.ai/docs/2.29-unstable/presidiotextcleaner
- OpenPcc (TEE CPU+GPU): https://arxiv.org/html/2606.11145v1
- Ví dụ dịch vụ confidential inference: https://phala.com/confidential-ai-models · https://chutes.ai/news/private-ai-inference-verifiable-confidential-llm-serving

Độ tin cậy & bảo mật agent
- Idempotency cho agent: https://tianpan.co/blog/2026-07-01-exactly-once-was-hard-before-your-agent-could-retry-itself
- Durable execution tối giản: https://hackernoon.com/you-dont-need-temporal-yet-durable-execution-for-ai-agents-in-150-lines
- OpenTelemetry GenAI observability: https://opentelemetry.io/blog/2026/genai-observability/
- OWASP LLM Top 10 2025 (thứ cấp): https://www.hackerone.com/ai/owasp-top-10-llms-2025
- OWASP Agentic Top 10 2026 (thứ cấp): https://goteleport.com/blog/owasp-top-10-agentic-applications

Pháp lý Việt Nam
- Hiệu lực Luật BVDLCN 2025: https://luatvietnam.vn/dan-su/luat-bao-ve-du-lieu-ca-nhan-2025-co-hieu-luc-khi-nao-568-103652-article.html
- Tóm tắt Luật 91/2025/QH15: https://gvlawyers.com.vn/wp-content/uploads/2025/09/VN_Legal-alert-_Law-on-PDP-2025.pdf
- Nghị định 356/2025/NĐ-CP hướng dẫn: https://www.ey.com/content/dam/ey-unified-site/ey-com/vi-vn/technical/tax/documents/ey-vietnam-legal-alert-march-2026-decree-no356-2025-nd-cp-providing-detailed-guidance-for-implementation-of-personal-data-protection-law-viet.pdf

---

## BẮT ĐẦU

Chế độ hiện tại: `AUTO` (trừ khi lượt này có `CHẾ ĐỘ: SAFE`).
Đọc `audit/PROGRESS.md` nếu đã tồn tại → tiếp tục từ đó. Chưa có → bắt đầu PHASE 0 §0.1.
