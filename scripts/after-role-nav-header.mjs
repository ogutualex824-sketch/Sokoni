/* PROOF — one role indicator, one registry, and an accessor that does not destroy.
   ==========================================================================
   Run:  node <scratchpad>/serve.js <worktree> 8901
         node <browser-skill>/browser.mjs "http://127.0.0.1:8901/offline.html" \
              --script ./scripts/after-role-nav-header.mjs

   Point it at a pre-change tree with SK_ORIGIN to get the BEFORE half; the R-rows
   are written as positive assertions, so they FAIL there and PASS here.

   ── WHAT WAS WRONG ────────────────────────────────────────────────────────
   1  #sk-nav-role-chip, injected by sokoni-nav-engine.js beside the SOKONI logo,
      rendered a role label from sokoni-nav-engine's own _role() — which reads
      localStorage ONLY, consults no authority, and returns a PRIORITY pick
      (superAdmin > admin > driver > rider > provider > seller > buyer) rather than
      the acting role. So the header could say RIDER while the profile menu said
      Buyer, and it said it for a forged localStorage value with no claim at all.
      shared-header.js injects nav-engine on every page it runs on, so this was
      platform-wide, not the six pages that carry a static <script> tag.

   2  shared-header.js carried a SECOND role->route map (ROLE_ROUTES) that disagreed
      with SokoniRoleAuthority.WORKSPACE_HUBS on every entry it shared, and included
      admin/moderator as if they were workspaces.

   3  SokoniPermissions.getAdminContext() treated "not verified yet" as "not
      authorized" and ERASED the context. See the race rows below.

   ── WHAT THIS PROVES, AND WHAT IT DOES NOT ────────────────────────────────
   Rendering and client-side state. NOT authorization — rules and the admin
   callables are the boundary and are untouched.
==========================================================================*/

import {
  installFixture, stubFirebaseModule, setScenario, primeOrigin, ORIGIN,
} from './lib/admin-fixture.mjs';

/* Representative pages: a marketplace page, the home page, a rider workspace, a
   seller workspace, and a provider workspace. */
const PAGES = ['cart.html', 'index.html', 'driver.html', 'seller-delivery.html', 'provider.html'];

const ROLE_WORD = '^(buyer|seller|rider|driver|provider|mechanic|health|legal|'
                + 'landlord|tenant|admin|super\\s*admin)$';

/* Any VISIBLE leaf element in the top nav whose entire text is a role name, other
   than the profile menu itself. That is the class of control being removed — not
   one id, so re-adding it under a new name still fails this. */
