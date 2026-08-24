#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   APPROVAL PROVISIONING — idempotency, concurrency, and failure release
   ══════════════════════════════════════════════════════════════════════════
   An approved merchant had a `sellers` record and no `businesses` record,
   because the only writer of one was the pos-setup wizard. The till asks
   `businesses where ownerId == uid`, got nothing, and told the merchant "No
   shop on this account".

   `_createBusiness` has NO guard of its own: it mints a fresh merchantId and
   commits unconditionally, so calling it twice produces two businesses for one
   merchant. Everything here exists to prove the guard around it holds.

   HOW THIS RUNS: firebase-admin is replaced in the module loader BEFORE
   business-bootstrap is required, so `const db = admin.firestore()` binds to a
   fake this file controls. The logic under test is the REAL logic — only the
   database is substituted. What is NOT proven here is Firestore's own
   transaction semantics; that needs the emulator or a real approval.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + label); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (detail ? '   [' + detail + ']' : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(74));

/* ── a Firestore fake with just enough surface ───────────────────────────── */
function makeDb() {
  const store = new Map();                       /* 'coll/id' -> data */
  const log = { sets: [], deletes: [], txAttempts: 0 };
  const key = (c, i) => c + '/' + i;

  function docRef(coll, id) {
    return {
      id, _coll: coll,
      async get() {
        const k = key(coll, id);
        return { exists: store.has(k), id, data: () => store.get(k) };
      },
      async set(v, opts) {
        const k = key(coll, id);
        store.set(k, (opts && opts.merge) ? Object.assign({}, store.get(k) || {}, v) : v);
        log.sets.push(k);
        return true;
      },
      async delete() { store.delete(key(coll, id)); log.deletes.push(key(coll, id)); return true; },
    };
  }
  function collRef(coll) {
    return {
      doc: (id) => docRef(coll, id || ('auto-' + Math.abs(hash(coll + store.size)))),
      where(field, op, val) {
        const rows = [...store.entries()]
          .filter(([k]) => k.startsWith(coll + '/'))
          .filter(([, v]) => op === '==' && v && v[field] === val)
          .map(([k, v]) => ({ id: k.slice(coll.length + 1), data: () => v }));
        const res = { limit: () => res, async get() { return { empty: rows.length === 0, docs: rows, size: rows.length }; } };
        return res;
      },
      async get() {
        const rows = [...store.entries()].filter(([k]) => k.startsWith(coll + '/'))
          .map(([k, v]) => ({ id: k.slice(coll.length + 1), data: () => v }));
        return { empty: rows.length === 0, docs: rows, size: rows.length };
      },
    };
  }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

  const db = {
    _store: store, _log: log,
    collection: collRef,
    batch() {
      const ops = [];
      return { set: (ref, v, o) => ops.push([ref, v, o]),
               update: (ref, v) => ops.push([ref, v, { merge: true }]),
               async commit() { for (const [ref, v, o] of ops) await ref.set(v, o); return true; } };
    },
    /* SERIALIZED, because Firestore transactions are serializable. Running two
       concurrently against this fake let both read an empty claim and both
       create — which measured the FAKE, not the guard. Chaining them models
       the isolation the real database provides, so the second transaction
       observes the first one's write. */
    _txChain: Promise.resolve(),
    async runTransaction(fn) {
      const run = db._txChain.then(() => db._runTx(fn));
      db._txChain = run.catch(() => {});
      return run;
    },
    async _runTx(fn) {
      log.txAttempts++;
      const t = {
        async get(ref) { return ref.get(); },
        set(ref, v, o) { return ref.set(v, o); },
        update(ref, v) { return ref.set(v, { merge: true }); },
        delete(ref) { return ref.delete(); },
      };
      return fn(t);
    },
  };
  return db;
}

