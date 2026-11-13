/**
 * The billing store (schema 53, spec B1): the balance, orders, SePay transfers, promo
 * codes, receipts. Every money change is one SQL statement, so a charge that does not fit
 * changes nothing and two at once cannot both spend the same đồng. Real SQL on PGlite.
 *
 *   node test/billing-store.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'billing-store-test-encryption-key-long-enough';
process.env.SESSION_SECRET ||= 'billing-store-test-session-secret';
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL']) delete process.env[name];

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const { vnDay } = await import('../server/billing/period.js');
const db = await PGlite.create();
const query = async (text, params = []) => (await db.query(text, params)).rows;
const store = await initStore({ driver: { query } });

let n = 0;
const makeUser = async (role = 'user') => {
  n += 1;
  return store.createUser({ id: `bu${n}`, email: `bu${n}@example.test`, passwordHash: 'x', role });
};
const entries = async (userId) => query('SELECT * FROM balance_entries WHERE user_id = $1 ORDER BY id', [userId]);
const balanceOf = async (userId) => Number((await query('SELECT vnd FROM balances WHERE user_id = $1', [userId]))[0]?.vnd ?? 0);
const NOW = new Date('2026-11-13T05:00:00Z');
const later = (ms) => new Date(NOW.getTime() + ms);
const order = (id, userId, over = {}) => ({
  id, userId, kind: 'plan', plan: 'plus', period: 'month', code: `SZ${String(1000000000 + Number(id.replace(/\D/g, '') || 0))}`,
  usdCents: 500, rate: 25656, rateSource: 'erapi', priceVnd: 129000, creditVnd: 0, totalVnd: 129000, useBalance: true,
  expiresAt: later(1_800_000), simulated: false, ...over,
});

section('schema 53 applies, with row-level security on every new table');
{
  const tables = ['billing_profiles', 'balances', 'balance_entries', 'billing_orders', 'sepay_transfers', 'subscriptions', 'promo_codes', 'promo_redemptions', 'receipts', 'einvoices'];
  const rows = await query('SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = ANY($1::text[])', [tables]);
  check('all ten tables exist', rows.length === tables.length, String(rows.length));
  check('  each with row-level security on', rows.every((r) => r.rowsecurity === true), JSON.stringify(rows.filter((r) => !r.rowsecurity)));
}

section('credit, debit, and a debit that does not fit');
const alice = await makeUser();
{
  check('a credit makes the balance row and returns the new balance', (await store.creditBalance(alice.id, 5000, { kind: 'topup', ref: 'o1', topup: true })) === 5000);
  const state = await store.billingState(alice.id);
  check('billingState reads balance, top-up time, no subscription', state.balanceVnd === 5000 && state.lastTopupAt instanceof Date && state.subscription === null, JSON.stringify(state));
  check('a debit that fits returns the new balance', (await store.debitBalance(alice.id, 1200, { kind: 'adjust', note: 'x' })) === 3800);
  const before = (await entries(alice.id)).length;
  check('a debit larger than the balance returns null', (await store.debitBalance(alice.id, 3801, { kind: 'adjust' })) === null);
  check('  and changes neither balance nor entries', (await balanceOf(alice.id)) === 3800 && (await entries(alice.id)).length === before);
  check('a user with no balance row cannot be debited', (await store.debitBalance('nobody', 1, { kind: 'adjust' })) === null);
  check('a billingState for a stranger is zero, not an error', (await store.billingState('nobody')).balanceVnd === 0);
  let refused = false;
  try { await store.creditBalance(alice.id, 1.5, { kind: 'topup' }); } catch { refused = true; }
  check('money that is not whole đồng is refused', refused);
  const list = await store.listBalanceEntries(alice.id, { kind: 'topup' });
  check('listBalanceEntries filters by kind, newest first', list.length === 1 && list[0].deltaVnd === 5000 && list[0].ref === 'o1', JSON.stringify(list));
}

section('twenty concurrent debits of 400đ against 4,000đ');
{
  const bob = await makeUser();
  await store.creditBalance(bob.id, 4000, { kind: 'topup' });
  const results = await Promise.all(Array.from({ length: 20 }, () => store.debitBalance(bob.id, 400, { kind: 'adjust' })));
  const ok = results.filter((r) => r !== null).length;
  check('exactly 10 succeed', ok === 10, String(ok));
  check('  the balance is 0, never negative', (await balanceOf(bob.id)) === 0);
}

section('usage charges fold into one row per category and day');
{
  const cy = await makeUser();
  await store.creditBalance(cy.id, 2000, { kind: 'topup' });
  const a = await store.chargeUsage(cy.id, 'search', 1, 400, '2026-11-13');
  const b = await store.chargeUsage(cy.id, 'search', 1, 400, '2026-11-13');
  const rows = (await entries(cy.id)).filter((e) => e.kind === 'usage');
  check('two charges leave 1,200đ', a === 1600 && b === 1200);
  check('  as one usage row, units 2 and -800', rows.length === 1 && Number(rows[0].units) === 2 && Number(rows[0].delta_vnd) === -800, JSON.stringify(rows));
  check('a charge that does not fit returns null and changes nothing', (await store.chargeUsage(cy.id, 'search', 5, 5000, '2026-11-13')) === null && (await balanceOf(cy.id)) === 1200 && Number((await entries(cy.id)).filter((e) => e.kind === 'usage')[0].units) === 2);
  check('another day is another row', (await store.chargeUsage(cy.id, 'search', 1, 400, '2026-11-14')) === 800 && (await entries(cy.id)).filter((e) => e.kind === 'usage').length === 2);
  check('refundUsage takes it back', (await store.refundUsage(cy.id, 'search', 1, 400, '2026-11-13')) === 1200);
  const after = (await entries(cy.id)).find((e) => e.kind === 'usage' && (e.day instanceof Date ? e.day.toISOString() : String(e.day)).startsWith('2026-11-13'));
  check('  and the row follows (units 1, -400)', Number(after.units) === 1 && Number(after.delta_vnd) === -400, JSON.stringify(after));
}

section('paying an order from the balance');
{
  const dee = await makeUser();
  await store.creditBalance(dee.id, 500000, { kind: 'topup', topup: true });
  await store.createOrder(order('o10', dee.id, { expiresAt: later(-1000) }));
  check('an expired order is not paid', (await store.payOrderFromBalance('o10', NOW)) === null);
  await store.createOrder(order('o11', dee.id, { useBalance: false }));
  check('use_balance off and not enough received: null even with a big balance', (await store.payOrderFromBalance('o11', NOW)) === null && (await balanceOf(dee.id)) === 500000);
  await store.addOrderReceived('o11', 129000);
  check('  once the transfer has covered it, it can be paid', (await store.payOrderFromBalance('o11', NOW))?.status === 'paid');
  await store.createOrder(order('o12', dee.id, { totalVnd: 100000, priceVnd: 129000, creditVnd: 29000 }));
  const before = await balanceOf(dee.id);
  const paid = await store.payOrderFromBalance('o12', NOW);
  check('a good order is paid', paid?.status === 'paid' && paid.totalVnd === 100000 && paid.paidAt instanceof Date, JSON.stringify(paid));
  check('  the balance is down by total_vnd', (await balanceOf(dee.id)) === before - 100000);
  check('  with one plan entry', (await entries(dee.id)).filter((e) => e.kind === 'plan' && e.ref === 'o12').length === 1);
  check('the same call again pays nothing (paid once)', (await store.payOrderFromBalance('o12', NOW)) === null && (await balanceOf(dee.id)) === before - 100000);
  const poor = await makeUser();
  await store.createOrder(order('o13', poor.id));
  check('an order the balance cannot cover stays pending', (await store.payOrderFromBalance('o13', NOW)) === null && (await store.getOrder('o13')).status === 'pending');
  const free = await makeUser();
  await store.createOrder(order('o14', free.id, { totalVnd: 0, creditVnd: 129000 }));
  check('a total of 0 (covered by credit) pays, with no balance row before', (await store.payOrderFromBalance('o14', NOW))?.status === 'paid');
  const racers = await makeUser();
  await store.creditBalance(racers.id, 129000, { kind: 'topup' });
  await store.createOrder(order('o15', racers.id));
  const both = await Promise.all([store.payOrderFromBalance('o15', NOW), store.payOrderFromBalance('o15', NOW)]);
  check('two at once: one pays, the other gets null', both.filter(Boolean).length === 1 && (await balanceOf(racers.id)) === 0);
}

section('orders');
{
  const eve = await makeUser();
  const created = await store.createOrder(order('o20', eve.id, { kind: 'topup', plan: null, period: null }));
  check('createOrder returns the order, money as numbers', created.id === 'o20' && created.priceVnd === 129000 && created.status === 'pending' && created.rate === 25656, JSON.stringify(created));
  check('getOrderByCode finds it', (await store.getOrderByCode(created.code))?.id === 'o20');
  check('listOrders by user and status', (await store.listOrders({ userId: eve.id, status: 'pending' })).length === 1 && (await store.listOrders({ userId: eve.id, status: 'paid' })).length === 0);
  check('addOrderReceived adds up', (await store.addOrderReceived('o20', 1000)).receivedVnd === 1000 && (await store.addOrderReceived('o20', 500)).receivedVnd === 1500);
  check("cancelOrder is the owner's only", (await store.cancelOrder('o20', 'someone-else')) === null && (await store.cancelOrder('o20', eve.id))?.status === 'cancelled');
  check('  and a cancelled order cannot be cancelled again', (await store.cancelOrder('o20', eve.id)) === null);
  await store.createOrder(order('o21', eve.id, { expiresAt: later(-5000) }));
  await store.createOrder(order('o22', eve.id));
  check('expireOrders closes the pending ones past their time, and counts them', (await store.expireOrders(NOW)) === 2 && (await store.getOrder('o21')).status === 'expired' && (await store.getOrder('o22')).status === 'pending');
}

section('SePay transfers');
{
  const t = { dedupe: 'ref:FT1', sepayId: '9', referenceCode: 'FT1', gateway: 'VCB', accountNumber: '123', amountVnd: 129000, code: 'SZ1234567890', content: 'x', transactionAt: NOW, outcome: 'unmatched', via: 'webhook' };
  const first = await store.recordTransfer(t);
  check('a transfer is recorded', first && first.amountVnd === 129000 && first.outcome === 'unmatched', JSON.stringify(first));
  check('the same dedupe a second time returns null', (await store.recordTransfer(t)) === null);
  const eve2 = await makeUser();
  await store.createOrder(order('o30', eve2.id));
  await store.setTransferOutcome(first.id, { outcome: 'applied', orderId: 'o30', userId: eve2.id });
  const got = await store.getTransfer(first.id);
  check('setTransferOutcome links order and user', got.outcome === 'applied' && got.orderId === 'o30' && got.userId === eve2.id);
  check('listTransfers by outcome', (await store.listTransfers({ outcome: 'applied' })).length === 1 && (await store.listTransfers({ outcome: 'late' })).length === 0);
}

section('subscriptions and the billing profile');
{
  const fay = await makeUser();
  const sub = { userId: fay.id, plan: 'plus', period: 'month', status: 'active', periodStart: NOW, periodEnd: later(30 * 86400_000), paidVnd: 129000, autoRenew: true, cancelAtEnd: false, nextPlan: null, nextPeriod: null, remindedAt: null, renewalOrder: null };
  await store.saveSubscription(sub);
  check('a subscription is saved and read', (await store.getSubscription(fay.id))?.plan === 'plus');
  await store.saveSubscription({ ...sub, plan: 'pro', status: 'grace' });
  check('saving again updates by user', (await store.getSubscription(fay.id)).plan === 'pro' && (await query('SELECT 1 FROM subscriptions WHERE user_id = $1', [fay.id])).length === 1);
  check('billingState carries it', (await store.billingState(fay.id)).subscription?.status === 'grace');
  check('not due to be worked 30 days out', !(await store.listSubscriptionsToWork(NOW)).some((s) => s.userId === fay.id));
  check('due within 3 days of its end', (await store.listSubscriptionsToWork(later(28 * 86400_000))).some((s) => s.userId === fay.id));
  await store.saveSubscription({ ...sub, status: 'ended' });
  check('an ended one is never worked', !(await store.listSubscriptionsToWork(later(40 * 86400_000))).some((s) => s.userId === fay.id));
  check('no profile yet', (await store.getBillingProfile(fay.id)) === null);
  await store.setBillingProfile(fay.id, 'sealed-text');
  await store.setLowBalance(fay.id, 20000);
  await store.markLowAlert(fay.id, NOW);
  const p = await store.getBillingProfile(fay.id);
  check('profile keeps the sealed text, the low line and the alert time', p.sealed === 'sealed-text' && p.lowBalanceVnd === 20000 && p.lowAlertSentAt instanceof Date, JSON.stringify(p));
  await store.setLowBalance(fay.id, null);
  await store.markLowAlert(fay.id, null);
  const p2 = await store.getBillingProfile(fay.id);
  check('  and lets go of them', p2.lowBalanceVnd === null && p2.lowAlertSentAt === null && p2.sealed === 'sealed-text');
}

section('promo codes');
{
  const owner = await makeUser('admin');
  await store.createPromo({ code: 'welcome10', creditVnd: 10000, maxUses: 10, expiresAt: null, createdBy: owner.id });
  let dup = null;
  try { await store.createPromo({ code: 'WELCOME10', creditVnd: 1, maxUses: 1, expiresAt: null, createdBy: owner.id }); } catch (e) { dup = e.code; }
  check('a code twice is a duplicate (case does not matter)', dup === 'duplicate', String(dup));
  const people = [];
  for (let i = 0; i < 11; i += 1) people.push(await makeUser());
  const credited = await Promise.all(people.map((u) => store.redeemPromo('welcome10', u.id, NOW)));
  check('11 accounts on a 10-use code: 10 credited', credited.filter((c) => c === 10000).length === 10 && credited.filter((c) => c === null).length === 1, JSON.stringify(credited));
  const promo = (await store.listPromos()).find((p) => p.code === 'WELCOME10');
  check('  used stops at 10', promo.used === 10, JSON.stringify(promo));
  const winner = people[credited.findIndex((c) => c === 10000)];
  check('  each credit is a promo entry and the balance', (await balanceOf(winner.id)) === 10000 && (await entries(winner.id)).filter((e) => e.kind === 'promo').length === 1);

  await store.createPromo({ code: 'ONCE', creditVnd: 5000, maxUses: 5, expiresAt: null, createdBy: owner.id });
  const gus = await makeUser();
  check('the first use credits', (await store.redeemPromo('once', gus.id, NOW)) === 5000);
  check('a second use by the same account returns null', (await store.redeemPromo('ONCE', gus.id, NOW)) === null && (await balanceOf(gus.id)) === 5000);
  check('  and does not use up the code', (await store.listPromos()).find((p) => p.code === 'ONCE').used === 1);
  const twice = await makeUser();
  const both = await Promise.all([store.redeemPromo('ONCE', twice.id, NOW), store.redeemPromo('ONCE', twice.id, NOW)]);
  check('  the same account twice at once is credited once', both.filter((c) => c === 5000).length === 1 && (await balanceOf(twice.id)) === 5000 && (await store.listPromos()).find((p) => p.code === 'ONCE').used === 2);
  const hal = await makeUser();
  await store.createPromo({ code: 'OLD', creditVnd: 5000, maxUses: 5, expiresAt: later(-1000), createdBy: owner.id });
  check('never after expires_at', (await store.redeemPromo('OLD', hal.id, NOW)) === null && (await balanceOf(hal.id)) === 0);
  await store.createPromo({ code: 'OFF', creditVnd: 5000, maxUses: 5, expiresAt: null, createdBy: owner.id });
  await store.disablePromo('OFF');
  check('never when disabled', (await store.redeemPromo('OFF', hal.id, NOW)) === null);
  check('a code that does not exist is null', (await store.redeemPromo('NOPE', hal.id, NOW)) === null);
}

section('receipts and e-invoices');
{
  const ivy = await makeUser();
  const year = vnDay(new Date()).slice(0, 4);
  const r1 = await store.createReceipt({ userId: ivy.id, transferId: null, orderId: 'o12', amountVnd: 100000, lines: [{ label: 'Plus', vnd: 100000 }], buyerSealed: 'sealed-buyer' });
  const r2 = await store.createReceipt({ userId: ivy.id, transferId: null, orderId: 'o13', amountVnd: 1, lines: [], buyerSealed: null });
  check('numbers run SZR-<VN year>-000001, 000002', r1.number === `SZR-${year}-000001` && r2.number === `SZR-${year}-000002`, `${r1.number} ${r2.number}`);
  const got = await store.getReceipt(r1.number);
  check('getReceipt returns it, lines as JSON', got.amountVnd === 100000 && got.lines[0].label === 'Plus' && got.buyerSealed === 'sealed-buyer', JSON.stringify(got));
  check("listReceipts is the account's, newest first", (await store.listReceipts(ivy.id)).map((r) => r.number).join() === `${r2.number},${r1.number}`);
  await store.saveEinvoice({ orderId: 'o12', referenceCode: 'ref-1', trackingCode: null, status: 'pending', error: null });
  await store.saveEinvoice({ orderId: 'o13', referenceCode: 'ref-2', trackingCode: 'T', status: 'issued', error: null });
  check('an e-invoice is saved and read', (await store.getEinvoice('o12'))?.referenceCode === 'ref-1');
  await store.saveEinvoice({ orderId: 'o12', referenceCode: 'ref-1', trackingCode: 'T9', status: 'pending', error: 'busy' });
  check('saving again updates by order', (await store.getEinvoice('o12')).trackingCode === 'T9');
  await query("SELECT setval('receipt_seq', 999999)");
  const big1 = await store.createReceipt({ userId: ivy.id, amountVnd: 1, lines: [] });
  const big2 = await store.createReceipt({ userId: ivy.id, amountVnd: 1, lines: [] });
  check('past 999,999 the number grows, it is not cut', big1.number === `SZR-${year}-1000000` && big2.number === `SZR-${year}-1000001`, `${big1.number} ${big2.number}`);
  check('only the unfinished are pending', (await store.listEinvoicesPending()).map((e) => e.orderId).join() === 'o12');
}

section('balances expire 12 months after the last top-up');
{
  const old = await makeUser();
  const fresh = await makeUser();
  const never = await makeUser();
  await store.creditBalance(old.id, 7000, { kind: 'topup', topup: true });
  await store.creditBalance(fresh.id, 8000, { kind: 'topup', topup: true });
  await store.creditBalance(never.id, 9000, { kind: 'promo' });
  await query('UPDATE balances SET last_topup_at = $2 WHERE user_id = $1', [old.id, new Date('2025-11-12T00:00:00Z')]);
  await query('UPDATE balances SET last_topup_at = $2 WHERE user_id = $1', [fresh.id, new Date('2025-11-14T00:00:00Z')]);
  const gone = await store.expireBalances(NOW);
  const mine = gone.filter((g) => [old.id, fresh.id, never.id].includes(g.userId));
  check('only the one past 12 months', mine.length === 1 && mine[0].userId === old.id && mine[0].vnd === 7000, JSON.stringify(mine));
  check('  zeroed, with an expire entry', (await balanceOf(old.id)) === 0 && (await entries(old.id)).some((e) => e.kind === 'expire' && Number(e.delta_vnd) === -7000));
  check('  the others untouched', (await balanceOf(fresh.id)) === 8000 && (await balanceOf(never.id)) === 9000);
  check('  and a second run finds nothing', (await store.expireBalances(NOW)).filter((g) => g.userId === old.id).length === 0);
}

section('credit that is not a top-up does not expire with an old top-up');
{
  const pat = await makeUser();
  await store.creditBalance(pat.id, 7000, { kind: 'topup', topup: true });
  await query('UPDATE balances SET last_topup_at = $2 WHERE user_id = $1', [pat.id, new Date('2025-01-01T00:00:00Z')]);
  check('the old top-up expires', (await store.expireBalances(NOW)).some((g) => g.userId === pat.id && g.vnd === 7000));
  await store.createPromo({ code: 'LATER', creditVnd: 3000, maxUses: 1, expiresAt: null, createdBy: null });
  check('a promo lands on the emptied balance', (await store.redeemPromo('LATER', pat.id, NOW)) === 3000);
  check('  with no expiry clock', (await query('SELECT last_topup_at FROM balances WHERE user_id = $1', [pat.id]))[0].last_topup_at === null);
  await store.expireBalances(NOW);
  check('  so the next run leaves it', (await balanceOf(pat.id)) === 3000);
  await store.creditBalance(pat.id, 100, { kind: 'adjust' });
  await store.refundUsage(pat.id, 'search', 1, 50, '2026-11-13');
  await store.expireBalances(NOW);
  check('  nor does a non-top-up credit or a refund on top of it', (await balanceOf(pat.id)) === 3150);
  await store.creditBalance(pat.id, 1000, { kind: 'topup', topup: true });
  const clock = (await query('SELECT last_topup_at FROM balances WHERE user_id = $1', [pat.id]))[0].last_topup_at;
  check('a real top-up after that starts the 12-month clock', clock instanceof Date && Date.now() - clock.getTime() < 60_000);
  const gone = await store.expireBalances(new Date(Date.now() + 366 * 86400_000));
  check('  and a year on it expires', gone.some((g) => g.userId === pat.id && g.vnd === 4150));
}

section('storage bytes per user');
{
  const kim = await makeUser();
  const lee = await makeUser();
  const mia = await makeUser();
  const file = (id, bytes, origin) => store.createAttachment(kim.id, { id, name: id, mime: 'text/plain', kind: 'text', bytes, data: 'x', origin });
  await file('sb1', 100, 'upload');
  await file('sb2', 50, 'generated');
  await file('sb3', 9999, 'machine');
  await query("INSERT INTO attachment_versions (id, attachment_id, user_id, revision, name, mime, kind, bytes, data) VALUES ('sv1', 'sb2', $1, 1, 'v', 'text/plain', 'text', 25, 'x')", [kim.id]);
  await store.createAttachment(lee.id, { id: 'sb4', name: 'l', mime: 'text/plain', kind: 'text', bytes: 7, data: 'x', origin: 'upload' });
  const sizes = await store.storageBytesByUser([kim.id, lee.id, mia.id]);
  check('a Map of user to bytes, files plus earlier copies, machine files left out', sizes instanceof Map && sizes.get(kim.id) === 175 && sizes.get(lee.id) === 7, JSON.stringify([...sizes]));
  check('  a user with nothing is 0, and agrees with bytesOfUser', sizes.get(mia.id) === 0 && sizes.get(kim.id) === (await store.bytesOfUser(kim.id)));
  check('  an empty list is an empty Map', (await store.storageBytesByUser([])).size === 0);
}

section('the admin figures');
{
  const f = await store.billingAdminFigures(new Date('2026-01-01T00:00:00Z'));
  check('money in by kind, balances held, order counts, database size', f.entries.topup.inVnd > 0 && f.balancesHeldVnd > 0 && f.orders.paid >= 1 && f.orders.pending >= 1 && (f.databaseBytes === null || f.databaseBytes > 0), JSON.stringify(f));
}

section('deleting an account');
{
  const zed = await makeUser();
  await store.creditBalance(zed.id, 6000, { kind: 'topup', topup: true });
  await store.createOrder(order('o90', zed.id));
  await store.setBillingProfile(zed.id, 'sealed-zed');
  await store.saveSubscription({ userId: zed.id, plan: 'plus', period: 'month', status: 'active', periodStart: NOW, periodEnd: later(86400_000), paidVnd: 1 });
  const tr = await store.recordTransfer({ dedupe: 'ref:ZED', amountVnd: 6000, outcome: 'topup', via: 'webhook', userId: zed.id });
  const rc = await store.createReceipt({ userId: zed.id, transferId: tr.id, orderId: 'o90', amountVnd: 6000, lines: [], buyerSealed: 'sealed-buyer' });
  await store.deleteUser(zed.id);
  const forfeit = await query("SELECT * FROM balance_entries WHERE kind = 'forfeit' AND note = 'account deleted'");
  check('a forfeit entry for the balance, now with no user', forfeit.length === 1 && forfeit[0].user_id === null && Number(forfeit[0].delta_vnd) === -6000, JSON.stringify(forfeit));
  check('the balance, profile and subscription are gone', (await query('SELECT 1 FROM balances WHERE user_id = $1', [zed.id])).length === 0 && (await store.getBillingProfile(zed.id)) === null && (await store.getSubscription(zed.id)) === null);
  const o = await store.getOrder('o90');
  const t = await store.getTransfer(tr.id);
  const r = await store.getReceipt(rc.number);
  check('the order, transfer and receipt are kept, with no user', o && o.userId === null && t && t.userId === null && r && r.userId === null);
  check('  and the receipt no longer carries the buyer', r.buyerSealed === null);
  const total = (await query('SELECT (SELECT COALESCE(SUM(vnd), 0) FROM balances) AS b, (SELECT COALESCE(SUM(delta_vnd), 0) FROM balance_entries) AS e'))[0];
  check('all balances still equal all entries, the deleted account forfeit included', Number(total.b) === Number(total.e), JSON.stringify(total));
  await store.deleteUser((await makeUser()).id);
  check('an account with no balance deletes without a forfeit', (await query("SELECT 1 FROM balance_entries WHERE kind = 'forfeit'")).length === 1);
}

section('after everything, every balance equals the sum of its entries');
{
  const rows = await query('SELECT b.user_id, b.vnd, COALESCE((SELECT SUM(delta_vnd) FROM balance_entries e WHERE e.user_id = b.user_id), 0) AS s FROM balances b');
  const bad = rows.filter((r) => Number(r.vnd) !== Number(r.s));
  check(`${rows.length} balances checked`, rows.length > 10 && bad.length === 0, JSON.stringify(bad));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
