/* Product archive must change CANONICAL data — never just the local cache.
 *
 *   node scripts/test-product-delete-canonical.js
 *
 * WHY THIS EXISTS
 * Reported: "Sync tried to delete a product, but the product count is not reducing."
 *
 * seller.js deleteProduct() used to splice localStorage, repaint, emit the sync event and toast
 * "Product Archived" — and only THEN attempt the Firestore archive, fire-and-forget, behind
 * `if (!target.id || !window.firebaseDB) return;` with a catch that merely warned. So a missing
 * id, an uninitialised firebaseDB, or any thrown write left the product ACTIVE in Firestore
 * while the merchant was told it was gone. The list looked shorter, the count never dropped,
 * and a refresh brought it back.
 *
 * This suite asserts the ORDER OF OPERATIONS that makes that impossible:
 *   · the canonical write is attempted BEFORE the cache is mutated
 *   · a FAILED write changes nothing and reports the failure
 *   · a product with no canonical id is described honestly, not called "Archived"
 *   · success is announced only after the write resolves
 *
 * Scope is deliberately STRUCTURAL: it proves the ordering that makes the bug impossible, and
 * that the visibility predicate excludes exactly what the archive writes. Proving the archive
 * lands in real Firestore needs the emulator (App Check cannot attest 127.0.0.1) and remains
 * unfinished — the summary says so rather than implying coverage that does not exist.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 100) + ']' : ''));
  ok ? pass++ : fail++;
};

const SRC = fs.readFileSync(path.join(ROOT, 'seller.js'), 'utf8');

/* ── Static guarantees: the ordering bug must be structurally impossible ───────── */
console.log('\nPRODUCT ARCHIVE — CANONICAL WRITE ORDERING');
console.log('='.repeat(70));

const fnStart = SRC.indexOf('function deleteProduct(index)');
const fnEnd = SRC.indexOf('\n}', SRC.indexOf('showNotification("🗑️ Product Archived"', fnStart));
const FN_RAW = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 6000);
/* Strip comments before any structural check. This function now documents the OLD behaviour in
   prose, and the "guard is gone" assertion matched that DESCRIPTION rather than live code —
   the same trap the syntax gate hit with an HTML comment quoting markup. Only executable text
   may satisfy a structural assertion. */
const FN = FN_RAW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

ck('deleteProduct located', fnStart > -1);

const iSplice  = FN.indexOf('sellerProducts.splice');
const iUpdate  = FN.indexOf('updateDoc');
const iToast   = FN.indexOf('🗑️ Product Archived');
const iEarly   = FN.search(/if\s*\(\s*!target\.id\s*\|\|\s*!window\.firebaseDB\s*\)\s*return/);

/* There are legitimately TWO splices. The first belongs to the no-canonical-id branch, where a
   product exists only in this browser and removing it from the cache IS the whole operation —
   there is nothing server-side to archive. The one that must never run before the canonical
   write is the SUCCESS-path splice, so assert on the last occurrence, and confirm the early one
   really is guarded by the no-id check rather than being the old unconditional splice. */
const iSpliceLast = FN.lastIndexOf('sellerProducts.splice');
const earlySpliceIsNoIdBranch = iSplice === iSpliceLast
  || /if\s*\(\s*!target\.id\s*\)[\s\S]{0,400}?sellerProducts\.splice/.test(FN);
ck('success-path cache splice comes AFTER the canonical write',
   iUpdate > -1 && iSpliceLast > iUpdate, 'updateDoc@' + iUpdate + ' lastSplice@' + iSpliceLast);
ck('any earlier splice is the no-canonical-id branch only', earlySpliceIsNoIdBranch,
   'firstSplice@' + iSplice);
ck('success toast comes AFTER the canonical write', iToast > iUpdate, 'toast@' + iToast + ' updateDoc@' + iUpdate);
ck('the silent `!target.id || !firebaseDB -> return` guard is gone', iEarly === -1,
   iEarly > -1 ? 'still present at ' + iEarly : 'removed');
ck('a failed write reports an error to the merchant', /showNotification\([^)]*error/i.test(FN));
ck('a failed write restores the cache', /_restore/.test(FN));
ck('archive writes status:"archived" (in SokoniProductVisibility.HIDDEN)', /status:\s*"archived"/.test(FN));
ck('archive also clears legacy active/isVisible flags',
   /isVisible:\s*false/.test(FN) && /active:\s*false/.test(FN));

/* ── The predicate must actually exclude what the write produces ──────────────── */
console.log('\nACTIVE-PRODUCT PREDICATE AGREES WITH THE WRITE');
const V = require(path.join(ROOT, 'sokoni-product-visibility.js'));
const archived = { id: 'p1', name: 'A', status: 'archived', isVisible: false, active: false };
const inactive = { id: 'p2', name: 'B', status: 'inactive', active: false };   /* SokoniInventory path */
const legacy   = { id: 'p3', name: 'C' };                                      /* no status = active */
ck('archived product is NOT active', V.isActiveProduct(archived) === false);
ck('inactive product is NOT active (SokoniInventory soft-delete)', V.isActiveProduct(inactive) === false);
ck('legacy product with no status IS active (absent = active)', V.isActiveProduct(legacy) === true);
ck('countActive drops by exactly one when a product is archived',
   V.countActive([legacy, { id: 'p4' }, archived]) === 2,
   String(V.countActive([legacy, { id: 'p4' }, archived])));

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
console.log('  SCOPE: proves the ORDER OF OPERATIONS (canonical write before cache mutation,');
console.log('         success announced only after it resolves, failure reported and');
console.log('         non-destructive) and that the visibility predicate excludes exactly what');
console.log('         the archive writes.');
console.log('  NOT VERIFIED: that the archive lands in real Firestore and the active count drops');
console.log('         by exactly one after a reload. That needs the Firestore emulator.');
process.exit(fail ? 1 : 0);
