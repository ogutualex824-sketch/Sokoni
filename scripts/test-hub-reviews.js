/* test-hub-reviews.js — the hub review stores (CHANGELOG 213): a client may REQUEST a review, never decide who wrote
 * it, who it is about, whether the experience happened, the aggregate, verification or moderation.
 * Real modules on the transactional fake Firestore; the REAL pages in Chromium. No network, no production.
 *
 * PROVES
 *   health       the PATIENT can no longer mark their appointment completed (only the provider / admin); a rating
 *                binds to the appointment's provider (a forged providerId is refused); integer 1–5 ("5" is 5,
 *                4.5 / 0 / 6 / "abc" refused); once per appointment, also under concurrency; no self-rating;
 *                the aggregate is sum/count (a legacy {rating, ratingCount} doc is carried over exactly)
 *   legal        the same for consultations (client cannot complete; forged provider refused; once; integer)
 *   digital      a product rating needs a PAID purchase (pending_payment refused); the purchase's product (a
 *                forged productId refused); not your own product; once
 *   unboxing     "Verified Buy" is the server's: your own delivered order only; one order → one review
 *   browser      unboxing.html: no invented demo reviews on the live wall; a posted review appears only after it is
 *                SAVED, carries no client "verified"; a real delivered order → "Verified Buy" from the server.
 *                sports-venue.html / home-services.html: an honest "not open yet", nothing stored or posted
 *
 *   node scripts/test-hub-reviews.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-hub-reviews';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const ROLES = { admin9: 4 };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: { role: ROLES[u] || 0 } }) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const HC = require(Path.join(FN, 'healthcare-hub.js'));
const LG = require(Path.join(FN, 'legal-hub.js'));
const DG = require(Path.join(FN, 'digital-hub.js'));
const RV = require(Path.join(FN, 'reviews.js'));
const { makePageHarness } = require('./lib/page-harness.js');
/* admin9 is a platform admin through the CANONICAL claim (admin-claim.js) — the numeric role >= 4 is minted by nothing (CHANGELOG 222). */
const run = (fnOrCall, uid, data) => (fnOrCall.run || fnOrCall)({ auth: uid ? { uid, token: uid === 'admin9' ? { admin: true } : {} } : null, data: data || {}, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

(async () => {
  /* ═══ health ═══ */
  say('\n── healthcare ──');
  await db.doc('healthProviders/doc1').set({ name: 'Dr A', rating: 4, ratingCount: 2 });      /* legacy: no ratingSum */
  await db.doc('healthProviders/doc2').set({ name: 'Dr B' });
  await db.doc('healthProviders/doc3').set({ name: 'Dr C', rating: 3.33, ratingCount: 3, ratingSum: 10 });   /* its rounded average loses information */
  const appt = (id, over) => db.doc('healthAppointments/' + id).set(Object.assign({ patientUid: 'p1', providerId: 'doc1', status: 'confirmed' }, over || {}));
  await appt('a1'); await appt('a2', { status: 'completed' }); await appt('a3', { status: 'completed' }); await appt('a4', { status: 'completed', patientUid: 'doc2', providerId: 'doc2' });
  const upd = HC.updateAppointmentStatus;   /* module.exports is rebound at the end of healthcare-hub.js, so _h is not exported */
  ck('the PATIENT can no longer mark their own appointment completed', (await code(run(upd, 'p1', { appointmentId: 'a1', status: 'completed' }))) === 'permission-denied' && (await get('healthAppointments/a1')).status === 'confirmed');
  ck('…nor record a no-show or confirm it', (await code(run(upd, 'p1', { appointmentId: 'a1', status: 'no_show' }))) === 'permission-denied' && (await code(run(upd, 'p1', { appointmentId: 'a1', status: 'confirmed' }))) === 'permission-denied');
  ck('…the patient may still cancel; the provider completes', (await run(upd, 'doc1', { appointmentId: 'a1', status: 'completed' })).ok === true && (await get('healthAppointments/a1')).status === 'completed');
  ck('an admin (canonical admin claim) may complete', (await run(upd, 'admin9', { appointmentId: 'a3', status: 'completed' })).ok === true);
  const rate = HC.rateHealthProvider;
  ck('a forged providerId is refused (one appointment cannot rate ANY provider)', (await code(run(rate, 'p1', { appointmentId: 'a2', providerId: 'doc2', rating: 1 }))) === 'permission-denied' && (await get('healthProviders/doc2')).ratingCount === undefined);
  for (const bad of [4.5, 0, 6, 'abc', '5.5', null]) ck(`rating ${JSON.stringify(bad)} is refused`, (await code(run(rate, 'p1', { appointmentId: 'a2', rating: bad }))) === 'invalid-argument');
  ck('a string "5" is the NUMBER 5 (it used to string-concatenate into the average)', (await run(rate, 'p1', { appointmentId: 'a2', rating: '5' })).ok === true);
  await appt('a6', { status: 'completed', providerId: 'doc3' });
  await run(rate, 'p1', { appointmentId: 'a6', rating: 5 });
  const d3 = await get('healthProviders/doc3');
  ck('the SUM is kept exactly — never re-derived from a rounded average (10 + 5 = 15, not 3.33 × 3 + 5 = 14.99)', d3.ratingSum === 15 && d3.ratingCount === 4 && d3.rating === 3.75, d3);
  const d1 = await get('healthProviders/doc1');
  ck('aggregate = sum / count, the legacy {4.0 × 2} carried over exactly: (8 + 5) / 3 = 4.33', d1.ratingCount === 3 && d1.ratingSum === 13 && d1.rating === 4.33, d1);
  ck('a second rating of the same appointment is refused', (await code(run(rate, 'p1', { appointmentId: 'a2', rating: 1 }))) === 'already-exists' && (await get('healthProviders/doc1')).ratingCount === 3);
  const both = await Promise.all([run(rate, 'p1', { appointmentId: 'a1', rating: 4 }).then(() => 'ok').catch((e) => e.code), run(rate, 'p1', { appointmentId: 'a1', rating: 4 }).then(() => 'ok').catch((e) => e.code)]);
  ck('two CONCURRENT ratings of one appointment → exactly one counted', both.filter((x) => x === 'ok').length === 1 && (await get('healthProviders/doc1')).ratingCount === 4, both);
  ck('someone else\'s appointment cannot be rated', (await code(run(rate, 'p2', { appointmentId: 'a3', rating: 5 }))) === 'permission-denied');
  ck('a provider cannot rate themselves', (await code(run(rate, 'doc2', { appointmentId: 'a4', rating: 5 }))) === 'permission-denied');
  await appt('a5');
  ck('an appointment the provider has not completed cannot be rated', (await code(run(rate, 'p1', { appointmentId: 'a5', rating: 5 }))) === 'failed-precondition');

  /* ═══ legal ═══ */
  say('\n── legal ──');
  await db.doc('legalProviders/law1').set({ name: 'Adv A' });
  await db.doc('legalProviders/law2').set({ name: 'Adv B' });
  await db.doc('legalConsultations/c1').set({ clientUid: 'cl1', providerId: 'law1', status: 'confirmed' });
  ck('the CLIENT can no longer mark the consultation completed', (await code(run(LG.updateConsultationStatus, 'cl1', { consultationId: 'c1', status: 'completed' }))) === 'permission-denied');
  ck('…the lawyer completes it', (await run(LG.updateConsultationStatus, 'law1', { consultationId: 'c1', status: 'completed' })).ok === true);
  ck('a forged providerId is refused', (await code(run(LG.rateLegalProvider, 'cl1', { consultationId: 'c1', providerId: 'law2', rating: 5 }))) === 'permission-denied');
  ck('a fractional rating is refused', (await code(run(LG.rateLegalProvider, 'cl1', { consultationId: 'c1', rating: 4.5 }))) === 'invalid-argument');
  ck('the client rates the consultation\'s own lawyer (no providerId needed)', (await run(LG.rateLegalProvider, 'cl1', { consultationId: 'c1', rating: 4 })).ok === true && (await get('legalProviders/law1')).ratingSum === 4 && (await get('legalProviders/law1')).ratingCount === 1);
  ck('…once', (await code(run(LG.rateLegalProvider, 'cl1', { consultationId: 'c1', rating: 1 }))) === 'already-exists');

  /* ═══ digital products ═══ */
  say('\n── digital products ──');
  await db.doc('digitalProducts/dp1').set({ sellerUid: 's1', title: 'Ebook', rating: 0, ratingCount: 0 });
  await db.doc('digitalProducts/dp2').set({ sellerUid: 's2', title: 'Course' });
  await db.doc('digitalPurchases/pu1').set({ buyerUid: 'b1', productId: 'dp1', status: 'pending_payment' });
  await db.doc('digitalPurchases/pu2').set({ buyerUid: 'b1', productId: 'dp1', status: 'completed' });
  await db.doc('digitalPurchases/pu3').set({ buyerUid: 's1', productId: 'dp1', status: 'completed' });
  ck('an UNPAID purchase cannot rate', (await code(run(DG.rateDigitalProduct, 'b1', { purchaseId: 'pu1', rating: 5 }))) === 'failed-precondition');
  ck('a paid purchase cannot rate a DIFFERENT product', (await code(run(DG.rateDigitalProduct, 'b1', { purchaseId: 'pu2', productId: 'dp2', rating: 5 }))) === 'permission-denied' && (await get('digitalProducts/dp2')).ratingCount === undefined);
  ck('the seller cannot rate their own product', (await code(run(DG.rateDigitalProduct, 's1', { purchaseId: 'pu3', rating: 5 }))) === 'permission-denied');
  ck('a paid purchase rates its own product once', (await run(DG.rateDigitalProduct, 'b1', { purchaseId: 'pu2', rating: 5 })).ok === true && (await get('digitalProducts/dp1')).ratingCount === 1 && (await code(run(DG.rateDigitalProduct, 'b1', { purchaseId: 'pu2', rating: 5 }))) === 'already-exists');

  /* ═══ unboxing verification ═══ */
  say('\n── unboxing: "Verified Buy" is the server\'s ──');
  const ver = RV._verifyUnboxingReview;
  await db.doc('orders/o1').set({ buyerUid: 'u1', status: 'delivered' });
  await db.doc('orders/o2').set({ buyerUid: 'u2', status: 'delivered' });
  await db.doc('orders/o3').set({ buyerUid: 'u1', status: 'processing' });
  const ub = (id, over) => db.doc('unboxingReviews/' + id).set(Object.assign({ uid: 'u1', rating: 5, product: 'X', orderId: 'o1' }, over || {}));
  await ub('r1'); await ub('r2', { orderId: 'o2' }); await ub('r3', { orderId: 'o3' }); await ub('r4', { orderId: 'o1' }); await ub('r5', { uid: 'u9', orderId: 'o1' });
  ck('someone else\'s order does not verify your review', (await code(run(ver, 'u1', { reviewId: 'r2' }))) === 'permission-denied' && (await get('unboxingReviews/r2')).orderVerified === undefined);
  ck('an undelivered order does not verify', (await code(run(ver, 'u1', { reviewId: 'r3' }))) === 'failed-precondition');
  ck('you cannot verify another person\'s review', (await code(run(ver, 'u1', { reviewId: 'r5' }))) === 'permission-denied');
  ck('your own delivered order → orderVerified (server-written)', (await run(ver, 'u1', { reviewId: 'r1' })).orderVerified === true && (await get('unboxingReviews/r1')).orderVerified === true);
  ck('one order verifies ONE review (a second review cannot reuse it)', (await code(run(ver, 'u1', { reviewId: 'r4' }))) === 'already-exists');

  /* ═══ browser ═══ */
  say('\n── browser ──');
  await db.doc('orders/o7').set({ buyerUid: 'w1', status: 'delivered' });
  const HAR = makePageHarness({ db, root: ROOT, callables: { verifyUnboxingReview: RV._verifyUnboxingReview } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    for (const vp of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
      const U = await HAR.page(browser, { user: { uid: 'w1', email: 'w1@x.co', emailVerified: true }, viewport: vp, storage: { loggedIn: 'true', sokoniUser: JSON.stringify({ uid: 'w1', name: 'Wanjiku' }) } });
      await U.addInitScript(() => { window.__writes = []; });
      await U.goto(HAR.BASE + '/unboxing.html');
      await U.waitForTimeout(1500);
      const t = await U.evaluate(() => document.body.innerText);
      ck(`${vp.width}: the live wall shows NO invented demo reviews (Brian K. / Grace M. / "StartUp CEO")`, !/Brian K\.|Grace M\.|StartUp CEO|Samsung Galaxy A55/.test(t) && await U.evaluate(() => !document.querySelector('.ub-verified-badge')));
      ck(`${vp.width}: no horizontal scroll`, await noOverflow(U));
      await U.__ctx.close();
    }
    /* posting: the page's SokoniDB is the module; the write is intercepted at the SDK shim (writes denied), so post
       through a stand-in that records the exact payload and returns the id, then let the REAL page call the server. */
    const P = await HAR.page(browser, { user: { uid: 'w1', email: 'w1@x.co', emailVerified: true }, viewport: { width: 390, height: 844 }, storage: { loggedIn: 'true', sokoniUser: JSON.stringify({ uid: 'w1', name: 'Wanjiku' }) } });
    await P.goto(HAR.BASE + '/unboxing.html');
    await P.waitForFunction(() => window.SokoniDB && typeof window.submitReview === 'function', null, { timeout: 10000 }).catch(() => {});
    const posted = await P.evaluate(async () => {
      const payloads = [];
      window.SokoniDB.saveUnboxingReview = async (r) => { payloads.push(JSON.parse(JSON.stringify(r))); return 'rvw1'; };
      openUpload && openUpload();
      document.querySelectorAll('.ub-star-btn')[4] && document.querySelectorAll('.ub-star-btn')[4].click();
      const cat = document.querySelector('.ub-cat-btn'); if (cat) cat.click();
      document.getElementById('ubProduct').value = 'Blender'; document.getElementById('ubComment').value = 'Arrived sealed and works well';
      document.getElementById('ubOrderId').value = 'o7';
      submitReview();
      await new Promise((r) => setTimeout(r, 1500));
      return { payloads, badge: !!document.querySelector('.ub-verified-badge') };
    });
    ck('the review payload carries NO client "verified" flag (the server decides)', posted.payloads.length === 1 && !('verified' in posted.payloads[0]) && !('orderVerified' in posted.payloads[0]), posted.payloads[0]);
    await db.doc('unboxingReviews/rvw1').set({ uid: 'w1', rating: 5, orderId: 'o7' });   /* what the save wrote */
    const again = await P.evaluate(async () => { try { return (await window.sokoniCallable('verifyUnboxingReview')({ reviewId: 'rvw1' })).data; } catch (e) { return { err: e.code }; } });
    ck('a real delivered order of the author\'s → the SERVER marks it "Verified Buy"', (await get('unboxingReviews/rvw1')).orderVerified === true && again.orderVerified === true, again);

    for (const [page, sel, rx] of [['/sports-venue.html', null, /Reviews open after a completed SOKONI booking/], ['/home-services.html', null, /Reviews open after a completed SOKONI booking/]]) {
      const S = await HAR.page(browser, { user: { uid: 'w2', email: 'w2@x.co', emailVerified: true }, viewport: { width: 360, height: 780 }, storage: { loggedIn: 'true', sokoniUser: JSON.stringify({ uid: 'w2', name: 'W' }) } });
      await S.goto(HAR.BASE + page);
      await S.waitForTimeout(1200);
      const out = await S.evaluate(async () => {
        const toasts = []; window._skToast = (m) => toasts.push(m); const a = window.alert; window.alert = (m) => toasts.push(m);
        const before = JSON.stringify(Object.keys(localStorage).filter((k) => /spt_rv_|hsReviews/.test(k)).map((k) => [k, localStorage.getItem(k)]));
        try {
          if (document.getElementById('rvName')) { document.getElementById('rvName').value = 'W'; document.getElementById('rvBody').value = 'Great place'; }
          if (typeof setReviewStar === 'function') setReviewStar(5);
          await submitReview();
        } catch (e) { toasts.push('ERR ' + e.message); }
        const after = JSON.stringify(Object.keys(localStorage).filter((k) => /spt_rv_|hsReviews/.test(k)).map((k) => [k, localStorage.getItem(k)]));
        const msg = (document.getElementById('hsReviewMsg') || {}).textContent || '';
        window.alert = a;
        return { toasts, msg, same: before === after };
      });
      ck(`${page}: an honest "not open yet" — nothing stored locally, nothing claimed as posted`, (out.toasts.some((m) => rx.test(m)) || rx.test(out.msg)) && out.same && !out.toasts.some((m) => /Thank you/.test(m)) && !/Thank you/.test(out.msg), out);
      await S.__ctx.close();
    }
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
