# POS paid-state integration for dynamic SOKONI Till QR (Q7)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core). COMMITTED · STACKED.
NOT ON R1 · NOT DEPLOYED.** Production remains `d592d8f`/v632, untouched.
**Date:** 2026-09-03

**Scope:** how a verified `pos_till_sale` payment (Q5 QR authority, Q6 webhook attribution)
reaches a "PAID exactly once" state a POS surface can observe — without inventing a second
payment-completed mechanism, and **without writing into the POS sale-authority collections that
are under active, ratified, gated governance** (found during this trace — see §2, the reason
this slice's actual deliverable is narrower than "write a POS sale record").

---

## 1. Trace — the payment→sale relationship, exactly as it exists today

```
paymentIntents/{ref}   (Q5's pos_till_sale purpose — server-derived amount, Till fields)
        ↓
payments/{ref}          (initiateSTKPush — unmodified, unchanged this slice)
        ↓
webhookIntasend          (verified, Q1's confirmed live endpoint; Q6 fixed WHO gets attributed)
        ↓
   ??? — NOTHING marks a POS sale "PAID" for pos_till_sale today. Traced explicitly:
```

- **`_finalizeMarketplacePayment`** only runs when `_isProductPay` is true, which requires
  `_pm.orderId` to be truthy. `pos_till_sale`'s metadata (Q5) never sets `orderId` — Till sales
  are a free-form cart (`{name, price, qty}`, no `productId`), not a marketplace order. **Confirmed
  unreachable for Till sales** — left untouched, exactly as instructed.
- **The legacy `_isBooking`/booking-creation branch** requires `attribution.type` to be
  `'booking'`/`'service-booking'`. `pos_till_sale`'s metadata never sets `type` to either.
  **Confirmed unreachable for Till sales** — left untouched, exactly as instructed.
- **Wallet credit and `commissionLedger`** already fire unconditionally for any completed
  payment (Q6 fixed the wallet-credit destination to `attribution.merchantUid` for Till sales) —
  money moves correctly, but nothing signals a POS surface that a *specific sale* is done.
- **`paymentIntents/{ref}.status` is never updated to a terminal "paid" state by anything**,
  for *any* purpose, verified by a repo-wide grep (`grep -rn "paymentIntents.*\.update\|
  paymentIntents.*\.set(" functions/*.js`) — the **only** write to a `paymentIntents` status
  field anywhere in the codebase is `booking-payment-sweep.js:199`, which sets `'expired'` on a
  stale service-booking intent. An intent stays `status:'created'` forever, even after the money
  moves. **This is a real, universal, previously-unnoticed gap** — not fixed generically here
  (see §4's scoping decision), but confirmed and logged.

## 2. Is `posCompleteCheckout` the right target? Traced in full — **no.**

`functions/pos-zero-friction.js:250`, read start to finish (~450 lines of its own logic). It is a
**synchronous, cashier-present checkout authority**, not a payment-completion sink:

- Requires `auth.uid` to `resolveActor` against `shopEmployees`/`workspaceMemberships` — a real,
  logged-in cashier with an employment record for this shop.
- Validates the cart against the **canonical `products` collection** (`productId` per line,
  server price lookup, stock check) — `pos_till_sale`'s free-form items have no `productId` at
  all, so they cannot be re-priced this way.
- Its non-cash tender confirmation reads **`posPayments/{ref}`**, written by `darajaSTKPush` and
  moved to `completed` by `darajaSTKCallback` — **Safaricom Daraja's own direct webhook, a
  completely different rail from IntaSend.** `payments/{ref}` (IntaSend, what Q5/Q6 are built on)
  is never read by this function at all.
- Resolves an **open shift** (`posShifts`) and attributes the sale to it — a dynamic-QR sale has
  no cashier terminal "open" at the moment the buyer's phone confirms payment; the cashier who
  generated the QR may not even still be at the till.

**Conclusion, evidenced not assumed:** `posCompleteCheckout` is built for "cashier rings up a
cart, confirms an already-in-hand tender, and the transaction completes synchronously." A dynamic
Till QR sale is the inverse shape — the cart and price are already frozen (`paymentIntents`, Q5)
*before* the QR exists, and confirmation arrives *asynchronously*, minutes later, from a webhook,
with no cashier session necessarily present. **Calling `posCompleteCheckout` from the webhook, or
dropping the payment reference into one of its fields, would be wrong** — it is not the same
authority, and per the explicit instruction, nothing here assumes otherwise.

## 3. The governance finding that reshaped this slice's scope

Traced where a "PAID" POS sale record could legitimately be written and found this, from this
project's own memory (`project_posretailsales_field_divergence.md`) and two committed-in-spirit
(currently untracked in this working tree) design docs, `docs/POS_SALES_LIFECYCLE_AUDIT.md` and
`docs/POS_SETTLEMENT_CONVERGENCE_DESIGN.md`, both read this pass to confirm they are current, not
stale:

- **`posRetailSales` and `posSales` are ALREADY three-way diverged** (TILL/`posCompleteCheckout`,
  MIRROR/`mirrorPosTransactionToRetail`, DISPATCH/`recordPOSSale`) — different owner fields
  (`merchantId`/`sellerId`), different id schemes, one path **not idempotent** (D6, a documented,
  separate defect: a retry duplicates the sale and double-decrements stock).
  `posRetailSales`'s Firestore rule does not even accept the field its sole intended writer
  emits — POS sales are **silently absent from Orders/Analytics/Revenue in production today**.
- The platform owner has **already ratified** a replacement architecture
  (`docs/POS_SETTLEMENT_CONVERGENCE_DESIGN.md`, "ARCHITECTURE RATIFIED 2026-08-27"): a **new**
  single authority, `retailSettlements/{txnId}`, with `posRetailSales`/`posSales` demoted to
  **projections only, never independently authoritative, until parity is demonstrated** — and
  implementation is **explicitly locked** behind a stated trigger phrase ("Build the POS
  settlement implementation candidate") plus unmet dependencies (two named security candidates
  landing first) that this conversation has not received and has no evidence are met.

**Decision: Q7 does not write to `posRetailSales`, `posSales`, or `retailSettlements`.** Writing
a Till sale into `posRetailSales` now would be a **fourth** divergent writer into a collection
whose own ratified fix exists specifically to stop that pattern — the opposite of "end in the
existing POS authority." Building `retailSettlements` is a separate, larger, explicitly-gated
undertaking this instruction did not invoke the trigger phrase for, and preempting it here would
violate a deliberate, recorded governance decision. **This finding is surfaced to the user
directly, not just filed in this document**, because it changes what "POS paid-state
integration" can honestly mean today.

## 4. What Q7 actually delivers: the payment intent's own PAID transition

The one **uncontested**, single-writer, already-rules-protected record every purpose already
funnels through is `paymentIntents/{ref}` itself (`firestore.rules:551` — read-own to
`resource.data.uid`, `create/update/delete: if false` for clients — Cloud-Functions-only,
unchanged). Marking it `status:'paid'` on webhook confirmation is not a new payment-completed
mechanism — it is the **existing, canonical, single record's own terminal state**, simply never
written before now. A cashier terminal that already knows the `ref` (it minted the QR from that
exact intent, Q5's `mintDynamicSokoniQR`) can listen on that one document and know, exactly once,
when the sale is paid — with no second "sale" collection invented.

**Scoped to Till sales only** (`attribution.sokoniTillId` truthy, from Q6's already-resolved
attribution) — not generalised to every purpose. The gap (§1: no purpose ever gets this
transition) is real and universal, but fixing it for subscription/product_order/etc. is a
separate, nameable piece of work with its own review surface (those purposes already have
*other* paid-state signals — `subscriptions/{uid}.status`, `orders/{orderId}.orderStatus` —
so the risk/value shape differs) — logged here as an observation, not bundled into this slice,
matching the same "keep discoveries separate" discipline this session has followed throughout.

```
attribution.sokoniTillId truthy?
  NO  -> no change (every other purpose's existing behaviour is untouched)
  YES -> load paymentIntents/{intentRef}
         intent.status already terminal ('paid'/'expired'/'cancelled')?
           YES -> no-op (idempotent; an expired intent is NOT retroactively marked paid —
                  see "expired/terminal intent" below)
           NO  -> confirmed webhook amount == intent.amount (rounded KES)?
                    NO  -> intent stays 'created' (NOT paid); logged + a
                           commissionReviewQueue entry for manual review — "wrong amount ->
                           sale remains pending", exactly as specified
                    YES -> paymentIntents/{intentRef}.update({ status:'paid', paidAt, paymentRef: apiRef })
```

**Why an already-expired intent is deliberately NOT flipped to 'paid' by a late webhook:** the
underlying money still moves — wallet credit and `commissionLedger` fire regardless (Q6,
unconditional, unchanged) — this transition is purely the *observability* signal for a specific
intent's own lifecycle. Flipping an expired intent to 'paid' after the fact would misrepresent
its own timeline to any future reader; leaving it 'expired' (while the money is still correctly
credited elsewhere) is the more honest record, and is exactly what the certification list asks
for ("expired/terminal intent → no new PAID transition").

**Wrapped in the same never-fail-the-webhook `try/catch` every other fan-out block already
uses** — a failure here never blocks or retries the webhook; the payment and its money-moving
effects (already correct per Q6) stand regardless.

## 5. Confirmed NOT required for Till sales, per the trace — left untouched

- **Inventory deduction** — `pos_till_sale` items carry no `productId` (confirmed, `functions/
  sokoni-qr-authority.js`'s `priceTillSale`); there is no catalogue stock to decrement. Consistent
  with `pos-qr.js`'s own free-form-cart precedent (D3), not a gap Q7 introduces.
- **`_finalizeMarketplacePayment`'s seller-guard** — confirmed unreachable for Till sales (§1);
  not touched, per the explicit instruction to leave it out unless proven required.
- **The dead booking-creation branch** — confirmed unreachable for Till sales (§1); not touched.
- **D4 (commission category/purpose vocabulary mismatch, Q6)** — not touched; `category` is still
  sourced from `payData.meta?.category` exactly as Q6 left it.
- **A buyer-facing `/pay/q/**` page** — not built. Per the instruction, only included if
  explicitly part of Q7, and it was not asked for. The backend payment path (Till issuance →
  dynamic-QR mint → resolution → intent → webhook → attribution → PAID transition) is now
  trustworthy end-to-end; the page is real, separate UI work for a later slice.

---

## 6. Certification — `scripts/test-pos-till-paid-transition.js`

Same pure-core methodology as Q5/Q6 — the state-machine DECISION (given an intent's current
state, the confirmed amount, and the attribution, should it transition to 'paid', stay put, or
flag for review?) is extracted as a pure function, `decidePaidTransition`, into
`functions/payment-attribution.js` (extending the same file Q6 already added, rather than a third
new module for one small, related decision) — no Firestore, directly certifiable.

| requirement | how certified |
|---|---|
| valid verified payment → correct POS sale (intent) becomes PAID | `decidePaidTransition` with a fresh, matching-amount, Till-attributed intent returns `{action:'mark_paid'}`. |
| same webhook replay → no second effect | outer webhook COMPLETE-claim (pre-existing, unmodified) already prevents re-entry; `decidePaidTransition` additionally returns `{action:'noop'}` for an intent already `status:'paid'` — certified directly. |
| wrong intent → wrong sale cannot be marked paid | the intent looked up is always `existing.intentRef` — server-written at `initiateSTKPush` time, never client-suppliable at webhook time; certified by construction (no id parameter Q7's code accepts from the request). |
| wrong merchant/Till → denied | the transition only ever runs when `attribution.sokoniTillId` is truthy — Q6's already-certified Till floor (never client-suppliable) gates this entirely; no new merchant-attribution surface is introduced by this slice. |
| wrong amount → sale remains pending | `decidePaidTransition` with a mismatched `confirmedAmount` vs `intent.amount` returns `{action:'flag_mismatch'}`, never `mark_paid` — certified directly, several magnitudes of mismatch. |
| expired/terminal intent → no new PAID transition | `decidePaidTransition` with `intent.status` in `{expired, cancelled, paid}` returns `{action:'noop'}` regardless of amount match — certified for each terminal status. |
| already-PAID sale → idempotent | covered by the same terminal-status check (`'paid'` is itself terminal) — certified directly, plus a repeated-call test proving two calls with an already-'paid' intent both return `noop`. |
| unrelated payment → no POS mutation | `decidePaidTransition` is a pure function of its own three arguments (`intent`, `confirmedAmount`, `isTillSale`) — no shared state; a second call with a different intent cannot be influenced by an earlier one — certified directly, plus the outer code's own `existing.intentRef` scoping (no cross-reference possible). |

Plus a **negative control** and a **sabotage control**: a weakened copy of `decidePaidTransition`
with the amount-equality check loosened (accepts any confirmed amount) is proven to wrongly mark
a mismatched-amount sale paid — the real function is proven, side by side, to still refuse it.

---

## What this slice does NOT do

Does not write to `posRetailSales`, `posSales`, or `retailSettlements` (§3 — deliberate, not an
oversight). Does not call or modify `posCompleteCheckout`, `darajaSTKPush`, or
`darajaSTKCallback`. Does not touch `_finalizeMarketplacePayment`, the dead booking branch, D4's
commission-category mapping, or `intasendWebhook`. Does not extend the intent-status fix to any
purpose other than `pos_till_sale` (logged as a separate observation, not fixed). Does not build
`/pay/q/**`, a buyer-facing payment page, or any merchant-facing "Till sales" list UI. Not
deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SOKONI_TILL_QR_IMPLEMENTATION.md` (Q5) · `docs/WEBHOOK_ATTRIBUTION_AUTHORITY.md` (Q6,
`attribution.sokoniTillId` — the floor this slice's gate depends on) ·
`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` (D1-D4, all unaffected by this slice) ·
`docs/POS_SALES_LIFECYCLE_AUDIT.md`, `docs/POS_SETTLEMENT_CONVERGENCE_DESIGN.md` (the ratified,
gated POS-sales-authority decision this slice deliberately does not preempt) ·
`functions/pos-zero-friction.js` (`posCompleteCheckout` — read in full, not modified) ·
`functions/payment-attribution.js` (extended with `decidePaidTransition`) ·
`scripts/test-pos-till-paid-transition.js` (certification)