/* ── load business-bootstrap against the fake ────────────────────────────── */
function loadModule(db, opts) {
  opts = opts || {};
  const fakeAdmin = {
    firestore: Object.assign(() => db, {
      FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__',
                    increment: (n) => ({ __inc: n }), arrayUnion: (...a) => a },
      Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m) => ({ toMillis: () => m }) },
    }),
    auth: () => ({ async getUser() { return { uid: 'u', customClaims: {} }; },
                   async setCustomUserClaims() { return true; } }),
    apps: [{}], initializeApp() {},
  };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'firebase-admin') return fakeAdmin;
    if (request === 'firebase-functions/v2/https') {
      return { onCall: (o, h) => (h || o),
               HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    }
    if (request === 'firebase-functions/v2/firestore') return { onDocumentWritten: () => ({}) };
    if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, log() {} };
    if (request === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} } };
    return realLoad.apply(this, arguments);
  };
  let mod = null, err = null;
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'functions', 'business-bootstrap.js'))];
    mod = require(path.join(ROOT, 'functions', 'business-bootstrap.js'));
  } catch (e) { err = e; }
  Module._load = realLoad;
  if (err) throw err;
  return mod;
}

/* ══ 1. the guard exists and is exported ═════════════════════════════════ */
head('1 — the idempotent entry point');
let db = makeDb();
let bb;
try { bb = loadModule(db); } catch (e) { bb = null; console.log('  load error: ' + e.message); }
ck('P1 business-bootstrap loads against a substituted db', !!bb, bb ? '' : 'module failed to load');
ck('P2 _ensureBusinessForOwner is exported for the approval path',
   !!(bb && typeof bb._ensureBusinessForOwner === 'function'));

