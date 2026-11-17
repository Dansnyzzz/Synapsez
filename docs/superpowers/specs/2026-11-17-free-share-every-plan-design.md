# Every plan gets the free share (1.32.0) — design

Asked by the owner on 2026-11-17, after 1.31.0 went live:

- "đảm bảo gói free cũng được miễn phí lượt tìm kiếm + sandbox"
- "mấy cái được tặng kèm là được tính ở free share (được tặng thêm hơn free tier) chứ không tính vào paid key"
- "khi xài hết tổng dung lượng free của hệ thống - gồm nhiều api keys - thì sau đó nếu users có xài thì mới tính vào paid key"

The owner left the allowance size and the order of use to us ("bạn thấy cách nào tối ưu hóa"). The choice below
spends free capacity first and keeps the paid key for last.

## Today (facts)

- **A Free account with no balance is not billable.** It uses the monthly free share:
  - `server/freeTier.js` `mayMeter` / `countMetered` for searches;
  - `e2bAccountAllowance` / `e2bAccountSpend` for the cloud computer.

  This is correct and stays as it is.
- **A Free account with a balance is billable** (`server/billing/meter.js` `isBillable`: a plan *or* a balance).
  `PLANS.free` includes 0 searches and 0 minutes, so:
  - every search is charged to the balance from the first one (`takeSearch`);
  - every minute of the computer is charged too (`holdSandbox`);
  - the free share is skipped: `server/tools/cloud.js:419` "pays its units … instead of using up the free share", and
    `server/e2b.js` `payUntil` says "a window billing paid for is not also drawn from the account's free share".

  **Topping up loses the free share.**
- **A paid plan** uses its included month, then the balance. It never gets the free share.
  - Included and balance calls carry `paid: true`.
  - The key pool (`server/keyPool.js`) serves a `paid: true` call from every free key first, and from the paid key only
    once all of them are spent. This is the owner's rule, and it stays.
- **The Free card is wrong.** It says "Không kèm lượt tìm kiếm tính phí" and "Không kèm giờ máy tính đám mây"
  (`public/js/billing-plans.js:309-310`), as though Free got nothing.

## Design

### 1. The order each call is paid from

**A billable account on a paid plan:**
1. **The plan's included month** (`paid: true`, so free keys first and the paid key only after them). Free keys serve the
   included amount early in the month, so the paid key is touched later and less, and quality never drops while any of
   the plan's amount remains.
2. **The free share**, the same as every member's (free keys only: when the pool is dry a free engine answers, as today).
3. **The balance**, at pay-as-you-go prices (`paid: true`).
4. **Nothing left:** refused in `live`, counted as "would" in `preview`. Both as today.

**A billable account on the Free plan** (it has a balance):
1. **The free share.**
2. **The balance.**
3. **Nothing left:** refused or "would", as above.

**Not billable** (no plan and no balance, or any member in `preview`): unchanged, the free share only.

### 2. How much each plan gets

- **Free:** the share **S**. Its formula is unchanged (capacity, a 20% reserve, the people who used it in 30 days,
  bounds of 30–900 searches).
- **Plus / Pro / Max:** **S + the plan's amount**.
  - Searches: 150 / 250 / 450.
  - Computer time: 4 / 6 / 12 h.

  A paid plan therefore always gets more than Free ("tặng thêm hơn free tier"), and "Mọi thứ trong gói Miễn phí, và:"
  on the paid cards becomes true.

### 3. The free keys are never promised twice

When the month's share is worked out (`server/freeShares.js` `workOut`), what the paid plans in force are owed is taken
out of the capacity first:

- `committed.searches` = Σ `PLANS[plan].searches` over subscriptions in `active` or `grace`.
- `committed.machineMills` = Σ `sandboxMinutes × MACHINE_MILLS_PER_HOUR / 60`.
- `S = clamp(max(0, capacity − committed) × 0.8 ÷ people, bounds)`. The machine share is reduced the same way.

The existing rules still apply:
- The share is worked out on the first call of the month, and again when capacity rises.
- It is stored so that it can only go up (`raiseSetting`), so a plan bought mid-month never lowers anybody's share. It is
  covered by the 20% reserve, as a newcomer is.
- With billing `off`, or no subscriptions, `committed` is 0 and nothing changes.

### 4. Where it is shown

- **The Free card** shows the viewer's own share this month:
  - vi "{n} lượt tìm kiếm miễn phí mỗi tháng"
  - vi "{time} máy tính đám mây miễn phí mỗi tháng"
  - en "{n} free searches a month"
  - en "{time} of free computer time a month"

  The figures come from the share the server works out (`accountShares`), carried on `GET /api/billing/plans` as `share`
  (`{ searches, machineMinutes }`, or null when it cannot be read).
- **If the share cannot be read**, the Free card says it more generally:
  - vi "Lượt tìm kiếm và máy tính đám mây miễn phí mỗi tháng, chia đều"
  - en "Free searches and computer time each month, shared evenly"
- **The paid cards** keep "Mọi thứ trong gói Miễn phí, và:" and their own amounts.
- **Settings → Usage** already shows the free share to every account, and **Settings → Billing** shows the plan's own
  month. Both now count for a paid account. Nothing new is drawn.
- **The `searchesNone` / `computerNone` keys** go from both locales.

### 5. Code shape

- **`server/billing/meter.js`:**
  - Searches: `takeSearch` gains a share step. For a paid plan it comes after the included month; for Free it comes
    first. When the account's share has room (`mayMeter`), `holdSearch` returns `NOT_BILLED`, so the caller's existing
    member path counts it (`countMetered`) and passes `paid: false`.
  - Computer time: `holdSandbox(userId, seconds, { shareCost })` does the same. When the window's cost fits the
    account's share (`e2bAccountAllowance`), it returns `NOT_BILLED`, and `payUntil`'s existing `shared` path draws it
    from the share. `server/e2b.js` passes the window's cost.
- **`server/freeShares.js`:** `committedNow()` (one grouped query, `store.countLivePlans()`), subtracted inside `workOut`.
- **Comments to correct:** `cloud.js:419` and the `payUntil` comment.
- **The plans sheet:** `share` on `GET /api/billing/plans`, and the Free card lines.

### 6. Tests

- **Meter:**
  - Free with a balance: the share first, then the balance only once the share is used, so the balance is untouched
    while the share has room.
  - Paid: the included month, then the share, then the balance.
  - Not billable: unchanged.
  - The computer behaves the same way, using `shareCost`.
  - `paid` is false for a call paid from the share, and true for included and balance calls.
- **Shares:** `committed` lowers S. With no plans or billing off, S is unchanged. A plan bought mid-month never lowers a
  stored share.
- **UI:**
  - The Free card shows the viewer's share figures.
  - If the share can't be read, it shows the general line.
  - The `searchesNone` / `computerNone` wording is gone.
- **Docs:** the README billing section and the features pins say the same as the code.

### 7. Release

1.32.0. The changelog (vi and en) says, in plain words:
- the Free plan keeps its free searches and computer time even with a balance;
- paid plans get the free share as well as their own amount.
