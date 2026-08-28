/* posCompleteCheckout — the merchant boundary, certified across every collection it writes.

   Run:  FIRESTORE_EMU_PORT=8099 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199 \n           NODE_PATH="<repo>/functions/node_modules;<repo>/node_modules" \n           firebase --config scripts/emulators.cert.json emulators:exec --only firestore,auth \n             --project sokoni-pos-authority-cert "node scripts/cert-pos-checkout-authority.js"

   The separate config exists because this repo is worked by several agents at once and
   the default emulator ports (8080/9099/4400/4500) are frequently already held. Do NOT
   kill processes on those ports to free them — they may be another agent's.

   THE DEFECT THIS CLOSES, measured before the fix: an authenticated user with no
   relationship to a merchant recorded a KES 400 sale against it under their own uid and
   moved its stock 50 -> 48. merchantId arrived in the payload and was never checked.

   ZERO MUTATION IS ASSERTED ACROSS THE WHOLE FOOTPRINT, not just stock. The checkout
   writes ten collections, and a refusal that still touched one of them would pass a
   narrower test. Every denial row snapshots all ten before and after.

   OUTCOME CLASSIFICATION IS PART OF THE TEST, because the first probe of this callable
   reported the caller as AUTHORIZED when it had actually been refused for a price
   mismatch — a malformed payload producing a false green security result:

     authorization refusal   a valid security negative
     validation error        INCONCLUSIVE — fix the payload, do not record a pass
     infrastructure error    INCONCLUSIVE
     success + mutation      an authorization failure when the caller should be refused
     success + no mutation   still requires its own assertion

   THE FROZEN WALLET BACKEND IS NOT TOUCHED. This certifies the boundary in front of the
   checkout; posWallets and posWalletTransactions are only ever OBSERVED here.
*/
'use strict';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + (process.env.FIRESTORE_EMU_PORT || 8080);
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9098';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-pos-checkout-cert';

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
const inc = (l, why) => { inconclusive++; console.log('  INCONCLUSIVE  ' + l + '   [' + why + ']'); };
const un = (l, w) => { unproven++; console.log('  UNPROVEN  ' + l + '   [' + w + ']'); };
const head = (t) => console.log('\n' + t);

/* Every collection the checkout writes. A refusal must leave all of them alone. */
const FOOTPRINT = ['products', 'posRetailSales', 'posReceipts', 'posDailySummary',
                   'posWallets', 'posWalletTransactions', 'posCustomers',
                   'loyaltyPrograms', 'coupons', 'posIdempotency'];

const A = 'merch_A', B = 'merch_B', EMP = 'emp_1', OUTSIDER = 'outsider_1';
const PROD_A = 'prod_A', PROD_B = 'prod_B';

const AUTHZ = /permission|denied|forbidden|not authorized|unauthor|employment|not-employed/i;
const VALIDATION = /required|mismatch|invalid|not found|insufficient|out of stock/i;
const INFRA = /No Firebase project|ECONNREFUSED|not a valid Firestore document|Cannot use "undefined"|ENOTFOUND/i;

async function snapshot () {
  const out = {};
  for (const c of FOOTPRINT) {
    const s = await db.collection(c).get();
    out[c] = s.size;
  }
  const p = await db.collection('products').doc(PROD_A).get();
  out.__stockA = p.exists ? p.data().stock : null;
  const pb = await db.collection('products').doc(PROD_B).get();
  out.__stockB = pb.exists ? pb.data().stock : null;
  return out;
}
const diff = (before, after) => Object.keys(before)
  .filter((k) => before[k] !== after[k])
  .map((k) => k.replace('__', '') + ' ' + before[k] + '->' + after[k]);

let seq = 0;
const checkout = async (uid, merchantId, productId) => {
  try {
    const out = await POS.posCompleteCheckout.run({
      data: {
        idempotencyKey: 'cert_' + (++seq) + '_' + Date.now(),
        merchantId: merchantId,
        items: [{ productId: productId, qty: 2, unitPrice: 200, name: 'Widget' }],
        payments: [{ method: 'cash', amount: 400 }],
        subtotal: 400, grandTotal: 400,
      },
      auth: { uid: uid, token: {} },
    });
    return { ok: true, out };
  } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
};

/* One denial case: refuse, for the right reason, touching nothing. */
async function denies (label, uid, merchantId, productId) {
  const before = await snapshot();
  const r = await checkout(uid, merchantId, productId);
  const after = await snapshot();
  const changed = diff(before, after);

  if (r.ok) {
    ck(label + ': REFUSED', false, 'ACCEPTED');
    ck(label + ': zero mutation across all ' + FOOTPRINT.length + ' collections',
       changed.length === 0, changed.join(', ') || 'none');
    return;
  }
  if (INFRA.test(r.err) || (VALIDATION.test(r.err) && !AUTHZ.test(r.err))) {
    inc(label, 'refused by ' + (INFRA.test(r.err) ? 'infrastructure' : 'validation') + ', not authorization: ' + r.err);
    ck(label + ': zero mutation anyway', changed.length === 0, changed.join(', ') || 'none');
    return;
  }
  ck(label + ': REFUSED by authorization', true, r.err);
  ck(label + ': zero mutation across all ' + FOOTPRINT.length + ' collections',
     changed.length === 0, changed.join(', ') || 'none');
}

