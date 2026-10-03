/* ============================================================================
   B2B LEAD FEE — the ONE authority for what SOKONI earns from the B2B Hub (owner 2026-10-03, via sokoni-f3)
   ----------------------------------------------------------------------------
   Owner decisions, recorded verbatim in intent:
     • Earning model: a LEAD FEE, NO % cut on wholesale orders. A lead = each RFQ / enquiry a SUPPLIER RECEIVES
       through SOKONI. (The order itself prices through commission-config RATES.b2b_order = 0%, a fixed lane.)
     • Price: KES 200 per lead + 16% VAT. "Add 16% VAT" was chosen explicitly, so the VAT treatment below is a
       DECISION (standard-rated, price stated EXCLUSIVE of VAT), not an inference.
     • Billing: counted per supplier per calendar month (Africa/Nairobi), invoiced at month end as a SOKONI →
       supplier PLATFORM invoice through the one engine (etims._issuePlatformInvoice, explicit taxCategory).
     • Price is admin-editable (Super Admin, audited) like adminSubUpdatePlan. A change applies to leads received
       AFTER it: each lead snapshots the price it was received at, so a mid-month edit never reprices history.

   DATA — ONE writer per collection:
     b2bLeads/{rfqId}__{supplierBusinessId}   WRITTEN BY rfq.js (sokoni-f3, functions/b2b-rfq-on-e61c73e @ 38ab5a8), in the
        RFQ delivery transaction, only after re-reading supply.acceptsLeads === true:
        { supplierBusinessId, supplierOwnerUid, rfqId, buyerBusinessId, month:'YYYY-MM', source:'rfq',
          consentAcceptsLeadsAt, createdAt, priceKES?, priceSource? }
        This module NEVER writes a lead row. leadFields(db) is the helper rfq.js spreads into the row so each lead
        carries the price it was received at; a row without priceKES is priced at invoice time and flagged.
     b2bLeadMonths/{supplierBusinessId}__{YYYY-MM}   WRITTEN HERE ONLY — the month-end claim + invoice record
        { supplierBusinessId, billToUid, month, leadCount, netKES, unsnapshottedLeads, status:'issuing'|'issued'|'failed',
          invoicePending, invoiceId }
        Totals are computed ONCE from the ledger when the month is first claimed and stored, so a retry bills exactly
        the same amount.

   MONTH END: b2bLeadMonthlyInvoices (1st of the month, 07:00 EAT) reads the previous month's leads (paged, one read per
   lead, once a month), groups them by supplier and issues one platform invoice each; a failed or stale claim is
   retried by the daily sweep (b2bLeadInvoiceSweep). The engine key `platform-lead-{aggregateId}` is the second line
   of idempotency.

   NOT DECIDED (do not invent): how the supplier PAYS the invoice (wallet debit, IntaSend link, or offset against
   B2B settlements). The invoice is the fiscal document and the receivable; collection is a separate owner decision.
   ============================================================================ */
'use strict';

const CONFIG_DOC = ['revenueConfig', 'b2b_leads'];
const LEADS = 'b2bLeads';
const MONTHS = 'b2bLeadMonths';
const LEAD_FEE_DEFAULT_KES = 200;
const MAX_KES = 100000;
const FEE_TYPE = 'lead';
/* Owner 2026-10-03: "KES 200 per lead + 16% VAT" — standard-rated, stated exclusive. Never inferred, never defaulted
   elsewhere: the invoice call below passes exactly this. */
const VAT_TREATMENT = Object.freeze({ taxCategory: 'standard', vatInclusive: false });
const STALE_MS = 10 * 60 * 1000;
const EAT_OFFSET_MS = 3 * 3600000; /* Africa/Nairobi has no DST */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function _validPrice(v) { return Number.isInteger(v) && v >= 1 && v <= MAX_KES; }

