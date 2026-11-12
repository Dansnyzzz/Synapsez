# SePay eInvoice API — research notes (read 2026-11-12)

## How this was read, and how to read these notes

- The URL in the brief, `https://developer.sepay.vn/vi/einvoice-api/v1`, returns **HTTP 404**. The section actually starts at
  `https://developer.sepay.vn/vi/einvoice-api/v1/tong-quan`. (`/vi/einvoice-api/tong-quan` also exists as an older alias.)
- I downloaded all **20 pages in the left-hand nav, in both `/vi/` and `/en/`** (40 pages, all HTTP 200), plus the demo page, the changelog,
  the SePay eInvoice product/pricing pages and the SePay eShop invoice guides on docs.sepay.vn. Then I extracted the text of each page.
- Each doc page embeds the **full OpenAPI 3.0.3 spec** ("SePay eInvoice API" v1.0.0) in its Next.js payload. I pulled it out, merged it
  (19 paths, 40 schemas) and read every operation. A fact marked **[spec]** comes from that embedded spec. It appears on every endpoint page.
  Its field tables are the source of the page's own "API Request" tables.
- **READ** = stated on the cited page. **INFERRED** = my reading or deduction, not stated anywhere. Each fact carries its URL.
- Base for the URLs below: `D = https://developer.sepay.vn/vi/einvoice-api/v1/` (English: same slug under `/en/einvoice-api/v1/`).

Nav pages, in order (all read): tong-quan, bat-dau-nhanh, sandbox, tao-token, danh-sach-tai-khoan ("Danh sách nhà cung cấp"),
chi-tiet-tai-khoan, dia-diem-kinh-doanh-nguoi-ban, xuat-hoa-don-dien-tu, xuat-hoa-don-dieu-chinh, xuat-hoa-don-thay-the,
theo-doi-trang-thai-xuat-hoa-don, xoa-hoa-don-nhap, phat-hanh-hoa-don-dien-tu, theo-doi-trang-thai-phat-hanh-hoa-don,
danh-sach-hoa-don, chi-tiet-hoa-don, tai-hoa-don, kiem-tra-han-ngach, lich-su-gui-email, xu-ly-loi.
The nav has **no** separate pages for webhooks, rate limits, a provider catalogue or a changelog. The changelog is site-wide at
https://developer.sepay.vn/vi/changelog.

---

## 1. What the e-invoice API is, who issues the invoice, and what the seller must set up

**READ**
- "SePay eInvoice API giúp **hộ kinh doanh và doanh nghiệp** xuất hóa đơn điện tử tuân thủ **Nghị định 123/2020/NĐ-CP và Thông tư 78/2021/TT-BTC**…
  tạo hóa đơn, phát hành lên cơ quan thuế (CQT) và quản lý toàn bộ vòng đời hóa đơn". Source: D+`tong-quan`.
- Invoices go to the tax authority **through an e-invoice provider account configured for you**: "Gửi hóa đơn đến CQT qua **nhà cung cấp hóa đơn
  điện tử đã cấu hình**". Source: D+`tong-quan`. `GET /v1/provider-accounts` lists "các tài khoản nhà cung cấp hóa đơn điện tử đã được liên kết".
  Field `provider` = "Mã nhà cung cấp (**matbao, bkav**...)". Every example shows `"provider": "matbao"` [spec]. Source: D+`danh-sach-tai-khoan`.
- Changelog, 2025-12-10: "Ra mắt eInvoice API. Phát hành hóa đơn điện tử qua API, **tích hợp Matbao**." Source: https://developer.sepay.vn/vi/changelog
- Sample `pdf_url` values point at `https://beta-portalv2.mifi.vn/DownloadPDFCA.aspx?kk=…&keyinv=…` [spec, D+`chi-tiet-hoa-don`].
  MIFI is Mắt Bão's e-invoice product (third-party press: https://www.brandsvietnam.com/congdong/topic/331765-Hoa-don-dien-tu-an-toan-MIFI-boi-Mat-Bao-nhan-giai-Sao-Khue-2023).
- The demo footer reads "Giải pháp hóa đơn điện tử an toàn **SEPAY INVOICE - MST: 0317887567**". 0317887567 is SePay's own tax code, shown in the
  sepay.vn footer. Sources: https://developer.sepay.vn/vi/einvoice-demo and https://sepay.vn/sepay-einvoice.html
