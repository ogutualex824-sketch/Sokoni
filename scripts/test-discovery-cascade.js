/* test-discovery-cascade.js — an OWNER's public change reaches its profile and services (CHANGELOG 245, C3b-1).
 * Transactional fake Firestore + the REAL functions/algolia-sync.js and typesense-sync.js `providers` trigger handlers
 * (firebase-functions trigger factories stubbed to return the handler), the REAL gated queues (algolia-queue /
 * typesense-queue .enqueue) and the REAL discovery-eligibility.js. No network.
 *
 * PROVES — authoritative provider change → re-queue profile + services → the C3a-1 gate decides
 *   suspension · status inactivation · searchable:false · isPublic:false  → the profile and EVERY service (both owner
 *               fields, paused ones included) are queued as DELETE, not just the provider document
 *   approval / reinstatement                         → dependents are queued as UPSERT under the owner's C1 category
 *   reclassification (trades → cleaning)             → dependents re-indexed under the NEW category
 *   provider deleted / created eligible              → dependents deleted / indexed
 *   no public change (a content edit)                → NO dependent is re-queued (no write amplification)
 *   one gate      the cascade queues only upserts; the queue's own gate (prepareForIndex) decides delete vs index
 *   engines       Typesense does not map the dependents → its cascade enqueues nothing for them, and does not throw
 *   bounded       paging covers every service; a per-change cap truncates and REPORTS it
 *   idempotent    a repeated change leaves exactly one queue entry per dependent
 *   fail-soft     a failing dependent enqueue is reported, never thrown into the provider's own sync
 *
 *   node scripts/test-discovery-cascade.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-discovery-cascade';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
stub('firebase-functions/v2/https', { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } });
stub('firebase-functions/params', { defineSecret: (n) => ({ name: n, value: () => 'test-key' }), defineString: (n) => ({ name: n, value: () => '' }) });
const LOG = [];
stub('firebase-functions/logger', { info: (m, d) => LOG.push(['info', m, d]), warn: (m, d) => LOG.push(['warn', m, d]), error: (m, d) => LOG.push(['error', m, d]), debug() {}, log() {} });
const tag = (k) => (o, h) => Object.assign(h, { __kind: k });
stub('firebase-functions/v2/firestore', { onDocumentCreated: tag('create'), onDocumentUpdated: tag('update'), onDocumentDeleted: tag('delete'), onDocumentWritten: tag('write') });

const DE = require(Path.join(FN, 'discovery-eligibility.js'));
const AS = require(Path.join(FN, 'algolia-sync.js'));
const TS = require(Path.join(FN, 'typesense-sync.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const snap = (d) => ({ data: () => d });
const biz = (category, extra) => Object.assign({ status: 'active', name: 'Biz', business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } }, extra || {});
const clearQueues = async () => { for (const c of ['algoliaQueue', 'typesenseQueue']) for (const d of (await db.collection(c).get()).docs) await db.doc(c + '/' + d.id).delete(); };
const aq = (col, id) => get(`algoliaQueue/${col}_${id}`);
const tsDependents = async () => (await db.collection('typesenseQueue').get()).docs.map((d) => d.id).filter((id) => /^provider(Profiles|Services)_/.test(id));

/* The REAL handlers of both engines */
const H = {
  aUpdate: AS.algoliaSync_providers_update, aCreate: AS.algoliaSync_providers_create, aDelete: AS.algoliaSync_providers_delete,
  tUpdate: TS.ts_providers_onUpdate, tCreate: TS.ts_providers_onCreate, tDelete: TS.ts_providers_onDelete,
};
const update = async (uid, before, after) => {
  await db.doc('providers/' + uid).set(after);
  const ev = { params: { docId: uid }, data: { before: snap(before), after: snap(after) } };
  await H.aUpdate(ev); await H.tUpdate(ev);
};

