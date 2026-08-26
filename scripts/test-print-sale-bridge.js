/* ══════════════════════════════════════════════════════════════════════════════
   Phone-sale bridge — EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
   PHONE sale commits → posRetailSales/{saleId} → (trigger) → posPrintJobs PENDING
                     → (realtime) DESKTOP → CLAIM → SokoniReceiptDoc → P58E → PRINTED

   Two properties carry this slice:

     1. NO INTENT BEFORE THE SALE COMMITS. Enforced structurally: the trigger fires on the sale
        document, which does not exist until posCompleteCheckout has written it.

     2. REALTIME IS NOTIFICATION, NOT AUTHORIZATION. Nothing reaches a transport except through
        claim → mayPrint === true → send. The tests below drive duplicate snapshot events,
        replays, reconnects, focus and manual reprint at the gate and count actual sends.

   Run: node scripts/test-print-sale-bridge.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

class HttpsError extends Error { constructor (code, msg) { super(msg); this.code = code; } }

/* ── Firestore stub (same optimistic-concurrency model as the lifecycle suite) ── */
function makeDb (seed) {
  const cols = {}; const ver = {};
  Object.entries(seed || {}).forEach(([c, docs]) => {
    cols[c] = {};
    Object.entries(docs).forEach(([id, d]) => { cols[c][id] = JSON.parse(JSON.stringify(d)); ver[c + '/' + id] = 1; });
  });
  const docRef = (col, id) => ({ id, _col: col, _path: col + '/' + id, get: async () => snapOf(col, id) });
  const snapOf = (col, id) => ({ exists: !!(cols[col] && cols[col][id]), id,
    data: () => (cols[col] || {})[id], ref: docRef(col, id) });
  const qRef = (col, filters) => ({ _col: col, _filters: filters,
    where: (f, o, v) => qRef(col, filters.concat([[f, o, v]])), limit: () => qRef(col, filters),
    get: async () => runQuery(col, filters) });
  function runQuery (col, filters) {
    const rows = Object.entries(cols[col] || {}).filter(([, d]) =>
      filters.every(([f, , v]) => Object.prototype.hasOwnProperty.call(d, f) && d[f] === v))
      .map(([id]) => snapOf(col, id));
    return { docs: rows, empty: rows.length === 0, size: rows.length };
  }
  const applyPatch = (t, p) => Object.entries(p).forEach(([k, v]) => {
    if (v && v.__inc !== undefined) t[k] = (Number(t[k]) || 0) + v.__inc; else t[k] = v; });
  async function runTransaction (fn) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const readVers = {}; const staged = [];
      const txn = {
        get: async (r) => { if (r._filters) return runQuery(r._col, r._filters);
          readVers[r._path] = ver[r._path] || 0; return snapOf(r._col, r.id); },
        set: (ref, data, o) => staged.push({ ref, data, merge: !!(o && o.merge), op: 'set' }),
        update: (ref, data) => staged.push({ ref, data, op: 'update' }),
      };
      const result = await fn(txn);
      if (Object.entries(readVers).some(([p, v]) => (ver[p] || 0) !== v)) continue;
      staged.forEach(({ ref, data, merge, op }) => {
        cols[ref._col] = cols[ref._col] || {};
        const cur = cols[ref._col][ref.id];
        if (op === 'set' && !merge) cols[ref._col][ref.id] = JSON.parse(JSON.stringify(data));
        else { const t = cur ? Object.assign({}, cur) : {}; applyPatch(t, data); cols[ref._col][ref.id] = t; }
        ver[ref._path] = (ver[ref._path] || 0) + 1;
      });
      return result;
    }
    throw new HttpsError('aborted', 'contention');
  }
  return { _cols: cols, _ver: ver, runTransaction,
    collection: (c) => Object.assign(qRef(c, []), { doc: (id) => docRef(c, id) }) };
}

