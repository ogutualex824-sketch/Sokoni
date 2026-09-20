/* ══════════════════════════════════════════════════════════════════════════════
   PAYROLL ORGANIZATION BOUNDARY — hr-payroll.js -> merchant-authority.js
   scripts/test-payroll-merchant-authority.js

   WHAT THIS PINS
   Eight hr-payroll handlers took `merchantId` from req.data and used it to
   select or mutate another organization's HR data. They now resolve it through
   merchant-authority.assertMerchantAccess, whose declared authority is
   businesses/{merchantId}.ownerId | adminUids[].

   HOW IT IS PROVEN
   The SHIPPED handlers are REQUIRED AND EXECUTED — `_h` is a real module export
   — against a recording Firestore stub, and the REAL merchant-authority module
   runs inside them. Nothing is source-matched: a source regex would pass on a
   call that never executes, which is the defect class this repair exists to
   close.

   THE OBSERVABLE
   Not the throw. A handler that crashed for an unrelated reason also throws.
   The observable is WHICH COLLECTIONS WERE TOUCHED:

     refused  -> `businesses` was read, and NO hr* collection was reached
     allowed  -> execution passed the authority call and reached hr* data

   Both directions are asserted for every handler, so a guard that refuses
   everybody fails here exactly as loudly as one that refuses nobody.

   SCOPE
   Authorization only. This suite has no opinion about the dead self-read rule
   arms, hrStaff.uid binding, the payslip lifecycle or any payment rail — each
   is its own gate, and section 5 asserts none of them moved.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs   = require('fs');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

/* ── The recording Firestore stub ───────────────────────────────────────────
   Permissive by design: it must never be the reason a handler stops, or an
   "allowed" verdict could not be distinguished from a stub failure. */
let TOUCHED = [];
let BUSINESSES = {};

function snap (id, data) {
  return { exists: data !== undefined, id, data: () => data, ref: { id } };
}
function emptyQuery () {
  const q = {
    where: () => q, orderBy: () => q, limit: () => q,
    get: async () => ({ empty: true, size: 0, docs: [], forEach: () => {} }),
    count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
  };
  return q;
}
function collection (name) {
  TOUCHED.push(name);
  const q = emptyQuery();
  q.doc = (id) => ({
    id,
    get: async () => snap(id, name === 'businesses' ? BUSINESSES[id] : undefined),
    set: async () => {}, update: async () => {}, delete: async () => {},
    collection,
  });
  return q;
}
const fakeDb = {
  collection,
  batch: () => ({ set () {}, update () {}, delete () {}, commit: async () => {} }),
  runTransaction: async (fn) => fn({
    get: async (ref) => snap(ref && ref.id, undefined),
    set () {}, update () {}, delete () {},
  }),
};

/* ── Load the SHIPPED module with its infrastructure stubbed ────────────────
   `admin.firestore` is a prototype GETTER on the real SDK; assigning to it
   fails silently and the harness would hit PRODUCTION while reporting
   "stubbed". So firebase-admin is replaced at the REQUIRE boundary instead —
   the stub is a plain object and `firestore` is an ordinary function on it. */
class HttpsError extends Error {
  constructor (code, message) { super(message); this.code = code; }
}
const STUBS = {
  'firebase-admin': (() => {
    const f = () => fakeDb;
    f.FieldValue = { serverTimestamp: () => 'TS', increment: n => n, arrayUnion: (...a) => a };
    f.Timestamp = { now: () => 'TS', fromDate: d => d };
    return { firestore: f, apps: [{}], initializeApp () {} };
  })(),
  'firebase-functions/v2/https': { onCall: (_o, fn) => (typeof _o === 'function' ? _o : fn), HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '0'.repeat(64) }) },
};
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, req)) return STUBS[req];
  return realLoad.call(this, req, parent, isMain);
};
let HR = null, AUTH_MOD = null, loadError = null;
try {
  HR       = require(path.join(ROOT, 'functions/hr-payroll.js'));
  AUTH_MOD = require(path.join(ROOT, 'functions/merchant-authority.js'));
} catch (e) { loadError = e && e.message ? e.message.slice(0, 160) : 'load failed'; }
Module._load = realLoad;

const SRC = fs.readFileSync(path.join(ROOT, 'functions/hr-payroll.js'), 'utf8');
/* Assertions about CODE run on stripped source — this suite's own prose names
   the very call it counts. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* THIS gate owns the handlers that take a merchantId from the caller, and they
   are identified by the ARGUMENT, not by a bare occurrence of the function
   name. The record-anchored gate passes an organization read off a stored
   document (runOrg, payslip.merchantId, leaveOrg, training.merchantId), so a
   substring count of `assertMerchantAccess(req.auth` conflates the two and
   rots the moment either gate changes. Whitespace-tolerant, argument-exact. */
