'use strict';
/* DL-01 — rider dispatch authorization.
 *
 *   node scripts/test-dl01-rider-eligibility.js
 *
 * WHAT THIS PROVES, AND WHY IT IS BUILT THIS WAY
 * The defect was never "the rules are too loose" alone — `dispatch.js` SELECTED riders from a
 * client-writable collection and gated on `isOnline`. So a rules-only test would pass while the
 * hole stayed open. This suite drives the real ranking engine (`sokoni-dispatch.rankRiders`)
 * through BOTH the old and the new selection paths and compares who comes out.
 *
 * The counter-proof is the point: the exploit must SUCCEED against the old path. A suite that
 * only shows the new code refusing proves the new code refuses — not that it closed this.
 *
 * Case 12 is equally load-bearing: an eligible, available rider must still be dispatched. A
 * gate that refuses everybody is not a fix. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SokoniDispatch = require(path.join(ROOT, 'functions', 'sokoni-dispatch'));
const elig = require(path.join(ROOT, 'functions', 'rider-eligibility'));
const vehicleClasses = require(path.join(ROOT, 'functions', 'vehicle-classes'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── A Firestore stub with exactly the surface rider-eligibility uses ──────────────────── */
function fakeDb(drivers, verifications) {
  const doc = (coll, id) => ({ _coll: coll, _id: id });
  return {
    collection: (c) => ({ doc: (id) => doc(c, id) }),
    getAll: async (...refs) => refs.map((r) => {
      const src = r._coll === 'drivers' ? drivers : verifications;
      const data = src[r._id];
      return { id: r._id, exists: data !== undefined, data: () => data };
    }),
  };
}

/* A delivery every rider in these fixtures can physically serve, so nothing is refused for
   distance/capacity reasons and the ONLY variable under test is authorization. */
const DELIVERY = {
  pickupLat: -1.2921, pickupLng: 36.8219, weightKg: 2, parcelSize: 'small', vehicleType: 'moto',
};
const PRESENT = (uid) => ({ uid, lat: -1.2925, lng: 36.8225, isOnline: true, activeDeliveries: 0 });

const OK_DRIVER = { approved: true, status: 'approved', name: 'Real Rider', vehicleType: 'moto' };
const OK_VERIFY = { documentsComplete: true, status: 'verified_on_file' };

/* THE OLD SELECTION PATH, reproduced verbatim from dispatch.js before the fix:
      collection('rideDrivers').where('isOnline','==',true)  ->  rankRiders(rows)
   Kept here deliberately so the exploit can be demonstrated rather than asserted. */
const oldSelect = (presenceRows) => SokoniDispatch.rankRiders(
  presenceRows.filter((r) => r.isOnline === true), DELIVERY);

const newSelect = async (presenceRows, drivers, verifications) => {
  const r = await elig.filterEligible(fakeDb(drivers, verifications),
    presenceRows.filter((x) => x.isOnline === true));
  return SokoniDispatch.rankRiders(r.riders, DELIVERY);
};

