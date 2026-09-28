# SOKONI Financial Core — locked architecture, current state, and the unit plan

**Status:** ARCHITECTURE LOCKED by the owner, 2026-09-28 · implementation proceeds as SEPARATE controlled units ·
nothing in this document is deployed by writing it.
**Related:** [[POS_COMMISSION_RAIL]] · [[Payments]] · [[SmartPOS]] · [[Orders]] · [[Marketplace]] · [[Events]]

This document exists so that every part of the locked architecture has a place:
- what the owner decided;
- what exists today, taken from the read-only census of 2026-09-28 (counts and field names only, positive control
  `posRetailSales` = 5);
- which unit closes each gap.

No unit may invent a new wallet, payment, receipt or commission authority outside this plan.

---

## 1. The locked architecture (owner, 2026-09-28)

```
                    SOKONI FINANCIAL CORE
       POS/Till            Marketplace            Booking
            └────────────────────┼────────────────────┘
                         Payment Authority  (channel-aware)
                   ┌─────────────┴─────────────┐
            IntaSend Payments            Wallet Authority (personal | business SOK-*)
                   └─────────────┬─────────────┘
                        Financial Documents
                  Invoice · Receipt · Credit/Debit note · Refund
```

1. **One Financial Center, separate typed records.** Merchant V2 gets a single Financial Center that replaces the
   "Receipts" button with "Financial Documents". It navigates sideways:
   Revenue → Payments → Wallets (Personal | Business) → Financial Documents (Invoices, Receipts, Credit Notes,
   Debit/Accountability Notes, Refund Documents) → Settlements.
   The UI is unified, but the records stay separate. There is no single ambiguous "financial record".
2. **Personal and business money never mix.**
   - A person owns a personal wallet. A business `SOK-*` owns a business wallet.
   - A cashier is not the merchant.
   - Business revenue goes to the business wallet only, and a buyer's wallet belongs to the buyer.
   - Every surface resolves the business identity FIRST.
3. **POS/Till declares its mode.** It runs in explicit **Business** or **Personal** mode and never infers the mode
   from whoever is signed in. The two ledgers never mix.
4. **Loyalty points have an owner and a scope.** Buyer points and business-earned rewards are separate. There is
   no global pool.
5. **Online payments are IntaSend only.** ONLINE_ORDER and BOOKING allow NO cash.
   - IntaSend checkout with no method named, so that every method the ACCOUNT has enabled is offered.
   - Record `paymentProvider = INTASEND` plus the provider's ACTUAL `paymentMethod`
     (M-PESA / CARD-PAYMENT / GOOGLE-PAY …). Never hard-code a list of methods.
6. **POS/TILL is wider.** It allows IntaSend (every enabled method), authorized cash, wallet, and other certified
   instruments. Cash must never leak into online checkout. The channel is encoded in the payment authority.
7. **One connected document system.** A single document system serves POS, marketplace, bookings and Merchant V2.
   Each document references its economic events: invoiceId, receiptId, orderId/bookingId/saleId, paymentId,
   businessId, customerId, currency, amount, tax, commission, status, createdAt.
8. **Documents link to each other.** Receipt → Payment → Order/Sale → Invoice → Wallet/Revenue, and
   Invoice → Payment → Receipt → Order/Booking.

---

## 2. Where each point stands today (census 2026-09-28, observed unless marked)

