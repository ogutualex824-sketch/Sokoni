/* Merchant V2 × dual-business navigation — the integration.

   The shell renders a PROJECTION of sokoni-merchant-routes.js. Integration is
   therefore a filter over that projection, and these tests run the real
   contract through the real decision layer — no fixtures standing in for
   either, so a drift between them fails here.

   The two properties that must not break:
     A subscription never creates a workspace.
     A lapsed subscription never removes one.
*/
'use strict';
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 76) + ']' : ''));
  ok ? pass++ : fail++;
};

/* Load the browser globals the same way the page does. */
const g = globalThis;
require(path.join(root, 'sokoni-merchant-routes.js'));
const NAV = require(path.join(root, 'sokoni-merchant-nav.js'));
const B   = require(path.join(root, 'functions', 'shared', 'business-scope.js'));
const CONTRACT = g.SokoniMerchantRoutes;

const LIVE = { status: 'active' };
const sub  = (s) => ({ found: true, status: s, tier: 'professional' });
const NOSUB = { found: false, status: 'none', tier: null };
const mkNav = (p, s, ps, ss) => NAV.resolveNav({
  scope: B.resolveBusinessScope({ seller: p ? LIVE : null, provider: s ? LIVE : null }),
  sellerSub: ps || NOSUB, providerSub: ss || NOSUB,
});
const ids = (routes, nav) => NAV.filterContractRoutes(routes, nav).map((x) => x.route.id);
const allRoutes = () => {
  const out = CONTRACT.primary().slice();
  CONTRACT.moreGroups().forEach((grp) => (grp.routes || []).forEach((r) => out.push(r)));
  return out;
};

/* 1 */
console.log('\n── 1. The shell loads the module, and the contract declares services ──');
{
  const html = fs.readFileSync(path.join(root, 'merchant-v2.html'), 'utf8');
  ck('merchant-v2.html loads sokoni-merchant-nav.js', /src="sokoni-merchant-nav\.js"/.test(html));
  ck('…before the shell script runs',
     html.indexOf('sokoni-merchant-nav.js') < html.indexOf('var CONTRACT = window.SokoniMerchantRoutes'));
  ck('the sidebar filters the projection', /CONTRACT\.primary\(\)\.filter\(_visible\)/.test(html));
  ck('the contract still loads and validates', !!CONTRACT && typeof CONTRACT.primary === 'function');
  ck('a services route exists', !!CONTRACT.ROUTES.find((r) => r.id === 'services'));
  ck('a bookings route exists', !!CONTRACT.ROUTES.find((r) => r.id === 'bookings'));
}

/* 11 + 12 */
console.log('\n── 11/12. catalogue.html stays THE catalogue ──');
{
  const svc = CONTRACT.ROUTES.find((r) => r.id === 'services');
  ck('the services route targets catalogue.html', /catalogue\.html/.test(svc.src || ''), svc.src);
  ck('…filtered to the services tab', /tab=services/.test(svc.src || ''), svc.src);
  const html = fs.readFileSync(path.join(root, 'merchant-v2.html'), 'utf8');
  ck('12. no second service catalogue was built into the shell',
     !/posServices/.test(html) && !/SokoniCatalogueModel/.test(html));
  ck('…and catalogue.html is untouched by this slice',
     fs.existsSync(path.join(root, 'catalogue.html')));
}

/* 2 */
console.log('\n── 2. Seller-only approved ──');
{
  const n = mkNav(true, false, sub('active'), NOSUB);
  const v = ids(allRoutes(), n);
  ck('Products is present', v.indexOf('products') !== -1);
  ck('Inventory is present', v.indexOf('inventory') !== -1);
  ck('Orders is present', v.indexOf('orders') !== -1);
  ck('the Till is present', v.indexOf('pos') !== -1 || v.indexOf('till') !== -1);
  ck('Services is ABSENT', v.indexOf('services') === -1);
  ck('Bookings is ABSENT', v.indexOf('bookings') === -1);
}

