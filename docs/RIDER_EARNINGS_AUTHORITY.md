# Rider Earnings Authority — Architecture

**Status:** DESIGN — **BLOCKED**. §7 Q1 answered 2026-07-19: distance is client-controlled, so this design is INSUFFICIENT as written. A server-derived distance authority must land first.
**Date:** 2026-07-19
**Invariant established:** *No client value may ever determine money.*

Evidence classes: **VERIFIED** (read from code) · **INFERRED** · **UNKNOWN**.

---

## 1. Why this exists

`navigation.js:563` — **VERIFIED**:

```js
const { tripId, earnings } = request.data;
```

`earnings` arrives from the client. It is written to the trip (`:579`), incremented into
`drivers.totalEarnings` (`:597`), and enqueued as the payout `amount` (`:609`), which
`processDriverEarning` (`:766`) credits to the rider's wallet. **No server-side validation of the
figure exists anywhere in the path.**

A rider completing a KES 200 delivery can submit `earnings: 200000` and be credited it.
`enforceAppCheck: true` is set — that attests the *app*, not the *number*.

The sibling producer has the opposite defect. `navSubmitPOD` (`:395`) enqueues **without**
`amount`; the consumer guards `if (!riderId || !amount) return;` (`:771`) and drops it silently,
behind `.catch(() => {})`. **Riders completing by proof-of-delivery are never paid.**

Two producers, two failure modes, no authority between them.

> **Ordering consequence.** Both defects are currently theoretical — zero payments have ever
> completed, so no wallet has been credited by any path. They become live the moment the IntaSend
> production webhook is repointed to `/intasendWebhook`. **This work therefore gates that change.**

---

## 2. Discovery — VERIFIED

| Concern | Finding |
|---|---|
| Client-supplied money in trip paths | **Exactly one site**: `navigation.js:563`. Narrow blast radius |
| Payout producers | **Two**: `navSubmitPOD:395`, `navCompleteTrip:605` |
| Payout consumer | **One**: `processDriverEarning:766` |
| Pricing tables | `sokoni-delivery-pricing.js:33-39` — 7 vehicle classes with `base` / `perKm` / `perMin`. **CLIENT-SIDE ONLY.** No equivalent under `functions/` |
| Server-side fare derivation | **ABSENT.** `grep riderEarning\|driverShare\|calculateFare functions/` returns only the consumer |
| Trip distance | `distanceKm` exists on trip docs (`navigation.js:969`). **Whether it is server-written or client-written is UNKNOWN** — see §7 |
| Consumer idempotency | **Sound.** `:774` documents at-least-once handling with a deterministic id. Not implicated |

---

## 3. Canonical contract

**Producers submit proof, never money.**

```
Producer  →  { tripId, completionProof, metadata }
Server    →  fare · commission · driverShare · walletCredit · ledger · settlement
```

Rejected inputs, always: `earnings`, `commission`, `fare`, `amount`, `total`, `payout`,
`walletBalance`. Presence of any of these on the request is not merely ignored — it is a
**signal**, and is logged (§6).

### Authority module

`functions/rider-earnings-authority.js` — new, and the **only** writer of rider payout amounts.

```
computeRiderEarnings(tripId) → {
  fare, driverShare, platformCommission,
  basis: { vehicleClass, distanceKm, durationMin, source },
  version, computedAt
}
```

Pure and side-effect free. Reads the trip document and configuration; writes nothing. Testable
without Firestore.

**Pricing tables move server-side.** `sokoni-delivery-pricing.js` becomes a generated mirror of a
server table, exactly as `sokoni-commission-rates.js` mirrors `functions/commission-config.js` —
with a deploy-time drift guard modelled on `scripts/verify-commission-single-source.js`.

> That guard has a known blind spot: it detects duplicate *tables*, not inline arithmetic
> (see `PRODUCTION_READINESS.md` §4). The rider-earnings guard must check **both**, or it will
> pass while `* 0.12`-style constants drift, exactly as the commission guard does today.

