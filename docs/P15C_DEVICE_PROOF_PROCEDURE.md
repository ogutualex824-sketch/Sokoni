# P15C — real-device proof procedure

**Status:** ⛔ **CANNOT RUN TODAY.** Written in advance so the pass/fail criteria are agreed
*before* the proof, not rationalised after it.
**Gates:** ADR-013 Option A Phase 2 onward. Nothing may be migrated until this passes.
**Date:** 2026-09-01

---

## Why it cannot run today — the circular gate

| requirement | state |
|---|---|
| `smartPosDispatch` deployed | ✅ ACTIVE, last updated **2026-08-27** |
| `posCompleteCheckout` deployed | ✅ ACTIVE, updated 2026-08-30 |
| `registerClientShift` handler in the deployed build | ❌ **0 occurrences in HEAD** (2 in working tree) |
| `shift_registration` sync route in the deployed build | ❌ **0 occurrences in HEAD** (3 in working tree) |

P15C exists **only in the uncommitted working tree**. The deployed dispatcher predates the
handler, so a device proof today would fail with an unknown-op error — a **deployment artefact,
not a design failure**, and it would prove nothing about the architecture.

**The gate is circular:** the proof requires deployed code; deploying requires committing;
committing and deploying are both currently withheld. Breaking the circle is an operator
decision, not something to engineer around.

**Minimum unblock chain:**
1. Commit the P15C slice (currently prohibited).
2. Deploy functions — requires authorization, resolution of the 403 push block, and the
   candidate-lineage guard (passes on `sok-fn-cand`, fails on `sok-printer` with 11 missing
   protections).
3. A real handset signed in as an **authorized merchant and, separately, a cashier**.

Do **not** shortcut step 3 with an emulator: an emulator token cannot read production, and a
passing in-memory harness cannot prove callable deployment topology. That is the whole point.

---

## What must be proven

Path: `offline POS shift → clientShiftId → PosSync → smartPosDispatch(registerClientShift) → authoritative posShifts`

### P1 · Happy path, online
Open a shift on the device. **PASS:** a `posShifts` document exists server-side, carrying the
server-derived merchant identity, and the device's `clientShiftId` appears as a join key — not as
authority.

### P2 · Offline capture
Airplane mode. Open a shift, record a sale. **PASS:** both are durable locally and the till
remains usable. **FAIL** if the till blocks, errors, or discards either.

### P3 · Reconnect drain
Restore connectivity. **PASS:** the queue drains and the shift registers. **FAIL** if the sale is
lost, or if registration failure discards the locally recorded sale.

### P4 · Idempotency under retry
Force a retry (kill connectivity mid-call, or replay the queue). **PASS:** exactly **one**
`posShifts` document and **one** sale; a replay returns the original outcome and performs no
second mutation.

### P5 · Collision refusal
Register the same `clientShiftId` against a different merchant. **PASS:** refused. **FAIL** if it
overwrites, merges, or guesses.

### P6 · Cashier identity
Repeat P1 signed in as a **cashier**, not the owner. **PASS:** the shift binds to the canonical
merchant, and the cashier's uid does **not** become the merchant identity.

### P7 · Sale-queue integrity
Across all of the above: **no sale lost, none duplicated, none double-charged, no stock deducted
twice.** This is the guarantee the migration exists to preserve.

---

## Automatic FAIL conditions

The proof **fails** — it does not "pass with caveats" — if passing requires any of:

- weakening employee authority, or granting a permission;
- accepting a client-supplied `sellerId`, `merchantId`, `cashierUid`, price, total or variance
  as authority;
- treating `clientShiftId` as authorization rather than a join key;
- relaxing the offline guarantee;
- consuming an approval (must remain **0**);
- publishing rules from the repo artifact.

A failure here is a real result. Report it and stop — do not tune the system until it passes.

---

## Evidence to capture

Device model and OS · signed-in role (owner / cashier) · the deployed function revision and its
update time · the commit actually deployed · served ruleset id at the time of the run · per-step
pass/fail · the resulting `posShifts` document id and its merchant binding · queue depth before
and after each step · any error text verbatim.

Without the deployed revision and commit recorded, the run proves nothing reproducible.
