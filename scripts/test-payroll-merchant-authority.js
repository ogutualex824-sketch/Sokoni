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
  /* RE-ANCHORED 2026-09-20. This counted EIGHT requested-merchantId boundaries.
     Gate 3 mechanism #3 moved ONE of them — addStaffMember — onto the
     provenance resolver, because establishing employment is owner authority and
     assertMerchantAccess discards the `via` that decision needs. So the shape is
     now SEVEN request-bound boundaries plus ONE establishment boundary, and the
     assertion DISCRIMINATES them syntactically rather than counting a total: a
     total would be satisfied by eight of either kind. */
  const ESTABLISH_FORM = /const \{ via \} = await resolveMerchantAccess\(req\.auth, merchantId\);/g;
  const ESTABLISH = (CODE.match(ESTABLISH_FORM) || []).length;
  ok('seven request-bound assertMerchantAccess boundaries remain',
     REQUESTED === 7, REQUESTED + ' of the requested form');
  ok('and ONE establishment boundary resolves provenance instead',
     ESTABLISH === 1, ESTABLISH + ' resolveMerchantAccess establishment site(s)');
  ok('  …gated on owner | platform, never admin or self',
     /if \(via !== 'owner' && via !== 'platform'\)/.test(CODE));
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
  /* CONTRACT CHANGE, NOT ANCHOR ROT. addStaffMember is no longer a
     merchant-ACCESS handler: mechanism #3 made establishment owner authority
     (ADR-035 §2), so `admin` and `self` are now DENIED there by design. That is
     a different expectation, asserted below in BOTH directions, not a stale
     string. Every other handler keeps the Gate 1 contract unchanged. */
  const ESTABLISHMENT = 'addStaffMember';
  for (const [name, tier, mk] of CASES) {
    if (name === ESTABLISHMENT) continue;
    const owner  = await invoke(name, reach(tier, OWNER),  mk(MINE));
    const member = await invoke(name, reach(tier, MEMBER), mk(MINE));
    const sole   = await invoke(name, reach(tier, OWNER),  mk(SOLE));
    ok(name + ' admits the business owner',        !owner.denied,  'code=' + owner.code);
    ok(name + ' admits an adminUids member',       !member.denied, 'code=' + member.code);
    /* ISOLATES ownerId: this organization has no adminUids at all. */
    ok(name + ' admits an owner who is NOT an adminUid', !sole.denied, 'code=' + sole.code);
  }

  head('2b - addStaffMember is ESTABLISHMENT authority, proven both ways');
  {
    const mk = CASES.find(c => c[0] === ESTABLISHMENT)[2];
    const owner = await invoke(ESTABLISHMENT, reach('claim', OWNER), mk(MINE));
    ok('PERMITS the business owner', !owner.denied, 'code=' + owner.code);
    const sole = await invoke(ESTABLISHMENT, reach('claim', OWNER), mk(SOLE));
    ok('PERMITS an owner who is NOT an adminUid', !sole.denied, 'code=' + sole.code);
    const plat = await invoke(ESTABLISHMENT, asAdmin('U_PLATFORM'), mk(MINE));
    ok('PERMITS a platform admin — ratified 2a', !plat.denied, 'code=' + plat.code);

    const member = await invoke(ESTABLISHMENT, reach('claim', MEMBER), mk(MINE));
    ok('DENIES an adminUids member — access is not employment authority',
       member.denied, 'code=' + member.code);
    /* ADR-035 §2 froze `self` as NEVER employment authority: the arm returns
       before reading anything and cannot confirm the organization exists. */
    const self = await invoke(ESTABLISHMENT, reach('claim', 'U_SELFORG'), mk('U_SELFORG'));
    ok('DENIES the self arm — merchantId === uid proves nothing was created',
       self.denied, 'code=' + self.code);
    const stranger = await invoke(ESTABLISHMENT, reach('claim', STRANGER), mk(MINE));
    ok('DENIES a stranger', stranger.denied, 'code=' + stranger.code);
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
  /* addStaffMember is EXCLUDED, and its opposite expectation is asserted in 2b.
     The legacy form IS the `self` arm, which ADR-035 §2 froze as never
     employment authority — so the very compatibility this section protects for
     the other seven handlers is deliberately absent from establishment. */
  for (const [name, tier, mk] of CASES) {
    if (name === ESTABLISHMENT) continue;
    const r = await invoke(name, reach(tier, 'U_LEGACY'), mk('U_LEGACY'));
    ok(name + ' admits a merchant whose merchantId IS their uid', !r.denied, 'code=' + r.code);
  }
  {
    const est = await invoke(ESTABLISHMENT, reach('claim', 'U_LEGACY'),
                            CASES.find(c => c[0] === ESTABLISHMENT)[2]('U_LEGACY'));
    ok('CONTRAST — establishment REFUSES the same legacy form, by design',
       est.denied, 'code=' + est.code);
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

    /* PARSER FIX 2026-09-20. This called `.trim()` on the WHOLE porcelain output
       before splitting, which strips the leading space of the FIRST line only.
       `git status --porcelain` emits a two-character index/worktree prefix, so
       an unstaged change prints " M path" — and after a global trim that became
       "M path", whose slice(3) is "ath"… in practice "restore.rules" for
       "firestore.rules". The path silently never appeared in the list.

       MEASURED: this assertion passed while firestore.rules WAS modified, and
       only failed once staging changed the prefix to "M  ". It was green for the
       wrong reason for as long as it existed. Each line is now parsed
       independently, with the two-character prefix preserved. */
    const porcelain = () => g(['status', '--porcelain'])
      .split('\n').filter(l => l.length > 0);
    const pathsOf = lines => lines.map(l => l.slice(3)).sort();
    const changed = pathsOf(porcelain());

    /* REGRESSION CONTROL for the parser itself. Both prefixes must resolve to
       the same path, and the FIRST-LINE case is the one that broke. Synthetic
       input, so it holds regardless of what the working tree happens to contain. */
    {
      const unstagedFirst = ['" M firestore.rules"'.slice(1, -1), 'M  other.js'];
      const stagedFirst = ['M  firestore.rules', ' M other.js'];
      ok('CONTROL — the parser reads " M firestore.rules" as the first line',
         pathsOf(unstagedFirst).includes('firestore.rules'), pathsOf(unstagedFirst).join('|'));
      ok('CONTROL — and reads "M  firestore.rules" as the first line',
         pathsOf(stagedFirst).includes('firestore.rules'), pathsOf(stagedFirst).join('|'));
      ok('CONTROL — the OLD global-trim parse would have missed the unstaged one',
         !unstagedFirst.join('\n').trim().split('\n').map(l => l.slice(3).trim())
            .includes('firestore.rules'));
    }

    /* SCOPE NARROWED 2026-09-20. `firestore.rules` was removed from this gate's
       claim: mechanism #4 (employment history) legitimately adds an
       employmentEvents block, so the ruleset is no longer Gate 1's to protect.
       The files this gate genuinely must not touch are asserted below. */

    /* ── THE GATE 1 CLAIM, RESTORED AGAINST ITS LANDING 2026-09-20 ──────────
       The comment above is kept: its reasoning was right, and it is the
       evidence for this repair. `firestore.rules` was dropped because a
       LIVE-TREE check cannot distinguish "Gate 1 touched the ruleset" from
       "some other gate has the ruleset open right now" — and mechanism #4
       legitimately had it open. The path did not leave Gate 1's scope; the
       anchor could not express the claim.

       Gate 1 landed at f4de0c1, which ADDED this suite. Against that frozen
       boundary the ruleset is untouched permanently, and no later mechanism can
       make it look otherwise. So the claim is restored, not re-litigated.

       SCOPE OF THIS REPAIR. Only the Gate 1 claim is re-anchored. The two
       assertions below still read the LIVE TREE and are DELIBERATELY LEFT
       ALONE: `crm.js` and `merchant-authority.js` were never part of Gate 1's
       landing claim — they were installed here by mechanism #4 (2197b48),
       replacing the ruleset rather than narrowing it. Whether they are
       historical scope assertions that belong to another gate's boundary, or
       independent current contracts that merely live in this file, is an
       OWNERSHIP question this repair does not answer. Re-anchoring them to
       f4de0c1 would silently attribute to Gate 1 two claims Gate 1 never made.
       Pending separate adjudication; `crm.js` is also protected in
       test-merchant-authority-provenance.js, whose mechanism does own it. */
    const gitAt = (...a) => require('child_process')
      .execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();

    /* Self-verifying: a bare SHA would silently compare the wrong commit if
       history were rewritten, and that empty diff reads exactly like a landing
       that respected its boundary. The landing is named by what it DID. */
    const G1 = 'f4de0c1';
    const SELF = 'scripts/test-payroll-merchant-authority.js';
    let anchorOk = false, added = '';
    try {
      added = gitAt('show', '--name-status', '--format=', G1, '--', SELF);
      anchorOk = new RegExp('^A\\s+' + SELF.replace(/[.\/]/g, '\\$&') + '$', 'm').test(added);
    } catch (e) { added = 'ref unresolved: ' + ((e && e.message) || '').slice(0, 60); }
    ok('the Gate 1 landing resolves, and is the commit that ADDED this suite',
       anchorOk, added || 'no output');

    if (!anchorOk) {
      ok('GATE 1 SCOPE ANCHOR UNVERIFIABLE — refusing to report a scope verdict', false,
         'the boundary could not be established, so "untouched" would be unproven');
    } else {
      const touched = gitAt('diff', '--name-only', G1 + '~1', G1, '--', 'firestore.rules');
      ok('firestore.rules is untouched BY THE GATE 1 LANDING',
         touched === '', touched || 'the ruleset is not in the landing');

      /* POSITIVE CONTROL — an empty diff is equally consistent with a landing
         that respected its boundary and a comparison that can never match. */
      const control = gitAt('diff', '--name-only', G1 + '~1', G1, '--', 'functions/hr-payroll.js');
      ok('CONTROL: the same comparison DOES report the file the landing changed',
         control === 'functions/hr-payroll.js', control || 'EMPTY — the detector is blind');

      /* SCOPE CONTROL — the landing changed files outside the protected set,
         and the assertion must not redden on those, or it is a global
         cleanliness check wearing a scope check's name. */
      const outside = gitAt('diff', '--name-only', G1 + '~1', G1, '--', SELF);
      ok('  …and the landing DID change files outside the protected set',
         outside === SELF, outside);
    }

    /* ── ADR-035 §8 — THE crm.js FAIL-OPEN IS STILL THERE ───────────────────
       ADJUDICATED 2026-09-20. This was `!changed.includes('functions/crm.js')`
       — a git-cleanliness check. Its stated reason was a CURRENT CONTRACT
       ("its fail-open is ADR-035 §8, a separate repair") but its implementation
       was a scope check, and the two do not meet: a clean file tells you
       nothing about whether the defect it names still exists. A repair of
       crm.js, once committed, would have left this green while the invariant it
       claims had become false.

       The invariant is STANDING and boundary-independent — nobody may repair
       the §8 fail-open as a side effect of other work — so it must NOT be
       anchored to a landing. It is asserted BEHAVIOURALLY instead.

       THE FAIL-OPEN, crm.js:94:
           if (data.ownerId !== uid && data.adminUids && !data.adminUids.includes(uid))
       With `adminUids` ABSENT the middle term is falsy, the condition is false,
       and a NON-OWNER is granted. Exercised through `createLead`, a shipped
       callable, so this proves the fail-open is REACHABLE and not merely
       present in a private function — `assertMerchantOwner` is not exported. */
    {
      const HttpsErr = HttpsError;
      const MERCHANT = 'M-FAILOPEN';
      /* The merchant document shape that arms it: an owner who is NOT the
         caller, and NO adminUids field at all. */
      let FIXTURE = { ownerId: 'someone-else' };
      const crmDb = {
        collection: (n) => ({
          doc: (id) => ({ id, get: async () => ({
            exists: n === 'merchants' && id === MERCHANT,
            data: () => FIXTURE,
          }) }),
          add: async () => ({ id: 'lead-1' }),
          where () { return this; }, orderBy () { return this; }, limit () { return this; },
          get: async () => ({ empty: true, docs: [], size: 0, forEach () {} }),
        }),
        batch: () => ({ set () {}, update () {}, commit: async () => {} }),
      };
      const crmStubs = {
        'firebase-admin': (() => {
          const f = () => crmDb;
          f.FieldValue = { serverTimestamp: () => 'TS', increment: n => n };
          f.Timestamp = { now: () => 'TS', fromDate: d => d };
          return { firestore: f, apps: [{}], initializeApp () {} };
        })(),
        'firebase-functions/v2/https': { onCall: (_o, fn) => (typeof _o === 'function' ? _o : fn), HttpsError: HttpsErr },
        'firebase-functions/v2/scheduler': { onSchedule: (_o, fn) => (typeof _o === 'function' ? _o : fn) },
        'firebase-functions/params': { defineSecret: () => ({ value: () => '0'.repeat(64) }) },
      };
      let CRM = null, crmErr = null;
      const prevLoad = Module._load;
      Module._load = function (req, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(crmStubs, req)) return crmStubs[req];
        return prevLoad.call(this, req, parent, isMain);
      };
      try { CRM = require(path.join(ROOT, 'functions/crm.js')); }
      catch (e) { crmErr = (e && e.message) ? e.message.slice(0, 120) : 'load failed'; }
      Module._load = prevLoad;

      ok('CONTROL — the shipped crm.js loads and exposes createLead',
         !!(CRM && typeof CRM.createLead === 'function'), crmErr || 'loaded');

      const callCreate = async () => {
        try {
          await CRM.createLead({ auth: { uid: 'not-the-owner' },
            data: { merchantId: MERCHANT, name: 'Lead', phone: '0700000000', source: 'online' } });
          return null;
        } catch (e) { return e.code || 'throw'; }
      };

      if (CRM && typeof CRM.createLead === 'function') {
        const granted = await callCreate();
        ok('ADR-035 §8: the crm.js fail-open is STILL PRESENT — a non-owner is admitted '
           + 'when adminUids is absent (deliberately unrepaired)',
           granted === null, 'refused with ' + granted);

        /* INVERTING FIXTURE CONTROL. Without this, a future repair of crm.js
           could be masked by a fixture that never arms the fail-open in the
           first place — the assertion above would pass for the wrong reason.
           With adminUids PRESENT the middle term is truthy and the guard works,
           so this MUST be refused. */
        FIXTURE = { ownerId: 'someone-else', adminUids: ['yet-another'] };
        const refused = await callCreate();
        ok('INVERTING CONTROL: with adminUids PRESENT the same call is REFUSED — '
           + 'so the fixture really does arm the fail-open',
           refused === 'permission-denied', String(refused));
        FIXTURE = { ownerId: 'someone-else' };
      }
    }

    /* RETIRED 2026-09-20 — `merchant-authority.js is untouched by THIS gate`.
       It was a live-tree cleanliness check, and it was NEVER FUNCTIONAL:

           17:17:33  f4de0c1  Gate 1 lands
           19:04:41  0eee8e4  mechanism #2 MODIFIES merchant-authority.js
           19:53:22  2197b48  this assertion is ADDED — 49 minutes later

       The only change it could ever have observed had already been committed
       when it was written, so it passed trivially from its first run. It was
       also never Gate 1's claim: f4de0c1 references merchant-authority.js only
       as the MODULE UNDER TEST, never as a protected path. Re-anchoring it to
       f4de0c1 or 2197b48 would have asserted a scope fact nobody set out to
       claim, so it is removed rather than repaired. The history is kept here
       and in the changelog; only the dead assertion is gone. */
    /* RE-ANCHORED 2026-09-20. The old regex pinned `status: 'active', uid: null`
       — the neighbouring FIELD NAME, not the property under test. Mechanism #3
       renamed the axis and changed the birth state; `uid` is still null, which
       is what this assertion was always about. The new anchor names all three
       parts of the established state explicitly. */
    ok('establishment writes pending / null / unbound',
       /employmentStatus: 'pending', workStatus: null, uid: null,/.test(SRC));
    ok('  …and the payable `active + uid null` birth state is GONE',
       !/employmentStatus: 'active'[^\n]*uid: null/.test(SRC) && !/status: 'active', uid: null/.test(SRC));
    ok('no uid binding is introduced AT ESTABLISHMENT',
       SRC.split('uid: null').length - 1 === 1);
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
