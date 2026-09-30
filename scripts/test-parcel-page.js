#!/usr/bin/env node
/* test-parcel-page.js — Send a Parcel (hosting slice) in a real browser, hermetic.
 *
 * The page's Firebase modules (delivery-hub.js → firebase.js, sokoni-db.js, sokoni-init.js) are
 * replaced by stub modules served from memory; window.sokoniCallable is a scripted fake that
 * records every call. Every other origin is aborted. Nothing reaches production.
 *
 *   Q  no price without both points; a typed distance is impossible (the field is gone); with
 *      points the SERVER quote is rendered verbatim and Book is enabled only with a quoteId
 *   K  Just Check Pricing calls the quote with preview:true (no write) and states it is a quote
 *   B  Book → createParcelRequest carries the quoteId + both points; the payment modal opens with
 *      the server fee; M-PESA → payParcelRequest {method:'mpesa'} → confirmParcelPayment polled →
 *      success modal shows the server PIN and receipt line; card/bank → {method:'checkout'} → the
 *      gateway URL
 *   L  My Deliveries renders server records: pending_payment has Pay now + Cancel; a paid one has
 *      Track, Show PIN (getMyParcelPin) and Receipt (server receipt with timestamps); incoming
 *      parcels are labelled; spent = server paid amounts only
 *   S  no WhatsApp on the page; Support link present
 *   node scripts/test-parcel-page.js
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 400) + ']')); ok ? pass++ : fail++; };
const STUB_HUB = `
let _sent = null, _in = null;
const HUB = {
  listenSenderParcels(uid, cb){ _sent = cb; window.__pushSent = (l) => cb(l); return () => {}; },
  listenRecipientParcels(uid, cb){ _in = cb; window.__pushIn = (l) => cb(l); return () => {}; },
  async cancelParcel(id, uid){ window.__cancelled = (window.__cancelled||[]).concat([id]); },
};
export default HUB;`;
const STUB_DB = 'export default {};';
/* the real sokoni-routing.js would overwrite the init-script stub and call Nominatim (aborted) */
const STUB_ROUTING = "window.SokoniRouting = { geocode: async (q) => (/westlands/i.test(q) ? { lat: -1.2635, lng: 36.8035, display: 'Westlands' } : /kasarani/i.test(q) ? { lat: -1.2205, lng: 36.8977, display: 'Kasarani' } : null), getRoute: async () => null };";
(async () => {
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const srv = http.createServer((rq, rs) => { const u = decodeURIComponent(rq.url.split('?')[0]); let fp = path.join(ROOT, u === '/' ? 'index.html' : u); if (u === '/delivery-hub.js') { rs.writeHead(200, { 'Content-Type': 'application/javascript' }); rs.end(STUB_HUB); return; } /* auth-guard.js redirects a guest to login after a delay — the stub auth is not Firebase; neutralise it (as the D2 harness does) */ if (u === '/auth-guard.js') { rs.writeHead(200, { 'Content-Type': 'application/javascript' }); rs.end('/* neutralised in the hermetic harness */'); return; } if (u === '/sokoni-routing.js') { rs.writeHead(200, { 'Content-Type': 'application/javascript' }); rs.end(STUB_ROUTING); return; } if (u === '/sokoni-db.js' || u === '/sokoni-init.js' || u === '/firebase.js') { rs.writeHead(200, { 'Content-Type': 'application/javascript' }); rs.end(STUB_DB); return; } if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(rs); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.__calls = [];
    const CAT = { version: 'parcel-2026-09-30', approved: true, currency: 'KES', vehicles: { boda: { base: 150, perKm: 35, maxKm: 25 }, bicycle: { base: 100, perKm: 20, maxKm: 10 }, car: { base: 400, perKm: 60, maxKm: 80 }, pickup: { base: 1500, perKm: 90, maxKm: 200 }, van: { base: 2500, perKm: 110, maxKm: 300 }, truck: { base: 5000, perKm: 150, maxKm: 500 }, ref: { base: 3000, perKm: 130, maxKm: 300 }, flatbed: { base: 6000, perKm: 170, maxKm: 500 } } };
    const Q = { catalogueVersion: 'parcel-2026-09-30', currency: 'KES', vehicleType: 'boda', vehicleLabel: 'Boda Boda', distanceKm: 8, weight: 'light', urgency: 'standard', base: 150, kmCharge: 280, weightFee: 0, urgencyFee: 0, total: 430, eta: '15–40 min' };
    let confirmCalls = 0;
    window.sokoniCallable = (name) => async (data) => {
      window.__calls.push({ name, data });
      if (name === 'getParcelQuote') { if (data.catalogueOnly) return { data: { ok: true, catalogue: CAT } }; if (!data.pickup || !data.dropoff) return { data: { ok: false, state: 'quote_unavailable', reason: 'coordinates_required', catalogue: CAT } }; return { data: { ok: true, quoteId: data.preview ? null : 'q_1', expiresAt: Date.now() + 900000, distanceSource: 'server_coords', quote: Q, catalogue: CAT } }; }
      if (name === 'createParcelRequest') return { data: { ok: true, parcelId: 'p1', deliveryRef: 'PRCp1', deliveryFee: 430, distanceKm: 8, proofPIN: '482913', status: 'pending_payment' } };
      if (name === 'payParcelRequest') return { data: data.method === 'mpesa' ? { ok: true, state: 'pending', method: 'mpesa', invoiceId: 'INV1' } : { ok: true, state: 'pending', method: 'checkout', url: 'https://sandbox.intasend.com/checkout/co_9' } };
      if (name === 'confirmParcelPayment') { confirmCalls++; return { data: confirmCalls < 2 ? { ok: false, state: 'pending' } : { ok: true, state: 'paid', amount: 430, receipt: { receiptNo: 'INV1', amount: 430, method: 'mpesa', mpesaReference: 'QX1ABC', paidAt: new Date().toISOString() } } }; }
      if (name === 'getMyParcelPin') return { data: { ok: true, proofPIN: '482913', role: 'sender' } };
      return { data: { ok: false } };
    };
    window.SokoniRouting = { geocode: async (q) => (/westlands/i.test(q) ? { lat: -1.2635, lng: 36.8035, display: 'Westlands' } : /kasarani/i.test(q) ? { lat: -1.2205, lng: 36.8977, display: 'Kasarani' } : null), getRoute: async () => null };
    window.firebaseAuth = { currentUser: { uid: 'sender1' } };
    try { localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'sender1', name: 'Sam', phone: '0722000000', email: 's@x.com' })); } catch (_) {}
  });
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
  await page.goto(base + '/delivery.html', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
  const src = fs.readFileSync(path.join(ROOT, 'delivery.html'), 'utf8');
  ck('S1  no WhatsApp on the page; Support link present; no typed-distance input', !/wa\.me|bookDeliveryWA|SOKONI_WA/.test(src) && /support\.html\?topic=parcel/.test(src) && !/type="number" id="distKm"/.test(src) && !/type="number" id="calcKm"/.test(src), null);
  const q0 = await page.evaluate(() => ({ cat: window.__calls.filter((c) => c.name === 'getParcelQuote' && c.data.catalogueOnly).length, grid: (document.getElementById('vc_vehicleGrid_boda') || {}).textContent }));
  ck('Q0  the rate card is fetched from the server once and priced into the vehicle grid', q0.cat === 1 && /KES 150/.test(q0.grid || ''), q0);
  await page.evaluate(() => selectVehicle('boda')); await page.waitForTimeout(600);
  const q1 = await page.evaluate(() => ({ msg: document.getElementById('calcMsg').textContent, box: document.getElementById('priceBox').style.display, book: document.getElementById('bookBtn').disabled, quotes: window.__calls.filter((c) => c.name === 'getParcelQuote' && !c.data.catalogueOnly).length }));
  ck('Q1  vehicle chosen, no points → "Quote unavailable", no price box, Book disabled, NO quote call made', /Quote unavailable/.test(q1.msg) && q1.box === 'none' && q1.book === true && q1.quotes === 0, q1);
  await page.evaluate(([i,v]) => { document.getElementById(i).value = v; }, ['pickupAddr','Westlands']); await page.evaluate(() => onAddrInput()); await page.evaluate(([i,v]) => { document.getElementById(i).value = v; }, ['dropoffAddr','Kasarani']); await page.evaluate(() => onAddrInput()); await page.waitForTimeout(2000);
  const q2 = await page.evaluate(() => { const c = window.__calls.filter((x) => x.name === 'getParcelQuote' && !x.data.catalogueOnly).pop(); return { call: c && c.data, total: document.getElementById('prTotal').textContent, dist: document.getElementById('distKmView').textContent, book: document.getElementById('bookBtn').disabled, msg: document.getElementById('calcMsg').textContent }; });
  ck('Q2  both addresses geocoded → quote called with the two points, NO distanceKm, preview absent; server total rendered; Book enabled', q2.call && q2.call.pickup && q2.call.dropoff && q2.call.distanceKm === undefined && !q2.call.preview && /KES 430/.test(q2.total) && /8 km/.test(q2.dist) && q2.book === false, q2);
  await page.evaluate(() => { showDelTab('calc'); selectCalcVehicle('boda'); }); await page.waitForTimeout(300);
  await page.evaluate(([i,v]) => { document.getElementById(i).value = v; }, ['calcPickupAddr','Westlands']); await page.evaluate(() => onCalcAddrInput('pickup')); await page.evaluate(([i,v]) => { document.getElementById(i).value = v; }, ['calcDropoffAddr','Kasarani']); await page.evaluate(() => onCalcAddrInput('dropoff')); await page.waitForTimeout(2000);
  const k1 = await page.evaluate(() => { const c = window.__calls.filter((x) => x.name === 'getParcelQuote' && x.data.preview).pop(); return { call: c && c.data, total: document.getElementById('cpTotal').textContent, msg: document.getElementById('calcPricingMsg').textContent, creates: window.__calls.filter((x) => x.name === 'createParcelRequest').length }; });
  ck('K1  Just Check Pricing: quote called with preview:true and both points; price shown; says it is only a quote; nothing created', k1.call && k1.call.preview === true && k1.call.pickup && /KES 430/.test(k1.total) && /quote/i.test(k1.msg) && k1.creates === 0, k1);
  await page.evaluate(() => showDelTab('create'));
  await page.evaluate(([i,v]) => { document.getElementById(i).value = v; }, ['recipPhone','0712345678']); await page.evaluate(([i,v]) => { document.getElementById(i).value = v; }, ['recipName','Jane']);
  await page.evaluate(() => bookParcel()); await page.waitForTimeout(800);
  const b1 = await page.evaluate(() => { const c = window.__calls.filter((x) => x.name === 'createParcelRequest').pop(); return { call: c && c.data, modal: document.getElementById('payModal').style.display, amount: document.getElementById('payAmount').textContent, ref: document.getElementById('payRef').textContent }; });
  ck('B1  Book → createParcelRequest carries quoteId + both points + recipient phone; payment modal shows the server fee and ref', b1.call && b1.call.quoteId === 'q_1' && b1.call.pickupCoords && b1.call.deliveryCoords && b1.call.recipientPhone === '0712345678' && b1.modal === 'flex' && /430/.test(b1.amount) && b1.ref === 'PRCp1', b1);
  await page.evaluate(([i,v]) => { document.getElementById(i).value = v; }, ['payPhone','0722000000']); try { await page.evaluate(() => payParcelMpesa()); } catch (e) { console.log("  payParcelMpesa threw:", String(e.message).slice(0, 300)); } await page.waitForTimeout(9500);
  const b2 = await page.evaluate(() => { const g = (id) => document.getElementById(id); const pay = window.__calls.filter((x) => x.name === 'payParcelRequest').pop(); const conf = window.__calls.filter((x) => x.name === 'confirmParcelPayment').length; return { url: location.href, missing: ['successModal','successPIN','successReceipt','payModal'].filter((id) => !g(id)), pay: pay && pay.data, conf, success: g('successModal') && g('successModal').style.display, pin: g('successPIN') && g('successPIN').textContent, receipt: g('successReceipt') && g('successReceipt').textContent, payModal: g('payModal') && g('payModal').style.display, payMsg: g('payMsg') && g('payMsg').textContent }; });
  ck('B2  M-PESA → payParcelRequest {method:mpesa, phone}; confirmParcelPayment polled until the SERVER says paid; success modal shows the server PIN and receipt', b2.pay && b2.pay.method === 'mpesa' && b2.pay.phone === '0722000000' && b2.conf >= 2 && b2.success === 'flex' && b2.pin === '482913' && /INV1/.test(b2.receipt) && /QX1ABC/.test(b2.receipt) && b2.payModal === 'none', b2);
  const b3 = await page.evaluate(async () => { window.__calls.length = 0; _openPayModal({ parcelId: 'p2', deliveryRef: 'PRCp2', deliveryFee: 615 }, ''); const _h = location.href; let nav = null; const d = Object.getOwnPropertyDescriptor(window, 'location'); try { await payParcelCheckout(); } catch (e) { nav = 'err:' + e.message; } return { call: window.__calls.filter((x) => x.name === 'payParcelRequest').pop(), msg: document.getElementById('payMsg').textContent }; });
  ck('B3  Card/Bank/Airtel → payParcelRequest {method:checkout} and the page moves to the gateway URL', b3.call && b3.call.data.method === 'checkout' && /IntaSend checkout/.test(b3.msg), b3);
  await page.goto(base + '/delivery.html', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
  await page.evaluate(() => { window.__pushSent([
    { _fsId: 'PRCa', deliveryRef: 'PRCa', parcelId: 'a', uid: 'sender1', kind: 'parcel', status: 'pending_payment', paymentState: 'unpaid', deliveryFee: 430, pickupAddress: 'Westlands', deliveryAddress: 'Kasarani', recipientName: 'Jane', createdAt: Date.now() },
    { _fsId: 'PRCb', deliveryRef: 'PRCb', parcelId: 'b', uid: 'sender1', kind: 'parcel', status: 'awaiting_rider', paymentState: 'paid', deliveryFee: 615, pickupAddress: 'CBD', deliveryAddress: 'Ngong', recipientName: 'Ali', createdAt: Date.now() - 3600000, paidAt: Date.now() - 3000000, receipt: { receiptNo: 'INV9', amount: 615, method: 'mpesa', mpesaReference: 'QZ9', paidAt: Date.now() - 3000000 } },
  ]); window.__pushIn([{ _fsId: 'PRCc', deliveryRef: 'PRCc', parcelId: 'c', uid: 'other', buyerUid: 'sender1', kind: 'parcel', status: 'driver_accepted', paymentState: 'paid', deliveryFee: 300, senderName: 'Bob', pickupAddress: 'Thika', deliveryAddress: 'Westlands', createdAt: Date.now(), riderName: 'Rider R' }]); showDelTab('active'); });
  await page.waitForTimeout(400);
  const l1 = await page.evaluate(() => { const html = document.getElementById('activeDeliveriesList').innerHTML; return { cards: (html.match(/dlv-card/g) || []).length, payNow: /payAgain\('a'/.test(html), cancelA: /_cancelDelivery\('PRCa'/.test(html), trackB: /delivery-tracking\.html\?ref=PRCb/.test(html), pinB: /showParcelPin\('b'\)/.test(html), receiptB: /_showReceipt\(window\.__parcels\['PRCb'\]\)/.test(html), incoming: /Incoming from Bob/.test(html), noPinA: !/showParcelPin\('a'\)/.test(html), spent: document.getElementById('st-spend').textContent, support: /support\.html\?topic=parcel(&amp;|&)ref=PRCb/.test(html), noConfirmReceipt: !/Confirm Receipt/.test(html) }; });
  ck('L1  cards from server records: unpaid → Pay now + Cancel, no PIN; paid → Track + Show PIN + Receipt; incoming labelled; Support per card; no "Confirm Receipt"', l1.cards === 3 && l1.payNow && l1.cancelA && l1.trackB && l1.pinB && l1.receiptB && l1.incoming && l1.noPinA && l1.support && l1.noConfirmReceipt, l1);
  ck('L2  Spent = the server\'s paid amounts for MY parcels only (615), not quotes, not incoming', l1.spent === '615', l1.spent);
  await page.evaluate(() => showParcelPin('b')); await page.waitForTimeout(400);
  const l3 = await page.evaluate(() => ({ pin: (document.getElementById('pin_b') || {}).textContent, call: window.__calls.filter((x) => x.name === 'getMyParcelPin').pop() }));
  ck('L3  Show PIN asks the server (getMyParcelPin) and reveals it', l3.call && l3.call.data.parcelId === 'b' && l3.pin === '482913', l3);
  await page.evaluate(() => _showReceipt(window.__parcels['PRCb'])); await page.waitForTimeout(300);
  const l4 = await page.evaluate(() => ({ open: document.getElementById('receiptModal').style.display, body: document.getElementById('receiptBody').textContent }));
  ck('L4  Receipt modal renders the server receipt: number, amount, method, M-PESA ref, requested/paid timestamps', l4.open === 'flex' && /INV9/.test(l4.body) && /615/.test(l4.body) && /QZ9/.test(l4.body) && /Requested/.test(l4.body) && /Paid/.test(l4.body), l4);
  await page.evaluate(() => _cancelDelivery('PRCa', true)); await page.waitForTimeout(300);
  const l5 = await page.evaluate(() => window.__cancelled);
  ck('L5  Cancel on an unpaid parcel goes through DeliveryHub.cancelParcel', Array.isArray(l5) && l5.includes('PRCa'), l5);
  ck('E1  no page errors', errs.length === 0, errs);
  await browser.close(); srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
