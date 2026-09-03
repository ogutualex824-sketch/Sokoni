# Payment-authority defects log — found during the Till/QR gate, tracked separately

**Status:** 📋 READ-ONLY LOG. No code changed. These are findings surfaced while tracing existing
payment infrastructure for the SOKONI Till/QR programme (`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md`
onward) — logged here on their own because each affects payment paths beyond the Till, and none
should be silently fixed as a side effect of Till work, or buried where a future reader would not
find them without already knowing to look in a Till-specific document.
**Date:** 2026-09-03 · Living document — append further entries here rather than re-scattering
findings across feature-specific docs.

---

## D1 — `payments/{ref}.meta` is client-supplied; `webhookIntasend` treats it as trusted

**Found during:** Q3, `docs/SOKONI_TILL_PAYMENT_INTENT_ATTACHMENT.md`.

**The fact, checked directly against source, not inferred:** `initiateSTKPush`
(`functions/index.js:6818-6826`) writes `payments/{ref}.meta = meta || {}`, where `meta` is
`request.data.meta` — **the client's own argument to the call, verbatim.** It is never merged
with, or checked against, `paymentIntents/{ref}.metadata` — the field every pricer in
`payment-purposes.js` derives server-side specifically so a client cannot author it.

**Where this is consumed as authority:** `webhookIntasend` (confirmed the live endpoint, Q1),
for every purpose except `subscription`:
- Wallet-credit destination: `_sellerId = payData.meta?.sellerUid || payData.uid`.
- Marketplace order finalisation (`_finalizeMarketplacePayment`): `orderId`, `sellerUid`,
  `items`, `fulfillmentType`, `address` — all read from `payData.meta`.
- Commission category: `payData.meta?.category`.

**The gap:** an authenticated client can call `initiateSTKPush` with the server-enforced amount
(when an intent exists and the category happens to be enforced — see D2) but a **self-chosen**
`meta.sellerUid` / `meta.orderId` / `meta.category`. `_finalizeMarketplacePayment`'s own
multi-seller guard checks that an order's *line items* agree with each other; it does not check
that the *caller-supplied* `sellerUid` matches the order's own recorded seller. Nothing else
re-derives these values from server state before crediting a wallet or finalising an order.

**Only the subscription branch is safe today** — it reads `paymentIntents/{intentRef}.planId`/
`.purpose`/`.uid` directly, never `payData.meta`, which is exactly the pattern every other purpose
should follow and currently does not.

**Severity, stated plainly:** this can misroute a wallet credit or an order's fulfilment details
to a party the payer did not intend, for any already-live purpose that isn't subscription
(marketplace product orders, service bookings, hub registrations, digital downloads — everywhere
`initiateSTKPush` is the collection path). It is not theoretical — it is the exact mechanism the
webhook uses for every non-subscription payment in production today.

**Not fixed here.** The correct remedy — `webhookIntasend` reading `paymentIntents/{intentRef}
.metadata` instead of `payData.meta` for the fields that matter (sellerUid, orderId, category) —
is real code to an already-live, high-stakes function and needs its own reviewed, tested,
separately-certified slice. Recorded so it is decided deliberately, not discovered mid-Till-build
or left for someone to rediscover from scratch.

**Relevance to the Till programme:** this is *why* Q3 designed the Till reference to be read off
`paymentIntents.metadata` server-side rather than trusted from `payments/{ref}.meta` — the Till
design does not use the tainted path, but it also cannot rely on it being fixed; see Q3's own
"gap this surfaces" section for how the Till's own reference reaches the webhook safely once this
is addressed.

---

## D2 — `initiateSTKPush`'s amount enforcement (Stage 1b) covers only `subscription`

**Found during:** Q1-preceding trace, `docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` §4; re-confirmed in
Q3.

