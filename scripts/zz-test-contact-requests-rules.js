/* CQ — product enquiry = lead (contactRequests), Construction convergence 2026-10-03. Emulator-backed, rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-contact-req "node scripts/zz-test-contact-requests-rules.js"
   Baseline: RULES_FILE=firestore.rules.served-f259c0b5 — CQ-F1/F2/F3/F5, CQ-S2/S3 must FAIL there (forged seller,
   planted status, illegal lead jumps are allowed by the served rule). */
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
  const env = await initializeTestEnvironment({ projectId: 'demo-contact-req',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nCQ contactRequests   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'products/cement1'), { sellerUid: 'seller', name: 'Cement', price: 750 });
    await setDoc(doc(f, 'products/steel1'), { sellerUid: 'other', name: 'Steel', price: 900 });
    await setDoc(doc(f, 'contactRequests/q1'), { buyerUid: 'buyer', sellerUid: 'seller', productId: 'cement1', message: 'hi', createdAt: 1, status: 'pending' });
  });
  const buyer = env.authenticatedContext('buyer').firestore(), seller = env.authenticatedContext('seller').firestore();
  const other = env.authenticatedContext('other').firestore(), admin = env.authenticatedContext('adm', { admin: true }).firestore();
  const good = { buyerUid: 'buyer', buyerName: 'B', buyerPhone: '0712345678', message: 'Need 100 bags', productId: 'cement1', productName: 'Cement', sellerUid: 'seller', sellerName: 'S', status: 'pending', createdAt: 2, source: 'product_page' };
  await allows('CQ-C1', 'buyer creates a lead with the product\'s real seller (df1a4cb payload)', setDoc(doc(buyer, 'contactRequests/n1'), good));
  await denies('CQ-F1', 'buyer plants a lead on ANOTHER seller for this product (sellerUid ≠ product owner)', setDoc(doc(buyer, 'contactRequests/f1'), Object.assign({}, good, { sellerUid: 'other' })));
  await denies('CQ-F2', 'lead created already "won" (planted status)', setDoc(doc(buyer, 'contactRequests/f2'), Object.assign({}, good, { status: 'won' })));
  await denies('CQ-F3', 'extra key smuggled in (e.g. assignedTo / commission)', setDoc(doc(buyer, 'contactRequests/f3'), Object.assign({}, good, { commissionRate: 0 })));
  await denies('CQ-F4', 'seller enquires on their own product', setDoc(doc(seller, 'contactRequests/f4'), Object.assign({}, good, { buyerUid: 'seller' })));
  await denies('CQ-F5', 'lead on a product that does not exist', setDoc(doc(buyer, 'contactRequests/f5'), Object.assign({}, good, { productId: 'nope' })));
  await denies('CQ-F6', 'creating a lead in someone else\'s name', setDoc(doc(other, 'contactRequests/f6'), good));
  await allows('CQ-S1', 'seller moves pending → responded (Contacted)', updateDoc(doc(seller, 'contactRequests/q1'), { status: 'responded', respondedAt: 3 }));
  await denies('CQ-S2', 'seller jumps responded → won (skips the lifecycle)', updateDoc(doc(seller, 'contactRequests/q1'), { status: 'won' }));
  await denies('CQ-S3', 'seller sets a status outside the lifecycle', updateDoc(doc(seller, 'contactRequests/q1'), { status: 'paid' }));
  await allows('CQ-S4', 'seller → quote_sent → negotiating → won', (async () => {
    await updateDoc(doc(seller, 'contactRequests/q1'), { status: 'quote_sent' });
    await updateDoc(doc(seller, 'contactRequests/q1'), { status: 'negotiating' });
    await updateDoc(doc(seller, 'contactRequests/q1'), { status: 'won' }); })());
  await denies('CQ-S5', 'seller re-opens a won lead', updateDoc(doc(seller, 'contactRequests/q1'), { status: 'negotiating' }));
  await denies('CQ-S6', 'seller rewrites the buyer or product on a lead', updateDoc(doc(seller, 'contactRequests/q1'), { productId: 'steel1' }));
  await allows('CQ-S7', 'seller edits only their note (same status)', updateDoc(doc(seller, 'contactRequests/q1'), { sellerNote: 'delivered Friday' }));
  await denies('CQ-X1', 'another seller reads the lead', getDoc(doc(other, 'contactRequests/q1')));
  await denies('CQ-X2', 'another seller moves the lead', updateDoc(doc(other, 'contactRequests/n1'), { status: 'lost' }));
  await allows('CQ-B1', 'buyer cancels their own open lead', updateDoc(doc(buyer, 'contactRequests/n1'), { status: 'cancelled' }));
  await denies('CQ-B2', 'buyer marks their lead won', updateDoc(doc(buyer, 'contactRequests/n1'), { status: 'won' }));
  await allows('CQ-A1', 'admin reads a lead', getDoc(doc(admin, 'contactRequests/q1')));
  // equipment rental (server-written by marketplace-extensions rental callables)
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'rentalProducts/rp1'), { shopId: 'shopS', createdBy: 'seller', title: 'Excavator', dailyRate: 28000, status: 'active' });
    await setDoc(doc(f, 'rentalProducts/rp2'), { shopId: 'shopS', createdBy: 'seller', title: 'Draft crane', status: 'paused' });
    await setDoc(doc(f, 'rentalBookings/rb1'), { rentalProductId: 'rp1', shopId: 'shopS', buyerId: 'buyer', totalAmount: 56000, status: 'pending' });
  });
  const anon = env.unauthenticatedContext().firestore();
  await allows('RN-1', 'the public reads an ACTIVE rental listing (the rental page can load)', getDoc(doc(anon, 'rentalProducts/rp1')));
  await denies('RN-2', 'the public reads a non-active rental listing', getDoc(doc(anon, 'rentalProducts/rp2')));
  await allows('RN-3', 'the lister reads their own non-active listing', getDoc(doc(seller, 'rentalProducts/rp2')));
  await denies('RN-4', 'a client writes a rental listing (server-only: price + seller assert)', setDoc(doc(seller, 'rentalProducts/rp3'), { shopId: 'shopS', dailyRate: 1, status: 'active' }));
  await denies('RN-5', 'the renter edits their booking total / status', updateDoc(doc(buyer, 'rentalBookings/rb1'), { totalAmount: 1, status: 'confirmed' }));
  await allows('RN-6', 'the renter reads their booking', getDoc(doc(buyer, 'rentalBookings/rb1')));
  await denies('RN-7', 'another user reads the booking (customer phone / dates)', getDoc(doc(other, 'rentalBookings/rb1')));
  await denies('RN-8', 'a client forges a booking', setDoc(doc(buyer, 'rentalBookings/rb9'), { rentalProductId: 'rp1', buyerId: 'buyer', totalAmount: 1, status: 'confirmed' }));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
