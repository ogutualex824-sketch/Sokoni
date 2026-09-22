/* SOKONI Connect authorization — emulator-backed, against the DEPLOYABLE artifact.
 *
 *   firebase emulators:exec --only firestore "node scripts/test-connect-rules.js"
 *   RULES_FILE=firestore.rules.build   (default — the artifact a release actually carries)
 *   COUNTERPROOF=1                     loads HEAD's artifact, where the Connect blocks do not
 *                                      exist; the suite must then FAIL, or it proves nothing
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/test-connect-authority.js` proves what the AUTHORITY decides. It cannot prove what
 * the DATABASE enforces, and those are different questions: connect-calls.js derives the
 * participant list from an anchor document, but nothing in that file stops a browser writing
 * `connectSessions/{id}` directly and adding itself. Only a rule stops that, and only an
 * emulator proves the rule.
 *
 * `emulators:exec` ALONE PROVES NOTHING HERE. Run as `firebase emulators:exec --only firestore
 * "node -e ..."` from the repository root, the emulator reports "Did not find a Cloud Firestore
 * rules file specified in a firebase.json config file" — because firebase.json declares
 * `firestore` as an ARRAY for two databases — and defaults to allowing all reads and writes.
 * A deliberately corrupted ruleset passed that way. This suite therefore loads the rules text
 * ITSELF through initializeTestEnvironment rather than trusting the emulator's own discovery,
 * and asserts a compile as a first-class result.
 *
 * WHAT IS BEING PROVEN
 * A call session is SERVER-OWNED. The participant list is the only record of who is on a call
 * and it must be unwritable from a browser — the production defect this whole layer refuses to
 * inherit is a client-named participant, where the consequence of getting it wrong is not a
 * misfiled message but a stranger's telephone ringing.
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COUNTERPROOF = !!process.env.COUNTERPROOF;
const RULES_FILE = process.env.RULES_FILE || 'firestore.rules.build';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const ok_ = async (l, p) => { try { await assertSucceeds(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };
const no_ = async (l, p) => { try { await assertFails(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };

const SESSION = {
  sessionId: 's1', channel: 'voice', mode: null,
  callerUid: 'buyer1', calleeUid: 'seller1',
  callerHandle: 'ep_buyer1', calleeHandle: 'ep_seller1',
  participants: ['buyer1', 'seller1'],
  context: { relationship: 'order', anchorType: 'orders', anchorId: 'SK-99420', purpose: '' },
  transportPlan: ['webrtc'], status: 'authorized', recording: 'DISABLED',
};

(async () => {
  console.log('\nSOKONI Connect — rules authorization\n');

  let rulesText;
  try {
    /* Absolute paths pass through, so COUNTERPROOF can point at an artifact extracted from
       another commit without writing it into the working tree. */
    rulesText = fs.readFileSync(
      path.isAbsolute(RULES_FILE) ? RULES_FILE : path.join(ROOT, RULES_FILE), 'utf8');
  } catch (e) {
    console.error(`FATAL cannot read ${RULES_FILE}: ${e.message}`);
    process.exit(1);
  }
  console.log(`  ruleset: ${RULES_FILE}  (${rulesText.length} chars)` +
    (COUNTERPROOF ? '   [COUNTERPROOF — the Connect blocks should be ABSENT]' : ''));

  /* The emulator's own rules discovery is NOT used. See this file's header. */
  let env;
  try {
    env = await initializeTestEnvironment({
      projectId: 'demo-sokoni-connect',
      firestore: { rules: rulesText, host: '127.0.0.1', port: 8080 },
    });
  } catch (e) {
    /* A compile error lands here. It is a RESULT, not an infrastructure problem: the artifact
       a release carries did not compile. */
    console.log('  FAIL  the ruleset compiles   [' + String(e.message).slice(0, 200) + ']');
    console.log('\nRESULT: 0 passed, 1 failed');
    process.exit(1);
  }
  ck('the deployable ruleset compiles', true, RULES_FILE);

  const seen = rulesText.includes('connectSessions');
  ck(COUNTERPROOF ? 'counterproof: the artifact does NOT declare connectSessions' : 'the artifact declares connectSessions',
    COUNTERPROOF ? !seen : seen);

  /* Seed through the admin context, which bypasses rules — exactly as connect-calls.js does
     from a Cloud Function. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.collection('connectSessions').doc('s1').set(SESSION);
    await db.collection('connectSessions').doc('s1').collection('signals').doc('sig1')
      .set({ from: 'buyer1', to: 'seller1', kind: 'offer', payload: 'v=0' });
    await db.collection('connectVideoGrants').doc('owner1__member1')
      .set({ ownerUid: 'owner1', memberUid: 'member1', active: true });
    await db.collection('connectVerifications').doc('v1').set({
      verificationId: 'v1', sessionId: 's1', subjectUid: 'subject1', adminUid: 'admin1',
      reason: 'merchant_verification', sessionOutcome: null,
      isProofOfIdentity: false, authority: 'providerVerification',
    });
  });

  const buyer = env.authenticatedContext('buyer1').firestore();
  const seller = env.authenticatedContext('seller1').firestore();
  const stranger = env.authenticatedContext('stranger9').firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();
  const anon = env.unauthenticatedContext().firestore();

  console.log('\n── A session is readable by its parties, and by nobody else ──');
  await ok_('C1   the caller may read the session', buyer.collection('connectSessions').doc('s1').get());
  await ok_('C2   the callee may read it', seller.collection('connectSessions').doc('s1').get());
  await ok_('C3   a platform admin may read it', admin.collection('connectSessions').doc('s1').get());
  await no_('C4   a stranger may NOT read it', stranger.collection('connectSessions').doc('s1').get());
  await no_('C5   an anonymous visitor may NOT read it', anon.collection('connectSessions').doc('s1').get());

  console.log('\n── A browser can never put itself on a call ──');
  await no_('C6   a stranger may not CREATE a session naming themselves',
    stranger.collection('connectSessions').doc('forged').set({
      participants: ['stranger9', 'seller1'], status: 'requested', channel: 'voice',
    }));
  await no_('C7   a participant may not create one either — sessions are server-written',
    buyer.collection('connectSessions').doc('forged2').set({
      participants: ['buyer1', 'seller1'], status: 'requested', channel: 'voice',
    }));
  await no_('C8   a participant may not ADD someone to an existing session',
    buyer.collection('connectSessions').doc('s1')
      .update({ participants: ['buyer1', 'seller1', 'stranger9'] }));
  await no_('C9   a participant may not flip the status to connected',
    buyer.collection('connectSessions').doc('s1').update({ status: 'connected' }));
  await no_('C10  …nor switch recording on',
    buyer.collection('connectSessions').doc('s1').update({ recording: 'ENABLED' }));
  await no_('C11  …nor widen the transport plan',
    buyer.collection('connectSessions').doc('s1').update({ transportPlan: ['webrtc', 'pstn'] }));
  await no_('C12  …nor delete the record of the call',
    buyer.collection('connectSessions').doc('s1').delete());
  await no_('C13  an ADMIN may not write either — read-only means read-only',
    admin.collection('connectSessions').doc('s1').update({ status: 'ended' }));

  console.log('\n── Signalling reaches the addressed peer only ──');
  const sig = (db) => db.collection('connectSessions').doc('s1').collection('signals').doc('sig1');
  await ok_('C14  the addressed peer may read the signal', sig(seller).get());
  await no_('C15  the SENDER may not read it back', sig(buyer).get());
  await no_('C16  a stranger may not read it', sig(stranger).get());
  await no_('C17  nobody may write a signal directly — connectSignal relays it',
    sig(buyer).set({ from: 'buyer1', to: 'seller1', kind: 'offer', payload: 'x' }));

  console.log('\n── The video grant is visible to the two accounts it names ──');
  const grant = (db) => db.collection('connectVideoGrants').doc('owner1__member1');
  const owner = env.authenticatedContext('owner1').firestore();
  const member = env.authenticatedContext('member1').firestore();
  await ok_('C18  the granting owner may read it', grant(owner).get());
  await ok_('C19  the member may read it — so a refusal can be explained', grant(member).get());
  await ok_('C20  a platform admin may read it', grant(admin).get());
  await no_('C21  a stranger may not', grant(stranger).get());
  await no_('C22  the member may NOT grant themselves video',
    grant(member).set({ ownerUid: 'owner1', memberUid: 'member1', active: true }));
  await no_('C23  the OWNER may not write it from a browser either — the callable proves the plan first',
    grant(owner).set({ ownerUid: 'owner1', memberUid: 'member1', active: true }));
  await no_('C24  …nor may an admin',
    grant(admin).update({ active: false }));

  console.log('\n── A verification is visible to its subject, and unwritable by everyone ──');
  const ver = (db) => db.collection('connectVerifications').doc('v1');
  const subject = env.authenticatedContext('subject1').firestore();
  await ok_('C25  the subject may read it — a person may see they were asked to appear on camera',
    ver(subject).get());
  await ok_('C26  a platform admin may read it', ver(admin).get());
  await no_('C27  a stranger may not', ver(stranger).get());
  await no_('C28  an anonymous visitor may not', ver(anon).get());
  await no_('C29  the SUBJECT may not record their own outcome',
    ver(subject).update({ sessionOutcome: 'verified' }));
  await no_('C30  an ADMIN may not write it from a browser — the callable holds the once-only rule',
    ver(admin).update({ sessionOutcome: 'verified' }));
  await no_('C31  nobody may create one directly',
    stranger.collection('connectVerifications').doc('forged').set({
      subjectUid: 'stranger9', sessionOutcome: 'verified',
    }));
  await no_('C32  …nor delete the record of a verification', ver(admin).delete());

  console.log('\n── Exactly one rule block per collection ──');
  /* A second match block on the same path is OR-ed with the first, so a later
     `allow write: if false` does not revoke an earlier grant — it is simply ignored. */
  const sessBlocks = (rulesText.match(/match \/connectSessions\//g) || []).length;
  const grantBlocks = (rulesText.match(/match \/connectVideoGrants\//g) || []).length;
  const verBlocks = (rulesText.match(/match \/connectVerifications\//g) || []).length;
  ck('C33  one connectSessions block', sessBlocks === (COUNTERPROOF ? 0 : 1), sessBlocks + ' block(s)');
  ck('C34  one connectVideoGrants block', grantBlocks === (COUNTERPROOF ? 0 : 1), grantBlocks + ' block(s)');
  ck('C35  one connectVerifications block', verBlocks === (COUNTERPROOF ? 0 : 1), verBlocks + ' block(s)');

  await env.cleanup();

  console.log('\n' + '─'.repeat(72));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (COUNTERPROOF) {
    console.log(fail > 0
      ? `COUNTER-PROOF HOLDS — ${fail} check(s) fail against an artifact without the Connect blocks.`
      : 'COUNTER-PROOF FAILED — everything passed without the rules; the detectors prove nothing.');
    process.exit(fail > 0 ? 0 : 1);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
