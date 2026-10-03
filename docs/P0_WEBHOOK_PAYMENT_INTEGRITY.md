# P0 — Webhook Payment Integrity (KES 1 → KES 10,000)

**Date:** 2026-10-03 · **Owner lane:** sokoni-5b (Gates 5, 9, 10 of `INTASEND_CONVERGENCE_BRIEF.md`)
**Branch:** `fix/webhook-payment-integrity-on-f076c64` (tree `C:/temp/sok-p0wh`) · **Base:** `f076c64` = the live
containment floor `68811e1` + owner repair #1 (`b026856`, `f076c64`)
**Status:** BUILT, NOT DEPLOYED. Live hole CONFIRMED (sokoni-e3, read-only `status.traffic` 2026-10-03:
`webhookintasend` = 100 % `00068-del` = `68811e1`, which has no gate).

Related: [[Payments]] · [[Orders]] · [[IntaSend]] · `docs/WEBHOOK_ATTRIBUTION_AUTHORITY.md`

## The defect (live)

`initiateSTKPush` accepts an intent-less, browser-chosen amount with `meta.orderId`. On `COMPLETE`, `webhookIntasend` →
`_finalizeMarketplacePayment` writes `status:'paid', paymentVerified:true` onto that existing order. It never compares the
amount to the order and never checks who paid. So a buyer pays KES 1 against their own KES 10,000 order, and the seller
sees "paid, verified".

## The chain now required before an order becomes paid

| # | Invariant | Where | Refusal |
|---|---|---|---|
| 1 | a server payment record (product_order intent) exists | `assessProductOrderPayment` | `missing_intent` |
| 2 | bound to THIS order (`metadata.orderId == resourceId == api_ref`) | same | `wrong_order` |
| 3 | not already consumed / closed (any terminal intent, `paid` included) | same | `intent_consumed` / `intent_terminal` |
| 4 | payer (`payments/{ref}.uid`, from `request.auth`) == intent owner | same | `wrong_buyer` / `intent_owner_missing` |
| 5 | an existing order's buyer (`buyerUid`/`uid`/`buyerId`) == intent owner | same | `wrong_buyer` |
| 6 | the order is still payable (`pending_payment` / `pending` / `awaiting_payment` / not yet written) | same | `order_not_payable` |
| 7 | currency KES on callback, intent and order | same | `wrong_currency` / `missing_evidence` |
| 8 | callback GROSS == intent `amountCents`, to the cent; no fallback when absent | same | `amount_mismatch` / `missing_evidence` |
| 9 | IntaSend itself, asked server-to-server, says COMPLETE for this ref in KES at the same gross | `assessProviderConfirmation` + `shared/intasend-status.js` | `provider_*` |
| 10 | replay of a settled payment is a no-op (`payments/{ref}` COMPLETE → 200) | existing claim | — |

Every refusal parks `payments/{ref}` as **REVIEW** BEFORE the COMPLETE claim. So no commission, wallet credit, stock
move or order finalisation can follow. The money is captured, and a reviewer re-drives it.

**Payable amount:** no server-written payable field exists on `orders/{id}` (the client writes `total`). The server's
payable amount is the intent's `amountCents`, priced from the catalogue by `createPaymentIntent` (`validateOrderLines`).

## Evidence

| Layer | What | Result |
|---|---|---|
| A | `scripts/test-p0-payment-integrity.js`: 29 named gate rows (A-01…A-28, A-13b) + 4 wiring rows (W-01…W-04) | **33 PASS, 0 FAIL** |
| B | the same file, real `webhookIntasend` in-process (in-memory Firestore, stub IntaSend), rows B-01…B-10 incl. **B-01 THE ATTACK** | **UNPROVEN**: harness refuses below 512 MB (302 MB at the run) |
| C | `scripts/test-b1-online-checkout-chain.js` on the Firestore emulator | **NOT RUN** (memory) |
| — | sabotage `scripts/sabotage-p0-payment-integrity.js` | **13/13 CAUGHT** by named rows |
| — | `test-product-intent-enforcement-webhook.js` | 29/0 (fixture now carries the real intent owner and payer) |
| — | `test-notify-booking-types.js` | 15/60 fail, **identical failure set at base f076c64** (pre-existing, not this change) |
| — | negative control on live `68811e1` | the gate module has no `assessProductOrderPayment`, so rows fail / crash. **UNPROVEN as behaviour** until Layer B/C runs `WH_ROOT=<68811e1>` |

## ⚠ Deploy-order dependency (owner decision required)

The **live checkout (hosting `72dca56`) does not create a product_order intent**. It calls `initiateSTKPush` with the
browser `orderTotal` and `meta.orderId`. The intent-creating checkout (repair #1 Unit 3, `3eb22ce` on
`fix/b1-checkout-intent-on-18e3711`) and the `product_order` pricer in `createPaymentIntent` (`b5d0541`) are **not live**.

Therefore, once this gate (or bare `f076c64`) is live, **every genuine online M-Pesa checkout parks as REVIEW**
(`missing_intent`) until both of those ship. The attack is closed at once; legitimate orders need manual re-drive in the
meantime. Alternative order: `createPaymentIntent` → checkout Unit 3 (rebased on live) → this webhook. That keeps
checkout automatic, but the attack stays open for two more releases.

## Deployment (when authorised; NOT before)

