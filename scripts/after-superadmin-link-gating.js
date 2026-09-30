/* AFTER-PROOF — no admin-only principal is offered a Super Admin dead end.
   ==========================================================================
   Run:  node scripts/after-superadmin-link-gating.js

   THE REGRESSION THIS CLOSES
   Before e1cc06a, admin.html's sidebar linked to superadmin.html, which admitted
   `superAdmin || admin` and adapted internally. The RBAC comment said so:
   "always visible but highlighted for superAdmin" — dimmed for an Admin, but
   clickable, and the target let them in.

   Retiring superadmin.html repointed that link to super-admin.html, which requires
   claims.superAdmin === true. The link kept its dimmed-but-clickable behaviour, so
   an ordinary Admin pressing it lands on

       "This account does not carry the Super Admin role."

   which is exactly the denial reported from a live Admin session. admin-os.html had
   two more links to the same place with no gating at all.

   THE INVARIANT
     admin only            -> /admin.html          Super Admin controls NOT offered
     superAdmin            -> /super-admin.html    offered
     admin + superAdmin    -> /super-admin.html    offered

   Every remaining route to super-admin.html must be gated on the CLAIM, or be
   unreachable without one.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('\n  Super Admin link gating — after-proof\n');

/* ── admin.html ── */
const admin = read('admin.html');
console.log('  ── admin.html sidebar');
ck('the link is HIDDEN when the claim is absent',
  /superLink\.style\.display = isSuperAdmin \? 'flex' : 'none'/.test(admin), '');
ck('the old dimmed-but-clickable behaviour is gone',
  !/superLink\.style\.opacity = isSuperAdmin \? '1' : '0\.5'/.test(admin), '');
ck('it still points at the canonical surface',
  /<a href="super-admin\.html"[^>]*id="link-superadmin"/.test(admin), '');

/* ── admin-os.html ── */
const aos = read('admin-os.html');
const aosJs = read('sokoni-aos.js');
console.log('\n  ── admin-os.html');
const marked = (aos.match(/data-requires-superadmin/g) || []).length;
/* Derived from the document, not a fixed count: the dashboard quick-link grid was
   removed (one primary path per destination, 2026-09-30), so the number of Super
   Admin links is whatever admin-os.html carries. The contract is that EVERY one of
   them is marked, plus the CSS rule that hides them — that is links + 1. */
const saLinks = (aos.match(/href="super-admin.html"/g) || []).length;
ck('every Super Admin link is marked (plus the CSS rule)', saLinks >= 1 && marked >= saLinks + 1, marked + ' occurrence(s) for ' + saLinks + ' link(s) incl. the CSS rule');
ck('a CSS rule hides them without the claim',
  /body:not\(\.is-super\) \[data-requires-superadmin\]\{display:none/.test(aos), '');
/* The gate is only real if something actually sets that class from a verified claim. */
ck('body.is-super is set from the VERIFIED claim, not from a mirror',
  /tok\.claims\.superAdmin/.test(aosJs) && /classList\.add\("is-super"\)/.test(aosJs),
  'sokoni-aos.js');
ck('no super-admin link in admin-os is left unmarked',
  (aos.match(/href="super-admin\.html"/g) || []).length
    === (aos.match(/data-requires-superadmin href="super-admin\.html"/g) || []).length,
  (aos.match(/href="super-admin\.html"/g) || []).length + ' link(s)');

/* ── every OTHER route to the surface ── */
console.log('\n  ── every other route is claim-gated or unreachable without the claim');
const perms = read('sokoni-permissions.js');
ck('adminHomeFor() returns it only for hasRole(superAdmin)',
  /if \(hasRole\('superAdmin'\)\) return 'super-admin\.html';/.test(perms), '');
/* 2026-09-30: the account popup + role switcher were factored out of shared-header.js into
   sokoni-profile-menu.js (one implementation, mounted by shared-header pages AND merchant-v2).
   The renderer moved; the property did not. Read BOTH files so a future move back cannot
   silently drop the check either way. */
const header = read('sokoni-profile-menu.js') + '\n' + read('shared-header.js');
/* This matched the RETIRED standalone switcher's spelling. That control and its
   builder are gone, so the pattern went missing and the row failed — while the
   property it exists to protect held perfectly well in the live account popup, one
   function away. A detector pinned to dead code reports its own deletion as a
   regression. Re-pointed at the live renderer, and widened: EVERY Super Admin entry
   pushed anywhere in this file must be guarded by hasRole('superAdmin'). */
const superPushes = header.match(/_adminEntries\.push\(\{ r: 'superAdmin'/g) || [];
const guardedSuperPushes =
  header.match(/hasRole\('superAdmin'\)\)\s*_adminEntries\.push\(\{ r: 'superAdmin'/g) || [];
ck('the role dropdown renders it only for hasRole(superAdmin)',
  superPushes.length > 0 && superPushes.length === guardedSuperPushes.length,
  guardedSuperPushes.length + ' of ' + superPushes.length + ' Super Admin entries claim-guarded');
const nav = read('sokoni-nav-engine.js');
ck('the nav engine keys it under the superAdmin role',
  /superAdmin: 'super-admin\.html'/.test(nav), '');
ck('the surface itself still requires the claim (defence in depth)',
  /guard\('superAdmin'\)/.test(read('super-admin.html')), '');

/* Routes that remain OPEN are recorded, not silently accepted. */
console.log('\n  ── recorded, not gated');
const idx = read('index.html');
ck('index.html 9-tap easter egg still navigates there (guard refuses)',
  /taps >= 9[\s\S]{0,120}super-admin\.html/.test(idx),
  'anyone can reach the URL; the page denies — recorded, not a link a user is OFFERED');
const profile = read('profile.html');
ck('profile.html superAdminLink starts hidden',
  /id="superAdminLink"[^>]*display:none/.test(profile), 'shown conditionally');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  A control that cannot succeed should not be offered. Typing the URL still');
console.log('  reaches the guard, which is the boundary — this is about not handing an');
console.log('  administrator a button that is guaranteed to refuse them.\n');
process.exit(fail ? 1 : 0);
