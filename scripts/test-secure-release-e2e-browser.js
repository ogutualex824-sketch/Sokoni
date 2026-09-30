'use strict';
/**
 * test-secure-release-e2e-browser.js — SOKONI Secure Release END TO END on the convergence line (real Chromium, 2026-09-30).
 *
 * OWNER (profile.html → the hosted premium wallet) → AdminOS (the real admin page) → OWNER release → payment → result.
 * Every page is the REAL page from this tree; every callable is the REAL functions/wallet.js / wallet-engine.js code over
 * ONE transactional fake Firestore (a counting fake B2C adapter; SMS stubbed to THROW). The pages' Firebase SDKs are thin
 * bridges into that same database and those same callables — nothing else is simulated. The provider's COMPLETED
 * webhook is delivered through the real finalizeB2CPayoutFromWebhook.
 *
 * PROVES
 *   E1 the owner opens the Wallet tab in profile (no navigation away) and requests KSh 300 with the PIN → held
 *      (700 / 300 reserved), pending, nothing sent
 *   E2 AdminOS approves on the real admin page → "no money was sent. The owner must now confirm"; the request is
 *      approved with a 72h window; still nothing sent; the owner's notification links to profile.html#wallet:payouts
 *   E3 the notification link opens profile on "Your withdrawals" (hosted, no navigation away) with CONFIRM & RELEASE
 *      KSh 300.00 → PIN → the payment is sent EXACTLY once (auto payout on); a repeat release sends nothing; the
 *      provider's COMPLETED → paid; the wallet shows the hold released (700 / 0) and the timeline Completed
 *   E4 manual mode: a second withdrawal released by the owner appears in AdminOS "Ready to pay"; Mark Paid with a
 *      reference + attestation → settled_manually, hold released once; nothing was ever sent through the provider
 *   E5 no page errors from the Secure Release / in-profile wallet code
 */
const Path = require('path'), http = require('http'), fs = require('fs');
const ROOT = Path.resolve(__dirname, '..'), FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const WATCHDOG = setTimeout(() => { say('  FAIL  watchdog — the suite did not finish in 6 min'); process.exit(3); }, 6 * 60 * 1000); WATCHDOG.unref();
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
stub('firebase-admin/auth', { getAuth: () => ({ getUserByPhoneNumber: async () => { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; } }) });
stub('./redis-rate-limiter', { checkRateLimit: async () => true });
stub('./finos-utils', { intasendB2C: async () => { throw new Error('legacy helper must not be used'); } });
stub('./sokoni-at', new Proxy({}, { get: (_, k) => (k === 'secrets' ? [] : () => { throw new Error('SMS must never be sent by a test'); }) }));
const NOTES = [];
stub('./notify', { notify: async (n) => { NOTES.push(n); return { ok: true }; } });
const sends = [];
stub('./payment-adapters', { getAdapter: () => ({ sendMoneyB2C: async (a) => { sends.push(a); return { tracking_id: 'TRK' + sends.length, status: 'Confirming balance' }; } }) });
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 380) + ']' : '')); ok ? pass++ : fail++; };
let W, WE;
try { W = require(Path.join(FN, 'wallet.js')); WE = require(Path.join(FN, 'wallet-engine.js')); } catch (e) { say('LOAD FAILED ' + e.stack); process.exit(2); }

