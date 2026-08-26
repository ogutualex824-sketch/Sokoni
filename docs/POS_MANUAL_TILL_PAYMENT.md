# POS — Manual M-PESA Till Payment

**Status:** BUILT, **not deployed** · 57/0 — awaiting two-device certification
**Date:** 2026-08-27
**Related:** [[MERCHANT_OWNED_PAYMENTS]] · [[RECEIPT_CONTRACT]] · [[COMMISSION_ENFORCEMENT_CONTRACT]]

---

## 1. The flow

```
sale → M-PESA Till Payment → enter reference → recorded paid → sync → receipt → print
```

The customer pays the merchant's own Till **directly**, out of band. The cashier then
records the M-PESA confirmation code against that sale.

**No Safaricom API dependency.** No STK Push, no Daraja credentials, no callback, no
shortcode, no C2B.

## 2. What the record means — and what it does not

> **Recording is not verification.**
>
> `mpesa_till_manual` means *the cashier recorded that this sale was paid by M-PESA and
> supplied the transaction reference.* It does **not** mean SOKONI independently confirmed
> that Safaricom received the money.

With no C2B webhook or STK callback on this path there is no way to ask Safaricom anything.
The distinction is carried in the data, not just in prose:

```js
paymentMethod:     'mpesa_till_manual'
paymentVerified:   false
paymentAttestedBy: 'operator'
```

Other payment methods are deliberately **not** given a verification status by this change. An
invented `paymentVerified: true` on cash or card would be a fabricated fact; an absent field
is honest. The POS UI carries the same statement, so a cashier is never shown a claim the
system cannot support.

## 3. Canonical record: `posTransactions`

Decided 2026-08-27. It is what `PosSyncEngine` actually writes, and the write is already an
idempotent `setDoc`.

```
payment.complete()  →  PosDB.transactions.save()  →  syncQueue
                                                        ↓
                                              PosSyncEngine (idempotent setDoc)
                                                        ↓
                                                 posTransactions
```

`posCompleteCheckout` is **not** an authoritative write — `pos.js` calls it with
`dryRun: true, shadow: true` as a comparison harness.

## 4. One vocabulary, so it stops growing

`mpesa_till_manual` is a **payment origin**, not a new payment concept. When the other
origins arrive they sit alongside it and feed the same transaction and receipt pipeline:

| Origin | Meaning | Verified by |
|---|---|---|
| `mpesa_till_manual` | customer paid the Till; cashier recorded the code | operator only |
| `mpesa_c2b` *(future)* | Safaricom C2B confirmation to a webhook | Safaricom |
| `mpesa_stk` *(future)* | STK Push initiated by SOKONI, callback confirmed | Safaricom |

This is the point of a distinct value. Collapsing all three into `mpesa` would make an
operator-attested payment indistinguishable from a Safaricom-confirmed one — permanently,
because the information would never have been recorded.

Pre-existing divergence this does **not** fix: seven method spellings (`mpesa`, `M-PESA`,
`mpesa_daraja`, `mpesa_intasend`, `cash`, `counter`, `shift_summary`) and four reference
spellings (`mpesaRef`, `mpesaCode`, `mpesaReceipt`, `mpesaReceiptNumber` — already coalesced
in `functions/admin-os.js:770`).

## 5. Uniqueness is claimed on the server

> **One M-PESA confirmation code may be attached to at most one completed sale.**

The client check in `pos.js` only sees its own device's history. The POS is **offline-first**,
so two devices can accept the same reference with neither able to see the other. The
authoritative guard is a deterministic transactional claim in
`functions/pos-mpesa-refs.js`:

```
mpesaReferenceClaims/{merchantId}__{REFERENCE}
```

* **Transactional** — concurrent claims race for one document; exactly one wins.
* **Idempotent for the same sale** — the sync queue retries, and a retry must not read as a
  duplicate.
* **Merchant-scoped.** A Safaricom receipt number is globally unique, so a global namespace
  would also catch cross-merchant reuse. Not used: it would let one merchant's record block
  another's sale, coupling tenants that must stay isolated. Cross-merchant reuse surfaces in
  `mpesaReferenceConflicts` for review instead.

### A duplicate does not reject the sale

By the time a reference reaches the server **the customer has already paid the Till** — the
money moved before SOKONI heard about it. Refusing or voiding the sale would destroy the
record of a real payment and leave the merchant with money they cannot account for.

So a duplicate is written to `mpesaReferenceConflicts` and the transaction is marked
`mpesaRefClaim: 'conflict'`. Status and total are untouched. A human decides which record is
wrong; the system's job is to make the collision impossible to miss.

This mirrors the existing oversell rule: *a post-payment race is flagged, never rejected.*

**Rules:** neither collection appears in `firestore.rules`, and there is no `{document=**}`
catch-all — so both are **default-denied to all clients** and reachable only by Cloud
Functions through the Admin SDK. No rules change was needed, which also avoids the compiled
ruleset size ceiling.

