'use strict';
/**
 * webhookIntasend financial attribution — the D1 fix (Q6).
 *
 * initiateSTKPush writes payments/{ref}.meta verbatim from the client's own
 * request argument. webhookIntasend used to read THAT for who gets paid
 * (sellerUid, providerId), which order gets finalised (orderId, items), and
 * — since Q5 — which Till a sale belongs to. This file is the ONE place that
 * decision is made now: prefer paymentIntents/{ref}.metadata (server-derived,
 * the whole reason payment-purposes.js exists) whenever an intent exists;
 * fall back to the client-supplied meta, UNCHANGED, when it does not — so a
 * caller not yet migrated onto createPaymentIntent (D2's remaining, separate
 * gap) keeps working exactly as it does today.
 *
 * mergeAttribution is pure (no Firestore) so it is directly certifiable —
 * see scripts/test-webhook-attribution.js — the same split
 * functions/sokoni-qr-authority.js (Q5) already established.
 *
 * Till-identity fields (sokoniTillId/shopId/branchId/merchantUid) are the one
 * hard floor here: they are NEVER read from legacyMeta, intent present or
 * not. There is no legacy Till flow whose behaviour needs preserving, so
 * unlike sellerUid/orderId (which DO have long-standing legacy traffic to
 * stay compatible with) these fields simply do not exist unless a verified
 * pos_till_sale intent produced them.
 *
 * Deliberately OUT OF SCOPE (docs/WEBHOOK_ATTRIBUTION_AUTHORITY.md §2-3):
 * commission `category` (a real, evidenced regression risk — see the doc),
 * and the cosmetic/logistics fields (hub, sellerName, buyerName, address,
 * fulfillmentType, serviceDesc, providerName) that no pricer's metadata
 * carries today.
 */

function mergeAttribution({ intent, legacyMeta }) {
  legacyMeta = legacyMeta || {};

  if (intent && intent.metadata && typeof intent.metadata === 'object') {
    const m = intent.metadata;
    return {
      source:       'intent',
      sellerUid:    m.sellerUid || null,
      providerId:   m.providerId || null,
      orderId:      m.orderId || null,
      items:        Array.isArray(m.items) ? m.items : null,
      type:         m.type || null,
      sokoniTillId: m.sokoniTillId || null,
      shopId:       m.shopId || null,
      branchId:     m.branchId || null,
      merchantUid:  m.merchantUid || null,
    };
  }

  /* No usable intent — behaviour byte-identical to pre-Q6 for every
     not-yet-migrated caller. Till fields are the one exception: they are
     ALWAYS null here, never sourced from legacyMeta (see header). */
  return {
    source:       'legacy_meta',
    sellerUid:    legacyMeta.sellerUid || null,
    providerId:   legacyMeta.providerId || null,
    orderId:      legacyMeta.orderId || null,
    items:        Array.isArray(legacyMeta.items) ? legacyMeta.items : null,
    type:         legacyMeta.type || null,
    sokoniTillId: null,
    shopId:       null,
    branchId:     null,
    merchantUid:  null,
  };
}

/**
 * resolveFinancialAttribution — I/O wrapper. Loads paymentIntents/{intentRef}
 * ONCE and delegates the decision to mergeAttribution. Fails OPEN to
 * legacyMeta on a read error (never blocks the webhook — the payment itself
 * is already captured and authoritative by the time this runs).
 */
async function resolveFinancialAttribution(db, { intentRef, legacyMeta }) {
  let intent = null;
  try {
    const snap = await db.collection('paymentIntents').doc(String(intentRef)).get();
    if (snap.exists) intent = snap.data();
  } catch (_) { /* fail open — merged below with intent:null, same as "not found" */ }

  return mergeAttribution({ intent, legacyMeta });
}

