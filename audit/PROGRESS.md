# PROGRESS — vòng audit v3 (AUDIT_RULES v3, chế độ AUTO)

> Đọc file này + `audit/ISSUE_LEDGER.md` (mục "VÒNG v3") trước tiên khi mở phiên mới hoặc sau khi
> ngữ cảnh bị nén. Không suy đoán tiến độ từ trí nhớ hội thoại.

## Trạng thái

- **Phase hiện tại:** 3 (kiểm chứng), lần 2 — evaluator lần 1 trả `NEEDS_WORK` (2 chặn + 5 không chặn) → quay lại Phase 2 với ID mới PRV-006 `3a773b5`, PRV-007 `4fb2530`, SEC-050 `0588530`, CODE-049 `80588d7`; sửa bảng token trong RESULT.md. Evaluator lần 2 (agent mới) cũng `NEEDS_WORK` (1 chặn + 7) → PRV-008 `383ff2d` (chặn: quyết định công bố theo id trùng), HAR-006 `3ccd8e7`, CODE-050 `2e7c612`, UX-008 `9b80bd5`, CFG-030 `bc5c01d`, PRV-009 `b699b4a`; CFG-031, CFG-032 → CHỜ-CHỦ; sửa GAP (secret ngoài repo → MỘT PHẦN) và RESULT (dòng console.log). Ledger v3 = 86 dòng = 70 FIXED + 14 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO, 0 OPEN. Evaluator lần 3 (lần đầu chết vì 429, chạy lại) `NEEDS_WORK` → PRV-010 `879438d` (chặn: `update_file` sửa tệp chat khác theo id), UX-009 `be1ec2b`, CODE-051 `7f15dcf`, CODE-052 `4e60f60`. Ledger v3 = 90 = 74 FIXED + 14 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO, 0 OPEN. Evaluator lần 4 `NEEDS_WORK` → PRV-011 `9a708fd` (chặn: tệp của link chia sẻ đọc trực tiếp, không theo ảnh chụp), CODE-053 `6f50c7a` (chặn: RESULT còn câu egress), SEC-051 `9f6931d`, UX-010 `de8c0d7` (test trình duyệt còn bắt được: lựa chọn Repeat bị mất khi đóng panel), SEC-052 `4a7d99a`, CODE-054 `9896f0f`. Ledger v3 = 96 = 80 FIXED + 14 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO, 0 OPEN. Evaluator lần 5 `NEEDS_WORK` → UX-011 `e3373b1` (chặn: UX-010 còn đọc ô từ panel dùng chung), PRV-012 `6d17c57` (chặn: sửa tin sau khi chia sẻ lọt ra khách), CODE-055 `2e91871`, SEC-053 `9e81771`; PRV-013 → CHỜ-CHỦ (cần cột); ACC-017 → DEFERRED. Ledger v3 = 102 = 84 FIXED + 15 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO + 1 DEFERRED, 0 OPEN. Evaluator lần 6 `NEEDS_WORK` (không còn rò rỉ trên đường chia sẻ; 3 hẹp) → CODE-056 `2e9b564`, SEC-054 `31fc494`, UX-012 `41b4b82`, CODE-057 `b4bc7db`, CODE-058 `c31d604`. Ledger v3 = 107 = 89 FIXED + 15 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO + 1 DEFERRED, 0 OPEN. Gate lần 7 xanh (`5d0fc03`, 214 s). Evaluator lần 7 `NEEDS_WORK` (code giữ vững; 1 chặn là câu trong CHANGELOG) → CODE-059 `973042b`, UX-013 `e0a85ff` (mở lại khi PATCH còn đang bay; lần mở/đóng sau cùng thắng), CODE-060 `7ccd19e`, CODE-061 `d4c17a6`. Ledger v3 = 111 = 93 FIXED + 15 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO + 1 DEFERRED, 0 OPEN (đếm bằng script). Gate lần 8 xanh (`fc9e922`, 224 s, 4.586 ✓). Evaluator lần 8 `NEEDS_WORK` (1 chặn: hồi quy do UX-013 — mở lịch khác bị kéo về lịch cũ) → UX-014 `783d30d` + `f63591b` (gate đỏ lần đầu vì test đọc mã nguồn tìm dòng cũ). Ledger v3 = 112 = 94 FIXED + 15 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO + 1 DEFERRED, 0 OPEN. Gate xanh (`1186563`, 218 s, 4.586 ✓); test:ui 927 ✓. Evaluator lần 9 **`PASS`** (không chặn; 3 mục "could be better" → UX-015, UX-016, CODE-062 DEFERRED có lý do). Ledger v3 = 115 = 94 FIXED + 15 CHỜ-CHỦ/TRONG-REPO + 2 NGOÀI-REPO + 4 DEFERRED, 0 OPEN. **Phase 4 xong:** merge `--no-ff` → `ba85616`; gate trên main xanh (213 s, 4.586 ✓); push `58b1ab4..ba85616` (không force); smoke prod pass (bản mới phục vụ, CSP giữ nguyên, script Vercel 200, token chia sẻ bịa 404, favicon không phiên 401). Vòng v3 khép lại; còn lại là các hàng CHỜ-CHỦ và DEFERRED trong ledger.
- **2026-10-06, yêu cầu tiếp của chủ (nhánh `feat/2026-10-06-owner-requests`):** giao diện (viền ẩn danh, bỏ tab Chạy theo giờ trong Cài đặt, nền panel kết nối, tool cuối bị che) `2c321fa`; model bị rút → Auto + thông báo, lịch/chuỗi việc chạy theo model hiện tại `3678b89` `2f6eda6`; MCP stdio trên máy tính đám mây + kiểm một lần cho mọi người `29b0c88`; CHỜ-CHỦ sửa được: PRV-013 `544011a`, CFG-028 `78f0c2b`, SEC-049 `333d979`, HAR-005 `47d6ae2`, PERF-022 `49e55bd`; DEFERRED sửa được: UX-015/016, CODE-062 `ea30fdf`; EXP-005 đóng (repo public, quét toàn lịch sử). Không làm được: `.env.example` (luật quyền `.env.*` chặn ghi, agent không tự nới — nội dung soạn sẵn), CFG-031 (`.claude/hooks`). Ledger v3 = 116 = 103 FIXED + 10 CHỜ-CHỦ + 3 DEFERRED, 0 OPEN.
- **Nhánh:** `optimize/2026-10-05` (tách từ `main` @ `58b1ab4`).
- **Yêu cầu thêm của chủ project (lượt 2026-10-04):** "web tôi xài full free như vercel free" +
  `npm i @vercel/analytics`, `npm i @vercel/speed-insights` → làm trong Phase 2 dưới ID riêng.

