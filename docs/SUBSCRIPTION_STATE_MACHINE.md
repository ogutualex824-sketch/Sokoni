# Subscription State Machine

**Status:** locked · **Date:** 2026-08-19 · **Certification:** `scripts/test-paid-trial-boundary.js` 82/0

Related: [[Payments]] · [[Authentication]] · [[SmartPOS]] · [[Marketplace]]

---

## The rule this document exists to enforce

**Buying a plan is not asking for a free trial.**

A merchant who has spent their promotional trial must still be able to buy anything.
The two paths ask different questions of different authorities, and neither may block
the other.

| Question | Authority | Consulted by |
| --- | --- | --- |
| Am I eligible for a promotional free trial? | `trialLedger` | the explicit *Start free trial* action only |
| May I buy this plan? | — | nobody; purchase is never gated on trial history |

Collapsing these produced *"you have already used your free plan"* on a **paid**
checkout, and made Seller Basic — which ships with a 3-day trial — impossible to buy.

---

## The machine

```
FREE
 |
 +-- Start free trial --> TRIALING (promotional)
 |                          |
 |                          +-- expires --> PAST_DUE --> free-tier limits
 |
 +-- Buy plan --> PAYMENT_PENDING
                      |
                      +-- PAID
                           |
                           +-- TRIALING (paid trial, if the package includes one)
                           |      |
                           |      +-- trial ends --> ACTIVE   (nothing more to pay)
                           |
                           +-- ACTIVE (no trial in the package)
                                  |
                        +---------+---------+
                        |                   |
                      RENEW              CANCEL
                        |                   |
                     ACTIVE      CANCEL_AT_PERIOD_END
```

The billing cycle belongs to the **paid-plan purchase**. It is never an input to the
free-trial eligibility check.

---

## Two things wear the status `trialing`

They must never be confused, because one has been paid for and the other has not.

| | promotional trial | paid plan's trial |
| --- | --- | --- |
| `paymentStatus` | absent / not `paid` | `paid` |
| `trialSource` | absent | `paid_plan` |
| trial ends on | `currentPeriodEnd` | `trialEnd` |
| when it ends | `PAST_DUE` — *"Subscribe now"* | `ACTIVE` — *"nothing more to pay"* |
| claims `trialLedger` | yes | **no** |

`paymentStatus` is the discriminator. It keys on the **recorded payment**, never on the
plan's price — a plan costing money does not mean this particular subscription was paid for.

`_trialEndMs()` reads `trialEnd` first and falls back to `currentPeriodEnd`, so every
pre-existing promotional trial behaves exactly as it did. This fallback is asserted as a
legacy control and must not be removed.

---

## A paid trial delays the paid period; it does not consume it

Payment on 19 Aug 2026 with a 3-day trial:

```
trial     19 Aug -> 22 Aug          already paid for
paid      22 Aug -> 22 Sep          monthly
renewal   22 Sep
```

Annual:

```
trial     19 Aug 2026 -> 22 Aug 2026
paid      22 Aug 2026 -> 22 Aug 2027
```

`currentPeriodStart` **is** the trial end. Charging for 30 days and delivering 27 is a
refund request, not a subscription.

---

## The subscription document

Three orthogonal facts, stated separately. Collapsing them is what made a paid
subscription indistinguishable from an unpaid trial.

| Field | Values | Meaning |
| --- | --- | --- |
| `status` | `trialing` · `active` · `grace` · `past_due` · `expired` · `cancelled` | the one field every existing reader consults |
| `paymentStatus` | `paid` | the money arrived |
| `subscriptionStatus` | `trialing` · `active` | where the subscription is |
| `trialStatus` | `active` · `ended` · `none` | where the trial is |
| `trialSource` | `paid_plan` · absent | which kind of trial |
| `billingCycle` | `monthly` · `annual` | what was bought |
| `trialStart` / `trialEnd` | Timestamp | the trial window |
| `currentPeriodStart` / `currentPeriodEnd` | Timestamp | the **paid** window |
| `renewalDueAt` | Timestamp | when money is next required |
| `expiresAt` | Timestamp | compat projection of `currentPeriodEnd` |

`status` stays authoritative for entitlement. `trialing` and `active` are both entitled
(`subscription-catalog.js` `LIFECYCLE`), so **access begins the moment the merchant pays**.

---

## Authority

| Concern | Owner |
| --- | --- |
| Price for `(planId, billingCycle)` | `createPaymentIntent` — from the catalogue |
| Trial length | `createPaymentIntent` — from the catalogue, stamped on the intent |
| Activation | `reconcilePaidIntent` — the single activation authority |
| Trial-end transition | `subProcessExpirations` (hourly) |
| Promotional-trial eligibility | `entitlement-authority.trialState` / `trialLedger` |

The browser names a **cycle**. It never names an amount, a trial length, or a period.
Trial terms are honoured **as quoted on the intent**, so activation uses the terms the
merchant paid against rather than whatever the catalogue says when the webhook lands.

---

## What the merchant is told

Both the cycle screen and the payment screen state:

> You're paying today. Your 3-day trial starts immediately. Your paid subscription
> begins automatically when the trial ends.

The trial-only modal states the opposite just as plainly: *"No payment today."*

---

## Open

- A merchant who spends the promotional trial and then buys still receives the plan's
  bundled trial. The stated commercial flow attaches it unconditionally; gating it is a
  one-line change if that double-dip is not intended.
- `isEntitled('past_due')` returns `true` while `entitlementFor({status:'past_due'})`
  resolves to free-tier limits. The authority path uses the latter and is correct; the
  two should be reconciled.
- Real M-PESA STK and a genuine IntaSend webhook remain **UNPROVEN** — no handset test
  has been run against this build.
