/* test-event-ops-browser.js — the Events operations UI in a REAL browser against the REAL server logic.
 *
 * Chromium loads the real event-manager.html + sokoni-event-ops.js and event-hub.html. Every callable
 * the pages make is routed to Node, where the REAL functions/event-ops.js, event-sales.js,
 * event-refunds.js, event-hub.js (and financial-os's refund-request handler) run on the transactional
 * fake Firestore. So "the cashier sold a ticket" is proven by the sale, ticket and receivable the
 * server wrote — not by what the page displayed. No network, no provider, no production.
 *
 * FLOWS (at 390 and 1280 px)             OVERFLOW (at 360 · 390 · 768 · 1024 · 1280 · 1440 px)
 *   cashier (staff mode): only Quick Sale + Sales visible; cash sale → PIN shown; server: sale
 *     COMPLETED, ticket valid, 3 % receivable
 *   gate staff (staff mode): only PIN Admission; the buyer's PIN → Admit; server: ADMITTED once
 *   organizer: all event-day sections; invite staff → invitation stored; finance renders settled
 *     figures ("—" for unknown); dashboard revenue from settlements
 *   buyer: My Tickets shows the PIN; Refund wizard: reason → questions → server eligibility → submit;
 *     server: canonical refund request + tickets REQUESTED; an ineligible reason cannot be submitted
 *
 *   node scripts/test-event-ops-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-event-ops-browser';
process.env.INTASEND_PRIVATE_KEY = 'harness';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
/* The ticket commission is READ from the policy the server uses (→ commission-config.RATES.event_tickets), never
   typed here — the owner schedule of 2026-09-28 moved it from 3% to 5%, and a literal would have gone stale. */
const TICKET_PCT = require(Path.join(FN, 'shared', 'commercial-policy.js')).policyFor({ policyKey: 'event_ticket' }).pct;
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
/* Auth records carry the users' REAL custom claims: the organizer authority is the event_organizer claim. */
const authApi = { getUser: async (u) => ({ uid: u, customClaims: (typeof USERS !== 'undefined' && USERS[u] && USERS[u].claims) || {} }) };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi });
stub('./notify', { notify: async () => ({ ok: true }) });

const OPS = require(Path.join(FN, 'event-ops.js'));
const SALES = require(Path.join(FN, 'event-sales.js'));
const RF = require(Path.join(FN, 'event-refunds.js'));
const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
const EA = require(Path.join(FN, 'event-admin.js'));
const EI = require(Path.join(FN, 'entertainment-integrations.js'));
const CH = require(Path.join(FN, 'creator-hub.js'));
let _failListEvents = false;   /* flips listEvents to a service failure for the unavailable-state check */
/* The REAL payment-intent authority prices a cashier M-PESA order. The provider edge (initiateSTKPush →
   IntaSend → webhook) is the ONLY simulated part: see STK below. */
const INTENTS = require(Path.join(FN, 'payment-intents.js'));
const STK = [];
ES.registerPurpose();

const USERS = {
  org1: { uid: 'org1', email: 'org1@x.co', displayName: 'Kamau Events', claims: { event_organizer: true } },
  till1: { uid: 'till1', email: 'till1@x.co', displayName: 'Till One', claims: {} },
  gate1: { uid: 'gate1', email: 'gate1@x.co', displayName: 'Gate One', claims: {} },
  buyer1: { uid: 'buyer1', email: 'buyer1@x.co', displayName: 'Achieng Otieno', claims: {} },
  door9: { uid: 'door9', email: 'door9@x.co', displayName: 'Door Nine', claims: {} },
  admin1: { uid: 'admin1', email: 'ops@sokoni.test', displayName: 'Ops Admin', claims: { isAdmin: true } },
};
const reqFor = (uid, data) => ({ auth: uid && USERS[uid] ? { uid, token: { email: USERS[uid].email, email_verified: true, ...USERS[uid].claims } } : null, rawRequest: { headers: { 'user-agent': 'chromium-harness' } }, data });
/* Like the real callable protocol, results cross the wire as JSON: Timestamps become ISO strings. */
const wire = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x.toMillis === 'function' ? new Date(x.toMillis()).toISOString() : x)));
async function server(name, data, uid) {
  const r = await _server(name, data, uid);
  return r.ok !== undefined ? { ok: wire(r.ok) } : r;
}
async function _server(name, data, uid) {
  try {
    if (name === 'eventOpsDispatch') {
      const h = OPS._h[data.op] || SALES._h[data.op] || RF._h[data.op] || EI._h[data.op];
      if (!h) return { err: { code: 'not-found', message: 'unknown op ' + data.op } };
      return { ok: await h(reqFor(uid, data)) };
    }
    if (name === 'creatorDispatch') {
      const h = CH._internal.OPS[data.op];
      if (!h) return { err: { code: 'not-found', message: 'unknown op ' + data.op } };
      return { ok: await h(reqFor(uid, data)) };
    }
    if (name === 'adminOsDispatch') {
      const h = EA._adminH[data.op] || ES._adminH[data.op];
      if (!h) return { err: { code: 'not-found', message: 'unknown op ' + data.op } };
      return { ok: await h(reqFor(uid, data)) };
    }
    if (name === 'createPaymentIntent') return { ok: await INTENTS.createPaymentIntent.run(reqFor(uid, data)) };
    if (name === 'initiateSTKPush') {
      /* SIMULATED PROVIDER EDGE. Mirrors the two checks the real initiateSTKPush makes against the
         server-authored intent (owner + amount), records the push, then plays IntaSend's webhook:
         payments/{ref} COMPLETE → the real activation trigger body. No network. */
      const it = await get('paymentIntents/' + data.ref);
      if (!it) return { err: { code: 'not-found', message: 'no intent' } };
      if (it.uid && it.uid !== uid) return { err: { code: 'permission-denied', message: 'This payment does not belong to you.' } };
      if (Math.round(Number(it.amount)) !== Math.round(Number(data.amount))) return { err: { code: 'invalid-argument', message: 'Payment amount does not match this order.' } };
      STK.push({ uid, phone: data.phone, ref: data.ref, amount: data.amount });
      setTimeout(async () => {
        await db.doc('payments/' + data.ref).set({ ref: data.ref, uid, amount: it.amount, amountCents: Math.round(it.amount * 100), currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 30 } });
        await ES.activateIfEventTicket(data.ref);
      }, 800);
      return { ok: { ok: true, checkoutId: 'SIM-' + data.ref } };
    }
      if (name === 'listEvents' && _failListEvents) return { err: { code: 'unavailable', message: 'The service is temporarily unavailable.' } };
    const fnMap = { purchaseTickets: EH.purchaseTickets, getEvent: EH.getEvent, getMyTickets: EH.getMyTickets, getOrganizerDashboard: EH.getOrganizerDashboard, listEvents: EH.listEvents, searchEvents: EH.searchEvents };
    if (fnMap[name]) return { ok: await fnMap[name].run(reqFor(uid, data)) };
    return { ok: {} };
  } catch (e) { return { err: { code: e.code || 'internal', message: e.message } }; }
}

