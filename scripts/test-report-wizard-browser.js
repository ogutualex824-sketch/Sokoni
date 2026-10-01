/* test-report-wizard-browser.js — the product-page report WIZARD in a REAL browser (community C2, 2026-10-01).
 * QUEUED — not yet run (browser hold). Run after RESUME:
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-report-wizard-browser.js
 *
 * REAL product.html + sokoni-trust.js + sokoni-report-wizard.js, REAL tsGetReportReasons / tsReportContent over the
 * fake Firestore (scripts/lib/page-harness.js shims only the Firebase SDK). At 390 px and 1280 px.
 *
 * PROVES
 *   WB1 the "Report this listing" entry is ≥44 px tall and opens a labelled modal dialog
 *   WB2 step 1 shows the SERVER's reasons (one radio per catalogue entry), keyboard-operable (Tab/Space/Enter)
 *   WB3 the dialog fits the viewport (no horizontal page scroll) and every button / option is ≥44 px tall
 *   WB4 a complete report by keyboard lands on the server with the chosen code; "received" only after the server
 *   WB5 the same buyer again → "already reported"; one report on the server
 *   WB6 Escape closes and focus returns to the "Report this listing" button
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-report-wizard-browser';
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
  await db.doc('users/sellW').set({ name: 'Duka' });
  await db.doc('products/pW').set({ name: 'Kitenge Dress', price: 2500, sellerUid: 'sellW', sellerName: 'Duka', status: 'active', isVisible: true, stock: 3, images: [] });
  const H = makePageHarness({ db, root: ROOT, callables: { tsGetReportReasons: TS.tsGetReportReasons, tsReportContent: TS.tsReportContent } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 12000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 160)); return false; } };
  const nServer = Object.keys(TS._reportModel.REPORT_REASONS.product).length;
  try {
    for (const vp of [{ width: 390, height: 860 }, { width: 1280, height: 900 }]) {
      const uid = 'buyW' + vp.width;
      const P = await H.page(browser, { user: { uid, email: uid + '@x.co', emailVerified: true }, viewport: vp });
      await P.goto(H.BASE + '/product.html?id=pW');
      await P.waitForSelector('#reportListingBtn', { state: 'visible', timeout: 15000 }).catch(() => {});
      const entryH = await P.evaluate(() => { const b = document.getElementById('reportListingBtn'); return b ? b.getBoundingClientRect().height : 0; });
      await act('open the wizard (' + vp.width + ')', async () => { await P.click('#reportListingBtn', T); await P.waitForSelector('[role="dialog"] input[type="radio"]', T); });
      const dlg = await P.evaluate(() => { const d = document.querySelector('[role="dialog"]'); const l = d && document.getElementById(d.getAttribute('aria-labelledby'));
        return d ? { modal: d.getAttribute('aria-modal'), label: l && l.textContent, radios: d.querySelectorAll('input[type="radio"]').length } : null; });
      ck(`WB1 @${vp.width} entry ≥44px opens a labelled modal dialog`, entryH >= 44 && dlg && dlg.modal === 'true' && /Report this listing/.test(dlg.label || ''), { entryH, dlg });
      ck(`WB2 @${vp.width} one radio per SERVER reason`, dlg && dlg.radios === TS._reportModel.REPORT_REASONS.product.length, { radios: dlg && dlg.radios, server: nServer });
      const geo = await P.evaluate(() => {
        const d = document.querySelector('[role="dialog"]'); const r = d.getBoundingClientRect();
        const small = [...d.querySelectorAll('button, label.srw-opt')].map((n) => n.getBoundingClientRect().height).filter((h) => h > 0 && h < 44);
        return { fits: r.left >= 0 && r.right <= window.innerWidth + 1, noH: document.documentElement.scrollWidth <= window.innerWidth + 1, small };
      });
      ck(`WB3 @${vp.width} the dialog fits, no horizontal scroll, every target ≥44px`, geo.fits && geo.noH && geo.small.length === 0, geo);
      await act('complete by keyboard (' + vp.width + ')', async () => {
        await P.focus('[role="dialog"] input[value="counterfeit"]'); await P.keyboard.press('Space');
        await P.click('text=Next', T); await P.waitForSelector('#srwDetail', T);
        await P.keyboard.type('The logo is printed crooked.'); await P.click('text=Next', T);
        await P.waitForSelector('text=Submit report', T); await P.keyboard.press('Enter');
        await P.waitForFunction(() => /SOKONI has your report/.test(document.body.innerText), null, T);
      });
      const on = (await db.collection('reports').get()).docs.map((d) => d.data()).filter((r) => r.reportedBy === uid);
      ck(`WB4 @${vp.width} the report is on the server with the chosen code`, on.length === 1 && on[0].reasonCode === 'counterfeit' && on[0].context && on[0].context.productName === 'Kitenge Dress', on.length);
      await act('Done', async () => { await P.click('text=Done', T); });
      await act('again (' + vp.width + ')', async () => {
        await P.click('#reportListingBtn', T); await P.waitForSelector('[role="dialog"] input[value="scam"]', T);
        await P.check('[role="dialog"] input[value="scam"]'); await P.click('text=Next', T); await P.click('text=Next', T); await P.click('text=Submit report', T);
        await P.waitForFunction(() => /already reported this/.test(document.body.innerText), null, T);
      });
      ck(`WB5 @${vp.width} the same buyer again → "already reported"; one report`, (await db.collection('reports').get()).docs.filter((d) => d.data().reportedBy === uid).length === 1);
      await P.keyboard.press('Escape');
      const back = await P.evaluate(() => !document.querySelector('[role="dialog"]') && document.activeElement && document.activeElement.id === 'reportListingBtn');
      ck(`WB6 @${vp.width} Escape closes and focus returns to the entry button`, back);
    }
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
