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
 * Money is never taken from a wallet here (no business-wallet credit writer exists yet) and nothing touches the
 * till gate (still OFF — P0).
 *
 * M0-4a (2026-09-28): confirmAttempt is THE confirm authority (provider status → judgeEvidence → one transition),
 * used by the Confirm callable and by the scheduled posCommissionAttemptSweep, which converges ABANDONED
 * IntaSend attempts (see sweepOpenAttempts). Every transition takes its expected source state inside its own
 * transaction. The 07:00 business-wallet collector is NOT here: it waits for FC-1 (M0-4b).
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

/* ── expected source state (M0-4a) ────────────────────────────────────────────────────────────────
   A transition that names `opts.from` happens only when the attempt is, INSIDE its own transaction, in one of
   those states; otherwise it is a replay that writes nothing. Two actors (the merchant's Confirm and the
   scheduled sweep) can then race on one attempt and the first transition wins: a PAID attempt can never be
   moved to NEEDS_REVIEW, a NEEDS_REVIEW attempt is not overwritten, a FAILED one is not reopened. Callers that
   pass no `from` keep their certified M0-3 behaviour (cash confirm, cash cancel). */
const allowedFrom = (pd, opts) => !(opts && Array.isArray(opts.from)) || opts.from.includes(pd.status);

