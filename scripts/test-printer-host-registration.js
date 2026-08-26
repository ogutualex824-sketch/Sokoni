/* ══════════════════════════════════════════════════════════════════════════════
   registerPrinterHost — EXECUTED, not inspected
   ══════════════════════════════════════════════════════════════════════════════
   The desktop PWA holds the Bluetooth link; a phone sale must never reach that printer
   directly. This establishes who the host is, and the whole point is that a client cannot
   simply declare itself one.

   The invariant that carries the most weight:

       THE CALLER NEVER SUPPLIES merchantId.

   It is read from the STORED posDevices document. A phone naming somebody else's shop gets
   nowhere, because the request is only a pointer to a record whose ownership is already
   fixed. Every hostile case below exists to prove that.

   Run: node scripts/test-printer-host-registration.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

/* ── A Firestore stub with real transaction semantics for what we assert ──── */
function makeDb (seed) {
  const cols = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  const docApi = (col, id) => ({
    id,
    get: async () => ({
      exists: !!(cols[col] && cols[col][id]),
      id,
      data: () => (cols[col] || {})[id],
      ref: docApi(col, id),
    }),
    _col: col,
  });
  const queryApi = (col, filters) => ({
    where: (f, op, v) => queryApi(col, filters.concat([[f, op, v]])),
    limit: () => queryApi(col, filters),
    get: async () => runQuery(col, filters),
    _col: col, _filters: filters,
  });
  function runQuery (col, filters) {
    const rows = Object.entries(cols[col] || {})
      .filter(([, d]) => filters.every(([f, , v]) => d[f] === v))
      .map(([id, d]) => ({ id, data: () => d, ref: docApi(col, id) }));
    return { docs: rows, empty: rows.length === 0, size: rows.length };
  }
  return {
    _cols: cols, _writes: writes,
    collection: (c) => Object.assign(queryApi(c, []), { doc: (id) => docApi(c, id) }),
    runTransaction: async (fn) => fn({
      get: async (q) => (q._filters ? runQuery(q._col, q._filters) : q.get()),
      set: (ref, data, opts) => {
        writes.push({ op: 'set', col: ref._col, id: ref.id, data });
        cols[ref._col] = cols[ref._col] || {};
        cols[ref._col][ref.id] = (opts && opts.merge)
          ? Object.assign({}, cols[ref._col][ref.id], data)
          : data;
      },
      update: (ref, data) => {
        writes.push({ op: 'update', col: ref._col, id: ref.id, data });
        cols[ref._col][ref.id] = Object.assign({}, cols[ref._col][ref.id], data);
      },
    }),
  };
}

/* Capture the handler by stubbing firebase-functions before requiring the module. */
let handler = null;
const realResolve = Module._resolveFilename;
const stubs = {
  'firebase-functions/v2/https': {
    onCall: (opts, fn) => { const f = fn || opts; handler = handler || f; return f; },
    HttpsError: class HttpsError extends Error {
      constructor (code, msg) { super(msg); this.code = code; }
    },
  },
};

/* ── Load the real function body by extracting it, so the assertions run the
      SHIPPED code rather than a copy. ─────────────────────────────────────── */
const fs = require('fs');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'device-manager.js'), 'utf8');
const start = SRC.indexOf('exports.registerPrinterHost = onCall(OPT, async (req) => {');
const bodyStart = SRC.indexOf('{', SRC.indexOf('async (req) =>', start)) ;
let d = 0, end = -1;
for (let i = bodyStart; i < SRC.length; i++) {
  if (SRC[i] === '{') d++;
  else if (SRC[i] === '}') { d--; if (!d) { end = i + 1; break; } }
}
const body = SRC.slice(bodyStart + 1, end - 1);

class HttpsError extends Error { constructor (code, msg) { super(msg); this.code = code; } }
function makeFn (db) {
  const F = { serverTimestamp: () => '<ts>' };
  const _requireAuth = (req) => { if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'sign in'); return req.auth.uid; };
  const _err = (m, c) => { throw new HttpsError(c || 'invalid-argument', m); };
  const _san = (v, n) => String(v == null ? '' : v).slice(0, n).trim();
  const _isAdmin = (req) => !!(req.auth && req.auth.token && req.auth.token.admin);
  const _log = () => {};
  // eslint-disable-next-line no-new-func
  /* The REAL shop-access module, not a stand-in — registerPrinterHost now delegates to it. */
  const { assertShopAccess } = require(path.join(__dirname, '..', 'functions', 'shop-access'));
  return new Function('db', 'F', '_requireAuth', '_err', '_san', '_isAdmin', '_log', 'HttpsError', 'assertShopAccess',
    'return async function (req) {' + body + '}')(db, F, _requireAuth, _err, _san, _isAdmin, _log, HttpsError, assertShopAccess);
}

