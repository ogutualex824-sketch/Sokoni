# ADR-014 — Stories need a server authority before they can have a shop entry point

**Status:** ⛔ **DECISION REQUIRED** — design only. No implementation, no rules published.
**Date:** 2026-09-02
**Raised by:** Slice B of the Shop Details convergence, which could not build a truthful
story ring on `/shop/{handle}`.
**Related:** [[ADR-013-pos-write-authority]] (same principle: the client expresses intent,
the server establishes state)

---

## The finding that stopped the UI

Stories today are **`localStorage["sokoniStories"]`**, written by `postStory` on the device
that posts them and read by Home from the same key, filtered on `expiresAt` against the
**visitor's own clock**.

There is no server collection. `merchantStories` and `storyAllocations` exist in the rules
artifact and in one rules test; **nothing reads or writes them.**

Three consequences, and together they are the whole reason this ADR exists:

1. **A shopper cannot see a merchant's stories.** They are in the merchant's browser, on
   the merchant's device. Not "not yet" — *cannot*.
2. **A story ring on the shop page could only be decorative.** It would light up on the
   merchant's own device and mislead everyone else. Building it first would make the
   product look finished while being untrue.
3. **Expiry is advisory.** A device with a wrong clock shows expired stories, or hides
   live ones.

## What already exists, and should be honoured

The rules stubs are not empty — they encode a prior design:

```
match /merchantStories/{storyId} {
  allow read:  if isAuthed();
  allow write: if false;   // CF-only — publishStory, recordStoryView, expireStories
}
match /storyAllocations/{allocationId} {
  allow read:  if isAdmin();
  allow write: if false;   // CF-only — publishStory claims it atomically
}
```

Three callables are already named, and allocation is already meant to be claimed
atomically. This ADR should extend that intent rather than invent a parallel one.

**One thing in it needs a decision:** `allow read: if isAuthed()` means a **logged-out
shopper cannot read stories at all**. On `/shop/{handle}` most visitors are logged out, so
as written the ring would be invisible to exactly the audience it is for. See §4.

---

## 1 · Story document schema

```
merchantStories/{storyId}
  sellerUid      string   owner; set by the CF from auth, NEVER from the payload
  shopId         string   resolved server-side from sellerUid
  handle         string   denormalised for the shop query
  mediaPath      string   Cloud Storage path — never the media itself
  mediaType      'image' | 'video'
  width, height  number   so the viewer reserves space and does not shift
  caption        string   <= 200
  createdAt      timestamp  serverTimestamp()
  expiresAt      timestamp  createdAt + 24h, computed SERVER-side
  status         'live' | 'expired' | 'removed'
  order          number   position within the seller's set
  viewCount      number   server-maintained
```

**Media is a Storage reference, never a blob.** A base64 image in a Firestore document
would blow the 1 MB limit and make every list query enormous.

## 2 · Write path

`publishStory` (onCall) is the only writer:

- takes `mediaPath`, `caption`, `mediaType`, dimensions — **never `sellerUid`**
- resolves the seller from `auth.uid`, then the shop from that seller
- stamps `createdAt`/`expiresAt` with `serverTimestamp()`
- claims a slot in `storyAllocations` in the same transaction (rate/quota)

`deleteStory` (onCall) sets `status: 'removed'` after verifying ownership.

`postStory`'s current `localStorage` write becomes a **local cache of the merchant's own
stories for instant feedback**, never the source of truth.

## 3 · Read paths — one source, three consumers

| consumer | query |
|---|---|
| `/shop/{handle}` | `where shopId == … && status == 'live' && expiresAt > now`, `limit(1)` for the ring's existence check, full set on tap |
| Home | the same collection, bounded (`orderBy createdAt desc, limit N`) |
| merchant's own management | `where sellerUid == auth.uid` |

**Existence must not cost a download.** The ring asks `limit(1)` — one document, not the
seller's whole set. Home must stay bounded; an unbounded feed is a cost and latency defect
waiting for the platform to grow.

### 3a · Home is added to, never moved from

The shop entry point is **additional**. The same story must be discoverable from Home *and*
from the merchant's shop — one record, two doorways. Moving stories from Home to the shop
would trade one surface for another and lose reach the merchant already has.

That makes the cutover a **dual-read**, not a switch, and
[[ADR-009-canonical-field-representation]] already governs that shape: read both sources,
prefer the canonical one, converge the write first. Concretely, during cutover Home reads
server stories and falls back to the `localStorage` set **only for the viewing merchant's
own stories**, so a merchant never watches their own post vanish — while a shopper only
ever sees server records. Once `postStory` has been server-side for longer than the 24h
lifetime, the local branch is dead by construction and comes out.

**The order is fixed:** server authority → Home reads it → shop reads it → ring → viewer.
The ring is built *last*, because it is the only part that is purely decorative until
everything above it is real.

