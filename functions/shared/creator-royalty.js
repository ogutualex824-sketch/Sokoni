/* ═══════════════════════════════════════════════════════════════════════════
   creator-royalty.js — PURE royalty arithmetic for the Creator Hub.

   No Firestore, no clock, no network. Every function takes its inputs and
   returns a value, so the money rules are provable in isolation
   (scripts/test-creator-royalty.js) and the server module is left with I/O only.

   UNITS. Money is INTEGER CENTS (KES minor units). Shares are INTEGER BASIS
   POINTS: 10000 = 100 %. Nothing here multiplies money by a float; the one
   commercial split comes from shared/creator-commercial.js as basis points.

   INVARIANTS (enforced here, asserted by the suite):
     I1  0 < share ≤ 10000, integer, per participant
     I2  Σ shares ≤ 10000 for any agreement; = 10000 to be LOCKED (accrual-grade)
     I3  Σ allocated cents == pool cents EXACTLY (largest-remainder, no drift)
     I4  one ledger identity per (payment, agreement version, participant)
     I5  a reversal can never take back more than was recognised
     I6  a release credits WHOLE shillings only; the sub-shilling remainder and
         any reversal debt are carried forward, never rounded away or clawed
         from a wallet

   Related: docs/CREATOR_HUB.md, docs/CREATOR_HUB_OWNERSHIP_MAP.md
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const BPS_TOTAL = 10000;
const MAX_PARTICIPANTS = 50;

const PARTICIPANT_TYPES = Object.freeze([
  'creator', 'producer', 'actor', 'director', 'publisher',
  'rights_holder', 'distributor', 'other',
]);

const AGREEMENT_STATUS = Object.freeze({ DRAFT: 'DRAFT', LOCKED: 'LOCKED', SUPERSEDED: 'SUPERSEDED' });

/* Ledger buckets. Kept SEPARATE on purpose (§27): creator royalty money is not
   SOKONI revenue, not commission, not seller proceeds, not buyer balance. */
const BUCKET = Object.freeze({
  PARTICIPANT_ROYALTY: 'PARTICIPANT_ROYALTY',
  PLATFORM_COMMISSION: 'PLATFORM_COMMISSION',
  PROVIDER_FEE:        'PROVIDER_FEE',
  TAX_LEVY:            'TAX_LEVY',
});

const ENTRY_KIND = Object.freeze({ EARN: 'EARN', REVERSAL: 'REVERSAL' });

/* Settlement periods. OPEN accrues; CALCULATED freezes a statement; APPROVED is
   the second pair of eyes; PAYABLE means released into the canonical wallet
   (withdrawable through requestSellerPayout); CLOSED is archival. */
const PERIOD_STATUS = Object.freeze({
  OPEN: 'OPEN', CALCULATED: 'CALCULATED', APPROVED: 'APPROVED', PAYABLE: 'PAYABLE', CLOSED: 'CLOSED',
});
const PERIOD_TRANSITIONS = Object.freeze({
  OPEN:       ['CALCULATED'],
  CALCULATED: ['CALCULATED', 'APPROVED'],   /* recalculation allowed until approved */
  APPROVED:   ['PAYABLE'],
  PAYABLE:    ['CLOSED'],
  CLOSED:     [],
});

/* Kenya has no DST; quarters are cut on East Africa Time so a sale at 01:00 EAT
   on 1 July is Q3, as the business reads it. */
const EAT_OFFSET_MS = 3 * 3600 * 1000;

const ID_RE  = /^[A-Za-z0-9_-]{1,64}$/;
const REF_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function _err(code, message) { const e = new Error(message); e.code = code; return e; }
const _isCents = (n) => Number.isSafeInteger(n) && n >= 0;

/* ── Agreement validation ───────────────────────────────────────────────── */

/**
 * Validate a royalty agreement's participant list.
 * @param {Array} participants
 * @param {{requireFull?: boolean}} [opts] requireFull — Σ must equal 10000 (lock/accrual grade)
 * @returns {{ok:boolean, errors:string[], participants:Array, totalBps:number}}
 */
