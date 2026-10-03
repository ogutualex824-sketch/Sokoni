#!/usr/bin/env node
'use strict';
/* SETTLEMENT AUTHORITY — owner 2026-10-03 deliberate breaks, executed through the REAL provider-ops settlement
     SA1 AMOUNT MANIPULATION: provider re-priced to 12,000 after KES 10,000 was held → base 10,000 (heldAmount), never price
     SA2 COMMISSION MANIPULATION: booking captured 10%; today's lane for its hub is 5% → settlement still 10% (snapshot)
     SA3 held amount unknown → settlement REFUSED (HELD_AMOUNT_UNKNOWN); money stays held, wallet untouched
     SA4 legacy booking (no snapshot) → priced once through the engine and RECORDED as legacy_recomputed_no_snapshot
     SA5 legacy hold without heldAmount → base from the VERIFIED payment (payments/{ref} COMPLETE), never price
     SA6 UNDERPAID: 8,000 held on a 10,000 booking → base 8,000 (the webhook gap can't settle in full)
     SA7 refunds move the HELD amount (provider cancel → refund heldAmount, not price + fee)
     SA8 capture: commissionSnapshotFor → marketing 10%, services 5%; unpriced milestone refused before anything is held
     SA9 replay: a second PIN release moves nothing (wallet credited once)
     SA10 pure engine: pass-through fee never commissioned; pass-through > held refused; rate bounds enforced
   NODE_PATH=<functions/node_modules> node scripts/test-settlement-authority.js */
const path = require('path');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { DOCS } = H;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const PO = require(path.join(FN, 'provider-ops.js'));
const PH = require(path.join(FN, 'provider-hub.js'));
const SA = require(path.join(FN, 'shared/settlement-authority.js'));
const SNAP10 = { commissionRate: 10, commissionRuleId: 'marketing_services@2026-10-03.marketing', commissionBase: 'service_price', category: 'marketing_services', policyVersion: '2026-10-03.marketing' };
const bk = (over) => Object.assign({ providerId: 'mk', customerUid: 'cust', service: 'Brand strategy', status: 'confirmed', paymentStatus: 'paid_held', paymentRef: 'API_1',
  price: 1000000, fee: 0, deposit: 0, heldAmount: 1000000, commissionHub: 'provider', commissionSnapshot: SNAP10 }, over || {});
const W = (u) => (DOCS.get('wallets/' + u) || {}).balance || 0;
const P = (id) => DOCS.get('providerPayouts/' + id) || {};
const B = (id) => DOCS.get('providerBookings/' + id) || {};
const run = async (fn) => { try { return { ok: true, r: await fn() }; } catch (e) { return { ok: false, code: e.code, det: e.details, msg: e.message }; } };

