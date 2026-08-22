/* PROOF — the seller's withdrawable balance is credited EXACTLY ONCE per order.
   ==========================================================================
   Run:  node scripts/proof-settlement-exactly-once.js

   No emulator, no production, no network. settleOrder(db, adminSdk, orderId) takes
   both handles as parameters, so a recording fake can observe every write it makes.
   settlement-engine is stubbed through require.cache before order-settlement loads,
   because it is a module-scope dependency.

   ── THE INVARIANT UNDER TEST ──────────────────────────────────────────────
   For one order, the seller's withdrawable balance is credited exactly once,
   regardless of webhook delivery, trigger retry, or settlement replay.

   That is STRONGER than "the state string matches". Deterministic ids already make
   walletTransactions, settlements and ledger replay-safe — a repeated .set() on the
   same id overwrites. FieldValue.increment does NOT overwrite, so the balance is the
   one write that a replay can double, and it must be protected by a real record
   rather than by a string comparison.

   ── WHY THIS EXISTS ───────────────────────────────────────────────────────
   Production carries seven orders whose settlementStatus is the LOWERCASE "settled",
   written by _finalizeMarketplacePayment on the IntaSend rail, while
   order-settlement's STATES.SETTLED is "SETTLED". The replay guard compares with ===.
==========================================================================*/
'use strict';
const path = require('path');
const Module = require('module');

/* ── stub settlement-engine before order-settlement requires it ──────────── */
const enginePath = require.resolve(path.join(__dirname, '..', 'functions', 'settlement-engine.js'));
require.cache[enginePath] = new Module(enginePath, null);
require.cache[enginePath].filename = enginePath;
require.cache[enginePath].loaded = true;
require.cache[enginePath].exports = {
  computeSettlement: async () => ({
    sellerNetCents: 9000,
    commission: { cents: 1000, rate: 0.1 },
    ledgerPlan: [{ type: 'commission', debitAccount: 'a', creditAccount: 'b', amountCents: 1000 }],
  }),
};

const OS = require(path.join(__dirname, '..', 'functions', 'order-settlement.js'));

/* ── recording fakes ─────────────────────────────────────────────────────── */
const INC = (n) => ({ __inc: n });
const adminSdk = { firestore: { FieldValue: {
  increment: INC, serverTimestamp: () => ({ __ts: true }), delete: () => ({ __del: true }),
} } };

function makeDb(store) {
  const key = (c, i) => c + '/' + i;
  const snap = (c, i) => {
    const d = store[key(c, i)];
    return { exists: d !== undefined, id: i, data: () => d };
  };
  const ref = (c, i) => ({ _c: c, _i: i, get: async () => snap(c, i) });
  const writes = [];
  const applySet = (c, i, data, opts) => {
    writes.push({ op: 'set', path: key(c, i), data, merge: !!(opts && opts.merge) });
    const cur = store[key(c, i)];
    if (opts && opts.merge && cur) {
      const next = { ...cur };
      for (const [k, v] of Object.entries(data)) {
        next[k] = (v && v.__inc !== undefined) ? (Number(cur[k]) || 0) + v.__inc : v;
      }
      store[key(c, i)] = next;
    } else {
      const next = {};
      for (const [k, v] of Object.entries(data)) {
        next[k] = (v && v.__inc !== undefined) ? v.__inc : v;
      }
      store[key(c, i)] = next;
    }
  };
  return {
    writes,
    collection: (c) => ({ doc: (i) => ref(c, i) }),
    runTransaction: async (fn) => fn({
      get: async (r) => snap(r._c, r._i),
      set: (r, data, opts) => applySet(r._c, r._i, data, opts),
      update: (r, data) => applySet(r._c, r._i, data, { merge: true }),
    }),
  };
}

const SELLER = 'sellerA';
function seedOrder(store, id, settlementStatus) {
  store['orders/' + id] = {
    sellerUid: SELLER, orderTotal: 100, total: 100, deliveryFee: 0,
    status: 'completed', settlementStatus,
  };
}
const balanceOf = (store) => Number((store['wallets/' + SELLER] || {}).balance) || 0;
const countAt = (store, prefix) =>
  Object.keys(store).filter((k) => k.startsWith(prefix)).length;

/* ── rows ────────────────────────────────────────────────────────────────── */
const rows = [];
const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail || '' });

