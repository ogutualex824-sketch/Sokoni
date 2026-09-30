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

    /* A PROVEN COLLECTION OUTRANKS THE CONFIGURED ROUTE.
       `resolveCollectionRoute` answers "how is this platform configured to collect", which is
       a standing setting. `o.collected` answers "was THIS sale collected", which is a fact
       about one transaction and is the one that decides where the money is. A Sell tender
       taken through the Till reaches the SOKONI collection account whatever the default
       route says, and reconciliation must record what happened rather than what was
       configured. */
    if (o.collected && o.collected.ok) out.collectionRoute = 'CENTRAL_MOR';
    /* Cash is never centrally collected whatever the route says — it is in a
       drawer. Recording the configured route against a cash sale would misstate
       who holds the money. */
    const allCash = (o.payments || []).every((p) => String(p.method).toLowerCase() === 'cash');
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
    let electronicC = 0;
    for (const p of (o.payments || [])) {
      const m = String(p.method || '').toLowerCase();
      const c = toCents(p.amount);
      byMethod[m] = (byMethod[m] || 0) + c;
      if (m !== 'cash') electronicC += c;
    }
    /* The drawer figure replaces the gross cash line: byMethod.cash is what the
       customer handed over, position.cashCents is what stayed. */
    out.position = {
      cashCents: Math.max(0, cashTenderedC - changeC),
      electronicCents: electronicC,
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
      /* WHETHER SOKONI ACTUALLY TOOK THE MONEY, per sale — not per configuration.
         On a DIRECT_TO_SELLER till sale the seller holds the cash and owes us a share, so
         the commission is a RECEIVABLE. On a sale collected into the SOKONI account the
         commission is already in our hands and the merchant is credited net, so calling it a
         receivable would book a debt nobody owes and leave a sweep chasing it forever. */
      collected: !!(o.collected && o.collected.ok),
      settlement: (o.collected && o.collected.ok) ? 'collected_at_source' : 'receivable',
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
      /* THE DIRECTION FOLLOWS THE MONEY.
           not collected → DR seller / CR revenue. The seller holds the cash and owes us; the
                           debit is the receivable, and nothing is drawn from platform
                           clearing because no platform cash exists for this sale.
           collected     → DR platform:clearing / CR revenue. The cash IS in the platform
                           account; the commission is taken from it, and the merchant is
                           credited net. Booking a seller receivable here would invent a debt
                           against a merchant who has already been charged. */
      const _collected = !!(o.collected && o.collected.ok);
      await FU.createLedgerEntry(db, {
        type: _collected ? 'pos_commission_collected' : 'pos_commission_receivable',
        amountCents: commissionCents,
        debitAccount: _collected
          ? ((FU.ACCOUNTS && FU.ACCOUNTS.PLATFORM_CLEARING) || 'platform:clearing')
          : (FU.ACCOUNTS ? FU.ACCOUNTS.seller(o.merchantId) : ('seller:' + o.merchantId)),
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

    /* ── THE BUSINESS WALLET ────────────────────────────────────────────────
       What the seller KEEPS, credited to the wallet of the BUSINESS — not to the
       personal wallet of whoever owns it. `sellerNetCents` comes from the same engine
       that produced the commission, so the wallet and the ledger cannot disagree about
       the split of one sale.

       CASH IS EXCLUDED, DELIBERATELY. A cash sale puts money in a DRAWER; crediting a
       wallet for it would state that SOKONI is holding funds it has never touched, and
       a merchant reconciling their drawer against that balance would be counting the
       same shillings twice. `collectionRoute` already distinguishes the two, so the
       wallet follows the money rather than the sale.

       ── AND CASH WAS NOT THE ONLY MONEY SOKONI NEVER TOUCHED ─────────────────────────
       The condition below read `collectionRoute !== 'CASH_IN_DRAWER'`, which credited the
       wallet on a DIRECT_TO_SELLER M-Pesa sale — a sale where the customer paid the
       MERCHANT'S OWN till and the platform received nothing. The sentence above says
       exactly why that is wrong; the test it was written as simply did not cover it.

       It mattered because this balance is spendable. `businessWalletDraw` moves it to the
       owner's personal wallet and `requestSellerPayout` pays it out of the SOKONI collection
       account over the B2C rail — so a merchant was paid twice for one sale: once by the
       customer into their own till, once by us. The commission receivable recovered a
       fraction of it and the rest was simply given away.

       The wallet is now credited ONLY on a collection SOKONI actually holds — a sale proven
       against a paid Till payment intent (see pos-collection-proof.js). A DIRECT_TO_SELLER
       sale still records, still posts its commission receivable, and credits nothing,
       because there is nothing of ours to credit.

       IDEMPOTENT BY THE SALE. The ref is derived from the sale id, so a retried posting
       credits nothing a second time — the same guarantee the ledger entry gets from its
       idempotencyKey, enforced by the wallet's own transaction rather than by this
       caller remembering to check.

       NON-FATAL. The sale has happened and the books are already posted; a wallet that
       could not be credited is a repairable discrepancy, not a reason to fail a sale the
       customer has paid for. It is recorded, not swallowed. */
    /* ── AND THE ROUTE ALONE IS NOT EVIDENCE THAT MONEY ARRIVED ──────────────────────
       This read `collectionRoute === 'CENTRAL_MOR'`, which is a CONFIGURATION — "how is
       this platform set up to collect" — and not a fact about this sale. Proven collection
       forces the route to CENTRAL_MOR, so for M-PESA and Till/QR the two agreed and the
       condition looked sound. They come apart on any tender that carries no proof: with the
       platform configured CENTRAL_MOR, a card sale approved by the client — in the limit, by
       `Math.random()` — satisfied this condition and credited a spendable wallet balance
       for money SOKONI never received.
       The credit now requires the PROOF, not the setting. A configuration change can no
       longer turn an unverified approval into money, which is the whole point of keeping
       these two ideas separate. The refusal above should already have stopped such a sale
       from existing; this is the second wall, and it is the one that guards the money. */
    const _proven = !!(o.collected && o.collected.ok === true);
    if (out.collectionRoute === 'CENTRAL_MOR' && _proven && sellerNetCents > 0) {
      try {
        const si = require('./store-identity');
        const ti = require('./tenant-identity');
        /* The merchantId here may be a legacy uid or a canonical business id. Resolving it
           rather than assuming keeps one code path for both. */
        let businessId = null;
        /* THE OWNER UID IS TRACKED SEPARATELY FROM THE MERCHANT ID, and that distinction is
           the whole point of the guard below.

           This read `assertNotUidShaped(businessId, String(o.merchantId))`. In the FIRST
           branch — `businesses/{merchantId}` exists, which is the normal case for a
           provisioned merchant — businessId IS merchantId, so the two arguments were the same
           string and the guard threw on every canonical merchant:

               "store id must not equal the owner uid"

           The throw was caught, a posFinancialRepair row was filed, and the sale completed.
           So the POS wallet credit never once succeeded for a properly provisioned merchant;
           it failed silently into a repair queue that nothing drains.

           The guard is asking "is this business id actually a person's uid?" — and the answer
           needs the OWNER'S uid, not the id we happened to look the business up by. */
        let ownerUid = null;
        const bizSnap = await db.collection('businesses').doc(String(o.merchantId)).get();
        if (bizSnap.exists) {
          businessId = String(o.merchantId);
          ownerUid = String((bizSnap.data() || {}).ownerId || '') || null;
        } else {
          /* merchantId is a uid here, so it IS the owner — and the guard becomes the real
             check that the resolved business id is not that same uid. */
          const owned = await ti.resolveMerchantIdForOwner(String(o.merchantId));
          if (owned.ok) { businessId = owned.merchantId; ownerUid = String(o.merchantId); }
        }
        if (businessId) {
          si.assertNotUidShaped(businessId, ownerUid);
          const bw = require('./business-wallet');
          const cr = await bw.credit({
            businessId,
            ownerUid: null,
            amountMinor: sellerNetCents,
            ref: 'possale_' + String(o.saleId),
            kind: 'pos_sale',
            /* ── POS OR TILL? THE COLLECTION KNOWS ────────────────────────────────────────
               Both are shop sales and both land in the same wallet, but they are different
               streams to a merchant deciding whether the Till is worth having:

                 TILL   the customer scanned the provisioned SOKONI Till / QR and paid it
                        themselves — pos-collection-proof reports rail 'till_qr'
                 POS    the sale was rung up on the counter and the cashier prompted the
                        phone — rail 'sell_stk'

               Taken from the PROVEN collection rather than from anything the client said,
               so the stream a sale is filed under is decided by how the money actually
               arrived. Absent proof there is no wallet credit at all, so this is never
               guessed at. */
            source: {
              channel: (o.collected && o.collected.rail === 'till_qr') ? 'TILL' : 'POS',
              /* HOW it was paid, from the same proof — a second dimension, not a channel. */
              method: (o.collected && o.collected.method) || 'UNKNOWN',
              businessId: businessId,
              shopId: (o.collected && o.collected.shopId) || null,
              saleId: String(o.saleId),
              paymentRef: (o.collected && o.collected.ref) || null,
              grossMinor: toCents(o.total),
              commissionMinor: commissionCents,
              netMinor: sellerNetCents,
              currency: 'KES',
            },
            metadata: { saleId: o.saleId, collectionRoute: out.collectionRoute },
          });
          out.businessWallet = { businessId, creditedMinor: cr.applied ? cr.amountMinor : 0,
                                 idempotent: !!cr.idempotent, balanceMinor: cr.balanceMinor };
        } else {
          out.businessWallet = { businessId: null, skipped: 'no-business-for-merchant' };
        }
      } catch (e) {
        out.businessWallet = { error: (e && e.message) || String(e) };
        try {
          await db.collection('posFinancialRepair').doc(String(o.saleId) + '_wallet').set({
            saleId: o.saleId, merchantId: o.merchantId, sellerNetCents,
            reason: 'business_wallet_credit_failed',
            error: out.businessWallet.error, at: FieldValue.serverTimestamp(),
          }, { merge: true });
        } catch (_) { }
      }
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
    /* NOT defaulted to a placeholder. `'default'` is not a branch — see
       pos-branch-authority. The requested value is resolved and PROVED against the
       merchant below; an absent one becomes the merchant's real default branch. */
    branchId: requestedBranchId,
    shiftId,
    items         = [],
    customer,
    payments      = [],
    couponCode,
    loyaltyRedeemPoints = 0,
    redemptionChallengeId = null,
    subtotal,
    discountTotal = 0,
    taxTotal      = 0,
    grandTotal,
    /* PROOF THAT SOKONI COLLECTED THIS SALE — a paymentIntents reference the IntaSend
       webhook has moved to `paid`. The client names it; every fact that decides money is
       then read from the server's own record of it. Absent means the sale was not centrally
       collected, which is a legitimate state (cash, or a merchant's own till) and simply
       earns no wallet credit. See pos-collection-proof.js. */
    collectedIntentRef,
    metadata      = {},
  } = data || {};

  if (!idempotencyKey) _e('idempotencyKey required');
  if (!merchantId)     _e('merchantId required');
  if (!items?.length)  _e('items required');
  if (!grandTotal || grandTotal < 0) _e('grandTotal invalid');

  /* ── 07:00 DAILY BUSINESS-DAY GATE (P3) ─────────────────────────────────────
     A business owing SOKONI commission may not BEGIN a new POS/Till business day.
     Enforced HERE, on the server, before any sale effect: no client can decline to
     ask, and a client that never calls the gate callable still cannot sell.

     Placed after argument validation and BEFORE the idempotency claim, the order
     write, the stock write and the payment — a blocked till must leave no trace,
     exactly like a refused claim in order-claim.js.

     It does NOT re-price anything and does NOT touch sale proceeds: the POS model is
     unchanged — the seller keeps the cash and owes a receivable. The gate only asks
     whether yesterday's obligation was settled.

     Opening is idempotent, so ten tills starting at 07:00:00 produce one open record. */
  /* ══ THE MERCHANT MUST BE PROVEN, AND BEFORE THE GATE ════════════════════
     `merchantId` arrives in the request body and, until this block, was checked for
     PRESENCE only. The comment below this one says the branch is resolved "AFTER
     merchantId has been server-established" — but nothing established it. The actor
     IS resolved further down, and is consumed only for discount authority, one error
     message and the receipt's servedBy line; no path refused the sale.

     THIS IS WHAT MAKES THE GATE BELOW MEAN ANYTHING. `assertBusinessDayOpen` keys on
     `merchantId`, so on an unproven id a merchant whose till is closed could pass a
     clean shop's id and keep trading, or pass a rival's id and close theirs. A gate on
     a forgeable identifier is not enforcement; it is the appearance of it.

     TWO AUTHORITIES, UNION — the same pair the discount check further down already
     uses. resolveActor covers the owner (keyed off the shops/{uid} document id, so
     ownership cannot be forged by writing a field) and shopEmployees staff on the
     canonical composite key. The canonical path covers staff who exist only in
     workspaceMemberships; requiring resolveActor alone would refuse every one of them.

     The actor is resolved again further down for discount authority. That second read
     is left alone deliberately: hoisting it would move a variable across two scopes in
     money code to save one document read, and the read is cheaper than the mistake. */
  {
    let _proven = false;
    try {
      const _a = await resolveActor(cashierId, merchantId);
      _proven = !!(_a && _a.ok);
    } catch (err) {
      _e('Staff permissions could not be checked, so this sale was not completed. ' +
         'Nothing has been charged.', 'unavailable');
    }
    if (!_proven) {
      let _canon = null;
      try {
        const _b = await db.collection('businesses').doc(String(merchantId)).get();
        if (_b.exists) _canon = String(merchantId);
        else {
          const { resolveMerchantIdForOwner } = require('./tenant-identity');
          const _own = await resolveMerchantIdForOwner(String(merchantId));
          if (_own && _own.ok) _canon = _own.merchantId;
        }
      } catch (_) { _canon = null; }
      if (_canon) {
        try {
          const { _assertBusinessPermission } = require('./workforce-identity');
          /* `sales` — the capability to transact here at all. NOT `discounts`, which is
             strictly narrower and would refuse ordinary cashiers. */
          await _assertBusinessPermission(cashierId, _canon, 'sales');
          _proven = true;
        } catch (_) { /* not a member here, or without the capability */ }
      }
    }
    if (!_proven) {
      _e('You are not authorised to record a sale for this shop.', 'permission-denied');
    }
  }

  {
    const _gate = require('./pos-business-day-gate');
    await _gate.assertBusinessDayOpen(db, String(merchantId));
  }

  /* ── BRANCH, RESOLVED AND PROVED ──────────────────────────────────────────
     `branchId` arrived from the client and was written straight through with a
     `'default'` fallback, so a sale could be filed under a branch the merchant does
     not own — or under a placeholder that is not a branch at all. Resolved here,
     AFTER merchantId has been server-established.

     A branch the caller NAMED but cannot prove is fatal: they asked for a specific
     scope and are not entitled to it, and quietly moving the sale to a different
     branch would misattribute the takings. An ABSENT branch is not fatal — it
     resolves to the merchant's own default branch, or to null, which is what these
     records already accept for an unknown scope. */
  const _branchAuth = require('./pos-branch-authority');
  const _branch = await _branchAuth.resolveBranchId(db, String(merchantId), requestedBranchId);
  if (!_branch.ok) {
    _e('That branch does not belong to this business, so the sale was not completed. '
       + '(' + _branch.reason + ')', 'permission-denied');
  }
  const branchId = _branch.branchId;

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

    /* ── POINTS, PRICED BY THE SERVER ────────────────────────────────────────
       `loyaltyRedeemPoints` is a COUNT the till asked to spend. What that count is
       worth is decided here, from the canonical loyaltyMerchantConfigs — never sent by the
       browser. pos-checkout.html previously subtracted its own KES figure from the
       total it displayed while omitting it from `discountTotal`, so the two sides
       disagreed by exactly the points value and the mismatch guard below refused
       every points sale. That is why redeeming points at a till has never worked.

       READ BEFORE THE TRANSACTION, RE-READ INSIDE IT. The total has to be known
       here, because the tender check below prices against it — but these snapshots
       are outside the transaction and could be stale by the time it commits. So this
       authorisation is PROVISIONAL: it prices the sale, and the transaction re-runs
       the identical calculation on its own snapshots and refuses if the answer moved.
       A balance that changed under us aborts the sale rather than charging a total
       nobody agreed to. */
    const _loyalty = require('./pos-loyalty-redemption');
    const _redeemBase = _round2(serverSubtotal - totalDiscount);
    let _preAuth = { ok: false, approvedPoints: 0, approvedKES: 0, reason: null };
    if (loyaltyRedeemPoints && customer?.id) {
      const [_pcSnap, _plSnap] = await Promise.all([
        db.collection('posCustomers').doc(customer.id).get(),
        require('./rewards-rate').configRef(db, merchantId).get(),
      ]);
      _preAuth = _loyalty.authorize({
        custSnap: _pcSnap, progSnap: _plSnap,
        pointsRequested: loyaltyRedeemPoints,
        redeemableBaseKES: _redeemBase,
      });
      /* A refusal is stated, not silently priced at zero. Charging the full amount
         after a till showed a points discount is the same class of defect as granting
         one that was never authorised. */
      if (!_preAuth.ok) {
        _e('Points could not be redeemed: ' + (_preAuth.reason || 'not authorised') +
           '. Ring the sale up again without points.', 'failed-precondition');
      }
    }
    const loyaltyRedeemKES = _preAuth.approvedKES || 0;

    /* ── THE CUSTOMER MUST HAVE AGREED ───────────────────────────────────────
       Points are money, and a cashier alone must not be able to spend a customer's
       balance. Where any points are being redeemed a CONFIRMED challenge is required —
       there is no path that spends points on the cashier's word.

       Checked here so a missing or invalid challenge refuses BEFORE tenders are taken,
       and re-checked inside the transaction below against the same sale. This read is
       outside the transaction and therefore advisory; the in-transaction re-check is the
       one that decides.

       No HMAC secret is needed on this path: verifying the CODE happens at confirmation
       time, and what the sale verifies is the recorded state and the binding. */
    let _chal = null;
    if (_preAuth.ok && _preAuth.approvedPoints > 0) {
      const _cm = require('./pos-redemption-challenge');
      if (!redemptionChallengeId) {
        _e('This redemption needs the customer to confirm it on the till. ' +
           'Start "Pay with Points" and ask the customer to approve.', 'failed-precondition');
      }
      _chal = await db.collection(_cm.COLLECTION).doc(String(redemptionChallengeId)).get();
      /* Date.now() directly, NOT the `now` binding — that const is declared further down,
         inside the transaction block, so referencing it here is a temporal dead zone
         throw. It would never have fired on a sale without a challenge, because the
         refusal above returns first; it would have fired on the first sale that supplied
         one, which is the only path anybody would have been testing by then. */
      const v = _cm.checkSpendable({
        snap: _chal, merchantId, customerId: customer && customer.id,
        saleKey: idempotencyKey,
        points: _preAuth.approvedPoints, valueKES: _preAuth.approvedKES, now: Date.now(),
      });
      if (!v.ok) _e('Points redemption refused: ' + v.reason + '.', 'failed-precondition');
    }

    /* ── the authoritative total ───────────────────────────────────────────
       Computed from the server's OWN prices and the discount it just
       authorised. The caller's grandTotal is not used; it is only compared, so
       a till showing a different figure from the one being charged is refused
       loudly instead of charging silently. */
    const authoritativeTotal = _round2(serverSubtotal - totalDiscount - loyaltyRedeemKES + (taxTotal || 0));
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
       `posPayments/{checkoutId}` is a server-written record that only a payment
       callback can move to `completed`. Reading it here is what makes the difference
       between "M-PESA was selected" and "M-PESA was paid". The client cannot
       write that document, so it cannot promote its own payment.

       Cash is exempt: the cashier is physically holding it, and the drawer
       reconciliation is what audits it. Wallet is validated separately below
       and debited inside the transaction. */
    const CONFIRMABLE = { mpesa: 1, card: 1 };
    /* THE CLOSED SET OF TENDERS THIS PATH ACCEPTS.
       An unrecognised method used to fall straight through `continue` and skip
       confirmation entirely — so any method this server did not know about became money
       accepted WITHOUT proof of payment, whether it was a retired rail, a typo, or a
       client sending something new. Unknown now REFUSES.

       Membership here is NOT confirmation, and the two must not be confused:
         mpesa / card   confirmed below against a server-written payment record
         cash           physically held; audited by drawer reconciliation
         wallet         validated and debited inside the transaction below
         gift_card      NOT verified here at all: no code, balance or existence
                        check runs in this path
       A method may only be added here once its settlement is accounted for. */
    const ACCEPTED = { mpesa: 1, card: 1, cash: 1, wallet: 1, gift_card: 1 };
    for (const p of _pay) {
      const method = String((p && p.method) || '').toLowerCase();
      if (!ACCEPTED[method]) {
        _e('"' + (method || '(none)') + '" is not an accepted POS/Till payment method.',
           'failed-precondition');
      }
      if (!CONFIRMABLE[method]) continue;

      const ref = String((p && (p.ref || p.reference || p.checkoutId || p.transactionRef)) || '').trim();
      if (!ref) {
        _e('This ' + method.toUpperCase() + ' payment has no transaction reference, so it ' +
           'cannot be confirmed. Send the payment request and wait for the customer to pay.');
      }

      /* ── WHERE THE CONFIRMATION LIVES (P6/P7) ────────────────────────────────
         The legacy rail wrote posPayments/{ref}. IntaSend writes posPaymentStatus/{ref}
         via the P5 webhook bridge. Reading only posPayments after the cutover would look for a
         document that is never created, and EVERY till sale paid through IntaSend would
         be refused with "no payment was found" — the customer charged, the sale
         impossible to complete.

         The two are normalised to one shape here so every check below — completed,
         belongs to THIS shop, sufficient amount, spent exactly once — runs unchanged
         against either rail. Legacy posPayments refs keep working, which is what lets a
         payment taken before the cutover still settle after it. */
      const _isIntasend = require('./pos-intasend-initiation').isPosRef(ref);
      let pay;
      if (_isIntasend) {
        const sSnap = await db.collection('posPaymentStatus').doc(ref).get();
        if (!sSnap.exists) {
          _e('No ' + method.toUpperCase() + ' payment was found for this sale. ' +
             'Nothing has been charged.', 'not-found');
        }
        const s = sSnap.data() || {};
        pay = {
          status:     s.status,                       /* 'completed' | 'failed' | 'pending' */
          sellerUid:  s.merchantId || null,
          paidAmount: (s.confirmedAmountKES != null) ? Number(s.confirmedAmountKES)
                    : (s.amountCents != null ? Number(s.amountCents) / 100 : null),
          mpesaCode:  s.transactionRef || null,
        };
      } else {
        const paySnap = await db.collection('posPayments').doc(ref).get();
        if (!paySnap.exists) {
          _e('No ' + method.toUpperCase() + ' payment was found for this sale. ' +
             'Nothing has been charged.', 'not-found');
        }
        pay = paySnap.data() || {};
      }

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
      /* CANONICAL rewards config. This was loyaltyPrograms/{merchantId} — client-written,
         with no Firestore rule, therefore never creatable, therefore a redemption authority
         that refused every merchant in production. */
      const progRef = customer?.id ? require('./rewards-rate').configRef(db, merchantId) : null;

      /* The challenge is re-read INSIDE the transaction: the pre-check above ran against
         a snapshot taken outside it, and between the two the challenge can be consumed by a
         concurrent sale. Reading it here is what makes double-spend impossible. */
      const _chalRef = redemptionChallengeId
        ? db.collection(require('./pos-redemption-challenge').COLLECTION).doc(String(redemptionChallengeId))
        : null;
      const [wTxSnap, wSnap, custSnap, progSnap, _chalSnap, ...productSnaps] = await Promise.all([
        walletPayment ? txn.get(walletTxRef)  : Promise.resolve(null),
        walletPayment ? txn.get(walletDocRef) : Promise.resolve(null),
        custRef ? txn.get(custRef) : Promise.resolve(null),
        progRef ? txn.get(progRef) : Promise.resolve(null),
        _chalRef ? txn.get(_chalRef) : Promise.resolve(null),
        ...productRefs.map(r => txn.get(r)),
      ]);

      /* ── PHASE 2: VALIDATE (no writes yet, so a rejection touches nothing) ── */

      /* POINTS, RE-AUTHORISED ON THE TRANSACTION'S OWN SNAPSHOTS.
         The provisional authorisation above priced the sale from a read taken outside
         this transaction. Between then and now the balance can have moved — the same
         customer scanned at a second till, a refund landed, a concurrent sale spent the
         points first. Re-running the identical calculation here, on snapshots Firestore
         guarantees are consistent with the commit, is what makes an overspend
         impossible: two tills racing for one balance cannot both succeed, because the
         loser's re-authorisation disagrees and its whole transaction aborts.

         DISAGREEMENT ABORTS THE SALE; it never silently reprices. The tenders were
         already collected against the provisional total, so quietly charging a
         different figure would take money the customer never agreed to — and quietly
         approving fewer points would hand over goods that were not paid for. */
      let _txAuth = { ok: false, approvedPoints: 0, approvedKES: 0 };
      if (loyaltyRedeemPoints && custRef) {
        _txAuth = _loyalty.authorize({
          custSnap, progSnap,
          pointsRequested: loyaltyRedeemPoints,
          redeemableBaseKES: _redeemBase,
        });
        if (!_txAuth.ok || _txAuth.approvedPoints !== _preAuth.approvedPoints ||
            _txAuth.approvedKES !== _preAuth.approvedKES) {
          throw new HttpsError('aborted',
            'The points balance changed while this sale was being completed. ' +
            'Nothing was charged and no points were spent. Ring the sale up again.');
        }

        /* THE CUSTOMER'S CONSENT, RE-VERIFIED AGAINST THE FIGURES BEING SPENT.
           Not a repeat of the pre-check: that ran on a snapshot taken outside this
           transaction, and a concurrent sale can consume a challenge in between. It is
           also bound to _txAuth — the figures this transaction is actually about to
           burn — so a challenge minted for one amount cannot settle another even if the
           balance moved in a way that happened to re-price identically.

           checkSpendable independently re-asserts that the confirming principal was not
           the minting cashier, so the sale never takes a confirmation flag on trust. */
        const _cmv = require('./pos-redemption-challenge').checkSpendable({
          snap: _chalSnap, merchantId, customerId: customer && customer.id,
          saleKey: idempotencyKey,
          points: _txAuth.approvedPoints, valueKES: _txAuth.approvedKES, now: now,
        });
        if (!_cmv.ok) {
          throw new HttpsError('failed-precondition',
            'Points redemption refused: ' + _cmv.reason + '. Nothing was charged.');
        }
      }

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
        /* EARN, FROM THE SAME CANONICAL RULE THE REDEMPTION USES.
           This computed (subtotal / 100) * 1 — one point per KES 100, a 0.1% reward — while
           the customer authority granted pointsPerKES 0.1, one point per KES 10. A tenfold
           divergence in what the SAME customer earned depending on which surface rang the
           sale, and neither figure was wrong on its own terms because neither knew the
           other existed.

           SOKONI's rule: 1 point per KES 10 earned, 10 points = KES 1 redeemed — a 1%
           effective reward. Both halves now come from loyaltyMerchantConfigs through
           normalizeRewardsRate, so a merchant cannot hold one economics for giving and
           another for taking, and the old 1/100 fallback is gone rather than demoted. */
        const _norm = require('./rewards-rate')
          .normalizeRewardsRate(progSnap && progSnap.exists ? progSnap.data() : null);
        loyaltyAwarded = Math.floor(serverSubtotal * _norm.pointsPerKES);

        /* THE BURN IS THE AUTHORISED FIGURE, NOT THE REQUESTED ONE.
           This used to subtract the caller's `loyaltyRedeemPoints` directly, clamped by
           Math.max(0, …). The clamp stopped a negative balance but nothing else: an
           unvalidated count could burn points the customer never had — floored at zero,
           so the loss was silent — and burn them without reducing the price by a single
           shilling, because no loyalty term existed in the total at all.

           `_txAuth.approvedPoints` was re-derived above from this transaction's own
           snapshots and is the same figure the sale was priced on. It can never exceed
           the balance, because authorize() refuses when it would. */
        const cust      = custSnap.data();
        const _burn     = _txAuth.approvedPoints || 0;
        const newPoints = Math.max(0, (cust.loyaltyPoints || 0) + loyaltyAwarded - _burn);
        txn.update(custRef, {
          loyaltyPoints:  newPoints,
          lifetimePoints: FieldValue.increment(loyaltyAwarded),
          totalSpent:     FieldValue.increment(authoritativeTotal),
          lastPurchaseAt: FieldValue.serverTimestamp(),
          purchaseCount:  FieldValue.increment(1),
        });

        /* THE LIABILITY, RECORDED SEPARATELY AND IN THE SAME COMMIT.
           A balance alone cannot be reconciled or reversed: it says what is left, never
           what was spent or against which sale. This ledger entry is what makes every
           redeemed point traceable to one customer, one sale and one rate context — and
           it is written INSIDE the sale's transaction, so points and sale commit together
           or not at all. A sale that fails after this point takes the burn with it. */
        if (_burn > 0) {
          /* THE CHALLENGE IS SPENT IN THE SAME COMMIT AS THE POINTS.
             Consumed here rather than at confirmation time, so a sale that fails after
             this point takes the consumption with it and the customer keeps both their
             points and a challenge they can still use. One commit, or neither. */
          if (_chalRef) {
            txn.update(_chalRef, require('./pos-redemption-challenge').consumePatch(now));
          }

          const _le = _loyalty.ledgerEntry({
            idempotencyKey, merchantId, customerId: customer.id, saleId,
            authorized: _txAuth, at: FieldValue.serverTimestamp(),
          });
          txn.set(db.collection(_loyalty.LEDGER).doc(_le.id), _le.doc);
        }
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
    /* ── WAS THIS COLLECTED BY SOKONI? ──────────────────────────────────────────────────
       Verified against the AUTHORITATIVE total the server just computed, not against
       anything the client sent — so a caller cannot present a small real collection to
       complete a large sale. The merchant is the RESOLVED one, so naming another shop's
       payment reference gains nothing.

       A failure here does not fail the sale. A cashier who mistypes a reference, or whose
       customer has not finished paying, must not lose a basket — the sale records as
       uncollected, which is the truth, and earns no wallet credit. The reason is carried on
       the sale so it is answerable later instead of vanishing. */
    let _collected = null;
    if (collectedIntentRef) {
      try {
        const CP = require('./pos-collection-proof');
        _collected = await CP.verifyAndClaimCollection(db, {
          intentRef: collectedIntentRef,
          saleId,
          merchantUid: merchantId,
          amountCents: Math.round(Number(authoritativeTotal) * 100),
        });
      } catch (e) {
        _collected = { ok: false, reason: 'collection-check-failed',
                       remedy: (e && e.message) || String(e) };
      }
    }

    /* ══ NON-CASH MONEY MUST BE PROVEN BEFORE A SALE EXISTS ═══════════════════════════
       THE AUTHORITY BOUNDARY, ENFORCED WHERE THE SALE IS DECIDED.

       `requiresCollection()` has existed in pos-collection-proof.js — cash needs no proof,
       everything else does — and was called from NOWHERE. The rule was written down and
       never became an enforcement point, which is the same as not having it.

       What that permitted, traced end to end: the POS card tender routed a Bluetooth or
       "manual" terminal to a client-side SimulatedAdapter that approved on
       `Math.random() > 0.1` with a fabricated authCode, cardLast4 and cardScheme. The
       browser then called this function with a non-cash payment line and no collection
       reference, and a sale was recorded, stock was moved and commission was accrued for
       money nobody had collected. Configure the platform CENTRAL_MOR — the direction of
       travel for merchant-of-record — and that fabricated approval would also have
       credited the business wallet, which is spendable.

       WHY HERE AND NOT IN THE BROWSER. The browser is the thing being defended against.
       It cannot be trusted to decline its own sale, and it cannot manufacture the way past
       this check either: `_collected` is derived on the server by
       CP.verifyAndClaimCollection against the total the server itself computed, from a
       reference the client may name but cannot forge a result for. A caller may send
       `collected: { ok: true }` in any shape it likes; nothing here reads it.

       FAILS CLOSED, AND SAYS WHY. A cashier who has genuinely taken money must be able to
       act on the refusal, so the reason and the remedy travel with it rather than a bare
       "failed-precondition".

       CASH IS UNAFFECTED, DELIBERATELY. Cash is in a drawer, SOKONI never touched it, and
       demanding a collection proof for it would refuse every legitimate cash sale. Its
       existing controls — the drawer reconciliation and the tendered/change arithmetic
       above — are the ones that apply. */
    {
      const CPX = require('./pos-collection-proof');
      /* ── WHICH LINES ARE STILL UNPROVEN ─────────────────────────────────────────────
         THIS WAS TOO BROAD IN ITS FIRST FORM, and the RC sweep caught it. It demanded a
         `collectedIntentRef` for EVERY non-cash line and ignored the confirmation this
         function already performs — the loop above resolves each CONFIRMABLE tender's
         reference against posPaymentStatus (or legacy posPayments), and refuses unless the
         payment is completed, belongs to this shop, covers the amount and has not already
         been spent on another sale. That is collection proof, obtained by a different
         route and if anything a stricter one. Requiring a second, different proof on top
         of it refused sales the server had already fully confirmed: test-sale-authority
         S18 — "a payment the SERVER confirmed does complete the sale", the permitted case
         without which every refusal around it proves nothing — went from PASS to FAIL,
         along with every mixed cash+M-PESA basket.

         The real gap is the one the CONFIRMABLE comment above names: a non-cash method
         that is neither RETIRED nor CONFIRMABLE hits `continue` and skips confirmation
         ENTIRELY. Those are the lines with nothing behind them, and those are what this
         refuses. CONFIRMABLE is referenced rather than restated, so a method added to one
         can never quietly bypass the other. */
      const unproven = _pay.filter((p) => {
        const m = String((p && p.method) || '').toLowerCase();
        if (m === 'cash') return false;          /* in the drawer; nothing to collect */
        if (CONFIRMABLE[m]) return false;        /* the loop above verified and claimed it */
        return true;                             /* non-cash and never confirmed */
      });
      if (unproven.length && !(_collected && _collected.ok === true)) {
        const methods = [...new Set(unproven.map((p) => String((p && p.method) || '?').toLowerCase()))];
        const why = _collected
          ? (_collected.reason || 'collection-not-verified')
          : 'no-collection-reference';
        throw new HttpsError('failed-precondition',
          'This sale cannot be completed: SOKONI has no proof it collected the ' +
          methods.join('/') + ' payment. ' +
          (_collected && _collected.remedy
            ? String(_collected.remedy)
            : 'Take the payment through SOKONI Pay or the SOKONI Till so the collection is ' +
              'confirmed, or tender cash.') +
          ' [' + why + ']');
      }
    }

    const financial = await _postSaleFinancials({
      saleId, merchantId, cashierId, idempotencyKey,
      items: enrichedItems,
      subtotal: serverSubtotal,
      discount: totalDiscount,
      total: authoritativeTotal,
      payments: _pay,
      collected: _collected,
      /* So the drawer figure can be recorded NET of what was handed back. */
      changeDue: changeDue,
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
      /* THE AUTHORISED FIGURE, NOT THE REQUESTED ONE. This recorded
         `loyaltyRedeemPoints` — the count the till asked for — which is the number the
         server may legitimately reduce (a cap, or points worth more than the sale). A
         sale saying 10,000 while the ledger says 200 is precisely the disagreement
         between the sale record and the loyalty ledger that reconciliation cannot
         resolve, and it is the reason both figures are now taken from one authorisation.
         `loyaltyRedeemedKES` is stored beside it so the receipt does not have to
         re-derive the cash value and reach a different answer. */
      loyaltyRedeemed:    _preAuth.approvedPoints || 0,
      loyaltyRedeemedKES: loyaltyRedeemKES,
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
      /* WHERE the money is, per sale: drawer vs provider, split by method. */
      position:           financial.position,
      collectionRoute:    financial.collectionRoute,
      /* WHETHER SOKONI HOLDS THIS MONEY, recorded on the sale itself so reconciliation and
         support can answer it without re-deriving anything. A refusal keeps its reason: a
         sale that failed its collection check is a sale somebody has to look at, and a
         `collected: false` with no explanation is the kind of gap that gets guessed at. */
      collected:          !!(_collected && _collected.ok),
      collectionRef:      (_collected && _collected.ok) ? _collected.ref : null,
      collectionProblem:  (_collected && !_collected.ok) ? _collected.reason : null,
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
      items:      enrichedItems,
      subtotal:   serverSubtotal,
      discount:   totalDiscount,
      tax:        taxTotal,
      total:      authoritativeTotal,
      payments,
      loyaltyAwarded,
      /* The receipt states what was ACTUALLY spent and what it was worth — the same
         pair the sale record and the ledger carry. A receipt quoting the requested
         count would be the one document the customer keeps, disagreeing with both. */
      loyaltyRedeemed: _preAuth.approvedPoints || 0,
      loyaltyRedeemedKES: loyaltyRedeemKES,
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
/* Every lookup is scoped to the CALLER'S customers.

   This function previously searched `posCustomers` collection-wide by phone,
   document id, email or member-card code with no merchant filter at all, and
   returned the customer's name, email, phone, loyalty points, tier, total spent
   and purchase count. Any signed-in account could look up any customer on the
   platform by phone number — and a phone number is guessable, so it was
   enumerable cross-tenant PII disclosure. `merchantId` was accepted but used
   ONLY to fetch the loyalty-programme config, long after the customer had
   already been selected.

   The owner now comes from AUTH (see pos-customer-scope.js) and is part of every
   query rather than a filter applied afterwards — a post-filter still reads the
   other merchant's document into memory before discarding it.

   A miss returns exactly `{ found: false }`, the same shape and the same
   response as a customer that genuinely does not exist. "Exists, but not yours"
   is itself an existence disclosure, so the two cases are indistinguishable. */
const _custScope = require('./pos-customer-scope');

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
    /* CANONICAL config, and NOT conditional on the document existing.
       This read loyaltyPrograms — uncreatable, so `prog` was always null, so `loyalty`
       stayed null, so the till's redeem control never rendered at all. The redemption
       authority refusing was only half the failure; the other half was that a cashier
       could never see the option to try.

       The rate goes through normalizeRewardsRate: the stored field is POINTS PER KES and
       this needs KES PER POINT, and reading it directly would invert rather than convert. */
    const _rates = require('./rewards-rate');
    const progSnap = await _rates.configRef(db, merchantId).get();
    const prog     = progSnap.exists ? progSnap.data() : null;
    {
      const pointValue = _rates.normalizeRewardsRate(prog).pointValueKES;
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
      /* The sale's OWN branch, or nothing. A refund recorded against a placeholder
         branch is a false scope on a financial reversal — the exact record a shift
         dispute turns on. writeAudit normalises it either way. */
      branchId:   sale.branchId || null,
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
  /* branchId is NOT defaulted to a placeholder — this is the call site that produced
     every `branchId: "default"` reprint record in production. Left undefined here and
     normalised by writeAudit, so an unknown scope records as NULL rather than as a
     branch that does not exist. */
  const { orderId, receiptType = 'sale', printerName = null, branchId, merchantId = null } = data || {};
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
  /* A read-only metric filter. An absent branch means ALL branches, which is what the
     caller intends — substituting a placeholder silently filtered to a branch that
     does not exist and returned nothing. */
  const { merchantId, branchId, days = 7 } = data || {};
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

/* ── ONE POSTING PATH, SHARED BY BOTH SALE RAILS ──────────────────────────────────────
   `recordPOSSale` (pos-retail-engine.js) writes sales too and posted NOTHING: no tax, no
   commission accrual, no wallet credit. So a merchant selling through that rail was
   gated on a commission ledger their own sales never wrote to — enforced against an
   empty balance, which is a gate that cannot close.

   Exported rather than reimplemented. Two posting implementations would drift, and the
   one that drifted would be the one nobody was reading. */
module.exports._postSaleFinancials = _postSaleFinancials;