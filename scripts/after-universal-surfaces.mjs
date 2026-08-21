/* PROOF — Home and Profile are universal authenticated surfaces.
   ==========================================================================
   Run:
     node <scratchpad>/serve.js <worktree> 8901
     node <browser-skill>/browser.mjs "http://127.0.0.1:8901/404.html" \
          --script ./scripts/after-universal-surfaces.mjs

   THE INVARIANT
     index.html    authenticated -> ALLOW, for every role
     profile.html  authenticated -> ALLOW, for every role
     admin.html    authenticated + claim + adminContext -> ALLOW, else DENY

   Holding an administrative claim must not cost an account the ordinary surfaces,
   and reaching Home or Profile must not confer anything administrative there.

   DIRECT URL ENTRY, NOT MENU CLICKS
   Every row navigates straight to the page. A menu that points somewhere correct
   can make a broken page gate look fixed, so the gate is tested where it lives.

   WHAT "ALLOW" MEANS HERE
   The page did not bounce to login and rendered a real body. A client gate decides
   what to RENDER; Firestore rules remain the boundary that protects data.

   CONTROLS
   * A signed-OUT visitor must be REDIRECTED from profile.html, or "allow" would be
     passing for every row and the guard would be proven absent rather than correct.
   * admin.html must DENY a non-admin, or the stricter gate would be unproven.
*/

