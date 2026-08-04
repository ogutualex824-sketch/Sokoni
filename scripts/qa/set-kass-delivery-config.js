'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Set a real deliveryConfig on a seller so the checkout exercises the AUTHORITATIVE
   delivery-pricing path (index.js darajaSTKPush recompute) instead of the legacy clamp —
   which is what stops `delivery_fee_unverified` for that merchant.

     node scripts/qa/set-kass-delivery-config.js <ID> [mode]

   <ID> may be EITHER:
     • a seller Firebase UID  → writes sellers/{uid}.deliveryConfig directly, OR
     • a Business ID "BIZ-…"  → resolves businesses/{BIZ}.ownerId (the owner's Firebase
                                UID) and writes sellers/{ownerUid}.deliveryConfig.

   WHY: checkout reads deliveryConfig from `sellers/{sellerUid}` where sellerUid is the
   seller's Firebase Auth UID (sellers docs are keyed by auth.uid — pos-qr.js:107,
   pos-session.js:56). `businesses/{BIZ-…}` is a DIFFERENT collection; writing the config
   there would never be read. This script resolves the mapping so you can't target the
   wrong doc.

   Requires admin creds (GOOGLE_APPLICATION_CREDENTIALS = service-account key, or
   `gcloud auth application-default login`). Writes ONE field with merge; touches nothing
   else. Emulator-safe (honours FIRESTORE_EMULATOR_HOST). It VERIFIES the target
   sellers/{uid} doc exists and REFUSES to write a phantom seller.
   ───────────────────────────────────────────────────────────────────────────── */
const admin = require('firebase-admin');

const rawId = process.argv[2];
const mode  = process.argv[3] || 'distance';
if (!rawId) { console.error('Usage: node scripts/qa/set-kass-delivery-config.js <SELLER_UID | BIZ-...> [mode]'); process.exit(1); }

const CONFIG = {
  enabled:    true,
  mode:       mode,      // 'distance' | 'flat' | 'zones' | 'free' | 'own_fleet'
  baseFee:    100,       // KES — distance mode
  perKm:      20,        // KES/km — distance mode
  freeAbove:  3000,      // KES subtotal → free delivery
  defaultFee: 200,       // KES — flat / own_fleet fallback
};

(async () => {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
  const db = admin.firestore();

  /* Resolve a Business ID to the owner's Firebase UID; a plain UID passes through. */
  let sellerUid = String(rawId);
  if (/^BIZ-/i.test(rawId)) {
    const bizSnap = await db.collection('businesses').doc(String(rawId)).get();
    if (!bizSnap.exists) { console.error(`business ${rawId} not found in businesses/. Check the Business ID.`); process.exit(2); }
    const b = bizSnap.data() || {};
    sellerUid = b.ownerId || b.owner || b.ownerUid || b.sellerUid || null;
    if (!sellerUid) { console.error(`businesses/${rawId} has no ownerId/owner/ownerUid — cannot map to a seller UID.`); process.exit(2); }
    console.log(`resolved ${rawId} → owner Firebase UID ${sellerUid}`);
  }

  /* Guard: checkout reads sellers/{sellerUid}; refuse to write a doc it will never read. */
  const ref = db.collection('sellers').doc(String(sellerUid));
  const before = await ref.get();
  if (!before.exists) {
    console.error(`sellers/${sellerUid} does not exist — the checkout would not read a config here.`);
    console.error(`Confirm the seller's Firebase UID (a Kass product's sellerUid field, or businesses/${rawId}.ownerId) and pass THAT.`);
    process.exit(3);
  }

  await ref.set({ deliveryConfig: Object.assign({}, CONFIG, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }) }, { merge: true });

  const after = (await ref.get()).data().deliveryConfig;
  console.log(`✓ deliveryConfig set on sellers/${sellerUid}:`);
  console.log(JSON.stringify({ enabled: after.enabled, mode: after.mode, baseFee: after.baseFee, perKm: after.perKm, freeAbove: after.freeAbove }, null, 2));
  console.log('\nNext: place a Kass Shop order — checkout now recomputes the fee from this config,');
  console.log('rejects any client mismatch, and no longer logs delivery_fee_unverified.');
  process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(4); });