const COMPAT = `
(function(){
  window.__adds = [];
  const call = (name) => async (data) => { const r = await window.__srv(name, data || {}, window.__user && window.__user.uid); if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; throw e; } return { data: r.ok }; };
  const snap0 = { empty: true, docs: [], size: 0, forEach(){}, exists: false, data: () => ({}) };
  const q = (name) => ({ where(){ return q(name); }, limit(){ return q(name); }, orderBy(){ return q(name); }, get: async () => snap0, onSnapshot: () => () => {}, add: async (d) => { window.__adds.push({ name, d }); return { id: 'n' }; }, doc: () => ({ get: async () => snap0, set: async () => {}, update: async () => {}, onSnapshot: () => () => {} }) });
  const user = () => window.__user ? Object.assign({}, window.__user, { getIdTokenResult: async () => ({ claims: window.__user.claims || {} }), getIdToken: async () => 't' }) : null;
  const authObj = { get currentUser() { return user(); }, onAuthStateChanged(cb) { setTimeout(() => cb(user()), 0); return () => {}; }, signOut: async () => {} };
  window.firebase = { __stub: true, apps: [{}], initializeApp: () => ({}), app: () => ({}), auth: () => authObj,
    functions: () => ({ useRegion(){}, httpsCallable: (n) => call(n) }),
    firestore: Object.assign(() => ({ collection: q }), { FieldValue: { serverTimestamp: () => null } }),
    appCheck: () => ({ activate(){} }) };
  window.SOKONI_CONFIG = {};
  window.SK = { dialog: { confirm: async () => true } };
})();`;
const REAL = new Set(['/event-manager.html', '/event-hub.html', '/sokoni-event-ops.js', '/sokoni-event-refund-reasons.js', '/sokoni-hub-nav.js', '/sokoni-qr.js', '/sokoni-event-ticket.js',
  '/sokoni-dashboard-profile.js', '/sokoni-dashboard-profile-core.js', '/sokoni-aos-entertainment.js', '/entertainment-integrations.html',
  '/entertainment.html', '/venue-booking.html']);
/* The rebuilt Entertainment Hub imports the MODULAR SDK: /firebase.js as an ES module and gstatic's
   firebase-functions.js. Classic pages load /firebase.js as a plain script (COMPAT). The browser marks a
   module fetch with Sec-Fetch-Mode: cors, so the server can answer each correctly. */
