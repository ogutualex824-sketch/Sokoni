/* migrate-ent-availability.js — ONE-TIME backfill: put every LIVE, FUTURE booking made before the
 * availability authority existed into it, so a new booking can never overlap an old one through the
 * authority alone (the engines keep their legacy slot-lock / prefetch guards meanwhile).
 *
 * DRY-RUN by default: prints what it would claim and changes nothing.
 *   node scripts/migrate-ent-availability.js                 dry run (needs credentials)
 *   node scripts/migrate-ent-availability.js --apply         writes (a DELIBERATE deploy step)
 *
 * NOT run by this change. Before --apply: re-read the CLAUDE.md Artifact Registry notice, run the dry
 * run, and have the owner approve the printed counts.
 *
 * Each booking is claimed through the authority's own claim() in a transaction: a booking whose time
 * already conflicts (two legacy bookings that overlap) is REPORTED, never forced in.
 */
'use strict';

async function backfill(db, AV, opts) {
  const o = Object.assign({ apply: false, nowMs: Date.now(), log: () => {} }, opts || {});
  const out = { scanned: 0, claimed: 0, alreadyTracked: 0, past: 0, conflicts: [], errors: [] };
  const sources = [
    { col: 'providerBookings', statuses: ['pending', 'confirmed', 'in_progress'], key: (b) => ({ providerId: b.providerId }), item: (id) => 'pb_' + id,
      paid: (b) => ['paid_held', 'settled'].includes(b.paymentStatus) || !(Number(b.price) + Number(b.fee || 0) > 0) },
    { col: 'bookings', statuses: ['pending', 'confirmed', 'active'], key: (b) => (b.venueId ? { venueId: b.venueId } : null), item: (id) => 'vb_' + id,
      paid: (b) => b.paymentStatus === 'paid' || !b.requiresPayment },
  ];
  for (const s of sources) {
    const snap = await db.collection(s.col).where('status', 'in', s.statuses).limit(5000).get();
    for (const doc of snap.docs) {
      const b = doc.data(); out.scanned++;
      const k = s.key(b);
      if (!k || !Number(b.startTs) || !Number(b.endTs)) continue;
      if (b.availability && b.availability.calKey) { out.alreadyTracked++; continue; }
      if (Number(b.endTs) <= o.nowMs) { out.past++; continue; }
      try {
        const plan = await AV.planReservation(Object.assign({}, k, { service: null, startMs: Number(b.startTs), endMs: Number(b.endTs),
          itemId: s.item(doc.id), ref: `${s.col}/${doc.id}`, skipBookable: true }));
        if (!o.apply) { out.claimed++; o.log(`[dry-run] would claim ${s.col}/${doc.id} on ${plan.calKey} ${new Date(Number(b.startTs)).toISOString()}`); continue; }
        let res = null;
        await db.runTransaction(async (txn) => {
          const cur = await txn.get(doc.ref);
          const st = await AV.readPlan(txn, plan);
          if (!cur.exists || (cur.data().availability && cur.data().availability.calKey)) { res = { skipped: true }; return; }
          /* evaluate as a HOLD/BOOKING that ignores the notice window (it was booked long ago) */
          res = AV.claim(txn, Object.assign({}, plan, { cfg: Object.assign({}, plan.cfg, { minNoticeMins: 0, horizonDays: 730 }) }), st, { kind: s.paid(b) ? 'B' : 'H' });
          if (res.ok) txn.update(doc.ref, { availability: res.record });
        });
        if (res && res.ok) out.claimed++;
        else if (res && !res.skipped) out.conflicts.push({ ref: `${s.col}/${doc.id}`, code: res.code });
      } catch (e) { out.errors.push({ ref: `${s.col}/${doc.id}`, error: e.message }); }
    }
  }
  return out;
}
module.exports = { backfill };

if (require.main === module) {
  (async () => {
    const admin = require(require.resolve('firebase-admin', { paths: [require('path').join(__dirname, '..', 'functions')] }));
    if (!admin.apps.length) admin.initializeApp();
    const AV = require('../functions/ent-availability');
    const apply = process.argv.includes('--apply');
    const r = await backfill(admin.firestore(), AV, { apply, log: (l) => console.log(l) });
    console.log(JSON.stringify(Object.assign({ mode: apply ? 'APPLY' : 'DRY-RUN' }, r), null, 2));
    process.exit(r.errors.length ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(2); });
}
