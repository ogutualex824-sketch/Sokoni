#!/usr/bin/env node
'use strict';
/* Rental deposit refund executor (functions/rental-deposit-refunds.js). In-memory txn store; the IntaSend adapter is a scripted
   double, the CONTRACT (REFUND_OUTCOME) is the real repaired module's (1af3029), and the pre-repair adapter is this tree's own. */
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'); const FN = path.join(ROOT, 'functions');
const RD = require(path.join(FN, 'rental-deposit-refunds.js'));
let pass = 0, fail = 0;
const ck = (id, ok, msg, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + msg + (ok ? '' : '  got=' + JSON.stringify(got))); ok ? pass++ : fail++; };

/* the REAL repaired contract, extracted from 1af3029 (not re-typed) */
const Module = require('module'); const _load = Module._load;
Module._load = function (r, p, m) { if (r === 'firebase-admin' || r === 'firebase-functions' || r.startsWith('firebase-functions/')) return new Proxy(function () {}, { get: () => () => ({}) , apply: () => ({}) }); return _load.call(this, r, p, m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdr-')); const REPAIRED = path.join(tmp, 'payment-adapters.js');
fs.writeFileSync(REPAIRED, execSync('git show 1af3029:functions/payment-adapters.js', { cwd: ROOT, encoding: 'utf8' }));
const PA = require(REPAIRED); const OLD = require(path.join(FN, 'payment-adapters.js'));
Module._load = _load;
const CONTRACT = PA.REFUND_OUTCOME;

let D = {};
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const put = (k, d, merge) => { const out = Object.assign({}, merge && D[k] ? D[k] : {}); for (const [f, v] of Object.entries(d)) out[f] = v && v.__ts ? 'TS' : v; D[k] = out; };
const ref = (c, id) => ({ _k: c + '/' + id, get: async () => ({ exists: (c + '/' + id) in D, data: () => clone(D[c + '/' + id]) }),
  update: async (d) => { if (!((c + '/' + id) in D)) throw new Error('missing'); put(c + '/' + id, d, true); }, set: async (d, o) => put(c + '/' + id, d, o && o.merge) });
const db = { collection: (c) => ({ doc: (id) => ref(c, id) }),
  runTransaction: async (fn) => { const w = []; const r = await fn({ get: (x) => x.get(), update: (x, d) => w.push(() => put(x._k, d, true)) }); w.forEach((f) => f()); return r; } };
const FieldValue = { serverTimestamp: () => ({ __ts: true }) };
let SENT = [], NEXT = { outcome: 'PROVIDER_ACCEPTED', chargebackId: 'CB1', providerStatus: 'PENDING' }, STATUS = { outcome: 'PROVIDER_COMPLETED', providerStatus: 'COMPLETED' };
const adapter = { initiateRefund: async (o) => { SENT.push(o); if (NEXT === 'THROW_PRE') throw new Error('REFUND_INVOICE_REQUIRED'); return Object.assign({}, NEXT); },
  getRefundStatus: async () => Object.assign({}, STATUS) };
const deps = (o) => Object.assign({ adapter, contract: CONTRACT, minCents: RD.OWNER_B2C_MIN_CENTS, FieldValue }, o || {});
const seed = (req, bk) => { SENT = []; D = {
  'rentalBookings/b1': Object.assign({ paymentStatus: 'released', heldAmountCents: 650000, invoiceId: 'INV-9', settlement: { depositCents: 200000, depositRefund: 'requested' } }, bk || {}),
  'rentalDepositRefunds/b1': Object.assign({ bookingId: 'b1', state: 'REQUESTED', amountCents: 200000, invoiceId: 'INV-9', renterUid: 'renter1' }, req || {}) }; };
const R = () => D['rentalDepositRefunds/b1'] || {};
const reviewed = (reason) => !!D['commissionReviewQueue/rental_deposit_' + reason + '_b1'];

(async () => {
  seed(); NEXT = { outcome: CONTRACT.ACCEPTED, chargebackId: 'CB1', providerStatus: 'PENDING' }; let r = await RD.executeDepositRefund(db, 'b1', deps());
  ck('X-1', r.outcome === 'PROVIDER_ACCEPTED' && R().state === 'PROVIDER_ACCEPTED' && R().chargebackId === 'CB1' && SENT.length === 1 && SENT[0].invoiceId === 'INV-9' && SENT[0].amountCents === 200000,
    'a valid request is sent ONCE against the original invoice_id for exactly the deposit; 201 = ACCEPTED, not returned', [r, R(), SENT]);
  r = await RD.executeDepositRefund(db, 'b1', deps());
  ck('X-2', r.outcome === 'not_requested' && SENT.length === 1, 'a second run NEVER re-sends (only REQUESTED is claimable)', [r, SENT.length]);
  r = await RD.reconcileDepositRefund(db, 'b1', deps());
  ck('X-3', r.outcome === 'COMPLETED' && R().state === 'COMPLETED' && D['rentalBookings/b1'].settlement.depositRefund === 'returned' && SENT.length === 1,
    'COMPLETED comes ONLY from the provider status read; the booking then says the deposit was returned', [r, R()]);

  seed(); NEXT = { outcome: CONTRACT.UNKNOWN, chargebackId: null, error: 'timeout' }; r = await RD.executeDepositRefund(db, 'b1', deps());
  ck('X-4', R().state === 'OUTCOME_UNKNOWN' && reviewed('outcome_unknown') && SENT.length === 1, 'no answer → OUTCOME_UNKNOWN + review; never re-sent', [r, R()]);
  r = await RD.executeDepositRefund(db, 'b1', deps()); const r2 = await RD.reconcileDepositRefund(db, 'b1', deps());
  ck('X-5', SENT.length === 1 && r2.outcome === 'needs_person', 'UNKNOWN with no chargebackId: not re-sent, not "reconciled" by guessing — a person decides', [SENT.length, r2]);
  seed(); NEXT = { outcome: CONTRACT.REJECTED, chargebackId: null, error: 'HTTP 400' }; r = await RD.executeDepositRefund(db, 'b1', deps());
  ck('X-6', R().state === 'REJECTED' && reviewed('rejected') && SENT.length === 1, 'a provider rejection → REJECTED + review, no automatic retry', R());

  const holds = [
    ['X-7', { invoiceId: 'EKOQ6P0' }, { invoiceId: 'EKOQ6P0' }, 'blocked_open_case', 'the open field case EKOQ6P0 is NEVER re-POSTed'],
    ['X-8', {}, {}, 'b2c_minimum_not_configured', 'no configured B2C minimum → nothing sent (no guessed number)', { minCents: null }],
    ['X-9', { amountCents: 100 }, { settlement: { depositCents: 100, depositRefund: 'requested' } }, 'below_b2c_minimum', 'below the configured minimum → held (a failed B2C strands the chargeback)'],
    ['X-10', { invoiceId: null }, {}, 'invoice_missing_or_mismatch', 'no invoice_id → never raised against api_ref or a guess'],
    ['X-11', { invoiceId: 'INV-OTHER' }, {}, 'invoice_missing_or_mismatch', 'an invoice that is not the booking\'s payment → held'],
    ['X-12', { amountCents: 300000 }, {}, 'booking_not_settled_for_this_amount', 'a request for more than the settled deposit → held'],
    ['X-13', {}, { paymentStatus: 'held', settlement: null }, 'booking_not_settled_for_this_amount', 'a booking that was not settled → held'],
    ['X-14', {}, {}, 'refund_adapter_unproven', 'the PRE-REPAIR adapter (wrong endpoint, rounded amounts) is refused', { adapter: new OLD.IntaSendAdapter({ privateKey: 'test-only-not-a-secret', publishableKey: 'test' }), contract: OLD.REFUND_OUTCOME || null }],
    ['X-15', {}, {}, 'refund_adapter_unproven', 'an adapter without the repaired contract is refused', { contract: null }],
  ];
  for (const [id, rq, bk, reason, msg, dx] of holds) {
    seed(rq, bk); r = await RD.executeDepositRefund(db, 'b1', deps(dx || {}));
    ck(id, r.outcome === 'held' && r.reason === reason && R().state === 'HELD_FOR_REVIEW' && SENT.length === 0 && reviewed(reason), msg, [r, R().state, SENT.length]);
  }
  seed(); NEXT = 'THROW_PRE'; r = await RD.executeDepositRefund(db, 'b1', deps());
  ck('X-16', R().state === 'HELD_FOR_REVIEW' && R().heldReason === 'adapter_refused' && reviewed('adapter_refused'), 'an adapter refusal before sending → held for review (no SENDING state left dangling)', R());
  seed({ state: 'SENDING' }); NEXT = { outcome: CONTRACT.ACCEPTED, chargebackId: 'CB1' }; r = await RD.executeDepositRefund(db, 'b1', deps());
  ck('X-17', r.outcome === 'not_requested' && SENT.length === 0, 'a request already being sent (SENDING) is never sent again', r);
  seed({ state: 'PROVIDER_ACCEPTED', chargebackId: 'CB1' }); STATUS = { outcome: CONTRACT.UNKNOWN }; r = await RD.reconcileDepositRefund(db, 'b1', deps());
  ck('X-18', r.outcome === 'unchanged' && R().state === 'PROVIDER_ACCEPTED' && SENT.length === 0, 'a status read with no answer changes nothing (never downgrades, never re-sends)', r);
  ck('X-20', RD.OWNER_B2C_MIN_CENTS === 10000, 'the owner floor is KES 100 (10,000 cents)', RD.OWNER_B2C_MIN_CENTS);
  seed({ amountCents: 9999 }, { settlement: { depositCents: 9999, depositRefund: 'requested' } }); r = await RD.executeDepositRefund(db, 'b1', deps());
  ck('X-21', r.reason === 'below_b2c_minimum' && SENT.length === 0, 'KES 99.99 is below the owner floor → held, never sent', r);
  ck('X-19', !/refundRequests|collection\('wallets'\)|businessWallets/.test(fs.readFileSync(path.join(FN, 'rental-deposit-refunds.js'), 'utf8')), 'the executor never touches refundRequests or any wallet', null);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
