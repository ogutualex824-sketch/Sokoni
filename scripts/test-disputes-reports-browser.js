/* test-disputes-reports-browser.js — disputes and reports on every side, in a REAL browser (2026-09-29)
 *   The REAL shared admin queue (sokoni-trust-queues.js — what AdminOS, super-admin.html and the legacy console mount)
 *   and the REAL merchant-v2 Disputes module, against the REAL handlers (disputes.js via admin-os._h, trust-safety.js,
 *   messagesDispatch) over the fake Firestore.
 *
 * PROVES
 *   TB1 an admin sees the active dispute with BOTH parties named
 *   TB2 the drawer shows the complaint, the seller's response, evidence and the timeline
 *   TB3 resolving asks for a side first; with a side + note it resolves through the server, and the row leaves Active
 *   TB4 Trust reports: a product report is listed; "Take product down" hides the product (server-verified)
 *   TB5 Conversations: a reported conversation is listed for the admin
 *   TB6 the drawer closes with Esc; no horizontal scroll at 390 px
 *   TB7 merchant-v2 › Disputes › Reports: the seller sees "Listing taken down" and SOKONI's reason — never the reporter
 *   TB8 dispute.html?order=… lands on dispute-portal.html with the order carried
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-disputes-reports-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), messaging: () => ({ send: async () => ({}) }), storage: () => ({ bucket: () => ({}) }) });
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
const DSP = require(Path.join(FN, 'disputes.js'));
const AOS = require(Path.join(FN, 'admin-os.js'));
const TS = require(Path.join(FN, 'trust-safety.js'));
const DISP = require(Path.join(FN, 'messages-dispatch.js'));
const MSG = require(Path.join(FN, 'messages.js'));
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
    var view = new URLSearchParams(location.search).get('view') || 'disputes';
    /* the same adapter AdminOS / super admin pass */
    window.__q = SokoniTrustQueues.mount(document.getElementById('host'), { view: view,
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
      callList: c('getSellerDisputes'), callDetail: c('getDisputeDetail'), callRespond: c('sellerRespondToDispute'),
      callEvidence: c('addDisputeEvidence'), callReports: c('tsGetReports'), onToast: function () {} });
  }
  start();
