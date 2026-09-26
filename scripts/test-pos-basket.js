/* sokoni-pos-basket.js — one basket, products + services + custom charges.

   THE PROPERTY THIS SUITE EXISTS FOR

   A line's SOURCE and KIND must survive into the server request, because that
   is what lets reconciliation answer "how much of this sale was catalogue
   price and how much did a cashier type in?". A basket that flattened the
   three into "items" would make that question unanswerable after the fact.

   And the basket must NOT price the sale. toPricingRequest emits lines and no
   total — asserted, with an inverting control proving the emitter does produce
   something, so "no total" cannot pass against an empty object.
*/
'use strict';
const path = require('path');
const B = require(path.join(__dirname, '..', 'sokoni-pos-basket.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 76) + ']' : ''));
  ok ? pass++ : fail++;
};

const CASHIER = 'uid_cashier_1';
/* The cyber cafe basket from the brief. */
const USB     = { id: 'p1', name: 'USB Flash Disk', price: 800, qty: 1, trackStock: true };
const PRINT   = { id: 's1', name: 'Printing', price: 20, qty: 10, trackStock: false, unit: 'page' };
const SCAN    = { id: 's2', name: 'Scanning', price: 50, qty: 2, trackStock: false, unit: 'document' };
const REPAIR  = { id: 's3', name: 'Computer Repair', price: 500, qty: 1, trackStock: false, unit: 'service', variablePrice: true };
const LEGACY  = { id: 'p0', name: 'Old Line', price: 300, qty: 1 };   /* pre-existing cart shape */

console.log('\n── Backward compatibility: a live till\'s existing lines ──');
ck('a line with no source is CATALOGUE', B.sourceOf(LEGACY) === 'catalogue');
ck('a line with no kind is a PRODUCT', B.kindOf(LEGACY) === 'product');
ck('…matching what the server pricer assumes', B.isProduct(LEGACY));
ck('trackStock:false is a SERVICE', B.isService(PRINT));
ck('null does not throw', B.kindOf(null) === 'product');

console.log('\n── The cyber cafe basket ──');
{
  const basket = [USB, PRINT, SCAN, REPAIR];
  ck('USB 800', B.lineCents(USB) === 80000, B.lineCents(USB));
  ck('Printing x10 = 200', B.lineCents(PRINT) === 20000, B.lineCents(PRINT));
  ck('Scanning x2 = 100', B.lineCents(SCAN) === 10000, B.lineCents(SCAN));
  ck('Repair 500', B.lineCents(REPAIR) === 50000);
  /* 800 + 200 + 100 + 500 — the figure the brief's own till shows. */
  ck('TOTAL 1,600', B.subtotalCents(basket) === 160000, B.subtotalCents(basket));
  ck('…formatted', B.fmtKES(B.subtotalCents(basket)) === 'KES 1,600.00',
     B.fmtKES(B.subtotalCents(basket)));

  const c = B.census(basket);
  ck('1 product, 3 services', c.products === 1 && c.services === 3, JSON.stringify(c));
  ck('it is a MIXED basket', c.isMixed);
  ck('no quick charges yet', c.quickCharges === 0);
}

console.log('\n── Grouping: products, services, custom charges ──');
{
  const qc = B.quickChargeLine({ description: 'Passport assistance', amountKES: 750 }, CASHIER);
  const g = B.groups([USB, PRINT, SCAN, qc]);
  ck('three groups', g.length === 3, g.map(x => x.key).join(','));
  ck('order is products → services → custom',
     g.map(x => x.key).join(',') === 'products,services,custom');
  ck('products group holds the USB only', g[0].lines.length === 1);
  ck('services group holds both catalogue services', g[1].lines.length === 2);
  ck('custom group holds the quick charge', g[2].lines.length === 1);
  ck('each group carries its own subtotal',
     g[0].subtotalCents === 80000 && g[1].subtotalCents === 30000 && g[2].subtotalCents === 75000,
     g.map(x => x.subtotalCents).join('/'));
  /* An empty group is not rendered — a "Services" heading over nothing is
     worse than no heading. */
  ck('an all-product basket has ONE group', B.groups([USB, LEGACY]).length === 1);
}

console.log('\n── Quick charge: described, attributed, labelled ──');
{
  const qc = B.quickChargeLine({ description: 'Passport application assistance', amountKES: 750 }, CASHIER);
  ck('it builds', !!qc);
  ck('the description becomes the name', qc.name === 'Passport application assistance');
  ck('price is carried', qc.price === 750);
  ck('source is quick_charge', qc.source === 'quick_charge');
  ck('kind is SERVICE — work done, not stock moved', qc.kind === 'service');
  ck('attributed to the cashier', qc.authorizedBy === CASHIER);
  ck('labelled for the cashier', B.labelFor(qc) === 'Custom service charge', B.labelFor(qc));
  ck('a catalogue service is labelled differently', B.labelFor(PRINT) === 'Service');
  ck('a product is labelled differently again', B.labelFor(USB) === 'Product');
  ck('the id cannot collide with a posProducts id', /^qc_/.test(qc.id), qc.id);
  ck('it carries NO taxRate (nothing authorised one)', qc.taxRate === undefined);
}
{
  /* Two different custom charges must not merge the way two scans of one
     product do. */
  const a = B.quickChargeLine({ description: 'Thing A', amountKES: 100 }, CASHIER);
  const b = B.quickChargeLine({ description: 'Thing B', amountKES: 200 }, CASHIER);
  ck('two quick charges get distinct ids', a.id !== b.id, a.id + ' / ' + b.id);
  ck('…and both survive in the basket', B.census([a, b]).quickCharges === 2);
}

