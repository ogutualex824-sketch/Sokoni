/* test-catalogue-u7b-barcode.js — universal catalogue U7b (2026-09-29): ONE canonical barcode, scanners that work,
 * and lookups that can only ever find the caller's OWN product.
 *
 * Census (U7):
 *   · merchant-v2 saved the barcode ONLY in specs.barcode; the till mirror, search indexers and every lookup read the
 *     top-level `barcode` — a code typed in merchant-v2 was not scannable at the till.
 *   · both merchant-v2 scan buttons called SokoniBarcode.scanOnce, which did not exist, and the module was not loaded.
 *   · sokoni-barcode.js lookupProduct, sokoni-inventory getProductByBarcode (no seller) and warehouse-scanner looked the
 *     code up across EVERY merchant's catalogue.
 *
 * REAL sokoni-merchant-data.js (writer + list reader + findByCode) and sokoni-barcode.js (in a vm window), plus the
 * shipped wiring in merchant-v2.html, pos.js, the indexers and the two legacy lookups.
 *
 * PROVES
 *   BC1 the writer derives the canonical top-level barcode from the Studio's specs.barcode; an explicit barcode wins;
 *       blank → null; a code a scanner cannot produce is refused (BARCODE_INVALID)
 *   BC2 per-shop uniqueness: a code another of MY products holds is refused (BARCODE_TAKEN) on create and on update;
 *       re-saving the SAME product keeps its code; ANOTHER shop's identical code is never looked at (no conflict, no
 *       adoption)
 *   BC3 the list reader carries the barcode (legacy specs-only records too) and findByCode resolves barcode, SKU or
 *       legacy code — never guessing between two
 *   BC4 sokoni-barcode: scanOnce exists and resolves the scanned value (or null on close); a lookup without a shopId
 *       answers null WITHOUT querying; the query is shop-scoped
 *   BC5 merchant-v2 loads the scanner before the Products module, Sell's openScanner uses scanOnce, and the adapter's
 *       findByBarcode is shop-scoped
 *   BC6 the bridge and the legacy lookups: the till mirror and the indexers read specs.barcode for legacy records;
 *       sokoni-inventory and warehouse-scanner query only the signed-in seller's products
 *
 *   node scripts/test-catalogue-u7b-barcode.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let MD; try { MD = require(path.join(ROOT, 'sokoni-merchant-data.js')); } catch (e) { MD = {}; }
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };

const SCOPE = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
function makeDb(products) {
  const P = products;
  return {
    P,
    queryProducts: async (spec) => Object.values(P).filter((p) => (spec.where || []).every((w) => p[w[0]] === w[2])).map((p) => Object.assign({}, p)),
    getProduct: async (id) => (P[id] ? Object.assign({}, P[id]) : null),
    writeProduct: async (o) => { P[o.id] = Object.assign({}, P[o.id] || {}, o.data); return { replayed: false }; },
    writeMirror: async () => {},
    /* the adapter contract merchant-v2 implements: THIS shop's ids carrying the code (canonical or legacy spec) */
    findByBarcode: async (scope, code) => Object.values(P).filter((p) => p.shopId === scope.shopId && p.status !== 'archived'
      && (p.barcode === code || (p.specs && p.specs.barcode === code))).map((p) => p.id),
  };
}
const base = () => ({
  a1: { id: 'a1', name: 'Soda 500ml', price: 80, shopId: 'shopA', sellerUid: 'shopA', status: 'active', barcode: '6161101234567' },
  a2: { id: 'a2', name: 'Old Juice', price: 90, shopId: 'shopA', sellerUid: 'shopA', status: 'active', specs: { barcode: '5000112233445' } },
  b1: { id: 'b1', name: 'Their Soda', price: 70, shopId: 'shopB', sellerUid: 'shopB', status: 'active', barcode: '7777777777777' },
});
const create = (db, product, tok) => MD.createProduct({ scope: SCOPE, db, product, draftToken: tok, canPublish: async () => ({ data: { allowed: true } }) });

