#!/usr/bin/env node
'use strict';
/* ============================================================================
   VAT POLICY — applicability is decided by the business, never inferred by code
   ----------------------------------------------------------------------------
   revenueConfig/commission_vat and revenueConfig/subscription_vat:
     taxable + configured  → invoice with VAT at the engine rate (inclusive/exclusive as stated)
     zero_rated            → invoice, VAT 0 (KRA category B)
     exempt                → invoice line with no VAT (category C)
     unresolved / absent / not yet effective / malformed → null ⇒ callers refuse or defer
   The fiscal engine (etims._platformTaxStatusFor + etims-tax-engine) turns the stated category
   into KRA line categories; an unknown category is refused, never mapped.
   Pure. node scripts/test-vat-policy.js
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'functions', 'node_modules');
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:1';
const admin = require(path.join(NM, 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-vat-policy-test' });

let pass = 0, fail = 0;
const ck = (label, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); } };

const { loadVatPolicy, POLICY_DOC, SUBSCRIPTION_POLICY_DOC } = require(path.join(ROOT, 'functions', 'commission-vat-policy'));
const TaxEngine = require(path.join(ROOT, 'functions', 'etims-tax-engine'));
const dbWith = (docs) => ({ collection(c) { return { doc(id) { return { async get() { const d = docs[c + '/' + id]; return { exists: !!d, data: () => d }; } }; } }; } });

(async () => {
  console.log('VAT policy — applicability, effective date, fail-closed\n');
  ck('1 both policy documents are named and distinct', POLICY_DOC === 'revenueConfig/commission_vat' && SUBSCRIPTION_POLICY_DOC === 'revenueConfig/subscription_vat');

  /* unresolved states → null */
  for (const [label, doc] of [
    ['absent', undefined],
    ['enabled:false', { enabled: false, applicability: 'taxable', inclusive: true, decidedBy: 'x' }],
    ['no applicability and no inclusive boolean', { enabled: true, decidedBy: 'x' }],
    ['unknown applicability word', { enabled: true, applicability: 'maybe', decidedBy: 'x' }],
    ['taxable but treatment of the price not stated', { enabled: true, applicability: 'taxable', decidedBy: 'x' }],
    ['no decidedBy', { enabled: true, applicability: 'exempt' }],
    ['effectiveFrom in the future', { enabled: true, applicability: 'taxable', inclusive: true, decidedBy: 'x', effectiveFrom: new Date(Date.now() + 86400000).toISOString() }],
  ]) {
    const p = await loadVatPolicy(dbWith(doc ? { [POLICY_DOC]: doc } : {}), POLICY_DOC);
    ck(`2 ${label} -> null (callers refuse / defer)`, p === null, p);
  }

  /* resolved states */
  const tIn = await loadVatPolicy(dbWith({ [POLICY_DOC]: { enabled: true, applicability: 'taxable', inclusive: true, decidedBy: 'adviser', reference: 'ADV-1' } }), POLICY_DOC);
  ck('3 taxable + inclusive -> {applicability taxable, taxCategory standard, inclusive true, reference}', tIn && tIn.applicability === 'taxable' && tIn.taxCategory === 'standard' && tIn.inclusive === true && tIn.reference === 'ADV-1', tIn);
  const tEx = await loadVatPolicy(dbWith({ [SUBSCRIPTION_POLICY_DOC]: { enabled: true, applicability: 'taxable', inclusive: false, decidedBy: 'adviser' } }), SUBSCRIPTION_POLICY_DOC);
  ck('4 taxable + exclusive -> inclusive false (VAT added on top of the stated fee)', tEx && tEx.inclusive === false && tEx.taxCategory === 'standard', tEx);
  const legacy = await loadVatPolicy(dbWith({ [POLICY_DOC]: { enabled: true, inclusive: true, decidedBy: 'adviser' } }), POLICY_DOC);
  ck('5 pre-2026-09-30 document shape (inclusive only) still means taxable — backward compatible', legacy && legacy.applicability === 'taxable' && legacy.inclusive === true, legacy);
  const zr = await loadVatPolicy(dbWith({ [POLICY_DOC]: { enabled: true, applicability: 'zero_rated', decidedBy: 'adviser' } }), POLICY_DOC);
  ck('6 zero_rated -> taxCategory zero_rated, inclusive null (nothing to include)', zr && zr.taxCategory === 'zero_rated' && zr.inclusive === null, zr);
  const ex = await loadVatPolicy(dbWith({ [POLICY_DOC]: { enabled: true, applicability: 'exempt', decidedBy: 'adviser', effectiveFrom: new Date(Date.now() - 86400000).toISOString() } }), POLICY_DOC);
  ck('7 exempt with a past effectiveFrom -> taxCategory exempt, in force', ex && ex.taxCategory === 'exempt' && ex.effectiveFrom, ex);

  /* the fiscal engine turns the category into KRA line categories — never a guessed amount */
  const line = (vatStatus, inclusive) => TaxEngine.computeLine({ name: 'Platform Commission Fee', quantity: 1, unitPrice: 500, discountRate: 0, seq: 1 }, vatStatus, { inclusive });
  const std = line('registered', true), stdEx = line('registered', false), zero = line('zero_rated', true), exm = line('exempt', true);
  ck('8 standard inclusive: KES 500 fee -> taxable 431.03 + VAT 68.97, category A', std.vatCatCd === 'A' && std.taxblAmt === 431.03 && std.taxAmt === 68.97 && std.totAmt === 500, std);
  ck('9 standard exclusive: KES 500 fee -> VAT 80 added, total 580', stdEx.vatCatCd === 'A' && stdEx.taxAmt === 80 && stdEx.totAmt === 580, stdEx);
  ck('10 zero_rated: category B, VAT 0, total 500', zero.vatCatCd === 'B' && zero.taxAmt === 0 && zero.totAmt === 500, zero);
  ck('11 exempt: category C, no taxable amount, VAT 0, total 500', exm.vatCatCd === 'C' && exm.taxblAmt === 0 && exm.taxAmt === 0 && exm.totAmt === 500, exm);

  /* etims maps the policy category to those statuses and refuses anything else */
  let etims = null;
  try {
    process.env.FUNCTIONS_EMULATOR = 'true';
    etims = require(path.join(ROOT, 'functions', 'etims'));
  } catch (e) { console.log('  (etims module could not load in this harness: ' + String(e.message).slice(0, 80) + ')'); }
  if (etims && etims._platformTaxStatusFor) {
    ck('12 etims: standard -> registered, zero_rated -> zero_rated, exempt -> exempt, omitted -> registered (pre-change meaning)',
       etims._platformTaxStatusFor('standard') === 'registered' && etims._platformTaxStatusFor('zero_rated') === 'zero_rated' && etims._platformTaxStatusFor('exempt') === 'exempt' && etims._platformTaxStatusFor(undefined) === 'registered');
    let threw = false; try { etims._platformTaxStatusFor('sixteen_percent'); } catch (_) { threw = true; }
    ck('13 etims: an unknown category is REFUSED, never mapped', threw);
  } else {
    fail++; console.log('  FAIL  12/13 etims._platformTaxStatusFor not reachable in this harness');
  }

  console.log('\nNC. negative control (must FAIL)');
  console.log(`  ${std.taxAmt === 0 ? 'PASS' : 'FAIL'}  NC deliberately false assertion — expected FAIL`);
  console.log(`\n${pass} passed, ${fail} failed (negative control excluded)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