(async () => {
  /* 1 — fresh settlement credits exactly once */
  {
    const store = {}; seedOrder(store, 'O1', 'HELD');
    const db = makeDb(store);
    const r = await OS.settleOrder(db, adminSdk, 'O1');
    ck('P1   a fresh settlement credits the wallet exactly once',
      r.outcome === 'settled' && balanceOf(store) === 90,
      'outcome=' + r.outcome + ' balance=' + balanceOf(store));
    ck('P2   it writes one settlement, one wallet txn and one ledger entry',
      countAt(store, 'settlements/') === 1
      && countAt(store, 'walletTransactions/') === 1
      && countAt(store, 'ledger/') === 1,
      'settlements=' + countAt(store, 'settlements/')
      + ' walletTx=' + countAt(store, 'walletTransactions/')
      + ' ledger=' + countAt(store, 'ledger/'));
  }

  /* 2 — THE INVARIANT: replay must not credit again */
  {
    const store = {}; seedOrder(store, 'O2', 'HELD');
    const db = makeDb(store);
    await OS.settleOrder(db, adminSdk, 'O2');
    const after1 = balanceOf(store);
    /* A trigger retry re-runs the whole handler against the stored order. */
    const r2 = await OS.settleOrder(db, adminSdk, 'O2');
    ck('P3   REPLAY of the same settlement does not credit twice',
      balanceOf(store) === after1,
      'after first=' + after1 + ' after replay=' + balanceOf(store)
      + ' outcome=' + r2.outcome);
    ck('P4   replay leaves exactly one wallet transaction and one settlement',
      countAt(store, 'walletTransactions/') === 1 && countAt(store, 'settlements/') === 1,
      'walletTx=' + countAt(store, 'walletTransactions/')
      + ' settlements=' + countAt(store, 'settlements/'));
  }

  /* 3 — THE PRODUCTION STATE: lowercase "settled" + completed */
  {
    const store = {}; seedOrder(store, 'O3', 'settled');   /* as written by index.js */
    const db = makeDb(store);
    const r = await OS.settleOrder(db, adminSdk, 'O3');
    ck('P5   lowercase "settled" is recognised as already-settled',
      r.outcome === 'already-settled' && balanceOf(store) === 0,
      'outcome=' + r.outcome + ' balance=' + balanceOf(store)
      + '   (7 production orders carry this exact value)');
  }

  /* 4 — CONTROL: the canonical uppercase state must still block */
  {
    const store = {}; seedOrder(store, 'O4', 'SETTLED');
    const db = makeDb(store);
    const r = await OS.settleOrder(db, adminSdk, 'O4');
    ck('P6   CONTROL canonical "SETTLED" still blocks',
      r.outcome === 'already-settled' && balanceOf(store) === 0,
      'outcome=' + r.outcome + ' balance=' + balanceOf(store));
  }

  /* 5 — CONTROL: a settlement record for ANOTHER order must not block this one.
     Without this, "exactly once" could be satisfied by a guard that blocks
     everything, and the harness would read green while settlement was broken. */
  {
    const store = {}; seedOrder(store, 'O5', 'HELD');
    store['settlements/SOMEONE_ELSE'] = { orderId: 'SOMEONE_ELSE' };
    const db = makeDb(store);
    const r = await OS.settleOrder(db, adminSdk, 'O5');
    ck('P7   CONTROL another order\'s settlement record does not block this one',
      r.outcome === 'settled' && balanceOf(store) === 90,
      'outcome=' + r.outcome + ' balance=' + balanceOf(store));
  }

  /* 6 — CONTROL: a genuinely unsettled order still settles (the harness can see success) */
  {
    const store = {}; seedOrder(store, 'O6', 'ELIGIBLE_FOR_SETTLEMENT');
    const db = makeDb(store);
    const r = await OS.settleOrder(db, adminSdk, 'O6');
    ck('P8   CONTROL an eligible order settles normally',
      r.outcome === 'settled' && balanceOf(store) === 90,
      'outcome=' + r.outcome + ' balance=' + balanceOf(store));
  }

  /* 7 — the RECORD guard must work INDEPENDENTLY of the state string.
     Without this row, every result above could be carried by the case fix alone and
     the exactly-once boundary would be untested. Here the state says HELD — a
     perfectly settleable state under either spelling — and only the existence of
     settlements/{orderId} may block it. */
  {
    const store = {}; seedOrder(store, 'O7', 'HELD');
    store['settlements/O7'] = { orderId: 'O7', sellerId: SELLER };
    const db = makeDb(store);
    const r = await OS.settleOrder(db, adminSdk, 'O7');
    ck('P9   the settlement RECORD blocks a credit even when the state says HELD',
      r.outcome === 'already-settled' && balanceOf(store) === 0,
      'outcome=' + r.outcome + ' balance=' + balanceOf(store)
      + '   (state was HELD; only settlements/O7 stood in the way)');
  }

  const passed = rows.filter((r) => r.ok).length;
  console.log('\n  SETTLEMENT EXACTLY-ONCE PROOF\n');
  for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
  console.log('\n  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
  console.log('\n  Fakes record every write; the invariant asserted is the WALLET BALANCE,');
  console.log('  not the state string. Deterministic ids already protect the other three');
  console.log('  documents — increment is the one write a replay can double.\n');
  process.exit(passed === rows.length ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILED:', e.stack || e.message); process.exit(2); });
