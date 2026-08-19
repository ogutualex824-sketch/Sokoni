#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 — REAL SELLER CERTIFICATION
   ------------------------------------------------------------------------------
   Proves the one question every local and Node test deliberately cannot answer:

       Can a REAL approved merchant enter Merchant v2 and use the native
       operational core against their OWN seller/shop data?

   MODE production (the launch gate) — a real approved seller, production Auth:

     SOKONI_CERT_MERCHANT_EMAIL=…       required (both, or exit 2)
     SOKONI_CERT_MERCHANT_PASSWORD=…
     SOKONI_APPCHECK_DEBUG_TOKEN=…      required — the harness serves localhost
     SOKONI_CERT_SELLER_UID=…           OPTIONAL pin; identity is otherwise DERIVED
     SOKONI_CERT_SHOP_ID=…              OPTIONAL pin
     node scripts/test-merchant-v2-certification.js

   MODE ci (repeatable, no secrets) — emulator identity + production App Check:

     SOKONI_APPCHECK_DEBUG_TOKEN=… \
     firebase emulators:exec --only auth --project merchant-v2-cert \
       "node scripts/test-merchant-v2-certification.js"

   Credentials are read from the environment at runtime and nowhere else. No default,
   no fallback account, no committed fixture. Half-supplied credentials exit 2 rather
   than quietly running the emulator path and reporting a green that answers a
   different question.

   WHAT CI MODE CANNOT EARN — measured, not assumed. Production Firestore will not
   accept an ID token signed by the emulator's project, so with an emulator session
   every production read is refused. Ownership rows therefore stay UNPROVEN in ci and
   only a production run can close them.

   WHAT NEITHER MODE CAN EARN — a headless browser cannot be granted Bluetooth and
   there is no physical printer attached. This suite proves the printer STATE and the
   shell's non-teardown across module switches; it CANNOT prove that a real GATT
   connection survives. That row is reported as DEVICE-MANUAL and must be signed by a
   human on real hardware. Faking it would defeat the point of the device layer.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { webkit, chromium } = require('playwright');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8841;
/* localhost, not 127.0.0.1 — firebase.js gates the debug path on IS_LOCALHOST and both
   qualify, but Firebase's authorized-domains list is the stricter of the two. */
/* SOKONI_CERT_ORIGIN targets an ALREADY-DEPLOYED origin instead of serving the repo.
   Unset (the default) is unchanged: serve localhost and require a debug token.

   Against production this is the STRONGER run, not a convenience. The artifact under
   test is the one merchants actually receive rather than a local copy of it, and App
   Check attests NATIVELY on the real origin — so no debug token is minted, used, or
   left behind to revoke. A debug token bypasses attestation; on production we want
   attestation exercised, which is the whole point of certifying the live shell. */
const CERT_ORIGIN = (process.env.SOKONI_CERT_ORIGIN || '').replace(/\/+$/, '');
const REMOTE = !!CERT_ORIGIN;
const BASE = REMOTE ? CERT_ORIGIN : 'http://localhost:' + PORT;
/* cleanUrls:true 301-redirects a .html path in production, and a 301 mid-run reads as a
   navigation the containment assertions must not see. Use the clean route there. */
const PAGE = REMOTE ? '/merchant-v2' : '/merchant-v2.html';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const EMU = 'http://' + AUTH_HOST;
const API_KEY = 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';  /* shipped web key; the emulator ignores its value */
const APPCHECK_TOKEN = process.env.SOKONI_APPCHECK_DEBUG_TOKEN || '';

const CERT_EMAIL = process.env.SOKONI_CERT_MERCHANT_EMAIL || '';
const CERT_PASSWORD = process.env.SOKONI_CERT_MERCHANT_PASSWORD || '';
const CERT_SELLER_UID = process.env.SOKONI_CERT_SELLER_UID || '';
const CERT_SHOP_ID = process.env.SOKONI_CERT_SHOP_ID || '';

