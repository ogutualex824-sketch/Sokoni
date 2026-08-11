/* Buyer delivery-tracking authorization — emulator-backed.

   Run:  firebase emulators:exec --only firestore --project sokoni-deliv-track-test \
           "node scripts/test-delivery-tracking-rules.js"

   WHY THIS EXISTS
   The buyer's live tracking map never rendered a rider. The rider's GPS is written
   to `deliveryLocations` / `driverLocations`, whose rules admit only the rider
   themselves, admins, or a uid listed in a `viewers` array — and NOTHING in the
   codebase has ever written that array. So the buyer's location listener failed
   with permission-denied straight into a console.warn and simply never fired.
   Meanwhile the one position field the buyer IS allowed to read — driverLat /
   driverLng on the delivery document itself — was written once at assignment and
   never refreshed.

   The fix keeps ONE location truth: the rider mirrors their position onto the
   canonical delivery record that the buyer, seller and rider already share. No new
   collection, and — the point of this file — no relaxed read rule.

   These tests pin the boundary the fix must not cross:
     * a buyer reads their OWN delivery and nobody else's
     * only the ASSIGNED rider may publish a position
     * a buyer may NOT forge a rider position
     * the rider GPS collection stays closed to buyers (proving the mirror is
       necessary rather than a convenience)
*/
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const check = async (label, p) => {
  try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); }
};

const BUYER   = 'buyer-uid-1';
const BUYER2  = 'buyer-uid-2';
const SELLER  = 'seller-uid-1';
const RIDER   = 'rider-uid-1';
const RIDER2  = 'rider-uid-2';

