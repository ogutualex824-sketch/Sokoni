/* ══════════════════════════════════════════════════════════════════════════════
   PRICE TIERS — WRITER + FORM (2026-10-01)
   ══════════════════════════════════════════════════════════════════════════════
   Owner model: three independent prices on one product, no new pricing object.
     ONLINE    = price           (required; marketplace, cart, checkout read it)
     SHOP      = shopPrice       (new, optional; the in-store price)
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
  return db;
}
const allow = async () => ({ data: { allowed: true } });
const POS = (id) => 'posProducts/' + id;
const INV = (id) => 'tenants/uid_A/inventory_products/' + id;

async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
let tok = 0;
const create = (db, product) => M.createProduct({ scope: SCOPE, db, draftToken: 't' + (++tok), canPublish: allow, product });
const createErr = async (product) => { const db = adapter(); const e = await refusal(() => create(db, product)); return { e, db }; };

function stored(extra) {
  const base = { shopId: 'shop_A', sellerUid: 'uid_A', name: 'Soap', price: 1000, status: 'active' };
  const p1 = Object.assign(base, extra || {});
  const mir = {};
  const tiers = {};
  ['shopPrice', 'wholesalePrice'].forEach((k) => { if (typeof p1[k] === 'number') tiers[k] = p1[k]; });
  mir[POS('p1')] = Object.assign({ name: 'Soap', price: 1000, sellerId: 'uid_A' }, tiers);
  mir[INV('p1')] = Object.assign({ name: 'Soap', sellingPrice: 1000, tenantId: 'uid_A' }, tiers);
  return { seed: { p1 }, mirrors: mir };
}
const edit = async (extra, patch, opts) => {
  const s = stored(extra);
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
  /* Owner, 2026-10-01: the SHELF price is PRIVATE ("make it truly private"). products/{id} is public, so the row
     mapping never reads it; withShelf() fills it from the merchant-only posProducts record. */
  ck('F2 mapProducts NEVER reads shopPrice from the public doc (the private record is the source)',
     /shopPrice: null,/.test(SRC) && !/shopPrice: \(typeof p\.shopPrice === 'number'\) \? p\.shopPrice : null/.test(SRC));
  const listed = await M.listProducts({ scope: SCOPE, db: adapter({ a: { shopId: 'shop_A', sellerUid: 'uid_A', name: 'x', price: 9, shopPrice: 8 },
                                                                     b: { shopId: 'shop_A', sellerUid: 'uid_A', name: 'y', price: 9 } }) });
  const rowA = (listed.rows || listed).find ? (listed.rows || listed).find((r) => r.id === 'a') : null;
  const rowB = (listed.rows || listed).find ? (listed.rows || listed).find((r) => r.id === 'b') : null;
  const merged = (typeof M.withShelf === 'function') ? M.withShelf(listed.rows || listed, { readable: true, map: { a: 8 } }) : [];
  const mA = merged.find ? merged.find((r) => r.id === 'a') : null;
  ck('F3 a public shopPrice is NOT carried; the PRIVATE shelf price is (withShelf)', !!rowA && rowA.shopPrice === null && !!mA && mA.shopPrice === 8,
     JSON.stringify({ public: rowA && rowA.shopPrice, private: mA && mA.shopPrice }));
  ck('F4 ...and an absent one as null (not 0)', !!rowB && rowB.shopPrice === null, rowB && JSON.stringify(rowB.shopPrice));
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
  ck('Z1 Shop price 0 is refused, naming the tier', !!x.e && /Shop price must be above zero/.test(x.e.message) && x.db.log.length === 0, x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, wholesalePrice: 0 });
  ck('Z2 Wholesale price 0 is refused, naming the tier', !!x.e && /Wholesale price must be above zero/.test(x.e.message) && x.db.log.length === 0, x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, shopPrice: -5 });
  ck('Z3 a negative Shop price is refused', !!x.e && /Shop price must be above zero/.test(x.e.message), x.e && x.e.message);
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
  ck('O3 Shop above Online is refused', !!x.e && /Shop price cannot be higher than the Online price/.test(x.e.message), x.e && x.e.message);
  x = await createErr({ name: 'S', price: 100, shopPrice: 80, wholesalePrice: 90 });
  ck('O4 Wholesale above Shop is refused', !!x.e && /Wholesale price cannot be higher than the Shop price/.test(x.e.message), x.e && x.e.message);
  ck('O5 ...every refusal writes nothing', x.db.log.length === 0 && x.db.mlog.length === 0);
  db = adapter();
  r = await create(db, { name: 'S', price: 100, shopPrice: 100, wholesalePrice: 100 - 0.5 });
  ck('O6 Shop EQUAL to Online is accepted (<=)', !!r && r.product.shopPrice === 100);
  db = adapter();
  r = await create(db, { name: 'S', price: 100, shopPrice: 90, wholesalePrice: 90 });
  ck('O7 Wholesale EQUAL to Shop is accepted (<=), still below Online', !!r && r.product.wholesalePrice === 90 && r.product.shopPrice === 90);
  db = adapter();
  r = await create(db, { name: 'S', price: '100', shopPrice: '95', wholesalePrice: '80' });
  ck('O8 a full valid ladder from form strings is stored as numbers', r.product.price === 100 && r.product.shopPrice === 95 && r.product.wholesalePrice === 80,
     JSON.stringify([r.product.price, r.product.shopPrice, r.product.wholesalePrice]));
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
  ck('E1 clearing the Shop tier (null) sends a field DELETE', !!uw && JSON.stringify(uw.deleteFields) === '["shopPrice"]', uw && JSON.stringify(uw));
  ck('E2 ...the update data carries no shopPrice (never 0, never null)', !!uw && !has(uw.data, 'shopPrice'));
  ck('E3 ...the stored product no longer has shopPrice', !has(ed.db.store.p1, 'shopPrice'), JSON.stringify(ed.db.store.p1));
  ck('E4 ...the untouched Wholesale tier is preserved', ed.db.store.p1.wholesalePrice === 800);
  ck('E5 ...the result reports what was cleared', !!ed.res && JSON.stringify(ed.res.cleared) === '["shopPrice"]');
  ed = await edit({ shopPrice: 950, wholesalePrice: 800 }, { wholesalePrice: '' });
  ck('E6 clearing with an empty string deletes too', !has(ed.db.store.p1, 'wholesalePrice') && ed.db.store.p1.shopPrice === 950, JSON.stringify(ed.db.store.p1));
  ed = await edit({ shopPrice: 950, wholesalePrice: 800, minWholesaleQty: 10 }, { name: 'Soap bar' });
  uw = ed.db.log.find((l) => l.mode === 'update');
  ck('E7 an edit that does not mention a tier sends NO tier field and NO delete',
     !!uw && !has(uw.data, 'shopPrice') && !has(uw.data, 'wholesalePrice') && !has(uw.data, 'minWholesaleQty') && !has(uw, 'deleteFields'), uw && JSON.stringify(uw));
  ck('E8 ...and every stored tier is preserved', ed.db.store.p1.shopPrice === 950 && ed.db.store.p1.wholesalePrice === 800 && ed.db.store.p1.minWholesaleQty === 10);
  ck('E9 ...and no mirror write happens (nothing tier-shaped changed)', ed.db.mlog.length === 0 && !has(ed.res, 'mirrors'));
  ed = await edit({ wholesalePrice: 800 }, { price: 700 });
  ck('E10 lowering Online below the STORED Wholesale is refused', !!ed.e && /Wholesale price must be lower than the Online price/.test(ed.e.message) && ed.db.log.length === 0, ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950 }, { price: 900 });
  ck('E11 lowering Online below the STORED Shop is refused', !!ed.e && /Shop price cannot be higher than the Online price/.test(ed.e.message), ed.e && ed.e.message);
  ed = await edit({ shopPrice: 900 }, { wholesalePrice: 950 });
  ck('E12 a Wholesale above the STORED Shop is refused', !!ed.e && /Wholesale price cannot be higher than the Shop price/.test(ed.e.message), ed.e && ed.e.message);
  ed = await edit({ shopPrice: 900 }, { shopPrice: null, wholesalePrice: 950 });
  ck('E13 ...but clearing the Shop tier in the same edit makes that Wholesale valid', !ed.e && ed.db.store.p1.wholesalePrice === 950 && !has(ed.db.store.p1, 'shopPrice'), ed.e && ed.e.message);
  ed = await edit({ wholesalePrice: 1500 }, { name: 'Legacy fix' });
  ck('E14 a legacy record already out of order does not block an unrelated edit', !ed.e && ed.db.store.p1.name === 'Legacy fix', ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950 }, { shopPrice: 0 });
  ck('E15 an edit setting a tier to 0 is refused (0 is not "remove")', !!ed.e && /Shop price must be above zero/.test(ed.e.message) && ed.db.log.length === 0, ed.e && ed.e.message);
  ed = await edit({ shopPrice: 950 }, { shopPrice: null }, { supportsFieldDelete: false });
  ck('E16 an adapter that cannot express a delete: the removal is REFUSED with zero writes',
     !!ed.e && ed.e.code === 'field-delete-unsupported' && ed.db.log.length === 0 && ed.db.store.p1.shopPrice === 950, ed.e && ed.e.code);
  ed = await edit({}, { price: null });
  ck('E17 the Online price cannot be cleared (refused, not deleted)', !!ed.e && /price above zero is required/.test(ed.e.message) && ed.db.log.length === 0, ed.e && ed.e.message);

  head('M - the till mirrors carry the tiers');
  db = adapter();
  r = await create(db, { name: 'S', price: 100, shopPrice: 95, wholesalePrice: 80 });
  ck('M1 posProducts carries shopPrice + wholesalePrice', db.mirrors[POS(r.id)].shopPrice === 95 && db.mirrors[POS(r.id)].wholesalePrice === 80, JSON.stringify(db.mirrors[POS(r.id)]));
  ck('M2 inventory_products carries shopPrice + wholesalePrice', db.mirrors[INV(r.id)].shopPrice === 95 && db.mirrors[INV(r.id)].wholesalePrice === 80, JSON.stringify(db.mirrors[INV(r.id)]));
  ck('M3 the Online price is still price / sellingPrice', db.mirrors[POS(r.id)].price === 100 && db.mirrors[INV(r.id)].sellingPrice === 100);
  db = adapter();
  r = await create(db, { name: 'S', price: 100, wholesalePrice: 80 });
  ck('M4 an absent Shop tier is OMITTED from both mirrors (not 0, not null)', !has(db.mirrors[POS(r.id)], 'shopPrice') && !has(db.mirrors[INV(r.id)], 'shopPrice'));
  const pj = M.productProjections({ id: 'q', name: 'n', price: 10, shopPrice: null, wholesalePrice: 0 }, SCOPE, 0);
  ck('M5 the pure projection omits null and 0 tiers', !has(pj.pos.data, 'shopPrice') && !has(pj.pos.data, 'wholesalePrice') && !has(pj.inventory.data, 'wholesalePrice'));
  ed = await edit({}, { shopPrice: 900 });
  ck('M6 an edit SETTING a tier updates both mirrors', ed.db.mirrors[POS('p1')].shopPrice === 900 && ed.db.mirrors[INV('p1')].shopPrice === 900 && ed.res.complete === true,
     JSON.stringify(ed.res && ed.res.mirrors));
  ck('M7 ...as an UPDATE carrying only the tier fields', ed.db.mlog.length === 2 && ed.db.mlog.every((m) => m.mode === 'update' && JSON.stringify(Object.keys(m.data)) === '["shopPrice"]'),
     JSON.stringify(ed.db.mlog));
  ed = await edit({ shopPrice: 950, wholesalePrice: 800 }, { wholesalePrice: null });
  ck('M8 an edit CLEARING a tier deletes it from both mirrors', !has(ed.db.mirrors[POS('p1')], 'wholesalePrice') && !has(ed.db.mirrors[INV('p1')], 'wholesalePrice')
     && ed.db.mirrors[POS('p1')].shopPrice === 950, JSON.stringify(ed.db.mirrors[POS('p1')]));
  ck('M9 ...through deleteFields', ed.db.mlog.every((m) => JSON.stringify(m.deleteFields) === '["wholesalePrice"]'));
  const s2 = stored({});
  db = adapter(s2.seed, { mirrors: {} });
  const r2 = await M.updateProduct({ scope: SCOPE, db, id: 'p1', patch: { shopPrice: 900 } });
  ck('M10 a MISSING mirror is not created half-filled: reported failed, product write stands',
     r2.complete === false && r2.mirrors.pos.state === 'failed' && Object.keys(db.mirrors).length === 0 && db.store.p1.shopPrice === 900, JSON.stringify(r2.mirrors));
  ed = await edit({}, { price: 1200 });
  ck('M11 an Online-only edit writes no mirror (unchanged behaviour, stated in CHANGELOG)', ed.db.mlog.length === 0);
  db = adapter(stored({ shopPrice: 950, wholesalePrice: 800 }).seed);
  await M.archiveProduct({ scope: SCOPE, db, id: 'p1' });
  ck('M12 archive re-projects the stored tiers onto the till copy', db.mirrors[POS('p1')].shopPrice === 950 && db.mirrors[POS('p1')].wholesalePrice === 800);

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
  ck('U2 Shop — in-store price, chip SHOP, optional', tier('shopPrice', 'SHOP', 'Shop — in-store price (KES)'));
  ck('U3 Wholesale — bulk price, chip WHOLE, optional', tier('wholesalePrice', 'WHOLE', 'Wholesale — bulk price (KES)'));
  ck('U4 helper text "Leave empty if not sold at this price"', /var TIER_HELP = 'Leave empty if not sold at this price';/.test(PSRC)
     && (PSRC.match(/p\.(shopPrice|wholesalePrice), TIER_HELP\)/g) || []).length === 2);
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

  console.log('\n' + '='.repeat(76));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((x) => { console.error('suite crashed:', x); process.exit(2); });
