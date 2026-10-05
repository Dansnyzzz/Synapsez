# PROGRESS — vòng audit v3 (AUDIT_RULES v3, chế độ AUTO)

> Đọc file này + `audit/ISSUE_LEDGER.md` (mục "VÒNG v3") trước tiên khi mở phiên mới hoặc sau khi
> ngữ cảnh bị nén. Không suy đoán tiến độ từ trí nhớ hội thoại.

## Trạng thái

- **Phase hiện tại:** 0 → 1 (đọc theo lô phần thay đổi kể từ audit trước).
- **Nhánh:** `main` @ `58b1ab4` (chưa tạo nhánh optimize — Phase 2 mới tạo).
- **Yêu cầu thêm của chủ project (lượt 2026-10-04):** "web tôi xài full free như vercel free" +
  `npm i @vercel/analytics`, `npm i @vercel/speed-insights` → làm trong Phase 2 dưới ID riêng.

## Phase 2 — đang chạy trên `optimize/2026-10-05` (tag `backup/pre-optimize-20261005-0736` = `58b1ab4`)

- FIXED: SEC-034 `53e2457` · PRV-001 `49309a8` · SEC-035 `a555a73` · SEC-036 `fae2ae2` · PRV-002 `74226b5` · SEC-039 `7ba763b` · SEC-040 `1c2917a` · SEC-041 `f1f4913` · PERF-015 `4598974` · SEC-042 `0851a37` · SEC-043 `75f5e50` · SEC-044 `bbb6c49` · PRV-005 `7247353` · SEC-037 `0c4499c` · CODE-031 `ee10f6d`.
- 3 sub-agent đọc vùng [UNKNOWN] đã báo cáo (44 dòng mới trong ledger, `928d162`); mọi HIGH của chúng đã xác minh + sửa.
- Kế tiếp (MEDIUM): PERF-016 → PERF-017 → PERF-018 → ACC-008 → HAR-002 → PRV-004 → CFG-026 → HAR-003 → SEC-046 → UX-006 → UX-005 → ACC-009..012 → PERF-020 → CODE-036 → CFG-027 → CODE-040 → CODE-041 → PERF-019; rồi LOW (gồm GAP-012 Vercel insights).
- Lệnh kiểm chứng mỗi ID: test file liên quan + `npx eslint <files>` + `npm run typecheck` (2 s). Script ledger: `scratchpad/ledger.mjs <ID> <STATUS> <verify> <commit>`.
- Ghi chú: `811d44c` có tiêu đề "ledger SEC-034" nhưng thực chất chỉ thêm 2 dòng HAR-003/HAR-004 (đã nói rõ trong `2c616fa`).
- 3 sub-agent (đọc vùng [UNKNOWN] từ snapshot `58b1ab4`) chạy nền từ 2026-10-05 sáng; kết quả → thêm ID mới.

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