/**
 * decidePaidTransition — Q7. Given a payment intent's CURRENT state, the
 * webhook-confirmed amount, and whether this payment is a Till sale, decide
 * whether paymentIntents/{ref} should transition to 'paid'. Pure — no
 * Firestore — so it is directly certifiable
 * (scripts/test-pos-till-paid-transition.js), the same split every pure core
 * in this programme (Q5, Q6) already uses.
 *
 * Scoped to Till sales only by the CALLER (webhookIntasend passes
 * isTillSale = !!attribution.sokoniTillId) — every other purpose is
 * untouched by this slice; see docs/POS_QR_PAID_STATE_INTEGRATION.md §4 for
 * why that is a deliberate scoping decision, not an oversight.
 *
 * Returns one of:
 *   { action: 'noop' }            — already terminal (paid/expired/cancelled), or no intent
 *   { action: 'mark_paid' }       — safe to transition to 'paid'
 *   { action: 'flag_mismatch' }   — confirmed amount does not match the intent's own —
 *                                   intent stays exactly as it is (NOT paid); caller should
 *                                   log/flag for review, never trust the webhook's figure here
 */
const TERMINAL_INTENT_STATUSES = ['paid', 'expired', 'cancelled'];

function decidePaidTransition({ intent, confirmedAmount, isTillSale }) {
  if (!isTillSale) return { action: 'noop' };
  if (!intent) return { action: 'noop' };
  if (TERMINAL_INTENT_STATUSES.includes(String(intent.status))) return { action: 'noop' };

  const expected = Math.round(Number(intent.amount));
  const confirmed = Math.round(Number(confirmedAmount));
  if (!Number.isFinite(expected) || !Number.isFinite(confirmed) || expected !== confirmed) {
    return { action: 'flag_mismatch' };
  }
  return { action: 'mark_paid' };
}

/**
 * Would webhookIntasend's settlement branch finalise a marketplace order (order → paid, stock
 * decremented via _finalizeMarketplacePayment) for this meta? THE one definition: the settlement branch
 * and the Unit 4b gate both call it, so "what the gate refuses" can never drift from "what settlement
 * would do". Semantics are byte-for-byte the expression it replaced in index.js (lowercase, NOT
 * trimmed; String() coercion) — changing them changes live settlement, not just the gate.
 */
function wouldFinalizeMarketplaceOrder(meta) {
  const m = (meta && typeof meta === 'object') ? meta : {};
  const cat = String(m.category || '').toLowerCase();
  return !!m.orderId
    && m.type !== 'booking'
    && !['subscription', 'wallet_topup', 'topup'].includes(cat);
}

