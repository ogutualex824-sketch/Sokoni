/* ══════════════════════════════════════════════════════════════════════════════
   PAYROLL RECORD-ANCHORED ORGANIZATION BOUNDARY
   scripts/test-payroll-record-authority.js

   WHAT THIS PINS
   Four hr-payroll handlers take a RECORD ID, never a merchantId:

     approvePayrollRun     hrPayrollRuns/{runId}.merchantId
     getPayslip            hrPayslips/{runId}_{staffId}.merchantId
     approveLeave          hrLeaves/{leaveId}.merchantId
     markTrainingComplete  hrTraining/{trainingId}.merchantId

   Each now reads the organization off the STORED record and authorizes it
   through merchant-authority.assertMerchantAccess. The caller never names an
   organization, and the organization is never recovered from a document id.

   THE ID IS A TRAP, AND THE FIXTURES SET IT
   Every one of these ids LOOKS like it contains the organization — runId is
   `${merchantId}_${period}`, the payslip id is `${runId}_${staffId}`. So each
   fixture stores a record whose ID DISAGREES with its own merchantId field. A
   handler that parses the id authorizes against the wrong organization and
   fails here; a handler that reads the field passes. Without that disagreement
   both implementations look identical.

   HOW IT IS PROVEN
   The SHIPPED handlers are REQUIRED AND EXECUTED via the exported `_h`, with
   the REAL merchant-authority running inside them, against a Firestore stub
   that serves documents and RECORDS EVERY WRITE. For the three mutating
   handlers the observable is not only the throw but whether the record was
   actually modified.

   SCOPE
   Authorization only. Asserts that hrStaff.uid is still unbound, that staffUid
   is still consulted by nothing, and that no payment rail appeared.
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

/* ── Document store + write recorder ───────────────────────────────────────
   Permissive: it must never be the reason a handler stops, or "allowed" could
   not be told apart from a stub failure. */
let DOCS = {}, WRITES = [], TOUCHED = [], autoId = 0;

function snap (coll, id) {
  const d = DOCS[coll + '/' + id];
  return { exists: d !== undefined, id, data: () => d, ref: { id, _coll: coll } };
}
function docHandle (coll, id) {
  return {
    id, _coll: coll,
    get: async () => snap(coll, id),
    set: async (v) => { WRITES.push({ op: 'set', coll, id, v }); },
    update: async (v) => { WRITES.push({ op: 'update', coll, id, v }); },
    delete: async () => { WRITES.push({ op: 'delete', coll, id }); },
    collection: (c) => collection(c),
  };
}
function collection (name) {
  TOUCHED.push(name);
  const q = {
    where: () => q, orderBy: () => q, limit: () => q,
    get: async () => ({ empty: true, size: 0, docs: [], forEach: () => {} }),
    doc: (id) => docHandle(name, id === undefined ? 'AUTO_' + (++autoId) : id),
  };
  return q;
}
const fakeDb = {
  collection,
  batch: () => ({
    set (ref, v)    { WRITES.push({ op: 'set',    coll: ref._coll, id: ref.id, v }); },
    update (ref, v) { WRITES.push({ op: 'update', coll: ref._coll, id: ref.id, v }); },
    delete (ref)    { WRITES.push({ op: 'delete', coll: ref._coll, id: ref.id }); },
    commit: async () => {},
  }),
  runTransaction: async (fn) => fn({
    get: async (ref) => snap(ref._coll, ref.id),
    set (ref, v)    { WRITES.push({ op: 'set',    coll: ref._coll, id: ref.id, v }); },
    update (ref, v) { WRITES.push({ op: 'update', coll: ref._coll, id: ref.id, v }); },
    delete (ref)    { WRITES.push({ op: 'delete', coll: ref._coll, id: ref.id }); },
  }),
};

/* ── Load the shipped module with infrastructure stubbed at the REQUIRE
   boundary. admin.firestore is a prototype getter on the real SDK; assigning
   to it fails silently and the harness would hit PRODUCTION while reporting
   "stubbed". ── */
