#!/usr/bin/env node
'use strict';
/* Rental settlement (functions/rental-settlement.js): ONE release of a held rental at completion. In-memory txn store;
   the commission engine and config are stubbed so the rate comes from a controlled single source. */
const path = require('path');
const FN = path.join(__dirname, '..', 'functions');
const stub = (file, exp) => { const p = path.join(FN, file); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
let CATS = ['construction_equipment_rental'], RATE = 10, ENGINE_THROWS = false;
stub('commission-config.js', { listCategories: () => CATS });
stub('finos-utils.js', { calculateCommission: async (_db, o) => { if (ENGINE_THROWS) throw new Error('UNPRICED'); return { commissionCents: Math.round(o.orderAmountCents * RATE / 100), effectiveRate: RATE, pricingSource: 'category_default', ruleId: 'default', category: o.category }; } });
const RS = require(path.join(FN, 'rental-settlement.js'));
/* THE REAL business-wallet.js from the canonical line (release/merchant-launch-rc), extracted — planMove is not re-implemented here */
const { execSync } = require('child_process'); const os = require('os'); const fs = require('fs');
const BW_SRC = execSync('git show release/merchant-launch-rc:functions/business-wallet.js', { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
const BW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-bw-')); const BW_FILE = path.join(BW_DIR, 'business-wallet.js'); fs.writeFileSync(BW_FILE, BW_SRC);
const Module = require('module'); const _load = Module._load;
Module._load = function (r, p, m) { if (r === 'firebase-admin') return { firestore: Object.assign(() => ({}), { FieldValue: {} }), apps: [1], initializeApp() {} }; return _load.call(this, r, p, m); };
const BW = require(BW_FILE); Module._load = _load;
let DEST = { ok: true, businessId: 'BIZ-shop1', ownerUid: 'owner1', storeId: 'store1' };
const SD = { resolveSettlementDestination: async (_db, o) => (o.sellerUid === 'owner1' && o.paymentVerified === true ? DEST : { ok: false, reason: 'business_unlinked' }) };
let DEPS = { BW, SD };
let pass = 0, fail = 0;
const ck = (id, ok, msg, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + msg + (ok ? '' : '  got=' + JSON.stringify(got))); ok ? pass++ : fail++; };

let D = {};
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const put = (k, d, merge) => { const out = Object.assign({}, merge && D[k] ? D[k] : {}); for (const [f, v] of Object.entries(d)) out[f] = v && v.__inc ? (Number(out[f]) || 0) + v.__inc : (v && v.__ts ? 'TS' : v); D[k] = out; };
const ref = (c, id) => ({ _k: c + '/' + id, get: async () => ({ exists: (c + '/' + id) in D, data: () => clone(D[c + '/' + id]) }) });
const db = { collection: (c) => ({ doc: (id) => ref(c, id) }),
  runTransaction: async (fn) => { const w = []; let wrote = false; const T = {
      get: async (x) => { if (wrote) throw new Error('reads after writes'); return x.get(); },
      update: (x, d) => { wrote = true; w.push(() => { if (!(x._k in D)) throw new Error('update missing ' + x._k); put(x._k, d, true); }); },
      set: (x, d, o) => { wrote = true; w.push(() => put(x._k, d, o && o.merge)); },
      create: (x, d) => { wrote = true; w.push(() => { if (x._k in D) throw new Error('ALREADY_EXISTS ' + x._k); put(x._k, d, false); }); } };
    const r = await fn(T); w.forEach((f) => f()); return r; } };
const FieldValue = { serverTimestamp: () => ({ __ts: true }), increment: (n) => ({ __inc: n }) };
const seed = (bk, intentX) => { D = {
  'paymentIntents/RENT-b1': Object.assign({ resourceType: 'rentalBooking', resourceId: 'b1', amountCents: 650000, paymentRef: 'API1',
    metadata: { commissionBaseCents: 450000, depositCents: 200000, commissionCategory: 'construction_equipment_rental', sellerUid: 'owner1' } }, intentX || {}),
  'rentalBookings/b1': Object.assign({ buyerId: 'renter1', shopId: 's1', status: 'returned', paymentStatus: 'held', heldAmountCents: 650000, intentRef: 'RENT-b1', paymentRef: 'API1', returnPinVerified: true }, bk || {}) }; };
/* the caller (f3 rentalComplete): quote outside, then ONE txn: re-read booking, settle (reads), write status, apply */
const complete = async (o) => {
  const pre = clone(D['rentalBookings/b1']);
  const quote = await RS.quoteRentalSettlement(db, { booking: pre, deps: DEPS });
  return db.runTransaction(async (t) => {
    const s = await t.get(ref('rentalBookings', 'b1')); const b = s.data();
    const plan = await RS.settleRentalBooking(t, db, Object.assign({ bookingId: 'b1', booking: b, ownerUid: 'owner1', actorUid: 'staff1', quote, FieldValue }, o || {}));
    t.update(ref('rentalBookings', 'b1'), { status: 'completed' });
    plan.apply(t);
    return plan;
  });
};
const W = () => (D['businessWallets/BIZ-shop1'] || {}).balanceMinor;
const PERSONAL = () => Object.keys(D).some((k) => k.startsWith('wallets/') || k.startsWith('walletTransactions/'));

(async () => {
  seed(); let r = await complete();
  const B = D['rentalBookings/b1'];
  ck('S-1', r.ok && B.paymentStatus === 'released' && B.status === 'completed' && W() === 405000 && D['businessWalletEntries/' + BW.entryDocId('BIZ-shop1', 'rentalsettle_b1')].amountMinor === 405000 && D['businessWalletEntries/' + BW.entryDocId('BIZ-shop1', 'rentalsettle_b1')].kind === 'rental_settlement'
    && B.settlement.commissionCents === 45000 && D['rentalDepositRefunds/b1'].state === 'REQUESTED' && D['rentalDepositRefunds/b1'].amountCents === 200000 && D['rentalDepositRefunds/b1'].renterUid === 'renter1',
    'KES 4,500 rent + 2,000 deposit: the SHOP BUSINESS wallet +405,000 cents (rent − 10%), commission 450, deposit = a B2C refund REQUEST to the renter', [W(), B.settlement, D['rentalDepositRefunds/b1']]);
  ck('S-2', !Object.keys(D).some((k) => /^wallets\/renter1|^refundRequests\//.test(k)), 'the deposit never credits any wallet and never touches refundRequests', Object.keys(D));
  r = await complete();
  ck('S-3', !r.ok && (r.reason === 'not_held' || r.reason === 'already_settled') && W() === 405000, 'a second completion pays NOTHING more', [r.reason, W()]);
  seed({ paymentStatus: 'held' }); D['businessWalletEntries/' + BW.entryDocId('BIZ-shop1', 'rentalsettle_b1')] = { amountMinor: 1 }; try { r = await complete(); } catch (e) { r = { ok: false, reason: 'THREW ' + e.message }; }
  ck('S-4', !r.ok && r.reason === 'already_settled' && (W() === undefined && !PERSONAL()), 'an existing settlement record (crash/retry) → no second credit', r.reason);

  seed({ returnPinVerified: false }); r = await complete();
  ck('S-5', !r.ok && r.reason === 'pin_not_verified' && (W() === undefined && !PERSONAL()) && D['commissionReviewQueue/rental_settle_b1'] && D['rentalBookings/b1'].paymentStatus === 'held', 'no verified PIN → no money, a review row, still held', r.reason);
  for (const ps of ['unpaid', 'refund_due', 'released', undefined]) { seed({ paymentStatus: ps }); r = await complete();
    ck('S-6 ' + ps, !r.ok && r.reason === 'not_held' && (W() === undefined && !PERSONAL()) && !D['rentalDepositRefunds/b1'], 'paymentStatus ' + ps + ' → no money moves', r.reason); }
  seed({ heldAmountCents: 100 }); r = await complete();
  ck('S-7', !r.ok && r.reason === 'held_amount_mismatch' && (W() === undefined && !PERSONAL()), 'held amount ≠ rent + deposit (from the INTENT) → refused', r.reason);
  seed({}, { metadata: { commissionBaseCents: 450000, depositCents: 200000, commissionCategory: 'construction_equipment_rental' }, amountCents: 999 }); r = await complete();
  ck('S-8', !r.ok && r.reason === 'intent_amounts_inconsistent' && (W() === undefined && !PERSONAL()), 'an intent whose parts do not add up → refused', r.reason);
  seed({ price: 1, totalAmount: 1 }); r = await complete();
  ck('S-9', r.ok && W() === 405000, 'booking price/total fields are IGNORED — commission comes from the intent (server) only', W());
  CATS = []; seed(); r = await complete(); CATS = ['construction_equipment_rental'];
  ck('S-10', !r.ok && r.reason === 'commission_unpriced' && (W() === undefined && !PERSONAL()), 'a category with no explicit commission row is REFUSED (never the silent 5% default)', r.reason);
  ENGINE_THROWS = true; seed(); r = await complete(); ENGINE_THROWS = false;
  ck('S-11', !r.ok && r.reason === 'commission_refused' && (W() === undefined && !PERSONAL()), 'the engine refusing to price (UNPRICED) → no money', r.reason);
  seed({ intentRef: undefined }); r = await complete();
  ck('S-12', !r.ok && r.reason === 'no_intent_ref' && (W() === undefined && !PERSONAL()), 'no server intent → no money', r.reason);
  seed({}, { metadata: { commissionBaseCents: 450000, depositCents: 0, commissionCategory: 'construction_equipment_rental', sellerUid: 'owner1' }, amountCents: 450000 }); D['rentalBookings/b1'].heldAmountCents = 450000; r = await complete();
  ck('S-13', r.ok && W() === 405000 && !D['rentalDepositRefunds/b1'], 'no deposit → no refund request', W());
  seed(); r = await complete({ ownerUid: '' });
  ck('S-14', !r.ok && r.reason === 'no_owner' && (W() === undefined && !PERSONAL()), 'no resolvable owner → no money', r.reason);
  RATE = 15; seed(); r = await complete(); RATE = 10;
  ck('S-15', r.ok && W() === 382500, 'the rate is the ENGINE\'s (single source), not hard-coded: 15% → 3,825', W());
  /* BUSINESS WALLET + CENTS (f3 review 2026-10-03) */
  seed(); await complete();
  ck('B-1', !PERSONAL(), 'the owner\'s PERSONAL wallet is never credited (personal and business never mix)', Object.keys(D));
  seed({}, { amountCents: 650099, metadata: { commissionBaseCents: 450099, depositCents: 200000, commissionCategory: 'construction_equipment_rental', sellerUid: 'owner1' } });
  D['rentalBookings/b1'].heldAmountCents = 650099; RATE = 10; await complete();
  const E = D['businessWalletEntries/' + BW.entryDocId('BIZ-shop1', 'rentalsettle_b1')] || {}, ST = D['rentalBookings/b1'].settlement || {};
  ck('B-2', W() === 405089 && E.amountMinor === 405089 && ST.commissionCents + E.amountMinor === 450099, 'cents are not dropped: KES 4,500.99 rent → 405,089 cents credited, commission + credit = rent to the cent', [W(), ST.commissionCents, E.amountMinor]);
  DEPS = { BW: null, SD }; seed(); let r2; try { r2 = await complete(); } catch (e) { r2 = { ok: false, reason: 'THREW ' + e.message }; } DEPS = { BW, SD };
  ck('B-3', !r2.ok && r2.reason === 'no_business_wallet' && W() === undefined && !PERSONAL() && D['rentalBookings/b1'].paymentStatus === 'held', 'no business-wallet authority on the tree → refused, still held, NEVER a personal-wallet fallback', r2.reason);
  DEST = { ok: false, reason: 'business_unlinked' }; seed(); r2 = await complete(); DEST = { ok: true, businessId: 'BIZ-shop1', ownerUid: 'owner1', storeId: 'store1' };
  ck('B-4', !r2.ok && r2.reason === 'no_business_wallet' && W() === undefined && !PERSONAL(), 'a shop owner with no linked business → refused (review), no money', r2.reason);
  seed(); r2 = await complete({ ownerUid: 'intruder' });
  ck('B-5', !r2.ok && r2.reason === 'owner_mismatch' && W() === undefined, 'the caller\'s shop owner must own the business credited', r2.reason);
  seed(); D['businessWallets/BIZ-shop1'] = { businessId: 'BIZ-shop1', balanceMinor: 1000, recoveryDebtMinor: 50000 }; await complete();
  ck('B-6', D['businessWallets/BIZ-shop1'].recoveryDebtMinor === 0 && W() === 1000 + 405000 - 50000, 'an outstanding reversal debt is paid down FIRST (the order-settlement recovery policy, via planMove)', D['businessWallets/BIZ-shop1']);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
