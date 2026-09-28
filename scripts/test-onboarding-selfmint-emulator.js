#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   Merchant V2 Canonicalization Slice 20 — onboarding self-mint closure.

   THE VULNERABILITY, in one line:

     httpsCallable('onboardingDispatch')({ op:'onbActivateRole', role:'merchant' })

   `onbActivateRole` (universal-onboarding.js) mints `{ [role]: true }` plus
   `{ [CLAIM_KEY[role]]: profileId }` for any role in its own VALID_ROLES — which
   contains merchant, provider, rider, driver and 16 more — after checking nothing
   but that the caller is signed in. It is reachable live: ROUTES in
   onboarding-dispatch.js:21 → exports.onboardingDispatch at index.js:12436.

   A custom claim is the platform's authority primitive. Every rule and every
   callable that trusts one trusts it BECAUSE no client can write it. This
   function breaks that premise for twenty role names at once.

   THE SUITE REPRODUCES IT BEFORE ASSERTING IT IS CLOSED. A closure test that
   never demonstrated the hole proves only that the code does not do something —
   which is also true of code that never could. Section 1 runs the exact attack
   against the real handler and reports what a signed-in stranger walks away with.

   WHAT MUST KEEP WORKING, and is asserted here rather than assumed:
     · the onboarding product itself — accounts/, accountProfiles/, drafts. None
       of those rules read a claim (firestore.rules:5177-5191, all uid-keyed or
       public), so the rail loses nothing by minting none.
     · approval. grantAccountRole is the authority and still mints.
     · every claim the account already held.

   Run (needs firestore + auth emulators):
     firebase emulators:exec --only firestore,auth "node scripts/test-onboarding-selfmint-emulator.js"

   Flags:
     --expect-vulnerable   invert section 2: PASS when the hole is still open.
                           Used to prove the reproduction is real before the fix.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'sokoni-selfmint-test';

const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'sokoni-selfmint-test' });
const db = admin.firestore();
const auth = admin.auth();

const EXPECT_VULNERABLE = process.argv.includes('--expect-vulnerable');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '   [' + detail + ']' : '')); }
};
const head = (t) => console.log('\n-- ' + t + ' --');

const UO = require(path.join(__dirname, '..', 'functions', 'universal-onboarding.js'))._h;
const LC = require(path.join(__dirname, '..', 'functions', 'application-lifecycle.js'))._internal;

const mkUser = async (uid, claims) => {
  try { await auth.deleteUser(uid); } catch (_) {}
  await auth.createUser({ uid, email: uid + '@example.test', password: 'testpass123' });
  if (claims) await auth.setCustomUserClaims(uid, claims);
};
const claimsOf = async (uid) => (await auth.getUser(uid)).customClaims || {};
const call = (uid, data) => UO.onbActivateRole({ auth: uid ? { uid } : null, data });
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

const ATTACKER = 'uidStranger';
const ATTACKER2 = 'uidStranger2';
const REAL_MERCHANT = 'uidRealMerchant';
const REAL_PROVIDER = 'uidRealProvider';
const HOTELIER = 'uidHotelier';

