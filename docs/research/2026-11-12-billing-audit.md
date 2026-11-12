# Audit: thiết kế thanh toán SePay + bảng gói/hạn mức (2026-11-12)

Đối chiếu hai tài liệu chủ web gửi — `Synapsez.pdf` (thiết kế thanh toán SePay, 11/11/2026) và
`Bang-limit-va-chi-phi-co-dinh.md` (bảng gói, hạn mức, chi phí, 04/11/2026) — với nguồn chính thức
đọc ngày 12/11/2026, và với code hiện có. Chi tiết từng dữ kiện kèm URL:
[sepay-payments](2026-11-12-sepay-payments.md), [sepay-einvoice](2026-11-12-sepay-einvoice.md),
[pricing-tax-check](2026-11-12-pricing-tax-check.md). Con số tính lại bằng
`scripts/billing-calc.mjs` của phiên (không gọi mạng).

Ký hiệu: ✅ đúng · ❌ sai (kèm số đúng) · ⚠️ đúng một phần / có rủi ro · ❓ chưa xác nhận được.

---

## 1. Tóm tắt

1. **SePay đủ cho chuyển khoản QR** — webhook HMAC-SHA256 có thật, QR VietQR của SePay đủ dùng,
   không cần img.vietqr.io. Nhưng **SePay không lưu thẻ và chưa có trừ tiền định kỳ** → màn
   "Thêm phương thức thanh toán" kiểu thẻ (ảnh 12–13) không làm 1:1 được; "tự gia hạn" chỉ làm
   được bằng **số dư dịch vụ**.
2. **Đơn giá 120đ/lượt tìm kiếm lỗ** ngay khi hết hạn mức miễn phí: một lượt tìm "mức thường"
   của app (Exa auto, 8 kết quả kèm nội dung) tốn **≈385đ**, không phải 103–119đ. Tài liệu bỏ quên
   phí nội dung của Exa ($1/1.000 trang) và tính sai Firecrawl (2 credit/lượt, không phải 0,2).
3. **Thuế:** "0%" là sai nhãn (0% chỉ cho xuất khẩu; trong nước là "không chịu thuế"). Và cơ quan
   thuế Hà Nội (25/05/2026) đã trả lời **gói AI chat không phải dịch vụ phần mềm → chịu 10%** (8%
   đến 31/12/2026). Nếu bán dưới dạng **hộ kinh doanh ≤ 1 tỷ/năm** thì không VAT, không TNCN.
4. **Hoá đơn điện tử SePay** dùng được nhưng chủ web phải có **mã số thuế + chữ ký số + gói hoá
   đơn + cơ quan thuế duyệt đăng ký** trước; không có webhook; nghị định tài liệu dẫn đã bị thay
   bằng **NĐ 254/2026 (từ 01/07/2026)**.
5. **Bảng md có ~20 lỗi số học/mâu thuẫn** (mục 4), và **4 chỗ đụng luật app đang chạy** (mục 6):
   giới hạn 20 hội thoại, 30 lượt tìm miễn phí/ngày, "ghế" Pro/Max chưa có mô hình nhóm, admin
   không giới hạn.

---

## 2. Thanh toán qua SePay (Synapsez.pdf)

