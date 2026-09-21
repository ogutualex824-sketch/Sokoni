/* sokoni-catalogue-model.js — one catalogue, two commerce types.

   Covers the 15 properties the slice was specified against, plus the two that
   matter most for data safety:

     - an EDIT MUST NOT STRIP fields the editor never shows (cost, batch,
       barcode, merchantId, sync bookkeeping). Tested with a positive control
       proving the edit DID change what it was supposed to, so "nothing lost"
       cannot pass against a no-op.
     - ABSENT stock is UNMETERED, not zero. Rendering 0 would read as
       out-of-stock and stop a sale that should happen.
*/
'use strict';
const path = require('path');
const fsmod = require('fs');
const C = require(path.join(__dirname, '..', 'sokoni-catalogue-model.js'));
const B = require(path.join(__dirname, '..', 'functions', 'shared', 'business-scope.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};

const LIVE = { status: 'active' };
const scopeProducts = B.resolveBusinessScope({ seller: LIVE, provider: null });
const scopeServices = B.resolveBusinessScope({ seller: null, provider: LIVE });
const scopeDual     = B.resolveBusinessScope({ seller: LIVE, provider: LIVE });

const CHARGER = { id: 'p1', name: 'iPhone Charger', price: 1500, stock: 18, trackStock: true, unit: 'piece', sku: 'CHG-1' };
const PRINTING = { id: 's1', name: 'Printing', price: 20, trackStock: false, unit: 'page' };
const REPAIR   = { id: 's2', name: 'Computer Repair', trackStock: false, unit: 'service', variablePrice: true };
const LEGACY   = { id: 'p0', name: 'Old Row', price: 300 };          /* no trackStock at all */

/* 1 + 2 + classification */
console.log('\n── 1/2. What a row IS ──');
ck('a product row renders as PRODUCT', C.kindOf(CHARGER) === 'product');
ck('trackStock === false renders as SERVICE', C.kindOf(PRINTING) === 'service');
ck('ABSENT trackStock is a PRODUCT (every existing row)', C.kindOf(LEGACY) === 'product');
ck('…which matches what the server pricer assumes', C.isProduct(LEGACY));
ck('null does not throw', C.kindOf(null) === 'product');

/* 3 + 4 */
console.log('\n── 3/4. Fixed vs variable pricing ──');
ck('a fixed service shows its price and unit', C.priceLabel(PRINTING) === 'KES 20 / page', C.priceLabel(PRINTING));
ck('a variable service shows "Variable price"', C.priceLabel(REPAIR) === 'Variable price', C.priceLabel(REPAIR));
ck('a fixed service is NOT variable', !C.isVariable(PRINTING));
ck('a PRODUCT can never be variable-priced',
   !C.isVariable(Object.assign({}, CHARGER, { variablePrice: true })));
ck('fixed badge on a fixed service', C.badgesFor(PRINTING).indexOf('FIXED') !== -1, C.badgesFor(PRINTING).join('|'));
ck('variable badge on a variable service', C.badgesFor(REPAIR).indexOf('VARIABLE') !== -1, C.badgesFor(REPAIR).join('|'));
ck('a priceless fixed row says so, it does not show 0',
   C.priceLabel({ trackStock: false, unit: 'page' }) === 'No price set');

/* 5 + 6 + 7 */
console.log('\n── 5/6/7. Scope gates creation ──');
ck('products-only CANNOT create a service', !C.mayCreate(scopeProducts, 'service'));
ck('products-only CAN create a product', C.mayCreate(scopeProducts, 'product'));
ck('services-only CANNOT create a product', !C.mayCreate(scopeServices, 'product'));
ck('services-only CAN create a service', C.mayCreate(scopeServices, 'service'));
ck('dual can create BOTH', C.creatableKinds(scopeDual).sort().join(',') === 'product,service');
ck('no scope creates nothing', C.creatableKinds(null).length === 0);
ck('an unavailable kind gets an EXPLANATION, not a dead button',
   /Apply to provide services/.test(C.unavailableReason(scopeProducts, 'service') || ''),
   C.unavailableReason(scopeProducts, 'service'));
{
  const pending = B.resolveBusinessScope({ seller: LIVE, provider: { status: 'pending' } });
  ck('…and a pending application says "in review"',
     /in review/i.test(C.unavailableReason(pending, 'service') || ''),
     C.unavailableReason(pending, 'service'));
  const susp = B.resolveBusinessScope({ seller: LIVE, provider: { status: 'suspended' } });
  ck('…and a suspension says suspended',
     /suspended/i.test(C.unavailableReason(susp, 'service') || ''), C.unavailableReason(susp, 'service'));
  ck('a permitted kind has NO reason (inverting control)',
     C.unavailableReason(scopeDual, 'service') === null);
}

/* 8 + 9 — the data-safety property */
console.log('\n── 8/9. An edit MERGES; unseen fields survive ──');
{
  const existing = Object.assign({}, CHARGER, {
    cost: 900, batch: 'B7', barcode: '6161000', expiryDate: '2027-01-01',
    merchantId: 'm1', createdAt: 'T0', syncedAt: 'T1', source: 'canonical', taxRate: 16,
  });
  const out = C.applyEdit(existing, 'product', { name: 'iPhone Charger 20W', price: 1700, stock: 12, sku: 'CHG-1' });
  ck('cost survives', out.cost === 900);
  ck('batch survives', out.batch === 'B7');
  ck('barcode survives', out.barcode === '6161000');
  ck('expiryDate survives', out.expiryDate === '2027-01-01');
  ck('merchantId survives', out.merchantId === 'm1');
  ck('createdAt / syncedAt / source survive',
     out.createdAt === 'T0' && out.syncedAt === 'T1' && out.source === 'canonical');
  ck('taxRate survives', out.taxRate === 16);
  /* POSITIVE CONTROL — without this, "nothing lost" passes against a no-op. */
  ck('…and the edit DID apply', out.name === 'iPhone Charger 20W' && out.price === 1700 && out.stock === 12);
}
{
  const existing = Object.assign({}, PRINTING, { merchantId: 'm1', createdAt: 'T0', legacyNote: 'keep' });
  const out = C.applyEdit(existing, 'service', { name: 'Printing (colour)', price: 40, unit: 'page' });
  ck('service edit keeps unknown fields', out.merchantId === 'm1' && out.legacyNote === 'keep');
  ck('…and applies the change', out.name === 'Printing (colour)' && out.price === 40);
  ck('…and keeps it a service', out.trackStock === false);
}

console.log('\n── The discriminator is written EXPLICITLY (it had no writer before) ──');
{
  ck('a new service writes trackStock:false', C.applyEdit({}, 'service', { name: 'Scan', price: 50, unit: 'document' }).trackStock === false);
  ck('a new product writes trackStock:true',  C.applyEdit({}, 'product', { name: 'Cable', price: 300 }).trackStock === true);
  ck('a service carries NO stock key at all',
     !('stock' in C.applyEdit({ stock: 5 }, 'service', { name: 'Typing', price: 100, unit: 'page' })));
  ck('…deleted, not zeroed (0 would read as OUT OF STOCK)',
     C.applyEdit({ stock: 5 }, 'service', { name: 'T', price: 1, unit: 'page' }).stock === undefined);
  ck('a product is never left variable-priced',
     !('variablePrice' in C.applyEdit({ variablePrice: true }, 'product', { name: 'X', price: 5 })));
}

console.log('\n── Absent stock is UNMETERED, not zero ──');
ck('absent stock reads "Not tracked"', C.stockLabel(LEGACY) === 'Not tracked', C.stockLabel(LEGACY));
ck('zero stock reads "Stock: 0"', C.stockLabel({ stock: 0 }) === 'Stock: 0');
ck('a real count reads through', C.stockLabel(CHARGER) === 'Stock: 18');
ck('a service has no stock label at all', C.stockLabel(PRINTING) === null);
ck('OUT OF STOCK badge only on a real zero', C.badgesFor({ stock: 0 }).indexOf('OUT OF STOCK') !== -1);
ck('…and NOT on an untracked row',
   C.badgesFor(LEGACY).indexOf('OUT OF STOCK') === -1, C.badgesFor(LEGACY).join('|'));

/* 10 */
console.log('\n── 10. Empty states ──');
ck('products-only empty', C.emptyMessage(scopeProducts, 'all').t === 'No products yet.');
ck('services-only empty', C.emptyMessage(scopeServices, 'all').t === 'No services yet.');
ck('dual empty', C.emptyMessage(scopeDual, 'all').t === 'Your catalogue is empty.');
ck('…and dual invites both', /products, services, or both/.test(C.emptyMessage(scopeDual, 'all').s));
ck('no scope invites applying', /Apply for a SOKONI business/.test(C.emptyMessage(null, 'all').s));
ck('the PRODUCTS tab empty is tab-specific', C.emptyMessage(scopeDual, 'products').t === 'No products yet.');

/* 11 */
console.log('\n── 11. Search and filter never mix the two kinds ──');
{
  const rows = [CHARGER, PRINTING, REPAIR, LEGACY, Object.assign({}, PRINTING, { id: 's9', name: 'Old Scan', active: false })];
  const prods = C.filterRows(rows, { tab: 'products' });
  ck('the PRODUCTS tab returns only products', prods.every(C.isProduct) && prods.length === 2, prods.length);
  const svcs = C.filterRows(rows, { tab: 'services' });
  ck('the SERVICES tab returns only services', svcs.every(C.isService) && svcs.length === 3, svcs.length);
  ck('ALL returns everything', C.filterRows(rows, { tab: 'all' }).length === 5);
  ck('archived filter works', C.filterRows(rows, { status: 'archived' }).length === 1);
  ck('active filter excludes archived', C.filterRows(rows, { status: 'active' }).length === 4);
  ck('search matches name', C.filterRows(rows, { query: 'print' }).length === 1);
  ck('search matches sku', C.filterRows(rows, { query: 'chg-1' }).length === 1);
  ck('search is case-insensitive', C.filterRows(rows, { query: 'PRINT' }).length === 1);
  ck('search + tab compose',
     C.filterRows(rows, { query: 'scan', tab: 'services' }).length === 1);
  ck('a search that matches nothing returns []', C.filterRows(rows, { query: 'zzz' }).length === 0);
}

console.log('\n── Draft validation ──');
ck('a service needs a unit', !C.validateDraft('service', { name: 'X', price: 20 }).ok);
ck('…and says so', /unit/i.test(C.validateDraft('service', { name: 'X', price: 20 }).problems.join(' ')));
ck('a service with a unit passes', C.validateDraft('service', { name: 'X', price: 20, unit: 'page' }).ok);
ck('a fixed item needs a price > 0', !C.validateDraft('service', { name: 'X', price: 0, unit: 'page' }).ok);
ck('a VARIABLE service may omit the price',
   C.validateDraft('service', { name: 'Repair', unit: 'service', variablePrice: true, price: '' }).ok);
ck('a name is required', !C.validateDraft('product', { price: 5 }).ok);
ck('negative stock is refused', !C.validateDraft('product', { name: 'X', price: 5, stock: -1 }).ok);
ck('blank stock is fine (unmetered)', C.validateDraft('product', { name: 'X', price: 5, stock: '' }).ok);

console.log('\n── Archive is a merge patch; no hard delete exists ──');
{
  const p = C.archivePatch('cashier_1');
  ck('archive sets active:false', p.active === false);
  ck('…and records who', p.deletedBy === 'cashier_1');
  ck('…and is a PATCH, not a whole row', Object.keys(p).length === 3, Object.keys(p).join(','));
  ck('restore exists', C.restorePatch().active === true);
  ck('no delete function is exported',
     typeof C.deleteRow === 'undefined' && typeof C.hardDelete === 'undefined');
}

/* 12 + 13 + 14 + 15 — boundary assertions over the repository itself */
console.log('\n── 12-15. The slice did not cross its boundary ──');
{
  const root = path.join(__dirname, '..');
  const model = fsmod.readFileSync(path.join(root, 'sokoni-catalogue-model.js'), 'utf8');
  const page  = fsmod.existsSync(path.join(root, 'catalogue.html'))
    ? fsmod.readFileSync(path.join(root, 'catalogue.html'), 'utf8') : '';
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
                        .replace(/<!--[\s\S]*?-->/g, '');
  const mCode = strip(model), pCode = strip(page);

  ck('12. no posServices collection is introduced',
     !/posServices/.test(mCode) && !/posServices/.test(pCode));
  ck('…and posProducts IS the collection used (positive control)',
     /posProducts/.test(pCode), page ? 'catalogue.html read' : 'page missing');
  ck('13. no payment rail is touched from the catalogue',
     !/createPaymentIntent|webhookIntasend|initiateSTKPush|payment-purposes/.test(mCode + pCode));
  ck('14. no quick-charge receiver is introduced',
     !/quick_?[Cc]harge\s*[:(]/.test(mCode + pCode));
  ck('15. no completeMultiTender implementation',
     !/completeMultiTender/.test(mCode + pCode));
  ck('the model is pure — no DOM', !/\bdocument\./.test(mCode));
  ck('…no firestore', !/firestore|firebase/i.test(mCode));
  ck('…and the stripper left real code (positive control)',
     /function applyEdit/.test(mCode), mCode.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
