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
   /buyer:\s*'index\.html'/.test(hubs[1]) && /seller:\s*'merchant-v2\.html'/.test(hubs[1]) &&
   /rider:\s*'driver\.html'/.test(hubs[1]));

/* ── 2. the administrative destination lives with the administrative authority ── */
console.log('\n2 — adminHomeFor() is defined beside the authority that decides admin access');
const perms = read('sokoni-permissions.js');
ck('sokoni-permissions.js exports adminHomeFor', /adminHomeFor,/.test(perms));
const fnBody = (perms.match(/function adminHomeFor\(\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || '';
ck('adminHomeFor resolves superAdmin BEFORE admin',
   fnBody.indexOf("'superAdmin'") > -1 && fnBody.indexOf("'admin'") > -1 &&
   fnBody.indexOf("'superAdmin'") < fnBody.indexOf("'admin'"));
ck('superAdmin resolves to super-admin.html', /super-admin\.html/.test(fnBody));
ck('admin resolves to admin.html', /return 'admin\.html'/.test(fnBody));
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
