## [2026-10-03] - webhookIntasend: the commission category comes from server records, never the client; unresolved → the seller credit is HELD

Functions only (`webhookIntasend`, new `functions/shared/commission-category-source.js`). Built on 73c5e5e. **Not deployed.**
- **Defect (2f lead, confirmed on 73c5e5e):**
  - The generic credit path priced commission with `payData.meta.category`, and `initiateSTKPush` copies `meta` verbatim from the client request. A modified client could name a 0% lane (jobs / construction_service) or the 5% default instead of marketplace 15%.
  - The seller-specific rule lookup used the PAYER's uid.
  - A failed commission calculation credited the seller 100%.
- **Fix:**
  - Product orders are priced under `marketplace` (owner 2026-09-19: one flat rate for every seller and product). The product's `category` is NOT read, because sellers can write it on the served rules. Live checkout sent `product`, which fell to the 5% default, and `marketplace` is 5% on this tree, so the price does not change. Other purposes use the category their server pricer stamped on the intent.
  - An unresolved category or a failed calculation HOLDS the seller credit: `commissionReviewQueue/commission_hold_{ref}` + `walletCreditSkipped: 'commission_unresolved'`. The buyer's payment still records as paid.
  - The commission lookup uses the attributed seller.
- **Behaviour change:** none for product orders. A payment whose server records name no category (a non-product purpose with no stamp) now holds the seller credit instead of charging the default.
- **Tests:**
  - `scripts/test-webhook-commission-category.js`: Layer A 7/0. Layer B (the real handler) is **UNPROVEN**: the harness refuses below the 512 MB floor, so it must run before deploy.
  - Existing suites: p0-payment-integrity 44/0 (all handler rows ran when memory allowed), product-intent 29/0, no-payer-credit 21/0, provider-method 14/0.

