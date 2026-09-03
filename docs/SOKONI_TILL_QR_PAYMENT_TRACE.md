> **Correction, 2026-09-03 (later the same day):** the "one duplication found" note below,
> characterizing `intasendWebhook`/`webhookIntasend` as "two near-identical exported functions,"
> is **wrong on both counts** — checked properly in
> `docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md` (Q1 of the Till/QR gate ordering). They are not
> near-identical (`webhookIntasend` is 624 lines vs. 254, and is a strict superset — wallet
> credit, marketplace order finalisation, booking creation, and an entitlement-materialisation
> incident fix that `intasendWebhook` never received). And the authority question is **not** out
> of scope-and-unresolved: 30 days of Cloud Run logs show `intasendwebhook` failed its challenge
> check on **100% of requests** (18/18 → 401), while `webhookintasend` served real,
> successfully-authenticated IntaSend traffic (47× 200 OK, real B2C payout payloads observed).
> **`webhookIntasend` is the live production endpoint.** Original text below left as written.

# SOKONI Till / QR payment — existing authority trace (read-only)

**Status:** 📋 READ-ONLY. No collection, no webhook, no commission path, no POS transition
created or changed. Design/trace only — not BUILT, not CERTIFIED, not ANCHORED, not deployed.
**Date:** 2026-09-03 · Traces `sokonipay-collect-settlement`, `money-authority.js`, the IntaSend
STK/webhook contract, `paymentIntents`, commission authority, POS checkout paths, and the
IntaSend webhook handlers together, to answer whether a SOKONI Till/QR system can be built as a
thin layer over what already exists, or needs new infrastructure.

**Headline: almost everything needed already exists, split across two payment authorities that
have never been connected to each other.** One (`paymentIntents` → `initiateSTKPush` →
`payments/{ref}` → the IntaSend webhook → commission/receipt/notification fan-out) is mature,
live, and proven. The other (`pos-sale-commission.js` + `money-authority.js`'s rail/custody
model, the correct shape for an in-person POS sale) is complete and **unwired — nothing calls
it.** A SOKONI Till/QR sale sits exactly at the join these two were never given.

---

## 1. What already creates a payment intent, if anything?

**`functions/payment-intents.js`** — `createPaymentIntent`, the canonical, live, generalised
intent minter. Its own header states the property it exists to guarantee: *"The server derives
plan, amount, currency, merchant, reference and expiry, writes them to `paymentIntents/{ref}`,
and returns only an id."*

It dispatches by `purpose` to **`functions/payment-purposes.js`**, a registry of pricers
(`digital_download`, `event_ticket`, `service_booking`, `product_order`, `hub_registration`).
Each pricer is `async (uid, data) → {amountCents, currency, resourceType, resourceId, metadata}`
— **no pricer may read an amount from the request.** The registry's own comment: *"Adding a paid
feature = one entry here + one entitlement adapter. No change to `createPaymentIntent`, the
webhook, the reconciler or the engine."* This is a designed extension seam, already proven for
five different domains.

**A second, separate, POS-specific "intent" already exists: `functions/pos-qr.js`.** This is
strikingly close to the Till/QR proposal already:

- `generatePOSPaymentQR` — writes `posPayments/{transactionId}` (items, subtotal, tax, discount,
  total, status `pending`, `expiresAt`). The transaction id is HMAC-signed (`_sign`), and the QR
  URL is `https://mysokoni.co.ke/pay/{txnId}` — **already the opaque-token pattern proposed**:
  the QR carries no amount, no merchant, only a signed reference.
- `getPOSPaymentDetails` resolves that opaque token server-side and returns the stored, not
  client-supplied, amount.
- `initiatePOSQRPayment` supports `method:'mpesa'` (STK) or `method:'card'` — the card branch
  redirects to `https://payment.intasend.com/pay/checkout/?ref=${transactionId}`, confirming
  IntaSend is already the card rail here.