function scanIndicators(rw) {
  const re = new RegExp(rw, 'i');
  const nav = document.getElementById('sk-top-nav');
  const popup = document.getElementById('sk-acct-popup');
  const adminMenu = document.getElementById('sk-admin-profile-menu');
  const hits = [];
  const roots = nav ? [nav] : [];
  roots.forEach((root) => {
    root.querySelectorAll('*').forEach((el) => {
      if (el.children.length) return;
      if (popup && popup.contains(el)) return;
      if (adminMenu && adminMenu.contains(el)) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 22 || !re.test(t)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (!(el.offsetWidth || el.offsetHeight)) return;
      hits.push({ text: t, id: el.id || null, tag: el.tagName });
    });
  });
  return {
    hits,
    navPresent: !!nav,
    /* CONTROL: the scanner must be able to see SOMETHING in the nav, or an empty
       result means "nothing rendered" rather than "no role indicator". */
    navLeaves: nav ? nav.querySelectorAll('*').length : 0,
    ariaLabel: nav ? nav.getAttribute('aria-label') : null,
  };
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  /* Without the Firestore double, _rolesFromFirebase() calls doc(db, ...) with the
     fixture's opaque handle and verification never completes — isVerified() stayed
     false at 4.5s and the "an unheld context is still cleared" row passed vacuously,
     having measured a page that never verified anything. */
  await stubFirebaseModule(page);
  await installFixture(page);
  await primeOrigin(page);

  /* ══ 1. No role indicator beside the logo, on any representative page ═════
     Acting role is buyer; the account also holds rider and seller. The old chip
     showed RIDER here — a label that contradicted both the acting role and the
     profile menu. */
  await setScenario(page, { claims: ['rider', 'seller'], ctx: '',
    lsroles: ['buyer', 'rider', 'seller'] });

  const perPage = [];
  for (const p of PAGES) {
    await page.goto(ORIGIN + '/' + p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3200);
    const r = await page.evaluate(scanIndicators, ROLE_WORD);
    perPage.push({ page: p, ...r });
  }

  ck('RIG  CONTROL the shared header rendered on every representative page',
    perPage.every((r) => r.navPresent && r.navLeaves > 3),
    perPage.map((r) => r.page + ':' + (r.navPresent ? r.navLeaves + ' nodes' : 'NO NAV')).join('  '));

  ck('R1   no role indicator beside the logo on any representative page',
    perPage.every((r) => r.hits.length === 0),
    perPage.filter((r) => r.hits.length)
      .map((r) => r.page + ':' + JSON.stringify(r.hits)).join('  ') || 'none on any page');

  ck('R2   the nav announces no role to assistive tech either',
    perPage.every((r) => !r.ariaLabel || !new RegExp(ROLE_WORD.replace(/^\^|\$$/g, ''), 'i')
      .test(r.ariaLabel.replace(/\s*navigation$/i, '').trim())),
    perPage.map((r) => r.page + ':"' + r.ariaLabel + '"').join('  '));

  /* ══ 2. NEGATIVE CONTROL — forged mirror, no claims at all ════════════════
     The old chip came from localStorage alone, so this produced a confident
     "SUPERADMIN" beside the logo for an account holding nothing. */
  await setScenario(page, { claims: [], ctx: '',
    lsroles: ['buyer', 'seller', 'rider', 'admin', 'superAdmin'] });
  await page.goto(ORIGIN + '/cart.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3200);
  const forged = await page.evaluate(scanIndicators, ROLE_WORD);
  ck('R3   CONTROL a forged localStorage mirror names no role in the header',
    forged.hits.length === 0 && forged.navLeaves > 3,
    'nav nodes=' + forged.navLeaves + ' hits=' + JSON.stringify(forged.hits));

  /* ══ 3. THE ACCESSOR RACE ════════════════════════════════════════════════
     getAdminContext() re-checks hasRole(ctx), which refuses an elevated role while
     _verifiedThisLoad is false — true on every load until the token round-trips,
     even though isVerified() has already gone true from the sessionStorage cache.
     In that window the accessor CLEARED the context and ERASED its mirror.

     Measured directly: call it as early as the module exists, then look at the
     mirror. This is the defect, not a proxy for it. */
  await page.addInitScript(() => {
    const t = setInterval(() => {
      const P = window.SokoniPermissions;
      if (!P || typeof P.getAdminContext !== 'function') return;
      clearInterval(t);
      let before = null, ret = null, after = null, verified = null;
      try { before = sessionStorage.getItem('sokoniAdminContext'); } catch (_) {}
      try { verified = !!(P.isVerified && P.isVerified()); } catch (_) {}
      let hasElevated = null;
      try { hasElevated = !!(P.hasRole && P.hasRole('admin')); } catch (_) {}
      try { ret = P.getAdminContext(); } catch (_) {}
      try { after = sessionStorage.getItem('sokoniAdminContext'); } catch (_) {}
      document.documentElement.setAttribute('data-sk-race',
        JSON.stringify({ before, ret, after, verified, hasElevated }));
    }, 5);

    /* ── DOM handshake, because page.evaluate cannot reach this ──────────────
       The safety row below first read window.SokoniPermissions straight from
       page.evaluate. That runs in an ISOLATED WORLD: the module is invisible there,
       every call returned undefined, and the row passed while measuring nothing at
       all. So the main world answers on request instead — the isolated world only
       raises a flag and reads the reply. */
    const ask = setInterval(() => {
      if (!document.documentElement.hasAttribute('data-fx-ask-ctx')) return;
      const P = window.SokoniPermissions;
      if (!P || typeof P.getAdminContext !== 'function') return;
      clearInterval(ask);
      const out = { verified: null, hasSuper: null, ret: null, mirror: null };
      try { out.verified = !!(P.isVerified && P.isVerified()); } catch (_) {}
      try { out.hasSuper = !!(P.hasRole && P.hasRole('superAdmin')); } catch (_) {}
      try { out.ret = P.getAdminContext(); } catch (_) {}
      try { out.mirror = sessionStorage.getItem('sokoniAdminContext'); } catch (_) {}
      document.documentElement.setAttribute('data-fx-ctx-answer', JSON.stringify(out));
    }, 60);
  });

  /* permCache is what makes this deterministic: it puts isVerified() true and
     _verifiedThisLoad false at the same instant, which is precisely the window.
     Without it the probe raced the token and hit the bug only on some loads. */
  await setScenario(page, { claims: ['admin'], ctx: 'admin', lsroles: ['buyer'],
    permCache: ['user', 'admin'], tokenDelayMs: 2500 });
  await page.goto(ORIGIN + '/cart.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sk-race'),
    null, { timeout: 20000 }).catch(() => {});
  const race = JSON.parse(await page.getAttribute('html', 'data-sk-race') || '{}');

  ck('RIG  CONTROL the early call landed INSIDE the race window',
    race.before === 'admin' && race.verified === true && race.hasElevated === false,
    'mirror before=' + JSON.stringify(race.before)
    + ' isVerified()=' + race.verified + ' hasRole(admin)=' + race.hasElevated
    + '  (the window is verified=true with hasRole=false)');
  ck('R4   an early getAdminContext() does NOT erase a valid context',
    race.after === 'admin',
    'mirror after the call=' + JSON.stringify(race.after)
    + ' returned=' + JSON.stringify(race.ret));

  /* ══ 4. THE SAFETY MUST SURVIVE THE FIX ══════════════════════════════════
     Not-verified must stop being read as unauthorized WITHOUT the accessor
     becoming permissive. A context the account genuinely does not hold must still
     be cleared once verification has actually happened. Without this row the fix
     would be indistinguishable from deleting the check. */
  await setScenario(page, { claims: ['admin'], ctx: 'superAdmin', lsroles: ['buyer'],
    permCache: null });
  await page.goto(ORIGIN + '/cart.html', { waitUntil: 'domcontentloaded' });
  /* Wait for verification to actually complete rather than sleeping at it. A fixed
     delay made this control read verified=false and the safety row below then passed
     vacuously, having measured a page that never verified anything. */
  await page.waitForFunction(() => {
    try {
      const st = JSON.parse(document.documentElement.getAttribute('data-sk-authstate') || '{}');
      return st.verified === true;
    } catch (_) { return false; }
  }, null, { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => document.documentElement.setAttribute('data-fx-ask-ctx', '1'));
  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-fx-ctx-answer'),
    null, { timeout: 20000 }).catch(() => {});
  const cleared = JSON.parse(await page.getAttribute('html', 'data-fx-ctx-answer') || '{}');
  ck('RIG  CONTROL verification really completed, and superAdmin is genuinely absent',
    cleared.verified === true && cleared.hasSuper === false,
    'verified=' + cleared.verified + ' hasRole(superAdmin)=' + cleared.hasSuper);
  ck('R5   CONTROL once VERIFIED, an unheld context is still cleared',
    cleared.ret == null && cleared.mirror == null,
    'returned=' + JSON.stringify(cleared.ret) + ' mirror=' + JSON.stringify(cleared.mirror));

  /* ══ 5. ROLE SWITCH = CHANGE ROLE + GO TO THAT ROLE'S WORKSPACE ══════════
     The requirement is that a switch ROUTES, not merely relabels. Driven through
     the profile menu exactly as a person would, from a page that is nobody's hub,
     and asserted on where the browser actually ended up. */
  const HUB_EXPECT = { seller: 'merchant', rider: 'driver', provider: 'providers' };
  const routed = [];
  for (const role of Object.keys(HUB_EXPECT)) {
    await setScenario(page, { claims: ['seller', 'rider', 'provider'], ctx: '',
      lsroles: ['buyer', 'seller', 'rider', 'provider'] });
    await page.goto(ORIGIN + '/cart.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3200);
    await page.evaluate(() => {
      const a = document.getElementById('sk-nav-avatar');
      if (a) a.click();
    });
    await page.waitForTimeout(500);
    /* Prefer the data attribute; fall back to the onclick spelling. The attribute is
       NEW in this slice, so an attribute-only selector would fail on a pre-change
       tree and report "routing broken" when the truth is "the probe could not find
       the button". This row is about where a switch GOES, not how it is labelled. */
    const clicked = await page.evaluate((r) => {
      const root = document.getElementById('sk-acct-popup');
      if (!root) return false;
      let el = root.querySelector('[data-sk-workspace="' + r + '"]');
      if (!el) {
        el = Array.prototype.find.call(
          root.querySelectorAll('button,a'),
          (n) => (n.getAttribute('onclick') || '').includes("_skSwitchRole('" + r + "')"));
      }
      if (!el) return false;
      el.click();
      return true;
    }, role);
    await page.waitForTimeout(4000);
    /* Strip the query AND the fragment before comparing. merchant.html adds its own
       #dashboard on arrival, so a hash-blind normaliser reported the seller hub as
       the wrong destination when the routing was exactly right. */
    const landed = page.url().split('?')[0].split('#')[0]
      .split('/').pop().replace(/\.html$/, '');
    routed.push({ role, clicked, landed });
  }

  ck('RIG  CONTROL every workspace entry was found and clicked',
    routed.every((x) => x.clicked),
    routed.map((x) => x.role + ':' + (x.clicked ? 'clicked' : 'NOT FOUND')).join('  '));
  ck('R6   a role switch ROUTES to that role\'s canonical workspace',
    routed.every((x) => x.landed === HUB_EXPECT[x.role]),
    routed.map((x) => x.role + ' -> ' + x.landed
      + (x.landed === HUB_EXPECT[x.role] ? '' : ' (want ' + HUB_EXPECT[x.role] + ')')).join('  '));

  /* ══ 6. ONE registry, and no role that switches to nowhere ════════════════ */
  const reg = await page.evaluate(() => {
    try { return JSON.parse(document.documentElement.getAttribute('data-sk-authstate') || '{}'); }
    catch (_) { return {}; }
  });
  const canon = reg.canonical || [];
  const hubs = reg.hubs || {};
  ck('R7   every canonical workspace role has a hub in the ONE registry',
    canon.length >= 9 && canon.every((r) => !!hubs[r]),
    canon.length + ' roles; missing: '
    + JSON.stringify(canon.filter((r) => !hubs[r])) + ' map=' + JSON.stringify(hubs));
  ck('R8   CONTROL the registry holds no administrative role',
    !('admin' in hubs) && !('superAdmin' in hubs) && !('moderator' in hubs),
    'keys=' + JSON.stringify(Object.keys(hubs)));

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows };
}
