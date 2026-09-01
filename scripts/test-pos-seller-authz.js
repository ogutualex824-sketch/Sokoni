/* POS seller authorization — the escalation must not survive.

   The defect: _requireSeller took sellerId from req.data and returned it with
   no check. Any signed-in user could pass another merchant's id to openShift,
   clockIn, setCommissionRate or approveCommission and act as that merchant.

   These tests extract the real guard from functions/pos-staff-ops.js at
   runtime rather than copying it, so the test cannot drift from the code. */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

class HttpsError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

/* Stand-in for the canonical engine. Records that it was consulted — the point
   of the fix is that authorization is DELEGATED here, not reimplemented. */
let engineCalls = [];
const MEMBERSHIPS = { STAFF_A: { biz: 'MERCHANT_1', perms: ['pos'] },
                      STAFF_B: { biz: 'MERCHANT_1', perms: ['reports'] } };
async function _assertBusinessPermission(uid, businessId, perm) {
  engineCalls.push({ uid, businessId, perm });
  const m = MEMBERSHIPS[uid];
  if (!m || m.biz !== businessId) throw new HttpsError('permission-denied', 'You are not a member of this business.');
  if (!m.perms.includes(perm)) throw new HttpsError('permission-denied', "Permission '" + perm + "' required.");
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'pos-staff-ops.js'), 'utf8');
const START = SRC.indexOf('async function _requireSeller');
const END = SRC.indexOf('\n}', START) + 2;
if (START < 0 || END < 2) { console.log('  FAIL  could not locate _requireSeller'); process.exit(1); }
const BLOCK = SRC.slice(START, END);

/* ── TENANT RESOLVER BINDINGS ──────────────────────────────────────────────────
   The extracted block gained three module dependencies when _requireSeller was
   converged to return the CANONICAL merchantId (P15C). This sandbox supplied only
   HttpsError and _assertBusinessPermission, so the block crashed on load with
   "looksLikeOwnerForm is not defined" — HARNESS DRIFT, not a production defect. The
   guard itself is proven separately by test-tenant-convergence-handler-surface.js.

   The values below are RUNTIME-FAITHFUL, not permissive stubs. looksLikeOwnerForm is
   the real implementation. The resolver models THIS fixture's world, where a merchant
   id doubles as its owner's uid: MERCHANT_1/MERCHANT_2 own themselves and nobody else
   is linked to a business, so an attacker still falls through to the canonical engine
   and is denied there. Weakening either would hide the escalation this suite exists
   to catch. */
const OWNERS = { MERCHANT_1: 'MERCHANT_1', MERCHANT_2: 'MERCHANT_2' };
const looksLikeOwnerForm = (value, authUid) => !!value && !!authUid && value === authUid;
const TENANT_REASON = { UNLINKED: 'UNLINKED', AMBIGUOUS: 'AMBIGUOUS',
                        MALFORMED: 'MALFORMED', INACTIVE: 'INACTIVE' };
let resolverCalls = 0;
async function resolveMerchantIdForOwner (ownerUid) {
  resolverCalls++;
  if (!ownerUid || typeof ownerUid !== 'string') return { ok: false, reason: TENANT_REASON.MALFORMED };
  const mid = OWNERS[ownerUid];
  return mid ? { ok: true, merchantId: mid } : { ok: false, reason: TENANT_REASON.UNLINKED };
}

const PROVIDED = ['HttpsError', '_assertBusinessPermission', 'looksLikeOwnerForm',
                  'resolveMerchantIdForOwner', 'TENANT_REASON'];
/* Fails with a named HARNESS DRIFT message the next time production gains a dependency
   this sandbox has not mirrored, instead of a bare ReferenceError mid-suite. */
require('./harness-sandbox').assertSandboxProvides(BLOCK, PROVIDED, 'test-pos-seller-authz');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const make = new AsyncFunction(...PROVIDED,
  '"use strict";' + BLOCK + '; return _requireSeller;');

(async () => {
  const _requireSeller = await make(HttpsError, _assertBusinessPermission,
    looksLikeOwnerForm, resolveMerchantIdForOwner, TENANT_REASON);
  const run = (uid, sellerId) => _requireSeller({ uid }, { sellerId });
  const denied = async (label, uid, sellerId) => {
    try { await run(uid, sellerId); ck(label, false, 'ALLOWED — escalation still open'); }
    catch (e) { ck(label, e.code === 'permission-denied', e.code + ': ' + e.message.slice(0, 44)); }
  };

  console.log('\n── The escalation ──');
  await denied('attacker cannot act as another merchant', 'ATTACKER', 'MERCHANT_1');
  await denied('attacker cannot act as an unrelated business', 'ATTACKER', 'MERCHANT_2');
  ck('canonical engine was consulted, not bypassed', engineCalls.length >= 1,
     JSON.stringify(engineCalls[0] || null));
  ck('engine asked for the pos capability', engineCalls.every(c => c.perm === 'pos'));

  console.log('\n── Legitimate access preserved ──');
  {
    const r = await run('MERCHANT_1', 'MERCHANT_1');
    ck('merchant operating their own POS is allowed', r === 'MERCHANT_1');
  }
  {
    /* SUPERSEDED LABEL, CORRECTED. This read "needs no Firestore read", which was true
       when _requireSeller short-circuited on uid === sellerId. P15C removed that
       short-circuit ON PURPOSE — returning the uid split one shop across two tenant
       keys — so the owner path now DOES resolve the tenant. What still holds, and what
       this assertion actually measures, is that the owner is recognised by OWNERSHIP
       and never needs the membership engine. */
    const before = engineCalls.length;
    const resolvedBefore = resolverCalls;
    await run('MERCHANT_1', 'MERCHANT_1');
    ck('owner path never consults the membership engine', engineCalls.length === before);
    ck('...it resolves the tenant instead (P15C, deliberately not a short-circuit)',
       resolverCalls > resolvedBefore);
  }
  {
    const r = await run('STAFF_A', 'MERCHANT_1');
    ck('staff with pos capability is allowed', r === 'MERCHANT_1');
  }

  console.log('\n── Capability is enforced, not just membership ──');
  await denied('staff WITHOUT pos capability is denied', 'STAFF_B', 'MERCHANT_1');

  console.log('\n── Input validation retained ──');
  const bad = async (label, uid, sellerId) => {
    try { await run(uid, sellerId); ck(label, false, 'did not throw'); }
    catch (e) { ck(label, e.code === 'invalid-argument', e.code); }
  };
  await bad('missing sellerId rejected', 'X', undefined);
  await bad('empty sellerId rejected', 'X', '');
  await bad('non-string sellerId rejected', 'X', { evil: true });

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