/* Extract each call's ARGUMENT and classify it. A negative-lookahead regex was
   tried first and was WRONG: the `\s*` before the lookahead can match empty,
   which moves the test off the identifier and lets the engine backtrack around
   it — so it matched all 12 calls, including the 8 it was written to exclude.
   Reading the argument out leaves nothing to backtrack around. */
const CALL_RE = /await\s+assertMerchantAccess\s*\(\s*req\.auth\s*,\s*([^)]+?)\s*\)\s*;/g;
function callArgs () {
  const out = []; let m; CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(CODE)) !== null) out.push(m[1].trim());
  return out;
}
const ARGS      = callArgs();
const REQUESTED = ARGS.filter(a => a === 'merchantId').length;
const RECORD    = ARGS.filter(a => a !== 'merchantId').length;

/* ── The eight handlers, with the minimum data that reaches the boundary ──── */
/* Six handlers sit behind a PRE-EXISTING claim gate (assertAdminOrManager:
   token.admin || token.manager). A caller without a claim is refused there,
   BEFORE the organization boundary runs — so driving them with a plain user
   would prove nothing about this repair while looking green. Each case is
   therefore driven with the weakest caller that reaches the boundary.
     'claim' -> needs token.manager   'open' -> any authenticated user       */
const CASES = [
  ['addStaffMember',      'claim', m => ({ merchantId: m, name: 'Jane', employeeNumber: 'E1', department: 'Ops', position: 'Clerk' })],
  ['recordAttendance',    'open',  m => ({ merchantId: m, staffId: 'S1' })],
  ['getAttendanceReport', 'claim', m => ({ merchantId: m, month: '2026-01' })],
  ['runPayroll',          'claim', m => ({ merchantId: m, period: '2026-01' })],
  ['getPayrollSummary',   'claim', m => ({ merchantId: m, period: '2026-01' })],
  ['requestLeave',        'open',  m => ({ merchantId: m, staffId: 'S1', type: 'annual', startDate: '2026-01-01', endDate: '2026-01-02' })],
  ['assignTraining',      'claim', m => ({ merchantId: m, title: 'T', dueDate: '2026-01-01', assignedTo: ['S1'] })],
  ['getStaffDashboard',   'claim', m => ({ merchantId: m })],
];
const HR_COLLECTIONS = ['hrStaff', 'hrAttendance', 'hrPayrollRuns', 'hrPayslips', 'hrLeaves', 'hrTraining'];

/** Execute a shipped handler and report what it touched. */
async function invoke (name, auth, data) {
  TOUCHED = [];
  let err = null;
  try { await HR._h[name]({ auth, data }); }
  catch (e) { err = e; }
  return {
    denied:    !!err && err.code === 'permission-denied',
    code:      err ? (err.code || 'throw') : null,
    readAuthority: TOUCHED.includes('businesses'),
    reachedHr: TOUCHED.some(c => HR_COLLECTIONS.includes(c)),
    touched:   TOUCHED.slice(),
  };
}

const OWNER = 'U_OWNER', MEMBER = 'U_MEMBER', STRANGER = 'U_STRANGER';
const MINE = 'SOK-MINE', THEIRS = 'SOK-THEIRS', GHOST = 'SOK-GHOST';
const SOLE = 'SOK-SOLE';
BUSINESSES = {
  [MINE]:   { ownerId: OWNER, adminUids: [OWNER, MEMBER], name: 'Mine' },
  [THEIRS]: { ownerId: 'U_OTHER', adminUids: ['U_OTHER'], name: 'Theirs' },
  /* The owner is deliberately NOT in adminUids. Without this, `ownerId` and
     `adminUids` are never distinguishable: an owner listed in both passes
     through whichever arm runs first, and deleting the ownerId arm entirely
     leaves the suite green. Measured — sabotage S8 went green until this
     fixture existed. */
  [SOLE]:   { ownerId: OWNER, name: 'Sole' },
  /* GHOST deliberately absent — fail-closed fixture. */
};
const asUser  = uid => ({ uid, token: {} });
const asAdmin = uid => ({ uid, token: { admin: true } });
/* A `manager` claim clears assertAdminOrManager but NOT the organization
   boundary — token.admin is the only claim merchant-authority bypasses on. It
   is therefore the caller that isolates THIS repair. */
