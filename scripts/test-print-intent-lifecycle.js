/* ══════════════════════════════════════════════════════════════════════════════
   Durable print lifecycle — EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
       PENDING ──claim──► CLAIMED ──begin──► PRINTING ──ok──► PRINTED
                             └───────fail────┴──► FAILED ──retry──► PENDING

   The property under test is not "the state machine works". It is:

       ONE SALE NEVER BECOMES TWO PHYSICAL RECEIPTS.

   across a reload, a duplicate realtime event, a focus event, a reconnect, a stale claim, a
   retry, and two desktops racing.

   THE RACE IS TESTED FOR REAL. The stub below implements optimistic concurrency the way
   Firestore does — reads record a document version, commit verifies it, and a conflict retries
   the whole transaction body. The race case forces BOTH claims to read before EITHER commits.
   A stub that merely ran the two sequentially would pass while proving nothing, because the
   second call would simply observe the first one's committed write.

   Run: node scripts/test-print-intent-lifecycle.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

/* ── Firestore stub with versioned optimistic concurrency ─────────────────── */
class HttpsError extends Error { constructor (code, msg) { super(msg); this.code = code; } }

function makeDb (seed) {
  const cols = {};
  const ver = {};                                   /* docPath -> version */
  Object.entries(seed || {}).forEach(([c, docs]) => {
    cols[c] = {};
    Object.entries(docs).forEach(([id, d]) => { cols[c][id] = JSON.parse(JSON.stringify(d)); ver[c + '/' + id] = 1; });
  });
  const hooks = {};

  const docRef = (col, id) => ({ id, _col: col, _path: col + '/' + id,
    get: async () => snapOf(col, id) });
  const snapOf = (col, id) => ({
    exists: !!(cols[col] && cols[col][id]), id,
    data: () => (cols[col] || {})[id],
    ref: docRef(col, id),
  });
  const qRef = (col, filters) => ({
    _col: col, _filters: filters,
    where: (f, op, v) => qRef(col, filters.concat([[f, op, v]])),
    limit: () => qRef(col, filters),
    get: async () => runQuery(col, filters),
  });
  function runQuery (col, filters) {
    const rows = Object.entries(cols[col] || {}).filter(([, d]) =>
      /* Firestore equality semantics: a document MISSING the field never matches. */
      filters.every(([f, , v]) => Object.prototype.hasOwnProperty.call(d, f) && d[f] === v)
    ).map(([id]) => snapOf(col, id));
    return { docs: rows, empty: rows.length === 0, size: rows.length };
  }

  function applyPatch (target, patch) {
    Object.entries(patch).forEach(([k, v]) => {
      if (v && v.__inc !== undefined) target[k] = (Number(target[k]) || 0) + v.__inc;
      else target[k] = v;
    });
  }

  async function runTransaction (fn, opts) {
    const label = (opts && opts.label) || 'txn';
    for (let attempt = 1; attempt <= 6; attempt++) {
      const readVers = {};
      const staged = [];
      const txn = {
        get: async (refOrQuery) => {
          if (refOrQuery._filters) return runQuery(refOrQuery._col, refOrQuery._filters);
          readVers[refOrQuery._path] = ver[refOrQuery._path] || 0;
          return snapOf(refOrQuery._col, refOrQuery.id);
        },
        set: (ref, data, o) => staged.push({ ref, data, merge: !!(o && o.merge), op: 'set' }),
        update: (ref, data) => staged.push({ ref, data, op: 'update' }),
      };
      let result;
      try { result = await fn(txn); }
      catch (e) { throw e; }                        /* a thrown body aborts, no retry */

      if (hooks.afterBody) await hooks.afterBody(label, attempt);

      /* Commit: verify every read is still at the version we saw. */
      const conflict = Object.entries(readVers).some(([p, v]) => (ver[p] || 0) !== v);
      if (conflict) { if (attempt === 6) throw new HttpsError('aborted', 'too much contention'); continue; }

      staged.forEach(({ ref, data, merge, op }) => {
        cols[ref._col] = cols[ref._col] || {};
        const cur = cols[ref._col][ref.id];
        if (op === 'set' && !merge) cols[ref._col][ref.id] = JSON.parse(JSON.stringify(data));
        else { const t = cur ? Object.assign({}, cur) : {}; applyPatch(t, data); cols[ref._col][ref.id] = t; }
        ver[ref._path] = (ver[ref._path] || 0) + 1;
      });
      return result;
    }
  }

  return {
    _cols: cols, _hooks: hooks, _ver: ver,
    collection: (c) => Object.assign(qRef(c, []), { doc: (id) => docRef(c, id) }),
    runTransaction,
  };
}