## 4 · The decision this ADR most needs

**Who may read a live story?**

- **(a) `isAuthed()`** — as the stub says. Simple, but a logged-out shopper sees no ring,
  which defeats the shop entry point.
- **(b) Public read of `status == 'live'`** — matches the product intent (a storefront is
  public), and matches how `products` and `shops` already read.
- **(c) Public read via a CF projection** — most control, most cost.

**Recommendation: (b)**, because the shop page is public and a story is marketing. But it
means anything in a story is world-readable, which is a **privacy decision, not a technical
one** — it belongs to the operator.

## 5 · Expiry — server truth, defence in depth

- `expiresAt` is written by the server.
- Queries filter `expiresAt > request.time` **in the rules**, so an expired story is
  unreadable even if a client asks for it.
- `expireStories` (scheduled) flips `status` and frees allocations.

**A client clock must never be the thing that keeps a story private.** Filtering only in
the query would let a device with a skewed clock read expired content.

## 6 · Rules footprint — and why publication is NOT forced

> **CORRECTION (2026-09-02).** An earlier version of this section read *"255,822
> characters, 178 free"*. That was a **unit error**: 255,822 is a count of **source
> characters** and 256,000 is a ceiling on **compiled bytes**. The two are not comparable,
> and they do not move together. Measured directly against the served release:
>
> | quantity | value |
> |---|---|
> | served ruleset | `59af870d-72eb-4791-a3b6-2f4de7eb8ff7` |
> | compiled executable | **255,551 B** |
> | free against 256,000 | **449 B** |
> | `firestore.rules` (repo candidate) | 255,822 source chars — *a different, larger artifact* |
>
> The correction is not merely "449 instead of 178". The **currency changed**, and cost in
> the real currency is not predictable from the wrong one: the recorded `trackb-v1`
> datapoint added 282 source characters and cost **445 compiled bytes**, ~1.58x. A plan
> priced in characters can overshoot by half again — which is how a candidate reached
> `400 INVALID_ARGUMENT` at RELEASE, *after* the ruleset had been created, since there is
> no predeploy guard on ruleset size.

> **CORRECTION.** This section also claimed the two story blocks were *"already present
> and already counted"*. They are present in the REPO artifact and **absent from the
> served ruleset** — `merchantStories` and `storyAllocations` are two of only five scopes
> the repo adds over `59af870d`. Since the repo artifact cannot be released, the story
> blocks have never been counted against the real budget at all. They are a NEW cost, not
> a sunk one.

Making the story rules real adds an
`expiresAt > request.time` condition, a `status` check and an ownership clause. **Whether
that fits in 449 compiled bytes is unknown, and cannot be known without compiling it.**

### What consolidation actually has to work with

Mapped read-only by `scripts/audit-rules-budget.js` and
`scripts/audit-rules-duplicate-scopes.js`:

| lever | source size | behaviour-preserving? |
|---|---|---|
| 10 same-scope duplicate `match` blocks | — | **No.** Same-scope blocks **union**; merging is a rules change |
| 315 `allow …: if false;` | 7,345 ch | Yes — a rule that never grants is a no-op; absent allow already denies |
| 22 match blocks that are entirely constant-false | 1,568 ch | Yes, same reason |
| comments | 51,150 ch | Yes in source — **worth an unknown number of compiled bytes** |
| indentation | 48,528 ch | Yes in source — same unknown |

**The 10 duplicates are a correctness finding before they are a size finding.** Same-scope
blocks OR together, so the second can grant what the first withholds, and reading either
alone gives the wrong answer. Three examples, all real:

- `platformConfig` — one block allows `write: if isSuperAdmin()`, the other `write: if
  false`. The union is superAdmin-writable; **the second block reads as though nothing may
  write it.**
- `securityEvents` — one allows `read: if isAdmin()`, the other also allows a user to read
  their own. The union is the broader rule; the narrower block **misdescribes** it.
- `fraudAlerts` — the second block (`isAdmin`) is fully subsumed by the first
  (`isModerator`, which includes admin), so it is inert.

In each case the *narrower or constant-false* member contributes nothing to the union and
is removable with provably zero behaviour change. That is the safe class. Merging two
blocks that each grant something is **not** in that class and needs its own proof.

### 6a · The measurement — run 2026-09-02, disposable rulesets, production untouched

`scripts/measure-rules-compiled-delta.js`. One control, one variable, then a candidate.
Every release created was named `sizeprobe-<ts>-<tag>`, guarded by an assertion that
**refuses** `cloud.firestore` rather than merely avoiding it, and deleted afterwards
including on failure.

