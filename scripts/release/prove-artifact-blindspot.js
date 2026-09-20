/* ============================================================================
   PROOF — the artifact-completeness gate's reference universe is incomplete
   scripts/release/prove-artifact-blindspot.js
   ============================================================================
   Demonstrates, rather than asserts, that `artifact-completeness.js` cannot see
   a module fetched by a RUNTIME LOADER.

   The gate resolves `src=` and `href=` attributes. Three of the five
   LIVE-ONLY-REQUIRED assets found by the unfiltered capability census are not
   referenced that way at all:

     pos.html:1879        lazyGlobal("PosPremiumScanner", "sokoni-premium-scanner.js")
     merchant-v2.html:1789 await loadScript('sokoni-print-host-listener.js')
     merchant-v2.html:3637 await loadScript('sokoni-printer-host-ui.js')

   Each of those fetches a file at runtime exactly as a <script src> would, and
   404s identically when the file is absent from the deployed tree.

   This script runs the gate's OWN attribute pattern against both forms, so the
   result is a property of the gate rather than of my description of it. It is
   paired with a positive control — a real `src=` line the pattern MUST match —
   because "the pattern did not match" proves nothing if the pattern is broken.

   READ-ONLY. Mutates nothing and requires no fixture commit.

   RUN  node scripts/release/prove-artifact-blindspot.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const GATE = path.resolve(__dirname, 'artifact-completeness.js');
const src = fs.readFileSync(GATE, 'utf8');

/* Lift the pattern out of the gate itself rather than retyping it: a retyped
   copy could drift from the gate and prove something about the copy. */
const m = /const ATTR = (\/.*\/[gi]*);/.exec(src);
if (!m) { console.error('could not lift ATTR from the gate — did it change?'); process.exit(2); }
// eslint-disable-next-line no-eval
const ATTR = eval(m[1]);
console.log('lifted pattern from the gate: ' + m[1] + '\n');

const CASES = [
  { label: 'POSITIVE CONTROL  <script src=>',
    line: '  <script src="sokoni-reports-builder.js"></script>',
    mustMatch: true },
  { label: 'POSITIVE CONTROL  <link href=>',
    line: '  <link rel="stylesheet" href="sokoni-tokens.css">',
    mustMatch: true },
  { label: 'runtime loader    loadScript()',
    line: "    await loadScript('sokoni-print-host-listener.js').catch(function () {});",
    mustMatch: false },
  { label: 'runtime loader    loadScript()',
    line: "      await loadScript('sokoni-printer-host-ui.js').catch(function () {});",
    mustMatch: false },
  { label: 'runtime loader    lazyGlobal()',
    line: '  window.PosPremiumScanner = lazyGlobal("PosPremiumScanner", "sokoni-premium-scanner.js");',
    mustMatch: false },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  ATTR.lastIndex = 0;
  const hit = ATTR.exec(c.line);
  const seen = hit ? (hit[1] != null ? hit[1] : hit[2]) : null;
  const ok = c.mustMatch ? !!seen : !seen;
  console.log((ok ? '  ✓ ' : '  ✗ ') + c.label.padEnd(34) +
              (seen ? 'matched -> ' + seen : 'NO MATCH'));
  ok ? pass++ : fail++;
}

console.log('\n' + '='.repeat(72));
if (fail === 0) {
  console.log('  PROVEN: the gate matches src=/href= and is BLIND to runtime loaders.');
  console.log('  Three LIVE-ONLY-REQUIRED assets are referenced only this way, which is');
  console.log('  why artifact completeness reported 6 assets while the capability census');
  console.log('  found 5 dangling references it had never examined.');
  console.log('');
  console.log('  This is a SCOPE defect, not a matching bug. Widening it means teaching');
  console.log('  the gate the project’s loader functions by name — and each addition');
  console.log('  needs its own control, or the gate starts reporting string constants');
  console.log('  that are never fetched.');
} else {
  console.log('  INCONCLUSIVE — ' + fail + ' case(s) behaved unexpectedly.');
  console.log('  A failed POSITIVE CONTROL means the lifted pattern is wrong and the');
  console.log('  blind-spot claim below it proves nothing.');
}
console.log('='.repeat(72) + '\n');
process.exit(fail === 0 ? 0 : 1);
