# Nhập môn có video, đúng từng chữ

Ngày: 2026-10-20

## Vấn đề

Hướng dẫn nhập môn 5 bước có ít nhất bốn chỗ sai so với app hiện tại:

1. **Ghi chú vàng ở bước 3** nói model miễn phí bị giới hạn và "đổi sang model trả phí là hết" —
   bỏ qua việc app giữ nhiều key mỗi nhà cung cấp và tự chuyển key, tự chuyển sang Auto.
2. **Bước 5 kể 3 mức tự do**, app có 5 (Có kiểm soát, Hỏi trước, Tự chạy, Lập kế hoạch, Chỉ đọc).
3. **Bước 1 nói "làm việc trên máy tính của bạn"** — giao diện đã bỏ ghép máy tính; máy cloud làm
   việc đó (`index.html`: "the cloud machine and the sandbox do the work a paired computer used to").
4. **Bước 4 nói "bấm là chạy luôn"** — bấm chỉ đưa câu vào ô nhập (`onTryPrompt → setComposerText`).

Câu gợi ý cũng chưa sát nhu cầu thường gặp, và không bước nào có hình minh hoạ.

## Quyết định đã chốt với chủ dự án

- **Chỉ làm lại nhập môn** — không làm trung tâm hướng dẫn (đã đổi ý giữa chừng, 2026-10-20).
- **Video quay tự động từ app thật**, bản vi và en, quay lại bằng một lệnh khi giao diện đổi.
- **Không có bước ghép máy tính** — app của chủ dự án không bao giờ ghép thiết bị; thay bằng máy cloud.
- **Mọi câu phải đúng, có nguồn**, và cái gì ghim được bằng test thì ghim.

## Sự thật dùng trong hướng dẫn, và nguồn

| Câu trong hướng dẫn | Nguồn |
|---|---|
| Model miễn phí OpenRouter: 20 yêu cầu/phút; 50/ngày, thành 1.000/ngày khi đã từng mua từ 10 credit | openrouter.ai/docs/api-reference/limits (đọc 2026-10-20) |
| Thêm key hay tài khoản OpenRouter không tăng giới hạn đó | cùng trang: "Making additional accounts or API keys will not affect your rate limits" |
| Một tin nhắn có thể tốn nhiều yêu cầu — mỗi bước là một lần gọi model | vòng lặp agent: một lượt gọi model mỗi bước (`server/agent.js`) |
| Giữ được nhiều key mỗi nhà cung cấp; thử lần lượt; key đang nghỉ thì bỏ qua; nếu sắp mở lại thì chờ | `streamAny` trong `server/providers/index.js` |
| Model không với tới được ở mọi key thì lượt đó chuyển sang Auto | `server/agent.js` (`upstream` → Auto cho lượt) |
| Năm nhà cung cấp: Anthropic, OpenAI, Google Gemini, OpenRouter, OrcaRouter | `server/providers/catalog.js` |
| Auto dùng các model miễn phí của OpenRouter | README "Auto"; `openrouter/openrouter/free` |
| Key được mã hoá ở máy chủ, không bao giờ gửi về trình duyệt | `server/crypto.js`; `test/http.test.mjs` "providers report status, not secrets" |
| Máy cloud: Linux riêng của tài khoản, Python/Node/git, giữ tệp và phần mềm giữa các cuộc trò chuyện, trình duyệt xem trực tiếp | định nghĩa `sandbox_run`, `cloud_browser` (`server/tools/definitions.js`) |
| 60 lượt máy cloud/ngày mỗi tài khoản, 400/ngày cả app (mặc định, chỉnh được) | `cloudBudgets` trong `server/sandbox.js` |
| Năm mức tự do và lời mô tả của từng mức | `policy.*` trong `public/js/locales/*.js` |
| Bấm gợi ý là đưa câu vào ô nhập, sửa được rồi gửi | `onTryPrompt: setComposerText` (`public/js/app.js`) |

## Sáu bước

1. **Synapsez làm được gì** — tìm và đọc web có dẫn nguồn; viết Word, Excel, PDF, slide để tải về;
   có máy cloud riêng chạy Python, lệnh, tệp và một trình duyệt bạn xem trực tiếp; dùng từ máy nào cũng được.
2. **Thêm API key** — Cài đặt → Nhà cung cấp; gợi ý OpenRouter (có model miễn phí); thêm được nhiều key
   mỗi nhà cung cấp và nhiều nhà cung cấp; key được mã hoá. Trạng thái: đã có / chưa có; nút mở phần key.
3. **Model và giới hạn miễn phí** — ghi chú vàng mới theo bảng trên; nút đổi model.
4. **Máy tính cloud của bạn** — máy là gì, giữ gì giữa các lần, trình duyệt xem trực tiếp ở khung bên,
   giới hạn 60 lượt/ngày.
