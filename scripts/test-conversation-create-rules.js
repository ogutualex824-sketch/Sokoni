/* test-conversation-create-rules.js — conversations are created only by the server (CHANGELOG 230).
 * Emulator-backed, against the SERVED ruleset.
 *
 *   node scripts/run-rules-suite.js scripts/test-conversation-create-rules.js
 *
 * PROVES
 *   - no client can create a conversation — not seating a victim beside themselves, not under a deterministic
 *     {a}_{b} id, not under an order / booking id, not with serverAnchored:true, not alone
 *   - no client can create a message either (sendMessage is the only writer)
 *   - POSITIVE CONTROL: a participant still reads a server-created conversation; a stranger cannot
 *   - COUNTERPROOF: the same client create succeeds with rules disabled
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const check = async (label, p) => { try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); } };
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!FS_HOST) { console.error('REFUSING: FIRESTORE_EMULATOR_HOST must be set (run via scripts/run-rules-suite.js)'); process.exit(2); }

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-conversation-create',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build'), 'utf8'), host: FS_HOST.split(':')[0], port: Number(FS_HOST.split(':')[1]) },
  });
  await env.clearFirestore();
  const { doc, setDoc, getDoc, addDoc, collection } = require('firebase/firestore');
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'conversations/order_o1'), { participants: ['alice', 'bob'], transactionType: 'order', transactionId: 'o1', serverAnchored: false });
  });
  const C = (uid) => env.authenticatedContext(uid, { email_verified: true, deactivated: false }).firestore();
  const mallory = C('mallory'); const alice = C('alice'); const stranger = C('stranger');

  console.log('\nconversations — client create is closed');
  await check('seating a victim beside yourself DENIED', assertFails(setDoc(doc(mallory, 'conversations/x1'), { participants: ['mallory', 'victim'], transactionType: 'order', transactionId: 'o9' })));
  await check('the deterministic {a}_{b} id product.js used DENIED', assertFails(setDoc(doc(mallory, 'conversations/mallory_victim'), { participants: ['mallory', 'victim'] })));
  await check('an order-id conversation (to read the order context) DENIED', assertFails(setDoc(doc(mallory, 'conversations/service_booking_b1'), { participants: ['mallory'], transactionType: 'service_booking', transactionId: 'b1' })));
  await check('claiming serverAnchored:true DENIED', assertFails(setDoc(doc(mallory, 'conversations/hc_booking_b1'), { participants: ['mallory', 'doc1'], serverAnchored: true })));
  await check('a conversation with yourself alone DENIED', assertFails(setDoc(doc(mallory, 'conversations/solo'), { participants: ['mallory'] })));
  await check('a client message create DENIED (sendMessage is the only writer)', assertFails(addDoc(collection(alice, 'conversations/order_o1/messages'), { senderId: 'alice', text: 'hi' })));

  console.log('\nreads (positive control)');
  await check('a participant reads a server-created conversation', assertSucceeds(getDoc(doc(alice, 'conversations/order_o1'))));
  await check('a stranger cannot', assertFails(getDoc(doc(stranger, 'conversations/order_o1'))));

  console.log('\nCOUNTERPROOF — rules disabled');
  await env.withSecurityRulesDisabled(async (c) => {
    await check('rules disabled: the client create succeeds (so the denials are the rules)', assertSucceeds(setDoc(doc(c.firestore(), 'conversations/x2'), { participants: ['mallory', 'victim'] })));
  });
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
