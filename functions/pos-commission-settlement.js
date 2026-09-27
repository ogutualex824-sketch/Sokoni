'use strict';
/**
 * SOKONI — POS COMMISSION SETTLEMENT (M0-3, owner ruling 2026-09-28)
 * functions/pos-commission-settlement.js
 *
 * THE ONE state machine that turns an OUTSTANDING POS commission debt into a SETTLED one.
 *
 *   debt authority   posCommissionLiabilities/poscomm_<saleId>          (M0-1 — the ONLY debt; never recomputed here)
 *   attempt          posCommissionPayments/{payId}                       one payment attempt over a FROZEN set of debts
 *   claim            posCommissionSettlementClaims/{debtId}              create()-only; a debt is held by at most ONE attempt
 *
 * Every payment mechanism is an ATTEMPT, never a debt authority:
 *   INTASEND_STK       M-Pesa STK push to SOKONI's IntaSend account        (shared/stk-gateway)
 *   INTASEND_CHECKOUT  IntaSend hosted checkout — every method the ACCOUNT has enabled (card, …). The
 *                      payer enters card details on IntaSend's page, on the cashier's phone; SOKONI never
 *                      receives, stores or forwards card credentials.  (shared/intasend-checkout)
 *   CASH               cash handed over, confirmed by a SOKONI platform admin who is not the requester
 *
 * Transitions (all inside Firestore transactions; all reads before writes):
 *   openAttempt      reads the OUTSTANDING debts of one business (or one owner's unresolved debts) and their
 *                    claims; freezes the unclaimed ones, their exact liabilityMinor total, creates the attempt
 *                    and one claim per debt. Same idempotency key → the same attempt.
 *   completeAttempt  only on PROVEN money (provider evidence bound to api_ref, amount and currency — or an
 *                    admin cash confirmation): each frozen debt still OUTSTANDING and held by THIS attempt
 *                    → SETTLED, once. Anything else is recorded for reconciliation, never settled twice.
 *   failAttempt      the payment did not happen: attempt FAILED, its claims released, debts stay OUTSTANDING.
 *
 * Money is never taken from a wallet here (no business-wallet credit writer exists yet), nothing touches the
 * till gate (still OFF — P0), and there is no scheduler (M0-4 must reuse these claims).
 */
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');

const LIABILITIES = 'posCommissionLiabilities';
const PAYMENTS    = 'posCommissionPayments';
const CLAIMS      = 'posCommissionSettlementClaims';
const MAX_DEBTS_PER_ATTEMPT = 200;           /* 1 attempt + 200 claims + 200 debt updates stays inside one commit */
const METHODS = Object.freeze({ STK: 'INTASEND_STK', CHECKOUT: 'INTASEND_CHECKOUT', CASH: 'CASH' });
const STATUS  = Object.freeze({ OPEN: 'OPEN', PAID: 'PAID', PAID_RECONCILE: 'PAID_RECONCILE', NEEDS_REVIEW: 'NEEDS_REVIEW', FAILED: 'FAILED' });
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
/* Fields that would mean card data is travelling through SOKONI. Refused outright. */
const CARD_FIELDS = ['cardNumber', 'card_number', 'pan', 'cvv', 'cvc', 'cvv2', 'expiry', 'exp_month', 'exp_year', 'card'];

const db = () => admin.firestore();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowMs = () => Date.now();

/* M-Pesa charges whole shillings, so the CHARGE is the frozen debt total rounded UP to the next shilling.
   The difference is recorded on the attempt (`roundingMinor`, 0–99) — never silently absorbed. */
const chargeMinorFor = (totalMinor) => Math.ceil(totalMinor / 100) * 100;