let DB = null;
const dbProxy = new Proxy({}, { get: (_, k) => {
  if (!DB) throw new Error('no db bound'); const v = DB[k];
  return typeof v === 'function' ? v.bind(DB) : v; } });
const adminStub = { firestore: Object.assign(() => dbProxy, {
  FieldValue: { serverTimestamp: () => '<ts>', increment: (n) => ({ __inc: n }) },
  Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms, __ms: ms }) } }) };

let triggerHandler = null, triggerCfg = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return adminStub;
  if (request === 'firebase-functions/v2/https') return { onCall: (o, f) => (f || o), HttpsError };
  if (request === 'firebase-functions/v2/firestore') {
    return { onDocumentCreated: (cfg, fn) => { triggerCfg = cfg; triggerHandler = fn; return fn; } };
  }
  return origLoad.apply(this, arguments);
};
const PI = require(path.join(__dirname, '..', 'functions', 'print-intents.js'));
Module._load = origLoad;

/* ── Load the listener with a window stub ─────────────────────────────────── */
global.window = global;
const PHL_PATH = path.join(__dirname, '..', 'sokoni-print-host-listener.js');
require(PHL_PATH);
const PH = global.window.SokoniPrintHost;

const SHOP_A = 'SHOP_A', SHOP_B = 'SHOP_B';
const OWNER_A = 'owner_a', CASHIER = 'cashier_1';
const HOST1 = 'desk-1';
const SALE = 'aBcDeFgHiJkLmNoPqRsT';

const seed = () => ({
  businesses: { [SHOP_A]: { ownerId: OWNER_A }, [SHOP_B]: { ownerId: 'owner_b' } },
  merchants:  { [SHOP_A]: { ownerId: OWNER_A }, [SHOP_B]: { ownerId: 'owner_b' } },
  posStaff: {},
  posDevices: {
    [HOST1]: { deviceId: HOST1, merchantId: SHOP_A, branchId: 'main', printerHost: true },
    'shopb-plain': { deviceId: 'shopb-plain', merchantId: SHOP_B, branchId: 'main' },
  },
  posRetailSales: {},
  posPrintJobs: {
    legacyRelayJob1: { uid: OWNER_A, shopId: SHOP_A, host: '192.168.1.50', port: 9100, bytes: 412, status: 'pending' },
  },
});

const fireSale = (saleId, sale) => triggerHandler({
  params: { saleId },
  data: { data: () => sale, id: saleId },
});
const req = (uid, data) => ({ auth: uid ? { uid, token: {} } : null, data });
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
const completedSale = (over) => Object.assign({
  id: SALE, merchantId: SHOP_A, branchId: 'main', cashierId: CASHIER,
  status: 'completed', grandTotal: 1250, items: [{ name: 'Sugar 1kg', qty: 1, price: 1250 }],
}, over || {});

