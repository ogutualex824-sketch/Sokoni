# SOKONI Till/QR — QR contract design (Q4 of the Till/QR gate)

**Status:** 📋 READ-ONLY / DESIGN. No code changed. No QR generated, no page built. Q1-Q3
resolved and unaffected. Surfaces one new payment-authority finding, logged separately in
`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` (D3), not fixed here.
**Date:** 2026-09-03 · Establishes the QR contract two products (permanent Till QR, dynamic POS
QR) must both satisfy, before either is built.

---

## What already exists — traced, not assumed

**The signing/token mechanism (`functions/pos-qr.js`):** `_txnId()` (16 random bytes, hex) +
`_sign()` (HMAC-SHA256 over the id, truncated to 16 hex chars, keyed by `QR_SIGNING_SECRET`) +
`crypto.timingSafeEqual` verification. The QR encodes **only** this opaque, signed reference —
confirmed by reading `generatePOSPaymentQR`'s actual Firestore write: `items`, `subtotal`,
`total`, `sellerId` etc. are all server-side, keyed by the id; none of it is IN the QR string
itself. This is the exact property the user asked to be preserved, and it already is, in the one
piece of `pos-qr.js` this design reuses.

**The QR rendering (`sokoni-qr.js`, not the third-party `qrcodejs` library — SOKONI's own,
first-party equivalent):** `window.SokoniQR` — a self-contained, dependency-free QR encoder
(Reed-Solomon/Galois-Field, versions 1-10, EC levels L/M), already at "v2.0" per its own header,
meaning it has iterated and matured. Relevant surface: `generateCanvas(url, size)` → a `<canvas>`
element (used by `pos.html`), `renderTo(el, type, id, options)`, `buildUrl(type, id, base)`, and
notably `scan(videoEl, onDetect)` — a **scanner**, not just an encoder, which was not otherwise
traced in this pass but is worth knowing exists if a future in-app scan flow is ever wanted.

