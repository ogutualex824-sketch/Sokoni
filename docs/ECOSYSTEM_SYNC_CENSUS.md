# Ecosystem Sync — Section 0 census (read-only)

**Status:** CENSUS. **No code changed by this document.** Nothing deployed, pushed or written to production.
**Date:** 2026-09-30 · **Tree:** `slice/c4-convergence` (`C:/temp/sok-u7c2`), measured at `2175115` (Step 2 committed).
**Programme:** "SOKONI Final Ecosystem Sync — Merchant-v2, AdminOS, Payments, Fiscal and Real-Time Convergence".

Related: [[QUICK_CHARGE_CENSUS]] · [[ETIMS_CERTIFICATION_READINESS]] · [[REFUND_AUTHORITY_CONVERGENCE]] ·
[[COMMUNICATION_NOTIFY_BYPASS_BACKLOG]] · [[MERCHANT_RECEIPTS_TAX_AUTHORITY]] · [[RECEIPT_CONTRACT]] ·
[[TAX_ADVISOR_ENQUIRY]] · [[SECURE_RELEASE]] · [[IN_PROFILE_WALLET]]

> **Rule of this document:** every finding is a *static* reading of source in one tree. None is
> proven against production. Firestore rules were not evaluated for the client writes listed in §6,
> so "a page writes X" means "the page *attempts* X" — whether the served ruleset refuses it is
> **UNPROVEN** until measured against the deployed ruleset ([[reference_deployed_ruleset_authority]]).

---

## 1. Ownership (who else is working here)

- **This workstream:** `slice/c4-convergence`. Step 1 (Secure Release) is committed at `a496c8d`. Step 2 (Quick Charge)
  follows it.
- **Worktrees:** 285 are registered. None was pruned, reset, stashed or removed by this census.
- **Branches with commits on 2026-09-30, owned by other agents.** Do not edit their files.

  | Branch | Tip | Notes |
  |---|---|---|
  | `feat/f1-pickup-location` | `e91f9db` | |
  | `fix/promotion-product-ownership` | `ebaca6b` | |
  | `feat/compact-premium-cards` | `5323149` | |
  | `fix/phone-verify-routing-on-4ca00b8` | `bdbd29c` | |
  | `hosting/shell-gate-consumer-on-49e0f3a` | `07088bb` | |
  | `slice/c4-capability-consumer` | `5312c0f` | |
  | `feat/f1b-pickup-hosting` | `2f3bb6f` | **Live hosting.** Any hosting candidate must descend from it. |
  | `candidate/providerdispatch-shell-gate` | `95ff9e8` | |
  | `feat/integrations-control-center` | `7f64c30` | Main checkout; it has foreign dirty files. |
  | `feat/d2-rider-*` | — | Delivery programme D2. |

- **Areas that already have an owner or an open decision.** These are not re-opened here:

  | Area | Where it lives | State |
  |---|---|---|
  | eTIMS certification | [[ETIMS_CERTIFICATION_READINESS]] | About 65%. Blocked on KRA: real `cmcKey` auth, item code list, buyer PIN, sandbox certification. |
  | Refunds | [[REFUND_AUTHORITY_CONVERGENCE]] | Three lineages (A/B/C). The owner decided on 2026-09-26 that they converge **at the release merge**. |
  | Notification bypass | [[COMMUNICATION_NOTIFY_BYPASS_BACKLOG]] | Assessed; no migration authorized. |
  | Commission VAT | [[TAX_ADVISOR_ENQUIRY]] | No commission invoice may be issued until the tax advisor answers. |
  | Receipt renderer | [[RECEIPT_CONTRACT]] | `SokoniReceiptDoc` is LOCKED and certified 113/0; not deployed. |

## 2. Fiscal spine — KRA / eTIMS

| Fact | Finding | Class |
|---|---|---|
| Canonical seller authority | `functions/etims.js` (`generateForOrder`, `submitToKra` → `etims-kra-adapter.classifyResponse`, which reports ACCEPTED **only with `rcptNo`**). It also has `outcome_unknown`, a hash-chained `etimsAuditLog` and the transactional `etimsSequences`. | **AUTHORITY** |
| Lifecycle (credit/debit note, cancel, amend, reverse) | `etims-lifecycle.js` builds all of them, but the adapter has `SPEC_LOADED=false`, so transmission is `blocked_pending_spec`. | **BLOCKED (KRA spec)** |
| Event tickets | `event-fiscal.js` reuses `generateForOrder(submitNow:false)` and `credit_note`. | Aligned |
| Hub invoicing | `functions/hub-etims.js` has a second `EtimsClient` and its own `hubSequences`. It accepts on `resultCd==="000"` **without requiring `rcptNo`** (:648, :754). `hubResubmitInvoice` has no `outcome_unknown` guard. | **DUPLICATE + honesty defect** |
| Browser submitter | Root `/etims.js`, loaded by admin.html, posts to KRA from the client. Its counter is not transactional, it falls back to a `Date.now()` invoice number, and it uses `taxTyCd:'B'` at 16%, which contradicts the engine's A=16%. | **DUPLICATE, client-side** |
| POS fiscalisation | **None.** POS sales are never submitted. `posCompleteCheckout` labels its VAT `basis:'sokoni_estimate'` (honest). `async-job-handlers` only sets `etimsStatus:'pending'`. | **GAP (honest)** |