function validateAgreement(participants, opts = {}) {
  const errors = [];
  const out = [];
  if (!Array.isArray(participants) || participants.length === 0) {
    return { ok: false, errors: ['participants must be a non-empty array'], participants: [], totalBps: 0 };
  }
  if (participants.length > MAX_PARTICIPANTS) errors.push(`at most ${MAX_PARTICIPANTS} participants`);

  const ids = new Set();
  const roles = new Set();
  let total = 0;
  participants.forEach((p, i) => {
    const at = `participant[${i}]`;
    if (!p || typeof p !== 'object') { errors.push(`${at} is not an object`); return; }
    const participantId   = String(p.participantId || '');
    const participantType = String(p.participantType || '');
    const uid             = String(p.uid || '');
    const bps             = p.bps;

    if (!ID_RE.test(participantId)) errors.push(`${at}.participantId invalid`);
    else if (ids.has(participantId)) errors.push(`${at}.participantId duplicated`);
    ids.add(participantId);

    if (!PARTICIPANT_TYPES.includes(participantType)) errors.push(`${at}.participantType not recognised`);

    /* A SOKONI account is the only payable destination the platform has
       (wallets/{uid}); a participant without one could accrue but never be paid. */
    if (!UID_RE.test(uid)) errors.push(`${at}.uid (registered SOKONI identity) required`);

    /* One person may hold two DIFFERENT roles (producer + actor) — that is
       explicitly modelled. The same person twice in the SAME role is a
       duplicate allocation and is refused. */
    const roleKey = uid + '|' + participantType;
    if (uid && roles.has(roleKey)) errors.push(`${at} duplicates an existing uid+role allocation`);
    roles.add(roleKey);

    if (!Number.isSafeInteger(bps)) errors.push(`${at}.bps must be an integer (basis points)`);
    else if (bps <= 0) errors.push(`${at}.bps must be > 0`);
    else if (bps > BPS_TOTAL) errors.push(`${at}.bps must be ≤ ${BPS_TOTAL}`);
    else total += bps;

    const legalRef = p.legalRef == null ? null : String(p.legalRef).slice(0, 200);
    const displayName = p.displayName == null ? null : String(p.displayName).slice(0, 120);
    out.push({ participantId, participantType, uid, bps, legalRef, displayName, status: 'ACTIVE' });
  });

  if (total > BPS_TOTAL) errors.push(`shares total ${total} bps exceeds ${BPS_TOTAL}`);
  if (opts.requireFull && total !== BPS_TOTAL) errors.push(`shares total ${total} bps; a locked agreement must total exactly ${BPS_TOTAL}`);

  return { ok: errors.length === 0, errors, participants: out, totalBps: total };
}

/**
 * Plan the lock of a DRAFT version. Locking is the moment a version becomes
 * the royalty authority; it is never back-dated, so no lock can re-attribute
 * revenue that an earlier version already governed.
 * @returns {{lock:Object, supersede:Object|null}}
 */
function planLock(versions, draftVersion, nowMs) {
  if (!Number.isSafeInteger(nowMs)) throw _err('invalid_clock', 'nowMs required');
  const list = Array.isArray(versions) ? versions : [];
  const draft = list.find((v) => v.version === draftVersion);
  if (!draft) throw _err('version_missing', `version ${draftVersion} not found`);
  if (draft.status !== AGREEMENT_STATUS.DRAFT) throw _err('version_not_draft', `version ${draftVersion} is ${draft.status}`);
  const v = validateAgreement(draft.participants, { requireFull: true });
  if (!v.ok) throw _err('agreement_invalid', v.errors.join('; '));

  const current = list.find((x) => x.status === AGREEMENT_STATUS.LOCKED) || null;
  if (current && current.version > draftVersion) throw _err('version_stale', 'a newer version is already locked');
  const effectiveFrom = current ? Math.max(nowMs, Number(current.effectiveFrom) + 1) : nowMs;
  return {
    lock: { version: draftVersion, status: AGREEMENT_STATUS.LOCKED, effectiveFrom, effectiveUntil: null, totalBps: v.totalBps },
    supersede: current ? { version: current.version, status: AGREEMENT_STATUS.SUPERSEDED, effectiveUntil: effectiveFrom } : null,
  };
}

/** The LOCKED/SUPERSEDED version that governed revenue recognised at `atMs`. */
function selectVersionAt(versions, atMs) {
  const list = (Array.isArray(versions) ? versions : [])
    .filter((v) => v.status === AGREEMENT_STATUS.LOCKED || v.status === AGREEMENT_STATUS.SUPERSEDED)
    .filter((v) => Number(v.effectiveFrom) <= atMs && (v.effectiveUntil == null || atMs < Number(v.effectiveUntil)));
  if (list.length !== 1) return null;   /* none, or an overlap — both are refusals */
  return list[0];
}

