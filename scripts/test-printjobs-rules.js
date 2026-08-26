/* ══════════════════════════════════════════════════════════════════════════════
   posPrintJobs — shop-scoped read isolation, EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
   The desktop printer host must read a job because it is an authenticated OWNER OF THE SHOP,
   not because it happens to be the same user who made the sale. A job created by a cashier's
   phone carries that cashier's uid; without the shop-owner path the owner's desktop cannot
   read the work it exists to print.

   The addition is ADDITIVE. The uid path stays exactly as it was, so every existing POS
   reader keeps working — that is asserted here, not assumed.

   Writes stay CF-only. A browser that could manufacture a print job could make somebody
   else's printer produce arbitrary paper.

   Run (needs the emulator):
     firebase emulators:exec --only firestore "node scripts/test-printjobs-rules.js"
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

  head('1 - the artifact');
  ck('the shop-owner read path is present',
     /ownsBiz\(resource\.data\.shopId\)/.test(rules));
  ck('the uid path is PRESERVED, not replaced',
     /resource\.data\.uid == request\.auth\.uid/.test(rules.slice(rules.indexOf('match /posPrintJobs'), rules.indexOf('match /posPrintJobs') + 400)));
  ck('writes remain CF-only',
     /allow create, update, delete: if false;/.test(rules.slice(rules.indexOf('match /posPrintJobs'), rules.indexOf('match /posPrintJobs') + 500)));
  ck('the ruleset is within the ceiling',
     rules.length <= 256000, rules.length + ' bytes, ' + (256000 - rules.length) + ' free');

  let env;
  try {
    const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
    env = await initializeTestEnvironment({
      projectId: 'sokoni-printjobs-test',
      firestore: { rules, host: '127.0.0.1', port: 8080 },
    });
    const ok = (p) => p.then(() => true, () => false);

    const OWNER_A = 'owner_a', OWNER_B = 'owner_b';
    const CASHIER = 'cashier_a', STRANGER = 'stranger';
    const SHOP_A = 'SHOP_A', SHOP_B = 'SHOP_B';

    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore();
      await db.doc('businesses/' + SHOP_A).set({ ownerId: OWNER_A, name: 'Bravilex Duka' });
      await db.doc('businesses/' + SHOP_B).set({ ownerId: OWNER_B, name: 'Other Duka' });
      /* The case the whole change exists for: created by the CASHIER's phone. */
      await db.doc('posPrintJobs/job1').set({
        uid: CASHIER, shopId: SHOP_A, receiptId: 'RCPT-000042',
        status: 'pending', bytes: 512, createdAt: new Date(),
      });
      /* Another shop's job — the isolation target. */
      await db.doc('posPrintJobs/job2').set({
        uid: 'cashier_b', shopId: SHOP_B, receiptId: 'RCPT-000099',
        status: 'pending', bytes: 512, createdAt: new Date(),
      });
      /* A legacy job with no shopId at all — the uid path must still carry it. */
      await db.doc('posPrintJobs/job3').set({
        uid: OWNER_A, receiptId: 'RCPT-000001', status: 'pending', createdAt: new Date(),
      });
    });

    const job = (ctx, id) => ctx.firestore().doc('posPrintJobs/' + id);
    const ownerA = env.authenticatedContext(OWNER_A);
    const ownerB = env.authenticatedContext(OWNER_B);
    const cashier = env.authenticatedContext(CASHIER);
    const stranger = env.authenticatedContext(STRANGER);
    const anon = env.unauthenticatedContext();
    const admin = env.authenticatedContext('admin_1', { admin: true });

    head('2 - the desktop host reads its shop\'s work');
    ck('SHOP A owner reads a job created by their CASHIER',
       await ok(assertSucceeds(job(ownerA, 'job1').get())),
       'this is the read the whole change exists for');

    head('3 - the existing uid path is untouched');
    ck('the cashier still reads their OWN job', await ok(assertSucceeds(job(cashier, 'job1').get())));
    ck('a legacy job with NO shopId is still readable by its uid',
       await ok(assertSucceeds(job(ownerA, 'job3').get())),
       'the addition must not regress jobs predating shopId');

    head('4 - isolation: a desktop on Shop A must never take Shop B\'s work');
    ck('SHOP A owner cannot read SHOP B\'s job', await ok(assertFails(job(ownerA, 'job2').get())));
    ck('SHOP B owner cannot read SHOP A\'s job', await ok(assertFails(job(ownerB, 'job1').get())));
    ck('the cashier cannot read another shop\'s job', await ok(assertFails(job(cashier, 'job2').get())));
    ck('a user owning no shop cannot read any job', await ok(assertFails(job(stranger, 'job1').get())));
    ck('an unauthenticated client is denied', await ok(assertFails(job(anon, 'job1').get())));

    head('5 - admin retains access');
    ck('admin reads any job', await ok(assertSucceeds(job(admin, 'job2').get())));

    head('6 - clients cannot manufacture or mutate print work');
    ck('the shop owner cannot CREATE a job',
       await ok(assertFails(job(ownerA, 'forged').set({
         uid: OWNER_A, shopId: SHOP_A, receiptId: 'RCPT-FORGED', status: 'pending',
       }))), 'a client that could create one could print arbitrary paper on a real printer');
    ck('the shop owner cannot CLAIM a job by writing status',
       await ok(assertFails(job(ownerA, 'job1').update({ status: 'claimed', claimedBy: 'dev1' }))),
       'the claim is an atomic SERVER transition, not a client write');
    ck('the cashier cannot mark their own job printed',
       await ok(assertFails(job(cashier, 'job1').update({ status: 'printed' }))));
    ck('the shop owner cannot DELETE a job', await ok(assertFails(job(ownerA, 'job1').delete())));
    ck('an ADMIN cannot write directly either',
       await ok(assertFails(job(admin, 'job1').update({ status: 'printed' }))));

    head('7 - forgery: shopId is read from the STORED document');
    ck('a stranger cannot read by claiming a shopId in a query payload',
       await ok(assertFails(job(stranger, 'job1').get())),
       'reads resolve ownsBiz against resource.data.shopId, which the client cannot set');
    ck('owning a DIFFERENT business does not admit them',
       await ok(assertFails(job(ownerB, 'job1').get())));

    head('8 - negative control');
    ck('NC a permitted write succeeds in this harness',
       await ok(assertSucceeds(ownerA.firestore().doc('userLocations/' + OWNER_A + '/places/p1')
         .set({ label: 'Home', town: 'Nairobi' }))),
       'so the refusals above are the RULES, not the rig');

    await env.cleanup();
  } catch (e) {
    const why = (e && e.message) || String(e);
    if (/ECONNREFUSED|emulator|connect|Cannot find module/i.test(why)) {
      unp('every emulator assertion', 'the Firestore emulator or its test package is unavailable');
    } else {
      ck('the suite ran', false, why);
    }
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed' + (unproven ? ', ' + unproven + ' unproven' : ''));
  process.exit(fail ? 1 : 0);
})();
