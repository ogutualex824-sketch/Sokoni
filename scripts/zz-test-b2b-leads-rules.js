/* BL — B2B RFQ / lead ledger server-only (B2B Hub, 2026-10-03). Emulator-backed, against a rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-b2b-leads "node scripts/zz-test-b2b-leads-rules.js"
   Baseline: RULES_FILE=firestore.rules.served-f259c0b5 — BL-P1 must FAIL there (admin client write of the lead price
   is allowed by the served revenueConfig rule); the collection rows deny there too (default deny), which is expected. */
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
  const env = await initializeTestEnvironment({ projectId: 'demo-b2b-leads',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nBL b2b leads / rfq   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'b2bLeads/r1__supA'), { supplierBusinessId: 'supA', supplierOwnerUid: 'sup', buyerBusinessId: 'buyB', month: '2026-10', priceKES: 200 });
    await setDoc(doc(f, 'b2bLeadMonths/supA_2026-10'), { supplierOwnerUid: 'sup', leadCount: 1, netKES: 200 });
    await setDoc(doc(f, 'rfqs/r1'), { buyerBusinessId: 'buyB', createdBy: 'buyer' });
    await setDoc(doc(f, 'rfqRecipients/r1__supA'), { buyerUid: 'buyer', supplierOwnerUid: 'sup' });
    await setDoc(doc(f, 'rfqQuotes/r1__supA'), { supplierOwnerUid: 'sup', totalKES: 1000 });
    await setDoc(doc(f, 'revenueConfig/b2b_leads'), { priceKES: 200 });
  });
  const sup = env.authenticatedContext('sup').firestore(), buyer = env.authenticatedContext('buyer').firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();
  const superA = env.authenticatedContext('sa1', { superAdmin: true }).firestore();
  // leads: suppliers read via b2bLeadStatement callable, never raw rows (rows carry buyerBusinessId)
  await denies('BL-L1', 'supplier reads own raw lead row', getDoc(doc(sup, 'b2bLeads/r1__supA')));
  await denies('BL-L2', 'supplier deletes / zeroes own lead (evade the invoice)', updateDoc(doc(sup, 'b2bLeads/r1__supA'), { priceKES: 0 }));
  await denies('BL-L3', 'buyer forges a lead against a supplier', setDoc(doc(buyer, 'b2bLeads/r9__supA'), { supplierBusinessId: 'supA', priceKES: 200 }));
  await denies('BL-L4', 'admin client writes a lead (server-only)', setDoc(doc(admin, 'b2bLeads/r9__supA'), { supplierBusinessId: 'supA' }));
  await allows('BL-L5', 'admin reads a lead (AdminOS)', getDoc(doc(admin, 'b2bLeads/r1__supA')));
  // invoice claim docs
  await denies('BL-M1', 'supplier reads own month claim', getDoc(doc(sup, 'b2bLeadMonths/supA_2026-10')));
  await denies('BL-M2', 'supplier pre-claims a month (blocks the invoice)', setDoc(doc(sup, 'b2bLeadMonths/supA_2026-11'), { leadCount: 0 }));
  await allows('BL-M3', 'superAdmin reads a month claim', getDoc(doc(superA, 'b2bLeadMonths/supA_2026-10')));
  await denies('BL-M4', 'superAdmin client writes a month claim', setDoc(doc(superA, 'b2bLeadMonths/supA_2026-12'), { leadCount: 0 }));
  // price config: one writer = adminSetB2bLeadPrice callable
  await denies('BL-P1', 'admin client writes revenueConfig/b2b_leads (bypasses validated+audited callable)', setDoc(doc(admin, 'revenueConfig/b2b_leads'), { priceKES: 1 }));
  await denies('BL-P2', 'supplier reads the lead price config raw', getDoc(doc(sup, 'revenueConfig/b2b_leads')));
  await allows('BL-P3', 'admin reads revenueConfig/b2b_leads', getDoc(doc(admin, 'revenueConfig/b2b_leads')));
  await allows('BL-P4', 'CONTROL: admin still writes another revenueConfig doc', setDoc(doc(admin, 'revenueConfig/global'), { x: 1 }));
  // rfq collections: all access through rfqDispatch
  await denies('BL-R1', 'buyer reads own rfq raw', getDoc(doc(buyer, 'rfqs/r1')));
  await denies('BL-R2', 'buyer flips own rfq to converted', updateDoc(doc(buyer, 'rfqs/r1'), { status: 'converted' }));
  await denies('BL-R3', 'supplier marks recipient row quoted without a quote', updateDoc(doc(sup, 'rfqRecipients/r1__supA'), { status: 'quoted' }));
  await denies('BL-R4', 'supplier rewrites own quote total', updateDoc(doc(sup, 'rfqQuotes/r1__supA'), { totalKES: 1 }));
  await denies('BL-R5', 'buyer reads the supplier quote raw', getDoc(doc(buyer, 'rfqQuotes/r1__supA')));
  await allows('BL-R6', 'admin reads an rfq', getDoc(doc(admin, 'rfqs/r1')));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
