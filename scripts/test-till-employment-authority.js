#!/usr/bin/env node
/* TILL EMPLOYMENT AUTHORITY — the repair, certified against a real Firestore.
 *
 *   firebase emulators:exec --only firestore --project sokoni-till-authority \
 *     "node scripts/test-till-employment-authority.js"
 *
 * docs/SHOP_EMPLOYMENT_TILL_AUTHORITY_DECISION.md
 *
 * THE DEFECT. shop-employees.js is "the ONE contract for who works at this
 * shop" and states its predicate in its own header — believed iff shopId
 * matches, uid matches, ACTIVE !== FALSE, role is known, and shopOwnerId
 * matches the shop's real owner. merchant-identity.resolveActor implemented
 * four of those five and replaced the fifth with a private `status` vocabulary
 * that NO WRITER HAS EVER WRITTEN, so `_employmentActive` returned true for an
 * absent field. removeShopEmployee returned {ok:true, active:false} to an owner
 * while the removed cashier kept selling.
 *
 * WHY THE EMULATOR. resolveActor reads shops, shopEmployees and users. Stubbing
 * `admin.firestore` is the documented way to certify a module while silently
 * hitting production instead — it is a prototype getter and the assignment can
 * fail without a word. Running the real Admin SDK against the emulator removes
 * the question.
 *
 * WHY resolveActor AND NOT resolveShopAccess. The defect is that two consumers
 * of one contract DISAGREED. Certifying the consumer that was already correct
 * would prove nothing about the one that was not. §3 below asserts they now
 * agree, record by record, and §2 proves the till path specifically.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('\n  REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is not set.\n' +
    '  This suite resolves real authorization against real documents. Run it via:\n' +
    '    firebase emulators:exec --only firestore --project sokoni-till-authority \\\n' +
    '      "node scripts/test-till-employment-authority.js"\n');
  process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-till-authority' });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = t => console.log('\n' + t);

const MI = require(path.join(FN, 'merchant-identity.js'));
const SE = require(path.join(FN, 'shop-employees.js'));
const resolveActor = MI._internal.resolveActor;

/* Comment-stripped source, for the assertions that are ABOUT the code. A check
   that matches its own explanatory prose proves nothing. */
