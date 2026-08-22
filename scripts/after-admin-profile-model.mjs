/* AFTER-PROOF — the administrative top-right profile model.
   ==========================================================================
   Run:  node <scratchpad>/serve.js <worktree> 8901
         node <browser-skill>/browser.mjs "http://127.0.0.1:8901/offline.html" \
              --script ./scripts/after-admin-profile-model.mjs

   THE MODEL UNDER TEST
     Marketplace pages   shared header + profile dropdown carrying role switching
     Admin surfaces      NO shared marketplace header; the top-right profile button
                         is the single dropdown entry point and REPLACES the
                         standalone Sign Out
     Admin switching     SokoniPermissions + adminContext, never setActiveRole
     Workspace switching SokoniRoleAuthority + activeRole
     Authority           never localStorage
     Every dropdown      internally scrollable and viewport-safe

   scripts/after-unified-role-menu.mjs proves the marketplace half on /cart. This
   proves the administrative half, which that harness structurally cannot see.

   ── WHAT THIS PROVES, AND WHAT IT DOES NOT ────────────────────────────────
   Rendering, wiring and client-side state transitions. NOT authorization: Firestore
   rules and the admin callables are the boundary and are untouched here. A menu that
   hides an entry has hidden an entry; it has not denied anything.

   admin.html additionally runs under a fixture firebase.js (see lib/admin-fixture.mjs),
   because its third auth resolver is a module-scoped import no global can reach. Under
   that route its data layer is inert, so NOTHING here asserts admin.html CONTENT —
   only its chrome. That restriction is deliberate; a content row would be measuring
   the harness.
==========================================================================*/

import {
  installFixture, stubFirebaseModule, setScenario, primeOrigin, open, read,
} from './lib/admin-fixture.mjs';

