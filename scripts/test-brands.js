/* Brand layer gate.

   Two properties matter more than the rest and are asserted hardest:
     1. Legal identity is NEVER overridable per brand. A receipt or invoice
        carrying the wrong entity is a filing error, not a cosmetic bug.
     2. A restricted category is never sellable without a gate — on EITHER brand.
        SOKONI's own adult listings are the easy one to forget. */
'use strict';
const B = require('../functions/brands');
const { COMPANY } = require('../functions/company-identity');
const AV = require('../functions/age-verification');

let pass = 0, fail = 0;
const check = (l, ok, d) => { console.log('  ' + (ok?'PASS  ':'FAIL  ') + l + (d?'   ['+d+']':'')); ok?pass++:fail++; };

console.log('\n── One legal entity, many brands ──');
check('two brands registered', B.brandIds().length === 2, B.brandIds().join(','));
for (const id of B.brandIds()) {
  const d = B.documentBranding(id);
  check(id + ': legalName is Bravilex', d.legalName === COMPANY.legalName, d.legalName);
  check(id + ': registration number is the company one', d.registrationNumber === COMPANY.registrationNumber);
}
check('brand display names differ',
      B.getBrand('sokoni').displayName !== B.getBrand('kass').displayName);
check('no brand can override legalName',
      Object.values(B.BRANDS).every(b => !('legalName' in b)));
check('no brand can override the KRA/registration identity',
      Object.values(B.BRANDS).every(b => !('registrationNumber' in b) && !('kraPin' in b)));

console.log('\n── Compliance is declared, not assumed ──');
check('KASS requires age verification',        B.getBrand('kass').requiresAgeVerification === true);
check('SOKONI is not a restricted storefront', B.getBrand('sokoni').requiresAgeVerification === false);
check('KASS gates the whole storefront (no category needed)',
      B.requiresAgeVerification('kass', null) === true);
check('KASS gates accessories too — no unrestricted basket',
      B.requiresAgeVerification('kass', 'vape-accessories') === true);

console.log('\n── SOKONI adult categories are gated (the easy one to forget) ──');
for (const c of ['vape', 'alcohol', 'tobacco', 'adult', 'nicotine']) {
  check('sokoni + ' + c + ' requires verification', B.requiresAgeVerification('sokoni', c) === true);
}
check('sokoni + groceries does NOT require verification',
      B.requiresAgeVerification('sokoni', 'groceries') === false);

console.log('\n── No drift against the age-verification service ──');
const missing = AV.RESTRICTED_CATEGORIES.filter(c => !B.requiresAgeVerification('sokoni', c));
check('every RESTRICTED_CATEGORY is gated on SOKONI', missing.length === 0, missing.join(',') || 'none');
check('every KASS category is in its own restricted list',
      B.getBrand('kass').categories.every(c => B.getBrand('kass').restrictedCategories.includes(c)));

console.log('\n── Host resolution fails safe ──');
check('kassvapes.co.ke -> kass',        B.brandFromHost('kassvapes.co.ke').id === 'kass');
check('www subdomain -> kass',          B.brandFromHost('www.kassvapes.co.ke').id === 'kass');
check('port is ignored',                B.brandFromHost('kassvapes.co.ke:8080').id === 'kass');
check('case is ignored',                B.brandFromHost('KassVapes.co.ke').id === 'kass');
check('mysokoni.co.ke -> sokoni',       B.brandFromHost('mysokoni.co.ke').id === 'sokoni');
check('unknown host falls back, never throws', B.brandFromHost('evil.example').id === 'sokoni');
check('empty/null host falls back',     B.brandFromHost(null).id === 'sokoni' && B.brandFromHost('').id === 'sokoni');
check('unknown brand id falls back',    B.getBrand('nope').id === 'sokoni');

console.log('\n── Catalogue isolation ──');
check('KASS catalogue is scoped',  Array.isArray(B.getBrand('kass').categories) && B.getBrand('kass').categories.length === 5);
check('SOKONI catalogue is open',  B.getBrand('sokoni').categories === null);
check('KASS carries a compliance notice', /under 18/i.test(B.getBrand('kass').complianceNotice || ''));
check('KASS notice names nicotine addiction', /addictive/i.test(B.getBrand('kass').complianceNotice || ''));

console.log('\n── Config is frozen (no runtime mutation) ──');
check('BRANDS frozen', Object.isFrozen(B.BRANDS));
check('each brand frozen', Object.values(B.BRANDS).every(b => Object.isFrozen(b)));
let mutated = false;
try { B.getBrand('kass').requiresAgeVerification = false; } catch (_) {}
if (B.getBrand('kass').requiresAgeVerification === false) mutated = true;
check('compliance flag cannot be switched off at runtime', mutated === false);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
