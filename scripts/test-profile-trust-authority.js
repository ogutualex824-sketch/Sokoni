#!/usr/bin/env node
'use strict';
/* ============================================================================
   Profile trust score — only real verifications count (2026-10-03)
     T1  a self-written users/{uid}.emailVerified:true earns NOTHING (live rules f259c0b5 do not guard it)
     T2  email verified per Firebase Auth (own token; others via Auth) earns +15; an Auth lookup failure = not verified
     T3  phone: the rules-guarded users.phoneVerified, or an Auth phone number (OTP-proven), earns +15
     T4  owning a business doc earns NOTHING; an APPROVED business facet earns +15 ("registered" ≠ "verified")
     T5  expired / pending facets earn nothing; levels Bronze/Silver/Gold/Platinum at 0/45/70/90
     T6  completion's email/phone steps use the same authority (no second answer)
     T7  overview returns verifications.business from the facet only, and every caller passes auth facts
   Runs the SHIPPING functions via the module's _test seam (pure; no Firestore).
   NODE_PATH=<functions/node_modules> node scripts/test-profile-trust-authority.js
   ============================================================================ */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'functions/profile-engine.js'));
const { _trustScore: T, _completion: C, _authFacts: A } = E._test;
const SRC = fs.readFileSync(path.join(ROOT, 'functions/profile-engine.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 220) : '')); } };
const ts = (d) => { const x = new Date(Date.now() + d * 864e5); return { toMillis: () => x.getTime() }; };
const facet = (name, state, expDays) => ({ facets: { [name]: Object.assign({ state }, expDays != null ? { expiresAt: ts(expDays) } : {}) } });

(async () => {
  ck('T1 self-written users.emailVerified:true → 0 points', T({ emailVerified: true }, {}, {}).score === 0, T({ emailVerified: true }, {}, {}));
  ck('T2a Auth emailVerified → +15 "Email Verified"', T({}, {}, { emailVerified: true }).score === 15 && T({}, {}, { emailVerified: true }).factors.includes('Email Verified'));
  let r = await A('u1', { auth: { uid: 'u1', token: { email_verified: true, phone_number: '+254712345678' } } });
  ck('T2b own token answers for the caller (email + phone)', r.emailVerified === true && r.phoneNumber === '+254712345678', r);
  r = await A('u2', null, async () => { throw new Error('auth/user-not-found'); });
  ck('T2c another user, Auth lookup fails → NOT verified (fail closed)', r.emailVerified === false && r.phoneNumber === null, r);
  r = await A('u3', { auth: { uid: 'someone-else', token: { email_verified: false } } }, async (id) => ({ uid: id, emailVerified: true, phoneNumber: null }));
  ck('T2d another user → read from Auth, never from the CALLER\'s token', r.emailVerified === true, r);
  r = await A('u4', { auth: { uid: 'caller', token: { email_verified: true } } }, async (id) => ({ uid: id, emailVerified: false }));
  ck('T2e caller verified but the viewed user is not → not verified', r.emailVerified === false, r);
  ck('T3 phone: guarded users.phoneVerified OR Auth phone → +15', T({ phoneVerified: true }, {}, {}).score === 15 && T({}, {}, { phoneNumber: '+254700000001' }).score === 15 && T({}, {}, {}).score === 0);
  ck('T4a owning businesses (old bizCount arg) adds nothing', T({}, {}, 3).score === 0 && !/bizCount > 0/.test(SRC.slice(SRC.indexOf('function _trustScore'), SRC.indexOf('function _facetStates'))));
  ck('T4b APPROVED business facet → +15 "Business Verified"', T({}, facet('business', 'approved'), {}).score === 15);
  ck('T5a pending / rejected / EXPIRED facets → 0', ['pending', 'rejected'].every((st) => T({}, facet('identity', st), {}).score === 0) && T({}, facet('identity', 'approved', -1), {}).score === 0 && T({}, facet('identity', 'approved', 30), {}).score === 20);
  const full = T({ photoURL: 'x', legalSigned: true, phoneVerified: true }, { facets: { identity: { state: 'approved' }, business: { state: 'approved' }, kra: { state: 'approved' }, address: { state: 'approved' }, bank: { state: 'approved' } } }, { emailVerified: true });
  ck('T5b everything real → 100 Platinum; levels at 45/70/90', full.score === 100 && full.level === 'Platinum' && T({ phoneVerified: true }, facet('identity', 'approved'), { emailVerified: true }).level === 'Silver', full);
  const steps = (c) => Object.fromEntries(c.steps.map((x) => [x.id, x.done]));
  ck('T6 completion email/phone steps follow the SAME authority', steps(C({ emailVerified: true }, {}, {}, {})).email === false && steps(C({}, {}, {}, { emailVerified: true })).email === true && steps(C({}, {}, {}, { phoneNumber: '+254700000001' })).phone === true);
  ck('T7a overview: verifications.business = approved facet only', /business:\s+_facets\.has\('business'\),/.test(SRC) && !/_facets\.has\('business'\) \|\| bizCount/.test(SRC));
  const calls = SRC.match(/_trustScore\([^)]*\)/g).filter((x) => !/function|user = \{\}/.test(x));
  ck('T7b every _trustScore caller passes auth facts (' + calls.length + ' callers)', calls.length >= 3 && calls.every((x) => /auth|_authFacts/.test(x)), calls);
  ck('T7c no reader of the self-writable users.emailVerified remains', !/user\.emailVerified/.test(SRC));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