/* ── completeAttempt — ONLY on proven money ──────────────────────────────────────────────────────── */
async function completeAttempt(payId, evidence, by, opts) {
  const payRef = db().collection(PAYMENTS).doc(payId);
  return db().runTransaction(async (t) => {
    const p = await t.get(payRef);
    if (!p.exists) throw new HttpsError('not-found', 'No such commission payment.');
    const pd = p.data();
    if (pd.status === STATUS.PAID || pd.status === STATUS.PAID_RECONCILE) return { status: pd.status, replay: true };
    if (!allowedFrom(pd, opts)) return { status: pd.status, replay: true };
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
async function failAttempt(payId, reason, by, opts) {
  const payRef = db().collection(PAYMENTS).doc(payId);
  return db().runTransaction(async (t) => {
    const p = await t.get(payRef);
    if (!p.exists) return { status: 'none' };
    const pd = p.data();
    if (pd.status !== STATUS.OPEN && pd.status !== STATUS.NEEDS_REVIEW) return { status: pd.status, replay: true };
    if (!allowedFrom(pd, opts)) return { status: pd.status, replay: true };
    const claimRefs = pd.debtIds.map((id) => db().collection(CLAIMS).doc(id));
    const claims = await t.getAll(...claimRefs);
    claims.forEach((c, i) => { if (c.exists && c.data().payId === payId && c.data().status === 'HELD') t.delete(claimRefs[i]); });
    t.update(payRef, { status: STATUS.FAILED, failReason: String(reason || 'failed').slice(0, 120), failedAtMs: nowMs(),
      history: admin.firestore.FieldValue.arrayUnion({ atMs: nowMs(), event: 'FAILED', by: by || 'system', reason: String(reason || '').slice(0, 120) }) });
    return { status: STATUS.FAILED };
  });
}

/* M0-4a — was a plain update with no status check, so a concurrent Confirm that had just made the attempt PAID
   could be overwritten with NEEDS_REVIEW. Now transactional, and only from `opts.from` (default: OPEN). Nothing
   moves an attempt OUT of NEEDS_REVIEW here — that is M0-5. */
async function markNeedsReview(payId, problem, evidence, by, opts) {
  const payRef = db().collection(PAYMENTS).doc(payId);
  const from = (opts && Array.isArray(opts.from)) ? opts.from : [STATUS.OPEN];
  return db().runTransaction(async (t) => {
    const p = await t.get(payRef);
    if (!p.exists) return { status: 'none' };
    const pd = p.data();
    if (!from.includes(pd.status)) return { status: pd.status, replay: true };
    t.update(payRef, { status: STATUS.NEEDS_REVIEW, reviewReason: String(problem || '').slice(0, 200), evidence: evidence || null,
      history: admin.firestore.FieldValue.arrayUnion({ atMs: nowMs(), event: 'NEEDS_REVIEW', by: by || 'system', reason: String(problem || '').slice(0, 200) }) });
    return { status: STATUS.NEEDS_REVIEW };
  });
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

/* ══ M0-4a — THE ONE CONFIRM AUTHORITY ════════════════════════════════════════════════════════════════
   provider status → judgeEvidence → exactly one transactional transition. The signed-in Confirm callable (after
   its own permission check) and the scheduled sweep both call THIS; there is no second settlement path.
     COMPLETE (proven)  → completeAttempt, from OPEN — or from FAILED (M0-3 F-4: proven money that arrives after a
                          failure still settles an OUTSTANDING, unclaimed debt; it is never refused)
     FAILED / EXPIRED   → failAttempt, from OPEN only (its claims are released; the debts stay OUTSTANDING)
     not proven         → markNeedsReview, from OPEN — or from FAILED, since a COMPLETE that does not match is a
                          money signal after a failure; nothing is guessed either way
     PENDING            → nothing
   An attempt already in NEEDS_REVIEW is left alone (M0-5 resolves review); PAID / PAID_RECONCILE are final.
   Returns { outcome, status?, why?, evidence?, pd } and never throws for a provider that does not answer. */
async function confirmAttempt(payId, opts) {
  const by = (opts && opts.by) || 'provider';
  const snap = await db().collection(PAYMENTS).doc(String(payId)).get();
  if (!snap.exists) return { outcome: 'NOT_FOUND' };
  const pd = snap.data();
  if (pd.method === METHODS.CASH) return { outcome: 'CASH', status: pd.status, pd };
  if (pd.status === STATUS.PAID || pd.status === STATUS.PAID_RECONCILE) return { outcome: 'ALREADY_PAID', status: pd.status, pd };
  if (pd.status === STATUS.NEEDS_REVIEW) return { outcome: 'IN_REVIEW', status: pd.status, pd };
  if (!pd.providerRef) return { outcome: 'NO_REFERENCE', status: pd.status, pd };
  let ev;
  try {
    const S = require('./shared/intasend-status');
    ev = (await S.readStatus({ invoiceId: pd.providerRef, privateKey: INTASEND_PRIVATE_KEY.value(),
      sandbox: process.env.INTASEND_SANDBOX === 'true', https: require('https') })).evidence;
  } catch (e) { return { outcome: 'PROVIDER_UNANSWERED', status: pd.status, pd }; }
  const j = judgeEvidence(pd, ev);
  if (j.decision === 'COMPLETE') {
    const r = await completeAttempt(pd.payId, Object.assign({ source: 'intasend-status' }, ev), by, { from: [STATUS.OPEN, STATUS.FAILED] });
    return { outcome: r.replay ? 'REPLAY' : 'COMPLETED', status: r.status, pd };
  }
  if (j.decision === 'FAILED') {
    const r = await failAttempt(pd.payId, 'provider state ' + ev.state, by, { from: [STATUS.OPEN] });
    return { outcome: r.replay ? 'REPLAY' : 'FAILED', status: r.status, why: j.why, pd };
  }
  if (j.decision === 'REVIEW') {
    const r = await markNeedsReview(pd.payId, j.why, ev, by, { from: [STATUS.OPEN, STATUS.FAILED] });
    return { outcome: r.replay ? 'REPLAY' : 'REVIEW', status: r.status, why: j.why, pd };
  }
  return { outcome: 'PENDING', status: pd.status, why: j.why, evidence: ev || null, pd };
}

/* ══ M0-4a — THE PENDING-ATTEMPT SWEEP ════════════════════════════════════════════════════════════════
   Converges ABANDONED IntaSend attempts; it never opens one, never calls a payment provider except to READ a
   status, never touches a wallet, and never blocks a till. Cash attempts are resolved by SOKONI, not here.
   Timing is measured from the attempt's persisted createdAtMs (not from a count of sweeps), so a delayed or
   missed run changes nothing:
     eligible    createdAtMs + SWEEP_MIN_AGE_MS            (leaves the interactive Confirm its time)
     pending cap eligible + SWEEP_PENDING_CAP_MS            still PENDING / unanswered after this → NEEDS_REVIEW
   For an OPEN IntaSend attempt past eligibility:
     has a provider reference         → confirmAttempt (the ONE authority)
     no reference, provider never called (gatewayOutcome null — a crash between opening and the call)
                                      → failAttempt: nothing can have been charged; claims released
     no reference, gateway rejected   → failAttempt
     no reference, outcome unknown / accepted without a reference
                                      → NEEDS_REVIEW: a prompt may have reached the phone, so money may be moving */
const SWEEP_MIN_AGE_MS     = 10 * 60 * 1000;
const SWEEP_PENDING_CAP_MS = 30 * 60 * 1000;
const SWEEP_BATCH          = 200;

async function sweepOpenAttempts(opts) {
  const at = (opts && Number.isFinite(opts.nowMs)) ? opts.nowMs : nowMs();
  const q = await db().collection(PAYMENTS).where('status', '==', STATUS.OPEN).limit(SWEEP_BATCH).get();
  const rows = q.docs.map((d) => d.data()).sort((a, b) => Number(a.createdAtMs) - Number(b.createdAtMs));
  const tally = { scanned: rows.length, tooYoung: 0, cash: 0, confirmed: {}, expired: 0, review: 0, pending: 0 };
  const bump = (k) => { tally.confirmed[k] = (tally.confirmed[k] || 0) + 1; };
  for (const pd of rows) {
    if (pd.method === METHODS.CASH) { tally.cash++; continue; }
    const created = Number(pd.createdAtMs);
    const eligibleAt = Number.isFinite(created) ? created + SWEEP_MIN_AGE_MS : 0;
    if (at < eligibleAt) { tally.tooYoung++; continue; }
    const capReached = at >= eligibleAt + SWEEP_PENDING_CAP_MS;
    try {
      if (!pd.providerRef) {
        if (pd.gatewayOutcome == null || pd.gatewayOutcome === 'GATEWAY_REJECTED') {
          const r = await failAttempt(pd.payId, pd.gatewayOutcome == null ? 'never reached the provider' : 'gateway rejected the request',
            'sweep', { from: [STATUS.OPEN] });
          if (!r.replay) tally.expired++;
        } else {
          const r = await markNeedsReview(pd.payId, 'no provider reference; gateway outcome ' + pd.gatewayOutcome, null, 'sweep', { from: [STATUS.OPEN] });
          if (!r.replay) tally.review++;
        }
        continue;
      }
      const r = await confirmAttempt(pd.payId, { by: 'sweep' });
      if ((r.outcome === 'PENDING' || r.outcome === 'PROVIDER_UNANSWERED') && capReached) {
        const m = await markNeedsReview(pd.payId, (r.outcome === 'PENDING' ? 'still pending (' + r.why + ')' : 'provider did not answer')
          + ' past the pending cap', r.evidence || null, 'sweep', { from: [STATUS.OPEN] });
        if (!m.replay) tally.review++;
      } else if (r.outcome === 'PENDING' || r.outcome === 'PROVIDER_UNANSWERED') {
        tally.pending++;
      } else {
        bump(r.outcome);
      }
    } catch (e) {
      /* one attempt must never stop the others; it is simply seen again on the next run */
      console.error('[posCommissionAttemptSweep] attempt not processed', { payId: pd.payId, error: e && e.message });
    }
  }
  return tally;
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
  /* M0-4a — everything past the permission check is the ONE confirm authority, shared with the sweep. */
  const r = await confirmAttempt(payId, { by: 'provider' });
  switch (r.outcome) {
    case 'ALREADY_PAID':        return publicView(pd, { replayed: true });
    case 'IN_REVIEW':           return publicView(pd, { status: STATUS.NEEDS_REVIEW, note: 'This payment is being reviewed by SOKONI.' });
    case 'NO_REFERENCE':        return publicView(pd, { note: 'No provider reference yet.' });
    case 'PROVIDER_UNANSWERED': return publicView(pd, { note: 'The provider did not answer; nothing changed.' });
    case 'PENDING':             return publicView(pd, { note: 'Still pending: ' + r.why });
    case 'REVIEW':              return publicView(pd, { status: STATUS.NEEDS_REVIEW, reason: r.why });
    default:                    return publicView(pd, { status: r.status });
  }
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
/* M0-4a — every 15 minutes, Africa/Nairobi. One instance, no automatic retry: a missed or failed run is simply
   followed by the next one, and every transition it makes is transactional and replay-safe. */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const SWEEP_OPTS = { schedule: 'every 15 minutes', timeZone: 'Africa/Nairobi', region: 'us-central1',
  secrets: [INTASEND_PRIVATE_KEY], retryCount: 0, maxInstances: 1, timeoutSeconds: 300 };
module.exports = {
  LIABILITIES, PAYMENTS, CLAIMS, METHODS, STATUS, MAX_DEBTS_PER_ATTEMPT,
  SWEEP_MIN_AGE_MS, SWEEP_PENDING_CAP_MS, SWEEP_BATCH,
  openAttempt, completeAttempt, failAttempt, markNeedsReview, confirmAttempt, sweepOpenAttempts, judgeEvidence, chargeMinorFor,
  _h: { posCommissionPayNow: _payNowHandler, posCommissionPayNowConfirm: _confirmHandler,
        posCommissionCashRecord: _cashRecordHandler, posCommissionCashConfirm: _cashConfirmHandler, posCommissionCashCancel: _cancelHandler,
        posCommissionAttemptSweep: sweepOpenAttempts },
  posCommissionAttemptSweep: onSchedule(SWEEP_OPTS, async () => {
    const tally = await sweepOpenAttempts();
    console.log('[posCommissionAttemptSweep]', JSON.stringify(tally));
  }),
  posCommissionPayNow:        onCall(OPTS, _payNowHandler),
  posCommissionPayNowConfirm: onCall(OPTS, _confirmHandler),
  posCommissionCashRecord:    onCall(Object.assign({}, OPTS, { secrets: [] }), _cashRecordHandler),
  posCommissionCashConfirm:   onCall(Object.assign({}, OPTS, { secrets: [] }), _cashConfirmHandler),
  posCommissionCashCancel:    onCall(Object.assign({}, OPTS, { secrets: [] }), _cancelHandler),
};
