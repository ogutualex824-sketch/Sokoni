#!/usr/bin/env node
'use strict';
/* ============================================================================
   SmartPOS server payment gate — owner P0 2026-10-03 (sokoni-pos). Runs WITHOUT the emulator:
     part 1 EXECUTES the certified module shared/pos-payment-ownership.js assertConfirmableStk
     part 2 checks posCompleteCheckout's wiring statically (closed tender list, STK = mpesa only,
            provider-confirmed amount must cover the sale, spent-once claim)
   The END-TO-END proof is scripts/test-pos-till-convergence-server.js (POS-01..POS-15) against the
   Firestore emulator — UNPROVEN until it runs (512 MB memory gate).
   node scripts/test-pos-payment-gate-unit.js
   ============================================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const own = require(path.join(ROOT, 'functions', 'shared', 'pos-payment-ownership.js'));
const src = fs.readFileSync(path.join(ROOT, 'functions', 'pos-zero-friction.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (id, l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + id + ' ' + l); } else { fail++; console.log('  FAIL  ' + id + ' ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };
const intent = (o) => Object.assign({ provider: 'intasend', currency: 'KES', merchantId: 'SHOP_A', idempotencyKey: 'SALE_1', amountCents: 10000 }, o || {});
const status = (o) => Object.assign({ status: 'completed', confirmedAmountKES: 100 }, o || {});
const A = { merchantId: 'SHOP_A', idempotencyKey: 'SALE_1' };

console.log('SmartPOS server payment gate — unit + wiring\n');
const r1 = own.assertConfirmableStk(intent(), status(), A);
ck('POS-01', 'confirmed, same shop, same sale, KES → ok with the PROVIDER amount (100)', r1.ok && r1.amount === 100, r1);
ck('POS-02', 'no intent on record → refused (no_document)', own.assertConfirmableStk(null, status(), A).reason === 'no_document');
ck('POS-03', 'pending → refused (not_paid)', own.assertConfirmableStk(intent(), status({ status: 'pending' }), A).reason === 'not_paid');
ck('POS-03b', 'no status record (provider never confirmed) → refused', own.assertConfirmableStk(intent(), null, A).reason === 'not_paid');
ck('POS-04', 'failed → refused (not_paid)', own.assertConfirmableStk(intent(), status({ status: 'failed' }), A).reason === 'not_paid');
const r5 = own.assertConfirmableStk(intent(), status({ confirmedAmountKES: 10 }), A);
ck('POS-05', 'PARTIAL: provider confirmed 10 of a 100 request → amount 10 (the caller then refuses: 10 < 100)', r5.ok && r5.amount === 10, r5);
const r5b = own.assertConfirmableStk(intent(), status({ confirmedAmountKES: null }), A);
ck('POS-05b', 'provider reported no amount → amount null (caller refuses)', r5b.ok && r5b.amount === null, r5b);
ck('POS-06', 'wrong merchant → refused (wrong_shop)', own.assertConfirmableStk(intent(), status(), { merchantId: 'SHOP_B', idempotencyKey: 'SALE_1' }).reason === 'wrong_shop');
ck('POS-07/14', 'payment requested for another sale → refused (wrong_sale)', own.assertConfirmableStk(intent(), status(), { merchantId: 'SHOP_A', idempotencyKey: 'SALE_2' }).reason === 'wrong_sale');
ck('POS-08', 'non-KES intent → refused (wrong_currency)', own.assertConfirmableStk(intent({ currency: 'USD' }), status(), A).reason === 'wrong_currency');
ck('POS-09', 'not an IntaSend record → refused', own.assertConfirmableStk(intent({ provider: 'daraja' }), status(), A).reason === 'unknown_shape');
ck('POS-10', 'SIMULATED_* is not an IntaSend prompt reference', own.isStkRef('SIMULATED_1791000000000') === false && own.isStkRef('postill_x') === true);

const fn = src.slice(src.indexOf('exports.posCompleteCheckout'), src.indexOf('exports.posCompleteCheckout') + 60000);
ck('POS-15a', 'closed tender list {cash, mpesa, card, wallet}; anything else refused before money is counted',
  /const SERVER_TENDERS = \{ cash: 1, mpesa: 1, card: 1, wallet: 1 \};/.test(fn) && /if \(!SERVER_TENDERS\[m\]\) _e\(/.test(fn) && fn.indexOf('SERVER_TENDERS[m]') < fn.indexOf('const tendered ='));
ck('POS-15b', 'an M-PESA prompt reference can only settle an M-PESA line', /if \(_stk && method !== 'mpesa'\) _e\(/.test(fn));
ck('POS-11', 'a confirmable line with no reference is refused', /if \(!ref\) \{\s*_e\(/.test(fn));
ck('POS-05c', 'the confirmed (provider) amount must cover the line; an unreadable amount is refused', /const confirmedAmount = Number\(_confirm\.amount\);/.test(fn) && /!isFinite\(confirmedAmount\) \|\| confirmedAmount \+ 1 < Number\(p\.amount \|\| 0\)/.test(fn));
ck('POS-12', 'spent once: posPaymentClaims/{ref} create(); another sale with the same payment refused', /collection\('posPaymentClaims'\)\.doc\(ref\)/.test(fn) && /await claimRef\.create\(/.test(fn) && /prior\.idempotencyKey !== idempotencyKey/.test(fn));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
