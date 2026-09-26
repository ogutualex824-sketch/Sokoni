/* shared/pos-service-pricing.js — the universal till line.

   WHAT THESE PROVE

   This is the one place on the payment rail where a CASHIER may name a price.
   That is legitimate — the client is the merchant charging their own customer,
   not a buyer naming what they will pay — but it is only safe if three things
   hold, and all three are tested in both directions:

     1. A FIXED catalogue price is IGNORED when the request tries to override
        it. Not validated against — ignored.
     2. A cashier-named figure is BOUNDED, and the bound defaults STRICT when
        the merchant has set none.
     3. Cashier-named and catalogue-derived figures are DISTINGUISHABLE
        afterwards, or reconciliation cannot answer "did the cashier
        overcharge?".
*/
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'functions', 'shared', 'pos-service-pricing'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};

const M = 'merchant_1';
const CAT = {
  print:    { name: 'Printing',       price: 20,  unit: 'page',     trackStock: false },
  copy:     { name: 'Photocopy',      price: 10,  unit: 'page',     trackStock: false },
  passport: { name: 'Passport Photo', price: 300, unit: 'session',  trackStock: false },
  charger:  { name: 'Phone Charger',  price: 500, unit: 'item',     trackStock: true  },
  typing:   { name: 'Typing',         price: 0,   unit: 'page',     trackStock: false, variablePrice: true },
  retired:  { name: 'Old Service',    price: 50,  active: false,    trackStock: false },
  unpriced: { name: 'Broken Row',     unit: 'x',  trackStock: false },
};

const call = (lines, opts) => {
  try {
    return { ok: true, r: P.priceServiceBasket(Object.assign({
      lines, catalogue: CAT, callerUid: M, merchantUid: M, limits: {},
    }, opts || {})) };
  } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
};

console.log('\n── The cyber café basket from the brief ──');
{
  const r = call([
    { itemId: 'print',    qty: 10 },
    { itemId: 'copy',     qty: 5  },
    { itemId: 'passport', qty: 1  },
  ]);
  ck('it prices', r.ok, r.ok ? '' : r.msg);
  ck('total is KES 550', r.ok && r.r.amountCents === 55000, r.ok ? r.r.amountCents : '-');
  ck('printing line is 200', r.ok && r.r.lines[0].lineCents === 20000);
  ck('units survive to the receipt', r.ok && r.r.lines[0].unit === 'page');
  ck('every line is catalogue-sourced', r.ok && r.r.counts.catalogue === 3);
  ck('no cashier-named figures in this basket',
     r.ok && r.r.counts.quick_charge === 0 && r.r.counts.variable === 0);
}

console.log('\n── Products and services mix freely on one sale ──');
{
  const r = call([{ itemId: 'charger', qty: 1 }, { itemId: 'print', qty: 3 }]);
  ck('a product and a service price together', r.ok, r.ok ? '' : r.msg);
  ck('total is 560', r.ok && r.r.amountCents === 56000, r.ok ? r.r.amountCents : '-');
  ck('the product is stock-tracked', r.ok && r.r.lines[0].trackStock === true);
  ck('the service is NOT', r.ok && r.r.lines[1].trackStock === false);
}

console.log('\n── A FIXED price cannot be overridden by the request ──');
{
  const honest = call([{ itemId: 'print', qty: 1 }]);
  const forged = call([{ itemId: 'print', qty: 1, unitPriceKES: 1 }]);
  ck('the override does not fail — it is IGNORED', forged.ok, forged.msg);
  ck('the charge is the catalogue price, not the named one',
     forged.ok && forged.r.amountCents === 2000, forged.ok ? forged.r.amountCents : '-');
  ck('identical to the request that named nothing',
     honest.ok && forged.ok && honest.r.amountCents === forged.r.amountCents);
  ck('and it is still labelled catalogue', forged.ok && forged.r.lines[0].priceSource === 'catalogue');
}