/* ── Pool ───────────────────────────────────────────────────────────────── */

/** Percentage (commission-config style, e.g. 15) → integer basis points. */
function pctToBps(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw _err('rate_invalid', `rate ${pct}% out of range`);
  const bps = Math.round(n * 100);
  if (Math.abs(bps - n * 100) > 1e-6) throw _err('rate_invalid', `rate ${pct}% is finer than a basis point`);
  return bps;
}

/** Half-up integer rounding of cents × bps / 10000 — no floats. */
function applyBps(cents, bps) {
  if (!_isCents(cents)) throw _err('amount_invalid', 'cents must be a non-negative safe integer');
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > BPS_TOTAL) throw _err('bps_invalid', 'bps out of range');
  return Math.floor((cents * bps + BPS_TOTAL / 2) / BPS_TOTAL);
}

/**
 * The authoritative split of ONE Creator sale under the Creator commercial
 * policy (shared/creator-commercial.js — the ONLY rate input; no caller can
 * pass a percentage):
 *
 *     net        = gross − provider fee − tax/levy
 *     commission = floor(net × sokoniCommissionBps / 10000)     → SOKONI
 *     pool       = net − commission                              → creators
 *
 * commission + pool == net EXACTLY. Rounding: SOKONI's share is FLOORED to the
 * cent; any sub-cent remainder stays in the creators' pool (never the other
 * way). An unknown fee is REFUSED (fee_indeterminate) — never assumed 0.
 */
function computePool({ grossCents, providerFeeCents, taxCents = 0, policy }) {
  if (!policy || !Number.isSafeInteger(policy.sokoniCommissionBps) || !Number.isSafeInteger(policy.creatorPoolBps)
      || policy.sokoniCommissionBps + policy.creatorPoolBps !== BPS_TOTAL || policy.basis !== 'NET_OF_PROVIDER_FEE') {
    throw _err('policy_invalid', 'a Creator commercial policy (integer bps summing to 10000, net basis) is required');
  }
  if (!_isCents(grossCents) || grossCents === 0) throw _err('amount_invalid', 'grossCents must be a positive integer');
  if (!_isCents(providerFeeCents)) throw _err('fee_indeterminate', 'providerFeeCents must be a known non-negative integer');
  if (!_isCents(taxCents)) throw _err('amount_invalid', 'taxCents must be a non-negative integer');
  if (providerFeeCents + taxCents > grossCents) throw _err('deductions_exceed_gross', 'fee + tax exceed gross');
  const netCents = grossCents - providerFeeCents - taxCents;
  const commissionCents = Math.floor((netCents * policy.sokoniCommissionBps) / BPS_TOTAL);
  const poolCents = netCents - commissionCents;
  return {
    grossCents, providerFeeCents, taxCents, netCents,
    policyId: policy.policyId || null,
    commissionBps: policy.sokoniCommissionBps, poolBps: policy.creatorPoolBps,
    commissionCents, poolCents,
  };
}

/**
 * Split `poolCents` across participants by bps. Largest-remainder: floor each
 * share, then hand the leftover cents one at a time to the largest fractional
 * remainders (tie → participantId ascending, so the result is deterministic).
 * Requires a fully-allocated (10000 bps) agreement: an under-allocated pool
 * would leave cents with no owner.
 */
function allocate(poolCents, participants) {
  if (!_isCents(poolCents)) throw _err('amount_invalid', 'poolCents must be a non-negative integer');
  const v = validateAgreement(participants, { requireFull: true });
  if (!v.ok) throw _err('agreement_invalid', v.errors.join('; '));
  const rows = v.participants.map((p) => {
    const num = poolCents * p.bps;
    return { ...p, amountCents: Math.floor(num / BPS_TOTAL), rem: num % BPS_TOTAL };
  });
  let left = poolCents - rows.reduce((s, r) => s + r.amountCents, 0);
  const order = rows.slice().sort((a, b) => (b.rem - a.rem) || (a.participantId < b.participantId ? -1 : 1));
  for (let i = 0; left > 0; i = (i + 1) % order.length) { order[i].amountCents += 1; left -= 1; }
  return rows.map(({ rem, ...r }) => r);
}

/* ── Deterministic identities (I4) ──────────────────────────────────────── */