/** Calendar month in Africa/Nairobi, 'YYYY-MM'. */
function monthOf(date) {
  const d = new Date(date.getTime() + EAT_OFFSET_MS);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
/** The calendar month before `date` (EAT). */
function previousMonth(date) {
  const d = new Date(date.getTime() + EAT_OFFSET_MS);
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth();
  return y + '-' + String(m).padStart(2, '0');
}

/** The current lead price. An invalid override is ignored (the default stands) and reported. */
async function leadPrice(db) {
  try {
    const s = await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).get();
    const v = s && s.exists && s.data() ? s.data().priceKES : undefined;
    if (v === undefined) return { priceKES: LEAD_FEE_DEFAULT_KES, source: 'default' };
    if (_validPrice(v)) return { priceKES: v, source: 'admin_override' };
    return { priceKES: LEAD_FEE_DEFAULT_KES, source: 'default', ignoredOverride: true };
  } catch (_) {
    return { priceKES: LEAD_FEE_DEFAULT_KES, source: 'default', unreadable: true };
  }
}

/** Fields rfq.js adds to each lead row it writes: the price the lead was received at. Never throws. */
async function leadFields(db) {
  const p = await leadPrice(db);
  return { priceKES: p.priceKES, priceSource: p.source };
}

/** Group one month's lead rows by supplier. Rows priced at write time keep that price; rows without one take `fallbackKES`. */
function groupLeads(rows, fallbackKES) {
  const by = new Map();
  for (const r of rows) {
    const sup = String(r.supplierBusinessId || '');
    if (!ID_RE.test(sup)) continue;
    if (r.buyerBusinessId && String(r.buyerBusinessId) === sup) continue; /* a supplier's own RFQ is never a lead */
    const g = by.get(sup) || { supplierBusinessId: sup, billToUid: null, leadCount: 0, netKES: 0, unsnapshottedLeads: 0 };
    if (!g.billToUid && r.supplierOwnerUid) g.billToUid = String(r.supplierOwnerUid);
    const snap = Number.isInteger(r.priceKES) && r.priceKES >= 1 && r.priceKES <= MAX_KES;
    g.leadCount += 1;
    g.netKES += snap ? r.priceKES : fallbackKES;
    if (!snap) g.unsnapshottedLeads += 1;
    by.set(sup, g);
  }
  return [...by.values()];
}

/* ── month-end invoicing ───────────────────────────────────────────────────────────────── */
async function _claim(db, aggRef, nowMs, totals) {
  return db.runTransaction(async (t) => {
    const s = await t.get(aggRef);
    if (!s.exists) {
      if (!totals) return { granted: false, reason: 'no_aggregate' };
      if (!(totals.leadCount > 0) || !(totals.netKES > 0)) return { granted: false, reason: 'nothing_to_bill' };
      if (!totals.billToUid) return { granted: false, reason: 'no_supplier_owner' };
      const agg = Object.assign({}, totals, { status: 'issuing', issuingSinceMs: nowMs, invoicePending: true });
      t.create(aggRef, agg);
      return { granted: true, agg };
    }
    const d = s.data() || {};
    if (d.status === 'issued') return { granted: false, reason: 'already_issued', invoiceId: d.invoiceId || null };
    if (d.status === 'issuing' && nowMs - Number(d.issuingSinceMs || 0) < STALE_MS) return { granted: false, reason: 'in_flight' };
    t.update(aggRef, { status: 'issuing', issuingSinceMs: nowMs, invoicePending: true });
    return { granted: true, agg: d };   /* a retry bills the STORED totals, never a recount */
  });
}

/**
 * Invoice one supplier-month. The amount is READ from the aggregate (never a caller), net of VAT; the engine adds
 * 16% because the treatment is standard / exclusive. deps.issueInvoice defaults to etims._issuePlatformInvoice.
 */
