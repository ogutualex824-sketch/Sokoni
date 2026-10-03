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
const _PSE = require('./shared/product-sale-eligibility');   /* owner 2026-10-03: a moderation takedown blocks till sales */
/* The employment authority. Required at LOAD, deliberately: if this cannot be
   resolved the deploy fails loudly, instead of every till silently losing
   discount authorisation and the "Served by" line at the same moment. */
const { resolveActor } = require('./merchant-identity')._internal;
const PSR = require('./pos-stock-restore');   /* the ONE server restock (refund + void), owner 2026-10-03 */
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

function _e(msg, code='invalid-argument', details) {
  throw details ? new HttpsError(code, msg, details) : new HttpsError(code, msg);
}

/* ══ 0b R1 — ONE SALE PER IDEMPOTENCY KEY, WHATEVER FAILS AFTERWARDS ═════════════════════
   The sale id used to be random (`uid()`) and the sale, receipt and daily summary were written
   AFTER the stock transaction. A failure in any of those writes marked the key 'failed'; the
   retry re-claimed it and ran the whole checkout again — a second sale id, a second stock
   deduction, a second loyalty award. The id is now DERIVED from the merchant and the key, and
   the sale, its receipt and its base daily counters are created INSIDE the stock transaction.
   A retry finds the committed sale and completes it instead of selling again. */
const _crypto = require('crypto');
function _saleIdFor(merchantId, idempotencyKey) {
  return 'ps_' + _crypto.createHash('sha256')
    .update(String(merchantId) + '|' + String(idempotencyKey)).digest('hex').slice(0, 40);
}
/* M0-4-DR-R proves a posRetailSales document is THIS writer's sale by re-deriving its id from its own stored facts —
   through this function, never a copy of it. */
exports._saleIdFor = _saleIdFor;
/* 6a — the idempotency record is scoped to the PROVEN merchant. It used to be posIdempotency/{raw client key}: one
   namespace for every merchant, so a replay of another merchant's key returned that merchant's sale and receipt, and one
   merchant's key occupied the same key for all others. Derived here, once; the certification derives it the same way. */
function _idemIdFor(merchantId, idempotencyKey) {
  return 'pi_' + _crypto.createHash('sha256')
    .update(String(merchantId) + '|' + String(idempotencyKey)).digest('hex').slice(0, 40);
}
exports._idemIdFor = _idemIdFor;

/* ══ 0b R4 — A TILL SELLS ONLY ITS OWN PRODUCTS ═════════════════════════════════════════════
   Pricing and the stock deduction read `products/{id}` by id alone. Nothing compared the
   product's owner to the merchant this sale was proven for, so a till could price and deduct
   another shop's stock. A product is sellable here only if it names an owner, every owner field
   is well-formed, and every one of them resolves to THE MERCHANT PROVEN FOR THIS SALE. A product
   with no owner is refused, not assumed: production held 0 such products when this was measured
   (2026-09-27, 102/102 owned, 0 malformed or conflicting), so failing closed costs nothing
   legitimate.

   The accepted identities come ONLY from the authority that proved the merchant:
     · shop_actor (resolveActor): the shop id — which IS the owner's uid (shops/{uid}) — and the
       one business that resolves FROM that proven uid (resolveMerchantIdForOwner);
     · workspace_membership: the business the membership proved, and that business's own owner
       (products are stamped with the owner's uid).
   A `businesses/{merchantId}` record is NOT consulted on the shop path: a business document that
   merely exists under that id is not the authority this sale was admitted by. */
const _PRODUCT_OWNER_FIELDS = ['sellerUid', 'sellerId', 'shopId', 'merchantId', 'storeId', 'ownerId', 'ownerUid'];
async function _merchantOwnerSet(merchantId, provenBy, provenBusinessId) {
  const owners = new Set([String(merchantId)]);
  if (provenBy === 'workspace_membership' && provenBusinessId) {
    owners.add(String(provenBusinessId));
    try {
      const b = await db.collection('businesses').doc(String(provenBusinessId)).get();
      if (b.exists && (b.data() || {}).ownerId) owners.add(String(b.data().ownerId));
    } catch (_) { /* unreadable adds nothing — the set only ever narrows what is accepted */ }
  } else if (provenBy === 'shop_actor') {
    try {
      const own = await _resolveMerchantIdForOwner(String(merchantId));
      if (own && own.ok && own.merchantId) owners.add(String(own.merchantId));
    } catch (_) { /* as above */ }
  }
  return owners;
}
/* ══ L-9A — THE MEMBERSHIP PATH'S OWNERS, BOUND TO ONE READ INSIDE THE STOCK TRANSACTION ════════
   On the membership path the caller is admitted by _assertBusinessPermission, which reads
   businesses/{biz} and admits `ownerId === caller` as the owner. _merchantOwnerSet then read the same
   document AGAIN to add its `ownerId` to the accepted product owners. A change of `ownerId` between
   those two reads (a time-of-check/time-of-use race) let a caller be admitted as owner and then sell
   the NEW owner's products: proven on the emulator (L-9A) — victim stock 10→9, the sale booked to the
   caller's business. The live ruleset (6c67a34d) gives no client a write to `ownerId`; the repository
   rules on this lineage do. The defect is in this code either way.

   So, inside the stock transaction, admission and the owner set are re-derived from ONE transactional
   read of the business (and of the caller's membership in it): the same rule as
   _assertBusinessPermission — the owner, or an active membership holding `sales` — and the owners
   {merchantId, business, its ownerId} taken from that same snapshot. A change of either after the read
   makes the transaction retry (production) or wait (emulator); it can never mix two states. The
   pre-transaction checks above are kept as defence in depth: they refuse early, before any payment is
   claimed, and the transaction is the authority. The shop path does not read `businesses.ownerId` for
   admission and is unchanged. */
function _txnMembershipRefs(callerUid, businessId) {
  return {
    bizRef: db.collection('businesses').doc(String(businessId)),
    memQuery: db.collection('workspaceMemberships')
      .where('uid', '==', String(callerUid))
      .where('businessId', '==', String(businessId))
      .where('status', '==', 'active')
      .limit(1),
  };
}
function _txnMembershipOwners(bizSnap, memSnap, callerUid, merchantId, businessId) {
  const biz = (bizSnap && bizSnap.exists) ? (bizSnap.data() || {}) : null;
  if (!biz) _e('This business could not be confirmed, so the sale was not recorded.', 'permission-denied');
  const isOwner = biz.ownerId === callerUid;
  const mem = (memSnap && !memSnap.empty) ? (memSnap.docs[0].data() || {}) : null;
  const canSell = !!mem && Array.isArray(mem.permissions) && mem.permissions.includes('sales');
  if (!isOwner && !canSell) _e('You are not authorised to record a sale for this shop.', 'permission-denied');
  const owners = new Set([String(merchantId), String(businessId)]);
  if (biz.ownerId) owners.add(String(biz.ownerId));
  return owners;
}

function _assertProductOwned(prod, owners, productId) {
  const p = prod || {};
  const present = _PRODUCT_OWNER_FIELDS.filter((k) => p[k] !== undefined);
  if (!present.length) {
    _e('Product ' + productId + ' has no owner on record, so it cannot be sold here.', 'permission-denied');
  }
  for (const k of present) {
    const v = p[k];
    if (typeof v !== 'string' || !v.trim()) {
      _e('Product ' + productId + ' has an unreadable owner (' + k + '), so it cannot be sold here.', 'permission-denied');
    }
    if (!owners.has(v.trim())) {
      _e('Product ' + productId + ' belongs to another shop.', 'permission-denied');
    }
  }
}

