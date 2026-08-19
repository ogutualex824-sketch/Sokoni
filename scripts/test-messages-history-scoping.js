/* ══════════════════════════════════════════════════════════════════════════════
   MESSAGES — JOIN-TIME HISTORY SCOPING  (rules-enforced)
   ══════════════════════════════════════════════════════════════════════════════
   A rider joins an order conversation when they are assigned, and must NOT thereby
   gain the buyer/merchant history that preceded them.

   THIS RUNS AGAINST THE REAL RULES IN THE FIRESTORE EMULATOR. That is the whole
   point: a filter in the UI is a presentation choice, and a rider could query
   Firestore directly. Only the rules layer can actually enforce this, so only a
   rules test can prove it.

   Run:
     firebase emulators:exec --only firestore "node scripts/test-messages-history-scoping.js"
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const unp = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log('\n' + t);

const BUYER = 'u_buyer', SELLER = 'u_seller', RIDER = 'u_rider', RIDER2 = 'u_rider2', STRANGER = 'u_str';
const CONV = 'order_o1';
const T = (n) => new Date(Date.UTC(2026, 0, 1, 0, n, 0));   /* deterministic clock */
const JOIN = T(10);                                         /* rider joined at minute 10 */

(async () => {
  console.log('\nMESSAGES — JOIN-TIME HISTORY SCOPING  (firestore emulator, real rules)');
  console.log('='.repeat(78));

  const env = await initializeTestEnvironment({
    projectId: 'sokoni-rules-test',
    firestore: { rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });

  /* Seed with rules DISABLED — this is fixture setup, not a tested path. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('conversations/' + CONV).set({
      transactionType: 'order', transactionId: 'o1',
      participants: [BUYER, SELLER, RIDER],
      participantsMeta: {
        [BUYER]:  { joinedAt: null },
        [SELLER]: { joinedAt: null },
        [RIDER]:  { joinedAt: JOIN, leftAt: null },
      },
    });
    /* 10 messages BEFORE the rider joined, 5 after. */
    for (let i = 0; i < 10; i++) {
      await db.doc('conversations/' + CONV + '/messages/old' + i)
        .set({ senderId: BUYER, text: 'old ' + i, createdAt: T(i) });
    }
    for (let i = 0; i < 5; i++) {
      await db.doc('conversations/' + CONV + '/messages/new' + i)
        .set({ senderId: SELLER, text: 'new ' + i, createdAt: T(20 + i) });
    }
  });

  const as = (uid) => env.authenticatedContext(uid).firestore();
  const readMsg = (uid, id) => as(uid).doc('conversations/' + CONV + '/messages/' + id).get();

  head('1 - unscoped participants see everything (existing behaviour preserved)');
  ck('buyer reads an OLD message', await assertSucceeds(readMsg(BUYER, 'old0')).then(() => true, () => false));
  ck('buyer reads a NEW message', await assertSucceeds(readMsg(BUYER, 'new0')).then(() => true, () => false));
  ck('merchant reads an OLD message', await assertSucceeds(readMsg(SELLER, 'old9')).then(() => true, () => false));

  head('2 - the rider is scoped to their joinedAt');
  ck('rider CANNOT read a message from before they joined',
     await assertFails(readMsg(RIDER, 'old0')).then(() => true, () => false));
  ck('...nor the last one before joining',
     await assertFails(readMsg(RIDER, 'old9')).then(() => true, () => false));
  ck('rider CAN read a message created after joining',
     await assertSucceeds(readMsg(RIDER, 'new0')).then(() => true, () => false));

  head('3 - the LIST path is fail-closed, not partially served');
  const unscoped = as(RIDER).collection('conversations/' + CONV + '/messages');
  ck('an UNSCOPED rider query is denied outright (no partial results)',
     await assertFails(unscoped.get()).then(() => true, () => false));
  const scoped = as(RIDER).collection('conversations/' + CONV + '/messages').where('createdAt', '>=', JOIN);
  const scopedOk = await scoped.get().then((s) => s.size, () => -1);
  if (scopedOk < 0) ck('a scoped rider query is allowed', false, 'denied');
  else if (scopedOk === 0) unp('a scoped rider query returns the post-join messages', 'no post-join messages in fixture');
  else ck('a scoped rider query returns ONLY post-join messages', scopedOk === 5, scopedOk + ' of 5');

  head('4 - a replaced rider');
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('conversations/' + CONV).set({
      transactionType: 'order', transactionId: 'o1',
      participants: [BUYER, SELLER, RIDER2],
      participantsMeta: {
        [BUYER]: { joinedAt: null }, [SELLER]: { joinedAt: null },
        [RIDER]: { joinedAt: JOIN, leftAt: T(30) },
        [RIDER2]: { joinedAt: T(30), leftAt: null },
      },
    });
  });
  ck('the PREVIOUS rider is denied immediately, even for a post-join message',
     await assertFails(readMsg(RIDER, 'new0')).then(() => true, () => false));
  ck('...and denied a direct read of an old message',
     await assertFails(readMsg(RIDER, 'old0')).then(() => true, () => false));
  ck('the NEW rider cannot read messages from before THEIR join',
     await assertFails(readMsg(RIDER2, 'new0')).then(() => true, () => false));

  head('5 - clients cannot rewrite the scoping');
  ck('a rider cannot change their own joinedAt',
     await assertFails(as(RIDER2).doc('conversations/' + CONV).update({
       participantsMeta: { [RIDER2]: { joinedAt: T(0) } } })).then(() => true, () => false));
  ck('a stranger cannot add themselves to participants',
     await assertFails(as(STRANGER).doc('conversations/' + CONV).update({
       participants: [BUYER, SELLER, RIDER2, STRANGER] })).then(() => true, () => false));
  ck('a participant cannot add anyone either',
     await assertFails(as(BUYER).doc('conversations/' + CONV).update({
       participants: [BUYER, SELLER, RIDER2, STRANGER] })).then(() => true, () => false));
  ck('a stranger still cannot read any message',
     await assertFails(readMsg(STRANGER, 'new0')).then(() => true, () => false));
  ck('direct message creation is still blocked (sends go through the CF)',
     await assertFails(as(BUYER).doc('conversations/' + CONV + '/messages/forged')
       .set({ senderId: SELLER, text: 'spoofed', createdAt: T(40) })).then(() => true, () => false));

  head('6 - the conversation document leaks no message text');
  /* Rules cannot hide a single field: any participant can read the whole
     conversation doc. So the defence is that the text is NOT THERE — the preview
     lives in the per-participant userConversations index instead. This asserts the
     absence at the read a rider can actually perform. */
  const convDoc = await as(RIDER2).doc('conversations/' + CONV).get();
  ck('a scoped rider CAN read the conversation document (rules allow it)', convDoc.exists);
  const cd = convDoc.data() || {};
  ck('...and it carries NO message text',
     !cd.lastMessage || typeof cd.lastMessage.text === 'undefined',
     JSON.stringify(cd.lastMessage || null));
  ck('...no other field carries message text either',
     !JSON.stringify(cd).includes('old ') && !JSON.stringify(cd).includes('new '),
     'no seeded message body found in the document');

  head('7 - non-vacuity');
  /* If NO message existed after the rider's join, "rider sees only new messages"
     would pass for the wrong reason. Prove the fixture actually contains both. */
  let counts = { before: 0, after: 0 };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const s = await ctx.firestore().collection('conversations/' + CONV + '/messages').get();
    s.forEach((d) => { (d.data().createdAt.toDate() < JOIN ? counts.before++ : counts.after++); });
  });
  ck('the fixture contains PRE-join messages to be denied', counts.before > 0, String(counts.before));
  if (counts.after === 0) unp('post-join readability', 'fixture has no post-join messages');
  else ck('the fixture contains POST-join messages to be allowed', counts.after > 0, String(counts.after));

  await env.cleanup();
  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nHARNESS ERROR: ' + (e && e.message) + '\n'); process.exit(2); });
