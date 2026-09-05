/* ================================================================
   SOKONI — Manual-Till checkout policy (fail-closed)

   WHY THIS MODULE EXISTS

   MANUAL_TILL_ORDER_CONTRACT §4 records six decisions that must be made before a
   manual-Till order can exist, and §4b unifies the two hardest into one question:

     "What protection does SOKONI give the customer and the merchant during the
      period between customer reference submission and merchant POS attestation?"

   That window is unlike any other pending state in the platform: the customer has
   already parted with money SOKONI never saw, to a merchant SOKONI cannot audit.
   Neither party is protected by the platform holding funds, because the platform
   holds none. Booking holds and IntaSend escrow assume custody; this has none, so
   none of their instincts transfer.

   THERE IS DELIBERATELY NO DEFAULT IN THIS FILE.

   `reserveStock` and `onMerchantSilence` have no fallback. An unset policy returns
   null and every caller must refuse. A default here would let engineering answer a
   commercial question by omission — which is precisely what §4 exists to prevent,
   and precisely how `cfg.inclusive !== false` came to decide SOKONI's VAT position.

   Contract F3 is binding: **a timeout may NOT decide merchant silence.**
   `onMerchantSilence: 'auto_confirm'` is therefore REFUSED by this loader, not
   merely discouraged — auto-confirming would hand a merchant a confirmed sale for
   doing nothing.

   To arm, once §4.1-4.3 are ratified:
     revenueConfig/manual_till_policy
       { enabled: true,
         reserveStock: <true|false>,
         attestationWindowHours: <number>,
         onMerchantSilence: 'escalate_to_human' | 'auto_cancel',
         decidedBy: '<name>', decidedAt: <ts>, reference: '<decision ref>' }
================================================================ */
'use strict';

const admin = require('firebase-admin');

const POLICY_DOC = 'revenueConfig/manual_till_policy';

/* auto_confirm is absent BY DESIGN — see contract F3. */
const SILENCE_OUTCOMES = new Set(['escalate_to_human', 'auto_cancel']);

/**
 * @returns {Promise<{reserveStock:boolean, attestationWindowHours:number,
 *                    onMerchantSilence:string, decidedBy:string}|null>}
 *          null whenever manual-Till checkout must NOT proceed.
 */
async function loadManualTillPolicy(db) {
  try {
    const [coll, id] = POLICY_DOC.split('/');
    const snap = await (db || admin.firestore()).collection(coll).doc(id).get();
    if (!snap.exists) return null;

    const c = snap.data() || {};
    if (c.enabled !== true) return null;

    /* §4.2 — must be an explicit boolean. A missing or truthy-ish value is not
       interpreted: that would be the library-default failure one layer up. */
    if (typeof c.reserveStock !== 'boolean') return null;

    /* §4.1 — an unbounded wait is an unbounded liability, so the window must be
       stated as a positive number. */
    const hrs = Number(c.attestationWindowHours);
    if (!Number.isFinite(hrs) || hrs <= 0) return null;

    /* §4.3 / F3 — auto_confirm is refused outright, not defaulted away. */
    if (!SILENCE_OUTCOMES.has(c.onMerchantSilence)) return null;

    /* An unattributable commercial decision is not a decision. */
    if (!c.decidedBy) return null;

    return {
      reserveStock:           c.reserveStock,
      attestationWindowHours: hrs,
      onMerchantSilence:      String(c.onMerchantSilence),
      decidedBy:              String(c.decidedBy),
      reference:              c.reference ? String(c.reference) : null,
    };
  } catch (_e) {
    /* Unreadable is indistinguishable from absent, and both mean the same thing:
       do not guess what protection the window offers. */
    return null;
  }
}

const UNSET_REASON =
  'Manual-Till checkout is not configured. MANUAL_TILL_ORDER_CONTRACT §4.1-4.3 ' +
  '(attestation window, stock reservation, merchant silence) must be ratified and ' +
  'written to revenueConfig/manual_till_policy before this payment mode can be used. ' +
  'No manual-Till order may be created until then.';

module.exports = { loadManualTillPolicy, POLICY_DOC, UNSET_REASON, SILENCE_OUTCOMES };
