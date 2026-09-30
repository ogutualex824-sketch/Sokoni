'use strict';
/**
 * SOKONI Till/QR — pure decision core (Q5 implementation).
 *
 * WHY THIS FILE IS SEPARATE FROM sokoni-till.js
 * Every decision that determines who gets paid, how much, and whether a QR is
 * genuine lives here as plain functions: no Firestore, no firebase-admin, no
 * Cloud Functions framework. sokoni-till.js (the onCall layer) does I/O only —
 * it reads documents, calls these functions to decide, and writes the result.
 * That split is what makes "unusually strong certification" (per the Q5
 * instruction) possible without an emulator: scripts/test-sokoni-qr-payment.js
 * calls these functions directly, the same way scripts/test-money-authority.js
 * already certifies functions/money-authority.js's pure core.
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE (docs/SOKONI_TILL_QR_CONTRACT.md, Q4)
 * QR -> server resolves token -> server resolves Till/paymentIntent -> server
 * derives merchant + amount. A client is never authoritative for merchantUid,
 * shopId, branchId, amount, commission or settlement. Every function below
 * that touches those fields reads them from server-loaded state (`till`,
 * `intent`), never from the caller-supplied `data` object — checked directly
 * in scripts/test-sokoni-qr-payment.js's "client-altered merchant" cases.
 *
 * WHAT THIS FILE DOES NOT DO
 * Does not create paymentIntents (createPaymentIntent, unmodified, still does
 * that — priceTillSale below is called FROM payment-purposes.js's pos_till_sale
 * entry, the same "one entry here" seam every other purpose already uses).
 * Does not touch webhookIntasend, initiateSTKPush, commission or settlement
 * logic (D1/D2/D3 in docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md remain unfixed,
 * unrelated to this file).
 */

const crypto = require('crypto');

/* Provider floor/ceiling — mirrors payment-purposes.js's MIN_KES/MAX_KES so a
   till-sale intent cannot fall outside the range every other purpose already
   enforces. Checked here too (not just in payment-purposes.js's priceFor) so
   this module's own certification does not depend on that file. */
const MIN_KES = 1;
const MAX_KES = 150000;

const TOKEN_TYPES = ['till', 'intent'];
const ID_RE = /^[A-Za-z0-9_-]{3,128}$/;

function _err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ── Opaque signed token ─────────────────────────────────────────────────
   Reuses pos-qr.js's exact mechanism (crypto.randomBytes/HMAC-SHA256/
   timingSafeEqual) — not its posPayments schema or completion path
   (docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md D3). The signature covers a type
   discriminator + the id, so a Till reference and a paymentIntent reference
   can never be confused for one another even if an id string collided
   between the two keyspaces (docs/SOKONI_TILL_QR_CONTRACT.md, Q1). Truncated
   to 32 hex chars (128 bits) rather than pos-qr.js's 16 (64 bits) — the same
   shape, a wider margin, because this is asked to be certified as forgery-
   resistant rather than merely unguessable-by-enumeration. */
function _sign(payload, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update(payload).digest('hex').slice(0, 32);
}

function mintToken(type, id, secret) {
  if (!TOKEN_TYPES.includes(type)) throw _err('invalid-argument', `Unknown token type "${type}".`);
  if (!ID_RE.test(String(id || ''))) throw _err('invalid-argument', 'Invalid id for token.');
  if (!secret) throw _err('failed-precondition', 'Signing secret not configured.');
  const sig = _sign(`${type}:${id}`, secret);
  return `${type}.${id}.${sig}`;
}

/**
 * verifyToken — the ONLY way a token string becomes trusted (type, id).
 * Returns null on ANY malformation or signature mismatch — never partial
 * trust. Constant-time comparison so a forged token cannot be narrowed down
 * byte-by-byte via response timing.
 */
function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token || token.length > 300) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [type, id, sig] = parts;
  if (!TOKEN_TYPES.includes(type)) return null;
  if (!ID_RE.test(id)) return null;
  if (!/^[0-9a-f]{32}$/.test(sig)) return null;
  if (!secret) return null;

  const expected = _sign(`${type}:${id}`, secret);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return { type, id };
}

