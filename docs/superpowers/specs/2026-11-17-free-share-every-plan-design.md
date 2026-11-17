# Every plan gets at least the free share (1.32.0) — design

Asked by the owner on 2026-11-17, after 1.31.0 went live:

- "đảm bảo gói free cũng được miễn phí lượt tìm kiếm + sandbox"
- "mấy cái được tặng kèm là được tính ở free share (được tặng thêm hơn free tier) chứ không tính vào paid key"
- "khi xài hết tổng dung lượng free của hệ thống - gồm nhiều api keys - thì sau đó nếu users có xài thì mới tính vào paid key"
- Asked "số lượng tặng thêm vậy có the best cho lợi nhuận của tôi chưa". After seeing the figures, the owner chose
  **the larger of the two** (a paid plan gets max(share, plan amount)) as the best for profit.

## Today (facts)

- **A Free account with no balance** is not billable. It uses the monthly free share:
  - searches through `server/freeTier.js` `mayMeter` / `countMetered`;
  - the cloud computer through `e2bAccountAllowance` / `e2bAccountSpend`.

  This is correct and stays as it is.
- **A Free account with a balance** is billable (`server/billing/meter.js` `isBillable`: a plan *or* a balance).
  `PLANS.free` includes 0 searches and 0 minutes, so every search and every minute of the computer is charged to the
  balance from the first one (`takeSearch`, `holdSandbox`). The free share is skipped:
  - `server/tools/cloud.js:419` says "pays its units … instead of using up the free share";
  - `server/e2b.js` `payUntil` says "a window billing paid for is not also drawn from the account's free share".

  **Topping up loses the free share.**
- **A paid plan** uses its included month, then the balance. It never gets the free share, so in a month when the
  share is larger than the plan's amount (it can reach 900 searches), a Free account gets more than Plus.
- **Included and balance calls carry `paid: true`.** The key pool (`server/keyPool.js` `pickKey`) serves them from every
  free key first, and from the paid key only once all of them are spent. This is the owner's rule, and it stays.
- **The Free card is wrong.** It says "Không kèm lượt tìm kiếm tính phí" and "Không kèm giờ máy tính đám mây"
  (`public/js/billing-plans.js:309-310`), as though Free got nothing.

## Design

### 1. How much each plan gets in a month

- **Free:** the free share **S**. Its formula is unchanged (capacity, a 20% reserve, the people who used it in 30 days,
  30–900 searches).
- **Plus / Pro / Max:** **max(S, P)**, where **P** is the plan's own amount.
  - Searches: P is 150 / 250 / 450.
  - The cloud computer: P is 4 / 6 / 12 h, compared in mills: `sandboxMinutes × MACHINE_MILLS_PER_HOUR / 60`.

A paid plan is therefore never worse than Free. Past that amount, every account pays from its balance, so heavy users
reach pay-as-you-go at the plan's amount, which is best for profit (the owner's choice). The calls cost the same in API
money under any choice; only the pay-as-you-go income differs.

### 2. The order each call is paid from

For a billable account (one with a plan or a balance):

1. **The plan's included month, P.** It is `paid: true`, so free keys come first and the paid key only after them. A
   Free account has no P.
2. **The free share, up to S − P** (S for Free). It uses free keys only: when the pool is dry a free engine answers, as
   today. It is counted on the account's existing share counter, so the condition is `used < S − P`.
3. **The balance**, at pay-as-you-go prices (`paid: true`).
4. **When nothing is left**, the call is refused in `live` and counted as "would" in `preview`, as today.

**Not billable** (no plan and no balance, or any member in `preview`): unchanged, the free share only.

**With `FREE_TIER_ONLY` off** (the ceilings lifted), there is no share to draw on and step 2 is skipped. Billing then
works exactly as today. Without this rule a lifted ceiling would make every call free, because `mayMeter` answers yes
whenever the ceilings are off.

Using the plan's amount first lets free keys serve it early in the month, so the paid key is touched later and less.

### 3. The free keys are never promised twice

When the month's share is worked out (`server/freeShares.js` `workOut`), what the paid plans in force are owed is taken
out of the capacity first:

- `committed.searches` = Σ P over subscriptions in `active` or `grace`.
- `committed.machineMills` is worked out the same way for the computer.
- `S = clamp(max(0, capacity − committed) × 0.8 ÷ people, bounds)`. The machine share is computed the same way.

