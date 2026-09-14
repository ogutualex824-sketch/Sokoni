#!/usr/bin/env node
/**
 * recordPOSSale — where every amount comes from, and what it can reach.
 *
 *   node scripts/test-recordpossale-money-provenance.js
 *
 * THE MAP (all five inputs are client-supplied; none is looked up from the product)
 *
 *   price     client  ->  lineTotal -> subtotal -> total   -> posSales.total
 *   cost      client  ->  costTotal -> profit            -> posSales.profit
 *   qty       client  ->  lineTotal AND products.stock decrement   <-- authoritative
 *   discount  client  ->  lineTotal
 *   taxRate   client  ->  IGNORED — taxAmount uses a hardcoded 16
 *
 * WHAT THOSE VALUES CAN AND CANNOT REACH
 * `posSales` is read by ten POS-domain modules and by NO commission, settlement, payout,
 * ledger, finos, sfos or escrow module. `profit` is consumed only by analytics inside
 * pos-retail-engine. So a client price or cost distorts the seller's OWN reporting; it does
 * not enter a platform financial authority.
 *
 * PRICE IS A LEGITIMATE OVERRIDE, NOT A DEFECT. The POS has a `price_override` approval type
 * and `ManagerAuth.requestPriceOverride`; selling at a cashier-entered price is intended
 * behaviour governed by the PIN today and by the approval primitive later. It is NOT removed
 * here.
 *
 * THE ONE REAL DEFECT, AND IT IS NOT PRICE OR COST
 * `productId` is caller-supplied and the transaction decrements `products/{id}.stock`. Nothing
 * checked the product belonged to the caller's shop, so a seller could record a sale in their
 * own books naming ANOTHER merchant's product and decrement that merchant's inventory. The
 * oversell guard protected the quantity; it never protected the identity.
 *
 * SEPARATELY CHARACTERISED, NOT FIXED HERE
 * `pos-accounting` computes COGS from `item.costPrice`; this writer emits `item.cost`. COGS
 * from POS sales is therefore always ZERO. That understates cost of goods in the financial
 * statements, and its intended contract has never been established.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

const RE_SRC = fs.readFileSync(path.join(ROOT, 'functions/pos-retail-engine.js'), 'utf8');
const ACC_SRC = fs.readFileSync(path.join(ROOT, 'functions/pos-accounting.js'), 'utf8');
const strip = (src) => {
  let out = '', i = 0, inB = false;
  while (i < src.length) {
    if (!inB && src[i] === '/' && src[i + 1] === '*') { inB = true; i += 2; continue; }
    if (inB && src[i] === '*' && src[i + 1] === '/') { inB = false; i += 2; continue; }
    if (!inB) out += src[i];
    i++;
  }
  return out;
};
const RE_CODE = strip(RE_SRC);

/* ── in-memory Firestore ──────────────────────────────────────────────────── */
let STORE = {};
let AUTO = 0;
const INC = (n) => ({ __inc: n });
const applyPatch = (t, p) => Object.keys(p).forEach((k) => {
  const v = p[k];
  if (v && typeof v === 'object' && typeof v.__inc === 'number') t[k] = (Number(t[k]) || 0) + v.__inc;
  else t[k] = v;
});
function makeRef (coll, id) {
  const key = coll + '/' + id;
  return { id, _key: key,
    get: async () => ({ exists: Object.prototype.hasOwnProperty.call(STORE, key),
                        data: () => STORE[key], id, ref: makeRef(coll, id) }),
    set: async (v) => { STORE[key] = v; },
    update: async (v) => { applyPatch(STORE[key] = STORE[key] || {}, v); } };
}
function makeColl (coll) {
  const c = {};
  c.where = () => c; c.orderBy = () => c; c.limit = () => c;
  c.get = async () => ({ empty: true, docs: [], size: 0, forEach() {} });
  c.doc = (id) => makeRef(coll, id || ('a' + (++AUTO)));
  c.add = async (v) => { const r = c.doc(); STORE[r._key] = v; return r; };
  return c;
}
const fdb = {
  collection: makeColl,
  batch: () => {
    const ops = [];
    return { set: (r, v) => ops.push(['set', r, v]), update: (r, v) => ops.push(['up', r, v]),
             commit: async () => ops.forEach(([op, r, v]) => {
               if (op === 'set') STORE[r._key] = v;
               else applyPatch(STORE[r._key] = STORE[r._key] || {}, v);
             }) };
  },
  runTransaction: async (fn) => {
    const writes = [];
    const out = await fn({ get: async (r) => r.get(),
      update: (r, v) => writes.push([r, v]) });
    writes.forEach(([r, v]) => applyPatch(STORE[r._key] = STORE[r._key] || {}, v));
    return out;
  },
};
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = true; }
}
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return { apps: [1], initializeApp() {},
    firestore: Object.assign(() => fdb, { FieldValue: {
      serverTimestamp: () => 'TS', increment: INC, arrayUnion: (...v) => v, delete: () => null } }) };
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({}) };
  if (request === './company-identity') return { COMPANY: {} };
  /* voidPOSSale now consults the employee authority and the tenant resolver (Priority 17).
     This suite tests recordPOSSale, which uses neither — but the module imports them at
     load time, so the harness must provide them or nothing loads at all. */
  if (request.endsWith('workforce-identity')) return {
    _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no membership in this harness'); } };
  if (request.endsWith('tenant-identity')) return {
    resolveMerchantIdForOwner: async () => ({ ok: false, reason: 'no-business-for-owner' }),
    looksLikeOwnerForm: (v, u) => v === u, REASON: {} };
  return realLoad.apply(this, arguments);
};
const RE = require(path.join(ROOT, 'functions/pos-retail-engine.js'));
Module._load = realLoad;

