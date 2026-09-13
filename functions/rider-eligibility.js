'use strict';
/**
 * RIDER ELIGIBILITY — the single authority for "may this account be dispatched a delivery?"
 *
 * DL-01. Before this module, `dispatch.js` selected riders with
 *
 *     collection('rideDrivers').where('isOnline','==',true)
 *
 * and nothing else. `rideDrivers` is client-creatable in the served ruleset, and
 * `noAdminFields()` — a DENYLIST — does not name `status`, `suspendedAt` or `isOnline`. So any
 * signed-in account could write `rideDrivers/{own-uid}` with `isOnline:true` and plausible GPS
 * and be dispatched real deliveries, including the pickup address and fee. Suspension did not
 * stop it either: `suspendedAt` was client-clearable AND never read.
 *
 * THE FIX IS NOT A LONGER DENYLIST. Adding `status` to `noAdminFields()` would leave the next
 * unnamed field to reopen the same hole — this is the third time this mechanism has appeared
 * (HC-01 on healthProviders, phoneVerified on users, now DL-01). The invariant is structural:
 *
 *     AUTHORITY  comes from `drivers` + `driverVerification`, which NO client can write.
 *     AVAILABILITY comes from a presence shard, which a client MAY write — because being
 *                  online is a fact about a device, not a permission.
 *
 * A client that lies about presence gets nothing: presence only decides WHICH eligible rider is
 * chosen, never WHETHER an account is eligible. That separation is what makes the shard safe to
 * leave writable, and it is already the shape `application-lifecycle.js::projectDriver` intends
 * — it creates approved riders OFFLINE precisely because approval grants the right to work
 * rather than putting someone on the road.
 */

/* Statuses on `drivers` that represent a live, working driver. `projectDriver` writes
   'approved' on approval and 'suspended' on retraction; production also holds 'active' from an
   earlier projection. An UNKNOWN status is not eligible — this is an allowlist, deliberately,
   because that is the property a denylist failed to provide. */
const vehicleClasses = require('./vehicle-classes');   /* V-2 — the canonical vehicle vocabulary */

const ELIGIBLE_STATUSES = new Set(['approved', 'active']);

/* driverVerification.status when the documents are on file. `projectDriver` writes
   'verified_on_file' when nothing is missing and 'incomplete' otherwise. */
const VERIFIED_STATUSES = new Set(['verified_on_file', 'verified']);

/**
 * Decide eligibility from the two server-controlled records.
 * Returns { eligible: boolean, reason: string } — the reason is for operator diagnostics and
 * audit, never surfaced to the rider, because it would tell an attacker which gate to attack.
 */
function evaluate(driver, verification) {
  if (!driver) return { eligible: false, reason: 'no_driver_record' };

  /* `approved` is written by the approval projection and is protected by noAdminFields() even
     on the writable shard. Checked here against the SERVER record regardless. */
  if (driver.approved !== true) return { eligible: false, reason: 'not_approved' };

  if (!ELIGIBLE_STATUSES.has(String(driver.status || ''))) {
    return { eligible: false, reason: 'status_not_eligible:' + (driver.status || 'absent') };
  }

  /* Suspension, from the record a client cannot write. Both spellings are checked: the
     projection writes `suspendedAt`, while the rules denylist protects a boolean `suspended`,
     so a record may carry either. Presence of EITHER refuses. */
  if (driver.suspendedAt) return { eligible: false, reason: 'suspended' };
  if (driver.suspended === true) return { eligible: false, reason: 'suspended' };
  if (driver.banned === true) return { eligible: false, reason: 'banned' };

  /* DL-02: verification must GATE eligibility, not merely be recorded beside it. The approval
     projection happily writes documentsComplete:false alongside approved:true, which is exactly
     the production state found in the D0 census — a driver approved and active whose document
     verification was incomplete. */
  if (!verification) return { eligible: false, reason: 'no_verification_record' };
  const complete = verification.documentsComplete === true
    || VERIFIED_STATUSES.has(String(verification.status || ''));
  if (!complete) {
    return { eligible: false, reason: 'verification_incomplete:' + (verification.status || 'absent') };
  }

  /* V-2. A driver whose vehicle class cannot be resolved to a PRICED canonical class is not
     dispatchable. Two distinct refusals hide behind one check:
       - unknown token  ('spaceship', a typo, a new class nobody mapped) — previously became
         'moto' silently, so an unmapped vehicle was dispatched as a motorcycle;
       - recognised but UNPRICED (pickup, suv, lorry, trailer, tractor) — these have no
         authoritative capacity or licence category yet, and guessing one would decide what a
         rider is asked to carry on a fabricated number. */
  const vclass = vehicleClasses.canonicalise(driver.vehicleType);
  if (!vclass) {
    return { eligible: false, reason: 'vehicle_class_unknown:' + (driver.vehicleType || 'absent') };
  }
  if (!vehicleClasses.isDispatchEligibleClass(vclass)) {
    return { eligible: false, reason: 'vehicle_class_unpriced:' + vclass };
  }

  return { eligible: true, reason: 'eligible' };
}