### Fabricated or unverified fiscal claims (violate "no fake KRA values")

1. `etims.js:703` sets `kraVerified: true` unconditionally. The live PIN check runs only in production. The flag feeds the
   "KRA Verified" profile badge (`profile-engine.js:56`).
2. `etims.js:376` — the receipt footer says "official KRA eTIMS fiscal receipt" even on **pending** documents. The badge at
   :316 is honest.
3. `invoice.html:316/440/455` labels every order invoice "KRA TAX INVOICE", with 16% VAT computed on the client and no
   eTIMS link.
4. `hub-etims.js:979-985` sets `etimsActive:true` even when KRA validation fails.
5. `pos-sales.js:154-156` copies the client-supplied `etimsInvoiceNo/etimsCode/etimsQR`. The receipt printers render them.
6. `pos-integrations.js:703-733` `markSaleSubmittedToETIMS` stores a manager-typed reference as `etimsSubmitted:true`.
7. `etims.js:1174` has a hard-coded device serial `"SOKONI-VSCU-001"`.
8. Marketing copy:
   - about.html:204 "KRA eTIMS compliant"
   - faq.html:199 "every sale automatically generates a compliant eTIMS invoice"
   - trust-and-safety.html:416

   These contradict `integration-registry.js:139` ("NOT live … sandbox never run").

## 3. Tax, levies, payroll

- **Tax engine:** `etims-tax-engine.js` has A=16%, B=0 and C=exempt.
  - The category comes from the business `vatStatus` or a per-line `vatStatus`. **There is no product tax-class field.**
  - The D/E buckets are never assigned, and there is no 8% rate.
- **Duplicate VAT maths (about 12 places):**
  - Server: `financial-engine._splitTax`, `finos-utils.calculateVAT` (exclusive), `finos-router:1018`, `index.js _TAX`,
    `pos-accounting`, `procurement`, `pos-session`, `sasos-billing`, `business-bootstrap`.
  - Client: invoice.html, seller.js, admin.html, pos-accounting.html, pos-checkout.html:1714.
- **Levies:** **no framework exists.** The only levy anywhere is the Housing Levy, inside payroll. Every category is
  therefore `REQUIRES_REVIEW` for levies; none may be invented.
- **Payroll** (`hr-payroll.js`):
  - It correctly never touches eTIMS or sales receipts.
  - The statutory tables are stale: NHIF instead of SHIF, the old NSSF tiers, and a Housing Levy of 1.5% whose PAYE
    interaction is not handled.
  - Runs go draft → approved only. There is **no payment step, no paid state and no statutory remittance record.**
  - Client duplicates: `pos-finance.js`, `seller.js`.
  - Changing statutory rates is **REQUIRES_REVIEW** (legal basis plus effective dates). The owner or an advisor must
    supply them; this programme must not guess them.

## 4. Payment → record → receipt

| Purpose | Commercial record | Receipt | Class |
|---|---|---|---|
| `pos_till_sale`, sale-bound | `posRetailSales` + `posReceipts/{saleId}` (Step 2) | one | Aligned |
| `pos_till_sale`, buyer-typed (pay-q) | intent only | webhook `posReceipts/{intentRef}` | Aligned by design (no cashier sale) |
| `product_order` | `orders` via `_finalizeMarketplacePayment`, wrapped in a try/catch that logs "recoverable" | `posReceipts/{apiRef}` **and** `receipts/{apiRef}` | **DUPLICATE receipt**; PAID-without-order is possible |
| film / event / venue | `payments/{id}` triggers (self-settling) | generic `receipts/{paymentId}` only (`read:false`) | PARTIAL |
| `service_booking` | held → `providerBookings`; the legacy `bookings/{apiRef}` is built from client metadata | generic | PARTIAL |
| subscription | **two activators**: webhook :8761 and `subAutoActivateOnPayment` | generic | DUPLICATE activator |
| `hub_registration` | **no PAID handler anywhere** | generic | **FAIL — PAID with no record** |

Receipt store and number defects:
- **Rule/writer mismatch.** The `posReceipts` read rule checks `sellerId`, but the writers set `merchantId`, so a merchant
  cannot read their own receipts. This has been known since [[MERCHANT_RECEIPTS_TAX_AUTHORITY]] (2026-08-16).
