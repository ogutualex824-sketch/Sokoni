/* ══════════════════════════════════════════════════════════════════════════════
   PAYROLL STAFF FIELD CONTRACT — hr-payroll.html -> addStaffMember
   scripts/test-payroll-staff-contract.js

   WHAT THIS PINS
   The page sent `employeeNo`. addStaffMember destructures `employeeNumber`, its
   JSDoc names `employeeNumber`, its validation message names `employeeNumber`,
   and the staff document id is built from `employeeNumber`. callCF does no key
   remapping — it is Object.assign({}, data, { op }) — and servicesDispatch
   forwards `req` untouched. So every add-staff call failed validation, from the
   only caller that exists.

   HOW IT IS PROVEN
   The payload literal and the callCF implementation are EXTRACTED FROM THE
   SHIPPED PAGE and executed; the validation predicate is extracted from the
   SHIPPED handler. Nothing here restates either side by hand — a restatement
   would agree with itself and prove nothing about the boundary.

   SCOPE
   The field contract only. This suite has no opinion about the payslip status
   inconsistency, the runPayroll secret binding, decryptData, bank-account
   support or disbursement — each of those is its own workstream.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

const PAGE = fs.readFileSync(path.join(ROOT, 'hr-payroll.html'), 'utf8');
const HANDLER = fs.readFileSync(path.join(ROOT, 'functions/hr-payroll.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── Extract the shipped callCF and the shipped payload literal ──────────── */
function block (src, from) {
  const open = src.indexOf('{', from);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(from, i + 1); }
  }
  return null;
}
const CALLCF_SRC = block(PAGE, PAGE.indexOf('function callCF'));
const PAYLOAD_AT = PAGE.indexOf("callCF('addStaffMember'");
const PAYLOAD_SRC = PAYLOAD_AT === -1 ? null
  : block(PAGE, PAGE.indexOf('{', PAYLOAD_AT));

/* eslint-disable no-new-func */
/* callCF touches firebase; only its transform matters, so the httpsCallable is
   replaced by an identity capture. The Object.assign line is the shipped one. */
const callCF = (() => {
  /* `_sdDispatch` is declared on the line ABOVE callCF in the page, so the
     extracted function alone does not close over it. */
  const body = 'let _sdDispatch = null;\n' + strip(CALLCF_SRC)
    .replace(/functions\.httpsCallable\([^)]*\)/, '(function (p) { return p; })');
  return new Function(body + '\n return callCF;')();
})();

/* The shipped payload literal, evaluated with the page's local variables IN
   SCOPE rather than textually substituted. Substitution rewrote the shorthand
   properties — `name,` became `'Jane',` — which is a syntax error and, worse,
   would have silently changed the very key names under test. */
function buildPayload () {
  /* `reason` added 2026-09-20. Gate 3 mechanism #3 made it a REQUIRED parameter
     of addStaffMember — employment history records WHY a transition happened
     (ADR-010), and establishment is a transition like any other. The page now
     collects it, so the payload literal references it and the harness must
     supply it or the literal cannot be evaluated at all. It is supplied as a
     SCOPE VARIABLE, like every other field, never substituted into the source. */
  const fn = new Function('state', 'name', 'empNo', 'dept', 'position',
                          'salary', 'startDate', 'phone', 'email', 'reason',
                          'return (' + strip(PAYLOAD_SRC) + ');');
  return fn({ merchantId: 'm1' }, 'Jane', 'E001', 'Ops', 'Clerk',
            50000, '2026-01-01', '0700000000', 'j@x.com', 'replacing Mary');
}

/* The shipped handler's own required-field predicate, lifted verbatim. */
const REQUIRED = (() => {
  const m = HANDLER.match(/if \(!merchantId \|\| !name \|\| !(\w+) \|\| !department \|\| !position\)/);
  return m ? m[1] : null;
})();

console.log('══════════════════════════════════════════════════════════════════');
console.log('  PAYROLL STAFF FIELD CONTRACT');
console.log('══════════════════════════════════════════════════════════════════');

head('0 - controls');
ok('the shipped callCF was extracted', !!CALLCF_SRC && /Object\.assign/.test(CALLCF_SRC));
ok('the shipped payload literal was extracted', !!PAYLOAD_SRC && PAYLOAD_SRC.length > 60,
   PAYLOAD_SRC ? PAYLOAD_SRC.length + ' chars' : 'MISSING');
ok('the handler names its required id field', REQUIRED === 'employeeNumber', String(REQUIRED));

/* ── 1. THE PAYLOAD ──────────────────────────────────────────────────────── */
head('1 - the page sends the field the backend reads');
/* FAIL CLOSED. If the payload literal can no longer be evaluated — a new local
   the harness does not supply, a syntax change — that is a FAILED assertion with
   a verdict, not a TypeError that kills the run before its summary. A crash
   reads as an infrastructure problem rather than as "this proved nothing". */
let payload = null, buildError = null;
try { payload = buildPayload(); }
catch (e) { buildError = e && e.message ? e.message.slice(0, 120) : 'build failed'; }
ok('the shipped payload literal evaluates', buildError === null, buildError || '');
const sent = payload ? callCF('addStaffMember', payload) : {};
{
  ok('the payload carries employeeNumber', 'employeeNumber' in sent,
     Object.keys(sent).sort().join(','));
  ok('and no longer carries employeeNo at this boundary', !('employeeNo' in sent));
  ok('the value is the form input, unchanged', sent.employeeNumber === 'E001',
     String(sent.employeeNumber));
  /* The same UI-to-handler contract, for the field mechanism #3 made REQUIRED.
     addStaffMember rejects a blank reason, so a page that collected it and
     failed to send it would fail every call — the employeeNo defect again, in a
     new field. Asserted here rather than assumed. */
  ok('the payload carries the REQUIRED reason', 'reason' in sent,
     Object.keys(sent).sort().join(','));
  ok('  …with the value the form supplied, unchanged',
     sent.reason === 'replacing Mary', String(sent.reason));
}

