#!/usr/bin/env node
/* ============================================================================
   CAPABILITY MIGRATION — one provider-only identity gains its business identity and a SERVICES stamp   (C4)
   scripts/migrate-capability-identity.js

   The deterministic case the C3 census established for DG Wine (and later Latomi):
       provider LIVE (status active + approvedAt) · seller ABSENT · businesses/shops/merchants ABSENT
       · one APPROVED provider application · 0 products anywhere · capability SERVICES, NOT_YET_STAMPED
   becomes
       businesses/{uid} created — the ONE business identity, same owner uid, id scheme of projectSeller —
       carrying capabilities.SERVICES = approved with the ORIGINAL approval as its evidence
       (decidedBy / decidedAt / applicationId of the approved application, source application_approval)
       + one adminAudit record.

   NOTHING ELSE. The provider record is not touched. The application is not touched. No shop is created
   (a shops doc would route the account to Merchant V2 as a shop owner — the wrong dashboard for SERVICES).
   No branch is created (no shared products+services branch model exists yet; inventing one is forbidden).
   PRODUCTS is never stamped: zero products is a fact this migration respects.

   HOW IT REFUSES
     --plan   reads production, re-derives the C3 shape, prints the exact mutation manifest. Writes nothing.
     --apply  requires --expect-digest <sha256 of the plan>; inside ONE transaction it re-reads every
              record the plan depends on and ABORTS if anything differs from the plan: a seller appeared,
              a business appeared, the provider changed, the application is no longer approved, a product
              exists. Idempotent: an existing businesses/{uid} whose stamp equals the plan is a no-op.
   Pure pieces (plan, verify) are exported for the fake-store suite.
   ========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const CAPS = require(path.join(ROOT, 'functions', 'shared', 'business-capabilities.js'));

const SLICE = 'C4';
const SOURCE = 'capability_migration_' + SLICE.toLowerCase();
const clean = (s, n) => (s === undefined || s === null ? null : String(s).replace(/[<>]/g, '').trim().slice(0, n) || null);

/** Load everything the plan depends on. `db` is a Firestore (real or fake). */
async function snapshot(db, uid, applicationId) {
  const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? (s.data() || {}) : null; };
  const count = async (col, field) => (await db.collection(col).where(field, '==', uid).limit(5).get()).size;
  const ownedBiz = await db.collection('businesses').where('ownerId', '==', uid).limit(5).get();
  const ownedShops = await db.collection('shops').where('ownerId', '==', uid).limit(5).get();
  return {
    uid, applicationId,
    provider: await get('providers/' + uid), seller: await get('sellers/' + uid),
    businessById: await get('businesses/' + uid), shopById: await get('shops/' + uid),
    businessesByOwner: ownedBiz.docs.map((d) => d.id), shopsByOwner: ownedShops.docs.map((d) => d.id),
    application: await get('applications/' + applicationId),
    productCount: (await count('products', 'sellerUid')) + (await count('products', 'ownerId'))
      + (await count('posProducts', 'sellerUid')) + (await count('inventory_products', 'sellerUid')),
  };
}

