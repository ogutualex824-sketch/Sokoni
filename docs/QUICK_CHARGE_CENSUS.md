# Quick Charge — Customer + Points census (Step 2)

**Date:** 2026-09-30 · **Branch:** `slice/c4-convergence` @ `a496c8d` (clean) · read-only census before coding
**Related:** [[SMART_CUSTOMER_SEARCH]] · [[PAYMENT_LABEL_AUTHORITY]] · [[SECURE_RELEASE]] · [[COMMERCE_CONVERGENCE_CENSUS]]

## Ownership

- **No other agent owns these files.**
  - Every commit touching Quick Charge, points and customer files since 2026-09-27 is from this programme: d4a48fe,
    ef1e992, 8b9ca72, 65fd706, 30c6066, e19e6c0, 4ad69bf and 938d94e.
  - The only others are two customer-scope ports on the POS lineage (52b9ed6, 64d68b1), which are not live here.
- **Owner direction (2026-09-30):** "use till and poscheckout". Quick Charge completes through the canonical till
  sale, the same one pos-checkout and the till (merchant-v2 Sell) use.

## Where Quick Charge lives today

| Entry point | File / function | What it does |
|---|---|---|
| Till & QR module (merchant-v2) | `sokoni-merchant-till.js` `onGenerateDynamic` | A typed amount plus an optional note becomes ONE free-typed line `{name: note \|\| 'Sale', price}`. `createPaymentIntent('pos_till_sale')` → dynamic QR → the buyer pays on pay-q. There is an optional `buyerPhone` for points P1, and QC-a "pay part with points" |
| Pricer | `functions/payment-purposes.js` `pos_till_sale` → `functions/sokoni-qr-authority.js` `priceTillSale` | Free-typed `items[]` (name/price/qty, **no catalogue id**) or a buyer-typed `amount`. **Owner-only** (`callerUid === till.merchantUid`). QC-a points: `validateQuickChargeRedemption` reduces the intent amount |
| PAID | `functions/index.js` webhook, "Till sale PAID" branch (~8065) | The intent → `paid`; `consumeHold` for QC points; `paymentComponents`; **writes `posReceipts/{intentRef}` (channel `quick_charge`)**; earns P1 points for `buyerPhone` (or the paying phone for `buyer_entered`) |
| Buyer pay page | `pay-q.html` | The buyer pays a dynamic intent, or types the amount on a permanent Till QR (`buyer_entered`) |
| Legacy parallel QR rail | `functions/pos-qr.js` (`generatePOSPaymentQR` / `initiatePOSQRPayment` / `completePOSQRPayment` / `refundPOSPayment`), used by `pos.html` and `pay.html` | A second IntaSend till rail. Out of scope; recorded |
| Unwired design | `functions/shared/pos-service-pricing.js` `priceServiceBasket` | A pure core with three price sources (`catalogue` / `variable` / `quick_charge`). **Nothing requires it.** Its catalogue lane still reads `posProducts` (the old catalogue) |

## Census table

