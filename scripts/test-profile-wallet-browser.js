/* test-profile-wallet-browser.js — the buyer's wallet opens INSIDE the profile page (real Chromium, 2026-09-30).
 *
 * Owner: "MAKE SURE THE WALLET OF BUYER OPEN CORRECT IN THE PROFILE PAGE … NOT TO REDIRECT OUT … SHELL EVERYTHING TO
 * PROFILE FOR BUYER WALLET".
 *
 * REAL profile.html, wallet.html, sokoni-wallet-v2.js, auth-guard.js, shared-header.js served from this tree. Firebase
 * is not reachable: firebase.js / session-manager.js are empty modules and the Firebase Auth SDK the wallet imports is a
 * stub whose only job is to report a signed-in (or, for PW5, a signed-out) user. Everything else external is aborted.
 *
 * PROVES
 *   PW1 a wallet.html link on the profile page does NOT leave the page: the Wallet tab opens and hosts the premium
 *       wallet (wallet.html?shell=profile) in-page
 *   PW2 the Wallet tab button alone opens the hosted wallet (the summary gives way to it)
 *   PW3 "Withdraw" (the palette / module command path, _goHref) lands on the WITHDRAW sheet inside the hosted wallet,
 *       still on profile.html
 *   PW3b a fresh deep link (profile.html#wallet:withdraw) opens the hosted wallet ON the withdraw sheet
 *   PW4 inside profile the wallet runs in shell mode: no second top bar, the enterprise Financial OS link is not shown,
 *       and a link out of the wallet opens at the top level, never trapped in the frame
 *   PW5 a lost session inside the hosted wallet sends the WHOLE tab to login (next = profile's wallet); the frame never
 *       renders a login page
 *   PW6 laid out for every device: no sideways scroll at 390px or 1280px; the wallet frame fits the viewport width and
 *       is at least 540px tall
 *   PW7 the account menu's Wallet entry points to profile.html#wallet (source contract)
 *   PW8 no page error from the in-profile wallet code
 */
'use strict';
const Path = require('path'), http = require('http'), fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 360) + ']' : '')); ok ? pass++ : fail++; };