/* ── Till identity derivation (Q2/Q4) ────────────────────────────────────
   Deliberately deviates from Q2's cosmetic "SK-KASS-0001" example: a shop-
   name-only code can collide across two differently-owned shops with similar
   names, and sokoniTillId is a platform-wide Firestore document id, not a
   per-shop-scoped one. Appending a stable suffix derived from the shop's own
   uid keeps the id human-plausible while making a cross-shop collision
   require an actual uid-suffix collision, not just a common shop name.
   mintSokoniTill's transaction still uses tx.create() (fails closed on
   ALREADY_EXISTS) as defense in depth if one ever occurred anyway. */
function deriveShopCode(name, shopId) {
  const nameRaw = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const base = (nameRaw || 'SHOP').slice(0, 6);
  const suffix = String(shopId || '').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase().padStart(4, 'X');
  return `${base}${suffix}`;
}

/* ── SOKONI Till number — DIGITS ONLY ─────────────────────────────────────
   The stored identity is a plain number, e.g. 2347283. `SOK-` is a DISPLAY
   prefix applied at render time and is never part of the stored id.

   This replaced `SK-${shopCode}-${seq}` (e.g. SK-KASSAB12-0001). That form
   carried letters derived from the shop name, which meant the Till number
   leaked the trading name, changed shape between merchants, and could not be
   read out over a counter or a phone the way a till number actually is.

   UNIQUENESS is global and comes from a single monotonic counter, not from the
   shop code — a per-shop sequence plus a name-derived prefix was only unique
   because the prefix disambiguated it, and digits alone cannot do that. The
   allocation is transactional, so the counter cannot hand the same number to
   two merchants.

   The number is PUBLIC by design — a customer reads it to pay — so being
   sequential is not a weakness. Nothing is authorised by knowing a Till number:
   resolution requires the HMAC-signed token, and Till activity is admin-only
   "never by anyone who merely knows the sokoniTillId string".

   BASE keeps every number 7 digits and stops the first merchant being Till 1. */
const TILL_NUMBER_BASE = 2000000;

function formatTillId(globalSeq) {
  const n = Math.max(1, Math.round(Number(globalSeq) || 1));
  return String(TILL_NUMBER_BASE + n);
}

/* Presentation only. Storage, lookup and signing all use the bare number. */
function displayTillId(id) {
  const s = String(id == null ? '' : id).trim();
  return s ? `SOK-${s}` : '';
}

/* A canonical Till id is digits only. Used to refuse the retired
   `SK-SHOP-0001` shape rather than silently accepting both forever. */
function isCanonicalTillId(id) {
  return /^[0-9]{7,}$/.test(String(id == null ? '' : id).trim());
}

/* ── Till allocation decision (Till Approval Automation) ─────────────────
   Given whether an ACTIVE Till already exists for (shopId, branchId) and
   the caller's requested behaviour, decide what mintSokoniTillCore
   (functions/sokoni-till.js) should do next. Pure — no Firestore — so the
   idempotency guarantee this whole feature depends on ("approving the same
   merchant twice returns the existing Till, never mints a second one") is
   directly certifiable, the same way every other Till/QR safety property
   in this programme is (Q5-Q8).
     onExisting:'throw'  — self-service (mintSokoniTill's own onCall): a
       seller double-tapping "Generate" sees an explicit conflict error.
     onExisting:'return' — server-triggered (application-lifecycle.js's
       applyDecision, and the Firestore trigger that can legitimately
       re-fire for the same approval): converge on the existing Till. */
function decideTillAllocation({ hasActiveTill, onExisting }) {
  if (!hasActiveTill) return { action: 'mint' };
  if (onExisting === 'return') return { action: 'return_existing' };
  return { action: 'throw_conflict' };
}

/* ── Till payability (Q2 Q6/Q7, Q4 Q6) ───────────────────────────────────
   The ONE gate every resolution path (permanent-QR scan, dynamic-sale
   pricing) must pass through, re-checked at resolution time — not cached
   from mint time — so a Till disabled between mint and scan fails closed. */
function checkTillPayable(till) {
  if (!till) return { ok: false, code: 'not-found', reason: 'Till not found.' };
  if (till.status !== 'ACTIVE') {
    return { ok: false, code: 'failed-precondition', reason: 'This till is not accepting payments.' };
  }
  return { ok: true };
}

