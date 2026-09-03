# SOKONI Till → paymentIntent attachment — design (Q3 of the Till/QR gate)

**Status:** 📋 READ-ONLY / DESIGN. No code changed. `webhookIntasend` not touched, per instruction
— this only determines how the Till's payment intent should reach it, not how the webhook should
change. Q1 (`docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md`) and Q2
(`docs/SOKONI_TILL_IDENTITY_DESIGN.md`) are resolved and unaffected by this document.
**Date:** 2026-09-03

**Headline finding, and the one that shapes this whole design: `payments/{ref}.meta` — the field
`webhookIntasend` actually reads for everything except the subscription purpose — is
client-supplied today, not server-derived from the intent.** This is a real, pre-existing gap,
not something introduced by the Till design. It means the Till reference must NOT be attached the
same way `sellerUid`/`orderId` currently are, or it would inherit the same weakness. This is
stated plainly below, not glossed over, because it changes where in the existing flow the Till
can safely enter.

---

## The exact chain, traced end to end

```
createPaymentIntent (payment-intents.js)
  → dispatches by `purpose` to payment-purposes.js's PURPOSES[purpose].price(uid, data)
  → pricer returns {amountCents, currency, resourceType, resourceId, metadata, preferredRef?}
  → paymentIntents/{ref} created — ref, uid, purpose, amount, amountCents, currency,
    metadata, status:'created', expiresAt (server-authoritative, immutable via .create())

initiateSTKPush (index.js:6521)
  → reads paymentIntents/{ref} for amount + ownership (Stage 1a: logs if absent; Stage 1b:
    ENFORCED only for purpose/category === 'subscription' today)
  → does NOT read intent.metadata for anything
  → writes payments/{ref}: { ref, checkoutId, phone, amount, status:'PENDING', uid,
    intentRef: ref, meta: meta || {} }
    ── meta HERE is request.data.meta — THE CLIENT'S OWN ARGUMENT, verbatim ──
  → calls IntaSend's STK API

webhookIntasend (index.js:8028, confirmed live in Q1)
  → transactionally claims payments/{apiRef}.status = 'COMPLETE'
  → commissionLedger/{apiRef} — category from payData.meta?.category
  → wallet credit — seller resolved as payData.meta?.sellerUid || payData.uid
  → marketplace order finalisation (_finalizeMarketplacePayment, receipts, clickAndCollect,
    delivery dispatch) — ALL keyed on payData.meta (== the client-supplied meta above)
  → subscription activation — the ONE branch that reads paymentIntents/{intentRef} directly,
    for intent.purpose/planId/uid — NOT via payData.meta
```

**Confirmed by reading `initiateSTKPush`'s actual write** (`functions/index.js:6818-6826`):
`meta: meta || {}` — no merge with, no cross-check against, `paymentIntents/{ref}.metadata`.
The intent's own server-derived `metadata` (e.g. `product_order`'s `{orderId, sellerUid,
subtotal, ...}`) is minted, then **never read again** by `initiateSTKPush` or by
`webhookIntasend`'s non-subscription branches. Only the subscription purpose's fields
(`purpose`, `planId`, `uid`) are ever read back from the intent itself.

**Consequence, stated precisely, not implied:** today, for any non-subscription payment, a client
could call `initiateSTKPush` with the *server-enforced* amount but a *self-chosen* `meta.sellerUid`
or `meta.orderId`, and the webhook's wallet credit and order finalisation would use the
client-chosen value — `_finalizeMarketplacePayment`'s own multi-seller guard checks that an
order's *line items* don't disagree with each other, but does not independently verify the
`sellerUid` it's given against `orders/{orderId}`'s own recorded seller. This is a real,
already-existing hazard, unrelated to the Till design — flagged here because it directly decides
where a Till reference can safely be attached without inheriting the same weakness.

---

## Where the Till attaches — the intent/orchestration boundary, not `payments/{ref}`

Per the explicit boundary given: **the Till enters via a new `payment-purposes.js` purpose, not
by patching `payments/{ref}`.** Concretely, a new pricer (name provisional: `pos_till_sale`):