function _ref(paymentRef) {
  const r = String(paymentRef || '');
  if (!REF_RE.test(r)) throw _err('ref_invalid', 'payment reference has an unsafe shape');
  return r;
}
const accrualId   = (paymentRef) => `acc_${_ref(paymentRef)}`;
const earnEntryId = (paymentRef, version, participantId) => {
  if (!Number.isSafeInteger(version) || version < 1) throw _err('version_invalid', 'version must be a positive integer');
  if (!ID_RE.test(String(participantId))) throw _err('participant_invalid', 'participantId invalid');
  return `earn_${_ref(paymentRef)}_v${version}_${participantId}`;
};
const bucketEntryId   = (paymentRef, bucket) => `${String(bucket).toLowerCase()}_${_ref(paymentRef)}`;
const reversalEntryId = (refundId, originalEntryId) => `rev_${_ref(refundId)}_${originalEntryId}`;
const statementId     = (periodId, uid) => `${periodId}_${uid}`;
/* Mirrors the platform's walletTransactions `${uid}_${sourceId}_${kind}` convention. */
const walletTxId      = (uid, periodId) => `${uid}_${periodId}_royalty`;

/* ── Periods ────────────────────────────────────────────────────────────── */

function periodFor(ms) {
  if (!Number.isFinite(ms)) throw _err('invalid_clock', 'ms required');
  const d = new Date(ms + EAT_OFFSET_MS);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return periodBounds(`${year}-Q${quarter}`);
}

function parsePeriodId(id) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(id || ''));
  if (!m) throw _err('period_invalid', `bad period id ${id}`);
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

function periodBounds(id) {
  const { year, quarter } = parsePeriodId(id);
  const startMs = Date.UTC(year, (quarter - 1) * 3, 1) - EAT_OFFSET_MS;
  const endMs   = Date.UTC(year, quarter * 3, 1) - EAT_OFFSET_MS;      /* exclusive */
  return { periodId: `${year}-Q${quarter}`, year, quarter, startMs, endMs };
}

function nextPeriodId(id) {
  const { year, quarter } = parsePeriodId(id);
  return quarter === 4 ? `${year + 1}-Q1` : `${year}-Q${quarter + 1}`;
}
function prevPeriodId(id) {
  const { year, quarter } = parsePeriodId(id);
  return quarter === 1 ? `${year - 1}-Q4` : `${year}-Q${quarter - 1}`;
}

function assertPeriodTransition(from, to, { nowMs, endMs, calculatedBy, actorUid, superAdmin, overrideReason } = {}) {
  const allowed = PERIOD_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw _err('period_transition_refused', `${from} → ${to} is not allowed`);
  if (to === PERIOD_STATUS.CALCULATED && !(Number.isFinite(nowMs) && Number.isFinite(endMs) && nowMs >= endMs)) {
    throw _err('period_not_ended', 'a period cannot be calculated before it ends');
  }
  if (to === PERIOD_STATUS.APPROVED && calculatedBy && actorUid === calculatedBy) {
    if (!(superAdmin && overrideReason && String(overrideReason).trim().length >= 10)) {
      throw _err('approver_not_distinct', 'the approver must not be the admin who calculated the period (superAdmin override needs a reason)');
    }
  }
  return true;
}

/* ── Statements & release (I6) ──────────────────────────────────────────── */

/**
 * One participant's statement for one period.
 * @param {Array} entries  ledger entries in the period for this uid (EARN +, REVERSAL −)
 * @param {number} carryInCents  signed carry from the previous statement
 */
function computeStatement(entries, carryInCents = 0) {
  if (!Number.isSafeInteger(carryInCents)) throw _err('amount_invalid', 'carryInCents must be an integer');
  let earnedCents = 0, reversedCents = 0;
  for (const e of entries || []) {
    if (!Number.isSafeInteger(e.amountCents)) throw _err('amount_invalid', 'entry amount must be an integer');
    if (e.kind === ENTRY_KIND.EARN) earnedCents += e.amountCents;
    else if (e.kind === ENTRY_KIND.REVERSAL) reversedCents += Math.abs(e.amountCents);
    else throw _err('entry_kind_invalid', `unknown entry kind ${e.kind}`);
  }
  const netCents = earnedCents - reversedCents;
  const release = computeRelease(netCents + carryInCents);
  return { earnedCents, reversedCents, netCents, carryInCents, ...release };
}

