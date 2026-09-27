/* test-money-integrity.js — nothing may say "paid" or "confirmed" without a server-confirmed payment (CHANGELOG 215).
 * The REAL pages in Chromium (scripts/lib/page-harness.js) + the REAL impact.js on the transactional fake.
 * No network, no production.
 *
 * PROVES
 *   bnb.html      Confirm Booking writes NO booking and says nothing was charged (was: a failed retired M-PESA call
 *                 or a 4-second SIMULATED "Payment confirmed!" wrote a CONFIRMED stay)
 *   car-hub.html  Confirm writes no rental / fee / commission, sends nothing to WhatsApp and never claims "STK push
 *                 sent" (none was)
 *   landlord.html Collect rent never marks the month paid — no simulated 3-second "Payment Confirmed", no
 *                 browser-decided IntaSend widget
 *   impact.js     a checkout donation that was not charged is a PLEDGE: no receipt, no Foundation ledger credit,
 *                 no totals
 *
 *   node scripts/test-money-integrity.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-money-integrity';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const SPY = () => { window.__opened = []; const o = window.open; window.open = (u) => { window.__opened.push(String(u)); return null; }; void o; };

(async () => {
  say('\n── impact.js: an uncharged checkout donation is a pledge ──');
  const IMP = require(Path.join(FN, 'impact.js'));
  /* a throw is a FAILED check, never a crash (a ledger write inside this transaction reads after writing) */
  const r = await IMP.impactCheckoutDonate.run({ auth: { uid: 'u1', token: {} }, data: { amount: 250, orderId: 'ORD9', destination: 'Education', type: 'checkout' }, rawRequest: { headers: {} } }).catch((e) => ({ threw: e.message }));
  const don = db._dump('foundationDonations/')[0] || {};
  ck('the donation is recorded as a PLEDGE (not "completed"), with no receipt number', r.status === 'pledged' && don.status === 'pledged' && don.paymentStatus === 'not_collected' && !don.receiptNo && !don.completedAt, don);
  ck('…the Foundation LEDGER is not credited and the totals do not grow', db._dump('foundationLedger/').length === 0 && !(await db.doc('foundationStats/current').get()).exists);

  const HAR = makePageHarness({ db, root: ROOT });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const user = { uid: 'u1', email: 'u1@x.co', emailVerified: true };
  const storage = { loggedIn: 'true', sokoniUser: JSON.stringify({ uid: 'u1', name: 'Wanjiku', role: 'buyer' }) };
  try {
    say('\n── bnb.html ──');
    const B = await HAR.page(browser, { user, storage, viewport: { width: 390, height: 844 } });
    await B.addInitScript(SPY);
    await B.goto(HAR.BASE + '/bnb.html');
    await B.waitForFunction(() => typeof confirmBooking === 'function', null, { timeout: 10000 }).catch(() => {});
    const bnb = await B.evaluate(async () => {
      const saved = []; window._saveBnBBookingFS = async (bk) => { saved.push(bk); return { ok: true, id: 'x' }; };
      window._bnbAuthUid = 'u1';
      for (const [id, v] of [['bookName', 'Wanjiku'], ['bookPhone', '0712345678'], ['bookIn', '2026-10-10'], ['bookOut', '2026-10-12']]) { let el = document.getElementById(id); if (!el) { el = document.createElement('input'); el.id = id; document.body.appendChild(el); } el.value = v; }
      const b = document.createElement('button'); b.className = 'modal-confirm-btn'; document.body.appendChild(b);
      window.SokoniMpesa = { pay: (o) => o.onFailure && o.onFailure('M-PESA by phone number has been retired') };   /* the retired rail */
      /* every text the page shows during the window (toasts come and go) */
      const seen = [];
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => seen.push(n.textContent || '')))).observe(document.body, { childList: true, subtree: true, characterData: true });
      confirmBooking('bnb1');
      await new Promise((r) => setTimeout(r, 7000));    /* longer than the old 4 s + 2 s simulated confirmation */
      return { saved, text: seen.join(' | ') + ' | ' + document.body.innerText, opened: window.__opened };
    });
    ck('no stay is written — not by the retired rail\'s failure, not by a simulated confirmation', bnb.saved.length === 0, bnb.saved);
    ck('…the guest is told nothing was booked or charged; no "Payment confirmed!" / "Booking confirmed!"', /nothing was booked or charged/.test(bnb.text) && !/Payment confirmed!|Booking confirmed!/.test(bnb.text));
    ck('…nothing is handed to WhatsApp', !bnb.opened.some((u) => /wa\.me|whatsapp/.test(u)), bnb.opened);

    say('\n── car-hub.html ──');
    const C = await HAR.page(browser, { user, storage: Object.assign({ sokoniCarFleet: JSON.stringify([{ id: 'c1', make: 'Toyota', model: 'Vitz', plate: 'KDA 123A', priceDay: 3000, deposit: 5000, owner: 'Owner', ownerPhone: '0722000000', status: 'available' }]) }, storage), viewport: { width: 390, height: 844 } });
    await C.addInitScript(SPY);
    await C.goto(HAR.BASE + '/car-hub.html');
    await C.waitForFunction(() => typeof confirmBooking === 'function', null, { timeout: 10000 }).catch(() => {});
    const car = await C.evaluate(async () => {
      for (const [id, v] of [['bkName', 'Wanjiku'], ['bkPhone', '0712345678'], ['pickupDate', '2026-10-10'], ['returnDate', '2026-10-12']]) { let el = document.getElementById(id); if (!el) { el = document.createElement('input'); el.id = id; document.body.appendChild(el); } el.value = v; }
      let m = document.getElementById('bookingMsg'); if (!m) { m = document.createElement('div'); m.id = 'bookingMsg'; document.body.appendChild(m); }
      currentBookingCarId = 'c1';
      const fees = []; if (window.SokoniPay) { SokoniPay.saveFee = (f) => fees.push(f); SokoniPay.saveCommission = (f) => fees.push(f); }
      confirmBooking();
      await new Promise((r) => setTimeout(r, 1500));
      return { msg: m.innerText, bookings: localStorage.getItem('sokoniCarBookings'), fleet: JSON.parse(localStorage.getItem('sokoniCarFleet'))[0].status, opened: window.__opened, fees };
    });
    ck('no rental is recorded and the car is not marked rented', (!car.bookings || car.bookings === '[]') && car.fleet === 'available', car);
    ck('…never "STK push sent" / "confirmed"; says nothing was booked or charged', /nothing was booked or charged/.test(car.msg) && !/STK push sent|confirmed/i.test(car.msg), car.msg);
    ck('…no fee "paid" / commission recorded, nothing to WhatsApp', car.fees.length === 0 && !car.opened.some((u) => /wa\.me/.test(u)), { fees: car.fees, opened: car.opened });

    say('\n── landlord.html ──');
    const props = [{ id: 'p1', name: 'Block A', units: [{ id: 'u1', number: '1A', rent: 15000, tenant: 'Otieno', tenantPhone: '0711111111', rentHistory: [] }] }];
    const L = await HAR.page(browser, { user, storage: Object.assign({ sokoniLandlordProperties: JSON.stringify(props) }, storage), viewport: { width: 390, height: 844 } });
    await L.goto(HAR.BASE + '/landlord.html');
    await L.waitForFunction(() => typeof window.openCollectRent === 'function', null, { timeout: 10000 }).catch(() => {});
    const ll = await L.evaluate(async () => {
      let intasend = 0; window.IntaSend = function () { intasend++; return { on() { return this; }, run() { return this; } }; };
      window.SokoniMpesa = { pay: (o) => o.onSuccess && o.onSuccess({ mpesaCode: 'FAKE' }) };   /* even a rail claiming success */
      window.openCollectRent('p1', 'u1');
      document.getElementById('collectRentPhone').value = '0711111111';
      window.sendRentStkPush();
      await new Promise((r) => setTimeout(r, 4500));    /* longer than the old 3 s simulated confirmation */
      const unit = JSON.parse(localStorage.getItem('sokoniLandlordProperties'))[0].units[0];
      return { history: unit.rentHistory, result: (document.getElementById('collectRentResult') || {}).innerText, intasend };
    });
    ck('the month is NEVER marked paid by this page (no simulated, browser-decided or retired-rail "payment")', Array.isArray(ll.history) && ll.history.length === 0 && ll.intasend === 0, ll);
    ck('…the landlord is told collection is being enabled and nothing was charged', /nothing was requested or charged/.test(ll.result || ''), ll.result);
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
