'use strict';
/* D1 FOUNDATION — vendor-neutral verification contract.
 *
 *   node scripts/test-d1-verification-foundation.js
 *
 * The thirteen required cases, plus the controls that keep them honest. Most of what must be
 * proven here is that something CANNOT happen, and an absence is easy to assert by accident — so
 * each refusal is paired with the positive case that proves the probe can see a success at all.
 *
 * No vendor, no region, no retention value, no threshold literal: the null adapter is the subject,
 * because "no automated verification configured" is a state the system must handle correctly
 * rather than a gap to be filled later. */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'functions', 'verification-adapter'));
const V = require(path.join(ROOT, 'functions', 'verification-authority'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 80) + ']' : '')); ok ? pass++ : fail++; };
const throws = (l, fn, match) => {
  try { fn(); ck(l, false, 'did NOT throw'); }
  catch (e) { ck(l, match ? new RegExp(match, 'i').test(e.message) : true, e.message.slice(0, 70)); }
};

const REVIEWER = { capabilities: ['application_verification_reviewer'] };
const R1 = 'reviewer-one', R2 = 'reviewer-two', APPLICANT = 'applicant-uid';

console.log('\nD1 VERIFICATION FOUNDATION\n' + '='.repeat(66));

console.log('\n1 - a client cannot manufacture verification state');
/* The deployed rules give both collections a read clause and NO write clause. Asserted from the
   shipped ruleset rather than from memory of it. */
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const blockOf = (c) => {
  const m = new RegExp('match\\s+/' + c + '/\\{[^}]*\\}\\s*\\{[\\s\\S]*?\\n\\s*\\}').exec(rules);
  return m ? m[0] : null;
};
/* The property is that NO CLIENT WRITE IS PERMITTED — not a particular spelling of that. Two
   shapes satisfy it and both are in use across the lineages: the deployed ruleset omits the write
   clause entirely (default deny), this tree writes `allow write: if false` (explicit deny). An
   earlier version of this check required "no write clause" and failed on the explicit form, which
   is asserting spelling rather than permission. */
const permitsClientWrite = (block) => {
  const clauses = block.match(/allow\s+(?:write|create|update|delete)[^;]*;/g) || [];
  return clauses.some((c) => !/:\s*if\s+false\s*;?\s*$/.test(c.replace(/\/\/.*$/, '').trim()));
};
for (const c of ['providerVerification', 'driverVerification']) {
  const b = blockOf(c);
  ck('1  ' + c + ': no client write is PERMITTED', !!b && !permitsClientWrite(b),
    b ? ((b.match(/allow\s+(?:write|create|update|delete)[^;]*;/g) || ['(no write clause)'])[0]).trim().slice(0, 44) : 'BLOCK MISSING');
}
/* Control: the checker must be able to SEE a permissive write, or the two passes above prove
   nothing. */
ck('1b the permit-detector catches a genuinely open write (control)',
  permitsClientWrite('match /x/{y} { allow write: if request.auth != null; }') === true);
ck('1c and they ARE readable by owner/admin (probe can see a real clause)',
  /allow\s+read/.test(blockOf('providerVerification') || ''));

console.log('\n2 - an arbitrary document URL cannot become authoritative');
throws('2  an unknown document kind is refused, not ignored',
  () => V.resolveSubmittedDocuments(APPLICANT, ['nationalId', 'evil']), 'unknown document kind');
const paths = V.resolveSubmittedDocuments(APPLICANT, ['nationalId', 'selfie']);
ck('2b paths are SERVER-derived from the authenticated uid',
  paths.nationalIdPath === 'documents/' + APPLICANT + '/nationalId'
  && paths.selfiePath === 'documents/' + APPLICANT + '/selfie', paths.nationalIdPath);
ck('2c a client-supplied URL has no way into the resolved set',
  Object.values(paths).every((p) => p.startsWith('documents/' + APPLICANT + '/')));
const submitSrc = fs.readFileSync(path.join(ROOT, 'functions', 'provider-onboarding.js'), 'utf8');
ck('2d the intake REFUSES a supplied *Url instead of dropping it',
  /Document URLs are no longer accepted/.test(submitSrc));

