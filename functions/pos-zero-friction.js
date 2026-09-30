/* ================================================================
   SOKONI SmartPOS — Zero Friction Checkout Cloud Functions v1.0
   Server-authoritative checkout chain (idempotent Firestore tx):
   verify payment → update inventory → award loyalty → receipt → analytics
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { writeAudit } = require('./pos-audit');
/* The employment authority. Required at LOAD, deliberately: if this cannot be
   resolved the deploy fails loudly, instead of every till silently losing
   discount authorisation and the "Served by" line at the same moment. */
const { resolveActor } = require('./merchant-identity')._internal;
/* Canonical employee authority + the ownerUid -> merchantId resolver. Neither adds a
   store; both are the already-canonical engines. */
const { _assertBusinessPermission } = require('./workforce-identity');
const { resolveMerchantIdForOwner: _resolveMerchantIdForOwner } = require('./tenant-identity');

const db      = getFirestore();
const REGION  = 'us-central1';
const cfg     = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 };
const cfgHeavy= { region: REGION, enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 120 };

/* ── Helpers ── */
const uid = () => db.collection('_').doc().id;

function _sanitize(s) {
  if (typeof s !== 'string') return String(s||'');
  return s.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
}

function _e(msg, code='invalid-argument') {
  throw new HttpsError(code, msg);
}

async function _assertAuth(auth) {
  if (!auth?.uid) _e('Authentication required', 'unauthenticated');
  return auth.uid;
}

/* The POS/Till commission rail — required LAZILY, on the call rather than at module load.
   This module already carries a module-scope require of an absent file; a second top-level
   dependency would be a second way for the whole POS surface to fail to deploy. Requiring it
   inside the operation means a problem with the rail refuses THAT SALE loudly instead of
   taking every callable in this file down with it. */
function _posRail() { return require('./pos-commission-rail'); }

/* collectionRoute -> the commission rail key, which is what decides CUSTODY.

   The route is already the system's answer to "who is holding this money", so this is a
   translation, not a second judgement. An UNRECOGNISED route resolves to the NON-CUSTODIAL
   key: if we cannot show SOKONI collected the money, the merchant is holding it and owes the
   commission. The opposite default would silently write off every sale on a route nobody had
   mapped yet — an under-collection that no error surfaces and no report shows. */
function _posRailKeyFor(collectionRoute) {
  switch (String(collectionRoute || '').toUpperCase()) {
    case 'CASH_IN_DRAWER': return 'POS_CASH';        /* notes in the drawer   — owed  */
    case 'CENTRAL_MOR':    return 'POS_MPESA_STK';   /* SOKONI collected it   — netted */
    case 'DIRECT_TO_SELLER':
    default:               return 'TILL_DIRECT';     /* merchant's own till   — owed  */
  }
}