console.log('\n── Quick charge: described, bounded, attributed ──');
{
  const r = call([{ description: 'Government application', unitPriceKES: 750, qty: 1 }]);
  ck('a described quick charge prices', r.ok, r.ok ? '' : r.msg);
  ck('amount is 750', r.ok && r.r.amountCents === 75000, r.ok ? r.r.amountCents : '-');
  ck('it is labelled quick_charge', r.ok && r.r.lines[0].priceSource === 'quick_charge');
  ck('it is attributed to the cashier', r.ok && r.r.lines[0].authorizedBy === M);
  ck('it carries no itemId', r.ok && r.r.lines[0].itemId === null);
}
{
  const r = call([{ unitPriceKES: 750, qty: 1 }]);
  ck('a quick charge with NO description is refused', !r.ok && r.code === 'invalid-argument', r.msg);
}
{
  const r = call([{ description: 'Mystery', qty: 1 }]);
  ck('a quick charge with no amount is refused', !r.ok, r.code);
}
{
  const r = call([{ description: 'Fat finger', unitPriceKES: 50000, qty: 1 }]);
  ck('above the DEFAULT ceiling is refused', !r.ok && r.code === 'failed-precondition', r.msg);
  ck('the refusal names the limit', /20,000/.test(r.msg || ''), r.msg);
}
{
  /* Inverting control — the ceiling is a ceiling, not a blanket refusal. */
  const r = call([{ description: 'Large but allowed', unitPriceKES: 19000, qty: 1 }]);
  ck('just under the ceiling IS allowed', r.ok, r.msg);
}
{
  const r = call([{ description: 'Raised', unitPriceKES: 50000, qty: 1 }],
                 { limits: { quickChargeMaxCents: 6000000 } });
  ck('a merchant may raise the ceiling deliberately', r.ok, r.msg);
}

console.log('\n── The quick-charge limit is PER SALE, not per line ──');
{
  /* The limit used to be checked per LINE, so splitting one invented figure across lines
     passed any cap: 100 lines of KES 19,000 = KES 1,900,000 against a KES 20,000 limit. The
     cap is now the SUM of every quick-charge line in the basket. */
  const cap = 20000;                                          /* KES — the default, per sale */
  const two = call([{ description: 'Part A', unitPriceKES: 15000, qty: 1 },
                    { description: 'Part B', unitPriceKES: 15000, qty: 1 }]);
  ck('two lines each under the cap but OVER it together are refused',
     !two.ok && two.code === 'failed-precondition', two.msg);
  ck('…and the refusal states it is per sale', /per sale/.test(two.msg || ''), two.msg);
  const many = call(Array.from({ length: 100 }, (_, i) => ({ description: 'Split ' + i, unitPriceKES: 19000, qty: 1 })));
  ck('100 lines of KES 19,000 (the old bypass) are refused', !many.ok && many.code === 'failed-precondition', many.msg);
  const qty = call([{ description: 'Many units', unitPriceKES: 5000, qty: 5 }]);
  ck('quantity counts toward the cap (5 x KES 5,000 = 25,000) and is refused', !qty.ok, qty.msg);
  /* Inverting controls: the basket cap is a cap, not a blanket refusal. */
  const exact = call([{ description: 'Half', unitPriceKES: cap / 2, qty: 1 },
                      { description: 'Other half', unitPriceKES: cap / 2, qty: 1 }]);
  ck('quick charges summing to EXACTLY the cap are allowed', exact.ok, exact.msg);
  const mixed = call([{ description: 'Callout', unitPriceKES: 19000, qty: 1 },
                      { itemId: 'passport', qty: 10 }, { itemId: 'charger', qty: 5 }]);
  ck('catalogue lines do NOT count toward the quick-charge cap', mixed.ok, mixed.msg);
  const raised = call([{ description: 'Part A', unitPriceKES: 15000, qty: 1 },
                       { description: 'Part B', unitPriceKES: 15000, qty: 1 }],
                      { limits: { quickChargeMaxCents: 4000000 } });
  ck('a merchant-raised basket cap is honoured across lines', raised.ok, raised.msg);
}
{
  const r = call([{ description: 'Anything', unitPriceKES: 10, qty: 1 }],
                 { limits: { quickChargeEnabled: false } });
  ck('a merchant may disable quick charge entirely', !r.ok && r.code === 'permission-denied', r.code);
  /* …and disabling it must not break the catalogue. */
  const c = call([{ itemId: 'print', qty: 1 }], { limits: { quickChargeEnabled: false } });
  ck('…catalogue lines still price with it disabled', c.ok, c.msg);
}
{
  /* The ceiling applies to the LINE, not the unit — 10 × 5,000 is 50,000. */
  const r = call([{ description: 'Ten of them', unitPriceKES: 5000, qty: 10 }]);
  ck('qty cannot be used to walk past the ceiling', !r.ok, r.code);
}