const record = RE.recordPOSSale;
const SELLER = { role: 'seller' };
const req = (uid, claims, data) => ({ auth: { uid, token: claims }, data });
const caught = async (fn) => { try { return { code: null, value: (await fn()) || {} }; }
                               catch (e) { return { code: e.code || 'threw', value: {} }; } };
const SHOP_A = 'uidShopA', SHOP_B = 'uidShopB';
function reset () {
  STORE = {};
  STORE['sellers/' + SHOP_A] = { name: 'A' };
  STORE['sellers/' + SHOP_B] = { name: 'B' };
  STORE['products/P_A'] = { sellerUid: SHOP_A, stock: 10, soldCount: 0, name: 'A item' };
  STORE['products/P_B'] = { sellerUid: SHOP_B, stock: 10, soldCount: 0, name: 'B item' };
}
const sale = (o) => Object.assign({
  items: [{ productId: 'P_A', name: 'A item', qty: 2, price: 100, cost: 40 }],
  payment: { method: 'cash', amount: 200 },
}, o);
const saleDoc = () => Object.keys(STORE).filter((k) => k.indexOf('posSales/') === 0).map((k) => STORE[k])[0] || {};

console.log(NL + 'recordPOSSale — MONEY PROVENANCE' + NL + '='.repeat(62));

