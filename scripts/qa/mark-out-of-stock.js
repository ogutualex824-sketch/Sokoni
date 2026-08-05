/* mark-out-of-stock.js — flag any product at stock 0 as outOfStock=true.
   The webhook now auto-flags this on the sale that hits 0; this fixes products
   already at 0 (e.g. oversold before the guard existed).
   USAGE: node scripts/qa/mark-out-of-stock.js [productId]   (default: scan all) */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();
const only = process.argv[2] || null;

(async () => {
  const ts = admin.firestore.FieldValue.serverTimestamp();
  const docs = only
    ? [await db.collection('products').doc(only).get()]
    : (await db.collection('products').where('stock', '<=', 0).limit(500).get()).docs;
  let n = 0;
  for (const d of docs) {
    if (!d.exists) continue;
    const p = d.data();
    if ((Number(p.stock) || 0) <= 0 && p.outOfStock !== true) {
      await d.ref.update({ outOfStock: true, updatedAt: ts });
      console.log('  outOfStock=true →', d.id, '|', p.name, '| stock:', p.stock);
      n++;
    }
  }
  console.log(`Done. ${n} product(s) flagged out of stock.`);
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