async function invoiceSupplierMonth(db, aggId, deps, totals) {
  const d = deps || {};
  const nowMs = d.nowMs ? d.nowMs() : Date.now();
  const aggRef = db.collection(MONTHS).doc(String(aggId));
  const c = await _claim(db, aggRef, nowMs, totals);
  if (!c.granted) return { ok: c.reason === 'already_issued', idempotent: true, reason: c.reason, invoiceId: c.invoiceId || null };
  const a = c.agg;
  const issue = d.issueInvoice || ((args) => require('./etims')._issuePlatformInvoice(args));
  let r;
  try {
    r = await issue({
      sellerUid: a.billToUid, feeType: FEE_TYPE, amount: Number(a.netKES), reference: String(aggId),
      description: `${a.leadCount} B2B lead${a.leadCount === 1 ? '' : 's'} received, ${a.month}`,
      vatInclusive: VAT_TREATMENT.vatInclusive, taxCategory: VAT_TREATMENT.taxCategory,
    });
  } catch (err) {
    await aggRef.update({ status: 'failed', invoicePending: true, error: String(err && err.message || err).slice(0, 200) });
    return { ok: false, reason: 'invoice_engine_failed' };
  }
  const invoiceId = r && r.invoiceId ? String(r.invoiceId) : null;
  if (!invoiceId) {
    await aggRef.update({ status: 'failed', invoicePending: true, error: 'no_invoice_id_returned' });
    return { ok: false, reason: 'no_invoice_id_returned' };
  }
  await aggRef.update({
    status: 'issued', invoiceId, invoicePending: false, error: null, issuedAtMs: nowMs,
    /* The receivable starts HERE, at the successful issue — never on a failed / deferred attempt (agreed with f3). */
    outstandingKES: _withVat(Number(a.netKES)).totalKES, paidKES: 0,
    billedLeadCount: Number(a.leadCount), billedNetKES: Number(a.netKES),
    taxCategory: VAT_TREATMENT.taxCategory, vatInclusive: VAT_TREATMENT.vatInclusive, engineDuplicate: r.duplicate === true,
  });
  return { ok: true, invoiceId, leadCount: Number(a.leadCount), netKES: Number(a.netKES) };
}

/** Every supplier with leads in `month` → one invoice each. Reads the lead ledger once (paged). */
async function invoiceMonth(db, month, deps) {
  const out = { month, leads: 0, suppliers: 0, issued: 0, failed: 0, skipped: 0 };
  const rows = [];
  let last = null;
  for (;;) {
    let q = db.collection(LEADS).where('month', '==', month).limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const doc of snap.docs) rows.push(doc.data() || {});
    if (snap.docs.length < 500) break;
    last = snap.docs[snap.docs.length - 1];
  }
  out.leads = rows.length;
  const price = await leadPrice(db);
  const groups = groupLeads(rows, price.priceKES);
  out.suppliers = groups.length;
  for (const g of groups) {
    const r = await invoiceSupplierMonth(db, g.supplierBusinessId + '__' + month, deps, Object.assign({ month }, g));
    if (r.ok && !r.idempotent) out.issued++; else if (r.ok || r.idempotent) out.skipped++; else out.failed++;
  }
  return out;
}

/** Failed or stale-issuing claims, any month. */
async function sweepPending(db, deps) {
  const snap = await db.collection(MONTHS).where('invoicePending', '==', true).limit(200).get();
  const out = { scanned: snap.docs.length, issued: 0, failed: 0, skipped: 0 };
  for (const doc of snap.docs) {
    const r = await invoiceSupplierMonth(db, doc.id, deps);
    if (r.ok && !r.idempotent) out.issued++; else if (r.ok || r.idempotent) out.skipped++; else out.failed++;
  }
  return out;
}

/* VAT through the ONE tax engine (never inline maths): net is exclusive, standard-rated. */
function _withVat(netKES) {
  const T = require('./etims-tax-engine');
  const t = T.computeTotals([T.computeLine({ name: 'B2B Lead Fee', quantity: 1, unitPrice: Number(netKES) || 0, discountRate: 0, seq: 1 }, 'registered', { inclusive: false })]);
  return { netKES: t.totTaxblAmt, vatKES: t.totTaxAmt, totalKES: t.totAmt };
}

/**
 * The caller's own lead statement: invoiced months (from b2bLeadMonths, billToUid == uid) plus the month in progress
 * (counted from the ledger). Internal claim fields (engine error text, timings) are never returned.
 */