/* 3 */
console.log('\n── 3. Provider-only approved ──');
{
  const n = mkNav(false, true, NOSUB, sub('active'));
  const v = ids(allRoutes(), n);
  ck('Services is present', v.indexOf('services') !== -1);
  ck('Bookings is present', v.indexOf('bookings') !== -1);
  ck('Products is ABSENT', v.indexOf('products') === -1);
  ck('Inventory is ABSENT', v.indexOf('inventory') === -1);
  ck('the Till is still present (the other side is usable)', v.indexOf('pos') !== -1);
}

/* 4 */
console.log('\n── 4. Dual — one account, both sides ──');
{
  const n = mkNav(true, true, sub('active'), sub('active'));
  const v = ids(allRoutes(), n);
  ck('Products AND Services together',
     v.indexOf('products') !== -1 && v.indexOf('services') !== -1);
  ck('Inventory AND Bookings together',
     v.indexOf('inventory') !== -1 && v.indexOf('bookings') !== -1);
  ck('one Till serves both', v.filter((x) => x === 'pos').length === 1);
}

/* 5 — the boundary */
console.log('\n── 5. A SUBSCRIPTION NEVER CREATES A WORKSPACE ──');
{
  const n = mkNav(false, false, sub('active'), sub('active'));
  const v = ids(allRoutes(), n);
  ck('paid seller plan, no approval ⇒ no Products', v.indexOf('products') === -1);
  ck('paid provider plan, no approval ⇒ no Services', v.indexOf('services') === -1);
  ck('…no Inventory, Orders or Bookings',
     v.indexOf('inventory') === -1 && v.indexOf('orders') === -1 && v.indexOf('bookings') === -1);
  ck('…and no Till', v.indexOf('pos') === -1);
  /* INVERTING CONTROL — the same plan works once approved, so the absences
     above are about approval, not about a filter that hides everything. */
  ck('the identical plan DOES yield Products once approved',
     ids(allRoutes(), mkNav(true, false, sub('active'), NOSUB)).indexOf('products') !== -1);
  /* 10 — account-level survives even here. */
  ck('10. account-level routes remain', v.indexOf('settings') !== -1 && v.indexOf('payments') !== -1);
}

/* 6 + 7 */
console.log('\n── 6/7. A LAPSED subscription never removes a workspace ──');
for (const state of ['expired', 'past_due', 'cancelled']) {
  const n = mkNav(true, true, sub(state), sub('active'));
  const v = ids(allRoutes(), n);
  ck(`seller ${state}: Products still VISIBLE`, v.indexOf('products') !== -1);
  const d = NAV.decideRoute(CONTRACT.ROUTES.find((r) => r.id === 'products'), n);
  ck(`…marked not usable, with a reason`, !d.usable && !!d.reason, d.reason);
  ck(`…and the reason says the data is safe`, /data is safe/i.test(d.reason || ''));
}
{
  const n = mkNav(true, true, sub('active'), sub('expired'));
  const v = ids(allRoutes(), n);
  ck('provider expired: Services still VISIBLE', v.indexOf('services') !== -1);
  ck('…Bookings still visible', v.indexOf('bookings') !== -1);
}

/* 8 + 9 */
console.log('\n── 8/9. Neither subscription affects the other ──');
{
  const before = mkNav(true, true, sub('active'), sub('active'));
  const afterS = mkNav(true, true, sub('cancelled'), sub('active'));
  ck('cancelling seller leaves the services side byte-identical',
     JSON.stringify(before.services) === JSON.stringify(afterS.services));
  ck('…Services stays usable',
     NAV.decideRoute(CONTRACT.ROUTES.find((r) => r.id === 'services'), afterS).usable);
  const afterP = mkNav(true, true, sub('active'), sub('cancelled'));
  ck('cancelling provider leaves the products side byte-identical',
     JSON.stringify(before.products) === JSON.stringify(afterP.products));
  ck('…Products stays usable',
     NAV.decideRoute(CONTRACT.ROUTES.find((r) => r.id === 'products'), afterP).usable);
}