const asManager = uid => ({ uid, token: { manager: true } });
/** The weakest caller that reaches the boundary in a given handler. */
const reach = (tier, uid) => (tier === 'claim' ? asManager(uid) : asUser(uid));

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  PAYROLL ORGANIZATION BOUNDARY');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - controls');
  ok('the shipped module loaded and executes', loadError === null && !!HR, loadError || '');
  ok('`_h` exposes all eight handlers under test',
     !!HR && CASES.every(([n]) => typeof HR._h[n] === 'function'),
     HR ? CASES.filter(([n]) => typeof HR._h[n] !== 'function').map(c => c[0]).join(',') || 'all present' : 'no module');
  ok('six handlers are claim-gated, two are open — both tiers are exercised',
     CASES.filter(c => c[1] === 'claim').length === 6 && CASES.filter(c => c[1] === 'open').length === 2,
     CASES.map(c => c[1]).join(','));
  ok('the REAL merchant-authority module is loaded, not a stub',
     !!AUTH_MOD && AUTH_MOD.AUTHORITY === 'businesses' && typeof AUTH_MOD.assertMerchantAccess === 'function',
     AUTH_MOD ? 'AUTHORITY=' + AUTH_MOD.AUTHORITY : 'missing');
  ok('hr-payroll imports it', /require\('\.\/merchant-authority'\)/.test(SRC));
  ok('eight requested-merchantId boundaries exist in the shipped source',
     REQUESTED === 8, REQUESTED + ' of the requested form');
  /* POSITIVE CONTROL. The matcher must be able to match, and must DISCRIMINATE:
     it has to find the record-anchored calls with the other pattern while
     excluding them from the count above. A matcher that can find nothing would
     report 0 and read as a broken repair; one that matches everything would
     report 12 and read the same way. */
  ok('CONTROL — the matcher discriminates the two call forms',
     RECORD === 4 && REQUESTED + RECORD === CODE.split('assertMerchantAccess(req.auth').length - 1,
     'requested=' + REQUESTED + ' record=' + RECORD + ' args=[' + ARGS.join(' | ') + ']');
  /* POSITIVE CONTROL for the stub itself. If `businesses` could never be read,
     every refusal below would be unattributable. */
  {
    const probe = await invoke('getStaffDashboard', asManager(OWNER), { merchantId: MINE });
    ok('CONTROL — the stub can be read, and an owner is NOT refused',
       probe.readAuthority && !probe.denied, 'code=' + probe.code);
    /* INVERTING CONTROL for the claim tier itself: the six claim-gated handlers
       refuse a claimless caller WITHOUT consulting the organization at all. If
       this ever passes, section 1 has started proving the wrong thing. */
    const claimless = await invoke('getStaffDashboard', asUser(OWNER), { merchantId: MINE });
    ok('CONTROL — a claimless caller is stopped by the PRE-EXISTING claim gate, not by this repair',
       claimless.denied && !claimless.readAuthority, 'touched=' + (claimless.touched.join(',') || 'nothing'));
  }

  /* ── 1. CROSS-ORGANIZATION ──────────────────────────────────────────────── */
  head('1 - a caller-supplied merchantId cannot cross organizations');
  for (const [name, tier, mk] of CASES) {
    const r = await invoke(name, reach(tier, STRANGER), mk(THEIRS));
    ok(name + ' refuses an organization the caller does not belong to',
       r.denied, 'code=' + r.code);
    /* ANTI-VACUITY. The refusal must come from THIS boundary: the authority
       document has to have been consulted. Without this, a pre-existing gate
       refusing first would read as a pass. */
    ok('  …and the refusal came from the organization boundary', r.readAuthority,
       'touched=' + (r.touched.join(',') || 'nothing'));
    ok('  …and reached no HR data before refusing', !r.reachedHr, r.touched.join(',') || 'nothing');
  }

  /* ── 2. THE LEGITIMATE PATHS ───────────────────────────────────────────── */
  head('2 - the authorized paths still work');
  for (const [name, tier, mk] of CASES) {
    const owner  = await invoke(name, reach(tier, OWNER),  mk(MINE));
    const member = await invoke(name, reach(tier, MEMBER), mk(MINE));
    const sole   = await invoke(name, reach(tier, OWNER),  mk(SOLE));
    ok(name + ' admits the business owner',        !owner.denied,  'code=' + owner.code);
    ok(name + ' admits an adminUids member',       !member.denied, 'code=' + member.code);
    /* ISOLATES ownerId: this organization has no adminUids at all. */
    ok(name + ' admits an owner who is NOT an adminUid', !sole.denied, 'code=' + sole.code);
  }

  /* ── 3. PLATFORM ADMIN + FAIL CLOSED ───────────────────────────────────── */
  head('3 - admin bypass preserved, missing organization fails closed');
  for (const [name, tier, mk] of CASES) {
    const adm   = await invoke(name, asAdmin('U_PLATFORM'),  mk(THEIRS));
    const ghost = await invoke(name, reach(tier, STRANGER),  mk(GHOST));
    ok(name + ' still admits a platform admin for any organization', !adm.denied, 'code=' + adm.code);
    ok(name + ' refuses an organization that does not exist',        ghost.denied, 'code=' + ghost.code);
  }

  /* ── 4. THE LEGACY FORM MUST SURVIVE ───────────────────────────────────── */
  head('4 - legacy uid-as-merchantId is preserved');
  /* One production business is still keyed by its owner's uid
     (businesses/D5Ql…). The primitive returns early on merchantId === uid, so
     that merchant must pass with NO businesses document at all. */
  for (const [name, tier, mk] of CASES) {
    const r = await invoke(name, reach(tier, 'U_LEGACY'), mk('U_LEGACY'));
    ok(name + ' admits a merchant whose merchantId IS their uid', !r.denied, 'code=' + r.code);
  }
  {
    const r  = await invoke('getStaffDashboard', asManager('U_LEGACY'), { merchantId: 'U_LEGACY' });
    const rx = await invoke('getStaffDashboard', asManager('U_LEGACY'), { merchantId: 'U_LEGACY_X' });
    ok('INVERTING CONTROL — that form is an EXACT match, not a prefix',
       rx.denied && !r.denied, 'U_LEGACY code=' + r.code + ' / U_LEGACY_X code=' + rx.code);
  }

  /* ── 5. UNAUTHENTICATED ────────────────────────────────────────────────── */
  head('5 - no organization is reachable without authentication');
  for (const [name, tier, mk] of CASES) {
    const r = await invoke(name, null, mk(MINE));
    ok(name + ' refuses an unauthenticated caller', r.code !== null && !r.reachedHr, 'code=' + r.code);
  }

  /* ── 6. STRICT SCOPE ───────────────────────────────────────────────────── */
  head('6 - nothing outside the authorization boundary moved');
  {
    const g = (args) => require('child_process')
      .execFileSync('git', ['-C', ROOT].concat(args), { encoding: 'utf8' });
    const changed = g(['status', '--porcelain']).trim().split('\n')
      .map(l => l.slice(3).trim()).filter(Boolean).sort();
    ok('firestore.rules is untouched', !changed.includes('firestore.rules'), changed.join(' '));
    ok('the hrStaff write shape is unchanged — uid is still null',
       /status: 'active', uid: null,/.test(SRC));
    ok('no uid binding was introduced', SRC.split('uid: null').length - 1 === 1);
    ok('decryptData is still called from nowhere',
       SRC.split('decryptData').length - 1 === 1, 'definition only');
    ok('no payment, payout or disbursement code was added',
       !/sendMoneyB2C|disburse|payout|initiatePayment/i.test(SRC));
    ok('no new payslip state was introduced', !/'paid'/.test(SRC));
    /* RETIRED 2026-09-20. This asserted that approvePayrollRun, getPayslip,
       approveLeave and markTrainingComplete carried no authority call. That was
       this gate's scope statement, and it was true when written; the
       record-anchored gate has since given all four an organization boundary of
       their own, deliberately. Their scope now belongs to
       scripts/test-payroll-record-authority.js, and no assertion replaces it
       here — a suite must not assert that another gate's legitimate work does
       not exist. */
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live call. firebase-admin is stubbed at the require boundary,');
  console.log('            so no Cloud Function runs and no document is written.');
  console.log('  SEPARATE  approvePayrollRun, getPayslip, approveLeave and markTrainingComplete');
  console.log('            are anchored on a RECORD, not a requested merchantId. They are now');
  console.log('            bound too, by the record-anchored gate, and certified in');
  console.log('            scripts/test-payroll-record-authority.js — not here.');
  console.log('  SEPARATE  the six hr* Firestore rules are untouched; three still guard fields');
  console.log('            no writer writes. Rules are a later gate.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  /* FAIL CLOSED. A harness crash must report a verdict, never exit 0. */
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
