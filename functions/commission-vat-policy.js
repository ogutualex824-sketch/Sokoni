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
async function loadVatPolicy(db, docPath) {
  try {
    const [coll, id] = String(docPath || POLICY_DOC).split('/');
    const snap = await (db || admin.firestore()).collection(coll).doc(id).get();
    if (!snap.exists) return null;

    const c = snap.data() || {};
    if (c.enabled !== true) return null;

    /* APPLICABILITY is decided by the business against KRA's rules, never here:
         'taxable'    — a taxable supply by a VAT-registered supplier: VAT at the configured
                        treatment (inclusive / exclusive of the stated price)
         'zero_rated' — taxable at 0%: the invoice states the supply, VAT 0
         'exempt'     — not a taxable supply (or the supplier is not VAT-registered): no VAT line
       Absent applicability is read as 'taxable' ONLY when `inclusive` is an explicit boolean —
       the pre-2026-09-30 document shape meant exactly that. Anything else is unresolved ⇒ null. */
    const applicability = c.applicability != null ? String(c.applicability)
      : (typeof c.inclusive === 'boolean' ? 'taxable' : null);
    if (['taxable', 'zero_rated', 'exempt'].indexOf(applicability) === -1) return null;
    if (c.effectiveFrom) {
      const from = c.effectiveFrom.toMillis ? c.effectiveFrom.toMillis() : Date.parse(String(c.effectiveFrom));
      if (Number.isFinite(from) && from > Date.now()) return null;   /* not yet in force */
    }

    /* For a taxable supply the treatment of the stated price must be explicit; for zero-rated
       and exempt supplies there is no VAT to include or exclude, so `inclusive` is irrelevant
       and reported as null. */
    if (applicability === 'taxable' && typeof c.inclusive !== 'boolean') return null;

    /* An unattributable tax decision is not a decision. */
    if (!c.decidedBy) return null;

    return {
      applicability,
      taxCategory: applicability === 'taxable' ? 'standard' : applicability,
      inclusive: applicability === 'taxable' ? c.inclusive : null,
      decidedBy: String(c.decidedBy),
      reference: c.reference ? String(c.reference) : null,
      decidedAt: c.decidedAt || null,
      effectiveFrom: c.effectiveFrom || null,
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

/* Subscription fees are platform revenue too, and their VAT treatment is a SEPARATE
   business decision (advertised plan prices may be inclusive where a commission is not).
   Same contract: no default; unset ⇒ the subscription invoice is DEFERRED, never guessed.
   To arm: write revenueConfig/subscription_vat { enabled: true, inclusive: <bool>, decidedBy }. */
const SUBSCRIPTION_POLICY_DOC = 'revenueConfig/subscription_vat';
const SUBSCRIPTION_UNSET_REASON =
  'Subscription VAT treatment is not configured. Set revenueConfig/subscription_vat ' +
  '{ enabled: true, inclusive: <true|false>, decidedBy: "<name>" } once the tax ' +
  'position is formally decided. Subscription invoices are deferred until then.';

module.exports = { loadVatPolicy, POLICY_DOC, UNSET_REASON, SUBSCRIPTION_POLICY_DOC, SUBSCRIPTION_UNSET_REASON };
