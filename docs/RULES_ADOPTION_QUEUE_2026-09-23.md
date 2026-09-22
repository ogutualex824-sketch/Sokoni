# Rules Adoption Queue — the 13, the other two surfaces, and the size constraint

**Date:** 2026-09-23 · **Tree:** `05c1f4e` · **Read-only. No ruleset deployed, no rules file edited.**
Supersedes nothing: extends [[SERVED_RULES_RECONCILIATION_2026-09-23]] (`5a84cf0`) with the
writer/reader/provenance census it listed as NOT DONE.

---

## 1 · Frozen baseline — three releases, treated independently

| release | ruleset | updated | served bytes | blocks |
|---|---|---|---|---|
| `cloud.firestore` | `6c67a34d-bb07-4fd5-8934-32d6b547a276` | **2026-09-22T20:19:30Z** | 158,659 | **702** |
| `cloud.firestore/sokoni-ops` | `c76c080c-5073-4b3d-94bc-53d6d8254516` | 2026-09-13T14:38:42Z | 672 | 1 |
| `firebase.storage/…` | `182624f3-7088-49de-ad72-a4c4701cb9f2` | 2026-08-11T05:18:05Z | 12,003 | 3 |

`ad2033ad` is **stale** and must not be used for further reasoning.

## 2 · sokoni-ops and Storage are IN SYNC — only the default DB has drift

Fetched and byte-compared against their tracked sources:

| surface | local source | served vs local |
|---|---|---|
| `firestore.rules.sokoni-ops` | 674 B | **IDENTICAL** |
| `storage.rules` | 12,327 B | **IDENTICAL** |

(Byte deltas against the served copies are CRLF line endings; content matches exactly.)

**Neither needs reconciliation.** The 13-block problem is confined to `cloud.firestore`.

---

## 2b · WHICH SIDE IS THE REFERENCE — and where the served ruleset came from

**Confirmed by the deploying session** (cross-session, 2026-09-23): `6c67a34d` was deployed at
**2026-09-22T20:19:30.344Z via the Rules REST API**, superseding
`ad2033ad-0d26-46d5-9646-1fa94554edc1`. My independently fetched `updateTime` of
`20:19:30.317Z` matches their deploy record to the second — the same event observed from two
directions.

It was assembled by **reconstructing from the deployed `ad2033ad` baseline**, plus 4 Connect
blocks and 16 deny guards — **not** from this branch's `firestore.rules`.

**That reframes the comparison, and the reframing matters:**

> "13 served-only blocks" is a statement about the **distance between this branch's local
> source and what is served**. It is **not** a claim that the served ruleset contains
> unexplained or rogue blocks.

The reference side is **this branch**. Production rules, like production functions, are a union
of lineages; measuring them against one branch describes that branch's position, not a defect in
production. Section 3's `commits=0` finding is exactly consistent: a ruleset reconstructed from
a *deployed* baseline will naturally carry blocks that never passed through this file.

**Count caveat:** the deploying session reports **729 blocks**; I measure **702**. The figures
are not comparable — mine counts only top-level `match /name/{…}` patterns via regex and
excludes nested and subcollection matches. Neither number is wrong; they measure different
things, and no conclusion here rests on the difference.

## 3 · The 13 — full census

**Provenance is unanimous.** `git log -S"match /<name>/" -- firestore.rules` over the entire
history returns **0 commits for all 13**. Not one has ever existed in this repository's tracked
rules. They are adoptions, not restorations.

**Writer/reader census** — ripgrep across all `.js`/`.html` including `functions/`, for the
collection name in any context, then narrowed to Firestore call sites.

| # | path | served | source | docs | writer | reader | history | disposition |
|---|---|---|---|---|---|---|---|---|
| 1 | **`userLocations`** | yes | no | 0 | **ACTIVE** — `addDoc`/`updateDoc`/`deleteDoc` | `getDocs` | external | **ADOPT** |
| 2 | `storeProvisioning` | yes | no | **2** | none found | none found | external | **DEFER — needs owner** |
| 3 | `courierQuotes` | yes | no | 0 | none found | none found | external | DEFER |
| 4 | `deliveryJobs` | yes | no | 0 | none found | none found | external | DEFER |
| 5 | `settlementHolds` | yes | no | 0 | none found | none found | external | DEFER |
| 6 | `deliveryDispatchMessages` | yes | no | 0 | none found | none found | external | DEFER |
| 7 | `landlordProfiles` | yes | no | 0 | none found | none found | external | DEFER |
| 8 | `tenantProfiles` | yes | no | 0 | none found | none found | external | DEFER |
| 9 | `merchantStories` | yes | no | 0 | none found¹ | none found | external | DEFER |
| 10 | `storyAllocations` | yes | no | 0 | none found | none found | external | DEFER |
| 11 | `riderRatings` | yes | no | 0 | none found | none found | external | DEFER |
| 12 | `productReportSummaries` | yes | no | 0 | none found | none found | external | DEFER |
| 13 | `resolutions` | yes | no | 0 | none found² | none found | external | DEFER |

