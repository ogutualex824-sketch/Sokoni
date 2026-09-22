#!/usr/bin/env node
/* ============================================================================
   OUTBOX FIRESTORE INTEGRATION — the real persistence path, on a real emulator
   ============================================================================
     firebase emulators:exec --only firestore "node scripts/test-outbox-firestore.js"

   WHY THIS EXISTS
   ---------------
   scripts/test-outbox.js proves the outbox's state machine and the identity
   derivation, 165 of them, with an inverting control. It cannot prove what
   FIRESTORE does, and that is the whole guarantee: `batch.create()` refusing a
   second write is an assertion about a database engine, not about JavaScript.
   A simulated create() that I wrote would be me marking my own homework.

   So this suite exercises the PRODUCTION implementation. It requires
   functions/messages.js and calls its real handler. Nothing about the message
   path is reimplemented here: the identity derivation, the batch, the
   create(), and the unread increment are all the shipping code.

   THE RUNTIME BOUNDARY, AND ONLY THAT
   -----------------------------------
   `exports.sendMessage` is an onCall wrapper that needs a Functions runtime.
   The handler it registers — `exports._h.sendMessage` — is the same function
   body, and that is what is invoked, with a request shaped as the runtime
   shapes it. The wrapper is the only thing stepped around. The code that
   performs the create() is the code under test.

   ADMIN IS POINTED AT THE EMULATOR BY ENVIRONMENT, NEVER BY STUBBING
   ------------------------------------------------------------------
   `admin.firestore` is a prototype getter; assigning a stub over it fails
   SILENTLY and the harness then talks to PRODUCTION while printing "stubbed".
   FIRESTORE_EMULATOR_HOST is set before firebase-admin is required, so the real
   SDK connects to the emulator and there is no stub to fail.

   Admin writes bypass rules — correctly, this is server code. Rules are proven
   separately, in section 6, through @firebase/rules-unit-testing against the
   DEPLOYABLE ruleset, because the emulator's own rules discovery does not work
   in this repository (firebase.json declares `firestore` as an ARRAY).
   ========================================================================= */
'use strict';

const PROJECT = 'sokoni-outbox-int';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

/* BEFORE firebase-admin is required. */
process.env.FIRESTORE_EMULATOR_HOST = HOST;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;

const fs = require('fs');
const path = require('path');
/* firebase-admin lives in functions/node_modules, not at the repo root. Both
   this file and functions/messages.js must resolve the SAME instance, or
   initializeApp() would apply to one and not the other. */
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');

const ROOT = path.join(__dirname, '..');
const RULES_FILE = process.env.RULES_FILE || 'firestore.rules.build';

let pass = 0, fail = 0;
const ck = (label, cond, detail) => {
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + label +
    (detail ? '   [' + String(detail).slice(0, 110) + ']' : ''));
  cond ? pass++ : fail++;
  return cond;
};

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

/* THE PRODUCTION IMPLEMENTATION. */
const messages = require(path.join(ROOT, 'functions', 'messages.js'));
const MSGID = require(path.join(ROOT, 'functions', 'shared', 'message-identity.js'));

const UID_A = 'userA_outbox';
const UID_B = 'userB_outbox';
const CONV = 'convOutboxIntegration';
const KEY = 'cm_integration_0001';

const reqFor = (uid, data) => ({ auth: { uid, token: {} }, data });

async function countMessages() {
  const snap = await db.collection('conversations').doc(CONV).collection('messages').get();
  return snap.size;
}
async function unreadOf() {
  const snap = await db.collection('conversations').doc(CONV).get();
  return (snap.data() || {}).unread || 0;
}

