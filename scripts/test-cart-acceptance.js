#!/usr/bin/env node
/* TRACK 2.3 — FINAL ACCEPTANCE.
 *
 *   node scripts/test-cart-acceptance.js
 *
 * The completion condition for 2.3 is NOT "no file touches the cart". It is:
 *
 *   every cart WRITER is migrated,
 *   every UNBLOCKED reader is migrated,
 *   and every remaining direct reader is blocked or deferred behind a named
 *   architectural boundary, with an owning phase and a recorded reason.
 *
 * That distinction is the whole point. A suite that demanded zero survivors would create
 * pressure to unfreeze checkout.html or ship the service to 300 pages unreviewed — turning
 * a cart migration into an unreviewed checkout change. So this asserts the real condition,
 * and separately asserts that the frozen boundaries were NOT crossed to reach it.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const SCAN = require('./scan-cart-writers.js');
const STATE = require('./cart-migration-state.js');
const { stripComments, keepOnly, htmlScriptRegions } = require('./scan-legacy-wishlist.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const execOf = (f) => stripComments(f.endsWith('.html')
  ? keepOnly(read(f), htmlScriptRegions(read(f))) : read(f));

const HITS = SCAN.scan().filter(h => h.key === 'cart');
const FILES = [...new Set(HITS.map(h => h.file))];

console.log('\nTRACK 2.3 — FINAL ACCEPTANCE\n' + '='.repeat(70));

/* ══ A. every writer is migrated ══ */
console.log('\nA. Every cart WRITER is migrated');
{
  const writers = HITS.filter(h => h.kind === 'WRITE' || h.kind === 'DELETE');
  const rogue = writers.filter(h => h.file !== 'sokoni-cart.js' &&
    !STATE.FROZEN_FILES.includes(h.file) && !STATE.DEFERRED_FILES.includes(h.file) &&
    !STATE.TEST_HARNESS.includes(h.file));
  ck('A', 'no unmigrated writer anywhere', rogue.length === 0,
     rogue.map(h => h.file + ':' + h.line).join(', '));
  ck('A', 'the service is a writer (control — the scan can see writers)',
     writers.some(h => h.file === 'sokoni-cart.js'));
  ck('A', 'no BLOCKED file is a writer — blocked survivors are readers only',
     !writers.some(h => STATE.BLOCKED_FILES.includes(h.file)),
     writers.filter(h => STATE.BLOCKED_FILES.includes(h.file)).map(h => h.file).join(', '));
}

/* ══ B. every remaining direct access is accounted for ══ */
console.log('\nB. Every survivor carries an owning phase and a reason');
{
  const unaccounted = FILES.filter(f => f !== 'sokoni-cart.js' &&
    !STATE.TEST_HARNESS.includes(f) && !STATE.survivorFor(f));
  ck('B', 'zero UNACCOUNTED survivors', unaccounted.length === 0, unaccounted.join(', '));
  [...STATE.FROZEN, ...STATE.DEFERRED, ...STATE.BLOCKED].forEach(e => {
    ck('B', e.file + ' → phase ' + e.phase, !!e.phase && /^2\.\d$/.test(e.phase), e.phase);
    ck('B', e.file + ' has a substantive reason, not a label',
       typeof e.reason === 'string' && e.reason.length > 80, (e.reason || '').length + ' chars');
  });
  ck('B', 'the harness is classified rather than migrated',
     STATE.TEST_HARNESS.includes('tests/rc/suites/rc-02-buyer.js'));
}

