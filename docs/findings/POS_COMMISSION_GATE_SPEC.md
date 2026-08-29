# POS commission morning gate — specification

**Specification only. No code, config, rules, IAM or deploy changes. Nothing deployed.**
2026-08-28 · traced against `ledger`, `createLedgerEntry`, `reverseLedgerEntry`, IntaSend
verification, wallet and the merchant-v2 entry path

---

## ⚠ THE PREREQUISITE — there is currently no outstanding-obligation state

`finos-utils.js:102` — `createLedgerEntry` **hardcodes**:

```js
status:    'settled',
settledAt: FieldValue.serverTimestamp(),
```

There is no parameter to write an entry as outstanding. So every `pos_commission_receivable` is
recorded **already settled**, with a settlement timestamp, even though the seller holds the cash and
owes the money. The live row proves it:

```
type pos_commission_receivable · amountCents 10500 · status settled · settledAt set
collectionRoute CASH_IN_DRAWER · createdBy posCompleteCheckout
```

The type says *receivable*; the lifecycle says *paid*.

**Consequence:** the morning gate has nothing to aggregate. Every row already reads settled, so
outstanding commission would compute to **zero for every merchant** — a seventh unreachable
authority, arriving on day one.

**This must be fixed first.** `createLedgerEntry` needs to accept a settlement state
(`status: 'outstanding'`, no `settledAt`) and `posCompleteCheckout` must use it. Small, surgical, and
it is the difference between a gate that works and one that silently passes everybody.

`ledger` has no other outstanding concept — the only `status:'open'` in `finos-utils.js` is
`fraudAlerts:755`, unrelated.

---

## The obligation model — aggregate recorded economics, never recompute

```
completed POS sale
   └─ posCompleteCheckout → createLedgerEntry
        type            pos_commission_receivable
        amountCents     the commission RECORDED AT SALE TIME
        status          outstanding            ← the prerequisite above
        idempotencyKey  poscomm_<sale key>     ← already derived from the sale
        metadata        { collectionRoute, commissionPct }

daily obligation = Σ amountCents WHERE sellerId = merchant
                                   AND type = pos_commission_receivable
                                   AND status = outstanding
```

**Non-negotiable, per instruction:** the morning figure is the **sum of recorded obligations**. It is
never produced by rescanning sales and recomputing commission. A recomputed figure would disagree
with the ledger the moment a rate changes or a sale is returned — the exact class of drift these
audits keep finding.

The idempotency key already exists (`poscomm_` + the sale's own key), so a retried posting cannot
double-book, and the obligation cannot be inflated by replay.

---

## Settlement state machine

```
OUTSTANDING ──payment initiated──► AWAITING_VERIFICATION ──verified──► SETTLED ──► POS UNLOCKED
     ▲                                      │
     └──────────failed / expired────────────┘        (remains OUTSTANDING, POS stays locked)
```

**STK/IntaSend success is not settlement.** Verification is the IntaSend webhook authenticated by its
`challenge` secret (`index.js:6671-6688`), matched to the payment reference. `7d115bc` already encodes
the discipline to reuse: settle **by `paymentRef`**, return `no_payment_ref` when absent and
`already_settled` on redelivery — its comment records the earlier bug where *"a redelivery of the SAME
payment settled a second time"*.

Settlement marks the specific ledger rows it paid — by id, from the recorded amounts — and stamps
`settledAt`. It does not clear "the balance".

## Lock semantics — merchant-specific, POS only

| outstanding | POS |
|---|---|
| KES 0 | opens normally |
| KES 500 | locked until fully cleared |
| initiated, unverified | **locked** |
| failed / expired | locked, with the reason shown |
| partial | locked — strict model; remaining obligation stands |

**The marketplace is unaffected.** Order intake, fulfilment, dispatch, marketplace commission, rider
economics, seller wallet credit and withdrawals continue while POS is locked. The gate is scoped to
the POS surface for one merchant.

**Entry point:** no restriction check exists on the merchant entry path today —
`sokoni-merchant-routes.js` and `merchant-v2.html` contain none. `7d115bc` provides
`getSellerRestriction` as the shape to reuse.

**Failure must be legible.** A locked merchant sees *why* — amount, contributing sales, and the
failure reason — never a silent lock.

## Returns interact correctly, for free

A returned POS sale reverses through `reverseLedgerEntry` (`finos-utils.js:122`), which reuses
`orig.amountCents` and never recomputes. Because the obligation is the **sum of outstanding recorded
rows**, a reversal removes that row's contribution automatically. No separate obligation-recalculation
path is needed — provided the obligation is never recomputed from sales.

This only works if `reverseLedgerEntry` is wired up; it currently has **no caller**.

---

## Amendment surface

| change | file |
|---|---|
| accept a settlement state (**the prerequisite**) | `functions/finos-utils.js:95-110` |
| write POS commission as `outstanding` | `functions/pos-zero-friction.js:201` |
| obligation aggregation + settlement by `paymentRef` | new, modelled on `7d115bc` |
| verification bound to the IntaSend challenge webhook | `functions/index.js:6671` |
| restriction read on merchant entry | `sokoni-merchant-routes.js` / `merchant-v2.html` |
| wire the reversal | a caller for `reverseLedgerEntry` |

**Untouched:** `merchant-authority.js` and the deployed POS authority guards · served ruleset
`59af870d` · `wallet.js` (POS commission never touches the wallet — the seller holds the cash) ·
`commissionLedger` · the six orphan rows.

**Note:** POS commission does **not** move through the seller wallet. The seller already holds the
cash; the obligation is a receivable settled by a separate inbound payment. That keeps the frozen
wallet backend out of this work entirely.

## Certification gates

1. **Outstanding-state gate** — a completed POS sale writes `status: outstanding` with **no**
   `settledAt`. Sabotage: revert to hardcoded `settled` and the gate must fail.
2. **Obligation provenance** — the morning figure equals the sum of recorded rows, asserted by
   comparing against the ledger, not a recomputation.
3. **Verification gate** — an STK/initiation response alone never settles; only the authenticated
   webhook does. Negative control: simulate initiation without a webhook, obligation must stay
   outstanding and POS locked.
4. **Replay** — the same payment reference settles once (`already_settled`).
5. **Reversal** — a returned sale removes its contribution via `reverseLedgerEntry`, no
   recomputation.
6. **Isolation** — marketplace order intake, dispatch and withdrawal all succeed while POS is locked.
7. **Live trace** — a real POS sale accrues, appears in the morning figure, is paid, is verified, and
   unlocks POS, observed in live documents.

Gate 1 is the one that decides whether this becomes the seventh unreachable authority.
