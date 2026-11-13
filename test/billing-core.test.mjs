/**
 * The pure billing rules (owner, 2026-11-12/13): plans and their prices in USD charged in đồng at
 * the day's rate, pay-as-you-go anchored to 25,656 đ and following the rate, Vietnamese time for
 * every period, payment codes that are SZ + ten digits, and the BILLING_MODE gate. No database,
 * no network: these modules depend only on node:crypto.
 *
 *   node test/billing-core.test.mjs
 */
import { PLANS, PLAN_IDS, PAID_PLANS, PAYG_ANCHOR_RATE, paygPrices, planVnd, unitsForPages, isPlan, isPaidPlan } from '../server/billing/plans.js';
import { vnDay, vnDayEnd, addMonths, monthWindow, prorate, addDays } from '../server/billing/period.js';
import { newPaymentCode, findCode } from '../server/billing/codes.js';
import { billingMode, billingVisible } from '../server/billing/mode.js';

const print = console.log.bind(console);
let failures = 0;
const section = (name) => print(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  print(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A Vietnamese wall time as a Date (UTC+7 all year). */
const vn = (y, m, d, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min) - 7 * 3600_000);

section('plans and prices in đồng');
check('plus month at 25,655.85 is 129,000đ', planVnd('plus', 'month', 25655.85) === 129000, String(planVnd('plus', 'month', 25655.85)));
check('pro month at 25,655.85 is 206,000đ', planVnd('pro', 'month', 25655.85) === 206000, String(planVnd('pro', 'month', 25655.85)));
check('max month at 25,655.85 is 385,000đ', planVnd('max', 'month', 25655.85) === 385000, String(planVnd('max', 'month', 25655.85)));
check('plus year at 25,655.85 is 1,463,000đ', planVnd('plus', 'year', 25655.85) === 1463000, String(planVnd('plus', 'year', 25655.85)));
check('pro year at 25,655.85 is 2,335,000đ', planVnd('pro', 'year', 25655.85) === 2335000, String(planVnd('pro', 'year', 25655.85)));
check('max year at 25,655.85 is 4,388,000đ', planVnd('max', 'year', 25655.85) === 4388000, String(planVnd('max', 'year', 25655.85)));
check('an exact thousand stays: plus month at 25,000 is 125,000đ', planVnd('plus', 'month', 25000) === 125000, String(planVnd('plus', 'month', 25000)));
check('plan ids are free, plus, pro, max', same(PLAN_IDS, ['free', 'plus', 'pro', 'max']));
check('paid plans are plus, pro, max', same(PAID_PLANS, ['plus', 'pro', 'max']));
check('isPlan knows the four, and nothing else', isPlan('max') && isPlan('free') && !isPlan('ultra') && !isPlan('__proto__') && !isPlan('constructor'));
check('isPaidPlan excludes free', isPaidPlan('pro') && !isPaidPlan('free') && !isPaidPlan('nope'));
check('included allowances are the owner\'s table', PLANS.plus.searches === 150 && PLANS.pro.searches === 250 && PLANS.max.searches === 450
  && PLANS.plus.sandboxMinutes === 240 && PLANS.pro.sandboxMinutes === 360 && PLANS.max.sandboxMinutes === 720
  && PLANS.plus.storageGb === 3 && PLANS.pro.storageGb === 5 && PLANS.max.storageGb === 10
  && PLANS.free.searches === 0 && PLANS.free.sandboxMinutes === 0 && PLANS.free.storageGb === 0.5);
check('no plan carries a per-day field (owner: no daily limits)', Object.values(PLANS).every((p) => !Object.keys(p).some((k) => /perday|daily/i.test(k))));
check('plans are frozen', Object.isFrozen(PLANS) && Object.isFrozen(PLANS.plus));

section('units for metered pages');
check('1 page is 1 unit', unitsForPages(1) === 1);
check('3 pages are 1 unit', unitsForPages(3) === 1);
check('4 pages are 2 units', unitsForPages(4) === 2);
check('10 pages are 4 units', unitsForPages(10) === 4);
check('0 pages is still 1 unit', unitsForPages(0) === 1);

section('pay-as-you-go follows the rate');
check('anchor rate is 25,656', PAYG_ANCHOR_RATE === 25656);
check('paygPrices() is the anchor prices', same(paygPrices(), { searchVnd: 400, sandboxVndPerMinute: 84, storageVndPerGbMonth: 1000 }), JSON.stringify(paygPrices()));
check('paygPrices(25656) is the anchor prices', same(paygPrices(25656), { searchVnd: 400, sandboxVndPerMinute: 84, storageVndPerGbMonth: 1000 }));
check('paygPrices(27000) is 430 / 88 / 1,060', same(paygPrices(27000), { searchVnd: 430, sandboxVndPerMinute: 88, storageVndPerGbMonth: 1060 }), JSON.stringify(paygPrices(27000)));
check('paygPrices(24000) is 380 / 78 / 940', same(paygPrices(24000), { searchVnd: 380, sandboxVndPerMinute: 78, storageVndPerGbMonth: 940 }), JSON.stringify(paygPrices(24000)));
check('paygPrices(0) is the anchor prices', same(paygPrices(0), paygPrices(25656)));
check('paygPrices(NaN) is the anchor prices', same(paygPrices(NaN), paygPrices(25656)));
check('regression: 26,297.40 search is 410, not 420', paygPrices(26297.4).searchVnd === 410, String(paygPrices(26297.4).searchVnd));
check('regression: 24,373.20 storage is 950, not 960', paygPrices(24373.2).storageVndPerGbMonth === 950, String(paygPrices(24373.2).storageVndPerGbMonth));
check('regression: 25,142.88 storage is 980, not 990', paygPrices(25142.88).storageVndPerGbMonth === 980, String(paygPrices(25142.88).storageVndPerGbMonth));
{
  // Every two-decimal rate from 23,000.00 to 29,000.00 against exact integer maths (BigInt).
  const ceilBig = (n, d) => (n + d - 1n) / d;
  const ANCHOR_C = 2_565_600n;
  let mismatches = 0;
  let first = '';
  for (let c = 2_300_000; c <= 2_900_000; c += 1) {
    const rc = BigInt(c);
    const exact = {
      searchVnd: Number(ceilBig(400n * rc, ANCHOR_C * 10n) * 10n),
      sandboxVndPerMinute: Number(ceilBig(5000n * rc, ANCHOR_C * 60n)),
      storageVndPerGbMonth: Number(ceilBig(1000n * rc, ANCHOR_C * 10n) * 10n),
    };
    const got = paygPrices(c / 100);
    if (!same(got, exact)) {
      mismatches += 1;
      if (!first) first = `${c / 100}: got ${JSON.stringify(got)} exact ${JSON.stringify(exact)}`;
    }
  }
  check('every rate 23,000.00 to 29,000.00 in cents matches exact integer maths', mismatches === 0, mismatches ? `${mismatches} differ, first ${first}` : '600,001 rates');
}

section('Vietnamese time for periods');
const start = vn(2026, 11, 13, 10);
check('vnDay of 17:30Z on 12 Nov is 13 Nov in Vietnam', vnDay(new Date('2026-11-12T17:30:00Z')) === '2026-11-13');
check('vnDayEnd of that day is 2026-11-13T17:00Z', vnDayEnd(new Date('2026-11-12T17:30:00Z')).toISOString() === '2026-11-13T17:00:00.000Z', vnDayEnd(new Date('2026-11-12T17:30:00Z')).toISOString());
check('addMonths(31 Jan, 1) is 28 Feb, same wall time', addMonths(vn(2026, 1, 31, 10), 1).getTime() === vn(2026, 2, 28, 10).getTime());
check('addMonths(31 Jan, 2) is 31 Mar, counted from the start', addMonths(vn(2026, 1, 31, 10), 2).getTime() === vn(2026, 3, 31, 10).getTime());
check('addMonths(29 Feb 2028, 12) is 28 Feb 2029', addMonths(vn(2028, 2, 29), 12).getTime() === vn(2029, 2, 28).getTime());
const win = monthWindow(vn(2026, 1, 31), vn(2026, 3, 5));
check('monthWindow(31 Jan, 5 Mar) starts 28 Feb', win.start.getTime() === vn(2026, 2, 28).getTime(), win.start.toISOString());
check('monthWindow(31 Jan, 5 Mar) ends 31 Mar', win.end.getTime() === vn(2026, 3, 31).getTime(), win.end.toISOString());
check('monthWindow key is the window start in ms', win.key === String(vn(2026, 2, 28).getTime()));
const end = addDays(start, 30);
check('prorate at the middle of 30 days is half of 129,000đ', prorate(129000, start, end, addDays(start, 15)) === 64500);
check('prorate at the start is the whole payment', prorate(129000, start, end, start) === 129000);
check('prorate at the end is 0', prorate(129000, start, end, end) === 0);
check('prorate rounds down to the đồng', prorate(100, start, end, addDays(start, 10)) === 66, String(prorate(100, start, end, addDays(start, 10))));

section('payment codes');
check('newPaymentCode with a fixed draw of 42 is SZ0000000042', newPaymentCode(() => 42) === 'SZ0000000042', newPaymentCode(() => 42));
const codes = Array.from({ length: 1000 }, () => newPaymentCode());
check('1,000 real codes all match SZ + 10 digits', codes.every((c) => /^SZ\d{10}$/.test(c)));
check('1,000 real codes are distinct', new Set(codes).size === 1000, String(new Set(codes).size));
check('SePay code field, lowercase, is uppercased', findCode('sz1234567890', '') === 'SZ1234567890');
check('content carries the code', findCode(null, 'MBVCB.123 SZ1234567890 chuyen tien') === 'SZ1234567890');
check('11 digits after SZ is not a code', findCode(null, 'SZ12345678901') === null);
check('a malformed code and no code in content is null', findCode('SZ-1', 'no code') === null);

section('BILLING_MODE gate');
check('unset is preview', billingMode({}) === 'preview');
check('LIVE is live (case and spacing do not matter)', billingMode({ BILLING_MODE: ' LIVE ' }) === 'live');
check('nonsense is preview', billingMode({ BILLING_MODE: 'nonsense' }) === 'preview');
check('off is off', billingMode({ BILLING_MODE: 'off' }) === 'off');
check('preview: an administrator sees billing', billingVisible({ role: 'admin' }, { BILLING_MODE: 'preview' }) === true);
check('preview: a user does not see billing', billingVisible({ role: 'user' }, { BILLING_MODE: 'preview' }) === false);
check('live: a user sees billing', billingVisible({ role: 'user' }, { BILLING_MODE: 'live' }) === true);
check('no account sees nothing', billingVisible(null, { BILLING_MODE: 'live' }) === false && billingVisible(null, {}) === false);
check('off: nobody sees billing', billingVisible({ role: 'admin' }, { BILLING_MODE: 'off' }) === false && billingVisible({ role: 'user' }, { BILLING_MODE: 'off' }) === false);

print(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
