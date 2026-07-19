/* Privacy gate for role-based fulfilment scanning.

   These assertions are the authorisation boundary for paperless fulfilment. A
   leak here means a rider keeps a customer's home address after the job ends, or
   a customer reads the merchant's margin. They are hard failures. */
'use strict';
const V = require('../functions/fulfilment-scan')._h;

let pass = 0, fail = 0;
const check = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const json = (o) => JSON.stringify(o);

/* An order carrying every category of sensitive field at once, so the
   separation is genuinely exercised rather than trivially satisfied. */
const ORDER = {
  id: 'SKN-88421', orderNo: 'SKN-88421', status: 'paid', deliveryStatus: 'in_transit',
  uid: 'BUYER1', sellerUid: 'SELLER1', assignedDriverUid: 'RIDER1',
  recipientName: 'Ann Momanyi', recipientPhone: '0705726803', altPhone: '0733444555',
  address: { county:'Nairobi', town:'Westlands', area:'Parklands', street:'3rd Ave',
             building:'Zamani Court', house:'B4', floor:'2', landmark:'Opp. Shell' },
  deliveryNotes: 'Gate code 4417',
  items: [{ name:'Duvet Wash', qty:1, sku:'DW-K', costPrice: 400 }],
  total: 2336, cod: true, paymentMethod: 'M-PESA', receiptNo: 'RQ7M3X9',
  deliveryOtpRequired: true, deliveryOtp: '4417',
  /* merchant internals — must never reach rider or customer */
  commission: 116.80, settlementAmount: 2184.16, sellerNet: 2184.16, margin: 900,
};
const DELIVERY = { status: 'in_transit', riderName: 'Isaac K.', riderPhone: '0700111222', dropoffGeo: { lat: -1.26, lng: 36.8 } };

console.log('\n── Role resolution ──');
check('admin claim wins',        V.resolveRole(ORDER, DELIVERY, 'NOBODY', { admin: true }) === 'admin');
check('seller by sellerUid',     V.resolveRole(ORDER, DELIVERY, 'SELLER1', {}) === 'seller');
check('rider by assignedDriverUid', V.resolveRole(ORDER, DELIVERY, 'RIDER1', {}) === 'rider');
check('buyer by uid',            V.resolveRole(ORDER, DELIVERY, 'BUYER1', {}) === 'customer');
check('unrelated party -> null (refused)', V.resolveRole(ORDER, DELIVERY, 'STRANGER', {}) === null);

console.log('\n── RIDER: address only while the assignment is active ──');
const riderActive   = V.riderView(ORDER, DELIVERY, true);
const riderInactive = V.riderView(ORDER, DELIVERY, false);
check('active rider sees address',  json(riderActive).includes('Zamani Court'));
check('active rider sees phone',    json(riderActive).includes('0705726803'));
check('active rider sees COD',      riderActive.codAmount === 2336);
check('INACTIVE rider gets NO address', !json(riderInactive).includes('Zamani Court'));
check('INACTIVE rider gets NO phone',   !json(riderInactive).includes('0705726803'));
check('INACTIVE rider gets NO landmark',!json(riderInactive).includes('Opp. Shell'));
check('inactive rider told why',    /not currently assigned/i.test(riderInactive.message || ''));

console.log('\n── RIDER: never receives the delivery OTP ──');
check('OTP value withheld from rider', !json(riderActive).includes('4417') || !('deliveryOtp' in riderActive),
      'rider must not self-confirm');
check('rider told OTP is required',    riderActive.otpRequired === true);

console.log('\n── RIDER: no merchant internals ──');
for (const [l, n] of [['commission','116.8'],['settlement','2184.16'],['margin','900']]) {
  check('rider view omits ' + l, !json(riderActive).includes(n), n);
}