**These two intent systems do not know about each other.** `posPayments` is never written to
`paymentIntents`, and `initiateSTKPush`'s amount-authority check (§5 below) only ever looks at
`paymentIntents/{ref}` — a QR payment routed through `pos-qr.js`'s own `mpesa` branch does not go
through `initiateSTKPush` at all (it only *plans* to call an STK push; see §7 for what actually
completes it).

## 2. What collection/account does existing IntaSend collection use?

One shared **platform** IntaSend account, not a per-merchant sub-account. `initiateSTKPush` uses
a single `INTASEND_PRIVATE_KEY` secret; `pos-qr.js`'s card redirect goes to one
`payment.intasend.com` checkout, keyed only by `ref`. `mpesa-c2b.js`'s own header is explicit that
this is a deliberate, existing decision, not something to design: *"It does not choose the
collection account — `payment-config.resolveCollectionRoute()` owns that."* — confirming a
**collection-routing seam already exists** or is at least already named as the place this
decision lives, rather than something a Till system would invent.

No merchant-specific IntaSend sub-account concept was found anywhere in this trace. A "SOKONI
Till → IntaSend collection account" is therefore **one platform account**, not one per shop — the
Till identity's job is to route the *ledger entry*, not to select a different collection
destination.

## 3. Where is merchant/shop identity established?

`auth.uid → sellerUid → activeShopId → shops/{shopId}` — the canonical chain documented
independently in `docs/MERCHANT_MARKETING_AUTHORITY.md` (`createAdCampaign` section) and
consistent with every pricer in `payment-purposes.js`, which resolve `sellerUid` from the
*product's own document*, never from the client (`product_order`'s comment: *"A product whose
seller cannot be derived from its own document is not checkout-able. Reject, never fill the
gap."*). `pos-qr.js` instead identifies the merchant from `sellers/{auth.uid}` directly — a
shop-less, account-level identity, matching the `createAdCampaign` finding that shop-scoping is
inconsistent across this codebase, not something already solved everywhere.

**A SOKONI Till identity (`sokoniTillId`) does not exist anywhere today.** Every payment path
identifies a merchant by `sellerUid`/`sellerId` (or, once, `sellerUid` mis-spelled as in
`sokoni-reconcile.js`, per the retirement graph). This is a genuine gap, not a rename target.

## 4. How is amount established server-side?

Two live enforcement points, of different strengths:

- **`payment-purposes.js`** — every pricer derives the amount from Firestore, never the request.
  This is unconditional, not staged.
- **`initiateSTKPush`** — enforces `paymentIntents/{ref}`'s amount **only when a caller has
  migrated**. Read directly (`functions/index.js:6673`): `const _enforcedCategories =
  ["subscription"];` — **only subscriptions are hard-enforced today.** Every other category,
  intent present or not, is logged (`STK_NO_AUTHORITY`) but **allowed to proceed with the
  client-supplied amount** if no intent exists. This is a live, current, real hazard for any new
  caller that skips minting an intent first — including a naive Till/QR implementation.
- **`pos-qr.js`** does not touch `initiateSTKPush` or `paymentIntents` at all for its `mpesa`
  branch — it stores the STK context on `posPayments` and returns `stk_initiated` to the client,
  but (see §7) nothing in the traced code actually fires a real STK push from that branch.

## 5. What event is the authoritative "payment confirmed" event?

