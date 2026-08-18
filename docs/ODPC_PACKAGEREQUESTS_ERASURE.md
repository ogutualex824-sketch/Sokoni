# ODPC — `packageRequests` and the erasure gap

**Status:** OPEN — **P1 investigation, tracked separately.** Not part of the Merchant v2
integration build and must not be folded into it.
**Nothing has been changed.** This is a finding plus a verification plan.

Related: [[ODPC_COMPLIANCE]] · [[DELIVERY_DESTINATION_BLOCKER]] · [[MERCHANT_SHELL_CAPABILITY]]

---

## 1. The finding

When a SOKONI account is erased, the delivery record created for that customer's orders appears
never to be touched — and it carries their name, phone number and home address.

```
packageRequests/DEL{orderId}
    buyerName
    buyerPhone          ← direct PII
    buyerUid            ← the identifier erasure is supposed to sever
    deliveryAddress     ← the customer's home address
            │
            ▼
   functions/account-purge-spec.js
            │
            ▼
     collection absent  ← measured
            │
            ▼
   finaliseExpiredDeletions never visits it
```

### Why the absence is decisive rather than merely suspicious

`functions/account-purge-spec.js` states it plainly in its own header:

> *"the finaliseExpiredDeletions worker drives **entirely** off this spec"*

That claim was checked rather than taken. The spec covers **twelve** collections:

```
notifications, follows, loyaltyAccounts, loyaltyPoints, wishlists, wishlistItems,
cartSaves, orders, walletTransactions, providerReviews, ledger, providerPayouts
```

`functions/account-manager.js` touches only `users`, `userSessions`, `auditLog` and `erasureLog`
directly — there is no hardcoded extra collection that might quietly cover the gap. So a collection
absent from the spec is genuinely never visited. **`packageRequests` is absent.**

### What is written there, and by whom

Two paths create the same document, both measured:

| writer | when |
|---|---|
| `functions/index.js:8170` | on the payment path |
| `functions/pos-marketplace-sync.js:250-268` | when a merchant marks an order `ready` |

Both write `buyerName`, `buyerPhone`, `buyerUid` and `deliveryAddress` with `{ merge: true }`.

By contrast the `orders` collection **is** covered, and is anonymised rather than deleted under a
7-year statutory retention basis (Income Tax Act Cap. 470), redacting `buyerName`, `buyerPhone`,
`phone`, `deliveryName`, `deliveryAddress`, `deliveryCoords`, `dropoffLat`, `dropoffLng`.

So the identical personal data is carefully redacted in one collection and, on this reading, left
intact in another — which is what makes this look like an oversight rather than a policy decision.

---

## 2. Why it is filed separately

It surfaced *while* tracing the delivery-destination divergence, but it is **not the same problem**
and must not wait behind it:

- The **destination divergence** is an architecture question — which of eight spellings is
  authoritative. It blocks new POS writes and needs a design decision.
- **This** is a compliance question — whether a data subject's erasure actually erases. It needs a
  verification run and, if confirmed, a remediation with its own gate.

Mixing them would let a privacy remediation inherit an architecture blocker's timeline. It also
must not be folded into the Merchant v2 integration build, which touches neither collection.

---

## 3. What is claimed, and what is not

**Claimed** — all directly measured:

- `packageRequests` does not appear in `functions/account-purge-spec.js`.
- The purge worker is spec-driven and touches no other collection.
- Both writers of `packageRequests` store `buyerName`, `buyerPhone`, `buyerUid`, `deliveryAddress`.
- The same fields are explicitly redacted for `orders`.

**NOT claimed:**

- **The purge worker has not been run.** This is derived from the spec's contents and the worker's
  code, not from an observed erasure. Until step 4.1 runs, this is a strong reading, not a proven
  breach.
- **No production data was inspected.** How many erased accounts still have a
  `packageRequests` document is unmeasured.
- **No conclusion about the correct remedy.** Delivery records may well carry a legitimate
  retention basis, exactly as `orders` does — in which case the answer is `anonymize`, not
  `delete`. That is a policy call, not an engineering one.
- **No claim that this is the only gap.** The same question is open for any other collection
  carrying buyer PII that is absent from the spec — `deliveryPins` and any delivery/dispatch mirror
  are obvious candidates and are **unchecked**.

---

## 4. Verification plan — in order

**4.1 Confirm the behaviour.** Run `finaliseExpiredDeletions` against a test account that has at
least one `packageRequests` document, and read the document back. This converts the finding from
derived to observed, and it is the gate for everything below.

**4.2 Census the blast radius.** Count `packageRequests` documents whose `buyerUid` belongs to an
already-erased account. That number is the actual exposure and belongs in the ODPC record.

**4.3 Sweep for sibling gaps.** Enumerate every collection written with a buyer identifier or
contact field, and diff that set against the twelve in the spec. The gap is unlikely to be a
population of one, and a per-collection answer is what the spec is for.

**4.4 Decide the action per collection** — `delete`, `anonymize` (with the legal basis and retention
period written down, as `orders` has), or `retain`. This is a policy decision and should be
ratified the way the 2026-07-28 policy was.

**4.5 Implement in the spec, not in the worker.** The spec is the single source of truth and is
meant to be readable by an auditor. A special case inside the worker would defeat both properties.

**4.6 Gate it.** A test that asserts **every** collection carrying a buyer identifier appears in the
purge spec, so the next collection to be added cannot silently repeat this. The negative control
matters as much as the assertion: introduce a synthetic PII-bearing collection absent from the spec
and require the gate to fail, or it proves nothing.

---

## 5. Standing rule until 4.4 is decided

Do not add another writer of buyer PII to `packageRequests`, and do not create a new
delivery-adjacent collection carrying buyer contact details, without adding it to the purge spec in
the same change. The gap exists because a collection was created without that step; repeating it
while the remediation is open would be knowing.
