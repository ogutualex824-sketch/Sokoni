'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Set a real deliveryConfig on a seller so the checkout exercises the AUTHORITATIVE
   delivery-pricing path (index.js:3313-3374) instead of the legacy clamp — which is
   what stops `delivery_fee_unverified` for that merchant.

     node scripts/qa/set-kass-delivery-config.js <SELLER_UID> [mode]

   Requires admin creds in the environment (GOOGLE_APPLICATION_CREDENTIALS pointing at
   a service-account key, or `gcloud auth application-default login`). Writes ONE field
   (sellers/{uid}.deliveryConfig) with merge — touches nothing else. Emulator-safe:
   honours FIRESTORE_EMULATOR_HOST if set.

   The config matches functions/shared/delivery-engine.js calculateDelivery():
     mode 'distance' → fee = baseFee + perKm × distanceKm ; free above `freeAbove`.
   ───────────────────────────────────────────────────────────────────────────── */
const admin = require('firebase-admin');

const uid  = process.argv[2];
const mode = process.argv[3] || 'distance';
if (!uid) { console.error('Usage: node scripts/qa/set-kass-delivery-config.js <SELLER_UID> [mode]'); process.exit(1); }

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
  const ref = db.collection('sellers').doc(String(uid));
  const before = await ref.get();
  if (!before.exists) { console.error(`seller ${uid} not found — check the UID.`); process.exit(2); }

  await ref.set({ deliveryConfig: Object.assign({}, CONFIG, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }) }, { merge: true });

  const after = (await ref.get()).data().deliveryConfig;
  console.log(`✓ deliveryConfig set on sellers/${uid}:`);
  console.log(JSON.stringify({ enabled: after.enabled, mode: after.mode, baseFee: after.baseFee, perKm: after.perKm, freeAbove: after.freeAbove }, null, 2));
  console.log('\nNext: place a Kass Shop order — checkout now recomputes the fee from this config,');
  console.log('rejects any client mismatch, and no longer logs delivery_fee_unverified.');
  process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(3); });
