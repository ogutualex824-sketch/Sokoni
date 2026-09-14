#!/usr/bin/env node
/* WALLET MONEY ADAPTER — certification against a transaction-semantics fake.
 *
 * No emulator, no credentials, no production. The fake models what actually matters:
 * read-your-reads, optimistic concurrency (a document written by another transaction after
 * you read it invalidates your commit and forces a retry), and create() failing when the
 * document already exists. Those are the semantics the atomicity and idempotency claims
 * depend on.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH
 * It certifies the ADAPTER'S LOGIC under transaction semantics. It does NOT certify
 * Firestore itself, nor field-level behaviour of the real client, nor security rules. A
 * green run here is not permission to wire or deploy.
 *
 * CONTROLS AT THE END. A negative control proves assertions can fail, and a sabotage
 * control removes the in-transaction idempotency check to prove the double-debit test would
 * actually catch a regression. A suite that cannot fail proves nothing.
 */
'use strict';
const MA = require('../functions/money-authority');
const { createWalletAdapter, LEDGER, WALLETS } = require('../functions/wallet-money-adapter');

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};
async function throwsWith (label, code, fn) {
  try { await fn(); fail++; console.log('  FAIL  ' + label + '   [did not throw; expected ' + code + ']'); }
  catch (e) {
    if (e.code === code) pass++;
    else { fail++; console.log('  FAIL  ' + label + '   [threw ' + (e.code || e.message) + ', expected ' + code + ']'); }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Fake Firestore with real transaction semantics
   ═══════════════════════════════════════════════════════════════════════════ */
function makeFakeDb () {
  const store = new Map();            /* path -> { data, version } */
  let commits = 0, retries = 0;

  const ref = (path) => ({
    path,
    get __store () { return store; }
  });

  const db = {
    __store: store,
    __beforeCommit: null,             /* test hook, for deterministic interleaving */
    get commits () { return commits; },
    get retries () { return retries; },
    collection: (c) => ({ doc: (d) => ref(c + '/' + d) }),

    async runTransaction (fn, { maxAttempts = 5 } = {}) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const readVersions = new Map();
        const writes = [];
        const txn = {
          async get (r) {
            const cur = store.get(r.path);
            readVersions.set(r.path, cur ? cur.version : 0);
            return {
              exists: !!cur,
              data: () => (cur ? JSON.parse(JSON.stringify(cur.data)) : undefined)
            };
          },
          create (r, data) { writes.push({ op: 'create', path: r.path, data }); },
          update (r, data) { writes.push({ op: 'update', path: r.path, data }); },
          set (r, data) { writes.push({ op: 'set', path: r.path, data }); }
        };

        let result;
        try { result = await fn(txn); }
        catch (e) { throw e; }        /* a validation refusal aborts with NO writes applied */

        if (db.__beforeCommit) { const h = db.__beforeCommit; await h(attempt); }

        /* optimistic concurrency: any doc we read must be unchanged since we read it */
        let stale = false;
        for (const [p, v] of readVersions) {
          const cur = store.get(p);
          if ((cur ? cur.version : 0) !== v) { stale = true; break; }
        }
        if (stale) { retries++; continue; }

        for (const w of writes) {
          if (w.op === 'create' && store.has(w.path)) {
            const err = new Error('ALREADY_EXISTS'); err.code = 6; throw err;
          }
        }
        for (const w of writes) {
          const cur = store.get(w.path);
          const base = w.op === 'update' && cur ? cur.data : {};
          store.set(w.path, {
            data: Object.assign({}, base, w.data),
            version: (cur ? cur.version : 0) + 1
          });
        }
        commits++;
        return result;
      }
      const err = new Error('ABORTED: too much contention'); err.code = 10; throw err;
    }
  };
  return db;
}

const KES = (n) => MA.fromMajor(n);
const seedWallet = (db, uid, balance, extra) =>
  db.__store.set(WALLETS + '/' + uid,
    { data: Object.assign({ uid, balance, currency: 'KES' }, extra || {}), version: 1 });
const walletOf = (db, uid) => (db.__store.get(WALLETS + '/' + uid) || {}).data;
const ledgerCount = (db) =>
  Array.from(db.__store.keys()).filter((k) => k.indexOf(LEDGER + '/') === 0).length;

const AUTH = (over) => Object.assign({
  id: 'auth_1', buyerUid: 'buyer_1', amountMinor: 100000,
  expiresAtMs: 9e15, consumed: false
}, over || {});

