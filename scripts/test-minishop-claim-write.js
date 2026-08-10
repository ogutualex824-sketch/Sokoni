#!/usr/bin/env node
'use strict';

/**
 * claimMinishopHandle — the WRITE half of the claim contract.
 *
 *   node scripts/test-minishop-claim-write.js
 *
 * The resolver test (test-minishop-claim-persistence.js) proves a claim already in Firestore
 * survives a reload. This proves the claim GETS there — and that the shapes the resolver reads
 * are the shapes the claim writes. A resolver and a writer that each pass alone but disagree on
 * where the claim lives is exactly the failure that sent a claimed seller back to the claim
 * screen.
 *
 * Four properties, all of them things that have gone wrong in this codebase:
 *   1. Claiming NEVER creates a shop. Ownership is shops/{shopId}.sellerUid, decided elsewhere;
 *      a claim that minted a shop would split the seller's products, orders and settlement
 *      across two identities.
 *   2. No fake success. A refused claim throws — it never returns {success:true}, and it leaves
 *      no partial write behind for the resolver to find.
 *   3. Idempotent. Re-claiming the same handle succeeds without duplicating or repointing, and
 *      repairs a config whose handle went missing.
 *   4. It cannot steal another seller's handle, including under a concurrent claim. The old code
 *      read shopHandles/{handle} and then committed a batch; two sellers could both pass that
 *      read and the second `set` silently overwrote the first.
 *
 * Firestore is a fake with REAL optimistic-concurrency semantics: documents carry versions,
 * transactions record what they read, and a commit whose read-set changed underneath re-runs the
 * transaction body. That is what makes property 4 testable without an emulator — the interleaving
 * is forced, not hoped for.
 */

const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : '')); }
};
const group = (n) => console.log('\n' + n);

/* ── A Firestore fake with versioned docs and retrying transactions ───────────── */
function makeDb() {
  const store = new Map();                 // "col/id" -> { data, version }
  let writes = 0;
  const key = (c, i) => c + '/' + i;

  const api = {
    /** Test-side seeding/inspection — not part of the surface minishop.js uses. */
    _seed (col, id, data) { store.set(key(col, id), { data: Object.assign({}, data), version: 1 }); },
    _raw (col, id) { const e = store.get(key(col, id)); return e ? e.data : null; },
    _has (col, id) { return store.has(key(col, id)); },
    _ids (col) { return [...store.keys()].filter((k) => k.startsWith(col + '/')).map((k) => k.slice(col.length + 1)); },
    _writes () { return writes; },
    /** Hook fired once, between a transaction's read and its commit. */
    _interleave: null,

    collection (col) {
      const q = { col, filters: [], lim: 0 };
      const chain = {
        doc: (id) => ({ __ref: true, col, id }),
        where (f, op, v) { q.filters.push({ f, op, v }); return chain; },
        limit (n) { q.lim = n; return chain; },
        async get () {
          let docs = [...store.entries()]
            .filter(([k]) => k.startsWith(col + '/'))
            .filter(([, e]) => q.filters.every((fl) => fl.op === '==' && e.data[fl.f] === fl.v))
            .map(([k, e]) => ({ id: k.slice(col.length + 1), exists: true, data: () => e.data }));
          if (q.lim) docs = docs.slice(0, q.lim);
          return { empty: docs.length === 0, docs, size: docs.length };
        },
      };
      return chain;
    },

    async runTransaction (fn) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const readSet = new Map();
        const staged = [];
        const tx = {
          async get (ref) {
            const e = store.get(key(ref.col, ref.id));
            readSet.set(key(ref.col, ref.id), e ? e.version : 0);
            return { exists: !!e, id: ref.id, data: () => (e ? e.data : undefined) };
          },
          set (ref, data, opts) { staged.push({ ref, data, merge: !!(opts && opts.merge) }); },
          update (ref, data) { staged.push({ ref, data, merge: true }); },
        };

        const result = await fn(tx);          // an HttpsError here propagates — correct

        if (api._interleave) { const h = api._interleave; api._interleave = null; h(api); }

        /* Commit only if nothing we read has moved. */
        let stale = false;
        for (const [k, v] of readSet) {
          const e = store.get(k);
          if ((e ? e.version : 0) !== v) { stale = true; break; }
        }
        if (stale) continue;                  // re-run the body, as Firestore does

        for (const w of staged) {
          const k = key(w.ref.col, w.ref.id);
          const prev = store.get(k);
          store.set(k, {
            data: w.merge && prev ? Object.assign({}, prev.data, w.data) : Object.assign({}, w.data),
            version: (prev ? prev.version : 0) + 1,
          });
          writes++;
        }
        return result;
      }
      throw new Error('transaction exhausted retries');
    },
  };
  return api;
}

