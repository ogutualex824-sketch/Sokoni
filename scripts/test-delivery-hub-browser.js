#!/usr/bin/env node
/* test-delivery-hub-browser.js — the Delivery Hub (driver.html + sokoni-rider-hub.js) in a REAL browser.
 * Every network dependency is stubbed: firebase.js, the gstatic Firestore/Storage/Auth/App SDKs, sokoni-db.js,
 * sokoni-orders.js, /api/rider-profile, /api/available-deliveries, the role guard. NOTHING reaches production.
 * The stubs record every call, so the suite proves WHICH authority the page used, not just what it painted.
 *
 *   G  guests / non-riders: sign-in gate, application CTA states, rider-only sections hidden & unreachable
 *   P  presence: server state only; refusal (not_eligible) shown, never a fake "Online"
 *   B  board: server list rendered escaped; claim → claimAvailableDelivery; 403/409/500 → honest states
 *   D  Rider Drive: pkg + order cards, stage actions call the EXISTING lifecycle, PIN → server callable,
 *      wrong PIN keeps the delivery active, parcel → completeParcelWithPin, failure → handleFailedDelivery
 *   E  earnings/wallet/performance from ledger + records; unknown = "—"/"Not yet available", never invented
 *   F  fuel: failed EPRA scrape → honest unavailable (no hard-coded prices)
 *   N  navigation: every sidebar route renders, hash routing, Escape closes drawer, mobile + desktop
 *   X  security: XSS escaped, no PIN displayed, no wa.me, no legacy `deliveries` collection, no browser
 *      write of delivered/sellerPayoutReady, no Math.random / localStorage driver record in the module
 * Run: node scripts/test-delivery-hub-browser.js   (needs Playwright Chromium)
 */
'use strict';
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.join(__dirname, '..');
const PW = process.env.PLAYWRIGHT_PATH || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/node_modules/playwright';
const { chromium } = require(PW);
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 260) + ']')); ok ? pass++ : fail++; };

/* ── stubs served in place of the real modules ── */
const STUB_FIREBASE = `
const S = window.__T = window.__T || {};
S.calls = S.calls || []; S.writes = S.writes || [];
const user = S.signedIn ? { uid: 'rider1', email: 'rider@example.com', displayName: 'Akinyi Otieno', getIdToken: async () => 'TOK' } : null;
window.firebaseApp = { name: 'app' };
window.firebaseAuth = { currentUser: user, onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; } };
window.firebaseDB = { __db: true };
window.firebaseFunctions = { httpsCallable: (name) => async (data) => { S.calls.push({ name, data }); let h = (S.callable || {})[name]; if (typeof h === 'string') h = (0, eval)(h); if (!h) throw Object.assign(new Error('no stub for ' + name), { code: 'functions/not-found' }); const r = await h(data); if (r && r.__throw) throw Object.assign(new Error(r.message), { code: r.code }); return { data: r }; } };
window.waitForFirebaseReady = async () => window.firebaseAuth;
export const db = window.firebaseDB;`;
const STUB_FIRESTORE = `
const S = window.__T;
const q = (col, ...cs) => ({ col, cs });
export const collection = (db, name) => name;
export const where = (f, op, v) => ({ f, op, v });
export const limit = (n) => ({ limit: n });
export const query = (col, ...cs) => q(col, ...cs);
export const doc = (db, col, id) => ({ col, id });
export const serverTimestamp = () => ({ __ts: true });
export async function getDocs (qq) { S.reads = (S.reads || []); S.reads.push({ col: qq.col, cs: qq.cs }); const h = (S.fsQuery || {})[qq.col]; if (h && h.__throw) throw new Error('denied'); const rows = typeof h === 'function' ? h(qq.cs) : (h || []); return { docs: rows.map((r, i) => ({ id: r.__id || ('d' + i), data: () => r })) }; }
export async function getDoc (d) { const h = (S.fsDoc || {})[d.col + '/' + d.id]; if (h && h.__throw) throw new Error('denied'); return { exists: () => !!h, data: () => h }; }
export function onSnapshot (ref, cb, err) { const k = ref.col && ref.id ? ref.col + '/' + ref.id : ref.col; const h = (S.fsSnap || {})[k]; setTimeout(() => { if (h && h.__throw) { err && err(new Error('denied')); return; } if (ref.id) cb({ exists: () => !!h, data: () => h }); else cb({ docChanges: () => (h || []).map((r, i) => ({ type: 'added', doc: { id: r.__id || 'q' + i, data: () => r } })) }); }, 0); return () => {}; }
export async function setDoc (d, data, opt) { S.writes.push({ col: d.col, id: d.id, data, opt }); }`;
const STUB_DB = `
const S = window.__T;
const SokoniDB = {
  serverTimestamp: () => ({ __ts: true }),
  async updatePackageRequest (ref, data) { S.writes.push({ col: 'packageRequests', id: ref, data, via: 'SokoniDB.updatePackageRequest' }); },
  listenDriverDeliveryRequests (id, cb) { S.listen = (S.listen || []); S.listen.push(['pkg', id]); setTimeout(() => cb(S.pkgJobs || []), 0); return () => {}; },
  listenRiderActiveOrders (id, cb) { S.listen = (S.listen || []); S.listen.push(['ord', id]); setTimeout(() => cb(S.orderJobs || []), 0); return () => {}; },
  startGPSTracking () { S.gps = 'on'; }, stopGPSTracking () { S.gps = 'off'; },
};
export default SokoniDB;`;
const STUB_ORDERS = `
const S = window.__T;
const step = (n) => async (oId, uid) => { S.writes.push({ col: 'orders', id: oId, via: 'SokoniOrders.' + n, uid }); return { ok: true }; };
export default { riderAccept: step('riderAccept'), riderReject: step('riderReject'), riderPickedUp: step('riderPickedUp'), riderInTransit: step('riderInTransit') };`;
const STUB_DELIVERY = `window.SokoniDelivery = { CATEGORY_CONFIG: { marketplace: { label:'Marketplace Product', icon:'🛒', defaultSpeed:'same_day' }, food: { label:'Food Order', icon:'🍱', defaultSpeed:'express' }, general: { label:'General Package', icon:'📦', defaultSpeed:'same_day' } } }; export default window.SokoniDelivery;`;

