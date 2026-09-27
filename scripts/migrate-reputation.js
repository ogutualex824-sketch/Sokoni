/* migrate-reputation.js — ONE-TIME normalisation for the provider reputation authority.
 *
 *  1. FOLLOW IDENTITY. services.html used to follow a provider as `service--sv_<display-name slug>`.
 *     A slug is not an identity (two providers can share a name; a rename orphans the follow). Each
 *     such follow is mapped to the provider's ACCOUNT id when — and only when — exactly one active
 *     provider has that slug; it then becomes a server follow `{uid}--provider--{providerUid}`.
 *     AMBIGUOUS (2+ providers) and ORPHAN (0) slugs are REPORTED, never guessed. The legacy doc is kept
 *     and stamped `migratedTo` so the migration is re-runnable and auditable.
 *  1b. SHOP FOLLOWS (CHANGELOG 211). MiniShop had TWO follow stores. Carried to ONE — follows/{uid}--shop--{shopId}
 *     via the server — from: shopFollowers/{shopId}_{uid} (the retired followShop store); client-written
 *     follows/{uid}--shop--{id} (adopted in place, via:'server'); and follows/{uid}--seller--{display name}
 *     (mapped only when exactly ONE shop carries that name; AMBIGUOUS / ORPHAN reported, never guessed).
 *     An owner's follow of their own shop is reported (self), not migrated. Legacy docs are kept + stamped.
 *  2. AGGREGATES. Every provider and venue is recounted from its published providerReviews and its
 *     follow records (functions/reputation.js recount) and marked repV — only then does a public page
 *     show its rating (an owner-written providers.rating is never shown).
 *
 *   node scripts/migrate-reputation.js            DRY RUN — prints the plan, writes nothing
 *   node scripts/migrate-reputation.js --apply    writes (a deliberate deploy step; owner approves counts)
 *
 * NOT run by this change.
 */
'use strict';

const slugOf = (name) => 'sv_' + String(name || '').replace(/\s+/g, '_').toLowerCase().replace(/[^a-zA-Z0-9]/g, '_');

async function migrateFollows(db, opts) {
  const o = Object.assign({ apply: false }, opts || {});
  const out = { scanned: 0, migrated: 0, alreadyMigrated: 0, ambiguous: [], orphan: [] };
  const provs = await db.collection('providers').limit(20000).get();
  const bySlug = {};
  provs.docs.forEach((p) => { const d = p.data(); if (!['active', 'approved'].includes(d.status)) return; const s = slugOf(d.businessName || d.name); (bySlug[s] = bySlug[s] || []).push(p.id); });
  const legacy = await db.collection('follows').where('type', '==', 'service').limit(50000).get();
  for (const f of legacy.docs) {
    const d = f.data(); out.scanned++;
    if (d.migratedTo) { out.alreadyMigrated++; continue; }
    const hits = bySlug[String(d.entityId || '')] || [];
    if (hits.length > 1) { out.ambiguous.push({ follow: f.id, slug: d.entityId, providers: hits.length }); continue; }
    if (!hits.length) { out.orphan.push({ follow: f.id, slug: d.entityId }); continue; }
    const providerUid = hits[0];
    if (providerUid === d.uid) { out.orphan.push({ follow: f.id, slug: d.entityId, reason: 'self' }); continue; }
    const to = `${d.uid}--provider--${providerUid.replace(/[^a-zA-Z0-9]/g, '_')}`;
    out.migrated++;
    if (!o.apply) continue;
    const toRef = db.collection('follows').doc(to);
    await db.runTransaction(async (txn) => {
      const t = await txn.get(toRef);
      if (!t.exists) txn.set(toRef, { uid: d.uid, type: 'provider', entityId: providerUid, entityName: d.entityName || '', showMe: false, via: 'server', migratedFrom: f.id, createdAt: d.createdAt || null });
      txn.update(f.ref, { migratedTo: to });
    });
  }
  return out;
}

const _shopOwner = (id, d) => d.sellerUid || d.ownerUid || d.ownerId || id;
const _nameKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const _fid = (uid, type, id) => `${uid}--${type}--${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`;

