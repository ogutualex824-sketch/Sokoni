/* SR — Sports server-only collections (sokoni-2f, sportsDispatch @ a2d55b4). Emulator-backed, against a rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-sports-rules "node scripts/zz-test-sports-rules.js"
   Baseline f259c0b5: S-R1 / S-R6 client-write rows must FAIL there (owner-writable teams / tournaments / regs). */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({ projectId: 'demo-sports-rules',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nSR sports   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'teams/tA'), { ownerUid: 'own', captainUid: 'cap', status: 'approved' });
    await setDoc(doc(f, 'teams/tS'), { ownerUid: 'own', captainUid: 'cap', status: 'submitted' });
    await setDoc(doc(f, 'teams/tNoMgr'), { ownerUid: 'own', status: 'submitted' });          /* no managerUids field */
    await setDoc(doc(f, 'tournaments/trD'), { organiserUid: 'org', status: 'draft' });
    await setDoc(doc(f, 'tournaments/trP'), { organiserUid: 'org', status: 'open' });
    await setDoc(doc(f, 'tournaments/trNone'), { organiserUid: 'org' });                       /* no status → draft */
    await setDoc(doc(f, 'sportsTournamentRegs/r1'), { teamId: 'tA', tournamentId: 'trP' });
    await setDoc(doc(f, 'sportsTeamMembers/m1'), { uid: 'mem1', teamId: 'tA' });
    await setDoc(doc(f, 'sportsTeamMembers/m2'), { uid: 'mem2', teamId: 'tA' });
    await setDoc(doc(f, 'sportsFixtures/f1'), { home: 'tA', away: 'tB' });
  });
  const anon = env.unauthenticatedContext().firestore(), stranger = env.authenticatedContext('str').firestore();
  const own = env.authenticatedContext('own').firestore(), cap = env.authenticatedContext('cap').firestore();
  const org = env.authenticatedContext('org').firestore(), mem1 = env.authenticatedContext('mem1').firestore();
  const admin = env.authenticatedContext('adm', { admin: true }).firestore();
  // S-R1 client writes denied everywhere (owner, captain, admin alike)
  await denies('S-R1a', 'owner updates own team', updateDoc(doc(own, 'teams/tA'), { name: 'x' }));
  await denies('S-R1b', 'admin client creates a team', setDoc(doc(admin, 'teams/tX'), { ownerUid: 'adm', status: 'approved' }));
  await denies('S-R1c', 'organiser updates own tournament', updateDoc(doc(org, 'tournaments/trP'), { prize: 1e6 }));
  await denies('S-R1d', 'captain registers for a tournament directly', setDoc(doc(cap, 'sportsTournamentRegs/r2'), { teamId: 'tA', tournamentId: 'trP' }));
  await denies('S-R1e', 'member writes own membership', updateDoc(doc(mem1, 'sportsTeamMembers/m1'), { role: 'captain' }));
  await denies('S-R1f', 'anyone writes a fixture result', updateDoc(doc(own, 'sportsFixtures/f1'), { homeScore: 9 }));
  await denies('S-R1g', 'owner deletes own team', deleteDoc(doc(own, 'teams/tS')));
  // S-R2 draft tournament privacy
  await denies('S-R2a', 'stranger reads a draft tournament', getDoc(doc(stranger, 'tournaments/trD')));
  await allows('S-R2b', 'organiser reads their draft tournament', getDoc(doc(org, 'tournaments/trD')));
  await allows('S-R2c', 'anyone reads a published tournament', getDoc(doc(anon, 'tournaments/trP')));
  await denies('S-R2d', 'a tournament with NO status reads as draft (fail closed)', getDoc(doc(stranger, 'tournaments/trNone')));
  // S-R3 team visibility
  await denies('S-R3a', 'stranger reads a submitted team', getDoc(doc(stranger, 'teams/tS')));
  await allows('S-R3b', 'owner reads their submitted team', getDoc(doc(own, 'teams/tS')));
  await allows('S-R3c', 'captain reads their submitted team', getDoc(doc(cap, 'teams/tS')));
  await allows('S-R3d', 'an approved team is public', getDoc(doc(anon, 'teams/tA')));
  await allows('S-R3e', 'owner reads a team with NO managerUids field (no expression error)', getDoc(doc(own, 'teams/tNoMgr')));
  await denies('S-R3f', 'stranger reads a team with no managerUids (denied, not errored open)', getDoc(doc(stranger, 'teams/tNoMgr')));
  // S-R4 membership privacy
  await allows('S-R4a', 'a member reads their own membership', getDoc(doc(mem1, 'sportsTeamMembers/m1')));
  await denies('S-R4b', 'a member reads a teammate\'s membership', getDoc(doc(mem1, 'sportsTeamMembers/m2')));
  // S-R5 fixtures public read
  await allows('S-R5', 'fixtures are publicly readable', getDoc(doc(anon, 'sportsFixtures/f1')));
  // S-R6 forged approval
  await denies('S-R6', 'client writes a forged approved/verified team', setDoc(doc(stranger, 'teams/tF'), { ownerUid: 'str', status: 'approved', verification: 'verified' }));
  await denies('S-R7', 'tournament registrations are admin-read only', getDoc(doc(cap, 'sportsTournamentRegs/r1')));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
