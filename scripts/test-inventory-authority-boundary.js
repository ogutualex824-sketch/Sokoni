/* ══════════════════════════════════════════════════════════════════════════════
   The inventory boundary — EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
   Products owns product METADATA.  Inventory owns the SHELF COUNT.

       create  → product metadata  +  optional opening quantity
                                        └─ merchantAdjustStock (server, transactional,
                                           floored, inventoryVersion, stockMovements row)
       edit    → product metadata ONLY. A stock patch is REFUSED, never dropped.

   THE DEFECT THIS CLOSES. The Products editor rendered a numeric Stock input on both create
   and edit. Its value flowed through FORM_KEYS → _productFields (which allowlisted `stock`)
   → the merchant-v2 writeProduct adapter → `setDoc(products/{id}, {stock, …}, {merge:true})`
   with no transaction, no inventoryVersion and no floor. A second path existed via variants:
   the specs module computes `patch.stock` from variant rows, so removing the allowlist entry
   alone would NOT have closed it.

   WHY REFUSING BEATS DROPPING. If a stock edit were silently ignored, the merchant types a
   figure, sees "Changes saved.", and the shelf count never moves. A fabricated success is a
   worse defect than the one being fixed, so updateProduct throws and the editor renders no
   input at all — two independent reasons an edit cannot mutate stock.

   Run: node scripts/test-inventory-authority-boundary.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

/* ── Load the module with a browser-ish global ─────────────────────────────── */
global.window = global;
require(path.join(ROOT, 'sokoni-product-specs.js'));
require(path.join(ROOT, 'sokoni-merchant-data.js'));
const MD = global.window.SokoniMerchantData;

const SCOPE = { ok: true, shopId: 'SHOP_A', sellerUid: 'seller_1' };

/* A db adapter that RECORDS every write, so "did stock reach the document?" is a
   measurement rather than an inspection. */
function mkDb (over) {
  const calls = { writes: [], gets: 0 };
  return Object.assign({
    calls,
    writeProduct: async (o) => { calls.writes.push(o); return { replayed: false }; },
    deleteProduct: async () => ({}),
    getProduct: async () => { calls.gets++; return calls._existing || null; },
    _existing: null,
  }, over || {});
}
function mkAdjust (over) {
  const calls = [];
  const fn = async (p) => { calls.push(p); if (over && over.throws) throw new Error(over.throws); return { ok: true }; };
  fn.calls = calls;
  return fn;
}
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
const lastWrite = (db) => db.calls.writes[db.calls.writes.length - 1];

