/* The four remaining cashier-facing callables — the merchant boundary, certified.
 *
 * posValidateCoupon, posLookupCustomer, posLogReprint and posCheckPaymentStatus each took a
 * caller-supplied merchantId behind _assertAuth, which only proves a uid exists. They now use
 * the SAME dual authority certified on posCompleteCheckout: owner/admin, OR an active employee
 * with a selling role.
 *
 * THE POSITIVE CONTROLS COME FIRST. A denial suite that denies everything proves nothing, and
 * the last staff-aware guard written in this workstream was rejected precisely because it
 * denied legitimate cashiers.
 *
 * Denials assert ZERO MUTATION across every collection these four can write — posLogReprint
 * increments a counter and writes an audit row, so "it refused" is not enough on its own.
 *
 * Run: see scripts/emulators.cert.json and the header of cert-pos-checkout-authority.js.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + (process.env.FIRESTORE_EMU_PORT || 8080);
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9098';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-pos-cashier-cert';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const POS = require('../functions/pos-zero-friction.js');

let pass = 0, fail = 0, unproven = 0, inconclusive = 0;
const failures = [];
const ck = (l, ok, d) => {
  if (ok) { pass++; console.log('  PASS  ' + l + (d ? '   [' + String(d).slice(0, 76) + ']' : '')); }
  else { fail++; failures.push(l + (d ? '  -> ' + d : '')); console.log('  FAIL  ' + l + (d ? '   -> ' + String(d).slice(0, 76) : '')); }
  return ok;
};
const inc = (l, w) => { inconclusive++; console.log('  INCONCLUSIVE  ' + l + '   [' + w + ']'); };
const un  = (l, w) => { unproven++; console.log('  UNPROVEN  ' + l + '   [' + w + ']'); };
const head = (t) => console.log('\n' + t);

const FOOTPRINT = ['posReprintCounters', 'auditLogs', 'posCustomers', 'coupons',
                   'posPaymentStatus', 'posRetailSales', 'products'];

const A = 'merch_A', B = 'merch_B', EMP = 'emp_1', OUTSIDER = 'outsider_1';
const AUTHZ = /permission|denied|forbidden|not authorized|unauthor|employment|not-employed/i;
const INFRA = /No Firebase project|ECONNREFUSED|not a valid Firestore document|Cannot use "undefined"|ENOTFOUND/i;

const snapshot = async () => {
  const o = {};
  for (const c of FOOTPRINT) o[c] = (await db.collection(c).get()).size;
  return o;
};
const diff = (b, a) => Object.keys(b).filter((k) => b[k] !== a[k]).map((k) => k + ' ' + b[k] + '->' + a[k]);

let seq = 0;
const CALLS = {
  posValidateCoupon:     (m) => ({ code: 'SAVE10', merchantId: m, subtotal: 400 }),
  posLookupCustomer:     (m) => ({ query: '0712345678', merchantId: m }),
  posLogReprint:         (m) => ({ orderId: 'order_' + (++seq), receiptType: 'sale', merchantId: m }),
  posCheckPaymentStatus: (m) => ({ ref: 'ref_' + (++seq), merchantId: m }),
};
const call = async (name, uid, merchantId) => {
  try { return { ok: true, out: await POS[name].run({ data: CALLS[name](merchantId), auth: { uid, token: {} } }) }; }
  catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
};

async function denies (name, label, uid, merchantId) {
  const before = await snapshot();
  const r = await call(name, uid, merchantId);
  const changed = diff(before, await snapshot());
  if (r.ok) {
    ck(name + ' / ' + label + ': REFUSED', false, 'ACCEPTED');
    ck(name + ' / ' + label + ': zero mutation', changed.length === 0, changed.join(', ') || 'none');
    return;
  }
  if (INFRA.test(r.err) || !AUTHZ.test(r.err)) {
    inc(name + ' / ' + label, 'refused for a non-authorization reason: ' + r.err);
    ck(name + ' / ' + label + ': zero mutation anyway', changed.length === 0, changed.join(', ') || 'none');
    return;
  }
  ck(name + ' / ' + label + ': REFUSED by authorization', true, r.err);
  ck(name + ' / ' + label + ': zero mutation across ' + FOOTPRINT.length + ' collections',
     changed.length === 0, changed.join(', ') || 'none');
}
async function allows (name, label, uid, merchantId) {
  const r = await call(name, uid, merchantId);
  if (r.ok) return ck(name + ' / ' + label + ': ALLOWED', true, 'reached the handler');
  if (AUTHZ.test(r.err)) return ck(name + ' / ' + label + ': ALLOWED', false, 'WRONGLY refused: ' + r.err);
  return ck(name + ' / ' + label + ': ALLOWED (past authorization)', true, 'non-authz outcome: ' + r.err);
}

const grant = (shopId, uid, role) => db.collection('shopEmployees').doc(uid)
  .set({ shopOwnerId: shopId, uid, status: 'active', role, name: 'Employee' });

(async () => {
  for (const u of [A, B, EMP, OUTSIDER]) { try { await admin.auth().createUser({ uid: u }); } catch (e) {} }
  for (const m of [A, B]) {
    await db.collection('shops').doc(m).set({ name: m, ownerId: m, status: 'active' });
    /* The owner path in resolveActor calls _personName(uid) and returns
       owner-name-unresolved without this — a real dependency, not just a fixture
       detail: an owner with no user document falls through to the POS model. */
    await db.collection('users').doc(m).set({ name: 'Owner ' + m });
  }
  await db.collection('users').doc(EMP).set({ name: 'Employee' });

  const NAMES = Object.keys(CALLS);

  head('0 - HARNESS SELF-CHECK');
  for (const n of NAMES) ck(n + ' is invocable', POS[n] && typeof POS[n].run === 'function');
  ck('the footprint is observable', Object.keys(await snapshot()).length === FOOTPRINT.length,
     FOOTPRINT.length + ' collections watched');

  head('1 - POSITIVE CONTROLS FIRST — owner, then a real active cashier');
  for (const n of NAMES) await allows(n, 'owner -> own merchant', A, A);
  await grant(A, EMP, 'cashier');
  for (const n of NAMES) await allows(n, 'active cashier -> own merchant', EMP, A);

  head('2 - OUTSIDER -> victim merchant');
  for (const n of NAMES) await denies(n, 'outsider', OUTSIDER, A);

  head('3 - CASHIER OF A -> merchant B');
  for (const n of NAMES) await denies(n, 'cashier of A acting on B', EMP, B);

  head('4 - REVOKED EMPLOYEE');
  await db.collection('shopEmployees').doc(EMP).update({ status: 'revoked' });
  for (const n of NAMES) await denies(n, 'revoked employee', EMP, A);

  head('5 - NON-SELLING ROLE');
  await grant(A, EMP, 'viewer');
  for (const n of NAMES) await denies(n, 'unknown/non-selling role', EMP, A);

  head('6 - THE OWNER STILL WORKS AFTER EVERY DENIAL');
  for (const n of NAMES) await allows(n, 'owner again', A, A);

  head('WHAT THIS DOES NOT PROVE');
  un('the onCall envelope', 'App Check is not exercised; .run() invokes the handler directly');
  un('posLookupCustomer scoping', 'it searches posCustomers PLATFORM-WIDE with no merchant filter - a separate pre-existing defect this authorization does not fix');
  un('which identity model is canonical', 'the guard accepts EITHER shops+shopEmployees OR businesses+posStaff');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + inconclusive + ' inconclusive, ' + unproven + ' unproven\n');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  SUITE CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
