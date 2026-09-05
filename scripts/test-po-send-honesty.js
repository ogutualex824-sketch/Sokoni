'use strict';
/**
 * CERT — a purchase order is 'sent' only when the authoritative backend says so.
 *
 * INVARIANT UNDER TEST
 *   A purchase-order action that fails at the authoritative backend must never appear
 *   successful to the merchant.
 *
 * METHOD
 *   `PosSuppliers.sendPurchaseOrder` is EXECUTED, not grepped. The module is a browser IIFE,
 *   so it is loaded into a sandbox with doubles for IndexedDB, firebase.functions() and
 *   navigator, and the real function is driven through each outcome: success, a rejecting
 *   callable, an unconfirmed result shape, and offline. The resulting local record and the
 *   emitted events are asserted.
 *
 *   The NEGATIVE path exercises the real failure contract — the callable rejects the way the
 *   live one does (`not-found`, because the canonical endpoint reads procPurchaseOrders while
 *   this module's ids live in posPurchaseOrders) — rather than matching a string in source.
 *
 *   Syntax validity is not a behavioural postcondition, so nothing here relies on it.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'pos-suppliers.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — PO "sent" requires authoritative confirmation\n');

/* ══════════════════════════════════════════════════════════════
   HARNESS — load the browser IIFE with doubles
══════════════════════════════════════════════════════════════ */

/**
 * @param {object} opts
 *   opts.callable  — async ({poId}) => result, or throws
 *   opts.online    — navigator.onLine
 *   opts.noFns     — omit firebase.functions entirely
 *   opts.seedPO    — the PO record already in the local store
 */
function load(opts) {
  const store = { purchase_orders: {}, suppliers: {}, grns: {}, supplier_invoices: {}, supplier_payments: {} };
  if (opts.seedPO) store.purchase_orders[opts.seedPO.id] = JSON.parse(JSON.stringify(opts.seedPO));
  const events = [];
  const calls  = [];

  /* Minimal IndexedDB double: the module only needs open/objectStore/put/get/getAll. */
  const idb = {
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({ createIndex() {} }),
          transaction(name) {
            return {
              objectStore(n) {
                const bag = store[n] || (store[n] = {});
                return {
                  put(rec) { const r = {}; setTimeout(() => { bag[rec.id] = rec; r.onsuccess && r.onsuccess(); }, 0); return r; },
                  get(id)  { const r = {}; setTimeout(() => { r.result = bag[id] || null; r.onsuccess && r.onsuccess(); }, 0); return r; },
                  getAll() { const r = {}; setTimeout(() => { r.result = Object.values(bag); r.onsuccess && r.onsuccess(); }, 0); return r; },
                  delete(id) { const r = {}; setTimeout(() => { delete bag[id]; r.onsuccess && r.onsuccess(); }, 0); return r; },
                  index() { return { getAll() { const r = {}; setTimeout(() => { r.result = []; r.onsuccess && r.onsuccess(); }, 0); return r; } }; },
                };
              },
            };
          },
        };
        req.result = db;
        req.onsuccess && req.onsuccess({ target: { result: db } });
      }, 0);
      return req;
    },
  };

  const firebase = opts.noFns ? {} : {
    functions: () => ({
      httpsCallable: (name) => async (payload) => {
        calls.push({ name, payload });
        return opts.callable(payload);
      },
    }),
    firestore: undefined,
  };

  const sandbox = {
    indexedDB: idb,
    navigator: { onLine: opts.online !== false },
    crypto: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) },
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Number,
    Error,
  };
  sandbox.window = sandbox;
  sandbox.firebase = firebase;
  sandbox.window.addEventListener = () => {};

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'pos-suppliers.js' });

  const PS = sandbox.window.PosSuppliers;
  ['po:sent', 'po:send-failed'].forEach((e) => PS.on(e, (d) => events.push({ e, d })));
  return { PS, store, events, calls };
}

const SEED = { id: 'PO-LOCAL-1', supplierId: 'SUP-1', status: 'draft', total: 48500 };
const okResult   = { data: { poId: 'PO-LOCAL-1', status: 'sent', poNumber: 'PO-1042', delivery: { email: 'queued', sms: 'queued', inApp: 'skipped' } } };
/** The REAL failure contract: the canonical callable reads procPurchaseOrders. */
function notFoundError() {
  const e = new Error('Purchase order not found.');
  e.code = 'functions/not-found';
  return e;
}