if ((CERT_EMAIL && !CERT_PASSWORD) || (!CERT_EMAIL && CERT_PASSWORD)) {
  console.error('\nFAIL CLOSED — production certification needs BOTH credentials:');
  console.error('  SOKONI_CERT_MERCHANT_EMAIL      ' + (CERT_EMAIL ? 'set' : 'MISSING'));
  console.error('  SOKONI_CERT_MERCHANT_PASSWORD   ' + (CERT_PASSWORD ? 'set' : 'MISSING'));
  console.error('Refusing to fall back to the emulator: that would answer a different question.');
  process.exit(2);
}
const MODE = CERT_EMAIL && CERT_PASSWORD ? 'production' : 'ci';
if (REMOTE && MODE !== 'production') {
  console.error('\nFAIL CLOSED — SOKONI_CERT_ORIGIN targets a deployed origin, which has no Auth');
  console.error('emulator to seed an identity into. CI mode there would sign in as nobody and');
  console.error('every ownership row would prove nothing. Supply the real approved seller:');
  console.error('  SOKONI_CERT_MERCHANT_EMAIL      ' + (CERT_EMAIL ? 'set' : 'MISSING'));
  console.error('  SOKONI_CERT_MERCHANT_PASSWORD   ' + (CERT_PASSWORD ? 'set' : 'MISSING'));
  process.exit(2);
}
const EMAIL = MODE === 'production' ? CERT_EMAIL : 'merchant-v2@sokoni.test';
const PASSWORD = MODE === 'production' ? CERT_PASSWORD : 'CertGate!2026';

let pass = 0, fail = 0, unproven = 0;
const failures = [];
const L = {};
const ck = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; failures.push(label + (detail ? '  → ' + detail : '')); console.log('  FAIL  ' + label + (detail ? '   → ' + detail : '')); }
  return !!cond;
};
const unp = (label, why) => { unproven++; console.log('  \x1b[33mUNPROVEN\x1b[0m  ' + label + (why ? '   → ' + why : '')); };
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
               '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
               '.webp': 'image/webp', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  let f = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';   /* cleanUrls:true */
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});

function post (url, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const r = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (rs) => { let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.write(data); r.end();
  });
}

/* The operational core, in the order a merchant actually works through it. The closing
   `orders` is the revisit that proves A -> … -> A across the WHOLE walk, not one hop. */
/* Ends on Products -> POS deliberately: that is the pairing the emulator diagnosis
   repeatedly implicated, so the production run must exercise it LAST, after every other
   surface has been opened and the session has had the longest chance to be disturbed. */
const WALK = ['dashboard', 'products', 'pos', 'orders', 'analytics', 'revenue',
              'payments', 'devices', 'availability', 'settings', 'products', 'pos'];
/* Native surfaces render in the shell's own document; iframe ones do not, so their
   invariants differ and are asserted separately. */
const NATIVE = new Set(['dashboard', 'orders', 'analytics', 'revenue', 'payments',
                        'devices', 'availability', 'settings']);

/* Hosting runs cleanUrls:true, so /merchant-v2.html is served and then reported as
   /merchant-v2. Comparing the literal path marks every in-shell hash change as a
   document navigation — the documented trap, and it produced 12 false violations. */
const samePage = (p1, p2) =>
  String(p1).split('#')[0].replace(/\.html$/, '') === String(p2).split('#')[0].replace(/\.html$/, '');

/* No server is listening in REMOTE mode, so closing must be a no-op rather than a throw. */
const closeServer = () => { try { if (!REMOTE) server.close(); } catch (_) {} };

process.on('unhandledRejection', () => {});