(async () => {
  H.reset();
  ['mk', 'cust'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));

  DOCS.set('providerBookings/b1', bk({ price: 1200000 }));      /* provider re-priced AFTER the hold */
  await PO.settleOnPinRelease('b1', 'cust');
  ck('SA1', P('b1').gross === 1000000 && P('b1').commission === 100000 && W('mk') === 9000 && B('b1').paymentStatus === 'settled',
    'AMOUNT MANIPULATION: price edited to 12,000 after 10,000 held → base 10,000, commission 1,000, wallet +9,000', { p: P('b1'), w: W('mk') });

  ck('SA2', P('b1').commissionPct === 10 && P('b1').pricingSource === 'booking_snapshot' && PH.commissionArgsForBooking(B('b1')).category === 'services',
    'COMMISSION MANIPULATION: today\'s lane for this hub is services 5%, the captured snapshot 10% is what settled', P('b1'));

  DOCS.set('providerBookings/b3', bk({ heldAmount: undefined, paymentRef: 'API_NONE' }));
  const w0 = W('mk');
  const r3 = await run(() => PO.settleOnPinRelease('b3', 'cust'));
  ck('SA3', !r3.ok && r3.det && r3.det.code === 'HELD_AMOUNT_UNKNOWN' && B('b3').paymentStatus === 'paid_held' && W('mk') === w0 && !DOCS.get('providerPayouts/b3'),
    'held amount unknown → REFUSED, money stays held, wallet untouched', r3);

  DOCS.set('providerBookings/b4', bk({ commissionSnapshot: undefined }));
  await PO.settleOnPinRelease('b4', 'cust');
  ck('SA4', P('b4').commission === 50000 && P('b4').commissionPct === 5,
    'legacy booking (no snapshot) → priced once via the engine (services 5%) and recorded as such', P('b4'));
  ck('SA4b', (await (async () => { const raw = DOCS.get('providerPayouts/b4'); return raw && raw.pricingSource !== 'booking_snapshot'; })()),
    '…and the record does not claim a snapshot it never had');

  DOCS.set('payments/API_5', { status: 'COMPLETE', amount: 7500 });
  DOCS.set('providerBookings/b5', bk({ heldAmount: undefined, paymentRef: 'API_5' }));
  await PO.settleOnPinRelease('b5', 'cust');
  ck('SA5', P('b5').gross === 750000 && P('b5').commission === 75000, 'legacy hold → base from the VERIFIED payment (7,500), never price (10,000)', P('b5'));

  DOCS.set('providerBookings/b6', bk({ heldAmount: 800000 }));
  await PO.settleOnPinRelease('b6', 'cust');
  ck('SA6', P('b6').gross === 800000 && P('b6').commission === 80000, 'UNDERPAID: 8,000 held on a 10,000 booking → base 8,000', P('b6'));

  DOCS.set('providerBookings/b7', bk({ heldAmount: 900000, price: 1000000, fee: 0 }));
  const r7 = await run(() => PO._disburseHeldFunds(B('b7'), { id: 'b7', path: 'providerBookings/b7' }, { by: 'provider' }));
  ck('SA7', r7.ok && r7.r.refundC === 900000 && r7.r.refundShillings === 9000, 'provider-cancel refund plan moves the HELD 9,000 (not price 10,000)', r7);

  const s1 = await PH.commissionSnapshotFor(H.db || require('firebase-admin').firestore(), 'mk', { serviceHub: 'marketing', serviceCategory: 'brand-strategy', commissionHub: 'provider' }, 1000000);
  const s2 = await PH.commissionSnapshotFor(require('firebase-admin').firestore(), 'p2', { commissionHub: 'provider' }, 1000000);
  const s3 = await run(() => PH.commissionSnapshotFor(require('firebase-admin').firestore(), 'p2', { kind: 'work_milestone', workCommissionCategory: 'nope' }, 1000000));
  ck('SA8', s1.commissionRate === 10 && s1.commissionRuleId && s1.commissionBase === 'service_price' && s2.commissionRate === 5 && !s3.ok && s3.code === 'category_unpriced',
    'capture: marketing 10%, services 5%; an unpriced milestone is refused before anything is held', { s1, s2, s3 });

  const before = W('mk');
  const again = await PO.settleOnPinRelease('b1', 'cust');
  ck('SA9', W('mk') === before && again && again.skipped, 'replay: a second PIN release moves nothing', again);

  const p1 = SA.settle({ heldAmountCents: 1050000, passThroughCents: 50000, commissionSnapshot: SNAP10 });
  const p2 = SA.settle({ heldAmountCents: 1000, passThroughCents: 2000, commissionSnapshot: SNAP10 });
  const p3 = SA.settle({ heldAmountCents: 1000, commissionSnapshot: { commissionRate: 150, commissionRuleId: 'x' } });
  ck('SA10', p1.baseCents === 1000000 && p1.commissionCents === 100000 && p1.settleCents === 950000 && !p2.ok && p2.reason === 'pass_through_exceeds_held' && p3.needsLegacy === true,
    'pure: fee passes through uncommissioned; pass-through > held refused; an out-of-range rate is not a valid snapshot', { p1, p2, p3 });

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
