'use strict';
/**
 * SOKONI — M0-4-DR-R: DETERMINISTIC RECONCILIATION of POS commission debts (a BACKSTOP, not a debt path)
 * functions/pos-debt-reconciliation.js
 *
 * M0-4-DR-A made normal debt creation atomic: a POS sale and its `poscomm_<saleId>` debt commit together, or not at
 * all. This module exists only for the residue — a proven, completed, commission-bearing sale that nevertheless has no
 * debt (historical records, exceptional states). For ordinary sales it is expected to find nothing.
 *
 *     completed sale → poscomm_<saleId> → exists? ── yes → done (never altered)
 *                                          └─ no → every prerequisite PROVEN from the sale's own recorded facts?
 *                                                    ├─ yes → the SAME DR-A builder, create-only  → RECONSTRUCTED
 *                                                    └─ no  → NEEDS_REVIEW (a reason code, never a guess)
 *
 * ── WHAT A CANDIDATE IS (owner-approved 2026-09-28) ─────────────────────────────────────────────────────────────────
 * Derived from the sale record and the rail's own commission semantics — never from whether a debt happens to exist:
 *   · a PROVEN SERVER SALE
 *       posRetailSales: its id re-derives from its own stored merchantId + idempotencyKey through the checkout's ONE
 *                       derivation (pos-zero-friction _saleIdFor). SmartPOS mirror sales (source 'pos-mirror') are OUT
 *                       OF SCOPE — they are the SmartPOS convergence unit's, and billing them here would make this a
 *                       second debt path;
 *       posSales:       exactly one posRecordSaleClaims record names it, for the same seller (M0-2, same commit);
 *   · COMMITTED AS COMPLETED, with no void or refund (status, or any posRefunds record for it). Void/refund
 *     economics belong to M0-5 → NEEDS_REVIEW;
 *   · COMMISSION-BEARING: pos-sale-commission.planSaleCommission over ONLY the recorded facts — the recorded rail
 *     (collectionRoute; TILL_DIRECT for recordPOSSale), the recorded gross, the authoritative sale time `soldAtMs`,
 *     the sale id and merchant — returns createsLiability.
 * A missing or malformed fact is NEEDS_REVIEW. Nothing is defaulted: no Date.now() for a sale time, no 0 for a gross,
 * no TILL_DIRECT for an unknown route, no createdAt promoted into soldAtMs.
 *
 * ── THE RATE ERA ────────────────────────────────────────────────────────────────────────────────────────────────────
 * planSaleCommission prices a sale with the rate table in the RUNNING code (commission-config.resolvePosRate).
 * Rebuilding an old sale with it would silently reprice history (production has charged 3% before this rail). A sale is
 * reconstructable only if it provably belongs to the rate era that table describes: RATE_ERA below is an immutable,
 * versioned record of (a) the fingerprint of the rate table it was written for — checked against the running table,
 * so any rate change invalidates the era — and (b) `fromSoldAtMs`, the deployment boundary from which production runs
 * this rail. The boundary is NULL until the deployment that first puts this rail in production fixes it (M0-6); while
 * it is null NO sale is in the era, and DR-R reconstructs nothing. The era is never a caller input.
 *
 * ── TWO MODES ───────────────────────────────────────────────────────────────────────────────────────────────────────
 *   dry_run  (default) evaluate and report. Writes NOTHING — no debt, no outcome record.
 *   execute  for each candidate: re-read the sale, its debt, its ledger row and every eligibility fact INSIDE one
 *            transaction and judge again; only then create the debt + ledger projection (create-only) and ONE outcome
 *            record, together. A sale that changed since the evaluation is judged on what it is now.
 * Outcome records (posDebtReconciliation/poscomm_<saleId>) are created once: RECONSTRUCTED, or NEEDS_REVIEW with a
 * reason code. They are a log of this backstop's decisions, not a debt authority; resolving a NEEDS_REVIEW is M0-5's.
 * Admin SDK only (no client rule opens the collection).
 *
 * NEVER: prices, category configuration, payment status, collection, wallets, the till gate, a second builder or
 * schema, an existing debt altered.
 */

const crypto = require('crypto');

const RAIL = require('./pos-commission-rail');
const PSC = require('./pos-sale-commission');
const MA = require('./money-authority');
const CC = require('./commission-config');
const PC = require('./payment-config');

const OUTCOMES = 'posDebtReconciliation';
const RETAIL_SALES = 'posRetailSales';
const RECORDED_SALES = 'posSales';
const RECORD_CLAIMS = 'posRecordSaleClaims';
const REFUNDS = 'posRefunds';
const STORES = Object.freeze([RETAIL_SALES, RECORDED_SALES]);
const MAX_PAGE = 100;

