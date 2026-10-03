'use strict';
/* P0 PAYMENT INTEGRITY — the adversarial matrix (owner 2026-10-03).
   "An order can become paid/verified only if: a verified server payment record exists, bound to THIS order, amount ==
   payable amount, currency matches, payer == the order's buyer, not already consumed, order still payable, and IntaSend
   itself confirms it. Anything missing or mismatched → review / no settlement, never paid."

   LAYER A (this file, always): the REAL gate functions (functions/payment-attribution.js) on every case.
   LAYER B (this file, always): the REAL webhookIntasend handler (functions/index.js) in-process on an in-memory
            Firestore + a stub IntaSend status API — the attack rows end-to-end through the handler.
   LAYER C (owed): scripts/test-b1-online-checkout-chain.js on the Firestore emulator (≥512 MB free).

     node scripts/test-p0-payment-integrity.js            (this tree)
     WH_ROOT=<68811e1 extract> node scripts/test-p0-payment-integrity.js     (the LIVE code — the attack rows must FAIL) */
const path = require('path'), fs = require('fs'), Module = require('module');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
const WH = path.resolve(process.env.WH_ROOT || path.join(__dirname, '..'), 'functions');
let pass = 0, fail = 0, unproven = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id.padEnd(5) + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
const unp = (id, m, why) => { console.log('  UNPROVEN ' + id.padEnd(5) + ' ' + m + '   [' + why + ']'); unproven++; };

console.log('\nP0 payment integrity   WH=' + WH + '\n');
let A = null;
try { A = require(path.join(WH, 'payment-attribution.js')); } catch (e) { A = {}; }

/* ══ LAYER A — the gate decisions ══ */
console.log('LAYER A — gate decisions (assessProductOrderPayment + assessProviderConfirmation)');
const has = typeof A.assessProductOrderPayment === 'function';
const G = (intent, ev) => has ? A.assessProductOrderPayment(intent, Object.assign({ apiRef: 'ORD10K', grossAmount: 10000, currency: 'KES', payerUid: 'buyerA',
  order: { uid: 'buyerA', status: 'pending_payment' }, legacyMeta: { category: 'product', orderId: 'ORD10K', sellerUid: 'S1' } }, ev || {})) : { applies: null, crashed: 'assessProductOrderPayment missing' };
const INT = (o) => Object.assign({ purpose: 'product_order', uid: 'buyerA', amountCents: 1000000, currency: 'KES', status: 'created', resourceId: 'ORD10K', metadata: { orderId: 'ORD10K' } }, o || {});
const refusedAs = (r, reason) => r && r.applies === true && r.ok === false && (!reason || r.reason === reason);
const settles = (r) => r && r.applies === true && r.ok === true;

ck('A-01', settles(G(INT())), 'KES 10,000 order + KES 10,000 payment → passes the gate', G(INT()));
ck('A-02', refusedAs(G(null, { grossAmount: 1 }), 'missing_intent'), 'THE ATTACK: KES 10,000 order + KES 1 payment with NO server record → REVIEW (missing_intent)', G(null, { grossAmount: 1 }));
ck('A-03', refusedAs(G(INT(), { grossAmount: 1 }), 'amount_mismatch'), 'KES 10,000 order + KES 1 payment WITH the order\'s intent → REVIEW (amount_mismatch)', G(INT(), { grossAmount: 1 }));
ck('A-04', refusedAs(G(INT(), { grossAmount: 9999 }), 'amount_mismatch'), 'KES 9,999 against KES 10,000 → REVIEW', G(INT(), { grossAmount: 9999 }));
ck('A-05', refusedAs(G(INT(), { grossAmount: 10001 }), 'amount_mismatch'), 'KES 10,001 against KES 10,000 → REVIEW (over-payment is not silently accepted)', G(INT(), { grossAmount: 10001 }));
ck('A-06', refusedAs(G(INT(), { grossAmount: 9999.99 }), 'amount_mismatch'), 'KES 9,999.99 → REVIEW (cents, no rounding)', G(INT(), { grossAmount: 9999.99 }));
ck('A-07', refusedAs(G(INT({ resourceId: 'ORD-A', metadata: { orderId: 'ORD-A' } }), { apiRef: 'ORD-B' }), 'wrong_order'), 'a payment for order A presented against order B → REVIEW (wrong_order)', G(INT({ resourceId: 'ORD-A', metadata: { orderId: 'ORD-A' } }), { apiRef: 'ORD-B' }));
ck('A-08', refusedAs(G(INT(), { payerUid: 'buyerB' }), 'wrong_buyer'), 'payment started by buyer B against buyer A\'s order/intent → REVIEW (wrong_buyer)', G(INT(), { payerUid: 'buyerB' }));
ck('A-09', refusedAs(G(INT(), { order: { uid: 'buyerB', status: 'pending_payment' } }), 'wrong_buyer'), 'buyer A\'s payment against an order owned by buyer B → REVIEW (wrong_buyer)', G(INT(), { order: { uid: 'buyerB', status: 'pending_payment' } }));
ck('A-10', refusedAs(G(INT(), { order: { buyerId: 'buyerB', status: 'pending_payment' } }), 'wrong_buyer') && refusedAs(G(INT(), { order: { buyerUid: 'buyerB', status: 'pending_payment' } }), 'wrong_buyer'),
  'the order\'s buyer is read from every buyer field (uid / buyerUid / buyerId)');
