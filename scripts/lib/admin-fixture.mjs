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
    let cfg = { claims: [], ctx: '', lsroles: ['buyer'], permCache: null,
                tokenDelayMs: 0, nonce: '0' };
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

    /* ── Seeding the permissions cache, to make the verification race reachable ──
       sokoni-permissions.js init() reads sessionStorage.sokoniPermCache and assigns
       _claimsVerified = cached.claimsVerified, while _verifiedThisLoad deliberately
       stays false until a signed token is read. That gap is the race: isVerified()
       answers true, hasRole(elevated) answers false, and anything consulting
       getAdminContext() in between used to erase the context.

       It is not an exotic state — it is what a returning user has on every
       page-to-page navigation within five minutes. Seeding it makes the window
       reachable on demand instead of by luck; polling for it hit the window on some
       loads and not others, which is what made the earlier harness swing. */
    try {
      if (cfg.permCache && cfg.permCache.length) {
        sessionStorage.setItem('sokoniPermCache', JSON.stringify({
          roles: cfg.permCache, claimsVerified: true, ts: Date.now(),
        }));
      } else if (cfg.permCache === null) {
        sessionStorage.removeItem('sokoniPermCache');
      }
    } catch (_) {}

    const user = {
      uid: 'fx', email: 'fx@example.test', displayName: 'Fixture Admin',
      /* the gates pass forceRefresh=true; the fixture is the token either way */
      /* A real token ROUND-TRIPS. Resolving instantly is the unrealistic part, and it
         made the verification window between _claimsVerified (cache, immediate) and
         _verifiedThisLoad (token, later) too small to land in reliably — the race
         control flipped run to run. A delay restores the window to a realistic width;
         it does not create it. */
      getIdTokenResult: () => new Promise((res) => {
        if (!cfg.tokenDelayMs) return res({ claims: claimObj });
        setTimeout(() => res({ claims: claimObj }), cfg.tokenDelayMs);
      }),
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

    /* ── Publishing authority state to the DOM ────────────────────────────
       Production serves a strict nonce-based CSP, so page.addScriptTag is blocked
       there — the reader came back null and the run died on the first assertion.
       page.evaluate is not blocked, but it runs in an ISOLATED WORLD and cannot see
       window.SokoniPermissions at all.

       So the main world publishes what it knows to an attribute, and the isolated
       world reads the attribute. addInitScript is injected over CDP before page
       scripts and is not subject to CSP, which is why this hook survives where an
       injected <script> does not.

       It only ever READS the authorities. It cannot grant anything.

       getAdminContext() IS NOT CALLED HERE, AND MUST NOT BE. It is named like a read
       and is not one: it re-checks hasRole(ctx) and, when that is false, clears the
       context AND ERASES ITS sessionStorage MIRROR.

       There is a window on every load where that check is false through no fault of
       the context. isVerified() returns _claimsVerified, which _readCache() sets true
       from the sessionStorage cache; hasRole() on an elevated role additionally
       demands _verifiedThisLoad, which is in-memory only and stays false until the
       token round-trips. Between those two moments getAdminContext() destroys the
       context it was asked about.

       Polling it here therefore erased the seeded context mid-load, and did so
       intermittently — the harness swung 32/0, 31/1, 22/10, 23/9 across runs, with
       later scenarios failing more often because the cache was warmer. Gating the call
       on isVerified() narrowed the window without closing it, because isVerified() is
       precisely the flag that goes true too early.

       So: publish PURE reads only. The context is taken from the raw sessionStorage
       mirror in the isolated world, and from the `is-current` mark the product itself
       renders — which is the stronger signal anyway, being the one a user can see.

       (No product code sits in that window today: all three getAdminContext callers
       render a dropdown on a human click, long after the round-trip. Latent, not live
       — but it is a real sharp edge in an API named like an accessor.) */
    setInterval(() => {
      try {
        const P = window.SokoniPermissions, RA = window.SokoniRoleAuthority;
        document.documentElement.setAttribute('data-sk-authstate', JSON.stringify({
          entryLoaded: !!window.SokoniAdminEntry,
          verified: !!(P && P.isVerified && P.isVerified()),
          hasAdmin: !!(P && P.hasRole && P.hasRole('admin')),
          hasSuper: !!(P && P.hasRole && P.hasRole('superAdmin')),
          approved: (RA && RA.getApprovedRoles) ? RA.getApprovedRoles() : undefined,
          active: (RA && RA.getActiveRole) ? RA.getActiveRole() : undefined,
          canonical: (RA && RA.CANONICAL_ROLES) ? RA.CANONICAL_ROLES : undefined,
          hubs: (RA && RA.WORKSPACE_HUBS) ? RA.WORKSPACE_HUBS : undefined,
        }));
      } catch (_) {}
    }, 250);
  });
}

