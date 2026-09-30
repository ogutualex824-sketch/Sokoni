#!/usr/bin/env node
/* ============================================================================
   R3 — AdminOS classification manifest for approved providers that carry no C1 category stamp
   scripts/r3-classification-manifest.js

   WHAT IT DOES (--plan, default): READ ONLY. For every providers/{uid} that is live by approval evidence and has no
   `business` stamp, it re-derives what C1 would have stamped AT APPROVAL — from the APPROVED APPLICATION only, through
   the real classifier (business-category.categoryFromApplication) and the real lane classifier
   (provider-hub.classifyDecidedApplication) — and proposes the stamp projectProvider writes, field for field:
       providers/{uid}.business = { category, lane, source: 'application', applicationId, setAt }
   It never reads providers.category / categoryLabel as evidence (they are self-editable text). It classifies only
   where the evidence is unambiguous: one approved application, uid matching, the provider's sourceApplicationId
   agreeing, a C1 category found. Everything else stays UNRESOLVED with the reason, for AdminOS.

   It also computes, for each identity, the post-R2 route the stamp would produce (category lane × stamped/observed
   capability) — so a disagreement (DG Wine / Latomi: wholesale × SERVICES → CONFLICT) is visible BEFORE anyone writes.

   TWO SEPARATE MANIFESTS, TWO DIGESTS: the primary set (eligible, no known disagreement) and the DISAGREEMENT set
   (eligible by evidence but the stamp would make the identity CONFLICT). The owner accepts or rejects each digest.

   --apply <digest> (not authorized as of this file's first commit): re-reads every record inside one transaction,
   recomputes the manifest, aborts on any difference, writes ONLY providers/{uid}.business for the set whose digest
   was named, plus one adminAudit record per identity. Idempotent: an already-stamped provider is skipped.
   ========================================================================== */
'use strict';
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const BCAT = require(path.join(ROOT, 'functions', 'business-category.js'));
const PH = require(path.join(ROOT, 'functions', 'provider-hub.js'));
const CAPS = require(path.join(ROOT, 'functions', 'shared', 'business-capabilities.js'));
const BW = require(path.join(ROOT, 'functions', 'business-workspace.js'));
const scope = require(path.join(ROOT, 'functions', 'shared', 'business-scope.js'));

const APPROVED = (a) => String((a && (a.statusCanonical || a.status)) || '') === 'approved';
const norm = (v) => (v === undefined || v === null) ? null : JSON.parse(JSON.stringify(v, (k, x) => (x && x._seconds !== undefined ? new Date(x._seconds * 1000).toISOString() : (x && x.toDate ? x.toDate().toISOString() : x))));

/** Pure: classify one identity from its records. */
function classify(s) {
  const reasons = [];
  const prov = s.provider || {};
  const live = scope.resolveBusinessScope({ provider: prov, seller: s.seller || null }).providesServices;
  if (!s.provider) reasons.push('provider_absent');
  if (s.provider && !live) reasons.push('provider_not_live_by_evidence');
  if (prov.business) reasons.push('already_stamped:' + (prov.business.category || 'null') + '/' + (prov.business.source || '?'));
  if (prov.healthcare) reasons.push('healthcare_authority_owns_it');
  const approved = (s.applications || []).filter(APPROVED);
  if (approved.length === 0) reasons.push('no_approved_application');
  if (approved.length > 1) reasons.push('multiple_approved_applications:' + approved.map((a) => a.__id).join(','));
  const app = approved.length === 1 ? approved[0] : null;
  if (app && String(app.uid || '') !== s.uid) reasons.push('application_uid_mismatch');
  if (app && prov.sourceApplicationId && prov.sourceApplicationId !== app.__id) reasons.push('provider_source_application_mismatch');
  if (app && !app.decidedBy) reasons.push('application_without_decider');
  const role = app ? String(app.role || '').toLowerCase() : null;
  const c1 = app ? BCAT.categoryFromApplication(app, role) : { category: null, reason: 'no_application' };
  if (app && !c1.category) reasons.push('c1_cannot_classify:' + (c1.reason || '?'));
  if (c1.category && BCAT.ADMIN_REVIEW_ONLY && BCAT.ADMIN_REVIEW_ONLY.includes && BCAT.ADMIN_REVIEW_ONLY.includes(c1.category)) reasons.push('admin_review_only_category');
  const lane = app ? PH.classifyDecidedApplication(Object.assign({}, app, { role })) : null;

  /* capability, as the read model sees it today */
  const rm = CAPS.readModel({ seller: s.seller || null, provider: s.provider || null, business: s.business || null, applications: s.applications || [], productCount: s.productCount });
  const cLane = BW.laneOf(c1.category);
  let expectedRoute = null, expectedState = null;
  if (!c1.category) { expectedState = 'PENDING_CLASSIFICATION (unchanged)'; }
  else if (rm.classification === 'CONFLICT') { expectedState = 'CAPABILITY_CONFLICT (read model)'; }
  else if (rm.classification === 'UNCLASSIFIED') { expectedState = 'no route (UNCLASSIFIED capability)'; }
  else if (rm.classification === 'PRODUCTS_AND_SERVICES') { expectedRoute = 'merchant-v2.html'; expectedState = 'AVAILABLE + Services workspace'; }
  else if ((cLane === 'products' && rm.classification === 'SERVICES') || (cLane === 'services' && rm.classification === 'PRODUCTS')) { expectedState = 'CAPABILITY_CONFLICT (CATEGORY_CAPABILITY_DISAGREEMENT ' + cLane + '/' + rm.classification + ')'; }
  else { expectedRoute = Object.prototype.hasOwnProperty.call(BW.ROUTE_OF, c1.category) ? BW.ROUTE_OF[c1.category] : null; expectedState = expectedRoute ? 'AVAILABLE' : 'NOT_IMPLEMENTED (unrouted category)'; }
  const disagreement = /DISAGREEMENT/.test(expectedState);

  const eligible = reasons.length === 0;
  const mutation = eligible ? { op: 'update', path: 'providers/' + s.uid, set: { business: { category: c1.category, lane, source: 'application', applicationId: app.__id, setAt: '<serverTimestamp>' } },
    audit: { action: 'category_backfill_r3', targetUid: s.uid, applicationId: app.__id, category: c1.category, evidence: 'approved application ' + app.__id + ' decided by ' + app.decidedBy + ' at ' + (norm(app.decidedAt) || '?') + '; C1 ' + c1.reason, performedBy: 'admin-sdk:r3-classification' } } : null;
  return { uid: s.uid, name: prov.name || null, eligible, disagreement, reasons,
    current: { providerStatus: prov.status || null, approvedAt: norm(prov.approvedAt) || null, providerCategoryText: prov.category || null, categoryLabelText: prov.categoryLabel || null, stamped: !!prov.business, capability: rm.classification, authorityStatus: rm.authorityStatus, conflicts: rm.conflicts.map((c) => c.code) },
    evidence: app ? { applicationId: app.__id, role, applicationCategory: app.category || null, applicationCategoryLabel: app.categoryLabel || null, hub: app.hub || null, type: app.type || null, professionalType: app.professionalType || null, requestedRole: app.requestedRole || null, roleResolvedBy: app.roleResolvedBy || null, decidedBy: app.decidedBy || null, decidedAt: norm(app.decidedAt) || null, c1: c1, lane } : null,
    expected: { lane: cLane, route: expectedRoute, state: expectedState }, mutation };
}