**The route:** `firebase.json:124-125` — `/pay/**` → `/pay.html`, already configured, already
live (confirmed: `pay.html` exists, 1042 lines, and calls `getPOSPaymentDetails`/
`initiatePOSQRPayment` against `pos-qr.js`'s live callables).

**What does NOT already work — the new finding this trace surfaces:** traced client-side
(`pos.html`, `pay.html`) as well as server-side. Full detail is logged as **D3** in
`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md`: `pay.html` polls `getPOSPaymentDetails` for a `'paid'`
status that nothing ever sets (`completePOSQRPayment` has zero callers — `pos.html`'s own
`complete()` tries a client method, `SPos.payment.completeQR`, that does not exist anywhere in
the codebase); the `mpesa` branch never calls the real, proven `initiateSTKPush`; the `card`
branch reaches a real IntaSend checkout whose confirmation would land on an `api_ref` that
`webhookIntasend` cannot resolve (`payments/{apiRef}` does not exist for a `posPayments`-only
transaction), so it would no-op silently.

**Conclusion carried into this design:** reuse the token/signing mechanism and the QR-rendering
component. Do not reuse `posPayments`, `completePOSQRPayment`, `pay.html`'s current polling
target, or `pos.html`'s current completion call — all of that is the broken half.

---

## Two products, one shared resolution shape

```
QR (either product)
  → opaque, HMAC-signed reference (pos-qr.js's exact _txnId()/_sign() shape)
  → https://mysokoni.co.ke/pay/q/{signedRef}          (NEW path segment — see "canonical page" below)
  → server: verify signature (timingSafeEqual, same as pos-qr.js)
  → server: resolve what the reference POINTS TO — a Till (permanent) or a paymentIntent (dynamic)
  → server: re-check status/validity AT RESOLUTION TIME, not just at mint time
  → server: derive merchant identity + amount from what was resolved, NEVER from the URL
```

### Product 1 — Permanent Till QR

```
sokoniTills/{sokoniTillId}   (Q2)
  → mint ONE signed reference at Till creation, HMAC over sokoniTillId (pos-qr.js's _sign()
    shape, new keyspace/purpose string so it can never collide with or be confused for a
    dynamic-intent signature — see "replay" below)
  → printed once, reused for every sale at that counter
  → resolves to: sokoniTills/{id} directly
  → the amount is NOT in the token — the buyer enters it on the payment page, which then mints
    a paymentIntent via the pos_till_sale purpose (Q3), with the Till already resolved and
    validated server-side before the amount is even asked for
```

### Product 2 — Dynamic POS QR (prioritised)

```
POS cart total confirmed by cashier
  → server creates the paymentIntent FIRST (pos_till_sale purpose, Q3) — amount, Till, shop,
    branch all resolved and frozen server-side at this point, before any QR exists
  → QR encodes a signed reference to THAT INTENT'S id (paymentIntents/{ref}), not to the Till
    directly and not to a NEW posPayments-style document
  → resolves to: paymentIntents/{ref} — the buyer's payment page reads amount/shop/status from
    the intent, exactly as the existing subscription/checkout flows already do
```

**Why the dynamic QR points at the intent, not a new intermediate document:** the explicit
boundary from Q3 — the Till enters at the intent/orchestration layer, not by inventing a second
record between the QR and the intent. A `posPayments`-shaped intermediate document is exactly
what made `pos-qr.js`'s own chain disconnect from the real payment authority (D3). Pointing the
QR straight at the already-authoritative `paymentIntents/{ref}` removes that seam entirely.

---

## The ten questions

### 1. What exact token format should be reused from `pos-qr.js`?

The **id + HMAC-signature pair and verification method** — `crypto.randomBytes(16).toString
('hex')` for the id, `crypto.createHmac('sha256', secret).update(id).digest('hex').slice(0,16)`
for the signature, compared with `crypto.timingSafeEqual`. Not the collection it's stored on, not
the `posPayments` schema, not `completePOSQRPayment`. Two independent signing contexts are
needed — permanent-Till references and dynamic-intent references must not be interchangeable
(a captured/leaked dynamic-intent QR must not resolve as if it were a Till reference, or vice
versa) — achieved by including a type discriminator in the signed payload (e.g. signing
`'till:' + sokoniTillId` vs. `'intent:' + ref`) rather than two separate secrets, which is the
same technique `_hash()` functions elsewhere in this codebase already use to bind a signature to
its specific purpose (e.g. `delivery-pin.js`'s HMAC binds the PIN to the specific delivery
reference for the identical reason).

### 2. Where does the permanent QR resolve?

To `sokoniTills/{sokoniTillId}` directly, server-side, after signature verification — never to
an amount or a specific sale. The payment page then prompts for an amount and mints a *new*
`paymentIntents` document (via `pos_till_sale`) for that specific transaction. The Till reference
itself never expires or gets consumed by a scan (see Q5) — it is a durable pointer, re-resolved
fresh on every scan.

### 3. How does a dynamic QR bind to `paymentIntentId`?

The QR's signed payload directly encodes the `paymentIntents/{ref}` id (post-verification) — the
binding is 1:1 and immediate, no separate lookup table. This is the same shape `pos-qr.js`
already uses for `transactionId` → `posPayments/{transactionId}`, just repointed at the
authoritative collection.

### 4. Can a QR be replayed?

**Permanent Till QR:** yes, by design — it is meant to be scanned repeatedly, forever (until the
Till is disabled/retired, Q6). Each scan is a fresh resolution to the same, unchanging Till
record; nothing about the Till reference itself is single-use.

**Dynamic intent QR:** the reference is only ever useful while the underlying `paymentIntents`
document is in a payable state. `createPaymentIntent`'s own `expiresAt` (15-minute TTL, already
proven) and its idempotent-replay logic (same buyer/purpose/resource/amount → same intent
returned; a mismatch refused) already answer this without new code: a replayed scan of the same
dynamic QR within the TTL resolves to the SAME intent, is safe, and does not create a second
payable record. A replay after the intent has reached a terminal state (`paid`, `cancelled`,
`expired`) must fail closed — resolving a terminal intent's QR should show "this payment is no
longer available," not silently re-offer payment.

### 5. What happens after expiration?

For the dynamic intent QR: the intent's own `expiresAt` already governs this — a scan after
expiry resolves the intent, sees it is expired (or `createPaymentIntent`'s TTL has lapsed and the
document reflects that), and the payment page shows an explicit expired state, matching how
`getPOSPaymentDetails` already handles `pos-qr.js`'s own expiry today (the one part of that flow
that *does* work correctly: `if (data.expiresAt.toMillis() < Date.now())` → explicit `expired`
status, not a silent failure). **No new expiry mechanism is needed** — this inherits directly
from the existing intent TTL.

For the permanent Till QR: it has no expiry of its own (Q2) — only its `status` gates it (Q6).

### 6. What happens if the Till becomes DISABLED/RETIRED?