/** Whole shillings out; remainder (or debt) carried forward. Never negative credit. */
function computeRelease(totalCents) {
  if (!Number.isSafeInteger(totalCents)) throw _err('amount_invalid', 'totalCents must be an integer');
  if (totalCents <= 0) return { releaseKes: 0, releaseCents: 0, carryOutCents: totalCents };
  const releaseKes = Math.floor(totalCents / 100);
  return { releaseKes, releaseCents: releaseKes * 100, carryOutCents: totalCents - releaseKes * 100 };
}

/* ── Reversal (I5) ──────────────────────────────────────────────────────── */

/**
 * Plan the reversal entries for one refund, cumulatively: the target after this
 * refund is the share of every recognised line proportional to TOTAL refunded
 * so far; this refund reverses the difference from what is already reversed.
 * Repeated partial refunds therefore converge on the original amounts and can
 * never exceed them.
 *
 * @param {{grossCents:number, lines:Array<{entryId,amountCents,alreadyReversedCents}>,
 *          refundedBeforeCents:number, refundCents:number}} p
 */
function planReversal({ grossCents, lines, refundedBeforeCents, refundCents }) {
  if (!_isCents(grossCents) || grossCents === 0) throw _err('amount_invalid', 'grossCents must be positive');
  if (!_isCents(refundedBeforeCents) || !_isCents(refundCents) || refundCents === 0) throw _err('amount_invalid', 'refund amounts must be positive integers');
  const cum = refundedBeforeCents + refundCents;
  if (cum > grossCents) throw _err('refund_exceeds_gross', 'refunds would exceed the sale');
  const out = [];
  for (const l of lines || []) {
    if (!_isCents(l.amountCents)) throw _err('amount_invalid', 'line amount invalid');
    const already = Number(l.alreadyReversedCents || 0);
    /* target = round-half-up(amount × cum / gross); full refund → exact amount */
    const target = cum === grossCents ? l.amountCents
      : Math.floor((l.amountCents * cum + Math.floor(grossCents / 2)) / grossCents);
    const delta = Math.min(target, l.amountCents) - already;
    if (delta > 0) out.push({ entryId: l.entryId, reverseCents: delta });
  }
  return { cumulativeRefundCents: cum, fullyRefunded: cum === grossCents, reversals: out };
}

/* ── Participant summary (dashboard) ────────────────────────────────────── */

/**
 * Buckets for the participant dashboard. Everything is derived from the
 * ledger + statements; nothing is a stored running balance that could drift.
 *   accrued            — net in OPEN periods (not yet settled)
 *   pendingSettlement  — net in CALCULATED/APPROVED periods
 *   released           — credited into the SOKONI wallet (withdrawable there)
 *   reversed           — total reversal cents ever booked
 *   carriedCents       — remainder/debt carried into the next statement
 */
function summarizeParticipant({ entries = [], periodStatusById = {}, statements = [] }) {
  const sum = { accruedCents: 0, pendingSettlementCents: 0, releasedCents: 0, reversedCents: 0, carriedCents: 0 };
  for (const e of entries) {
    const st = periodStatusById[e.periodId] || PERIOD_STATUS.OPEN;
    const signed = e.kind === ENTRY_KIND.REVERSAL ? -Math.abs(e.amountCents) : e.amountCents;
    if (e.kind === ENTRY_KIND.REVERSAL) sum.reversedCents += Math.abs(e.amountCents);
    if (st === PERIOD_STATUS.OPEN) sum.accruedCents += signed;
    else if (st === PERIOD_STATUS.CALCULATED || st === PERIOD_STATUS.APPROVED) sum.pendingSettlementCents += signed;
  }
  let lastPeriod = null;
  for (const s of statements) {
    if (s.released === true) sum.releasedCents += Number(s.releaseCents || 0);
    if (!lastPeriod || s.periodId > lastPeriod) { lastPeriod = s.periodId; sum.carriedCents = Number(s.carryOutCents || 0); }
  }
  return sum;
}

module.exports = {
  BPS_TOTAL, MAX_PARTICIPANTS, PARTICIPANT_TYPES, AGREEMENT_STATUS, BUCKET, ENTRY_KIND,
  PERIOD_STATUS, PERIOD_TRANSITIONS, EAT_OFFSET_MS,
  validateAgreement, planLock, selectVersionAt,
  pctToBps, applyBps, computePool, allocate,
  accrualId, earnEntryId, bucketEntryId, reversalEntryId, statementId, walletTxId,
  periodFor, periodBounds, parsePeriodId, nextPeriodId, prevPeriodId, assertPeriodTransition,
  computeStatement, computeRelease, planReversal, summarizeParticipant,
};