/* ══ Q0a — LOYALTY REDEMPTION AND THE CUSTOMER IT TOUCHES ═════════════════════════════════════
   The transaction wrote `loyaltyPoints = max(0, points + awarded - loyaltyRedeemPoints)` with the
   browser's figure unchecked, on `posCustomers/{customer.id}` with the browser's id unchecked:
     · a NEGATIVE figure minted points (−500 added 500);
     · a non-number either coerced ("5") or wrote NaN into the balance;
     · a positive figure burned points while the SERVER granted nothing for them — the till's
       loyalty discount is not in `discountTotal`, and no server-side price for a point exists on
       this path, so the charged total never moved;
     · the customer could be ANY merchant's customer.
   So: the figure must be a whole, non-negative number, and a non-zero redemption is refused
   outright — honouring one would need a redemption-price authority, and none is invented here.
   Zero stays valid. Production held 5/5 POS sales with loyaltyRedeemed 0 and no posCustomers
   documents when this was measured (2026-09-27), so neither refusal excludes a real sale.

   Ownership is `pos-customer-scope.js`'s rule (body `sellerId`, or the composite id
   `{sellerId}_{phone}`), evaluated against the owners proven for THIS sale (_merchantOwnerSet) —
   never a merchant or relationship the request names. Stricter than the lookup rule in one way:
   a present `sellerId` must itself be well-formed and ours, so a record whose id prefix and body
   disagree is not accepted on the id alone. A customer id that does not exist touches nothing,
   exactly as before. */
const _CUSTOMER_SCOPE = require('./pos-customer-scope');
function _assertCustomerOwned(snap, owners) {
  /* Q0b-1 — the strict rule lives in pos-customer-scope.js (classifyCustomer), the one authority
     every POS customer read and write uses; this only turns its verdict into the sale's refusal. */
  const verdict = _CUSTOMER_SCOPE.classifyCustomer(snap.id, snap.data(), owners);
  if (verdict === 'owned') return;
  if (verdict === 'malformed') {
    _e('This customer record has an unreadable owner, so it cannot be used here.', 'permission-denied');
  }
  if (verdict === 'foreign') _e('This customer belongs to another shop.', 'permission-denied');
  _e('This customer is not on record as a customer of this shop.', 'permission-denied');
}

/* ══ Q0b-1 — WHOSE CUSTOMERS A TILL MAY LOOK UP ══════════════════════════════════════════════
   The request's `merchantId` is a CLAIM. It is proven by the same two authorities the checkout
   admits a sale by — resolveActor (the shop owner and the shop's staff), or the canonical business
   membership — and the accepted customer owners are then _merchantOwnerSet's, exactly as for the
   sale's customer check (Q0a). So a till can look up precisely the customers it can sell to.

   The membership capability is `customers`, the canonical permission for customer work (cashier,
   waiter, receptionist, supervisor, manager hold it) — not the checkout's `sales`, which no default
   role grants. This is a separate helper by decision: the checkout's inline proof is pinned
   verbatim by gate suites and is left untouched; converging the two is workforce-authority work. */
async function _proveCustomerMerchant(callerUid, merchantId) {
  let actor = null;
  try {
    actor = await resolveActor(callerUid, merchantId);
  } catch (_) {
    _e('Staff permissions could not be checked, so no customer was looked up.', 'unavailable');
  }
  if (actor && actor.ok) return { provenBy: 'shop_actor', provenBusinessId: null };
  let canon = null;
  try {
    const b = await db.collection('businesses').doc(String(merchantId)).get();
    if (b.exists) canon = String(merchantId);
    else {
      const own = await _resolveMerchantIdForOwner(String(merchantId));
      if (own && own.ok) canon = own.merchantId;
    }
  } catch (_) { canon = null; }
  if (canon) {
    try {
      await _assertBusinessPermission(callerUid, canon, 'customers');
      return { provenBy: 'workspace_membership', provenBusinessId: canon };
    } catch (_) { /* not a member here, or no `customers` capability */ }
  }
  _e('You are not authorised to look up customers for this shop.', 'permission-denied');
}

/* Q0b-2b — the same proof for another module that serves a till's customer data
   (pos-intelligence posGetCustomerInsights): the owners proven for this caller's merchant claim,
   refused exactly as posLookupCustomer refuses. Not a Cloud Function — index.js re-exports this
   module by name only. */
exports._provenCustomerOwners = async function (callerUid, merchantId) {
  const proof = await _proveCustomerMerchant(callerUid, merchantId);
  return _merchantOwnerSet(merchantId, proof.provenBy, proof.provenBusinessId);
};

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
/* M0-4-DR-R maps a sale's RECORDED route through this same mapper (after refusing any route it does not name, so the
   default branch never decides a reconstructed debt). */
exports._posRailKeyFor = _posRailKeyFor;

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

/* The collection route of a sale — which collection model applied, so reconciliation never assumes. It is
   platform configuration (payment-config) plus the tenders: cash is never centrally collected whatever the
   route says — it is in a drawer — so an all-cash sale is CASH_IN_DRAWER. A payment OUTCOME never enters
   into it. ONE helper: the pre-transaction custody decision and _postSaleFinancials both use it. */
async function _collectionRouteFor(payments) {
  const allCash = (payments || []).every((p) => String(p.method).toLowerCase() === 'cash');
  if (allCash) return 'CASH_IN_DRAWER';
  try {
    const pc = require('./payment-config');
    const r = await pc.resolveCollectionRoute(db);
    return r.route;
  } catch (_) { return 'DIRECT_TO_SELLER'; }
}

