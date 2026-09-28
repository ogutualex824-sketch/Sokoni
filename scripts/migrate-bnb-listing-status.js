/* migrate-bnb-listing-status.js — give LEGACY accommodation listings an explicit lifecycle status (CHANGELOG 242).
 *
 * Before the approval gate, bnbListings/* carried NO `status`: a host's browser write made a listing public at once.
 * After it, the public reads status 'active' only, and the hub queries status == 'active' — Firestore cannot query a
 * MISSING field, so a legacy listing with no status is simply not shown publicly until it is given one.
 *
 * This script is the controlled way to give it one. It NEVER publishes: every legacy listing is set 'pending', so it
 * enters AdminOS › Entertainment › (kind bnb) review like any new listing, and only an administrator's audited
 * decision (entAdminSetListingStatus) makes it public. Listings that already carry a status are never touched.
 *
 * Evidence, stated as such: scripts/sokoni-db.js records bnbListings as EMPTY in production as of 2026-08-01. That
 * measurement is stale; this script's DRY RUN is the way to re-measure before anyone decides.
 *
 *   node scripts/migrate-bnb-listing-status.js                          DRY RUN — prints the plan, writes nothing
 *   node scripts/migrate-bnb-listing-status.js --apply --operator=<uid> writes (a deliberate, owner-approved step)
 *
 * NOT run by this change.
 */
'use strict';

const SCRIPT_VERSION = 'migrate-bnb-listing-status@1.0.0 (CHANGELOG 242)';
const PAGE = 300;

/** Every listing with NO status (the legacy shape). Pure over any Firestore-like db. */
async function plan(db) {
  const legacy = []; let scanned = 0; let last = null;
  for (;;) {
    let q = db.collection('bnbListings').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      scanned++;
      const x = d.data() || {};
      if (!Object.prototype.hasOwnProperty.call(x, 'status')) legacy.push({ id: d.id, name: x.name || x.title || null, hostUid: x.hostUid || null });
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE) break;
  }
  return { scanned, legacy };
}

/** Set each legacy listing 'pending' (never 'active') and record the migration. Re-running is a no-op. */
async function apply(db, operator, FieldValue) {
  if (!operator || !/^[A-Za-z0-9_-]{6,128}$/.test(String(operator))) throw new Error('--operator=<admin uid> is required to apply.');
  const p = await plan(db);
  let changed = 0;
  for (const l of p.legacy) {
    const ref = db.collection('bnbListings').doc(l.id);
    await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || Object.prototype.hasOwnProperty.call(s.data() || {}, 'status')) return;   /* already has one */
      t.update(ref, { status: 'pending', updatedAt: FieldValue.serverTimestamp() });
      t.set(db.collection('adminAudit').doc(), { action: 'bnb_listing_legacy_status', performedBy: String(operator), module: 'migrate-bnb-listing-status',
        target: { collection: 'bnbListings', id: l.id }, before: { status: null }, after: { status: 'pending' }, script: SCRIPT_VERSION, createdAt: FieldValue.serverTimestamp() });
      changed++;
    });
  }
  return { scanned: p.scanned, legacy: p.legacy.length, changed };
}

module.exports = { plan, apply, SCRIPT_VERSION };

if (require.main === module) {
  (async () => {
    const admin = require(require.resolve('firebase-admin', { paths: [require('path').join(__dirname, '..', 'functions')] }));
    if (!admin.apps.length) admin.initializeApp();
    const db = admin.firestore();
    const args = process.argv.slice(2);
    const doApply = args.includes('--apply');
    const operator = (args.find((a) => a.startsWith('--operator=')) || '').slice(11);
    if (!doApply) {
      const p = await plan(db);
      console.log(`[${SCRIPT_VERSION}] DRY RUN — scanned ${p.scanned} listing(s); ${p.legacy.length} have no status and would be set 'pending' (never 'active'):`);
      p.legacy.slice(0, 200).forEach((l) => console.log(`  ${l.id}  ${l.name || '(no name)'}  host=${l.hostUid || '—'}`));
      console.log('Nothing written. To apply (owner-approved): --apply --operator=<admin uid>');
      return;
    }
    const r = await apply(db, operator, admin.firestore.FieldValue);
    console.log(`[${SCRIPT_VERSION}] APPLIED by ${operator}: scanned ${r.scanned}, legacy ${r.legacy}, set pending ${r.changed}.`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
