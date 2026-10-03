'use strict';
/**
 * CERT — Slice B2: SOKONI supply relationships.
 *
 * INVARIANTS UNDER TEST
 *   1. businesses/{id} is the ONE canonical identity on both sides — no duplicate supplier
 *      account is created for a business already on SOKONI.
 *   2. Supply participation is an EXPLICIT, server-authoritative business-level opt-in. It
 *      is never inferred from owning products or from wholesaleEnabled on a product.
 *   3. A supplier relationship may name an on-SOKONI business, verified (exists AND opted
 *      in), while external suppliers keep their contact fields.
 *   4. Buyer-side and supplier-side authority are INDEPENDENT. Authority for merchant A
 *      must not confer supplier-side access to B's inbound orders, or the reverse.
 *   5. Ownership fields are unreachable from any client payload.
 *
 * METHOD
 *   The real authority functions are EXECUTED against an injected Firestore double holding
 *   two businesses, two principals, and a third business that has NOT opted in. Static
 *   checks appear only where the property is genuinely textual. Every detector is exercised
 *   in both directions; syntax validity proves nothing and is not relied upon.
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

console.log('\nCERT — Slice B2: SOKONI supply relationships\n');

/* ══════════════════════════════════════════════════════════════
   FIXTURE — two principals; A supplies, B buys, C has NOT opted in
══════════════════════════════════════════════════════════════ */
const UID_A = 'principal-A', UID_B = 'principal-B';
const BIZ_A = 'SOK-AAAA11';   // opted IN to supply
const BIZ_B = 'SOK-BBBB22';   // buyer, has NOT opted in
const BIZ_C = 'SOK-CCCC33';   // exists, supply absent entirely

const DATA = {
  businesses: {
    [BIZ_A]: { ownerId: UID_A, supply: { enabled: true, displayName: 'A Supplies' } },
    [BIZ_B]: { ownerId: UID_B },
    [BIZ_C]: { ownerId: UID_A, supply: { enabled: false } },
  },
  workspaceMemberships: [],
};

function makeFirestore(data) {
  return () => ({
    collection(name) {
      return {
        doc(id) {
          return {
            async get() { const bag = data[name] || {}; const d = bag[id]; return { exists: !!d, data: () => d }; },
          };
        },
        where(f1, _o1, v1) {
          const conds = [[f1, v1]];
          const q = { where(f, _o, v) { conds.push([f, v]); return q; }, limit() { return q; },
            async get() {
              const rows = (data[name] || []).filter((r) => conds.every(([f, v]) => r[f] === v));
              return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => ({ data: () => r })) };
            } };
          return q;
        },
      };
    },
  });
}

/** Load merchant-authority.js against the fixture. */
function loadAuthority(data) {
  const src = fs.readFileSync(path.join(ROOT, 'functions/merchant-authority.js'), 'utf8');
  const stubAdmin = { firestore: makeFirestore(data), apps: [{}], initializeApp() {} };
  const stubHttps = { HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  const m = new Module('ma', null);
  m.filename = path.join(ROOT, 'functions/merchant-authority.js');
  m.paths = Module._nodeModulePaths(path.join(ROOT, 'functions'));
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; if (req === 'firebase-functions/v2/https') return stubHttps; return orig.apply(this, arguments); };
  try { m._compile(src, m.filename); } finally { Module._load = orig; }
  return m.exports;
}

/** Load procurement.js against the SAME fixture. firebase-admin is stubbed via Module._load
 *  before the require (as test-supply-integration-slice-m.js / test-find-suppliers-slice-k.js
 *  do), so the module-level `db = admin.firestore()` IS the fixture double. Before 2026-10-03
 *  this section required procurement.js unstubbed and `_assertSuppliesEnabled(BIZ_A)` read
 *  through the REAL admin SDK (one production read on 2026-09-30). The stub's firestore()
 *  records every collection it is asked for, so the suite can prove the read hit the fixture. */
