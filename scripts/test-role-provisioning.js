#!/usr/bin/env node
/* Canonical role provisioning  (Roles Phase 2)
 *
 *   node scripts/test-role-provisioning.js
 *
 * WHY THIS EXISTS
 * Phase 1 taught the intake to DECLARE a role. The account then threw the
 * declaration away: grantAccountRole mapped only five roles and had `|| 'provider'`
 * behind the lookup, so an approved mechanic, landlord or rental tenant became a
 * `provider` in users.roles, and health and legal were mapped there deliberately.
 * A declared role that is discarded one step later is not a role model.
 *
 * This suite pins the account-side half:
 *   · every canonical role keeps its own key — nothing collapses into provider;
 *   · an unmapped role THROWS rather than defaulting;
 *   · mechanic / landlord / tenant get a uid-keyed profile of their own;
 *   · a tenant profile is private and carries _noIndex — never searchable;
 *   · landlordProfiles is registered for indexing, tenantProfiles and riders are not;
 *   · legacy `driver` and canonical `rider` behave identically.
 *
 * It asserts against the real modules, not restated tables.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const LIFECYCLE = path.join(ROOT, 'functions', 'application-lifecycle.js');
const SYNC = path.join(ROOT, 'functions', 'algolia-sync.js');
const VOCAB = require(path.join(ROOT, 'functions', 'role-vocabulary.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');
const SRC = fs.readFileSync(LIFECYCLE, 'utf8');

/* ══ 1 · every canonical role has its own key ══ */
head('1 · no canonical role collapses into provider');
const keyBlock = SRC.slice(SRC.indexOf('const ROLE_KEY = {'), SRC.indexOf('const key = ROLE_KEY[role]'));
const mapped = {};
keyBlock.replace(/(\w+)\s*:\s*'([a-z]+)'/g, (_, k, v) => { mapped[k] = v; return _; });

[['seller', 'seller'], ['provider', 'provider'], ['mechanic', 'mechanic'], ['rider', 'rider'],
 ['health', 'health'], ['legal', 'legal'], ['landlord', 'landlord'], ['tenant', 'tenant'],
 ['buyer', 'buyer'], ['admin', 'admin'], ['staff', 'staff']].forEach(([role, want]) => {
  ck(role + ' → ' + want, mapped[role] === want, mapped[role]);
});
ck('legacy `driver` still maps to the rider key', mapped.driver === 'rider', mapped.driver);

/* THE REGRESSION THIS PHASE REMOVES */
['mechanic', 'health', 'legal', 'landlord', 'tenant'].forEach((r) => {
  ck(r + ' is NOT mapped to provider', mapped[r] !== 'provider', mapped[r]);
});

/* ══ 2 · the silent fallback is gone ══ */
head('2 · an unmapped role fails loudly instead of defaulting');
ck("no `|| 'provider'` fallback remains on the key lookup",
   !/const key = ROLE_KEY\[role\] \|\| 'provider'/.test(SRC));
