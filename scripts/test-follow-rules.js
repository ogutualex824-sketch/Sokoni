/* Follow lifecycle + Firestore rules — emulator-backed.

   Run:  firebase emulators:exec --only firestore "node scripts/test-follow-rules.js"

   WHY THIS EXISTS
   ---------------
   Follow reported "Action failed — try again" on every attempt from business.html.
   The cause was not the network and not the UI: the page wrote

       follows/{uid}_{entityId}          <- underscore

   while the deployed rule is

       match /follows/{followId} {
         allow create: if isAuthed() && followId.matches(request.auth.uid + '--.*');
       }

   That document ID can NEVER satisfy the regex, so the write was rejected 100% of
   the time. A UI test cannot distinguish "the button is wired wrong" from "the
   document ID is unrepresentable", which is exactly how this survived: the failure
   was total, deterministic, and invisible behind one generic toast.

   So the ID FORMAT is the thing under test here, against the real rules file. Each
   case below runs the sequence a user actually performs, and asserts the BACKEND
   result — the document's existence after each step — rather than the button label.

   Covered:
     * the canonical ID is accepted; the four historical wrong shapes are rejected
     * follow -> persists -> unfollow -> persists -> refollow  (survives refresh:
       every read is a fresh get(), never a cached UI value)
     * repeat follow is idempotent (rapid double-tap cannot create a duplicate or
       corrupt state)
     * unauthenticated follow is denied
     * one user cannot create, read or delete another user's follow
     * every followable entity type shares the one model
     * the soft-delete unfollow the old code used ({deleted:true} merge) is denied,
       which is why unfollow appeared to work and then came back
     * followerCounts is denied both ways — the reason its write must never be
       allowed to fail the follow (see sokoni-db.js)
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

/* The canonical document ID. Must stay byte-identical to sokoni-social.js
   _fDocId() / sokoni-db.js _followDocId() / business.html _bizFollowId(). */
const followId = (uid, type, entityId) =>
  uid + '--' + type + '--' + String(entityId).replace(/[^a-zA-Z0-9]/g, '_');

