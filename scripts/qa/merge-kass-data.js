/* merge-kass-data.js — STEP 1 (safe, non-destructive) of merging the two KASS accounts.
   Consolidates the phone account's DATA into the Google account (canonical), which already
   holds the 103 products + orders + MiniShop. No auth changes here (that's step 2).
     FROM (phone)  xrH21J5GFb… — name KASS SHOP, 10 products (uid), 4 buyer orders, KES 4 wallet
     TO   (Google) D5Ql2…      — alexochieng3030@gmail.com, 103 products, shop kassshop
   USAGE: node scripts/qa/merge-kass-data.js */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const FROM = 'xrH21J5GFbW8PluCZ2ny5nIuf602';
const TO   = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

(async () => {
  const ts = admin.firestore.FieldValue.serverTimestamp();

  // 1 — products created under the phone account → re-owned by the canonical account
  const prods = await db.collection('products').where('uid', '==', FROM).get();
  let n = 0, batch = db.batch();
  prods.forEach(d => { batch.update(d.ref, { sellerUid: TO, uid: TO, shopId: TO, updatedAt: ts }); n++; });
  if (n) await batch.commit();
  console.log('products re-owned FROM→TO:', n);

  // 2 — buyer orders placed under the phone account → keep in the canonical account's history
  const ords = await db.collection('orders').where('buyerUid', '==', FROM).get();
  let m = 0, b2 = db.batch();
  ords.forEach(d => { b2.update(d.ref, { buyerUid: TO }); m++; });
  if (m) await b2.commit();
  console.log('buyer orders re-linked FROM→TO:', m);

  // 3 — merge profile fields onto the canonical user (phone + shop name), record the link
  const fu = (await db.collection('users').doc(FROM).get()).data() || {};
  await db.collection('users').doc(TO).set({
    phoneNumber: fu.phoneNumber || '+254705726803',
    shopName: fu.shopName || 'KASS SHOP',
    linkedAccounts: admin.firestore.FieldValue.arrayUnion(FROM),
    updatedAt: ts,
  }, { merge: true });
  console.log('profile merged onto TO (phone + shopName + linkedAccounts)');

  // verify
  const total = await db.collection('products').where('sellerUid', '==', TO).count().get();
  console.log('\nTO now owns products:', total.data().count);
  console.log('NOTE: wallets/' + FROM.slice(0, 8) + ' holds KES 4 — left untouched (wallet backend FROZEN).');
  console.log('Next: step 2 moves the phone number to TO so phone login also lands on D5Ql2.');
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
