/* ══════════════════════════════════════════════════════════════════════════════
   KASS SUBSCRIPTION — production verification (READ ONLY)
   ══════════════════════════════════════════════════════════════════════════════
   The KES 499 purchase is treated as a production INCIDENT to verify, not as
   something already understood. The code fix proves the plan-resolution defect in
   the emulator; it proves nothing about whether the payment arrived, whether a
   subscription record exists, or what this merchant's ceiling is right now.

   This script answers the release gate, arrow by arrow:

     KASS 499 → payment → subscription → entitlement → Merchant v2
              → product limit → inventory

   ── IT WRITES NOTHING ───────────────────────────────────────────────────────
   Every operation is a read. There is no set(), no update(), no delete() in this
   file, and the suite asserts that. Diagnosing a billing incident must not be
   able to change the thing being diagnosed.

   ── RUN ─────────────────────────────────────────────────────────────────────
     gcloud auth application-default login          (needs production credentials)
     node scripts/verify-kass-subscription.js <shopUidOrEmail>

   Without credentials it reports UNPROVEN and exits 0 — an unrun check is not a
   passed check, and it is not a failure either.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const TARGET = process.argv[2] || process.env.KASS_UID || '';
const line = (k, v) => console.log('  ' + (k + ' ').padEnd(28, '.') + ' ' + v);
const head = (t) => console.log('\n' + t);

console.log('\nKASS SUBSCRIPTION — production verification (READ ONLY)');
console.log('='.repeat(74));

(async () => {
  let admin, db;
  try {
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-aeb26' });
    db = admin.firestore();
    /* Cheapest possible proof that credentials actually work. */
    await db.collection('shops').limit(1).get();
  } catch (e) {
    head('UNPROVEN');
    console.log('  Production credentials unavailable: ' + String((e && e.message) || e).slice(0, 90));
    console.log('  Run: gcloud auth application-default login');
    console.log('\n  NOTHING was verified. The plan-resolution fix is proven in the');
    console.log('  emulator only; the live KASS state is unknown.\n');
    process.exit(0);
  }

  if (!TARGET) {
    console.log('\n  Usage: node scripts/verify-kass-subscription.js <shopUid|email>');
    console.log('         node scripts/verify-kass-subscription.js --find <name fragment>\n');
    process.exit(2);
  }

  /* ── FIND MODE ─────────────────────────────────────────────────────────────
     The verification needs the SHOP uid, and a shop uid is not something anyone
     remembers. This scans shop names for a fragment and prints only id + name —
     no contact details, no customer data. Still read-only. */
  if (TARGET === '--find') {
    const frag = String(process.argv[3] || '').toLowerCase();
    if (!frag) { console.log('\n  --find needs a name fragment\n'); process.exit(2); }
    head('Shops matching "' + frag + '"');
    /* Firestore has no substring search, so this pages and filters client-side.
       Bounded so a typo cannot walk the whole collection. */
    let scanned = 0, shown = 0, last = null;
    while (scanned < 5000) {
      let q = db.collection('shops').orderBy('__name__').limit(500);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) break;
      page.forEach((d) => {
        scanned++;
        const n = String((d.data() || {}).name || (d.data() || {}).storeName || '');
        if (n.toLowerCase().indexOf(frag) > -1) { shown++; line(d.id, n); }
      });
      last = page.docs[page.docs.length - 1];
      if (page.size < 500) break;
    }
    console.log('\n  ' + shown + ' match(es) in ' + scanned + ' shops scanned. Nothing was written.\n');
    process.exit(0);
  }

  /* Resolve the uid without writing anything. */
  let uid = TARGET;
  if (TARGET.indexOf('@') > -1) {
    try { uid = (await admin.auth().getUserByEmail(TARGET)).uid; }
    catch (_) { console.log('\n  No account for ' + TARGET + '\n'); process.exit(2); }
  }

  head('1 - identity');
  const [shopSnap, userSnap] = await Promise.all([
    db.doc('shops/' + uid).get(), db.doc('users/' + uid).get(),
  ]);
  line('uid', uid);
  line('shops/{uid}', shopSnap.exists ? (shopSnap.data().name || '(no name)') : 'MISSING');
  line('users/{uid}', userSnap.exists ? (userSnap.data().name || userSnap.data().displayName || '(no name)') : 'MISSING');

  /* ── THE FALSE-NEGATIVE GUARD ──────────────────────────────────────────────
     Without this, a run with no credentials reached the verdict and printed five
     RED arrows — which reads as "confirmed broken" when in fact NOTHING was
     read. A diagnosis that fails convincingly is worse than one that fails
     loudly. A real merchant has a shops document and a users document; if
     neither exists we cannot tell "wrong uid" from "no access", so we refuse to
     report a verdict at all. */
  if (!shopSnap.exists && !userSnap.exists) {
    head('UNPROVEN');
    console.log('  Neither shops/' + uid + ' nor users/' + uid + ' could be read.');
    console.log('  That is either the wrong uid or no production access — and this');
    console.log('  script cannot tell those apart. NO verdict is reported.');
    console.log('\n  Run: gcloud auth application-default login, then pass the real shop uid.\n');
    process.exit(0);
  }

  head('2 - payment');
  /* aiPaymentRefs is the idempotency claim ai-subscriptions writes per payment. */
  const payRefs = await db.collection('aiPaymentRefs').where('uid', '==', uid).limit(10).get().catch(() => null);
  line('aiPaymentRefs', payRefs ? payRefs.size + ' record(s)' : 'unreadable');
  if (payRefs) payRefs.forEach((d) => {
    const p = d.data();
    line('  ref ' + d.id.slice(0, 18), (p.amount != null ? 'KES ' + p.amount + ' ' : '') + (p.plan || '') + ' ' + (p.createdAt ? '' : '(no createdAt)'));
  });
  for (const coll of ['walletTransactions', 'payments', 'billingRecords']) {
    const s = await db.collection(coll).where('uid', '==', uid).limit(5).get().catch(() => null);
    if (s && !s.empty) line(coll, s.size + ' record(s)');
  }

  head('3 - subscription records, BOTH stores');
  const aiSub = await db.doc('aiSubscriptions/' + uid).get().catch(() => null);
  line('aiSubscriptions/{uid}', aiSub && aiSub.exists
    ? (aiSub.data().plan + ' / ' + aiSub.data().status) : 'MISSING');
  const subsById = await db.doc('subscriptions/' + uid).get().catch(() => null);
  line('subscriptions/{uid}', subsById && subsById.exists
    ? ((subsById.data().plan || subsById.data().planId) + ' / ' + subsById.data().status) : 'none');
  const subsByUid = await db.collection('subscriptions').where('uid', '==', uid).limit(10).get().catch(() => null);
  line('subscriptions where uid==', subsByUid ? subsByUid.size + ' record(s)' : 'unreadable');
  if (subsByUid) subsByUid.forEach((d) => {
    const s = d.data();
    line('  ' + d.id.slice(0, 20), (s.plan || s.planId || s.tier || '?') + ' / ' + (s.status || '?'));
  });

  head('4 - entitlement, as the fixed authority now resolves it');
  const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));
  const ent = await EA.getMerchantEntitlement(uid);
  line('effective plan', ent.plan + ' (' + ent.label + ')');
  line('status', ent.status);
  line('resolved from', (ent.resolvedFrom || '-') + ' / ' + (ent.resolvedPlanId || '-'));
  line('records considered', String(ent.considered));
  line('product limit', ent.limits.products === -1 ? 'unlimited' : String(ent.limits.products));
  line('products used', ent.limits.productsUsed === null ? '— (counter unreadable)' : String(ent.limits.productsUsed));
  line('trial', ent.trial.active ? ent.trial.daysRemaining + ' days remaining' : (ent.trial.used ? 'used' : 'none'));

  head('5 - the cached ceiling the RULES actually enforce');
  const ctr = await db.doc('productCounters/' + uid).get().catch(() => null);
  if (ctr && ctr.exists) {
    const c = ctr.data();
    line('productCounters.count', String(c.count));
    line('productCounters.maxProducts', String(c.maxProducts));
    line('source / catalogVersion', (c.source || '-') + ' / ' + (c.catalogVersion == null ? '-' : c.catalogVersion));
    line('DRIFT vs entitlement', c.maxProducts === ent.limits.products ? 'none' :
      'YES — cached ' + c.maxProducts + ' vs entitled ' + ent.limits.products);
  } else {
    line('productCounters/{uid}', 'MISSING — the rules cap is fail-open for this shop');
  }

  head('6 - real product count, counted not trusted');
  const real = await db.collection('products').where('sellerUid', '==', uid).count().get()
    .then((s) => s.data().count).catch(() => null);
  line('products (counted)', real === null ? 'unreadable' : String(real));
  if (ctr && ctr.exists && real !== null) {
    line('counter drift', ctr.data().count === real ? 'none' : 'YES — counter ' + ctr.data().count + ' vs real ' + real);
  }

  head('VERDICT');
  const arrows = [
    ['payment received', payRefs && payRefs.size > 0],
    ['subscription record', !!(aiSub && aiSub.exists) || (subsByUid && subsByUid.size > 0)],
    ['entitlement resolves paid', ent.plan !== 'FREE'],
    ['ceiling matches entitlement', !!(ctr && ctr.exists && ctr.data().maxProducts === ent.limits.products)],
    ['counter matches reality', !!(ctr && ctr.exists && real !== null && ctr.data().count === real)],
  ];
  arrows.forEach(([label, ok]) => console.log('  ' + (ok ? 'GREEN ' : 'RED   ') + label));
  const red = arrows.filter(([, ok]) => !ok).length;
  console.log('\n  ' + (red === 0 ? 'Every arrow green.' : red + ' arrow(s) RED — the chain is not closed.'));
  console.log('  Nothing was written by this script.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n  Verification aborted: ' + (e && e.message) + '\n');
  process.exit(1);
});