(async () => {
  if (!REMOTE) await new Promise((r) => server.listen(PORT, r));

  console.log('\n  ORIGIN: ' + BASE + (REMOTE ? '   (DEPLOYED artifact — App Check attests natively)' : '   (repo served locally)'));
  console.log('\n\x1b[1mMODE: ' + MODE.toUpperCase() + '\x1b[0m' +
    (MODE === 'production' ? '  — REAL approved seller against PRODUCTION Auth'
                           : '  — Auth emulator identity + production App Check'));

  /* On the real origin App Check attests natively. A debug token would BYPASS the very
     mechanism this run exists to exercise, so supplying one here is refused rather than
     ignored — silently accepting it would produce a green that proves less than it claims. */
  if (REMOTE && APPCHECK_TOKEN) {
    console.error('\nFAIL CLOSED — a debug token was supplied for a PRODUCTION origin run.');
    console.error('App Check attests natively on ' + BASE + '. A debug token bypasses attestation,');
    console.error('so the run would no longer prove the live shell passes App Check.');
    console.error('Unset SOKONI_APPCHECK_DEBUG_TOKEN and run again.');
    closeServer(); process.exit(2);
  }

  if (!REMOTE && !APPCHECK_TOKEN) {
    console.error('\nFAIL CLOSED — SOKONI_APPCHECK_DEBUG_TOKEN is required.');
    console.error('The harness serves from localhost, so App Check cannot attest without it and');
    console.error('a failed App Check token fetch blocks every Firebase Auth request BEFORE it is');
    console.error('sent — sign-in would never happen and every row would prove nothing.');
    console.error('Mint one, run, then REVOKE it (docs/APPCHECK_DEBUG_TOKEN_LEDGER.md).');
    closeServer(); process.exit(2);
  }

  /* A malformed token costs a full run to discover: App Check fails to attest, Auth is
     blocked before the request is sent, sign-in reports auth/network-request-failed, and
     every downstream row fails for a reason that has nothing to do with the product.
     That happened once with a UUID missing a single hyphen. Check the shape first. */
  if (!REMOTE && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(APPCHECK_TOKEN)) {
    console.error('\nFAIL CLOSED — SOKONI_APPCHECK_DEBUG_TOKEN is not a valid UUID.');
    console.error('  got a value of length ' + APPCHECK_TOKEN.length +
                  ' with ' + (APPCHECK_TOKEN.split('-').length - 1) + ' hyphen(s); a debug token is');
    console.error('  8-4-4-4-12 hex, e.g. 1234abcd-12ab-34cd-56ef-1234567890ab (4 hyphens).');
    console.error('Re-copy it from `firebase appcheck:debugtokens:create` — a single missing hyphen');
    console.error('makes every row below fail for a reason unrelated to the product.');
    closeServer(); process.exit(2);
  }

  head('0 · identity');
  let UID = null;
  if (MODE === 'ci') {
    let signUp = null;
    try {
      signUp = await post(EMU + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY,
        { email: EMAIL, password: PASSWORD, returnSecureToken: true });
    } catch (e) {
      console.log('  SKIP — Auth emulator not reachable at ' + AUTH_HOST + ' (' + e.message + ')');
      closeServer(); process.exit(0);
    }
    if (!signUp || !signUp.localId) { console.log('  SKIP — emulator minted no user'); closeServer(); process.exit(0); }
    UID = signUp.localId;
    ck('emulator minted a test account', !!UID, 'uid=' + UID);
  } else {
    console.log('  production — signing in as the supplied approved seller. No emulator is attached,');
    console.log('  and NO identity is seeded into the page: every role and shop claim comes from the account.');
  }

  /* Chromium in production mode: it is the engine that implements Web Bluetooth, so the
     device rows describe the browser a merchant would actually use. WebKit otherwise. */
  const browser = await (MODE === 'production' ? chromium : webkit).launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: MODE !== 'production', hasTouch: true });

  if (MODE === 'ci') {
    const authRoute = async (route) => {
      try {
        const u = new URL(route.request().url());
        const r = await route.fetch({ url: EMU + '/' + u.host + u.pathname + u.search });
        await route.fulfill({ response: r });
      } catch (e) { try { await route.abort(); } catch (_) {} }
    };
    await ctx.route('https://identitytoolkit.googleapis.com/**', authRoute);
    await ctx.route('https://securetoken.googleapis.com/**', authRoute);
  }

  await ctx.addInitScript(({ token }) => {
    try {
      if (token) localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', token);   /* never set in REMOTE mode */
      localStorage.setItem('loggedIn', 'true');   /* only the flag the armed guard reads */
    } catch (e) {}
  }, { token: REMOTE ? '' : APPCHECK_TOKEN });

  const page = await ctx.newPage();
  const pageErrors = [], topNav = [], childNav = [];
  const sdkHits = [];
  page.on('pageerror', (e) => pageErrors.push({ msg: (e.message || '').slice(0, 160), stack: String(e.stack || '').slice(0, 500) }));
  page.on('framenavigated', (f) => {
    const u = f.url(); if (!u.startsWith(BASE)) return;
    (f === page.mainFrame() ? topNav : childNav).push(u.replace(BASE, ''));
  });
  /* THE no-repeated-initialization invariant, measured directly. Only main-frame
     requests count: an iframe module legitimately boots its own SDK until it is ported. */
  page.on('request', (r) => {
    if (/firebasejs\/[\d.]+\/firebase-(app|auth|firestore)\.js/.test(r.url()) && r.frame() === page.mainFrame()) {
      sdkHits.push(r.url().split('/').pop());
    }
  });

  head('1 · sign in where Firebase boots, then enter the shell');
  /* cleanUrls 301s '/index.html' in production. A redirect here would register as an extra
     top-level navigation and muddy the containment rows, so REMOTE uses the clean root. */
  await page.goto(BASE + (REMOTE ? '/' : '/index.html'), { waitUntil: 'commit', timeout: 30000 }).catch(() => null);
  await page.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout: 25000 }).catch(() => null);

  /* Bounded retry — sign-in through the shipped SDK intermittently misses its window,
     and an intermittent sign-in makes everything downstream measure a signed-OUT
     browser while the ledger still prints rows. */
  let auth = { ok: false, why: 'not attempted' };
  for (let i = 0; i < 3; i++) {
    auth = await page.evaluate(async ({ email, password }) => {
      try {
        const [{ getApps, getApp }, { getAuth, signInWithEmailAndPassword, onAuthStateChanged }] = await Promise.all([
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
        ]);
        if (!getApps().length) return { ok: false, why: 'no Firebase app on the page' };
        const a = getAuth(getApp());
        if (a.currentUser) return { ok: true, uid: a.currentUser.uid };
        await signInWithEmailAndPassword(a, email, password);
        const uid = await new Promise((res) => {
          const t = setTimeout(() => res(null), 10000);
          onAuthStateChanged(a, (u) => { if (u) { clearTimeout(t); res(u.uid); } });
        });
        return { ok: !!uid, uid: uid };
      } catch (e) { return { ok: false, why: (e && (e.code || e.message)) || 'unknown' }; }
    }, { email: EMAIL, password: PASSWORD }).catch((e) => ({ ok: false, why: e.message }));
    if (auth.ok) break;
    await page.waitForTimeout(2000);
  }
  L.session = ck('signed in against ' + (MODE === 'production' ? 'PRODUCTION Auth' : 'the emulator'),
                 auth.ok, auth.why || '');
  const SESSION_UID = auth.uid || null;
  if (MODE === 'ci') L.uid = ck('resolved the emulator uid', SESSION_UID === UID, 'got ' + SESSION_UID);
  else if (CERT_SELLER_UID) L.uid = ck('session uid matches the pinned SOKONI_CERT_SELLER_UID', SESSION_UID === CERT_SELLER_UID, 'got ' + SESSION_UID);
  else { L.uid = ck('resolved a production uid', !!SESSION_UID); console.log('        derived sellerUid = ' + SESSION_UID); }

  head('2 · the shell adopts the session — once');
  await page.goto(BASE + PAGE + '#dashboard', { waitUntil: 'commit', timeout: 30000 }).catch(() => null);
  await page.waitForFunction(() => !!(window.SokoniShell && window.SokoniShell.session && typeof window.__mgo === 'function'),
                             null, { timeout: 25000 }).catch(() => null);
  /* Wait for the shell's OWN resolution, not a fixed sleep — 'resolving' is not 'out'. */
  await page.waitForFunction(() => window.SokoniShell.session.state !== 'resolving', null, { timeout: 30000 }).catch(() => null);
  /* …and then wait for the SHOP lookup to SETTLE. `state` flips to 'in' as soon as the user
     is known, while resolveShop() is still in flight, so sampling here reported
     `shop:null, shopError:null` — the initial values — and scored it as a failed lookup.
     A settled lookup has EITHER a shop OR a recorded reason; anything else is "not yet". */
  await page.waitForFunction(
    () => { const s = window.SokoniShell.session; return s.state !== 'in' || !!s.activeShopId || !!s.shopError; },
    null, { timeout: 30000 }
  ).catch(() => null);
  topNav.length = 0;
  const preShellErrors = pageErrors.splice(0, pageErrors.length);   /* index.html defects are not v2's */
  const sdkAtEntry = sdkHits.length;

  const s0 = await page.evaluate(() => ({
    state: window.SokoniShell.session.state,
    uid: window.SokoniShell.session.uid,
    sellerUid: window.SokoniShell.session.sellerUid,
    shop: window.SokoniShell.activeShopId,
    shopName: (window.SokoniShell.session.shop || {}).name || null,
    shopError: window.SokoniShell.session.shopError || null,
  }));
  L.shellSession = ck('the shell resolved a real session', s0.state === 'in' && !!s0.uid, JSON.stringify(s0));
  /* `null === null` is not a proof. This row reported PASS on a run where sign-in had
     failed and BOTH sides were null — a green earned by the absence of a session. It is
     only assertable once an identity exists. */
  if (!SESSION_UID) { unp('shell sellerUid === the authenticated uid', 'no session to compare'); L.sellerUid = null; }
  else L.sellerUid = ck('shell sellerUid === the authenticated uid', s0.sellerUid === SESSION_UID, JSON.stringify(s0));
  if (MODE === 'production') {
    L.shop = ck('an active shop resolved', !!s0.shop, JSON.stringify(s0));
    if (CERT_SHOP_ID) ck('active shop matches the pinned SOKONI_CERT_SHOP_ID', s0.shop === CERT_SHOP_ID, s0.shop);
  } else { unp('an active shop resolved', 'emulator identity owns no production shop'); L.shop = null; }

  head('3 · the operational walk — ' + WALK.length + ' transitions');
  const routeFails = [], invariantFails = [];
  let prev = await page.evaluate(() => ({
    docId: (window.__certDoc = window.__certDoc || String(Math.random()).slice(2)),
    uid: window.SokoniShell.session.uid,
    shop: window.SokoniShell.activeShopId,
    panels: document.querySelectorAll('.panel').length,
  }));

  for (const id of WALK) {
    const got = await page.evaluate(async (rid) => {
      window.__mgo(rid);
      await new Promise((x) => setTimeout(x, 2200));
      /* THE PERSISTED RECORD, checked at EVERY transition — not only at the end.
         The emulator diagnosis showed the origin's auth record can disappear silently
         while the page looks healthy, and a walk that only samples identity would miss
         the exact step it happened on. Checking it per step is what makes the production
         result attributable to a surface rather than to "somewhere in the walk". */
      const persisted = await new Promise((res) => {
        try {
          const rq = indexedDB.open('firebaseLocalStorageDb');
          rq.onsuccess = () => {
            const db = rq.result;
            if (!db.objectStoreNames.contains('firebaseLocalStorage')) return res(false);
            const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
            all.onsuccess = () => res((all.result || []).some((r) => /firebase:authUser:/.test(String(r && r.fbase_key))));
            all.onerror = () => res(false);
          };
          rq.onerror = () => res(false);
        } catch (e) { res(false); }
      });
      let sdkUser = null;
      try {
        const { getApps, getApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
        sdkUser = getApps().length ? ((getAuth(getApp()).currentUser || {}).uid || null) : null;
      } catch (e) {}
      return {
        persisted: persisted,
        sdkUser: sdkUser,
        hash: location.hash.replace('#', ''),
        pathname: location.pathname,
        shown: document.querySelectorAll('.panel.show').length,
        panels: document.querySelectorAll('.panel').length,
        /* Replaced by a reload or a full remount; survives an in-document route change.
           This is what makes "no reload" OBSERVED rather than inferred from the URL. */
        docId: (window.__certDoc = window.__certDoc || String(Math.random()).slice(2)),
        uid: window.SokoniShell.session.uid,
        shop: window.SokoniShell.activeShopId,
        headers: document.querySelectorAll('header.hdr').length,
        sidebars: document.querySelectorAll('aside.side').length,
        printer: window.SokoniShell.devices.printer.state,
      };
    }, id).catch((e) => ({ err: e.message }));

    if (!got || got.err || got.hash !== id || got.shown !== 1 || !samePage(got.pathname, PAGE)) {
      routeFails.push(id + ' ' + JSON.stringify(got));
      if (got && !got.err) prev = got;
      continue;
    }
    const bad = [];
    if (got.docId !== prev.docId) bad.push('document replaced (reload/remount)');
    if (got.uid !== prev.uid) bad.push('identity changed ' + prev.uid + ' -> ' + got.uid);
    /* "Same identity" is satisfied by null === null, so it PASSED an entire walk in
       which the shell had no session at all — a vacuous green. Once a session is
       expected, the uid must be PRESENT on every transition, not merely unchanged. */
    if (L.session && !got.uid) bad.push('no uid on this transition (session expected)');
    /* The four things that must hold at EVERY step, per the launch definition:
       auth uid present · persisted record present · sellerUid === auth uid ·
       activeShopId unchanged (the last two are covered above). */
    if (L.session && got.persisted === false) bad.push('PERSISTED AUTH RECORD GONE at this step');
    if (L.session && !got.sdkUser) bad.push('SDK currentUser gone at this step');
    if (L.session && got.sdkUser && got.uid && got.sdkUser !== got.uid) {
      bad.push('shell uid ' + got.uid + ' disagrees with SDK currentUser ' + got.sdkUser);
    }
    if (prev.shop != null && got.shop != null && got.shop !== prev.shop) bad.push('activeShopId changed ' + prev.shop + ' -> ' + got.shop);
    if (prev.shop != null && got.shop == null) bad.push('activeShopId LOST');
    if (got.headers !== 1) bad.push('header count ' + got.headers);
    if (got.sidebars !== 1) bad.push('sidebar count ' + got.sidebars);
    if (got.panels > prev.panels + 1) bad.push('more than one panel appeared');
    if (bad.length) invariantFails.push(id + ': ' + bad.join('; '));
    prev = got;
  }
  L.walk = ck('every route mounted exactly one panel, in-document', routeFails.length === 0, routeFails.join(' | '));
  /* Every identity check inside the loop is guarded by `L.session`, so with no session the
     loop asserts NOTHING and this row printed PASS across 12 transitions in which the uid,
     the persisted record and the shop were all null throughout. A row that cannot fail must
     not report success — it is VOID until there is a session to keep. */
  if (!L.session) {
    unp('every transition kept the same document, identity, shop and one shell',
        'no session was established — the per-step identity checks were all skipped');
    L.invariants = null;
  } else
  L.invariants = ck('every transition kept the same document, identity, shop and one shell',
                    invariantFails.length === 0, invariantFails.join(' | '));

  head('4 · no repeated Firebase initialization');
  const sdkAfterWalk = sdkHits.length;
  L.singleInit = ck('the shell initialised the SDK once and never again across the walk',
    sdkAfterWalk === sdkAtEntry, 'main-frame SDK fetches ' + sdkAtEntry + ' -> ' + sdkAfterWalk +
    ' (iframe modules boot their own and are excluded)');

  head('5 · containment');
  L.noDocNav = ck('the document never left ' + PAGE, topNav.every((u) => samePage(u, PAGE)),
                  topNav.filter((u) => !samePage(u, PAGE)).join(', '));
  L.noPaneLogin = ck('no child frame navigated itself to login',
                     !childNav.some((u) => /^\/login(\.html)?/.test(u)),
                     childNav.filter((u) => /login/.test(u)).join(', '));

  head('6 · device layer survives the walk');
  const dev = await page.evaluate(() => ({
    api: !!window.SokoniShell.devices,
    printer: window.SokoniShell.devices.printer.state,
    saved: !!window.SokoniShell.devices.printer.saved,
    list: window.SokoniShell.devices.list.length,
  }));
  L.deviceApi = ck('the shell still owns the device registry after the walk', dev.api, JSON.stringify(dev));
  /* State persistence is provable here. A real GATT connection is NOT. */
  console.log('  \x1b[33mDEVICE-MANUAL\x1b[0m  a real printer connection surviving the walk');
  console.log('           Headless browsers cannot be granted Bluetooth and no printer is attached.');
  console.log('           This suite proves the registry and the shell are never torn down; that a');
  console.log('           live GATT link survives Devices -> POS -> Orders -> Analytics must be signed');
  console.log('           by a human on real hardware. Printer state observed: ' + dev.printer);
  L.deviceManual = null;

  head('7 · ownership — the merchant sees their OWN data');
  if (MODE !== 'production') {
    unp('orders are scoped to this seller', 'emulator identity cannot read production');
    unp('payments are scoped to this seller', 'emulator identity cannot read production');
    L.ownOrders = null; L.ownPayments = null;
  } else {
    const own = await page.evaluate(async () => {
      const out = {};
      const { getApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      const db = m.getFirestore(getApp());
      const uid = (getAuth(getApp()).currentUser || {}).uid;
      out.uid = uid;
      try {
        const s = await m.getDocs(m.query(m.collection(db, 'orders'), m.where('sellerUid', '==', uid), m.limit(10)));
        out.orders = { size: s.size, fromCache: s.metadata.fromCache, owners: s.docs.map((d) => (d.data() || {}).sellerUid) };
      } catch (e) { out.orders = 'ERR ' + (e.code || e.message); }
      try {
        const s = await m.getDocs(m.query(m.collection(db, 'sellerPayments'), m.where('sellerUid', '==', uid), m.limit(10)));
        out.payments = { size: s.size, fromCache: s.metadata.fromCache, owners: s.docs.map((d) => (d.data() || {}).sellerUid) };
      } catch (e) { out.payments = 'ERR ' + (e.code || e.message); }
      return out;
    }).catch((e) => ({ err: e.message }));

    console.log('  orders:   ' + JSON.stringify(own.orders));
    console.log('  payments: ' + JSON.stringify(own.payments));
    /* An EMPTY set is valid — a real seller may have no orders yet. What must hold is
       that the backend answered and that every row returned is genuinely theirs. */
    const okOwned = (r) => r && typeof r === 'object' && r.fromCache === false &&
                           (r.owners || []).every((o) => o === own.uid);
    L.ownOrders = ck('orders reached the backend and every row belongs to this seller', okOwned(own.orders), JSON.stringify(own.orders));
    L.ownPayments = ck('payments reached the backend and every row belongs to this seller', okOwned(own.payments), JSON.stringify(own.payments));
  }

  head('8 · refresh keeps the route and the session');
  await page.reload({ waitUntil: 'commit' }).catch(() => null);
  await page.waitForFunction(() => !!(window.SokoniShell && typeof window.__mgo === 'function'), null, { timeout: 25000 }).catch(() => null);
  /* Wait for the session to SETTLE. Waiting only for state !== 'resolving' samples the
     instant the shell reports a transient pre-restore state, which failed this row while
     the session was in fact restored a moment later (measured: currentUser present,
     IndexedDB record intact, shell 'in'). Wait for the expected outcome, bounded. */
  await page.waitForFunction(() => window.SokoniShell.session.state === 'in', null, { timeout: 30000 })
    .catch(() => null);
  /* Report what FIREBASE has, not only what the shell thinks. A bare shell state cannot
     distinguish "the session was lost" from "the shell has not adopted it yet", and those
     are completely different defects — one is data loss, the other is latency. */
  const after = await page.evaluate(async () => {
    const o = {
      path: location.pathname, hash: location.hash.replace('#', ''),
      state: window.SokoniShell.session.state, uid: window.SokoniShell.session.uid,
    };
    try {
      const { getApps, getApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      o.sdkUser = getApps().length ? ((getAuth(getApp()).currentUser || {}).uid || null) : 'no-app';
    } catch (e) { o.sdkUser = 'err'; }
    o.persisted = await new Promise((res) => {
      try {
        const rq = indexedDB.open('firebaseLocalStorageDb');
        rq.onsuccess = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains('firebaseLocalStorage')) return res(false);
          const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
          all.onsuccess = () => res((all.result || []).some((r) => /firebase:authUser:/.test(String(r && r.fbase_key))));
          all.onerror = () => res(false);
        };
        rq.onerror = () => res(false);
      } catch (e) { res(false); }
    });
    return o;
  }).catch((e) => ({ err: e.message }));

  /* Hosting runs cleanUrls:true, so a reload normalises /merchant-v2.html -> /merchant-v2.
     Comparing the literal path failed this row for a URL-shape reason with nothing wrong in
     the product — the documented trap: 'page.html' never matches after cleanUrls. */
  /* DERIVE the expected route from the walk. It was hardcoded to 'orders' and kept that
     value when the walk was reordered to end on 'pos', so this row failed while the shell
     had in fact restored the correct route — the path comparator was already cleanUrls-safe
     and was never the problem. An expectation that duplicates a value instead of reading it
     is a defect waiting for the next edit. */
  const expectedRoute = WALK[WALK.length - 1];
  const routeKept = samePage(after.path, PAGE) && after.hash === expectedRoute;
  L.refreshRoute = ck('refresh restored the same route', routeKept, JSON.stringify(after));
  /* The SESSION row splits, so a slow adoption is never reported as a lost session. */
  L.refreshSession = ck('the session itself survived the refresh',
    after.persisted === true && after.sdkUser === SESSION_UID, JSON.stringify(after));
  L.refresh = ck('the shell re-adopted the session after refresh',
    after.state === 'in' && after.uid === SESSION_UID, JSON.stringify(after));
  if (after.persisted && after.sdkUser === SESSION_UID && after.state !== 'in') {
    console.log('        ATTRIBUTION: the session is intact (persisted + SDK currentUser present) —');
    console.log('        the SHELL had not adopted it within the wait. That is adoption latency,');
    console.log('        not data loss, and it is a real finding about the shell rather than Auth.');
  }

  head('9 · console');
  const ours = pageErrors.filter((e) => e.stack.indexOf(BASE) >= 0 || /\/(sokoni|merchant)[-.]/.test(e.stack));
  const theirs = pageErrors.filter((e) => ours.indexOf(e) < 0);
  L.console = ck('no uncaught page errors in the shell attributable to SOKONI code',
    ours.length === 0, ours.slice(0, 3).map((e) => e.msg).join(' | '));
  ours.slice(0, 4).forEach((e) => { console.log('      ✗ ' + e.msg); console.log('        ' + (e.stack.split('\n')[1] || '').trim().slice(0, 120)); });
  if (preShellErrors.length) {
    console.log('  note — ' + preShellErrors.length + ' error(s) on the SIGN-IN page (index.html), not v2 defects:');
    preShellErrors.slice(0, 3).forEach((e) => console.log('      · ' + e.msg));
  }
  if (theirs.length) console.log('  note — ' + theirs.length + ' third-party error(s), not attributed to SOKONI.');

  await browser.close();
  closeServer();

  const M = (v) => (v === null ? 'UNPROVEN' : v ? 'PASS' : 'FAIL');
  console.log('\n\n\x1b[1mMERCHANT V2 — REAL SELLER CERTIFICATION\x1b[0m\n');
  console.log((MODE === 'production' ? 'PRODUCTION PATH  (real approved seller)' : 'CI PATH  (emulator identity + production App Check)'));
  console.log('────────────────────────────────────────');
  console.log('Authenticated session          ' + M(L.session));
  console.log('Shell adopted the session      ' + M(L.shellSession));
  console.log('sellerUid === auth uid         ' + M(L.sellerUid));
  console.log('Active shop resolved           ' + M(L.shop));
  console.log('Walk (' + WALK.length + ' transitions)         ' + M(L.walk));
  console.log('Transition invariants          ' + M(L.invariants) + '   uid + persisted record + shop, EVERY step');
  console.log('Single Firebase init           ' + M(L.singleInit));
  console.log('No document navigation         ' + M(L.noDocNav));
  console.log('No in-pane login               ' + M(L.noPaneLogin));
  console.log('Device registry intact         ' + M(L.deviceApi));
  console.log('Refresh keeps the route        ' + M(L.refreshRoute));
  console.log('Session survives refresh       ' + M(L.refreshSession));
  console.log('Shell re-adopts after refresh  ' + M(L.refresh));
  console.log('Shell console clean            ' + M(L.console));
  console.log('\nOWNED DATA');
  console.log('────────────────────────────────────────');
  console.log('Orders scoped to this seller   ' + M(L.ownOrders));
  console.log('Payments scoped to this seller ' + M(L.ownPayments));
  console.log('\nREQUIRES A HUMAN');
  console.log('────────────────────────────────────────');
  console.log('Printer survives the walk      DEVICE-MANUAL  (real hardware, real gesture)');
  console.log('\nRELEASE GATE');
  console.log('────────────────────────────────────────');
  const closed = MODE === 'production' && L.ownOrders && L.ownPayments && L.invariants && L.singleInit;
  console.log('"Real merchant can use v2"     ' + (closed ? 'PROVEN (pending the device signature)' : 'BLOCKED'));
  if (!closed) {
    console.log('Reason                         ' + (MODE === 'production'
      ? 'the production run did not satisfy every row — see above'
      : 'no approved production seller supplied to the harness'));
  }

  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  if (failures.length) { console.log(''); failures.forEach((f) => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { closeServer(); } catch (_) {} process.exit(2); });