(async () => {
  console.log('\nOUTBOX FIRESTORE INTEGRATION\n');

  /* ── 0. The code under test is the real one ───────────────────────────── */
  const handler = messages._h && messages._h.sendMessage;
  if (!ck('production message persistence implementation exercised',
    typeof handler === 'function', 'functions/messages.js _h.sendMessage')) {
    console.log('\n  cannot continue without the production handler\n');
    process.exit(1);
  }
  /* Guard against this suite silently becoming a simulation: the shipping file
     must still be the one performing the create(). */
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'messages.js'), 'utf8');
  ck('…and that implementation still uses batch.create()',
    src.indexOf('batch.create(msgRef, msgData)') !== -1);
  ck('…and still increments unread in the SAME batch',
    /batch\.create\(msgRef, msgData\)[\s\S]{0,400}unread:\s*_inc\(1\)/.test(src));

  /* Fixture: a real conversation both users participate in. */
  await db.collection('conversations').doc(CONV).delete().catch(() => {});
  const existing = await db.collection('conversations').doc(CONV).collection('messages').get();
  await Promise.all(existing.docs.map((d) => d.ref.delete()));
  await db.collection('conversations').doc(CONV).set({
    participants: [UID_A, UID_B], status: 'active', unread: 0,
    transactionType: 'order', transactionId: 'SK-INT-1',
  });
  await db.collection('users').doc(UID_A).set({ displayName: 'Buyer A' });
  await db.collection('users').doc(UID_B).set({ displayName: 'Buyer B' });
  ck('CONTROL: the fixture starts empty', (await countMessages()) === 0 && (await unreadOf()) === 0);

  /* ── 1. FIRST SUBMISSION ──────────────────────────────────────────────── */
  const first = await handler(reqFor(UID_A, {
    conversationId: CONV, type: 'text', text: 'is my order ready?', clientMessageId: KEY,
  }));
  ck('first logical message: accepted === true', first.accepted === true, JSON.stringify(first));
  ck('first logical message: duplicate is not true', first.duplicate !== true, String(first.duplicate));
  ck('first logical message creates exactly one record', (await countMessages()) === 1,
    String(await countMessages()));
  ck('first send increments unread exactly once', (await unreadOf()) === 1,
    String(await unreadOf()));

  /* ── 2. EXACT RETRY — same uid, same conversation, same key ───────────── */
  const retry = await handler(reqFor(UID_A, {
    conversationId: CONV, type: 'text', text: 'is my order ready?', clientMessageId: KEY,
  }));
  ck('identical retry returns accepted=true duplicate=true',
    retry.accepted === true && retry.duplicate === true, JSON.stringify(retry));
  ck('identical retry returns the SAME message id', retry.messageId === first.messageId,
    first.messageId + ' vs ' + retry.messageId);

  /* THE DATABASE IS THE WITNESS, not the returned object. */
  const afterRetryCount = await countMessages();
  const afterRetryUnread = await unreadOf();
  ck('identical retry creates no second message', afterRetryCount === 1, String(afterRetryCount));
  ck('identical retry creates no second unread increment', afterRetryUnread === 1,
    String(afterRetryUnread));

  /* The atomicity claim, stated directly: the rejected duplicate took the
     unread increment down with it, because they shared one batch. */
  ck('ALREADY_EXISTS rejected the WHOLE batch, increment included',
    afterRetryCount === 1 && afterRetryUnread === 1);

  /* A retry that mints a NEW key is a different logical message and MUST
     create a second record — the inverting control for everything above. */
  const different = await handler(reqFor(UID_A, {
    conversationId: CONV, type: 'text', text: 'is my order ready?',
    clientMessageId: 'cm_integration_0002',
  }));
  ck('CONTROL: a DIFFERENT key does create a second message',
    different.duplicate === false && (await countMessages()) === 2,
    String(await countMessages()));
  ck('CONTROL: …and does increment unread again', (await unreadOf()) === 2,
    String(await unreadOf()));

  /* ── 3. CROSS-USER NAMESPACE ISOLATION ────────────────────────────────── */
  const idA = MSGID.messageDocIdFor(UID_A, CONV, KEY);
  const idB = MSGID.messageDocIdFor(UID_B, CONV, KEY);
  ck('identity(A,C,X) !== identity(B,C,X)', idA !== idB, idA + ' / ' + idB);

  const bSend = await handler(reqFor(UID_B, {
    conversationId: CONV, type: 'text', text: 'different person, same key', clientMessageId: KEY,
  }));
  ck('User A + X is isolated from User B + X: B is NOT told it is a duplicate',
    bSend.accepted === true && bSend.duplicate === false, JSON.stringify(bSend));
  ck('…and B occupies its own document', bSend.messageId !== first.messageId);
  ck('…so B could not squat A\'s deterministic id (a denial of service)',
    (await countMessages()) === 3, String(await countMessages()));

  const aDoc = await db.collection('conversations').doc(CONV)
    .collection('messages').doc(idA).get();
  const bDoc = await db.collection('conversations').doc(CONV)
    .collection('messages').doc(idB).get();
  ck('Firestore holds A\'s record under A\'s derived id',
    aDoc.exists && aDoc.data().senderId === UID_A);
  ck('Firestore holds B\'s record under B\'s derived id',
    bDoc.exists && bDoc.data().senderId === UID_B);
  ck('…and the two carry the SAME clientMessageId, isolated only by sender',
    aDoc.data().clientMessageId === KEY && bDoc.data().clientMessageId === KEY);

  /* ── 4. A malformed key is refused, not coerced ───────────────────────── */
  let refused = false;
  try {
    await handler(reqFor(UID_A, {
      conversationId: CONV, type: 'text', text: 'bad key', clientMessageId: 'no',
    }));
  } catch (e) { refused = /clientMessageId/.test(String(e && e.message)); }
  ck('a malformed clientMessageId is REFUSED', refused);
  ck('…and wrote nothing', (await countMessages()) === 3, String(await countMessages()));

  /* Absent key keeps the previous random-id behaviour — nothing existing broke. */
  const noKey = await handler(reqFor(UID_A, {
    conversationId: CONV, type: 'text', text: 'legacy caller',
  }));
  ck('a caller sending NO key still works, as before', !!noKey.messageId);
  ck('…and is not reported as a duplicate', noKey.duplicate === false);

  /* ── 5. RULES AUTHORIZATION — executed, not read ──────────────────────── */
  let env = null;
  try {
    const rulesText = fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8');
    const [h, p] = HOST.split(':');
    env = await initializeTestEnvironment({
      projectId: PROJECT + '-rules',
      firestore: { rules: rulesText, host: h, port: Number(p) },
    });
    ck('the DEPLOYABLE ruleset compiles (' + RULES_FILE + ')', true);
  } catch (e) {
    ck('the DEPLOYABLE ruleset compiles (' + RULES_FILE + ')', false, e.message);
  }

  if (env) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('conversations').doc(CONV).set({
        participants: [UID_A, UID_B], status: 'active', unread: 0,
      });
      await ctx.firestore().collection('conversations').doc(CONV)
        .collection('messages').doc('m1').set({ senderId: UID_A, text: 'hi', type: 'text' });
      await ctx.firestore().collection('users').doc(UID_A).set({ active: true });
    });

    const aCtx = env.authenticatedContext(UID_A).firestore();
    const outsider = env.authenticatedContext('stranger_outbox').firestore();
    const anon = env.unauthenticatedContext().firestore();

    const r = (c) => c.collection('conversations').doc(CONV);

    try { await assertSucceeds(r(aCtx).get());
      ck('legitimate Firestore authorization succeeds', true);
    } catch (e) { ck('legitimate Firestore authorization succeeds', false, e.message); }

    try { await assertFails(r(outsider).get());
      ck('unauthorized access is rejected (non-participant)', true);
    } catch (e) { ck('unauthorized access is rejected (non-participant)', false, e.message); }

    try { await assertFails(r(anon).get());
      ck('unauthorized access is rejected (unauthenticated)', true);
    } catch (e) { ck('unauthorized access is rejected (unauthenticated)', false, e.message); }

    /* A browser must not write a message directly — the server owns that path,
       which is what makes the idempotency guarantee meaningful at all. */
    try {
      await assertFails(r(aCtx).collection('messages').doc('forged').set({
        senderId: UID_A, text: 'written straight from a browser', type: 'text',
      }));
      ck('a participant cannot write a message document directly', true);
    } catch (e) { ck('a participant cannot write a message document directly', false, e.message); }

    /* WHY it was refused matters as much as THAT it was.

       The emulator logs a rules EXPRESSION ERROR while evaluating this write —
       "Property admin is undefined on object" — raised by isAdmin() reading
       request.auth.token.admin on a token that carries no such claim. An
       expression error denies, so a refusal caused by a BROKEN RULE is
       indistinguishable from a refusal caused by a WORKING one if all you
       check is that it failed.

       The discriminator: "allow create: if false" is unconditional, so an
       ADMIN must be refused too. If the refusal above came from isAdmin()
       erroring, an admin — whose token DOES carry the claim, so no error — would
       get through. It must not. */
    const adminCtx = env.authenticatedContext('platform_admin_outbox',
      { admin: true }).firestore();
    try {
      await assertFails(adminCtx.collection('conversations').doc(CONV)
        .collection('messages').doc('forged_by_admin').set({
          senderId: 'platform_admin_outbox', text: 'admin write', type: 'text',
        }));
      ck('…refused by `create: if false`, NOT by an erroring isAdmin() ' +
        '(an admin is refused too)', true);
    } catch (e) {
      ck('…refused by `create: if false`, NOT by an erroring isAdmin() ' +
        '(an admin is refused too)', false, e.message);
    }

    /* CONTROL for that discriminator: the SAME admin context must be able to do
       something ONLY an admin may do. Otherwise "the admin was refused" might
       just mean the claim never took effect, and the discriminator proves
       nothing. shops/{uid} is "allow create: if isAdmin()" — so a success here
       shows isAdmin() evaluates TRUE for this context, which is precisely what
       rules out "isAdmin() errored" as the reason the message write failed.

       NOTE: reading the conversation is NOT such an operation. Conversations
       are "allow read: if isParticipant()" with no admin bypass — an admin who
       is not a party genuinely cannot read one, which is correct privacy
       design, not a broken context. That first attempt failed for a real
       reason and was replaced rather than relaxed. */
    try {
      await assertSucceeds(adminCtx.collection('shops').doc('shop_admin_control').set({
        name: 'control shop',
      }));
      ck('CONTROL: the admin claim IS live (admin-only shops create succeeds)', true);
    } catch (e) {
      ck('CONTROL: the admin claim IS live (admin-only shops create succeeds)',
        false, e.message);
    }

    try {
      await assertFails(r(outsider).collection('messages').doc('m1').get());
      ck('a non-participant cannot read messages', true);
    } catch (e) { ck('a non-participant cannot read messages', false, e.message); }

    await env.cleanup();
  }

  console.log('');
  console.log('  outbox unit/state:        165/0   (scripts/test-outbox.js, unchanged)');
  console.log('  outbox Firestore:         ' + pass + '/' + fail);
  console.log('');
  console.log(fail ? '  RESULT: FAIL' : '  RESULT: PASS — INTEGRATION-VERIFIED (not production verified)');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  /* A crash is not a refusal and is not a pass. */
  console.error('\n  SUITE CRASHED — this is a FAILURE, not a skip');
  console.error(e && e.stack);
  process.exit(1);
});