console.log('\n3-4 - reviewer seats');
const assisted = { verificationRoute: 'assisted', status: V.STATE.PENDING_REVIEW };
const first = V.applyReviewerDecision(assisted, { actor: R1, subjectUid: APPLICANT, decision: 'approve', claims: REVIEWER });
ck('3  one reviewer CANNOT complete a two-review decision',
  first.complete === false && first.patch.humanDecision === null, 'status=' + first.patch.status);
ck('3b the record says WHY it is still pending', first.patch.decisionPending === 'awaiting_second_reviewer');
throws('4  the SAME reviewer cannot occupy both seats',
  () => V.applyReviewerDecision({ ...assisted, ...first.patch }, { actor: R1, subjectUid: APPLICANT, decision: 'approve', claims: REVIEWER }),
  'second, independent reviewer');
const second = V.applyReviewerDecision({ ...assisted, ...first.patch }, { actor: R2, subjectUid: APPLICANT, decision: 'approve', claims: REVIEWER });
ck('4b two DISTINCT reviewers complete it (positive control)',
  second.complete === true && second.patch.humanDecision === 'approved', 'seats ' + second.seatsFilled + '/' + second.seatsRequired);

console.log('\n5 - an unauthorized admin cannot act as a verification reviewer');
ck('5  plain admin claim does NOT carry the capability', V.hasVerificationCapability({ admin: true }) === false);
throws('5b and is refused at the gate',
  () => V.applyReviewerDecision(assisted, { actor: R1, subjectUid: APPLICANT, decision: 'approve', claims: { admin: true } }),
  'capability required');
