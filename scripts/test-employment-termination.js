#!/usr/bin/env node
/* MECHANISM #8 — ACCEPTED-EMPLOYMENT TERMINATION. Stage 5 certification.
 *
 *   firebase emulators:exec --only firestore --project sokoni-employment-term \
 *     "node scripts/test-employment-termination.js"
 *
 * ADR-035 §4 + "Mechanism numbering, and the termination assignment".
 *
 * WHY THE EMULATOR. #8 is a transaction whose correctness is mostly about what
 * happens when it does NOT commit. Stubbing the transaction would make every
 * negative case pass by construction, and `admin.firestore` is a prototype
 * getter whose stub assignment can fail silently — the documented way to
 * certify a module while quietly hitting production. Real SDK, real emulator,
 * real aborts.
 *
 * THE FIVE REFUSALS THE CONTRACT NAMES, each asserted from FIRESTORE STATE and
 * not from a return value:
 *     already terminated · missing uid · mismatched claim.staffId ·
 *     MISSING CLAIM · a claim belonging to another employment
 *
 * The missing-claim case is the one that cannot be delegated to `delete()`:
 * `t.delete()` on an absent document, and on another employment's document,
 * BOTH SUCCEED SILENTLY. Only the read-then-verify distinguishes them, so §5
 * below proves the claim is read and compared rather than blind-deleted.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('\n  REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is not set.\n' +
    '  #8 is a transaction; its refusals must be proven against a real one. Run:\n' +
    '    firebase emulators:exec --only firestore --project sokoni-employment-term \\\n' +
    '      "node scripts/test-employment-termination.js"\n');
  process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-employment-term' });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 84) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = t => console.log('\n' + t);

const TERM = require(path.join(FN, 'employment-termination.js'));
const INV = require(path.join(FN, 'employment-invites.js'));

/* Comment-stripped source, for the assertions that are ABOUT the code. */
const strip = f => fs.readFileSync(path.join(FN, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const BIZ = 'SOK-TERM', OWNER = 'u_owner', EMP = 'u_emp', OTHER = 'u_other';
const asOwner = { uid: OWNER, token: { email: 'owner@example.com' } };
const asAdminUid = { uid: 'u_admin', token: {} };
const asPlatform = { uid: 'u_plat', token: { admin: true } };

async function wipe () {
  for (const c of ['hrStaff', 'employmentUidClaims', 'employmentEvents', 'businesses']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
}
const seedBiz = () => db.doc('businesses/' + BIZ).set({ ownerId: OWNER, adminUids: ['u_admin'] });

/** An ACTIVE, bound employment plus its occupancy claim — the post-#1 state. */
async function seedActive (empNo, uid) {
  const id = `${BIZ}_${empNo}`;
  await db.doc('hrStaff/' + id).set({
    merchantId: BIZ, employeeNumber: empNo, name: 'Jane ' + empNo,
    email: 'jane@example.com', employmentStatus: 'active', workStatus: 'working', uid,
  });
  await db.doc(`employmentUidClaims/${BIZ}_${uid}`).set({
    businessId: BIZ, uid, staffId: id, createdAt: new Date(),
  });
  return id;
}
const call = (auth, data) =>
  TERM._h.terminateEmployment({ auth, data })
    .then(out => ({ out, code: null }))
    .catch(e => ({ out: null, code: e.code || 'throw', msg: e.message }));

const staffOf = id => db.doc('hrStaff/' + id).get().then(s => s.data());
const claimOf = uid => db.doc(`employmentUidClaims/${BIZ}_${uid}`).get();
const eventsFor = id => db.collection('employmentEvents')
  .where('staffId', '==', id).where('event', '==', 'employment_terminated').get();

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  MECHANISM #8 — ACCEPTED-EMPLOYMENT TERMINATION');
  console.log('  ' + process.env.FIRESTORE_EMULATOR_HOST);
  console.log('══════════════════════════════════════════════════════════════════');

  /* ══ 1. THE LEGITIMATE PATH, FIRST ═════════════════════════════════════════
     A hostile-only suite passes a mechanism that refuses everybody. */
  head('1 - an active, bound employment terminates');
  {
    await wipe(); await seedBiz();
    const id = await seedActive('E001', EMP);
    const r = await call(asOwner, { staffId: id, reason: 'resigned' });
    ck('terminated', r.code === null, r.code || r.msg);
    ck('  …returns the terminationId', !!(r.out && r.out.terminationId), r.out && r.out.terminationId);

    const s = await staffOf(id);
    ck('FIRESTORE: employmentStatus = terminated', s.employmentStatus === 'terminated', s.employmentStatus);
    ck('FIRESTORE: workStatus = null', s.workStatus === null, String(s.workStatus));
    ck('FIRESTORE: uid is RETAINED — the identity binding survives', s.uid === EMP, String(s.uid));
    ck('  …and provenance is recorded', !!s.terminatedAt && s.terminatedBy === OWNER);

    ck('FIRESTORE: the occupancy claim is GONE', !(await claimOf(EMP)).exists);

    const ev = await eventsFor(id);
    ck('FIRESTORE: exactly one employment_terminated event', ev.size === 1, ev.size + '');
    const p = ev.docs[0].data();
    ck('  …previousStatus active/working, newStatus terminated/null',
       p.previousStatus.employmentStatus === 'active' && p.newStatus.employmentStatus === 'terminated'
       && p.newStatus.workStatus === null);
    ck('  …the event id carries the terminationId',
       ev.docs[0].id === `${id}_terminated_${r.out.terminationId}`, ev.docs[0].id);
    ck('  …uid is NOT recorded as rebound (retention is not a rebinding)',
       p.previousUid === null && p.newUid === null,
       'prev=' + p.previousUid + ' new=' + p.newUid);
  }

  /* ══ 2. THE UID IS RELEASED — the whole point of deleting the claim ════════ */
  head('2 - the released uid can be employed again');
  {
    await wipe(); await seedBiz();
    const a = await seedActive('E001', EMP);
    await call(asOwner, { staffId: a, reason: 'x' });
    ck('claim released', !(await claimOf(EMP)).exists);

    /* Mechanism #1's create() must now succeed for a NEW employment. */
    const b = `${BIZ}_E002`;
    await db.doc('hrStaff/' + b).set({
      merchantId: BIZ, employeeNumber: 'E002', employmentStatus: 'pending', workStatus: null, uid: null,
    });
    let reacquired = false;
    try {
      await db.doc(`employmentUidClaims/${BIZ}_${EMP}`).create({
        businessId: BIZ, uid: EMP, staffId: b, createdAt: new Date(),
      });
      reacquired = true;
    } catch (_) { reacquired = false; }
    ck('a NEW employment can acquire the same uid — #1 create() succeeds', reacquired);
    ck('  CONTROL: and is refused while still held', await (async () => {
      try { await db.doc(`employmentUidClaims/${BIZ}_${EMP}`)
              .create({ businessId: BIZ, uid: EMP, staffId: 'x', createdAt: new Date() });
            return false; } catch (_) { return true; }
    })());
  }

  /* ══ 3. THE FIVE REFUSALS ══════════════════════════════════════════════════ */
  head('3 - the five refusals the contract names');
  {
    /* 3a — already terminated: the REPLAY guard. */
    await wipe(); await seedBiz();
    const a = await seedActive('E001', EMP);
    const first = await call(asOwner, { staffId: a, reason: 'first' });
    ck('CONTROL: the first termination succeeded', first.code === null);
    const replay = await call(asOwner, { staffId: a, reason: 'replay' });
    /* THE CODE ALONE CANNOT DISCRIMINATE. After a successful termination the
       CLAIM IS ALSO GONE, so a replay would hit the missing-claim guard and
       throw the SAME failed-precondition. Sabotage M5 removed the active gate
       and this assertion stayed green. Assert WHICH guard fired. */
    ck('ALREADY TERMINATED is refused BY THE ACTIVE GATE',
       replay.code === 'failed-precondition' && /is 'terminated', not 'active'/.test(replay.msg || ''),
       replay.msg);
    ck('  …and NO second event was written', (await eventsFor(a)).size === 1);

    /* 3b — missing uid. */
    await wipe(); await seedBiz();
    const b = `${BIZ}_E001`;
    await db.doc('hrStaff/' + b).set({
      merchantId: BIZ, employeeNumber: 'E001', employmentStatus: 'active', workStatus: 'working', uid: null,
    });
    const nb = await call(asOwner, { staffId: b, reason: 'x' });
    /* Same discrimination problem: uid '' yields claimId(biz,'') which is
       absent, so the missing-claim guard would also refuse. Sabotage M6. */
    ck('MISSING UID is refused BY THE UID GATE',
       nb.code === 'failed-precondition' && /bound to no uid/.test(nb.msg || ''), nb.msg);
    ck('  …the employment is untouched', (await staffOf(b)).employmentStatus === 'active');

    /* 3c — MISSING CLAIM. The case delete() cannot detect. */
    await wipe(); await seedBiz();
    const c = await seedActive('E001', EMP);
    await db.doc(`employmentUidClaims/${BIZ}_${EMP}`).delete();   /* claim gone */
    const nc = await call(asOwner, { staffId: c, reason: 'x' });
    ck('MISSING CLAIM is refused BY THE EXISTENCE GATE',
       nc.code === 'failed-precondition' && /holds no occupancy claim/.test(nc.msg || ''), nc.msg);
    ck('  …the employment is STILL ACTIVE — no partial termination',
       (await staffOf(c)).employmentStatus === 'active');
    ck('  …and no event was written', (await eventsFor(c)).size === 0);

    /* 3d — claim.staffId mismatch (same business, wrong employment). */
    await wipe(); await seedBiz();
    const d = await seedActive('E001', EMP);
    await db.doc(`employmentUidClaims/${BIZ}_${EMP}`)
      .set({ businessId: BIZ, uid: EMP, staffId: `${BIZ}_E999`, createdAt: new Date() });
    const nd = await call(asOwner, { staffId: d, reason: 'x' });
    ck('MISMATCHED claim.staffId is refused BY THE OWNERSHIP GATE',
       nd.code === 'failed-precondition' && /belongs to a different employment/.test(nd.msg || ''), nd.msg);
    ck('  …the employment is STILL ACTIVE', (await staffOf(d)).employmentStatus === 'active');
    ck('  …and the OTHER employment\'s claim SURVIVES — not collateral-deleted',
       (await claimOf(EMP)).exists);

    /* 3e — a claim belonging to ANOTHER real employment. Distinct from 3d:
       here the named employment genuinely exists and is active, so a
       blind delete would revoke a live occupancy. */
    await wipe(); await seedBiz();
    const victim = await seedActive('E002', EMP);          /* holds the claim */
    const attacker = `${BIZ}_E001`;
    await db.doc('hrStaff/' + attacker).set({
      merchantId: BIZ, employeeNumber: 'E001', employmentStatus: 'active',
      workStatus: 'working', uid: EMP,                     /* same uid, no claim of its own */
    });
    const ne = await call(asOwner, { staffId: attacker, reason: 'x' });
    ck('A CLAIM OWNED BY ANOTHER EMPLOYMENT is refused BY THE OWNERSHIP GATE',
       ne.code === 'failed-precondition' && /belongs to a different employment/.test(ne.msg || ''), ne.msg);
    ck('  …the victim\'s claim SURVIVES', (await claimOf(EMP)).exists);
    ck('  …the victim is STILL ACTIVE', (await staffOf(victim)).employmentStatus === 'active');
    ck('  …and the caller\'s own employment was not terminated either',
       (await staffOf(attacker)).employmentStatus === 'active');
  }

  /* ══ 4. AUTHORITY — §2's owner boundary ════════════════════════════════════ */
  head('4 - ending employment is OWNER authority');
  {
    await wipe(); await seedBiz();
    const id = await seedActive('E001', EMP);
    const adm = await call(asAdminUid, { staffId: id, reason: 'x' });
    ck('a business ADMIN (adminUids) is refused', adm.code === 'permission-denied', adm.code);
    ck('  …the employment is untouched', (await staffOf(id)).employmentStatus === 'active');
    const str = await call({ uid: OTHER, token: {} }, { staffId: id, reason: 'x' });
    ck('a stranger is refused', str.code !== null, str.code);

    /* THE ORGANIZATION IS RECORD-ANCHORED, NOT REQUEST-SUPPLIED. Without this
       fixture nothing supplies req.data.businessId, so a handler that trusted
       it would never be exercised — sabotage M12 was INERT for exactly that
       reason. The stranger owns SOK-OTHER and names it, trying to authorize
       against their own organization while acting on this one's employment. */
    await db.doc('businesses/SOK-OTHER').set({ ownerId: OTHER, adminUids: [] });
    const forged = await call({ uid: OTHER, token: {} },
      { staffId: id, reason: 'x', businessId: 'SOK-OTHER', merchantId: 'SOK-OTHER' });
    ck('a FORGED businessId in the request is ignored — authority is record-anchored',
       forged.code === 'permission-denied', forged.code + ' ' + (forged.msg || ''));
    ck('  …and the employment is untouched', (await staffOf(id)).employmentStatus === 'active');

    const plat = await call(asPlatform, { staffId: id, reason: 'platform action' });
    ck('a PLATFORM admin may terminate (ADR-035 §2a)', plat.code === null, plat.code || plat.msg);
    ck('  …recorded as changedVia platform',
       (await eventsFor(id)).docs[0].data().changedVia === 'platform');
  }

  /* ══ 5. terminationId IS MINTED BEFORE THE TRANSACTION ═════════════════════
     The contract's concurrency invariant. Asserted on STRIPPED source because
     the module's own comments discuss the forbidden placement by name — an
     unstripped check would read the explanation as the violation. */
  head('5 - terminationId is generated ONCE, before runTransaction');
  {
    const src = strip('employment-termination.js');
    const gen = src.indexOf('crypto.randomUUID()');
    const txn = src.indexOf('db.runTransaction');
    ck('crypto.randomUUID() appears BEFORE db.runTransaction',
       gen > -1 && txn > -1 && gen < txn, 'gen@' + gen + ' txn@' + txn);
    ck('  …and NOT inside the transaction callback',
       src.slice(txn).indexOf('randomUUID') === -1);
    ck('  …exactly one generation site', (src.match(/randomUUID\(\)/g) || []).length === 1);
    /* POSITIVE CONTROL — the position test must be able to fail. */
    const fake = 'db.runTransaction(async t => { const id = crypto.randomUUID(); })';
    ck('CONTROL: the detector FIRES on generation inside the callback',
       fake.indexOf('crypto.randomUUID()') > fake.indexOf('db.runTransaction'));
    ck('CONTROL: the stripper left code intact', /runTransaction/.test(src) && src.length > 2000);
  }

  /* ══ 6. THE CLAIM IS READ AND VERIFIED, NOT BLIND-DELETED ═════════════════ */
  head('6 - the claim is read and compared before deletion');
  {
    const src = strip('employment-termination.js');
    ck('the claim is READ inside the transaction', /t\.get\(claimRef\)/.test(src));
    ck('  …its staffId is COMPARED to this employment', /claimStaffId !== staffId/.test(src));
    ck('  …and only then deleted', /t\.delete\(claimRef\)/.test(src));
    const del = src.indexOf('t.delete(claimRef)');
    const cmp = src.indexOf('claimStaffId !== staffId');
    ck('  …the comparison precedes the delete', cmp > -1 && del > -1 && cmp < del);
    ck('CONTROL: a bare-delete implementation would fail this',
       !/t\.get\(claimRef\)/.test('t.delete(claimRef);'));
  }

  /* ══ 7. SCOPE — #8 owns ONE transition ════════════════════════════════════ */
  head('7 - #8 does not absorb the neighbouring axes');
  {
    const src = strip('employment-termination.js');
    ck('no on_leave / suspended write', !/'on_leave'|'suspended'/.test(src));
    ck('no shopEmployees reference', !/shopEmployees/.test(src));
    ck('no shop-assignment revocation', !/shopId/.test(src));
    ck('no payroll or payability logic', !/runPayroll|payslip|grossSalary/i.test(src));
    ck('revokeEmploymentInvite is NOT extended',
       !/revokeEmploymentInvite/.test(src) &&
       !/_requirePendingEmployment/.test(strip('employment-termination.js')));
    ck('CONTROL: the forbidden matchers CAN fire',
       /'on_leave'/.test("const x = 'on_leave';") && /shopEmployees/.test('shopEmployees'));
    ck('not re-exported from index.js — unreachable in production, by convention',
       !/employment-termination/.test(fs.readFileSync(path.join(FN, 'index.js'), 'utf8')));
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  SEPARATE  reinstatement, uid_rebound, work status (#5/#6) and shop');
  console.log('            assignment (#7) have no implementation and are not #8\'s.');
  console.log('  NOTE      #8 is NOT exported from functions/index.js — the whole');
  console.log('            employment workstream is unwired. Nothing is deployed.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