The existing rules still hold:
- The share is worked out on the first call of a month, and again when capacity rises.
- It is stored so that it only ever rises (`raiseSetting`), so a plan bought mid-month never lowers anybody's share; it
  comes out of the 20% reserve, as a newcomer does.
- With billing `off`, or with no subscriptions, `committed` is 0 and nothing changes.

### 4. Where it is shown

The figures come from a new `share` field on `GET /api/billing/plans`: `{ searches, machineMills }` for the viewer this
month (from `accountShares`), or `null` when it cannot be read.

- **The Free card** shows the viewer's own share:

  | | Searches | Computer time |
  |---|---|---|
  | vi | "{n} lượt tìm kiếm miễn phí mỗi tháng" | "{time} máy tính đám mây miễn phí mỗi tháng" |
  | en | "{n} free searches a month" | "{time} of free computer time a month" |

  If `share` is null, the card shows one general line instead:
  - vi "Lượt tìm kiếm và máy tính đám mây miễn phí mỗi tháng, chia đều"
  - en "Free searches and computer time each month, shared evenly"
- **The paid cards** show max(S, P), noting that it already contains the free share. P is used when `share` is null.
  - vi "{n} lượt tìm kiếm mỗi tháng (đã gồm phần miễn phí)" and "{time} máy tính đám mây mỗi tháng (đã gồm phần miễn
    phí)"
  - en "{n} searches a month (the free share included)" and "{time} of computer time a month (the free share
    included)"
- **The keys `searchesNone` and `computerNone`** are removed from both locales.
- **Settings → Usage** already shows the free share, and **Settings → Billing** shows the plan's month. Nothing new is
  drawn there.

### 5. Code shape

**`server/billing/meter.js`**
- A step between the included month and the balance: "the share has room beyond P".
  - Searches: `freeTierOnly() && used < share − P`, read from `searchShareOf`.
  - The computer: `freeTierOnly() && shareMills − Pmills − usedMills ≥ shareCost`, read from `machineShareOf`.
- When the share has room, `holdSearch` / `holdSandbox` return `NOT_BILLED`. The caller's existing member path then does
  the rest:
  - `countMetered` for searches, and `paid: false`;
  - for the computer, `payUntil`'s `shared` path draws on `e2bAccountAllowance`.
- Extra units asked for in `settle` (more pages than held) never draw on the share; they follow the included/balance
  rules.
- `holdSandbox(userId, seconds, { now, shareCost })`. `server/e2b.js` `payUntil` passes the window's cost.

**`server/freeShares.js`**
- `committedNow()` uses one grouped query, a new store method `countLivePlans()` → `{ plus, pro, max }`, and is 0 with
  billing off.
- `workOut(capacity, people, env, committed)` subtracts it.

**Comments to correct:** `server/tools/cloud.js:419` and the `payUntil` comment, to say what is true now.

**`server/routes/billing.js`:** `share` on `GET /api/billing/plans`.

**`public/js/billing-plans.js`:** the card lines, plus the locales.

### 6. Tests

**Meter** (`test/billing-meter.test.mjs`):
- **Free with a balance:** the share is used first. The balance is untouched while the share has room, and is charged
  once the share is used.
- **Paid, when S ≤ P:** the plan's amount, then the balance. The share is never drawn on.
- **Paid, when S > P:** the plan's amount, then the share for S − P, then the balance.
- **Not billable:** unchanged.
- **`FREE_TIER_ONLY` off:** there is no share step.
- **The computer:** the same cases, using `shareCost`.
- **`paid`:** false on a call taken from the share, and true on included and balance calls.
- **Existing sections** that expect a balance charge while the share still has room are changed to use the share up
  first, or to say plainly why not.

**Shares** (`test/free-shares.test.mjs`):
- `committed` lowers S.
- With no plans, or with billing off, S is unchanged.
- A plan bought mid-month never lowers a stored share.

**Routes:** `share` on `/billing/plans`, for the viewer only.

**UI** (`test/ui-billing.test.mjs`):
- The Free card shows the viewer's share.
- With `share` null, the Free card shows the general line.
- A paid card shows max(S, P) with "(the free share included)".
- The old "No metered searches included" wording is gone.

**Docs:** the README billing section and the features pins say what the code does.

### 7. Release

1.32.0. The changelog (vi and en) says, in plain words:
- The Free plan keeps its free searches and computer time even with a balance.
- A paid plan always gets at least the free share.
- The plans sheet shows the real figures.
