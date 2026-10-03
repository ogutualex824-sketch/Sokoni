#!/usr/bin/env node
'use strict';
/* ============================================================================
   foundationContentDispatch + foundationStoryMediaGuard — stories, testimonials, Media House
   Real handlers on the in-memory Firestore fake + a fake Storage bucket (metadata + download tokens).
     A  testimonial: consent required; server re-reads media type/size; foreign path refused; created once
     B  a participant can never publish: listPublished shows nothing until an ADMIN approves AND publishes
     C  decisions follow the state machine; notes required; author cannot approve own story; audit rows
     D  publishing: only approved; tokens issued; consent.showMedia=false → no media; showName rules
     E  media guard: archive / unpublish / consent withdrawal revoke tokens; removed media revoked
     F  forged client fields (moderation, publishAt, kind) are ignored
     G  public listing is bounded, filtered by destination/programme, and carries no private fields
   node scripts/test-foundation-content.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };

let now = Date.now();   /* publish stamps the real clock */
const T0 = Date.now();
const F = makeFakeFirestore({ clock: () => now + (Date.now() - T0) });   /* moves with real time + the test's manual jumps */
const OBJECTS = {};   /* path → { contentType, size, token } */
const bucket = {
  name: 'sokoni-aeb26.appspot.com',
  file: (p) => ({
    getMetadata: async () => { if (!OBJECTS[p]) throw new Error('No such object'); return [{ contentType: OBJECTS[p].contentType, size: String(OBJECTS[p].size) }]; },
    setMetadata: async (m) => { if (!OBJECTS[p]) throw new Error('No such object'); OBJECTS[p].token = m.metadata.firebaseStorageDownloadTokens || null; return [{}]; },
    copy: async (dest) => { if (!OBJECTS[p]) throw new Error('No such object'); OBJECTS[dest._path] = { ...OBJECTS[p], token: null, copyOf: p }; return [{}]; },
    delete: async () => { if (!OBJECTS[p]) throw new Error('No such object'); delete OBJECTS[p]; return [{}]; },
    _path: p,
  }),
};
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff, storage: () => ({ bucket: () => bucket }) } };
const M = require(path.join(FN, 'foundation-content.js'));
let ipn = 0;
async function call(uid, data, token = {}) {
  ipn++;
  try { return { ok: true, v: await M.foundationContentDispatch.run({ auth: uid ? { uid, token } : null, data, rawRequest: { headers: { 'x-forwarded-for': '10.1.0.' + (ipn % 250) } } }) }; }
  catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
const ADM = { admin: true };
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
/* simulate the media-worker codebase: READY record + derivatives under foundation-processed/ */
async function markMedia(srcPath, state, reason) {
  const sub = srcPath.replace(/^foundation-media\//, '');
  const video = /\.(mp4|webm|mov)$/.test(srcPath);
  const main = 'foundation-processed/' + sub + '/1/main.' + (video ? 'mp4' : 'webp'), thumb = 'foundation-processed/' + sub + '/1/thumb.jpg';
  if (state === 'READY') { OBJECTS[main] = { contentType: video ? 'video/mp4' : 'image/webp', size: 1000 }; OBJECTS[thumb] = { contentType: 'image/jpeg', size: 100 }; }
  await F.db.collection('foundationMedia').doc(M._test.mediaIdOf(srcPath)).set({ sourcePath: srcPath, state, kind: video ? 'video' : 'image',
    derivatives: state === 'READY' ? { main: { path: main, contentType: video ? 'video/mp4' : 'image/webp' }, thumb: { path: thumb, contentType: 'image/jpeg' } } : null,
    error: reason ? { reason } : null });
}
const pubCopies = () => Object.keys(OBJECTS).filter((k) => k.startsWith('foundation-published/'));
const tid = (uid, rid) => 'T_' + require('crypto').createHash('sha256').update(uid + '|' + rid).digest('hex').slice(0, 28);
const story = async (id) => (await F.db.collection('foundationStories').doc(id).get()).data();
/* run the media guard as the trigger would, on the before/after of a write */
async function writeAndGuard(id, fn) {
  const before = await story(id);
  const r = await fn();
  const after = await story(id);
  const g = await M._test.guard(before, after);
  if (g.clearDoc) await F.db.collection('foundationStories').doc(id).update({ media: M._test.stripTokens(after.media) });
  return r;
}

(async () => {
  console.log('foundationContentDispatch — stories, testimonials, Media House\n');
  await F.db.collection('impactCampaigns').doc('edu1').set({ title: 'School fees', status: 'active' });
  await F.db.collection('impactCampaigns').doc('old').set({ title: 'Closed', status: 'completed' });
  OBJECTS['foundation-media/u1/photo.jpg'] = { contentType: 'image/jpeg', size: 400000 };
  OBJECTS['foundation-media/u1/clip.mp4'] = { contentType: 'video/mp4', size: 30 * 1024 * 1024 };
  OBJECTS['foundation-media/u1/huge.mp4'] = { contentType: 'video/mp4', size: 90 * 1024 * 1024 };
  OBJECTS['foundation-media/u1/evil.svg'] = { contentType: 'image/svg+xml', size: 1000 };
  OBJECTS['foundation-media/u2/theirs.jpg'] = { contentType: 'image/jpeg', size: 1000 };
  OBJECTS['foundation-media/admin/visit.jpg'] = { contentType: 'image/webp', size: 200000 };

  /* A */
  const base = { op: 'submitTestimonial', title: 'SOKONI helped my shop', body: 'After the fire, the Foundation <b>helped</b> me restock.', displayName: 'Akinyi Otieno', displayPreference: 'first_name', location: 'Kisumu', programmeId: 'edu1' };
  const a0 = await call(null, { ...base, requestId: uuid(1), consent: { publish: true } });
  const a1 = await call('u1', { ...base, requestId: uuid(1), consent: {} });
  const a2 = await call('u1', { ...base, requestId: uuid(1), consent: { publish: true }, media: ['foundation-media/u2/theirs.jpg'] });
  const a3 = await call('u1', { ...base, requestId: uuid(1), consent: { publish: true }, media: ['foundation-media/u1/huge.mp4'] });
  const a4 = await call('u1', { ...base, requestId: uuid(1), consent: { publish: true }, media: ['foundation-media/u1/evil.svg'] });
  const a5 = await call('u1', { ...base, requestId: uuid(1), consent: { publish: true }, programmeId: 'old' });
  ck('A1 signed out / no consent / someone else\'s file / video >80MB / SVG / inactive programme → all refused',
    a0.code === 'unauthenticated' && a1.code === 'invalid-argument' && a2.code === 'invalid-argument' && /80 MB/.test(a3.msg) && /JPEG/.test(a4.msg) && /not active/.test(a5.msg), { a0, a1, a2, a3, a4, a5 });
  const a6 = await call('u1', { ...base, requestId: uuid(1), consent: { publish: true, showName: true, showMedia: true }, media: ['foundation-media/u1/photo.jpg', 'foundation-media/u1/clip.mp4'],
    moderation: { status: 'approved' }, publishAt: 1, kind: 'story', submittedBy: 'someoneElse' });
  const T = tid('u1', uuid(1));
  const t = await story(T);
  ck('A2 valid testimonial → pending, consent recorded with version, markup stripped, media typed by the SERVER',
    a6.ok && t.moderation.status === 'pending' && t.consent.publish && t.consent.version && !/[<>]/.test(t.body) && t.media.length === 2 && t.media[1].type === 'video' && t.media[1].contentType === 'video/mp4', t);
  ck('F1 forged moderation / publishAt / kind / submittedBy ignored', t.kind === 'testimonial' && t.publishAt === null && t.submittedBy === 'u1');
  const a7 = await call('u1', { ...base, requestId: uuid(1), consent: { publish: true } });
  ck('A3 same requestId again → same record, not a second one', a7.ok && a7.v.alreadySubmitted === true && [...F.db._store.keys()].filter((k) => /^foundationStories\/[^/]+$/.test(k)).length === 1, a7);

  /* B */
  const b1 = await call('anyone', { op: 'listPublished' });
  const b2 = await call('u1', { op: 'adminDecide', id: T, action: 'approve' });
  const b3 = await call('u1', { op: 'adminPublish', id: T });
  ck('B1 nothing public while pending; the participant cannot approve or publish', b1.ok && b1.v.rows.length === 0 && b2.code === 'permission-denied' && b3.code === 'permission-denied', { b1, b2, b3 });

  /* C */
  const c1 = await call('adm1', { op: 'adminDecide', id: T, action: 'reject' }, ADM);
  const c2 = await call('adm1', { op: 'adminDecide', id: T, action: 'archive' }, ADM);
  ck('C1 reject without a note refused; archive from pending refused (state machine)', c1.code === 'invalid-argument' && c2.code === 'failed-precondition', { c1, c2 });
  const c3 = await call('adm1', { op: 'adminPublish', id: T }, ADM);
  ck('C2 publishing a pending story refused', c3.code === 'failed-precondition', c3);
  const s1 = await call('adm1', { op: 'adminSaveStory', requestId: uuid(9), title: 'Visit to Kibera school', body: 'We delivered books.', media: ['foundation-media/admin/visit.jpg'], destinations: ['foundation_home', 'banking_hub', 'nonsense'], programmeId: 'edu1', submit: true }, ADM);
  const S = 'S_' + uuid(9);
  const c4 = await call('adm1', { op: 'adminDecide', id: S, action: 'approve' }, ADM);
  const c5 = await call('adm2', { op: 'adminDecide', id: S, action: 'approve' }, ADM);
  ck('C3 an admin cannot approve the story they wrote; a second admin can', s1.ok && c4.code === 'permission-denied' && c5.ok && (await story(S)).moderation.status === 'approved', { c4, c5 });
  ck('C4 destinations filtered to the known set', JSON.stringify((await story(S)).destinations) === '["foundation_home","banking_hub"]', (await story(S)).destinations);
  const c6 = await call('adm2', { op: 'adminDecide', id: T, action: 'approve' }, ADM);
  const trans = [...F.db._store.keys()].filter((k) => k.startsWith('foundationStories/' + T + '/transitions/'));
  ck('C5 testimonial approved; transitions + adminActions audit written', c6.ok && trans.length >= 2 && [...F.db._store.keys()].filter((k) => k.startsWith('adminActions/')).length === 2, trans);

  /* D */
  const mg0 = await call('adm2', { op: 'adminPublish', id: T }, ADM);
  await markMedia('foundation-media/u1/photo.jpg', 'READY');
  await markMedia('foundation-media/u1/clip.mp4', 'PROCESSING');
  const mg1 = await call('adm2', { op: 'adminPublish', id: T }, ADM);
  await markMedia('foundation-media/u1/clip.mp4', 'REJECTED', 'unsupported_codec');
  const mg2 = await call('adm2', { op: 'adminPublish', id: T }, ADM);
  ck('M1 publish REFUSED while media has no processing record / is PROCESSING / was REJECTED (reason shown); nothing made public',
    !mg0.ok && /still processing/.test(mg0.msg) && !mg1.ok && /still processing/.test(mg1.msg) && !mg2.ok && /rejected \(unsupported_codec\)/.test(mg2.msg) && pubCopies().length === 0, { mg0, mg1, mg2 });
  const ml = await call('adm2', { op: 'adminList', kind: 'testimonial' }, ADM);
  const mrow = ml.v.rows.find((r) => r.id === T);
  ck('M2 admin list shows each item\'s processing state and reason', mrow && mrow.media[0].processing === 'READY' && mrow.media[1].processing === 'REJECTED' && mrow.media[1].reason === 'unsupported_codec', mrow && mrow.media);
  await markMedia('foundation-media/u1/clip.mp4', 'READY');
  const d1 = await call('adm2', { op: 'adminPublish', id: T }, ADM);
  ck('M3 publish copies the READY DERIVATIVES (main + thumb), never the original upload', d1.ok && pubCopies().length === 4 && pubCopies().every((k) => String(OBJECTS[k].copyOf).startsWith('foundation-processed/u1/')) && !pubCopies().some((k) => String(OBJECTS[k].copyOf).startsWith('foundation-media/')), pubCopies().map((k) => OBJECTS[k].copyOf));
  const pub = await call('anyone', { op: 'listPublished', destination: 'donation_wizard' });
  const row = pub.v && pub.v.rows.find((r) => r.id === T);
  ck('D1 published testimonial appears below the donation wizard with tokened media + first name only',
    d1.ok && row && row.name === 'Akinyi' && row.media.length === 2 && /token=/.test(row.media[0].url) && /foundation-published%2F/.test(row.media[0].url) && !!row.media[0].thumbUrl && row.media[1].contentType === 'video/mp4' && !OBJECTS['foundation-media/u1/photo.jpg'].token, row);
  ck('G1 public row has no uid (not even inside a media URL), consent, moderation or storage path', row && !/(^|[^a-z])u1([^0-9]|$)/.test(JSON.stringify(row)) && !('submittedBy' in row) && !('consent' in row) && !('moderation' in row) && !row.media.some((m) => 'path' in m), row);
  /* second testimonial: showMedia false, anonymous */
  OBJECTS['foundation-media/u3/p.jpg'] = { contentType: 'image/png', size: 1000 };
  await call('u3', { op: 'submitTestimonial', requestId: uuid(3), title: 'Thank you', body: 'Help with medical bills.', displayPreference: 'anonymous', consent: { publish: true, showMedia: false }, media: ['foundation-media/u3/p.jpg'] });
  const T3 = tid('u3', uuid(3));
  await call('adm1', { op: 'adminDecide', id: T3, action: 'approve' }, ADM);
  await call('adm1', { op: 'adminPublish', id: T3 }, ADM);
  const pub2 = await call('anyone', { op: 'listPublished' });
  const r3 = pub2.v.rows.find((r) => r.id === T3);
  ck('D2 consent.showMedia=false → no media and no token issued; anonymous → neutral name', r3 && r3.media.length === 0 && !pubCopies().some((k) => String(OBJECTS[k].copyOf).startsWith('foundation-processed/u3/')) && r3.name === 'A SOKONI Foundation beneficiary', r3);
  await markMedia('foundation-media/admin/visit.jpg', 'READY');
  const d3 = await call('adm1', { op: 'adminPublish', id: S, publishAt: now + 86400000 }, ADM);
  const pub3 = await call('anyone', { op: 'listPublished' });
  ck('D3 a story scheduled for tomorrow is not public yet', d3.ok && !pub3.v.rows.some((r) => r.id === S));
  now += 2 * 86400000;
  const pub4 = await call('anyone', { op: 'listPublished', destination: 'banking_hub' });
  ck('D4 …and is public once its time passes, in the Banking Hub view only where tagged', pub4.v.rows.length === 1 && pub4.v.rows[0].id === S, pub4.v.rows.map((r) => r.id));
  const pub5 = await call('anyone', { op: 'listPublished', programmeId: 'edu1' });
  ck('G2 programme filter returns the stories linked to that programme', pub5.v.rows.length === 2 && pub5.v.rows.every((r) => r.programmeId === 'edu1'), pub5.v.rows.map((r) => r.id));
  await F.db.collection('foundationStories').doc('legacy1').set({ kind: 'story', title: 'Hand-edited', body: 'x', moderation: { status: 'archived' }, publishAt: F.Timestamp.fromMillis(now - 1000), destinations: ['foundation_home'], media: [] });
  const pubL = await call('anyone', { op: 'listPublished' });
  ck('G4 a doc with a publish time but NOT approved (e.g. hand-edited) is never listed', pubL.ok && !pubL.v.rows.some((r) => r.id === 'legacy1'), pubL.v && pubL.v.rows.map((r) => r.id));
  await F.db.collection('foundationStories').doc('legacy1').delete();
  const pub6 = await call('anyone', { op: 'listPublished', limit: 500 });
  ck('G3 page size bounded (≤12) with a cursor', pub6.ok && pub6.v.rows.length <= 12);

  /* E */
  await writeAndGuard(T, () => call('adm2', { op: 'adminDecide', id: T, action: 'archive' }, ADM));
  ck('E1 archive → off the public list AND download tokens revoked', !(await call('anyone', { op: 'listPublished' })).v.rows.some((r) => r.id === T) && !pubCopies().some((k) => String(OBJECTS[k].copyOf).startsWith('foundation-processed/u1/')) && (await story(T)).media.every((m) => !m.token && !m.publicPath));
  await writeAndGuard(S, () => call('adm1', { op: 'adminUnpublish', id: S }, ADM));
  ck('E2 unpublish → published copy deleted', !pubCopies().some((k) => String(OBJECTS[k].copyOf).startsWith('foundation-processed/admin/visit.jpg/')));
  /* consent withdrawal on a live one */
  await call('adm2', { op: 'adminDecide', id: S, action: 'archive' }, ADM);
  OBJECTS['foundation-media/u4/v.mp4'] = { contentType: 'video/webm', size: 5000 };
  await call('u4', { op: 'submitTestimonial', requestId: uuid(4), title: 'Grateful', body: 'Thanks.', displayName: 'Juma', displayPreference: 'name', consent: { publish: true, showName: true, showMedia: true }, media: ['foundation-media/u4/v.mp4'] });
  const T4 = tid('u4', uuid(4));
  await call('adm1', { op: 'adminDecide', id: T4, action: 'approve' }, ADM);
  await markMedia('foundation-media/u4/v.mp4', 'READY');
  await call('adm1', { op: 'adminPublish', id: T4 }, ADM);
  const live = pubCopies().some((k) => String(OBJECTS[k].copyOf).startsWith('foundation-processed/u4/v.mp4/'));
  const e3x = await call('u1', { op: 'withdrawMine', id: T4 });
  await writeAndGuard(T4, () => call('u4', { op: 'withdrawMine', id: T4 }));
  ck('E3 only the participant can withdraw; withdrawal archives, unpublishes and revokes media', live && e3x.code === 'not-found' && (await story(T4)).moderation.status === 'archived' && (await story(T4)).consent.publish === false && !pubCopies().some((k) => String(OBJECTS[k].copyOf).startsWith('foundation-processed/u4/v.mp4/')), { e3x, s: (await story(T4)).moderation });
  OBJECTS['foundation-published/zz/0'] = { contentType: 'image/jpeg', size: 1 };
  const g = await M._test.guard({ media: [{ path: 'foundation-media/admin/visit.jpg', publicPath: 'foundation-published/zz/0', token: 'x' }] }, { moderation: { status: 'approved' }, publishAt: 1, kind: 'story', media: [] });
  ck('E4 a media item removed from a live story has its public copy deleted', g.revoked === 1 && !OBJECTS['foundation-published/zz/0']);
  const c7 = await call('adm1', { op: 'adminDecide', id: T4, action: 'restore' }, ADM);
  const c8 = await call('adm2', { op: 'adminDecide', id: T4, action: 'approve' }, ADM);
  ck('C6 a withdrawn testimonial can be restored to review, but never approved without consent', c7.ok && c8.code === 'failed-precondition', { c7, c8 });

  /* participant views */
  const m1 = await call('u1', { op: 'listMine' });
  ck('H1 participant sees only their own submissions with status', m1.ok && m1.v.rows.length === 1 && m1.v.rows[0].status === 'archived');
  const h2 = await call('adm1', { op: 'adminCounts' }, ADM);
  ck('H2 admin counts are aggregates', h2.ok && h2.v.testimonials === 3 && h2.v.stories === 1, h2.v);
  const r5 = [];
  for (let i = 10; i < 14; i++) r5.push(await call('u9', { op: 'submitTestimonial', requestId: uuid(i), title: 'x', body: 'y', consent: { publish: true } }));
  ck('H3 participant limit: the 4th submission in a day is refused', r5.slice(0, 3).every((r) => r.ok) && r5[3].code === 'resource-exhausted', r5.map((r) => r.code || 'ok'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
