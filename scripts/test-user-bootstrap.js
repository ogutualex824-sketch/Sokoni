/* Unit tests for sokoni-user-bootstrap.js pure planners.
   Verifies idempotency, no-overwrite, and that a client baseline write can never
   include a field firestore.rules would reject. Pure logic — no Firestore. */
'use strict';
const path = require('path');
const PLAN = require(path.join(__dirname, '..', 'sokoni-user-bootstrap.js'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const authUser = { uid: 'U1', displayName: 'Jane Doe', email: 'jane@x.com', phoneNumber: '+254700000000', photoURL: '' };

/* Fields the client must NEVER write to users/{uid} (rules: noAdminFields /
   noPrivilegeEscalation / noProviderForgery / timestamp integrity / edit-limit). */
const FORBIDDEN = ['role', 'isAdmin', 'suspended', 'banned', 'verified', 'featured',
  'commissionRate', 'betaStatus', 'accessLevel', 'featureFlags', 'permissions',
  'trustScore', 'kycStatus', 'riskLevel', 'merchantStatus', 'providerStatus',
  'provider', 'providers', 'createdAt', 'profileEditCount', 'profileEditWindowStartMs'];
function assertNoForbidden(data, label) {
  Object.keys(data || {}).forEach(k => ok(FORBIDDEN.indexOf(k) === -1, label + ' wrote forbidden field: ' + k));
}

/* 1) brand-new doc → create with safe baseline */
const c = PLAN.planUserDoc(null, authUser);
ok(c.op === 'create', 'null doc → create');
ok(Array.isArray(c.data.roles) && c.data.roles[0] === 'buyer', 'create sets roles:[buyer]');
ok(c.data.name === 'Jane Doe', 'create derives name from displayName');
ok(c.data.onboardingRequired === true, 'brand-new create → onboarding required');
assertNoForbidden(c.data, 'create');

/* 2) complete doc → NO write (idempotent) */
const complete = { uid: 'U1', name: 'Jane', email: 'jane@x.com', phoneNumber: '+254700000000',
  roles: ['buyer', 'seller'], registeredAs: { user: true, seller: true }, accountStatus: 'active',
  onboardingCompleted: true, onboardingRequired: false };
const n = PLAN.planUserDoc(complete, authUser);
ok(n.op === 'none', 'complete doc → no write (idempotent), got ' + n.op);

/* 3) doc missing roles → fill ONLY roles, preserve everything else */
const missingRoles = { uid: 'U1', name: 'Jane', email: 'jane@x.com', phoneNumber: '+254700000000',
  accountStatus: 'active', onboardingCompleted: true, onboardingRequired: false, registeredAs: { user: true } };
const r = PLAN.planUserDoc(missingRoles, authUser);
ok(r.op === 'update', 'missing roles → update');
ok(Object.keys(r.data).length === 1 && r.data.roles, 'update fills ONLY roles, keys=' + Object.keys(r.data));
assertNoForbidden(r.data, 'update-roles');

/* 4) doc missing name (the auth-loop trigger) → fills name */
const missingName = { uid: 'U1', email: 'jane@x.com', roles: ['buyer'], registeredAs: { user: true },
  accountStatus: 'active', onboardingCompleted: true, onboardingRequired: false };
const nm = PLAN.planUserDoc(missingName, authUser);
ok(nm.op === 'update' && nm.data.name === 'Jane Doe', 'missing name → filled from auth');
ok(nm.data.roles === undefined, 'present roles NOT overwritten when filling name');

/* 5) existing doc missing onboarding flags → treat as ONBOARDED (never re-trigger) */
const noOnboard = { uid: 'U1', name: 'Jane', roles: ['buyer'], registeredAs: { user: true }, accountStatus: 'active' };
const ob = PLAN.planUserDoc(noOnboard, authUser);
ok(ob.data.onboardingCompleted === true && ob.data.onboardingRequired === false,
   'existing doc missing onboarding → onboarded, not re-onboarded');

/* 6) no-overwrite invariant: never emit a key the existing doc already has */
[complete, missingRoles, missingName, noOnboard].forEach((doc, i) => {
  const p = PLAN.planUserDoc(doc, authUser);
  if (p.op === 'update') Object.keys(p.data).forEach(k =>
    ok(doc[k] === undefined || doc[k] === null, 'case ' + i + ' overwrote existing key: ' + k));
});

/* 7) wallet + notifPrefs planners */
ok(PLAN.planWallet({ balance: 500 }).op === 'none', 'existing wallet → no write');
const w = PLAN.planWallet(null);
ok(w.op === 'create' && w.data.balance === 0, 'missing wallet → create balance EXACTLY 0');
ok(PLAN.planNotifPrefs({ email: true }).op === 'none', 'existing prefs → no write');
ok(PLAN.planNotifPrefs(null).op === 'create', 'missing prefs → create');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
