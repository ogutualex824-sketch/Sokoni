/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — POS COMMISSION RECEIVABLE COLLECTION
   functions/pos-commission-collection.js

   The till rail accrues but never collected. `pos_commission_receivable` was written
   by pos-zero-friction.js and read by NOTHING: no consumer, no scheduled job. SOKONI
   earned 5% on every till sale and never asked for it.

   This closes that loop WITHOUT touching the accrual. calculateCommission() and
   _postSaleFinancials() are already green (20/0) and are not modified here.

       POS sale ─► 5% ─► pos_commission_receivable ─► [THIS FILE] ─► collected ─► reconciled

   TWO RAILS, DELIBERATELY SEPARATE
   ────────────────────────────────
   Marketplace: SOKONI holds the buyer's money, so commission is DEDUCTED before the
   seller and rider wallets are credited, after buyer confirmation. That path is
   order-settlement.js and is untouched.

   POS/till: the seller already holds the cash. SOKONI holds nothing, so commission is
   a RECEIVABLE the seller owes — never a deduction from money we do not have. This
   file collects that debt. The two must not share a settlement path; they share only
   the 5% authority (calculateCommission).

   THE COLLECTION RAIL IS NOT INVENTED HERE, AND FAILS CLOSED
   ─────────────────────────────────────────────────────────
   No rail today can debit a seller. mpesa-c2b.js is INBOUND ONLY (validation and
   confirmation webhooks for someone paying the Paybill); it cannot initiate a charge.
   IntaSend B2C is a PAYOUT rail — building on it would pay every seller 5% of their
   till sales daily instead of collecting it, which is the single most expensive
   mistake available here.

   So `_rail()` returns null unless an operator explicitly configures one, and an
   unconfigured rail records the attempt as `blocked_no_rail` and MOVES NO MONEY. The
   engine, its idempotency, its state machine and its reconciliation are all provable
   today; only the final money movement waits on a commercial decision.

   DOUBLE ENTRY, AND THE DIRECTION MATTERS
   ───────────────────────────────────────
     accrual     DEBIT seller:{id}      CREDIT platform:revenue     (seller owes us)
     collection  DEBIT external:mpesa   CREDIT seller:{id}          (seller paid; debt down)

   Ledger entries are immutable, so "mark collected" is a SETTLING ENTRY, never an
   edit of the accrual. A seller's account nets to zero when fully collected.

   IDEMPOTENCY IS ON THE COLLECTION, NOT THE SALE
   ──────────────────────────────────────────────
   The accrual key (`poscomm_<saleIdempotencyKey>`) stops one SALE being booked twice.
   It cannot stop a retried collection charging a seller twice, because a collection
   spans many sales. So a collection carries its own deterministic key,
   `poscollect_<sellerId>_<period>`, and one attempt document per seller per period.

   UNKNOWN IS NOT FAILURE
   ──────────────────────
   A payment whose outcome we do not know must never be blind-retried — that is how a
   seller gets charged twice — and must never be marked collected. It becomes
   `unknown` and stays outstanding until a human or a confirmation resolves it. This
   is the same hazard as the STK confirmation race (callback after the window closes).
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

const REGION = 'us-central1';

/* Collections owned by this module. */
const C_ATTEMPTS = 'posCommissionCollections';
const C_LEDGER   = 'ledger';
const C_RECON    = 'posCommissionReconciliation';

const TYPE_ACCRUAL   = 'pos_commission_receivable';
const TYPE_COLLECTED = 'pos_commission_collected';

/* Attempt states. `unknown` is terminal until resolved by a human or a confirmation;
   nothing in this file promotes it automatically. */
const STATE = {
  BLOCKED:   'blocked_no_rail',
  PENDING:   'pending',
  CONFIRMED: 'confirmed',
  FAILED:    'failed',
  UNKNOWN:   'unknown',
};

function _db () { return getFirestore(); }

/* Nairobi calendar day. The collection period must be stable regardless of where the
   function happens to execute, or a seller could be collected twice across a UTC
   boundary — two different period keys for one local day. */