const VERDICT = Object.freeze({
  RECONSTRUCTABLE: 'RECONSTRUCTABLE',   /* dry-run: every prerequisite proven, no debt */
  RECONSTRUCTED:   'RECONSTRUCTED',     /* execute: debt + projection + outcome created together */
  NEEDS_REVIEW:    'NEEDS_REVIEW',
  DEBT_PRESENT:    'DEBT_PRESENT',      /* the debt and its projection exist — nothing to do, never altered */
  NOT_OWED:        'NOT_OWED',          /* a proven sale whose recorded facts owe no debt (custodial / zero) */
  OUT_OF_SCOPE:    'OUT_OF_SCOPE',      /* not a server sale (SmartPOS mirror) — another unit's */
  OUTCOME_ALREADY_RECORDED: 'OUTCOME_ALREADY_RECORDED',
});

const REASON = Object.freeze({
  SALE_MISSING:              'SALE_MISSING',
  MIRROR_SALE:               'MIRROR_SALE',
  SALE_IDENTITY_UNPROVEN:    'SALE_IDENTITY_UNPROVEN',
  PROJECTION_MISSING:        'PROJECTION_MISSING',          /* debt present, its ledger projection absent */
  LEDGER_WITHOUT_DEBT:       'LEDGER_WITHOUT_DEBT',
  LEGACY_RECEIVABLE_PRESENT: 'LEGACY_RECEIVABLE_PRESENT',   /* pre-rail pos_commission_receivable — billing again would double-charge */
  SALE_VOIDED_OR_REFUNDED:   'SALE_VOIDED_OR_REFUNDED',
  SALE_NOT_COMPLETED:        'SALE_NOT_COMPLETED',
  SOLD_AT_MISSING:           'SOLD_AT_MISSING',
  ROUTE_UNPROVEN:            'ROUTE_UNPROVEN',
  GROSS_UNPROVEN:            'GROSS_UNPROVEN',
  RATE_ERA_UNPROVEN:         'RATE_ERA_UNPROVEN',
  PLAN_FAILED:               'PLAN_FAILED',
  BUSINESS_UNRESOLVED:       'BUSINESS_UNRESOLVED',
  CUSTODIAL_OR_ZERO:         'CUSTODIAL_OR_ZERO',
});

/* The rate table's fingerprint: every input resolvePosRate / planSaleCommission take from configuration. */
function rateTableFingerprint() {
  const plans = Object.keys(CC.POS_PLAN_RATES).sort().map((k) => [k, CC.POS_PLAN_RATES[k].rateFraction, CC.POS_PLAN_RATES[k].floorExempt]);
  return crypto.createHash('sha256')
    .update(JSON.stringify({ plans, defaultPlan: CC.POS_DEFAULT_PLAN, minCommissionKes: CC.MIN_COMMISSION_KES }))
    .digest('hex');
}

/* IMMUTABLE. A new rate table is a new era (a new id and fingerprint), never an edit of this one. */
const RATE_ERA = Object.freeze({
  id: 'POS-RAIL-ERA-1',
  /* commission-config POS_PLAN_RATES as of 2f4fc20 (flat 5% on every plan), POS_DEFAULT_PLAN seller_free, KES 10 floor. */
  /* sha256 of {"plans":[[seller_basic,0.05,false],[seller_enterprise,…],[seller_free,…],[seller_pro,…]],
     "defaultPlan":"seller_free","minCommissionKes":10} — see rateTableFingerprint(). */
  rateTableSha256: '460545db52a87e32d6b31adc7e1fc836a8e86cb0de4d8bbe66a2739a33635929',
  /* The DEPLOYMENT boundary: the first production moment this rail prices POS sales. Fixed by the deployment commit
     (M0-6) — null until then, which puts NO sale in the era. */
  fromSoldAtMs: null,
});

function eraProves(era, soldAtMs) {
  return !!era && Number.isSafeInteger(era.fromSoldAtMs) && era.fromSoldAtMs > 0
    && typeof era.rateTableSha256 === 'string' && era.rateTableSha256 === rateTableFingerprint()
    && soldAtMs >= era.fromSoldAtMs;
}

/* The checkout's own derivations — one each, never re-implemented here. Lazy: the checkout module is large. */
const _zf = () => require('./pos-zero-friction');
/* Every route the checkout's rail mapper NAMES. Listed here only so an unrecorded or unknown route is refused rather
   than falling into _posRailKeyFor's default branch (TILL_DIRECT) — the mapping itself is the checkout's. */