class HttpsError extends Error {
  constructor (code, message) { super(message); this.code = code; }
}
const STUBS = {
  'firebase-admin': (() => {
    const f = () => fakeDb;
    f.FieldValue = { serverTimestamp: () => 'TS', increment: n => n, arrayUnion: (...a) => ({ _arrayUnion: a }) };
    f.Timestamp = { now: () => 'TS', fromDate: d => d };
    return { firestore: f, apps: [{}], initializeApp () {} };
  })(),
  'firebase-functions/v2/https': { onCall: (o, fn) => (typeof o === 'function' ? o : fn), HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '0'.repeat(64) }) },
};
const realLoad = Module._load;
Module._load = function (r, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, r)) return STUBS[r];
  return realLoad.call(this, r, parent, isMain);
};
let HR = null, AUTH_MOD = null, loadError = null;
try {
  HR       = require(path.join(ROOT, 'functions/hr-payroll.js'));
  AUTH_MOD = require(path.join(ROOT, 'functions/merchant-authority.js'));
} catch (e) { loadError = e && e.message ? e.message.slice(0, 160) : 'load failed'; }
Module._load = realLoad;

const SRC = fs.readFileSync(path.join(ROOT, 'functions/hr-payroll.js'), 'utf8');
/* Assertions about CODE must run on stripped source. The repair's own comment
   explains why `staffUid` is not consulted — and that sentence satisfied the
   check that it is not consulted. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── Identities ─────────────────────────────────────────────────────────── */
const OWNER = 'U_OWNER', MEMBER = 'U_MEMBER', STRANGER = 'U_STRANGER', LEGACY = 'U_LEGACY';
const MINE = 'SOK-MINE', THEIRS = 'SOK-THEIRS';
const asUser    = uid => ({ uid, token: {} });
const asManager = uid => ({ uid, token: { manager: true } });
const asAdmin   = uid => ({ uid, token: { admin: true } });

/* Every handler here is behind assertAdmin or assertAdminOrManager, except
   markTrainingComplete. `manager` clears those gates but NOT the organization
   boundary — token.admin is the only claim merchant-authority bypasses — so it
   is the caller that isolates THIS repair. */
const M = asManager, A = asAdmin;

/* The weakest caller that ISOLATES the boundary in each handler — it must
   clear every other gate without bypassing merchant-authority.
     approvePayrollRun     assertAdmin           -> token.admin required
     getPayslip            admin||manager        -> manager suffices
     approveLeave          admin||manager        -> manager suffices
     markTrainingComplete  req.auth, then a staff-identity check that admits
                           only the employee or an admin/manager -> manager  */
const TIER = {
  approvePayrollRun:    asAdmin,
  getPayslip:           asManager,
  approveLeave:         asManager,
  markTrainingComplete: asManager,
};
const reach = (n, uid) => TIER[n](uid);

/* approvePayrollRun is DELIBERATELY EXCLUDED from the cross-organization
   assertions. assertAdmin requires token.admin, and merchant-authority
   BYPASSES token.admin === true — so every correctly-minted caller that clears
   its gate is then bypassed, and its boundary can never REFUSE on ownership.
   Asserting a denial there would be asserting a fiction. What IS reachable for
   it — the missing-organization refusal, which runs before the primitive — is
   certified in its own section. */
const ORG_ENFORCED = ['getPayslip', 'approveLeave', 'markTrainingComplete'];