**Commission comes from the existing engine.** `functions/commission-config.js` is already the
single source with a working drift guard. The authority calls it. It does **not** define a rider
commission rate of its own — that would be a second table, forbidden by the Platform Constitution.

---

## 4. Financial flow

```
Trip completed (either producer)
   │  submits tripId + proof only
   ▼
computeRiderEarnings(tripId)          ← authority; trusted inputs only
   │
   ▼
runTransaction:
   ├─ claim  finosIdempotency/rider_payout_{tripId}   ← exactly-once
   ├─ write  driverEarningQueue/{tripId}  (deterministic id, amount from authority)
   ├─ write  ledger entries (double-entry, via finos-utils.createLedgerEntry)
   └─ stamp  trips/{tripId}.earningsAuthority = { version, computedAt, fare, driverShare }
   ▼
processDriverEarning  → wallet credit (existing consumer, unchanged)
   ▼
receipt · audit · notification
```

**Deterministic id is the keystone.** `driverEarningQueue/{tripId}` replaces today's `.add()`
auto-id. A replayed completion collides rather than appending — the same pattern
`intasendWebhook` uses for `commissionLedger/{apiRef}`.

### Transitions

| Transition | Producer | Authority | Failure mode | Recovery |
|---|---|---|---|---|
| Completion → earnings | `navCompleteTrip`, `navSubmitPOD` | `computeRiderEarnings` | Missing distance → **reject, do not guess** | Queue for ops review |
| Earnings → queue | authority | deterministic id | Duplicate → collides, no-op | None needed |
| Queue → wallet | `processDriverEarning` | existing | Already idempotent (`:774`) | Existing |
| Wallet → settlement | settlement engine | existing | — | — |

**Silent failure is removed.** `.catch(() => {})` at `:392`, `:401` and `:612` must go. A payout
that fails must surface — an unpaid rider is a support ticket, a silently unpaid rider is a
reconciliation defect nobody discovers.

---

## 5. Reuse — what is NOT built

| Need | Existing module | Why reuse |
|---|---|---|
| Commission rate | `functions/commission-config.js` | Single source with a working drift guard |
| Idempotency | `finosIdempotency` transactional claim | Proven in `sub-engine.js`, `payment-success.js` |
| Ledger | `finos-utils.createLedgerEntry` | Real double-entry; enforces its own key |
| Wallet credit | `processDriverEarning` | Already at-least-once safe |
| Notifications | `notify()` with `dedupeKey` | Designated entry point |
| Audit | `auditLog` with deterministic id | Matches `payment-success.js` |

**Only one new module.** Everything else extends what exists.

**Wallet units:** the authority emits **KES**. `finos-utils` works in cents and no longer writes
`balance` (fixed 2026-07-19). The authority must state its unit at the boundary and convert once,
explicitly. Ambiguity here is what produced the 100× collision.

---

## 6. Attack review

| Attack | Defence |
|---|---|
| **Forged earnings** | Client value never read. Any money field on the request is logged as a tampering signal |
| **Modified request** | Only `tripId` + proof accepted; everything else derived server-side |
| **Replay** | Deterministic `driverEarningQueue/{tripId}` + `finosIdempotency` claim |
| **Race / double completion** | Transactional claim; `txn.create` fails if the doc exists |
| **Negative / overflow** | Authority clamps to `[0, MAX_TRIP_EARNING]`; rejects non-finite. Rejects, never silently zeroes |
| **Partial completion** | Only a terminal, server-verified status may trigger payout |
| **Privilege escalation** | Payout binds to `trips/{id}.riderId`, never `request.auth.uid` — a rider cannot claim another's trip |
| **Distance inflation** | **The critical open risk — see §7** |

---

## 7. Open questions — must be answered before implementation

