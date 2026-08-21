/* BEFORE-PROOF — header/dropdown role-state divergence (F1 + F2).

   Run:
     node <scratchpad>/serve.js <worktree> 8899 &
     node <browser-skill>/browser.mjs "http://127.0.0.1:8901/404.html" \
          --script ./scripts/before-role-state-divergence.mjs

   WHAT IS UNDER TEST
   shared-header.js holds TWO readers of "which role am I acting as":

     _skActingRole()        line ~1860   asks SokoniRoleAuthority  (the authority)
     _injectRoleSwitcher()  line ~2518   is handed detail.role / sokoniUser.role
                                         (the mirror) and never asks the authority

   and the switcher has exactly ONE call site, inside a {once:true} listener on
   sokoniAuthReady, with no re-render on sokoniActiveRoleChanged.

   THE CONTRACT (must hold before and after any fix)
     C0  the switcher renders at all
     C1  authority says driver, mirror says buyer  -> dropdown marks DRIVER
     C2  authority and mirror agree on driver      -> dropdown marks DRIVER
     C3  authority changes to driver after paint   -> dropdown marks DRIVER

   C2 was written as the control — the row that must PASS today so that a harness
   which simply rendered nothing could not "detect" a defect on every row. It
   FAILED on the first run, and measuring the instrument (rather than trusting the
   row) turned up a defect UNDER F1/F2:

     _injectRoleSwitcher does  actionsEl.insertBefore(wrapper, avatar)
     but #sk-nav-avatar is a child of #sk-acct-wrap, NOT of #sk-nav-actions

   so the call throws NotFoundError, the sokoniAuthReady handler aborts, and
   {once:true} has already spent the listener. The header role switcher therefore
   NEVER RENDERS. F1/F2 sit downstream of that and cannot be observed until it is
   fixed. C0 below captures the throw directly, by invoking the registered handler,
   so the evidence is the exception itself rather than an absence.

   The surviving controls are the RIG rows: the nav injects, and the authority and
   mirror really do hold the values each row claims. Without those a null result
   would be indistinguishable from a broken fixture.

   ── ON THE FIXTURE ────────────────────────────────────────────────────────
   SokoniRoleAuthority is STUBBED and sokoniAuthReady is dispatched by hand.
   That is a fixture for a rendering function, not an authenticated session:
   the thing under test is "which state does the renderer read", so the test
   must be able to set both states independently. Nothing here signs in,
   forges a token, or mints a claim, and NO result licenses any statement
   about a real account's authority. Page authorization is out of scope and is
   proven separately — a correct dropdown is not an access-control result.
*/

const BASE = 'http://127.0.0.1:8901/404.html';

/* Seeded before any page script runs, so the mirror and the authority are both
   in place by the time shared-header's listener fires. Parameters travel in the
   query string because addInitScript is installed once and must serve every row. */
function fixture() {
  /* Capture the handlers shared-header registers, so C0 can invoke one directly and
     observe the exception. dispatchEvent swallows listener throws into the global
     error channel, where a page with unrelated 404s can hide them. */
  if (!window.__caught) {
    window.__caught = [];
    const _add = document.addEventListener.bind(document);
    document.addEventListener = function (t, f, o) {
      if (t === 'sokoniAuthReady') window.__caught.push(f);
      return _add(t, f, o);
    };
  }
  const q = new URLSearchParams(location.search);
  const roles = (q.get('roles') || 'buyer,driver').split(',');
  const ra = q.get('ra') || 'buyer';
  const mirror = q.get('mirror') || 'buyer';
  localStorage.setItem('sokoniUser', JSON.stringify({
    uid: 'fixture-uid', name: 'Fixture', roles: roles, role: mirror, activeRole: ra,
  }));
  window.__FX = { ra: ra, mirror: mirror, detail: q.get('detail') || mirror, roles: roles };
  window.__installRA = function (role) {
    window.SokoniRoleAuthority = {
      _r: role,
      isVerified: function () { return true; },
      getActiveRole: function () { return this._r; },
      getApprovedRoles: function () { return window.__FX.roles.slice(); },
      isApproved: function (r) { return window.__FX.roles.indexOf(r) >= 0; },
      hubFor: function () { return null; },          /* no navigation during the probe */
      ready: function () { return Promise.resolve(); },
    };
  };
  window.__installRA(ra);
}

/* Reads the RENDERED switcher. The "current" marker is a discrete node
   (shared-header.js:2565), so this asserts what the user actually sees rather
   than re-deriving it from the state the renderer was handed. */
function probe() {
  const out = { injected: false, items: [], current: null, authority: null, mirror: null };
  try { out.authority = window.SokoniRoleAuthority.getActiveRole(); } catch (e) {}
  try { out.mirror = (JSON.parse(localStorage.getItem('sokoniUser') || '{}').role) || null; } catch (e) {}
  const sw = document.getElementById('sk-role-switcher');
  out.injected = !!sw;
  if (sw) {
    const menu = document.getElementById('sk-role-menu');
    const items = menu ? menu.querySelectorAll('a[role="menuitem"]') : [];
    for (const a of items) {
      const spans = a.querySelectorAll('span');
      const label = spans[1] ? (spans[1].textContent || '') : '';
      const marked = /current/i.test(a.textContent || '');
      out.items.push({ label: label.trim(), marked: marked });
      if (marked) out.current = label.trim().toLowerCase();
    }
  }
  document.documentElement.setAttribute('data-probe', JSON.stringify(out));
}

