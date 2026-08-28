'use strict';
/* role-entry-convergence — server + static checks (node).
   Proves the legal landlord->property wiring, resolveRole landlord routing on live's Phase-2
   engine, and the static wiring of the gap-fills. */
const path = require('path');
const fs = require('fs');
const FN = path.join(__dirname, '..', 'functions');
const ROOT = path.join(__dirname, '..');
const LA = require(path.join(FN, 'legal-agreements.js'));
let AL = null, alErr = '';
try { const m = require(path.join(FN, 'application-lifecycle.js')); AL = m.resolveRole ? m : (m._internal || null); } catch (e) { alErr = (e.message || '').split('\n')[0]; }
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const P = (n) => { pass++; console.log('  [PASS] ' + n); };
const F = (n, d) => { fail++; console.log('  [FAIL] ' + n + (d ? '  -> ' + d : '')); };

/* Legal: the property agreement set is now the landlord set (was orphaned). */
const set = LA.ROLE_AGREEMENTS.landlord;
(Array.isArray(set) && set === LA.ROLE_AGREEMENTS.property) ? P('ROLE_AGREEMENTS.landlord === property set (legalGetAgreements("landlord") now returns the property agreements)') : F('landlord legal alias', JSON.stringify(set));
(set && set.some((a) => a.id === 'property-listing-agreement')) ? P('landlord agreements include property-listing-agreement') : F('landlord agreement contents');

/* Server routing: a landlord application (requestedRole:landlord) resolves to landlord on live's Phase-2 engine. */
if (!AL) { F('application-lifecycle failed to load', alErr); }
else {
  (AL.resolveRole({ requestedRole: 'landlord' }).role === 'landlord') ? P('resolveRole({requestedRole:landlord}) -> landlord (VOCAB explicit)') : F('resolveRole landlord', JSON.stringify(AL.resolveRole({ requestedRole: 'landlord' })));
  (AL.resolveRole({ requestedRole: 'seller' }).role === 'seller') ? P('regression: resolveRole seller intact') : F('resolveRole seller regression');
}

/* Static wiring of the gap-fills. */
const authSrc = read('sokoni-role-authority.js');
(/'provider-dashboard.html':\s*'provider'/.test(authSrc) && /'rider-dashboard.html':\s*'rider'/.test(authSrc)) ? P('WORKSPACE_ROUTES adds provider-dashboard + rider-dashboard') : F('WORKSPACE_ROUTES additions');
(/APPLICATION_ROUTES\s*=\s*\{[\s\S]*landlord:\s*'onboarding-landlord.html'/.test(authSrc)) ? P('APPLICATION_ROUTES maps landlord -> onboarding-landlord.html') : F('APPLICATION_ROUTES landlord');
(/deniedUrl\s*\|\|\s*APPLICATION_ROUTES\[canonical\]/.test(authSrc)) ? P('guardWorkspace redirects unapproved -> the role application') : F('guardWorkspace deniedUrl wiring');

['provider.html', 'provider-dashboard.html', 'rider-dashboard.html'].forEach((f) => {
  (/sokoni-role-authority\.js/.test(read(f))) ? P(`${f} loads sokoni-role-authority.js (auto-guarded)`) : F(`${f} not guarded`);
});
const rider = read('rider-dashboard.html');
(!/claims\.role\s*!==\s*'driver'/.test(rider) && /!claims\.driver\s*&&\s*!claims\.rider/.test(rider)) ? P('rider-dashboard.html reads canonical claims.driver/rider (wrong-claim bug removed)') : F('rider-dashboard bug still present');

const ll = read('onboarding-landlord.html');
(/SokoniLegalSign\.mount\([^)]*role\s*:\s*'landlord'/.test(ll)) ? P('onboarding-landlord mounts SokoniLegalSign role:landlord (property agreements)') : F('intake gate role');
(/requestedRole:\s*'landlord'/.test(ll) && /_consentOk/.test(ll)) ? P('onboarding-landlord: fail-closed + requestedRole:landlord') : F('intake contract');
{ const dataBlock = (ll.match(/var data = \{[\s\S]*?\};/) || [''])[0];
  (dataBlock && !/[{,]\s*role\s*:/.test(dataBlock) && !/[{,]\s*approved\s*:/.test(dataBlock)) ? P('intake WRITE has no admin fields (role/approved) — passes noAdminFields()') : F('intake leaks admin field'); }

console.log('\n' + (fail === 0 ? `convergence-server: PASS ${pass}/${pass}` : `convergence-server: ${fail} FAIL of ${pass + fail}`));
process.exit(fail === 0 ? 0 : 1);