| | source | compiled | free |
|---|---|---|---|
| served `59af870d` (live) | 252,640 ch | **255,551 B** | 449 |
| control — served source recompiled unchanged | 252,640 ch | **255,551 B** | 449 |
| variable — comments + indentation removed | 153,363 ch (−99,277) | **255,423 B** | 577 |

**The control reproduced the live size exactly**, so the instrument measures what is
deployed. Without that the delta below would be uninterpretable, and the run aborts rather
than reporting a number if it fails to match.

> ## 99,277 source characters are worth **128 compiled bytes**.
>
> 0.0013 B per character — **0.13%** of what a character-based estimate predicts.

**So the answer is effectively "unchanged."** Deleting every comment and every indent from
the entire ruleset moves free space from 449 B to 577 B. That does not fund the story
rules, and it would cost the file all of its explanatory value — the comments that record
*why* a rule is shaped as it is are, in budget terms, free. **Keep them.**

**Consolidation must therefore be structural**, exactly as §6's table anticipated: remove
rules and blocks that are inert, not characters that are merely decorative.

### 6b · The repo candidate cannot be released at all

Priced with the same instrument. `firestore.rules` (255,822 ch — a *different and larger*
artifact than the served `firestore.rules.release-minimal`):

- ruleset **CREATE succeeded** → the syntax is valid
- release **REJECTED, 400 INVALID_ARGUMENT**
- stripped of comments and indentation (−101,522 ch, to 154,300) → **still rejected**

Ruleset create validates syntax; release enforces limits. So this candidate is
syntactically sound and hits a limit — and stripping does not rescue it, which is exactly
what the 128-byte result predicts.

**Do not record this as "too big" as though it were established.** The API does not return
the reason. What is established: it **cannot be released as it stands**, and no cosmetic
reduction changes that.

This is a **blocking fact for the whole rules track**, and it is bigger than the story
question. The restored `shopEmployees.shopOwnerId` anchor lives in this artifact. Until
structural consolidation brings the candidate under the limit, **that anchor cannot be
published** — so the reconciliation in `docs/RULES_RECONCILIATION_59af870d.md` has a size
precondition it did not previously know about.

### 6c · Production was not changed

| | before | after |
|---|---|---|
| `cloud.firestore` ruleset | `59af870d-…` | `59af870d-…` |
| release `updateTime` | 2026-08-28T14:49:34.255213Z | 2026-08-28T14:49:34.255213Z |

Stray `sizeprobe-` releases: **none**. Rulesets created on 2026-09-02 still present:
**zero**. Verified by an independent listing, not by the script that did the cleanup.

### The prediction, and what it was worth

Before the measurement this section reasoned that compiled (255,551) being ~1.66x the
code-only source (154,299) was *the signature of a bytecode form in which comments have
already vanished*, and predicted they would be worth **zero**.

**The direction was right and the magnitude was not.** They are worth 128 bytes, not zero.
The prediction would have been a fine hypothesis and a poor foundation: it is the same
reasoning-from-signature that produced the original 178-character error. Recorded here
because the lesson is not "comments are free" but **price a candidate by compiling it**.

**This ADR does not authorise forcing publication.** Options:

1. **Consolidate first** — now the accepted order, and the levers are the table above.
2. **Ship stories with the read rule as-is** (`isAuthed()`) — rejected: it hides the ring
   from logged-out shoppers, the audience the shop entry point exists for.
3. **Split the ruleset** — a larger change with its own risk.

## 7 · Cutover, not migration

Existing stories are device-local and expire within 24 hours. **There is no population to
migrate.** On launch, `postStory` writes server-side; existing local entries age out on
their own. Attempting to "publish" old local stories would upload content the merchant
posted under different expectations.

## 8 · Failure and offline

- Publish offline → queued locally, marked *pending*, never shown to shoppers as live.
- Read offline → the shop shows no ring rather than a stale one.
- Storage upload fails → no document is written; a story with no media is not a story.

## 9 · Moderation

Server-written stories are reportable and removable; `status: 'removed'` gives admin a
lever that `localStorage` never could. Worth deciding whether reports route to the existing
admin surface.

---

## What this ADR forbids

- **No story ring until the availability signal is real.** A decorative ring is worse than
  no ring: it teaches shoppers the control does nothing.
- **No second story source.** Home and the shop read the same collection. Two sources is
  the defect this ADR exists to prevent.
- **No client-supplied `sellerUid`.** The owner comes from `auth.uid`, server-side.
- **No client-clock expiry.** Rules enforce `expiresAt`.
- **No media blobs in Firestore.** Storage references only.
- **No forced rules publication** to make stories fit.

## Certification required before this is called done

merchant creates a story · it survives reload **and a different device** · a shopper sees
the correct shop's story · an expired story disappears · another seller can neither read
nor modify it · the ring opens the correct seller · **Home still shows stories**.

Each PASS/FAIL/UNPROVEN separately. A code path existing is not evidence.
