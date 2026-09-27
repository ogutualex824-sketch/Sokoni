/* migrate-reputation.js — ONE-TIME normalisation for the provider reputation authority.
 *
 *  1. FOLLOW IDENTITY. services.html used to follow a provider as `service--sv_<display-name slug>`.
 *     A slug is not an identity (two providers can share a name; a rename orphans the follow). Each
 *     such follow is mapped to the provider's ACCOUNT id when — and only when — exactly one active
 *     provider has that slug; it then becomes a server follow `{uid}--provider--{providerUid}`.
 *     AMBIGUOUS (2+ providers) and ORPHAN (0) slugs are REPORTED, never guessed. The legacy doc is kept
 *     and stamped `migratedTo` so the migration is re-runnable and auditable.
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

async function recountAll(db, rep, opts) {
  const o = Object.assign({ apply: false }, opts || {});
  const out = { providers: 0, venues: 0, changed: [] };
  for (const [type, col] of [['provider', 'providers'], ['venue', 'venues']]) {
    const s = await db.collection(col).limit(20000).get();
    for (const d of s.docs) {
      out[type === 'provider' ? 'providers' : 'venues']++;
      if (!o.apply) { out.changed.push({ type, id: d.id, before: { rating: d.data().rating ?? null, reviewCount: d.data().reviewCount ?? null, repV: d.data().repV || null } }); continue; }
      const r = await rep.recount(type, d.id);
      out.changed.push({ type, id: d.id, after: r });
    }
  }
  return out;
}

module.exports = { slugOf, migrateFollows, recountAll };

if (require.main === module) {
  (async () => {
    const admin = require(require.resolve('firebase-admin', { paths: [require('path').join(__dirname, '..', 'functions')] }));
    if (!admin.apps.length) admin.initializeApp();
    const rep = require('../functions/reputation');
    const apply = process.argv.includes('--apply');
    const f = await migrateFollows(admin.firestore(), { apply });
    const r = await recountAll(admin.firestore(), rep, { apply });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY-RUN', follows: f, aggregates: { providers: r.providers, venues: r.venues, sample: r.changed.slice(0, 20) } }, null, 2));
  })().catch((e) => { console.error(e); process.exit(2); });
}
