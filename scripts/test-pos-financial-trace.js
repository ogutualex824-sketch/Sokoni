#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — a till sale produces a COMPLETE financial trace.
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-pos-financial-trace.js

       sale → tax record → commission → balanced ledger entry → payable balance

   WHY THIS EXISTS
   posCompleteCheckout wrote posRetailSales, posDaily and posReceipts and stopped.
   No commission entry, no ledger entry, no tax computation. The commission writer
   (payment-success.js onPaymentSucceeded) watches `payments/{id}` — the IntaSend
   collection — while POS writes `posPayments`, so a till sale reached NO financial
   path at all. Every downstream product the merchant was promised — commission,
   settlement, the tax pack — reads from records that were never written.

   THE ONE THING THIS MUST NOT DO
   Book cash SOKONI never held. `settlement-engine.computeSettlement()` assumes
   "100% of every customer payment is collected into the Bravilex account first".
   That is FALSE for a till: cash is in the merchant's drawer and a DIRECT_TO_SELLER
   M-Pesa payment went to the merchant's own shortcode. Posting a till sale as a
   settlement out of platform clearing would invent platform cash and create seller
   liabilities with nothing behind them — the exact defect payment-config.js:41-55
   warns about. Commission on a till sale is a RECEIVABLE.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

function makeStore() {
  const store = {
    products: {
      P1: { name: 'Sugar 2kg', price: 1000, stock: 50 },
      P2: { name: 'Rice 5kg',  price: 2000, stock: 50 },
    },
    merchants: { OWNER1: { name: 'Bravilex', vatStatus: 'registered' },
                 OWNER2: { name: 'Small Duka' } },
    shops: { OWNER1: { name: 'Bravilex International Co. Limited' },
             OWNER2: { name: 'Small Duka' } },
    users: { OWNER1: { name: 'Alex Ogutu' }, OWNER2: { name: 'Jane Njeri' } },
    shopEmployees: {},
    posPayments: {},
    posPaymentClaims: {},
    posIdempotency: {},
    revenueConfig: { global: { defaultCommissionPct: 5 } },
    coupons: {},
    idempotency: {},
    ledger: {},
    writes: [],
  };

  function docApi(col, id) {
    const ref = {
      id, __col: col,
      get: async () => {
        const bag = store[col] || {};
        const has = Object.prototype.hasOwnProperty.call(bag, id);
        return { exists: has, id, ref, data: () => (has ? bag[id] : undefined) };
      },
      create: async (v) => {
        store[col] = store[col] || {};
        if (Object.prototype.hasOwnProperty.call(store[col], id)) {
          const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e;
        }
        store[col][id] = v;
      },
      set: async (v) => {
        store.writes.push({ col, id, v });
        store[col] = store[col] || {}; store[col][id] = v;
      },
      update: async (v) => {
        store.writes.push({ col, id, v, update: true });
        store[col] = store[col] || {};
        store[col][id] = Object.assign({}, store[col][id], v);
      },
      delete: async () => { if (store[col]) delete store[col][id]; },
    };
    return ref;
  }

  let autoN = 0;
  function colApi(col) {
    const q = {
      doc: (id) => docApi(col, id == null ? ('auto' + (++autoN)) : String(id)),
      add: async (v) => { store.writes.push({ col, id: null, v }); return { id: 'auto' + (++autoN) }; },
      where: () => q, orderBy: () => q, limit: () => q,
      get: async () => ({ empty: true, docs: [], size: 0 }),
    };
    return q;
  }

  const db = {
    collection: colApi,
    doc: (p) => { const [c, i] = String(p).split('/'); return docApi(c, i); },
    runTransaction: async (fn) => fn({
      get: async (ref) => ref.get(),
      set: (ref, v) => { store.writes.push({ col: ref.__col, id: ref.id, v, txn: true }); },
      update: (ref, v) => { store.writes.push({ col: ref.__col, id: ref.id, v, txn: true, update: true }); },
      create: (ref, v) => { store.writes.push({ col: ref.__col, id: ref.id, v, txn: true }); },
      delete: () => {},
    }),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }),
  };
  return { store, db };
}

function loadModule(db) {
  const https = {
    onCall: (a, b) => (typeof a === 'function' ? a : b),
    HttpsError: class HttpsError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
  };
  const mocks = {
    'firebase-functions/v2/https': https,
    'firebase-functions/v2/scheduler': { onSchedule: (a, b) => (typeof a === 'function' ? a : b) },
    'firebase-functions/v2/firestore': { onDocumentCreated: () => {}, onDocumentWritten: () => {},
                                         onDocumentUpdated: () => {} },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: {
        increment: (n) => ({ __increment: n }),
        serverTimestamp: () => ({ __serverTimestamp: true }),
        arrayUnion: function () { return { __arrayUnion: [].slice.call(arguments) }; },
      },
    },
    'firebase-admin': { firestore: () => db, auth: () => ({ getUser: async () => null }) },
    './pos-audit': { writeAudit: async () => {} },
  };
  const origLoad = Module._load;
  Module._load = function (req) {
    if (Object.prototype.hasOwnProperty.call(mocks, req)) return mocks[req];
    return origLoad.apply(this, arguments);
  };
  try {
    for (const f of ['pos-zero-friction.js', 'merchant-identity.js', 'finos-utils.js',
                     'etims-tax-engine.js', 'payment-config.js']) {
      const p = path.join(ROOT, 'functions', f);
      try { delete require.cache[require.resolve(p)]; } catch (_) {}
    }
    return require(path.join(ROOT, 'functions', 'pos-zero-friction.js'));
  } finally { Module._load = origLoad; }
}

