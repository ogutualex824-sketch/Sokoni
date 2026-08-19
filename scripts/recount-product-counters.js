/* ══════════════════════════════════════════════════════════════════════════════
   PRODUCT COUNTER RECOUNT — from reality, not from arithmetic
   ══════════════════════════════════════════════════════════════════════════════
   `productCounters/{uid}.count` has drifted, and not merely staleness: the KASS
   shop holds **−23** against **103 real products**. Because the rule is
   `count < maxProducts`, a negative count means −23 < 10 PASSES — so the cap was
   never enforced. That is a bypass, not a display bug, and it is how 103 products
   exist against an allowance of 10.

   This recounts from the `products` collection — the only thing that is actually
   true — and never from the previous counter value. A drifted counter cannot be
   repaired by adjusting it; it has to be replaced by reality.

   ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
   Writes NOTHING unless `--apply` is passed. This touches a live merchant's
   enforcement record, so the default is to report and stop.

     node scripts/recount-product-counters.js <uid> [<uid> …]
     node scripts/recount-product-counters.js <uid> --apply

   ── IT DOES NOT SET THE CEILING ─────────────────────────────────────────────
   `maxProducts` is resolved by product-limit.syncLimit() from the subscription,
   and that is deliberately left alone here. Fixing the count and the ceiling in
   one script would make a wrong ceiling look like a counting error.

   ── GRANDFATHERING IS PRESERVED ─────────────────────────────────────────────
   A merchant at 103 against an allowance of 100 keeps all 103. Nothing is
   deleted, archived or hidden — creation is blocked until they are under the
   limit, and deleting frees capacity immediately. That behaviour already exists
   in product-limit.js; this script must not undermine it, so it reports the
   over-limit state rather than "correcting" it.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const APPLY = args.indexOf('--apply') > -1;
const UIDS = args.filter((a) => a.indexOf('--') !== 0);

const line = (k, v) => console.log('  ' + (k + ' ').padEnd(30, '.') + ' ' + v);
const head = (t) => console.log('\n' + t);

console.log('\nPRODUCT COUNTER RECOUNT ' + (APPLY ? '— APPLY (writes)' : '— DRY RUN (writes nothing)'));
console.log('='.repeat(74));

if (!UIDS.length) {
  console.log('\n  Usage: node scripts/recount-product-counters.js <uid> [<uid> …] [--apply]\n');
  process.exit(2);
}

(async () => {
  let admin;
  try {
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-aeb26' });
    await admin.firestore().collection('shops').limit(1).get();
  } catch (e) {
    console.log('\n  UNPROVEN — no production access: ' + String((e && e.message) || e).slice(0, 90));
    console.log('  Nothing was read and nothing was written.\n');
    process.exit(0);
  }
  const db = admin.firestore();
  const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));

  let anyDrift = false;
  for (const uid of UIDS) {
    head(uid);
    /* COUNTED, not trusted. count() is a server-side aggregate, so this does not
       page a large catalogue into memory. */
    const real = await db.collection('products').where('sellerUid', '==', uid).count().get()
      .then((s) => s.data().count).catch(() => null);
    if (real === null) { line('products (counted)', 'UNREADABLE — skipped, nothing written'); continue; }

    const snap = await db.doc('productCounters/' + uid).get().catch(() => null);
    const prev = (snap && snap.exists) ? snap.data() : null;
    const prevCount = prev && typeof prev.count === 'number' ? prev.count : null;

    line('products (counted)', String(real));
    line('counter.count (stored)', prevCount === null ? 'MISSING' : String(prevCount));
    line('counter.maxProducts', prev && prev.maxProducts != null ? String(prev.maxProducts) : 'MISSING');

    const ent = await EA.getMerchantEntitlement(uid).catch(() => null);
    if (ent) {
      line('entitled plan / limit', ent.plan + ' / ' + (ent.limits.products === -1 ? 'unlimited' : ent.limits.products));
      if (ent.resolvedUid && ent.resolvedUid !== uid) line('entitled VIA linked uid', ent.resolvedUid);
    }

    const drift = prevCount !== real;
    if (drift) anyDrift = true;
    line('drift', drift ? 'YES — ' + String(prevCount) + ' -> ' + real : 'none');

    /* The bypass, named explicitly where it exists. */
    if (prevCount !== null && prevCount < 0) {
      line('BYPASS', 'negative count passes `count < maxProducts` — cap was NOT enforced');
    }
    if (ent && ent.limits.products !== -1 && real > ent.limits.products) {
      line('OVER LIMIT after recount', real + ' > ' + ent.limits.products +
           ' — existing products stay, creation blocked until under the limit');
    }

    if (!drift) { line('action', 'none needed'); continue; }
    if (!APPLY) { line('action', 'WOULD set count = ' + real + '  (dry run — nothing written)'); continue; }

    await db.doc('productCounters/' + uid).set({
      uid: uid,
      count: real,
      /* Recorded so the correction is self-explaining a year from now. */
      recountedAt: admin.firestore.FieldValue.serverTimestamp(),
      recountedFrom: prevCount,
      recountSource: 'scripts/recount-product-counters.js',
    }, { merge: true });
    line('action', 'APPLIED — count set to ' + real + ' (was ' + prevCount + ')');
  }

  head('SUMMARY');
  console.log('  ' + (anyDrift ? 'Drift found.' : 'No drift.') +
              (APPLY ? ' Changes were written.' : ' DRY RUN — nothing was written.'));
  if (anyDrift && !APPLY) console.log('  Re-run with --apply to correct, once the numbers above are agreed.');
  console.log('  maxProducts was NOT touched — that is syncLimit\'s job.\n');
  process.exit(0);
})().catch((e) => { console.error('\n  Recount aborted: ' + (e && e.message) + '\n'); process.exit(1); });
