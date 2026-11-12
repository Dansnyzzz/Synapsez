# Pricing plan fact-check: provider prices, VND, Vietnamese tax, benchmark

Checked 2026-11-12. Every verdict comes from a page fetched today, unless it is marked **[inferred]** (my own arithmetic or reading) or **[secondary]** (a news or accounting site, not the official source).

Verdicts: **CONFIRMED**, **WRONG** (the right figure is given), **PARTLY WRONG**, **UNCONFIRMED**.

---

## Provider prices

### 1. Exa: Lite search $0.004 per search. CONFIRMED
Source: https://exa.ai/pricing (read)
- `/search` `lite` costs **$4 per 1k requests ($0.004)**. `instant` is also $4 per 1k and is a "legacy" type.
- `auto` and `fast` cost **$7 per 1k ($0.007)**.
- The base price covers up to 10 results. Each result above 10 costs $1 per 1k results. AI page summaries cost $1 per 1k pages, and are not listed for lite.
- Deep search: `deep-lite` $12 per 1k, `deep` **$12 per 1k ($0.012)**, `deep-reasoning` $15 per 1k (legacy).
- Contents (`/contents`): **$1 per 1k pages, per content type**. Text, highlights and summary are each billed separately.
- Answer costs $5 per 1k. Monitors cost $2 per 1k.
- Free credit: **"$10 in credits (up to 2,500 Lite searches) the day you sign up"**, and **"your free balance resets to $10 on the first of every month."** The free credit is therefore monthly, topped back up to $10.

