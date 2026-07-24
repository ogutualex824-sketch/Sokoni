# IntaSend webhook — configuration audit

**Date:** 2026-07-24 · **Type:** read-only audit, no configuration changed

Evidence classes are marked throughout:
**VERIFIED** (directly observed) · **EXPECTED** (derived from our code) ·
**UNKNOWN** (dashboard-side, not observable from here).

## VERIFIED — two live IntaSend webhook endpoints

| | `webhookIntasend` | `intasendWebhook` |
|---|---|---|
| Source | `functions/index.js:6636` | `functions/index.js:5754` |
| Deployed | yes (https) | yes (https) |
| Probe `POST {}` | **401** | **401** |
| Invoker | public | public |
| Challenge | `INTASEND_WEBHOOK_CHALLENGE`, HMAC-SHA256 constant-time | **identical** |
| Writes `subscriptions/{uid}` | yes | **yes** |
| Direct `materialiseEntitlements` | **yes** (`:6790`) | no |
| Event states | COMPLETE · FAILED · PENDING | COMPLETE · FAILED · PENDING · **CANCELLED** · processing |

Both accept the same secret and both activate subscriptions. They are
near-duplicates that have **diverged**: one carries the entitlement fix, the other
carries wider event-state coverage. Neither is a superset of the other.

## VERIFIED — corrected risk assessment

An earlier draft of this audit claimed entitlement materialisation reaches
production *only* via `webhookIntasend`. **That was wrong**, and the correction
changes the operational conclusion.

`onSubscriptionChangedSyncEntitlements` triggers on `subscriptions/{subId}`
(`subscription-authority.js:255`) and calls `materialiseEntitlements`. Because
**both** webhooks write `subscriptions/{uid}`, that trigger covers either one.

| Deployment state | `webhookIntasend` | `intasendWebhook` |
|---|---|---|
| **Current** — new functions NOT deployed | no materialisation | no materialisation |
| Trigger deployed | ✅ direct call + trigger | ✅ trigger |
| **Option B** — trigger dropped for quota | ✅ direct call only | ❌ **none** |

Current deployment state, verified via `functions:list`:

```
onSubscriptionChangedSyncEntitlements   NOT DEPLOYED
getMerchantEntitlements                 NOT DEPLOYED
onSubscriptionChangedSyncLimit          NOT DEPLOYED
```

### The coupling that matters

**Option B and the endpoint choice are not independent decisions.** Dropping
`onSubscriptionChangedSyncEntitlements` to save Cloud Run capacity removes the
redundancy that makes the endpoint choice safe. Take Option B *and* have the
dashboard pointed at `intasendWebhook`, and entitlements silently never
materialise — the original incident reproduced by two individually reasonable
choices.

If Option B is taken, pointing the dashboard at `webhookIntasend` stops being
hygiene and becomes **required**.

## VERIFIED — server-side readiness

| Check | Status | Evidence |
|---|---|---|
| Endpoint reachable | ✅ | live POST → 401 (not 403/404) |
| Challenge validation | ✅ | constant-time HMAC compare, not `===` |
| Secret present | ✅ | 3 ENABLED versions, latest 2026-07-23 11:17 (**metadata only — value never read**) |
| Idempotency | ✅ | `payments/{apiRef}` guard inside a transaction; a duplicate-commission race is documented in-code |
| Audit trail | ✅ | `commissionLedger` · `subscriptionAuditLog` · `entitlementAuditLog` |
| Error handling | ⚠️ | `500` on missing secret (IntaSend retries — correct); `401` on mismatch may retry indefinitely |
| **Delivery ever observed** | ❌ | `commissionLedger` 0 · `subscriptionAuditLog` 0 · `billingHistory` 0 · `entitlements` 0 |

**No correctly-challenged COMPLETE callback has ever been processed by either
endpoint.** Both subscription payments remain `status: PENDING`.

## VERIFIED — event coverage gaps

| IntaSend event | Handler | Business logic expecting it |
|---|---|---|
| Collection (COMPLETE) | ✅ both | subscriptions, orders, commission |
| **Reversal** | ❌ none | `refunds` exists; `adminSubProcessRefund` marks `processed` with **zero gateway calls** |
| **Send Money** | ❌ none | settlement/payout engines exist |
| **Wallet Transfer** | ❌ none | `walletTransactions` exists |

A reversal performed in IntaSend would not be reflected in SOKONI. Not today's
blocker, but a real divergence risk once refunds are used.

## EXPECTED — dashboard configuration (NOT verified)

> Derived from our code. Nothing here states what the dashboard actually contains.

| Setting | Expected |
|---|---|
| Endpoint | `https://us-central1-sokoni-aeb26.cloudfunctions.net/webhookIntasend` |
| Method | POST, `application/json` |
| Challenge | must equal Secret Manager `INTASEND_WEBHOOK_CHALLENGE` |
| Collection event | enabled |
| Send Money / Reversal / Wallet Transfer | no handler exists — see above |

## UNKNOWN

Registration count · which row owns Collection · duplicate rows · whether IntaSend
permits one webhook per event type · actual challenge value or length · delivery
history.

A code comment (`index.js:5760`) records `challengeLen = 12` and "no
`x-intasend-signature` header". That is **a claim in a comment, not live
evidence**, and must not be treated as current dashboard state.

## Operational checklist

Configuration evidence and runtime evidence, in an order that keeps them separable:

1. Deploy the intended functions.
2. **Record which endpoint IntaSend is configured to call.** Cheap, and it removes
   a variable from any later diagnosis — knowing the endpoint turns an ambiguous
   result into an immediate explanation.
3. Make one real payment.
4. Verify: `payments` · `subscriptions` · `commissionLedger` ·
   `subscriptionAuditLog` · `entitlements/{uid}`.
5. Run `node scripts/verify-entitlement-consistency.js <uid>`.

Discriminating result: if `commissionLedger` gains a document but `entitlements`
stays empty, the fix is not reaching production — cross-reference step 2 and the
trigger's deployment state to distinguish "wrong endpoint" from "trigger absent".

## Target architecture (after Milestone 1)

```
IntaSend
   │
   ▼
webhookIntasend
   │
   ▼
shared payment/subscription service
   ├── payments
   ├── subscriptions
   ├── commission
   ├── entitlements
   └── audit logs
```

`intasendWebhook` removed, or reduced to a thin wrapper delegating to the same
service. Two public handlers with overlapping responsibility have **already**
drifted once — one holds the entitlement fix, the other wider event coverage.
Consolidate after the flow is proven, not before: changing the handler and the
configuration simultaneously would make a failure impossible to attribute.
