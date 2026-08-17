#!/usr/bin/env node
/* Seller AUTHORITY at the Firestore boundary (E2).
 *
 *   RULES_FILE=firestore.rules.e2-candidate \
 *   firebase emulators:exec --only firestore --project sokoni-seller-rules "node scripts/test-seller-rules.js"
 *
 * WHAT THIS PROVES
 * Product mutation requires an APPROVED seller — `request.auth.token.seller == true` — and
 * ownership, not merely authentication. Before this gate the rules required only
 * `sellerUid == request.auth.uid`, so any signed-in buyer could create products as themselves.
 *
 * THE NEGATIVE INVARIANTS, each with a live counter-example in the estate:
 *   - an application document        is not authority (3 accounts hold one with no claim)
 *   - sellers/{uid}.status=='active' is not authority (the applicant writes it themselves)
 *   - roles[] containing 'seller'    is not authority (historical; 6 accounts)
 *   - the claim alone                IS authority
 *
 * This is the CLIENT boundary only. Admin-SDK callables bypass rules entirely; those paths are
 * covered separately by scripts/test-product-write-authority.js (Stage E1).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, deleteDoc, updateDoc } = require('firebase/firestore');

const ROOT = path.resolve(__dirname, '..');
/* `--rules <file>` mirrors test-role-rules.js; RULES_FILE mirrors the other rules suites.
   Both exist so the npm script can name the candidate without shell-specific env syntax. */
const _argv = process.argv.slice(2);
const _rulesArg = _argv.indexOf('--rules') >= 0 ? _argv[_argv.indexOf('--rules') + 1] : null;
const RULES_FILE = _rulesArg || process.env.RULES_FILE || 'firestore.rules';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n-- ' + t + ' --');

const SELLER_A = 'uidSellerA', SELLER_B = 'uidSellerB', BUYER = 'uidBuyer';
const P_A = 'prodA', P_B = 'prodB';

const product = (sellerUid) => ({
  sellerUid, name: 'Test item', price: 100, stock: 5,
  category: 'general', createdAt: Date.now(),
});

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-seller-rules',
    firestore: { rules: fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8') },
  });
  console.log('\nRules under test: ' + RULES_FILE);

  /* Seed products past the rules, plus the decoys that must grant nothing, plus the
     productCounters rows withinProductLimit() reads. Without a counter that predicate
     dereferences a null get() and the create is refused for a reason that has nothing to do
     with seller authority — which is how the first version of this suite "failed". */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'products', P_A), product(SELLER_A));
    await setDoc(doc(db, 'products', P_B), product(SELLER_B));
    /* applicant-written record — deliberately says 'active' */
    await setDoc(doc(db, 'sellers', BUYER), { uid: BUYER, status: 'active', shopName: 'Decoy' });
    /* historical role array */
    await setDoc(doc(db, 'users', BUYER), { uid: BUYER, roles: ['buyer', 'seller'] });
    await setDoc(doc(db, 'users', SELLER_A), { uid: SELLER_A, roles: ['buyer', 'seller'] });
    for (const uid of [SELLER_A, SELLER_B, BUYER]) {
      await setDoc(doc(db, 'productCounters', uid), { uid, maxProducts: -1, count: 0 });
    }
  });

  /* Auth contexts. `deactivated: false` is present on every token deliberately: isActive()
     reads request.auth.token.deactivated, and on a token where that claim is ABSENT the rules
     engine raises "Property deactivated is undefined" and the whole expression errors to deny.
     That is pre-existing behaviour of the LIVE ruleset — verified identical on live and on this
     candidate — and is NOT what this suite is measuring. Setting it keeps the variable under
     test the SELLER CLAIM and nothing else. (Recorded separately as a pre-existing finding.) */
  const ACTIVE = { deactivated: false };
  const asBuyer    = env.authenticatedContext(BUYER, { ...ACTIVE }).firestore();
  const asSellerA  = env.authenticatedContext(SELLER_A, { ...ACTIVE, seller: true }).firestore();
  const asSellerB  = env.authenticatedContext(SELLER_B, { ...ACTIVE, seller: true }).firestore();
  const asAdmin    = env.authenticatedContext('uidAdmin', { ...ACTIVE, admin: true }).firestore();
  const asAnon     = env.unauthenticatedContext().firestore();

  /* ══ 1 · a buyer cannot mutate products ══ */
  head('1 - buyer (no seller claim) cannot mutate products');
  ck('create own product -> DENIED',
     await assertFails(setDoc(doc(asBuyer, 'products', 'newByBuyer'), product(BUYER))).then(() => true).catch(() => false));
  ck('update own-uid product -> DENIED',
     await assertFails(updateDoc(doc(asBuyer, 'products', P_A), { price: 1 })).then(() => true).catch(() => false));
  ck('delete another seller product -> DENIED',
     await assertFails(deleteDoc(doc(asBuyer, 'products', P_A))).then(() => true).catch(() => false));

  /* ══ 2 · the decoys grant nothing ══ */
  head('2 - the request is not the authority');
  ck("sellers/{uid}.status=='active' grants NOTHING",
     await assertFails(setDoc(doc(asBuyer, 'products', 'viaSellerDoc'), product(BUYER))).then(() => true).catch(() => false));
  ck("users.roles[] containing 'seller' grants NOTHING",
     await assertFails(setDoc(doc(asBuyer, 'products', 'viaRoles'), product(BUYER))).then(() => true).catch(() => false));
  ck('anonymous create -> DENIED',
     await assertFails(setDoc(doc(asAnon, 'products', 'viaAnon'), product('whoever'))).then(() => true).catch(() => false));

  /* ══ 3 · an approved seller CAN, but only its own ══ */
  head('3 - approved seller: own products only');
  ck('approved seller creates its OWN product -> ALLOWED',
     await assertSucceeds(setDoc(doc(asSellerA, 'products', 'newByA'), product(SELLER_A))).then(() => true).catch(() => false));
  ck('approved seller updates its OWN product -> ALLOWED',
     await assertSucceeds(updateDoc(doc(asSellerA, 'products', P_A), { price: 250 })).then(() => true).catch(() => false));
  ck('approved seller deletes its OWN product -> ALLOWED',
     await assertSucceeds(deleteDoc(doc(asSellerA, 'products', 'newByA'))).then(() => true).catch(() => false));

  head('4 - cross-seller isolation');
  ck('seller A updates seller B product -> DENIED',
     await assertFails(updateDoc(doc(asSellerA, 'products', P_B), { price: 1 })).then(() => true).catch(() => false));
  ck('seller A deletes seller B product -> DENIED',
     await assertFails(deleteDoc(doc(asSellerA, 'products', P_B))).then(() => true).catch(() => false));
  ck('seller A creates a product OWNED BY B -> DENIED',
     await assertFails(setDoc(doc(asSellerA, 'products', 'spoof'), product(SELLER_B))).then(() => true).catch(() => false));
  /* withSecurityRulesDisabled() resolves to undefined — it does not forward the callback's
     return value — so the result has to be captured out of band. */
  let bPrice = null;
  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), 'products', P_B));
    bPrice = s.data().price;
  });
  ck('seller B product untouched by A (price still 100)', bPrice === 100, bPrice);

  head('5 - reads stay public, admin retains override');
  ck('anonymous READ still allowed (public catalogue)',
     await assertSucceeds(getDoc(doc(asAnon, 'products', P_A))).then(() => true).catch(() => false));
  ck('admin may update any product',
     await assertSucceeds(updateDoc(doc(asAdmin, 'products', P_B), { price: 111 })).then(() => true).catch(() => false));

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (rules: ' + RULES_FILE + ')');
  await env.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
