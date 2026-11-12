# Per-key plan and usage: what each provider exposes (researched 2026-11-12)

Legend:
- **READ** means taken from the provider's official docs page, fetched today.
- **PROBED** means seen live today from a request made with an obviously fake key. No real keys or secrets were used, and the fake-key calls cost nothing.
- **INFERRED** means my reading or a third-party source. Not confirmed by the provider.

---

## 1. Exa (exa.ai)

**(a) Usage endpoint**
- READ: the Team Management API has usage data, but it needs a **service key**, not a normal key. Spec: https://exa.ai/docs/team-management-spec.yaml
  - Base URL: `https://admin-api.exa.ai/team-management`
  - Auth: `x-api-key: <SERVICE KEY>`.
  - A service key exists only after support@exa.ai enables Team Management for the team. It is then created under the "Service keys" tab. The service key must belong to the same team as the key you query. Source: https://exa.ai/docs/reference/team-management/get-api-key-usage.md
  - `GET /api-keys/{publicId}/usage?start_date=&end_date=`
    - Defaults to the last 30 days. `start_date` must be within 180 days, otherwise 400.
    - Response fields: `id` (publicId), `api_key_id` (despite the name, this holds the secret), `api_key_name`, `team_id`, `period.start`, `period.end`, `total_cost_usd`, `cost_breakdown[]` (`price_id`, `price_name`, `quantity`, `amount_usd`), `metadata.generated_at`.
    - Errors: 400 bad params, 401 bad service key, 404 key not found, 500.
  - `GET /credits` returns `credits_usd`, `expiring_credits[]` (`amount_usd`, `expires_at`) and `metadata.generated_at`.
  - Key objects carry `rateLimit` (QPS), `budgetCents` (budget for the current billing period) and `isOverBudget`.
  - The rate limit of the admin API is not documented.
