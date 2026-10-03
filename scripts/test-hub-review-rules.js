/* Hub review stores — CENSUS proof against the real rules (sokoni-5b, 2026-10-03).

   Run:  firebase emulators:exec --only firestore "node scripts/test-hub-review-rules.js"
         RULES_FILE=<extracted candidate> firebase emulators:exec --only firestore "node scripts/test-hub-review-rules.js"

   This is NOT a fix. It records what each hub's review writer does TODAY: every row sends the byte-for-byte payload
   the page sends (see docs/HUB_REVIEW_STORES_CENSUS.md for the source line of each) and asserts the backend result.
   A row that changes outcome means the census is stale — re-read the writer before trusting any conclusion.

   Outcome vocabulary:
     LOST       the page says "thank you / submitted" but the rules refuse the write (the review never exists)
     SELF-PUB   the browser publishes a review with no purchase/booking check and no moderation
     MISFILED   the write succeeds into a collection that is not a review store
     CF-ONLY    the browser is refused; only a Cloud Function writes (positive control for the refusal path)
*/
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const check = async (label, p) => { try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); } };

(async () => {
  const rulesFile = process.env.RULES_FILE || 'firestore.rules';
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-hub-review-census',
    firestore: { rules: fs.readFileSync(path.isAbsolute(rulesFile) ? rulesFile : path.join(__dirname, '..', rulesFile), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await env.clearFirestore();
  const { doc, setDoc, addDoc, collection, serverTimestamp } = require('firebase/firestore');
  const U = 'buyerA';
  const db = env.authenticatedContext(U).firestore();
  console.log('\nHub review stores — census against ' + rulesFile + '\n');

  /* ── entertainment-hub.js submitReview: writes approved:true, which noAdminFields() forbids ── */
  await check('E-1 LOST      entReviews  entertainment-hub payload (approved:true) is REFUSED',
    assertFails(addDoc(collection(db, 'entReviews'), { uid: U, targetType: 'artist', targetId: 'a1', reviewerName: 'A',
      rating: 5, comment: 'x', approved: true, createdAt: serverTimestamp() })));
  await check('E-2 SELF-PUB  entReviews  the same payload WITHOUT approved is ACCEPTED (dropping the flag is not a fix)',
    assertSucceeds(addDoc(collection(db, 'entReviews'), { uid: U, targetType: 'artist', targetId: 'a1', reviewerName: 'A',
      rating: 5, comment: 'x', createdAt: serverTimestamp() })));

  /* ── home-services.html submitReview → _hsFireWrite: no uid in the payload; rule needs uid ── */
  await check('H-1 LOST      homeServiceReviews  home-services payload (no uid) is REFUSED',
    assertFails(addDoc(collection(db, 'homeServiceReviews'), { providerId: 'p1', providerName: 'P', rating: 5, text: 'x',
      reviewer: 'A', hub: 'home-services', createdAt: serverTimestamp() })));

  /* ── legal-hub.html legacy fallback: no lawyerId; rule needs uid, lawyerId, rating, date ── */
  await check('L-1 LOST      legalReviews  legal-hub fallback payload (no lawyerId) is REFUSED',
    assertFails(addDoc(collection(db, 'legalReviews'), { apptId: 'c1', rating: 5, text: 'x', reviewerName: 'A',
      date: new Date().toISOString(), uid: U })));

  /* ── digital.html submitFlReview: reviewerUid = caller; no contract check ── */
  await check('D-1 SELF-PUB  digitalReviews  a review for ANY contract / seller is ACCEPTED',
    assertSucceeds(addDoc(collection(db, 'digitalReviews'), { id: 'REVX', contractId: 'not-my-contract', gigId: null,
      sellerUid: 'any-seller', rating: 1, text: 'x', reviewerName: 'A', reviewerUid: U, createdAt: Date.now() })));

  /* ── sokoni-health.js / sokoni-construct.js saveReview: no page calls them today, but the path is open ── */
  await check('HC-1 SELF-PUB healthReviews  saveReview payload is ACCEPTED (dormant writer, open surface)',
    assertSucceeds(setDoc(doc(db, 'healthReviews', 'HRV-1'), { providerId: 'hp1', rating: 1, text: 'x', id: 'HRV-1', uid: U, createdAt: serverTimestamp() }, { merge: true })));
  await check('C-1 SELF-PUB  constructReviews  saveReview payload is ACCEPTED (dormant writer, open surface)',
    assertSucceeds(setDoc(doc(db, 'constructReviews', 'CRV-1'), { providerId: 'cp1', rating: 1, text: 'x', id: 'CRV-1', uid: U, createdAt: serverTimestamp() }, { merge: true })));

  /* ── sokoni-sports.js addReview → fsWrite: no id (client throws on .doc(undefined)) and no uid ── */
  await check('S-1 LOST      sportsReviews  sports payload, even given an id, is REFUSED (no uid)',
    assertFails(setDoc(doc(db, 'sportsReviews', 'RV1'), { targetId: 'v1', targetType: 'venue', author: 'A', rating: 5, body: 'x', ts: Date.now() }, { merge: true })));

  /* ── sokoni-bnb.js addReview → fsWrite('reviews') = bnbReviews: no rule block exists ── */
  await check('B-1 LOST      bnbReviews  no rule block — default deny',
    assertFails(setDoc(doc(db, 'bnbReviews', 'RV1'), { targetId: 'b001', name: 'A', rating: 5, comment: 'x', ts: Date.now(), uid: U }, { merge: true })));

  /* ── sokoni-property.js addReview → SokoniDB.saveApplication({...review, category:'reviews'}) ── */
  await check('P-1 MISFILED  applications  a property review is ACCEPTED as an APPLICATION (admin queue, never public)',
    assertSucceeds(setDoc(doc(db, 'applications', 'APP-1'), { targetId: 'agt001', targetType: 'agent', name: 'A', rating: 5,
      comment: 'x', ts: Date.now(), category: 'reviews', id: 'APP-1', uid: U, createdAt: serverTimestamp() }, { merge: true })));

  /* ── positive controls for the refusal path: CF-only stores ── */
  await check('X-1 CF-ONLY   providerReviews  browser create REFUSED',
    assertFails(setDoc(doc(db, 'providerReviews', 'bk1'), { providerId: 'p1', rating: 5, uid: U })));
  await check('X-2 CF-ONLY   entertainmentReviews  browser create REFUSED',
    assertFails(setDoc(doc(db, 'entertainmentReviews', 'r1'), { listingId: 'l1', rating: 5, reviewerUid: U })));

  await env.cleanup();
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a result):', e && e.message); process.exit(2); });
