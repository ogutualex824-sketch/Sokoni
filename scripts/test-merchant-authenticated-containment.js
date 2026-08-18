#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT AUTHENTICATED CONTAINMENT GATE — all 31 destinations, real session
   ------------------------------------------------------------------------------
   The unauthenticated gate (test-merchant-route-gate.js --all) proves the SHELL
   mounts the right module. It cannot prove the module WORKS, because every embedded
   destination it walks is being viewed by a logged-out browser. Measured: the seller
   iframe renders the login page, document.title = "Log In to SOKONI".

   This gate establishes the whole chain before it asserts anything:

       App Check attested
             ↓
       authenticated (REAL production session)
             ↓
       seller entitlement / approval
             ↓
       canonical shop resolved
             ↓
       /merchant#route
             ↓
       correct Merchant body
             ↓
       real authenticated data

   WHY ATTESTATION IS A PRECONDITION, NOT A NICETY
   Without an App Check token every Firestore read resolves as
   `size=0, fromCache=true` — an EMPTY CACHE HIT that does not throw. A gate run
   unattested would see zeroes everywhere and report them as data. So this suite
   refuses to run unattested rather than produce confident nonsense.

   CREDENTIALS ARE NEVER STORED HERE
   All three inputs come from the environment, are never defaulted, and are never
   echoed. A missing input SKIPS loudly — it never degrades into a weaker run that
   could be mistaken for a pass.

     APPCHECK_DEBUG_TOKEN   registered per docs/APPCHECK_DEBUG_TOKEN_LEDGER.md
     MERCHANT_EMAIL         an APPROVED merchant account
     MERCHANT_PASSWORD

   THIS IS A HARNESS RESULT, NOT PRODUCTION VERIFICATION. It drives a local server
   against production data. The real-phone run on the production account is a
   separate gate and this suite never claims to replace it.

     node scripts/test-merchant-authenticated-containment.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

const TOKEN    = process.env.APPCHECK_DEBUG_TOKEN || '';
const EMAIL    = process.env.MERCHANT_EMAIL || '';
const PASSWORD = process.env.MERCHANT_PASSWORD || '';

/* ── Loud skip. A gate that vanishes quietly is worse than one that fails. ──── */
if (!TOKEN || !EMAIL || !PASSWORD) {
  const miss = [!TOKEN && 'APPCHECK_DEBUG_TOKEN', !EMAIL && 'MERCHANT_EMAIL',
                !PASSWORD && 'MERCHANT_PASSWORD'].filter(Boolean);
  console.log('\n' + '='.repeat(74));
  console.log('  SKIPPED — NOT A PASS. NOTHING WAS PROVEN.');
  console.log('='.repeat(74));
  console.log('  Missing: ' + miss.join(', '));
  console.log('\n  This suite refuses to run without all three, because a run without');
  console.log('  attestation reads an EMPTY CACHE that does not throw — every assertion');
  console.log('  would see zero rows and could be misread as real data.');
  console.log('\n  PowerShell:');
  console.log('    $env:APPCHECK_DEBUG_TOKEN = "<value>"   # see docs/APPCHECK_DEBUG_TOKEN_LEDGER.md');
  console.log('    $env:MERCHANT_EMAIL       = "<approved merchant email>"');
  console.log('    $env:MERCHANT_PASSWORD    = "<password>"');
  console.log('    node scripts/test-merchant-authenticated-containment.js');
  console.log('='.repeat(74) + '\n');
  process.exit(0);
}

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml',
  '.jpg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

const VIEWPORT = { width: 393, height: 852 };          /* iPhone 14 Pro */
const TARGETS  = C.ROUTES.filter(r => r.kind !== 'exit');

let pass = 0, fail = 0;
const failures = [];
let curRoute = '—';

/* Same three buckets as the unauthenticated gate, same rule: an unmatched failure
   is UNPROVEN, never ENV. Nothing here suppresses a failure or removes it from the
   total — classification is an additional report over identical numbers. */