| # | Tài liệu nói | Kết quả | Đúng là / sửa thế nào |
|---|---|---|---|
| P1 | Plus 99.000đ, Pro 199.000đ (2 gói) | ⚠️ | Mâu thuẫn với md (Plus 5 / Pro 8 / Max 15 USD, 3 gói). Chủ web đã chốt 3 gói → **theo md**. |
| P2 | Webhook HMAC-SHA256, header `x-sepay-signature` + `x-sepay-timestamp` | ✅ | Header thật: `X-SePay-Signature: sha256={hex}`, `X-SePay-Timestamp: {giây unix}`; chuỗi ký `{timestamp}.{raw_body}`. Mẫu SePay từ chối request cũ hơn 300 s. Ngoài ra có API Key / OAuth2 / không xác thực. |
| P3 | Code mẫu so chữ ký bằng `timingSafeEqual(Buffer.from(signature), …)` | ❌ | Thiếu header → `Buffer.from(undefined)` ném lỗi (500); khác độ dài → `timingSafeEqual` ném `RangeError`. Phải: kiểm tra có header, bỏ tiền tố `sha256=`, so độ dài trước, kiểm tra cửa sổ thời gian. |
| P4 | Trả 200 rồi xử lý bất đồng bộ sau phản hồi | ❌ (trên Vercel) | Hàm serverless bị dừng sau khi trả lời → mất giao dịch. Xử lý xong (1 giao dịch DB, nhanh) **rồi** trả 200, hoặc `waitUntil`. |
| P5 | Trả `{"success": true}` trong 30 s; gửi lại tối đa 7 lần ~33 phút | ✅ | Khoảng 1,1,2,3,5,8,13 phút. **200 với body khác sẽ bị ghi là lỗi và không gửi lại.** Có nút gửi lại tay. Bật "Tự động gửi lại khi server trả lỗi". |
| P6 | Chống trùng bằng `status = pending` | ⚠️ | Chưa đủ: webhook gửi lại + job dự phòng chạy cùng lúc → kích hoạt 2 lần. Cần **UNIQUE trên id giao dịch SePay** + `UPDATE … WHERE status='pending' RETURNING` (nguyên tử). SePay nói rõ bên nhận phải tự chống trùng theo `id`. |
| P7 | Khớp đơn bằng `content.trim() === payment_code` | ❌ | Nội dung chuyển khoản thường có thêm chữ do ngân hàng chèn. Dùng trường **`code`** SePay đã tách theo tiền tố cấu hình (2–5 chữ cái + 1–30 ký tự số), không phân biệt hoa thường; dự phòng bằng regex trên `content`. |
| P8 | Mã đơn kiểu `WEB2M-20261111-001` | ❌ | Có dấu gạch (ngân hàng hay bỏ), lộ ngày, số thứ tự đoán được. Dùng **tiền tố chữ + chuỗi số ngẫu nhiên dài cố định, không gạch** (vd `SZ` + 10 số). |
| P9 | Chuyển thiếu → `status = failed` | ⚠️ | Tiền khách đã vào tài khoản mà đơn chết. Đề xuất: tiền nhận được **cộng vào số dư dịch vụ**, đơn giữ "còn thiếu X", khách trả phần còn lại từ số dư. Chuyển dư → phần dư vào số dư (thay vì "không hoàn"). Chuyển trễ sau khi đơn hết hạn → vẫn ghi nhận (vào số dư hoặc kích hoạt). |
| P10 | QR VietQR qua img.vietqr.io; link `dl.vietqr.io/pay?app=mb&account=…` | ⚠️ | img.vietqr.io có thật nhưng giới hạn 10 ảnh/10 s/IP; URL trong tài liệu có khoảng trắng và thiếu `amount`/`addInfo`. **SePay có máy tạo QR riêng** (`qr.sepay.vn/img?acc=&bank=&amount=&des=`), đã giải mã: chuẩn VietQR/NAPAS động, đúng số tiền + nội dung → **chỉ cần SePay** (đúng như chủ web nghĩ). Deep link đúng là `dl.vietqr.io/pay?app=&ba=acc@bank&am=&tn=` (tùy chọn). |
| P11 | Job dự phòng `GET /v2/transactions`, từ "1 giờ trước" | ⚠️ | Endpoint có thật: `userapi.sepay.vn/v2/transactions`, Bearer token, 3 req/s. Nên dùng `since_id` thay vì "1 giờ trước" (sự cố dài hơn 1 giờ sẽ mất). **id v2 là UUID, khác id số của webhook** → đối chiếu bằng `reference_number`. "Khớp `reference_number` với payment_code" là sai trường. |
| P12 | Cron 10–15 phút | ⚠️ | Vercel **Hobby chỉ chạy cron 1 lần/ngày**; cần Vercel Pro, hoặc hỏi trạng thái khi khách đang mở trang thanh toán (không cần cron) + cron ngày đối soát. |
| P13 | Đơn có trạng thái `expired` | ⚠️ | Tài liệu không nói hết hạn sau bao lâu, và tỷ giá khoá bao lâu. Đề xuất: giá VND khoá 30 phút; QR hết hạn sau 30 phút nhưng tiền đến muộn vẫn được ghi nhận. |
| P14 | Bảng `subscriptions` | ⚠️ | Thiếu: kỳ (tháng/năm), tự gia hạn, huỷ cuối kỳ, gói chờ đổi, tín dụng khi nâng cấp giữa kỳ (ảnh 7 có "Prorated credit"). |
| P15 | SePay FREE 0đ/50 GD, STARTUP 120.000đ/180 GD | ✅ | Vượt gói FREE: 700đ/GD. Chỉ tính tiền vào. Giữ dữ liệu 6 tháng (chỉnh được 1 giờ–3 năm). |
| P16 | "Cửa dự phòng khi MB bảo trì: tự chuyển SMS Banking" | ❌ | Chuyển **thủ công**, và chỉ khi gói có SMS Banking; bảng giá hiện không có gói SMS. |
| P17 | MBBank liên kết qua Open API, OTP, không mật khẩu | ✅ | Tài khoản cá nhân, hộ kinh doanh, doanh nghiệp đều được; MB nằm trong gói FREE. |
| P18 | Không cần giấy phép trung gian (NĐ 52/2024) | ✅ (suy ra) | Nhận tiền vào tài khoản của chính mình cho dịch vụ của mình. **Số dư dịch vụ** không rút, không chuyển, chỉ tiêu trong app → đọc như tiền trả trước dịch vụ, không phải ví điện tử — nhưng **chưa có điều khoản nói thẳng**; nên xin ý kiến luật sư. Rủi ro: Điều 8.6 cấm phát hành phương tiện thanh toán trái phép nếu số dư hoạt động như tiền. |
| P19 | Thẻ / "Add payment method" (ảnh 9–13) | ❌ | Cổng thanh toán SePay nhận Visa/Mastercard/JCB (1,6–2,2% + 2.200đ/GD, cần giấy đăng ký kinh doanh), **trên trang của SePay, từng lần**; **không lưu thẻ, không trừ định kỳ** (SePay ghi "sắp có"). Và app **không bao giờ được tự nhận số thẻ/CVC** (PCI DSS) — ô "Secure address input frame" trong ảnh 13 là iframe của Stripe, không phải form của Claude. |

