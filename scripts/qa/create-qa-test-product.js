/* ────────────────────────────────────────────────────────────────────────────
   create-qa-test-product.js — a dedicated QA/Test product with high stock so the
   checkout gate can be re-run end-to-end WITHOUT editing a real product's
   inventory each time.

   USAGE:  node scripts/qa/create-qa-test-product.js            # stock 100, price 100
           node scripts/qa/create-qa-test-product.js 50 100     # stock 50, price 100

   Owned by the KASS SHOP seller (D5Ql2) so it settles into the same wallet the
   gate verifies. Product page:  https://mysokoni.co.ke/product.html?id=QATEST100
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const D  = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';   /* KASS SHOP seller */
const ID = 'QATEST100';
const stock = Math.max(1, Math.round(Number(process.argv[2]) || 100));
const price = Math.max(1, Math.round(Number(process.argv[3]) || 100));

/* Search prefixes so it surfaces in local-first search. */
const terms = new Set();
['qa', 'test', 'sokoni test', 'test product', 'vape'].forEach((w) => {
  const s = w.toLowerCase();
  for (let i = 2; i <= s.length; i++) terms.add(s.slice(0, i));
  terms.add(s);
});

(async () => {
  const ref = db.collection('products').doc(ID);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    id: ID,
    name: 'SOKONI QA Test Product',
    nameLower: 'sokoni qa test product',
    description: 'Dedicated QA end-to-end checkout test product. High stock so gate tests can repeat. Not a real listing.',
    price, costPrice: 0, deliveryCost: 0,
    stock, outOfStock: false, sold: 0, inventoryVersion: 0,
    sellerUid: D, uid: D,
    sellerName: 'KASS SHOP', businessName: 'KASS SHOP', sellerEmail: '',
    category: 'vape', location: 'nairobi',
    status: 'active', verificationStatus: 'none',
    isDigital: false, isService: false,
    image: '', images: [], imageStorageUrls: [],
    searchableTerms: Array.from(terms),
    createdAt: now, updatedAt: now, uploadedAt: now,
    _qaTestProduct: true,
  }, { merge: true });
  const after = (await ref.get()).data();
  console.log('QA test product ready:');
  console.log('  id:', ID, '| name:', after.name, '| price:', after.price, '| stock:', after.stock, '| seller:', after.sellerName);
  console.log('  URL: https://mysokoni.co.ke/product.html?id=' + ID);
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