(async () => {
  /* ══════════════════════════════════════════════════════════
     §1 POSITIVE — an authoritative success does mark it sent
  ══════════════════════════════════════════════════════════ */
  console.log('§1 POSITIVE — authoritative success');
  {
    const h = load({ seedPO: SEED, callable: async () => okResult });
    await h.PS.init('default', 'merchant-1');
    const po = await h.PS.sendPurchaseOrder('PO-LOCAL-1');

    check('returns the PO', !!po);
    check('status becomes sent on confirmation', po.status === 'sent');
    check('sentAt is stamped on confirmation', typeof po.sentAt === 'number');
    check('the server delivery outcome is recorded locally', !!po.delivery && po.delivery.email === 'queued');
    check('the local store is updated', h.store.purchase_orders['PO-LOCAL-1'].status === 'sent');
    check('po:sent is emitted', h.events.some((x) => x.e === 'po:sent'));
    check('no failure event is emitted', !h.events.some((x) => x.e === 'po:send-failed'));
    check('the callable was actually invoked', h.calls.some((c) => c.name === 'sendPurchaseOrder'));
    check('the client does NOT dictate the channel (no method sent)',
      h.calls.every((c) => c.name !== 'sendPurchaseOrder' || !('method' in c.payload)));
  }

  /* ══════════════════════════════════════════════════════════
     §2 NEGATIVE — the real backend failure contract
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 NEGATIVE — real failure contract (not-found from the canonical endpoint)');
  {
    const h = load({ seedPO: SEED, callable: async () => { throw notFoundError(); } });
    await h.PS.init('default', 'merchant-1');

    let threw = null;
    try { await h.PS.sendPurchaseOrder('PO-LOCAL-1'); } catch (e) { threw = e; }

    check('the failure is surfaced to the caller (throws)', threw !== null);
    check('the error carries the backend reason', threw && /not found/i.test(threw.message));
    check('status is NOT advanced to sent', h.store.purchase_orders['PO-LOCAL-1'].status === 'draft');
    check('sentAt is NOT stamped', h.store.purchase_orders['PO-LOCAL-1'].sentAt === undefined);
    check('po:sent is NOT emitted', !h.events.some((x) => x.e === 'po:sent'));
    check('po:send-failed IS emitted', h.events.some((x) => x.e === 'po:send-failed'));
    check('the failure reason is persisted for the merchant',
      !!h.store.purchase_orders['PO-LOCAL-1'].lastSendError);
    check('the attempt timestamp is recorded without claiming success',
      typeof h.store.purchase_orders['PO-LOCAL-1'].lastSendAttemptAt === 'number');

    /* Retry must be possible without accumulating a false sentAt. */
    let threw2 = null;
    try { await h.PS.sendPurchaseOrder('PO-LOCAL-1'); } catch (e) { threw2 = e; }
    check('a retry also fails honestly', threw2 !== null);
    check('a retry still has not stamped sentAt', h.store.purchase_orders['PO-LOCAL-1'].sentAt === undefined);
  }

  /* ══════════════════════════════════════════════════════════
     §3 NEGATIVE — an unconfirmed / wrong-shaped result is not success
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 NEGATIVE — unconfirmed result shapes');
  for (const [label, result] of [
    ['a resolved call with no data',        {}],
    ['a result whose status is not "sent"', { data: { poId: 'PO-LOCAL-1', status: 'pending' } }],
    ['a result with no status at all',      { data: { poId: 'PO-LOCAL-1' } }],
  ]) {
    const h = load({ seedPO: SEED, callable: async () => result });
    await h.PS.init('default', 'merchant-1');
    let threw = null;
    try { await h.PS.sendPurchaseOrder('PO-LOCAL-1'); } catch (e) { threw = e; }
    check(label + ' is rejected, not treated as sent',
      threw !== null && h.store.purchase_orders['PO-LOCAL-1'].status === 'draft');
  }

  /* ══════════════════════════════════════════════════════════
     §4 NEGATIVE — offline preserves the record but claims nothing
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 NEGATIVE — offline / unavailable');
  {
    const h = load({ seedPO: SEED, online: false, callable: async () => okResult });
    await h.PS.init('default', 'merchant-1');
    let threw = null;
    try { await h.PS.sendPurchaseOrder('PO-LOCAL-1'); } catch (e) { threw = e; }
    check('offline send fails rather than claiming sent', threw !== null);
    check('offline does NOT mark the PO sent', h.store.purchase_orders['PO-LOCAL-1'].status === 'draft');
    check('offline does NOT call the backend', !h.calls.some((c) => c.name === 'sendPurchaseOrder'));
    check('local-first is preserved — the PO record still exists', !!h.store.purchase_orders['PO-LOCAL-1']);
  }
  {
    const h = load({ seedPO: SEED, noFns: true, callable: async () => okResult });
    await h.PS.init('default', 'merchant-1');
    let threw = null;
    try { await h.PS.sendPurchaseOrder('PO-LOCAL-1'); } catch (e) { threw = e; }
    check('a missing send service fails rather than claiming sent', threw !== null);
    check('a missing send service does NOT mark the PO sent', h.store.purchase_orders['PO-LOCAL-1'].status === 'draft');
  }

  /* ══════════════════════════════════════════════════════════
     §5 SABOTAGE — the suite must catch the old behaviour returning
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 SABOTAGE');

  /* Rebuild the module with the ORIGINAL swallowing implementation and prove §2 would fail. */
  const SABOTAGED = SRC.replace(
    /  async function sendPurchaseOrder\(poId, method = 'email'\) \{[\s\S]*?\n  \}\n/,
    `  async function sendPurchaseOrder(poId, method = 'email') {
    const po = await _get(S.POS, poId);
    if (!po) throw new Error('PO not found');
    po.status = 'sent';
    po.sentAt = Date.now();
    await _put(S.POS, po);
    if (_online && window.firebase?.functions) {
      firebase.functions().httpsCallable('sendPurchaseOrder')({ poId, method }).catch(() => {});
    }
    emit('po:sent', { poId, method });
    return po;
  }\n`
  );
  check('the sabotage actually replaced the implementation', SABOTAGED !== SRC);

  const sabRes = await (async () => {
    const saved = SRC;
    try {
      /* Load the sabotaged source through the same harness. */
      const tmp = path.join(require('os').tmpdir(), 'pos-suppliers.sabotaged.js');
      fs.writeFileSync(tmp, SABOTAGED);
      const realSrc = SABOTAGED;
      /* inline mini-loader mirroring load() but with the sabotaged source */
      const mod = { SRC: realSrc };
      const origSrcRef = mod.SRC;
      const h = (function loadSab() {
        const backup = SRC;
        /* reuse load() by temporarily swapping module-level SRC via closure is not possible,
           so replicate the minimal path: run the sabotaged source in the same sandbox shape */
        const store = { purchase_orders: { 'PO-LOCAL-1': JSON.parse(JSON.stringify(SEED)) } };
        const events = [];
        const idb = { open() { const req = {}; setTimeout(() => { const db = { objectStoreNames:{contains:()=>true}, createObjectStore:()=>({createIndex(){}}), transaction(){ return { objectStore(n){ const bag = store[n] || (store[n] = {}); return { put(rec){const r={};setTimeout(()=>{bag[rec.id]=rec;r.onsuccess&&r.onsuccess();},0);return r;}, get(id){const r={};setTimeout(()=>{r.result=bag[id]||null;r.onsuccess&&r.onsuccess();},0);return r;}, getAll(){const r={};setTimeout(()=>{r.result=Object.values(bag);r.onsuccess&&r.onsuccess();},0);return r;}, delete(){const r={};setTimeout(()=>{r.onsuccess&&r.onsuccess();},0);return r;}, index(){return{getAll(){const r={};setTimeout(()=>{r.result=[];r.onsuccess&&r.onsuccess();},0);return r;}};} }; } }; } }; req.result=db; req.onsuccess&&req.onsuccess({target:{result:db}}); },0); return req; } };
        const sandbox = { indexedDB: idb, navigator:{onLine:true}, crypto:{randomUUID:()=> 'x'}, console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
        sandbox.window = sandbox;
        sandbox.firebase = { functions: () => ({ httpsCallable: () => async () => { throw notFoundError(); } }) };
        sandbox.window.addEventListener = () => {};
        vm.createContext(sandbox);
        vm.runInContext(realSrc, sandbox, { filename: 'sabotaged.js' });
        const PS = sandbox.window.PosSuppliers;
        PS.on('po:sent', (d) => events.push({ e: 'po:sent', d }));
        return { PS, store, events };
      })();
      await h.PS.init('default', 'merchant-1');
      let threw = null;
      try { await h.PS.sendPurchaseOrder('PO-LOCAL-1'); } catch (e) { threw = e; }
      return { threw, status: h.store.purchase_orders['PO-LOCAL-1'].status, emitted: h.events.length > 0 };
    } catch (e) { return { error: e }; }
  })();

  sab('the old swallowing implementation marks a FAILED send as sent',
    !sabRes.error && sabRes.status === 'sent');
  sab('the old implementation does NOT surface the failure',
    !sabRes.error && sabRes.threw === null);
  sab('the old implementation emits po:sent on a failed send',
    !sabRes.error && sabRes.emitted === true);
  /* The differential: run the CURRENT implementation against the identical failing callable
     and assert it behaves the opposite way on all three axes. A hardcoded `true` here would
     be a detector that cannot fail, which proves nothing. */
  const curRes = await (async () => {
    const h = load({ seedPO: SEED, callable: async () => { throw notFoundError(); } });
    await h.PS.init('default', 'merchant-1');
    let threw = null;
    try { await h.PS.sendPurchaseOrder('PO-LOCAL-1'); } catch (e) { threw = e; }
    return {
      threw,
      status: h.store.purchase_orders['PO-LOCAL-1'].status,
      sentEmitted: h.events.some((x) => x.e === 'po:sent'),
    };
  })();
  sab('current vs old, same failing callable: current does NOT mark sent',
    curRes.status === 'draft' && sabRes.status === 'sent');
  sab('current vs old, same failing callable: current DOES surface the failure',
    curRes.threw !== null && sabRes.threw === null);
  sab('current vs old, same failing callable: current does NOT emit po:sent',
    curRes.sentEmitted === false && sabRes.emitted === true);

  /* ══════════════════════════════════════════════════════════
     §6 REGRESSION — what must not have changed
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 preservation');
  check('no .catch(() => {}) remains on the send callable',
    !/httpsCallable\('sendPurchaseOrder'\)\([^)]*\)\.catch\(\(\) => \{\}\)/.test(SRC));
  sab('the detector catches a reintroduced swallow',
    /httpsCallable\('sendPurchaseOrder'\)\([^)]*\)\.catch\(\(\) => \{\}\)/.test(
      "firebase.functions().httpsCallable('sendPurchaseOrder')({ poId, method }).catch(() => {});"));
  check('PRESERVED: local-first IndexedDB write for drafts',
    /await _put\(S\.POS, po\);/.test(SRC));
  check('PRESERVED: the observable cloud-sync path from the earlier fix',
    /op: 'posSupplierSync'/.test(SRC) && /retryFailedSyncs/.test(SRC));
  /* Assert the EXPORT, not the formatting. An earlier version matched a whole line of
     adjacent names and broke when Slice B added submitPurchaseOrder and re-wrapped the
     line — a false failure about a function that was never removed. */
  const RETURN_BLOCK = (/\n  return \{[\s\S]*?\n  \};/.exec(SRC) || [''])[0];
  check('PRESERVED: sendPurchaseOrder is still exported',
    /\bsendPurchaseOrder\b/.test(RETURN_BLOCK));
  sab('the export detector is not vacuous — it fails on a removed export',
    !/\bsendPurchaseOrder\b/.test('  return {\n    init, on, off,\n    createPurchaseOrder,\n  };'));

  const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
  check('UNTOUCHED: canonical procurement.sendPurchaseOrder still reads procPurchaseOrders',
    /collection\('procPurchaseOrders'\)\.doc\(poId\)/.test(PROC));
  check('UNTOUCHED: canonical endpoint still requires approved status',
    /po\.status !== 'approved'/.test(PROC));
  check('UNTOUCHED: canonical endpoint still exported', /sendPurchaseOrder,/.test(PROC));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) {
    console.log('\n  ' + fail + ' FAILURE(S):');
    failures.forEach((f) => console.log('    - ' + f));
    process.exit(1);
  }
  console.log('\n  PASS — a PO is "sent" only when the authoritative backend confirms it.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
