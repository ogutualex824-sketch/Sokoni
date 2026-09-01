# Firestore Rules reconciliation — repo artifact vs served `59af870d`

**Status:** reconciliation mapped and the deficit repaired in the artifact. **NOT PUBLISHED.**
**Served ruleset:** `59af870d-72eb-4791-a3b6-2f4de7eb8ff7`, file `firestore.rules.release-minimal`
(252,640 B), re-fetched 2026-09-02 and unchanged.
**Artifact:** `firestore.rules` in the Release 1 tree (`release/r1-pos-printer-fn`).

---

## 1. Two candidates, and they are not equivalent

| candidate | `shopEmployees` anchor | `products` `isSeller()` |
|---|---|---|
| **release tree** (`6775b09` lineage) | was **LOST** → now **RESTORED** | **KEPT** |
| primary tree (`fa5082b` proposal) | **LOST** | **LOST** |

The primary tree's artifact — the one previously described as "the repo rules" — loses **both**
live protections. The release tree's loses only one. **Only the release tree's artifact is a
viable publication candidate**, and only after the repair below.

## 2. The deficit, and the repair

Exactly one protection was missing. Restored **verbatim from the served ruleset**, not re-derived:

```
allow update: if isAdmin()
              || (isAuthed() && resource.data.shopOwnerId == request.auth.uid
                  && request.resource.data.shopOwnerId == resource.data.shopOwnerId);
```

`shopOwnerId` is the tenant anchor. Without pinning it across an update, the holder of a
membership row can repoint it at another shop and inherit that shop's employee authority — the
escalation recorded in `docs/findings/SHOPEMPLOYEES_ESCALATION.md`.

**Post-repair: both live protections are KEPT.**

## 3. Everything else the comparator flagged was a false positive

A line-exact comparator reports a *reformatted* line as a removal. Each was checked
**semantically**, not by text:

| block | flagged | actual |
|---|---|---|
| `posPrintJobs` | 1 line | **ADDITIVE** — keeps the served clause, appends a shop-owner path; the trailing `;` moved |
| `conversations` / `messages` | 4 + 4 lines | **NARROWING** — `inConvo()` present in both; join-time scoping tightens the read |
| `databases` | 4 lines | not a collection — the comparator matched `match /databases/...` inside `get()` paths |
| `shopEmployees` | 1 line | only the served *comment* text; the clause itself is present |

**Net: the artifact removes nothing from production.**

## 4. What publication would ADD

Three collections absent from served, purely additive: `userLocations`, `merchantStories`,
`storyAllocations`.

## 5. Still to do before any publication

- **`posTransactions`** — identical to served today. ADR-013 leaves it client-authoritative;
  tightening it is a *Rail 2* decision, not a rules-reconciliation decision. Not changed here.
- **`inventory`** — absent in served *and* in the artifact. The POS branch-inventory write is
  therefore still denied in production (P20B made that denial observable). Adding a rule is an
  inventory-model decision, unresolved. Not added here.
- **AdminOS / SuperAdmin paths** — `adminLog` is identical to served. The admin convergence
  integrated in `9a7227e` is a client-side claims guard and needs no rules change.
- **Compiled-size ceiling** — the served ruleset sits near the limit; the repair adds one
  condition plus comments. Compiled cost is structural rather than character count, but this is
  **UNPROVEN** until a real publish attempt or a compile check.
- **Rules test suites** — the `test-*-rules.js` suites need the Firestore emulator. **Not yet run
  against the repaired artifact.**

## 6. Boundary

Not published. `firebase deploy --only firestore:rules` has NOT been run. Publication remains
gated on the compile check, the emulator rules suites, and an explicit operator decision.
