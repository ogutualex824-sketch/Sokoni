# Writers to `subscriptions/*`

**Built:** 2026-07-22 · **Method:** grep for every `collection('subscriptions').doc(...)` write, then per-writer trigger and deployment check.

Built because four separate investigations in one session each found one writer,
concluded from it, and were wrong. `activateSubscription` was read and reasoned
about for an hour before `intasendWebhook` — the authoritative path — was found
sixty lines above it in the same file.

**Rule this exists to enforce:** before changing a canonical write path,
enumerate every writer to the same document and classify each as primary,
repair, migration or legacy.

---

## The map

| # | Writer | Doc id | Trust source | Deployed | Role |
|---|---|---|---|---|---|
| 1 | `index.js:5693` `intasendWebhook` | `intent.uid` | **`paymentIntents/{ref}`** | **ACTIVE** | **PRIMARY — payment activation** |
| 2 | `index.js:5803` `activateSubscription` | `uid` | **client `request.data.plan`** | **ACTIVE** | **LEGACY — weaker boundary** |
| 3 | `payment-reconciliation.js:644` `healSubscriptionEntitlement` | `uid` | `payments/{ref}` + intent | ACTIVE (via reconciliation) | REPAIR — config-gated, fails closed |
| 4 | `entitlement-adapters.js:73,98` `activate()` | `uid` / `led.ownerUid` | ledger entry | unverified | INTERNAL abstraction |
| 5 | `business-bootstrap.js:973` | **`merchantId`** | server onboarding | not deployed | ONBOARDING |
| 6 | `sub-billing.js:320,386,430,606,681` | **auto-id** + `subscriptionId` | server | dispatcher not deployed | BILLING lifecycle |
| 7 | `sub-engine.js:315,531-532` | **auto-id** | server | dispatcher not deployed | ENGINE lifecycle |

12 write sites, 6 modules.

---

## Three document-id conventions, and why it matters

```
subscriptions/{uid}          webhook, activateSubscription, heal, adapters
subscriptions/{merchantId}   business-bootstrap        ← SOK-GL58F7 lives here
subscriptions/{autoId}       sub-billing, sub-engine   (uid carried as a field)
```

**This is the root cause of the identity mismatch patched client-side earlier in
the session.** `sokoni-subscriptions.js` looked up `subscriptions/{providerId}`
by document id and missed the live merchant entirely, because that merchant's
record is keyed by `merchantId`. The client fix — try the direct id, then query
`where('uid','==',...)` — treats the symptom. The cause is that three server
subsystems disagree about what identifies a subscription.

A reader cannot be correct without knowing all three conventions, and nothing
declares them.

---

## The two that are live

**`intasendWebhook` — correct.** Reads `paymentIntents/{apiRef}`, requires
`purpose === 'subscription'`, and derives `uid` and `plan` from the intent. The
client is never consulted. Its own comment states the design: *"The client-side
onSuccess path is fragile (tab close, network drop); this webhook is the
authoritative signal that payment completed."* This is the intent-authority
model, already implemented.

**`activateSubscription` — weaker.** Validates that the caller owns a COMPLETE
payment, then writes whatever `plan` the client sent. It never loads the intent.
Both callers are in `subscriptions.html`:

- `:359` — `plan: planKey`, from the page's hardcoded array
- `:525` — `plan: stored.plan`, from **`localStorage.sokoniSubscription`**

The second violates a standing project rule: never treat localStorage as
business authority. The value reaches a deployed callable that accepts it.

Both write the same `subscriptions/{uid}` document as the webhook, so the two
paths can disagree about the same merchant's plan.

---

## What is NOT established

- Whether `entitlement-adapters.activate()` is reachable in production.
- Which deployed function created `subscriptions/SOK-GL58F7`. It carries
  `activatedBy: 'automation'` (matching `automation-engine.js:230`) and
  `autoActivated: true` (matching `business-bootstrap.js:988`), but neither
  module's dispatcher appears in the deployed function list. It may predate the
  current deployment set.
- Whether `sub-billing` / `sub-engine` auto-id records exist in production. The
  `subscriptions` collection holds exactly one document, keyed by `merchantId`,
  so neither convention is currently represented.

---

## Recommendation

Retiring `activateSubscription` is defensible — the webhook covers its purpose
with a stronger boundary — but two facts argue for delegation over deletion:

1. It exists to cover webhook failure, and webhook delivery is not guaranteed.
2. `healSubscriptionEntitlement` already exists as the server-side backstop for
   exactly that case, and is config-gated and fails closed.

If (2) is considered sufficient coverage, delete `activateSubscription` and both
of its call sites. If not, make it resolve `paymentIntents/{paymentRef}` and
derive `plan` the way the webhook does, ignoring `request.data.plan` entirely.

**Either way it must stop accepting a plan from the client.** That is the whole
of the defect; the reference model does not need changing, and an earlier
proposal in this session to normalize it was based on not having found the
webhook.
