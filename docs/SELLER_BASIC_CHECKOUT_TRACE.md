# Seller Basic → Confirm & Pay — full path trace

**Traced in code, not in a browser.** The reported symptom is reproduced exactly by the
source; no test purchase was made and nothing was changed.

Symptom: pressing **Confirm & Pay** on Seller Basic reports *"Payment not confirmed.
Complete payment first."* before any STK push is sent.

---

## The path, end to end

```
plans.html  subGetPlans → seller_basic { price.monthly 99900, trial.days 3 }
     ↓
plans.html:353  trialDays > 0  →  button renders "Start Free Trial"
     ↓
plans.html:430  branch: plan.trialDays > 0
     ↓
     subActivate({ planId, billingCycle, paymentRef: "trial_…", startTrial: true })
     ↓
sub-billing.js:269  const { planId, billingCycle, paymentRef, isTrial } = req.data
     ↓                                                        ^^^^^^^
     isTrial === undefined          ← the client sent `startTrial`
     ↓
sub-billing.js:276  if (amountDue > 0 && !isTrial)   → 99900 > 0 && !undefined → TRUE
     ↓
     looks up payments/trial_seller_basic_<ts>  → does not exist
     ↓
sub-billing.js:287  throw "Payment not confirmed. Complete payment first."
```

## Break 1 — a one-word field-name mismatch

`plans.html:437` sends **`startTrial: true`**. `sub-billing.js:269` destructures
**`isTrial`**. The names never meet, so `isTrial` is `undefined`, the paid-plan
verification branch runs on a trial request, and it looks for a payment that was never
supposed to exist. The fabricated `paymentRef` (`trial_<plan>_<timestamp>`) confirms the
client never intended a real payment here.

**This is the reported error, in full.** It is not an STK failure, not an IntaSend problem,
and not a webhook problem — the STK push is never reached.

## Break 2 — the paid path leads to a page that ignores it

For a plan with **no** trial, `plans.html:454` redirects to:

```
checkout.html?type=subscription&planId=…&cycle=…&amount=…&name=…
```

`checkout.html` contains **no `URLSearchParams`, no `params.get(`, and no subscription
branch** — the single occurrence of the word "subscription" is an unrelated comment at
line 3059. Every one of those parameters is ignored. There is no M-PESA number step, no
STK initiation, and no subscription checkout at all.

So the paid path is a dead end, and the trial path is broken by Break 1. **Neither route
can currently activate Seller Basic.**

## Break 3 — and this one changes the fix ORDER

Fixing Break 1 alone would be **worse than leaving it**.

`subActivate` performs **no trial-eligibility check**. It does not consult any record of
whether this merchant has already had a trial, because until now no such record existed
(see the entitlement audit, finding F5). The field-name mismatch is currently the *only*
thing stopping `startTrial: true` from provisioning a fresh 3-day trial on every click,
indefinitely.

**Correct order:**

1. Wire the trial ledger into `subActivate` — `entitlement-authority.startTrial()` already
   claims `trialLedger/{uid}` with `create()`, so a trial is granted once, ever. Certified.
2. **Then** fix `startTrial` → `isTrial` (or accept both and normalise).
3. Then build the real paid checkout: M-PESA number → STK → pending → verified → activate.

Doing (2) before (1) opens an unlimited-free-trial hole on a live billing path.

## The paid flow that is missing

Nothing in the current path implements the four states. `subActivate` recognises only
"payment exists and is COMPLETE" or "refuse":

| state | meaning | exists today |
|---|---|---|
| `STK_SENT` | request reached M-PESA | no |
| `PAYMENT_PENDING` | awaiting confirmation | no |
| `PAID` | verified by provider/webhook | partially — `payments/{ref}.status === 'COMPLETE'` |
| `ACTIVE` | subscription provisioned from a verified payment | yes — `subActivate` |

The merchant's phone number is never collected or prefilled anywhere in this path.

## Price rendering

`plans.html` reads the price from the catalogue (`plan.price.monthly`, falling back to
`plan.priceMonthly`) and converts cents → KES, so it is **not** hardcoded. A prior defect
is already fixed there: `plan.price` did not exist on the modal's plan object and produced
`amount=NaN`; the current code guards a missing price and refuses checkout rather than
sending NaN.

Note the catalogue disagreement recorded elsewhere: `seller_basic` is **99900 cents =
KES 999**, while `ai_starter` is KES 499. Both map to the STARTER entitlement tier.

## What was NOT done

- No code changed. No payment attempted. No deployment.
- The webhook and renewal lifecycle remain untraced — the break is upstream of them, so
  this trace does not reach them.
- The KASS repair stays on hold, as agreed.
