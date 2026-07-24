# SOKONI — Polish Gap Audit

**Purpose.** Classify the 10 pre-beta polish areas so effort goes where it
actually pays. Started 2026-07-24.

**Why this exists.** A feature-shaped roadmap assumed things were missing that
turned out to be built (swipe, lightbox, voice search) and assumed things worked
that turned out to be broken (Algolia indexing). Neither is visible from reading
the roadmap or the code. This document separates the two.

## Buckets

| Bucket | Meaning | Priority |
|---|---|---|
| 🔴 **Built but broken** | Runtime evidence disproves it | **Highest** |
| 🟠 **Built but fragile** | Works, but no recovery path / no resilience | High |
| ⬜ **Missing** | Never implemented | Depends on roadmap |
| ✅ **Built** | Verified working | Monitor only |
| ❔ **Unaudited** | Not yet examined — **not** a claim either way | — |

## Evidence levels

A bucket says *what we believe*; the evidence level says *why*. Both are
required — they are what stop "absence of evidence" drifting into "assumed
working".

| Level | Meaning |
|---|---|
| **Runtime** | Observed in production or a controlled end-to-end test |
| **Integration** | Verified across components in a test environment |
| **Static** | Code inspection only |
| **None** | Not yet examined |

Only **Runtime** or **Integration** may justify ✅ or 🔴. **Static** alone caps a
row at ❔ — twice this session static reading said "correct" where runtime said
otherwise.

> **Rule of this document:** a row without evidence is ❔, never ✅. "I read the
> code and it looks right" is ❔. Only a runtime observation moves a row to ✅ or
> 🔴.

---

## 🔴 Built but broken

| Item | Evidence level | Evidence | Status |
|---|---|---|---|
| **Product create → Algolia enqueue** | **Runtime** | Acceptance probe 2026-07-24: a product created through the real write path was **never indexed within 608s**. Queue inspection found **6 entries for the probe document, all `delete`, and zero `upsert`**. The delete triggers fired; the create path enqueued nothing at all | 🔴 **OPEN** — independent of the batch-poisoning defect, which is fixed and separately verified |
| Algolia batch indexing | **Runtime** | One 195KB base64 record failed whole batches; 26+ consecutive upserts lost; 152 entries driven to `dlq` | ✅ **FIXED** 2026-07-24 — queue `{done:147, dlq:152}` → `{done:306, dlq:0}`; all 153 released entries drained, zero failures |

**Why these are two defects, not one.** The batch fix demonstrably works — the
backlog drained completely. But draining a backlog says nothing about whether
*new* work enters the queue. The probe was run precisely because inferring the
second from the first is unsound, and it was: variant data reaches Firestore in
22s and never reaches Algolia at all, because nothing enqueues it.

---

## 🟠 Built but fragile — *operational resilience gaps*

Systems that function nominally but lack automatic recovery from drift, partial
failure, or stale state. Naming the class matters: these look like four
unrelated bugs and are one recurring design omission, so a future contributor
who recognises the shape can catch the fifth before it ships.

| Item | Why fragile | Notes |
|---|---|---|
| `algoliaQueue` stale-job reclaim | `_claimBatch` selects only `pending`/`failed`. A job set to `processing` by an invocation that then crashes is **unreachable forever** — and a stuck job looks identical to a busy one | Two measurements 7min apart both showed the same `processing: 1`. Reclaim on `updatedAt < now - margin`, margin **> max legitimate processing time** or it races live workers |
| Product image storage (producer side) | `seller-wiring.js` writes base64 `data:` URIs, so oversized documents are still manufactured. Consumers are now hardened; the producer is not | Migration: detect → upload to Storage → replace with URL → remove embedded data. Do **not** reject legacy products |
| Backfill vs live-trigger record schema | Backfill produces a 6-field record where the trigger produces 28. Recovered documents are present but under-searchable | Variants specifically are safe (shared normaliser); every other field still diverges |
| Live Algolia index settings | `algoliaSetupIndexes` is admin-only `onCall`, so committed settings stay **inert** until someone invokes it. Live had 7 searchable / 7 facets against 15 / 26 declared | Variant attributes pushed additively (7 → 13 each). Wider drift untouched — needs a decision on which side is authoritative |

---

## ✅ Built (verified this session)

| Item | Evidence |
|---|---|
| Product variants — capture, display, cards, filters | `npm run check:variants` 33/33; Playwright at 430px: correct groups per category, 0 empty headings, 0 page errors, hostile payload renders inert |
| Search matching logic | `npm run test:search` 23/23 — typo, Swahili↔EN, suggest, scan window, cache poisoning |
| Algolia batch isolation | `npm run test:algolia-isolation` 14/14 + production drain evidence above |
| Variant edit → Firestore terms | Production probe: colours-only edit propagated in 0s, old term removed |

---

## ⬜ Missing (confirmed absent, product page)

| Item | Area |
|---|---|
| Pinch-to-zoom | 1 — product page (tap-to-lightbox exists; pinch does not) |
| Estimated delivery | 1 — product page |
| Seller response time | 1 — product page |

Already present, contrary to the roadmap's assumption: image swipe, full-screen
lightbox, stock status chips (`Out of Stock` / `Only N left`), units sold,
"You may like", recently viewed, recent searches, trending searches, voice
search.

---

## ❔ Unaudited

Listed so the gaps in this audit are visible rather than implied.

| Area | Note |
|---|---|
| 3 — Seller post-publish confirmation | Not examined |
| 4 — Inventory intelligence | Not examined |
| 5 — Order timeline | `timeline` appears in the codebase; coverage unknown |
| 6 — Actionable notifications | Not examined |
| 7 — Buyer trust indicators | `prdTrustStrip` exists; contents unverified |
| 8 — Seller dashboard health | Not examined |
| 9 — Timestamp standardisation | Known: products use `uploadedAt`; full spread unmeasured |
| 10 — Consistency sweep | Not examined; `skeleton` appears in the codebase |

## Carried over from earlier work (not re-verified here)

🔴 Google Sign-In across devices · 🔴 OTP sign-in · 🔴 Wallet top-up invocation
(IAM). These predate this audit and are tracked in [[RELEASE_ACCEPTANCE]].
