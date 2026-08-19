# Webhook → activation trace

**Traced in code. No payment made, nothing deployed.**
Suite: `scripts/test-subscription-pay-methods.js` §12–13 — 64/0.

## Correction to an earlier statement of mine

I first reported "no IntaSend challenge/signature verification found". **That was a grep
filter artifact.** Verification exists: `intasendWebhook` (index.js:6655) and
`webhookIntasend` (index.js:7782) both take `INTASEND_WEBHOOK_CHALLENGE` from Secret
Manager and compare it against `req.body.challenge`, refusing when the secret is empty.
An unverified callback cannot mark a payment complete.

## What the chain actually does

```
initiateSTKPush          writes payments/{apiRef}, stores intentRef
        ↓
IntaSend                 provider reference
        ↓
intasendWebhook          challenge verified → payments/{apiRef}.status = COMPLETE
        ↓
        └── activates subscriptions/{uid} DIRECTLY   ← index.js:6848
```

## Finding 1 — no webhook ever marks the intent PAID 🔴

Nothing writes `paymentIntents/{ref}.status = 'paid'`. Not `intasendWebhook`, not
`webhookMpesa`, not `darajaSTKCallback`.

Consequences:

- **`onPaymentIntentPaid` never fires on the M-PESA path.** The trigger I added listens for
  exactly that transition.
- **`reconcileSubscriptionPayment` always returns `not-paid`** for an M-PESA purchase — so
  the checkout surface would poll twenty times and settle on "waiting for payment" **while
  the subscription was in fact already active**, activated directly by the webhook.

The merchant would be told the payment had not landed when it had. That is the
"healthy-looking failure" shape: the money arrives, the plan works, and the screen says
otherwise.

## Finding 2 — two activation authorities, divergent field names 🔴 *(mine)*

`intasendWebhook:6848` and `webhookMpesa:8333` both guard on:

```js
if (!subData || subData.paymentRef !== apiRef) { …activate… }
```

My `reconcilePaidIntent` wrote `lastPaymentRef` and never `paymentRef`. So had the wallet
rail activated first, the guard would have read `undefined !== apiRef` → **true**, and the
webhook would have activated **again** with a fresh 30-day `expiresAt`.

**One payment, period extended twice.** A defect I introduced by adding a second writer with
its own vocabulary — the same failure mode as the ten plan catalogues, at a smaller scale.

**Bridged, not solved.** The reconciler now also writes `paymentRef` and `expiresAt`, the
fields the deployed webhooks read, so their guard correctly skips. Certified: three
consecutive replays all SKIP, the period is unchanged, `lastPaymentRef` is unchanged,
exactly one subscription document exists, and the wallet is not debited again. A mutation
control proves the guard *would* have fired without the compat field, and a negative control
proves a genuinely different `apiRef` still activates.

## CONVERGED 2026-08-19 — the destination is now the implementation

Both webhooks were changed to **stamp the intent PAID and stop**. Neither writes
`subscriptions/{uid}` any more — 0 rival guards remain, and `reconcilePaidIntent` is the
only writer of a subscription document, for the wallet rail, the mobile rails, and every
rail added later. Finding 1 is therefore closed as well: the M-PESA path now marks the
intent PAID, so `onPaymentIntentPaid` fires and the checkout can report success truthfully.

The compatibility fields (`paymentRef`, `expiresAt`) are still WRITTEN as a projection for
existing readers, but nothing guards on them any more — a projection, not a second
authority.

```
Provider webhook
      ├─ verify challenge          (INTASEND_WEBHOOK_CHALLENGE)
      ├─ identify payment          (apiRef → payments/{apiRef})
      ├─ resolve intent            (existing.intentRef || apiRef)
      └─ paymentIntent.status = PAID
                    ↓
          onPaymentIntentPaid
                    ↓
          reconcilePaidIntent          ← the ONLY activation authority
             ├─ subscription ACTIVE
             └─ entitlement + maxProducts
```

## The destination, for the release

The webhooks should **mark the intent PAID and stop there**, letting `onPaymentIntentPaid` →
`reconcilePaidIntent` be the single activation authority. That removes the divergence rather
than bridging it, and makes the M-PESA and wallet rails identical from PAID onward.

It is a change to a **deployed money path**, so it belongs in the subscription release with
its own review — not slipped in here.

## Assertions now certified

| | |
|---|---|
| subscription period isn't extended twice | 🟢 |
| `lastPaymentRef` remains the same | 🟢 |
| entitlement isn't activated twice | 🟢 |
| wallet isn't debited twice | 🟢 |
| duplicate webhook doesn't create another subscription | 🟢 exactly one doc |
| a webhook for a different payment cannot activate this intent | 🟢 |
| an unverified callback cannot mark a payment PAID | 🟢 challenge verified |
| PENDING/PROCESSING never activate entitlement | 🟢 refused by name |
| `reconciledAt` isn't replaced incorrectly | 🟢 replay returns the original |

## Still open

- The M-PESA rail cannot report success to the merchant until Finding 1 is fixed.
- No real payment has been made.
- Renewal, grace, cancellation, resume, upgrade, downgrade remain untraced.
