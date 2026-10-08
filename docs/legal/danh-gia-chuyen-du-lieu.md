# Hồ sơ đánh giá tác động chuyển dữ liệu cá nhân ra nước ngoài — bản mẫu

> Bản mẫu do mã nguồn cung cấp (LAW-001), để bên vận hành một bản triển khai Synapsez lập hồ sơ theo Luật
> Bảo vệ dữ liệu cá nhân số 91/2025/QH15 (hiệu lực 01/01/2026) và văn bản hướng dẫn. Phần mô tả kỹ thuật dưới
> đây đúng với phần mềm tại phiên bản `privacy-2026-10-08`; phần pháp lý — biểu mẫu, thời hạn nộp, cơ quan tiếp
> nhận, căn cứ điều khoản — **phải được luật sư đối chiếu với văn bản hiện hành**. Đây không phải tư vấn pháp lý.

## 1. Bên chuyển dữ liệu

- Tên, địa chỉ, người đại diện: *[bên vận hành điền]*
- Người phụ trách bảo vệ dữ liệu cá nhân, liên hệ: *[bên vận hành điền]*
- Bản triển khai: *[tên miền]*, chạy trên Vercel; cơ sở dữ liệu Neon, vùng *[điền vùng đã chọn]*.

## 2. Mô tả hoạt động xử lý

| Hạng mục | Nội dung (theo phần mềm) |
|---|---|
| Chủ thể dữ liệu | Người dùng có tài khoản trên bản triển khai |
| Loại dữ liệu | Tài khoản (tên, email, mật khẩu dạng băm); nội dung hội thoại, tệp, ghi chú bộ nhớ; khoá API (mã hoá); nhật ký bảo mật (mạng, trình duyệt — không lưu IP đầy đủ); vị trí gần đúng cỡ thành phố khi người dùng hỏi "gần tôi" (toạ độ làm tròn ~1 km, không lưu; tên thành phố và các địa điểm tìm được kèm khoảng cách nằm trong hội thoại) |
| Dữ liệu nhạy cảm | Không thu thập có chủ đích; người dùng có thể tự nhập. Bộ nhớ mặc định từ chối lưu chủ đề nhạy cảm trừ khi người dùng bật |
| Mục đích | Cung cấp trợ lý AI theo yêu cầu; an ninh tài khoản; vận hành dịch vụ |
| Căn cứ | Đồng ý của chủ thể khi đăng ký (ghi vào nhật ký bảo mật, sự kiện `consent_given`, kèm phiên bản thông báo) |
| Thời gian lưu | Đến khi người dùng xoá, hoặc thời hạn người dùng chọn (30/90/180/365 ngày); hội thoại ẩn danh xoá sau 1 ngày |

## 3. Bên nhận ở nước ngoài

| Bên nhận | Dữ liệu nhận | Khi nào | Quốc gia | Cam kết của bên nhận (bên vận hành kiểm tra điều khoản gốc) |
|---|---|---|---|---|
| Anthropic | Tin nhắn, tệp liên quan | Khi người dùng chọn mô hình Claude | Hoa Kỳ | *[điền]* |
| OpenAI | như trên | Mô hình GPT | Hoa Kỳ | *[điền]* |
| Google (Gemini) | như trên | Mô hình Gemini; key gói miễn phí: Google có thể dùng để cải thiện sản phẩm | Hoa Kỳ / toàn cầu | *[điền]* |
| OpenRouter và nhà cung cấp được định tuyến | như trên | Mô hình qua OpenRouter, Auto, mô hình miễn phí | Hoa Kỳ và nhiều nước | Chế độ Nghiêm ngặt chỉ định tuyến tới nhà cung cấp không lưu/không huấn luyện |
| OrcaRouter | như trên | Mô hình qua OrcaRouter | *[điền]* | *[điền]* |
| Vercel | Toàn bộ dữ liệu ứng dụng khi xử lý; máy tính đám mây | Luôn | Hoa Kỳ / vùng chọn | *[điền]* |
| Neon | Cơ sở dữ liệu | Luôn | Vùng chọn | *[điền]* |
| Exa, DuckDuckGo, Tavily, Brave, Google | Câu truy vấn tìm kiếm | Khi trợ lý tìm kiếm web | Hoa Kỳ | *[điền]* |
| OpenStreetMap: Nominatim (OSMF), Overpass (overpass-api.de, overpass.kumi.systems), OSRM (router.project-osrm.org, routing.openstreetmap.de — FOSSGIS) | Tên địa điểm; toạ độ nơi được tìm quanh, kể cả vị trí gần đúng (~1 km) khi hỏi "gần tôi" | Khi trợ lý tra địa điểm, tìm quanh một nơi, chỉ đường | Chủ yếu châu Âu (Đức và các nước khác) — bên vận hành kiểm tra | *[điền]* |
| Dịch vụ email (Gmail/Resend/SMTP) | Email người dùng nhờ gửi | Khi gửi email | *[điền]* | *[điền]* |

