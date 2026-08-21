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
      /* Models the real setActiveRole contract: approves only what the claims
         approve, and on refusal changes NOTHING. P2 depends on the refusal being
         a genuine no-op rather than a suppressed UI update. */
      setActiveRole: function (r) {
        if (window.__FX.roles.indexOf(r) < 0) {
          return Promise.resolve({ ok: false, reason: 'not-approved' });
        }
        this._r = r;
        document.dispatchEvent(new CustomEvent('sokoniActiveRoleChanged', { detail: { role: r } }));
        return Promise.resolve({ ok: true, role: r });
      },
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
    var r = { threw: null, anchorOk: null, anchorId: null, found: false };
    var a = document.getElementById('sk-nav-actions');
    var av = document.getElementById('sk-nav-avatar');
    /* The fix does NOT flatten the header; it climbs to whichever ancestor is a
       direct child. Assert that climb resolves — re-nesting the avatar so that no
       ancestor qualifies would silently bring the NotFoundError back. */
    var anchor = av;
    while (anchor && anchor.parentElement !== a) anchor = anchor.parentElement;
    r.anchorOk = !!anchor;
    r.anchorId = anchor ? (anchor.id || anchor.className || '?') : null;
    /* Select shared-header's handler by SIGNATURE, not by position. Several modules
       register on sokoniAuthReady and their order varies with script load timing, so
       indexing [0] silently tested somebody else's handler on some runs. */
    (window.__caught || []).forEach(function (h) {
      if (String(h).indexOf('_wireRealtime') < 0) return;
      r.found = true;
      try { h({ detail: { uid: 'fixture-uid', roles: ['buyer','driver'], role: 'driver' } }); }
      catch (e) { r.threw = String(e && e.message || e); }
    });
    r.switcher = !!document.getElementById('sk-role-switcher');
    document.documentElement.setAttribute('data-c0', JSON.stringify(r));
  ` });
  const c0 = JSON.parse(await page.getAttribute('html', 'data-c0'));
  ck('RIG  shared-header\'s own sokoniAuthReady handler was located by signature',
    c0.found === true, 'without it the C0 rows below are void');
  ck('RIG  the insert anchor resolves to a DIRECT child of #sk-nav-actions',
    c0.anchorOk === true, 'anchor=' + c0.anchorId);
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

  /* ── P: a RENDERED dropdown must actually switch ────────────────────────────
     C0–C3 prove the dropdown reflects the authority. They do not prove the control
     does anything when clicked — which it did not: the items were plain anchors
     that navigated and never called setActiveRole. P1 clicks the real element. */
  const p = await paint('roles=buyer,driver&ra=buyer&mirror=buyer&detail=buyer');
  ck('RIG  dropdown starts marked buyer before any click', p.current === 'buyer',
    'marked=' + p.current);

  await page.addScriptTag({ content: `
    var items = document.querySelectorAll('#sk-role-menu a[role="menuitem"]');
    var target = null;
    for (var i = 0; i < items.length; i++) {
      if (/driver/i.test(items[i].textContent || '')) target = items[i];
    }
    document.documentElement.setAttribute('data-p', JSON.stringify({ found: !!target }));
    if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  ` });
  const pClick = JSON.parse(await page.getAttribute('html', 'data-p'));
  ck('RIG  a Driver item exists in the rendered menu to click', pClick.found === true);
  await page.waitForTimeout(700);
  const afterClick = await readProbe();
  ck('P1   clicking Driver switches the acting role -> dropdown marks DRIVER',
    afterClick.current === 'driver' && afterClick.authority === 'driver',
    'marked=' + afterClick.current + ' authority=' + afterClick.authority);

  /* P2: the authority refuses. The visible role must not move — a UI that switches
     anyway would be claiming a role the server just declined. */
  const p2 = await paint('roles=buyer,driver&ra=buyer&mirror=buyer&detail=buyer');
  ck('RIG  reset to buyer before the refused switch', p2.current === 'buyer',
    'marked=' + p2.current);
  await page.addScriptTag({ content: 'window._skSwitchRole("admin");' });
  await page.waitForTimeout(700);
  const refused = await readProbe();
  ck('P2   a REFUSED switch leaves the visible role unchanged (still buyer)',
    refused.current === 'buyer' && refused.authority === 'buyer',
    'marked=' + refused.current + ' authority=' + refused.authority);

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