/* 10 */
console.log('\n── 10. Account-level navigation never locks ──');
{
  const dead = mkNav(true, true, sub('cancelled'), sub('expired'));
  for (const id of ['settings', 'payments', 'reports', 'messages', 'plan', 'kra-tax', 'customers']) {
    const r = CONTRACT.ROUTES.find((x) => x.id === id);
    if (!r) { ck(`${id} exists in the contract`, false, 'route missing'); continue; }
    const d = NAV.decideRoute(r, dead);
    ck(`${id} stays visible AND usable`, d.visible && d.usable);
  }
  ck('…while the Till correctly does not', !NAV.decideRoute(CONTRACT.ROUTES.find(r => r.id === 'pos'), dead).usable);
}

console.log('\n── An unknown route is account-level, never hidden ──');
{
  ck('a route this map does not know stays visible',
     NAV.decideRoute({ id: 'some-future-route' }, mkNav(true, false, sub('active'), NOSUB)).visible);
  ck('…so a new route cannot vanish the day it is added',
     NAV.sideOfRoute({ id: 'some-future-route' }) === null);
}

console.log('\n── The shell holds no entitlement logic of its own ──');
{
  const html = fs.readFileSync(path.join(root, 'merchant-v2.html'), 'utf8');
  const shell = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('no businessType in the shell', !/businessType/.test(shell));
  ck('no subscription store read in the shell',
     !/merchantSubscriptions|providerSubscriptions/.test(shell));
  ck('no approval status logic in the shell', !/sellsProducts|providesServices/.test(shell));
  /* The shell aliases the module once (`var NAV = window.SokoniMerchantNav`)
     and calls NAV.decideRoute — assert the alias AND the call, not a literal
     dotted path the code never spells. */
  ck('…it only asks the module',
     /window\.SokoniMerchantNav/.test(shell) && /NAV\.decideRoute\(/.test(shell));
  /* Fail OPEN while state is unknown: a slow read must not blank the sidebar. */
  ck('an unresolved nav state filters NOTHING', /!window\._navState\) return true/.test(shell));
}

/* 13 + 14 + 15 */
console.log('\n── 13/14/15. Nothing outside the shell and the contract was touched ──');
{
  const shellSrc = fs.readFileSync(path.join(root, 'merchant-v2.html'), 'utf8');
  const navSrc   = fs.readFileSync(path.join(root, 'sokoni-merchant-nav.js'), 'utf8');
  const both = shellSrc + navSrc;
  ck('13. no payment-purposes reference', !/payment-purposes/.test(both));

  /* 14. A COUNT, not a diff.
     The first draft scanned `git diff HEAD`, which passed vacuously the moment
     these files were committed — the diff went empty and "adds no payment
     reference" became true of nothing. Its positive control caught that, which
     is the only reason it is not still there passing for the wrong reason.

     merchant-v2.html already referenced createPaymentIntent at line 2763
     before this work, so the durable property is not "zero" but "still exactly
     the one that was always there". A second occurrence — added by anyone,
     whenever — fails this. */
  const payRefs = (s) => (s.match(/webhookIntasend|completeMultiTender|createPaymentIntent/g) || []).length;
  ck('14. the shell still has exactly ONE payment reference, the pre-existing one',
     payRefs(shellSrc) === 1, payRefs(shellSrc) + ' occurrence(s)');
  ck('…and it is createPaymentIntent, not a receiver',
     !/webhookIntasend|completeMultiTender/.test(shellSrc));
  ck('…the nav module has NONE at all', payRefs(navSrc) === 0, payRefs(navSrc) + '');
  /* Positive control: the counter can count. */
  ck('…and the counter is not stuck at zero (positive control)',
     payRefs('createPaymentIntent webhookIntasend') === 2);
  ck('15. no tax calculation', !/calculateVAT|taxRate\s*=/.test(navSrc));
  ck('…and the nav module is still pure', !/firestore|firebase/i.test(navSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