const UID = 'owner1', PIN = '4829';
const OWNER = { auth: { uid: UID, token: { auth_time: Math.floor(Date.now() / 1000) - 3600 } } };
const ADMIN = { auth: { uid: 'adm1', token: { admin: true, superAdmin: true } } };
const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v && typeof v.toMillis === 'function' ? { _seconds: Math.floor(v.toMillis() / 1000), _ms: v.toMillis() } : v)));
const wrap = async (fn) => { try { return { data: plain(await fn()) }; } catch (e) { return { err: e.message, code: e.code }; } };
const OWNER_ROUTES = {
  walletV2Dashboard: (p) => WE.walletV2Dashboard.run({ ...OWNER, data: p || {} }),
  requestSellerPayout: (p) => W.requestSellerPayout.run({ ...OWNER, data: p }),
  getPayoutHistory: (p) => W.getPayoutHistory.run({ ...OWNER, data: p || {} }),
  confirmPayoutRelease: (p) => W.confirmPayoutRelease.run({ ...OWNER, data: p }),
  cancelPayoutRequest: (p) => W.cancelPayoutRequest.run({ ...OWNER, data: p }),
};
const ADMIN_ROUTES = {
  adminProcessPayout: (p) => W.adminProcessPayout.run({ ...ADMIN, data: p }),
  aosGetPendingPayouts: async () => ({ payouts: (await db.collection('payoutRequests').where('status', '==', 'pending').get()).docs.map((d) => Object.assign({ id: d.id }, d.data())) }),
  adminPayoutOps: (p) => W.adminPayoutOps.run({ ...ADMIN, data: p || {} }),
};
const CALLS = [];
const ownerCall = async (name, payload) => { CALLS.push('owner:' + name); const fn = OWNER_ROUTES[name]; return fn ? wrap(() => fn(payload || {})) : { err: 'not available in this test: ' + name, code: 'unimplemented' }; };
const adminCall = async (name, payload) => {
  if (name === 'adminOsDispatch' && payload && payload.op) { name = payload.op; payload = payload.data || payload; }
  CALLS.push('admin:' + name); const fn = ADMIN_ROUTES[name]; return fn ? wrap(() => fn(payload || {})) : { data: {} };
};
/* the admin page's compat Firestore reads, answered from the SAME database (read-only: every write is trapped) */
const ADMIN_WRITES = [];
const adminQuery = async (coll, filters) => {
  let q = db.collection(coll);
  for (const [f, op, v] of filters) if (op === '==' || op === 'in') q = q.where(f, op, v);
  return plain((await q.get()).docs.map((d) => Object.assign({ __id: d.id }, d.data())));
};
const adminGet = async (path) => { const s = await db.doc(path).get(); return s.exists ? plain(s.data()) : null; };
const wal = async () => { const s = await db.doc('wallets/' + UID).get(); const d = s.data() || {}; return { balance: d.balance, pending: d.pendingPayout || 0 }; };
const req = async (id) => ((await db.doc('payoutRequests/' + id).get()).data() || {});

