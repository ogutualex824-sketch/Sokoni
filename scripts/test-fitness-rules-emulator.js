#!/usr/bin/env node
/* test-fitness-rules-emulator.js — FITNESS memberships + F0-R containment at the Firestore client boundary (2026-10-03).
 *
 *   firebase emulators:exec --only firestore --project demo-fitness-rules "node scripts/test-fitness-rules-emulator.js"
 *   (merged combined file:  RULES_FILE=<path> … same command)
 *
 * STATUS: WRITTEN, **QUEUED — NOT RUN.** Host free RAM ≈270 MB on 2026-10-03, below the 512 MB emulator floor. No
 * result of this suite exists yet; nothing here may be quoted as a pass until it has been run.
 *
 * LOCALHOST ONLY: `demo-` project ids; refuses to start unless FIRESTORE_EMULATOR_HOST is 127.0.0.1 / localhost.
 * No firebase-admin, no credentials: @firebase/rules-unit-testing talks to the emulator only.
 *
 * TWO RULESETS, ONE PROCESS (mirrors scripts/test-takedown-rules.js on rules/takedown-enforcement-on-served):
 *   CANDIDATE  firestore.rules.fitness-candidate (or RULES_FILE) — every row must PASS
 *   CONTROL    firestore.rules.served-f259c0b5 — the gap rows must show the gap, proving the candidate's results come
 *              from the change and not from the harness.
 *
 * NAMED ROWS
 *   M1  member get + list(where buyerUid==me) of OWN membership            → ALLOWED
 *   M2  member get of ANOTHER member's membership                           → DENIED; unconstrained list → DENIED
 *   M3  gym get + list(where providerId==me) of OWN gym's memberships       → ALLOWED
 *   M4  gym get of ANOTHER gym's membership; list(where providerId==other)  → DENIED
 *   M5  staff (signed-in, staff claim, not the providerId) direct read       → DENIED (staff = callables only)
 *   M6  member reads OWN attendance (get + list); other member              → ALLOWED / DENIED
 *   M7  gym reads attendance of own membership; other gym                   → ALLOWED / DENIED
 *   M8  events + releases: member DENIED; own gym ALLOWED; admin ALLOWED; other gym DENIED
 *   M9  every protected-field write on the membership (price, priceCents, paymentStatus, status, attendedSessions,
 *       refundEligible, releasedCents, providerId, buyerUid) by member, gym AND admin client → DENIED;
 *       client create (member, gym) → DENIED; delete (member, gym, admin) → DENIED
 *   M10 client create in attendance / events / releases (member, gym, admin) → DENIED
 *   M11 fitnessMembershipClaims: read + write DENIED for member, gym, admin
 *   M12 fitness_bookings/classes/clubs/equipment/requests/challenges/checkins/community_posts:
 *       client create with the payload the SERVED rule accepted → DENIED; owner update/delete → DENIED;
 *       non-admin get → DENIED; anon list → DENIED; admin get → ALLOWED
 *   M13 fitness_gyms: owner edits name/hours → ALLOWED; owner writes rating / members / verified / status /
 *       moderationStatus → DENIED; create carrying rating → DENIED; plain create → ALLOWED
 *   M14 fitness_progress: owner read/write → ALLOWED; another user → DENIED (unchanged, user-private)
 *   M15 providerPayouts (sourceType 'membership'): gym reads OWN row → ALLOWED; gym reads ANOTHER gym's row → DENIED;
 *       member/buyer reads payout rows → DENIED; list where providerId==me → ALLOWED; gym client write → DENIED;
 *       admin read → ALLOWED
 *   M16 providers/{uid}.business owner edit → DENIED. NOTE: this lock is f3's hunk (rules/capability-decisions-on-
 *       f20be7d), NOT in the standalone fitness candidate. The row auto-detects the lock in RULES_FILE: on the merged
 *       combined file it must PASS; on the standalone candidate it prints OPEN-ON-THIS-FILE and is NOT counted as a pass.
 *   C1–C5 CONTROL on served f259c0b5:
 *       C1 client mints fitness_bookings{status:'confirmed'} → SUCCEEDS (D-3 live)
 *       C2 owner self-stamps fitness_gyms rating:5 → SUCCEEDS (D-14 live)
 *       C3 member get of own providerMemberships → DENIED (no rule served: the candidate's grant is the change)
 *       C4 anon reads fitness_classes → SUCCEEDS (D-5 live)
 *       C5 gym reads own payout row → SUCCEEDS (unchanged served behaviour)
 */
