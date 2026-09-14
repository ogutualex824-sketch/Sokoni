# P3-A Census — IntaSend POS QR Webhook Association

**Date:** 2026-09-14 · **Branch:** `release/multishop-checkout-certified` · **Base:** `d2e1c40`
**Status:** READ-ONLY census. **No webhook modified. Nothing deployed. No implementation begun.**

Related: [[P3A_POS_QR_WEBHOOK_ASSOCIATION]] · [[project_two_intasend_webhooks_diverge]] ·
[[project_pos_payment_authority]] · [[Payments]] · [[SmartPOS]]

---

## 1. There are three inbound IntaSend handlers, not two

| Handler | Lines | Size | Production callbacks (180 d) |
|---|---|---:|---|
| `verifyIntasendPayment` | `index.js:2677–3065` | 389 | **none ever logged** |
| `intasendWebhook` | `index.js:6545–6804` | 260 | **none ever logged** |
| `webhookIntasend` | `index.js:7655–8435` | **781** | **all of them** — most recent 2026-09-14 |

> **The census's decisive finding.** The deferred record asked "which one actually receives
> production callbacks. Do not assume the two behave alike; they demonstrably do not." Measured
> against 180 days of Cloud Logging on the `raw payload` line each handler logs before parsing:
> **`webhookIntasend` receives every callback; `intasendWebhook` has never received one.**
>
> This collapses the change surface from two divergent handlers to **one**, and it means the
> 260-line handler is dead weight that a future gate should retire rather than keep in sync.

`financial-os.js:234` also parses `api_ref`, on its own `payments/{apiRef}` path. Out of scope
here, but it is a fourth reader of the same identifier and should not be forgotten.

---

## 2. `api_ref` handling — identical in both webhooks

```js
const invoice    = req.body?.invoice || {};
const state      = String(invoice.state || req.body?.state || "FAILED").toUpperCase();
const apiRef     = invoice.api_ref    || req.body?.api_ref;
const checkoutId = invoice.id         || req.body?.invoice_id;
const trackingId = req.body?.tracking_id || invoice.tracking_id || req.body?.file_id || …;
const amount     = Number(invoice.net_amount || invoice.amount || … || 0);
```

Authentication is a **body `challenge`**, not a header HMAC, normalised through HMAC-SHA256 so
`timingSafeEqual` always receives equal-length buffers. A callback that fails the challenge is
`401`ed before any parsing. **This is the trust boundary, and it is already correct.**

### Dispatch order, as it actually runs

```
challenge check ─► 401 on mismatch
      ↓
B2C payout   (pout_…, by api_ref OR invoice id OR tracking_id) ─► 200, return
      ↓
missing api_ref ─► 400
      ↓
wallet top-up (wtop_… prefix)                                  ─► 200, return
      ↓
payments/{apiRef}.get()
      ↓
  ┌── NOT FOUND ──► 200 OK, DROPPED          ← QR sales land here.  THE SEAM.
  └── FOUND ─────► status COMPLETE? ─► 200, return  (idempotency)
                        ↓
                   transaction claim ─► orders, commission, wallet, receipts,
                                        deliveries, bookings, subscriptions…
```

---

## 3. The insertion point, and why it is the smallest safe one

**`functions/index.js:7733`** (and its twin `6615`):

```js
const payRef = db.collection("payments").doc(apiRef);
const snap   = await payRef.get();
if (!snap.exists) { res.status(200).send("OK"); return; }   // ← here
```

Association belongs **after** the `payments/{apiRef}` miss, never before it. That ordering is the
entire safety argument:

* an online payment **exists** → handled exactly as today; the certified path is never entered
  differently, never delayed, never re-ordered. **Zero behavioural change to the online rail.**
* an online payment is **absent** → the callback is currently discarded. Anything added here
  operates on a path whose present behaviour is *doing nothing*, so it cannot regress a
  behaviour that does not exist.

There is a **precedent for exactly this shape in the same function**: `_finalizeWalletTopUp(apiRef,
state, amount, tag)` returns `true` if it claimed the ref and `false` otherwise, and the caller
returns early. A POS association function should be written to the same contract and placed in
the same chain.

### The QR id has no prefix — and that is fine

`wtop_` and `pout_` are discriminated by prefix. A QR `transactionId` is
`crypto.randomBytes(16).toString('hex')` — **32 lowercase hex characters, no prefix**
(`pos-qr.js:80`). So the discriminator cannot be a prefix; it must be *the existence of a
server-created `posPayments/{apiRef}` document*, which is the association itself.

