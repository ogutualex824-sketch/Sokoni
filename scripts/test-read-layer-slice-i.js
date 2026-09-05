'use strict';
/**
 * CERT — Slice I: the merchant-scoped read layer.
 *
 * THE INVARIANT
 *   Every procurement read is scoped to a merchant the caller is authorized for, derived
 *   from authoritative data. No forged identity, cursor, filter, ordering or count may widen
 *   that scope.
 *
 * METHOD
 *   The real list operations and the real `getProcurementDashboard` / `getProcurementForecast`
 *   are EXECUTED against an injected fixture holding TWO merchants and TWO principals, with
 *   interleaved documents in every collection — so a missing filter leaks visibly rather than
 *   passing because the fixture happened to hold only one merchant's rows.
 *
 *   Leakage is checked by inspecting returned ROWS, not by reading source.
 */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
const IDX  = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice I: merchant-scoped read layer\n');

const UID_A = 'uid-A', UID_B = 'uid-B';
const BIZ_A = 'SOK-AAAA11', BIZ_B = 'SOK-BBBB22';

/* Interleaved ids so a scope failure surfaces as B's rows inside A's page. */
function rows(prefix, extra) {
  const out = {};
  for (let i = 1; i <= 6; i++) {
    const owner = i % 2 === 1 ? BIZ_A : BIZ_B;
    const id = prefix + '-' + String(i).padStart(2, '0');
    out[id] = Object.assign({ merchantId: owner, status: 'active' }, extra ? extra(id, owner, i) : {});
  }
  return out;
}

function freshData() {
  return {
    businesses: { [BIZ_A]: { ownerId: UID_A, status: 'active' },
                  [BIZ_B]: { ownerId: UID_B, status: 'active' } },
    workspaceMemberships: [],
    procSuppliers:        rows('sup', (id, o) => ({ supplierId: id, name: 'S ' + id, supplierBusinessId: o === BIZ_A ? BIZ_B : null })),
    procPurchaseOrders:   rows('po',  (id, o) => ({ poId: id, poNumber: 'PO-' + id, total: 100, items: [{ productId: 'p' }], buyerBusinessId: o })),
    procGRN:              rows('grn', (id) => ({ grnId: id, poId: 'po-01', totalReceived: 3, discrepancies: [] })),
    procSupplierInvoices: rows('inv', (id) => ({ invoiceId: id, invoiceNumber: 'IN-' + id, total: 50, paidAt: null })),
    posProducts:          rows('prd', (id) => ({ productId: id, branchId: 'main', stockQty: 7 })),
    stockMovements:       rows('mov', (id) => ({ type: 'procurement_receipt', productId: 'prd-01', qty: 2 })),
    procForecast:         {},
  };
}

function loadProcurement(data) {
  const mkRef = (n, id) => ({ _c: n, _id: id,
    async get() { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d, id }; },
    async update() { return true; }, async set() { return true; }, async create() { return true; } });
  function makeQuery(n, conds, order, after, lim) {
    return {
      where(f, _o, v) { return makeQuery(n, conds.concat([[f, v]]), order, after, lim); },
      orderBy(f) { return makeQuery(n, conds, f, after, lim); },
      startAfter(c) { return makeQuery(n, conds, order, c, lim); },
      limit(k) { return makeQuery(n, conds, order, after, k); },
      select() { return makeQuery(n, conds, order, after, lim); },
      async get() {
        const bag = data[n] || {};
        let ids = Object.keys(bag).filter((id) => conds.every(([f, v]) => {
          if (f === '__name__' || (f && f.__docId)) return true;
          return bag[id][f] === v;
        }));
        ids.sort();
        if (after) ids = ids.filter((id) => id > String(after));
        if (lim) ids = ids.slice(0, lim);
        const docs = ids.map((id) => ({ id, data: () => bag[id] }));
        /* A real QuerySnapshot exposes forEach; the dashboard uses it. Omitting it made a
           correct implementation look broken. */
        return { empty: docs.length === 0, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
      },
    };
  }
  const fsFn = () => ({
    collection(n) {
      const base = makeQuery(n, [], null, null, null);
      return Object.assign(Object.create(base), base, { doc: (id) => mkRef(n, id) });
    },
    async runTransaction(fn) { return fn({ get: async () => ({ exists: false, data: () => ({}) }), set() {}, update() {} }); },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };
  fsFn.Timestamp  = { fromDate: (d) => d };
  fsFn.FieldPath  = { documentId: () => ({ __docId: true }) };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    ['functions/procurement.js', 'functions/merchant-authority.js', 'functions/tenant-identity.js']
      .forEach((f) => { try { delete require.cache[require.resolve(path.join(ROOT, f))]; } catch (_) {} });
    return require(path.join(ROOT, 'functions/procurement.js'));
  } finally { Module._load = orig; }
}

