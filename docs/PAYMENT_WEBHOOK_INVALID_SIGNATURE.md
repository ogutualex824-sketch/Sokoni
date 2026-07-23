# Payment Webhook — invalid_signature blocks subscription activation

**Type:** Investigation handoff (not an audit, not a fix). No code changed.
**Date:** 2026-07-23
**Owner:** the payments workstream (owns `intasendWebhook` and the payment-confirmation pipeline). This document is evidence for that owner, produced without modifying their code.

## Summary

A completed customer payment did not activate the merchant subscription because
the payment webhook was rejected before any payment-completion processing
occurred. The money left the customer and was confirmed by IntaSend; SOKONI
rejected the confirming callback and the payment record never advanced past
PENDING.

**Status:** Investigation complete. No code changes made. Signature verification
must NOT be weakened — see Security Note.

## Observed evidence

### Transaction
- Amount: **KES 499**
- IntaSend tracking reference: **KBQE4OW**
- IntaSend payment confirmation received ("Your payment of KES 499.00 to SOKONI has been received")
- Merchant M-PESA confirmation SMS received
- Date/time: **2026-07-20 21:12 EAT** (18:12 UTC)

### Database state (production, read 2026-07-23)
- `payments/SKNTJKAS8` — **status: PENDING**, `checkoutId: bff55f40-ee88-483d-84df-f5349f597914`, `uid: xrH21J5GFbW8PluCZ2ny5nIuf602` (KASS VAPES owner), amount 499
- `paymentIntents/SKN3550FD490` — status `created`, same uid, amount 499
- `subscriptions/SOK-GL58F7` — `status: trialing`, `plan: trial`, `planId: seller_free`
- Across the whole `payments` collection: **COMPLETE = 0**

### Webhook logs
The IntaSend callback DID reach SOKONI and was rejected:
- `webhookLogs/5Y5JxduRJrZMNd0EYKgO` — `status: invalid_signature`, `eventId WHK-1784571122969-FE349B6E`, ts 18:12:03Z
- `webhookLogs/J70TSThrgjbZ2JtOvENr` — `status: invalid_signature`, ts 18:12:33Z
- `webhookLogs/3CDYhBcg7IXLbPKQYZaC` — `provider: intasend`; its `diag` captured `hasChallengeField` among the request characteristics
- Result each time: **invalid_signature → HTTP 401**

## Execution trace

```
M-PESA
   ↓
IntaSend  (KBQE4OW — payment received, confirmed to customer)
   ↓
Webhook reaches SOKONI  (18:12:03, 18:12:33)
   ↓
Signature verification fails  → invalid_signature
   ↓
HTTP 401
   ↓
payments/SKNTJKAS8 stays PENDING
   ↓
Subscription activation never executes
   ↓
subscriptions/SOK-GL58F7 stays trialing / seller_free
```

## Code location (what the implementation does — not a judgement)

`functions/index.js`, `exports.intasendWebhook` (~line 5610). The current
implementation:

- reads the signature from the request header `x-intasend-signature`
- computes an expected HMAC-SHA256 of the raw body using `INTASEND_PRIVATE_KEY`
- compares them with a constant-time check and responds `401 Unauthorized` on mismatch

This section documents the implementation only. Whether it matches the
provider's mechanism is the subject of the hypothesis below.

## Working hypothesis (needs confirmation — NOT established fact)

Based on the rejected callbacks, the `invalid_signature` status, and the webhook
diagnostics (notably `hasChallengeField` in the captured request), the current
verification implementation **may not match the webhook authentication mechanism
configured for this IntaSend integration** — i.e. the code verifies an
`x-intasend-signature` HMAC header while the incoming webhook may authenticate by
a different mechanism (for example a `challenge` value in the body).

This is a hypothesis derived from static analysis and the captured diagnostics.
It has NOT been confirmed against the provider's contract. It must be verified
against:

- IntaSend's current webhook documentation
- the IntaSend dashboard webhook configuration for this account
- the configured webhook secret / challenge value

before any code change.

Scope note: because `payments COMPLETE = 0` across the entire collection, this
appears to affect every IntaSend webhook, not only KBQE4OW — but that breadth is
part of the same hypothesis and should be confirmed the same way.

## Security note

**Do not bypass or remove webhook signature verification.** The current behaviour
fails closed — it rejects unauthenticated callbacks, which is correct. Removing
the check would allow anyone to forge a payment-confirmation and mint a paid
subscription without paying. Any correction must continue to authenticate webhook
requests according to the provider's documented mechanism; the goal is to verify
correctly, not to stop verifying.

## Recommended next step (payments owner)

1. Verify IntaSend's configured webhook authentication method for this account
   (dashboard + current docs).
2. Compare it with the current verification implementation (`intasendWebhook`).
3. Update the verification logic ONLY if a mismatch is confirmed — preserving
   authentication, not removing it.
4. Do NOT stop at "the webhook returns 200". That proves authentication only.
   Replay `KBQE4OW` (or an equivalent low-value / sandbox test transaction) and
   verify the ENTIRE downstream chain, because none of it has ever executed in
   production — no payment has reached activation, so this is its first real run:
   ```
   webhook accepted
         ↓
   payments/{ref} → COMPLETE
         ↓
   subscription document updated
         ↓
   trial → starter
         ↓
   product limit removed (canPublishProduct no longer returns the trial cap)
         ↓
   pricing page reflects Starter
         ↓
   merchant dashboard reflects Starter
   ```
   A 200 that does not produce a Starter entitlement end to end means the fix is
   incomplete — the failure would simply have moved one stage downstream.

## Related
- `docs/SUBSCRIPTION_ACTIVATION_VERIFICATION.md` — the earlier read-only
  verification (activation subsystem not at fault; no completed payment existed to
  activate). This document identifies WHY no payment completed: the webhook
  rejection upstream of activation.