**A write to `payments/{ref}.status` transitioning into a successful state**, made only by the
IntaSend webhook (or, for card, `verifyIntasendPayment`'s server-side check against IntaSend's
own API — never the client's claim). `functions/payment-success.js`'s header is the clearest
single statement of this in the codebase: *"ONE trigger, fired on the canonical payment-success
transition"* — and it explicitly lists every other thing that also reacts to it, so nothing new
duplicates:

```
payments/{paymentId} transitions to success
  ├─ commissionLedger/{apiRef}       written INLINE inside the webhook (finos-utils.calculateCommission)
  ├─ onPaymentSucceeded              (payment-success.js)   → receipts/{paymentId}, notifications, auditLog
  ├─ emailOnPaymentSuccess           (email-triggers.js)    → customer email
  ├─ subAutoActivateOnPayment        (sub-engine.js)        → subscription activation
  └─ onPaymentUpdated                (redis-integrations.js)→ Redis/event-bus state
```

`posPayments/{transactionId}.status` (pos-qr.js) is a **separate status field on a separate
document** — none of the above fan-out watches it. A QR payment completed only through `pos-qr.js`
produces no receipt, no notification, no audit entry, no Redis update — it is invisible to every
consumer of "payment succeeded" that the rest of the platform already relies on.

## 6. How is webhook idempotency currently implemented?

Three independent, composed layers (again, `payment-success.js`'s own inventory, verified against
the actual code):

1. **Transition guard** — `payStatus.becameSuccessful(before, after)` fires only on the edge into
   success, not on a re-delivered COMPLETE-over-COMPLETE write.
2. **Durable claim** — `finosIdempotency/payment_success_pipeline_{paymentId}`, a transactional
   `.create()` (fails if it exists), used by both `payment-success.js` and `sub-engine.js`.
3. **Deterministic ids** — `receipts/{paymentId}`, `commissionLedger/{apiRef}` (`.set()`, not
   `.add()`), `auditLog/payment_success_{paymentId}` — even a defeat of layers 1-2 overwrites
   rather than duplicates.

Separately, the webhook handler itself (`intasendWebhook`/`webhookIntasend`) claims the
`payments/{apiRef}` COMPLETE transition inside its own transaction, reading current status first
and only proceeding if it is not already COMPLETE — the exact "duplicate webhook → already
processed, no double sale" behaviour the user asked to be verified. **Confirmed present, not
assumed.**

`pos-qr.js`'s idempotency is weaker but present: `completePOSQRPayment` checks
`data.status === 'paid'` and returns `already_paid` — a plain read-then-write inside a
transaction, not a separate durable claim doc, but sufficient given the smaller blast radius of
that (currently unwired) path.

## 7. Where does commission get frozen/calculated?

**Two parallel mechanisms, for two different sale shapes — both real, neither wrong, but not the
same code path:**

- **Online/IntaSend-webhook path**: inline inside `intasendWebhook`/`webhookIntasend`, calling
  `finos-utils.calculateCommission(db, {orderAmountCents, category, sellerId})`, written to
  `commissionLedger/{apiRef}` with `status: 'auto_collected'`. Rate is resolved **at
  confirmation time**, from the category on the payment's own `meta`.
- **POS/Till in-person sale path**: `functions/pos-sale-commission.js`'s `planSaleCommission()`
  — resolves a `RAIL` (tender type) to a `method`, classifies its custody via
  `money-authority.js`'s `classifyCustody()`, resolves the merchant's plan rate via
  `commission-config.js`'s `resolvePosRate()`, and calls `money-authority.js`'s
  `planSaleAccounting()` to produce the actual booking (merchant credit vs. liability, by
  custody). Its own header states plainly: **"STATUS: NOT INTEGRATED, NOT DEPLOYED. Nothing
  calls this."** — confirmed by grep, not assumed.

**The `RAIL` registry already distinguishes exactly the SOKONI-Till-vs-M-PESA-Till question the
user asked to keep separate:**

```js
const RAIL = {
  POS_CASH:         { method: 'cash',          surface: 'POS'  },
  POS_MPESA_STK:    { method: 'mpesa_stk',     surface: 'POS'  },   // CUSTODIAL
  POS_WALLET:       { method: 'sokoni_wallet', surface: 'POS'  },   // CUSTODIAL
  POS_STORE_CREDIT: { method: 'store_credit',  surface: 'POS'  },   // NON_CUSTODIAL
  POS_CARD:         { method: 'card',          surface: 'POS'  },
  TILL_DIRECT:      { method: 'mpesa_direct',  surface: 'TILL' },   // NON_CUSTODIAL — the merchant's OWN M-PESA Till
};
```

`TILL_DIRECT` **is** the ordinary M-PESA Till the user explicitly does not want this confused
with — its own file comment: *"TILL (direct) — NON_CUSTODIAL, paid to the merchant's own till →
liability... commission never collected [until the 07:00 gate]."* A SOKONI Till/QR rail —
IntaSend-collected, CUSTODIAL (already a recognised `money-authority.js` custody class for
`intasend` and `mpesa_stk`) — is a **new `RAIL` entry**, structurally identical in shape to
`POS_MPESA_STK`/`POS_CARD`, not a modification of `TILL_DIRECT`.

## 8. Where does custodial balance credit occur?

**Depends on sale shape — two different timings, both real:**

- **Marketplace online orders**: NOT at payment confirmation. `money-authority.js`'s own
  documentation (traced earlier this session) distinguishes the rider's delivery fee (paid on
  proof-of-delivery) from the seller's product earnings, which **settle at `completed`** — an
  escrow model. The actual credit happens later, off `orders/{orderId}` status transitions
  (`onOrderStatusChange`, already fully traced in this session's delivery-PIN work), not off the
  payment webhook directly.
- **In-person POS/Till sales** (the shape a Till/QR sale actually is): designed to be immediate,
  via `pos-sale-commission.js`'s `planSaleAccounting()` → for a CUSTODIAL rail, `booking.commission`
  is deducted and `booking.gross` minus commission is the net credit, resolved **at the sale**,
  not deferred to a delivery-style completion event. This is the correct shape for a Till/QR
  sale — there is no delivery to wait for — but it is the unwired half.

**A SOKONI Till/QR payment should settle like a POS sale (§8, second bullet), not like a
marketplace order escrow (§8, first bullet).** Conflating the two would either pay a merchant
before the money is confirmed, or hold a physical, already-complete in-person sale in an escrow
model built for delivery risk it does not have.

## 9. Where does a POS sale become PAID?

Three different "PAID" transitions exist, none of them unified:

- `pos-qr.js`'s `posPayments/{txnId}.status = 'paid'` — set by `completePOSQRPayment`, an
  **authenticated `onCall`** (`data.sellerId === auth.uid` or admin), **not a webhook**. Grep,
  repo-wide: **zero callers of `completePOSQRPayment` anywhere.** It is exported
  (`functions/index.js:12142`) and deployed, but nothing invokes it — the exact "payment confirmed
  without a verified server event" hazard the user asked to check for is present in the code
  *shape* (a seller-authenticated call, trusting a caller-supplied `mpesaRef`/`intasendRef`
  string with no verification against IntaSend), but is currently **inert** because nothing calls
  it. If a Till/QR UI were wired to call this function directly on a client-side "payment
  succeeded" signal, that hazard would go live immediately.
- `payments/{ref}.status = 'COMPLETE'` — set only by the IntaSend webhook after challenge
  verification, inside a transactional claim. This is the pattern that is actually safe and
  actually proven.
- `pos-sale-commission.js` has no PAID transition of its own — it is a pure accounting function,
  called with an already-confirmed sale; something else would need to call it once a sale is
  confirmed paid.

## 10. What existing infrastructure can the SOKONI Till reuse?

Summarised in the table below. In prose: **the intent-minting registry (`payment-purposes.js`),
the STK/webhook/challenge-verification pipeline, the exactly-once payment-success fan-out
(receipts/notifications/audit/commission), and the rail/custody commission engine — all of it.**
What does not exist is the thing that joins them for a QR-initiated, in-person, custodial-rail
sale: a `RAIL` entry, a `payment-purposes.js` pricer (or reuse of `pos-qr.js`'s existing intent
shape, migrated onto `paymentIntents`), and the call from "webhook confirms" to
`pos-sale-commission.js`'s currently-unwired accounting.

---

## Hazard checklist — evidence, not assumption

| hazard | finding |
|---|---|
| client-supplied `merchantId` | Marketplace pricers resolve `sellerUid` from the product, never the client (product_order). `pos-qr.js` resolves the seller from `auth.uid`, not the request — safe. `initiateSTKPush`'s `paymentIntents` lookup is itself the guard against a client-supplied amount, but is **only enforced for `subscription`** today — a real, live gap for any category that skips minting an intent. |
| client-supplied amount | Fully closed in `payment-purposes.js`. **Open** in `initiateSTKPush` for every non-subscription category with no intent (`STK_NO_AUTHORITY`, logged not refused). `pos-qr.js` computes the total server-side from validated items — safe on creation, but its completion path (`completePOSQRPayment`) never re-validates against anything. |
| Till number treated as M-PESA destination | Not found — `TILL_DIRECT` (the real M-PESA Till) and any prospective IntaSend-collected rail are already structurally distinct concepts in `pos-sale-commission.js`'s `RAIL` map; a new Till/QR rail would sit beside `TILL_DIRECT`, not inside it. |
| direct seller Daraja path accidentally reused | `mpesa-c2b.js` is a **separate, Paybill-account-number-keyed** reconciliation path ("Customer pays Paybill manually... `paymentIntents/{ref}` → verify → mark paid") for manual/QR-less Paybill payments — not the STK/webhook path a QR flow would use, and explicitly does not choose the collection account itself. No evidence a Till/QR design would touch this path unless deliberately built to. |
| duplicate webhook | Handled — transactional claim on `payments/{ref}`, checked-then-write, confirmed in both `intasendWebhook` and `webhookIntasend`. |
| same payment reference reused | `createPaymentIntent`'s deterministic-ref replay logic (§1) fails closed on an amount/purpose/resource mismatch rather than silently overwriting — proven pattern, reusable. |
| payment confirmed without verified server event | **Present in shape, currently inert.** `completePOSQRPayment` is an authenticated-caller `onCall`, not a webhook-verified transition, and trusts a caller-supplied `mpesaRef`/`intasendRef`. Zero current callers (confirmed by grep) — but this is exactly the shape to avoid wiring a Till/QR UI directly against. |
| commission bypass | `TILL_DIRECT`'s own documented problem ("commission never collected" until the 07:00 gate) is precisely the failure a SOKONI-collected (rather than direct-Till) rail exists to avoid — this is the user's own stated motivation, corroborated independently in the code's own comments. |
| double seller credit | The `commissionLedger/{apiRef}` / `{paymentId}` deterministic-id, transactional-claim pattern is used consistently everywhere credit-adjacent writes were traced (`onSellerPaymentCreated`, `intasendWebhook`, `payment-success.js`) — the pattern to reuse, not reinvent. |

**One duplication found, unrelated to the Till/QR question but adjacent enough to flag plainly:**
`intasendWebhook` and `webhookIntasend` (`functions/index.js:6918` and `:8028`) are two
separately-exported, near-identical Cloud Functions implementing the same challenge-verification,
B2C-payout, wallet-top-up, and `payments/{ref}` completion logic. Which one is the URL actually
registered in the IntaSend dashboard was not established here (out of scope for this trace) —
noted so a future Till/QR webhook integration does not have to guess which is authoritative
without checking.

---

## Final table

| Component | Existing authority | Reuse? | Gap |
|---|---|---|---|
| Till identity | **None.** Merchant identity today is `sellerUid` (account-level) or, inconsistently, `sellerUid`→`activeShopId`→`shops/{shopId}` | — | A `sokoniTillId` record (shop-scoped, with `intasendCollectionAccount`/`status`/`currency` fields as proposed) does not exist anywhere; net-new, but small — an identity document, not a payment mechanism |
| QR token | **`pos-qr.js`'s `generatePOSPaymentQR`** — HMAC-signed opaque `transactionId`, `https://mysokoni.co.ke/pay/{txnId}`, no amount/merchant in the token | **Yes** | None found — this already matches the proposed "opaque token resolves server-side" design almost exactly |
| Payment intent | **Two, unconnected:** `paymentIntents/{ref}` (mature, extensible registry, webhook-integrated) and `posPayments/{txnId}` (pos-qr.js's own, QR-shaped, NOT webhook-integrated) | **Yes, `paymentIntents` + a new `payment-purposes.js` entry** | The QR shape (`pos-qr.js`) and the intent authority (`paymentIntents`) have never been joined; joining them (mint a `paymentIntents` doc, keep `pos-qr.js`'s token/QR mechanics) closes both the amount-authority gap (§4) and the invisible-to-fan-out gap (§9), rather than building either system fresh |
| IntaSend collection | **One shared platform account**, `INTASEND_PRIVATE_KEY`; `payment-config.resolveCollectionRoute()` already named as the routing seam | **Yes** | No per-merchant sub-account exists or is implied to be needed — the Till identity routes the *ledger*, not the *destination* |
| Webhook | **`intasendWebhook`/`webhookIntasend`** — challenge-verified, transactionally idempotent, triggers the full receipts/notifications/audit/commission fan-out via `payments/{ref}` | **Yes** | Two near-duplicate exported functions (flagged above, out of scope to resolve here); a Till/QR sale must land on `payments/{ref}` (or extend the same fan-out) to be visible to this machinery at all |
| Amount verification | **`payment-purposes.js`** (unconditional, safe) + `initiateSTKPush`'s `paymentIntents` check (**conditional — only `subscription` is enforced today**) | **Yes, via a new pricer** | A Till/QR purpose registered in `payment-purposes.js` inherits the unconditional server-derivation; it must NOT rely on `initiateSTKPush`'s current partial enforcement alone |
| Commission | **Two parallel engines**: inline `finos-utils.calculateCommission` (webhook path, live) vs. `pos-sale-commission.js`'s `RAIL`/custody-aware `planSaleCommission` (POS-shaped, correct, **not integrated, not deployed**) | **Yes — `pos-sale-commission.js` is the correct shape, needs wiring** | Add one `RAIL` entry for the IntaSend-collected Till rail; the engine itself is complete |
| POS PAID state | **`payments/{ref}.status`** (webhook-verified, safe) vs. **`posPayments/{txnId}.status`** (caller-authenticated `onCall`, unverified, currently uncalled) | **Reuse `payments/{ref}`'s pattern**, not `posPayments`'s completion call | `completePOSQRPayment` is the wrong template to wire a UI against directly — it is exactly the "confirmed without a verified server event" shape; the webhook-driven transition is the one to extend |
| Seller settlement | **Two timings**: marketplace escrow-to-`completed` (`onOrderStatusChange`) vs. POS immediate (`money-authority.js`'s `planSaleAccounting`, via the unwired `pos-sale-commission.js`) | **Yes — the immediate/POS timing, not the escrow timing** | A Till/QR sale is an in-person sale with no delivery risk; it belongs on the immediate-settlement timing, and that engine already exists and is correct — it only needs a caller |

---

## What this trace does NOT do

Does not create a `sokoniTillId`/QR/intent/webhook/commission-path/POS-transition. Does not wire
`pos-sale-commission.js`. Does not add a `RAIL` entry. Does not resolve the
`intasendWebhook`/`webhookIntasend` duplication. Does not touch `firestore.rules`. Does not
change `initiateSTKPush`'s enforcement staging. Does not deploy. Does not touch `C:/temp/sok-r1`.

## Related

`functions/pos-qr.js`, `functions/payment-intents.js`, `functions/payment-purposes.js`,
`functions/pos-sale-commission.js`, `functions/money-authority.js`,
`functions/commission-config.js`, `functions/payment-success.js`, `functions/mpesa-c2b.js`,
`functions/manual-till-policy.js`, `functions/index.js` (`initiateSTKPush`, `intasendWebhook`,
`webhookIntasend`, `verifyIntasendPayment`) — all read directly for this trace, none modified.
`docs/MERCHANT_MARKETING_AUTHORITY.md` (independent corroboration of the shop-identity chain).
