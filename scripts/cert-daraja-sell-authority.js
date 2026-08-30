/* darajaSTKPush — the client-supplied sellerUid, bound to real sell authority.
 *
 * THE DEFECT. darajaSTKPush checked `if (!request.auth)` and nothing else, then spent
 * `request.data.sellerUid` as if it named the caller's own merchant: it priced that merchant's
 * catalogue, wrote auditLogs rows stamped `merchantId: sellerUid`, read shopSettings/{sellerUid}
 * for live Daraja credentials, and sent an M-Pesa STK prompt to a caller-chosen phone collecting
 * into that merchant's shortcode. Authentication is not authorization: any signed-in user could
 * drive ANY merchant's collection rail.
 *
 * WHAT IS CERTIFIED HERE. Not a re-implementation of the guard — the REAL exported callable,
 * invoked through `darajaSTKPush.run({ data, auth })`, against a Firestore emulator. The guard
 * reuses pos-zero-friction's `_assertSellAuthority`, the same dual authority already certified on
 * posCompleteCheckout, so this suite also pins that the two cannot drift apart.
 *
 * HOW A PASS IS DISTINGUISHED FROM A DENIAL — and why this is not circular. An authorized caller
 * is NOT expected to succeed: it is expected to get PAST the guard and fail later, at the
 * credential stage, with a message that is provably not an authorization message. That marker is
 * asserted explicitly (`notAuthzShaped`) so "the guard let me through" can never be confused with
 * "everything fails for some other reason". This is the negative control: without it a totally
 * broken handler would score 100%.
 *
 * POSITIVE CONTROLS COME FIRST. A denial suite that denies everything proves nothing, and a
 * staff-aware guard written earlier in this workstream was rejected by test precisely because it
 * denied legitimate cashiers. Ordinary selling cashiers live in shopEmployees; POS-native
 * merchants live in businesses/posStaff. Both must still reach the rail.
 *
 * NO NETWORK IS EVER REACHED. Every case terminates at or before the shopSettings credential
 * lookup, so no Daraja token is requested and no STK prompt is ever sent.
 *
 * Run:  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199 \
 *         NODE_PATH="<repo>/functions/node_modules;<repo>/node_modules" \
 *         firebase --config scripts/emulators.cert.json emulators:exec --only firestore,auth \
 *           --project sokoni-daraja-cert "node scripts/cert-daraja-sell-authority.js"
 *
 * Sabotage:  SABOTAGE=1 neutralises nothing by itself — see scripts/sabotage-daraja-authority.sh,
 * which edits the guard out of index.js, re-runs this suite and requires a NON-ZERO exit.
 */
'use strict';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + (process.env.FIRESTORE_EMU_PORT || 8099);
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-daraja-cert';

/* index.js calls admin.initializeApp() itself at load. It must therefore go FIRST and own the
   [DEFAULT] app: initialising here first produces "already exists with a different configuration"
   and the suite never runs. The db handle is taken from the app index.js created, so the harness
   and the code under test are demonstrably talking to the same Firestore. */
const IDX = require('../functions/index.js');
const admin = require('firebase-admin');
const db = admin.firestore();
const FN = IDX.darajaSTKPush;

let pass = 0, fail = 0, inconclusive = 0;
const failures = [];
const ck = (l, ok, d) => {
  if (ok) { pass++; console.log('  PASS  ' + l + (d ? '   [' + String(d).slice(0, 84) + ']' : '')); }
  else { fail++; failures.push(l + (d ? '  -> ' + d : '')); console.log('  FAIL  ' + l + (d ? '   -> ' + String(d).slice(0, 84) : '')); }
  return ok;
};
const inc = (l, w) => { inconclusive++; console.log('  INCONCLUSIVE  ' + l + '   [' + String(w).slice(0, 84) + ']'); };
const head = (t) => console.log('\n' + t);

/* The three shapes the handler can produce. Kept as separate patterns on purpose: an
   authorization denial and an ordinary precondition failure must never match each other. */
const AUTHZ   = /not authorized|permission-denied|permission denied/i;
const CREDS   = /credentials not configured|Incomplete Daraja credentials/i;
/* Two distinct refusals live on this path and BOTH are correct: the handler's own
   `Must be signed in.` when request.auth is absent, and _assertSellAuthority's
   `Authentication required` (code `unauthenticated`) when an auth object arrives with no uid.
   The first regex matched only the former and scored a correct fail-closed refusal as a FAIL. */
const NOAUTH  = /Must be signed in|Authentication required|unauthenticated/i;
const INFRA   = /ECONNREFUSED|ENOTFOUND|No Firebase project|fetch failed|getaddrinfo/i;

/* Anything the handler could mutate before or at the point the guard sits. auditLogs is the one
   that matters most: the pre-fix handler attributed rows to `merchantId: sellerUid`, so a refused
   outsider must leave no trace under a merchant they never belonged to. */
const FOOTPRINT = ['auditLogs', 'posPayments', 'shopSettings', 'products'];
const snapshot = async () => {
  const o = {};
  for (const c of FOOTPRINT) o[c] = (await db.collection(c).get()).size;
  return o;
};
const diff = (b, a) => Object.keys(b).filter((k) => b[k] !== a[k]).map((k) => k + ' ' + b[k] + '->' + a[k]);