console.log('\n── CUSTOMER: own order, never merchant internals ──');
const cust = V.customerView(ORDER, DELIVERY);
for (const [l, n] of [['commission','116.8'],['settlement','2184.16'],['sellerNet','2184.16'],['cost price','400']]) {
  check('customer view omits ' + l, !json(cust).includes(n), n);
}
check('customer sees own total',     cust.total === 2336);
check('customer sees order status',  !!cust.status);
check('customer gets receipt url',   /payment-receipt\.html\?ref=RQ7M3X9/.test(cust.receiptUrl || ''));
check('customer sees rider name once assigned', cust.rider && cust.rider.name === 'Isaac K.');
check('customer does NOT get rider live location', !json(cust).includes('dropoffGeo'));

console.log('\n── SELLER: fulfilment data, not settlement ──');
const sell = V.sellerView(ORDER, DELIVERY);
check('seller sees recipient name',  sell.recipientName === 'Ann Momanyi');
check('seller sees items to pack',   (sell.items || []).length === 1);
check('seller view omits settlement',!json(sell).includes('2184.16'));
check('seller view omits commission',!json(sell).includes('116.8'));
check('seller view omits item cost price', !json(sell).includes('400'));

console.log('\n── Projections are allowlists, not the raw order ──');
const ORDER2 = Object.assign({}, ORDER, { secretInternalField: 'LEAK-ME-9999' });
check('new order field does NOT leak to rider',    !json(V.riderView(ORDER2, DELIVERY, true)).includes('LEAK-ME-9999'));
check('new order field does NOT leak to customer', !json(V.customerView(ORDER2, DELIVERY)).includes('LEAK-ME-9999'));
check('new order field does NOT leak to seller',   !json(V.sellerView(ORDER2, DELIVERY)).includes('LEAK-ME-9999'));

console.log('\n── Active-state vocabulary (canonical lifecycle) ──');
const L = require('../functions/fulfilment-lifecycle');

/* REGRESSION. The active window was a hand-written Set of 'assigned'/'accepted'.
   dispatch.js writes 'driver_assigned'/'driver_accepted' and firestore.rules:99
   uses 'rider_assigned' -- none matched, so a rider on a genuinely active
   delivery was refused the customer's address. Every spelling any writer in the
   codebase actually produces must resolve to active. */
for (const v of ['driver_assigned', 'driver_accepted', 'rider_assigned', 'assigned',
                 'picked_up', 'picking_up', 'in_transit', 'rider_en_route',
                 'out_for_delivery', 'shipped', 'arriving']) {
  check('ACTIVE: ' + v, L.isRiderActive(v) === true, L.normalize(v));
}
for (const v of ['delivered', 'completed', 'returned', 'refunded', 'cancelled',
                 'failed', 'exhausted', 'suspended', 'pending', 'ready_for_pickup', 'offered']) {
  check('not active: ' + v, L.isRiderActive(v) === false, L.normalize(v));
}

console.log('\n── Lifecycle normalisation fails closed ──');
check('unrecognised value -> unknown', L.normalize('teleported') === L.UNKNOWN);
check('unknown is NOT rider-active',  L.isRiderActive('teleported') === false);
check('unknown is NOT terminal',      L.isTerminal('teleported') === false);
check('empty/null -> unknown',        L.normalize(null) === L.UNKNOWN && L.normalize('') === L.UNKNOWN);
check('case + spacing tolerated',     L.normalize('  In-Transit ') === 'in_transit');

console.log('\n── Stage progression guards ──');
check('forward advance allowed',      L.canAdvance('packing', 'in_transit') === true);
check('backward advance refused',     L.canAdvance('in_transit', 'packing') === false);
check('same stage idempotent',        L.canAdvance('packing', 'packing') === true);
check('return can interrupt transit', L.canAdvance('in_transit', 'returned') === true);
check('completed is terminal',        L.isTerminal('completed') === true);
check('cannot leave a terminal state',L.canAdvance('completed', 'returned') === false);
check('every canonical stage is self-aliasing',
      L.CANONICAL.every(s => L.normalize(s) === s));
check('every canonical stage has a label',
      L.CANONICAL.every(s => !!L.LABELS[s]));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