/* ── Load minishop.js against the fake, before it can reach the real admin SDK ── */
const DB = makeDb();
const fsPath = require.resolve('firebase-admin/firestore', { paths: [path.join(__dirname, '..', 'functions')] });
require.cache[fsPath] = {
  id: fsPath, filename: fsPath, loaded: true, children: [], paths: [], exports: {
    getFirestore: () => DB,
    FieldValue: { serverTimestamp: () => '__TS__', increment: (n) => ({ __inc: n }), arrayUnion: (...a) => a },
    Timestamp: { now: () => ({ toMillis: () => 0 }) },
  },
};

const minishop = require('../functions/minishop');
const call = (uid, data) => minishop.claimMinishopHandle.run({ auth: uid ? { uid } : null, data });
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };

const SELLER = 'seller-A';
const OTHER  = 'seller-B';

(async () => {
  console.log('\nclaimMinishopHandle — the claim WRITE path');
  console.log('='.repeat(66));

  /* ── 1. A claim never creates a shop ── */
  group('1. Claiming does not create a shop');
  {
    const err = await caught(call('seller-with-no-shop', { handle: 'ghostshop' }));
    ok('refuses when no shop names this uid', err && err.code === 'not-found', err && (err.code + ' ' + err.message));
    ok('created no shop document', DB._ids('shops').length === 0, DB._ids('shops'));
    ok('reserved no handle', !DB._has('shopHandles', 'ghostshop'));
    ok('wrote no config', !DB._has('minishopConfig', 'ghostshop'));
  }

  /* ── 2. A real claim writes exactly what the resolver reads ── */
  group('2. A claim persists where the resolver looks');
  DB._seed('shops', 'shop-A', { sellerUid: SELLER, name: 'KASS SHOP' });
  DB._seed('shops', 'shop-B', { sellerUid: OTHER,  name: 'Other Shop' });
  {
    const res = await call(SELLER, { handle: 'KassShop' });     // mixed case on purpose
    ok('returns success', res && res.success === true, res);
    ok('normalises the handle to lowercase', res.handle === 'kassshop', res.handle);
    ok('returns the canonical shopId', res.shopId === 'shop-A', res.shopId);
    ok('returns the owner uid', res.ownerUid === SELLER, res.ownerUid);

    const h = DB._raw('shopHandles', 'kassshop');
    ok('shopHandles/{handle} records the owner uid', h && h.uid === SELLER, h);
    ok('shopHandles/{handle} points at the seller\'s existing shop', h && h.shopId === 'shop-A', h);

    const cfg = DB._raw('minishopConfig', 'shop-A');
    ok('minishopConfig/{shopId} carries the handle', cfg && cfg.handle === 'kassshop', cfg);
    ok('minishopConfig/{shopId} carries ownership', cfg && cfg.ownerUid === SELLER, cfg);
    ok('still exactly two shops — none minted', DB._ids('shops').length === 2, DB._ids('shops'));
  }

  /* ── 3. Idempotence and repair ── */
  group('3. Re-claiming is idempotent, and repairs a lost config');
  {
    const before = DB._raw('shopHandles', 'kassshop');
    const res = await call(SELLER, { handle: 'kassshop' });
    ok('re-claim succeeds', res && res.success === true, res);
    ok('handle doc still points at the same shop', DB._raw('shopHandles', 'kassshop').shopId === before.shopId);
    ok('no duplicate handle document', DB._ids('shopHandles').length === 1, DB._ids('shopHandles'));

    /* A claim whose handle doc landed but whose config write did not: the old early-return
       reported "already yours" forever while the storefront resolver found no handle. */
    DB._seed('minishopConfig', 'shop-A', { brandColor: '#71ff00' });    // handle wiped
    await call(SELLER, { handle: 'kassshop' });
    const cfg = DB._raw('minishopConfig', 'shop-A');
    ok('re-claim restores a missing config handle', cfg && cfg.handle === 'kassshop', cfg);
    ok('re-claim preserves unrelated config fields', cfg && cfg.brandColor === '#71ff00', cfg);
  }

  /* ── 4. It cannot take a handle that is not yours ── */
  group('4. Another seller\'s handle is not available');
  {
    const err = await caught(call(OTHER, { handle: 'kassshop' }));
    ok('refuses a handle owned by someone else', err && err.code === 'already-exists', err && err.code);
    ok('the handle still belongs to the original owner', DB._raw('shopHandles', 'kassshop').uid === SELLER);
    ok('the handle still points at the original shop', DB._raw('shopHandles', 'kassshop').shopId === 'shop-A');
    ok('no config was written for the loser', !DB._raw('minishopConfig', 'shop-B'), DB._raw('minishopConfig', 'shop-B'));
  }

  /* ── 5. THE RACE: a competing claim lands between read and commit ── */
  group('5. Concurrent claim — the loser is refused, not silently overwritten');
  {
    /* seller-B claims a free handle; between B's read and B's commit, seller-A takes it.
       Under the old read-then-batch code B's `set` would overwrite A's and BOTH would report
       success. With a transaction, B's read-set is stale, the body re-runs, and B now sees A's
       document and is refused. */
    DB._interleave = (db) => {
      db._seed('shopHandles', 'contested', { shopId: 'shop-A', uid: SELLER, handle: 'contested' });
    };
    const err = await caught(call(OTHER, { handle: 'contested' }));
    ok('the racing claim is refused', err && err.code === 'already-exists', err && (err.code + ' ' + err.message));
    ok('the winner keeps the handle', DB._raw('shopHandles', 'contested').uid === SELLER, DB._raw('shopHandles', 'contested'));
    ok('the loser got no config pointing at the contested handle',
       (DB._raw('minishopConfig', 'shop-B') || {}).handle !== 'contested', DB._raw('minishopConfig', 'shop-B'));
  }

  /* ── 6. Validation still refuses without touching Firestore ── */
  group('6. Rejected input writes nothing');
  {
    const w0 = DB._writes();
    for (const [h, why] of [['ab', 'too short'], ['Has Space', 'illegal characters'],
                            ['admin', 'reserved'], ['a'.repeat(31), 'too long']]) {
      const err = await caught(call(SELLER, { handle: h }));
      ok('refuses "' + h.slice(0, 12) + '" (' + why + ')', err && err.code === 'invalid-argument', err && err.code);
    }
    const err = await caught(call(null, { handle: 'anything' }));
    ok('refuses an unauthenticated caller', err && err.code === 'unauthenticated', err && err.code);
    ok('none of the refusals wrote to Firestore', DB._writes() === w0, DB._writes() - w0);
  }

  console.log('\n' + '='.repeat(66));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('\n  SCOPE: exercises the real claimMinishopHandle handler against a Firestore fake');
  console.log('         with versioned optimistic concurrency. NOT VERIFIED here: security rules');
  console.log('         and real Firestore transaction contention — those need the emulator.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