A `/^[0-9a-f]{32}$/` pre-filter is worth having anyway, not for speed but as a **safety
property**: it makes it structurally impossible for a `pout_…` or `wtop_…` ref to enter the POS
path even if the ordering above were ever changed.

---

## 4. The anchor exists and is already verified end to end

| Step | Where | Evidence |
|---|---|---|
| QR created, `posPayments/{txnId}` written server-side | `pos-qr.js:176` | `sellerId: auth.uid`, `status:'pending'`, `total` from validated items |
| Single-flight reservation `paymentAttempts/{txnId}` | `pos-qr.js:368` | atomic `create()`; `RESERVED` → `GATEWAY_ACCEPTED` |
| `api_ref` set to the transactionId | `pos-qr.js:413` | `apiRef: transactionId` |
| Gateway payload carries it | `shared/stk-gateway.js:38` | `api_ref: apiRef` |
| P1 verifies against it | `shared/intasend-verify.js:105` | matches `invoice_id` **or** `tracking_id` **or** `api_ref` |

**The `transactionId → api_ref` anchor P3-A must preserve is already established and already
load-bearing.** Nothing needs to be invented; the callback simply is not being listened to.

---

## 5. Where association must be written — decided by the authorization layer

Checked against the **deployed** ruleset (`6264c7db…`, released 2026-09-13), not the repo:

| Collection | Deployed rule | Consequence |
|---|---|---|
| `posPayments/{checkoutId}` | `allow read` for admin, `sellerUid`/`sellerId`, `callerUid`/`buyerId`. **No `allow write` clause at all** | writes denied by default; **readable by the seller and the buyer** |
| `paymentAttempts/{uid}` | **no match block whatsoever** | invisible to every client, read and write |

**Therefore the association must land on `posPayments/{transactionId}`.** Writing it only to
`paymentAttempts` would satisfy an audit trail and achieve *nothing* for the latency problem
P3-A exists to solve, because no client can read that collection.

> **Repo/deployed divergence, recorded not fixed:** `firestore.rules:1983` carries an explicit
> `allow write: if false;` for `posPayments` that is **absent from the deployed ruleset**. The
> security outcome is identical — Firestore denies by default — but the two sources differ, which
> is consistent with the reopened rules-lineage finding. Not a P3-A defect.

### `paymentAttempts` has one producer and zero consumers

`pos-qr.js:368` writes it. **Nothing in production reads it** — every other reference is test or
certification code. It is a genuine audit record, but it is not a channel.

---

## 6. Who would actually benefit, and how the news travels

* **Customer (`pay.html`)** — polls the **callable** `getPOSPaymentDetails` every interval
  (`pay.html:866`); it does **not** read Firestore directly. So association becomes visible to the
  customer only if `getPOSPaymentDetails` (`pos-qr.js:232`) is taught to surface it. That callable
  already enforces a 32-char id and an HMAC signature check.
* **Cashier / POS** — reads `posPayments` directly under the rule above.

**The workflow gap remains the real prize:** only the seller may call `completePOSQRPayment`, so
today nothing flips until the cashier confirms. Association is what would let both screens learn
sooner — it is a **latency and UX improvement, not an integrity repair.**

---

## 7. Duplication, reordering, and what the callback can be trusted for

**Idempotency today** is two-layered: an early `status === "COMPLETE"` short-circuit, then a
`runTransaction` that re-reads inside the transaction and sets `claimed`. A racing duplicate finds
`claimed === false` and logs `Already processed (raced)`. **Any association write must adopt the
same discipline — a deterministic document id and a transactional guard, never a blind `update`.**

IntaSend retries on timeout and 5xx, so duplicates are expected, and **ordering is not guaranteed**:
a `FAILED` may arrive after a `COMPLETE`. Association must therefore be **monotonic** — it may
record that a gateway transaction is associated, but must never move a sale backwards.

**What the callback may be trusted for:** the `api_ref` — because *we* minted it and it survived a
round trip through an authenticated channel. That is enough to answer *which* sale.

**What it must never be trusted for:** `amount`, seller, or order. The server already owns
`posPayments/{txnId}.total`, written at QR creation from validated items, and `sellerId` from
`auth.uid`. **The callback says which; the server says what.** Since the seller is never read from
the body, a malformed or hostile callback cannot cross sellers — the worst case is naming a
transactionId that does not exist, which must change nothing.

---

## 8. Isolation — can this be committed cleanly?

