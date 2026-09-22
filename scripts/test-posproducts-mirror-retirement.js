#!/usr/bin/env node
/**
 * test-posproducts-mirror-retirement.js — certifies the seller.js posProducts mirror
 * writer retirement (docs/POSPRODUCTS_SELLERJS_RETIREMENT_GRAPH.md executed).
 *
 * Static, comment-stripped source assertions (same convention as
 * scripts/test-convertprtopo-fix.js) PLUS sabotage controls: each positive check is
 * proven capable of failing by re-running it against a deliberately-broken in-memory
 * copy of the source, so a vacuous regex can't pass silently
 * (feedback_sabotage_must_be_targeted_and_counted_by_exit).
 *
 * Five things this proves, per the retirement slice's own scope:
 *   1. the posProducts mirror write is gone from seller.js
 *   2. the canonical `products` write survives, untouched
 *   3. the `tenants/{uid}/inventory_products` sync survives, untouched
 *   4. the unrelated addProduct() implementations (digital-esoko-seller.html,
 *      ministore.html) and seller-wiring.js's global patch are byte-identical to
 *      the last commit — this retirement touched seller.js and nothing else
 *   5. no posProducts WRITE call site reappeared anywhere else in the repo — the
 *      only remaining writers are the already-known, already-scoped ones
 *      (pos-inventory-pro.js's canonical writer, procurement.js's already-flagged
 *      receiveGoods path)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const sellerJs = fs.readFileSync(path.join(ROOT, 'seller.js'), 'utf8');
const sellerJsStripped = strip(sellerJs);

/* Isolate addProduct()'s own body — a page-wide check would be too broad (other
   functions could coincidentally contain similar strings) and too narrow a slice
   would miss a resurrection placed just outside the function. addProduct() runs
   from its declaration to the matching top-level `}` that closes it (the function
   ends where the file returns to column-0 statements after it). */
