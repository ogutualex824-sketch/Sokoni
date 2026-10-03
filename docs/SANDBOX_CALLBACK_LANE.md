> **RETIRED 2026-10-03.** Daraja was removed on the owner's order (SOKONI collects through IntaSend only). The code this
> document describes no longer exists; the functions safety guard now asserts Daraja is absent. Kept as history. See
> [[Payments]] and CHANGELOG 2026-10-03.

# Sandbox callback lane — narrow, inert, and not seller-forgeable

**Branch:** `fix/stk-msisdn-safety`, cut from live `b223635`
**Gate:** `scripts/test-daraja-sandbox-lane.js` — **26 passed, 0 failed**
**Status:** committed, gate-certified, **NOT deployed**. Ships **inert**.

---

## The problem it solves

Gate 3 (*STK → Safaricom sandbox → callback → reconciliation*) cannot complete today.
`darajaSTKCallback` rejects any caller outside Safaricom's **production** IP allowlist, and
the sandbox posts from other infrastructure. So a sandbox STK could never settle its own
`posPayments` row — it would strand an unsettleable pending payment instead.

The fix is **not** to loosen the production allowlist. Sandbox and production are different
environments; this is an explicitly sandbox-scoped path that leaves the production rule
exactly as it was.

## Why the obvious implementation is unsafe

`posPayments.env` is copied from `shopSettings/{sellerUid}.darajaEnv`, and `firestore.rules`
lets a seller write their **own** `shopSettings`. So **`env === "sandbox"` is a
seller-forgeable claim.** A lane that trusted it alone would let any merchant mark their
live payments sandbox and make them completable by anyone who learns the CheckoutRequestID.

**Two conditions, not one:**

```js
if (!ipTrusted) {
  if (payData.env !== "sandbox"
      || !_DARAJA_SANDBOX_SELLER_UIDS.has(payData.sellerUid)) { /* reject, as before */ }
}
```

The allowlist is fixed at **deploy time** from `DARAJA_SANDBOX_SELLER_UIDS` and cannot be
written by any seller. That is what makes the forgeable claim safe to act on.

## Inert by construction

An empty set means **the lane does not exist**: the callback rejects an untrusted IP
**without reading Firestore at all**. That read-free branch is not incidental — without it
a public endpoint becomes an amplifier for unauthenticated reads, one document read per
request. Production configuration is the empty set.

**Deploying this code does not create the lane.** Someone must also set the variable.

## Sandbox money is not money

`_isSandbox` (`env === "sandbox" || isTest === true`) does two things:

- gates the financial engine off entirely — booking paperwork against a payment that never
  moved would put fabricated figures into production financial reporting
- stamps `isTest` on the `sellerPayments` credit

The second is a **real fix**. `onSellerPaymentCreated` already has
`if (!data || data.isTest) return;`, but this path never copied the flag — so that guard
was unreachable and **a KES 1 test booked a real commission**.

## Document-id safety

Once an untrusted caller can reach `.doc(checkoutId)`, an id containing `/` addresses a
different Firestore path and an empty one throws. The id is validated before use.

## What the gate proves

| section | property |
|---|---|
| A | with no allowlist the lane does not exist — and **Firestore is not read at all** |
| B | an enrolled sandbox seller settles from any IP, audited |
| C | **the converse** — a non-enrolled seller claiming sandbox is refused; an enrolled seller cannot settle a *production* row |
| D | malformed ids cannot address another path, and nothing is thrown-and-swallowed |
| E | sandbox money never reaches the ledger; the credit is stamped `isTest` |
| F | the Safaricom path still settles **and still books real money**, not marked `isTest` |

The handler is **extracted from `functions/index.js` and executed**, so the gate cannot
drift from shipped code.

### Two holes the first sabotage run exposed

The first version of this gate scored 23/0 and was still **unsound in two places**. Both
misses were failures to observe, not failures to assert:

1. **checkoutId validation** — the handler's outer `try/catch` **swallows** the throw from
   `.doc('a/b')`, so "row untouched, no audit entry" held identically with and without the
   guard. Fixed by capturing `console.error` and asserting nothing was thrown-and-swallowed.
2. **read-free early reject** — replacing it with `if (false)` still ends in a rejection
   further down, so the row stays pending and the audit entry still appears. The only
   observable difference is that Firestore **was read first** — the entire purpose of the
   branch. Fixed by counting document reads, with a control proving the counter registers
   reads when they occur.

### Sabotage, second run — all caught

```
baseline                                      -> exit=0 fails=0
drop the seller allowlist condition           -> exit=1 fails=2
drop the env==="sandbox" condition            -> exit=1 fails=1
stop stamping isTest on the seller credit     -> exit=1 fails=1
let sandbox money reach the financial engine  -> exit=1 fails=1
drop the checkoutId path validation           -> exit=1 fails=1
remove the read-free early reject             -> exit=1 fails=1
restored                                      -> exit=0 fails=0
file identical to good copy: true
sabotages not caught / probes broken: 0
```

A sabotage that fails to **apply** is reported as a broken probe, never as a pass.

## Gate 3 status

⚪ **Still not passed.** This makes the boundary *testable*; it does not test it. Passing
Gate 3 still requires: deploy this lane → enrol the sandbox seller → one real Safaricom
sandbox STK → observe the actual callback → verify the full chain → retry the callback and
confirm idempotency at the real deployed boundary.

`productionAuthorized` remains **false**. `DARAJA_SANDBOX_SELLER_UIDS` ships **empty**.
The customer rail remains **IntaSend**.

Related: [[Gate3 Callback Reconciliation]] · [[STK MSISDN Safety]] · [[Merchant-Owned Payments]]
