/* PA — products authority, phase 1 (sokoni-5b security convergence, 2026-10-03). Emulator-backed, against a rules FILE.

   Run (test the BUILT artefact — it is what Firebase serves):
     node scripts/build-firestore-rules.js
     RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
       firebase emulators:exec --only firestore --project demo-products-authority "node scripts/zz-test-products-authority-rules.js"
   Baseline (PA-1..PA-8 must FAIL there — served lets the owner create, re-price, re-publish and hard-delete):
     RULES_FILE=firestore.rules.served-f259c0b5

   CONTRACT: merchantProduct (Admin SDK) is the only creator and the only writer of price / publication / ownership.
   Owner browser writes keep descriptive fields and — phase 1 only — the till's stock fields. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc, deleteDoc, getDoc } = require('firebase/firestore');

let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };

(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({
    projectId: 'demo-products-authority',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) },
  });
  console.log('\nPA products authority (phase 1)   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  const P = { sellerUid: 'sellA', shopId: 'sellA', name: 'Sugar', description: 'x', price: 250, status: 'active', isVisible: true, stock: 5, sold: 0, inventoryVersion: 1 };
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'products/prd_sellA_1'), P); });
  const owner = env.authenticatedContext('sellA', { seller: true }).firestore();
  const other = env.authenticatedContext('sellB', { seller: true }).firestore();
  const adminC = env.authenticatedContext('admin1', { admin: true }).firestore();

  await denies('PA-1', 'the owner cannot CREATE a product from the browser (merchantProduct creates)', setDoc(doc(owner, 'products/prd_sellA_2'), { sellerUid: 'sellA', shopId: 'sellA', name: 'New', price: 10 }));
  await denies('PA-2', 'the owner cannot change PRICE directly', updateDoc(doc(owner, 'products/prd_sellA_1'), { price: 1 }));
  await denies('PA-3', 'the owner cannot change STATUS directly (publication is the server\'s)', updateDoc(doc(owner, 'products/prd_sellA_1'), { status: 'draft' }));
  await denies('PA-4', 'the owner cannot flip isVisible directly', updateDoc(doc(owner, 'products/prd_sellA_1'), { isVisible: false }));
  await denies('PA-5', 'the owner cannot move the product to another shop', updateDoc(doc(owner, 'products/prd_sellA_1'), { shopId: 'sellB' }));
  await denies('PA-6', 'the owner cannot set a salePrice directly', updateDoc(doc(owner, 'products/prd_sellA_1'), { salePrice: 1 }));
  await denies('PA-7', 'the owner cannot HARD-delete (archive is the server tombstone)', deleteDoc(doc(owner, 'products/prd_sellA_1')));
  await denies('PA-8', 'the owner cannot forge approval / rating fields', updateDoc(doc(owner, 'products/prd_sellA_1'), { approvalStatus: 'approved', rating: 5 }));
  await denies('PA-9', 'another seller cannot update it', updateDoc(doc(other, 'products/prd_sellA_1'), { name: 'Hijack' }));
  await allows('PA-10', 'CONTROL: the owner may still edit descriptive fields', updateDoc(doc(owner, 'products/prd_sellA_1'), { name: 'Sugar 2kg', description: 'y' }));
  await allows('PA-11', 'PHASE 1: the till\'s stock sync still works for the owner (stock / sold / inventoryVersion)', updateDoc(doc(owner, 'products/prd_sellA_1'), { stock: 4, sold: 1, inventoryVersion: 2, lastStockSource: 'pos:sale:x' }));
  await allows('PA-12', 'CONTROL: an admin client may still moderate (status / price)', updateDoc(doc(adminC, 'products/prd_sellA_1'), { status: 'removed', price: 260 }));
  await allows('PA-13', 'CONTROL: products stay publicly readable', getDoc(doc(env.unauthenticatedContext().firestore(), 'products/prd_sellA_1')));
  await allows('PA-14', 'CONTROL: an admin client may delete', deleteDoc(doc(adminC, 'products/prd_sellA_1')));

  await env.cleanup();
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