/* ══ C. the boundaries were NOT crossed to reach this state ══ */
console.log('\nC. No boundary was unfrozen to make the sweep read zero');
{
  const changed = cp.execSync('git diff --name-only HEAD~10..HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  STATE.FROZEN_FILES.forEach(f => ck('C', f + ' unchanged across the whole of Track 2.3',
    !changed.includes(f), changed.filter(x => x === f).join(', ')));
  STATE.DEFERRED_FILES.forEach(f => ck('C', f + ' unchanged across the whole of Track 2.3',
    !changed.includes(f)));
  STATE.BLOCKED_FILES.forEach(f => ck('C', f + ' unchanged across the whole of Track 2.3',
    !changed.includes(f)));
  /* The specific temptation, named: adding the service to checkout.html would have
     unblocked seller-wiring.js and made the sweep read one lower. */
  ck('C', 'checkout.html still does NOT load the cart service',
     !/src="sokoni-cart\.js"/.test(read('checkout.html')));
  ck('C', 'the interceptor is still in place', /localStorage\.setItem\s*=/.test(execOf('provider-wiring.js')));
}

/* ══ D. the migrated set genuinely has no direct access ══ */
console.log('\nD. Migrated surfaces really are migrated');
{
  const leaked = STATE.MIGRATED.filter(f => FILES.includes(f));
  ck('D', 'no migrated file still touches the cart directly', leaked.length === 0, leaked.join(', '));
  ck('D', 'the migrated set is substantial (control)', STATE.MIGRATED.length >= 15,
     STATE.MIGRATED.length + ' files');
  /* Every migrated PAGE must actually load the service, or the migration is inert — the
     trap that hit three pages in Track 3 and cart.html in 2.3.6. */
  const inert = STATE.MIGRATED.filter(f => f.endsWith('.html'))
    .filter(f => /SokoniCart/.test(execOf(f)) && !/src="sokoni-cart\.js"/.test(read(f)));
  ck('D', 'no page calls SokoniCart without loading it', inert.length === 0, inert.join(', '));
}

/* ══ E. the invariants the whole track was for ══ */
console.log('\nE. Platform invariants');
{
  const svc = stripComments(read('sokoni-cart.js'));
  ck('E', 'one storage key, declared once', /var KEY = 'cart'/.test(svc));
  ck('E', 'the service exposes no money helper', !/subtotal|function total/.test(svc));
  ck('E', 'the service is not uid-scoped', !/firebaseAuth|onAuthStateChanged/.test(svc));
  ck('E', 'both count models remain available',
     /lines:\s*lines/.test(svc) && /units:\s*units/.test(svc));
  ck('E', 'row-level and product-level removal remain distinct',
     /removeById:\s*removeById/.test(svc) && /removeAllById:\s*removeAllById/.test(svc));
  ck('E', 'writes still go through localStorage.setItem so the bridge fires',
     /localStorage\.setItem\(KEY/.test(svc));
  ck('E', 'corruption is quarantined, not overwritten', /cart_corrupt_/.test(svc));
}

/* ══ F. summary of where the cart now lives ══ */
console.log('\nF. Final topology');
{
  const byGroup = { migrated: 0, blocked: 0, deferred: 0, frozen: 0 };
  FILES.forEach(f => {
    if (STATE.BLOCKED_FILES.includes(f)) byGroup.blocked++;
    else if (STATE.DEFERRED_FILES.includes(f)) byGroup.deferred++;
    else if (STATE.FROZEN_FILES.includes(f)) byGroup.frozen++;
  });
  console.log('     direct-access files remaining: ' + (FILES.length - 1) + ' (excluding the service)');
  console.log('       blocked ' + byGroup.blocked + '  deferred ' + byGroup.deferred +
              '  frozen ' + byGroup.frozen + '  harness 1');
  ck('F', 'exactly two blocked readers', byGroup.blocked === 2, byGroup.blocked);
  ck('F', 'exactly one deferred implementation', byGroup.deferred === 1, byGroup.deferred);
  ck('F', 'exactly two frozen surfaces', byGroup.frozen === 2, byGroup.frozen);
  ck('F', 'Track 2.3 completion condition met: all writers + all unblocked readers',
     R.A === 'PASS' && R.B === 'PASS' && R.C === 'PASS' && R.D === 'PASS');
}

console.log('\n' + '='.repeat(70));
console.log('Track 2.3 final acceptance\n');
['A','B','C','D','E','F'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