console.log('\n── Quick charge refusals ──');
{
  const bad = (d, o) => B.validateQuickCharge(d, o);
  ck('no description is refused', !bad({ amountKES: 100 }).ok);
  ck('…and says what is missing', /what the charge is for/i.test(bad({ amountKES: 100 }).problems.join(' ')));
  ck('no amount is refused', !bad({ description: 'X' }).ok);
  ck('zero is refused', !bad({ description: 'X', amountKES: 0 }).ok);
  ck('negative is refused', !bad({ description: 'X', amountKES: -5 }).ok);
  ck('a valid charge passes (inverting control)', bad({ description: 'X', amountKES: 750 }).ok);
  let threw = false;
  try { B.quickChargeLine({ description: 'X', amountKES: 100 }, null); } catch (_) { threw = true; }
  ck('an UNATTRIBUTED quick charge throws', threw);
}

console.log('\n── The ceiling is the SERVER\'s, not ours ──');
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'sokoni-pos-basket.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no hard-coded 20000 anywhere in the code', !/20000|2000000/.test(code));
  ck('no DEFAULT ceiling constant', !/CEILING\s*=|MAX_QUICK/.test(code));
  /* It may WARN when handed the merchant's own figure — early feedback, not
     authority. */
  const warn = B.validateQuickCharge({ description: 'Big', amountKES: 50000 },
    { advisoryCeilingCents: 2000000 });
  ck('given the merchant\'s figure it warns early', !warn.ok);
  ck('…saying the SERVER will refuse it', /server will refuse/i.test(warn.problems.join(' ')));
  /* And absent that figure it asserts NOTHING — silence is not approval. */
  ck('without a supplied ceiling it does not judge the amount',
     B.validateQuickCharge({ description: 'Big', amountKES: 50000 }).ok);
}

console.log('\n── The seam: exactly what pos_service_sale accepts ──');
{
  const qc = B.quickChargeLine({ description: 'Passport assistance', amountKES: 750 }, CASHIER);
  const req = B.toPricingRequest([USB, PRINT, REPAIR, qc]);
  ck('one entry per line', req.length === 4, req.length);
  ck('a catalogue line sends itemId + qty',
     req[0].itemId === 'p1' && req[0].qty === 1 && req[0].description === undefined);
  ck('a FIXED service sends NO price (the catalogue owns it)',
     req[1].itemId === 's1' && req[1].unitPriceKES === undefined);
  ck('a VARIABLE service DOES send the counter figure',
     req[2].itemId === 's3' && req[2].unitPriceKES === 500);
  ck('a quick charge sends description + amount, no itemId',
     req[3].description === 'Passport assistance' && req[3].unitPriceKES === 750 && req[3].itemId === undefined);
  ck('quantities survive', B.toPricingRequest([PRINT])[0].qty === 10);

  /* NO TOTAL. The server prices the sale. */
  const flat = JSON.stringify(req);
  ck('the request carries no total', !/"total"|"amount"|"subtotal"/.test(flat), flat.slice(0, 60));
  /* Inverting control — the emitter is not simply empty. */
  ck('…and it is not empty (positive control)', /itemId/.test(flat) && /description/.test(flat));
}

console.log('\n── The server pricer accepts what we emit ──');
{
  /* End-to-end against the REAL pricer, so the two cannot drift apart. */
  const P = require(path.join(__dirname, '..', 'functions', 'shared', 'pos-service-pricing.js'));
  const M = 'merchant_1';
  const CAT = {
    p1: { name: 'USB Flash Disk', price: 800, trackStock: true },
    s1: { name: 'Printing', price: 20, unit: 'page', trackStock: false },
    s3: { name: 'Computer Repair', price: 0, unit: 'service', trackStock: false, variablePrice: true },
  };
  const qc = B.quickChargeLine({ description: 'Passport assistance', amountKES: 750 }, M);
  const req = B.toPricingRequest([USB, PRINT, REPAIR, qc]);
  let out = null, err = null;
  try { out = P.priceServiceBasket({ lines: req, catalogue: CAT, callerUid: M, merchantUid: M, limits: {} }); }
  catch (e) { err = e.message; }
  ck('the real pricer accepts the emitted request', !!out, err || '');
  ck('…and totals 800 + 200 + 500 + 750 = 2,250',
     out && out.amountCents === 225000, out && out.amountCents);
  ck('…classifying 2 catalogue, 1 variable, 1 quick charge',
     out && out.counts.catalogue === 2 && out.counts.variable === 1 && out.counts.quick_charge === 1,
     out && JSON.stringify(out.counts));
  ck('…and the quick charge is attributed server-side',
     out && out.lines[3].authorizedBy === M);
}

console.log('\n── This slice does not touch the money path ──');
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'sokoni-pos-basket.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no completeMultiTender', !/completeMultiTender/.test(code));
  ck('no createPaymentIntent', !/createPaymentIntent/.test(code));
  ck('no webhook reference', !/webhook/i.test(code));
  ck('nothing marks anything paid', !/\bpaid\b/i.test(code));
  ck('no DOM, no firestore', !/document\.|firestore|firebase/i.test(code));
  ck('…and the stripped source still has real code',
     /function toPricingRequest/.test(code), code.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
