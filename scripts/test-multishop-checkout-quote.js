/* ============================================================================
   Test — Multi-Shop Checkout Quote (server-authoritative)
   ============================================================================
   Pure node, no emulator. Proves the foundation the checkout/payment agent will
   consume: multi-shop basket → per-shop groups → INDEPENDENT delivery fees →
   one consolidated authoritative quote → correct totals, plus the money-safety
   invariants (never-free-by-default, client price never trusted, revalidation
   catches drift/expiry). Order creation itself is the payment path's job; this
   proves the per-shop breakdown that produces separate orders.
   ========================================================================= */
'use strict';
const Q = require('../functions/multishop-checkout-quote.js');

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   ' + JSON.stringify(extra) : '')); }
}
function throws(name, fn) {
  let threw = false; try { fn(); } catch (e) { threw = true; }
  ck(name, threw);
}

/* Fixed clock + id so the quote is deterministic. */
const NOW = 1_700_000_000_000;
const DET = { now: NOW, ttlMs: 15 * 60 * 1000, genId: () => 'q_test_1' };

/* Seller delivery configs — each shop's own policy, priced by the shared engine. */
const sellerConfigs = {
  s_njeri: { shopName: "Mama Njeri Grocers", deliveryConfig: { enabled: true, mode: 'flat', defaultFee: 150, freeAbove: 2000 } },
  s_tech:  { shopName: "TechHub Kenya",      deliveryConfig: { enabled: true, mode: 'flat', defaultFee: 300 } },
  s_bloom: { shopName: "Bloom & Petal",      deliveryConfig: { enabled: true, mode: 'free' } },
};

console.log('\nA. Core: 3 shops, delivery requested, independent per-shop fees');
{
  const lines = [
    { productId: 'p1', name: 'Sukuma Wiki', qty: 2, unitPrice: 750,  sellerUid: 's_njeri' }, // 1500
    { productId: 'p3', name: 'Earbuds',     qty: 1, unitPrice: 8000, sellerUid: 's_tech'  }, // 8000
    { productId: 'p4', name: 'Roses',       qty: 2, unitPrice: 750,  sellerUid: 's_bloom' }, // 1500
    { productId: 'p5', name: 'Milk',        qty: 3, unitPrice: 65,   sellerUid: 's_njeri' }, // 195  → njeri 1695
  ];
  const q = Q.assembleQuote({ validatedLines: lines, sellerConfigs, order: { fulfillmentType: 'delivery' }, ...DET });
  const njeri = q.shops.find(s => s.sellerUid === 's_njeri');
  const tech  = q.shops.find(s => s.sellerUid === 's_tech');
  const bloom = q.shops.find(s => s.sellerUid === 's_bloom');

  ck('3 shop groups', q.shopCount === 3, { shopCount: q.shopCount });
  ck('Njeri itemTotal 1695 (grouped across two lines)', njeri.itemTotal === 1695, { got: njeri.itemTotal });
  /* MARKETPLACE DELIVERY AUTHORITY = the RES-1 server-issued quote (owner decision 2026-09-27).
     These shops still carry seller deliveryConfig (flat 150 / flat 300 / mode free) — deliberately:
     the assertions prove that config now has NO effect. A multi-shop basket has no RES-1 quote, so
     delivery is UNPRICED — never a seller figure, never 0, never "free". */
  const unpriced = (d) => d.available === false && d.fee === null && d.free === false && d.reason === 'res1_quote_required';
  ck('Njeri (seller flat 150) delivery is UNPRICED, not 150', unpriced(njeri.delivery), njeri.delivery);
  ck('Tech (seller flat 300) delivery is UNPRICED, not 300', unpriced(tech.delivery), tech.delivery);
  ck('Bloom (seller mode:free) is NOT free — seller config is not authoritative', unpriced(bloom.delivery), bloom.delivery);
  ck('three different seller configs produce the SAME unpriced answer', [njeri, tech, bloom].every((x) => unpriced(x.delivery)));
  ck('Njeri shopTotal = items only (1695)', njeri.shopTotal === 1695, { got: njeri.shopTotal });
  ck('Tech shopTotal = items only (8000)', tech.shopTotal === 8000, { got: tech.shopTotal });
  ck('Bloom shopTotal 1500', bloom.shopTotal === 1500, { got: bloom.shopTotal });
  ck('itemsTotal 11195', q.itemsTotal === 11195, { got: q.itemsTotal });
  ck('deliveryTotal is UNKNOWN (null), not 0 and not a seller sum', q.deliveryTotal === null, { got: q.deliveryTotal });
  ck('grandTotal = the items the basket actually charges (11195)', q.grandTotal === 11195, { got: q.grandTotal });
  ck('deliveryPriced is false', q.deliveryPriced === false, { got: q.deliveryPriced });
  ck('quote is authoritative + time-boxed', q.authoritative === true && q.expiresAt === NOW + DET.ttlMs);
  ck('allDeliverable false — no shop may take a delivery order without a RES-1 quote', q.allDeliverable === false);
}

