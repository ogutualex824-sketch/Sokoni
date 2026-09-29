#!/usr/bin/env node
/* test-r3-classification-apply.js — the R3 apply path on the transactional fake store. No network.
 *
 * PROVES
 *   digest gate   apply refuses (writes nothing) unless the live primary set's digest equals the authorized one
 *   writes        exactly providers/{uid}.business (+updatedAt) and one adminAudit per PRIMARY identity — the
 *                 disagreement identity and the unresolved identity are NOT written
 *   preserved     every other provider field is byte-identical; the application is byte-identical; no capabilities,
 *                 businesses, shops, sellers or products change
 *   drift         an identity whose application changed between plan and transaction is aborted (that identity only)
 *   idempotent    a second apply with the same digest recomputes an empty primary set → digest_mismatch with
 *                 alreadyStampedProviders reported, and writes nothing; a third apply the same
 *   post-R2       each stamped identity resolves to provider-dashboard / AVAILABLE with capability SERVICES
 *
 *   node scripts/test-r3-classification-apply.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-r3';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path'); const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue }), auth: () => ({}) });
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const R3 = require(Path.join(ROOT, 'scripts', 'r3-classification-manifest.js'));
const BW = require(Path.join(FN, 'business-workspace.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const J = (x) => JSON.stringify(x);
const stripStamp = (p) => { const c = Object.assign({}, p); delete c.business; delete c.updatedAt; return c; };
const seed = async (uid, cat, opts) => {
  const o = opts || {};
  await db.doc('providers/' + uid).set(Object.assign({ name: uid, status: 'active', approvedAt: 1, category: cat, sourceApplicationId: 'app_' + uid }, o.provider || {}));
  await db.doc('applications/app_' + uid).set(Object.assign({ uid, role: 'provider', status: 'approved', statusCanonical: 'approved', category: cat, decidedBy: 'admin_1', decidedAt: 1 }, o.app || {}));
};
(async () => {
  await seed('tailor1', 'tailor'); await seed('clean1', 'cleaning'); await seed('mover1', 'moving');
  await seed('dg', 'wholesaler'); await db.doc('businesses/dg').set({ uid: 'dg', ownerId: 'dg', capabilities: { version: 1, SERVICES: { state: 'approved', decidedBy: 'a', decidedAt: 1, applicationId: 'app_dg', source: 'application_approval' } } });
  await db.doc('providers/statusonly').set({ name: 'S', status: 'active', category: 'dj' });
  await db.doc('users/tailor1').set({ roles: ['provider'] });
  const before = {}; for (const u of ['tailor1', 'clean1', 'mover1', 'dg', 'statusonly']) before[u] = { p: J(await get('providers/' + u)), a: J(await get('applications/app_' + u)) };
  const bizBefore = J(await get('businesses/dg'));

  say('\n── plan ──');
  const m = R3.buildManifests(await R3.snapshotAll(db));
  ck('plan: 3 primary (tailor→service_business, cleaning, moving→trades), 1 disagreement (dg), 1 unresolved (status only)', m.primary.length === 3 && m.disagree.length === 1 && m.unresolved.length === 1 && m.primary.map((r) => r.mutation.set.business.category).sort().join() === 'cleaning,service_business,trades', { p: m.primary.length, d: m.disagree.length, u: m.unresolved.length });
  const DIG = m.digests.primary;

  say('\n── digest gate ──');
  const bad = await R3.apply(db, 'deadbeef'.repeat(8), F.FieldValue);
  ck('a wrong digest is refused, nothing written', bad.refused === 'digest_mismatch' && bad.applied.length === 0 && !(await get('providers/tailor1')).business);
  ck('no digest is refused', (await R3.apply(db, null, F.FieldValue)).refused === 'no_digest');

  say('\n── drift between plan and apply ──');
  await db.doc('applications/app_mover1').set({ category: 'dj' }, { merge: true });   /* the mover's application changed after the plan: moving → dj (artist_creator) */
  const r1 = await R3.apply(db, DIG, F.FieldValue);
  ck('the primary set is recomputed LIVE: the mover now classifies differently → digest_mismatch, NOTHING written for anyone', r1.refused === 'digest_mismatch' && r1.applied.length === 0 && !(await get('providers/tailor1')).business && !(await get('providers/mover1')).business, r1);
  /* restore the mover's application exactly as planned */
  await db.doc('applications/app_mover1').set({ uid: 'mover1', role: 'provider', status: 'approved', statusCanonical: 'approved', category: 'moving', decidedBy: 'admin_1', decidedAt: 1 });
  ck('restored: the live primary digest equals the authorized one again', R3.buildManifests(await R3.snapshotAll(db)).digests.primary === DIG);

  say('\n── apply the authorized primary set ──');
  const r2 = await R3.apply(db, DIG, F.FieldValue);
  ck('all 3 primary identities applied, none refused, each with an audit id', !r2.refused && r2.applied.length === 3 && r2.applied.every((x) => x.auditId) && r2.skipped.length === 0, r2);
  for (const [u, cat] of [['tailor1', 'service_business'], ['clean1', 'cleaning'], ['mover1', 'trades']]) {
    const p = await get('providers/' + u);
    ck(`${u}: business stamp = { ${cat}, lane, source application, applicationId app_${u}, setAt }`, !!p.business && p.business.category === cat && p.business.source === 'application' && p.business.applicationId === 'app_' + u && p.business.setAt !== undefined && p.business.lane && 'hub' in p.business.lane, p.business);
    ck(`${u}: every other provider field byte-identical; application byte-identical`, J(stripStamp(p)) === J(JSON.parse(before[u].p)) && J(await get('applications/app_' + u)) === before[u].a);
  }
  const audits = db._dump ? db._dump('adminAudit/').filter((a) => a.action === 'category_backfill_r3') : [];
  ck('exactly 3 audit records, one per identity, naming the evidence', audits.length === 3 && new Set(audits.map((a) => a.targetUid)).size === 3 && audits.every((a) => /decided by admin_1/.test(a.evidence)), audits.map((a) => a.targetUid));
  ck('the DISAGREEMENT identity (dg) was NOT stamped; its capability stamp untouched', !(await get('providers/dg')).business && J(await get('businesses/dg')) === bizBefore && J(await get('providers/dg')) === before.dg.p);
  ck('the UNRESOLVED identity (status only) was NOT touched', J(await get('providers/statusonly')) === before.statusonly.p);
  ck('no businesses/shops/sellers/products/users record changed', (await get('businesses/tailor1')) === null && (await get('shops/tailor1')) === null && (await get('sellers/tailor1')) === null && J(await get('users/tailor1')) === J({ roles: ['provider'] }));

  say('\n── idempotent ──');
  const r3 = await R3.apply(db, DIG, F.FieldValue);
  ck('a second apply with the same authorized digest: the live primary set is now EMPTY → digest_mismatch, primaryCount 0, 3 alreadyStampedProviders reported, no new audit', r3.refused === 'digest_mismatch' && r3.primaryCount === 0 && r3.alreadyStampedProviders === 3 && (db._dump ? db._dump('adminAudit/').filter((a) => a.action === 'category_backfill_r3').length : 3) === 3, r3);
  const r4 = await R3.apply(db, DIG, F.FieldValue);
  ck('a third apply is the same no-op', r4.refused === 'digest_mismatch' && r4.primaryCount === 0);

  say('\n── post-R2 resolver ──');
  for (const u of ['tailor1', 'clean1', 'mover1']) {
    const w = await BW.workspaceFor(db, u);
    ck(`${u}: category stamped + provider lane + SERVICES → provider-dashboard, AVAILABLE`, w.route === 'provider-dashboard.html' && w.state === 'AVAILABLE' && w.lane === 'services' && w.capability.classification === 'SERVICES', { route: w.route, state: w.state, cat: w.category, cap: w.capability.classification });
  }
  const wdg = await BW.workspaceFor(db, 'dg');
  ck('dg (deferred): still PENDING_CLASSIFICATION, no route — untouched by R3', wdg.state === 'PENDING_CLASSIFICATION' && wdg.route === null);

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