function digestOf(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => ({ uid: r.uid, mutation: r.mutation, expected: r.expected })))).digest('hex'); }

async function snapshotAll(db) {
  const provs = await db.collection('providers').get();
  const out = [];
  for (const d of provs.docs) {
    const uid = d.id; const prov = Object.assign({ __id: uid }, d.data());
    const [seller, biz, apps, prodA, prodB] = await Promise.all([
      db.doc('sellers/' + uid).get(), db.doc('businesses/' + uid).get(),
      db.collection('applications').where('uid', '==', uid).limit(10).get(),
      db.collection('products').where('sellerUid', '==', uid).limit(5).get(), db.collection('products').where('ownerId', '==', uid).limit(5).get()]);
    out.push({ uid, provider: prov, seller: seller.exists ? seller.data() : null, business: biz.exists ? biz.data() : null,
      applications: apps.docs.map((a) => Object.assign({ __id: a.id }, a.data())), productCount: prodA.size + prodB.size });
  }
  return out;
}

function buildManifests(snapshots) {
  const rows = snapshots.map(classify);
  const primary = rows.filter((r) => r.eligible && !r.disagreement);
  const disagree = rows.filter((r) => r.eligible && r.disagreement);
  const unresolved = rows.filter((r) => !r.eligible);
  return { rows, primary, disagree, unresolved, digests: { primary: digestOf(primary), disagreement: digestOf(disagree) } };
}

/** Snapshot ONE identity (the records a row depends on). */
async function snapshotOne(db, uid) {
  const [p, seller, biz, apps, prodA, prodB] = await Promise.all([db.doc('providers/' + uid).get(), db.doc('sellers/' + uid).get(), db.doc('businesses/' + uid).get(),
    db.collection('applications').where('uid', '==', uid).limit(10).get(), db.collection('products').where('sellerUid', '==', uid).limit(5).get(), db.collection('products').where('ownerId', '==', uid).limit(5).get()]);
  return { uid, provider: p.exists ? Object.assign({ __id: uid }, p.data()) : null, seller: seller.exists ? seller.data() : null, business: biz.exists ? biz.data() : null,
    applications: apps.docs.map((a) => Object.assign({ __id: a.id }, a.data())), productCount: prodA.size + prodB.size };
}

/**
 * apply(db, expectDigest, FieldValue): the ONLY writes. Recomputes the PRIMARY set from a fresh snapshot of every
 * provider; refuses unless its digest equals the authorized one; then, one transaction PER identity: re-read the
 * provider and its applications, recompute the row, abort that identity if the mutation differs or it is no longer
 * eligible; write providers/{uid}.business (the stamp) and one adminAudit. An already-stamped identity is skipped
 * (idempotent). Never touches capabilities, businesses, shops, sellers, products, or the disagreement set.
 */
