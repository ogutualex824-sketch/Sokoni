/* Shared fixture for the administrative-surface proofs.
   ==========================================================================
   WHAT IS STUBBED, AND WHY EXACTLY THIS MUCH

   Only the IDENTITY/CLAIM SOURCE, at the two boundaries the product code really
   reads:

     window.firebaseAuth.currentUser.getIdTokenResult   sokoni-permissions.js,
                                                        sokoni-role-authority.js
     firebase.auth()                                    the compat shim that the
                                                        admin.html / super-admin.html /
                                                        sokoni-aos.js gates read

   The first version of this fixture stubbed only window.firebaseAuth. Every one of
   the three gates calls firebase.auth() instead, so all three redirected — super-admin
   to login.html, admin and admin-os to the marketplace home — and the harness happily
   measured the WRONG DOCUMENTS. admin.html "rendered the shared marketplace header"
   because we were standing on the marketplace. Hence assertLanded() below: a proof
   that never checks which page it is on cannot tell a result from a redirect.

   Everything else is real: the real gates, the real sokoni-permissions.js, the real
   sokoni-role-authority.js, the real page code. Nothing signs in and no module is
   replaced.

   WHAT THIS CANNOT PROVE. Rendering and wiring, never authorization. Firestore rules
   and the admin callables are the boundary and are untouched here.
==========================================================================*/

/* Parameterised so the SAME harness can be pointed at a pre-change tree served on
   another port. A before/after pair is only worth anything if both halves are
   measured by identical code. */
export const ORIGIN = process.env.SK_ORIGIN || 'http://127.0.0.1:8901';

/* ONE init script, whose scenario is read from localStorage at run time.
   ==========================================================================
   Playwright has no removeInitScript: calling addInitScript per scenario STACKS
   them, so every previously-registered script still runs on every later
   navigation. That is not merely untidy — it re-seeds sokoniAdminContext on the
   page you navigate TO, which would silently mask the one assertion the
   SuperAdmin -> Buyer transition exists to make: that the administrative context
   is CLEARED rather than relabelled. The seed would put it straight back.

   So: register once, and change scenario by writing localStorage.

   The context seed is also nonce-guarded, and therefore applies to exactly the
   first navigation after setScenario(). Any later navigation — the one the switch
   itself performs — inherits whatever the product code left behind, which is the
   thing under test. */
