/* ────────────────────────────────────────────────────────────────────────────
   set-kass-test-price.js — set the KASS test product's price for the checkout
   gate test, so the live order charges a small, predictable amount.

   USAGE (run from repo root):
       node scripts/qa/set-kass-test-price.js            # sets price = 100
       node scripts/qa/set-kass-test-price.js 50         # sets price = 50

   After running: on the phone, CLEAR the cart, open the product page (it will now
   show the new price), ADD to cart, then checkout — the STK will request exactly
   this amount. The IntaSend product path currently charges the client-computed
   total, so the cart must be rebuilt from the updated product for the amount to
   match. (Server-authoritative re-pricing for this path is a tracked follow-up.)
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const PRODUCT_ID = '1784487613418';                 /* BLUEBERRY RASPBERRY */
const price = Math.max(1, Math.round(Number(process.argv[2]) || 100));

(async () => {
  const ref = db.collection('products').doc(PRODUCT_ID);
  const before = (await ref.get()).data();
  if (!before) { console.error('Product not found:', PRODUCT_ID); process.exit(1); }
  console.log(`BEFORE  price=${before.price}  name=${before.name}`);
  await ref.update({ price, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  const after = (await ref.get()).data();
  console.log(`AFTER   price=${after.price}`);
  console.log('\nDone. On the phone: clear cart → open the product → add to cart → checkout.');
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