/* ── Dynamic-intent resolution state (Q4 Q4/Q5; extended Q8) ─────────────
   `nowMs` is a parameter (not Date.now() internally) purely so this stays a
   pure function certifiable with fixed clocks in the test suite.

   Q8 ADDITION: `status:'paid'` is now a distinct SUCCESS outcome
   (`{ok:true, status:'paid'}`), not a refusal. The buyer's payment page
   (Q8) polls resolveSokoniQR for the dynamic-QR flow — the buyer is not the
   intent's owner (the cashier is, Q5), so it cannot read paymentIntents/{ref}
   directly via Firestore rules, and must poll through this same,
   already-hardened resolution path instead of a new one. Treating 'paid' as
   a refusal would make the SECOND poll after a successful payment throw,
   which is wrong — the buyer scanning/polling their own already-paid sale is
   not a security concern (initiateSTKPush's own idempotent-replay guard,
   unmodified, is what actually prevents a double charge; this function only
   decides whether resolveSokoniQR replies, never whether money moves).
   `completed`/`cancelled`/`expired` remain refusals, unchanged — those are
   genuinely no-longer-payable and never in this function's caller's
   interest to succeed on. */
function classifyIntentResolution(intent, nowMs) {
  if (!intent) return { ok: false, code: 'not-found', reason: 'Payment reference not found.' };
  if (intent.purpose !== 'pos_till_sale') {
    return { ok: false, code: 'failed-precondition', reason: 'Not a Till payment.' };
  }
  const status = String(intent.status || '');

  if (status === 'paid') return { ok: true, status: 'paid' };

  const terminal = ['completed', 'cancelled', 'expired'].includes(status);
  if (terminal) return { ok: false, code: 'failed-precondition', reason: 'This payment is no longer available.' };

  const expMs = Number(intent.expiresAtMs);
  const expired = Number.isFinite(expMs) && expMs < Number(nowMs);
  if (expired) return { ok: false, code: 'failed-precondition', reason: 'This payment QR has expired.' };

  if (status !== 'created') {
    return { ok: false, code: 'failed-precondition', reason: 'This payment is not available.' };
  }
  return { ok: true, status: 'created' };
}

/* ── STK-push caller authorization for a Till-sale intent (Q8) ───────────
   initiateSTKPush (functions/index.js) refuses to push an STK request
   whenever `intent.uid !== request.auth.uid` — correct and unchanged for
   every purpose where the payer IS the intent's own owner (subscriptions,
   marketplace checkout, bookings). It does NOT hold for the dynamic-QR Till
   flow: the intent is created by the CASHIER (Q5's `pos_till_sale`
   cart-mode requires `callerUid === till.merchantUid`), but the person who
   must actually push the STK request and receive the prompt is the WALK-UP
   BUYER scanning the QR — a different uid, by design, every time.

   This function is the ONE place that exception is decided, so it is
   certifiable in isolation. It is deliberately narrow: it returns true only
   when the intent unambiguously IS a Till sale whose money-routing is
   ALREADY fully locked to the Till's own merchant (`metadata.merchantUid`,
   Q6-hardened) — meaning the STK caller's identity has zero influence on
   who gets credited or what is charged (amount is separately enforced,
   unconditionally, by initiateSTKPush's own existing amount-match check
   whenever an intent exists — untouched by this function). Any other
   ownership mismatch (every other purpose) is refused exactly as before. */
function canInitiateStkForIntent(intent) {
  if (!intent) return false;
  return intent.purpose === 'pos_till_sale'
    && !!(intent.metadata && intent.metadata.merchantUid);
}

/* ── pos_till_sale pricing decision (Q3) ─────────────────────────────────
   Called from payment-purposes.js's `pos_till_sale` registry entry, which
   supplies `till` (already loaded from Firestore) and `callerUid`
   (request.auth.uid — createPaymentIntent's own, unmodified auth gate).
   Returns the same shape every other pricer returns; payment-purposes.js's
   priceFor() re-applies MIN_KES/MAX_KES after this returns, unchanged.
   `shopId`/`branchId`/`merchantUid` in the returned metadata are read
   EXCLUSIVELY off `till` — `data` is never consulted for them, which is what
   makes "client-altered merchant -> rejected" true by construction rather
   than by a check that could be forgotten (see the test suite's
   "merchant tamper" cases, which pass a hostile data.shopId/merchantUid and
   assert the returned metadata ignores it). */