## 6. The receipt hop that was already broken

`PosPrintService` renders its payment block from a `payments` array
(`sokoni-pos-print-service.js:1243 → payment()`). **Nothing ever populated it.**

`receiptData` spreads the transaction, which had no `payments` field, and the call site
passed `context.payments = txn.payments` — also undefined. So `payments = []`, `b.payment()`
was never called, and **POS receipts have been printing with no payment section at all**: no
method, no code, no tendered, no change. The renderer supported every one of those.

Building the tender array is what lets a Till reference reach paper. It **also restores the
payment section for cash and card**.

> ⚠️ **User-visible change.** Every POS receipt will now show a payment section that was
> previously absent. This is a fix, but it is a change to what customers receive and should
> be expected rather than discovered.

`amount` (applied to the sale) is kept distinct from `tendered` (handed over). Conflating
them would overstate takings on every cash receipt.

### A split sale is TWO tenders

Caught in review, before deployment. `payment.complete` receives `method: 'split'` with
`splitCash` / `splitMpesa` (the split monkey-patch in `pos.js`). A single-line builder would
have emitted one tender labelled **`split`** — a word that names no payment method — with
the M-PESA code attached to it, and **printed exactly that on the customer's receipt**.

Previously invisible, because the payment section never rendered at all. Restoring the
section is what would have exposed it.

```
split: cash 300 + M-PESA 700
   →  [ {method:'cash',  amount:300},
        {method:'mpesa', amount:700, ref:'QK72ABC123'} ]
```

`PosPrintService.payment()` groups by method and prints a code per tender precisely for this
case, and `SokoniReceiptDoc` carries the same rule. The code sits on the M-PESA tender only.
A zero-value portion emits no line, and a tender set is never empty.

The suite **executes the shipped builder** for this rather than matching its source text — a
split rendering wrongly is a runtime fact and has to be tested as one.

### The live renderer is not `SokoniReceiptDoc`

`sokoni-receipt-doc.js` **is** loaded by `pos.html:2383`, but `PosPrintService` references it
**zero** times. Wiring the reference into `SokoniReceiptDoc` would have printed nothing. The
test suite asserts this assumption stays true, so the day the POS moves onto
`SokoniReceiptDoc` the suite fails loudly rather than the receipt silently losing its code.

## 7. Documented, NOT fixed — the `posSales` divergence

`posSales` is referenced by **ten** backend modules — accounting, BI, HQ, intelligence, CRM,
inventory, integrations, retail-engine, async-job-handlers, ai-assistant — and **nothing in
`pos.js` writes it**. The POS writes `posTransactions`; `functions/pos-zero-friction.js:326`
writes `posRetailSales`. Three collections.

This is almost certainly the mechanism behind the recorded *"POS sales absent from
Orders/Analytics/Revenue"* defect.

**Deliberately not addressed here.** `posTransactions` is canonical for this slice; the
analytics divergence is a separate pre-existing defect and fixing it silently inside a
payment change would hide a significant data-model decision inside an unrelated diff.

## 8. Manual test checklist

- [ ] Cash sale → receipt now shows `Cash`, `Tendered`, `Change`
- [ ] Till sale → reference required; confirm disabled until 10 valid characters
- [ ] Lowercase and spaced input (`qk72 abc 123`) normalises to `QK72ABC123`
- [ ] Receipt prints `M-Pesa Till:` and `Code: QK72ABC123`
- [ ] Same reference on a second sale, same device → refused at the counter
- [ ] Same reference from **two devices offline**, then both sync → one `claimed`, one
      `conflict`; **both sales still exist with correct totals**
- [ ] **Split sale (cash + M-PESA)** → receipt shows TWO tender lines, code on the M-PESA line only
- [ ] Reprint a receipt → payment section identical to the original
- [ ] Sync a Till sale twice → claim is idempotent, no conflict raised
- [ ] STK "M-PESA" button unchanged (still fails on empty `shopSettings` — expected)

## 9. Out of scope — untouched

Daraja / STK Push · `productionAuthorized` · `darajaStoreNumber` · C2B · commission logic ·
the print bridge (`BRIDGE_ENABLED = false`) · the `posSales` analytics divergence.

## 10. Files

| File | Change |
|---|---|
| `pos.html` | Till method button; reference-entry modal |
| `pos.js` | `mpesaTill` controller; method handling; **tender array** on the transaction |
| `sokoni-pos-print-service.js` | `M-Pesa Till` label for the new method |
| `functions/pos-mpesa-refs.js` | **new** — claim, onCall pre-check, sync trigger |
| `functions/index.js` | re-export both functions by name |
| `scripts/test-pos-manual-till-payment.js` | **new** — 57/0 |

**Deployment:** requires a functions deploy (`claimPosMpesaReference`,
`onPosTransactionMpesaRef`) and a hosting deploy. Neither has been done.