**Checked at resolution time, not just at QR-print time — this is the one place a stale cached
resolution would be dangerous.** For the permanent QR: every scan re-reads
`sokoniTills/{id}.status`; a non-`ACTIVE` Till fails the resolution outright, before any amount
prompt or intent creation, with an explicit "this till is not accepting payments" state — never a
silent fallback. For the dynamic QR: the `pos_till_sale` pricer already checks Till status *at
intent-mint time* (Q3) — a Till disabled between mint and scan does not retroactively invalidate
an already-created, still-valid intent (the intent is the financial authority once minted, per
the critical invariant), but no *new* intent can be minted against a disabled Till from that point
forward.

### 7. Can a customer alter the amount through the URL/query?

**No — there is no amount anywhere in the QR or its resolved URL for either product.** For the
dynamic QR, the amount lives only on the already-minted `paymentIntents/{ref}` document, read
server-side by the payment page; nothing in the URL carries it. For the permanent QR, the amount
does not exist yet at scan time — it is supplied by the buyer *after* resolution and immediately
becomes the input to a NEW server-minted intent (`pos_till_sale`), not a value trusted back from
the browser for anything downstream — the buyer's typed number never itself becomes an
authoritative field; it is the seed for a fresh, server-validated intent creation, subject to the
exact same `MIN_KES`/`MAX_KES` bounds every other purpose in the registry already enforces.

### 8. Does scanning the same QR twice create two intents or reuse one?

**Permanent QR:** by design, each scan is a *new* transaction (a different sale each time) — this
is not "duplication," it is the product working as intended. Each scan → a fresh amount prompt →
a fresh `pos_till_sale` intent.

**Dynamic QR:** reuses the same intent — this is the whole point of minting the intent *before*
generating the QR (§ two products, above). Answered concretely in Q4: `createPaymentIntent`'s
deterministic-ref idempotent-replay logic already guarantees this without new code, provided the
`pos_till_sale` pricer supplies a `preferredRef` tied to the POS sale/cart identity (as Q3
specified) rather than minting a fresh random ref on every call.

### 9. Which page is the canonical payment UI?

**A page reached via `/pay/q/**`, resolving BOTH products through the shared resolution shape
above — not `pay.html` as it stands today.** `pay.html`'s route (`/pay/**`) and its
`getPOSPaymentDetails`/`initiatePOSQRPayment` calls are wired to `posPayments`, the broken half
(D3). Two options, not decided here: (a) a new page/route (`/pay/q/**` as sketched, or reusing
the `/pay/**` prefix with a path segment that disambiguates the new resolution target), or (b)
rewriting `pay.html`'s data layer to call `paymentIntents`/Till-aware endpoints instead of
`pos-qr.js`'s. Either way, the canonical page must call **new** resolution endpoints built for
this contract — reusing `pay.html`'s existing UI shell (states, polling loop *pattern*, timer) is
reasonable; reusing its current backend calls is not, per D3.

### 10. Does the POS receive the resulting verified payment event without a second payment authority?

**Yes, if the webhook read-path fix named in Q3 lands** (`webhookIntasend` reading
`paymentIntents/{intentRef}.metadata` instead of `payData.meta`) — the POS-facing "payment
received" signal should come from the SAME `payments/{ref}` → `webhookIntasend` → fan-out chain
every other purpose already uses (receipts, notifications — `payment-success.js`'s existing,
proven, exactly-once machinery), with the cashier's screen listening on a Firestore field the
webhook/fan-out already writes (e.g. a notification, or a direct listener on the intent/payment
document's status) — **not** a second, POS-specific completion callable the way
`completePOSQRPayment` is today. This is the direct answer to "no second payment authority": the
POS's UI is a *reader* of the existing authoritative transition, never a second writer of it.

---

## What this design does NOT do

Does not build `pay.html`'s replacement, the `/pay/q/**` route, or any resolution endpoint. Does
not implement the `pos_till_sale` purpose (Q3 remains design-only). Does not fix D1/D2/D3
(`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md`) — D3 is newly logged here, not remedied. Does not touch
`pos-qr.js`, `pay.html`, `pos.html`, `sokoni-qr.js`, or `firebase.json`. Does not decide between
option (a)/(b) for the canonical page (Q9). Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SOKONI_TILL_IDENTITY_DESIGN.md` (Q2) · `docs/SOKONI_TILL_PAYMENT_INTENT_ATTACHMENT.md` (Q3)
· `docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` (D1-D3, the standalone defect log this trace adds to) ·
`functions/pos-qr.js` (signing mechanism reused; `posPayments`/`completePOSQRPayment` explicitly
not reused) · `sokoni-qr.js` (QR rendering, reused as-is) · `pay.html`, `pos.html` (read for their
current wiring; neither modified) · `firebase.json:124-125` (the existing `/pay/**` rewrite)