const RECOGNISED_ROUTES = Object.freeze(['CASH_IN_DRAWER', PC.ROUTE_CENTRAL, PC.ROUTE_DIRECT]);

const _str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const review = (reason, extra) => Object.assign({ verdict: VERDICT.NEEDS_REVIEW, reason }, extra || {});

/* Every read the judgement needs, through one reader: plain reads for dry-run, the transaction for execute. */
async function gather(rd, store, saleId) {
  const db = rd.base;
  const debtId = RAIL.debtIdFor(saleId);
  const [sale, debt, ledger, outcome, refunds, ledgerByOrder, claims] = await Promise.all([
    rd.get(db.collection(store).doc(saleId)),
    rd.get(db.collection(RAIL.LIABILITIES).doc(debtId)),
    rd.get(db.collection(RAIL.LEDGER).doc(debtId)),
    rd.get(db.collection(OUTCOMES).doc(debtId)),
    rd.get(db.collection(REFUNDS).where('saleId', '==', saleId).limit(1)),
    rd.get(db.collection(RAIL.LEDGER).where('orderId', '==', saleId).limit(10)),
    store === RECORDED_SALES ? rd.get(db.collection(RECORD_CLAIMS).where('saleId', '==', saleId).limit(2)) : Promise.resolve(null),
  ]);
  return { store, saleId, debtId, sale, debt, ledger, outcome, refunds, ledgerByOrder, claims };
}

/* The judgement. Reads nothing but the gathered evidence, except the ONE business resolver (through the same reader). */
async function judge(ev, rd, era) {
  const { store, saleId, sale } = ev;
  if (!sale || !sale.exists) return review(REASON.SALE_MISSING);
  const s = sale.data() || {};

  /* 1. a proven server sale */
  let merchantUid, soldAtMs, grossMinor, rail;
  if (store === RETAIL_SALES) {
    if (s.source === 'pos-mirror') return { verdict: VERDICT.OUT_OF_SCOPE, reason: REASON.MIRROR_SALE };
    const mid = _str(s.merchantId), key = _str(s.idempotencyKey);
    if (!mid || !key || _zf()._saleIdFor(mid, key) !== saleId) return review(REASON.SALE_IDENTITY_UNPROVEN);
    merchantUid = mid;
  } else {
    const docs = ev.claims ? ev.claims.docs : [];
    const c = docs.length === 1 ? (docs[0].data() || {}) : null;
    const seller = _str(s.sellerId);
    if (!c || !seller || c.saleId !== saleId || c.sellerId !== seller) return review(REASON.SALE_IDENTITY_UNPROVEN);
    merchantUid = seller;
  }

  /* 2. the debt: present → done (never altered); half-present → review */
  if (ev.debt.exists) {
    return ev.ledger.exists ? { verdict: VERDICT.DEBT_PRESENT, merchantUid } : review(REASON.PROJECTION_MISSING, { merchantUid });
  }
  if (ev.ledger.exists) return review(REASON.LEDGER_WITHOUT_DEBT, { merchantUid });
  if (ev.ledgerByOrder.docs.some((d) => d.id !== ev.debtId && (d.data() || {}).type === 'pos_commission_receivable')) {
    return review(REASON.LEGACY_RECEIVABLE_PRESENT, { merchantUid });
  }

  /* 3. committed as completed, never voided or refunded */
  if (/^(voided|void|refunded|partially_refunded)$/.test(String(s.status || '')) || s.voided === true || !ev.refunds.empty) {
    return review(REASON.SALE_VOIDED_OR_REFUNDED, { merchantUid });
  }
  if (s.status !== 'completed') return review(REASON.SALE_NOT_COMPLETED, { merchantUid });

  /* 4. the recorded facts — each proven, none defaulted */
  if (store === RETAIL_SALES) {
    soldAtMs = s.soldAtMs;
    if (!Number.isSafeInteger(soldAtMs) || soldAtMs <= 0) return review(REASON.SOLD_AT_MISSING, { merchantUid });
    if (!RECOGNISED_ROUTES.includes(s.collectionRoute)) return review(REASON.ROUTE_UNPROVEN, { merchantUid, soldAtMs });
    rail = _zf()._posRailKeyFor(s.collectionRoute);
    if (typeof s.grandTotal !== 'number' || !Number.isFinite(s.grandTotal) || s.grandTotal < 0) return review(REASON.GROSS_UNPROVEN, { merchantUid, soldAtMs });
    grossMinor = Math.round(s.grandTotal * 100);
  } else {
    const c = ev.claims.docs[0].data();
    soldAtMs = c.soldAtMs;
    if (!Number.isSafeInteger(soldAtMs) || soldAtMs <= 0) return review(REASON.SOLD_AT_MISSING, { merchantUid });
    rail = 'TILL_DIRECT';   /* recordPOSSale's one rail (DR-A); a code fact, not a default */
    grossMinor = c.grossMinor;
    if (!Number.isSafeInteger(grossMinor) || grossMinor < 0 || typeof s.total !== 'number' || Math.round(s.total * 100) !== grossMinor) {
      return review(REASON.GROSS_UNPROVEN, { merchantUid, soldAtMs });
    }
  }

  /* 5. the rate era — never reprice a sale with a table it was not sold under */
  if (!eraProves(era, soldAtMs)) return review(REASON.RATE_ERA_UNPROVEN, { merchantUid, soldAtMs });

  /* 6. commission-bearing, by the rail's own semantics */
  let record;
  try {
    record = PSC.planSaleCommission({ rail, gross: MA.fromMinor(grossMinor), planId: null, soldAtMs, saleId, merchantUid });
  } catch (e) {
    return review(REASON.PLAN_FAILED, { merchantUid, soldAtMs });
  }
  if (!record.createsLiability) return { verdict: VERDICT.NOT_OWED, reason: REASON.CUSTODIAL_OR_ZERO, merchantUid, soldAtMs };

  /* 7. the business, unambiguously — the ONE resolver, read through the same reader */
  const business = await RAIL.resolveDebtBusiness(rd.db, merchantUid);
  if (!business || !business.businessId) return review(REASON.BUSINESS_UNRESOLVED, { merchantUid, soldAtMs, businessResolution: business && business.via });

  return { verdict: VERDICT.RECONSTRUCTABLE, merchantUid, soldAtMs, record, business };
}