/* Change scenario. Requires being on the origin already — call primeOrigin() once. */
let _nonce = 0;
export async function setScenario(page,
  { claims = [], ctx = '', lsroles = ['buyer'], permCache = null, tokenDelayMs = 0 } = {}) {
  const cfg = { claims, ctx, lsroles, permCache, tokenDelayMs, nonce: 'n' + (++_nonce) };
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
  /* Matches /admin AND /admin.html, and NOT /admin-os. Production sets cleanUrls, so
     /admin.html 301s to /admin — an .includes('/admin.html') check therefore never
     matched there, admin.html got the REAL signed-out auth, and the run measured the
     marketplace home while reporting on the admin console. The same class of mistake
     the landed-URL control exists to catch, one layer lower down. */
  const IS_ADMIN_PAGE = /\/admin(\.html)?(\?|#|$)/;
  await page.route('**/firebase.js', (route) => {
    if (!IS_ADMIN_PAGE.test(route.request().frame().url())) return route.continue();
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
/* ONE reader, so before and after measure the same things the same way.
   Runs via page.evaluate, NOT addScriptTag: production's nonce CSP blocks an injected
   <script>, and the first production run died on a null read because of it. evaluate()
   lives in an isolated world, so anything needing main-world globals comes from the
   data-sk-authstate attribute the fixture publishes. */
export function readFn() {
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

  /* Every VISIBLE control whose label is a sign-out — OURS INCLUDED, so a duplicate is
     counted rather than assumed away. Anchored on the label with leading/trailing
     non-letters stripped: an unanchored whole-label match alone did not catch our own
     "↩ Sign out", so the count came back 0 and read as "no sign-out on the surface"
     when the truth was "one, and the probe could not see it". Record WHOSE each one
     is — "exactly one" is only the right answer if that one is ours. */
  out.signOuts = Array.prototype.filter.call(
    document.querySelectorAll('button, a'),
    function (el) {
      var t = txt(el).replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z]+$/, '');
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

  /* Main-world state, smuggled through the DOM by the fixture. */
  var st = {};
  try { st = JSON.parse(document.documentElement.getAttribute('data-sk-authstate') || '{}'); }
  catch (_) {}
  out.entryLoaded = !!st.entryLoaded;
  out.verified    = !!st.verified;
  out.hasAdmin    = !!st.hasAdmin;
  out.hasSuper    = !!st.hasSuper;
  /* deliberately NOT st.ctx: see the publisher. The context is observed through the
     raw mirror below and through the product-rendered is-current mark. */
  out.approved    = st.approved;
  out.active      = st.active;
  out.authStateSeen = document.documentElement.hasAttribute('data-sk-authstate');
  out.ssCtx       = (function () { try { return sessionStorage.getItem('sokoniAdminContext'); }
                                   catch (_) { return 'ERR'; } }());
  return out;
}

export async function read(page) {
  return page.evaluate(readFn);
}

/* Clicking through evaluate for the same CSP reason. */
export async function clickSel(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
}