(async () => {
  head('0 - controls');
  ck('CONTROL: the module loaded', !!MD && typeof MD.createProduct === 'function');
  ck('CONTROL: the specs module loaded (the variant path needs it)',
     !!global.window.SokoniProductSpecs && typeof global.window.SokoniProductSpecs.totalStock === 'function');

  /* ── 1. create WITH opening stock ───────────────────────────────────────── */
  head('1 - create with an opening quantity');
  let db = mkDb(), adj = mkAdjust();
  let res = await MD.createProduct({
    scope: SCOPE, db, draftToken: 't1', adjustStock: adj,
    product: { name: 'Sugar 1kg', price: 120, stock: 40 },
  });
  ck('the product is created', !!res.id);
  ck('the metadata write carries NO stock', lastWrite(db).data.stock === undefined,
     'stock in the document would be an untransacted, unversioned shelf count');
  ck('the inventory authority was called once', adj.calls.length === 1);
  ck('with the opening quantity as a positive delta', adj.calls[0].delta === 40);
  ck('and a reason the server accepts', adj.calls[0].reason === 'restock');
  ck('shopId comes from the resolved scope', adj.calls[0].shopId === 'SHOP_A');
  ck('the result reports the opening stock landed', res.openingStock && res.openingStock.ok === true);

  head('2 - the adjustment id is deterministic, so a retry cannot double the shelf');
  const db2 = mkDb(), adj2 = mkAdjust();
  const a = await MD.createProduct({ scope: SCOPE, db: db2, draftToken: 'same', adjustStock: adj2,
    product: { name: 'Sugar 1kg', price: 120, stock: 40 } });
  const b = await MD.createProduct({ scope: SCOPE, db: db2, draftToken: 'same', adjustStock: adj2,
    product: { name: 'Sugar 1kg', price: 120, stock: 40 } });
  ck('the same draftToken claims the same product id', a.id === b.id);
  ck('and therefore the same adjustmentId', adj2.calls[0].adjustmentId === adj2.calls[1].adjustmentId,
     adj2.calls[0].adjustmentId);
  ck('the id is derived from the product, not random', adj2.calls[0].adjustmentId === 'open_' + a.id);

  /* ── 3. create WITHOUT stock ────────────────────────────────────────────── */
  head('3 - create without an opening quantity');
  db = mkDb(); adj = mkAdjust();
  res = await MD.createProduct({ scope: SCOPE, db, draftToken: 't3', adjustStock: adj,
    product: { name: 'Notebook', price: 80 } });
  ck('the product is created', !!res.id);
  ck('the inventory authority is NOT called', adj.calls.length === 0,
     'no opening quantity was asked for; inventing one would be a fabricated fact');
  ck('the document has no stock field', lastWrite(db).data.stock === undefined);
  ck('and nothing claims an opening stock happened', res.openingStock === null);

  head('4 - an explicit zero is not an invented zero');
  db = mkDb(); adj = mkAdjust();
  res = await MD.createProduct({ scope: SCOPE, db, draftToken: 't4', adjustStock: adj,
    product: { name: 'Pen', price: 20, stock: 0 } });
  ck('zero does not call the authority', adj.calls.length === 0,
     'merchantAdjustStock refuses a zero delta by design — nothing to move');
  ck('and it is reported as a real zero, not silence',
     res.openingStock && res.openingStock.opening === 0 && res.openingStock.noop === true);

  /* ── 5. EDIT CANNOT MUTATE STOCK ────────────────────────────────────────── */
  head('5 - an edit cannot change an existing shelf count');
  db = mkDb(); db.calls._existing = { name: 'Sugar 1kg', price: 120, shopId: 'SHOP_A', sellerUid: 'seller_1' };
  let e = await caught(MD.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { stock: 99 } }));
  ck('it is REFUSED', !!e, e && e.message);
  ck('with a code the UI can act on', e && e.code === 'stock-not-editable');
  ck('the message sends the merchant to Inventory', e && /Inventory/i.test(e.message), e && e.message);
  ck('and NOTHING was written', db.calls.writes.length === 0,
     'a dropped stock edit with a "Changes saved" toast is worse than a refusal');

  e = await caught(MD.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { name: 'X', stock: 5 } }));
  ck('a stock key smuggled alongside metadata is refused too', e && e.code === 'stock-not-editable');
  ck('and that write did not happen either', db.calls.writes.length === 0);

  /* THE SECOND PATH — variants. */
  e = await caught(MD.updateProduct({ scope: SCOPE, db, id: 'p1',
    patch: { variants: [{ attrs: { Size: 'M' }, stock: 7 }] } }));
  ck('the VARIANT path is refused as well', e && e.code === 'stock-not-editable',
     'specs.build() computes patch.stock from variant rows — removing the allowlist alone missed this');

  head('6 - a metadata-only edit still works');
  db = mkDb(); db.calls._existing = { name: 'Sugar 1kg', price: 120, shopId: 'SHOP_A', sellerUid: 'seller_1' };
  const up = await MD.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { name: 'Sugar 2kg', price: 240 } });
  ck('it writes', db.calls.writes.length === 1 && up.id === 'p1');
  ck('name and price land', up.patch.name === 'Sugar 2kg' && up.patch.price === 240);
  ck('and no stock rides along', up.patch.stock === undefined && lastWrite(db).data.stock === undefined);

  /* ── 7. the variant path on CREATE goes to the authority, not the doc ───── */
  head('7 - variant totals are a shelf count, not metadata');
  db = mkDb(); adj = mkAdjust();
  res = await MD.createProduct({ scope: SCOPE, db, draftToken: 't7', adjustStock: adj,
    product: { name: 'Tee', price: 500,
               variants: [{ attrs: { Size: 'S' }, stock: 3 }, { attrs: { Size: 'M' }, stock: 4 }] } });
  ck('the document still carries no stock', lastWrite(db).data.stock === undefined);
  ck('the variant total went to the authority', adj.calls.length === 1 && adj.calls[0].delta === 7,
     'got delta=' + (adj.calls[0] && adj.calls[0].delta));

  /* ── 8. invalid quantities ──────────────────────────────────────────────── */
  head('8 - invalid opening quantities are rejected before anything is written');
  for (const [label, val] of [['negative', -5], ['fractional', 2.5], ['not a number', 'many'],
                              ['implausibly large', 5000000]]) {
    db = mkDb(); adj = mkAdjust();
    e = await caught(MD.createProduct({ scope: SCOPE, db, draftToken: 't8', adjustStock: adj,
      product: { name: 'X', price: 10, stock: val } }));
    ck('a ' + label + ' opening stock is refused', !!e, e && e.message);
    ck('  …and no product was created', db.calls.writes.length === 0,
       'validating after the write would leave a product nobody asked for');
    ck('  …and the authority was never called', adj.calls.length === 0);
  }

  /* ── 9. a failed adjustment is reported, never swallowed ────────────────── */
  head('9 - a failed opening adjustment does not become a silent success');
  db = mkDb(); adj = mkAdjust({ throws: 'permission-denied' });
  res = await MD.createProduct({ scope: SCOPE, db, draftToken: 't9', adjustStock: adj,
    product: { name: 'Rice', price: 200, stock: 12 } });
  ck('the product still exists', !!res.id, 'it genuinely was created — saying otherwise would be a lie too');
  ck('but the opening stock is reported as NOT ok', res.openingStock && res.openingStock.ok === false);
  ck('with the reason preserved', /permission-denied/.test(res.openingStock.reason || ''));
  ck('and the document has no stock', lastWrite(db).data.stock === undefined,
     'the shelf count is unknown, which is the truth');

  db = mkDb();
  res = await MD.createProduct({ scope: SCOPE, db, draftToken: 't9b',
    product: { name: 'Rice', price: 200, stock: 12 } });   /* no adjustStock supplied */
  ck('a missing inventory adapter is reported, not ignored',
     res.openingStock && res.openingStock.ok === false && res.openingStock.reason === 'no-inventory-adapter');

  /* ── 10. the editor renders no stock input on edit ──────────────────────── */
  head('10 - the editor offers no control that would lie');
  const PS = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
  const code = PS.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('stock is rendered as an input only when creating',
     /creating\s*\?\s*fld\('stock'/.test(code), 'a control that the writer refuses is a control that lies');
  ck('edit mode renders a read-only presentation', /:\s*stockReadHTML\(p\)/.test(code));
  ck('the read-only block carries NO data-pf', (() => {
    const i = code.indexOf('function stockReadHTML');
    return i > 0 && !/data-pf/.test(code.slice(i, i + 700));
  })(), 'captureForm() reads by data-pf, so this cannot contribute to a patch');
  ck('unknown stock renders as — and never as 0', (() => {
    const i = code.indexOf('function stockReadHTML');
    return i > 0 && /'—'/.test(code.slice(i, i + 700));
  })());

  head('11 - the corrected contracts match the behaviour');
  const MDsrc = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
  ck('the false "no stock-writing function at all" claim is gone',
     !/no stock-writing function at all — not one\./.test(MDsrc));
  ck('and the openingStock route is documented', /openingStock/.test(MDsrc));
  ck('the products header no longer claims stock is read-only outright',
     !/shows\s*\n?\s*stock as a READ and offers no way to change it\. The two must not merge\./.test(PS));
  ck('it now distinguishes create from edit', /on EDIT this surface shows stock as a read/i.test(PS));

  head('12 - the WRITE SITE itself refuses authority fields');
  /* The register entry rests on this guard, so it is executed, not read. The payload reaching
     the adapter is computed, so the static detector cannot vouch for it — this can. */
  const MV2 = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
  const gs = MV2.indexOf('_refuseAuthorityFields: function');
  ck('CONTROL: the guard exists in the shipped shell', gs > 0);
  let gd = 0, ge = -1;
  for (let i = MV2.indexOf('{', gs); i < MV2.length; i++) {
    if (MV2[i] === '{') gd++; else if (MV2[i] === '}') { gd--; if (!gd) { ge = i + 1; break; } }
  }
  const guardSrc = MV2.slice(MV2.indexOf('{', gs), ge);
  const guard = new Function('return function (data, where) ' + guardSrc)()
    .bind({ _AUTHORITY_FIELDS: ['stock', 'sold', 'inventoryVersion', 'stockQty'] });

  ck('plain metadata passes', !!guard({ name: 'X', price: 10 }, 'test'));
  ['stock', 'sold', 'inventoryVersion', 'stockQty'].forEach((f) => {
    const payload = { name: 'X' }; payload[f] = 1;
    let threw = null;
    try { guard(payload, 'writeProduct'); } catch (err) { threw = err; }
    ck('"' + f + '" in the payload THROWS', !!threw, threw && threw.message);
  });
  let z = null;
  try { guard({ name: 'X', stock: 0 }, 'writeProduct'); } catch (err) { z = err; }
  ck('even stock: 0 throws — presence, not truthiness', !!z,
     'a falsy authority field is still an authority write');
  ck('the guard is wired into writeProduct',
     /self\._refuseAuthorityFields\(o && o\.data, 'writeProduct'\)/.test(MV2));
  const wp = MV2.indexOf('writeProduct: function (o)');
  const wpBody = MV2.slice(wp, wp + 900);
  ck('and it runs BEFORE the document reference is built',
     wpBody.indexOf('_refuseAuthorityFields') < wpBody.indexOf('m.fs.doc('),
     'a guard after the write is decoration');

  head('13 - the gate that blocked hosting now passes, for the right reason');
  const GW = fs.readFileSync(path.join(ROOT, 'scripts', 'gate-inventory-writers.js'), 'utf8');
  ck('merchant-v2.html is registered as METADATA, not CLIENT or AUTHORING',
     /const METADATA = \[[\s\S]{0,600}merchant-v2\.html/.test(GW));
  ck('the detector was NOT weakened',
     /const AUTHORITY_FIELDS = \['stock', 'sold', 'inventoryVersion', 'stockQty'\];/.test(GW),
     'the fix was to make the writer safe, never to make the detector blind');
  ck('the reason names the write-site guard', /_refuseAuthorityFields\(\) THROWS/.test(GW));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
