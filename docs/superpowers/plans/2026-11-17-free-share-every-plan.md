# Every plan gets at least the free share — implementation plan (1.32.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Free plan keeps its monthly free searches and computer time even after topping up. A paid plan gets
max(free share, its own amount). The plans sheet shows the real figures. The paid key stays last.

**Architecture:**
- Billing's meter (`server/billing/meter.js`) gains one step between a plan's included month and the balance: "the
  free share has room beyond the plan's amount". When it does, the hold returns `NOT_BILLED`, and the caller's existing
  member path counts the call against the share with `paid: false`.
- The month's share (`server/freeShares.js`) is worked out after setting aside what the paid plans in force are owed.
- `GET /api/billing/plans` carries the viewer's share, so the cards can show it.

**Tech Stack:** Node ESM, Express, Postgres (PGlite in tests), vanilla JS front end, the repo's hand-rolled test
harness (`node test/<name>.test.mjs`), Playwright for the `ui-*` suites.

**Spec:** `docs/superpowers/specs/2026-11-17-free-share-every-plan-design.md` (§1–7). Read the section each task names.

## Global Constraints

- **Allowances.** A paid plan's monthly allowance is **max(S, P)**:
  - S is the account's free share this month (`searchShareOf` / `machineShareOf`).
  - For searches, P is the plan's own amount: Plus 150, Pro 250, Max 450.
  - For the computer, P is `sandboxMinutes × MACHINE_MILLS_PER_HOUR / 60` mills: 4 / 6 / 12 h.
  - Free's allowance is S, and P = 0.
- **The order a call is paid from:** the plan's included month (`paid: true`), then the share while
  `used < S − P` (`paid: false`, free keys only), then the balance (`paid: true`), then refused in `live` and counted as
  "would" in `preview`.
- **Ceilings lifted.** With `FREE_TIER_ONLY` off (`freeTierOnly()` false), the share step is skipped entirely, and
  billing works exactly as before this release.
- **Unbillable accounts are unchanged:** no plan and no balance, or any member in `preview`.
- **The paid key stays last.** `pickKey` already serves `paid: true` from every free key before the paid key. Do not
  change `server/keyPool.js`.
- **Shares.** `committed` = Σ P over subscriptions in `active` or `grace`. It is 0 when `billingMode() === 'off'`.
  - S = `clamp(max(0, capacity − committed) × (1 − reserve) ÷ max(peopleFloor, people), bounds)`. The machine share is
    computed the same way. The 34% cap per account stays on the raw capacity.
  - The stored share only ever rises (`raiseSetting`), and that rule is unchanged.
- **Copy:**
  - Free card: vi "{n} lượt tìm kiếm miễn phí mỗi tháng" / "{time} máy tính đám mây miễn phí mỗi tháng"; en "{n} free
    searches a month" / "{time} of free computer time a month".
  - Free card with no share: vi "Lượt tìm kiếm và máy tính đám mây miễn phí mỗi tháng, chia đều"; en "Free searches and
    computer time each month, shared evenly".
  - Paid cards: vi "{n} lượt tìm kiếm mỗi tháng (đã gồm phần miễn phí)" / "{time} máy tính đám mây mỗi tháng (đã gồm
    phần miễn phí)"; en "{n} searches a month (the free share included)" / "{time} of computer time a month (the free
    share included)".
  - Remove `billing.plans.searchesNone` and `billing.plans.computerNone`.
- **Locales.** Every new user-facing string goes in both `public/js/locales/en.js` and `vi.js`. Server errors a person
  sees go in `server/i18n/vi.js`.
- **Comments** say why, not what. CODE-039 has a ceiling of 93 back-to-back doc blocks: a section banner straight above
  a `/** */` counts, so leave a blank line between them.
- **Checks.** `npm run typecheck` must stay within its baseline (ceiling 269), and `npm run lint` must be clean.
- **Line endings.** The working tree is CRLF, except `public/js/locales/*.js` and `test/features.test.mjs`, which are
  LF. Never leave a lone CR, and never use `sed -i`.
- **Files that are off limits.**
  - Never read, edit or stage `.env` or `.env.example`.
  - Stage by path only. Never stage `.claude/AUDIT_RULES.md`, `.claude/audit-annex/`, `.vscode/` or
    `Exa Deep Research-3.4.1-v1/`.
  - **Never use `git stash` in any form.** To prove a test fails first, use a scratch copy made from
    `git show HEAD:<path>`.
- **Running tests.** Run them in the foreground. Implementers never run `npm run gate` or the full `npm run test:ui`;
  the controller does.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: The share is worked out after what paid plans are owed

