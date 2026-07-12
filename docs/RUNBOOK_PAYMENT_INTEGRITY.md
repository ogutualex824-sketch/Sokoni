# Runbook — Payment Integrity (P0-7)

**Incident:** Checkout fabricated payment confirmations and marked unpaid orders `paid`.
**Hotfix deployed:** 2026-07-13 (`d7a7ac7`, `af2d632` — hosting only)
**Related:** [[Financial Transaction Standard]] · [[Settlement Engine]] · [[Orders]]

---

## Status

| | |
| --- | --- |
| Bleeding stopped? | ✅ Yes — hotfix live. No new order can be marked `paid` without provider proof. |
| Historical damage assessed? | ❌ **No.** Not started. |
| Historical data modified? | ❌ **No — and it must not be, automatically.** |

---

## 1. Assess the damage (do this first)

```bash
node scripts/audit-payment-integrity.js --csv payment-audit.csv
```

**Read-only.** It writes nothing to Firestore. It lists every order with `status: "paid"`
that carries no provider evidence, ranked by what the platform has already lost:

| Risk | Meaning |
| --- | --- |
| **CRITICAL** | Goods shipped, and payment was *impossible* (no backend exists for that method). Real loss, already incurred. |
| **HIGH** | Marked paid, payment impossible, not yet shipped. **Stop the fulfilment now** — this is still preventable. |
| **MEDIUM** | Shipped on PayPal/bank. May well be genuine — verify the money landed. |
| **LOW** | Awaiting manual verification. Normal for those rails. |

Work **HIGH before CRITICAL** if any HIGH order is about to ship. CRITICAL is a loss you
have already taken; HIGH is one you can still stop.

---

## 2. Reconcile — by hand, per order

For each row, check the payment against the **provider's own records** — IntaSend dashboard,
M-Pesa statement, bank statement. Not our database: our database is the thing that lied.

**Do NOT bulk-update.** Some bank-transfer and PayPal orders were almost certainly paid and
settled by hand — the old code marked them `paid` for the wrong reason, but the customer
still paid. A blanket reversal would rob a paying customer, and you would not be able to tell
which ones afterwards.

Three outcomes per order:

1. **Money found at the provider** → legitimate. Leave `paid`. Backfill `paymentVerified: true`
   and the provider reference so it never resurfaces in this audit.
2. **No money, not yet shipped** → set `pending_payment`. Contact the customer to pay.
3. **No money, already shipped** → this is a loss. Decide commercially: pursue the customer,
   or absorb it. **Whatever you decide, the seller must be made whole** — they shipped real
   stock in good faith against a confirmation *we* fabricated. That is our error, not theirs.

---

## 3. Correct the downstream ledger

Settlement, commission, payout and escrow all read order status. If any unbacked order was
counted, those figures are overstated.

- Re-run settlement reconciliation for the affected window.
- Escrow: unbacked orders had `escrow.held = <total>` for money that never arrived.
- **Any revenue/GMV figure predating 2026-07-13 is unsafe** until this completes. Do not
  report it externally, and do not use it as a launch metric.

---

## 4. Verify the fix holds

```bash
node scripts/test-payment-integrity.js     # 15 checks, CI-blocking, takes no payment
```

Then, on a real device against production:

| Check | Expected |
| --- | --- |
| Pay with M-Pesa | STK arrives. Order becomes `paid` **only after** server verification. |
| Select Airtel / T-Kash / Equity / MTN / EcoCash / Chipper | Dimmed, "Coming soon". Cannot be selected. **No order created.** |
| Pay by card with the IntaSend script **blocked** (DevTools → block request) | *"Card payment unavailable… your card has NOT been charged and no order was placed."* **No order created.** ← this is the exact path that used to hand out free goods |
| Bank transfer | Order is `pending_payment`. Customer is told it will not be dispatched until verified. |

---

## 5. Prevent recurrence

`scripts/test-payment-integrity.js` is now a CI gate. It fails the build if any code:

- confirms a payment on a timer
- creates an order from a fallback
- hardcodes `status: "paid"`
- offers a payment method with no backend
- shows the customer a success message outside a server-verified branch

> **A simulation path in payment code is a live weapon, not a dev convenience.**
> If it cannot take money, it must say so and stop.

---

## Escalation

Financial exposure or a shipped-but-unpaid order → **founder, immediately**. Do not sit on it.