(async () => {
  console.log('\nDL-01 — RIDER DISPATCH AUTHORIZATION\n' + '='.repeat(66));

  /* ── THE COUNTER-PROOF ────────────────────────────────────────────────────────────────── */
  console.log('\n0 - COUNTER-PROOF: the exploit must work against the OLD path');
  const attacker = Object.assign(PRESENT('attacker-uid'), {
    status: 'active', name: 'Totally A Rider', vehicleType: 'moto',
  });
  const oldRanked = oldSelect([attacker]);
  ck('OLD path DISPATCHES an account with no driver record at all',
    oldRanked.length === 1 && oldRanked[0].riderId === 'attacker-uid',
    'ranked ' + oldRanked.length + ' — this is the live defect, reproduced');
  const newRanked = await newSelect([attacker], {}, {});
  ck('NEW path refuses the same account', newRanked.length === 0, 'ranked ' + newRanked.length);

  /* ── THE TWELVE CASES ─────────────────────────────────────────────────────────────────── */
  console.log('\n1-11 - adversarial: none of these may become dispatchable');

  /* 1. Unauthenticated is refused before this layer (no uid => no presence row to join).
        Asserted as the empty-candidate contract rather than pretended to be an auth test. */
  const r1 = await elig.filterEligible(fakeDb({}, {}), []);
  ck('1  unauthenticated / no presence row -> no candidates', r1.riders.length === 0);

  ck('2  ordinary signed-in user -> not eligible',
    (await newSelect([PRESENT('normal-user')], {}, {})).length === 0);

  ck('3  applicant pending approval -> not eligible',
    (await newSelect([PRESENT('u3')], { u3: { approved: false, status: 'pending' } }, { u3: OK_VERIFY })).length === 0);

  /* A legacy record that predates the `approved` field: status looks right, the flag is ABSENT.
     This is the shape a fail-open lets through — `approved === false` would pass it, while
     `approved !== true` refuses. Absence must never read as permission. */
  ck('3b driver record with `approved` ABSENT -> not eligible',
    (await newSelect([PRESENT('u3b')], { u3b: { status: 'approved', name: 'Legacy', vehicleType: 'moto' } },
      { u3b: OK_VERIFY })).length === 0, 'absence is not approval');

  ck('4  approved but verification INCOMPLETE -> not eligible  (DL-02)',
    (await newSelect([PRESENT('u4')], { u4: OK_DRIVER },
      { u4: { documentsComplete: false, status: 'incomplete' } })).length === 0);

  ck('5  suspended (suspendedAt set) -> not eligible',
    (await newSelect([PRESENT('u5')],
      { u5: Object.assign({}, OK_DRIVER, { status: 'suspended', suspendedAt: '2026-09-01' }) },
      { u5: OK_VERIFY })).length === 0);

  ck('5b suspended but status still "approved" -> STILL not eligible',
    (await newSelect([PRESENT('u5b')],
      { u5b: Object.assign({}, OK_DRIVER, { suspendedAt: '2026-09-01' }) },
      { u5b: OK_VERIFY })).length === 0, 'suspendedAt alone must refuse');

  ck('6  banned -> not eligible',
    (await newSelect([PRESENT('u6')],
      { u6: Object.assign({}, OK_DRIVER, { banned: true }) }, { u6: OK_VERIFY })).length === 0);

  /* 7-8. The shard is client-writable. Lying in it must change nothing about authority. */
  const liar = Object.assign(PRESENT('u7'), { status: 'active', approved: true, suspendedAt: null });
  ck('7  client sets rideDrivers.status/approved -> no eligibility effect',
    (await newSelect([liar], {}, {})).length === 0, 'shard fields are not authority');

  ck('8  client sets rideDrivers.isOnline -> cannot bypass eligibility',
    (await newSelect([Object.assign(PRESENT('u8'), { isOnline: true })], {}, {})).length === 0);

  ck('9  a fabricated availability row alone -> no eligibility effect',
    (await newSelect([PRESENT('u9')], {}, {})).length === 0);

  ck('10 plausible GPS does not confer authority',
    (await newSelect([Object.assign(PRESENT('u10'), { lat: -1.2921, lng: 36.8219 })], {}, {})).length === 0);

  /* 11. A legacy row: the shape production actually holds — status 'active', approved true —
         but with no canonical driver record behind it. */
  ck('11 legacy rideDrivers record -> cannot bypass the canonical check',
    (await newSelect([Object.assign(PRESENT('legacy'), { status: 'active', approved: true })], {}, {})).length === 0);

  ck('11b driver record exists but verification record ABSENT -> not eligible',
    (await newSelect([PRESENT('u11b')], { u11b: OK_DRIVER }, {})).length === 0);

  ck('11c unknown/novel status -> not eligible (allowlist, not denylist)',
    (await newSelect([PRESENT('u11c')],
      { u11c: Object.assign({}, OK_DRIVER, { status: 'probation' }) }, { u11c: OK_VERIFY })).length === 0);

  /* ── THE POSITIVE CONTROL ─────────────────────────────────────────────────────────────── */
  console.log('\n12 - POSITIVE CONTROL: a real rider must still be dispatched');
  const good = await newSelect([PRESENT('good')], { good: OK_DRIVER }, { good: OK_VERIFY });
  ck('12 eligible + verified + available -> DISPATCHES', good.length === 1 && good[0].riderId === 'good',
    'ranked ' + good.length);
  ck('12b status "active" is accepted as well as "approved"',
    (await newSelect([PRESENT('g2')],
      { g2: Object.assign({}, OK_DRIVER, { status: 'active' }) }, { g2: OK_VERIFY })).length === 1);
  ck('12c verification by status alone (verified_on_file, no boolean) is accepted',
    (await newSelect([PRESENT('g3')],
      { g3: OK_DRIVER }, { g3: { status: 'verified_on_file' } })).length === 1);

  /* Capability must come from the SERVER record, or a client could claim a lorry's payload. */
  console.log('\n13 - capability is read from the canonical record, not the shard');
  const inflated = Object.assign(PRESENT('cap'), { vehicleType: 'lorry' });
  const capRes = await elig.filterEligible(
    fakeDb({ cap: Object.assign({}, OK_DRIVER, { vehicleType: 'moto' }) }, { cap: OK_VERIFY }), [inflated]);
  ck('13 client-claimed vehicleType is ignored', capRes.riders[0] && capRes.riders[0].vehicleType === 'moto',
    capRes.riders[0] && capRes.riders[0].vehicleType);
  ck('13b client-claimed name/phone come from the driver record',
    capRes.riders[0] && capRes.riders[0].name === 'Real Rider');

  /* Layer 2 asserted on its own. evaluate() already refuses a missing driver, so the structural
     guard inside filterEligible is invisible while evaluate is correct — removing it broke no
     test. A defence-in-depth layer with no independent assertion is indistinguishable from dead
     code. The permissive evaluator disables layer 1 so layer 2 has to hold by itself. */
  console.log('\n13c - defence in depth: the structural guard holds with evaluate() disabled');
  const alwaysEligible = () => ({ eligible: true, reason: 'forced' });
  /* These two force layer 1 open on purpose, so a regression here does not merely return the
     wrong answer — it can THROW on a record that was never proved to exist. An exception that
     escapes would exit non-zero with no FAIL line, which reads as "crashed", not "caught".
     Fail closed: a throw is reported as a failure of THIS case. */
  const ckSafe = async (label, fn, detail) => {
    try { ck(label, (await fn()) === true, detail); }
    catch (e) { ck(label, false, 'THREW: ' + e.message); }
  };
  await ckSafe('13c missing driver record refused even when evaluate() says yes', async () => {
    const layer2 = await elig.filterEligible(fakeDb({}, {}), [PRESENT('ghost')], alwaysEligible);
    return layer2.riders.length === 0 && !!layer2.refused[0]
      && layer2.refused[0].reason === 'no_driver_record';
  }, 'layer 2 must hold alone');
  await ckSafe('13d the permissive evaluator IS actually reached (the seam is not inert)', async () =>
    (await elig.filterEligible(fakeDb({ real: OK_DRIVER }, {}), [PRESENT('real')], alwaysEligible))
      .riders.length === 1,
  'a driver with NO verification record passes only because layer 1 was forced open');

  /* V-2 — the canonical vehicle vocabulary, at the dispatch boundary. */
  console.log('\n15 - V-2: vehicle classification fails closed');
  const withVehicle = (v) => Object.assign({}, OK_DRIVER, { vehicleType: v });
  const sel = async (v) => (await newSelect([PRESENT('v')], { v: withVehicle(v) }, { v: OK_VERIFY })).length;

  ck('15  unknown vehicle token -> NOT dispatchable (was silently "moto")', (await sel('spaceship')) === 0);
  ck('15a absent vehicleType -> NOT dispatchable', (await sel(undefined)) === 0);
  ck('15b "suv" -> recognised but UNPRICED -> NOT dispatchable', (await sel('suv')) === 0);
  ck('15c "tractor" -> NOT dispatchable (previously became a motorcycle)', (await sel('tractor')) === 0);
  ck('15d "trailer" -> NOT dispatchable', (await sel('trailer')) === 0);
  ck('15e "pickup" is its OWN class now, and is unpriced -> NOT dispatchable',
    (await sel('pickup')) === 0, 'owner ruling V-2: pickup is not an alias of van');
  ck('15f "lorry" no longer borrows truck capacity -> NOT dispatchable', (await sel('lorry')) === 0);

  ck('15g "moto" (the live production token) still dispatches', (await sel('moto')) === 1);
  ck('15h "motorcycle" dispatches', (await sel('motorcycle')) === 1);
  /* Asserting only "bike dispatches" would NOT catch a regression to bicycle — a bicycle is also
     dispatchable. The class itself has to be checked, or the collision hides behind a pass. */
  const bikeRes = await elig.filterEligible(fakeDb({ v: withVehicle('bike') }, { v: OK_VERIFY }), [PRESENT('v')]);
  ck('15i "bike" resolves to MOTORCYCLE, not bicycle (owner ruling)',
    bikeRes.riders.length === 1 && bikeRes.riders[0].vehicleType === 'moto',
    'scorer token: ' + (bikeRes.riders[0] && bikeRes.riders[0].vehicleType));
  ck('15i2 and its capacity is the motorcycle one, not the 8kg bicycle',
    vehicleClasses.capacityOf('bike').maxWeightKg === vehicleClasses.capacityOf('motorcycle').maxWeightKg
    && vehicleClasses.capacityOf('bike').maxWeightKg !== vehicleClasses.capacityOf('bicycle').maxWeightKg,
    vehicleClasses.capacityOf('bike').maxWeightKg + 'kg vs bicycle ' + vehicleClasses.capacityOf('bicycle').maxWeightKg + 'kg');
  ck('15j "van" dispatches', (await sel('van')) === 1);
  ck('15k "tuk_tuk" spelling variant resolves', (await sel('tuk_tuk')) === 1);

  /* The capacity a rider is scored with must be the one their class actually has — handing
     scoreRider a canonical token it does not know would fall back to moto and mis-size them. */
  const vres = await elig.filterEligible(fakeDb({ v: withVehicle('van') }, { v: OK_VERIFY }), [PRESENT('v')]);
  ck('15l the scorer receives a token it understands (not the canonical name)',
    vres.riders[0] && vres.riders[0].vehicleType === 'van', vres.riders[0] && vres.riders[0].vehicleType);
  const mres = await elig.filterEligible(fakeDb({ v: withVehicle('motorcycle') }, { v: OK_VERIFY }), [PRESENT('v')]);
  ck('15m canonical "motorcycle" is translated to the legacy capacity key',
    mres.riders[0] && mres.riders[0].vehicleType === 'moto', mres.riders[0] && mres.riders[0].vehicleType);

  ck('15n refusal distinguishes UNKNOWN from UNPRICED', await (async () => {
    const a = await elig.filterEligible(fakeDb({ v: withVehicle('spaceship') }, { v: OK_VERIFY }), [PRESENT('v')]);
    const b = await elig.filterEligible(fakeDb({ v: withVehicle('tractor') }, { v: OK_VERIFY }), [PRESENT('v')]);
    return /vehicle_class_unknown/.test(a.refused[0].reason) && /vehicle_class_unpriced/.test(b.refused[0].reason);
  })(), 'a typo and an unpriced class are different operator problems');

  /* A refusal must say why, for operators — and must not be silent. */
  console.log('\n14 - refusals are explained for operators');
  const refRes = await elig.filterEligible(fakeDb({ x: { approved: false } }, {}), [PRESENT('x')]);
  ck('14 refusal carries a machine-readable reason',
    refRes.refused.length === 1 && /not_approved/.test(refRes.refused[0].reason), refRes.refused[0] && refRes.refused[0].reason);

  console.log('\n' + '-'.repeat(66));
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
