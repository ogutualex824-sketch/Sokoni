'use strict';
/* SUSPENSION LIFECYCLE — reinstatement must clear the flag the dispatch gate reads.
 *
 *   node scripts/test-suspension-lifecycle.js
 *
 * THE DEFECT
 * `projectDriver` is symmetric in intent and asymmetric in fact. Retraction writes
 * `suspendedAt`; re-approval writes `status:'active'`, `approved:true` and a fresh `approvedAt`
 * — and left `suspendedAt` exactly where it was. `rider-eligibility` is the ONLY authoritative
 * reader of that field and refuses on it BEFORE it looks at verification, so a reinstated driver
 * was refused as `suspended` with an approval timestamp a full day newer than the suspension.
 * Measured in production, not inferred: one live driver, suspended 2026-08-04, re-approved
 * 2026-08-05, still carrying the flag.
 *
 * WHY THE SUITE IS SHAPED LIKE THIS
 * 1. It drives the REAL `projectDriver` and the REAL `rider-eligibility.evaluate`. A suite that
 *    reimplements either measures the reimplementation. The only stub is Firestore itself.
 * 2. Both projections are asserted SEPARATELY (A4 drivers, A5 rideDrivers). They are written by
 *    two adjacent lines, and a fix applied to one is invisible while the other still works.
 * 3. Group B proves the gate still refuses a genuinely suspended driver — including one whose
 *    paperwork is otherwise perfect, so removing the `suspendedAt` read in rider-eligibility
 *    turns this suite red rather than leaving it green.
 * 4. Group C carries the positive control. A gate that refuses everybody is not a fix, so one
 *    fully-documented driver must come out ELIGIBLE after reinstatement.
 * 5. Group D audits the harness. `FieldValue.delete()` is a TRUTHY sentinel object: a fake store
 *    that failed to resolve it would leave `suspendedAt` set and the suite would go red — D1
 *    proves that is what happens, so a green A4 means the field is really gone.
 *
 * SCOPE NOTE — the lifecycle driver in group A deliberately does NOT become dispatchable.
 * The production census established that record is missing nationalId, dlNumber and vehicleType.
 * Clearing suspension removes ONE independent blocker; it does not confer eligibility. A7 asserts
 * the refusal MOVES ON to the next check rather than asserting success this fix cannot deliver.
 *
 * NOT PROVEN HERE: that the Firestore backend accepts `FieldValue.delete()` inside a merge-set.
 * This harness models those semantics, it cannot certify them. That acceptance rests on the OB-5
 * precedent at application-lifecycle.js:506, which ships the identical shape to production. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { FieldValue } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
const AL = require(path.join(ROOT, 'functions', 'application-lifecycle'))._internal;
const elig = require(path.join(ROOT, 'functions', 'rider-eligibility'));

/* Both are documented singletons; identity comparison is how the fake store recognises them.
   Asserted rather than assumed — C1 below re-checks it, because if a future firebase-admin
   returned fresh instances the fake would silently stop resolving them. */
const DELETE = FieldValue.delete();
const STAMP = FieldValue.serverTimestamp();
/* Identity is the primary test and D1 asserts it holds. The structural fallback exists so that
   if a future firebase-admin ever hands back fresh instances, the store keeps modelling Firestore
   correctly instead of silently storing a truthy sentinel and blaming the production fix. */
const isDelete = (v) => v === DELETE || !!(v && v.constructor && v.constructor.name === 'DeleteTransform');
const isStamp = (v) => v === STAMP || !!(v && v.constructor && v.constructor.name === 'ServerTimestampTransform');

const EXPECTED_CASES = 27;
let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
/* Fail closed: a case that throws is a FAILED case, never an absent one. */
const ckt = (label, fn, detail) => {
  try { ck(label, fn() === true, typeof detail === 'function' ? detail() : detail); }
  catch (e) { ck(label, false, 'THREW: ' + e.message); }
};

/* ── Firestore stub: the exact surface projectDriver uses, with real merge semantics ─────── */
function makeStore(seed) {
  const docs = new Map(Object.entries(seed || {}));
  const audit = [];
  /* Deterministic monotonic clock, so "approval is newer than suspension" is a fact of the
     fixture and not a race against the wall clock. */
  let clock = Date.UTC(2026, 7, 4, 9, 0, 0);
  let resolve = true;

  const apply = (key, data, merge) => {
    const cur = merge ? Object.assign({}, docs.get(key)) : {};
    Object.keys(data).forEach((k) => {
      const v = data[k];
      if (resolve && isDelete(v)) { delete cur[k]; return; }
      if (resolve && isStamp(v)) { cur[k] = new Date(clock += 1000); return; }
      cur[k] = v;
    });
    docs.set(key, cur);
  };

  return {
    db: {
      collection: (c) => ({
        doc: (id) => ({
          path: c + '/' + id,
          get: async () => ({ id, exists: docs.has(c + '/' + id), data: () => docs.get(c + '/' + id) }),
        }),
      }),
      batch: () => {
        const ops = [];
        return {
          set: (ref, data, opts) => ops.push([ref.path, data, !!(opts && opts.merge)]),
          commit: async () => ops.forEach((o) => { audit.push({ path: o[0], data: o[1] }); apply(o[0], o[1], o[2]); }),
        };
      },
    },
    get: (k) => docs.get(k),
    has: (k) => docs.has(k),
    audit,
    disableSentinelResolution: () => { resolve = false; },
  };
}

