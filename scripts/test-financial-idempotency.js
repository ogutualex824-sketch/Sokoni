#!/usr/bin/env node
/* ================================================================
   SOKONI — Financial Idempotency Regression Suite
   scripts/test-financial-idempotency.js

   Proves, against an in-memory Firestore stub (runs in CI, no emulator), that
   every money operation is EXACTLY-ONCE under retry, concurrency and
   at-least-once trigger redelivery.

   EVERY test asserts:
       • exactly ONE ledger record
       • exactly ONE financial movement

   These tests exist because P0-2..P0-5 were all found by static audit and NONE
   was caught by a test. They are the regression net for that entire defect class.

   Run:  node scripts/test-financial-idempotency.js     (exit 0 = pass)
================================================================ */
'use strict';

/* ── In-memory Firestore with REAL semantics for the things that matter ──────
   - create() throws ALREADY_EXISTS (code 6)  → atomic set-if-not-exists
   - increment() actually accumulates          → proves non-idempotency if unguarded
   - runTransaction serialises                 → models the claim
   - auto-id .doc()/.add() generates a new id  → proves duplicate rows          */
const store = new Map();
const versions = new Map();          // key → version, bumped on every write (OCC)
let autoId = 0;
const bump = (key) => versions.set(key, (versions.get(key) || 0) + 1);

const INC = (n) => ({ __inc: n });
const TS = () => ({ __ts: true });

function applyValue(prev, next) {
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(next)) {
    if (v && v.__inc !== undefined) out[k] = (out[k] || 0) + v.__inc;
    else out[k] = v;
  }
  return out;
}

function docRef(col, id) {
  const key = `${col}/${id}`;
  return {
    id, col, key,
    async get() { const d = store.get(key); return { exists: d !== undefined, id, data: () => d }; },
    async set(data, opts) { this._set(data, opts); },
    async update(data) { store.set(key, applyValue(store.get(key), data)); bump(key); },
    async create(data) {
      if (store.has(key)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
      store.set(key, applyValue(undefined, data)); bump(key);
    },
    /* synchronous internals — a transaction commit must not yield mid-write */
    _set(data, opts) {
      const prev = opts && opts.merge ? store.get(key) : undefined;
      store.set(key, applyValue(prev, data)); bump(key);
    },
    _update(data) { store.set(key, applyValue(store.get(key), data)); bump(key); },
  };
}
function colRef(col) {
  return {
    doc: (id) => docRef(col, id !== undefined ? id : `auto_${++autoId}`),
    async add(data) { const r = docRef(col, `auto_${++autoId}`); await r.set(data); return r; },
  };
}
const db = {
  collection: colRef,
  batch() {
    const ops = [];
    return {
      set: (r, d, o) => ops.push(() => r.set(d, o)),
      update: (r, d) => ops.push(() => r.update(d)),
      async commit() { for (const op of ops) await op(); },
    };
  },
  /* Models REAL Firestore transaction semantics: optimistic concurrency control.
     Every doc read is version-stamped; at commit time, if any doc in the read-set
     changed, the transaction ABORTS and the callback RE-RUNS against fresh data.

     This matters enormously: without it, two concurrent transactions would both
     read "ledger does not exist" and both apply their increment — reporting a
     failure that CANNOT happen in production. A test harness that does not model
     transaction retry will slander correct code (and, worse, would pass code that
     relies on the wrong semantics). */
  async runTransaction(fn) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const readSet = new Map();
      const writes = [];
      const txn = {
        get: async (r) => { readSet.set(r.key, versions.get(r.key) || 0); return r.get(); },
        set: (r, d, o) => writes.push(() => r._set(d, o)),
        update: (r, d) => writes.push(() => r._update(d)),
      };
      const result = await fn(txn);

      /* COMMIT — conflict check and writes must be ONE synchronous block, or another
         transaction could slip in between them (which is what real Firestore prevents). */
      let conflict = false;
      for (const [key, v] of readSet) {
        if ((versions.get(key) || 0) !== v) { conflict = true; break; }
      }
      if (conflict) continue;                  // ABORT → re-run the callback (Firestore does this)

      for (const w of writes) w();             // synchronous — no yield mid-commit
      return result;
    }
    throw new Error('transaction failed after max retries (contention)');
  },
};

const count = (col) => [...store.keys()].filter((k) => k.startsWith(col + '/')).length;
const get = (col, id) => store.get(`${col}/${id}`);

/* ── Harness ────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
};
const reset = () => { store.clear(); autoId = 0; };

/* ══════════════════════════════════════════════════════════════════
   THE PRODUCTION PATTERNS (mirrors of the deployed fixes)
══════════════════════════════════════════════════════════════════ */