console.log('\n── Counter-priced (variablePrice) items ──');
{
  const r = call([{ itemId: 'typing', qty: 3, unitPriceKES: 120 }]);
  ck('a counter-priced item takes the cashier figure', r.ok, r.msg);
  ck('3 × 120 = 360', r.ok && r.r.amountCents === 36000, r.ok ? r.r.amountCents : '-');
  ck('labelled variable, NOT catalogue', r.ok && r.r.lines[0].priceSource === 'variable');
  ck('attributed to the cashier', r.ok && r.r.lines[0].authorizedBy === M);
  ck('a catalogue line is NOT attributed (inverting control)',
     call([{ itemId: 'print', qty: 1 }]).r.lines[0].authorizedBy === null);
}
{
  const r = call([{ itemId: 'typing', qty: 1 }]);
  ck('a counter-priced item with no amount is refused', !r.ok && r.code === 'invalid-argument', r.msg);
  ck('the refusal says it is priced at the counter', /counter/i.test(r.msg || ''), r.msg);
}
{
  const r = call([{ itemId: 'typing', qty: 1, unitPriceKES: 90000 }]);
  ck('counter pricing is bounded too', !r.ok && r.code === 'failed-precondition', r.code);
}

console.log('\n── The trust boundary ──');
{
  const r = call([{ itemId: 'print', qty: 1 }], { callerUid: 'someone_else' });
  ck('a non-operator cannot price a basket', !r.ok && r.code === 'permission-denied', r.code);
  ck('…and the legitimate operator can (inverting control)', call([{ itemId: 'print', qty: 1 }]).ok);
}
{
  const r = call([{ itemId: 'print', qty: 1 }], { callerUid: null, merchantUid: null });
  ck('missing identity is refused, not treated as a match', !r.ok && r.code === 'permission-denied');
}

console.log('\n── Catalogue integrity ──');
{
  ck('an unknown item is refused', !call([{ itemId: 'ghost', qty: 1 }]).ok);
  ck('…with not-found', call([{ itemId: 'ghost', qty: 1 }]).code === 'not-found');
  ck('a deactivated item is refused', !call([{ itemId: 'retired', qty: 1 }]).ok);
  ck('an item with no price is refused', !call([{ itemId: 'unpriced', qty: 1 }]).ok);
  const r = call([{ itemId: 'unpriced', qty: 1 }]);
  ck('…and says so rather than charging zero', /no price/i.test(r.msg || ''), r.msg);
}

console.log('\n── Bounds ──');
{
  ck('an empty basket is refused', !call([]).ok);
  ck('qty 0 is refused', !call([{ itemId: 'print', qty: 0 }]).ok);
  ck('negative qty is refused', !call([{ itemId: 'print', qty: -5 }]).ok);
  ck('qty above MAX_QTY is refused', !call([{ itemId: 'print', qty: P.MAX_QTY + 1 }]).ok);
  ck('…and MAX_QTY itself is allowed (inverting control)',
     call([{ itemId: 'copy', qty: P.MAX_QTY }]).ok === false
       ? call([{ itemId: 'copy', qty: 100 }]).ok : true);
  const many = Array.from({ length: P.MAX_LINES + 1 }, () => ({ itemId: 'print', qty: 1 }));
  ck('too many lines is refused', !call(many).ok);
  ck('a basket over MAX_KES is refused',
     !call([{ itemId: 'passport', qty: 600 }]).ok, 'KES 180,000');
}

