# SePay payments: checking the design document against SePay's current docs

Researched 2026-11-12. Every page was fetched live today: raw HTML with curl, the developer site's raw `.md` pages, its `llms-full.txt` (generated 2026-11-05), WebFetch and WebSearch.
Labels used below:
- **[READ]** means the page states it.
- **[MEASURED]** means I ran it myself (curl, or decoding a QR image).
- **[INFERRED]** means it is my reasoning and not on any page.

Main sources:
- docs.sepay.vn: the older user docs. Still live and partly updated.
- developer.sepay.vn: the current developer docs. Any page also serves raw markdown at `<url>.md`.
- sepay.vn: marketing and pricing pages.

---

## A. Webhooks ("Tích hợp webhook", bank-balance change)

### A1. Payload fields: CONFIRMED (12 fields, no others)
Source: https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook (also https://docs.sepay.vn/tich-hop-webhooks.html)

[READ] Field table:

| field | type | null/empty | note (translated) |
|---|---|---|---|
| id | integer | no | SePay transaction ID. "does not change across retries and replays, use as dedup key" |
| gateway | string | no | bank name (Vietcombank, BIDV, TPBank…) |
| transactionDate | string | no | `YYYY-MM-DD HH:mm:ss`, Vietnam time |
| accountNumber | string | no | bank account number |
| subAccount | string | may be "" | the VA that matched (an official VA, or a TKP "content VA"); "" if none |
| code | string | **may be null** | "Mã thanh toán (e.g. DH123456), extracted from the content by the prefix in Company → General configuration → Payment code structure. Unrelated to VA. **null when no configuration matches**." |
| content | string | no | the bank's original transfer content, "SePay does not process it" |
| transferType | string | no | `in` / `out` |
| description | string | may be "" | the bank's full description; empty for some banks |
| transferAmount | integer | no | VND, always positive |
| accumulated | integer | may be 0 | balance after the transaction; 0 if the bank does not provide it |
| referenceCode | string | may be "" | the bank's reference code |

Example from the docs: `{"id":92704,"gateway":"Vietcombank","transactionDate":"2024-07-02 11:08:33","accountNumber":"1017588888","subAccount":"","code":"SEVN63DC8E5C","content":"SEVN63DC8E5C chuyen tien","transferType":"in","description":"NGUYEN VAN A chuyen tien","transferAmount":5000000,"accumulated":105000000,"referenceCode":"FT24012345678"}`

[READ] The body is JSON by default. Webhooks that use API Key, HMAC or no auth can instead be sent as `multipart/form-data` or `application/x-www-form-urlencoded`. OAuth 2.0 webhooks are always JSON.

[READ] The developer page and the payment-code page disagree on the empty case:
- developer page: "`code = null` means no payment code, which is different from an empty code".
- payment-code page: "Hết mẫu mà không khớp → code rỗng" ("no pattern matches → code is empty").
[INFERRED] Treat both `null` and `""` as "no code".

### A2. Authentication: the design's claim is CONFIRMED (HMAC-SHA256 with X-SePay-Signature and X-SePay-Timestamp is real)
Source: https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc

[READ] Four options are offered: none, API Key, HMAC-SHA256 and OAuth 2.0. **HMAC-SHA256 is marked "Khuyến nghị" (recommended).**

**HMAC-SHA256** [READ]:
- Headers:
  - `X-SePay-Signature: sha256={hex_hash}`
  - `X-SePay-Timestamp: {unix seconds}`
- Signed string: `{timestamp}.{raw_body}`, using HMAC-SHA256 with your Secret Key and hex output.
- You must use the raw body bytes. The docs warn that re-serialising `express.json()` output breaks the signature, and say to use `express.raw({ type: 'application/json' })`.
- For form-encoded webhooks, SePay signs the form-encoded string.
- The PHP sample rejects requests where |now − timestamp| > 300 s and compares with `hash_equals`.
- The secret is shown in full only once. Afterwards the dashboard shows `****xxxx`.

**API Key** [READ]: `Authorization: Apikey YOUR_API_KEY`. The docs say it "only verifies the request came from SePay, does not protect the payload".

**OAuth 2.0** [READ]:
- SePay fetches a token from your HTTPS token endpoint. It tries client_credentials form-urlencoded first and falls back to a custom JSON `{clientId, clientSecret}` request.
- It then sends `Authorization: Bearer {token}`.
- It refreshes the token when less than 10 s of validity remains.

**None** [READ]: "test only, never production".

### A3. Success response, timeout and retries: mostly CONFIRMED, with two corrections
Sources:
- https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook
- https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi
- https://docs.sepay.vn/tich-hop-webhooks.html

**Success** [READ]: all three conditions must hold.
- HTTP **200 or 201**
- a body that is exactly `{"success": true}`
- a response within **30 s**

These all count as failure: 200 with any other body (`{"status":"ok"}` or empty), 202, redirects, 4xx and 5xx.

**OAuth 2.0 timeout** [READ, docs.sepay.vn]: SePay may wait only 8 s.

**OAuth 2.0 success rule** [READ, docs.sepay.vn]: SePay reads only the status code, and "with some webhooks (made in the old UI or via API, attached directly to a bank account) only 201 counts as success". The developer xac-thuc page instead says "200/201 + {"success": true}".
[INFERRED] If OAuth is used, return 201 with `{"success":true}`, which satisfies both rules.

**Retry schedule** [READ]:
- Fibonacci waits of 1, 1, 2, 3, 5, 8 and 13 minutes.
- That is 8 sends in total (1 initial + 7 retries), about 33 minutes.
- The webhook is then marked Failed, and an alert is sent if alerts are configured.
- "Webhooks older than 5 hours are no longer scanned by the retry cron."

**Correction 1, retries are conditional.** The two doc sites disagree:
- docs.sepay.vn [READ]: "SePay only retries in two cases: (1) cannot connect or timeout, (2) you enabled 'Tự động gửi lại khi server trả lỗi' and the endpoint returned non-2xx. **An endpoint that returns 200 but lacks {"success": true} is only recorded as failed, NOT retried.**"
- developer.sepay.vn/xu-ly-loi [READ]: "When the webhook has 'Tự động gửi lại khi server trả lỗi' enabled, SePay retries if: cannot connect (DNS, refused, timeout); status outside 200-299". This places both cases under the setting.

[INFERRED] Turn the option on in the webhook setup, and never answer 200 with the wrong body.

**Correction 2, manual resends exist.** [READ]
- docs.sepay.vn: "You can resend manually in the webhook log".
- developer site: use the **Sự cố** (Incidents) page → **Phát lại** (replay) to resend lost transactions, including to a new URL. "Admin can replay even successful logs".
- There is also a **Gửi thử** (test send) button. Test payloads carry a mock `id` such as 0.

**Response timing** [READ]: "Return 200 immediately, then push the payload to a queue."
[INFERRED, Vercel] Work done after the response is not guaranteed on Vercel unless you use `waitUntil`. The safer pattern is a fast synchronous path: verify the signature, run one `INSERT … ON CONFLICT DO NOTHING`, credit the account, then answer. It should finish well under the 30 s timeout. Cold start plus a Supabase connection must also fit, so keep it lean.

### A4. Duplicates: CONFIRMED that the receiver must de-duplicate
Source: https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook

[READ] Duplicates come from three places: automatic retries, manual replays (including replays of successful logs), and several webhooks pointing at the same endpoint.
- Dedup on `id`, which is stable across retries and replays.
- Make `transaction_id` UNIQUE and use `INSERT IGNORE`.
- When the row already exists, still return `{"success":true}`.

[INFERRED, Postgres] The equivalent is `INSERT … ON CONFLICT (sepay_id) DO NOTHING RETURNING id`, then credit the account only when a row came back. Do the insert and the credit in one transaction.

### A5. Sending IPs: CONFIRMED, published
Sources:
- https://developer.sepay.vn/vi/dia-chi-ip
- https://docs.sepay.vn/tich-hop-webhooks.html

[READ]
- IPv4: 172.236.138.20, 172.233.83.68, 171.244.35.2, 151.158.108.68, 151.158.109.79, 103.255.238.139, 45.57.137.67
- IPv6: 2400:8905::2000:8cff:fe98:45cd, 2600:3c15::2000:8aff:fedd:874b

"The list may be updated in future, check periodically." HTTPS is required: "SePay does not send to plain HTTP URLs".
[INFERRED] On Vercel, read the client IP from `x-forwarded-for` / `x-real-ip`. Use the IP list only as a second layer: HMAC is the real check, and a hard-coded list will go stale.

### A6. Payment-code detection: CONFIRMED in detail; the docs say nothing about how banks change content
Sources:
- https://developer.sepay.vn/vi/sepay-webhooks/cau-hinh-ma-thanh-toan
- https://docs.sepay.vn/cau-hinh-chung.html

[READ] Where to set it: my.sepay.vn → Cấu hình Công ty → Cấu hình chung → "Nhận diện mã thanh toán" (an on/off switch, default on) and "Cấu trúc mã thanh toán". Several patterns are allowed. The first one is the default and cannot be deleted.

Each pattern has [READ]:
- **Prefix** (tiền tố), 2–5 characters, uppercased when saved. docs.sepay.vn adds "phải là chữ" (must be letters).
- **Min suffix length**, 1–30, default 6.
- **Max suffix length**, 1–30, default 8, and at least the minimum.
- **Character type**: "Số nguyên" (digits 0-9) or "Số và chữ" (digits and A-Z).

How matching works [READ]:
- Patterns are tried in declared order.
- SePay "searches the content for `<prefix><min..max chars of the type>`. **The prefix is case-insensitive**."
- The first match becomes `code` and matching stops.

Examples from the docs:
- `dh999999 thanh toan` → `DH999999` (uppercased)
- `DH123` with a minimum of 6 → no code
- `HD12AB` with alphanumeric 4-6 → `HD12AB`

Webhook filters that depend on this [READ]:
- "Chỉ gửi khi có mã thanh toán": skip transactions with no code.
- "Lọc theo mã thanh toán": only send when the code starts with one of the chosen prefixes.
- Test mode keeps its own pattern configuration.

Reserved content tokens [READ, https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code]:
- VietinBank personal and household accounts need `SEVQR` in the content.
- The "VA by content" scheme uses `TKP` + VA code.
- For MB (listed under "other banks") a VA is optional, so a plain account number works.

What the docs do not cover [READ, by absence]: I found no SePay page about banks rewriting transfer content (stripping hyphens, uppercasing, adding prefixes). The only related facts are QR-side:
- SePay's QR generator strips diacritics and special characters from `des` (anything that is not a letter, digit or space) and caps it at 94 chars.
- vietqr.io caps `addInfo` at 50 characters with no special characters.

The safest order-code format [INFERRED, from the documented matcher]:
- A letters-only prefix of 3–5 characters, unlikely to occur naturally. Avoid tokens banks or SePay use: `FT`, `MB`, `IBFT`, `CT`, `TKP`, `SEVQR`.
- A **digits-only** suffix with **min = max** (for example 8). With an alphanumeric suffix and a range, the matcher can swallow following letters when the customer types no space, e.g. `DH123456chuyen`.
- No hyphens, underscores or dots. They are stripped by the QR generator and cannot be part of the pattern.
- Put the code first in the QR `des`, keep `des` short (well under 50 chars), and match case-insensitively. SePay already returns `code` uppercased.
- Because the match is a substring search, a bank-added prefix such as `MBVCB.123.` in front of your code should not break detection. That is inferred, not documented.
- Still check the amount against the order, and fall back to looking for the code in `content` yourself.

---

## B. QR codes

### SePay's generator: CONFIRMED that it exists. The documented host is now `vietqr.app`; `qr.sepay.vn/img` still works.
Sources:
- https://docs.sepay.vn/tao-qr-code-vietqr-dong.html
- https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code

[READ] "SePay provides a tool to create dynamic QR images at qr.sepay.vn". The documented embed format is:
`https://vietqr.app/img?acc=…&bank=…&amount=…&des=…&template=…&download=…&showinfo=…&fullacc=…&holder=…&store=…`

[READ] Parameters:

| param | required | rule |
|---|---|---|
| acc | yes | account number or VA, letters and digits only |
| bank | yes | `code`, `bin`, `short_name` or `alias` from https://vietqr.app/banks.json (for example MB, 970422 or MBBank) |
| amount | no | VND, digits only; leave empty and the customer types the amount |
| des | no | ≤94 chars; diacritics and special characters are removed |
| template | no | (empty) = standard QR with the VietQR logo; `compact` = NAPAS/VietQR, bank and SePay logos; `qronly` = QR only; `standee` = print layout |
| download | no | `true` makes the browser download the image |
| showinfo, fullacc, holder, store | no | show account information on the image |

[MEASURED] Both hosts return `HTTP 200 image/png` (360×360, through Cloudflare):
- `https://qr.sepay.vn/img?acc=0000000000&bank=MBBank&amount=100000&des=DH123456&template=qronly`
- the same query on `https://vietqr.app/img`

I decoded both images with jsQR. They carry the identical payload:
`00020101021238540010A00000072701240006970422011000000000000208QRIBFTTA530370454061000005802VN62120808DH123456630404AB`

That breaks down as:
- `010212`: point of initiation **12 = dynamic**
- `38…A000000727`: the NAPAS VietQR GUID
- `0006970422`: MB's BIN
- `QRIBFTTA`: transfer to an account
- `5303704`: VND
- `5406100000`: **fixed amount**
- `5802VN`
- `62…0808DH123456`: **fixed content** in purpose field 08
- `6304`: CRC

So it is a standard NAPAS/EMVCo VietQR dynamic QR with a fixed amount and content.

Price [READ / INFERRED]: no API key is needed, and I saw no fee or rate limit published for the generator. The pricing page lists "QR thanh toán tĩnh & động" as a feature. I found no SLA either.

### img.vietqr.io: CONFIRMED real (Casso). Current format is `.svg`.
Source: https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/

[READ] Format: `https://img.vietqr.io/image/<BANK_ID>-<ACCOUNT_NO>-<TEMPLATE>.svg?amount=&addInfo=&accountName=`
- Templates: compact2, compact, qr_only, print, …
- `addInfo` ≤50 chars, no special characters.
- `accountName` is "not part of the VietQR standard".
- **Rate limit: 10 QR per 10 s per IP.**
- The page announces upcoming changes to the Generate, Quicklink and Custom Theme APIs.

[MEASURED] A `.png` URL now answers 301 → the same path as `.svg`.

### dl.vietqr.io deep link: CONFIRMED real
Source: https://www.vietqr.io/danh-sach-api/deeplink-app-ngan-hang/

[READ] Format: `https://dl.vietqr.io/pay?app={appId}&ba={account}@{bank}&am={amount}&tn={content}&bn={name}&url={return_url}`
- `ba`, `am`, `tn`, `app` and `url` are listed as required.
- App lists: `https://api.vietqr.io/v2/android-app-deeplinks` and `https://api.vietqr.io/v2/ios-app-deeplinks`.
- **Autofill deep links are limited to 5 per minute per IP.**

[MEASURED] It returns 200 HTML.

### Is SePay's generator enough on its own? YES for the QR (inferred)
[INFERRED]
- A dynamic VietQR with a fixed amount and content is everything a Vietnamese bank app needs.
- img.vietqr.io adds nothing SePay's image lacks, and it brings a tighter rate limit and a second third party.
- The dl.vietqr.io deep link is an optional phone convenience: tap to open a bank app instead of scanning. It is a Casso service, not SePay's. Drop it or add it later.
- A zero-dependency alternative is to build the EMVCo string on the server (format above, CRC16-CCITT) and render it locally. That keeps account, amount and order code off third-party hosts.
- Either way, show the account number, amount and content as copyable text beside the QR.

---

## C. SePay "Cổng thanh toán" (payment gateway)

Sources:
- https://developer.sepay.vn/vi/cong-thanh-toan/gioi-thieu
- https://developer.sepay.vn/vi/cong-thanh-toan/luong-thanh-toan
- https://developer.sepay.vn/vi/cong-thanh-toan/API/don-hang/form-thanh-toan
- https://developer.sepay.vn/vi/cong-thanh-toan/IPN
- https://developer.sepay.vn/vi/cong-thanh-toan/sdk/nodejs
- https://sepay.vn/cong-thanh-toan-truc-tuyen.html

**It exists: CONFIRMED** [READ].

Hosts:
- API: `https://pgapi.sepay.vn` (sandbox `pgapi-sandbox.sepay.vn`)
- Checkout: `https://pay.sepay.vn` (sandbox `pay-sandbox.sepay.vn`)

**Payment methods** [READ], three groups:
1. VietQR bank-transfer QR. Money goes straight to your own account. Personal and business accounts. Activated online in about 30 minutes.
2. NAPAS QR ("VietQRPay / VietQRGlobal"). SePay is an authorised NAPAS partner. Needs "7 legal documents, 3-7 days".
3. International **Visa, Mastercard and JCB** credit and debit cards, through SePay + VPBank + Mastercard MPGS with 3-D Secure. Needs "business documents (3 basic documents), 3-7 days" and "hồ sơ doanh nghiệp".

Not listed anywhere [READ, by absence]: **Amex** and **domestic ATM/NAPAS cards**. `payment_method` takes only `CARD | BANK_TRANSFER | NAPAS_BANK_TRANSFER`.

**Recurring billing, auto-charge and saved cards: NOT AVAILABLE** [READ]
- The payment-flow page, under "Thanh toán định kỳ (Recurring Payment)": "**Tính năng sắp ra mắt** — Recurring payment is being finalised and will be released soon."
- The Node and PHP SDKs: `operation` "hiện chỉ hỗ trợ: PURCHASE" (currently PURCHASE only).
- One API page lists `VERIFY` ("card verification, free"), and the English IPN page lists a `RENEWAL_ORDER_PAID` type and an `agreement` field. These point to a card-on-file product being built. No tokenisation, saved-card or charge-a-saved-card API is documented.

**Integration** [READ]:
- Your server builds an HTML form and **POSTs it to `https://pay.sepay.vn/v1/checkout/init`**. SePay answers 302 to its own hosted page at `/v1/checkout`, where the customer chooses a method and enters card details.
- Form fields:
  - merchant, currency=VND, order_amount, operation=PURCHASE
  - order_description, order_invoice_number (unique)
  - optional: payment_method, customer_id, success_url, error_url, cancel_url, lang
- **Signature**:
  - Take the allowed fields in this fixed order: `order_amount, merchant, currency, operation, order_description, order_invoice_number, customer_id, payment_method, success_url, error_url, cancel_url`.
  - Skip empty, `0` and `"0"` values.
  - Join them as `field=value` with commas.
  - Compute `base64(HMAC-SHA256(string, merchant secret_key))`.
  - The input order in the HTML must match.
- **IPN**:
  - SePay POSTs JSON to the URL set under Cổng thanh toán → Cấu hình → IPN.
  - Header `X-Secret-Key: <secret>` is sent when auth type = SECRET_KEY.
  - `notification_type` values: `ORDER_PAID` and `TRANSACTION_VOID`; the English page adds `RENEWAL_ORDER_PAID`.
  - The body holds `order`, `transaction` (masked card number and brand for cards), `customer` and `agreement`.
  - Return 200. The IPN URL must be public HTTPS.
  - The docs warn: confirm orders by IPN, not by return_url.
- **REST API**: Basic auth with `merchant_id:secret_key`. Covers list, detail, cancel order, and void card transaction.
- **SDKs**: `npm i sepay-pg-node`, plus PHP.

**Fees** [READ, https://sepay.vn/cong-thanh-toan-truc-tuyen.html]:

| method | fee |
|---|---|
| VietQR bank transfer | **200–500 đ per transaction, fixed** |
| NAPAS QR | **0.3%** |
| International cards | **1.6%–2.2% + 2,200 đ** per transaction, "set by contract" |

It is UNCONFIRMED whether the VietQR gateway fee comes on top of the plain SePay plan (section E).

**"Add payment method" card form like Stripe's** [INFERRED from all of the above]:
- **SePay cannot do it.** There are no embeddable card fields, no tokenisation, and no saved card to charge later.
- Card entry happens only on SePay's hosted `pay.sepay.vn` page, one charge per checkout, and card acceptance needs business registration documents.

The honest equivalent:
- (a) Every subscription period is a new checkout: QR transfer, or the hosted card page once card acceptance is approved.
- (b) Replace "Add payment method" with "How you pay: bank transfer by VietQR", plus renewal reminders and a "Renew now" button.
- (c) Optionally let renewals draw automatically from the prepaid service balance. That is the app's own ledger, not a stored card.
- Revisit when SePay ships recurring payments.

---

## D. Transaction API for a backup poller: CONFIRMED that v2 exists, and the design's call is right
Sources:
- https://developer.sepay.vn/vi/sepay-api/v2/giao-dich/danh-sach
- https://developer.sepay.vn/vi/sepay-api/v2/xac-thuc
- https://developer.sepay.vn/vi/sepay-api/v2/nang-cap-tu-v1
- https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich

[READ] Endpoint: **`GET https://userapi.sepay.vn/v2/transactions`** (sandbox `https://userapi-sandbox.sepay.vn/v2`).
- The design's `GET /v2/transactions` with `transaction_date_from` and `amount_in_min/max` is correct.
- v1 still works: `GET https://my.sepay.vn/userapi/transactions/list`, with `transaction_date_min/max`, `since_id`, `limit` (default 5000) and an exact `amount_in`. It is marked "no longer developed".

**Auth** [READ]: `Authorization: Bearer {api_key}`. The key is 64 alphanumeric characters, made in Cài đặt công ty → API Keys.

**Rate limit** [READ]:
- **3 requests per second per IP**, checked before auth.
- Over the limit returns 429 with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.
- v1 says 3/s in its header text but "2 request/giây" in its error table.

**Query parameters** [READ]:
- `q` searches reference_number, content and code.
- Filters:
  - `bank_account_id`, `va_id`, `bank_brand_name`
  - `transaction_date_from` / `transaction_date_to` (inclusive, `YYYY-MM-DD HH:mm:ss`)
  - `amount_in_min` / `amount_in_max`, `amount_out_min` / `amount_out_max`
  - `reference_number` (exact), `transaction_content`, `transfer_type=in|out`, `webhook_success=0|1`
- Polling:
  - `since_id` takes the UUID of the last transaction you have. It filters only and does not change the order, so add `transaction_date_sort=asc` and read every page.
- Sorting and output:
  - `amount_in_sort`, `amount_out_sort`, `fields`
  - `timestamp_format=iso8601`
- **Pagination**: `page` / `per_page` (default 20, max 100). The response carries `meta.pagination{total, per_page, current_page, last_page, has_more}`.

**Response row** [READ]: `id` (UUID), transaction_date, account_number, va, transfer_type, amount_in and amount_out (integers), accumulated, transaction_content, reference_number, code, bank_brand_name, bank_account_id, va_id, `webhook_success` (0, 1 or null).

**Gotcha**:
- [READ] v2 `id` is a **UUID**, while the webhook `id` is an **integer**. SePay's own reconciliation sample matches webhook rows to API rows by **`reference_number`** (webhook `referenceCode`).
- [INFERRED] v1 `id` is numeric and probably equals the webhook `id`. No page states this.
- [INFERRED] Make the dedup key unique on `(account_number, reference_number)` as well as the webhook id, or match on reference number. `referenceCode` "may be empty" for some banks, so keep a fallback on (date, amount, content).

[INFERRED] Polling every 10–15 minutes is well inside 3 req/s. Data is kept 6 months by default (section E).

---

## E. Pricing (read 2026-11-12)
Sources:
- https://sepay.vn/bang-gia.html
- https://docs.sepay.vn/goi-dich-vu.html
- https://docs.sepay.vn/cau-hinh-chung.html
- https://docs.sepay.vn/ket-noi-mb-api.html

**FREE: 0 đ a month, 50 transactions a month. CONFIRMED** [READ]. Overage is allowed and billed at the end of the cycle at **700 đ per transaction** on the free plan (from the tooltip).

**STARTUP: 120,000 đ a month, 180 transactions a month. CONFIRMED** [READ].

Higher API plans, monthly price for transactions per month [READ, from the HTML option list]:

| plan | price per month | transactions per month |
|---|---|---|
| Startup Plus | 220,000 đ | 350 |
| Basic | 368,000 đ | 600 |
| VIP | 589,000 đ | 1,000 |
| Growth | 850,000 đ | 1,500 |
| Stellar | 1,190,000 đ | 2,300 |
| Premium | 1,680,000 đ | 3,400 |
| Elite | 2,480,000 đ | 5,100 |

The ladder continues up to 986,000 transactions a month. Paying yearly is "Giảm tới 20%" (up to 20% off). On paid plans, overage costs "the plan's own price per transaction".

Other plan facts [READ]:
- Every plan has every feature: webhook, API and "Cổng thanh toán trực tuyến".
- The bank list on FREE and STARTUP is the 12 API banks, **including MBBank**.

**What counts** [READ]:
- "Số lượng giao dịch là tổng số lượng giao dịch **tiền vào** trong một tháng" (the number of *incoming* transactions in a month).
- "Outgoing transactions are free and do not count toward the quota."
- [INFERRED] The count is of bank transactions, not webhook deliveries. Retries and replays should not count. No page says this outright.

**SMS Banking fallback: PARTLY CONFIRMED, but manual and plan-dependent** [READ, https://docs.sepay.vn/ket-noi-mb-api.html]:
- For MB, SePay lets you **switch the connection by hand** from API Banking to SMS Banking "khi hệ thống ngân hàng MB gián đoạn hoặc bảo trì" (when MB's system is down or under maintenance).
- The switch requires that "**gói dịch vụ bạn đang sử dụng phải hỗ trợ SMS Banking**" (your current plan supports SMS Banking), plus a SIM registered with MB for balance SMS.
- [READ, by absence] The current pricing page shows only FREE and API plans covering the 12 API banks. I saw no SMS plan offered.
- [INFERRED] It is not automatic and probably not open to FREE or STARTUP. The design overstates it if it implies an automatic fallback.

**Data retention: CONFIRMED 6 months by default, and configurable** [READ, cau-hinh-chung]:
- Options are 1 h, 8 h, 1 day, 3 days, 7 days, 1 month, 3 months, **6 months (default)**, and 1, 2 or 3 years (contact SePay for a quote).
- When the period ends, transactions, chat logs and **webhook logs** are deleted.
- goi-dich-vu says "Dữ liệu giao dịch được lưu tối đa 6 tháng" (kept up to 6 months) unless you pay for longer.

---

## F. Linking MBBank: CONFIRMED official API, OTP, no internet-banking password; personal accounts supported
Sources:
- https://sepay.vn/mb.html
- https://docs.sepay.vn/ket-noi-mb-api.html
- https://docs.sepay.vn/them-tai-khoan-ngan-hang.html
- https://sepay.vn/bang-gia.html

[READ]
- "SePay là đối tác chính thức của MB Bank… API chính thức từ ngân hàng" (official MB partner, official bank API). It is free and online in about a minute.
- Steps:
  1. my.sepay.vn → Ngân hàng → Kết nối thêm → MB.
  2. Account type: **Cá nhân** (personal), Hộ kinh doanh (household business) or Doanh nghiệp (business).
  3. Enter the MB account number, CCCD (or tax code for a business) and the registered phone number.
  4. MB sends an **OTP**, which you enter.
- "SePay không hỏi mật khẩu ngân hàng" (SePay never asks for the bank password). The add-account page says SePay never needs your Internet Banking password, whether you connect by API or SMS.
- By default SePay receives credits and debits on the main account.
- MB accounts linked since 2024-11-01 can create official MB VAs.

---

## G. Legal context (Vietnam)
Source of the decree text: Nghị định 52/2024/NĐ-CP (signed 15/05/2024, effective 01/07/2024, replacing NĐ 101/2012), full text at https://caselaw.vn/van-ban-phap-luat/411601-nghi-dinh-so-52-2024-nd-cp-ngay-15-05-2024-cua-chinh-phu-quy-dinh-ve-thanh-toan-khong-dung-tien-mat

What the text says [READ]:
- **Art. 2**: the decree covers (1) payment service providers, (2) intermediary payment service providers, (3) parties involved with them, and (4) "Tổ chức, cá nhân **sử dụng** dịch vụ… (sau đây gọi là khách hàng)", meaning users, who are called customers.
- **Art. 22.1**: the intermediary payment services are financial switching, international switching, electronic clearing, e-wallet, collection/disbursement support, and electronic payment gateway. A non-bank must hold an SBV licence to provide them. Providing them without one is banned by **Art. 8.7**.
- **Art. 3.12, tiền điện tử (e-money)**: "giá trị tiền Việt Nam đồng lưu trữ trên các phương tiện điện tử được cung ứng trên cơ sở đối ứng với số tiền được khách hàng trả trước cho **ngân hàng, chi nhánh ngân hàng nước ngoài, tổ chức cung ứng dịch vụ trung gian thanh toán cung ứng dịch vụ ví điện tử**". In English: VND value stored on electronic media against money the customer prepaid to a bank, a foreign bank branch, or a licensed e-wallet provider.
- **Art. 3.16, dịch vụ ví điện tử (e-wallet service)**: a service "để nạp tiền vào ví điện tử, **rút tiền ra** khỏi ví điện tử và **thực hiện giao dịch thanh toán**" (to top up, withdraw, and make payment transactions).
- **Art. 6.1**: "Ví điện tử, thẻ trả trước là phương tiện lưu trữ tiền điện tử" (e-wallets and prepaid cards are means of storing e-money).
- **Art. 3.10 and 3.11, with Art. 8.6**: payment instruments are listed exhaustively. Anything else is a "phương tiện thanh toán không hợp pháp" (illegal payment instrument), and issuing or using one is banned.

**G1. Receiving into your own account: CONFIRMED as the reading of the text, but [INFERRED]; no clause says so directly.**
A seller collecting bank transfers or VietQR payments into its own MB account is a *customer* of MB under Art. 2.4. It provides none of the Art. 22.1 services, so no intermediary licence is needed. SePay itself only reads the notifications, and the money never passes through SePay ("Tiền vào trực tiếp không qua trung gian", sepay.vn/cong-thanh-toan-truc-tuyen.html).

**G2. A service balance is not an e-wallet: UNCONFIRMED as an explicit exemption, but defensible [INFERRED].**
- Nothing in NĐ 52/2024 mentions closed-loop store credit, points or vouchers. Neither does a summary article I checked (doanhnghiephoinhap.vn).
- By the definitions, e-money is value prepaid to a bank or licensed intermediary, and an e-wallet service includes withdrawal and payment transactions.
- A balance that is non-withdrawable, non-transferable and spendable only on the seller's own services reads as **prepayment for services**, not e-money.
- The real risk is Art. 8.6 (illegal payment instrument) if the balance ever works like money: transfers between users, paying third parties, cash-out, or interest or bonuses expressed in VND.

Mitigations [INFERRED]:
- Call it "service credit" in the UI.
- Spend it only on your own plans or usage.
- No user-to-user transfers, no withdrawal, no third-party spending.
- Book it as unearned revenue.
- Publish refund terms.
- **Get a Vietnamese lawyer's written opinion before launch.** Also check consumer-protection rules on prepaid balances and refunds (Luật Bảo vệ quyền lợi người tiêu dùng 2023), which I did not research.

[READ] A draft decree amending NĐ 52/2024 was out for comment in 2026 (thuvienphapluat and luatvietnam hold the draft, which has no number). I could not confirm it has been issued. Circular 40/2024/TT-NHNN (guiding intermediary services) has since been amended by 41/2025 and 22/2026. Re-check these before launch.

---

## Practical takeaways for the build [INFERRED]
1. Webhook route:
   - HTTPS, `express.raw` on that route only, and HMAC check on `{ts}.{raw}` with a ±300 s window and a constant-time compare.
   - Dedup insert, then credit, inside one DB transaction. Reply `200 {"success":true}`.
   - In the SePay dashboard, turn on "Tự động gửi lại khi server trả lỗi", turn on failure alerts, and turn on "Chỉ gửi khi có mã thanh toán" plus the prefix filter.
2. Order code: one letters-only prefix plus a fixed-length digits-only suffix, e.g. `PREFIX + 8 digits`. Match on `code`, re-check the amount, and fall back to `content`.
3. Poller every 10–15 minutes on the v2 API:
   - `transaction_date_from` = last checkpoint minus a margin, `transfer_type=in`, `per_page=100`, `transaction_date_sort=asc`, all pages.
   - Match on reference number and code, and reuse the same idempotent credit path.
   - Check Vercel's cron frequency limits for the project's plan before counting on a 10–15 minute schedule. From memory, Hobby crons are limited to about once a day; I did not check this today. An external scheduler is the fallback.
4. QR: use SePay's `vietqr.app/img` (or `qr.sepay.vn/img`) with `bank=MB`, `amount` and `des=<code>`, or build the EMVCo string on the server. No img.vietqr.io needed. The deep link is optional.
5. No "saved card" UI. Card payments would need business documents and SePay's hosted page, and still cannot recur today.
