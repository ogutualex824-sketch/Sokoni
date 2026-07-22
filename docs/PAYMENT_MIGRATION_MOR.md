# Payment Migration — Merchant-of-Record Collection

**Deprecation plan for per-merchant Daraja collection.** Every stage below has an
exit criterion that can be *executed*, not judged. "Pending" is a state, not a
criterion — a stage is only complete when its check returns the stated result.

Related: [[PRODUCTION_RECOVERY_REGISTER]] · [[SETTLEMENT_MIGRATION_PHASE2]]
Owner: payments · Last verified: 2026-07-22

---

## Why this migration exists

Two halves of the platform disagreed about where customer money lands:

| Component | Assumes |
|---|---|
| `settlement-engine.js:7,173` | *"100% of every customer payment is collected into the Bravilex account first"* |
| `darajaSTKPush` (`index.js`) | `BusinessShortCode`/`PartyB` = `shopSettings/{sellerUid}.darajaShortCode` — the **seller's** shortcode |

Under the second model the seller receives 100% while the ledger records a
platform commission that was never collected: commission booked as revenue,
settlement liabilities with no cash behind them, and reconciliation that cannot
tie out against M-Pesa.

**This was technical debt, not an active loss.** The audit below found the
per-merchant path had never been configured or used, so no money was
mis-collected — a materially different situation from an in-flight migration.

---

## Stage gate

| # | Stage | Exit criterion (executable) | Status |
|---|---|---|---|
| 1 | Collection route explicit | Every new `posPayments` row carries `collectionRoute`; `resolveCollectionRoute()` defaults `DIRECT_TO_SELLER` and refuses `CENTRAL_MOR` without a shortcode | ✅ `9d72055` (9/9 tests) |
| 2 | Manual/QR reconciliation exists | `mpesaC2BValidation` + `mpesaC2BConfirmation` deployed; replay of one `TransID` applies once | ✅ `dbb09af` (15/15 tests) |
| 3 | No merchants configured | `shopSettings` document count **= 0** | ✅ verified 2026-07-22 |
| 4 | Client credential collection retired | No client read/write of `darajaConsumerSecret`/`darajaPassKey` outside comments | ✅ `5ee7e3a` |
| 5 | Central Paybill provisioned | `settlementConfig/paymentAccounts.centralPaybill` matches `^\d{5,7}$` | ⏳ pending |
| 6 | Central credentials deployed | Secret Manager holds the central Daraja consumer key / secret / passkey, bound to the STK function | ⏳ pending |
| 7 | Regulatory + commercial clearance | Written confirmation from Safaricom onboarding **and** counsel that Bravilex may collect and remit third-party merchant funds | ⏳ **operational gate, not engineering** |
| 7½ | Production acceptance | all 9 rows of the end-to-end checklist below pass on **one real payment**, including the deliberate callback replay | ⏳ gates live traffic |
| 8 | Central pilot successful | ≥1 payment with `collectionRoute = CENTRAL_MOR` reaches `status = paid`, settles, and reconciles against the M-Pesa statement | ⏳ pending |
| 9 | Legacy STK path disabled | `darajaSTKPush` refuses every caller; no new `posPayments` row has `collectionRoute = DIRECT_TO_SELLER` | ⏳ after stage 8 |
| 10 | Legacy code removed | Repo-wide `daraja*` references = 0 outside `docs/` | ⏳ after production stabilisation |

Stages 5–7 are **prerequisites, not engineering work**. Nothing in the codebase
blocks them, and no code change can satisfy them.

---

## Gate 7½ — Production acceptance (before any live traffic)

Run **once, end to end, on a single real low-value payment** (KES 10 or similar)
after stages 5–7 and before the stage 8 pilot opens.

This is deliberately not another engineering stage. Its purpose is to prove the
*lifecycle*, not the parts: every component below already has unit coverage, and
passing them individually is exactly the evidence that would let a broken
end-to-end flow through. One payment must traverse all nine rows.