/* Fetch merchant config from Firestore */
async function _getMerchant(merchantId) {
  const snap = await db.collection('merchants').doc(merchantId).get();
  if (!snap.exists) _e('Merchant not found', 'not-found');
  return { id: merchantId, ...snap.data() };
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE FINANCIAL TRACE FOR ONE TILL SALE
   ══════════════════════════════════════════════════════════════════════════════
   Returns { tax, commission, collectionRoute, status } and NEVER throws. A sale
   that has already moved stock and taken money must not be failed because a
   bookkeeping write did not land — but the failure must also never be silent, so
   an unpostable sale is stamped `status: 'failed'` with its reason and can be
   found and repaired. A swallowed catch here would be the healthy-looking failure
   that hides missing revenue for months.
────────────────────────────────────────────────────────────────────────────── */
/* Per-method daily increments. Kept as a nested map of increments so a split
   tender contributes to EVERY method it used — the old `paymentMethod:
   payments[0].method` recorded one tender for the whole sale, so a 4,000 M-Pesa
   + 2,000 cash sale was filed entirely under whichever came first. */
function _methodIncrements(position) {
  const out = {};
  const by = (position && position.byMethod) || {};
  for (const k of Object.keys(by)) out[k] = FieldValue.increment(by[k] || 0);
  return out;
}

async function _postSaleFinancials(o) {
  const out = { status: 'pending', tax: null, commission: null, collectionRoute: null,
                position: null, error: null };
  const toCents = (n) => Math.round((Number(n) || 0) * 100);

  try {
    /* ── which collection model applied, so reconciliation never assumes ──── */
    try {
      const pc = require('./payment-config');
      const r = await pc.resolveCollectionRoute(db);
      out.collectionRoute = r.route;
    } catch (_) { out.collectionRoute = 'DIRECT_TO_SELLER'; }
    /* Cash is never centrally collected whatever the route says — it is in a
       drawer. Recording the configured route against a cash sale would misstate
       who holds the money. */
    /* Points P2b: a points tender is not money (the shop funds it), so cash + points is still cash-in-drawer */
    const allCash = (o.payments || []).every((p) => ['cash', 'points', 'gift_card'].includes(String(p.method).toLowerCase()));
    if (allCash) out.collectionRoute = 'CASH_IN_DRAWER';

    /* ══ THE MONEY POSITION ══════════════════════════════════════════════════
       WHERE the money physically is, which is not the same question as how much
       the sale was for. Cash sits in a drawer; an M-Pesa or card tender sits with
       the payment provider. Merging them into one `totalRevenue` — which is all
       posDailySummary held — makes reconciliation impossible: a merchant cannot
       count a drawer against a number that also contains money that never
       entered it.

       CASH IS RECORDED NET OF CHANGE. What went into the drawer is what was
       tendered minus what was handed back, so 3,500 taken on a 3,000 sale is
       +3,000, not +3,500. Change comes out of the same drawer.

       Electronic amounts are the CONFIRMED ones. An unconfirmed tender never
       reaches this function: the sale would have been refused. */
    const cashTenderedC = toCents((o.payments || [])
      .filter((p) => String(p.method).toLowerCase() === 'cash')
      .reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const changeC = toCents(o.changeDue);
    const byMethod = {};
    let electronicC = 0, pointsC = 0, giftC = 0;
    for (const p of (o.payments || [])) {
      const m = String(p.method || '').toLowerCase();
      const c = toCents(p.amount);
      byMethod[m] = (byMethod[m] || 0) + c;
      /* Points P2b: points are a SHOP-FUNDED discount, not money held by a provider */
      if (m === 'points') { pointsC += c; continue; }
      if (m === 'gift_card') { giftC += c; continue; }       /* slice 13: prepaid store value, not money arriving */
      if (m !== 'cash') electronicC += c;
    }
    /* The drawer figure replaces the gross cash line: byMethod.cash is what the
       customer handed over, position.cashCents is what stayed. */
    out.position = {
      cashCents: Math.max(0, cashTenderedC - changeC),
      electronicCents: electronicC,
      pointsCents: pointsC,
      giftCardCents: giftC,
      changeGivenCents: changeC,
      byMethod,
    };

    /* ── TAX — an ESTIMATE from the records SOKONI holds, never an assessment ──
       A merchant who has not declared a VAT status gets NO figure. Applying 16%
       to a business that may not be VAT-registered would invent a liability, and
       an invented tax number is worse than a stated unknown. */
    let vatStatus = 'undeclared';
    try {
      const m = await db.collection('merchants').doc(String(o.merchantId)).get();
      const v = m.exists ? String((m.data() || {}).vatStatus || '') : '';
      if (v === 'registered' || v === 'exempt' || v === 'zero_rated') vatStatus = v;
    } catch (_) { /* unreadable → stays undeclared, which is the honest answer */ }

    if (vatStatus === 'undeclared') {
      out.tax = {
        basis: 'sokoni_estimate', vatStatus: 'undeclared',
        vatCents: null, taxableCents: null,
        reason: 'This shop has not recorded a VAT status, so SOKONI cannot estimate VAT ' +
                'for this sale. Set it once in settings and every later sale carries it.',
      };
    } else {
      const TE = require('./etims-tax-engine');
      /* KRA (owner 2026-09-29): points are a discount given BY THE SHOP, so VAT is on the reduced price — as are the
         sale's other discounts (offers, coupon, manual), which this estimate used to ignore. Spread pro rata over the
         lines through the engine's own discountRate. The engine reads `quantity`; it was sent `qty`, so every
         multi-quantity line was estimated as ONE unit. */
      const _saleDisc = Math.max(0, (Number(o.discount) || 0) + (Number(o.pointsKES) || 0));
      const _gross = Math.max(0, Number(o.subtotal) || 0);
      const _dcRt = _gross > 0 ? Math.min(100, Math.round(_saleDisc / _gross * 1e6) / 1e4) : 0;
      const inv = TE.computeInvoice({
        items: (o.items || []).map((it) => ({
          name: it.name, quantity: Number(it.qty || 1), unitPrice: Number(it.unitPrice || 0), discountRate: _dcRt,
        })),
        vatStatus,
      });
      const t = inv.totals || {};
      out.tax = {
        /* NEVER 'official'. SOKONI assists with filing; KRA/ETIMS assesses.
           The day an ETIMS response exists it is stored beside this, not over it. */
        basis: 'sokoni_estimate',
        vatStatus,
        vatCents: toCents(t.totTaxAmt),
        taxableCents: toCents(t.totTaxblAmt),
        totalCents: toCents(t.totAmt),
        engine: 'etims-tax-engine',
      };
    }

    /* ── COMMISSION — the canonical rate, never a local table ──────────────── */
    let pct = null, commissionCents = 0, sellerNetCents = null;
    try {
      const FU = require('./finos-utils');
      /* Cents in, cents out — calculateCommission speaks orderAmountCents and
         returns commissionCents. Converting through shillings here would round
         twice and drift from the marketplace's figure on the same basket. */
      const c = await FU.calculateCommission(db, {
        /* owner 2026-09-29: commission on the MONEY RECEIVED — the points part is the shop's own discount */
        orderAmountCents: toCents(Math.max(0, (Number(o.total) || 0) - (Number(o.pointsKES) || 0))), sellerId: o.merchantId,
        hubId: 'pos', category: 'pos',
      });
      pct = (c && typeof c.effectiveRate === 'number') ? c.effectiveRate : null;
      commissionCents = (c && Number.isInteger(c.commissionCents)) ? c.commissionCents : 0;
      sellerNetCents  = (c && Number.isInteger(c.sellerNetCents)) ? c.sellerNetCents : null;
    } catch (e) {
      out.status = 'failed';
      out.error = 'commission rate unavailable: ' + ((e && e.message) || e);
      return out;
    }

    out.commission = {
      pct: (typeof pct === 'number') ? pct : null,
      amountCents: commissionCents,
      basisCents: toCents(Math.max(0, (Number(o.total) || 0) - (Number(o.pointsKES) || 0))),
      /* What the seller keeps, from the same engine — so the merchant wallet and
         the platform never disagree about the split of one sale. */
      sellerNetCents: sellerNetCents,
      /* Not collected at the point of sale — see the note at the call site. */
      collected: false,
      settlement: 'receivable',
    };

    /* ── THE LEDGER ENTRY ──────────────────────────────────────────────────
       Double entry, and the direction matters. The seller HOLDS the cash and
       OWES the commission, so the seller account is DEBITED and platform revenue
       is CREDITED. Nothing is drawn from platform clearing, because no platform
       cash exists for this sale.
       Zero commission writes nothing: createLedgerEntry requires a positive
       amount, and a zero-value entry would be noise in a reconciliation. */
    if (commissionCents > 0) {
      const FU = require('./finos-utils');
      await FU.createLedgerEntry(db, {
        type: 'pos_commission_receivable',
        amountCents: commissionCents,
        debitAccount: FU.ACCOUNTS ? FU.ACCOUNTS.seller(o.merchantId) : ('seller:' + o.merchantId),
        creditAccount: (FU.ACCOUNTS && FU.ACCOUNTS.PLATFORM_REVENUE) || 'platform:revenue',
        description: 'SOKONI commission on till sale ' + o.saleId,
        orderId: o.saleId,
        sellerId: o.merchantId,
        category: 'pos',
        createdBy: 'posCompleteCheckout',
        /* Derived from the SALE's idempotency key, so a retried posting for the
           same sale is recognised and cannot double-book commission. */
        idempotencyKey: 'poscomm_' + o.idempotencyKey,
        metadata: { collectionRoute: out.collectionRoute, commissionPct: pct },
      });
    }

    out.status = 'posted';
    return out;
  } catch (e) {
    /* Recorded, not swallowed. The sale stands; the books are marked repairable. */
    out.status = 'failed';
    out.error = (e && e.message) || String(e);
    try {
      await db.collection('posFinancialRepair').doc(String(o.saleId)).set({
        saleId: o.saleId, merchantId: o.merchantId, idempotencyKey: o.idempotencyKey,
        totalCents: Math.round((Number(o.total) || 0) * 100),
        error: out.error, at: Date.now(),
      });
    } catch (_) { /* even the marker failed — the status on the sale still says so */ }
    return out;
  }
}

/* ════════════════════════════════════════════════════════════════
   posCompleteCheckout
   Idempotent authoritative checkout:
   1. Check idempotency key
   2. Verify payment (if M-Pesa, verify with IntaSend)
   3. Deduct inventory (transaction, all-or-nothing)
   4. Award loyalty points
   5. Mark coupon used
   6. Save sale to posRetailSales + posDaily
   7. Create receipt
   8. Update analytics
════════════════════════════════════════════════════════════════ */
/* Points P1: a sale can open the buyer's SOKONI loyalty account, whose card QR is signed with LOYALTY_HMAC_SECRET. */
const _LOYALTY_HMAC = require('firebase-functions/params').defineSecret('LOYALTY_HMAC_SECRET');   /* same secret loyalty.js declares */
/* The ONE gift-card acceptance rule (giftCards store). Returns a refusal message, or null when the card may pay. */
function _giftCardRefusal(g, { merchantId, pin, amount }) {
  if (!g) return 'That gift card does not exist.';
  if (String(g.shopId || '') !== String(merchantId)) return 'That gift card belongs to another shop.';
  if (g.status !== 'active') return 'That gift card is ' + (g.status || 'not active') + '.';
  const exp = g.expiryDate && typeof g.expiryDate.toMillis === 'function' ? g.expiryDate.toMillis() : (g.expiryDate ? Date.parse(g.expiryDate) : null);
  if (exp && exp < Date.now()) return 'That gift card has expired.';
  if (g.pin && String(g.pin) !== String(pin || '')) return 'Wrong gift card PIN.';
  if (!(Number(amount) > 0)) return 'Every payment needs a positive amount';
  if ((Number(g.balance) || 0) + 1e-9 < Number(amount)) return 'The gift card has only KES ' + (Number(g.balance) || 0) + ' left.';
  return null;
}

exports.posCompleteCheckout = onCall({ ...cfgHeavy, secrets: [_LOYALTY_HMAC] }, async ({ data, auth }) => {
  const cashierId = await _assertAuth(auth);

  const {
    idempotencyKey,
    merchantId,
    branchId      = 'default',
    shiftId,
    items: _itemsIn = [],
    customer,
    payments      = [],
    couponCode,
    loyaltyRedeemPoints = 0,
    buyerPhone    = null,     /* Points P1: identifies the buyer to credit — never a points figure */
    subtotal,
    discountTotal = 0,
    taxTotal      = 0,
    grandTotal,
    metadata      = {},
  } = data || {};

  if (!idempotencyKey) _e('idempotencyKey required');
  if (!merchantId)     _e('merchantId required');
  if (!Array.isArray(_itemsIn) || !_itemsIn.length) _e('items required');
  /* QUICK CHARGE (Step 2, 2026-09-30 — owner: "use till and poscheckout"): a described, cashier-priced line with NO
     catalogue item — a delivery fee, a repair, a government application. It is a line ON THIS SALE, priced by the
     existing pure core (shared/pos-service-pricing.js, the quick_charge lane: description required, bounded, attributed
     to the cashier). It has NO product, NO stock and NO offers — it can never become a shadow product. Every other part
     of the sale — the merchant proof, the payment proof, customer, points, commission, tax, receipt — is this function's
     own, unchanged. Product lines below are exactly as before. */
  const items = _itemsIn.filter((it) => !(it && it.quickCharge === true));
  const _quickIn = _itemsIn.filter((it) => it && it.quickCharge === true);
  if (_quickIn.some((it) => it.productId)) _e('A quick charge is not a catalogue item — sell a product from the catalogue instead.');
  let quickLines = [];
  if (_quickIn.length) {
    let _qp;
    try {
      /* The core's trust boundary is "the till's own operator". THIS function proves that below (resolveActor — owner or
         authorised staff of merchantId — and the sale is refused otherwise), so the core is asked on the shop's behalf and
         the line is attributed to the real cashier. Pure: nothing is written before the sale's own checks pass. */
      _qp = require('./shared/pos-service-pricing').priceServiceBasket({
        lines: _quickIn.map((it) => ({ description: it.description || it.name, unitPriceKES: it.unitPrice, qty: it.qty })),
        catalogue: {}, callerUid: String(merchantId), merchantUid: String(merchantId),
      });
    } catch (qe) { _e(qe.message || 'That quick charge could not be priced.', qe.code || 'invalid-argument'); }
    quickLines = _qp.lines.map((l) => ({
      productId: null, name: l.name, qty: l.qty, unitPrice: l.unitCents / 100, lineTotal: l.lineCents / 100,
      priceSource: 'quick_charge', authorizedBy: String(cashierId), categoryId: null,
    }));
  }
  if (!grandTotal || grandTotal < 0) _e('grandTotal invalid');
  /* LOYALTY REDEMPTION — ported from main's Q0a (dd9dc2a), the redemption rule only. The transaction writes
     `loyaltyPoints = max(0, points + awarded - loyaltyRedeemPoints)` with the browser's figure: a NEGATIVE value
     minted points, a non-number coerced or wrote NaN, and a positive value burned points while the charged total
     never moved (the till's loyalty discount is not in discountTotal, and no server-side point price exists on
     this path). So the figure must be a whole, non-negative number and any non-zero redemption is refused; zero
     stays valid. Customer OWNERSHIP is already enforced on this line inside the transaction (c4f6ced,
     pos-customer-scope.ownsCustomer) — deliberately not duplicated here. Checked before anything is read,
     claimed, priced or charged. Number.isInteger is false for strings, booleans, null, arrays, NaN and ±Infinity. */
  if (!Number.isInteger(loyaltyRedeemPoints) || loyaltyRedeemPoints < 0) {
    _e('loyaltyRedeemPoints must be a whole, non-negative number');
  }
  if (loyaltyRedeemPoints > 0) {
    _e('Loyalty points cannot be redeemed at the till yet, so no points were used and nothing was charged.',
       'failed-precondition');
  }
  if (customer?.id && (typeof customer.id !== 'string' || !/^[^/]{1,200}$/.test(customer.id))) {
    _e('customer.id must be a single customer record id');
  }

  /* ── DRY-RUN (checkout-convergence shadow instrumentation) ──
     Side-effect-FREE: validate + price against the CANONICAL products collection and compute
     what the order + stock deltas WOULD be, then return — NO idempotency claim, NO order, NO
     stock write, NO payment, NO customer-visible effect. Lets the shadow compare the canonical
     result against the legacy till with zero risk. Gated by an explicit flag existing callers
     never pass, so the real settlement path below is completely untouched. */
  if (data && data.dryRun === true) {
    const refs  = items.map(it => db.collection('products').doc(it.productId));
    const snaps = await Promise.all(refs.map(r => r.get()));
    let serverSubtotal = 0;
    const enriched = [], stockDeltas = [], differences = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i], s = snaps[i];
      if (!s.exists) { differences.push({ productId: it.productId, error: 'not-found' }); continue; }
      const p = s.data();
      const serverPrice = p.salePrice || p.price || 0;
      if (Math.abs(serverPrice - (it.unitPrice || 0)) > 1) {
        differences.push({ productId: it.productId, field: 'unitPrice', expected: it.unitPrice, canonical: serverPrice });
      }
      enriched.push({ productId: it.productId, name: p.name, qty: it.qty || 1, unitPrice: serverPrice,
        _own: String(p.shopId || p.sellerUid || '') === String(merchantId) });
      serverSubtotal += serverPrice * (it.qty || 1);
      /* Inventory convergence A (2026-09-30): only a METERED item has a stock delta. An item with no numeric `stock`
         is unmetered (shared/sellability.stockOf) — it never had a "0 → 0" figure to show. */
      const _stD = require('./shared/sellability').stockOf(p);
      if (_stD.metered && p.trackInventory !== false) {
        const from = _stD.stock, to = Math.max(0, from - (it.qty || 0));
        stockDeltas.push({ productId: it.productId, from, to, delta: to - from });
      }
    }
    /* U7c2 (2026-09-29): the SAME offer quote the real sale will apply, so the till can SHOW it before charging.
       Only this shop's own lines are quoted; an unreadable offer store is reported, never shown as "no offers". */
    const _oq = await require('./shop-offers').quoteShopOffers(db, { shopId: String(merchantId),
      lines: enriched.filter((l) => l._own), deliveryFee: 0, buyerUid: (customer && customer.id) ? String(customer.id) : null });
    const _offerDiscount = _oq.unavailable ? null : Math.max(0, Number(_oq.discount) || 0);
    enriched.forEach((l) => { delete l._own; });
    /* Quick charge: the same core figure the real sale books (no offers, no stock) */
    quickLines.forEach((l) => { serverSubtotal += l.lineTotal; enriched.push(Object.assign({}, l)); });
    return {
      dryRun: true,
      ok: differences.length === 0 && !_oq.unavailable,
      serverSubtotal,
      offerDiscount: _offerDiscount,
      offersApplied: _oq.unavailable ? [] : (_oq.applied || []).filter((a) => a.kind !== 'delivery').map((a) => ({ id: a.id, label: a.label, amount: a.amount })),
      offersUnavailable: !!_oq.unavailable,
      grandTotal: serverSubtotal - (discountTotal || 0) - (_offerDiscount || 0) + (taxTotal || 0),
      items: enriched,
      stockDeltas,
      differences,
    };
  }

  /* ── 1. Idempotency claim — atomic ──
     The previous version read, checked, then set: two concurrent requests (double-tap, HTTP
     retry, two till terminals) could both read "not exists" and both proceed — the race window
     in F3. create() is atomic: exactly one caller creates the doc; every other gets
     ALREADY_EXISTS and is routed to the cached result or rejected. */
  const idemRef = db.collection('posIdempotency').doc(idempotencyKey);
  try {
    await idemRef.create({ status: 'processing', startedAt: Date.now(), cashierId, merchantId });
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) {
      const prev = (await idemRef.get()).data() || {};
      if (prev.status === 'complete') return { saleId: prev.saleId, receipt: prev.receipt, cached: true };
      /* A FAILED attempt must be retryable, or a refusal becomes permanent.
         The till deliberately holds ONE sale token across retries so the key is
         reproduced identically — that is what makes a retry safe. But it also
         means an attempt refused for a CORRECTABLE reason (a discount the cashier
         is not authorised to give, an STK push the buyer had not confirmed yet)
         could never be corrected and re-sent: every retry would be turned away as
         "already in progress" and the sale would be stranded.
         Re-claiming here runs the whole validation again from the top. */
      if (prev.status !== 'failed') _e('Checkout already in progress', 'already-exists');
      await idemRef.set({ status: 'processing', startedAt: Date.now(), cashierId, merchantId,
                          retryOf: prev.failedAt || null });
      /* Re-claimed: fall through to the validation below rather than rethrowing
         the ALREADY_EXISTS that brought us here. */
    } else {
      throw err;   /* a real infra error — let the caller retry */
    }
  }

  /* Confirmed non-cash payments this attempt has claimed. Declared OUT here so a
     refusal below can RELEASE them: a sale that does not complete must not leave
     the customer's money spent on nothing. */
  const _consumed = [];

  try {
    /* ── 2. Validate cart totals server-side — batch fetch all products ──
       Reads the CANONICAL `products` collection (Stage 2 convergence). posProducts was empty for
       most merchants, so the till failed "product not found" on every sale; and it deducted a
       separate stock counter from the one inventory/catalogue/dispatch use. One source now. */
    const productRefs  = items.map(item => db.collection('products').doc(item.productId));
    const productSnaps = await Promise.all(productRefs.map(r => r.get()));

    let serverSubtotal = 0;
    const enrichedItems = [];
    for (let i = 0; i < items.length; i++) {
      const item     = items[i];
      const prodSnap = productSnaps[i];
      if (!prodSnap.exists) _e(`Product ${item.productId} not found`, 'not-found');
      const prod = prodSnap.data();
      /* Price tolerance: allow minor rounding diff (≤1 KES per item) */
      const serverPrice = prod.salePrice || prod.price || 0;
      const diff = Math.abs(serverPrice - (item.unitPrice || 0));
      if (diff > 1) _e(`Price mismatch for ${prod.name}: expected ${serverPrice}, got ${item.unitPrice}`);
      enrichedItems.push({ ...item, name: _sanitize(prod.name), unitPrice: serverPrice, categoryId: prod.category || prod.categoryId || null });
      serverSubtotal += serverPrice * (item.qty || 1);
    }
    /* Quick charge: the core's figure, never the caller's subtotal */
    quickLines.forEach((l) => { serverSubtotal += l.lineTotal; });
    const saleLines = enrichedItems.concat(quickLines);   /* what the sale, its tax trace and its receipt record */

    /* Allow ±2% rounding tolerance on subtotal */
    if (Math.abs(serverSubtotal - subtotal) > serverSubtotal * 0.02 + 1) {
      _e(`Subtotal mismatch: server=${serverSubtotal} client=${subtotal}`);
    }

    /* ── 3. Coupon validation ── */
    let couponDiscount = 0;
    if (couponCode) {
      const cpSnap = await db.collection('coupons').doc(couponCode.trim().toUpperCase()).get();
      if (!cpSnap.exists || !cpSnap.data().active) _e('Coupon invalid or expired');
      const cp = cpSnap.data();
      if (cp.merchantId && cp.merchantId !== merchantId) _e('Coupon not valid for this store');
      if (cp.expiresAt?.toMillis && cp.expiresAt.toMillis() < Date.now()) _e('Coupon has expired');
      if (cp.usageLimit && (cp.usageCount || 0) >= cp.usageLimit) _e('Coupon usage limit reached');
      couponDiscount = cp.type === 'percent'
        ? Math.min(serverSubtotal * cp.value / 100, cp.maxDiscount || serverSubtotal)
        : Math.min(cp.value || 0, serverSubtotal);
    }

    /* ══════════════════════════════════════════════════════════════════════
       3a. THE SALE AUTHORITY — the total is computed here, never accepted
       ══════════════════════════════════════════════════════════════════════
       Everything below used to be taken on trust from the caller. `grandTotal`
       was destructured straight out of `data` and written to revenue, so a
       3,000 cart could be recorded as a 1 shilling sale; `discountTotal` was
       believed with no coupon, no role and no approval behind it; and an
       M-PESA tender was recorded as taken without anyone confirming the money
       arrived. The till is not the only caller — anything holding a signed-in
       session can reach this function — so the authority has to live here.

       Four rules, in the order money actually moves:
         · a manual discount is AUTHORISED against the actor's real role
         · the total is COMPUTED from the server's own prices
         · the tenders must COVER that total
         · a non-cash tender must be CONFIRMED, and confirmed money may be
           spent on exactly one sale */

    const _round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    /* ── the actor, resolved from the server's own employment records ──────
       resolveActor is the existing merchant-identity authority. It keys the
       owner off the shops/{uid} document id (so ownership cannot be forged by
       writing a field) and an employee off shopEmployees.shopOwnerId matching
       the shop being acted on. `merchantId` here IS the shopId — the till
       sends `merchantId: scope.shopId`.

       resolveActor returns { ok:false, reason } for an ordinary refusal — this
       person is not employed here — and that is a legitimate answer. It THROWING
       is a different thing entirely: the authority itself is unavailable. The two
       must not collapse into one "no actor", because that would silently turn off
       discount authorisation for everybody at the moment the check broke. */
    let _actor = null;
    try {
      _actor = await resolveActor(cashierId, merchantId);
    } catch (err) {
      _e('Staff permissions could not be checked, so this sale was not completed. ' +
         'Nothing has been charged.', 'unavailable');
    }

    /* ══ THE MERCHANT MUST BE PROVEN, NOT DECLARED ═══════════════════════════
       `merchantId` arrives in the request body. Until this block it was checked
       for PRESENCE only (`if (!merchantId) _e('merchantId required')`) and then
       used as the tenant for the entire sale — the products read, the shift
       query, the sale document, the inventory deduction and the commission.

       A comment further down asserted this was already handled — "merchantId is
       enforced by resolveActor above (the sale is refused when !_actor.ok)" —
       but NOTHING REFUSED IT. `_actor` was consumed for discount authority, for
       one error message, and for the receipt's servedBy line. A caller could put
       any shop's id in the body and book a sale into their books. The comment
       described a guarantee the code did not provide, which is worse than no
       comment: the next reader stops looking.

       THIS IS WHAT MAKES THE COMMISSION GATE SAFE TO ENFORCE. Gating on a
       forgeable id would be worse than not gating — a merchant could pass a
       clean shop's id to dodge their own closed gate, or a rival's id to gate an
       innocent party — and it would look like enforcement. Proving the id first
       is the whole precondition.

       TWO AUTHORITIES, UNION — deliberately the same pair the discount check
       below already uses. resolveActor covers owners (keyed off the shops/{uid}
       document id, so ownership cannot be forged by writing a field) and
       shopEmployees staff. The canonical path covers staff who exist only in
       workspaceMemberships. Requiring resolveActor alone would refuse every sale
       by canonically-employed staff — a live till outage dressed as a security
       fix. */
    let _merchantProven = !!(_actor && _actor.ok);
    let _provenBy = _merchantProven ? 'shop_actor' : null;
    if (!_merchantProven) {
      let _canon = null;
      try {
        const _b = await db.collection('businesses').doc(String(merchantId)).get();
        if (_b.exists) _canon = String(merchantId);
        else {
          const _own = await _resolveMerchantIdForOwner(String(merchantId));
          if (_own && _own.ok) _canon = _own.merchantId;
        }
      } catch (_) { _canon = null; }
      if (_canon) {
        try {
          /* `sales` is the capability to transact here at all — NOT `discounts`,
             which is a strictly narrower permission. Reusing the discount
             capability would refuse ordinary cashiers, who are exactly the people
             this call exists for. */
          await _assertBusinessPermission(cashierId, _canon, 'sales');
          _merchantProven = true;
          _provenBy = 'workspace_membership';
        } catch (_) { /* not a member here, or no capability */ }
      }
    }
    if (!_merchantProven) {
      _e('You are not authorised to record a sale for this shop.', 'permission-denied');
    }

    /* ══ EVERY LINE MUST BE THIS SHOP'S PRODUCT (CHANGELOG 225) ══════════════
       The cart was priced from `products/{productId}` for ANY id the till sent — the
       product's owner was never compared to the proven merchant. A till could therefore
       "sell" another shop's product: deduct THEIR stock, bump THEIR sales counters, and
       book the revenue into this shop's sale. The owner is the product's canonical
       `shopId` (the owner's uid — the key merchantAdjustStock checks, and the one the
       till sends as `merchantId`), falling back to `sellerUid` only for older products
       that carry no shopId. Never `businesses.ownerId`: that field is client-writable. */
    const _ownerOfProduct = (p) => String((p && (p.shopId || p.sellerUid)) || '');
    productSnaps.forEach((snap) => {
      if (_ownerOfProduct(snap.data()) !== String(merchantId)) {
        _e('One of these products does not belong to this shop, so the sale was not recorded. Nothing has been charged.', 'permission-denied');
      }
    });
    /* U7a (2026-09-29): an archived / removed / moderation-blocked product is not for sale at the till either —
       the same tombstone the online checkout already refuses (functions/shared/sellability.tillBlockReason). */
    const _SELL = require('./shared/sellability');
    productSnaps.forEach((snap) => {
      if (_SELL.tillBlockReason(snap.data())) {
        _e(`${_sanitize((snap.data() || {}).name || 'An item')} is no longer for sale, so the sale was not recorded. Nothing has been charged.`, 'failed-precondition');
      }
    });

    /* ══ PACKAGES / BUNDLES (universal catalogue U5, 2026-09-29) ═════════════
       A package sold at the till takes its COMPONENTS off the shelf — the canonical products/{id}.stock — read from
       the package's own document (functions/shared/package-stock.js). A component must be THIS shop's product and not
       itself a package; otherwise the sale is refused before anything is charged. The package document carries no
       stock and is never deducted. */
    const _PSp = require('./shared/package-stock');
    const _posComp = {};
    productSnaps.forEach((snap, i) => {
      const p = snap.data() || {};
      if (_PSp.isComposite(p)) {
        _PSp.componentsForLine(p).forEach((c) => { _posComp[c.productId] = (_posComp[c.productId] || 0) + c.qty * (Number(items[i].qty) || 1); });
      }
    });
    const _posCompIds = Object.keys(_posComp);
    if (_posCompIds.length) {
      const _cs = await Promise.all(_posCompIds.map((id) => db.collection('products').doc(id).get()));
      _cs.forEach((c) => {
        if (!c.exists || _ownerOfProduct(c.data()) !== String(merchantId) || _PSp.isComposite(c.data())) {
          _e('A package in this sale contains an item that is not this shop\'s product, so the sale was not recorded. Nothing has been charged.', 'permission-denied');
        }
        if (_SELL.tillBlockReason(c.data())) {
          _e('A package in this sale contains an item that is no longer for sale, so the sale was not recorded. Nothing has been charged.', 'failed-precondition');
        }
      });
    }

    /* ══ THE COMMISSION GATE ═════════════════════════════════════════════════
       Unpaid POS/Till commission from a previous settlement day closes the till
       at 07:00 Africa/Nairobi. Enforced HERE, on the operation, and not only in
       the scheduler — a scheduler can open and close a cycle, but a merchant
       calling this callable directly would transact straight past it.

       `merchantId` is safe to gate on now, and only now, because the block above
       proved the caller belongs to it. Enforcement on an unproven id is a bypass
       wearing the appearance of a control.

       An UNREADABLE ledger is NOT an open gate: `assertGateOpen` throws rather
       than returning "owes nothing", and that throw stops the sale. Refusing to
       sell during an outage is the conservative failure; the alternative is a day
       of untracked trading that reconciliation can never recover. */
    try {
      await _posRail().assertGateOpen(db, String(merchantId), Date.now());
    } catch (gateErr) {
      if (gateErr && gateErr.code === 'POS_GATE_CLOSED') {
        _e(gateErr.message, 'failed-precondition');
      }
      _e('Your commission balance could not be checked, so this sale was not completed. ' +
         'Nothing has been charged.', 'unavailable');
    }

    /* ── manual discount: authorised, bounded, or refused ─────────────────
       A coupon is already validated above against its own document. A MANUAL
       discount has no document behind it, so the only thing that can justify
       it is the actor's role. The sale is refused rather than silently
       repriced: quietly dropping the discount would charge the customer more
       than the till just showed them, which is the same class of defect as
       quietly granting it. */
    const manualDiscount = _round2(discountTotal);
    if (manualDiscount < 0) _e('A discount cannot be negative');
    if (manualDiscount > 0) {
      /* DISCOUNT AUTHORITY — Stack A, then the canonical membership.

         `_actor.capabilities` comes from resolveActor -> shopEmployees -> ROLE_CAPABILITIES,
         where `discount` belongs to owner and manager only. That is correct and is tried
         first, unchanged, so no existing till changes behaviour.

         The canonical path is ADDITIVE, for staff who exist only in workspaceMemberships.
         It was checked rather than assumed: `discounts` in ROLE_PERMISSIONS belongs to
         owner, manager and supervisor — and NOT to cashier. So converging cannot widen
         discounting to cashiers; it adds supervisor, a role Stack A has no concept of, and
         that follows from adopting the richer model as canonical.

         The merchant is the one the sale is being written for, already bound by
         resolveActor above. Nothing here reads a merchant from the request. */
      let _discountOk = !!(_actor && _actor.ok &&
                           (_actor.capabilities || []).indexOf('discount') > -1);

      if (!_discountOk) {
        let _canonical = null;
        try {
          const _biz = await db.collection('businesses').doc(String(merchantId)).get();
          if (_biz.exists) _canonical = String(merchantId);
          else {
            const _owned = await _resolveMerchantIdForOwner(String(merchantId));
            if (_owned && _owned.ok) _canonical = _owned.merchantId;
          }
        } catch (_) { _canonical = null; }

        if (_canonical) {
          try {
            await _assertBusinessPermission(cashierId, _canonical, 'discounts');
            _discountOk = true;
          } catch (_) { /* not a member, or no capability — stays false */ }
        }
      }

      if (!_discountOk) {
        /* The message still names the actor when one was resolved, because "a cashier
           cannot give a discount" is more useful than a generic refusal. */
        _e('A ' + ((_actor && _actor.servedBy && _actor.servedBy.label) || 'staff member') +
           ' cannot give a discount. Ask an owner or manager to approve it.',
           'permission-denied');
      }
      if (manualDiscount > serverSubtotal) _e('A discount cannot exceed the sale');
    }

    /* ── U7c2 (2026-09-29): THE SHOP'S LIVE OFFERS — the same server resolver online checkout uses ───────────────
       Applied to the server-priced lines (canonical salePrice || price), so a flash sale or a meal deal prices the
       SAME at the till as online. The till SHOWS the figure shopOfferQuote returns; the device total is compared,
       never believed. An unreadable offer store refuses the sale BEFORE any charge — charging full price while the
       till showed the offer would take more than the customer agreed to. */
    const _SOp = require('./shop-offers');
    const _offQ = await _SOp.quoteShopOffers(db, { shopId: String(merchantId), lines: enrichedItems, deliveryFee: 0,
      buyerUid: (customer && customer.id) ? String(customer.id) : null });
    /* OFFLINE REPLAY (pos-v2's queue marks `metadata.offlineQueuedAt`). That sale was rung up — and the CASH taken —
       while the device could not see the shop's offers. Refusing it now would not un-take the cash: pos-v2 drops a
       queued sale on any non-network error, so the paid sale would simply vanish. The replay is therefore recorded at
       the total the customer actually paid — displayed = charged — without the offer, and the skip is written on the
       sale (offerSkipped) for audit. A replay whose device total already INCLUDES the offer is charged with it. */
    const _offlineReplay = !!(metadata && typeof metadata.offlineQueuedAt === 'number' && metadata.offlineQueuedAt <= Date.now() + 60000);
    if (_offQ.unavailable && !_offlineReplay) _e('The shop\'s offers could not be checked just now, so the sale was not recorded. Nothing has been charged.', 'failed-precondition');  /* NOT 'unavailable': tills treat that as offline and park the sale */
    let offerDiscount = _offQ.unavailable ? 0 : _round2(Math.max(0, Number(_offQ.discount) || 0));
    let offersApplied = _offQ.unavailable ? [] : (_offQ.applied || []).filter((a) => a.kind !== 'delivery')
      .map((a) => ({ id: a.id, label: a.label, type: a.type, kind: a.kind, amount: a.amount }));
    let offerSkipped = null;
    if (_offlineReplay) {
      const _base = serverSubtotal - manualDiscount - couponDiscount + (taxTotal || 0);
      if (_offQ.unavailable || (offerDiscount > 0 && Math.abs(_round2(_base - offerDiscount) - Number(grandTotal)) > 1
          && Math.abs(_round2(_base) - Number(grandTotal)) <= 1)) {
        if (offerDiscount > 0 || _offQ.unavailable) offerSkipped = 'offline_replay';
        offerDiscount = 0; offersApplied = [];
      }
    }

    const totalDiscount = _round2(manualDiscount + couponDiscount + offerDiscount);
    if (totalDiscount > serverSubtotal) _e('The discounts together exceed the sale');

    /* ── the authoritative total ───────────────────────────────────────────
       Computed from the server's OWN prices and the discount it just
       authorised. The caller's grandTotal is not used; it is only compared, so
       a till showing a different figure from the one being charged is refused
       loudly instead of charging silently. */
    const authoritativeTotal = _round2(serverSubtotal - totalDiscount + (taxTotal || 0));
    if (authoritativeTotal < 0) _e('The sale total cannot be negative');
    if (Math.abs(authoritativeTotal - Number(grandTotal)) > 1) {
      _e('Total mismatch: this device is showing ' + grandTotal +
         ' but the sale prices to ' + authoritativeTotal +
         '. Ring the sale up again.');
    }

    /* ── the tenders must cover the sale ───────────────────────────────────
       Cash may EXCEED the total — that is change, and it is computed here so
       the drawer and the receipt cannot disagree about it. Nothing else may
       exceed it, because there is no mechanism to hand back change on a card
       or an M-PESA payment. */
    const _pay = Array.isArray(payments) ? payments : [];
    for (const p of _pay) {
      const a = Number(p && p.amount);
      if (!isFinite(a) || a <= 0) _e('Every payment needs a positive amount');
    }
    const tendered = _round2(_pay.reduce((s, p) => s + Number(p.amount || 0), 0));
    if (tendered + 1 < authoritativeTotal) {
      _e('The payment of ' + tendered + ' does not cover the sale total of ' + authoritativeTotal);
    }
    const cashTendered = _round2(_pay.filter((p) => p.method === 'cash')
      .reduce((s, p) => s + Number(p.amount || 0), 0));
    const changeDue = _round2(Math.max(0, tendered - authoritativeTotal));
    if (changeDue > cashTendered + 1) {
      _e('Only a cash payment can produce change');
    }

    /* ── SOKONI POINTS (P2b) — a points tender is valid ONLY as the buyer's confirmed redemption ──────────────
       The buyer received a one-time code and read it to the cashier; the points are already HELD for this shop and
       THIS sale (its idempotency key), for an exact value, within 25% of the sale. Anything else that calls itself
       points — another name, no confirmation, another shop's or another sale's — is refused before anything is
       claimed or charged. Legacy shop-local balances (loyaltyRedeemPoints) stay refused above. */
    const _PTS_NAMES = ['points', 'sokoni_points', 'loyalty', 'loyalty_points'];
    const _ptsPays = _pay.filter((p) => _PTS_NAMES.includes(String((p && p.method) || '').toLowerCase()));
    let pointsTender = null;
    if (_ptsPays.length) {
      if (_ptsPays.length > 1) _e('Only one points payment per sale.');
      if (String(_ptsPays[0].method).toLowerCase() !== 'points') {
        _e('Points are paid only with the buyer\'s SOKONI confirmation code.', 'failed-precondition');
      }
      try {
        pointsTender = await require('./loyalty-points-spend').validateTillTender(db, {
          tender: _ptsPays[0], merchantId, idempotencyKey, saleTotal: authoritativeTotal });
      } catch (pe) { _e((pe && pe.message) || 'The points could not be confirmed.', (pe && pe.code) || 'failed-precondition'); }
    }

    /* ── non-cash money must be CONFIRMED, and spent once ──────────────────
       `posPayments/{checkoutId}` is written by darajaSTKPush and moved to
       `completed` ONLY by darajaSTKCallback — the webhook Safaricom calls after
       the buyer enters their PIN. Reading it here is what makes the difference
       between "M-PESA was selected" and "M-PESA was paid". The client cannot
       write that document, so it cannot promote its own payment.

       Cash is exempt: the cashier is physically holding it, and the drawer
       reconciliation is what audits it. Wallet is validated separately below
       and debited inside the transaction. */
    /* ── PAYMENT LABELS (convergence slice 13, 2026-09-29) ─────────────────────────────────────────────────
       Every label is a real payment path with its own evidence, or it is refused. Before this, any label this
       function did not recognise (gift_card, split, bank, qr, voucher …) completed the sale with NO evidence and was
       booked as electronic money. docs/PAYMENT_LABEL_AUTHORITY.md. */
    const _KNOWN_TENDERS = { cash: 1, mpesa: 1, card: 1, wallet: 1, points: 1, gift_card: 1 };   /* no mpesa_daraja (retired), no mpesa_till_manual (owner: IntaSend only) */
    for (const p of _pay) {
      const m = String((p && p.method) || '').toLowerCase();
      if (!_KNOWN_TENDERS[m]) {
        _e(m === 'split'
          ? 'A split payment is sent as its separate payments (cash, M-PESA, card …), each confirmed on its own.'
          : '"' + String((p && p.method) || '').slice(0, 30) + '" is not a payment SOKONI can confirm, so the sale was not recorded. Nothing has been charged.',
          'failed-precondition');
      }
    }

    /* GIFT CARD — ONE store (giftCards: shop-scoped stored value). Pre-checked here so a bad card is refused before
       anything is claimed; re-read and debited INSIDE the sale transaction below. */
    const _giftPays = _pay.filter((p) => String(p.method).toLowerCase() === 'gift_card');
    const _giftCards = [];
    for (const p of _giftPays) {
      const code = String((p && p.code) || '').replace(/[\s-]/g, '').toUpperCase();
      if (!/^[A-Z0-9]{8,32}$/.test(code)) _e('This gift card payment has no valid card code.', 'failed-precondition');
      const docId = code.match(/.{1,4}/g).join('-');
      if (_giftCards.some((g) => g.docId === docId)) _e('The same gift card cannot pay twice in one sale.');
      const gSnap = await db.collection('giftCards').doc(docId).get();
      const g = gSnap.exists ? gSnap.data() : null;
      const why = _giftCardRefusal(g, { merchantId, pin: p.pin, amount: Number(p.amount) });
      if (why) _e(why, 'failed-precondition');
      _giftCards.push({ docId, ref: db.collection('giftCards').doc(docId), amount: _round2(Number(p.amount)), pin: p.pin });
    }

    /* MANUAL M-PESA (paid straight to the merchant's own Till) is REFUSED — owner 2026-09-29: "all electronic money
       goes through IntaSend"; SOKONI never sees a manual Till payment. It is not on the allow-list above. */

    const CONFIRMABLE = { mpesa: 1, card: 1 };
    for (const p of _pay) {
      const method = String((p && p.method) || '').toLowerCase();
      if (!CONFIRMABLE[method]) continue;

      /* A PAID IntaSend payment for THIS sale (convergence slice 13): the Quick Charge / createPaymentIntent authority,
         marked paid only by the verified webhook. Bound to this shop, this sale's key and the tender amount; spent once. */
      if (p && p.intentRef) {
        const iref = String(p.intentRef);
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(iref)) _e('Unknown payment reference.', 'failed-precondition');
        const iSnap = await db.collection('paymentIntents').doc(iref).get();
        const it = iSnap.exists ? (iSnap.data() || {}) : null;
        const md = (it && it.metadata) || {};
        if (!it) _e('No ' + method.toUpperCase() + ' payment was found for this sale. Nothing has been charged.', 'not-found');
        if (it.purpose !== 'pos_till_sale') _e('That payment was not made for a till sale.', 'failed-precondition');
        if (String(md.shopId || '') !== String(merchantId)) _e('That payment belongs to a different shop.', 'permission-denied');
        if (String(md.saleId || '') !== String(idempotencyKey)) _e('That payment was made for a different sale.', 'failed-precondition');
        if (!['paid', 'completed'].includes(String(it.status))) {
          _e('The customer has not completed this payment yet (' + (it.status || 'pending') + '). Wait for their confirmation, or send the request again.', 'failed-precondition');
        }
        if (Math.round(Number(it.amount) * 100) !== Math.round(Number(p.amount) * 100)) {
          _e('The confirmed payment is ' + it.amount + ' but this sale is claiming ' + p.amount + '.');
        }
        const claimRef = db.collection('posPaymentClaims').doc(iref);
        try {
          await claimRef.create({ reference: iref, source: 'paymentIntent', method, merchantId, cashierId, idempotencyKey, amount: Number(p.amount), claimedAt: Date.now() });
          _consumed.push(iref);
        } catch (err) {
          if (err && err.code === 6) {
            const prior = (await claimRef.get()).data() || {};
            if (prior.idempotencyKey !== idempotencyKey) _e('That payment has already been used for another sale.', 'already-exists');
          } else { throw err; }
        }
        p.confirmed = true; p.confirmedAmount = Number(it.amount); p.intentRef = iref;
        if (it.paymentRef) p.gatewayRef = it.paymentRef;
        continue;
      }

      /* ALL PAYMENTS = INTASEND (owner, 2026-09-29: "no daraja everything intasend"). The legacy posPayments record in
         status 'completed' is written ONLY by the retired Daraja callback, so it no longer settles a sale: M-PESA and card
         at the till are confirmed only by a PAID IntaSend payment (intentRef, above). */
      _e('This ' + method.toUpperCase() + ' payment has no IntaSend payment reference, so it cannot be confirmed. ' +
         'Send the payment request from SOKONI and wait for the customer to pay.', 'failed-precondition');
    }

    const saleId   = uid();
    const now      = Date.now();
    const saleDate = new Date(now).toISOString().split('T')[0];

    /* ── 3b. Wallet payment pre-validation ── */
    const walletPayment = payments.find(p => p.method === 'wallet');
    let walletAmt = 0, walletTxRef = null, walletDocRef = null;
    if (walletPayment) {
      if (!customer?.id) _e('Wallet payment requires an identified customer');
      const rawAmt = Number(walletPayment.amount);
      if (!Number.isInteger(rawAmt) || rawAmt <= 0)
        _e('Wallet payment amount must be a positive whole number');
      if (rawAmt > authoritativeTotal)
        _e('Wallet payment exceeds sale total');
      if (walletPayment.customerId && walletPayment.customerId !== customer.id)
        _e('Wallet payment customerId mismatch', 'permission-denied');
      walletAmt    = rawAmt;
      walletTxRef  = db.collection('posWalletTransactions').doc(`${idempotencyKey}_wallet`);
      walletDocRef = db.collection('posWallets').doc(customer.id);
    }

    /* ── 4. Firestore transaction: wallet + inventory + loyalty ──
       Firestore requires ALL READS before ALL WRITES in a transaction. The previous version
       wrote the wallet debit and then read inventory inside the same transaction, so
       Transaction.get() threw "all reads must be executed before all writes" — every
       wallet-paid sale failed 100%. This is restructured into two phases: read everything,
       validate, then write everything. */
    const { loyaltyAwarded, custOnFile } = await db.runTransaction(async txn => {

      /* ── PHASE 1: ALL READS (parallel) ── */
      const productRefs = enrichedItems.map(item => db.collection('products').doc(item.productId));
      const custRef = customer?.id ? db.collection('posCustomers').doc(customer.id) : null;
      const progRef = customer?.id ? db.collection('loyaltyPrograms').doc(merchantId) : null;

      const [wTxSnap, wSnap, custSnap, progSnap, ...productSnaps] = await Promise.all([
        walletPayment ? txn.get(walletTxRef)  : Promise.resolve(null),
        walletPayment ? txn.get(walletDocRef) : Promise.resolve(null),
        custRef ? txn.get(custRef) : Promise.resolve(null),
        progRef ? txn.get(progRef) : Promise.resolve(null),
        ...productRefs.map(r => txn.get(r)),
      ]);
      /* U5: the package components — still the read phase, before any write */
      const _compRefs  = _posCompIds.map((id) => db.collection('products').doc(id));
      const _compSnaps = await Promise.all(_compRefs.map((r) => txn.get(r)));
      /* Gift cards (slice 13) — re-read in the read phase; debited with the sale below */
      const _gcSnaps = await Promise.all(_giftCards.map((g) => txn.get(g.ref)));
      _gcSnaps.forEach((gs, i) => {
        const why = _giftCardRefusal(gs.exists ? gs.data() : null, { merchantId, pin: _giftCards[i].pin, amount: _giftCards[i].amount });
        if (why) throw new HttpsError('failed-precondition', why + ' Nothing was charged.');
      });
      /* Points P2b: the hold and its redemption — still the read phase */
      const _PTS = pointsTender ? require('./loyalty-points-spend') : null;
      const _ptsCtx = pointsTender ? await _PTS.prepareConsumeTx(txn, db, { channel: 'till', ref: pointsTender.redemptionId }) : null;
      const _redRef = pointsTender ? db.collection(_PTS.REDEMPTIONS).doc(pointsTender.redemptionId) : null;
      const _redSnap = _redRef ? await txn.get(_redRef) : null;
      if (pointsTender && (!_redSnap.exists || _redSnap.data().status !== 'confirmed' || !_ptsCtx.hold || _ptsCtx.hold.status !== 'held')) {
        throw new HttpsError('failed-precondition', 'Those points were already spent or their confirmation lapsed. Nothing was charged.');
      }

      /* ── PHASE 2: VALIDATE (no writes yet, so a rejection touches nothing) ── */
      /* Wallet: idempotent skip if the deterministic txn doc already exists (prior attempt). */
      const doWalletDeduct = walletPayment && !wTxSnap.exists;
      if (doWalletDeduct) {
        const bal = wSnap.exists ? (wSnap.data().balance ?? 0) : -1;
        if (bal < walletAmt)
          throw new HttpsError('failed-precondition',
            `Insufficient wallet balance: has KES ${Math.max(0, bal)}, needs KES ${walletAmt}`);
      }
      /* A named customer must be THIS shop's customer (pos-customer-scope.ownsCustomer —
         the same predicate every customer read uses). The checkout used to update loyalty
         points, total spent and purchase count on ANY posCustomers id it was sent, so one
         shop could redeem or inflate another shop's customer's points (CHANGELOG 225). */
      if (custSnap && custSnap.exists && !require('./pos-customer-scope').ownsCustomer(custSnap.id, custSnap.data(), merchantId)) {
        throw new HttpsError('permission-denied', 'That customer is not a customer of this shop, so the sale was not recorded.');
      }
      /* Inventory: assert stock before deducting anything. */
      productSnaps.forEach((snap, i) => {
        const item = enrichedItems[i];
        if (!snap.exists) throw new Error(`Product ${item.productId} disappeared`);
        const prod  = snap.data();
        /* ownership re-checked on the transaction's own read (CHANGELOG 225) */
        if (_ownerOfProduct(prod) !== String(merchantId)) {
          throw new HttpsError('permission-denied', 'One of these products does not belong to this shop, so the sale was not recorded.');
        }
        /* U7a: re-checked on the transaction's own read — an archive that lands after the pre-check still wins. */
        if (_SELL.tillBlockReason(prod)) {
          throw new HttpsError('failed-precondition', `${_sanitize(prod.name || 'An item')} is no longer for sale, so the sale was not recorded.`);
        }
        /* Inventory convergence A (2026-09-30): ONE meaning of stock — shared/sellability.stockOf, the same rule online
           checkout applies. A numeric `stock` is metered (0 = sold out); NO numeric `stock` is UNMETERED (a service,
           a legacy product) and always sellable. The old `stock ?? stockQty ?? quantity ?? 9999` read legacy fields
           the online path never honoured, and its 9999 let the write below drive an absent field to -qty. */
        const _st = _SELL.stockOf(prod);
        if (_st.metered && _st.stock < (item.qty || 1) && prod.trackInventory !== false && !_PSp.isComposite(prod))
          throw new Error(`Insufficient stock for ${prod.name}`);
      });
      _compSnaps.forEach((cs, k) => {
        const id = _posCompIds[k];
        if (!cs.exists) throw new Error('An item in a package disappeared');
        const cp = cs.data();
        if (_ownerOfProduct(cp) !== String(merchantId) || _PSp.isComposite(cp)) {
          throw new HttpsError('permission-denied', 'A package in this sale contains an item that is not this shop\'s product, so the sale was not recorded.');
        }
        if (_SELL.tillBlockReason(cp)) {
          throw new HttpsError('failed-precondition', 'A package in this sale contains an item that is no longer for sale, so the sale was not recorded.');
        }
        const loose = enrichedItems.reduce((n, it) => n + (it.productId === id ? (Number(it.qty) || 1) : 0), 0);
        const _stC = _SELL.stockOf(cp);   /* same rule as a loose item: unmetered components are never short */
        if (cp.trackInventory !== false && _stC.metered && _stC.stock < _posComp[id] + loose) throw new Error(`Insufficient stock for ${cp.name} (in a package)`);
      });

      /* ── PHASE 3: ALL WRITES ── */
      if (doWalletDeduct) {
        txn.set(walletDocRef, {
          balance:   FieldValue.increment(-walletAmt),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        txn.set(walletTxRef, {
          sellerId:  merchantId,
          phone:     customer?.phone || '',
          type:      'pos_purchase',
          amount:    -walletAmt,
          saleId,
          idempotencyKey,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      const _folded = new Set();   /* U5: component units folded into a loose item's write, so each product is written once */
      productSnaps.forEach((snap, i) => {
        const item = enrichedItems[i];
        if (_PSp.isComposite(snap.data())) {
          /* the package itself: no stock of its own — only its sales counters move */
          txn.update(productRefs[i], { sold: FieldValue.increment(item.qty || 1), lastSoldAt: FieldValue.serverTimestamp(),
            totalRevenue: FieldValue.increment(item.unitPrice * (item.qty || 1)), updatedAt: FieldValue.serverTimestamp() });
          item.stockDeducted = 0;
          return;
        }
        item.stockDeducted = 0;   /* recorded on the sale line: a refund returns at most what THIS line took */
        if (snap.data().trackInventory !== false) {
          const _extra = (!_folded.has(item.productId) && _posComp[item.productId]) ? _posComp[item.productId] : 0;
          if (_extra) _folded.add(item.productId);
          /* Inventory convergence A (2026-09-30): an UNMETERED item (no numeric `stock`) keeps its sales counters but its
             stock is never created, decremented or returned — increment() on an absent field would CREATE stock: -qty. */
          const _metered = _SELL.stockOf(snap.data()).metered;
          const _upd = {
            sold:             FieldValue.increment((item.qty || 1) + _extra),
            lastSoldAt:       FieldValue.serverTimestamp(),
            totalUnitsSold:   FieldValue.increment(item.qty || 1),
            totalRevenue:     FieldValue.increment(item.unitPrice * (item.qty || 1)),
            updatedAt:        FieldValue.serverTimestamp(),
          };
          if (_metered) {
            /* Deduct the CANONICAL `stock` — the same field inventory, catalogue and dispatch
               read, so a till sale is immediately reflected everywhere. inventoryVersion bumps
               so client caches invalidate. Pre-check above guarantees stock ≥ qty. */
            _upd.stock            = FieldValue.increment(-((item.qty || 1) + _extra));
            _upd.inventoryVersion = FieldValue.increment(1);
            item.stockDeducted    = item.qty || 1;
          }
          txn.update(productRefs[i], _upd);
        }
      });

      /* U5: the components not already folded into a loose item's write */
      _compSnaps.forEach((cs, k) => {
        const id = _posCompIds[k];
        if (_folded.has(id) || cs.data().trackInventory === false) return;
        const _cUpd = { sold: FieldValue.increment(_posComp[id]), lastSoldAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
        if (_SELL.stockOf(cs.data()).metered) {   /* an unmetered component: counters only, its stock is never created */
          _cUpd.stock            = FieldValue.increment(-_posComp[id]);
          _cUpd.inventoryVersion = FieldValue.increment(1);
        }
        txn.update(_compRefs[k], _cUpd);
      });

      let loyaltyAwarded = 0;
      if (custRef && custSnap.exists) {
        const prog    = progSnap && progSnap.exists ? progSnap.data() : { points: { earnRate: 1, earnDenom: 100 } };
        const earnCfg = prog.points || { earnRate: 1, earnDenom: 100 };
        loyaltyAwarded = Math.floor((serverSubtotal / earnCfg.earnDenom) * earnCfg.earnRate);

        const cust      = custSnap.data();
        const newPoints = Math.max(0, (cust.loyaltyPoints || 0) + loyaltyAwarded - loyaltyRedeemPoints);
        txn.update(custRef, {
          loyaltyPoints:  newPoints,
          lifetimePoints: FieldValue.increment(loyaltyAwarded),
          totalSpent:     FieldValue.increment(authoritativeTotal),
          lastPurchaseAt: FieldValue.serverTimestamp(),
          purchaseCount:  FieldValue.increment(1),
        });
      }

      if (couponCode) {
        const cpRef  = db.collection('coupons').doc(couponCode.trim().toUpperCase());
        const update = { usageCount: FieldValue.increment(1) };
        if (customer?.id) update[`customerUses.${customer.id}`] = FieldValue.increment(1);
        txn.update(cpRef, update);
      }

      /* Gift cards (slice 13): debited WITH the sale, atomically */
      _giftCards.forEach((g, i) => {
        const cur = Number(_gcSnaps[i].data().balance) || 0;
        const nb = _round2(cur - g.amount);
        txn.update(g.ref, { balance: nb, status: nb <= 0 ? 'redeemed' : 'active', updatedAt: FieldValue.serverTimestamp(),
          redemptions: FieldValue.arrayUnion({ amount: g.amount, saleKey: String(idempotencyKey), by: cashierId, at: new Date().toISOString() }) });
      });
      /* Points P2b: spent WITH the sale, exactly once */
      if (pointsTender) {
        _PTS.consumeHoldTx(txn, db, _ptsCtx, { channel: 'till', ref: pointsTender.redemptionId, saleRef: saleId, orderId: saleId });
        txn.update(_redRef, { status: 'consumed', saleId, consumedAtMs: Date.now() });
      }

      /* Smart Customer Search: the attached customer is named on the sale from the shop's OWN record (the till only
         ever holds a masked phone) — never from what the caller typed */
      const custOnFile = custSnap && custSnap.exists ? { name: String(custSnap.data().name || ''), phone: String(custSnap.data().phoneKey || custSnap.data().phone || '') } : null;
      return { loyaltyAwarded, custOnFile };
    });

    /* ══════════════════════════════════════════════════════════════════════
       4b. THE FINANCIAL TRACE — tax, commission, and a balanced ledger entry
       ══════════════════════════════════════════════════════════════════════
       Before this, a till sale wrote posRetailSales, posDaily and posReceipts
       and STOPPED. No commission, no ledger entry, no tax computation. The
       commission writer (payment-success.onPaymentSucceeded) watches
       `payments/{id}` — the IntaSend collection — while POS writes
       `posPayments`, so a till sale reached NO financial path at all. Every
       downstream product built on it — billing, settlement, the tax pack —
       was reading records nobody wrote.

       COMPOSED, NOT REINVENTED: the VAT figures come from etims-tax-engine and
       the rate from finos-utils.calculateCommission, the same authorities the
       marketplace uses. A second set of tax or commission maths would be a
       second set of numbers.

       WHAT THIS DELIBERATELY DOES NOT DO: it does not call
       settlement-engine.computeSettlement(). That function assumes "100% of
       every customer payment is collected into the Bravilex account first",
       which is FALSE for a till — the cash is in the merchant's drawer and a
       DIRECT_TO_SELLER M-Pesa payment went to the merchant's own shortcode.
       Posting a till sale as a settlement out of platform clearing would invent
       platform cash and create seller liabilities with nothing behind them,
       which is exactly the defect payment-config.js:41-55 warns about.
       On a till sale SOKONI's commission is a RECEIVABLE: the seller already
       holds the money and owes us a share. */
    const financial = await _postSaleFinancials({
      saleId, merchantId, cashierId, idempotencyKey,
      items: saleLines,
      subtotal: serverSubtotal,
      discount: totalDiscount,
      total: authoritativeTotal,
      pointsKES: pointsTender ? pointsTender.kes : 0,     /* Points P2b: shop-funded, not money */
      payments: _pay,
      /* So the drawer figure can be recorded NET of what was handed back. */
      changeDue: changeDue,
    });

    /* ── 4b. Derive the authoritative open shift ──────────────────────────
       `shiftId` arrived in the request body and was only sanitized, so a caller
       could attach a sale to another cashier's shift, or to one already closed.
       Both inputs to this query are already server-bound: `merchantId` is enforced
       by resolveActor above (the sale is refused when !_actor.ok), and `cashierId`
       is auth.uid. This is the SAME query openShift and getCurrentShift use, against
       posShifts — it introduces no second shift authority.

       Having no open shift is a legitimate state: a till can sell without one. The
       result is therefore null, never a fabricated id and never the caller's claim. */
    let resolvedShiftId = null;
    try {
      const _shiftSnap = await db.collection('posShifts')
        .where('sellerId', '==', merchantId)
        .where('cashierUid', '==', cashierId)
        .where('status', '==', 'open')
        .limit(1)
        .get();
      resolvedShiftId = _shiftSnap.empty ? null : _shiftSnap.docs[0].id;
    } catch (err) {
      /* A shift lookup must never fail a sale the customer has already paid for.
         Record nothing rather than guess: an unattributed sale is recoverable,
         a misattributed one is not. */
      console.error('[posCompleteCheckout] shift resolution failed:', err && err.message);
      resolvedShiftId = null;
    }
    if (shiftId && shiftId !== resolvedShiftId) {
      /* Security signal, not an error: the caller named a shift that is not their
         open one. The sale proceeds against the authoritative value. */
      console.warn('[posCompleteCheckout] client shiftId ignored — claimed=' +
        String(shiftId).slice(0, 64) + ' authoritative=' + String(resolvedShiftId));
    }

    /* ── 5. Write sale record ── */
    const sale = {
      /* CALLER-SUPPLIED, AND FIRST. `metadata` is client data spread into the sale
         document. It used to be spread LAST, which meant a caller could send
         { metadata: { grandTotal: 1 } } and overwrite the figure the server had
         just computed — silently, after every authority check had passed.
         Spreading it first makes every authoritative field below win. */
      ...metadata,

      id:              saleId,
      merchantId:      _sanitize(merchantId),
      /* sellerId IS the read key. The served rule authorises a read with
         `resource.data.sellerId == request.auth.uid`, and this writer only ever set
         `merchantId` — so a shop owner could not read their own POS sales at all, and
         POS sales were invisible to every non-admin surface. The mirror writer
         (pos-retail-mirror-map.js) already writes BOTH under the same convention and
         says so; this brings the primary writer into line with it rather than
         inventing a third spelling.

         IT IS WRITTEN AFTER `...metadata` — like every field here — so a caller cannot
         supply its own `sellerId` through metadata and choose who may read the sale.
         Before this, `sellerId` was a name nothing wrote, which made it exactly the
         kind of gap caller-supplied metadata could fill. */
      sellerId:        _sanitize(merchantId),
      branchId:        _sanitize(branchId),
      cashierId:       _sanitize(cashierId),
      /* SERVER-DERIVED (4b). Never the caller's claim. */
      shiftId:         resolvedShiftId,
      items:           saleLines,
      customer:        customer ? {
        id:    _sanitize(customer.id || ''),
        name:  _sanitize((custOnFile && custOnFile.name) || customer.name || 'Guest'),
        phone: _sanitize(custOnFile ? custOnFile.phone : (customer.phone || '')),
      } : null,
      payments,
      couponCode:         couponCode ? _sanitize(couponCode) : null,
      couponDiscount,
      offerDiscount,              /* U7c2: the shop's offers, server-applied */
      offersApplied,
      ...(offerSkipped ? { offerSkipped } : {}),
      loyaltyRedeemed:    loyaltyRedeemPoints,
      loyaltyAwarded,
      ...(pointsTender ? { pointsRedeemed: { points: pointsTender.points, kes: pointsTender.kes, redemptionId: pointsTender.redemptionId,
        fundingShopId: String(merchantId) }, amountPaidInMoney: _round2(authoritativeTotal - pointsTender.kes) } : {}),
      subtotal:           serverSubtotal,
      discountTotal:      totalDiscount,
      taxTotal,
      grandTotal:         authoritativeTotal,
      status:             'completed',
      createdAt:          FieldValue.serverTimestamp(),
      saleDate,
      idempotencyKey:     _sanitize(idempotencyKey),

      /* ── THE FINANCIAL TRACE, carried on the sale itself ─────────────────
         Stored here so the sale is self-describing: the tax pack, billing and
         reconciliation all read one record rather than re-deriving figures from
         line items months later and getting a different answer.
         `financialPosting` is the honest status of the bookkeeping — 'posted',
         or 'failed' with a reason and a row in posFinancialRepair. A sale whose
         books did not land is findable instead of invisible. */
      tax:                financial.tax,
      commission:         financial.commission,
      /* WHERE the money is, per sale: drawer vs provider, split by method. */
      position:           financial.position,
      collectionRoute:    financial.collectionRoute,
      /* HOW the merchant was proven for this sale — shop_actor (owner/shopEmployees) or
         workspace_membership. Recorded so an audit can tell which authority admitted the
         sale, rather than inferring it from a role months later. */
      merchantProvenBy:   _provenBy,
      financialPosting:   financial.status,
      financialError:     financial.error || null,

    };

    await db.collection('posRetailSales').doc(saleId).set(sale);

    /* ── 5b. THE COMMISSION LIABILITY ────────────────────────────────────────
       The gate above is only as good as what it reads. Nothing was writing the
       liability rows it evaluates, so every merchant looked permanently clear and
       the 07:00 gate could never close on anyone. A gate over an empty ledger is
       not a control, it is a decoration.

       AFTER the sale is written, deliberately. A liability recorded for a sale
       that then failed to write would bill a merchant for money they never took;
       this order can only fail the other way — a completed sale whose liability
       write failed — which is recoverable by reconciliation from posRetailSales
       and is visible in the error log. Charging for a sale that did not happen is
       not recoverable, because nobody knows to look.

       IDEMPOTENT ON THE SALE ID, so the retry paths above converge on one row
       instead of billing twice. CUSTODIAL rails write nothing: their commission
       already came out of money SOKONI was holding, and billing it again at 07:00
       would look like diligence.

       Best-effort by design: a failure here is logged and does NOT fail a sale the
       customer has already paid for. The gate is what makes it collectible; losing
       one row delays collection, whereas throwing here would reject a completed
       transaction at the counter. */
    try {
      const _rail = _posRail();
      const _P = require('./pos-sale-commission');
      const _MA = require('./money-authority');
      /* CUSTODY comes from `collectionRoute`, which this sale already computed — not from a
         second reading of the tenders. Custody is the question "who is holding this money",
         and the route is the system's existing answer to it:

           CASH_IN_DRAWER    the merchant has the notes            -> owed
           DIRECT_TO_SELLER  paid to the merchant's own till       -> owed
           CENTRAL_MOR       SOKONI collected it                   -> already netted

         Deriving it again from `payments` would be a second authority on the same fact, and
         the two would eventually disagree — which is how a sale gets billed twice or not at
         all. */
      const _railKey = _posRailKeyFor(financial && financial.collectionRoute);
      const _rec = _P.planSaleCommission({
        rail:        _railKey,
        gross:       _MA.fromMinor(Math.round(authoritativeTotal * 100)),
        /* NULL, deliberately. POS/Till is a FLAT 5% on every plan (owner ruling), so the
           plan cannot change the rate — and resolving one here would cost a read per sale to
           record a value that changes nothing. Passing null makes `resolvePosRate` return
           `matched: false`, which honestly records "no plan was resolved" rather than
           stamping a plan nobody verified. */
        planId:      null,
        soldAtMs:    Date.now(),
        saleId:      String(saleId),
        merchantUid: String(merchantId),
      });
      await _rail.recordSaleLiability(db, _rec);
    } catch (commErr) {
      console.error('[posCompleteCheckout] commission liability not recorded', {
        saleId, merchantId, error: commErr && commErr.message,
      });
    }

    /* ── 6. Daily counter aggregation ──
       These increments run exactly once per idempotencyKey: the atomic create() claim at the
       top of this function admits a single caller per key, a retry of a 'complete' key returns
       cached before reaching here, and a retry of a 'processing' key is rejected before reaching
       here. So the counter cannot double on retry. (@financial-safe: guarded by the atomic
       idempotency claim above.) */
    const dailyRef = db.collection('posDailySummary').doc(`${merchantId}_${saleDate}`);
    await dailyRef.set({
      merchantId, branchId, saleDate,
      totalSales:    FieldValue.increment(1),
      totalRevenue:  FieldValue.increment(authoritativeTotal),
      totalItems:    FieldValue.increment(items.reduce((s, i) => s + (i.qty || 1), 0)),
      totalDiscount: FieldValue.increment(totalDiscount),
      totalTax:      FieldValue.increment(taxTotal),

      /* ── WHERE THE MONEY IS ────────────────────────────────────────────────
         `totalRevenue` above says how much was SOLD. These say where it went,
         and they are the only figures a merchant can actually reconcile:
         count the drawer against cashCents, check the provider against
         electronicCents. One merged total could never be checked against
         anything, because it mixes money that entered the drawer with money
         that never did.
         cashCents is NET of change; byMethod.cash is the gross tendered. */
      cashCents:       FieldValue.increment((financial.position && financial.position.cashCents) || 0),
      electronicCents: FieldValue.increment((financial.position && financial.position.electronicCents) || 0),
      changeGivenCents: FieldValue.increment((financial.position && financial.position.changeGivenCents) || 0),
      byMethod:        _methodIncrements(financial.position),

      /* Commission accrued today, and the tax SOKONI estimated — the latter in
         cents from the tax engine, NOT the caller-supplied `taxTotal` that
         `totalTax` above still carries for backward compatibility. */
      commissionCents: FieldValue.increment((financial.commission && financial.commission.amountCents) || 0),
      totalTaxCents:   FieldValue.increment((financial.tax && financial.tax.vatCents) || 0),

      updatedAt:     FieldValue.serverTimestamp(),
    }, { merge: true });

    /* ── 7. Queue metric (for cashier speed analytics) ── */
    if (metadata.checkoutStartedAt) {
      const elapsed = now - metadata.checkoutStartedAt;
      await db.collection('posCheckoutMetrics').add({
        merchantId, branchId, cashierId, saleId,
        itemCount:     items.reduce((s, i) => s + (i.qty || 1), 0),
        durationMs:    elapsed,
        grandTotal:   authoritativeTotal,
        /* EVERY method, not the first. `payments[0].method` filed a 4,000 M-Pesa
           + 2,000 cash sale entirely under whichever tender happened to be first
           in the array, so split sales were silently misattributed in every
           report built on this. `paymentMethod` is kept as the single-tender
           answer for existing readers, and is 'mixed' when it genuinely is. */
        paymentMethod: (_pay.length === 1 ? String(_pay[0].method) : 'mixed'),
        paymentMethods: _pay.map((p) => String(p.method)),
        createdAt:     FieldValue.serverTimestamp(),
        saleDate,
      });
    }

    /* ── 8. Build receipt ── */
    const receipt = {
      receiptNo:  saleId.slice(-8).toUpperCase(),
      saleId,
      merchantId,
      items:      saleLines,
      subtotal:   serverSubtotal,
      discount:   totalDiscount,
      offersApplied: offersApplied.map((o) => ({ label: o.label, amount: o.amount })),   /* U7c2: named on the receipt */
      tax:        taxTotal,
      total:      authoritativeTotal,
      payments,
      loyaltyAwarded,
      loyaltyRedeemed: loyaltyRedeemPoints,
      /* Points P2b: the receipt says what points paid and what money paid */
      ...(pointsTender ? { pointsRedeemed: { points: pointsTender.points, kes: pointsTender.kes },
        paidInMoney: _round2(authoritativeTotal - pointsTender.kes) } : {}),
      customer:   customer?.name || 'Guest',
      cashier:    cashierId,
      timestamp:  new Date(now).toISOString(),

      /* ── What the customer actually handed over, and what went back ──────
         Recorded on the receipt because a cash receipt that shows only the total
         cannot be checked by the person holding the change. `amountPaid` is what
         was tendered (3,000), `total` is what the sale was (2,800), `changeDue`
         is the difference the drawer gave back (200). */
      amountPaid: tendered,
      changeDue:  changeDue,

      /* ── SERVED BY, resolved by the SERVER ───────────────────────────────
         From merchant-identity's employment records — never from anything the
         client sent. A cashier cannot put "Alex / Manager" on a financial
         document by typing it. When the employment cannot be resolved this is
         null and the printed receipt omits the line entirely, rather than
         naming the wrong person or silently crediting the shop owner. */
      servedBy: (_actor && _actor.ok && _actor.servedBy) ? {
        uid:        _actor.servedBy.uid,
        name:       _actor.servedBy.name,
        role:       _actor.servedBy.role,
        label:      _actor.servedBy.label,
        /* Present only when the employment relationship actually carries one.
           TODAY IT DOES NOT: shopEmployees has no employee-number field, and the
           `employeeNumber` that exists in hr-payroll belongs to a separate staff
           registry keyed {merchantId}_{employeeNumber} that POS identity is not
           joined to. So this is null and the receipt omits the line — which is the
           correct output for "the employment relationship does not provide one",
           not a placeholder pretending to be wired. Joining the two registries is
           the multi-shop employment slice, not this one. */
        employeeNo: _actor.servedBy.employeeNo || null,
      } : null,
    };

    await db.collection('posReceipts').doc(saleId).set({ ...receipt, createdAt: FieldValue.serverTimestamp() });

    /* ── 9. Mark idempotency complete ── */
    /* U7c2: one redemption row per (sale, offer) — create() makes a retried completion a no-op */
    if (offersApplied.length) {
      await _SOp.recordRedemptionsForOrder(db, { orderId: saleId, shopId: String(merchantId), buyerUid: (customer && customer.id) ? String(customer.id) : null,
        applied: offersApplied, source: 'till' }).catch((e) => console.error('[posCompleteCheckout] offer redemption record failed:', e && e.message));
    }
    /* ── Points P1 (2026-09-29): SOKONI-wide points for the buyer the cashier identified by phone ──────────────
       1 point per KES 10 of the AUTHORITATIVE total, credited by the server after the sale is recorded — the phone only
       says WHO; the amount is never the device's. A points problem (unknown number, blocked account) never undoes a
       completed sale: it is reported on the receipt instead. Idempotent per sale (earn__till__{saleId}). */
    let pointsEarned = null;
    /* Step 2 (2026-09-30): the buyer is the one the cashier identified for points, or else the CUSTOMER ATTACHED to this
       sale — the phone on the shop's own record (custOnFile), never a typed number. No SOKONI account on it → no points. */
    const _earnPhone = buyerPhone || (custOnFile && custOnFile.phone) || null;
    if (_earnPhone) {
      try {
        const _earn = await require('./loyalty-points').earnForSale(db, { buyerPhone: String(_earnPhone), issuerShopId: String(merchantId),
          saleId, amountKES: _round2(authoritativeTotal - (pointsTender ? pointsTender.kes : 0)), source: 'till',   /* P2b: not on points */ shopName: receipt.merchantName || receipt.shopName || null });
        pointsEarned = _earn && _earn.ok ? { points: _earn.points || 0, balance: _earn.balance == null ? null : _earn.balance }
                                         : { points: 0, reason: (_earn && _earn.reason) || 'not-credited' };
      } catch (pe) {
        console.error('[posCompleteCheckout] points earn failed:', pe && pe.message);
        pointsEarned = { points: 0, reason: 'not-credited' };
      }
      receipt.pointsEarned = pointsEarned;
      await db.collection('posReceipts').doc(saleId).set({ pointsEarned }, { merge: true }).catch(() => {});
    }
    await idemRef.update({ status: 'complete', saleId, receipt, completedAt: now });

    return { saleId, receipt, loyaltyAwarded, pointsEarned };

  } catch (err) {
    /* RELEASE any confirmed payment this attempt claimed. The money is still the
       customer's — the sale simply did not complete — and leaving the claim in
       place would make their genuinely paid M-PESA unusable on the retry, which
       is a worse outcome than the failure itself. Released before the failure is
       recorded, so a crash between the two leaves the claim rather than losing it. */
    for (const ref of _consumed) {
      try { await db.collection('posPaymentClaims').doc(ref).delete(); } catch (_) {}
    }
    await idemRef.update({ status: 'failed', error: err.message, failedAt: Date.now() });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', err.message || 'Checkout failed');
  }
});

/* ════════════════════════════════════════════════════════════════
   posValidateCoupon — server-side coupon check before checkout
════════════════════════════════════════════════════════════════ */
exports.posValidateCoupon = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { code, merchantId, subtotal = 0, customerId } = data || {};
  if (!code) _e('code required');

  const cpSnap = await db.collection('coupons').doc(code.trim().toUpperCase()).get();
  if (!cpSnap.exists) return { valid: false, error: 'Coupon not found' };
  const cp = cpSnap.data();

  if (!cp.active) return { valid: false, error: 'Coupon is inactive' };
  if (cp.merchantId && cp.merchantId !== merchantId) return { valid: false, error: 'Not valid for this store' };
  if (cp.expiresAt?.toMillis && cp.expiresAt.toMillis() < Date.now()) return { valid: false, error: 'Coupon has expired' };
  if (cp.usageLimit && (cp.usageCount || 0) >= cp.usageLimit) return { valid: false, error: 'Usage limit reached' };
  if (cp.minPurchase && subtotal < cp.minPurchase) return { valid: false, error: `Minimum purchase KES ${cp.minPurchase} required` };
  if (customerId && cp.perCustomerLimit) {
    const uses = (cp.customerUses || {})[customerId] || 0;
    if (uses >= cp.perCustomerLimit) return { valid: false, error: 'Already used this coupon' };
  }

  const discountAmount = cp.type === 'percent'
    ? Math.min(subtotal * cp.value / 100, cp.maxDiscount || subtotal)
    : Math.min(cp.value || 0, subtotal);

  return {
    valid: true,
    code: code.trim().toUpperCase(),
    type: cp.type,
    discountAmount: Math.round(discountAmount * 100) / 100,
    description: cp.description || `${cp.value}${cp.type === 'percent' ? '%' : ' KES'} off`,
  };
});

/* ════════════════════════════════════════════════════════════════
   posLookupCustomer — multi-method: phone, QR code, member ID, email
════════════════════════════════════════════════════════════════ */
/* Every lookup is scoped to the CALLER'S customers.

   This function previously searched `posCustomers` collection-wide by phone,
   document id, email or member-card code with no merchant filter at all, and
   returned the customer's name, email, phone, loyalty points, tier, total spent
   and purchase count. Any signed-in account could look up any customer on the
   platform by phone number — and a phone number is guessable, so it was
   enumerable cross-tenant PII disclosure.

   The owner comes from AUTH (see pos-customer-scope.js) and is part of every
   query rather than a filter applied afterwards. A miss returns exactly
   `{ found: false }` — "exists, but not yours" is itself an existence disclosure.

   RESTORED 2026-09-29, verbatim from 9360cbd: commit 2f4fc20 (a durability commit of 296 uncommitted files) put
   the unscoped version back; scripts/test-pos-customer-scope.js had been failing 18 checks since. */
const _custScope = require('./pos-customer-scope');

/* ══ SMART CUSTOMER SEARCH (2026-09-30) — posCustomers (the one customer authority), scoped to the SHOP the sale is
   for, this shop's till staff only (the same gate as the points lookup). docs/SMART_CUSTOMER_SEARCH.md */
async function _customerShopGate(auth, data) {
  const shopId = String((data && data.shopId) || '');
  await require('./loyalty-points').assertTillStaff(auth && auth.uid, shopId);
  return shopId;
}
exports.posCustomerSearch = onCall(cfg, async ({ data, auth }) => {
  const shopId = await _customerShopGate(auth, data);
  return _custScope.searchOwned(db, shopId, data && data.q);
});
exports.posCustomerSave = onCall(cfg, async ({ data, auth }) => {
  const shopId = await _customerShopGate(auth, data);
  return _custScope.saveOwned(db, shopId, { phone: data && data.phone, name: data && data.name, by: auth.uid });
});
exports.posCustomerCard = onCall(cfg, async ({ data, auth }) => {
  const shopId = await _customerShopGate(auth, data);
  const snap = await _custScope.getOwned(db, shopId, String((data && data.customerId) || ''));
  if (!snap) _e('That customer is not a customer of this shop.', 'not-found');
  const card = _custScope.cardOf(snap);
  /* SOKONI points for this number — the canonical balance, never a figure from the shop's own records */
  /* 'member' (with the balance) · 'none' (no SOKONI account on this number) · 'unavailable' (could not be read — the
     till shows "—", never a 0 it does not know) */
  let sokoniPoints = null, sokoni = 'unavailable';
  try {
    const key = snap.data().phoneKey || _custScope.phoneKey(snap.data().phone);
    const b = key ? await require('./loyalty-points').resolveBuyer(db, key) : null;
    if (!b) sokoni = 'none';
    else { const a = await db.collection('loyaltyAccounts').doc(b.uid).get(); if (a.exists) { sokoniPoints = Number(a.data().balance) || 0; sokoni = 'member'; } else sokoni = 'none'; }
  } catch (_) { sokoniPoints = null; sokoni = 'unavailable'; }
  return Object.assign(card, { sokoniPoints, sokoni });
});

exports.posLookupCustomer = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { query, method = 'auto', merchantId } = data || {};
  if (!query) _e('query required');

  const owner = _custScope.resolveOwner(auth, data && data.sellerId);
  const q     = String(query).trim();
  let doc     = null;

  if (method === 'phone' || method === 'auto') {
    const phone = q.replace(/\s/g, '').replace(/^0/, '+254');
    doc = await _custScope.findOwned(db, owner, 'phone', phone);
    if (!doc) doc = await _custScope.findOwned(db, owner, 'phone', q);
  }

  if (!doc && (method === 'id' || method === 'auto')) {
    doc = await _custScope.getOwned(db, owner, q);
  }

  if (!doc && (method === 'email' || method === 'auto')) {
    doc = await _custScope.findOwned(db, owner, 'email', q.toLowerCase());
  }

  if (!doc && (method === 'memberCard' || method === 'auto')) {
    doc = await _custScope.findOwned(db, owner, 'memberCardCode', q.toUpperCase());
  }

  if (!doc) return { found: false };

  const cust = doc.data();

  /* Fetch loyalty info if merchantId provided */
  let loyalty = null;
  if (merchantId) {
    const progSnap = await db.collection('loyaltyPrograms').doc(merchantId).get();
    const prog     = progSnap.exists ? progSnap.data() : null;
    if (prog) {
      const pointValue = prog.points?.pointValue || 0.5;
      loyalty = {
        points:      cust.loyaltyPoints || 0,
        pointsValue: Math.round((cust.loyaltyPoints || 0) * pointValue * 100) / 100,
        tier:        cust.tier || 'bronze',
        totalSpent:  cust.totalSpent || 0,
        purchaseCount: cust.purchaseCount || 0,
      };
    }
  }

  return {
    found:   true,
    id:      doc.id,
    name:    cust.name || 'Customer',
    phone:   cust.phone || '',
    email:   cust.email || '',
    tier:    cust.tier || 'bronze',
    loyalty,
  };
});

