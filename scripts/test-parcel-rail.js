#!/usr/bin/env node
/* test-parcel-rail.js — Delivery Hub D5: Send a Parcel on the packageRequests rail.
 *
 * Drives the REAL functions from FUNCTIONS_DIR against the Firestore + Auth emulators:
 *   quote (pure) → getParcelQuote → createParcelRequest → payParcelRequest (mpesa + checkout,
 *   IntaSend transport FAKED) → confirmParcelPayment (server-verified, idempotent) → the board
 *   (availableDeliveries, real ID token) → claimAvailableDelivery → completeParcelWithPin.
 * Negative controls: a browser-forged kind:'parcel' job never reaches the board or a claim;
 * an unpaid parcel never reaches the board; a wrong PIN counts; one invoice pays one parcel.
 *
 *   firebase emulators:exec --only firestore,auth --project demo-parcel "node scripts/test-parcel-rail.js"
 */
'use strict';

/* ── EMULATOR-ONLY GUARD (2026-10-03) — runs BEFORE anything can load firebase-admin ──────────
   This suite DELETES EVERY COLLECTION it can list on startup. Pointed at production through
   application-default credentials it would wipe the live database (a test wrote to production
   through ADC on this machine on 2026-10-01). It therefore refuses — exit 3, nothing required —
   unless ALL of these hold:
     · FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST are both set, and each host is
       localhost or 127.0.0.1 (host:port);
     · every project-id source the Admin SDK reads (GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT,
       FIREBASE_CONFIG.projectId) that is set starts with "demo-", and at least one is set
       (a demo-* project can never resolve to a real Firebase project);
     · GOOGLE_APPLICATION_CREDENTIALS is NOT set (no service-account key in reach).
   Pure: only process.env is read; no module is required until the guard has passed.
   Proven by scripts/test-parcel-rail-guard.js. Never weaken; never bypass with a flag. */
(function emulatorOnlyGuard(env) {
  const refuse = (why) => { console.error('REFUSED test-parcel-rail: ' + why + ' — this suite deletes every collection; it runs ONLY against local emulators with a demo-* project.'); process.exit(3); };
  const localHost = (v) => { const m = /^(localhost|127\.0\.0\.1):(\d{1,5})$/.exec(String(v || '').trim()); return !!m && Number(m[2]) > 0 && Number(m[2]) < 65536; };
  if (env.GOOGLE_APPLICATION_CREDENTIALS) refuse('GOOGLE_APPLICATION_CREDENTIALS is set');
  for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    if (!env[k]) refuse(k + ' is not set');
    if (!localHost(env[k])) refuse(k + ' is not localhost/127.0.0.1:<port>');
  }
  const ids = [];
  if (env.GCLOUD_PROJECT) ids.push(['GCLOUD_PROJECT', env.GCLOUD_PROJECT]);
  if (env.GOOGLE_CLOUD_PROJECT) ids.push(['GOOGLE_CLOUD_PROJECT', env.GOOGLE_CLOUD_PROJECT]);
  if (env.FIREBASE_CONFIG) {
    let pid = null;
    try { pid = JSON.parse(env.FIREBASE_CONFIG).projectId || null; } catch (_) { refuse('FIREBASE_CONFIG is not inline JSON (cannot verify its projectId)'); }
    if (!pid) refuse('FIREBASE_CONFIG has no projectId');
    ids.push(['FIREBASE_CONFIG.projectId', pid]);
  }
  if (!ids.length) refuse('no project id is set (GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT)');
  for (const [k, v] of ids) if (!/^demo-[a-z0-9-]+$/.test(String(v))) refuse(k + ' "' + v + '" is not a demo-* project');
})(process.env);

const path = require('path');
process.env.FUNCTIONS_EMULATOR = 'true';
process.env.INTASEND_PRIVATE_KEY = 'test-key';
const FN_DIR = path.resolve(process.env.FUNCTIONS_DIR || path.join(__dirname, '..', 'functions'));
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const codeOf = async (p) => { try { const r = await p; return { ok: true, r }; } catch (e) { return { ok: false, code: e.code || e.message, message: e.message }; } };

