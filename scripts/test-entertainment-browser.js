/* test-entertainment-browser.js — Entertainment dashboards certified in a REAL browser (Chromium),
 * at 360 / 390 / 768 / 1024 / 1280 / 1440 px.
 *
 * REAL pages and REAL widget code: event-hub.html (buyer pay panel), event-manager.html (organizer
 * application gate AND the organizer workspace), venue-manager.html, provider-dashboard.html,
 * sokoni-dashboard-profile.js, sokoni-aos-entertainment.js. Only infrastructure is stubbed
 * (Firebase SDK, shared header, auth guard). Callables are answered by a Node stub; nothing
 * reaches a network, a provider or production.
 *
 * AT EVERY WIDTH
 *   · no horizontal page overflow
 *   · the profile icon is visible, the menu OPENS on click, lies fully inside the viewport,
 *     and offers Sign Out; Sign Out works; Escape closes it; no admin link is offered
 *   · event-hub pay panel: fully inside the viewport, M-PESA always offered, card/other methods
 *     ONLY when the server reports them proven; an invalid phone is refused client-side
 *   · event-manager (non-organizer): the application form renders inside the viewport and
 *     submits a canonical applications/{id} (type event_organizer, agreementAccepted)
 *   · AdminOS Entertainment panel renders every tab; unknown figures show "—", never 0
 *
 *   node scripts/test-entertainment-browser.js
 */
'use strict';
const Path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;

const WIDTHS = [360, 390, 768, 1024, 1280, 1440];
const REAL = new Set(['/event-hub.html', '/event-manager.html', '/venue-manager.html', '/provider-dashboard.html',
  '/sokoni-dashboard-profile.js', '/sokoni-dashboard-profile-core.js', '/sokoni-aos-entertainment.js', '/sokoni-hub-nav.js', '/sokoni-form-nav.js']);

/* ── Firebase compat stub (gstatic compat SDKs AND /firebase.js) ── */
const COMPAT = `
(function(){
  if (window.firebase && window.firebase.__stub) return;
  window.__adds = [];
  const call = (name) => async (data) => { const r = await window.__srv(name, data || {}); if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; throw e; } return { data: r.ok }; };
  const snap0 = { empty: true, docs: [], size: 0, forEach(){}, exists: false, data: () => ({}) };
  const q = (name) => ({ where(){ return q(name); }, limit(){ return q(name); }, orderBy(){ return q(name); }, startAfter(){ return q(name); },
    get: async () => snap0, onSnapshot: () => () => {},
    add: async (d) => { window.__adds.push({ name, d }); return { id: 'new' + window.__adds.length }; },
    doc: () => ({ get: async () => snap0, set: async () => {}, update: async () => {}, onSnapshot: () => () => {}, collection: (n) => q(n) }) });
  const user = () => window.__user ? Object.assign({}, window.__user, { getIdTokenResult: async () => ({ claims: window.__user.claims || {} }), getIdToken: async () => 'tok' }) : null;
  const authObj = { get currentUser() { return user(); }, onAuthStateChanged(cb) { setTimeout(() => cb(user()), 0); return () => {}; },
    signOut: async () => { window.__signedOut = (window.__signedOut || 0) + 1; } };
  window.firebase = { __stub: true, apps: [{}], initializeApp: () => ({}), app: () => ({}),
    auth: () => authObj,
    functions: () => ({ useRegion(){}, httpsCallable: (n) => call(n) }),
    firestore: Object.assign(() => ({ collection: q, doc: () => q('x').doc(), batch: () => ({ set(){}, update(){}, commit: async () => {} }) }),
      { FieldValue: { serverTimestamp: () => null, increment: () => null, arrayUnion: () => null }, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }),
    storage: () => ({ ref: () => ({}) }), messaging: () => ({}), appCheck: () => ({ activate(){} }) };
  window.firebaseApp = {};
  window.SOKONI_CONFIG = window.SOKONI_CONFIG || {};
})();`;

