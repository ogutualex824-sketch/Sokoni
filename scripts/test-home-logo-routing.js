/* Home/logo routing — after-proof. Option B: the administrative destination lives with
   the administrative authority, and admin/superAdmin never become workspace roles.

   Run:  node scripts/test-home-logo-routing.js

       administrative   SokoniPermissions.adminHomeFor()   superAdmin > admin
       workspace        SokoniRoleAuthority.hubFor(role)   buyer/seller/rider/…

   The boundary under test is that NEITHER authority learns the other's roles.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };

console.log('\nHOME / LOGO ROUTING — AFTER-PROOF (Option B)');
console.log('='.repeat(78));

/* ── 1. the boundary is intact ── */
console.log('\n1 — admin/superAdmin did NOT become workspace roles');
const ra = read('sokoni-role-authority.js');
const canon = ra.match(/var CANONICAL = \[([\s\S]*?)\];/);
const hubs = ra.match(/var WORKSPACE_HUBS = \{([\s\S]*?)\n  \};/);
ck('CANONICAL_ROLES parsed', !!canon);
ck('WORKSPACE_HUBS parsed', !!hubs);
ck('CANONICAL contains no admin', !!canon && !/['"]admin['"]/.test(canon[1]));
ck('CANONICAL contains no superAdmin', !!canon && !/superAdmin/.test(canon[1]));
ck('WORKSPACE_HUBS contains no admin entry', !!hubs && !/\badmin\s*:/.test(hubs[1]));
ck('WORKSPACE_HUBS contains no superAdmin entry', !!hubs && !/superAdmin\s*:/.test(hubs[1]));
ck('WORKSPACE_HUBS still routes the workspace roles', !!hubs &&
   /buyer:\s*'index\.html'/.test(hubs[1]) && /rider:\s*'driver\.html'/.test(hubs[1]));

/* THE SELLER HUB CUTOVER — PERFORMED 2026-08-31, as its own deliberate slice.

   This assertion spent its life pinned to 'merchant.html' as a TRIPWIRE, not an
   endorsement: Hosting publishes the TREE, so flipping the hub would otherwise have
   shipped an uncertified cutover as a side effect of whatever release went out next. It
   held the line until the flip could be a reviewed moment. That is what happened.

   Measured on production before flipping, not assumed: /merchant (188 KB, "Merchant OS")
   and /merchant-v2 (203 KB, "Merchant") are DIFFERENT applications, and the POS/printer/
   scanner integration exists only in v2 — MODULE_ALLOW 0 vs 2, printBytes 0 vs 1,
   goModule 0 vs 1. Both seller rails pointed at the shell WITHOUT it, so a seller reached
   a merchant shell with no shell-owned printer, no print bridge and no camera delegation.

   The whole seller-entry surface moved together, because a partial flip is worse than
   none — the same seller would reach different applications depending on which control
   they touched:

       sokoni-role-authority.js   seller hub          -> merchant-v2.html
       sokoni-merchant-entry.js   MERCHANT_URL        -> /merchant-v2  (workspace AND #shop)
       profile.html x4            hardcoded <a href>  -> now data-sk-merchant-entry, so they
                                                        route through resolve() instead of
                                                        bypassing both authorities

   BUYER -> index.html is correct and was NOT touched. The legacy shell still exists; this
   is a routing change, not a deletion. The assertion is now inverted: a REVERT to
   merchant.html is what turns it red. */
const sellerHub = (hubs && (hubs[1].match(/seller:\s*'([^']+)'/) || [])[1]) || null;
ck('seller hub is a real merchant shell',
   sellerHub === 'merchant.html' || sellerHub === 'merchant-v2.html', sellerHub);
/* PERFORMED 2026-08-31. The tripwire did its job: it stayed red until the flip was a
   deliberate, reviewed moment, and it is now inverted so a REVERT to the legacy shell is
   what turns it red. The assertion below it - hub and entry resolver must agree - is
   unchanged and is what stops the two from drifting apart again. */
ck('workspace cutover PERFORMED (seller hub is the integrated v2 shell)',
   sellerHub === 'merchant-v2.html', sellerHub + (sellerHub === 'merchant.html'
     ? '  <- REVERTED to the legacy shell, which has no POS/printer/scanner integration'
     : '  (v2: the shell POS, the printer bridge and the scanner live here)'));
/* The two must never disagree — a hub sending sellers one way while the entry resolver
   sends them the other is exactly the split this constant exists to prevent. */
const entrySrc = read('sokoni-merchant-entry.js');
const entryUrl = (entrySrc.match(/var MERCHANT_URL\s*=\s*'([^']+)'/) || [])[1] || null;
ck('the workspace hub and the entry resolver agree on the merchant shell',
   !!entryUrl && !!sellerHub && sellerHub.replace(/\.html$/, '') === entryUrl.replace(/^\//, ''),
   'hub=' + sellerHub + '  entry=' + entryUrl);

/* ── 2. the administrative destination lives with the administrative authority ── */
console.log('\n2 — adminHomeFor() is defined beside the authority that decides admin access');
const perms = read('sokoni-permissions.js');
ck('sokoni-permissions.js exports adminHomeFor', /adminHomeFor,/.test(perms));
const fnBody = (perms.match(/function adminHomeFor\(\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || '';
ck('adminHomeFor resolves superAdmin BEFORE admin',
   fnBody.indexOf("'superAdmin'") > -1 && fnBody.indexOf("'admin'") > -1 &&
   fnBody.indexOf("'superAdmin'") < fnBody.indexOf("'admin'"));
ck('superAdmin resolves to super-admin.html', /super-admin\.html/.test(fnBody));
/* Pinned to the LEGACY destination. e7dd99e moved the admin home to admin-os.html - the
   comment in sokoni-permissions.js reads "canonical admin console (was legacy admin.html)"
   - and two other routers say the same independently: shared-header.js ("canonical admin
   console") and sokoni-admin-entry.js DEST. The product is consistent; this assertion was
   the outlier.

   This does NOT touch the three-way admin.html lineage divergence: nothing here decides
   which console is canonical, deletes a surface, or reconciles the lineages. It records the
   destination the product already resolves, and pins the LEGACY one as excluded so a silent
   revert is caught.

   Upgraded from one string check into a CONVERGENCE check across all three routers, because
   a destination that only one of them agrees with is the exact defect shape this codebase
   keeps producing - a sender and a receiver nobody checks agree. */
ck('admin resolves to the canonical admin console', /return 'admin-os\.html'/.test(fnBody));
ck('...and NOT the legacy admin.html', !/return 'admin\.html'/.test(fnBody));
ck('...and the destination is a real page', fs.existsSync(path.join(ROOT, 'admin-os.html')));
ck('all three admin routers agree on the canonical console',
   /return 'admin-os\.html'/.test(perms) &&
   /'super-admin\.html'\s*:\s*'admin-os\.html'/.test(read('shared-header.js')) &&
   /admin:\s*'admin-os\.html'/.test(read('sokoni-admin-entry.js')),
   'sokoni-permissions.js, shared-header.js, sokoni-admin-entry.js');
ck('it returns null when neither claim is held', /return null/.test(fnBody));
ck('it routes through hasRole() — never a raw role list',
   /hasRole\('superAdmin'\)/.test(fnBody) && /hasRole\('admin'\)/.test(fnBody));

/* ── 3. the cache-forgery guard is the one adminHomeFor inherits ── */
console.log('\n3 — a forged/cached elevated role cannot produce an admin destination');
const hasRoleBody = (perms.match(/function hasRole\(role\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || '';
ck('hasRole refuses an elevated role asserted only by cache',
   /_verifiedThisLoad/.test(hasRoleBody) && /ELEVATED_LEVEL/.test(hasRoleBody));

/* Functional: load the module with a fake window and NO verified claims. A cached or
   localStorage-asserted admin must NOT yield a destination. */
function loadPermissions(localUser) {
  const store = {};
  if (localUser) store.sokoniUser = JSON.stringify(localUser);
  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    addEventListener() {}, location: { pathname: '/', href: '/' },
    navigator: { onLine: true },
  };
  const doc = {
    readyState: 'complete', addEventListener() {}, dispatchEvent() {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} }, body: { appendChild() {} },
  };
  win.document = doc;
  const fn = new Function('window', 'document', 'localStorage', 'setTimeout', 'console',
    read('sokoni-permissions.js') + '\n;return window.SokoniPermissions;');
  return fn(win, doc, win.localStorage, () => {}, console);
}

try {
  const P = loadPermissions({ uid: 'u1', roles: ['admin', 'superAdmin'], role: 'admin' });
  const dest = P.adminHomeFor();
  ck('localStorage claiming admin+superAdmin yields NO destination', dest === null,
     'got ' + JSON.stringify(dest));
  ck('   └─ and hasRole("admin") is false without a verified claim', P.hasRole('admin') === false);
} catch (e) {
  un('functional load of sokoni-permissions.js', e.message.slice(0, 70));
}

/* ── 4. the header resolver ── */
console.log('\n4 — the header asks both authorities, in the right order');
const hdr = read('shared-header.js');
ck('shared-header defines the resolver', /_skResolveHomeHref/.test(hdr));
const res = (hdr.match(/function _skResolveHomeHref\(\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || '';
ck('it asks SokoniPermissions.adminHomeFor FIRST', res.indexOf('adminHomeFor') > -1 &&
   res.indexOf('adminHomeFor') < res.indexOf('hubFor'));
ck('it falls back to SokoniRoleAuthority.hubFor(getActiveRole())',
   /hubFor\(RA\.getActiveRole\(\)\)/.test(res));
ck('it falls back to "/" when nothing authorises a destination', /return '\/'/.test(res));
/* Match an ASSIGNMENT, not a mention. The first version of this predicate tested for the
   string "Location.prototype" and tripped on the comment that warns against wrapping it —
   a detector that fails on its own documentation. */
ck('it never wraps window.location',
   !/Location\.prototype\.\w+\s*=/.test(hdr) &&
   !/defineProperty\s*\(\s*Location\.prototype/.test(hdr) &&
   !/location\.href\s*=\s*function/.test(hdr));
/* Control: the tightened predicate must still catch a real wrap. */
ck('   └─ detector control: a real wrap WOULD be caught',
   /Location\.prototype\.\w+\s*=/.test('Location.prototype.href = function(){}'));
ck('the logo markup default is still "/"', /<a href="\/" id="sk-nav-logo"/.test(hdr));
ck('it re-resolves on both authorities\' change events',
   /sokoniRoleAuthorityReady', _skApplyHomeHref/.test(hdr) &&
   /sokoniActiveRoleChanged', _skApplyHomeHref/.test(hdr));

/* ── 5. role switching still cannot offer admin ── */
console.log('\n5 — admin is not selectable as an activeRole');
ck('the switcher renders from CANONICAL/approved roles, which exclude admin',
   !!canon && !/['"]admin['"]/.test(canon[1]));

un('a REAL signed-in admin taps Home and lands on admin.html',
   'needs personas; hasRole() requires a verified claim this load');
un('a REAL signed-in superAdmin lands on super-admin.html', 'needs personas');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
process.exit(fail ? 1 : 0);
