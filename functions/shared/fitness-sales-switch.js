/* ============================================================================
   FITNESS MEMBERSHIP SALES SWITCH — the ONE predicate (2026-10-03)
   featureFlags/fitness_membership_sales.enabled must be EXACTLY boolean true. The string 'true', 1, a missing doc, a
   missing field or a read error all mean OFF (fail closed). Used by BOTH the payment purpose (payment-purposes
   fitness_membership) and membership creation (fitness-membership-create, sokoni-e3) — one copy, so the two can never
   disagree about whether sales are open.
   ============================================================================ */
'use strict';

const FLAG_DOC = 'fitness_membership_sales';

async function salesEnabled(db) {
  try {
    const snap = await db.collection('featureFlags').doc(FLAG_DOC).get();
    return !!(snap && snap.exists && snap.data() && snap.data().enabled === true);
  } catch (e) {
    /* Still OFF (fail closed) — but say so, so ops can tell "flag unreadable" from "flag off". */
    try { require('firebase-functions/logger').warn('[fitness-sales-switch] FLAG_UNREADABLE — treating sales as OFF', { error: (e && e.message) || 'Error' }); } catch (_) { /* no logger offline */ }
    return false;
  }
}

module.exports = { salesEnabled, FLAG_DOC };