ck('an unmapped role throws', /throw new Error\('grantAccountRole: unmapped role/.test(SRC));
ck('...and the error names the canonical set', /Canonical roles: '/.test(SRC));

/* ══ 3 · every canonical role in the vocabulary is mapped ══ */
head('3 · vocabulary and account keys agree');
VOCAB.CANONICAL_ROLES.forEach((r) => {
  ck(r + ' is present in ROLE_KEY', Object.prototype.hasOwnProperty.call(mapped, r), mapped[r]);
});

/* ══ 4 · role profiles ══ */
head('4 · mechanic / landlord / tenant get their own uid-keyed profile');
ck('mechanic → mechanics (existing collection, uid-keyed alongside legacy docs)',
   /mechanic:\s*\{\s*collection:\s*'mechanics'/.test(SRC));
ck('landlord → landlordProfiles (new)', /landlord:\s*\{\s*collection:\s*'landlordProfiles'/.test(SRC));
ck('tenant → tenantProfiles (new)', /tenant:\s*\{\s*collection:\s*'tenantProfiles'/.test(SRC));
ck('tenantProfiles is NOT named tenants/ (inventory multi-tenancy)',
   !/tenant:\s*\{\s*collection:\s*'tenants'/.test(SRC));
ck('the projection is routed before the provider fallback',
   SRC.indexOf('ROLE_PROFILES[role]') < SRC.indexOf('projectProvider(db, app, uid, approved))'));

/* ══ 5 · tenant privacy ══ */
head('5 · a rental tenant is private and never searchable');
ck('tenant profile is marked indexable:false', /tenant:\s*\{\s*collection:\s*'tenantProfiles',\s*indexable:\s*false/.test(SRC));
ck('a non-indexable profile stamps _noIndex', /if \(!spec\.indexable\) patch\._noIndex = true;/.test(SRC));
ck('visibility follows indexability', /visibility:\s*spec\.indexable \? 'public' : 'private'/.test(SRC));

/* ══ 6 · indexing registration ══ */
head('6 · only landlordProfiles was added to the index generator');
const SYNC_SRC = fs.readFileSync(SYNC, 'utf8');
ck('landlordProfiles IS registered', /_makeTriggers\('landlordProfiles'\)/.test(SYNC_SRC));
ck('tenantProfiles is NOT registered', !/_makeTriggers\('tenantProfiles'\)/.test(SYNC_SRC));
ck('drivers is NOT registered (riders stay private)', !/_makeTriggers\('drivers'\)/.test(SYNC_SRC));
ck('rideDrivers is NOT registered', !/_makeTriggers\('rideDrivers'\)/.test(SYNC_SRC));
ck('mechanics was already registered — no duplicate added',
   (SYNC_SRC.match(/_makeTriggers\('mechanics'\)/g) || []).length === 1);
/* Legal reconciliation SETTLED: legalProviders is the authority, lawyers is its
   search projection (both uid-keyed, both already written together by
   scripts/onboard-batch2.js). Indexing the authority would create a SECOND
   searchable record of the same firm, so it stays unregistered by design — not
   by omission. scripts/test-legal-projection.js pins the lifecycle itself. */
ck('legalProviders is NOT registered — one search surface per legal entity',
   !/_makeTriggers\('legalProviders'\)/.test(SYNC_SRC));
ck('...and lawyers was left exactly as it was', /_makeTriggers\('lawyers'\)/.test(SYNC_SRC));

/* ══ 7 · activeRole authority ══ */
head('7 · activeRole is written by approval, not by the client');
ck('approval sets activeRole', /patch\.activeRole = key;/.test(SRC));
ck('...and records that approval set it', /patch\.activeRoleSetBy = 'approval';/.test(SRC));
ck('revocation demotes a now-unapproved active role', /patch\.activeRole = 'buyer';/.test(SRC));
ck('...only when the revoked role was the active one',
   /snap\.data\(\)\.activeRole === key/.test(SRC));

/* ══ 8 · canonical claims ══ */
head('8 · claims carry the canonical role, without breaking the old shape');
ck('a canonical claim is set for the role', /claims\[key\] = !!approved;/.test(SRC));
ck('the legacy provider claim is still set for provider/health/legal',
   /if \(role === 'provider' \|\| role === 'health' \|\| role === 'legal'\) claims\.provider/.test(SRC));
ck('rider sets both driver and rider claims', /if \(key === 'rider'\) \{ claims\.driver/.test(SRC));

/* ══ 9 · legacy safety ══ */
head('9 · legacy behaviour preserved');
ck('driver AND rider both reach projectDriver', /role === 'driver' \|\| role === 'rider'/.test(SRC));
ck('legacy mechanics/{docId} documents are not read, rewritten or deleted',
   !/mechanics.*delete|deleteDoc.*mechanics/i.test(SRC));
ck('a withdrawn role profile is retracted, not deleted', /action: 'retracted'/.test(SRC));
ck('profile writes are idempotent (merge)', /await ref\.set\(patch, \{ merge: true \}\)/.test(SRC));

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