/** Pure. The plan, or a refusal with every reason. */
function plan(s) {
  const refusals = [];
  const rm = CAPS.readModel({ seller: s.seller, provider: s.provider, business: s.businessById, applications: s.application ? [s.application] : [], productCount: s.productCount });
  if (!s.provider) refusals.push('provider_absent');
  if (rm.observed.provider !== 'live') refusals.push('provider_not_live:' + rm.observed.provider);
  if (s.seller) refusals.push('seller_present');
  if (s.shopById || s.shopsByOwner.length) refusals.push('shop_present');
  if (s.businessesByOwner.some((id) => id !== s.uid)) refusals.push('other_business_owned:' + s.businessesByOwner.filter((id) => id !== s.uid).join(','));
  if (!s.application) refusals.push('application_absent');
  else {
    if (String(s.application.statusCanonical || s.application.status) !== 'approved') refusals.push('application_not_approved');
    if (String(s.application.uid || '') !== s.uid) refusals.push('application_uid_mismatch');
    if (!s.application.decidedBy) refusals.push('application_without_decider');
    if (CAPS.ROLE_TO_CAPABILITY[String(s.application.role || '').toLowerCase()] !== 'SERVICES') refusals.push('application_role_not_services:' + s.application.role);
  }
  if (s.productCount !== 0) refusals.push('products_present:' + s.productCount);
  if (s.provider && s.provider.sourceApplicationId && s.provider.sourceApplicationId !== s.applicationId) refusals.push('provider_source_application_mismatch');

  const stamp = s.application ? {
    version: CAPS.STAMP_VERSION,
    SERVICES: { state: 'approved', decidedBy: String(s.application.decidedBy || ''), decidedAt: s.application.decidedAt || null, applicationId: s.applicationId, source: 'application_approval' },
  } : null;
  const v = stamp ? CAPS.validateStamp(stamp) : { ok: false, errors: ['no_application'] };
  if (!v.ok) refusals.push('stamp_invalid:' + v.errors.join('|'));

  /* idempotency: an existing business is acceptable ONLY if it is exactly this migration's result */
  let existing = null;
  if (s.businessById) {
    const same = JSON.stringify(s.businessById.capabilities || null) === JSON.stringify(stamp) && s.businessById.ownerId === s.uid && s.businessById.source === SOURCE;
    if (same) existing = 'already_migrated';
    else refusals.push('business_exists_and_differs');
  }
  if (rm.classification !== 'SERVICES' && existing !== 'already_migrated') refusals.push('read_model_not_services:' + rm.classification + ':' + rm.conflicts.map((c) => c.code).join('|'));

  const p = s.provider || {}, a = s.application || {};
  const name = clean(p.name || a.name, 160) || null;
  if (!name) refusals.push('no_name');
  const business = refusals.length ? null : {
    uid: s.uid, ownerId: s.uid, name, businessName: name, nameLower: name.toLowerCase(),
    status: 'active', source: SOURCE, applicationId: s.applicationId,
    searchable: false, isPublic: false,            /* discovery stays the discovery gate's decision, never a migration's */
    ...(a.category ? { category: clean(a.category, 80) } : {}),
    ...(a.description || p.description ? { description: clean(a.description || p.description, 1000) } : {}),
    ...(a.phoneNumber || a.phone || p.phoneNumber || p.phone ? { phone: a.phoneNumber || a.phone || p.phoneNumber || p.phone } : {}),
    ...(a.email || p.email ? { email: a.email || p.email } : {}),
    ...(a.location || a.city || p.location || p.city ? { city: clean(a.location || a.city || p.location || p.city, 160) } : {}),
    capabilities: stamp,
    migration: { slice: SLICE, from: 'providers/' + s.uid, providerApprovedAt: p.approvedAt || null, sourceApplicationId: s.applicationId },
  };
  const manifest = business ? [
    { op: 'create', path: 'businesses/' + s.uid, data: business },
    { op: 'create', path: 'adminAudit/(auto)', data: { action: 'capability_migration_' + SLICE.toLowerCase(), targetUid: s.uid, businessId: s.uid, applicationId: s.applicationId, capability: 'SERVICES', performedBy: 'admin-sdk:capability-migration', reason: 'C3 census: provider-only identity; SERVICES approved by ' + (a.decidedBy || '?') } },
  ] : [];
  const untouched = ['providers/' + s.uid, 'applications/' + s.applicationId, 'users/' + s.uid, 'wallets/' + s.uid, 'providerProfiles/' + s.uid, 'sellers/' + s.uid + ' (stays absent)', 'shops/* (none created)', 'branches/* (none created)', 'products/* (none created)'];
  const digest = crypto.createHash('sha256').update(JSON.stringify({ uid: s.uid, applicationId: s.applicationId, manifest, refusals, existing })).digest('hex');
  return { ok: refusals.length === 0 || existing === 'already_migrated', noop: existing === 'already_migrated', refusals, manifest, untouched, stamp, readModel: { classification: rm.classification, authorityStatus: rm.authorityStatus, conflicts: rm.conflicts.map((c) => c.code) }, digest };
}

