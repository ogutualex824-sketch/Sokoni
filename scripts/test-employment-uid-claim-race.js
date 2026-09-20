#!/usr/bin/env node
/* UID OCCUPANCY UNIQUENESS — REAL concurrency, against the Firestore emulator.
 * Gate 3 mechanism #1. ADR-035 §4.
 *
 *   firebase emulators:exec --only firestore --project sokoni-uid-claim-race \
 *     "node scripts/test-employment-uid-claim-race.js"
 *
 * WHY THIS RUNS AGAINST AN EMULATOR
 * A test that calls acceptance twice in sequence proves nothing about a race.
 * The whole question is what Firestore does when N transactions contend, so the
 * transactions must actually contend. Every acceptance below is fired with
 * Promise.all against a live emulator — no mocks, no stubs, no simulated
 * ordering. The in-process suite (test-employment-invites.js) SERIALISES
 * transactions and says so; it can prove the claim is enforced, never that it
 * serialises contention.
 *
 * THE THREE OBLIGATIONS, kept separate
 *   1 SERIALIZATION   the claim is the NEWLY shared document. Two acceptances
 *                     for DIFFERENT employments in one business share nothing
 *                     else — §0 proves that directly, so §1's single winner is
 *                     attributable to the claim and not to incidental overlap.
 *   2 LOSER SIDE EFFECTS  read back from FIRESTORE: the losing employment is
 *                     uid:null / pending / workStatus:null, its invite is still
 *                     pending, and no invite_accepted event exists for it.
 *                     A caught ALREADY_EXISTS earns no credit on its own — the
 *                     money-path harness found eight callers each reporting
 *                     success over a ledger holding eight rows.
 *   3 REAL CONTENTION this file REFUSES TO RUN without FIRESTORE_EMULATOR_HOST.
 *
 * 1 AND 2 ARE SEPARATE PROPERTIES WITH SEPARATE ENFORCERS, and conflating them
 * is the likely future mistake. UNIQUENESS is enforced by CONTENTION ON THE
 * CLAIM — create() refuses the second writer. LOSER-SIDE-EFFECT FREEDOM is
 * enforced by the claim living INSIDE THE SAME TRANSACTION as the employment
 * mutation — the abort takes the staff update, the invite update and the event
 * with it. Move the claim to after the commit and uniqueness still holds: one
 * claim exists, the second create still fails, every count in §1 still reads
 * correctly. Only the loser's Firestore state exposes it, and the sabotage that
 * does exactly this goes RED on that and nothing else. A maintainer who sees
 * "exactly one claim exists" and concludes the mechanism is atomic has read
 * obligation 1 and skipped obligation 2.
 *
 * SCOPE — mechanism #1 only. Termination, claim release, reinstatement and
 * uid_rebound have no code path (ADR-035 §4 boundary), so nothing here pretends
 * to exercise them.
 */
'use strict';

const path = require('path');
/* firebase-admin lives in functions/node_modules, not at the repo root —
   resolved explicitly, the same way test-order-claim-race.js does it. */
