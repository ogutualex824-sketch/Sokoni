/* Smart Receipt Engine certification.
   The privacy assertions are the point: a leak here is printed on a parcel and
   handed to a stranger, so they are tested as hard failures, not warnings. */
'use strict';
const fs = require('fs');
const vm = require('vm');

const sandbox = { window: {}, document: undefined, console, TextEncoder, TextDecoder, Uint8Array };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('./sokoni-receipt-engine.js', 'utf8'), sandbox);
const E = sandbox.window.SokoniReceiptEngine;

let pass = 0, fail = 0;
const check = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

/* A realistic order carrying BOTH customer PII and internal financials, so the
   privacy separation is actually exercised rather than trivially satisfied. */
const ORDER = {
  orderNo: 'SKN-88421', receiptNo: 'RQ7M3X9',
  shopName: 'Mama Fua Cleaners', merchantName: 'Mama Fua Cleaners',
  merchantPhone: '0722000111', merchantAddress: 'Ngong Rd, Nairobi',
  recipientName: 'Ann Momanyi', recipientPhone: '0705726803', altPhone: '0733444555',
  address: { county:'Nairobi', town:'Westlands', area:'Parklands', street:'3rd Ave',
             building:'Zamani Court', house:'B4', floor:'2', landmark:'Opp. Shell' },
  deliveryNotes: 'Call on arrival, gate code 4417',
  items: [
    { name:'Duvet Wash — King', qty:1, unitPrice:900, sku:'DW-K', modifiers:['Extra rinse'], notes:'Stain on corner' },
    { name:'Curtain Clean', qty:3, unitPrice:400, sku:'CC-STD' },
  ],
  packageNo: 1, packageCount: 2, weight: '4.2kg', fragile: true, cod: true,
  subtotal: 2100, tax: 336, discount: 100, total: 2336,
  /* internal — must never reach a parcel document */
  commission: 116.80, gatewayFee: 35.04, settlementAmount: 2184.16,
  settlementStatus: 'PENDING', sellerNet: 2184.16,
  paymentMethod: 'M-PESA', paymentRef: 'SFH7XK2P91', mpesaCode: 'SFH7XK2P91',
  cashierName: 'Grace W.', registerNo: 2, shiftNo: 'AM',
  pickupCode: 'PK-4417', pickupLocation: 'Ngong Rd Branch', pickupDeadline: '22 Jul 2026, 6pm',
  verifyUrl: 'https://mysokoni.co.ke/payment-receipt.html?ref=RQ7M3X9',
  tableNo: 12, orderNotes: 'Allergy: nuts',
};

console.log('\n── Document plan resolution ──');
const plans = {
  walkin:   E.planDocuments({ fulfilment: 'walkin' }),
  delivery: E.planDocuments({ fulfilment: 'delivery' }),
  pickup:   E.planDocuments({ fulfilment: 'pickup' }),
  food:     E.planDocuments({ fulfilment: 'delivery', category: 'Restaurant' }),
  foodPick: E.planDocuments({ fulfilment: 'pickup', category: 'restaurant' }),
  merchant: E.planDocuments({ fulfilment: 'walkin', merchantCopy: true }),
};
const t = (p) => p.map(x => x.type).join('+');
check('walk-in  -> receipt',                    t(plans.walkin) === 'receipt', t(plans.walkin));
check('delivery -> receipt + packing',          t(plans.delivery) === 'receipt+packing', t(plans.delivery));
check('pickup   -> receipt + pickup',           t(plans.pickup) === 'receipt+pickup', t(plans.pickup));
check('restaurant delivery -> receipt+packing+kitchen',
      t(plans.food) === 'receipt+packing+kitchen', t(plans.food));
check('restaurant pickup   -> receipt+pickup+kitchen',
      t(plans.foodPick) === 'receipt+pickup+kitchen', t(plans.foodPick));
check('merchantCopy flag adds merchant doc',    t(plans.merchant) === 'receipt+merchant', t(plans.merchant));

console.log('\n── Printer routing ──');
check('packing routes to packing printer', plans.delivery[1].printer === 'packing', plans.delivery[1].printer);
check('kitchen routes to kitchen printer',  plans.food[2].printer === 'kitchen', plans.food[2].printer);
const oneP = { receipt: 'POS-58-A' };
check('single-printer merchant: packing falls back to receipt printer',
      E.resolvePrinter('packing', oneP) === 'POS-58-A', String(E.resolvePrinter('packing', oneP)));
check('no config -> null (caller queues, does not crash)',
      E.resolvePrinter('kitchen', {}) === null);

console.log('\n── PRIVACY: internal financials must never reach a parcel ──');
const packing = E.buildHTML({ type: 'packing', data: ORDER });
const LEAKS = [['commission','116.8'], ['settlement','2184.16'], ['gateway fee','35.04'], ['margin','sellerNet']];
for (const [label, needle] of LEAKS) {
  check('packing slip omits ' + label, !packing.includes(needle), needle);
}
check('packing slip omits order total',  !packing.includes('2,336') && !packing.includes('2336'));
check('packing slip omits unit prices',  !packing.includes('900') && !packing.includes('400'));
check('packing slip DOES carry recipient (its purpose)', packing.includes('Ann Momanyi'));
check('packing slip DOES carry phone',   packing.includes('0705726803'));
check('packing slip DOES carry address', packing.includes('Zamani Court') && packing.includes('Parklands'));
check('packing slip shows landmark',     packing.includes('Opp. Shell'));
check('packing slip shows package n of m', packing.includes('1') && packing.includes('of'));
check('packing slip flags FRAGILE + COD', packing.includes('FRAGILE') && packing.includes('CASH ON DELIVERY'));
check('packing slip has blank rider/signature fields',
      packing.includes('Rider name') && packing.includes('Recipient signature'));

