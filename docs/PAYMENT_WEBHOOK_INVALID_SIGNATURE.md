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

## Runtime evidence — the captured webhook request (decisive)

The webhook logs an inert `diag` object per rejected callback. These are the
actual production requests IntaSend sent for KBQE4OW, read 2026-07-23:

| Field | Value | What it establishes |
|---|---|---|
| `signatureHeaders` | `""` (empty) | IntaSend sent **no** signature header |
| `headerNames` | `host, cache-control, x-forwarded-ssl, x-forwarded-proto, content-length, sentry-trace, baggage, …` | `x-intasend-signature` is **absent** |
| `hasChallengeField` | `true` | the request body **contains** a `challenge` |
| `challengeLen` | `12` | the challenge is a 12-char value |
| `bodyKeys` | `invoice_id, state, provider, charges, net_amount, currency, value, account, api_ref, provider_ref, challenge, …` | |
| `bodySample` | `{"invoice_id":"KBQE4OW","state":"PENDING",…}` | correct transaction; `invoice_id` = the tracking ref |
| `rawBodyLen` | 537 / 540 | body is intact — rules out body mutation (unknown B) |
| `sourceIp` | `157.245.201.212` | (an IntaSend egress IP) |

### Harness unknowns A–E, resolved by this evidence

- **A — does IntaSend sign as the code expects?** No. It sends a body `challenge`,
  not a header HMAC. The code's assumption is contradicted by the request.
- **B — does Cloud Functions modify the body before verification?** No. `rawBodyLen`
  is present and consistent; not the cause.
- **C — hashing the wrong payload?** Moot — there is no signature to compare against.
- **D — wrong secret / env / header?** **Wrong HEADER / wrong MECHANISM.** The code
  reads `x-intasend-signature`; that header does not exist (`signatureHeaders=""`).
- **E — failure before signature validation?** No. It fails **at** signature
  validation, because the required input (a signature header) is absent.

### First divergence (Phase 3)

| Step | Expected | Observed | Evidence |
|---|---|---|---|
| read signature | `x-intasend-signature` header present | header absent | `diag.signatureHeaders=""`, `headerNames` lacks it |
| authenticate | HMAC(body, key) == header sig | nothing to compare; check fails | `status: invalid_signature`, HTTP 401 |
| (intended) auth model | verify body `challenge` == configured value | challenge present but never checked | `hasChallengeField=true`, `challengeLen=12` |

The first divergence is at the very first read of the verification block: the code
requires a header IntaSend does not send.

## Confirmed root cause (was a hypothesis; now supported by the production request)

The production request shows IntaSend authenticates this webhook with a `challenge`
value in the request BODY, and sends no signature header. The deployed
`intasendWebhook` authenticates by requiring an `x-intasend-signature` HEADER and
HMACing the body. The required input is absent from every request, so verification
can never pass and every callback is rejected `invalid_signature` (HTTP 401).

Still to be confirmed by the payments owner (config, not mechanism): the exact
challenge value and where it is stored (IntaSend dashboard webhook config). The
MECHANISM is established by the request data; the SECRET VALUE to compare against
is not visible in these logs and must come from the dashboard.

Scope: `payments COMPLETE = 0` across the entire collection is consistent with
this affecting every IntaSend webhook, not only KBQE4OW.

---

## Harness deliverables

**Timeline**
```
2026-07-20 18:12:01Z  payments/SKNTJKAS8 created (PENDING), checkoutId bff55f40-…
2026-07-20 18:12:03Z  webhook #1 (state PENDING)    → invalid_signature → 401
2026-07-20 18:12:03Z  webhook #2 (state PROCESSING) → invalid_signature → 401
2026-07-20 18:12:33Z  webhook #3                    → invalid_signature → 401
                      payment never marked COMPLETE; activation never runs
2026-07-23            trace: signatureHeaders="", hasChallengeField=true → root cause
```

**Root cause (one sentence):** the production callbacks do not contain the
`x-intasend-signature` header the webhook requires (they contain a `challenge`
field instead), so every callback fails authentication and returns 401 before the
payment can be marked COMPLETE. *(Established from the request data. That the
`challenge` field is IntaSend's authentication mechanism is NOT asserted here — its
semantics must come from IntaSend's documentation, not from its mere presence.)*

**Fix (one sentence, for the payments owner to implement):** replace the
`x-intasend-signature` HMAC check with IntaSend's **documented** webhook
authentication mechanism (the request data shows a `challenge` field and no
signature header, but the correct verification must be taken from IntaSend's docs +
dashboard config, not inferred from the payload), preserving constant-time,
fail-closed behaviour.

**Proof (the one replay that resolves this — NOT yet performed; owner + IntaSend
config required):** replay KBQE4OW (or an equivalent sandbox transaction) and
observe the full chain — webhook 200 → payment COMPLETE → subscription written →
Starter entitlement in the dashboard and pricing page. Until that replay is
observed, the fix is unproven, per the Committed→Deployed→Parity→Runtime→Customer
Outcome invariant.

## Working hypothesis — SUPERSEDED (retained for history)

Previously stated as a hypothesis before the `diag` request data was read:

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