const FN = path.join(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('\n  REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is not set.\n' +
    '  This suite must contend against a real Firestore. A run that happens to\n' +
    '  pass sequentially is not evidence of concurrency safety. Run it via:\n' +
    '    firebase emulators:exec --only firestore --project sokoni-uid-claim-race \\\n' +
    '      "node scripts/test-employment-uid-claim-race.js"\n');
  process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-uid-claim-race' });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = t => console.log('\n' + t);

const INV = require(path.join(FN, 'employment-invites.js'));

const BIZ = 'SOK-RACE', BIZ2 = 'SOK-OTHER';
const OWNER = 'u_owner', EMP = 'u_emp', EMAIL = 'jane@example.com';
const asOwner = { uid: OWNER, token: { email: 'owner@example.com' } };
const asInvitee = { uid: EMP, token: { email: EMAIL } };

async function wipe () {
  for (const c of ['hrStaff', 'employmentInvites', 'employmentEvents', 'employmentUidClaims',
                   'businesses']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
}
async function seedBusiness (biz) {
  await db.collection('businesses').doc(biz).set({ ownerId: OWNER, adminUids: [] });
}
/** A PENDING employment, exactly as addStaffMember writes one. */
async function seedStaff (biz, empNo) {
  const id = `${biz}_${empNo}`;
  await db.collection('hrStaff').doc(id).set({
    merchantId: biz, employeeNumber: empNo, name: 'Jane ' + empNo, email: EMAIL,
    employmentStatus: 'pending', workStatus: null, uid: null,
  });
  return id;
}
const call = (fn, auth, data) =>
  fn({ auth, data }).then(out => ({ out, code: null }))
                    .catch(e => ({ out: null, code: e.code || 'throw', msg: e.message }));

const staffOf = id => db.collection('hrStaff').doc(id).get().then(s => s.data());
const inviteOf = t => db.collection('employmentInvites').doc(t).get().then(s => s.data());
const claimsAll = () => db.collection('employmentUidClaims').get()
  .then(s => s.docs.map(d => Object.assign({ _id: d.id }, d.data())));
const acceptedEventsFor = id => db.collection('employmentEvents')
  .where('staffId', '==', id).where('event', '==', 'invite_accepted').get()
  .then(s => s.size);

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  UID OCCUPANCY UNIQUENESS — REAL CONCURRENCY');
  console.log('  ' + process.env.FIRESTORE_EMULATOR_HOST);
  console.log('══════════════════════════════════════════════════════════════════');

  /* ══ 0. THE CLAIM IS THE NEWLY SHARED DOCUMENT ═════════════════════════════
     Attribution, before any result is claimed. Section 1 shows exactly one
     acceptance survives; that number only means something if the claim is WHY.
     If the two transactions already contended on something else, the same
     number would appear with no claim at all and the suite would prove nothing.

     So this section runs the acceptance transaction WITHOUT the claim — same
     reads, same writes — and shows BOTH commit. An executable control, not an
     argument that they ought to be disjoint. */
  head('0 - control: WITHOUT the claim, the two transactions do not contend');
  {
    await wipe(); await seedBusiness(BIZ);
    const a = await seedStaff(BIZ, 'E001');
    const b = await seedStaff(BIZ, 'E002');
    const ta = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: a, reason: 'x' })).out.token;
    const tb = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: b, reason: 'x' })).out.token;

    const ia = await inviteOf(ta), ib = await inviteOf(tb);
    ck('the two employments are distinct', ia.staffId !== ib.staffId, ia.staffId + ' / ' + ib.staffId);
    ck('  …and read distinct invitations', ta !== tb);
    ck('  …yet the SAME organization and the SAME invitee address',
       ia.businessId === ib.businessId && ia.email === ib.email);
    ck('  …so both resolve to ONE claim id',
       INV.claimId(ia.businessId, EMP) === INV.claimId(ib.businessId, EMP),
       INV.claimId(ia.businessId, EMP));

    /* The acceptance transaction MINUS the claim: the two reads it really
       performs, the two writes it really performs. */
    const noClaim = (tok) => db.runTransaction(async (t) => {
      const iRef = db.collection('employmentInvites').doc(tok);
      const iSnap = await t.get(iRef);
      const sRef = db.collection('hrStaff').doc(iSnap.data().staffId);
      await t.get(sRef);
      t.update(sRef, { uid: EMP, employmentStatus: 'active', workStatus: 'working' });
      t.update(iRef, { status: 'accepted' });
      return true;
    }).then(() => null).catch(e => e.code || 'throw');

    const [ca, cb] = await Promise.all([noClaim(ta), noClaim(tb)]);
    ck('CONTROL: both claimless transactions COMMIT — nothing else serialises them',
       ca === null && cb === null, ca + ' / ' + cb);
    ck('CONTROL: the invariant is genuinely violated without the claim',
       (await staffOf(a)).uid === EMP && (await staffOf(b)).uid === EMP);
    ck('CONTROL: and no claim was involved', (await claimsAll()).length === 0);
  }

  /* ══ 1. TEN CONCURRENT ACCEPTANCES, ONE UID, ONE BUSINESS ══════════════════ */
  head('1 - 10 concurrent acceptances, distinct employments, same (business, uid)');
  {
    await wipe(); await seedBusiness(BIZ);
    const ids = [], tokens = [];
    for (let i = 1; i <= 10; i++) {
      const id = await seedStaff(BIZ, 'E' + String(i).padStart(3, '0'));
      ids.push(id);
      tokens.push((await call(INV._h.sendEmploymentInvite, asOwner, { staffId: id, reason: 'x' })).out.token);
    }

    /* THE RACE. */
    const results = await Promise.all(
      tokens.map(t => call(INV._h.acceptEmploymentInvite, asInvitee, { token: t, reason: 'racing' })));

    const wins = results.filter(r => r.code === null);
    const losses = results.filter(r => r.code !== null);
    ck('exactly ONE acceptance succeeded', wins.length === 1, wins.length + ' wins');
    ck('  …and the other nine were refused', losses.length === 9, losses.length + ' losses');
    ck('  …every loss is the expected uniqueness refusal',
       losses.every(l => l.code === 'failed-precondition'),
       [...new Set(losses.map(l => l.code))].join(','));

    /* ── FIRESTORE STATE, not return values. ── */
    const staff = await Promise.all(ids.map(staffOf));
    const active = staff.filter(s => s.employmentStatus === 'active');
    ck('FIRESTORE: exactly ONE employment is active', active.length === 1,
       active.length + ' active of ' + staff.length);
    ck('FIRESTORE: exactly ONE employment carries a uid',
       staff.filter(s => s.uid !== null).length === 1);

    const winner = active[0];
    ck('WINNER: uid is the invitee', winner.uid === EMP, String(winner.uid));
    ck('WINNER: employmentStatus active', winner.employmentStatus === 'active');
    ck('WINNER: workStatus working', winner.workStatus === 'working', String(winner.workStatus));
    const winnerId = `${BIZ}_${winner.employeeNumber}`;
    const winnerTok = tokens[ids.indexOf(winnerId)];
    ck('WINNER: its invitation is accepted',
       (await inviteOf(winnerTok)).status === 'accepted');
    ck('WINNER: exactly one invite_accepted event', (await acceptedEventsFor(winnerId)) === 1);

    /* ── THE LOSERS, each one read back individually. ── */
    const loserIds = ids.filter(i => i !== winnerId);
    const loserStaff = await Promise.all(loserIds.map(staffOf));
    ck('LOSERS: uid is still null on all nine',
       loserStaff.every(s => s.uid === null),
       loserStaff.filter(s => s.uid !== null).length + ' bound');
    ck('LOSERS: employmentStatus still pending',
       loserStaff.every(s => s.employmentStatus === 'pending'),
       [...new Set(loserStaff.map(s => s.employmentStatus))].join(','));
    ck('LOSERS: workStatus still null', loserStaff.every(s => s.workStatus === null));
    const loserInvites = await Promise.all(
      loserIds.map(i => inviteOf(tokens[ids.indexOf(i)])));
    ck('LOSERS: every invitation is still pending',
       loserInvites.every(v => v.status === 'pending'),
       [...new Set(loserInvites.map(v => v.status))].join(','));
    const loserEvents = await Promise.all(loserIds.map(acceptedEventsFor));
    ck('LOSERS: NO invite_accepted event exists for any of them',
       loserEvents.every(n => n === 0), loserEvents.join(','));

    /* ── THE CLAIM. ── */
    const claims = await claimsAll();
    ck('exactly ONE occupancy claim exists', claims.length === 1, claims.length + '');
    ck('  …keyed {businessId}_{uid}', claims[0]._id === `${BIZ}_${EMP}`, claims[0]._id);
    ck('  …provenance names the WINNING staffId', claims[0].staffId === winnerId,
       claims[0].staffId + ' vs ' + winnerId);
    /* EXACT SET, not containment, and DELIBERATELY STRICTER THAN THE ADR.
       ADR-035 §4 PERMITS immutable provenance; it does not grant the claim an
       open schema. So this assertion is a CHANGE-DETECTION GATE, not a
       reinterpretation of the invariant: today's approved provenance schema is
       exactly these four fields, and any additional provenance field — mutable
       or immutable — must be reviewed through the ADR rather than arrive
       silently. Enumerating forbidden names instead would catch an accidental
       new MUTABLE field and miss an accidental new immutable one. */
    ck('  …fields are EXACTLY the approved provenance set (ADR change gate)',
       Object.keys(claims[0]).filter(k => k !== '_id').sort().join(',')
         === 'businessId,createdAt,staffId,uid',
       Object.keys(claims[0]).filter(k => k !== '_id').sort().join(','));
    ck('  …NO status or lifecycle field',
       claims[0].status === undefined && claims[0].employmentStatus === undefined
       && claims[0].released === undefined && claims[0].workStatus === undefined);
  }

  /* ══ 2. THE INVARIANT IS PER ORGANIZATION ══════════════════════════════════ */
  head('2 - the same uid across DIFFERENT businesses');
  {
    await wipe(); await seedBusiness(BIZ); await seedBusiness(BIZ2);
    const a = await seedStaff(BIZ, 'E001');
    const b = await seedStaff(BIZ2, 'E001');
    const ta = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: a, reason: 'x' })).out.token;
    const tb = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: b, reason: 'x' })).out.token;

    const [ra, rb] = await Promise.all([
      call(INV._h.acceptEmploymentInvite, asInvitee, { token: ta, reason: 'x' }),
      call(INV._h.acceptEmploymentInvite, asInvitee, { token: tb, reason: 'x' }),
    ]);
    ck('BOTH acceptances succeed', ra.code === null && rb.code === null,
       ra.code + ' / ' + rb.code);
    ck('FIRESTORE: both employments are active and bound',
       (await staffOf(a)).uid === EMP && (await staffOf(b)).uid === EMP);
    const claims = await claimsAll();
    ck('TWO claims exist, one per business', claims.length === 2, claims.length + '');
    ck('  …with distinct ids',
       new Set(claims.map(c => c._id)).size === 2, claims.map(c => c._id).join(' | '));
  }

  /* ══ 2b. THE CLAIM IS PER UID, NOT PER BUSINESS ════════════════════════════
     The invariant is one employment per PERSON per organization — not one
     employment per organization. A claim keyed on businessId alone would
     satisfy every assertion in §1 and §2 while refusing an organization its
     second employee. The legitimate path has to be tested too: a hostile-only
     suite passes a guard that refuses everybody. */
  head('2b - a SECOND, DIFFERENT person in the same business');
  {
    await wipe(); await seedBusiness(BIZ);
    const a = await seedStaff(BIZ, 'E001');
    const b = await seedStaff(BIZ, 'E002');
    /* A different invitee, so a different email on the second record. */
    const EMP2 = 'u_emp2', EMAIL2 = 'sam@example.com';
    await db.collection('hrStaff').doc(b).update({ email: EMAIL2 });
    const ta = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: a, reason: 'x' })).out.token;
    const tb = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: b, reason: 'x' })).out.token;
    const as2 = { uid: EMP2, token: { email: EMAIL2 } };

    const [ra, rb] = await Promise.all([
      call(INV._h.acceptEmploymentInvite, asInvitee, { token: ta, reason: 'x' }),
      call(INV._h.acceptEmploymentInvite, as2, { token: tb, reason: 'x' }),
    ]);
    ck('BOTH succeed — the business may employ two people', ra.code === null && rb.code === null,
       ra.code + ' / ' + rb.code);
    ck('FIRESTORE: both employments are active',
       (await staffOf(a)).employmentStatus === 'active' && (await staffOf(b)).employmentStatus === 'active');
    ck('  …each bound to its OWN uid',
       (await staffOf(a)).uid === EMP && (await staffOf(b)).uid === EMP2);
    const claims = await claimsAll();
    ck('TWO claims in ONE business, one per uid', claims.length === 2, claims.length + '');
    ck('  …keyed by uid, not by business alone',
       claims.map(c => c._id).sort().join('|') === [BIZ + '_' + EMP, BIZ + '_' + EMP2].sort().join('|'),
       claims.map(c => c._id).join(' | '));
  }

  /* ══ 3. SAME-INVITE REPLAY UNDER CONCURRENCY ═══════════════════════════════
     Distinct from §1: here the transactions DO share the invite document, so a
     single winner would be explained by invite contention alone. Included
     because it must stay safe, not as evidence about the claim. */
  head('3 - 5 concurrent acceptances of the SAME invitation');
  {
    await wipe(); await seedBusiness(BIZ);
    const a = await seedStaff(BIZ, 'E001');
    const t = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: a, reason: 'x' })).out.token;
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      call(INV._h.acceptEmploymentInvite, asInvitee, { token: t, reason: 'replay' })));
    ck('exactly one succeeds', rs.filter(r => r.code === null).length === 1,
       rs.filter(r => r.code === null).length + '');
    ck('FIRESTORE: one claim, one active employment',
       (await claimsAll()).length === 1 && (await staffOf(a)).employmentStatus === 'active');
    ck('FIRESTORE: exactly one invite_accepted event', (await acceptedEventsFor(a)) === 1);
  }

  /* ══ 4. A LOSING TRANSACTION LEAVES NOTHING — SEQUENTIAL, FOR CLARITY ══════ */
  head('4 - a refused acceptance writes nothing at all');
  {
    await wipe(); await seedBusiness(BIZ);
    const a = await seedStaff(BIZ, 'E001');
    const b = await seedStaff(BIZ, 'E002');
    const ta = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: a, reason: 'x' })).out.token;
    const tb = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: b, reason: 'x' })).out.token;
    await call(INV._h.acceptEmploymentInvite, asInvitee, { token: ta, reason: 'first' });

    const before = JSON.stringify({
      staff: await staffOf(b), invite: await inviteOf(tb),
      events: await acceptedEventsFor(b), claims: (await claimsAll()).length,
    });
    const r = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: tb, reason: 'second' });
    const after = JSON.stringify({
      staff: await staffOf(b), invite: await inviteOf(tb),
      events: await acceptedEventsFor(b), claims: (await claimsAll()).length,
    });
    ck('the second acceptance is refused', r.code === 'failed-precondition', r.code);
    ck('  …and the world around it is byte-identical', before === after);
    ck('  …still one claim, naming the FIRST employment',
       (await claimsAll()).length === 1 && (await claimsAll())[0].staffId === a);
  }

  /* ══ 5. AN UNEXPECTED ERROR IS RE-RAISED, NOT LAUNDERED ════════════════════
     The loser handler must not turn every failure into the uniqueness refusal.
     A collision and a vanished employment are different facts, and a caller
     told the wrong one retries the wrong thing. Distinguished by MESSAGE, not
     by code — both are failed-precondition, so the code alone proves nothing. */
  head('5 - only a real collision produces the uniqueness refusal');
  {
    await wipe(); await seedBusiness(BIZ);
    const a = await seedStaff(BIZ, 'E001');
    const t = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: a, reason: 'x' })).out.token;
    /* An unrelated failure, inside the same transaction: the employment
       disappears between send and accept. */
    await db.collection('hrStaff').doc(a).delete();
    const r = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: t, reason: 'x' });
    ck('the acceptance fails', r.code !== null, String(r.code));
    ck('  …and does NOT wear the uniqueness message',
       !/already holds an active employment/i.test(String(r.msg || '')), r.msg);
    ck('  …no claim was created for a binding that never happened',
       (await claimsAll()).length === 0, (await claimsAll()).length + '');

    /* POSITIVE CONTROL — the matcher above must be able to fire. An absence
       assertion with no inverting control is a detector that may simply be
       unable to match. */
    await wipe(); await seedBusiness(BIZ);
    const c = await seedStaff(BIZ, 'E001'), d = await seedStaff(BIZ, 'E002');
    const tc = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: c, reason: 'x' })).out.token;
    const td = (await call(INV._h.sendEmploymentInvite, asOwner, { staffId: d, reason: 'x' })).out.token;
    await call(INV._h.acceptEmploymentInvite, asInvitee, { token: tc, reason: 'x' });
    const coll = await call(INV._h.acceptEmploymentInvite, asInvitee, { token: td, reason: 'x' });
    ck('INVERTING CONTROL: a REAL collision DOES wear that message',
       /already holds an active employment/i.test(String(coll.msg || '')), coll.msg);
  }



  console.log('\n  what this suite does NOT prove');
  console.log('  SEPARATE  termination, claim release, reinstatement and uid_rebound have NO');
  console.log('            code path (ADR-035 §4 boundary). Their claim rules are consumer');
  console.log('            contracts for mechanisms #5/#7, not unwritten parts of #1.');
  console.log('  NOTE      an accepted employment\'s claim is therefore NOT RELEASABLE by any');
  console.log('            existing path. That is the stated dependency boundary, not a leak.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