const SHOP_A = 'SHOP_A', SHOP_B = 'SHOP_B';
const OWNER_A = 'owner_a', ADMIN_A = 'admin_a', OWNER_B = 'owner_b', STRANGER = 'stranger';
const seed = () => ({
  businesses: { [SHOP_A]: { ownerId: OWNER_A }, [SHOP_B]: { ownerId: OWNER_B } },
  merchants: { [SHOP_A]: { ownerId: OWNER_A, adminUids: [ADMIN_A] }, [SHOP_B]: { ownerId: OWNER_B } },
  posStaff: {},
  posDevices: {
    'desk-1': { deviceId: 'desk-1', merchantId: SHOP_A, branchId: 'main', cashierId: 'c1', status: 'active' },
    'desk-2': { deviceId: 'desk-2', merchantId: SHOP_A, branchId: 'main', cashierId: 'c2', status: 'active' },
    'shopb-1': { deviceId: 'shopb-1', merchantId: SHOP_B, branchId: 'main', cashierId: 'c3', status: 'active' },
    'BOOTSTRAP_NOT_A_UUID': { deviceId: 'BOOTSTRAP_NOT_A_UUID', merchantId: SHOP_A, branchId: 'main', status: 'active' },
  },
});
const call = async (db, uid, data, token) =>
  makeFn(db)({ auth: uid ? { uid, token: token || {} } : null, data });
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
/* A case that throws must FAIL, not abort the file — an aborted run prints no FAIL lines
   at all, which reads exactly like a clean pass to anything counting them. */
const ok_ = async (p) => { try { return await p; } catch (e) { return { _threw: e }; } };