function seed () {
  DOCS = {};
  WRITES = []; TOUCHED = []; autoId = 0;

  DOCS['businesses/' + MINE]   = { ownerId: OWNER, adminUids: [OWNER, MEMBER] };
  DOCS['businesses/' + THEIRS] = { ownerId: 'U_OTHER', adminUids: ['U_OTHER'] };
  DOCS['businesses/' + 'SOK-SOLE'] = { ownerId: OWNER };   /* owner, no adminUids */

  /* THE ID/FIELD DISAGREEMENT. Each id spells THEIRS; each stored organization
     is MINE. Read the field -> MINE. Parse the id -> THEIRS. */
  DOCS['hrPayrollRuns/' + THEIRS + '_2026-01'] = { merchantId: MINE, period: '2026-01', status: 'draft' };
  DOCS['hrPayslips/' + THEIRS + '_2026-01_S1'] = { merchantId: MINE, runId: THEIRS + '_2026-01', staffId: 'S1', netSalary: 42 };
  DOCS['hrLeaves/L_THEIRS_1']                  = { merchantId: MINE, staffId: 'S1', status: 'pending', type: 'annual', leaveDays: 1, startDate: '2026-01-01', endDate: '2026-01-02', requestedBy: 'U_REQ' };
  DOCS['hrTraining/T_THEIRS_1']                = { merchantId: MINE, assignedTo: ['S1'], completedBy: [] };

  /* Genuinely belonging to THEIRS — the cross-organization fixtures. */
  DOCS['hrPayrollRuns/X_RUN'] = { merchantId: THEIRS, period: '2026-01', status: 'draft' };
  DOCS['hrPayslips/X_S1']     = { merchantId: THEIRS, runId: 'X', staffId: 'S1' };
  DOCS['hrLeaves/X_LEAVE']    = { merchantId: THEIRS, staffId: 'S1', status: 'pending', type: 'annual', leaveDays: 1, startDate: 'a', endDate: 'b', requestedBy: 'U_REQ' };
  DOCS['hrTraining/X_TRAIN']  = { merchantId: THEIRS, assignedTo: ['S1'], completedBy: [] };

  /* No merchantId at all. */
  DOCS['hrPayrollRuns/N_RUN'] = { period: '2026-01', status: 'draft' };
  DOCS['hrPayslips/N_S1']     = { runId: 'N', staffId: 'S1' };
  DOCS['hrLeaves/N_LEAVE']    = { staffId: 'S1', status: 'pending', type: 'annual', leaveDays: 1, startDate: 'a', endDate: 'b', requestedBy: 'U_REQ' };
  DOCS['hrTraining/N_TRAIN']  = { assignedTo: ['S1'], completedBy: [] };

  /* Legacy form: organization id IS the owner's uid, and no businesses doc. */
  DOCS['hrPayrollRuns/LEG_RUN'] = { merchantId: LEGACY, period: '2026-01', status: 'draft' };
  DOCS['hrPayslips/LEG_S1']     = { merchantId: LEGACY, runId: 'LEG', staffId: 'S1' };
  DOCS['hrLeaves/LEG_LEAVE']    = { merchantId: LEGACY, staffId: 'S1', status: 'pending', type: 'annual', leaveDays: 1, startDate: 'a', endDate: 'b', requestedBy: 'U_REQ' };
  DOCS['hrTraining/LEG_TRAIN']  = { merchantId: LEGACY, assignedTo: ['S1'], completedBy: [] };

  /* Owner-only organization, to isolate the ownerId arm from adminUids. */
  DOCS['hrPayrollRuns/SOLE_RUN'] = { merchantId: 'SOK-SOLE', period: '2026-01', status: 'draft' };

  /* getPayslip loads hrStaff FIRST. Present for most cases; deliberately absent
     for the markTrainingComplete fail-open fixtures. */
  DOCS['hrStaff/S1'] = { merchantId: MINE, name: 'Jane', employeeNumber: 'E1', uid: null };
}

/** Run a shipped handler; report refusal, mutation and what was touched. */
async function invoke (name, auth, data) {
  seed();
  let err = null, out = null;
  try { out = await HR._h[name]({ auth, data }); }
  catch (e) { err = e; }
  return {
    denied: !!err && err.code === 'permission-denied',
    code: err ? (err.code || 'throw') : null,
    out,
    wrote: WRITES.length > 0,
    writes: WRITES.slice(),
    readAuthority: TOUCHED.includes('businesses'),
  };
}

/* Each case: handler, the data that reaches the record, and the caller tier. */
const H = {
  approvePayrollRun:    id => ({ runId: id }),
  getPayslip:           id => ({ runId: id, staffId: 'S1' }),
  approveLeave:         id => ({ leaveId: id, approved: true }),
  markTrainingComplete: id => ({ trainingId: id, staffId: 'S1' }),
};
/* getPayslip addresses `${runId}_${staffId}`, so its "id" argument is the runId
   portion; every other handler takes the document id directly. */