const CLASSIFY = [
  { bucket:'ENV',  re:/is not allowed by Access-Control-Allow-Origin|\/api\/[a-z-]+.*404/i,
    why:'the harness serves static files from an ephemeral loopback origin and implements no /api routes.' },
  { bucket:'REAL', re:/Can't find variable|is not defined|is not a function|Cannot read propert/i,
    why:'a JavaScript error inside SOKONI code.' },
  { bucket:'REAL', re:/login page|customer app|onboarding|duplicate|blank/i,
    why:'a containment violation: the destination rendered something other than the merchant body.' },
];
const classify = (t) => CLASSIFY.find(c => c.re.test(t || '')) ||
  { bucket:'UNPROVEN', why:'no classification rule matched; defaulting to UNPROVEN rather than assuming environment.' };

const ck = (label, ok, detail) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).replace(/\s+/g,' ').slice(0,110) + ']' : ''));
  if (ok) pass++;
  else {
    fail++;
    const c = classify(label + ' ' + (detail || ''));
    failures.push({ route: curRoute, label, detail: String(detail || '').slice(0,160), bucket: c.bucket, why: c.why });
  }
  return ok;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('\nWATCHDOG — exceeded 15 min'); process.exit(1); }, 900000);
wd.unref && wd.unref();

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message)); server.close(); process.exit(0); return; }

  const ctx = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  /* firebase.js:122 reads this key BEFORE it initialises App Check. */
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); } catch (e) {}
  }, TOKEN);

  const page = await ctx.newPage();
  let routeErrors = [];
  const ENV_NOISE = /favicon|net::ERR|frame-ancestors|report-only/i;
  page.on('console', m => { if (m.type() === 'error' && !ENV_NOISE.test(m.text())) routeErrors.push(m.text().slice(0,170)); });
  page.on('pageerror', e => { if (!ENV_NOISE.test(String(e.message))) routeErrors.push('PAGEERROR: ' + String(e.message).slice(0,170)); });

  console.log('\n' + '='.repeat(74));
  console.log('  MERCHANT AUTHENTICATED CONTAINMENT GATE');
  console.log('  ' + TARGETS.length + ' destinations · ' + VIEWPORT.width + '×' + VIEWPORT.height + ' · PRODUCTION data');
  console.log('='.repeat(74));

  /* ── 1 · attestation ─────────────────────────────────────────────────────────
     Attested and signed in on /index.html, NOT on /merchant.html — because the
     merchant shell document has no Firebase client at all. Measured: merchant.html
     carries no firebase.js script tag, none of its 31 loaded scripts calls
     initializeApp, and after 12s in the shell `window.firebaseApp`,
     `window.firebaseDB`, `window.firebase` and `window.__sokoniAppCheckState` are all
     absent. Only firebase.js sets those, and the shell never loads it.

     Signing in here would therefore always fail, and would look like a credentials
     problem rather than an architecture one. Firebase Auth persists per-ORIGIN in
     IndexedDB, so establishing the session on a page that does boot Firebase carries
     it to /merchant and to every same-origin iframe the shell mounts — which is also
     the order a real merchant arrives in: log in, then open the workspace. */
  head('1 · App Check attested (precondition) — on a page that boots Firebase');
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
  await page.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(4000);
  const acState = await page.evaluate(() => window.__sokoniAppCheckState);
  if (!ck('App Check exchanged (not rejected/pending)', acState === 'exchanged', 'state=' + acState)) {
    console.log('\n  ABORTING — unattested reads return empty CACHE hits that do not throw.');
    console.log('  Continuing would report zeroes as data. Fix attestation, then re-run.\n');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }

  /* ── 2 · real production session ─────────────────────────────────────────── */
  head('2 · authenticated with a REAL production session');
  const auth = await page.evaluate(async ({ email, password }) => {
    try {
      const [{ getApps, getApp }, A] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
      ]);
      if (!getApps().length) return { ok:false, why:'no Firebase app in the 10.12.2 registry' };
      const a = A.getAuth(getApp());
      const cred = await A.signInWithEmailAndPassword(a, email, password);
      const uid = cred.user.uid;
      const tok = await cred.user.getIdTokenResult().catch(() => null);
      return { ok:true, uid, claims: tok ? tok.claims : null };
    } catch (e) { return { ok:false, why:(e && (e.code || e.message)) || String(e) }; }
  }, { email: EMAIL, password: PASSWORD }).catch(e => ({ ok:false, why:'evaluate rejected: ' + (e && e.message) }));

  if (!ck('signed in against production', auth.ok, auth.ok ? 'uid=' + auth.uid : auth.why)) {
    console.log('\n  ABORTING — no session, so nothing below would test an approved merchant.\n');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }

  /* ── 3 · entitlement + canonical shop ────────────────────────────────────── */
  head('3 · seller entitlement, approval, canonical shop');
  /* The canonical claim shape is set by functions/role-authority.js: an approved seller
     gets `claims.seller = true` (line 116) and `roles: ['seller']`; `role` is a STRING
     ("superAdmin"), never a number. The previous assertion read `claims.role || claims.roles`
     and reported `claims.role=5`, which is neither — it was reading the wrong field and
     printing a value that means nothing in this scheme. Dump the real custom claims so the
     account's actual authority is visible, and assert the shape the platform really mints. */
  const claims = auth.claims || {};
  const STD = ['iss','aud','auth_time','user_id','sub','iat','exp','email','email_verified',
               'firebase','phone_number','name','picture'];
  const custom = {};
  Object.keys(claims).forEach((k) => { if (STD.indexOf(k) === -1) custom[k] = claims[k]; });
  console.log('    NOTE  custom claims: ' + (Object.keys(custom).length ? JSON.stringify(custom) : '(none)'));

  const rolesArr = Array.isArray(claims.roles) ? claims.roles : [];
  const hasAuthority = claims.seller === true || claims.merchant === true ||
                       claims.admin === true || claims.superAdmin === true ||
                       rolesArr.some((r) => /seller|merchant|admin/i.test(String(r))) ||
                       (typeof claims.role === 'string' && /seller|merchant|admin/i.test(claims.role));
  ck('account carries a seller/merchant authority claim', hasAuthority,
     'seller=' + claims.seller + ' merchant=' + claims.merchant + ' admin=' + claims.admin +
     ' roles=' + JSON.stringify(claims.roles) + ' role=' + JSON.stringify(claims.role));

  /* Carry the session into the workspace. */
  await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
  await page.waitForTimeout(9000);

  /* The shell's Firebase reality, recorded rather than assumed. This is informational,
     not an assertion: if the shell legitimately delegates all data to its modules then
     `false` here is by design, and the assertion that matters is the shop context below.
     Recorded because every callable in this file — posCompleteCheckout,
     merchantAdjustStock, the 5 Staff, 8 Marketing and 3 Disputes callables — is guarded
     on `window.firebaseApp` and throws "SOKONI is still starting up" without it. */
  const shellFb = await page.evaluate(() => ({
    app: !!window.firebaseApp, db: !!window.firebaseDB, glob: typeof window.firebase,
  }));
  console.log('    NOTE  shell document Firebase: app=' + shellFb.app +
              ' db=' + shellFb.db + ' global=' + shellFb.glob +
              (shellFb.app ? '' : '  ← every _callable() in merchant.html is guarded on window.firebaseApp'));

  const shopCtx = await page.evaluate(() => ({
    activeShopId: (window.SokoniShell || {}).activeShopId || null,
    branch: (window.SokoniBranch || {}).activeShopId || null,
  }));
  const shopId = shopCtx.activeShopId || shopCtx.branch;
  ck('canonical shop resolved into the shell', !!shopId, 'activeShopId=' + shopId);
  /* The unauthenticated run showed "No shop is active yet" on #staff — an honest guard
     that fires BEFORE any callable, masking whether the callable path works. If the shop
     resolves and that text is gone, the mask is lifted and section 4 tests the real thing. */

  /* ── 4 · containment across every destination ────────────────────────────── */
  head('4 · containment across all ' + TARGETS.length + ' destinations');

  for (const route of TARGETS) {
    const id = route.id;
    curRoute = id;
    console.log('\n  ── ' + route.name.toUpperCase() + '  (#' + id + ') ──');
    routeErrors = [];

    if (route.tier === 'hidden') await page.evaluate(r => { location.hash = r; }, id);
    else {
      const clicked = await page.evaluate(r => {
        const el = document.querySelector('.mnav-item[data-id="' + r + '"]');
        if (!el) return false; el.click(); return true;
      }, id);
      if (!ck('sidebar button exists and was clicked', clicked)) continue;
    }
    await page.waitForTimeout(id === 'dashboard' ? 2000 : 4200);

    const st = await page.evaluate(() => {
      const shown = [].filter.call(document.querySelectorAll('.mpanel'), p => p.classList.contains('show'));
      const s = shown[0] || null;
      const ifr = s ? s.querySelector('iframe') : null;
      const nat = s ? s.querySelector('.native') : null;
      const out = {
        shownCount: shown.length,
        shellHeaders: document.querySelectorAll('header.mtop').length,
        shellNavs: document.querySelectorAll('nav#mbnav, nav.mbnav').length,
        panelKind: ifr ? 'iframe' : nat ? 'native' : 'empty',
        iframeId: ifr ? ifr.id : null,
        iframeSrc: ifr ? ifr.getAttribute('src') : null,
        nativeId: nat ? nat.id : null,
        url: location.href,
      };
      /* Body content + containment signals, reaching INTO the iframe (same origin). */
      let doc = null, where = 'native';
      if (ifr) { try { doc = ifr.contentDocument; where = 'iframe'; } catch (e) { doc = null; } }
      else if (nat) { doc = document; }
      if (!doc) { out.readable = false; return out; }
      out.readable = true;
      const scope = where === 'iframe' ? doc.body : (nat || doc.body);
      const text = (scope.innerText || '').replace(/\s+/g, ' ').trim();
      out.textLen = text.length;
      out.textHead = text.slice(0, 180);
      out.title = doc.title || '';
      /* Containment probes */
      /* A password input is NOT evidence of a login page. POS carries several by design —
         4-digit cashier PINs and the M-Pesa consumer secret / passkey fields — so the bare
         `input[type=password]` check reported the POS workspace as a login screen while the
         body plainly read "KASS SHOP … DEVICES … Add Device". Identity comes from what the
         document SAYS it is: its title, or login copy at the top of the body. */
      out.loginMarkers   = /log in to sokoni|sign in to continue|welcome back/i.test(text.slice(0, 700))
                        || /^log ?in|sign ?in/i.test(out.title);
      out.onboardMarkers = /become a seller|start selling|apply to sell|create your shop|seller application/i.test(text.slice(0, 900));
      out.custHeaders    = doc.querySelectorAll('#sk-top-nav, .sk-top-nav, header.sk-header').length;
      out.custNavs       = doc.querySelectorAll('#sk-bottom-nav, .sk-bottom-nav, nav.sk-bottomnav').length;
      out.childShellHdr  = where === 'iframe' ? doc.querySelectorAll('header.mtop').length : 0;
      out.childShellNav  = where === 'iframe' ? doc.querySelectorAll('nav#mbnav, nav.mbnav').length : 0;
      out.errorSurface   = /something went wrong|failed to load|unable to load|an error occurred/i.test(text.slice(0, 500));
      return out;
    });

    /* THE SHELL SURVIVES */
    ck('merchant shell intact (exactly one header + one bottom nav)',
       st.shellHeaders === 1 && st.shellNavs === 1, 'hdr=' + st.shellHeaders + ' nav=' + st.shellNavs);
    /* BOTH forms are the merchant workspace. firebase.json sets cleanUrls:true, so the
       shell legitimately runs at /merchant as often as /merchant.html — and this suite
       reaches it through a bounce that guarantees the clean form: auth-guard.js redirects
       to login.html?next=… when localStorage.loggedIn is unset (which it is here, because
       the session is established through the SDK rather than the login form), and login
       returns to the cleanUrl path. Asserting only '/merchant.html' failed all 31
       destinations for being at the correct URL.
       The property being tested is "we did not leave the workspace", so it is spelled that
       way: escaping to /login or /index still fails, which is the case that matters. */
    const bare = st.url.split('#')[0].split('?')[0];
    ck('still inside /merchant (no full-page navigation)',
       /\/merchant(\.html)?$/.test(bare), st.url.replace(BASE, ''));
    ck('exactly one panel visible', st.shownCount === 1, String(st.shownCount));

    /* THE RIGHT BODY */
    let modOk = false, modDetail = st.iframeSrc || st.nativeId || st.panelKind;
    if (route.kind === 'native')      modOk = st.panelKind === 'native' && st.nativeId === 'native-' + id;
    else if (route.kind === 'pos')    modOk = st.iframeId === 'mfx-pos';
    else if (route.kind === 'seller') modOk = st.iframeId === 'mfx-seller';
    else if (route.kind === 'page')   modOk = !!st.iframeSrc && st.iframeSrc.split('?')[0] === route.src.split('?')[0];
    ck('correct module mounted (' + route.kind + ')', modOk, modDetail);

    if (!st.readable) { ck('body readable for containment inspection', false, 'cross-origin or missing document'); continue; }

    /* CONTAINMENT — the seven properties */
    ck('no login page in the merchant body', !st.loginMarkers, st.loginMarkers ? 'login markers: "' + st.textHead.slice(0,90) + '"' : 'clean');
    ck('no customer app shell (index.html) inside the body',
       st.custHeaders === 0 && st.custNavs === 0, 'custHdr=' + st.custHeaders + ' custNav=' + st.custNavs);
    ck('no seller application/onboarding for an approved merchant',
       !st.onboardMarkers, st.onboardMarkers ? 'onboarding markers: "' + st.textHead.slice(0,90) + '"' : 'clean');
    ck('no duplicate merchant navigation inside the child',
       st.childShellHdr === 0 && st.childShellNav === 0, 'childHdr=' + st.childShellHdr + ' childNav=' + st.childShellNav);
    ck('no blank surface', st.textLen > 40, 'textLen=' + st.textLen + (st.textLen <= 40 ? ' "' + st.textHead + '"' : ''));
    ck('no error surface', !st.errorSurface, st.errorSurface ? st.textHead.slice(0,90) : 'clean');
    ck('no route/console error', routeErrors.length === 0, routeErrors[0] || 'clean');
  }

  /* ── 5 · authorization still enforced ────────────────────────────────────── */
  head('5 · authorization is still enforced (attestation is not authorization)');
  const authz = await page.evaluate(async () => {
    try {
      const [{ getApp }, F] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
      ]);
      const db = F.getFirestore(getApp());
      /* A signed-in merchant must NOT be able to list the whole users collection. */
      const s = await F.getDocs(F.query(F.collection(db, 'users'), F.limit(2)));
      return { denied:false, size:s.size, fromCache:s.metadata.fromCache };
    } catch (e) { return { denied:true, code:(e && e.code) || '' }; }
  });
  ck('a merchant session cannot list all users', authz.denied === true,
     authz.denied ? authz.code : 'READ SUCCEEDED size=' + authz.size + ' fromCache=' + authz.fromCache);

  /* ── report ──────────────────────────────────────────────────────────────── */
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (' + TARGETS.length + ' destinations, authenticated)');
  console.log('='.repeat(74));

  if (failures.length) {
    const ORDER = ['REAL','UNPROVEN','ENV'];
    const ICON = { REAL:'🔴', UNPROVEN:'🟡', ENV:'🟢' };
    failures.length && console.log('\n  FAILURE CLASSIFICATION (none suppressed)');
    ORDER.forEach(b => {
      const inB = failures.filter(f => f.bucket === b);
      if (!inB.length) return;
      console.log('\n' + ICON[b] + '  ' + b + '  ×' + inB.length);
      const seen = {};
      inB.forEach(f => {
        const k = f.route + '|' + f.label;
        if (seen[k]) return; seen[k] = 1;
        console.log('     · ' + f.route + ' — ' + f.label);
        if (f.detail) console.log('       ' + f.detail.replace(/\s+/g,' ').slice(0,130));
      });
    });
    const n = b => failures.filter(f => f.bucket === b).length;
    console.log('\n  REAL ' + n('REAL') + '  ·  UNPROVEN ' + n('UNPROVEN') + '  ·  ENV ' + n('ENV') + '  ·  TOTAL ' + fail);
  }
  console.log('\n  NOTE: harness result against production DATA. NOT production verification —');
  console.log('  the real-phone run on the production account and shop remains outstanding.\n');

  clearTimeout(wd);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
});