/* ── scope: whose debts ────────────────────────────────────────────────────────────────────────── */
async function resolveScope(callerUid, data) {
  if (data && data.scope === 'unresolved') {
    /* Debts whose business could not be resolved (M0-1) are payable ONLY by the proven shop owner:
       their merchantUid IS that owner's uid. The money comes from outside, never from a wallet. */
    return { kind: 'UNRESOLVED_OWNER', businessId: null, merchantUid: callerUid, key: 'uid:' + callerUid };
  }
  const businessId = data && typeof data.businessId === 'string' ? data.businessId : '';
  if (!/^SOK-[A-Za-z0-9_-]{1,80}$/.test(businessId)) {
    throw new HttpsError('invalid-argument', 'businessId (a SOK-* business) is required, or scope "unresolved".');
  }
  /* THE existing guard: the business owner, or an active member holding `finance`. No new guard. */
  await require('./workforce-identity')._assertBusinessPermission(callerUid, businessId, 'finance');
  return { kind: 'BUSINESS', businessId, merchantUid: null, key: 'biz:' + businessId };
}

function debtsQuery(scope) {
  const c = db().collection(LIABILITIES);
  return scope.kind === 'BUSINESS'
    ? c.where('businessId', '==', scope.businessId).where('status', '==', 'OUTSTANDING').limit(MAX_DEBTS_PER_ATTEMPT)
    : c.where('merchantUid', '==', scope.merchantUid).where('businessUnresolved', '==', true)
        .where('status', '==', 'OUTSTANDING').limit(MAX_DEBTS_PER_ATTEMPT);
}

/* ── openAttempt ───────────────────────────────────────────────────────────────────────────────── */
async function openAttempt({ scope, method, idempotencyKey, requestedBy, extra }) {
  const payId = 'poscs_' + sha(scope.key + '|' + idempotencyKey).slice(0, 32);
  const payRef = db().collection(PAYMENTS).doc(payId);
  return db().runTransaction(async (t) => {
    const p = await t.get(payRef);
    if (p.exists) {
      const pd = p.data();
      if (pd.method !== method) {
        throw new HttpsError('failed-precondition', 'This idempotencyKey was already used for a different payment method.');
      }
      return { created: false, payment: pd };
    }
    const debtSnap = await t.get(debtsQuery(scope));
    const claimRefs = debtSnap.docs.map((d) => db().collection(CLAIMS).doc(d.id));
    const claims = claimRefs.length ? await t.getAll(...claimRefs) : [];
    const free = debtSnap.docs.filter((d, i) => !claims[i].exists);
    if (!debtSnap.size) throw new HttpsError('failed-precondition', 'There is no outstanding commission to pay.');
    if (!free.length) throw new HttpsError('failed-precondition', 'A payment for this commission is already in progress.');
    const debtIds = free.map((d) => d.id);
    const totalMinor = free.reduce((s, d) => s + Number(d.data().liabilityMinor), 0);
    if (!Number.isInteger(totalMinor) || totalMinor <= 0) throw new HttpsError('failed-precondition', 'The outstanding debts are unreadable; nothing was started.');
    const chargedMinor = chargeMinorFor(totalMinor);
    const payment = Object.assign({
      payId, method, provider: method === METHODS.CASH ? null : 'INTASEND',
      scope: { kind: scope.kind, businessId: scope.businessId, merchantUid: scope.merchantUid },
      debtIds, debtCount: debtIds.length, totalMinor, chargedMinor, roundingMinor: chargedMinor - totalMinor, currency: 'KES',
      status: STATUS.OPEN, requestedBy, createdAtMs: nowMs(), providerRef: null, gatewayOutcome: null,
      history: [{ atMs: nowMs(), event: 'OPENED', by: requestedBy }],
    }, extra || {});
    t.create(payRef, payment);
    for (const id of debtIds) t.create(db().collection(CLAIMS).doc(id), { debtId: id, payId, status: 'HELD', createdAtMs: nowMs() });
    return { created: true, payment };
  });
}

