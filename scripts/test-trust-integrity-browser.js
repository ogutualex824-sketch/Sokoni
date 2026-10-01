/* test-trust-integrity-browser.js — the REPORT part of 80a201b's browser cert, ported for community C2 (2026-10-01).
 * QUEUED — not yet run (browser hold). Run after RESUME:
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-trust-integrity-browser.js
 *
 * Ported: TB4 (a signed-in buyer's report reaches the server with product context, no login bounce), now through the
 * wizard. NOT ported: TB1–TB3 (reviews / invented-claims — owned by another session). The wizard's own geometry and
 * keyboard proof is scripts/test-report-wizard-browser.js.
 *
 * PROVES
 *   TB4 a signed-in buyer's report (product page → wizard → tsReportContent) is on the server with the product context;
 *       the page did not bounce the buyer to login, and said "received" only after the server accepted it
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-trust-integrity-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path'), Module = require('module');
const ROOT = Path.resolve(__dirname, '..');
const FN_DIR = process.env.SOKONI_FUNCTIONS_DIR ? Path.resolve(process.env.SOKONI_FUNCTIONS_DIR) : Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log;
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};
const TS = require(Path.join(FN_DIR, 'trust-safety.js'));
if (typeof TS.tsGetReportReasons !== 'function') { say('BLOCKED — no report authority in ' + FN_DIR); process.exit(2); }
console.log = console.info = console.warn = console.error = console.debug = () => {};
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  await db.doc('users/sellT').set({ name: 'Duka' });
  await db.doc('products/pT').set({ name: 'Kitenge Dress', price: 2500, sellerUid: 'sellT', sellerName: 'Duka', status: 'active', isVisible: true, stock: 3, images: [] });
  const H = makePageHarness({ db, root: ROOT, callables: { tsGetReportReasons: TS.tsGetReportReasons, tsReportContent: TS.tsReportContent } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 12000 };
  try {
    const b = await H.page(browser, { user: { uid: 'buyT', email: 'b@x.co', emailVerified: true }, viewport: { width: 390, height: 900 } });
    await b.goto(H.BASE + '/product.html?id=pT');
    let flowErr = null;
    try {
      await b.waitForSelector('#reportListingBtn', { state: 'visible', timeout: 15000 });
      await b.click('#reportListingBtn', T);
      await b.check('[role="dialog"] input[value="misleading"]', T);
      await b.click('text=Next', T); await b.fill('#srwDetail', 'Photos show a different colour.', T);
      await b.click('text=Next', T); await b.click('text=Submit report', T);
      await b.waitForFunction(() => /SOKONI has your report/.test(document.body.innerText), null, T);
    } catch (e) { flowErr = String(e && e.message).slice(0, 160); }
    const reps = (await db.collection('reports').get()).docs.map((d) => d.data());
    ck('TB4 a signed-in buyer\'s report reaches the server with product context (no login bounce)', !flowErr && reps.length === 1 && reps[0].entityType === 'product'
      && reps[0].entityId === 'pT' && reps[0].reasonCode === 'misleading' && reps[0].context && reps[0].context.productName === 'Kitenge Dress' && !/login/.test(b.url()),
      { flowErr, n: reps.length, url: b.url() });
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
