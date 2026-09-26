/* test-creator-preview.js — PREVIEW enforcement, executed.
 *
 *   SERVER  the REAL creator-hub.js ops (playback.preview, playback.previewProgress,
 *           playback.authorize, playback.heartbeat, film.saveDraft) on the
 *           transactional fake Firestore and a signing bucket that records every
 *           path it signs — so "the full film URL never reached a non-entitled
 *           viewer" is an observation, not an assumption.
 *   GUARD   the shared attachPreviewGuard (the SAME module creator.html loads) on
 *           a simulated media element: 30 s / 60 s boundaries, seek, pause/play.
 *   BROWSER the guard on a REAL <video> in Chromium, playing a real webm the page
 *           records from a canvas (no network, no fixture file).
 *
 *   node scripts/test-creator-preview.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-creator-preview';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.UTC(2026, 8, 26, 9);
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;
const quiet = console.log; console.info = console.warn = console.error = console.debug = () => {};

const signed = [];
const bucket = { file: (p) => ({
  exists: async () => [true],
  getMetadata: async () => [{ size: 1000, contentType: 'video/mp4', generation: '1' }],
  getSignedUrl: async (o) => { signed.push({ path: p, expires: o.expires }); return [`https://storage.googleapis.com/fake/${encodeURIComponent(p)}?sig=1`]; },
}) };
const stub = (m, exp) => { require.cache[require.resolve(m, { paths: [FN] })] = { id: m, filename: m, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => bucket }) });
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (u) => ({ uid: u, email: u + '@x.test', providerData: [{ providerId: 'password' }] }) }) });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }),
  auth: () => ({ getUser: async (u) => ({ uid: u, providerData: [{}] }) }), storage: () => ({ bucket: () => bucket }) });

const H = require(Path.join(FN, 'creator-hub.js'));
H._internal._setClock(() => NOW);
const P = require(Path.join(FN, 'shared', 'creator-publishing.js'));
const OPS = H._internal.OPS;
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: { 'x-forwarded-for': '41.90.1.23' } } });
const op = (name, uid, data = {}, token) => OPS[name]({ ...who(uid, token), data });
async function out(p) { try { return { ok: await p }; } catch (e) { return { err: e.code, msg: e.message }; } }

let pass = 0, fail = 0;
const ck = (l, ok, d) => { quiet('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 150) + ']' : '')); ok ? pass++ : fail++; };
const mastersSignedFor = (n0) => signed.slice(n0).filter((s) => /creator-masters/.test(s.path));

async function film(id, over = {}) {
  await db.doc('entertainmentListings/' + id).set({ creatorHub: true, creatorUid: 'cA', title: 'Film ' + id, pubState: 'PUBLISHED', status: 'active',
    previewSeconds: 30, previewReady: true, priceCents: 50000, currency: 'KES', accessType: 'buy', ...over });
  await db.doc('creatorMedia/' + id).set({ filmId: id, creatorUid: 'cA', storagePath: `creator-masters/cA/${id}/m1`, previewStoragePath: `creator-previews/cA/${id}/p1` });
}
async function entitle(uid, filmId, status = 'ACTIVE') {
  const ref = `pay_${uid}_${filmId}`;
  await db.doc(`contentAccess/${uid}_${filmId}`).set({ paymentRef: ref, uid, filmId });
  await db.doc('contentEntitlements/' + ref).set({ buyerUid: uid, contentId: filmId, status, expiresAtMs: null });
  return ref;
}

(async () => {
  quiet('\n── server: PREVIEW vs ENTITLED ──');
  await film('F30');
  ck('unauthenticated → refused, nothing signed', (await out(op('playback.preview', null, { filmId: 'F30' }))).err === 'unauthenticated' && signed.length === 0);
  let n0 = signed.length;
  const g = await op('playback.preview', 'v1', { filmId: 'F30' });
  ck('non-entitled viewer gets a PREVIEW grant with limit 30', g.mode === 'PREVIEW' && g.limitSec === 30 && g.remainingSec === 30 && g.resumeAtSec === 0);
  ck('…the URL is the PREVIEW rendition, never the master', /creator-previews/.test(signed[signed.length - 1].path) && mastersSignedFor(n0).length === 0);
  ck('…URL expiry bounded by the allowance (30 s + slack)', g.urlExpiresAtMs <= NOW + 30000 + P.PREVIEW.URL_SLACK_MS);
  const a = await out(op('playback.authorize', 'v1', { filmId: 'F30', deviceId: 'dev-v1' }));
  ck('non-entitled viewer asking for full playback → refused, master NOT signed', a.err === 'permission-denied' && mastersSignedFor(n0).length === 0, a.msg);
  ck('anonymous (guest) viewer: preview only, master never signed', (await op('playback.preview', 'anon1', { filmId: 'F30' }, { firebase: { sign_in_provider: 'anonymous' } })).mode === 'PREVIEW'
    && (await out(op('playback.authorize', 'anon1', { filmId: 'F30', deviceId: 'd' }))).err === 'permission-denied' && mastersSignedFor(n0).length === 0);

  quiet('\n── server: the allowance survives reloads ──');
  await op('playback.previewProgress', 'v1', { filmId: 'F30', positionSec: 12 });
  const g2 = await op('playback.preview', 'v1', { filmId: 'F30' });
  ck('reload resumes at 12 s with 18 s left — not reset', g2.resumeAtSec === 12 && g2.remainingSec === 18, g2);
  await op('playback.previewProgress', 'v1', { filmId: 'F30', positionSec: 5 });
  ck('a smaller reported position cannot give time back (monotonic)', (await db.doc('creatorPreviewGrants/v1_F30').get()).data().consumedSec === 12);
  const pr = await op('playback.previewProgress', 'v1', { filmId: 'F30', positionSec: 999 });
  ck('a position past the limit is clamped to 30 and exhausts the preview', pr.consumedSec === 30 && pr.exhausted === true, pr);
  ck('after the limit: preview refused (preview_used), nothing signed', /preview_used/.test((await out(op('playback.preview', 'v1', { filmId: 'F30' }))).msg) && signed.length === n0 + 3);
  await db.doc('creatorPreviewGrants/v1_F30').update({ consumedSec: 0, exhausted: false }).catch(() => {});
  /* the viewer cannot do that (rules test), and even the grant counter still binds: */
  for (let i = 0; i < 6; i++) await out(op('playback.preview', 'v1', { filmId: 'F30' }));
  ck(`grant cap: more than ${P.PREVIEW.MAX_GRANTS} preview URLs in one window refused`, /preview_used/.test((await out(op('playback.preview', 'v1', { filmId: 'F30' }))).msg));
  await op('playback.preview', 'v2', { filmId: 'F30' });
  NOW += P.PREVIEW.WINDOW_MS + 1000;
  ck('wall-clock window: after it closes the preview cannot restart', /preview_used/.test((await out(op('playback.preview', 'v2', { filmId: 'F30' }))).msg));

  quiet('\n── server: 60-second preview ──');
  await film('F60', { previewSeconds: 60 });
  const s60 = await op('playback.preview', 'v3', { filmId: 'F60' });
  ck('60 s preview: limit 60', s60.limitSec === 60 && s60.remainingSec === 60);
  const p59 = await op('playback.previewProgress', 'v3', { filmId: 'F60', positionSec: 59 });
  ck('at 59 s the preview is still open', p59.exhausted === false && (await op('playback.preview', 'v3', { filmId: 'F60' })).remainingSec === 1);
  ck('at 60 s it stops', (await op('playback.previewProgress', 'v3', { filmId: 'F60', positionSec: 60 })).exhausted === true
    && /preview_used/.test((await out(op('playback.preview', 'v3', { filmId: 'F60' }))).msg));

  quiet('\n── server: two tabs ──');
  await film('FTAB');
  const tabs = await Promise.all([op('playback.preview', 'v4', { filmId: 'FTAB' }), op('playback.preview', 'v4', { filmId: 'FTAB' })]);
  const gt = (await db.doc('creatorPreviewGrants/v4_FTAB').get()).data();
  ck('two tabs share ONE allowance (one ledger, two grants counted)', tabs.every((t) => t.mode === 'PREVIEW') && gt.grants === 2 && gt.limitSec === 30, gt);

  quiet('\n── server: entitled viewers are not limited ──');
  await entitle('b1', 'F30');
  n0 = signed.length;
  ck('entitled viewer asking for a preview is told ENTITLED (no preview URL)', (await op('playback.preview', 'b1', { filmId: 'F30' })).mode === 'ENTITLED' && signed.length === n0);
  const full = await op('playback.authorize', 'b1', { filmId: 'F30', deviceId: 'dev-b1' });
  ck('entitled viewer gets the FULL film (master), no preview limit', /creator-masters/.test(signed[signed.length - 1].path) && !('limitSec' in full), full.url);
  await db.doc('contentEntitlements/pay_b1_F30').update({ status: 'REVOKED' });
  ck('revoked entitlement → full playback refused', (await out(op('playback.authorize', 'b1', { filmId: 'F30', deviceId: 'dev-b1' }))).err === 'permission-denied');
  ck('…and the running session is ended on its next heartbeat', (await op('playback.heartbeat', 'b1', { sessionId: full.sessionId })).revoked === true);

  quiet('\n── server: malformed previewSeconds fails safe ──');
  for (const [v, label] of [[0, '0'], [-5, 'negative'], [1e9, 'huge'], [2.5, 'fractional'], ['abc', 'text'], [601, 'over 600'], [null, 'null']]) {
    const id = 'FBAD' + label.replace(/\W/g, '');
    await film(id, { previewSeconds: v });
    const n1 = signed.length;
    const r = await out(op('playback.preview', 'v5', { filmId: id }));
    ck(`previewSeconds ${label} → no preview (entitlement required), nothing signed`, /preview_unavailable/.test(r.msg || '') && signed.length === n1, r.msg);
  }
  await film('FNOFILE', { previewReady: false });
  await db.doc('creatorMedia/FNOFILE').set({ filmId: 'FNOFILE', storagePath: 'creator-masters/cA/FNOFILE/m1' });
  const nf = await out(op('playback.preview', 'v5', { filmId: 'FNOFILE' }));
  ck('previewSeconds set but NO preview file → refused; the master is never used as a preview', /preview_unavailable/.test(nf.msg || '') && mastersSignedFor(0).every((s) => !/FNOFILE/.test(s.path)));
  const cat = await OPS['catalog.get']({ ...who('v5'), data: { filmId: 'FNOFILE' } });
  ck('catalog does not advertise a preview it cannot serve', cat.film.previewAvailable === false);
  ck('catalog advertises the real one', (await OPS['catalog.get']({ ...who('v5'), data: { filmId: 'F30' } })).film.previewAvailable === true);
  await film('FDRAFT', { pubState: 'DRAFT', status: 'draft' });
  ck('an unpublished film has no preview', /film_unavailable/.test((await out(op('playback.preview', 'v5', { filmId: 'FDRAFT' }))).msg || ''));

  quiet('\n── server: flags are server-owned ──');
  const forged = P.sanitizeFilmInput;
  let refused = '';
  try { forged({ title: 'X', previewReady: true }, { uid: 'cA', partial: true }); } catch (e) { refused = e.message; }
  ck('a creator cannot set previewReady (must be verified by the server)', /server-owned/.test(refused), refused);

  quiet('\n── guard: simulated media element ──');
  function fakeMedia() {
    const h = {}; const m = { currentTime: 0, paused: true, pauses: 0,
      addEventListener: (e, f) => { (h[e] = h[e] || []).push(f); }, removeEventListener: (e, f) => { h[e] = (h[e] || []).filter((x) => x !== f); },
      emit: (e) => (h[e] || []).forEach((f) => f()), pause() { this.paused = true; this.pauses++; }, play() { this.paused = false; this.emit('play'); } };
    return m;
  }
  for (const limit of [30, 60]) {
    const m = fakeMedia(); let hits = 0;
    P.attachPreviewGuard(m, limit, () => { hits++; });
    m.play();
    for (let t = 0; t <= limit + 5; t += 0.25) { if (m.paused) break; m.currentTime = t; m.emit('timeupdate'); }
    ck(`${limit} s preview stops at ${limit} (paused, position ≤ ${limit})`, m.paused && m.currentTime <= limit && m.currentTime >= limit - 0.5 && hits === 1, m.currentTime);
    m.currentTime = limit + 20; m.emit('seeking');
    ck(`${limit} s: seek past the boundary is refused`, m.currentTime <= limit && m.paused);
    m.play();
    ck(`${limit} s: play after the limit is refused (pause/play cannot bypass)`, m.paused && hits === 1);
  }
  const m2 = fakeMedia(); P.attachPreviewGuard(m2, 30, () => {});
  m2.play(); m2.currentTime = 10; m2.emit('timeupdate'); m2.currentTime = 45; m2.emit('seeking');
  ck('seek from 10 s to 45 s lands back at ≤ 10 s, stopped', m2.currentTime <= 10 && m2.paused, m2.currentTime);
  const m3 = fakeMedia(); P.attachPreviewGuard(m3, 30, () => {});
  m3.play(); m3.currentTime = 10; m3.emit('timeupdate'); m3.pause(); m3.play(); m3.currentTime = 20; m3.emit('timeupdate');
  ck('pause/play inside the preview is allowed (the boundary, not playback, is limited)', !m3.paused && m3.currentTime === 20);

  quiet('\n── page wiring ──');
  const page = fs.readFileSync(Path.join(ROOT, 'creator.html'), 'utf8');
  ck('creator.html plays previews through playback.preview + the shared guard', /cd\('playback\.preview'/.test(page) && /attachPreviewGuard\(pv, g\.limitSec/.test(page) && /playback\.previewProgress/.test(page));
  ck('the preview player never calls playback.authorize for a non-entitled viewer', /if \(g\.mode === 'ENTITLED'\) return watch\(/.test(page));
  ck('sokoni-creator-rules.js (served copy) == functions/shared/creator-publishing.js', fs.readFileSync(Path.join(ROOT, 'sokoni-creator-rules.js'), 'utf8') === fs.readFileSync(Path.join(FN, 'shared', 'creator-publishing.js'), 'utf8'));

  quiet('\n── browser: real <video> in Chromium ──');
  let chromium;
  try { ({ chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'))); } catch (e) { ck('playwright available', false, e.message); }
  if (chromium) {
    const browser = await chromium.launch();
    try {
      const pg = await browser.newPage();
      await pg.setContent('<html><body><video id="v" muted playsinline></video></body></html>');
      await pg.addScriptTag({ content: fs.readFileSync(Path.join(ROOT, 'sokoni-creator-rules.js'), 'utf8') });
      const r = await pg.evaluate(async () => {
        /* record ~4 s of real webm from a canvas — no network, no fixture file */
        const c = document.createElement('canvas'); c.width = 64; c.height = 48; const x = c.getContext('2d');
        const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' });
        const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
        let k = 0; const draw = setInterval(() => { x.fillStyle = `hsl(${(k++ * 12) % 360},80%,50%)`; x.fillRect(0, 0, 64, 48); }, 40);
        rec.start(); await new Promise((res) => setTimeout(res, 4000)); rec.stop(); clearInterval(draw);
        await new Promise((res) => { rec.onstop = res; });
        const v = document.getElementById('v');
        v.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
        await new Promise((res) => { v.onloadeddata = res; v.load(); });
        let limitHit = 0;
        window.SokoniCreatorRules.attachPreviewGuard(v, 1.5, () => { limitHit++; });
        await v.play();
        await new Promise((res) => setTimeout(res, 3200));
        const stoppedAt = v.currentTime, pausedAfter = v.paused;
        v.currentTime = 3.5; await new Promise((res) => setTimeout(res, 400));
        const afterSeek = v.currentTime;
        await v.play().catch(() => {}); await new Promise((res) => setTimeout(res, 800));
        return { stoppedAt, pausedAfter, afterSeek, afterReplay: v.currentTime, pausedFinal: v.paused, limitHit };
      });
      ck('real video: playback stops at the 1.5 s boundary', r.pausedAfter && r.stoppedAt <= 1.5 + 0.35 && r.stoppedAt >= 1.0, r);
      ck('real video: seeking to 3.5 s is pulled back inside the preview', r.afterSeek <= 1.5 + 0.05, r.afterSeek);
      ck('real video: play() after the limit stays stopped', r.pausedFinal && r.afterReplay <= 1.5 + 0.05 && r.limitHit === 1, r);
    } catch (e) { ck('browser run completed', false, e.message); }
    finally { await browser.close(); }
  }

  quiet('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { quiet('HARNESS CRASHED', e && e.stack); process.exit(2); });