const followDoc = (uid, type, entityId, name) => ({
  uid, type, entityId: String(entityId), entityName: name || '', createdAt: 1,
});

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-follow-rules-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', process.env.RULES_FILE || 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  /* Start from empty. Without this the suite is only correct on a fresh emulator:
     documents left by the previous run make every `create` an update, so the
     canonical-ID case fails for the very reason the suite exists to distinguish. */
  await env.clearFirestore();

  const { doc, setDoc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');

  const UID = 'buyerA', OTHER = 'buyerB';
  const dbA = env.authenticatedContext(UID).firestore();
  const dbB = env.authenticatedContext(OTHER).firestore();
  const dbAnon = env.unauthenticatedContext().firestore();

  console.log('\nFollow — canonical document ID vs the deployed rule');
  console.log('  rule: follows/{followId} create if followId.matches(uid + \'--.*\')');

  /* ── 1. The ID shapes ─────────────────────────────────────────────────────
     The four rejected shapes are the ones that were actually in the codebase. */
  await check('canonical  {uid}--{type}--{entityId}  ACCEPTED',
    assertSucceeds(setDoc(doc(dbA, 'follows', followId(UID, 'business', 'biz1')),
      /* Canonical legal name — scripts/verify-company-identity.js flags any file that
         says "Bravilex" without it. A fixture is still a file the brand gate reads. */
      followDoc(UID, 'business', 'biz1', 'Bravilex International Co. Limited'))));

  await check('business.html shape  {uid}_{entityId}  DENIED  <- the reported bug',
    assertFails(setDoc(doc(dbA, 'follows', UID + '_biz1'),
      { followerUid: UID, businessId: 'biz1', ts: 1 })));

  await check('another user\'s prefix  {otherUid}--...  DENIED',
    assertFails(setDoc(doc(dbA, 'follows', followId(OTHER, 'business', 'biz1')),
      followDoc(OTHER, 'business', 'biz1'))));

  await check('no uid prefix at all  {type}--{entityId}  DENIED',
    assertFails(setDoc(doc(dbA, 'follows', 'business--biz1'),
      followDoc(UID, 'business', 'biz1'))));

  await check('bare uid, no separator  {uid}  DENIED',
    assertFails(setDoc(doc(dbA, 'follows', UID), followDoc(UID, 'business', 'biz1'))));

  /* ── 2. The lifecycle the user performs ───────────────────────────────────
     Each assertion re-reads from the emulator, so "survives refresh" is tested
     as a backend fact, not as a button label. */
  console.log('\nLifecycle — follow / refresh / unfollow / refresh / refollow');
  const fid = followId(UID, 'store', 'kaspa_prints');
  const ref = () => doc(dbA, 'follows', fid);

  await check('follow  -> write accepted',
    assertSucceeds(setDoc(ref(), followDoc(UID, 'store', 'kaspa_prints', 'Kaspa Prints'))));

  let snap = await getDoc(ref());
  ck('refresh -> document EXISTS (state persisted)', snap.exists());
  ck('refresh -> canonical fields present (uid/type/entityId)',
    snap.exists() && snap.data().uid === UID && snap.data().type === 'store' &&
    snap.data().entityId === 'kaspa_prints',
    snap.exists() ? JSON.stringify(snap.data()) : 'missing');

  /* Re-following something already followed.

     The rule grants create/read/delete — there is NO `allow update`. So writing the
     document again is an UPDATE and is DENIED. This is not hypothetical: the UI
     cache and the server disagree exactly in the cross-device case
     (follow on phone A, open the page on phone B with a stale cache showing
     "Follow", tap it), and the old comment in sokoni-social.js claimed this path
     was "idempotent — safe even if the label was stale cross-device". It is not.

     Rather than grant `update` (which would also let a client rewrite the follow's
     fields, and cannot be added anyway — the compiled ruleset has ~72B of headroom),
     the CLIENT must converge: on permission-denied for a follow, re-read the doc;
     if it exists the user is already following, which is the intended end state. */
  await check('re-follow an existing doc is an UPDATE -> DENIED (no allow update)',
    assertFails(setDoc(ref(), followDoc(UID, 'store', 'kaspa_prints', 'Kaspa Prints'), { merge: true })));
  snap = await getDoc(ref());
  ck('...and the reconciliation read still sees the follow -> client converges to "Following"',
    snap.exists());

  await check('unfollow -> delete accepted', assertSucceeds(deleteDoc(ref())));
  snap = await getDoc(ref());
  ck('refresh -> document GONE (unfollow persisted)', !snap.exists());

  await check('refollow -> accepted after delete',
    assertSucceeds(setDoc(ref(), followDoc(UID, 'store', 'kaspa_prints', 'Kaspa Prints'))));
  snap = await getDoc(ref());
  ck('refresh -> following again', snap.exists());

  /* The mirror of the case above: unfollowing something already unfollowed. The
     delete rule does not reference `resource`, so deleting an absent document is
     permitted and the client converges to "not following" without an error. */
  await deleteDoc(ref());
  await check('unfollow when already unfollowed -> allowed (converges, no error)',
    assertSucceeds(deleteDoc(ref())));
  await setDoc(ref(), followDoc(UID, 'store', 'kaspa_prints', 'Kaspa Prints'));

  /* ── 3. The old soft-delete unfollow ──────────────────────────────────────
     business.html unfollowed with setDoc({deleted:true},{merge:true}). That is an
     UPDATE, and the rule grants create/read/delete only — so unfollow was denied,
     and had it succeeded the document would still exist and every other surface
     would keep reading the user as a follower. */
  console.log('\nRegression — the soft-delete unfollow that was in business.html');
  await check('soft-delete unfollow {deleted:true} DENIED (no update permission)',
    assertFails(updateDoc(ref(), { deleted: true, updatedAt: 2 })));
  snap = await getDoc(ref());
  ck('soft-delete left the follow intact -> would have shown a false Unfollowed', snap.exists());
  await deleteDoc(ref()).catch(() => {});

  /* ── 4. Auth and isolation ────────────────────────────────────────────────*/
  console.log('\nAuth / isolation');
  await check('logged-out follow DENIED',
    assertFails(setDoc(doc(dbAnon, 'follows', followId('anon', 'store', 'kaspa_prints')),
      followDoc('anon', 'store', 'kaspa_prints'))));

  await setDoc(doc(dbB, 'follows', followId(OTHER, 'store', 'kenshop')),
    followDoc(OTHER, 'store', 'kenshop', 'KenShop'));

  await check('user A cannot READ user B\'s follow',
    assertFails(getDoc(doc(dbA, 'follows', followId(OTHER, 'store', 'kenshop')))));
  await check('user A cannot DELETE user B\'s follow',
    assertFails(deleteDoc(doc(dbA, 'follows', followId(OTHER, 'store', 'kenshop')))));
  await check('user B CAN read their own follow',
    assertSucceeds(getDoc(doc(dbB, 'follows', followId(OTHER, 'store', 'kenshop')))));

  /* ── 5. Every followable entity type, one model ───────────────────────────
     The types actually emitted across the platform. If a new surface adds a type
     it inherits this, which is the point of an entity-agnostic model. */
  console.log('\nEntity types — one model for every followable thing');
  const TYPES = ['store', 'business', 'shop', 'seller', 'provider', 'user', 'hub',
                 'plumber', 'mechanic', 'electrician', 'cleaner', 'legal',
                 'hospital', 'bnb', 'car', 'entertainment', 'construction'];
  for (const t of TYPES) {
    const id = followId(UID, t, 'entity-1');
    /* eslint-disable no-await-in-loop */
    await check('type "' + t + '" follow + unfollow',
      assertSucceeds(setDoc(doc(dbA, 'follows', id), followDoc(UID, t, 'entity-1')))
        .then(() => assertSucceeds(deleteDoc(doc(dbA, 'follows', id)))));
  }

  /* ── 6. followerCounts — why it must never fail the follow ────────────────
     There is no rule for this collection, so it is denied both ways. sokoni-db.js
     used to issue it inside the SAME Promise.all() as the follow document, so this
     denial rejected the whole call and a follow that HAD been written reported
     failure. It is now fired-and-caught separately. */
  console.log('\nfollowerCounts — no rule exists (documents the blocked gap)');
  await check('followerCounts write DENIED (no rule)',
    assertFails(setDoc(doc(dbA, 'followerCounts', 'store--kaspa_prints'), { count: 1 })));
  await check('followerCounts read DENIED (no rule) -> counts must render "—"',
    assertFails(getDoc(doc(dbA, 'followerCounts', 'store--kaspa_prints'))));

  await env.cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
