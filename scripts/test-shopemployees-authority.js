/* shopEmployees as an authorization AUTHORITY — emulator-backed, against the SERVED ruleset.
 *
 *   set RULES_FILE=_served-f1c4e35b.rules
 *   firebase emulators:exec --only firestore "node scripts/test-shopemployees-authority.js"
 *
 * WHY THIS EXISTS
 * The staff-aware guard for the five cashier-facing POS callables would elevate
 * `shopEmployees` into an authorization authority. Unlike `posStaff` (absent from the
 * ruleset, hence deny-by-default and server-only), `shopEmployees` IS client-writable.
 *
 * "Client-writable" does not by itself mean "attacker-writable". What matters is whether
 * the rule stops an attacker from SELECTING A VICTIM'S shopOwnerId. That is a security
 * property, so it gets demonstrated — never assumed from reading the rule.
 *
 * The rule is asymmetric and that asymmetry is the whole question:
 *   create: request.resource.data.shopOwnerId == request.auth.uid   <- constrains the NEW value
 *   update:          resource.data.shopOwnerId == request.auth.uid  <- constrains the OLD value only
 */
'use strict';
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};

const E = 'shopEmployees';
const OWNER_A = 'ownerA';        /* victim merchant, keyed BY uid (shops/{ownerUid}) */
const EMP_A   = 'empA';          /* legitimate cashier of ownerA                     */
const ATTACK  = 'attacker';      /* a principal who owns their own shop              */

(async () => {
  const rulesFile = process.env.RULES_FILE || 'firestore.rules';
  const rulesPath = path.join(__dirname, '..', rulesFile);
  const rules = fs.readFileSync(rulesPath, 'utf8');

  /* CONTROL ON THE RIG ITSELF: a ruleset that does not contain the block under test
     would make every DENY below vacuous. Refuse to run. */
  if (rules.indexOf('match /' + E + '/') === -1) {
    console.error('  ABORT: ' + rulesFile + ' contains no ' + E + ' block — the probe is broken.');
    process.exit(1);
  }
  console.log('  ruleset: ' + rulesFile + ' (' + rules.length + ' bytes)\n');

  const env = await initializeTestEnvironment({
    projectId: 'sokoni-shopemployees-authority-test',
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });

  const { doc, setDoc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');

  const seed = async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, E, EMP_A),  { shopOwnerId: OWNER_A, role: 'cashier', status: 'active', name: 'Legit Cashier' });
      await setDoc(doc(db, E, ATTACK), { shopOwnerId: ATTACK,  role: 'cashier', status: 'active', name: 'Attacker' });
    });
  };

  const as   = (uid) => env.authenticatedContext(uid).firestore();
  const ok   = async (label, p, note) => { try { await p; ck(label, true, note); } catch (e) { ck(label, false, 'unexpectedly DENIED: ' + e.code); } };
  const deny = async (label, p, note) => { try { await p; ck(label, false, 'ALLOWED — must have been denied'); } catch (e) { ck(label, true, note || e.code); } };

  console.log('A. Rig controls — a DENY is only meaningful if an ALLOW is reachable\n');
  await seed();
  await ok('CONTROL an owner may create an employee of their OWN shop',
    setDoc(doc(as(ATTACK), E, 'newEmp1'), { shopOwnerId: ATTACK, role: 'cashier', status: 'active' }),
    'proves the probe can produce ALLOW');
  await ok('CONTROL the legitimate cashier can read their own record',
    getDoc(doc(as(EMP_A), E, EMP_A)));
  await ok('CONTROL the shop owner can read their employee',
    getDoc(doc(as(OWNER_A), E, EMP_A)));

  console.log('\nB. FACT 2 — can an attacker SELECT a victim as shopOwnerId?\n');
  await seed();
  await deny('CREATE a record naming the VICTIM as shopOwnerId',
    setDoc(doc(as(ATTACK), E, 'evil1'), { shopOwnerId: OWNER_A, role: 'manager', status: 'active' }),
    'the create rule constrains the NEW value');
  await deny('CREATE at my own uid naming the VICTIM as shopOwnerId',
    setDoc(doc(as(ATTACK), E, ATTACK + '2'), { shopOwnerId: OWNER_A, role: 'manager', status: 'active' }));
  await deny('UPDATE the victim\'s existing employee record',
    updateDoc(doc(as(ATTACK), E, EMP_A), { role: 'manager' }),
    'existing shopOwnerId is the victim, not me');
  await deny('DELETE the victim\'s employee record',
    deleteDoc(doc(as(ATTACK), E, EMP_A)));
  await deny('READ the victim\'s employee record',
    getDoc(doc(as(ATTACK), E, EMP_A)));

  console.log('\nC. THE ASYMMETRY — update constrains the OLD value only\n');
  await seed();
  await deny('SELF-ESCALATION: rewrite MY OWN record to point at the VICTIM\'s shop',
    updateDoc(doc(as(ATTACK), E, ATTACK), { shopOwnerId: OWNER_A, role: 'manager', status: 'active' }),
    'create is guarded; if update is not, create-then-update defeats it');

  console.log('\nD. Documented but NOT an escalation\n');
  await seed();
  await ok('adding SOMEONE ELSE as an employee of MY OWN shop is allowed',
    setDoc(doc(as(ATTACK), E, 'victimUid'), { shopOwnerId: ATTACK, role: 'cashier', status: 'active' }),
    'grants nothing over the victim — it is my shop, not theirs');

  await env.cleanup();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  SUITE CRASHED: ' + (e && e.stack || e)); process.exit(1); });