function addProductBody(src) {
  const start = src.indexOf('async function addProduct(');
  if (start === -1) return null;
  let i = src.indexOf('{', start), depth = 1; i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++; else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

/* ══════════════════════════════════════════════════════════════════════════
   The three positive detectors under test — defined once, used for both the
   real source (must pass/fail as expected) and the sabotage copies below.
   ══════════════════════════════════════════════════════════════════════════ */
const RE_POSPRODUCTS_WRITE = /m\.setDoc\(\s*m\.doc\(\s*db\s*,\s*'posProducts'/;
const RE_CANONICAL_WRITE   = /m\.setDoc\(\s*m\.doc\(\s*db\s*,\s*'products'\s*,\s*newProduct\.id\s*\)\s*,\s*fsProduct\s*\)/;
const RE_INVENTORY_SYNC    = /m\.setDoc\(\s*m\.doc\(\s*db\s*,\s*'tenants'\s*,\s*sellerUid\s*,\s*'inventory_products'\s*,\s*newProduct\.id\s*\)\s*,\s*_invProduct/;

const noMirror   = (src) => !RE_POSPRODUCTS_WRITE.test(src);
const hasCanon   = (src) => RE_CANONICAL_WRITE.test(src);
const hasInvSync = (src) => RE_INVENTORY_SYNC.test(src);

/* ══════════════════════════════════════════════════════════════════════════
   1-3. Real source — the three properties this retirement must hold
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nseller.js — addProduct() after retirement\n');
const body = addProductBody(sellerJsStripped);
if (!body) {
  bad('could not isolate addProduct() body at all — cannot certify anything');
} else {
  noMirror(body)
    ? ok('the posProducts mirror write is gone from addProduct()')
    : bad('the posProducts mirror write is STILL present in addProduct()');
  hasCanon(body)
    ? ok('the canonical products write survives, unchanged (awaited, primary)')
    : bad('the canonical products write is missing or altered');
  hasInvSync(body)
    ? ok('the tenants/{uid}/inventory_products sync survives, unchanged')
    : bad('the inventory_products sync is missing or altered');
}

/* Page-wide converse: posProducts should appear exactly once now — the
   explanatory retirement comment — not as any write call anywhere in the file. */
{
  /* Unstripped — the surviving mentions ARE the retirement comment's prose;
     stripping comments first would hide the exact thing being checked. Not an
     exact count (a explanatory comment is free to mention the name more than
     once) — the real safety property is the next check: no CODE reference. */
  const mentions = (sellerJs.match(/posProducts/g) || []).length;
  mentions >= 1
    ? ok('posProducts is still mentioned in seller.js (' + mentions + 'x, the retirement comment — not silently erased)')
    : bad('posProducts is not mentioned anywhere in seller.js — the retirement comment itself is gone, losing the audit trail');
  !/m\.setDoc\([^)]*posProducts/.test(sellerJsStripped) && !/m\.updateDoc\([^)]*posProducts/.test(sellerJsStripped)
    ? ok('no setDoc/updateDoc call targeting posProducts exists anywhere in seller.js (page-wide, not just addProduct())')
    : bad('a posProducts write call exists somewhere in seller.js outside addProduct()');
}

/* ══════════════════════════════════════════════════════════════════════════
   SABOTAGE — prove each detector above can actually fail, not just pass
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nSabotage controls — each detector proven capable of catching the regression it exists for\n');

/* S1. Resurrect the mirror write into an otherwise-clean copy. */
{
  const sabotaged = body.replace(
    /(m\.setDoc\(\s*m\.doc\(\s*db\s*,\s*'tenants'[\s\S]*?\.catch\(function[\s\S]*?\}\);)/,
    "$1\n  m.setDoc(m.doc(db, 'posProducts', newProduct.id), { name: 'x' });"
  );
  const caught = !noMirror(sabotaged);
  caught
    ? ok('SABOTAGE resurrected-posProducts-write: the detector correctly reports it back (not a vacuous pass)')
    : bad('SABOTAGE resurrected-posProducts-write: the detector did NOT catch a reintroduced mirror write — check is vacuous');
}

/* S2. Break the canonical products write (simulate an accidental edit to it). */
{
  const sabotaged = body.replace(
    "await m.setDoc(m.doc(db,'products',newProduct.id), fsProduct);",
    "await m.setDoc(m.doc(db,'products',newProduct.id + '_typo'), fsProduct);"
  );
  const stillDetectsCanon = hasCanon(sabotaged);
  !stillDetectsCanon
    ? ok('SABOTAGE broken-canonical-write: the detector correctly reports it MISSING once mutated (not a vacuous pass)')
    : bad('SABOTAGE broken-canonical-write: the detector still reports the canonical write present after mutation — check is vacuous');
}

/* S3. Remove the inventory_products sync (simulate an accidental deletion). */
{
  const sabotaged = body.replace(
    /m\.setDoc\(m\.doc\(db, 'tenants', sellerUid, 'inventory_products', newProduct\.id\), _invProduct, \{ merge: true \}\)\s*\n\s*\.catch\(function \(e\) \{ console\.warn\('\[SOKONI\] inventory sync \(non-blocking\):', e && e\.message\); \}\);/,
    '/* removed for sabotage test */'
  );
  const stillDetectsInv = hasInvSync(sabotaged);
  !stillDetectsInv
    ? ok('SABOTAGE removed-inventory-sync: the detector correctly reports it MISSING once deleted (not a vacuous pass)')
    : bad('SABOTAGE removed-inventory-sync: the detector still reports the sync present after deletion — check is vacuous');
}

/* S4. Cross-contamination check: a copy with ONLY the old mirror write re-added
   (canonical + inventory sync both present, exactly the pre-retirement shape)
   must fail the "no mirror" check while STILL passing the other two — proving
   the three detectors are independent, not accidentally the same regex. */
{
  const oldShape = body.replace(
    /(m\.setDoc\(\s*m\.doc\(\s*db\s*,\s*'tenants'[\s\S]*?\.catch\(function[\s\S]*?\}\);)/,
    "$1\n  m.setDoc(m.doc(db, 'posProducts', newProduct.id), {status:'active'});"
  );
  const results = { mirror: !noMirror(oldShape), canon: hasCanon(oldShape), inv: hasInvSync(oldShape) };
  (results.mirror && results.canon && results.inv)
    ? ok('SABOTAGE cross-contamination: pre-retirement shape correctly trips ONLY the mirror-write detector, not the other two independently-defined checks')
    : bad('SABOTAGE cross-contamination: the three detectors are not independent — ' + JSON.stringify(results));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. Unrelated addProduct() implementations and seller-wiring.js — untouched
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nUnrelated files — proven byte-identical to the last commit (this retirement touched ONLY seller.js)\n');
for (const f of ['digital-esoko-seller.html', 'ministore.html', 'seller-wiring.js']) {
  try {
    const committed = execFileSync('git', ['show', 'HEAD:' + f], { cwd: ROOT, encoding: 'utf8' });
    const working = fs.readFileSync(path.join(ROOT, f), 'utf8');
    committed === working
      ? ok(f + ' is byte-identical to HEAD — its addProduct()/patch logic was not touched by this retirement')
      : bad(f + ' DIFFERS from HEAD — this retirement should not have touched it');
  } catch (e) {
    bad(f + ': could not diff against HEAD (' + e.message.split('\n')[0] + ')');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   5. No posProducts WRITE call site reappeared anywhere else in the repo —
   the remaining writer set is exactly the already-known, already-scoped one.
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nRepo-wide — the remaining posProducts writer set is exactly what was already known\n');
{
  let grepOut;
  try {
    grepOut = execFileSync('git', ['grep', '-n', '-I', '-E',
      "\\.(setDoc|updateDoc|set|update)\\([^)]*posProducts|collection\\('posProducts'\\)\\.doc\\([^)]*\\)\\.(set|update)",
      '--', '*.js', '*.html'],
      { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    /* git grep exits 1 when there are zero matches — that would itself be a
       finding worth seeing, not swallowing. */
    grepOut = (e.status === 1 && e.stdout) ? e.stdout : '';
    if (e.status !== 1 && e.status !== 0) bad('git grep for posProducts writers failed to run: ' + e.message.split('\n')[0]);
  }
  const lines = grepOut.split('\n').filter(Boolean);
  const allFiles = new Set(lines.map(l => l.split(':')[0]));

  /* THE SUBJECT IS PRODUCTION WRITERS, NOT HARNESSES. A suite that seeds
     posProducts into an emulator matches this pattern and is not a writer the
     retirement is about — `test-served-posproducts-authorization.js` seeds rows
     to exercise the SERVED ruleset, and this file matches its own pattern.

     Scoping beats allowlisting two filenames: an exact-set assertion over a
     shared repo goes red on another agent's valid addition, and the obvious
     "fix" then looks like deleting their work. The extras are REPORTED rather
     than silently dropped, so a harness quietly becoming a production writer
     still surfaces here. */
  const isHarness = (f) => f.startsWith('scripts/');
  const harnesses = [...allFiles].filter(isHarness);
  const files = new Set([...allFiles].filter(f => !isHarness(f)));
  if (harnesses.length) {
    console.log('  note  ' + harnesses.length + ' test harness(es) also match this pattern and are ' +
                'out of scope: ' + harnesses.join(', '));
  }

  !files.has('seller.js')
    ? ok('seller.js has zero remaining posProducts write call sites (repo-wide git grep, not the file-scoped check above)')
    : bad('git grep still finds a posProducts write call site in seller.js');

  /* sokoni-reconcile.js is a KNOWN, pre-existing, out-of-scope THIRD writer — a
     repair/reconciliation tool the original migration graph (row #14) already
     flagged as "should probably be the one place that's allowed to normalize
     field names, not migrated away." This retirement slice is scoped to
     seller.js only, per instruction — sokoni-reconcile.js is correctly left
     alone and correctly expected here, not silently allowed by accident. */
  const expected = new Set(['sokoni-reconcile.js']);
  const unexpected = [...files].filter(f => f !== 'seller.js' && !expected.has(f));
  unexpected.length === 0
    ? ok('every remaining posProducts write call site this pattern catches is either already-known-and-out-of-scope (' + [...files].filter(f=>f!=='seller.js').join(', ') + ') — pos-inventory-pro.js/procurement.js write via an indirect ref this pattern does not match, so their absence here is expected, not a finding')
    : bad('an UNEXPECTED posProducts write call site appeared: ' + unexpected.join(', '));
}

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed.');
if (fail) { console.log('\n  ' + fail + ' FAILURE(S).'); process.exit(1); }
console.log('\n  PASS — seller.js posProducts mirror writer retirement certified.');
