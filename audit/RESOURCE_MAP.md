# RESOURCE_MAP — tài nguyên sẵn có và cách dùng (AUDIT_RULES v5 PHẦN XIII, vòng v4/v5 — cập nhật 2026-11-03)

Trạng thái: `ĐANG DÙNG ĐÚNG` · `DÙNG THỪA` · `CÓ MÀ CHƯA DÙNG` (kèm quyết định) · `KHÔNG CẦN`.

## Model / provider

| Tài nguyên | Trạng thái | Bằng chứng / quyết định |
|---|---|---|
| Prompt caching Anthropic | ĐANG DÙNG ĐÚNG | breakpoint cuối tools + system (`anthropic.js:136-137`); ngày đứng một mình trong system, ghi chú lượt nằm trong tin nhắn người dùng (`agent.js` — giữ tiền tố ổn định, T1–T3) |
| Prompt caching OpenRouter | ĐANG DÙNG ĐÚNG | `markPromptCache` (`providers/index.js:44`) |
| Prompt caching OrcaRouter | CÓ MÀ CHƯA DÙNG | OrcaRouter không có marker theo request → không có gì để bật (agent harness, `index.js:47`) |
| Effort / thinking | ĐANG DÙNG ĐÚNG sau GAP-014 + PERF-025 | `REASONING_MAP.md` |
| Định tuyến model rẻ cho việc phụ (compaction, extract, plan) | ĐANG DÙNG ĐÚNG | `roleModel.js` — chỉ đổi khi chứng minh rẻ hơn |
| Strict tool schema (Anthropic) | ĐANG DÙNG ĐÚNG | `anthropic.js:156` |
| Batch API | KHÔNG CẦN (hiện tại) | không có việc hàng loạt không real-time; lịch chạy là từng lượt có người đọc kết quả |
| Đếm token trước khi gửi (`messages.countTokens`) | CÓ MÀ CHƯA DÙNG | quyết định: chưa dùng — mỗi lần đếm là một request nữa trên free tier; đồng hồ ngữ cảnh ước lượng (TOK-002 ghi nhận sai số với schema tool) |
| Citations cho PDF đọc nguyên bản (Anthropic) | CÓ MÀ CHƯA DÙNG | quyết định: chưa dùng — không đi chung request với structured output (V10); cổng QC-001 đã kiểm trích dẫn URL tất định; trích dẫn trong PDF là bước sau (RES-001, CHỜ-CHỦ: cần key Anthropic sống để kiểm) |
| Tìm kiếm web của provider (Gemini grounding) | ĐANG DÙNG ĐÚNG | trong chuỗi tìm kiếm có hạn mức (`freeTier.js`) |

## Dịch vụ miễn phí (một hạn mức chung mỗi deployment — `freeTier.js`)

| Tài nguyên | Trạng thái | Ghi chú |
|---|---|---|
| Exa ($10/tháng), Tavily (1.000/tháng), Brave ($5, cần thẻ), Google grounding, Stack Exchange | ĐANG DÙNG ĐÚNG | trần 95–97% + phần mỗi tài khoản/ngày (`FREE_TIER_USER_DAILY`); thích ứng Exa deep→auto→lite khi thiếu. Brave (có thẻ, không trần riêng) nay trừ trước khi gọi bằng một upsert và dừng khi không đọc được bộ đếm (HAR-009, `a0ba9b2`); một lỗi nhà cung cấp dừng ở 5 lời gọi hỏng mỗi request (HAR-013, `e5105c0`) |
| Cache tìm kiếm 10 phút | ĐANG DÙNG ĐÚNG sau PRV-016 | tách theo tài khoản (T13) |
| E2B ($100 hết hạn 2027-12-01 + $5) | ĐANG DÙNG ĐÚNG sau HAR-007/HAR-010/SBX-005 | trần tháng rải đều; phần mỗi tài khoản (`E2B_ACCOUNT_SHARE`); hoàn tiền khi khởi động hỏng; giới hạn output/tệp |
| Vercel Sandbox (dự phòng) | ĐANG DÙNG ĐÚNG | thay thế khi E2B từ chối/hết phần/không nạp được SDK (SBX-002) |

## Hạ tầng

| Tài nguyên | Trạng thái | Ghi chú |
|---|---|---|
| Vercel Hobby: hàm 300 s | ĐANG DÙNG ĐÚNG sau HAR-012 | ngân sách mỗi lời gọi model 240 s (`PROVIDER_REQUEST_BUDGET_MS`) |
| Vercel Cron (1 lần/ngày trên Hobby) + pinger ngoài | ĐANG DÙNG ĐÚNG | `api/cron/*`; pinger cron-job.org từng làm Neon hết giờ tính toán (memory) — nay Supabase |
| Supabase Postgres free | ĐANG DÙNG ĐÚNG | pooler 6543; SEC-060 (thiếu CA) CHỜ-CHỦ |
| Vercel Analytics / Speed Insights | ĐANG DÙNG ĐÚNG | ẩn danh, không nội dung, chỉ app chính, tôn trọng GPC/DNT |
| CDN cho `public/` | ĐANG DÙNG ĐÚNG | `express.static` maxAge 0 + ETag (đã xét ở vòng trước, không cache-bust) |

## Plugin / skill / MCP của chính phiên audit

Xem `SKILL_MAP.md` §5. Dùng: agent project `security-auditor`, `code-reviewer` (đọc), `verify`; không dùng skill tự chạy git/release.

## Rò tài nguyên (L9) — đã sửa trong vòng này

Đã sửa: PERF-024 (blob URL sơ đồ được thu hồi cùng sơ đồ, `cf31879`), UI-002 (đóng panel khi đang lái thì dừng timer giữ máy thức, `649078a`), HAR-011 (socket chưa xác thực không chiếm chỗ panel, `fd77044`), SBX-005 (output E2B không giới hạn), SEC-062 (giải mã ảnh không rõ kích thước).