# Invoice stores census — six stores, one canonical invoice (owner 2026-10-04)

Related: [[E2E_RELEASE_GATE]] · [[Payments]] · [[Orders]] · [[FINANCIAL_CORE]]

**Owner rule:** the canonical invoice is the invoice attached to the underlying commercial transaction (order / booking /
quote) and its authoritative payment record. A store is never chosen because it holds the most documents. Only a
VERIFIED payment event makes an invoice paid; a merchant-entered reference is a claim.

**Production state (2026-10-04, read-only count; positive control providers = 11): all six stores hold 0 documents.** The convergence is a clean start: no legacy invoice, no merchant-marked "paid" and no duplicate exist in production, and the migration script is a no-op.

Evidence: the deployed source (adminOsDispatch archive gen 1788271885523075; financeSprintDispatch gen 1787386169391458)
plus the main checkout. Read-only; no production data was read.

## The six stores

| Store | What it actually holds | Who writes it (live) | How "paid" is set | Link to the transaction | Classification |
|---|---|---|---|---|---|
| `invoices` | **Three different documents in one collection:** (A) a merchant's manual invoice (`shopId`, `clientName`); (B) SOKONI's monthly commission bill to a seller (`sellerUid`, `period`); (C) an order invoice from the WAP workflow (doc id = `orderId`) | (A) finance-os invoiceCreate / Send / **MarkPaid** / Void via `financeSprintDispatch`; (B) `generateMonthlyInvoices`, `markCommissionPaid`; (C) wap.js `_svcInvoice` | (A) the merchant's word (**fixed**: now an unverified claim, 3df9c14); (B) an admin with a manual reference; (C) never | (A) none; (B) `period`; (C) `orderId` | **Legacy duplicate**: mixed semantics; must be split by a discriminator before any total is trusted |
| `etimsInvoices` | KRA eTIMS fiscal invoice / receipt for an order (+ platform fee invoices) | etims.js `generateForOrder` (trigger `etimsOnOrderCompleted`, `etimsGenerateInvoice`, bulk, platform) | never — status = KRA submission | `orderId`, idempotency `${seller}-order-${orderId}` | **Feature-specific (tax)**: a fiscal copy of the canonical invoice, never the commercial invoice |
| `hubInvoices` (+ `hubInvoiceQueue`) | Hub eTIMS fiscal invoice when the hub is the invoicing authority | hub-etims.js `_issueHubInvoice` (trigger + manual) | never | `orderId`, `hubId` | **Feature-specific (tax)**. Live has no queue consumer (main does) |
| `sasosInvoices` | SaaS subscription invoice + refund credit notes | `sasosCreateInvoice`, `sasosAdminRefund` | **the client's word at creation**: any `paymentRef` → `status:'paid'` | client `paymentRef`, `planId` | **Unclear provenance**: exclude from financial totals; **open hole** (see below) |
| `procSupplierInvoices` | Procurement supplier BILL (accounts payable — money the merchant owes) | `createSupplierInvoice`, `approveAndPayInvoice` (admin, manual ref + `paymentLedger`) | an admin with a manual reference | `poId`, `grnId` | **Feature-specific (payables)**: a different document type, never a sales invoice |
| `fosInvoices` | FinOS invoice generated from a payment transaction | `fosGenerateInvoice` | **copied from the payment record** (`fosTransactions`, completed by the verified `fosSecureWebhook`) — but not required to be COMPLETED | `fosTransactionId`, `payRef` | **Closest to canonical, immature**: the only store tied to a verified payment; non-sequential numbers, no client uses it |

## Duplicates — can one transaction be counted twice?

**Yes, today.** One order can produce:
- an `invoices` doc (WAP `invoice.generate`) **and** an `etimsInvoices` doc (`etimsOnOrderCompleted`);
- an `etimsInvoices` **and** a `hubInvoices` doc via the manual `etimsGenerateInvoice`, which has no hub check;
- a `fosInvoices` doc for its payment, on top of either.

So the invoice system is **not converged**. Any admin total across stores would double-count.

## Open money holes found by the census (not fixed by this document)

| Hole | Where | Owner |
|---|---|---|
| ~~Subscription invoice created `paid` from a client reference~~ **FIXED** 3c7eec6: payment_unverified + no cross-user leak | sasos-billing.js `sasosCreateInvoice` | f3 |
| ~~`createSupplierInvoice` shows no check that the caller owns the PO~~ **FIXED on e3's procurement line** (feat/parcel-rail-fn-on-5a0935e @ ca55f8b, not deployed): buyer derived from the authoritative PO; grnId must belong to that PO and merchant. Owner decision (via e3): an admin-approved supplier payment is a CLAIM until a verified payment matches it. **Built** de9fb9d: approveAndPayInvoice writes approved + paymentStatus claimed, never paid or ledger rows; a server-only, idempotent markSupplierInvoicePaidVerified is the only writer of paid. No verified supplier-payment rail exists yet, so claims stay claims | procurement.js | sokoni-e3 |
| ~~`_assertShop` accepts `users.role == 'admin'`~~ **FIXED** e99a961: only the Auth admin / superAdmin claim | finance-os-sprint43.js | f3 |
| ~~A FinOS invoice can be generated for a not-yet-COMPLETED transaction~~ **FIXED** d3d6190 (fix/fos-invoice-completed-on-live): verified-complete only, no default, one per transaction (race-proof) | financial-os.js `fosGenerateInvoice` | f3 |

## Recommended convergence (decision needed — see the owner question)

1. **Canonical store: `invoices`**, restructured, with
   - a required `source` (order | booking | quote | subscription | commission | manual) and `transactionRef`;
   - **payment allocations written only by the verified-payment path**. The logic is lifted from `fosInvoices`, the one store already tied to a verified payment;
   - `invoice.status` (draft → issued → partially_paid → paid; void; overdue) kept separate from `payment.status` (pending / processing / succeeded / failed / refunded).
2. **`etimsInvoices` / `hubInvoices`:** remain fiscal derivatives, keyed by the canonical `invoiceId`. They are never counted as invoices.
3. **`procSupplierInvoices`:** stays a payables store, a different document type that is never in sales totals.
4. **`sasosInvoices` → canonical** with `source: subscription`. The client-reference "paid" is removed, and payment state comes only from the verified webhook.
5. **`fosInvoices` → merged into canonical.** Its generation logic becomes the payment-allocation step, and the store is retired.
6. **Legacy `invoices` shapes:**
   - a server migration stamps `source` on every legacy doc: A → manual, B → commission, C → order;
   - shape-A `status:'paid'` docs are re-labelled as **unverified merchant claims**, not confirmed payments.
7. **Admin totals** read the canonical store only: confirmed paid = verified allocations, and unverified claims are shown separately. An unknown store or shape is never counted.

The critical test: one commercial transaction → exactly ONE canonical invoice in AdminOS.
