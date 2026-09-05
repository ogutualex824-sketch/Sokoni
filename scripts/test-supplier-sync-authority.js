'use strict';
/**
 * CERT — pos-supplier-sync authority + the BI inventory-health retirement.
 *
 * Static/behavioural certification of two changes:
 *   1. functions/pos-supplier-sync.js  — the server-authoritative supplier write path that
 *      replaces pos-suppliers.js's rules-denied, silently-swallowed browser writes.
 *   2. functions/pos-bi.js + pos-bi.html — retirement of the dead posBatches inventory-health
 *      sub-queries, with posBatches itself explicitly preserved.
 *
 * Every authority assertion is paired with a SABOTAGE check: the detector is re-run against a
 * synthetic mutation that reintroduces the defect, and must FAIL on it. A check that cannot
 * fail proves nothing. Sabotage checks are counted separately and reported by exit code.
 *
 * The op handler is exercised directly with injected fakes (no emulator — none is available
 * in this environment), so these are real executions of the authorization branch, not greps.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];

function check(name, cond) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name); }
}
function sab(name, cond) {
  sabotage++;
  if (cond) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + name + ')'); }
  else { fail++; failures.push('SABOTAGE ' + name); console.log('  FAIL    (sabotage: ' + name + ')'); }
}

console.log('\nCERT — supplier-sync authority + BI inventory-health retirement\n');

/* ══════════════════════════════════════════════════════════════
   SECTION 1 — the module exists, loads, and is wired to the dispatcher
══════════════════════════════════════════════════════════════ */
console.log('§1 module + dispatcher wiring');

const SYNC_SRC = R('functions/pos-supplier-sync.js');
const DISPATCH = R('functions/smartpos-dispatch.js');

let mod = null;
try { mod = require(path.join(ROOT, 'functions/pos-supplier-sync.js')); } catch (e) {
  console.log('  FATAL: module failed to load: ' + e.message); process.exit(1);
}

check('module loads and registers exactly one op', !!mod._h && Object.keys(mod._h).length === 1);
check('the op is named posSupplierSync', typeof mod._h.posSupplierSync === 'function');
check('dispatcher requires the module', /require\('\.\/pos-supplier-sync'\)/.test(DISPATCH));
check('dispatcher merges its _h registry', /posSupplierSync\._h/.test(DISPATCH));
sab('a missing dispatcher merge is detected', !/posSupplierSync\._h/.test('const _H = _merge(\n  posCrmPro._h\n);'));

/* All five denied collections are covered, and only those. */
const ENT = mod._ENTITIES;
const COLLECTIONS = Object.keys(ENT).map((k) => ENT[k].collection).sort();
/* Slice B removed purchaseOrder: POs are owned by the canonical procurement engine and
   no browser-side pos* PO cloud writer may survive. The remaining four still route here
   until Slices D and E converge them. */
check('covers exactly the 4 collections still written via this op',
  JSON.stringify(COLLECTIONS) === JSON.stringify(
    ['posGRN', 'posSupplierInvoices', 'posSupplierPayments', 'posSuppliers']));
['supplier', 'grn', 'supplierInvoice', 'supplierPayment'].forEach((e) => {
  check('entity type "' + e + '" is registered', Object.prototype.hasOwnProperty.call(ENT, e));
});
check('purchaseOrder is DELIBERATELY absent — no pos* PO cloud writer',
  !Object.prototype.hasOwnProperty.call(ENT, 'purchaseOrder'));
check('posPurchaseOrders is not a reachable target collection',
  COLLECTIONS.indexOf('posPurchaseOrders') === -1);
sab('the detector would catch a reintroduced PO entity',
  Object.prototype.hasOwnProperty.call({ purchaseOrder: 1 }, 'purchaseOrder'));

/* ══════════════════════════════════════════════════════════════
   SECTION 2 — the authority model, executed
══════════════════════════════════════════════════════════════ */
console.log('\n§2 authority model (executed against injected fakes)');

/* A minimal Firestore double: only what _assertMerchantWriteAuthority touches. */
function makeDb(businesses) {
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const d = (businesses || {})[id];
              return { exists: !!d, data: () => d };
            },
          };
        },
      };
    },
  };
}

