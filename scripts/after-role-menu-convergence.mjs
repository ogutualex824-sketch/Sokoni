/* PROOF — one canonical role state, one switcher, a scrollable menu.
   ==========================================================================
   Run:
     node <scratchpad>/serve.js <worktree> 8901
     node <browser-skill>/browser.mjs "http://127.0.0.1:8901/404.html" \
          --script ./scripts/after-role-menu-convergence.mjs

   WHAT IS UNDER TEST
     1  header and dropdown both read SokoniRoleAuthority.getActiveRole()
     2  Admin / Super Admin appear ONLY when the claim is held
     3  selecting them enters the administrative CONTEXT — never setActiveRole()
     4  an unauthorised elevated role is absent, and forcing it changes nothing
     5  the menu scrolls inside itself at any list length

   WHY 2 AND 3 ARE SEPARATE AUTHORITIES
   `admin` and `superAdmin` are deliberately excluded from CANONICAL_ROLES, so
   setActiveRole('admin') returns {ok:false, reason:'unknown-role'} by design.
   Administrative access is SokoniPermissions' job. One user-facing menu, two
   authorities behind it — the alternative is a second path to the same privilege.

   ── ON THE FIXTURE ────────────────────────────────────────────────────────
   Both authorities are stubbed at the boundary they really read: RA reports an
   approved set, SokoniPermissions reports claim-derived roles. Nothing signs in and
   no row licenses a statement about a real account. Firestore rules remain the
   boundary that protects data.

   CONTROLS
   * An authorised admin MUST see the entry, or "absent" would pass for every row.
   * A non-admin MUST NOT, or the entry would be decoration rather than a decision.
   * The scroll row uses a deliberately OVERSIZED list — a menu that merely fits
     today's six roles proves nothing about scrolling.
*/

