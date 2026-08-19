/* ══════════════════════════════════════════════════════════════════════════════
   ROLE / ACCOUNT BOUNDARY — certification against the REAL live rules
   ══════════════════════════════════════════════════════════════════════════════
   The highest-risk foundation under Merchant v2. A beautiful workspace built on a
   weak account boundary is worse than no workspace, because it looks trustworthy.

   Certified against `firestore.rules.live` — the recorded source of the LIVE
   ruleset — in the Firestore emulator. NOT against mocks, and NOT against the
   worktree `firestore.rules`, which is a candidate that cannot currently release.

     firebase emulators:exec --only firestore "node scripts/test-role-boundary.js"

   Without the emulator the rules half is reported UNPROVEN, never passed.

   ── WHAT MUST BE TRUE ───────────────────────────────────────────────────────
     · the authenticated UID is the identity authority — always
     · a forged `activeRole` cannot elevate access
     · A's shop data is unreachable under B, in the DATA layer, not just the UI
     · an employee cannot become an owner by editing local state
     · buyer <-> merchant switching needs no second login and no second identity
     · refresh, logout, back navigation and direct URLs all preserve the boundary

   ── PROVENANCE LIMIT, STATED ────────────────────────────────────────────────
   `firestore.rules.live` is documented (docs/RULES_RECONCILIATION.md) as the exact
   source of the live ruleset. This session had no gcloud token, so that file was
   NOT re-verified against the live releases API. The rules certified here are the
   recorded live baseline; confirming it still matches production is a separate,
   unrun step — reported as UNPROVEN below rather than assumed.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const RULES_FILE = path.join(ROOT, 'firestore.rules.live');
const rules = fs.readFileSync(RULES_FILE, 'utf8');

console.log('\nROLE / ACCOUNT BOUNDARY — against firestore.rules.live');
console.log('='.repeat(74));

/* ────────────────────────────────────────────────────────────────────────────
   PART A — the rules do not trust anything the client can write
   ──────────────────────────────────────────────────────────────────────────── */

head('1 - the live rules never consult activeRole at all');
/* The strongest possible form of "a forged activeRole cannot elevate": the data
   layer does not read it. Access is uid-ownership, so forging the field grants
   nothing because nothing consults it. */
const stripped = rules.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
ck('`activeRole` appears nowhere in the live ruleset',
   stripped.indexOf('activeRole') === -1,
   (stripped.match(/.{0,40}activeRole.{0,40}/) || ['absent'])[0]);
/* `registeredAs` DOES appear — but only ever to RESTRICT, never to grant. It is a
   client-writable field, so a rule that read it as proof of a role would be a
   forgeable grant. Every occurrence is inside noPrivilegeEscalation(), where it
   blocks self-granted admin keys. Asserted by position, not by hope. */
const regLines = stripped.split('\n')
  .map((l, i) => ({ l: l, i: i }))
  .filter((x) => x.l.indexOf('registeredAs') > -1);
const npeStart = stripped.split('\n').findIndex((l) => /function noPrivilegeEscalation/.test(l));
const npeEnd = npeStart + 20;
ck('`registeredAs` is never used to GRANT — every use is inside noPrivilegeEscalation',
   regLines.length > 0 && regLines.every((x) => x.i > npeStart && x.i < npeEnd),
   regLines.length + ' uses, lines ' + regLines.map((x) => x.i + 1).join(','));
ck('...and it is a RESTRICTION: it blocks self-granted admin keys',
   /!request\.resource\.data\.registeredAs\.keys\(\)\s*\.hasAny\(\['admin','superAdmin','moderator','isAdmin'\]\)/.test(stripped));
ck('the forgeable `registeredAs.seller` grants nothing anywhere in the ruleset',
   stripped.indexOf('registeredAs.seller') === -1);
ck('NC the detector would catch a grant if one existed',
   'allow read: if resource.data.registeredAs.seller == true;'.indexOf('registeredAs.seller') > -1);
ck('NC the detector DOES find a token the rules really use',
   stripped.indexOf('request.auth.uid') > -1);
ck('NC ...and would catch activeRole if it were there',
   'allow read: if resource.data.activeRole == 1;'.indexOf('activeRole') > -1);
/* Ownership, by contrast, is everywhere. */
const ownerChecks = (stripped.match(/request\.auth\.uid/g) || []).length;
ck('the boundary is uid-ownership, used throughout', ownerChecks > 200, ownerChecks + ' uid comparisons');