## Phase 2 — đang chạy trên `optimize/2026-10-05` (tag `backup/pre-optimize-20261005-0736` = `58b1ab4`)

- FIXED (ledger là nguồn chuẩn; danh sách này đối chiếu lại từ ledger lúc cập nhật 2026-10-05):
  - HIGH/MEDIUM: SEC-034 `53e2457` · PRV-001 `49309a8` · SEC-035 `a555a73` · SEC-036 `fae2ae2` · PRV-002 `74226b5` · SEC-039 `7ba763b` · SEC-040 `1c2917a` · SEC-041 `f1f4913` · PERF-015 `4598974` · SEC-042 `0851a37` · SEC-043 `75f5e50` · SEC-044 `bbb6c49` · PRV-005 `7247353` · SEC-037 `0c4499c` · CODE-031 `ee10f6d` · PERF-016 `516bf10` · PERF-017 `28c6b94` · PERF-018 `64bdf0a` · PERF-019 `71ab750` · ACC-008 `37e309d` · HAR-002 `2ea90ea` · PRV-004 `3101fef` · CFG-026 `aedd6e2` · HAR-003 `58b9b1f` · SEC-046 `c7af02a` · UX-005 `b929640` · UX-006 `0d0b3fc` · ACC-009 `fdeed7e` · ACC-010 `95ca45c` · ACC-011 `1b8ffc2` · ACC-012 `30db765` · PERF-020 `7d4177a` · CODE-036 `2815cb9` · CFG-027 `3b48180` · CODE-040 `b14ba6c` · CODE-041 `9a8ecf3`.
  - LOW: GAP-012 `2c134ec` (Vercel Analytics + Speed Insights) · SEC-048 `c92373b` · CODE-033 `fe2b24a` · CODE-035 `7ea1630` · CODE-042 `e78fc7a` · SEC-038 `005516f` · SEC-045 `5f8ca6d` · TOK-001 `b77ad2a` · CODE-037 `c6eae69` · ACC-013 `d8a6451` · ACC-014 `b1f66a2` · ACC-015 `4f2bf7b` · ACC-016 `f4b7db5` · PERF-021 `8e13f69` · UX-007 `d00fe4a` · CODE-038 `1bc183d` · CODE-039 `d58d92a` · CFG-029 `c9694f4` · CODE-044 `842fec6` · CODE-045 `a082b54` · CODE-046 `765e2c7` · CODE-047 `7da176e` · CODE-043 `934f174` · CODE-048 `612daa8` (dòng mới, phát hiện khi làm CODE-047).