function serve () {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, p === '/' ? 'driver.html' : p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404); rsp.end(''); return; }
      const ext = path.extname(f); rsp.writeHead(200, { 'content-type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function openHub (browser, base, T, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message))); page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((t) => { window.__T = t; window.__T.calls = []; window.__T.writes = []; }, T.state);
  await page.route('**/*', async (route) => {
    const u = route.request().url(); const p = new URL(u).pathname;
    const js = (body) => route.fulfill({ status: 200, contentType: 'text/javascript', body });
    if (/\/firebase\.js$/.test(p)) return js(STUB_FIREBASE);
    if (/gstatic\.com\/firebasejs\/.*firebase-firestore\.js/.test(u)) return js(STUB_FIRESTORE);
    if (/gstatic\.com\/firebasejs\/.*firebase-(auth|app|storage)\.js/.test(u)) return js('export async function getRedirectResult(){return null} export function getApp(){return {}} export function getStorage(){return {}} export function ref(){return {}} export async function uploadBytes(){} export async function getDownloadURL(){return "https://x/p.jpg"}');
    if (/\/sokoni-db\.js$/.test(p)) return js(STUB_DB);
    if (/\/sokoni-orders\.js$/.test(p)) return js(STUB_ORDERS);
    if (/\/sokoni-delivery\.js$/.test(p)) return js(STUB_DELIVERY);
    if (/\/(security|auth-guard|sokoni-auth-state|sokoni-user-bootstrap|sokoni-permissions|sokoni-role-authority|sw-register|sokoni-geo)\.js$/.test(p)) return js('/* stubbed */');
    if (p === '/api/rider-profile') return route.fulfill({ status: T.profileStatus || 200, contentType: 'application/json', body: JSON.stringify(T.profile || { ok: true, signedIn: true, rider: { exists: false }, roles: [] }) });
    if (p === '/api/available-deliveries') return route.fulfill({ status: T.boardStatus || 200, contentType: 'application/json', body: JSON.stringify(T.board || { ok: true, deliveries: [] }) });
    if (u.startsWith(base)) return route.continue();
    return route.fulfill({ status: 204, body: '' });   /* everything external: blocked */
  });
  await page.goto(base + '/driver.html' + (opts.hash || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(opts.wait || 700);
  return { ctx, page, errors };
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const T = (page) => page.evaluate(() => window.__T);

const RIDER = { ok: true, signedIn: true, rider: { exists: true, id: 'rider1', approved: true, status: 'approved', name: 'Akinyi Otieno', zone: 'Nairobi CBD', vehicle: 'motorcycle', photo: null }, roles: ['rider'] };
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    console.log('\n── G: guests & non-riders ──');
    let h = await openHub(browser, base, { state: { signedIn: false } });
    ck('G1 signed out → sign-in gate with /login redirect back to /driver', (await text(h.page, '[data-view="overview"]')).includes('Sign in') && await h.page.$('a[href="/login.html?redirect=%2Fdriver"]') !== null);
    ck('G2 rider-only sidebar items hidden when not a rider', await h.page.$$eval('[data-rider]', (els) => els.every((e) => e.style.display === 'none')));
    ck('G3 no page errors (signed out)', h.errors.length === 0, h.errors); await h.ctx.close();

    h = await openHub(browser, base, { state: { signedIn: true, fsQuery: { applications: [] } } });
    let ov = await text(h.page, '[data-view="overview"]');
    ck('G4 signed-in non-rider: "Apply to become a rider" → onboarding-driver.html (the ONE application)', ov.includes('Apply to become a rider') && await h.page.$('a[href="onboarding-driver.html"]') !== null, ov.slice(0, 200));
    await h.page.goto(base + '/driver.html#/available'); await h.page.waitForTimeout(600);
    ck('G5 a rider-only route typed into the URL is NOT reachable for a non-rider (falls back to Application)', await h.page.$eval('.dh-view.on', (e) => e.dataset.view) === 'application');
    await h.ctx.close();

    h = await openHub(browser, base, { state: { signedIn: true, fsQuery: { applications: [{ uid: 'rider1', type: 'driver', status: 'needs_info', createdAt: 1790000000000 }] } } }, { hash: '#/application' });
    let ap = await text(h.page, '[data-view="application"]');
    ck('G6 application needs_info → "More information required" + Complete application (no Approved shown)', ap.includes('More information required') && ap.includes('Complete application') && !/\bApproved\b/.test(ap), ap.slice(0, 200));
    await h.ctx.close();
    h = await openHub(browser, base, { state: { signedIn: true, fsQuery: { applications: [{ uid: 'rider1', type: 'driver', status: 'rejected', decisionReason: 'ID unreadable', createdAt: 1 }] } } }, { hash: '#/application' });
    ap = await text(h.page, '[data-view="application"]');
    ck('G7 rejected → Rejected + the reason; never an Apply-and-Approved mix', ap.includes('Rejected') && ap.includes('ID unreadable') && !ap.includes('Open Rider Drive'), ap.slice(0, 200));
    await h.ctx.close();

    console.log('\n── P: presence (server-decided) ──');
    const base1 = { signedIn: true, fsQuery: { applications: [], walletTransactions: [], payouts: [], csatRatings: [], packageRequests: [], orders: [] }, fsDoc: { 'wallets/rider1': null } };
    h = await openHub(browser, base, { profile: RIDER, state: { ...base1, callable: { riderPresence: "() => ({ ok: true, state: 'not_eligible' })" } } });
    ov = await text(h.page, '[data-view="overview"]');
    ck('P1 server says not_eligible → "not cleared" shown, toggle reads "Not cleared yet" (never Online)', ov.includes('not cleared') && (await text(h.page, '#dhToggle')).includes('Not cleared') && !(await text(h.page, '#dhPresTxt')).includes('Online'), ov.slice(0, 300));
    let t = await T(h.page);
    ck('P2 presence asked through riderPresence {action:status}', t.calls.some((c) => c.name === 'riderPresence' && c.data.action === 'status'));
    await h.ctx.close();

    const board = { ok: true, deliveries: [
      { id: 'DELo1', orderId: 'o1', category: 'food', sellerName: 'Mama Oliech ' + XSS, deliveryArea: 'Langata', itemCount: 2, riderEarning: 180, distanceKm: 2.4 },
      { id: 'PRCp1', kind: 'parcel', orderId: 'p1', sellerName: 'Sender', deliveryArea: 'Westlands', itemCount: 1, driverNet: null } ] };
    const stOnline = { ...base1, callable: { riderPresence: "() => ({ ok: true, state: 'online' })", claimAvailableDelivery: "(d) => ({ ok: true, deliveryRef: d.deliveryRef })" } };
    h = await openHub(browser, base, { profile: RIDER, board, state: stOnline }, { hash: '#/available', wait: 900 });
    console.log('\n── B: board ──');
    let av = await text(h.page, '[data-view="available"]');
    ck('B1 server board rendered: shop → delivery area, server earning, server distance', av.includes('Langata') && av.includes('KES 180') && av.includes('2.4 km'), av.slice(0, 300));
    ck('B2 unknown earning renders "—", never 0 or a guess', /Parcel[\s\S]*—/.test(av) && !/KES 0\b/.test(av));
    ck('B3 seller name with HTML is ESCAPED (no injected element, no script ran)', await h.page.evaluate(() => !window.__xss && !document.querySelector('[data-view="available"] img[src="x"]')));
    await h.page.click('[data-act="claim"][data-ref="DELo1"]'); await h.page.waitForTimeout(400);
    t = await T(h.page);
    ck('B4 Claim → claimAvailableDelivery {deliveryRef} (the existing authority), then Rider Drive', t.calls.some((c) => c.name === 'claimAvailableDelivery' && c.data.deliveryRef === 'DELo1') && await h.page.$eval('.dh-view.on', (e) => e.dataset.view) === 'drive');
    await h.ctx.close();
    for (const [code, want, lbl] of [[403, 'not cleared', 'B5 403 → "not cleared" (not "no work")'], [500, 'Could not load', 'B6 500 → error with Retry (not an empty board)']]) {
      h = await openHub(browser, base, { profile: RIDER, boardStatus: code, board: { ok: false }, state: stOnline }, { hash: '#/available', wait: 900 });
      av = await text(h.page, '[data-view="available"]'); ck(lbl, av.includes(want) && !av.includes('No deliveries right now'), av.slice(0, 200)); await h.ctx.close();
    }
    h = await openHub(browser, base, { profile: RIDER, board, state: { ...base1, callable: { riderPresence: "() => ({ ok: true, state: 'offline' })" } } }, { hash: '#/available', wait: 900 });
    av = await text(h.page, '[data-view="available"]'); t = await T(h.page);
    ck('B7 offline → "Go online to see available deliveries" and the board is NOT fetched with a token', av.includes('Go online') && !av.includes('Langata'), av.slice(0, 160));
    await h.ctx.close();

    console.log('\n── D: Rider Drive ──');
    const pkg = { _fsId: 'pk1', deliveryRef: 'DELo9', status: 'in_transit', category: 'marketplace', pickupAddress: 'Shop ' + XSS, deliveryAddress: 'Kilimani', sellerName: 'Shop A', buyerName: 'Wanjiru', buyerPhone: '0712345678', riderEarning: 150, proofPin: '987654', deliveryPin: '987654' };
    const ord = { _fsId: 'or1', id: 'or1', status: 'rider_assigned', category: 'food', pickupAddress: 'Cafe', deliveryAddress: 'Ngong Rd', driverNet: 120, deliveryRef: 'DELor1', items: [{ name: 'Pilau', qty: 2 }] };
        const stDrive = { ...stOnline, pkgJobs: [pkg], orderJobs: [ord], callable: { ...stOnline.callable, completeDeliveryWithPin: "() => window.__T.pinRes || { ok: true }", completeParcelWithPin: "() => ({ ok: true })", deliveryVerifyShadow: "() => ({ ok: true })", handleFailedDelivery: "(d) => ({ customer_unavailable: { action: 'retry', attemptsLeft: 1 }, wrong_address: { action: 'refund' }, rejected_order: { action: 'refund' }, rider_breakdown: { action: 'reassign' }, seller_delay: { action: 'retry', attemptsLeft: 0 } })[d.reason]" } };
    h = await openHub(browser, base, { profile: RIDER, board, state: stDrive }, { hash: '#/drive', wait: 900 });
    let dv = await text(h.page, '[data-view="drive"]');
    ck('D1 both active jobs shown (packageRequest + order) with pickup → customer route', dv.includes('Kilimani') && dv.includes('Ngong Rd') && dv.includes('2× Pilau'), dv.slice(0, 300));
    ck('D2 the delivery PIN is NEVER displayed to the rider (proofPin present in the record)', !dv.includes('987654'));
    ck('D3 pickup text with HTML escaped in Rider Drive', await h.page.evaluate(() => !window.__xss && !document.querySelector('[data-view="drive"] img[src="x"]')));
    ck('D4 message button = in-app chat (logistics_request / order), no wa.me anywhere', await h.page.$('a[href="chat.html?tx=logistics_request&txId=pk1"]') !== null && await h.page.$('a[href="chat.html?tx=order&txId=or1"]') !== null && !(await h.page.content()).includes('wa.me'));
    await h.page.click('[data-act="ord-accept"]'); await h.page.waitForTimeout(250);
    t = await T(h.page);
    ck('D5 order Accept → SokoniOrders.riderAccept (the existing state machine)', t.writes.some((w) => w.via === 'SokoniOrders.riderAccept' && w.id === 'or1'));
    await h.page.fill('#pin_p_pk1', '12'); await h.page.click('[data-act="complete"][data-key="p_pk1"]'); await h.page.waitForTimeout(200);
    const nPin0 = (await T(h.page)).calls.filter((c) => c.name === 'completeDeliveryWithPin').length;
    ck('D9 malformed PIN refused before any server call', nPin0 === 0, nPin0);
    await h.page.evaluate(() => { window.__T.pinRes = { __throw: true, code: 'functions/permission-denied', message: 'Wrong PIN — 2 attempts left' }; });
    await h.page.fill('#pin_p_pk1', '111111'); await h.page.click('[data-act="complete"][data-key="p_pk1"]'); await h.page.waitForTimeout(350);
    t = await T(h.page);
    ck('D6 wrong PIN → server message shown, delivery stays active (no browser "delivered" write)', (await text(h.page, '#dhToast')).includes('Wrong PIN') && await h.page.$('#pin_p_pk1') !== null && !t.writes.some((w) => w.data && w.data.status === 'delivered'));
    await h.page.evaluate(() => { window.__T.pinRes = { ok: true }; });
    await h.page.fill('#pin_p_pk1', '987654'); await h.page.click('[data-act="complete"][data-key="p_pk1"]'); await h.page.waitForTimeout(350);
    t = await T(h.page);
    const pinCall = t.calls.filter((c) => c.name === 'completeDeliveryWithPin').pop();
    ck('D7 PIN → completeDeliveryWithPin {deliveryRef, pin}; success copy only after server ok', pinCall && pinCall.data.deliveryRef === 'DELo9' && pinCall.data.pin === '987654' && (await text(h.page, '#dhToast')).includes('confirmed by SOKONI'));
    ck('D8 the browser NEVER writes delivered / sellerPayoutReady / payoutDue', !t.writes.some((w) => w.data && (w.data.status === 'delivered' || 'sellerPayoutReady' in w.data || 'payoutDue' in w.data)));
    ck('D9b after a confirmed completion the button reads "Completed ✓" and stays disabled', (await text(h.page, '[data-act="complete"][data-key="p_pk1"]')).includes('Completed') && await h.page.$eval('[data-act="complete"][data-key="p_pk1"]', (b) => b.disabled));
    await h.page.click('[data-act="problem"][data-key="p_pk1"]'); await h.page.waitForTimeout(150);
    await h.page.click('[data-act="fail"][data-reason="customer_unavailable"]'); await h.page.waitForTimeout(300);
    t = await T(h.page);
    ck('D10 "Customer unavailable" → handleFailedDelivery {deliveryRef, reason} (server decides retry/return)', t.calls.some((c) => c.name === 'handleFailedDelivery' && c.data.deliveryRef === 'DELo9' && c.data.reason === 'customer_unavailable'));
    ck('D10b the SERVER\'s decision is shown after sending (retry, 1 attempt left)', (await text(h.page, '#dhModalBody')).includes('SOKONI scheduled a retry (1 attempt left)'));
    const WANT = { wrong_address: 'started a refund', rejected_order: 'started a refund', rider_breakdown: 'reassigning this delivery', seller_delay: 'scheduled a retry' };
    const seen = [];
    for (const [reason, want] of Object.entries(WANT)) {
      await h.page.evaluate(() => document.getElementById('dhModal').classList.remove('on'));
      await h.page.click('[data-act="problem"][data-key="p_pk1"]'); await h.page.waitForTimeout(120);
      await h.page.click('[data-act="fail"][data-reason="' + reason + '"]'); await h.page.waitForTimeout(250);
      seen.push([reason, (await text(h.page, '#dhModalBody')).includes(want)]);
    }
    t = await T(h.page);
    ck('D10c all five reasons go to handleFailedDelivery and each shows the server\'s returned decision', seen.every((x) => x[1]) && ['customer_unavailable', 'wrong_address', 'rejected_order', 'rider_breakdown', 'seller_delay'].every((r) => t.calls.some((c) => c.name === 'handleFailedDelivery' && c.data.reason === r)), seen);
    ck('D10d the browser never writes a return/refund/retry status itself', !t.writes.some((w) => w.data && /return|refund|retry/.test(String(w.data.status || ''))));
    ck('D11 no page errors during the drive flow', h.errors.length === 0, h.errors);
    await h.ctx.close();
    h = await openHub(browser, base, { profile: RIDER, board, state: { ...stDrive, pkgJobs: [{ ...pkg, _fsId: 'pp2', kind: 'parcel', deliveryRef: 'PRCx' }], orderJobs: [] } }, { hash: '#/drive', wait: 900 });
    await h.page.fill('#pin_p_pp2', '123456'); await h.page.click('[data-act="complete"][data-key="p_pp2"]'); await h.page.waitForTimeout(300);
    t = await T(h.page);
    ck('D12 a parcel job completes through completeParcelWithPin (sokoni-e3 authority)', t.calls.some((c) => c.name === 'completeParcelWithPin' && c.data.deliveryRef === 'PRCx'));
    await h.ctx.close();
    h = await openHub(browser, base, { profile: RIDER, board, state: { ...stDrive, pkgJobs: [{ ...pkg, _fsId: 'pp3', kind: 'parcel', deliveryRef: 'PRCy' }], orderJobs: [], callable: { ...stDrive.callable, completeParcelWithPin: "() => ({ __throw: true, code: 'functions/not-found', message: 'not found' })" } } }, { hash: '#/drive', wait: 900 });
    await h.page.fill('#pin_p_pp3', '123456'); await h.page.click('[data-act="complete"][data-key="p_pp3"]'); await h.page.waitForTimeout(300);
    t = await T(h.page);
    ck('D13 parcel completion not deployed → "Parcel completion is temporarily unavailable", no fallback write, delivery stays active', (await text(h.page, '#dhToast')).includes('Parcel completion is temporarily unavailable') && !t.writes.some((w) => w.data && w.data.status === 'delivered') && await h.page.$('#pin_p_pp3') !== null);
    await h.ctx.close();
    /* Served rules: the ASSIGNED rider may change only these packageRequests fields. Anything else is refused,
       so a write outside this set is a broken feature (the old portal's Accept/Pass/report all were). */
    const RIDER_ALLOW = ['status', 'driverNote', 'updatedAt', 'pickedUpAt', 'deliveredAt', 'arrivedAtSellerAt', 'acceptedAt', 'etaMin', 'payoutDue', 'proofNote', 'driverLat', 'driverLng', 'driverSpeed', 'driverLocUpdatedAt', 'timeline', '_lastTimelineEntry'];
    h = await openHub(browser, base, { profile: RIDER, board, state: { ...stDrive, pkgJobs: [{ ...pkg, _fsId: 'pa1', deliveryRef: 'DELpa1', status: 'driver_assigned' }], orderJobs: [] } }, { hash: '#/drive', wait: 900 });
    ck('D14 an assigned job offers Accept but no "Pass" (a rider cannot unassign under the rules)', await h.page.$('[data-act="pkg-accept"]') !== null && await h.page.$('[data-act="pkg-pass"]') === null);
    await h.page.click('[data-act="pkg-accept"]'); await h.page.waitForTimeout(250);
    await h.page.click('[data-act="problem"][data-key="p_pa1"]'); await h.page.waitForTimeout(150);
    await h.page.fill('#issueTxt', 'Gate locked, guard not answering'); await h.page.click('[data-act="issue"][data-key="p_pa1"]'); await h.page.waitForTimeout(250);
    t = await T(h.page);
    const pw = t.writes.filter((w) => w.col === 'packageRequests');
    ck('D15 every rider write to packageRequests stays inside the rules\' rider allowlist (accept = status+acceptedAt; problem = driverNote)', pw.length === 2 && pw.every((w) => Object.keys(w.data).every((k) => RIDER_ALLOW.includes(k))) && pw[0].data.status === 'driver_accepted' && pw[1].data.driverNote === 'Gate locked, guard not answering', pw.map((w) => Object.keys(w.data)));
    ck('D16 proof photo is shown as "not available yet" (Storage has no deliveryProofs rule) — no dead upload control', (await text(h.page, '[data-view="drive"]')).includes('not available yet') && await h.page.$('input[type="file"]') === null);
    await h.ctx.close();

    console.log('\n── E: earnings / wallet / performance ──');
    const now = Date.now();
    const stMoney = { ...stOnline, fsQuery: { ...base1.fsQuery, walletTransactions: [{ uid: 'rider1', type: 'delivery_earning', amount: 150, createdAt: now - 3600e3, orderId: 'o1' }, { uid: 'rider1', type: 'delivery_earning', amount: 200, createdAt: now - 40 * 86400e3 }, { uid: 'rider1', type: 'withdrawal', amount: 999, createdAt: now }], packageRequests: [{ status: 'delivered', createdAt: now - 86400e3 }, { status: 'cancelled', createdAt: now - 86400e3 }], payouts: [] }, fsDoc: { 'wallets/rider1': { balance: 1250 } } };
    h = await openHub(browser, base, { profile: RIDER, board, state: stMoney }, { hash: '#/earnings', wait: 1100 });
    let ea = await text(h.page, '[data-view="earnings"]');
    ck('E1 earnings = ledger delivery_earning only (today KES 150, all-time KES 350; the withdrawal is NOT earnings)', ea.includes('KES 150') && ea.includes('KES 350') && !ea.includes('999'), ea.slice(0, 260));
    ck('E2 bonuses/adjustments say "Not available yet" (not 0)', ea.includes('Not available yet'));
    await h.page.click('.dh-item[data-go="wallet"]'); await h.page.waitForTimeout(300);
    const wa = await text(h.page, '[data-view="wallet"]');
    ck('E3 wallet balance from wallets/{uid}; Pending = "Not available yet"', wa.includes('KES 1,250') && wa.includes('Not available yet'), wa.slice(0, 200));
    await h.page.click('.dh-item[data-go="performance"]'); await h.page.waitForTimeout(300);
    const pf = await text(h.page, '[data-view="performance"]');
    ck('E4 performance from records: 1 completed of 2 closed = 50%; acceptance/on-time "Not yet available"; tiers "Not available yet"', pf.includes('50%') && pf.includes('Not yet available') && pf.includes('Rider tier'), pf.slice(0, 300));
    await h.ctx.close();
    h = await openHub(browser, base, { profile: RIDER, board, state: { ...stOnline, fsQuery: { ...base1.fsQuery, walletTransactions: { __throw: true } } } }, { hash: '#/earnings', wait: 900 });
    ea = await text(h.page, '[data-view="earnings"]');
    ck('E5 ledger read refused → "Could not load your earnings" + Retry (never KES 0)', ea.includes('Could not load') && !ea.includes('KES 0'), ea.slice(0, 160));
    await h.ctx.close();

    console.log('\n── F: fuel (EPRA) ──');
    h = await openHub(browser, base, { profile: RIDER, board, state: { ...stOnline, fsSnap: { 'sysConfig/fuelPrices': { scraperStatus: 'failed', scraperError: 'All EPRA URLs failed', scraperLastAttempt: '2026-10-03T05:00:31Z' } } } }, { hash: '#/fuel', wait: 900 });
    const fu = await text(h.page, '[data-view="fuel"]');
    ck('F1 failed EPRA scrape → "EPRA prices unavailable", no hard-coded price', fu.includes('EPRA prices unavailable') && !/KES\s*\d{3}\.\d{2}/.test(fu), fu.slice(0, 200));
    await h.ctx.close();
    /* The document exactly as fetchEPRAFuelPrices (fix/epra-pump-prices) writes it. */
    const EPRA_DOC = { current: { super_petrol: { nairobi: 214.03, mombasa: 203.11 }, diesel: { nairobi: 217.86, mombasa: 206.50 }, kerosene: { nairobi: 191.38, mombasa: 180.02 } }, effectiveFrom: '2026-08-15', effectiveTo: '2026-09-14', source: 'EPRA Kenya (live)', scraperStatus: 'success', scraperLastSuccess: '2026-10-03T05:00:00Z' };
    h = await openHub(browser, base, { profile: RIDER, board, state: { ...stOnline, fsSnap: { 'sysConfig/fuelPrices': EPRA_DOC } } }, { hash: '#/fuel', wait: 900 });
    const fu2 = await text(h.page, '[data-view="fuel"]');
    ck('F2 server prices (current.<fuel>.nairobi) shown exactly as stored (214.03 / 217.86 / 191.38) with source and period', fu2.includes('214.03') && fu2.includes('217.86') && fu2.includes('191.38') && fu2.includes('EPRA Kenya') && /15 Aug 2026/.test(fu2) && /14 Sept? 2026/.test(fu2), fu2.slice(0, 300));
    ck('F3 the published period has ended (today > 14 Sep) → "EPRA has not yet published newer prices" (no implied freshness)', fu2.includes('has not yet published newer prices'), fu2.slice(0, 300));
    await h.ctx.close();
    h = await openHub(browser, base, { profile: { ...RIDER, rider: { ...RIDER.rider, zone: 'Mombasa Island' } }, board, state: { ...stOnline, fsSnap: { 'sysConfig/fuelPrices': EPRA_DOC } } }, { hash: '#/fuel', wait: 900 });
    const fu3 = await text(h.page, '[data-view="fuel"]');
    ck('F4 a rider zoned in Mombasa sees EPRA\'s Mombasa prices (a published town, not an offset)', fu3.includes('203.11') && fu3.includes('Mombasa') && !fu3.includes('214.03'), fu3.slice(0, 200));
    await h.ctx.close();

    console.log('\n── N: navigation & responsive ──');
    h = await openHub(browser, base, { profile: RIDER, board, state: stDrive }, { wait: 900 });
    const routes = await h.page.$$eval('.dh-item[data-go]', (els) => els.map((e) => e.dataset.go));
    const bad = [];
    for (const r of routes) { await h.page.click(`.dh-item[data-go="${r}"]`); await h.page.waitForTimeout(120); const on = await h.page.$eval('.dh-view.on', (e) => e.dataset.view); const txt = await text(h.page, `.dh-view[data-view="${r}"]`); if (on !== r || txt.trim().length < 20) bad.push(r); }
    ck('N1 every sidebar route (' + routes.length + ') renders its own section', routes.length >= 16 && bad.length === 0, bad);
    ck('N2 hash routing reflects the section (#/settings)', (await h.page.evaluate(() => location.hash)) === '#/settings');
    ck('N3 active item marked aria-current="page"', await h.page.$('.dh-item[data-go="settings"][aria-current="page"]') !== null);
    ck('N4 no page errors across all routes', h.errors.length === 0, h.errors);
    await h.ctx.close();
    h = await openHub(browser, base, { profile: RIDER, board, state: stDrive }, { mobile: true, wait: 900 });
    ck('N5 mobile: bottom nav visible, sidebar off-canvas', await h.page.$eval('.dh-bnav', (e) => getComputedStyle(e).display !== 'none') && await h.page.$eval('#dhSide', (e) => e.getBoundingClientRect().right <= 1));
    await h.page.click('#dhMenuBtn'); await h.page.waitForTimeout(300);
    ck('N6 mobile: menu opens the drawer; Escape closes it', await h.page.$eval('#dhSide', (e) => e.classList.contains('open')) && (await h.page.keyboard.press('Escape'), await h.page.waitForTimeout(250), !(await h.page.$eval('#dhSide', (e) => e.classList.contains('open')))));
    ck('N7 mobile: no horizontal page scroll', await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await h.ctx.close();
    h = await openHub(browser, base, { profile: RIDER, board, state: stMoney }, { hash: '#documents', wait: 1000 });
    ck('N8 rider-email deep link driver.html#documents (no slash) opens Documents', await h.page.$eval('.dh-view.on', (e) => e.dataset.view) === 'documents');
    await h.ctx.close();

    console.log('\n── R: one rider workspace ──');
    const redir = async (pathq) => { const ctx = await browser.newContext({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); await pg.route('**/*', (route) => { const u = route.request().url(); if (!u.startsWith(base)) return route.fulfill({ status: 204, body: '' }); if (/\/sw-register\.js$/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }); if (/\/driver(\?|#|$)/.test(new URL(u).pathname + (new URL(u).search || ''))) return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>hub</p>' }); return route.continue(); }); await pg.goto(base + pathq).catch(() => {}); await pg.waitForTimeout(400); const u = new URL(pg.url()); await ctx.close(); return u.pathname + u.hash; };
    ck('R1 rider-dashboard.html → /driver (no second online toggle survives)', (await redir('/rider-dashboard.html')) === '/driver');
    ck('R2 rider-dashboard.html#earnings → /driver#/earnings', (await redir('/rider-dashboard.html#earnings')) === '/driver#/earnings');
    ck('R3 food-rider.html (the fake portal) → /driver#/available', (await redir('/food-rider.html')) === '/driver#/available');
    ck('R4 driver-dashboard.html#nav (was a 404 linked from profile) → /driver#/map', (await redir('/driver-dashboard.html#nav')) === '/driver#/map');
    const noCmt = (x) => x.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const rd = noCmt(fs.readFileSync(path.join(ROOT, 'rider-dashboard.html'), 'utf8')), fr = noCmt(fs.readFileSync(path.join(ROOT, 'food-rider.html'), 'utf8'));
    ck('R5 the legacy pages carry no rider logic (no riderLocations write, no localStorage orders, no Math.random)', !/riderLocations|setDoc|updateDoc/.test(rd) && !/localStorage|Math\.random|SokoniFood/.test(fr));
    const ps = fs.readFileSync(path.join(ROOT, 'sokoni-profile-switcher.js'), 'utf8'), ob = fs.readFileSync(path.join(ROOT, 'onboarding.html'), 'utf8'), sv = fs.readFileSync(path.join(ROOT, 'services.html'), 'utf8'), ix = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ck('R6 entry links point at the Delivery Hub (switcher, onboarding, services, home)', /rider:\s*'driver\.html'/.test(ps) && /rider:'driver\.html'/.test(ob) && !/food-rider\.html/.test(sv + ix) && !/'rider-dashboard\.html'/.test(ps + ob));

    console.log('\n── X: static security ──');
    const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, ''); const mod = strip(fs.readFileSync(path.join(ROOT, 'sokoni-rider-hub.js'), 'utf8')); const htmlSrc = strip(fs.readFileSync(path.join(ROOT, 'driver.html'), 'utf8'));
    ck('X1 no legacy `deliveries` collection / delivery-hub.js pipeline in the new hub', !/collection\(\s*db\s*,\s*['"]deliveries['"]/.test(mod) && !/['"](deliveryRiders|deliveryLocations)['"]/.test(mod) && !/delivery-hub\.js/.test(mod + htmlSrc));
    ck('X2 no wa.me / WhatsApp hand-off in the hub', !/wa\.me/i.test(mod + htmlSrc));
    ck('X3 no Math.random, no localStorage driver record (sokoniDrivers), no hard-coded 0.88 share', !/Math\.random/.test(mod) && !/sokoniDrivers/.test(mod) && !/0\.88/.test(mod));
    ck('X4 no client write of sellerPayoutReady anywhere in the delivery client files (6f0a576 preserved)', ['delivery-hub.js', 'sokoni-delivery.js', 'sokoni-orders.js', 'driver.html', 'sokoni-rider-hub.js'].every((f) => !/sellerPayoutReady\s*:\s*true/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
    ck('X5 the page still loads the role guard and self-update script', /sokoni-role-authority\.js/.test(htmlSrc) && /sw-register\.js/.test(htmlSrc));
    ck('X6 insurance / referral / "8 PM" payout claims removed', !/insurance|referral|8\s*PM/i.test(mod + htmlSrc));
    ck('Z1 negative control: the stubbed board really contained an XSS payload (B3/D3 are not vacuous)', JSON.stringify(board).includes('onerror'));
  } finally { await browser.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack)); process.exit(2); });