/* ── completeAttempt — ONLY on proven money ──────────────────────────────────────────────────────── */
async function completeAttempt(payId, evidence, by) {
  const payRef = db().collection(PAYMENTS).doc(payId);
  return db().runTransaction(async (t) => {
    const p = await t.get(payRef);
    if (!p.exists) throw new HttpsError('not-found', 'No such commission payment.');
    const pd = p.data();
    if (pd.status === STATUS.PAID || pd.status === STATUS.PAID_RECONCILE) return { status: pd.status, replay: true };
    const debtRefs = pd.debtIds.map((id) => db().collection(LIABILITIES).doc(id));
    const claimRefs = pd.debtIds.map((id) => db().collection(CLAIMS).doc(id));
    const [debts, claims] = [await t.getAll(...debtRefs), await t.getAll(...claimRefs)];
    const settled = [], unsettled = [];
    pd.debtIds.forEach((id, i) => {
      const d = debts[i].exists ? debts[i].data() : null;
      const c = claims[i].exists ? claims[i].data() : null;
      const heldByUs = c && c.payId === payId;
      const heldByOther = c && c.payId !== payId;
      if (d && d.status === 'OUTSTANDING' && !heldByOther) {
        t.update(debtRefs[i], { status: 'SETTLED', settlementRef: payId, settledVia: pd.method, settledAtMs: nowMs() });
        if (heldByUs) t.update(claimRefs[i], { status: 'SETTLED', settledAtMs: nowMs() });
        else t.create(claimRefs[i], { debtId: id, payId, status: 'SETTLED', createdAtMs: nowMs(), settledAtMs: nowMs() });
        settled.push(id);
      } else {
        unsettled.push(id);
      }
    });
    const status = unsettled.length ? STATUS.PAID_RECONCILE : STATUS.PAID;
    t.update(payRef, {
      status, evidence: evidence || null, settledDebtIds: settled, unsettledDebtIds: unsettled, paidAtMs: nowMs(),
      history: admin.firestore.FieldValue.arrayUnion({ atMs: nowMs(), event: status, by: by || 'system' }),
    });
    return { status, settled: settled.length, unsettled: unsettled.length };
  });
}

/* ── failAttempt — the payment did not happen ────────────────────────────────────────────────────── */
async function failAttempt(payId, reason, by) {
  const payRef = db().collection(PAYMENTS).doc(payId);
  return db().runTransaction(async (t) => {
    const p = await t.get(payRef);
    if (!p.exists) return { status: 'none' };
    const pd = p.data();
    if (pd.status !== STATUS.OPEN && pd.status !== STATUS.NEEDS_REVIEW) return { status: pd.status, replay: true };
    const claimRefs = pd.debtIds.map((id) => db().collection(CLAIMS).doc(id));
    const claims = await t.getAll(...claimRefs);
    claims.forEach((c, i) => { if (c.exists && c.data().payId === payId && c.data().status === 'HELD') t.delete(claimRefs[i]); });
    t.update(payRef, { status: STATUS.FAILED, failReason: String(reason || 'failed').slice(0, 120), failedAtMs: nowMs(),
      history: admin.firestore.FieldValue.arrayUnion({ atMs: nowMs(), event: 'FAILED', by: by || 'system', reason: String(reason || '').slice(0, 120) }) });
    return { status: STATUS.FAILED };
  });
}

async function markNeedsReview(payId, problem, evidence) {
  await db().collection(PAYMENTS).doc(payId).update({ status: STATUS.NEEDS_REVIEW, reviewReason: problem, evidence: evidence || null,
    history: admin.firestore.FieldValue.arrayUnion({ atMs: nowMs(), event: 'NEEDS_REVIEW', by: 'system', reason: problem }) });
}

