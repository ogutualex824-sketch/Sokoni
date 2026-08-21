/* AFTER-PROOF — index seller predicate + expense-management role source.
   ==========================================================================
   Run:  node scripts/after-role-presentation.js

   Two small corrections from the role-contract triage (54fed88):

     script.js               THREE disagreeing seller predicates -> one resolver
     expense-management.html claims.role (never written) + a casing bug that
                             denied genuine Super Admins

   NEGATIVE CONTROL FIRST. Most rows assert an ABSENCE, and a dead pattern reports
   absence exactly like a fixed file. Every pattern is fired against the pre-fix
   source from git before anything is scored, and the run VOIDS if they do not.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT = path.join(__dirname, '..');
const BASE = '9bfc2f0';

const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

const read = (f) => strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const readPre = (f) => {
  try { return strip(execSync('git show ' + BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })); }
  catch (_) { return ''; }
};

const js = read('script.js'), jsPre = readPre('script.js');
const em = read('expense-management.html'), emPre = readPre('expense-management.html');

/* Patterns that must FIRE on the pre-fix source. */
const GONE = [
  { f: 'script.js', name: 'registeredAs?.seller predicate',
    re: /registeredAs\?\.\s*seller/, now: js, pre: jsPre },
  { f: 'script.js', name: 'five-way mirror chain (x2)',
    re: /isSeller\s*\|\|\s*\w+\.role === 'seller'\s*\|\|\s*\w+\.registeredAs === 'seller'/, now: js, pre: jsPre },
  { f: 'expense-management.html', name: 'un-normalised role compare',
    re: /const role = claims\.role \|\| data\.role \|\| ''/, now: em, pre: emPre },
];

console.log('\n  role presentation — after-proof\n');
console.log('  ── negative control (pre-fix source from ' + BASE + ')');
ck('pre-fix sources readable', jsPre.length > 1000 && emPre.length > 1000,
  'script.js ' + jsPre.length + ' / expense ' + emPre.length);
const fired = GONE.filter((g) => g.re.test(g.pre));
ck('every "gone" pattern FIRES on the pre-fix source',
  fired.length === GONE.length, fired.length + ' of ' + GONE.length
    + (fired.length < GONE.length ? ' — MISSING: '
      + GONE.filter((g) => !fired.includes(g)).map((g) => g.name).join(', ') : ''));
if (fired.length !== GONE.length || jsPre.length < 1000) {
  console.log('\n  RUN VOID — the detector cannot be shown to work.\n');
  process.exit(1);
}

console.log('\n  ── script.js: one predicate, not three');
for (const g of GONE.filter((x) => x.f === 'script.js')) {
  ck(g.name.padEnd(34) + ' absent', !g.re.test(g.now), '');
}
ck('_skIsSeller resolver is defined once', (js.match(/function _skIsSeller/g) || []).length === 1, '');
ck('all three sites now call it',
  (js.match(/_skIsSeller\(/g) || []).length >= 3,
  (js.match(/_skIsSeller\(/g) || []).length + ' call site(s)');
ck('it asks the AUTHORITY first', /SokoniRoleAuthority[\s\S]{0,180}isApproved\('seller'\)/.test(js), '');
/* The mirror union must still cover BOTH registeredAs shapes, or the fix would
   deny someone the old code allowed. */
ck('the fallback covers registeredAs as a STRING', /ra === 'seller'/.test(js), '');
ck('the fallback covers registeredAs as an OBJECT', /ra && ra\.seller === true/.test(js), '');
ck('the fallback keeps every old condition',
  ['isSeller', "role === 'seller'", 'sellerActive', 'storeName'].every((c) => js.includes(c)), '');

console.log('\n  ── expense-management: canonical source + casing');
ck('un-normalised compare absent', !/const role = claims\.role \|\| data\.role \|\| ''/.test(em), '');
ck('role string is lowercased before comparing', /roleStr = String\([\s\S]{0,60}\)\.toLowerCase\(\)/.test(em), '');
ck('the BOOLEAN claims are consulted',
  /claims\.admin === true \|\| claims\.superAdmin === true/.test(em), '');
ck('the deny branch honours the claim', /!hasAdminClaim && !\[/.test(em), '');
ck('isManager honours the claim', /isManager\s*=\s*hasAdminClaim \|\|/.test(em), '');
/* Widening only: nothing that previously passed may now fail. */
ck('every previously-accepted role string is still accepted',
  ['seller', 'admin', 'superadmin', 'manager'].every((r) => em.includes("'" + r + "'")), '');

console.log('\n  ── nothing else moved');
ck('no Firestore rule referenced', !/firestore\.rules/.test(js) && !/firestore\.rules/.test(em), '');
ck('no claim is written anywhere', !/setCustomUserClaims/.test(js) && !/setCustomUserClaims/.test(em), '');
ck('script.js parses', (() => { try { new (require('vm').Script)(fs.readFileSync(path.join(ROOT,'script.js'),'utf8')); return true; } catch (e) { return false; } })(), '');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  Static. Both changes are PRESENTATION and client-side guards — Firestore');
console.log('  rules remain the boundary that decides what may actually happen.\n');
process.exit(fail ? 1 : 0);