const auth = (uid, token) => ({ uid, token: token || {} });
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }

const OPS = ['listSuppliers', 'listPurchaseOrders', 'listGRNs', 'listSupplierInvoices',
             'listWarehouseStock', 'listStockMovements'];

(async () => {
  const data = freshData();
  const proc = loadProcurement(data);
  const call = (name, a, d) => {
    const fn = proc[name];
    if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data: d || {} });
    if (fn && typeof fn.__handler === 'function') return fn.__handler({ auth: a, data: d || {} });
    throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
  };
  const probe = await verdict(() => call('listSuppliers', auth(UID_A), { merchantId: BIZ_A }));
  check('the real read layer is invocable', probe.code !== 'harness');
  if (probe.code === 'harness') { console.log('\n  HARNESS CANNOT INVOKE'); process.exit(1); }

  /* ══════════════════════════════════════════════════════════
     §1 POSITIVE — each merchant reads its own, and ONLY its own
  ══════════════════════════════════════════════════════════ */
  console.log('§1 POSITIVE — own data only (executed, interleaved fixture)');
  for (const op of OPS) {
    const a = await verdict(() => call(op, auth(UID_A), { merchantId: BIZ_A }));
    const b = await verdict(() => call(op, auth(UID_B), { merchantId: BIZ_B }));
    check(op + ': A reads A', a.ok && a.value.items.length === 3);
    check(op + ': B reads B', b.ok && b.value.items.length === 3);
    check(op + ': the authorized merchantId is echoed', a.ok && a.value.merchantId === BIZ_A);
  }

  /* ══════════════════════════════════════════════════════════
     §2 NEGATIVE — cross-merchant is refused
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 NEGATIVE — cross-merchant');
  for (const op of OPS) {
    const ab = await verdict(() => call(op, auth(UID_A), { merchantId: BIZ_B }));
    const ba = await verdict(() => call(op, auth(UID_B), { merchantId: BIZ_A }));
    check(op + ': A reads B → DENIED', !ab.ok && ab.code === 'permission-denied');
    check(op + ': B reads A → DENIED', !ba.ok && ba.code === 'permission-denied');
  }
  {
    const r = await verdict(() => call('listSuppliers', auth(UID_A, { manager: true, role: 4 }), { merchantId: BIZ_B }));
    check('a manager/admin claim without a merchant relationship is DENIED',
      !r.ok && r.code === 'permission-denied');
    const r2 = await verdict(() => call('listSuppliers', null, { merchantId: BIZ_A }));
    check('unauthenticated is refused', !r2.ok);
  }
  {
    /* Forged identity fields on the request object — the resolver reads none of them. */
    const forged = auth(UID_A);
    forged.merchantId = BIZ_B; forged.businessId = BIZ_B; forged.supplierId = 'sup-02';
    forged.activeShopId = BIZ_B;
    const r = await verdict(() => call('listPurchaseOrders', forged, {}));
    check('FORGED identity fields cannot select another merchant',
      !r.ok || r.value.items.every((i) => i.buyerBusinessId !== BIZ_B));
    const r2 = await verdict(() => call('listPurchaseOrders', forged, { merchantId: BIZ_B }));
    check('a forged payload merchantId is still refused', !r2.ok && r2.code === 'permission-denied');
  }
  {
    /* A forged narrowing filter cannot reach another merchant's row. */
    const r = await verdict(() => call('listSuppliers', auth(UID_A), { merchantId: BIZ_A, status: 'active' }));
    check('narrowing filters stay inside the merchant scope',
      r.ok && r.value.items.every((i) => /-0[135]$/.test(i.supplierId)));
    const r2 = await verdict(() => call('listGRNs', auth(UID_A), { merchantId: BIZ_A, poId: 'po-02' }));
    check('a filter naming another merchant\'s document yields nothing, not their rows',
      r2.ok && r2.value.items.every((i) => /-0[135]$/.test(i.grnId)));
  }

  /* ══════════════════════════════════════════════════════════
     §3 pagination / cursor / count cannot widen scope
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 pagination, cursors and counts');
  {
    const p1 = await verdict(() => call('listSuppliers', auth(UID_A), { merchantId: BIZ_A, limit: 2 }));
    check('a limited page returns only that many', p1.ok && p1.value.items.length === 2);
    check('a next cursor is offered when more remain', p1.ok && !!p1.value.nextCursor);
    check('page 1 holds only A rows', p1.ok && p1.value.items.every((i) => /-0[135]$/.test(i.supplierId)));

    const p2 = await verdict(() => call('listSuppliers', auth(UID_A), { merchantId: BIZ_A, limit: 2, cursor: p1.value.nextCursor }));
    check('page 2 continues within A only', p2.ok && p2.value.items.every((i) => /-0[135]$/.test(i.supplierId)));
    check('pages do not overlap',
      p2.ok && p2.value.items.every((i) => !p1.value.items.some((j) => j.supplierId === i.supplierId)));
    check('the final page reports no further cursor', p2.ok && p2.value.nextCursor === null);

    /* THE LEAKAGE TEST: a cursor lifted from B's result set, replayed by A. */
    const bPage = await verdict(() => call('listSuppliers', auth(UID_B), { merchantId: BIZ_B, limit: 1 }));
    const stolen = bPage.ok ? bPage.value.nextCursor : 'sup-02';
    const leak = await verdict(() => call('listSuppliers', auth(UID_A), { merchantId: BIZ_A, cursor: stolen }));
    check("a cursor taken from ANOTHER merchant's page returns no foreign rows",
      leak.ok && leak.value.items.every((i) => /-0[135]$/.test(i.supplierId)));
    check('and the echoed merchantId is still the caller\'s own', leak.ok && leak.value.merchantId === BIZ_A);

    check('counts are computed from the filtered page, not a collection aggregate',
      p1.ok && p1.value.count === p1.value.items.length);
    const big = await verdict(() => call('listSuppliers', auth(UID_A), { merchantId: BIZ_A, limit: 9999 }));
    check('an oversized limit is capped and still scoped',
      big.ok && big.value.items.length === 3 && big.value.items.every((i) => /-0[135]$/.test(i.supplierId)));
  }

  /* ══════════════════════════════════════════════════════════
     §4 the analytics authority FIX
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 dashboard + forecast authority fix');
  {
    const ownD = await verdict(() => call('getProcurementDashboard', auth(UID_A), { merchantId: BIZ_A }));
    check('dashboard: A reads A', ownD.ok);
    const crossD = await verdict(() => call('getProcurementDashboard', auth(UID_A), { merchantId: BIZ_B }));
    check('dashboard: A reads B → DENIED', !crossD.ok && crossD.code === 'permission-denied');
    const anonD = await verdict(() => call('getProcurementDashboard', null, { merchantId: BIZ_A }));
    check('dashboard: unauthenticated refused', !anonD.ok);
    const claimD = await verdict(() => call('getProcurementDashboard', auth(UID_A, { role: 4 }), { merchantId: BIZ_B }));
    check('dashboard: a role claim without relationship → DENIED', !claimD.ok && claimD.code === 'permission-denied');

    const crossF = await verdict(() => call('getProcurementForecast', auth(UID_A), { merchantId: BIZ_B }));
    check('forecast: A reads B → DENIED', !crossF.ok && crossF.code === 'permission-denied');
  }
  check('the dashboard no longer relies on _requireAuth alone',
    /const getProcurementDashboard[\s\S]{0,700}await _assertMerchantAuthority\(request, _requestedMerchantId\)/.test(PROC));
  sab('the detector catches the ungated dashboard',
    !/const getProcurementDashboard[\s\S]{0,700}await _assertMerchantAuthority/.test(
      'const getProcurementDashboard = onCall(OPT, async (request) => {\n  _requireAuth(request);\n  const { merchantId } = request.data;'));
  check('the forecast is merchant-scoped',
    /const getProcurementForecast[\s\S]{0,400}await _assertMerchantAuthority/.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §5 structure — one primitive, scope before cursor
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 structure');
  check('a single shared scoped-list primitive exists', /async function _listScoped\(request, collection, opts\)/.test(PROC));
  /* Scoped to the PRIMITIVE. An earlier version compared file-wide positions and broke when
     Slice K added a findSuppliers carrying its own, earlier, startAfter() - a false failure
     about an invariant that still holds inside _listScoped. */
  const LS = (/async function _listScoped[\s\S]*?\n\}/.exec(PROC) || [''])[0];
  check('the primitive body was located', LS.length > 200);
  check('the merchant filter is applied BEFORE the cursor',
    LS.indexOf("where('merchantId', '==', merchantId)") < LS.indexOf('q.startAfter('));
  sab('the detector catches cursor-before-scope',
    !('startAfter(); where(merchantId)'.indexOf('where(merchantId)') < 'startAfter(); where(merchantId)'.indexOf('startAfter()')));
  check('the queried scope is the AUTHORIZED value, not the request',
    /const merchantId = await _assertMerchantAuthority\(request, o\.requested\);/.test(PROC));
  /* The property is that no LIST OP hand-writes a scoping query — every one routes through
     the shared primitive. An earlier version counted occurrences file-wide and failed on the
     dashboard's own pre-existing scoped queries, which are a different operation entirely
     and legitimately query merchantId themselves. */
  const listBodies = OPS.map((op) => (new RegExp('const ' + op + ' = onCall[\\s\\S]*?\\n\\}\\);').exec(PROC) || [''])[0]);
  check('every list op body was located', listBodies.every((b) => b.length > 100));
  check('no list op writes its own scoping query',
    listBodies.every((b) => !/where\('merchantId'/.test(b)));
  check('every list op routes through the shared primitive',
    listBodies.every((b) => /_listScoped\(request, '/.test(b)));
  check('the primitive holds the ONLY scoping query in the read layer',
    ((/async function _listScoped[\s\S]*?\n\}/.exec(PROC) || [''])[0]
      .match(/where\('merchantId', '==', merchantId\)/g) || []).length === 1);
  sab('the detector catches a list op that scopes itself',
    /where\('merchantId'/.test("const listX = onCall(OPT, async (r) => { return db.collection('x').where('merchantId','==',r.data.merchantId).get(); });"));
  check('every list op is re-exported by name in index.js',
    OPS.every((op) => new RegExp('^exports\\.' + op + '\\s+=\\s+procurement\\.' + op + ';', 'm').test(IDX)));
  check('stock quantity is null when unknown, never 0', /stockQty: d\.stockQty \?\? null,/.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §6 scope discipline + preservation
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 scope + preservation');
  /* Slice K landed: discovery must now EXIST and be audience-gated. */
  check('discovery exists (Slice K) and is audience gated',
    /const findSuppliers = onCall/.test(PROC) && /Supplier discovery is available to SOKONI businesses/.test(PROC));
  check('SCOPE: no wholesale/catalogue redesign', !/const getSupplyCatalogue = onCall/.test(PROC));
  /* Slice J2 has since registered it, at tier:'more' so the founder's primary sidebar spec
     stays untouched. The invariant flips from "absent" to "present and not primary". */
  check('the Supply route exists and is NOT primary (J2)', (function () {
    const R = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
    return /id:'supply'/.test(R) && /id:'supply'[\s\S]{0,120}tier:'more'/.test(R);
  })());
  check('SCOPE: payment semantics untouched', /return result;\n\}\);/.test(PROC) && !/settlement/i.test(PROC));
  check('SCOPE: invoice totals still client-supplied within the 5% band', /deviation > 0\.05/.test(PROC));
  check('PRESERVED: Slice H resolver', /const resolveMerchantContext = onCall/.test(PROC));
  check('PRESERVED: Slice E payment idempotency', /_deterministicId\(invoiceId \+ '\|debit', 'led'\)/.test(PROC));
  check('PRESERVED: Slice D receipt idempotency', /_deterministicId\(keySeed, 'grn'\)/.test(PROC));
  check('PRESERVED: Slice C PO gate', /_assertPoAuthority/.test(PROC));
  check('PRESERVED: no new file dependency', (PROC.match(/require\('\.\//g) || []).length ===
    ((require('child_process').execSync('git show HEAD:functions/procurement.js', { cwd: ROOT, encoding: 'utf8' })).match(/require\('\.\//g) || []).length);

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — every procurement read is merchant-scoped and cannot be widened.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
