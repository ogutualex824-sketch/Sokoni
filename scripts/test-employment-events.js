/* ══════════════════════════════════════════════════════════════════════════════
   EMPLOYMENT EVENT BUILDER — Gate 3 mechanism #4
   scripts/test-employment-events.js

   WHAT THIS PINS
   `employmentEvent(o)` returns { ref, payload } and NEVER writes. It is the only
   enforcement point between a caller and the audit record: Firestore rules
   cannot express "and the actor combination is coherent", nor "and this status
   transition matches the event named", and writes are CF-only.

   THIS SUITE PROVES A CONTRACT, NOT A WORKFLOW
   The builder has no caller — every one of the twelve events is performed by a
   mechanism that does not exist yet (#3, #1, #5, #7). So nothing here pretends
   to exercise an employment lifecycle end to end; it proves what the builder
   accepts, what it refuses, and that calling it writes nothing.

   THE CONTROL THAT MAKES THE REFUSALS MEAN ANYTHING
   A validator that rejected everything would pass every rejection test. Section
   1 therefore builds a VALID payload for all twelve events first. If that
   section fails, every refusal below it is unattributable.

   SCOPE
   The builder only. The Firestore rules are certified separately against the
   real rules engine — a rules expression error reads as a working guard and
   cannot be proven by reading source.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

/* ── Stub that RECORDS EVERY OPERATION ────────────────────────────────────
   "The builder never writes" is an observable, not a promise: any set/update/
   add/commit reaching the stub is a failure of the contract. */
let OPS = [];
const docHandle = (coll, id) => ({
  id,
  path: coll + '/' + id,
  set: async () => { OPS.push('set ' + coll + '/' + id); },
  update: async () => { OPS.push('update ' + coll + '/' + id); },
  delete: async () => { OPS.push('delete ' + coll + '/' + id); },
  get: async () => { OPS.push('get ' + coll + '/' + id); return { exists: false }; },
});
const fakeDb = {
  collection: (name) => ({
    doc: (id) => docHandle(name, id),
    add: async () => { OPS.push('add ' + name); },
  }),
  batch: () => ({ set () { OPS.push('batch.set'); }, commit: async () => { OPS.push('batch.commit'); } }),
  runTransaction: async (fn) => fn({ set () { OPS.push('txn.set'); } }),
};
class HttpsError extends Error {
  constructor (code, message) { super(message); this.code = code; }
}
const STUBS = {
  'firebase-admin': (() => {
    const f = () => fakeDb;
    f.FieldValue = { serverTimestamp: () => '__TS__' };
    return { firestore: f, apps: [{}], initializeApp () {} };
  })(),
  'firebase-functions/v2/https': { HttpsError },
};
const realLoad = Module._load;
Module._load = function (r, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, r)) return STUBS[r];
  return realLoad.call(this, r, parent, isMain);
};
let EV = null, loadError = null;
try {
  delete require.cache[require.resolve(path.join(ROOT, 'functions/employment-events.js'))];
  EV = require(path.join(ROOT, 'functions/employment-events.js'));
} catch (e) { loadError = e && e.message ? e.message.slice(0, 160) : 'load failed'; }
Module._load = realLoad;

