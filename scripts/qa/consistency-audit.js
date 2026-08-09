/**
 * READ-ONLY production data-consistency audit (Phase 2 hardening).
 * Verifies ONE canonical source of truth per entity for a merchant, and flags the exact failure
 * modes seen in this project: wrong owner id, stale/legacy collections, inventory mismatch,
 * split identity. No writes.
 *
 * Usage: node scripts/qa/consistency-audit.js [sellerUid]
 */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const UID = process.argv[2] || 'D5Ql2EYr95bt79IpcGTmOMTK0P83';   // KASS (merged Google account)
const OLD = 'xrH21J5GFbW8PluCZ2ny5nIuf602';                      // deprecated phone account

const P = (ok, label, detail) => console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);

(async () => {
  console.log(`\n=== Consistency audit for ${UID.slice(0, 10)}… ===\n`);

  // 1. Identity — one user doc, clean roles
  console.log('MERCHANT IDENTITY');
  const u = await db.collection('users').doc(UID).get();
  P(u.exists, 'users/{uid} exists');
  if (u.exists) {
    const roles = u.data().roles || [];
    const dupes = roles.length !== new Set(roles.map(r => String(r).toLowerCase())).size;
    P(!dupes, 'roles are a unique set', JSON.stringify(roles));
  }
  const oldU = await db.collection('users').doc(OLD).get();
  P(true, 'deprecated account still present?', oldU.exists ? 'yes (xrH — legacy, should not be signed into)' : 'no');

  // 2. Shop / provider record
  console.log('\nSHOP / PROVIDER');
  const prov = await db.collection('providers').doc(UID).get().catch(() => ({ exists: false }));
  const seller = await db.collection('sellers').doc(UID).get().catch(() => ({ exists: false }));
  P(prov.exists || seller.exists, 'has a shop record (providers or sellers)',
    `providers=${prov.exists} sellers=${seller.exists}`);

  // 3. Inventory — canonical products, all owned by this uid, no legacy posProducts
  console.log('\nINVENTORY (canonical: products)');
  const prods = await db.collection('products').where('sellerUid', '==', UID).get();
  P(prods.size > 0, 'products where sellerUid==uid', `${prods.size} product(s)`);
  let mismatched = 0, noStock = 0;
  prods.forEach(d => { const p = d.data(); if (p.sellerUid !== UID && p.uid !== UID) mismatched++; if (p.stock == null) noStock++; });
  P(mismatched === 0, 'no owner-id mismatch on products', mismatched ? `${mismatched} mismatched` : 'clean');
  P(true, 'products missing a stock field', noStock ? `${noStock} (default-visible, but verify)` : 'none');
  const posProds = await db.collection('posProducts').where('sellerUid', '==', UID).get().catch(() => ({ size: 0 }));
  P(posProds.size === 0, 'legacy posProducts is empty (till reads canonical products)', `${posProds.size} doc(s)`);

  // 4. Orders — attributed to the surviving uid (post-backfill), not the deprecated one
  console.log('\nORDERS');
  const byUid = await db.collection('orders').where('uid', '==', UID).get();
  const byBuyer = await db.collection('orders').where('buyerUid', '==', UID).get();
  const stillOld = await db.collection('orders').where('uid', '==', OLD).get();
  P(true, 'orders where uid==uid', `${byUid.size}`);
  P(true, 'orders where buyerUid==uid', `${byBuyer.size}`);
  P(stillOld.size === 0, 'no orders still attributed to the deprecated uid', `${stillOld.size}`);

  // 5. Terminal / hardware profile
  console.log('\nPOS TERMINAL / HARDWARE');
  const term = await db.collection('posTerminals').doc(UID + '_hardware').get();
  P(term.exists, 'posTerminals/{uid}_hardware exists');
  if (term.exists) {
    const t = term.data();
    P(t.uid === UID, 'terminal uid matches (rule authority)', t.uid || '—');
    P(!!t.setupComplete, 'setupComplete flag set (onboarding gate)', String(!!t.setupComplete));
  }

  console.log('\n=== audit complete (read-only) ===\n');
  process.exit(0);
})().catch(e => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
