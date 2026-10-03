/* TS — trackingSubscriptions server/admin-only (Car Hub C2, 2026-10-03). Emulator-backed, against a rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-tracking-sub "node scripts/zz-test-tracking-subscription.js"
   Baseline (TS-D rows must FAIL there — the owner could self-activate): RULES_FILE=firestore.rules.served-f259c0b5 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({ projectId: 'demo-tracking-sub',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nTS tracking subscription   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'trackingSubscriptions/alice'), { plan: 'free', vehicleLimit: 1 }); });
  const alice = env.authenticatedContext('alice').firestore(), bob = env.authenticatedContext('bob').firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();
  await allows('TS-R1', 'owner reads own plan', getDoc(doc(alice, 'trackingSubscriptions/alice')));
  await denies('TS-R2', 'another user reads alice\'s plan', getDoc(doc(bob, 'trackingSubscriptions/alice')));
  await denies('TS-D1', 'owner upgrades own plan to fleet (self-activation)', updateDoc(doc(alice, 'trackingSubscriptions/alice'), { plan: 'fleet', vehicleLimit: 50 }));
  await denies('TS-D2', 'new user creates own pro plan', setDoc(doc(bob, 'trackingSubscriptions/bob'), { plan: 'pro', vehicleLimit: 5 }));
  await denies('TS-D3', 'owner raises vehicleLimit only', updateDoc(doc(alice, 'trackingSubscriptions/alice'), { vehicleLimit: 99 }));
  await allows('TS-A1', 'admin writes a plan', setDoc(doc(admin, 'trackingSubscriptions/bob'), { plan: 'pro', vehicleLimit: 5 }));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