/* ════════════════════════════════════════════════════════════════
   posProcessRefund — refund with inventory return
════════════════════════════════════════════════════════════════ */
/* REFUND AUTHORITY — canonical membership, with posStaff as a compatibility surface.

   WHAT THIS USED TO BE: a posRole claim of manager|owner, then EITHER ownership of
   businesses/{merchantId} OR any active posStaff row for it. posStaff membership alone
   authorised a refund — there was no capability check at all.

   THREE THINGS THE MAP ESTABLISHED, and each shapes what follows:

   1. THE ROLE SETS DIFFER FROM VOID. Refund requires manager|owner; void also allows
      supervisor. That is existing product behaviour, not an accident to normalise away, so
      the role gate is left exactly as it was.

   2. `refunds` IS HELD BY CASHIER in ROLE_PERMISSIONS, so the capability alone would widen
      authority to every cashier. Authority is therefore the CONJUNCTION of the existing role
      claim and the canonical capability — the same shape the void convergence uses.

   3. THE MERCHANT ARRIVES IN EITHER TENANT SPACE. Checkout validates its merchantId against
      shops/{uid} (owner-uid space) while workspaceMemberships is keyed by the generated
      merchantId. So the value is recognised in both forms and resolved forward, exactly as
      _requireSeller does — recognised, never trusted.

   posStaff remains a fallback because the convergence decision names it a COMPATIBILITY
   SURFACE: removing it here would strip refund authority from staff who exist only in that
   store. It is tried last and is not the authority. */
