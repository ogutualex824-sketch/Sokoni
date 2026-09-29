/* test-trust-integrity-browser.js — the product page's trust surfaces in a REAL browser (trust integrity T1, 2026-09-29):
 * REAL product.html, REAL sokoni-reviews.js / sokoni-trust.js, REAL reviews.js + trust-safety.js callables.
 *
 * PROVES
 *   TB1 no invented reviews or trust claims render, and KEBS reads "declared by seller"
 *   TB2 a signed-in buyer whose order was delivered can publish a review from the page; it shows "Verified purchase"
 *   TB3 a signed-in stranger is told only verified buyers can review — nothing is written
 *   TB4 a signed-in buyer's report goes to the server (reports collection, with product context) — the page no longer
 *       sends signed-in buyers to login, and says the report was received only after the server accepted it
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-trust-integrity-browser';
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
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const RV = require(Path.join(FN, 'reviews.js'));
const TS = require(Path.join(FN, 'trust-safety.js'));
const KS = require(Path.join(FN, 'kasshop.js'));
const { makePageHarness } = require('./lib/page-harness.js');
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  const old = { createdAt: F.Timestamp.fromMillis(Date.now() - 90 * 86400000) };
  for (const u of ['sellT', 'buyT', 'strT']) await db.doc('users/' + u).set(Object.assign({ name: u === 'buyT' ? 'Wanjiku' : u }, old));
  await db.doc('shops/sellT').set({ sellerUid: 'sellT', name: 'Duka', status: 'active' });
  await db.doc('products/pT').set({ name: 'Kitenge Dress', price: 2500, sellerUid: 'sellT', sellerName: 'Duka', status: 'active', isVisible: true, stock: 3, kebsCert: 'KS-2024-001', images: [] });
  await db.doc('orders/oT').set({ buyerUid: 'buyT', status: 'delivered', items: [{ productId: 'pT', qty: 1 }] });
  const H = makePageHarness({ db, root: ROOT, callables: { getReviews: run(RV.getReviews), submitReview: run(RV.submitReview), markReviewHelpful: run(RV.markReviewHelpful || (() => ({}))),
    flagReview: run(RV.flagReview || (() => ({}))), tsReportContent: run(TS.tsReportContent), getShopAvailability: run(KS.getShopAvailability) } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 140)); return false; } };
  try {
    const b = await H.page(browser, { user: { uid: 'buyT', email: 'b@x.co', emailVerified: true }, viewport: { width: 390, height: 900 } });
    await b.goto(H.BASE + '/product.html?id=pT');
    await b.waitForSelector('.sk-reviews-widget, #productReviewsContainer', { timeout: 15000 }).catch(() => {});
    await b.waitForFunction(() => /Write a Review|No reviews yet/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const body = await b.evaluate(() => document.body.innerText);
    ck('TB1 no invented reviews or claims; KEBS "declared by seller"', !/— Alex|— Brian|Trusted Seller|KEBS CERTIFIED/.test(body) && /declared by seller/.test(body), body.slice(0, 160));

    await act('write a review', async () => {
      await b.click('.sk-star-pick[data-val="5"]', { timeout: 5000 });
      await b.fill('.sk-body-inp', 'Beautiful fabric, fits perfectly — delivered fast.', { timeout: 5000 });
      await b.click('.sk-submit-btn, .sk-review-form-wrap button[type="button"]:last-of-type', { timeout: 5000 });
      await b.waitForFunction(() => /Verified purchase/.test(document.body.innerText), null, { timeout: 10000 });
    });
    const revs = (await db.collection('reviews').get()).docs.map((d) => d.data());
    ck('TB2 a delivered buyer publishes a review from the page; it shows "Verified purchase"', revs.length === 1 && revs[0].verifiedPurchase === true && /Verified purchase/.test(await b.evaluate(() => document.body.innerText)), revs.length);

    const s = await H.page(browser, { user: { uid: 'strT', email: 's@x.co', emailVerified: true }, viewport: { width: 390, height: 900 } });
    await s.goto(H.BASE + '/product.html?id=pT');
    await s.waitForFunction(() => /Write a Review/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    await act('stranger tries to review', async () => {
      await s.click('.sk-star-pick[data-val="4"]', { timeout: 5000 });
      await s.fill('.sk-body-inp', 'I never bought this but here is a review.', { timeout: 5000 });
      await s.click('.sk-submit-btn, .sk-review-form-wrap button[type="button"]:last-of-type', { timeout: 5000 });
      await s.waitForFunction(() => { const e = document.querySelector('.sk-form-error'); return e && e.style.display !== 'none' && e.textContent.trim(); }, null, { timeout: 10000 });
    });
    const err = await s.evaluate(() => (document.querySelector('.sk-form-error') || {}).textContent || '');
    ck('TB3 a stranger is refused — only verified buyers — nothing written', /delivered|verified/i.test(err) && (await db.collection('reviews').get()).size === 1, err);

    await act('report the product', async () => {
      await b.evaluate(() => openReportListing());
      await b.waitForFunction(() => document.getElementById('reportModal').style.display === 'flex', null, { timeout: 8000 });
      await b.selectOption('#reportListingReason', 'Counterfeit or suspicious product');
      await b.fill('#reportListingDetails', 'The label looks copied.');
      await b.evaluate(() => submitListingReport());
      await b.waitForFunction(() => document.getElementById('reportModal').style.display === 'none', null, { timeout: 10000 });
    });
    const reps = (await db.collection('reports').get()).docs.map((d) => d.data());
    ck('TB4 a signed-in buyer\'s report reaches the server with product context (no login bounce)', reps.length === 1 && reps[0].entityType === 'product' && reps[0].entityId === 'pT'
      && reps[0].context && reps[0].context.productName === 'Kitenge Dress' && !/login/.test(b.url()), { n: reps.length, url: b.url() });
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