- Setup, from the product page FAQ: "Thủ tục đăng ký sử dụng SePay eInvoice cần gì? Bạn cần **thông tin doanh nghiệp hoặc hộ kinh doanh, mã số thuế
  và chứng thư số (chữ ký số)**. SePay sẽ hướng dẫn chi tiết từng bước và hỗ trợ setup A-Z trong 24h." Also: "Bạn có thể sử dụng chữ ký số đang kê khai
  thuế hoặc bất kỳ chữ ký số nào của doanh nghiệp (cùng thông tin Mã số thuế) còn hạn". The 3 steps are: choose an invoice package → buy a digital
  signature (SePay refers partners) → start issuing. Signing is "ký số online… không cần USB Token… chứng thư số **HSM**". Source: https://sepay.vn/sepay-einvoice.html
- Tax-authority approval is a hard gate. `tax_authority_approved_date` = "Ngày CQT duyệt tờ khai. Hóa đơn có ngày lập trước ngày này sẽ bị từ chối…
  Trả `null` khi chưa cập nhật hoặc ở sandbox". Errors: `422 REGISTRATION_NOT_TAX_APPROVED` ("Doanh nghiệp chưa đăng ký HĐĐT hoặc CQT chưa duyệt tờ khai")
  and `422 INVOICE_DATE_BEFORE_TAX_APPROVAL`. Sources: D+`danh-sach-tai-khoan`, D+`xuat-hoa-don-dien-tu`.
  Changelog 2026-04-20: "Phải sau ngày CQT chấp thuận tờ khai mới phát hành được hóa đơn."
- Account and billing gates, all returned as **HTTP 500**: `REGISTRATION_NOT_COMPLETE` ("Công ty chưa hoàn tất đăng ký gói"), `BILLING_IS_UNPAID`,
  `QUOTA_HAS_BEEN_USERD_UP`. "Những trường hợp này phải xử lý trên **my.sepay.vn**". Source: D+`xu-ly-loi`.
- Invoice template and series (mẫu số / ký hiệu) come from the provider account: `GET /v1/provider-accounts/{id}` → `templates[]` of
  `{template_code, invoice_series, invoice_label}`, for example `"1 - C26TSE - Hóa đơn giá trị gia tăng"` and `"2 - C26TSE - Hóa đơn bán hàng"`. Template kinds named:
  VAT invoice, sales invoice, "Phiếu xuất kho kiêm vận chuyển nội bộ", "Biên lai điện tử". Source: D+`chi-tiet-tai-khoan`.
- eShop guide: "Trước khi sử dụng tính năng xuất hoá đơn, bạn phải thanh toán mua gói hạn mức." Source: https://docs.sepay.vn/sepay-eshop/cau-hinh-hoa-don-dien-tu.html

**INFERRED (not stated by SePay)**
- Under Vietnamese law the **seller issues the invoice under its own tax code** (MST) and signs it with its own digital certificate. Here the certificate
  is a remote HSM certificate bought through SePay. The certified e-invoice service provider behind SePay is **Mắt Bão (MIFI)**, and BKAV is named as a possible
  provider code. SePay is the reseller/integrator you contract with: you buy quota and the HSM certificate from SePay.
  No page says who files the registration form (Mẫu 01/ĐKTĐ-HĐĐT) with the tax authority. "SePay hỗ trợ setup A-Z" suggests SePay helps, but this is **unconfirmed**.