**The fact:** `functions/index.js:6673` — `const _enforcedCategories = ["subscription"];`. For
every other category, a missing `paymentIntents/{ref}` record is logged (`STK_NO_AUTHORITY`) and
**the client-supplied amount is accepted anyway.** This is a deliberately staged rollout (Stage
1a observes, Stage 1b enforces per-migrated-caller, per the function's own header), not an
oversight — but it means any caller that has not yet been migrated to mint an intent first can
still set its own price today.

**Not fixed here.** Migrating a new category into `_enforcedCategories` is a one-line, well
precedented change (the file's own comments describe exactly how), but it is a behaviour change
to a live function each time and belongs with whichever slice introduces that category's intent —
for the Till/QR programme, that is the `pos_till_sale` purpose's own implementation slice, not
this trace.

---

## D3 — `pos-qr.js`'s QR-to-paid chain has no working completion path, and its card branch appears
un-reconciled by the live webhook

**Found during:** Q4 (`docs/SOKONI_TILL_QR_CONTRACT.md`).

**The fact, traced client-side and server-side:**
- `pos.html` (merchant/cashier) **does** call `generatePOSPaymentQR` and render a real, scannable
  QR (via `sokoni-qr.js`'s `SokoniQR.generateCanvas`) — this half is live and reachable.
- `pay.html` (customer) **does** call `getPOSPaymentDetails` (polling, `setInterval`) and
  `initiatePOSQRPayment` — also live and reachable.
- **Nothing calls `completePOSQRPayment`.** `pos.html`'s own `complete()` handler tries
  `SPos.payment.completeQR(_txnId)` first — a method that does not exist anywhere in the
  codebase (grepped, zero definitions) — falling through to `SPos.payment.process`, unverified in
  this pass. `pay.html`'s polling loop is therefore waiting on a status transition nothing in the
  traced code ever performs.
- **The `mpesa` branch of `initiatePOSQRPayment` never calls `initiateSTKPush`** (the actual,
  IntaSend-integrated STK path) — it stores pending-STK context on `posPayments` and returns a
  message telling the customer to check their phone, with no real STK push issued from the code
  read here.
- **The `card` branch redirects to a real, hosted IntaSend checkout**
  (`https://payment.intasend.com/pay/checkout/?ref=${transactionId}`) — this one *can* move real
  money. But `webhookIntasend` (confirmed live, Q1) resolves an incoming `api_ref` against
  `payments/{apiRef}` — **not `posPayments/{transactionId}`** — and no-ops (`200 OK`, does
  nothing) when that document does not exist. A `pos-qr.js`-initiated card payment would have no
  `payments/{ref}` document at all, so a real IntaSend confirmation for it would be silently
  unreconciled: no commission entry, no wallet credit, no order, no receipt — while the money has
  actually moved.

**Severity:** the QR-generation and initiation halves of this feature are reachable from real,
linked pages today; the completion half is not wired at all, and the one sub-path that can move
real money (card) appears to have no reconciliation path to the confirmed-live webhook. Whether
this has ever been exercised by a real merchant/customer was not checked in this pass (would
require its own Cloud Logging query, analogous to Q1's) — flagged as unverified, not asserted
either way.

**Not fixed here.** This is exactly why the Till/QR design (Q1-Q4) reuses `pos-qr.js`'s
opaque-token/QR-rendering *mechanism* only, and routes the actual payment through
`paymentIntents` → `initiateSTKPush` → `payments/{ref}` → `webhookIntasend` — the proven chain —
rather than through `pos-qr.js`'s own `posPayments`/`completePOSQRPayment` path. This entry
records the reason as a first-class fact, not an implied inference a future reader would have to
re-derive.

---

## What this log does NOT do

Does not fix D1, D2, or D3. Does not touch `webhookIntasend`, `initiateSTKPush`, `pos-qr.js`,
`pay.html`, or `pos.html`. Does not quantify real-world exposure (no Cloud Logging query run
against `posPayments`/`pos-qr.js`'s Cloud Run traffic in this pass). Not deployed. Does not touch
`C:/temp/sok-r1`.

## Related

`docs/SOKONI_TILL_PAYMENT_INTENT_ATTACHMENT.md` (Q3, where D1/D2 were first surfaced) ·
`docs/SOKONI_TILL_QR_CONTRACT.md` (Q4, where D3 was surfaced) ·
`docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md` (Q1, establishes `webhookIntasend` as the
live endpoint these defects are measured against)
