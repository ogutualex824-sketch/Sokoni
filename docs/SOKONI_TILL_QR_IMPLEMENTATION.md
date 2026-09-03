# SOKONI Till/QR — Q5 implementation and certification

**Status:** 🟢 **BUILT · CERTIFIED (pure core, 60/60) · COMMITTED · STACKED. NOT ON R1
(`C:/temp/sok-r1` remains dirty). NOT DEPLOYED.** Production remains `d592d8f`/v632,
untouched. This is the first slice in the Till/QR programme that is real code, not design —
Q1-Q4 (`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` onward) are unaffected and unmodified.
**Date:** 2026-09-03

**Scope actually built:** the QR/Till authority layer — token minting/verification, Till
identity issuance and lifecycle, dynamic-QR minting against an already-created payment
intent, and server-side QR resolution. **Does not** build the buyer-facing payment page,
the `/pay/q/**` route, or a merchant-facing Till-management UI — see "Deliberately deferred"
below for why, and where that work belongs.

---

## What was built

| File | What |
|---|---|
| `functions/sokoni-qr-authority.js` (new) | Pure decision core — no Firestore, no `firebase-admin`, no Cloud Functions framework. `mintToken`/`verifyToken` (HMAC-signed opaque references), `deriveShopCode`/`formatTillId` (Till identity), `checkTillPayable` (status gate), `classifyIntentResolution` (dynamic-intent resolution state), `priceTillSale` (the `pos_till_sale` pricing/authorization decision). |
| `functions/sokoni-till.js` (new) | The Cloud Functions (onCall) layer — I/O only. `mintSokoniTill`, `setSokoniTillStatus`, `mintDynamicSokoniQR`, `resolveSokoniQR`. Every decision is delegated to `sokoni-qr-authority.js`; this file reads/writes Firestore and translates the pure core's plain `{code, message}` errors into `HttpsError`. |
| `functions/payment-purposes.js` | **One additive entry**, `pos_till_sale`, inserted before `hub_registration`. Loads the Till document, delegates the pricing/authorization decision to `sokoni-qr-authority.js`'s `priceTillSale`, translates its errors via the file's own `fail()`. No existing entry touched. |
| `functions/index.js` | Four new exports (`mintSokoniTill`, `setSokoniTillStatus`, `mintDynamicSokoniQR`, `resolveSokoniQR`), added the same way `pos-qr.js`'s exports already are — no existing export touched. |
| `firestore.rules` | New `sokoniTills/{sokoniTillId}` (owner/admin read-own, `write: if false` — issuance and status transitions are Cloud-Functions-only, matching the `SEC-F1` pattern already used for `sellerPayments`) and `shopTillCounters/{shopId}` (`read, write: if false` — not client-facing, mirrors the existing `/_counters/{counterId}` rationale). No existing rule touched. |
| `scripts/test-sokoni-qr-payment.js` (new) | Certification suite for the pure core — see below. |

**Confirmed untouched, as instructed:** `webhookIntasend`, `initiateSTKPush`, `payment-intents.js` (`createPaymentIntent` itself), any commission or settlement logic, `pos-qr.js`, `pay.html`, `pos.html`. The only way a `pos_till_sale` payment intent comes into existence is a client calling the existing, unmodified `createPaymentIntent` with `{purpose: 'pos_till_sale', ...}` — exactly the "one entry here" extensibility `payment-purposes.js`'s own header describes, reused rather than bypassed.

---

## How the two products actually work, end to end

**Permanent Till QR:**
1. Seller calls `mintSokoniTill({branchId?})` — transactional issuance (see "Till issuance" below), returns `{sokoniTillId, token, qrUrl}`. `qrUrl` = `https://mysokoni.co.ke/pay/q/{token}`; a merchant-facing page can render it into an actual QR image with `sokoni-qr.js`'s existing `SokoniQR.generateCanvas(qrUrl, size)` — unmodified, not rebuilt here.
2. A buyer scans it, an (unbuilt — see below) payment page calls `resolveSokoniQR({token})`. Server verifies the signature, resolves `sokoniTills/{id}`, checks `status === 'ACTIVE'`, returns `{type:'till', sokoniTillId, shopName, currency}` — **no amount**.
3. The buyer types an amount. The page calls the **existing, unmodified** `createPaymentIntent({purpose:'pos_till_sale', sokoniTillId, amount})`. `pos_till_sale`'s pricer re-resolves the Till server-side (re-checking `ACTIVE` at this later moment too), derives `amountCents` from the buyer's own number (bounded `MIN_KES..MAX_KES`, the same bound every other purpose already enforces), and returns an intent whose `metadata.shopId`/`merchantUid`/`branchId` are read **only** from the Till document.
4. The page then calls **existing, unmodified** `initiateSTKPush`/the payment flow with the returned `ref`, exactly like every other purpose today.