## 3. Hoá đơn điện tử SePay (developer.sepay.vn/vi/einvoice-api/v1/…)

- Hoá đơn phát hành qua tài khoản nhà cung cấp của chính chủ web (Mắt Bão; mã "bkav" cũng có).
  Trước khi gọi API phải có: **mã số thuế (doanh nghiệp hoặc hộ kinh doanh), chữ ký số
  (SePay bán HSM 1.272.000đ/năm), gói hoá đơn, đăng ký đã được cơ quan thuế duyệt** — chưa có thì
  API trả `422 REGISTRATION_NOT_TAX_APPROVED`. Cá nhân chưa đăng ký kinh doanh: không thấy đường nào.
- Production `einvoice-api.sepay.vn`, sandbox `einvoice-api-sandbox.sepay.vn`; `POST /v1/token`
  bằng Basic auth → JWT 24 h, không refresh.
- **Không có webhook** → phải hỏi trạng thái; một yêu cầu có thể "Pending" tới 2 giờ.
- `reference_code` của mình là khoá chống trùng (gửi lại → 409). **Không bao giờ gửi lại khi kết
  quả "chưa xác nhận được"** (sinh hoá đơn ký trùng). Lỗi tài khoản/quota cũng trả HTTP 500 → rẽ
  nhánh theo `error.code`.
- `issued_date` phải là **hôm nay theo giờ Việt Nam** (Vercel chạy UTC → 00:00–07:00 sẽ lệch ngày).
- Thuế suất: −2 = KCT, −1 = KKKNT, 0, 5, 8, 10; hoá đơn bán hàng (mẫu 2, hộ kinh doanh) bỏ qua thuế.
- PDF: `pdf_url` (có vẻ là link công khai có khoá) hoặc `GET /v1/invoices/{tracking_code}/download`
  (Bearer, base64). → "Tải PDF" phải đi qua route của app, kiểm tra quyền sở hữu.
- Hoá đơn đã phát hành **không huỷ được** (NĐ 254/2026 bỏ huỷ hoá đơn), chỉ điều chỉnh/thay thế.
- Giá: 600đ/hoá đơn (gói 300) → 100đ/hoá đơn (gói 200.000), +8% VAT.
- Tài liệu SePay vẫn dẫn NĐ 123/2020 + TT 78/2021 — **đã bị thay bằng NĐ 254/2026 + TT 91/2026 từ
  01/07/2026**. Hộ kinh doanh ≤ 1 tỷ/năm **được** dùng hoá đơn điện tử nhưng không bắt buộc; > 1 tỷ
  bắt buộc.

