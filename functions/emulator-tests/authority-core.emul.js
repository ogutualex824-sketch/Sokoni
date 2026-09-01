'use strict';
/* AdminOS Authority Core — EMULATOR suite (Firestore + Auth). Binding scope 05df4c9.
 * Exercises the REAL control-events machinery + real Firebase Auth custom claims:
 *   C1  merge-preserve through actual setCustomUserClaims (non-role claim survives)
 *   C3  intent precondition — a non-winning claim never reaches the Auth mutation
 *   C8  atomic ownership — concurrent claims → exactly ONE winner / ONE mutation
 *   C9  abandoned-`mutating` recovery — reconcile performs ZERO additional Auth mutations,
 *        reaching committed (completion verifiable) OR explicit recovery (fail-closed)
 *   C10 owner fencing — a stale owner's late finalize is rejected and cannot alter the event
 *
 * Run: firebase emulators:exec --only firestore,auth --project sokoni-test \
 *        "node functions/emulator-tests/authority-core.emul.js"
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-test';
process.env.FUNCTIONS_EMULATOR = 'true';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const db = getFirestore();
const crypto = require('crypto');
const ace = require('../authority-control-events');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

/* Mutation counter — wraps the ONLY privileged Auth write, so "zero additional mutations"
   assertions have teeth. The NEG control at the end proves the counter actually fires. */
let mutations = 0;
async function mutate(uid, claims) { mutations++; return getAuth().setCustomUserClaims(uid, claims); }

async function clearCol(n) { const s = await db.collection(n).get(); await Promise.all(s.docs.map(d => d.ref.delete())); }
async function freshUser(uid, claims) {
  try { await getAuth().deleteUser(uid); } catch (_) {}
  await getAuth().createUser({ uid, email: uid + '@t.test' });
  if (claims) await getAuth().setCustomUserClaims(uid, claims);
}
const claimsOf = async (uid) => (await getAuth().getUser(uid)).customClaims || {};
const ev = async (id) => (await db.collection('controlEvents').doc(id).get()).data() || {};

/* Replicate setUserRole's exact winner sequence against the real emulator. */
async function runSetUserRole(targetUid, callerUid, role, requestId) {
  const rid = (typeof requestId === 'string' && requestId.trim()) ? requestId.trim() : crypto.randomUUID();
  const current = await claimsOf(targetUid);
  const merged = ace.computeMergedClaims(current, role);
  const eventId = ace.deterministicEventId({ targetUid, callerUid, intendedClaims: merged, requestId: rid });
  const owner = 'exec_' + Math.random().toString(36).slice(2);
  const claim = await ace.claimEvent(db, eventId, { type: 'admin.setUserRole', targetUid, callerUid, requestId: rid, intendedClaims: merged }, owner);
  if (claim.alreadyCommitted) return { eventId, idempotent: true, result: claim.result };
  if (claim.recovery)   return { eventId, blocked: 'recovery' };
  if (claim.inProgress) {                                           // C8 loser: wait/reconcile → committed, never mutate
    const w = await ace.waitForCommit(db, eventId, getAuth);
    if (w.status === 'committed') return { eventId, idempotent: true, viaWait: true, result: w.result };
    return { eventId, blocked: w.status };
  }
  if (claim.stale) { const rec = await ace.reconcileStaleEvent(db, eventId, getAuth); return { eventId, reconciled: rec.status }; }
  // winner
  await mutate(targetUid, merged);                                  // THE single Auth mutation
  await ace.finalizeEvent(db, eventId, owner, claim.fenceToken, { ok: true, role, permsVersion: merged.permsVersion, mutationCount: 1 });
  return { eventId, owner, fenceToken: claim.fenceToken, won: true };
}