- CHỜ-CHỦ: PRV-003, HAR-001, HAR-004, HAR-005, CODE-032, CODE-034, CFG-024, CFG-025, PERF-022, SEC-049, SEC-047, CFG-028; NGOÀI-REPO: EXP-005, LAW-001.
- 3 sub-agent đọc vùng [UNKNOWN] đã báo cáo (44 dòng mới trong ledger, `928d162`); mọi HIGH của chúng đã xác minh + sửa.
- CODE-043 dự kiến CHỜ-CHỦ nhưng sửa được không cần chủ: probe còn trên clipboard giờ là FAIL thật.
- Kiểm chứng trên trình duyệt thật (ui.test, Edge): ACC-016, PERF-021, UX-007, CODE-038 — "All interface checks passed".
- Ghi chú: `612daa8` mang dòng CODE-048 bị cắt ở dấu `"` đầu tiên (PowerShell 5.1 tách tham số); dòng đầy đủ ở `143be92`.
- CODE-042: test đầu tiên (6 lần lưu song song qua HTTP) pass cả trên code cũ vì PGlite chạy từng truy vấn một → bỏ; thay bằng test ép lần lưu rơi đúng vào khe đọc–ghi (fail trên code cũ, pass trên code mới).
- Ghi chú ledger: mô tả của SEC-039 và PERF-017 chứa `|` chưa escape làm lệch cột bảng → đã escape `\|` (2026-10-05).
- Lệnh kiểm chứng mỗi ID: test file liên quan + `npx eslint <files>` + `npm run typecheck` (2 s). Script ledger: `scratchpad/ledger.mjs <ID> <STATUS> <verify> <commit>`.
- Ghi chú: `811d44c` có tiêu đề "ledger SEC-034" nhưng thực chất chỉ thêm 2 dòng HAR-003/HAR-004 (đã nói rõ trong `2c616fa`).

## Đã xong

- 0.1 an toàn: `.env*` chưa từng commit; `.fuse_hidden*` không track; gitleaks không cài. → `CONTRACT.md`, `EXPOSURE.md` (cần thêm mục v3).
- 0.1b visibility: API GitHub ẩn danh 404 → private lúc audit (AUDIT_RULES ghi PUBLIC). `.env.example` bị chủ project xoá ở `8253179`.
- 0.2 hợp đồng: `audit/CONTRACT.md`.
- 0.6 baseline: `audit/BASELINE.md` mục v3 (gate xanh 255 s, 4.282 ✓, 1 skip, typecheck 315/315, coverage 64.09/75.42/67.03/64.09).
- 0.8 dataflow: `audit/DATAFLOW.md`.
- Nghiên cứu Vercel insights: gói `@vercel/analytics@2.0.1`, `@vercel/speed-insights@2.0.0` (đọc `dist/index.mjs` trong scratchpad). Không bundler → phải vendor ESM vào `public/vendor/` như katex/pdfjs. Prod đã trả 200 cho `/_vercel/insights/script.js` và `/_vercel/speed-insights/script.js`. Giới hạn Hobby: Analytics 50.000 sự kiện/tháng (vượt → dừng thu 3 ngày ân hạn rồi dừng); Speed Insights 10.000 sự kiện/30 ngày cuộn (vượt → dừng ≥14 ngày).

## Sự cố quy trình

- 2026-10-04: 5 agent đọc song song (routes/auth/store · egress/sandbox/tools · harness/providers · frontend · tests/docs/.claude) **đều chết vì giới hạn phiên 429** trước khi báo cáo. Không có kết quả nào từ chúng được dùng. Lead auditor tự đọc theo lô.

