# Product checkout payment gate (webhookIntasend) — owner repair #1

Related: [[Payments]] · [[Checkout]] · docs/CHECKOUT_CONTRACT.md · docs/WEBHOOK_ATTRIBUTION_AUTHORITY.md

**Status:** drafted on `68811e1` (the webhookIntasend production lineage) and reviewed by the
webhook-lineage owner. **Not committed, not deployed.**

## What the gate decides

A payment carrying a server-minted `product_order` intent settles only when all of these hold:

- the intent is **this order's** (`metadata.orderId` and `resourceId` both equal `api_ref`);
- the currency is **KES**;
- the **gross** amount the buyer paid equals the intent's `amountCents` **to the cent**. There is no
  whole-shilling rounding: KES 389.60 does not satisfy KES 390.00.

Anything else parks the payment as `status: 'REVIEW'` with a `reviewReason` **before** the COMPLETE claim,
so no commission, wallet credit, stock move or order finalisation can follow.

The reasons are: `wrong_order`, `wrong_currency`, `amount_mismatch`, `missing_evidence`,
`intent_terminal`, `intent_amount_invalid`, `gate_error` (the intent could not be read), and — from
Unit 4b — `missing_intent`. A replayed
delivery re-evaluates the same way.

## Unit 4 — an intent-less payment may not finalise a marketplace order

The rule on both sides is keyed on the **effect**, never on a label: *would this payment's meta
finalise a marketplace order* (order → paid, stock decremented)? The predicate is
`wouldFinalizeMarketplaceOrder`: `orderId` present, `type` not `booking`, and category not
subscription/wallet_topup/topup. It uses the exact semantics of the webhook's settlement branch.

- **Why not the `category` label.** A label is chosen by the browser.
  - `category:'default'` + `orderId` would dodge a label rule and still finalise the order.
  - The census (2026-09-30, hosting `b108ae3`) found that SokoniPay's gateway labels a **deposit**
    `product.category || 'product'` (the product.js contact-seller fallback) with **no** orderId. A
    label rule would have refused that live flow.
  - `checkout.html` is the only STK caller that sends `orderId`.
- **4a, `initiateSTKPush`.** `functions/stk-intent-enforcement.js` gains `wouldFinalizeMarketplaceOrder`
  (matched `marketplace_order`). Such an STK with no intent is refused before any money moves. Built
  on the live initiateSTKPush source `8afb25d`.
- **4b, `webhookIntasend`.** With no intent, the same predicate on `payments/{ref}.meta` parks the
  payment as `REVIEW(missing_intent)` before the COMPLETE claim.
  - The settlement branch now calls the **same** function (`_isProductPay`), so the refusal cannot
    drift from settlement.
  - The meta decides only *whether* to refuse, never who is paid or how much.
- **Unchanged.** POS, bookings, SokoniPay deposits and every other intent-less payment behave as
  before, until each caller's own migration.
- **Deploy order:**
  1. Unit 1, then Unit 2, then Unit 3 (the checkout that mints intents).
  2. Then 4a.
  3. Then 4b, after in-flight legacy STK payments have drained.
  - A straggler that arrives after 4b is parked, not lost: the money is captured and a reviewer
    re-drives it.
- **Certification:**
  - `scripts/test-product-intent-enforcement-webhook.js` (pure, 29 rows):
    - 15 caller controls;
    - P-7, the shared predicate against the verbatim 68811e1 settlement expression on 350 edge cases.

    The 4b rows fail on the Unit 2 draft.
  - `scripts/test-b1-online-checkout-chain.js` (emulator):
    - C-1a/C-1r/C-2: zero money effects on the parked payments;
    - C-3a..d: SokoniPay, booking, POS and food controls settle COMPLETE.
  - 4a: `test-healthcare-subscription-foundation.js` STK-6e..6h.
  - 4a vs 4b predicate equivalence: 300 cases.

## Why GROSS (`value`), never the webhook's `amount` — measured

Production webhookIntasend logs were read on 2026-09-30, read-only, using key names and amount
relationships only. The first fee-bearing COMPLETE was seen 2026-09-14T01:15:13Z.

- IntaSend's collection body is **flat**: `invoice_id`, `api_ref`, `state`, `value`, `net_amount`,
  `charges`, `currency`, `provider` at the top level, with no `invoice` wrapper.
- On COMPLETE M-PESA payments, **`value − net_amount === charges`** (observed 1.80 and 0.03).
- The webhook's own `amount` variable is `net_amount`. A gate comparing it exactly would refuse
  **every** legitimate payment that carried an IntaSend fee.

## Card and other methods — evidence scope (read before enabling card on product checkout)

- **Sample:** in the 30 days to 2026-09-30 there were **11** collection bodies, **all provider M-PESA**,
  and **every one carried `value` and `currency`**.
- **Card is not on this rail today:** the live online checkout refuses it as unintegrated.
- **Card work exists but is undeployed:** commit `87382dc` ("card becomes a METHOD on the IntaSend
  rail") on the release lines.
- **Before enabling card, or any other IntaSend method, on product checkout:** capture a real card
  confirmation body and verify it carries `value` and `currency` with the same `value − net_amount ===
  charges` relationship. If it does not, every card payment will park as `missing_evidence`.

## Certification

`scripts/test-b1-online-checkout-chain.js` runs the real createPaymentIntent (unit 1), the real webhook
(unit 2) and the real checkout client (unit 3).

- **Result on the repair:** 26/0.
- **Baselines:** the all-live baseline fails the repair rows, including a reproduced misdirected credit
  to a browser-named wallet. The ungated webhook settles short, fractional, foreign, evidence-less and
  unreadable-intent payments.
- **Deliberate breakages:** single-defect mutants are caught, including the gate-error branch (G-1).