/* ── Fixtures ──────────────────────────────────────────────────────────────────
   Two merchants under DIFFERENT identity models, because the guard accepts the union and
   collapsing to one would silently lock out every merchant registered under the other.

     A = shop_A      shops/{uid} + shopEmployees        (merchant-identity model)
     B = biz_B       businesses/{id}.ownerId + posStaff (this-file model)                       */
const A = 'shop_A';                 // shops/{uid} is keyed BY the owner uid
const A_EMP_CASHIER = 'emp_cashier';
const A_EMP_LEFT = 'emp_terminated';
const B = 'biz_B';
const B_OWNER = 'owner_B';
const B_STAFF = 'staff_B';
const B_STAFF_OFF = 'staff_B_suspended';
const OUTSIDER = 'outsider_1';

async function seed() {
  await db.doc('shops/' + A).set({ name: 'Shop A', status: 'active' });
  await db.doc('users/' + A).set({ name: 'Owner A' });
  await db.doc('users/' + A_EMP_CASHIER).set({ name: 'Cashier A' });
  await db.doc('shopEmployees/' + A_EMP_CASHIER).set({
    shopOwnerId: A, role: 'cashier', status: 'active', name: 'Cashier A',
  });
  await db.doc('shopEmployees/' + A_EMP_LEFT).set({
    shopOwnerId: A, role: 'cashier', status: 'terminated', name: 'Former A',
  });

  await db.doc('businesses/' + B).set({ ownerId: B_OWNER, name: 'Biz B' });
  await db.collection('posStaff').doc('ps_active').set({
    merchantId: B, uid: B_STAFF, status: 'active',
  });
  await db.collection('posStaff').doc('ps_suspended').set({
    merchantId: B, uid: B_STAFF_OFF, status: 'suspended',
  });

  /* Deliberately INCOMPLETE credentials for A. An authorized caller therefore travels further
     than the not-found arm — past the existence check, into the completeness check — which proves
     more of the path is reachable, while still stopping dead before any Daraja network call. */
  await db.doc('shopSettings/' + A).set({ darajaShortCode: '000000' });
}

let seq = 0;
const callFn = async (auth, sellerUid, extra) => {
  const data = Object.assign({
    sellerUid: sellerUid, phone: '0712345678', amount: 100,
    description: 'cert ' + (++seq), hub: 'pos',
  }, extra || {});
  try { return { ok: true, out: await FN.run({ data: data, auth: auth }) }; }
  catch (e) { return { ok: false, err: String((e && e.message) || e), code: (e && e.code) || '' }; }
};

/* An AUTHORIZED caller passes the guard and then fails on credentials. Three assertions, because
   only the third one makes this a real test: it refused, it refused for a CREDENTIAL reason, and
   the refusal is NOT authorization-shaped. */
async function allows(label, auth, sellerUid) {
  const r = await callFn(auth, sellerUid);
  if (r.ok) { ck(label + ': reached the rail', true, 'handler returned'); return; }
  if (INFRA.test(r.err)) { inc(label, 'infrastructure, not a verdict: ' + r.err); return; }
  ck(label + ': PASSED the sell-authority guard', CREDS.test(r.err), r.err);
  ck(label + ': refusal is NOT authorization-shaped (negative control)', !AUTHZ.test(r.err), r.err);
}

/* A DENIED caller is refused BY AUTHORIZATION and leaves nothing behind. "It threw" is not
   enough — a handler that throws for an unrelated reason would score identically. */
async function denies(label, auth, sellerUid) {
  const before = await snapshot();
  const r = await callFn(auth, sellerUid);
  const changed = diff(before, await snapshot());

  if (r.ok) {
    ck(label + ': REFUSED', false, 'ACCEPTED — cross-tenant STK reachable');
    ck(label + ': zero mutation', changed.length === 0, changed.join(', ') || 'none');
    return;
  }
  if (INFRA.test(r.err)) { inc(label, 'infrastructure, not a verdict: ' + r.err); return; }
  if (CREDS.test(r.err)) {
    ck(label + ': REFUSED by authorization', false,
       'reached the CREDENTIAL stage — the guard did not stop it: ' + r.err);
    ck(label + ': zero mutation', changed.length === 0, changed.join(', ') || 'none');
    return;
  }
  ck(label + ': REFUSED by authorization', AUTHZ.test(r.err), r.err);
  ck(label + ': zero mutation across ' + FOOTPRINT.length + ' collections',
     changed.length === 0, changed.join(', ') || 'none');
}