1. **Is `distanceKm` trustworthy? — ANSWERED 2026-07-19: NO. VERIFIED.**

   > **No Cloud Function writes `distanceKm` anywhere.** Grep across `functions/` returns only
   > readers (`email-triggers.js:345`, `navigation.js:969`, `sokoni-dispatch.js:312`) plus
   > `security-fraud-engine.js`, which computes its own for login-geo checks and never touches a
   > trip. The only producer is **`delivery-hub.js:168-192`, which is CLIENT-SIDE** (repo root, not
   > `functions/`) — haversine or OSRM in the browser — and writes it at `:239`.
   >
   > `firestore.rules:1183` permits `deliveries` **create** by any authed user who sets
   > `senderUid == request.auth.uid`, so the client supplies its own `distanceKm`.
   > `logistics-plus.js:604` additionally reads `distanceKm` straight from `req.data` and prices
   > it at `:612` (`KES 8/km beyond 50km`) — a second client-controlled money input.
   >
   > `trips/{tripId}` is read-only to clients (`firestore.rules:3210-3212`) and no CF writes the
   > field, so **`trips.distanceKm` appears never to be populated at all** — consistent with
   > `navigation.js:969` defaulting `t.distanceKm || 0`.
   >
   > **Consequence: the Rider Earnings Authority as designed MUST NOT be implemented.** Moving the
   > fare server-side while distance arrives from the browser is security theatre — the client
   > still sets the number that determines the money. A server-derived distance authority is a
   > prerequisite, not a follow-up.

   ~~UNKNOWN, and it decides the design.~~ If it is client-written,
   moving the fare calculation server-side changes nothing: the client still controls the input,
   and inflating distance inflates the fare. The authority is only as trustworthy as its least
   trusted input.
   - If server-written from GPS traces → usable, with a sanity ceiling.
   - If client-written → the authority must derive distance from the recorded route, or from the
     order's origin/destination via the existing routing service, and treat the reported figure
     as advisory only.
   **Answer this first. Everything else depends on it.**
2. **What is the rider's share?** No `driverShare` config exists anywhere — **VERIFIED absent**.
   A rate must be decided by the business and stored in config, never hardcoded.
3. **Surge, waiting time, multi-stop, cancellations, tips?** Present in the client pricing table as
   modifiers; their authority is undefined.
4. **What happens when distance is missing?** Recommendation: **reject and queue for ops**. Never
   guess an amount; never pay zero silently.

---

## 8. Migration

Both producers move together — a split migration leaves one trusting the client.

1. Move pricing tables server-side; regenerate the client mirror; add the drift guard (arithmetic **and** tables).
2. Add `rider-earnings-authority.js` + unit tests. No behaviour change yet.
3. Switch `navCompleteTrip` to the authority; **stop reading `earnings` from `request.data`**.
4. Switch `navSubmitPOD` to the same call. Both defects close together.
5. Deterministic queue ids; remove the three `.catch(() => {})`.
6. Backfill `earningsAuthority` on historical trips for reconciliation. **UNKNOWN scope** — no trip has ever paid out.

**Rollback:** revert the commit and redeploy the two functions. No data migration either way —
the authority adds fields, never rewrites existing ones. Safe because **no rider has ever been
paid**, so there is no in-flight financial state to unwind. That is also why this is cheap now
and expensive later.

---

## 9. Regression tests required

| Test | Asserts |
|---|---|
| Client cannot increase earnings | `earnings: 999999` in the request → payout equals the authority's figure |
| Client cannot reduce commission | `commission: 0` → platform share unchanged |
| Client cannot alter settlement | Settlement derives from the authority alone |
| Wallet credit equals canonical calculation | Credited amount == `computeRiderEarnings()` |
| Idempotent | Same `tripId` submitted 5×, and 10× concurrently → one payout |
| Both producers agree | `navSubmitPOD` and `navCompleteTrip` on identical trips → identical payouts |
| Missing distance rejects | No silent zero, no guess |
| Negative / overflow rejected | Clamped, logged, not silently zeroed |

Each must be proven to fail when the defect is reintroduced — the standard set by
`scripts/test-root-identity.js`.

---

## Related

[[PRODUCTION_READINESS]] · [[PLATFORM_CONSTITUTION]] · [[RELEASE_VALIDATION_STANDARD]]
