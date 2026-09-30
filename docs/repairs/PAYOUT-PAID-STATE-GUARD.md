# Payout paid-state guard — a final payout never pays twice

**Status:** built on the POS lineage (base `8183694`) 2026-09-29. **Not deployed.**
**Base:** ports `61098e9` (creator-hub, 2026-09-26, "an ambiguous B2C outcome is never re-sent"), then extends it.
**Related:** [[PAYOUT_OUTCOME_UNKNOWN]] · [[FINANCIAL_CORE_ARCHITECTURE]] · [[FC-1A-SFOS-INVOKER-CONTAINMENT]] · [[SECURITY]]

## The invariant

> A payout that is terminal, or that a gateway payment may already have paid, must not produce another financial
> settlement or refund effect. Manual **Mark Paid is allowed from `approved` only**.

## Census (2026-09-29, deployed code on the emulator)

Production serves one `wallet.js` (blob `5b558d43`) in all six payout functions. There is one settlement function,
`_settlePayoutPaid`, and it refused only `paid` / `settled_manually`.

| Measured on the deployed code | Result |
|---|---|
| rejected → Mark Paid | accepted: balance 1,000 kept (the refund stays), **reserved −100**, payout ledger row → seller paid twice |
| failed → Mark Paid | same |
| pending / approving / retry_scheduled → Mark Paid | accepted — approval bypassed / a gateway payment possibly in flight |
| processing → Mark Paid, then gateway COMPLETED | the webhook is swallowed as "already settled" — **two real payouts, one on the books** |
| paid → Mark Paid (late) | reported `settled_manually`, record stays `paid` |
| rejected → REVERSED webhook | **balance 1,100, reserved −100** — credited twice |

`approved` is the only state in which no gateway payment was ever sent (approval leaves a payout `approved` only when
automatic payout is off or the method is not M-PESA). Production held 7 payouts (4 paid, 2 failed, 1 rejected), 0 open.

## What changed (all in `functions/wallet.js`)

**From `61098e9`, ported unchanged:**
- `_settlePayoutPaid` refuses `rejected` / `failed` / `reversed`;
- `_refundPayout` treats `settled_manually` / `reversed` as terminal;
- the `outcome_unknown` state for an ambiguous B2C result, with retries that never re-send;
- `adminResolvePayoutOutcome` (Super Admin, provider evidence, exactly-once);
- the late-call response reports the real status (`alreadySettled`).

It also brings `admin-os.js`, `reconcile-payouts.js`, `scripts/test-payout-outcome-unknown.js`, its helper
`scripts/lib/fake-firestore-txn.js`, `docs/PAYOUT_OUTCOME_UNKNOWN.md` and `docs/PAYOUT_SANDBOX_VERIFICATION.md`.
**Not ported:** its AdminOS / provider-dashboard UI (the live AdminOS payout queue landed separately in `4259b92`).

**Extensions (owner decisions 2026-09-29):**
- **Mark Paid is approved-only**, enforced inside the settlement transaction (`requireStatus: 'approved'`). Every other
  source is refused with its reason: pending (not approved), approving / processing / retry_scheduled (a gateway payment
  was or is being sent), rejected / failed / reversed (funds already returned), outcome_unknown (provider evidence).
- **`_reversePayout` has a terminal guard.** Only `paid`, `processing`, `approving`, `retry_scheduled` and
  `outcome_unknown` can be reversed. Everything else is refused with no money effect, and the refusal is recorded in the
  payout history (`reversal_refused`).

## What is fixed where — the truthful production claim

| Path | After an `adminProcessPayout` deploy |
|---|---|
| **Admin Mark Paid** (approved only, terminal refusal, honest late response) | **fixed** |
| **Webhook settlement / reversal** (`webhookIntasend`, `intasendWebhook`) | **NOT fixed** — both still serve the old `wallet.js` until they are deployed under their own gate (`intasendWebhook` has P0-4) |

## Deployment (NOT authorized by this implementation)

Maximum scope: `--only functions:adminProcessPayout`. Method (precedent `961e66a`): patch the function's OWN serving
archive (`adminProcessPayout`, generation `1787384900712538`, revision `adminprocesspayout-00023-xos`) by replacing
`wallet.js` with this commit's file — the archive's other files, including `index.js`, stay as served.

Gates before any deploy command:
1. KEEP protection re-verified live (CLAUDE.md Artifact Registry notice).
2. The serving archive re-checked against the recorded generation, and its `wallet.js` against blob `5b558d43`.
3. `--only functions:adminProcessPayout` — never broader: the same archive contains `sfosMerchantSettle` /
   `sfosTransact` (FC-1A: a deploy of either re-grants public invocation).

Not deployed with it: `adminResolvePayoutOutcome` (new; exported here, dormant while automatic payout is off),
`requestSellerPayout` (the key-binding fix `4770c5c` stays out of this unit), the webhooks.
