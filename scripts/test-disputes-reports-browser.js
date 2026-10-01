/* test-disputes-reports-browser.js — the REPORT half of ec40b9b's browser cert, ported for community C2 (2026-10-01).
 * QUEUED — not yet run (browser hold). Run after RESUME:
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-disputes-reports-browser.js
 *
 * The REAL shared report queue (sokoni-trust-queues.js — what AdminOS › Reports Queue and super-admin › Trust reports
 * mount, with the same callable adapter) and the REAL merchant-v2 Disputes module (its Reports tab), against the REAL
 * trust-safety.js handlers over the fake Firestore.
 * Ported: TB4, TB6, TB7. NOT ported: TB1–TB3 (disputes — ec40b9b's dispute ops are not on the live functions lineage),
 * TB5 (conversation reports — messagesDispatch, a separate store), TB8 (dispute.html).
 *
 * PROVES
 *   TB4 a product report is listed (Pending) and "Uphold + take product down" hides the product (server-verified)
 *   TB6 the drawer closes with Esc; no horizontal scroll at 390 px; filter chips and actions are ≥44 px
 *   TB7 merchant-v2 › Disputes › Reports: the seller sees "Listing taken down" and SOKONI's reason — never the reporter
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-disputes-reports-browser';
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
const as = (uid, data, claims) => ({ auth: { uid, token: Object.assign({ email_verified: true }, claims || {}) }, data, rawRequest: { headers: {} } });
const SHELL = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body>${body}</body></html>`;
const ADMIN_PAGE = SHELL(`<div id="host" style="padding:12px"></div><div id="toasts"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-trust-queues.js"></script>
<script>
  function start() {
    if (!firebase.auth().currentUser) return setTimeout(start, 50);
    /* the same adapter AdminOS (sokoni-aos.js _mountTrustQueue) and super admin (SA.loadTrustQueue) pass */
    window.__q = SokoniTrustQueues.mount(document.getElementById('host'), {
      callable: function (n) { return function (p) { return firebase.functions().httpsCallable(n)(p).then(function (r) { return r.data; }); }; },
      onToast: function (m) { var t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.getElementById('toasts').appendChild(t); } });
  }
  start();
</script>`);
const MERCHANT_PAGE = SHELL(`<div id="host" style="height:100vh;display:flex;flex-direction:column"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-merchant-disputes.js"></script>
<script src="/sokoni-merchant-disputes-ui.js"></script>
<script>
  function start() {
    var u = firebase.auth().currentUser; if (!u) return setTimeout(start, 50);
    var c = function (n) { return function (p) { return firebase.functions().httpsCallable(n)(p); }; };
    window.__ui = SokoniMerchantDisputesUI.mount(document.getElementById('host'), { scope: { ok: true, sellerUid: u.uid }, shopName: 'Duka',
      callList: function () { return Promise.resolve({ data: { disputes: [] } }); }, callDetail: c('getDisputeDetail'), callRespond: c('sellerRespondToDispute'),
      callEvidence: c('addDisputeEvidence'), callReports: c('tsGetReports'), onToast: function () {} });
  }
  start();
</script>`);

(async () => {
  await db.doc('products/pT').set({ name: 'Leather Boots', price: 4200, sellerUid: 'selB', status: 'active', isVisible: true });
  await TS.tsReportContent(as('buyB', { entityType: 'product', entityId: 'pT', reasonCode: 'counterfeit', detail: 'Wanjiku: brand logo is fake' }));
  const H = makePageHarness({ db, root: ROOT, pages: { '/tq-admin.html': ADMIN_PAGE, '/tq-merchant.html': MERCHANT_PAGE },
    callables: { tsGetReports: TS.tsGetReports, tsReviewReport: TS.tsReviewReport } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 8000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 160)); return false; } };
  const txt = (p) => p.evaluate(() => document.body.innerText).catch(() => '');
  try {
    const admin = { uid: 'admB', email: 'a@x.co', emailVerified: true, claims: { admin: true } };
    const R = await H.page(browser, { user: admin, viewport: { width: 390, height: 860 } });
    await R.goto(H.BASE + '/tq-admin.html');
    await R.waitForFunction(() => /Leather Boots/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const listed = /Leather Boots/.test(await txt(R)) && /Pending review/.test(await txt(R));
    await act('take the product down', async () => { await R.click('.stq-row', T); await R.fill('#stqNote', 'Counterfeit confirmed.', T);
      await R.click('[data-act="decide"][data-v="takedown"]', T); await R.waitForFunction(() => /product taken down/.test(document.body.innerText), null, T); });
    const p = (await db.doc('products/pT').get()).data();
    ck('TB4 a product report is listed and "Uphold + take product down" hides it (server)', listed && p.isVisible === false && p.moderationHold && !!p.moderationHold.reportId, { listed, vis: p.isVisible });
    await act('drawer + Esc', async () => { await R.click('[data-act="filter"][data-v="approved"]', T); await R.waitForSelector('.stq-row', T); await R.click('.stq-row', T);
      await R.waitForSelector('.stq-drawer', T); await R.keyboard.press('Escape'); await R.waitForFunction(() => !document.querySelector('.stq-drawer'), null, T); });
    const geo = await R.evaluate(() => ({ noH: document.documentElement.scrollWidth <= window.innerWidth + 1,
      small: [...document.querySelectorAll('.stq-chip, .stq-btn, .stq-row')].map((n) => n.getBoundingClientRect().height).filter((h) => h > 0 && h < 44) }));
    ck('TB6 the drawer closes with Esc; no horizontal scroll at 390 px; targets >=44 px', !(await R.$('.stq-drawer')) && geo.noH && geo.small.length === 0, geo);

    const M = await H.page(browser, { user: { uid: 'selB', email: 's@x.co', emailVerified: true }, viewport: { width: 390, height: 860 } });
    await M.goto(H.BASE + '/tq-merchant.html');
    await act('merchant reports tab', async () => { await M.waitForSelector('[data-act="tab"][data-t="reports"]', { timeout: 15000 }); await M.click('[data-act="tab"][data-t="reports"]', T);
      await M.waitForFunction(() => /Leather Boots/.test(document.body.innerText), null, T); });
    const tm = await txt(M);
    ck('TB7 the seller sees "Listing taken down" and the SOKONI reason, never the reporter', /Listing taken down/i.test(tm) && /Counterfeit confirmed/.test(tm) && !/Wanjiku|buyB|brand logo/.test(tm),
      { leak: (tm.match(/Wanjiku|buyB|brand logo/) || [null])[0] });
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
