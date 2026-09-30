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
`intent_terminal`, `intent_amount_invalid`, and `gate_error` (the intent could not be read). A replayed
delivery re-evaluates the same way.

Payments **without** a `product_order` intent are unchanged. Refusing those is a later step ("Unit 4"),
safe only once the checkout that mints intents is live.

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