/* Nairobi CBD — inside the _validGPS Kenya bbox. */
const KE = { lat: -1.2864, lng: 36.8172 };
/* London — outside it. */
const NON_KE = { lat: 51.5074, lng: -0.1278 };

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-deliv-track-test',
    firestore: {
      /* RULES_FILE lets the SAME assertions run against the built (comment-stripped)
         ruleset. Identical results from both files is the evidence that
         build-firestore-rules.js preserved behaviour — brace balance alone proves
         nothing about an authorization expression. */
      rules: fs.readFileSync(
        path.resolve(__dirname, '..', process.env.RULES_FILE || 'firestore.rules'), 'utf8'),
      host: '127.0.0.1', port: 8080,
    },
  });

  /* Seed with rules disabled — these are Cloud-Function/Admin-SDK writes in prod. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    /* packageRequests — the marketplace delivery record. */
    await db.collection('packageRequests').doc('DEL-AAA111').set({
      deliveryRef: 'DEL-AAA111', uid: BUYER, buyerUid: BUYER, sellerUid: SELLER,
      assignedDriverId: RIDER, driverName: 'Brian',
      status: 'in_transit',
      driverLat: KE.lat, driverLng: KE.lng,
      driverLocUpdatedAt: '2026-08-11T09:00:00.000Z',
      deliveryCoords: { lat: -1.30, lng: 36.80 },
      pickupCoords:   { lat: -1.28, lng: 36.82 },
      deliveryFee: 250, proofPIN: '4821',
    });

    /* A DIFFERENT customer's delivery — the isolation target. */
    await db.collection('packageRequests').doc('DEL-BBB222').set({
      deliveryRef: 'DEL-BBB222', uid: BUYER2, buyerUid: BUYER2, sellerUid: 'seller-uid-9',
      assignedDriverId: RIDER2, status: 'in_transit',
      driverLat: KE.lat, driverLng: KE.lng, deliveryFee: 300, proofPIN: '1111',
    });

    /* deliveries — the hub/send-a-package record. */
    await db.collection('deliveries').doc('hub1').set({
      deliveryRef: 'DEL-HUB001', senderUid: BUYER, assignedRiderId: RIDER,
      riderName: 'Brian', status: 'in_transit', deliveryFee: 200, proofPIN: '9090',
    });

    /* The rider's dedicated GPS doc — no `viewers` array, exactly as in prod. */
    await db.collection('deliveryLocations').doc(RIDER).set({
      uid: RIDER, riderId: RIDER, lat: KE.lat, lng: KE.lng,
    });
    await db.collection('driverLocations').doc(RIDER).set({
      uid: RIDER, lat: KE.lat, lng: KE.lng,
    });
  });

  const asBuyer  = env.authenticatedContext(BUYER).firestore();
  const asBuyer2 = env.authenticatedContext(BUYER2).firestore();
  const asSeller = env.authenticatedContext(SELLER).firestore();
  const asRider  = env.authenticatedContext(RIDER).firestore();
  const asRider2 = env.authenticatedContext(RIDER2).firestore();

  const pkg  = (db, id) => db.collection('packageRequests').doc(id);
  const hub  = (db, id) => db.collection('deliveries').doc(id);

  console.log('\npackageRequests — buyer read isolation');
  await check('buyer reads their OWN delivery (rider position included)',
    assertSucceeds(pkg(asBuyer, 'DEL-AAA111').get()));
  await check('buyer CANNOT read another customer\'s delivery',
    assertFails(pkg(asBuyer, 'DEL-BBB222').get()));
  await check('seller CANNOT read a delivery for another seller',
    assertFails(pkg(asSeller, 'DEL-BBB222').get()));
  await check('assigned rider reads the delivery they are on',
    assertSucceeds(pkg(asRider, 'DEL-AAA111').get()));
  await check('unassigned rider CANNOT read someone else\'s delivery',
    assertFails(pkg(asRider2, 'DEL-AAA111').get()));

  console.log('\npackageRequests — who may publish a rider position');
  await check('ASSIGNED rider publishes driverLat/driverLng/driverLocUpdatedAt',
    assertSucceeds(pkg(asRider, 'DEL-AAA111').update({
      driverLat: -1.2900, driverLng: 36.8200,
      driverLocUpdatedAt: '2026-08-11T09:05:00.000Z',
    })));
  await check('UNASSIGNED rider CANNOT publish a position',
    assertFails(pkg(asRider2, 'DEL-AAA111').update({
      driverLat: -1.3100, driverLng: 36.7500,
      driverLocUpdatedAt: '2026-08-11T09:08:00.000Z',
    })));
  /* NOTE: every forge attempt below must use coordinates that DIFFER from what is
     already stored. Firestore's diff() reports no affected keys when a write sets
     identical values, and hasOnly([]) is trivially true — so a no-op write passes
     the rule and would look like a security hole that isn't one. Ask for a real
     change, or the assertion proves nothing. */
  await check('BUYER CANNOT forge the rider position',
    assertFails(pkg(asBuyer, 'DEL-AAA111').update({
      driverLat: -1.3500, driverLng: 36.7000,
      driverLocUpdatedAt: '2026-08-11T09:07:00.000Z',
    })));
  await check('SELLER CANNOT forge the rider position',
    assertFails(pkg(asSeller, 'DEL-AAA111').update({
      driverLat: -1.3600, driverLng: 36.7100,
    })));
  await check('rider CANNOT publish coordinates outside Kenya (_validGPS)',
    assertFails(pkg(asRider, 'DEL-AAA111').update({
      driverLat: NON_KE.lat, driverLng: NON_KE.lng,
    })));
  await check('rider CANNOT smuggle deliveryFee alongside a position update',
    assertFails(pkg(asRider, 'DEL-AAA111').update({
      driverLat: -1.2901, driverLng: 36.8201, deliveryFee: 1,
    })));
  await check('rider CANNOT smuggle proofPIN alongside a position update',
    assertFails(pkg(asRider, 'DEL-AAA111').update({
      driverLat: -1.2902, driverLng: 36.8202, proofPIN: '0000',
    })));

  console.log('\ndeliveries (hub) — same boundary');
  await check('sender reads their own hub delivery',
    assertSucceeds(hub(asBuyer, 'hub1').get()));
  await check('unrelated user CANNOT read a hub delivery',
    assertFails(hub(asBuyer2, 'hub1').get()));
  await check('ASSIGNED rider publishes position on a hub delivery',
    assertSucceeds(hub(asRider, 'hub1').update({
      driverLat: -1.2910, driverLng: 36.8210,
      driverLocUpdatedAt: '2026-08-11T09:06:00.000Z',
    })));
  await check('UNASSIGNED rider CANNOT publish on a hub delivery',
    assertFails(hub(asRider2, 'hub1').update({
      driverLat: -1.3200, driverLng: 36.7600,
    })));
  /* ── KNOWN GAP (pre-existing, deliberately characterised, NOT introduced here) ──
     The hub sender clause is a BLOCKLIST:

       resource.data.senderUid == request.auth.uid
       && !...affectedKeys().hasAny(['senderUid','deliveryFee','proofPIN'])

     so a sender may write any other field on their own delivery — including
     status, deliveredAt, assignedRiderId and now driverLat/driverLng. The
     equivalent packageRequests clause is a strict allowlist and correctly denies
     this (asserted above).

     Impact on tracking specifically is nil: the sender is the only reader of their
     own map, so forging their own rider pin deceives nobody. The real exposure is
     status/deliveredAt forging, which predates this work and belongs to a separate
     hub-rules convergence — converting the clause to an allowlist requires tracing
     every legitimate sender write (cancelDelivery, confirmReceipt) and is not an
     RC-freeze change.

     Asserted as CURRENT behaviour so the suite stays honest and the gap is on the
     record. Flip this to assertFails when the hub clause becomes an allowlist. */
  await check('KNOWN GAP: hub sender can still write arbitrary fields (blocklist rule)',
    assertSucceeds(hub(asBuyer, 'hub1').update({
      driverLat: -1.3300, driverLng: 36.7700,
    })));
  await check('hub rider CANNOT publish coordinates outside Kenya',
    assertFails(hub(asRider, 'hub1').update({
      driverLat: NON_KE.lat, driverLng: NON_KE.lng,
    })));
  await check('hub rider CANNOT smuggle deliveryFee alongside a position',
    assertFails(hub(asRider, 'hub1').update({
      driverLat: -1.2911, driverLng: 36.8211, deliveryFee: 1,
    })));

  console.log('\nrider GPS collections stay closed to buyers (why the mirror exists)');
  await check('buyer CANNOT read deliveryLocations/{rider} — no `viewers` array is ever written',
    assertFails(asBuyer.collection('deliveryLocations').doc(RIDER).get()));
  await check('buyer CANNOT read driverLocations/{rider}',
    assertFails(asBuyer.collection('driverLocations').doc(RIDER).get()));
  await check('rider CAN still read their own GPS doc',
    assertSucceeds(asRider.collection('deliveryLocations').doc(RIDER).get()));

  await env.cleanup();
  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