## 4. Bảng gói, hạn mức, chi phí (Bang-limit-va-chi-phi-co-dinh.md)

### 4.1 Lỗi số học và mâu thuẫn nội bộ

| # | Chỗ | Tài liệu | Đúng là |
|---|---|---|---|
| M1 | Nguồn tỷ giá | link tới exa.ai/pricing | Link sai. open.er-api.com: miễn phí, không key, **cập nhật 1 lần/ngày**, chặn 20 phút nếu gọi dồn, **bắt buộc ghi nguồn**. Hôm nay: **25.655,85**; Vietcombank bán chuyển khoản 25.870. |
| M2 | "Fetch tỷ giá mỗi lần render" | — | Không làm được với nguồn cập nhật 1 lần/ngày, có rate limit; phải cache (≥1 giờ) và **khoá giá trên từng đơn**. |
| M3 | Đơn giá lượt tìm | 120đ = 0,0047 USD | 0,0047 × 25.744 = **121,0đ → làm tròn lên 10đ = 130đ**; bảng 0.1 lại dùng 110,70đ (= 0,0043 USD). Ba con số 0,0043 / 0,0046 / 0,0047 cho cùng một thứ. |
| M4 | "Markup ~5%" của 120đ | 118,8đ → 120đ | 120/118,8 = **+1,0%**, không phải 5%. Đúng quy tắc +5% rồi làm tròn lên: 130đ. |
| M5 | Giá vốn trung bình lượt tìm | ~$0,0046 | Trung bình 5 dòng = $0,00361; 4 dòng = $0,0043. Mà **trung bình cộng không có nghĩa** — chi phí phụ thuộc engine nào trả lời (mục 4.2). |
| M6 | Firecrawl search | ~0,2 credit/lượt | **2 credit/10 kết quả**, làm tròn lên → một lượt thường = 2 credit. |
| M7 | Dòng tặng kèm Plus/Pro/Max | search 33.000 / 55.000 / 99.000 | Tính theo 110đ, còn dòng tổng theo 120đ: 300×120 = **36.000**, 500×120 = **60.000**, 900×120 = **108.000**. Tổng 73.740 / 116.900 / 221.800 thì đúng. |
| M8 | "Giá trị tặng kèm 70.740đ" (benchmark) | 70.740 | Bảng Plus ghi 73.740. |
| M9 | Giá vốn tặng kèm | Plus 66.645, Pro 105.390, Max 200.482 | Khớp với giá vốn **Exa lite 102,98đ**, không phải "trung bình 118,8đ" tài liệu tự nêu (theo 118,8: 71.388 / 113.296 / 214.712). |
| M10 | Hoà vốn toàn bộ, Pro tháng | 21 khách | 2.161.045 / 100.562 = 21,5 → **22**. |
| M11 | Hoà vốn hạ tầng, Max tháng | 7 khách | 1.302.912 / 185.678 = 7,02 → **8** (7 khách = 1.299.746 < 1.302.912). Câu "chỉ cần 7 khách Max" sai theo. |
| M12 | Hoà vốn toàn bộ, Pro năm | 24 khách | 2.161.045 / 89.835 = 24,06 → **25**. |
| M13 | Đoạn "gói năm 60 USD" | 60 = 12×5, hoà vốn không đổi | Còn sót từ bản cũ — gói năm đã chốt 57 USD (−5%), hoà vốn **có** đổi (đoạn sau tự nói vậy). |
| M14 | Ví dụ tiêu thụ ví "Vừa" | bán 52.240, vốn 49.720 | 200×120 + 5×4.500 + 3×580 = **48.240**; vốn (118,8) **46.719**. |
| M15 | Ví dụ "Dùng nhiều" | bán 183.800, vốn 174.940 | **191.800**; vốn **185.780** (118,8) hoặc 173.124 (lite). |
| M16 | Domain | "67,32 USD/năm · 1.733.184 VND/tháng · 17.331.840 VND/năm" | Cột ghi nhầm: 1.733.184 là **mỗi năm**, 17.331.840 là **10 năm**. Và giá **cao gấp ~3,5 lần thị trường**: .com gia hạn ≈ 430–460k/năm chưa VAT (P.A Việt Nam 459.000đ) → ≈ 42.000đ/tháng, không phải 144.432đ. |
| M17 | Fair-use "Storage/tài khoản 3 GB" cho cả 3 gói | 3 GB | Mâu thuẫn Pro 5 GB, Max 10 GB. |
| M18 | Fair-use "Hội thoại 900", "File xuất 60" cho cả 3 gói | — | Plus là 300 hội thoại và 20 file. |
| M19 | Benchmark "Tặng kèm **Pro** của bạn" | 300 search, 8 giờ, 30 tin/ngày | Đó là số của **Plus**. |
| M20 | Mục 3 bước 3 | "Nạp tối thiểu 50.000đ" | Đúng cho Free; Plus/Pro/Max là 100.000đ. |
| M21 | Bảng mục 0 | cột "USD" chứa giá VND ở các dòng ví | Đảo cột. |
| M22 | E2B Hobby | 20 sandbox đồng thời | **10**, mỗi phiên tối đa 1 giờ. $100 là **một lần** (≈ 604 giờ tổng), không phải mỗi tháng. |
| M23 | Vercel Pro "vô hạn lưu lượng" | không meter | Flat Rate CDN gồm 1 TB + 1 triệu request; vượt cả kỳ → bị đẩy lên bậc trên ($20/tháng). Function vẫn tính riêng ($0,60/triệu lần gọi, $0,128/giờ CPU). |
| M24 | Hạn mức reset "ngày 1" | — | Khách mua ngày 28 nhận 2 lần hạn mức trong 4 ngày. Đề xuất reset theo **ngày bắt đầu kỳ** của từng khách (như Claude), giờ Việt Nam. |