### 2. Brave Search API: $0.005 per search. CONFIRMED (free-tier note PARTLY CONFIRMED)
Source: https://brave.com/search/api/ (read)
- Search costs **$5 per 1,000 requests ($0.005)** at 50 QPS. Answers costs $4 per 1k plus $5 per million tokens.
- Each plan says it **"Includes $5 in free credits every month"**, applied automatically. The page header says "Up to $20 in free calls every month", which the page does not reconcile with the $5 figure.
- Billing uses prepaid credits with no subscription. No free plan without billing is listed.
- Credit card: the FAQ asks "Why do you ask for a credit card?" and answers "To prevent abuse." A card is therefore requested.
- "No free tier since Feb 2026": the official page gives no date. Secondary sources say Brave removed the no-billing free plan for new users in February 2026 (https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/, https://alternativeto.net/news/2026/2/brave-updates-its-search-api-with-a-new-llm-context-endpoint-for-ai-and-new-pricing). **[secondary]**

### 3. Tavily: basic search $0.008, 1,000 free credits per month, advanced = 2 credits. CONFIRMED
Sources: https://tavily.com/pricing and https://docs.tavily.com/documentation/api-credits (both read)
- Pay as you go costs **$0.008 per credit**.
- Basic search costs **1 credit ($0.008)**. Advanced search costs **2 credits ($0.016)**.
- The free Researcher plan gives **1,000 credits per month** with no card.
- Extract: basic is 1 credit per 5 successful URLs, advanced is 2 credits per 5. Map is 1 credit per 10 pages, or 2 with instructions. Crawl costs map plus extract. Research is dynamic: pro 15–250 credits, mini 4–110.
- The Project plan shows "$30 / month, 4,000 credits". The slider markup was garbled, so treat this figure as approximate.

### 4. Firecrawl: search ≈ 0.2 credit per search. WRONG
Sources: https://www.firecrawl.dev/pricing and https://docs.firecrawl.dev/billing (both read)
- Search costs **2 credits per 10 results**, "Rounded up per 10 results (e.g., 11 results = 4 credits)". Each result that is also scraped adds its own scrape cost. The 0.2 figure is the cost per *result*, not per search. A normal search of up to 10 results costs 2 credits. **[inferred: 0.2 = 2 ÷ 10]**
- Scrape costs **1 credit per page**. CONFIRMED. Add-ons: JSON, query, highlights, audio and video formats each add 4 credits per page. PDF parsing adds 1 credit per PDF page. The enhanced proxy adds nothing.
- Crawl costs 1 credit per page. Map costs **1 credit per call**.
- Extract is not in the billing table. A docs guide calls it token-based (1 credit = 15 tokens) and tells new projects to use `/agent` instead. Agent cost is dynamic, with 5 free runs a day. Browser costs 2–7 credits per minute. **[the 15-token figure comes from a docs page found by search, not re-read]**
- Plans:
  - Free: $0, **1,000 credits per month**, 2 concurrent requests.
  - Hobby: $19 a month, or $16 a month billed yearly, for 5k credits.
  - **Standard: $99 a month, or $83 a month billed yearly ($990 a year), for 100k credits.**
  - Growth: $399 a month for 500k credits.
  - Scale: $749 a month for 1M credits.
- "Credit ≈ $0.00083 on Standard" is right **only on annual billing** ($990 ÷ 1.2M ≈ $0.000825). Monthly billing works out to **$0.00099**. Extra Standard credits cost 2,000 per $5, which is **$0.0025 per credit**. **[inferred arithmetic]**

### 5. E2B: 2 vCPU + 4 GiB ≈ $0.1656 per hour. Price CONFIRMED; concurrency WRONG
Source: https://e2b.dev/pricing (read)
- vCPU costs **$0.000014 per vCPU-second**. RAM costs **$0.0000045 per GiB-second**. "Running sandboxes are billed per second for provisioned CPU and RAM." Disk is free (10 GiB on Hobby).
- "The default sandbox has 2 vCPUs and 4 GiB of RAM." That costs 2×0.000014 + 4×0.0000045 = $0.000046 per second, which is **$0.1656 per hour**. At 25,744 VND per dollar that is ≈4,263 VND. **[inferred arithmetic; it matches the claim]**
- Hobby: $0, **"One-time $100 in usage credits"** (CONFIRMED), **"Up to 10 concurrently running sandboxes"** (**WRONG**: 10, not 20), and **up to 1 hour per sandbox session**.
- Pro: **$150 a month** plus usage, 100 concurrent sandboxes, 24-hour sessions. Enterprise has a $3,000 monthly minimum.

### 6. Supabase Pro. CONFIRMED, with caveats about compute
Source: https://supabase.com/pricing (read)
- "from $25/month", billed **per organization**.
- MAU: 100,000 included, then $0.00325 per MAU.
- Database disk: **8 GB per project**, then **$0.125 per GB**.
- File storage: **100 GB**, then **$0.0213 per GB**.
- Egress: **250 GB**, then **$0.09 per GB**. Cached egress: 250 GB, then $0.03 per GB.
- Compute: Pro includes **"$10/month in compute credits, which covers one Micro instance."** Micro costs $10 a month (1 GB RAM). Small costs $15 a month. **"Additional projects add their full compute cost."**
- So **$25 pays for one org with one Micro project**. Each extra project adds at least $10 a month. Moving the first project to Small adds about $5 a month. **[inferred from the quoted rules]**

### 7. Vercel Pro: Flat Rate CDN, bandwidth not metered. PARTLY WRONG
Sources: https://vercel.com/pricing, https://vercel.com/docs/pricing/flat-rate-cdn (last updated 2026-09-14), and https://vercel.com/changelog/flat-rate-cdn-is-now-ga-for-pro-teams (2026-09-08). All read.
- Pro costs **$20 a month per developer seat**. Viewer seats are unlimited. A **$20 included usage credit** is shared across resources.
- Flat Rate CDN is real. It reached GA on 2026-09-08 and is **"on by default" for new Pro teams**. Existing teams switch over in Billing.
- Pro includes the lowest tier: **1M CDN requests and 1 TB data transfer**. Higher tiers: $20 a month for 10M requests and 50 TB, $100 for 50M and 50 TB, $300 for 150M and 50 TB.
- The tier covers CDN requests, Fast Data Transfer, Blob and Sandbox transfer, and CDN observability events.
- "Not metered" is wrong. Usage is still measured. A one-day spike is served and not billed. **If a whole billing cycle exceeds capacity, Vercel moves the team to a higher tier at the start of the next cycle.** Above the top tier, usage goes on demand.
- Fair-use limits apply. Bulk file or media delivery and use as file hosting are out of scope.
- On-demand rates, used if Flat Rate CDN is off:
  - Fast Data Transfer: 1 TB included, then from $0.15 per GB.
  - CDN requests: 10M included, then from $2 per 1M.
- Functions are billed outside Flat Rate CDN:
  - **Invocations: from $0.60 per 1M** (CONFIRMED).
  - **Fluid Active CPU: from $0.128 per hour.**
  - **Provisioned memory: from $0.0106 per GB-hour.**
- Hobby: **"Our Hobby plan is for personal, non-commercial use."** CONFIRMED. A paid product cannot run on Hobby.

### 8. Claude Pro: $200 a year, $20 a month. CONFIRMED
Source: https://claude.com/pricing (read)
- "($200 billed up front)" with the annual discount, which is $17 a month. "$20 if billed monthly." Max starts at $100 a month.

### 9. Exchange-rate sources. CONFIRMED, with additions
Sources: https://www.exchangerate-api.com/docs/free (read), and live calls today to `open.er-api.com/v6/latest/USD` and the Vietcombank endpoints.
- open.er-api.com is **free with no API key**, and it **"Updates Once Per Day"**. The response gives `time_next_update`.
  - Today's response: last update Thu, 12 Nov 2026 00:02 UTC, next update Fri, 13 Nov 2026 00:19 UTC.
  - **Rate-limited.** It returns HTTP 429, and the block lifts after 20 minutes. The docs suggest caching, or at most one request an hour.
  - **Attribution is required** on pages that use the rates: `<a href="https://www.exchangerate-api.com">Rates By Exchange Rate API</a>`.
  - Personal and commercial conversion is allowed. **Redistributing the data is not.**
- Live **USD/VND = 25,655.85** (mid-market, open.er-api today).
- Vietcombank publishes two machine-readable feeds. Both returned today's data:
  - XML: `https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx?b=10`. It carries the comment `<!--For reference only. Only one request every 5 minutes!-->`. Timestamp 11/12/2026 6:40 PM. **USD buy 25,460, transfer 25,490, sell 25,870.**
  - JSON: `https://www.vietcombank.com.vn/api/exchangerates?date=2026-11-12`. Updated 2026-11-12T14:45+07:00, with the same USD figures.
  - Neither feed has published terms, so they are unofficial public endpoints. **[inferred]**
- The plan's 25,744 sits between the mid-market rate and VCB's sell rate. It is about 0.3% above mid-market and 0.5% below VCB sell. **[inferred]**

### 10. .com domain at 1.6–1.7 million VND a year. WRONG (about 3.5× too high)
- P.A Vietnam (https://www.pavietnam.vn/vn/ten-mien-bang-gia.html, read): .com registration and **renewal 459,000 VND a year, before VAT**. A 25,000 VND first-year promo applies to 3-year sign-ups.
- Search snippets **[secondary]**: Sapo 430,000 VND a year, Hostinger renewal 453,900 VND, Spaceship $9.98.
- A realistic figure is **about 430–500k VND a year before VAT**, roughly 4.5–5.5M VND for 10 years. Verisign raised the .com wholesale price on 2026-11-01 **[secondary]**, so retail may rise slightly.

---

## Vietnamese tax

Main official source: **Văn bản hợp nhất 12/VBHN-VPQH (Feb 2026)**, the consolidated VAT Law 48/2024/QH15 as amended by Nghị quyết 204/2025/QH15, Luật 90/2025/QH15 and Luật 149/2025/QH15. https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/02/12-vbhn-vpqh.pdf (downloaded and read)

### 11. Software is not subject to VAT under Law 48/2024 Art 5(21) and Decree 181/2025. Clause CONFIRMED; applying it to an AI chat subscription is DOUBTFUL; calling it "0%" is WRONG
- **Art 5 clause 21**, read verbatim: "Chuyển giao công nghệ theo quy định của Luật Chuyển giao công nghệ; chuyển nhượng quyền sở hữu trí tuệ theo quy định của Luật Sở hữu trí tuệ; **sản phẩm phần mềm và dịch vụ phần mềm theo quy định của pháp luật.**"
- **Decree 181/2025/NĐ-CP, Art 4 clause 13** (via https://hethongphapluat.com/nghi-dinh-181-2025-nd-cp-huong-dan-luat-thue-gia-tri-gia-tang/khoan-13-dieu-4, read): "...sản phẩm phần mềm và dịch vụ phần mềm theo quy định của **pháp luật về công nghệ thông tin, pháp luật về công nghiệp công nghệ số và pháp luật liên quan**." The plan should cite "Art 4 clause 13", not just "Decree 181".
- **Does an AI chat subscription count as a "dịch vụ phần mềm"? Probably not, on current rulings:**
  - **Thuế cơ sở 6 TP Hà Nội** (reported by VietNamNet, 25/05/2026) ruled that **"các gói dịch vụ ChatGPT của OpenAI và ứng dụng trí tuệ nhân tạo (AI) không phải dịch vụ phần mềm"**. If they are not goods or services under Art 4 or Art 19 of Decree 181, **10% VAT applies**. The ruling quotes Decree 71/2007 Art 3(10): software service is "hoạt động trực tiếp hỗ trợ, phục vụ việc sản xuất, cài đặt, khai thác, sử dụng, nâng cấp, bảo hành, bảo trì phần mềm...". Source: https://www.vietnam.vn/co-quan-thue-chatgpt-khong-duoc-xem-la-dich-vu-phan-mem-de-mien-vat, original at https://vietnamnet.vn/co-quan-thue-chatgpt-khong-duoc-xem-la-dich-vu-phan-mem-de-mien-vat-2517826.html (read).
  - **Thuế tỉnh Quảng Trị, Công văn 5854/QTR-CNTK (22/10/2026)** says it depends on whether the item meets the IT and digital-technology-industry definitions, and the decision is **"không chỉ căn cứ vào tên gọi"**. It cites Law 71/2025/QH15 Arts 2 and 13. https://thuehaiquan.tapchikinhtetaichinh.vn/san-pham-dich-vu-phan-mem-nao-khong-chiu-thue-gia-tri-gia-tang-170993.html (read)
  - Decree 71/2007 is reported as **replaced by Decree 353/2025/NĐ-CP from 01/01/2026**. Law 71/2025 reportedly frames this as "cung cấp dịch vụ công nghệ số" (Art 13(3)). **[secondary, not read in the official text]**
  - Both rulings answer individual taxpayers, so neither binds generally. Still, the only ruling on AI chat itself says **taxable at 10%** (8% until end-2026). **The plan should not assume it is not subject to VAT** without its own ruling.
- **"0%" is a different legal category from "not subject" (KCT):**
  - KCT (Art 5): no output VAT. Input VAT is generally not deductible. The invoice is marked KCT.
  - 0% (Art 9.1): for exports. Input VAT can be credited and refunded.
  - The plan's "0%" label is wrong for domestic sales.
  - The law does let KCT goods and services use **0% when exported** (Art 9.1(c): "hàng hóa, dịch vụ thuộc đối tượng không chịu thuế giá trị gia tăng khi xuất khẩu"), except for the list in Art 9.1(d).

### 12. 8% VAT until 31/12/2026 under Res 204/2025/QH15, 10% from 01/01/2027. CONFIRMED (the 2027 part is inferred)
- Consolidated text, read: Nghị quyết 204/2025/QH15 of 17/6/2025 is **in force from 01/07/2025 to 31/12/2026**. It cuts 2 points from the Art 9(3) 10% rate, **"(còn 8%)"**.
- Excluded from the cut: viễn thông, hoạt động tài chính, ngân hàng, chứng khoán, bảo hiểm, kinh doanh bất động sản, sản phẩm kim loại, sản phẩm khai khoáng (trừ than), and hàng hóa/dịch vụ chịu thuế TTĐB (trừ xăng).
- IT is not on that list. Secondary sources say Decree 174/2025 dropped the old IT exclusion annex. **[secondary]**
- Standard rate is **10%** (Art 9(3)). This includes services that foreign suppliers deliver into Vietnam over digital platforms.
- From 01/01/2027 the rate returns to 10% **[inferred]**. Res 204 expires then, and I found no extension (search today).
- **If the seller is a household:** households use the **direct method**, a percentage of revenue. For services that is **5%** (Art 12(2)(b2), read). The 8%/10% rate does not apply to them. Decree 174 reportedly cuts the direct-method percentage by 20%. **[UNCONFIRMED]**

### 13. Households at or below 1 billion VND a year are exempt from VAT and PIT from 01/01/2026 (Decree 141/2026/NĐ-CP). CONFIRMED
- **Decree 141/2026/NĐ-CP, 29/4/2026**, amends Decree 68/2026/NĐ-CP (household tax) and Decree 320/2025/NĐ-CP (CIT). It changes "500 triệu đồng" to **"01 tỷ đồng"** in Art 3 (VAT) and Art 4 (PIT) of Decree 68. It is **"có hiệu lực thi hành từ ngày 01/01/2026"**, so it is retroactive. Households at or below 1 billion that already paid get the tax handled back.
  - https://baochinhphu.vn/chinh-thuc-nang-nguong-chiu-thue-voi-ho-kinh-doanh-len-01-ty-dong-nam-ap-dung-tu-1-1-2026-102260429185517215.htm (read)
  - https://xaydungchinhsach.chinhphu.vn/nghi-dinh-so-141-2026-nd-cp-quy-dinh-moi-ve-chinh-sach-thue-doi-voi-ho-kinh-doanh-doanh-nghiep-119260430091642895.htm (read)
  - https://pbgdpl.cantho.gov.vn/mot-so-quy-dinh-cua-nghi-dinh-so-1412026nd-cp-ngay-2942026-cua-chinh-phu (read)
- How it got there:
  - Law 149/2025/QH15 had set **500 million** from 01/01/2026. The consolidated text still shows that figure.
  - On 24/4/2026 the National Assembly passed the law amending 4 tax laws. Secondary sources number it **Luật 09/2026/QH16**. It **delegated the threshold to the Government**. https://hatinh.gov.vn/vi/bai-viet/quoc-hoi-chot-bo-nguong-chiu-thue-500-trieu-dong-voi-ho-kinh-doanh (read; the law number is **[secondary]**)
  - Decree 141 then set 1 billion.
- Decree 141 also **exempts from CIT any enterprise with total annual revenue of 1 billion VND or less**.

### 14. Exported services to foreign customers are 0% VAT. CONFIRMED with conditions; an online subscription to an individual is UNCERTAIN
- **Law, Art 9.1(b)** (read): "dịch vụ cung cấp trực tiếp cho tổ chức, cá nhân ở nước ngoài và được **tiêu dùng ở ngoài Việt Nam**".
- **Decree 181/2025 Art 17(2):** for a foreign *individual*, the service counts as exported **only if the person is outside Vietnam while the service is provided**.
- **Art 18(2)** has two conditions: (a) **"Hợp đồng cung cấp dịch vụ với tổ chức, cá nhân ở nước ngoài..."** and (b) **"Chứng từ thanh toán không dùng tiền mặt"**. Both via hethongphapluat.com Arts 17 and 18 (read).
- Art 9.1(d) lists cases that never get 0%. It **includes "dịch vụ bưu chính, viễn thông"** and technology transfer or IP transfer abroad. It does not list software.
- A HCMC ruling (Thuế cơ sở 16, VCCI 14/07/2026) says a household that develops software for foreign clients and is paid by bank transfer gets **0% if those conditions are met**. https://www.vcci.com.vn/tin-tuc/ho-kinh-doanh-xuat-khau-phan-mem-nop-thue-gia-tri-gia-tang-the-nao (read)
- A foreign individual buying an online subscription qualifies in principle. The plan would need proof that the buyer was outside Vietnam during use (billing country or IP), a contract (whether click-through terms count is untested), and a card or bank payment. Without that evidence, 10%/8% is the safe default. **[inferred]**
- Under Decree 254/2026, households selling **digital content services to foreign organisations or individuals are exempt from issuing invoices**. Source: EY summary, item 16.
- A household at or below 1 billion VND is outside VAT entirely, so the question does not arise for it.

### 15. CIT: 20% standard, 15%/17% tiers, 30% cut for 2026–2027 at 10 billion or less. CONFIRMED
- **Law 67/2025/QH15** (from 01/10/2025, applies from tax period 2025):
  - Standard rate **20%**.
  - **15% for revenue up to 3 billion VND**.
  - **17% for revenue above 3 billion up to 50 billion**.
  - Subsidiaries and affiliates of related parties that do not qualify are excluded.
  - Source: https://pbgdpl.cantho.gov.vn/diem-moi-cua-luat-thue-thu-nhap-doanh-nghiep-2025 (read). The 15/17% tiers are measured on the previous year's revenue per MISA. **[secondary]**
- **30% cut:**
  - The National Assembly resolution was passed and took effect on 24/08/2026: https://lsvn.vn/chinh-thuc-giam-30-thue-thu-nhap-cho-ca-nhan-kinh-doanh-doanh-nghiep-trong-ky-tinh-thue-2026-2027-a178093.html (read). Its number, **Nghị quyết 43/2026/QH16**, is **[secondary]**.
  - It is detailed by **Decree 398/2026/NĐ-CP of 29/10/2026**: https://pbgdpl.cantho.gov.vn/quy-dinh-ve-giam-thue-thu-nhap-ca-nhan-thue-thu-nhap-doanh-nghiep-doi-voi-ca-nhan-va-doanh-nghiep (read).
  - It cuts **30% of CIT payable** for tax years 2026 and 2027 for enterprises with annual revenue of 10 billion VND or less. It also cuts **30% of PIT on business income** for resident business individuals and households under the same cap.
  - If revenue turns out above 10 billion, the cut is repaid. Enterprises formed by splitting are excluded when their combined revenue exceeds 10 billion.
- Also: enterprises at or below 1 billion VND are **CIT-exempt** under Decree 141/2026 (item 13).

### 16. E-invoices for households under Decree 70/2025 amending Decree 123/2020. OUTDATED
- **Decree 254/2026/NĐ-CP of 30/6/2026, in force from 01/07/2026, replaces Decree 123/2020 and Decree 70/2025.** It comes with Circular 91/2026/TT-BTC.
  - EY: https://www.ey.com/vi_vn/technical/tax/tax-and-law-updates/nghi-dinh-254-2026-nd-cp-ve-hoa-don-dien-tu-va-chung-tu-dien-tu (read)
- Current household rule. Source: Cục Thuế Công văn 5131/CT-CS of 23/7/2026, citing **Decree 254 Art 6(1)(d)**: https://xaydungchinhsach.chinhphu.vn/huong-dan-su-dung-hoa-don-dien-tu-voi-ho-kinh-doanh-co-doanh-thu-duoi-1-ty-dong-nam-119260727150121544.htm (read). The rule:
  - Households above 1 billion VND a year **must use e-invoices**, either **with a tax-authority code** or **generated from a cash register connected to the tax authority**. Decree 141/2026 adds that a household crossing 1 billion mid-year must register within 30 days after the period ends.
  - Households at or below 1 billion **may** register voluntarily.
- EY: under Decree 254, cash-register invoices are **"không bắt buộc"**. A seller to consumers may keep its registered invoice form.
- So no revenue threshold makes a cash-register invoice compulsory now. Above 1 billion, either form of e-invoice is compulsory.
- The old Decree 70/2025 rule required cash-register e-invoices for households at 1 billion or more selling directly to consumers in listed sectors, from 01/06/2025. That rule is superseded. **[secondary]**
- Per-sale timing under Decree 254: invoices are issued when the sale completes. Platform services may issue after reconciling with the customer (EY). The exact household per-sale wording is **UNCONFIRMED**.

---

## Benchmark

### 17. OpenAI/NBER "How People Use ChatGPT" (Sept 2025): 700M weekly users, 18B messages a week, coding 4.2%. CONFIRMED
Source: NBER Working Paper **34255**, issued September 2025, by Chatterji, Cunningham, Deming, Hitzig, Ong, Shan and Wadman. https://www.nber.org/papers/w34255; the PDF was downloaded and read.
- Text: "By July 2025, **18 billion messages were being sent each week by 700 million users**, representing around 10% of the global adult population."
- Text: "**only 4.2% of ChatGPT messages are related to computer programming**, compared to 33% of work-related Claude conversations".
- Caveat: these are **consumer plans only** (Free, Plus, Pro). Business, Enterprise and Education plans are excluded. The figure is a share of messages, not of users.
