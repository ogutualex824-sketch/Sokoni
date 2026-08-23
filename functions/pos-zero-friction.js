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
async function _postSaleFinancials(o) {
  const out = { status: 'pending', tax: null, commission: null, collectionRoute: null, error: null };
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
    const allCash = (o.payments || []).every((p) => String(p.method).toLowerCase() === 'cash');
    if (allCash) out.collectionRoute = 'CASH_IN_DRAWER';

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
      const inv = TE.computeInvoice({
        items: (o.items || []).map((it) => ({
          name: it.name, qty: Number(it.qty || 1), unitPrice: Number(it.unitPrice || 0),
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
        orderAmountCents: toCents(o.total), sellerId: o.merchantId,
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
      basisCents: toCents(o.total),
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
exports.posCompleteCheckout = onCall(cfgHeavy, async ({ data, auth }) => {
  const cashierId = await _assertAuth(auth);

  const {
    idempotencyKey,
    merchantId,
    branchId      = 'default',
    shiftId,
    items         = [],
    customer,
    payments      = [],
    couponCode,
    loyaltyRedeemPoints = 0,
    subtotal,
    discountTotal = 0,
    taxTotal      = 0,
    grandTotal,
    metadata      = {},
  } = data || {};

  if (!idempotencyKey) _e('idempotencyKey required');
  if (!merchantId)     _e('merchantId required');
  if (!items?.length)  _e('items required');
  if (!grandTotal || grandTotal < 0) _e('grandTotal invalid');

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
      enriched.push({ productId: it.productId, name: p.name, qty: it.qty || 1, unitPrice: serverPrice });
      serverSubtotal += serverPrice * (it.qty || 1);
      const from = Number(p.stock || 0), to = Math.max(0, from - (it.qty || 0));
      stockDeltas.push({ productId: it.productId, from, to, delta: to - from });
    }
    return {
      dryRun: true,
      ok: differences.length === 0,
      serverSubtotal,
      grandTotal: serverSubtotal - (discountTotal || 0) + (taxTotal || 0),
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
      if (!_actor || !_actor.ok) {
        _e('A discount needs an identified member of staff. ' +
           (_actor && _actor.reason ? 'Employment check: ' + _actor.reason : 'The employment record could not be read.'),
           'permission-denied');
      }
      if ((_actor.capabilities || []).indexOf('discount') === -1) {
        _e('A ' + (_actor.servedBy && _actor.servedBy.label || 'staff member') +
           ' cannot give a discount. Ask an owner or manager to approve it.',
           'permission-denied');
      }
      if (manualDiscount > serverSubtotal) _e('A discount cannot exceed the sale');
    }

    const totalDiscount = _round2(manualDiscount + couponDiscount);
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

    /* ── non-cash money must be CONFIRMED, and spent once ──────────────────
       `posPayments/{checkoutId}` is written by darajaSTKPush and moved to
       `completed` ONLY by darajaSTKCallback — the webhook Safaricom calls after
       the buyer enters their PIN. Reading it here is what makes the difference
       between "M-PESA was selected" and "M-PESA was paid". The client cannot
       write that document, so it cannot promote its own payment.

       Cash is exempt: the cashier is physically holding it, and the drawer
       reconciliation is what audits it. Wallet is validated separately below
       and debited inside the transaction. */
    const CONFIRMABLE = { mpesa: 1, card: 1, mpesa_daraja: 1 };
    for (const p of _pay) {
      const method = String((p && p.method) || '').toLowerCase();
      if (!CONFIRMABLE[method]) continue;

      const ref = String((p && (p.ref || p.reference || p.checkoutId || p.transactionRef)) || '').trim();
      if (!ref) {
        _e('This ' + method.toUpperCase() + ' payment has no transaction reference, so it ' +
           'cannot be confirmed. Send the payment request and wait for the customer to pay.');
      }

      const paySnap = await db.collection('posPayments').doc(ref).get();
      if (!paySnap.exists) {
        _e('No ' + method.toUpperCase() + ' payment was found for this sale. ' +
           'Nothing has been charged.', 'not-found');
      }
      const pay = paySnap.data() || {};

      if (pay.status !== 'completed') {
        _e('The customer has not completed this payment yet (' + (pay.status || 'pending') + '). ' +
           'Wait for their confirmation, or try the payment again.', 'failed-precondition');
      }
      /* The money must have reached THIS shop, not merely exist somewhere. */
      if (pay.sellerUid && pay.sellerUid !== merchantId && pay.sellerUid !== cashierId) {
        _e('That payment belongs to a different shop.', 'permission-denied');
      }
      /* And it must be enough. A 3,000 sale cannot be settled with a confirmed
         10 shilling payment just because a reference was pasted in. */
      const confirmedAmount = Number(pay.paidAmount != null ? pay.paidAmount : pay.amount);
      if (isFinite(confirmedAmount) && confirmedAmount + 1 < Number(p.amount || 0)) {
        _e('The confirmed payment is ' + confirmedAmount + ' but this sale is claiming ' +
           p.amount + '.');
      }

      /* ── spent exactly once ────────────────────────────────────────────
         Without this, one genuinely confirmed M-PESA payment could settle any
         number of sales — the strongest confirmation check in the world is
         worth nothing if its result is replayable. create() is atomic: exactly
         one sale wins the reference, every other caller gets ALREADY_EXISTS.
         Keyed by reference, and it records which sale spent it. */
      const claimRef = db.collection('posPaymentClaims').doc(ref);
      try {
        await claimRef.create({
          reference: ref, method, merchantId, cashierId,
          idempotencyKey, amount: Number(p.amount || 0), claimedAt: Date.now(),
        });
        _consumed.push(ref);
      } catch (err) {
        if (err && err.code === 6 /* ALREADY_EXISTS */) {
          const prior = (await claimRef.get()).data() || {};
          /* The SAME sale retrying is fine — it already owns this payment. */
          if (prior.idempotencyKey !== idempotencyKey) {
            _e('That payment has already been used for another sale.', 'already-exists');
          }
        } else { throw err; }
      }

      /* Carry the confirmation onto the payment line, so the receipt and the
         stored sale show the real M-PESA code rather than the client's guess. */
      p.confirmed = true;
      p.confirmedAmount = isFinite(confirmedAmount) ? confirmedAmount : null;
      if (pay.mpesaCode) p.mpesaCode = pay.mpesaCode;
      if (pay.paidPhone) p.paidPhone = pay.paidPhone;
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
    const { loyaltyAwarded } = await db.runTransaction(async txn => {

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

      /* ── PHASE 2: VALIDATE (no writes yet, so a rejection touches nothing) ── */
      /* Wallet: idempotent skip if the deterministic txn doc already exists (prior attempt). */
      const doWalletDeduct = walletPayment && !wTxSnap.exists;
      if (doWalletDeduct) {
        const bal = wSnap.exists ? (wSnap.data().balance ?? 0) : -1;
        if (bal < walletAmt)
          throw new HttpsError('failed-precondition',
            `Insufficient wallet balance: has KES ${Math.max(0, bal)}, needs KES ${walletAmt}`);
      }
      /* Inventory: assert stock before deducting anything. */
      productSnaps.forEach((snap, i) => {
        const item = enrichedItems[i];
        if (!snap.exists) throw new Error(`Product ${item.productId} disappeared`);
        const prod  = snap.data();
        /* Canonical stock field is `stock`; fall back to legacy names for older docs. */
        const stock = prod.stock ?? prod.stockQty ?? prod.quantity ?? 9999;
        if (stock < (item.qty || 1) && prod.trackInventory !== false)
          throw new Error(`Insufficient stock for ${prod.name}`);
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

      productSnaps.forEach((snap, i) => {
        const item = enrichedItems[i];
        if (snap.data().trackInventory !== false) {
          txn.update(productRefs[i], {
            /* Deduct the CANONICAL `stock` — the same field inventory, catalogue and dispatch
               read, so a till sale is immediately reflected everywhere. inventoryVersion bumps
               so client caches invalidate. Pre-check above guarantees stock ≥ qty. */
            stock:            FieldValue.increment(-(item.qty || 1)),
            inventoryVersion: FieldValue.increment(1),
            sold:             FieldValue.increment(item.qty || 1),
            lastSoldAt:       FieldValue.serverTimestamp(),
            totalUnitsSold:   FieldValue.increment(item.qty || 1),
            totalRevenue:     FieldValue.increment(item.unitPrice * (item.qty || 1)),
            updatedAt:        FieldValue.serverTimestamp(),
          });
        }
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

      return { loyaltyAwarded };
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
      items: enrichedItems,
      subtotal: serverSubtotal,
      discount: totalDiscount,
      total: authoritativeTotal,
      payments: _pay,
    });

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
      branchId:        _sanitize(branchId),
      cashierId:       _sanitize(cashierId),
      shiftId:         shiftId ? _sanitize(shiftId) : null,
      items:           enrichedItems,
      customer:        customer ? {
        id:    _sanitize(customer.id || ''),
        name:  _sanitize(customer.name || 'Guest'),
        phone: _sanitize(customer.phone || ''),
      } : null,
      payments,
      couponCode:         couponCode ? _sanitize(couponCode) : null,
      couponDiscount,
      loyaltyRedeemed:    loyaltyRedeemPoints,
      loyaltyAwarded,
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
      collectionRoute:    financial.collectionRoute,
      financialPosting:   financial.status,
      financialError:     financial.error || null,

    };

    await db.collection('posRetailSales').doc(saleId).set(sale);

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
        paymentMethod: payments[0]?.method || 'unknown',
        createdAt:     FieldValue.serverTimestamp(),
        saleDate,
      });
    }

    /* ── 8. Build receipt ── */
    const receipt = {
      receiptNo:  saleId.slice(-8).toUpperCase(),
      saleId,
      merchantId,
      items:      enrichedItems,
      subtotal:   serverSubtotal,
      discount:   totalDiscount,
      tax:        taxTotal,
      total:      authoritativeTotal,
      payments,
      loyaltyAwarded,
      loyaltyRedeemed: loyaltyRedeemPoints,
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
    await idemRef.update({ status: 'complete', saleId, receipt, completedAt: now });

    return { saleId, receipt, loyaltyAwarded };

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
exports.posLookupCustomer = onCall(cfg, async ({ data, auth }) => {
  await _assertAuth(auth);
  const { query, method = 'auto', merchantId } = data || {};
  if (!query) _e('query required');

  const q    = String(query).trim();
  const coll = db.collection('posCustomers');
  let snap   = null;

  if (method === 'phone' || method === 'auto') {
    const phone = q.replace(/\s/g, '').replace(/^0/, '+254');
    snap = await coll.where('phone', '==', phone).limit(1).get();
    if (snap.empty) snap = await coll.where('phone', '==', q).limit(1).get();
  }

  if ((!snap || snap.empty) && (method === 'id' || method === 'auto')) {
    const direct = await coll.doc(q).get();
    if (direct.exists) snap = { docs: [direct], empty: false };
  }

  if ((!snap || snap.empty) && (method === 'email' || method === 'auto')) {
    snap = await coll.where('email', '==', q.toLowerCase()).limit(1).get();
  }

  if ((!snap || snap.empty) && (method === 'memberCard' || method === 'auto')) {
    snap = await coll.where('memberCardCode', '==', q.toUpperCase()).limit(1).get();
  }

  if (!snap || snap.empty) return { found: false };

  const doc  = snap.docs[0];
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
/* Manager-or-owner authority + merchant membership.

   posProcessRefund previously called _assertAuth(), which only checks that SOMEONE is logged in.
   Any authenticated user who knew a saleId could therefore refund it: there was no role gate and
   no check that the caller belonged to the merchant (the only comparison was the client-supplied
   merchantId against the sale's own merchantId, which an attacker simply supplies correctly).
   Refunds move real money and return stock, so they now require manager/owner rank AND
   membership of the merchant that owns the sale. */
async function _assertRefundAuthority(auth, merchantId) {
  if (!auth?.uid) _e('Authentication required', 'unauthenticated');
  const uidStr = auth.uid;

  const role = auth.token?.posRole || 'cashier';
  const isAdmin = auth.token?.admin === true || auth.token?.superAdmin === true;
  if (!isAdmin && role !== 'manager' && role !== 'owner') {
    _e('Refunds require a manager or owner', 'permission-denied');
  }
  if (isAdmin) return uidStr;

  /* Membership: business owner, or an active staff member of this merchant. */
  const [bizSnap, staffSnap] = await Promise.all([
    db.collection('businesses').doc(String(merchantId)).get(),
    db.collection('posStaff')
      .where('merchantId', '==', String(merchantId))
      .where('uid', '==', uidStr)
      .where('status', '==', 'active')
      .limit(1).get(),
  ]);
  if (bizSnap.exists && bizSnap.data().ownerId === uidStr) return uidStr;
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

  /* IDEMPOTENCY: refundId used to be a random id, so a double-tapped "Refund" created TWO
     refund records and returned the stock TWICE. Derive it from the caller's key (falling back
     to the saleId, since a sale can only be fully refunded once) and short-circuit inside the
     transaction if it already exists. */
  const rawKey   = String(idempotencyKey || saleId || '');
  const refundId = 'rf_' + rawKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  const refundRef = db.collection('posRefunds').doc(refundId);

  let refundTotal = 0;
  const alreadyDone = await db.runTransaction(async txn => {
    /* ── ALL READS FIRST ──
       The original read each product INSIDE the write loop (txn.get after txn.update), which
       Firestore rejects — every multi-item refund threw at runtime. */
    const prodRefs = items.map(it => db.collection('products').doc(it.productId));   /* canonical — symmetric with sale deduction */
    const [refundSnap, ...prodSnaps] = await Promise.all([
      txn.get(refundRef),
      ...prodRefs.map(r => txn.get(r)),
    ]);

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

    /* ── WRITES ── */
    plan.forEach(pItem => {
      if (pItem.snap.exists && pItem.snap.data().trackInventory !== false) {
        txn.update(pItem.ref, {
          stock:            FieldValue.increment(pItem.qty),   /* return canonical stock */
          inventoryVersion: FieldValue.increment(1),
          sold:             FieldValue.increment(-pItem.qty),
          totalUnitsSold:   FieldValue.increment(-pItem.qty),
          totalRevenue:     FieldValue.increment(-(pItem.orig.unitPrice * pItem.qty)),
          updatedAt:        FieldValue.serverTimestamp(),
        });
      }
    });

    txn.set(refundRef, {
      id:          refundId,
      saleId,
      merchantId:  _sanitize(merchantId),
      items:       plan.map(x => ({ productId: x.orig.productId, qty: x.qty })),
      refundTotal,
      refundMethod,
      reason:      _sanitize(reason),
      processedBy: managerId,
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

  return { refundId, refundTotal, idempotent: alreadyDone };
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
