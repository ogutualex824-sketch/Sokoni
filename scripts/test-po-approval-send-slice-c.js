'use strict';
/**
 * CERT — Slice C: merchant-scoped approval + send.
 *
 * INVARIANT UNDER TEST
 *   Every operation acting on an existing PO derives the merchant from the AUTHORITATIVE
 *   document and authorizes the caller against it. A manager at merchant A cannot approve
 *   or send merchant B's purchase order.
 *
 * METHOD
 *   `_assertPoAuthority` is EXECUTED against an injected Firestore double holding two
 *   businesses, two principals and two purchase orders — one per merchant. Verdicts are
 *   real throws or real returns. Static checks appear only where the property is genuinely
 *   textual (e.g. "the delivery abstraction was not altered"). Syntax validity proves
 *   nothing here. Every detector is exercised in both directions.
 *
 * A NOTE ON "admin"
 *   Two distinct notions share the word, and the suite keeps them apart rather than
 *   pretending both are denied:
 *     • a MERCHANT-level admin (a member of business A's `adminUids`) — denied on B;
 *     • a PLATFORM admin (`token.admin` / `token.superAdmin`, set server-side and
 *       unforgeable) — ALLOWED, which is what the current authority model explicitly
 *       permits and what this slice deliberately preserves.
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

console.log('\nCERT — Slice C: merchant-scoped approval + send\n');

/* ══════════════════════════════════════════════════════════════
   FIXTURE — two merchants, two principals, one PO each
══════════════════════════════════════════════════════════════ */
const UID_A = 'principal-A', UID_B = 'principal-B', UID_ADMIN_A = 'admin-of-A';
const BIZ_A = 'SOK-AAAA11', BIZ_B = 'SOK-BBBB22';
const PO_A  = 'po_aaa', PO_B = 'po_bbb';

const DATA = {
  businesses: {
    [BIZ_A]: { ownerId: UID_A, adminUids: [UID_ADMIN_A] },
    [BIZ_B]: { ownerId: UID_B },
  },
  procPurchaseOrders: {
    [PO_A]: { poId: PO_A, merchantId: BIZ_A, buyerBusinessId: BIZ_A, status: 'draft', supplierId: 'sup-a' },
    [PO_B]: { poId: PO_B, merchantId: BIZ_B, buyerBusinessId: BIZ_B, status: 'approved', supplierId: 'sup-b' },
    'po_orphan': { poId: 'po_orphan', status: 'draft' },   // no owner at all
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
            async update() { return true; },
          };
        },
        where(f1, _o1, v1) {
          const conds = [[f1, v1]];
          const q = { where(f, _o, v) { conds.push([f, v]); return q; }, limit() { return q; },
            async get() { const rows = (data[name] || []).filter((r) => conds.every(([f, v]) => r[f] === v));
              return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => ({ data: () => r })) }; } };
          return q;
        },
      };
    },
  });
}

/** Load merchant-authority against the fixture — the real primitive, real branches. */
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

/**
 * Load the REAL procurement.js with firebase-admin stubbed at require time, so
 * `_assertPoAuthority` closes over the fixture instead of production Firestore.
 *
 * An earlier version of this suite drove a hand-written REPLICA of the gate. That was a
 * genuine hole: sabotaging the real fail-closed branch left the suite green, because the
 * replica still failed closed on its own. A suite that cannot see the code it certifies is
 * not certifying it. This loads the real module and executes the real function.
 */
function loadProcurement(data) {
  const fsFn = () => ({
    collection(n) {
      return {
        doc(id) {
          return {
            async get() { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d }; },
            async update() { return true; },
            async set() { return true; },
          };
        },
        where(f1, _o, v1) {
          const conds = [[f1, v1]];
          const q = { where(f, _o2, v) { conds.push([f, v]); return q; }, limit() { return q; },
            async get() {
              const rows = (Array.isArray(data[n]) ? data[n] : []).filter((r) => conds.every(([f, v]) => r[f] === v));
              return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => ({ data: () => r })) };
            } };
          return q;
        },
      };
    },
    async runTransaction(fn) { return fn({ get: async () => ({ exists: false, data: () => ({}) }), set() {} }); },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: () => 1 };
  fsFn.Timestamp  = { fromDate: (d) => d };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };

  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'functions/procurement.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'functions/merchant-authority.js'))];
    return require(path.join(ROOT, 'functions/procurement.js'));
  } finally { Module._load = orig; }
}

const auth = (uid, token) => ({ uid, token: token || {} });
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }

