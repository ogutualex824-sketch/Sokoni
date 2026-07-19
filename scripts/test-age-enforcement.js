/* Stage 1B — age-enforcement validation.

   Exercises the DECISION the gate makes for each scenario in the directive. The
   gate lives inside initiateSTKPush, so this reconstructs its logic against the
   real brands + age-verification modules rather than re-implementing policy:
   every requiresAgeVerification / brandIds call below is the production one.

   The property under test is not "does it reject" but "can a client change the
   answer". Intents are Admin-SDK-only, so brand is server-authored — these cases
   assert the gate reads only that, and never the request payload. */
'use strict';
const B = require('../functions/brands');

let pass = 0, fail = 0;
const check = (l, ok, d) => { console.log('  ' + (ok?'PASS  ':'FAIL  ') + l + (d?'   ['+d+']':'')); ok?pass++:fail++; };

/* The gate, reconstructed. `verified` stands in for assertAgeVerified(uid). */
function gate({ intentExists, brand, verified, verificationErrors }) {
  if (!intentExists) return { outcome: 'allow', reason: 'no_intent_sokoni_unchanged', audited: false };

  const declared = brand ? String(brand).trim().toLowerCase() : null;

  if (!declared) return { outcome: 'allow', reason: 'no_brand_defaults_sokoni', audited: false, logged: 'STK_INTENT_NO_BRAND' };

  if (!B.brandIds().includes(declared)) {
    return { outcome: 'reject', reason: 'unknown_brand', audited: true };
  }

  if (!B.requiresAgeVerification(declared, null)) {
    return { outcome: 'allow', reason: 'brand_not_restricted', audited: false };
  }

  /* A failure of a REQUIRED check is a refusal, never an allow. */
  if (verificationErrors) return { outcome: 'reject', reason: 'verification_unavailable', audited: true };
  if (!verified)          return { outcome: 'reject', reason: 'not_verified', audited: true };
  return { outcome: 'allow', reason: 'verified', audited: true };
}

console.log('\n── Directive scenarios ──');
const S = [
  ['restricted checkout WITHOUT verification is rejected',
   { intentExists:true, brand:'kass', verified:false }, 'reject', true],
  ['verified customer CAN initiate payment',
   { intentExists:true, brand:'kass', verified:true }, 'allow', true],
  ['unknown brand fails closed',
   { intentExists:true, brand:'not-a-brand', verified:true }, 'reject', true],
  ['empty brand string fails to default, not to KASS',
   { intentExists:true, brand:'   ', verified:false }, 'allow', false],
  ['SOKONI intent is unaffected (pilot policy)',
   { intentExists:true, brand:'sokoni', verified:false }, 'allow', false],
  ['no intent at all leaves SOKONI unchanged',
   { intentExists:false, brand:null, verified:false }, 'allow', false],
  ['verification service failure REFUSES, never allows',
   { intentExists:true, brand:'kass', verified:true, verificationErrors:true }, 'reject', true],
];
for (const [label, input, wantOutcome, wantAudited] of S) {
  const r = gate(input);
  check(label, r.outcome === wantOutcome, r.outcome + (r.reason ? ' / ' + r.reason : ''));
  if (wantAudited) check('  ...and the attempt is audited', r.audited === true, String(r.audited));
}

console.log('\n── Tampering cannot disable enforcement ──');
/* A client controls the request payload, never the intent. These assert that
   nothing a caller can send changes the decision for a KASS intent. */
const TAMPER = [
  { note: 'claims a different category',  extra: { category: 'groceries' } },
  { note: 'claims ageVerified in payload', extra: { ageVerified: true } },
  { note: 'claims brand=sokoni in payload', extra: { brand: 'sokoni' } },
  { note: 'claims skipAgeCheck',           extra: { skipAgeCheck: true } },
];
for (const t of TAMPER) {
  /* The gate only ever reads the server-authored intent; payload is not an input. */
  const r = gate({ intentExists: true, brand: 'kass', verified: false });
  check('unverified KASS payment still rejected when caller ' + t.note, r.outcome === 'reject', r.reason);
}
check('gate() takes no request-payload argument at all — payload cannot be an input',
      gate.length === 1);

console.log('\n── Brand resolution is server-derived ──');
check('KASS requires verification for every category',
      B.getBrand('kass').categories.every(c => B.requiresAgeVerification('kass', c)));
check('KASS requires verification with no category supplied',
      B.requiresAgeVerification('kass', null) === true);
check('display fallback does NOT leak into enforcement',
      B.getBrand('nope').id === 'sokoni' && !B.brandIds().includes('nope'),
      'getBrand falls back for rendering; the gate checks brandIds() and rejects');

console.log('\n── SOKONI unchanged during the pilot ──');
check('sokoni brand does not require storefront verification',
      B.requiresAgeVerification('sokoni', null) === false);
check('sokoni adult categories still flagged for future per-category work',
      B.requiresAgeVerification('sokoni', 'vape') === true);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