| # | Check | Proven by |
|---|---|---|
| 1 | Secret Manager credentials resolve | the STK function obtains a Safaricom OAuth token — no `Daraja auth failed` |
| 2 | STK Push succeeds on central credentials | response carries a `CheckoutRequestID`, and the request's `BusinessShortCode` == `settlementConfig/paymentAccounts.centralPaybill` (not a seller shortcode) |
| 3 | Callback received and authenticated | `darajaSTKCallback` / `mpesaC2BConfirmation` fires; if `c2bToken` is configured it matched |
| 4 | Intent reaches PAID **exactly once** | intent `status = paid`; then **re-deliver the same callback** and confirm no second transition and no second credit |
| 5 | Ledger entry balances | the `computeSettlement` `ledgerPlan` for this payment sums to zero (debits == credits) |
| 6 | Receipt generated | a receipt exists carrying the M-Pesa receipt number |
| 7 | Settlement queue entry created | a settlement record exists for the seller, with commission deducted |
| 8 | Merchant wallet reflects expected amount | wallet delta == gross − commission (− WHT where applicable) |
| 9 | Reconciliation shows zero variance | the M-Pesa statement line for this `TransID` equals the ledger's recorded gross |

**Row 4 is the one that matters most.** Duplicate delivery is the normal failure
mode of every payment webhook — Safaricom retries until acknowledged — so the
replay must be performed deliberately, not assumed from the unit tests.

**Row 9 requires an operational artifact**, not a query: the actual M-Pesa
statement. If it cannot be obtained for the pilot transaction, this gate is NOT
passed — a ledger that only agrees with itself is the exact failure this whole
migration exists to prevent.

Record the `TransID`, the intent `ref` and the settlement id alongside the result,
so the pilot has a citable baseline to compare later transactions against.

---

## Verification commands

Each is read-only. Stage 3 in particular should be **re-run immediately before
stage 9 or 10** — the whole plan rests on it staying zero.

```bash
# Stage 3 — no merchant has credentials (must print an EMPTY shopSettings result)
#   listCollectionIds is authoritative: a collection only appears if it holds >=1 doc.
#   Confirm the read path works first (positive control), or an outage looks like a pass.

# Stage 4 — no client handling of secrets (expect: comments only)
grep -nE "darajaConsumerSecret|darajaPassKey" payments.html pos.js seller.html

# Stage 5 — central Paybill provisioned
#   settlementConfig/paymentAccounts.centralPaybill  =~ ^[0-9]{5,7}$

# Stage 9 — legacy path no longer used
#   posPayments where collectionRoute == 'DIRECT_TO_SELLER' AND createdAt > <cutover>  => 0

# Stage 10 — legacy code gone
grep -rn "daraja" --include=*.js --include=*.html . | grep -v worktrees | grep -v '^./docs/'
```

---

## Audit of record — 2026-07-22

```
shopSettings      0 documents        merchants with credentials   0
posPayments       0 documents        active on direct STK         0
sellerPayments    0 documents        orphaned credentials         0
paymentIntents    1 · payments 2 · paymentTimeline 1   (test data)
posDevices       10 · posStaff 1 · posSettings 1
```

Read path validated before trusting the zeros: `listCollectionIds` returned **107**
collections and a positive control read of `users` succeeded. The zeros are real,
not a failed query.

**Consequence:** stage 3 passes, there is no cohort to pilot against, and central
collection can become the *only* model at cutover rather than running dual-mode.

---

## Constraints that shaped the design

**Paybill, not Buy Goods Till.** Reconciliation joins on the server-minted
reference (`SKN` + 9 hex, `payment-intents.js:_mintRef`) carried as the M-Pesa
account number. Buy Goods has **no account field**; matching on
amount + MSISDN + timestamp instead collides as soon as two customers pay the
same amount in the same minute.

**STK signing is credential-bound.** `BusinessShortCode` cannot be repointed on
its own — consumer key, secret and passkey must change with it. Pairing a central
shortcode with seller credentials would fail at Safaricom or collect to the wrong
party, which is why stage 5 and stage 6 must land together. `darajaSTKPush`
currently refuses (`failed-precondition`) if `CENTRAL_MOR` is armed without them,
rather than sending a mis-signed request.

**Split is not native.** `settlement-providers.js:38` — *"Daraja STK cannot split
a single charge natively → collect-then-payout"* — so collect-then-settle is
forced by the rail, not merely preferred.

---

## Rollback

Stages 1–4 are additive or client-only and need no rollback path: the default
route is the pre-existing behaviour, and the retired UI collected data nothing
consumed. From stage 9, rollback is setting
`settlementConfig/paymentAccounts.collectionRoute` back to `DIRECT_TO_SELLER` —
which is why stage 10 (deleting the legacy path) must wait for production
stabilisation, not merely a successful pilot.
