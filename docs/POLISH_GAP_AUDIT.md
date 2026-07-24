# SOKONI — Polish Gap Audit

**Purpose.** Classify the pre-beta polish areas so effort goes where it actually
pays. Started 2026-07-24.

**Why this exists.** A feature-shaped roadmap assumed things were missing that
turned out to be built (image swipe, lightbox, voice search) and assumed things
worked that turned out to be broken (Algolia indexing). Neither is visible from
reading the roadmap or the code. This document separates the two.

This is a **reliability document**, not a checklist: a row can move backwards.

---

## Status — what we believe

| Status | Meaning | Priority |
|---|---|---|
| 🔴 **Built but broken** | Runtime evidence disproves it | **Highest** |
| 🟠 **Built but fragile** | Works, but no recovery path / no resilience | High |
| 🟡 **Partly verified** | Some legs proven, others not | Medium |
| ⬜ **Missing** | Never implemented | Depends on roadmap |
| ✅ **Built** | Verified working | Monitor only |
| ❔ **Unaudited** | Not examined — **not** a claim either way | — |

## Evidence quality — why we believe it

Tracked **separately from status**, so a static code review can never be read as
equivalent to a successful production run.

| Level | Meaning |
|---|---|
| **Runtime** | Observed in production or a controlled end-to-end test |
| **Integration** | Verified across components in a test environment |
| **Static** | Code inspection only |
| **None** | Not yet examined |

## Governing rules

1. **A row without evidence is ❔, never ✅.** "I read the code and it looks
   right" is Static, and Static alone caps a row at ❔.
2. Only **Runtime** or **Integration** may justify ✅ or 🔴.
3. **Last Verified is part of the claim.** Evidence expires; an undated ✅ is an
   assumption wearing a tick.
4. **Corrections stay visible.** When a finding is revised, the original is
   retained with a *Revised* note — the reasoning trail is the point.
5. **A symptom and its explanation are separate claims** with separate evidence.
   A verified symptom does not confer any confidence on a proposed cause.
6. **Record the revision under test.** Before attributing runtime behaviour:
   confirm branch, confirm working-tree state, record the commit hash, and
   confirm the *deployed* revision matches it. This repository has concurrent
   writers (see *Evidence integrity*), so "which code produced this?" is a real
   question, not a formality.

---

## Evidence integrity

Runtime evidence is only as good as the instrument. Three times this session an
observation was an artefact of the probe rather than a fact about the system —
and each looked like a clean result at the time. For any significant probe,
record these four things **before** running it:

| Item | Ask |
|---|---|
| **Observation target** | What exactly is being read — queue entry, Algolia record, Firestore document, log line? |
| **Probe side effects** | What does the probe create, modify or delete? |
| **Risk to validity** | Could any side effect change the thing being measured, or exclude the subject from the path under test? |
| **Mitigation** | Usually: observe before mutating; separate observation from teardown |

### Worked examples from 2026-07-24

| Probe | Side effect | How it invalidated the result |
|---|---|---|
| Variant e2e #1 | Created the test product with `status:'draft'` for safety | `_shouldSkip` excludes drafts from indexing — the probe removed its own subject from the path it was testing, then reported the path broken |
| Variant e2e #3 | Purged the product on exit | `enqueue` uses a deterministic queue id, so the purge **overwrote** the create's queue entry. The probe could not have observed an upsert even if one existed |
| Batch-fix inference | *(no probe at all)* | Assumed a drained backlog implied new work indexes. Draining says nothing about intake |

### Required probe structure

Observation and teardown must be **separate phases**, in this order:

```
create test subject
      ↓
observe queue DURING the processing window
      ↓
observe the destination index
      ↓
record all evidence
      ↓
── phase boundary: nothing above may be undone by anything below ──
      ↓
cleanup
```

The property that matters: **no destructive action occurs before every
observation has been recorded.** Cleanup still has to run on every exit path,
including failures — but always after the verdict, never before it.

---

## 🔴 Built but broken

| Item | Evidence | Method | Last verified |
|---|---|---|---|
| **Product create → Algolia record** | Product created through the real write path reached Firestore with correct variant terms in **22s** and was **never present in `sokoni_products` within 608s**, across two independent probe runs | Runtime — end-to-end probe | 2026-07-24 |

> ⚠️ **The stated cause was withdrawn.** See *Revised findings*: "zero `upsert`
> entries in the queue" was an artefact of the probe, not a fact about the
> system.