const AUTH_STUB = `export function getAuth(){ return {}; }
export function onAuthStateChanged(a, cb){
  var nu = false; try { nu = localStorage.getItem('__test_null_user') === '1'; } catch (e) {}
  setTimeout(function(){ cb(nu ? null : { uid: 'jane', phoneNumber: '+254712345678', displayName: 'Jane', email: 'jane@example.com' }); }, 50);
  return function(){};
}
export function signOut(){ return Promise.resolve(); }
export function onIdTokenChanged(a, cb){ return function(){}; }
export function RecaptchaVerifier(){}
export function linkWithPhoneNumber(){ return Promise.reject(new Error('stub')); }
export function updatePhoneNumber(){ return Promise.reject(new Error('stub')); }
export var PhoneAuthProvider = { credential: function(){ return {}; } };`;

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
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 20000 };
  const errors = [];
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 220)); return false; } };
  const newCtx = async (vw, nullUser) => {
    const ctx = await browser.newContext({ viewport: { width: vw, height: 860 } });
    await ctx.route('**/*', (r) => {
      const url = r.request().url();
      if (/gstatic\.com\/firebasejs\/.*firebase-auth\.js/.test(url)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: AUTH_STUB });
      return url.startsWith(BASE) ? r.continue() : r.abort();
    });
    await ctx.addInitScript((nu) => {
      try { localStorage.setItem('loggedIn', 'true'); localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'jane', name: 'Jane' }));
        if (nu) localStorage.setItem('__test_null_user', '1'); else localStorage.removeItem('__test_null_user');
        localStorage.setItem('sokoniPrivacyConsent', '1'); } catch (e) {}
    }, !!nullUser);
    return ctx;
  };
  const frameOf = async (P) => { for (let i = 0; i < 60; i++) { const f = P.frames().find((x) => /wallet\.html\?shell=profile/.test(x.url())); if (f) return f; await P.waitForTimeout(250); } return null; };
  try {
    /* ── PW1, PW3, PW4, PW6 @390 ── */
    const ctx = await newCtx(390);
    const P = await ctx.newPage();
    P.on('pageerror', (e) => errors.push(e.message));
    await P.goto(BASE + '/profile.html', { waitUntil: 'domcontentloaded' });
    await P.waitForFunction(() => typeof _openWalletIn === 'function' && typeof switchTab === 'function', null, T);
    await P.waitForTimeout(800);

    let pw1 = {};
    await act('a wallet.html link on profile', async () => {
      pw1.before = P.url();
      await P.evaluate(() => { const a = document.querySelector('a[href="wallet.html"]'); a.click(); });
      await P.waitForSelector('#walletFrame', T);
      await P.waitForTimeout(400);
      pw1.after = P.url();
      pw1.src = await P.$eval('#walletFrame', (f) => f.getAttribute('src'));
      pw1.tab = await P.evaluate(() => document.getElementById('panel-wallet').classList.contains('active'));
      pw1.host = await P.evaluate(() => !document.getElementById('walletHost').hidden && document.getElementById('walletSummary').hidden);
    });
    ck('PW1 a wallet.html link does NOT leave profile: the Wallet tab opens and hosts the premium wallet in-page',
      /\/profile\.html#wallet$/.test(pw1.after || '') && pw1.src === 'wallet.html?shell=profile' && pw1.tab && pw1.host, pw1);

    let pw4 = {};
    await act('shell mode inside the frame', async () => {
      const F = await frameOf(P);
      await F.waitForFunction(() => document.documentElement.classList.contains('in-profile'), null, T);
      pw4 = await F.evaluate(() => ({
        top: getComputedStyle(document.getElementById('wal-top')).display,
        fos: (() => { const a = document.querySelector('a[href="sfos-wallet.html"]'); return a ? getComputedStyle(a).display : 'absent'; })(),
        base: (document.querySelector('base') || {}).target || null,
      }));
    });
    ck('PW4 in profile the wallet runs in shell mode: no second top bar, no enterprise Financial OS link, links out open at the top level',
      pw4.top === 'none' && (pw4.fos === 'none' || pw4.fos === 'absent') && pw4.base === '_top', pw4);

    let pw3 = {};
    await act('Withdraw lands on the withdraw sheet', async () => {
      await P.evaluate(() => _goHref('wallet.html#withdraw'));
      const F = await frameOf(P);
      await F.waitForFunction(() => { const o = document.getElementById('ovlWithdraw'); return o && (o.classList.contains('open') || o.classList.contains('active') || getComputedStyle(o).display !== 'none'); }, null, T);
      pw3.url = P.url();
      pw3.sheet = await F.evaluate(() => { const o = document.getElementById('ovlWithdraw'); return { cls: o.className, disp: getComputedStyle(o).display }; });
    });
    ck('PW3 "Withdraw" (the palette / module command path) opens the WITHDRAW sheet inside the hosted wallet — still on profile',
      /* the hash may settle on #wallet: profile's later switchTab wrappers re-write it (pre-existing, recorded) */
      /\/profile\.html#wallet(:withdraw)?$/.test(pw3.url || '') && pw3.sheet && pw3.sheet.disp !== 'none', pw3);

    const lay390 = await P.evaluate(() => { const el = document.getElementById('walletFrame'); if (!el) return { missing: true }; const f = el.getBoundingClientRect(); return { over: document.scrollingElement.scrollWidth - window.innerWidth, fw: f.width, fh: f.height, vw: window.innerWidth }; });
    await P.setViewportSize({ width: 1280, height: 900 }); await P.waitForTimeout(300);
    const lay1280 = await P.evaluate(() => { const el = document.getElementById('walletFrame'); if (!el) return { missing: true }; const f = el.getBoundingClientRect(); return { over: document.scrollingElement.scrollWidth - window.innerWidth, fw: f.width, fh: f.height, vw: window.innerWidth }; });
    ck('PW6 laid out for every device: no sideways scroll at 390px or 1280px; the wallet fits the width and is ≥540px tall',
      [lay390, lay1280].every((l) => !l.missing && l.over <= 0 && l.fw > 0 && l.fw <= l.vw && l.fh >= 540), { lay390, lay1280 });
    await ctx.close();

    /* ── PW2: the tab button alone ── */
    const ctx2 = await newCtx(1280);
    const P2 = await ctx2.newPage();
    P2.on('pageerror', (e) => errors.push(e.message));
    await P2.goto(BASE + '/profile.html', { waitUntil: 'domcontentloaded' });
    await P2.waitForFunction(() => typeof switchTab === 'function', null, T);
    let pw2 = {};
    await act('the Wallet tab button', async () => {
      await P2.evaluate(() => document.querySelector('.up-tab[data-tab="wallet"]').click());
      await P2.waitForSelector('#walletFrame', T);
      pw2 = await P2.evaluate(() => ({ url: location.pathname + location.hash, summaryHidden: document.getElementById('walletSummary').hidden }));
    });
    ck('PW2 the Wallet tab button opens the hosted wallet (the summary gives way to it)', pw2.url === '/profile.html#wallet' && pw2.summaryHidden === true, pw2);
    await ctx2.close();

    /* ── PW3b: a fresh deep link — profile.html#wallet:withdraw from anywhere ── */
    const ctx4 = await newCtx(390);
    const P4 = await ctx4.newPage();
    P4.on('pageerror', (e) => errors.push(e.message));
    let pw3b = {};
    await act('fresh withdraw deep link', async () => {
      await P4.goto(BASE + '/profile.html#wallet:withdraw', { waitUntil: 'domcontentloaded' });
      await P4.waitForSelector('#walletFrame', T);
      pw3b.src = await P4.$eval('#walletFrame', (f) => f.getAttribute('src'));
      const F = await frameOf(P4); pw3b.t0 = Date.now();
      await F.waitForFunction(() => { const o = document.getElementById('ovlWithdraw'); return o && o.classList.contains('open'); }, null, { timeout: 30000, polling: 250 });
      pw3b.open = true; pw3b.ms = Date.now() - pw3b.t0; pw3b.url = P4.url();
      pw3b.phone = await F.evaluate(() => (document.getElementById('wdrPhone') || {}).value || '');
    });
    ck('PW3b a fresh deep link (profile.html#wallet:withdraw) opens profile with the hosted wallet ON the withdraw sheet, prefilled with the owner\'s M-PESA number',
      pw3b.src === 'wallet.html?shell=profile&open=withdraw' && pw3b.open === true && pw3b.phone === '0712345678' && /\/profile\.html#wallet/.test(pw3b.url || ''), pw3b);
    await ctx4.close();

    /* ── PW5: a lost session inside the hosted wallet ── */
    const ctx3 = await newCtx(390, true);
    const P3 = await ctx3.newPage();
    P3.on('pageerror', (e) => errors.push(e.message));
    const frameNavs = [], topNavs = [];
    P3.on('framenavigated', (f) => { if (f !== P3.mainFrame()) frameNavs.push(f.url()); else topNavs.push(f.url()); });
    await P3.goto(BASE + '/profile.html#wallet', { waitUntil: 'domcontentloaded' });
    let pw5 = {};
    await act('lost session', async () => {
      await P3.waitForURL(/\/login\.html\?next=/, { timeout: 20000 });
      /* the recorded top-level navigation (this test keeps the loggedIn flag, so login then returns to `next`) */
      pw5.url = topNavs.find((u) => /\/login\.html\?next=/.test(u)) || P3.url();
    });
    pw5.frameLogin = frameNavs.filter((u) => /login/.test(u));
    ck('PW5 a lost session in the hosted wallet sends the WHOLE tab to login (next = profile\'s wallet); the frame never renders login',
      /login\.html\?next=%2Fprofile\.html%23wallet$/.test(pw5.url || '') && pw5.frameLogin.length === 0, pw5);
    await ctx3.close();

    const sh = fs.readFileSync(Path.join(ROOT, 'shared-header.js'), 'utf8');
    ck('PW7 the account menu\'s Wallet entry points to profile.html#wallet (source contract)', /href="profile\.html#wallet"[^>]*><i class="fas fa-wallet"><\/i> Wallet/.test(sh) && !/href="wallet\.html"[^>]*><i class="fas fa-wallet"><\/i> Wallet/.test(sh), '');

    const pe = errors.filter((m) => /_ensureWalletFrame|_openWalletIn|_goHref|_openFromLink|in-profile|__sokoniWalletInProfile|walletFrame|walletHost/i.test(m));
    ck('PW8 no page error from the in-profile wallet code', pe.length === 0, { errs: pe.slice(0, 3), other: errors.length });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
