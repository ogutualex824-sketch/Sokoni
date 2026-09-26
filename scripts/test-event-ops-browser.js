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
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
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
ES.registerPurpose();

const USERS = {
  org1: { uid: 'org1', email: 'org1@x.co', displayName: 'Kamau Events', claims: { event_organizer: true } },
  till1: { uid: 'till1', email: 'till1@x.co', displayName: 'Till One', claims: {} },
  gate1: { uid: 'gate1', email: 'gate1@x.co', displayName: 'Gate One', claims: {} },
  buyer1: { uid: 'buyer1', email: 'buyer1@x.co', displayName: 'Achieng Otieno', claims: {} },
};
const reqFor = (uid, data) => ({ auth: { uid, token: { email: USERS[uid].email, email_verified: true, ...USERS[uid].claims } }, rawRequest: { headers: { 'user-agent': 'chromium-harness' } }, data });
/* Like the real callable protocol, results cross the wire as JSON: Timestamps become ISO strings. */
const wire = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x.toMillis === 'function' ? new Date(x.toMillis()).toISOString() : x)));
async function server(name, data, uid) {
  const r = await _server(name, data, uid);
  return r.ok !== undefined ? { ok: wire(r.ok) } : r;
}
async function _server(name, data, uid) {
  try {
    if (name === 'eventOpsDispatch') {
      const h = OPS._h[data.op] || SALES._h[data.op] || RF._h[data.op];
      if (!h) return { err: { code: 'not-found', message: 'unknown op ' + data.op } };
      return { ok: await h(reqFor(uid, data)) };
    }
    const fnMap = { getEvent: EH.getEvent, getMyTickets: EH.getMyTickets, getOrganizerDashboard: EH.getOrganizerDashboard, listEvents: EH.listEvents, searchEvents: EH.searchEvents };
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
const REAL = new Set(['/event-manager.html', '/event-hub.html', '/sokoni-event-ops.js', '/sokoni-event-refund-reasons.js', '/sokoni-hub-nav.js',
  '/sokoni-dashboard-profile.js', '/sokoni-dashboard-profile-core.js']);
const srv = http.createServer((rq, res) => {
  const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  if (p === '/firebase.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(COMPAT); }
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
  await db.doc('events/evA').set({ eventId: 'evA', title: 'Nairobi Jazz Night', organizerUid: 'org1', status: 'live', startDate: new Date(NOW + 48 * H).toISOString(), endDate: new Date(NOW + 52 * H).toISOString(), totalTicketsSold: 0, createdAt: F.Timestamp.fromMillis(NOW),
    refundPolicy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 24 * H).toISOString(), noShowRefund: true } });
  await db.doc('eventTicketTiers/VIP').set({ tierId: 'VIP', eventId: 'evA', name: 'VIP', price: 5000, quantity: 100, sold: 0, isActive: true, currency: 'KES' });
  await db.doc('eventTicketTiers/REG').set({ tierId: 'REG', eventId: 'evA', name: 'Regular', price: 2000, quantity: 500, sold: 0, isActive: true, currency: 'KES' });
  for (const [uid, role] of [['till1', 'cashier'], ['gate1', 'admission']]) {
    await OPS._h.eventStaffInvite(reqFor('org1', { eventId: 'evA', email: USERS[uid].email, role }));
    await OPS._h.eventStaffAccept(reqFor(uid, { eventId: 'evA' }));
  }
  /* a paid online order for the buyer, through the REAL activation */
  const oid = 'ORDBUY1';
  await db.doc(`eventOrders/${oid}`).set({ orderId: oid, buyerUid: 'buyer1', eventId: 'evA', tierId: 'REG', tierName: 'Regular', quantity: 2, totalAmount: 4000, currency: 'KES', status: 'pending_payment', attendeeName: 'Achieng Otieno', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < 2; i++) await db.doc(`eventTickets/${oid}_k${i}`).set({ ticketId: `${oid}_k${i}`, orderId: oid, eventId: 'evA', buyerUid: 'buyer1', tierName: 'Regular', status: 'awaiting_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`paymentIntents/${oid}`).set({ ref: oid, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: oid, uid: 'buyer1', ownerUid: 'buyer1', amount: 4000, amountCents: 400000, currency: 'KES', metadata: { eventId: 'evA', organizerUid: 'org1' } });
  await db.doc(`payments/${oid}`).set({ ref: oid, uid: 'buyer1', amount: 4000, amountCents: 400000, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 60 } });
  await ES.activateIfEventTicket(oid);
  /* a SEPARATE paid order the gate flows admit — the buyer's own order stays unused for the refund wizard */
  const g = 'ORDGATE1';
  await db.doc(`eventOrders/${g}`).set({ orderId: g, buyerUid: 'buyer2', eventId: 'evA', tierId: 'REG', tierName: 'Regular', quantity: 2, totalAmount: 4000, currency: 'KES', status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  for (let i = 0; i < 2; i++) await db.doc(`eventTickets/${g}_k${i}`).set({ ticketId: `${g}_k${i}`, orderId: g, eventId: 'evA', buyerUid: 'buyer2', tierName: 'Regular', attendeeName: 'Achieng Otieno', status: 'awaiting_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`paymentIntents/${g}`).set({ ref: g, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: g, uid: 'buyer2', ownerUid: 'buyer2', amount: 4000, amountCents: 400000, currency: 'KES', metadata: { eventId: 'evA', organizerUid: 'org1' } });
  await db.doc(`payments/${g}`).set({ ref: g, uid: 'buyer2', amount: 4000, amountCents: 400000, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 60 } });
  await ES.activateIfEventTicket(g);
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
        await pg.click('[data-inc="VIP"]'); await pg.click('[data-tender="cash"]');
        await pg.fill('#qsCash', '6000'); await pg.click('#qsDo');
        await pg.waitForSelector('.eo-pin', { timeout: 8000 }).catch(() => null);
        const pinShown = await pg.textContent('#qsOut').catch(() => '');
        const sales = db._dump('eventSales/').filter((x) => x.cashierUid === 'till1' && x.tender === 'cash');
        const last = sales[sales.length - 1] || {};
        ck(`cashier @${w}: cash sale → PIN shown to hand over`, /[A-Z2-9]{4}-[A-Z2-9]{4}/.test(pinShown), pinShown.slice(0, 60));
        ck(`cashier @${w}: server wrote a COMPLETED 5,000 sale + valid ticket + 3 % receivable`, last.status === 'COMPLETED' && last.grossCents === 500000
          && db._dump('eventTickets/').some((t) => t.saleId === last.saleId && t.status === 'valid') && ((await get(`eventCommissionReceivables/${last.saleId}`)) || {}).amountCents === 15000);
        ck(`cashier @${w}: change shown (1,000)`, /change KES 1,000/.test(await pg.textContent('#qsMsg')));
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
        await pg.click('#adAdmit'); await pg.waitForFunction(() => /Admitted|Already|✗/.test(document.getElementById('adOut').textContent), null, { timeout: 8000 }).catch(() => null);
        const _ad = await pg.textContent('#adOut');
        ck(`gate @${w}: Admit → server ADMITTED`, /Admitted/.test(_ad) && (await get(`eventTickets/${tk}`)).admissionStatus === 'ADMITTED', _ad + ' | server=' + (await get(`eventTickets/${tk}`)).admissionStatus);
        await pg.fill('#adPin', pin); await pg.click('#adVerify'); await pg.waitForFunction(() => !/Checking/.test(document.getElementById('adOut').textContent), null, { timeout: 8000 }).catch(() => null);
        ck(`gate @${w}: the same PIN again is refused`, /Already admitted/.test(await pg.textContent('#adOut')));
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
        ck(`organizer @${w}: finance shows settled figures (online + door)`, /Gross ticket sales/.test(fin) && /Online salesKES 8,000/.test(fin) && /SOKONI commission on door sales/.test(fin), fin.slice(0, 160));
      }
      await c.close();

      /* buyer */
      c = await ctxFor('buyer1', w); pg = await c.newPage();
      await pg.goto(BASE + '/event-hub.html'); await pg.waitForTimeout(400);
      await pg.evaluate(() => { document.getElementById('my-tickets-panel').style.display = 'block'; return window.loadMyTickets ? null : null; });
      await pg.evaluate(() => (typeof loadMyTickets === 'function') && loadMyTickets()); await pg.waitForTimeout(400);
      const mt = await pg.textContent('#my-tickets-list');
      ck(`buyer @${w}: My Tickets shows the ticket PIN + number`, /[A-Z2-9]{4}-[A-Z2-9]{4}/.test(mt) && /SK-EVT-/.test(mt));
      ck(`buyer @${w}: My Tickets has no horizontal overflow`, await noOverflow(pg, w));
      if (flows && w === 1280) {
        await pg.evaluate((o) => window.openRefundWizard(o), oid); await pg.waitForSelector('#rw-reason');
        await pg.selectOption('#rw-reason', 'cannot_attend'); await pg.click('#rw-next'); await pg.waitForSelector('#rw-check');
        await pg.click('#rw-check'); await pg.waitForTimeout(400);
        const step3 = await pg.textContent('#modal-content');
        ck('buyer: the wizard shows the SERVER eligibility (YES, before the deadline)', /Refund eligibility/.test(step3) && /YES/.test(step3), step3.slice(0, 120));
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
    }
  } finally { await browser.close(); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(3); });
