/**
 * Backfill orders.uid for the KASS account merge: the phone account `xrH…` was folded into the
 * Google account `D5Ql2…` (see project_kass_account_merge), but older orders kept uid=<old>. This
 * aligns `uid` with `buyerUid` so every uid-keyed surface (admin, analytics, settlement) attributes
 * them to the surviving account.
 *
 * SAFE BY DEFAULT: dry-run. Pass --apply to write. Only touches docs where uid===OLD and
 * buyerUid===NEW (never guesses).
 *
 * Usage:
 *   node scripts/qa/backfill-order-uid.js            # dry-run
 *   node scripts/qa/backfill-order-uid.js --apply    # execute
 */
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const OLD = 'xrH21J5GFbW8PluCZ2ny5nIuf602';   // deprecated phone account
const NEW = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';   // surviving Google account
const APPLY = process.argv.includes('--apply');

(async () => {
  const snap = await db.collection('orders').where('uid', '==', OLD).get();
  const targets = [];
  snap.forEach(d => {
    const o = d.data() || {};
    // Only migrate when buyerUid already points at the survivor — the safe, unambiguous case.
    if (o.buyerUid === NEW) targets.push({ id: d.id, phone: o.buyerPhone || o.customerPhone || '—', total: o.total ?? o.amount ?? '—' });
  });

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY-RUN'} — orders with uid==${OLD.slice(0,8)}… AND buyerUid==${NEW.slice(0,8)}…`);
  console.log(`Matched ${targets.length} order(s):`);
  console.table(targets);

  const skipped = snap.size - targets.length;
  if (skipped > 0) console.log(`(${skipped} order(s) had uid==OLD but a different/absent buyerUid — NOT touched.)`);

  if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to write uid → ' + NEW.slice(0,8) + '…'); process.exit(0); }

  let n = 0;
  for (const t of targets) {
    await db.collection('orders').doc(t.id).set({ uid: NEW, _uidBackfilledFrom: OLD, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    n++;
  }
  console.log(`\n✓ Backfilled uid on ${n} order(s).`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