/* ── Stub the two firebase modules before loading print-intents ───────────── */
let DB = null;
/* print-intents captures db = admin.firestore() at LOAD time, so hand it a lazy proxy that
   resolves to whichever database the current case built. */
const dbProxy = new Proxy({}, {
  get: (_, k) => { if (!DB) throw new Error('no db bound for this case'); const v = DB[k];
    return typeof v === 'function' ? v.bind(DB) : v; },
});
const adminStub = {
  firestore: Object.assign(() => dbProxy, {
    FieldValue: { serverTimestamp: () => '<ts>', increment: (n) => ({ __inc: n }) },
    Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms, __ms: ms }) },
  }),
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return adminStub;
  if (request === 'firebase-functions/v2/https') return { onCall: (o, f) => (f || o), HttpsError };
  return origLoad.apply(this, arguments);
};
const PI = require(path.join(__dirname, '..', 'functions', 'print-intents.js'));
Module._load = origLoad;

const SHOP_A = 'SHOP_A', SHOP_B = 'SHOP_B';
const OWNER_A = 'owner_a', OWNER_B = 'owner_b', STRANGER = 'stranger';
const HOST1 = 'desk-1', HOST2 = 'desk-2', PLAIN = 'desk-plain';
const RCP = 'RCP-000123';

const seed = () => ({
  businesses: { [SHOP_A]: { ownerId: OWNER_A }, [SHOP_B]: { ownerId: OWNER_B } },
  merchants:  { [SHOP_A]: { ownerId: OWNER_A }, [SHOP_B]: { ownerId: OWNER_B } },
  posStaff: {},
  posDevices: {
    [HOST1]: { deviceId: HOST1, merchantId: SHOP_A, branchId: 'main', printerHost: true },
    [HOST2]: { deviceId: HOST2, merchantId: SHOP_A, branchId: 'main', printerHost: true },
    [PLAIN]: { deviceId: PLAIN, merchantId: SHOP_A, branchId: 'main' },
    'shopb-host': { deviceId: 'shopb-host', merchantId: SHOP_B, branchId: 'main', printerHost: true },
  },
  posPrintJobs: {
    /* A LEGACY LAN-relay audit record: random id, lowercase status, no `kind`. */
    'legacyRelayJob1': { uid: OWNER_A, shopId: SHOP_A, host: '192.168.1.50', port: 9100, bytes: 412, status: 'pending' },
  },
});

const req = (uid, data) => ({ auth: uid ? { uid, token: {} } : null, data });
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
const okOr = async (p) => { try { return await p; } catch (e) { return { _threw: e }; } };