### 4.2 Giá vốn thật của một lượt tìm (theo cấu hình app, `server/search.js`)

Exa tính phí theo loại tìm **cộng $1/1.000 kết quả cho mỗi loại nội dung** (tài liệu bỏ quên phần
này). Firecrawl Hobby: $19/tháng = 5.000 credit → $0,0038/credit; vượt gói: 1.000 credit/$5.

| Mức suy luận | Exa | Tavily | Brave | Firecrawl | Tệ nhất (VND, tỷ giá 25.655) |
|---|---|---|---|---|---|
| Thấp | lite 5 kết quả $0,009 | basic $0,008 | $0,005 | 2 credit | 231đ |
| Trung bình | auto 8 kq **$0,015** | basic $0,008 | $0,005 | 2 credit | **385đ** |
| Cao | auto 8 kq $0,015 | advanced $0,016 | $0,005 | 2 credit | 410đ |
| Rất cao (2 engine) | deep 10 kq $0,022 | advanced $0,016 | $0,005 | 2 credit | 975đ |
| Tối đa (2 engine) | deep-reasoning 12 kq $0,029 | advanced $0,016 | $0,005 | 4 credit | 1.155đ |

→ **120đ/lượt lỗ 2–9 lần** khi lượt đó do Exa trả lời và hết hạn mức miễn phí. Engine rẻ nhất khi
phải trả tiền là **Brave $0,005 ≈ 128đ** (+5% → 140đ).

### 4.3 Hạn mức miễn phí khi mỗi dịch vụ có 5 key (chỉ đúng nếu mỗi key là một tài khoản riêng)

| Dịch vụ | Mỗi key/tháng | 5 key | Tương đương |
|---|---|---|---|
| Exa | $10 (reset ngày 1) | $50 | ≈ 3.200 lượt mức trung bình, ≈ 5.400 lượt mức thấp |
| Tavily | 1.000 credit | 5.000 | ≈ 4.750 lượt basic |
| Brave | $5 credit (thẻ trên file, không trần) | $25 | ≈ 4.750 lượt |
| Firecrawl | Hobby 5.000 + 4 key Free × 1.000 | 9.000 credit | ≈ 4.275 lượt tìm (hoặc 4.750 nếu chỉ key Hobby: 2.375 lượt) |

Tổng ≈ 15.000–17.000 lượt/tháng với chi phí biên ≈ 0 (trừ phí cố định Firecrawl Hobby $19). Hạn
mức tặng kèm Plus 300 lượt → đủ cho khoảng 50 khách Plus dùng cạn trước khi phải trả tiền thật.

