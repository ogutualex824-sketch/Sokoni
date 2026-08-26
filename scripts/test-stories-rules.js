/* ══════════════════════════════════════════════════════════════════════════════
   STORIES AUTHORITY — the rules, executed against the emulator
   ══════════════════════════════════════════════════════════════════════════════
   Stories are merchant-authored and buyer-visible, and every decision that matters is the
   SERVER's: publication, the weekly allocation claim, moderation state, the view counter and
   expiry. So the whole surface rests on one claim — a client cannot write here — and that is
   a claim only the rules layer can make good on. A module check would prove nothing: a
   merchant can reach Firestore directly from the browser console.

   Run (needs the emulator):
     firebase emulators:exec --only firestore "node scripts/test-stories-rules.js"
   Without it the suite says UNPROVEN rather than passing.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const unp = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log('\n' + t);

(async () => {
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

  /* ── The artifact itself, before any behaviour ─────────────────────────── */
  head('1 - the ruleset carries the Stories authority, and fits');
  ck('merchantStories is declared', rules.indexOf('match /merchantStories/{storyId}') > -1);
  ck('storyAllocations is declared', rules.indexOf('match /storyAllocations/{allocationId}') > -1);
  ck('the ruleset is within the 256,000-byte ceiling',
     rules.length <= 256000, rules.length + ' bytes, ' + (256000 - rules.length) + ' free');

  let env;
  try {
    const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
    env = await initializeTestEnvironment({
      projectId: 'sokoni-stories-test',
      firestore: { rules, host: '127.0.0.1', port: 8080 },
    });

    const ok = (p) => p.then(() => true, () => false);
    const M1 = 'merchant_one', M2 = 'merchant_two', BUYER = 'buyer_one';
    const merchant = env.authenticatedContext(M1);
    const other = env.authenticatedContext(M2);
    const buyer = env.authenticatedContext(BUYER);
    const anon = env.unauthenticatedContext();
    const admin = env.authenticatedContext('admin_one', { admin: true, role: 'admin' });

    /* Seed through the back door — exactly as a Cloud Function would. */
    await env.withSecurityRulesDisabled(async (c) => {
      await c.firestore().doc('merchantStories/s1').set({
        merchantId: M1, mediaUrl: 'https://x/1.jpg', kind: 'image',
        status: 'active', views: 0,
        publishedAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      });
      await c.firestore().doc('storyAllocations/' + M1 + '_2026-W35').set({
        merchantId: M1, isoWeek: '2026-W35', storyId: 's1', claimedAt: new Date(),
      });
    });

    const story = (ctx, id) => ctx.firestore().doc('merchantStories/' + (id || 's1'));
    const alloc = (ctx, id) => ctx.firestore().doc('storyAllocations/' + (id || (M1 + '_2026-W35')));

    /* ── READS: buyers discover stories, so any signed-in account may read ── */
    head('2 - reads: buyers must be able to discover a story');
    ck('the author reads their own story', await ok(assertSucceeds(story(merchant).get())));
    ck('a BUYER reads it — discovery is the point',
       await ok(assertSucceeds(story(buyer).get())));
    ck('another merchant reads it — it is buyer-visible, not private',
       await ok(assertSucceeds(story(other).get())));
    /* The one read that must fail: stories are for signed-in accounts. */
    ck('an UNAUTHENTICATED client cannot read', await ok(assertFails(story(anon).get())));

    /* ── WRITES: the whole authority rests here ───────────────────────────── */
    head('3 - writes: CF-only, and that means the AUTHOR too');
    ck('the author cannot CREATE a story directly',
       await ok(assertFails(story(merchant, 'forged').set({
         merchantId: M1, mediaUrl: 'https://x/2.jpg', kind: 'image', status: 'active',
       }))), 'publication is a server decision — an allocation must be claimed first');
    ck('the author cannot EDIT their own story',
       await ok(assertFails(story(merchant).update({ mediaUrl: 'https://x/evil.jpg' }))));
    ck('the author cannot extend their own expiry',
       await ok(assertFails(story(merchant).update({ expiresAt: new Date(Date.now() + 30 * 86400000) }))),
       'expiry is server-enforced; a client that could set it would never expire');
    ck('the author cannot inflate their own view count',
       await ok(assertFails(story(merchant).update({ views: 99999 }))));
    ck('the author cannot change moderation status',
       await ok(assertFails(story(merchant).update({ status: 'approved' }))));
    ck('the author cannot DELETE it', await ok(assertFails(story(merchant).delete())));
    ck('another merchant cannot write to it',
       await ok(assertFails(story(other).update({ mediaUrl: 'https://x/hijack.jpg' }))));
    ck('a buyer cannot write to it',
       await ok(assertFails(story(buyer).update({ views: 5 }))));
    ck('an ADMIN cannot write directly either',
       await ok(assertFails(story(admin).update({ status: 'removed' }))),
       'moderation goes through a function, so it is logged and reversible');

    /* ── ALLOCATIONS: the scarcity that makes Stories work ─────────────────── */
    head('4 - allocations: cannot be forged, read or double-claimed');
    ck('a merchant cannot READ their own allocation',
       await ok(assertFails(alloc(merchant).get())),
       'allocation state is the server\'s bookkeeping, not a client surface');
    ck('a merchant cannot READ another merchant\'s allocation',
       await ok(assertFails(alloc(other).get())));
    ck('a merchant cannot FORGE an allocation for a new week',
       await ok(assertFails(alloc(merchant, M1 + '_2026-W36').set({
         merchantId: M1, isoWeek: '2026-W36', claimedAt: new Date(),
       }))), 'forging one would publish a story without spending the weekly slot');
    ck('a merchant cannot overwrite an existing allocation to re-claim it',
       await ok(assertFails(alloc(merchant).set({ merchantId: M1, isoWeek: '2026-W35', storyId: 's2' }))),
       'double-claiming is the whole reason the claim is atomic and server-side');
    ck('a merchant cannot DELETE an allocation to free the week',
       await ok(assertFails(alloc(merchant).delete())));
    ck('an admin MAY read allocations', await ok(assertSucceeds(alloc(admin).get())),
       'support needs to see why a publish was refused');
    ck('an admin still cannot write one', await ok(assertFails(alloc(admin).delete())));

    /* ── NEGATIVE CONTROL ──────────────────────────────────────────────────
       Every write above failed. That is only meaningful if a write CAN succeed in this
       harness at all — otherwise the emulator, not the rules, is refusing everything. */
    head('5 - negative control: the harness can write when a rule permits it');
    const ownDoc = buyer.firestore().doc('userLocations/' + BUYER + '/places/p1');
    ck('NC a permitted write DOES succeed here',
       await ok(assertSucceeds(ownDoc.set({ label: 'Home', town: 'Nairobi' }))),
       'so the failures above are the RULES refusing, not the rig');

    await env.cleanup();
  } catch (e) {
    const why = (e && e.message) || String(e);
    if (/ECONNREFUSED|emulator|connect/i.test(why)) {
      unp('every rules assertion', 'the Firestore emulator is not running — run under firebase emulators:exec');
    } else {
      ck('the rules suite ran', false, why);
    }
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed' +
              (unproven ? ', ' + unproven + ' unproven' : ''));
  process.exit(fail ? 1 : 0);
})();
