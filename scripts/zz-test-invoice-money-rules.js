/* IM — invoice money authority (owner 2026-10-04). Emulator-backed, against a rules FILE:
     RULES_FILE=firestore.rules.hotfix-jobs  …  and  RULES_FILE=firestore.rules.build
   Baseline RULES_FILE=firestore.rules.served-f259c0b5: IM-W3 / IM-W4 (admin raw client writes) must FAIL there (allowed live). */
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
  const env = await initializeTestEnvironment({ projectId: 'demo-invoice-money',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nIM invoice money   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'invoices/inv1'), { shopId: 'shopA', createdBy: 'merch', sellerUid: 'merch', status: 'sent', total: 1000 });
    await setDoc(doc(c.firestore(), 'invoicePaymentClaims/c1'), { invoiceId: 'inv1', status: 'unverified' });
  });
  const merch = env.authenticatedContext('merch').firestore(), admin = env.authenticatedContext('adm', { admin: true }).firestore(), str = env.authenticatedContext('str').firestore();
  await denies('IM-W1', 'the merchant writes status=paid on its own invoice', updateDoc(doc(merch, 'invoices/inv1'), { status: 'paid', paidAt: 1 }));
  await denies('IM-W2', 'the merchant writes balance 0 / paymentRef', updateDoc(doc(merch, 'invoices/inv1'), { balanceDue: 0, paymentRef: 'ABC123' }));
  await denies('IM-W3', 'an ADMIN raw client write of status=paid is refused (server-only financial state)', updateDoc(doc(admin, 'invoices/inv1'), { status: 'paid' }));
  await denies('IM-W4', 'an admin client cannot create an invoice', setDoc(doc(admin, 'invoices/inv2'), { shopId: 'shopA', status: 'paid', total: 5 }));
  await denies('IM-C1', 'a merchant cannot write a payment claim directly (server records claims)', setDoc(doc(merch, 'invoicePaymentClaims/c2'), { invoiceId: 'inv1', status: 'verified' }));
  await denies('IM-C2', 'nobody flips a claim to verified from a client (admin included)', updateDoc(doc(admin, 'invoicePaymentClaims/c1'), { status: 'verified' }));
  await denies('IM-C3', 'claims are not client-readable by a stranger', getDoc(doc(str, 'invoicePaymentClaims/c1')));
  await allows('IM-R1', 'CONTROL: the seller reads its own invoice (sellerUid)', getDoc(doc(merch, 'invoices/inv1')));
  await allows('IM-R2', 'CONTROL: an admin reads it', getDoc(doc(admin, 'invoices/inv1')));
  await denies('IM-R3', 'a stranger cannot read it', getDoc(doc(str, 'invoices/inv1')));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