(async function main() {
  await seed();

  head('POSITIVE CONTROLS — every legitimate operator still reaches the rail');
  await allows('owner of A (shops/{uid})',            { uid: A, token: {} }, A);
  await allows('active cashier of A (shopEmployees)', { uid: A_EMP_CASHIER, token: {} }, A);
  await allows('platform admin',                      { uid: 'admin_1', token: { admin: true } }, A);

  /* B has no shopSettings doc, so its authorized arm stops one step earlier, at not-found. Both
     messages are CREDS — the point is that neither is an authorization refusal. */
  await allows('owner of B (businesses.ownerId)',     { uid: B_OWNER, token: {} }, B);
  await allows('active posStaff of B',                { uid: B_STAFF, token: {} }, B);

  head('THE DEFECT — a client-supplied sellerUid naming someone else');
  await denies('outsider names A',                    { uid: OUTSIDER, token: {} }, A);
  await denies('outsider names B',                    { uid: OUTSIDER, token: {} }, B);
  await denies("A's owner names B (cross-merchant)",  { uid: A, token: {} }, B);
  await denies("B's owner names A (cross-merchant)",  { uid: B_OWNER, token: {} }, A);
  await denies("A's cashier names B (cross-merchant)", { uid: A_EMP_CASHIER, token: {} }, B);
  await denies('unknown merchant id',                 { uid: OUTSIDER, token: {} }, 'no_such_merchant');

  head('REVOKED ACCESS — resolution is at call time, not from a cached session');
  await denies('terminated cashier of A',             { uid: A_EMP_LEFT, token: {} }, A);
  await denies('suspended posStaff of B',             { uid: B_STAFF_OFF, token: {} }, B);

  head('MISSING AUTHENTICATION');
  for (const [label, auth] of [['no auth object', undefined], ['auth without uid', { token: {} }]]) {
    const before = await snapshot();
    const r = await callFn(auth, A);
    const changed = diff(before, await snapshot());
    ck(label + ': refused', !r.ok, r.ok ? 'ACCEPTED' : r.err);
    ck(label + ': refused as unauthenticated or unauthorized',
       !r.ok && (NOAUTH.test(r.err) || AUTHZ.test(r.err)), r.err);
    ck(label + ': zero mutation', changed.length === 0, changed.join(', ') || 'none');
  }

  head('ORDERING — the guard must precede every merchant-attributed side effect');
  /* The pre-fix handler wrote auditLogs rows keyed to the named merchant during pricing. An
     outsider supplying line items and a mismatched delivery fee is the shape that produced them,
     so this asserts the refusal happens upstream of that work rather than merely somewhere. */
  await db.doc('products/p_A').set({ sellerUid: A, price: 500, status: 'active', stock: 10, name: 'A item' });
  const beforeOrder = await snapshot();
  const r = await callFn({ uid: OUTSIDER, token: {} }, A,
    { items: [{ productId: 'p_A', qty: 2 }], deliveryFee: 999, amount: 1 });
  const changedOrder = diff(beforeOrder, await snapshot());
  ck('outsider with line items: refused', !r.ok && AUTHZ.test(r.err), r.err);
  ck('outsider with line items: no auditLogs row attributed to A',
     changedOrder.length === 0, changedOrder.join(', ') || 'none');

  head('SHARED AUTHORITY — index.js and pos-zero-friction must not fork');
  const posInternal = require('../functions/pos-zero-friction.js')._internal;
  ck('pos-zero-friction exports _assertSellAuthority',
     !!(posInternal && typeof posInternal._assertSellAuthority === 'function'),
     posInternal ? Object.keys(posInternal).join(', ') : 'no _internal');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  /* Slice to the NEXT top-level export, not to a fixed character budget. The handler is ~29k
     chars; a 12000-char window cut it in half and reported surviving downstream guards as
     MISSING — a truncated haystack fails exactly like a deleted guard. */
  const _hs = src.indexOf('exports.darajaSTKPush');
  const _he = src.indexOf('\nexports.', _hs + 10);
  const handler = src.slice(_hs, _he > _hs ? _he : src.length);
  ck('darajaSTKPush resolves the guard from pos-zero-friction, not a local copy',
     /require\(['"]\.\/pos-zero-friction['"]\)\._internal/.test(handler)
     && !/function\s+_assert\w*SellAuthority/.test(handler),
     'no second authority defined inline');
  ck('the guard is awaited before the rate-limit read',
     handler.indexOf('_assertDarajaSellAuthority(') > -1
     && handler.indexOf('_assertDarajaSellAuthority(') < handler.indexOf('_rl_snap'),
     'guard @' + handler.indexOf('_assertDarajaSellAuthority(') + ' < rate-limit @' + handler.indexOf('_rl_snap'));

  head('PRESERVED BEHAVIOUR — the guard must not have eaten anything downstream');
  for (const marker of [
    ['server pricing authority retained', 'server_recomputed'],
    ['delivery recompute retained',       'delivery_fee_mismatch'],
    ['oversell guard retained',           'Out of stock'],
    ['cross-seller cart guard retained',  'another seller'],
    ['idempotent order dedup retained',   'already been paid'],
    ['rate limit retained',               'Too many payment requests'],
    ['App Check still enforced',          'enforceAppCheck: true'],
    ['collection route still stamped',    'DIRECT_TO_SELLER'],
  ]) ck(marker[0], handler.indexOf(marker[1]) > -1, marker[1]);

  console.log('\n' + '='.repeat(72));
  console.log('  PASS ' + pass + '   FAIL ' + fail + '   INCONCLUSIVE ' + inconclusive);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(72));
  process.exit(fail === 0 && pass > 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