Preconditions:
- **guard route A or B authorised** by the owner;
- **≥ 512 MB free**;
- `gcloud` status.traffic re-read;
- secret `INTASEND_PRIVATE_KEY` confirmed present (it is already bound to `initiateSTKPush`; this release binds it to
  `webhookIntasend` too).

```
git status --short ; git diff ; git diff --cached ; git rev-parse HEAD ; git show --stat <release commit>
firebase deploy --only functions:webhookIntasend      # exactly this one function; .env present for the CLI, excluded from the artifact
```

Then:
1. verify status.traffic is 100 % on the new revision and the revision is Ready;
2. live smoke on both sides:
   - VALID: KES N order + KES N verified payment → paid;
   - ATTACK: KES N order + KES 1 → REVIEW, not paid, no seller settlement;
   - cross-order and cross-buyer attempts stay unpaid.

**Not "fixed" until** the deployed revision is verified and the ATTACK path is proven closed live.

## Not in this release

- `initiateSTKPush` still accepts intent-less product STKs (Unit 4a); the webhook parks them instead.
- `intasendWebhook` (the second webhook) — Gate 9 census pending.
- Gateway `/orders` server economics — Gate 11, sokoni-e3.

## Changelog (this lineage carries no CHANGELOG.md — functions-only recovery tree)

- **2026-10-03:** gate extended from repair #1:
  - added buyer binding, order-still-payable, single use, order currency, and IntaSend server-to-server confirmation;
  - `webhookIntasend` now binds `INTASEND_PRIVATE_KEY`;
  - `shared/intasend-status.js` ported byte-identical from `349bf9d` (sha256 `cfa7acb21abacc58`).
- **Files:** `functions/payment-attribution.js`, `functions/index.js`, `functions/shared/intasend-status.js`, `scripts/test-p0-payment-integrity.js`, `scripts/lib/p0-webhook-{harness,rows}.js`, `scripts/sabotage-p0-payment-integrity.js`, `scripts/test-product-intent-enforcement-webhook.js` (fixture: real intent owner + payer).
- **Database:** no schema change; new REVIEW reasons on `payments/{ref}.reviewReason`.
- **Breaking:** online checkouts without a product_order intent park REVIEW (see the deploy-order dependency above).

## Route B — Daraja removal ported (owner 2026-10-03), a SEPARATE change from the payment repair

- **What was ported:** 093fd4f (sokoni-b2, hosting lineage) does not cherry-pick onto this lineage (conflicts in index.js, pos-zero-friction.js and 7 files absent here). So its exact declaration set was removed BY NAME, on this lineage's own boundaries:
  - helpers: `DARAJA_UTC_OFFSET_MS`, `_darajaTimestamp`, `_normalizeMsisdn`, `_darajaToken`;
  - exports: `darajaSTKPush`, `darajaSTKCallback`, `validateDarajaCredentials`, `sendTestSTKPush`, `webhookMpesa`, `mpesaC2BValidation`, `mpesaC2BConfirmation`;
  - constants: `SAFARICOM_CALLBACK_IPS`, `_DARAJA_SANDBOX_SELLER_UIDS`, `_DARAJA_IPS`, and the `./mpesa-c2b` require;
  - `functions/mpesa-c2b.js` deleted.
- **Result:** exactly those 7 exports gone, 0 added (1,073 lines). Kept and verified present: `webhookIntasend`, `initiateSTKPush`, `verifyPaymentStatus`, `_finalizeMarketplacePayment`.
- **Guard:** `scripts/deploy/guard-functions-safety.js` byte-identical to 093fd4f (sha256 `5d1b4b295479bba1`). It **PASSES in full mode, no exemption**.
- **AST:** `scripts/check-daraja-removed-names.js` (@babel/parser) finds 0 undeclared references to removed names and 0 `require("./mpesa-c2b")` across 402 modules. Positive controls: the pre-port tree reports the require; a planted `_darajaToken` / `SAFARICOM_CALLBACK_IPS` reference is reported by name and line.
- **Regressions:** P0 suite 33/0 (+10 UNPROVEN), intent suite 29/0. The notification suite's 15 failures are byte-identical to base f076c64 (pre-existing).
- **Live:** the 7 exports were already deleted live by sokoni-b2 on 2026-10-03. A scoped `--only functions:webhookIntasend` deploy neither recreates nor deletes them.

## ⚠ Deploy-config finding (decision at deploy time)

This lineage's `firebase.json` hooks name four gate scripts that **do not exist in the lineage**: `predeploy-syntax-gate`, `verify-commission-single-source`, `verify-delivery-engine-sync`, `predeploy-payout-gate`. They are also in the quoted form that never executes, so this was never noticed. The canonical copies from the main checkout don't fit this tree: two crash on missing companions, and the payout gate "skips (infra)" with exit 0, which fails open. `functions.ignore` is `[]`, so `.env` would be packaged.

**Proposed scratch deploy config** (owner to approve at deploy time): relative fail-closed hooks:
- `node scripts/deploy/guard-functions-safety.js`
- `node scripts/check-daraja-removed-names.js`
- `node scripts/test-product-intent-enforcement-webhook.js`
- `node scripts/test-p0-payment-integrity.js`. Exit 3 (UNPROVEN rows) must be treated as a block until Layer B runs at ≥ 512 MB.

`functions.ignore` adds `.env` and `.env.*`, and `.env` stays present for the CLI.