**Files:**
- Modify: `server/store/pg.js` (new `countLivePlans()`, next to `listSubscribedUserIds` at about line 5956)
- Modify: `server/freeShares.js` (`committedNow()`, `workOut(…, committed)`, `monthShares` passes it and stores it)
- Test: `test/free-shares.test.mjs` (new section); `test/billing-store.test.mjs` if the store method needs its own check

**Interfaces:**
- Produces: `store.countLivePlans(): Promise<Record<string, number>>`, the number of subscriptions per plan id in
  `active` or `grace`.
- Produces: `committedNow(): Promise<{ searches: number, machineMills: number }>`, internal to freeShares. The stored
  figure gains `committed`.

- [ ] **Step 1: Write the failing checks** in a new section of `test/free-shares.test.mjs`:
  `'paid plans are set aside before the even split'`.
  - **Setup:** use the file's own helpers (`addKey`, `reset`, `refreshPool`). Pick a capacity big enough that the
    bounds do not clamp, for example an Exa key with a large ceiling. Then insert two Plus and one Max subscription
    (`status: 'active'`) with `store.createSubscription`. Read how `test/billing-meter.test.mjs` `withPlan` calls it.
  - **Checks:**
    - The share falls by exactly `floor((cap − committed) × 0.8 / people)` against `floor(cap × 0.8 / people)`, where
      `committed.searches = 2×150 + 450`. Compare with a run that has no subscriptions.
    - With `BILLING_MODE=off`, the share equals the no-plan figure.
    - A subscription created after the month's figure is stored does not lower the stored figure (the stored value
      only rises).
    - The machine share drops the same way. Compute `machineMills` committed with `MACHINE_MILLS_PER_HOUR`.
    - `countLivePlans()` counts `active` and `grace` and ignores `ended`.
- [ ] **Step 2: Run** `node test/free-shares.test.mjs`. It should fail: the share does not move.
- [ ] **Step 3: Implement.**

```js
// server/store/pg.js — beside listSubscribedUserIds
/** How many plans are in force, by plan: what the free keys are set aside for before the even split (freeShares.js). */
async countLivePlans() {
  const rows = await q(`SELECT plan, COUNT(*)::int AS n FROM subscriptions WHERE status IN ('active', 'grace') GROUP BY plan`);
  return Object.fromEntries(rows.map((r) => [r.plan, Number(r.n)]));
},
```

```js
// server/freeShares.js
import { billingMode } from './billing/mode.js';
import { PLANS, PAID_PLANS } from './billing/plans.js';

/** What the paid plans in force are owed this month, in searches and machine mills: theirs before anybody's even share (owner, 2026-11-17). */
async function committedNow() {
  if (billingMode() === 'off') return { searches: 0, machineMills: 0 };
  const counts = await getStore().countLivePlans();
  let searches = 0;
  let machineMills = 0;
  for (const plan of PAID_PLANS) {
    const n = Number(counts[plan]) || 0;
    searches += n * PLANS[plan].searches;
    machineMills += n * Math.round((PLANS[plan].sandboxMinutes * MACHINE_MILLS_PER_HOUR) / 60);
  }
  return { searches, machineMills };
}
```

  In `workOut(capacity, people, env = process.env, committed = { searches: 0, machineMills: 0 })`:
  - Divide `max(0, capacity.searches − committed.searches)` in place of `capacity.searches`.
  - Divide `max(0, capacity.machineMills − committed.machineMills)` in the machine's per-person figure. `machineHigh`
    stays on the raw `capacity.machineMills`.

  In `monthShares`:
  - Call `committedNow()` (wrapped so that a failure counts as 0, logged with `log.warn` without account details).
  - Pass the result to `workOut`.
  - Add `committed` to the object given to `raiseSetting`.

  First check that `server/billing/mode.js` and `server/billing/plans.js` import nothing that leads back to
  `freeShares.js`. If they do, stop and report.
- [ ] **Step 4: Run** `node test/free-shares.test.mjs`, `node test/billing-store.test.mjs`,
  `node test/billing-meter.test.mjs`, `npm run lint` and `npm run typecheck`. All should pass.
- [ ] **Step 5: Commit** with the message `feat(shares): the even split comes after what paid plans are owed`.

### Task 2: The meter takes the free share before the balance

