/* Product-visibility regression — locks the canonical "active product" predicate so an
   archived product can NEVER inflate an active count again (the "103 after deleting 2" bug),
   and a legacy product with no status is NEVER wrongly hidden (the 92/103 trap). */
'use strict';
const path = require('path');
const V = require(path.join(__dirname, '..', 'sokoni-product-visibility.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* ── Active vs archived ── */
ok(V.isActiveProduct({ status: 'active' }) === true, 'status:active → active');
ok(V.isActiveProduct({}) === true, 'NO status field → active (legacy KASS products; absent = active)');
ok(V.isActiveProduct({ name: 'X', price: 10 }) === true, 'a real legacy product with no status/isVisible → active');
ok(V.isActiveProduct({ status: 'archived' }) === false, 'status:archived → NOT active (deleted product)');
ok(V.isActiveProduct({ status: 'ARCHIVED' }) === false, 'status case-insensitive');
['deleted', 'removed', 'hidden', 'draft', 'banned', 'suspended', 'paused', 'inactive', 'rejected'].forEach(s =>
  ok(V.isActiveProduct({ status: s }) === false, 'status:' + s + ' → NOT active'));
ok(V.isActiveProduct({ isVisible: false }) === false, 'isVisible:false → NOT active');
ok(V.isActiveProduct({ visible: false }) === false, 'visible:false → NOT active');
ok(V.isActiveProduct({ isDeleted: true }) === false, 'isDeleted:true → NOT active');
ok(V.isActiveProduct({ deleted: true }) === false, 'deleted:true → NOT active');
ok(V.isActiveProduct(null) === false, 'null → not active (no crash)');

/* ── The exact bug scenario: 103 docs, archive 2 → active count 101 ── */
const catalogue = [];
for (let i = 0; i < 101; i++) catalogue.push({ id: 'P' + i, name: 'Item ' + i });          /* legacy, no status → active */
catalogue.push({ id: 'A1', status: 'archived' });                                            /* just deleted */
catalogue.push({ id: 'A2', status: 'archived' });                                            /* just deleted */
ok(catalogue.length === 103, 'shop has 103 total product docs');
ok(V.countActive(catalogue) === 101, 'active count EXCLUDES the 2 archived → 101 (was the 103 bug)');
ok(V.activeOnly(catalogue).every(p => p.id !== 'A1' && p.id !== 'A2'), 'archived products are not in the active list');
ok(V.isArchived({ status: 'archived' }) === true && V.isArchived({}) === false, 'isArchived is the inverse');

/* ── Predicate MUST match the catalogue Cloud Function HIDDEN set (drift guard) ── */
const CF_HIDDEN = ['deleted', 'removed', 'hidden', 'draft', 'archived', 'banned', 'suspended', 'paused', 'inactive', 'rejected'];
ok(JSON.stringify(V.HIDDEN.slice().sort()) === JSON.stringify(CF_HIDDEN.slice().sort()),
   'client HIDDEN set matches the /api/catalogue server set (no drift)');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