function periodKey (d) {
  const t = new Date((d || new Date()).getTime() + 3 * 3600 * 1000); /* UTC+3, no DST in EAT */
  return t.getUTCFullYear() + String(t.getUTCMonth() + 1).padStart(2, '0') +
         String(t.getUTCDate()).padStart(2, '0');
}

function collectionKey (sellerId, period) { return 'poscollect_' + sellerId + '_' + period; }

/* ── THE RAIL BOUNDARY ────────────────────────────────────────────────────────
   Returns an adapter only when an operator has explicitly approved and configured
   one. There is deliberately no default: an unconfigured platform must not move a
   merchant's money because a scheduler ran.

   An adapter is { id, charge({ sellerId, amountCents, reference }) } resolving to
   { outcome: 'confirmed'|'failed'|'unknown', ref, raw }. `unknown` is a first-class
   outcome, not an error — a timeout or an absent callback is exactly that. */
function _rail (cfg) {
  if (!cfg || cfg.enabled !== true || !cfg.railId) return null;
  const reg = (module.exports._railRegistry) || {};
  return reg[cfg.railId] || null;
}

async function _railConfig (db) {
  try {
    const s = await db.collection('platformConfig').doc('posCommissionCollection').get();
    return (s && s.exists) ? (s.data() || {}) : {};
  } catch (_) { return {}; }
}

/* ── OUTSTANDING ──────────────────────────────────────────────────────────────
   Accrued minus collected, from the ledger itself rather than a cached balance. A
   cached figure is a second source of truth and would drift from the books it claims
   to describe. */
async function outstandingForSeller (db, sellerId) {
  const snap = await db.collection(C_LEDGER)
    .where('sellerId', '==', sellerId)
    .where('type', 'in', [TYPE_ACCRUAL, TYPE_COLLECTED])
    .get();

  let accruedCents = 0, collectedCents = 0;
  const receivableIds = [];
  (snap.docs || []).forEach((d) => {
    const v = d.data() || {};
    const amt = Number(v.amountCents) || 0;
    if (v.type === TYPE_ACCRUAL)        { accruedCents += amt; receivableIds.push(d.id); }
    else if (v.type === TYPE_COLLECTED) { collectedCents += amt; }
  });

  return {
    sellerId,
    accruedCents,
    collectedCents,
    outstandingCents: accruedCents - collectedCents,
    receivableIds,
  };
}

/* Every seller carrying an accrual. Scanning the ledger keeps the worklist derived
   from the books; a separate "sellers who owe" collection would be a second truth. */
async function sellersWithReceivables (db) {
  const snap = await db.collection(C_LEDGER).where('type', '==', TYPE_ACCRUAL).get();
  const ids = new Set();
  (snap.docs || []).forEach((d) => { const s = (d.data() || {}).sellerId; if (s) ids.add(s); });
  return [...ids];
}

/* ── ONE COLLECTION ATTEMPT ───────────────────────────────────────────────────
   Deterministic document id, so a second run in the same period finds the existing
   attempt instead of creating a parallel one. The guard is the DOCUMENT, not a flag
   inside it: a flag can be read stale, a create cannot. */
