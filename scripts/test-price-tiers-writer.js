/* ══════════════════════════════════════════════════════════════════════════════
   PRICE TIERS — WRITER + FORM (2026-10-01)
   ══════════════════════════════════════════════════════════════════════════════
   Owner model: three independent prices on one product, no new pricing object.
     ONLINE    = price           (required; marketplace, cart, checkout read it)
     SHELF     = shopPrice       (new, optional; label "Shelf", field unchanged)
     WHOLESALE = wholesalePrice  (existing, optional; the bulk price)
   An absent tier is NOT AVAILABLE and is stored ABSENT — never 0, never null.

   This suite EXECUTES sokoni-merchant-data.js against a recording adapter:
     F  allowlist + mapProducts carry shopPrice
     A  absent stays absent (create; '' and null; mirrors omit it)
     Z  0 / negative / non-number / over MAX_PRICE refused, with the tier named
     O  ordering: wholesale < online, shop <= online, wholesale <= shop — each named
     Q  minWholesaleQty no longer required; negative / non-integer still refused
     E  edit: clearing a tier deletes the field; an untouched tier is preserved;
        ordering checked against the STORED tiers; a delete the adapter cannot
        express is refused with zero writes
     M  posProducts / inventory_products carry shopPrice + wholesalePrice, omit
        absent tiers, follow an edit (set and delete), never create a mirror
     U  the form renders three labelled inputs with chips and helper text (static)
     P  SHELF IS OWNER-PRIVATE (owner decision 2026-10-01): products/{id} is public, so
        shopPrice is NEVER written there (create or edit); it lives ONLY on posProducts/{id}
        (owner/admin-readable, served rules f259c0b5); inventory_products never carries it;
        an edit deletes a leaked products.shopPrice; ordering reads the stored Shelf from
        posProducts; an unreadable posProducts refuses an ordering-relevant edit (zero
        writes) and allows an unrelated one; the edit form reads it once per opened product.
        NEGATIVE CONTROL: SOKONI_PT_NEGCTL=1 re-introduces shopPrice into the products
        payload (wrapping every writeProduct call) — the suite must then FAIL.

   Node-only. No browser, no emulator, no network.
   Run: node scripts/test-price-tiers-writer.js
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
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
const PSRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
const HSRC = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const M = require(path.join(ROOT, 'sokoni-merchant-data.js'));

const SCOPE = { ok: true, shopId: 'shop_A', sellerUid: 'uid_A' };
const DEL = '__deleted__';

/* A recording adapter that behaves like the merchant-v2 one: deleteFields removes the
   field; a mirror write with mode 'update' fails when the mirror does not exist. */
function adapter(seed, opts) {
  const o = opts || {};
  const store = JSON.parse(JSON.stringify(seed || {}));
  const mirrors = JSON.parse(JSON.stringify(o.mirrors || {}));
  const log = [], mlog = [];
  const db = {
    log, mlog, store, mirrors,
    writeProduct: async (req) => {
      log.push(JSON.parse(JSON.stringify(req)));
      const { id, data, mode } = req;
      if (mode === 'create' && store[id]) return { replayed: true };
      store[id] = Object.assign({}, store[id] || {}, data);
      (req.deleteFields || []).forEach((k) => { delete store[id][k]; });
      return { replayed: false };
    },
    deleteProduct: async () => { throw new Error('never'); },
    getProduct: async (id) => (store[id] ? JSON.parse(JSON.stringify(store[id])) : null),
    posReads: [],
    /* posProducts/{id}: owner-readable. posReadable:false = the read is DENIED (throws). */
    getPosProduct: async (id) => {
      db.posReads.push(id);
      if (o.posReadable === false) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
      const k = 'posProducts/' + id;
      return mirrors[k] ? JSON.parse(JSON.stringify(mirrors[k])) : null;
    },
    queryProducts: async () => Object.keys(store).map((id) => Object.assign({ id }, store[id])),
    writeMirror: async (req) => {
      mlog.push(JSON.parse(JSON.stringify(req)));
      const key = req.path.join('/');
      if (req.mode === 'update' && !mirrors[key]) throw new Error('No document to update: ' + key);
      mirrors[key] = Object.assign({}, mirrors[key] || {}, req.data);
      (req.deleteFields || []).forEach((k) => { delete mirrors[key][k]; });
    },
  };
  if (o.supportsFieldDelete !== false) db.supportsFieldDelete = true;
  if (o.noPosReader) delete db.getPosProduct;
  /* NEGATIVE CONTROL: a writer that put shopPrice back on products/{id} — the P section must catch it. */
  if (process.env.SOKONI_PT_NEGCTL === '1') {
    const real = db.writeProduct;
    db.writeProduct = async (req) => real(Object.assign({}, req, { data: Object.assign({ shopPrice: 777 }, req.data) }));
  }
  return db;
}
const allow = async () => ({ data: { allowed: true } });
const POS = (id) => 'posProducts/' + id;
const prodWrites = (d) => d.log.filter((l) => l.mode === 'create' || l.mode === 'update');
const noShelfOnProducts = (d) => prodWrites(d).every((l) => !has(l.data, 'shopPrice'));
const INV = (id) => 'tenants/uid_A/inventory_products/' + id;