/* the premium wallet's modular SDK → the owner's callables + the wallet balance (read) */
const SDK = {
  'firebase-auth.js': `export function getAuth(){ return { currentUser: { uid: '${UID}', phoneNumber: '+254712345678', displayName: 'Jane Owner' } }; }
export function onAuthStateChanged(a, cb){ setTimeout(function(){ cb({ uid: '${UID}', phoneNumber: '+254712345678', displayName: 'Jane Owner', email: 'jane@example.com' }); }, 30); return function(){}; }
export function onIdTokenChanged(){ return function(){}; } export function signOut(){ return Promise.resolve(); }
export function RecaptchaVerifier(){} export function linkWithPhoneNumber(){ return Promise.reject(new Error('stub')); } export function updatePhoneNumber(){ return Promise.reject(new Error('stub')); }
export var PhoneAuthProvider = { credential: function(){ return {}; } };`,
  'firebase-functions.js': `export function getFunctions(){ return {}; }
export function httpsCallable(_f, name){ return function(payload){ return window.__ownerCall(name, payload).then(function(r){ if (r && r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; }); }; }`,
  'firebase-firestore.js': `export function getFirestore(){ return {}; }
export function doc(){ return {}; } export function collection(){ return {}; } export function query(){ return {}; } export function where(){ return {}; } export function limit(){ return {}; } export function orderBy(){ return {}; }
export function getDocs(){ return Promise.resolve({ empty: true, docs: [], size: 0, forEach: function(){} }); }
export function getDoc(){ return window.__wallet().then(function(d){ return { exists: function(){ return !!d; }, data: function(){ return d; } }; }); }
export function onSnapshot(r, cb){ var live = true; function tick(){ if (!live) return; window.__wallet().then(function(d){ if (live) cb({ exists: function(){ return !!d; }, data: function(){ return d; } }); }); } tick(); var t = setInterval(tick, 700); return function(){ live = false; clearInterval(t); }; }
export var Timestamp = { now: function(){ return { toMillis: function(){ return Date.now(); } }; } };`,
};
/* the admin page's compat SDK → the admin callables + read-only queries on the same database */
function adminStub() {
  const writeTrap = (what) => () => { window.__adminWrite(what); return Promise.resolve(); };
  const hydrate = (o) => { if (!o || typeof o !== 'object') return o; if (typeof o._ms === 'number') { const ms = o._ms; return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), _seconds: Math.floor(ms / 1000) }; }
    if (Array.isArray(o)) return o.map(hydrate); const r = {}; for (const k of Object.keys(o)) r[k] = hydrate(o[k]); return r; };
  function docRef(path) {
    return { id: path.split('/').pop(), get: () => window.__adminGet(path).then((d) => ({ exists: !!d, id: path.split('/').pop(), data: () => (d ? hydrate(d) : undefined) })),
      set: writeTrap('set:' + path), update: writeTrap('update:' + path), delete: writeTrap('delete:' + path),
      onSnapshot: (cb) => { cb({ exists: false, data: () => undefined }); return () => {}; }, collection: (c) => query(path + '/' + c, []) };
  }
  function query(coll, filters) {
    const q = { where: (f, op, v) => query(coll, filters.concat([[f, op, v]])), orderBy: () => q, limit: () => q, startAfter: () => q, limitToLast: () => q,
      doc: (id) => docRef(coll + '/' + id), add: writeTrap('add:' + coll),
      get: () => window.__adminQuery(coll, filters).then((rows) => { const docs = rows.map((r) => ({ id: r.__id, exists: true, data: () => hydrate(r) })); return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) }; }),
      onSnapshot: (cb) => { q.get().then(cb).catch(() => {}); return () => {}; } };
    return q;
  }
  const fsx = { collection: (c) => query(c, []), doc: (p) => docRef(p), batch: () => ({ set: writeTrap('batch'), update: writeTrap('batch'), delete: writeTrap('batch'), commit: writeTrap('batch.commit') }), runTransaction: writeTrap('runTransaction') };
  const fsFn = () => fsx; fsFn.Timestamp = { fromDate: (d) => ({ toMillis: () => d.getTime(), toDate: () => d }), now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }) };
  fsFn.FieldValue = { serverTimestamp: () => ({}), increment: (n) => n, arrayUnion: (...a) => a };
  const user = { uid: 'adm1', email: 'admin@example.test', displayName: 'Cert Admin', getIdTokenResult: () => Promise.resolve({ claims: { admin: true, superAdmin: true } }), getIdToken: () => Promise.resolve('t') };
  const auth = { currentUser: user, onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; }, signOut: () => Promise.resolve() };
  const fns = { httpsCallable: (name) => async (data) => { const r = await window.__adminCall(name, data || {}); if (r && r.err) { const e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; } };
  window.firebase = { auth: () => auth, firestore: fsFn, functions: () => fns, app: () => ({}), apps: [{}] };
  window.firebaseAuth = auth; window.firebaseDB = fsx;
  window.SokoniAdminEntry = { guard: async () => ({ ok: true }), mountControls: () => {} };
  window.alert = () => {}; window.confirm = () => true; window.prompt = () => null;
  try { localStorage.setItem('sokoniPrivacyAccepted', 'true'); } catch (e) {}
}
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/firebase.js' || u === '/session-manager.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end('/* stubbed */ export {};'); }
      const f = Path.join(ROOT, u.replace(/^\/+/, '') || 'index.html');
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(''); }
      const ext = Path.extname(f);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.json' ? 'application/json' : 'application/javascript' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  if (!W.confirmPayoutRelease) { ck('E0 Secure Release is on this line', false); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const setCfg = (x) => db.doc('config/payouts').set(Object.assign({ secureRelease: true, autoB2C: true, enabled: true, requirePin: true, releaseWindowHours: 72, newDestinationCoolingHours: 0, maxPerRequest: 150000, maxPayoutsPerDay: 50, dailyLimit: 1000000, instantLimit: 100000, holdNewSellersDays: 0 }, x || {}));
  await setCfg();
  await db.doc('users/' + UID).set({ accountStatus: 'active', payoutVerified: true, displayName: 'Jane Owner', phoneNumber: '+254712345678', createdAt: F.Timestamp.fromMillis(Date.now() - 90 * 86400000) });
  await db.doc('wallets/' + UID).set({ uid: UID, balance: 1000, pendingPayout: 0, currency: 'KES', status: 'active', pinVerifier: WE._pinAuthority.makePinVerifier(PIN) });

  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 20000 };
  const errors = [];
  const flow = async (id, fn) => { try { return await fn(); } catch (e) { ck('flow: ' + id, false, String(e && e.message).slice(0, 220)); return null; } };
  const ownerCtx = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 860 } });
    await ctx.route('**/*', (r) => {
      const url = r.request().url();
      const m = url.match(/gstatic\.com\/firebasejs\/[^/]+\/(firebase-(?:auth|functions|firestore)\.js)/);
      if (m) return r.fulfill({ status: 200, contentType: 'application/javascript', body: SDK[m[1]] });
      return url.startsWith(BASE) ? r.continue() : r.abort();
    });
    /* profile's own sign-in gate lifts when its auth resolves (html.sk-auth-ok) — the top-level Firebase is not
       running here, so the test marks it as resolved, exactly as a signed-in profile does */
    await ctx.addInitScript(() => { const mark = () => document.documentElement && document.documentElement.classList.add('sk-auth-ok'); mark(); document.addEventListener('DOMContentLoaded', mark); });
    await ctx.addInitScript(() => { try { localStorage.setItem('loggedIn', 'true'); localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'owner1', name: 'Jane' })); localStorage.setItem('sokoniPrivacyAccepted', 'true'); } catch (e) {} });
    const P = await ctx.newPage();
    P.on('pageerror', (e) => errors.push(e.message));
    await P.exposeFunction('__ownerCall', ownerCall);
    await P.exposeFunction('__wallet', async () => plain((await db.doc('wallets/' + UID).get()).data() || null));
    return { ctx, P };
  };
  const walletFrame = async (P) => { for (let i = 0; i < 80; i++) { const f = P.frames().find((x) => /wallet\.html\?shell=profile/.test(x.url())); if (f) return f; await P.waitForTimeout(250); } throw new Error('no hosted wallet frame'); };
  const enterPin = async (Fr) => { await Fr.waitForSelector('#ovlPinVerify.open', T); await Fr.fill('#pinVerifyInput', PIN); };
  const adminPage = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (!u.startsWith(BASE)) return route.abort();
      if (/\/sokoni-admin-entry\.js(\?|$)/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.SokoniAdminEntry=window.SokoniAdminEntry||{guard:async()=>({ok:true}),mountControls(){}};' });
      return route.continue();
    });
    const P = await ctx.newPage();
    P.on('pageerror', (e) => errors.push(e.message));
    await P.exposeFunction('__adminCall', adminCall);
    await P.exposeFunction('__adminQuery', adminQuery);
    await P.exposeFunction('__adminGet', adminGet);
    await P.exposeFunction('__adminWrite', async (w) => { ADMIN_WRITES.push(w); });
    await P.addInitScript(adminStub);
    await P.goto(BASE + '/admin-os.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await P.waitForFunction(() => window.SokoniAOS && document.querySelector('#panel-financial'), null, { timeout: 45000 });
    await P.evaluate(() => { const n = document.querySelector('.nav-item[data-section="financial"]'); if (n) n.click(); });
    return { ctx, P };
  };
  const payoutsTab = async (P) => { await P.evaluate(() => SokoniAOS.financialTab('payouts')); await P.waitForFunction(() => /Ready to pay/.test((document.getElementById('finBody') || {}).innerText || ''), null, T); };
  try {
    /* ── E1 ── */
    let e1 = {};
    await flow('E1', async () => {
      const { ctx, P } = await ownerCtx();
      await P.goto(BASE + '/profile.html', { waitUntil: 'domcontentloaded' });
      await P.waitForFunction(() => typeof switchTab === 'function', null, T);
      await P.evaluate(() => document.querySelector('.up-tab[data-tab="wallet"]').click());
      const Fr = await walletFrame(P);
      await Fr.waitForFunction(() => window.W2 && /\d/.test((document.getElementById('balVal') || {}).textContent || ''), null, T);
      await Fr.evaluate(() => W2.openWithdraw());
      await Fr.fill('#wdrAmount', '300'); await Fr.fill('#wdrPhone', '0712345678');
      await Fr.evaluate(() => { W2.requestPayout(); });
      await enterPin(Fr);
      await Fr.waitForSelector('#wdrSuccess', { state: 'visible', timeout: 20000 });
      e1.url = P.url(); e1.msg = await Fr.$eval('#wdrSuccess', (e) => e.innerText);
      await ctx.close();
    });
    const rid1 = ((await db.collection('payoutRequests').get()).docs[0] || { id: null }).id;
    ck('E1 in profile (no navigation away) the owner requests KSh 300 with the PIN → held (700 / 300), pending, nothing sent',
      /\/profile\.html#wallet$/.test(e1.url || '') && /Money held for you/.test(e1.msg || '') && (await req(rid1)).status === 'pending' && JSON.stringify(await wal()) === JSON.stringify({ balance: 700, pending: 300 }) && sends.length === 0,
      { url: e1.url, st: (await req(rid1)).status, w: await wal() });

    /* ── E2: AdminOS approves on the real admin page ── */
    let e2 = {};
    await flow('E2', async () => {
      const { ctx, P } = await adminPage();
      await payoutsTab(P);
      e2.pendingListed = await P.evaluate(() => /Awaiting review/.test(document.getElementById('finBody').innerText) && /Approve/.test(document.getElementById('finBody').innerText));
      await P.evaluate((id) => SokoniAOS.approvePayout(id), rid1);
      await P.waitForFunction(() => /no money was sent/.test((document.getElementById('aosToasts') || {}).innerText || ''), null, T);
      e2.toast = await P.evaluate(() => document.getElementById('aosToasts').innerText);
      await payoutsTab(P);
      e2.owner = await P.evaluate(() => [...document.querySelectorAll('#payoutOwnerTable tr[data-payout-id]')].map((t) => t.getAttribute('data-payout-id')));
      await ctx.close();
    });
    const p2 = await req(rid1);
    const note = NOTES.find((n) => n.type === 'payout_release_ready');
    const hrs = p2.approval && (p2.approval.expiresAt.toMillis() - Date.now()) / 3600000;
    ck('E2 AdminOS approves → "no money was sent. The owner must now confirm"; approved with a 72h window; nothing sent; the notification links to profile.html#wallet:payouts',
      e2.pendingListed && /The owner must now confirm/.test(e2.toast || '') && p2.status === 'approved' && hrs > 71.9 && e2.owner && e2.owner.includes(rid1) && sends.length === 0
      && note && note.deepLink === '/profile.html#wallet:payouts', { toast: (e2.toast || '').slice(0, 90), st: p2.status, owner: e2.owner, link: note && note.deepLink });

    /* ── E3: the notification link → release → sent exactly once → completed ── */
    let e3 = {};
    await flow('E3', async () => {
      const { ctx, P } = await ownerCtx();
      await P.goto(BASE + (note ? note.deepLink : '/profile.html#wallet:payouts'), { waitUntil: 'domcontentloaded' });
      const Fr = await walletFrame(P);
      e3.src = P.frames().map((f) => f.url()).find((u) => /shell=profile/.test(u));
      await Fr.waitForSelector('.sr-release', T);
      e3.card = await Fr.$eval('#payoutsList', (e) => e.innerText);
      e3.hit = await Fr.evaluate(() => { const b = document.querySelector('.sr-release'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { r: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], vh: innerHeight, top: t && (t.id || t.className || t.tagName) }; });
      e3.parent = await P.evaluate((hy) => { const fr = document.getElementById('walletFrame'); const r = fr.getBoundingClientRect(); const y = r.y + hy; const t = document.elementFromPoint(r.x + 100, Math.min(y, innerHeight - 1)); return { frameY: Math.round(r.y), frameH: Math.round(r.height), vh: innerHeight, y: Math.round(y), top: t && (t.id || t.className || t.tagName), scrollY: scrollY }; }, e3.hit.r[1] + 26);
      await Fr.click('.sr-release');
      await enterPin(Fr);
      await Fr.waitForFunction(() => /Released|Processing|sending/i.test((document.getElementById('payoutsList') || {}).innerText || ''), null, T);
      e3.sentAfterRelease = sends.length;
      const again = await ownerCall('confirmPayoutRelease', { requestId: rid1, pin: PIN });   /* a repeat release (e.g. a double tap) */
      e3.again = again.data;
      await W.finalizeB2CPayoutFromWebhook(db, rid1, 'COMPLETE', { status: 'COMPLETE', paid_amount: 300 });   /* the provider confirms */
      await Fr.evaluate(() => W2.openPayouts());
      await Fr.waitForFunction(() => /✓\s*Completed|Paid/.test((document.getElementById('payoutsList') || {}).innerText || ''), null, T);
      e3.after = await Fr.$eval('#payoutsList', (e) => e.innerText);
      e3.url = P.url();
      e3.inView = e3.parent ? e3.parent.frameY < 200 : null;
      await ctx.close();
    });
    const p3 = await req(rid1);
    ck('E3 the link opens profile on "Your withdrawals" → CONFIRM & RELEASE KSh 300.00 (the wallet in view) → PIN → sent EXACTLY once; a repeat sends nothing; COMPLETED → paid; hold released (700 / 0); timeline Completed',
      /open=payouts/.test(e3.src || '') && /\/profile\.html#wallet/.test(e3.url || '') && /CONFIRM & RELEASE KSh 300\.00/.test(e3.card || '') && e3.sentAfterRelease === 1 && sends.length === 1
      && sends[0].amountKES === 300 && e3.again && e3.again.alreadyConfirmed === true && p3.status === 'paid' && JSON.stringify(await wal()) === JSON.stringify({ balance: 700, pending: 0 })
      && /Completed/.test(e3.after || '') && e3.inView === true, { hit: e3.hit, parent: e3.parent, src: e3.src, sent: sends.length, again: e3.again, st: p3.status, w: await wal() });

    /* ── E4: manual mode — the owner releases, AdminOS pays by hand with evidence ── */
    await setCfg({ autoB2C: false });
    let e4 = {};
    await flow('E4', async () => {
      const { ctx, P } = await ownerCtx();
      await P.goto(BASE + '/profile.html#wallet:withdraw', { waitUntil: 'domcontentloaded' });
      const Fr = await walletFrame(P);
      await Fr.waitForSelector('#ovlWithdraw.open', T);
      await Fr.fill('#wdrAmount', '200'); await Fr.fill('#wdrPhone', '0712345678');
      await Fr.evaluate(() => { W2.requestPayout(); });
      await enterPin(Fr);
      await Fr.waitForSelector('#wdrSuccess', { state: 'visible', timeout: 20000 });
      await ctx.close();
    });
    const rid2 = (await db.collection('payoutRequests').get()).docs.map((d) => ({ id: d.id, ...d.data() })).find((x) => x.amount === 200);
    await W.adminProcessPayout.run({ ...ADMIN, data: { requestId: rid2 && rid2.id, status: 'approved' } }).catch(() => null);
    await flow('E4-release', async () => {
      const { ctx, P } = await ownerCtx();
      await P.goto(BASE + '/profile.html#wallet:payouts', { waitUntil: 'domcontentloaded' });
      const Fr = await walletFrame(P);
      await Fr.waitForSelector('.sr-release', T);
      await Fr.click('.sr-release');
      await enterPin(Fr);
      await Fr.waitForFunction(() => /Released — sending/.test((document.getElementById('payoutsList') || {}).innerText || ''), null, T);
      await ctx.close();
    });
    await flow('E4-admin', async () => {
      const { ctx, P } = await adminPage();
      await payoutsTab(P);
      e4.ready = await P.evaluate(() => [...document.querySelectorAll('#payoutReadyTable tr[data-payout-id]')].map((t) => t.getAttribute('data-payout-id')));
      await P.evaluate((id) => SokoniAOS.markPayoutPaid(id), rid2 && rid2.id);
      await P.waitForSelector('#mpSubmit', T);
      await P.fill('#mpRef', 'QWE123RTY'); await P.fill('#mpAtt', 'sent by finance via M-PESA 14:05');
      await P.click('#mpSubmit');
      await P.waitForFunction(() => /Server recorded this payout as/.test((document.getElementById('aosToasts') || {}).innerText || ''), null, T);
      e4.toast = await P.evaluate(() => document.getElementById('aosToasts').innerText);
      await ctx.close();
    });
    const p4 = rid2 ? await req(rid2.id) : {};
    ck('E4 manual mode: the owner-released withdrawal is in AdminOS "Ready to pay"; Mark Paid with evidence → settled_manually, hold released once; no provider send',
      rid2 && e4.ready && e4.ready.includes(rid2.id) && p4.status === 'settled_manually' && /settled_manually/.test(e4.toast || '') && JSON.stringify(await wal()) === JSON.stringify({ balance: 500, pending: 0 })
      && sends.length === 1 && ADMIN_WRITES.length === 0, { ready: e4.ready, st: p4.status, w: await wal(), sends: sends.length, adminWrites: ADMIN_WRITES });

    const pe = errors.filter((m) => /_sr|releasePayout|cancelPayout|_checkReleaseReady|_ensureWalletFrame|_openWalletIn|_goHref|walletFrame|markPayoutPaid|_loadReleaseQueues|_readyQueueHtml|_ownerQueueHtml/i.test(m));
    ck('E5 no page errors from the Secure Release / in-profile wallet code', pe.length === 0, { errs: pe.slice(0, 3), other: errors.slice(0, 2) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
