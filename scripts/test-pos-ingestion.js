/* POS ingestion regression — proves the authoritative backend POS sale (posRetailSales)
   flows through OrderService into the unified stream, dedups against its local IndexedDB
   twin, and respects branch scope. This is the pipeline that was silently broken:
   posRetailSales existed but nothing read it, so Merchant Analytics had no POS sales. */
'use strict';
const path = require('path');
global.window = {};            /* no indexedDB in node → local-POS read is skipped, provider path runs */
require(path.join(__dirname, '..', 'sokoni-order-service.js'));
const OS = global.window.SokoniOrderService;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };
const now = Date.now();

ok(typeof OS.setPosProvider === 'function' && typeof OS.hasPosProvider === 'function', 'OrderService exposes the POS provider API');

/* An authoritative posRetailSales record (as posCompleteCheckout writes it). */
OS.setPosProvider(function () {
  return [
    { id: 'KASS-SALE-1', merchantId: 'S1', branchId: 'main', grandTotal: 500, status: 'completed', createdAt: now, items: [{ name: 'Milk', qty: 2, price: 250 }], customer: { name: 'Walk-in' }, payments: [{ method: 'cash' }] },
    { id: 'KASS-SALE-2', merchantId: 'S1', branchId: 'branchB', grandTotal: 300, status: 'completed', createdAt: now, items: [{ name: 'Bread', qty: 1, price: 300 }], payments: [{ method: 'mpesa' }] },
  ];
});

(async () => {
  let rows = await OS.query({ range: 'all', tab: 'all' });
  let pos = rows.filter(r => r.source === 'pos');
  ok(pos.length === 2, 'both authoritative POS sales reach the unified stream');
  const s1 = pos.filter(p => p.canonicalId === 'KASS-SALE-1')[0];
  ok(s1 && s1.total === 500 && s1.branchId === 'main' && s1.status === 'completed', 'sale mapped with correct total/branch/status');
  ok(s1.paymentMethod === 'cash' && s1.items[0].name === 'Milk', 'payment + items mapped');

  /* Branch scope: main sees only its own POS sale; branchB never sees main's. */
  const inMain = (await OS.query({ range: 'all', tab: 'all', branchId: 'main' })).filter(r => r.source === 'pos');
  ok(inMain.length === 1 && inMain[0].canonicalId === 'KASS-SALE-1', 'branch=main → only main sale (Shop A isolated)');
  const inB = (await OS.query({ range: 'all', tab: 'all', branchId: 'branchB' })).filter(r => r.source === 'pos');
  ok(inB.length === 1 && inB[0].canonicalId === 'KASS-SALE-2', 'branch=branchB → only its sale (no cross-branch leak)');

  /* Dedup: an online provider re-pushing the same sale id must not double-count POS. Here we
     simulate the local IndexedDB twin arriving with the SAME saleId via a second provider read
     — the (source+canonicalId) dedup collapses them to one. */
  OS.setPosProvider(function () {
    return [
      { id: 'KASS-SALE-1', merchantId: 'S1', branchId: 'main', grandTotal: 500, status: 'completed', createdAt: now, items: [], payments: [] },
      { id: 'KASS-SALE-1', merchantId: 'S1', branchId: 'main', grandTotal: 500, status: 'completed', createdAt: now, items: [], payments: [] },
    ];
  });
  rows = await OS.query({ range: 'all', tab: 'all' });
  ok(rows.filter(r => r.source === 'pos').length === 1, 'same saleId from two reads dedups to ONE (no double-count)');

  console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