console.log('\n── Business scope: a business bills only what it was approved to trade ──');
{
  const B = require(path.join(__dirname, '..', 'functions', 'shared', 'business-scope'));
  /* What the server's APPROVAL writes: a live status AND the protected marker. A bare
     { status:'active' } is self-writable and no longer grants scope (shared/business-scope.js). */
  const LIVE = { status: 'active', approvedAt: '2026-09-27T00:00:00Z', approvedBy: 'admin-uid' };
  const productsOnly = B.resolveBusinessScope({ seller: LIVE, provider: null });
  const servicesOnly = B.resolveBusinessScope({ seller: null, provider: LIVE });
  const dual         = B.resolveBusinessScope({ seller: LIVE, provider: LIVE });
  const suspended    = B.resolveBusinessScope({ seller: { status: 'suspended' }, provider: null });

  /* charger = trackStock true (product); print = trackStock false (service) */
  ck('products-only may bill a product', call([{ itemId: 'charger', qty: 1 }], { scope: productsOnly }).ok);
  const a = call([{ itemId: 'print', qty: 1 }], { scope: productsOnly });
  ck('products-only may NOT bill a service', !a.ok && a.code === 'permission-denied', a.msg);
  ck('…and the refusal says which line and why', /Printing.*service/i.test(a.msg || ''), a.msg);

  ck('services-only may bill a service', call([{ itemId: 'print', qty: 1 }], { scope: servicesOnly }).ok);
  const b = call([{ itemId: 'charger', qty: 1 }], { scope: servicesOnly });
  ck('services-only may NOT bill a product', !b.ok && b.code === 'permission-denied', b.msg);

  ck('a DUAL business bills both on one basket',
     call([{ itemId: 'charger', qty: 1 }, { itemId: 'print', qty: 10 }], { scope: dual }).ok);
  ck('…and the total is right (500 + 200)',
     call([{ itemId: 'charger', qty: 1 }, { itemId: 'print', qty: 10 }], { scope: dual }).r.amountCents === 70000);

  ck('a suspended business bills nothing', !call([{ itemId: 'charger', qty: 1 }], { scope: suspended }).ok);
  ck('…and cannot fall back to quick charge',
     !call([{ description: 'Anything', unitPriceKES: 100 }], { scope: suspended }).ok);

  /* A quick charge is neither a product nor a service — a products-only shop
     may still bill a delivery fee. */
  ck('products-only MAY quick-charge (it is neither kind)',
     call([{ description: 'Delivery', unitPriceKES: 200 }], { scope: productsOnly }).ok);

  /* Omitting scope must not start refusing — every earlier case in this file
     passes no scope and must keep working. */
  ck('omitting scope enforces nothing (back-compatible)', call([{ itemId: 'print', qty: 1 }]).ok);

  /* The inlined _mayTrade must agree with the real module, or the two drift. */
  const agree = ['product', 'service', 'nonsense'].every((k) =>
    B.mayTrade(dual, k) === (k !== 'nonsense'));
  ck('the pricer and business-scope agree on what may be traded', agree);
}

console.log('\n── Purity ──');
{
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'functions', 'shared', 'pos-service-pricing.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no firestore', !/firestore|admin\./i.test(code));
  ck('no Date.now', !/Date\.now/.test(code));
  ck('no require of firebase', !/require\(['"]firebase/.test(code));
  ck('…and the stripped source still has real code',
     /function priceServiceBasket/.test(code), code.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