5. **Mức tự do của trợ lý** — đủ 5 mức, một dòng mỗi mức, lấy từ chính lời mô tả của app.
6. **Thử việc đầu tiên** — 6 gợi ý, không cái nào cần đính kèm; bấm là đưa vào ô nhập:
   - Tìm 5 tin AI nổi bật tuần này, mỗi tin 2 câu tóm tắt, kèm nguồn
   - Viết 3 mẫu bài đăng Facebook giới thiệu sản phẩm mới cho shop online, giọng thân thiện
   - Lập kế hoạch nội dung 2 tuần cho fanpage quán cà phê, xuất ra file Excel
   - So sánh 3 phần mềm quản lý bán hàng phổ biến ở Việt Nam: giá, tính năng, ưu nhược — làm thành bảng
   - Soạn email chào hàng gửi khách doanh nghiệp, kèm bản tiếng Anh
   - Tạo dữ liệu bán hàng mẫu 12 tháng, phân tích bằng Python và vẽ biểu đồ doanh thu

## Giao diện

- Hộp rộng hơn (tối đa 760px): hàng tên 6 bước ở trên (bước hiện tại sáng, bước đã qua có dấu),
  video 16:10, tiêu đề, 2–4 câu, dòng trạng thái và nút "làm ngay" khi có, chân Bỏ qua / Quay lại / Tiếp tục.
  Điện thoại: xếp dọc, tên bước thu thành chấm.
- **Video**: không tiếng, lặp, chỉ bước hiện tại tự chạy; ảnh tĩnh hiện ngay khi chưa tải xong; chỉ tải
  video của bước đang xem; đóng hộp là dừng. **Nút Tạm dừng / Phát** luôn có (WCAG 2.2.2 — nội dung tự
  chạy quá 5 giây phải dừng được). `prefers-reduced-motion`: không tự chạy, bấm Phát mới chạy. Video không
  tải được: ảnh tĩnh ở lại, chữ vẫn đủ thông tin — video là minh hoạ, không mang thông tin riêng.
- `aria-label` cho video nói nó minh hoạ gì; phím ←/→ chuyển bước khi tiêu điểm không ở ô nhập.

## Quay video

`npm run onboarding:record` → `scripts/record-onboarding.mjs`:

- Dựng server cục bộ với PGlite tạm, một tài khoản mẫu, mở Chrome headless (Playwright `recordVideo`).
- Mỗi bước một cảnh, ở cả vi và en. Phần cài đặt (dán key, chọn model, mở menu mức tự do) là **thao tác
  thật trên giao diện**. Phần cuộc trò chuyện (lệnh, Python, biểu đồ, trình duyệt cloud, tệp) được vẽ bằng
  **chính các hàm hiển thị của app** (`assistantMessage` trong `render.js`) với dữ liệu mẫu — không gọi
  model thật, nên không tốn lượt và lần nào quay cũng như nhau.
- Một con trỏ giả di chuyển tới chỗ sắp bấm và nháy khi bấm, để người xem thấy đang bấm vào đâu.
- Cắt phần tải trang ở đầu và nén lại bằng ffmpeg đi kèm Playwright (VP8/WebM); ảnh tĩnh là ảnh chụp
  JPEG của khung hình đẹp nhất.
- Ra `public/onboarding/{vi,en}/step-{1..6}.webm` và `.jpg` — đường dẫn cố định, nên không cần tệp kê khai.
- Ngân sách: mỗi clip ≤ 600KB, tổng ≤ 8MB.

## Kiểm thử

| Kiểm | Ở đâu |
|---|---|
| Đủ 6 bước có tiêu đề ở cả hai ngôn ngữ | `test/i18n.test.mjs` |
| Bước 5 kể đúng các mức có trong menu, không thừa không thiếu | `test/ui.test.mjs` |
| Năm nhà cung cấp nêu ở bước 2 đúng với `catalog.js` | `test/features.test.mjs` |
| Hạn mức máy cloud nêu ở bước 4 đúng với `cloudBudgets()` mặc định | `test/features.test.mjs` |
| Mỗi bước có video và ảnh tĩnh ở cả vi và en, trong ngân sách dung lượng | `test/features.test.mjs` |
| Đi hết 6 bước; trạng thái key; gợi ý đưa vào ô nhập; nút Tạm dừng có và hoạt động | `test/ui.test.mjs` |

## Ngoài phạm vi

- Trung tâm hướng dẫn theo tính năng.
- Ghép máy tính.
- browser-use — một thử nghiệm riêng sau đó (3–5 việc thật, so với trình duyệt cloud hiện có).