**Symptom and candidate causes, tracked separately.** One confirmed symptom;
every explanation still owes evidence.

| Claim | Status | Evidence |
|---|---|---|
| Product missing from `sokoni_products` after create | 🔴 **Verified symptom** | Runtime — two independent probe runs, 608s each, purge after the window |
| `algoliaSync_products_create` deployed | ✅ | Runtime — function list shows **ACTIVE** |
| `algoliaSync_products_create` invoked | ✅ | Runtime — logs show an invocation at 13:27:11Z matching the probe |
| Queue write missing | ❔ **Unknown** | Prior claim withdrawn — probe cleanup destroyed the evidence |
| Trigger guard skipped the work | ❔ **Unknown** | Not examined |
| Drain processed it incorrectly | ❔ **Unknown** | Not examined |
| Batch poisoning | ✅ **Fixed** | Runtime — backlog drained `{done:147, dlq:152}` → `{done:306, dlq:0}` |

**Scope note.** The probe's deletes fanned out to **both** `gs__products` and
`products`, so the delete path works for both targets while the create path
produced neither.

**Narrowed 2026-07-24 (Runtime — Cloud Function logs + deployment list):**

| Ruled out | Evidence |
|---|---|
| Not deployed | `algoliaSync_products_create` is **ACTIVE** |
| Never fired | Invoked at **13:27:11Z**, matching the probe's create; its paired delete ran 13:38:15Z |
| Queue broken | The delete handler's `enqueue` wrote successfully in the same window |
| Drain broken | Queue drained to `{done:306, dlq:0}` |

**The queue-based half of this diagnosis is WITHDRAWN.** `enqueue` derives a
**deterministic** document id:

```js
const queueId = `${collection}_${docId}`;   // one queue doc per (collection, docId)
```

so a create's `upsert` entry and a later `delete` entry for the same product
write to **the same document**. The probe purges on exit, which **overwrote the
upsert entry with a delete before the queue was ever inspected**. "6 entries, all
delete, zero upsert" was therefore guaranteed by the probe's own cleanup — it
could not have observed an upsert even if one existed.

**What survives:** the product never appeared in `sokoni_products` within 608s,
twice, and the purge happened *after* that window — so the drain had ~2 cycles
to act while the entry should still have been present. That symptom is real and
unexplained.

**What does not survive:** any claim about whether the create path enqueues.
Not proven either way.

**Probe redesign required before the next attempt:** sample the queue *during*
the observation window, not after cleanup. A deterministic queue id means
cleanup is destructive to the evidence, so the queue must be read while the
product still exists.

---

## 🟠 Built but fragile — *operational resilience gaps*

> **Operational resilience gaps** — functionality works under nominal conditions
> but lacks automatic recovery from drift, stale state, partial failure, or
> deployment/configuration divergence.

Named as a class deliberately: these read as four unrelated tickets and are one
recurring design omission. Track systemic improvement, not just closures.

| Item | Why fragile | Evidence | Method | Last verified |
|---|---|---|---|---|
| `algoliaQueue` stale-job reclaim | `_claimBatch` selects only `pending`/`failed`. A job set to `processing` by an invocation that then dies is **unreachable forever**, and a stuck job looks identical to a busy one | Same `processing: 1` in two measurements 7min apart, and present before the batch fix | Runtime — repeated queue status sampling | 2026-07-24 |
| Product image storage (producer) | `seller-wiring.js` writes base64 `data:` URIs, so oversized documents are still manufactured. Consumers hardened; producer not | One product at 397,980 bytes; 195KB in `image` and again in `images` | Runtime — Firestore document inspection | 2026-07-24 |
| Backfill vs live-trigger record schema | Backfill produces 6 fields where the trigger produces 28; recovered documents are present but under-searchable | Observed in `sokoni_services` | Runtime — index record comparison | 2026-07-24 |
| Live Algolia index settings | `algoliaSetupIndexes` is an admin-only `onCall`, so committed settings stay **inert** until invoked. Live: 7 searchable / 7 facets vs 15 / 26 declared | Read from the live index before and after the variant push (7 → 13 each) | Runtime — Algolia settings API | 2026-07-24 |

**Fix guidance captured** (see [[KNOWN_LIMITATIONS]]): reclaim on
`status = 'processing' AND updatedAt < now - margin`, where the margin **must
exceed maximum legitimate processing time** or it races a live worker and
double-indexes. Base64 migration is detect → upload → replace → remove —
**not** rejecting legacy products.

---

## ✅ Built

