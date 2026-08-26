#!/usr/bin/env node
/* Chat history boundary — emulator-backed rules test.
   Run:  firebase emulators:exec --only firestore "node scripts/test-chat-history-boundary.js"

   Proves the SECURITY PROPERTY, not just that the ruleset compiles:
     buyer/seller  -> read the whole conversation
     rider         -> reads ONLY messages from participantJoinedAt onward
     rider         -> DENIED on earlier buyer/seller messages
     outsider      -> denied entirely

   The last two are the point. A rider joining an order must not inherit the
   history that preceded them. */
'use strict';
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require(path.join(ROOT, 'node_modules/@firebase/rules-unit-testing'));
const { doc, getDoc, setDoc, Timestamp } = require(path.join(ROOT, 'node_modules/firebase/firestore'));

const BUYER = 'buyer1', SELLER = 'seller1', RIDER = 'rider1', OUTSIDER = 'nobody1';
const CONV = 'convHB';
const T0 = new Date('2026-01-01T10:00:00Z');   /* before the rider joined */
const T1 = new Date('2026-01-01T12:00:00Z');   /* the rider's join instant */
const T2 = new Date('2026-01-01T14:00:00Z');   /* after the rider joined */

let pass = 0, fail = 0;
async function check(label, p) {
  try { await p; console.log('  ok    ' + label); pass++; }
  catch (e) { console.log('  FAIL  ' + label + '  -> ' + String(e.message).slice(0, 70)); fail++; }
}

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'chat-history-boundary',
    firestore: {
      rules: fs.readFileSync(path.join(ROOT, 'firestore.rules.build'), 'utf8'),
      host: '127.0.0.1', port: 8080,
    },
  });
  await env.clearFirestore();

  /* seed with rules disabled — this mirrors what addRiderToConversation writes */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'conversations', CONV), {
      participants: [BUYER, SELLER, RIDER],
      participantJoinedAt: { [RIDER]: Timestamp.fromDate(T1) },
      participantRole: { [RIDER]: 'rider' },
      transactionType: 'order',
    });
    await setDoc(doc(db, 'conversations', CONV, 'messages', 'old1'),
      { senderId: BUYER, type: 'text', text: 'private buyer/seller talk', timestamp: Timestamp.fromDate(T0) });
    await setDoc(doc(db, 'conversations', CONV, 'messages', 'new1'),
      { senderId: SELLER, type: 'text', text: 'rider is on the way', timestamp: Timestamp.fromDate(T2) });
  });

  const asBuyer  = env.authenticatedContext(BUYER).firestore();
  const asRider  = env.authenticatedContext(RIDER).firestore();
  const asOther  = env.authenticatedContext(OUTSIDER).firestore();
  const M = (db, id) => getDoc(doc(db, 'conversations', CONV, 'messages', id));

  console.log('\nchat history boundary');
  await check('buyer reads the EARLIER message',        assertSucceeds(M(asBuyer, 'old1')));
  await check('buyer reads the later message',          assertSucceeds(M(asBuyer, 'new1')));
  await check('rider reads the message AFTER joining',  assertSucceeds(M(asRider, 'new1')));
  await check('rider DENIED the earlier message',       assertFails(M(asRider, 'old1')));
  await check('outsider denied earlier',                assertFails(M(asOther, 'old1')));
  await check('outsider denied later',                  assertFails(M(asOther, 'new1')));

  await env.cleanup();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  const m = String(e && e.message || e);
  if (/ECONNREFUSED|emulator|connect/i.test(m)) {
    console.log('  UNPROVEN — no Firestore emulator on 127.0.0.1:8080');
    process.exitCode = 2;
  } else { console.error(m); process.exitCode = 1; }
});