const SRC = fs.readFileSync(path.join(ROOT, 'functions/employment-events.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── Fixtures ────────────────────────────────────────────────────────────── */
const BIZ = 'SOK-MINE', STAFF = 'SOK-MINE_E001';
const OWNER = 'U_OWNER', EMP = 'U_EMP', OLD_EMP = 'U_EMP_OLD';
const PENDING = { employmentStatus: 'pending', workStatus: null };
const WORKING = { employmentStatus: 'active', workStatus: 'working' };
const ON_LEAVE = { employmentStatus: 'active', workStatus: 'on_leave' };
const SUSPENDED = { employmentStatus: 'active', workStatus: 'suspended' };
const TERMINATED = { employmentStatus: 'terminated', workStatus: null };

const byOwner = { actorType: 'human', changedBy: OWNER, changedVia: 'owner' };
const bySystem = { actorType: 'system', changedBy: null, changedVia: 'system' };

const base = extra => Object.assign(
  { businessId: BIZ, staffId: STAFF, reason: 'because the contract requires one' },
  byOwner, extra);

/** All twelve, each with a payload that MUST be accepted. */
const VALID = {
  employment_established: base({ event: 'employment_established', previousStatus: null, newStatus: PENDING }),
  invite_sent: base({ event: 'invite_sent', previousStatus: PENDING, newStatus: PENDING }),
  invite_accepted: base({ event: 'invite_accepted', previousStatus: PENDING, newStatus: WORKING, newUid: EMP }),
  invite_revoked: base({ event: 'invite_revoked', previousStatus: PENDING, newStatus: TERMINATED }),
  uid_rebound: base({ event: 'uid_rebound', previousStatus: WORKING, newStatus: WORKING, previousUid: OLD_EMP, newUid: EMP, transitionId: 'T1' }),
  leave_granted: base({ event: 'leave_granted', previousStatus: WORKING, newStatus: ON_LEAVE, leaveId: 'L1' }),
  leave_ended: Object.assign(base({ event: 'leave_ended', previousStatus: ON_LEAVE, newStatus: WORKING, leaveId: 'L1' }), bySystem),
  employment_suspended: base({ event: 'employment_suspended', previousStatus: WORKING, newStatus: SUSPENDED, suspensionId: 'S1' }),
  suspension_lifted: base({ event: 'suspension_lifted', previousStatus: SUSPENDED, newStatus: WORKING, suspensionId: 'S1' }),
  employment_terminated: base({ event: 'employment_terminated', previousStatus: SUSPENDED, newStatus: TERMINATED, terminationId: 'X1' }),
  employment_reinstated: base({ event: 'employment_reinstated', previousStatus: TERMINATED, newStatus: WORKING, reinstatementId: 'R1' }),
  record_edited: base({ event: 'record_edited', previousStatus: WORKING, newStatus: WORKING, editId: 'E1' }),
};

function build (o) {
  OPS = [];
  try { return { out: EV.employmentEvent(o), code: null, ops: OPS.slice() }; }
  catch (e) { return { out: null, code: e.code || 'throw', msg: e.message, ops: OPS.slice() }; }
}
const reject = (name, o, why) => {
  const r = build(o);
  ok('REJECTS ' + name, r.code === 'invalid-argument', r.code ? r.code : 'ACCEPTED');
};
const mut = (evt, patch) => Object.assign({}, VALID[evt], patch);

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  EMPLOYMENT EVENT BUILDER — mechanism #4');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - controls');
  ok('the module loaded', loadError === null && !!EV, loadError || '');
  ok('employmentEvent is exported', !!EV && typeof EV.employmentEvent === 'function');
  ok('exactly twelve events are declared',
     !!EV && Object.keys(EV.EVENTS).length === 12, EV ? Object.keys(EV.EVENTS).length + '' : '');
  ok('the collection is employmentEvents', !!EV && EV.COLLECTION === 'employmentEvents',
     EV ? EV.COLLECTION : '');
  ok('every declared event has a fixture',
     !!EV && Object.values(EV.EVENTS).every(e => VALID[e] !== undefined),
     EV ? Object.values(EV.EVENTS).filter(e => !VALID[e]).join(',') || 'all twelve' : '');

  /* ── 1. THE POSITIVE CONTROL ───────────────────────────────────────────── */
  head('1 - all twelve valid payloads are ACCEPTED');
  for (const [evt, payload] of Object.entries(VALID)) {
    const r = build(payload);
    ok('accepts ' + evt, r.code === null && !!r.out, r.code ? r.code + ': ' + r.msg : r.out.ref.path);
  }

  /* ── 2. IT NEVER WRITES ────────────────────────────────────────────────── */
  head('2 - the builder performs no Firestore operation');
  {
    let all = [];
    for (const payload of Object.values(VALID)) all = all.concat(build(payload).ops);
    ok('no set / update / delete / add / commit across all twelve',
       all.length === 0, all.join(',') || 'zero operations recorded');
    const shape = build(VALID.leave_granted).out;
    ok('returns { ref, payload }', !!shape.ref && !!shape.payload && typeof shape.ref.path === 'string');
    ok('CONTROL — the stub CAN record an operation, so zero is meaningful',
       (() => { OPS = []; fakeDb.collection('x').doc('y').set({}); return OPS.length === 1; })());
  }

  /* ── 3. DETERMINISTIC REFERENCES ───────────────────────────────────────── */
  head('3 - the reference is deterministic, and discriminated where it must be');
  {
    const a = build(VALID.employment_established).out.ref.path;
    const b = build(VALID.employment_established).out.ref.path;
    ok('the same input twice yields the same reference', a === b, a);
    ok('a once-per-employment event needs no discriminator',
       a === 'employmentEvents/' + STAFF + '_employment_established', a);
    const l1 = build(VALID.leave_granted).out.ref.path;
    const l2 = build(mut('leave_granted', { leaveId: 'L2' })).out.ref.path;
    ok('a recurring event is discriminated by the id of the thing acted on',
       l1 !== l2 && /_leave_L1_granted$/.test(l1) && /_leave_L2_granted$/.test(l2), l1 + ' vs ' + l2);
    const g = build(VALID.leave_granted).out.ref.path;
    const e = build(VALID.leave_ended).out.ref.path;
    ok('granted and ended for the SAME leave are distinct documents', g !== e, g + ' vs ' + e);
    const paths = Object.values(VALID).map(p => build(p).out.ref.path);
    ok('all twelve produce distinct references', new Set(paths).size === 12, new Set(paths).size + '/12');
  }

  /* ── 4. THE PAYLOAD ────────────────────────────────────────────────────── */
  head('4 - the payload carries exactly the contracted fields');
  {
    const p = build(VALID.uid_rebound).out.payload;
    const want = ['businessId', 'staffId', 'event', 'previousUid', 'newUid', 'previousStatus',
                  'newStatus', 'actorType', 'changedBy', 'changedVia', 'reason', 'at', 'ts'].sort();
    ok('field set is exact', Object.keys(p).sort().join(',') === want.join(','),
       Object.keys(p).sort().join(','));
    ok('both status axes are preserved',
       p.previousStatus.employmentStatus === 'active' && p.previousStatus.workStatus === 'working'
       && p.newStatus.workStatus === 'working');
    ok('previousUid and newUid are both recorded on a rebind',
       p.previousUid === OLD_EMP && p.newUid === EMP);
    ok('the server timestamp is used, not a client clock', p.at === '__TS__');
    ok('reason is trimmed, never empty',
       build(mut('leave_granted', { reason: '  spaced  ' })).out.payload.reason === 'spaced');
    const t = build(VALID.employment_terminated).out.payload;
    ok('a termination records { terminated, null }',
       t.newStatus.employmentStatus === 'terminated' && t.newStatus.workStatus === null);
    const sys = build(VALID.leave_ended).out.payload;
    ok('a system actor records changedBy null, changedVia system',
       sys.actorType === 'system' && sys.changedBy === null && sys.changedVia === 'system');
  }

  /* ── 5. EVENT VOCABULARY ───────────────────────────────────────────────── */
  head('5 - the vocabulary is closed');
  reject('an unknown event type', mut('leave_granted', { event: 'employee_fired' }));
  reject('a missing event type', mut('leave_granted', { event: undefined }));
  reject('a near-miss spelling', mut('leave_granted', { event: 'leave_grant' }));
  /* ISOLATES THE VOCABULARY CHECK. Measured: a sabotage that fell back to the
     record_edited spec for unknown events scored GREEN, because the fixture
     above is leave_granted-shaped and the fallback rejected it on the status
     transition — the right verdict for the wrong reason. This payload is valid
     in every respect EXCEPT its event name, so only the vocabulary check can
     refuse it. */
  reject('an unknown event whose payload is otherwise entirely valid',
         mut('record_edited', { event: 'made_up_event' }));

  /* ── 6. REASON ─────────────────────────────────────────────────────────── */
  head('6 - reason is required (ADR-010: what changed without why)');
  reject('a missing reason', mut('leave_granted', { reason: undefined }));
  reject('an empty reason', mut('leave_granted', { reason: '' }));
  reject('a whitespace-only reason', mut('leave_granted', { reason: '   ' }));
  reject('a non-string reason', mut('leave_granted', { reason: 42 }));

  /* ── 7. THE ACTOR ──────────────────────────────────────────────────────── */
  head('7 - human and system actors cannot drift apart');
  reject('actorType human with changedBy null',
         mut('leave_granted', { actorType: 'human', changedBy: null, changedVia: 'owner' }));
  reject('actorType system with a changedBy uid',
         mut('leave_granted', { actorType: 'system', changedBy: OWNER, changedVia: 'system' }));
  reject("actorType system with changedVia 'owner'",
         mut('leave_granted', { actorType: 'system', changedBy: null, changedVia: 'owner' }));
  reject("actorType human with changedVia 'system'",
         mut('leave_granted', { actorType: 'human', changedBy: OWNER, changedVia: 'system' }));
  reject('an unknown actorType',
         mut('leave_granted', { actorType: 'robot', changedBy: OWNER, changedVia: 'owner' }));
  reject("changedVia 'self' — never employment authority (ADR-035 §2)",
         mut('leave_granted', { changedVia: 'self' }));
  reject("changedVia 'admin' — organization access is not employment authority",
         mut('leave_granted', { changedVia: 'admin' }));
  {
    const r = build(mut('leave_granted', { actorType: 'human', changedBy: OWNER, changedVia: 'platform' }));
    ok("ACCEPTS changedVia 'platform' — ratified 2a", r.code === null, r.code || 'accepted');
  }

  /* ── 8. THE MASQUERADE GUARD ───────────────────────────────────────────── */
  head('8 - record_edited cannot masquerade as a lifecycle event');
  reject('record_edited that moves workStatus',
         mut('record_edited', { previousStatus: WORKING, newStatus: SUSPENDED }));
  reject('record_edited that moves employmentStatus',
         mut('record_edited', { previousStatus: WORKING, newStatus: TERMINATED }));
  reject('record_edited that moves both axes',
         mut('record_edited', { previousStatus: WORKING, newStatus: PENDING }));
  {
    const r = build(VALID.record_edited);
    ok('ACCEPTS record_edited with an unchanged status — an ordinary data edit',
       r.code === null, r.code || 'accepted');
  }
  reject('uid_rebound that also moves status',
         mut('uid_rebound', { previousStatus: WORKING, newStatus: ON_LEAVE }));

  /* ── 9. TRANSITIONS MUST MATCH THE EVENT THAT NAMES THEM ───────────────── */
  head('9 - every lifecycle event enforces its own transition');
  reject('leave_granted from on_leave', mut('leave_granted', { previousStatus: ON_LEAVE }));
  reject('leave_granted to suspended', mut('leave_granted', { newStatus: SUSPENDED }));
  reject('leave_ended from working', mut('leave_ended', { previousStatus: WORKING }));
  reject('employment_suspended to on_leave', mut('employment_suspended', { newStatus: ON_LEAVE }));
  reject('suspension_lifted from on_leave', mut('suspension_lifted', { previousStatus: ON_LEAVE }));
  reject('employment_terminated from terminated', mut('employment_terminated', { previousStatus: TERMINATED }));
  reject('employment_reinstated from active', mut('employment_reinstated', { previousStatus: WORKING }));
  reject('employment_established with a non-null previousStatus',
         mut('employment_established', { previousStatus: WORKING }));
  reject('invite_accepted from active', mut('invite_accepted', { previousStatus: WORKING }));
  reject('invite_revoked that leaves the record pending',
         mut('invite_revoked', { newStatus: PENDING }));
  {
    const r = build(VALID.invite_revoked);
    ok('ACCEPTS invite_revoked ending the relationship — pending → terminated',
       r.code === null && r.out.payload.newStatus.employmentStatus === 'terminated',
       r.code || r.out.payload.newStatus.employmentStatus);
  }
  reject('a terminated status carrying a workStatus',
         mut('employment_terminated', { newStatus: { employmentStatus: 'terminated', workStatus: 'working' } }));
  reject('an active status with no workStatus',
         mut('leave_granted', { newStatus: { employmentStatus: 'active', workStatus: null } }));
  /* ISOLATES THE STATUS-SHAPE RULES. The two above are ALSO caught by the
     transition table, so disabling the shape check alone left them passing —
     measured GREEN. `record_edited` requires only that both sides be identical,
     so an identical INVALID shape reaches the shape check and nothing else. */
  {
    const bothTerm = { employmentStatus: 'terminated', workStatus: 'working' };
    reject('  …isolated: terminated + workStatus, identical on both sides',
           mut('record_edited', { previousStatus: bothTerm, newStatus: bothTerm }));
    const bothActive = { employmentStatus: 'active', workStatus: null };
    reject('  …isolated: active + null workStatus, identical on both sides',
           mut('record_edited', { previousStatus: bothActive, newStatus: bothActive }));
  }
  reject('an unknown employmentStatus',
         mut('leave_granted', { newStatus: { employmentStatus: 'fired', workStatus: 'working' } }));
  reject('an unknown workStatus',
         mut('leave_granted', { newStatus: { employmentStatus: 'active', workStatus: 'napping' } }));

  /* ── 10. IDENTITY FIELDS ───────────────────────────────────────────────── */
  head('10 - rebinding and acceptance require their identities');
  reject('uid_rebound without previousUid', mut('uid_rebound', { previousUid: undefined }));
  reject('uid_rebound without newUid', mut('uid_rebound', { newUid: undefined }));
  reject('uid_rebound where the two uids are equal', mut('uid_rebound', { previousUid: EMP, newUid: EMP }));
  reject('invite_accepted without newUid', mut('invite_accepted', { newUid: undefined }));

  /* ── 11. DISCRIMINATORS AND IDS ────────────────────────────────────────── */
  head('11 - discriminators and id fragments');
  reject('leave_granted without a leaveId', mut('leave_granted', { leaveId: undefined }));
  reject('employment_suspended without a suspensionId', mut('employment_suspended', { suspensionId: undefined }));
  reject('record_edited without an editId', mut('record_edited', { editId: undefined }));
  reject('uid_rebound without a transitionId', mut('uid_rebound', { transitionId: undefined }));
  reject('a leaveId containing a path separator', mut('leave_granted', { leaveId: 'a/b' }));
  reject('a staffId containing a path separator', mut('leave_granted', { staffId: 'a/b' }));
  reject('a missing businessId', mut('leave_granted', { businessId: undefined }));
  reject('an empty staffId', mut('leave_granted', { staffId: '' }));
  reject('a non-object input', 'not an object');
  reject('a null input', null);

  /* ── 12. STRICT SCOPE ──────────────────────────────────────────────────── */
  head('12 - nothing beyond the builder appeared');
  {
    ok('the module reads no collection other than employmentEvents',
       (CODE.match(/collection\(/g) || []).length === (CODE.match(/collection\(COLLECTION\)/g) || []).length,
       'all collection() calls target COLLECTION');
    ok('no history-read callable was added', !/onCall|getEmploymentHistory/.test(CODE));
    ok('no invitation, uniqueness-claim or shop-assignment logic appeared',
       !/shopInvites|acceptInvite|uniquenessClaim|shopAssignment/i.test(CODE));
    ok('no payroll or payment code appeared',
       !/payroll|payslip|disburse|sendMoneyB2C/i.test(CODE));
    ok('the builder never calls .set / .update / .delete itself',
       !/\.(set|update|delete)\(/.test(CODE));
    /* POSITIVE CONTROL for the stripper. */
    const MUST = ['function employmentEvent', "COLLECTION = 'employmentEvents'", 'previousStatus', 'changedVia'];
    ok('CONTROL — stripping left every load-bearing statement intact',
       MUST.every(m => CODE.includes(m)), MUST.filter(m => !CODE.includes(m)).join(',') || 'all present');
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live write. firebase-admin is stubbed at the require boundary,');
  console.log('            and the builder does not write in any case.');
  console.log('  SEPARATE  the Firestore rules are certified against the real rules ENGINE in');
  console.log('            scripts/test-employment-events-rules.js — a rules expression error');
  console.log('            reads as a working guard and cannot be proven by reading source.');
  console.log('  SEPARATE  employmentEvent has NO caller. The twelve transitions belong to');
  console.log('            mechanisms #3, #1, #5 and #7, none of which exists yet.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