async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
let tok = 0;
const create = (db, product) => M.createProduct({ scope: SCOPE, db, draftToken: 't' + (++tok), canPublish: allow, product });
const createErr = async (product) => { const db = adapter(); const e = await refusal(() => create(db, product)); return { e, db }; };

/* The STORED state under the owner-private model: `extra.shopPrice` lives on posProducts ONLY; the public
   products/{id} carries a shopPrice only when `leak` is given (a legacy / leaked field). */
function stored(extra, leak) {
  const base = { shopId: 'shop_A', sellerUid: 'uid_A', name: 'Soap', price: 1000, status: 'active' };
  const ex = Object.assign({}, extra || {});
  const shelf = ex.shopPrice; delete ex.shopPrice;
  const p1 = Object.assign(base, ex);
  if (leak !== undefined) p1.shopPrice = leak;
  const mir = {};
  const wt = (typeof p1.wholesalePrice === 'number') ? { wholesalePrice: p1.wholesalePrice } : {};
  mir[POS('p1')] = Object.assign({ name: 'Soap', price: 1000, sellerId: 'uid_A' }, wt, typeof shelf === 'number' ? { shopPrice: shelf } : {});
  mir[INV('p1')] = Object.assign({ name: 'Soap', sellingPrice: 1000, tenantId: 'uid_A' }, wt);
  return { seed: { p1 }, mirrors: mir };
}
const edit = async (extra, patch, opts) => {
  const s = stored(extra, opts && opts.leak);
  const db = adapter(s.seed, Object.assign({ mirrors: s.mirrors }, opts || {}));
  let res = null;
  const e = await refusal(async () => { res = await M.updateProduct({ scope: SCOPE, db, id: 'p1', patch }); });
  return { e, db, res };
};