## Kế tiếp

1. Đọc theo lô (≤12 file/lô) các file đổi kể từ `6e526f1` — danh sách `git diff --numstat 6e526f1 58b1ab4`. Thứ tự: server/routes → server (egress/sandbox) → server/tools → harness/providers/memory → store → public → tests/scripts → .claude.
2. File không đổi kể từ `6e526f1` = đã audit ở vòng 2026-09-28 (6e526f1) và vòng v2 (2026-09-14); ghi nhận, không đọc lại.
3. Ghi ledger mục "VÒNG v3" ngay khi thấy.

## Lô đã đọc (lead auditor tự đọc)

- Lô 1/6 routes: `server/routes/share.js`, `chatShare.js`, `account.js`, `files.js` (đủ); diff `routes/chats.js`, diff `server/app.js`; `server/settings.js` (đủ); `server/providers/index.js:340-460`.
- Lô 2/6 egress/sandbox: `server/imageProxy.js`, `favicon.js`, `sandbox.js`, `cloudBrowser/index.js` (đủ); `cloudBrowser/service.mjs:380-461`; `tools/definitions.js:2700-2930`.
- Lô 3/6 harness: `server/resume.js`, `progress.js`, `memory.js`, `audit.js` (đủ); `agent.js:405-445,630-925` + diff code; `store/pg.js:1000-1184`.
- Lô 4/6 frontend: `public/js/markdown.js:250-360` + diff các dòng sinh HTML; sink scan `cards.js`, `sketch.js`, `cite.js`, `webrows.js`, `share-view.js`, `privacy.js`, `plan.js`; `privacy.js:80-145,238-280`; `locales/en.js:1415-1464`.
- Lô 5/6: diff code `scheduler.js`/`workflows.js`; khảo sát mọi `fetch(` trần trong `server/`; `.claude/hooks/*` (lệnh git), `.claude/settings.json`.
- Lô 6/6: `server/vision.js:1-127`; `public/js/import-formats.js` (scan); `test/desktop.test.mjs:140-165`.

**[UNKNOWN] chưa đọc vòng v3** (đổi kể từ `6e526f1` nhưng chưa mở): phần còn lại của `tools/cloud.js` (ngoài memory + `getJson`), `render.js`, `pages.js`, diff `public/js/app.js`, phần còn lại của `cards.js`/`cite.js`/`sketch.js`, `schedule-grammar.js`, `subagents.js`, `compact.js`, `projects.js`, `research/*`, adapter `providers/{anthropic,google,openaiCompatible}.js`, `ocr.js`, `pdf.js`, `tools/{sports,images,library,calc,cards,chart,validate}.js` (ngoài getJson), `css/app.css`, test delta, `scripts/storage.js`, `worker/` diff. Đã có test xanh phủ các vùng này (gate 4.282 ✓) nhưng đó không phải là đã đọc.

**Không đổi kể từ `6e526f1`:** đã audit vòng 2026-09-28 (`6e526f1`) và v2 (2026-09-14); không đọc lại.

## Quyết định đã chốt

- Ledger v3 nối tiếp ID cũ: SEC-033+, CODE-031+, PERF-014+, AUTO-010+, ARCH-010+, UX-005+, GAP-012+, EXP-005+, ACC-008+, CFG-024+; tiền tố mới PRV-001+, TOK-001+, HAR-001+, LAW-001+.
- Vercel insights chỉ nạp khi server báo đang chạy trên Vercel (`/api/session` → `insights`), chỉ trên app chính (`index.html`), không trên `share.html`/`launcher.html`; `beforeSend` cắt query + hash; bỏ qua khi GPC/DNT bật.

- Ghi chú lịch sử commit SEC-039: code nằm trong `7ba763b` (tiêu đề sai: 'ledger SEC-039 fixed in 928d162'); `d266ed1` mang đúng message mô tả SEC-039 nhưng chỉ chứa dòng ledger trỏ về `7ba763b`. Nguyên nhân: lệnh commit lỗi vì dấu ngoặc kép PowerShell. Từ đây mọi ID dùng `scratchpad/fix.ps1` (dừng nếu commit code lỗi).
