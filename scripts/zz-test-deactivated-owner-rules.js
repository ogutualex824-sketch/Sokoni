/* DO — P0-F deactivated-owner write restriction (owner 2026-10-03). Emulator-backed, against a rules FILE:
     RULES_FILE=firestore.rules.hotfix-jobs  …  and  RULES_FILE=firestore.rules.build
   Baseline RULES_FILE=firestore.rules.served-f259c0b5: DO-P2..P6 and DO-S2..S5 must FAIL there (the live gap — a
   deactivated / suspended owner still edits), while every CONTROL row passes on all three files. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.hotfix-jobs';
  const env = await initializeTestEnvironment({ projectId: 'demo-deactivated-owner',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nDO deactivated owner   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  const P = { act: { status: 'active' }, pend: { status: 'pending' }, deac: { status: 'deactivated', deactivated: true },
    susp: { status: 'suspended', suspended: true }, revk: { status: 'revoked' }, flag: { status: 'active', deactivated: true },
    none: {}, odd: { status: 'whatever' } };
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    for (const [k, v] of Object.entries(P)) await setDoc(doc(f, 'providers/p_' + k), Object.assign({ uid: 'p_' + k, name: 'X' }, v));
    for (const [k, v] of Object.entries({ act: {}, deac: { deactivated: true, isVisible: false }, susp: { suspended: true }, ban: { banned: true } }))
      await setDoc(doc(f, 'shops/s_' + k), Object.assign({ ownerId: 's_' + k, name: 'Shop' }, v));
  });
  const as = (uid, claims) => env.authenticatedContext(uid, claims || {}).firestore();
  const bio = { bio: 'edited' }, nm = { name: 'Renamed' };
  /* providers */
  await allows('DO-P1', 'CONTROL: an ACTIVE provider edits its bio', updateDoc(doc(as('p_act'), 'providers/p_act'), bio));
  await allows('DO-P1b', 'CONTROL: a PENDING (onboarding) provider edits its bio', updateDoc(doc(as('p_pend'), 'providers/p_pend'), bio));
  await denies('DO-P2', 'a DEACTIVATED provider cannot edit its profile', updateDoc(doc(as('p_deac'), 'providers/p_deac'), bio));
  await denies('DO-P3', 'a SUSPENDED provider is read-only', updateDoc(doc(as('p_susp'), 'providers/p_susp'), bio));
  await denies('DO-P4', 'a REVOKED provider cannot edit', updateDoc(doc(as('p_revk'), 'providers/p_revk'), bio));
  await denies('DO-P5', 'status active but deactivated flag set → denied', updateDoc(doc(as('p_flag'), 'providers/p_flag'), bio));
  await denies('DO-P6', 'an owner whose TOKEN carries deactivated:true cannot edit even an active record', updateDoc(doc(as('p_act', { deactivated: true }), 'providers/p_act'), bio));
  await denies('DO-P7', 'a provider with NO status fails closed', updateDoc(doc(as('p_none'), 'providers/p_none'), bio));
  await denies('DO-P8', 'an UNKNOWN status fails closed', updateDoc(doc(as('p_odd'), 'providers/p_odd'), bio));
  await denies('DO-P9', 'a deactivated provider cannot reactivate itself by writing deactivated:false', updateDoc(doc(as('p_deac'), 'providers/p_deac'), { deactivated: false }));
  await allows('DO-P10', 'CONTROL: admin edits a deactivated provider', updateDoc(doc(as('adm', { admin: true }), 'providers/p_deac'), { adminNote: 'reviewed' }));
  /* shops */
  await allows('DO-S1', 'CONTROL: an active shop owner renames the shop', updateDoc(doc(as('s_act'), 'shops/s_act'), nm));
  await denies('DO-S2', 'a DEACTIVATED shop owner cannot edit', updateDoc(doc(as('s_deac'), 'shops/s_deac'), nm));
  await denies('DO-S3', 'a SUSPENDED shop is read-only', updateDoc(doc(as('s_susp'), 'shops/s_susp'), nm));
  await denies('DO-S4', 'a BANNED shop owner cannot edit', updateDoc(doc(as('s_ban'), 'shops/s_ban'), nm));
  await denies('DO-S5', 'a deactivated-claim token cannot edit an active shop', updateDoc(doc(as('s_act', { deactivated: true }), 'shops/s_act'), nm));
  await denies('DO-S6', 'no owner writes isVisible (whitelist, unchanged)', updateDoc(doc(as('s_act'), 'shops/s_act'), { isVisible: true }));
  await allows('DO-S7', 'CONTROL: admin edits a deactivated shop', updateDoc(doc(as('adm', { admin: true }), 'shops/s_deac'), { name: 'Admin fix' }));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