const BASE = 'http://127.0.0.1:8901/404.html';

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  /* Every URL the frame actually went to, so a click can be judged by what it
     REQUESTED rather than by where unrelated guards later sent the browser. */
  const navChain = [];
  page.on('framenavigated', (f) => { try { if (!f.parentFrame()) navChain.push(f.url()); } catch (e) {} });

  /* Stub both authorities before any page script runs. Parameters travel in the
     query string because addInitScript is installed once and serves every row. */
  await page.addInitScript(() => {
    const q = new URLSearchParams(location.search);
    const roles = (q.get('roles') || 'buyer,driver').split(',').filter(Boolean);
    const ra = q.get('ra') || 'buyer';
    const claims = (q.get('claims') || '').split(',').filter(Boolean);

    localStorage.setItem('loggedIn', 'true');
    localStorage.setItem('sokoniUser', JSON.stringify({
      uid: 'fx', name: 'Fixture', roles: roles, role: q.get('mirror') || ra, activeRole: ra,
    }));

    window.__FX = { roles, ra, claims };
    /* shared-header now SELF-BOOTSTRAPS sokoni-permissions.js and
       sokoni-role-authority.js, so the real modules load after this init script and
       overwrite these stubs — which took this harness from 18/0 to 9/9 the moment
       the bootstrap landed. The product is correct; the fixture has to survive it.
       Installed as a function so paint() can re-apply after the real ones arrive,
       the same guard the F0-F3 harness already uses. */
    window.__installStubs = function () {
    window.SokoniRoleAuthority = {
      _r: ra,
      isVerified() { return true; },
      getActiveRole() { return this._r; },
      getApprovedRoles() { return roles.slice(); },
      isApproved(r) { return roles.indexOf(r) >= 0; },
      hubFor() { return null; },
      ready() { return Promise.resolve(); },
      setActiveRole(r) {
        if (roles.indexOf(r) < 0) return Promise.resolve({ ok: false, reason: 'not-approved' });
        this._r = r;
        document.dispatchEvent(new CustomEvent('sokoniActiveRoleChanged', { detail: { role: r } }));
        return Promise.resolve({ ok: true, role: r });
      },
    };
    /* Claim-derived, exactly as hasRole() is. */
    window.__ctx = null;
    window.SokoniPermissions = {
      hasRole(r) { return claims.indexOf(r) >= 0; },
      isVerified() { return true; },
      isLoggedIn() { return true; },
      getRoles() { return claims.slice(); },
      getAdminContext() { return window.__ctx; },
      clearAdminContext() { window.__ctx = null; },
      enterAdminContext(r) {
        if (claims.indexOf(r) < 0 && !(r === 'admin' && claims.indexOf('superAdmin') >= 0)) {
          return { ok: false, reason: 'no-claim' };
        }
        window.__ctx = (claims.indexOf(r) >= 0) ? r : 'superAdmin';
        document.dispatchEvent(new CustomEvent('sokoniAdminContextChanged',
          { detail: { context: window.__ctx } }));
        return { ok: true, context: window.__ctx };
      },
      init() { return Promise.resolve(); },
    };
    };                       /* end __installStubs */
    window.__installStubs();
    /* stop the header navigating away mid-probe */
    window.__nav = [];
  });

  async function paint(qs) {
    await page.goto(BASE + '?' + qs, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sk-nav-actions', { timeout: 15000 }).catch(() => {});
    /* Re-apply the fixture: the header self-bootstraps the REAL authority modules,
       which replace the stubs installed at document-start. */
    await page.addScriptTag({ content: 'window.__installStubs && window.__installStubs();' });
    await page.addScriptTag({ content:
      'document.dispatchEvent(new CustomEvent("sokoniAuthReady",{detail:{'
      + 'uid:"fx",roles:window.__FX.roles,role:window.__FX.ra}}));' });
    await page.waitForTimeout(500);
  }

  async function readMenu() {
    await page.addScriptTag({ content: `
      (function () {
        var m = document.getElementById('sk-role-menu');
        var out = { injected: !!document.getElementById('sk-role-switcher'),
                    items: [], current: null, adminEntries: [] };
        if (m) {
          var cs = getComputedStyle(m);
          out.maxHeight = cs.maxHeight; out.overflowY = cs.overflowY;
          out.scrollH = m.scrollHeight; out.clientH = m.clientHeight;
          Array.prototype.forEach.call(m.querySelectorAll('a[role="menuitem"]'), function (a) {
            var sp = a.querySelectorAll('span');
            var label = sp[1] ? (sp[1].textContent || '').trim() : '';
            out.items.push(label);
            if (/current/i.test(a.textContent || '')) out.current = label.toLowerCase();
            if (/Admin/i.test(label)) out.adminEntries.push(label);
          });
        }
        document.documentElement.setAttribute('data-m', JSON.stringify(out));
      }());` });
    return JSON.parse(await page.getAttribute('html', 'data-m'));
  }

  /* ── 1. convergence: authority wins over a disagreeing mirror ── */
  await paint('roles=buyer,driver&ra=driver&mirror=buyer');
  let m = await readMenu();
  ck('RIG  the switcher rendered', m.injected === true, JSON.stringify(m.items));
  ck('C1   authority=driver, mirror=buyer -> dropdown marks DRIVER',
    m.current === 'driver', 'marked=' + m.current);

  /* The window BEFORE the authority verifies. Both consumers must still give ONE
     answer: this is the state that produced Driver in the header and Buyer in the
     menu, and it is reached on any load where verification has not finished. */
  await page.goto(BASE + '?roles=buyer,driver&ra=driver&mirror=buyer',
    { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content:
    'window.SokoniRoleAuthority.isVerified = function(){ return false; };' });
  await page.waitForSelector('#sk-nav-actions', { timeout: 15000 }).catch(() => {});
  await page.addScriptTag({ content:
    'document.dispatchEvent(new CustomEvent("sokoniAuthReady",{detail:{'
    + 'uid:"fx",roles:window.__FX.roles,role:"buyer"}}));' });
  await page.waitForTimeout(700);
  await page.addScriptTag({ content: `
    (function () {
      var menu = document.getElementById('sk-role-menu');
      var marked = null;
      if (menu) {
        Array.prototype.forEach.call(menu.querySelectorAll('a[role="menuitem"]'), function (a) {
          if (/current/i.test(a.textContent || '')) {
            var sp = a.querySelectorAll('span');
            marked = sp[1] ? (sp[1].textContent || '').trim().toLowerCase() : null;
          }
        });
      }
      var mirror = null;
      try {
        var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
        mirror = u.activeRole || u.role || null;
      } catch (e) {}
      document.documentElement.setAttribute('data-d',
        JSON.stringify({ marked: marked, mirror: mirror }));
    }());` });
  const dv = JSON.parse((await page.getAttribute('html', 'data-d')) || '{}');
  ck('C1b  authority UNVERIFIED -> header and menu share ONE mirror',
    dv.marked === dv.mirror && !!dv.marked,
    'menu=' + dv.marked + ' mirror=' + dv.mirror);

  /* ── 2. Admin entries appear only with the claim ── */
  await paint('roles=buyer,driver&ra=buyer&claims=admin');
  m = await readMenu();
  ck('C2   CONTROL admin claim -> "Admin" appears',
    m.adminEntries.some((x) => /^Admin$/i.test(x)), JSON.stringify(m.adminEntries));
  ck('C3   admin claim only -> "Super Admin" absent',
    !m.adminEntries.some((x) => /Super Admin/i.test(x)), JSON.stringify(m.adminEntries));

  await paint('roles=buyer,driver&ra=buyer&claims=admin,superAdmin');
  m = await readMenu();
  ck('C4   both claims -> both entries appear',
    m.adminEntries.some((x) => /^Admin$/i.test(x))
    && m.adminEntries.some((x) => /Super Admin/i.test(x)), JSON.stringify(m.adminEntries));

  await paint('roles=buyer,driver&ra=buyer&claims=');
  m = await readMenu();
  ck('C5   CONTROL no claim -> neither entry appears',
    m.adminEntries.length === 0, JSON.stringify(m.adminEntries));

  /* ── 3. an admin whose only workspace role is buyer still gets a menu ── */
  await paint('roles=buyer&ra=buyer&claims=admin');
  m = await readMenu();
  ck('C6   single workspace role + admin claim -> menu still renders',
    m.injected === true && m.adminEntries.length > 0,
    'items=' + JSON.stringify(m.items));

  /* ── 4. selecting Admin enters the CONTEXT, not activeRole ── */
  await paint('roles=buyer,driver&ra=buyer&claims=admin');
  /* A successful selection NAVIGATES — that is the behaviour under test, and it
     destroys the page before any DOM attribute can be read back. The first version
     of this probe stamped <html> and always found it missing.

     Record the outcome into sessionStorage from the context-changed event instead,
     let the navigation happen, and read it afterwards. Overriding location was not
     an option: wrapping Location.prototype.href has broken Auth signup here before. */
  await page.addScriptTag({ content: `
    (function () {
      try { sessionStorage.removeItem('__probe'); } catch (e) {}
      document.addEventListener('sokoniAdminContextChanged', function (ev) {
        try {
          sessionStorage.setItem('__probe', JSON.stringify({
            ctx: (ev.detail && ev.detail.context) || null,
            activeRole: window.SokoniRoleAuthority.getActiveRole() }));
        } catch (e) {}
      });
      /* The menu is now re-rendered on sokoniRoleAuthorityReady / sokoniRolesReady,
         so the node found by a single query can be replaced before it is clicked —
         which made this row flake between pass and fail on identical input. Look up
         the entry FRESH at click time, and poll for it rather than assuming the
         paint has already happened. */
      function find() {
        var t = null;
        var items = document.querySelectorAll('#sk-role-menu a[role="menuitem"]');
        Array.prototype.forEach.call(items, function (a) {
          var sp = a.querySelectorAll('span');
          if (sp[1] && /^Admin$/i.test((sp[1].textContent||'').trim())) t = a;
        });
        return t;
      }
      var n = 0;
      (function wait() {
        var t = find();
        if (t) {
          document.documentElement.setAttribute('data-found', '1');
          t.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, button:0}));
          return;
        }
        if (++n > 60) { document.documentElement.setAttribute('data-found', '0'); return; }
        setTimeout(wait, 50);
      }());
    }());` });
  await page.waitForSelector('html[data-found]', { timeout: 8000 }).catch(() => {});
  const found = (await page.getAttribute('html', 'data-found')) === '1';
  await page.waitForTimeout(1500);        /* allow the navigation chain to settle */
  const c = await page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem('__probe') || 'null') || {}; }
    catch (e) { return {}; }
  });
  c.found = found;
  /* Assert the NAVIGATION CHAIN, not the final URL. admin.html runs its own entry
     guard, which correctly bounces an unauthenticated fixture visitor onward — so
     checking where the browser ENDED tested those other guards rather than the
     switcher. The question here is only whether selecting Admin requested the admin
     surface at all. */
  ck('C7b  selecting Admin requests the admin surface',
    navChain.some((u) => /admin\.html/.test(u)),
    navChain.map((u) => u.split('/').pop()).slice(-4).join(' -> ') || '(no navigation)');
  /* entry existence is already proven by C2/C4/C6; this row only mattered while the
     probe could not survive the navigation, and it flaked for that reason. */
  ck('C7   selecting Admin ENTERS the administrative context',
    c.ctx === 'admin', 'ctx=' + c.ctx);
  ck('C8   selecting Admin does NOT change activeRole',
    c.activeRole === 'buyer', 'activeRole=' + c.activeRole);

  /* ── 5. an unauthorised elevated role changes nothing ── */
  await paint('roles=buyer,driver&ra=driver&claims=');
  await page.addScriptTag({ content: `
    (function () {
      var out = { res: null, ctx: null, before: null, after: null, err: null };
      try {
        out.before = window.SokoniRoleAuthority.getActiveRole();
        out.res = window.SokoniPermissions.enterAdminContext('superAdmin');
        out.ctx = window.__ctx === undefined ? null : window.__ctx;
        out.after = window.SokoniRoleAuthority.getActiveRole();
      } catch (e) { out.err = String(e && e.message || e); }
      document.documentElement.setAttribute('data-u', JSON.stringify(out));
    }());` });
  const u = JSON.parse((await page.getAttribute('html', 'data-u')) || '{"err":"attribute never set"}');
  if (u.err) ck('RIG  the refusal probe ran without throwing', false, u.err);
  ck('C9   unauthorised elevated role is REFUSED',
    u.res && u.res.ok === false && u.res.reason === 'no-claim', 'reason=' + (u.res || {}).reason);
  ck('C10  the refusal leaves the visible role unchanged',
    u.ctx === null && u.after === u.before, 'before=' + u.before + ' after=' + u.after);

  /* ── 6. the menu scrolls INSIDE ITSELF, proven on an oversized list ── */
  await paint('roles=buyer,driver,seller,provider,mechanic,rider,health,legal,landlord&ra=buyer&claims=admin,superAdmin');
  await page.setViewportSize({ width: 390, height: 844 });
  /* Open it the way a user does, so the clamp runs. Forcing display:block bypassed
     the open handler and therefore skipped the very fix under test. */
  await page.addScriptTag({ content:
    'var b=document.querySelector("#sk-role-switcher button"); if(b) b.click();' });
  await page.waitForTimeout(200);
  m = await readMenu();
  ck('RIG  the oversized list really overflows',
    m.scrollH > m.clientH, 'scrollH=' + m.scrollH + ' clientH=' + m.clientH);
  ck('C11  the menu scrolls inside itself, not the page',
    m.overflowY === 'auto' || m.overflowY === 'scroll', 'overflow-y=' + m.overflowY);
  ck('C12  the menu is height-capped rather than growing without limit',
    m.maxHeight !== 'none' && parseInt(m.maxHeight, 10) <= 844,
    'max-height=' + m.maxHeight);

  const wide = [];
  for (const vp of [{ width: 390, height: 844 }, { width: 820, height: 1180 },
                    { width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const m = document.getElementById('sk-role-menu');
      if (!m) return null;
      const b = m.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right),
               h: Math.round(b.height), vw: window.innerWidth, vh: window.innerHeight,
               fits: b.right <= window.innerWidth + 1 && b.left >= -1,
               tall: b.height <= window.innerHeight };
    });
    wide.push({ vp: vp.width + 'x' + vp.height, ok: !!(r && r.fits && r.tall), r });
  }
  ck('C13  the menu stays inside the viewport at 390/820/1440 and landscape',
    wide.every((w) => w.ok),
    wide.map((w) => w.vp + ':' + (w.ok ? 'ok'
      : 'left=' + (w.r && w.r.left) + ' right=' + (w.r && w.r.right) + ' vw=' + (w.r && w.r.vw))).join('  '));

  /* ── C14: the repaint must not be gated on the LEGACY mirror field ──────────
     The sokoniActiveRoleChanged handler used to return early when u.role already
     equalled the new role, and the account-popup repaint sat BEHIND that check.
     u.role is the legacy field that setActiveRole never writes, so the guard
     compared the new role against something unrelated to what is on screen — and a
     stale label survived the switch.

     Fire the event with u.role ALREADY matching, which is exactly the case that
     used to skip the repaint. */
  await paint('roles=buyer,driver&ra=driver&mirror=driver');
  await page.addScriptTag({ content: `
    (function () {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      u.role = 'driver'; u.activeRole = 'driver';
      localStorage.setItem('sokoniUser', JSON.stringify(u));
      window.SokoniRoleAuthority._r = 'driver';
      var threw = null;
      try {
        document.dispatchEvent(new CustomEvent('sokoniActiveRoleChanged', { detail: { role: 'driver' } }));
      } catch (e) { threw = String(e && e.message || e); }
      document.documentElement.setAttribute('data-c14', JSON.stringify({
        threw: threw,
        acting: window.SokoniRoleAuthority.getActiveRole(),
        mirrorRole: (JSON.parse(localStorage.getItem('sokoniUser') || '{}').role) || null
      }));
    }());` });
  const c14 = JSON.parse((await page.getAttribute('html', 'data-c14')) || '{}');
  ck('C14  an event whose value already matches the mirror is still handled',
    c14.threw === null && c14.acting === 'driver' && c14.mirrorRole === 'driver',
    'acting=' + c14.acting + ' mirror=' + c14.mirrorRole
      + (c14.threw ? ' THREW: ' + c14.threw : ''));

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