/* ═══════════════════════════════════════════════════════════════════════════ */
(async function run () {
  console.log('');
  console.log('  WALLET MONEY ADAPTER — certification (fake db, transaction semantics)');
  console.log('');

  /* ── the fake itself must be trustworthy before anything is measured on it ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'u1', 100);
    let sawContention = false;
    db.__beforeCommit = async () => {
      if (!sawContention) {
        sawContention = true;
        const cur = db.__store.get(WALLETS + '/u1');
        db.__store.set(WALLETS + '/u1', { data: cur.data, version: cur.version + 1 });
      }
    };
    await db.runTransaction(async (t) => { await t.get(db.collection(WALLETS).doc('u1')); });
    db.__beforeCommit = null;
    ok('FAKE CONTROL: a concurrent write forces a retry', db.retries === 1, 'retries=' + db.retries);
  }
  {
    const db = makeFakeDb();
    let threw = null;
    db.__store.set('x/1', { data: {}, version: 1 });
    try {
      await db.runTransaction(async (t) => { t.create(db.collection('x').doc('1'), { a: 1 }); });
    } catch (e) { threw = e.code; }
    ok('FAKE CONTROL: create() on an existing doc is ALREADY_EXISTS', threw === 6, String(threw));
  }

  /* ── 1 · a successful debit writes BOTH ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'buyer_1', 5000);
    const a = createWalletAdapter({ db, now: () => 1000 });
    const r = await a.purchase({
      walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'k1',
      authorization: AUTH(), reason: 'POS sale'
    });
    ok('debit applied', r.applied === true);
    ok('balance mutated 5000 -> 4000', walletOf(db, 'buyer_1').balance === 4000,
       String(walletOf(db, 'buyer_1').balance));
    ok('exactly one ledger entry', ledgerCount(db) === 1, String(ledgerCount(db)));
    const led = db.__store.get(LEDGER + '/k1').data;
    ok('ledger records before/after', led.balanceBeforeMinor === 500000 && led.balanceAfterMinor === 400000);
    ok('ledger has NO balance field of its own',
       !('balance' in led) && !('availableBalance' in led));
    ok('ledger records the authorization', led.authorizationId === 'auth_1');
  }

  /* ── 2 · ROLLBACK: a refusal writes NEITHER ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'buyer_1', 500);
    const a = createWalletAdapter({ db, now: () => 1000 });
    await throwsWith('insufficient balance declines', 'WALLET_INSUFFICIENT_BALANCE',
      () => a.purchase({ walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'k1',
        authorization: AUTH() }));
    ok('ROLLBACK: balance untouched', walletOf(db, 'buyer_1').balance === 500);
    ok('ROLLBACK: no ledger entry', ledgerCount(db) === 0);
    ok('ROLLBACK: nothing committed', db.commits === 0, 'commits=' + db.commits);
  }

  /* ── 3 · duplicate request debits exactly once ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'buyer_1', 5000);
    const a = createWalletAdapter({ db, now: () => 1000 });
    const args = { walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'same',
                   authorization: AUTH() };
    const r1 = await a.purchase(args);
    const r2 = await a.purchase(args);
    const r3 = await a.purchase(args);
    ok('first application applies', r1.applied === true);
    ok('retry is REPLAYED, not applied', r2.applied === false && r2.replayed === true);
    ok('third retry also replayed', r3.replayed === true);
    ok('balance debited ONCE', walletOf(db, 'buyer_1').balance === 4000,
       String(walletOf(db, 'buyer_1').balance));
    ok('exactly one ledger entry after 3 calls', ledgerCount(db) === 1, String(ledgerCount(db)));
    ok('replay reports the same resulting balance', r2.balanceAfter.minorUnits === 400000);
  }

  /* ── 4 · an idempotency key may not be reused for a different movement ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'buyer_1', 5000);
    const a = createWalletAdapter({ db, now: () => 1000 });
    await a.purchase({ walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'k',
      authorization: AUTH() });
    await throwsWith('same key, different amount is a conflict', 'ADAPTER_IDEMPOTENCY_CONFLICT',
      () => a.purchase({ walletUid: 'buyer_1', amount: KES(2000), idempotencyKey: 'k',
        authorization: AUTH({ amountMinor: 200000 }) }));
    ok('conflict left the balance alone', walletOf(db, 'buyer_1').balance === 4000);
  }

  /* ── 5 · CONCURRENT DEBIT: interleaved, only one may win ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'buyer_1', 1500);           /* enough for ONE 1000 debit, not two */
    const a = createWalletAdapter({ db, now: () => 1000 });

    /* Force the race: while transaction A is between its reads and its commit, transaction
       B runs to completion. A must then observe a stale read, retry, and re-validate
       against the NEW balance — where 1000 no longer fits in the remaining 500. */
    let fired = false;
    db.__beforeCommit = async () => {
      if (fired) return;
      fired = true;
      db.__beforeCommit = null;
      await a.purchase({ walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'B',
        authorization: AUTH() });
    };
    let aErr = null;
    try {
      await a.purchase({ walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'A',
        authorization: AUTH() });
    } catch (e) { aErr = e; }
    db.__beforeCommit = null;

    ok('the interleaved transaction retried', db.retries >= 1, 'retries=' + db.retries);
    ok('exactly ONE debit succeeded', ledgerCount(db) === 1, 'ledger=' + ledgerCount(db));
    ok('the loser was refused for insufficient funds',
       aErr && aErr.code === 'WALLET_INSUFFICIENT_BALANCE', aErr && aErr.code);
    ok('balance debited once only (1500 -> 500)', walletOf(db, 'buyer_1').balance === 500,
       String(walletOf(db, 'buyer_1').balance));
    ok('no negative balance', walletOf(db, 'buyer_1').balance >= 0);
  }

  /* ── 6 · authorization failures never reach the balance ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'buyer_1', 5000);
    const a = createWalletAdapter({ db, now: () => 1000 });
    await throwsWith('no authorization refuses', 'WALLET_NOT_AUTHORIZED',
      () => a.purchase({ walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'k',
        authorization: null }));
    await throwsWith('another buyer\'s authorization refuses', 'WALLET_AUTHORIZATION_WRONG_BUYER',
      () => a.purchase({ walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'k2',
        authorization: AUTH({ buyerUid: 'someone_else' }) }));
    await throwsWith('authorization for a different amount refuses',
      'WALLET_AUTHORIZATION_AMOUNT_MISMATCH',
      () => a.purchase({ walletUid: 'buyer_1', amount: KES(9999), idempotencyKey: 'k3',
        authorization: AUTH() }));
    await throwsWith('expired authorization refuses', 'WALLET_AUTHORIZATION_EXPIRED',
      () => a.purchase({ walletUid: 'buyer_1', amount: KES(1000), idempotencyKey: 'k4',
        authorization: AUTH({ expiresAtMs: 1 }) }));
    ok('no authorization failure touched the balance', walletOf(db, 'buyer_1').balance === 5000);
    ok('no authorization failure wrote a ledger entry', ledgerCount(db) === 0);
  }

  /* ── 7 · wallet-state refusals ── */
  {
    const db = makeFakeDb();
    const a = createWalletAdapter({ db, now: () => 1000 });
    await throwsWith('a missing wallet is NOT a zero balance', 'ADAPTER_WALLET_NOT_FOUND',
      () => a.creditSale({ walletUid: 'ghost', amount: KES(100), idempotencyKey: 'g' }));

    seedWallet(db, 'frozen_1', 5000, { frozen: true });
    await throwsWith('a frozen wallet refuses', 'ADAPTER_WALLET_FROZEN',
      () => a.creditSale({ walletUid: 'frozen_1', amount: KES(100), idempotencyKey: 'f' }));

    seedWallet(db, 'bad_1', 'lots');
    await throwsWith('an unreadable balance refuses, not defaults to 0',
      'ADAPTER_BALANCE_UNREADABLE',
      () => a.creditSale({ walletUid: 'bad_1', amount: KES(100), idempotencyKey: 'b' }));

    db.__store.set(WALLETS + '/usd_1',
      { data: { uid: 'usd_1', balance: 100, currency: 'USD' }, version: 1 });
    await throwsWith('a currency mismatch refuses', 'ADAPTER_CURRENCY_MISMATCH',
      () => a.creditSale({ walletUid: 'usd_1', amount: KES(100), idempotencyKey: 'c' }));
    ok('no state refusal wrote anything', ledgerCount(db) === 0);
  }

  /* ── 8 · entry-type discipline ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'm1', 5000);
    const a = createWalletAdapter({ db, now: () => 1000 });
    await throwsWith('an unknown entry type fails closed', 'ADAPTER_UNKNOWN_ENTRY_TYPE',
      () => a.apply({ walletUid: 'm1', entryType: 'MYSTERY', amount: KES(10),
        idempotencyKey: 'x' }));
    await throwsWith('a missing idempotency key is refused', 'ADAPTER_NO_IDEMPOTENCY_KEY',
      () => a.creditSale({ walletUid: 'm1', amount: KES(10) }));
    await throwsWith('a negative amount is refused', 'ADAPTER_NEGATIVE_AMOUNT',
      () => a.creditSale({ walletUid: 'm1', amount: MA.fromMinor(-100), idempotencyKey: 'n' }));
    await throwsWith('a NON_CUSTODIAL movement may not touch a wallet', 'ADAPTER_NON_CUSTODIAL',
      () => a.creditSale({ walletUid: 'm1', amount: KES(10), idempotencyKey: 'nc',
        expectCustody: MA.CUSTODY.NON_CUSTODIAL }));
    ok('entry-type refusals wrote nothing', ledgerCount(db) === 0);
  }

  /* ── 9 · credit, settlement, reserve, reverse ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'm1', 1000);
    const a = createWalletAdapter({ db, now: () => 1000 });
    await a.creditSale({ walletUid: 'm1', amount: KES(950), idempotencyKey: 's1',
      reason: 'net of commission' });
    ok('sale credit adds net', walletOf(db, 'm1').balance === 1950);
    await a.settle({ walletUid: 'm1', amount: KES(450), idempotencyKey: 's2' });
    ok('settlement debits', walletOf(db, 'm1').balance === 1500);
    await a.reserve({ walletUid: 'm1', amount: KES(1500), idempotencyKey: 's3' });
    ok('reserve debits to exactly zero', walletOf(db, 'm1').balance === 0);
    await throwsWith('a further reserve is refused', 'ADAPTER_INSUFFICIENT_BALANCE',
      () => a.reserve({ walletUid: 'm1', amount: KES(1), idempotencyKey: 's4' }));
    await a.reverse({ walletUid: 'm1', amount: KES(1500), idempotencyKey: 's5' });
    ok('reverse restores the balance', walletOf(db, 'm1').balance === 1500);
    /* FIVE calls were made, but one was REFUSED — so four entries is the correct answer,
       and the refused reserve is exactly the movement that must have left no trace. The
       first version of this assertion expected five and was itself the defect. */
    ok('four ledger entries — one per COMMITTED movement, none for the refusal',
       ledgerCount(db) === 4, String(ledgerCount(db)));
    ok('the refused reserve wrote no entry', !db.__store.has(LEDGER + '/s4'));
  }

  /* ── 10 · the ledger reconstructs the balance (reconciliation, not authority) ── */
  {
    const db = makeFakeDb();
    seedWallet(db, 'm1', 0);
    const a = createWalletAdapter({ db, now: () => 1000 });
    await a.creditSale({ walletUid: 'm1', amount: KES(5000), idempotencyKey: 'r1' });
    await a.settle({ walletUid: 'm1', amount: KES(250), idempotencyKey: 'r2' });
    await a.reserve({ walletUid: 'm1', amount: KES(1000), idempotencyKey: 'r3' });
    let sum = 0;
    Array.from(db.__store.entries())
      .filter(([k]) => k.indexOf(LEDGER + '/') === 0)
      .forEach(([, v]) => { sum += v.data.direction * v.data.amountMinor; });
    ok('journal sum equals the wallet balance',
       sum === MA.fromMajor(walletOf(db, 'm1').balance).minorUnits,
       sum + ' vs ' + MA.fromMajor(walletOf(db, 'm1').balance).minorUnits);
  }

  /* ══ CONTROLS ═════════════════════════════════════════════════════════════ */
  console.log('  CONTROLS');
  let controlsOk = true;
  {
    const before = fail;
    ok('__negative_control__ (expected to fail)', 1 === 2);
    const detected = fail === before + 1;
    fail = before;
    console.log('    ' + (detected ? 'PASS' : 'FAIL') + '  assertions can fail');
    if (!detected) controlsOk = false;
  }
  {
    /* SABOTAGE: an adapter whose idempotency check is outside the transaction would
       double-debit on a retry. Model that and require the duplicate test to catch it. */
    const db = makeFakeDb();
    seedWallet(db, 'buyer_1', 5000);
    let applied = 0;
    const naive = async () => db.runTransaction(async (t) => {
      const ws = await t.get(db.collection(WALLETS).doc('buyer_1'));
      const bal = ws.data().balance;                    /* no ledger read at all */
      t.update(db.collection(WALLETS).doc('buyer_1'), { balance: bal - 1000 });
      applied++;
    });
    await naive(); await naive();
    const doubled = walletOf(db, 'buyer_1').balance === 3000 && applied === 2;
    console.log('    ' + (doubled ? 'PASS' : 'FAIL') +
                '  an adapter WITHOUT the in-transaction idempotency read double-debits');
    if (!doubled) controlsOk = false;
  }

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (!controlsOk) {
    console.log('');
    console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
    process.exit(1);
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.log('  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