function loadProcurement(data) {
  const touched = [];
  const base = makeFirestore(data);
  const fsFn = () => { const f = base(); return { collection(n) { touched.push(n); return f.collection(n); } }; };
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }), arrayUnion: (...a) => ({ __union: a }), delete: () => ({ __del: true }) };
  fsFn.Timestamp  = { fromDate: (d) => d, now: () => new Date(0) };
  fsFn.FieldPath  = { documentId: () => ({ __docId: true }) };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    ['functions/procurement.js', 'functions/merchant-authority.js', 'functions/tenant-identity.js']
      .forEach((f) => { try { delete require.cache[require.resolve(path.join(ROOT, f))]; } catch (_) {} });
    const mod = require(path.join(ROOT, 'functions/procurement.js'));
    mod.__touched = touched;
    return mod;
  } finally { Module._load = orig; }
}

const auth = (uid, token) => ({ uid, token: token || {} });
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }

(async () => {
  const A = loadAuthority(DATA);

  /* ══════════════════════════════════════════════════════════
     §1 canonical identity — no duplicate supplier account
  ══════════════════════════════════════════════════════════ */
  console.log('§1 canonical identity');
  check('the relationship row points at businesses/{id}, not a new account',
    /supplierBusinessId: _verifiedSupplierBusinessId,/.test(PROC));
  /* Slice M split the contact source in two. The invariant here is unchanged and is what
     these now assert: a GENUINELY EXTERNAL supplier still has no canonical record, so its
     name and phone remain required and client-supplied. What changed is only that a SOKONI
     counterparty no longer asks the buyer to retype contact details it already holds —
     discovery withholds phone by design, so requiring one would invite an invented number.
     The executed proof of both paths lives in test-supply-integration-slice-m.js. */
  check('an external supplier still supplies its own contact fields',
    /const _resolvedName = _bizData[\s\S]{0,140}:\s*name;/.test(PROC) &&
    /const _resolvedPhone = _bizData \?[^:]*:\s*phone;/.test(PROC));
  check('an external supplier still REQUIRES a phone',
    /if \(!_bizData && !phone\) _err\('Contact phone is required\.'\);/.test(PROC));
  check('the written contact fields are the resolved ones, sanitised',
    /name:\s+_san\(_resolvedName, MAX_SUPPLIER_NAME\)/.test(PROC) &&
    /phone:\s+_resolvedPhone \? _san\(_resolvedPhone, 20\) : null,/.test(PROC));
  sab('the external-phone detector catches the requirement being dropped',
    !/if \(!_bizData && !phone\) _err\('Contact phone is required\.'\);/.test(
      'const phone = d.phone || null;'));
  check('supplierBusinessId is nullable for genuinely external suppliers',
    /const _supplyingBusiness = supplierBusinessId\s*\n?\s*\?\s*await _loadSupplyingBusiness\(supplierBusinessId\)\s*\n?\s*:\s*null;/.test(PROC) &&
    /const _verifiedSupplierBusinessId = _supplyingBusiness \? _supplyingBusiness\.id : null;/.test(PROC));
  check('the consent check has ONE implementation, not two',
    /async function _loadSupplyingBusiness/.test(PROC) &&
    /return \(await _loadSupplyingBusiness\(supplierBusinessId\)\)\.id;/.test(PROC));
  sab('the single-implementation detector notices the check being copied',
    !/return \(await _loadSupplyingBusiness\(supplierBusinessId\)\)\.id;/.test(
      'async function _assertSuppliesEnabled(id) { const s = await db.doc(id).get(); return id; }'));
  check('no second supplier identity is minted for a SOKONI business',
    !/createSupplierAccount|supplierAccounts|new supplier business/i.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §2 participation is EXPLICIT, never inferred (executed)
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 explicit supply participation (executed)');
  const proc = loadProcurement(DATA);

  check('_assertSuppliesEnabled is exported and callable', typeof proc._assertSuppliesEnabled === 'function');
  {
    /* EXECUTED against the fixture (hermetic since 2026-10-03): opted in → passes. */
    const r = await verdict(() => proc._assertSuppliesEnabled(BIZ_A));
    check('an opted-in business (A) is accepted as a supplier', r.ok && r.value === BIZ_A);
    check('the read went to the FIXTURE businesses collection, not a real database',
      proc.__touched.length > 0 && proc.__touched.every((c) => c === 'businesses'));
  }
  {
    const r = await verdict(() => proc._assertSuppliesEnabled(BIZ_B));
    check('a business with NO supply block (B) is REFUSED: failed-precondition',
      !r.ok && r.code === 'failed-precondition' && /has not enabled supply/.test(r.message || ''));
  }
  {
    const r = await verdict(() => proc._assertSuppliesEnabled(BIZ_C));
    check('a business with supply.enabled === false (C) is REFUSED: failed-precondition',
      !r.ok && r.code === 'failed-precondition');
  }
  {
    const r = await verdict(() => proc._assertSuppliesEnabled('SOK-NOPE99'));
    check('an unknown business is REFUSED: not-found', !r.ok && r.code === 'not-found');
  }
  {
    const r = await verdict(() => proc._assertSuppliesEnabled('a/b'));
    check('a path-shaped id is REFUSED before any read', !r.ok && r.code === 'invalid-argument');
  }
  {
    /* Positive control on the fixture itself: flip A's opt-in in a COPY and the same call refuses. */
    const flipped = JSON.parse(JSON.stringify(DATA)); flipped.businesses[BIZ_A].supply.enabled = 'true';
    const r = await verdict(() => loadProcurement(flipped)._assertSuppliesEnabled(BIZ_A));
    sab('a string "true" is not an opt-in (the executed check is strict)', !r.ok && r.code === 'failed-precondition');
  }
  check('participation requires an explicit boolean',
    /typeof supply\.enabled !== 'boolean'/.test(PROC));
  check('the refusal says participation is never inferred',
    /participation is explicit, never inferred/.test(PROC));
  check('existence alone is NOT participation',
    /if \(!d\.supply \|\| d\.supply\.enabled !== true\)/.test(PROC));
  sab('the detector catches an existence-only check',
    !/if \(!d\.supply \|\| d\.supply\.enabled !== true\)/.test('if (!snap.exists) _err("x"); return id;'));
  /* Inference must be checked against CODE, not prose. An earlier version matched the bare
     word and fired on the comment documenting the rule — a detector that flags its own
     documentation. Strip comments first, then look for actual inference. */
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const CODE = stripComments(PROC);
  check('supply is NOT inferred from wholesaleEnabled (code, not prose)',
    !/wholesaleEnabled/.test(CODE));
  sab('the comment-stripper does not hide real code',
    /wholesaleEnabled/.test(stripComments("/* never from wholesaleEnabled */\nif (p.wholesaleEnabled) enable();")));
  sab('the comment-stripper does remove prose',
    !/wholesaleEnabled/.test(stripComments("/* never inferred from wholesaleEnabled here */\nconst x = 1;")));
  check('supply is NOT inferred from owning products',
    !/products[\s\S]{0,80}supply\.enabled\s*=\s*true/.test(CODE));

  const SUPPLY_ALLOW = proc._SUPPLY_MUTABLE;
  check('supply opt-in has a field allowlist', Array.isArray(SUPPLY_ALLOW) && SUPPLY_ALLOW.length > 0);
  ['ownerId', 'adminUids', 'merchantId', 'enabledBy', 'enabledAt', 'updatedBy']
    .forEach((f) => check('IMMUTABLE via supply payload: ' + f, SUPPLY_ALLOW.indexOf(f) === -1));
  check('the supply patch is BUILT from the allowlist, never spread',
    /for \(const key of SUPPLY_MUTABLE\)/.test(PROC) && !/\.\.\.supply/.test(PROC));
  sab('the detector catches a supply payload spread', /\.\.\.supply/.test('const p = { ...supply };'));

  /* ══════════════════════════════════════════════════════════
     §3 ambiguity — a uid may not stand in for "my business"
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 ambiguous owner refused at opt-in');
  check('opt-in resolves a bare uid through the canonical resolver',
    /resolveMerchantIdForOwner\(String\(auth\.uid\)\)/.test(PROC));
  check('an ambiguous owner is REFUSED, not guessed',
    /TENANT_REASON\.AMBIGUOUS[\s\S]{0,180}failed-precondition/.test(PROC));
  check('resolution is not treated as authorization',
    /resolution is not authorization/.test(PROC) &&
    /return await _assertMerchantAuthority\(request, owned\.merchantId\)/.test(PROC));
  sab('the detector catches resolution-without-authorization',
    !/return await _assertMerchantAuthority\(request, owned\.merchantId\)/.test(
      'const owned = await resolveMerchantIdForOwner(uid); return owned.merchantId;'));

  /* ══════════════════════════════════════════════════════════
     §4 BUYER vs SUPPLIER authority — independent (executed)
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 buyer-side and supplier-side authority are independent (executed)');
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_B), BIZ_B));
    check('B is authorized for its own (buyer) business', r.ok && r.value === BIZ_B);
  }
  {
    /* THE invariant: buyer authority must not reach the supplier's book. */
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_B), BIZ_A));
    check('buyer B is DENIED supplier-side access to A', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_A), BIZ_B));
    check('supplier A is DENIED access to buyer B', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => A.assertMerchantAccess(auth(UID_B, { manager: true, role: 3 }), BIZ_A));
    check('a manager claim does not bridge the two sides', !r.ok && r.code === 'permission-denied');
  }

  check('supplier-side authority resolves from the ORDER, not the caller',
    /_assertSupplierSideAuthority\(request, supplierBusinessId\)/.test(PROC));
  check('supplier-side is a distinct function, not the buyer-side helper',
    /async function _assertSupplierSideAuthority/.test(PROC) &&
    typeof proc._assertSupplierSideAuthority === 'function');
  check('the inbound query is scoped by supplierBusinessId',
    /where\('supplierBusinessId', '==', businessId\)/.test(PROC));
  sab('the detector catches scoping the supplier view by the caller instead',
    !/where\('supplierBusinessId', '==', businessId\)/.test(
      "db.collection('procPurchaseOrders').where('merchantId','==',auth.uid)"));
  check('an order with no SOKONI supplier cannot be claimed supplier-side',
    /This order has no SOKONI supplier business/.test(PROC));
  check('the supplier sees the order, not the buyer\'s whole book',
    /The supplier sees the order, not the buyer's whole book/.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §5 relationship verification
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 relationship verification');
  check('addSupplier verifies BEFORE minting a supplier id',
    PROC.indexOf('_verifiedSupplierBusinessId = supplierBusinessId') < PROC.indexOf("const supplierId = _genId('sup')"));
  check('updateSupplier can clear the link', /if \(v === null \|\| v === ''\) \{ patch\.supplierBusinessId = null; break; \}/.test(PROC));
  check('updateSupplier verifies a newly-set link',
    /patch\.supplierBusinessId = await _assertSuppliesEnabled\(v\);/.test(PROC));
  check('supplierBusinessId is on the supplier allowlist',
    proc._SUPPLIER_MUTABLE.indexOf('supplierBusinessId') !== -1);
  check('merchantId is still NOT client-mutable on a supplier',
    proc._SUPPLIER_MUTABLE.indexOf('merchantId') === -1);

  /* ══════════════════════════════════════════════════════════
     §6 wiring + preservation
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 wiring + preservation');
  check('setSupplyParticipation is exported', typeof proc.setSupplyParticipation === 'function');
  check('getInboundSupplyOrders is exported', typeof proc.getInboundSupplyOrders === 'function');
  check('setSupplyParticipation is re-exported by name in index.js',
    /^exports\.setSupplyParticipation\s+=\s+procurement\.setSupplyParticipation;/m.test(IDX));
  check('getInboundSupplyOrders is re-exported by name in index.js',
    /^exports\.getInboundSupplyOrders\s+=\s+procurement\.getInboundSupplyOrders;/m.test(IDX));

  check('UNTOUCHED: sendPurchaseOrder still reads procPurchaseOrders',
    /collection\('procPurchaseOrders'\)\.doc\(poId\)/.test(PROC));
  check('UNTOUCHED: sendPurchaseOrder still requires approved status', /po\.status !== 'approved'/.test(PROC));
  check('NOT EXPANDED: B2 did not touch approval', !/approvePurchaseOrder[\s\S]{0,200}supplierBusinessId/.test(PROC));
  check('NOT REVIVED: posSendPurchaseOrder stays retired', !/^exports\.posSendPurchaseOrder\s*=/m.test(IDX));
  check('PRESERVED: Slice A merchant authority still gates addSupplier',
    /const merchantId = await _assertMerchantAuthority\(request, _requestedMerchantId\);/.test(PROC));
  check('PRESERVED: Slice B canonical PO shape',
    /buyerBusinessId:\s*merchantId,/.test(PROC));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — one canonical identity; explicit opt-in; buyer and supplier authority independent.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