| # | Point | Today | Gap |
|---|---|---|---|
| 1 | Financial Center | Merchant V2 "Receipts" renders **orders** through SokoniReceiptDoc. It cannot read `posReceipts`: rules check `sellerId`, while the writers stamp `merchantId`. Revenue is a **client sum over 100 orders**, with no truncation guard. | FC-8 server aggregates, then FC-9 UI |
| 2 | Personal ≠ business | The live `webhookIntasend` credits **personal** `wallets/{uid}`, falling back to the **payer** (`index.js:7805`). There are **three** `businessWallets` designs: m02/ICC `{shopId, kind, ownerUid}`, RC `{SOK businessId, ownerId}`, and prod with 2 RC-shaped docs and **0 entries**. No live credit writer exists. | FC-1 wallet authority · FC-3 revenue routing |
| 3 | POS mode | No Business/Personal mode field anywhere in POS. The only business link is the M0-1 debt's `businessId`. | FC-4 |
| 4 | Points | `loyaltyAccounts` is a global per-uid pool (1 doc) with no business scope. `wallets.rewardPoints` also exists. | FC-7 (data migration) |
| 5 | Online = IntaSend only | **No server path rejects cash for online orders or bookings.** Known holes: `rentalBook` accepts "Cash on pickup" (`marketplace-extensions.js:362`); `clientOrderInit` does not constrain `paymentMethod`; `createPaymentSession` accepts `cash`. `api-gateway` is the only guard. **No record stores the actual IntaSend method**: the webhook hard-codes `mpesa_intasend` / `M-PESA`. RC has `intasend-method.js` / `actualMethod` (unmerged). | FC-2 channel + method contract |
| 6 | POS wider | POS cash is legitimate (`CASH_IN_DRAWER`). POS commission settlement accepts STK, hosted checkout and admin-confirmed cash (**M0-3**). | M0-3 (built) · FC-2 generalises the channel contract |
| 7 | One document system | **≥5 receipt writers**: `posReceipts` ×4 (trust, webhook, checkout, async job) and `receipts` ×2. **≥8 invoice stores**, all 0 docs. `financialReceipts` has sequential SKN numbering, VAT and a journal, but its only caller is retired Daraja. `landlord` / `sokoni-invoice` are **localStorage only**. Credit/debit notes are eTIMS-only. | FC-5 document authority |
| 8 | Linked navigation | Link fields are partial. `receipts` lack businessId and currency; `posReceipts` lack sellerId (rule mismatch), currency and invoiceId. | FC-5, then FC-9 |
| — | Refunds | **≥14 deployed refund entrypoints** and 5 stores (0 docs except 1 `settlementReversals`). `refundRequests` auto-credits a wallet. | FC-6 consolidate / freeze |

---

## 3. The unit plan — one controlled unit at a time, each certified before the next

Each unit follows the standing method: census, then design approval, then implementation, then an old/new
differential, one mutant per safeguard, the regression floor, and exact blobs. The unit then STOPS for commit
authorization. Nothing is deployed without its own authorization.

**Built and committed** (none deployed): P0 gate-off `ed57196` · M0-1 one debt `ab62fb7` · M0-2 sale
idempotency `8fc7ce2`.