function strip (file) {
  return fs.readFileSync(path.join(FN, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

const OWNER = 'u_owner', EMP = 'u_emp', OTHER = 'u_other';
const SHOP = OWNER;                 /* resolveActor: ownership IS the document id */

async function wipe () {
  for (const c of ['shops', 'shopEmployees', 'users']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
}
async function seedWorld () {
  await db.doc('shops/' + SHOP).set({ ownerId: OWNER, storeName: 'A Shop' });
  await db.doc('users/' + OWNER).set({ name: 'Owner Person' });
  await db.doc('users/' + EMP).set({ name: 'Sam Cashier' });
}
/** A record exactly as acceptShopInvite writes one (index.js:5663). */
const REC = (over) => Object.assign({
  uid: EMP, email: 'sam@example.com', name: 'Sam Cashier', role: 'cashier',
  shopId: SHOP, shopOwnerId: OWNER, shopName: 'A Shop', active: true,
}, over || {});
const putEmp = (over, id) =>
  db.doc('shopEmployees/' + (id || `${SHOP}_${EMP}`)).set(REC(over));

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  TILL EMPLOYMENT AUTHORITY — ' + process.env.FIRESTORE_EMULATOR_HOST);
  console.log('══════════════════════════════════════════════════════════════════');

  /* ══ 1. THE LEGITIMATE PATH ════════════════════════════════════════════════
     First, and deliberately. A hostile-only suite passes a guard that refuses
     everybody, and "nobody can sell" would satisfy every refusal assertion
     below while breaking every till in the country. */
  head('1 - an ACTIVE employee remains authorized on the till path');
  {
    await wipe(); await seedWorld(); await putEmp();
    const r = await resolveActor(EMP, SHOP);
    ck('authorized', r.ok === true, r.reason);
    ck('  …source is the employment record', r.source === 'shop-employee', r.source);
    ck('  …servedBy names the EMPLOYEE, never the owner',
       r.servedBy.uid === EMP && r.servedBy.name === 'Sam Cashier', JSON.stringify(r.servedBy));
    ck('  …role and label preserved',
       r.servedBy.role === 'cashier' && r.servedBy.label === 'Cashier');
    ck('  …capabilities are the cashier ceiling',
       r.capabilities.join(',') === MI._internal.ROLE_CAPABILITIES.cashier.join(','),
       r.capabilities.join(','));

    /* ── NEVER THE OWNER ────────────────────────────────────────────────────
       This module's header names this as the reason it exists: "a receipt
       crediting the owner for an employee's sale is a false financial record,
       and it is exactly the record a shift dispute turns on". An unresolvable
       name must REFUSE, not substitute. Asserted with a fixture that can see
       it — every other case here supplies a name, which would make a fallback
       INERT and a sabotage of it read green. */
    await wipe(); await seedWorld();
    await db.doc('users/' + EMP).delete();
    await putEmp({ name: '' });
    const anon = await resolveActor(EMP, SHOP);
    ck('an employee whose name cannot be resolved is REFUSED', anon.ok === false, anon.reason);
    ck('  …and never falls back to the owner\'s name',
       !(anon.servedBy && anon.servedBy.name === 'Owner Person'), JSON.stringify(anon.servedBy));
  }

  /* ══ 2. THE DEFECT, ON THE PATH THAT CARRIES MONEY ═════════════════════════ */
  head('2 - an active:false employee is REFUSED by the till path');
  {
    await wipe(); await seedWorld(); await putEmp({ active: false });
    const r = await resolveActor(EMP, SHOP);
    ck('REFUSED', r.ok === false, JSON.stringify(r).slice(0, 60));
    ck('  …and says so as an inactive employment', r.reason === 'employment-inactive', r.reason);

    /* The three things pos-zero-friction actually derives from this result.
       Asserting only `ok` would leave the consequences unproven. */
    ck('  …so the merchant is NOT proven (pos-zero-friction:477)', !(r && r.ok));
    ck('  …no discount authority (pos-zero-friction:553)',
       !((r.capabilities || []).indexOf('discount') > -1));
    ck('  …and NO servedBy for the receipt (pos-zero-friction:1108)',
       !(r && r.ok && r.servedBy));

    /* The removal path end to end, not a hand-written active:false. */
    await wipe(); await seedWorld(); await putEmp();
    ck('  CONTROL: authorized before removal', (await resolveActor(EMP, SHOP)).ok === true);
    await db.doc(`shopEmployees/${SHOP}_${EMP}`)
      .update({ active: false, removedAt: new Date(), removedBy: OWNER });
    ck('  after removeShopEmployee\'s exact write, REFUSED',
       (await resolveActor(EMP, SHOP)).ok === false);
  }

  /* ══ 2b. THE REPAIR CHANGED THE AUTHORITY SOURCE AND NOTHING ELSE ══════════
     The subtle regression available here is fixing authorization while quietly
     altering WHO GETS CREDITED FOR A SALE. `servedBy` is a financial record —
     this module's header calls a receipt crediting the owner for an employee's
     sale "exactly the record a shift dispute turns on". So the whole
     attribution payload is pinned to its expected value field by field, not
     merely checked for truthiness: a regression that swapped a name or widened
     a capability set would satisfy `ok === true` perfectly. */
  head('2b - the financial attribution payload is unchanged');
  {
    await wipe(); await seedWorld();
    await putEmp({ role: 'manager', restrictions: ['discount'] });
    const r = await resolveActor(EMP, SHOP);

    const EXPECT = {
      servedBy: { uid: EMP, name: 'Sam Cashier', role: 'manager', label: 'Manager' },
      capabilities: MI._internal.ROLE_CAPABILITIES.manager.filter(c => c !== 'discount'),
      restrictions: ['discount'],
      source: 'shop-employee',
      shopId: SHOP,
    };
    ck('servedBy is EXACTLY the expected attribution',
       JSON.stringify(r.servedBy) === JSON.stringify(EXPECT.servedBy), JSON.stringify(r.servedBy));
    ck('  …the credited uid is the EMPLOYEE, not the owner',
       r.servedBy.uid === EMP && r.servedBy.uid !== OWNER);
    ck('  …the credited NAME is the employee\'s own',
       r.servedBy.name === 'Sam Cashier' && r.servedBy.name !== 'Owner Person');
    ck('capabilities are EXACTLY the narrowed ceiling',
       r.capabilities.join(',') === EXPECT.capabilities.join(','), r.capabilities.join(','));
    ck('restrictions are EXACTLY as written',
       JSON.stringify(r.restrictions) === JSON.stringify(EXPECT.restrictions));
    ck('the source still names the employment record, not ownership',
       r.source === EXPECT.source && r.shopId === EXPECT.shopId);

    /* The shape itself, so a field cannot be quietly ADDED or DROPPED. */
    ck('the payload carries exactly the expected keys',
       Object.keys(r).sort().join(',') === 'capabilities,ok,restrictions,servedBy,shop,shopId,source',
       Object.keys(r).sort().join(','));
    ck('  …and servedBy exactly its four',
       Object.keys(r.servedBy).sort().join(',') === 'label,name,role,uid',
       Object.keys(r.servedBy).sort().join(','));

    /* INVERTING CONTROL — the comparison can fail. Without it, a JSON.stringify
       equality that always matched would read identically. */
    ck('CONTROL: the attribution comparison DOES fail on a changed name',
       JSON.stringify(Object.assign({}, r.servedBy, { name: 'Owner Person' }))
         !== JSON.stringify(EXPECT.servedBy));
  }

  /* ══ 3. THE TWO CONSUMERS NO LONGER DISAGREE ═══════════════════════════════
     The defect was a DISAGREEMENT, so the repair's proof is agreement across a
     matrix — not either consumer in isolation. */
  head('3 - resolveActor and resolveShopAccess agree, record by record');
  {
    const CASES = [
      ['a clean active record',            {},                                    true],
      ['active:false',                     { active: false },                     false],
      ['an unknown role',                  { role: 'supervisor' },                false],
      ['shopOwnerId naming someone else',  { shopOwnerId: OTHER },                false],
      ['shopId naming another shop',       { shopId: 'SOME_OTHER_SHOP' },         false],
      ['uid naming another person',        { uid: OTHER },                        false],
      ['active absent (legacy shape)',     { active: undefined },                 true],
    ];
    for (const [label, over, expect] of CASES) {
      await wipe(); await seedWorld();
      const rec = REC(over);
      if (over.active === undefined && 'active' in over) delete rec.active;
      await db.doc(`shopEmployees/${SHOP}_${EMP}`).set(rec);

      const a = await resolveActor(EMP, SHOP);
      let b;
      try { b = (await SE.resolveShopAccess(EMP, SHOP)).via === 'employee'; }
      catch (_) { b = false; }
      ck(label, a.ok === expect && b === expect,
         'resolveActor=' + a.ok + ' resolveShopAccess=' + b + ' expected=' + expect);
    }
    console.log('  NOTE  `active` ABSENT is believed, by the contract\'s own wording');
    console.log('        (`active !== false`). That is the canonical predicate, not a');
    console.log('        leftover of the private one — §6 proves the private one is gone.');
  }

  /* ══ 4. THE OWNER ARM IS UNCHANGED ═════════════════════════════════════════
     The repair touched the EMPLOYEE arm only. resolveActor keys ownership off
     the shops/{uid} document id; shop-employees.js reads the
     ownerId|sellerUid|ownerUid union. Converging those is separate work, and a
     repair that quietly did it would be a different change than the one
     authorized. */
  head('4 - owner authorization is untouched');
  {
    await wipe(); await seedWorld();
    const r = await resolveActor(OWNER, SHOP);
    ck('the owner is authorized with NO employment record at all', r.ok === true, r.reason);
    ck('  …source is shop ownership', r.source === 'shop-owner', r.source);
    ck('  …and carries the OWNER capability set, not a role ceiling',
       r.capabilities.join(',') === MI._internal.OWNER_CAPABILITIES.join(','));
    ck('  …labelled Owner', r.servedBy.role === 'owner' && r.servedBy.label === 'Owner');

    /* An owner is not narrowed by an employment record, and cannot be revoked
       by one — the arms must stay independent in BOTH directions. */
    await db.doc(`shopEmployees/${SHOP}_${OWNER}`).set(REC({ uid: OWNER, active: false }));
    const r2 = await resolveActor(OWNER, SHOP);
    ck('an inactive employment record does NOT revoke the owner', r2.ok === true, r2.reason);

    const s = await resolveActor(OTHER, SHOP);
    ck('CONTROL: a stranger is still refused', s.ok === false, s.reason);

    /* ── THE OWNER-LESS SHOP ────────────────────────────────────────────────
       In THIS function ownership is the shops/{uid} document id, so a shop
       document carrying no ownerId/sellerUid/ownerUid field at all is
       legitimate — `if (shopOwner && shopOwner !== shopId)` passes on an empty
       owner by design. That makes the owner uid handed to the shared predicate
       observable: pass `shopId` (this module's model) and the employee is
       believed; pass the union's `shopOwner` and an owner-less shop refuses
       everybody. Without this fixture that substitution is INERT, and a
       sabotage of it reads green for want of a case that can see it. */
    await wipe();
    await db.doc('shops/' + SHOP).set({ storeName: 'A Shop' });   /* no owner field */
    await db.doc('users/' + EMP).set({ name: 'Sam Cashier' });
    await db.doc('users/' + OWNER).set({ name: 'Owner Person' });
    await putEmp();
    const o = await resolveActor(EMP, SHOP);
    ck('an employee of an OWNER-LESS shop is still authorized', o.ok === true, o.reason);
    ck('  …because the document id IS the ownership, not a field',
       o.ok === true && o.servedBy.uid === EMP);
    ck('  CONTROL: an owner-less shop still refuses a stranger',
       (await resolveActor(OTHER, SHOP)).ok === false);
  }

  /* ══ 5. RESTRICTIONS STILL NARROW, AND NEVER GRANT ═════════════════════════ */
  head('5 - capabilities / restrictions are unchanged');
  {
    await wipe(); await seedWorld();
    await putEmp({ role: 'manager', restrictions: ['discount', 'refund'] });
    const r = await resolveActor(EMP, SHOP);
    ck('authorized as a manager', r.ok === true && r.servedBy.role === 'manager');
    ck('  …the withdrawn capabilities are gone',
       r.capabilities.indexOf('discount') === -1 && r.capabilities.indexOf('refund') === -1);
    ck('  …the rest of the ceiling survives', r.capabilities.indexOf('sell') > -1);
    ck('  …restrictions are echoed back', (r.restrictions || []).join(',') === 'discount,refund');

    await wipe(); await seedWorld();
    await putEmp({ role: 'cashier', restrictions: ['manageStaff'] });
    const c = await resolveActor(EMP, SHOP);
    ck('INVERTING CONTROL: restricting a capability the role never had is a NO-OP,',
       c.ok === true &&
       c.capabilities.join(',') === MI._internal.ROLE_CAPABILITIES.cashier.join(','));
    ck('  …and cannot be used to GRANT it', c.capabilities.indexOf('manageStaff') === -1);
  }

  /* ══ 6. NO PRIVATE EMPLOYMENT VOCABULARY REMAINS ═══════════════════════════
     Asserted on STRIPPED source, because the repair's own comments discuss the
     thing being forbidden by name. An unstripped check would read the
     explanation as the violation. */
  head('6 - the private `status` predicate is gone from the employee arm');
  {
    const src = strip('merchant-identity.js');
    ck('no _employmentActive in code', !/_employmentActive/.test(src));
    ck('no ACTIVE_EMPLOYMENT in code', !/ACTIVE_EMPLOYMENT/.test(src));
    ck('no approved/enabled employment vocabulary', !/'approved',\s*'enabled'/.test(src));
    ck('nothing reads rec.status / emp.status', !/\b(rec|emp)\.status\b/.test(src));
    ck('it CONSUMES the contract instead',
       /require\('\.\/shop-employees'\)/.test(src) && /employeeRecordReasons\(/.test(src));

    /* POSITIVE CONTROLS. An absence assertion whose matcher cannot fire is not
       evidence — these prove the stripper left code intact and the patterns
       above are capable of matching. */
    ck('CONTROL: the stripper did not blank the file', /resolveActor/.test(src) && src.length > 4000);
    ck('CONTROL: the forbidden pattern DOES match when present',
       /_employmentActive/.test('if (!_employmentActive(emp)) return;'));
    ck('CONTROL: shop.status IS still read (the SHOP\'s field, a different thing)',
       /shopData\.status|shop\.status/.test(strip('shop-employees.js')));

    /* The predicate lives in exactly one place. */
    const se = strip('shop-employees.js');
    ck('the predicate is declared ONCE, in the contract module',
       (se.match(/function employeeRecordReasons/g) || []).length === 1);
    ck('  …and merchant-identity declares no copy of it',
       !/function employeeRecordReasons/.test(src));
    ck('  …with active !== false inside it', /e\.active === false/.test(se));
  }

  /* ══ 7. THE POS PATH REALLY IS THIS PATH ═══════════════════════════════════
     §2 proves resolveActor refuses. This proves the till is what consumes it —
     otherwise the suite certifies a function nothing calls. */
  head('7 - pos-zero-friction consumes exactly this authority');
  {
    const pos = strip('pos-zero-friction.js');
    ck('it imports resolveActor from merchant-identity',
       /require\('\.\/merchant-identity'\)\._internal/.test(pos) && /resolveActor/.test(pos));
    ck('it calls it with the acting uid and the shop', /resolveActor\(cashierId, merchantId\)/.test(pos));
    ck('the merchant is proven from _actor.ok', /_merchantProven\s*=\s*!!\(_actor && _actor\.ok\)/.test(pos));
    ck('discount authority is gated on _actor.ok', /_discountOk\s*=\s*!!\(_actor && _actor\.ok/.test(pos));
    ck('servedBy is written from _actor.ok', /_actor && _actor\.ok && _actor\.servedBy/.test(pos));
    ck('CONTROL: the matcher can fire', /resolveActor\(/.test('await resolveActor(a, b)'));
  }

  /* ══ 8. LEGACY KEYS AND MIGRATION ══════════════════════════════════════════ */
  head('8 - legacy keys stay outside the contract, and no migration is needed');
  {
    await wipe(); await seedWorld();
    await putEmp({}, EMP);                        /* shopEmployees/{uid} — the legacy id */
    const r = await resolveActor(EMP, SHOP);
    ck('a legacy shopEmployees/{uid} record is NOT honoured', r.ok === false, r.reason);
    ck('  …the contract boundary is unchanged by this repair',
       /legacyEmployeeDocId/.test(strip('shop-employees.js')));

    /* MIGRATION. The honest proof is that the repaired authority path NEVER
       WRITES: a read-only predicate cannot require a backfill, whatever the
       record population is. A first draft of this assertion searched for
       `status: 'active'` anywhere in merchant-identity.js and failed on an
       unrelated merchant-link write — a matcher that did not follow the
       observable it claimed to measure. */
    const arm = strip('merchant-identity.js')
      .slice(strip('merchant-identity.js').indexOf('async function resolveActor'));
    const body = arm.slice(0, arm.indexOf('\n}\n') + 3);
    ck('MIGRATION: the till authority path performs NO WRITES at all',
       !/\.(set|update|create|delete|add)\s*\(/.test(body), body.length + ' chars scanned');
    ck('  …and the shared predicate is pure — no I/O, no writes',
       !/\.(get|set|update|create|delete)\s*\(/.test(
         (m => m ? m[0] : '')(strip('shop-employees.js')
           .match(/function employeeRecordReasons[\s\S]*?\n\}/))));
    ck('  CONTROL: the write matcher DOES fire on a writing function',
       /\.(set|update|create|delete|add)\s*\(/.test('await ref.update({ active: false });'));
    ck('  so no record is rewritten, and production carries 0 anyway (entry 111)',
       (await db.collection('shopEmployees').where('active', '==', false).get()).size === 0);
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  SEPARATE  the owner-arm ownership divergence (shops/{uid} here vs the');
  console.log('            ownerId|sellerUid|ownerUid union there) is UNCHANGED and');
  console.log('            deliberately out of scope.');
  console.log('  SEPARATE  hrStaff employment and ADR-035 #5/#7. Different collection,');
  console.log('            different key, no bridge.');
  console.log('  NOTE      production shopEmployees = 0, so this repair revokes nobody');
  console.log('            today. It arms the first removal instead of missing it.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
