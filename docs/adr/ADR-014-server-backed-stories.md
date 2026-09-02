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

Current artifact: **255,822 characters, 178 free** against the 256,000 ceiling. The two
story blocks are **already present and already counted**.

Making them real costs more: an `expiresAt > request.time` condition, a `status` check, and
an ownership clause. Realistically **150–400 characters** — which does **not** fit.

**This ADR does not authorise forcing publication.** Options, to be decided before any
rules change:

1. **Consolidate first.** The artifact carries 15 `firestore.rules.*` variants and blocks
   whose helpers duplicate one another; a reconciliation pass is likely to free more than
   400 characters.
2. **Ship stories with the read rule as-is** (`isAuthed()`) and defer the public-read
   change until consolidation — functional for signed-in shoppers, invisible to others.
3. **Split the ruleset** — a larger change with its own risk.

The rules boundary stands: nothing is published until the reconciliation proves it removes
no live protection, per `docs/RULES_RECONCILIATION_59af870d.md`.

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
