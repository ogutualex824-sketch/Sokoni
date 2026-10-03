/* FM — foodMenus closed (sokoni-5b security convergence, 2026-10-03). Emulator-backed, against a rules FILE.

   Run (test the BUILT artefact — it is what Firebase serves):
     node scripts/build-firestore-rules.js
     RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
       firebase emulators:exec --only firestore --project demo-food-menus "node scripts/zz-test-food-menus-rules.js"
   Baseline (FM-1..FM-5 must FAIL there — the served rule is owner-write / public-read):
     RULES_FILE=firestore.rules.served-f259c0b5

   CONTRACT: foodMenus/{id} has no client reader or writer. Every client read, create, update and delete is refused —
   the owner's own id, another restaurant's id, an anonymous caller, a buyer, an admin client. Server (Admin SDK) only. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');

let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };

(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({
    projectId: 'demo-food-menus',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) },
  });
  console.log('\nFM foodMenus closed   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'foodMenus/restA'), { restaurantId: 'restA', items: [{ name: 'x', price: 100 }] }); });
  const owner = env.authenticatedContext('restA').firestore();
  const other = env.authenticatedContext('restB').firestore();
  const buyer = env.authenticatedContext('buyer1').firestore();
  const adminC = env.authenticatedContext('admin1', { admin: true }).firestore();
  const anon = env.unauthenticatedContext().firestore();

  await denies('FM-1', 'the owner cannot write its own foodMenus doc (was allowed)', setDoc(doc(owner, 'foodMenus/restA'), { restaurantId: 'restA', items: [{ name: 'free', price: 1 }] }));
  await denies('FM-2', 'the owner cannot create a new foodMenus doc for itself', setDoc(doc(other, 'foodMenus/restB'), { restaurantId: 'restB', items: [] }));
  await denies('FM-3', 'anonymous read is refused (was public)', getDoc(doc(anon, 'foodMenus/restA')));
  await denies('FM-4', 'a buyer cannot read it', getDoc(doc(buyer, 'foodMenus/restA')));
  await denies('FM-5', 'the owner cannot delete it', deleteDoc(doc(owner, 'foodMenus/restA')));
  await denies('FM-6', 'another restaurant cannot write it', updateDoc(doc(other, 'foodMenus/restA'), { items: [] }));
  await denies('FM-7', 'anonymous write is refused', setDoc(doc(anon, 'foodMenus/restC'), { items: [] }));
  await denies('FM-8', 'an admin CLIENT cannot write it either (server only)', setDoc(doc(adminC, 'foodMenus/restA'), { items: [] }));
  /* positive control: the emulator and the file are live (an unrelated public read still works) */
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'products/p1'), { sellerUid: 'restA', name: 'x', price: 10 }); });
  await allows('FM-C', 'CONTROL: a public product read still succeeds (the harness can tell allow from deny)', getDoc(doc(anon, 'products/p1')));

  await env.cleanup();
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