- **Receipt numbers.** `receipt-number-authority.js` exists and says "NOT INTEGRATED", while about 12 other generators are
  in use.
- **Verify vs void.** `verifyTrustReceipt` looks a receipt up by its doc id, but `voidTrustReceipt` searches the
  `receiptNo` field. Marketplace and Quick-Charge receipts only have `receiptNumber`, so they cannot be voided.
- **Client-amount receipt writers.** `finosGenerateReceipt` and `recordPOSSale` (the second POS rail) take amounts from
  the client. `generateTrustReceipt` is called from checkout.html with browser amounts; it is refused for buyers, and a
  `.catch` hides the refusal.
- **Refunds** write no receipt or credit note, and `posProcessRefund` does not void `posReceipts`. About 12 refund
  entry points exist ([[REFUND_AUTHORITY_CONVERGENCE]]).
- **AdminOS order status.** `adminUpdateOrderStatus` can set "completed" on an unpaid order from free text, bypassing
  `orderAdvance`.

## 5. Notifications, realtime, AdminOS ↔ merchant

- **Notification authority:** `functions/notify.js notify()`.
  - Bypasses: 8 private `_notify` helpers, `sendFcm` ×4, `messaging().send` in 7 files, and about 40 direct
    `notifications.add` writes.
- **Recipient field split.** Clients query `targetUid`, but writers also use `userId`, `uid` and `recipientUid`. Those
  rows are **invisible** in the feed.
- **Double sends.** The buyer gets `payment_success` **twice** (the dedupe keys differ); the seller gets up to three.
- **Dead links:**
  - `/receipt/{id}` and `verifyUrl` have no rewrite, so they 404.
  - `/my-bookings` has no page.
  - `track.html?orderId=` — the page reads `?order=`.
  - Links still point to `seller.html` and `wallet.html`; the canonical homes are merchant-v2 and `profile.html#wallet`.
  - `food-hub.html` and `/subscription.html` do not exist.
- **Realtime:**
  - Buyer orders/payments, notification feeds, POS `posProducts`/`posInventory` (a separate store from `products`) and
    `clickAndCollect` update live.
  - **merchant-v2 has 0 listeners** (orders and payments use a 60 s cache). The product page, cart, store and AdminOS
    lists load once.
  - Dead listener: `sokoni-offers.js:64` listens to the legacy `offers` collection.
- **AdminOS → merchant:**
  - A product removal plus `adminNote` shows in merchant-v2 as "draft", and the note is never shown.
  - merchant-v2 reads only `shops.status==='suspended'` and never the compliance decision.
  - An AdminOS refund goes through finos `processRefund` and does not reach the merchant's sale or receipt.
  - Disputes are aligned.

## 6. Destination pages with competing workflows (client writes — rules UNPROVEN)