(async () => {
  /* ── 0. controls ────────────────────────────────────────────────────────── */
  head('0 - controls');
  ck('CONTROL: the three callables loaded', typeof PI.createPrintIntent === 'function'
     && typeof PI.claimPrintJob === 'function' && typeof PI.advancePrintJob === 'function');
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  ['createPrintIntent', 'claimPrintJob', 'advancePrintJob'].forEach((n) => {
    ck('re-exported by name from index.js: ' + n,
       new RegExp('exports\\.' + n + '\\s*=\\s*printIntents\\.' + n).test(IDX));
  });
  /* NEGATIVE CONTROL for the stub: prove a conflicting write really is detected. */
  {
    const db = makeDb(seed()); DB = db;
    let bumped = false;
    db._hooks.afterBody = async (label, attempt) => {
      if (attempt === 1 && !bumped) { bumped = true; db._ver['posDevices/' + HOST1]++; }
    };
    let attempts = 0;
    await db.runTransaction(async (t) => { attempts++; await t.get(db.collection('posDevices').doc(HOST1)); });
    ck('CONTROL: the stub RETRIES on a version conflict', attempts === 2,
       'ran ' + attempts + ' times; without this the race test below proves nothing');
    db._hooks.afterBody = null;
  }

  /* ── 1. one durable intent per sale ─────────────────────────────────────── */
  head('1 - duplicate phone/realtime events do not create duplicate intents');
  let db = makeDb(seed()); DB = db;
  const c1 = await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }));
  const c2 = await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }));
  const c3 = await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }));
  ck('the first creates', c1.created === true && c1.status === 'PENDING');
  ck('the second does NOT create', c2.created === false);
  ck('the third does NOT create', c3.created === false);
  ck('all three name the SAME document', c1.jobId === c2.jobId && c2.jobId === c3.jobId, c1.jobId);
  const intents = Object.values(db._cols.posPrintJobs).filter((j) => j.kind === 'printIntent');
  ck('exactly ONE durable intent exists', intents.length === 1, 'found ' + intents.length);
  ck('the id is derived from the receipt, not random', c1.jobId === PI.intentDocId(SHOP_A, RCP));

  const e0 = await caught(PI.createPrintIntent(req(STRANGER, { shopId: SHOP_A, receiptId: 'X1' })));
  ck('a stranger cannot queue printing for a shop', e0 && e0.code === 'permission-denied');
  const e0b = await caught(PI.createPrintIntent(req(null, { shopId: SHOP_A, receiptId: 'X1' })));
  ck('unauthenticated cannot create an intent', e0b && e0b.code === 'unauthenticated');

  /* ── 2. THE RACE ────────────────────────────────────────────────────────── */
  head('2 - two hosts race for one pending job');
  db = makeDb(seed()); DB = db;
  const job = (await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }))).jobId;

  /* Hold BOTH transaction bodies after their reads, release together, so neither saw the
     other's write when it decided. This is the interleave that a sequential stub cannot make. */
  let arrived = 0, release;
  const gate = new Promise((r) => { release = r; });
  db._hooks.afterBody = async (label, attempt) => {
    if (attempt !== 1) return;                       /* retries must not re-enter the barrier */
    arrived++;
    if (arrived >= 2) release(); else await gate;
  };
  const [rA, rB] = await Promise.all([
    okOr(PI.claimPrintJob(req(OWNER_A, { jobId: job, deviceId: HOST1 }))),
    okOr(PI.claimPrintJob(req(OWNER_A, { jobId: job, deviceId: HOST2 }))),
  ]);
  db._hooks.afterBody = null;

  ck('both bodies ran before either committed', arrived === 2, 'arrived=' + arrived);
  const winners = [rA, rB].filter((r) => r && !r._threw && r.mayPrint === true);
  const losers  = [rA, rB].filter((r) => r && r._threw);
  ck('EXACTLY ONE claim succeeds', winners.length === 1,
     'winners=' + winners.length + ' losers=' + losers.length);
  ck('the other is refused with aborted', losers.length === 1 && losers[0]._threw.code === 'aborted',
     losers[0] && losers[0]._threw.message);
  const claimed = db._cols.posPrintJobs[job];
  ck('the document records exactly one claimant', !!claimed.claimedBy
     && (claimed.claimedBy === HOST1 || claimed.claimedBy === HOST2), claimed.claimedBy);
  ck('and one claim token', typeof claimed.claimToken === 'string' && claimed.claimToken.length === 32);

  /* ── 3. reload / duplicate event / reconnect ────────────────────────────── */
  head('3 - reload after CLAIMED does not claim again');
  db = makeDb(seed()); DB = db;
  const j2 = (await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }))).jobId;
  const first = await PI.claimPrintJob(req(OWNER_A, { jobId: j2, deviceId: HOST1 }));
  const tok1 = first.claimToken;
  const again = await PI.claimPrintJob(req(OWNER_A, { jobId: j2, deviceId: HOST1 }));
  ck('the same host re-claiming is idempotent', again.alreadyMine === true);
  ck('the SAME token comes back — no new claim', again.claimToken === tok1);
  ck('claimedAt is not reset', db._cols.posPrintJobs[j2].claimedAt === '<ts>');
  ck('takeovers was never incremented', db._cols.posPrintJobs[j2].takeovers === undefined);
  ck('mayPrint is still true while CLAIMED', again.mayPrint === true,
     'the host may finish work it legitimately holds');

  head('4 - reconnect after PRINTING does not duplicate');
  await PI.advancePrintJob(req(OWNER_A, { jobId: j2, to: 'PRINTING', claimToken: tok1 }));
  const midPrint = await PI.claimPrintJob(req(OWNER_A, { jobId: j2, deviceId: HOST1 }));
  ck('the job is still PRINTING', midPrint.status === 'PRINTING');
  ck('it is still mine', midPrint.alreadyMine === true);
  ck('mayPrint is FALSE once printing has begun', midPrint.mayPrint === false,
     'after a crash mid-print we cannot know whether paper came out; re-sending on ambiguity is the duplicate');

  head('5 - the same host seeing the same job twice prints once');
  /* mayPrint is the only signal the desktop acts on. Count how often it is true. */
  db = makeDb(seed()); DB = db;
  const j3 = (await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }))).jobId;
  let mayPrintCount = 0;
  let tok3 = null;
  for (let i = 0; i < 4; i++) {                       /* four duplicate realtime events */
    const r = await PI.claimPrintJob(req(OWNER_A, { jobId: j3, deviceId: HOST1 }));
    tok3 = tok3 || r.claimToken;
    if (r.mayPrint) {
      mayPrintCount++;
      /* what a real host does the moment it is allowed to print */
      await PI.advancePrintJob(req(OWNER_A, { jobId: j3, to: 'PRINTING', claimToken: r.claimToken }));
    }
  }
  ck('mayPrint was true exactly ONCE across four duplicate events', mayPrintCount === 1,
     'got ' + mayPrintCount + ' — each one would have been a sheet of paper');

  /* ── 6. boundaries ──────────────────────────────────────────────────────── */
  head('6 - wrong shop and non-host desktops cannot claim');
  db = makeDb(seed()); DB = db;
  const j4 = (await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }))).jobId;

  let e = await caught(PI.claimPrintJob(req(OWNER_B, { jobId: j4, deviceId: 'shopb-host' })));
  ck('another shop\'s host cannot claim it', e && e.code === 'permission-denied', e && e.message);
  ck('and the job is untouched', db._cols.posPrintJobs[j4].status === 'PENDING');

  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: j4, deviceId: PLAIN })));
  ck('a desktop that is NOT the registered host cannot claim', e && e.code === 'failed-precondition',
     e && e.message);

  e = await caught(PI.claimPrintJob(req(STRANGER, { jobId: j4, deviceId: HOST1 })));
  ck('a stranger at a valid host cannot claim', e && e.code === 'permission-denied');

  e = await caught(PI.claimPrintJob(req(null, { jobId: j4, deviceId: HOST1 })));
  ck('unauthenticated cannot claim', e && e.code === 'unauthenticated');

  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: j4, deviceId: 'no-such-device' })));
  ck('an unregistered device cannot claim', e && e.code === 'not-found');

  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: 'no-such-job', deviceId: HOST1 })));
  ck('a non-existent job cannot be claimed', e && e.code === 'not-found');

  /* ── 7. stale lease recovery + fencing ──────────────────────────────────── */
  head('7 - an expired claim recovers, and fences the old holder out');
  db = makeDb(seed()); DB = db;
  const j5 = (await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }))).jobId;
  const held = await PI.claimPrintJob(req(OWNER_A, { jobId: j5, deviceId: HOST1 }));
  const staleToken = held.claimToken;

  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: j5, deviceId: HOST2 })));
  ck('while the lease is LIVE the other host is refused', e && e.code === 'aborted');

  /* Expire it the way time would. */
  db._cols.posPrintJobs[j5].leaseExpiresAt = { toMillis: () => Date.now() - 1000 };
  const taken = await PI.claimPrintJob(req(OWNER_A, { jobId: j5, deviceId: HOST2 }));
  ck('once the lease expires the job recovers', taken.mayPrint === true && taken.tookOverStale === true);
  ck('the new holder gets a DIFFERENT token', taken.claimToken !== staleToken);
  ck('the takeover is recorded', db._cols.posPrintJobs[j5].takeovers === 1
     && db._cols.posPrintJobs[j5].lastTakeoverFrom === HOST1);

  e = await caught(PI.advancePrintJob(req(OWNER_A, { jobId: j5, to: 'PRINTING', claimToken: staleToken })));
  ck('THE FENCE: the old holder cannot move the job', e && e.code === 'permission-denied', e && e.message);
  e = await caught(PI.advancePrintJob(req(OWNER_A, { jobId: j5, to: 'PRINTED', claimToken: staleToken })));
  ck('the old holder cannot mark it PRINTED', e && e.code === 'permission-denied' || (e && e.code === 'failed-precondition'));
  ck('the job still belongs to the new holder', db._cols.posPrintJobs[j5].claimedBy === HOST2);

  /* ── 8. the happy path ──────────────────────────────────────────────────── */
  head('8 - a successful print reaches PRINTED and stays there');
  db = makeDb(seed()); DB = db;
  const j6 = (await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }))).jobId;
  const cl6 = await PI.claimPrintJob(req(OWNER_A, { jobId: j6, deviceId: HOST1 }));
  await PI.advancePrintJob(req(OWNER_A, { jobId: j6, to: 'PRINTING', claimToken: cl6.claimToken }));
  const done = await PI.advancePrintJob(req(OWNER_A, { jobId: j6, to: 'PRINTED', claimToken: cl6.claimToken }));
  ck('it reaches PRINTED', done.status === 'PRINTED');
  ck('printedBy records the host', db._cols.posPrintJobs[j6].printedBy === HOST1);
  ck('the token is cleared on the terminal state', db._cols.posPrintJobs[j6].claimToken === null);
  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: j6, deviceId: HOST1 })));
  ck('a PRINTED job cannot be claimed again', e && e.code === 'failed-precondition', e && e.message);
  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: j6, deviceId: HOST2 })));
  ck('nor by the other host', e && e.code === 'failed-precondition');
  e = await caught(PI.advancePrintJob(req(OWNER_A, { jobId: j6, to: 'PRINTING', claimToken: cl6.claimToken })));
  ck('PRINTED is terminal — it cannot go back to PRINTING', e && e.code === 'failed-precondition');

  /* ── 9. retry reuses the same job ───────────────────────────────────────── */
  head('9 - a failed print retries without creating a second job');
  db = makeDb(seed()); DB = db;
  const j7 = (await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }))).jobId;
  let cl7 = await PI.claimPrintJob(req(OWNER_A, { jobId: j7, deviceId: HOST1 }));
  await PI.advancePrintJob(req(OWNER_A, { jobId: j7, to: 'PRINTING', claimToken: cl7.claimToken }));
  await PI.advancePrintJob(req(OWNER_A, { jobId: j7, to: 'FAILED', claimToken: cl7.claimToken, error: 'GATT write failed' }));
  ck('it lands in FAILED', db._cols.posPrintJobs[j7].status === 'FAILED');
  ck('the error is recorded', db._cols.posPrintJobs[j7].lastError === 'GATT write failed');
  ck('attempts incremented', db._cols.posPrintJobs[j7].attempts === 1);

  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: j7, deviceId: HOST1 })));
  ck('a FAILED job cannot be claimed until retried', e && e.code === 'failed-precondition');

  const retried = await PI.advancePrintJob(req(OWNER_A, { jobId: j7, to: 'PENDING' }));
  ck('retry returns it to PENDING', retried.status === 'PENDING' && retried.retried === true);
  ck('the claim is cleared', db._cols.posPrintJobs[j7].claimToken === null
     && db._cols.posPrintJobs[j7].claimedBy === null);
  const afterRetry = Object.values(db._cols.posPrintJobs).filter((x) => x.kind === 'printIntent');
  ck('NO second job was created', afterRetry.length === 1, 'found ' + afterRetry.length);
  ck('it is the SAME document', retried.jobId === j7);
  cl7 = await PI.claimPrintJob(req(OWNER_A, { jobId: j7, deviceId: HOST2 }));
  ck('and it can now be claimed by either host', cl7.mayPrint === true);

  /* Put it back into FAILED so the refusal below can only be about AUTHORISATION. The earlier
     version asserted on a job that was already PENDING, so it passed on the transition table
     and would have passed with no shop check at all. */
  await PI.advancePrintJob(req(OWNER_A, { jobId: j7, to: 'FAILED', claimToken: cl7.claimToken, error: 'again' }));
  ck('CONTROL: the job really is FAILED', db._cols.posPrintJobs[j7].status === 'FAILED');
  e = await caught(PI.advancePrintJob(req(STRANGER, { jobId: j7, to: 'PENDING' })));
  ck('a stranger cannot retry a failed print for a shop they do not run', e && e.code === 'permission-denied', e && e.code);
  ck('and the job stays FAILED', db._cols.posPrintJobs[j7].status === 'FAILED');
  const ret2 = await PI.advancePrintJob(req(OWNER_A, { jobId: j7, to: 'PENDING' }));
  ck('the owner still can', ret2.status === 'PENDING');

  /* ── 10. legacy relay records ───────────────────────────────────────────── */
  head('10 - legacy posPrintJobs rows stay readable and unreachable');
  db = makeDb(seed()); DB = db;
  await PI.createPrintIntent(req(OWNER_A, { shopId: SHOP_A, receiptId: RCP }));
  const legacy = db._cols.posPrintJobs['legacyRelayJob1'];
  ck('the legacy row is untouched', legacy.status === 'pending' && legacy.host === '192.168.1.50');
  ck('it has no `kind`', legacy.kind === undefined);
  const q = await db.collection('posPrintJobs').where('kind', '==', 'printIntent').where('status', '==', 'PENDING').get();
  ck('the desktop query returns ONLY intents', q.docs.length === 1 && q.docs[0].data().kind === 'printIntent',
     'a legacy relay row appearing here would be reprinted — the bytes already went to the LAN printer');
  ck('lowercase "pending" is a second, independent discriminator',
     (await db.collection('posPrintJobs').where('status', '==', 'PENDING').get()).docs.length === 1);
  e = await caught(PI.claimPrintJob(req(OWNER_A, { jobId: 'legacyRelayJob1', deviceId: HOST1 })));
  ck('a legacy row cannot be claimed even by exact id', e && e.code === 'failed-precondition', e && e.message);
  e = await caught(PI.advancePrintJob(req(OWNER_A, { jobId: 'legacyRelayJob1', to: 'PRINTED', claimToken: 'x' })));
  ck('nor advanced', e && e.code === 'failed-precondition');

  /* ── 11. the client cannot write status at all ──────────────────────────── */
  head('11 - status is server-only');
  const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const at = RULES.indexOf('match /posPrintJobs/{jobId}');
  const blk = RULES.slice(at, at + 600);
  ck('CONTROL: the posPrintJobs block was located', at > 0);
  ck('clients cannot create, update or delete', /allow create, update, delete: if false;/.test(blk));
  ck('reads stay shop-scoped', /ownsBiz\(resource\.data\.shopId\)/.test(blk));
  ck('the read rule does not require `kind` — legacy rows remain readable', !/kind/.test(blk),
     'narrowing reads to intents would hide the existing relay audit trail');
  /* Compare against git, not against itself — the previous form asserted x === x. */
  const { execSync } = require('child_process');
  let headRules = null;
  try { headRules = execSync('git show HEAD:firestore.rules', { cwd: path.join(__dirname, '..'), maxBuffer: 8e6 }).toString(); } catch (_) {}
  ck('CONTROL: the committed ruleset was retrievable', !!headRules && headRules.length > 1000);
  ck('firestore.rules is BYTE-IDENTICAL to HEAD', headRules === RULES,
     'the frozen artifact has ~510 compiled bytes free; this slice reuses posPrintJobs and spends none');
  ck('no intent vocabulary leaked into the rules', !/printIntent|printerHost/.test(RULES));

  /* ── 12. focus -> drain cannot bypass the claim ─────────────────────────── */
  head('12 - the focus/reconnect drain path cannot print unclaimed durable work');
  const SVC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-pos-print-service.js'), 'utf8');
  /* Brace-match, never a fixed window: a fixed slice runs straight into the next method. */
  const _gs = SVC.indexOf('_gateLocalDrain (job) {');
  let _gd = 0, _ge = -1;
  for (let i = SVC.indexOf('{', _gs); i < SVC.length; i++) {
    if (SVC[i] === '{') _gd++; else if (SVC[i] === '}') { _gd--; if (!_gd) { _ge = i + 1; break; } }
  }
  const gateFn = SVC.slice(_gs, _ge);
  ck('CONTROL: the gate exists in the shipped file', gateFn.length > 100 && gateFn.length < 400,
     gateFn.length + ' chars — a slice that swallowed the next method would not be the gate');
  /* Execute it rather than read it. */
  const gateImpl = new Function('job',
    'return (' + gateFn.slice(gateFn.indexOf('{')).replace(/^\{/, 'function (job) {') + ')(job)');
  ck('an ordinary local job is NOT blocked', gateImpl({ jobId: 'a', bytes: [1, 2] }) === null);
  ck('an intent-backed job with no claim IS blocked', typeof gateImpl({ jobId: 'a', intentId: 'x' }) === 'string');
  ck('an intent-backed job with a server-verified claim is allowed',
     gateImpl({ jobId: 'a', intentId: 'x', claimToken: 't', claimVerifiedAt: 1 }) === null);
  ck('a token alone is not enough', typeof gateImpl({ jobId: 'a', intentId: 'x', claimToken: 't' }) === 'string',
     'a token the server never confirmed for THIS host is not a claim');
  /* And the gate must actually be wired into the loop, not merely defined. */
  const drain = SVC.slice(SVC.indexOf('async drainQueue ()'), SVC.indexOf('async drainQueue ()') + 900);
  ck('drainQueue CALLS the gate', /_gateLocalDrain\(job\)/.test(drain));
  /* Read the guarded statement itself rather than pattern-matching across it: the emit call
     carries an object literal, so a [^}]* window can never reach the continue. */
  const _bi = drain.indexOf('if (_blocked)');
  /* Bound it to the guarded statement's OWN line. A fixed character window runs on into the
     try block below and picks up the very _sendBytes call this is asserting is unreachable —
     the same fixed-window mistake, one level up. */
  const _bstmt = _bi < 0 ? '' : drain.slice(_bi).split('\n')[0];
  ck('CONTROL: the guarded statement was located', _bstmt.length > 40);
  ck('a blocked job is skipped, not printed',
     /continue;/.test(_bstmt) && !/_sendBytes/.test(_bstmt), _bstmt.split('\n')[0]);
  ck('a blocked job is not marked failed either', !/_blocked[\s\S]{0,80}markFail/.test(drain),
     'blocking is not a print failure — it must not burn an attempt');
  const gateIdx = drain.indexOf('_gateLocalDrain(job)'), sendIdx = drain.indexOf('_sendBytes');
  ck('the gate runs BEFORE any bytes are sent', gateIdx > 0 && sendIdx > gateIdx,
     'a gate after the send is decoration');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
