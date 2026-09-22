# Live-lineage port — failure classification

> **Tree:** `release/comms-on-live` @ `d9eb524`, base `111dbd7` · **Dated:** 2026-09-22
>
> Every failure on the ported tree, classified before any of it was fixed. The rule applied
> throughout: *the invariant is sacred, the count is diagnostic.*

## Connect authority — 15 failures, none a behavioural defect

| # | Assertion | Cause | Action |
|---|---|---|---|
| 1–3 | `admin-os.html` loads the console / as a tab / loads the write surface | **PAGE_MISSING** | port `admin-os.html` hunk |
| 4–11 | `super-admin.html` console, write surface, Connect nav item, panel, mount point, loader, nav dispatch, missing-module reporting | **PAGE_MISSING** | port `super-admin.html` hunk |
| 12 | the intent is registered in the canonical engine | **REAL_PORTING_DEFECT** | **fixed** — see below |
| 13–14 | the composite index / the signals index is DECLARED | **DEPENDENCY_MISSING** | `firestore.indexes.json` |
| 15 | the read path is the one the rules already authorize | **DEPENDENCY_MISSING** | `firestore.rules` |

### The port needs NINE browser surfaces, not seven

`admin-os.html` and `super-admin.html` were not in the original seven. Both exist live with
substantial live-only work (84 and 78 live-only lines), so both are hunks, never replacements.

### #12 was a defect in my own hunk — fixed

`notify.js` registers `connect_incoming_call` in its intent table on the source branch. My anchor
hunk ported the business-anchor fields and **missed the intent**. `connect-notify` names an
intent and never a channel, so without the registration the incoming-call notification has no
entry in the canonical engine. Registered, with `smsTemplate: null` preserved — a call that
cannot reach a push token must not silently become an SMS. Authority failures 15 → 14.

## Two deployment artefacts are absent from the live lineage

This is the most consequential finding in the classification, and it is **not** a test problem.

| Artefact | Live | Source | Consequence |
|---|---|---|---|
| `firestore.rules` — `connectSessions` block | **0 occurrences** | 1 | a browser could write session documents directly |
| `firestore.indexes.json` — `connectSessions` indexes | **0** | present | the incoming-call listener query has no index |

Verified with a positive control: the same detector finds `match /conversations`,
`match /packageRequests` and `match /shops` in the live ruleset, and finds `connectSessions` on
the source branch. The absence is real, not a broken search.

**Connect must not be deployed to production before its rules are.** `scripts/test-connect-rules.js`
(37/0 on the source branch) exists precisely because `connect-calls.js` derives participants from
an anchor while *nothing in that file stops a browser writing `connectSessions/{id}` and adding
itself* — only a rule stops that, and only an emulator proves the rule.

Rules deployment is governed by its own gate and its own lineage history, which this port does
not touch. It is recorded here as a **release blocker**, not repaired in passing.

## Remaining page-class failures

| Suite | Result | Cause |
|---|---|---|
| communication engine | 531/37 | PAGE_MISSING — store, support, help, admin-os, super-admin |
| shop inquiry | 14/13 | PAGE_MISSING — `store.html` |
| shop boundary | 30/4 | PAGE_MISSING — `store.html` |
| health honesty | 9/12 | PAGE_MISSING — `support.html`, `status.html` |
| outbox | 163/2 | to be diagnosed after the pages; expected to be browser-surface, not the Firestore integration (34/0) |

## Classification summary

```
PAGE_MISSING                   11  +  the page-class suites above
REAL_PORTING_DEFECT             1  (fixed: notify connect intent)
DEPENDENCY_MISSING              3  (rules ×1, indexes ×2)
LIVE_LINEAGE_DIFFERENCE         0  in this batch
TEST_VOCABULARY_MISMATCH        0  in this batch
LEGITIMATE_BEHAVIORAL_DIFF      0  in this batch
```

The earlier `PLANS.BUSINESS` finding remains the only **TEST_VOCABULARY_MISMATCH** of the port,
and the only place a test was adapted rather than an implementation fixed.
