#!/usr/bin/env node
'use strict';
/**
 * RETIRE-18B — proves the posSendPurchaseOrder retirement landed correctly and left the
 * canonical procurement.sendPurchaseOrder untouched.
 *
 * See docs/adr/ADR-018-legacy-retirement-graph.md for the decision and the production-caller
 * evidence (docs/cf-invocation-census.json) it rests on.
 *
 * Every static check below is paired with a synthetic-fixture check that proves the same
 * detector actually flags a reintroduced/broken pattern — a check that can't fail is not a
 * check (see feedback_marker_comments_need_runtime_proof / feedback_sabotage_must_be_targeted).
 *
 * Run: node scripts/test-retire-18b.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
const POS_RETAIL = fs.readFileSync(path.join(ROOT, 'functions/pos-retail.js'), 'utf8');
const PROCUREMENT = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else      { fail++; console.log('  FAIL  ' + label); }
}

console.log('RETIRE-18B — posSendPurchaseOrder retirement, procurement.sendPurchaseOrder survives\n');

/* ── 1. posSendPurchaseOrder export is gone from index.js ────────────────────── */
const LIVE_EXPORT_RE = /^exports\.posSendPurchaseOrder\s*=/m;
check('index.js no longer exports posSendPurchaseOrder', !LIVE_EXPORT_RE.test(INDEX));
check('  (detector self-check: catches a reintroduced export)',
  LIVE_EXPORT_RE.test('exports.posSendPurchaseOrder       = posRetail.sendPurchaseOrder;'));

/* ── 2. pos-retail.js no longer exports the retired sendPurchaseOrder function ── */
const POS_RETAIL_EXPORT_RE = /^exports\.sendPurchaseOrder\s*=/m;
check('pos-retail.js no longer exports sendPurchaseOrder', !POS_RETAIL_EXPORT_RE.test(POS_RETAIL));
check('  (detector self-check: catches a reintroduced export)',
  POS_RETAIL_EXPORT_RE.test("exports.sendPurchaseOrder = onCall(\n  { secrets: [SENDGRID_SK] },"));

/* ── 3. pos-retail.js loads cleanly and exposes exactly its 4 surviving functions ── */
delete require.cache[require.resolve(path.join(ROOT, 'functions/pos-retail.js'))];
let posRetailExports = {};
let loadError = null;
try { posRetailExports = require(path.join(ROOT, 'functions/pos-retail.js')); }
catch (e) { loadError = e; }
check('pos-retail.js requires without throwing', !loadError);
const survivingExports = Object.keys(posRetailExports).sort();
const expectedSurvivors = ['posLowStockAlert', 'posMarketplaceOrderSync', 'posSyncToMarketplace', 'sendPOSReceipt'].sort();
check('pos-retail.js exports exactly the 4 surviving functions, no more, no fewer',
  JSON.stringify(survivingExports) === JSON.stringify(expectedSurvivors));

/* ── 4. the canonical procurement.sendPurchaseOrder is still wired in index.js ── */
const CANONICAL_WIRING_RE = /^exports\.sendPurchaseOrder\s*=\s*procurement\.sendPurchaseOrder;/m;
check('index.js still wires procurement.sendPurchaseOrder -> exports.sendPurchaseOrder',
  CANONICAL_WIRING_RE.test(INDEX));
check('  (detector self-check: catches procurement wiring going missing)',
  !CANONICAL_WIRING_RE.test('exports.sendPurchaseOrder                = someOtherModule.sendPurchaseOrder;'));

/* procurement.js exports via a single `module.exports = { a, b, c }` block, not per-line
   `exports.x =` — a different convention from index.js/pos-retail.js, so the detector below
   matches that shape specifically. */
const PROC_EXPORTS_BLOCK = (PROCUREMENT.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/) || [])[1] || '';
function procExports(name) { return new RegExp('(^|[,{]\\s*)' + name + '\\s*(,|\\n|\\})').test(PROC_EXPORTS_BLOCK); }

/* ── 5. procurement.js still exports its own sendPurchaseOrder — the retirement did not
        touch the canonical module ─────────────────────────────────────────────────── */
check('procurement.js still exports sendPurchaseOrder', procExports('sendPurchaseOrder'));
check('  (detector self-check: catches sendPurchaseOrder missing from the exports block)',
  !/(^|[,{]\s*)sendPurchaseOrder\s*(,|\n|\})/.test('module.exports = {\n  addSupplier,\n  createPurchaseOrder,\n};'));

/* ── 6. the full procurement lifecycle around it is intact (createPurchaseOrder,
        approvePurchaseOrder, receiveGoods) — proves this is the structurally-complete
        engine the ADR says survives, not a second orphan ──────────────────────────── */
['createPurchaseOrder', 'approvePurchaseOrder', 'receiveGoods'].forEach(fn => {
  check('procurement.js still exports ' + fn, procExports(fn));
});

/* ── 7. no live code caller of the retired export remains anywhere in the repo ── */
let grepHits = [];
try {
  const out = execSync(
    'git grep -n "posSendPurchaseOrder" -- "*.js" "*.html" ":!docs/**" ":!CHANGELOG.md"',
    { cwd: ROOT, encoding: 'utf8' }
  );
  grepHits = out.split('\n').filter(Boolean);
} catch (e) {
  if (e.status === 1) grepHits = []; /* git grep exits 1 when there are no matches */
  else throw e;
}
/* The only permitted hits are the two retirement comments left in place as an audit trail. */
const permitted = grepHits.filter(l =>
  /functions\/(index|pos-retail)\.js:/.test(l) && /RETIRED/.test(POS_RETAIL + INDEX)
);
const unexpected = grepHits.filter(l => !/functions\/(index|pos-retail)\.js:/.test(l));
check('no live code caller of posSendPurchaseOrder outside the retirement comments',
  unexpected.length === 0);
check('  (detector self-check: git grep actually finds occurrences when present)',
  grepHits.length >= 2); /* the two comment lines in index.js and pos-retail.js */

/* ── 8. siblings untouched: the other 4 pos-retail exports are still wired in index.js ── */
['posSyncToMarketplace', 'sendPOSReceipt', 'posLowStockAlert', 'posMarketplaceOrderSync'].forEach(fn => {
  check('index.js still wires posRetail.' + fn,
    new RegExp('^exports\\.' + fn + '\\s*=\\s*posRetail\\.' + fn + ';', 'm').test(INDEX));
});

/* ── 9. CF export count dropped by exactly 1 ──────────────────────────────────── */
const exportCount = (INDEX.match(/^exports\./gm) || []).length;
check('functions/index.js has exactly 1508 top-level exports (1509 - 1 retired)', exportCount === 1508);

/* ── report ────────────────────────────────────────────────────────────────── */
console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed.');
if (fail) {
  console.log('\n  ' + fail + ' FAILURE(S). See ADR-018 and docs/cf-invocation-census.json before changing this.');
  process.exit(1);
}
console.log('\n  PASS — posSendPurchaseOrder is retired; procurement.sendPurchaseOrder is untouched.');
