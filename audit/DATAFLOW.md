# DATAFLOW — dữ liệu người dùng đi đâu (vòng v3, 2026-10-04, `58b1ab4`)

Mỗi dòng: một đích nhận hoặc lưu dữ liệu người dùng. Không dòng nào khử định danh trước khi gửi
(**không có lớp P2** trong codebase — xem `PRV-001`). "Thời gian lưu" lấy từ tài liệu gốc khi có;
còn lại `[UNKNOWN]`. Đây không phải tư vấn pháp lý.

## 1. Provider LLM — nội dung đầy đủ

| Đích | File:line | Trường dữ liệu | Khử định danh? | Mục đích | Thời gian lưu (nguồn) | Xuyên biên giới? | Đánh giá |
|---|---|---|---|---|---|---|---|
| Anthropic `api.anthropic.com` | `server/providers/anthropic.js`; base `server/models.js:457` | toàn bộ hội thoại, system prompt (custom instructions + ghi chú memory `server/memory.js` `memoryForTurn` + đoạn trích project), tệp đính kèm (ảnh/PDF), kết quả tool | Không | trả lời | không train nếu không cho phép; nội dung không giữ mặc định trừ Covered Models 30 ngày (platform.claude.com/docs/en/manage-claude/api-and-data-retention) | Có (VN → US) | Chấp nhận được với key thương mại; cần nêu trên trang privacy |
| OpenAI `api.openai.com` | `server/providers/openaiCompatible.js`; `server/models.js:466` | như trên | Không | trả lời | [UNKNOWN] vòng này chưa mở trang gốc | Có | Cần xác minh `store` |
| Google Gemini `generativelanguage.googleapis.com` | `server/providers/google.js`; `server/models.js:477` | như trên | Không | trả lời; cũng là "mắt" cho model mù (`server/vision.js`) | **Free tier: Google dùng để cải thiện sản phẩm, người duyệt có thể đọc**; Paid: không train, log ngắn hạn chống lạm dụng (ai.google.dev/gemini-api/terms) | Có | **Rủi ro privacy cao khi người dùng dùng key free** — phải nói thật trong UI (→ `PRV-` ledger) |
| OpenRouter `openrouter.ai` (Auto = `openrouter/free`) | `server/providers/openaiCompatible.js:301`; `server/autoPick.js:8` | như trên | Không | trả lời; định tuyến sang provider bên dưới | `data_collection` mặc định `allow` → provider bên dưới **có thể lưu và train**; `strict` của app gửi `provider:{data_collection:'deny', zdr:true}` (openrouter.ai/docs/guides/routing/provider-selection) | Có | Mặc định của app là không-strict → hội thoại Auto có thể bị train; cần nêu rõ (→ `PRV-`) |
| OrcaRouter `api.orcarouter.ai` | `server/models.js:10` | như trên | Không | trả lời | [UNKNOWN] | Có | [UNKNOWN] |
| Embedding RAG (OpenAI / Gemini) | `server/rag.js:111,137` | đoạn văn tài liệu project | Không | tìm kiếm ngữ nghĩa | như dòng provider tương ứng | Có | Như trên |

## 2. API bên ngoài nhận dữ liệu suy ra từ tin nhắn (do model viết tham số)