¹ The only textual hits are `merchantStoriesFor(uid)` in `functions/stories-capability.js` — a
**function name**, not the collection. False positive, excluded.
² Searched in collection context (`collection('resolutions')`, `doc(db,'resolutions')`,
`'resolutions/'`) because the bare word is too common to grep. No match.

**Positive control:** the same search *did* find `userLocations` in `sokoni-buyer-locations.js`
and `merchantStoriesFor` in `stories-capability.js`. "No writer found" is therefore a
measurement, not a detector that cannot see.

### 3.1 · `userLocations` — the case that settles the method

- Writer: `sokoni-buyer-locations.js` — `COL = 'userLocations'`, `SUB = 'places'`, with
  `addDoc` (129), `updateDoc` (125), `deleteDoc` (136), `getDocs` (107, 145).
- Loaded in production: `merchant-v2.html:753` — a real `<script src>`, not a mention.
- Production documents: **0**.

So this collection has an **active, shipped writer and zero documents**. Had the rule been
dropped because it looked empty, buyer saved-addresses would have broken the first time anyone
saved one — and the cause would have been a rules block nobody noticed vanishing.

**This is the concrete proof that "empty today" is not "safe to drop."** One of thirteen was
enough to make the difference, and it was the one with no documents at all.

A second detail sharpens it. `sokoni-buyer-locations.js:24-25` states the path is *"owned by
the buyer alone, **enforced in firestore.rules**"*. That enforcement has **never** been in this
repository's `firestore.rules`. The protection is real — it is in the served ruleset — but the
module documents a guarantee its own repository cannot evidence.

### 3.2 · `storeProvisioning` — not yet classifiable

| id | created | updated | fields |
|---|---|---|---|
| `SELLER_A` | 2026-09-07T19:34:54Z | never | `storeId, uid, startedAt, businessId` |
| `SELLER_A_uid_7f3` | 2026-09-07T20:44:14Z | never | `businessId, uid, startedAt, storeId` |

Both created the same evening ~70 minutes apart, **never updated in 16 days**, with ids that
are not Firebase uids (a uid is 28 chars; `SELLER_A` is a literal placeholder). No writer and
no reader anywhere in the codebase.

That is consistent with test fixtures — but "consistent with" is not "confirmed", and the
instruction was explicit not to call them fixtures yet. **Unresolved:** who created them, and
whether any out-of-repo provisioning path still reads them. **DEFER — needs owner.**

---

## 4 · The size constraint is real, and points at the wrong file

| artifact | bytes | % of 256 KiB |
|---|---|---|
| `firestore.rules` (source) | 276,984 | **105.7% — over the limit** |
| `firestore.rules.build` | 167,225 | 63.8% |
| served | 158,659 | 60.5% |

**The source → build reduction is entirely legitimate.** Measured, not assumed:

| removed | bytes |
|---|---|
| comments | 62,028 |
| blank lines | 1,749 |
| leading indentation | 44,571 |
| **total explained** | **108,348** |

Block count is **712 in both**, with **zero blocks in one and not the other**. The build is a
faithful minification; no semantic content is lost, and the 13 are genuinely absent from both.

### 4.1 · `firebase.json` points at the artifact that cannot deploy

```json
{ "database": "(default)", "rules": "firestore.rules", … }
```

It references the **source** (105.7%), not the build (63.8%). `build-firestore-rules.js` writes
`firestore.rules.build`, which `firebase.json` never mentions.

So a CLI rules deploy would send the oversized source and be rejected — and the build, which
would fit comfortably, is not what the CLI would send. **The size blocker is a wiring problem
as much as a volume problem.**

### 4.2 · Served matches neither local artifact

Served is 158,659 B / 702 blocks. Source and build are both 712 blocks. Whatever produced the
09-22 release was not either of these files, which is consistent with §3's finding that the 13
have no history here.

---

## 5 · Adoption decisions

| decision | count | basis |
|---|---|---|
| **ADOPT** | 1 — `userLocations` | active shipped writer, documented dependency, zero docs |
| **DEFER — needs owner** | 12 | no writer in this repo, but authorship is external, so "no writer here" cannot prove "no writer anywhere" |
| **RETIRE** | 0 | nothing has evidence sufficient to retire |

**Nothing is retired on this evidence.** Twelve collections having no writer *in this
repository* is not proof they have none — their rules were authored outside it, so their
writers may live outside it too. Retirement needs an owner who can say what the block was for.

---

## 6 · Not done

- No rules file edited. No ruleset created or deployed.
- The 12 DEFER blocks have **not** been read line by line; adoption requires that.
- Whether `storeProvisioning`'s documents are fixtures: **unconfirmed**.
- The **23 source-only blocks** (present locally, never served) are the mirror question and are
  untouched here. Whatever they protect is currently governed by default-deny.
- No emulator authorization matrix was run against any proposed change.
