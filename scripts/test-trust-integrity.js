#!/usr/bin/env node
/* test-trust-integrity.js — product trust integrity T1 (2026-09-29): no invented social proof, verified-purchase product
 * reviews that actually work, and product reports that reach AdminOS.
 *
 *   node scripts/test-trust-integrity.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-trust-integrity.js  # @ 7d469f9 — failures ARE the defects
 *
 * REAL functions/reviews.js (submitReview · getReviews) and functions/trust-safety.js (tsReportContent · tsGetReports ·
 * tsReviewReport) on the transactional fake Firestore; the page fixes are asserted on the served sources.
 *
 * PROVES
 *   RV1 a non-buyer cannot review a product (NOT_A_VERIFIED_BUYER)
 *   RV2 an order that is not delivered, or that holds a DIFFERENT product, does not qualify
 *   RV3 the product's own seller cannot review it (SELF_REVIEW)
 *   RV4 a buyer whose delivered order holds the product can — found by the server, marked verifiedPurchase
 *   RV5 the review is read back under the SAME key the widget asks for (raw product id + targetType product)
 *   RV6 the widget calls signed-in callables and reads with targetType; product.html passes the raw id
 *   FK1 product.js renders no hard-coded reviews and no fixed trust claims
 *   FK2 KEBS is labelled "declared by seller", never "CERTIFIED", on the page and the card
 *   RP1 a report needs a signed-in reporter, a known type and a listed reason; a missing product is refused
 *   RP2 a seller cannot report their own product; the same reporter cannot file twice while pending
 *   RP3 the server captures the product context (name, seller, price, state)
 *   RP4 AdminOS lists it (admin only — a reporter / seller cannot read the queue)
 *   RP5 an admin "take down" hides the product (isVisible:false + moderationHold) and audits it; a seller cannot
 *       review a report; an unknown action is refused
 *   RP6 the page sends reports to tsReportContent (not the unread `flags`), checks sign-in on its own app, and never
 *       claims a report was sent when it was not
 *   AD1 AdminOS shows the reported entity (entityId + context) and sends only actions the server accepts
 *   MD1 moderation.html puts no report data inside onclick script, escapes ', and bans only on a USER report
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF, BASE = '7d469f9';
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };
let tmp = null;
const show = (rel) => cp.execFileSync('git', ['show', BASE + ':' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
function load(rel) {
  if (!CPM) return require(path.join(FN, rel));
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'trustint-'));
  const out = path.join(tmp, rel.replace(/\//g, '__'));
  fs.writeFileSync(out, show('functions/' + rel));
  return require(out);
}
const src = (rel) => (CPM ? show(rel) : fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h };
  if (tmp && this.filename && this.filename.startsWith(tmp) && id.startsWith('./')) return origReq.call(this, path.join(FN, id));
  return origReq.apply(this, arguments);
};
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: (e.details && e.details.code) || e.code || e.message }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });

(async () => {
  say('\nSOURCE: ' + (CPM ? `@ ${BASE} — failures below ARE the defects` : 'working tree (fix)'));
  const RV = load('reviews.js');
  const TS = load('trust-safety.js');
  const SELLER = 'sellerR', BUYER = 'buyerR', OTHER = 'otherR';
  const old = { createdAt: F.Timestamp.fromMillis(Date.now() - 90 * 86400000) };
  for (const u of [SELLER, BUYER, OTHER, 'buyerP', 'strangerR']) await db.doc('users/' + u).set(Object.assign({ name: u }, old));
  await db.doc('products/pR').set({ name: 'Kitenge Dress', sellerUid: SELLER, price: 2500, status: 'active', isVisible: true });
  await db.doc('products/pX').set({ name: 'Other', sellerUid: SELLER, price: 100, status: 'active' });
  await db.doc('orders/o1').set({ buyerUid: BUYER, status: 'delivered', items: [{ productId: 'pR', qty: 1 }] });
  await db.doc('orders/o2').set({ buyerUid: 'buyerP', status: 'pending', items: [{ productId: 'pR' }] });
  await db.doc('orders/o3').set({ buyerUid: OTHER, status: 'delivered', items: [{ productId: 'pX' }] });
  const review = (uid, extra) => RV.submitReview(as(uid, Object.assign({ targetId: 'pR', targetType: 'product', rating: 5, body: 'Lovely fabric and great fit.' }, extra || {})));

  say('\n── reviews ──');
  ck('RV1 a non-buyer cannot review a product', await codeOf(review('strangerR')) === 'NOT_A_VERIFIED_BUYER');
  const rv2 = [await codeOf(review('buyerP')), await codeOf(review(OTHER)), await codeOf(review(OTHER, { orderId: 'o3' }))];
  ck('RV2 an undelivered order, or an order of a DIFFERENT product, does not qualify', rv2.every((c) => c === 'NOT_A_VERIFIED_BUYER'), rv2);
  ck('RV3 the product\'s own seller cannot review it', await codeOf(review(SELLER)) === 'SELF_REVIEW');
  const r4 = await tryv(review(BUYER));
  const stored = r4 && r4.reviewId ? await get('reviews/' + r4.reviewId) : null;
  ck('RV4 a buyer with a delivered order of it can — the server found the order and marked verified purchase', !!stored && stored.verifiedPurchase === true && stored.orderId === 'o1' && r4.status === 'approved', { r4, v: stored && stored.verifiedPurchase });
  const g = await tryv(RV.getReviews(as(null, { targetId: 'pR', targetType: 'product', limit: 5 })));
  ck('RV5 it is read back under the same key the widget asks for, with its verified flag', g && Array.isArray(g.reviews) && g.reviews.length === 1 && g.reviews[0].verifiedPurchase === true, g && (g.reviews || g.error));
  const sw = src('sokoni-reviews.js'), ph = src('product.html');
  ck('RV6 the widget uses signed-in callables and reads with targetType; product.html passes the raw id',
    /httpsCallable\(getFunctions\(app, "us-central1"\), name\)/.test(sw) && /targetId: this\.targetId,\s*\n\s*targetType: this\.targetType/.test(sw)
    && /new SokoniReviews\(productId, "product"/.test(ph) && !/new SokoniReviews\("product_" \+ productId/.test(ph));

  say('\n── invented content ──');
  const pj = src('product.js'), sj = src('script.js');
  ck('FK1 no hard-coded reviews, no fixed trust claims', !/— Alex/.test(pj) && !/— Brian/.test(pj) && !/<p>✔ Trusted Seller<\/p>/.test(pj) && !/<p>✔ Secure Payments<\/p>/.test(pj));
  ck('FK2 KEBS is "declared by seller", never "CERTIFIED"', !/>KEBS CERTIFIED</.test(pj) && /declared by seller/.test(pj) && !/kebs-certified/.test(sj) && /KEBS \(declared\)/.test(sj));

  say('\n── reports → AdminOS ──');
  const rep = (uid, data) => TS.tsReportContent(as(uid, Object.assign({ entityType: 'product', entityId: 'pR', reason: 'Counterfeit or suspicious product', detail: 'Looks fake' }, data || {})));
  const rp1 = [await codeOf(rep(null)), await codeOf(rep(BUYER, { entityType: 'planet' })), await codeOf(rep(BUYER, { reason: 'I just dislike it' })), await codeOf(rep(BUYER, { entityId: 'noSuch' }))];
  ck('RP1 sign-in, a known type, a listed reason, an existing product', rp1[0] === 'unauthenticated' && rp1[1] === 'invalid-argument' && rp1[2] === 'invalid-argument' && rp1[3] === 'not-found', rp1);
  const r1 = await tryv(rep(BUYER));
  const rp2 = [await codeOf(rep(SELLER)), await codeOf(rep(BUYER))];
  ck('RP2 a seller cannot report their own product; no duplicate while pending', rp2[0] === 'failed-precondition' && rp2[1] === 'already-exists', rp2);
  const rdoc = r1 && r1.reportId ? await get('reports/' + r1.reportId) : null;
  ck('RP3 the server captured the product context', !!rdoc && rdoc.context && rdoc.context.productName === 'Kitenge Dress' && rdoc.context.sellerUid === SELLER && rdoc.context.price === 2500 && rdoc.reportedBy === BUYER, rdoc && rdoc.context);
  const admin = { admin: true };
  const lst = await tryv(TS.tsGetReports(as('adm1', { status: 'pending' }, admin)));
  const lstBuyer = await codeOf(TS.tsGetReports(as(BUYER, { status: 'pending' })));
  ck('RP4 AdminOS lists it (admin only)', lst && Array.isArray(lst.reports) && lst.reports.some((x) => x.entityId === 'pR' && x.context) && !!lstBuyer, { n: lst && lst.reports && lst.reports.length, lstBuyer });
  const bySeller = await codeOf(TS.tsReviewReport(as(SELLER, { reportId: r1 && r1.reportId, action: 'dismiss' })));
  const badAct = await codeOf(TS.tsReviewReport(as('adm1', { reportId: r1 && r1.reportId, action: 'action' }, admin)));
  const done = await tryv(TS.tsReviewReport(as('adm1', { reportId: r1 && r1.reportId, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed' }, admin)));
  const p = await get('products/pR');
  const audit = (await db.collection('trustSafetyAudit').get()).docs.map((d) => d.data()).find((a) => a.reportId === (r1 && r1.reportId));
  ck('RP5 admin take-down hides the product and audits it; a seller cannot review; an unknown action is refused', !!bySeller && !!badAct && done && done.productHidden === true
    && p.isVisible === false && p.moderationHold && p.moderationHold.reportId === r1.reportId && !!audit && audit.productHidden === true, { bySeller, badAct, done, hold: p.moderationHold });
  const st = src('sokoni-trust.js');
  ck('RP6 the page reports through tsReportContent, checks sign-in on its own app, never fakes success',
    /'tsReportContent'\)\(payload\)/.test(st) && !/addDoc\(fs\.collection\(db, 'flags'\)/.test(st) && /SokoniReport\.submit\('product',pid/.test(ph)
    && !/var u = window\.firebaseAuth && window\.firebaseAuth\.currentUser;\n  if\(!u\)\{ \(window\._skToast\|\|alert\)\('Please sign in to report a listing\.'\)/.test(ph) && !/'Report submitted\. Thank you\.'/.test(ph));
  const aos = src('sokoni-aos.js');
  ck('AD1 AdminOS shows entityId + product context and sends only server actions', /c\.productName \|\| r\.entityId/.test(aos) && !/reviewReport\('\$\{r\.id\}','action'\)/.test(aos) && /'approve',true\)/.test(aos));
  const md = src('moderation.html');
  ck('MD1 moderation.html: no report data in onclick script, escapes \', ban only on a user report', !/onclick="reportAction\(/.test(md) && /replace\(\/'\/g,'&#39;'\)/.test(md) && /r\.type==='user' \? '<button class="mod-action-btn btn-ban"/.test(md));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