head('2 - the client authority takes roles from CLAIMS, not from a document');
const ra = fs.readFileSync(path.join(ROOT, 'sokoni-role-authority.js'), 'utf8');
const raCode = ra.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
ck('roles are derived from the ID token claims', /_rolesFromClaims\(/.test(raCode) &&
   /getIdTokenResult/.test(raCode));
ck('setActiveRole REFUSES a role that is not approved',
   /if \(!isApproved\(r\)\) return \{ ok: false/.test(raCode));
ck('...and refuses an unknown role outright', /return \{ ok: false, reason: 'unknown-role' \}/.test(raCode));
ck('a signed-out user cannot set an active role',
   /return \{ ok: false, reason: 'signed-out' \}/.test(raCode));
ck('a server refusal is surfaced, not swallowed',
   /rejected-by-server/.test(raCode));
/* The workspace module must not write activeRole behind the authority's back — it
   did once, and the mirror and the authority disagreed. */
const ws = fs.readFileSync(path.join(ROOT, 'sokoni-workspace.js'), 'utf8');
const wsCode = ws.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
ck('the workspace switcher does NOT write activeRole itself',
   !/activeRole\s*=/.test(wsCode), (wsCode.match(/.{0,30}activeRole\s*=.{0,30}/) || ['clean'])[0]);
ck('NC the detector would catch it if it did',
   /activeRole\s*=/.test('u.activeRole = ws.role;'));

/* ────────────────────────────────────────────────────────────────────────────
   PART B — the rules themselves, in the emulator
   ──────────────────────────────────────────────────────────────────────────── */

(async () => {
  let env = null;
  try {
    const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
    env = await initializeTestEnvironment({
      projectId: 'sokoni-role-boundary',
      firestore: { rules: rules, host: '127.0.0.1', port: 8080 },
    });
  } catch (e) {
    head('3-7 - the rules, in the emulator');
    un('the entire rules half of this certification',
       'emulator unavailable: ' + String((e && e.message) || e).slice(0, 60));
    console.log('        run: firebase emulators:exec --only firestore "node scripts/test-role-boundary.js"');
    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven + 1) + ' unproven');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }

  const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
  const { doc, getDoc, setDoc, updateDoc, collection, getDocs, query, where } = require('firebase/firestore');

  const A = 'ownerA';        /* merchant, owns shop A */
  const B = 'ownerB';        /* a DIFFERENT merchant */
  const E = 'employeeE';     /* employee of shop A */
  const buyer = 'buyerZ';

  /* Seed as admin, bypassing rules — the fixtures are not what is under test. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'products/pA1'), { sellerUid: A, name: 'A Sugar', price: 100, stock: 5 });
    await setDoc(doc(db, 'products/pB1'), { sellerUid: B, name: 'B Sugar', price: 100, stock: 5 });
    await setDoc(doc(db, 'orders/oA1'), { uid: buyer, buyerUid: buyer, sellerUid: A, total: 100, status: 'paid' });
    await setDoc(doc(db, 'orders/oB1'), { uid: buyer, buyerUid: buyer, sellerUid: B, total: 100, status: 'paid' });
    await setDoc(doc(db, 'shopEmployees/' + E), { shopOwnerId: A, role: 'cashier', name: 'Mary' });
    /* The forgery: B's own user document claims to be a seller with A's shop. */
    await setDoc(doc(db, 'users/' + B), { uid: B, activeRole: 'seller', registeredAs: { seller: true }, shopId: A });
  });

  /* Contexts. NOTE what is deliberately NOT in B's token: no seller claim. */
  /* EMULATOR vs PRODUCTION, stated: in the emulator, reading a custom claim that is
     absent from the token is an ERROR, not undefined — so isActive()'s
     `token.deactivated != true` fails closed for a claimless token and NOTHING can
     be created. Production returns undefined and the same expression passes, which is why
     real sellers create products every day. The claim is therefore set explicitly here
     so this suite measures the ROLE BOUNDARY rather than that divergence. */
  const BASE = { deactivated: false };
  const asA = env.authenticatedContext(A, BASE).firestore();
  const asB = env.authenticatedContext(B, BASE).firestore();
  const asE = env.authenticatedContext(E, BASE).firestore();
  const asBuyer = env.authenticatedContext(buyer, BASE).firestore();

  head('3 - a FORGED activeRole elevates nothing');
  await assertSucceeds(getDoc(doc(asB, 'users/' + B)))
    .then(() => ck('B really does hold a forged activeRole:seller document', true))
    .catch(() => ck('B really does hold a forged activeRole:seller document', false));
  await assertFails(setDoc(doc(asB, 'products/forged1'), { sellerUid: A, name: 'x', price: 10 }))
    .then(() => ck('...yet B cannot create a product owned by A', true))
    .catch(() => ck('...yet B cannot create a product owned by A', false));
  await assertFails(updateDoc(doc(asB, 'products/pA1'), { price: 1 }))
    .then(() => ck('...cannot reprice A\'s product', true))
    .catch(() => ck('...cannot reprice A\'s product', false));
  await assertFails(getDoc(doc(asB, 'orders/oA1')))
    .then(() => ck('...and cannot read A\'s order', true))
    .catch(() => ck('...and cannot read A\'s order', false));

  head('4 - NEGATIVE CONTROL: the real owner CAN do all of it');
  /* Without this, section 3 would pass on a ruleset that denies everyone. */
  await assertSucceeds(setDoc(doc(asA, 'products/pA2'), { sellerUid: A, name: 'A Rice', price: 200, stock: 3 }))
    .then(() => ck('NC A creates a product it owns', true))
    .catch((e) => ck('NC A creates a product it owns', false, String(e).slice(0, 70)));
  await assertSucceeds(updateDoc(doc(asA, 'products/pA1'), { price: 150 }))
    .then(() => ck('NC A reprices its own product', true))
    .catch((e) => ck('NC A reprices its own product', false, String(e).slice(0, 70)));
  await assertSucceeds(getDoc(doc(asA, 'orders/oA1')))
    .then(() => ck('NC A reads its own order', true))
    .catch((e) => ck('NC A reads its own order', false, String(e).slice(0, 70)));

  head('5 - A\'s data is unreachable under B — in the DATA layer');
  await assertFails(getDoc(doc(asA, 'orders/oB1')))
    .then(() => ck('A cannot read B\'s order either — the boundary is symmetric', true))
    .catch(() => ck('A cannot read B\'s order either — the boundary is symmetric', false));
  await assertFails(updateDoc(doc(asA, 'products/pB1'), { price: 1 }))
    .then(() => ck('A cannot touch B\'s product', true))
    .catch(() => ck('A cannot touch B\'s product', false));
  /* Ownership cannot be reassigned to steal a product. */
  await assertFails(updateDoc(doc(asA, 'products/pA1'), { sellerUid: B }))
    .then(() => ck('sellerUid cannot be reassigned, even by the owner', true))
    .catch(() => ck('sellerUid cannot be reassigned, even by the owner', false));
  await assertFails(setDoc(doc(asB, 'products/steal1'), { sellerUid: B, name: 'x', price: 10, adminApproved: true }))
    .then(() => ck('admin-only fields cannot be self-granted on create', true))
    .catch(() => ck('admin-only fields cannot be self-granted on create', false));

  head('6 - the employee boundary');
  await assertSucceeds(getDoc(doc(asE, 'shopEmployees/' + E)))
    .then(() => ck('an employee can read their OWN employment record', true))
    .catch((e) => ck('an employee can read their OWN employment record', false, String(e).slice(0, 70)));
  await assertSucceeds(getDoc(doc(asA, 'shopEmployees/' + E)))
    .then(() => ck('NC the shop owner can read it too', true))
    .catch((e) => ck('NC the shop owner can read it too', false, String(e).slice(0, 70)));
  await assertFails(getDoc(doc(asB, 'shopEmployees/' + E)))
    .then(() => ck('an unrelated merchant CANNOT read it', true))
    .catch(() => ck('an unrelated merchant CANNOT read it', false));
  /* The elevation attempt this gate exists for. */
  await assertFails(updateDoc(doc(asE, 'shopEmployees/' + E), { role: 'owner', shopOwnerId: E }))
    .then(() => ck('an employee CANNOT promote themselves to owner', true))
    .catch(() => ck('an employee CANNOT promote themselves to owner', false));
  /* The elevation that would actually matter is claiming to work FOR A. */
  await assertFails(setDoc(doc(asE, 'shopEmployees/impostor'), { shopOwnerId: A, role: 'manager' }))
    .then(() => ck('...nor mint an employment record placing themselves under A', true))
    .catch(() => ck('...nor mint an employment record placing themselves under A', false));
  /* By contrast, a SELF-owned record IS permitted by the rule (create requires
     request.resource.data.shopOwnerId == request.auth.uid). That is by design — it
     is how an owner adds their own staff — and it grants nothing over shop A. It is
     recorded, not asserted away, because it means shopEmployees is self-declarable
     and must never be read as proof that someone is a merchant. */
  let selfOwned = null;
  await assertSucceeds(setDoc(doc(asE, 'shopEmployees/' + E + '_self'), { shopOwnerId: E, role: 'owner' }))
    .then(() => { selfOwned = 'permitted'; }).catch(() => { selfOwned = 'denied'; });
  ck('a SELF-owned employment record is permitted by design', selfOwned === 'permitted', selfOwned);
  /* And it buys nothing: re-tested AFTER the record exists, not assumed. */
  await assertFails(getDoc(doc(asE, 'orders/oA1')))
    .then(() => ck('...and having minted it, E STILL cannot read A\'s order', true))
    .catch(() => ck('...and having minted it, E STILL cannot read A\'s order', false));

  head('7 - FINDING: an employee has no data access to the shop they work for');
  /* Not a pass or a fail of the boundary — it is airtight. It is a GAP for the
     employee journey: products and orders are keyed to sellerUid == auth.uid, so
     an employee cannot read the shop's orders or touch its products at all. Any
     employee sale must therefore go through a server callable that checks
     shopEmployees, never through direct client writes. */
  let empProduct = null;
  await assertFails(setDoc(doc(asE, 'products/eP1'), { sellerUid: A, name: 'x', price: 10 }))
    .then(() => { empProduct = 'denied'; })
    .catch(() => { empProduct = 'ALLOWED'; });
  ck('an employee cannot create a product for their employer', empProduct === 'denied', empProduct);
  let empOrder = null;
  await assertFails(getDoc(doc(asE, 'orders/oA1')))
    .then(() => { empOrder = 'denied'; })
    .catch(() => { empOrder = 'ALLOWED'; });
  ck('an employee cannot read their employer\'s orders', empOrder === 'denied', empOrder);
  ck('=> an employee sale MUST go through a server callable, not client writes',
     empProduct === 'denied' && empOrder === 'denied', 'recorded as a gap, not a pass');

  head('8 - a buyer is a buyer, and buyer<->merchant needs no second identity');
  let buyerOwn = false, buyerOther = false, sellerOwn = false;
  await getDoc(doc(asBuyer, 'orders/oA1')).then(() => { buyerOwn = true; }).catch(() => {});
  await getDoc(doc(asBuyer, 'orders/oB1')).then(() => { buyerOther = true; }).catch(() => {});
  await getDoc(doc(asA, 'orders/oA1')).then(() => { sellerOwn = true; }).catch(() => {});
  ck('the buyer reads their OWN order', buyerOwn);
  /* oB1 is also the buyer's order (uid: buyer), so it SHOULD be readable — the
     boundary here is seller-side, and asserting a denial would be asserting a bug. */
  ck('NC ...and their other order too, because both are genuinely theirs', buyerOther);
  ck('the seller reads the same order from the seller side', sellerOwn);
  /* Both capacities resolved on ONE uid under ONE ruleset, with no second account
     and no second login anywhere in the path. */
  ck('one authenticated UID carries both capacities — no second identity is created',
     buyerOwn && sellerOwn, 'buyer-side ' + buyerOwn + ', seller-side ' + sellerOwn);

  head('9 - MEASURED FINDING: products/create has no approved-seller gate');
  /* Measured, not assumed. The rule at L867 is isActive() && isAuthed() &&
     sellerUid == request.auth.uid — pure uid-ownership, with no seller claim and no
     approval check anywhere in it. */
  let buyerSells = null;
  await assertSucceeds(setDoc(doc(asBuyer, 'products/bP1'), { sellerUid: buyer, name: 'x', price: 10 }))
    .then(() => { buyerSells = 'ALLOWED'; }).catch(() => { buyerSells = 'denied'; });
  ck('an ordinary BUYER with no seller claim can create a product',
     buyerSells === 'ALLOWED', buyerSells);
  ck('...because the create rule checks ownership only, not approval',
     /allow create: if isActive\(\) && isAuthed\(\)\s*&& request\.resource\.data\.sellerUid == request\.auth\.uid/.test(rules));
  ck('...and no seller claim is consulted anywhere in the products block',
     (rules.split('match /products/{productId}')[1] || '').split('}')[0].indexOf('token.') === -1);
  ck('=> approval is enforced ABOVE the rules, so it is not a data-layer boundary',
     buyerSells === 'ALLOWED', 'consistent with the frozen seller-approval finding');

  await env.cleanup();

  head('10 - provenance');
  un('that firestore.rules.live still matches the deployed ruleset',
     'no gcloud token in this session — releases API not queried');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