(async () => {

  /* ══ 1 · REPRODUCE — what a signed-in stranger can currently take ══════════ */
  head('1 · REPRODUCTION — a signed-in stranger calls the real handler');

  await mkUser(ATTACKER);
  const before = await claimsOf(ATTACKER);
  ck('the attacker starts with NO claims', Object.keys(before).length === 0, JSON.stringify(before));

  const res = await call(ATTACKER, { role: 'merchant', profileData: { name: 'Totally Legit Ltd' } });
  ck('the call SUCCEEDS — no approval was required of it',
     res && res.activated === true, JSON.stringify(res));

  const after = await claimsOf(ATTACKER);
  console.log('      claims now: ' + JSON.stringify(after));

  const gotRoleClaim = after.merchant === true;
  const gotIdClaim = typeof after.merchantId === 'string';

  if (EXPECT_VULNERABLE) {
    ck('REPRODUCED: a merchant CLAIM was minted with no approval', gotRoleClaim, JSON.stringify(after));
    ck('REPRODUCED: a merchantId CLAIM was minted too', gotIdClaim, after.merchantId);
  } else {
    ck('CLOSED: no merchant claim was minted', !gotRoleClaim, JSON.stringify(after));
    ck('CLOSED: no merchantId claim was minted', !gotIdClaim, JSON.stringify(after));
  }

  /* The blast radius of the identifier claim, stated precisely rather than
     hand-waved. firestore.rules:5017-5037 and marketing-engine.js:123 compare a
     document's merchantId against this claim, and onbActivateRole is its ONLY
     minter anywhere in functions/ — so the value it writes (BIZ-xxxxxxxx) has a
     different shape from a real merchantId (SOK-XXXXXX, business-bootstrap), and
     matches no live document. The hole is a premise violation, not a data leak. */
  if (gotIdClaim) {
    ck('…and it is BIZ-shaped, so it matches no real merchantId (SOK-)',
       /^BIZ-/.test(after.merchantId), after.merchantId);
  }

  /* ══ 2 · THE FIX — the same call grants nothing ════════════════════════════ */
  head('2 · the onboarding rail still works, and grants no authority');

  const acct = (await db.collection('accounts').doc(ATTACKER).get()).data() || {};
  ck('the onboarding PRODUCT still works — the role is recorded on the account',
     (acct.roles || []).indexOf('merchant') > -1, JSON.stringify(acct.roles));
  ck('…and a profile document was still created',
     !!res.profileId && (await db.collection('accountProfiles').doc(res.profileId).get()).exists,
     res.profileId);
  ck('…and the handler still answers with a dashboard, so the UI is unbroken',
     typeof res.dashboard === 'string' && res.dashboard.length > 0, res.dashboard);

  /* Those three collections are uid-keyed or public in firestore.rules
     (5177-5191) and read no claim, which is why minting none costs nothing. */

  head('2b · the client authority must not report the role as approved');
  /* sokoni-role-authority.js derives approved roles from CLAIMS. Since Slice 19
     put `merchant` in CANONICAL, a self-minted merchant claim would make
     isApproved('merchant') true and the client workspace guard would pass. The
     server door still refuses — but the client must not be lying either. */
  const fs = require('fs');
  /* LINEAGE NOTE (port onto feat/creator-hub, CHANGELOG 237): this lineage has NO sokoni-role-authority.js, so
     there is no client role authority that could over-report a claim. Reported as N/A — neither a PASS nor
     silently skipped. The server-side closure above is what this lineage needs proven. */
  const RA_PATH = path.join(__dirname, '..', 'sokoni-role-authority.js');
  if (!fs.existsSync(RA_PATH)) {
    console.log('  N/A   sokoni-role-authority.js is not on this lineage — no client role authority to check');
  } else {
  const RA = fs.readFileSync(RA_PATH, 'utf8');
  const CANON = (RA.match(/var CANONICAL = \[([\s\S]*?)\];/) || [, ''])[1]
    .match(/'([a-z]+)'/g).map((s) => s.replace(/'/g, ''));
  const LEG = {};
  (RA.match(/var LEGACY_CLAIM = \{([\s\S]*?)\};/) || [, ''])[1]
    .replace(/(\w+):\s*'([a-z]+)'/g, (_, k, v) => { LEG[k] = v; return ''; });
  const rolesFromClaims = (c) => {
    const out = ['buyer'];
    CANON.forEach((r) => { if (c[r] === true && out.indexOf(r) < 0) out.push(r); });
    Object.keys(LEG).forEach((l) => { if (c[l] === true && out.indexOf(LEG[l]) < 0) out.push(LEG[l]); });
    return out;
  };
  const attackerRoles = rolesFromClaims(await claimsOf(ATTACKER));
  if (EXPECT_VULNERABLE) {
    ck('REPRODUCED: the client authority would grant the merchant workspace',
       attackerRoles.indexOf('merchant') > -1, JSON.stringify(attackerRoles));
  } else {
    ck('the client authority resolves the stranger to buyer ONLY',
       attackerRoles.length === 1 && attackerRoles[0] === 'buyer', JSON.stringify(attackerRoles));
  }
  }   /* end: sokoni-role-authority.js present on this lineage */

  /* ══ 3 · every OTHER role in VALID_ROLES ═══════════════════════════════════ */
  head('3 · no role in VALID_ROLES may be self-granted');

  const ROLES = ['provider', 'rider', 'driver', 'courier', 'property', 'hotel',
                 'restaurant', 'pharmacy', 'events', 'employer', 'freelancer',
                 'distributor', 'wholesaler', 'manufacturer', 'ngo', 'school',
                 'healthcare', 'finance', 'buyer'];
  await mkUser(ATTACKER2);
  let mintedAny = [];
  for (const r of ROLES) {
    await call(ATTACKER2, { role: r });
    const c = await claimsOf(ATTACKER2);
    if (c[r] === true) mintedAny.push(r);
  }
  const finalClaims = await claimsOf(ATTACKER2);
  if (EXPECT_VULNERABLE) {
    ck('REPRODUCED: every role is self-mintable', mintedAny.length === ROLES.length,
       mintedAny.length + '/' + ROLES.length + ' -> ' + mintedAny.join(','));
  } else {
    ck('NO role claim is minted for any of the 19', mintedAny.length === 0, mintedAny.join(','));
    ck('…and no identifier claim either',
       Object.keys(finalClaims).length === 0, JSON.stringify(finalClaims));
  }
  /* The onboarding product still records them. */
  const acct2 = (await db.collection('accounts').doc(ATTACKER2).get()).data() || {};
  ck('the account still records every activated role (product unbroken)',
     ROLES.every((r) => (acct2.roles || []).indexOf(r) > -1), JSON.stringify(acct2.roles));

  /* ══ 4 · APPROVAL still grants — the authority rail is untouched ═══════════ */
  head('4 · approval is still the thing that grants');

  await mkUser(REAL_MERCHANT);
  await db.collection('users').doc(REAL_MERCHANT).set({ uid: REAL_MERCHANT, name: 'Real Merchant' });
  /* LINEAGE NOTE (feat/creator-hub, CHANGELOG 237): this lineage's resolveRole does not read `requestedRole`
     (the live lineage's intake vocabulary); a merchant application declares itself with `type:'seller'`
     (application-lifecycle DECLARED_TYPES). The control is unchanged: a REAL approval still grants seller. */
  await LC.applyDecision('appRM', {
    uid: REAL_MERCHANT, status: 'approved', requestedRole: 'merchant', type: 'seller', name: 'Real Merchant',
  });
  let c = await claimsOf(REAL_MERCHANT);
  ck('an APPROVED merchant gets the seller authority claim', c.seller === true, JSON.stringify(c));
  ck('…and still no merchant claim, which nothing may mint yet',
     c.merchant === undefined, JSON.stringify(c));

  await mkUser(REAL_PROVIDER);
  await db.collection('users').doc(REAL_PROVIDER).set({ uid: REAL_PROVIDER, name: 'Real Provider' });
  await LC.applyDecision('appRP', {
    uid: REAL_PROVIDER, status: 'approved', requestedRole: 'provider', name: 'Real Provider',
  });
  c = await claimsOf(REAL_PROVIDER);
  ck('an APPROVED provider gets the provider claim', c.provider === true, JSON.stringify(c));

  head('4b · an UNAPPROVED merchant has no merchant authority');
  const unapproved = await claimsOf(ATTACKER);
  ck('the stranger holds no seller claim', unapproved.seller === undefined, JSON.stringify(unapproved));
  ck('…and no provider claim', unapproved.provider === undefined, JSON.stringify(unapproved));

  /* ══ 5 · EXISTING CLAIMS ARE PRESERVED ═════════════════════════════════════ */
  head('5 · onboarding never destroys a claim it did not grant');

  /* setCustomUserClaims REPLACES the whole object. A real merchant using
     "Add Another Role" (provider-dashboard.html:301 links straight here) must not
     lose their authority, their tenancy, or their POS identity on the way. */
  await mkUser(HOTELIER, {
    seller: true, merchantId: 'SOK-REAL01', posRole: 'owner',
    admin: false, tenantId: 'TEN-1',
  });
  await call(HOTELIER, { role: 'hotel', profileData: { name: 'Serena' } });
  c = await claimsOf(HOTELIER);
  ck('the seller authority claim survives', c.seller === true, JSON.stringify(c));
  ck('the REAL merchantId claim survives — and is not overwritten',
     c.merchantId === 'SOK-REAL01', c.merchantId);
  ck('the posRole claim survives', c.posRole === 'owner', c.posRole);
  ck('the tenantId claim survives', c.tenantId === 'TEN-1', c.tenantId);
  if (!EXPECT_VULNERABLE) {
    ck('…and no hotel claim was added', c.hotel === undefined, JSON.stringify(c));
  }

  /* THE OVERWRITE, in the case that actually triggers it. `hotel` maps to a
     hotelId claim, so it never collided. `merchant` maps to merchantId — the one
     identifier claim firestore.rules:5017-5037 and marketing-engine.js:123
     actually read. A real merchant who taps "Add Another Role" and picks merchant
     had their live merchantId replaced with a freshly generated BIZ- id, losing
     every POS cash-session read that clause grants. Availability, not privilege,
     but a real merchant really loses a real thing. */
  await call(HOTELIER, { role: 'merchant', profileData: { name: 'Second Shop' } });
  c = await claimsOf(HOTELIER);
  if (EXPECT_VULNERABLE) {
    ck('REPRODUCED: the real merchantId claim is OVERWRITTEN with a BIZ- id',
       c.merchantId !== 'SOK-REAL01' && /^BIZ-/.test(String(c.merchantId)), c.merchantId);
  } else {
    ck('THE OVERWRITE IS CLOSED: the real merchantId claim is intact',
       c.merchantId === 'SOK-REAL01', c.merchantId);
    ck('…and the seller authority survived that call too', c.seller === true, JSON.stringify(c));
  }

  /* ══ 6 · the pre-existing guards still hold ════════════════════════════════ */
  head('6 · unauthenticated and unknown roles are still refused');

  ck('unauthenticated is refused',
     (await threw(() => call(null, { role: 'merchant' }))) === 'unauthenticated');
  ck('an unknown role is refused',
     (await threw(() => call(ATTACKER, { role: 'superadmin' }))) === 'invalid-argument');
  ck('a forged role name is refused',
     (await threw(() => call(ATTACKER, { role: 'admin' }))) === 'invalid-argument');
  ck('an empty role is refused',
     (await threw(() => call(ATTACKER, { role: '' }))) === 'invalid-argument');
  ck('a non-string role is refused',
     (await threw(() => call(ATTACKER, { role: { evil: true } }))) === 'invalid-argument');

  console.log(`\n${pass} passed, ${fail} failed`
    + (EXPECT_VULNERABLE ? '   (--expect-vulnerable: asserting the hole is OPEN)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
