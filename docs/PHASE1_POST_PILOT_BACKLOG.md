# Phase 1 — Post-Pilot Backlog

Items deferred out of RC1 by explicit change-control decision. **None is implemented during
RC1.** Each is a confirmed defect with evidence, not a speculative improvement.

Governing rule for both items: **invariant 10 (Read-ordered) / forbidden pattern F7** in
[FINANCIAL_TRANSACTION_STANDARD.md](FINANCIAL_TRANSACTION_STANDARD.md) — every Firestore
transaction completes all reads before the first write.

---

## T-1 · `transferWarehouseStock` — read-after-write

**Location:** `functions/pos-inventory-pro.js:610` (`runTransaction` body)

**Root cause.** The transaction reads the source stock document, writes it (`tx.update` on the
`exists` path, `tx.set` on the `else` path — so the write is unconditional on the success path),
and only then reads the destination document:

```js
const sourceSnap = await tx.get(sourceRef);       // READ
…
tx.update(sourceRef, { quantity: _INC(-qty) });   // WRITE
…
const destSnap = await tx.get(destRef);           // READ AFTER WRITE -> SDK throws
```

The author treated the transfer as two sequential steps (decrement source, then increment
destination) rather than as one atomic read-set → write-set.

**Business impact.** Every warehouse-to-warehouse stock transfer fails. A multi-branch or
multi-warehouse merchant cannot move stock between locations at all. Invisible to single-warehouse
merchants, which is why it was never reported. **Not Phase 0 blocking** — the pilot is a
single-location retail merchant.

**Proposed fix.** Hoist both reads above all writes:

```js
const [sourceSnap, destSnap] = await Promise.all([tx.get(sourceRef), tx.get(destRef)]);
// validate sourceQty >= qty …
// then all writes: source decrement, destination increment, transfer record
```

No schema change, no logic change, no signature change — purely reordering. ~5 lines.

**Estimated regression risk: LOW.**
- The function is currently **100% broken**, so there is no working behaviour to regress.
- No callers depend on the current (throwing) response.
- Reads are already against fixed, deterministic doc ids (`{sellerId}_{warehouse}_{productId}`).
- Watch: the `else` branch writes a **negative** source quantity as a "should not happen" guard;
  preserve that behaviour exactly rather than silently changing it.

**Emulator test plan.**
1. Seed `posWarehouseStock` for source (qty 10) and destination (qty 0) under one seller.
2. Transfer 4 → assert source 6, destination 4, one `inventoryTransfers` record. *(Today this
   throws — the test reproduces the bug before the fix.)*
3. Transfer to a destination doc that does **not** exist → assert it is created with qty 4.
4. Transfer more than available → assert `failed-precondition` and **no** mutation on either doc.
5. Concurrent transfers of the same product → assert no lost update (totals conserved).
6. Same source and destination warehouse → assert `invalid-argument` (existing guard).

---

## T-2 · Booking cancellation — read-after-write

**Location:** `functions/availability.js:570` (`runTransaction` body)

**Root cause.** The transaction reads the booking slot, **unconditionally** writes it, then
conditionally reads the provider config to decrement a daily counter:

```js
const slotDoc = await tx.get(slotRef);              // READ
…
tx.update(slotRef, { status: 'cancelled', … });     // WRITE (always runs)
…
if (booking.date === now.date) {                    // only for TODAY's bookings
  const configDoc = await tx.get(configRef);        // READ AFTER WRITE -> SDK throws
```

**`configRef` and `slotRef` are DIFFERENT documents — confirmed:**
- `slotRef` → `providerAvailability/{providerId}/bookings/{bookingId}` (subcollection document)
- `configRef` → `providerAvailability/{providerId}` (parent document)

In Firestore a subcollection is **not** part of its parent document, so these are distinct
entities. The "remove the redundant read" option therefore **does not apply** — the read is
necessary and must be hoisted.

**Business impact.** Cancelling a booking scheduled for **today** throws; the booking stays
active and the customer/provider sees an error. Future-dated cancellations succeed because the
date guard is false and the second read never executes. This is the more damaging variant: same-day
is exactly when cancellations happen, and the failure is silent to anyone testing with a
future date. **Not Phase 0 blocking** — the pilot is retail POS, not the services/booking vertical.

**Proposed fix.** Read both documents up front, validate, then write:

```js
const [slotDoc, configDoc] = await Promise.all([tx.get(slotRef), tx.get(configRef)]);
// existence + authorization + status checks …
tx.update(slotRef, { status: 'cancelled', … });
if (booking.date === now.date && configDoc.exists) {
  tx.update(configRef, { 'cap.todayCount': Math.max(0, count - 1) });
}
```

The config read becomes unconditional (cheap: one extra document read) while the **write** stays
conditional, preserving today's semantics exactly.

**Estimated regression risk: LOW–MEDIUM.**
- Low for correctness: same-day cancellation is currently broken, so there is nothing to regress.
- The medium component is the **counter**: `cap.todayCount` must not be decremented for
  future-dated cancellations, and must not go negative. Guard with `Math.max(0, …)` and assert it.
- Also verify the authorization checks (admin / customer / provider) still run **before** any
  write — hoisting reads must not accidentally move a permission check after a mutation.

**Emulator test plan.**
1. Seed a provider config with `cap.todayCount = 3` and a booking dated **today**.
2. Cancel it → assert status `cancelled` **and** `todayCount` 3 → 2. *(Today this throws.)*
3. Seed a booking dated **tomorrow**; cancel → assert status `cancelled` and `todayCount`
   **unchanged**.
4. Cancel an already-cancelled booking → assert the existing `failed-precondition` guard and no
   double decrement.
5. Cancel as an unrelated user → assert `permission-denied` and **no** write to either document.
6. Cancel with `todayCount = 0` → assert it floors at 0, never negative.
7. Concurrent cancel of two different same-day bookings for one provider → assert the counter
   decrements exactly twice (no lost update).

---

## Sequencing

**T-1 first** (wider blast radius — all transfers fail, and it affects inventory accuracy), then
**T-2**. Both are independent and can ship separately. Each should be verified on the Firestore
emulator using the pattern established by the RC1 refund fix: write the test so it **reproduces
the failure before the fix**, then passes after.
