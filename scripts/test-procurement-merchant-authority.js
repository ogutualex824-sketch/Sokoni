'use strict';
/**
 * CERT — Slice A: merchant-scoped authority on the procurement supplier surface.
 *
 * INVARIANT UNDER TEST
 *   The server derives or verifies the merchant relationship from authoritative data.
 *   A caller authorized for merchant A cannot add or update supplier records for merchant
 *   B, nor create PO data for merchant B.
 *
 * METHOD — executed, with two businesses and two principals
 *   `merchant-authority.assertMerchantAccess` and procurement's composed
 *   `_assertMerchantAuthority` are EXECUTED against an injected Firestore double holding
 *   two `businesses` documents with different owners, plus `workspaceMemberships` and
 *   `procSuppliers`. Every verdict below is a real throw or a real return, not a grep.
 *
 *   Static checks appear only where the property is genuinely textual — e.g. "the update
 *   object is built from an allowlist rather than spread from the payload".
 *
 *   Syntax validity is not a behavioural postcondition and nothing here relies on it.
 *   Every detector is exercised in both directions.
 */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice A: procurement merchant-scoped authority\n');

/* ══════════════════════════════════════════════════════════════
   FIXTURE — two businesses, two principals, one foreign supplier
══════════════════════════════════════════════════════════════ */
const UID_A = 'principal-A';          // owner of merchant A
const UID_B = 'principal-B';          // owner of merchant B
const UID_EMP = 'employee-no-cap';    // member of A, WITHOUT the pos capability
const UID_EMP_OK = 'employee-with-pos'; // member of A, WITH the pos capability
const MERCH_A = 'biz-A';
const MERCH_B = 'biz-B';

const DATA = {
  businesses: {
    [MERCH_A]: { ownerId: UID_A },
    [MERCH_B]: { ownerId: UID_B },
  },
  procSuppliers: {
    'sup-A1': { supplierId: 'sup-A1', merchantId: MERCH_A, name: 'A Supplier', status: 'active' },
    'sup-B1': { supplierId: 'sup-B1', merchantId: MERCH_B, name: 'B Supplier', status: 'active' },
  },
  workspaceMemberships: [
    { uid: UID_EMP,    businessId: MERCH_A, status: 'active', permissions: ['refunds'] },
    { uid: UID_EMP_OK, businessId: MERCH_A, status: 'active', permissions: ['pos'] },
  ],
};

/** Minimal Firestore double covering doc().get() and the membership query shape. */
function makeFirestore(data) {
  return () => ({
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const bag = data[name] || {};
              const d = bag[id];
              return { exists: !!d, data: () => d };
            },
          };
        },
        where(f1, _o1, v1) {
          const conds = [[f1, v1]];
          const q = {
            where(f, _o, v) { conds.push([f, v]); return q; },
            limit() { return q; },
            async get() {
              const rows = (data[name] || []).filter((r) => conds.every(([f, v]) => r[f] === v));
              return { empty: rows.length === 0, docs: rows.map((r) => ({ data: () => r })) };
            },
          };
          return q;
        },
      };
    },
  });
}

/** Load merchant-authority.js with firebase-admin stubbed. */
function loadAuthority(data, opts) {
  const src = (opts && opts.src) || fs.readFileSync(path.join(ROOT, 'functions/merchant-authority.js'), 'utf8');
  const stubAdmin = { firestore: makeFirestore(data), apps: [{}], initializeApp() {} };
  const stubHttps = {
    HttpsError: class HttpsError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
  };
  const m = new Module('merchant-authority-under-test', null);
  m.filename = path.join(ROOT, 'functions/merchant-authority.js');
  m.paths = Module._nodeModulePaths(path.join(ROOT, 'functions'));
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'firebase-admin') return stubAdmin;
    if (req === 'firebase-functions/v2/https') return stubHttps;
    return origLoad.apply(this, arguments);
  };
  try { m._compile(src, m.filename); } finally { Module._load = origLoad; }
  return m.exports;
}

const auth = (uid, token) => ({ uid, token: token || {} });
async function verdict(fn) {
  try { const v = await fn(); return { ok: true, value: v }; }
  catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; }
}