**Files:**
- Modify: `server/billing/meter.js` (`takeSearch`, `holdSearch`, `holdSandbox`, and the file's header comment)
- Modify: `server/e2b.js` (`payUntil` passes `{ shareCost: cost }`; the comment above it)
- Modify: `server/tools/cloud.js` (the comment at about line 419, "instead of using up the free share")
- Test: `test/billing-meter.test.mjs`

**Interfaces:**
- Consumes: `searchShareOf(userId, now)` → `{ share, used }` and `machineShareOf(userId, now)` → `{ share, used }`
  (mills), both from `server/freeShares.js`; `freeTierOnly` from `server/freeTierPeriod.js`; `MACHINE_MILLS_PER_HOUR`.
- Produces: `holdSandbox(userId, seconds, { now, shareCost })`. `shareCost` is in mills. When it is omitted, the share
  step is skipped for the computer.

- [ ] **Step 1: Write the failing checks** in `test/billing-meter.test.mjs`, in a new section
  `'every plan gets at least the free share (owner, 2026-11-17)'`.
  - **Setup:** the file deletes `FREE_TIER_ONLY`, so shares are enforced. Fix the share small and known by setting
    `FREE_TIER_USER_MONTHLY_MIN` / `MAX`, or by writing the month's `free_shares:<month>` setting directly, as
    `test/free-shares.test.mjs` does. Work out S from that figure, not from a literal.
  - **Free with a balance.** For the first S − used searches:
    - `holdSearch` returns `NOT_BILLED`;
    - the balance does not change;
    - `usage(user, 'search').u` stays 0.
    Once the share is used up, the next search returns `billed && source === 'balance'` and the balance falls by the
    pay-as-you-go price. Count the share for this check by calling `countMetered`, as the caller does.
  - **Plus with S ≤ P.** The included month comes first (`source: 'included'`). After P, the balance is charged, and
    `NOT_BILLED` never appears.
  - **Plus with S > P.** After P included searches, `NOT_BILLED` is returned for S − P more, and then the balance.
  - **`FREE_TIER_ONLY=false`.** A Free account with a balance is charged from the first search (as today).
  - **The computer, Free with a balance:**
    - `holdSandbox(id, 600, { shareCost })` returns `NOT_BILLED` while `e2bAccountAllowance(id).left ≥ shareCost`;
    - once the share is spent, it takes from the balance;
    - with `shareCost` omitted, it takes from the balance.
  - **The computer, paid plan:** the included time, then the share beyond P mills, then the balance.
  - **`paid`:** false on every `NOT_BILLED` hold, and true on included and balance holds.
  - **`settle(more)` on a billed hold** never draws on the share. Use a balance-sourced hold and settle 3 units: all
    three are charged to the balance.
  - **Existing sections.** Re-run the whole file. Any older check that expects a Free+balance or Plus account to be
    charged while its share still has room now fails. Fix each one either by using the share up first, or by running
    that section with `FREE_TIER_ONLY=false` and a comment saying why. Do not weaken what those checks assert.
- [ ] **Step 2: Run** `node test/billing-meter.test.mjs`. The new checks should fail.
- [ ] **Step 3: Implement.**

```js
// server/billing/meter.js
import { freeTierOnly } from '../freeTierPeriod.js';
import { searchShareOf, machineShareOf, MACHINE_MILLS_PER_HOUR } from '../freeShares.js';

/** A call the free share pays for: the caller's member path counts it, with free keys only (owner, 2026-11-17). */
const SHARE = Symbol('share');

/**
 * What is left of the free share beyond the plan's own amount: a plan gets the larger of the two (owner, 2026-11-17,
 * "the best for profit"), and Free gets the whole share. Nothing with the ceilings lifted — there is no share then, and
 * counting one would make every call free. Unreadable is nothing: the call is charged as before this release.
 */
async function searchRoom(userId, now, plan) {
  if (!freeTierOnly()) return 0;
  try {
    const { share, used } = await searchShareOf(userId, now);
    const own = plan.plan === 'free' ? 0 : PLANS[plan.plan].searches;
    return Number.isFinite(share) ? Math.max(0, share - own - used) : 0;
  } catch (err) {
    warn('the free share could not be read', err);
    return 0;
  }
}

async function machineRoom(userId, now, plan) {
  if (!freeTierOnly()) return 0;
  try {
    const { share, used } = await machineShareOf(userId, now);
    const own = plan.plan === 'free' ? 0 : Math.round((PLANS[plan.plan].sandboxMinutes * MACHINE_MILLS_PER_HOUR) / 60);
    return Number.isFinite(share) ? Math.max(0, share - own - used) : 0;
  } catch (err) {
    warn('the free machine share could not be read', err);
    return 0;
  }
}
```

  In `takeSearch(ctx, units, { share = true } = {})`, after the included block and before the balance:
  `if (share && (await searchRoom(userId, now, plan)) > 0) return SHARE;`

  In `holdSearch`:
  - `const first = await takeSearch(ctx, units); if (first === SHARE) return NOT_BILLED;`
  - In `settle`, the extra is `takeSearch(ctx, want - held, { share: false })`.

  In `holdSandbox(userId, seconds, { now = new Date(), shareCost } = {})`, inside `if (!piece)` and before the balance:
  `if (shareCost != null && (await machineRoom(id, now, plan)) >= shareCost) return NOT_BILLED;`

  In `server/e2b.js` `payUntil`: `await holdSandbox(userId, Math.ceil((until - from) / 1000), { shareCost: cost })`.
  Then update the two comments that say a billed account never uses the share, so they say what is true now.

  Check for import cycles: `server/freeShares.js` must not import `server/billing/meter.js`.
- [ ] **Step 4: Run** `node test/billing-meter.test.mjs`, `node test/e2b.test.mjs`, `node test/free-shares.test.mjs`,
  `node test/billing-flow.test.mjs`, `node test/search.test.mjs` and `node test/firecrawl.test.mjs` (both use
  `holdSearch` paths), plus `npm run lint` and `npm run typecheck`. All should pass.
- [ ] **Step 5: Commit** with the message
  `feat(billing): the free share comes before the balance — Free keeps it, a plan gets the larger of the two`.

### Task 3: The plans sheet shows the real figures

**Files:**
- Modify: `server/routes/billing.js` (`GET /api/billing/plans` gains `share`)
- Modify: `public/js/billing-plans.js` (card lines at about lines 308-313), `public/js/locales/en.js`,
  `public/js/locales/vi.js`
- Test: `test/billing-routes.test.mjs`, `test/ui-billing.test.mjs`

**Interfaces:**
- Produces: `share: { searches: number, machineMills: number | null } | null` on `GET /api/billing/plans`. It is the
  viewer's own share: `searchShareOf(req.user.id).share` and `machineShareOf(req.user.id).share`, with a non-finite
  value as `null`. The whole field is `null` when `!freeTierOnly()` or when it cannot be read; log it with `log.warn`
  and no account details.
  - Do **not** call `accountShares`: it reads the keys' capacity, about a dozen queries, on every sheet open.

- [ ] **Step 1: Write the failing checks.**
  - **Routes.** `share` is present for the signed-in viewer and matches `searchShareOf` for that account. It is `null`
    with `FREE_TIER_ONLY=false`. Another account's figure is never returned: prove it with two accounts with different
    arrival days, so their prorated shares differ.
  - **UI** (`test/ui-billing.test.mjs`, routed `/api/billing/plans` with a known `share`):
    - The Free card reads "{n} free searches a month" and "{time} of free computer time a month". Use the client's
      `machineTime` from `public/js/free-share.js` for `{time}`.
    - With `share: null`, the Free card shows the general line.
    - With `share.searches` 400, the Plus card reads "400 searches a month (the free share included)".
    - With `share.searches` 120, the Plus card reads "150 searches a month (the free share included)".
    - The computer line follows the same max rule, compared in mills.
    - "No metered searches included" and "No cloud computer time included" appear nowhere.
    - Both locales have the keys (`node test/i18n.test.mjs`).
- [ ] **Step 2: Run.** It should fail.
- [ ] **Step 3: Implement.**
  - In the route, read the share (see Interfaces).
  - In `billing-plans.js`, build the search and computer lines per card from `data.plans.share`:
    - Free: the share lines, or the general line when there is no share.
    - Paid: `max(S, P)`, with "(the free share included)".
  - Add the new locale keys to both locales, and remove `searchesNone` and `computerNone`.
  - Keep `listHtml` and the "Everything in …, and:" lead-ins as they are.
- [ ] **Step 4: Run** `node test/billing-routes.test.mjs`, `node test/ui-billing.test.mjs`, `node test/i18n.test.mjs`,
  `node test/features.test.mjs`, `npm run lint` and `npm run typecheck`. All should pass.
- [ ] **Step 5: Commit** with the message `feat(billing): the plans sheet shows the free share and the larger allowance`.

### Task 4: Release 1.32.0

**Files:**
- Modify: `package.json` (1.32.0)
- Modify: `public/changelog.json` (1.32.0, vi and en, with arrays of the same length)
- Modify: `CHANGELOG.md`
- Modify: `README.md`, the billing section. Correct any sentence saying a plan's included month replaces the free share,
  or that Free has no searches, and add the max(S, P) rule and the order of use.
- Modify: `test/features.test.mjs`, adding pins that read from the code:
  - the order of use (the share sits between the included month and the balance);
  - max(S, P);
  - `FREE_TIER_ONLY` off means no share step;
  - the committed set-aside.

- [ ] **Step 1:** Write the pins, then run `node test/features.test.mjs`. It should fail.
- [ ] **Step 2:** Update the files. The changelog is written for the people who use Synapsez, in plain words with no file
  names:
  - the Free plan keeps its free searches and computer time even after topping up;
  - a paid plan always gets at least the free share;
  - the plans sheet shows the real figures.
- [ ] **Step 3:** Run `node test/features.test.mjs`, `node test/billing-docs.test.mjs`, `node test/i18n.test.mjs`,
  `node test/deploy.test.mjs` and lint. All should pass.
- [ ] **Step 4: Commit** with the message
  `release: 1.32.0 — the Free plan keeps its free share; every plan gets at least that`.