async function statementFor(db, uid, deps) {
  const d = deps || {};
  const now = d.now ? d.now() : new Date();
  const current = monthOf(now);
  const snap = await db.collection(MONTHS).where('billToUid', '==', String(uid)).limit(24).get();
  const months = snap.docs.map((doc) => {
    const m = doc.data() || {};
    const net = Number(m.billedNetKES != null ? m.billedNetKES : m.netKES) || 0;
    return Object.assign({ month: m.month, leadCount: Number(m.billedLeadCount != null ? m.billedLeadCount : m.leadCount) || 0,
      status: m.status === 'issued' ? 'invoiced' : 'being_invoiced', invoiceId: m.status === 'issued' ? (m.invoiceId || null) : null }, _withVat(net));
  }).sort((a, b) => (a.month < b.month ? 1 : -1));
  const cur = await db.collection(LEADS).where('supplierOwnerUid', '==', String(uid)).where('month', '==', current).limit(5000).get();
  const price = await leadPrice(db);
  let net = 0;
  for (const doc of cur.docs) { const r = doc.data() || {}; net += Number.isInteger(r.priceKES) ? r.priceKES : price.priceKES; }
  return { ok: true, currentMonth: Object.assign({ month: current, leadCount: cur.docs.length, status: 'in_progress' }, _withVat(net)),
    months, priceKES: price.priceKES };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
   RECOVERY of issued lead invoices (owner 2026-10-03, contracts agreed with sokoni-f3 / sokoni-5b)
   ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Two ways an issued invoice is paid, ONE code path:
     • SETTLEMENT DEDUCTION — at release of a buyer-paid B2B order, the supplier's payout is reduced by
       min(outstanding, settlement), oldest invoice first. The buyer is never touched. Claim: leaddeduct_<settlementId>_<key>.
     • PAY NOW — purpose 'b2b_lead_invoice' (IntaSend, verified webhook). Claim: leadpay_<paymentRef>_<key>.
   READ / WRITE SPLIT (Firestore: all reads before any write). The caller's transaction does
       const st = await prepareLeadDeduction(t, db, {...})   <- BEFORE any of the caller's writes
       ... caller's own reads ...
       const r  = commitLeadDeduction(t, st)                  <- with the caller's writes
   prepare discovers candidate invoices with a NON-transactional query (discovery only) and then t.get()s EVERY one
   of them, plus this operation's claim for each, INSIDE the transaction. Amounts come only from those in-txn reads,
   so a Pay Now or another release that committed after discovery is re-read, and the same KES is never recovered
   twice. An invoice issued after discovery is simply not in this round; it carries forward.
   A retry of the same operation finds its own claims by t.get(): it recovers 0 more and reports what it already
   recovered, so the caller computes the SAME net as the first time (never an aborted release, never a second cut).
   A refund / void of the B2B order after a deduction does NOT reverse it: the lead invoice was a real debt
   (owner policy needed for anything else).
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
const RECOVERIES = 'b2bLeadRecoveries';
const OVERDUE_MS = 2 * 86400000;
const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const _claimKey = (opKey, key) => String(opKey) + '_' + String(key);

/** Outstanding issued invoices for a supplier owner, oldest first (non-transactional: display / discovery only). */
async function outstandingFor(db, billToUid) {
  const snap = await db.collection(MONTHS).where('billToUid', '==', String(billToUid)).where('status', '==', 'issued').limit(100).get();
  return snap.docs.map((d) => Object.assign({ invoiceKey: d.id }, d.data() || {}))
    .filter((m) => Number(m.outstandingKES) > 0)
    .map((m) => ({ invoiceKey: m.invoiceKey, month: m.month, issuedAtMs: Number(m.issuedAtMs) || 0, outstandingKES: _r2(m.outstandingKES), invoiceId: m.invoiceId || null }))
    .sort((a, b) => a.issuedAtMs - b.issuedAtMs);
}

async function _prepare(t, db, { opKey, kind, billToUid, capKES }) {
  const uid = String(billToUid || '');
  const cap = _r2(capKES);
  if (!uid || !(cap >= 0)) throw new Error('bad recovery request');
  /* Discovery (outside the txn): candidate invoices + any invoice this op already claimed. Ids only — no amounts. */
  const [open, mine] = await Promise.all([
    db.collection(MONTHS).where('billToUid', '==', uid).where('status', '==', 'issued').limit(100).get(),
    db.collection(RECOVERIES).where('opKey', '==', String(opKey)).limit(100).get(),
  ]);
  const keys = [...new Set(open.docs.map((d) => d.id).concat(mine.docs.map((d) => String((d.data() || {}).invoiceKey || ''))).filter(Boolean))];
  /* IN-TXN reads: every invoice and this op's claim on it. */
  const reads = await Promise.all(keys.map(async (key) => {
    const ref = db.collection(MONTHS).doc(key);
    const claimRef = db.collection(RECOVERIES).doc(_claimKey(opKey, key));
    const [m, c] = await Promise.all([t.get(ref), t.get(claimRef)]);
    return { key, ref, claimRef, m: m.exists ? (m.data() || {}) : null, claim: c.exists ? (c.data() || {}) : null };
  }));
  let replayKES = 0;
  const candidates = [];
  for (const r of reads) {
    if (r.claim) { replayKES = _r2(replayKES + Number(r.claim.amountKES || 0)); continue; }   /* this op already recovered it */
    if (!r.m || r.m.billToUid !== uid || r.m.status !== 'issued') continue;                 /* paid / not issued / not theirs */
    const out = _r2(r.m.outstandingKES);
    if (!(out > 0)) continue;
    candidates.push({ key: r.key, ref: r.ref, claimRef: r.claimRef, before: out, paidBefore: _r2(r.m.paidKES), issuedAtMs: Number(r.m.issuedAtMs) || 0, month: r.m.month || null });
  }
  candidates.sort((a, b) => a.issuedAtMs - b.issuedAtMs);
  let left = _r2(cap - replayKES);
  const lines = [];
  for (const c of candidates) {
    if (!(left > 0)) break;
    const amount = _r2(Math.min(c.before, left));
    left = _r2(left - amount);
    lines.push(Object.assign({}, c, { amount }));
  }
  return { opKey: String(opKey), kind, billToUid: uid, capKES: cap, replayKES, lines, _prepared: true };
}

/** Read phase for a settlement deduction. Call BEFORE any write in the release transaction. */
function prepareLeadDeduction(t, db, { settlementId, billToUid, settlementKES }) {
  if (!ID_RE.test(String(settlementId || ''))) throw new Error('settlementId required');
  return _prepare(t, db, { opKey: 'leaddeduct_' + settlementId, kind: 'settlement_deduction', billToUid, capKES: settlementKES });
}
/** Read phase for a verified Pay Now payment. */
function preparePayment(t, db, { paymentRef, billToUid, amountKES }) {
  if (!String(paymentRef || '')) throw new Error('paymentRef required');
  return _prepare(t, db, { opKey: 'leadpay_' + String(paymentRef).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120), kind: 'pay_now', billToUid, capKES: amountKES });
}

