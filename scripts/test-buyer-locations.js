/* ══════════════════════════════════════════════════════════════════════════════
   BUYER SAVED LOCATIONS — logic + ownership isolation
   ══════════════════════════════════════════════════════════════════════════════
   Two halves, and the second is the one that matters:

     1. the module's own rules (normalise / snapshot / deliverability), executed
     2. OWNERSHIP ISOLATION against the REAL firestore.rules in the emulator —
        because "another buyer cannot read my addresses" is a claim only the rules
        layer can make good on. A module check would prove nothing: a buyer can
        query Firestore directly.

   Run the full suite (needs the emulator):
     firebase emulators:exec --only firestore "node scripts/test-buyer-locations.js"
   Logic-only (no emulator) still runs and says so.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const L = require(path.join(ROOT, 'sokoni-buyer-locations.js'));

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const unp = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nBUYER SAVED LOCATIONS');
console.log('='.repeat(74));

head('1 - the canonical shape is the only shape stored');
const n = L.normalise({ label: 'Home', building: 'Block B', unit: 'B14', street: 'Ngong Rd',
                        area: "Lang'ata", town: 'Nairobi', instructions: 'Use the main gate',
                        lat: -1.3, lng: 36.8, hacker: 'evil', sellerUid: 'u_seller' });
ck('every canonical field is kept', n.building === 'Block B' && n.unit === 'B14' && n.town === 'Nairobi');
ck('UNKNOWN keys are dropped, not stored', n.hacker === undefined && n.sellerUid === undefined,
   Object.keys(n).filter((k) => L.FIELDS.indexOf(k) === -1 && k !== 'formatted').join(',') || 'none');
ck('a missing label defaults to Other', L.normalise({ town: 'Nairobi' }).label === 'Other');
ck('formatted is built from the parts present', n.formatted === "Block B · B14 · Ngong Rd · Lang'ata · Nairobi", n.formatted);
ck('...and omits blanks rather than leaving stray separators',
   L.normalise({ town: 'Nairobi' }).formatted === 'Nairobi', L.normalise({ town: 'Nairobi' }).formatted);

head('2 - a pin is a PAIR');
ck('both coordinates are kept', L.normalise({ town: 'X', lat: -1.3, lng: 36.8 }).lat === -1.3);
ck('lat WITHOUT lng is discarded', L.normalise({ town: 'X', lat: -1.3 }).lat === undefined);
ck('lng WITHOUT lat is discarded', L.normalise({ town: 'X', lng: 36.8 }).lng === undefined);
ck('non-numeric coordinates are discarded', L.normalise({ town: 'X', lat: 'abc', lng: 'def' }).lat === undefined);

head('3 - deliverability: an address OR a pin, never nothing');
ck('a written address is deliverable', L.isDeliverable(L.normalise({ town: 'Nairobi' })));
ck('a pin ALONE is deliverable (a buyer who drops a pin has told us where)',
   L.isDeliverable(L.normalise({ lat: -1.3, lng: 36.8 })));
ck('a label alone is NOT deliverable', !L.isDeliverable(L.normalise({ label: 'Home' })));
ck('empty is not deliverable', !L.isDeliverable(L.normalise({})));

head('4 - the snapshot is a COPY, not a reference');
const place = Object.assign({ id: 'p1' }, L.normalise({ label: 'Home', town: 'Nairobi', building: 'Block B' }));
const snap = L.snapshot(place, 'TS');
ck('it carries the address', snap.town === 'Nairobi' && snap.building === 'Block B');
ck('it records which saved place it came from', snap.savedPlaceId === 'p1');
ck('it stamps when it was captured', snap.capturedAt === 'TS');
place.town = 'Mombasa'; place.building = 'Block Z';
ck('editing the saved place does NOT rewrite the snapshot', snap.town === 'Nairobi' && snap.building === 'Block B',
   snap.town + ' / ' + snap.building);
ck('...and the snapshot holds no live reference back', typeof snap.ref === 'undefined' && !snap.__proto__.town);

head('5 - geolocation refusal must not break manual entry');
ck('currentPin resolves rather than throwing when geolocation is absent',
   typeof L.currentPin === 'function');
/* Deferred into the async block below — a top-level await here made Node unable to
   decide whether this file was CommonJS or an ES module, and it refused to run at all. */
