/* test-business-category-admin-shops-browser.js — AdminOS › Business categories › SELLER SHOPS in a REAL browser
 * (shop discovery authority, stage 2, 2026-09-28).
 *
 * Chromium loads the REAL sokoni-aos-business.js, mounted as sokoni-aos.js mounts it ({host, call}), with `call` routed
 * to the REAL functions/business-category-admin.js ops on the transactional fake Firestore. No network.
 *
 * PROVES
 *   S1  switching the registry to "Seller shops" shows the UNCLASSIFIED shop queue (approved + legacy), not pending shops
 *   S2  a hostile shop name and owner wording are escaped, never executed
 *   S3  only shop categories (merchant-v2) are offered — never a service, Healthcare or authority-owned category
 *   S4  a shop with NO approval record cannot be saved without "I verified this business" (client + server)
 *   S5  saving an approved shop classifies it on the SERVER, then says it is listed, and it leaves the queue
 *   S6  the attested legacy save is recorded as attested in the audit log
 *   S7  the provider view is still the default (unchanged)
 *   S8  no horizontal overflow at 390 and 1280 px
 *
 *   node scripts/test-business-category-admin-shops-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-biz-admin-shops-browser';
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
const BW = require(Path.join(FN, 'business-workspace.js'));
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
  await db.doc('providers/p1').set({ name: 'Plumb Co', status: 'active', approvedAt: 1, business: { category: null, source: 'application', lane: { hub: 'provider', entClass: null } } });
  await db.doc('shops/legacyX').set({ sellerUid: 'lx', name: '<img src=x onerror=alert(1)>Old Duka', status: 'active', category: '<svg onload=alert(2)>' });
  await db.doc('shops/apprX').set({ sellerUid: 'ax', ownerId: 'ax', name: 'Approved Hardware', status: 'active', source: 'application_approval', applicationId: 'a1' });
  await db.doc('sellers/ax').set({ uid: 'ax', shopId: 'apprX', status: 'active' });
  await db.doc('shops/pendX').set({ sellerUid: 'px', name: 'Pending Shop', status: 'pending' });
  const ops = { bizAdminProviders: BA.bizAdminProviders, bizAdminClassify: BA.bizAdminClassify, bizAdminShops: BA.bizAdminShops, bizAdminClassifyShop: BA.bizAdminClassifyShop };
  const H = makePageHarness({ db, root: ROOT, pages: { '/aos-shops-test.html': PAGE }, callables: { adminOsDispatch: ops } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    for (const w of [390, 1280]) {
      say(`\n── ${w}px ──`);
      const page = await H.page(browser, { user: { uid: 'admin1', claims: { admin: true } }, viewport: { width: w, height: 900 } });
      let dialogs = 0; page.on('dialog', (d) => { dialogs++; d.dismiss(); });
      await page.goto(H.BASE + '/aos-shops-test.html');
      await page.waitForSelector('[data-row]', { timeout: 15000 }).catch(() => {});
      ck(`S7 ${w}: the provider view is still the default`, !!(await page.$('[data-row="p1"]')) && (await page.$eval('[data-registry]', (e) => e.value)) === 'providers');
      await page.selectOption('[data-registry]', 'shops');
      await page.waitForSelector('[data-shop-row]', { timeout: 15000 }).catch(() => {});
      const rows = await page.$$eval('[data-shop-row]', (els) => els.map((e) => e.getAttribute('data-shop-row')));
      ck(`S1 ${w}: the unclassified shop queue shows approved + legacy shops, not the pending one`, rows.includes('legacyX') && rows.includes('apprX') && !rows.includes('pendX'), rows);
      const html = await page.$eval('[data-shop-row="legacyX"]', (e) => e.innerHTML);
      ck(`S2 ${w}: a hostile shop name and owner wording are escaped`, html.includes('&lt;img') && html.includes('&lt;svg') && !(await page.$('[data-shop-row] img, [data-shop-row] svg')) && dialogs === 0);
      const opts = await page.$$eval('[data-classify-shop="apprX"] option', (o) => o.map((x) => x.value).filter(Boolean));
      ck(`S3 ${w}: only shop (merchant-v2) categories are offered`, opts.length > 0 && opts.every((v) => BW.ROUTE_OF[v] === 'merchant-v2.html') && !opts.some((v) => ['trades', 'pharmacy', 'lawyer', 'delivery'].includes(v)), opts);
      ck(`S8 ${w}: no horizontal page overflow`, await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1));
      if (w === 1280) {
        /* S4: legacy shop without attestation → refused, nothing written */
        await page.selectOption('[data-classify-shop="legacyX"] select', 'supermarket');
        await page.fill('[data-classify-shop="legacyX"] input[name=reason]', 'Visited the duka');
        await page.click('[data-classify-shop="legacyX"] button');
        await page.waitForTimeout(400);
        const m1 = await page.$eval('[data-msg]', (e) => e.textContent);
        const srvRefuse = await BA.bizAdminClassifyShop({ auth: { uid: 'admin1', token: { admin: true } }, data: { shopId: 'legacyX', category: 'supermarket', reason: 'direct call' } }).then(() => null, (e) => (e.details && e.details.code) || e.code);
        ck('S4 a legacy shop needs "I verified this business" — the page says so and the server refuses too', /verified this business/i.test(m1) && !(await db.doc('shops/legacyX').get()).data().business && srvRefuse === 'NO_APPROVAL_RECORD', { m1, srvRefuse });
        /* S5: approved shop → classified on the server, listed, leaves the queue */
        await page.selectOption('[data-classify-shop="apprX"] select', 'hardware');
        await page.fill('[data-classify-shop="apprX"] input[name=reason]', 'Hardware store, confirmed by documents');
        await page.click('[data-classify-shop="apprX"] button');
        await page.waitForFunction(() => !document.querySelector('[data-shop-row="apprX"]'), null, { timeout: 8000 }).catch(() => {});
        const m2 = await page.$eval('[data-msg]', (e) => e.textContent);
        const s = (await db.doc('shops/apprX').get()).data();
        ck('S5 saving an approved shop classifies it on the SERVER, says it is listed, and it leaves the queue',
          s.business && s.business.category === 'hardware' && s.business.source === 'admin' && /listed publicly/.test(m2) && !(await page.$('[data-shop-row="apprX"]')), { m2, b: s.business });
        /* S6: attested legacy save */
        await page.selectOption('[data-classify-shop="legacyX"] select', 'supermarket');
        await page.fill('[data-classify-shop="legacyX"] input[name=reason]', 'Visited the duka in person');
        await page.check('[data-classify-shop="legacyX"] input[name=attest]');
        await page.click('[data-classify-shop="legacyX"] button');
        await page.waitForFunction(() => !document.querySelector('[data-shop-row="legacyX"]'), null, { timeout: 8000 }).catch(() => {});
        const audit = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).find((a) => a.targetShopId === 'legacyX');
        ck('S6 the attested legacy save is classified and audited as attested', !!audit && audit.attested === true && audit.next === 'supermarket' && audit.performedBy === 'admin1', audit);
      }
      await page.context().close();
    }
  } finally { await browser.close(); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