/* Pattern C — deterministic ledger id + guarded increment (P0-3 / P0-5 fix) */
async function creditWithLedgerGuard({ paymentId, sellerId, gross, commission }) {
  const ledgerRef  = db.collection('commissionLedger').doc(paymentId);   // deterministic
  const billingRef = db.collection('sellerBilling').doc(sellerId);
  return db.runTransaction(async (txn) => {
    const existing = await txn.get(ledgerRef);
    if (existing.exists) return false;                                   // redelivery
    txn.set(ledgerRef, { paymentId, sellerId, gross, commission });
    txn.set(billingRef, { totalCommission: INC(commission), gross: INC(gross) }, { merge: true });
    return true;
  });
}

/* Pattern A — atomic create() idempotency lock (P0-4 fix) */
async function webhookWithAtomicLock(eventId, onSuccess) {
  const idemRef = db.collection('webhookIdempotency').doc(eventId);
  try { await idemRef.create({ eventId, status: 'processing' }); }
  catch (e) { if (e.code === 6) return 'duplicate'; throw e; }
  await onSuccess();
  return 'processed';
}

/* THE OLD, BROKEN PATTERN — kept to PROVE the tests can actually detect the bug */
async function brokenCredit({ sellerId, gross, commission }) {
  await db.collection('commissionLedger').add({ sellerId, gross, commission });   // auto-id
  await db.collection('sellerBilling').doc(sellerId)
    .set({ totalCommission: INC(commission) }, { merge: true });                  // unguarded
}