/* ── provider evidence → a decision. Missing is "not proven", never "matches". ──────────────────── */
function judgeEvidence(pd, ev) {
  if (!ev || !ev.state) return { decision: 'PENDING', why: 'no state' };
  if (['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'RETRY'].includes(ev.state)) return { decision: 'FAILED', why: ev.state };
  if (ev.state !== 'COMPLETE') return { decision: 'PENDING', why: ev.state };
  if (ev.apiRef !== pd.payId) return { decision: 'REVIEW', why: 'api_ref does not name this payment' };
  if (ev.currency !== 'KES') return { decision: 'REVIEW', why: 'currency not proven KES' };
  if (ev.value === null || Math.round(ev.value * 100) !== pd.chargedMinor) return { decision: 'REVIEW', why: 'amount not proven equal to the frozen charge' };
  return { decision: 'COMPLETE', why: 'proven' };
}

/* ── the provider calls (injected https so a harness counts and scripts them) ───────────────────── */
async function initiateProvider(pd, data) {
  const https = require('https');
  const sandbox = process.env.INTASEND_SANDBOX === 'true';
  const amountKES = pd.chargedMinor / 100;
  if (pd.method === METHODS.STK) {
    const G = require('./shared/stk-gateway');
    const payload = G.buildPayload({ phone: data.phone, amountKES, apiRef: pd.payId, narrative: 'SOKONI commission ' + pd.payId.slice(-6) });
    const res = await G.pushSTK({ payload, privateKey: INTASEND_PRIVATE_KEY.value(), sandbox, https });
    return { outcome: G.classifyOutcome(res.status), providerRef: G.checkoutIdOf(res.data), checkoutUrl: null };
  }
  const K = require('./shared/intasend-checkout');
  const publicKey = process.env.INTASEND_PUBLISHABLE_KEY || '';
  const payload = K.buildPayload({ amountKES, apiRef: pd.payId, publicKey, narrative: 'SOKONI commission', email: data.email, firstName: data.firstName, lastName: data.lastName });
  const res = await K.createCheckout({ payload, publicKey, sandbox, https });
  return { outcome: K.classifyOutcome(res.status), providerRef: K.invoiceIdOf(res.data), checkoutUrl: K.checkoutUrlOf(res.data), methods: K.methodsOf(res.data) };
}

function mustKey(data) {
  const k = data && typeof data.idempotencyKey === 'string' ? data.idempotencyKey : '';
  if (!KEY_RE.test(k)) throw new HttpsError('invalid-argument', 'idempotencyKey is required (8-128 characters: letters, digits, _ . : -).');
  return k;
}
function refuseCardData(data) {
  for (const f of CARD_FIELDS) if (data && data[f] !== undefined) {
    throw new HttpsError('invalid-argument', 'Card details are never sent to SOKONI. Use Pay by Card: the payer enters them on the IntaSend page.');
  }
}
const authed = (req) => { if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.'); return req.auth.uid; };
const publicView = (pd, extra) => Object.assign({ payId: pd.payId, status: pd.status, method: pd.method, debtCount: pd.debtCount,
  totalMinor: pd.totalMinor, chargedMinor: pd.chargedMinor, roundingMinor: pd.roundingMinor, currency: pd.currency }, extra || {});

/* ════ CALLABLES ═══════════════════════════════════════════════════════════════════════════════════ */

/** Pay Now through IntaSend. `method`: 'INTASEND_STK' (needs `phone`) or 'INTASEND_CHECKOUT' (card and every
    other method the account has enabled — returns a URL the payer opens). */
async function _payNowHandler(req) {
  const uid = authed(req); const data = req.data || {};
  refuseCardData(data);
  const key = mustKey(data);
  const method = data.method === METHODS.CHECKOUT ? METHODS.CHECKOUT : data.method === METHODS.STK ? METHODS.STK : null;
  if (!method) throw new HttpsError('invalid-argument', "method must be 'INTASEND_STK' or 'INTASEND_CHECKOUT'.");
  if (method === METHODS.STK && !/^254\d{9}$/.test(String(data.phone || ''))) throw new HttpsError('invalid-argument', 'phone must be 2547XXXXXXXX / 2541XXXXXXXX.');
  if (method === METHODS.CHECKOUT && !process.env.INTASEND_PUBLISHABLE_KEY) {
    throw new HttpsError('failed-precondition', 'Card and other IntaSend methods are not configured yet (no publishable key). Nothing was started.');
  }
  const scope = await resolveScope(uid, data);
  const { created, payment } = await openAttempt({ scope, method, idempotencyKey: key, requestedBy: uid });
  if (!created) return publicView(payment, { replayed: true, checkoutUrl: payment.checkoutUrl || null });
  /* The provider call happens AFTER the claims are committed, exactly once per attempt. */
  let r;
  try { r = await initiateProvider(payment, data); }
  catch (e) { r = { outcome: 'OUTCOME_UNKNOWN', providerRef: null, checkoutUrl: null, error: String(e && e.message || e).slice(0, 120) }; }
  await db().collection(PAYMENTS).doc(payment.payId).update({ gatewayOutcome: r.outcome, providerRef: r.providerRef || null,
    checkoutUrl: r.checkoutUrl || null, providerMethods: r.methods || null,
    history: admin.firestore.FieldValue.arrayUnion({ atMs: nowMs(), event: 'GATEWAY_' + r.outcome, by: 'system' }) });
  if (r.outcome === 'GATEWAY_REJECTED') { await failAttempt(payment.payId, 'gateway rejected the request', 'system'); return publicView(Object.assign({}, payment, { status: STATUS.FAILED })); }
  /* OUTCOME_UNKNOWN: the claims stay HELD — money may be moving. Confirm (or the M0-4 sweep) resolves it. */
  return publicView(payment, { gatewayOutcome: r.outcome, checkoutUrl: r.checkoutUrl || null, methods: r.methods || null });
}

/** Ask the provider what happened, and apply it through the ONE state machine. Safe to call any number of times. */
async function _confirmHandler(req) {
  const uid = authed(req); const payId = String((req.data || {}).payId || '');
  const snap = await db().collection(PAYMENTS).doc(payId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such commission payment.');
  const pd = snap.data();
  if (pd.requestedBy !== uid) {
    if (pd.scope.kind !== 'BUSINESS') throw new HttpsError('permission-denied', 'Not your payment.');
    await require('./workforce-identity')._assertBusinessPermission(uid, pd.scope.businessId, 'finance');
  }
  if (pd.method === METHODS.CASH) throw new HttpsError('failed-precondition', 'A cash payment is confirmed by SOKONI, not by the provider.');
  if (pd.status === STATUS.PAID || pd.status === STATUS.PAID_RECONCILE) return publicView(pd, { replayed: true });
  if (!pd.providerRef) return publicView(pd, { note: 'No provider reference yet.' });
  let ev;
  try {
    const S = require('./shared/intasend-status');
    ev = (await S.readStatus({ invoiceId: pd.providerRef, privateKey: INTASEND_PRIVATE_KEY.value(), sandbox: process.env.INTASEND_SANDBOX === 'true', https: require('https') })).evidence;
  } catch (e) { return publicView(pd, { note: 'The provider did not answer; nothing changed.' }); }
  const j = judgeEvidence(pd, ev);
  if (j.decision === 'COMPLETE') { const r = await completeAttempt(payId, Object.assign({ source: 'intasend-status' }, ev), 'provider'); return publicView(pd, { status: r.status }); }
  if (j.decision === 'FAILED') { if (pd.status === STATUS.OPEN) await failAttempt(payId, 'provider state ' + ev.state, 'provider'); return publicView(pd, { status: pd.status === STATUS.OPEN ? STATUS.FAILED : pd.status }); }
  if (j.decision === 'REVIEW') { await markNeedsReview(payId, j.why, ev); return publicView(pd, { status: STATUS.NEEDS_REVIEW, reason: j.why }); }
  return publicView(pd, { note: 'Still pending: ' + j.why });
}

/** Cash, step 1 — the owner or a `finance` member records that cash was handed to SOKONI. Nothing settles yet. */
async function _cashRecordHandler(req) {
  const uid = authed(req); const data = req.data || {};
  refuseCardData(data);
  const key = mustKey(data);
  const scope = await resolveScope(uid, data);
  const { created, payment } = await openAttempt({ scope, method: METHODS.CASH, idempotencyKey: key, requestedBy: uid,
    extra: { cashNote: String(data.note || '').slice(0, 200) } });
  return publicView(payment, { replayed: !created, note: 'Awaiting confirmation by SOKONI.' });
}

/** Cash, step 2 — ONLY a SOKONI platform admin who is NOT the requester, with a receipt number, can settle it. */
async function _cashConfirmHandler(req) {
  const uid = authed(req); const data = req.data || {};
  const tok = (req.auth && req.auth.token) || {};
  if (!(tok.admin === true || tok.superAdmin === true)) throw new HttpsError('permission-denied', 'Only SOKONI can confirm that cash was received.');
  const receiptNo = String(data.receiptNo || '').trim();
  if (!/^[A-Za-z0-9_.:\/-]{4,64}$/.test(receiptNo)) throw new HttpsError('invalid-argument', 'receiptNo is required.');
  const payId = String(data.payId || '');
  const snap = await db().collection(PAYMENTS).doc(payId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such commission payment.');
  const pd = snap.data();
  if (pd.method !== METHODS.CASH) throw new HttpsError('failed-precondition', 'Only a cash payment can be confirmed as cash.');
  if (pd.requestedBy === uid) throw new HttpsError('permission-denied', 'The person who recorded the cash cannot also confirm it.');
  if (pd.status === STATUS.FAILED) throw new HttpsError('failed-precondition', 'This cash payment was cancelled.');
  const r = await completeAttempt(payId, { source: 'cash', receiptNo, confirmedBy: uid, confirmedAtMs: nowMs() }, uid);
  return publicView(pd, { status: r.status });
}

/** Cancel an OPEN cash payment (nothing was received). IntaSend attempts resolve only through the provider. */
async function _cancelHandler(req) {
  const uid = authed(req); const payId = String((req.data || {}).payId || '');
  const snap = await db().collection(PAYMENTS).doc(payId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such commission payment.');
  const pd = snap.data();
  if (pd.method !== METHODS.CASH) throw new HttpsError('failed-precondition', 'An IntaSend payment is resolved by the provider, not cancelled.');
  if (pd.requestedBy !== uid) throw new HttpsError('permission-denied', 'Only the requester can cancel it.');
  const r = await failAttempt(payId, 'cancelled by requester', uid);
  return publicView(pd, { status: r.status });
}

const OPTS = { region: 'us-central1', enforceAppCheck: true, secrets: [INTASEND_PRIVATE_KEY], maxInstances: 20 };
module.exports = {
  LIABILITIES, PAYMENTS, CLAIMS, METHODS, STATUS, MAX_DEBTS_PER_ATTEMPT,
  openAttempt, completeAttempt, failAttempt, judgeEvidence, chargeMinorFor,
  _h: { posCommissionPayNow: _payNowHandler, posCommissionPayNowConfirm: _confirmHandler,
        posCommissionCashRecord: _cashRecordHandler, posCommissionCashConfirm: _cashConfirmHandler, posCommissionCashCancel: _cancelHandler },
  posCommissionPayNow:        onCall(OPTS, _payNowHandler),
  posCommissionPayNowConfirm: onCall(OPTS, _confirmHandler),
  posCommissionCashRecord:    onCall(Object.assign({}, OPTS, { secrets: [] }), _cashRecordHandler),
  posCommissionCashConfirm:   onCall(Object.assign({}, OPTS, { secrets: [] }), _cashConfirmHandler),
  posCommissionCashCancel:    onCall(Object.assign({}, OPTS, { secrets: [] }), _cancelHandler),
};
