'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Consolidate KASS SHOP onto the operator's account (D5Ql2) — the account the
   products actually attribute to (a localStorage→Firestore sync keeps writing
   sellerUid=D5Ql2, overwriting the separate xrH2 shop entity). Rather than fight
   the sync, make D5Ql2 the canonical KASS seller so checkout owner-resolution,
   deliveryConfig lookup, and settlement all align on ONE account.

     node scripts/qa/consolidate-kass-seller.js

   Writes (idempotent, merge):
     • sellers/{D5Ql2}  — seller profile "KASS SHOP", status active, deliveryConfig (distance)
     • users/{D5Ql2}.roles += 'seller'
   Products already carry sellerUid=D5Ql2, so NO product writes are needed.

   Requires admin creds (GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth
   application-default login`) and NODE_PATH=functions/node_modules.
   ───────────────────────────────────────────────────────────────────────────── */
const admin = require('firebase-admin');

const UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';     // Kaspa / alexochieng3030 — the KASS operator
const CONFIG = { enabled: true, mode: 'distance', baseFee: 100, perKm: 20, freeAbove: 3000, defaultFee: 200 };

(async () => {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
  const db = admin.firestore();
  const now = () => admin.firestore.FieldValue.serverTimestamp();

  const liveCount = (await db.collection('products').where('sellerUid', '==', UID).count().get()).data().count;

  await db.collection('sellers').doc(UID).set({
    name: 'KASS SHOP', shopName: 'KASS SHOP', status: 'active', ownerId: UID,
    productCount: liveCount,
    deliveryConfig: Object.assign({}, CONFIG, { updatedAt: now() }),
    updatedAt: now(), _consolidatedFrom: 'xrH21J5GFbW8PluCZ2ny5nIuf602', _consolidatedAt: now(),
  }, { merge: true });

  await db.collection('users').doc(UID).set(
    { roles: admin.firestore.FieldValue.arrayUnion('seller'), isSeller: true, updatedAt: now() },
    { merge: true });

  const s = (await db.collection('sellers').doc(UID).get()).data();
  const u = (await db.collection('users').doc(UID).get()).data();
  console.log('✓ sellers/D5Ql2:', JSON.stringify({ name: s.name, status: s.status, deliveryConfig: s.deliveryConfig && s.deliveryConfig.mode + ' base' + s.deliveryConfig.baseFee }));
  console.log('✓ users.roles:', JSON.stringify(u.roles));
  console.log('✓ products.sellerUid==D5Ql2:', liveCount, '(checkout owner = sellerUid = D5Ql2, deliveryConfig now on this seller)');
  console.log('\nGate order now aligns on ONE account: buyer -> KASS product (sellerUid=D5Ql2) -> pay -> settle to wallets/D5Ql2.');
  console.log('NOTE: D5Ql2 is also the provisioned rider — for seller≠rider, use a different online rider, or accept solo (owner plays both).');
  process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