(async function main () {

/* ── 0 · controls ─────────────────────────────────────────────────────────── */
head('0 · CONTROLS');
ck('the handler loaded', typeof record === 'function');
ck('CONTROL the comment stripper works',
   RE_CODE.indexOf('THE PRODUCT MUST BELONG TO THIS SHOP') === -1 && RE_CODE.length > 20000);
reset();
ck('CONTROL a legitimate own-shop sale SUCCEEDS',
   (await caught(() => record(req(SHOP_A, SELLER, sale())))).code === null,
   'if this failed, every refusal below would be vacuous');

/* ── 1 · provenance of each amount ────────────────────────────────────────── */
head('1 · every input is client-supplied; none is looked up');
['price', 'cost', 'qty', 'discount', 'taxRate'].forEach((f) => {
  ck(f + ' comes from the payload', RE_CODE.indexOf('_num(item.' + f) > -1);
});
ck('NEGATIVE no product price/cost lookup exists in the calculation',
   RE_CODE.indexOf('const validatedItems') > -1 &&
   RE_CODE.slice(RE_CODE.indexOf('const validatedItems'),
                 RE_CODE.indexOf('const itemDiscount')).indexOf("collection('products')") === -1,
   'totals are computed from what the till sent, not from the catalogue');
ck('taxRate is accepted and then IGNORED',
   RE_CODE.indexOf('_num(item.taxRate, 16)') > -1 &&
   RE_CODE.indexOf('const avgTaxRate   = 16;') > -1,
   'a per-item rate is read, stored, and never used in taxAmount');

/* ── 2 · what the derived values reach ────────────────────────────────────── */
head('2 · profit and total are display, not settlement');
reset();
await record(req(SHOP_A, SELLER, sale()));
const d = saleDoc();
ck('the sale records the client-derived total', d.total === 200, String(d.total));
ck('...and the client-derived profit', d.profit === 120, String(d.profit) + ' = 200 - (40*2)');
ck('CONTROL posSales reaches no financial engine',
   ['commission', 'settlement', 'payout', 'ledger', 'finos', 'sfos', 'escrow'].every((m) =>
     fs.readdirSync(path.join(ROOT, 'functions'))
       .filter((f) => f.indexOf(m) > -1 && f.slice(-3) === '.js')
       .every((f) => fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8')
         .indexOf("collection('posSales')") === -1)),
   'so a distorted profit corrupts the seller own reporting, not platform money');

/* ── 3 · THE REAL DEFECT: cross-shop stock ────────────────────────────────── */
head('3 · a seller cannot decrement another shop stock');
reset();
const attack = await caught(() => record(req(SHOP_A, SELLER,
  sale({ items: [{ productId: 'P_B', name: 'B item', qty: 3, price: 1, cost: 0 }] }))));
ck('NEGATIVE the sale is REFUSED', attack.code === 'permission-denied', attack.code);
ck('...and the other shop stock is UNTOUCHED', STORE['products/P_B'].stock === 10,
   'before this it would have fallen to 7');
ck('...and no sale document was written',
   Object.keys(STORE).filter((k) => k.indexOf('posSales/') === 0).length === 0);
reset();
ck('POSITIVE the own-shop product still sells',
   (await caught(() => record(req(SHOP_A, SELLER, sale())))).code === null &&
   STORE['products/P_A'].stock === 8,
   'the guard must not block legitimate trade');

head('3b · the guard reads the field production actually uses');
ck('sellerUid is checked FIRST',
   RE_CODE.indexOf('snaps[i].data().sellerUid || snaps[i].data().sellerId') > -1,
   'the served rule creates products with sellerUid == request.auth.uid');
ck('CONTROL the void path was corrected too',
   RE_CODE.indexOf('p.data().sellerUid || p.data().sellerId || p.data().merchantId') > -1,
   'it read only sellerId/merchantId, so on real products the guard was SKIPPED');
reset();
STORE['products/P_A'] = { stock: 10, soldCount: 0, name: 'ownerless' };
ck('KNOWN LIMIT a product with NO owner field still sells',
   (await caught(() => record(req(SHOP_A, SELLER, sale())))).code === null,
   'failing closed would block legacy products; how many exist is a production question');

/* ── 4 · the oversell guard is intact ─────────────────────────────────────── */
head('4 · quantity protection unchanged');
reset();
ck('NEGATIVE overselling is refused',
   (await caught(() => record(req(SHOP_A, SELLER,
     sale({ items: [{ productId: 'P_A', name: 'A item', qty: 99, price: 1, cost: 0 }] }))))).code
     === 'failed-precondition');
ck('...and stock is unchanged', STORE['products/P_A'].stock === 10);

/* ── 5 · price override is legitimate ─────────────────────────────────────── */
head('5 · a cashier-entered price is intended behaviour');
ck('the POS has a price_override approval type',
   fs.readFileSync(path.join(ROOT, 'functions/pos-staff-ops.js'), 'utf8')
     .indexOf("price_override: ['productId', 'amount']") > -1);
ck('...and a manager-authorisation path for it',
   fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8').indexOf('requestPriceOverride') > -1);
ck('CONTROL price was NOT removed from the payload',
   RE_CODE.indexOf('_num(item.price, 0)') > -1,
   'removing a legitimate override would be a regression, not a fix');

/* ── 6 · characterised, not fixed ─────────────────────────────────────────── */
head('6 · accounting COGS is a separate defect');
ck('accounting reads item.costPrice', strip(ACC_SRC).indexOf('Number(item.costPrice)') > -1);
ck('...but this writer emits item.cost',
   RE_CODE.indexOf('qty, price, cost, discount, taxRate, lineTotal') > -1);
ck('NEGATIVE it has not been silently renamed',
   RE_CODE.indexOf('costPrice:') === -1,
   'COGS from POS sales is always zero; the intended contract is unestablished');

/* ── 7 · boundary ─────────────────────────────────────────────────────────── */
head('7 · what this does not settle');
un('whether client cost SHOULD be authoritative', 'a business decision; today it reaches only own-shop reporting');
un('how many products lack an owner field', 'production query — the guard fails open for those');
un('accounting COGS intended behaviour', 'separate defect, deliberately uncorrected');
un('a real cross-shop attempt in production', 'needs the deployed dispatcher and two seller accounts');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: price/cost are display-scope. The defect fixed here is stock identity.');
})().then(() => process.exit(fail ? 1 : 0))
   .catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
