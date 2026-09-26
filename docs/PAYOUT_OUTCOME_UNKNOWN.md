# Payout ambiguous outcome — `outcome_unknown`

**Status:** repaired on `feat/creator-hub`, **NOT DEPLOYED**. Code: `functions/wallet.js`.
Tests: `scripts/test-payout-outcome-unknown.js` (executed). Related: [[PAYOUT_SANDBOX_VERIFICATION]],
[[WITHDRAWAL_ENGINE_CHANGE_PLAN]], [[CREATOR_HUB]], [[Payments]].

## The defect (proven by execution, 2026-09-26)

An IntaSend B2C request that ended in a timeout / 5xx / 429 was parked at `retry_scheduled`. The
`processPayoutRetries` job then **sent it again**. The B2C request body carries **no reference IntaSend
deduplicates on** (`payment-adapters.js sendMoneyB2C` sends `provider, currency, requires_approval,
transactions[]` only), so if the first request had executed, the seller was paid twice. Executed
locally: timeout → retry job → **2 provider calls for one payout**.

Two neighbouring holes closed at the same time:

- `adminProcessPayout` could **approve** (re-send) or **reject** (return the funds of) a
  `retry_scheduled` payout. Either can double-pay.
- `adminProcessPayout status:'paid'` could settle a `failed` payout whose funds were already returned
  (`pendingPayout` went to −200 in the executed control). `_settlePayoutPaid` now refuses
  `rejected/failed/reversed`; `_refundPayout` now treats `settled_manually/reversed` as terminal.

## State machine

| From | Event | To | Money |
|---|---|---|---|
| (request) | balance check passes | `approving` (instant) / `pending` / `scheduled` | balance −amount, `pendingPayout` +amount (**RESERVED**) |
| `approving` | B2C 2xx | `processing` (+ `intasendRef`) | held |
| `approving` | B2C 4xx answered (not 408/409/425/429) | `failed` | returned **once** |
| `approving` | adapter unavailable before any request | `failed` | returned once |
| `approving` | timeout / reset / DNS / 5xx / 408 / 409 / 425 / 429 | **`outcome_unknown`** | **held**, never retried |
| `retry_scheduled` (legacy) | `processPayoutRetries` | **`outcome_unknown`** | held — **no provider call** |
| `outcome_unknown` | `adminResolvePayoutOutcome` `paid` + IntaSend transaction id | `paid` | hold released, ledger row written |
| `outcome_unknown` | `adminResolvePayoutOutcome` `not_paid` + provider statement | `failed` | returned once |
| `outcome_unknown` | provider webhook that matches the payout: COMPLETE / FAILED | `paid` / `failed` | as above (provider-authoritative) |
| `outcome_unknown` | approve · reject · manual mark-paid · retry worker | **refused / skipped** | unchanged |
| `processing` | webhook COMPLETE | `paid` | hold released |
| `processing` | webhook FAILED | `failed` | returned once |
| `paid` / `settled_manually` / `failed` / `rejected` / `reversed` | any settle or refund | unchanged (no-op) | unchanged |

`outcome_unknown` is counted as in-flight by `_hasActivePayout` (so a new request is not instant),
by `scripts/reconcile-payouts.js` (reservation consistency), and by `adminPayoutOps`
(`counts.outcomeUnknown`, `lists.outcomeUnknown`).

## Resolution — `adminResolvePayoutOutcome` (Super Admin only)

There is **no safe provider-status lookup** for this case, so none was invented:
`/api/v1/payment/status/` (`wallet.js _intasendInvoiceState`) is the **collection invoice** lookup,
and an `outcome_unknown` payout never received a tracking id to query. The webhook cannot find it
either (it matches by `api_ref` = request id — which B2C never sends — or by `intasendRef`).

A Super Admin checks the IntaSend account and records what it shows:

| decision | evidence.type | evidence.reference |
|---|---|---|
| `paid` | `intasend_transaction` | the IntaSend transfer id (becomes `intasendRef` / `gatewayReference`) |
| `not_paid` | `provider_statement` · `provider_support_confirmation` | the statement / ticket reference |

`evidence.note` (≥ 20 chars) says what was checked. One transaction commits the transition, its
ledger effect and `payoutResolutions/{requestId}` (`requestId, decision, evidence, resolvedBy,
resolvedByEmail, resolvedAt, previousStatus, resultingStatus, sellerUid, amount`), created with
`create()` — the exactly-once anchor. A `paid` decision also `create()`s
`payoutEvidenceClaims/{sha256(REFERENCE)}`, so one IntaSend transfer cannot settle two payouts.
Repeating the same decision is a no-op (`alreadyResolved`); a contradicting one is refused.

UI: **AdminOS → Financial → Payouts → "Outcome unknown"** (`sokoni-aos.js`). Every admin sees the
list; only a Super Admin gets the evidence form. The server enforces everything; the form is
convenience.

## Provider semantics — what is and is not known

| Claim | Status |
|---|---|
| The code never sends a second B2C request for a payout whose first outcome is unknown | **Proven locally** (executed, counting fake adapter) |
| A 4xx from IntaSend means the transfer was not executed | **Provider contract, assumed** — not certified live |
| A timeout / 5xx may have executed | **Assumed conservatively** — not observed live |
| The provider reference protects against duplicate execution | **FALSE.** The reference is for reconciliation only. B2C initiate has no idempotency key; SOKONI does not claim one |
| Live IntaSend behaviour for any of the above | **UNPROVEN** — no provider call was made |

## Residual (not in this repair)

- A payout stuck at `approving` (crash between claim and answer, or the success write failing) is
  flagged by `reconcilePayouts` but has no resolution action; it is never re-sent.
- ECONNREFUSED / ENOTFOUND prove nothing left the process but are still classed `outcome_unknown`
  (conservative; costs a manual resolution, never money).
- The seller UI's own idempotency key (`provider-dashboard.html` uses `'po_'+Date.now()`) is the
  separate "withdrawal UI key" slice. The server payout identity is what these guarantees rest on.

## Deploy

Functions: `requestSellerPayout`, `adminProcessPayout`, `processPayoutRetries` (no secret bound any
more), `adminPayoutOps`, `adminGetPayout` (`admin-os.js` STAGE map), **new**
`adminResolvePayoutOutcome`. Hosting: `sokoni-aos.js`, `sokoni-wallet-v2.js`,
`sokoni-merchant-wallet.js`, `provider-dashboard.html`. No rules change (the new collections are
server-only; default-deny for clients). Deploy the functions **before** the hosting labels are
relied on; there is no data migration — legacy `retry_scheduled` rows are parked by the first
`processPayoutRetries` run. **Wallet backend is FROZEN** (`wallet-backend-v1.0-frozen`): this
change needs the owner's release decision and the gates in [[WALLET_FREEZE_ACCEPTANCE]].