/* ── 2. callCF STILL FORWARDS VERBATIM ──────────────────────────────────── */
head('2 - callCF remaps nothing');
{
  const probe = callCF('someOp', { alpha: 1, beta: 2 });
  ok('every input key survives', probe.alpha === 1 && probe.beta === 2);
  ok('only `op` is added', Object.keys(probe).sort().join(',') === 'alpha,beta,op',
     Object.keys(probe).sort().join(','));
  ok('the source performs no key translation',
     !/employeeNo\s*:|rename|mapKeys/.test(strip(CALLCF_SRC)));
  /* If callCF ever gained a remap, the payload assertion above would pass for
     the wrong reason — this is what keeps it honest. */
  ok('control — callCF is a shallow copy plus op',
     /Object\.assign\(\{\}, data \|\| \{\}, \{ op: name \}\)/.test(strip(CALLCF_SRC)));
}

/* ── 3. THE HANDLER ACCEPTS IT ──────────────────────────────────────────── */
head('3 - addStaffMember accepts the resulting shape');
{
  /* The handler's own predicate, applied to what the page actually sends. */
  const { merchantId, name, department, position } = sent;
  const idField = sent[REQUIRED];
  const rejected = (!merchantId || !name || !idField || !department || !position);
  ok('the required-field check passes', rejected === false);
  ok('and the id it will use is the submitted one', idField === 'E001', String(idField));

  /* The deterministic document id the handler builds. */
  const docId = merchantId + '_' + idField;
  ok('the staff document id is well formed', docId === 'm1_E001', docId);
  ok('it is not built from undefined', docId.indexOf('undefined') === -1);
}

/* ── 4. THE OLD MISMATCH IS CAUGHT ──────────────────────────────────────── */
head('4 - reverting the field is detected');
{
  /* Rebuild the payload with the OLD key and run the SAME predicate. */
  const old = Object.assign({}, sent);
  delete old.employeeNumber;
  old.employeeNo = 'E001';
  const rejectedOld = (!old.merchantId || !old.name || !old[REQUIRED] ||
                       !old.department || !old.position);
  ok('INVERTING CONTROL — the old employeeNo payload IS rejected', rejectedOld === true);
  ok('and would have produced an undefined document id',
     (old.merchantId + '_' + old[REQUIRED]).indexOf('undefined') > -1);
  /* Source-level tripwire, so a revert in the page itself fails here too. */
  const code = strip(PAGE);
  const addStaffCall = code.slice(code.indexOf("callCF('addStaffMember'"),
                                  code.indexOf("callCF('addStaffMember'") + 400);
  ok('the page no longer sends employeeNo to addStaffMember',
     !/employeeNo\s*:/.test(addStaffCall));
  ok('control — the tripwire can see a key in that call',
     /employeeNumber\s*:/.test(addStaffCall));
}

/* ── 5. NOTHING ELSE MOVED ──────────────────────────────────────────────── */
head('5 - strict scope');
{
  /* RE-ANCHORED 2026-09-20. This asserted that functions/hr-payroll.js was
     CLEAN in the worktree — a proxy for "the employeeNo repair was page-only".
     A later authorized gate (canonical merchant authorization) legitimately
     modifies that module, so worktree state stopped describing THIS repair's
     scope and started describing someone else's work. Asserted on the SHIPPED
     handler instead, which is what the check always meant: addStaffMember
     still consumes `employeeNumber`, and the staff document identity is still
     built from it. Stripped first — a comment naming the field would otherwise
     satisfy the check on its own. */
  {
    const h = strip(HANDLER);
    ok('addStaffMember still consumes ' + REQUIRED,
       new RegExp('\\n\\s*' + REQUIRED + ',').test(h), String(REQUIRED));
    ok('the staff document identity is still built from it',
       new RegExp('staffId\\s*=\\s*`\\$\\{merchantId\\}_\\$\\{' + REQUIRED + '\\}`').test(h));
    ok('the staff document is written carrying it',
       new RegExp('t\\.set\\(staffRef,[\\s\\S]{0,400}' + REQUIRED).test(h));
    /* POSITIVE CONTROL. Without this, a matcher that can match NOTHING would
       report the invariant as broken — or, inverted, a broken matcher would
       report it as held. */
    ok('CONTROL — the same matcher finds a field known to be consumed',
       /\n\s*department,/.test(h));
    ok('CONTROL — and does NOT find the retired spelling',
       !/\n\s*employeeNo,/.test(h));
  }
  const code = strip(PAGE);
  ok('the form input keeps its own id', /getElementById\('staffEmpNo'\)|empNo\s*=/.test(code),
     'form field not renamed');
  ok('no payslip, disbursement or bank field was introduced',
     !/disburse|payout|bankAccount|accountNumber/i.test(code));
  /* decryptData and the secret binding are other workstreams; assert they were
     not dragged in. */
  ok('no crypto or secret handling appears on the page',
     !/decryptData|encryptData|PAYROLL_ENCRYPTION_KEY/.test(code));
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  a live call. callCF\'s httpsCallable is replaced by an identity');
console.log('            capture, so no function is invoked and no record is created.');
console.log('  SEPARATE  line ~1072 renders s.employeeNo from the STAFF DOCUMENT, which the');
console.log('            backend writes as employeeNumber. That is the READ side of the same');
console.log('            mismatch and is deliberately NOT repaired here.');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