**Dynamic POS QR:**
1. Cashier (authenticated as the shop's own `merchantUid`) confirms a cart on the POS terminal, calls the **existing, unmodified** `createPaymentIntent({purpose:'pos_till_sale', sokoniTillId, items, saleId})`. `saleId` is a client-generated idempotency key for the cart (not commercial data — see "Idempotency" below).
2. Cashier's terminal calls the **new** `mintDynamicSokoniQR({ref})` — verifies the intent exists, has `purpose:'pos_till_sale'`, is still `created` and not expired, and that the caller is the intent's own `merchantUid`. Mints `token = mintToken('intent', ref, secret)`, returns `qrUrl`.
3. Buyer scans it, the payment page calls `resolveSokoniQR({token})` — resolves straight to the already-existing `paymentIntents/{ref}`, returns `{type:'intent', ref, amount, currency, shopName, expiresAt}` read entirely from the intent. **No new intent is created by the scan** — `resolveSokoniQR` never writes anything.
4. Buyer pays via the same, existing STK/payment flow against that `ref`.

---

## Deviations from the Q1-Q4 pseudocode, and why

- **Shop code collision fix.** Q2's example (`SK-KASS-0001`) derives the human-readable code
  from the shop name alone. Because `sokoniTillId` is a Firestore document id shared across
  the whole platform, two differently-owned shops with similar names (e.g. two "Kass Traders")
  would collide. `deriveShopCode` appends a 4-character suffix derived from the shop's own
  `uid`, so the code stays human-plausible while a collision now requires a matching uid
  suffix, not just a matching name. `mintSokoniTill`'s transaction still uses `tx.create()`
  (fails closed with `ALREADY_EXISTS`, surfaced as a retryable error) as defense in depth.
- **`pos_till_sale` is dual-mode**, not the single `items`-only shape Q3's pseudocode sketched.
  Q4's own Q7 answer already anticipated this ("the buyer's typed number... is the seed for a
  fresh, server-validated intent creation") — a permanent-Till buyer has no cart to validate
  against, unlike a POS cashier's confirmed cart. The pricer therefore branches: `items`
  present → cashier/dynamic flow, requires `callerUid === till.merchantUid`; `amount` present
  (no items) → buyer-entered/permanent flow, open to any authenticated buyer, bounded only by
  `MIN_KES`/`MAX_KES`. Which fields the metadata is drawn from never changes between the two
  modes — always the resolved `till`, never `data`.
- **The buyer must be authenticated (`request.auth` required) for both products.** This is not
  a Q5-specific restriction — `createPaymentIntent` already requires auth for every existing
  purpose, and `resolveSokoniQR` matches that platform-wide convention rather than inventing an
  anonymous-payment path, which would be materially larger scope than "the QR layer."
- **Idempotency key (`saleId`) added**, not present in Q3's pseudocode. Without it, a cashier's
  accidental double-tap of "Generate QR" would mint two separate intents for the same cart
  (`createPaymentIntent` has no ref to deduplicate against without a `preferredRef`). `saleId`
  is a client-generated, non-commercial string (a cart/session id); the pricer turns it into
  `preferredRef = POSTILL-{sokoniTillId}-{saleId}`, so a retried call with the same `saleId`
  resolves to the identical intent via `createPaymentIntent`'s own, unmodified, already-proven
  replay-with-mismatch-refusal logic. Omitting `saleId` still works (a fresh ref is minted) but
  loses the double-tap guarantee — documented as a requirement for whichever POS UI slice
  calls this next.
- **Token signature widened to 128 bits** (32 hex chars) rather than `pos-qr.js`'s 64 bits (16
  hex chars) — same HMAC-SHA256 + `timingSafeEqual` mechanism, wider margin, because this slice
  was explicitly asked to certify forgery-resistance rather than only unguessability.

---

## Deliberately deferred — not missing, not forgotten

- **The buyer-facing payment page and the `/pay/q/**` route.** Building it now would either (a)
  duplicate `pay.html`'s UI shell prematurely, or (b) go live pointing at a payment flow whose
  webhook-side confirmation still depends on **D1** (`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md`) —
  `webhookIntasend` still reads `payments/{ref}.meta` (client-supplied) rather than
  `paymentIntents/{ref}.metadata` (server-derived) for everything except `subscription`. A
  `pos_till_sale` payment today would need the client to correctly echo `sokoniTillId` etc. into
  `initiateSTKPush`'s `meta` argument for the webhook to act on it correctly — functionally
  works, but inherits D1's exact weakness. Per the user's own suggested ordering, the webhook
  read-path fix belongs with Q6 ("verified IntaSend webhook binding"); the payment page belongs
  right after it, so it is built against a webhook that is actually safe for this purpose,
  not before.