```js
pos_till_sale: {
  resourceType: 'posTillSale',
  async price(uid, data) {
    const sokoniTillId = String(data.sokoniTillId || '').trim();
    if (!sokoniTillId) fail('invalid-argument', 'sokoniTillId is required.');

    // Resolve the Till SERVER-SIDE — never trust shopId/branchId/merchantUid from the client.
    const tSnap = await db().collection('sokoniTills').doc(sokoniTillId).get();
    if (!tSnap.exists) fail('not-found', 'Till not found.');
    const till = tSnap.data();
    if (till.status !== 'ACTIVE') fail('failed-precondition', 'This Till is not accepting payments.');
    //   ^ answers "retired/disabled Till -> no new payment intent" directly.

    // Amount: server-derived from the cart/sale the cashier built, exactly like
    // product_order's validateOrderLines — NEVER from data.amount.
    const { lines, subtotal } = await validateOrderLines(uid, data.items); // or a POS-specific
                                                                            // equivalent if the
                                                                            // sale isn't a
                                                                            // marketplace cart
    const cents = Math.round(subtotal * 100);
    if (cents <= 0) fail('failed-precondition', 'Sale has no payable amount.');

    return {
      amountCents: cents,
      currency: till.currency || 'KES',
      resourceType: 'posTillSale',
      resourceId: /* the POS sale/cart id, server-generated or cashier-supplied+validated */,
      metadata: {
        sokoniTillId: till.sokoniTillId,     // server-read off the Till doc, not the request
        shopId:       till.shopId,           // ditto
        branchId:     till.branchId,         // ditto
        merchantUid:  till.merchantUid,      // ditto
        category:     'pos_till',
        items: lines,
      },
    };
  },
},
```