async function _assertRefundAuthority(auth, merchantId) {
  if (!auth?.uid) _e('Authentication required', 'unauthenticated');
  const uidStr = auth.uid;

  const role = auth.token?.posRole || 'cashier';
  const isAdmin = auth.token?.admin === true || auth.token?.superAdmin === true;
  if (!isAdmin && role !== 'manager' && role !== 'owner') {
    _e('Refunds require a manager or owner', 'permission-denied');
  }
  if (isAdmin) return uidStr;

  const mid = String(merchantId);
  const bizSnap = await db.collection('businesses').doc(mid).get();

  /* OWNER, in either space: the businesses document, or the owner-uid form. */
  if (bizSnap.exists && (bizSnap.data() || {}).ownerId === uidStr) return uidStr;
  if (mid === uidStr) return uidStr;

  /* CANONICAL EMPLOYEE AUTHORITY. Resolve the merchant forward when the caller named the
     owner-uid form, then require the capability — membership alone is not authority. */
  let canonical = mid;
  if (!bizSnap.exists) {
    const owned = await _resolveMerchantIdForOwner(mid);
    if (owned && owned.ok) canonical = owned.merchantId;
  }
  try {
    await _assertBusinessPermission(uidStr, canonical, 'refunds');
    return uidStr;
  } catch (_) { /* fall through to the compatibility surface */ }

  /* COMPATIBILITY SURFACE. posStaff is not the authority; it is read so staff who exist only
     there keep working until the employee migration lands. It carries no capability model, so
     the role gate above is the only thing narrowing it — as it always was. */
  const staffSnap = await db.collection('posStaff')
    .where('merchantId', '==', mid)
    .where('uid', '==', uidStr)
    .where('status', '==', 'active')
    .limit(1).get();
  if (!staffSnap.empty) return uidStr;

  _e('You do not belong to this merchant', 'permission-denied');
}

