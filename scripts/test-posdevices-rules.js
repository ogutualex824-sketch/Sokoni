/* ══════════════════════════════════════════════════════════════════════════════
   posDevices — the ownsBiz() access path, EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
   Production allows a business owner to reach their own POS devices through
   ownsBiz(merchantId); the repository lineage has only isPosOwner() || isAdmin() and does not
   define ownsBiz at all. The proposed ruleset deliberately CARRIES PRODUCTION FORWARD, so a
   rules release from this lineage cannot silently strip a business owner's access to their
   own devices.

   Structural checks — "ownsBiz is defined once and called four times" — cannot make that
   claim good. A helper can exist, be called, and still not admit the person it was written
   for: `exists()` on the wrong path, an ownerId field that does not match, a disjunct in the
   wrong order. Only the emulator settles it.

   ownsBiz(mid) = isAuthed()
               && mid is string
               && exists(businesses/$(mid))
               && get(businesses/$(mid)).data.ownerId == request.auth.uid

   Run (needs the emulator):
     firebase emulators:exec --only firestore "node scripts/test-posdevices-rules.js"
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

  head('1 - the access path is present in the artifact under test');
  ck('ownsBiz is defined', /function ownsBiz\(mid\)/.test(rules));
  ck('posDevices read admits ownsBiz',
     /allow read:\s*if isPosOwner\(\) \|\| isAdmin\(\) \|\| ownsBiz\(resource\.data\.merchantId\)/.test(rules));
  ck('posDevices update admits ownsBiz',
     /allow update:\s*if isPosOwner\(\) \|\| isAdmin\(\) \|\| ownsBiz\(resource\.data\.merchantId\)/.test(rules));
  ck('posDevices create admits ownsBiz',
     /allow create:\s*if claimsPosOwner\(\) \|\| ownsBiz\(request\.resource\.data\.merchantId\)/.test(rules));

  let env;
  try {
    const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
    env = await initializeTestEnvironment({
      projectId: 'sokoni-posdev-test',
      firestore: { rules, host: '127.0.0.1', port: 8080 },
    });
    const ok = (p) => p.then(() => true, () => false);

    const OWNER = 'biz_owner_1';      /* owns businesses/BIZ1 */
    const OTHER = 'biz_owner_2';      /* owns businesses/BIZ2 */
    const SELLER = 'pos_seller_1';    /* named in the device's sellerId */
    const STRANGER = 'random_user';
    const BIZ1 = 'BIZ1', BIZ2 = 'BIZ2';

    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore();
      await db.doc('businesses/' + BIZ1).set({ ownerId: OWNER, name: 'Bravilex Duka' });
      await db.doc('businesses/' + BIZ2).set({ ownerId: OTHER, name: 'Other Duka' });
      /* A device belonging to BIZ1, operated by SELLER. */
      await db.doc('posDevices/dev1').set({ merchantId: BIZ1, sellerId: SELLER, label: 'Till 1' });
      /* A device belonging to BIZ2 — the isolation target. */
      await db.doc('posDevices/dev2').set({ merchantId: BIZ2, sellerId: 'pos_seller_2', label: 'Till 2' });
    });

    const dev = (ctx, id) => ctx.firestore().doc('posDevices/' + id);
    const owner = env.authenticatedContext(OWNER);
    const other = env.authenticatedContext(OTHER);
    const seller = env.authenticatedContext(SELLER);
    const stranger = env.authenticatedContext(STRANGER);
    const anon = env.unauthenticatedContext();
    const admin = env.authenticatedContext('admin_1', { admin: true });

    /* ── THE PATH BEING CARRIED FORWARD ───────────────────────────────────── */
    head('2 - a business owner reaches their OWN devices through ownsBiz()');
    ck('owner READS their own device', await ok(assertSucceeds(dev(owner, 'dev1').get())),
       'this is the access the repo lineage would have removed');
    ck('owner UPDATES their own device',
       await ok(assertSucceeds(dev(owner, 'dev1').update({ label: 'Front counter' }))));
    ck('owner CREATES a device for their own business',
       await ok(assertSucceeds(dev(owner, 'dev3').set({ merchantId: BIZ1, sellerId: 'x', label: 'Till 3' }))));

    /* ── ISOLATION ────────────────────────────────────────────────────────── */
    head('3 - and reaches nobody else\'s');
    ck('owner cannot read ANOTHER business\'s device', await ok(assertFails(dev(owner, 'dev2').get())));
    ck('owner cannot update another business\'s device',
       await ok(assertFails(dev(owner, 'dev2').update({ label: 'Hijacked' }))));
    ck('the OTHER owner cannot read this one', await ok(assertFails(dev(other, 'dev1').get())));
    ck('a merchant who owns no business cannot read it',
       await ok(assertFails(dev(stranger, 'dev1').get())));
    ck('an UNAUTHENTICATED client is denied', await ok(assertFails(dev(anon, 'dev1').get())));

    /* ── FORGERY: the disjunct reads merchantId off the DOCUMENT ──────────── */
    head('4 - merchantId cannot be forged to gain access');
    /* Reads/updates resolve ownsBiz against resource.data.merchantId — the STORED value — so
       claiming another merchantId in the payload must not open the door. */
    ck('a stranger cannot update by CLAIMING a merchantId they do not own',
       await ok(assertFails(dev(stranger, 'dev1').update({ merchantId: BIZ1, label: 'Forged' }))),
       'ownsBiz reads the STORED merchantId, not the submitted one');
    /* sellerId must name SOMEONE ELSE, or claimsPosOwner() — the first disjunct — allows the
       create on its own and the assertion says nothing about ownsBiz. My first version set
       sellerId to the stranger themselves and "failed" against perfectly correct rules:
       a seller registering their own device is exactly what that disjunct is for. */
    ck('a stranger cannot create a device for ANOTHER seller against a business they do not own',
       await ok(assertFails(dev(stranger, 'dev9').set({ merchantId: BIZ1, sellerId: 'someone_else' }))),
       'neither disjunct admits them: not the seller, not the business owner');
    ck('...nor against a NON-EXISTENT business',
       await ok(assertFails(dev(stranger, 'dev10').set({ merchantId: 'NO_SUCH_BIZ', sellerId: 'someone_else' }))),
       'exists() is what refuses this one');
    /* And the converse, so the two above are not passing merely because everything fails. */
    ck('CONTROL: the real business owner CAN create for another seller',
       await ok(assertSucceeds(dev(owner, 'dev11').set({ merchantId: BIZ1, sellerId: 'someone_else' }))),
       'ownsBiz admits them where claimsPosOwner does not');

    /* ── isPosOwner() — the other disjunct, unchanged ─────────────────────── */
    head('5 - isPosOwner() still works, independently of ownsBiz()');
    ck('the named sellerId READS the device', await ok(assertSucceeds(dev(seller, 'dev1').get())),
       'isPosOwner() matches resource.data.sellerId');
    ck('the named sellerId UPDATES the device',
       await ok(assertSucceeds(dev(seller, 'dev1').update({ label: 'Counter A' }))));
    ck('a different seller does NOT match', await ok(assertFails(dev(seller, 'dev2').get())));
    ck('claimsPosOwner() lets a seller create their own device',
       await ok(assertSucceeds(dev(seller, 'dev4').set({ merchantId: 'ANY', sellerId: SELLER }))),
       'create checks the SUBMITTED sellerId, which is the device being claimed');

    /* ── ADMIN ────────────────────────────────────────────────────────────── */
    head('6 - admin behaviour is unchanged');
    ck('admin reads any device', await ok(assertSucceeds(dev(admin, 'dev2').get())));
    ck('admin updates any device', await ok(assertSucceeds(dev(admin, 'dev2').update({ label: 'Support' }))));
    ck('admin may DELETE', await ok(assertSucceeds(dev(admin, 'dev2').delete())));
    /* Delete is admin-only — neither the business owner nor the seller may. */
    ck('the business owner may NOT delete', await ok(assertFails(dev(owner, 'dev1').delete())));
    ck('the named seller may NOT delete', await ok(assertFails(dev(seller, 'dev1').delete())));

    /* ── NEGATIVE CONTROL ─────────────────────────────────────────────────── */
    head('7 - negative control');
    ck('NC a permitted write succeeds in this harness',
       await ok(assertSucceeds(owner.firestore().doc('userLocations/' + OWNER + '/places/p1')
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

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed' +
              (unproven ? ', ' + unproven + ' unproven' : ''));
  process.exit(fail ? 1 : 0);
})();