/** The only writes. ONE transaction: re-verify everything, then create. Returns what happened. */
async function apply(db, s0, expectDigest, FieldValue) {
  const p0 = plan(s0);
  if (!p0.ok) return { applied: false, reason: 'plan_refused', refusals: p0.refusals };
  if (expectDigest && p0.digest !== expectDigest) return { applied: false, reason: 'digest_mismatch', expected: expectDigest, actual: p0.digest };
  if (p0.noop) return { applied: false, reason: 'already_migrated', digest: p0.digest };
  const bizRef = db.collection('businesses').doc(s0.uid);
  const auditRef = db.collection('adminAudit').doc();
  const result = await db.runTransaction(async (t) => {
    /* every dependency re-read INSIDE the transaction; any difference aborts before a write */
    const [prov, seller, biz, shop, app] = await Promise.all([t.get(db.doc('providers/' + s0.uid)), t.get(db.doc('sellers/' + s0.uid)), t.get(bizRef), t.get(db.doc('shops/' + s0.uid)), t.get(db.doc('applications/' + s0.applicationId))]);
    const s1 = Object.assign({}, s0, { provider: prov.exists ? prov.data() : null, seller: seller.exists ? seller.data() : null, businessById: biz.exists ? biz.data() : null, shopById: shop.exists ? shop.data() : null, application: app.exists ? app.data() : null });
    const p1 = plan(s1);
    if (!p1.ok || p1.noop || p1.digest !== p0.digest) throw Object.assign(new Error('drift'), { drift: true, refusals: p1.refusals, digest: p1.digest });
    const ts = FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString();
    t.set(bizRef, Object.assign({}, p1.manifest[0].data, { createdAt: ts, updatedAt: ts }));
    t.set(auditRef, Object.assign({}, p1.manifest[1].data, { createdAt: ts }));
    return { applied: true, businessId: s0.uid, auditId: auditRef.id, digest: p1.digest };
  }).catch((e) => (e && e.drift ? { applied: false, reason: 'drift_abort', refusals: e.refusals, digest: e.digest } : Promise.reject(e)));
  return result;
}

module.exports = { SLICE, SOURCE, snapshot, plan, apply };

/* ── CLI ─────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
  const uid = arg('--uid'), applicationId = arg('--application');
  const mode = args.includes('--apply') ? 'apply' : 'plan';
  if (!uid || !applicationId) { console.error('usage: --uid <uid> --application <applicationId> [--plan | --apply --expect-digest <sha256>]'); process.exit(2); }
  const _r = require('module').createRequire(path.join(ROOT, 'functions', 'package.json'));
  const admin = _r('firebase-admin'); const { getFirestore, FieldValue } = _r('firebase-admin/firestore');
  const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'sokoni-aeb26' });
  const db = getFirestore(app);
  (async () => {
    const s = await snapshot(db, uid, applicationId);
    const p = plan(s);
    console.log(JSON.stringify({ mode, uid, applicationId, plan: p }, null, 2));
    if (mode === 'plan') { process.exit(p.ok ? 0 : 1); }
    const expect = arg('--expect-digest');
    if (!expect) { console.error('REFUSED: --apply requires --expect-digest <sha256 of the reviewed plan>'); process.exit(2); }
    const r = await apply(db, s, expect, FieldValue);
    console.log(JSON.stringify({ result: r }, null, 2));
    process.exit(r.applied ? 0 : 1);
  })().catch((e) => { console.error('FAILED — ' + (e.stack || e)); process.exit(2); });
}
