/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT IDENTITY AUTHORITY + EMPLOYEE SALE AUTHORITY — certification
   ══════════════════════════════════════════════════════════════════════════════
   ONE trustworthy source for who the shop is, who is serving, and what role they
   hold — so no UI ever invents `servedBy`.

   The invariant that carries real consequence:

     AN EMPLOYEE MUST NEVER FALL THROUGH TO THE OWNER'S IDENTITY.

   A receipt crediting the owner for an employee's sale is a false financial record
   and is exactly the record a shift dispute turns on. When the acting identity
   cannot be established the sale FAILS CLOSED — never anonymous, never the owner.

   Nothing off the wire is authority. `servedBy`, `role`, `employeeUid` and
   `cashierName` are ignored entirely; `shopId` is accepted as CONTEXT and the
   relationship is then resolved from shops/ and shopEmployees/ or refused.

   Runs against real Firestore in the emulator:
     firebase emulators:exec --only firestore "node scripts/test-merchant-identity.js"
   Without it, the resolution half is UNPROVEN — never passed.
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

console.log('\nMERCHANT IDENTITY + EMPLOYEE SALE AUTHORITY');
console.log('='.repeat(74));

const SRC = fs.readFileSync(path.join(ROOT, 'functions/merchant-identity.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

head('1 - nothing off the wire is authority');
/* Asserted on the CODE, because the strongest form of "it does not trust X" is
   that X is never read at all. */
['servedBy', 'cashierName', 'employeeUid', 'servedByName'].forEach((f) => {
  ck('`data.' + f + '` is never read from the request',
     CODE.indexOf('d.' + f) === -1 && CODE.indexOf('data.' + f) === -1);
});
ck('`data.role` is never read as authority', !/\bd\.role\b/.test(CODE) && !/data\.role\b/.test(CODE));
ck('`shopId` IS accepted — as context only', /resolveActor\(uid, d\.shopId\)/.test(CODE) ||
   /resolveActor\(uid, \(data \|\| \{\}\)\.shopId\)/.test(CODE));
ck('...and the relationship is then resolved server-side',
   /shopEmployees'\)\.doc\(uid\)/.test(CODE) && /_s\(emp\.shopOwnerId, 64\) !== shopId/.test(CODE));
ck('the uid always comes from auth, never from the payload',
   /function _uid\(auth\)/.test(CODE) && /const uid = _uid\(auth\)/.test(CODE));
ck('NC the detector would catch a payload read if one existed',
   'const x = d.servedBy;'.indexOf('d.servedBy') > -1);

head('2 - the employee name never comes from the shop');
/* The exact false attribution: reading the shop record (the owner) for an
   employee's name. */
ck('the employee name is read from the employment record or the user, not the shop',
   /_s\(emp\.name, 60\) \|\| await _personName\(uid\)/.test(CODE));
ck('_personName reads the PERSON\'s own records only',
   /collection\('users'\)\.doc\(uid\)/.test(CODE) && /admin\.auth\(\)\.getUser\(uid\)/.test(CODE));
ck('...and never the shop document', !/_personName[\s\S]{0,400}collection\('shops'\)/.test(CODE));
ck('an unresolved name is a REFUSAL, not a fallback',
   /reason: 'employee-name-unresolved'/.test(CODE) && /reason: 'owner-name-unresolved'/.test(CODE));

head('3 - the receipt prints who served, and their role');
const R = require(path.join(ROOT, 'sokoni-receipt.js'));
ck('an OWNER sale prints Role: Owner',
   R.servedRoleLine({ servedBy: { name: 'Alex', role: 'owner', label: 'Owner' } }) === 'Role: Owner');
ck('an EMPLOYEE sale prints Role: Staff',
   R.servedRoleLine({ servedBy: { name: 'Brian', role: 'cashier', label: 'Staff' } }) === 'Role: Staff');
ck('a manager prints Role: Manager',
   R.servedRoleLine({ servedBy: { name: 'Mary', role: 'manager', label: 'Manager' } }) === 'Role: Manager');
ck('a bare role still resolves a label', R.servedRoleLine({ servedBy: { name: 'X', role: 'staff' } }) === 'Role: Staff');
ck('no name -> NO role line, so a role can never sit on nobody',
   R.servedRoleLine({ servedBy: { role: 'owner', label: 'Owner' } }) === null);
ck('an unknown role yields no line rather than a guess',
   R.servedRoleLine({ servedBy: { name: 'X', role: 'wizard' } }) === null);
/* End to end through the renderer. */
const Cash = require(path.join(ROOT, 'sokoni-cash.js'));
const Ful = require(path.join(ROOT, 'sokoni-fulfilment.js'));
const mk = (servedBy) => R.toText(R.render({
  receiptId: 'SKN-1', createdAt: '2026-08-19T09:00:00Z',
  items: [{ name: 'Milk', qty: 1, unitMinor: 12000, lineMinor: 12000 }],
  totalMinor: 12000, servedBy: servedBy,
  settlement: Cash.settle({ totalMinor: 12000, tenders: [{ method: 'cash', amountMinor: 12000 }] }),
  fulfilment: Ful.buildFulfilment({ type: 'pickup' }),
  shop: { name: 'Kass Electronics' },
}, {}));
const tOwner = mk({ name: 'Alex', role: 'owner', label: 'Owner' });
const tStaff = mk({ name: 'Brian', role: 'cashier', label: 'Staff' });
ck('the owner receipt reads "Served by: Alex" / "Role: Owner"',
   tOwner.indexOf('Served by: Alex') > -1 && tOwner.indexOf('Role: Owner') > -1);
ck('the employee receipt reads "Served by: Brian" / "Role: Staff"',
   tStaff.indexOf('Served by: Brian') > -1 && tStaff.indexOf('Role: Staff') > -1);
ck('the EMPLOYEE receipt does not name the owner anywhere', tStaff.indexOf('Alex') === -1);

/* ────────────────────────────────────────────────────────────────────────────
   PART B — resolution against real Firestore
   ──────────────────────────────────────────────────────────────────────────── */
(async () => {
  let env = null, admin = null;
  try {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-merchant-identity' });
    await admin.firestore().collection('_ping').doc('x').set({ ok: true });
    env = true;
  } catch (e) {
    head('4-8 - resolution against real Firestore');
    un('the entire resolution half of this certification',
       'emulator/admin unavailable: ' + String((e && e.message) || e).slice(0, 70));
    console.log('        run: firebase emulators:exec --only firestore "node scripts/test-merchant-identity.js"');
    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven + 1) + ' unproven');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }

  const { resolveActor, shopIdentity, ROLE_CAPABILITIES } =
    require(path.join(ROOT, 'functions/merchant-identity.js'))._internal;

  const db = admin.firestore();
  const SHOP = 'shopOwnerA';
  const OTHER = 'shopOwnerB';
  const EMP = 'empBrian';
  const EX = 'empExFired';
  const STRANGER = 'randomZ';

  await db.doc('shops/' + SHOP).set({ name: 'Kass Electronics', phone: '0712345678', city: 'Nairobi' });
  await db.doc('shops/' + OTHER).set({ name: 'Rival Shop' });
  await db.doc('users/' + SHOP).set({ name: 'Alex Ogutu' });
  await db.doc('users/' + EMP).set({ name: 'Brian Otieno' });
  await db.doc('shopEmployees/' + EMP).set({ shopOwnerId: SHOP, role: 'cashier', name: 'Brian', status: 'active' });
  await db.doc('shopEmployees/' + EX).set({ shopOwnerId: SHOP, role: 'cashier', name: 'Ex', status: 'revoked' });

  head('4 - the OWNER resolves as owner');
  const rOwner = await resolveActor(SHOP, SHOP);
  ck('resolved', rOwner.ok === true, rOwner.reason || rOwner.source);
  ck('named from their OWN user record', rOwner.ok && rOwner.servedBy.name === 'Alex Ogutu');
  ck('role owner, label Owner', rOwner.ok && rOwner.servedBy.role === 'owner' && rOwner.servedBy.label === 'Owner');
  ck('may sell', rOwner.ok && rOwner.capabilities.indexOf('sell') > -1);
  ck('ownership is the DOCUMENT ID — there is no ownerId field to forge',
     /if \(uid === shopId\)/.test(CODE));

  head('5 - the EMPLOYEE resolves as themselves, never as the owner');
  const rEmp = await resolveActor(EMP, SHOP);
  ck('resolved', rEmp.ok === true, rEmp.reason || rEmp.source);
  ck('named BRIAN, from the employment record', rEmp.ok && rEmp.servedBy.name === 'Brian');
  ck('...and NOT the owner', rEmp.ok && rEmp.servedBy.name !== 'Alex Ogutu');
  ck('role cashier, label Staff', rEmp.ok && rEmp.servedBy.role === 'cashier' && rEmp.servedBy.label === 'Staff');
  ck('the uid on the attribution is the EMPLOYEE\'s', rEmp.ok && rEmp.servedBy.uid === EMP);
  ck('may sell, may NOT manage staff',
     rEmp.ok && rEmp.capabilities.indexOf('sell') > -1 && rEmp.capabilities.indexOf('manageStaff') === -1);

  head('6 - FAIL CLOSED — every refusal, and none of them fall through');
  const cases = [
    ['a stranger with no employment', await resolveActor(STRANGER, SHOP), 'not-employed-here'],
    ['an employee of A acting on B', await resolveActor(EMP, OTHER), 'not-employed-here'],
    ['a REVOKED employee', await resolveActor(EX, SHOP), 'employment-inactive'],
    ['no shop specified', await resolveActor(EMP, ''), 'shop-not-specified'],
    ['a shop that does not exist', await resolveActor(EMP, 'ghostShop'), 'shop-not-found'],
    ['an unauthenticated caller', await resolveActor(null, SHOP), 'unauthenticated'],
  ];
  cases.forEach(([label, r, reason]) => {
    ck(label + ' is REFUSED', r.ok === false && r.reason === reason, r.reason);
  });
  ck('...and not ONE refusal returned a servedBy',
     cases.every(([, r]) => !r.servedBy), 'no identity leaked on any refusal');
  ck('...specifically, none fell through to the owner',
     cases.every(([, r]) => JSON.stringify(r).indexOf('Alex Ogutu') === -1));

  head('7 - the self-declared employment record grants nothing');
  /* shopEmployees is client-writable with shopOwnerId == self, so anyone can mint
     one. It matches only their OWN shop id and therefore never reaches shop A. */
  await db.doc('shopEmployees/' + STRANGER).set({ shopOwnerId: STRANGER, role: 'manager', name: 'Impostor' });
  const rSelf = await resolveActor(STRANGER, SHOP);
  ck('a self-declared manager record does NOT resolve against shop A',
     rSelf.ok === false && rSelf.reason === 'not-employed-here', rSelf.reason);
  ck('NC ...while the genuine employee still resolves (not vacuous)',
     (await resolveActor(EMP, SHOP)).ok === true);

  head('8 - an unknown employment role is refused, not promoted');
  await db.doc('shopEmployees/oddRole').set({ shopOwnerId: SHOP, role: 'intern', name: 'Sam' });
  const rOdd = await resolveActor('oddRole', SHOP);
  ck('role "intern" is refused rather than treated as staff',
     rOdd.ok === false && rOdd.reason === 'employment-role-unknown', rOdd.reason);
  ck('NC every DEFINED role does resolve',
     (await Promise.all(['cashier', 'staff', 'manager', 'supervisor'].map(async (role, i) => {
       const u = 'roleUser' + i;
       await db.doc('shopEmployees/' + u).set({ shopOwnerId: SHOP, role: role, name: 'R' + i });
       return (await resolveActor(u, SHOP)).ok;
     }))).every(Boolean));
  ck('a role with no `sell` capability could not sell',
     Object.keys(ROLE_CAPABILITIES).every((r) => Array.isArray(ROLE_CAPABILITIES[r])) &&
     /capabilities\.indexOf\('sell'\) === -1/.test(CODE));

  head('9 - the shop identity feeds the receipt without inventing anything');
  const ident = shopIdentity(SHOP, (await db.doc('shops/' + SHOP).get()).data());
  ck('name, phone and city are carried',
     ident.name === 'Kass Electronics' && ident.phone === '0712345678' && ident.city === 'Nairobi');
  ck('an absent logo is ABSENT, not an empty string',
     !('logo' in ident), JSON.stringify(Object.keys(ident)));
  ck('...so the receipt engages its wordmark fallback',
     R.render({ shop: ident }).blocks.filter((b) => b.type === 'identity')[0].mark.kind === 'wordmark');
  ck('NC a shop WITH a logo carries it through',
     shopIdentity(SHOP, { name: 'X', logo: 'https://x/l.png' }).logo === 'https://x/l.png');
  ck('no KRA PIN is invented — shops/{uid} has no tax field', !('kraPin' in ident));

  head('10 - what is NOT yet enforced');
  un('that posCompleteCheckout consults the attribution record',
     'a one-line guard on a deployed money path — deliberately a separate change');
  un('that a real employee can complete a real sale end-to-end',
     'journey D — needs the switcher and a real employee account');

  await db.doc('_ping/x').delete().catch(() => {});
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