ck('A-11', refusedAs(G(INT({ uid: '' })), 'intent_owner_missing') && refusedAs(G(INT({ uid: undefined })), 'intent_owner_missing'), 'an intent with no owner is not "anyone" → REVIEW');
ck('A-12', refusedAs(G(INT(), { payerUid: null }), 'wrong_buyer'), 'a payment record with no payer → REVIEW');
ck('A-13', refusedAs(G(INT(), { currency: 'USD' }), 'wrong_currency') && refusedAs(G(INT({ currency: 'USD' })), 'wrong_currency'), 'wrong currency (payment or intent) → REVIEW');
ck('A-13b', refusedAs(G(INT(), { order: { uid: 'buyerA', status: 'pending_payment', currency: 'USD' } }), 'wrong_currency') && settles(G(INT(), { order: { uid: 'buyerA', status: 'pending_payment', currency: 'kes' } })), 'payment.currency == order.currency: an order in another currency → REVIEW (KES in any case passes)');
ck('A-14', refusedAs(G(INT(), { currency: null }), 'missing_evidence'), 'no currency in the callback → REVIEW');
ck('A-15', refusedAs(G(INT(), { grossAmount: undefined }), 'missing_evidence') && refusedAs(G(INT(), { grossAmount: '' }), 'missing_evidence') && refusedAs(G(INT(), { grossAmount: 'abc' }), 'missing_evidence'),
  'no / malformed payment amount → REVIEW — NO fallback to the order or intent amount');
ck('A-16', refusedAs(G(INT({ status: 'paid' })), 'intent_consumed'), 'an already-consumed (paid) intent cannot settle another payment → REVIEW');
ck('A-17', refusedAs(G(INT({ status: 'expired' })), 'intent_terminal') && refusedAs(G(INT({ status: 'cancelled' })), 'intent_terminal'), 'an expired / cancelled intent → REVIEW');
const NP = ['paid', 'cancelled', 'processing', 'shipped', 'delivered', 'completed', 'refunded'];
ck('A-18', NP.every((s) => refusedAs(G(INT(), { order: { uid: 'buyerA', status: s } }), 'order_not_payable')), 'an order that is not awaiting payment (' + NP.join('/') + ') cannot become paid → REVIEW');
ck('A-19', ['pending_payment', 'pending', 'awaiting_payment'].every((s) => settles(G(INT(), { order: { uid: 'buyerA', status: s } }))) && settles(G(INT(), { order: null })),
  'CONTROL: an order awaiting payment (or not yet written) passes the gate');
ck('A-20', refusedAs(G(INT({ amountCents: 0 })), 'intent_amount_invalid') && refusedAs(G(INT({ amountCents: 'x' })), 'intent_amount_invalid'), 'an intent with no valid amount → REVIEW');
ck('A-21', (() => { const r = G(INT(), { legacyMeta: { category: 'product', orderId: 'ORD10K', amount: 1, sellerUid: 'attacker' }, grossAmount: 10000 }); return settles(r) && r.expectedCents === 1000000; })(),
  'a caller-supplied amount / seller in the client meta never changes the expected amount — the SERVER intent wins');