| Đích | File:line | Trường | Khử định danh? | Đánh giá |
|---|---|---|---|---|
| Exa / Tavily / Brave / DuckDuckGo / Gemini grounding | `server/search.js:111,136,154,197,273` | câu truy vấn tìm kiếm | Không | Truy vấn có thể chứa tên/địa điểm người dùng nhắc tới; chỉ query, không gửi cả hội thoại [INFER từ chữ ký hàm] |
| Open-Meteo | `server/tools/cloud.js:1203,1208` | tên địa điểm / toạ độ | Không | tối thiểu |
| open.er-api.com, CoinGecko, Yahoo Finance, Nager.Date | `server/tools/library.js:122,281,305,315,349` | mã tiền tệ/ticker/quốc gia | — | không phải dữ liệu cá nhân |
| Nominatim, OSRM, tile OSM | `server/tools/library.js:387,439`; `server/imageProxy.js:172` | địa điểm, toạ độ, z/x/y | Không | địa chỉ người dùng có thể lọt vào query |
| Openverse, Wikimedia Commons | `server/tools/images.js:48,73` | từ khoá ảnh | — | tối thiểu |
| TheSportsDB | `server/tools/sports.js:20` | tên đội | — | tối thiểu |
| Trang web bất kỳ (web_fetch, deep_research) | `server/safeFetch.js` | URL (model chọn) | — | URL có thể mang dữ liệu → đã có `carriesData()` chấm `sensitive` (vòng 2026-09-28) |
| YouTube (nhúng `youtube-nocookie.com`) | trình duyệt, `securityHeaders.js:31` | IP + video id của người xem | — | chỉ khi bấm/hiện card |

## 3. Đích do người dùng chủ động nối (connector / OAuth / MCP)

GitHub, Notion, Slack, Supadata, Telegram, Facebook Graph (`server/connectors.js:29-174`), Google
Workspace qua OAuth (`server/google.js`, `server/tools/google.js`), MCP server từ xa
(`server/mcp/`). Nhận đúng tham số của lời gọi tool; token người dùng lưu mã hoá trong DB
(`server/crypto.js`). Hành động ghi (gửi mail, đăng tin) qua cổng duyệt `assessRisk`.

## 4. Gửi thư

Resend `api.resend.com` (`server/email.js:146`) hoặc Gmail SMTP (`server/email.js:201`): người nhận,
tiêu đề, nội dung. Local không cấu hình mail → in ra terminal (`server/email.js:222-226`, có chủ
đích, chỉ máy local); trên Vercel chỉ log sự kiện, không log địa chỉ/nội dung (`:216-220`). ✔

## 5. Thực thi từ xa

Vercel Sandbox (`server/sandbox.js`) và cloud browser (`server/cloudBrowser/`): mã/URL do model
sinh, tệp người dùng đẩy vào sandbox. Chi tiết cô lập → kết quả agent audit egress.

## 6. Lưu trữ phía mình

| Đích | Trường | Mã hoá lúc lưu | Thời gian lưu | Đánh giá |
|---|---|---|---|---|
| Postgres (Neon prod / PGlite local) | chats, messages, attachments (bytea), memory notes, `audit_events`, usage, API key người dùng | API key + token connector: mã hoá ứng dụng (`server/crypto.js`); nội dung chat: chỉ mã hoá ở tầng đĩa của Neon [INFER] | `prefs.retentionDays` 0/30/90/180/365, chat ghim giữ lại (`server/memory.js`/`routes/account.js`) | Region Neon = [UNKNOWN] (cấu hình ngoài repo) |
| Log Vercel | message + trace id + field đã qua `redactSecrets` (`server/util/trace.js` `cleanFields`) | — | theo Vercel | grep không thấy call site log nội dung chat ✔ |
| Trình duyệt `localStorage` | `REMEMBERED_EMAIL` (`public/js/app.js:418,426`), theme, detail, rail, kích thước, ngôn ngữ | — | đến khi xoá | email nhớ đăng nhập là PII nhẹ, do người dùng chọn |
| Trình duyệt `sessionStorage` | `CONTINUE_KEY` = token share đang chờ (`app.js:377`), `ai-remote-local-device` (`api.js:360`) | — | theo tab | chấp nhận được |

## 7. Analytics / đo hiệu năng

**Trước vòng v3: không có.** 0 SDK analytics/APM/error-tracker (BASELINE). Vòng v3 thêm Vercel Web
Analytics + Speed Insights theo yêu cầu chủ project → xem `GAP-012` / `PRV-` trong ledger: chỉ gửi
`origin + pathname` (query và hash bị cắt trong `beforeSend` vì URL mang `?reset=`, `?t=`,
`?continue=`, `?chat=`), tôn trọng Global Privacy Control / Do Not Track, không cookie (theo
vercel.com/docs/analytics/privacy-policy và /docs/speed-insights/privacy-policy).