const noGeoPromise = (() => {
  /* global.navigator is a getter-only property in modern Node, so a plain assignment
     throws. defineProperty is the only way to simulate a browser without geolocation. */
  const orig = Object.getOwnPropertyDescriptor(global, 'navigator');
  Object.defineProperty(global, 'navigator', { value: undefined, configurable: true });
  const p = L.currentPin(50);
  if (orig) Object.defineProperty(global, 'navigator', orig);
  return p;
})();
ck('a manually typed address with NO pin is still deliverable',
   L.isDeliverable(L.normalise({ building: 'Block B', town: 'Nairobi' })));

head('6 - this phase writes no order and no seller document');
/* Comments stripped FIRST. The module's header explains that it is deliberately not
   `deliveryLocations` (the rider GPS collection), and a raw grep matched that prose and
   reported the very confusion the comment exists to prevent. Same trap as the
   role/workspace check earlier in this workstream — a detector that reads documentation
   as code will keep finding it. */
const src = fs.readFileSync(path.join(ROOT, 'sokoni-buyer-locations.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
ck('the module never touches the orders collection', !/['"]orders['"]/.test(src));
ck('...nor shops / sellers', !/['"](shops|sellers)['"]/.test(src));
ck('...nor packageRequests', !/packageRequests/.test(src));
ck('...and writes only under userLocations', (src.match(/var COL = '([a-zA-Z]+)'/) || [])[1] === 'userLocations');
ck('it is NOT the rider GPS collection', !/deliveryLocations/.test(src));

/* ── 7. ownership isolation — the half only rules can prove ───────────────── */
(async () => {
  ck('geolocation refusal yields null, so the form stays usable', (await noGeoPromise) === null);

  head('7 - ownership isolation (real firestore.rules)');
  let env = null;
  try {
    const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
    env = await initializeTestEnvironment({
      projectId: 'sokoni-loc-test',
      firestore: { rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
    });
    const A = 'buyer_a', B = 'buyer_b';
    const doc = (ctx, uid) => ctx.firestore().doc('userLocations/' + uid + '/places/p1');
    const ok = (p) => p.then(() => true, () => false);

    await env.withSecurityRulesDisabled(async (c) => {
      await c.firestore().doc('userLocations/' + A + '/places/p1')
        .set({ label: 'Home', town: 'Nairobi', building: 'Block B' });
    });

    const a = env.authenticatedContext(A), b = env.authenticatedContext(B), anon = env.unauthenticatedContext();
    ck('owner reads their own place', await ok(assertSucceeds(doc(a, A).get())));
    ck('owner writes their own place', await ok(assertSucceeds(doc(a, A).set({ label: 'Home', town: 'Nairobi' }))));
    ck('ANOTHER BUYER cannot read it', await ok(assertFails(doc(b, A).get())));
    ck('ANOTHER BUYER cannot write it', await ok(assertFails(doc(b, A).set({ label: 'Hacked', town: 'X' }))));
    ck('another buyer cannot DELETE it', await ok(assertFails(doc(b, A).delete())));
    ck('an unauthenticated client cannot read it', await ok(assertFails(doc(anon, A).get())));
    ck('a non-numeric lat is refused by the rules', await ok(assertFails(
      doc(a, A).set({ label: 'Home', town: 'X', lat: 'not-a-number', lng: 1 }))));
    ck('a numeric pin is accepted', await ok(assertSucceeds(
      doc(a, A).set({ label: 'Home', town: 'X', lat: -1.3, lng: 36.8 }))));

    /* Non-vacuity: an empty collection would let "another buyer sees nothing" pass
       for the wrong reason. Prove the document is genuinely there and readable BY
       ITS OWNER before trusting any denial above. */
    const owned = await doc(a, A).get();
    ck('NON-VACUITY: the place really exists and the owner really reads it',
       owned.exists && !!owned.data().label, owned.exists ? owned.data().label : 'absent');

    await env.cleanup();
  } catch (e) {
    if (env) { try { await env.cleanup(); } catch (_) {} }
    unp('ownership isolation against real rules', 'emulator unavailable: ' + (e && e.message || '').slice(0, 60));
    console.log('        run: firebase emulators:exec --only firestore "node scripts/test-buyer-locations.js"');
  }

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed' + (unproven ? ', ' + unproven + ' unproven' : ''));
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