| Area | Existing authority | Quick Charge currently uses | Gap | Owner |
|---|---|---|---|---|
| Customer | `posCustomers` via `pos-customer-scope.js` (`phoneKey` = wallet-engine normaliser; `searchKeys`; `searchOwned`/`saveOwned`/`cardOf`; opaque ids) + `posCustomerSearch/Save/Card` (pos-zero-friction) — d4a48fe | nothing (a typed `buyerPhone` for points only) | no search, no attach, no customer on the record | this programme |
| Catalogue | canonical `products` (posCompleteCheckout reads, verifies ownership, saleability, stock) | none — free-typed lines only | a free-typed line is not a product (correctly); catalogue till sales already go through Sell / pos-checkout | this programme |
| Price | products → posCompleteCheckout; cashier-named figures → `priceTillSale` / `pos-service-pricing` quick_charge lane | `priceTillSale` (owner-only, unbounded apart from MIN/MAX) | no per-line description requirement, no quick-charge ceiling, no attribution | this programme |
| Offers | `shopOffers` applied by posCompleteCheckout (U7c2) | none | n/a for a free-typed service (offers attach to products) — must not be computed locally | this programme |
| Points earning | `loyalty-points.earnForSale` — posCompleteCheckout (till), webhook (QC + buyer_entered), orders (online) | webhook, from a typed `buyerPhone` | not bound to a sale or customer | this programme |
| Points spending | `loyalty-points-spend` — P2b till OTP (`tillStart/tillConfirm/validateTillTender` + `consumeHoldTx` in posCompleteCheckout); QC-a (`validateQuickChargeRedemption` + webhook `consumeHold`) | QC-a | two till spend paths | this programme |
| Payment | IntaSend `pos_till_sale` intent, proven PAID + claimed once by posCompleteCheckout (ef1e992) | the same intent, but no sale claims it | the payment is not bound to a sale | this programme |
| Sale | `posCompleteCheckout` → `posRetailSales` (products only) | **none** — the paid intent is the only record | no canonical sale; POS reports and sales views never see a Quick Charge | this programme |
| Inventory | posCompleteCheckout (transactional, floored) | none | correct for a service line; catalogue items belong to Sell / pos-checkout | this programme |
| Receipt | posCompleteCheckout → `posReceipts/{saleId}` | webhook → `posReceipts/{intentRef}` | **defect:** Sell / pos-checkout M-PESA/card sales get BOTH receipts (the webhook writes one for every paid till intent, including ones a sale claims) | this programme |

## Payment support today

- **Quick Charge (Till module):** IntaSend only (M-PESA or card via the QR). No cash, split, gift card or offline.
- **pos-checkout / Sell:** cash, M-PESA, card, points, gift card and split, all through posCompleteCheckout.

## Existing tests

- `test-points-quick-charge` 4/0 and `-browser` 4/0 (QC-a).
- `test-points-p1*`, `test-points-p2b*`, `test-smart-customer-*`, `test-payment-labels*`.

## Known failures (pre-existing)

- `test-smart-customer-poscheckout-browser` CP1: 5/1 on both `1f21885` and `a496c8d` (outside this slice).
- `creator-completion` commission row: 1 failure on the parent.
- `auth-verify-gate` H2 and `entertainment-registry` panel op: 1 failure each on the parent.

## Plan (one slice)

1. **Canonical sale:** `posCompleteCheckout` accepts a `quickCharge` line. It is priced by the existing
   `pos-service-pricing` quick_charge lane: description required, bounded, attributed to the cashier, and refused if
   the business may not trade. It has no product, no stock and no offers. Everything else is the existing sale
   authority: customer, points, payment proof, receipt and commission.
2. **Till & QR Quick Charge** becomes a client of it:
   - Smart Customer Search (the same callables);
   - description + amount;
   - the intent bound to its sale id;
   - PAID → posCompleteCheckout;
   - points through the P2b buyer-confirmed till redemption.
3. **pos-checkout** gets the same "Quick charge" line.
4. **Webhook:** a paid intent bound to a sale (`metadata.saleId`) gets NO webhook receipt or points — the sale owns
   them. This fixes the duplicate receipt.
5. **Kept separate:** a buyer-typed permanent-Till payment (`buyer_entered`, pay-q), where there is no cashier sale.

## Result (2026-09-30) — what was built, and how it differs from the plan

**Owner direction mid-slice: "use till and poscheckout".** Plan item 2 (a Till & QR client with its own customer
search and redemption) was therefore **not** built. The Till & QR module's free-typed charge card now hands over to
merchant-v2 Sell, and a Quick Charge is a line rung on Sell or pos-checkout. There is one screen per sale, not a second
Quick Charge flow. Items 1, 3, 4 and 5 were built as planned. The webhook's sale-bound signal is `metadata.saleBound`,
set by the pricer, and not the mere presence of `metadata.saleId`.

### Evidence

**Server** — `test-quick-charge-sale.js` **8/0**:

