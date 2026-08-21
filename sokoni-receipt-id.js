/* ============================================================================
   ADR-009 — canonical receipt/invoice identifier accessor
   ============================================================================
   `receiptNumber` and `invoiceNumber` are canonical. `receiptNo` / `invoiceNo`
   are DEPRECATED aliases that still exist across the POS and print paths.

   This module is the ONE place new code may resolve either identifier. It is
   the single point that changes when the ADR-009 rename completes: when every
   document carries the canonical field, delete the alias arm here and the
   deprecated name is gone from the read path in one edit.

   Deliberately NOT a rename of any stored field. The live write/response
   contracts (`functions/subscription-pay-methods.js` return shape,
   `functions/payment-trust.js` void path, `posReceipts/{receiptNo}` document
   ids) are OPEN decisions and are untouched.

   Zero dependencies by design — its consumers span six pages that share no
   other script, so it must never assume a load order beyond its own tag.
   ========================================================================= */
(function (root) {
  'use strict';

  /* Canonical first, deprecated alias second. Returns '' (falsy) when absent
     so existing `|| '-'` style fallbacks at call sites keep working. */
  function receiptIdOf(doc) {
    if (!doc) return '';
    return doc.receiptNumber || doc.receiptNo || '';
  }

  /* An invoice is a DIFFERENT document from a receipt (ADR-009); it gets its
     own accessor rather than being folded into the one above. */
  function invoiceIdOf(doc) {
    if (!doc) return '';
    return doc.invoiceNumber || doc.invoiceNo || '';
  }

  var api = { receiptIdOf: receiptIdOf, invoiceIdOf: invoiceIdOf };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.SokoniReceiptId = api;
    root.receiptIdOf = receiptIdOf;
    root.invoiceIdOf = invoiceIdOf;
  }
})(typeof window !== 'undefined' ? window : null);