export default async function run(page) {
  await page.addInitScript(fixture);

  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  const AUTH_READY = 'document.dispatchEvent(new CustomEvent("sokoniAuthReady",{detail:{'
    + 'uid:"fixture-uid",roles:window.__FX.roles,role:window.__FX.detail}}));';

  async function readProbe() {
    await page.addScriptTag({ content: '(' + probe.toString() + ')()' });
    return JSON.parse(await page.getAttribute('html', 'data-probe'));
  }

  async function paint(qs) {
    await page.goto(BASE + '?' + qs, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sk-nav-actions', { timeout: 15000 }).catch(() => {});
    /* Main world: the isolated world page.evaluate runs in cannot see these globals. */
    await page.addScriptTag({ content: 'window.__installRA(window.__FX.ra);' + AUTH_READY });
    await page.waitForTimeout(400);
    return readProbe();
  }

  /* ── rig check: without a nav there is nothing to inject into and every row is void ── */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const navOk = await page.waitForSelector('#sk-nav-actions', { timeout: 15000 })
    .then(() => true, () => false);
  ck('RIG  host page injects #sk-nav-actions (rows are void without it)', navOk);
  if (!navOk) return { VOID: true, reason: 'shared-header did not inject a nav', rows };

  /* ── C0: does the switcher render at all? Capture the exception rather than
        inferring a defect from an empty DOM — an absence has many causes, a
        NotFoundError naming insertBefore has one. ── */
  await page.goto(BASE + '?roles=buyer,driver&ra=driver&mirror=driver&detail=driver',
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sk-nav-actions', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.addScriptTag({ content: `
    var r = { threw: null, avatarDirectChild: null };
    var a = document.getElementById('sk-nav-actions');
    var av = document.getElementById('sk-nav-avatar');
    r.avatarDirectChild = !!(a && av && av.parentElement === a);
    r.avatarParent = av && av.parentElement ? (av.parentElement.id || '?') : null;
    var h = (window.__caught || [])[0];
    if (h) { try { h({ detail: { uid: 'fixture-uid', roles: ['buyer','driver'], role: 'driver' } }); }
             catch (e) { r.threw = String(e && e.message || e); } }
    r.switcher = !!document.getElementById('sk-role-switcher');
    document.documentElement.setAttribute('data-c0', JSON.stringify(r));
  ` });
  const c0 = JSON.parse(await page.getAttribute('html', 'data-c0'));
  ck('RIG  #sk-nav-avatar is a DIRECT child of #sk-nav-actions (insertBefore requires it)',
    c0.avatarDirectChild === true, 'parent=' + c0.avatarParent);
  ck('C0   the sokoniAuthReady handler completes without throwing',
    c0.threw === null, c0.threw || '');
  ck('C0   the role switcher renders at all', c0.switcher === true, '');

  /* ── C2 CONTROL: agreement must render correctly on today's code ── */
  const agree = await paint('roles=buyer,driver&ra=driver&mirror=driver&detail=driver');
  ck('CONTROL  switcher injected at all', agree.injected, JSON.stringify(agree.items));
  ck('CONTROL  authority and mirror AGREE on driver -> dropdown marks DRIVER',
    agree.current === 'driver', 'marked=' + agree.current);

  /* ── C1 / F1: the reported symptom ── */
  const split = await paint('roles=buyer,driver&ra=driver&mirror=buyer&detail=buyer');
  ck('RIG  authority really reports driver while the mirror says buyer',
    split.authority === 'driver' && split.mirror === 'buyer',
    'authority=' + split.authority + ' mirror=' + split.mirror);
  ck('F1   authority=driver mirror=buyer -> dropdown marks DRIVER',
    split.current === 'driver', 'marked=' + split.current + '  (header shows Driver)');

  /* ── C3 / F2: re-render after a switch ── */
  await page.goto(BASE + '?roles=buyer,driver&ra=buyer&mirror=buyer&detail=buyer',
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sk-nav-actions', { timeout: 15000 }).catch(() => {});
  await page.addScriptTag({ content: 'window.__installRA("buyer");' + AUTH_READY });
  await page.waitForTimeout(300);
  const pre = await readProbe();
  ck('RIG  starts marked buyer before the switch', pre.current === 'buyer',
    'marked=' + pre.current);

  await page.addScriptTag({ content:
    'window.SokoniRoleAuthority._r="driver";'
    + 'document.dispatchEvent(new CustomEvent("sokoniActiveRoleChanged",{detail:{role:"driver"}}));' });
  await page.waitForTimeout(600);
  const post = await readProbe();
  ck('F2   sokoniActiveRoleChanged -> dropdown re-renders and marks DRIVER',
    post.current === 'driver', 'marked=' + post.current);

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
