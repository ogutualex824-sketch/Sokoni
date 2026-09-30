'use strict';
/**
 * test-secure-release-browser.js — SOKONI Secure Release in the premium wallet (real Chromium, 2026-09-30).
 *
 * REAL wallet.html + sokoni-wallet-v2.js served from this tree; the callables they use are the REAL functions/wallet.js
 * and functions/wallet-engine.js over the transactional fake Firestore (a counting fake B2C adapter; SMS stubbed to
 * THROW). The Firebase SDK modules the page imports are replaced by thin routers: auth reports the signed-in owner,
 * functions route to the real callables, firestore serves the wallet balance. The ADMIN approval step is performed by
 * the test through the real adminProcessPayout — exactly what AdminOS calls.
 *
 * PROVES
 *   SB1 a wallet with no PIN: the withdraw sheet says "Wallet security incomplete — set your Wallet PIN", and a request
 *       is not sent
 *   SB2 "Secure my wallet" → the PIN pad sets a PIN (stored server-side as a salted verifier); the notice goes away
 *   SB3 request KSh 300 with the PIN → "Money held for you"; the server holds it (pending), nothing sent
 *   SB4 after SOKONI approves: the dashboard shows "Your money is ready to be released"
 *   SB5 "Your withdrawals": the timeline (requested ✓, PIN verified ✓, SOKONI approved ✓, waiting for YOUR confirmation)
 *       and "CONFIRM & RELEASE KSh 300.00" with the authorization note → PIN → the server records owner_confirmed; the
 *       list then says "Released — sending"; the banner is gone
 *   SB6 a second request, cancelled from the list → cancelled, the money back in the wallet
 *   SB7 laid out for every device: no sideways scroll at 390px or 1280px; the release button is a ≥48px target
 *   SB8 no page error from the Secure Release code
 */
const Path = require('path'), http = require('http'), fs = require('fs');
const ROOT = Path.resolve(__dirname, '..'), FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log;
const WATCHDOG = setTimeout(() => { say('  FAIL  watchdog — the suite did not finish in 240s'); process.exit(3); }, 240000); WATCHDOG.unref && WATCHDOG.unref(); console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
stub('firebase-admin/auth', { getAuth: () => ({ getUserByPhoneNumber: async () => { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; } }) });
stub('./redis-rate-limiter', { checkRateLimit: async () => true });
stub('./finos-utils', { intasendB2C: async () => { throw new Error('legacy helper must not be used'); } });
stub('./sokoni-at', new Proxy({}, { get: (_, k) => (k === 'secrets' ? [] : () => { throw new Error('SMS must never be sent by a test'); }) }));
stub('./notify', { notify: async () => ({ ok: true }) });
const sends = [];
stub('./payment-adapters', { getAdapter: () => ({ sendMoneyB2C: async (a) => { sends.push(a); return { tracking_id: 'TRK' + sends.length }; } }) });
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 360) + ']' : '')); ok ? pass++ : fail++; };
let W, WE;
try { W = require(Path.join(FN, 'wallet.js')); WE = require(Path.join(FN, 'wallet-engine.js')); } catch (e) { say('LOAD FAILED ' + e.stack); process.exit(2); }
const UID = 'owner1';
const AU = { auth: { uid: UID, token: { auth_time: Math.floor(Date.now() / 1000) - 3600 } } };
const ROUTES = {
  walletV2Dashboard: (p) => WE.walletV2Dashboard.run({ ...AU, data: p || {} }),
  requestSellerPayout: (p) => W.requestSellerPayout.run({ ...AU, data: p }),
  getPayoutHistory: (p) => W.getPayoutHistory.run({ ...AU, data: p || {} }),
  confirmPayoutRelease: (p) => W.confirmPayoutRelease.run({ ...AU, data: p }),
  cancelPayoutRequest: (p) => W.cancelPayoutRequest.run({ ...AU, data: p }),
  walletV2SetPin: (p) => WE.walletV2SetPin.run({ ...AU, data: p }),
};
const CALLS = [];
const call = async (name, payload) => {
  CALLS.push(name);
  const fn = ROUTES[name];
  if (!fn) return { err: 'not available in this test: ' + name, code: 'unimplemented' };
  try { return { data: JSON.parse(JSON.stringify(await fn(payload || {}), (k, v) => (v && typeof v.toMillis === 'function' ? { _seconds: Math.floor(v.toMillis() / 1000) } : v))) }; }
  catch (e) { return { err: e.message, code: e.code }; }
};
const readWallet = async () => { const s = await db.doc('wallets/' + UID).get(); const d = s.exists ? s.data() : {}; return { balance: d.balance, pendingPayout: d.pendingPayout || 0 }; };
const read = async (p) => (await db.doc(p).get()).data() || {};   /* absent = {} — a missing record FAILS a check, never crashes the run */