(async () => {
  console.log('\nFUNCTIONS: ' + FN_DIR);
  const mod = require(path.join(FN_DIR, 'index.js'));
  const admin = require(require.resolve('firebase-admin', { paths: [FN_DIR] }));
  const { onCall, HttpsError } = require(require.resolve('firebase-functions/v2/https', { paths: [FN_DIR] }));
  const pr = require(path.join(FN_DIR, 'parcel-requests.js'));
  const rp = require(path.join(FN_DIR, 'rider-presence.js'));
  const db = admin.firestore();
  for (const c of await db.listCollections()) { const s = await c.get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
  if (rp._resetConfigCache) rp._resetConfigCache();

  /* ── fake IntaSend ── every call recorded; responses scripted per test ── */
  const calls = [];
  let gateway = { stk: null, checkout: null, collection: null };
  const transport = async (method, p, body, key) => {
    calls.push({ method, path: p, body, key });
    if (p.startsWith('/api/v1/payment/mpesa-stk-push/')) return gateway.stk;
    if (p.startsWith('/api/v1/checkout/')) return gateway.checkout;
    if (p.startsWith('/api/v1/payment/collection/')) return gateway.collection;
    return { status: 404, data: null };
  };
  let clock = Date.now();
  const P = pr.makeParcelRequests({ onCall, HttpsError, admin, db, INTASEND_PRIVATE_KEY: null, transport, now: () => clock });
  const call = (fn, uid, data, token) => fn.run({ auth: uid ? { uid, token: token || {} } : null, data: data || {} });

  /* ── rider helpers (as in test-d2-rider-presence.js) ── */
  const presence = (uid, action, extra) => mod.riderPresence.run({ auth: { uid, token: {} }, data: Object.assign({ action }, extra || {}) });
  const tokenFor = async (uid) => {
    try { await admin.auth().createUser({ uid }); } catch (_) {}
    const custom = await admin.auth().createCustomToken(uid);
    const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    return (await r.json()).idToken;
  };
  const feed = async (uid) => {
    const idToken = await tokenFor(uid);
    return new Promise((resolve) => {
      const res = { statusCode: 200, headers: {}, body: null,
        setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, on() {}, once() {}, emit() {}, removeListener() {}, writeHead(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; },
        send(b) { this.body = b; resolve(this); return this; }, end() { resolve(this); } };
      mod.availableDeliveries({ method: 'GET', url: '/', headers: { authorization: 'Bearer ' + idToken, origin: 'https://mysokoni.co.ke' }, query: {}, get(h) { return this.headers[h.toLowerCase()]; } }, res);
    });
  };
  const ids = (r) => ((r.body && r.body.deliveries) || []).map((d) => d.id);
  const claim = (uid, ref) => codeOf(mod.claimAvailableDelivery.run({ auth: { uid }, data: { deliveryRef: ref } }));
  const driver = async (uid, over = {}) => {
    await db.collection('drivers').doc(uid).set(Object.assign({ uid, name: 'Rider ' + uid, approved: true, status: 'approved', vehicleType: 'moto', phone: '0700000001' }, over));
    await db.collection('driverVerification').doc(uid).set({ documentsComplete: true, status: 'verified_on_file' });
  };

  console.log('\n── pricing is one catalogue, same arithmetic the browser showed ──');
  let q = pr.quote({ vehicleType: 'boda', distanceKm: 8, weight: 'medium', urgency: 'express' });
  ck('Q1  boda 8km medium express = 615 (150 + 280 + 43, ×1.3)', q.total === 615 && q.base === 150 && q.kmCharge === 280 && q.weightFee === 43 && q.urgencyFee === 142, q);
  ck('Q2  standard light has no surcharges', (() => { const x = pr.quote({ vehicleType: 'car', distanceKm: 10 }); return x.total === 1000 && x.weightFee === 0 && x.urgencyFee === 0; })(), null);
  let e = await codeOf(Promise.resolve().then(() => pr.quote({ vehicleType: 'boda', distanceKm: 30 })));
  ck('Q3  beyond the vehicle range is refused (boda 30km > 25)', !e.ok && e.code === 'failed-precondition', e);
  e = await codeOf(Promise.resolve().then(() => pr.quote({ vehicleType: 'rocket', distanceKm: 3 })));
  ck('Q4  unknown vehicle refused', !e.ok && e.code === 'invalid-argument', e);
  e = await codeOf(Promise.resolve().then(() => pr.quote({ vehicleType: 'boda', distanceKm: 0 })));
  ck('Q5  zero distance refused', !e.ok && e.code === 'invalid-argument', e);
  ck('Q6  active catalogue is approved and versioned', pr.activeCatalogue().approved === true && pr.ACTIVE_VERSION === 'parcel-2026-09-30', pr.ACTIVE_VERSION);

  console.log('\n── getParcelQuote: coordinates REQUIRED (owner rule); anyone may check; only a sender gets a claimable quote ──');
  const PK = { lat: -1.2921, lng: 36.8219 }, DR = { lat: -1.2921, lng: 36.8772 };   /* ≈6.15 km → ×1.3 ≈ 8.0 km */
  let r = await call(P.getParcelQuote, null, { vehicleType: 'boda', distanceKm: 8, weight: 'medium', urgency: 'express' });
  ck('G0a no coordinates → quote_unavailable, even with a typed distance (never read)', r.ok === false && r.state === 'quote_unavailable' && r.reason === 'coordinates_required' && r.quote === undefined, r);
  r = await call(P.getParcelQuote, null, { vehicleType: 'boda', distanceKm: 8, pickup: PK, dropoff: { lat: 999, lng: 36.9 } });
  ck('G0b invalid drop-off coordinates → quote_unavailable', r.ok === false && r.state === 'quote_unavailable' && r.reason === 'dropoff_coordinates_required', r);
  r = await call(P.getParcelQuote, null, { vehicleType: 'boda', dropoff: DR });
  ck('G0c missing pickup → quote_unavailable', r.ok === false && r.reason === 'pickup_coordinates_required', r);
  ck('G0d nothing was written by unavailable quotes', (await db.collection('parcelQuotes').get()).size === 0, null);
  r = await call(P.getParcelQuote, null, { vehicleType: 'boda', distanceKm: 99, pickup: PK, dropoff: DR, weight: 'medium', urgency: 'express' });
  const expect8 = pr.quote({ vehicleType: 'boda', distanceKm: r.quote && r.quote.distanceKm, weight: 'medium', urgency: 'express' });
  ck('G1  guest with coordinates gets the SERVER distance (≈8 km; the typed 99 is ignored), the price for it and the rate card, no quoteId', r.ok && r.distanceSource === 'server_coords' && r.quote.distanceKm > 7.5 && r.quote.distanceKm < 8.5 && r.quote.total === expect8.total && r.quoteId === null && r.catalogue.vehicles.boda.base === 150, r);
  const TOTAL = r.quote.total;
  r = await call(P.getParcelQuote, null, { catalogueOnly: true });
  ck('G2  catalogueOnly returns the rate card', r.ok && r.catalogue && Object.keys(r.catalogue.vehicles).length === 8, r);
  r = await call(P.getParcelQuote, 'sender', { vehicleType: 'boda', distanceKm: 99, pickup: { lat: -1.2921, lng: 36.8219 }, dropoff: { lat: -1.3032, lng: 36.7073 } });
  ck('G3  with both coordinates the SERVER distance wins over the declared 99km', r.ok && r.distanceSource === 'server_coords' && r.quote.distanceKm > 10 && r.quote.distanceKm < 25, r.quote && r.quote.distanceKm);
  const qBefore = (await db.collection('parcelQuotes').get()).size;
  r = await call(P.getParcelQuote, 'sender', { vehicleType: 'boda', pickup: PK, dropoff: DR, preview: true });
  ck('G1b a signed-in PRICE CHECK (preview) prices but writes nothing and gets no quoteId', r.ok && r.quote.total > 0 && r.quoteId === null && (await db.collection('parcelQuotes').get()).size === qBefore, { r: r.quoteId, before: qBefore });
  r = await call(P.getParcelQuote, 'sender', { vehicleType: 'boda', pickup: PK, dropoff: DR, weight: 'medium', urgency: 'express' });
  const quoteId = r.quoteId;
  const qdoc = (await db.collection('parcelQuotes').doc(quoteId).get()).data();
  ck('G4  signed-in sender gets a stored, issued quote with a TTL', !!quoteId && qdoc.status === 'issued' && qdoc.uid === 'sender' && qdoc.quote.total === TOTAL, qdoc);

  console.log('\n── createParcelRequest: claims the quote once, writes record + job as pending_payment ──');
  await db.collection('users').doc('rcpt').set({ uid: 'rcpt', name: 'Jane Recipient', phone: '0712345678' });
  const form = { quoteId, pickupAddress: 'Westlands, Nairobi', deliveryAddress: 'Kasarani, Nairobi', recipientName: 'Jane', recipientPhone: '0712345678', senderPhone: '0722000000', senderName: 'Sam', packageType: 'documents', notes: 'fragile', pickupCoords: { lat: -1.26, lng: 36.80 }, deliveryCoords: { lat: -1.22, lng: 36.90 } };
  e = await codeOf(call(P.createParcelRequest, 'thief', form));
  ck('C1  another user cannot spend the sender\'s quote', !e.ok && e.code === 'permission-denied', e);
  e = await codeOf(call(P.createParcelRequest, 'sender', Object.assign({}, form, { recipientPhone: '' })));
  ck('C2  recipient phone is required', !e.ok && e.code === 'invalid-argument', e);
  e = await codeOf(call(P.createParcelRequest, 'sender', Object.assign({}, form, { recipientPhone: '12345' })));
  ck('C3  a non-Kenyan phone is refused', !e.ok && e.code === 'invalid-argument', e);
  e = await codeOf(call(P.createParcelRequest, 'sender', Object.assign({}, form, { recipientPhone: '0799999999' })));
  ck('C3b a recipient WITHOUT a SOKONI account is refused (owner rule)', !e.ok && e.code === 'failed-precondition' && /SOKONI account/.test(e.message), e);
  ck('C3c … and nothing was written for it', (await db.collection('parcelRequests').get()).size === 0, null);
  r = await call(P.createParcelRequest, 'sender', form);
  const parcelId = r.parcelId, jobId = r.deliveryRef;
  ck('C4  created: PRC job id, fee = quoted total, 6-digit PIN returned once, pending_payment', r.ok && jobId === 'PRC' + parcelId && r.deliveryFee === TOTAL && /^\d{6}$/.test(r.proofPIN) && r.status === 'pending_payment', r);
  const PIN = r.proofPIN;
  let prec = (await db.collection('parcelRequests').doc(parcelId).get()).data();
  let job = (await db.collection('packageRequests').doc(jobId).get()).data();
  ck('C5  server record: unpaid, pending_payment, pin stored server-side, payout state honest', prec.payment.state === 'unpaid' && prec.status === 'pending_payment' && prec.pin === PIN && prec.riderPayoutState === 'pending_manual' && prec.deliveryFee === TOTAL, prec);
  ck('C6  job doc: kind parcel, sender uid, recipient resolved to an account (buyerUid grant), areas coarse, phones normalised, no PIN on it', job.kind === 'parcel' && job.uid === 'sender' && job.recipientUid === 'rcpt' && job.buyerUid === 'rcpt' && job.status === 'pending_payment' && job.pickupArea === 'Westlands' && job.deliveryAddressParts.area === 'Kasarani' && job.recipientPhone === '254712345678' && job.pin === undefined && job.proofPIN === undefined, job);
  const pk = (await db.collection('deliveryPickups').doc(jobId).get()).data();
  ck('C6b the parcel pickup is written to the F1 authority (deliveryPickups/{jobId}) with the sender\'s validated point', !!pk && pk.lat === form.pickupCoords.lat && pk.lng === form.pickupCoords.lng && pk.source === 'parcel_sender', pk);
  ck('C7  quote is now claimed and names the parcel', (await db.collection('parcelQuotes').doc(quoteId).get()).data().status === 'claimed', null);
  e = await codeOf(call(P.createParcelRequest, 'sender', form));
  ck('C8  the same quote cannot create a second parcel', !e.ok && e.code === 'failed-precondition', e);
  r = await call(P.getParcelQuote, 'sender', { vehicleType: 'boda', pickup: PK, dropoff: DR });
  clock += pr.QUOTE_TTL_MS + 1000;
  e = await codeOf(call(P.createParcelRequest, 'sender', Object.assign({}, form, { quoteId: r.quoteId })));
  ck('C9  an expired quote cannot create a parcel', !e.ok && e.code === 'failed-precondition', e);
  clock -= pr.QUOTE_TTL_MS + 1000;

  console.log('\n── the board never lists an unpaid parcel ──');
  await driver('r1'); await presence('r1', 'online');
  let f = await feed('r1');
  ck('B1  online rider sees an empty board while the parcel is unpaid', f.statusCode === 200 && ids(f).length === 0, { code: f.statusCode, ids: ids(f) });
  let c = await claim('r1', jobId);
  ck('B2  claiming the unpaid parcel is refused', !c.ok && c.code === 'failed-precondition', c);

  console.log('\n── payParcelRequest: server-initiated, both IntaSend methods, never "paid" from the browser ──');
  gateway.stk = { status: 200, data: { id: 'chk_1', invoice: { invoice_id: 'INV1', state: 'PENDING' } } };
  e = await codeOf(call(P.payParcelRequest, 'thief', { parcelId, method: 'mpesa', phone: '0722000000' }));
  ck('P1  only the sender can start a payment', !e.ok && e.code === 'permission-denied', e);
  e = await codeOf(call(P.payParcelRequest, 'sender', { parcelId, method: 'mpesa' }));
  ck('P2  M-PESA needs a phone', !e.ok && e.code === 'invalid-argument', e);
  r = await call(P.payParcelRequest, 'sender', { parcelId, method: 'mpesa', phone: '0722000000' });
  const stkCall = calls.find((x) => x.path.startsWith('/api/v1/payment/mpesa-stk-push/'));
  ck('P3  STK push sent with the SERVER amount and api_ref = parcelId', r.ok && r.state === 'pending' && r.invoiceId === 'INV1' && stkCall.body.amount === TOTAL && stkCall.body.api_ref === parcelId && stkCall.body.phone_number === '254722000000' && stkCall.key === 'test-key', { r, body: stkCall && stkCall.body });
  prec = (await db.collection('parcelRequests').doc(parcelId).get()).data();
  ck('P4  record shows pending mpesa with the invoice, still NOT paid', prec.payment.state === 'pending' && prec.payment.method === 'mpesa' && prec.payment.invoiceId === 'INV1' && prec.status === 'pending_payment', prec.payment);
  gateway.checkout = { status: 201, data: { id: 'co_9', url: 'https://sandbox.intasend.com/checkout/co_9', signature: 'sig' } };
  r = await call(P.payParcelRequest, 'sender', { parcelId, method: 'checkout', email: 'sam@example.com' });
  const coCall = calls.find((x) => x.path.startsWith('/api/v1/checkout/'));
  ck('P5  hosted checkout (card/bank/Airtel/M-PESA) returns the gateway URL, api_ref = parcelId, redirect back to the parcel page', r.ok && r.url === 'https://sandbox.intasend.com/checkout/co_9' && coCall.body.api_ref === parcelId && coCall.body.amount === TOTAL && /delivery\.html\?paid=/.test(coCall.body.redirect_url), { r, body: coCall && coCall.body });
  e = await codeOf(call(P.payParcelRequest, 'sender', { parcelId, method: 'bitcoin' }));
  ck('P6  unknown method refused', !e.ok && e.code === 'invalid-argument', e);

  console.log('\n── confirmParcelPayment: IntaSend is asked; api_ref, state and amount must all agree ──');
  gateway.collection = { status: 200, data: { results: [{ invoice_id: 'INV1', api_ref: parcelId, state: 'PENDING', value: String(TOTAL) + '.00' }] } };
  r = await call(P.confirmParcelPayment, 'sender', { parcelId });
  ck('F1  PENDING at the gateway → not paid', r.ok === false && r.state === 'pending', r);
  gateway.collection = { status: 200, data: { results: [{ invoice_id: 'INV1', api_ref: 'someone-else', state: 'COMPLETE', value: String(TOTAL) + '.00' }] } };
  r = await call(P.confirmParcelPayment, 'sender', { parcelId });
  ck('F2  a COMPLETE payment for a DIFFERENT api_ref does not pay this parcel', r.ok === false && r.state === 'not_found', r);
  gateway.collection = { status: 200, data: { results: [{ invoice_id: 'INV1', api_ref: parcelId, state: 'COMPLETE', value: '100.00' }] } };
  e = await codeOf(call(P.confirmParcelPayment, 'sender', { parcelId }));
  ck('F3  a short payment (100 < total) is refused, not rounded up', !e.ok && e.code === 'failed-precondition', e);
  ck('F3b … and the parcel is still unpaid', (await db.collection('parcelRequests').doc(parcelId).get()).data().payment.state === 'pending', null);
  gateway.collection = { status: 200, data: { results: [{ invoice_id: 'INV1', api_ref: parcelId, state: 'COMPLETE', value: String(TOTAL) + '.00', mpesa_reference: 'QX1ABC', provider: 'M-PESA' }] } };
  e = await codeOf(call(P.confirmParcelPayment, 'thief', { parcelId }));
  ck('F4  a stranger cannot confirm', !e.ok && e.code === 'permission-denied', e);
  r = await call(P.confirmParcelPayment, 'sender', { parcelId });
  prec = (await db.collection('parcelRequests').doc(parcelId).get()).data();
  job = (await db.collection('packageRequests').doc(jobId).get()).data();
  const claimDoc = (await db.collection('parcelPayments').doc('INV1').get()).data();
  ck('F5  COMPLETE + api_ref + amount → PAID: record awaiting_rider, job awaiting_rider, invoice claimed', r.ok && r.state === 'paid' && prec.payment.state === 'paid' && prec.status === 'awaiting_rider' && job.status === 'awaiting_rider' && job.paymentState === 'paid' && claimDoc && claimDoc.parcelId === parcelId, { r, pay: prec.payment, job: job.status, claimDoc });
  ck('F5b in-app receipt on the job: number, amount, method, M-PESA ref, paid-at timestamp, breakdown', job.receipt && job.receipt.receiptNo === 'INV1' && job.receipt.amount === TOTAL && job.receipt.mpesaReference === 'QX1ABC' && job.receipt.paidAt && job.receipt.breakdown && job.receipt.breakdown.total === TOTAL && job.paidAt, job.receipt);
  r = await call(P.confirmParcelPayment, 'sender', { parcelId });
  ck('F6  confirming again is a no-op (alreadyPaid)', r.ok && r.alreadyPaid === true, r);
  /* one invoice, one parcel: a second parcel pointing at INV1 must be refused */
  r = await call(P.getParcelQuote, 'sender', { vehicleType: 'boda', pickup: PK, dropoff: DR });
  r = await call(P.createParcelRequest, 'sender', Object.assign({}, form, { quoteId: r.quoteId }));
  const parcel2 = r.parcelId, job2 = r.deliveryRef;
  gateway.collection = { status: 200, data: { results: [{ invoice_id: 'INV1', api_ref: parcel2, state: 'COMPLETE', value: '9999.00' }] } };
  e = await codeOf(call(P.confirmParcelPayment, 'sender', { parcelId: parcel2 }));
  ck('F7  the same invoice cannot pay a second parcel (claim is create(), not set())', !e.ok && e.code === 'failed-precondition', e);
  ck('F7b … second parcel still unpaid', (await db.collection('parcelRequests').doc(parcel2).get()).data().payment.state === 'unpaid', null);

  console.log('\n── the board: a PAID parcel appears, rider-safe; a forged one never does ──');
  await db.collection('packageRequests').doc('PRCforged').set({ kind: 'parcel', parcelId: 'forged', uid: 'attacker', status: 'awaiting_rider', deliveryFee: 5000, pickupArea: 'X', deliveryAddressParts: { area: 'Y' } });
  await db.collection('packageRequests').doc('PRC' + parcel2).set({ status: 'awaiting_rider', paymentState: 'paid' }, { merge: true }); /* job flipped from a browser, record unpaid */
  f = await feed('r1');
  const board = (f.body && f.body.deliveries) || [];
  const mine = board.find((d) => d.id === jobId);
  ck('L1  the paid parcel is on the board, and ONLY it (forged + unpaid-but-flipped refused)', f.statusCode === 200 && ids(f).length === 1 && !!mine, { code: f.statusCode, ids: ids(f) });
  ck('L2  board entry is a parcel with the server fee, coarse areas, F1 pickupKnown, trip length; rider→pickup distance null until the rider reports a position (never invented)', mine && mine.kind === 'parcel' && mine.deliveryFee === TOTAL && mine.pickupArea === 'Westlands' && mine.deliveryArea === 'Kasarani' && mine.pickupKnown === true && mine.tripKm > 0 && mine.distanceKm === null && mine.itemCount === 1, mine);
  ck('L3  board entry carries NO sender/recipient identity, street address or PIN', mine && mine.recipientPhone === undefined && mine.senderPhone === undefined && mine.recipientName === undefined && mine.deliveryAddress === undefined && mine.pin === undefined && mine.proofPIN === undefined, mine);
  ck('L4  rider earning is a number below the fee, or honestly null (never invented)', mine && (mine.riderEarning === null || (Number.isFinite(mine.riderEarning) && mine.riderEarning < TOTAL && mine.riderEarning > 0)), mine && mine.riderEarning);
  const vj = await rp.validateJob(db, Object.assign({ id: 'PRCforged' }, (await db.collection('packageRequests').doc('PRCforged').get()).data()));
  ck('L5  validateJob names the refusal for the forged job: parcel_missing', !vj.ok && vj.reason === 'parcel_missing', vj);
  c = await claim('r1', 'PRCforged');
  ck('L6  claiming the forged job is refused', !c.ok && c.code === 'failed-precondition', c);
  c = await claim('r1', 'PRC' + parcel2);
  ck('L7  claiming the flipped-but-unpaid job is refused', !c.ok && c.code === 'failed-precondition', c);

  console.log('\n── claim → both records assigned; a second rider is too late ──');
  await driver('r2'); await presence('r2', 'online');
  c = await claim('r1', jobId);
  job = (await db.collection('packageRequests').doc(jobId).get()).data();
  prec = (await db.collection('parcelRequests').doc(parcelId).get()).data();
  ck('K1  r1 claims: job driver_accepted with riderId, record follows', c.ok && job.status === 'driver_accepted' && job.riderId === 'r1' && job.assignedDriverId === 'r1' && prec.status === 'driver_accepted' && prec.riderId === 'r1', { c, job: job.status, prec: prec.status });
  c = await claim('r2', jobId);
  ck('K2  r2 is refused (already taken)', !c.ok && c.code === 'failed-precondition', c);
  f = await feed('r2');
  ck('K3  the claimed parcel is off the board', ids(f).length === 0, ids(f));

  console.log('\n── the sender re-reads the PIN; the assigned rider closes with it ──');
  r = await call(P.getMyParcelPin, 'sender', { parcelId });
  ck('N1  sender re-reads the PIN', r.ok && r.proofPIN === PIN, r);
  e = await codeOf(call(P.getMyParcelPin, 'r1', { parcelId }));
  ck('N2  the rider cannot read the PIN from the server', !e.ok && e.code === 'not-found', e);
  r = await call(P.getMyParcelPin, 'rcpt', { parcelId });
  ck('N2b the RECIPIENT can read the PIN (they hand it to the rider)', r.ok && r.proofPIN === PIN && r.role === 'recipient', r);
  e = await codeOf(call(P.completeParcelWithPin, 'r2', { deliveryRef: jobId, pin: PIN }));
  ck('N3  a rider who does not hold the job cannot complete it, even with the right PIN', !e.ok && e.code === 'permission-denied', e);
  const wrong = String((Number(PIN) + 1) % 1000000).padStart(6, '0');
  e = await codeOf(call(P.completeParcelWithPin, 'r1', { deliveryRef: jobId, pin: wrong }));
  prec = (await db.collection('parcelRequests').doc(parcelId).get()).data();
  ck('N4  wrong PIN refused and counted', !e.ok && e.code === 'permission-denied' && prec.pinAttempts === 1, { e, attempts: prec.pinAttempts });
  r = await call(P.completeParcelWithPin, 'r1', { deliveryRef: jobId, pin: PIN });
  job = (await db.collection('packageRequests').doc(jobId).get()).data();
  prec = (await db.collection('parcelRequests').doc(parcelId).get()).data();
  ck('N5  right PIN → delivered on job and record', r.ok && job.status === 'delivered' && prec.status === 'delivered' && prec.deliveredBy === 'r1', { r, job: job.status, prec: prec.status });
  r = await call(P.completeParcelWithPin, 'r1', { deliveryRef: jobId, pin: PIN });
  ck('N6  completing again is idempotent', r.ok && r.alreadyDelivered === true, r);
  for (let i = 0; i < pr.PIN_MAX_ATTEMPTS; i++) await db.collection('parcelRequests').doc(parcel2).set({ pinAttempts: pr.PIN_MAX_ATTEMPTS }, { merge: true });
  await db.collection('packageRequests').doc('PRC' + parcel2).set({ assignedDriverId: 'r1', riderId: 'r1', status: 'driver_accepted' }, { merge: true });
  e = await codeOf(call(P.completeParcelWithPin, 'r1', { deliveryRef: 'PRC' + parcel2, pin: '000000' }));
  ck('N7  after the attempt cap the PIN is locked (resource-exhausted)', !e.ok && e.code === 'resource-exhausted', e);
  e = await codeOf(call(P.completeParcelWithPin, 'r1', { deliveryRef: 'DELorder1', pin: '123456' }));
  ck('N8  an order job is not a parcel: not-found / failed-precondition, never completed here', !e.ok && (e.code === 'not-found' || e.code === 'failed-precondition'), e);

  console.log('\n── the order rail is untouched ──');
  await db.collection('orders').doc('o1').set({ uid: 'buyer', buyerUid: 'buyer', sellerUid: 'seller', sellerName: 'Shop', paymentVerified: true, status: 'awaiting_rider', deliveryFee: 1000, items: [{ n: 1 }] });
  await db.collection('packageRequests').doc('DELo1').set({ orderId: 'o1', sellerUid: 'seller', sellerName: 'Shop', status: 'awaiting_rider', pickupAddress: 'Shop A', deliveryFee: 1000 });
  await db.collection('paymentIntents').doc('o1').set({ purpose: 'product_order', resourceId: 'o1', metadata: { orderId: 'o1', deliveryFee: 1000 } });
  f = await feed('r2');
  const ord = ((f.body && f.body.deliveries) || []).find((d) => d.id === 'DELo1');
  ck('O1  a server-readied ORDER job still lists exactly as before (fee 1000, seller shop)', !!ord && ord.deliveryFee === 1000 && ord.sellerName === 'Shop' && ord.kind === undefined, ord);
  ck('O2  validateJob for an order without kind is unchanged (no_order when orderId missing)', (await rp.validateJob(db, { id: 'x' })).reason === 'no_order', null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