console.log('\nB. Never free by default: a shop with NO delivery config, delivery requested');
{
  const lines = [{ productId: 'x', qty: 1, unitPrice: 500, sellerUid: 's_none' }];
  const q = Q.assembleQuote({ validatedLines: lines, sellerConfigs: {}, order: { fulfillmentType: 'delivery' }, ...DET });
  const shop = q.shops[0];
  ck('unconfigured shop is available:false', shop.delivery.available === false, shop.delivery);
  ck('reason is res1_quote_required (NOT free)', shop.delivery.reason === 'res1_quote_required' && shop.delivery.free === false, shop.delivery);
  ck('no phantom delivery charge: fee unknown (null), shopTotal = items', shop.delivery.fee === null && shop.shopTotal === 500);
  ck('allDeliverable false when a shop cannot deliver', q.allDeliverable === false);
}

console.log('\nC. The seller freeAbove threshold no longer prices marketplace delivery');
{
  const cfg = { s_thr: { shopName: 'Thresh', deliveryConfig: { enabled: true, mode: 'flat', defaultFee: 200, freeAbove: 2000 } } };
  const below = Q.assembleQuote({ validatedLines: [{ productId: 'a', qty: 1, unitPrice: 1500, sellerUid: 's_thr' }], sellerConfigs: cfg, order: { fulfillmentType: 'delivery' }, ...DET });
  const above = Q.assembleQuote({ validatedLines: [{ productId: 'a', qty: 1, unitPrice: 2500, sellerUid: 's_thr' }], sellerConfigs: cfg, order: { fulfillmentType: 'delivery' }, ...DET });
  /* The seller's freeAbove threshold no longer decides anything for marketplace delivery. */
  ck('below the seller threshold: not charged the seller 200 — unpriced', below.shops[0].delivery.fee === null && below.shops[0].delivery.reason === 'res1_quote_required');
  ck('above the seller threshold: not made free by it — unpriced', above.shops[0].delivery.fee === null && above.shops[0].delivery.free === false && above.shops[0].delivery.reason === 'res1_quote_required');
}

console.log('\nD. A distance-mode seller config no longer prices marketplace delivery');
{
  const cfg = { s_dist: { deliveryConfig: { enabled: true, mode: 'distance', baseFee: 80, perKm: 15 } } };
  const q = Q.assembleQuote({ validatedLines: [{ productId: 'a', qty: 1, unitPrice: 1000, sellerUid: 's_dist' }], sellerConfigs: cfg, order: { fulfillmentType: 'delivery', distanceKm: 4 }, ...DET });
  ck('a distance-mode seller config (80 + 15/km) does NOT price it — unpriced', q.shops[0].delivery.fee === null && q.shops[0].delivery.reason === 'res1_quote_required', q.shops[0].delivery);
}

console.log('\nE. Pickup: no delivery charge, and it is NOT labelled free');
{
  const lines = [{ productId: 'a', qty: 1, unitPrice: 1000, sellerUid: 's_njeri' }];
  const q = Q.assembleQuote({ validatedLines: lines, sellerConfigs, order: { fulfillmentType: 'pickup' }, ...DET });
  ck('pickup fee 0', q.shops[0].delivery.fee === 0);
  ck('pickup reason is pickup (not free)', q.shops[0].delivery.reason === 'pickup' && q.shops[0].delivery.free === false);
  ck('deliveryTotal 0, grandTotal == itemsTotal', q.deliveryTotal === 0 && q.grandTotal === q.itemsTotal);
}