exports.posProcessRefund = onCall(cfgHeavy, async ({ data, auth }) => {
  const { saleId, items, reason, refundMethod = 'cash', merchantId, idempotencyKey } = data || {};
  if (!saleId)        _e('saleId required');
  if (!items?.length) _e('items required');
  if (!reason)        _e('reason required');
  if (!merchantId)    _e('merchantId required');

  const managerId = await _assertRefundAuthority(auth, merchantId);

  const saleRef  = db.collection('posRetailSales').doc(saleId);
  const saleSnap = await saleRef.get();
  if (!saleSnap.exists) _e('Sale not found', 'not-found');
  const sale = saleSnap.data();
  if (sale.merchantId !== merchantId) _e('Unauthorized', 'permission-denied');
  if (sale.status === 'refunded') _e('Sale already fully refunded');

  /* ── MANAGER APPROVAL — the first mutation that actually SPENDS one ──────────────────
     `_consumeApproval` (pos-staff-ops.js) has been complete for weeks — transactional,
     replay-safe, binding-checked — and had ZERO call sites. Its own comment said so:
     "NOTHING CONSUMES ONE YET... manager approval is not enforceable end-to-end until they
     do." So the Sales Control Centre could show a manager approving a refund, record the
     decision, and authorise nothing: the refund proceeded on `_assertRefundAuthority` alone
     whether or not anyone had approved it. An approval that gates nothing is theatre.

     OPTIONAL, DELIBERATELY. Refund authority is unchanged: a manager or owner may still
     refund directly, exactly as before. What changes is that when an approval IS presented,
     it is now VERIFIED and SPENT rather than decorative — so a shop that wants two-person
     control can have it, and no existing caller breaks. Making it mandatory is a policy
     decision with a live blast radius, and it is not made here.

     CONSUMED BEFORE THE REFUND IS WRITTEN. The other order refunds first and then tries to
     spend the approval, so a failure between the two leaves money returned on an
     authorisation nobody verified. This order fails the safe way: a burned approval on a
     refund that did not happen, which a manager can simply re-approve. Money is never moved
     on an unverified approval.

     BOUND TO THIS SALE AND THIS AMOUNT. `_consumeApproval` re-checks both against what the
     manager actually saw, so an approval for a KES 200 refund cannot be spent on a KES 2,000
     one, and an approval for another sale cannot be spent here at all. */
  let approvalReceipt = null;
  if (data && data.approvalId) {
    /* The amount is derived from the ORIGINAL sale, never from the caller — a client-supplied
       total would let the requester choose what the manager appears to have approved. The
       refund transaction recomputes it below from the same source and must agree. */
    let expectedTotal = 0;
    for (const refItem of items) {
      const orig = (sale.items || []).find((i) => i.productId === refItem.productId);
      if (!orig) _e('Item ' + refItem.productId + ' not in original sale');
      const qty = Number(refItem.qty);
      if (!Number.isFinite(qty) || qty <= 0) _e('Refund qty must be positive');
      if (qty > orig.qty) _e('Cannot refund more than sold');
      expectedTotal += orig.unitPrice * qty;
    }
    expectedTotal = Math.round(expectedTotal * 100) / 100;

    const { consume } = require('./pos-staff-ops')._approvals;
    approvalReceipt = await consume(String(data.approvalId), {
      sellerId:    String(merchantId),
      type:        'refund',
      binding:     { saleId: String(saleId), amount: expectedTotal },
      consumerUid: managerId,
    });
  }

  /* IDEMPOTENCY: refundId used to be a random id, so a double-tapped "Refund" created TWO
     refund records and returned the stock TWICE. Derive it from the caller's key (falling back
     to the saleId, since a sale can only be fully refunded once) and short-circuit inside the
     transaction if it already exists. */
  const rawKey   = String(idempotencyKey || saleId || '');
  const refundId = 'rf_' + rawKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  const refundRef = db.collection('posRefunds').doc(refundId);

  let refundTotal = 0, listValue = 0, refundRatio = 1, pointsKESShare = 0, pointsOutcome = null;
  const alreadyDone = await db.runTransaction(async txn => {
    /* ── ALL READS FIRST ──
       The original read each product INSIDE the write loop (txn.get after txn.update), which
       Firestore rejects — every multi-item refund threw at runtime. */
    const prodRefs = items.map(it => db.collection('products').doc(it.productId));   /* canonical — symmetric with sale deduction */
    const [refundSnap, ...prodSnaps] = await Promise.all([
      txn.get(refundRef),
      ...prodRefs.map(r => txn.get(r)),
    ]);
    /* Refunds × points (2026-09-29): the sale's points rows — still the read phase */
    const _PR = require('./loyalty-points-spend');
    const _ptsCtx = refundSnap.exists ? null : await _PR.preparePointsRefundTx(txn, db, { orderId: String(saleId), refundKey: refundId });

    if (refundSnap.exists) return true;            // idempotent replay — change nothing

    refundTotal = 0;
    /* Validate against the original sale BEFORE writing anything. */
    const plan = items.map((refItem, idx) => {
      const orig = sale.items.find(i => i.productId === refItem.productId);
      if (!orig) throw new Error('Item ' + refItem.productId + ' not in original sale');
      const qty = Number(refItem.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('Refund qty must be positive');
      if (qty > orig.qty) throw new Error('Cannot refund more than sold');
      refundTotal += orig.unitPrice * qty;
      return { qty, orig, snap: prodSnaps[idx], ref: prodRefs[idx] };
    });

    /* WHAT WAS ACTUALLY PAID for these lines (2026-09-29). The refund used to be `unitPrice × qty` — the LIST price —
       so a sale discounted by a shop offer, a coupon or a manual discount refunded more than the customer paid (a KES
       67,500 offer sale refunded 75,000), and a sale paid partly with SOKONI points repaid that part in cash. Now the
       lines' share of the sale (their list value over the sale's subtotal) is applied to what the customer actually
       paid: MONEY for the money-paid part, and the spent POINTS given back as points (below). */
    listValue = Math.round(refundTotal * 100) / 100;
    const _sub = Number(sale.subtotal) || 0, _grand = Number(sale.grandTotal) || 0;
    const _ptsKES = (sale.pointsRedeemed && Number(sale.pointsRedeemed.kes)) || 0;
    refundRatio = _sub > 0 ? Math.min(1, listValue / _sub) : 1;
    refundTotal = (_sub > 0 && _grand > 0) ? Math.round(refundRatio * Math.max(0, _grand - _ptsKES) * 100) / 100 : listValue;
    pointsKESShare = Math.round(refundRatio * _ptsKES * 100) / 100;

    /* ── WRITES ── */
    /* the points: earned taken back, spent given back — with the refund, exactly once (writes only; read above) */
    pointsOutcome = _PR.applyPointsRefundTx(txn, db, _ptsCtx, { ratio: refundRatio, refundKey: refundId, reason: 'pos_refund' });
    /* Inventory convergence A (2026-09-30): return ONLY the metered stock the sale actually took. An unmetered item
       (no numeric `stock`) gets no stock field — increment() would CREATE one and make a service metered. A line that
       recorded `stockDeducted` returns at most that; a sale from before it was recorded is judged by today's metering. */
    const _SELLr = require('./shared/sellability');
    plan.forEach(pItem => {
      if (pItem.snap.exists && pItem.snap.data().trackInventory !== false) {
        const _deducted = (typeof pItem.orig.stockDeducted === 'number') ? pItem.orig.stockDeducted : pItem.qty;
        const _ret = _SELLr.stockOf(pItem.snap.data()).metered ? Math.min(pItem.qty, _deducted) : 0;
        const _upd = {
          sold:             FieldValue.increment(-pItem.qty),
          totalUnitsSold:   FieldValue.increment(-pItem.qty),
          totalRevenue:     FieldValue.increment(-(pItem.orig.unitPrice * pItem.qty)),
          updatedAt:        FieldValue.serverTimestamp(),
        };
        if (_ret > 0) {
          _upd.stock            = FieldValue.increment(_ret);   /* return canonical stock */
          _upd.inventoryVersion = FieldValue.increment(1);
        }
        pItem.stockReturned = _ret;
        txn.update(pItem.ref, _upd);
      }
    });

    txn.set(refundRef, {
      id:          refundId,
      saleId,
      merchantId:  _sanitize(merchantId),
      items:       plan.map(x => ({ productId: x.orig.productId, qty: x.qty, stockReturned: x.stockReturned || 0 })),
      refundTotal,                         /* MONEY returned — the money-paid share of what these lines cost */
      listValue, refundRatio,              /* 2026-09-29: the list value refunded, and its share of the sale */
      pointsValueShareKES: pointsKESShare, /* the part that was paid with SOKONI points — given back as points */
      pointsRestored: pointsOutcome.restored, pointsReversed: pointsOutcome.reversed, pointsShortfall: pointsOutcome.shortfall,
      refundMethod,
      reason:      _sanitize(reason),
      processedBy: managerId,
      /* WHO AUTHORISED IT, when an approval was presented. Recorded on the refund itself so
         a reconciliation can answer "who agreed to this?" without joining two collections,
         and so a refund taken on direct manager authority is visibly distinguishable from
         one taken under two-person control. Null is honest: it means nobody approved it
         separately, not that the approver is unknown. */
      approvalId:  approvalReceipt ? approvalReceipt.approvalId : null,
      approvedBy:  approvalReceipt ? (approvalReceipt.reviewedBy || null) : null,
      requestedBy: approvalReceipt ? (approvalReceipt.requestedBy || null) : null,
      createdAt:   FieldValue.serverTimestamp(),
    });
    txn.update(saleRef, { status: 'refunded', refundId, refundedAt: FieldValue.serverTimestamp() });
    return false;
  });

  /* Audit (canonical schema) — only on a real refund, not an idempotent replay. */
  if (!alreadyDone) {
    writeAudit(db, {
      action:     'pos.refund',
      actorUid:   managerId,
      actorRole:  (auth && auth.token && auth.token.role) || null,
      branchId:   sale.branchId || 'default',
      objectType: 'order',
      objectId:   saleId,
      before:     { paymentStatus: 'paid' },
      after:      { paymentStatus: 'refunded' },
      delta:      -refundTotal,
      reason:     reason || null,
      metadata:   { refundId, refundTotal, refundMethod, merchantId, items: (items || []).map(i => ({ productId: i.productId, qty: i.qty })) },
    });
  }

  return { refundId, refundTotal, idempotent: alreadyDone,
    ...(pointsOutcome && (pointsOutcome.restored || pointsOutcome.reversed) ? { pointsRestored: pointsOutcome.restored, pointsReversed: pointsOutcome.reversed } : {}) };
});

/* ════════════════════════════════════════════════════════════════
   posLogReprint — audit a receipt reprint (client-initiated, so logged via a callable).
   Increments an authoritative per-order reprint counter and writes the canonical audit entry.
════════════════════════════════════════════════════════════════ */
exports.posLogReprint = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { orderId, receiptType = 'sale', printerName = null, branchId = 'default', merchantId = null } = data || {};
  if (!orderId) _e('orderId required');

  const cntRef = db.collection('posReprintCounters').doc(String(orderId));
  let count = 1;
  try {
    await db.runTransaction(async (txn) => {
      const s = await txn.get(cntRef);
      count = (((s.exists && s.data().count) || 0)) + 1;
      txn.set(cntRef, { orderId: String(orderId), count, lastAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  } catch (_) { /* counter is best-effort; the audit below is the record of truth */ }

  writeAudit(db, {
    action:     'pos.receipt_reprint',
    actorUid:   auth.uid,
    actorRole:  (auth.token && auth.token.role) || null,
    branchId,
    objectType: 'receipt',
    objectId:   String(orderId),
    metadata:   { receiptType, printerName, reprintCount: count, merchantId },
  });
  return { ok: true, reprintCount: count };
});

/* ════════════════════════════════════════════════════════════════
   posGetQueueMetrics — real-time cashier performance & queue analytics
════════════════════════════════════════════════════════════════ */
exports.posGetQueueMetrics = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { merchantId, branchId = 'default', days = 7 } = data || {};
  if (!merchantId) _e('merchantId required');

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const snap = await db.collection('posCheckoutMetrics')
    .where('merchantId', '==', merchantId)
    .where('branchId', '==', branchId)
    .where('saleDate', '>=', sinceStr)
    .orderBy('saleDate', 'asc')
    .limit(1000)
    .get();

  const metrics = snap.docs.map(d => d.data());
  if (!metrics.length) return { empty: true, days };

  /* Aggregate by cashier */
  const byCashier = {};
  let totalMs = 0, totalSales = 0;

  for (const m of metrics) {
    if (!byCashier[m.cashierId]) {
      byCashier[m.cashierId] = { cashierId: m.cashierId, sales: 0, totalMs: 0, maxMs: 0 };
    }
    byCashier[m.cashierId].sales++;
    byCashier[m.cashierId].totalMs += m.durationMs;
    byCashier[m.cashierId].maxMs = Math.max(byCashier[m.cashierId].maxMs, m.durationMs);
    totalMs += m.durationMs;
    totalSales++;
  }

  const cashierStats = Object.values(byCashier).map(c => ({
    ...c,
    avgMs:      Math.round(c.totalMs / c.sales),
    avgDisplay: _msToTime(Math.round(c.totalMs / c.sales)),
    maxDisplay: _msToTime(c.maxMs),
  })).sort((a, b) => a.avgMs - b.avgMs);

  /* Payment method breakdown */
  const byMethod = {};
  for (const m of metrics) {
    byMethod[m.paymentMethod] = (byMethod[m.paymentMethod] || 0) + 1;
  }

  /* Hourly distribution (peak hours) */
  const byHour = Array(24).fill(0);
  for (const d of snap.docs) {
    const ts = d.data().createdAt;
    if (ts?.toDate) byHour[ts.toDate().getHours()]++;
  }

  return {
    days,
    totalSales,
    avgCheckoutMs:      Math.round(totalMs / totalSales),
    avgCheckoutDisplay: _msToTime(Math.round(totalMs / totalSales)),
    cashierStats,
    byPaymentMethod:    byMethod,
    peakHours:          byHour.map((count, hour) => ({ hour, count })),
  };
});

function _msToTime(ms) {
  if (ms < 60000) return `${Math.round(ms/1000)}s`;
  return `${Math.floor(ms/60000)}m ${Math.round((ms%60000)/1000)}s`;
}

/* ════════════════════════════════════════════════════════════════
   posCleanupIdempotency — daily cleanup of old idempotency records
════════════════════════════════════════════════════════════════ */
exports.posCleanupIdempotency = onSchedule({
  schedule:  'every 24 hours',
  timeZone:  'Africa/Nairobi',
  region:    REGION,
}, async () => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const snap = await db.collection('posIdempotency')
    .where('startedAt', '<', cutoff)
    .limit(500)
    .get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (!snap.empty) await batch.commit();
});