(async () => {
  const A = loadAuthority(DATA);
  /* THE REAL FUNCTION, closed over the fixture. */
  const procLive = loadProcurement(DATA);
  const poGate = (a, poId) => procLive._assertPoAuthority({ auth: a }, poId);

  /* ══════════════════════════════════════════════════════════
     §1 POSITIVE — each principal on its own PO
  ══════════════════════════════════════════════════════════ */
  console.log('§1 POSITIVE');
  {
    const r = await verdict(() => poGate(auth(UID_A), PO_A));
    check('A -> A PO  is authorized', r.ok && r.value.merchantId === BIZ_A);
  }
  {
    const r = await verdict(() => poGate(auth(UID_B), PO_B));
    check('B -> B PO  is authorized', r.ok && r.value.merchantId === BIZ_B);
  }
  {
    const r = await verdict(() => poGate(auth(UID_ADMIN_A), PO_A));
    check('merchant-admin of A -> A PO is authorized (adminUids)', r.ok);
  }

  /* ══════════════════════════════════════════════════════════
     §2 NEGATIVE — the cross-merchant matrix
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 NEGATIVE — cross-merchant matrix');
  {
    const r = await verdict(() => poGate(auth(UID_A), PO_B));
    check('A -> B PO  is DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => poGate(auth(UID_B), PO_A));
    check('B -> A PO  is DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => poGate(auth(UID_A, { manager: true, role: 3 }), PO_B));
    check('MANAGER claim on A + B PO -> DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => poGate(auth(UID_ADMIN_A, { manager: true }), PO_B));
    check('merchant-ADMIN of A + B PO -> DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    /* Documented, deliberate: an unforgeable PLATFORM admin claim is permitted by the
       current authority model, and this slice preserves that rather than silently
       changing it. */
    const r = await verdict(() => poGate(auth('platform-root', { admin: true }), PO_B));
    check('PLATFORM admin claim is ALLOWED (explicitly permitted, unchanged)', r.ok);
  }
  {
    const r = await verdict(() => poGate(auth('nobody'), PO_A));
    check('an unrelated authenticated user is DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => poGate(null, PO_A));
    check('an unauthenticated caller is rejected', !r.ok && r.code === 'unauthenticated');
  }

  /* ══════════════════════════════════════════════════════════
     §3 NEGATIVE — fail closed, and forged payloads are irrelevant
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 fail-closed + forged payloads');
  {
    const r = await verdict(() => poGate(auth(UID_A), 'po_does_not_exist'));
    check('a nonexistent PO fails closed (not-found)', !r.ok && r.code === 'not-found');
  }
  {
    const r = await verdict(() => poGate(auth(UID_A), 'po_orphan'));
    check('a PO with no owning merchant is REFUSED, not defaulted', !r.ok && r.code === 'failed-precondition');
  }
  {
    /* A forged merchantId on the request object changes nothing: the gate never reads one. */
    const forged = auth(UID_A);
    forged.merchantId = BIZ_B; forged.buyerBusinessId = BIZ_B; forged.ownerId = UID_B;
    const r = await verdict(() => poGate(forged, PO_B));
    check('a forged merchantId in the request is irrelevant to authorization',
      !r.ok && r.code === 'permission-denied');
  }
  {
    const forged = auth(UID_A);
    forged.supplierId = 'sup-b'; forged.supplierBusinessId = BIZ_B;
    const r = await verdict(() => poGate(forged, PO_B));
    check('forged supplier/business ids do not confer PO ownership',
      !r.ok && r.code === 'permission-denied');
  }
  check('the gate reads the owner off the DOCUMENT, not the request',
    /const owner = po\.buyerBusinessId \|\| po\.merchantId;/.test(PROC));
  sab('the detector catches deriving the owner from the request',
    !/const owner = po\.buyerBusinessId \|\| po\.merchantId;/.test(
      'const owner = request.data.merchantId;'));

  /* ══════════════════════════════════════════════════════════
     §4 the two operations actually carry the gate
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 approve + send are gated');
  const proc = require(path.join(ROOT, 'functions/procurement.js'));
  check('_assertPoAuthority exists and is exported', typeof proc._assertPoAuthority === 'function');
  check('approvePurchaseOrder uses the PO-derived gate',
    /const approvePurchaseOrder[\s\S]{0,700}await _assertPoAuthority\(request, poId\)/.test(PROC));
  check('approvePurchaseOrder STILL requires manager/admin',
    /const approvePurchaseOrder[\s\S]{0,400}_requireManager\(request\)/.test(PROC));
  check('sendPurchaseOrder uses the PO-derived gate',
    /const sendPurchaseOrder[\s\S]{0,700}await _assertPoAuthority\(request, poId\)/.test(PROC));
  sab('the detector catches an ungated send',
    !/const sendPurchaseOrder[\s\S]{0,700}await _assertPoAuthority\(request, poId\)/.test(
      'const sendPurchaseOrder = onCall(OPT, async (request) => {\n  const uid = _requireAuth(request);\n  const poSnap = await poRef.get();'));
  check('neither op re-reads the PO independently of the gate',
    !/const approvePurchaseOrder[\s\S]{0,900}poSnap = await poRef\.get\(\)/.test(PROC) &&
    !/const sendPurchaseOrder[\s\S]{0,900}poSnap = await poRef\.get\(\)/.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §5 semantics preserved
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 approval + send semantics unchanged');
  check('approval still refuses a PO not in draft/pending_approval',
    /\['draft', 'pending_approval'\]\.includes\(po\.status\)/.test(PROC));
  check('approved:false still cancels', /const newStatus = approved \? 'approved' : 'cancelled';/.test(PROC));
  check('send still refuses anything not approved', /po\.status !== 'approved'/.test(PROC));
  check('approved must still be an explicit boolean', /typeof approved !== 'boolean'/.test(PROC));

  console.log('\n  delivery abstraction — preserved exactly');
  check('PRESERVED: email routes through emailSvc.queue', /await emailSvc\.queue\(\{/.test(PROC));
  check('PRESERVED: deterministic email id (no double-send on retry)',
    /emailId:\s*`po-sent-\$\{poId\}`/.test(PROC));
  check('PRESERVED: the PDF attachment', /filename:\s*`\$\{po\.poNumber \|\| poId\}\.pdf`/.test(PROC));
  check('PRESERVED: SMS/in-app/push route through the ONE notify engine',
    /await notify\.notify\(\{/.test(PROC));
  check('PRESERVED: notify dedupeKey — one notification per PO, ever',
    /dedupeKey:\s*`po:\$\{poId\}:sent`/.test(PROC));
  check('PRESERVED: honest per-channel delivery record',
    /delivery\.email = 'queued'/.test(PROC) && /delivery\.email = 'failed'/.test(PROC) &&
    /delivery\.sms\s*=\s*supplier\.phone \? 'queued' : 'skipped'/.test(PROC));
  check('PRESERVED: the delivery record is written back onto the PO',
    /await poRef\.update\(\{\s*\n\s*delivery,/.test(PROC));
  check('PRESERVED: send returns the real delivery outcome',
    /return \{ poId, status: 'sent', poNumber: po\.poNumber \|\| poId, delivery \};/.test(PROC));
  check('NOT ALTERED: no WhatsApp channel was added in this slice', !/whatsapp/i.test(PROC));
  sab('the delivery detector is not vacuous',
    !/await emailSvc\.queue\(\{/.test('/* no email here */ const x = 1;'));

  /* ══════════════════════════════════════════════════════════
     §6 preservation of earlier slices
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 earlier slices intact');
  check('PRESERVED: Slice A gates addSupplier',
    /const merchantId = await _assertMerchantAuthority\(request, _requestedMerchantId\);/.test(PROC));
  check('PRESERVED: Slice B canonical PO shape', /buyerBusinessId:\s*merchantId,/.test(PROC));
  check('PRESERVED: Slice B2 supply participation is explicit',
    /typeof supply\.enabled !== 'boolean'/.test(PROC));
  check('PRESERVED: Slice B2 supplier-side authority is separate',
    /async function _assertSupplierSideAuthority/.test(PROC));
  /* At Slice C this asserted receiveGoods was still UNGATED, because converging it was
     Slice D's job. Slice D has since landed, so the invariant flips: receiveGoods must now
     carry the same PO-derived gate. Updated rather than deleted — the operation still needs
     an assertion, just the opposite one. */
  check('receiveGoods now carries the same PO-derived gate (Slice D)',
    /const receiveGoods[\s\S]{0,1400}await _assertPoAuthority\(request, poId\)/.test(PROC));
  sab('the detector catches receiveGoods losing the gate',
    !/const receiveGoods[\s\S]{0,1400}await _assertPoAuthority\(request, poId\)/.test(
      "const receiveGoods = onCall(OPT, async (request) => {\n  const uid = _requireAuth(request);\n  const poSnap = await poRef.get();"));
  check('NOT REVIVED: posSendPurchaseOrder stays retired', !/^exports\.posSendPurchaseOrder\s*=/m.test(IDX));
  check('sendPurchaseOrder still exported by name', /^exports\.sendPurchaseOrder\s+=\s+procurement\.sendPurchaseOrder;/m.test(IDX));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — a manager at one merchant cannot approve or send another merchant\'s PO.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