const AOS_HARNESS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font-family:sans-serif;background:#000;color:#fff}.aos-table-wrap{overflow-x:auto}.aos-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}</style></head>
<body><div id="host" style="padding:8px"></div><script src="/sokoni-aos-entertainment.js"></script>
<script>window.SokoniAOSEntertainment.mount({ host: document.getElementById('host'), call: async (op, d) => { const r = await window.__srv(op, d || {}); if (r.err) throw new Error(r.err.message); return r.ok; } });</script></body></html>`;

/* ── the "server" ── */
let HOSTED = false;
const calls = [];
async function server(name, data) {
  calls.push({ name, data });
  switch (name) {
    case 'listEvents': case 'searchEvents': return { ok: { events: [], nextCursor: null } };
    case 'getMyTickets': return { ok: { tickets: [] } };
    case 'getCheckoutMethods': return { ok: { purpose: data.purpose, stk: { method: 'M-PESA' }, hosted: HOSTED, hostedMethods: HOSTED ? ['CARD-PAYMENT'] : [] } };
    case 'getOrganizerDashboard': return { ok: { events: [], totals: {} } };
    case 'providerDispatch': case 'providerDashboard': return { ok: { profile: { name: 'Test Provider' }, bookings: [], services: [] } };
    case 'eventAdminOverview': return { ok: { events: { live: 2 }, settlements: null, heldOrganizerNetCents: null, commissionCents: 2955, openExceptions: 0, ordersAwaitingRefund: null, policy: 3 } };
    case 'eventAdminEvents': return { ok: { events: [{ id: 'e1', title: 'Gig', status: 'live', organizerUid: 'org1', startDate: '2026-12-01T18:00:00Z', totalTicketsSold: 4 }] } };
    case 'eventAdminSettlements': return { ok: { settlements: [{ id: 'P1', paymentRef: 'P1', status: 'FEE_UNREPORTED', grossCents: 100000, providerFeeCents: null, commissionCents: null, organizerNetCents: null, releaseAfter: null }] } };
    case 'eventAdminRefundQueue': return { ok: { orders: [] } };
    case 'eventAdminExceptions': return { ok: { exceptions: [] } };
    case 'entAdminListings': return { ok: { kind: data.kind, status: data.status, listings: [{ id: 'v1', name: 'Hall', uid: 'o1', status: 'pending' }] } };
    case 'entAdminMatrix': {
      const REG = require(Path.join(ROOT, 'functions', 'shared', 'entertainment-registry.js'));
      const POL = require(Path.join(ROOT, 'functions', 'shared', 'commercial-policy.js'));
      return { ok: { categories: REG.CATEGORIES, orphans: REG.orphans(), commercialPolicies: POL.matrix() } };
    }
    default: return { ok: {} };
  }
}

const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/firebase.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(COMPAT); }
  if (p === '/aos-harness.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(AOS_HARNESS); }
  if (REAL.has(p)) {
    res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/javascript' });
    return res.end(fs.readFileSync(Path.join(ROOT, p.slice(1))));
  }
  if (/\.m?js$/.test(p)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('/* stubbed infrastructure */'); }
  if (/\.css$/.test(p)) { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(''); }
  res.writeHead(404); res.end();
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

/* page-level checks */
/* Measured against the DEVICE width: with mobile emulation, content wider than the screen WIDENS the
   layout viewport, so comparing scrollWidth with innerWidth would pass a page that overflows. */
let DEVICE_W = 0;
const noOverflow = (page) => page.evaluate((w) => document.documentElement.scrollWidth <= w + 1 && window.innerWidth <= w + 1, DEVICE_W);
const inViewport = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s); if (!el) return { found: false };
  const r = el.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight;
  return { found: true, visible: r.width > 0 && r.height > 0, inside: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1, r: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom), vw, vh] };
}, sel);

async function profileMenu(page, hostSel, label, w) {
  const trig = `${hostSel} [data-act="open-profile"]`;
  const t = await inViewport(page, trig);
  ck(`${label} @${w}: profile icon visible and on-screen`, t.found && t.visible && t.inside, t.r);
  if (!t.found) return;
  await page.click(trig);
  const pop = await inViewport(page, `${hostSel} [data-popup="profile"]:not([hidden])`);
  ck(`${label} @${w}: menu opens fully inside the viewport`, pop.found && pop.visible && pop.inside, pop.r);
  const info = await page.evaluate((h) => {
    const p = document.querySelector(h + ' [data-popup="profile"]');
    const links = [...p.querySelectorAll('a,button')].map((a) => (a.getAttribute('href') || '') + '|' + a.textContent.trim());
    return { links, expanded: document.querySelector(h + ' [data-act="open-profile"]').getAttribute('aria-expanded') };
  }, hostSel);
  ck(`${label} @${w}: menu has Sign Out, aria-expanded=true, NO admin link`, info.links.some((l) => /Sign Out/.test(l)) && info.expanded === 'true' && !info.links.some((l) => /admin/i.test(l)), info.links.join(' , ').slice(0, 150));
  await page.keyboard.press('Escape');
  const closed = await page.evaluate((h) => document.querySelector(h + ' [data-popup="profile"]').hidden, hostSel);
  ck(`${label} @${w}: Escape closes the menu`, closed === true);
}

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const ctxFor = async (user, width) => {
    const c = await browser.newContext({ viewport: { width, height: width < 700 ? 740 : 900 }, hasTouch: width < 700, isMobile: width < 700 });
    await c.exposeBinding('__srv', async (_src, name, data) => server(name, data));
    await c.addInitScript((u) => { window.__user = u; try { localStorage.setItem('sokoniUser', JSON.stringify(u)); localStorage.setItem('sokoni_logged_in', '1'); } catch (_) {} }, user);
    /* A LATER route wins — the catch-all first, then the SDK stubs. */
    await c.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await c.route(/gstatic\.com\/firebasejs\/.*\.js$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: COMPAT }));
    return c;
  };
  const buyer = { uid: 'buyer1', email: 'buyer@example.com', displayName: 'Achieng Otieno', claims: {} };
  const organizer = { uid: 'org1', email: 'org@example.com', displayName: 'Kamau Events', claims: { event_organizer: true } };
  const provider = { uid: 'pv1', email: 'pv@example.com', displayName: 'DJ Test', claims: { provider: true } };
  try {
    for (const w of WIDTHS) {
      DEVICE_W = w;
      say(`\n── ${w}px ──`);

      /* event-hub: buyer pay panel */
      let c = await ctxFor(buyer, w); let page = await c.newPage();
      await page.goto(BASE + '/event-hub.html'); await page.waitForTimeout(250);
      ck(`event-hub @${w}: no horizontal overflow`, await noOverflow(page));
      HOSTED = false;
      await page.evaluate(() => { document.getElementById('overlay').classList.add('open'); window.showPayPanel({ orderId: 'ORD00001', ticketCount: 2, totalAmount: 1000, currency: 'KES', payment: { purpose: 'event_ticket', orderId: 'ORD00001' } }); });
      await page.waitForTimeout(150);
      const stk = await inViewport(page, '#pay-stk');
      ck(`event-hub @${w}: "Pay with M-PESA" on-screen`, stk.found && stk.inside, stk.r);
      ck(`event-hub @${w}: card/other methods HIDDEN when not proven`, !(await page.$('#pay-hosted')));
      await page.fill('#pay-phone', '12345'); await page.click('#pay-stk');
      ck(`event-hub @${w}: invalid phone refused before any intent`, /valid Safaricom/.test(await page.textContent('#pay-msg')) && !calls.some((x) => x.name === 'createPaymentIntent' && x.data.orderId === 'ORD00001'));
      HOSTED = true;
      await page.evaluate(() => window.showPayPanel({ orderId: 'ORD00002', ticketCount: 1, totalAmount: 500, currency: 'KES', payment: {} }));
      await page.waitForTimeout(150);
      ck(`event-hub @${w}: card/other methods SHOWN only once proven`, !!(await page.$('#pay-hosted')));
      ck(`event-hub @${w}: pay panel causes no horizontal overflow`, await noOverflow(page));
      await c.close();

      /* event-manager: non-organizer sees the application form */
      c = await ctxFor(buyer, w); page = await c.newPage();
      await page.goto(BASE + '/event-manager.html'); await page.waitForSelector('#org-form', { timeout: 8000 }).catch(() => null);
      const form = await inViewport(page, '#org-form button[type=submit]');
      ck(`event-manager (applicant) @${w}: application form renders`, form.found, form.r);
      ck(`event-manager (applicant) @${w}: no horizontal overflow`, await noOverflow(page));
      if (w === 390) {
        await page.fill('[name=name]', 'Kamau Events'); await page.fill('[name=phone]', '0712345678');
        await page.check('[name=eventTypes]'); await page.fill('[name=payoutPhone]', '0712345678');
        await page.fill('[name=idLast4]', '1234'); await page.check('[name=agree]');
        await page.click('#org-form button[type=submit]'); await page.waitForTimeout(200);
        const adds = await page.evaluate(() => window.__adds);
        const a = adds.find((x) => x.name === 'applications');
        ck('event-manager: submits a canonical application (type event_organizer, agreement accepted, own uid)',
          a && a.d.type === 'event_organizer' && a.d.role === 'event_organizer' && a.d.agreementAccepted === true && a.d.uid === 'buyer1' && !('status' in a.d && a.d.status !== 'pending'), a && JSON.stringify(a.d).slice(0, 140));
        ck('event-manager: ID stored as last-4 only (no full document number)', a && a.d.identity && a.d.identity.documentLast4 === '1234' && Object.keys(a.d.identity).length === 2);
      }
      await profileMenu(page, '#sk-identity', 'event-manager (applicant)', w);
      await c.close();

      /* event-manager: organizer workspace */
      c = await ctxFor(organizer, w); page = await c.newPage();
      await page.goto(BASE + '/event-manager.html'); await page.waitForTimeout(400);
      ck(`event-manager (organizer) @${w}: workspace (not the form) renders`, !(await page.$('#org-form')) && !!(await page.$('.layout')));
      ck(`event-manager (organizer) @${w}: no horizontal overflow`, await noOverflow(page));
      await profileMenu(page, '#sk-identity', 'event-manager (organizer)', w);
      await page.click('#sk-identity [data-act="open-profile"]');
      await page.click('#sk-identity [data-act="sign-out"]'); await page.waitForTimeout(150);
      ck(`event-manager @${w}: Sign Out signs out`, await page.evaluate(() => (window.__signedOut || 0) >= 1 || /login\.html/.test(location.href)));
      await c.close();

      /* venue-manager */
      c = await ctxFor(organizer, w); page = await c.newPage();
      await page.goto(BASE + '/venue-manager.html'); await page.waitForTimeout(400);
      ck(`venue-manager @${w}: no horizontal overflow`, await noOverflow(page));
      await profileMenu(page, '#sk-identity', 'venue-manager', w);
      await c.close();

      /* provider-dashboard (performers) — mobile identity below 768, sidebar identity above */
      c = await ctxFor(provider, w); page = await c.newPage();
      await page.goto(BASE + '/provider-dashboard.html'); await page.waitForTimeout(300);
      await page.evaluate(() => { if (typeof _mountDashIdentity === 'function') _mountDashIdentity({ name: 'DJ Test' }, window.__user); });
      await page.waitForTimeout(100);
      const host = w <= 768 ? '#dash-identity-mobile' : '#dash-identity';
      ck(`provider-dashboard @${w}: no horizontal overflow`, await noOverflow(page));
      await profileMenu(page, host, 'provider-dashboard', w);
      await c.close();

      /* AdminOS › Entertainment panel */
      c = await ctxFor({ uid: 'adm', claims: { admin: true } }, w); page = await c.newPage();
      await page.goto(BASE + '/aos-harness.html'); await page.waitForTimeout(300);
      await page.waitForSelector('#aosentBody .aos-kpis', { timeout: 5000 }).catch(() => null);
      const ov = await page.textContent('#host');
      ck(`AdminOS Entertainment @${w}: overview renders; unknown shows "—", known 29.55`, /—/.test(ov) && /29\.55/.test(ov) && !/KES 0\.00/.test(ov));
      for (const tab of ['events', 'settlements', 'refunds', 'exceptions', 'listings', 'matrix']) {
        await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(120);
        const t = await page.textContent('#aosentBody');
        ck(`AdminOS Entertainment @${w}: ${tab} tab renders`, !/Could not load/.test(t), t.slice(0, 60));
      }
      const mt = await page.textContent('#aosentBody');
      ck(`AdminOS Entertainment @${w}: matrix shows every category + 30 / 3 / 15 / 5 rates`, /Streaming/.test(mt) && /Events & Ticketing/.test(mt) && /30%/.test(mt) && /3%/.test(mt) && /15%/.test(mt) && /5%/.test(mt));
      ck(`AdminOS Entertainment @${w}: no horizontal page overflow`, await noOverflow(page));
      await c.close();
    }
  } finally {
    await browser.close(); srv.close();
  }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(3); });
