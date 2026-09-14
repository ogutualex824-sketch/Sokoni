# P3-A — POS QR Webhook Association (DEFERRED GATE)

**Status:** 🟡 **NOT OPENED.** Recorded by P3 so it is not rediscovered by accident.
**Prerequisites:** P1 (`2e09929`) and P2 (`3dc56d2`) are closed. P3 (`this commit`) removed the dead
`pendingMpesaPhone` field that implied this mechanism existed.
**Related:** [[project_two_intasend_webhooks_diverge]] · [[project_pos_payment_authority]]

---

## What is missing

```
IntaSend webhook
      ↓  api_ref = transactionId          ← P2 already sets this
posPayments/{transactionId}
      ↓  ASSOCIATION ONLY
P1 verification remains authoritative
      ↓
paid + order
```

Today a POS QR callback is **acknowledged and dropped**:

```js
const payRef = db.collection("payments").doc(apiRef);
const snap   = await payRef.get();
if (!snap.exists) { res.status(200).send("OK"); return; }   // ← QR sales land here
```

Both `intasendWebhook` and `webhookIntasend` key on `api_ref` and look up **`payments/{apiRef}`**.
A QR sale's record lives in **`posPayments/{apiRef}`**, which neither handler knows about. Nothing
is created and nothing is corrupted — it fails closed — but the callback is discarded.

## What this is, and firmly is not

**It is a latency/UX improvement, not an integrity repair.** P1 obtains authoritative association by
querying IntaSend directly on `api_ref`; it does not need to be told. Association would let the POS
and `pay.html` learn sooner that money arrived, instead of waiting for the cashier to confirm.

**It must never become a second definition of "paid".** The callback may associate a gateway
transaction with a reserved POS sale. Only `completePOSQRPayment` may mark a sale paid, and only
after independent IntaSend verification. A webhook that could set `paid` would reintroduce exactly
the trust hole P1 closed, by a different door.

## Why it was deferred rather than built

The only place to do the association is inside those two webhook handlers, and they are:

* **certified, shared infrastructure** carrying the online marketplace rail;
* **already divergent** — there are two of them, and one prod sale is provably unpaid through that
  divergence (`project_two_intasend_webhooks_diverge`);
* **inside `functions/index.js`**, which carries other agents' in-flight uncommitted work.

P3's own scope forbade touching the certified online rail. Modifying a payment webhook to fix a
latency problem, in a file three parties are editing, is not a change to make under a cleanup gate.

## What P3-A must do when it opens

1. **Its own census** — both handlers, their divergence, and which one actually receives production
   callbacks. Do not assume the two behave alike; they demonstrably do not.
2. **Association only** — record the gateway transaction against `posPayments/{transactionId}`.
   Never `status: 'paid'`, never an order, never settlement.
3. **Deterministic and idempotent** — a retried callback must produce no second effect. IntaSend
   retries on timeout and 5xx.
4. **Fail closed on ambiguity** — no match, multiple matches, or a mismatched seller must change
   nothing.
5. **Never trust the callback body** for amount, seller or order. The callback says *which*
   transaction; the server already owns *what it costs*.
6. **Preserve the `transactionId → api_ref` anchor** established by P2 and verified by P1.
7. **Its own deployment gate** — touching a live payment webhook is not covered by any prior
   authorization.

## Also still open, and not part of P3-A

* **`posPayments` carries two incompatible document shapes** — the retired Daraja POS rail
  (`index.js:3935`) and the QR rail write different fields to the same collection. All 13 production
  rows are Daraja-shaped. Its own convergence gate.
* **`pendingMethod` and `paymentInitiatedAt`** also have zero consumers. Left in place by P3, whose
  scope named only `pendingMpesaPhone`. Harmless, but they are the same kind of dead weight.
* **The cashier still has to confirm.** Only the seller may call `completePOSQRPayment`, so the
  customer's `pay.html` poll does not flip on its own. A workflow gap, not a money defect — and it
  is the thing P3-A would actually improve.
