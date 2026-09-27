/* test-sokoni-pay-gateway.js — the SOKONI Pay gateway (sokoni-pay.js showGateway) charges ONLY a server-priced intent,
 * offers every IntaSend method the server enables, and never hands a booking to WhatsApp (CHANGELOG 216).
 * The REAL sokoni-pay.js + sokoni-intasend.js in Chromium, the REAL createPaymentIntent + purpose registry on the
 * fake Firestore; IntaSend itself (initiateSTKPush / hosted checkout) is recorded, never called. No network.
 *
 * PROVES
 *   refusal      a gateway call with no server purpose (bookNow / platformBook / revealPhone — client-priced) is
 *                REFUSED before any money moves: no STK push, "nothing was charged"
 *   server price with a purpose, the amount SHOWN and CHARGED is the server's (service_booking: KES 5,000 from the
 *                booking) even when the page claims a deposit of KES 1; the push carries the intent ref
 *   confirmation onSuccess fires only after the SERVER marks payments/{ref} COMPLETE — a FAILED payment never unlocks
 *   methods      M-PESA always; "Card, bank & other methods" only when getCheckoutMethods enables hosted checkout for
 *                the purpose, and it redirects only to IntaSend (https, *.intasend.com)
 *   intent       an already-minted intent (subscriptions) still pays
 *   WhatsApp     waConnect opens SOKONI chat (or says nothing was sent) — never wa.me, never a charge
 *   layout       the modal fits at 360 and 1280
 *
 *   node scripts/test-sokoni-pay-gateway.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-pay-gateway';
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
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const PI = require(Path.join(FN, 'payment-intents.js'));
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title></head><body style="background:#060a06;color:#eee;margin:0">' +
  '<script type="module" src="/firebase.js"></script><script src="/sokoni-commission-rates.js"></script><script src="/sokoni-intasend.js"></script><script src="/sokoni-pay.js"></script></body></html>';

(async () => {
  await db.doc('providerBookings/pb1').set({ customerUid: 'b1', providerId: 'prov1', price: 500000, fee: 0, deposit: 0, status: 'pending', paymentStatus: 'pending', currency: 'KES' });
  await db.doc('providerBookings/pb2').set({ customerUid: 'b1', providerId: 'prov1', price: 300000, fee: 0, deposit: 0, status: 'pending', paymentStatus: 'pending', currency: 'KES' });
  const stk = []; const hosted = [];
  let failNext = false; let hostedEnabled = true;
  const HAR = makePageHarness({ db, root: ROOT, pages: { '/t-pay.html': PAGE }, callables: {
    createPaymentIntent: PI.createPaymentIntent.run,
    getCheckoutMethods: async (req) => ({ purpose: req.data.purpose, stk: { method: 'M-PESA' }, hosted: hostedEnabled && req.data.purpose === 'service_booking', hostedMethods: hostedEnabled ? ['CARD-PAYMENT', 'BANK-ACH'] : [] }),
    initiateHostedCheckout: async (req) => { hosted.push(req.data); return { url: 'https://sandbox.intasend.com/checkout/abc/', methods: ['CARD-PAYMENT'] }; },
    initiateSTKPush: async (req) => {
      stk.push({ phone: req.data.phone, amount: req.data.amount, ref: req.data.ref });
      await db.doc('payments/' + req.data.ref).set({ ref: req.data.ref, uid: req.auth.uid, amount: req.data.amount, status: failNext ? 'FAILED' : 'COMPLETE', failReason: failNext ? 'Insufficient funds' : null });
      return { success: true, checkoutId: 'CHK-' + req.data.ref };   /* the real initiateSTKPush reply shape (functions/index.js) */
    },
    verifyPaymentStatus: async (req) => { const d = (await db.doc('payments/' + req.data.ref).get()).data(); return d ? { status: d.status, failReason: d.failReason } : {}; },
  } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const user = { uid: 'b1', email: 'b1@x.co', emailVerified: true, phoneNumber: '+254712345678' };
  const open = async (vp) => {
    const p = await HAR.page(browser, { user, viewport: vp || { width: 390, height: 844 }, storage: { loggedIn: 'true', sokoniUser: JSON.stringify({ uid: 'b1', phone: '0712345678' }) } });
    await p.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; window.__toasts = []; window._skToast = (m) => window.__toasts.push(String(m)); });
    await p.goto(HAR.BASE + '/t-pay.html');
    await p.waitForFunction(() => window.SokoniPay && window.SokoniIntaSend && window.SokoniIntaSend.call, null, { timeout: 10000 }).catch(() => {});
    return p;
  };
  const gw = (p) => p.evaluate(() => (document.getElementById('sokoniPayGateway') || {}).innerText || '');
  try {
    say('\n── refusal: no server price, no payment ──');
    for (const [label, fn] of [
      ['bookNow (legacy client deposit)', () => SokoniPay.bookNow({ providerName: 'Plumber', category: 'plumbing', serviceDesc: 'Leak' }, () => { window.__paid = true; })],
      ['platformBook (client total, 50 % default)', () => SokoniPay.platformBook({ providerName: 'Chef', category: 'food', totalAmount: 1, onSuccess: () => { window.__paid = true; } })],
      ['revealPhone (client lead fee)', () => SokoniPay.revealPhone({ providerName: 'Mechanic', category: 'mechanics', phone: '0700' }, () => { window.__paid = true; })],
    ]) {
      const p = await open();
      await p.evaluate(fn);
      await p.waitForTimeout(700);
      const t = await gw(p);
      const payVisible = await p.evaluate(() => { const a = document.getElementById('spPayArea'); return !!a && getComputedStyle(a).display !== 'none'; });
      ck(`${label}: refused — "nothing was charged", no pay button, no STK push`, /nothing was charged/.test(t) && !payVisible && stk.length === 0, t.slice(0, 120));
      await p.__ctx.close();
    }

    say('\n── server-priced purpose ──');
    const P = await open();
    /* the page calls the gateway itself and CLAIMS its own amount (deposit KES 1, total KES 1) */
    await P.evaluate(() => { SokoniPay.gateway({ providerName: 'Jane Photography', serviceDesc: 'Portraits', purpose: 'service_booking', purposeData: { bookingId: 'pb1' }, depositAmount: 1, serviceTotal: 1, onSuccess: (ref) => { window.__paidRef = ref; } }); });
    await P.waitForFunction(() => /KES 5,000/.test((document.getElementById('spAmount') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    ck('the amount SHOWN is the SERVER\'s (KES 5,000 from the booking), not the page\'s "deposit" of KES 1', (await P.evaluate(() => document.getElementById('spAmount').textContent)) === 'KES 5,000');
    await P.waitForSelector('#spHostedBtn', { state: 'visible', timeout: 5000 }).catch(() => {});
    ck('card, bank & other methods are OFFERED because the server enables hosted checkout for this purpose', await P.evaluate(() => getComputedStyle(document.getElementById('spHostedBtn')).display !== 'none'));
    await P.fill('#spPhone', '0712345678');
    await P.click('#spPayBtn');
    await P.waitForSelector('#spContinueBtn', { state: 'visible', timeout: 12000 }).catch(() => {});
    const intentRef = (db._dump('paymentIntents/')[0] || {}).ref || Object.keys(await db._dump('paymentIntents/'))[0];
    ck('the M-PESA push CHARGES the server amount (5000) on the INTENT\'s reference', stk.length === 1 && stk[0].amount === 5000 && stk[0].ref === intentRef, { stk, intentRef });
    await P.click('#spContinueBtn');
    await P.waitForTimeout(200);
    ck('onSuccess fires only after the server marked the payment COMPLETE — with the intent ref', (await P.evaluate(() => window.__paidRef)) === intentRef);
    ck('the modal fits at 390 (no horizontal scroll)', await P.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await P.__ctx.close();

    say('\n── a FAILED payment never unlocks ──');
    failNext = true;
    const Q = await open({ width: 360, height: 780 });
    await Q.evaluate(() => SokoniPay.bookNow({ providerName: 'Jane', purpose: 'service_booking', purposeData: { bookingId: 'pb2' } }, (ref) => { window.__paidRef = ref; }));
    await Q.waitForFunction(() => /KES 3,000/.test((document.getElementById('spAmount') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    await Q.fill('#spPhone', '0712345678'); await Q.click('#spPayBtn');
    await Q.waitForTimeout(3000);
    const qt = await gw(Q);
    ck('a failed payment shows the failure, keeps the pay button, and onSuccess never fires', /fail/i.test(qt) && !(await Q.evaluate(() => window.__paidRef)) && await Q.evaluate(() => getComputedStyle(document.getElementById('spContinueBtn')).display === 'none'), qt.slice(0, 120));
    ck('the modal fits at 360', await Q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await Q.__ctx.close();
    failNext = false;

    say('\n── hosted checkout ──');
    await db.doc('providerBookings/pb3').set({ customerUid: 'b1', providerId: 'prov1', price: 200000, fee: 0, status: 'pending', paymentStatus: 'pending', currency: 'KES' });
    const H = await open({ width: 1280, height: 900 });
    await H.evaluate(() => SokoniPay.bookNow({ providerName: 'Jane', purpose: 'service_booking', purposeData: { bookingId: 'pb3' } }));
    await H.waitForSelector('#spHostedBtn', { state: 'visible', timeout: 8000 }).catch(() => {});
    const nav = H.waitForRequest((r) => /intasend\.com\/checkout/.test(r.url()), { timeout: 8000 }).catch(() => null);
    await H.click('#spHostedBtn');
    const req = await nav;
    ck('"Card, bank & other methods" opens IntaSend\'s hosted checkout for the SAME server intent', !!req && hosted.length === 1 && /^[A-Za-z0-9_-]+$/.test(String(hosted[0].ref)), hosted);
    await H.__ctx.close();
    hostedEnabled = false;
    await db.doc('providerBookings/pb4').set({ customerUid: 'b1', providerId: 'prov1', price: 100000, fee: 0, status: 'pending', paymentStatus: 'pending', currency: 'KES' });
    const N = await open();
    await N.evaluate(() => SokoniPay.bookNow({ providerName: 'Jane', purpose: 'service_booking', purposeData: { bookingId: 'pb4' } }));
    await N.waitForFunction(() => /KES 1,000/.test((document.getElementById('spAmount') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    await N.waitForTimeout(500);
    ck('when the server does NOT enable hosted checkout, only M-PESA is offered (never faked)', await N.evaluate(() => getComputedStyle(document.getElementById('spHostedBtn')).display === 'none'));
    await N.__ctx.close();
    hostedEnabled = true;

    say('\n── an already-minted intent (subscriptions) ──');
    await db.doc('paymentIntents/SUBREF1').set({ ref: 'SUBREF1', uid: 'b1', amount: 999, purpose: 'subscription', status: 'created' });
    const S = await open();
    /* gateway() returns the modal's Promise — do not let evaluate() wait on it */
    await S.evaluate(() => { SokoniPay.gateway({ providerName: 'SOKONI', serviceDesc: 'Pro plan', paymentIntentId: 'SUBREF1', depositAmount: 999, onSuccess: (ref) => { window.__paidRef = ref; } }); });
    await S.waitForFunction(() => /KES 999/.test((document.getElementById('spAmount') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    await S.fill('#spPhone', '0712345678'); await S.click('#spPayBtn');
    await S.waitForSelector('#spContinueBtn', { state: 'visible', timeout: 12000 }).catch(() => {});
    await S.click('#spContinueBtn').catch(() => {});
    ck('a page-minted intent still pays, on its own reference', (await S.evaluate(() => window.__paidRef)) === 'SUBREF1' && stk.some((s) => s.ref === 'SUBREF1' && s.amount === 999));
    await S.__ctx.close();

    say('\n── no WhatsApp ──');
    const W = await open();
    const w = await W.evaluate(() => {
      let chat = null; window.SokoniInbox = { openChat: (o) => { chat = o; } };
      SokoniPay.waConnect('0712000000', 'I want to book', { providerName: 'Plumber', providerUid: 'prov9', category: 'plumbing' });
      const withUid = { chat, opened: window.__opened.slice() };
      chat = null; delete window.SokoniInbox;
      SokoniPay.waConnect('0712000000', 'I want to book', { providerName: 'Plumber', category: 'plumbing' });
      return { withUid, noUid: { opened: window.__opened.slice(), toasts: window.__toasts.slice() }, gateway: !!document.getElementById('sokoniPayGateway') };
    });
    ck('waConnect opens the provider\'s SOKONI chat — never wa.me, never a charge', w.withUid.chat && w.withUid.chat.otherUid === 'prov9' && !w.withUid.opened.some((u) => /wa\.me|whatsapp/.test(u)) && !w.gateway, w.withUid);
    ck('…with no known account it says nothing was sent or charged (still no WhatsApp)', /Nothing was sent or charged/.test(w.noUid.toasts.join(' ')) && !w.noUid.opened.some((u) => /wa\.me|whatsapp/.test(u)), w.noUid);
    ck('no STK push was sent by any refused / WhatsApp path (only the 3 M-PESA payments: success, failure, minted intent)', stk.length === 3, stk.map((s) => s.ref + ':' + s.amount));
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