export function installFixture(page) {
  return page.addInitScript(() => {
    let cfg = { claims: [], ctx: '', lsroles: ['buyer'], nonce: '0' };
    try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem('__fxCfg') || '{}')); }
    catch (_) {}

    const claimObj = {};
    (cfg.claims || []).forEach((c) => { claimObj[c] = true; });

    localStorage.setItem('loggedIn', 'true');
    localStorage.setItem('sokoniUser', JSON.stringify({
      uid: 'fx', name: 'Fixture Admin', email: 'fx@example.test',
      roles: cfg.lsroles, activeRole: 'buyer',
    }));
    try {
      if (cfg.ctx && sessionStorage.getItem('__fxCtxNonce') !== cfg.nonce) {
        sessionStorage.setItem('sokoniAdminContext', cfg.ctx);
        sessionStorage.setItem('__fxCtxNonce', cfg.nonce);
      } else if (!cfg.ctx) {
        sessionStorage.removeItem('sokoniAdminContext');
      }
    } catch (_) {}

    const user = {
      uid: 'fx', email: 'fx@example.test', displayName: 'Fixture Admin',
      /* the gates pass forceRefresh=true; the fixture is the token either way */
      getIdTokenResult: () => Promise.resolve({ claims: claimObj }),
      getIdToken: () => Promise.resolve('fixture-token'),
    };
    const stub = {
      currentUser: user,
      onAuthStateChanged: (cb) => {
        setTimeout(() => { try { cb(user); } catch (_) {} }, 0);
        return () => {};
      },
      signOut: () => Promise.resolve(),
    };

    /* firebase.js assigns window.firebaseAuth during load and would otherwise
       replace the fixture with the real signed-out auth midway through the page's
       own entry flow. A refusing setter keeps one answer for the page lifetime. */
    Object.defineProperty(window, 'firebaseAuth', {
      configurable: true, get: () => stub, set: () => {},
    });
    /* Non-null so setActiveRole reaches its write; the doubled Firestore module
       above decides what that write does. It is an opaque handle — nothing here
       reads from it, and getDoc answers "absent". */
    const dbStub = { __fixture: true };
    Object.defineProperty(window, 'firebaseDB', {
      configurable: true, get: () => dbStub, set: () => {},
    });

    /* The compat shim: let firebase.js install the real one, but always answer
       .auth() with the fixture. firestore()/functions() pass straight through so the
       pages boot normally (their reads fail on App Check, which is not what is under
       test here).

       MUST READ UNDEFINED UNTIL firebase.js ASSIGNS. firebase.js installs its shim
       behind `if (!window.firebase)`. The first version of this getter returned a
       Proxy unconditionally — always truthy — so that branch never ran and the shim
       was never built. firestore() and functions() were then undefined, super-admin
       and admin-os threw during their own boot, and the harness reported the profile
       button as missing on two pages where the real cause was that neither page had
       finished starting. */
    let realShim, proxy;
    Object.defineProperty(window, 'firebase', {
      configurable: true,
      get: () => {
        if (!realShim) return undefined;
        if (!proxy) {
          proxy = new Proxy(realShim, {
            get: (t, p) => (p === 'auth' ? () => stub : t[p]),
            has: (t, p) => (p === 'auth' ? true : p in t),
          });
        }
        return proxy;
      },
      set: (v) => { realShim = v; proxy = null; },
    });
  });
}

/* Change scenario. Requires being on the origin already — call primeOrigin() once. */
let _nonce = 0;
export async function setScenario(page, { claims = [], ctx = '', lsroles = ['buyer'] } = {}) {
  const cfg = { claims, ctx, lsroles, nonce: 'n' + (++_nonce) };
  await page.evaluate((c) => {
    localStorage.setItem('__fxCfg', JSON.stringify(c));
    try { sessionStorage.removeItem('__fxCtxNonce'); } catch (_) {}
  }, cfg);
  return cfg;
}

/* A neutral same-origin page, so setScenario has a localStorage to write to. */
export async function primeOrigin(page) {
  await page.goto(ORIGIN + '/offline.html', { waitUntil: 'domcontentloaded' });
}

/* ── The THIRD identity boundary, and why it needs a route ───────────────────
   admin.html resolves identity THREE different ways:

     1  _adminEnter()          window.firebaseAuth.currentUser
     2  SokoniAdminEntry       the same, via sokoni-permissions.js
     3  a module <script>      import { auth } from './firebase.js'
                               onAuthStateChanged(auth, ...)   <- module-scoped

   (3) is a module-scoped import binding. No page-level global can reach it, so the
   only way to give it a fixture identity is to serve a fixture firebase.js. That is
   a genuine test double for the identity provider — heavier than stubbing a global,
   and the reason it is opt-in rather than always on: super-admin.html and admin-os.html
   read firebase.auth() and need the REAL firebase.js compat shim to boot.

   That admin.html carries three independent auth resolvers is a real finding about
   the page, not an artefact of the harness. It is recorded here rather than fixed:
   consolidating them is its own slice with its own before-proof.

   Everything this serves is inert — no app, no db. The page's data layer therefore
   does not load, so any row about admin.html CONTENT would be measuring the harness.
   Only the chrome (header, profile button, menu, sign-out) is asserted under it. */
