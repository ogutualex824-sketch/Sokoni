#!/usr/bin/env node
/* Canonical role vocabulary and intake resolution  (Roles Phase 1)
 *
 *   node scripts/test-role-vocabulary.js
 *
 * WHY THIS EXISTS
 * An applicant's role used to be DERIVED from nine pooled free-text fields and,
 * when nothing matched, defaulted to `provider`. Three roles were unreachable as a
 * result: `mechanic` was a keyword INSIDE the provider pattern, so every garage
 * became a generic provider; `landlord` matched nothing and defaulted to the same
 * place; and `health`/`legal` reached their own registries but collapsed onto the
 * provider role key. None of that failed loudly — a mis-filed applicant looks
 * exactly like a correctly filed one.
 *
 * Phase 1 makes the role a DECLARATION. This suite pins the three properties that
 * make the migration safe:
 *
 *   1. a declared role is honoured exactly, and aliases normalise;
 *   2. a NEW application can never fall through to `provider` — an unrecognised
 *      declaration is refused, not guessed;
 *   3. a LEGACY application (no requestedRole) decides exactly as it did before,
 *      and is stamped `legacy-*` so the migration's progress is measurable.
 *
 * It asserts against the real module, not a copy of its table.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VOCAB = require(path.join(ROOT, 'functions', 'role-vocabulary.js'));
const { resolveRole } = require(path.join(ROOT, 'functions', 'application-lifecycle.js'))._internal;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

/* ══ 1 · the canonical set ══ */
head('1 · canonical vocabulary');
const EXPECTED = ['buyer', 'seller', 'provider', 'mechanic', 'rider', 'health', 'legal', 'landlord', 'tenant', 'admin', 'staff'];
EXPECTED.forEach((r) => ck(r + ' is canonical', VOCAB.isCanonicalRole(r)));
ck('no extra roles beyond the agreed set',
   VOCAB.CANONICAL_ROLES.length === EXPECTED.length,
   VOCAB.CANONICAL_ROLES.join(','));

/* ══ 2 · every canonical role is accepted as a declaration ══ */
head('2 · a declared canonical role is honoured exactly');
EXPECTED.forEach((r) => {
  const out = resolveRole({ requestedRole: r });
  ck('requestedRole=' + r + ' → ' + r, out.role === r && out.by === 'explicit', out.role + '/' + out.by);
});

/* ══ 3 · aliases normalise ══ */
head('3 · legacy aliases normalise to canonical');
[['merchant', 'seller'], ['vendor', 'seller'], ['driver', 'rider'], ['delivery', 'rider'],
 ['courier', 'rider'], ['healthcare', 'health'], ['lawyer', 'legal'], ['user', 'buyer'],
 ['garage', 'mechanic']].forEach(([given, want]) => {
  const out = resolveRole({ requestedRole: given });
  ck(given + ' → ' + want, out.role === want && out.by === 'explicit-alias', out.role + '/' + out.by);
});
ck('case and whitespace are forgiving', resolveRole({ requestedRole: '  SELLER ' }).role === 'seller');

/* ══ 4 · THE REGRESSION THIS PHASE EXISTS TO PREVENT ══
   These five were indistinguishable before: each resolved to `provider`. */
head('4 · mechanic, health, legal, landlord, tenant are DISTINCT from provider');
['mechanic', 'health', 'legal', 'landlord', 'tenant'].forEach((r) => {
  ck(r + ' does NOT resolve to provider', resolveRole({ requestedRole: r }).role === r);
});
ck('provider still resolves to provider', resolveRole({ requestedRole: 'provider' }).role === 'provider');
ck('rental tenant is not the inventory tenants/ collection',
   VOCAB.isCanonicalRole('tenant') && VOCAB.REGISTRY_PENDING.indexOf('tenant') > -1,
   'registry deferred to Phase 2 — must not reuse tenants/');

/* ══ 5 · a NEW application can never fall through to provider ══ */
head('5 · an unrecognised declaration is refused, never defaulted');
['wizard', 'chef', 'sellerr', 'landlords', '???', 'null', '0', 'providers', 'rider2'].forEach((bad) => {
  const out = resolveRole({ requestedRole: bad });
  ck('requestedRole="' + bad + '" refused',
     out.role === null && out.by === 'invalid-requested-role', out.role + '/' + out.by);
});
/* Trimming is deliberate and is NOT a refusal — asserted separately so the
   refusal list above cannot quietly absorb a value that was actually accepted. */
ck('"provider " (trailing space) is ACCEPTED, not refused',
   resolveRole({ requestedRole: 'provider ' }).role === 'provider');
{
  /* The decisive case: an unknown declaration alongside free text that WOULD have
     keyword-matched. The declaration must win by being refused — falling back to
     the keyword path here is exactly the silent mis-filing being removed. */
  const out = resolveRole({ requestedRole: 'chef', type: 'business', category: 'cleaning', hub: 'home-services' });
  ck('unknown declaration does not fall back to the keyword path',
     out.role === null && out.by === 'invalid-requested-role', out.role + '/' + out.by);
}
{
  const out = resolveRole({ requestedRole: 'notarole', type: 'driver' });
  ck('...not even when another field says driver', out.role === null, out.role + '/' + out.by);
}

/* ══ 6 · legacy applications still resolve, and are marked as legacy ══ */
head('6 · legacy documents (no requestedRole) decide exactly as before');
[[{ type: 'driver' }, 'driver'],
 [{ type: 'business', category: 'cleaning', hub: 'home-services' }, 'provider'],
 [{ type: 'Cleaning Company / Housekeeper', category: 'Service Provider', hub: 'service' }, 'provider'],
 [{ professionalType: 'Lawyer / Legal' }, 'legal'],
 [{ category: 'Hospital / Clinic', hub: 'healthcare' }, 'health'],
 [{ type: 'seller', hub: 'shopping' }, 'seller']].forEach(([app, want]) => {
  const out = resolveRole(app);
  ck(JSON.stringify(app).slice(0, 52) + ' → ' + want,
     out.role === want && out.by === 'legacy-keyword', out.role + '/' + out.by);
});
{
  const out = resolveRole({ type: 'something nobody wrote a pattern for' });
  ck('unrecognised LEGACY vocabulary still lands on provider',
     out.role === 'provider' && out.by === 'legacy-default', out.role + '/' + out.by);
}
ck('an empty legacy document does not crash', resolveRole({}).role === 'provider');

/* ══ 7 · the declaration outranks legacy fields ══ */
head('7 · a declaration outranks every legacy field');
{
  const out = resolveRole({ requestedRole: 'mechanic', type: 'business', category: 'cleaning', hub: 'home-services' });
  ck('mechanic declared, provider keywords present → mechanic', out.role === 'mechanic', out.role);
}
{
  const out = resolveRole({ requestedRole: 'landlord', type: 'driver', hub: 'delivery' });
  ck('landlord declared, driver keywords present → landlord', out.role === 'landlord', out.role);
}
{
  const out = resolveRole({ requestedRole: 'seller', professionalType: 'Doctor / Healthcare' });
  ck('seller declared, health keywords present → seller', out.role === 'seller', out.role);
}

/* ══ 8 · empty/absent declarations are legacy, not invalid ══
   An absent field means "written before Phase 1", which must keep working. */
head('8 · absent or empty requestedRole falls to the legacy path');
[undefined, null, ''].forEach((v) => {
  const out = resolveRole({ requestedRole: v, type: 'driver' });
  ck('requestedRole=' + JSON.stringify(v) + ' → legacy path', out.role === 'driver' && /^legacy-/.test(out.by),
     out.role + '/' + out.by);
});

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