## 4. Biện pháp bảo vệ đã có trong phần mềm

- Mã hoá khi truyền (TLS); khoá API mã hoá khi lưu (khoá mã hoá tách khỏi khoá phiên).
- Chế độ Nghiêm ngặt cho OpenRouter (không lưu, không huấn luyện, zero data retention).
- Che thông tin cá nhân (tuỳ chọn, PRV-003): email, SĐT, CMND/CCCD, số tài khoản, số thẻ, tên có nhãn được thay bằng mã giữ chỗ trước khi gửi; bảng ánh xạ chỉ trong bộ nhớ một lần gọi. Giới hạn: không che tên không có nhãn, địa chỉ, thông tin nhận diện qua ngữ cảnh.
- Hội thoại ẩn danh; tắt bộ nhớ; tắt tìm hội thoại cũ; thời hạn lưu.
- Xuất dữ liệu, xoá dữ liệu, xoá tài khoản ngay trong ứng dụng.
- Nhật ký bảo mật cho từng tài khoản; log máy chủ không chứa nội dung hội thoại.

## 5. Đánh giá rủi ro

| Rủi ro | Khả năng | Mức độ | Giảm thiểu | Rủi ro còn lại |
|---|---|---|---|---|
| Nhà cung cấp mô hình lưu hoặc dùng nội dung để huấn luyện | *[đánh giá]* | *[đánh giá]* | Nghiêm ngặt; chọn key trả phí; che thông tin cá nhân | *[đánh giá]* |
| Lộ dữ liệu khi truyền | | | TLS | |
| Truy cập trái phép tài khoản | | | Mật khẩu băm, xác thực hai lớp, giới hạn đăng nhập, nhật ký bảo mật | |
| Nhà cung cấp chịu yêu cầu của cơ quan nước ngoài | | | Hạn chế dữ liệu gửi đi (che thông tin, ẩn danh) | |

## 6. Thông tin cho chủ thể và đồng ý

- Thông báo xử lý dữ liệu: `/privacy.html` (song ngữ), liên kết ở màn hình đăng ký và trong Cài đặt → Bộ nhớ & quyền riêng tư.
- Đồng ý: ô đánh dấu bắt buộc khi đăng ký; ghi nhận phiên bản thông báo vào nhật ký bảo mật.
- Rút lại đồng ý: xoá tài khoản; hoặc tắt các tính năng liên quan.

## 7. Việc bên vận hành cần làm

1. Điền mục 1, 3 (cột trống) và 5; cập nhật `public/privacy.html` mục 1 với tên và liên hệ của mình.
2. Nhờ luật sư xác nhận hồ sơ và thông báo theo văn bản hiện hành; nộp hồ sơ theo yêu cầu (nếu có).
3. Khi thông báo thay đổi nội dung: tăng phiên bản (`privacy-YYYY-MM-DD`) ở `public/privacy.html` và `PRIVACY_NOTICE` trong `public/js/app.js` (test giữ hai chỗ khớp nhau).
