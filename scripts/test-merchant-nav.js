/* sokoni-merchant-nav.js — identity decides what EXISTS, subscription decides
   what is USABLE.

   THE TWO PROPERTIES THIS SUITE EXISTS FOR

     1. A SUBSCRIPTION NEVER CREATES A WORKSPACE. Paying for a seller plan
        without a seller approval must show nothing. If this ever passes,
        selling has become purchasable — which is the exact boundary
        capability-authority.js was written to hold.

     2. THE TWO SIDES ARE INDEPENDENT. Cancelling the seller subscription must
        not change one field of the services side.

   Both are tested with inverting controls, because "shows nothing" and
   "unchanged" are absence claims and would each pass against a resolver that
   returned nothing at all.
*/
'use strict';
const path = require('path');
const N = require(path.join(__dirname, '..', 'sokoni-merchant-nav.js'));
const B = require(path.join(__dirname, '..', 'functions', 'shared', 'business-scope.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};

/* What the server's APPROVAL writes: live status AND the protected marker. A bare
   { status:'active' } is self-writable and no longer grants scope (shared/business-scope.js). */
const LIVE = { status: 'active', approvedAt: '2026-09-27T00:00:00Z', approvedBy: 'admin-uid' };
const scope = (p, s) => B.resolveBusinessScope({ seller: p ? LIVE : null, provider: s ? LIVE : null });
const sub = (status, tier) => ({ found: true, status, tier: tier || 'professional' });
const NOSUB = { found: false, status: 'none', tier: null };

const nav = (o) => N.resolveNav(o);

console.log('\n── The cyber café: both approved, both subscribed ──');
{
  const r = nav({ scope: scope(true, true), sellerSub: sub('active'), providerSub: sub('active') });
  ck('dual', r.isDual);
  ck('dual and fully active', r.isDualActive);
  ck('products usable', r.products.usable);
  ck('services usable', r.services.usable);
  ck('can open Products', N.canOpen(r, 'products'));
  ck('can open Service catalogue', N.canOpen(r, 'services'));
  ck('can open the Till', N.canOpen(r, 'till'));
  ck('both catalogue kinds creatable',
     N.creatableKinds(r).sort().join(',') === 'product,service', N.creatableKinds(r).join(','));
  ck('two subscription cards', N.subscriptionCards(r).length === 2);
  ck('…labelled Seller and Service provider',
     N.subscriptionCards(r).map(c => c.label).join('|') === 'Seller|Service provider');
}

console.log('\n── 1. A SUBSCRIPTION NEVER CREATES A WORKSPACE ──');
{
  /* Paying for both plans while approved for NEITHER. */
  const r = nav({ scope: scope(false, false), sellerSub: sub('active'), providerSub: sub('active') });
  ck('no approval ⇒ products workspace ABSENT', r.products.state === 'absent', r.products.state);
  ck('no approval ⇒ services workspace ABSENT', r.services.state === 'absent', r.services.state);
  ck('…not usable', !r.products.usable && !r.services.usable);
  ck('…Products is not even visible', !N.canOpen(r, 'products'));
  ck('…the Till is not visible', !r.sections.find(s => s.id === 'till').visible);
  ck('…nothing is creatable', N.creatableKinds(r).length === 0);
  ck('…and no subscription card is offered for an unapproved side',
     N.subscriptionCards(r).length === 0);
  ck('the reason invites APPLYING, not paying',
     /Apply to sell products/.test(N.whyBlocked(r, 'products') || ''), N.whyBlocked(r, 'products'));

  /* INVERTING CONTROL — the same live subscription DOES work once approved,
     so the absences above are about approval and not about the resolver
     never granting anything. */
  const ok = nav({ scope: scope(true, false), sellerSub: sub('active'), providerSub: NOSUB });
  ck('…the identical subscription works WITH approval', ok.products.usable);
}

console.log('\n── An approval without a subscription still SHOWS, restricted ──');
{
  const r = nav({ scope: scope(true, true), sellerSub: NOSUB, providerSub: sub('active') });
  ck('products is restricted, not absent', r.products.state === 'restricted', r.products.state);
  ck('…still VISIBLE — the merchant\'s data does not vanish',
     r.sections.find(s => s.id === 'products').visible);
  ck('…but not usable', !r.products.usable);
  ck('…with a reason that says the data is safe',
     /data is safe|Start a seller subscription/.test(r.products.reason || ''), r.products.reason);
  ck('services is unaffected and usable', r.services.usable);
  ck('the Till still opens on the services side',
     N.canOpen(r, 'till'), 'either side usable ⇒ till usable');
  ck('only services is creatable', N.creatableKinds(r).join(',') === 'service');
}

console.log('\n── Lapsed-subscription wording is specific ──');
{
  const mk = (st) => nav({ scope: scope(true, false), sellerSub: sub(st), providerSub: NOSUB }).products.reason;
  ck('past_due mentions overdue', /overdue/i.test(mk('past_due') || ''), mk('past_due'));
  ck('cancelled mentions cancelled', /cancelled/i.test(mk('cancelled') || ''), mk('cancelled'));
  ck('expired mentions expired', /expired/i.test(mk('expired') || ''), mk('expired'));
  ck('all three reassure the data is safe',
     ['past_due', 'cancelled', 'expired'].every(s => /data is safe/i.test(mk(s) || '')));
}

console.log('\n── 2. THE TWO SIDES ARE INDEPENDENT ──');
{
  const before = nav({ scope: scope(true, true), sellerSub: sub('active'), providerSub: sub('active') });
  const after  = nav({ scope: scope(true, true), sellerSub: sub('cancelled'), providerSub: sub('active') });

  ck('cancelling SELLER stops the products side', before.products.usable && !after.products.usable);
  ck('…and the services side is byte-identical',
     JSON.stringify(before.services) === JSON.stringify(after.services),
     JSON.stringify(after.services).slice(0, 60));
  ck('…services can still be created', N.creatableKinds(after).join(',') === 'service');
  ck('…the service catalogue still opens', N.canOpen(after, 'services'));
  ck('…and the business is still DUAL (approval is untouched)', after.isDual);
  ck('…but no longer dual-ACTIVE', !after.isDualActive);
}
{
  const before = nav({ scope: scope(true, true), sellerSub: sub('active'), providerSub: sub('active') });
  const after  = nav({ scope: scope(true, true), sellerSub: sub('active'), providerSub: sub('cancelled') });
  ck('cancelling PROVIDER stops the services side', !after.services.usable);
  ck('…and the products side is byte-identical',
     JSON.stringify(before.products) === JSON.stringify(after.products));
  ck('…products can still be created', N.creatableKinds(after).join(',') === 'product');
  ck('…the merchant keeps their products', N.canOpen(after, 'products'));
}

console.log('\n── Account-level sections never lock ──');
{
  const dead = nav({ scope: scope(true, true), sellerSub: sub('cancelled'), providerSub: sub('expired') });
  ck('nothing commercial is usable', !dead.anyUsable);
  for (const id of ['billing', 'applications', 'profile', 'reports', 'tax', 'payouts', 'customers', 'payments', 'overview']) {
    ck(`${id} is still usable`, N.canOpen(dead, id));
  }
  /* Billing above all — locking the page where they would fix the lapse is a
     trap, and it is the one section that MUST work when nothing else does. */
  ck('…and the Till is correctly NOT usable', !N.canOpen(dead, 'till'));
}

console.log('\n── Unknown subscription status is NOT live ──');
{
  ck('active is live', N.subLive(sub('active')));
  ck('trialing is live', N.subLive(sub('trialing')));
  ck('a status nobody recognises is NOT live', !N.subLive(sub('quantum')));
  ck('found:false is not live', !N.subLive({ found: false, status: 'active' }));
  ck('null is not live', !N.subLive(null));
  ck('case and padding do not matter', N.subLive(sub('  ACTIVE ')));
}

console.log('\n── Suspension of an approval removes the workspace ──');
{
  const susp = B.resolveBusinessScope({ seller: { status: 'suspended' }, provider: LIVE });
  const r = nav({ scope: susp, sellerSub: sub('active'), providerSub: sub('active') });
  ck('a suspended approval is ABSENT even with a live plan', r.products.state === 'absent');
  ck('…the reason names the suspension',
     /suspended/i.test(N.whyBlocked(r, 'products') || ''), N.whyBlocked(r, 'products'));
  ck('…and the services side is untouched', r.services.usable);
}
{
  const pend = B.resolveBusinessScope({ seller: null, provider: { status: 'pending' } });
  const r = nav({ scope: pend, sellerSub: NOSUB, providerSub: NOSUB });
  ck('a pending application says "in review"',
     /in review/i.test(N.whyBlocked(r, 'services') || ''), N.whyBlocked(r, 'services'));
}

console.log('\n── Garbage in ──');
{
  const r = nav();
  ck('no arguments does not throw', r && r.anyUsable === false);
  ck('…and shows no commercial workspace', N.creatableKinds(r).length === 0);
  ck('…but account sections still exist', N.canOpen(r, 'billing'));
  ck('an unknown section reports so', /Unknown section/.test(N.whyBlocked(r, 'nope') || ''));
}

console.log('\n── Purity and boundary ──');
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'sokoni-merchant-nav.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no DOM', !/\bdocument\./.test(code));
  ck('no firestore / firebase', !/firestore|firebase/i.test(code));
  ck('no Date.now', !/Date\.now/.test(code));
  ck('it never reads a subscription itself', !/resolveSubscription|collection\(/.test(code));
  ck('no payment code', !/createPaymentIntent|webhookIntasend|completeMultiTender/.test(code));
  ck('…and the stripped source still has real code',
     /function resolveNav/.test(code), code.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