const MOD_FIREBASE = 'export const app = { __stub: true }; export const auth = { currentUser: null }; export const db = {}; export const storage = {}; export const messaging = null;';
const MOD_FUNCTIONS = `export function getFunctions() { return {}; }
export function httpsCallable(_f, name) { return async (data) => { const r = await window.__srv(name, data || {}, window.__user && window.__user.uid); if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; throw e; } return { data: r.ok }; }; }`;
/* AdminOS › Entertainment, mounted with the REAL admin-os.html stylesheet and AdminOS's call shape. */
const AOS_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  (fs.readFileSync(Path.join(ROOT, 'admin-os.html'), 'utf8').match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('') +
  '</head><body style="background:#060a06;color:#eee;margin:0"><div class="aos-main" style="margin-left:0"><div class="aos-content" style="padding:16px"><div id="host"></div></div></div><script src="/sokoni-aos-entertainment.js"></script>' +
  '<script>window.SokoniAOSEntertainment.mount({ host: document.getElementById("host"), call: async (op, d) => { const r = await window.__srv("adminOsDispatch", Object.assign({ op: op }, d || {}), window.__user.uid); if (r.err) throw new Error(r.err.message); return r.ok; } });</script></body></html>';
const srv = http.createServer((rq, res) => {
  const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  if (p === '/aos-events.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(AOS_PAGE); }
  if (p === '/firebase.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(rq.headers['sec-fetch-mode'] === 'cors' ? MOD_FIREBASE : COMPAT); }
  if (REAL.has(p)) { res.writeHead(200, { 'Content-Type': (p.endsWith('.html') ? 'text/html' : 'application/javascript') + '; charset=utf-8' }); return res.end(fs.readFileSync(Path.join(ROOT, p.slice(1)))); }
  if (/\.m?js$/.test(p)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(''); }
  res.writeHead(200, { 'Content-Type': 'text/css' }); res.end('');
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 150) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

async function seed() {
  const NOW = Date.now(); const H = 3600e3;
  await db.doc('users/org1').set({ roles: ['event_organizer'] });
  await db.doc('events/evA').set({ eventId: 'evA', title: 'Nairobi Jazz Night', organizerUid: 'org1', status: 'live', startDate: new Date(NOW + 3 * H).toISOString(), endDate: new Date(NOW + 7 * H).toISOString(), totalTicketsSold: 0, createdAt: F.Timestamp.fromMillis(NOW),
    venue: 'KICC', city: 'Nairobi', refundPolicy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 1 * H).toISOString(), noShowRefund: true } });
  /* the organizer is registered for KRA eTIMS: paid sales get a REAL (queued) eTIMS invoice */
  await db.doc('etimsProfiles/org1').set({ status: 'active', kraPin: 'P051234567T', businessName: 'Kamau Events', branchId: '00', vatStatus: 'registered', invoicePrefix: 'KEV' });
  await db.doc('eventTicketTiers/VIP').set({ tierId: 'VIP', eventId: 'evA', name: 'VIP', price: 5000, quantity: 100, sold: 0, isActive: true, currency: 'KES' });
  await db.doc('eventTicketTiers/REG').set({ tierId: 'REG', eventId: 'evA', name: 'Regular', price: 2000, quantity: 500, sold: 0, isActive: true, currency: 'KES' });
  await db.doc('eventTicketTiers/FEW').set({ tierId: 'FEW', eventId: 'evA', name: 'Backstage', price: 9000, quantity: 2, sold: 0, isActive: true, currency: 'KES' });
  for (const [uid, role] of [['till1', 'cashier'], ['gate1', 'admission'], ['door9', 'admission']]) {
    await OPS._h.eventStaffInvite(reqFor('org1', { eventId: 'evA', email: USERS[uid].email, role }));
    await OPS._h.eventStaffAccept(reqFor(uid, { eventId: 'evA' }));
  }
  /* a paid online order for the buyer, through the REAL activation */
  const oid = 'ORDBUY1';
  await db.doc(`eventOrders/${oid}`).set({ orderId: oid, buyerUid: 'buyer1', eventId: 'evA', tierId: 'REG', tierName: 'Regular', quantity: 2, totalAmount: 4000, currency: 'KES', status: 'pending_payment', attendeeName: 'Achieng Otieno', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < 2; i++) await db.doc(`eventTickets/${oid}_k${i}`).set({ ticketId: `${oid}_k${i}`, orderId: oid, eventId: 'evA', buyerUid: 'buyer1', tierId: 'REG', tierName: 'Regular', status: 'awaiting_payment', token: 'tok' + i + 'buy1aaaaaaaaaaaaaaaaaaaaaaaaaaa', qrData: `sokoni-ticket:${oid}_k${i}:tok${i}buy1aaaaaaaaaaaaaaaaaaaaaaaaaaa`, createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`paymentIntents/${oid}`).set({ ref: oid, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: oid, uid: 'buyer1', ownerUid: 'buyer1', amount: 4000, amountCents: 400000, currency: 'KES', metadata: { eventId: 'evA', organizerUid: 'org1' } });
  await db.doc(`payments/${oid}`).set({ ref: oid, uid: 'buyer1', amount: 4000, amountCents: 400000, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 60 } });
  await ES.activateIfEventTicket(oid);
  /* KRA accepted the buyer's invoice (the fields etimsProcessQueue writes from KRA's answer) */
  const fr = await get(`eventFiscal/${oid}`);
  await db.doc(`etimsInvoices/${fr.invoiceId}`).set({ status: 'accepted', receiptNumber: 'KRA-RCPT-4411', qrCode: 'https://etims.kra.go.ke/qr/KRA-RCPT-4411.png', verificationUrl: 'https://etims.kra.go.ke/verify?r=KRA-RCPT-4411' }, { merge: true });
  /* a SEPARATE paid order the gate flows admit — the buyer's own order stays unused for the refund wizard */
  const g = 'ORDGATE1';
  await db.doc(`eventOrders/${g}`).set({ orderId: g, buyerUid: 'buyer2', eventId: 'evA', tierId: 'REG', tierName: 'Regular', quantity: 2, totalAmount: 4000, currency: 'KES', status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < 2; i++) await db.doc(`eventTickets/${g}_k${i}`).set({ ticketId: `${g}_k${i}`, orderId: g, eventId: 'evA', buyerUid: 'buyer2', tierName: 'Regular', attendeeName: 'Achieng Otieno', status: 'awaiting_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`paymentIntents/${g}`).set({ ref: g, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: g, uid: 'buyer2', ownerUid: 'buyer2', amount: 4000, amountCents: 400000, currency: 'KES', metadata: { eventId: 'evA', organizerUid: 'org1' } });
  await db.doc(`payments/${g}`).set({ ref: g, uid: 'buyer2', amount: 4000, amountCents: 400000, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 60 } });
  await ES.activateIfEventTicket(g);
  /* an ONLINE order a gate cashier checks in Quick Sale (one ticket per flow width) */
  const c = 'ORDCHK1';
  await db.doc(`eventOrders/${c}`).set({ orderId: c, buyerUid: 'buyer3', eventId: 'evA', tierId: 'REG', tierName: 'Regular', quantity: 2, totalAmount: 4000, currency: 'KES', status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < 2; i++) await db.doc(`eventTickets/${c}_k${i}`).set({ ticketId: `${c}_k${i}`, orderId: c, eventId: 'evA', buyerUid: 'buyer3', tierName: 'Regular', status: 'awaiting_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`paymentIntents/${c}`).set({ ref: c, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: c, uid: 'buyer3', ownerUid: 'buyer3', amount: 4000, amountCents: 400000, currency: 'KES', metadata: { eventId: 'evA', organizerUid: 'org1' } });
  await db.doc(`payments/${c}`).set({ ref: c, uid: 'buyer3', amount: 4000, amountCents: 400000, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 60 } });
  await ES.activateIfEventTicket(c);
  await db.doc('creators/cW').set({ uid: 'cW', state: 'ACTIVE', displayName: 'Kibera Films' });
  await db.doc('entertainmentListings/filmW').set({ creatorHub: true, creatorUid: 'cW', creatorName: 'Kibera Films', title: 'Nairobi Nights', pubState: 'PUBLISHED', status: 'active', subcategory: 'feature_film', publishedAt: F.Timestamp.fromMillis(NOW), priceCents: 25000, currency: 'KES' });
  await db.doc('creators/cX').set({ uid: 'cX', state: 'SUSPENDED', displayName: 'Suspended' });
  await db.doc('entertainmentListings/filmX').set({ creatorHub: true, creatorUid: 'cX', title: 'Should Not Show', pubState: 'PUBLISHED', status: 'active', subcategory: 'feature_film', publishedAt: F.Timestamp.fromMillis(NOW), priceCents: 100, currency: 'KES' });
  return oid;
}

(async () => {
  const oid = await seed();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const ctxFor = async (uid, width) => {
    const c = await browser.newContext({ viewport: { width, height: width < 700 ? 780 : 900 }, isMobile: width < 700, hasTouch: width < 700 });
    await c.exposeBinding('__srv', async (_s, name, data, u) => server(name, data, u));
    await c.addInitScript((u) => { window.__user = u; }, USERS[uid]);
    await c.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await c.route(/gstatic\.com\/firebasejs\/.*\.js$/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: COMPAT }));
    /* registered last = matched first: the modular functions SDK is an ES module */
    await c.route(/gstatic\.com\/firebasejs\/[\d.]+\/firebase-functions\.js$/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: MOD_FUNCTIONS }));
    return c;
  };
  const noOverflow = (page, w) => page.evaluate((W) => document.documentElement.scrollWidth <= W + 1 && innerWidth <= W + 1, w);
  const visibleSecs = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('[data-sec]')].map((n) => n.dataset.sec))]);
  try {
    for (const w of [360, 390, 768, 1024, 1280, 1440]) {
      const flows = w === 390 || w === 1280;
      say(`\n── ${w}px ──`);

      /* cashier (staff mode) */
      let c = await ctxFor('till1', w); let pg = await c.newPage();
      await pg.goto(BASE + '/event-manager.html'); await pg.waitForTimeout(500);
      const secs = await visibleSecs(pg);
      ck(`cashier @${w}: staff mode shows ONLY Quick Sale + Sales`, JSON.stringify(secs.sort()) === JSON.stringify(['quicksale', 'sales']), secs.join(','));
      await pg.evaluate(() => window.showSection('quicksale')); await pg.waitForSelector('[data-inc="VIP"]', { timeout: 8000 }).catch(() => null);
      ck(`cashier @${w}: Quick Sale has no horizontal overflow`, await noOverflow(pg, w));
      if (flows) {
        /* add / reduce tickets */
        const qv = (id) => pg.inputValue('[data-q="' + id + '"]');
        ck(`cashier @${w}: − is disabled at zero`, await pg.$eval('[data-dec="VIP"]', (b) => b.disabled));
        for (let i = 0; i < 3; i++) await pg.click('[data-inc="VIP"]');
        await pg.click('[data-dec="VIP"]');
        ck(`cashier @${w}: + three times, − once → 2 VIP, total KES 10,000`, (await qv('VIP')) === '2' && /KES 10,000/.test(await pg.textContent('#qsTotal')) && /2 × VIP/.test(await pg.textContent('#qsLines')));
        await pg.fill('[data-q="VIP"]', '999'); await pg.press('[data-q="VIP"]', 'Tab');
        ck(`cashier @${w}: a typed 999 is clamped to the 50-per-line limit`, (await qv('VIP')) === '50' && await pg.$eval('[data-inc="VIP"]', (b) => b.disabled));
        await pg.click('[data-inc="FEW"]'); await pg.click('[data-inc="FEW"]');
        const fewLeft = Number(await pg.textContent('[data-left="FEW"]'));
        ck(`cashier @${w}: + stops at the tickets left`, (await qv('FEW')) === String(Math.min(2, fewLeft)) && await pg.$eval('[data-inc="FEW"]', (b) => b.disabled));
        await pg.click('[data-tender="intasend"]');
        ck(`cashier @${w}: M-PESA with two ticket types is blocked and explained`, await pg.$eval('#qsDo', (b) => b.disabled) && /one ticket type per sale/.test(await pg.textContent('#qsMsg')));
        await pg.click('#qsClear');
        ck(`cashier @${w}: Clear empties the cart; Complete disabled`, (await qv('VIP')) === '0' && (await qv('FEW')) === '0' && /KES 0/.test(await pg.textContent('#qsTotal')) && await pg.$eval('#qsDo', (b) => b.disabled));
        ck(`cashier @${w}: stepper controls cause no overflow`, await noOverflow(pg, w));
        /* CASH IS NOT ACCEPTED (owner decision 2026-09-27): no Cash tender; the door sale is a card on the organizer's terminal */
        ck(`cashier @${w}: no Cash tender is offered, and the page says cash is not accepted`, !(await pg.$('[data-tender="cash"]')) && /Cash is not accepted for ticket sales/.test(await pg.textContent('#qsTender').catch(() => '') + await pg.textContent('body')));
        await pg.click('[data-inc="VIP"]'); await pg.click('[data-tender="card_external"]');
        await pg.fill('#qsRef', 'BRWREF' + w.toString(36).toUpperCase());   /* no 4-digit run: cannot look like a PIN */ await pg.click('#qsDo');
        await pg.waitForSelector('#qsOut .sk-t-pin', { timeout: 8000 }).catch(() => null);
        const pinShown = await pg.textContent('#qsOut').catch(() => '');
        const sales = db._dump('eventSales/').filter((x) => x.cashierUid === 'till1' && x.tender === 'card_external' && x.status === 'COMPLETED');
        const last = sales[sales.length - 1] || {};
        const pins = await pg.$$eval('#qsOut .sk-t-pin', (xs) => xs.map((x) => x.textContent.trim()));
        const nums = await pg.$$eval('#qsOut .sk-t-num', (xs) => xs.map((x) => x.textContent.trim()));
        ck(`cashier @${w}: SALE COMPLETE — the ticket card shows its number + 4-digit PIN to hand over`, /SALE COMPLETE/.test(pinShown) && pins.length === 1 && /^\d{4}$/.test(pins[0]) && /^SK-EVT-\d{4}-\d{6}$/.test(nums[0]), [pins, nums]);
        ck(`cashier @${w}: the SOKONI QR is drawn (local encoder) and KRA shows its real status`, (await pg.$$('#qsOut .sk-t-qr canvas')).length === 1 && /Pending fiscal confirmation/.test(pinShown) && !/KRA \/ FISCAL QR/.test(pinShown), [(await pg.$$('#qsOut .sk-t-qr canvas')).length, pinShown.slice(Math.max(0, pinShown.indexOf('KRA'))).replace(/\s+/g, ' '), db._dump('eventFiscal/').filter((f) => /door/.test(f.channel)).map((f) => f.saleKey + ':' + f.status), last.saleId]);
        ck(`cashier @${w}: the ticket card fits the screen (no overflow)`, await noOverflow(pg, w));
        /* Show ticket → full-screen dialog; Send ticket → WhatsApp with number + PIN; Print ticket → print window */
        await pg.click('#qsOut [data-tk-show]');
        const dlg = await pg.waitForSelector('[role="dialog"] .sk-ticket', { timeout: 5000 }).catch(() => null);
        ck(`cashier @${w}: Show ticket opens the ticket full-screen`, !!dlg && (await dlg.textContent()).includes(nums[0]) && await noOverflow(pg, w));
        await pg.click('[data-tk-close]');
        const [wa] = await Promise.all([pg.waitForEvent('popup', { timeout: 5000 }).catch(() => null), pg.click('#qsOut [data-tk-send]')]);
        const waUrl = wa ? decodeURIComponent(wa.url()) : '';
        ck(`cashier @${w}: Send ticket hands over the ticket number + PIN (WhatsApp, no Web Share in this browser)`, /wa\.me/.test(waUrl) && waUrl.includes(nums[0]) && waUrl.includes('PIN: ' + pins[0]), waUrl.slice(0, 120));
        if (wa) await wa.close();
        const [pw] = await Promise.all([pg.waitForEvent('popup', { timeout: 5000 }).catch(() => null), pg.click('#qsOut [data-tk-print]')]);
        if (pw) await pw.waitForLoadState().catch(() => null);
        const printed = pw ? await pw.content().catch(() => '') : '';
        ck(`cashier @${w}: Print ticket opens a printable ticket (QR as an image, no buttons)`, /SOKONI EVENT TICKET/.test(printed) && printed.includes(nums[0]) && /<img[^>]+data:image\/png/.test(printed) && !/data-tk-print/.test(printed));
        if (pw) await pw.close();
        /* an ONLINE ticket at the gate: Quick Sale → Check ticket → PIN → Admit (same authority) */
        const chk = w === 390 ? 'ORDCHK1_k0' : 'ORDCHK1_k1';
        await pg.click('[data-qsmode="check"]'); await pg.waitForSelector('#qsCheck #adPin', { timeout: 5000 }).catch(() => null);
        await pg.fill('#qsCheck #adPin', (await get(`eventTicketSecrets/${chk}`)).pin); await pg.click('#qsCheck #adVerify');
        await pg.waitForSelector('#qsCheck #adAdmit', { timeout: 5000 }).catch(() => null);
        ck(`cashier @${w}: Check ticket shows the ONLINE ticket (number, tier) for its PIN`, (await pg.textContent('#qsCheck #adOut')).includes((await get(`eventTickets/${chk}`)).ticketNumber));
        await pg.check('#qsCheck #adMatch');
        await pg.click('#qsCheck #adAdmit'); await pg.waitForTimeout(400);
        const adm1 = await get(`eventAdmissions/${chk}`);
        ck(`cashier @${w}: Admit → server ADMITTED by the cashier (canonical admission record)`, adm1 && adm1.admittedBy === 'till1' && adm1.method === 'pin' && (await get(`eventTickets/${chk}`)).admissionStatus === 'ADMITTED');
        ck(`cashier @${w}: Check ticket has no horizontal overflow`, await noOverflow(pg, w));
        await pg.click('[data-qsmode="sale"]');
        ck(`cashier @${w}: server wrote a COMPLETED 5,000 sale + valid ticket + ticket-rate receivable (${TICKET_PCT}% per policy)`, last.status === 'COMPLETED' && last.grossCents === 500000
          && db._dump('eventTickets/').some((t) => t.saleId === last.saleId && t.status === 'valid') && ((await get(`eventCommissionReceivables/${last.saleId}`)) || {}).amountCents === Math.round(500000 * TICKET_PCT / 100));
        ck(`cashier @${w}: the card sale records the terminal reference (attested, not verified)`, !!last.card && last.card.reference === ('BRWREF' + w.toString(36).toUpperCase()) && last.paymentVerified === false && /Sale recorded/.test(await pg.textContent('#qsMsg')));
        const vip = await get('eventTicketTiers/VIP');
        ck(`cashier @${w}: after the sale the tickets-left count is re-read from the server`, Number(await pg.textContent('[data-left="VIP"]')) === vip.quantity - vip.sold && (await qv('VIP')) === '0', [await pg.textContent('[data-left="VIP"]'), vip.quantity - vip.sold]);
        if (w === 1280) {
          /* M-PESA at the till: REAL intent pricing → STK (simulated provider edge) → webhook → REAL activation */
          const before = STK.length;
          await pg.click('[data-inc="REG"]'); await pg.click('[data-tender="intasend"]');
          await pg.fill('#qsPhone', '0712 345 678'); await pg.click('#qsDo');
          await pg.waitForSelector('#qsOut .sk-t-pin', { timeout: 15000 }).catch(() => null);
          const push = STK[before] || {};
          const msale = db._dump('eventSales/').filter((x) => x.tender === 'intasend' && x.cashierUid === 'till1').pop() || {};
          ck('cashier: M-PESA prompt sent to the buyer number for the SERVER price (KES 2,000)', STK.length === before + 1 && push.phone === '254712345678' && Number(push.amount) === 2000 && push.ref === msale.saleId, push);
          ck('cashier: after the M-PESA payment the sale is COMPLETED and the PIN is shown', msale.saleId && ((await get('eventSales/' + msale.saleId)) || {}).status === 'COMPLETED' && /^\d{4}$/.test(((await pg.$$eval('#qsOut .sk-t-pin', (xs) => xs.map((x) => x.textContent.trim()))) || [])[0] || '') && /Payment confirmed/.test(await pg.textContent('#qsMsg')));
          const st = (await get('eventSettlements/' + msale.saleId)) || {};
          ck(`cashier: M-PESA sale settles HELD at the ticket rate (${TICKET_PCT}% per policy) of (gross − fee), never the POS rate`, st.status === 'HELD' && st.commissionCents === Math.round((200000 - 3000) * TICKET_PCT / 100), st);
        }
      }
      await c.close();

      /* gate staff (staff mode) */
      c = await ctxFor('gate1', w); pg = await c.newPage();
      await pg.goto(BASE + '/event-manager.html'); await pg.waitForTimeout(500);
      ck(`gate @${w}: staff mode shows ONLY PIN Admission`, JSON.stringify(await visibleSecs(pg)) === JSON.stringify(['admission']));
      await pg.evaluate(() => window.showSection('admission')); await pg.waitForSelector('#adPin', { timeout: 8000 }).catch(() => null);
      ck(`gate @${w}: admission screen has no horizontal overflow`, await noOverflow(pg, w));
      if (flows) {
        const tk = w === 390 ? 'ORDGATE1_k0' : 'ORDGATE1_k1';
        const pin = (await get(`eventTicketSecrets/${tk}`)).pin;
        await pg.fill('#adPin', pin.toLowerCase()); await pg.click('#adVerify');
        await pg.waitForSelector('#adAdmit', { timeout: 8000 }).catch(() => null);
        ck(`gate @${w}: the buyer's PIN verifies (tier + initials, no email)`, /Regular/.test(await pg.textContent('#adOut')) && /AO/.test(await pg.textContent('#adOut')) && !/@/.test(await pg.textContent('#adOut')));
        const num = (await get(`eventTickets/${tk}`)).ticketNumber;
        ck(`gate @${w}: CHECK TICKET shows the ticket NUMBER to compare; CONFIRM ADMISSION stays disabled until confirmed`,
          (await pg.textContent('#adOut')).includes(num) && await pg.$eval('#adAdmit', (b) => b.disabled) && /CONFIRM ADMISSION/.test(await pg.textContent('#adOut')));
        await pg.check('#adMatch');
        await pg.click('#adAdmit'); await pg.waitForFunction(() => /Admitted|Already|✗/.test(document.getElementById('adOut').textContent), null, { timeout: 8000 }).catch(() => null);
        const _ad = await pg.textContent('#adOut');
        ck(`gate @${w}: Admit → server ADMITTED`, /Admitted/.test(_ad) && (await get(`eventTickets/${tk}`)).admissionStatus === 'ADMITTED', _ad + ' | server=' + (await get(`eventTickets/${tk}`)).admissionStatus);
        await pg.fill('#adPin', pin); await pg.click('#adVerify'); await pg.waitForFunction(() => !/Checking/.test(document.getElementById('adOut').textContent), null, { timeout: 8000 }).catch(() => null);
        ck(`gate @${w}: the same PIN again is refused`, /Already admitted/.test(await pg.textContent('#adOut')));
        if (w === 1280) {
          /* a REAL PIN, but the attendee cannot show that ticket number: "Doesn't match" → recorded, not admitted */
          const other = db._dump('eventTicketSecrets/').find((x) => x.ticketId === 'ORDBUY1_k1');
          await pg.fill('#adPin', other.pin); await pg.click('#adVerify'); await pg.waitForSelector('#adNoMatch', { timeout: 8000 }).catch(() => null);
          const before = db._dump('eventOpsAudit/').filter((a) => a.action === 'event_admission_mismatch').length;
          if (await pg.$('#adNoMatch')) { await pg.click('#adNoMatch'); await pg.waitForTimeout(400); }
          ck("gate: \"Doesn't match\" → not admitted, recorded as a security event", /did not match/.test(await pg.textContent('#adOut'))
            && db._dump('eventOpsAudit/').filter((a) => a.action === 'event_admission_mismatch').length === before + 1
            && (await get('eventTickets/ORDBUY1_k1')).admissionStatus !== 'ADMITTED');
        }
      }
      await c.close();

      /* organizer */
      c = await ctxFor('org1', w); pg = await c.newPage();
      await pg.goto(BASE + '/event-manager.html'); await pg.waitForTimeout(600);
      const osecs = await visibleSecs(pg);
      ck(`organizer @${w}: every event-day section is available`, ['quicksale', 'admission', 'sales', 'finance', 'staff'].every((x) => osecs.includes(x)));
      const rev = await pg.textContent('#stat-revenue');
      ck(`organizer @${w}: dashboard revenue comes from settlements (not the never-written KES 0)`, /KES [1-9]/.test(rev), rev);
      for (const sec of ['staff', 'finance', 'sales']) {
        await pg.evaluate((x) => window.showSection(x), sec); await pg.waitForTimeout(350);
        ck(`organizer @${w}: ${sec} renders without horizontal overflow`, await noOverflow(pg, w) && !/Loading…$/.test(await pg.textContent('#eo-' + sec)));
      }
      if (flows) {
        await pg.evaluate(() => window.showSection('staff')); await pg.waitForSelector('#stEmail');
        await pg.fill('#stEmail', `promo${w}@x.co`); await pg.selectOption('#stRole', 'marketing'); await pg.click('#stAdd'); await pg.waitForTimeout(300);
        ck(`organizer @${w}: invite stored server-side + link shown`, db._dump('eventStaffInvites/').some((i) => i.email === `promo${w}@x.co` && i.role === 'marketing') && /staffInvite=evA/.test(await pg.innerHTML('#stLink')));
        await pg.evaluate(() => window.showSection('finance')); await pg.waitForTimeout(400);
        const fin = await pg.textContent('#eo-finance');
        /* Expected online gross is DERIVED from the settlements the server wrote (earlier flows add sales,
           e.g. the M-PESA till sale at 1280) — never a hard-coded figure. */
        const onlineCents = db._dump('eventSettlements/').filter((x) => x.eventId === 'evA' && x.status !== 'REFUNDED' && x.channel !== 'CASH' && x.channel !== 'CARD_EXTERNAL')
          .reduce((a, x) => a + (Number(x.grossCents) || 0), 0);
        const onlineTxt = 'Online salesKES ' + (onlineCents / 100).toLocaleString('en-KE');
        ck(`organizer @${w}: finance shows settled figures (online + door)`, onlineCents >= 800000 && /Gross ticket sales/.test(fin) && fin.includes(onlineTxt) && /SOKONI commission on door sales/.test(fin), [onlineTxt, fin.slice(0, 160)]);
        await pg.evaluate(() => window.showSection('promo')); await pg.waitForTimeout(200);
        ck(`organizer @${w}: share is disabled until an event is chosen`, (await pg.$eval('#share-copy', (b) => b.disabled)) && !(await pg.getAttribute('#share-wa', 'href')));
        await pg.selectOption('#share-event-select', 'evA'); await pg.fill('#share-promo', 'jazz-20!');
        const link = await pg.inputValue('#share-link');
        ck(`organizer @${w}: share link = public event page + sanitised promo`, link === BASE + '/event-hub.html?event=evA&promo=JAZZ20', link);
        const wa = await pg.getAttribute('#share-wa', 'href');
        ck(`organizer @${w}: WhatsApp share carries the title and link, opens safely`, /^https:\/\/wa\.me\/\?text=/.test(wa) && decodeURIComponent(wa).includes('Nairobi Jazz Night') && decodeURIComponent(wa).includes(link) && (await pg.getAttribute('#share-wa', 'rel')) === 'noopener noreferrer');
        ck(`organizer @${w}: promo + share section has no horizontal overflow`, await noOverflow(pg, w));
      }
      await c.close();

      /* buyer */
      c = await ctxFor('buyer1', w); pg = await c.newPage();
      await pg.goto(BASE + '/event-hub.html'); await pg.waitForTimeout(400);
      await pg.evaluate(() => { document.getElementById('my-tickets-panel').style.display = 'block'; return window.loadMyTickets ? null : null; });
      await pg.evaluate(() => (typeof loadMyTickets === 'function') && loadMyTickets()); await pg.waitForTimeout(400);
      const mt = await pg.textContent('#my-tickets-list');
      const bpins = await pg.$$eval('#my-tickets-list .sk-t-pin', (xs) => xs.map((x) => x.textContent.trim()));
      /* A ticket whose refund is in flight (the 1280 flow requests one) shows NO PIN and NO QR — it is
         not valid for entry; every other card shows its own 4-digit PIN. */
      const suspended = /Refund in progress/.test(mt);
      const shown = bpins.filter((x) => x !== '————');
      ck(`buyer @${w}: My Tickets shows each ticket as a card: SK-EVT-YYYY-NNNNNN + its own 4-digit PIN (hidden only while a refund is in flight)`,
        shown.length >= 1 && shown.every((x) => /^\d{4}$/.test(x)) && /SK-EVT-\d{4}-\d{6}/.test(mt) && new Set(shown).size === shown.length && (shown.length === bpins.length || suspended), bpins);
      ck(`buyer @${w}: the SOKONI TICKET QR is drawn for every usable ticket, labelled optional`, (await pg.$$('#my-tickets-list .sk-t-qr canvas')).length === shown.length && /SOKONI TICKET QR/.test(mt));
      const kraImgs = await pg.$$eval('#my-tickets-list .sk-t-fiscal img', (xs) => xs.map((x) => x.getAttribute('src')));
      ck(`buyer @${w}: KRA / FISCAL QR only as KRA returned it (accepted invoice), with the KRA receipt`, kraImgs.length >= 1 && kraImgs.every((u) => u === 'https://etims.kra.go.ke/qr/KRA-RCPT-4411.png') && /KRA receipt: KRA-RCPT-4411/.test(mt) && /KRA \/ FISCAL QR/.test(mt), kraImgs);
      ck(`buyer @${w}: the price shows on the card (VIP/Regular • KES)`, /Regular • KES 2,000/.test(mt));
      ck(`buyer @${w}: My Tickets has no horizontal overflow`, await noOverflow(pg, w));
      if (flows) {
        const p2 = await c.newPage();
        await p2.goto(BASE + '/event-hub.html?event=evA&promo=jazz20'); await p2.waitForSelector('#promo-input', { timeout: 5000 }).catch(() => null);
        ck(`buyer @${w}: a shared link opens the event with the code prefilled (not applied)`,
          /Nairobi Jazz Night/.test(await p2.textContent('#modal-content')) && (await p2.inputValue('#promo-input')) === 'JAZZ20' && !(await p2.isVisible('#promo-result')));
        await p2.goto(BASE + '/event-hub.html?event=' + encodeURIComponent('../x"><img src=x onerror=alert(1)>')); await p2.waitForTimeout(300);
        ck(`buyer @${w}: a malformed event id in the link is ignored`, !(await p2.$eval('#overlay', (o) => o.classList.contains('open'))));
        if (w === 1280) {
          /* The buyer pays online with M-PESA: REAL purchaseTickets (seat hold) → REAL intent → STK
             (simulated provider edge) → webhook → REAL activation → My Tickets shows the PIN. */
          await p2.goto(BASE + '/event-hub.html?event=evA'); await p2.waitForSelector('#tier-REG', { timeout: 8000 }).catch(() => null);
          await p2.click('#tier-REG'); await p2.click('#buy-btn');
          await p2.waitForSelector('#pay-stk', { timeout: 8000 }).catch(() => null);
          ck('buyer: checkout offers M-PESA (hosted methods stay hidden until proven)', !!(await p2.$('#pay-stk')) && !(await p2.$('#pay-hosted')));
          const before = STK.length;
          await p2.fill('#pay-phone', '0722000111'); await p2.click('#pay-stk');
          await p2.waitForFunction(() => /Payment confirmed/.test(document.getElementById('pay-msg') ? document.getElementById('pay-msg').textContent : ''), null, { timeout: 20000 }).catch(() => null);
          const push = STK[before] || {};
          const ord = (await get('eventOrders/' + push.ref)) || {};
          ck('buyer: M-PESA prompt for the SERVER price to the buyer\'s number', push.uid === 'buyer1' && push.phone === '254722000111' && Number(push.amount) === 2000 && ord.buyerUid === 'buyer1', push);
          const tix = db._dump('eventTickets/').filter((t) => t.orderId === push.ref);
          ck('buyer: payment confirmed → order paid, ticket valid with a PIN', ord.status === 'paid' && tix.length === 1 && tix[0].status === 'valid' && !!tix[0].pinHash && /Payment confirmed/.test(await p2.textContent('#pay-msg')));
        }
        await p2.close();
      }
      if (flows && w === 1280) {
        await pg.evaluate((o) => window.openRefundWizard(o), oid); await pg.waitForSelector('#rw-reason');
        await pg.selectOption('#rw-reason', 'cannot_attend'); await pg.click('#rw-next'); await pg.waitForSelector('#rw-check');
        await pg.click('#rw-check'); await pg.waitForTimeout(400);
        const step3 = await pg.textContent('#modal-content');
        ck('buyer: the wizard shows the SERVER eligibility (YES, before the deadline)', /Refund eligibility/.test(step3) && /YES/.test(step3), step3.slice(0, 120));
        ck('buyer: the wizard states the refund AMOUNT from the server quote (no fee under this policy)', /Refund amountKES 4,000/.test(step3.replace(/\s+/g, '')) || /Refund amount\s*KES 4,000/.test(step3), step3.slice(0, 200));
        ck('buyer: the wizard causes no horizontal overflow', await noOverflow(pg, w));
        await pg.click('#rw-send'); await pg.waitForTimeout(500);
        ck('buyer: submit → canonical refund request (pending admin review) + tickets REQUESTED',
          ((await get(`fosRefundQueue/ref_${oid}`)) || {}).status === 'pending' && (await get(`eventTickets/${oid}_k0`)).refundStatus === 'REQUESTED');
      }
      if (flows && w === 390) {
        /* an ineligible reason: "event cancelled" on a live event */
        await pg.evaluate((o) => window.openRefundWizard(o), oid); await pg.waitForSelector('#rw-reason');
        await pg.selectOption('#rw-reason', 'event_cancelled'); await pg.click('#rw-next'); await pg.waitForSelector('#rw-check');
        await pg.click('#rw-check'); await pg.waitForTimeout(400);
        ck('buyer: an ineligible reason is explained and CANNOT be submitted', /NO/.test(await pg.textContent('#modal-content')) && !(await pg.$('#rw-send')));
      }
      await c.close();

      /* Entertainment Hub — the ENTRY POINT, walked as a VISITOR (no account) on the real page with the
         real event-hub listEvents and the real Creator catalogue behind it. */
      c = await ctxFor(null, w); pg = await c.newPage();
      const hubErrors = []; pg.on('pageerror', (e) => hubErrors.push(e.message));
      await pg.goto(BASE + '/entertainment.html'); await pg.waitForSelector('#p-home a.tile', { timeout: 5000 }).catch(() => null);
      const tiles = await pg.$$eval('#p-home a.tile', (as) => as.map((a) => a.getAttribute('href')));
      ck(`hub @${w}: home routes to the canonical owners (events, films, services, venues, organize, publish)`,
        ['/event-hub.html', '/creator.html', '/services.html?cat=entertainment', '/venue-booking.html', '/event-manager.html', '/creator-studio.html'].every((h) => tiles.includes(h)), tiles);
      const allHrefs = await pg.$$eval('a[href^="/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href').split(/[?#]/)[0]))]);
      const dead = allHrefs.filter((h) => !fs.existsSync(Path.join(ROOT, h.slice(1))));
      ck(`hub @${w}: no dead link on the page (${allHrefs.length} distinct targets)`, dead.length === 0, dead.join(','));
      await pg.click('#tab-events'); await pg.waitForSelector('#events [data-event], #events .state:not(:empty)', { timeout: 6000 }).catch(() => null);
      ck(`hub @${w}: Events lists the LIVE event-hub event, linking to its canonical page`, (await pg.getAttribute('#events [data-event="evA"]', 'href').catch(() => null)) === '/event-hub.html?event=evA');
      await pg.click('#tab-films'); await pg.waitForSelector('#films [data-film], #films .state.err', { timeout: 6000 }).catch(() => null);
      const filmIds = await pg.$$eval('#films [data-film]', (as) => as.map((a) => a.dataset.film));
      ck(`hub @${w}: Films lists the published film of an ACTIVE creator — never a suspended creator's`, filmIds.includes('filmW') && !filmIds.includes('filmX'), filmIds);
      await pg.click('#tab-artists');
      ck(`hub @${w}: Artists & services route to the provider marketplace (DJ / MC / all)`, (await pg.$$eval('#artistChips a', (as) => as.map((a) => a.getAttribute('href')))).some((h) => h === '/services.html?cat=dj'));
      ck(`hub @${w}: no horizontal overflow; no script error`, (await noOverflow(pg, w)) && hubErrors.length === 0, hubErrors.join(' | '));
      await c.close();
      if (flows) {
        /* click through: Hub card → the canonical event page, which opens that event */
        c = await ctxFor('buyer1', w); pg = await c.newPage();
        await pg.goto(BASE + '/entertainment.html?tab=events'); await pg.waitForSelector('#events [data-event="evA"]', { timeout: 6000 }).catch(() => null);
        await Promise.all([pg.waitForNavigation({ timeout: 8000 }).catch(() => null), pg.click('#events [data-event="evA"]')]);
        await pg.waitForTimeout(800);
        ck(`hub @${w}: clicking the event opens it on event-hub (canonical buyer flow)`, /event-hub\.html\?event=evA/.test(pg.url()) && /Nairobi Jazz Night/.test(await pg.content()));
        await c.close();
        /* unavailable is shown as unavailable, never as "no events" */
        _failListEvents = true;
        c = await ctxFor(null, w); pg = await c.newPage();
        await pg.goto(BASE + '/entertainment.html?tab=events'); await pg.waitForSelector('#events .state', { timeout: 6000 }).catch(() => null);
        ck(`hub @${w}: a failing events service renders "unavailable", not an empty list`, /unavailable right now/.test(await pg.textContent('#events')));
        _failListEvents = false;
        await c.close();
        /* legacy deep links land on the canonical owner */
        c = await ctxFor(null, w); pg = await c.newPage();
        await pg.goto(BASE + '/entertainment.html?cat=dj'); await pg.waitForTimeout(400);
        ck(`hub @${w}: a legacy ?cat=dj link lands on the provider marketplace`, /\/services\.html\?cat=dj/.test(pg.url()));
        await c.close();
        /* venue booking: the page must BOOT (it threw on load before) */
        c = await ctxFor('buyer1', w); pg = await c.newPage();
        const vbErr = []; pg.on('pageerror', (e) => vbErr.push(e.message));
        await pg.goto(BASE + '/venue-booking.html?tab=mine'); await pg.waitForTimeout(800);
        ck(`venues @${w}: venue-booking boots without a script error and opens My Bookings from the Hub link`, vbErr.length === 0 && await pg.evaluate(() => { const v = document.getElementById('v-bookings'); return !!v && getComputedStyle(v).display !== 'none'; }), vbErr.join(' | '));
        ck(`venues @${w}: no horizontal overflow`, await noOverflow(pg, w));
        await c.close();
      }

      /* Entertainment › Integrations: status + canonical routing (the REAL page) */
      c = await ctxFor('org1', w); pg = await c.newPage();
      await pg.goto(BASE + '/entertainment-integrations.html?context=events&integration=kra_etims'); await pg.waitForSelector('#int-kra_etims', { timeout: 5000 }).catch(() => null);
      const ih = await pg.content();
      ck(`integrations @${w}: five status cards, the focused card highlighted`, (await pg.$$('section.card')).length === 5 && !!(await pg.$('#int-kra_etims.focus')));
      ck(`integrations @${w}: KRA "View integrations" opens the canonical eTIMS page with context`, (await pg.getAttribute('[data-view="kra_etims"]', 'href')) === '/etims-seller.html?hub=entertainment&context=events');
      ck(`integrations @${w}: an organizer sees NO AdminOS link and nothing to configure`, !(await pg.$('[data-admin]')) && !(await pg.$('form, input, select, textarea')));
      /* read the rendered chips from the DOM (the page's own stylesheet names every state, so a text search proves nothing) */
      const kra = await pg.evaluate(() => { const o = {}; const sp = [...document.querySelectorAll('#int-kra_etims .kv > span')]; for (let k = 0; k < sp.length; k += 2) { const ch = sp[k + 1].querySelector('.chip'); o[sp[k].textContent.trim()] = ch ? ch.dataset.s : sp[k + 1].textContent.trim(); } return o; });
      const liveNoEv = await pg.evaluate(() => [...document.querySelectorAll('#int-intasend tbody tr')].filter((tr) => tr.querySelector('.chip').dataset.s === 'LIVE_AND_PROVEN' && tr.children[2].textContent.trim() === '—').length);
      ck(`integrations @${w}: KRA PIN masked; credit notes DISABLED; sandbox UNKNOWN; no method LIVE without evidence`, ih.includes('P05******7T') && !ih.includes('P051234567T') && kra['Credit notes'] === 'DISABLED' && kra['Sandbox certification'] === 'UNKNOWN' && kra['Invoice transmission'] === 'CONFIGURED' && liveNoEv === 0, kra);
      ck(`integrations @${w}: no horizontal page overflow`, await noOverflow(pg, w));
      await c.close();
      if (flows) {
        c = await ctxFor('admin1', w); pg = await c.newPage();
        await pg.goto(BASE + '/entertainment-integrations.html?context=creator'); await pg.waitForSelector('[data-admin="kra_etims"]', { timeout: 5000 }).catch(() => null);
        ck(`integrations @${w}: an admin is routed to AdminOS › Integrations filtered to Entertainment`, (await pg.getAttribute('[data-admin="kra_etims"]', 'href')) === '/admin-os.html?hub=entertainment&integration=etims&context=creator#integrations');
        await c.close();
        c = await ctxFor('buyer1', w); pg = await c.newPage();
        await pg.goto(BASE + '/entertainment-integrations.html'); await pg.waitForSelector('#int-kra_etims', { timeout: 5000 }).catch(() => null);
        ck(`integrations @${w}: an organizer who is not on eTIMS sees NOT APPLICABLE — never another organizer's registration`, /NOT APPLICABLE/.test(await pg.textContent('#int-kra_etims')) && !(await pg.content()).includes('P05'));
        await c.close();
      }

      /* AdminOS › Entertainment › Events investigation */
      c = await ctxFor('admin1', w); pg = await c.newPage();
      await pg.goto(BASE + '/aos-events.html'); await pg.waitForTimeout(300);
      await pg.click('[data-tab="investigate"]'); await pg.waitForSelector('[data-evsearch]');
      await pg.selectOption('[data-evsearch] select[name="by"]', 'event'); await pg.fill('[data-evsearch] input[name="value"]', 'evA');
      await pg.click('[data-evsearch] button[type="submit"]'); await pg.waitForSelector('[data-trace-order]', { timeout: 5000 }).catch(() => null);
      const inv = await pg.textContent('#aosentBody');
      ck(`admin @${w}: search by event lists tickets, orders and door sales`, /SK-EVT-/.test(inv) && /ORDBUY1/.test(inv) && /Door & cashier sales/.test(inv));
      ck(`admin @${w}: ticket PINs show only as ••••; each row has its fiscal status`, /••••/.test(inv) && /CONFIRMED|PENDING/.test(inv));
      ck(`admin @${w}: investigation has no horizontal page overflow`, await noOverflow(pg, w));
      const html0 = await pg.content();
      const allPins = db._dump('eventTicketSecrets/').map((x) => x.pin);
      /* a PIN counts as leaked only as a STANDALONE 4-digit token: ticket numbers (SK-EVT-2026-NNNNNN) and amounts contain 4-digit windows that are not PINs (a substring search here was flaky). */
      const _tok = (p) => new RegExp('(^|\\D)' + p + '(\\D|$)');
      /* ticket numbers are shown on purpose; remove them first so their year / digit groups cannot pose as a PIN */
      const htmlScan = html0.replace(/SK-EVT-\d{4}-\d{6}/g, 'SK-EVT-#');
      const leaked = allPins.filter((p) => _tok(p).test(htmlScan)).map((p) => { const i = htmlScan.search(_tok(p)); return p + ' @ …' + htmlScan.slice(Math.max(0, i - 40), i + 8).replace(/\s+/g, ' ') + '…'; });
      ck(`admin @${w}: no ticket PIN anywhere in the investigation page`, allPins.length > 0 && leaked.length === 0, leaked.join(' | '));
      if (flows) {
        await pg.click('[data-trace-order="ORDBUY1"]'); await pg.waitForSelector('.aos-trace', { timeout: 5000 }).catch(() => null);
        const tr = await pg.textContent('#aosentBody');
        ck(`admin @${w}: trace walks event → tickets → payment → commission → proceeds → refund → payout`,
          ['event', 'tickets', 'sale', 'payment', 'commission', 'receivable', 'organizer proceeds', 'refund', 'payout'].every((x) => tr.includes(x)) && /observed/.test(tr), tr.slice(0, 160));
        ck(`admin @${w}: trace has no horizontal page overflow`, await noOverflow(pg, w));
        await pg.click('[data-untrace]');
        /* PIN identity: a real PIN finds its ticket; the PIN is not kept on the page */
        const sec = db._dump('eventTicketSecrets/').find((x) => x.ticketId === `${oid}_k1`);
        await pg.selectOption('[data-evsearch] select[name="by"]', 'pin');
        await pg.fill('[data-evsearch] input[name="value"]', sec.pin); await pg.fill('[data-evsearch] input[name="eventId"]', 'evA');
        await pg.click('[data-evsearch] button[type="submit"]'); await pg.waitForTimeout(400);
        const ph = await pg.content();
        ck(`admin @${w}: PIN search finds exactly that ticket`, ph.includes(`data-trace-ticket="${oid}_k1"`) && (ph.match(/data-trace-ticket=/g) || []).length === 1);
        ck(`admin @${w}: the PIN is not left on the page after the search`, !ph.includes(sec.pin) && (await pg.inputValue('[data-evsearch] input[name="value"]')) === '');
        /* Staff & gate */
        await pg.click('[data-tab="eventops"]'); await pg.waitForSelector('[data-evops]');
        await pg.fill('[data-evops] input[name="eventId"]', 'evA'); await pg.click('[data-evops] button[type="submit"]');
        await pg.waitForSelector('[data-revoke]', { timeout: 5000 }).catch(() => null);
        const so = await pg.textContent('#aosentBody');
        ck(`admin @${w}: staff, invitations, admissions and PIN counters render`, /Staff/.test(so) && /Invitations/.test(so) && /Admissions/.test(so) && /Wrong-PIN counters/.test(so));
        ck(`admin @${w}: staff view has no horizontal page overflow`, await noOverflow(pg, w));
        if (w === 1280) {
          await pg.click('[data-revoke="door9"]'); await pg.fill('.aoscr-ask textarea', 'lost device at the east gate');
          await pg.click('.aoscr-ask button.aos-btn:not(.aos-btn-ghost)'); await pg.waitForTimeout(400);
          ck('admin: revoke → server staff record revoked with the reason, audited',
            (await get('eventStaff/evA_door9')).status === 'revoked' && db._dump('adminAudit/').some((a) => a.action === 'event_staff_revoked_by_admin' && a.after.reason === 'lost device at the east gate'));
          await pg.click('[data-tab="refundreq"]'); await pg.waitForTimeout(400);
          ck('admin: the buyer\'s wizard request is in the refund-request queue', /ORDBUY1/.test(await pg.textContent('#aosentBody')) && /PENDING_REVIEW/.test(await pg.textContent('#aosentBody')));
        }
        await pg.click('[data-tab="receivables"]'); await pg.waitForTimeout(400);
        ck(`admin @${w}: receivables render without overflow`, /Owed|No receivables/.test(await pg.textContent('#aosentBody')) && await noOverflow(pg, w));
        await pg.click('[data-tab="fiscal"]'); await pg.waitForTimeout(400);
        const fb = await pg.textContent('#aosentBody');
        ck(`admin @${w}: Fiscal (KRA) reconciliation renders without overflow`, /Nothing here is fabricated/.test(fb) && /Sale|Nothing to reconcile/.test(fb) && await noOverflow(pg, w), fb.slice(0, 300));
      }
      await c.close();
    }
  } finally { await browser.close(); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(3); });