| Check | What it proves |
|---|---|
| QS1 | A quick-only sale is canonical |
| QS2 | Product + quick line: stock is taken once |
| QS3 | Bad input is refused before any write |
| QS4 | The dry run prices the line identically |
| QS5 | The attached customer earns once; no account → none; another shop's customer is refused |
| QS6 | The payment is sale-bound, and intent-level points are refused |
| QS7 | A quick line carrying a productId is refused before any payment, stock, receipt or points move, **with a positive control** |
| QS8 | **The cyber basket (permanent):** printing (a service, `trackInventory:false`) 20×10 + A4 envelopes 5×20 + scanning (quick charge) 3×30 → ONE M-PESA payment, ONE sale, ONE receipt, KES 390; envelopes 50 → 45 |

**Browser** (real Chromium, real callables):

- Sell `test-quick-charge-sell-browser.js` 5/0
- pos-checkout `test-quick-charge-poscheckout-browser.js` 5/0
- the Till handover `test-till-quick-charge-handover-browser.js` 5/0

**Deliberate breakages:**

- Server 10/10, plus Q2b: removing the productId guard is caught by QS7.
- UI 7/7 (U1–U7).
- Every file was restored byte-identically.

**Parent comparison (`a496c8d`).** Each new suite fails on the parent because the feature is absent:

| Suite | Result on parent | Why it fails |
|---|---|---|
| quick-charge-sale | 0/8 | "Product undefined not found" |
| quick-charge-sell-browser | 1/8 | No quick-charge control |
| quick-charge-poscheckout-browser | 2/7 | `Checkout.quickChargeOpen is not a function` |
| till-quick-charge-handover-browser | 3/5 | The free-typed form is still on the Till |

The checks that pass on the parent are invariants: no page errors, the permanent QR is still drawn, and nothing mints
a payment.

**Full regression, 282 suites, `a496c8d` vs Step 2.** 263 identical, 19 different, every one explained:

- **Uncommitted-change guards (5):** cart-food, cart-marketplace, cart-page, cart-wishlist-page,
  catalogue-canonical-migration. Each reads `git diff`/`git status` and fails only while Step 2 is uncommitted.
  Re-run on the committed tree (below).
- **Removed, superseded (2):** points-p1-quick-browser and points-quick-charge-browser. The screen they drove no longer
  exists.
- **New (4):** the Quick Charge suites above, all green.
- **Intended behaviour change (1):** smart-customer-search SC10. The attached customer now earns on the sale, so her
  card reads 1,240 + 100 = 1,340. The test was updated with its reason and asserts exactly one earn row. The updated SC10
  fails on the parent (1,240).
- **Same result on both trees (1):** merchant-ecosystem-convergence 144/1, the flash-sale productId finding
  (pre-existing). The parent's row was corrupted by a run that was killed, so the comparison labelled it "NEW".
- **Flaky or environment, re-run on both trees (6):** merchant-customers-ui, merchant-diag,
  smart-customer-poscheckout-browser CP1, merchant-v2-ecosystem-runtime (timeout), profile-command-prompt (timeout) and
  provider-dashboard-sidebar-browser. Results are recorded in the Step 2 commit report.

### Found by this slice, deliberately NOT fixed here

- **Unmetered stock goes negative (pre-existing; found by QS8).**
  - `posCompleteCheckout` writes `stock: -qty` onto an item with no stock field. The next sale is then refused.
  - The same defect sits in the till refund path (`+qty` creates stock) and in the online stock writers.
  - It is the next slice: inventory convergence, Phase A (till) then Phase B (a shared deduction helper in
    `shared/sellability.js`).
- **pos-checkout offline save:** calls `PosSales.park`, which does not exist. Belongs to the offline-convergence slice.
- **`pos-qr.js`:** a parallel QR rail, censused in the payment-label slice. Not to be deleted.
- **Sale-record lines:** catalogue lines carry no `lineTotal`; quick lines do.