| Item | Evidence | Method | Last verified |
|---|---|---|---|
| Algolia batch isolation | Backlog drained `{done:147, dlq:152}` → `{done:306, dlq:0}`; all 153 released entries reached `done`, zero failures. Confirmed by two independent samples ~7min apart | Runtime — production queue drain metrics | 2026-07-24 |
| Algolia sanitiser / isolation logic | 14 checks; stub reproduces Algolia's all-or-nothing rejection and proves the incident reproduces *without* the fix first | Integration — `npm run test:algolia-isolation` | 2026-07-24 |
| Variant schema ↔ indexer parity | 33 checks incl. every malformed document shape | Integration — `npm run check:variants` | 2026-07-24 |
| Search matching logic | 23 checks — typo, Swahili↔EN, suggest, scan window, cache poisoning | Integration — `npm run test:search` | 2026-07-24 |
| Variant display, cards, filters, encoding | Correct groups per category, 0 empty headings, 0 page errors; hostile `"><img …>` payload renders inert | Runtime — Playwright browser probe at 430px | 2026-07-24 |
| Variant edit → Firestore terms | Colours-only edit propagated in 0s; old term removed, new term added | Runtime — production probe | 2026-07-24 |

---

## 🟡 Partly verified

| Item | Proven | Not proven | Last verified |
|---|---|---|---|
| Variant pipeline end-to-end | Firestore write, term generation, edit propagation, display, filters | Algolia record, search-by-variant, facet-by-variant, edit re-index — **all blocked** by the 🔴 above | 2026-07-24 |

---

## ⬜ Missing (confirmed absent — product page)

| Item | Method |
|---|---|
| Pinch-to-zoom (tap-to-lightbox exists) | Static — source audit |
| Estimated delivery | Static — source audit |
| Seller response time | Static — source audit |

Already present, contrary to the roadmap's assumption: image swipe, full-screen
lightbox, stock chips (`Out of Stock` / `Only N left`), units sold, "You may
like", recently viewed, recent searches, trending searches, voice search.

---

## ❔ Unaudited

Listed so this audit's own coverage gaps are visible rather than implied.
Evidence level for every row below: **None**.

| Area | Note |
|---|---|
| 3 — Seller post-publish confirmation | Not examined |
| 4 — Inventory intelligence | Not examined |
| 5 — Order timeline | `timeline` appears in the codebase; coverage unknown |
| 6 — Actionable notifications | Not examined |
| 7 — Buyer trust indicators | `prdTrustStrip` exists; contents unverified |
| 8 — Seller dashboard health | Not examined |
| 9 — Timestamp standardisation | Products use `uploadedAt`; full spread unmeasured |
| 10 — Consistency sweep | `skeleton` appears in the codebase; coverage unknown |

> A grep hit is **not** evidence a feature works. Twice this session that
> assumption class was wrong.

---

## Revised findings

Kept rather than overwritten, so the reasoning trail survives.

| Date | Original finding | Revised to | What changed it |
|---|---|---|---|
| 2026-07-24 | Variant Algolia leg failed because the probe created the product as `status: 'draft'`, which `_shouldSkip` excludes | **Wrong.** Re-run with an indexable product failed identically. The draft skip is real but was not the cause | A second probe with `status:'active'` |
| 2026-07-24 | Algolia leg blocked by batch poisoning; expected to pass once fixed | **Partly wrong.** Batch poisoning was real and is fixed, but a *second, independent* defect — the create path never enqueuing — also blocks it | Post-fix re-probe, which failed for a different reason |
| 2026-07-24 | Homepage-inventory and scroll-freeze fixes listed as verified | Removed from ✅ — no runtime evidence was presented in this session | Applying rule 1 to inherited claims |
| 2026-07-24 | "The create path enqueues nothing — 6 queue entries, all `delete`, zero `upsert`" | **Withdrawn.** `enqueue` uses a deterministic queue id (`${collection}_${docId}`), so the probe's own purge **overwrote** the upsert entry with a delete before the queue was read. The observation was manufactured by the cleanup and could never have shown otherwise. Symptom (never indexed in 608s, twice) stands; **cause is unknown again** | Reading `enqueue` after asserting the conclusion — the order that should have been reversed |

---

## Carried over (not verified here)

🔴 Google Sign-In across devices · 🔴 OTP sign-in · 🔴 Wallet top-up invocation
(IAM). These predate this audit; evidence level **None** in this session.
Tracked in [[RELEASE_ACCEPTANCE]].
