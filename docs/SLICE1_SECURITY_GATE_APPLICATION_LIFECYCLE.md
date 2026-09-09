# Slice 1 — security gate: `application-lifecycle` self-approval reachability

**From:** `4a17401` · **Read-only.** No file modified, nothing merged, nothing deployed.

**Question:** can `applicationDecide` or `applicationReconcile` reach `applyDecision` in a way
that lets an application approve itself, given that two of the three deployed lineages lack the
guard added in `c4013d1`?

# 🟢 SECURITY-GATE-PASS

**Self-approval possible: NO** — in the deployed configuration, by traced control flow.
Not concluded from marker counts, and not from "the trigger runs the fixed build".

---

## The vulnerable code really is deployed

Confirmed, not assumed. In **both** older lineages the trigger calls:

```js
await applyDecision(appId, after, {});     // 2ba509b line 1136, ed1c16b line 1175
```

No `decidedBy`, and **zero** authority-guard markers in either file. That is precisely the
defect `c4013d1` describes — *"an application could approve itself — the guard was lost in
reconciliation."* `c4013d1` instead computes `authority`, and on failure writes
`projectionStatus: 'blocked_unauthorised_decision'`, raises an `adminAlerts` document, logs, and
**returns without calling `applyDecision`**.

So the question is entirely one of **reachability**.

## Every path to `applyDecision`, traced

| # | entry | guard | deployed lineage | reachable unguarded? |
|---|---|---|---|---|
| 1 | `applicationLifecycle` — Firestore trigger | `authority` check → refuse + alert | **`c4013d1`** (gen `ab2614e8`) | 🟢 **no — this is the fixed build** |
| 2 | `applicationDecide` — onCall | `_requireAdmin(req)` + `enforceAppCheck` | `ed1c16b` | 🟢 no |
| 3 | `applicationReconcile` — onCall | `_requireAdmin(req)` + `enforceAppCheck` | `ed1c16b` | 🟢 no |
| 4 | `applicationList` — onCall | — | `2ba509b` | 🟢 **never calls `applyDecision`** |
| 5 | `_internal.applyDecision` — test seam | — | — | 🟢 **`delete exports._internal` in `index.js:9921`** |

### Why the vulnerable bundles cannot fire the trigger

Each Cloud Run service declares exactly one entry point:

```
applicationlifecycle   build-function-target = applicationLifecycle
applicationdecide      build-function-target = applicationDecide
applicationreconcile   build-function-target = applicationReconcile
applicationlist        build-function-target = applicationList
```

And of **288** Eventarc triggers in the project, exactly **one** targets an application service:

```
applicationlifecycle-910566 → google.cloud.firestore.document.v1.written
```

`applicationdecide` and `applicationreconcile` carry the vulnerable trigger *code* in their
bundles, but nothing routes a Firestore write to it and their target is their own onCall. **Dead
code in a bundle is not an attack surface.**

*(The first Eventarc query, scoped to `us-central1`, returned zero and would have looked like
"no triggers exist". The triggers live elsewhere; the control against the all-locations list
caught it. A blind probe here would have produced a confident wrong answer.)*

### The onCall guards are identical in all three lineages

```
2ba509b   _requireAdmin ×4   enforceAppCheck ×3
ed1c16b   _requireAdmin ×4   enforceAppCheck ×3
c4013d1   _requireAdmin ×4   enforceAppCheck ×3

function _requireAdmin (req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Administrator access required.');
}
```

The `c4013d1` fix was to the **trigger**, not the callables — so the two older lineages were
never missing an onCall guard. An applicant reaching `applicationDecide` is refused before any
argument is read.

---

## ⚠️ The safety is topological, and that is a fragility worth recording

**This passes because of *where the trigger is registered*, not because the deployed source is
uniformly safe.** Two of three bundles contain exploitable code that is currently unreachable.

That protection would evaporate if any of the following happened, none of them exotic:

* the Firestore trigger were re-registered against a different application service;
* `applicationdecide` or `applicationreconcile` were redeployed with a trigger target;
* a future deployment shipped the older lineage to the `applicationlifecycle` service.

The last is the realistic one: **any redeployment of `applicationlifecycle` from a lineage other
than `c4013d1` reintroduces a live self-approval vulnerability.** That is an argument for
converging the three lineages — but as its own decision, not as a merge side-effect.

## Evidence classification

| claim | basis |
|---|---|
| vulnerable code present in 2 of 3 lineages | 🟢 source, byte-identified |
| trigger registered exactly once, to the fixed build | 🟢 live Eventarc + Cloud Run metadata |
| onCall paths admin-gated in all lineages | 🟢 source |
| `_internal` not deployed | 🟢 source (`delete exports._internal`) |
| no exploit executed against production | ⚪ **deliberately not attempted** — this is control-flow and topology evidence, not a live exploit test. No production credential was fabricated and no data mutated. |

---

## Candidate security effect

The candidate **preserves every guard**, matching `c4013d1` exactly:

```
_requireAdmin(req)        c4013d1 4   candidate 4
enforceAppCheck: true     c4013d1 3   candidate 3
blocked_unauthorised      c4013d1 2   candidate 2
decisionAuthority         c4013d1 2   candidate 2
```

It carries the fix rather than reintroducing the defect — and adopting it would remove the
topological fragility above by putting the guard in every lineage. **Not adopted here.**

---

## Next required scope

Full semantic review of `application-lifecycle.js`, against **`c4013d1`** as the production-side
authority for the trigger path — it is the only lineage whose trigger is actually registered.

The review must cover what this gate did not: intake patching, projection, role provisioning,
`buildIntakePatch`, `projectProvider` / `projectDriver`, registry writes, idempotency, and the
`applicationList` read surface. This gate answered one question only.

```
production deployed   NO
production mutated    NO
worktree              clean
files changed         NONE
```