console.log('\nF. Client money is never trusted');
{
  throws('rejects a line with no server unitPrice', () =>
    Q.assembleQuote({ validatedLines: [{ productId: 'a', qty: 1, unitPrice: 0, sellerUid: 's_njeri' }], sellerConfigs, order: {}, ...DET }));
  throws('rejects a line whose seller the server could not resolve', () =>
    Q.assembleQuote({ validatedLines: [{ productId: 'a', qty: 1, unitPrice: 100 }], sellerConfigs, order: {}, ...DET }));
  throws('rejects an empty basket', () =>
    Q.assembleQuote({ validatedLines: [], sellerConfigs, order: {}, ...DET }));
}

console.log('\nG. Revalidation gate (payment must call before charging)');
{
  const lines = [
    { productId: 'p1', qty: 2, unitPrice: 750,  sellerUid: 's_njeri' },
    { productId: 'p3', qty: 1, unitPrice: 8000, sellerUid: 's_tech'  },
  ];
  const fresh = { validatedLines: lines, sellerConfigs, order: { fulfillmentType: 'delivery' } };
  const q = Q.assembleQuote({ ...fresh, ...DET });

  const good = Q.revalidateQuote(q, fresh, { now: NOW + 60_000 });
  ck('unchanged basket revalidates ok', good.ok === true);

  const tampered = Object.assign({}, q, { grandTotal: 0 });
  const drift = Q.revalidateQuote(tampered, fresh, { now: NOW + 60_000 });
  ck('a tampered stored total is rejected (amount_drift)', drift.ok === false && drift.reason === 'amount_drift', drift);

  const expired = Q.revalidateQuote(q, fresh, { now: q.expiresAt + 1 });
  ck('an expired quote is rejected', expired.ok === false && expired.reason === 'expired', expired);

  const priceChanged = Q.revalidateQuote(q, {
    validatedLines: [{ productId: 'p1', qty: 2, unitPrice: 900, sellerUid: 's_njeri' }, { productId: 'p3', qty: 1, unitPrice: 8000, sellerUid: 's_tech' }],
    sellerConfigs, order: { fulfillmentType: 'delivery' },
  }, { now: NOW + 60_000 });
  ck('a server price change since quoting is rejected (amount_drift)', priceChanged.ok === false && priceChanged.reason === 'amount_drift', priceChanged);
}

console.log('\nH. makeCreateQuote wires injected deps without touching peer code');
{
  const calls = { validate: 0, cfg: 0, persist: 0 };
  const create = Q.makeCreateQuote({
    validateLines: async (uid, items) => { calls.validate++; return [
      { productId: 'p1', qty: 1, unitPrice: 1000, sellerUid: 's_njeri' },
      { productId: 'p3', qty: 1, unitPrice: 2000, sellerUid: 's_tech'  },
    ]; },
    readSellerConfigs: async (uids) => { calls.cfg++; return sellerConfigs; },
    persistQuote: async (quote) => { calls.persist++; },
    now: NOW, ttlMs: DET.ttlMs, genId: () => 'q_wire_1',
  });
  let out;
  const run = create('user123', { items: [{ id: 'p1', qty: 1 }, { id: 'p3', qty: 1 }], fulfillmentType: 'delivery' })
    .then(q => { out = q; });
  // resolve the promise chain synchronously enough for a simple script
  run.then(() => {
    ck('validateLines, readSellerConfigs, persistQuote all invoked', calls.validate === 1 && calls.cfg === 1 && calls.persist === 1, calls);
    ck('wired quote has 2 shops + a grandTotal', out && out.shopCount === 2 && out.grandTotal > 0, out && { shops: out.shopCount, grand: out.grandTotal });
    finish();
  });
}

function finish() {
  console.log('\n======================================================================');
  console.log('Multi-Shop Checkout Quote');
  console.log('  TOTAL:  ' + (pass + fail));
  console.log('  PASSED: ' + pass);
  console.log('  FAILED: ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
