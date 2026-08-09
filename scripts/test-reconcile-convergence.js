/* Data-convergence test — proves SokoniReconcile correctly MEASURES drift between the
   canonical products and their caches, and between order sources and the unified view.
   Pure logic, deterministic (mirrors test-availability-enforcement.js). */
'use strict';
const path = require('path');
global.window = {};
require(path.join(__dirname, '..', 'sokoni-reconcile.js'));
const R = global.window.SokoniReconcile;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

ok(R && typeof R.productConvergence === 'function' && typeof R.orderConvergence === 'function', 'SokoniReconcile exposes pure convergence fns');

/* ── Products: perfectly converged ── */
const canon = [
  { id: 'P1', name: 'Milk', price: 100, stock: 10 },
  { id: 'P2', name: 'Bread', price: 50, stock: 5 },
];
const posOk  = [{ id: 'P1', name: 'Milk', price: 100, stock: 10 }, { id: 'P2', name: 'Bread', price: 50, stock: 5 }];
const invOk  = [{ sourceProductId: 'P1', name: 'Milk', sellingPrice: 100, stockLevel: 10 }, { sourceProductId: 'P2', name: 'Bread', sellingPrice: 50, stockLevel: 5 }];
let c = R.productConvergence(canon, posOk, invOk);
ok(c.canonical === 2 && c.posCache === 2 && c.inventory === 2, 'counts each source');
ok(c.missing === 0 && c.mismatched === 0 && c.orphans === 0 && c.ok === true, 'fully converged → ok');

/* ── Products: a missing POS mirror + a price mismatch in inventory ── */
const posMissing = [{ id: 'P1', name: 'Milk', price: 100, stock: 10 }];          /* P2 missing from POS */
const invStale   = [{ sourceProductId: 'P1', name: 'Milk', sellingPrice: 100, stockLevel: 10 },
                    { sourceProductId: 'P2', name: 'Bread', sellingPrice: 999, stockLevel: 5 }]; /* price drift */
c = R.productConvergence(canon, posMissing, invStale);
ok(c.missing === 1, 'detects missing POS mirror for P2');
ok(c.mismatched === 1, 'detects inventory price mismatch for P2');
ok(c.ok === false, 'drift → not ok');

/* ── Products: an orphan cache row (in mirror, not canonical) ── */
const posOrphan = posOk.concat([{ id: 'GHOST', name: 'x', price: 1, stock: 1 }]);
c = R.productConvergence(canon, posOrphan, invOk);
ok(c.orphans === 1, 'detects orphan cache row not in canonical');

/* ── Orders: unified, no dupes/orphans ── */
let o = R.orderConvergence(
  [{ id: 'O1' }, { id: 'O2' }],          /* marketplace */
  [{ id: 'T1' }],                        /* pos */
  [{ orderId: 'O1' }]                    /* delivery attaches to O1 */
);
ok(o.marketplace === 2 && o.pos === 1 && o.deliveries === 1, 'order source counts');
ok(o.unified === 3 && o.duplicates === 0 && o.orphans === 0 && o.ok === true, 'three identities, no dupes/orphans');

/* ── Orders: an orphan delivery (order unknown) ── */
o = R.orderConvergence([{ id: 'O1' }], [], [{ orderId: 'GHOST' }]);
ok(o.orphans === 1 && o.ok === false, 'delivery whose order is unknown → orphan');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
