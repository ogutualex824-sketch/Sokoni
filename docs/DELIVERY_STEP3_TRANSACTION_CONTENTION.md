# Step 3 — Transaction Contention Investigation

**Status:** INVESTIGATION ONLY — zero production writes, no migration, no fix applied
**Verdict:** 🟡 **AMBER** — every proposed cause is now *eliminated by evidence*, and the true cause is not reproduced
**Date:** 2026-09-13
**Related:** [[DELIVERY_RAIL_CONVERGENCE]] · CHANGELOG entry 45

---

## 1. Observed failure

During the stale-`suspendedAt` migration (CHANGELOG 45), `db.runTransaction` invoked its callback
**5 times** before committing — 4 aborted attempts. The content-equality precondition **passed on
every attempt**, and post-verification showed exactly one field removed from each document.

```
preconditions: all PASSED on the transactional snapshot     ×5
COMMITTED: true
```

### Exact transaction

| | |
|---|---|
| Read set | `drivers/D5Ql2EYr95…`, `rideDrivers/D5Ql2EYr95…` (single `tx.getAll`) |
| Write set | the same two documents, `tx.update({ suspendedAt: FieldValue.delete() })` |
| Preconditions | inside the transaction: shape checks + byte-equality of normalised content vs a pre-read |

### The distinction that governs this investigation

**Firestore aborts a transaction when a document in its read set changes `updateTime` — not when
its content changes.** A writer rewriting *identical* values still bumps `updateTime`. That would
abort the transaction while leaving the content-equality precondition passing — precisely the
signature observed. This made "a writer wrote identical content" the leading hypothesis.

---

## 2. Known writers of the two documents

| Writer | Path | Scheduled? | Status |
|---|---|---|---|
| `application-lifecycle.js:534-535` `projectDriver` | both | no — approval-driven | not running |
| `dispatch.js` 242, 392, 454, 487 | `rideDrivers` | no — dispatch-driven | `dispatchQueue` is **empty** |
| `navigation.js` 205, 404, 597 | `drivers` | no — trip-driven | no trips |
| `processCascadeTimeouts` | `rideDrivers` | **every 1 minute** | returns early — `dispatchQueue` empty |
| `emailOnDriverStatusChange` | reads `drivers` | trigger | **writes nothing back**; early-returns when `status` unchanged |
| `sokoni-db.js:847` `setDriverOnline` (client heartbeat, 60 s) | `rideDrivers` | client | **see §3** |

---

## 3. Hypotheses eliminated

### 3a. Client heartbeat — ELIMINATED by two independent lines of evidence

`driver.html:2073` heartbeats every 60 s via `SokoniDB.setDriverOnline`, which writes:

```js
{ driverId, uid, isOnline, vehicleType, lat, lng, updatedAt: serverTimestamp(), ...extra }
```

The live `rideDrivers/D5Ql2EYr95…` document contains **none of `driverId`, `lat`, `lng`,
`lastPing`**. `setDriverOnline` has therefore **never written this document** — field archaeology,
independent of any timing argument. And it writes `updatedAt: serverTimestamp()` plus a changing
`lastPing`, so had it run, the content-equality precondition would have **failed**, not passed.

### 3b. Any competing writer at all — ELIMINATED by direct measurement

`updateTime` on both documents was polled over 60 s (6 samples):

```
drivers      0 changes
rideDrivers  0 changes
```

Both documents still carry `updateTime = 2026-09-13T16:18:04.255Z` — **the migration's own write**.
Nothing has written either document since. No competing writer exists to cause an abort.

### 3c. Ongoing read-set contention — DOES NOT REPRODUCE

Read-only transactions over the identical read set (zero mutations committed):

| Instrument | Result |
|---|---|
| `maxAttempts: 1` × 8 | **8/8 succeeded on the first attempt** |
| default retry policy × 3 | **3/3 with `attempts = 1`** |

`maxAttempts: 1` matters: it forces the SDK to surface the real error code instead of silently
retrying. No `ABORTED` was produced.

---

## 4. Why the emulator cannot settle it — a harness limit, proven not assumed

A controlled reproduction was attempted in an isolated emulator: seed both documents, run the exact
transaction shape, and drive a competing writer during the read→commit window.

It never retried. Rather than tune the window indefinitely, the emulator's concurrency semantics
were measured directly:

```
baseline writes in 1000ms (no transaction):  141
writes during a 1000ms transaction:            2
transaction attempts:                          1
```

The competing writer's throughput **collapsed from 141/s to 2/s** while the transaction held the
document, and the transaction committed in one attempt. **The emulator serialises with LOCKS; it
does not model production's optimistic-concurrency aborts.** It therefore cannot reproduce this
failure at all, and no window-widening would have helped.

This also invalidates the first reproduction run, where competing writes simply never landed inside
the window — that measured the harness, not Firestore.

---

## 5. Root-cause confidence

| Hypothesis | Status | Evidence |
|---|---|---|
| Client heartbeat | **ELIMINATED** | absent fields on the document; would have failed the precondition |
| Any competing writer | **ELIMINATED** | `updateTime` unchanged over 60 s; still at the migration's own write |
| Scheduled function | **ELIMINATED** | `processCascadeTimeouts` early-returns on empty `dispatchQueue` |
| Trigger write-back | **ELIMINATED** | `emailOnDriverStatusChange` writes nothing; early-returns |
| Read-set contention | **NOT REPRODUCED** | 8/8 and 3/3 single-attempt |
| **Transient transport retry** | **UNPROVEN — most probable remaining** | see below |
| Application race | **NO EVIDENCE** | no second writer exists to race with |

**The most probable remaining explanation is transient transport retries, not contention.**
`runTransaction` in the Node SDK retries on more than `ABORTED` — `UNAVAILABLE` and internal
transport errors are also retryable, and each retry re-invokes the callback, which would print
"preconditions passed" every time. The measured round-trip to `nam5` is **~1.4 s per transaction**,
which is consistent with a high-latency link where transient retries are unremarkable.

**This is a hypothesis, not a finding.** Distinguishing it requires capturing the per-attempt error
code on a transaction that actually *writes* — and that is a production write, which this gate
forbids.

---

## 6. Production impact

**None observed, and none plausible.** The retries were invisible: the transaction committed, the
preconditions held on every attempt, post-verification confirmed exactly one field removed from each
document with zero other fields changed, and the subsequent census showed the intended
reclassification and nothing else. Retrying is the SDK behaving correctly, not a defect surfacing.

---

## 7. Proposed fix

**None — do not fix what is not demonstrated.** Retrying five times and committing correctly is
within normal `runTransaction` behaviour.

What should change is **instrumentation, not logic**. The migration logged only "preconditions
passed" per attempt and never recorded *why* it retried. Any future migration of this shape should:

1. record the **attempt number and the error code** that caused each retry (`maxAttempts: 1` in a
   loop, or an explicit retry wrapper), and
2. record each read document's **`updateTime`** per attempt — that, not content, is what Firestore
   aborts on, so it is the only field that can explain an abort.

With those two, this investigation would have been a log read rather than a census.

---

## 8. Verdict

🟡 **AMBER.** Contention did not reproduce; every specific hypothesis is eliminated by direct
evidence; the emulator is structurally incapable of reproducing the failure; and the remaining
explanation is unproven because proving it requires a production write this gate forbids.

**Recommendation:** close as *benign, unexplained, instrumented-next-time*. Re-open only if a future
transaction on these documents retries **and** the new instrumentation names an `ABORTED` code — at
which point the cause is a real writer and this document's eliminations narrow the search
immediately.