async function _postSaleFinancials(o) {
  const out = { status: 'pending', tax: null, commission: null, collectionRoute: null,
                position: null, error: null };
  const toCents = (n) => Math.round((Number(n) || 0) * 100);

  try {
    /* ── which collection model applied, so reconciliation never assumes ──── */
    /* M0-4-DR-A — the route is a SALE fact decided once, before the sale transaction (the debt's custody
       depends on it); the sale carries it and completion reuses it. Only a sale committed before that
       (no route on the record) derives it here, through the same helper. */
    out.collectionRoute = o.collectionRoute || await _collectionRouteFor(o.payments);

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
      /* Not collected at the point of sale — see the note at the call site. */
      collected: false,
      settlement: 'receivable',
    };

    /* ── THE LEDGER ENTRY ──────────────────────────────────────────────────
       M0-1 (owner ruling 2026-09-27): this function NO LONGER posts the ledger entry.
       It used to write a `pos_commission_receivable` entry here, on its own, before the
       sale was written, with a random id and a check-then-set key — a second record of the
       same debt that nothing collected from and that a concurrent retry could duplicate.
       The ONE obligation is now `posCommissionLiabilities/poscomm_<saleId>`, and its ledger
       entry is written WITH it, from its figures, by pos-commission-rail.recordSaleLiability
       (after the sale). `out.commission` above stays on the sale as information only. */

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

/* ══ 0b R1 — COMPLETE A COMMITTED SALE (fresh or resumed) ═════════════════════════════════════
   Everything that happens after the stock transaction, written so that running it again for the
   same sale changes nothing:
     · the financial trace posts once and the sale is updated in place (L-4 port note: on this
       lineage _postSaleFinancials posts NO ledger entry — M0-1 made the ledger entry a projection
       of the debt, written with it by pos-commission-rail.recordSaleLiability);
     · the commission debt (M0-1: posCommissionLiabilities/poscomm_<saleId>, created once) is keyed
       on the (now deterministic) sale id;
     · the money-position daily counters are applied exactly once, behind a flag on the sale,
       inside their own transaction;
     · the metric is written at a deterministic id;
     · the receipt was created with the sale and is only read here. */
async function _completeCommittedSale(o) {
  const { saleId, saleRef, idemRef, merchantId, cashierId, idempotencyKey } = o;
  const metadata = o.metadata || {};
  let sale = (await saleRef.get()).data() || {};

  let financial = { tax: sale.tax, commission: sale.commission, position: sale.position,
                    collectionRoute: sale.collectionRoute, status: sale.financialPosting,
                    error: sale.financialError || null };
  if (sale.financialPosting !== 'posted' && sale.financialPosting !== 'failed') {
    financial = await _postSaleFinancials({
      saleId, merchantId, cashierId, idempotencyKey,
      items: sale.items || [],
      subtotal: sale.subtotal,
      discount: sale.discountTotal,
      total: sale.grandTotal,
      payments: sale.payments || [],
      changeDue: sale.changeDue || 0,
      collectionRoute: sale.collectionRoute || null,
    });
    await saleRef.set({
      tax: financial.tax, commission: financial.commission, position: financial.position,
      collectionRoute: financial.collectionRoute, financialPosting: financial.status,
      financialError: financial.error || null,
    }, { merge: true });
  }

  /* M0-4-DR-A — the commission debt is NO LONGER written here. It was best-effort after the commit:
     a failure left a completed sale with no debt, and because this step then marked the key complete,
     a retry never repaired it. The debt is now created INSIDE the stock transaction, with the sale
     (see prepareSaleDebt / applySaleDebtInTxn there) — the two commit together or not at all. A sale
     committed before this change that lacks a debt is M0-4-DR-R's (reconciliation) to find. */

  /* The money-position counters, exactly once per sale. */
  const dailyRef = db.collection('posDailySummary').doc(`${merchantId}_${sale.saleDate}`);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(saleRef);
    if ((snap.data() || {}).dailyFinancialsApplied === true) return;
    txn.set(dailyRef, {
      cashCents:        FieldValue.increment((financial.position && financial.position.cashCents) || 0),
      electronicCents:  FieldValue.increment((financial.position && financial.position.electronicCents) || 0),
      changeGivenCents: FieldValue.increment((financial.position && financial.position.changeGivenCents) || 0),
      byMethod:         _methodIncrements(financial.position),
      commissionCents:  FieldValue.increment((financial.commission && financial.commission.amountCents) || 0),
      totalTaxCents:    FieldValue.increment((financial.tax && financial.tax.vatCents) || 0),
      updatedAt:        FieldValue.serverTimestamp(),
    }, { merge: true });
    txn.update(saleRef, { dailyFinancialsApplied: true });
  });

  /* Queue metric (cashier speed analytics) — deterministic id, so a resume rewrites the same row. */
  if (metadata.checkoutStartedAt) {
    const _pay = Array.isArray(sale.payments) ? sale.payments : [];
    await db.collection('posCheckoutMetrics').doc(String(saleId)).set({
      merchantId, branchId: sale.branchId, cashierId, saleId,
      itemCount:      (sale.items || []).reduce((s, i) => s + (i.qty || 1), 0),
      durationMs:     Date.now() - metadata.checkoutStartedAt,
      grandTotal:     sale.grandTotal,
      paymentMethod:  (_pay.length === 1 ? String(_pay[0].method) : 'mixed'),
      paymentMethods: _pay.map((p) => String(p.method)),
      createdAt:      FieldValue.serverTimestamp(),
      saleDate:       sale.saleDate,
    });
  }

  const rSnap = await db.collection('posReceipts').doc(String(saleId)).get();
  const receipt = rSnap.exists ? (() => { const r = Object.assign({}, rSnap.data()); delete r.createdAt; return r; })() : null;

  await idemRef.set({ status: 'complete', saleId, receipt, completedAt: Date.now() }, { merge: true });
  return { saleId, receipt, loyaltyAwarded: sale.loyaltyAwarded || 0 };
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
  /* 0b R3 — the TAX POLICY is unchanged here (inclusive vs on-top, and which store is the
     authority, are a separate repair). What changes is only that the caller's figure must be a
     real, non-negative number: a negative taxTotal lowered the charged total with no discount
     authority behind it, and a non-number broke the arithmetic after stock had moved. */
  if (typeof taxTotal !== 'number' || !Number.isFinite(taxTotal) || taxTotal < 0) {
    _e('taxTotal must be a finite, non-negative number');
  }
  /* Q0a — see _assertCustomerOwned. Checked before anything is claimed, priced or charged. */
  /* Number.isInteger is false for every non-number (strings, booleans, null, arrays), NaN and ±Infinity. */
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
      /* Same takedown rule as the real path. */
      const _dblk = _PSE.saleBlock(p);
      if (_dblk) { differences.push({ productId: it.productId, field: 'moderation', error: _dblk.reason }); continue; }
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

  /* ══ 6b — THE TENDER ALLOWLIST ══════════════════════════════════════════════════════════════════════════
     Every tender must be one this checkout can stand behind: cash (the cashier holds it), mpesa or card (CONFIRMED
     against posPayments below, and spent once), or wallet (validated and debited inside the transaction). Anything
     else used to be skipped by the confirmation loop and simply counted towards the total — so a `gift_card`, a
     `manual_till`, a `split` or any invented method name completed a real sale, moved real stock and created a real
     commission debt against money nobody verified. It now fails closed, before any claim, stock or write.
     (Census 2026-09-29: the only caller that newly fails is pos-checkout.html's gift card, whose "redemption" is
     device-local; production holds 0 gift cards. Stored value returns with its own server authority — step 10.)
     Placed after the dry-run return, so the side-effect-free preview is unchanged. */
  /* gift_card (owner P0 2026-10-03): its server authority now exists — the canonical giftCards/{code} is verified and
     debited, with the posGiftCardRedemptions payment record, inside the sale's own transaction (3a below). */
  const _TENDERS = { cash: 1, mpesa: 1, card: 1, wallet: 1, gift_card: 1 };
  for (const p of (Array.isArray(payments) ? payments : [])) {
    const m = String((p && p.method) || '').toLowerCase();
    if (!_TENDERS[m]) {
      _e('This payment method (' + (m || 'none') + ') cannot be accepted at the till. Use cash, or an M-PESA or card ' +
         'payment that SOKONI has confirmed. Nothing has been charged.', 'invalid-argument');
    }
  }

  /* ══ 6a — THE MERCHANT IS PROVEN BEFORE ANYTHING ELSE HAPPENS ══════════════════════════════════════════
     This proof used to run AFTER the idempotency claim, the cached replay and the resume of an existing sale, so a
     caller who was never proven for `merchantId` could claim a key, receive another merchant's cached receipt, or
     resume a record at the merchant's sale id and write that merchant's daily summary. It is the SAME proof, moved
     unchanged: one proven merchant identity then feeds the scoped idempotency key, the sale id, the resume check,
     the stock and debt authority and the receipt. No claim, replay, resume or write happens before it. */
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
  let _provenBusinessId = null;   /* 0b R4 — the business a membership proof established */
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
        _provenBusinessId = _canon;
      } catch (_) { /* not a member here, or no capability */ }
    }
  }
  if (!_merchantProven) {
    _e('You are not authorised to record a sale for this shop.', 'permission-denied');
  }

  /* ── 1. Idempotency claim — atomic ──
     The previous version read, checked, then set: two concurrent requests (double-tap, HTTP
     retry, two till terminals) could both read "not exists" and both proceed — the race window
     in F3. create() is atomic: exactly one caller creates the doc; every other gets
     ALREADY_EXISTS and is routed to the cached result or rejected. */
  const idemRef = db.collection('posIdempotency').doc(_idemIdFor(merchantId, idempotencyKey));
  try {
    await idemRef.create({ status: 'processing', startedAt: Date.now(), cashierId, merchantId, idempotencyKey });
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) {
      const prev = (await idemRef.get()).data() || {};
      /* 6a — a completed result is returned only to the merchant it belongs to (the id is already scoped; this is the
         second, independent check). */
      if (prev.status === 'complete' && String(prev.merchantId || '') !== String(merchantId)) {
        _e('This checkout key belongs to another merchant.', 'permission-denied');
      }
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
      await idemRef.set({ status: 'processing', startedAt: Date.now(), cashierId, merchantId, idempotencyKey,
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

  /* 0b R1/R2 — the sale this key can ever produce, and whether it has COMMITTED. Once the stock
     transaction has committed, the sale exists and the payment it spent is spent: nothing after
     that point may release the payment claim or allow a second sale. */
  const saleId  = _saleIdFor(merchantId, idempotencyKey);
  const saleRef = db.collection('posRetailSales').doc(saleId);
  let _committed = false;

  try {
    /* 0b R1 — a retry of a key whose sale ALREADY COMMITTED completes that sale; it is not
       re-validated (a price changed since must not fail a sale that already happened) and it is
       not sold again. Only the cashier who committed it may resume it. */
    const _prior = await saleRef.get();
    if (_prior.exists) {
      const _p = _prior.data() || {};
      /* 6a — resume ONLY a sale this checkout committed. The id is derived from (merchant, key), but anything else able
         to write that id — the SmartPOS mirror copies a CLIENT-CHOSEN posTransactions id into posRetailSales — used to be
         adopted as a committed sale: completed with no stock movement and no commission debt. The record must carry the
         checkout's own provenance, which the mirror's whitelisted shape can never produce. Anything else fails closed:
         nothing is adopted, charged, moved or summarised, and the key is marked failed. */
      const _ours = _p.source !== 'pos-mirror'
        && String(_p.merchantId || '') === _sanitize(merchantId)
        && String(_p.idempotencyKey || '') === _sanitize(idempotencyKey)
        && (_p.merchantProvenBy === 'shop_actor' || _p.merchantProvenBy === 'workspace_membership')
        && Number.isSafeInteger(_p.soldAtMs);
      if (!_ours) {
        console.error('[posCompleteCheckout] SECURITY — sale id occupied by a record the checkout did not write; refused', {
          saleId, merchantId, cashierId, source: _p.source || null });
        _e('This sale could not be recorded: its sale number is already taken by a record the till did not create. ' +
           'Nothing has been charged.', 'failed-precondition');
      }
      if (String(_p.cashierId || '') !== String(cashierId)) {
        _e('This sale belongs to another cashier.', 'permission-denied');
      }
      _committed = true;
      return await _completeCommittedSale({ saleId, saleRef, idemRef, merchantId, cashierId,
        idempotencyKey, metadata });
    }

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
      /* MODERATION TAKEDOWN (owner 2026-10-03): a product SOKONI has taken down cannot be sold through SOKONI's till,
         whatever the client sends — refused before any price, stock or money effect. Only an AdminOS restore (which
         removes moderationHold) makes it sellable again. A seller's own switch-off (isVisible:false alone) still sells. */
      const _blk = _PSE.saleBlock(prod);
      if (_blk) _e(_sanitize(prod.name || 'This product') + ': ' + _blk.message, 'failed-precondition');
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

    /* 0b R4 — the products priced above must belong to the merchant just proven. Checked on the
       SAME snapshots the prices came from, and again inside the stock transaction below. */
    const _owners = await _merchantOwnerSet(merchantId, _provenBy, _provenBusinessId);
    for (let i = 0; i < items.length; i++) {
      _assertProductOwned(productSnaps[i].data(), _owners, items[i].productId);
    }
    /* Q0a — the customer, if one is named and exists, must be this proven merchant's. Checked
       here, before any payment is verified or claimed, and again on the transaction's own read. */
    if (customer?.id) {
      const _custPre = await db.collection('posCustomers').doc(customer.id).get();
      if (_custPre.exists) _assertCustomerOwned(_custPre, _owners);
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
       of untracked trading that reconciliation can never recover.

       P0 (2026-09-27): `enforceSaleGate` is the ONE switch. It is OFF until a certified
       settlement path exists — see pos-commission-rail GATE_ENFORCED. While off it does not
       read the ledger and never refuses; the liability is still recorded below. */
    try {
      await _posRail().enforceSaleGate(db, String(merchantId), Date.now());
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
    /* 2026-10-03 (owner P0, sokoni-pos): a CLOSED tender list. Every method the server cannot settle was
       counted toward the tendered total with no confirmation at all (e.g. 'bank', 'mpesa_till_manual',
       'gift_card') — a sale could complete on a payment nobody proved. Cash is the drawer's; M-PESA and card
       are confirmed below; wallet is debited inside the transaction. Anything else is refused. */
    /* gift_card (owner P0 2026-10-03, sokoni-5b): admitted ONLY together with its server authority below — the
       canonical giftCards/{code} is verified and debited inside the sale's own transaction. mpesa_till_manual stays
       refused (owner ruling 2026-10-03: a manual till code cannot complete a sale). */
    const SERVER_TENDERS = { cash: 1, mpesa: 1, card: 1, wallet: 1, gift_card: 1 };
    for (const p of _pay) {
      const a = Number(p && p.amount);
      if (!isFinite(a) || a <= 0) _e('Every payment needs a positive amount');
      const m = String((p && p.method) || '').toLowerCase();
      if (!SERVER_TENDERS[m]) _e('This payment method (' + (m || 'none') + ') cannot settle a sale. Take cash or a confirmed M-PESA / card payment.');
      if (p && p.currency !== undefined && p.currency !== null && String(p.currency).toUpperCase() !== 'KES') {
        _e('Payments at the till are in KES only.', 'invalid-argument', { reason: 'WRONG_CURRENCY' });
      }
    }
    /* No bearer credential leaves this function: a gift card leg is stored with the last 4 of its code and its server
       redemption id only; a PIN is never stored (sale, receipt). */
    /* The redemption id must not carry the code (it is stored on the seller-readable sale): a one-way key instead. */
    const _gcKey = (code) => require('crypto').createHash('sha256').update(String(code)).digest('hex').slice(0, 16);
    const _gcNorm = (raw) => { const c = String(raw || '').replace(/[\s-]/g, '').toUpperCase(); return /^[A-Z0-9]{4,32}$/.test(c) ? c.match(/.{1,4}/g).join('-') : null; };
    const _paymentsPublic = _pay.map((p) => {
      const o = Object.assign({}, p); delete o.pin; delete o.balance; delete o.paid; delete o.status;
      if (String(o.method || '').toLowerCase() === 'gift_card') {
        const code = _gcNorm(o.code || o.ref); delete o.code; delete o.ref; delete o.reference;
        o.codeLast4 = code ? code.replace(/-/g, '').slice(-4) : null;
        o.redemptionId = code ? String(saleId) + '_' + _gcKey(code) : null;
      }
      return o;
    });
    const tendered = _round2(_pay.reduce((s, p) => s + Number(p.amount || 0), 0));
    if (tendered + 1 < authoritativeTotal) {
      _e('The payment of ' + tendered + ' does not cover the sale total of ' + authoritativeTotal);
    }
    if (_pay.some((p) => String((p && p.method) || '').toLowerCase() === 'gift_card') && tendered < authoritativeTotal) {
      _e('With a gift card the payment must cover the sale total of ' + authoritativeTotal + ' exactly.', 'invalid-argument', { reason: 'GIFT_CARD_AMOUNT' });
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
    /* `mpesa_daraja` is GONE. Daraja is retired outbound, so a method that can
       never be confirmed must not be listed as confirmable — assertConfirmable
       would refuse it as a legacy document anyway, and advertising it here
       invites a caller to try. */
    const CONFIRMABLE = { mpesa: 1, card: 1 };
    for (const p of _pay) {
      const method = String((p && p.method) || '').toLowerCase();
      if (!CONFIRMABLE[method]) continue;

      const ref = String((p && (p.ref || p.reference || p.checkoutId || p.transactionRef)) || '').trim();
      if (!ref) {
        _e('This ' + method.toUpperCase() + ' payment has no transaction reference, so it ' +
           'cannot be confirmed. Send the payment request and wait for the customer to pay.');
      }

      /* POS/Till convergence — an IntaSend M-PESA PROMPT (postill_ ref) is confirmed from its two
         server-only records, by the SAME certified module; every other reference keeps the QR
         rail below, unchanged. */
      const _own = require('./shared/pos-payment-ownership');
      const _stk = _own.isStkRef(ref);
      if (_stk && method !== 'mpesa') _e('An M-PESA prompt can only settle an M-PESA payment.');
      let pay = null;
      if (!_stk) {
        const paySnap = await db.collection('posPayments').doc(ref).get();
        if (!paySnap.exists) {
          _e('No ' + method.toUpperCase() + ' payment was found for this sale. ' +
             'Nothing has been charged.', 'not-found');
        }
        pay = paySnap.data() || {};
      }

      /* ── MAY THIS PAYMENT SETTLE THIS SALE? — asked of the certified module
         `shared/pos-payment-ownership.js` rather than re-decided here.

         This block used to carry its own status and ownership checks, and both
         were wrong in ways that read as right:

           · it required `completed`, the DARAJA spelling. darajaSTKPush is no
             longer exported, so nothing can reach that status — the gate
             refused every till payment forever. Measured 2026-09-22:
             posPaymentClaims held ZERO rows against five posRetailSales.

           · the shop check was guarded `if (pay.sellerUid && …)`, and a QR
             document carries `sellerId`, NOT `sellerUid`. The condition was
             false, so THE WHOLE CHECK WAS SKIPPED and any shop could confirm
             against another shop's payment. A check that silently does nothing
             when its field is absent is worse than no check, because it reads
             as one.

         assertConfirmable answers both, refuses a legacy Daraja document
         outright whatever status it carries, and treats an owner it cannot
         establish as a REFUSAL. It never writes and never throws.

         Certified by scripts/certify-pos-payment-ownership.js, whose W7-1..W7-4
         assert exactly this wiring. See Amendment A.1.5. */
      let _confirm;
      if (_stk) {
        const [iSnap, sSnap] = await Promise.all([
          db.collection('posPaymentIntents').doc(ref).get(),
          db.collection('posPaymentStatus').doc(ref).get(),
        ]);
        _confirm = _own.assertConfirmableStk(iSnap.exists ? iSnap.data() : null,
          sSnap.exists ? sSnap.data() : null, { merchantId, idempotencyKey });
      } else {
        _confirm = _own.assertConfirmable(pay, { merchantId, cashierId });
      }
      if (!_confirm.ok) {
        _e(_confirm.message,
           _confirm.reason === 'wrong_shop' ? 'permission-denied'
             : _confirm.reason === 'no_document' ? 'not-found'
               : 'failed-precondition');
      }

      /* And it must be enough. A 3,000 sale cannot be settled with a confirmed
         10 shilling payment just because a reference was pasted in. The module
         returns the GATEWAY's figure; the sufficiency decision stays here,
         because only this caller knows what the sale is claiming. */
      const confirmedAmount = Number(_confirm.amount);
      /* 6b — a confirmation with no readable amount proves nothing: it is refused, not waved through. */
      if (!isFinite(confirmedAmount) || confirmedAmount + 1 < Number(p.amount || 0)) {
        _e(!isFinite(confirmedAmount)
          ? 'The payment provider did not report an amount for this payment, so it cannot settle the sale.'
          : 'The confirmed payment is ' + confirmedAmount + ' but this sale is claiming ' + p.amount + '.');
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
      if (pay && pay.mpesaCode) p.mpesaCode = pay.mpesaCode;
      if (pay && pay.paidPhone) p.paidPhone = pay.paidPhone;
      /* STK rail: the webhook records the reference, not the M-PESA receipt code — so none is
         claimed here. The line says which rail confirmed it and against what. */
      if (_stk) { p.provider = 'intasend'; p.rail = 'stk'; p.providerRef = ref; }
    }

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

    const now      = Date.now();
    const saleDate = new Date(now).toISOString().split('T')[0];
    /* M0-4-DR-A — the sale's own custody fact, fixed BEFORE the transaction: platform configuration plus the
       tenders, never a payment outcome. The sale carries it; the debt's rail and completion both read it. */
    const _saleRoute = await _collectionRouteFor(payments);

    /* ── 3a. Gift cards (owner P0 2026-10-03). The browser's balance, "paid" flag and reference are ignored. Each card
       is read from the canonical giftCards/{code} (pos-completeness shape) and debited in the transaction below;
       the AUTHORITATIVE payment record is posGiftCardRedemptions/{saleId}_{code}, bound to this sale, merchant,
       amount and KES. saleId is deterministic per (merchant, idempotencyKey), so a duplicate / replay / retry finds
       the same record and debits nothing again. No second gift-card ledger: the card's balance + redemptions are it. */
    const giftLegs = new Map();
    for (const p of _pay) {
      if (String((p && p.method) || '').toLowerCase() !== 'gift_card') continue;
      const code = _gcNorm(p.code || p.ref);
      if (!code) _e('Enter the gift card code.', 'invalid-argument', { reason: 'GIFT_CARD_CODE_REQUIRED' });
      const prev = giftLegs.get(code);
      giftLegs.set(code, { amount: _round2((prev ? prev.amount : 0) + Number(p.amount)), pin: (p.pin === undefined || p.pin === null) ? (prev ? prev.pin : null) : String(p.pin) });
    }
    const giftRefs = [...giftLegs.keys()].map((code) => ({ code,
      card: db.collection('giftCards').doc(code),
      rec:  db.collection('posGiftCardRedemptions').doc(String(saleId) + '_' + _gcKey(code)) }));

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

    /* 0b R1 — built BEFORE the transaction, created INSIDE it. */
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
      items:           enrichedItems,
      customer:        customer ? {
        id:    _sanitize(customer.id || ''),
        name:  _sanitize(customer.name || 'Guest'),
        phone: _sanitize(customer.phone || ''),
      } : null,
      payments: _paymentsPublic,
      couponCode:         couponCode ? _sanitize(couponCode) : null,
      couponDiscount,
      loyaltyRedeemed:    loyaltyRedeemPoints,
      loyaltyAwarded:     0,           /* set inside the transaction */
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
      tax:                null,
      commission:         null,
      /* WHERE the money is, per sale: drawer vs provider, split by method. */
      position:           null,
      collectionRoute:    _saleRoute,
      /* M0-4-DR-A — the sale's own time, the one its debt is dated by (never a later completion's). */
      soldAtMs:           now,
      /* HOW the merchant was proven for this sale — shop_actor (owner/shopEmployees) or
         workspace_membership. Recorded so an audit can tell which authority admitted the
         sale, rather than inferring it from a role months later. */
      merchantProvenBy:   _provenBy,
      financialPosting:   'pending',
      financialError:     null,
      changeDue,
      tendered,
      dailyFinancialsApplied: false,

    };


    const receipt = {
      receiptNo:  saleId.slice(-8).toUpperCase(),
      saleId,
      merchantId,
      items:      enrichedItems,
      subtotal:   serverSubtotal,
      discount:   totalDiscount,
      tax:        taxTotal,
      total:      authoritativeTotal,
      payments: _paymentsPublic,
      loyaltyAwarded:  0,             /* set inside the transaction */
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


    const receiptRef = db.collection('posReceipts').doc(saleId);
    const dailyRef   = db.collection('posDailySummary').doc(`${merchantId}_${saleDate}`);

    /* M0-4-DR-A — THE COMMISSION DEBT, planned from the sale's own facts BEFORE the transaction (the
       business lookup is a read that cannot sit in a write phase), created INSIDE it with the sale. If the
       debt cannot be planned, the sale is not recorded — a completed sale without its debt is exactly
       the state this unit removes. A custodial sale (SOKONI holds the money) plans no debt, as before. */
    let _debtPlan;
    try {
      const _P  = require('./pos-sale-commission');
      const _MA = require('./money-authority');
      _debtPlan = await _posRail().prepareSaleDebt(db, _P.planSaleCommission({
        rail:        _posRailKeyFor(_saleRoute),
        gross:       _MA.fromMinor(Math.round(Number(authoritativeTotal || 0) * 100)),
        planId:      null,
        soldAtMs:    now,
        saleId:      String(saleId),
        merchantUid: String(merchantId),
      }));
    } catch (planErr) {
      console.error('[posCompleteCheckout] commission debt could not be planned — sale refused', {
        saleId, merchantId, error: planErr && planErr.message,
      });
      _e('The commission for this sale could not be recorded, so the sale was not recorded. Nothing has been charged.', 'unavailable');
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

      /* L-9A — on the membership path, the business and the caller's membership are read here too. */
      const _memRefs = _provenBy === 'workspace_membership' ? _txnMembershipRefs(cashierId, _provenBusinessId) : null;
      /* M0-4-DR-A — the debt and its ledger projection are read here too (create-only writes follow). */
      const _debtRefs = _debtPlan && !_debtPlan.none ? _debtPlan.refs : null;
      const [saleSnap, wTxSnap, wSnap, custSnap, progSnap, bizTxSnap, memTxSnap, debtSnap, ledgerSnap, ...productSnaps] = await Promise.all([
        txn.get(saleRef),
        walletPayment ? txn.get(walletTxRef)  : Promise.resolve(null),
        walletPayment ? txn.get(walletDocRef) : Promise.resolve(null),
        custRef ? txn.get(custRef) : Promise.resolve(null),
        progRef ? txn.get(progRef) : Promise.resolve(null),
        _memRefs ? txn.get(_memRefs.bizRef)   : Promise.resolve(null),
        _memRefs ? txn.get(_memRefs.memQuery) : Promise.resolve(null),
        _debtRefs ? txn.get(_debtRefs[0]) : Promise.resolve(null),
        _debtRefs ? txn.get(_debtRefs[1]) : Promise.resolve(null),
        ...productRefs.map(r => txn.get(r)),
      ]);
      const giftSnaps = await Promise.all(giftRefs.map((g) => Promise.all([txn.get(g.card), txn.get(g.rec)])));

      /* 0b R1 — another attempt with this key committed first (a concurrent re-claim of a failed
         key). That sale stands; this attempt writes NOTHING — no stock, no wallet, no loyalty. */
      if (saleSnap.exists) return { loyaltyAwarded: (saleSnap.data() || {}).loyaltyAwarded || 0, alreadyCommitted: true };

      /* ── PHASE 2: VALIDATE (no writes yet, so a rejection touches nothing) ── */
      /* Wallet: idempotent skip if the deterministic txn doc already exists (prior attempt). */
      const doWalletDeduct = walletPayment && !wTxSnap.exists;
      if (doWalletDeduct) {
        const bal = wSnap.exists ? (wSnap.data().balance ?? 0) : -1;
        if (bal < walletAmt)
          throw new HttpsError('failed-precondition',
            `Insufficient wallet balance: has KES ${Math.max(0, bal)}, needs KES ${walletAmt}`);
      }
      /* L-9A — the owners the in-transaction checks use: on the membership path, admission and owners
         re-derived from the transaction's own read of the business; on the shop path, unchanged. */
      const _txOwners = _memRefs
        ? _txnMembershipOwners(bizTxSnap, memTxSnap, cashierId, merchantId, _provenBusinessId)
        : _owners;
      /* Q0a — customer ownership re-checked on the transaction's own read. */
      if (custSnap && custSnap.exists) _assertCustomerOwned(custSnap, _txOwners);
      /* Gift cards: real, this shop's, active, unexpired, KES, PIN-matched, funded — or nothing is written. */
      const giftDebits = [];
      giftRefs.forEach((g, i) => {
        const [cSnap, rSnap] = giftSnaps[i];
        if (rSnap.exists) {
          const rr = rSnap.data() || {};
          if (String(rr.saleId) !== String(saleId)) throw new HttpsError('failed-precondition', 'That gift card payment belongs to another sale.', { reason: 'GIFT_CARD_WRONG_SALE' });
          return;                                                         /* this sale already redeemed it */
        }
        const want = giftLegs.get(g.code);
        if (!cSnap.exists) throw new HttpsError('failed-precondition', 'That gift card was not found. Nothing has been charged.', { reason: 'GIFT_CARD_NOT_FOUND' });
        const c = cSnap.data() || {};
        const _shops = [merchantId, _provenBusinessId].filter(Boolean).map(String);
        if (!_shops.includes(String(c.shopId || ''))) throw new HttpsError('failed-precondition', 'That gift card is not valid at this shop.', { reason: 'GIFT_CARD_OTHER_SHOP' });
        if (c.status !== 'active') throw new HttpsError('failed-precondition', 'That gift card is ' + String(c.status || 'not active') + '.', { reason: 'GIFT_CARD_NOT_ACTIVE' });
        if (c.currency && String(c.currency).toUpperCase() !== 'KES') throw new HttpsError('failed-precondition', 'That gift card is not in KES.', { reason: 'GIFT_CARD_CURRENCY' });
        if (c.expiryDate && typeof c.expiryDate.toMillis === 'function' && c.expiryDate.toMillis() < Date.now()) {
          throw new HttpsError('failed-precondition', 'That gift card has expired.', { reason: 'GIFT_CARD_EXPIRED' });
        }
        if (c.pin && String(c.pin) !== String(want.pin || '')) throw new HttpsError('permission-denied', 'The gift card PIN is wrong.', { reason: 'GIFT_CARD_PIN' });
        const bal = Number(c.balance);
        if (!isFinite(bal) || Math.round(bal * 100) < Math.round(want.amount * 100)) {
          throw new HttpsError('failed-precondition', 'The gift card balance is KES ' + (isFinite(bal) ? bal : 0) + ', not enough for KES ' + want.amount + '.', { reason: 'GIFT_CARD_BALANCE' });
        }
        giftDebits.push({ g, amount: want.amount, newBalance: _round2(bal - want.amount) });
      });

      /* Inventory: assert stock before deducting anything. */
      productSnaps.forEach((snap, i) => {
        const item = enrichedItems[i];
        /* 6b — typed, so an offline till syncing this sale can tell a REFUSAL (never retried) from an outage
           (retried with the same key). A plain Error left here surfaced as `internal` — indistinguishable from a crash. */
        if (!snap.exists) throw new HttpsError('not-found', `Product ${item.productId} disappeared`);
        const prod  = snap.data();
        /* 0b R4 — ownership re-checked on the transaction's own read (owners bound to it: L-9A). */
        _assertProductOwned(prod, _txOwners, item.productId);
        /* Canonical stock field is `stock`; fall back to legacy names for older docs. */
        const stock = prod.stock ?? prod.stockQty ?? prod.quantity ?? 9999;
        if (stock < (item.qty || 1) && prod.trackInventory !== false)
          throw new HttpsError('failed-precondition', `Insufficient stock for ${prod.name}`);
      });

      /* ── PHASE 3: ALL WRITES ── */
      for (const d of giftDebits) {
        txn.update(d.g.card, { balance: d.newBalance, status: d.newBalance <= 0 ? 'redeemed' : 'active',
          redemptions: FieldValue.arrayUnion({ amount: d.amount, saleId: String(saleId), by: String(cashierId || (auth && auth.uid) || ''), at: new Date(now).toISOString() }),
          updatedAt: FieldValue.serverTimestamp() });
        txn.set(d.g.rec, { code: d.g.code, saleId: String(saleId), merchantId: String(merchantId), idempotencyKey: String(idempotencyKey),
          amount: d.amount, currency: 'KES', saleTotal: authoritativeTotal, balanceAfter: d.newBalance, status: 'captured',
          at: FieldValue.serverTimestamp() });
      }
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

      /* 0b R1 — the sale, its receipt and the base daily counters commit WITH the stock. */
      txn.create(saleRef, Object.assign({}, sale, { loyaltyAwarded }));
      txn.create(receiptRef, Object.assign({}, receipt, { loyaltyAwarded, createdAt: FieldValue.serverTimestamp() }));
      /* M0-4-DR-A — and the commission debt + its ledger projection, in the SAME commit: both or neither. */
      _posRail().applySaleDebtInTxn(txn, _debtPlan, debtSnap, ledgerSnap);
      txn.set(dailyRef, {
        merchantId, branchId, saleDate,
        totalSales:    FieldValue.increment(1),
        totalRevenue:  FieldValue.increment(authoritativeTotal),
        totalItems:    FieldValue.increment(items.reduce((s, i) => s + (i.qty || 1), 0)),
        totalDiscount: FieldValue.increment(totalDiscount),
        totalTax:      FieldValue.increment(taxTotal),
        updatedAt:     FieldValue.serverTimestamp(),
      }, { merge: true });

      return { loyaltyAwarded };
    });

    /* 0b R1 — the stock transaction COMMITTED this sale (or found it already committed).
       From here on nothing may release the payment claim or sell again: the rest is the
       resumable completion, the same code a retry runs. */
    _committed = true;
    return await _completeCommittedSale({ saleId, saleRef, idemRef, merchantId, cashierId,
      idempotencyKey, metadata });

  } catch (err) {
    /* RELEASE any confirmed payment this attempt claimed. The money is still the
       customer's — the sale simply did not complete — and leaving the claim in
       place would make their genuinely paid M-PESA unusable on the retry, which
       is a worse outcome than the failure itself. Released before the failure is
       recorded, so a crash between the two leaves the claim rather than losing it. */
    /* 0b R2 — ONLY if nothing committed. After the stock transaction the sale exists and has
       spent this payment; releasing the claim then let the same confirmed M-PESA fund a second
       sale under a new key. A failure after commit is completed by the retry instead. */
    if (!_committed) {
      for (const ref of _consumed) {
        try { await db.collection('posPaymentClaims').doc(ref).delete(); } catch (_) {}
      }
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
  const callerUid = await _assertAuth(auth);
  const { query, method = 'auto', merchantId } = data || {};
  if (!query || typeof query !== 'string' || !query.trim() || query.length > 200) _e('query required');
  if (!merchantId || typeof merchantId !== 'string') _e('merchantId required');

  /* Q0b-1 — every lookup is scoped to the customers of the merchant PROVEN for this caller (see
     _proveCustomerMerchant). Previously this searched posCustomers platform-wide by phone, id, email
     and member card and returned name, phone, email, points, tier and spend: enumerable
     cross-tenant PII. A miss and "exists but belongs to someone else" are the same `{found:false}`;
     telling them apart would itself disclose that the customer exists. */
  const proof  = await _proveCustomerMerchant(callerUid, merchantId);
  const owners = await _merchantOwnerSet(merchantId, proof.provenBy, proof.provenBusinessId);

  const q   = query.trim();
  let doc   = null;

  if (method === 'phone' || method === 'auto') {
    const phone = q.replace(/\s/g, '').replace(/^0/, '+254');
    doc = await _CUSTOMER_SCOPE.findOwnedByPhone(db, owners, [phone, q], q);
  }
  if (!doc && (method === 'id' || method === 'auto')) {
    doc = await _CUSTOMER_SCOPE.getOwnedIn(db, owners, q);
  }
  if (!doc && (method === 'email' || method === 'auto')) {
    doc = await _CUSTOMER_SCOPE.findOwnedIn(db, owners, 'email', q.toLowerCase());
  }
  if (!doc && (method === 'memberCard' || method === 'auto')) {
    doc = await _CUSTOMER_SCOPE.findOwnedIn(db, owners, 'memberCardCode', q.toUpperCase());
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

/* ════════════════════════════════════════════════════════════════
   posVoidSale — void a completed till sale and return its stock, ON APPROVAL, exactly once (owner 2026-10-03, via
   sokoni-5b; ported in shape from the certified B9.34 rail on slice/realtime-control-plane).

   AUTHORITY = the APPROVAL. A cashier may ASK (createApprovalRequest type 'void', bound to the sale); a manager/owner
   reviews it; only a presented, approved, unexpired, unspent 'void' approval bound to THIS sale lets this run. The
   executing caller must still belong to the shop with `sell` (resolveActor), so a stranger holding an approval id
   cannot spend it. The approval is CONSUMED INSIDE the same transaction as the restore, so a failure leaves both
   untouched, and the approval id IS the operation id: a retry of the same void is an idempotent no-op; a different
   approval against an already-void sale is refused (it would return the stock twice).

   ZERO MONEY. A void moves no money and no entitlement: it touches the sale, products, stockMovements and the
   approval — never gift cards, loyalty, wallets or tickets — so it cannot recreate anything the buyer consumed.
   A refunded sale cannot be voided; a voided sale cannot be refunded (posProcessRefund re-checks in its transaction).
════════════════════════════════════════════════════════════════ */
exports.posVoidSale = onCall(cfgHeavy, async ({ data, auth }) => {
  const { saleId, merchantId, approvalId, reason } = data || {};
  if (!auth || !auth.uid) _e('Authentication required', 'unauthenticated');
  if (!saleId)     _e('saleId required');
  if (!merchantId) _e('merchantId required');
  if (!approvalId) _e('A manager must approve this void first.', 'failed-precondition');
  if (!reason)     _e('void reason required');

  const actor = await resolveActor(auth.uid, String(merchantId));
  if (!actor || !actor.ok || !(actor.capabilities || []).includes('sell')) {
    _e('You do not work at this shop.', 'permission-denied');
  }
  const actorUid = auth.uid;
  const { _approvals } = require('./pos-staff-ops');
  const saleRef = db.collection('posRetailSales').doc(_sanitize(String(saleId)));
  const opId = 'void_' + _sanitize(String(approvalId));
  let restock = [];
  let idempotent = false;

  await db.runTransaction(async (txn) => {
    restock = []; idempotent = false;
    /* ── EVERY READ ── */
    const saleSnap = await txn.get(saleRef);
    if (!saleSnap.exists) _e('Sale not found', 'not-found');
    const sale = saleSnap.data() || {};
    if (sale.merchantId !== merchantId) _e('Unauthorized', 'permission-denied');
    if (sale.status === 'voided') {
      if (sale.voidApprovalId === String(approvalId)) { idempotent = true; return; }
      _e('That sale has already been voided.', 'failed-precondition');
    }
    if (sale.status === 'refunded') _e('A refunded sale cannot be voided. The money has already gone back.', 'failed-precondition');
    if (sale.status !== 'completed') _e('Only a completed sale can be voided.', 'failed-precondition');

    const lines = PSR.allLines(sale);
    if (!lines.length) _e('That sale records no line items, so its stock cannot be restored.', 'failed-precondition');
    if (lines.some((l) => !l.productId)) {
      _e('That sale does not identify its products, so voiding it would leave the stock short.', 'failed-precondition');
    }
    const prodRefs = lines.map((l) => db.collection('products').doc(l.productId));
    const prodSnaps = await Promise.all(prodRefs.map((r) => txn.get(r)));
    const missing = lines.filter((l, i) => !prodSnaps[i].exists).map((l) => l.productId);
    if (missing.length) _e('A product on that sale no longer exists, so its stock cannot be returned.', 'failed-precondition');

    /* ── THE APPROVAL: read + spent here, after the reads, before the writes ── */
    await _approvals.consume(String(approvalId), {
      sellerId: String(merchantId), type: 'void', binding: { saleId: String(saleId) }, consumerUid: actorUid,
    }, txn);

    /* ── EVERY WRITE ── */
    restock = PSR.writeRestore(txn, { db, FieldValue, opId, kind: 'void', actorUid, reason, saleId: String(saleId), shopId: merchantId },
      lines, prodRefs, prodSnaps);
    txn.update(saleRef, {
      status: 'voided', voidedAt: FieldValue.serverTimestamp(), voidedBy: actorUid,
      voidReason: _sanitize(String(reason)).slice(0, 500), voidApprovalId: String(approvalId),
      voidStockRestored: restock.filter((r) => r.restored).length,
    });
  });

  if (!idempotent) {
    writeAudit(db, {
      action: 'pos.void', actorUid, actorRole: (actor.servedBy && actor.servedBy.role) || null, branchId: 'default',
      objectType: 'order', objectId: String(saleId), before: { status: 'completed' }, after: { status: 'voided' },
      delta: 0, reason: reason || null, metadata: { merchantId, approvalId, restock },
    });
  }
  return { saleId: String(saleId), status: 'voided', restock, idempotent };
});

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
  /* A replay of the refund that already closed this sale falls through to the transaction, which answers it as an
     idempotent no-op; any OTHER refund of a refunded sale is refused here (and again, authoritatively, in the txn). */
  const _replayId = 'rf_' + String(idempotencyKey || saleId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  if (sale.status === 'refunded' && sale.refundId !== _replayId) _e('Sale already fully refunded');

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
  let restock = [];
  const alreadyDone = await db.runTransaction(async txn => {
    /* ── ALL READS FIRST — including the SALE, re-read here ──
       The status check above runs outside this transaction, and the refund id comes from the caller's key, so two
       refunds sent with DIFFERENT keys could both pass it and return the stock twice. The authoritative check is this
       in-transaction read: a sale is refunded once. (Owner 2026-10-03: stock comes back exactly once, on approval.) */
    const prodRefs = items.map(it => db.collection('products').doc(String(it.productId)));   /* canonical — symmetric with sale deduction */
    const [refundSnap, saleNow, ...prodSnaps] = await Promise.all([
      txn.get(refundRef),
      txn.get(saleRef),
      ...prodRefs.map(r => txn.get(r)),
    ]);

    if (refundSnap.exists) return true;            // idempotent replay — change nothing
    const cur = (saleNow.exists && saleNow.data()) || {};
    if (cur.merchantId !== merchantId) _e('Unauthorized', 'permission-denied');
    if (cur.status === 'refunded') _e('Sale already fully refunded', 'failed-precondition');
    if (cur.status === 'voided') _e('A voided sale cannot be refunded.', 'failed-precondition');

    /* Validate against the original sale BEFORE writing anything (quantities requested, prices from the sale). */
    let plan;
    try { plan = PSR.planLines(cur, items); } catch (err) { _e(err.message, 'invalid-argument'); }
    refundTotal = Math.round(plan.reduce((t, l) => t + l.unitPrice * l.qty, 0) * 100) / 100;

    /* ── WRITES ── the stock leg is the shared restore: metered lines only, one ledger row per line (create()). */
    restock = PSR.writeRestore(txn, {
      db, FieldValue, opId: refundId, kind: 'refund', actorUid: managerId, reason, saleId, shopId: merchantId,
    }, plan, prodRefs, prodSnaps);

    txn.set(refundRef, {
      id:          refundId,
      saleId,
      merchantId:  _sanitize(merchantId),
      items:       plan.map(x => ({ productId: x.productId, qty: x.qty })),
      refundTotal,
      refundMethod,
      reason:      _sanitize(reason),
      processedBy: managerId,
      /* WHO AUTHORISED IT, when an approval was presented. Null is honest: it means nobody approved it separately
         (the manager/owner refunding is the approval), not that the approver is unknown. */
      approvalId:  approvalReceipt ? approvalReceipt.approvalId : null,
      approvedBy:  approvalReceipt ? (approvalReceipt.reviewedBy || null) : null,
      requestedBy: approvalReceipt ? (approvalReceipt.requestedBy || null) : null,
      stockRestored: restock.filter(r => r.restored).map(r => ({ productId: r.productId, qty: r.qty })),
      stockNotRestored: restock.filter(r => !r.restored).map(r => ({ productId: r.productId, qty: r.qty, reason: r.reason })),
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

  return { refundId, refundTotal, idempotent: alreadyDone, restock };
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