| Page | Competing logic | Canonical target |
|---|---|---|
| `seller.html` + `seller.js` | A second merchant workspace: localStorage orders, status, wallet and commission ledger; direct product/stock writes. **merchant-v2 iframes it** (merchant-v2.html:1426). | merchant-v2 modules |
| `checkout.html` | Client `total` on an order `setDoc`, local points (+25), localStorage stock decrement | server order/payment/loyalty |
| `invoice.html` | localStorage invoices marked "paid"; "KRA TAX INVOICE" | receipts/eTIMS |
| bnb-manage, food-dashboard, food-menu, legal-hub, car-hub, car-rental, property-hub, services | Client status writes, client commission (legal-hub persists it), localStorage bookings, property listings `active` without approval | booking/order/commission authorities |
| admin.html, superadmin.html, super-admin.html | Direct approval, seller `active` and **commission-rate** writes | admin-os callables |
| seller-earnings vs seller-wallet | Redirect to different "one wallet"s (profile#wallet vs wallet.html) | `profile.html#wallet` (Step 1) |

Two payout callables are still exported: `commission.requestWithdrawal` and `wallet.requestSellerPayout`.

Already canonical: event/venue/entertainment, seller-fulfilment/delivery, payment-receipt, wallet.html, customer-display.

## 7. Acceptance matrix — starting state (FACT × SURFACE, all categories)

Legend: PASS · PARTIAL · FAIL · BLOCKED · UNPROVEN · n/a.

This is the **static** starting state. No cell is PASS without a test, so most cells read UNPROVEN until a slice
certifies them. The full CATEGORY × SURFACE × FACT matrix is built slice by slice under `docs/ecosystem-matrix/`.

| Fact | merchant-v2 | AdminOS | POS/Sell | Quick Charge | checkout | receipts | notifications |
|---|---|---|---|---|---|---|---|
| price | UNPROVEN | n/a | PASS (server priced) | PASS (Step 2) | FAIL (client total) | PARTIAL | n/a |
| points | UNPROVEN | UNPROVEN | PASS (P1/P2) | PASS (Step 2) | FAIL (local +25) | PARTIAL | n/a |
| stock | UNPROVEN | n/a | PASS (txn) | n/a | FAIL (localStorage) | n/a | n/a |
| payment | UNPROVEN | UNPROVEN | PASS | PASS | UNPROVEN | PARTIAL | FAIL (double send) |
| tax | UNPROVEN | UNPROVEN | PARTIAL (estimate, honest) | PARTIAL | FAIL (client 16%) | PARTIAL | n/a |
| levy | BLOCKED (no framework) | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | n/a |
| KRA/eTIMS | FAIL (fabricated badge) | UNPROVEN | FAIL (client eTIMS fields) | n/a | n/a | FAIL (invoice.html) | n/a |
| receipt | FAIL (rule mismatch) | UNPROVEN | PASS (one receipt) | PASS | FAIL (duplicate) | PARTIAL | FAIL (dead link) |
| refund | UNPROVEN | FAIL (not reflected) | PARTIAL | UNPROVEN | UNPROVEN | FAIL (no credit note) | UNPROVEN |
| commission | UNPROVEN | UNPROVEN | PASS (settlement) | PASS | FAIL (client) | n/a | n/a |

## 8. Slice order — LOCKED by the owner (2026-09-30)

1. **Step 2** Quick Charge commit.
2. **This census** — its own commit.
3. **Unmetered-stock fix.** `posCompleteCheckout` writes `stock: -qty` onto an item with no stock field, contrary to
   `shared/sellability.js`. Found by `test-quick-charge-sale.js` QS8 (the cyber basket).
4. **Payment-label security.** Every tender label (split, gift_card, mpesa_till_manual, …) needs server-side evidence.
   This includes a census of the legacy `pos-qr.js` rail, which is not to be deleted.
5. **Category capability matrix.** merchant-v2 modules become category/capability aware, using the existing matrix
   rather than 100 dashboards. Then the CATEGORY × SURFACE × FACT acceptance run.
6. **Remaining fiscal / receipt / realtime convergence**, each its own slice:
   - **ES-1 Fiscal honesty (narrow).** For each of the 7 code locations in §2, trace the source of every displayed or
     generated KRA value. Confirmed evidence → show the real value or state. No evidence → remove it, or show
     UNCONFIRMED/PENDING.
     - Never invent: KRA PIN, eTIMS invoice number, OSCU token, VSCU identifier, fiscal verification status, KRA QR,
       submission reference, KRA acceptance, or a certificate/approval claim.
     - No OSCU/VSCU integration is built in this slice.
     - The three public marketing pages are **out of scope** (owner decision: keep).
     - Goal: build the SOKONI-side authorities and interfaces now, so the eventual KRA connection is an integration and
       certification step, not a rebuild.
   - **ES-2** `hub_registration` payment integrity: no PAID without a record.
   - **ES-3** Online duplicate receipts: one payment → one canonical receipt.
   - **ES-4** Merchant POS receipt authorization: the `sellerId`/`merchantId` rule-field mismatch. Measure against the
     served ruleset first.
   - **ES-5** Duplicate payment-success notifications.
   - **ES-6** Broken notification destinations.
   - **ES-7** merchant-v2 live updates.
   - **ES-8** Workflow fragmentation across the ~17 standalone pages, one page per slice.

## 9. Decision items — NOT engineering work until the owner or advisor supplies them

| Item | Waiting on |
|---|---|
| **MARKETING CLAIMS — OWNER DECISION 2026-09-30: KEEP AS WRITTEN** (about.html:204/225, faq.html:199, trust-and-safety.html:243/271/416) | Decided. Not rewritten, removed or weakened. This is a **product decision, not evidence**: the matrix keeps recording KRA/eTIMS at its real implementation state until KRA evidence exists. Nothing is fabricated to make the claims look operational. |
| Levy framework | Legal basis and rates per category/location |
| Payroll statutory tables and payment | Current PAYE/SHIF/NSSF/Housing-Levy tables and start dates |
| Commission VAT | Tax advisor ([[TAX_ADVISOR_ENQUIRY]]) |
| eTIMS OSCU/VSCU integration | KRA specification and credentials ([[ETIMS_CERTIFICATION_READINESS]]) |
| Refund convergence + credit notes | Release-merge decision ([[REFUND_AUTHORITY_CONVERGENCE]]) |

**Target shape.** merchant-v2 is the business workspace, AdminOS the administrative authority, and destination pages
specialized views. The canonical server authorities hold the business truth. So a cyber's 20 prints + 5 envelopes is
one basket → one sale → one payment → one sale number → one receipt → one fiscal record → correct stock and service
accounting → one points event.