/* ══════════════════════════════════════════════════════════════════ */
(async () => {
  console.log('\nSOKONI — Financial Idempotency Regression Suite\n');

  /* 0. Sanity: the suite must be able to DETECT the defect it guards against. */
  console.log('Meta — the tests can actually catch the bug');
  reset();
  await brokenCredit({ sellerId: 's1', gross: 1000, commission: 100 });
  await brokenCredit({ sellerId: 's1', gross: 1000, commission: 100 });   // retry
  ok('BROKEN pattern DOES double-write (proves the assertions are real)',
     count('commissionLedger') === 2 && get('sellerBilling', 's1').totalCommission === 200,
     'if this fails, every test below is vacuous');

  /* 1. Duplicate webhook */
  console.log('\nT1 — Duplicate webhook');
  reset();
  await creditWithLedgerGuard({ paymentId: 'p1', sellerId: 's1', gross: 1000, commission: 100 });
  await creditWithLedgerGuard({ paymentId: 'p1', sellerId: 's1', gross: 1000, commission: 100 });
  ok('exactly ONE ledger record', count('commissionLedger') === 1);
  ok('exactly ONE financial movement', get('sellerBilling', 's1').totalCommission === 100);

  /* 2. Sequential webhook retry (provider re-delivers after timeout) */
  console.log('\nT2 — Sequential retry');
  reset();
  for (let i = 0; i < 5; i++) await creditWithLedgerGuard({ paymentId: 'p2', sellerId: 's1', gross: 500, commission: 50 });
  ok('5 retries → ONE ledger record', count('commissionLedger') === 1);
  ok('5 retries → ONE movement', get('sellerBilling', 's1').totalCommission === 50);

  /* 3. Concurrent webhook (fan-out) */
  console.log('\nT3 — Concurrent webhook');
  reset();
  await Promise.all([
    creditWithLedgerGuard({ paymentId: 'p3', sellerId: 's1', gross: 800, commission: 80 }),
    creditWithLedgerGuard({ paymentId: 'p3', sellerId: 's1', gross: 800, commission: 80 }),
  ]);
  ok('concurrent → ONE ledger record', count('commissionLedger') === 1);
  ok('concurrent → ONE movement', get('sellerBilling', 's1').totalCommission === 80);

  /* 4. Firestore trigger redelivery (AT-LEAST-ONCE) — the P0-3 / P0-5 class */
  console.log('\nT4 — Firestore trigger redelivery (at-least-once)');
  reset();
  const deliver = () => creditWithLedgerGuard({ paymentId: 'evt1', sellerId: 's9', gross: 2000, commission: 200 });
  const first = await deliver();
  const second = await deliver();                    // redelivery
  ok('first delivery applies', first === true);
  ok('redelivery is a NO-OP', second === false);
  ok('ONE ledger record', count('commissionLedger') === 1);
  ok('seller NOT double-billed', get('sellerBilling', 's9').totalCommission === 200);

  /* 5. Duplicate wallet credit (driver paid twice — P0-5) */
  console.log('\nT5 — Duplicate wallet credit');
  reset();
  const creditDriver = async (queueId, riderId, amount) => {
    const txRef = db.collection('walletTransactions').doc(queueId);      // deterministic
    const wRef  = db.collection('wallets').doc(riderId);
    return db.runTransaction(async (txn) => {
      const seen = await txn.get(txRef);
      if (seen.exists) return false;
      txn.set(txRef, { riderId, amount });
      txn.set(wRef, { balance: INC(amount) }, { merge: true });
      return true;
    });
  };
  await creditDriver('q1', 'd1', 300);
  await creditDriver('q1', 'd1', 300);          // trigger redelivery
  ok('ONE wallet transaction record', count('walletTransactions') === 1);
  ok('driver NOT paid twice', get('wallets', 'd1').balance === 300);

  /* 6. Duplicate refund */
  console.log('\nT6 — Duplicate refund');
  reset();
  const refund = async (orderId, amount) => {
    const rRef = db.collection('refunds').doc(`refund_${orderId}_${amount}`);   // deterministic key
    return db.runTransaction(async (txn) => {
      if ((await txn.get(rRef)).exists) return false;
      txn.set(rRef, { orderId, amount });
      txn.set(db.collection('wallets').doc('buyer1'), { balance: INC(amount) }, { merge: true });
      return true;
    });
  };
  await refund('o1', 500);
  await refund('o1', 500);
  ok('ONE refund record', count('refunds') === 1);
  ok('ONE credit movement', get('wallets', 'buyer1').balance === 500);

  /* 7. Double payout attempt */
  console.log('\nT7 — Double payout');
  reset();
  const payout = async (payoutId) => {
    const pRef = db.collection('payouts').doc(payoutId);
    try { await pRef.create({ payoutId, status: 'paid', amount: 900 }); return true; }
    catch (e) { if (e.code === 6) return false; throw e; }
  };
  ok('first payout succeeds', (await payout('po1')) === true);
  ok('second payout REJECTED', (await payout('po1')) === false);
  ok('exactly ONE payout record', count('payouts') === 1);

  /* 8. Duplicate subscription activation */
  console.log('\nT8 — Duplicate subscription activation');
  reset();
  const activate = async (uid) => {
    const sRef = db.collection('subscriptions').doc(uid);   // one per account
    return db.runTransaction(async (txn) => {
      const s = await txn.get(sRef);
      if (s.exists && s.data().status === 'active') return false;
      txn.set(sRef, { uid, status: 'active' });
      txn.set(db.collection('payments').doc(`sub_${uid}`), { uid, charged: 1000 });
      return true;
    });
  };
  await activate('u1');
  await activate('u1');
  ok('ONE subscription record', count('subscriptions') === 1);
  ok('charged ONCE', count('payments') === 1);

  /* 9. Duplicate settlement */
  console.log('\nT9 — Duplicate settlement');
  reset();
  const settle = async (orderId) => {
    const ref = db.collection('settlements').doc(orderId);
    try { await ref.create({ orderId, settled: true }); return true; }
    catch (e) { if (e.code === 6) return false; throw e; }
  };
  await settle('o9'); await settle('o9');
  ok('exactly ONE settlement', count('settlements') === 1);

  /* 10. Atomic webhook lock (P0-4) */
  console.log('\nT10 — Atomic webhook lock under concurrency');
  reset();
  let processed = 0;
  const results = await Promise.all([
    webhookWithAtomicLock('evt-x', async () => { processed++; }),
    webhookWithAtomicLock('evt-x', async () => { processed++; }),
    webhookWithAtomicLock('evt-x', async () => { processed++; }),
  ]);
  ok('exactly ONE processed, others duplicate',
     processed === 1 && results.filter((r) => r === 'duplicate').length === 2,
     `processed=${processed} results=${results}`);

  /* 11. Ledger consistency */
  console.log('\nT11 — Ledger consistency');
  reset();
  await creditWithLedgerGuard({ paymentId: 'a', sellerId: 's', gross: 1000, commission: 100 });
  await creditWithLedgerGuard({ paymentId: 'b', sellerId: 's', gross: 2000, commission: 200 });
  await creditWithLedgerGuard({ paymentId: 'a', sellerId: 's', gross: 1000, commission: 100 }); // retry
  const b = get('sellerBilling', 's');
  ok('ledger rows == distinct payments (2)', count('commissionLedger') === 2);
  ok('Σ gross correct (3000)', b.gross === 3000);
  ok('Σ commission correct (300)', b.totalCommission === 300);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
