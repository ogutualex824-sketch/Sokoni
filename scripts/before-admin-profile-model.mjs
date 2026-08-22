/* BEFORE-PROOF — the administrative surfaces do not yet carry the profile model.
   ==========================================================================
   Run:  node <scratchpad>/serve.js <worktree> 8901
         node <browser-skill>/browser.mjs "http://127.0.0.1:8901/admin.html" \
              --script ./scripts/before-admin-profile-model.mjs

   THE SPECIFIED MODEL
     Administrative pages carry NO shared marketplace header, and their top-right
     profile button is the single dropdown entry point — replacing the standalone
     Sign Out control.

   This measures what admin.html, super-admin.html and admin-os.html do TODAY, so
   the after-proof is an improvement over a measurement rather than over a claim.

   ── HOW TO READ IT ────────────────────────────────────────────────────────
   A B-row PASSES when the DEFECT IS PRESENT. So:

     against a PRE-CHANGE tree   11 / 0    every defect present  <- the baseline
     against the CHANGED tree     6 / 5    every B-row fails     <- defects gone

   The RIG rows must stay green in both, or the run measured nothing. Point it at a
   pre-change tree with SK_ORIGIN, e.g.

     git worktree add --detach /c/temp/sok-before <pre-change-sha>
     node <scratchpad>/serve.js /c/temp/sok-before 8902
     SK_ORIGIN=http://127.0.0.1:8902 node <browser>/browser.mjs \
       "http://127.0.0.1:8902/offline.html" --script ./scripts/before-admin-profile-model.mjs

   A detached worktree rather than a stash: the stash stack is repo-wide across
   worktrees and another process writes this repo.

   The fixture, and why the first version of this file was VOID, is documented in
   scripts/lib/admin-fixture.mjs.
==========================================================================*/

import {
  installFixture, stubFirebaseModule, setScenario, primeOrigin, open, read,
} from './lib/admin-fixture.mjs';

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

  await stubFirebaseModule(page);
  await installFixture(page);
  await primeOrigin(page);
  await setScenario(page, {
    claims: ['admin', 'superAdmin', 'seller', 'rider'], ctx: 'admin',
    lsroles: ['buyer', 'seller', 'rider'],
  });

  /* ── admin.html ─────────────────────────────────────────────────────────── */
  const landedA = await open(page, 'admin.html', { wait: 5000 });
  const a = await read(page);

  /* CONTROLS FIRST. Without these the rows below cannot distinguish "the page does
     X" from "we are standing on some other page entirely" — which is exactly how
     the first run of this harness reported four confident results from the
     marketplace home and the login screen. */
  ck('RIG  CONTROL we are on admin.html, not a redirect target',
    landedA.ok, 'landed=' + landedA.landed);
  ck('RIG  CONTROL the fixture claims actually verified',
    a.verified === true && a.hasAdmin === true && a.hasSuper === true,
    'verified=' + a.verified + ' admin=' + a.hasAdmin + ' super=' + a.hasSuper);
  ck('RIG  CONTROL the surface opened rather than denying',
    a.deny === false && a.authGateShown === false,
    'deny=' + a.deny + (a.denyTitle ? ' (' + a.denyTitle + ')' : '')
    + ' authGate=' + a.authGateShown);

  ck('B1   DEFECT admin.html renders the shared MARKETPLACE header',
    a.sharedHeader === true,
    'sk-top-nav=' + a.sharedHeader + ' sk-nav-avatar=' + a.sharedAvatar);
  ck('B2   DEFECT admin.html has no administrative profile dropdown',
    a.menuExists === false, 'sk-admin-profile-menu=' + a.menuExists);

  /* ── super-admin.html ───────────────────────────────────────────────────── */
  await setScenario(page, {
    claims: ['admin', 'superAdmin', 'seller', 'rider'], ctx: 'superAdmin',
    lsroles: ['buyer', 'seller', 'rider'],
  });
  const landedS = await open(page, 'super-admin.html', { wait: 5000 });
  const s = await read(page);
  ck('RIG  CONTROL we are on super-admin.html, not a redirect target',
    landedS.ok, 'landed=' + landedS.landed);
  ck('RIG  CONTROL super-admin opened rather than denying',
    s.deny === false && s.authGateShown === false,
    'deny=' + s.deny + (s.denyTitle ? ' (' + s.denyTitle + ')' : '')
    + ' authGate=' + s.authGateShown);

  ck('B3   DEFECT super-admin.html shows MORE THAN ONE Sign Out control',
    s.signOuts.length > 1, s.signOuts.length + ' visible: ' + JSON.stringify(s.signOuts));
  ck('B4   DEFECT super-admin.html offers a bare <select>, not a profile dropdown',
    s.legacySelect === true && s.menuExists === false,
    'select=' + s.legacySelect + ' menu=' + s.menuExists);

  /* ── admin-os.html ──────────────────────────────────────────────────────── */
  await setScenario(page, {
    claims: ['admin', 'superAdmin', 'seller', 'rider'], ctx: 'admin',
    lsroles: ['buyer', 'seller', 'rider'],
  });
  const landedO = await open(page, 'admin-os.html', { wait: 5000 });
  const o = await read(page);
  ck('RIG  CONTROL we are on admin-os.html, not a redirect target',
    landedO.ok, 'landed=' + landedO.landed);
  /* This row first read "admin-os.html loads sokoni-admin-entry.js and mounts
     NOTHING", from a grep of admin-os.html alone. It does mount — the call lives in
     sokoni-aos.js, one file away. A page-scoped grep answered a question that spans
     two files, and answered it wrongly. What is actually true before the change is
     that admin-os shows the legacy bar AND keeps its own Sign Out. */
  ck('B5   DEFECT admin-os.html shows the legacy bar and keeps its own Sign Out',
    o.legacyBar === true && o.signOutsPage > 0,
    'controls=' + o.legacyBar + ' page-owned signouts=' + JSON.stringify(o.signOuts));

  const passed = rows.filter((r) => r.ok).length;
  return { passed, failed: rows.length - passed, rows,
    raw: { admin: a, superAdmin: s, adminOs: o } };
}
