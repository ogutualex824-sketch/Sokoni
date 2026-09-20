/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT AUTHORITY PROVENANCE — Gate 3 mechanism #2
   scripts/test-merchant-authority-provenance.js

   WHAT THIS PINS
   `assertMerchantAccess` evaluated four granting arms and returned the SAME
   bare string from each, discarding the distinction between owning an
   organization and merely having access to it. `resolveMerchantAccess` now
   returns { merchantId, via }; `assertMerchantAccess` is that with the
   provenance dropped; `assertMerchantOwner` filters on `via` (ADR-035 §2).

   THE CENTRAL TRAP
   All four arms still produce an ALLOW from `assertMerchantAccess`, so a test
   that only checks "allowed" cannot tell them apart and would pass against the
   unrepaired module. Every fixture here is therefore asserted on `via`, and the
   arms are proven MUTUALLY EXCLUSIVE and correctly ORDERED — a caller who is
   BOTH a platform admin and the owner must resolve `platform`, because that arm
   runs first. Reordering the resolver would otherwise be invisible.

   COMPATIBILITY IS THE POINT, NOT A SIDE NOTE
   `assertMerchantAccess` must still return a STRING, throw the same codes, and
   perform the same reads in the same order. The `self` arm must stay readless:
   making the resolver always read would tighten an established Gate 1 path, so
   that is asserted as forbidden rather than merely untested.

   SCOPE
   Authorization provenance only. No employment schema, uid binding, history
   collection, invitation flow or payroll behaviour is designed or touched here;
   section 6 asserts none appeared.
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

/* ── Firestore stub that COUNTS READS ─────────────────────────────────────
   The read count is an observable here, not a performance note: the design
   forbids the resolver from reading on the `self` arm, and requires exactly one
   extra read on the `platform` arm of the owner assertion. */
let DOCS = {}, READS = [];
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ({
      id,
      get: async () => {
        READS.push(name + '/' + id);
        const d = DOCS[name + '/' + id];
        return { exists: d !== undefined, id, data: () => d };
      },
    }),
  }),
};
class HttpsError extends Error {
  constructor (code, message) { super(message); this.code = code; }
}
const STUBS = {
  'firebase-admin': { firestore: () => fakeDb, apps: [{}], initializeApp () {} },
  'firebase-functions/v2/https': { HttpsError },
};
const realLoad = Module._load;
Module._load = function (r, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, r)) return STUBS[r];
  return realLoad.call(this, r, parent, isMain);
};
let MA = null, loadError = null;
try {
  delete require.cache[require.resolve(path.join(ROOT, 'functions/merchant-authority.js'))];
  MA = require(path.join(ROOT, 'functions/merchant-authority.js'));
} catch (e) { loadError = e && e.message ? e.message.slice(0, 160) : 'load failed'; }
Module._load = realLoad;

