# Daraja Sandbox — end-to-end STK test

**Purpose:** prove one payment completes the whole SOKONI lifecycle against Safaricom's
sandbox, before anything is attempted on the live Bravilex Till.

Related: [[PAYMENT_MIGRATION_MOR]] · [[MONEY_PATH_VERIFICATION]] · [[GO_LIVE_RUNBOOK]]
Owner: payments · Status: **prepared, not yet run** · Last updated: 2026-08-25

---

## What is being tested

```
SOKONI  →  sendTestSTKPush  →  posPayments (pending)
                                     ↓
                            Daraja SANDBOX (174379)
                                     ↓
                            darajaSTKCallback
                                     ↓
                            posPayments (completed)
                                     ↓
                            verifyPaymentStatus
```

**The Daraja portal simulator alone cannot produce this result.** It mints its own
`CheckoutRequestID`, for which no `posPayments` row exists, so the callback logs
`Unknown checkoutId` and returns. The simulator proves reachability; only a push that
*originates in SOKONI* proves the lifecycle.

## Callback URL

```
https://us-central1-sokoni-aeb26.cloudfunctions.net/darajaSTKCallback
```

Hardcoded at both call sites. There is no hosting rewrite — a `mysokoni.co.ke/...` URL will
not work. Do not create a second endpoint.

## Preconditions

| # | Precondition | Why |
|---|---|---|
| 1 | Sandbox credentials **regenerated** in the Daraja portal | the previous set was exposed in a screenshot |
| 2 | A **real, existing** Firebase account nominated as the test seller | the seed script refuses to create one |
| 3 | `auditLogs(action, sellerUid, createdAt)` index **BUILT**, not merely deployed | `sendTestSTKPush`'s rate-limit query throws `FAILED_PRECONDITION` until it is |
| 4 | `shopSettings/{uid}` seeded with `darajaEnv: "sandbox"` | the code default is `"production"` — omitting it sends sandbox keys to the live API |
| 5 | `DARAJA_SANDBOX_SELLER_UIDS` set to that UID, functions redeployed | without it the callback is rejected and the payment stays pending forever |

## Procedure

```bash
# 1. seed — dry run first; secrets are runtime-only and never printed
DARAJA_SANDBOX_CONSUMER_KEY=… DARAJA_SANDBOX_CONSUMER_SECRET=… \
DARAJA_SANDBOX_PASSKEY=…      SANDBOX_SELLER_UID=<uid> \
node scripts/seed-daraja-sandbox-seller.js
# …review the redacted document, then re-run with --apply

# 2. enrol the UID in functions/.env, then
npm run deploy:functions

# 3. push from SOKONI (signed in as the test seller), amount is fixed at KES 1
#    sendTestSTKPush({ phone: '<Daraja sandbox test MSISDN>' })

# 4. confirm
#    verifyPaymentStatus({ checkoutId }) → status: "completed", mpesaCode present
```

`sendTestSTKPush` enforces **3 pushes per seller per hour**. Plan the run.

## Acceptance — all must hold

| # | Assertion | Where to look |
|---|---|---|
| 1 | `posPayments/{id}` created `pending`, `env: "sandbox"` | Firestore |
| 2 | STK prompt reaches the sandbox MSISDN | handset / simulator |
| 3 | `stk_callback_sandbox_accepted` audited | `auditLogs` |
| 4 | `posPayments/{id}` → `completed` with an `mpesaCode` | Firestore |
| 5 | `verifyPaymentStatus` returns `completed` | callable |
| 6 | `sellerPayments/{id}` carries `isTest: true` | Firestore |
| 7 | **No** `commissionLedger` entry for it | Firestore |
| 8 | **No** invoice / receipt / journal / tax record | financial-engine collections |
| 9 | A replayed identical callback changes nothing | re-post, then re-read row |

Rows 6–8 are the point of the F2 containment. If any of them fails, sandbox money has entered
production financial reporting and the run must be treated as a defect, not a pass.

## Constraints during the run

* **Never pass an `orderId`.** `sendTestSTKPush` does not, and the callback's order/inventory
  transaction is *not* sandbox-guarded — a sandbox payment carrying an `orderId` would
  decrement **real stock**.
* Never substitute the live Bravilex Till for `174379`.
* Never set `phone` / `ownerPhone` on the seeded document — `sendTestSTKPush` refuses any
  number that does not match a stored seller phone, which would block the sandbox MSISDN.

## Teardown — mandatory

```bash
SANDBOX_SELLER_UID=<uid> node scripts/seed-daraja-sandbox-seller.js --revoke --apply
# then clear DARAJA_SANDBOX_SELLER_UIDS in functions/.env and redeploy
```

Either step alone closes the lane. Do both: the seeded document holds live sandbox
credentials, and a stale allowlist entry leaves a lane open for a seller who no longer
expects one.

## Not in scope

**STK Query** (`/mpesa/stkpushquery/v1/query`) is not implemented anywhere in the repo.
Verification is callback-driven only, so a dropped callback leaves a payment `pending` with no
reconciliation poll. That is a real resilience gap and is deliberately deferred until the basic
flow is proven. It must be closed before production traffic — see [[PAYMENT_MIGRATION_MOR]]
gate 7½.