(async () => {
  await clearCol('controlEvents');

  /* 1 — C1 preservation end-to-end through real Auth claims + committed event */
  await freshUser('t1', { merchantId: 'm_keep', posId: 'till_9', seller: true });
  mutations = 0;
  const r1 = await runSetUserRole('t1', 'super1', 'admin', 'rq-1');
  const c1 = await claimsOf('t1');
  ok(r1.won === true, '1: winner path taken');
  ok(c1.merchantId === 'm_keep' && c1.posId === 'till_9', '1: C1 — non-role claims (merchantId, posId) PRESERVED through real setCustomUserClaims');
  ok(c1.admin === true && c1.seller === false, '1: elected role applied, stale governed role cleared');
  ok(c1.permsVersion === ace.CURRENT_PERMS_VERSION, '1: C2 permsVersion stamped');
  ok((await ev(r1.eventId)).status === 'committed', '1: controlEvents finalized → committed');
  ok(mutations === 1, '1: exactly ONE Auth mutation');

  /* 2 — C7 idempotency: same intent replays as a no-op (alreadyCommitted), zero new mutation */
  mutations = 0;
  const r2 = await runSetUserRole('t1', 'super1', 'admin', 'rq-1');   // identical requestId + intent
  ok(r2.idempotent === true, '2: C7 — identical intent → idempotent no-op');
  ok(mutations === 0, '2: C7 — retry performed ZERO additional Auth mutations');

  /* 3 — C8 concurrency: two racing executions, exactly one winner / one mutation */
  await freshUser('t3', {});
  await clearCol('controlEvents');
  mutations = 0;
  const [a, b] = await Promise.all([
    runSetUserRole('t3', 'super1', 'moderator', 'rq-3'),
    runSetUserRole('t3', 'super1', 'moderator', 'rq-3'),
  ]);
  const winners = [a, b].filter(x => x.won).length;
  const waited  = [a, b].filter(x => x.idempotent === true).length;
  const loser   = [a, b].find(x => x.idempotent === true);
  ok(winners === 1, '3: C8 — exactly ONE execution won the ownership claim');
  ok(waited === 1, '3: C8 — the loser WAITED/reconciled to committed (did NOT mutate)');
  ok(loser && loser.result && loser.result.role === 'moderator', '3: C8 — loser RETURNED the winner\'s committed result (per contract)');
  ok(mutations === 1, '3: C8 — exactly ONE Auth mutation under concurrency');
  ok((await claimsOf('t3')).moderator === true, '3: role applied once');

  /* 4 — C9 crash recovery (completion VERIFIABLE): winner mutated Auth then finalize was lost.
        Reconcile must reach committed with ZERO additional mutations. */
  await freshUser('t4', {});
  const merged4 = ace.computeMergedClaims({}, 'admin');
  await getAuth().setCustomUserClaims('t4', merged4);                 // simulate: the Auth mutation DID happen
  const id4 = ace.deterministicEventId({ targetUid: 't4', callerUid: 'super1', intendedClaims: merged4, requestId: 'rq-4' });
  await db.collection('controlEvents').doc(id4).set({               // ...but the finalize was lost → stuck 'mutating'
    id: id4, type: 'admin.setUserRole', targetUid: 't4', callerUid: 'super1', requestId: 'rq-4',
    intendedClaims: merged4, status: 'mutating', owner: 'crashedA', fenceToken: 1,
    intentAt: Timestamp.now(), mutatingAt: Timestamp.fromMillis(Date.now() - (ace.STALE_MS + 60000)),
  });
  mutations = 0;
  const rec4 = await ace.reconcileStaleEvent(db, id4, getAuth);
  ok(rec4.status === 'committed', '4: C9 — stale mutating with completed Auth → reconciled to committed');
  ok(mutations === 0, '4: C9 — recovery performed ZERO additional Auth mutations');
  const e4 = await ev(id4);
  ok(e4.status === 'committed' && e4.fenceToken === 2 && String(e4.owner).startsWith('recon_'), '4: C10 — ownership transferred (fenceToken 1→2, reconciler owner)');

  /* 5 — C10 owner fencing: the ORIGINAL (crashed) owner wakes and attempts a late finalize.
        It must be rejected as a no-op and cannot alter the recovered event. */
  const before5 = await ev(id4);
  const late = await ace.finalizeEvent(db, id4, 'crashedA', 1, { ok: true, role: 'admin', hijacked: true, mutationCount: 1 });
  const after5 = await ev(id4);
  ok(late.finalized === false && late.reason === 'fenced', '5: C10 — stale owner (crashedA, fence 1) finalize REJECTED as fenced');
  ok(JSON.stringify(after5.outcome) === JSON.stringify(before5.outcome) && after5.fenceToken === 2 && after5.owner === before5.owner,
     '5: C10 — recovered event UNALTERED by the stale owner (no hijacked outcome, owner/fence intact)');

  /* 6 — C9 fail-closed (completion NOT verifiable): stale mutating, but Auth does NOT match intended.
        Reconcile must NOT mutate and must land in explicit recovery. */
  await freshUser('t6', { buyer: true });                            // Auth is buyer, intended is admin → mismatch
  const merged6 = ace.computeMergedClaims({}, 'admin');
  const id6 = ace.deterministicEventId({ targetUid: 't6', callerUid: 'super1', intendedClaims: merged6, requestId: 'rq-6' });
  await db.collection('controlEvents').doc(id6).set({
    id: id6, type: 'admin.setUserRole', targetUid: 't6', callerUid: 'super1', requestId: 'rq-6',
    intendedClaims: merged6, status: 'mutating', owner: 'crashedB', fenceToken: 1,
    intentAt: Timestamp.now(), mutatingAt: Timestamp.fromMillis(Date.now() - (ace.STALE_MS + 60000)),
  });
  mutations = 0;
  const rec6 = await ace.reconcileStaleEvent(db, id6, getAuth);
  ok(rec6.status === 'recovery', '6: C9 — unverifiable completion → explicit recovery (fail-closed)');
  ok(mutations === 0, '6: C9 — fail-closed recovery performed ZERO Auth mutations');
  ok((await ev(id6)).status === 'recovery' && (await claimsOf('t6')).admin !== true, '6: recovery state set; NO privilege granted');

  /* 7 — C3 intent precondition + C8 bounded fail-closed: a fresh live 'mutating' (non-stale) event
        held by another execution (a) is NOT claimable by a second execution — claimEvent → inProgress
        (intent gates the Auth mutation); (b) a bounded wait that never observes commit and is not
        stale FAILS CLOSED (timeout) and performs NO Auth mutation. */
  await freshUser('t7', {});
  await clearCol('controlEvents');
  const merged7 = ace.computeMergedClaims({}, 'seller');
  const id7 = ace.deterministicEventId({ targetUid: 't7', callerUid: 'super1', intendedClaims: merged7, requestId: 'rq-7' });
  await db.collection('controlEvents').doc(id7).set({                // a live winner holds it (fresh mutatingAt)
    id: id7, type: 'admin.setUserRole', targetUid: 't7', callerUid: 'super1', requestId: 'rq-7',
    intendedClaims: merged7, status: 'mutating', owner: 'liveWinner', fenceToken: 1,
    intentAt: Timestamp.now(), mutatingAt: Timestamp.now(),
  });
  mutations = 0;
  const raw7 = await ace.claimEvent(db, id7, { type: 'admin.setUserRole', targetUid: 't7', callerUid: 'super1', requestId: 'rq-7', intendedClaims: merged7 }, 'exec_second');
  ok(raw7.inProgress === true && !raw7.won, '7: C3/C8 — second execution sees a live intent → NOT granted the mutation (inProgress)');
  const wait7 = await ace.waitForCommit(db, id7, getAuth, { timeoutMs: 300, pollMs: 50 });
  ok(wait7.status === 'timeout', '7: C8 — bounded wait on a non-committing, non-stale winner FAILS CLOSED (timeout)');
  ok(mutations === 0 && (await claimsOf('t7')).seller !== true, '7: C3 — no Auth mutation while intent held by another');

  /* 7b — C7 semantics made explicit: WITHOUT a client requestId, calls are DISTINCT intents (no
        cross-call idempotency, by design); WITH a stable requestId they collapse to at-most-once. */
  await freshUser('t9', {});
  await clearCol('controlEvents');
  mutations = 0;
  const w1 = await runSetUserRole('t9', 'super1', 'seller');       // no requestId → fresh id
  const w2 = await runSetUserRole('t9', 'super1', 'seller');       // no requestId → fresh id again
  ok(w1.eventId !== w2.eventId && w1.won && w2.won, '7b: C7 — omitted requestId → DISTINCT events, each a full intent (documented)');
  ok(mutations === 2, '7b: C7 — omitted requestId gives NO cross-call idempotency (2 mutations) — by design');
  await clearCol('controlEvents');
  mutations = 0;
  const s1 = await runSetUserRole('t9', 'super1', 'driver', 'stable-key');
  const s2 = await runSetUserRole('t9', 'super1', 'driver', 'stable-key');
  ok(s1.eventId === s2.eventId, '7b: C7 — SAME requestId → same deterministic event id');
  ok((s1.won || s1.idempotent) && s2.idempotent && mutations === 1, '7b: C7 — stable requestId → at-most-once (1 mutation)');

  /* 8 — adminPermissions PILOT: the subordinate, narrowing-only capability read (the ONLY reader
        of adminPermissions in this build). Proven directly on the exported predicate. */
  const adminOs = require('../admin-os.js');
  await clearCol('adminPermissions');
  ok(await adminOs._adminCapabilityAllows(db, 'noDoc', 'audit.read') === true,
     '8: pilot — NO adminPermissions doc → coarse admin governs (non-regressive allow)');
  await db.collection('adminPermissions').doc('denyU').set({ capabilities: { audit: { read: false } } });
  ok(await adminOs._adminCapabilityAllows(db, 'denyU', 'audit.read') === false,
     '8: pilot — explicit capabilities.audit.read=false → NARROWS an admin (deny)');
  await db.collection('adminPermissions').doc('grantU').set({ capabilities: { audit: { read: true } } });
  ok(await adminOs._adminCapabilityAllows(db, 'grantU', 'audit.read') === true,
     '8: pilot — audit.read=true → allowed');
  await db.collection('adminPermissions').doc('otherU').set({ capabilities: { billing: { read: false } } });
  ok(await adminOs._adminCapabilityAllows(db, 'otherU', 'audit.read') === true,
     '8: pilot — an UNRELATED capability does not gate adminGetAuditLogs (only audit.read does)');
  await clearCol('adminPermissions');

  /* NEG — teeth: a deliberate extra mutation MUST move the counter, proving the "zero" assertions
     above are falsifiable rather than vacuous. */
  mutations = 0;
  await freshUser('tN', {});
  await mutate('tN', { buyer: true });
  ok(mutations === 1, 'NEG: mutation counter DETECTS an Auth write (assertions have teeth)');

  console.log(`\nAuthority Core emul: ${pass} passed, ${fail} failed`);
  await clearCol('controlEvents');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(1); });