/**
 * Join presence candidates against the canonical authority.
 *
 * @param db        Firestore (Admin SDK)
 * @param candidates [{ uid, ...presence }] — from the availability shard. UNTRUSTED.
 * @returns { riders: [...], refused: [{ uid, reason }] }
 *
 * Identity and capability fields on the returned rider are taken from `drivers`, NOT from the
 * presence record: `vehicleType` decides which payloads a rider can win, so reading it from a
 * client-writable document would let an account claim a lorry's capacity. Only genuine device
 * telemetry — location, online flag, battery, signal — is taken from the shard.
 */
/* `_evaluate` is a TEST SEAM, and it exists for a specific reason. The `!drv` guard below is a
   second layer behind evaluate()'s own `!driver` check, so while evaluate() is correct the guard
   is unobservable — sabotaging it away broke no test. A defence-in-depth layer that cannot be
   asserted independently is indistinguishable from dead code the next person deletes. Passing a
   permissive evaluator lets the suite prove the guard refuses on its own. Production never
   passes this argument. */
async function filterEligible(db, candidates, _evaluate) {
  const check = typeof _evaluate === 'function' ? _evaluate : evaluate;
  const riders = [];
  const refused = [];
  if (!candidates || !candidates.length) return { riders, refused };

  const uids = candidates.map((c) => c.uid);
  /* Two batched getAll calls rather than 2N serial gets. */
  const [driverSnaps, verSnaps] = await Promise.all([
    db.getAll(...uids.map((u) => db.collection('drivers').doc(u))),
    db.getAll(...uids.map((u) => db.collection('driverVerification').doc(u))),
  ]);
  const driverMap = {};
  driverSnaps.forEach((s) => { if (s.exists) driverMap[s.id] = s.data(); });
  const verMap = {};
  verSnaps.forEach((s) => { if (s.exists) verMap[s.id] = s.data(); });

  for (const c of candidates) {
    const drv = driverMap[c.uid];
    const ver = verMap[c.uid];
    /* Structural guard, independent of evaluate(). Every field below is read off `drv`, so a
       verdict of "eligible" with no driver record would either crash the dispatcher or — worse —
       emit a rider built entirely from client-supplied presence data. Refusing here means no
       single mistake inside evaluate() can produce that, which is the point of defence in
       depth: the check that saves you is the one that did not have to be reasoned about. */
    if (!drv) { refused.push({ uid: c.uid, reason: 'no_driver_record' }); continue; }
    const verdict = check(drv, ver);
    if (!verdict.eligible) { refused.push({ uid: c.uid, reason: verdict.reason }); continue; }
    riders.push({
      /* authority + capability — server-controlled */
      uid: c.uid,
      name: drv.name || 'Rider',
      phone: drv.phone || drv.phoneNumber || '',
      /* The token scoreRider understands, translated explicitly — see vehicle-classes.dispatchKey.
         Non-null by construction: evaluate() already refused any class without a capacity. */
      vehicleType: vehicleClasses.dispatchKey(drv.vehicleType),
      hubId: drv.hubId || null,
      rating: drv.rating,
      acceptanceRate: drv.acceptanceRate,
      /* presence telemetry — client-supplied, non-authoritative */
      lat: c.lat,
      lng: c.lng,
      isOnline: c.isOnline === true || c.online === true,
      activeDeliveries: c.activeDeliveries || 0,
      battery: c.battery,
      networkStrength: c.networkStrength,
      /* `status` is deliberately NOT copied from the shard. scoreRider() treats
         status === 'break' as unavailable, and a client-writable status must not be able to
         reach the scorer at all. Break state belongs on the canonical record. */
      status: drv.status === 'break' ? 'break' : undefined,
    });
  }
  return { riders, refused };
}

module.exports = { evaluate, filterEligible, ELIGIBLE_STATUSES, VERIFIED_STATUSES };