const ORIGIN = 'http://127.0.0.1:8901';
const ROLES = ['buyer', 'seller', 'driver', 'moderator', 'admin', 'superAdmin'];
const WORKSPACE = ['buyer', 'seller', 'driver', 'moderator'];

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  /* One fixture, parameterised by ?role=. Both authorities are stubbed at the
     boundary they really read; nothing signs in. */
  await page.addInitScript(() => {
    const q = new URLSearchParams(location.search);
    const role = q.get('role') || 'buyer';
    const signedOut = q.get('signedout') === '1';
    const elevated = (role === 'admin' || role === 'superAdmin');
    const workspace = elevated ? ['buyer'] : ['buyer', role];
    const claims = {};
    if (elevated) { claims[role] = true; if (role === 'superAdmin') claims.admin = true; }

    if (signedOut) {
      try { localStorage.removeItem('loggedIn'); localStorage.removeItem('sokoniUser'); } catch (e) {}
      window.firebaseAuth = null;
    } else {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: 'fx', name: 'Fixture', roles: workspace, role: 'buyer', activeRole: 'buyer',
      }));
      window.firebaseAuth = { currentUser: { uid: 'fx',
        getIdTokenResult: function () { return Promise.resolve({ claims: claims }); } } };
    }
    window.firebaseDB = null;

    window.SokoniRoleAuthority = {
      _r: 'buyer',
      isVerified() { return !signedOut; },
      getActiveRole() { return this._r; },
      getApprovedRoles() { return workspace.slice(); },
      isApproved(r) { return workspace.indexOf(r) >= 0; },
      hubFor() { return null; },
      ready() { return Promise.resolve(); },
      setActiveRole(r) { this._r = r; return Promise.resolve({ ok: true, role: r }); },
    };
    window.SokoniPermissions = {
      hasRole(r) { return claims[r] === true; },
      hasAnyRole(a) { return a.some((r) => claims[r] === true); },
      isVerified() { return !signedOut; },
      isLoggedIn() { return !signedOut; },
      getRoles() { return Object.keys(claims); },
      getAdminContext() { return window.__ctx || null; },
      clearAdminContext() { window.__ctx = null; },
      enterAdminContext(r) {
        if (!claims[r] && !(r === 'admin' && claims.superAdmin)) return { ok: false, reason: 'no-claim' };
        window.__ctx = claims[r] ? r : 'superAdmin';
        return { ok: true, context: window.__ctx };
      },
      requireAdminContext(need) {
        if (signedOut) return { ok: false, reason: 'signed-out' };
        const claimed = claims[need] === true || (need === 'admin' && claims.superAdmin === true);
        if (!claimed) return { ok: false, reason: 'no-claim', need };
        if (!window.__ctx) return { ok: false, reason: 'context-not-entered', need, canEnter: true };
        return { ok: true, context: window.__ctx, need };
      },
      reverify() { return Promise.resolve(!signedOut); },
      init() { return Promise.resolve(); },
    };
  });

  /* Direct navigation, then read where we ACTUALLY are — a redirect and a page that
     failed to render are indistinguishable from the DOM alone. */
  async function visit(path, qs) {
    await page.goto(ORIGIN + '/' + path + '?' + qs, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    return page.evaluate(() => ({
      landed: location.pathname,
      body: (document.body && document.body.textContent || '').trim().length,
      denied: !!document.getElementById('sk-admin-deny'),
      /* Did the fixture survive? window.firebaseAuth is set BY firebase.js, which
         these full pages load — so it overwrites the stub and the run silently
         measures the real, signed-out auth stack instead. */
      stubAlive: !!(window.firebaseAuth && window.firebaseAuth.currentUser
                    && window.firebaseAuth.currentUser.uid === 'fx'),
    }));
  }

  /* KNOWN-GOOD CONTROL THAT ABORTS THE RUN.
     The first version of this harness reported 8/11 with every role — buyer
     included — "denied" from profile.html, and with the signed-out control
     INVERTED. Uniform failure plus a backwards control is an instrument fault, not
     a product finding. Rather than publish rows that look like evidence, check the
     fixture is actually in force and stop if it is not. */
  const rig = await visit('profile.html', 'role=buyer');
  if (!rig.stubAlive) {
    return {
      VOID: true,
      reason: 'firebase.js overwrote window.firebaseAuth, so the fixture never took '
            + 'effect and every row would describe the real signed-out stack.',
      evidence: 'profile.html landed=' + rig.landed + ' stubAlive=false',
      whatThisDoesNotSay: 'It does NOT show that Home or Profile deny administrators. '
            + 'Statically neither page is role-gated: index.html has no guard at all, '
            + 'profile.html declares data-require-auth="true" (auth only, no role), and '
            + 'neither appears as a key in GUARDED_ROUTES — profile.html appears there '
            + 'only as a redirect TARGET.',
      toProveIt: 'Needs a real signed-in session, or a fixture stubbed at a boundary '
            + 'firebase.js does not own.',
      rows,
    };
  }

  /* ── universal surfaces, every role, by direct URL ── */
  for (const role of ROLES) {
    for (const surface of ['index.html', 'profile.html']) {
      const r = await visit(surface, 'role=' + role);
      const bounced = /login/.test(r.landed);
      ck('U  ' + role.padEnd(11) + ' -> ' + surface.padEnd(13) + (bounced ? 'DENIED' : 'ALLOW'),
        !bounced && r.body > 0, 'landed=' + r.landed + ' bodyChars=' + r.body);
    }
  }

  /* ── CONTROL: signed out must be refused from profile ── */
  const so = await visit('profile.html', 'role=buyer&signedout=1');
  ck('CONTROL  signed OUT -> profile.html is refused',
    /login/.test(so.landed), 'landed=' + so.landed);

  /* ── the stricter administrative gate, also by direct URL ── */
  for (const role of WORKSPACE) {
    const r = await visit('admin.html', 'role=' + role);
    const blocked = /login/.test(r.landed) || r.denied;
    ck('A  ' + role.padEnd(11) + ' -> admin.html        ' + (blocked ? 'DENY' : 'REACHED'),
      blocked, 'landed=' + r.landed + ' denyScreen=' + r.denied);
  }
  for (const role of ['admin', 'superAdmin']) {
    const r = await visit('admin.html', 'role=' + role);
    /* Holding the claim without entering the context is still a denial — but a
       DIFFERENT one, and it must not be a bounce to login. */
    ck('A  ' + role.padEnd(11) + ' -> admin.html        claim seen, context required',
      !/login/.test(r.landed), 'landed=' + r.landed + ' denyScreen=' + r.denied);
  }

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