/* The resolver's reads (collection().doc().get(), collection().where().limit().get()) served by the transaction. */
function _txnReader(t, db) {
  const wrap = (q) => ({
    doc: (id) => ({ get: () => t.get(q.doc(id)) }),
    where: (...a) => wrap(q.where(...a)),
    limit: (n) => wrap(q.limit(n)),
    get: () => t.get(q),
  });
  return { collection: (c) => wrap(db.collection(c)) };
}

function _outcomeDoc(ev, j, pre, extra) {
  return Object.assign({
    debtId: ev.debtId, saleId: ev.saleId, store: ev.store,
    verdict: j.verdict === VERDICT.RECONSTRUCTABLE ? VERDICT.RECONSTRUCTED : j.verdict,
    reason: j.reason || null,
    evaluatedVerdict: pre.verdict, evaluatedReason: pre.reason || null,
    changedSinceEvaluation: pre.verdict !== j.verdict || (pre.reason || null) !== (j.reason || null),
    merchantUid: j.merchantUid || null,
    soldAtMs: Number.isSafeInteger(j.soldAtMs) ? j.soldAtMs : null,
    rateEraId: RATE_ERA.id,
  }, extra);
}

/* execute, one sale: judge AGAIN inside the transaction; write only what that judgement allows. */
async function _executeOne(db, store, saleId, pre, era, actorUid) {
  return db.runTransaction(async (t) => {
    const rd = { base: db, get: (x) => t.get(x), db: _txnReader(t, db) };
    const ev = await gather(rd, store, saleId);
    const j = await judge(ev, rd, era);
    if (ev.outcome.exists) {
      return { saleId, debtId: ev.debtId, verdict: VERDICT.OUTCOME_ALREADY_RECORDED, prior: (ev.outcome.data() || {}).verdict || null };
    }
    const nowMs = Date.now();
    const outcomeRef = db.collection(OUTCOMES).doc(ev.debtId);
    if (j.verdict === VERDICT.RECONSTRUCTABLE) {
      const debt = RAIL.buildDebt(j.record, j.business, nowMs);   /* createdAtMs = when the debt came into existence */
      const plan = { none: false, refs: [db.collection(RAIL.LIABILITIES).doc(debt.debtId), db.collection(RAIL.LEDGER).doc(debt.debtId)],
        debt, ledger: RAIL.ledgerProjectionOf(debt) };
      RAIL.applySaleDebtInTxn(t, plan, ev.debt, ev.ledger);
      t.create(outcomeRef, _outcomeDoc(ev, j, pre, { reconciledAtMs: nowMs, reconciledBy: actorUid,
        debtCreatedAtMs: nowMs, liabilityMinor: debt.liabilityMinor, businessId: debt.businessId }));
      return { saleId, debtId: ev.debtId, verdict: VERDICT.RECONSTRUCTED };
    }
    if (j.verdict === VERDICT.NEEDS_REVIEW) {
      t.create(outcomeRef, _outcomeDoc(ev, j, pre, { reconciledAtMs: nowMs, reconciledBy: actorUid }));
      return { saleId, debtId: ev.debtId, verdict: VERDICT.NEEDS_REVIEW, reason: j.reason, changedSinceEvaluation: pre.verdict !== j.verdict };
    }
    return { saleId, debtId: ev.debtId, verdict: j.verdict, reason: j.reason || null, changedSinceEvaluation: pre.verdict !== j.verdict };
  });
}