let keyN = 0;
const cart = (over) => Object.assign({
  idempotencyKey: 'fin' + (++keyN),
  merchantId: 'OWNER1',
  items: [{ productId: 'P1', qty: 1, unitPrice: 1000 }, { productId: 'P2', qty: 1, unitPrice: 2000 }],
  subtotal: 3000, grandTotal: 3000,
  payments: [{ method: 'cash', amount: 3000 }],
}, over || {});

async function call(fn, data, uid) {
  try { return { ok: true, res: await fn({ data, auth: { uid: uid || 'OWNER1', token: {} } }) }; }
  catch (e) { return { ok: false, err: (e && e.message) || String(e), code: e && e.code }; }
}

const ledgerWrites = (store) => store.writes.filter((w) => w.col === 'ledger');
const saleWrite = (store) => store.writes.find((w) => w.v && w.v.grandTotal != null && w.v.items);

(async function main() {
  const { store, db } = makeStore();
  const M = loadModule(db);
  const F = M.posCompleteCheckout;

  ck('F0  the real handler loaded', typeof F === 'function', 'everything below depends on it');

  store.writes.length = 0;
  const sale = await call(F, cart());
  ck('F1  CONTROL an ordinary cash sale still completes',
    sale.ok, sale.ok ? ('total ' + sale.res.receipt.total) : sale.err);

  const sw = saleWrite(store);
  const led = ledgerWrites(store);

  /* ── the trace ─────────────────────────────────────────────────────────── */
  ck('F2  the sale records a COMMISSION figure',
    !!(sw && sw.v.commission && typeof sw.v.commission.amountCents === 'number'),
    sw && sw.v.commission ? JSON.stringify(sw.v.commission)
                          : 'no commission on the stored sale — nothing downstream can bill it');

  ck('F3  a BALANCED ledger entry is written for the commission',
    led.length > 0 && led.every((w) => w.v.debitAccount && w.v.creditAccount && w.v.amountCents > 0),
    led.length ? led.map((w) => w.v.type + ' ' + w.v.debitAccount + '→' + w.v.creditAccount +
                                ' ' + w.v.amountCents).join(' | ')
               : 'NO ledger entry — the till sale never reaches the books');

  ck('F4  commission is booked as a RECEIVABLE, not out of platform clearing',
    led.length > 0 && led.every((w) => w.v.creditAccount === 'platform:revenue' &&
                                       String(w.v.debitAccount).startsWith('seller:')),
    'SOKONI holds no cash for a till sale; debiting clearing would invent it. ' +
    (led.length ? led[0].v.debitAccount + ' → ' + led[0].v.creditAccount : 'n/a'));

  ck('F5  the ledger entry carries an idempotency key derived from the sale',
    led.length > 0 && led.every((w) => !!w.v.idempotencyKey),
    'a retried posting must not double-book commission');

  ck('F6  the sale records a TAX computation',
    !!(sw && sw.v.tax),
    sw && sw.v.tax ? JSON.stringify(sw.v.tax).slice(0, 120) : 'no tax record — no filing trail');

  ck('F7  the tax record is labelled an ESTIMATE, never an official figure',
    !!(sw && sw.v.tax && sw.v.tax.basis === 'sokoni_estimate'),
    'SOKONI assists with filing; it does not assess liability');

  ck('F8  the collection route is stamped, so reconciliation knows who holds the cash',
    !!(sw && sw.v.collectionRoute),
    sw ? String(sw.v.collectionRoute) : 'absent');

  /* ── a merchant whose VAT status is unknown ────────────────────────────── */
  store.writes.length = 0;
  const un = await call(F, cart({ merchantId: 'OWNER2' }), 'OWNER2');
  const uw = saleWrite(store);
  ck('F9  CONTROL a sale still completes for a merchant with no VAT status',
    un.ok, un.ok ? 'completed' : un.err);
  ck('F10 an UNDECLARED VAT status yields no invented tax figure',
    !!(uw && uw.v.tax && uw.v.tax.vatStatus === 'undeclared' && uw.v.tax.vatCents == null),
    uw && uw.v.tax ? JSON.stringify(uw.v.tax).slice(0, 140)
                   : 'no tax record at all — should be a stated unknown, not silence');

  /* ── failure must not silently swallow the posting ─────────────────────── */
  ck('F11 a sale that could not be posted says so on the record',
    !!(sw && sw.v.financialPosting),
    sw ? String(sw.v.financialPosting) : 'no posting status — a failed posting would be invisible');

  /* ── CONTROLS ──────────────────────────────────────────────────────────── */
  const bogus = await call(F, cart({ items: [] }));
  ck('F12 CONTROL the probe still detects a refusal',
    !bogus.ok, 'empty cart must be refused: ' + (bogus.ok ? 'IT WAS NOT' : bogus.err));

  store.writes.length = 0;
  const dup = cart();
  await call(F, dup);
  const firstLed = ledgerWrites(store).length;
  store.writes.length = 0;
  await call(F, dup);                       /* same idempotencyKey — the cached path */
  ck('F13 replaying the same sale does NOT double-book commission',
    ledgerWrites(store).length === 0 && firstLed > 0,
    'first posting wrote ' + firstLed + ', replay wrote ' + ledgerWrites(store).length);

  const passed = rows.filter((r) => r.ok).length;
  console.log('');
  console.log('  POS FINANCIAL TRACE — sale → tax → commission → ledger');
  console.log('  ' + '='.repeat(68));
  console.log('');
  for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
  console.log('');
  console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
  console.log('');
  process.exit(passed === rows.length ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
