/* CV — conversation pre-claim (sokoni-b2, 2026-10-03). Emulator-backed, against a rules FILE:
     RULES_FILE=firestore.rules.hotfix-jobs  …  and  RULES_FILE=firestore.rules.build
   Baseline RULES_FILE=firestore.rules.served-f259c0b5: CV-C1..C3 must FAIL there (the live pre-claim), controls pass. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.hotfix-jobs';
  const env = await initializeTestEnvironment({ projectId: 'demo-conv-preclaim',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nCV conversation pre-claim   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'conversations/service_booking_b1'), { participants: ['cust', 'prov'], serverCreated: true, lastMessage: '' });
  });
  const atk = env.authenticatedContext('atk').firestore(), cust = env.authenticatedContext('cust').firestore();
  const str = env.authenticatedContext('str').firestore();
  await denies('CV-C1', 'attacker pre-claims service_booking_<victim> with itself as participant', setDoc(doc(atk, 'conversations/service_booking_b2'), { participants: ['atk', 'prov'] }));
  await denies('CV-C2', 'attacker pre-claims order_<victim>', setDoc(doc(atk, 'conversations/order_o9'), { participants: ['atk'] }));
  await denies('CV-C3', 'even a legitimate party cannot client-create (server creates)', setDoc(doc(cust, 'conversations/cust_prov'), { participants: ['cust', 'prov'] }));
  await denies('CV-C4', 'a non-party cannot take over an existing conversation', updateDoc(doc(atk, 'conversations/service_booking_b1'), { participants: ['atk', 'prov'] }));
  await denies('CV-C5', 'a party cannot rewrite participants', updateDoc(doc(cust, 'conversations/service_booking_b1'), { participants: ['cust', 'atk'] }));
  await allows('CV-P1', 'CONTROL: a party reads the conversation', getDoc(doc(cust, 'conversations/service_booking_b1')));
  await allows('CV-P2', 'CONTROL: a party updates lastMessage / unread', updateDoc(doc(cust, 'conversations/service_booking_b1'), { lastMessage: 'hi', unread: { prov: 1 } }));
  await denies('CV-P3', 'a stranger cannot read it', getDoc(doc(str, 'conversations/service_booking_b1')));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
