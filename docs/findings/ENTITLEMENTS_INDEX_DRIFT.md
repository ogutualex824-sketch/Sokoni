# Index drift — `entitlements (purpose, status, expiresAt)`

**Read-only investigation. Nothing synced, nothing deleted, no index or config changed.**
2026-08-28 · blocks `npm run predeploy` on `fix/ledger-settlement-state`

---

## Verdict: REQUIRED BY PENDING WORK, MISSING FROM THE MAINLINE SOURCE

**Not obsolete. Do not delete it.**

```
production (deployed) : 409 composite indexes
tracked in source     : 406
UNTRACKED (a deploy would DELETE) : 1
    entitlements | purpose:ASCENDING, status:ASCENDING, expiresAt:ASCENDING
```

**It is declared on `fix/boost-ranking-entitlement`, commit `5485527`** — *"feat(boost): boost
ranking entitlement — a paid boost actually features the listing (Approach A)"* — which adds exactly
`collectionGroup: entitlements` with `purpose`, `status`, `expiresAt`.

That branch has **not landed** on the live lineage. The index reached production; its source
declaration did not. So the mainline manifest is missing a declaration for an index a pending
feature needs.

## Evidence

**Pre-existing, not caused by the ledger change.** Control: the parent commit `9c2af67`, with the
settlement-state change absent, produces the identical 409/406/1 result, and `dde64d9` touches no
index file.

**No current consumer, and it indexes nothing today.**

* Every `entitlements` access in `functions/` is `.doc(uid)` — a document read or write, never a
  filtered query.
* The only two queries in the repo are `subscription-os.html:493`
  (`where('riskScore','>',60)`) and `:732` (`orderBy('updatedAt','desc')`). Neither uses these fields.
* **No live document carries `purpose` or `status`.** All 5 sampled `entitlements` docs hold
  `subscriptionStatus`, `active`, `plan`, `premium`, `expiresAt` — and a composite index only
  includes documents that have *every* indexed field. It currently indexes **zero documents**.

**Source declares two other `entitlements` indexes** — `(needsRefresh, updatedAt)` and
`(riskScore, updatedAt)`, both marked `legacy: true` in `docs/index-registry.json`. Neither is this
one.

## Why "indexes nothing today" is not a reason to delete it

The Boost entitlement feature writes `purpose`/`status` when it lands. The index is empty **because
the feature that populates those fields has not shipped**, not because it is dead. Deleting it would:

* silently break the branch's query the moment it lands, with `9 FAILED_PRECONDITION` — the same
  failure mode that hid `posGetQueueMetrics` for its whole life;
* require rebuilding the index, which is not instant (the `posCheckoutMetrics` build took minutes);
* and it is the one direction that is hard to undo safely.

Keeping it costs effectively nothing: an index over documents that match no field has no write
amplification.

## Options

**A. Adopt into source — recommended.** Declare it in `firestore.indexes.json` and add a registry
entry citing `5485527` / `fix/boost-ranking-entitlement` as provenance. Production is unchanged,
tracked becomes 407-of-409-consistent for this entry, the deploy stops threatening to delete it, and
the pending feature keeps its index.

**B. Delete from production.** Only if Boost ranking is being abandoned. Requires that decision
first — it is a product call, not an index cleanup.

**C. Leave the drift.** Predeploy stays red on every branch, and the next person is tempted to run
`--sync` blindly, which is how an index gets dropped by accident.

## Recommendation

Take **A**, as a **separately reviewed change** — not folded into the ledger prerequisite, and not by
running `--sync` to make a gate green. The registry entry should record that the index arrived in
production ahead of its source declaration, so the provenance is legible later.

Worth noting for the Boost workstream: this is the second artefact of that feature found in
production ahead of its lineage. It suggests the Boost branch was deployed from at least once.

## Not done here

No `--sync`. No deletion. No index, manifest, registry or config file modified.
