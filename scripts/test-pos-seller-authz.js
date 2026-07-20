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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const make = new AsyncFunction('HttpsError', '_assertBusinessPermission',
  '"use strict";' + BLOCK + '; return _requireSeller;');

(async () => {
  const _requireSeller = await make(HttpsError, _assertBusinessPermission);
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
    const before = engineCalls.length;
    await run('MERCHANT_1', 'MERCHANT_1');
    ck('own-POS path needs no Firestore read', engineCalls.length === before);
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