let provisionCalls = 0;
const OPTS = { ensureBusiness: async () => { provisionCalls++; return { created: true, merchantId: 'SOK-TEST1' }; } };

const verdict = (s, uid) => elig.evaluate(s.get('drivers/' + uid), s.get('driverVerification/' + uid));

/* The census record's shape: an application carrying none of the identifiers. */
const THIN_APP = { applicationId: 'APP-THIN', name: 'Census Rider', phone: '0712345678' };
/* A complete one — every field `missing[]` checks for. */
const FULL_APP = {
  applicationId: 'APP-FULL', name: 'Complete Rider', phone: '0722000111',
  nationalId: '12345678', dlNumber: 'DL-889900', dlExpiry: '2030-01-01',
  plate: 'KDA123A', vehicleType: 'motorcycle', city: 'Nairobi',
};

(async () => {
  console.log('\nSUSPENSION LIFECYCLE — projectDriver reinstatement vs rider-eligibility\n');

  /* ── A. The lifecycle the census actually found ───────────────────────────────────────── */
  console.log('A - approved -> suspended -> re-approved (the production sequence)');
  const S = makeStore();
  const UID = 'census-rider';

  await AL.projectDriver(S.db, THIN_APP, UID, true, OPTS);
  ckt('A1 first approval writes both projections and NO suspension flag',
    () => S.has('drivers/' + UID) && S.has('rideDrivers/' + UID)
       && S.get('drivers/' + UID).suspendedAt === undefined
       && S.get('rideDrivers/' + UID).suspendedAt === undefined,
    () => 'approved=' + S.get('drivers/' + UID).approved);

  await AL.projectDriver(S.db, THIN_APP, UID, false, OPTS);
  ckt('A2 retraction sets suspendedAt on BOTH projections',
    () => !!S.get('drivers/' + UID).suspendedAt && !!S.get('rideDrivers/' + UID).suspendedAt,
    () => 'drivers.status=' + S.get('drivers/' + UID).status);

  const suspendedVerdict = verdict(S, UID);
  /* Retraction writes BOTH `status:'suspended'` and `suspendedAt`, and rider-eligibility checks
     status BEFORE the flag — so this refusal is carried by the status layer, not by the flag.
     That is exactly why the flag's own load-bearing proof cannot live here: it must run on a
     fixture whose status is already eligible. That fixture is the LIVE record's shape — status
     restored on reinstatement, flag left behind — and it is B3/B4 below. */
  ckt('A3 a retracted driver is refused by the real gate (status layer fires first)',
    () => suspendedVerdict.eligible === false && suspendedVerdict.reason === 'status_not_eligible:suspended',
    () => suspendedVerdict.reason);

  const suspendedAtValue = S.get('drivers/' + UID).suspendedAt;
  await AL.projectDriver(S.db, THIN_APP, UID, true, OPTS);

  ckt('A4 re-approval CLEARS suspendedAt on drivers/{uid}',
    () => S.get('drivers/' + UID).suspendedAt === undefined
       && !('suspendedAt' in S.get('drivers/' + UID)),
    () => 'value now: ' + String(S.get('drivers/' + UID).suspendedAt));

  /* Separate assertion on purpose — one line fixed and one line missed is the failure mode a
     combined assertion cannot see. rideDrivers is what dispatch reads for presence. */
  ckt('A5 re-approval CLEARS suspendedAt on rideDrivers/{uid} (per-layer, not combined)',
    () => S.get('rideDrivers/' + UID).suspendedAt === undefined
       && !('suspendedAt' in S.get('rideDrivers/' + UID)),
    () => 'value now: ' + String(S.get('rideDrivers/' + UID).suspendedAt));

  const afterVerdict = verdict(S, UID);
  ckt('A6 the gate no longer refuses this driver for suspension',
    () => afterVerdict.reason !== 'suspended', () => afterVerdict.reason);

  /* The scope boundary, asserted rather than assumed: clearing suspension advances the driver to
     the NEXT blocker. This driver stays undispatchable because the identifiers are absent. */
  ckt('A7 refusal MOVES ON to verification — still not dispatchable, and that is correct',
    () => afterVerdict.eligible === false && /^verification_incomplete/.test(afterVerdict.reason),
    () => afterVerdict.reason);

  ckt('A8 reinstatement preserves approved:true and status active',
    () => S.get('drivers/' + UID).approved === true && S.get('drivers/' + UID).status === 'active',
    () => 'approved=' + S.get('drivers/' + UID).approved + ' status=' + S.get('drivers/' + UID).status);

  ckt('A9 the approval that cleared the flag is NEWER than the suspension it cleared',
    () => S.get('drivers/' + UID).approvedAt > suspendedAtValue,
    () => 'approvedAt ' + S.get('drivers/' + UID).approvedAt.toISOString());

  /* Atomicity: the clear must ride in the same set() as the approval, not a follow-up write that
     a crash could skip and leave the record approved-and-suspended. */
  const lastDrv = S.audit.filter((w) => w.path === 'drivers/' + UID).pop();
  ckt('A10 the clear is in the SAME batched write as the approval (no second-write window)',
    () => lastDrv.data.suspendedAt === DELETE && lastDrv.data.approved === true,
    () => 'keys: ' + Object.keys(lastDrv.data).length);

  const before = JSON.stringify(S.get('drivers/' + UID).approved) + String(S.get('drivers/' + UID).status);
  await AL.projectDriver(S.db, THIN_APP, UID, true, OPTS);
  ckt('A11 reinstatement is idempotent — a repeat run leaves no suspension flag',
    () => !('suspendedAt' in S.get('drivers/' + UID)) && !('suspendedAt' in S.get('rideDrivers/' + UID))
       && (JSON.stringify(S.get('drivers/' + UID).approved) + String(S.get('drivers/' + UID).status)) === before,
    'second re-approval');

  /* ── B. Regression: a genuinely suspended driver stays out ────────────────────────────── */
  console.log('\nB - a driver who is ACTUALLY suspended remains ineligible');
  const B = makeStore();
  await AL.projectDriver(B.db, FULL_APP, 'genuine', true, OPTS);
  const bEligibleFirst = verdict(B, 'genuine');
  ckt('B1 CONTROL: fully documented + approved = ELIGIBLE (the gate is not refusing everybody)',
    () => bEligibleFirst.eligible === true, () => bEligibleFirst.reason);

  await AL.projectDriver(B.db, FULL_APP, 'genuine', false, OPTS);
  const bSuspended = verdict(B, 'genuine');
  ckt('B2 the SAME fully documented driver, once retracted, is refused',
    () => bSuspended.eligible === false && /suspended/.test(bSuspended.reason), () => bSuspended.reason);

  /* ── The two suspension layers, asserted SEPARATELY ──────────────────────────────────────
     Retraction sets both, so a combined fixture can only ever prove that SOMETHING refused.
     Each layer below is exercised with the other one absent, so removing either read in
     rider-eligibility turns this suite red. B3 is the live record's exact shape. */
  const docs = B.get('driverVerification/genuine');
  const eligibleShape = { uid: 'x', approved: true, status: 'active', vehicleType: 'moto' };

  ckt('B3 FLAG LAYER ALONE: eligible status + stale suspendedAt is still refused "suspended"',
    () => elig.evaluate(Object.assign({}, eligibleShape, { suspendedAt: new Date() }), docs).reason === 'suspended',
    () => elig.evaluate(Object.assign({}, eligibleShape, { suspendedAt: new Date() }), docs).reason);

  ckt('B4 BOOLEAN LAYER ALONE: eligible status + suspended:true is refused independently',
    () => elig.evaluate(Object.assign({}, eligibleShape, { suspended: true }), docs).reason === 'suspended',
    () => elig.evaluate(Object.assign({}, eligibleShape, { suspended: true }), docs).reason);

  ckt('B5 STATUS LAYER ALONE: status suspended with NO flag is still refused',
    () => elig.evaluate(Object.assign({}, eligibleShape, { status: 'suspended' }), docs).reason === 'status_not_eligible:suspended',
    () => elig.evaluate(Object.assign({}, eligibleShape, { status: 'suspended' }), docs).reason);

  /* And the control for all three: the same shape with no suspension signal at all passes. If
     this ever fails, B3-B5 are proving nothing but a gate that refuses everybody. */
  ckt('B6 CONTROL: the identical shape with no suspension signal is ELIGIBLE',
    () => elig.evaluate(eligibleShape, docs).eligible === true, () => elig.evaluate(eligibleShape, docs).reason);

  ckt('B7 suspension outranks complete paperwork (both layers precede the verification check)',
    () => docs.documentsComplete === true && /suspended/.test(bSuspended.reason),
    () => 'documentsComplete=' + docs.documentsComplete);

  /* ── C. Regression: reinstatement is no longer blocked by a stale flag ────────────────── */
  console.log('\nC - a reinstated driver is not rejected merely for a stale flag');
  await AL.projectDriver(B.db, FULL_APP, 'genuine', true, OPTS);
  const bReinstated = verdict(B, 'genuine');
  ckt('C1 suspend -> re-approve restores eligibility for a driver who qualifies',
    () => bReinstated.eligible === true && bReinstated.reason === 'eligible', () => bReinstated.reason);

  /* The live record was written by the OLD code, so it exists as approved-with-a-flag and was
     never produced by the new path. Seed that shape directly and prove the migration works. */
  const L = makeStore({
    'drivers/legacy': {
      uid: 'legacy', approved: true, status: 'active', vehicleType: 'moto',
      suspendedAt: new Date(Date.UTC(2026, 7, 4)), approvedAt: new Date(Date.UTC(2026, 7, 5)),
    },
    'rideDrivers/legacy': { uid: 'legacy', status: 'active', suspendedAt: new Date(Date.UTC(2026, 7, 4)) },
    'driverVerification/legacy': { uid: 'legacy', documentsComplete: true, status: 'verified_on_file' },
  });
  ckt('C2 BEFORE: the legacy shape is refused as suspended despite a NEWER approval',
    () => verdict(L, 'legacy').reason === 'suspended', () => verdict(L, 'legacy').reason);

  await AL.projectDriver(L.db, FULL_APP, 'legacy', true, OPTS);
  ckt('C3 AFTER: re-running approval over the legacy shape clears it in both projections',
    () => !('suspendedAt' in L.get('drivers/legacy')) && !('suspendedAt' in L.get('rideDrivers/legacy')));
  ckt('C4 AFTER: the legacy driver is eligible — the fix is a migration path, not just new writes',
    () => verdict(L, 'legacy').eligible === true, () => verdict(L, 'legacy').reason);

  await AL.projectDriver(L.db, FULL_APP, 'legacy', false, OPTS);
  ckt('C5 retraction still works after a reinstatement (no one-way latch)',
    () => !!L.get('drivers/legacy').suspendedAt && verdict(L, 'legacy').eligible === false,
    () => verdict(L, 'legacy').reason);

  /* ── D. Harness integrity ─────────────────────────────────────────────────────────────── */
  console.log('\nD - the harness itself');
  ckt('D1 FieldValue.delete() is a TRUTHY sentinel — an unresolved one would read as suspended',
    () => !!DELETE && typeof DELETE === 'object' && FieldValue.delete() === DELETE
       && elig.evaluate({ approved: true, status: 'active', suspendedAt: DELETE }, {}).reason === 'suspended',
    DELETE.constructor.name);

  /* So a green A4/A5 is only meaningful if the store really resolves it. Prove the negative. */
  const N = makeStore();
  N.disableSentinelResolution();
  await AL.projectDriver(N.db, THIN_APP, 'nores', true, OPTS);
  await AL.projectDriver(N.db, THIN_APP, 'nores', false, OPTS);
  await AL.projectDriver(N.db, THIN_APP, 'nores', true, OPTS);
  ckt('D2 with sentinel resolution OFF the same lifecycle stays suspended (A4/A5 are load-bearing)',
    () => verdict(N, 'nores').reason === 'suspended', () => verdict(N, 'nores').reason);

  const M = makeStore({ 'drivers/keep': { uid: 'keep', rating: 4.8, completedDeliveries: 42 } });
  await AL.projectDriver(M.db, FULL_APP, 'keep', true, OPTS);
  ckt('D3 merge does not wholesale-replace — an unrelated seeded field survives',
    () => M.get('drivers/keep').rating === 4.8 && M.get('drivers/keep').approved === true,
    () => 'rating=' + M.get('drivers/keep').rating);

  ckt('D4 the suite drove the REAL projection, not a copy',
    () => typeof AL.projectDriver === 'function' && provisionCalls > 0,
    () => 'ensureBusiness calls: ' + provisionCalls);

  /* A suite that crashed halfway would otherwise exit 0 with a short, green-looking list. */
  console.log('\n' + '-'.repeat(72));
  const counted = pass + fail;
  if (counted !== EXPECTED_CASES) {
    console.log('  FAIL  harness: ' + counted + ' cases ran, ' + EXPECTED_CASES + ' expected — suite did not complete');
    fail++;
  }
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack || e); process.exit(1); });