/**
 * ONLINE PRODUCT CHECKOUT — may this provider confirmation settle this order? (owner repair #1,
 * 2026-09-30; drafted for review by the webhook-lineage owner).
 *
 * Applies ONLY when the payment carries a server-minted `product_order` intent (createPaymentIntent,
 * priced from the catalogue, seller resolved from each product's own record).
 *
 * UNIT 4b — AN INTENT-LESS PAYMENT MAY NOT FINALISE A MARKETPLACE ORDER. When there is NO intent and
 * the client-written meta would drive `_finalizeMarketplacePayment` (order → paid, stock decremented),
 * the payment is refused as `missing_intent`: the seller, the items and the amount would all come from
 * the browser (legacy_meta). Keyed on that EFFECT (wouldFinalizeMarketplaceOrder — the webhook's own
 * settlement branch calls the same predicate), NOT on the `category` label:
 *   - a label is browser-chosen, so `category:'default'` + `orderId` would dodge a label rule and
 *     still finalise the order;
 *   - SokoniPay's gateway labels a deposit `product.category || 'product'` (product.js contact-seller
 *     fallback) with NO orderId — it finalises no order and must not be refused here.
 * Census 2026-09-30 (live hosting b108ae3): checkout.html is the only STK caller that sends orderId, and
 * sokoni-intasend.js forwards orderId only when the caller supplies it. POS, bookings and every other
 * SokoniPay caller keep today's behaviour until their own migration.
 * DEPLOY ORDER: only after the checkout client that mints product_order intents is live (Unit 3) AND
 * initiateSTKPush refuses intent-less product STKs (Unit 4a), and after in-flight legacy STKs drain.
 * A straggler is PARKED as REVIEW, never lost: the money is captured and a reviewer re-drives it.
 *
 * The comparison is on the GROSS amount the buyer paid (`value`), to the CENT, in KES.
 *
 * WHY GROSS — MEASURED, DO NOT "CORRECT" THIS TO `amount`. Production webhookIntasend logs (read-only,
 * key names and amount relationships only; first fee-bearing COMPLETE seen 2026-09-14T01:15:13Z,
 * sampled 2026-09-30) show IntaSend's collection body is FLAT — invoice_id, api_ref, state, value,
 * net_amount, charges, currency, provider at the top level, no `invoice` wrapper — and on COMPLETE
 * M-PESA `value − net_amount === charges` (e.g. 1.80, 0.03). The webhook's own `amount` is
 * `net_amount`, so an exact gate on it would refuse every legitimate payment that carried a fee.
 * Whole-shilling rounding is deliberately NOT used: KES 389.60 must not satisfy KES 390.00.
 *
 * SCOPE OF THE EVIDENCE. All 11 collection bodies in the 30 days to 2026-09-30 were provider M-PESA,
 * each carrying `value` and `currency`. Card is not on this rail today (online checkout refuses it).
 * If a card or other method is added to product checkout, re-verify that its confirmation carries
 * `value` + `currency` BEFORE enabling it — otherwise every such payment parks as missing_evidence.
 *
 * Pure apart from the one intent read the caller passes in. Never throws, never writes.
 *
 * @param {object|null} intent   paymentIntents/{intentRef} data, or null
 * @param {object} evidence      { apiRef, grossAmount, currency } from the provider payload, plus
 *                               legacyMeta: payments/{ref}.meta (client-written; used ONLY to decide
 *                               that a refusal applies, never to decide who is paid or how much)
 * @returns {{applies:false}|{applies:true, ok:boolean, reason?:string, expectedCents?:number, confirmedCents?:number}}
 */
/* Order statuses from which a product order may become paid (census 2026-10-03: checkout.html writes
   'pending_payment'; nothing writes a failed-payment status to orders). Anything else — paid, cancelled,
   processing, shipped, delivered, refunded … — is not payable: the payment parks as REVIEW. */
const PAYABLE_ORDER_STATUSES = Object.freeze(['', 'pending_payment', 'pending', 'awaiting_payment']);