(async () => {
  /* BC1 */
  let f1, f2, f3, bad;
  try {
    f1 = MD._productFields ? null : null;
    const d1 = makeDb(base());
    const r1 = await create(d1, { name: 'Maziwa', price: 60, specs: { barcode: ' 6001234000001 ' } }, 't1');
    const r2 = await create(d1, { name: 'Mkate', price: 55, barcode: '6001234000002', specs: { barcode: 'ignored-spec' } }, 't2');
    const r3 = await create(d1, { name: 'Sukari', price: 150, specs: { barcode: '' } }, 't3');
    f1 = d1.P[r1.id].barcode; f2 = d1.P[r2.id].barcode; f3 = d1.P[r3.id].barcode;
    bad = await codeOf(create(d1, { name: 'X', price: 1, barcode: '<img onerror=1>' }, 't4'));
  } catch (e) { f1 = 'CRASH ' + e.message; }
  ck('BC1 the writer derives top-level barcode from specs.barcode; explicit wins; blank → null; unscannable refused',
    f1 === '6001234000001' && f2 === '6001234000002' && f3 === null && bad === 'BARCODE_INVALID', { f1, f2, f3, bad });

  /* BC2 */
  const d2 = makeDb(base());
  const dupNew = await codeOf(create(d2, { name: 'Soda copy', price: 80, barcode: '6161101234567' }, 'u1'));
  const dupLegacy = await codeOf(create(d2, { name: 'Juice copy', price: 90, specs: { barcode: '5000112233445' } }, 'u2'));
  const dupUpd = await codeOf(MD.updateProduct({ scope: SCOPE, db: d2, id: 'a2', patch: { barcode: '6161101234567' } }));
  const sameOk = await codeOf(MD.updateProduct({ scope: SCOPE, db: d2, id: 'a1', patch: { barcode: '6161101234567', price: 85 } }));
  const otherShop = await create(d2, { name: 'My own soda', price: 75, barcode: '7777777777777' }, 'u3').then((r) => r, (e) => ({ err: e.code || e.message }));
  ck('BC2 a code another of MY products holds is refused (create, legacy, update); the same product keeps it; another shop\'s code is not a conflict',
    dupNew === 'BARCODE_TAKEN' && dupLegacy === 'BARCODE_TAKEN' && dupUpd === 'BARCODE_TAKEN' && sameOk === null && otherShop.id && d2.P[otherShop.id].shopId === 'shopA'
    && d2.P.b1.shopId === 'shopB' && d2.P.b1.name === 'Their Soda',
    { dupNew, dupLegacy, dupUpd, sameOk, otherShop: otherShop.err || 'created' });

  /* BC3 */
  let rows = [];
  try { rows = await MD.listProducts({ scope: SCOPE, db: makeDb(Object.assign(base(), { a3: { id: 'a3', name: 'Twin', price: 1, shopId: 'shopA', status: 'active', barcode: 'DUP1' }, a4: { id: 'a4', name: 'Twin2', price: 1, shopId: 'shopA', status: 'active', sku: 'DUP1' } })) }); } catch (_) {}
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const fb = (c) => { const h = MD.findByCode && MD.findByCode(rows, c); return h ? h.id : null; };
  ck('BC3 list rows carry the barcode (legacy too, other shops never listed); findByCode resolves barcode / legacy / SKU, never between two',
    byId.a1 && byId.a1.barcode === '6161101234567' && byId.a2 && byId.a2.barcode === '5000112233445' && !byId.b1
    && fb('6161101234567') === 'a1' && fb('5000112233445') === 'a2' && fb('7777777777777') === null && fb('dup1') === null,
    { a1: byId.a1 && byId.a1.barcode, a2: byId.a2 && byId.a2.barcode, b1: !!byId.b1, hits: [fb('6161101234567'), fb('5000112233445'), fb('dup1')] });

  /* BC4 — sokoni-barcode in a vm window */
  let B = null, queried = false, scanned, closed, attempted = 0;
  try {
    const win = { document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), body: { appendChild() {} } } };
    /* the lookup's only observable attempt in a vm: its Firestore import fails and it WARNS — so a warn = it tried to query */
    const ctx = vm.createContext({ window: win, console: { warn() { attempted++; }, log() {} }, BarcodeDetector: undefined, navigator: {} });
    vm.runInContext(src('sokoni-barcode.js'), ctx);
    B = win.SokoniBarcode;
    /* a lookup without a shop must answer null WITHOUT reaching Firestore — the import would be the first thing it does */
    const noShop = await B.lookupProduct('6161101234567');
    queried = noShop !== null || attempted > 0;
    /* positive control: WITH a shop it does attempt the (shop-scoped) query */
    await B.lookupProduct('6161101234567', { shopId: 'shopA' });
    /* scanOnce resolves the scanner's value, and null when the merchant closes it */
    B.openScanner = async ({ onScan }) => { onScan('6161101234567', 'ean_13'); };
    scanned = await B.scanOnce({ title: 't' });
    B.openScanner = async ({ onClose }) => { onClose(); };
    closed = await B.scanOnce({});
  } catch (e) { scanned = 'CRASH ' + e.message; }
  const bs = src('sokoni-barcode.js');
  ck('BC4 scanOnce resolves the scan (null on close); a lookup without a shop answers null; the query is shop-scoped',
    !!B && typeof B.scanOnce === 'function' && scanned === '6161101234567' && closed === null && !queried && attempted === 1
    && /where\('shopId', '==', shopId\), where\(field, '==', barcode\)/.test(bs) && !/where\('barcode', '==', barcode\), limit\(1\)/.test(bs),
    { scanOnce: !!(B && B.scanOnce), scanned, closed, queried, attempted });

  /* BC5 — merchant-v2 wiring */
  const mv = src('merchant-v2.html');
  const iScan = mv.indexOf('<script src="sokoni-barcode.js"></script>'), iProd = mv.indexOf('<script src="sokoni-merchant-products.js"></script>');
  ck('BC5 merchant-v2 loads the scanner before Products; Sell\'s openScanner uses scanOnce; findByBarcode is shop-scoped',
    iScan > 0 && iProd > iScan && /return B\.scanOnce\(\{ title: 'Scan an item' \}\)/.test(mv) && !/Barcode scanning is not available in this workspace yet/.test(mv)
    && /findByBarcode: function \(scope, code\)/.test(mv) && /where: \[\['shopId', '==', scope\.shopId\], \[field, '==', code\]\]/.test(mv) && /q\('specs\.barcode'\)/.test(mv),
    { iScan, iProd });

  /* BC6 — the bridge and the legacy lookups */
  const pos = src('pos.js'), inv = src('sokoni-inventory.js'), wh = src('warehouse-scanner.html');
  const bridged = (pos.match(/barcode: p\.barcode \|\| \(p\.specs && p\.specs\.barcode\) \|\| ''/g) || []).length === 2
    && /c\.barcode \|\| \(c\.specs && c\.specs\.barcode\)/.test(src('pos-inventory-sync.js'))
    && /data\.barcode \|\| \(data\.specs && data\.specs\.barcode\)/.test(src('functions/algolia-indexer.js'))
    && /data\.barcode \|\| \(data\.specs && data\.specs\.barcode\)/.test(src('functions/typesense-client.js'));
  const scoped = /where\('sellerUid', '==', seller\)\.where\('barcode', '==', barcode\)/.test(inv) && !/where\('barcode', '==', barcode\)\.limit\(5\)/.test(inv)
    && (wh.match(/where\('sellerUid','==',currentUser\.uid\)\.where\('sku'/g) || []).length === 2;
  ck('BC6 the till mirror and indexers read legacy specs.barcode; sokoni-inventory and warehouse-scanner query only the seller\'s own products',
    bridged && scoped, { bridged, scoped });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