async function collectForSeller (db, sellerId, opts) {
  const o = opts || {};
  const period = o.period || periodKey();
  const id = sellerId + '_' + period;
  const ref = db.collection(C_ATTEMPTS).doc(id);

  const existing = await ref.get();
  if (existing && existing.exists) {
    const v = existing.data() || {};
    /* Already settled, already refused, or in an unknown state nobody has resolved.
       None of these may be retried automatically. */
    return { sellerId, period, state: v.state, amountCents: v.amountCents || 0,
             duplicate: true, reason: 'attempt already exists for this period' };
  }

  const bal = await outstandingForSeller(db, sellerId);
  if (bal.outstandingCents <= 0) {
    return { sellerId, period, state: 'nothing_due', amountCents: 0, duplicate: false };
  }

  const cfg  = o.config || await _railConfig(db);
  const rail = _rail(cfg);
  const base = {
    sellerId, period, amountCents: bal.outstandingCents,
    accruedCents: bal.accruedCents, collectedCents: bal.collectedCents,
    receivableIds: bal.receivableIds,
    idempotencyKey: collectionKey(sellerId, period),
    createdAt: new Date().toISOString(),
  };

  /* FAIL CLOSED. No approved rail means no money moves, and the attempt is recorded
     so the debt stays visible instead of silently disappearing from the worklist. */
  if (!rail) {
    await ref.set(Object.assign({}, base, {
      state: STATE.BLOCKED,
      note: 'no approved seller-collection rail is configured; nothing was charged',
    }));
    return { sellerId, period, state: STATE.BLOCKED, amountCents: bal.outstandingCents, duplicate: false };
  }

  await ref.set(Object.assign({}, base, { state: STATE.PENDING, railId: cfg.railId }));

  let outcome = 'unknown', railRef = null, raw = null;
  try {
    const r = await rail.charge({
      sellerId, amountCents: bal.outstandingCents, reference: base.idempotencyKey,
    });
    outcome = (r && r.outcome) || 'unknown';
    railRef = (r && r.ref) || null;
    raw     = (r && r.raw) || null;
  } catch (e) {
    /* A THROWN error is not a failure to charge — the request may have reached the
       gateway. Treating it as `failed` would invite a retry that charges twice. */
    outcome = 'unknown';
    raw = { error: (e && e.message) || String(e) };
  }

  if (outcome === 'confirmed') {
    /* The settling entry. createLedgerEntry enforces its own idempotency on this key,
       so even a duplicated confirmation books once. */
    const FU = require('./finos-utils');
    await FU.createLedgerEntry(db, {
      type: TYPE_COLLECTED,
      amountCents: bal.outstandingCents,
      debitAccount: (FU.ACCOUNTS && FU.ACCOUNTS.EXTERNAL_MPESA) || 'external:mpesa',
      creditAccount: FU.ACCOUNTS ? FU.ACCOUNTS.seller(sellerId) : ('seller:' + sellerId),
      description: 'POS commission collected for ' + period,
      sellerId, category: 'pos', createdBy: 'posCommissionCollection',
      idempotencyKey: base.idempotencyKey,
      metadata: { period, railId: cfg.railId, railRef, receivableIds: bal.receivableIds },
    });
    await ref.update({ state: STATE.CONFIRMED, railRef, confirmedAt: new Date().toISOString() });
    return { sellerId, period, state: STATE.CONFIRMED, amountCents: bal.outstandingCents, duplicate: false };
  }

  const state = (outcome === 'failed') ? STATE.FAILED : STATE.UNKNOWN;
  await ref.update({
    state, railRef, raw,
    resolvedAt: null,
    note: state === STATE.UNKNOWN
      ? 'outcome unknown — the charge may or may not have succeeded. NOT retried automatically.'
      : 'the rail refused the charge; the receivable remains outstanding',
  });
  return { sellerId, period, state, amountCents: bal.outstandingCents, duplicate: false };
}

/* ── RECONCILIATION ───────────────────────────────────────────────────────────
   READ-ONLY, and that is the point. A reconciliation that repairs what it finds can
   hide the very drift it exists to surface. It writes one report and changes no
   financial record. */
