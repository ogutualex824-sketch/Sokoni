# Cloud Function Consolidation Programme

**Status:** started 2026-08-19 · **Gate:** `scripts/verify-architecture.js` · **Blocks:** the subscription release deploy

Related: [[Payments]] · [[SmartPOS]] · [[Marketplace]] · [[Authentication]]

---

## Why this exists

`verify-architecture` fails:

```
CF export count 1692 exceeds HARD budget 1480 — consolidate before deploying.
```

It is **not** a regression from any recent change. Measured:

| | count |
| --- | --- |
| Exports in source (runtime enumeration) | 1692 |
| Functions **deployed in production** (`functions:list`) | 1691 |
| HARD budget | 1480 |
| **Must remove** | **212** |

Production has been running ~211 over budget for some time. The budget guards the
~1500 Cloud Run vCPU ceiling this project has already hit once, so it is a real
capacity constraint, not a style rule — but it is a *standing* condition, and
clearing it is a programme, not a release step.

---

## What can and cannot move

Measured by `scripts/cf-consolidation-candidates.js`:

| Kind | Count | Can consolidate? |
| --- | --- | --- |
| `onCall` | 1734 | **Yes** — behind a dispatcher (13 already exist) |
| triggers / schedules / http / storage | 313 | **No** — each binds to its own event |

Two hard invariants constrain every step:

1. **A dispatched op must stop being individually exported.** `verify-architecture`
   enforces "no dispatched op double-exported", so consolidation *removes* the old
   name. Every client call site must move in the same change.
2. **An orphan aborts the next deploy.** A function deleted from source but still
   deployed blocks deployment until explicitly deleted in the console/CLI.

A third, softer constraint decides sequencing: **cached PWA clients**. A browser
holding yesterday's HTML still calls the old name. Code references are therefore
necessary but not sufficient evidence — production invocation data is.

---

## The shape of the answer

`scripts/cf-reachability.js` classifies every `onCall` by whether anything can
reach it. A name counts as reachable if a client file **or** another server module
references it; modules that build callable names dynamically are excluded wholesale.
"Mentioned only in docs/tests" is reported but never treated as reachable.

```
total onCall examined                    : 1734
NO reference anywhere but its own module :  180
target reduction                         :  212
```

So the overage is mostly **unreferenced surface**, not functions needing clever
merging. The programme is therefore primarily *removal*, with dispatcher
consolidation making up the remainder.

Largest unreferenced populations:

| Module | onCall | client-ref | server-ref | no reference |
| --- | --- | --- | --- | --- |
| `finance-os-sprint43` | 37 | 20 | 0 | **17** |
| `marketplace-extensions` | 30 | 14 | 0 | **16** |
| `index` | 55 | 38 | 18 | **14** |
| `pos-inventory-pro` | 21 | 9 | 2 | **12** |
| `analytics-engine` | 33 | 22 | 0 | **11** |
| `logistics-plus` | 30 | 19 | 0 | **11** |
| `marketing-engine` | 11 | 1 | 0 | **10** |
| `property-hub` | 12 | 2 | 0 | **10** |

---

## Phases

### Phase 0 — evidence (in progress)

* `scripts/cf-inventory.js` — the real export population, grouped by origin
* `scripts/cf-consolidation-candidates.js` — what can move, and its blast radius
* `scripts/cf-reachability.js` — what nothing references
* **Production invocation history** — Cloud Logging over the retention window, so
  "unreferenced in source" can be upgraded to "not invoked in production"

A function is only a removal candidate when it is **unreferenced in source AND
un-invoked in production**. Either alone is insufficient: source can miss a cached
client, and logs only cover the retention window.

### Phase 1 — remove the provably unused

Per module, in ascending blast-radius order. Each step: remove from source, deploy,
delete the orphaned deployed functions, re-measure. Never batch two modules into one
deploy — an aborted deploy should name one cause.

### Phase 2 — dispatcher consolidation

For the remainder, follow the existing pattern (`bookingDispatch` and the other 12
dispatchers): one `onCall` taking an `op`, with every client call site moved in the
same change and the individual exports deleted.

### Phase 3 — re-measure and lower the ratchet

Once under 1480, keep it there: the budget already warns at 1350.

---

## Risks

| Risk | Control |
| --- | --- |
| Cached PWA client calls a removed function | require zero production invocations over the full retention window, not just zero code references |
| Orphaned function aborts a later deploy | delete orphans explicitly as part of the same step |
| A dispatched op left double-exported | `verify-architecture` already fails on this |
| Deleting something a scheduled job calls | reachability counts server-to-server references |
| Dynamic callable names evade the analysis | whole module excluded when it builds names at runtime |

---

## Standing decision

Nothing in this programme is deleted on the strength of static analysis alone, and
no removal is bundled into a release whose purpose is something else. The
subscription release stays undeployed until the budget is met.

---

## Open

- Production invocation history not yet joined to the 180 candidates.
- Retention window for the `_Default` log bucket not yet confirmed; if it is 30
  days, a function used quarterly would look dead. Seasonal/rare functions need a
  longer signal than logs can give — candidates in that class must be reviewed by
  a human who knows the product.