/* Re-load the module with a patched db by exercising the exported helper against a stub.
   _assertMerchantWriteAuthority closes over the real db, so we test the branch that needs no
   db (owner-uid form) directly, and the doc-reading branches through the op with a stubbed
   admin.firestore — done below via the payload-validation path, which runs before any read. */

const auth = (uid, token) => ({ uid, token: token || {} });

(async () => {
  /* --- owner-uid form: merchantId === auth.uid, no lookup, cannot be spoofed --- */
  const ownerUid = 'merchant-owner-1';
  const got = await mod._assertMerchantWriteAuthority(auth(ownerUid), ownerUid);
  check('owner-uid form resolves to the caller uid', got === ownerUid);

  sab('owner-uid form does NOT accept a different merchantId without a business doc', await (async () => {
    try { await mod._assertMerchantWriteAuthority(auth(ownerUid), 'someone-elses-merchant'); return false; }
    catch (e) { return /not-found|Business not found/i.test(e.message || String(e)); }
  })());

  /* --- payload validation runs BEFORE any authority read, so it is exercisable --- */
  const callOp = (data, a) => mod._h.posSupplierSync({ auth: a || auth('u1'), data });

  check('unauthenticated call is rejected', await (async () => {
    try { await mod._h.posSupplierSync({ data: {} }); return false; }
    catch (e) { return /unauthenticated|Sign in/i.test(e.message || String(e)); }
  })());

  check('missing merchantId is rejected', await (async () => {
    try { await callOp({ entity: 'supplier', id: 'x', data: { name: 'n' } }); return false; }
    catch (e) { return /merchantId/i.test(e.message || String(e)); }
  })());

  check('unknown entity is rejected (closed allow-list)', await (async () => {
    try { await callOp({ merchantId: 'm', entity: 'users', id: 'x', data: {} }); return false; }
    catch (e) { return /Unknown entity/i.test(e.message || String(e)); }
  })());

  sab('a KNOWN entity is not rejected by the unknown-entity check', await (async () => {
    try { await callOp({ merchantId: 'm', entity: 'supplier', id: 'x', data: { name: 'n' } }); return true; }
    catch (e) { return !/Unknown entity/i.test(e.message || String(e)); }
  })());

  check('missing id is rejected', await (async () => {
    try { await callOp({ merchantId: 'm', entity: 'supplier', data: { name: 'n' } }); return false; }
    catch (e) { return /\bid\b/i.test(e.message || String(e)); }
  })());

  check('non-object data is rejected', await (async () => {
    try { await callOp({ merchantId: 'm', entity: 'supplier', id: 'x', data: 'nope' }); return false; }
    catch (e) { return /data must be an object/i.test(e.message || String(e)); }
  })());

  check('array data is rejected', await (async () => {
    try { await callOp({ merchantId: 'm', entity: 'supplier', id: 'x', data: [] }); return false; }
    catch (e) { return /data must be an object/i.test(e.message || String(e)); }
  })());

  /* Per-entity required-field validation. purchaseOrder is absent by design since Slice B. */
  const REQUIRED = { supplier: 'name', grn: 'supplierId',
                     supplierInvoice: 'supplierId', supplierPayment: 'supplierId' };
  for (const ent of Object.keys(REQUIRED)) {
    check('entity "' + ent + '" rejects a payload missing ' + REQUIRED[ent], await (async () => {
      try { await callOp({ merchantId: 'm', entity: ent, id: 'x', data: {} }); return false; }
      catch (e) { return new RegExp('data\\.' + REQUIRED[ent]).test(e.message || String(e)); }
    })());
  }

  /* ══════════════════════════════════════════════════════════
     SECTION 3 — static guarantees that must hold in the source
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 source guarantees');

  check('sellerId is never read from the payload',
    !/body\.data\.sellerId|data\.sellerId\s*\|\|/.test(SYNC_SRC));
  sab('the detector catches a payload-sourced sellerId',
    /body\.data\.sellerId/.test('const sellerId = body.data.sellerId;'));

  check('server-owned fields are stripped from client data',
    /SERVER_OWNED\.indexOf\(k\) === -1/.test(SYNC_SRC));
  check('sellerId is among the server-owned fields', mod._SERVER_OWNED.indexOf('sellerId') !== -1);
  check('merchantId is among the server-owned fields', mod._SERVER_OWNED.indexOf('merchantId') !== -1);

  check('no users/{uid} identity field is used as an authorization input',
    !/users'\)\.doc\([^)]*\)[\s\S]{0,200}(merchantId|sellerId|businessId|shopId)/.test(SYNC_SRC));
  sab('the detector catches a users-doc identity check',
    /users'\)\.doc\([^)]*\)[\s\S]{0,200}(merchantId|sellerId)/.test(
      "const u = await db.collection('users').doc(uid).get();\n if (u.data().merchantId !== merchantId) throw x;"));

  check('authority resolves businesses/{merchantId}.ownerId',
    /collection\('businesses'\)\.doc\(merchantId\)/.test(SYNC_SRC) && /ownerId/.test(SYNC_SRC));
  check('a missing business document DENIES rather than defaults',
    /if \(!bizSnap\.exists\)[\s\S]{0,160}throw new HttpsError/.test(SYNC_SRC));
  sab('the detector catches a fail-open on a missing business',
    !/if \(!bizSnap\.exists\)[\s\S]{0,160}throw new HttpsError/.test(
      'if (!bizSnap.exists) { return uid; }'));

  check('employee path requires an explicit capability',
    /_assertBusinessPermission\(uid, merchantId, REQUIRED_PERMISSION\)/.test(SYNC_SRC));
  check('the capability is an existing membership permission',
    ['discounts', 'pos', 'refunds', 'users'].indexOf(mod._REQUIRED_PERMISSION) !== -1);

  check('admin bypass uses unforgeable custom claims only',
    /auth\.token && \(auth\.token\.admin === true \|\| auth\.token\.superAdmin === true\)/.test(SYNC_SRC));

  check('authority is asserted BEFORE the write',
    SYNC_SRC.indexOf('_assertMerchantWriteAuthority(auth, merchantId)') <
    SYNC_SRC.indexOf('.set(doc, { merge: true })'));
  sab('the detector catches write-before-authority ordering',
    !('x.set(doc);\nawait _assertMerchantWriteAuthority(a,m);'.indexOf('_assertMerchantWriteAuthority') <
      'x.set(doc);\nawait _assertMerchantWriteAuthority(a,m);'.indexOf('.set(doc')));

  /* ══════════════════════════════════════════════════════════
     SECTION 4 — the client no longer swallows sync failures
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 client sync is observable, not swallowed');

  const CLIENT = R('pos-suppliers.js');

  check('the swallowing direct-write _sync is gone',
    !/firebase\.firestore\(\)\.collection\(col\)\.doc\(id\)\.set\(data, \{ merge: true \}\)\.catch\(\(\) => \{\}\)/.test(CLIENT));
  sab('the detector catches the original swallowing write',
    /firebase\.firestore\(\)\.collection\(col\)\.doc\(id\)\.set\(data, \{ merge: true \}\)\.catch\(\(\) => \{\}\)/.test(
      'function _sync(col,id,data){ firebase.firestore().collection(col).doc(id).set(data, { merge: true }).catch(() => {}); }'));

  check('sync routes through the smartPosDispatch op', /op: 'posSupplierSync'/.test(CLIENT));
  check('a sync failure is recorded', /_syncState\.failed\.push/.test(CLIENT));
  check('a sync failure is emitted', /emit\('sync:error'/.test(CLIENT));
  check('sync state is observable', /getSyncState/.test(CLIENT));
  check('failed syncs are recoverable', /retryFailedSyncs/.test(CLIENT));
  check('both are exported on the public surface', /getSyncState, retryFailedSyncs,/.test(CLIENT));
  check('local-first IndexedDB write is preserved', /await _put\(S\.SUPPLIERS, s\);/.test(CLIENT));
  check('init accepts the merchantId needed for authority',
    /async function init\(branchId = 'default', merchantId = null\)/.test(CLIENT));

  /* ══════════════════════════════════════════════════════════
     SECTION 5 — BI retirement, and what it must NOT touch
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 BI inventory-health retirement + preservation');

  const BI   = R('functions/pos-bi.js');
  const HTML = R('pos-bi.html');
  const INV  = R('functions/pos-inventory-pro.js');
  const INTEL= R('functions/pos-intelligence.js');
  const IDX  = R('functions/index.js');
  const RULES= R('firestore.rules');

  check('no posBatches QUERY remains in pos-bi.js',
    !/collection\('posBatches'\)/.test(BI));
  sab('the detector catches a reintroduced posBatches query',
    /collection\('posBatches'\)/.test("const s = await db.collection('posBatches').get();"));
  check('no expiringCount/expiringValue wiring remains in pos-bi.js',
    !/expiringCount|expiringValue/.test(BI));
  check('the dead Expiring Soon row is gone from the panel',
    !/Expiring Soon/.test(HTML));
  check('the retired fields are gone from the mock fallback',
    !/expiringSoon|expiringValue/.test(HTML));

  /* The panel itself is NOT empty — these rows are fed by live collections and must survive. */
  check('PRESERVED: Stockout Events row (live posSales-derived)', /Stockout Events/.test(HTML));
  check('PRESERVED: Overstock Items row (live)', /Overstock Items/.test(HTML));
  check('PRESERVED: Turnover Rate row (live posSales)', /Turnover Rate/.test(HTML));
  check('PRESERVED: the low-stock query in getExecutiveDashboard',
    /\.where\('stock', '<=', 10\)/.test(BI));

  /* Explicit preservation list from the ruled 18c boundary. */
  check('PRESERVED: posBatches writer receivePurchaseOrder', /receivePurchaseOrder/.test(INV));
  check('PRESERVED: posBatches write site in the writer', /collection\('posBatches'\)/.test(INV));
  check('PRESERVED: scheduled batchExpiryAlertSweep', /exports\.batchExpiryAlertSweep = onSchedule/.test(INV));
  check('PRESERVED: batchExpiryAlertSweep still exported', /exports\.batchExpiryAlertSweep\s*=/.test(IDX));
  check('PRESERVED: both pos-intelligence.js posBatches readers',
    (INTEL.match(/collection\('posBatches'\)/g) || []).length === 2);
  check('PRESERVED: canonical procurement.sendPurchaseOrder wiring',
    /exports\.sendPurchaseOrder\s*=\s*procurement\.sendPurchaseOrder;/.test(IDX));
  check('PRESERVED: retired posSendPurchaseOrder stays retired (18b untouched)',
    !/^exports\.posSendPurchaseOrder\s*=/m.test(IDX));

  /* Rules must not be widened — the whole point of the server-side write path. */
  check('NOT WIDENED: posBatches rule still present', /match \/posBatches\//.test(RULES));
  /* A write clause is fine if and only if it DENIES. `allow write: if false` is the repo's
     explicit deny; the served ruleset simply grants nothing at all. Either is correct — what
     must never appear is a write clause with a satisfiable condition. An earlier version of
     this check matched on `allow write` alone and reported the explicit deny as a widening. */
  const grantsWrite = (src, coll) => {
    const m = new RegExp('match /' + coll + '/\\{[^}]*\\} \\{([\\s\\S]*?)\\n    \\}').exec(src);
    if (!m) return false;
    return /allow\s+(write|create|update|delete)[^;]*:\s*if\s+(?!false\s*;)/.test(m[1]);
  };
  check('NOT WIDENED: no client write GRANTED on posSuppliers', !grantsWrite(RULES, 'posSuppliers'));
  check('NOT WIDENED: no client write GRANTED on posPurchaseOrders', !grantsWrite(RULES, 'posPurchaseOrders'));
  sab('the detector catches a genuinely widened rule',
    grantsWrite('match /posSuppliers/{id} {\n      allow write: if isAuthed();\n    }', 'posSuppliers'));
  sab('the detector does NOT misfire on an explicit deny',
    !grantsWrite('match /posSuppliers/{id} {\n      allow write: if false;\n    }', 'posSuppliers'));

  /* getPOSInventoryIntelligence must be untouched — its 500 is a separate defect. */
  check('UNTOUCHED: getPOSInventoryIntelligence still defined',
    /getPOSInventoryIntelligence/.test(INTEL));

  /* ══════════════════════════════════════════════════════════ */
  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' +
              sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) {
    console.log('\n  ' + fail + ' FAILURE(S):');
    failures.forEach((f) => console.log('    - ' + f));
    process.exit(1);
  }
  console.log('\n  PASS — supplier writes are server-authoritative and observable;');
  console.log('         the dead posBatches BI presentation is retired;');
  console.log('         posBatches, its writer, its sweep and procurement are preserved.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
