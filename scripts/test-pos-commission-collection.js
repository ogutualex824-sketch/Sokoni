#!/usr/bin/env node
/**
 * POS COMMISSION RECEIVABLE COLLECTION — the loop the till rail never closed.
 *
 *   node scripts/test-pos-commission-collection.js
 *
 * pos_commission_receivable was written by pos-zero-friction.js and read by NOTHING.
 * This suite audits the module that collects it, and it asserts the dangerous parts
 * hardest: the rail fails closed, an unknown outcome is never retried, and a
 * collection cannot be booked twice.
 *
 * The 5% accrual is NOT re-tested here — it is already green in
 * test-pos-financial-trace (20/0) and this slice does not touch it.
 */
'use strict';
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

/* ── a Firestore stub with the query shapes this module uses ─────────────────── */
function makeDb (seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  function docApi (col, id) {
    return {
      id, __col: col,
      get: async () => {
        const bag = store[col] || {};
        const has = Object.prototype.hasOwnProperty.call(bag, id);
        return { exists: has, id, data: () => (has ? bag[id] : undefined) };
      },
      set: async (v) => { store[col] = store[col] || {}; store[col][id] = v; writes.push({ col, id, v, op: 'set' }); },
      update: async (v) => {
        store[col] = store[col] || {};
        store[col][id] = Object.assign({}, store[col][id], v);
        writes.push({ col, id, v, op: 'update' });
      },
    };
  }
  function colApi (col) {
    const filters = [];
    const q = {
      where: (f, op, val) => { filters.push([f, op, val]); return q; },
      get: async () => {
        const bag = store[col] || {};
        const docs = Object.keys(bag).filter((id) => filters.every(([f, op, val]) => {
          const cur = bag[id] ? bag[id][f] : undefined;
          if (op === '==') return cur === val;
          if (op === 'in') return Array.isArray(val) && val.indexOf(cur) > -1;
          return true;
        })).map((id) => ({ id, data: () => bag[id] }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
      doc: (id) => docApi(col, id),
    };
    return q;
  }
  return { db: { collection: colApi }, store, writes };
}

/* ── load the module with its function/admin deps mocked ─────────────────────── */
function load (ledgerSpy) {
  const mocks = {
    'firebase-functions/v2/scheduler': { onSchedule: (a, b) => (typeof a === 'function' ? a : b) },
    'firebase-functions/v2/https': {
      onCall: (a, b) => (typeof a === 'function' ? a : b),
      HttpsError: class extends Error { constructor (c, m) { super(m); this.code = c; } },
    },
    'firebase-admin/firestore': { getFirestore: () => null },
  };
  const orig = Module._load;
  Module._load = function (req) {
    if (Object.prototype.hasOwnProperty.call(mocks, req)) return mocks[req];
    /* finos-utils is required LAZILY inside the confirm branch — the same trap that
       broke test-pos-financial-trace — so it is intercepted by NAME, not by timing. */
    if (/finos-utils$/.test(req) || /finos-utils\.js$/.test(req)) {
      return {
        ACCOUNTS: { EXTERNAL_MPESA: 'external:mpesa', PLATFORM_REVENUE: 'platform:revenue',
                    seller: (id) => 'seller:' + id },
        createLedgerEntry: async (db, e) => { ledgerSpy.push(e); return { id: 'L' + ledgerSpy.length }; },
      };
    }
    return orig.apply(this, arguments);
  };
  /* THE INTERCEPTION STAYS INSTALLED for the life of this process, deliberately.

     pos-commission-collection requires finos-utils LAZILY, inside the confirm branch
     at call time. Restoring Module._load in a `finally` — the obvious shape, and the
     one test-pos-financial-trace used — means the mock is gone by then and the real
     firebase-admin cannot resolve, because it lives in functions/package.json and
     functions/node_modules does not exist here. That is the exact defect that made
     five money assertions fail against correct code; it bit this suite too, on the
     first run, which is why it is written down rather than quietly fixed. */
  const p = path.join(ROOT, 'functions', 'pos-commission-collection.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

/* one accrued receivable of KES 150 (5% of a KES 3,000 till sale) */
const SEED = {
  ledger: {
    L1: { type: 'pos_commission_receivable', sellerId: 'S1', amountCents: 15000,
          debitAccount: 'seller:S1', creditAccount: 'platform:revenue',
          idempotencyKey: 'poscomm_sale1' },
  },
};

console.log('\nPOS COMMISSION COLLECTION\n' + '='.repeat(64));

(async () => {
  /* ══ 1. outstanding is derived from the ledger ══ */
  head('1 · outstanding comes from the books, not a cached balance');
  {
    const spy = []; const M = load(spy); const { db } = makeDb(SEED);
    const bal = await M.outstandingForSeller(db, 'S1');
    ck('accrued is the 5% receivable', bal.accruedCents === 15000, bal.accruedCents);
    ck('nothing collected yet', bal.collectedCents === 0);
    ck('outstanding = accrued - collected', bal.outstandingCents === 15000, bal.outstandingCents);
    ck('the seller is on the worklist', (await M.sellersWithReceivables(db)).indexOf('S1') > -1);
  }

  /* ══ 2. THE RAIL FAILS CLOSED ══ */
  head('2 · no approved rail ⇒ nothing is charged');
  {
    const spy = []; const M = load(spy); const { db, store } = makeDb(SEED);
    const r = await M.collectForSeller(db, 'S1', { period: '20260901' });
    ck('the attempt is recorded as blocked', r.state === M.STATE.BLOCKED, r.state);
    ck('NO ledger entry was written', spy.length === 0, spy.length + ' entries');
    ck('the debt is still outstanding',
       (await M.outstandingForSeller(db, 'S1')).outstandingCents === 15000);
    ck('the attempt is visible, so the debt is not lost from the worklist',
       !!store.posCommissionCollections['S1_20260901']);
    ck('CONTROL a disabled config is still no rail',
       (await M.collectForSeller(db, 'S2', { period: '20260901', config: { enabled: false, railId: 'x' } })).state !== M.STATE.CONFIRMED);
  }

  /* ══ 3. a confirmed collection settles the debt, in the right direction ══ */
  head('3 · confirmed ⇒ settling entry, seller CREDITED');
  {
    const spy = []; const M = load(spy);
    M._railRegistry.test = { id: 'test', charge: async () => ({ outcome: 'confirmed', ref: 'R1' }) };
    const { db, store } = makeDb(SEED);
    const cfg = { enabled: true, railId: 'test' };
    const r = await M.collectForSeller(db, 'S1', { period: '20260901', config: cfg });
    ck('state is confirmed', r.state === M.STATE.CONFIRMED, r.state);
    ck('one settling ledger entry', spy.length === 1, spy.length);
    const e = spy[0] || {};
    ck('...typed as a collection', e.type === 'pos_commission_collected', e.type);
    ck('...DEBITS the cash rail', e.debitAccount === 'external:mpesa', e.debitAccount);
    ck('...CREDITS the seller, reducing the debt', e.creditAccount === 'seller:S1', e.creditAccount);
    ck('...for the outstanding amount', e.amountCents === 15000, e.amountCents);
    ck('the accrual entry was NOT mutated',
       store.ledger.L1.type === 'pos_commission_receivable' && store.ledger.L1.amountCents === 15000,
       'ledger entries are immutable; settlement is a second entry');
    delete M._railRegistry.test;
  }

  /* ══ 4. IDEMPOTENCY — the dangerous one ══ */
  head('4 · a seller cannot be charged twice');
  {
    const spy = []; const M = load(spy);
    let charges = 0;
    M._railRegistry.test = { id: 'test', charge: async () => { charges++; return { outcome: 'confirmed', ref: 'R1' }; } };
    const { db } = makeDb(SEED);
    const cfg = { enabled: true, railId: 'test' };
    await M.collectForSeller(db, 'S1', { period: '20260901', config: cfg });
    const again = await M.collectForSeller(db, 'S1', { period: '20260901', config: cfg });
    ck('the rail was called exactly ONCE', charges === 1, charges + ' charges');
    ck('the second run is a recognised duplicate', again.duplicate === true, JSON.stringify(again.state));
    ck('only ONE settling entry exists', spy.length === 1, spy.length);
    ck('the collection key is DISTINCT from the accrual key',
       M.collectionKey('S1', '20260901') !== 'poscomm_sale1' &&
       /^poscollect_/.test(M.collectionKey('S1', '20260901')),
       M.collectionKey('S1', '20260901'));
    ck('...and is deterministic per seller and period',
       M.collectionKey('S1', '20260901') === M.collectionKey('S1', '20260901'));
    delete M._railRegistry.test;
  }

  /* ══ 5. UNKNOWN IS NOT FAILURE, AND IS NEVER RETRIED ══ */
  head('5 · an unknown outcome is never blind-retried');
  {
    const spy = []; const M = load(spy);
    let charges = 0;
    M._railRegistry.test = { id: 'test', charge: async () => { charges++; return { outcome: 'unknown' }; } };
    const { db, store } = makeDb(SEED);
    const cfg = { enabled: true, railId: 'test' };
    const r = await M.collectForSeller(db, 'S1', { period: '20260901', config: cfg });
    ck('state is unknown, not failed', r.state === M.STATE.UNKNOWN, r.state);
    ck('NOT marked collected', spy.length === 0, spy.length + ' ledger entries');
    ck('the receivable stays outstanding',
       (await M.outstandingForSeller(db, 'S1')).outstandingCents === 15000);
    const retry = await M.collectForSeller(db, 'S1', { period: '20260901', config: cfg });
    ck('a re-run does NOT charge again', charges === 1, charges + ' charges');
    ck('...it reports the existing unresolved attempt', retry.duplicate === true);
    ck('the record says the outcome is genuinely unknown',
       /may or may not/.test((store.posCommissionCollections['S1_20260901'] || {}).note || ''));
    delete M._railRegistry.test;
  }

  head('5b · a THROWN rail error is unknown, not failed');
  {
    const spy = []; const M = load(spy);
    M._railRegistry.test = { id: 'test', charge: async () => { throw new Error('socket hang up'); } };
    const { db } = makeDb(SEED);
    const r = await M.collectForSeller(db, 'S1', { period: '20260901', config: { enabled: true, railId: 'test' } });
    ck('a thrown error yields unknown', r.state === M.STATE.UNKNOWN, r.state);
    ck('...because the request may have reached the gateway', spy.length === 0);
    delete M._railRegistry.test;
  }

  /* ══ 6. an explicit refusal leaves the debt outstanding ══ */
  head('6 · a refused charge is failed, and still owed');
  {
    const spy = []; const M = load(spy);
    M._railRegistry.test = { id: 'test', charge: async () => ({ outcome: 'failed' }) };
    const { db } = makeDb(SEED);
    const r = await M.collectForSeller(db, 'S1', { period: '20260901', config: { enabled: true, railId: 'test' } });
    ck('state is failed', r.state === M.STATE.FAILED, r.state);
    ck('nothing was booked', spy.length === 0);
    ck('still outstanding', (await M.outstandingForSeller(db, 'S1')).outstandingCents === 15000);
    delete M._railRegistry.test;
  }

  /* ══ 7. RECONCILIATION ══ */
  head('7 · reconciliation reports, and never repairs');
  {
    const spy = []; const M = load(spy);
    const seed = JSON.parse(JSON.stringify(SEED));
    seed.posCommissionCollections = {
      S1_20260830: { sellerId: 'S1', period: '20260830', state: 'confirmed',
                     amountCents: 15000, idempotencyKey: 'poscollect_S1_20260830' },
    };
    const { db, store } = makeDb(seed);
    const rep = await M.reconcile(db, { period: '20260901' });
    ck('accrued is reported', rep.accruedCents === 15000, rep.accruedCents);
    ck('the identity holds: accrued - collected = outstanding', rep.balanced === true);
    ck('a confirmed attempt with NO settling entry is caught',
       rep.findings.some((f) => f.kind === 'collected_without_ledger'),
       rep.findings.map((f) => f.kind).join(','));
    ck('the accrual was not altered by reconciling',
       store.ledger.L1.amountCents === 15000 && !store.ledger.L1.collected,
       'a reconciliation that repairs can hide the drift it exists to surface');
    ck('the report is the only thing written',
       Object.keys(store.posCommissionReconciliation || {}).length === 1);
  }

  head('7b · reconciliation catches over-collection and stale unknowns');
  {
    const spy = []; const M = load(spy);
    const seed = JSON.parse(JSON.stringify(SEED));
    seed.ledger.L2 = { type: 'pos_commission_collected', sellerId: 'S1', amountCents: 20000,
                       idempotencyKey: 'poscollect_S1_20260829' };
    seed.posCommissionCollections = {
      S1_20260820: { sellerId: 'S1', period: '20260820', state: 'unknown', amountCents: 15000,
                     idempotencyKey: 'poscollect_S1_20260820' },
    };
    const { db } = makeDb(seed);
    const rep = await M.reconcile(db, { period: '20260901' });
    ck('collecting MORE than accrued is caught',
       rep.findings.some((f) => f.kind === 'over_collected'), rep.findings.map((f) => f.kind).join(','));
    ck('an unresolved unknown from an earlier period is caught',
       rep.findings.some((f) => f.kind === 'stale_unknown'));
    ck('the report is not ok', rep.ok === false);
  }

  /* ══ 8. THE BOUNDARIES ══ */
  head('8 · boundaries — direction, and the untouched rails');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'pos-commission-collection.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    ck('NO B2C anywhere in the collection path', !/B2C/i.test(code),
       'B2C is a PAYOUT rail here — it would pay sellers 5% daily instead of collecting');
    ck('the rail registry ships EMPTY', /_railRegistry = \{\}/.test(code),
       'adding a rail is a commercial decision, not a code default');
    ck('the module never writes to the marketplace settlement path',
       !/order-settlement|releaseEscrow|computeSettlement/.test(code));
    ck('it does not recompute commission — 5% stays with calculateCommission',
       !/calculateCommission/.test(code));
    ck('the accrual writer is untouched by this slice',
       fs.readFileSync(path.join(ROOT, 'functions', 'pos-zero-friction.js'), 'utf8')
         .indexOf('pos_commission_receivable') > -1);
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
