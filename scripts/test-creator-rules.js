/* test-creator-rules.js — Creator Hub Firestore + Storage rules on a REAL emulator.
 *
 * Loads the SERVED rules text (firestore.rules.build, storage.rules) explicitly:
 * `emulators:exec` loads no rules and would otherwise default to allow-all
 * (reference_emulators_exec_does_not_load_rules). A COUNTERPROOF re-runs the
 * denials under allow-all rules and requires them to flip — proving this
 * harness can SEE a denial, so "denied" is evidence and not a harness artefact.
 *
 * Fails CLOSED if the emulator hosts are not set (never falls back to :8080,
 * which another agent's emulator may hold).
 *
 *   node scripts/run-creator-rules.js      (starts private-port emulators)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('@firebase/rules-unit-testing');

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const ST_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
if (!FS_HOST || !ST_HOST) { console.error('REFUSING: FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST must be set (use scripts/run-creator-rules.js)'); process.exit(2); }
const [fh, fp] = FS_HOST.split(':'); const [sh, sp] = ST_HOST.split(':');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const denied = async (p) => { try { await T.assertFails(p); return true; } catch (_) { return false; } };
const allowed = async (p) => { try { await T.assertSucceeds(p); return true; } catch (e) { return false; } };

async function suite(env, label, expectDenials) {
  const seed = async (fn) => env.withSecurityRulesDisabled(async (c) => fn(c.firestore()));
  await seed(async (db) => {
    const f = (p, d) => db.doc(p).set(d);
    await f('entertainmentListings/filmPub', { creatorHub: true, creatorUid: 'cA', status: 'active', pubState: 'PUBLISHED', title: 'Pub' });
    await f('entertainmentListings/filmDraft', { creatorHub: true, creatorUid: 'cA', status: 'draft', pubState: 'DRAFT', title: 'Draft' });
    await f('creators/cA', { state: 'ACTIVE', displayName: 'A' });
    await f('creators/cP', { state: 'PENDING', displayName: 'P' });
    await f('creatorPrivate/cA', { phone: '+2547' });
    await f('creatorMedia/filmPub', { storagePath: 'creator-masters/cA/filmPub/x' });
    await f('royaltyAgreements/filmPub/versions/1', { status: 'LOCKED', participants: [] });
    await f('contentEntitlements/PAY1', { buyerUid: 'v1', contentId: 'filmPub', status: 'ACTIVE' });
    await f('contentAccess/v1_filmPub', { buyerUid: 'v1', paymentRef: 'PAY1', status: 'ACTIVE' });
    await f('royaltyLedger/earn_PAY1_v1_actorA', { uid: 'uActA', creatorUid: 'cA', amountCents: 100 });
    await f('royaltyAccruals/acc_PAY1', { creatorUid: 'cA', grossCents: 100 });
    await f('royaltyStatements/2026-Q3_uActA', { uid: 'uActA', releaseKes: 1 });
    await f('royaltyPeriods/2026-Q3', { status: 'OPEN' });
    await f('playbackSessions/s1', { uid: 'v1' });
    await f('entertainmentListingSecrets/leg1', { streamingUrl: 'https://secret' });
    await f('config/creatorHub', { purchasesEnabled: false });
    await f('creatorVerifications/cA', { creatorId: 'cA', status: 'SUBMITTED', identity: { documentType: 'passport', documentLast4: '1234' } });
    await f('creatorVerifications/cA/events/e1', { from: 'DRAFT', to: 'SUBMITTED', actor: 'cA' });
  });
  const anon = env.unauthenticatedContext().firestore();
  const v1 = env.authenticatedContext('v1').firestore();
  const cA = env.authenticatedContext('cA').firestore();
  const cB = env.authenticatedContext('cB').firestore();
  const act = env.authenticatedContext('uActA').firestore();
  const adm = env.authenticatedContext('adm', { admin: true }).firestore();
  const D = expectDenials;
  const expectDeny = async (l, p) => ck(`${label}: ${l} ${D ? 'DENIED' : 'ALLOWED (counterproof)'}`, D ? await denied(p) : await allowed(p));

  console.log(`\n── ${label}: client writes (all must be denied) ──`);
  await expectDeny('creator self-publishes a film', cA.doc('entertainmentListings/filmDraft').update({ pubState: 'PUBLISHED', status: 'active' }));
  await expectDeny('creator creates a film doc directly', cA.doc('entertainmentListings/new1').set({ creatorHub: true, creatorUid: 'cA', status: 'active' }));
  await expectDeny('creator self-approves', cA.doc('creators/cA').update({ state: 'ACTIVE', verification: 'VERIFIED' }));
  await expectDeny('forged creator profile for another uid', cB.doc('creators/cA').set({ state: 'ACTIVE' }));
  await expectDeny('creator edits a LOCKED royalty split', cA.doc('royaltyAgreements/filmPub/versions/1').update({ participants: [{ uid: 'cA', bps: 10000 }] }));
  await expectDeny('forged participant index', act.doc('royaltyParticipations/uActA_filmPub_v1').set({ uid: 'uActA', bps: 10000 }));
  await expectDeny('buyer writes an entitlement', v1.doc('contentEntitlements/FORGED').set({ buyerUid: 'v1', contentId: 'filmPub', status: 'ACTIVE' }));
  await expectDeny('buyer writes an access pointer', v1.doc('contentAccess/v1_filmDraft').set({ buyerUid: 'v1', status: 'ACTIVE' }));
  await expectDeny('participant credits themselves in the ledger', act.doc('royaltyLedger/earn_FAKE_v1_actorA').set({ uid: 'uActA', amountCents: 999999 }));
  await expectDeny('participant marks a statement released', act.doc('royaltyStatements/2026-Q3_uActA').update({ released: true, releaseKes: 999 }));
  await expectDeny('client marks a period PAYABLE', adm.doc('royaltyPeriods/2026-Q3').update({ status: 'PAYABLE' }));
  await expectDeny('client marks a payment COMPLETE', v1.doc('payments/PAY1').set({ status: 'COMPLETE', uid: 'v1' }));
  await expectDeny('client opens purchases (config)', adm.doc('config/creatorHub').set({ purchasesEnabled: true }));
  await expectDeny('client writes the media location', cA.doc('creatorMedia/filmPub').set({ storagePath: 'x' }));
  await expectDeny('creator marks own verification APPROVED', cA.doc('creatorVerifications/cA').update({ status: 'APPROVED' }));
  await expectDeny('creator creates a pre-approved application', cB.doc('creatorVerifications/cB').set({ status: 'APPROVED', creatorId: 'cB' }));
  await expectDeny('creator forges a verification event', cA.doc('creatorVerifications/cA/events/fake').set({ to: 'APPROVED' }));
  await expectDeny('creator sets the VERIFIED projection', cA.doc('creators/cA').update({ verification: 'VERIFIED' }));

  console.log(`\n── ${label}: reads ──`);
  if (D) {
    ck(`${label}: published film readable by anyone`, await allowed(anon.doc('entertainmentListings/filmPub').get()));
    ck(`${label}: owner reads own draft`, await allowed(cA.doc('entertainmentListings/filmDraft').get()));
    ck(`${label}: buyer reads own entitlement`, await allowed(v1.doc('contentEntitlements/PAY1').get()));
    ck(`${label}: participant reads own ledger row`, await allowed(act.doc('royaltyLedger/earn_PAY1_v1_actorA').get()));
    ck(`${label}: rights owner reads participant ledger rows of own film`, await allowed(cA.doc('royaltyLedger/earn_PAY1_v1_actorA').get()));
    ck(`${label}: owner reads own agreement`, await allowed(cA.doc('royaltyAgreements/filmPub/versions/1').get()));
    ck(`${label}: active creator profile public`, await allowed(anon.doc('creators/cA').get()));
    ck(`${label}: admin reads a period`, await allowed(adm.doc('royaltyPeriods/2026-Q3').get()));
    ck(`${label}: creator reads own verification`, await allowed(cA.doc('creatorVerifications/cA').get()));
    ck(`${label}: admin reads a verification + its events`, await allowed(adm.doc('creatorVerifications/cA').get()) && await allowed(adm.doc('creatorVerifications/cA/events/e1').get()));
  }
  await expectDeny('anonymous reads a DRAFT film', anon.doc('entertainmentListings/filmDraft').get());
  await expectDeny('rival reads another creator\'s draft', cB.doc('entertainmentListings/filmDraft').get());
  await expectDeny('anonymous reads a PENDING creator', anon.doc('creators/cP').get());
  await expectDeny('rival reads private creator contact', cB.doc('creatorPrivate/cA').get());
  await expectDeny('creator reads media location (even own)', cA.doc('creatorMedia/filmPub').get());
  await expectDeny('rival reads another film\'s agreement', cB.doc('royaltyAgreements/filmPub/versions/1').get());
  await expectDeny('another user reads my entitlement', cB.doc('contentEntitlements/PAY1').get());
  await expectDeny('cross-participant ledger read', v1.doc('royaltyLedger/earn_PAY1_v1_actorA').get());
  await expectDeny('cross-participant statement read', cB.doc('royaltyStatements/2026-Q3_uActA').get());
  await expectDeny('participant reads a period doc', act.doc('royaltyPeriods/2026-Q3').get());
  await expectDeny('viewer reads playback sessions', v1.doc('playbackSessions/s1').get());
  await expectDeny('anyone reads a legacy stream URL', v1.doc('entertainmentListingSecrets/leg1').get());
  await expectDeny('anyone reads config', v1.doc('config/creatorHub').get());
  await expectDeny("cross-creator verification read", cB.doc('creatorVerifications/cA').get());
  await expectDeny("cross-creator verification events read", cB.doc('creatorVerifications/cA/events/e1').get());
}

async function storageSuite(env, label, D) {
  const cA = env.authenticatedContext('cA').storage();
  const cB = env.authenticatedContext('cB').storage();
  const v1 = env.authenticatedContext('v1').storage();
  const anon = env.unauthenticatedContext().storage();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const put = (s, p, type) => s.ref(p).put(bytes, { contentType: type });
  const expectDeny = async (l, p) => ck(`${label}: ${l} ${D ? 'DENIED' : 'ALLOWED (counterproof)'}`, D ? await denied(p) : await allowed(p));
  console.log(`\n── ${label}: storage ──`);
  if (D) ck(`${label}: creator uploads own master (create)`, await allowed(put(cA, 'creator-masters/cA/f1/u1', 'video/mp4')));
  else await allowed(put(cA, 'creator-masters/cA/f1/u1', 'video/mp4'));
  await expectDeny('creator OVERWRITES an attached master', put(cA, 'creator-masters/cA/f1/u1', 'video/mp4'));
  await expectDeny('creator reads own master', cA.ref('creator-masters/cA/f1/u1').getDownloadURL());
  await expectDeny('viewer reads a master', v1.ref('creator-masters/cA/f1/u1').getDownloadURL());
  await expectDeny('rival uploads into another creator\'s masters', put(cB, 'creator-masters/cA/f1/u2', 'video/mp4'));
  await expectDeny('non-video master', put(cA, 'creator-masters/cA/f1/u3', 'application/pdf'));
  await expectDeny('creator deletes a master', cA.ref('creator-masters/cA/f1/u1').delete());
  if (D) {
    ck(`${label}: creator uploads own poster`, await allowed(put(cA, 'creator-public/cA/poster.jpg', 'image/jpeg')));
    ck(`${label}: poster publicly readable`, await allowed(anon.ref('creator-public/cA/poster.jpg').getDownloadURL()));
  }
  await expectDeny('rival writes another creator\'s poster', put(cB, 'creator-public/cA/evil.jpg', 'image/jpeg'));
  await expectDeny('SVG poster (XSS vector)', put(cA, 'creator-public/cA/x.svg', 'image/svg+xml'));
}

(async () => {
  const fsRules = fs.readFileSync(path.join(ROOT, 'firestore.rules.build'), 'utf8');
  const stRules = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8');
  ck('served rules text loaded (not the emulator default)', fsRules.includes('match /royaltyLedger/{entryId}') && stRules.includes('match /creator-masters/'));

  const env = await T.initializeTestEnvironment({ projectId: 'demo-creator-rules',
    firestore: { host: fh, port: Number(fp), rules: fsRules }, storage: { host: sh, port: Number(sp), rules: stRules } });
  await suite(env, 'SERVED', true);
  await storageSuite(env, 'SERVED', true);
  await env.clearFirestore(); await env.clearStorage(); await env.cleanup();

  /* COUNTERPROOF: the same harness, allow-all rules → every denial must flip. */
  const openFs = "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if true; } } }";
  const openSt = "rules_version = '2';\nservice firebase.storage { match /b/{b}/o { match /{x=**} { allow read, write: if true; } } }";
  const env2 = await T.initializeTestEnvironment({ projectId: 'demo-creator-rules-open',
    firestore: { host: fh, port: Number(fp), rules: openFs }, storage: { host: sh, port: Number(sp), rules: openSt } });
  await suite(env2, 'COUNTERPROOF', false);
  await storageSuite(env2, 'COUNTERPROOF', false);
  await env2.cleanup();

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