const SRC = fs.readFileSync(path.join(ROOT, 'functions/merchant-authority.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── Identities and fixtures ─────────────────────────────────────────────── */
const OWNER = 'U_OWNER', MEMBER = 'U_MEMBER', STRANGER = 'U_STRANGER';
const BOTH = 'U_BOTH';                 /* platform admin AND the owner */
const MINE = 'SOK-MINE', GHOST = 'SOK-GHOST';
/* A business with NO adminUids FIELD AT ALL — not an empty array. The fail-open
   being guarded against (`d.adminUids && !d.adminUids.includes(uid)`) evaluates
   its middle conjunct to undefined and GRANTS when the field is absent, so a
   fixture that merely has an empty array cannot detect it. */
const NOADMINS = 'SOK-NOADMINS';
const SELFORG = 'U_SELFORG';           /* a uid used as its own merchantId */

function seed () {
  READS = [];
  DOCS = {
    ['businesses/' + MINE]: { ownerId: OWNER, adminUids: [MEMBER] },  /* owner NOT in adminUids */
    ['businesses/' + BOTH]: { ownerId: BOTH, adminUids: [] },
    ['businesses/' + NOADMINS]: { ownerId: OWNER },   /* adminUids ABSENT */
    /* GHOST absent. SELFORG absent — that is the compatibility fixture. */
  };
}
const user = uid => ({ uid, token: {} });
const admin_ = uid => ({ uid, token: { admin: true } });
const superA = uid => ({ uid, token: { superAdmin: true } });

async function call (fn, auth, requested) {
  seed();
  let err = null, out;
  try { out = await fn(auth, requested); } catch (e) { err = e; }
  return { out, code: err ? (err.code || 'throw') : null, reads: READS.slice() };
}

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  MERCHANT AUTHORITY PROVENANCE — mechanism #2');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - controls');
  ok('the module loaded and executes', loadError === null && !!MA, loadError || '');
  ok('all three functions are exported',
     !!MA && ['resolveMerchantAccess', 'assertMerchantAccess', 'assertMerchantOwner']
       .every(n => typeof MA[n] === 'function'));
  ok('the authority collection is unchanged', !!MA && MA.AUTHORITY === 'businesses',
     MA ? MA.AUTHORITY : '');
  {
    const probe = await call(MA.resolveMerchantAccess, user(OWNER), MINE);
    ok('CONTROL — the stub serves documents and records reads',
       probe.out && probe.out.via === 'owner' && probe.reads.length === 1,
       'via=' + (probe.out && probe.out.via) + ' reads=' + probe.reads.length);
  }

  /* ── 1. FOUR ARMS, EACH ISOLATED ───────────────────────────────────────── */
  head('1 - every arm reports its own provenance');
  const ARMS = [
    ['owner',    user(OWNER),     MINE,    1],
    ['admin',    user(MEMBER),    MINE,    1],
    ['self',     user(SELFORG),   SELFORG, 0],
    ['platform', admin_(STRANGER), MINE,   0],
  ];
  for (const [expected, auth, mid, reads] of ARMS) {
    const r = await call(MA.resolveMerchantAccess, auth, mid);
    ok('via === ' + expected, r.out && r.out.via === expected,
       'got ' + (r.out ? r.out.via : 'code=' + r.code));
    ok('  …merchantId is returned intact', r.out && r.out.merchantId === mid,
       r.out ? r.out.merchantId : '');
    ok('  …read count is ' + reads, r.reads.length === reads,
       r.reads.join(',') || 'no reads');
  }
  {
    const s = await call(MA.resolveMerchantAccess, superA(STRANGER), MINE);
    ok('superAdmin resolves platform, same as admin', s.out && s.out.via === 'platform',
       s.out ? s.out.via : 'code=' + s.code);

    /* THE FAIL-OPEN FIXTURE. A stranger against a business with no adminUids
       field must be DENIED. The shape this guards against grants instead. */
    const noAdm = await call(MA.resolveMerchantAccess, user(STRANGER), NOADMINS);
    ok('a stranger is DENIED when the business has no adminUids field',
       noAdm.code === 'permission-denied',
       'code=' + noAdm.code + (noAdm.out ? ' via=' + noAdm.out.via : ''));
    /* INVERTING CONTROL — the same document must still admit its owner, so the
       denial above is not simply "documents without adminUids refuse everyone". */
    const ownNoAdm = await call(MA.resolveMerchantAccess, user(OWNER), NOADMINS);
    ok('  …while its OWNER is still admitted', ownNoAdm.out && ownNoAdm.out.via === 'owner',
       ownNoAdm.out ? ownNoAdm.out.via : 'code=' + ownNoAdm.code);
  }

  /* ── 2. THE ARMS ARE EXCLUSIVE AND ORDERED ─────────────────────────────── */
  head('2 - exclusivity and order');
  {
    const seen = new Set();
    for (const [, auth, mid] of ARMS) {
      const r = await call(MA.resolveMerchantAccess, auth, mid);
      if (r.out) seen.add(r.out.via);
    }
    ok('the four fixtures yield four DISTINCT values', seen.size === 4,
       [...seen].sort().join(','));
    ok('and every value is in the frozen taxonomy',
       [...seen].every(v => ['owner', 'admin', 'self', 'platform'].includes(v)));

    /* THE ORDERING TRAP. A platform admin who is ALSO the owner must resolve
       `platform`, because that arm runs first. Without this, reordering the
       resolver changes provenance silently. */
    const both = await call(MA.resolveMerchantAccess, admin_(BOTH), BOTH);
    ok('a platform admin who is ALSO the owner resolves `platform`, not `owner`',
       both.out && both.out.via === 'platform', both.out ? both.out.via : 'code=' + both.code);
    ok('  …and did so WITHOUT reading — the arm ran first', both.reads.length === 0,
       both.reads.join(',') || 'no reads');

    /* self vs owner: merchantId === uid AND a business document exists. */
    const selfOwner = await call(MA.resolveMerchantAccess, user(BOTH), BOTH);
    ok('self precedes owner when merchantId === uid and a business EXISTS',
       selfOwner.out && selfOwner.out.via === 'self',
       selfOwner.out ? selfOwner.out.via : 'code=' + selfOwner.code);
  }

  /* ── 3. THE OWNER ASSERTION ────────────────────────────────────────────── */
  head('3 - assertMerchantOwner filters on via');
  {
    const cases = [
      ['owner with a real business document',        user(OWNER),      MINE,    true],
      ['adminUids member',                           user(MEMBER),     MINE,    false],
      ['self with NO business document',             user(SELFORG),    SELFORG, false],
      ['platform admin, business exists',            admin_(STRANGER), MINE,    true],
      ['platform superAdmin, business exists',       superA(STRANGER), MINE,    true],
      ['platform admin, business ABSENT',            admin_(STRANGER), GHOST,   false],
      ['stranger, business exists',                  user(STRANGER),   MINE,    false],
      ['anyone, business absent',                    user(STRANGER),   GHOST,   false],
    ];
    for (const [name, auth, mid, allowed] of cases) {
      const r = await call(MA.assertMerchantOwner, auth, mid);
      ok((allowed ? 'ALLOWS  ' : 'DENIES  ') + name,
         allowed ? r.out === mid : r.code === 'permission-denied',
         allowed ? String(r.out) : 'code=' + r.code);
    }
    /* PLATFORM AUTHORIZATION IS NOT BUSINESS EXISTENCE — the extra read that
       enforces the distinction must actually happen. */
    const p = await call(MA.assertMerchantOwner, admin_(STRANGER), MINE);
    ok('the platform arm performs the existence read itself',
       p.reads.length === 1 && p.reads[0] === 'businesses/' + MINE,
       p.reads.join(',') || 'NO READ — existence unchecked');
    const selfR = await call(MA.assertMerchantOwner, user(SELFORG), SELFORG);
    ok('the self arm is denied WITHOUT any read', selfR.reads.length === 0,
       selfR.reads.join(',') || 'no reads');
  }

  /* ── 4. BACKWARD COMPATIBILITY ─────────────────────────────────────────── */
  head('4 - assertMerchantAccess is unchanged');
  {
    for (const [expected, auth, mid, reads] of ARMS) {
      const r = await call(MA.assertMerchantAccess, auth, mid);
      ok('the ' + expected + ' arm still ALLOWS access', r.out === mid, String(r.out));
      ok('  …returns a STRING, not an object', typeof r.out === 'string', typeof r.out);
      ok('  …with the same read count (' + reads + ')', r.reads.length === reads,
         String(r.reads.length));
    }
    /* THE COMPATIBILITY TRAP. `self` must still be allowed with no business
       document. A resolver that always read would deny here — silently
       tightening Gate 1. */
    const compat = await call(MA.assertMerchantAccess, user(SELFORG), SELFORG);
    ok('COMPATIBILITY — self is allowed with NO business document',
       compat.out === SELFORG && compat.reads.length === 0,
       'out=' + compat.out + ' reads=' + compat.reads.length);

    /* Error taxonomy, unchanged. */
    const errs = [
      ['no auth',            null,             MINE,  'unauthenticated'],
      ['auth without uid',   { token: {} },    MINE,  'unauthenticated'],
      ['id containing a /',  user(STRANGER),   'a/b', 'invalid-argument'],
      ['business absent',    user(STRANGER),   GHOST, 'permission-denied'],
      ['no arm matched',     user(STRANGER),   MINE,  'permission-denied'],
    ];
    for (const [name, auth, mid, code] of errs) {
      const r = await call(MA.assertMerchantAccess, auth, mid);
      ok('throws ' + code + ' — ' + name, r.code === code, 'code=' + r.code);
    }
    /* The default-to-caller arm. */
    const dflt = await call(MA.assertMerchantAccess, user(SELFORG), undefined);
    ok('an omitted merchantId still defaults to the caller', dflt.out === SELFORG,
       String(dflt.out));

    /* canAccessMerchant — exported, zero production consumers, must still work. */
    /* FAIL CLOSED. Calling a missing export throws a TypeError, which kills the
       run before its summary — and a sabotage runner that looks for a FAIL line
       reads that as a PASS. Measured: removing this export scored GREEN. */
    if (typeof MA.canAccessMerchant !== 'function') {
      ok('canAccessMerchant is still exported as a function', false, 'MISSING');
    } else {
      seed();
      const yes = await MA.canAccessMerchant(user(OWNER), MINE);
      const no = await MA.canAccessMerchant(user(STRANGER), MINE);
      ok('canAccessMerchant returns booleans and never throws',
         yes === true && no === false, 'true/false = ' + yes + '/' + no);
    }
    ok('isValidMerchantId is unchanged',
       typeof MA.isValidMerchantId === 'function'
       && MA.isValidMerchantId('SOK-A') === true && MA.isValidMerchantId('a/b') === false
       && MA.isValidMerchantId('') === false);
  }

  /* ── 5. THE MODULE SHAPE ───────────────────────────────────────────────── */
  head('5 - export shape is additive only');
  {
    /* Four procurement slice suites re-require this module under a stubbed
       firebase-admin, so a removed or renamed export breaks tests that never
       import it directly. */
    const required = ['assertMerchantAccess', 'canAccessMerchant', 'isValidMerchantId', 'AUTHORITY'];
    ok('every pre-existing export survives', required.every(k => k in MA),
       required.filter(k => !(k in MA)).join(',') || 'all present');
    ok('and the two new ones are present',
       'resolveMerchantAccess' in MA && 'assertMerchantOwner' in MA);
  }

  /* ── 6. STRICT SCOPE ───────────────────────────────────────────────────── */
  head('6 - no Gate 3 implementation leaked in');
  {
    ok('the resolver still reads only the authority collection',
       (CODE.match(/collection\(/g) || []).length === (CODE.match(/collection\(AUTHORITY\)/g) || []).length,
       'collection() calls all target AUTHORITY');
    ok('no employment schema appears',
       !/employmentStatus|workStatus|hrStaff|employeeNumber/.test(CODE));
    ok('no identity binding appears', !/\buid:\s*null|rebind|acceptInvite/i.test(CODE));
    ok('no history or invitation collection appears',
       !/employmentHistory|shopInvites|hrHistory/.test(CODE));
    ok('no payroll or payment code appears',
       !/payroll|payslip|disburse|sendMoneyB2C/i.test(CODE));
    /* POSITIVE CONTROL: the stripper must not have blanked the file. */
    /* A LENGTH RATIO is the wrong control here: this module is ~76% comment,
       so a correct strip legitimately removes most of the file. Assert on what
       the stripped CODE must still CONTAIN instead. */
    const MUST = ["via: 'owner'", "via: 'admin'", "via: 'self'", "via: 'platform'",
                  'function resolveMerchantAccess', 'function assertMerchantAccess',
                  'function assertMerchantOwner', "AUTHORITY = 'businesses'"];
    const missing = MUST.filter(m => !CODE.includes(m));
    ok('CONTROL — stripping left every load-bearing statement intact',
       missing.length === 0, missing.join(' | ') || CODE.length + ' chars of code');
    /* RE-ANCHORED 2026-09-20. This also named `firestore.rules`, which was
       correct when written: mechanism #2 is pure JavaScript and touches no
       ruleset. Mechanism #4 (employment history) legitimately adds an
       `employmentEvents` block, so the file is no longer this gate's to claim —
       and a scope assertion that fails on ANOTHER gate's authorized work stops
       describing this one's scope. Narrowed to the two modules mechanism #2
       genuinely must not touch: the payroll handlers it authorizes, and the
       crm.js fail-open it deliberately leaves alone (ADR-035 §8). */
    const g = require('child_process').execFileSync('git',
      ['-C', ROOT, 'status', '--porcelain', '--', 'functions/hr-payroll.js', 'functions/crm.js'],
      { encoding: 'utf8' }).trim();
    ok('hr-payroll.js and crm.js are untouched', g === '', g || 'clean');
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live call. firebase-admin is stubbed at the require boundary.');
  console.log('  SEPARATE  assertMerchantOwner has NO caller yet. It is the mechanism, not');
  console.log('            its adoption; employment handlers are a later gate.');
  console.log('  SEPARATE  the crm.js fail-open (ADR-035 §8) is deliberately untouched.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n  HARNESS CRASH — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
