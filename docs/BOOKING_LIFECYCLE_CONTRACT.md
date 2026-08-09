# Booking Lifecycle Contract — v1.0 (RATIFIED 2026-07-27)

**Status:** RATIFIED — the authoritative state machine for **service-appointment** bookings
(`providerBookings`). No lifecycle op — existing or future (refunds, disputes, auto-expiry) — may
introduce a transition not defined here. This is to booking lifecycle what the Publication Contract is
to publishing: a versioned contract, not a description of current code.
**Scope:** `providerBookings` (provider service appointments). Venue/facility bookings (`booking.js` /
`bookings`) have their own vocabulary and are out of scope.
**Companion:** `docs/BOOKING_CONVERGENCE.md` (Phase D is where D1 implements this contract).

---

## 1. States

| State | Kind | Holds a slot lock? | Settles? | Meaning |
|---|---|---|---|---|
| `pending` | active · initial | ✅ yes | no | created, awaiting provider confirmation (default from `bookingCreateService`) |
| `confirmed` | active | ✅ yes | no | provider accepted; slot committed (also the `autoConfirm` create default) |
| `in_progress` | active | ✅ yes | no | service is underway |
| `completed` | **terminal** | released | **✅ yes (once)** | service delivered → Phase C settlement credits the wallet |
| `cancelled` | **terminal** | released | no | called off by provider or customer before delivery |
| `declined` | **terminal** | released | no | provider rejected a pending request |
| `no_show` | **terminal** | released | no | customer did not attend a confirmed booking |

**Active** states hold a slot lock (`providerAvailability/{providerId}/slotLocks/{slotKey}`) and count
toward capacity/overlap. **Terminal** states are final and release the slot lock.

`rescheduled` is deliberately **not** a state — see §4.

---

## 2. Transitions

Only these transitions are legal. Anything else is rejected `failed-precondition`.

```
pending ──confirm──▶ confirmed
pending ──decline──▶ declined         (terminal)
pending ──cancel───▶ cancelled        (terminal)
pending ──complete▶ completed         (terminal, convenience — see §5)

confirmed ──start────▶ in_progress
confirmed ──complete─▶ completed      (terminal, settles)
confirmed ──cancel───▶ cancelled      (terminal)
confirmed ──no_show──▶ no_show        (terminal)

in_progress ──complete─▶ completed    (terminal, settles)
in_progress ──cancel───▶ cancelled    (terminal)

pending|confirmed ──reschedule──▶ (same state, new slot)   (§4, not a state change)

completed | cancelled | declined | no_show ──▶ ∅   (terminal, no transitions out)
```

### Quick-reference matrix

| From | Allowed to | Operations available |
|---|---|---|
| `pending` | confirmed, completed\*, cancelled, declined | confirm · complete\* · cancel · decline · **reschedule**† |
| `confirmed` | in_progress, completed, cancelled, no_show | start · complete · cancel · no_show · **reschedule**† |
| `in_progress` | completed, cancelled | complete · cancel |
| `completed` | — (terminal) | — |
| `cancelled` | — (terminal) | — |
| `declined` | — (terminal) | — |
| `no_show` | — (terminal) | — |

\* `pending → completed` is the v1 compatibility convenience (§5).
† **reschedule** is an operation, not a state change — it moves the slot in place and keeps the current state (§4).

### Transition table (actor · guard · side effects)

| From | To | Op | Actor | Guard | Side effects |
|---|---|---|---|---|---|
| pending | confirmed | `providerConfirmBooking` | provider (owner) | own booking | mirror `providerCalendar/{id}`; notify customer |
| pending | declined | `providerDeclineBooking` | provider | own | **release slot lock**; notify customer |
| pending | cancelled | `providerCancelBooking` | provider (or customer) | own / customer of booking | **release slot lock**; notify counterparty |
| confirmed | in_progress | `providerStartBooking` | provider | own; not before `startTs` − grace | — |
| confirmed | completed | `providerCompleteBooking` | provider | own | **Phase C settlement (exactly-once)**; release slot lock; remove calendar mirror |
| confirmed | cancelled | `providerCancelBooking` | provider/customer | own/customer | **release slot lock**; deposit-refund policy → §6 (deferred) |
| confirmed | no_show | `providerMarkNoShow` | provider | own; not before `startTs` | **release slot lock**; **no settlement**; deposit-forfeit → §6 (deferred) |
| in_progress | completed | `providerCompleteBooking` | provider | own | **settlement**; release slot lock |
| in_progress | cancelled | `providerCancelBooking` | provider | own | **release slot lock** |
| pending/confirmed | (same, new slot) | `providerRescheduleBooking` | provider/customer | own/customer; new slot valid + free | release **old** lock, acquire **new**; `rescheduleCount++`; append `rescheduleHistory[]` |

**Authorization:** every op re-derives the actor from `req.auth.uid` and verifies ownership
(`providerId === uid`, or `customerUid === uid` for customer-permitted transitions). Rules keep
`providerBookings` writes CF-only (`write:false`); the server is the sole mutator.

---

## 3. Invariants (must always hold)

1. **Exactly one terminal settlement.** Only `completed` credits the wallet, and only once (Phase C
   transaction). No other terminal state settles. This is precisely what the settlement-convergence
   monitor verifies in production.