async function apply(db, expectDigest, FieldValue) {
  const snaps = await snapshotAll(db);
  const m = buildManifests(snaps);
  if (!expectDigest) return { applied: [], refused: 'no_digest' };
  if (m.digests.primary !== expectDigest) {
    /* an already-applied set recomputes to an EMPTY primary set (every row now already_stamped): report that as done */
    const stampedNow = snaps.filter((s) => s.provider && s.provider.business && s.provider.business.source === 'application').length;
    return { applied: [], refused: 'digest_mismatch', expected: expectDigest, actual: m.digests.primary, primaryCount: m.primary.length, alreadyStampedProviders: stampedNow };
  }
  const results = [];
  for (const row of m.primary) {
    const provRef = db.doc('providers/' + row.uid);
    const auditRef = db.collection('adminAudit').doc();
    const r = await db.runTransaction(async (t) => {
      const p = await t.get(provRef);
      const appSnap = await t.get(db.doc('applications/' + row.evidence.applicationId));
      const s1 = { uid: row.uid, provider: p.exists ? Object.assign({ __id: row.uid }, p.data()) : null, seller: null, business: null,
        applications: appSnap.exists ? [Object.assign({ __id: appSnap.id }, appSnap.data())] : [], productCount: row.current.productCount || 0 };
      const row1 = classify(s1);
      if (row1.reasons.some((x) => x.startsWith('already_stamped'))) return { uid: row.uid, applied: false, reason: 'already_stamped' };
      const same = row1.eligible && !row1.disagreement && JSON.stringify(row1.mutation.set.business) === JSON.stringify(row.mutation.set.business);
      if (!same) return { uid: row.uid, applied: false, reason: 'drift_abort', reasons: row1.reasons, now: row1.mutation && row1.mutation.set.business };
      const ts = FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString();
      const business = Object.assign({}, row.mutation.set.business, { setAt: ts });
      t.update(provRef, { business, updatedAt: ts });
      t.set(auditRef, Object.assign({}, row.mutation.audit, { createdAt: ts }));
      return { uid: row.uid, applied: true, category: business.category, auditId: auditRef.id };
    });
    results.push(r);
  }
  return { applied: results.filter((r) => r.applied), skipped: results.filter((r) => !r.applied), digest: expectDigest };
}

module.exports = { classify, buildManifests, digestOf, snapshotAll, snapshotOne, apply };

if (require.main === module) {
  const args = process.argv.slice(2);
  const _r = require('module').createRequire(path.join(ROOT, 'functions', 'package.json'));
  const admin = _r('firebase-admin'); const { getFirestore, FieldValue } = _r('firebase-admin/firestore');
  const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'sokoni-aeb26' });
  const db = getFirestore(app);
  (async () => {
    if (args.includes('--apply')) {
      const expect = args[args.indexOf('--apply') + 1];
      if (!expect || !/^[a-f0-9]{64}$/.test(expect)) { console.error('REFUSED: --apply <sha256 of the authorized PRIMARY digest>'); process.exit(2); }
      const r = await apply(db, expect, FieldValue);
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.refused ? 1 : 0);
    }
    const snaps = await snapshotAll(db);
    const m = buildManifests(snaps);
    const red = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/email|phone/i.test(k) && typeof v === 'string' ? v.replace(/(.{2}).+(.{2})/, '$1***$2') : v)));
    const out = { at: new Date().toISOString(), readOnly: true, providers: snaps.length, primary: m.primary.map(red), disagreement: m.disagree.map(red), unresolved: m.unresolved.map(red), digests: m.digests };
    const outPath = args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(require('os').tmpdir(), 'r3-manifest.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log('R3 PLAN @ ' + out.at + ' providers ' + snaps.length + ' · primary ' + m.primary.length + ' · disagreement ' + m.disagree.length + ' · unresolved ' + m.unresolved.length);
    for (const r of m.rows) console.log((r.eligible ? (r.disagreement ? 'DISAGREE ' : 'PRIMARY  ') : 'UNRESOLV ') + r.uid + '  ' + String(r.name || '').padEnd(26).slice(0, 26) + '  cap=' + r.current.capability + '/' + r.current.authorityStatus + '  textCat=' + (r.current.providerCategoryText || '—') + '  app=' + (r.evidence ? r.evidence.applicationId + ':' + r.evidence.applicationCategory + ':' + r.evidence.role + ':' + r.evidence.roleResolvedBy : '—') + '  C1=' + (r.evidence ? r.evidence.c1.category + '(' + r.evidence.c1.reason + ')' : '—') + '  lane=' + (r.evidence && r.evidence.lane ? r.evidence.lane.hub + '/' + r.evidence.lane.entClass : '—') + '  → ' + (r.expected.route || 'no route') + ' [' + r.expected.state + ']' + (r.reasons.length ? '  reasons=' + r.reasons.join('|') : ''));
    console.log('digests: primary ' + m.digests.primary + ' · disagreement ' + m.digests.disagreement);
    console.log('json → ' + outPath);
    process.exit(0);
  })().catch((e) => { console.error('PLAN FAILED — ' + (e.stack || e)); process.exit(2); });
}