- No page mentions a separate contract with Mắt Bão.
- Legal references may be out of date. The docs still cite Decree 123/2020 and Circular 78/2021. From **1 July 2026, Decree 254/2026/NĐ-CP replaces
  Decree 123/2020 (as amended by 70/2025), and Circular 91/2026/TT-BTC takes effect** (EY: https://www.ey.com/vi_vn/technical/tax/tax-and-law-updates/nghi-dinh-254-2026-nd-cp-ve-hoa-don-dien-tu-va-chung-tu-dien-tu).
  The product page cites Decree 70/2025.

## 2. Base URLs and authentication

**READ**
- Production `https://einvoice-api.sepay.vn`; Sandbox `https://einvoice-api-sandbox.sepay.vn`. Sources: D+`tong-quan`, D+`sandbox`, [spec `servers`].
- Sandbox is "cách ly hoàn toàn với Production… dữ liệu giả lập, không phát hành hóa đơn thật lên cơ quan thuế". To go live: "lấy token Production và đổi base URL…
  Phần còn lại của tích hợp giữ nguyên." Source: D+`sandbox`.
- "Token chỉ dùng được cho môi trường đã cấp nó, gửi token Sandbox tới Production sẽ nhận `401`." Source: D+`xu-ly-loi`.
- Getting a token: `POST /v1/token` with **HTTP Basic auth, username = `client_id`, password = `client_secret`** ("được cấp khi đăng ký"), and an **empty body**.
  Response: `{"success":true,"data":{"access_token":"eyJ…","token_type":"Bearer","expires_in":86400}}`. Source: D+`tao-token`, [spec `basicAuth`].
- Every other call sends `Authorization: Bearer <access_token>` (a JWT per [spec `bearerAuth` bearerFormat]).
- Token lifetime is **86400 s (24 h)**. There is **no refresh token**. "Nên lưu vào cache và tái sử dụng… Khi nhận lỗi `401`, tự động lấy token mới."
  An expired token returns `401 TOKEN_EXPIRED`. Sources: D+`bat-dau-nhanh`, D+`xu-ly-loi`.
- "Tất cả API calls phải thực hiện từ server-side… KHÔNG gọi API này từ browser hay mobile app." Source: D+`bat-dau-nhanh`.
- Token errors: `400` (bad format), `401 UNAUTHORIZED` ("Sai thông tin client_id hoặc client_secret"). Source: D+`tao-token`.
- It is **not OAuth2 client-credentials** in form (no `grant_type`, no form body). It is Basic → JWT.

**NOT FOUND**: where Sandbox `client_id`/`client_secret` are issued. Only "client_id và client_secret từ tài khoản SePay eInvoice" is stated (D+`bat-dau-nhanh`).
Separately, D+`xuat-hoa-don-dien-tu` mentions a "Test mode" that "bỏ qua kiểm tra ngày duyệt". How it relates to Sandbox is not explained.

## 3. Every endpoint

All responses use the envelope `{success, data}`. Errors use `{success:false, error:{code, message}}` (D+`xu-ly-loi`). Some list endpoints return just `{data:{paging, items}}` with no `success` [spec].

| # | Method & path | Purpose | Doc page |
|---|---|---|---|
| 1 | POST `/v1/token` | Basic → Bearer token | `tao-token` |
| 2 | GET `/v1/provider-accounts?page&per_page` | your provider accounts (`id`, `provider`, `active`, `tax_authority_approved_date`); per_page ≤100, default 20 | `danh-sach-tai-khoan` |
| 3 | GET `/v1/provider-accounts/{id}` | account + `templates[]` (template_code, invoice_series, invoice_label); 404 if unknown | `chi-tiet-tai-khoan` |
| 4 | POST `/v1/invoices/create` | create draft (`is_draft:true`) or create **and issue** (`is_draft:false`); async; **200** + `tracking_code`, `tracking_url`, `message` | `xuat-hoa-don-dien-tu` |
| 5 | GET `/v1/invoices/create/check/{tracking_code}` | status of create **and also of adjust/replace** ("Dùng chung cho cả ba luồng") | `theo-doi-trang-thai-xuat-hoa-don` |
| 6 | POST `/v1/invoices/issue` body `{reference_code}` | issue a previously created **draft**; async; 200 + tracking | `phat-hanh-hoa-don-dien-tu` |
| 7 | GET `/v1/invoices/issue/check/{tracking_code}` | status of issue | `theo-doi-trang-thai-phat-hanh-hoa-don` |
| 8 | POST `/v1/invoices/adjust` | adjustment invoice (increase/decrease/combined/info); async; **202** | `xuat-hoa-don-dieu-chinh` |
| 9 | POST `/v1/invoices/replace` | replacement invoice; async; **202** | `xuat-hoa-don-thay-the` |
| 10 | POST `/v1/invoices/delete/{reference_code}` | delete a **draft** only; irreversible (the changelog calls it "DELETE", but it is POST) | `xoa-hoa-don-nhap` |
| 11 | GET `/v1/invoices?page&per_page&source&document_type&seller_store_xid` | paginated list; per_page default 10, max 100; `source` = manual/api; `document_type` = comma list such as `6,7` | `danh-sach-hoa-don` |
| 12 | GET `/v1/invoices/{reference_code}` | detail, including items, `pdf_url`, `xml_url`, `tax_authority_code`, `provider_status`, `document_type` | `chi-tiet-hoa-don` |
| 13 | GET `/v1/invoices/{tracking_code}/download?type=pdf\|xml` | file as **base64** | `tai-hoa-don` |
| 14 | GET `/v1/usage` | `{"data":{"quota_remaining":"534"}}` (a **string**) | `kiem-tra-han-ngach` |
| 15 | GET `/v1/email-logs?page&per_page&invoice_number&status&to_email&reference_code` | email delivery log | `lich-su-gui-email` |
| 16–19 | GET `/v1/business-locations`; POST `/v1/business-locations/create` / `update` / `delete` | seller business-location catalogue (`xid`, `code` ≤50, `name` ≤400, `address` ≤255, `is_used`, `is_active`) | `dia-diem-kinh-doanh-nguoi-ban` |

### Create request — `CreateInvoiceRequest` [spec; D+`xuat-hoa-don-dien-tu`]
- `template_code` string **required**: from the account detail ("1" = VAT invoice, "2" = sales invoice).
- `invoice_series` string **required**: "không hardcode vì phần C{YY} phải khớp năm hiện tại, ví dụ 2026 là C26; sai năm sẽ bị từ chối" (`400 VALIDATION_ERROR`).
- `issued_date` string **required**, format `YYYY-MM-DD HH:mm:ss`. "Chỉ hỗ trợ ngày lập là ngày hiện tại". A future date gives `400 ISSUED_DATE_INVALID`. A past date was
  forbidden from 2026-06-23 (changelog). A bad format gives `INVALID_ISSUED_DATE`.
- `currency` enum **required**: `VND` | `USD` | `CAD` (default VND).
- `provider_account_id` string(UUID) **required**.
- `seller_store_xid` uuid, optional (400 `SELLER_STORE_NOT_FOUND` / `SELLER_STORE_INACTIVE`).
- `reference_code` string, optional: "**phải là duy nhất**. Nếu không truyền, hệ thống tự sinh UUID." A duplicate gives `409 EINVOICE_DOCUMENT_EXISTED`.
- `payment_method` enum, optional: `TM` (cash) | `CK` (bank transfer) | `TM/CK` | `KHAC`.
- `is_draft` boolean **required**. It must be a real JSON boolean; the string `"false"` gives `400 INVALID_IS_DRAFT_TYPE`. Drafts don't count against the quota.
- `buyer` object **required**. Inside it **no sub-field is required** [spec]:
  `type` enum `personal`|`company`; `name`; `legal_name` ("dùng khi buyer.type là company"); `tax_code`; `address`; `email` (format email, "Email nhận hóa đơn");
  `phone`; `buyer_code` (≤100, nullable); `national_id` (≤12, nullable, "CCCD / Số định danh cá nhân").
- `items` array, minItems 1, **required**. `InvoiceItem`:
  `line_number` int **req**; `line_type` int **req** (1 = goods/service, 2 = promotional item, 3 = trade discount, 4 = note line); `item_code`; `item_name` **req**; `unit`;
  `quantity` number ≥0 (decimals allowed, "tối đa 2 chữ số sau dấu phẩy"); `unit_price` number ≥0;
  `tax_rate` enum **−2 = Không chịu thuế (KCT), −1 = "Không kê khai, tính nộp thuế GTGT" (KKKNT), 0, 5, 8, 10**;
  `tax_amount` **integer** ≥0, optional (if sent, used verbatim and not checked against tax_rate; decimals give 400);
  `discount_tax` (% discount), `discount_amount`, `before_discount_and_tax_amount` (used for line_type 3).
- `notes` string ("Ghi chú nội bộ"). A note shown **on** the invoice must be sent as an item with `line_type: 4`.
- `total_amount` **integer**, optional. If omitted, it is computed from the lines and "làm tròn về số nguyên". If sent, it is used verbatim with no reconciliation, and decimals give 400.
- "`tax_rate` chỉ bắt buộc truyền khi dùng cho công ty (không cần truyền nếu sử dụng hoá đơn bán hàng)". With `template_code = 2`, tax_rate and tax_amount are ignored.
  A promotional line (type 2) is worth 0 unless you give it a price.

### Status-check response (create/issue) [spec; D+`theo-doi-trang-thai-xuat-hoa-don`, D+`theo-doi-trang-thai-phat-hanh-hoa-don`]
`data.reference_code`, `data.status` ∈ **`Pending` | `Success` | `Failed`**, `data.message`, and optionally `data.retry {retries_count, max_retries (7), next_retry_at ("Y-m-d H:i:s", giờ Việt Nam) | null}`.
`data.invoice` holds `{reference_code, invoice_number ("0" for drafts), issued_date (YYYY-MM-DD), pdf_url, xml_url (nullable), status ("draft"|"issued"), buyer, seller_store, total_before_tax, tax_amount, total_amount, notes, source ("manual"|"api")}`.
The page says "Trường `document_type` trong `data.invoice` cho biết kết quả là hóa đơn loại nào", but the status schema **does not list `document_type`**. That is an inconsistency in the docs.

### Invoice status values (all READ, [spec])
- SePay's internal `status`: **`draft` | `issued` | `cancelled`** (list/detail). Only draft and issued appear in status responses.
- `document_type` (detail and the list filter): 1 nháp, 2 mới, 3 đã xóa bỏ/đã hủy, 4 thay thế, 5 bị thay thế, 6 điều chỉnh tăng, 7 điều chỉnh giảm, 8 điều chỉnh thông tin, 9 điều chỉnh tăng/giảm, 10 bị điều chỉnh.
- `provider_status` (detail; "Khác với trạng thái nội bộ SePay"): 1 Nháp, 2 Lỗi ký, 3 Chưa gửi CQT, 4 Đã cấp mã/tiếp nhận, 5 CQT chưa phản hồi, 6 Không đủ ĐK cấp mã, 7 [04/SS] Chưa tạo tờ khai, 8 [04/SS] CQT chưa tiếp nhận, 9 [04/SS] CQT đã phê duyệt.
- `tax_authority_code` (mã CQT, nullable): "Có giá trị khi hóa đơn đã được đăng ký với cơ quan thuế".
- Detail `items[]` return numbers as **strings** ("2.00", "100000.00") "to ensure precision" (D+`chi-tiet-hoa-don`, en page).
- Email log `status`: pending, sending, sent, failed, retrying, permanent_failed.

### Adjust / replace [spec; D+`xuat-hoa-don-dieu-chinh`, D+`xuat-hoa-don-thay-the`]
- Both require `provider_account_id`, `original_invoice_reference_code`, `is_draft`, `items`. Optional: `issued_date` (must be today), `reference_code`, `payment_method`
  (inherits from the original), `notes` (**≤255 chars**), `total_amount`. Replace also takes `currency` (inherits) and **requires `buyer`**.
  Adjust requires `adjustment_type` (`increase` | `decrease` | `combined` | `info`), and `buyer` only when `info`.
- Rules: the original must be issued and accepted by the tax authority. Choosing adjust or replace **locks that path for all later corrections**. Each original can be **replaced once**,
  even if the replacement is still a draft. Adjustments can repeat. `info` adjustments must total 0. Adjustment lines hold only the **difference**, and you prefix item names yourself
  ("Điều chỉnh tăng mặt hàng …"). Replacements carry the full new content, keep the original's template and series, and their total cannot be negative.
- After issue: an adjustment has document_type 6/7/8/9 and the original becomes 10. A replacement has 4 and the original becomes 5.
- Errors: `422 INVALID_ORIGIN_INVOICE`, `400 INVALID_ADJUSTMENT_TYPE`, `500 EINVOICE_ACCOUNT_NOT_FOUND`, and the shared ones.

## 4. Getting the PDF / XML

**READ**
- `pdf_url` and `xml_url` (nullable) are returned by the status checks, the list and the detail. Example: `https://beta-portalv2.mifi.vn/DownloadPDFCA.aspx?kk=1434747710&keyinv=...`.
  "`xml_url` may be `null` if the invoice doesn't have an XML file or the provider doesn't support it". Sources: [spec], https://developer.sepay.vn/en/einvoice-api/v1/chi-tiet-hoa-don
- Download endpoint: `GET /v1/invoices/{tracking_code}/download?type=pdf|xml`. It needs a **Bearer token**. It returns `{file_type, file_name (e.g. "HD_0000589_20251215.pdf"), content: <base64>}`.
  "Cần decode base64 để lưu thành file… Đảm bảo hóa đơn đã được phát hành thành công trước khi tải file." Errors: `400 INVALID_FILE_TYPE`, `404 INVOICE_NOT_FOUND`. Source: D+`tai-hoa-don`.
- Changelog: PDF download endpoint added 2026-01-13. "Tải XML cho hóa đơn nháp" added 2026-01-22.

**NOT STATED**: the lifetime of `pdf_url`, or whether it needs authentication. **No** lookup code (mã tra cứu) is returned by the API, although SePay has a public lookup page
(https://sepay.vn/tra-cuu-hoa-don-dien-tu) that takes one.
**INFERRED**: `pdf_url` looks like an unauthenticated, key-in-query link on Mắt Bão's portal, so anyone holding it can open the PDF. Its permanence is unknown.
For the Billing page's "Download PDF", the safer design is a route on your server that checks the user owns the invoice, calls `/download?type=pdf` with the Bearer token,
decodes the base64 and streams `application/pdf`. Optionally cache the file in your own storage. Do not hand the raw `pdf_url` to the browser.
**Ambiguity**: the path parameter is named `tracking_code`, but the detail page says "Sử dụng `reference_code` để tải file", and the examples use the same UUID for both.
Test which identifier works in Sandbox.

## 5. Capability checklist

| Question | Answer | Basis |
|---|---|---|
| Issue automatically from a SePay **bank transaction**? | **Not in the API.** No field links a bank transaction, and there is no trigger. You call `create` yourself from your own SePay webhook handler. The **SePay eShop UI** can auto-create or auto-issue invoices on paid transactions, with a 0–2 h delay and draft or issue mode, using a "sản phẩm mặc định". The invoice "chỉ được tạo nếu số tiền chuyển khoản chia hết cho giá bán". | READ: [spec]; https://docs.sepay.vn/sepay-eshop/cau-hinh-hoa-don-dien-tu.html |
| Buyer with **no tax code** (individual consumer)? | **Yes.** No buyer sub-field is required; `type: personal`; `national_id` (CCCD) is optional; the decimal-quantity example has no `tax_code`. The eShop UI lets you skip buyer info for walk-in customers. | READ: [spec]; D+`xuat-hoa-don-dien-tu`; changelog 2026-04-14 "Thêm trường CCCD/CMND cho người mua là cá nhân"; docs.sepay.vn/sepay-eshop/xuat-hoa-don-dien-tu.html |
| 0% vs **KCT** vs 8%/10% | `tax_rate`: **−2 = KCT**, −1 = KKKNT, 0, 5, 8, 10. The tax rate applies only on a VAT invoice (`template_code 1`). Sales invoices (`template_code 2`) carry no tax. | READ: [spec] |
| USD vs VND | `currency` ∈ VND, USD, CAD. **No exchange-rate field exists.** `total_amount` and `tax_amount` must be integers, and auto-totals are "làm tròn về số nguyên". | READ: [spec]. INFERRED: USD with cents and the required exchange rate (tỷ giá) look **unsupported or unclear**. Ask SePay before invoicing in USD. |
| Adjust / replace / **cancel** | Adjust (`/adjust`) and replace (`/replace`): yes. **Cancel (hủy) an issued invoice: no endpoint.** Only drafts can be deleted. `cancelled` and document_type 3 exist as states, presumably set via the UI or support. | READ: [spec], D+`xoa-hoa-don-nhap`. Note: Decree 254/2026 **abolished the cancellation procedure** from 1/7/2026, so correction is by adjust or replace only (MISA: https://amis.misa.vn/80258/phuong-phap-huy-hoa-don-dien-tu/) |
| **Email** to the buyer | `buyer.email` = "Email nhận hóa đơn". `GET /v1/email-logs` shows sends with retry states. On Sandbox the log is "giả lập… `status` luôn là `sent`". **There is no endpoint to send or resend an email**, and no page explicitly says sending is automatic. | READ: D+`lich-su-gui-email`. INFERRED: SePay or the provider emails the buyer automatically on issue. Confirm in Sandbox and Production. |

## 6. Webhooks / callbacks

**READ (by absence)**: the embedded OpenAPI spec has no `webhooks` or callbacks, and no e-invoice page mentions any. Status is **poll-only**: "Thực hiện polling với khoảng cách 2-3 giây…
yêu cầu có thể ở trạng thái `Pending` tới 2 giờ" (D+`bat-dau-nhanh`). Retries run on a Fibonacci schedule (1, 1, 2, 3, 5, 8, 13 min): 8 attempts over about 33 min, with a hard cap of 2 h.
The retry cron "chạy theo chu kỳ 30 giây". Only infrastructure errors are retried; data and account errors fail at once (D+`xu-ly-loi`).
(SePay's *bank* webhooks are a separate product and are not tied to invoices.)
**INFERRED**: on Vercel you need durable state (an invoice row in Postgres with `reference_code`, `tracking_code`, `status`, `next_check_at`) plus a cron or retrying job to finish polling.
A request-scoped function cannot wait up to 2 hours.

## 7. Pricing and limits

**READ** (https://sepay.vn/sepay-einvoice.html; also https://sepay.vn/bang-gia.html "Hóa đơn điện tử: 100đ - 600đ / hóa đơn (Chưa bao gồm VAT 8%)"):

| Package | Invoices | Unit price | Total |
|---|---|---|---|
| eInvoice-300 | 300 | 600đ | 180.000đ |
| eInvoice-500 | 500 | 480đ | 240.000đ |
| eInvoice-1K | 1.000 | 450đ | 450.000đ |
| eInvoice-3K | 3.000 | 240đ | 720.000đ |
| eInvoice-5K | 5.000 | 180đ | 900.000đ |
| eInvoice-10K | 10.000 | 161đ | 1.610.000đ |
| eInvoice-20K | 20.000 | 150đ | 3.000.000đ |
| eInvoice-50K | 50.000 | 130đ | 6.500.000đ |
| eInvoice-200K | 200.000 | 100đ | 20.000.000đ |

- The HSM digital signature costs **1.272.000đ / year**. All prices exclude 8% VAT.
- **Quota**: `GET /v1/usage` → `quota_remaining` (string). It drops only on real issuance; drafts are free. When it runs out, issuance fails with `500 QUOTA_HAS_BEEN_USERD_UP`
  (typo as returned; "đừng retry tự động"). Source: D+`kiem-tra-han-ngach`, D+`xu-ly-loi`.
- No validity period for the packages is stated. Whether adjust or replace invoices use quota is not stated (INFERRED: probably yes, since quota counts "lượt thao tác hóa đơn").
- **Rate limits: none documented** on any page or in the spec (no 429). Page size is capped at 100.
- Retention: "Hóa đơn điện tử đã phát hành sẽ được lưu trữ trong 10 năm"; after you stop the service you can still look invoices up. Source: https://sepay.vn/sepay-einvoice.html

## 8. Developer surprises (READ unless marked)

1. **The `reference_code` you supply is the idempotency key.** It must be unique; a duplicate returns `409 EINVOICE_DOCUMENT_EXISTED`. "Mỗi hóa đơn cần một `reference_code` duy nhất do bạn sinh ra,
   và khi gửi lại phải dùng đúng mã đó." Before retrying a `Failed` request, call `GET /v1/invoices/{reference_code}`. A **404 means it is safe to resend**; data back means it already exists.
   The message "Hệ thống chưa xác nhận được kết quả phát hành với nhà cung cấp hóa đơn" means the outcome is **unknown**: "không gửi lại… liên hệ SePay", or you risk a duplicate signed invoice. (D+`xu-ly-loi`)
   INFERRED: derive it deterministically from your payment id.
2. **`issued_date` must be today**, in `YYYY-MM-DD HH:mm:ss`; past and future dates are rejected. The timezone is not stated for `issued_date`; `next_retry_at` is explicitly "giờ Việt Nam".
   INFERRED: format the date in `Asia/Ho_Chi_Minh`. Vercel runs in UTC, so between 00:00 and 07:00 Vietnam time a UTC date would be "yesterday" and get rejected.
3. **`invoice_series` is year-bound** (`C{YY}`). Read it from `GET /provider-accounts/{id}` at issue time and never hardcode it. INFERRED: a new year's series must exist on the provider account in time, so plan for 1 January.
4. **`is_draft` must be a JSON boolean**; the string `"false"` gives 400.
5. **Integers only** for `total_amount` and `tax_amount` (decimals give 400). Auto-computed totals round to integers. If you pass them yourself, SePay does **not** reconcile them with the lines.
   A wrong value prints on the invoice and "cơ quan thuế có thể từ chối". `quantity` allows at most 2 decimals.
6. **Two-step async** for create and issue. `create` with `is_draft:false` already signs and submits, so no `issue` call is needed. Status can stay `Pending` for up to 2 h.
   No `retry` block means "not yet attempted", not "retries off". `next_retry_at: null` means "settling the final result", not "retrying now".
7. **HTTP 500 is not always a server error.** Quota, billing and registration states also return 500 with a recognisable `error.code`. "Xử lý lỗi dựa trên `error.code`, không khớp theo chuỗi `error.message`."
   A `Failed` async status carries **no `error.code`**, only `message`.
8. Status codes are inconsistent: create and issue answer 200, adjust and replace answer **202**. Adjust and replace examples return `tracking_url` values like `/v1/invoices/adjust/check/…`
   and `/v1/invoices/replace/check/…`, **but those paths are not in the spec**. The docs say to poll `/v1/invoices/create/check/{tracking_code}` for all three.
9. `quota_remaining` and `invoice_number` are **strings**. `invoice_number` is `"0"` for drafts. Detail line items return numbers as decimal strings.
10. Character limits found: adjust/replace `notes` ≤255; `buyer_code` ≤100; `national_id` ≤12; business location `code` ≤50, `name` ≤400, `address` ≤255.
    **No max length is documented** for create `notes`, `item_name`, buyer `name`, or buyer `address`.
11. Sandbox: `tax_authority_approved_date` is `null` and email logs are simulated. "Test mode" skips the approval-date check.
12. No cancel endpoint, and a correction path (adjust vs replace) is locked after first use.

---

## Separate question: can a household business or individual use it, and must a below-threshold seller issue invoices?

**SePay side (READ)**
- Built for "hộ kinh doanh và doanh nghiệp" (D+`tong-quan`). The product page says "Từ hộ kinh doanh đến doanh nghiệp lớn" and "phù hợp cho hộ kinh doanh và doanh nghiệp".
  Registration needs "thông tin doanh nghiệp **hoặc hộ kinh doanh**, mã số thuế và chứng thư số" (https://sepay.vn/sepay-einvoice.html).
- No page says a plain individual (cá nhân) **without** business registration can use it.
  INFERRED: you need a tax code, a digital certificate in that tax code's name, and a tax-authority-approved e-invoice registration, so in practice an enterprise or a registered household or individual business.
  Error texts say "Doanh nghiệp" and "Công ty".

**Law (secondary sources; I could not read the official gazette text, so verify with an accountant)**
- **Decree 141/2026/NĐ-CP** (29/4/2026, effective retroactively from 01/01/2026) amends **Decree 68/2026/NĐ-CP** (05/03/2026, on tax for household and individual businesses).
  It replaces "500 triệu đồng" with "**01 tỷ đồng**" in Art. 3, Art. 4, Art. 8(1), Art. 9, Art. 10 and others. New Art. 8(5):
  (a) household or individual businesses with annual revenue **over 1 billion VND must use** e-invoices with a tax-authority code, or cash-register e-invoices;
  (b) those **at or below 1 billion** "đáp ứng điều kiện và **có nhu cầu**" **may register** to use them;
  (c) those who cross 1 billion mid-year must register within 30 days.
  Source (text quoted): https://hethongphapluat.com/nghi-dinh-141-2026-nd-cp-21f4c295caca62acf3b33cedda2abb2d.html
- Secondary sources say the **VAT-exempt / PIT-free revenue threshold for household businesses is now 1 billion VND/year** (it was 500 million early in 2026, after the amended VAT law and the 2025 PIT law).
  Sources disagree on the effective date. Sources: https://einvoice.vn/tin-tuc/hkd-doanh-thu-duoi-1-ty-nam, https://thue.man.net.vn/nghi-dinh-so-141-2026/ (search snippets),
  and earlier https://luatvietnam.vn/linh-vuc-khac/ho-kinh-doanh-co-doanh-thu-duoi-500-trieu-nam-co-phai-xuat-hoa-don-dien-tu-khong-883-106880-article.html (Feb 2026, at 500 million).
- **Tax Department statement of 17/4/2026** (Công văn 2458/CT-PC per luatquanghuy): local tax offices may **not** force households below the threshold to stop using e-invoices.
  Households already using them may continue "không phải thông báo bổ sung". Sources: https://vnexpress.net/ho-co-doanh-thu-duoi-500-trieu-dong-van-duoc-xuat-hoa-don-dien-tu-5063805.html,
  https://luatquanghuy.vn/tu-van-luat/thue-phi/ho-kinh-doanh-doanh-thu-duoi-500-trieu-van-duoc-dung-hoa-don-dien-tu-huong-dan-moi-nhat-2026-tu-cuc/
- **Must a below-threshold seller still issue invoices?** Under Decree 123 Art. 4(1) as amended by 70/2025, "người bán phải xuất hóa đơn để giao cho người mua", including households under 500 million,
  but such a seller is **not obliged to use e-invoices** (luatvietnam, Feb 2026, the author's reading).
  From **1/7/2026 Decree 254/2026 replaces Decree 123**. EY says it exempts household businesses from issuing invoices for some income types (property leasing, digital content to foreigners,
  agency income where tax is withheld). It also allows "bán cho người tiêu dùng" when an individual consumer gives no details. (EY link in §1.)
  **I could not confirm** the post-1/7/2026 general obligation for a household below 1 billion selling digital subscriptions to consumers. This is for an accountant.
- Which template to use: VAT invoice (template 1) belongs to the credit (khấu trừ) VAT method; sales invoice (template 2) belongs to the direct method, which household businesses use.
  Sources: Cục Thuế material on Decree 70/2025 cited by search results, and https://www.misaeshop.vn/?p=28609 (secondary). INFERRED: a household seller would use template 2 with no tax_rate.

## Not confirmed / open questions to put to SePay (support@sepay.vn per spec `info.contact`; hotline 02873.059.589)
1. How to get Sandbox credentials, and how "test mode" differs from Sandbox.
2. Whether issuance automatically emails `buyer.email` in Production, and whether multiple addresses are allowed.
3. Whether `pdf_url` is public and permanent; whether `/download` takes `tracking_code` or `reference_code`; how to get the lookup code (mã tra cứu).
4. USD invoices: how the exchange rate is set, and whether cents are supported given the integer-only totals.
5. Whether adjust or replace consumes quota; whether quota packages expire.
6. Who files the registration form (Mẫu 01/ĐKTĐ-HĐĐT) and how long tax-authority approval takes.
7. Whether there are any rate limits.
8. When the docs will move from Decree 123/Circular 78 to Decree 254/Circular 91, and whether anything in the API changes as a result.