⚠️ **Rủi ro điều khoản:** nếu 4 key là của 4 tài khoản lập thêm để nhân hạn mức miễn phí, nhiều
nhà cung cấp cấm việc này; khi phát hiện có thể khoá cả 5. Điều khoản Exa (PDF) không đọc được để
trích dẫn; Firecrawl nói rõ **mọi key trong cùng một team dùng chung credit và rate limit** — key
cùng tài khoản chỉ giúp khi một key bị thu hồi, không thêm hạn mức.

### 4.4 Biên lãi khi khách dùng cạn tặng kèm (tỷ giá 25.655, giá vốn thật)

| Gói | Giá | Lượt tìm do hạn mức miễn phí trả | …do Brave trả | …do Exa mức TB trả |
|---|---|---|---|---|
| Plus (8 h, 300 lượt, 3 GB) | 128.279đ | 92.650đ (72%) | 54.160đ (42%) | **−22.790đ (lỗ)** |
| Pro (12 h, 500 lượt, 5 GB) | 205.247đ | 151.531đ (74%) | 87.381đ (43%) | **−40.869đ (lỗ)** |
| Max (24 h, 900 lượt, 10 GB) | 384.838đ | 277.407đ (72%) | 161.937đ (42%) | **−68.913đ (lỗ)** |

→ Lượt tặng kèm và lượt trả bằng số dư, khi đã hết hạn mức miễn phí, phải đi engine rẻ (Brave),
không đi Exa mức trung bình trở lên.

### 4.5 Chi phí cố định, sửa lại

| Khoản | Tài liệu | Sửa |
|---|---|---|
| Domain | 144.432đ/tháng | ≈ 42.000đ/tháng |
| Supabase Pro + Vercel Pro | 45 USD | 45 USD ✅ |
| **Firecrawl Hobby (mới)** | — | **19 USD/tháng** (hoặc 16 nếu trả năm) |
| SePay | — | 0đ (≤ 50 GD/tháng) → 120.000đ (STARTUP) |
| Chữ ký số (nếu xuất hoá đơn) | — | ≈ 106.000đ/tháng (1.272.000đ/năm) |
| Claude 2 × Pro năm | 858.133đ | 855.195đ ✅ |
| **Hạ tầng** | 1.302.912đ | **≈ 1.684.000đ** (64 USD + domain) |
| **Toàn bộ** | 2.161.045đ | **≈ 2.539.000đ** (chưa gồm SePay STARTUP, chữ ký số) |

## 5. Thuế

| # | Tài liệu | Kết quả | Đúng là |
|---|---|---|---|
| T1 | "0% — phần mềm không chịu thuế (Luật 48/2024 điểm 21 Điều 5, NĐ 181/2025)" | ❌ | Khoản 21 Điều 5 ✅, NĐ 181/2025 **Điều 4 khoản 13**. Nhưng "**không chịu thuế (KCT)**" ≠ "**0%**" (0% là xuất khẩu, được hoàn thuế đầu vào). |
| T2 | Web chat AI = dịch vụ phần mềm | ❌ rủi ro cao | Thuế cơ sở 6 Hà Nội (VietNamNet 25/05/2026): **gói ChatGPT và ứng dụng AI không phải dịch vụ phần mềm → 10%**. Quảng Trị (CV 5854, 22/10/2026): tuỳ định nghĩa, không theo tên gọi. Không có văn bản riêng thì không nên giả định KCT. |
| T3 | 8% đến 31/12/2026 (NQ 204/2025), 10% từ 2027 | ✅ | CNTT không nằm trong danh sách loại trừ. |
| T4 | Hộ kinh doanh ≤ 1 tỷ miễn VAT + TNCN (NĐ 141/2026) | ✅ | NĐ 141/2026 ngày 29/4/2026, hiệu lực hồi tố 01/01/2026. Hộ kinh doanh không cộng 8%/10% vào hoá đơn; trên 1 tỷ nộp theo % doanh thu (dịch vụ 5%). DN ≤ 1 tỷ miễn TNDN. |
| T5 | Khách nước ngoài 0% | ⚠️ | Chỉ khi dịch vụ được tiêu dùng ngoài VN (cá nhân phải ở ngoài VN lúc dùng), có hợp đồng, thanh toán không tiền mặt. Mua gói online: khó chứng minh. Hộ ≤ 1 tỷ thì không phát sinh. |
| T6 | TNDN 20%, 15%/17%, giảm 30% cho 2026–2027 nếu ≤ 10 tỷ | ✅ | Luật 67/2025; NĐ 398/2026 (29/10/2026). |
| T7 | Hoá đơn theo NĐ 70/2025 | ❌ lỗi thời | NĐ 254/2026 + TT 91/2026 thay thế từ 01/07/2026. |

