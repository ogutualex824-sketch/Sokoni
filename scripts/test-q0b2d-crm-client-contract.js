'use strict';
/**
 * CERTIFICATION — Q0b-2d: pos-crm-pro.html speaks its server's actual customer contract.
 *
 * Runs the page's REAL module script (its inline <script type="module">, with only the gstatic/config `import`
 * lines replaced by in-process stand-ins) over a minimal DOM stub. `httpsCallable(fns, 'smartPosDispatch')` is
 * routed to the REAL `_h` handlers (pos-retail-engine getPOSCustomer; pos-crm-pro getCustomerInsights,
 * checkBirthdayReward, issueStoreCredit) on the Firestore EMULATOR — so the page is tested against what the server
 * really accepts and returns, and every payload the page sends is recorded.
 *
 * Pointed at the pre-2d page (PAGE = a copy of pos-crm-pro.html at 2568786) the lookups are refused, the
 * envelope is rendered as the customer, and the follow-on calls send `customerId`; on this page each works.
 *
 *   PAGE         page under test (default: this repo's pos-crm-pro.html)
 *   REPAIR_ROOT  functions tree the page is served by (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
const PAGE = path.resolve(process.env.PAGE || path.join(__dirname, '..', 'pos-crm-pro.html'));
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0b2d';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 180s\n'); process.exit(3); }, 180000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr),
  cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) {
  process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; }
}

let PRE, CRM;
try { PRE = require(path.join(FN, 'pos-retail-engine.js')); CRM = require(path.join(FN, 'pos-crm-pro.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }
const HANDLERS = Object.assign({}, CRM._h, PRE._h);

/* ── the page, loaded ── */
const html = fs.readFileSync(PAGE, 'utf8');
const modStart = html.indexOf('<script type="module">');
const modSrc = modStart < 0 ? null : html.slice(modStart + '<script type="module">'.length, html.indexOf('</script>', modStart));
if (!modSrc) { process.stdout.write('  ✖ SETUP — the page module script was not found\n'); process.exit(2); }
const body = modSrc.replace(/^\s*import\s+[^;]+;\s*$/gm, '');       /* only the import lines are replaced */

const TOAST = [], SENT = [];
let AUTH = { uid: 'q2d-a', token: { uid: 'q2d-a', role: 'seller' } };
function el(id) {
  return { id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute() {}, focus() {} };
}
const ELS = {};
const document = {
  getElementById: (id) => (ELS[id] = ELS[id] || el(id)),
  createElement: () => { const e = el('_new'); Object.defineProperty(e, 'textContent', { set(v) { TOAST.push(String(v)); }, get() { return ''; } }); return e; },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};
const window = { location: { href: '' } };
const ctx = {
  window, document, console, setTimeout: (f) => 0, clearTimeout() {}, Promise, Date, Math, JSON, Object, Array, String, Number, isFinite, isNaN,
  firebaseConfig: {},
  initializeApp: () => ({}), getAuth: () => ({}), onAuthStateChanged: () => {},
  getFunctions: () => ({}),
  httpsCallable: (_fns, name) => async (payload) => {
    if (name !== 'smartPosDispatch') throw new Error('unexpected callable ' + name);
    SENT.push(JSON.parse(JSON.stringify(payload)));
    const h = HANDLERS[payload.op];
    if (!h) throw Object.assign(new Error('unknown op ' + payload.op), { code: 'not-found' });
    const out = await quiet(() => h({ data: payload, auth: AUTH }));
    return { data: JSON.parse(JSON.stringify(out)) };
  },
};
ctx.globalThis = ctx;
try { vm.runInNewContext(body, ctx, { filename: 'pos-crm-pro.html#module' }); }
catch (e) { process.stdout.write('  ✖ SETUP — the page module did not run: ' + e.message + '\n'); process.exit(2); }
const W = window;

const lastSent = (op) => [...SENT].reverse().find((p) => p.op === op);
const clearToasts = () => { TOAST.length = 0; };
const card = () => ELS.custResult ? ELS.custResult.innerHTML : '';

