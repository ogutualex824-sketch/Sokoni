/* migrate-legal-quarantine.js — REMOVE untrustworthy legacy advocate identities from the Legal registry
 * (CHANGELOG 220 · docs/LEGAL_VERIFICATION.md).
 *
 * T.M.M & Partners Advocates (legalProviders/ZrG4N8SETmS7NMEg0src1NYjBw23) was written `status:'active'`
 * by scripts/onboard-batch2.js with a BLANK LSK number and `verified:false` — no SOKONI decision and no
 * LSK evidence. Owner decision 2026-09-27: remove it from the Legal provider registry completely, keep
 * an internal audit/migration record, and never fabricate a verification for it.
 *
 * For each TARGET the apply step, in ONE transaction:
 *   - writes legalProviderQuarantine/{uid}   the legacy documents verbatim + action + reason + time +
 *                                            script version + operator (admin-read only)
 *   - deletes legalProviders/{uid} and lawyers/{uid} (the public directory card)
 *   - clears users/{uid}.hasLegalProfile
 *   - appends legalVerificationEvents        kind 'quarantine' (the verification audit history)
 * A quarantined uid is refused by registerLegalProvider and by any later AdminOS decision until it is
 * released deliberately. Re-running is a no-op.
 *
 * The DRY RUN also REPORTS (never modifies) every other legal record that carries no verification — so
 * the owner sees the whole legacy estate before deciding anything else.
 *
 *   node scripts/migrate-legal-quarantine.js                         DRY RUN — prints the plan, writes nothing
 *   node scripts/migrate-legal-quarantine.js --apply --operator=<uid> writes (a deliberate, owner-approved step)
 *
 * NOT run by this change. Even before it runs, the server predicate (functions/legal-verification.js)
 * already refuses T.M.M everywhere: it has no admin decision and no LSK verification.
 */
'use strict';

/* firebase-admin lives in functions/ (the repo root has none) — the same resolution migrate-reputation uses. */
const _admin = () => require(require.resolve('firebase-admin', { paths: [require('path').join(__dirname, '..', 'functions')] }));

const SCRIPT_VERSION = 'migrate-legal-quarantine@1.0.0 (CHANGELOG 220)';
const TARGETS = [{
  uid: 'ZrG4N8SETmS7NMEg0src1NYjBw23',
  label: 'T.M.M & Partners Advocates',
  source: 'scripts/onboard-batch2.js',
  reason: 'Legacy script-written advocate record: status "active" with a blank LSK practising number and verified:false — no SOKONI administrative decision and no LSK evidence. Removed from the Legal provider registry by owner decision 2026-09-27; no verification was fabricated.',
}];

async function plan(db) {
  const out = { targets: [], unverifiedOthers: [], unprojectedCards: [] };
  for (const t of TARGETS) {
    const [lp, law, q] = await Promise.all([
      db.collection('legalProviders').doc(t.uid).get(),
      db.collection('lawyers').doc(t.uid).get(),
      db.collection('legalProviderQuarantine').doc(t.uid).get(),
    ]);
    out.targets.push({ uid: t.uid, label: t.label, legalProviders: lp.exists, lawyers: law.exists, alreadyQuarantined: q.exists,
      action: (lp.exists || law.exists) ? 'QUARANTINE + REMOVE' : (q.exists ? 'none (done)' : 'none (absent)') });
  }
  const ids = new Set(TARGETS.map((t) => t.uid));
  const lps = await db.collection('legalProviders').limit(5000).get();
  lps.docs.forEach((d) => {
    if (ids.has(d.id)) return;
    const v = d.data().verification;
    if (!v || !v.admin || !v.lsk) out.unverifiedOthers.push({ uid: d.id, name: d.data().name || '', status: d.data().status || null });
  });
  const cards = await db.collection('lawyers').limit(5000).get();
  cards.docs.forEach((d) => { if (!ids.has(d.id) && d.data().projectedBy !== 'legal-verification') out.unprojectedCards.push({ id: d.id, name: d.data().name || '' }); });
  return out;
}

async function apply(db, opts) {
  const o = Object.assign({ operator: null, now: Date.now() }, opts || {});
  if (!o.operator) throw new Error('--operator=<admin uid> is required to apply');
  const FieldValue = _admin().firestore.FieldValue;
  const results = [];
  for (const t of TARGETS) {
    await db.runTransaction(async (txn) => {
      const lpRef = db.collection('legalProviders').doc(t.uid);
      const lawRef = db.collection('lawyers').doc(t.uid);
      const qRef = db.collection('legalProviderQuarantine').doc(t.uid);
      const uRef = db.collection('users').doc(t.uid);
      const [lp, law, q, u] = await Promise.all([txn.get(lpRef), txn.get(lawRef), txn.get(qRef), txn.get(uRef)]);
      if (!lp.exists && !law.exists) { results.push({ uid: t.uid, action: q.exists ? 'noop_already_quarantined' : 'noop_absent' }); return; }
      const legacy = { legalProviders: lp.exists ? lp.data() : null, lawyers: law.exists ? law.data() : null,
        usersHasLegalProfile: u.exists ? (u.data().hasLegalProfile === true) : null };
      txn.set(qRef, Object.assign({}, q.exists ? q.data() : {}, {
        uid: t.uid, label: t.label, source: t.source, reason: t.reason, action: 'removed_from_legal_registry',
        legacy, removedAtMs: o.now, scriptVersion: SCRIPT_VERSION, operator: o.operator, lskVerificationFabricated: false,
      }));
      if (lp.exists) txn.delete(lpRef);
      if (law.exists) txn.delete(lawRef);
      if (u.exists && u.data().hasLegalProfile === true) txn.set(uRef, { hasLegalProfile: false }, { merge: true });
      txn.set(db.collection('legalVerificationEvents').doc('quarantine_' + t.uid + '_' + o.now), {
        uid: t.uid, kind: 'quarantine', actor: o.operator, action: 'quarantine_remove', target: 'legalProviders/' + t.uid,
        previous: lp.exists ? (lp.data().status || null) : null, next: 'quarantined', reason: t.reason,
        scriptVersion: SCRIPT_VERSION, atMs: o.now, createdAt: FieldValue.serverTimestamp(),
      });
      results.push({ uid: t.uid, action: 'quarantined', removed: { legalProviders: lp.exists, lawyers: law.exists } });
    });
  }
  return results;
}

module.exports = { plan, apply, TARGETS, SCRIPT_VERSION };

if (require.main === module) {
  (async () => {
    const admin = _admin();
    if (!admin.apps.length) admin.initializeApp();
    const db = admin.firestore();
    const doApply = process.argv.includes('--apply');
    const opArg = process.argv.find((a) => a.startsWith('--operator='));
    const p = await plan(db);
    console.log(JSON.stringify({ mode: doApply ? 'APPLY' : 'DRY-RUN', scriptVersion: SCRIPT_VERSION, plan: p }, null, 2));
    if (doApply) console.log(JSON.stringify({ applied: await apply(db, { operator: opArg ? opArg.split('=')[1] : null }) }, null, 2));
  })().catch((e) => { console.error(e && e.message); process.exit(1); });
}
