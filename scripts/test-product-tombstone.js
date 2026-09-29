/* ============================================================================
   DELETE MEANS DELIST — the canonical product document is never destroyed.

   Run:  node scripts/test-product-tombstone.js      (no emulator, no network)

   WHY
   A canonical product id is a FOREIGN KEY. It is referenced by:

       reviews/{}.targetId          ratingsSummary/{id}
       orders[].items[].productId   inventoryMovements
       every cached client copy (localStorage.sellerProducts, selectedProduct)

   Physically deleting products/{id} orphans all of them at once: the reviews
   survive but address nothing, the ratings summary becomes unreachable, and an
   order line can no longer resolve what was sold.

   TWO hard-delete paths existed, and the second was only found because the first
   was audited properly:

     sokoni-db.js        deleteDoc(doc(db,'products',id))       — client, physical
     functions/index.js  products/{id}.delete() + a record in
                         `deleted_products`                      — KASS admin agent

   The second is the more dangerous shape: it LOOKED safe because it wrote a
   deleted_products audit row, but that is a different collection nothing reads, so
   every buyer surface and every foreign key still lost its referent.

   FIVE delete/unpublish paths now exist across the platform. This test asserts all
   five converge on a status in the canonical HIDDEN vocabulary, and that none of
   them can physically remove the document.
============================================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const S = require(path.join(ROOT, 'functions', 'shared', 'sellability'));

console.log('\nThe canonical tombstone');
ck('tombstone status is archived', S.TOMBSTONE.status === 'archived');
ck('tombstone hides the product',  S.TOMBSTONE.isVisible === false);
ck('tombstonePatch() returns the same shape',
   JSON.stringify(S.tombstonePatch()) === JSON.stringify({ status: 'archived', isVisible: false }));
ck('tombstonePatch() is a fresh object each call (no shared mutable state)',
   S.tombstonePatch() !== S.tombstonePatch());
ck('the tombstone status is in the hidden vocabulary',
   S.HIDDEN_STATUSES.indexOf(S.TOMBSTONE.status) !== -1);

console.log('\nA tombstoned product is unavailable everywhere, even with stock');
{
  const dead = Object.assign({ stock: 9, price: 100 }, S.tombstonePatch());
  ck('not publicly listed',            S.isPubliclyListed(dead) === false);
  ck('classifies as unavailable',      S.availabilityOf(dead).state === 'unavailable');
  ck('not sellable',                   S.availabilityOf(dead).sellable === false);
  ck('orderable quantity is 0',        S.maxOrderableQty(dead) === 0);
  ck('clamps any requested qty to 0',  S.clampQty(5, dead).qty === 0);
  ck('checkout gate refuses it',       S.itemAvailability(dead, undefined).available === false);
  ck('stock is irrelevant — listing outranks it',
     S.availabilityOf(dead).reason === 'status:archived');
  ck('an OPEN shop cannot resurrect it',
     S.availabilityOf(dead, { acceptingOrders: true, online: true }).sellable === false);
}

console.log('\nNo path can physically delete a canonical product');
{
  const dbSrc  = code('sokoni-db.js');
  const idxSrc = code('functions/index.js');
  ck('sokoni-db.js no longer calls deleteDoc on products',
     !/deleteDoc\(doc\(db, 'products'/.test(dbSrc));
  ck('sokoni-db.js writes the tombstone instead',
     /tombstonePatch\(\)/.test(dbSrc) && /archivedAt/.test(dbSrc));
  ck('sokoni-db.js merges rather than replacing the document',
     /setDoc\(doc\(db, 'products', String\(productId\)\)[\s\S]{0,220}?\{ merge: true \}/.test(dbSrc));
  ck('the KASS admin tool no longer deletes the document',
     !/collection\("products"\)\.doc\(input\.productId\)\.delete\(\)/.test(idxSrc));
  ck('the KASS admin tool writes the canonical tombstone',
     /_availability\.tombstonePatch\(\)/.test(idxSrc));
  ck('the deleted_products audit record is retained',
     /collection\("deleted_products"\)/.test(idxSrc));
  ck('the audit record states the method was a tombstone',
     /method: "tombstone"/.test(idxSrc));

  /* Repo-wide: no client physical delete on the canonical collection. */
  const clientFiles = fs.readdirSync(ROOT)
    .filter(f => /\.(js|html)$/.test(f))
    .filter(f => f !== 'sokoni-dev-mock.js');           /* the mock is an in-memory stub */
  const offenders = clientFiles.filter(f => {
    const src = code(f);
    return /deleteDoc\(\s*doc\(\s*db\s*,\s*['"]products['"]/.test(src);
  });
  ck('no client file physically deletes products/{id}', offenders.length === 0,
     offenders.join(',') || 'none');
}

console.log('\nEvery delete/unpublish path lands in the hidden vocabulary');
{
  /* Each path writes a different status on purpose — a merchant archiving, an
     admin removing and an inventory deactivation are different events. What must
     NOT differ is that all of them delist. */
  const PATHS = [
    ['seller-wiring.js  (merchant retire)', 'archived'],
    ['admin.html        (admin remove)',    'removed'],
    ['sokoni-inventory  (deactivate)',      'inactive'],
    ['SokoniDB          (tombstone)',       'archived'],
    ['KASS admin agent  (tombstone)',       'archived'],
  ];
  PATHS.forEach(([label, status]) => {
    ck(label + ' → "' + status + '" is hidden',
       S.HIDDEN_STATUSES.indexOf(status) !== -1 &&
       S.isPubliclyListed({ status: status }) === false);
  });

  ck('seller-wiring still archives (unchanged)',
     /status: 'archived', isVisible: false/.test(code('seller-wiring.js')));
  ck('admin.html still routes removal through the server',
     /adminUpdateProductStatus/.test(code('admin.html')) && /status:'removed'/.test(code('admin.html')));
  ck('sokoni-inventory still soft-deletes',
     /status: 'inactive'/.test(code('sokoni-inventory.js')));
}

console.log('\nForeign keys still resolve after a tombstone');
{
  /* The point of the tombstone: the id remains addressable. These are structural
     assertions — the document is merged, not replaced, so every other field
     (name, price, sellerUid, images) that a review card, an order line or an
     inventory movement needs in order to render is still present. */
  const dbSrc = code('sokoni-db.js');
  ck('the write is a merge, so name/price/sellerUid survive for order lines',
     /\{ merge: true \}/.test(dbSrc));
  ck('ratingsSummary is keyed by the product id, which still exists',
     /collection\("ratingsSummary"\)\.doc\(targetId\)/.test(read('functions/reviews.js')));
  ck('reviews address the product by targetId, which still exists',
     /where\("targetId", "==", targetId\)/.test(read('functions/reviews.js')));

  /* And the detail page must EXPLAIN a tombstoned product rather than 404 —
     lists exclude it, but a bookmark deserves an answer (established in dde631b). */
  ck('product detail does not filter delisted products out',
     !/isPubliclyListed/.test(code('product.js')));
}

console.log('\nThe two module copies stay identical');
ck('sokoni-sellability.js === functions/shared/sellability.js',
   read('sokoni-sellability.js') === read('functions/shared/sellability.js'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