async function migrateShopFollows(db, opts) {
  const o = Object.assign({ apply: false }, opts || {});
  const out = { fromShopFollowers: 0, adoptedClientShopFollows: 0, fromSellerNames: 0, alreadyMigrated: 0, self: [], ambiguous: [], orphan: [] };
  const shops = {}; const byName = {};
  (await db.collection('shops').limit(20000).get()).docs.forEach((s) => {
    const d = s.data(); shops[s.id] = d;
    const k = _nameKey(d.name || d.storeName); if (k) (byName[k] = byName[k] || []).push(s.id);
  });
  async function toShopFollow(uid, shopId, from, legacyRef) {
    const sd = shops[shopId];
    if (!sd) { out.orphan.push({ from, shopId }); return false; }
    if (_shopOwner(shopId, sd) === uid) { out.self.push({ from, shopId }); return false; }
    if (!o.apply) return true;
    const ref = db.collection('follows').doc(_fid(uid, 'shop', shopId));
    await db.runTransaction(async (txn) => {
      const t = await txn.get(ref);
      if (!t.exists) txn.set(ref, { uid, type: 'shop', entityId: shopId, entityName: sd.name || sd.storeName || '', showMe: false, via: 'server', migratedFrom: from, createdAt: null });
      else if (t.data().via !== 'server') txn.update(ref, { via: 'server' });
      if (legacyRef) txn.set(legacyRef, { migratedTo: ref.path }, { merge: true });
    });
    return true;
  }
  for (const f of (await db.collection('shopFollowers').limit(50000).get()).docs) {
    const d = f.data(); if (d.migratedTo) { out.alreadyMigrated++; continue; }
    if (await toShopFollow(d.uid, d.shopId, f.ref.path, f.ref)) out.fromShopFollowers++;
  }
  for (const f of (await db.collection('follows').where('type', '==', 'shop').limit(50000).get()).docs) {
    const d = f.data(); if (d.via === 'server') continue;
    if (await toShopFollow(d.uid, d.entityId, f.ref.path, null)) out.adoptedClientShopFollows++;
  }
  for (const f of (await db.collection('follows').where('type', '==', 'seller').limit(50000).get()).docs) {
    const d = f.data(); if (d.migratedTo) { out.alreadyMigrated++; continue; }
    const hits = byName[_nameKey(d.entityName || d.entityId)] || [];
    if (hits.length > 1) { out.ambiguous.push({ follow: f.id, name: d.entityName || d.entityId, shops: hits.length }); continue; }
    if (!hits.length) { out.orphan.push({ from: f.ref.path, name: d.entityName || d.entityId }); continue; }
    if (await toShopFollow(d.uid, hits[0], f.ref.path, f.ref)) out.fromSellerNames++;
  }
  return out;
}

async function recountAll(db, rep, opts) {
  const o = Object.assign({ apply: false }, opts || {});
  const out = { providers: 0, venues: 0, shops: 0, changed: [] };
  for (const [type, col] of [['provider', 'providers'], ['venue', 'venues'], ['shop', 'shops']]) {
    const s = await db.collection(col).limit(20000).get();
    for (const d of s.docs) {
      out[col]++;
      if (!o.apply) { out.changed.push({ type, id: d.id, before: { rating: d.data().rating ?? null, reviewCount: d.data().reviewCount ?? null, repV: d.data().repV || null } }); continue; }
      const r = await rep.recount(type, d.id);
      out.changed.push({ type, id: d.id, after: r });
    }
  }
  return out;
}

module.exports = { slugOf, migrateFollows, migrateShopFollows, recountAll };

if (require.main === module) {
  (async () => {
    const admin = require(require.resolve('firebase-admin', { paths: [require('path').join(__dirname, '..', 'functions')] }));
    if (!admin.apps.length) admin.initializeApp();
    const rep = require('../functions/reputation');
    const apply = process.argv.includes('--apply');
    const f = await migrateFollows(admin.firestore(), { apply });
    const sf = await migrateShopFollows(admin.firestore(), { apply });
    const r = await recountAll(admin.firestore(), rep, { apply });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY-RUN', follows: f, shopFollows: sf, aggregates: { providers: r.providers, venues: r.venues, shops: r.shops, sample: r.changed.slice(0, 20) } }, null, 2));
  })().catch((e) => { console.error(e); process.exit(2); });
}