const SDK = {
  'firebase-auth.js': `export function getAuth(){ return { currentUser: { uid: '${UID}', phoneNumber: '+254712345678', displayName: 'Jane Owner' } }; }
export function onAuthStateChanged(a, cb){ setTimeout(function(){ cb({ uid: '${UID}', phoneNumber: '+254712345678', displayName: 'Jane Owner', email: 'jane@example.com' }); }, 30); return function(){}; }
export function onIdTokenChanged(){ return function(){}; }
export function signOut(){ return Promise.resolve(); }
export function RecaptchaVerifier(){}
export function linkWithPhoneNumber(){ return Promise.reject(new Error('stub')); }
export function updatePhoneNumber(){ return Promise.reject(new Error('stub')); }
export var PhoneAuthProvider = { credential: function(){ return {}; } };`,
  'firebase-functions.js': `export function getFunctions(){ return {}; }
export function httpsCallable(_f, name){ return function(payload){ return window.__call(name, payload).then(function(r){ if (r && r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; }); }; }`,
  'firebase-firestore.js': `export function getFirestore(){ return {}; }
export function doc(){ return { path: Array.prototype.slice.call(arguments, 1).join('/') }; }
export function collection(){ return {}; } export function query(){ return {}; } export function where(){ return {}; } export function limit(){ return {}; } export function orderBy(){ return {}; }
export function getDocs(){ return Promise.resolve({ empty: true, docs: [], size: 0, forEach: function(){} }); }
export function getDoc(r){ return window.__wallet().then(function(d){ return { exists: function(){ return !!d; }, data: function(){ return d; } }; }); }
export function onSnapshot(r, cb){ var live = true; function tick(){ if (!live) return; window.__wallet().then(function(d){ if (live) cb({ exists: function(){ return !!d; }, data: function(){ return d; } }); }); } tick(); var t = setInterval(tick, 700); return function(){ live = false; clearInterval(t); }; }
export var Timestamp = { now: function(){ return { toMillis: function(){ return Date.now(); } }; } };`,
};
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/firebase.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end('window.firebaseApp = {}; export {};'); }
      const f = Path.join(ROOT, u.replace(/^\/+/, '') || 'index.html');
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(''); }
      const ext = Path.extname(f);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  if (!W.confirmPayoutRelease) { ck('SB0 Secure Release loads', false); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('config/payouts').set({ secureRelease: true, autoB2C: false, enabled: true, requirePin: true, releaseWindowHours: 72, newDestinationCoolingHours: 0, maxPerRequest: 150000, maxPayoutsPerDay: 50, dailyLimit: 1000000 });
  await db.doc('users/' + UID).set({ accountStatus: 'active', payoutVerified: true, displayName: 'Jane Owner', phoneNumber: '+254712345678', createdAt: F.Timestamp.fromMillis(Date.now() - 90 * 86400000) });
  await db.doc('wallets/' + UID).set({ uid: UID, balance: 1000, pendingPayout: 0, currency: 'KES', status: 'active' });

  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 15000 };
  const errors = [];
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 220)); return false; } };
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 860 } });
    await ctx.route('**/*', (r) => {
      const url = r.request().url();
      const m = url.match(/gstatic\.com\/firebasejs\/[^/]+\/(firebase-(?:auth|functions|firestore)\.js)/);
      if (m) return r.fulfill({ status: 200, contentType: 'application/javascript', body: SDK[m[1]] });
      return url.startsWith(BASE) ? r.continue() : r.abort();
    });
    await ctx.addInitScript(() => { try { localStorage.setItem('loggedIn', 'true'); localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'owner1', name: 'Jane' })); localStorage.setItem('sokoniPrivacyAccepted', 'true');   /* the site's own consent key (security.js ACCEPT_KEY) — the modal never mounts */ } catch (e) {} });
    const P = await ctx.newPage();
    P.on('pageerror', (e) => errors.push(e.message));
    await P.exposeFunction('__call', call);
    await P.exposeFunction('__wallet', async () => { const s = await db.doc('wallets/' + UID).get(); return s.exists ? JSON.parse(JSON.stringify(s.data(), (k, v) => (v && typeof v.toMillis === 'function' ? { _seconds: Math.floor(v.toMillis() / 1000) } : v))) : null; });
    const open = async () => {
      await P.goto(BASE + '/wallet.html', { waitUntil: 'domcontentloaded' });
      await P.waitForFunction(() => window.W2 && typeof W2.openWithdraw === 'function', null, T);
      await P.waitForFunction(() => { const b = document.getElementById('balVal'); return b && /\d/.test(b.textContent); }, null, T);
      await P.evaluate(() => { const b = document.getElementById('_sokoniPrivacyBanner'); if (b) b.remove(); });
    };
    const enterPin = async (pin) => {
      await P.waitForSelector('#ovlPinVerify.open', T);
      await P.fill('#pinVerifyInput', pin);
    };
    const PIN = '4829';

    /* SB1 */
    let sb1 = {};
    await act('no PIN', async () => {
      await open();
      await P.evaluate(() => W2.openWithdraw());
      await P.waitForSelector('#wdrPinNotice', { state: 'visible', timeout: 15000 });
      sb1.notice = await P.$eval('#wdrPinNotice', (e) => e.innerText);
      await P.fill('#wdrAmount', '300'); await P.fill('#wdrPhone', '0712345678');
      const before = CALLS.filter((c) => c === 'requestSellerPayout').length;
      await P.evaluate(() => { W2.requestPayout(); });   /* not awaited: a PIN prompt must never hang the suite */
      await P.waitForTimeout(600);
      sb1.prompt = await P.evaluate(() => !!document.querySelector('#ovlPinVerify.open'));
      sb1.sent = CALLS.filter((c) => c === 'requestSellerPayout').length - before;
      sb1.err = await P.$eval('#wdrError', (e) => e.innerText);
    });
    ck('SB1 no PIN: the sheet says "Wallet security incomplete — set your Wallet PIN", and no request is sent',
      /Wallet security incomplete/.test(sb1.notice || '') && /Set your Wallet PIN/.test(sb1.notice || '') && sb1.sent === 0 && sb1.prompt === false, sb1);

    /* SB2 */
    let sb2 = {};
    await act('set the PIN', async () => {
      await P.click('#wdrPinNotice button', T);
      await P.waitForSelector('#ovlPinSetup.open', T);
      for (const k of PIN) await P.evaluate((x) => W2.pinKey(x), k);
      await P.waitForTimeout(400);
      for (const k of PIN) await P.evaluate((x) => W2.pinKey(x), k);
      await P.waitForFunction(() => !document.querySelector('#ovlPinSetup.open'), null, T);
      sb2.w = await read('wallets/' + UID);
      await P.evaluate(() => W2.openWithdraw());
      await P.waitForTimeout(200);
      sb2.notice = await P.$eval('#wdrPinNotice', (e) => getComputedStyle(e).display);
    });
    ck('SB2 "Secure my wallet" sets the PIN — stored only as a salted verifier — and the notice goes away',
      sb2.w && sb2.w.pinVerifier && !sb2.w.pinHash && !JSON.stringify(sb2.w).includes('"' + PIN + '"') && sb2.notice === 'none', { v: !!(sb2.w && sb2.w.pinVerifier), notice: sb2.notice });

    /* SB3 */
    let sb3 = {};
    await act('request with the PIN', async () => {
      await P.fill('#wdrAmount', '300'); await P.fill('#wdrPhone', '0712345678');
      await P.evaluate(() => { W2.requestPayout(); });
      await enterPin(PIN);
      await P.waitForSelector('#wdrSuccess', { state: 'visible', timeout: 15000 });
      sb3.title = await P.$eval('#wdrSuccess', (e) => e.innerText);
    });
    const reqs = (await db.collection('payoutRequests').get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const r1 = reqs[0] || {};
    ck('SB3 request KSh 300 with the PIN → "Money held for you"; the server holds it (pending), nothing sent',
      /Money held for you/.test(sb3.title || '') && r1.status === 'pending' && r1.secureRelease === true && JSON.stringify(await readWallet()) === JSON.stringify({ balance: 700, pendingPayout: 300 }) && sends.length === 0,
      { title: (sb3.title || '').slice(0, 80), st: r1.status, w: await readWallet() });

    /* SB4 — SOKONI approves (the real adminProcessPayout, as AdminOS calls it) */
    /* fail closed: an approval that cannot run is a FAIL below, never a crash */
    try { await W.adminProcessPayout.run({ auth: { uid: 'adm1', token: { admin: true } }, data: { requestId: r1.id, status: 'approved' } }); } catch (_) {}
    let sb4 = {};
    await act('the dashboard after approval', async () => {
      await open();
      await P.waitForSelector('#releaseReadyBanner', { state: 'visible', timeout: 15000 });
      sb4.text = await P.$eval('#releaseReadyBanner', (e) => e.innerText);
    });
    ck('SB4 after SOKONI approves, the dashboard says "Your money is ready to be released" (nothing sent yet)',
      /ready to be released/.test(sb4.text || '') && /300/.test(sb4.text || '') && /No money has been sent/.test(sb4.text || '') && sends.length === 0, sb4);

    /* SB5 */
    let sb5 = {};
    await act('confirm & release', async () => {
      sb5.hit = await P.evaluate(() => { const b = document.getElementById('releaseReadyBanner').getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { b: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], top: e && (e.id || e.className), vh: innerHeight }; });
      await P.click('#releaseReadyBanner', T);
      await P.waitForSelector('.sr-release', T);
      sb5.card = await P.$eval('#payoutsList', (e) => e.innerText);
      sb5.btnH = await P.$eval('.sr-release', (b) => b.getBoundingClientRect().height);
      sb5.l390 = await P.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
      await P.click('.sr-release', T);
      await enterPin(PIN);
      await P.waitForFunction(() => /Released — sending/.test((document.getElementById('payoutsList') || {}).innerText || ''), null, T);
      sb5.after = await P.$eval('#payoutsList', (e) => e.innerText);
      await P.waitForTimeout(600);
      sb5.banner = await P.$eval('#releaseReadyBanner', (e) => getComputedStyle(e).display);
    });
    const r1b = await read('payoutRequests/' + r1.id);
    ck('SB5 the timeline + "CONFIRM & RELEASE KSh 300.00" with the authorization note → PIN → owner_confirmed; list says "Released — sending"; banner gone',
      /Wallet PIN verified/.test(sb5.card || '') && /SOKONI approved/.test(sb5.card || '') && /Waiting for YOUR confirmation/.test(sb5.card || '')
      && /CONFIRM & RELEASE KSh 300\.00/.test(sb5.card || '') && /authorize SOKONI to release this exact amount/.test(sb5.card || '')
      && r1b.status === 'owner_confirmed' && /Released — sending/.test(sb5.after || '') && sb5.banner === 'none' && sends.length === 0,
      { hit: sb5.hit, st: r1b.status, banner: sb5.banner, card: (sb5.card || '').replace(/\s+/g, ' ').slice(0, 200) });

    /* SB6 */
    let sb6 = {};
    await act('cancel a request', async () => {
      await P.evaluate(() => W2.closeOverlay('ovlPayouts'));
      await P.evaluate(() => W2.openWithdraw());
      await P.fill('#wdrAmount', '200'); await P.fill('#wdrPhone', '0712345678');
      await P.evaluate(() => { W2.requestPayout(); });
      await enterPin(PIN);
      await P.waitForSelector('#wdrSuccess', { state: 'visible', timeout: 15000 });
      await P.evaluate(() => W2.openPayouts());
      await P.waitForSelector('.sr-cancel', T);
      P.once('dialog', (d) => d.accept());
      await P.click('.sr-cancel', T);
      await P.waitForFunction(() => /Cancelled/.test((document.getElementById('payoutsList') || {}).innerText || ''), null, T);
    });
    const two = (await db.collection('payoutRequests').get()).docs.map((d) => d.data()).find((x) => x.amount === 200) || {};
    ck('SB6 a second request, cancelled from the list → cancelled, the money back in the wallet', two.status === 'cancelled' && JSON.stringify(await readWallet()) === JSON.stringify({ balance: 700, pendingPayout: 300 }), { st: two.status, w: await readWallet() });

    /* SB7 */
    await P.setViewportSize({ width: 1280, height: 900 }); await P.waitForTimeout(250);
    const l1280 = await P.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
    ck('SB7 no sideways scroll at 390px or 1280px; the release button is a ≥48px target', sb5.l390 <= 0 && l1280 <= 0 && sb5.btnH >= 48, { l390: sb5.l390, l1280, h: sb5.btnH });

    const pe = errors.filter((m) => /_sr|releasePayout|cancelPayout|_checkReleaseReady|wdrPinNotice|releaseReady|_payoutsCache/i.test(m));
    ck('SB8 no page error from the Secure Release code', pe.length === 0, { errs: pe.slice(0, 3), other: errors.slice(0, 2) });
    await ctx.close();
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