Ghi chú: khách **nước ngoài** chỉ trả được nếu có tài khoản ngân hàng Việt Nam (chuyển khoản QR),
hoặc qua cổng thẻ SePay (cần đăng ký kinh doanh). Hiển thị USD cho họ mà không có cách trả USD
thì vô ích — giá thu thật luôn là VND.

## 6. Đụng với luật app đang chạy

| # | Bảng md | App hiện tại | Cần chủ web chốt |
|---|---|---|---|
| A1 | Free 20 hội thoại/tháng, lịch sử 7 ngày; trả phí 12 tháng | Mỗi người giữ 20 hội thoại gần nhất mỗi nơi (ngoài / mỗi dự án), 10 ghim, admin không giới hạn (chốt 11/11/2026) | Hai luật khác bản chất (đếm theo tháng vs giữ N cái gần nhất). |
| A2 | Free 0 lượt tìm tặng kèm (chỉ ví) | Mọi tài khoản 30 lượt có tính phí/ngày từ hạn mức chung; hết thì sang DuckDuckGo miễn phí | Free có còn 30 lượt/ngày không; engine miễn phí (DuckDuckGo, Stack Exchange, chỉ mục Firecrawl) có còn không tính lượt không. |
| A3 | Pro 3 ghế, Max 10 ghế (pool cả team), ghế thêm 150.000đ | App không có mô hình nhóm/workspace có thành viên | Cần một hạng mục riêng (mời, vai trò, hạn mức chung). Không nên in "3 ghế" lên thẻ gói khi chưa có. |
| A4 | Free 300 request model/tháng qua key của chính khách | Không giới hạn (BYOK) | Chặn request bằng key của chính khách là luật mới, đụng mọi đường gọi model. |
| A5 | Giá theo tháng, quota reset ngày 1 | `freeTier.js` đếm theo tháng UTC; các bảng xếp hạng theo giờ VN | Chọn mốc: ngày bắt đầu kỳ của khách, giờ VN. |
| A6 | Xoá dữ liệu 1:1 khi xoá | Chủ web muốn xoá là mất hẳn | **Luật kế toán buộc giữ chứng từ/hoá đơn 10 năm** → khi xoá tài khoản: xoá dữ liệu cá nhân, giữ hoá đơn/thanh toán đã tách khỏi tài khoản. |

## 7. Nguồn chính (đọc 12/11/2026)

- SePay webhook: developer.sepay.vn/vi/sepay-webhooks/…, docs.sepay.vn/tich-hop-webhooks.html; IP: developer.sepay.vn/vi/dia-chi-ip
- SePay QR: vietqr.app/img, qr.sepay.vn/img; cổng thanh toán: pay.sepay.vn/v1/checkout/init
- SePay userapi v2: userapi.sepay.vn/v2/transactions; bảng giá: sepay.vn/bang-gia
- SePay hoá đơn điện tử: developer.sepay.vn/vi/einvoice-api/v1/tong-quan (20 trang + OpenAPI 3.0.3)
- Exa exa.ai/pricing · Brave brave.com/search/api · Tavily tavily.com/pricing · Firecrawl firecrawl.dev/pricing, docs.firecrawl.dev/rate-limits, docs.firecrawl.dev/billing · E2B e2b.dev/pricing · Supabase supabase.com/pricing · Vercel vercel.com/pricing, vercel.com/docs/pricing/flat-rate-cdn
- Tỷ giá: exchangerate-api.com/docs/free; Vietcombank portal.vietcombank.com.vn/…/pXML.aspx?b=10
- Thuế: VBHN 12/VBHN-VPQH (Luật 48/2024 hợp nhất); NĐ 181/2025 Đ4 k13; vietnamnet.vn/…-2517826.html; CV 5854/QTR-CNTK; baochinhphu.vn (NĐ 141/2026); EY về NĐ 254/2026; CV 5131/CT-CS
- NBER w34255 (18 tỷ tin/tuần, 700 triệu người, lập trình 4,2%) ✅