(async () => {
  ck('the REAL trigger handlers of both engines were loaded', Object.values(H).every((h) => typeof h === 'function'), Object.keys(H).filter((k) => typeof H[k] !== 'function'));

  const P1 = biz('trades', { name: 'Paul Plumbing' });
  await db.doc('providers/p1').set(P1);
  await db.doc('providerProfiles/p1').set({ uid: 'p1', status: 'active', name: 'Paul Plumbing', category: 'Plumbing' });
  await db.doc('providerServices/s1').set({ providerId: 'p1', name: 'Burst pipe', active: true });
  await db.doc('providerServices/s2').set({ uid: 'p1', name: 'Geyser fit', active: true });        /* owner via uid */
  await db.doc('providerServices/s3').set({ providerId: 'p1', name: 'Paused', active: false });
  await db.doc('providerServices/sx').set({ providerId: 'other', name: 'Not mine', active: true });
  const DEPS = [['providerProfiles', 'p1'], ['providerServices', 's1'], ['providerServices', 's2'], ['providerServices', 's3']];
  const ops = async () => Promise.all(DEPS.map(async ([c, id]) => { const e = await aq(c, id); return e ? e.operation + (e.data && e.data.category ? ':' + e.data.category : '') : 'none'; }));

  say('\n── discoveryChanged: only a PUBLIC change cascades ──');
  const t = DE.discoveryChanged;
  ck('eligible → suspended / pending / hidden / not public / unclassified / deleted = change',
    [{ status: 'suspended' }, { status: 'pending' }, { searchable: false }, { isPublic: false }, { suspended: true }].every((x) => t(P1, Object.assign({}, P1, x)))
    && t(P1, Object.assign({}, P1, { business: { category: null } })) && t(P1, null));
  ck('ineligible → eligible (approval / reinstatement / created) = change', t({ status: 'pending', business: P1.business }, P1) && t(null, P1));
  ck('reclassified while eligible = change; a content edit = NO change; hidden → still hidden = NO change',
    t(P1, biz('cleaning')) && !t(P1, Object.assign({}, P1, { name: 'New name', description: 'x', category: 'free text' }))
    && !t({ status: 'suspended' }, { status: 'suspended', name: 'y' }) && !t(null, { status: 'pending' }));

  say('\n── suspension: the profile and EVERY service leave both queues\' gate as DELETE ──');
  await clearQueues();
  await update('p1', P1, Object.assign({}, P1, { status: 'suspended', suspended: true }));
  const sus = await ops();
  ck('Algolia: profile + both owner fields + the paused one → DELETE', sus.every((o) => o === 'delete'), sus);
  ck('…the provider document itself is queued as DELETE too (unchanged behaviour)', (await aq('providers', 'p1')).operation === 'delete');
  ck('…another owner\'s service is untouched', (await aq('providerServices', 'sx')) === null);
  ck('Typesense: it does not map the dependents → its cascade queued nothing for them, and did not throw', (await tsDependents()).length === 0 && (await get('typesenseQueue/providers_p1')).operation === 'delete');
  const eng = (e) => LOG.filter((l) => l[1] === '[discovery] owner change re-queued dependents' && l[2] && l[2].engine === e && l[2].uid === 'p1');
  ck('…but BOTH engines\' providers triggers ran the cascade (wired, so it follows if Typesense ever maps a dependent)',
    eng('algolia').length >= 1 && eng('typesense').length >= 1, { algolia: eng('algolia').length, typesense: eng('typesense').length });

  say('\n── reinstatement: dependents come back under the owner\'s C1 category ──');
  await clearQueues();
  await update('p1', Object.assign({}, P1, { status: 'suspended', suspended: true }), P1);
  const back = await ops();
  ck('profile + active services → UPSERT under trades; the paused service stays DELETE (the gate, not the cascade, decides)',
    back.join() === 'upsert:trades,upsert:trades,upsert:trades,delete', back);

  say('\n── reclassification: trades → cleaning ──');
  await clearQueues();
  const P1c = biz('cleaning', { name: 'Paul Plumbing' });
  await update('p1', P1, P1c);
  const rc = await ops();
  ck('every live dependent is re-indexed under the NEW category', rc.join() === 'upsert:cleaning,upsert:cleaning,upsert:cleaning,delete', rc);

  say('\n── hidden flags ──');
  for (const [label, x] of [['searchable:false', { searchable: false }], ['isPublic:false', { isPublic: false }], ['status inactive', { status: 'inactive' }]]) {
    await clearQueues();
    await update('p1', P1c, Object.assign({}, P1c, x));
    const h = await ops();
    ck(`${label} → every dependent DELETE`, h.every((o) => o === 'delete'), h);
    await update('p1', Object.assign({}, P1c, x), P1c);    /* restore for the next case */
  }

  say('\n── no public change → no cascade (no write amplification) ──');
  await clearQueues();
  await update('p1', P1c, Object.assign({}, P1c, { name: 'Paul Plumbing & Sons', description: 'Now with sons', category: 'free text' }));
  ck('a content edit re-queues the provider only — no dependent entry in either queue',
    (await ops()).every((o) => o === 'none') && (await tsDependents()).length === 0 && !!(await aq('providers', 'p1')), await ops());

  say('\n── delete / create ──');
  await clearQueues();
  await db.doc('providers/p1').delete();
  await H.aDelete({ params: { docId: 'p1' }, data: snap(P1c) }); await H.tDelete({ params: { docId: 'p1' }, data: snap(P1c) });
  ck('provider deleted → every dependent DELETE', (await ops()).every((o) => o === 'delete'), await ops());
  await clearQueues();
  await db.doc('providers/p1').set(P1c);
  await H.aCreate({ params: { docId: 'p1' }, data: snap(P1c) }); await H.tCreate({ params: { docId: 'p1' }, data: snap(P1c) });
  ck('provider created ALREADY eligible (approval projecting it) → dependents indexed', (await ops()).join() === 'upsert:cleaning,upsert:cleaning,upsert:cleaning,delete', await ops());
  await clearQueues();
  const PENDING = { status: 'pending_approval', name: 'New' };
  await db.doc('providers/p9').set(PENDING);
  await db.doc('providerServices/s9').set({ providerId: 'p9', name: 'Draft', active: true });
  await H.aCreate({ params: { docId: 'p9' }, data: snap(PENDING) });
  ck('provider created PENDING → no cascade (nothing public changed)', (await aq('providerServices', 's9')) === null);

  say('\n── bounded, idempotent, fail-soft ──');
  for (let i = 0; i < 7; i++) await db.doc(`providerServices/b${i}`).set({ providerId: 'p1', name: 'B' + i, active: true });
  const seenIds = [];
  const r1 = await DE.requeueDependents(db, 'p1', async (e) => { seenIds.push(e.docId); }, { page: 2 });
  ck('paging (page size 2) reaches every service exactly once, both owner fields', r1.services === 10 && new Set(seenIds).size === seenIds.length && !r1.truncated, r1);
  const r2 = await DE.requeueDependents(db, 'p1', async () => {}, { page: 2, max: 4 });
  ck('a per-change cap TRUNCATES and says so', r2.services === 4 && r2.truncated === true, r2);
  await clearQueues();
  await update('p1', P1c, Object.assign({}, P1c, { status: 'suspended' }));
  await update('p1', Object.assign({}, P1c, { status: 'suspended' }), Object.assign({}, P1c, { status: 'suspended', suspended: true, name: 'again' }));
  await update('p1', Object.assign({}, P1c, { status: 'suspended' }), P1c);
  await update('p1', P1c, Object.assign({}, P1c, { status: 'suspended' }));
  const ids = (await db.collection('algoliaQueue').get()).docs.map((d) => d.id).filter((id) => /^providerServices_/.test(id));
  ck('repeated changes leave exactly ONE queue entry per dependent (keyed collection_docId)', ids.length === new Set(ids).size && ids.length === 10, ids.length);
  const logged = LOG.length;
  /* A throw here must be RECORDED as the failure it is — an unguarded call would crash the suite instead, and a crash
     is not a verdict. */
  let bad;
  try { bad = await DE.cascadeOwnerChange(db, 'p1', P1c, null, async () => { throw new Error('queue down'); }, 'test'); }
  catch (e) { bad = { THREW: (e && e.message) || String(e) }; }
  ck('a failing dependent enqueue is REPORTED (returned + logged), never thrown', bad && !bad.THREW && /queue down/.test(bad.error) && LOG.slice(logged).some((l) => l[0] === 'error'), bad);
  ck('an unchanged owner does not even read its dependents', (await DE.cascadeOwnerChange(db, 'p1', P1c, P1c, async () => { throw new Error('must not be called'); }, 'test')) === null);
  ck('an unsafe uid is refused without a read', (await DE.requeueDependents(db, 'a/b', async () => { throw new Error('x'); })).services === 0);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
