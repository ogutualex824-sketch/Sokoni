# Firestore Transaction Integrity Audit — 2026-07-17

**Bug class:** Firestore requires **every read before every write** inside a transaction. A
`txn.get()` after a `txn.set/update/delete` throws at runtime. These failures are easy to miss in
review because they are often **conditional** — the happy path passes and only a specific input
shape trips them.

**Why this was run:** `posProcessRefund` had exactly this defect (`txn.get` inside the write loop),
so **every multi-item refund threw** while single-item refunds passed. Fixed 2026-07-17 in
`6d941f7`. This sweep looks for the same class elsewhere.

**Method:** brace-matched every `runTransaction(async (v) => {…})` body across `functions/*.js`,
stripped comments and string literals, then ordered each `v.get/set/update/delete` call and
flagged any read positioned after the first write. Read-only.

**Scanner limitation (important):** the detector is **position-based, not control-flow aware**, so
a read in an `else` branch looks like it follows a write in the `if` branch. Every candidate was
therefore verified by hand. 3 candidates → **2 real, 1 false positive.**

---

## CONFIRMED — T-1 · `transferWarehouseStock` · `functions/pos-inventory-pro.js:610`

```js
await db.runTransaction(async (tx) => {
  const sourceSnap = await tx.get(sourceRef);      // READ
  …
  tx.update(sourceRef, { quantity: _INC(-qty) });  // WRITE   (or tx.set on the else branch)
  …
  const destSnap = await tx.get(destRef);          // READ AFTER WRITE  -> throws
```

The source write is unconditional on the success path, so the destination read always follows it.

- **Impact:** **every warehouse-to-warehouse stock transfer fails.** Multi-branch or
  multi-warehouse merchants cannot move stock at all. Silent in single-warehouse setups, which is
  why it survived.
- **Severity:** High for any multi-branch merchant; not Phase 0 blocking (pilot is single-branch).
- **Fix:** hoist both reads above all writes — `const [sourceSnap, destSnap] = await Promise.all([tx.get(sourceRef), tx.get(destRef)]);`
  then branch on `.exists`. ~5 lines, no behaviour change.

## CONFIRMED — T-2 · booking cancellation · `functions/availability.js:570`

```js
await db.runTransaction(async (tx) => {
  const slotDoc = await tx.get(slotRef);           // READ
  …
  tx.update(slotRef, { status: 'cancelled', … });  // WRITE  (unconditional)
  …
  if (booking.date === now.date) {                 // only for TODAY's bookings
    const configDoc = await tx.get(configRef);     // READ AFTER WRITE -> throws
```

- **Impact:** **cancelling a booking scheduled for today throws.** Cancelling a future-dated
  booking succeeds, because the guard is false and the second read never executes. A customer or
  provider trying to cancel a same-day appointment gets an error and the booking stays active —
  the worst variant, since same-day is exactly when cancellations happen.
- **Severity:** High for the booking/services vertical. Not Phase 0 pilot blocking (retail POS).
- **Fix:** read `configRef` alongside `slotRef` at the top, then apply the decrement conditionally.
  Note `configRef` and `slotRef` resolve to related paths under the same
  `providerAvailability/{providerId}` document — worth confirming they are not the *same* document,
  in which case the second read is redundant and can simply be deleted.

## FALSE POSITIVE — `functions/b2b-wholesale.js:563`

`tx.get(noteRef)` sits in the `else if (paymentMethod === 'credit_note')` branch; the wallet writes
sit in the mutually exclusive `if (paymentMethod === 'wallet')` branch. Only one executes per
invocation, so no read ever follows a write at runtime. **Correct as written — do not change.**

---

## Recommendation

Both confirmed defects are **existing functions that throw**, not missing features. Each fix is
surgical (hoist the reads; no logic or schema change) and independently verifiable on the Firestore
emulator using the pattern already established for the refund fix.

Neither is Phase 0 pilot-blocking — the pilot is a single-branch retail merchant, so warehouse
transfer and provider booking are not on its critical path. **Not fixed here; awaiting
authorization** per the RC1 freeze.

Suggested order when authorized: **T-1** (broader blast radius — all transfers) then **T-2**.

## Standing guidance

When writing any Firestore transaction: perform **all** reads first, ideally in a single
`Promise.all`, then all writes. Never place a `get` inside a loop that also writes, and never
behind a conditional that follows a write. The three fixes shipped today
(`posCompleteCheckout`, `posProcessRefund`, `posUpsertProduct`) all follow this shape and can be
used as references.