const IDS = {
  trap:   { approvePayrollRun: THEIRS + '_2026-01', getPayslip: THEIRS + '_2026-01', approveLeave: 'L_THEIRS_1', markTrainingComplete: 'T_THEIRS_1' },
  cross:  { approvePayrollRun: 'X_RUN',  getPayslip: 'X',   approveLeave: 'X_LEAVE',  markTrainingComplete: 'X_TRAIN' },
  noOrg:  { approvePayrollRun: 'N_RUN',  getPayslip: 'N',   approveLeave: 'N_LEAVE',  markTrainingComplete: 'N_TRAIN' },
  legacy: { approvePayrollRun: 'LEG_RUN', getPayslip: 'LEG', approveLeave: 'LEG_LEAVE', markTrainingComplete: 'LEG_TRAIN' },
};
const NAMES = Object.keys(H);
const MUTATING = ['approvePayrollRun', 'approveLeave', 'markTrainingComplete'];

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  PAYROLL RECORD-ANCHORED ORGANIZATION BOUNDARY');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - controls');
  ok('the shipped module loaded and executes', loadError === null && !!HR, loadError || '');
  ok('all four handlers are exposed',
     !!HR && NAMES.every(n => typeof HR._h[n] === 'function'));
  ok('the REAL merchant-authority is loaded, not a stub',
     !!AUTH_MOD && AUTH_MOD.AUTHORITY === 'businesses',
     AUTH_MOD ? 'AUTHORITY=' + AUTH_MOD.AUTHORITY : 'missing');
  /* RE-ANCHORED 2026-09-20. This counted TWELVE assertMerchantAccess sites.
     Gate 3 mechanism #3 moved establishment onto the provenance resolver — it
     needs the `via` that assertMerchantAccess discards — so the Gate 1/Gate 2
     contract now accounts for ELEVEN, plus one separately certified
     establishment boundary. Counted by FORM, not by total: a total would be
     satisfied by eleven of any kind. */
  ok('eleven authority call sites keep the Gate 1 / Gate 2 contract (7 requested + 4 record-anchored)',
     SRC.split('assertMerchantAccess(req.auth').length - 1 === 11,
     (SRC.split('assertMerchantAccess(req.auth').length - 1) + ' sites');
  ok('  …and establishment resolves provenance separately, gated on owner | platform',
     /const \{ via \} = await resolveMerchantAccess\(req\.auth, merchantId\);/.test(SRC)
     && /if \(via !== 'owner' && via !== 'platform'\)/.test(SRC));
  ok('  …so the four RECORD-anchored boundaries are still present',
     ['runOrg', 'payslip.merchantId', 'leaveOrg', 'training.merchantId']
       .every(a => SRC.includes('assertMerchantAccess(req.auth, ' + a + ')')));
  /* POSITIVE CONTROL for the stub: it must be able to serve a record AND record
     a write, or every "denied / did not write" verdict below is unattributable. */
  {
    const r = await invoke('approvePayrollRun', A('U_PLATFORM'), { runId: 'X_RUN' });
    ok('CONTROL — the stub serves records and captures writes',
       !r.denied && r.wrote, 'code=' + r.code + ' writes=' + r.writes.length);
  }

  /* ── 1. THE DIRECT ANCHOR IS READ FROM THE FIELD, NOT THE ID ──────────── */
  head('1 - the organization comes from the stored field, never the document id');
  for (const n of NAMES) {
    const r = await invoke(n, reach(n, OWNER), H[n](IDS.trap[n]));
    ok(n + ' authorizes against the record\'s merchantId', !r.denied, 'code=' + r.code);
    /* ANTI-VACUITY, except where the admin bypass legitimately short-circuits
       the lookup before `businesses` is ever read. */
    if (ORG_ENFORCED.includes(n)) {
      ok('  …and the authority document WAS consulted', r.readAuthority,
         r.readAuthority ? '' : 'businesses never read');
    } else {
      ok('  …(admin bypass: no lookup expected)', !r.readAuthority);
    }
  }

  /* ── 2. CROSS-ORGANIZATION ─────────────────────────────────────────────── */
  head('2 - a record belonging to another organization is refused');
  for (const n of ORG_ENFORCED) {
    const r = await invoke(n, reach(n, OWNER), H[n](IDS.cross[n]));
    ok(n + ' refuses a record owned by another organization', r.denied, 'code=' + r.code);
    /* ANTI-VACUITY: the refusal must come from THIS boundary, not from a
       downstream identity check that happens to refuse the same caller. */
    ok('  …and the refusal came from the organization boundary', r.readAuthority,
       r.readAuthority ? '' : 'businesses never read');
    if (MUTATING.includes(n)) {
      ok('  …and nothing was written', !r.wrote,
         r.writes.map(w => w.op + ' ' + w.coll).join(',') || 'no writes');
    } else {
      ok('  …and no payslip was returned', r.out === null || r.out === undefined,
         JSON.stringify(r.out || null));
    }
  }

  /* ── 3. A RECORD WITH NO ORGANIZATION ──────────────────────────────────── */
  head('3 - a record that names no organization is refused, never defaulted');
  for (const n of NAMES) {
    const r = await invoke(n, reach(n, OWNER), H[n](IDS.noOrg[n]));
    ok(n + ' refuses a record with no merchantId', r.denied, 'code=' + r.code);
    ok('  …and did NOT fall back to the caller as the organization',
       !r.readAuthority, r.readAuthority ? 'consulted businesses — a fallback ran' : 'refused before lookup');
  }

  /* ── 4. THE CALLER CANNOT SUPPLY THE ORGANIZATION ──────────────────────── */
  head('4 - a caller-supplied merchantId is ignored in both directions');
  for (const n of ORG_ENFORCED) {
    /* Record belongs to THEIRS; caller claims MINE, which they DO own. */
    const forged = await invoke(n, reach(n, OWNER), Object.assign(H[n](IDS.cross[n]), { merchantId: MINE }));
    ok(n + ' a forged merchantId cannot UNLOCK another organization\'s record',
       forged.denied, 'code=' + forged.code);
    /* Record belongs to MINE; caller claims THEIRS, which they do NOT own. */
    const noisy = await invoke(n, reach(n, OWNER), Object.assign(H[n](IDS.trap[n]), { merchantId: THEIRS }));
    ok(n + ' a wrong merchantId cannot LOCK a record the caller may act on',
       !noisy.denied, 'code=' + noisy.code);
  }

  /* ── 5. THE AUTHORITY ARMS ARE PRESERVED ───────────────────────────────── */
  head('5 - admin bypass, owner, adminUids and the legacy form all survive');
  for (const n of NAMES) {
    const adm = await invoke(n, A('U_PLATFORM'), H[n](IDS.cross[n]));
    ok(n + ' still admits a platform admin for any organization', !adm.denied, 'code=' + adm.code);
  }
  for (const n of ORG_ENFORCED) {
    const mem = await invoke(n, reach(n, MEMBER), H[n](IDS.trap[n]));
    ok(n + ' still admits an adminUids member', !mem.denied, 'code=' + mem.code);
    const leg = await invoke(n, reach(n, LEGACY), H[n](IDS.legacy[n]));
    ok(n + ' still admits the legacy merchantId === uid form', !leg.denied, 'code=' + leg.code);
    const str = await invoke(n, reach(n, STRANGER), H[n](IDS.trap[n]));
    ok(n + ' refuses a stranger', str.denied, 'code=' + str.code);
  }
  {
    /* ISOLATES ownerId from adminUids: this organization has no adminUids. */
    DOCS['hrLeaves/SOLE_LEAVE'] = null;
    const sole = await (async () => {
      seed();
      DOCS['hrLeaves/SOLE_LEAVE'] = { merchantId: 'SOK-SOLE', staffId: 'S1', status: 'pending', type: 'annual', leaveDays: 1, startDate: 'a', endDate: 'b', requestedBy: 'U_REQ' };
      let err = null;
      try { await HR._h.approveLeave({ auth: asManager(OWNER), data: { leaveId: 'SOLE_LEAVE', approved: true } }); }
      catch (e) { err = e; }
      return { denied: !!err && err.code === 'permission-denied', code: err ? err.code : null };
    })();
    ok('an owner who is NOT an adminUid is admitted', !sole.denied, 'code=' + sole.code);
  }

  /* ── 6. THE markTrainingComplete FAIL-OPEN ─────────────────────────────── */
  head('6 - markTrainingComplete no longer depends on the employee record existing');
  {
    /* The defect: the whole permission check lived inside `if (staffSnap.exists)`
       with no else. hrStaff is EMPTY in production, so that branch never ran and
       any authenticated caller could complete anyone's training. */
    delete DOCS['hrStaff/S1'];
    const noStaff = await (async () => {
      seed(); delete DOCS['hrStaff/S1'];
      let err = null;
      try { await HR._h.markTrainingComplete({ auth: asUser(STRANGER), data: { trainingId: 'X_TRAIN', staffId: 'S1' } }); }
      catch (e) { err = e; }
      return { denied: !!err && err.code === 'permission-denied', code: err ? err.code : null, wrote: WRITES.length > 0 };
    })();
    ok('DEFECT CLOSURE — training exists, staff record ABSENT, unauthorized caller → denied',
       noStaff.denied, 'code=' + noStaff.code);
    ok('  …and the training record was not modified', !noStaff.wrote);

    /* NEGATIVE CONTROL for this defect: with the staff record absent, a caller
       who IS authorized for the organization must still succeed. A fix that
       simply refuses whenever hrStaff is missing would pass the line above and
       break every legitimate call. */
    const okNoStaff = await (async () => {
      seed(); delete DOCS['hrStaff/S1'];
      let err = null;
      try { await HR._h.markTrainingComplete({ auth: asUser(OWNER), data: { trainingId: 'T_THEIRS_1', staffId: 'S1' } }); }
      catch (e) { err = e; }
      return { denied: !!err && err.code === 'permission-denied', code: err ? err.code : null, wrote: WRITES.length > 0 };
    })();
    ok('CONTROL — an AUTHORIZED caller still succeeds with no staff record',
       !okNoStaff.denied && okNoStaff.wrote, 'code=' + okNoStaff.code);
  }

  /* ── 7. approvePayrollRun ORDERING ─────────────────────────────────────── */
  head('7 - approvePayrollRun: reachability, and ordering');
  {
    /* The organization boundary here can refuse on a MISSING organization but
       never on ownership, because the only callers that clear assertAdmin are
       exactly the callers merchant-authority bypasses. Recorded as a fact
       about the handler, not claimed as a protection it does not provide. */
    const nonAdmin = await invoke('approvePayrollRun', asManager(OWNER), { runId: IDS.trap.approvePayrollRun });
    ok('a non-admin never reaches the boundary — the PRE-EXISTING assertAdmin stops them',
       nonAdmin.denied && !nonAdmin.readAuthority,
       'code=' + nonAdmin.code + ' businessesRead=' + nonAdmin.readAuthority);
    const crossAdmin = await invoke('approvePayrollRun', asAdmin('U_PLATFORM'), { runId: IDS.cross.approvePayrollRun });
    ok('an admin is NOT refused for another organization — the bypass is intended',
       !crossAdmin.denied, 'code=' + crossAdmin.code);
  }
  {
    const r = await invoke('approvePayrollRun', A('U_PLATFORM'), { runId: IDS.trap.approvePayrollRun });
    const upd = r.writes.find(w => w.op === 'update' && w.coll === 'hrPayrollRuns');
    ok('the approval still happens for an authorized caller', !!upd && upd.v.status === 'approved',
       upd ? upd.v.status : 'no update');
    /* A non-draft run must still be refused on its own precondition, which
       proves the transaction body was not bypassed by the new pre-read. */
    seed();
    DOCS['hrPayrollRuns/' + THEIRS + '_2026-01'].status = 'approved';
    let err = null;
    try { await HR._h.approvePayrollRun({ auth: asAdmin('U_PLATFORM'), data: { runId: THEIRS + '_2026-01' } }); }
    catch (e) { err = e; }
    ok('a non-draft run is still refused by the transaction precondition',
       !!err && err.code === 'failed-precondition', err ? err.code : 'no error');
  }

  /* ── 8. STRICT SCOPE ───────────────────────────────────────────────────── */
  head('8 - nothing outside the authorization boundary moved');
  {
    /* RE-ANCHORED 2026-09-20. The old regex pinned the neighbouring field name
       (`status: 'active'`) rather than the property under test. What this
       assertion has always been about is that ESTABLISHMENT leaves the identity
       unbound — still true, and now stated on all three parts of the state. */
    ok('establishment still leaves the identity unbound — pending / null / uid null',
       /employmentStatus: 'pending', workStatus: null, uid: null,/.test(SRC));
    ok('no identity binding is introduced AT ESTABLISHMENT',
       SRC.split('uid: null').length - 1 === 1);
    /* Binding belongs to the invitation gate, in its own module. */
    ok('  …and this module never binds a uid itself',
       !/uid: (req|request)\.auth\.uid/.test(SRC));
    ok('staffUid is consulted by NOTHING in the handler module', !/staffUid/.test(CODE));
    /* POSITIVE CONTROL: the stripper must not have blanked the file, or every
       absence assertion above it passes for free. */
    ok('CONTROL — stripping left the code intact',
       CODE.length > SRC.length * 0.5 && /assertMerchantAccess/.test(CODE),
       CODE.length + '/' + SRC.length + ' chars');
    ok('the organization is never parsed out of a document id',
       !/\.split\('_'\)|splitMerchant|merchantIdFrom/.test(CODE));
    ok('decryptData is still called from nowhere', SRC.split('decryptData').length - 1 === 1);
    ok('no payment, payout or disbursement code was added',
       !/sendMoneyB2C|disburse|payout|initiatePayment/i.test(SRC));
    ok('no new payslip state was introduced', !/'paid'/.test(SRC));
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    ok('the dead staffUid rule arm is left exactly as it was',
       /resource\.data\.staffUid == request\.auth\.uid/.test(rules));
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live call. firebase-admin is stubbed at the require boundary,');
  console.log('            so no Cloud Function runs and no document is written.');
  console.log('  SEPARATE  hrStaff.uid is still null, so employee self-service remains');
  console.log('            impossible and three hr* rules still guard unwritten fields.');
  console.log('            Identity binding is its own gate.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