'use strict';
const fs = require('fs'), path = require('path');
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  console.error('REFUSED: FIRESTORE_EMULATOR_HOST must be a localhost emulator (got "' + host + '"). Run via firebase emulators:exec.');
  process.exit(2);
}
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, deleteDoc, updateDoc, collection, getDocs, query, where, limit } = require('firebase/firestore');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE = process.env.RULES_FILE || 'firestore.rules.fitness-candidate';
const SERVED = 'firestore.rules.served-f259c0b5';
let pass = 0, fail = 0, open = 0;
const ck = (l, ok) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l); ok ? pass++ : fail++; };
const ok = (p) => assertSucceeds(p).then(() => true).catch(() => false);
const no = (p) => assertFails(p).then(() => true).catch(() => false);
const all = async (ps) => { for (const p of ps) if (!(await p())) return false; return true; };

const MEMBER = 'uMember', MEMBER2 = 'uMember2', GYM = 'uGym', GYM2 = 'uGym2', STAFF = 'uStaff', ADMIN = 'uAdmin';
const membership = (buyerUid, providerId, extra) => Object.assign({
  providerId, buyerUid, priceCents: 300000, periodCount: 1, periodUnit: 'month', startAt: 1, category: 'fitness',
  title: 'Monthly', serviceId: 's1', createdAt: 1, paymentStatus: 'paid_held', status: 'active',
  attendedSessions: 0, refundEligible: true, releasedPeriods: 0, releasedCents: 0,
}, extra || {});
const LEGACY = {
  fitness_bookings: (u) => ({ type: 'class', provider: 'x', ref: 'r', uid: u, status: 'confirmed', ts: 1 }),
  fitness_classes: (u) => ({ name: 'HIIT', type: 'hiit', instructor: 'i', phone: '0700', uid: u, ts: 1 }),
  fitness_clubs: (u) => ({ name: 'Runners', type: 'run', uid: u, ts: 1 }),
  fitness_equipment: (u) => ({ uid: u, ts: 1 }),
  fitness_requests: (u) => ({ text: 'need trainer', uid: u, ts: 1 }),
  fitness_challenges: (u) => ({ uid: u, pts: 10 }),
  fitness_checkins: (u) => ({ memberName: 'A', gymUid: u, ts: 1 }),
  fitness_community_posts: (u) => ({ uid: u, ts: 1, text: 'hi' }),
};