This is "one entry here," exactly as the registry's own header promises — no change to
`createPaymentIntent`, no new collection for the intent itself, no second payment authority.
`paymentIntents/{ref}.metadata.sokoniTillId` becomes the ONE place the Till reference is recorded
against a specific payment, written once, immutably (the collection's existing `.create()`
semantics already guarantee this — answers **"historical intent retains original Till identity"**
by construction, the same way `service_booking`'s price snapshot already does).

**Critically: `shopId`/`branchId`/`merchantUid` are read OFF THE TILL DOCUMENT inside the pricer,
never taken from `data`.** The only client input is `sokoniTillId` itself (or, for the dynamic-QR
flow, the opaque signed reference that resolves to it — see Q2's Q5). This is what makes "client
changes Till → server ignores/rejects" true by construction rather than by a check that could be
forgotten: there is no code path in this design where a client-supplied shop/branch/merchant value
is ever consulted.

## The gap this surfaces, named but not fixed here

Because `initiateSTKPush` does not read `intent.metadata` into `payments/{ref}.meta` (it only
enforces `intent.amount`), and `webhookIntasend` reads `payData.meta` for everything except
subscriptions, **a `sokoniTillId` minted safely into `paymentIntents/{ref}.metadata` today has no
proven path to reach `webhookIntasend` at all** — unless the client is trusted to copy it into the
`meta` argument it passes to `initiateSTKPush`, which is exactly the pattern already shown to be
unenforced for `sellerUid`/`orderId`.

**The correct fix — named, not implemented, per the explicit instruction not to touch
`webhookIntasend` in this slice** — is for the webhook's Till-handling logic to read
`paymentIntents/{intentRef}.metadata.sokoniTillId` directly, mirroring the ONE branch that
already does this correctly (`intent.purpose === 'subscription'` → reads `intent.planId`/`uid`
from the intent itself, never from `payData.meta`). This is a small, additive, well-precedented
change — but it is real code to an already-live function, and belongs in its own reviewed,
tested slice (Q5 or Q6 of the ordering), not bundled into this trace.

**Until that lands, a Till-initiated payment's webhook-side effects (receipt, POS signal,
commission category) would have to rely on the same client-supplied `meta` path everything else
does today** — functionally working, but carrying the same pre-existing weakness. This is worth
knowing before implementation starts, not discovered partway through it.

---

## Reconciliation controls — answered with the design, not assumed safe

| control | how this design satisfies it |
|---|---|
| **same Till + same intent → no duplicate intent** | Reuses `createPaymentIntent`'s existing deterministic-ref replay logic verbatim (Q1-preceding trace, §1) — the `pos_till_sale` pricer returns a `preferredRef` derived from the POS sale/cart identity (mirroring `product_order`'s `preferredRef: orderId`), so a retried "Show QR" tap for the *same* cart resolves to the *same* intent, with the existing same-buyer/same-purpose/same-resource/same-amount check refusing a mismatched replay rather than silently overwriting. |
| **same QR scanned twice → no duplicate financial effect** | For the **dynamic** QR (the prioritised mode): the QR encodes the intent's own opaque reference, so a second scan resolves to the identical, already-created `paymentIntents` doc — `initiateSTKPush`'s existing PENDING-reuse window (`status:'PENDING'` within the last 10 minutes → `reused:true`, no second STK push) already prevents a duplicate charge attempt. For the **permanent** Till QR: each scan is a *new* sale by design (different amount, different intent) — "duplicate" does not apply to that mode the same way, and is not a defect. |
| **client changes amount → server ignores/rejects** | The pricer derives `amountCents` from the sale's own items/total server-side, never from `data.amount` — identical discipline to every existing pricer. **Recommended, not done here:** add `'pos_till'` to `initiateSTKPush`'s `_enforcedCategories` (currently only `['subscription']`) so a client-supplied amount is *refused*, not merely logged, for this purpose — a one-line, well-precedented change belonging to implementation, not this trace. |
| **client changes Till → server ignores/rejects** | By construction (above): the pricer reads `shopId`/`branchId`/`merchantUid` off the resolved `sokoniTills/{id}` document, never off `data`. The only Till-related client input is the id/opaque-token itself, and an invalid or non-`ACTIVE` one fails the intent mint outright. |
| **payment reference replay → existing idempotency wins** | Unchanged, reused as-is: `createPaymentIntent`'s replay-with-mismatch-refusal, `initiateSTKPush`'s PENDING-reuse check, `webhookIntasend`'s transactional COMPLETE-claim (proven in Q1's evidence: it is the endpoint that actually enforces this, not the unauthenticated `intasendWebhook`). |
| **retired/disabled Till → no new payment intent** | The pricer's `till.status !== 'ACTIVE'` check runs before any amount is derived or any intent is minted — a `DISABLED`/`RETIRED` Till cannot originate a new intent, full stop. |
| **historical intent retains original Till identity** | `paymentIntents` documents are already write-once (`.create()`, never overwritten) — the Till reference embedded in `metadata` at mint time is frozen by the same mechanism that already freezes `service_booking`'s price snapshot. No special-case code needed; this is inherited for free by using the existing model correctly. |

---

## What this design does NOT do

Does not create the `pos_till_sale` (or equivalently named) pricer. Does not modify
`payment-purposes.js`, `createPaymentIntent`, `initiateSTKPush`, or `webhookIntasend` — **the
`payData.meta` vs. `paymentIntents.metadata` gap identified above is named, not fixed.** Does not
add `pos_till`/`pos_till_sale` to `initiateSTKPush`'s `_enforcedCategories`. Does not decide the
exact `resourceId`/POS-sale-id scheme (a real open question: does the cashier's cart get its own
server-side id before the QR is shown, analogous to `orderId` for `product_order`? — left for the
next slice, Q4). Does not touch `firestore.rules`. Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SOKONI_TILL_IDENTITY_DESIGN.md` (Q2 — the Till record this attaches to) ·
`docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md` (Q1 — confirms which webhook this design must
eventually reach) · `docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` (the original existing-authority trace)
· `functions/payment-purposes.js` (`product_order`, the closest existing precedent — server-side
amount derivation, single-seller guard, `preferredRef`) · `functions/payment-intents.js`
(`createPaymentIntent`'s replay/idempotency logic, reused not reinvented) · `functions/index.js`
(`initiateSTKPush:6521`, `webhookIntasend:8028` — both read, neither modified)