- **Merchant-facing Till management / QR-image rendering UI.** `mintSokoniTill` and
  `mintDynamicSokoniQR` both return a `qrUrl` ready to be rendered by `sokoni-qr.js`'s existing,
  unmodified `SokoniQR.generateCanvas(qrUrl, size)` — the same call `pos.html` already makes for
  the (broken, D3) legacy flow. Building that screen is UI work belonging with the POS
  integration step (the user's suggested Q7), not the authority layer this slice certifies.
- **Employee-vs-owner authority.** `callerUid === till.merchantUid` is the only authorization
  check for dynamic-QR/cart sales — deliberately matching the existing simplification
  `pos-qr.js`'s `generatePOSPaymentQR` already uses (`auth.uid` treated as the seller). A
  proper employee-authority model is a separate, already-open workstream in this project
  (`project_employee_attribution_audit` in memory) and out of scope here.

---

## Certification — `scripts/test-sokoni-qr-payment.js`

**Method:** the same pure-core methodology `scripts/test-money-authority.js` already uses for
`functions/money-authority.js` — no Firestore, no emulator, no network. The Cloud Functions
layer (`sokoni-till.js`) is I/O only around the pure core, so certifying the core certifies
every decision that matters; the I/O layer's job is limited to "read the right document, call
the core, write what it returns," mirrored 1:1 against what is tested.

**Result: 60/60 real assertions passed.** Plus:
- a **negative control** (`1 === 2`) that correctly failed and was verified to have incremented
  the failure counter, proving the harness itself can detect a failure;
- a **sabotage control**: a temporary, deliberately-weakened copy of `sokoni-qr-authority.js`
  had its one `callerUid !== till.merchantUid` authorization line stripped out via a regex
  the setup asserts actually matched (the run aborts loudly if it doesn't, rather than passing
  vacuously against unmodified sabotage). The SAME "non-operator tries to price a cart sale"
  attack that the real module correctly denies (`permission-denied`) was proven to be **wrongly
  allowed** by the sabotaged copy — confirming this specific assertion would have caught the
  vulnerability had it existed, not merely that it agrees with correct code today.

Coverage against the user's certification list, mapped explicitly:

| requirement | where certified |
|---|---|
| valid permanent QR → resolves correct Till | token round-trip (§1) + `checkTillPayable` ACTIVE case (§4). Firestore lookup itself is untested here (pure core has no Firestore) — the I/O wrapper mirrors the logic 1:1. |
| foreign/forged token → denied | §2 — wrong secret, hand-forged signature, type-confusion, all malformed shapes. |
| disabled Till → denied | §4. |
| retired Till → denied | §4. |
| dynamic QR → resolves exact intent | token round-trip (§1) + `classifyIntentResolution` "created, not expired" case (§5). |
| client-altered amount → ignored/rejected | §6 — a client-sent `amount`/`total` alongside a cashier cart is ignored; a buyer-entered amount is bounded and validated. |
| client-altered merchant → ignored/rejected | §6 — hostile `shopId`/`merchantUid`/`branchId`/`sokoniTillId` in the request body are all proven ignored; a non-operator caller is proven denied; re-certified adversarially by the sabotage control. |
| expired token → denied | Tokens themselves never expire (by design — Q4 Q5: a permanent Till reference is durable, a dynamic reference's validity is entirely inherited from the underlying intent's own TTL, no new expiry mechanism). What "expires" is the **intent** a dynamic token points to — certified in §5 ("expired (by timestamp, still status=created) intent is refused"). |
| malformed token → denied | §2 — wrong segment count, illegal characters, bad signature length, oversized string, non-string, empty string. |
| replay → deterministic/no duplicate financial object | §3 (token minting/verification is deterministic, not random) + §6 (same `saleId` → identical `preferredRef`/`resourceId`; a different `saleId` never collides). The actual "no duplicate `paymentIntents` document" guarantee is `createPaymentIntent`'s own, unmodified, already-proven replay-with-mismatch-refusal logic (`docs/SOKONI_TILL_PAYMENT_INTENT_ATTACHMENT.md`) — reused verbatim, not re-tested here since that would require Firestore. |
| QR contains only the intended opaque payload | §2b — the minted token is proven to be exactly `type.id.signature`, nothing appended; `mintToken`'s own signature takes no parameter through which business data (amount, shop name, merchantUid) could enter it. |

---

## What this slice does NOT do

Does not fix D1, D2, or D3 (`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md`) — all three remain open,
unrelated to this code. Does not modify `webhookIntasend`, `initiateSTKPush`,
`payment-intents.js`, `pos-qr.js`, `pay.html`, or `pos.html`. Does not build the buyer-facing
payment page, the `/pay/q/**` `firebase.json` rewrite, or any merchant-facing Till UI. Does not
run against a live Firestore/emulator — certification is of the pure decision core only, per the
methodology this codebase already uses for money-adjacent modules. Not deployed. Does not touch
`C:/temp/sok-r1`.

## Related

`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` · `docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md` (Q1) ·
`docs/SOKONI_TILL_IDENTITY_DESIGN.md` (Q2) ·
`docs/SOKONI_TILL_PAYMENT_INTENT_ATTACHMENT.md` (Q3) · `docs/SOKONI_TILL_QR_CONTRACT.md` (Q4) ·
`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` (D1-D3, unchanged by this slice) ·
`functions/sokoni-qr-authority.js`, `functions/sokoni-till.js` (this slice's new code) ·
`functions/payment-purposes.js` (`pos_till_sale`, this slice's one additive entry) ·
`scripts/test-sokoni-qr-payment.js` (certification, 60/60 + negative + sabotage controls)
