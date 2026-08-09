/* POS retail-mirror regression — proves a live posTransactions sale maps to a canonical
   posRetailSales doc whose shape OrderService (_fromRetailSale) reads correctly, so a POS
   sale is CANONICAL + cross-device readable (Gap B). Round-trip: txn → mirror → OrderService
   posProvider → unified row. No stock/payment side effects live in the mirror (proven by shape). */
'use strict';
const path = require('path');
const { mapTxnToRetail } = require(path.join(__dirname, '..', 'functions', 'pos-retail-mirror-map.js'));
global.window = {};
require(path.join(__dirname, '..', 'sokoni-order-service.js'));
const OS = global.window.SokoniOrderService;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };
const now = Date.now();

/* A live posTransactions doc (pos.js checkout shape + sync-enriched sellerId + PosDB branchId). */
const txn = {
  id: 'txn_KASS_1', sellerId: 'KASSUID', branchId: 'main',
  items: [{ name: 'Milk', qty: 2, unitPrice: 60 }, { productName: 'Bread', quantity: 1, price: 55 }],
  subtotal: 175, discountAmount: 0, taxAmount: 0, total: 175,
  paymentMethod: 'cash', cashierId: 'c1', cashierName: 'Jane', customerName: 'Walk-in',
  status: 'completed', timestamp: now,
};

const mirror = mapTxnToRetail(txn, txn.id);

/* ── Mirror shape ── */
ok(mirror.id === 'txn_KASS_1', 'mirror id = txn id (deterministic → idempotent doc)');
ok(mirror.merchantId === 'KASSUID' && mirror.sellerId === 'KASSUID', 'merchantId + sellerId both = seller (read rule + query both pass)');
ok(mirror.branchId === 'main', 'branchId carried (branch isolation)');
ok(mirror.grandTotal === 175 && mirror.subtotal === 175, 'totals mapped');
ok(mirror.items.length === 2 && mirror.items[0].name === 'Milk' && mirror.items[0].qty === 2 && mirror.items[0].unitPrice === 60, 'items[] mapped (name/qty/unitPrice)');
ok(mirror.items[1].name === 'Bread' && mirror.items[1].qty === 1 && mirror.items[1].unitPrice === 55, 'alt item field names (productName/quantity/price) mapped');
ok(mirror.payments[0].method === 'cash', 'payment method mapped');
ok(mirror.status === 'completed', 'status mapped');
ok(mirror.source === 'pos-mirror', 'provenance = pos-mirror (no side effects)');
/* No stock/payment execution fields leak into the mirror. */
ok(!('stock' in mirror) && !('inventoryVersion' in mirror) && !('amountPaid' in mirror) && !('change' in mirror), 'mirror carries NO stock/payment-execution fields (no double-deduct/charge)');

/* ── Round-trip: the mirror is readable by OrderService as a POS sale ── */
OS.setPosProvider(() => [mirror]);
(async () => {
  const rows = await OS.query({ range: 'all', tab: 'all' });
  const r = rows.find(x => x.canonicalId === 'txn_KASS_1');
  ok(r && r.source === 'pos', 'OrderService reads the mirror as a POS sale (cross-device visible)');
  ok(r && r.total === 175, 'unified total = 175 (contributes to Analytics revenue)');
  ok(r && r.branchId === 'main', 'unified row keeps branch scope');
  ok(r && r.items && r.items[0].name === 'Milk', 'unified items preserved');

  /* Branch scope: another branch cannot see it. */
  const inOther = (await OS.query({ range: 'all', tab: 'all', branchId: 'branchB' })).filter(x => x.source === 'pos');
  ok(!inOther.some(x => x.canonicalId === 'txn_KASS_1'), 'main-branch sale not visible under branchB (no leak)');

  /* Refund status maps through. */
  const refundMirror = mapTxnToRetail({ id: 'r1', sellerId: 'KASSUID', total: 50, status: 'refunded', timestamp: now, items: [] }, 'r1');
  ok(refundMirror.status === 'refunded', 'a refunded txn mirrors as refunded');

  console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
