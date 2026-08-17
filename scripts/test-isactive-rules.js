#!/usr/bin/env node
/* isActive() — an ABSENT `deactivated` claim must mean ACTIVE, not "error, therefore deny".
 *
 *   npm run test:rules:isactive            # the corrected candidate
 *   npm run test:rules:isactive:live       # control: the live base, where absent errors
 *
 * WHY
 * isActive() read `request.auth.token.deactivated` directly. On a token where that claim is
 * ABSENT the operand errors, and CEL absorbs the error only if another operand of the `||` is
 * TRUE — which is the case for an ADMIN and not for anyone else. Real accounts carry no custom
 * claims at all, so every ordinary account evaluated INACTIVE and was denied by an error rather
 * than by a decision. Measured consequence: all 103 live products belong to the one admin
 * account, and an approved seller would have been unable to create a product even holding the
 * seller claim.
 *
 * Intended model — `deactivated` is an EXCEPTIONAL account-status claim, not one every user is
 * required to possess:
 *
 *     deactivated == true   -> inactive
 *     deactivated == false  -> active
 *     claim absent          -> active
 *
 * Scope is one line. This suite must therefore also prove that DEACTIVATION still works and that
 * the admin bypass is unchanged — a fix that quietly stopped denying deactivated accounts would
 * be far worse than the defect.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc } = require('firebase/firestore');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const RULES_FILE = (argv.indexOf('--rules') >= 0 ? argv[argv.indexOf('--rules') + 1] : null)
  || process.env.RULES_FILE || 'firestore.rules';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 60) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n-- ' + t + ' --');

/* products.create is the cheapest surface that goes through isActive(). Ownership and the
   product counter are satisfied so the ONLY variable is the deactivated claim. */
const UID = 'uidSubject';
const product = () => ({ sellerUid: UID, name: 'probe', price: 100, stock: 1, category: 'general', createdAt: 1 });
const tryCreate = (db, id) => setDoc(doc(db, 'products', id), product()).then(() => true).catch(() => false);

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-isactive-rules',
    firestore: { rules: fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8') },
  });
  console.log('\nRules under test: ' + RULES_FILE);

  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'productCounters', UID), { uid: UID, maxProducts: -1, count: 0 });
  });

  /* The candidate carries no seller predicate, so `seller` is irrelevant here EXCEPT in the
     combined case, which is the one E2 depends on. */
  const ctxFor = (claims) => env.authenticatedContext(UID, claims).firestore();

  head('1 - the three states of the claim');
  ck('claim ABSENT      -> ACTIVE (create allowed)',
     await tryCreate(ctxFor({}), 'p_absent'));
  ck('deactivated:false -> ACTIVE (create allowed)',
     await tryCreate(ctxFor({ deactivated: false }), 'p_false'));
  ck('deactivated:true  -> INACTIVE (create denied)',
     (await tryCreate(ctxFor({ deactivated: true }), 'p_true')) === false);

  head('2 - deactivation still bites, and admin bypass is unchanged');
  ck('deactivated:true + admin      -> ACTIVE (bypass preserved)',
     await tryCreate(ctxFor({ deactivated: true, admin: true }), 'p_true_admin'));
  ck('deactivated:true + superAdmin -> ACTIVE (bypass preserved)',
     await tryCreate(ctxFor({ deactivated: true, superAdmin: true }), 'p_true_super'));
  ck('deactivated:true + seller     -> INACTIVE (seller is not a bypass)',
     (await tryCreate(ctxFor({ deactivated: true, seller: true }), 'p_true_seller')) === false);

  head('3 - the case E2 depends on');
  ck('seller claim + NO deactivated -> ACTIVE',
     await tryCreate(ctxFor({ seller: true }), 'p_seller_absent'));

  head('4 - unauthenticated is still not active');
  ck('anonymous create -> DENIED',
     (await setDoc(doc(env.unauthenticatedContext().firestore(), 'products', 'p_anon'), product())
       .then(() => true).catch(() => false)) === false);

  head('5 - reads are unaffected by this change');
  ck('anonymous READ still allowed (public catalogue)',
     await getDoc(doc(env.unauthenticatedContext().firestore(), 'products', 'p_absent'))
       .then(() => true).catch(() => false));

  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (rules: ' + RULES_FILE + ')');
  await env.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