/**
 * One page of one sale store. `opts.era` exists for the certification suite; the callable never forwards one.
 * @returns {{mode, store, rateEra, scanned, next, counts, results}}
 */
async function reconcile(db, opts) {
  const o = opts || {};
  const mode = o.mode || 'dry_run';
  if (mode !== 'dry_run' && mode !== 'execute') throw new Error('mode must be dry_run or execute');
  if (!STORES.includes(o.store)) throw new Error('store must be one of ' + STORES.join(', '));
  const era = o.era || RATE_ERA;
  const limit = Math.min(Math.max(1, Math.floor(Number(o.limit) || 25)), MAX_PAGE);
  const { FieldPath } = require('firebase-admin/firestore');
  let q = db.collection(o.store).orderBy(FieldPath.documentId()).limit(limit);
  if (o.after) q = q.startAfter(String(o.after));
  const page = await q.get();

  const results = [], counts = {};
  const plain = { base: db, get: (x) => x.get(), db };
  for (const doc of page.docs) {
    const ev = await gather(plain, o.store, doc.id);
    const pre = await judge(ev, plain, era);
    let r = { saleId: doc.id, debtId: ev.debtId, verdict: pre.verdict, reason: pre.reason || null };
    if (ev.outcome.exists) r.outcomeRecorded = (ev.outcome.data() || {}).verdict || null;
    if (mode === 'execute' && (pre.verdict === VERDICT.RECONSTRUCTABLE || pre.verdict === VERDICT.NEEDS_REVIEW)) {
      r = await _executeOne(db, o.store, doc.id, pre, era, o.actorUid || null);
    }
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    results.push(r);
  }
  return {
    mode, store: o.store,
    rateEra: { id: era.id, established: Number.isSafeInteger(era.fromSoldAtMs) && era.rateTableSha256 === rateTableFingerprint() },
    scanned: page.size,
    next: page.size === limit ? page.docs[page.size - 1].id : null,
    counts, results,
  };
}

/* ── the admin callable ──────────────────────────────────────────────────────────────────────────────────────────── */
async function _handler(req) {
  const { HttpsError } = require('firebase-functions/v2/https');
  if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const tok = req.auth.token || {};
  if (!(tok.admin === true || tok.superAdmin === true)) {
    throw new HttpsError('permission-denied', 'Only SOKONI administrators can reconcile POS commission debts.');
  }
  const d = req.data || {};
  const mode = d.mode === undefined ? 'dry_run' : d.mode;
  if (mode !== 'dry_run' && mode !== 'execute') throw new HttpsError('invalid-argument', 'mode must be "dry_run" or "execute".');
  if (!STORES.includes(d.store)) throw new HttpsError('invalid-argument', 'store must be "posRetailSales" or "posSales".');
  if (d.after !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(String(d.after))) throw new HttpsError('invalid-argument', 'after must be a sale id.');
  if (d.limit !== undefined && !(Number.isInteger(d.limit) && d.limit >= 1 && d.limit <= MAX_PAGE)) {
    throw new HttpsError('invalid-argument', 'limit must be an integer from 1 to ' + MAX_PAGE + '.');
  }
  const out = await reconcile(require('firebase-admin').firestore(), { mode, store: d.store, after: d.after, limit: d.limit, actorUid: req.auth.uid });
  console.log('[reconcilePosSaleDebts]', JSON.stringify({ by: req.auth.uid, mode, store: d.store, scanned: out.scanned, counts: out.counts, era: out.rateEra }));
  return out;
}

const OPTS = { region: 'us-central1', enforceAppCheck: true, maxInstances: 1, timeoutSeconds: 300 };

module.exports = {
  OUTCOMES, VERDICT, REASON, RATE_ERA, RECOGNISED_ROUTES, MAX_PAGE,
  rateTableFingerprint, eraProves, gather, judge, reconcile,
  _h: { reconcilePosSaleDebts: _handler },
  reconcilePosSaleDebts: require('firebase-functions/v2/https').onCall(OPTS, _handler),
};
