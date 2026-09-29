/* test-product-conversations-browser.js — T2a end to end in a REAL browser (2026-09-29):
 *   buyer on the REAL product.html → "Ask a question" (public) → REAL messagesDispatch → seller in the REAL merchant-v2
 *   Messages module sees the thread → replies → "Publish answer publicly" → the product page's Q&A shows the answer.
 *
 * PROVES
 *   CB1 the buyer's question (asked from the product page) opens a conversation with the product's seller
 *   CB2 the seller sees that thread in merchant-v2 › Messages, with the buyer's question in it
 *   CB3 the seller's reply is stored in the same thread
 *   CB4 "Publish answer publicly" publishes it; the product page's Q&A then shows question + answer, without the asker
 *   CB5 the ask sheet closes with its ✕ (no trapped modal)
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-product-conversations-browser';
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
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), messaging: () => ({ send: async () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const DISP = require(Path.join(FN, 'messages-dispatch.js'));
const KS = require(Path.join(FN, 'kasshop.js'));
const { makePageHarness } = require('./lib/page-harness.js');
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };

const MERCHANT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09)}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host" style="height:100vh"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-merchant-messages.js"></script>
<script src="/sokoni-merchant-messages-ui.js"></script>
<script type="module">
  import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
  import { getFirestore, collection, query, orderBy, limit, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  const app = getApps()[0] || initializeApp({ projectId: 'demo' });
  const fdb = getFirestore(app);
  /* the same adapter shape merchant-v2 passes (queryMessages) */
  const adapter = { queryMessages: async (spec) => { const parts = [collection(fdb, ...spec.path)]; if (spec.orderBy) parts.push(orderBy(spec.orderBy[0], spec.orderBy[1])); if (spec.limit) parts.push(limit(spec.limit));
    const s = await getDocs(query(...parts)); return s.docs.map((d) => Object.assign({ id: d.id }, d.data())); } };
  function start() {
    const u = firebase.auth().currentUser; if (!u) return setTimeout(start, 50);
    window.__ui = SokoniMerchantMessagesUI.mount(document.getElementById('host'), { scope: { sellerUid: u.uid }, db: adapter,
      dispatch: (p) => firebase.functions().httpsCallable('messagesDispatch')(p), onToast: () => {} });
  }
  start();
</script></body></html>`;

(async () => {
  for (const u of ['sellC', 'buyC']) await db.doc('users/' + u).set({ name: u === 'sellC' ? 'Duka la Mama' : 'Wanjiku' });
  await db.doc('shops/sellC').set({ sellerUid: 'sellC', name: 'Duka', status: 'active' });
  await db.doc('products/pC').set({ name: 'Kitenge Dress', price: 2500, sellerUid: 'sellC', sellerName: 'Duka', status: 'active', isVisible: true, stock: 3, images: [] });
  const H = makePageHarness({ db, root: ROOT, pages: { '/mm-test.html': MERCHANT_PAGE },
    callables: { messagesDispatch: run(DISP.messagesDispatch), getShopAvailability: run(KS.getShopAvailability) } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 160)); return false; } };
  const T = { timeout: 8000 };
  try {
    const b = await H.page(browser, { user: { uid: 'buyC', email: 'b@x.co', emailVerified: true }, viewport: { width: 390, height: 900 } });
    await b.goto(H.BASE + '/product.html?id=pC');
    await b.waitForFunction(() => typeof window.openAskSeller === 'function' && window.SokoniSecureCall, null, { timeout: 15000 }).catch(() => {});
    await act('buyer asks publicly', async () => {
      await b.evaluate(() => openAskSeller({ publicQuestion: true }));
      await b.fill('#prdAskText', 'Can you deliver to Langata?', T);
      await b.click('#prdAskSend', T);
      await b.waitForFunction(() => /Sent to the seller/.test((document.getElementById('prdAskStatus') || {}).textContent || ''), null, T);
    });
    const cid = 'product_enquiry_pC__buyC';
    const conv = (await db.doc('conversations/' + cid).get());
    ck('CB1 the question from the product page opened a conversation with the product\'s seller', conv.exists && conv.data().participants.includes('sellC') && conv.data().participants.includes('buyC'));
    await act('close the sheet', async () => { await b.click('#prdAskClose', T); await b.waitForFunction(() => document.getElementById('prdAskSheet').style.display === 'none', null, T); });
    ck('CB5 the ask sheet closes with ✕', await b.evaluate(() => document.getElementById('prdAskSheet').style.display === 'none'));

    const s = await H.page(browser, { user: { uid: 'sellC', email: 's@x.co', emailVerified: true }, viewport: { width: 390, height: 860 } });
    await s.goto(H.BASE + '/mm-test.html');
    await act('seller opens the thread', async () => {
      await s.waitForSelector('.mmg-row', { timeout: 15000 });
      await s.click('.mmg-row', T);
      await s.waitForFunction(() => /Langata/.test(document.body.innerText), null, T);
    });
    ck('CB2 the seller sees the thread in merchant-v2 Messages with the buyer\'s question', /Langata/.test(await s.evaluate(() => document.body.innerText)) && !!(await s.$('[data-act="publish-qa"]')));
    await act('seller replies', async () => {
      await s.fill('#mmg-draft', 'Yes — Langata delivery is same day.', T);
      await s.click('[data-act="send"]', T);
      await s.waitForFunction(() => /same day/.test(document.querySelector('.mmg-msgs') ? document.querySelector('.mmg-msgs').innerText : ''), null, T);
    });
    const msgs = (await db.collection('conversations').doc(cid).collection('messages').get()).docs.map((d) => d.data());
    ck('CB3 the seller\'s reply is stored in the same thread', msgs.some((m) => m.senderId === 'sellC' && /same day/.test(m.text)));
    await act('seller publishes', async () => {
      await s.click('[data-act="publish-qa"]', T);
      await s.waitForFunction(() => !document.querySelector('[data-act="publish-qa"]'), null, T);
    });
    await b.reload();
    await b.waitForFunction(() => /same day/.test((document.getElementById('qaList') || {}).innerText || ''), null, { timeout: 12000 }).catch(() => {});
    const qaText = await b.evaluate(() => (document.getElementById('qaList') || {}).innerText || '');
    ck('CB4 the product page\'s Q&A shows the question and the seller\'s answer, without the asker', /Langata/.test(qaText) && /same day/.test(qaText) && !/Wanjiku|buyC/.test(qaText), qaText.slice(0, 160));
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
