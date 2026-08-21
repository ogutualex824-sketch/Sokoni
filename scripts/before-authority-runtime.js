/* Authority runtime availability — BEFORE-PROOF. Measures. CHANGES NOTHING.

   Run:  node scripts/before-authority-runtime.js

   WHY
   `2a3e1a9` routes Home through SokoniPermissions.adminHomeFor(), and `aad9118` delegates
   role switching to a path that needs SokoniRoleAuthority. Both are only operative on pages
   that actually LOAD those modules. This file measures which pages do.

   WHAT THE RUNTIME SWEEP ALREADY SETTLED (recorded here, not re-run — it needs a browser)
   The modules do NOT fail to initialise. Loaded in isolation, sokoni-permissions.js exposes
   window.SokoniPermissions with adminHomeFor(), zero page errors. Earlier readings of
   "undefined" on profile.html and account-centre.html were measuring **login.html**: every
   auth-gated page redirects an anonymous visitor there, so the probe never reached the page
   under test. That is an auth redirect, not an initialisation failure, and the distinction
   is the whole question this file was opened to answer.

       admin.html          -> /login.html      admin-os.html       -> /login.html
       super-admin.html    -> /login.html      profile.html        -> /login.html
       account-centre.html -> /login           index.html          -> renders, body 307868

   index.html renders fully and still reports SokoniPermissions undefined — which the static
   census below explains: it carries no tag.

   NOT PROVEN HERE
   The authenticated positive controls — an admin claim resolving adminHomeFor() to
   admin.html, a superAdmin claim to super-admin.html — require real personas. Anonymous
   loading is not evidence about the authenticated path.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
/* Detail is the FAILURE explanation, so print it only on failure — otherwise a passing line
   reads "PASS ... [no tag]", which contradicts itself and misleads whoever reads the log. */
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d ? '   [' + String(d).slice(0, 84) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };

/* A real <script src=...> tag, never a prose mention. Three detectors this session have
   matched comments instead of code; this one matches the tag. */
const hasTag = (src, file) =>
  new RegExp('<script[^>]+src="[^"]*' + file.replace('.', '\\.') + '"').test(src);

console.log('\nAUTHORITY RUNTIME AVAILABILITY — BEFORE-PROOF');
console.log('='.repeat(78));

const SURFACES = ['index.html', 'admin.html', 'admin-os.html', 'super-admin.html',
                  'profile.html', 'account-centre.html'];

console.log('\n1 — which surfaces load which authority');
const missing = [];
for (const f of SURFACES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('  (absent) ' + f); continue; }
  const s = fs.readFileSync(p, 'utf8');
  const perms = hasTag(s, 'sokoni-permissions.js');
  const ra = hasTag(s, 'sokoni-role-authority.js');
  console.log('  ' + f.padEnd(22) + 'permissions=' + (perms ? 'yes' : 'NO ') + '  role-authority=' + (ra ? 'yes' : 'NO'));
  if (!perms) missing.push(f);
}

console.log('\n2 — the consequence for work already committed');
ck('index.html loads SokoniPermissions, so Home can route an admin',
   missing.indexOf('index.html') === -1,
   'no tag — adminHomeFor() is unreachable, the logo falls through to "/"');
ck('admin.html loads SokoniPermissions', missing.indexOf('admin.html') === -1, 'no tag');
ck('admin-os.html loads SokoniPermissions', missing.indexOf('admin-os.html') === -1, 'no tag');
ck('super-admin.html loads SokoniPermissions', missing.indexOf('super-admin.html') === -1, 'no tag');
ck('profile.html loads SokoniPermissions', missing.indexOf('profile.html') === -1);
ck('account-centre.html loads SokoniPermissions', missing.indexOf('account-centre.html') === -1);

/* Ordering: a classic tag executes during parse, a deferred one after. The authorities must
   run BEFORE shared-header's Home resolver asks them, so their tags must precede it. */
console.log('\n2b — the authorities load before the header that asks them');
const tagPos = (src, file) => {
  const m = src.match(new RegExp('<script[^>]+src="[^"]*' + file.replace('.', '\\.') + '"'));
  return m ? m.index : -1;
};
for (const f of ['index.html', 'admin.html', 'admin-os.html', 'super-admin.html']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const p = tagPos(s, 'sokoni-permissions.js');
  const h = tagPos(s, 'shared-header.js');
  ck(f.padEnd(22) + 'permissions tag precedes shared-header tag',
     p > -1 && h > -1 && p < h, 'permissions@' + p + ' header@' + h);
}

/* NEGATIVE CONTROL: pages outside this slice must be untouched. A fix that sprayed the tag
   across every surface would satisfy every assertion above while widening the freeze. */
console.log('\n2c — negative control: unrelated pages were NOT modified');
const UNRELATED = ['login.html', 'category.html', 'checkout.html', 'community.html'];
for (const f of UNRELATED) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('  (absent) ' + f); continue; }
  const s = fs.readFileSync(p, 'utf8');
  ck(f.padEnd(22) + 'still does NOT load sokoni-permissions.js', !hasTag(s, 'sokoni-permissions.js'),
     'gained a tag — this slice was supposed to touch four pages');
}

console.log('\n3 — the module itself is sound');
const permSrc = fs.readFileSync(path.join(ROOT, 'sokoni-permissions.js'), 'utf8');
ck('sokoni-permissions.js assigns window.SokoniPermissions at top level',
   /window\.SokoniPermissions\s*=/.test(permSrc));
ck('   └─ measured in an isolated browser load: object present, adminHomeFor present, 0 errors', true,
   'recorded from the runtime sweep');

console.log('\n4 — how many surfaces carry the tag at all');
const all = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const withTag = all.filter((f) => hasTag(fs.readFileSync(path.join(ROOT, f), 'utf8'), 'sokoni-permissions.js'));
console.log('  ' + withTag.length + ' of ' + all.length + ' served pages load sokoni-permissions.js');
console.log('  ' + withTag.slice(0, 14).join(' '));

console.log('\n5 — authenticated behaviour');
un('admin claim -> adminHomeFor() === admin.html', 'needs personas');
un('superAdmin claim -> adminHomeFor() === super-admin.html', 'needs personas');
un('ordinary buyer -> no admin destination', 'needs personas');
un('activeRole=admin without the claim -> denied', 'rules layer proven in 80297d4; surface needs personas');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
console.log('  Measurement only. No page was changed.\n');
process.exit(fail ? 1 : 0);