(async () => {
  process.stdout.write(`\nQ0b-2d — pos-crm-pro.html customer contract   (page: ${PAGE})\n\n`);
  const A = 'q2d-a';
  const set = (p, d) => db.doc(p).set(d);
  const today = new Date();
  /* customers of store A — shapes as the server writers produce them */
  await set(`posCustomers/${A}_254711000001`, { sellerId: A, phone: '254711000001', name: 'Grace Gold', loyaltyPoints: 6000,
    totalSpend: 1500, visitCount: 3, storeCredit: 0, birthdayMonth: today.getMonth() + 1, birthdayDay: today.getDate() });   /* recordPOSSale / upsert set */
  await set(`posCustomers/${A}_254711000002`, { sellerId: A, phone: '254711000002', name: 'Till Tom', loyaltyPoints: 10,
    totalSpent: 800, purchaseCount: 2 });                                                                               /* checkout set */
  await set(`posCustomers/${A}_254711000003`, { sellerId: A, phone: '254711000003', name: 'Both Bea', loyaltyPoints: 10,
    totalSpend: 1500, visitCount: 3, totalSpent: 800, purchaseCount: 2 });                                              /* both sets */
  await set('posSales/q2d-s1', { sellerId: A, customerPhone: '254711000001', total: 700, items: [{ productId: 'SKU-MAIZE', name: 'Maize Flour', qty: 2 }],
    createdAt: admin.firestore.Timestamp.fromDate(new Date('2026-09-20T10:00:00Z')) });

  process.stdout.write('[L] the lookup speaks getPOSCustomer\'s contract\n');
  ELS.custSearch = el('custSearch'); ELS.custSearch.value = '0711000001';
  { let threw = null; try { await W.searchCustomer(); } catch (e) { threw = e; }
    const sent = lastSent('getPOSCustomer');
    ok(sent && sent.phone === '0711000001' && sent.query === undefined, 'L-1', 'a phone-like search sends { phone }: ' + JSON.stringify(sent));
    ok(!threw && /Grace Gold/.test(card()) && /254711000001/.test(card()), 'L-2', 'the real {found, customer} response renders THE CUSTOMER (not the envelope): ' + (threw ? 'threw ' + threw.message : card().replace(/\s+/g, ' ').slice(0, 90)));
    ok(/tier-gold/.test(card()) && /Gold/.test(card()), 'L-3', 'the tier OBJECT the server returns is normalised — the badge renders Gold, no .toLowerCase() failure');
    ok(/KES 1,500/.test(card()) && />3</.test(card()), 'L-4', 'spend and visits shown from the ONE counter set present (totalSpend / visitCount)'); }
  ELS.custSearch.value = `${A}_254711000002`;
  await W.searchCustomer();
  { const sent = lastSent('getPOSCustomer');
    ok(sent && sent.customerId === `${A}_254711000002` && sent.phone === undefined, 'L-5', 'anything not phone-like is looked up as { customerId }: ' + JSON.stringify(sent));
    ok(/Till Tom/.test(card()) && /KES 800/.test(card()) && />2</.test(card()), 'L-6', 'a customer carrying only the checkout set (totalSpent / purchaseCount) shows those values'); }
  ELS.custSearch.value = '0711000003';
  await W.searchCustomer();
  { const c = card();
    ok(/Both Bea/.test(c) && !/KES 1,500/.test(c) && !/KES 800/.test(c) && !/2,300|2300/.test(c) && (c.match(/>—</g) || []).length >= 2, 'L-7',
      'BOTH counter sets present → spend and visits render "—": never one of them as the total, never a client-side sum'); }
  ELS.custSearch.value = '0799999999';
  await W.searchCustomer();
  ok(/No customer found/.test(card()), 'L-8', 'a customer that is not found renders a not-found state, not an empty card: ' + card().replace(/\s+/g, ' ').slice(0, 70));
  ok(/placeholder="Search by phone or customer ID…"/.test(html) && !/Search by phone or name/.test(html), 'L-9', 'the search box no longer promises name search');

  process.stdout.write('\n[F] the follow-on calls send the customer\'s phone, and read the real responses\n');
  ELS.custSearch.value = '0711000001';
  await W.searchCustomer();
  ELS.insightsContent = el('insightsContent'); ELS.custInsights = el('custInsights');
  await W.viewHistory();
  { const sent = lastSent('getCustomerInsights'), panel = ELS.insightsContent.innerHTML;
    ok(sent && sent.phone === '254711000001' && sent.customerId === undefined, 'F-1', 'getCustomerInsights receives the customer\'s phone: ' + JSON.stringify(sent));
    const row = (label) => { const m = panel.match(new RegExp(label + '</span><span>([^<]*)</span>')); return m ? m[1] : null; };
    ok(row('Favourite Products') === 'SKU-MAIZE' && /Maize Flour/.test(panel) && /KES 700/.test(panel) && /2026-09-20/.test(panel) && !/No purchases/.test(panel), 'F-2',
      'the favourites row shows the server\'s favouriteProducts (SKU-MAIZE) and the table its recentPurchases (item, date, amount): favourites=' + row('Favourite Products'));
    ok(row('Last Visit') === '—', 'F-2b', 'the server returned no lastVisit, so the row shows "—" — never a date inferred from the purchase history: ' + row('Last Visit')); }
  clearToasts();
  const ptsBefore = (await db.doc(`posCustomers/${A}_254711000001`).get()).data().loyaltyPoints;
  await W.checkBirthdayReward();
  { const sent = lastSent('checkBirthdayReward');
    const ptsAfter = (await db.doc(`posCustomers/${A}_254711000001`).get()).data().loyaltyPoints;
    ok(sent && sent.phone === '254711000001', 'F-3', 'checkBirthdayReward receives the customer\'s phone: ' + JSON.stringify(sent));
    ok(ptsAfter === ptsBefore + 200 && TOAST.some((t) => /reward given: 200 points/.test(t)) && !TOAST.some((t) => /No birthday reward/.test(t)), 'F-4',
      'the server AWARDED 200 points, and the page says so — never "No birthday reward" after an award: ' + TOAST.join(' | ')); }
  clearToasts();
  await W.checkBirthdayReward();
  ok(TOAST.some((t) => /No birthday reward given: Already rewarded this year/.test(t)), 'F-5', 'a second check reports the server\'s actual reason: ' + TOAST.join(' | '));

  process.stdout.write('\n[S] store credit keeps its manager gate\n');
  ELS.scAmount = el('scAmount'); ELS.scAmount.value = '50'; ELS.scReason = el('scReason'); ELS.scReason.value = 'goodwill';
  clearToasts();
  const credBefore = (await db.doc(`posCustomers/${A}_254711000001`).get()).data().storeCredit;
  await W.doStoreCredit();
  { const sent = lastSent('issueStoreCredit');
    const credAfter = (await db.doc(`posCustomers/${A}_254711000001`).get()).data().storeCredit;
    ok(sent && sent.phone === '254711000001' && sent.customerId === undefined, 'S-1', 'issueStoreCredit receives the customer\'s phone: ' + JSON.stringify(sent));
    ok(credAfter === credBefore && TOAST.some((t) => /Requires manager role/.test(t)), 'S-2', 'without a manager role the credit is REFUSED by its existing gate, and nothing is credited: ' + TOAST.join(' | ')); }
  AUTH = { uid: A, token: { uid: A, role: 'seller', posRole: 'manager' } };   /* test-only claim: proves the CONTRACT, not the gate */
  await W.doStoreCredit();
  ok((await db.doc(`posCustomers/${A}_254711000001`).get()).data().storeCredit === credBefore + 50, 'S-3', 'with a manager role (test-only claim — nothing mints posRole) the same payload credits the customer: the contract is right, the gate is unchanged');
  AUTH = { uid: A, token: { uid: A, role: 'seller' } };

  process.stdout.write('\n[W] the wallet screen\n');
  ELS.walletPhone = el('walletPhone'); ELS.walletPhone.value = '0711000002';
  ELS.walletCustomerName = el('walletCustomerName'); ELS.walletAmount = el('walletAmount'); ELS.walletDisplay = el('walletDisplay'); ELS.walletTxBody = el('walletTxBody');
  clearToasts();
  await W.loadWallet();
  { const sent = lastSent('getPOSCustomer');
    ok(sent && sent.phone === '0711000002' && sent.query === undefined && ELS.walletCustomerName.textContent === 'Till Tom', 'W-1',
      'the wallet lookup sends { phone } and names the customer from the unwrapped response: ' + JSON.stringify(sent) + ' → ' + ELS.walletCustomerName.textContent + (TOAST.length ? ' | toast: ' + TOAST.join(' | ') : '')); }

  process.stdout.write('\n[P] page freshness is unchanged\n');
  ok(/<script src="shared-header\.js"><\/script>/.test(html), 'P-1', 'the page still loads shared-header.js (which injects sw-register.js)');

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