function assessProductOrderPayment(intent, evidence) {
  const e = evidence || {};
  if (!intent) {
    return wouldFinalizeMarketplaceOrder(e.legacyMeta)
      ? { applies: true, ok: false, reason: 'missing_intent', expectedCents: null }
      : { applies: false };
  }
  if (intent.purpose !== 'product_order') return { applies: false };
  const md = (intent.metadata && typeof intent.metadata === 'object') ? intent.metadata : {};
  const expectedCents = Number(intent.amountCents);
  const refuse = (reason, extra) => Object.assign({ applies: true, ok: false, reason, expectedCents }, extra || {});

  /* The intent must be THIS order's: a valid payment for another order cannot settle this one. */
  if (!e.apiRef || String(md.orderId || '') !== String(e.apiRef) || String(intent.resourceId || '') !== String(e.apiRef)) {
    return refuse('wrong_order');
  }
  /* SINGLE USE (P0, owner 2026-10-03). Nothing in this lineage marks a product_order intent paid (only subscription
     and till intents are), so a product intent that is already terminal — paid included — was consumed or closed
     elsewhere: it cannot settle this payment. A replay of THIS payment never reaches here (payments/{ref} COMPLETE
     returns first). */
  if (TERMINAL_INTENT_STATUSES.includes(intent.status)) {
    return refuse(intent.status === 'paid' ? 'intent_consumed' : 'intent_terminal');
  }
  /* BUYER BINDING (P0). The server intent names its owner. The payment record's initiator (payments/{ref}.uid,
     written by initiateSTKPush from request.auth) must be that owner, and an existing order's buyer must be too —
     a payment started by buyer A can never settle buyer B's order. A missing owner is not "anyone". */
  const owner = String(intent.uid || '');
  if (!owner) return refuse('intent_owner_missing');
  if (String(e.payerUid || '') !== owner) return refuse('wrong_buyer');
  const order = (e.order && typeof e.order === 'object') ? e.order : null;
  if (order) {
    const buyer = String(order.buyerUid || order.uid || order.buyerId || '');
    if (buyer && buyer !== owner) return refuse('wrong_buyer');
    /* ORDER STILL PAYABLE (P0): only an order awaiting payment can become paid. */
    if (!PAYABLE_ORDER_STATUSES.includes(String(order.status || ''))) return refuse('order_not_payable', { orderStatus: String(order.status || '') });
    /* payment.currency == order.currency (brief Gate 5): an order that names a currency must name KES. */
    if (order.currency && String(order.currency).toUpperCase() !== 'KES') return refuse('wrong_currency');
  }
  if (!Number.isInteger(expectedCents) || expectedCents <= 0) return refuse('intent_amount_invalid');
  const cur = String(e.currency || '').toUpperCase();
  if (!cur) return refuse('missing_evidence');
  if (cur !== 'KES' || String(intent.currency || 'KES').toUpperCase() !== 'KES') return refuse('wrong_currency');
  const gross = Number(e.grossAmount);
  if (e.grossAmount === null || e.grossAmount === undefined || e.grossAmount === '' || !Number.isFinite(gross)) {
    return refuse('missing_evidence');
  }
  const confirmedCents = Math.round(gross * 100);
  if (confirmedCents !== expectedCents) return refuse('amount_mismatch', { confirmedCents });
  return { applies: true, ok: true, expectedCents, confirmedCents };
}

/**
 * PROVIDER CONFIRMATION (P0, owner 2026-10-03): "payment status actually verified by IntaSend". The webhook is
 * authenticated by the shared challenge, but its body is still a claim. Before a product order settles, the server
 * asks IntaSend itself (shared/intasend-status.js) and this decides, purely, whether that answer confirms THIS
 * payment: found, COMPLETE, the same api_ref, KES, and the same GROSS value to the cent as the server intent.
 * Unreachable / not found / anything different → a refusal reason (the caller parks REVIEW). Never throws.
 * @param {object} st  intasendCollectionStatus result
 * @param {{apiRef:string, expectedCents:number}} want
 */
function assessProviderConfirmation(st, want) {
  const w = want || {};
  if (!st || st.ok !== true) return { ok: false, reason: 'provider_unverified', detail: st && st.error ? String(st.error) : 'NO_RESULT' };
  if (!st.found) return { ok: false, reason: 'provider_not_found' };
  if (String(st.state || '').toUpperCase() !== 'COMPLETE') return { ok: false, reason: 'provider_not_complete', detail: String(st.state || '') };
  if (!w.apiRef || String(st.api_ref || '') !== String(w.apiRef)) return { ok: false, reason: 'provider_ref_mismatch' };
  if (String(st.currency || '').toUpperCase() !== 'KES') return { ok: false, reason: 'provider_currency_mismatch' };
  if (st.value === null || st.value === undefined || !Number.isFinite(Number(st.value))) return { ok: false, reason: 'provider_amount_missing' };
  const cents = Math.round(Number(st.value) * 100);
  if (!Number.isInteger(w.expectedCents) || cents !== w.expectedCents) return { ok: false, reason: 'provider_amount_mismatch', providerCents: cents };
  return { ok: true, providerCents: cents };
}

module.exports = { mergeAttribution, resolveFinancialAttribution, decidePaidTransition, assessProductOrderPayment, assessProviderConfirmation, wouldFinalizeMarketplaceOrder, TERMINAL_INTENT_STATUSES, PAYABLE_ORDER_STATUSES };