/** Write phase. Claims by create() (a concurrent duplicate aborts the whole txn); never touches the buyer. */
function commitLeadRecovery(t, state, deps) {
  if (!state || !state._prepared) throw new Error('commit without prepare');
  const ts = (deps && deps.serverTs) || (() => new Date());
  let recovered = 0;
  const lines = [];
  for (const l of state.lines) {
    if (!(l.amount > 0)) continue;
    const after = _r2(l.before - l.amount);
    t.create(l.claimRef, { opKey: state.opKey, kind: state.kind, invoiceKey: l.key, month: l.month, billToUid: state.billToUid,
      amountKES: l.amount, outstandingBefore: l.before, outstandingAfter: after, createdAt: ts() });
    t.update(l.ref, { outstandingKES: after, paidKES: _r2(l.paidBefore + l.amount), status: after <= 0 ? 'paid' : 'issued',
      lastRecoveryKind: state.kind, lastRecoveryOp: state.opKey });
    recovered = _r2(recovered + l.amount);
    lines.push({ invoiceKey: l.key, month: l.month, amountKES: l.amount, outstandingAfter: after });
  }
  const total = _r2(recovered + state.replayKES);
  return { deductedKES: recovered, replayedKES: state.replayKES, totalRecoveredKES: total, netKES: _r2(state.capKES - total), lines };
}
const commitLeadDeduction = commitLeadRecovery;

/** Till/POS gate predicate: an issued invoice unpaid for more than 2 days. Enforcement waits for a certified Pay Now. */
async function leadInvoiceGate(db, uid, nowMs) {
  const now = Number(nowMs) || Date.now();
  const list = await outstandingFor(db, uid);
  const over = list.filter((m) => m.issuedAtMs > 0 && now - m.issuedAtMs > OVERDUE_MS);
  return {
    overdue: over.length > 0,
    overdueKES: _r2(over.reduce((t, m) => t + m.outstandingKES, 0)),
    invoiceKeys: over.map((m) => m.invoiceKey),
    since: over.length ? over[0].issuedAtMs + OVERDUE_MS : null,
    enforce: false,   /* owner: block only once a certified Pay Now exists — display only until then */
  };
}