export async function stubFirebaseModule(page) {
  const REAL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
  const FS = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  /* ── Why the Firestore module is doubled too ─────────────────────────────
     setActiveRole() PERSISTS the selection before it takes effect locally:

         await setDoc(doc(db, 'users', uid), { activeRole: r }, { merge: true })
         _setActiveLocal(r)     <- dispatches sokoniActiveRoleChanged
                                <- which is what CLEARS the admin context

     With window.firebaseDB null it returned {ok:false, reason:'db-unavailable'},
     so the SuperAdmin -> Buyer transition never ran and the context stayed put.
     That reads exactly like the defect the transition test is looking for, and is
     not one: _setActiveLocal dispatches unconditionally, with no equality guard.

     So the write is made to succeed locally. getDoc answers "absent" so no role
     can be conjured from a document — the claims stay the only source of
     entitlement, which is the property under test. */
  await page.route(FS, (route) => {
    if (route.request().url().includes('__sk=real')) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: [
        'export * from "' + FS + '?__sk=real";',
        'export function doc(db, col, id) { return { __fx: true, path: col + "/" + id }; }',
        'export function setDoc(ref, data) {',
        '  try { window.__fxWrites = (window.__fxWrites || []).concat([{ ref: ref, data: data }]); }',
        '  catch (_) {}',
        '  return Promise.resolve();',
        '}',
        'export function getDoc() { return Promise.resolve({ exists: function () { return false; },',
        '                                                    data: function () { return {}; } }); }',
      ].join('\n'),
    });
  });

  /* ONLY admin.html. super-admin.html and admin-os.html read firebase.auth() from the
     compat shim that the REAL firebase.js installs; serving them this inert module
     removed firestore()/functions(), so their own boot threw before it ever reached the
     profile menu — which the harness then reported as a missing button. Scope the
     double to the one page whose third resolver actually needs it. */
  await page.route('**/firebase.js', (route) => {
    if (!route.request().frame().url().includes('/admin.html')) return route.continue();
    return route.fulfill({
    status: 200,
    contentType: 'application/javascript; charset=utf-8',
    body: [
      '/* fixture firebase.js — identity only, everything else inert */',
      'const auth = window.firebaseAuth;',
      'const app = null, db = null, storage = null, messaging = null;',
      'async function sokoniRequestPushPermission() { return null; }',
      'function sokoniListenMessages() { return function () {}; }',
      'try { document.dispatchEvent(new CustomEvent("sokoniFirebaseReady")); } catch (_) {}',
      'export { app, auth, db, storage, messaging,',
      '         sokoniRequestPushPermission, sokoniListenMessages };',
    ].join('\n'),
    });
  });

  /* The real modular onAuthStateChanged asserts its argument is a real AuthImpl and
     would throw on the fixture — leaving admin.html's body permanently hidden, which
     is a harness failure that looks exactly like a product one. Re-export the real
     module and override that ONE function. A local declaration wins over `export *`. */
  await page.route(REAL, (route) => {
    if (route.request().url().includes('__sk=real')) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: [
        'export * from "' + REAL + '?__sk=real";',
        'export function onAuthStateChanged(a, cb) {',
        '  try { return a.onAuthStateChanged(cb); }',
        '  catch (_) { try { cb((a && a.currentUser) || null); } catch (__) {} return function () {}; }',
        '}',
      ].join('\n'),
    });
  });
}

/* A proof that does not check where it landed cannot tell a result from a redirect. */
export function assertLanded(page, file) {
  const url = page.url();
  const landed = url.split('?')[0].split('/').pop();
  return { ok: landed === file || landed === file.replace(/\.html$/, ''), landed, url };
}

