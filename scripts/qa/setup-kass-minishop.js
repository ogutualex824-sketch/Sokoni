/* setup-kass-minishop.js — create KASS's MiniShop so the storefront resolves + shows products.
   KASS (D5Ql2) had a sellers/ record but NO shopHandles mapping, shops doc, minishopConfig, and
   its 103 products had no shopId — so functions/minishop.js (resolves shopHandles/{handle} →
   shops/{shopId} → products where shopId==shopId) returned 404/empty.
   Canonical choice: shopId == uid == sellerUid == D5Ql2 (single-owner shop), so product.shopId
   backfill = sellerUid. This is Stage 3 (ownership) applied to KASS.
   USAGE: node scripts/qa/setup-kass-minishop.js [handle]   (default handle: kass) */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const UID    = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const HANDLE = (process.argv[2] || 'kass').toLowerCase().replace(/[^a-z0-9_-]/g, '');

(async () => {
  const ts = admin.firestore.FieldValue.serverTimestamp();

  // 1 — handle mapping (shopHandles/{handle} → {shopId, uid})
  const hRef = db.collection('shopHandles').doc(HANDLE);
  const hSnap = await hRef.get();
  if (hSnap.exists && hSnap.data().uid && hSnap.data().uid !== UID) {
    console.error('Handle already taken by another shop:', HANDLE); process.exit(1);
  }
  await hRef.set({ shopId: UID, uid: UID, handle: HANDLE, createdAt: ts }, { merge: true });

  // 2 — shop doc (shops/{shopId}); minishopConfig sub-object drives branding via resolveConfig
  await db.collection('shops').doc(UID).set({
    id: UID, handle: HANDLE, name: 'KASS SHOP', shopName: 'KASS SHOP',
    sellerUid: UID, uid: UID, active: true, status: 'active',
    minishopConfig: { tagline: 'KASS SHOP — Premium Vapes & Pods', accent: '#71ff00' },
    createdAt: ts, updatedAt: ts,
  }, { merge: true });

  // 3 — minishopConfig/{shopId}
  await db.collection('minishopConfig').doc(UID).set({
    tagline: 'KASS SHOP — Premium Vapes & Pods', accent: '#71ff00', totalProducts: 0, followerCount: 0, updatedAt: ts,
  }, { merge: true });

  // 4 — backfill product.shopId = sellerUid (Stage 3 ownership) for every KASS product
  const snap = await db.collection('products').where('sellerUid', '==', UID).limit(500).get();
  let n = 0, batch = db.batch(), ops = 0;
  for (const d of snap.docs) {
    if (!d.data().shopId) {
      batch.update(d.ref, { shopId: UID, updatedAt: ts }); n++; ops++;
      if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
  }
  if (ops) await batch.commit();
  await db.collection('minishopConfig').doc(UID).set({ totalProducts: snap.size }, { merge: true });

  console.log(`MiniShop ready: handle "${HANDLE}" · shopId ${UID.slice(0,6)} · products tagged ${n}/${snap.size}`);
  console.log(`Storefront: https://mysokoni.co.ke/@${HANDLE}  ·  https://mysokoni.co.ke/shop/${HANDLE}`);
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
