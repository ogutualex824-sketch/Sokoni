/* Branch-isolation test — proves the core rule: Shop A must never display Shop B's
   records, while untagged legacy records stay visible until backfill. Covers the
   OrderService branch-filter predicate and SokoniReconcile.branchIsolation. Pure. */
'use strict';
const path = require('path');
global.window = {};
require(path.join(__dirname, '..', 'sokoni-reconcile.js'));
const R = global.window.SokoniReconcile;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* The OrderService read-filter predicate (mirror of sokoni-order-service.js getAll):
   keep a row when no active branch scope, OR the row is untagged legacy, OR it matches. */
function branchFilter (rows, branchId) {
  if (!branchId) return rows;
  return rows.filter(function (o) { return o.branchId == null || o.branchId === branchId; });
}

const rows = [
  { id: 'A1', branchId: 'shopA', total: 100 },
  { id: 'A2', branchId: 'shopA', total: 200 },
  { id: 'B1', branchId: 'shopB', total: 999 },
  { id: 'L1', branchId: null,    total: 50 },   /* legacy, untagged */
];

/* ── Read-filter isolation ── */
const inA = branchFilter(rows, 'shopA').map(r => r.id);
ok(inA.indexOf('B1') === -1, 'Shop A view EXCLUDES Shop B records (no leakage)');
ok(inA.indexOf('A1') > -1 && inA.indexOf('A2') > -1, 'Shop A view includes its own records');
ok(inA.indexOf('L1') > -1, 'legacy untagged record stays visible until backfill (no data loss)');
const inB = branchFilter(rows, 'shopB').map(r => r.id);
ok(inB.indexOf('A1') === -1 && inB.indexOf('A2') === -1, 'Shop B view EXCLUDES Shop A records');
ok(inB.indexOf('B1') > -1, 'Shop B sees its own record');
ok(branchFilter(rows, null).length === 4, 'no active branch → all records (backward compatible)');

/* Analytics A ≠ Analytics B when data differs (revenue by branch is disjoint). */
const revA = branchFilter(rows, 'shopA').reduce((s, r) => s + r.total, 0);
const revB = branchFilter(rows, 'shopB').reduce((s, r) => s + r.total, 0);
ok(revA !== revB, 'branch revenue differs (A=' + revA + ', B=' + revB + ') → analytics isolated');

/* ── Reconcile branch-isolation report ── */
let iso = R.branchIsolation(rows, 'shopA');
ok(iso.active === 2 && iso.other === 1 && iso.untagged === 1, 'branchIsolation counts active/other/untagged');
ok(iso.leakage === true && iso.ok === false, 'flags leakage when other-branch records present (unscoped view would leak)');
ok(iso.branches === 2, 'reports distinct branch count');

/* A cleanly-scoped set (only active branch + legacy) shows no leakage. */
iso = R.branchIsolation([{ branchId: 'shopA' }, { branchId: null }], 'shopA');
ok(iso.leakage === false && iso.ok === true, 'no other-branch records → no leakage');

/* ── Backfill decision (never blind-assign; audit the ambiguous) ── */
const shops2 = { shops: [{ id: 'a' }, { id: 'b', isMain: true }] };
ok(R.determineBranch({ branchId: 'shopB' }, { shops: [{ id: 'a' }] }).branchId === 'shopB', 'backfill NEVER overwrites an existing branchId');
ok(R.determineBranch({ raw: { shopId: 'shopX' } }, shops2).reason === 'existing-ref', 'uses an existing shop ref on the record');
ok(R.determineBranch({}, { shops: [{ id: 'only' }] }).reason === 'single-shop', 'single-shop seller → unambiguous assign');
const amb = R.determineBranch({}, shops2);
ok(amb.branchId === 'b' && amb.reason === 'ambiguous-primary' && amb.audit === true, 'multi-shop ambiguous → primary branch + AUDIT flag');
ok(R.determineBranch({}, { shops: [] }).branchId === null, 'no shops → skip (never dump into a wrong branch)');
/* Non-financial (products): ambiguous may go to primary+audit → assignable. */
const planP = R.backfillPlan([{ branchId: 'a' }, {}, { raw: { shopId: 'a' } }, {}], shops2, { financial: false });
ok(planP.alreadyTagged === 1 && planP.assignable === 3 && planP.ambiguousReview === 0, 'products plan: alreadyTagged + assignable (ambiguous→primary+audit)');
ok(planP.plan.filter(p => p.audit).length === 2, 'products plan records an audit for each ambiguous assignment');

/* Financial (orders/transactions): ambiguous is NEVER auto-assigned → ambiguousReview. */
const planF = R.backfillPlan([{ branchId: 'a' }, {}, { raw: { shopId: 'a' } }, {}], shops2, { financial: true });
ok(planF.alreadyTagged === 1 && planF.assignable === 1 && planF.ambiguousReview === 2,
   'FINANCIAL plan: ambiguous NEVER auto-assigned (2 → review), only safe (ref/single-shop) assignable');
ok(planF.review.length === 2, 'ambiguous financial records surfaced for human review, not moved');

/* A single-shop seller: financial ambiguity does not arise → everything safe. */
const planSingle = R.backfillPlan([{}, {}, { branchId: 'x' }], { shops: [{ id: 'only', isMain: true }] }, { financial: true });
ok(planSingle.assignable === 2 && planSingle.ambiguousReview === 0 && planSingle.alreadyTagged === 1, 'single-shop seller: unambiguous, no review needed');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