</script>`);

(async () => {
  await db.doc('users/buyB').set({ displayName: 'Wanjiku M' });
  await db.doc('users/selB').set({ businessName: 'Duka la Mama' });
  await db.doc('orders/oB').set({ buyerId: 'buyB', buyerUid: 'buyB', userId: 'buyB', sellerId: 'selB', total: 4200, status: 'delivered', items: [{}], createdAt: F.Timestamp.fromMillis(Date.now() - 3600000) });
  const c = await run(DSP.createDispute)(as('buyB', { orderId: 'oB', reason: 'not_as_described', description: 'The shoes are size 40, not 42 as listed.' }));
  await run(DSP.sellerRespondToDispute)(as('selB', { disputeId: c.disputeId, response: 'We sent the listed size; happy to exchange.' }));
  await run(DSP.addDisputeEvidence)(as('buyB', { disputeId: c.disputeId, evidenceType: 'photo', description: 'Label shows size 40', fileUrl: 'https://img.example/label.jpg' }));
  await db.doc('products/pT').set({ name: 'Leather Boots', price: 4200, sellerUid: 'selB', status: 'active', isVisible: true });
  await run(TS.tsReportContent)(as('buyB', { entityType: 'product', entityId: 'pT', reason: 'Counterfeit or suspicious product', detail: 'Wanjiku: brand logo is fake' }));
  await db.doc('conversations/cvB').set({ participants: ['buyB', 'selB'], type: 'direct' });
  await MSG._h.reportConversation(as('buyB', { conversationId: 'cvB', reason: 'harassment', details: 'rude' }));

  const H = makePageHarness({ db, root: ROOT, pages: { '/tq-admin.html': ADMIN_PAGE, '/tq-merchant.html': MERCHANT_PAGE },
    callables: { adminOsDispatch: AOS._h, tsGetReports: run(TS.tsGetReports), tsReviewReport: run(TS.tsReviewReport), messagesDispatch: run(DISP.messagesDispatch),
      getSellerDisputes: run(DSP.getSellerDisputes), getDisputeDetail: run(DSP.getDisputeDetail), sellerRespondToDispute: run(DSP.sellerRespondToDispute), addDisputeEvidence: run(DSP.addDisputeEvidence) } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 8000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 160)); return false; } };
  const txt = (p) => p.evaluate(() => document.body.innerText).catch(() => '');
  try {
    const admin = { uid: 'admB', email: 'a@x.co', emailVerified: true, claims: { admin: true } };
    const A = await H.page(browser, { user: admin, viewport: { width: 1280, height: 900 } });
    await A.goto(H.BASE + '/tq-admin.html?view=disputes');
    await A.waitForFunction(() => /Wanjiku M/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const t1 = await txt(A);
    ck('TB1 the admin sees the active dispute with both parties named', /Wanjiku M/.test(t1) && /Duka la Mama/.test(t1) && /KES 4,200/.test(t1), t1.slice(0, 200));
    await act('open the dispute', async () => { await A.click('.stq-row', T); await A.waitForFunction(() => /happy to exchange/.test(document.body.innerText), null, T); });
    const t2 = await txt(A);
    ck('TB2 the drawer shows complaint, seller response, evidence and timeline', /size 40, not 42/.test(t2) && /happy to exchange/.test(t2) && /Label shows size 40/.test(t2) && /Timeline/i.test(t2) && /Dispute opened by buyer/.test(t2));
    await act('resolve without a side', async () => { await A.fill('#stqNote', 'Size mismatch confirmed from the label photo.', T); await A.click('[data-act="resolve"]', T);
      await A.waitForFunction(() => /Choose whose favour/.test(document.body.innerText), null, T); });
    const refused = /Choose whose favour/.test(await txt(A)) && (await db.doc('disputes/' + c.disputeId).get()).data().status !== 'resolved';
    await act('resolve for the buyer', async () => { await A.click('[data-act="fav"][data-v="buyer"]', T); await A.click('[data-act="resolve"]', T);
      await A.waitForFunction(() => /Dispute resolved/.test(document.body.innerText), null, T); await A.waitForFunction(() => !document.querySelector('.stq-drawer'), null, T); });
    const dz = (await db.doc('disputes/' + c.disputeId).get()).data();
    const t3 = await txt(A);
    ck('TB3 a side is required; then it resolves through the server and leaves Active', refused && dz.status === 'resolved' && dz.favorBuyer === true && /label photo/.test(dz.resolution) && !/Wanjiku M/.test(t3), { status: dz.status, fav: dz.favorBuyer });

    const R = await H.page(browser, { user: admin, viewport: { width: 390, height: 860 } });
    await R.goto(H.BASE + '/tq-admin.html?view=reports');
    await R.waitForFunction(() => /Leather Boots/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    await act('take the product down', async () => { await R.click('.stq-row', T); await R.fill('#stqNote', 'Counterfeit confirmed.', T); await R.click('[data-act="r-takedown"]', T);
      await R.waitForFunction(() => /product taken down/.test(document.body.innerText), null, T); });
    const p = (await db.doc('products/pT').get()).data();
    ck('TB4 a product report is listed and "Take product down" hides it (server)', p.isVisible === false && p.moderationHold && !!p.moderationHold.reportId, { vis: p.isVisible });
    await act('conversations tab', async () => { await R.click('[data-act="kind"][data-v="conversations"]', T); await R.waitForFunction(() => /cvB/.test(document.body.innerText), null, T); });
    ck('TB5 the reported conversation is listed for the admin', /cvB/.test(await txt(R)) && /harassment/.test(await txt(R)));
    await act('drawer + Esc', async () => { await R.click('.stq-row', T); await R.waitForSelector('.stq-drawer', T); await R.keyboard.press('Escape'); await R.waitForFunction(() => !document.querySelector('.stq-drawer'), null, T); });
    const noHScroll = await R.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ck('TB6 the drawer closes with Esc; no horizontal scroll at 390 px', !(await R.$('.stq-drawer')) && noHScroll, { noHScroll });

    const M = await H.page(browser, { user: { uid: 'selB', email: 's@x.co', emailVerified: true }, viewport: { width: 390, height: 860 } });
    await M.goto(H.BASE + '/tq-merchant.html');
    await act('merchant reports tab', async () => { await M.waitForSelector('[data-act="tab"][data-t="reports"]', { timeout: 15000 }); await M.click('[data-act="tab"][data-t="reports"]', T);
      await M.waitForFunction(() => /Leather Boots/.test(document.body.innerText), null, T); });
    const tm = await txt(M);
    ck('TB7 the seller sees "Listing taken down" and SOKONI\'s reason — never the reporter', /Listing taken down/i.test(tm) /* .mdp-status is text-transform:uppercase */ && /Counterfeit confirmed/.test(tm) && !/Wanjiku|buyB|brand logo/.test(tm), { taken: /Listing taken down/i.test(tm), why: /Counterfeit confirmed/.test(tm), leak: (tm.match(/Wanjiku|buyB|brand logo/) || [null])[0] });

    const D = await H.page(browser, { user: { uid: 'buyB', email: 'b@x.co', emailVerified: true }, viewport: { width: 390, height: 860 } });
    await D.goto(H.BASE + '/dispute.html?order=oB').catch(() => {});
    await D.waitForURL(/dispute-portal\.html\?orderId=oB/, { timeout: 8000 }).catch(() => {});
    ck('TB8 dispute.html carries the order to the dispute portal', /dispute-portal\.html\?orderId=oB/.test(D.url()), D.url());
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
