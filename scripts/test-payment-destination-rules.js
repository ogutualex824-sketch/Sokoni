/* paymentDestinations + sellerRestrictions Firestore rules — emulator-backed.
 *
 * Run against the Track B candidate (live lineage + the two new blocks):
 *   RULES_FILE=firestore.rules.trackb-candidate \
 *   firebase emulators:exec --only firestore --project sokoni-trackb-rules-test \
 *     "node scripts/test-payment-destination-rules.js"
 *
 * THE RULE THESE TESTS EXIST TO PROVE
 * A merchant must never be able to write their own payment destination. If they
 * could, they would set status:'VERIFIED' on any number they liked and STK push
 * would route live customer money to a destination nobody tested. The same
 * applies to sellerRestrictions: a merchant who could write it would clear their
 * own commission restriction and keep trading on an unpaid balance.
 *
 * So the assertions that matter are the DENIALS, and they are written as
 * denials — `assertFails` on every shape of write a real attacker would try,
 * including the merchant writing their OWN document, which is the case a naive
 * "owner can write their own doc" rule would wrongly allow.
 *
 * Reads are asserted too: the owner must be able to see their own destination
 * (the UI depends on it) and must NOT be able to see anyone else's.
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const check = async (label, p) => {
  try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); }
};

const ME    = 'seller_me';
const OTHER = 'seller_other';

(async () => {
  const rulesFile = process.env.RULES_FILE || 'firestore.rules';
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-trackb-rules-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', rulesFile), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  console.log('\nRules file under test: ' + rulesFile + '\n');

  /* Seed both documents with the Admin SDK (bypasses rules), because in
     production only Cloud Functions ever create them. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('paymentDestinations/' + ME).set({
      sellerUid: ME, shopId: 'shop_me', status: 'VERIFIED',
      activeDestination: { destinationType: 'TILL', destinationNumber: '123456', status: 'VERIFIED' },
      productionAuthorized: false,
    });
    await db.doc('paymentDestinations/' + OTHER).set({ sellerUid: OTHER, status: 'VERIFIED' });
    await db.doc('sellerRestrictions/' + ME).set({ sellerUid: ME, restricted: true, outstandingKES: 287.5 });
    await db.doc('sellerRestrictions/' + OTHER).set({ sellerUid: OTHER, restricted: false });
  });

  const me     = env.authenticatedContext(ME).firestore();
  const other  = env.authenticatedContext(OTHER).firestore();
  const anon   = env.unauthenticatedContext().firestore();
  const admin  = env.authenticatedContext('admin_1', { admin: true }).firestore();

  /* ── paymentDestinations ────────────────────────────────────────────── */
  console.log('paymentDestinations — reads\n');
  await check('owner can read their own destination',
    assertSucceeds(me.doc('paymentDestinations/' + ME).get()));
  await check('admin can read any destination',
    assertSucceeds(admin.doc('paymentDestinations/' + ME).get()));
  await check('another seller CANNOT read it',
    assertFails(other.doc('paymentDestinations/' + ME).get()));
  await check('anonymous CANNOT read it',
    assertFails(anon.doc('paymentDestinations/' + ME).get()));

  console.log('\npaymentDestinations — writes are denied to EVERYONE\n');
  await check('owner CANNOT create their own destination',
    assertFails(me.doc('paymentDestinations/brand_new').set({ sellerUid: ME })));
  await check('owner CANNOT update their own destination',
    assertFails(me.doc('paymentDestinations/' + ME).update({ accountName: 'x' })));
  /* The attack this whole design exists to stop. */
  await check('owner CANNOT self-declare a destination VERIFIED',
    assertFails(me.doc('paymentDestinations/' + ME).update({
      activeDestination: { destinationType: 'TILL', destinationNumber: '999999', status: 'VERIFIED' },
    })));
  await check('owner CANNOT flip productionAuthorized',
    assertFails(me.doc('paymentDestinations/' + ME).update({ productionAuthorized: true })));
  await check('owner CANNOT delete it',
    assertFails(me.doc('paymentDestinations/' + ME).delete()));
  await check('another seller CANNOT write it',
    assertFails(other.doc('paymentDestinations/' + ME).update({ accountName: 'x' })));
  await check('anonymous CANNOT write it',
    assertFails(anon.doc('paymentDestinations/' + ME).set({ sellerUid: ME })));
  /* Even an admin token must not write this from a client — the Admin SDK
     bypasses rules, so Cloud Functions are unaffected, but a stolen admin token
     must not be able to redirect a merchant's collections. */
  await check('an ADMIN token still cannot write it from a client',
    assertFails(admin.doc('paymentDestinations/' + ME).update({ accountName: 'x' })));

  /* ── sellerRestrictions ─────────────────────────────────────────────── */
  console.log('\nsellerRestrictions — reads\n');
  await check('owner can read their own restriction',
    assertSucceeds(me.doc('sellerRestrictions/' + ME).get()));
  await check('admin can read any restriction',
    assertSucceeds(admin.doc('sellerRestrictions/' + ME).get()));
  await check('another seller CANNOT read it',
    assertFails(other.doc('sellerRestrictions/' + ME).get()));
  await check('anonymous CANNOT read it',
    assertFails(anon.doc('sellerRestrictions/' + ME).get()));

  console.log('\nsellerRestrictions — writes are denied to EVERYONE\n');
  /* The attack: a restricted merchant clearing their own gate. */
  await check('a restricted owner CANNOT clear their own restriction',
    assertFails(me.doc('sellerRestrictions/' + ME).update({ restricted: false })));
  await check('owner CANNOT zero their own outstanding balance',
    assertFails(me.doc('sellerRestrictions/' + ME).update({ outstandingKES: 0 })));
  await check('owner CANNOT delete the restriction',
    assertFails(me.doc('sellerRestrictions/' + ME).delete()));
  await check('owner CANNOT create one for anyone',
    assertFails(me.doc('sellerRestrictions/brand_new').set({ restricted: false })));
  await check('anonymous CANNOT write it',
    assertFails(anon.doc('sellerRestrictions/' + ME).update({ restricted: false })));
  await check('an ADMIN token still cannot write it from a client',
    assertFails(admin.doc('sellerRestrictions/' + ME).update({ restricted: false })));

  /* ── Server path still works ────────────────────────────────────────── */
  console.log('\nCloud Functions (Admin SDK) are unaffected\n');
  await check('the Admin SDK can still write both documents', (async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('paymentDestinations/' + ME).update({ status: 'VERIFIED' });
      await ctx.firestore().doc('sellerRestrictions/' + ME).update({ restricted: false });
    });
  })());

  /* ── No collateral damage to existing collections ───────────────────── */
  console.log('\nExisting live behaviour preserved\n');
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('commissionLedger/entry_me').set({ sellerUid: ME, totalOwed: 50 });
    await ctx.firestore().doc('shops/' + ME).set({ ownerId: ME, name: 'My Shop', status: 'active' });
  });
  await check('commissionLedger still readable by its seller',
    assertSucceeds(me.doc('commissionLedger/entry_me').get()));
  await check('commissionLedger still not writable by its seller',
    assertFails(me.doc('commissionLedger/entry_me').update({ totalOwed: 0 })));
  await check('shops still publicly readable (unchanged)',
    assertSucceeds(anon.doc('shops/' + ME).get()));

  await env.cleanup();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