export async function open(page, file, { wait = 3500 } = {}) {
  await page.goto(ORIGIN + '/' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  return assertLanded(page, file);
}

/* One reader, so before and after measure the same things the same way. */
export const READ = String.raw`(function () {
  function txt(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function vis(el) {
    if (!el) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  var out = {};
  out.landed        = location.pathname.split('/').pop();
  out.sharedHeader  = !!document.getElementById('sk-top-nav');
  out.sharedAvatar  = !!document.getElementById('sk-nav-avatar');
  out.profileBtn    = vis(document.getElementById('sk-admin-profile'));
  out.menuExists    = !!document.getElementById('sk-admin-profile-menu');
  out.menuOpen      = vis(document.getElementById('sk-admin-profile-menu'));
  out.legacyBar     = !!document.getElementById('sk-admin-controls');
  out.legacySelect  = !!document.getElementById('sk-admin-role');
  out.deny          = !!document.getElementById('sk-admin-deny');
  out.denyTitle     = (document.querySelector('#sk-admin-deny h1') || {}).textContent || null;
  out.bodyChars     = (document.body.innerText || '').length;
  /* The page's OWN admission signal. bodyChars was standing in for it and is a poor
     proxy: under the fixture no data loads, so a correctly-open super-admin console
     renders ~1k characters of chrome and a threshold on length calls that a failure. */
  out.authGateShown = vis(document.getElementById('authGate'))
                   || vis(document.getElementById('adminLock'));

  /* Every VISIBLE control whose label is a sign-out — OURS INCLUDED, so a duplicate
     is counted rather than assumed away.

     The first version anchored on /^sign\s*out$/i and so did not match our own
     "↩ Sign out": the count came back 0 and the row read as "no sign-out on the
     surface" when the truth was "one, and the probe could not see it". Strip
     leading/trailing non-letters before matching, and record WHOSE each one is —
     "exactly one" is only the right answer if that one is ours. */
  out.signOuts = Array.prototype.filter.call(
    document.querySelectorAll('button, a'),
    function (el) {
      var t = txt(el).replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
      return /^sign\s*out$/i.test(t) && vis(el);
    }
  ).map(function (el) {
    return (el.hasAttribute('data-sk-signout') ? 'OURS:' : 'PAGE:')
      + (el.id || el.className || el.tagName);
  });
  out.signOutsOurs = out.signOuts.filter(function (s) { return s.indexOf('OURS:') === 0; }).length;
  out.signOutsPage = out.signOuts.length - out.signOutsOurs;

  var m = document.getElementById('sk-admin-profile-menu');
  out.workspace = []; out.admin = []; out.adminCurrent = null;
  if (m) {
    var cs = getComputedStyle(m);
    out.overflowY = cs.overflowY; out.maxHeight = cs.maxHeight;
    out.scrollH = m.scrollHeight; out.clientH = m.clientHeight;
    var b = m.getBoundingClientRect();
    out.rect = { l: Math.round(b.left), r: Math.round(b.right),
                 t: Math.round(b.top), b: Math.round(b.bottom),
                 vw: window.innerWidth, vh: window.innerHeight };
    Array.prototype.forEach.call(m.querySelectorAll('[data-sk-workspace]'), function (el) {
      out.workspace.push(el.getAttribute('data-sk-workspace'));
    });
    Array.prototype.forEach.call(m.querySelectorAll('[data-sk-admin]'), function (el) {
      out.admin.push(el.getAttribute('data-sk-admin'));
      if (el.classList.contains('is-current')) out.adminCurrent = el.getAttribute('data-sk-admin');
    });
  }

  var P = window.SokoniPermissions, RA = window.SokoniRoleAuthority;
  out.entryLoaded = !!window.SokoniAdminEntry;
  out.verified    = !!(P && P.isVerified && P.isVerified());
  out.hasAdmin    = !!(P && P.hasRole && P.hasRole('admin'));
  out.hasSuper    = !!(P && P.hasRole && P.hasRole('superAdmin'));
  out.ctx         = (P && P.getAdminContext) ? P.getAdminContext() : undefined;
  out.approved    = (RA && RA.getApprovedRoles) ? RA.getApprovedRoles() : undefined;
  out.active      = (RA && RA.getActiveRole) ? RA.getActiveRole() : undefined;
  out.ssCtx       = (function () { try { return sessionStorage.getItem('sokoniAdminContext'); }
                                   catch (_) { return 'ERR'; } }());
  document.documentElement.setAttribute('data-p', JSON.stringify(out));
}());`;

export async function read(page) {
  await page.addScriptTag({ content: READ });
  return JSON.parse(await page.getAttribute('html', 'data-p'));
}
