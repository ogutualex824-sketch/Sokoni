#!/usr/bin/env node
/* test-trust-integrity.js — REPORT parts of 80a201b's suite, ported for community C2 (2026-10-01).
 *
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-trust-integrity.js
 *
 * Ported: RP1–RP6, AD1, MD1 (adapted: the server reason list is a CODE catalogue now, dedupe is one report per user
 * per entity on a deterministic id, the AdminOS queue is the shared sokoni-trust-queues.js).
 * NOT ported (another session owns them): RV1–RV6 (reviews.js / sokoni-reviews.js — sokoni-70) and FK1–FK2
 * (product.js / script.js invented-content hunks). A trust-safety.js without the report authority → BLOCKED (exit 2).
 *
 * PROVES
 *   RP1 a report needs a signed-in reporter, a known type and a listed reason CODE; a missing product is refused
 *   RP2 a seller cannot report their own product; the same reporter cannot file twice
 *   RP3 the server captures the product context (name, seller, shop, price, state)
 *   RP4 the admin queue lists it (admin only — a reporter / seller cannot read the queue)
 *   RP5 an admin take-down hides the product (isVisible:false + moderationHold) and audits it; a seller cannot decide;
 *       an unknown action ('action') is refused
 *   RP6 the client reports through tsReportContent (never `flags`), never fakes success, and has no client reason list
 *   AD1 AdminOS shows entityId-backed rows through the shared queue and sends only server actions
 *   MD1 moderation.html puts no report data inside onclick script, escapes ', and bans only on a USER report
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN_DIR = process.env.SOKONI_FUNCTIONS_DIR ? path.resolve(process.env.SOKONI_FUNCTIONS_DIR) : path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};
say('\nfunctions source: ' + FN_DIR);
let TS; try { TS = require(path.join(FN_DIR, 'trust-safety.js')); } catch (e) { say('BLOCKED — ' + e.message); process.exit(2); }
if (typeof TS.tsGetReportReasons !== 'function') { say('BLOCKED — no report authority in this trust-safety.js; set SOKONI_FUNCTIONS_DIR to the functions lineage.'); process.exit(2); }
console.log = console.info = console.warn = console.debug = () => {};
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });

(async () => {
  const SELLER = 'sellerR', BUYER = 'buyerR';
  await db.doc('products/pR').set({ name: 'Kitenge Dress', sellerUid: SELLER, shopId: 'shopR', price: 2500, status: 'active', isVisible: true });
  const rep = (uid, data) => TS.tsReportContent(as(uid, Object.assign({ entityType: 'product', entityId: 'pR', reasonCode: 'counterfeit', detail: 'Looks fake' }, data || {})));
  const rp1 = [await codeOf(rep(null)), await codeOf(rep(BUYER, { entityType: 'planet' })), await codeOf(rep(BUYER, { reasonCode: 'i_dislike_it' })), await codeOf(rep(BUYER, { entityId: 'noSuch' }))];
  ck('RP1 sign-in, a known type, a listed reason code, an existing product', rp1[0] === 'unauthenticated' && rp1[1] === 'invalid-argument' && rp1[2] === 'invalid-argument' && rp1[3] === 'not-found', rp1);
  const r1 = await tryv(rep(BUYER));
  const rp2 = [await codeOf(rep(SELLER)), await codeOf(rep(BUYER))];
  ck('RP2 a seller cannot report their own product; the same reporter cannot file twice', rp2[0] === 'failed-precondition' && rp2[1] === 'already-exists', rp2);
  const rdoc = r1 && r1.reportId ? await get('reports/' + r1.reportId) : null;
  ck('RP3 the server captured the product context', !!rdoc && rdoc.context && rdoc.context.productName === 'Kitenge Dress' && rdoc.context.sellerUid === SELLER
    && rdoc.context.shopId === 'shopR' && rdoc.context.price === 2500 && rdoc.context.isVisible === true && rdoc.reportedBy === BUYER, rdoc && rdoc.context);
  const admin = { admin: true };
  const lst = await tryv(TS.tsGetReports(as('adm1', { state: 'pending' }, admin)));
  const lstBuyer = await codeOf(TS.tsGetReports(as(BUYER, { status: 'pending' })));
  const lstSeller = await codeOf(TS.tsGetReports(as(SELLER, {})));
  ck('RP4 the admin queue lists it (admin only)', lst && Array.isArray(lst.reports) && lst.reports.some((x) => x.entityId === 'pR' && x.context && x.moderationState === 'pending')
    && lstBuyer === 'permission-denied' && lstSeller === 'permission-denied', { lstBuyer, lstSeller });
  const bySeller = await codeOf(TS.tsReviewReport(as(SELLER, { reportId: r1 && r1.reportId, action: 'dismiss' })));
  const badAct = await codeOf(TS.tsReviewReport(as('adm1', { reportId: r1 && r1.reportId, action: 'action' }, admin)));
  const done = await tryv(TS.tsReviewReport(as('adm1', { reportId: r1 && r1.reportId, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed' }, admin)));
  const p = await get('products/pR');
  const audit = (await db.collection('trustSafetyAudit').get()).docs.map((d) => d.data()).find((a) => a.reportId === (r1 && r1.reportId));
  ck('RP5 admin take-down hides the product and audits it; a seller cannot decide; "action" is refused', bySeller === 'permission-denied' && badAct === 'invalid-argument'
    && done && done.productHidden === true && p.isVisible === false && p.moderationHold && p.moderationHold.reportId === r1.reportId && !!audit && audit.productHidden === true,
    { bySeller, badAct, done });

  const st = src('sokoni-trust.js'), ph = src('product.html');
  const rpBlock = st.slice(st.indexOf('window.SokoniReport = {'), st.indexOf('window.SokoniOnboarding'));
  ck('RP6 the client reports through tsReportContent, never `flags`, never fakes success, no client reason list',
    /_reportCallable\('tsReportContent'\)/.test(rpBlock) && /_reportCallable\('tsGetReportReasons'\)/.test(rpBlock) && !/addDoc|'flags'/.test(rpBlock) && !/types:\s*\{/.test(rpBlock)
      && !/'Report submitted\. Thank you\.'/.test(ph) && !/<option>Counterfeit/.test(ph));
  const aos = src('sokoni-aos.js'), tq = src('sokoni-trust-queues.js');
  const vr = aos.slice(aos.indexOf('async function viewReports()'), aos.indexOf('async function investigateAlert('));
  ck('AD1 AdminOS mounts the shared queue (entityId + context rows) and sends only server actions',
    /_mountTrustQueue\(/.test(vr) && !/r\.targetId/.test(vr.replace(/\/\*[\s\S]*?\*\//g, '')) && /c\.productName \|\| r\.entityId/.test(tq)
      && !/'action'\)/.test(vr.replace(/\/\*[\s\S]*?\*\//g, '')) && Object.keys(require(path.join(ROOT, 'sokoni-trust-queues.js')).ACTION).every((a) => a === 'takedown' || a in TS._reportModel.REPORT_ACTIONS));
  const md = src('moderation.html');
  ck('MD1 moderation.html: no report data in onclick script, escapes \', ban only on a user report', !/onclick="reportAction\(/.test(md) && /replace\(\/'\/g,'&#39;'\)/.test(md) && /r\.type==='user' \? '<button class="mod-action-btn btn-ban"/.test(md));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
