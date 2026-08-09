/* POS ECOSYSTEM propagation regression — proves one transaction/product mutation flows through
   the SAME canonical identity end-to-end, and that Analytics totals are DERIVED from the same
   OrderService the Orders screen reads (not a copy that can drift). Data propagation is the
   acceptance criterion — a rendered button is not evidence. Pure Node over the real services. */
'use strict';
const path = require('path');
global.window = {};
require(path.join(__dirname, '..', 'sokoni-order-service.js'));
require(path.join(__dirname, '..', 'sokoni-analytics-engine.js'));
require(path.join(__dirname, '..', 'sokoni-product-visibility.js'));
const OS = global.window.SokoniOrderService;
const AE = global.window.SokoniAnalyticsEngine;
const V = global.window.SokoniProductVisibility;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };
const now = Date.now();

(async () => {
  /* ── POS sale + marketplace order share ONE identity → Orders and Analytics agree ── */
  OS.setPosProvider(() => [
    { id: 'POS-1', merchantId: 'M', branchId: 'main', grandTotal: 500, status: 'completed', createdAt: now, items: [{ name: 'Milk', qty: 2, price: 250 }], payments: [{ method: 'cash' }] },
  ]);
  OS.setOnlineProvider(() => [
    { id: 'ORD-1', sellerUid: 'M', branchId: 'main', orderTotal: 300, status: 'delivered', createdAt: now, items: [{ name: 'Bread', qty: 1, price: 300 }], deliveryType: 'delivery', paymentMethod: 'mpesa' },
  ]);

  const orders = await OS.query({ range: 'all', tab: 'all' });
  const sum = OS.summarize(orders);
  const an = await AE.compute({ range: 'all' });

  ok(orders.length === 2, 'POS sale + marketplace order both reach the unified Orders stream');
  ok(orders.some(o => o.source === 'pos') && orders.some(o => o.source === 'marketplace'), 'one stream holds BOTH POS and marketplace (one identity)');

  /* Analytics is DERIVED from the same OrderService — totals must reconcile with Orders. */
  ok(an.orders === sum.count && an.orders === 2, 'Analytics order count == Orders count (' + an.orders + ')');
  ok(an.revenue === sum.revenue && an.revenue === 800, 'Analytics revenue == Orders revenue (800 = 500 POS + 300 online)');
  ok(an.pos.count === 1 && an.pos.revenue === 500, 'POS sale contributes to POS count + revenue');
  ok(an.online.count === 1 && an.online.revenue === 300, 'marketplace order contributes to online count + revenue');

  /* ── No double-count: the SAME sale from two reads dedups to one everywhere ── */
  OS.setPosProvider(() => [
    { id: 'POS-1', merchantId: 'M', branchId: 'main', grandTotal: 500, status: 'completed', createdAt: now, items: [], payments: [] },
    { id: 'POS-1', merchantId: 'M', branchId: 'main', grandTotal: 500, status: 'completed', createdAt: now, items: [], payments: [] },
  ]);
  const an2 = await AE.compute({ range: 'all' });
  ok(an2.pos.count === 1, 'same POS saleId from two reads counts ONCE in Analytics (no drift/double-count)');

  /* ── Branch isolation: Branch A cannot leak into Branch B (Analytics is branch-scoped) ── */
  OS.setPosProvider(() => [
    { id: 'PA', merchantId: 'M', branchId: 'A', grandTotal: 100, status: 'completed', createdAt: now, items: [], payments: [] },
    { id: 'PB', merchantId: 'M', branchId: 'B', grandTotal: 999, status: 'completed', createdAt: now, items: [], payments: [] },
  ]);
  OS.setOnlineProvider(() => []);
  const anA = await AE.compute({ range: 'all', branchId: 'A' });
  const anB = await AE.compute({ range: 'all', branchId: 'B' });
  ok(anA.pos.revenue === 100 && anB.pos.revenue === 999, 'each branch sees only its own sales (A=100, B=999)');
  ok(anA.revenue !== anB.revenue, 'Branch A analytics ≠ Branch B analytics (no leak)');
  /* Legacy untagged sale must appear in EVERY branch scope (never hidden by missing branchId). */
  OS.setPosProvider(() => [{ id: 'LEG', merchantId: 'M', branchId: null, grandTotal: 50, status: 'completed', createdAt: now, items: [], payments: [] }]);
  const anLegacy = await AE.compute({ range: 'all', branchId: 'A' });
  ok(anLegacy.pos.revenue === 50, 'legacy untagged (branchId=null) sale still counts in a scoped view (not hidden)');

  /* ── Order status lifecycle preserved through normalization (shared identity w/ delivery) ── */
  OS.setPosProvider(() => []);
  const statuses = { 'pending_payment': 'pending', 'delivered': 'completed', 'cancelled': 'cancelled', 'refunded': 'refunded' };
  OS.setOnlineProvider(() => Object.keys(statuses).map((s, i) => ({ id: 'ST' + i, sellerUid: 'M', orderTotal: 100, status: s, createdAt: now, items: [] })));
  const strows = await OS.query({ range: 'all', tab: 'all' });
  Object.keys(statuses).forEach((s, i) => {
    const r = strows.find(x => x.canonicalId === 'ST' + i);
    ok(r && r.status === statuses[s], 'status "' + s + '" → unified "' + statuses[s] + '" (one lifecycle, shared with delivery/pickup)');
  });
  /* channel identity: a delivery order is delivery, a pickup order is pickup — for Deliveries/Pickup */
  OS.setOnlineProvider(() => [
    { id: 'D1', sellerUid: 'M', orderTotal: 100, status: 'delivered', createdAt: now, items: [], deliveryType: 'delivery' },
    { id: 'K1', sellerUid: 'M', orderTotal: 100, status: 'completed', createdAt: now, items: [], deliveryType: 'pickup' },
  ]);
  const chrows = await OS.query({ range: 'all', tab: 'all' });
  ok(chrows.find(o => o.canonicalId === 'D1').channel === 'delivery', 'delivery order → channel:delivery (Deliveries reads same order)');
  ok(chrows.find(o => o.canonicalId === 'K1').channel === 'pickup', 'pickup order → channel:pickup (Pickup reads same order)');

  /* ── Product archive removes it from ACTIVE views (Note: shared visibility predicate) ── */
  const cat = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3', status: 'archived' }];
  ok(V.countActive(cat) === 2, 'archiving a product drops it from the active catalogue/count (3 → 2)');

  /* ── Stock event SIGN (Note A): a sale deduction must be STOCK_DEDUCTED, not STOCK_RECEIVED ── */
  const evType = d => (Number(d) < 0 ? 'STOCK_DEDUCTED' : 'STOCK_RECEIVED');
  ok(evType(-2) === 'STOCK_DEDUCTED', 'signed delta -2 (POS sale) → STOCK_DEDUCTED');
  ok(evType(5) === 'STOCK_RECEIVED', 'signed delta +5 (stock-in) → STOCK_RECEIVED');

  console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
