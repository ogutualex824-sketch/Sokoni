'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   POS BRANCH AUTHORITY — a branch is resolved and proved, never accepted
   ══════════════════════════════════════════════════════════════════════════════
   THE DEFECT THIS EXISTS TO REMOVE (found in production, 2026-09-06)

   Every `pos.*` audit record in production carries `branchId: "default"`. That is
   not a branch. Real branches are `branches/{merchantId}-main`, recorded on the
   business as `defaultBranchId` — business-bootstrap already resolves them that way
   (`b.defaultBranchId || `${mid}-main``). `"default"` is a literal that fourteen
   call sites substitute when the caller supplies nothing:

       posCompleteCheckout   branchId = 'default'        <- client-supplied, unvalidated
       pos.refund audit      sale.branchId || 'default'
       pos.receipt_reprint   branchId

   Two separate problems, and the second is the dangerous one:

     1. FABRICATION. `pos-audit.js` documents `branchId` as "branch/terminal scope,
        WHEN KNOWN" and stores `e.branchId || null` — null is the honest answer for
        an unknown scope. Callers overwrite that honesty with a placeholder that
        looks like a real branch in an investigation. A shift dispute, a till
        reconciliation or a fraud review reading "default" cannot tell whether the
        scope was unknown or whether a branch genuinely called "default" existed.

     2. NO OWNERSHIP PROOF. `branchId` arrives from the client and is written
        straight through. Nothing checks the branch belongs to the merchant, so a
        caller could file a sale, a refund or an audit entry under ANOTHER
        merchant's branch.

   THE CONTRACT

     · a placeholder is never stored — it resolves to the merchant's real default
       branch, or to null, and never to the string "default"
     · a REQUESTED branch must belong to the merchant, proved against
       `branches/{id}.merchantId`, or it is refused
     · resolution never invents: with no business record and no branch document the
       answer is null, which the audit schema already accommodates

   HISTORICAL RECORDS ARE LEFT ALONE. Existing `"default"` rows cannot be attributed
   to a real branch from the evidence available (see the provenance trace), and
   rewriting them would manufacture a history nobody can vouch for.
   ══════════════════════════════════════════════════════════════════════════════ */

/* Values that are NOT branch ids, however often they are written as one. Compared
   case-insensitively and after trimming, because "Default" is the same lie. */
const PLACEHOLDER_BRANCH_IDS = ['default', 'main', 'branch', 'none', 'null', 'undefined', '-', ''];

function isPlaceholderBranchId(id) {
  return PLACEHOLDER_BRANCH_IDS.indexOf(String(id == null ? '' : id).trim().toLowerCase()) !== -1;
}

/** The branch id a merchant's own default branch would have. */
function defaultBranchIdFor(merchantId) {
  const m = String(merchantId == null ? '' : merchantId).trim();
  return m ? `${m}-main` : null;
}

/**
 * resolveBranchId — the ONE way a branch reaches a stored record.
 *
 * @param db          Firestore instance
 * @param merchantId  the merchant the operation belongs to (server-derived)
 * @param requested   what the caller asked for; may be absent or a placeholder
 * @returns {Promise<{ok:true, branchId:string|null, source:string} | {ok:false, reason:string}>}
 *
 * Never throws for an ordinary refusal — the caller decides whether a bad branch is
 * fatal (a sale) or merely unrecorded (an audit line).
 */
async function resolveBranchId(db, merchantId, requested) {
  const mid = String(merchantId == null ? '' : merchantId).trim();
  if (!mid) return { ok: false, reason: 'no-merchant' };

  const asked = String(requested == null ? '' : requested).trim();

  /* A REQUESTED branch is proved, never trusted. */
  if (asked && !isPlaceholderBranchId(asked)) {
    let snap = null;
    try { snap = await db.collection('branches').doc(asked).get(); }
    catch (e) { return { ok: false, reason: 'branch-lookup-failed' }; }
    if (!snap || !snap.exists) return { ok: false, reason: 'branch-not-found' };
    const b = snap.data() || {};
    if (String(b.merchantId || '') !== mid) return { ok: false, reason: 'branch-belongs-to-another-merchant' };
    return { ok: true, branchId: asked, source: 'requested' };
  }

  /* Nothing usable was asked for. Resolve the merchant's OWN default, from the
     business record where business-bootstrap writes it. */
  let biz = null;
  try { biz = await db.collection('businesses').doc(mid).get(); }
  catch (e) { return { ok: true, branchId: null, source: 'unresolved' }; }

  const declared = biz && biz.exists ? String((biz.data() || {}).defaultBranchId || '').trim() : '';
  if (declared && !isPlaceholderBranchId(declared)) {
    return { ok: true, branchId: declared, source: 'business-default' };
  }

  /* Last resort: the conventional id — but only when that branch actually exists.
     Returning it unchecked would reintroduce a made-up scope by another name. */
  const conventional = defaultBranchIdFor(mid);
  if (conventional) {
    try {
      const s = await db.collection('branches').doc(conventional).get();
      if (s.exists) return { ok: true, branchId: conventional, source: 'conventional' };
    } catch (_) { /* fall through to unresolved */ }
  }

  /* HONEST NULL. The audit schema says "when known"; this is when it is not. */
  return { ok: true, branchId: null, source: 'unresolved' };
}

/**
 * auditBranchId — what an audit line may record.
 * A placeholder becomes null rather than a fabricated scope. Used as defence in
 * depth at the audit boundary so no future caller can reintroduce "default".
 */
function auditBranchId(id) {
  return isPlaceholderBranchId(id) ? null : String(id).trim();
}

module.exports = {
  PLACEHOLDER_BRANCH_IDS, isPlaceholderBranchId, defaultBranchIdFor,
  resolveBranchId, auditBranchId,
};