- READ: billing docs say the balance is on the dashboard (https://dashboard.exa.ai/billing). The plain API has no balance endpoint. Source: https://exa.ai/docs/reference/billing
- READ: `GET https://api.exa.ai/websets/v0/teams/me` takes a normal key (`x-api-key` or `Authorization: Bearer`).
  - It returns only `object`, `id`, `name`, `concurrency.{active,queued}` and `limits.{maxConcurrent,maxQueued}`.
  - It has no credits or plan fields (the schema sets `additionalProperties:false`).
  - The docs do not say whether it is billed. Source: https://exa.ai/docs/websets/api/teams/get-team-info.md
  - PROBED: the docs' `/v0/teams/me` path returns 404. The working path is `/websets/v0/teams/me`.

**(b) Usage in normal responses**
- READ: every `/search` response carries `costDollars`. Source: https://exa.ai/docs/reference/search.md
  - `total`: "Estimated total dollar cost… not an invoice record"
  - `search.{neural,keyword}`
  - `summary`
  - `contents.{text,highlights,summary}`
- READ: response headers are `x-request-id`, `x-exa-queued` and `x-exa-queue-ms`. There are no remaining-credit or rate-limit quota headers. A 429 may carry `Retry-After`. Source: https://exa.ai/docs/reference/rate-limits.md
- INFERRED: for a free key, count spend locally by adding up `costDollars.total` against the $10 monthly grant. A 402 tells you the credits ran out.

**(c) Cheapest validation**
- PROBED: `GET https://api.exa.ai/websets/v0/teams/me` with a bad key returns 401 `{"requestId","error":"Invalid API key…","tag":"INVALID_API_KEY"}`.
- INFERRED: this call is free, because it only reads team metadata. The docs don't say either way.

**(d) Free allowance and errors**
- READ: $10 in credits every month, reset "on the first day of every calendar month". Unused credits don't roll over. Source: https://exa.ai/docs/reference/billing
  - A one-time $10 onboarding bonus also exists and does not expire.
  - **Only a user's first team gets the monthly grant.**
  - Free tier rate limit: 10 QPS (5 QPS for deep search).
- READ error codes (https://exa.ai/docs/reference/error-codes.md):
  - The body is always `{requestId, error, tag}`.
  - Invalid key: 401 `INVALID_API_KEY`.
  - Credits gone: 402 `NO_MORE_CREDITS`.
  - Budget hit: 402 `API_KEY_BUDGET_EXCEEDED` (key) or `TEAM_BUDGET_EXCEEDED` (team).
  - Rate limited: 429 `RATE_LIMIT_EXCEEDED`, with `Retry-After` when present. Agent runs use 429 `CONCURRENCY_LIMIT_REACHED`.

---

## 2. Tavily

**(a) Usage endpoint**
- READ: yes, `GET https://api.tavily.com/usage`. Source: https://docs.tavily.com/documentation/api-reference/endpoint/usage.md
  - Auth: `Authorization: Bearer tvly-…`. Optional header `X-Project-ID`.
  - `key` fields:
    - `usage` (credits used by this key this billing cycle)
    - `limit` (`null` means unlimited)
    - `search_usage`, `extract_usage`, `crawl_usage`, `map_usage`, `research_usage`
  - `account` fields:
    - `current_plan` (string, e.g. "Bootstrap")
    - `plan_usage`, `plan_limit`
    - `paygo_usage`, `paygo_limit`
    - the same `*_usage` breakdown as `key`
  - Sample from the spec: `{"key":{"usage":150,"limit":1000,"search_usage":100,…},"account":{"current_plan":"Bootstrap","plan_usage":500,"plan_limit":15000,"paygo_usage":25,"paygo_limit":100,…}}`
  - Rate limit: **10 requests per 10 minutes**, separate from the normal limit and the same for dev and prod keys. Source: https://docs.tavily.com/documentation/rate-limits.md
  - The docs don't say whether the call costs credits. INFERRED: it is free.
  - INFERRED: remaining = `plan_limit - plan_usage`, or `key.limit - key.usage` when the key has a limit.

**(b)** Not needed, because the endpoint above exists.

**(c) Cheapest validation**
- `GET /usage` itself.
- PROBED: a bad key returns 401 `{"detail":{"error":"Unauthorized: missing or invalid API key."}}`.
- Mind the 10-per-10-minutes cap: cache the result.

**(d) Free allowance and errors**
- READ: the Researcher (free) plan gets 1,000 credits per month with no card. Source: https://docs.tavily.com/documentation/api-credits.md
  - Basic search costs 1 credit and advanced search 2.
  - Extract costs 1 credit per 5 URLs (2 for advanced).
- READ: credits "reset on the first day of each month, regardless of the billing date". Source: https://help.tavily.com/articles/3116968635
- READ: free rate limit is 100 RPM, and all keys in an account share it.
- READ errors (https://help.tavily.com/articles/8645538886-understanding-http-errors):
  - 401 "Unauthorized: missing or invalid API key"
  - **432** Plan Limit Exceeded: "This request exceeds your plan's set usage limit…"
  - **433** Pay-As-You-Go Limit Exceeded
  - 429: "Your request has been blocked due to excessive requests…", with `Retry-After` in seconds
  - 434: Flex tier capacity exceeded

---

## 3. Brave Search API

**(a) Usage endpoint**
- READ: none. "Usage and remaining credits are visible in the dashboard at any time." The Credits balance tab shows balance and spend per plan. Source: https://api-dashboard.search.brave.com/documentation/resources/help-feedback/index.html.md

**(b) Headers on every response**
- READ (https://api-dashboard.search.brave.com/documentation/guides/rate-limiting/index.html.md). Each header has two values, one for the per-second window and one for the monthly window:
  - `X-RateLimit-Limit: 1, 15000`. A monthly value of **0 means unlimited**.
  - `X-RateLimit-Policy: 1;w=1, 15000;w=2592000`. Windows are in seconds.
  - `X-RateLimit-Remaining: 1, 1000`
  - `X-RateLimit-Reset: 1, 1419704`. These are seconds until each window resets, not timestamps.
  - "Only successful requests (non-error responses) are counted against your quota and billed."
- INFERRED: on today's credit-billed plans the monthly value is probably 0 (unlimited), so the headers would not show $ left. Check the first live response. Remaining $ is then counted locally: requests × $5/1,000 against the $5 grant.

**(c) Cheapest validation**
- There is no free endpoint.
- PROBED: `GET https://api.search.brave.com/res/v1/web/search?q=test&count=1` with header `X-Subscription-Token` and a bad key returns **422** `{"type":"ErrorResponse","error":{"status":422,"detail":"The provided API key is invalid.","meta":{"component":"authentication"},"code":"SUBSCRIPTION_TOKEN_INVALID"}}`.
- A bad key is not billed, because only successful requests are. A good key costs one request (about $0.005 of the $5 credit).

**(d) Free allowance and errors**
- READ: each plan (Search, Answers, …) includes **$5 in free credits that "renews every single month"** and is "replaced each month rather than carried over". Source: help-feedback page above.
  - Search plan: $5 per 1,000 requests, 50 QPS.
  - Answers plan: $4 per 1,000 plus $5 per million tokens, 2 QPS.
  - A card is required "to prevent abuse". Source: https://brave.com/search/api/
  - The hero text says "up to $20 in free calls", INFERRED to mean $5 × several plans.
  - The reset date (1st or anniversary) is **not stated**.
- READ: when credits run out, "your service will be paused — further API requests are rejected until you add more funds". The status code is not documented.
- READ: rate limited returns 429.
- INFERRED (third-party): error codes are `RATE_LIMITED` and `QUOTA_LIMITED`.

---

## 4. Firecrawl

**(a) Usage endpoints**
- READ: `GET https://api.firecrawl.dev/v2/team/credit-usage`, with `Authorization: Bearer fc-…`. Source: https://docs.firecrawl.dev/api-reference/endpoint/credit-usage
  - Response: `{"success":true,"data":{"remainingCredits":1000,"planCredits":500000,"billingPeriodStart":"…","billingPeriodEnd":"…"}}`
  - The fields are camelCase. There is no `remaining_credits`.
  - `planCredits` "does not include coupon credits or credits added by pay-as-you-go".
  - Both period dates can be null.
  - Errors: 404 "Could not find credit usage information", 500.
  - The docs don't say whether the call costs credits or what its rate limit is. INFERRED: it is free.
- READ: `GET /v2/team/credit-usage/historical?byApiKey=true` returns `{"success":true,"periods":[{"startDate","endDate","apiKey"(name or null),"totalCredits"}]}`.
- READ: `GET /v2/team/queue-status` returns `jobsInQueue`, `activeJobsInQueue`, `waitingJobsInQueue`, `maxConcurrency`, `mostRecentSuccess`.
- INFERRED (SDK source, no docs page read): `GET /v2/team/token-usage` returns remaining tokens, plan tokens and billing-period dates. It is legacy, for Extract.

**(c) Cheapest validation**
- `GET /v2/team/credit-usage`.
- PROBED: a bad key returns 401 `{"success":false,"error":"Unauthorized: Invalid token"}`.

**(d) Free allowance and errors**
- READ: the free plan gets **1,000 credits per month**, refreshed monthly, with no card. Sources: https://www.firecrawl.dev/pricing and https://docs.firecrawl.dev/billing
  - The free allotment resets "at the start of each monthly cycle". The docs don't say whether that is the 1st or the signup date, so use `billingPeriodEnd`.
  - Credits don't roll over.
  - INFERRED (third-party): earlier in 2026 the free plan was 500 one-time credits.
- READ: free plan rate limits are /scrape 10 RPM, /search 10, /map 10, /crawl 2, /agent 2, with 2 concurrent browsers. Source: https://docs.firecrawl.dev/rate-limits
- READ errors (https://docs.firecrawl.dev/api-reference/errors):
  - 401 "Unauthorized: Invalid token"
  - **402** "Payment Required: Insufficient credits". Not retryable. Free plans get it until the monthly reset.
  - 429 "Rate limit exceeded" or "Concurrency limit reached", with `Retry-After`
  - The index daily limit gives 429 `INDEX_DAILY_LIMIT` with `limit`, `used`, `resetsAt` (00:00 UTC) and `upgradeUrl`.

---

## 5. E2B

**(a) Usage endpoint**
- READ: none for credits or spend. "Check usage and costs in the console usage tab" (https://console.e2b.dev/?tab=usage). Source: https://docs.e2b.dev/billing.md
- READ: I downloaded and searched the full OpenAPI spec (https://docs.e2b.dev/openapi-public.yaml). It has no credit, billing or budget path.
- READ: `GET https://api.e2b.app/teams/{teamID}/metrics?start=&end=` (`X-API-Key`) returns only `timestampUnix`, `concurrentSandboxes` and `sandboxStartRate`.
- Note: the API host is `api.e2b.app`.

**(b) Usage in responses**
- READ: `GET /v2/sandboxes` returns the headers `X-Total-Running` and `X-Next-Token`.
- READ: a 429 returns `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.
- INFERRED: spend has to be counted locally as sandbox-seconds × the per-second price.

**(c) Cheapest validation**
- `GET https://api.e2b.app/v2/sandboxes?limit=1` with `X-API-Key`. It only lists sandboxes, so it is free.
- PROBED: a bad key returns 401 `{"code":401,"message":"Invalid API key, please visit https://docs.e2b.dev/api-key …"}`.

**(d) Free allowance and errors**
- READ: the Hobby plan gets **$100 one-time**, not monthly. Limits: 10 concurrent sandboxes, 1-hour max continuous runtime, 1 sandbox created per second. Source: https://docs.e2b.dev/billing.md
- READ: the API rate limit is 10 req/s per endpoint per project. Over the limit you get 429 with `Retry-After`.
- READ: if credits run out with no card, "every project in your workspace is blocked". The status code is not documented.
- READ: the spec has 403 examples `{"code":403,"message":"team is blocked"}` and `"team is banned"`.
- INFERRED: the blocked-team 403 is what a key gets after its credits run out.

---

## 6. Google Gemini API key (Grounding with Google Search)

**(a) Usage endpoint**
- READ: none for an API key. "Rate limits are applied per project, not per API key." You view limits on the AI Studio rate-limit page, and the docs mention no API for it. Source: https://aistudio.google.com/docs/rate-limits
  - **So five keys from the same project share one quota.** Each key needs its own project (in practice its own account) to count separately.
  - RPD resets at midnight Pacific.

**(b) Usage in responses**
- READ: the body has `usageMetadata.{promptTokenCount, candidatesTokenCount, toolUsePromptTokenCount, thoughtsTokenCount, totalTokenCount}` and `candidates[].groundingMetadata.{webSearchQueries, groundingChunks, searchEntryPoint, groundingSupports}`. There is no quota or remaining field. Source: https://aistudio.google.com/api-reference/generate-content
- READ: Gemini 3+ is billed per executed search query, so count `webSearchQueries.length`. Gemini 2.5 is billed per prompt. Source: https://aistudio.google.com/docs/google-search

**(c) Cheapest validation**
- `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1` with `x-goog-api-key`.
- PROBED: a bad key returns **400** `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID",…}]}}`.
- INFERRED: models.list uses no generation quota.

**(d) Free grounding quota and errors**
- READ (https://aistudio.google.com/docs/pricing):

| Model | Grounding on the free tier | Grounding on the paid tier |
|---|---|---|
| `gemini-2.5-flash`, `gemini-2.5-flash-lite` | "Free of charge, up to 500 RPD", shared between the two | 1,500 RPD free, then $35 per 1,000 grounded prompts |
| `gemini-3.8-flash`, `3.6-flash`, `3.5-flash-lite`, `3.1-flash-lite`, `3-flash-preview` | **"Not available"** | "5,000 free search requests per month (shared across all Gemini 3 and newer models)", then $14 per 1,000, with a 1,500 RPD cap |

- READ: **`gemini-2.5-flash` is deprecated. "Effective December 1, 2026, all API requests to `gemini-2.5-flash` will automatically route to" `gemini-3.5-flash-lite`.**
- INFERRED: from that date, a free key will likely lose Google Search grounding.
- READ errors:
  - 429 `RESOURCE_EXHAUSTED`. Codes `rate_limit_exceeded` (per minute) and `quota_exceeded` (daily). Sources: https://aistudio.google.com/docs/api-errors and the rate-limits page
  - 402 `payment_required` when Prepay credits run out
  - 403 `permission_denied` for a leaked or blocked key
  - The new error table lists 401 `authentication` for an invalid key. The v1beta REST API actually returns 400 `API_KEY_INVALID` (PROBED).

---

## 7. Stack Exchange API

**(a) Usage endpoint**
- There is none. Every response wrapper carries the quota instead.
- READ: wrapper fields are `quota_max`, `quota_remaining`, `backoff` (may be absent), `error_id`, `error_name`, `error_message`, `has_more`, `items`, `page`, `page_size`, `total` and `type`. Source: https://api.stackexchange.com/docs/wrapper (fetched with curl)

**Per key or per IP**
- READ (https://api.stackexchange.com/docs/throttle):
  - Without an access_token, "the application shares an IP based quota with all other applications on that IP… it is the max of the daily request limit for the applications involved, which by default is 10,000."
  - With an access_token, the quota is per user/app pair, 10,000 a day.
  - Over 30 req/s from one IP gets you dropped for about 30 s to a few minutes.
  - `backoff` means you must wait N seconds before calling that method again.
- **So a key raises the IP's quota to 10,000. It is not a per-key bucket, and five keys on one IP don't add up.**
  - INFERRED: Vercel's egress IPs are shared across many apps, so `quota_remaining` reflects the IP, not your key.
  - READ: the docs' fix for shared hosting is a `no_expiry` user access token. Source: https://api.stackexchange.com/docs/authentication
- READ: the 2025 auth change says to send the key or token as `Authorization: Bearer {API key or access token}`.
- PROBED: the old `key=` query parameter is still parsed.
- PROBED: without a key, `quota_max` was 300 for this IP.

**(c) Cheapest validation**
- There is no free call; each one costs 1 of the 10k quota. Use `GET https://api.stackexchange.com/2.3/info?site=stackoverflow`.
- PROBED: a bad `key=` returns HTTP 400 `{"error_id":400,"error_message":"`key` doesn't match a known application","error_name":"bad_parameter"}`.
- PROBED: a bad Bearer value returns HTTP 400 `{"error_id":402,"error_message":"does not exist","error_name":"invalid_access_token"}`.

**(d) Allowance and errors**
- 10,000 requests a day with a key, 300 without.
- The reset time isn't documented. INFERRED: midnight UTC.
- READ: the HTTP status is 400 for every error, and `error_id` carries the meaning: 502 `throttle_violation`, 400 `bad_parameter`, 503 `temporarily_unavailable`. Source: https://api.stackexchange.com/docs/error-handling

---

## 8. CoinGecko Demo API

**(a) Usage endpoint**
- READ: `GET https://pro-api.coingecko.com/api/v3/key` with `x-cg-pro-api-key`. Source: https://docs.coingecko.com/reference/api-usage
  - "only available to **Basic, Analyst, Lite, Pro, and Enterprise** plan", so **not Demo**.
  - Fields: `plan`, `rate_limit_request_per_minute`, `monthly_call_credit`, `current_total_monthly_calls`, `current_remaining_monthly_calls`, `api_key_rate_limit_request_per_minute`, `api_key_monthly_call_credit`, `api_key_current_total_monthly_calls`.
- PROBED: `api.coingecko.com/api/v3/key` and the pro host both return 401 10002 for a demo-style key.
- READ: Demo users check usage in the Developer Dashboard.
- **For Demo keys, count locally.** READ: "Each successful request (HTTP 200) deducts 1 credit". Source: https://docs.coingecko.com/demo/reference/authentication.md

**(b) Headers**
- READ: nothing is documented.
- PROBED: `/ping` returned no rate-limit headers.

**(c) Cheapest validation**
- `GET https://api.coingecko.com/api/v3/ping` with header **`x-cg-demo-api-key`** (or the query parameter `x_cg_demo_api_key`).
- PROBED: a bad key returns HTTP 401 `{"status":{"error_code":10002,"error_message":"API Key Missing. …"}}`.
- A valid key costs 1 credit (INFERRED from the "each successful request" rule).

**(d) Free allowance and errors**
- READ (https://www.coingecko.com/en/api/pricing):
  - 10k credits per month and 100 calls per minute. Attribution is required.
  - "Regardless of your billing cycle, your requests are counted from the first day of the month to the last", so the reset is on the 1st. The timezone isn't stated.
- READ errors (https://docs.coingecko.com/docs/common-errors-rate-limit):
  - 401 missing or invalid key
  - 429 rate limit (4xx and 5xx responses count toward it)
  - 10002 key missing
  - 10005 plan restricted
  - 10010 or 10011 wrong key type for the host
- The response when the monthly cap is used up is **not documented**.

---

## 9. FRED (St. Louis Fed)

**(a) Usage endpoint**
- READ: none. Sources: https://fred.stlouisfed.org/docs/api/api_key.html and https://fred.stlouisfed.org/docs/api/terms_of_use.html
- The terms reserve the right to cap bandwidth or transactions.

**(b) Headers**
- PROBED: no rate-limit headers.

**(c) Cheapest validation**
- `GET https://api.stlouisfed.org/fred/category?category_id=0&file_type=json&api_key=…` (free).
- PROBED: a bad key returns HTTP 400 `{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered.  …"}`.

**(d) Allowance and errors**
- The service is free with no monthly quota.
- READ: "429 Too Many Requests (Up to 120 requests per minute are allowed before being served a 429 error code.)". Ignoring the throttling can cause a temporary block. Source: https://fred.stlouisfed.org/docs/api/fred/errors.html
- INFERRED (third-party): the limit is per key.
- The key is a 32-character lowercase alphanumeric string.

---

## 10. Resend

**(a) Usage endpoint**
- READ: **new on 2026-10-01**: `GET https://api.resend.com/usage`, `Authorization: Bearer re_…`. Sources: https://resend.com/docs/api-reference/usage/retrieve-usage.md and https://resend.com/changelog/account-usage-api.md
  - Sample response: `{"object":"usage","emails":{"daily":{"used","limit","sent","received","resets_at"},"monthly":{…same…}},"contacts":{"used","limit"},"segments":{…},"broadcasts":{…},"ai_credits":{"used","limit","next_increase_at"},"automation_runs":{"used","limit","resets_at"},"domains":{"used","limit"},"rate_limit":{"limit","duration":"1000ms"}}`
  - There is no `remaining` field; compute `limit - used`.
  - `emails.daily.limit` is null on a paid sending plan.
  - The docs describe `daily` as a "rolling 24 hours" and `monthly` as a calendar month.
  - Errors aren't documented, and the docs don't say whether a sending-only key works here.

**(b) Headers**
- READ (https://resend.com/docs/api-reference/rate-limit):
  - `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` (seconds) and `retry-after`
  - `x-resend-daily-quota`: used daily quota, sent to the free plan only
  - `x-resend-monthly-quota`: used monthly quota

**(c) Cheapest validation**
- `GET /usage`.
- PROBED: a bad key returns HTTP 400 `{"statusCode":400,"message":"API key is invalid","name":"validation_error"}`.
- READ: on the send endpoints a bad key gives 401 `validation_error` instead.
- READ: a sending-only key on non-send endpoints gives 401 `restricted_api_key`. That means the key is valid but can't read usage.

**(d) Free allowance and errors**
- READ: **100 emails a day and 3,000 a month.** Received email counts, and every To, Cc and Bcc recipient counts as one. Source: https://resend.com/docs/knowledge-base/account-quotas-and-limits
  - The daily quota resets at midnight UTC.
  - Monthly is a calendar month, so it resets on the 1st (`resets_at`).
  - The free plan allows 3 domains. Rate limit: 10 req/s per team, no burst.
- READ: there is a conflict. The quotas page says the daily quota resets at midnight UTC, while the usage page calls it "rolling 24 hours".
- READ errors (https://resend.com/docs/api-reference/errors):
  - 429 `daily_quota_exceeded`, `monthly_quota_exceeded` and `rate_limit_exceeded`
  - 401 `missing_api_key`
  - 403 `suspended_api_key`

---

## 11. TheSportsDB

**(a) and (b) Usage data**
- READ: there is no usage endpoint or header. Source: https://www.thesportsdb.com/documentation
- PROBED: the 200 response has no rate-limit headers.

**(c) Cheapest validation**
- v1 puts the key in the path: `GET https://www.thesportsdb.com/api/v1/json/{KEY}/all_sports.php`.
- v2 (premium only) takes the header `X-API-KEY`: `GET https://www.thesportsdb.com/api/v2/json/all/sports`.
- PROBED: a bad key returns HTTP 400 `{"Message":"Invalid Premium API key: Signup here: https://www.thesportsdb.com/pricing"}` on both v1 and v2.

**(d) Allowance and errors**
- READ: the **free key is the public shared `123`**, so there is nothing to sign up for. It allows 30 req/min, and "most queries [are] limited" (for example, search returns 1 result and the day schedule 3).
  - Premium Single Developer: $9/mo, 100 rpm, livescores, v2, highlight links.
  - Business: $20/mo, 120 rpm.
  - "You will recieve a "429" http header if you breach the limit." After that, wait a minute.
  - Sources: https://www.thesportsdb.com/documentation and https://www.thesportsdb.com/pricing
- The docs don't say whether limits are per key or per IP.
- INFERRED: five "free keys" means nothing here. The free key is one shared value.
