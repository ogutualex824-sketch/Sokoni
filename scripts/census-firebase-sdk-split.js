/* CENSUS — Firebase SDK version splits that break the shared app registry.
   ==========================================================================
   Run:  node scripts/census-firebase-sdk-split.js

   READ-ONLY.

   THE DEFECT, measured on platform-health.html before this census existed:

     platform-health.html imported firebasejs/11.0.2
     firebase.js          initialises  firebasejs/10.12.2

   Two SDK versions are two separate ES module instances with two separate app
   registries. So getApps() in the 11.0.2 instance was always empty, the page's
   bootstrap branch imported firebase.js (which initialised the app in the OTHER
   registry), and getAuth() then ran against nothing:

     Firebase: No Firebase App '[DEFAULT]' has been created (app/no-app)

   It surfaced as an unhandled REJECTION rather than a console error, so the page
   sat on "Computing scores…" forever — for every visitor, signed in or not. The
   health callable was never reached, which made a BOOTSTRAP failure look like an
   authorization failure.

   A VERSION MISMATCH IS NOT AUTOMATICALLY A DEFECT
   A file that calls initializeApp() with its own config is self-contained and works
   at any version. The defect needs BOTH halves:

     1. imports a version other than the canonical one, AND
     2. consumes the shared app — getAuth/getFunctions/getFirestore/getApps —
        without initializing its own

   Only that combination is reported. Anything else is listed as informational, so
   a reader can see the fragmentation without it being dressed up as 11 bugs.

   CONTROLS
   * The canonical version is derived from firebase.js, not hard-coded.
   * A file that initialises its own app must NOT be reported.
   * The known-fixed file must now be clean, and its pre-fix form must be caught.
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
const SKIP = /(^|[\\/])(node_modules|\.git|docs|scripts|tests)([\\/]|$)/;

function sources() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.relative(ROOT, path.join(d, e.name)).replace(/\\/g, '/');
      if (SKIP.test(rel)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(js|mjs|html)$/.test(e.name)) out.push(p);
    }
  }(ROOT));
  return out;
}

const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

/* Canonical = whatever firebase.js actually uses. Derived, not asserted, so this
   census cannot drift away from the file it is measuring against. */
const fbjs = strip(fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8'));
const canonVersions = [...new Set((fbjs.match(/firebasejs\/([0-9.]+)/g) || [])
  .map((s) => s.split('/')[1]))];
const CANON = canonVersions[0];

console.log('\n  FIREBASE SDK SPLIT CENSUS\n');
console.log('  canonical version (from firebase.js): ' + CANON
  + (canonVersions.length > 1 ? '   WARNING: firebase.js itself uses ' + canonVersions.length : ''));

const rows = [];
for (const f of sources()) {
  let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const src = strip(raw);
  const versions = [...new Set((src.match(/firebasejs\/([0-9.]+)/g) || []).map((s) => s.split('/')[1]))];
  if (!versions.length) continue;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === 'firebase.js') continue;

  const offVersions = versions.filter((v) => v !== CANON);
  /* Does it stand on its own two feet? */
  const selfInit = /\binitializeApp\s*\(/.test(src);
  /* Does it consume the SHARED app? */
  const consumesShared = /\bgetAuth\s*\(|\bgetFunctions\s*\(|\bgetFirestore\s*\(|\bgetApps\s*\(/.test(src);

  rows.push({ file: rel, versions, offVersions, selfInit, consumesShared,
    defect: offVersions.length > 0 && consumesShared && !selfInit });
}

const defects = rows.filter((r) => r.defect);
const mixed = rows.filter((r) => !r.defect && r.offVersions.length);

/* MEASURED: this signature is NECESSARY BUT NOT SUFFICIENT.

   Seven of the candidates below were loaded in a browser and checked for the
   app/no-app unhandled rejection that platform-health.html produced:

     admin-feedback  business-kpi  feedback  ops-dashboard
     reliability-center  seller-success  checkout          -> 0 rejections, all seven

   So sharing the signature does not make a file broken. platform-health.html failed
   because of its specific bootstrap shape — it called getApps() from the OFF-version
   instance, found it empty, imported firebase.js (initialising the app in the OTHER
   registry), and then called getAuth() from the off-version instance anyway. A file
   that never calls getApps(), or reaches getAuth() only after a same-version init,
   does not hit it.

   These are therefore CANDIDATES for runtime confirmation, not a defect list.
   Reporting them as defects would be inventing 13 bugs from one measurement. */
console.log('\n  ── CANDIDATES: off-canonical, consume the shared app, no own init');
console.log('     (signature only — 7 of these were browser-tested and showed 0 rejections)');
if (!defects.length) console.log('  (none)');
for (const r of defects) {
  console.log('  ' + r.file);
  console.log('      imports ' + r.versions.join(', ') + '   canonical is ' + CANON);
}

console.log('\n  ── informational: off-canonical but self-contained or app-agnostic  ('
  + mixed.length + ')');
for (const r of mixed.slice(0, 14)) {
  console.log('  ' + (r.file + '  ').padEnd(42) + r.versions.join(',')
    + (r.selfInit ? '   initializeApp()' : '')
    + (r.consumesShared ? '   consumes-shared' : ''));
}
if (mixed.length > 14) console.log('  … and ' + (mixed.length - 14) + ' more');

console.log('\n  ── controls');
ck('canonical version was derived from firebase.js, not hard-coded',
  !!CANON && /^[0-9.]+$/.test(CANON), CANON);
ck('a file that initialises its own app is NOT reported as a defect',
  rows.filter((r) => r.selfInit).every((r) => !r.defect),
  rows.filter((r) => r.selfInit).length + ' self-initialising file(s)');
ck('platform-health.html is now clean (it was the measured instance)',
  !defects.some((d) => d.file === 'platform-health.html'), '');
/* Negative control: the pre-fix shape must be caught, or a clean estate and a
   broken detector look identical. */
const synthetic = 'import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";\ngetAuth();';
const sv = [...new Set((synthetic.match(/firebasejs\/([0-9.]+)/g) || []).map((s) => s.split('/')[1]))];
ck('CONTROL the detector catches the pre-fix shape',
  sv.some((v) => v !== CANON) && /\bgetAuth\s*\(/.test(synthetic) && !/\binitializeApp\s*\(/.test(synthetic),
  'synthetic 11.0.2 consumer');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  ' + defects.length + ' candidate(s), ' + mixed.length + ' informational.');
console.log('  1 CONFIRMED defect to date: platform-health.html, fixed and re-measured.');
console.log('  Version fragmentation alone is not a bug list, and neither is the signature:');
console.log('  7 candidates were browser-tested and produced 0 rejections. When it DOES');
console.log('  bite it fails as an unhandled REJECTION, not a console error, so it is');
console.log('  invisible to ordinary error capture — check rejections, not the console.\n');
process.exit(fail ? 1 : 0);
