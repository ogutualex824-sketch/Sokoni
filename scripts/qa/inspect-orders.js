/**
 * READ-ONLY diagnostic: inspect recent `orders` docs to explain why a buyer's
 * my-orders list is empty. Shows the buyer-identity fields the my-orders query
 * (`where uid == <buyer>`) depends on. No writes.
 *
 * Usage: node scripts/qa/inspect-orders.js [phoneOrUid]
 */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const NEEDLE = process.argv[2] || null;   // optional phone (+254…) or uid to spotlight

(async () => {
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(40).get();
  console.log(`\n=== ${snap.size} most-recent orders ===`);
  const rows = [];
  snap.forEach(d => {
    const o = d.data() || {};
    rows.push({
      id: d.id.slice(0, 14),
      uid: o.uid || '—',
      buyerUid: o.buyerUid || '—',
      buyerId: o.buyerId || '—',
      phone: o.buyerPhone || o.customerPhone || '—',
      seller: (o.sellerUid || '—').slice(0, 8),
      source: o.source || '—',
      total: o.total ?? o.amount ?? o.orderTotal ?? '—',
      status: o.status || '—',
    });
  });
  console.table(rows);

  // Field-presence tally — is `uid` (what my-orders queries) actually populated?
  const tally = { hasUid: 0, uidNull: 0, hasBuyerUid: 0, hasBuyerId: 0, hasPhone: 0 };
  snap.forEach(d => {
    const o = d.data() || {};
    if (o.uid) tally.hasUid++; else tally.uidNull++;
    if (o.buyerUid) tally.hasBuyerUid++;
    if (o.buyerId) tally.hasBuyerId++;
    if (o.buyerPhone || o.customerPhone) tally.hasPhone++;
  });
  console.log('\n=== buyer-field presence across those orders ===');
  console.log(tally);

  if (NEEDLE) {
    console.log(`\n=== orders matching "${NEEDLE}" (uid / buyerUid / phone) ===`);
    const byUid = await db.collection('orders').where('uid', '==', NEEDLE).limit(10).get().catch(() => ({ size: 0, forEach() {} }));
    const byPhone = await db.collection('orders').where('buyerPhone', '==', NEEDLE).limit(10).get().catch(() => ({ size: 0, forEach() {} }));
    console.log(`  where uid == needle      → ${byUid.size} order(s)`);
    console.log(`  where buyerPhone == needle → ${byPhone.size} order(s)`);
  }
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
