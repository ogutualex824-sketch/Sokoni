/* R0 — review / unboxing rules containment (owner, 2026-09-30). Emulator-backed, against a rules FILE.

   Run (the BUILT artefact is what Firebase serves; test that, not only the source):
     node scripts/build-firestore-rules.js
     RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
       firebase emulators:exec --only firestore "node scripts/test-review-rules-r0.js"
   Baseline (must FAIL the containment rows): RULES_FILE=<served b87c94e4 text>.
   NOTE (owner 2026-09-30): every unboxing submission must REACH AdminOS, so a clean browser submission is
   accepted and born pending; only moderator/server fields are refused.

   WHAT WAS OPEN on the served ruleset b87c94e4:
     /reviews         create: claimsOwner() && noAdminFields()  — noAdminFields never blocked `status`, so a
                      browser created status:"approved" reviews with any target / rating / authorUid and no order;
                      they were public at once and counted in ratingsSummary.
     /unboxingReviews read: true, create: claimsOwner()         — a browser posted its own "verified" unboxing.

   CONTRACT after R0:
     reviews          public read = approved only; author/admin read own; ALL browser writes denied except admin.
     unboxingReviews  public read = approved only; author/admin read own; a clean submission is accepted (pending);
                      it may not set status/verified/orderVerified/likes/featured/moderation fields; edits = admin.
   Controls: the flags / helpfulVotes / ratingsSummary server-only rules are unchanged. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs , addDoc } = require('firebase/firestore');

let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };

(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({
    projectId: 'demo-r0-review-rules',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) },
  });
  console.log('\nR0 review/unboxing rules   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await setDoc(doc(d, 'reviews/rv-approved'), { authorUid: 'alice', targetId: 'p1', rating: 5, body: 'ok', status: 'approved' });
    await setDoc(doc(d, 'reviews/rv-pending'), { authorUid: 'alice', targetId: 'p1', rating: 4, body: 'wait', status: 'pending' });
    await setDoc(doc(d, 'unboxingReviews/ub-approved'), { uid: 'alice', rating: 5, status: 'approved' });
    await setDoc(doc(d, 'unboxingReviews/ub-legacy'), { uid: 'alice', rating: 5, verified: true });   /* a pre-R0 unmoderated post */
    /* 2026-10-03: submissions are written by submitUnboxing (Admin SDK), seeded here the same way */
    await setDoc(doc(d, 'unboxingReviews/UBR-2'), { uid: 'mallory', rating: 4, product: 'Cake', comment: 'nice', status: 'pending' });
    for (const c of ['reviewModerationLog', 'reviewRateLimits', 'smsSendAudit', 'deliveryPinLog']) await setDoc(doc(d, c + '/x'), { v: 1 });
    await setDoc(doc(d, 'sportsReviews/legacy'), { targetId: 'v1', rating: 4, body: 'old', uid: 'alice' });
    await setDoc(doc(d, 'propertyViewings/L1_alice_2026-10-04'), { listingId: 'L1', buyerUid: 'alice', agentUid: 'ag1', status: 'requested' });
  });
  const anon = env.unauthenticatedContext().firestore();
  const alice = env.authenticatedContext('alice').firestore();
  const mallory = env.authenticatedContext('mallory').firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();

  console.log('[A] reviews — forgery closed');
  await denies('A-1', 'signed-in browser creates status:"approved" (the live forgery)',
    setDoc(doc(mallory, 'reviews/forged'), { uid: 'mallory', authorUid: 'mallory', targetId: 'p1', rating: 5, status: 'approved' }));
  await denies('A-2', 'signed-in browser creates a pending review directly (submitReview is the only writer)',
    setDoc(doc(mallory, 'reviews/direct'), { uid: 'mallory', authorUid: 'mallory', targetId: 'p1', rating: 1, status: 'pending' }));
  await denies('A-3', 'forged review naming ANOTHER author', setDoc(doc(mallory, 'reviews/impersonate'), { uid: 'mallory', authorUid: 'alice', targetId: 'p1', rating: 1, status: 'approved' }));
  await denies('A-4', 'unauthenticated create', setDoc(doc(anon, 'reviews/anon'), { targetId: 'p1', rating: 5, status: 'approved' }));
  await denies('A-5', 'author flips own pending review to approved', updateDoc(doc(alice, 'reviews/rv-pending'), { status: 'approved' }));
  await denies('A-6', 'author edits own rating/body from the browser', updateDoc(doc(alice, 'reviews/rv-approved'), { rating: 1 }));
  await denies('A-7', 'author deletes own review from the browser (removal is an AdminOS action)', deleteDoc(doc(alice, 'reviews/rv-approved')));
  /* 2026-10-03 (sokoni-5b 7ec04c5): moderation is adminModerateReview (Admin SDK) — no browser write, admin included */
  await denies('A-8', 'admin-claimed BROWSER update (moderation is the server op)', updateDoc(doc(admin, 'reviews/rv-pending'), { status: 'rejected' }));
  await denies('A-9', 'admin-claimed BROWSER delete', deleteDoc(doc(admin, 'reviews/rv-pending')));
  console.log('[B] reviews — read contract unchanged');
  await allows('B-1', 'public reads an approved review', getDoc(doc(anon, 'reviews/rv-approved')));
  await denies('B-2', 'public reads a non-approved review', getDoc(doc(anon, 'reviews/rv-pending')));
  await allows('B-3', 'author reads own non-approved review', getDoc(doc(alice, 'reviews/rv-pending')));
  await denies('B-4', 'another user reads a non-approved review', getDoc(doc(mallory, 'reviews/rv-pending')));
  await allows('B-5', 'public list filtered to status==approved', getDocs(query(collection(anon, 'reviews'), where('status', '==', 'approved'))));

  console.log('[U] unboxingReviews — AdminOS pre-approval');
  await denies('U-1', 'signed-in browser posts a self-"verified" unboxing (the live forgery)',
    setDoc(doc(mallory, 'unboxingReviews/UBR-1'), { uid: 'mallory', rating: 5, verified: true, orderId: 'typed-anything' }));
  /* Every submission must REACH AdminOS (owner): a clean submission is accepted, born pending (no status),
     and is not public until approved. */
  await denies('U-2', 'browser direct create of even a CLEAN unboxing (submitUnboxing is the only writer, 2026-10-03)',
    setDoc(doc(mallory, 'unboxingReviews/UBR-2'), { uid: 'mallory', rating: 4, product: 'Cake', comment: 'nice', orderId: 'o-1', photoEmoji: '📦' }));
  await denies('U-2p', 'the submitted post is NOT public before approval', getDoc(doc(anon, 'unboxingReviews/UBR-2')));
  await allows('U-2r', 'AdminOS (admin) can read the pending submission', getDoc(doc(admin, 'unboxingReviews/UBR-2')));
  await denies('U-2a', 'submission that sets its own status:"approved"', setDoc(doc(mallory, 'unboxingReviews/UBR-3'), { uid: 'mallory', rating: 5, status: 'approved' }));
  await denies('U-2b', 'submission that sets likes', setDoc(doc(mallory, 'unboxingReviews/UBR-4'), { uid: 'mallory', rating: 5, likes: 999 }));
  await denies('U-2c', 'submission that sets orderVerified (Verified Buy is the server\'s)', setDoc(doc(mallory, 'unboxingReviews/UBR-5'), { uid: 'mallory', rating: 5, orderVerified: true }));
  await denies('U-2d', 'rating out of range', setDoc(doc(mallory, 'unboxingReviews/UBR-6'), { uid: 'mallory', rating: 9 }));
  await denies('U-2e', 'submission in another user\'s name', setDoc(doc(mallory, 'unboxingReviews/UBR-7'), { uid: 'alice', rating: 5 }));
  await denies('U-2f', 'the CURRENT live-page payload (verified + likes) is refused, so the client save must send a clean submission',
    setDoc(doc(mallory, 'unboxingReviews/UBR-8'), { uid: 'mallory', rating: 5, verified: false, likes: 0, liked: false, product: 'x' }));
  await denies('U-3', 'author edits own post', updateDoc(doc(alice, 'unboxingReviews/ub-approved'), { rating: 1 }));
  await denies('U-4', 'author deletes own post from the browser', deleteDoc(doc(alice, 'unboxingReviews/ub-approved')));
  await allows('U-5', 'public reads an APPROVED unboxing', getDoc(doc(anon, 'unboxingReviews/ub-approved')));
  await denies('U-6', 'public reads an unmoderated (pre-R0) unboxing', getDoc(doc(anon, 'unboxingReviews/ub-legacy')));
  await allows('U-7', 'author reads own unmoderated post', getDoc(doc(alice, 'unboxingReviews/ub-legacy')));
  await denies('U-8', 'public unfiltered wall query (the live listener shape) is refused, not silently served', getDocs(collection(anon, 'unboxingReviews')));
  await allows('U-9', 'public wall query filtered to status==approved', getDocs(query(collection(anon, 'unboxingReviews'), where('status', '==', 'approved'))));
  await denies('U-10', 'admin-claimed BROWSER update of an unboxing (adminModerateReview kind unboxing is the server op)', updateDoc(doc(admin, 'unboxingReviews/ub-legacy'), { status: 'approved' }));
  await denies('U-11', 'admin-claimed BROWSER create of an unboxing', setDoc(doc(admin, 'unboxingReviews/UBR-9'), { uid: 'admin1', rating: 5 }));

  console.log('[L] server-only logs — no client access at all');
  for (const c of ['reviewModerationLog', 'reviewRateLimits', 'smsSendAudit', 'deliveryPinLog']) {
    await denies('L-' + c + '-r', c + ': signed-in read', getDoc(doc(alice, c + '/x')));
    await denies('L-' + c + '-ar', c + ': admin-claimed read', getDoc(doc(admin, c + '/x')));
    await denies('L-' + c + '-w', c + ': admin-claimed write', setDoc(doc(admin, c + '/y'), { v: 1 }));
  }

  console.log('[H] hub reviews — server-submitted only (owner 2026-10-03)');
  await denies('H-1', 'sports-venue page payload straight to sportsReviews (even WITH uid) — self-publish closed',
    setDoc(doc(mallory, 'sportsReviews/sr1'), { targetId: 'v1', targetType: 'venue', author: 'M', rating: 5, body: 'great venue', uid: 'mallory', ts: 1 }));
  await denies('H-2', 'bnbReviews direct write (no rule — default deny)', setDoc(doc(mallory, 'bnbReviews/b1'), { targetId: 'h1', rating: 5, uid: 'mallory' }));
  await denies('H-3', 'property review MISFILED as an application (category:reviews) is refused',
    setDoc(doc(mallory, 'applications/APP-rv'), { uid: 'mallory', category: 'reviews', name: 'Anonymous', rating: 5, comment: 'nice flat' }));
  await allows('H-3c', 'inverting control: a genuine undecided application is still accepted',
    setDoc(doc(mallory, 'applications/APP-ok'), { uid: 'mallory', category: 'seller', businessName: 'M Shop', status: 'pending' }));
  await denies('H-4', 'forged approved review straight to reviews (targetType property)',
    setDoc(doc(mallory, 'reviews/mallory_property_L1'), { authorUid: 'mallory', targetType: 'property', targetId: 'L1', rating: 5, status: 'approved' }));
  await allows('H-5', 'public can still read an existing legacy sportsReviews doc', getDoc(doc(anon, 'sportsReviews/legacy')));
  await denies('H-6', 'browser forges a propertyViewings record to become review-eligible',
    setDoc(doc(mallory, 'propertyViewings/L1_mallory_2026-10-04'), { propertyId: 'L1', listingId: 'L1', buyerUid: 'mallory', uid: 'mallory', date: '2026-10-04', time: 'am', status: 'requested' }));
  await denies('H-6b', 'the live property.html payload (no date/time) stays refused', addDoc(collection(mallory, 'propertyViewings'), { propertyId: 'L1', uid: 'mallory', status: 'pending' }));
  await allows('H-6c', 'inverting control: the buyer reads their own SERVER-written viewing', getDoc(doc(alice, 'propertyViewings/L1_alice_2026-10-04')));

  console.log('[M] money records — never minted by a browser (IntaSend brief)');
  await denies('M-1', 'buyer CREATES an order already marked paymentStatus:paid',
    setDoc(doc(mallory, 'orders/o-paid'), { uid: 'mallory', buyerUid: 'mallory', items: [], total: 10000, status: 'pending', paymentStatus: 'paid' }));
  await denies('M-1b', 'buyer CREATES an order with status:paid', setDoc(doc(mallory, 'orders/o-paid2'), { uid: 'mallory', buyerUid: 'mallory', total: 10000, status: 'paid' }));
  await denies('M-1c', 'buyer CREATES an order with paymentVerified:true', setDoc(doc(mallory, 'orders/o-pv'), { uid: 'mallory', buyerUid: 'mallory', total: 10000, status: 'pending', paymentVerified: true }));
  await allows('M-1d', 'inverting control: a normal pending order (paymentStatus pending) is still created',
    setDoc(doc(mallory, 'orders/o-ok'), { uid: 'mallory', buyerUid: 'mallory', items: [], total: 500, status: 'pending', paymentStatus: 'pending' }));
  await denies('M-2', 'browser mints a bookingFees record for itself', setDoc(doc(mallory, 'bookingFees/f1'), { uid: 'mallory', amount: 5000, type: 'booking_fee' }));

  console.log('[C] controls — server-only neighbours unchanged');
  await denies('C-1', 'browser writes ratingsSummary', setDoc(doc(mallory, 'ratingsSummary/p1'), { avg: 5, count: 999 }));
  await denies('C-2', 'browser writes a flag subdoc directly', setDoc(doc(mallory, 'reviews/rv-approved/flags/mallory'), { reason: 'x' }));
  await denies('C-3', 'browser writes a helpful vote directly', setDoc(doc(mallory, 'reviews/rv-approved/helpfulVotes/mallory'), { v: 1 }));

  await env.cleanup();
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
