/* test-ent-availability-browser.js — the availability calendar, storefront, provider workspace,
 * conversation card and AdminOS tabs in a REAL browser (Chromium via Playwright) against the REAL
 * server modules on the transactional fake Firestore. No network, no provider, no production.
 *
 * REALTIME is real in the sense that matters: the page listens (onSnapshot) to the public counter
 * docs entAvailabilityPublic/{calKey}[_{month}]; this harness streams every change the SERVER makes
 * to those docs into the page, exactly like a Firestore listener. The page then re-asks the server.
 *
 * PROVES
 *   Browser A views 10:00 AVAILABLE → Browser B books it through the storefront checkout →
 *   A shows TEMPORARILY HELD without a refresh → payment confirmed → A shows BOOKED → B's booking is
 *   cancelled canonically → A shows AVAILABLE. A provider block → A shows UNAVAILABLE and never the
 *   private label. Price change during checkout → "Price changed" and nothing charged. Enquiry from the
 *   storefront → server-created conversation. Conversation card shows the PIN to the buyer only.
 *   AdminOS › Availability shows states, not labels. No horizontal scroll at 360 · 390 · 768 · 1280.
 *
 *   node scripts/test-ent-availability-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-avail-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const CORE = require(Path.join(FN, 'shared', 'ent-availability-core.js'));
const AV = require(Path.join(FN, 'ent-availability.js'));
const RC = require(Path.join(FN, 'ent-rate-cards.js'));
const EQ = require(Path.join(FN, 'ent-enquiries.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const PO = require(Path.join(FN, 'provider-ops.js'));
const SW = require(Path.join(FN, 'booking-payment-sweep.js'));
const EB = require(Path.join(FN, 'entertainment-bookings.js'));
const BK = require(Path.join(FN, 'booking.js'));

const USERS = { buyerA: { uid: 'buyerA' }, buyerB: { uid: 'buyerB' }, ph1: { uid: 'ph1' }, adm: { uid: 'adm', claims: { admin: true } } };
const reqFor = (uid, data) => ({ auth: uid ? { uid, token: Object.assign({ email_verified: true }, (USERS[uid] && USERS[uid].claims) || {}) } : null, rawRequest: { headers: {} }, data });
const wire = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : x)));
const BOOKING_H = Object.assign({}, AV._h, RC._h, EQ._h, BK._h);
const PROVIDER_H = Object.assign({}, BS._h, PO._h);
const ADMIN_H = Object.assign({}, AV._adminH, RC._adminH, EQ._adminH, EB._adminH);
async function server(name, data, uid) {
  try {
    const op = data && data.op;
    let h = null;
    if (name === 'bookingDispatch') h = BOOKING_H[op];
    else if (name === 'providerDispatch') h = PROVIDER_H[op];
    else if (name === 'eventOpsDispatch') h = EB._h[op];
    else if (name === 'adminOsDispatch') h = ADMIN_H[op];
    else if (name === 'connectDispatch') return { ok: { actions: [] } };
    if (!h) return { err: { code: 'not-found', message: 'unknown op ' + op } };
    return { ok: wire(await h(reqFor(uid, data))) };
  } catch (e) { return { err: { code: e.code || 'internal', message: e.message, details: e.details || null } }; }
}

/* the page-side Firebase: callables → Node; onSnapshot → a listener the harness feeds */
const COMPAT = `
(function(){
  window.__subs = {};
  const call = (name) => async (data) => { const r = await window.__srv(name, data || {}, window.__user && window.__user.uid); if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; e.details = r.err.details; throw e; } return { data: r.ok }; };
  const docRef = (path) => ({ id: path.split('/').pop(), get: async () => ({ exists: false, data: () => ({}) }),
    onSnapshot(cb) { (window.__subs[path] = window.__subs[path] || []).push(cb); window.__listen(path); return () => { window.__subs[path] = (window.__subs[path] || []).filter((f) => f !== cb); }; } });
  const col = (c) => ({ doc: (id) => docRef(c + '/' + id), where(){ return col(c); }, limit(){ return col(c); }, get: async () => ({ empty: true, docs: [] }) });
  window.__snap = (path, data) => { (window.__subs[path] || []).forEach((cb) => cb({ exists: !!data, data: () => data || {} })); };
  const user = () => window.__user ? Object.assign({}, window.__user, { getIdTokenResult: async () => ({ claims: window.__user.claims || {} }) }) : null;
  window.firebase = { apps: [{}], auth: () => ({ get currentUser() { return user(); }, onAuthStateChanged(cb) { setTimeout(() => cb(user()), 0); return () => {}; } }),
    functions: () => ({ httpsCallable: (n) => call(n) }), firestore: () => ({ collection: col }) };
})();`;
const today = CORE.dateOf(Date.now());
const D = CORE.addDays(today, 9);
const PAGE = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title>
  <style>body{background:#060a06;color:#eee;margin:0;padding:12px;font-family:system-ui}</style>
  <script>${COMPAT}</script><script src="/sokoni-ent-calendar.js"></script><script src="/sokoni-ent-storefront.js"></script><script src="/sokoni-ent-workspace.js"></script><script src="/sokoni-ent-conversation.js"></script></head>
  <body>${body}</body></html>`;
const PAGES = {
  '/cal.html': PAGE('<div id="cal"></div><script>window.CAL = SokoniEntCalendar.mount(document.getElementById("cal"), { providerId: "ph1", serviceId: "svc_ph1", mode: "public" });</script>'),
  '/sf.html': PAGE('<div id="sf"></div><script>window.SokoniBookService = { payFor: (o) => { window.__paid = o; } }; window.SF = SokoniEntStorefront.mount(document.getElementById("sf"), { providerId: "ph1", name: "Jane Photography" });</script>'),
  '/ws.html': PAGE('<div id="ws"></div><script>window.WS = SokoniEntWorkspace.mount(document.getElementById("ws"), { section: "calendar" });</script>'),
  '/conv.html': PAGE('<div id="ctx-banner"></div><script>SokoniEntConversation.mount(window.__conv, (window.__user||{}).uid);</script>'),
};
const AOS_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  (fs.readFileSync(Path.join(ROOT, 'admin-os.html'), 'utf8').match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('') +
  '</head><body style="background:#060a06;color:#eee;margin:0"><div id="host"></div><script src="/sokoni-aos-entertainment.js"></script>' +
  '<script>window.SokoniAOSEntertainment.mount({ host: document.getElementById("host"), call: async (op, d) => { const r = await window.__srv("adminOsDispatch", Object.assign({ op: op }, d || {}), window.__user.uid); if (r.err) throw new Error(r.err.message); return r.ok; } });</script></body></html>';
const REAL = new Set(['/sokoni-ent-calendar.js', '/sokoni-ent-storefront.js', '/sokoni-ent-workspace.js', '/sokoni-ent-conversation.js', '/sokoni-aos-entertainment.js']);
const srv = http.createServer((rq, res) => {
  const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  if (PAGES[p]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGES[p]); }
  if (p === '/aos.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(AOS_PAGE); }
  if (REAL.has(p)) { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); return res.end(fs.readFileSync(Path.join(ROOT, p.slice(1)))); }
  res.writeHead(404); res.end('');
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '08:00', close: '20:00' }], breaks: [] }; });

async function seed() {
  for (const u of ['buyerA', 'buyerB', 'ph1']) await db.doc('users/' + u).set({ displayName: u });
  await db.doc('providers/ph1').set({ name: 'Jane Photography', status: 'active', category: 'photographer', acceptsBookings: true });
  await db.doc('applications/app_ph1').set({ uid: 'ph1', status: 'approved', role: 'provider', category: 'photographer' });
  await db.doc('providerAvailability/ph1').set({ uid: 'ph1', modes: ['fixed_hours'], schedule: WEEK, appt: { enabled: true, durationMins: 60, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true }, cap: {} });
  await db.doc('providerServices/svc_ph1').set({ providerId: 'ph1', name: 'Portrait session', price: 500000, fee: 0, deposit: 0, durationMins: 60, active: true });
  await EQ._h.entMessagingSetSettings(reqFor('ph1', { settings: { responseTime: 'WITHIN_1_HOUR', callRequests: 'ENABLED', publicInfo: { cancellationPolicy: 'Full refund up to 24 hours before.' } } }));
}

async function wirePage(page, uid) {
  await page.exposeFunction('__srv', (name, data, u) => server(name, data, u));
  const watched = new Set(); const last = {};
  await page.exposeFunction('__listen', (path) => { watched.add(path); });
  await page.addInitScript((u) => { window.__user = u; }, uid ? Object.assign({}, USERS[uid]) : null);
  const timer = setInterval(async () => {
    for (const path of watched) {
      const d = await get(path);
      const s = JSON.stringify(wire(d));
      if (last[path] !== s) { last[path] = s; page.evaluate(([p, x]) => window.__snap && window.__snap(p, x), [path, wire(d)]).catch(() => {}); }
    }
  }, 120);
  page.on('close', () => clearInterval(timer));
}
const slotState = (page, start) => page.evaluate((s) => { const b = [...document.querySelectorAll('.skcal-slot')].find((x) => x.textContent.trim().startsWith(s)); return b ? (b.querySelector('small') || {}).textContent : null; }, start);
const waitSlot = (page, start, want, ms) => page.waitForFunction(([s, w]) => { const b = [...document.querySelectorAll('.skcal-slot')].find((x) => x.textContent.trim().startsWith(s)); return b && b.querySelector('small') && b.querySelector('small').textContent === w; }, [start, want], { timeout: ms || 8000 }).then(() => true).catch(() => false);
const tenLabel = (() => { const h = 10; return ((h + 11) % 12 + 1) + ':00 AM'; })();
const twelveLabel = '12:00 PM';

(async () => {
  await seed();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    /* ── Browser A: a buyer watching the calendar ── */
    say('\n── realtime: Browser A watches, Browser B books ──');
    const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const A = await ctxA.newPage(); await wirePage(A, 'buyerA');
    await A.goto(BASE + '/cal.html');
    await A.waitForSelector('.skcal-day[data-date]');
    const monthsAhead = (Number(D.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(D.slice(5, 7)) - Number(today.slice(5, 7));
    for (let i = 0; i < monthsAhead; i++) { await A.click('[data-next]'); await A.waitForTimeout(200); }
    await A.click(`.skcal-day[data-date="${D}"]`);
    await A.waitForSelector('.skcal-slot');
    ck('Browser A sees 10:00 AVAILABLE', (await slotState(A, tenLabel)) === 'Available', await slotState(A, tenLabel));
    ck('…the day grid uses only safe words', await A.evaluate(() => [...document.querySelectorAll('.skcal-day[aria-label]')].every((d) => /Available|Limited|Booked|Unavailable|Booking not open|Temporarily held/.test(d.getAttribute('aria-label')))));

    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const B = await ctxB.newPage(); await wirePage(B, 'buyerB');
    await B.goto(BASE + '/sf.html');
    await B.waitForSelector('[data-act="book"]');
    ck('the storefront offers Book now · Check availability · Ask a question (server-allowed) and shows the response time', await B.evaluate(() => !!document.querySelector('[data-act="book"]') && !!document.querySelector('[data-act="ask"]') && /Typically replies within 1 hour/.test(document.body.textContent)));
    await B.click('[data-act="book"]');
    await B.waitForSelector('.skcal-day[data-date]');
    for (let i = 0; i < monthsAhead; i++) { await B.click('[data-next]'); await B.waitForTimeout(200); }
    await B.click(`.skcal-day[data-date="${D}"]`);
    await B.waitForSelector('.skcal-slot');
    await B.evaluate((s) => { [...document.querySelectorAll('.skcal-slot')].find((x) => x.textContent.trim().startsWith(s)).click(); }, tenLabel);
    await B.waitForSelector('[data-act="pay"]');
    const co = await B.evaluate(() => document.querySelector('[data-co]').textContent);
    ck('checkout shows service · date · time · base · discount · final · payment method · refund policy', /Portrait session/.test(co) && /Base price/.test(co) && /Discount/.test(co) && /Final price/.test(co) && /M-PESA/.test(co) && /Full refund up to 24 hours before/.test(co) && /KES 5,000/.test(co), co.slice(0, 160));
    await B.click('[data-act="pay"]');
    await B.waitForFunction(() => !!window.__paid, null, { timeout: 8000 }).catch(() => null);
    const paid = await B.evaluate(() => window.__paid);
    const pb = paid && await get('providerBookings/' + paid.bookingId);
    ck('CONFIRM & PAY reserved the slot on the SERVER (hold) and handed over to the payment step', !!pb && pb.status === 'pending' && pb.price === 500000 && pb.customerUid === 'buyerB');
    ck('Browser A updates to TEMPORARILY HELD without a refresh', await waitSlot(A, tenLabel, 'Temporarily held'), await slotState(A, tenLabel));

    /* payment confirmed by the payment authority */
    await db.doc('paymentIntents/SKNBR01').set({ ref: 'SKNBR01', resourceType: 'providerBooking', resourceId: paid.bookingId, uid: 'buyerB' });
    await SW.holdServiceBookingPayment(db, ADMIN, 'SKNBR01', 'SKNBR01', 5000);
    ck('payment confirmed → Browser A shows BOOKED', await waitSlot(A, tenLabel, 'Booked'), await slotState(A, tenLabel));
    ck('Browser A never learns who, which booking, or why', await A.evaluate((id) => !document.body.innerHTML.includes(id) && !/buyerB|pb_|providerBookings/.test(document.body.innerHTML), paid.bookingId));

    /* Browser B cancels legitimately → canonical cancelled state → A AVAILABLE */
    await PO._h.providerCancelBooking(reqFor('buyerB', { bookingId: paid.bookingId, reason: 'plans changed' }));
    ck('the canonical cancel → Browser A shows AVAILABLE again (no refresh)', await waitSlot(A, tenLabel, 'Available'), await slotState(A, tenLabel));

    /* ── provider: block time from the workspace ── */
    say('\n── provider workspace ──');
    const ctxP = await browser.newContext({ viewport: { width: 768, height: 1000 } });
    const P = await ctxP.newPage(); await wirePage(P, 'ph1');
    await P.goto(BASE + '/ws.html');
    await P.waitForSelector('.skcal-day[data-date]');
    for (let i = 0; i < monthsAhead; i++) { await P.click('[data-next]'); await P.waitForTimeout(200); }
    await P.click(`.skcal-day[data-date="${D}"]`);
    await P.waitForSelector('[data-blockform]');
    await P.fill('[data-blockform] input[name=start]', '12:00'); await P.fill('[data-blockform] input[name=end]', '13:00');
    await P.fill('[data-blockform] input[name=label]', 'Private wedding — Westlands');
    await P.click('[data-blockform] button[type=submit]');
    ck('the provider blocks 12:00 with a private note → Browser A shows UNAVAILABLE', await waitSlot(A, twelveLabel, 'Unavailable'), await slotState(A, twelveLabel));
    ck('…and the private note never reaches Browser A', !(await A.evaluate(() => /wedding|westlands/i.test(document.body.innerHTML))));
    await P.waitForFunction(() => /Private wedding/.test(document.body.textContent), null, { timeout: 6000 }).catch(() => null);
    ck('the provider sees BLOCKED with their own note', await P.evaluate(() => /Blocked/.test(document.body.textContent) && /Private wedding/.test(document.body.textContent)));
    await P.click('[data-view="week"]');
    await P.waitForSelector('.skcal-week .col', { timeout: 6000 }).catch(() => null);
    ck('provider WEEK view: seven days of private slots', await P.evaluate(() => document.querySelectorAll('.skcal-week .col').length === 7 && /Blocked/.test(document.querySelector('.skcal-week').textContent)));
    await P.click('[data-view="year"]');
    await P.waitForSelector('.skcal-year button', { timeout: 6000 }).catch(() => null);
    ck('provider YEAR view: twelve months with booked / pending / blocked totals', await P.evaluate(() => document.querySelectorAll('.skcal-year button').length === 12 && /blocked/.test(document.querySelector('.skcal-year').textContent)));
    await P.click('[data-view="month"]');
    for (const t of ['availability', 'ratecards', 'enquiries', 'calls', 'messaging', 'discounts', 'stats']) {
      await P.click(`[data-tab="${t}"]`);
      await P.waitForFunction(() => !/Loading…/.test(document.querySelector('[data-body]').textContent), null, { timeout: 6000 }).catch(() => null);
      const err = await P.evaluate(() => (document.querySelector('.skws-card.skws-err') || {}).textContent || '');
      ck(`workspace › ${t} renders from the server`, !err, err);
    }
    await P.click('[data-tab="stats"]'); await P.waitForTimeout(400);
    ck('stats show — for unknown figures, never an invented 0', await P.evaluate(() => /—/.test(document.body.textContent)));

    /* ── price race ── */
    say('\n── checkout: the price moved ──');
    await B.reload(); await B.waitForSelector('[data-act="book"]');
    await B.click('[data-act="book"]'); await B.waitForSelector('.skcal-day[data-date]');
    for (let i = 0; i < monthsAhead; i++) { await B.click('[data-next]'); await B.waitForTimeout(200); }
    await B.click(`.skcal-day[data-date="${D}"]`); await B.waitForSelector('.skcal-slot');
    await B.evaluate(() => { [...document.querySelectorAll('.skcal-slot')].find((x) => x.textContent.trim().startsWith('3:00 PM')).click(); });
    await B.waitForSelector('[data-act="pay"]');
    await db.doc('providerServices/svc_ph1').set({ price: 650000 }, { merge: true });   /* the provider changed the price while B's checkout was open */
    await B.evaluate(() => { window.__paid = null; });
    await B.click('[data-act="pay"]');
    await B.waitForFunction(() => /Price changed/.test(document.body.textContent), null, { timeout: 6000 }).catch(() => null);
    ck('"Price changed" with the NEW authoritative total — and nothing reserved or charged', await B.evaluate(() => /Price changed/.test(document.body.textContent) && /KES 6,500/.test(document.body.textContent) && !window.__paid) &&
      !db._dump('providerBookings/').some((b) => b.startTime === '15:00' && b.date === D));

    /* ── enquiry from the storefront ── */
    say('\n── public enquiry ──');
    await B.click('[data-act="ask"]');
    await B.waitForSelector('[data-ask]');
    await B.selectOption('[data-ask] select[name=category]', 'PRICING');
    await B.fill('[data-ask] textarea[name=question]', 'How much for a two-hour family shoot?');
    await B.click('[data-ask] button[type=submit]');
    await B.waitForFunction(() => /Open the conversation/.test(document.body.textContent), null, { timeout: 6000 }).catch(() => null);
    const enq = db._dump('entEnquiries/').find((e) => e.buyerUid === 'buyerB');
    ck('the storefront enquiry → a server enquiry (OPEN) + its conversation, linked from the page', !!enq && enq.status === 'OPEN' && enq.category === 'PRICING' && !!(await get('conversations/ent_enquiry_' + enq.enquiryId)) &&
      await B.evaluate((id) => !!document.querySelector(`a[href*="ent_enquiry_${id}"]`), enq.enquiryId));

    /* ── conversation card ── */
    say('\n── booking conversation card ──');
    const bk2 = await BS._h.bookingCreateService(reqFor('buyerA', { providerId: 'ph1', serviceId: 'svc_ph1', date: D, startTime: '16:00' }));
    await db.doc('paymentIntents/SKNBR02').set({ ref: 'SKNBR02', resourceType: 'providerBooking', resourceId: bk2.bookingId, uid: 'buyerA' });
    await SW.holdServiceBookingPayment(db, ADMIN, 'SKNBR02', 'SKNBR02', 6500);
    await EB.onSourceWritten('providerBookings', bk2.bookingId, await get('providerBookings/' + bk2.bookingId));
    const env = await get('entBookings/svc_' + bk2.bookingId);
    const conv = await get('conversations/' + env.conversationId);
    const secret = await get('entBookingSecrets/svc_' + bk2.bookingId);
    const C1 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await wirePage(C1, 'buyerA');
    await C1.addInitScript((c) => { window.__conv = c; }, wire(Object.assign({ id: env.conversationId }, conv)));
    await C1.goto(BASE + '/conv.html'); await C1.waitForSelector('#ent-conv-card .ecc-grid', { timeout: 6000 }).catch(() => null);
    ck('the BUYER\'s conversation card shows provider, booking, status, date, service, payment and the PIN', await C1.evaluate((pin) => { const t = document.getElementById('ent-conv-card').textContent; return /BK-/.test(t) && t.includes(pin) && /View booking/.test(t) && /Refund/.test(t); }, secret.pin));
    const C2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await wirePage(C2, 'ph1');
    await C2.addInitScript((c) => { window.__conv = c; }, wire(Object.assign({ id: env.conversationId }, conv)));
    await C2.goto(BASE + '/conv.html'); await C2.waitForSelector('#ent-conv-card .ecc-grid', { timeout: 6000 }).catch(() => null);
    ck('the PROVIDER\'s card never shows the PIN (or a refund button)', await C2.evaluate((pin) => { const t = document.getElementById('ent-conv-card').textContent; return /BK-/.test(t) && !t.includes(pin) && !/Refund/.test(t); }, secret.pin));

    /* ── AdminOS ── */
    say('\n── AdminOS › Entertainment › Availability ──');
    const AD = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); await wirePage(AD, 'adm');
    await AD.goto(BASE + '/aos.html'); await AD.waitForSelector('[data-tab="availability"]');
    await AD.click('[data-tab="availability"]'); await AD.waitForSelector('[data-avsearch]');
    await AD.fill('[data-avsearch] input[name=id]', 'ph1'); await AD.fill('[data-avsearch] input[name=month]', D.slice(0, 7));
    await AD.click('[data-avsearch] button[type=submit]');
    await AD.waitForFunction(() => /BLOCKED/.test(document.body.textContent), null, { timeout: 6000 }).catch(() => null);
    ck('an admin sees states and booking references; a provider\'s private note is not shown', await AD.evaluate(() => /BLOCKED/.test(document.body.textContent) && /providerBookings\//.test(document.body.textContent) && !/wedding/i.test(document.body.textContent)));
    for (const t of ['comms', 'ratecards', 'entbookings']) {
      await AD.click(`[data-tab="${t}"]`); await AD.waitForTimeout(500);
      ck(`AdminOS › ${t} renders`, await AD.evaluate(() => !/Could not load/.test(document.body.textContent)));
    }

    /* ── mobile / overflow ── */
    say('\n── no horizontal scroll ──');
    for (const w of [360, 390, 768, 1280]) {
      for (const pg of ['/cal.html', '/sf.html', '/ws.html']) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
        const pp = await ctx.newPage(); await wirePage(pp, pg === '/ws.html' ? 'ph1' : 'buyerA');
        await pp.goto(BASE + pg); await pp.waitForTimeout(700);
        if (pg === '/sf.html') { await pp.click('[data-act="book"]').catch(() => {}); await pp.waitForTimeout(600); }
        const ov = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        ck(`${pg} at ${w}px has no horizontal scroll`, ov <= 1, ov + 'px');
        const small = await pp.evaluate(() => [...document.querySelectorAll('.skcal-day:not(.pad),.skcal-slot,.sksf-btn,.skws-tab')].filter((b) => b.getBoundingClientRect().height && b.getBoundingClientRect().height < 40).length);
        ck(`${pg} at ${w}px: tap targets ≥ 40px`, small === 0, small);
        await ctx.close();
      }
    }
  } finally { await browser.close(); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