async function reconcile (db, opts) {
  const o = opts || {};
  const period = o.period || periodKey();
  const sellers = await sellersWithReceivables(db);

  const findings = [];
  let accrued = 0, collected = 0, outstanding = 0;

  for (const sellerId of sellers) {
    const bal = await outstandingForSeller(db, sellerId);
    accrued += bal.accruedCents;
    collected += bal.collectedCents;
    outstanding += bal.outstandingCents;

    if (bal.outstandingCents < 0) {
      findings.push({ kind: 'over_collected', sellerId,
        detail: 'collected ' + bal.collectedCents + ' exceeds accrued ' + bal.accruedCents });
    }

    const att = await db.collection(C_ATTEMPTS).where('sellerId', '==', sellerId).get();
    const byPeriod = {};
    (att.docs || []).forEach((d) => {
      const v = d.data() || {};
      byPeriod[v.period] = (byPeriod[v.period] || 0) + 1;
      if (v.state === STATE.UNKNOWN && v.period !== period) {
        findings.push({ kind: 'stale_unknown', sellerId, period: v.period,
          detail: 'an unresolved unknown outcome from an earlier period still blocks collection' });
      }
    });
    Object.keys(byPeriod).forEach((p) => {
      if (byPeriod[p] > 1) {
        findings.push({ kind: 'duplicate_attempt', sellerId, period: p,
          detail: byPeriod[p] + ' attempts exist for one period' });
      }
    });

    /* A confirmed attempt must be backed by a settling ledger entry. Marked collected
       without one means the books disagree with the operational record. */
    for (const d of (att.docs || [])) {
      const v = d.data() || {};
      if (v.state !== STATE.CONFIRMED) continue;
      const led = await db.collection(C_LEDGER)
        .where('idempotencyKey', '==', v.idempotencyKey).get();
      if (!led || (led.docs || []).length === 0) {
        findings.push({ kind: 'collected_without_ledger', sellerId, period: v.period,
          detail: 'attempt is confirmed but no settling ledger entry exists' });
      } else {
        const amt = Number((led.docs[0].data() || {}).amountCents) || 0;
        if (amt !== Number(v.amountCents)) {
          findings.push({ kind: 'amount_mismatch', sellerId, period: v.period,
            detail: 'attempt ' + v.amountCents + ' vs ledger ' + amt });
        }
      }
    }
  }

  const report = {
    period, generatedAt: new Date().toISOString(),
    sellers: sellers.length,
    accruedCents: accrued, collectedCents: collected, outstandingCents: outstanding,
    balanced: (accrued - collected) === outstanding,
    findings, ok: findings.length === 0,
  };
  await db.collection(C_RECON).doc(period).set(report);
  return report;
}

/* ── THE DAILY JOB ────────────────────────────────────────────────────────────
   Morning, Nairobi time. It collects FROM sellers; it never pays them, so no B2C
   rail appears anywhere in this file. */
async function runDailyCollection (db, opts) {
  const o = opts || {};
  const period = o.period || periodKey();
  const cfg = o.config || await _railConfig(db);
  const sellers = await sellersWithReceivables(db);

  const results = [];
  for (const sellerId of sellers) {
    try {
      results.push(await collectForSeller(db, sellerId, { period, config: cfg }));
    } catch (e) {
      results.push({ sellerId, period, state: STATE.UNKNOWN,
                     error: (e && e.message) || String(e) });
    }
  }
  const report = await reconcile(db, { period });
  return { period, attempted: results.length, results, reconciliation: report };
}

exports.posCommissionDailyCollection = onSchedule(
  { schedule: '0 6 * * *', timeZone: 'Africa/Nairobi', region: REGION,
    timeoutSeconds: 540, memory: '256MiB' },
  async () => { await runDailyCollection(_db()); },
);

/* Operator surface: run the reconciliation on demand. Read-only by construction. */
exports.posCommissionReconcile = onCall({ region: REGION }, async ({ data, auth }) => {
  if (!auth || !auth.token || auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'admin only');
  }
  return reconcile(_db(), { period: (data && data.period) || undefined });
});

/* Exported for the suite and for an operator to wire an approved rail. The registry
   is deliberately EMPTY: adding one is a commercial decision, not a code default. */
module.exports._railRegistry = {};
module.exports.periodKey = periodKey;
module.exports.collectionKey = collectionKey;
module.exports.outstandingForSeller = outstandingForSeller;
module.exports.sellersWithReceivables = sellersWithReceivables;
module.exports.collectForSeller = collectForSeller;
module.exports.runDailyCollection = runDailyCollection;
module.exports.reconcile = reconcile;
module.exports.STATE = STATE;
module.exports.TYPE_ACCRUAL = TYPE_ACCRUAL;
module.exports.TYPE_COLLECTED = TYPE_COLLECTED;
