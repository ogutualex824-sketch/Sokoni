/* ══════════════════════════════════════════════════════════════════════════════
   ADVANCED UPLOADER — WRITER DECISIONS (Unit B, 2026-10-01)
   ══════════════════════════════════════════════════════════════════════════════
   The c4 product writer was ported onto the live hosting line with the live line's
   stock and specification rules kept (owner decision 2026-10-01). This suite proves
   the decisions by EXECUTING the writer against a recording adapter:

     V  a stock patch and a per-variant quantity patch are REFUSED with zero writes;
        a variants patch that carries no quantity is accepted, and every stored row
        keeps the quantity it had (matched by id); a new row starts at 0 with a fresh
        id that can never inherit another row's quantity.
     S  specs / variants / stockUnit go through SokoniProductSpecs.build() — invalid
        records fail the save; without the model they are not stored at all.
     C  create still takes an opening quantity through merchantAdjustStock, never as
        a field in the product document.
     L  subscribeProducts is callable, throws no ReferenceError, and yields the SAME
        rows as listProducts (the live line called an undefined `mapProducts`).
     Q  no Quick Charge (2175115) symbol is present in the writer.
     A  Remove archives (tombstone), never deletes; the till mirror follows.
     K  the per-business-type listing limits are applied by the writer — in the
        BROWSER only (no server check exists yet; queued as its own functions unit).

   Node-only. No browser, no emulator, no network.
   Run: node scripts/test-uploader-writer-decisions.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 240) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
const M = require(path.join(ROOT, 'sokoni-merchant-data.js'));

const SCOPE = { ok: true, shopId: 'shop_A', sellerUid: 'uid_A' };

function adapter(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const log = [];
  const mirrors = {};
  return {
    log, store, mirrors,
    writeProduct: async ({ id, data, mode }) => {
      log.push({ op: mode || 'write', id, data: JSON.parse(JSON.stringify(data)) });
      if (mode === 'create' && store[id]) return { replayed: true };
      store[id] = Object.assign({}, store[id] || {}, data);
      return { replayed: false };
    },
    deleteProduct: async ({ id }) => { log.push({ op: 'delete', id }); delete store[id]; },
    getProduct: async (id) => (store[id] ? JSON.parse(JSON.stringify(store[id])) : null),
    queryProducts: async () => Object.keys(store).map((id) => Object.assign({ id }, store[id])),
    writeMirror: async ({ path: p, data }) => { mirrors[p.join('/')] = Object.assign({}, mirrors[p.join('/')] || {}, data); },
  };
}
const allow = async () => ({ data: { allowed: true } });

function seeded() {
  return adapter({
    p1: {
      shopId: 'shop_A', sellerUid: 'uid_A', name: 'Sneaker', price: 3000, status: 'active', stock: 12,
      variants: [
        { id: 'v1', attrs: { Colour: 'Black', Size: '42' }, stock: 5, price: 3000 },
        { id: 'v2', attrs: { Colour: 'White', Size: '42' }, stock: 7, price: 3100 },
      ],
    },
  });
}

async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

(async () => {
  console.log('\nADVANCED UPLOADER - WRITER DECISIONS (Unit B)');
  console.log('='.repeat(76));

  /* The spec model is a browser global in production; load it the same way. */
  require(path.join(ROOT, 'sokoni-product-specs.js'));
  ck('NC the specification model loaded as a global', !!globalThis.SokoniProductSpecs);

  head('V - Inventory is the only stock writer');
  let db = seeded();
  let e = await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { stock: 99 } }));
  ck('V1 a product-level stock patch is refused', !!e && e.code === 'stock-not-editable', e && e.code);
  ck('V2 ...with zero writes', db.log.length === 0, JSON.stringify(db.log));

  db = seeded();
  e = await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: {
    variants: [{ id: 'v1', attrs: { Colour: 'Black', Size: '42' }, stock: 50 }],
  } }));
  ck('V3 a per-variant quantity in an update patch is refused', !!e && e.code === 'stock-not-editable' && e.reason === 'variant-quantity', e && e.code);
  ck('V4 ...with zero writes', db.log.length === 0, JSON.stringify(db.log));
  ck('V5 ...and the refusal says where stock IS changed', !!e && /Inventory/.test(e.message), e && e.message);

  db = seeded();
  e = await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: {
    variants: [{ id: 'v1', attrs: { Colour: 'Black' }, stock: '0' }],
  } }));
  ck('V6 even a quantity of "0" is a quantity - refused', !!e && e.code === 'stock-not-editable' && e.reason === 'variant-quantity', e && e.code);

  db = seeded();
  const r = await M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: {
    variants: [
      { id: 'v1', attrs: { Colour: 'Jet black', Size: '42' }, price: 3200, sku: 'SN-BLK-42' },
      { id: 'v2', attrs: { Colour: 'White', Size: '42' }, price: 3100 },
      { attrs: { Colour: 'Red', Size: '42' }, price: 3300 },
    ],
  } });
  const w = db.log.find((l) => l.op === 'update');
  const vs = (w && w.data.variants) || [];
  const byId = Object.fromEntries(vs.map((v) => [v.id, v]));
  ck('V7 a variants patch WITHOUT quantities is accepted (rename / reprice / re-SKU)', !!w && vs.length === 3, JSON.stringify(vs));
  ck('V8 the renamed row keeps its stored quantity (5), matched by id', byId.v1 && byId.v1.stock === 5 && byId.v1.attrs.Colour === 'Jet black' && byId.v1.price === 3200,
     JSON.stringify(byId.v1));
  ck('V9 the untouched row keeps its stored quantity (7)', byId.v2 && byId.v2.stock === 7, JSON.stringify(byId.v2));
  const fresh = vs.find((v) => v.attrs.Colour === 'Red');
  ck('V10 a row added by an edit starts at 0, with a fresh id', !!fresh && fresh.stock === 0 && fresh.id !== 'v1' && fresh.id !== 'v2', JSON.stringify(fresh));
  ck('V11 the update wrote NO product-level stock', !!w && !Object.prototype.hasOwnProperty.call(w.data, 'stock'), w && Object.keys(w.data).join(','));
  ck('V12 the stored products.stock is unchanged', db.store.p1.stock === 12, db.store.p1.stock);
  ck('V13 the returned patch is what was written', !!r && JSON.stringify(r.patch.variants) === JSON.stringify(vs));

  /* A new row must never inherit a stored row's quantity by landing on its id or index. */
  db = seeded();
  await M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: {
    variants: [
      { id: 'v2', attrs: { Colour: 'White', Size: '42' } },
      { attrs: { Colour: 'Blue', Size: '42' } },                     /* index 1, would be "v2" positionally */
      { id: 'v2', attrs: { Colour: 'Grey', Size: '42' } },           /* a duplicated stored id */
      { id: 'forged', attrs: { Colour: 'Green', Size: '42' } },      /* an id that was never stored */
    ],
  } });
  const w2 = db.log.find((l) => l.op === 'update');
  const vs2 = (w2 && w2.data.variants) || [];
  const col = (c) => vs2.find((v) => v.attrs.Colour === c) || {};
  ck('V14 the stored row keeps 7', col('White').stock === 7 && col('White').id === 'v2', JSON.stringify(col('White')));
  ck('V15 a new row at a stored row\'s position gets 0, not its quantity', col('Blue').stock === 0 && col('Blue').id !== 'v2', JSON.stringify(col('Blue')));
  ck('V16 a duplicated stored id is honoured once; the second copy is new (0)', col('Grey').stock === 0 && col('Grey').id !== 'v2', JSON.stringify(col('Grey')));
  ck('V17 an id that was never stored is treated as new (0)', col('Green').stock === 0 && col('Green').id !== 'forged', JSON.stringify(col('Green')));
  ck('V18 every written id is unique', new Set(vs2.map((v) => v.id)).size === vs2.length, vs2.map((v) => v.id).join(','));

  /* Without the stored record the quantities cannot be kept, so the write is refused. */
  const noGet = seeded(); delete noGet.getProduct;
  e = await refusal(() => M.updateProduct({ scope: SCOPE, db: noGet, id: 'p1', patch: {
    variants: [{ id: 'v1', attrs: { Colour: 'Black', Size: '42' } }],
  } }));
  ck('V19 a variants patch with no readable stored record is refused, not guessed', !!e && e.code === 'variant-stock-unverifiable' && noGet.log.length === 0, e && e.code);

  head('S - specifications and variants are validated by SokoniProductSpecs.build()');
  db = seeded();
  e = await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: {
    variants: [{ id: 'v1', attrs: { Colour: 'Black' } }, { id: 'v2', attrs: { colour: 'black' } }],
  } }));
  ck('S1 duplicate variant options are refused', !!e && /share the same options/.test(e.message) && db.log.length === 0, e && e.message);
  db = seeded();
  e = await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { variants: [{ id: 'v1', attrs: {} }] } }));
  ck('S2 a variant with no option is refused', !!e && /at least one option/.test(e.message) && db.log.length === 0, e && e.message);
  db = seeded();
  e = await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { specs: { weight: { v: 2, u: 'zorkmids' } } } }));
  ck('S3 an unrecognised unit is refused, not stored as a meaningless number', !!e && /not a unit we recognise/.test(e.message) && db.log.length === 0, e && e.message);
  db = seeded();
  await M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { specs: { weight: { v: 500, u: 'g' }, brand: ' Bata ' } } });
  const w3 = db.log.find((l) => l.op === 'update');
  ck('S4 valid specs are stored NORMALISED by the model', !!w3 && w3.data.specs && w3.data.specs.brand === 'Bata' && !!w3.data.specs.weight,
     w3 && JSON.stringify(w3.data.specs));
  ck('S5 unknown keys never reach the document', !!w3 && !('bogus' in w3.data));

  /* Without the model: optional data is not stored, and the save still works. */
  const SPsave = globalThis.SokoniProductSpecs;
  delete globalThis.SokoniProductSpecs;
  db = seeded();
  await M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { name: 'Sneaker 2', specs: { brand: 'X' } } });
  const w4 = db.log.find((l) => l.op === 'update');
  ck('S6 with no spec model, specs are NOT stored unvalidated', !!w4 && !('specs' in w4.data) && w4.data.name === 'Sneaker 2', w4 && Object.keys(w4.data).join(','));
  globalThis.SokoniProductSpecs = SPsave;

  head('C - create: opening quantity goes through merchantAdjustStock');
  db = adapter();
  const adj = [];
  const rc = await M.createProduct({
    scope: SCOPE, db, draftToken: 'c1', canPublish: allow,
    adjustStock: async (a) => { adj.push(a); return { data: { ok: true } }; },
    product: { name: 'Tee', price: 800, variants: [
      { attrs: { Size: 'M' }, stock: 3 }, { attrs: { Size: 'L' }, stock: 4 },
    ] },
  });
  const cw = db.log.find((l) => l.op === 'create');
  ck('C1 the product document carries NO stock field', !!cw && !Object.prototype.hasOwnProperty.call(cw.data, 'stock'), cw && Object.keys(cw.data).join(','));
  ck('C2 the opening quantity (3 + 4) is ONE merchantAdjustStock movement', adj.length === 1 && adj[0].delta === 7 && adj[0].adjustmentId === 'open_' + rc.id,
     JSON.stringify(adj));
  ck('C3 the per-variant opening quantities are recorded on the variant rows', !!cw && cw.data.variants && cw.data.variants[0].stock === 3 && cw.data.variants[1].stock === 4);

  head('L - subscribeProducts (restored from live, mapProducts defined)');
  ck('L1 subscribeProducts is exported', typeof M.subscribeProducts === 'function');
  ck('L2 mapProducts is DEFINED in the writer (the live line called it undefined)', /function mapProducts\s*\(/.test(SRC));
  db = seeded();
  let got = null, err = null, unsub = null;
  const subDb = Object.assign({}, db, {
    subscribeProducts: (q, onRows, onErr) => {
      ck('L3 the live read uses the SAME query descriptor as listProducts', JSON.stringify(q) === JSON.stringify(M.productQuery(SCOPE)), JSON.stringify(q));
      setTimeout(() => { db.queryProducts().then(onRows).catch(onErr); }, 0);
      return function () {};
    },
  });
  try {
    unsub = M.subscribeProducts({ scope: SCOPE, db: subDb, onProducts: (rows) => { got = rows; }, onError: (x) => { err = x; } });
  } catch (x) { err = x; }
  await new Promise((res) => setTimeout(res, 20));
  ck('L4 no ReferenceError (or any error) on delivery', !err && Array.isArray(got), err && String(err));
  ck('L5 it returns the adapter\'s unsubscribe', typeof unsub === 'function');
  const listed = await M.listProducts({ scope: SCOPE, db });
  ck('L6 the live rows are identical to listProducts rows', JSON.stringify(got) === JSON.stringify(listed));
  ck('L7 an adapter without subscribeProducts yields null, not a throw', M.subscribeProducts({ scope: SCOPE, db: adapter(), onProducts() {} }) === null);

  head('Q - Quick Charge Step 2 (2175115) is NOT in this port');
  ck('Q1 no addQuickCharge function or export', !/addQuickCharge/.test(SRC) && typeof M.addQuickCharge === 'undefined');
  ck('Q2 buildSale has no quick-charge line shape', !/quickCharge\s*:/.test(SRC) && !/l\.quick\b/.test(SRC));
  ck('Q3 no quick-charge id prefix', !/'qc_'/.test(SRC));

  head('A - Remove archives; it never deletes');
  db = seeded();
  const ra = await M.deleteProduct({ scope: SCOPE, db, id: 'p1' });
  ck('A1 deleteProduct ARCHIVES (no physical delete)', db.log.every((l) => l.op !== 'delete') && db.store.p1 && db.store.p1.status === 'archived' && db.store.p1.isVisible === false,
     JSON.stringify(db.log.map((l) => l.op)));
  ck('A2 the till copy follows', db.mirrors['posProducts/p1'] && db.mirrors['posProducts/p1'].status === 'archived');
  ck('A3 it says so', ra.deleted === false && ra.method === 'tombstone');
  const rr = await M.restoreProduct({ scope: SCOPE, db, id: 'p1' });
  ck('A4 restore returns it to the status it had', rr.restored === true && db.store.p1.status === 'active' && db.store.p1.isVisible === true);

  head('K - listing limits per business type (BROWSER-ENFORCED ONLY)');
  require(path.join(ROOT, 'sokoni-product-taxonomy.js'));
  require(path.join(ROOT, 'sokoni-catalogue-capabilities.js'));
  db = seeded();
  e = await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', businessCategory: null, patch: { listingType: 'room' } }));
  ck('K1 an UNCLASSIFIED business listing a room is refused by the writer', !!e && db.log.length === 0, e && (e.code + ' ' + e.message));
  ck('K2 the writer states the check is CLIENT-side', /CLIENT-side/.test(SRC));

  head('U - the editor offers no per-variant quantity on an EXISTING product (static; the browser run is queued)');
  const PSRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
  ck('U1 the quantity input is rendered only when NOT editing', /\(editing\s*\?[\s\S]{0,700}:\s*'<input class="pr-i pr-vqty" data-pf="variant\.' \+ r \+ '\.stock"/.test(PSRC));
  ck('U2 a stored row carries its id in a hidden field (how the writer matches it)', PSRC.indexOf('data-pf="variant.\' + r + \'.id"') > -1);
  ck('U3 the section points at Inventory instead', /Variant quantities are changed in Inventory, not here/.test(PSRC) && /data-pr="go" data-route="inventory">📦 Adjust stock in Inventory/.test(PSRC));
  ck('U4 no "sum of every variant" promise while editing', /var total = \(!editing && SP/.test(PSRC));

  console.log('\n' + '='.repeat(76));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((x) => { console.error('suite crashed:', x); process.exit(2); });