async function allows (label, uid, merchantId, productId, expectStockDrop) {
  const before = await snapshot();
  const r = await checkout(uid, merchantId, productId);
  const after = await snapshot();
  if (!ck(label + ': ALLOWED', r.ok === true, r.ok ? 'ok' : r.err)) return;
  const key = productId === PROD_A ? '__stockA' : '__stockB';
  ck(label + ': stock moved as expected', before[key] - after[key] === expectStockDrop,
     before[key] + ' -> ' + after[key]);
  ck(label + ': a sale was recorded', after.posRetailSales > before.posRetailSales,
     before.posRetailSales + ' -> ' + after.posRetailSales);
}

async function seed () {
  for (const u of [A, B, EMP, OUTSIDER]) { try { await admin.auth().createUser({ uid: u }); } catch (e) {} }
  for (const m of [A, B]) {
    await db.collection('shops').doc(m).set({ name: m, ownerId: m, status: 'active' });
    await db.collection('users').doc(m).set({ name: 'Owner ' + m });
  }
  await db.collection('users').doc(EMP).set({ name: 'Employee' });
  await db.collection('users').doc(OUTSIDER).set({ name: 'Outsider' });
  await db.collection('products').doc(PROD_A).set({
    name: 'Widget', stock: 50, price: 200, sellerUid: A, merchantId: A, shopId: A });
  await db.collection('products').doc(PROD_B).set({
    name: 'Widget', stock: 50, price: 200, sellerUid: B, merchantId: B, shopId: B });
}

/* FIXTURES ADAPTED TO THE LIVE SCHEMA (2026-08-28).
   This script was written on audit/employee-attribution, where shopEmployees was
   keyed `shopId_uid` and carried a `permissions` array. The LIVE model that
   resolveActor actually reads is different:

     doc id     the EMPLOYEE UID           (not shopId_uid)
     field      shopOwnerId == shopId
     field      role, mapped through EMPLOYEE_ROLES -> ROLE_CAPABILITIES

   Running the original fixtures against live refused two legitimate employees —
   a schema mismatch, not an authorization defect. Capability now comes from the
   ROLE, because that is what live resolves.

   CONSEQUENCE, and it is a real modelling limit: keyed by uid, an employee belongs
   to exactly ONE shop. Multi-shop employment is NOT representable on live, so the
   original case 7 cannot be expressed and is reframed below. */
const grant = (shopId, uid, role) => db.collection('shopEmployees').doc(uid).set({
  shopOwnerId: shopId, uid, status: 'active', role, name: 'Employee' });

(async () => {
  await seed();

  head('0 - HARNESS SELF-CHECK');
  ck('the real callable is invocable', typeof POS.posCompleteCheckout.run === 'function');
  const s0 = await snapshot();
  ck('the footprint is observable', Object.keys(s0).length >= FOOTPRINT.length, FOOTPRINT.length + ' collections watched');
  ck('both merchants have stock to lose', s0.__stockA === 50 && s0.__stockB === 50, 'A=50 B=50');

  head('1 - THE POSITIVE CONTROL FIRST (a denial suite that denies everything proves nothing)');
  await allows('owner -> own merchant', A, A, PROD_A, 2);

  head('2 - OUTSIDER -> victim merchant   (the confirmed gap)');
  await denies('outsider', OUTSIDER, A, PROD_A);

  head('3 - EMPLOYEE OF A -> merchant B');
  await grant(A, EMP, 'cashier');
  await denies('employee of A acting on B', EMP, B, PROD_B);

  head('4 - EMPLOYEE WITHOUT pos.sell -> own merchant');
  /* On live every KNOWN role carries 'sell' (owner/manager/cashier/staff), so
     'no sell capability' is expressed by an UNKNOWN role: resolveActor returns
     employment-role-unknown and the sale is refused. */
  await grant(A, EMP, 'viewer');
  await denies('employee lacking pos.sell', EMP, A, PROD_A);

  head('5 - REVOKED EMPLOYEE -> own merchant');
  await grant(A, EMP, 'cashier');
  await db.collection('shopEmployees').doc(EMP).update({ status: 'revoked' });
  await denies('revoked employee', EMP, A, PROD_A);

  head('6 - EMPLOYEE WITH pos.sell -> authorized merchant');
  await grant(A, EMP, 'cashier');
  await allows('employee with pos.sell', EMP, A, PROD_A, 2);

  head('7 - EMPLOYMENT IS SINGLE-SHOP ON THIS MODEL');
  /* shopEmployees is keyed by the employee uid, so re-employing EMP at B MOVES
     them: they must lose A and, lacking a selling role at B, gain nothing. */
  await grant(B, EMP, 'viewer');
  await denies('after moving to B, checkout in A', EMP, A, PROD_A);
  await denies('at B with a non-selling role', EMP, B, PROD_B);

  head('8 - THE OWNER STILL WORKS AFTER ALL THE DENIALS');
  await allows('owner -> own merchant, again', A, A, PROD_A, 2);

  head('WHAT THIS DOES NOT PROVE');
  un('the frozen wallet backend', 'posWallets and posWalletTransactions are OBSERVED for zero-mutation only, never modified');
  un('the onCall envelope', 'App Check is not exercised; .run() invokes the handler');
  un('the other POS callables', 'posProcessRefund has its own authority; the rest of the file is unreviewed');
  un('which identity model is canonical', 'the fix accepts EITHER shops+shopEmployees OR businesses+posStaff — converging them is a separate decision');

  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + inconclusive + ' inconclusive, ' + unproven + ' unproven');
  if (failures.length) { console.log(''); failures.forEach((f) => console.log('  · ' + f)); }
  console.log('='.repeat(78));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