**Yes.** Verified by block comparison against `HEAD`:

```
webhookIntasend        IDENTICAL to HEAD  (781 lines)   ← clean to edit
intasendWebhook        IDENTICAL to HEAD  (260 lines)
verifyIntasendPayment  IDENTICAL to HEAD  (389 lines)
```

`functions/index.js` is dirty (**+109/−5**) with another agent's work in **five hunks**, at new-file
lines **4773, 4825, 6244, 6256, 12911** — **none of them inside any IntaSend handler.** The nearest
(6244/6256) sits ~290 lines above `intasendWebhook` and outside its block.

So the change is committable by the same **content-marker hunk isolation with mandatory mixed-hunk
detection** used for D1+D2 and for this session's changelog. Separability must be proven in both
directions before staging.

---

## 9. Proposed implementation scope — the smallest thing that works

**One new file** — `functions/shared/pos-qr-association.js`, pure and `require`-free of the admin
SDK, testable in isolation, in the style of `shared/pos-payment-ownership.js`:

```js
associateQrCallback({ apiRef, state, gatewayInvoiceId, now })
  → { handled: false }                    // not a 32-hex ref, or no posPayments doc
  → { handled: true, fields: {…} }        // association fields ONLY
```

**One call site** — `functions/index.js:7733`, in `webhookIntasend` only, ahead of the existing
drop, following the `_finalizeWalletTopUp` early-return contract.

**Fields written to `posPayments/{transactionId}`** — association metadata exclusively:

```
gatewayInvoiceId   gatewayState   gatewayNotifiedAt   gatewayCallbackCount
```

**`status` is not among them, and never will be.**

### Hard boundary, restated as code-level prohibitions

The implementation must not write `status`, must not create an order, must not call
`settleOrder`, must not credit a wallet, must not write `paidAt`/`receiptId`/`orderId`, must not
replace or shortcut P1, must not treat the callback `amount` as proof, and must not touch
`intasendWebhook`, `verifyIntasendPayment`, `mpesa-c2b.js` or any inbound Daraja handler.

---

## 10. GREEN contract for the implementation gate

1. A QR callback is identified **exclusively** by `api_ref`, matched to `posPayments/{apiRef}`.
2. The correct POS transaction is associated; the seller is read from the **server document**,
   never the callback body.
3. An unknown `api_ref` changes nothing and still answers `200` — proven, not assumed.
4. Duplicate callbacks are idempotent: N deliveries produce one association; the count is
   observable, the association is not re-applied.
5. Out-of-order delivery cannot move a sale backwards.
6. A malformed or hostile body cannot cross sellers, and cannot write to a foreign transaction.
7. **No callback can establish `paid`** — sabotage proves a callback attempting `status:'paid'`
   is detected and fails the gate.
8. **P1 remains the only authority**; `completePOSQRPayment` is unchanged, asserted byte-identical.
9. The certified online rail is **byte-identical to HEAD** where it is not the seam, and its
   behaviour for an existing `payments/{apiRef}` is provably unaltered.
10. `intasendWebhook`, `verifyIntasendPayment` and `mpesa-c2b.js` byte-identical to HEAD.
11. Other-agent hunks untouched; attribution asserted by **content**, not by "file unchanged".
12. Every sabotage proves `mutated !== original` before its detector runs.
13. Every "nothing found" assertion is paired with a positive control.
14. Require-closure passes; full regression 0 failed / 0 blocked; isolated commit; **nothing
    deployed.**

---

## 11. Recorded here, explicitly NOT part of P3-A

* **D3 / Safaricom.** `darajaSTKCallback` is still receiving live POSTs and **rejecting genuine
  Safaricom IPs** (`196.201.212.69`, inside their published range, on 2026-09-03 and 2026-09-06).
  Recorded as a D3 security/operational finding. **Not to be repaired** — repairing the legacy
  inbound rail would contradict the IntaSend-only direction, and D3 is blocked on external
  de-registration regardless.
* **`intasendWebhook` is dead** — zero callbacks in 180 days, 260 lines kept in partial sync with
  an 781-line sibling. Its retirement is its own gate.
* **`posPayments` still carries two document shapes** (retired Daraja vs QR). Its own convergence
  gate.
* **`pendingMethod` / `paymentInitiatedAt`** still have zero consumers.
* **Production hosting is unchanged.** `754704a` is not deployed; `mysokoni.co.ke` still serves the
  pre-retirement console. The repository is IntaSend-only; production is not.
