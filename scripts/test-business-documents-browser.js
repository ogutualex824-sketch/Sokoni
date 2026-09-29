/* test-business-documents-browser.js — universal catalogue U6 (2026-09-29) in a REAL browser: the documents each
 * business is asked for, reviewed in AdminOS by a verification reviewer, shown honestly to the merchant.
 *
 * REAL sokoni-aos-business.js (the AdminOS seller registry) against the REAL business-category-admin ops, and the REAL
 * merchant-v2 Shop details module (Permits step) against the REAL kasshop callables, over the fake Firestore.
 *
 * PROVES
 *   DB1 AdminOS › Seller shops › Documents lists what a PHARMACY is asked for (PPB licence), not a lawyer's (LSK)
 *   DB2 a plain admin who presses Verify is refused, and the refusal is SHOWN; nothing changes
 *   DB3 a verification reviewer opens the document (a signed link) and verifies it; the badge turns Verified; audited
 *   DB4 a rejection without a reason is refused in the UI; with one it saves and the merchant sees the reason
 *   DB5 the merchant's Permits step shows the pharmacy's documents (PPB, no LSK) with their honest states
 *   DB6 no horizontal overflow at 390 px; no page errors
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-business-docs-browser';
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
const signed = [];
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => ({ file: (p) => ({ getSignedUrl: async () => { signed.push(p); return ['https://signed.example/' + encodeURIComponent(p)]; } }) }) }) });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });
const BA = require(Path.join(FN, 'business-category-admin.js'))._adminH;
const KS = require(Path.join(FN, 'kasshop.js'));
const MS = require(Path.join(FN, 'minishop.js'));
const { makePageHarness } = require('./lib/page-harness.js');
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

const AOS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:16px;font:14px system-ui;background:#0b0b0b;color:#eee}.aos-table-wrap{overflow-x:auto}.aos-table{border-collapse:collapse;width:100%}.aos-table td,.aos-table th{padding:6px;border-bottom:1px solid #222;text-align:left}.aos-inline-form{display:flex;flex-wrap:wrap;gap:6px}</style></head>
<body><div id="host"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-aos-business.js"></script>
<script>
  window.__opened = []; window.open = function (u) { window.__opened.push(u); return null; };
  const call = (op, data) => firebase.functions().httpsCallable('adminOsDispatch')(Object.assign({ op }, data || {})).then((r) => r.data);
  window.__mounted = SokoniAOSBusiness.mount({ host: document.getElementById('host'), call });
</script></body></html>`;
const PROFILE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--bg:#050505;--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09)}body{margin:0;padding:12px;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-catalogue-capabilities.js"></script>
<script src="/sokoni-availability-model.js"></script>
<script src="/sokoni-merchant-shop-profile.js"></script>
<script>
  const call = (n) => (d) => firebase.functions().httpsCallable(n)(d || {});
  function start() {
    const u = firebase.auth().currentUser; if (!u) return setTimeout(start, 50);
    window.__ui = SokoniMerchantShopProfile.mount(document.getElementById('host'), {
      uid: u.uid, origin: location.origin, isOwner: true,
      callGet: call('getShopProfile'), callSave: call('saveShopProfile'), callConfig: call('getMyMinishop'), callSaveConfig: call('saveMinishopConfig'),
      upload: (o) => Promise.resolve('https://x/' + o.path), onOpenAvailability: () => {}, onToast: () => {} });
  }
  start();
</script></body></html>`;

(async () => {
  const U = 'pharm1';
  await db.doc('shops/' + U).set({ sellerUid: U, ownerId: U, name: 'Afya Pharmacy', status: 'active', business: { category: 'pharmacy', source: 'admin' }, searchable: true, isPublic: true });
  await db.doc('minishopConfig/' + U).set({ shopId: U, ownerUid: U, handle: 'afya', schemaVersion: 2 });
  await db.doc('shopHandles/afya').set({ shopId: U, ownerUid: U });
  /* the owner uploads the PPB licence and types a KRA PIN — through the REAL writer */
  await run(KS.saveShopProfile)({ auth: { uid: U }, data: { profile: { name: 'Afya Pharmacy' }, compliance: { ppbNumber: 'PPB/123', kraPin: 'A012345678B', permits: { ppb: 'kyc-documents/pharm1/permit-ppb-1.pdf' } } } });
  const ops = { bizAdminShops: BA.bizAdminShops, bizAdminClassifyShop: BA.bizAdminClassifyShop, bizAdminProviders: BA.bizAdminProviders, bizAdminClassify: BA.bizAdminClassify,
    bizAdminShopCompliance: BA.bizAdminShopCompliance, bizAdminReviewPermit: BA.bizAdminReviewPermit, bizAdminDocumentUrl: BA.bizAdminDocumentUrl };
  const H = makePageHarness({ db, root: ROOT, pages: { '/aos-docs.html': AOS_PAGE, '/profile.html': PROFILE_PAGE },
    callables: { adminOsDispatch: ops, getShopProfile: run(KS.getShopProfile), saveShopProfile: run(KS.saveShopProfile), getMyMinishop: run(MS.getMyMinishop), saveMinishopConfig: run(MS.saveMinishopConfig) } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 8000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 160)); return false; } };
  const errors = [];
  const openDocs = async (p) => {
    await p.waitForSelector('[data-registry]', { timeout: 15000 });
    await p.selectOption('[data-registry]', 'shops', T);
    await p.waitForSelector('[data-view]', T);
    await p.selectOption('[data-view]', 'all', T);
    await p.click('[data-q] button[type="submit"]', T);
    await p.waitForSelector('[data-docs="pharm1"]', T);
    await p.click('[data-docs="pharm1"]', T);
    await p.waitForSelector('[data-doc="ppb"]', T);
  };
  try {
    /* DB1 + DB2 — a plain admin */
    const A = await H.page(browser, { user: { uid: 'adm1', claims: { admin: true } }, viewport: { width: 1280, height: 900 } });
    A.on('pageerror', (e) => errors.push(e.message));
    await A.goto(H.BASE + '/aos-docs.html');
    await act('plain admin opens Documents', () => openDocs(A));
    const list = await A.evaluate(() => [...document.querySelectorAll('[data-doc]')].map((d) => d.getAttribute('data-doc'))).catch(() => []);
    const ppbState = await A.evaluate(() => (document.querySelector('[data-doc="ppb"] [data-doc-state]') || {}).getAttribute && document.querySelector('[data-doc="ppb"] [data-doc-state]').getAttribute('data-doc-state')).catch(() => null);
    ck('DB1 AdminOS lists the pharmacy\'s documents (PPB licence, KRA…) — not a lawyer\'s LSK certificate; the PPB upload awaits review',
      list.includes('ppb') && list.includes('kra') && !list.includes('lsk') && ppbState === 'pending_review', { list, ppbState });
    await act('plain admin presses Verify', async () => { await A.click('[data-doc-verify="pharm1"][data-kind="ppb"] button', T); await A.waitForTimeout(500); });
    const shown = await A.evaluate(() => document.querySelector('[data-msg]').textContent).catch(() => '');
    ck('DB2 a plain admin is refused, the refusal is shown, nothing changes', /reviewer capability required/i.test(shown)
      && ((((await get('shops/pharm1/private/compliance')) || {}).review || {}).ppb || {}).state === 'pending_review', shown.slice(0, 120));

    /* DB3 + DB4 — a verification reviewer */
    const R = await H.page(browser, { user: { uid: 'rev1', claims: { admin: true, capabilities: ['application_verification_reviewer'] } }, viewport: { width: 390, height: 900 } });
    R.on('pageerror', (e) => errors.push(e.message));
    await R.goto(H.BASE + '/aos-docs.html');
    await act('reviewer opens the document, then verifies it', async () => {
      await openDocs(R);
      await R.click('[data-doc-open="pharm1"][data-kind="ppb"]', T);
      await R.waitForFunction(() => window.__opened.length === 1, null, T);
      await R.click('[data-doc-verify="pharm1"][data-kind="ppb"] button', T);
      await R.waitForFunction(() => { const b = document.querySelector('[data-doc="ppb"] [data-doc-state]'); return b && b.getAttribute('data-doc-state') === 'verified_on_file'; }, null, T);
    });
    const opened = await R.evaluate(() => window.__opened).catch(() => []);
    const rv = (((await get('shops/pharm1/private/compliance')) || {}).review || {}).ppb || {};
    const audit = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).filter((a) => a.shopId === 'pharm1').map((a) => a.action);
    ck('DB3 the reviewer opens the document (signed link) and verifies it; the badge turns Verified; both audited',
      opened.length === 1 && /signed\.example\/kyc-documents/.test(opened[0]) && rv.state === 'verified_on_file' && rv.reviewedBy === 'rev1'
      && audit.includes('business_doc_opened') && audit.includes('business_doc_verified_on_file'), { opened, state: rv.state, audit });
    await act('reject KRA — first without a reason', async () => {
      /* KRA has a number but no document: it offers no Verify / Reject at all (a number alone cannot be verified) */
    });
    const kraForms = await R.evaluate(() => !!document.querySelector('[data-doc-verify="pharm1"][data-kind="kra"]')).catch(() => true);
    await act('reject PPB without a reason, then with one', async () => {
      await R.click('[data-doc-reject="pharm1"][data-kind="ppb"] button', T); await R.waitForTimeout(300);
    });
    const noReason = await R.evaluate(() => document.querySelector('[data-msg]').textContent).catch(() => '');
    const stillVerified = ((((await get('shops/pharm1/private/compliance')) || {}).review || {}).ppb || {}).state === 'verified_on_file';
    await act('reject with a reason', async () => {
      await R.fill('[data-doc-reject="pharm1"][data-kind="ppb"] input[name="note"]', 'The licence has expired — upload the 2026 one.', T);
      await R.click('[data-doc-reject="pharm1"][data-kind="ppb"] button', T);
      await R.waitForFunction(() => { const b = document.querySelector('[data-doc="ppb"] [data-doc-state]'); return b && b.getAttribute('data-doc-state') === 'rejected'; }, null, T);
    });
    ck('DB4 no Verify/Reject for a number without a document; a rejection needs a reason (UI refuses, state kept); with one it saves',
      kraForms === false && /Say why/.test(noReason) && stillVerified && ((((await get('shops/pharm1/private/compliance')) || {}).review || {}).ppb || {}).state === 'rejected', { kraForms, noReason: noReason.slice(0, 60) });

    /* DB5 — the merchant */
    const M = await H.page(browser, { user: { uid: U }, viewport: { width: 390, height: 900 } });
    M.on('pageerror', (e) => errors.push(e.message));
    await M.goto(H.BASE + '/profile.html');
    await act('merchant opens Permits', async () => { await M.waitForSelector('[data-pgo="2"]', { timeout: 15000 }); await M.click('[data-pgo="2"]', T); await M.waitForSelector('[data-docstate]', T); });
    const mv = await M.evaluate(() => ({ text: document.getElementById('host').innerText, states: [...document.querySelectorAll('[data-docstate]')].map((b) => b.getAttribute('data-docstate')) })).catch(() => ({ text: '', states: [] }));
    ck('DB5 the merchant sees the pharmacy\'s documents with honest states: PPB rejected with the reason, KRA declared; no LSK',
      /Pharmacy & Poisons Board/.test(mv.text) && !/Law Society/.test(mv.text) && /Rejected — The licence has expired/.test(mv.text)
      && mv.states.includes('declared') && !/Document uploaded/.test(mv.text), mv.states);
    const over = await M.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false)
      && await R.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    ck('DB6 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