(async () => {
  console.log('\nPRICE TIERS - WRITER + FORM (Online=price, Shop=shopPrice, Wholesale=wholesalePrice)');
  console.log('='.repeat(76));

  head('F - the field is carried');
  ck('F1 shopPrice is in the writer allowlist (money list, empty = absent)',
     /\['deliveryCost', 'shopPrice', 'wholesalePrice', 'minWholesaleQty'\]\.forEach/.test(SRC));
  ck('F2 mapProducts does NOT map shopPrice (owner-private: never read from the public products doc)',
     !/shopPrice: \(typeof p\.shopPrice/.test(SRC) && /wholesalePrice: \(typeof p\.wholesalePrice === 'number'\) \? p\.wholesalePrice : null/.test(SRC));
  const listed = await M.listProducts({ scope: SCOPE, db: adapter({ a: { shopId: 'shop_A', sellerUid: 'uid_A', name: 'x', price: 9, shopPrice: 8, wholesalePrice: 7 },
                                                                     b: { shopId: 'shop_A', sellerUid: 'uid_A', name: 'y', price: 9 } }) });
  const rowA = (listed.rows || listed).find ? (listed.rows || listed).find((r) => r.id === 'a') : null;
  const rowB = (listed.rows || listed).find ? (listed.rows || listed).find((r) => r.id === 'b') : null;
  ck('F3 a listed row NEVER carries a Shelf price, even from a leaked products.shopPrice', !!rowA && !has(rowA, 'shopPrice') && rowA.wholesalePrice === 7,
     rowA && JSON.stringify(rowA.shopPrice));
  ck('F4 ...and an absent Wholesale tier maps to null (not 0)', !!rowB && rowB.wholesalePrice === null && !has(rowB, 'shopPrice'), rowB && JSON.stringify(rowB.wholesalePrice));
  ck('F5 MAX_PRICE is exported and positive', typeof M.MAX_PRICE === 'number' && M.MAX_PRICE > 0, M.MAX_PRICE);

  head('A - absent stays absent');
  let db = adapter();
  let r = await create(db, { name: 'Soap', price: 100 });
  let cw = db.log.find((l) => l.mode === 'create');
  ck('A1 no tiers given: the document has NO shopPrice and NO wholesalePrice', !!cw && !has(cw.data, 'shopPrice') && !has(cw.data, 'wholesalePrice'),
     cw && Object.keys(cw.data).join(','));
  ck('A2 ...and the till mirror omits them', !has(db.mirrors[POS(r.id)], 'shopPrice') && !has(db.mirrors[POS(r.id)], 'wholesalePrice'));
  ck('A3 ...and the Inventory mirror omits them', !has(db.mirrors[INV(r.id)], 'shopPrice') && !has(db.mirrors[INV(r.id)], 'wholesalePrice'));
  db = adapter();
  await create(db, { name: 'Soap', price: 100, shopPrice: '', wholesalePrice: null, minWholesaleQty: '' });
  cw = db.log.find((l) => l.mode === 'create');
  ck('A4 empty string / null tiers on create are ABSENT (not 0, not null)',
     !!cw && !has(cw.data, 'shopPrice') && !has(cw.data, 'wholesalePrice') && !has(cw.data, 'minWholesaleQty'), cw && JSON.stringify(cw.data));
  ck('A5 create never sends deleteFields', !!cw && !has(cw, 'deleteFields'));

  head('Z - each set tier: finite, > 0, <= MAX_PRICE');
  let x = await createErr({ name: 'S', price: 100, shopPrice: 0 });
  ck('Z1 Shelf price 0 is refused, naming the tier', !!x.e && /Shelf price must be above zero/.test(x.e.message) && x.db.log.length === 0, x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, wholesalePrice: 0 });
  ck('Z2 Wholesale price 0 is refused, naming the tier', !!x.e && /Wholesale price must be above zero/.test(x.e.message) && x.db.log.length === 0, x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, shopPrice: -5 });
  ck('Z3 a negative Shelf price is refused', !!x.e && /Shelf price must be above zero/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, wholesalePrice: 'abc' });
  ck('Z4 a non-number Wholesale price is refused', !!x.e && /Wholesale price must be above zero/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: M.MAX_PRICE + 1 });
  ck('Z5 an Online price above MAX_PRICE is refused', !!x.e && /Online price is too large/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: 0 });
  ck('Z6 Online price 0 is still refused (required, > 0)', !!x.e && /price above zero is required/.test(x.e.message), x.e && x.e.message);
  ck('Z7 every tier is checked against the same MAX_PRICE', /v > MAX_PRICE/.test(SRC) && /fields\.price > MAX_PRICE/.test(SRC));

  head('O - ordering: wholesale <= shop <= online, wholesale < online');
  x = await createErr({ name: 'S', price: 100, wholesalePrice: 100 });
  ck('O1 Wholesale EQUAL to Online is refused (strict)', !!x.e && /Wholesale price must be lower than the Online price/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, wholesalePrice: 150 });
  ck('O2 Wholesale above Online is refused', !!x.e && /Wholesale price must be lower than the Online price/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, shopPrice: 120 });
  ck('O3 Shelf above Online is refused', !!x.e && /Shelf price cannot be higher than the Online price/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, shopPrice: 80, wholesalePrice: 90 });
  ck('O4 Wholesale above Shelf is refused', !!x.e && /Wholesale price cannot be higher than the Shelf price/.test(x.e.message), x.e && x.e.message);
  ck('O5 ...every refusal writes nothing', x.db.log.length === 0 && x.db.mlog.length === 0);
  db = adapter();
  r = await create(db, { name: 'S', price: 100, shopPrice: 100, wholesalePrice: 100 - 0.5 });
  ck('O6 Shelf EQUAL to Online is accepted (<=) — saved on the till copy', !!r && db.mirrors[POS(r.id)].shopPrice === 100 && r.shelf.state === 'saved');
  db = adapter();
  r = await create(db, { name: 'S', price: 100, shopPrice: 90, wholesalePrice: 90 });
  ck('O7 Wholesale EQUAL to Shelf is accepted (<=), still below Online', !!r && r.product.wholesalePrice === 90 && db.mirrors[POS(r.id)].shopPrice === 90);
  db = adapter();
  r = await create(db, { name: 'S', price: '100', shopPrice: '95', wholesalePrice: '80' });
  ck('O8 a full valid ladder from form strings is stored as numbers', r.product.price === 100 && db.mirrors[POS(r.id)].shopPrice === 95 && r.product.wholesalePrice === 80,
     JSON.stringify([r.product.price, db.mirrors[POS(r.id)].shopPrice, r.product.wholesalePrice]));
  ck('O9 the old "normal price" wording is gone; the Online price is named', !/lower than the normal price/.test(SRC) && /lower than the Online price/.test(SRC));

  head('Q - minWholesaleQty is informational, no longer coupled');
  db = adapter();
  r = await create(db, { name: 'S', price: 100, wholesalePrice: 80 });
  ck('Q1 a Wholesale price WITHOUT a minimum quantity is accepted', !!r && r.product.wholesalePrice === 80 && !has(r.product, 'minWholesaleQty'));
  db = adapter();
  r = await create(db, { name: 'S', price: 100, minWholesaleQty: 12 });
  ck('Q2 a minimum quantity without a Wholesale price is accepted (kept as information)', !!r && r.product.minWholesaleQty === 12);
  ck('Q3 the both-or-neither message is gone from the writer', !/A bulk deal needs both a wholesale price and a minimum quantity/.test(SRC));
  x = await createErr({ name: 'S', price: 100, wholesalePrice: 80, minWholesaleQty: -3 });
  ck('Q4 a negative minimum quantity is still refused', !!x.e && /cannot be negative/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, wholesalePrice: 80, minWholesaleQty: 2.5 });
  ck('Q5 a non-integer minimum quantity is still refused', !!x.e && /whole number/.test(x.e.message), x.e && x.e.message);

  head('E - edit: clear deletes, untouched is preserved, ordering against the stored tiers');
  let ed = await edit({ shopPrice: 950, wholesalePrice: 800 }, { shopPrice: null });
  let uw = ed.db.log.find((l) => l.mode === 'update');
  let pm = ed.db.mlog.find((m) => m.path[0] === 'posProducts');
  ck('E1 clearing the Shelf tier (null) sends a field DELETE to posProducts/{id} (update, never create)',
     !!pm && pm.mode === 'update' && JSON.stringify(pm.deleteFields) === '["shopPrice"]', pm && JSON.stringify(pm));
  ck('E2 ...products/{id} is NOT written at all (nothing public changed; no shopPrice set or deleted there)', !uw, uw && JSON.stringify(uw));
  ck('E3 ...the till copy no longer has shopPrice', !has(ed.db.mirrors[POS('p1')], 'shopPrice'), JSON.stringify(ed.db.mirrors[POS('p1')]));
  ck('E4 ...the untouched Wholesale tier is preserved (product and till copy)', ed.db.store.p1.wholesalePrice === 800 && ed.db.mirrors[POS('p1')].wholesalePrice === 800);
  ck('E5 ...the result reports what was cleared, and that the Shelf change was saved',
     !!ed.res && JSON.stringify(ed.res.cleared) === '["shopPrice"]' && ed.res.shelf.state === 'saved' && ed.res.shelf.cleared === true);
  ed = await edit({ shopPrice: 950, wholesalePrice: 800 }, { wholesalePrice: '' });
  ck('E6 clearing with an empty string deletes too', !has(ed.db.store.p1, 'wholesalePrice') && ed.db.mirrors[POS('p1')].shopPrice === 950, JSON.stringify(ed.db.store.p1));
  ed = await edit({ shopPrice: 950, wholesalePrice: 800, minWholesaleQty: 10 }, { name: 'Soap bar' });
  uw = ed.db.log.find((l) => l.mode === 'update');
  ck('E7 an edit that does not mention a tier sends NO tier field and NO delete',
     !!uw && !has(uw.data, 'shopPrice') && !has(uw.data, 'wholesalePrice') && !has(uw.data, 'minWholesaleQty') && !has(uw, 'deleteFields'), uw && JSON.stringify(uw));
  ck('E8 ...and every stored tier is preserved', ed.db.mirrors[POS('p1')].shopPrice === 950 && ed.db.store.p1.wholesalePrice === 800 && ed.db.store.p1.minWholesaleQty === 10);
  ck('E9 ...and no mirror write happens (nothing tier-shaped changed)', ed.db.mlog.length === 0 && !has(ed.res, 'mirrors'));
  ed = await edit({ wholesalePrice: 800 }, { price: 700 });
  ck('E10 lowering Online below the STORED Wholesale is refused', !!ed.e && /Wholesale price must be lower than the Online price/.test(ed.e.message) && ed.db.log.length === 0, ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950 }, { price: 900 });
  ck('E11 lowering Online below the STORED Shelf is refused', !!ed.e && /Shelf price cannot be higher than the Online price/.test(ed.e.message), ed.e && ed.e.message);
  ed = await edit({ shopPrice: 900 }, { wholesalePrice: 950 });
  ck('E12 a Wholesale above the STORED Shelf is refused', !!ed.e && /Wholesale price cannot be higher than the Shelf price/.test(ed.e.message), ed.e && ed.e.message);
  ed = await edit({ shopPrice: 900 }, { shopPrice: null, wholesalePrice: 950 });
  ck('E13 ...but clearing the Shelf tier in the same edit makes that Wholesale valid', !ed.e && ed.db.store.p1.wholesalePrice === 950 && !has(ed.db.mirrors[POS('p1')], 'shopPrice'), ed.e && ed.e.message);
  ed = await edit({ wholesalePrice: 1500 }, { name: 'Legacy fix' });
  ck('E14 a legacy record already out of order does not block an unrelated edit', !ed.e && ed.db.store.p1.name === 'Legacy fix', ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950 }, { shopPrice: 0 });
  ck('E15 an edit setting a tier to 0 is refused (0 is not "remove")', !!ed.e && /Shelf price must be above zero/.test(ed.e.message) && ed.db.log.length === 0, ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950 }, { shopPrice: null }, { supportsFieldDelete: false });
  ck('E16 an adapter that cannot express a delete: the removal is REFUSED with zero writes',
     !!ed.e && ed.e.code === 'field-delete-unsupported' && ed.db.log.length === 0 && ed.db.mlog.length === 0 && ed.db.mirrors[POS('p1')].shopPrice === 950, ed.e && ed.e.code);
  ed = await edit({}, { price: null });
  ck('E17 the Online price cannot be cleared (refused, not deleted)', !!ed.e && /price above zero is required/.test(ed.e.message) && ed.db.log.length === 0, ed.e && ed.e.message);

  head('M - the till mirrors carry the tiers');
  db = adapter();
  r = await create(db, { name: 'S', price: 100, shopPrice: 95, wholesalePrice: 80 });
  ck('M1 posProducts carries shopPrice + wholesalePrice', db.mirrors[POS(r.id)].shopPrice === 95 && db.mirrors[POS(r.id)].wholesalePrice === 80, JSON.stringify(db.mirrors[POS(r.id)]));
  ck('M2 inventory_products carries wholesalePrice and NOT shopPrice (staff-readable: wider than posProducts)',
     !has(db.mirrors[INV(r.id)], 'shopPrice') && db.mirrors[INV(r.id)].wholesalePrice === 80, JSON.stringify(db.mirrors[INV(r.id)]));
  ck('M3 the Online price is still price / sellingPrice', db.mirrors[POS(r.id)].price === 100 && db.mirrors[INV(r.id)].sellingPrice === 100);
  db = adapter();
  r = await create(db, { name: 'S', price: 100, wholesalePrice: 80 });
  ck('M4 an absent Shop tier is OMITTED from both mirrors (not 0, not null)', !has(db.mirrors[POS(r.id)], 'shopPrice') && !has(db.mirrors[INV(r.id)], 'shopPrice'));
  const pj = M.productProjections({ id: 'q', name: 'n', price: 10, shopPrice: null, wholesalePrice: 0 }, SCOPE, 0);
  ck('M5 the pure projection omits null and 0 tiers', !has(pj.pos.data, 'shopPrice') && !has(pj.pos.data, 'wholesalePrice') && !has(pj.inventory.data, 'wholesalePrice'));
  ed = await edit({}, { shopPrice: 900 });
  ck('M6 an edit SETTING the Shelf tier updates posProducts ONLY (never inventory_products)',
     ed.db.mirrors[POS('p1')].shopPrice === 900 && !has(ed.db.mirrors[INV('p1')], 'shopPrice') && ed.res.complete === true && ed.res.shelf.state === 'saved',
     JSON.stringify(ed.res && ed.res.mirrors));
  ck('M7 ...as an UPDATE carrying only the tier field', ed.db.mlog.length === 1 && ed.db.mlog.every((m) => m.mode === 'update' && m.path[0] === 'posProducts' && JSON.stringify(Object.keys(m.data)) === '["shopPrice"]'),
     JSON.stringify(ed.db.mlog));
  ed = await edit({}, { wholesalePrice: 700 });
  ck('M7b an edit SETTING Wholesale updates both mirrors', ed.db.mirrors[POS('p1')].wholesalePrice === 700 && ed.db.mirrors[INV('p1')].wholesalePrice === 700 && ed.res.complete === true,
     JSON.stringify(ed.res && ed.res.mirrors));
  ed = await edit({ shopPrice: 950, wholesalePrice: 800 }, { wholesalePrice: null });
  ck('M8 an edit CLEARING a tier deletes it from both mirrors', !has(ed.db.mirrors[POS('p1')], 'wholesalePrice') && !has(ed.db.mirrors[INV('p1')], 'wholesalePrice')
     && ed.db.mirrors[POS('p1')].shopPrice === 950, JSON.stringify(ed.db.mirrors[POS('p1')]));
  ck('M9 ...through deleteFields', ed.db.mlog.every((m) => JSON.stringify(m.deleteFields) === '["wholesalePrice"]'));
  const s2 = stored({});
  db = adapter(s2.seed, { mirrors: {} });
  const r2 = await M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { shopPrice: 900 } });
  ck('M10 a MISSING till copy is not created half-filled: the Shelf price is reported NOT saved, nothing claims success',
     r2.complete === false && r2.mirrors.pos.state === 'failed' && Object.keys(db.mirrors).length === 0
     && r2.shelf && r2.shelf.state === 'not-saved' && !has(db.store.p1, 'shopPrice') && db.log.length === 0, JSON.stringify(r2));
  ed = await edit({}, { price: 1200 });
  ck('M11 an Online-only edit writes no mirror (unchanged behaviour, stated in CHANGELOG)', ed.db.mlog.length === 0);
  const s12 = stored({ shopPrice: 950, wholesalePrice: 800 });
  db = adapter(s12.seed, { mirrors: s12.mirrors });
  await M.archiveProduct({ scope: SCOPE, db, id: 'p1' });
  ck('M12 archive re-projects onto the till copy and KEEPS its Shelf price (merge; never sourced from products)',
     db.mirrors[POS('p1')].shopPrice === 950 && db.mirrors[POS('p1')].wholesalePrice === 800 && db.mirrors[POS('p1')].status === 'archived'
     && !has(db.mirrors[INV('p1')], 'shopPrice'));

  head('D - the merchant-v2 adapter expresses the delete');
  ck('D1 writeProduct maps deleteFields to deleteField()', /o\.deleteFields\.forEach\(function \(k\) \{ data\[k\] = m\.fs\.deleteField\(\); \}\)/.test(HSRC));
  ck('D2 ...refuses an authority field in deleteFields', /_refuseAuthorityFields\(delObj, 'writeProduct \(delete\)'\)/.test(HSRC));
  ck('D3 writeMirror mode update uses updateDoc (never creates a mirror)', /if \(o\.mode === 'update'\)[\s\S]{0,300}m\.fs\.updateDoc\(ref, data\)/.test(HSRC));
  ck('D4 the adapter declares supportsFieldDelete', /supportsFieldDelete: true/.test(HSRC));

  head('U - the form: three labelled tier inputs (static)');
  const tier = (key, chip, label) => {
    const re = new RegExp("tierFld\\('" + key + "', '" + chip + "', '" + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'");
    return re.test(PSRC);
  };
  ck('U1 Online — marketplace price, chip ONL, required', tier('price', 'ONL', 'Online — marketplace price (KES)') && /'Online — marketplace price \(KES\)',\s*'type="number" inputmode="decimal" min="1" step="any" required'/.test(PSRC));
  ck('U2 Shelf — the price on the shelf, chip SHELF, optional (field stays shopPrice)', tier('shopPrice', 'SHELF', 'Shelf — the price on the shelf in your shop (KES)'));
  ck('U3 Wholesale — bulk price, chip WHOLE, optional', tier('wholesalePrice', 'WHOLE', 'Wholesale — bulk price (KES)'));
  ck('U4 helper text "Leave empty if not sold at this price" (Shelf: via shelfNote, which falls back to it)',
     /var TIER_HELP = 'Leave empty if not sold at this price';/.test(PSRC)
     && (PSRC.match(/p\.wholesalePrice, TIER_HELP\)/g) || []).length === 1 && /p\.shopPrice, shelfNote\(\)\)/.test(PSRC)
     && /function shelfNote \(\) \{[\s\S]{0,400}return TIER_HELP;/.test(PSRC));
  ck('U5 each input has a <label for> (the accessible name) and the chip is aria-hidden',
     /<label class="pr-l" for="pf-' \+ key \+ '">' \+\s*'<span class="pr-tier-chip pr-tier-chip--' \+ key \+ '" aria-hidden="true">'/.test(PSRC));
  ck('U6 inputs keep the form class (46px, >= 44px target)', /'<input class="pr-i" id="pf-' \+ key \+ '" data-pf="' \+ key \+ '" '/.test(PSRC) && /\.pr-i\{[^']*min-height:46px/.test(PSRC));
  ck('U7 the three tiers render in ONE pricing group', /function pricingHTML[\s\S]{0,2600}tierFld\('price'[\s\S]{0,400}tierFld\('shopPrice'[\s\S]{0,400}tierFld\('wholesalePrice'/.test(PSRC)
     && /pricingHTML\(p\) \+/.test(PSRC));
  ck('U8 shopPrice is a captured, numeric form key', /'shopPrice', 'wholesalePrice', 'minWholesaleQty',/.test(PSRC) && /shopPrice: 1, wholesalePrice: 1/.test(PSRC));
  ck('U9 empty numeric is ABSENT on save (never 0)', /if \(raw === '' \|\| raw === null\) return;\s*out\[k\] = Number\(raw\);/.test(PSRC));
  ck('U10 edit: only a tier the product HAD and the merchant emptied is sent as null',
     /var had = E\.product && typeof E\.product\[k\] === 'number';\s*if \(had && E\.values && E\.values\[k\] === ''\) patch\[k\] = null;/.test(PSRC));
  ck('U11 the old Bulk-deal section is gone (no second wholesale input)', !/function bulkHTML/.test(PSRC) && (PSRC.match(/'wholesalePrice', 'WHOLE'/g) || []).length === 1);
  ck('U12 the bulk read-out keeps its .pr-bulk-strip / "not a discount" contract', /pr-bulk-strip/.test(PSRC) && /That is not a discount/.test(PSRC));

  head('P - the Shelf price is OWNER-PRIVATE: posProducts only, never the public products/{id}');
  db = adapter();
  r = await create(db, { name: 'S', price: 100, shopPrice: 95, wholesalePrice: 80 });
  ck('P1 create: the products/{id} write does NOT contain shopPrice', noShelfOnProducts(db) && prodWrites(db).length === 1 && !has(db.store[r.id], 'shopPrice'),
     JSON.stringify(prodWrites(db).map((l) => Object.keys(l.data))));
  ck('P2 ...the returned public document carries none either', !has(r.product, 'shopPrice'));
  ck('P3 ...posProducts/{id} carries it, with sellerId = the owner (the served rule\'s read key)',
     db.mirrors[POS(r.id)].shopPrice === 95 && db.mirrors[POS(r.id)].sellerId === 'uid_A' && r.shelf.state === 'saved');
  ck('P4 ...inventory_products does NOT', !has(db.mirrors[INV(r.id)], 'shopPrice'));
  db = adapter();
  db.writeMirror = async (req) => { db.mlog.push(req); if (req.path[0] === 'posProducts') throw new Error('permission-denied'); db.mirrors[req.path.join('/')] = req.data; };
  r = await create(db, { name: 'S', price: 100, shopPrice: 95 });
  ck('P5 create whose till copy fails: the Shelf price is reported NOT saved (no other home), never on products',
     r.shelf && r.shelf.state === 'not-saved' && noShelfOnProducts(db) && r.complete === false, JSON.stringify(r.shelf));
  ed = await edit({ shopPrice: 950, wholesalePrice: 800 }, { shopPrice: 900, name: 'Soap 2', wholesalePrice: 700 });
  ck('P6 edit setting Shelf + others: the products write carries name/wholesale and NO shopPrice',
     !ed.e && noShelfOnProducts(ed.db) && prodWrites(ed.db).length === 1 && ed.db.store.p1.name === 'Soap 2' && !has(ed.db.store.p1, 'shopPrice')
     && ed.db.mirrors[POS('p1')].shopPrice === 900, ed.e ? ed.e.message : JSON.stringify(prodWrites(ed.db)));
  ed = await edit({ shopPrice: 950 }, { name: 'Fix' }, { leak: 950 });
  uw = ed.db.log.find((l) => l.mode === 'update');
  ck('P7 a LEAKED products.shopPrice is deleted by an unrelated edit, in the same write',
     !!uw && JSON.stringify(uw.deleteFields) === '["shopPrice"]' && !has(uw.data, 'shopPrice') && !has(ed.db.store.p1, 'shopPrice') && ed.res.leakedShelfRemoved === true,
     uw && JSON.stringify(uw));
  ck('P8 ...and the till copy keeps the owner\'s Shelf price', ed.db.mirrors[POS('p1')].shopPrice === 950 && ed.db.log.length === 1);
  ed = await edit({ shopPrice: 950 }, { shopPrice: 940 }, { leak: 950 });
  uw = ed.db.log.find((l) => l.mode === 'update');
  ck('P9 a Shelf-only edit on a leaked record: products gets ONLY the delete, the till copy the new price',
     !!uw && JSON.stringify(uw.data) === '{}' && JSON.stringify(uw.deleteFields) === '["shopPrice"]' && ed.db.mirrors[POS('p1')].shopPrice === 940, uw && JSON.stringify(uw));
  ed = await edit({ shopPrice: 950 }, { name: 'Fix' }, { leak: 950, supportsFieldDelete: false });
  ck('P10 ...an adapter that cannot delete: the edit stands and says the leak was NOT removed', !ed.e && ed.res.leakedShelfRemoved === false && noShelfOnProducts(ed.db));
  ed = await edit({ shopPrice: 950 }, { price: 900 }, { leak: 10 });
  ck('P11 ordering uses the posProducts Shelf (950), not a leaked products.shopPrice (10): Online 900 refused',
     !!ed.e && /Shelf price cannot be higher than the Online price/.test(ed.e.message) && ed.db.log.length === 0, ed.e && ed.e.message);
  ed = await edit({ shopPrice: 500 }, { price: 900 }, { leak: 5000 });
  ck('P12 ...and a leaked figure cannot block a valid edit (posProducts 500 <= 900)', !ed.e && ed.db.store.p1.price === 900 && !has(ed.db.store.p1, 'shopPrice'), ed.e && ed.e.message);
  ck('P13 ...the stored Shelf was read from posProducts exactly once', JSON.stringify(ed.db.posReads) === '["p1"]', JSON.stringify(ed.db.posReads));
  ed = await edit({ shopPrice: 950 }, { price: 1200 }, { posReadable: false });
  ck('P14 posProducts UNREADABLE + an Online edit: REFUSED with zero writes',
     !!ed.e && ed.e.code === 'shelf-unreadable' && /Shelf price could not be read/.test(ed.e.message) && ed.db.log.length === 0 && ed.db.mlog.length === 0, ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950 }, { wholesalePrice: 100 }, { posReadable: false });
  ck('P15 ...a Wholesale edit too', !!ed.e && ed.e.code === 'shelf-unreadable' && ed.db.log.length === 0 && ed.db.mlog.length === 0, ed.e && ed.e.code);
  const s16 = stored({ shopPrice: 950 });
  delete s16.mirrors[POS('p1')];
  db = adapter(s16.seed, { mirrors: s16.mirrors });
  x = { e: await refusal(() => M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { price: 1200 } })) };
  ck('P16 posProducts MISSING + an Online edit: refused (unknown Shelf), zero writes', !!x.e && x.e.code === 'shelf-unreadable' && db.log.length === 0, x.e && x.e.code);
  ed = await edit({ shopPrice: 950 }, { price: 1200 }, { noPosReader: true });
  ck('P17 an adapter with no posProducts reader: refused, never validated against an unknown', !!ed.e && ed.e.code === 'shelf-unreadable' && ed.db.log.length === 0);
  ed = await edit({ shopPrice: 950 }, { name: 'Renamed' }, { posReadable: false });
  ck('P18 posProducts UNREADABLE + an unrelated edit (name): ALLOWED, no Shelf read', !ed.e && ed.db.store.p1.name === 'Renamed' && ed.db.posReads.length === 0, ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950, wholesalePrice: 800 }, { shopPrice: null });
  ck('P19 a cleared Shelf deletes posProducts.shopPrice ONLY: no products write, no inventory write',
     ed.db.log.length === 0 && ed.db.mlog.length === 1 && ed.db.mlog[0].path[0] === 'posProducts' && JSON.stringify(ed.db.mlog[0].deleteFields) === '["shopPrice"]'
     && JSON.stringify(ed.db.mlog[0].data) === '{}' && ed.db.mirrors[INV('p1')].wholesalePrice === 800, JSON.stringify(ed.db.mlog));
  const pj2 = M.productProjections({ id: 'q', name: 'n', price: 10, shopPrice: 9, wholesalePrice: 8 }, SCOPE, 0);
  ck('P20 the projection NEVER sources a Shelf price from the products doc (a leak is not a source)',
     !has(pj2.pos.data, 'shopPrice') && !has(pj2.inventory.data, 'shopPrice') && pj2.pos.data.wholesalePrice === 8);
  const pj3 = M.productProjections({ id: 'q', name: 'n', price: 10 }, SCOPE, 0, { shopPrice: 9 });
  ck('P21 ...only from the private input, onto posProducts only', pj3.pos.data.shopPrice === 9 && !has(pj3.inventory.data, 'shopPrice'));

  head('L - the edit form loads the Shelf price: one posProducts read per opened product');
  const sL = stored({ shopPrice: 950 });
  db = adapter(sL.seed, { mirrors: sL.mirrors });
  let ld = await M.loadShelfPrice({ scope: SCOPE, db, id: 'p1' });
  ck('L1 loadShelfPrice returns the stored Shelf from posProducts', ld.state === 'observed' && ld.shopPrice === 950 && JSON.stringify(db.posReads) === '["p1"]', JSON.stringify(ld));
  await M.listProducts({ scope: SCOPE, db });
  ck('L2 listing the catalogue makes NO posProducts read (never per list row)', db.posReads.length === 1);
  db = adapter(stored({}).seed, { mirrors: stored({}).mirrors });
  ld = await M.loadShelfPrice({ scope: SCOPE, db, id: 'p1' });
  ck('L3 a till copy without a Shelf price: observed, null (not 0)', ld.state === 'observed' && ld.shopPrice === null, JSON.stringify(ld));
  db = adapter(stored({}).seed, { mirrors: {} });
  ld = await M.loadShelfPrice({ scope: SCOPE, db, id: 'p1' });
  ck('L4 a missing till copy: state missing (never "no Shelf price")', ld.state === 'missing', JSON.stringify(ld));
  db = adapter(stored({}).seed, { mirrors: stored({ shopPrice: 1 }).mirrors, posReadable: false });
  ld = await M.loadShelfPrice({ scope: SCOPE, db, id: 'p1' });
  ck('L5 a denied read: state unreadable', ld.state === 'unreadable' && /permission/.test(ld.reason), JSON.stringify(ld));
  const fm = {}; fm[POS('p1')] = { sellerId: 'uid_OTHER', shopPrice: 5 };
  db = adapter(stored({}).seed, { mirrors: fm });
  ld = await M.loadShelfPrice({ scope: SCOPE, db, id: 'p1' });
  ck('L6 a till copy naming another seller is not this owner\'s figure: unreadable', ld.state === 'unreadable' && !has(ld, 'shopPrice'), JSON.stringify(ld));
  const body = (name) => { const i = PSRC.indexOf('function ' + name + ' ('); const j = PSRC.indexOf('\n    function ', i + 10); return i < 0 ? '' : PSRC.slice(i, j); };
  ck('L7 openEditor loads the Shelf price ONLY for an edit, once (loadShelf -> M.loadShelfPrice, one call site)',
     /if \(mode === 'edit' && product && product\.id\) loadShelf\(S\.editor\);/.test(body('openEditor'))
     && (PSRC.match(/loadShelfPrice\(/g) || []).length === 1 && (PSRC.match(/loadShelf\(S\.editor\)/g) || []).length === 1);
  ck('L8 the stored product enters the edit with NO shopPrice until the read succeeds (an empty box is never a clear)',
     /delete S\.editor\.product\.shopPrice;/.test(body('openEditor')) && /E\.product\.shopPrice = r\.shopPrice;/.test(body('loadShelf')));
  ck('L9 an unreadable Shelf shows "Shelf price not loaded"', /Shelf price not loaded/.test(body('shelfNote')) && /state: 'unreadable'/.test(body('loadShelf')));
  ck('L10 a typed Shelf value is never overwritten by a late read', /if \(E\.values\.shopPrice === undefined \|\| E\.values\.shopPrice === ''\) E\.values\.shopPrice = r\.shopPrice;/.test(body('loadShelf'))
     && /S\.editor !== E/.test(body('loadShelf')));
  ck('L11 the edit result says when the Shelf price was NOT saved', /Shelf price was NOT saved/.test(body('editText')) && /Shelf price was NOT saved/.test(PSRC.slice(PSRC.indexOf('SHELF_NOT_SAVED'))));
  ck('L12 card / detail / live-listing surfaces never render shopPrice',
     ['card', 'detailHTML', 'liveListing', 'specRows'].every((n) => body(n).length > 0 && !/shopPrice/.test(body(n))));
  ck('L13 the adapter reads posProducts/{id} for the Shelf price (getPosProduct)',
     /getPosProduct: function \(id\) \{[\s\S]{0,300}m\.fs\.doc\(window\.firebaseDB, 'posProducts', id\)/.test(HSRC));

  console.log('\n' + '='.repeat(76));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((x) => { console.error('suite crashed:', x); process.exit(2); });
