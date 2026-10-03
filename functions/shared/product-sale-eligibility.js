'use strict';
/**
 * PRODUCT SALE ELIGIBILITY — the ONE rule every SOKONI-mediated sale consults (owner, 2026-10-03).
 *
 * "A canonical PRODUCT-LEVEL TAKEDOWN blocks SOKONI-mediated POS/TILL sales as well as online marketplace/discovery."
 * The till and the online checkout stay SEPARATE transaction domains (a physical POS sale is not a marketplace
 * order); both obey THIS moderation enforcement.
 *
 * The canonical takedown is the report authority's (trust-safety.js tsReviewReport, community C2/C3):
 *   products/{id}.moderationHold = { reportId, reason, by, at, … }  + isVisible:false
 * written when a report is upheld and removed ONLY by an authorised AdminOS restore. `isVisible:false` ALONE is the
 * seller's own switch-off (hidden from the marketplace) and does NOT block the seller's own in-store sale.
 *
 * Pure. @returns null when sellable, else { reason:'PRODUCT_UNDER_MODERATION', message } — never thrown here.
 */
function saleBlock(product) {
  const p = product || {};
  if (p.moderationHold) {
    return { reason: 'PRODUCT_UNDER_MODERATION',
      message: 'This product is under review by SOKONI and cannot be sold right now.' };
  }
  return null;
}
module.exports = { saleBlock };
