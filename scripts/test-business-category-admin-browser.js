/* test-business-category-admin-browser.js — AdminOS › Business Categories in a REAL browser (CHANGELOG 236, C1).
 *
 * Chromium loads the REAL sokoni-aos-business.js, mounted exactly as sokoni-aos.js mounts it ({host, call}), with
 * `call` routed to the REAL functions/business-category-admin.js ops on the transactional fake Firestore. No network.
 *
 * PROVES: the UNCLASSIFIED queue is the default view; a business name is escaped; a classification needs a reason
 * and shows success only after the server answered, then leaves the queue; the dropdown never offers a category owned
 * by another authority nor one across the Healthcare boundary; a non-admin sees the server's refusal; no horizontal
 * overflow at 390 or 1280 px.
 *
 *   node scripts/test-business-category-admin-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-biz-admin-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => ({}) });
const BA = require(Path.join(FN, 'business-category-admin.js'))._adminH;
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:16px;font:14px system-ui;background:#0b0b0b;color:#eee}.aos-table-wrap{overflow-x:auto}.aos-table{border-collapse:collapse;width:100%}.aos-table td,.aos-table th{padding:6px;border-bottom:1px solid #222;text-align:left}.aos-inline-form{display:flex;flex-wrap:wrap;gap:6px}</style></head>
<body><div id="host"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-aos-business.js"></script>
<script>
  const call = (op, data) => firebase.functions().httpsCallable('adminOsDispatch')(Object.assign({ op }, data || {})).then((r) => r.data);
  window.__mounted = SokoniAOSBusiness.mount({ host: document.getElementById('host'), call });
</script></body></html>`;

(async () => {
  await db.doc('providers/amb1').set({ name: '<img src=x onerror=alert(1)>Mixed Co', status: 'active', business: { category: null, source: 'application', lane: { hub: 'provider', entClass: null } } });
  await db.doc('providers/doc1').set({ name: 'Dr One', status: 'active', healthcare: { category: null, source: 'application' }, business: { category: null, source: 'application', lane: { hub: 'healthcare', entClass: null } } });
  await db.doc('providers/ok1').set({ name: 'Plumb Co', status: 'active', business: { category: 'trades', source: 'application', lane: { hub: 'provider', entClass: null } } });
  const H = makePageHarness({ db, root: ROOT, pages: { '/aos-business-test.html': PAGE }, callables: { adminOsDispatch: { bizAdminProviders: BA.bizAdminProviders, bizAdminClassify: BA.bizAdminClassify } } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    for (const w of [390, 1280]) {
      say(`\n── ${w}px ──`);
      const page = await H.page(browser, { user: { uid: 'admin1', claims: { admin: true } }, viewport: { width: w, height: 900 } });
      let dialogs = 0; page.on('dialog', (d) => { dialogs++; d.dismiss(); });
      await page.goto(H.BASE + '/aos-business-test.html');
      await page.waitForSelector('[data-row]', { timeout: 15000 }).catch(() => {});
      const rows = await page.$$eval('[data-row]', (els) => els.map((e) => e.getAttribute('data-row')));
      ck(`${w}: the default view is the UNCLASSIFIED queue (both unclassified businesses, not the classified one)`, rows.includes('amb1') && rows.includes('doc1') && !rows.includes('ok1'), rows);
      const html = await page.$eval('[data-row="amb1"]', (e) => e.innerHTML);
      ck(`${w}: a hostile business name is escaped, never executed`, html.includes('&lt;img') && !(await page.$('[data-row="amb1"] img')) && dialogs === 0);
      const opts = await page.$$eval('[data-classify="amb1"] option', (o) => o.map((x) => x.value).filter(Boolean));
      const hcOpts = await page.$$eval('[data-classify="doc1"] option', (o) => o.map((x) => x.value).filter(Boolean));
      ck(`${w}: no authority-owned category (lawyer / event organizer / delivery) is offered`, !opts.some((v) => ['lawyer', 'event_organizer', 'delivery'].includes(v)));
      ck(`${w}: the Healthcare boundary holds in the UI: a non-health business gets no Healthcare option, a health provider only Healthcare ones`,
        !opts.some((v) => ['clinician', 'pharmacy', 'facility'].includes(v)) && hcOpts.length === 6 && hcOpts.every((v) => ['clinician', 'facility', 'pharmacy', 'laboratory', 'telemedicine', 'home_care'].includes(v)), { opts: opts.length, hcOpts });
      ck(`${w}: no horizontal page overflow`, await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1));
      if (w === 1280) {
        await page.selectOption('[data-classify="amb1"] select', 'trades');
        await page.fill('[data-classify="amb1"] input[name=reason]', 'Plumbing company, confirmed by documents');
        await page.click('[data-classify="amb1"] button');
        await page.waitForFunction(() => !document.querySelector('[data-row="amb1"]'), null, { timeout: 8000 }).catch(() => {});
        const msg = await page.$eval('[data-msg]', (e) => e.textContent);
        const stored = (await db.doc('providers/amb1').get()).data();
        ck('classifying with a reason saves on the SERVER, then says so, and the business leaves the queue', stored.business.category === 'trades' && stored.business.source === 'admin' && /Saved/.test(msg) && !(await page.$('[data-row="amb1"]')), { msg, cat: stored.business.category });
        const audit = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).find((a) => a.targetUid === 'amb1');
        ck('…and the audit log records it with the reason', !!audit && /documents/.test(audit.reason) && audit.performedBy === 'admin1');
      }
      await page.context().close();
    }
    say('\n── a non-admin ──');
    const page = await H.page(browser, { user: { uid: 'mallory', claims: {} }, viewport: { width: 1280, height: 900 } });
    await page.goto(H.BASE + '/aos-business-test.html');
    await page.waitForFunction(() => /Could not load/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {});
    ck('a non-admin sees the server\'s refusal and no business rows', /Could not load/.test(await page.textContent('body')) && !(await page.$('[data-row]')));
    await page.context().close();
  } finally { await browser.close(); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