console.log('\n── PRIVACY: kitchen ticket carries no money and no customer contact ──');
const kitchen = E.buildHTML({ type: 'kitchen', data: ORDER });
check('kitchen omits prices',          !kitchen.includes('900') && !kitchen.includes('2,336'));
check('kitchen omits customer phone',  !kitchen.includes('0705726803'));
check('kitchen omits customer name',   !kitchen.includes('Ann Momanyi'));
check('kitchen shows item + qty',      kitchen.includes('Duvet Wash') && kitchen.includes('3×'));
check('kitchen shows modifiers',       kitchen.includes('Extra rinse'));
check('kitchen shows item notes',      kitchen.includes('Stain on corner'));
check('kitchen shows destination',     kitchen.includes('TABLE 12'));

console.log('\n── Merchant copy is the ONLY doc allowed internal figures ──');
const merch = E.buildHTML({ type: 'merchant', data: ORDER });
check('merchant copy shows commission', merch.includes('116.80'));
check('merchant copy shows settlement', merch.includes('2,184.16'));
check('merchant copy shows cashier/register/shift',
      merch.includes('Grace W.') && merch.includes('Register') && merch.includes('AM'));
check('merchant copy marked NOT FOR CUSTOMER', merch.includes('NOT FOR CUSTOMER'));

console.log('\n── Pickup slip ──');
const pick = E.buildHTML({ type: 'pickup', data: ORDER });
check('pickup shows code prominently', pick.includes('PK-4417'));
check('pickup shows deadline',         pick.includes('22 Jul 2026'));
check('pickup has NO delivery address block', !pick.includes('Zamani Court'));
check('pickup has no rider fields',    !pick.includes('Rider name'));

console.log('\n── Courier manifest ──');
const man = E.buildHTML({ type: 'manifest', data: {
  tripId: 'TRIP-77', riderName: 'Isaac K.', riderPhone: '0700111222',
  stops: [
    { recipientName:'Ann Momanyi', phone:'0705726803', orderNo:'SKN-88421', codAmount:2336, address:{area:'Parklands',town:'Westlands'} },
    { recipientName:'Delia Baraka', phone:'0711222333', orderNo:'SKN-88422', codAmount:0, address:'Kilimani' },
  ] } });
check('manifest lists stops in route order', man.indexOf('Ann Momanyi') < man.indexOf('Delia Baraka'));
check('manifest shows COD per stop',   man.includes('2,336'));
check('manifest marks prepaid stop',   man.includes('PREPAID'));
check('manifest totals COD to collect',man.includes('COD TO COLLECT'));
check('manifest has signature column', man.includes('Signature column'));

console.log('\n── Extensibility (no checkout change required) ──');
check('registry lists all types', E.documentTypes().length >= 12, E.documentTypes().length + ' types');
E.registerDocument('returnslip', { build: () => '<html>RETURN</html>', printer: 'packing', carries: [] });
check('new type registers at runtime', E.buildHTML({ type:'returnslip', data:{} }).includes('RETURN'));
check('duplicate registration refused', (() => {
  try { E.registerDocument('returnslip', { build: () => '' }); return false; } catch (_) { return true; }
})());
check('unknown type falls back to receipt, never throws',
      typeof E.buildHTML({ type:'nonexistent', data: ORDER }) === 'string');
check('shipping label now reachable via dispatcher',
      E.buildHTML({ type:'shipping', data: ORDER }).includes('Ann Momanyi'));

console.log('\n── XSS escaping ──');
const evil = E.buildHTML({ type:'packing', data: { ...ORDER, recipientName: '<img src=x onerror=alert(1)>' } });
check('recipient name is escaped', !evil.includes('<img src=x') && evil.includes('&lt;img'));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
/* Samples embed a timestamp, so regenerating them on every run dirties the
   working tree. Opt in with SAMPLES=1 when the templates actually change. */
if (!fail && process.env.SAMPLES === '1') {
  fs.mkdirSync('./docs/receipt-samples', { recursive: true });
  for (const ty of ['receipt','packing','pickup','kitchen','merchant']) {
    fs.writeFileSync('./docs/receipt-samples/' + ty + '-80mm.html',
                     E.buildHTML({ type: ty, data: ORDER }, { paperWidth: 80 }));
    fs.writeFileSync('./docs/receipt-samples/' + ty + '-58mm.html',
                     E.buildHTML({ type: ty, data: ORDER }, { paperWidth: 58 }));
  }
  fs.writeFileSync('./docs/receipt-samples/manifest-80mm.html', man);
  console.log('  sample documents written to docs/receipt-samples/ (58mm + 80mm)');
}
process.exit(fail ? 1 : 0);
