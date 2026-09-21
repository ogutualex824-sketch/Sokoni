/* shared/business-scope.js — may this account trade products, services, or both?

   WHAT THESE PROVE

   A cyber café sells airtime AND prints documents. The scope resolver decides
   which catalogues it may use and which it may bill for, so the two failure
   modes are opposite and both are expensive:

     too narrow  a real dual business cannot add its services, keeps two
                 accounts, and SOKONI cannot report what one business earned
     too wide    an account grants itself a scope nobody approved

   So every grant is tested alongside its refusal, and the self-claimable
   fields are tested to have NO effect — with a positive control proving the
   resolver can grant at all, otherwise "label ignored" would pass against a
   resolver that simply never grants anything.
*/
'use strict';
const path = require('path');
const B = require(path.join(__dirname, '..', 'functions', 'shared', 'business-scope'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};

const LIVE = { status: 'active' };
const S = (seller, provider) => B.resolveBusinessScope({ seller, provider });

console.log('\n── The four shapes a business can be in ──');
{
  const none = S(null, null);
  ck('no registry docs ⇒ trades nothing', !none.isTrading && none.scopes.length === 0);
  ck('…and is not dual', !none.isDual);

  const shop = S(LIVE, null);
  ck('seller only ⇒ products', shop.sellsProducts && !shop.providesServices);
  ck('…scopes is ["products"]', shop.scopes.join(',') === 'products', shop.scopes.join(','));

  const prov = S(null, LIVE);
  ck('provider only ⇒ services', prov.providesServices && !prov.sellsProducts);
  ck('…scopes is ["services"]', prov.scopes.join(',') === 'services', prov.scopes.join(','));

  const both = S(LIVE, LIVE);
  ck('BOTH registries ⇒ dual business', both.isDual);
  ck('…both scopes', both.scopes.sort().join(',') === 'products,services', both.scopes.join(','));
  ck('…and it is trading', both.isTrading);
}

console.log('\n── The cyber café: sells airtime, prints documents ──');
{
  const cyber = S({ status: 'active', shopId: 'kass' }, { status: 'active', providerId: 'kass' });
  ck('it may use the merchant workspace', B.canUseMerchantWorkspace(cyber));
  ck('it gets BOTH catalogue kinds',
     B.catalogueKindsFor(cyber).join(',') === 'product,service', B.catalogueKindsFor(cyber).join(','));
  ck('it may bill a product line', B.mayTrade(cyber, 'product'));
  ck('it may bill a service line', B.mayTrade(cyber, 'service'));
}

console.log('\n── Scope is NOT self-claimable ──');
{
  /* Every one of these is a field an account can write on its own record. */
  const liar = S(
    { businessType: 'provider', category: 'services', hub: 'service', isProvider: true, role: 'provider' },
    null);
  ck('businessType:"provider" grants NO service scope', !liar.providesServices);
  ck('category/hub/isProvider/role grant nothing either', liar.scopes.join(',') === 'products' || !liar.providesServices);
  ck('the reason is not_applied, not approved', liar.reasons.services === 'not_applied', liar.reasons.services);

  /* POSITIVE CONTROL — the resolver CAN grant services, so the refusals above
     are about the source of truth and not about it never granting anything. */
  ck('a real providers doc DOES grant services', S(null, LIVE).providesServices);
}

console.log('\n── Suspension revokes, per scope, independently ──');
{
  const half = S({ status: 'suspended' }, LIVE);
  ck('a suspended seller loses products', !half.sellsProducts);
  ck('…but the live provider keeps services', half.providesServices);
  ck('…so it is no longer dual', !half.isDual);
  ck('…and is still trading', half.isTrading);
  ck('the reason distinguishes suspended from never-applied',
     half.reasons.products === 'suspended', half.reasons.products);
}
{
  ck('active:false revokes even with status "active"',
     !S({ status: 'active', active: false }, null).sellsProducts);
  ck('suspended:true revokes even with status "active"',
     !S({ status: 'active', suspended: true }, null).sellsProducts);
}

console.log('\n── Unknown status is NOT active ──');
{
  ck('status "pending" does not trade', !S({ status: 'pending' }, null).sellsProducts);
  ck('…reported as pending_review', S({ status: 'pending' }, null).reasons.products === 'pending_review');
  ck('status "rejected" does not trade', !S({ status: 'rejected' }, null).sellsProducts);
  ck('a status nobody recognises does not trade', !S({ status: 'quantum' }, null).sellsProducts);
  ck('…and is reported AS ITSELF, not bucketed as suspended',
     S({ status: 'quantum' }, null).reasons.products === 'unknown_status:quantum',
     S({ status: 'quantum' }, null).reasons.products);
  /* Inverting control: the recognised ones still work. */
  ck('"approved" trades', S({ status: 'approved' }, null).sellsProducts);
  ck('"active" trades', S({ status: 'active' }, null).sellsProducts);
  ck('case and padding do not matter', S({ status: '  ACTIVE ' }, null).sellsProducts);
}

console.log('\n── A pre-status legacy record still trades ──');
{
  ck('a doc with no status at all is live', S({ shopId: 'old' }, null).sellsProducts);
  ck('…but not if it is explicitly deactivated',
     !S({ shopId: 'old', active: false }, null).sellsProducts);
}

console.log('\n── mayTrade refuses what it does not know ──');
{
  const dual = S(LIVE, LIVE);
  ck('an unrecognised kind is refused even for a dual business', !B.mayTrade(dual, 'crypto'));
  ck('…and for undefined', !B.mayTrade(dual, undefined));
  ck('a null scope trades nothing', !B.mayTrade(null, 'product'));
  ck('…and cannot reach the workspace', !B.canUseMerchantWorkspace(null));
  /* Inverting control. */
  ck('…while a real dual scope can', B.canUseMerchantWorkspace(dual));
}

console.log('\n── Garbage in ──');
{
  ck('no argument at all does not throw', B.resolveBusinessScope().isTrading === false);
  ck('a string instead of a doc grants nothing', !S('active', null).sellsProducts);
  ck('a number grants nothing', !S(7, null).sellsProducts);
}

console.log('\n── Purity ──');
{
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'functions', 'shared', 'business-scope.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no firestore', !/firestore|admin\./i.test(code));
  ck('no require of firebase', !/require\(['"]firebase/.test(code));
  ck('no Date.now', !/Date\.now/.test(code));
  ck('no subscription is consulted — scope is not purchasable',
     !/subscription|capabilit/i.test(code));
  ck('…and the stripped source still has real code',
     /function resolveBusinessScope/.test(code), code.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