/* ════════════════════════════════════════════════════════════════
   posCheckPaymentStatus — poll IntaSend transaction status (no confirm() dialog)
   Called by the client every 3s after STK push to auto-detect completion.
   Returns: { status: 'pending' | 'completed' | 'failed', transactionRef, reason }
════════════════════════════════════════════════════════════════ */
exports.posCheckPaymentStatus = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { ref, merchantId } = data || {};
  if (!ref) _e('ref required');

  /* Check posPaymentStatus collection first — webhook writes here on IntaSend callback */
  const statusRef  = db.collection('posPaymentStatus').doc(String(ref));
  const statusSnap = await statusRef.get();

  if (statusSnap.exists) {
    const d = statusSnap.data();
    if (d.status === 'completed') {
      return { status: 'completed', transactionRef: d.transactionRef || ref };
    }
    if (d.status === 'failed' || d.status === 'cancelled') {
      return { status: 'failed', reason: d.failureReason || 'Payment was not completed' };
    }
  }

  /* No webhook yet — check posIdempotency for same-ref completion */
  if (merchantId) {
    const idemSnap = await db.collection('posIdempotency')
      .where('ref', '==', String(ref))
      .where('merchantId', '==', String(merchantId))
      .limit(1).get();
    if (!idemSnap.empty) {
      const idem = idemSnap.docs[0].data();
      if (idem.status === 'completed') return { status: 'completed', transactionRef: ref };
      if (idem.status === 'failed')    return { status: 'failed', reason: 'Payment failed' };
    }
  }

  /* Still waiting for webhook */
  return { status: 'pending' };
});

