# Communication Engine

**Status:** Live (2026-07-13)
**Source:** `functions/notify.js`
**Related:** [[Notifications]] · [[Orders]] · [[SmartPOS]] · [[Authentication]]

---

## Why this exists

Before this engine, SOKONI had no seam for outbound communication. Eight modules sent
push directly, ~19 wrote the `notifications` collection directly, and SMS was reached
through a third path. Nothing was shared, so nothing was consistent — and three
production failures had accumulated silently, none of which any test would have caught.

All three were the same bug: **two names for one thing, with nobody checking that the
two sides agreed.**

| Producer wrote | Consumer read | Consequence |
| --- | --- | --- |
| client → `users/{uid}.fcmToken` (a *field*) | `loyalty.js` → `collection('fcmTokens')`<br>`redis-jobs.js` → `users/{uid}/fcmTokens` | Both queries always returned empty. **Push from those two modules never reached a single user.** |
| engine → `data.deepLink` | both service workers → `data.url` | Every rich push **opened the homepage** instead of the order it was about. |
| engine → `userId` | notification center → `where('targetUid','==',uid)` | Notification stored perfectly and **seen by nobody** — it did not match the feed's query. |

Each was invisible because the two halves lived in different files and were never
asserted against each other. `scripts/test-notify.js` now asserts all three, by reading
both sides and comparing them.

---

## The contract

Business code declares **intent**. It never names a channel or a provider.

```js
const { notify } = require('./notify');

await notify({
  uid,
  type: 'order_dispatched',        // intent
  dedupeKey: `order:${id}:picked_up`,
  deepLink: `/track?order=${id}`,
  group: `order:${id}`,
});
```

The engine decides channels from the type's **priority**:

| Priority | Channels | Preferences | Quiet hours |
| --- | --- | --- | --- |
| `critical` (OTP, password reset, fraud, wallet debit) | SMS + push + in-app | **Ignored** | **Ignored** |
| `commerce` (orders, payments, delivery) | Push first; SMS only as a **fallback** if push cannot land | Respected | Respected |
| `marketing` (promotions) | Push + email; SMS only on explicit opt-in | Respected (opt-**in**) | Respected |

A caller that picks its own channel is how "marketing SMS" ends up in an OTP path.
Critical is unsuppressible on purpose: nobody should be locked out of their account
because it is 11pm and they once muted a category.

**Idempotency.** Every send carries a `dedupeKey`. The Firestore doc ID *is* the key,
written with `.create()` — so a retried Cloud Function cannot double-notify. This is
idempotency by construction, not by check-then-write.

---

## Order timeline

Eleven stages, defined as **data** in `notify.js` (`ORDER_TIMELINE`). Adding a stage is
a registry entry, not a code change.

| # | Stage | Notifies | Milestone |
| --- | --- | --- | --- |
| 1 | Order Received | `order_placed` | ✓ |
| 2 | Payment Confirmed | `payment_success` | ✓ |
| 3 | Seller Accepted | `order_accepted` | ✓ |
| 4 | Preparing Order | `order_preparing` | |
| 5 | Package Ready | `order_ready` | |
| 6 | Rider Assigned | `rider_assigned` | ✓ |
| 7 | Picked Up | `order_dispatched` | ✓ |
| 8 | On The Way | — *(silent)* | |
| 9 | Near You | `rider_nearby` | |
| 10 | Delivered | `order_delivered` | ✓ |
| 11 | Completed | — *(silent)* | |

Two properties the customer actually feels:

- **Monotonic.** `advanceOrder()` to a stage already passed is a no-op. A retried
  trigger or a duplicate courier webhook cannot rewind *Delivered* to *On The Way*. An
  order that jumps backwards is worse than one that says nothing.
- **Quiet where it should be.** Stages 8 and 11 carry no notification type. Eleven
  pushes for one order is how a premium experience becomes a muted app.

**Client:** `track.html` renders the stages live from `orders/{id}`, with the time each
stage was reached. The push deep-link is `/track?order=<id>`. The older shareable
`/track?code=<8-char>` trip link still works and needs no sign-in.

---

## Rich push

`image` renders, and `group` maps to the webpush `tag`, so the eleven stages of one
order **collapse into a single updating thread** instead of stacking eleven
notifications. `renotify` still alerts on each change. The same `group` is the feed's
`groupKey`, so the notification center groups it identically.

---

## Branding

Every outbound message is **SOKONI**. "✓ SOKONI Confirmed Payment" — never Bravilex.

Bravilex International Co. Limited remains the legal entity, Merchant of Record,
settlement account holder and KRA taxpayer. It appears **only** in the legal footer, on
tax documents, and on settlement records. See [[Brand Policy]] — enforced by
`scripts/verify-company-identity.js` (`BRAND_FORBIDDEN`).

---

## Testing

`node scripts/test-notify.js` — 23 checks. **Sends nothing.** It guards the rules whose
failure hurts a real person: that OTP can never be suppressed, that marketing is
opt-in, that commerce does not double-spend on SMS, that the timeline cannot rewind,
and that all three producer/consumer field pairs above still agree.

---

## Known gaps

- Push delivery has **never been proven on a real device**. The token plumbing is now
  correct and tested, but "correct" and "arrived" are different claims. This needs a
  human with a phone.
- SMS sender ID "SOKONI" is still pending Africa's Talking approval; `AT_SENDER_ID`
  stays empty until it lands.
- ~19 modules still write the `notifications` collection directly rather than calling
  `notify()`. They work, but they bypass preferences, quiet hours and idempotency.
  Migration is incremental and safe: each one is a local change to a single call site.