ck('5c superAdmin retains authority (positive control)', V.hasVerificationCapability({ superAdmin: true }) === true);
const adminSrc = fs.readFileSync(path.join(ROOT, 'functions', 'admin-os.js'), 'utf8');
ck('5d the callable asserts the capability, not just _requireAdmin',
  /assertVerificationReviewer\(req\.auth\?\.token/.test(adminSrc));

console.log('\n6 - an applicant cannot review themselves');
throws('6  self-review refused even holding the capability',
  () => V.applyReviewerDecision(assisted, { actor: APPLICANT, subjectUid: APPLICANT, decision: 'approve', claims: REVIEWER }),
  'your own verification');

console.log('\n7-8 - rejection reasons and idempotency');
throws('7  a rejection still requires a reason',
  () => V.applyReviewerDecision({ status: V.STATE.PENDING_REVIEW }, { actor: R1, subjectUid: APPLICANT, decision: 'reject', claims: REVIEWER }),
  'needs a reason');
ck('7b a rejection WITH a reason succeeds (positive control)',
  V.applyReviewerDecision({ status: V.STATE.PENDING_REVIEW },
    { actor: R1, subjectUid: APPLICANT, decision: 'reject', reason: 'blurry ID', claims: REVIEWER }).complete === true);
ck('8  repeating a decision the record already carries is idempotent',
  V.isIdempotentRepeat({ status: V.STATE.ON_FILE }, 'approve') === true);
ck('8b but a PENDING record is not treated as already-decided',
  V.isIdempotentRepeat({ status: V.STATE.ON_FILE, decisionPending: 'awaiting_second_reviewer' }, 'approve') === false);

console.log('\n9 - existing priorDecisions[] history is preserved');
const withHistory = { status: V.STATE.REJECTED, reviewNotes: 'old reason', reviewedBy: 'old-rev',
  priorDecisions: [{ status: 'rejected', reviewedBy: 'older' }] };
const kept = V.applyReviewerDecision(withHistory, { actor: R1, subjectUid: APPLICANT, decision: 'approve', claims: REVIEWER });
ck('9  the earlier entry survives and the superseded decision is appended',
  Array.isArray(kept.patch.priorDecisions) && kept.patch.priorDecisions.length === 2
  && kept.patch.priorDecisions[0].reviewedBy === 'older', (kept.patch.priorDecisions || []).length + ' entries');

console.log('\n10 - provider and driver converge on one schema');
ck('10  the shared vocabulary keeps the LIVE token verified_on_file', V.STATE.ON_FILE === 'verified_on_file');
const lifecycleSrc = fs.readFileSync(path.join(ROOT, 'functions', 'application-lifecycle.js'), 'utf8');
ck('10b the driver projection writes the shared review fields',
  /verificationRoute: null/.test(lifecycleSrc) && /humanDecision: null/.test(lifecycleSrc));
ck('10c and does NOT infer humanDecision from documentsComplete',
  !/humanDecision:\s*'approved'/.test(lifecycleSrc));

console.log('\n11-12 - NULL ADAPTER SAFETY: absence is never approval');
ck('11  no vendor is configured', A.isConfigured() === false);
ck('11b an empty result routes to ASSISTED', A.decideRoute(A.emptyResult()).route === A.ROUTE.ASSISTED);
ck('11c ...and never to automated', A.decideRoute(A.emptyResult()).route !== A.ROUTE.AUTOMATED);
ck('11d a record with NO face evidence is NOT official',
  V.isOfficial({ applicationApproved: true, documentsComplete: true, status: V.STATE.ON_FILE,
                 humanDecision: 'approved' }).official === false, 'absence must not pass');
ck('11e the SAME record via the assisted route IS official (positive control)',
  V.isOfficial({ applicationApproved: true, documentsComplete: true, status: V.STATE.ON_FILE,
                 humanDecision: 'approved', verificationRoute: 'assisted' }).official === true);

/* 12 — a fabricated positive cannot be produced from client input. */
const fabricated = { livenessResult: 'pass', faceMatchScore: 0.99, automatedOutcome: 'approved',
                     official: true, humanDecision: 'approved', documentsComplete: true };
ck('12  a client-shaped positive result still needs a CONFIGURED threshold',
  A.decideRoute(fabricated).route === A.ROUTE.ASSISTED, 'no threshold configured -> assisted');
ck('12b a submitted official:true does not make a record official',
  V.isOfficial({ ...fabricated, applicationApproved: false }).official === false, 'application_not_approved');
ck('12c documentsComplete is DERIVED, not taken from input',
  V.deriveDocumentsComplete({ nationalIdPath: 'x' }, ['nationalId', 'licence']).documentsComplete === false,
  'missing licence');
ck('12d ...and derives TRUE when the paths are present (positive control)',
  V.deriveDocumentsComplete({ nationalIdPath: 'x', licencePath: 'y' }, ['nationalId', 'licence']).documentsComplete === true);
/* A score of 0 is a real measurement — it must not be mistaken for "absent". */
ck('12e a score of 0 is treated as a measurement, not as missing',
  A.decideRoute({ livenessResult: 'pass', faceMatchScore: 0 }, 0.8).failureClass === A.FAILURE_CLASS.MATCH_LOW_CONFIDENCE);

/* THE undefined !== false CLASS, exercised WITH a threshold configured.
   Removing the presence guard left the suite green, because with no threshold nothing can reach
   automated — a second layer masking the first. But once a threshold IS configured the masking
   stops: `null < 0.8` is true (assisted, by luck), while `undefined < 0.8` is FALSE and falls
   through to AUTOMATED. An absent score must never approve, whichever flavour of absent it is. */
for (const [label, score] of [['undefined', undefined], ['null', null], ['NaN', NaN], ['""', '']]) {
  ck('12f absent score (' + label + ') + configured threshold -> ASSISTED',
    A.decideRoute({ livenessResult: 'pass', faceMatchScore: score }, 0.8).route === A.ROUTE.ASSISTED);
}
ck('12g absent LIVENESS + configured threshold -> ASSISTED',
  A.decideRoute({ faceMatchScore: 0.99 }, 0.8).route === A.ROUTE.ASSISTED);
ck('12h ...while a complete result with a configured threshold DOES pass (control)',
  A.decideRoute({ livenessResult: 'pass', faceMatchScore: 0.99 }, 0.8).route === A.ROUTE.AUTOMATED);

console.log('\n13 - no vendor, region, retention or threshold literal leaked into the patch');
const adapterSrc = fs.readFileSync(path.join(ROOT, 'functions', 'verification-adapter.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(ROOT, 'functions', 'verification-authority.js'), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [n, s] of [['adapter', code(adapterSrc)], ['authority', code(authSrc)]]) {
  ck('13  ' + n + ': no vendor named', !/persona|sumsub|veriff/i.test(s));
  ck('13  ' + n + ': no region hard-coded', !/us-central|europe-west|eu-west|nam5/i.test(s));
  ck('13  ' + n + ': no retention literal', !/\b30\s*\*\s*24|retentionDays\s*=\s*\d/.test(s));
}
ck('13d no default confidence threshold', !/threshold\s*=\s*0?\.\d/.test(code(adapterSrc)));

console.log('\n' + '-'.repeat(66));
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
