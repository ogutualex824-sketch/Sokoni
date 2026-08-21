/* AFTER-PROOF — retirement of superadmin.html.
   ==========================================================================
   Run:  node scripts/after-superadmin-retirement.js

   Pairs with docs/ADMIN_SURFACE_RECONCILIATION.md (before-proof, f74068b), which
   established super-admin.html as canonical, found no unique capability in
   superadmin.html, and confirmed its apparent setUserRole escalation is refused
   server-side by _requireSuperAdmin.

   WHY A PAGE REFERENCE IS NOT ONE STRING
   The before-proof enumerated five callers by grepping `superadmin.html`. That
   missed two, and both were found only by widening the pattern during removal:

     service-worker.js   precached the cleanUrls form "/superadmin"
     firebase.json       matched the path segment inside an @(...) alternation

   So this proof searches for the PAGE in all three spellings — `superadmin.html`,
   `/superadmin`, and bare `superadmin` inside a route alternation — while excluding
   the ROLE string `superadmin`, which appears in ~20 unrelated authorization checks
   and is a different concern entirely.

   CONTROLS
   * The searcher must still find the surviving canonical page, or a scanner that
     matches nothing would report a clean estate either way.
   * The role-string exclusion must not be so wide that it hides a real page
     reference: a synthetic page reference is injected and must be caught.
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
const SKIP = /^(node_modules|\.git|docs|scripts)([\\/]|$)|^CHANGELOG\.md$/;

function sources() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.relative(ROOT, path.join(d, e.name)).replace(/\\/g, '/');
      if (SKIP.test(rel)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(js|mjs|cjs|html|json)$/.test(e.name)) out.push(p);
    }
  }(ROOT));
  return out;
}

/* A reference to the PAGE, in any spelling this repo actually uses. The role string
   'superadmin' inside a quoted list of roles is excluded — it is a separate
   inconsistency (lowercase role vs the superAdmin claim) and not this slice. */
function pageRefs(src) {
  const hits = [];
  const lines = src.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/superadmin\.html/i.test(l)) { hits.push({ n: i + 1, why: 'superadmin.html', l }); return; }
    if (/["'`]\/superadmin\b/.test(l)) { hits.push({ n: i + 1, why: '/superadmin route', l }); return; }
    if (/@\([^)]*\bsuperadmin\b[^)]*\)/.test(l)) { hits.push({ n: i + 1, why: 'route alternation', l }); }
  });
  return hits;
}

console.log('\n  superadmin.html retirement — after-proof\n');

console.log('  ── the file is gone');
ck('superadmin.html no longer exists', !fs.existsSync(path.join(ROOT, 'superadmin.html')), '');
ck('super-admin.html survives', fs.existsSync(path.join(ROOT, 'super-admin.html')), '');

console.log('\n  ── zero page references remain');
const files = sources();
let all = [];
for (const f of files) {
  let s = ''; try { s = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  for (const h of pageRefs(s)) all.push(path.relative(ROOT, f).replace(/\\/g, '/') + ':' + h.n + '  (' + h.why + ')');
}
ck('no source file references the retired page', all.length === 0,
  all.length ? all.slice(0, 6).join(' | ') : 'scanned ' + files.length + ' file(s)');

/* CONTROL: the searcher must find the page that DID survive. */
let canonHits = 0;
for (const f of files) {
  let s = ''; try { s = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  if (/super-admin\.html/.test(s)) canonHits++;
}
ck('CONTROL the searcher finds the surviving canonical page', canonHits > 0,
  'super-admin.html in ' + canonHits + ' file(s)');

/* CONTROL: the role-string exclusion must not hide a real page reference. */
const synthetic = 'const x = { href: "superadmin.html" };\nconst role = ["admin","superadmin"];\n';
const caught = pageRefs(synthetic);
ck('CONTROL a synthetic page reference is caught', caught.length === 1, caught.length + ' hit(s)');
ck('CONTROL the ROLE string alone is NOT reported',
  pageRefs('const roles = ["admin","superadmin"];').length === 0, '');

console.log('\n  ── the canonical destination is unchanged');
const perms = fs.readFileSync(path.join(ROOT, 'sokoni-permissions.js'), 'utf8');
ck('adminHomeFor() still resolves superAdmin to super-admin.html',
  /hasRole\('superAdmin'\)\)\s*return\s*'super-admin\.html'/.test(perms), '');
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
ck('the admin.html sidebar link now points at the canonical page',
  /<a href="super-admin\.html"[^>]*id="link-superadmin"/.test(adminHtml), '');
ck('its RBAC styling hook survived the repoint',
  /getElementById\('link-superadmin'\)/.test(adminHtml), '');

console.log('\n  ── retirement did not strip a security header');
/* firebase.json applied no-store + noindex to @(login|signup|admin|superadmin).
   super-admin was NOT in that alternation, so deleting the entry would have taken
   those headers off the surviving surface. It was REPOINTED, not dropped. */
const fbj = fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8');
ck('hosting header rules now name super-admin',
  (fbj.match(/@\(login\|signup\|admin\|super-admin\)/g) || []).length === 2,
  (fbj.match(/@\(login\|signup\|admin\|super-admin\)/g) || []).length + ' of 2');
ck('those rules still carry no-store', /no-store, no-cache, must-revalidate, private/.test(fbj), '');
ck('firebase.json is valid JSON', (() => { try { JSON.parse(fbj); return true; } catch (_) { return false; } })(), '');
ck('navigation-registry.json is valid JSON', (() => {
  try { JSON.parse(fs.readFileSync(path.join(ROOT, 'navigation-registry.json'), 'utf8')); return true; }
  catch (_) { return false; }
})(), '');

console.log('\n  ── CACHE_VERSION untouched (the predeploy bump owns it)');
const sw = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
ck('service-worker.js still declares a CACHE_VERSION', /CACHE_VERSION/.test(sw), '');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
console.log('  Source-level proof. It does not prove production behaviour — the retired');
console.log('  route is still live until a deploy, and this branch is undeployed.\n');
process.exit(fail ? 1 : 0);