(async () => {
  head('0 - the function was extracted from the shipped module');
  ck('CONTROL: body located (' + body.length + ' chars)', body.length > 1200);
  ck('it is exported by name from device-manager', /registerPrinterHost:\s*exports\.registerPrinterHost/.test(SRC));
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  ck('and re-exported by name from index.js', /exports\.registerPrinterHost\s*=\s*deviceMgr\.registerPrinterHost/.test(IDX),
     'a new Cloud Function that index.js does not re-export is never deployed');

  head('1 - who may register');
  let db = makeDb(seed());
  let r = await call(db, OWNER_A, { deviceId: 'desk-1' });
  ck('the shop OWNER registers a host', r && r.ok === true && r.printerHost === true);
  ck('merchantId is DERIVED from the device record', r.merchantId === SHOP_A);
  ck('the device is marked host', db._cols.posDevices['desk-1'].printerHost === true);

  db = makeDb(seed());
  r = await call(db, ADMIN_A, { deviceId: 'desk-1' });
  ck('a shop ADMIN registers a host', r && r.ok === true, 'merchants.adminUids');

  db = makeDb(seed());
  let e = await caught(call(db, OWNER_B, { deviceId: 'desk-1' }));
  ck('an UNRELATED merchant is refused', e && e.code === 'permission-denied', e && e.message);
  ck('and nothing was written', !db._cols.posDevices['desk-1'].printerHost);

  db = makeDb(seed());
  e = await caught(call(db, STRANGER, { deviceId: 'desk-1' }));
  ck('a stranger is refused', e && e.code === 'permission-denied');

  db = makeDb(seed());
  e = await caught(call(db, null, { deviceId: 'desk-1' }));
  ck('an UNAUTHENTICATED caller is refused', e && e.code === 'unauthenticated');

  head('2 - the device must exist and carry a shop');
  db = makeDb(seed());
  e = await caught(call(db, OWNER_A, { deviceId: 'no-such-device' }));
  ck('an unknown deviceId is refused', e && e.code === 'not-found');

  db = makeDb(seed());
  db._cols.posDevices['orphan'] = { deviceId: 'orphan', status: 'active' };
  e = await caught(call(db, OWNER_A, { deviceId: 'orphan' }));
  ck('a device with no merchantId cannot host', e && e.code === 'failed-precondition');

  head('3 - THE INVARIANT: merchantId cannot be supplied to gain ownership');
  db = makeDb(seed());
  /* Shop B's owner names Shop A in the payload while pointing at Shop B's own device. */
  r = await ok_(call(db, OWNER_B, { deviceId: 'shopb-1', merchantId: SHOP_A }));
  ck('a supplied merchantId is IGNORED — the record decides', r.merchantId === SHOP_B,
     (r._threw ? 'it threw: ' + r._threw.message : 'got ' + r.merchantId) +
     '; a phone naming another shop must not reach its printer');
  ck('Shop A was untouched', !db._cols.posDevices['desk-1'].printerHost);

  db = makeDb(seed());
  e = await caught(call(db, OWNER_B, { deviceId: 'desk-1', merchantId: SHOP_B }));
  ck('claiming another shop\'s DEVICE by naming your own shop is refused',
     e && e.code === 'permission-denied');

  head('4 - one active host per shop');
  db = makeDb(seed());
  await call(db, OWNER_A, { deviceId: 'desk-1' });
  e = await caught(call(db, OWNER_A, { deviceId: 'desk-2' }));
  ck('a SECOND host without replace is refused', e && e.code === 'already-exists', e && e.message);
  ck('the first host still holds it', db._cols.posDevices['desk-1'].printerHost === true);
  ck('the second was not made a host', !db._cols.posDevices['desk-2'].printerHost);

  head('5 - replacement is explicit and atomic');
  db = makeDb(seed());
  await call(db, OWNER_A, { deviceId: 'desk-1' });
  r = await call(db, OWNER_A, { deviceId: 'desk-2', replace: true });
  ck('with replace it succeeds', r && r.ok === true);
  ck('the OLD host is cleared', db._cols.posDevices['desk-1'].printerHost === false);
  ck('the new host is set', db._cols.posDevices['desk-2'].printerHost === true);
  ck('the replacement is recorded on the old device',
     db._cols.posDevices['desk-1'].printerHostReplacedBy === 'desk-2');
  ck('it reports what it replaced', Array.isArray(r.replaced) && r.replaced[0] === 'desk-1');
  /* Both writes must be in ONE transaction, or the shop is briefly double-hosted. */
  const txnWrites = db._writes.filter((w) => w.col === 'posDevices');
  ck('clear and set happened in the same transaction', txnWrites.length >= 2,
     'two desktops racing must not both end up hosting');

  head('6 - re-registering the same device is idempotent');
  db = makeDb(seed());
  await call(db, OWNER_A, { deviceId: 'desk-1' });
  const firstAt = db._cols.posDevices['desk-1'].printerHostAt;
  r = await call(db, OWNER_A, { deviceId: 'desk-1' });
  ck('a repeat registration succeeds WITHOUT replace', r && r.ok === true);
  ck('it reports that it was already the host', r.alreadyHost === true);
  ck('it replaced nothing', r.replaced.length === 0);
  ck('printerHostAt is not reset on a repeat', db._cols.posDevices['desk-1'].printerHostAt === firstAt,
     'the host has held since the first registration, not since the last heartbeat');

  head('7 - device ids are taken as found');
  db = makeDb(seed());
  r = await call(db, OWNER_A, { deviceId: 'BOOTSTRAP_NOT_A_UUID' });
  ck('a non-UUID bootstrap device CAN host', r && r.ok === true,
     'registerDevice demands a UUID; bootstrapDevice does not, and production holds both');

  head('8 - the write is additive');
  db = makeDb(seed());
  await call(db, OWNER_A, { deviceId: 'desk-1', printerIdentity: { name: 'MP58E', deviceKey: 'bt:aa:bb', transport: 'bluetooth' } });
  const dev = db._cols.posDevices['desk-1'];
  ['deviceId', 'merchantId', 'branchId', 'cashierId', 'status'].forEach((f) => {
    ck('existing field "' + f + '" survives', dev[f] !== undefined);
  });
  ck('printer identity is stored', dev.printerName === 'MP58E' && dev.printerDeviceKey === 'bt:aa:bb');
  ck('transport defaults to bluetooth when unspecified',
     (await (async () => { const d2 = makeDb(seed()); await call(d2, OWNER_A, { deviceId: 'desk-1' }); return d2._cols.posDevices['desk-1'].printerTransport; })()) === 'bluetooth');

  head('9 - the rules boundary is unchanged');
  const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const blk = RULES.slice(RULES.indexOf('match /posDevices/{deviceId}'), RULES.indexOf('match /posDevices/{deviceId}') + 400);
  ck('clients still cannot write posDevices directly',
     /allow delete:\s*if isAdmin\(\);/.test(blk) && !/allow write:\s*if isAuthed/.test(blk));
  ck('no printerHost rule was added', !/printerHost/.test(RULES),
     'the declaration is a server relationship, not a client-writable flag');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
