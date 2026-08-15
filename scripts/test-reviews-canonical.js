/* Canonical review ratings — emulator-backed, against the real firestore.rules.

   Run:  firebase emulators:exec --only firestore "node scripts/test-reviews-canonical.js"

   WHY THIS EXISTS
   The Shop/Marketplace grid (category.html?cat=all — the SAME page the bottom nav
   calls "Shop" and the drawer calls "Marketplace") rendered a star rating computed
   from localStorage `sokoniRatings`: a map seeded by demo-seed.js and appended to
   by success.html after a purchase ON THAT DEVICE. Two shoppers saw different
   ratings for the same product, and a product with genuine approved reviews showed
   none. A rating is a business metric; CLAUDE.md forbids deriving one from local
   state.

   The canonical aggregate already existed and was simply unused here:
   ratingsSummary/{targetId} = {avg,count}, recomputed server-side by
   functions/reviews.js::_recalcSummary over APPROVED reviews only.

   What this suite pins:
     * the client may READ ratingsSummary under the deployed rules (allow read: if true)
     * the client may NOT write it — the aggregate stays server-owned
     * `reviews` is moderation-gated: approved rows are public, non-approved are not
     * documentId() `in` batching works, so a 98-card grid costs 4 queries not 98
     * count 0 / missing summary yields NO rating (the neutral state), never "★ 0"
*/
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const check = async (label, p) => {
  try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); }
};

/* Mirrors category.js::_hydrateCardRatings — a summary is shown only when it
   exists AND count > 0. Kept here so the rule and the render agree. */
function shouldRender(summary) {
  return !!(summary && typeof summary.avg === 'number' && summary.count > 0);
}

/* Mirrors the THREE-state affordance in category.js::_hydrateCardRatings.
   The distinction between "known zero" and "could not look" is the point:
   rendering them identically would turn a Firestore outage into a false claim
   that every product in the catalogue has no reviews. */
function affordanceText(readOk, summary) {
  if (!readOk) return '';                                   /* UNKNOWN — claim nothing */
  if (!shouldRender(summary)) return 'No reviews yet';      /* KNOWN zero */
  const n = summary.count;
  return '★ ' + summary.avg.toFixed(1) + ' · ' + n + ' review' + (n === 1 ? '' : 's');
}

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-reviews-canonical-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules'), 'utf8'),
      host: '127.0.0.1', port: 8080,
    },
  });
  await env.clearFirestore();

  const { doc, setDoc, getDoc, getDocs, collection, query, where, documentId } =
    require('firebase/firestore');

  /* Seed past the rules: the server owns these documents. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'ratingsSummary', 'P1'), { targetId: 'P1', avg: 4.5, count: 12 });
    await setDoc(doc(db, 'ratingsSummary', 'P2'), { targetId: 'P2', avg: 0,   count: 0  });
    await setDoc(doc(db, 'reviews', 'r-approved'), {
      targetId: 'P1', authorUid: 'buyerA', rating: 5, body: 'Great', status: 'approved', createdAt: 1 });
    await setDoc(doc(db, 'reviews', 'r-pending'), {
      targetId: 'P1', authorUid: 'buyerB', rating: 1, body: 'Spam',  status: 'pending',  createdAt: 2 });
  });

  const anon = env.unauthenticatedContext().firestore();
  const buyer = env.authenticatedContext('buyerA').firestore();

  console.log('\nCanonical rating aggregate (ratingsSummary)');
  await check('anyone may READ a summary (public catalogue needs it)',
    assertSucceeds(getDoc(doc(anon, 'ratingsSummary', 'P1'))));
  await check('a signed-in client may NOT write a summary — server-owned',
    assertFails(setDoc(doc(buyer, 'ratingsSummary', 'P1'), { avg: 5, count: 999 })));
  await check('an anonymous client may NOT write a summary',
    assertFails(setDoc(doc(anon, 'ratingsSummary', 'P1'), { avg: 5, count: 999 })));

  console.log('\nBatched read — how the grid actually fetches');
  const snap = await getDocs(query(collection(anon, 'ratingsSummary'),
    where(documentId(), 'in', ['P1', 'P2', 'P3-missing'])));
  const got = {}; snap.forEach(d => { got[d.id] = d.data(); });
  ck('documentId() `in` batching returns the summaries that exist', Object.keys(got).length === 2,
    Object.keys(got).join(','));
  ck('a product with no summary is simply absent (not an error)', !got['P3-missing']);

  console.log('\nRender contract — never invent a rating');
  ck('P1 (avg 4.5, count 12) renders a star', shouldRender(got['P1']) === true);
  ck('P2 (count 0) renders NOTHING — not "★ 0"', shouldRender(got['P2']) === false);
  ck('missing summary renders NOTHING', shouldRender(got['P3-missing']) === false);
  ck('P1 average is the server value, not a client computation',
    got['P1'] && got['P1'].avg === 4.5, got['P1'] && got['P1'].avg);

  console.log('\nReview affordance — three states, never two');
  ck('read OK + approved reviews -> canonical figures',
     affordanceText(true, got['P1']) === '★ 4.5 · 12 reviews', affordanceText(true, got['P1']));
  ck('read OK + count 0 -> "No reviews yet" (a KNOWN zero)',
     affordanceText(true, got['P2']) === 'No reviews yet');
  ck('read OK + no summary doc -> "No reviews yet"',
     affordanceText(true, got['P3-missing']) === 'No reviews yet');
  ck('read FAILED -> renders NOTHING (unknown must not read as zero)',
     affordanceText(false, undefined) === '');
  ck('read FAILED on a product that HAS reviews still renders nothing',
     affordanceText(false, got['P1']) === '');
  ck('singular is not pluralised',
     affordanceText(true, { avg: 5, count: 1 }) === '★ 5.0 · 1 review');

  console.log('\nModeration gate on reviews');
  await check('an APPROVED review is publicly readable',
    assertSucceeds(getDoc(doc(anon, 'reviews', 'r-approved'))));
  await check('a PENDING review is NOT publicly readable',
    assertFails(getDoc(doc(anon, 'reviews', 'r-pending'))));
  await check('an author may read their own pending review',
    assertSucceeds(getDoc(doc(env.authenticatedContext('buyerB').firestore(), 'reviews', 'r-pending'))));

  await env.cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