2. **Slot-lock ⇔ active, exactly one.** At any moment a booking holds **exactly one** active slot lock iff
   it is in an active state — never two, never zero (see the atomicity guarantee in §4). Every transition
   to a terminal state (except `completed`, which also releases) **must release the slot lock**, or the
   slot is stranded forever (the known venue-engine class of bug — D1 must not repeat it).
3. **Terminal is final.** No transition leaves `completed`/`cancelled`/`declined`/`no_show`. A retry of
   a terminal op is idempotent (returns the current terminal state, no side effect).
4. **Guards are server-evaluated** against server time, never client-supplied timestamps.
5. **Booking identity is immutable.** `bookingId`, `providerId`, and `customerUid` are fixed at creation
   and **never change** for the life of the booking — not even across a reschedule. Only scheduling data
   (`date`, `startTime`/`endTime`, `startTs`/`endTs`, `slotKey`) and lifecycle status are mutable. This is
   the formal reason in-place reschedule (§4) is correct: a booking *is* a single, stable customer
   commitment; rescheduling changes *when*, never *who* or *which*. It is also why settlement, reviews,
   notifications, and monitor counts can all safely key on `bookingId`.

---

## 4. Reschedule — in-place slot move (recommended contract)

**Decision:** `providerRescheduleBooking` moves the booking to a new slot **in place** — it keeps the
same booking document and lifecycle status (`pending`/`confirmed`), releases the old slot lock, acquires
and validates the new one (via `reservation-core` + the same availability checks as
`bookingCreateService`: working hours, **breaks** (D2), buffers, capacity, blackout overrides,
min-notice), and records the change:

```
{ startTs, endTs, date, startTime, endTime, slotKey } := new slot
  rescheduleCount: increment(1)
  rescheduleHistory: append({ from:{date,startTime}, to:{date,startTime}, by, at })
```

**Why not a `rescheduled` terminal state (+ new doc):** that fragments a single appointment into a chain
of records, breaks the customer/provider's continuous reference (notifications thread, reviews-after-
completion gating, the calendar entry), and would double-count in the settlement monitor. In-place move
preserves identity while keeping full history in `rescheduleHistory[]`. The booking's document id no
longer equals `providerId_slotKey` after a reschedule — that coupling is only needed at **creation**
(natural lock + idempotency); post-creation the `slotLocks` subcollection is the authority on occupancy.

**Atomicity (invariant).** Reschedule is a **single transaction**. There is never a committed state in
which the booking owns two slot locks or zero — either the whole move commits or it aborts and the
booking keeps its original slot untouched. The algorithm inside the transaction:

```
1. validate the new slot   (working hours, breaks[D2], buffers, capacity, blackout override, min-notice)
2. acquire the new slot lock via CAS   (fail → abort with `already-exists`, original slot intact)
3. release the old slot lock
4. update the booking's scheduling fields (date/startTime/endTime/startTs/endTs/slotKey)
5. append to rescheduleHistory[] and increment rescheduleCount
— commit —
```

Order matters: acquire-new **before** release-old, both inside the transaction, so a failure at step 2
never leaves the booking with no lock. Because it reuses the create path's CAS, a reschedule racing
another booking for the target slot fails cleanly and leaves the original booking and its lock intact.
Future implementations MUST preserve this single-transaction, exactly-one-lock property (invariant §3.2).

---

## 5. `pending → completed` (convenience transition)

The deployed `providerCompleteBooking` permits completing directly from `pending` (not only
`confirmed`/`in_progress`) — a pragmatic path for providers who deliver a just-requested service without
an explicit confirm step. This contract **keeps** it as an allowed convenience transition (an implicit
confirm-then-complete) rather than a silent behavior. It still settles exactly once and still releases
the slot lock.

> **Compatibility note.** Retained in v1 because deployed production permits this transition. Removal
> would constitute a v2 lifecycle change, made only after operational evidence demonstrates the shortcut
> is unused. (Documenting reality, not an aspirational workflow — consistent with the Publication
> Contract philosophy.)

---

## 6. Non-transition operations & deferred policy

- **`providerContactCustomer`** is **not** a state transition — it returns/relays the customer's contact
  channel (or posts a message) for an active booking and leaves `status` unchanged. Documented here so it
  is never mistaken for a lifecycle edge.
- **Deposit/refund policy (deferred to D3+):** cancel-refund and no-show-forfeit semantics activate only
  once per-service **deposits** exist (D3). Until then, cancel/no-show simply release the slot with no
  money movement. When deposits land, the refund/forfeit rules attach to the `cancelled`/`no_show`
  transitions above — the state machine does not change, only the side effects.

---

## 7. Versioning

- **v1.0** — this contract (7 states, the transitions above, in-place reschedule).
- Additive ops that respect these states (e.g. `disputeBooking` that only reads, an auto-expiry job that
  drives `pending → cancelled` on a timeout) are **v1.x**.
- Changing a state's meaning, removing the `pending → completed` convenience, or adding a new state is
  **v2.0** (breaking) and requires re-approval.

An op is "compliant with Booking Lifecycle v1.0" only when its transitions are a subset of §2 and it
upholds every §3 invariant.
