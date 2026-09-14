'use strict';
/**
 * LEGACY TENANT-KEY MIGRATION — classification only. This module NEVER writes.
 *
 * Records written before tenant convergence may carry `sellerId = owner uid`, while every
 * converged reader now asks for `sellerId = merchantId`. Those records are still there; they
 * are simply unreachable. See docs/TENANT_IDENTITY_CENSUS.md.
 *
 * The single most dangerous thing this could do is quietly rewrite a record whose meaning it
 * did not understand. So classification is deliberately pessimistic: a record is ELIGIBLE only
 * when every question has an unambiguous answer, and every other outcome is a named refusal
 * that a human has to look at.
 *
 * IT CREATES NO COLLECTION. The resolver authority is the existing `businesses.ownerId`
 * relationship — no tenantMappings, no migrationRecords, no side ledger.
 */

/** Outcomes. Each is distinct so the census can count them separately. */
const STATUS = {
  CANONICAL:  'canonical',        /* already a merchantId — nothing to do */
  ELIGIBLE:   'eligible',         /* uid, resolves to exactly one active merchant */
  UNLINKED:   'unresolved',       /* uid owns no business */
  AMBIGUOUS:  'ambiguous',        /* uid owns more than one */
  MALFORMED:  'malformed',        /* business record inconsistent */
  INACTIVE:   'inactive',         /* business not active */
  MISSING:    'missing-sellerId', /* no tenant key at all */
  UNKNOWN:    'unknown-key',      /* neither a known merchantId nor a resolvable uid */
  COLLISION:  'collision',        /* a record already exists under the target */
  MEANING:    'meaning-change',   /* migrating would alter what the record says */
};

/* Fields whose presence means the record carries history that a tenant rewrite must not
   disturb. They are asserted as PRESERVED, never rewritten. */
const HISTORY_FIELDS = [
  'cashierUid', 'cashierId', 'servedBy', 'shiftId', 'requestedBy', 'reviewedBy',
  'consumedBy', 'approvalId', 'saleId', 'createdAt', 'openedAt', 'closedAt', 'timestamp',
];

/**
 * Classify ONE record.
 *
 * @param {object}  rec        the document data (plus `id`)
 * @param {object}  ctx
 *   @param {Set}     ctx.knownMerchantIds   every `businesses` document id
 *   @param {Function} ctx.resolveOwner      uid -> {ok, merchantId} | {ok:false, reason}
 *   @param {Function} ctx.targetExists      (merchantId, rec) -> boolean
 * @returns {{status: string, from: string|null, to: string|null, reason?: string}}
 */
function classify (rec, ctx) {
  const from = rec && typeof rec.sellerId === 'string' ? rec.sellerId : null;

  if (!from) return { status: STATUS.MISSING, from: null, to: null };

  /* Already canonical. Idempotency lives here: a second pass over a migrated record
     recognises it and proposes nothing. */
  if (ctx.knownMerchantIds.has(from)) {
    return { status: STATUS.CANONICAL, from: from, to: from };
  }

  const owned = ctx.resolveOwner(from);
  if (!owned || !owned.ok) {
    const map = {
      'no-business-for-owner':         STATUS.UNLINKED,
      'owner-has-multiple-businesses': STATUS.AMBIGUOUS,
      'business-record-malformed':     STATUS.MALFORMED,
      'business-not-active':           STATUS.INACTIVE,
    };
    /* A value that is neither a known merchantId nor a uid we can resolve is not a "uid we
       failed to resolve" — it is an identifier we do not recognise at all. Naming that
       separately keeps a data-quality problem from hiding inside a migration statistic. */
    const status = (owned && map[owned.reason]) || STATUS.UNKNOWN;
    return { status: status, from: from, to: null, reason: owned && owned.reason };
  }

  const to = owned.merchantId;

  /* A record that already exists under the target is never merged and never overwritten. */
  if (ctx.targetExists && ctx.targetExists(to, rec)) {
    return { status: STATUS.COLLISION, from: from, to: to };
  }

  /* If the record carries its own idea of the tenant that disagrees with the resolved one,
     rewriting `sellerId` would change what the record SAYS, not merely where it is filed. */
  if (rec.merchantId && rec.merchantId !== to) {
    return { status: STATUS.MEANING, from: from, to: to,
             reason: 'record.merchantId disagrees with the resolved merchant' };
  }

  return { status: STATUS.ELIGIBLE, from: from, to: to };
}

/**
 * The ONLY mutation this migration may ever propose: one field.
 * Returns the patch, and the history fields it is asserting remain untouched.
 */
function patchFor (plan) {
  if (plan.status !== STATUS.ELIGIBLE) return null;
  return { patch: { sellerId: plan.to }, preserves: HISTORY_FIELDS.slice() };
}

/** Roll a set of classifications into the census row for one collection. */
function summarise (collection, plans) {
  const row = { collection: collection, total: plans.length };
  Object.keys(STATUS).forEach((k) => { row[STATUS[k]] = 0; });
  plans.forEach((p) => { row[p.status] = (row[p.status] || 0) + 1; });
  return row;
}

module.exports = { classify, patchFor, summarise, STATUS, HISTORY_FIELDS };