const CLAIMS_BOTH = ['admin', 'superAdmin', 'seller', 'rider'];

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  await stubFirebaseModule(page);
  await installFixture(page);
  await primeOrigin(page);

  /* Open the menu and read it. Clicking is the only honest way to assert "the
     dropdown opens" — asserting the element exists proves markup, not behaviour. */
  async function openMenu() {
    await page.addScriptTag({ content:
      'var b=document.getElementById("sk-admin-profile"); if(b) b.click();' });
    await page.waitForTimeout(400);
    return read(page);
  }

  /* ══ admin.html ══════════════════════════════════════════════════════════ */
  await setScenario(page, { claims: CLAIMS_BOTH, ctx: 'admin',
    lsroles: ['buyer', 'seller', 'rider'] });
  let landed = await open(page, 'admin.html', { wait: 5000 });
  let r = await read(page);

  ck('RIG  CONTROL on admin.html, not a redirect target',
    landed.ok, 'landed=' + landed.landed);
  ck('RIG  CONTROL the claims verified and the surface opened',
    r.verified && r.hasAdmin && r.hasSuper && !r.deny,
    'verified=' + r.verified + ' admin=' + r.hasAdmin + ' super=' + r.hasSuper
    + ' deny=' + r.deny + (r.denyTitle ? ' (' + r.denyTitle + ')' : ''));

  ck('A1   admin.html carries NO shared marketplace header',
    r.sharedHeader === false && r.sharedAvatar === false,
    'sk-top-nav=' + r.sharedHeader + ' sk-nav-avatar=' + r.sharedAvatar);
  ck('A2   the top-right profile button is present',
    r.profileBtn === true, 'sk-admin-profile visible=' + r.profileBtn);
  ck('A3   the old standalone control bar is gone',
    r.legacyBar === false && r.legacySelect === false,
    'sk-admin-controls=' + r.legacyBar + ' select=' + r.legacySelect);

  let m = await openMenu();
  ck('A4   the dropdown opens on click',
    m.menuOpen === true, 'menu visible=' + m.menuOpen);
  ck('A5   Admin controls are present in the dropdown',
    m.admin.indexOf('admin') > -1, JSON.stringify(m.admin));
  ck('A6   the entered administrative context is marked current',
    m.adminCurrent === 'admin', 'current=' + m.adminCurrent + ' ctx=' + m.ctx);
  ck('A7   exactly ONE Sign Out on the surface, and it is OURS',
    m.signOuts.length === 1 && m.signOutsOurs === 1,
    m.signOuts.length + ' visible: ' + JSON.stringify(m.signOuts));
  ck('A8   workspace roles come from the AUTHORITY, and admin is not among them',
    m.workspace.length > 1 && m.workspace.indexOf('admin') < 0
      && m.workspace.indexOf('superAdmin') < 0,
    JSON.stringify(m.workspace) + ' approved=' + JSON.stringify(m.approved));

  /* ── A9. Super Admin absent unless the CLAIM authorises it ─────────────── */
  await setScenario(page, { claims: ['admin', 'seller', 'rider'], ctx: 'admin',
    lsroles: ['buyer', 'seller', 'rider'] });
  landed = await open(page, 'admin.html', { wait: 5000 });
  r = await read(page);
  ck('RIG  CONTROL still on admin.html with the admin-only claim',
    landed.ok && r.hasAdmin === true && r.hasSuper === false,
    'landed=' + landed.landed + ' admin=' + r.hasAdmin + ' super=' + r.hasSuper);
  m = await openMenu();
  ck('A9   CONTROL admin claim alone -> Super Admin is ABSENT',
    m.admin.indexOf('superAdmin') < 0 && m.admin.indexOf('admin') > -1,
    JSON.stringify(m.admin));

  /* ── A10. THE NEGATIVE CONTROL: a forged localStorage role grants nothing ─
     The mirror claims every role there is; the token carries none. If any
     administrative entry appears, the menu is reading the mirror. */
  await setScenario(page, { claims: [], ctx: '',
    lsroles: ['buyer', 'seller', 'admin', 'superAdmin'] });
  await open(page, 'admin.html', { wait: 5000 });
  r = await read(page);
  ck('A10  CONTROL forged localStorage roles + no claims -> DENIED, no menu',
    r.admin.length === 0 && (r.deny === true || r.profileBtn === false),
    'deny=' + r.deny + (r.denyTitle ? ' (' + r.denyTitle + ')' : '')
    + ' profileBtn=' + r.profileBtn + ' admin=' + JSON.stringify(r.admin));

  /* ══ super-admin.html ════════════════════════════════════════════════════ */
  await setScenario(page, { claims: CLAIMS_BOTH, ctx: 'superAdmin',
    lsroles: ['buyer', 'seller', 'rider'] });
  landed = await open(page, 'super-admin.html', { wait: 5000 });
  r = await read(page);
  ck('RIG  CONTROL on super-admin.html, not a redirect target',
    landed.ok, 'landed=' + landed.landed);
  ck('RIG  CONTROL super-admin opened rather than denying',
    r.deny === false && r.authGateShown === false,
    'deny=' + r.deny + (r.denyTitle ? ' (' + r.denyTitle + ')' : '')
    + ' authGate=' + r.authGateShown + ' chars=' + r.bodyChars);

  ck('S1   super-admin.html carries NO shared marketplace header',
    r.sharedHeader === false && r.sharedAvatar === false,
    'sk-top-nav=' + r.sharedHeader + ' sk-nav-avatar=' + r.sharedAvatar);
  ck('S2   the top-right profile button is present',
    r.profileBtn === true, 'sk-admin-profile visible=' + r.profileBtn);
  ck('S3   the TWO standalone Sign Out buttons this page shipped are adopted',
    r.signOutsPage === 0, 'page-owned still visible: ' + JSON.stringify(r.signOuts));

  m = await openMenu();
  ck('S4   the dropdown opens on click', m.menuOpen === true, 'menu visible=' + m.menuOpen);
  ck('S5   Super Admin controls are present in the dropdown',
    m.admin.indexOf('superAdmin') > -1, JSON.stringify(m.admin));
  ck('S6   the administrative context is superAdmin and is marked current',
    m.ctx === 'superAdmin' && m.adminCurrent === 'superAdmin',
    'ctx=' + m.ctx + ' current=' + m.adminCurrent);
  ck('S7   exactly ONE Sign Out on the surface, and it is OURS',
    m.signOuts.length === 1 && m.signOutsOurs === 1,
    m.signOuts.length + ' visible: ' + JSON.stringify(m.signOuts));

  /* ── S8/S9. Scrolling and viewport safety ──────────────────────────────── */
  ck('S8   the dropdown scrolls inside itself and is height-capped',
    (m.overflowY === 'auto' || m.overflowY === 'scroll') && m.maxHeight !== 'none',
    'overflow-y=' + m.overflowY + ' max-height=' + m.maxHeight);

  const vps = [];
  for (const vp of [{ width: 360, height: 640 }, { width: 390, height: 844 },
                    { width: 820, height: 1180 }, { width: 1440, height: 900 },
                    { width: 844, height: 390 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(250);
    const g = await page.evaluate(() => {
      const el = document.getElementById('sk-admin-profile-menu');
      if (!el || el.hidden) return null;
      const b = el.getBoundingClientRect();
      return { ok: b.right <= window.innerWidth + 1 && b.left >= -1
                   && b.top >= -1 && b.height <= window.innerHeight,
               l: Math.round(b.left), r: Math.round(b.right),
               t: Math.round(b.top), h: Math.round(b.height) };
    });
    vps.push({ vp: vp.width + 'x' + vp.height, g });
  }
  ck('S9   the dropdown stays inside the viewport at 360/390/820/1440 and landscape',
    vps.every((v) => v.g && v.g.ok),
    vps.map((v) => v.vp + ':' + (v.g ? (v.g.ok ? 'ok' : 'l=' + v.g.l + ' r=' + v.g.r
      + ' t=' + v.g.t + ' h=' + v.g.h) : 'closed')).join('  '));
  await page.setViewportSize({ width: 1280, height: 720 });

  /* ══ THE CRITICAL TRANSITION: SuperAdmin -> Buyer ════════════════════════
     The requirement is that the page LEAVES the administrative context, not that
     it relabels itself. So this asserts the state, not the caption: the context is
     null, its sessionStorage mirror is gone, and the surface has changed.

     The fixture's context seed is nonce-guarded to the first navigation after
     setScenario precisely so this navigation cannot silently re-seed it. */
  await setScenario(page, { claims: CLAIMS_BOTH, ctx: 'superAdmin',
    lsroles: ['buyer', 'seller', 'rider'] });
  landed = await open(page, 'super-admin.html', { wait: 5000 });
  const pre = await openMenu();
  ck('RIG  CONTROL in the superAdmin context before switching',
    landed.ok && pre.ctx === 'superAdmin' && pre.ssCtx === 'superAdmin'
      && pre.workspace.indexOf('buyer') > -1,
    'ctx=' + pre.ctx + ' ss=' + pre.ssCtx + ' workspace=' + JSON.stringify(pre.workspace));

  await page.addScriptTag({ content:
    'var b=document.querySelector("#sk-admin-profile-menu [data-sk-workspace=\'buyer\']");'
    + ' if (b) b.click();' });
  await page.waitForTimeout(4000);
  const post = await read(page);

  ck('T1   SuperAdmin -> Buyer LEAVES the administrative context',
    post.ctx == null && post.ssCtx == null,
    'getAdminContext=' + JSON.stringify(post.ctx) + ' sessionStorage=' + JSON.stringify(post.ssCtx));
  ck('T2   SuperAdmin -> Buyer leaves the administrative SURFACE',
    post.landed !== 'super-admin.html', 'landed=' + post.landed);
  ck('T3   the acting workspace role is now buyer',
    post.active === 'buyer', 'activeRole=' + post.active);

  /* ══ admin-os.html ═══════════════════════════════════════════════════════ */
  await setScenario(page, { claims: CLAIMS_BOTH, ctx: 'admin',
    lsroles: ['buyer', 'seller', 'rider'] });
  landed = await open(page, 'admin-os.html', { wait: 5000 });
  r = await read(page);
  ck('RIG  CONTROL on admin-os.html, not a redirect target',
    landed.ok, 'landed=' + landed.landed);
  ck('O1   admin-os.html carries NO shared marketplace header and has the button',
    r.sharedHeader === false && r.profileBtn === true,
    'sk-top-nav=' + r.sharedHeader + ' profileBtn=' + r.profileBtn);
  m = await openMenu();
  /* This row first "passed" while the page's OWN button was the one remaining and the
     menu had never mounted — a count of 1 was right for entirely the wrong reason. */
  ck('O2   its shipped standalone Sign Out is adopted — the one left is OURS',
    m.signOuts.length === 1 && m.signOutsOurs === 1,
    m.signOuts.length + ' visible: ' + JSON.stringify(m.signOuts));

  const passed = rows.filter((x) => x.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