const hasP = typeof A.assessProviderConfirmation === 'function';
const P = (st, w) => hasP ? A.assessProviderConfirmation(st, Object.assign({ apiRef: 'ORD10K', expectedCents: 1000000 }, w || {})) : { ok: null, crashed: 'assessProviderConfirmation missing' };
const OK = { ok: true, found: true, state: 'COMPLETE', value: 10000, currency: 'KES', api_ref: 'ORD10K' };
ck('A-22', P(OK).ok === true, 'IntaSend itself confirms COMPLETE / same ref / KES / same gross → confirmed', P(OK));
ck('A-23', P({ ok: false, error: 'NETWORK' }).reason === 'provider_unverified' && P(null).reason === 'provider_unverified', 'IntaSend unreachable → REVIEW (never "assume paid")');
ck('A-24', P({ ok: true, found: false }).reason === 'provider_not_found', 'IntaSend has no such collection → REVIEW');
ck('A-25', ['PENDING', 'FAILED', 'PROCESSING', ''].every((s) => P(Object.assign({}, OK, { state: s })).reason === 'provider_not_complete'), 'an UNVERIFIED (not COMPLETE at IntaSend) callback → REVIEW');
ck('A-26', P(Object.assign({}, OK, { api_ref: 'OTHER' })).reason === 'provider_ref_mismatch', 'IntaSend\'s record is for another ref → REVIEW');
ck('A-27', P(Object.assign({}, OK, { value: 1 })).reason === 'provider_amount_mismatch' && P(Object.assign({}, OK, { value: null })).reason === 'provider_amount_missing',
  'IntaSend reports a different or no amount → REVIEW (a forged callback body cannot outvote IntaSend)');
ck('A-28', P(Object.assign({}, OK, { currency: 'USD' })).reason === 'provider_currency_mismatch', 'IntaSend reports another currency → REVIEW');

/* ══ STATIC WIRING — the webhook feeds the gate and asks IntaSend before the COMPLETE claim ══ */
console.log('\nWIRING — webhookIntasend source');
let SRC = ''; try { SRC = fs.readFileSync(path.join(WH, 'index.js'), 'utf8'); } catch (_) {}
const wi = SRC.indexOf('exports.webhookIntasend = onRequest(');
const body = wi >= 0 ? SRC.slice(wi, SRC.indexOf('\nexports.', wi + 10) > 0 ? SRC.indexOf('\nexports.', wi + 10) : undefined) : '';
const claimAt = body.indexOf('let claimed = false;');
ck('W-01', /payerUid:\s+existing\.uid/.test(body) && /order:\s+_gOrder/.test(body), 'the gate is given the payment record\'s payer and the order it would settle');
/* the CALL and its refusal → park, not merely the name (a require line also contains the name) */
const pcCall = body.search(/const _pc = assessProviderConfirmation\(_st, \{ apiRef, expectedCents: _gate\.expectedCents \}\);\s*if \(!_pc\.ok\) \{\s*await _park\(_pc\.reason/);
const stCall = body.search(/_st = await intasendCollectionStatus\(_invId, \{ privateKey: INTASEND_PRIVATE_KEY\.value\(\)/);
ck('W-02', claimAt > 0 && pcCall > 0 && pcCall < claimAt && stCall > 0 && stCall < pcCall,
  'IntaSend is asked, and a refusal PARKS, BEFORE the COMPLETE claim (nothing settles first)');
ck('W-03', /secrets: \[INTASEND_WEBHOOK_CHALLENGE, INTASEND_PRIVATE_KEY\]/.test(SRC.slice(wi, wi + 300)), 'webhookIntasend declares the IntaSend key it needs for the confirmation');
ck('W-04', /require\("\.\/shared\/intasend-status"\)/.test(body) && fs.existsSync(path.join(WH, 'shared', 'intasend-status.js')), 'the ONE IntaSend status helper is used (no second way of calling IntaSend)');

/* ══ LAYER B — the REAL handler, in-process ══ */
(async () => {
  console.log('\nLAYER B — the real webhookIntasend handler (in-memory Firestore, stub IntaSend)');
  let H = null, harnessErr = null;
  try { H = require('./lib/p0-webhook-harness.js')(WH, NM); } catch (e) { harnessErr = e && e.message; }
  if (!H || !H.ready) {
    ['B-01', 'B-02', 'B-03', 'B-04', 'B-05', 'B-06', 'B-07', 'B-08', 'B-09', 'B-10', 'B-11', 'B-12'].forEach((id) => unp(id, 'handler row', 'harness: ' + String(harnessErr || (H && H.error) || 'not ready').slice(0, 120)));
  } else {
    await require('./lib/p0-webhook-rows.js')(H, { ck, unp });
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed' + (unproven ? ', ' + unproven + ' UNPROVEN' : ''));
  process.exit(fail ? 1 : (unproven ? 3 : 0));
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