async function seed(env) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'providerMemberships', 'm1'), membership(MEMBER, GYM));
    await setDoc(doc(db, 'providerMemberships', 'm2'), membership(MEMBER2, GYM2));
    for (const [m, buyer, gym] of [['m1', MEMBER, GYM], ['m2', MEMBER2, GYM2]]) {
      await setDoc(doc(db, 'providerMemberships', m, 'attendance', 'a1'),
        { membershipId: m, memberUid: buyer, providerId: gym, sessionRef: 's', checkedInAt: 1, method: 'qr', actorUid: gym, actorRole: 'owner', status: 'checked_in', correlationId: 'c' });
      await setDoc(doc(db, 'providerMemberships', m, 'events', 'e1'), { type: 'payment_held', at: 1 });
      await setDoc(doc(db, 'providerMemberships', m, 'releases', 'r1'), { period: 1, cents: 0, at: 1 });
    }
    await setDoc(doc(db, 'fitnessMembershipClaims', 'h1'), { membershipId: 'm1' });
    for (const [c, f] of Object.entries(LEGACY)) await setDoc(doc(db, c, 'seed'), f(MEMBER));
    await setDoc(doc(db, 'fitness_gyms', GYM), { uid: GYM, name: 'Gym', hours: '6-22' });
    await setDoc(doc(db, 'fitness_progress', MEMBER), { weight: 70 });
    await setDoc(doc(db, 'providerPayouts', 'p1'), { providerId: GYM, sourceType: 'membership', sourceId: 'm1', amountCents: 100 });
    await setDoc(doc(db, 'providerPayouts', 'p2'), { providerId: GYM2, sourceType: 'membership', sourceId: 'm2', amountCents: 100 });
    await setDoc(doc(db, 'providers', GYM), { uid: GYM, status: 'active', category: 'gym', name: 'Gym' });
  });
}
function ctxs(env) {
  const A = { deactivated: false };
  return {
    member: env.authenticatedContext(MEMBER, A).firestore(),
    member2: env.authenticatedContext(MEMBER2, A).firestore(),
    gym: env.authenticatedContext(GYM, A).firestore(),
    gym2: env.authenticatedContext(GYM2, A).firestore(),
    staff: env.authenticatedContext(STAFF, { ...A, staff: true, providerId: GYM }).firestore(),
    admin: env.authenticatedContext(ADMIN, { ...A, admin: true }).firestore(),
    anon: env.unauthenticatedContext().firestore(),
  };
}
const ruleEnv = (id, file) => initializeTestEnvironment({ projectId: id,
  firestore: { rules: fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8'), host: host.split(':')[0], port: Number(host.split(':')[1]) } });

(async () => {
  const env = await ruleEnv('demo-fitness-rules', CANDIDATE);
  await seed(env);
  const c = ctxs(env);
  const PM = (db, id) => doc(db, 'providerMemberships', id);
  const sub = (db, id, s, d) => doc(db, 'providerMemberships', id, s, d);
  console.log('\nCANDIDATE: ' + CANDIDATE);

  ck('M1 member get + list(buyerUid==me) own membership → ALLOWED', await all([
    () => ok(getDoc(PM(c.member, 'm1'))),
    () => ok(getDocs(query(collection(c.member, 'providerMemberships'), where('buyerUid', '==', MEMBER), limit(20))))]));
  ck('M2 member get of another member\'s membership → DENIED; unconstrained list → DENIED', await all([
    () => no(getDoc(PM(c.member, 'm2'))),
    () => no(getDocs(query(collection(c.member, 'providerMemberships'), limit(20))))]));
  ck('M3 gym get + list(providerId==me) own memberships → ALLOWED', await all([
    () => ok(getDoc(PM(c.gym, 'm1'))),
    () => ok(getDocs(query(collection(c.gym, 'providerMemberships'), where('providerId', '==', GYM), limit(20))))]));
  ck('M4 gym get of another gym\'s membership / list(providerId==other) → DENIED', await all([
    () => no(getDoc(PM(c.gym, 'm2'))),
    () => no(getDocs(query(collection(c.gym, 'providerMemberships'), where('providerId', '==', GYM2), limit(20))))]));
  ck('M5 staff direct read (membership, attendance, list) → DENIED', await all([
    () => no(getDoc(PM(c.staff, 'm1'))), () => no(getDoc(sub(c.staff, 'm1', 'attendance', 'a1'))),
    () => no(getDocs(query(collection(c.staff, 'providerMemberships'), where('providerId', '==', GYM), limit(20))))]));
  ck('M6 member reads own attendance (get + list) → ALLOWED; other member → DENIED', await all([
    () => ok(getDoc(sub(c.member, 'm1', 'attendance', 'a1'))),
    () => ok(getDocs(collection(c.member, 'providerMemberships', 'm1', 'attendance'))),
    () => no(getDoc(sub(c.member2, 'm1', 'attendance', 'a1')))]));
  ck('M7 gym reads own membership attendance → ALLOWED; other gym → DENIED', await all([
    () => ok(getDoc(sub(c.gym, 'm1', 'attendance', 'a1'))), () => no(getDoc(sub(c.gym2, 'm1', 'attendance', 'a1')))]));
  ck('M8 events/releases: member DENIED, own gym ALLOWED, admin ALLOWED, other gym DENIED', await all(
    ['events', 'releases'].flatMap((s) => {
      const d = s === 'events' ? 'e1' : 'r1';
      return [() => no(getDoc(sub(c.member, 'm1', s, d))), () => ok(getDoc(sub(c.gym, 'm1', s, d))),
        () => ok(getDoc(sub(c.admin, 'm1', s, d))), () => no(getDoc(sub(c.gym2, 'm1', s, d))),
        () => no(getDocs(collection(c.member, 'providerMemberships', 'm1', s)))];
    })));
  const PROTECTED = { price: 1, priceCents: 1, paymentStatus: 'released', status: 'active', attendedSessions: 0,
    refundEligible: true, releasedCents: 999999, providerId: GYM2, buyerUid: MEMBER2 };
  ck('M9 protected-field writes (member, gym, admin client) → DENIED; client create → DENIED; delete → DENIED', await all([
    ...Object.entries(PROTECTED).flatMap(([k, v]) => ['member', 'gym', 'admin'].map((who) => () => no(updateDoc(PM(c[who], 'm1'), { [k]: v })))),
    () => no(setDoc(PM(c.member, 'mNew'), membership(MEMBER, GYM, { paymentStatus: 'paid_held' }))),
    () => no(setDoc(PM(c.gym, 'mNew2'), membership(MEMBER, GYM))),
    () => no(deleteDoc(PM(c.member, 'm1'))), () => no(deleteDoc(PM(c.gym, 'm1'))), () => no(deleteDoc(PM(c.admin, 'm1')))]));
  ck('M10 client create in attendance/events/releases (member, gym, admin) → DENIED', await all(
    ['attendance', 'events', 'releases'].flatMap((s) => ['member', 'gym', 'admin'].map((who) =>
      () => no(setDoc(sub(c[who], 'm1', s, 'x_' + who), { status: 'checked_in', at: 1 }))))));
  ck('M11 fitnessMembershipClaims read + write DENIED (member, gym, admin)', await all(
    ['member', 'gym', 'admin'].flatMap((who) => [() => no(getDoc(doc(c[who], 'fitnessMembershipClaims', 'h1'))),
      () => no(setDoc(doc(c[who], 'fitnessMembershipClaims', 'h_' + who), { membershipId: 'm1' }))])));
  ck('M12 fitness_* legacy: create/update/delete DENIED; non-admin get + anon list DENIED; admin get ALLOWED', await all(
    Object.entries(LEGACY).flatMap(([coll, f]) => [
      () => no(setDoc(doc(c.member, coll, 'new_' + coll), f(MEMBER))),
      () => no(updateDoc(doc(c.member, coll, 'seed'), { ts: 2 })),
      () => no(deleteDoc(doc(c.member, coll, 'seed'))),
      () => no(getDoc(doc(c.member, coll, 'seed'))),
      () => no(getDocs(query(collection(c.anon, coll), limit(5)))),
      () => ok(getDoc(doc(c.admin, coll, 'seed')))])));
  ck('M13 fitness_gyms: owner edits name/hours ALLOWED; rating/members/verified/status/moderationStatus DENIED; create w/ rating DENIED; plain create ALLOWED', await all([
    () => ok(updateDoc(doc(c.gym, 'fitness_gyms', GYM), { name: 'Gym 2', hours: '5-23' })),
    ...['rating', 'members', 'verified', 'status', 'moderationStatus'].map((k) => () => no(updateDoc(doc(c.gym, 'fitness_gyms', GYM), { [k]: k === 'members' ? 500 : (k === 'rating' ? 5 : 'x') }))),
    () => no(setDoc(doc(c.gym2, 'fitness_gyms', GYM2), { uid: GYM2, name: 'G2', rating: 5.0, members: 0 })),
    () => ok(setDoc(doc(c.gym2, 'fitness_gyms', GYM2), { uid: GYM2, name: 'G2', hours: '6-22' }))]));
  ck('M14 fitness_progress: owner read/write ALLOWED; another user DENIED', await all([
    () => ok(getDoc(doc(c.member, 'fitness_progress', MEMBER))), () => ok(updateDoc(doc(c.member, 'fitness_progress', MEMBER), { weight: 69 })),
    () => no(getDoc(doc(c.member2, 'fitness_progress', MEMBER))), () => no(setDoc(doc(c.member2, 'fitness_progress', MEMBER), { weight: 1 }))]));
  ck('M15 providerPayouts membership rows: own gym ALLOWED (get+list); other gym DENIED; buyer DENIED; gym write DENIED; admin ALLOWED', await all([
    () => ok(getDoc(doc(c.gym, 'providerPayouts', 'p1'))),
    () => ok(getDocs(query(collection(c.gym, 'providerPayouts'), where('providerId', '==', GYM), where('sourceType', '==', 'membership'), limit(20)))),
    () => no(getDoc(doc(c.gym, 'providerPayouts', 'p2'))),
    () => no(getDoc(doc(c.member, 'providerPayouts', 'p1'))),
    () => no(getDocs(query(collection(c.member, 'providerPayouts'), where('sourceType', '==', 'membership'), limit(20)))),
    () => no(updateDoc(doc(c.gym, 'providerPayouts', 'p1'), { amountCents: 999999 })),
    () => no(setDoc(doc(c.gym, 'providerPayouts', 'pNew'), { providerId: GYM, sourceType: 'membership', amountCents: 1 })),
    () => ok(getDoc(doc(c.admin, 'providerPayouts', 'p2')))]));
  const rulesText = fs.readFileSync(path.isAbsolute(CANDIDATE) ? CANDIDATE : path.join(ROOT, CANDIDATE), 'utf8');
  const hasBusinessLock = /match \/providers\/\{providerId\} \{[\s\S]*?'approved', 'business'\]/.test(rulesText);
  const m16 = await no(updateDoc(doc(c.gym, 'providers', GYM), { business: { category: 'gym', lane: 'services' } }));
  if (hasBusinessLock) ck('M16 providers.business owner edit → DENIED (f3 lock present in this file)', m16);
  else { open++; console.log('  OPEN  M16 providers.business owner edit → ' + (m16 ? 'denied' : 'ALLOWED') + ' — OPEN-ON-THIS-FILE: the lock is f3\'s hunk; run on the merged combined file'); }
  await env.cleanup();

  /* ── CONTROL: the SERVED ruleset ── */
  const env2 = await ruleEnv('demo-fitness-rules-served', SERVED);
  await seed(env2);
  const s = ctxs(env2);
  console.log('\nCONTROL (served f259c0b5): the gap rows must show the gap');
  ck("C1 served: client mints fitness_bookings{status:'confirmed'} → SUCCEEDS (D-3 live)", await ok(setDoc(doc(s.member, 'fitness_bookings', 'b_ctl'), LEGACY.fitness_bookings(MEMBER))));
  ck('C2 served: owner self-stamps fitness_gyms rating:5 → SUCCEEDS (D-14 live)', await ok(updateDoc(doc(s.gym, 'fitness_gyms', GYM), { rating: 5 })));
  ck('C3 served: member get of own providerMemberships → DENIED (no served rule; the grant is the change)', await no(getDoc(doc(s.member, 'providerMemberships', 'm1'))));
  ck('C4 served: anon reads fitness_classes → SUCCEEDS (D-5 live)', await ok(getDoc(doc(s.anon, 'fitness_classes', 'seed'))));
  ck('C5 served: gym reads own payout row → SUCCEEDS (unchanged)', await ok(getDoc(doc(s.gym, 'providerPayouts', 'p1'))));
  await env2.cleanup();

  console.log(`\n${pass} passed, ${fail} failed${open ? ', ' + open + ' OPEN (not counted as pass)' : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a result):', e && e.message); process.exit(3); });