/* Everything asynchronous runs inside main(). */
async function main() {
  /* re-run section 2 properly */
  db = makeDb();
  bb = loadModule(db);
  const r1 = await bb._ensureBusinessForOwner({ uid: 'UID-A', businessName: 'Bravilex Duka', category: 'Retail' });
  ck('P3 a merchant with no business gets one', r1 && r1.created === true, JSON.stringify(r1));
  ck('P4 ...and it is findable the way the TILL looks for it — ownerId == uid',
     (await db.collection('businesses').where('ownerId', '==', 'UID-A').limit(1).get()).empty === false,
     'sokoni-pos-context.js queries exactly this');
  const bizDocs = (await db.collection('businesses').get()).docs;
  ck('P5 exactly ONE business document exists', bizDocs.length === 1, bizDocs.length + ' found');
  ck('P6 it is stamped provisionedBy: approval',
     bizDocs[0] && bizDocs[0].data().provisionedBy === 'approval',
     bizDocs[0] ? String(bizDocs[0].data().provisionedBy) : 'none');
  ck('P7 status is active and ownerId is the canonical uid',
     bizDocs[0].data().status === 'active' && bizDocs[0].data().ownerId === 'UID-A');
  ck('P8 a default branch was provisioned', !!bizDocs[0].data().defaultBranchId);

  /* ══ 3. IDEMPOTENCY ══════════════════════════════════════════════════ */
  head('3 — a retried approval must not provision twice');
  const r2 = await bb._ensureBusinessForOwner({ uid: 'UID-A', businessName: 'Bravilex Duka', category: 'Retail' });
  ck('P9 the second call does NOT create', r2 && r2.created === false, JSON.stringify(r2));
  ck('P10 ...and reports why', r2.reason === 'already-provisioned', String(r2.reason));
  ck('P11 STILL exactly one business — no duplicate identity',
     (await db.collection('businesses').get()).docs.length === 1);
  ck('P12 ...and it returns the SAME merchantId', r2.merchantId === r1.merchantId,
     r1.merchantId + ' vs ' + r2.merchantId);

  /* ══ 4. CONCURRENCY ══════════════════════════════════════════════════ */
  head('4 — two approvals racing must not both create');
  const db2 = makeDb();
  const bb2 = loadModule(db2);
  const [a, b] = await Promise.all([
    bb2._ensureBusinessForOwner({ uid: 'UID-B', businessName: 'Shop B', category: 'Retail' }),
    bb2._ensureBusinessForOwner({ uid: 'UID-B', businessName: 'Shop B', category: 'Retail' }),
  ]);
  const created = [a, b].filter((x) => x && x.created === true).length;
  ck('P13 only ONE of two concurrent approvals creates', created === 1,
     'created=' + created + '  ' + JSON.stringify([a.reason, b.reason]));
  ck('P14 ...and only one business document exists',
     (await db2.collection('businesses').get()).docs.length === 1,
     (await db2.collection('businesses').get()).docs.length + ' found');
  ck('P15 the claim is keyed on the CANONICAL uid, never a browser value',
     db2._store.has('posProvisioning/UID-B'),
     [...db2._store.keys()].filter((k) => k.startsWith('posProvisioning')).join(','));

  /* ══ 5. FAILURE RELEASES THE CLAIM ═══════════════════════════════════ */
  head('5 — a failed run must not leave the merchant unprovisionable');
  const db3 = makeDb();
  const bb3 = loadModule(db3);
  const realBatch = db3.batch.bind(db3);
  db3.batch = () => ({ set() {}, update() {}, async commit() { throw new Error('simulated commit failure'); } });
  let threw = false;
  try { await bb3._ensureBusinessForOwner({ uid: 'UID-C', businessName: 'Shop C', category: 'Retail' }); }
  catch (_) { threw = true; }
  ck('P16 the failure is reported, not swallowed', threw);
  ck('P17 the claim was RELEASED — a stuck claim would block this merchant forever',
     !db3._store.has('posProvisioning/UID-C'),
     [...db3._store.keys()].join(',') || '(empty)');
  db3.batch = realBatch;
  const retry = await bb3._ensureBusinessForOwner({ uid: 'UID-C', businessName: 'Shop C', category: 'Retail' });
  ck('P18 ...so a retry after the failure DOES provision', retry && retry.created === true,
     JSON.stringify(retry));

  /* ══ 6. PROVENANCE IS NOT A PASSTHROUGH ══════════════════════════════ */
  head('6 — provenance is an allowlist');
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'business-bootstrap.js'), 'utf8');
  const decomment0 = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('P19 provisionedBy is chosen from an allowlist, not written from input',
     /__provisionedBy === 'approval'\) \? 'approval' : 'onboarding-v2'/.test(src));
  ck('P20 NC ...and the raw value is never assigned straight through',
     !/provisionedBy: *d\.__provisionedBy *,/.test(src) &&
     !/provisionedBy: *_san\(d\.provisionedBy/.test(src));

  /* ══ 7. THE APPROVAL PATH ════════════════════════════════════════════ */
  head('7 — the approval path calls it, safely');
  /* Comments are STRIPPED before every source assertion below. Both of the
     first failures here were this file's own explanatory prose matching its
     own detector — a check that reads comments cannot tell a fallback from a
     sentence describing one. */
  const decomment = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const life = decomment(fs.readFileSync(path.join(ROOT, 'functions', 'application-lifecycle.js'), 'utf8'));
  ck('P21 approval invokes the shared helper, not a second implementation',
     /_ensureBusinessForOwner\(/.test(life) && /require\('\.\/business-bootstrap'\)/.test(life));
  ck('P22 ...only when APPROVED and only for a merchant role',
     /status === 'approved' && \(role === 'seller' \|\| role === 'merchant'\)/.test(life));
  ck('P23 provisioning failure does NOT roll back the approval',
     /posProvisioning: \{ ok: false/.test(life));
  ck('P24 ...and the outcome is recorded on the application for a reviewer',
     /posProvisioning: \{ ok: true/.test(life));
  ck('P25 NC no client fallback was introduced — no localStorage/URL/merchantId shortcut',
     !/localStorage/.test(life) && !/users\/\$\{uid\}\.merchantId/.test(life));

  /* ══ 8. THE TILL STOPS BLAMING THE MERCHANT ══════════════════════════ */
  head('8 — the message tells the truth');
  const till = decomment(fs.readFileSync(path.join(ROOT, 'till.html'), 'utf8'));
  ck('P26 the old wording is gone',
     till.indexOf('This account is not the owner of a shop yet') === -1);
  ck('P27 ...replaced with one that names SOKONI as responsible',
     /SOKONI has not finished setting up this business for POS/.test(till));
  ck('P28 NC the till still does NOT invent a shop client-side',
     !/collection\('businesses'\)[\s\S]{0,80}\.(set|add)\(/.test(till));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