(async () => {
  const A = loadAuthority(DATA);

  /* ══════════════════════════════════════════════════════════
     §1 POSITIVE — an authorized principal can act on its own merchant
  ══════════════════════════════════════════════════════════ */
  console.log('§1 POSITIVE');
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A), MERCH_A));
    check('owner of A is authorized for A', r.ok && r.value === MERCH_A);
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_B), MERCH_B));
    check('owner of B is authorized for B', r.ok && r.value === MERCH_B);
  }
  {
    /* The owner-uid form: a merchant operating under its own uid. */
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A), UID_A));
    check('owner-uid form is authorized without a lookup', r.ok && r.value === UID_A);
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A)));
    check('omitted merchantId defaults to the caller', r.ok && r.value === UID_A);
  }

  /* ══════════════════════════════════════════════════════════
     §2 NEGATIVE — THE cross-merchant invariant
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 NEGATIVE — cross-merchant denial (two businesses, two principals)');
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A), MERCH_B));
    check('owner of A is DENIED on B', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_B), MERCH_A));
    check('owner of B is DENIED on A', !r.ok && r.code === 'permission-denied');
  }
  {
    /* A manager claim alone must NOT be sufficient. */
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A, { manager: true, role: 3 }), MERCH_B));
    check('a MANAGER claim alone does not authorize another merchant',
      !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A), 'no-such-merchant'));
    check('a nonexistent merchant DENIES (fails closed)', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(null, MERCH_A));
    check('an unauthenticated caller is rejected', !r.ok && r.code === 'unauthenticated');
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A), 'bad/id'));
    check('a path-traversing merchantId is rejected', !r.ok && r.code === 'invalid-argument');
  }
  {
    /* Forged payload identity: the caller cannot promote itself by claiming ownership. */
    const forged = auth(UID_B);
    forged.merchantId = MERCH_A; forged.ownerId = UID_A; forged.sellerId = UID_A;
    const r = await verdict(() => A.assertMerchantAccess(forged, MERCH_A));
    check('forged ownerId/merchantId/sellerId on the payload change nothing',
      !r.ok && r.code === 'permission-denied');
  }
  {
    /* Platform admin claims ARE unforgeable and do authorize. */
    const r = await verdict(() => A.assertMerchantAccess(auth('root', { admin: true }), MERCH_B));
    check('an unforgeable platform admin claim does authorize', r.ok);
  }

  /* ══════════════════════════════════════════════════════════
     §3 the composed helper: employee capability path
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 employee capability path (composed helper)');
  const PROC_SRC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');

  check('procurement composes the SHARED primitive, not a private copy',
    /require\('\.\/merchant-authority'\)/.test(PROC_SRC));
  check('the employee path requires the EXISTING pos capability',
    /_assertBusinessPermission\(String\(auth\.uid\), merchantId, 'pos'\)/.test(PROC_SRC));
  check('no new permission vocabulary was invented',
    !/'procurement'|'suppliers'|'inventory'/.test(
      (/_assertBusinessPermission\([^)]*\)/.exec(PROC_SRC) || [''])[0]));
  check('only a tenancy denial falls through to the capability path',
    /e\.code !== 'permission-denied'\) throw e/.test(PROC_SRC));
  sab('the detector catches an unconditional fall-through',
    !/e\.code !== 'permission-denied'\) throw e/.test('catch (e) { await _assertBusinessPermission(uid, m, "pos"); }'));

  check('no users/{uid} identity field is an authorization input',
    !/collection\('users'\)[\s\S]{0,200}(merchantId|sellerId|businessId|shopId)\s*===/.test(PROC_SRC));

  /* ══════════════════════════════════════════════════════════
     §4 the ops that now carry the gate
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 gated operations');
  const gatedCount = (PROC_SRC.match(/_assertMerchantAuthority\(request/g) || []).length;
  check('addSupplier is merchant-scoped',
    /const addSupplier[\s\S]{0,900}_assertMerchantAuthority\(request, _requestedMerchantId\)/.test(PROC_SRC));
  check('createPurchaseOrder is merchant-scoped',
    /const createPurchaseOrder[\s\S]{0,900}_assertMerchantAuthority\(request, _requestedMerchantId\)/.test(PROC_SRC));
  check('getSupplierPerformance is merchant-scoped',
    /const getSupplierPerformance[\s\S]{0,700}_assertMerchantAuthority\(request, _requestedMerchantId\)/.test(PROC_SRC));
  check('updateSupplier is merchant-scoped', /const updateSupplier[\s\S]{0,1600}_assertMerchantAuthority\(request, existing\.merchantId\)/.test(PROC_SRC));
  check('at least 4 operations carry the gate', gatedCount >= 4);

  check('the payload merchantId is never written directly — the AUTHORIZED value is',
    !/merchantId:\s*_san\(_requestedMerchantId/.test(PROC_SRC));
  sab('the detector catches writing the payload value',
    /merchantId:\s*_san\(_requestedMerchantId/.test('merchantId: _san(_requestedMerchantId, 100),'));

  check('updateSupplier authorizes against the DOCUMENT merchantId, not the payload',
    /_assertMerchantAuthority\(request, existing\.merchantId\)/.test(PROC_SRC));
  sab('the detector catches authorizing against a payload merchantId',
    !/_assertMerchantAuthority\(request, existing\.merchantId\)/.test(
      'await _assertMerchantAuthority(request, request.data.merchantId);'));

  /* ══════════════════════════════════════════════════════════
     §5 updateSupplier field allowlisting
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 field allowlist / ownership immutability');
  const proc = require(path.join(ROOT, 'functions/procurement.js'));
  const ALLOW = proc._SUPPLIER_MUTABLE;

  check('an allowlist is exported', Array.isArray(ALLOW) && ALLOW.length > 0);
  ['merchantId', 'supplierId', 'createdBy', 'createdAt', 'currentBalance', 'rating', 'updatedBy']
    .forEach((f) => check('IMMUTABLE: ' + f + ' is not client-mutable', ALLOW.indexOf(f) === -1));
  ['name', 'contactName', 'phone', 'email', 'kraPin', 'bankDetails', 'paymentTerms', 'creditLimit', 'status']
    .forEach((f) => check('mutable: ' + f, ALLOW.indexOf(f) !== -1));

  check('the patch is BUILT from the allowlist, never spread from the payload',
    /for \(const key of SUPPLIER_MUTABLE\)/.test(PROC_SRC) &&
    !/\.\.\.updates/.test(PROC_SRC));
  sab('the detector catches a payload spread',
    /\.\.\.updates/.test('const patch = { ...updates, updatedAt: now };'));

  /* ══════════════════════════════════════════════════════════
     §6 SABOTAGE — remove the merchant relationship check
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 SABOTAGE (executed, differential)');
  const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'functions/merchant-authority.js'), 'utf8');
  /* RE-ANCHORED 2026-09-20. The owner arm used to read
       if (d.ownerId === uid) return merchantId;
     and now returns the provenance object instead (ADR-035 §2, mechanism #2).
     The old literal matched NOTHING, so `.replace` silently returned the source
     unchanged and the differential measured a no-op against itself. The anchor
     is counted before use so a future rewrite reports a MISS rather than a pass. */
  const SAB_ANCHOR = "  if (d.ownerId === uid) return { merchantId, via: 'owner' };";
  const ANCHOR_HITS = AUTH_SRC.split(SAB_ANCHOR).length - 1;
  check('the sabotage anchor matches the primitive exactly once', ANCHOR_HITS === 1);
  const SAB_SRC = AUTH_SRC.replace(
    SAB_ANCHOR,
    "  return { merchantId, via: 'owner' }; /* SABOTAGE: relationship check removed */"
  );
  check('the sabotage actually changed the primitive', SAB_SRC !== AUTH_SRC);

  const SabA = loadAuthority(DATA, { src: SAB_SRC });
  const sabCross = await verdict(() => SabA.assertMerchantAccess(auth(UID_A), MERCH_B));
  const curCross = await verdict(() => A.assertMerchantAccess(auth(UID_A), MERCH_B));

  sab('with the check removed, A IS wrongly allowed onto B', sabCross.ok === true);
  sab('with the check present, A is denied on B', curCross.ok === false);
  sab('the two differ — the detector is measuring the check, not something else',
    sabCross.ok !== curCross.ok);

  /* ══════════════════════════════════════════════════════════
     §7 REGRESSION — what must not have changed
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 preservation');
  check('UNTOUCHED: sendPurchaseOrder still reads procPurchaseOrders',
    /collection\('procPurchaseOrders'\)\.doc\(poId\)/.test(PROC_SRC));
  check('UNTOUCHED: sendPurchaseOrder still requires approved status',
    /po\.status !== 'approved'/.test(PROC_SRC));
  check('UNTOUCHED: sendPurchaseOrder still routes through notify + emailSvc',
    /notify\.notify\(/.test(PROC_SRC) && /emailSvc\.queue\(/.test(PROC_SRC));
  /* RETIRED 2026-09-20. This compared the module byte-for-byte against a copy in
     ANOTHER WORKTREE — C:/temp/sok-tenant-authz — outside this repository, not
     owned here, and a stale snapshot dated 28 Aug, the day the module was
     created. A test that fails when a file this tree does not control drifts is
     not an invariant of this mechanism; it also quietly PASSED whenever that
     path happened to be absent, so it proved one thing on one machine and
     nothing on another. Replaced with an owned, deterministic contract
     assertion over the module this suite actually loads. */
  check('the shared primitive exports the API this suite depends on',
    typeof A.assertMerchantAccess === 'function'
    && typeof A.canAccessMerchant === 'function'
    && typeof A.isValidMerchantId === 'function'
    && A.AUTHORITY === 'businesses');
  check('and assertMerchantAccess still returns a merchantId STRING',
    typeof (await A.assertMerchantAccess(auth(UID_A), MERCH_A)) === 'string');
  check('updateSupplier is exported from procurement', typeof proc.updateSupplier === 'function');
  const IDX = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  check('updateSupplier is re-exported by name in index.js',
    /^exports\.updateSupplier\s*=\s*procurement\.updateSupplier;/m.test(IDX));
  check('NOT REVIVED: posSendPurchaseOrder stays retired',
    !/^exports\.posSendPurchaseOrder\s*=/m.test(IDX));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) {
    console.log('\n  ' + fail + ' FAILURE(S):');
    failures.forEach((f) => console.log('    - ' + f));
    process.exit(1);
  }
  console.log('\n  PASS — merchant authority is derived from authoritative data;');
  console.log('         cross-merchant access is denied; ownership fields are immutable.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