| Unit | Scope | Depends on |
|---|---|---|
| **M0-3** | ONE settlement state machine for POS commission: STK, hosted checkout (card and all account methods; card data never touches SOKONI), admin-confirmed cash. Retires the day-based settle paths. | built; certification in progress |
| **M0-4a** | Pending-attempt sweep (owner ruling 2026-09-28). `confirmAttempt` is THE confirm authority, shared by the Confirm callable and a scheduled sweep (every 15 min):<br>• an attempt is eligible 10 min after `createdAtMs`;<br>• proven → PAID; failed → FAILED, claims released;<br>• ambiguous, no-reference-but-sent, or still pending 30 min after eligibility → NEEDS_REVIEW;<br>• provider never called → expired.<br>Every transition checks its source state inside its transaction. No wallet is touched and the till is never blocked. See [[POS-M0-4a-attempt-sweep]]. | built on this lineage; not deployed |
| **M0-4-DR-A** | Atomic debt creation. `posCompleteCheckout` and `recordPOSSale` create the debt and its ledger projection **inside** the sale's own transaction, through one pure builder (`buildDebt`), dated by the sale's own time. The sale and its debt commit together or not at all. Category is metadata only; 107 repository categories are proven to share the one authority. See [[POS-M0-4-DR-A-atomic-debt]]. | built on this lineage; not deployed |
| **M0-4-DR-R** | Deterministic reconciliation — a BACKSTOP, not a debt path. A **proven server sale** (id re-derived / M0-2 claim; SmartPOS mirror out of scope), completed, never voided or refunded, with recorded `soldAtMs`, route, gross, an established **rate era** and an unambiguous business, gets its one `poscomm_<saleId>` debt through the DR-A builder (create-only, re-judged inside the transaction). Anything unproven goes to NEEDS_REVIEW with a reason code. Admin callable `reconcilePosSaleDebts`; dry-run by default and writes nothing. The era boundary is null until deployment, so it reconstructs nothing before then; production's 5 historical sales all go to NEEDS_REVIEW. See [[POS-M0-4-DR-R-reconciliation]]. | built on this lineage; not deployed |
| **6a** | Checkout authority hardening, the precondition for SmartPOS convergence (6b). `posCompleteCheckout` proves the merchant **before** any idempotency claim, replay or resume (the existing proof, moved). Idempotency is merchant-scoped (`posIdempotency/pi_<sha(merchant|key)>`). Resume adopts only a record with the checkout's own provenance: never a `pos-mirror` record, which used to complete with no stock and no debt. The mirror refuses the reserved `ps_` namespace. The M-PESA reference trigger binds the merchant to the rule-bound `sellerId`. See [[POS-6a-checkout-authority]]. | built on this lineage; not deployed |
| **M0-4b** | 07:00 EAT collector from the business wallet, through the same debt and settlement authority, with no second collection engine. **Held until FC-1**: debts are keyed by `SOK-*` businesses, wallets are not, and no credit writer exists. A scheduled M-PESA prompt is a separate policy decision, not authorized. | FC-1, M0-4-DR |
| **M0-5** | Reconciliation: NEEDS_REVIEW / PAID_RECONCILE resolution (an AdminOS tool) and a reversal rule for a refunded or charged-back settlement. | M0-3 |
| **M0-6** | Deployment provenance:<br>• Artifact Registry authorization;<br>• the merchant-identity gap;<br>• reconcile `c4f6ced` (the product/customer-ownership checks on feat/creator-hub, which are **not** on this lineage) — disposition recorded at L-9C `6d8b0da`: not ported;<br>• the ICC gate-off port;<br>• the **controlled KES 10 live proof**;<br>• provision `INTASEND_PUBLISHABLE_KEY` (production has none). | before ANY deploy |
| **R-48H** | Remove the 48-hour commission (`sweepCommissionDue`, `PER_SALE_48H`, seller restriction). Code, plus a separately authorized production deletion. | owner confirmation |
| **FC-1** | Business-wallet authority: `businessWallets/{SOK-ID}` in the prod/RC shape, ledgered, with a credit writer. Retire the m02/ICC `{shopId}` design. Keep personal and business separate. | M0-6 lineage decision |
| **FC-2** | Payment channel + method contract:<br>• ONLINE_ORDER / BOOKING = IntaSend only, enforced server-side (close the rentalBook, clientOrderInit and createPaymentSession cash holes);<br>• POS_TILL = IntaSend + cash + wallet;<br>• record `paymentProvider` + actual `paymentMethod` (port RC `intasend-method.js`). | — |
| **FC-3** | Revenue routing: business revenue goes to the business wallet; remove the payer fallback. This touches the deployed webhook lineage and the live double-credit guard. | FC-1, FC-2, M0-6 |
| **FC-4** | POS/Till explicit Business/Personal mode. | FC-1 |
| **FC-5** | Financial-document authority:<br>• one numbering authority (the financial-engine design);<br>• the link fields;<br>• fix the `posReceipts` rule/writer mismatch;<br>• consolidate the receipt writers;<br>• invoices and credit/debit notes. | FC-2 |
| **FC-6** | Refund consolidation: one refund authority; freeze or retire duplicate entrypoints. Branch absence is not production retirement. | FC-5 |
| **FC-7** | Loyalty ownership and scope (data migration). | FC-1 |
| **FC-8** | Revenue and payments server aggregates, POS included. Replaces client sums. | FC-2, FC-5 |
| **FC-9** | Merchant V2 Financial Center UI (Financial Documents replaces Receipts), built on FC-1..FC-8. Every money UI differs across 4 lineages; the base must be chosen in M0-6. | FC-1..FC-8 |

**Standing constraints for every unit:**
- The till gate stays OFF (P0) until a certified settlement path is deployed and the owner authorizes a policy.
- Never route commission or business revenue through `initiateSTKPush` / `payments/{ref}` while the webhook's
  payer fallback exists.
- Production contention remains UNPROVEN on the emulator; it is recorded, not assumed.
- The Healthcare session (feat/creator-hub) defers Healthcare POS and pharmacy wiring until FC-1 provides the
  entry point.
