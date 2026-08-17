#!/usr/bin/env node
/* PRE-RELEASE GATE — can a real approved seller actually create a product?
 *
 *   npm run gate:seller:create
 *
 * WHY THIS EXISTS, SEPARATE FROM test-seller-rules.js
 * That suite isolates the SELLER PREDICATE: it sets `deactivated:false` on every token and
 * seeds productCounters so the only variable is the claim. That is correct for proving the
 * predicate, and it is deliberately NOT a production-shaped test.
 *
 * This gate does the opposite. It reproduces the ACTUAL production prerequisites, measured
 * from live on 2026-08-17, and asks whether a create would really succeed:
 *
 *   operational seller D5Ql2…  claims {admin, superAdmin, role:5, driver, rider, seller}
 *                              NO `deactivated` claim
 *                              productCounters {maxProducts:10, count:-23, status:'INACTIVE'}
 *                              103 real products
 *   real buyer 8c8ASJQO…       claims: NONE           counter: NONE
 *
 * The two pre-existing hazards it is built to expose — neither introduced by the seller gate:
 *   1. isActive() reads request.auth.token.deactivated. On a token where that claim is ABSENT
 *      the operand errors. CEL absorbs the error only if another operand of the || is TRUE —
 *      which is the case for an ADMIN, and not for an ordinary seller.
 *   2. withinProductLimit() dereferences a get() that can be null when no counter exists.
 *
 * Run against the candidate:  --rules firestore.rules.e2-candidate
 * Run against live for control: --rules firestore.rules.phase4-candidate
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const RULES_FILE = (argv.indexOf('--rules') >= 0 ? argv[argv.indexOf('--rules') + 1] : null)
  || process.env.RULES_FILE || 'firestore.rules';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n-- ' + t + ' --');

/* measured from production — do not "tidy" these into nicer values */
const OPERATIONAL_UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const OPERATIONAL_CLAIMS = { admin: true, superAdmin: true, role: 5, driver: true, rider: true, seller: true };
const OPERATIONAL_COUNTER = { uid: OPERATIONAL_UID, maxProducts: 10, status: 'INACTIVE', count: -23 };
const BUYER_UID = '8c8ASJQO3oPqmWqkvAhHCrFMBw43';          /* real account, no claims, no counter */
const PLAIN_SELLER_UID = 'uidPlainApprovedSeller';          /* what an ordinary approval produces */

const product = (sellerUid) => ({
  sellerUid, name: 'Gate probe', price: 100, stock: 1, category: 'general', createdAt: Date.now(),
});
const tryCreate = async (db, uid, id) =>
  setDoc(doc(db, 'products', id), product(uid)).then(() => true).catch(() => false);

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-gate-seller-create',
    firestore: { rules: fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8') },
  });
  console.log('\nRules under test: ' + RULES_FILE);

  await env.withSecurityRulesDisabled(async (ctx) => {
    /* the operational seller's REAL counter, negative count and all */
    await setDoc(doc(ctx.firestore(), 'productCounters', OPERATIONAL_UID), OPERATIONAL_COUNTER);
    /* BUYER and PLAIN_SELLER get no counter, exactly as in production */
  });

  /* Tokens carry EXACTLY the production claims — note: no `deactivated` anywhere. */
  const asOperational = env.authenticatedContext(OPERATIONAL_UID, OPERATIONAL_CLAIMS).firestore();
  const asPlainSeller = env.authenticatedContext(PLAIN_SELLER_UID, { seller: true }).firestore();
  const asBuyer       = env.authenticatedContext(BUYER_UID, {}).firestore();

  head('1 - the operational seller (production claims + real counter)');
  const opOk = await tryCreate(asOperational, OPERATIONAL_UID, 'gate_op');
  ck('operational seller CAN create a product', opOk, opOk ? 'created' : 'DENIED');

  head('2 - an ordinary approved seller (seller claim only, no admin, no counter)');
  const plainOk = await tryCreate(asPlainSeller, PLAIN_SELLER_UID, 'gate_plain');
  ck('ordinary approved seller CAN create a product', plainOk, plainOk ? 'created' : 'DENIED');

  head('3 - the buyer must never create (real account, no claims)');
  const buyerOk = await tryCreate(asBuyer, BUYER_UID, 'gate_buyer');
  ck('buyer is DENIED', buyerOk === false, buyerOk ? 'CREATED - HOLE' : 'denied');

  head('4 - diagnosis: which prerequisite blocks an ordinary seller');
  const withDeact = env.authenticatedContext('uidSellerDeact', { seller: true, deactivated: false }).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'productCounters', 'uidSellerDeact'), { uid: 'uidSellerDeact', maxProducts: -1, count: 0 });
  });
  const deactOk = await tryCreate(withDeact, 'uidSellerDeact', 'gate_deact');
  ck('seller + deactivated:false + counter CAN create', deactOk, deactOk ? 'created' : 'DENIED');

  const counterOnly = env.authenticatedContext('uidSellerCounter', { seller: true }).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'productCounters', 'uidSellerCounter'), { uid: 'uidSellerCounter', maxProducts: -1, count: 0 });
  });
  const counterOk = await tryCreate(counterOnly, 'uidSellerCounter', 'gate_counter');
  ck('seller + counter but NO deactivated claim CAN create', counterOk, counterOk ? 'created' : 'DENIED');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (rules: ' + RULES_FILE + ')');
  if (!plainOk && deactOk && !counterOk) {
    console.log('\n  DIAGNOSIS: the blocker is isActive() reading an ABSENT `deactivated` claim,');
    console.log('  not the seller predicate and not the product counter. An ordinary approved');
    console.log('  seller would be denied; the operational account passes only because it is admin.');
  }
  await env.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('GATE CRASHED:', e && e.stack); process.exit(1); });