function priceTillSale({ till, callerUid, data }) {
  data = data || {};

  const payable = checkTillPayable(till);
  if (!payable.ok) throw _err(payable.code, payable.reason);

  let amountCents;
  let sourceMode;
  let lines = null;

  if (Array.isArray(data.items) && data.items.length) {
    /* Cashier/dynamic flow — the cart is only trustworthy from the Till's own
       authorized operator (same trust boundary POS sales already use: the
       cashier's price entry is the existing authority, not a new one). */
    if (String(callerUid) !== String(till.merchantUid)) {
      throw _err('permission-denied', 'Not authorized to sell on this Till.');
    }
    if (data.items.length > 100) throw _err('invalid-argument', 'Too many line items.');

    let subtotal = 0;
    lines = data.items.map((it, i) => {
      const name = String((it && it.name) || `Item ${i + 1}`).replace(/[<>]/g, '').trim().slice(0, 120);
      const price = Number(it && it.price);
      const qty = Math.max(1, Math.min(999, Math.round(Number(it && it.qty) || 1)));
      if (!(price > 0)) throw _err('invalid-argument', `Item "${name}" has no valid price.`);
      subtotal += price * qty;
      return { name, price, qty };
    });
    amountCents = Math.round(subtotal * 100);
    sourceMode = 'pos_cart';
  } else if (data.amount !== undefined && data.amount !== null && data.amount !== '') {
    /* Permanent-Till / buyer-entered flow — there is no cart to validate
       against; the buyer's own typed figure IS the amount, by the nature of
       a Till payment (docs/SOKONI_TILL_QR_CONTRACT.md, Q4 Q7) — bounded like
       every other purpose, not matched against anything else because
       nothing else exists to match it against. */
    const amt = Number(data.amount);
    if (!Number.isFinite(amt) || amt <= 0) throw _err('invalid-argument', 'Enter a valid amount.');
    amountCents = Math.round(amt * 100);
    sourceMode = 'buyer_entered';
  } else {
    throw _err('invalid-argument', 'items or amount is required.');
  }

  if (!(amountCents > 0)) throw _err('failed-precondition', 'Sale has no payable amount.');
  const kes = amountCents / 100;
  if (kes < MIN_KES || kes > MAX_KES) throw _err('failed-precondition', 'Amount is outside the payable range.');

  /* Idempotency key. A cashier's double-tap of "Generate QR" for the SAME
     cart must resolve to the SAME intent, not mint a second one — reuses
     createPaymentIntent's existing preferredRef/replay machinery verbatim
     (docs/SOKONI_TILL_PAYMENT_INTENT_ATTACHMENT.md), unmodified here. */
  const saleId = String(data.saleId || '').trim();
  let preferredRef;
  if (saleId) {
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(saleId)) throw _err('invalid-argument', 'Invalid saleId.');
    preferredRef = `POSTILL-${till.sokoniTillId}-${saleId}`.slice(0, 128);
  }

  return {
    amountCents,
    currency: till.currency || 'KES',
    resourceType: 'posTillSale',
    resourceId: saleId ? `${till.sokoniTillId}-${saleId}` : `${till.sokoniTillId}-${Date.now().toString(36)}`,
    preferredRef,
    metadata: {
      sokoniTillId: till.sokoniTillId,
      shopId: till.shopId,
      branchId: till.branchId,
      merchantUid: till.merchantUid,
      category: 'pos_till',
      sourceMode,
      items: lines,
    },
  };
}

module.exports = {
  MIN_KES, MAX_KES, TOKEN_TYPES,
  mintToken, verifyToken,
  deriveShopCode, formatTillId, displayTillId, isCanonicalTillId,
  checkTillPayable, classifyIntentResolution, priceTillSale,
  canInitiateStkForIntent, decideTillAllocation,
};