/** Amount the Pay Now purpose charges: every outstanding issued invoice, read on the server. */
async function payNowAmount(db, uid) {
  const list = await outstandingFor(db, uid);
  return { amountKES: _r2(list.reduce((t, m) => t + m.outstandingKES, 0)), invoiceKeys: list.map((m) => m.invoiceKey) };
}

/* ── deployables ── */
let b2bLeadMonthlyInvoices, b2bLeadInvoiceSweep, adminSetB2bLeadPrice, b2bLeadPrice, b2bLeadStatement;
{
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  const logger = require('firebase-functions/logger');
  const _db = () => require('firebase-admin').firestore();
  /* etims secrets must be bound to any function that reaches _issuePlatformInvoice. */
  const _secrets = () => { try { return require('./etims')._ALL_SECRETS || []; } catch (_) { return []; } };

  b2bLeadMonthlyInvoices = onSchedule({ schedule: '0 7 1 * *', timeZone: 'Africa/Nairobi', region: 'us-central1', memory: '256MiB', timeoutSeconds: 540, secrets: _secrets() }, async () => {
    const month = previousMonth(new Date());
    const out = await invoiceMonth(_db(), month);
    logger.info('[b2b-leads] month-end invoices', out);
  });
  b2bLeadInvoiceSweep = onSchedule({ schedule: 'every 24 hours', region: 'us-central1', memory: '256MiB', timeoutSeconds: 540, secrets: _secrets() }, async () => {
    const out = await sweepPending(_db());
    logger.info('[b2b-leads] sweep', out);
  });
  /* Public read so the supplier dashboard and seller terms show the live price (never a hard-coded copy). */
  b2bLeadPrice = onCall({ region: 'us-central1', maxInstances: 20 }, async () => {
    const p = await leadPrice(_db());
    return { ok: true, priceKES: p.priceKES, vat: 'plus 16% VAT', billing: 'monthly, per lead received' };
  });
  /* A supplier's own statement (merchant-v2). Scoped to the caller; b2bLeadMonths itself stays admin-read in rules. */
  b2bLeadStatement = onCall({ region: 'us-central1', maxInstances: 20 }, async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to see your lead statement.');
    try { return await statementFor(_db(), req.auth.uid); } catch (e) {
      logger.error('[b2b-leads] statement failed', { uid: req.auth.uid, err: String(e && e.message || e).slice(0, 200) });
      throw new HttpsError('unavailable', 'Your lead statement could not be loaded. Try again shortly.');
    }
  });
  /* Super Admin only. Whole KES 1..100,000; applies to leads received after the change; audited. */
  adminSetB2bLeadPrice = onCall({ region: 'us-central1', maxInstances: 5 }, async (req) => {
    const tk = req.auth && req.auth.token;
    if (!tk || tk.superAdmin !== true) throw new HttpsError('permission-denied', 'Only a Super Admin can change the B2B lead price.');
    const v = req.data && req.data.priceKES;
    if (!_validPrice(v)) throw new HttpsError('invalid-argument', 'The lead price must be a whole number of shillings, 1–' + MAX_KES + '.');
    const admin = require('firebase-admin');
    const db = _db();
    const before = await leadPrice(db);
    await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).set({ priceKES: v, updatedBy: req.auth.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await db.collection('adminAudit').add({ action: 'b2b_lead_price', hub: 'b2b', by: req.auth.uid, from: before.priceKES, to: v, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true, priceKES: v };
  });
}

module.exports = {
  LEAD_FEE_DEFAULT_KES, VAT_TREATMENT, FEE_TYPE, CONFIG_DOC, LEADS, MONTHS,
  monthOf, previousMonth, leadPrice, leadFields, groupLeads, statementFor, invoiceSupplierMonth,
  outstandingFor, prepareLeadDeduction, preparePayment, commitLeadRecovery, commitLeadDeduction, leadInvoiceGate, payNowAmount, RECOVERIES, OVERDUE_MS, invoiceMonth, sweepPending,
  b2bLeadMonthlyInvoices, b2bLeadInvoiceSweep, b2bLeadPrice, b2bLeadStatement, adminSetB2bLeadPrice,
};