(async () => {
  head('0 - controls');
  ck('CONTROL: the trigger registered', typeof triggerHandler === 'function');
  ck('it listens on the SALE document, not on a print collection',
     triggerCfg && triggerCfg.document === 'posRetailSales/{saleId}', triggerCfg && triggerCfg.document);
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  ck('re-exported by name from index.js',
     /exports\.onPosSaleCompleted\s*=\s*printIntents\.onPosSaleCompleted/.test(IDX));
  ck('CONTROL: the listener loaded', !!PH && typeof PH._processJob === 'function');
  const IDXJ = require(path.join(__dirname, '..', 'firestore.indexes.json'));
  const wanted = IDXJ.indexes.find((i) => i.collectionGroup === 'posPrintJobs');
  ck('the composite index for the desktop query exists', !!wanted
     && wanted.fields.map((f) => f.fieldPath).join(',') === 'kind,shopId,status,createdAt',
     wanted && wanted.fields.map((f) => f.fieldPath).join(','));

  /* ── 1. never before the sale commits ───────────────────────────────────── */
  head('1 - no print intent before the sale has committed');
  let db = makeDb(seed()); DB = db;
  const before = Object.keys(db._cols.posPrintJobs).length;
  ck('CONTROL: no intent exists yet', before === 1 /* the legacy row only */);

  await fireSale(SALE, completedSale({ status: 'processing' }));
  ck('an in-flight sale creates NOTHING',
     Object.keys(db._cols.posPrintJobs).length === before);
  await fireSale(SALE, completedSale({ status: 'voided' }));
  ck('a voided sale creates NOTHING', Object.keys(db._cols.posPrintJobs).length === before);
  await fireSale(SALE, completedSale({ status: 'failed' }));
  ck('a failed sale creates NOTHING', Object.keys(db._cols.posPrintJobs).length === before);
  await fireSale(SALE, completedSale({ merchantId: '' }));
  ck('a sale with no shop creates NOTHING', Object.keys(db._cols.posPrintJobs).length === before,
     'an abandoned checkout must not produce a valid-looking receipt job');

  await fireSale(SALE, completedSale());
  const jobId = PI.intentDocId(SHOP_A, SALE);
  ck('a COMPLETED sale creates exactly one intent',
     Object.keys(db._cols.posPrintJobs).length === before + 1 && !!db._cols.posPrintJobs[jobId]);
  const intent = db._cols.posPrintJobs[jobId];
  ck('it is PENDING', intent.status === 'PENDING');
  ck('it carries kind:printIntent', intent.kind === 'printIntent');
  ck('the identity is the saleId, not the receipt number', intent.saleId === SALE);
  ck('the doc id is derived from the sale', jobId === SHOP_A + '__' + SALE);

  head('2 - the intent is routing metadata, not a second receipt authority');
  ck('it references the canonical sale',
     intent.source && intent.source.collection === 'posRetailSales' && intent.source.id === SALE);
  ['grandTotal', 'items', 'subtotal', 'taxTotal', 'payments', 'total'].forEach((f) => {
    ck('it does NOT copy "' + f + '"', intent[f] === undefined);
  });
  ck('receiptNo is carried as display metadata only',
     intent.receiptNo === SALE.slice(-8).toUpperCase());
  ck('and it is NOT the key', jobId.indexOf(intent.receiptNo) < 0,
     'receiptNo uppercases 8 chars of a 62-symbol id — 16% collision at 1M receipts per shop');

  head('3 - a re-fired trigger is idempotent');
  await fireSale(SALE, completedSale());
  await fireSale(SALE, completedSale());
  const intents = Object.values(db._cols.posPrintJobs).filter((j) => j.kind === 'printIntent');
  ck('three firings, ONE intent', intents.length === 1, 'found ' + intents.length);

  head('4 - no host, no intent');
  db = makeDb(seed()); DB = db;
  delete db._cols.posDevices[HOST1].printerHost;
  await fireSale(SALE, completedSale());
  ck('a shop with no registered printer host gets no intent',
     Object.values(db._cols.posPrintJobs).filter((j) => j.kind === 'printIntent').length === 0,
     'a backlog that prints en masse when a host registers months later is a trap, not durability');

  /* ── 5. THE GATE ────────────────────────────────────────────────────────── */
  head('5 - realtime is notification, not authorization');
  db = makeDb(seed()); DB = db;
  await fireSale(SALE, completedSale());

  /* deps wired to the REAL callables, with a counting transport. */
  let sends = 0, rendered = 0;
  const mkDeps = (over) => Object.assign({
    claim:   (p) => PI.claimPrintJob(req(OWNER_A, p)),
    advance: (p) => PI.advancePrintJob(req(OWNER_A, p)),
    loadSale: async () => completedSale(),
    render:  () => { rendered++; return { lines: ['SOKONI', 'Sugar 1kg  1250'] }; },
    send:    async () => { sends++; return { ok: true }; },
  }, over || {});

  PH._state.deviceId = HOST1;
  PH._state.running = true;
  PH._state.deps = mkDeps();

  const r1 = await PH._processJob(jobId, PH._state.deps);
  ck('the first pass prints', r1.printed === true && sends === 1);
  ck('the job is PRINTED', db._cols.posPrintJobs[jobId].status === 'PRINTED');

  /* Everything that can re-deliver the same document. */
  const r2 = await PH._processJob(jobId, PH._state.deps);   /* duplicate snapshot event */
  const r3 = await PH._processJob(jobId, PH._state.deps);   /* listener replay on reconnect */
  const r4 = await PH._processJob(jobId, PH._state.deps);   /* tab regains focus */
  ck('a duplicate snapshot event does not print', r2.printed === false);
  ck('a listener replay does not print', r3.printed === false);
  ck('a focus-triggered pass does not print', r4.printed === false);
  ck('the transport was reached exactly ONCE across four passes', sends === 1,
     'sends=' + sends + ' — each extra one is a sheet of paper');

  head('6 - a manual reprint is not a way around the gate');
  PH.reprint(jobId);
  await new Promise((r) => setTimeout(r, 10));
  ck('reprinting a PRINTED job does not reach the transport', sends === 1, 'sends=' + sends);

  head('7 - the gate refuses when the claim is refused');
  db = makeDb(seed()); DB = db;
  await fireSale(SALE, completedSale());
  sends = 0; rendered = 0;
  PH._state.deviceId = 'shopb-plain';               /* not a host, and another shop */
  PH._state.deps = mkDeps();
  const rWrong = await PH._processJob(jobId, PH._state.deps);
  ck('a non-host device prints nothing', rWrong.printed === false && sends === 0, rWrong.reason);
  ck('nothing was even rendered', rendered === 0,
     'the claim comes first — before the render, before any connectivity check');
  ck('the job is still PENDING', db._cols.posPrintJobs[jobId].status === 'PENDING');

  head('8 - a transport that reports failure is never called a success');
  db = makeDb(seed()); DB = db;
  await fireSale(SALE, completedSale());
  PH._state.deviceId = HOST1;
  PH._state.deps = mkDeps({ send: async () => ({ ok: false, error: 'GATT write failed' }) });
  const rFail = await PH._processJob(jobId, PH._state.deps);
  ck('it reports NOT printed', rFail.printed === false, rFail.reason);
  ck('the job is FAILED, not PRINTED', db._cols.posPrintJobs[jobId].status === 'FAILED');
  ck('the printer error is recorded', /GATT write failed/.test(db._cols.posPrintJobs[jobId].lastError || ''));

  /* And a retry then works, on the same document. */
  await PI.advancePrintJob(req(OWNER_A, { jobId, to: 'PENDING' }));
  sends = 0;
  PH._state.deps = mkDeps();
  const rRetry = await PH._processJob(jobId, PH._state.deps);
  ck('after an operator retry it prints, once', rRetry.printed === true && sends === 1);
  ck('still one document', Object.values(db._cols.posPrintJobs).filter((j) => j.kind === 'printIntent').length === 1);

  head('9 - a throwing transport does not strand the job');
  db = makeDb(seed()); DB = db;
  await fireSale(SALE, completedSale());
  PH._state.deps = mkDeps({ send: async () => { throw new Error('printer offline'); } });
  const rThrow = await PH._processJob(jobId, PH._state.deps);
  ck('it reports not printed', rThrow.printed === false);
  ck('the job is FAILED and therefore retryable', db._cols.posPrintJobs[jobId].status === 'FAILED');

  head('10 - a missing canonical sale fails the job rather than inventing a receipt');
  db = makeDb(seed()); DB = db;
  await fireSale(SALE, completedSale());
  sends = 0;
  PH._state.deps = mkDeps({ loadSale: async () => null });
  const rNoSale = await PH._processJob(jobId, PH._state.deps);
  ck('nothing is printed', rNoSale.printed === false && sends === 0);
  ck('the job is FAILED', db._cols.posPrintJobs[jobId].status === 'FAILED');
  ck('the reason is recorded', /canonical sale/.test(db._cols.posPrintJobs[jobId].lastError || ''));

  head('11 - the snapshot handler cannot print, only name work');
  const SRC = fs.readFileSync(PHL_PATH, 'utf8');
  const oss = SRC.indexOf('S.unsub = fsMod.onSnapshot(');
  const handler = SRC.slice(oss, SRC.indexOf('}, function (err)', oss));
  ck('CONTROL: the snapshot handler was located', handler.length > 80 && handler.length < 700,
     handler.length + ' chars');
  ck('it does not send', !/\bsend\(|printReceipt|_sendBytes/.test(handler));
  ck('it does not claim', !/claim\(/.test(handler));
  ck('it only enqueues', /_enqueue\(d\.id\)/.test(handler));
  /* And the gate is the only route to a transport in the whole file. */
  const sendCalls = (SRC.match(/deps\.send\(/g) || []).length;
  ck('deps.send is reached from exactly ONE place', sendCalls === 1, 'found ' + sendCalls);
  const gs = SRC.indexOf('async function _processJob');
  const ge = SRC.indexOf('async function _fail');
  const gate = SRC.slice(gs, ge);
  ck('and that place is inside the gate', gate.indexOf('deps.send(') > 0);
  ck('the claim precedes the send inside the gate',
     gate.indexOf('deps.claim(') > 0 && gate.indexOf('deps.claim(') < gate.indexOf('deps.send('));
  ck('the mayPrint guard precedes the send',
     gate.indexOf('mayPrint !== true') > 0 && gate.indexOf('mayPrint !== true') < gate.indexOf('deps.send('));
  ck('the query uses BOTH discriminators',
     /where\('kind', '==', 'printIntent'\)/.test(SRC) && /where\('status', '==', 'PENDING'\)/.test(SRC));

  head('12 - the existing focus/drain guard is still in place');
  const SVC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-pos-print-service.js'), 'utf8');
  ck('_gateLocalDrain still exists', /_gateLocalDrain \(job\) \{/.test(SVC),
     'realtime arriving is not a reason to remove the other guard');
  ck('drainQueue still calls it', /_gateLocalDrain\(job\)/.test(SVC));

  head('13 - the device id resolver picks the key that names a real document');
  const LS = {};
  global.localStorage = { getItem: (k) => (k in LS ? LS[k] : null), setItem: (k, v) => { LS[k] = String(v); } };
  ck('with nothing stored it returns null, not a fresh id', PH.resolveDeviceId() === null,
     'generating one here would create a third vocabulary for the same thing');
  LS.pos_device_id = 'dev_abc_123';
  ck('pos_device_id is IGNORED', PH.resolveDeviceId() === null,
     'pos-sync.js writes it and never sends it to any device CF — it names nothing on the server');
  LS.sokoni_device_id = '11111111-2222-4333-8444-555555555555';
  ck('sokoni_device_id is used', PH.resolveDeviceId() === LS.sokoni_device_id,
     'pos-setup.html passes exactly this to bootstrapDevice, so it IS the posDevices doc id');

  head('13 - the rules and the phone are untouched');
  const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const { execSync } = require('child_process');
  let headRules = null;
  try { headRules = execSync('git show HEAD:firestore.rules', { cwd: path.join(__dirname, '..'), maxBuffer: 8e6 }).toString(); } catch (_) {}
  ck('CONTROL: HEAD ruleset retrievable', !!headRules && headRules.length > 1000);
  ck('firestore.rules is byte-identical to HEAD', headRules === RULES);
  ck('the listener never touches Bluetooth directly',
     !/navigator\.bluetooth|requestDevice|GATT|gattserver/i.test(SRC),
     'the phone sells; this file routes; the print service owns the transport');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
