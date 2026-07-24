# Release sequence — callable surface & runtime certification

Companion to `CALLABLE_INVOKER_GAPS.md` (what is unreachable) and
`CALLABLE_INVOKER_REVIEW.md` (who is supposed to call it).

## Why there is a pre-flight AND a post-flight

The callable surface can change from outside the release process. During the
2026-07-24 hardening pass, two `run.invoker` bindings were granted between one sweep
and the next; the sweep total moved 348 → 346 and a written status line was stale
within a few turns. Only re-running caught it.

A point-in-time verdict cannot show that. A **baseline plus a diff** can — so the
audit snapshots itself before the release and compares afterwards.

```bash
npm run release:preflight     # baseline -> .release-preflight.json
#   … deploys, IAM changes, runtime certification …
npm run release:postflight    # diff vs baseline; exits 1 on any PASS -> FAIL
```

`release:postflight` fails **only on a regression** (a function that was reachable
and no longer is). Functions that were fixed during the window are reported, not
failed — that is the expected direction of travel.

## Sequence

### Pre-flight
1. `npm run release:preflight` — establishes the operational baseline **before**
   anything else runs, so later failures can be attributed.
2. Environment verification.
3. Secret verification.

### Runtime certification
4. RC-01 Merchant onboarding.
5. RC-04 Inventory.
6. RC-07 GDPR export — see below.
7. Payment callback / webhook replay.

### Post-flight
8. `npm run release:postflight` — diff against the baseline.
9. Regression summary.
10. Cleanup verification.

## RC-07 — GDPR export, end to end

Infrastructure is done and evidenced: the source binding was corrected and
deployed, and the two `run.invoker` bindings are applied (both probe 401, audit
PASS). What remains is **runtime behaviour**, which requires a real authenticated
session and cannot be produced headlessly.

Confirm each step, not just the endpoints:

1. An authenticated user submits an export request.
2. A `dataExportQueue/{requestId}` document is created.
3. `processDataExport` executes (it triggers on `document.created` for that path).
4. The artifact is generated and written to Storage —
   `data-exports/{uid}/{requestId}.json`.
5. Status transitions through its lifecycle (queued → processing → ready).
6. The user can retrieve, or is notified about, the completed export.

Step 2 is the one that was previously broken and is the highest-value assertion: the
deployed `requestDataExport` used to write only `dataExportRequests`, never the queue
document, so the worker never fired. It is the seam between the synchronous callable
and the asynchronous pipeline — a request can return success while the pipeline never
starts.

### Baseline observed 2026-07-24 (read-only, production)

| Collection | Documents |
|---|---|
| `dataExportRequests` | **0** |
| `dataExportQueue` | **0** |

No export request has ever been recorded in production. Combined with the IAM
blockage (403 until the bindings were applied), that makes RC-07 a **high-priority**
runtime certification, not a formality: the obligation has never been fulfilled
end to end.

### Acceptance criteria

| Stage | Evidence |
|---|---|
| Export request accepted | `dataExportRequests/{requestId}` exists with expected initial state |
| Queue handoff | `dataExportQueue/{requestId}` created ← highest-value |
| Worker execution | queue item processed, status advances |
| Artifact generation | object created at `data-exports/{uid}/{requestId}.json` |
| Completion | status reaches `ready` (or expected terminal state) |
| Cleanup | test artifacts and temporary test data handled per operational process |

**Triggering is a deliberate decision, not an automation step.** The request must
come from an authenticated session that has been explicitly designated for testing.
Do not manufacture production PII-processing activity purely to automate this. The
verification side is already fully observable with the existing tooling — the open
question is whether the live workflow executes, not whether it can be inspected.

## RC — payment → commission → wallet, end to end

One successful **marketplace** payment (not a subscription — see below) is the
acceptance test for the whole integrated path. It produces evidence for eight
assertions at once, which is why it is worth more than testing each subsystem
alone.

Baseline at time of writing: `payments` 3 (all PENDING), `commissionLedger` 0,
`wallets` untouched by any payment. Nothing on this path has ever executed.

### 1 · Observe one successful payment
Confirm COMPLETE **in IntaSend's own dashboard first** — that is upstream of
everything we control, and the flow has never got past it.

### 2 · Capture the correlation chain
Follow one `apiRef` through every record it should touch:

```
apiRef → payments/{apiRef}            status COMPLETE, walletCreditedAt set
       → commissionLedger/{apiRef}    sokoniCut, providerNet
       → wallets/{sellerId}           availableBalance incremented
       → wallets/{sellerId}/transactions/{auto}   direction credit, orderId=apiRef
```

A break in that chain localises the failure immediately; without the chain you
only know "the wallet is wrong".

### 3 · Reconcile
```
gross (payments.amount)
  = commissionLedger.sokoniCut  +  commissionLedger.providerNet
providerNet * 100 == payments.walletCreditCents == the wallet transaction amountCents
```
All three must agree. Gateway fees are **not** modelled, so `providerNet` is net of
commission only — if Finance defines a gateway fee later, this identity changes and
must be re-derived rather than patched.

### 4 · Replay the delivery — the idempotency proof
Re-send the same webhook payload (or await a genuine IntaSend retry). Assert:

- **no second wallet credit** — `availableBalance` unchanged
- **no second ledger entry** under `wallets/{sellerId}/transactions`
- **no second commission** — `commissionLedger/{apiRef}` unchanged
- the duplicate is visible in logs, not silent

This is the assertion that cannot be proven by construction. `_walletTxRef()`
generates a random id, so nothing in FinOS prevents a double credit — the guard is
the `walletCreditedAt` check on `payments/{apiRef}`. Only a real duplicate proves it
holds.

### 5 · Exercise the recovery path
If practical, force a wallet-credit failure (e.g. temporarily deny the wallet
write). Assert the webhook still returns **200**, the payment remains COMPLETE and
authoritative, `walletCreditedAt` is **absent**, and a `commissionReviewQueue` entry
records the failure. That demonstrates a wallet fault cannot corrupt payment state
or trigger an IntaSend retry storm.

### Subscription payments are a different test
A subscription payment flows merchant → platform and is **deliberately excluded**
from wallet crediting: `payData.uid` is the merchant paying us, so crediting them
would refund their own fee. For a subscription, assert the opposite — that
`walletCreditedAt` is **absent** and the log records `wallet credit skipped
(subscription)` — then follow the subscription/entitlement chain instead.

## Loyalty settlement — deployed, NOT runtime-verified

`loyaltyRedemptions` was also empty at the same reading, so the atomic
points-deduction path added on 2026-07-24 has never executed in production: no
completed payment has exercised it. Describe it as **implemented and deployed,
pending runtime verification** — not certified. It should be covered by the
payment/inventory RC path, where a real completed order is the trigger.

## What a green audit does and does not mean

`audit-callable-invokers.js` detects exactly one failure mode — a Cloud Run service
missing `roles/run.invoker`. A clean run means:

> No endpoint in the audited set exhibits this specific IAM misconfiguration.

It does **not** mean the callable surface is correctly configured. It says nothing
about in-function authorization, App Check, Firestore Rules, or business logic.
Those need their own evidence; this gate must not stand in for them.
