# Phase 1 — Post-Pilot Backlog

Items deferred out of RC1 by explicit change-control decision. **None is implemented during
RC1.** Each is a confirmed defect with evidence, not a speculative improvement.

> **Formal deferral — 2026-07-17.** T-1 and T-2 were reviewed and explicitly deferred by change
> control. Rationale on record: they are outside approved RC1 scope, they modify **financial
> transaction behaviour**, neither is verified as pilot-blocking, and introducing runtime changes
> during the release-candidate window would reduce confidence that RC1 behaves as validated.
>
> **Scheduled as the first engineering work after Phase 0**, subject to re-confirming they are
> still relevant against production evidence gathered during the pilot.
>
> Governing principle: *the goal is no longer to maximise improvements before release — it is to
> maximise confidence that the release candidate behaves exactly as expected in production.*

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


---

## P1-CHARSET — `<meta charset>` declared after the first `<script>`

**Deferred 2026-07-18. Standards hygiene, not a defect. No measurable performance effect.**

231 of 320 HTML files declare `<meta charset="UTF-8">` after the first `<script>` tag. The HTML
spec asks for it within the first 1024 bytes and before any content.

A 3-page pilot (`pos.html`, `pos-checkout.html`, `checkout.html`) was **authorized but not
executed**: the premise — that late charset forced a parser restart producing ~85 aborted
requests on SmartPOS — was disproven before any file was edited. See
[[MEASUREMENT_VALIDITY_CORRECTION]].

Evidence against any performance benefit:

- `document.characterSet` resolves to UTF-8 on every page tested — no encoding failure exists.
- `/pos-setup` produced 82 aborts reached via redirect and 2 loaded directly. Same file. The
  aborts were navigation cancellation, not parsing.
- `pos.html` and `checkout.html` begin with a UTF-8 BOM, which outranks `<meta charset>`
  entirely — the proposed mechanism cannot apply to them.

**Why still worth doing eventually:** spec conformance, and removing a documented trap for future
readers. **Expected performance gain: zero.** Do not schedule it as a performance item.

**If ever executed:** no generator exists (verified — no template engine or bundler in
`package.json`, no `.ejs`/`.pug`/`.hbs`/`.njk` files, no SSG config, no script in `scripts/`
emits `.html`), so all 231 files need direct edits. Automation is appropriate: the move is
mechanical, and each file can be verified byte-identical once the moved tag is normalised.
Rollback is a single revert.

---

## P1-HOME-TBT — Home page warm TBT 755 ms (style/layout bound)

**Deferred 2026-07-18. Confirmed with evidence. Does not meet RC1 freeze criteria.**

Home is the platform's worst page on warm Total Blocking Time — **755 ms median**, 3.6× the next
worst page and 3.8× the 200 ms threshold — on the highest-traffic surface. Its cold-start penalty
is the smallest on the platform (3.4×), meaning the cost is **structural, not first-visit**.

**Root cause is rendering, not JavaScript.** RecalcStyle 3527 ms + Layout 2699 ms = 6226 ms,
against ScriptDuration 1811 ms — 3.4× the JS cost, across 314 style recalcs and 291 layout passes
over a 3128-element DOM. Full analysis: [[HOME_PERFORMANCE_INVESTIGATION]].

**Largest single verified win — `sokoni-sheet.js:343 promote()`.** It calls `getComputedStyle` on
1081 elements to find the 13 that are `position:fixed` (98.8% wasted) and interleaves those reads
with `getBoundingClientRect`, forcing synchronous layout. Browser-side ablation measured:

| Metric | Baseline | Neutralized | Delta |
|---|---|---|---|
| TBT | 1471 ms | 1200 ms | **−271 ms** |
| RecalcStyle | 3527 ms | 3216 ms | −311 ms |
| Layout | 2699 ms | 2488 ms | −211 ms |

**Risk: Medium.** `promote()` guarantees full-screen sheets layer above the header; a wrong
narrowing renders modals *behind* it — visible on checkout and auth. A safe fix preserves which
elements get promoted and only narrows the scan. Files: `sokoni-sheet.js` only. Rollback: single
revert. Expected LCP benefit: **none** (LCP is hero/image-bound here). Preserve the intentional
single-pass, no-polling design documented at `sokoni-sheet.js:332`.

**Why deferred rather than shipped:** 271 ms is 18% of a 1471 ms problem, on a working page, at
Medium risk to modal layering during a pilot where checkout must not break. The largest bottleneck
is diffuse style/layout pressure from DOM size — `promote()` is the easiest slice of it, not the
bottleneck itself. Attacking DOM size is the higher-value work and is too large for a freeze.

**Secondary items** (same investigation, unproven as contributors — verify before acting):
16 registered intervals including `kass-widget.js:152` @60 ms and `recaptcha` @100 ms; 475
registered event listeners; `_writeSafeAreaVars` (`sokoni-form-engine.js:247`) forcing synchronous
layout at ~303 ms per call, twice per load.
