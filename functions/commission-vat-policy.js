/* ================================================================
   SOKONI — Commission VAT policy (fail-closed)

   WHY THIS MODULE EXISTS

   `etims-tax-engine.js` computes VAT with `const inclusive = cfg.inclusive !== false`,
   and no caller has ever passed a config. So the platform has been answering
   "is the 5% commission VAT-inclusive or VAT-exclusive?" with a LIBRARY DEFAULT.

   It answers *inclusive*, which happens to match terms.html:255 ("SOKONI deducts
   and remits 16% VAT on platform fees"). It happens to. Nobody chose it, and
   legal-hub.html:3228 ("VAT ... shall be charged at the prevailing rate") reads
   the other way. Both pages are live. The seller agreement mentions neither.

   The difference is real money:

       KES 10,000 sale @ 5%
       inclusive → merchant owes 500, SOKONI recognises 431.03, VAT 68.97
       exclusive → merchant owes 580, SOKONI recognises 500.00, VAT 80.00

   THERE IS DELIBERATELY NO DEFAULT IN THIS FILE.

   An unset policy returns null and every caller must refuse to issue. A default
   here would re-create the exact defect it exists to close — a tax position
   chosen by code rather than by the business. An issued eTIMS invoice cannot be
   quietly corrected, only credit-noted, so a wrong answer is durable and visible
   to KRA.

   Mirrors `revenueConfig/commission_penalty`, which likewise refuses to assess a
   fee without an explicitly configured rate.

   To arm: write `revenueConfig/commission_vat`
       { enabled: true, inclusive: <true|false>, decidedBy: '<name>',
         decidedAt: <ts>, reference: '<advice ref>' }
================================================================ */
'use strict';

const admin = require('firebase-admin');

const POLICY_DOC = 'revenueConfig/commission_vat';

/**
 * Load the commission VAT policy.
 *
 * @returns {Promise<{inclusive:boolean, decidedBy:string, reference:string}|null>}
 *          null whenever a VAT treatment must NOT be assumed — unset, disabled,
 *          unreadable, or missing an explicit boolean.
 */
async function loadVatPolicy(db) {
  try {
    const [coll, id] = POLICY_DOC.split('/');
    const snap = await (db || admin.firestore()).collection(coll).doc(id).get();
    if (!snap.exists) return null;

    const c = snap.data() || {};
    if (c.enabled !== true) return null;

    /* `inclusive` must be an explicit boolean. A missing or truthy-ish value is
       NOT interpreted — that would be the library-default failure again, one
       layer up. */
    if (typeof c.inclusive !== 'boolean') return null;

    /* An unattributable tax decision is not a decision. */
    if (!c.decidedBy) return null;

    return {
      inclusive: c.inclusive,
      decidedBy: String(c.decidedBy),
      reference: c.reference ? String(c.reference) : null,
      decidedAt: c.decidedAt || null,
    };
  } catch (_e) {
    /* Unreadable config is indistinguishable from absent config, and both mean
       the same thing: do not guess a tax treatment. */
    return null;
  }
}

/** Human-readable reason, for logs and for the error surfaced to an operator. */
const UNSET_REASON =
  'Commission VAT treatment is not configured. Set revenueConfig/commission_vat ' +
  '{ enabled: true, inclusive: <true|false>, decidedBy: "<name>" } once the tax ' +
  'position is formally decided. No invoice may be issued until then.';

module.exports = { loadVatPolicy, POLICY_DOC, UNSET_REASON };
