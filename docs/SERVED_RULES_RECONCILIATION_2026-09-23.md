# Served-Rules Reconciliation — the 13 served-only blocks

**Date:** 2026-09-23 · **Tree:** `05c1f4e` · **Read-only. No rules deployed, no rules edited.**
**Objective:** reconcile the served-only blocks — *not* deploy source over them.

---

## 1 · The served ruleset is not what the record says

Re-fetched live via the Rules REST API, as the standing rule requires.

| | |
|---|---|
| release | `projects/sokoni-aeb26/releases/cloud.firestore` |
| **ruleset** | **`6c67a34d-bb07-4fd5-8934-32d6b547a276`** |
| updated | **2026-09-22T20:19:30Z** |
| size | 158,659 B |

The release record carries **`ad2033ad` (09-20)**. That is **stale** — rules were redeployed on
09-22. Any reasoning that assumed `ad2033ad` is the served ruleset needs re-checking.

`firestore.rules.live` on disk is dated **Aug 11** and is stale by six weeks. It was not used.

Three releases exist, so the default DB is not the whole picture:

| release | updated |
|---|---|
| `cloud.firestore` | 2026-09-22T20:19:30Z |
| `sokoni-ops` | 2026-09-13T14:38:42Z |
| `sokoni-aeb26.firebasestorage.app` | 2026-08-11T05:18:05Z |

**This reconciliation covers `cloud.firestore` (the default DB) only.**

## 1b · Which side of the comparison is the reference

**Added 2026-09-23 after confirmation from the deploying session.** `6c67a34d` was deployed
at 2026-09-22T20:19:30.344Z via the Rules REST API, superseding `ad2033ad`, and was assembled
by reconstructing from the **deployed** `ad2033ad` baseline plus Connect blocks and deny
guards — not from this branch.

So every "served-only" figure below is **the distance between this branch and production**, not
evidence that the served ruleset holds unexplained blocks. The reference side is this branch.
See [[RULES_ADOPTION_QUEUE_2026-09-23]] §2b.

## 2 · The three artifacts disagree

| artifact | bytes | % of 256 KiB | top-level blocks |
|---|---|---|---|
| `firestore.rules` (source) | 276,984 | **105.7% — deploy REJECTED on size** | 712 |
| `firestore.rules.build` | 167,225 | 63.8% | 712 |
| **served** | 158,659 | 60.5% | **702** |

Source and build hold the same 712 blocks; source is larger only because the build strips
comments. **Served has 702** — a different set, not a subset.

- **13 blocks are served-only** (absent from source *and* build)
- **23 blocks are source-only** (present locally, never served)

## 3 · Risk direction: breakage, not exposure

There is **no global catch-all**. The only `document=**` in served is the scoped
`match /tenants/{tenantId}/{document=**}`; source's second occurrence is inside a comment
explaining the deliberate absence.

Firestore denies when no rule matches. So a served block that disappears makes its collection
**inaccessible** — a functional break, never a data leak. That is the safe direction, and it
means the cost of getting this wrong is an outage, not a disclosure.

## 4 · Do the 13 protect live data?

Probed read-only against the production default DB.

| collection | production |
|---|---|
| `courierQuotes` · `deliveryDispatchMessages` · `deliveryJobs` · `landlordProfiles` · `merchantStories` · `productReportSummaries` · `resolutions` · `riderRatings` · `settlementHolds` · `storyAllocations` · `tenantProfiles` · `userLocations` | **empty** (12) |
| `storeProvisioning` | **has data — 2 documents** |

**Positive controls pass.** `users`, `products` and `orders` all return data through the same
probe, so "empty" is a measurement and not a detector that cannot see.

`storeProvisioning`'s two documents are named **`SELLER_A`** and **`SELLER_A_uid_7f3`** — those
read as **test fixtures**, not production records. That should be confirmed before it is
treated as live data.

## 4b · They were never in this repo's source — at any commit

A pickaxe search (`git log -S"match /<name>/" -- firestore.rules`) over the full history
returns **0 commits** for every one of the six blocks sampled: `courierQuotes`, `deliveryJobs`,
`settlementHolds`, `merchantStories`, `tenantProfiles`, `storeProvisioning`.

So these are not blocks that were written and later deleted. **No commit in this repository's
history of `firestore.rules` has ever contained them.** They reached production from outside
this file's tracked lineage — another branch, another worktree, or a hand-edited deploy.

That matters for the disposition: porting them into source is not "restoring" anything. It is
**adopting rules whose authorship and intent are not recorded here**, which is a reason to read
each block before adopting it rather than pasting all 13 in bulk.

## 5 · What this means

Deploying the current build over served would silently drop 13 blocks. On today's evidence
that breaks nothing, because 12 of the collections are empty and the 13th appears to hold
fixtures.

**But "empty today" is not "safe to drop."** A collection with no documents may still have a
deployed writer that has not run yet — `settlementHolds`, `deliveryJobs` and `courierQuotes`
are all named like live features. The first time such a feature runs, it would be denied, and
the cause would be a rules block nobody noticed vanishing.

### Recommended disposition

| Action | Blocks |
|---|---|
| **Port into source** — cheap, preserves behaviour exactly, removes the divergence | all 13 |
| **Then retire deliberately** — with a writer census per collection, as separate decisions | any that prove to have no writer |

Porting first and retiring second is the order that cannot cause an outage. Retiring first
relies on "empty today" holding true forever.

**The 23 source-only blocks are the mirror question** and are *not* covered here: they have
never been served, so whatever they protect is currently governed by default-deny.

## 6 · The size blocker is separate and unresolved

Source cannot be deployed at all — 276,984 B is **105.7%** of the 256 KiB limit. The build
(63.8%) is the only deployable artifact, and it is the one missing the 13.

> **CORRECTION, added 2026-09-23.** "The build is the only deployable artifact" was too kind to
> the current wiring. `firebase.json` points the default DB at **`firestore.rules`** — the
> oversized source — and never references `firestore.rules.build`, which
> `build-firestore-rules.js` writes. A CLI deploy would therefore send the artifact that gets
> rejected, while the one that would fit is not wired in at all. See
> [[RULES_ADOPTION_QUEUE_2026-09-23]] §4.1.

So reconciliation cannot be completed by "deploy the source". It requires either porting the 13
into source and rebuilding, or an explicit decision to retire them.

## 7 · Not done

- Nothing deployed. No ruleset created. No local rules file edited.
- The `sokoni-ops` ruleset (09-13) was **not** examined.
- Storage rules (08-11) were **not** examined.
- No writer census was run for the 13 — that is the input to any retirement decision.
- Whether `storeProvisioning`'s two documents are fixtures or real is **unconfirmed**.
