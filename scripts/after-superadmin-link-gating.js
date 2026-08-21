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
ck('both Super Admin links are marked', marked >= 3, marked + ' occurrence(s) incl. the CSS rule');
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
const header = read('shared-header.js');
ck('the role dropdown renders it only for hasRole(superAdmin)',
  /P\.hasRole\('superAdmin'\)\) admin\.push\(\{ role: 'superAdmin'/.test(header), '');
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
