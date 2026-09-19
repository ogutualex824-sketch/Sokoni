# Gate M — what the media pipeline actually supports, and why the extra lanes stay absent

**Status:** DECIDED — no new lanes · two pre-existing defects found
**Date:** 2026-09-19 · **Gate:** M
**Evidence:** `scripts/test-media-capability.mjs` — **25/0**, against the real Storage rules
engine in the emulator

No Storage expansion. No second media writer. No rules changed. Nothing deployed.

---

## The contract, measured rather than assumed

The client module states its limits mirror the deployed rule. They do — but the rule says
more than the module does, and the difference is where the decision lives.

| path | who may read | content types | size |
|---|---|---|---|
| `product-images/{uid}/**` | **anyone** (`read: if true`) | 6 safe image types | < 15 MB |
| `bnb-videos/{uid}/{file}` | **signed-in only** | `video/*` | < 150 MB |
| `property-videos/{uid}/{file}` | **signed-in only** | `video/*` | < 150 MB |
| `documents/{uid}/{file}` | **owner or admin** | images + PDF | < 20 MB |
| anything else | nobody | — | — |

## Decision: Video, 360° and Documents lanes stay absent

### Video — the capability exists, but not on terms a listing page can use

Video uploads really are accepted, at 150 MB, on two paths. **But those paths are
`read: if request.auth != null`, and listing images are `read: if true`.**

A video attached to a public listing would render for the merchant who added it — they are
signed in — and be **blank for every signed-out visitor**, which is most of a marketplace's
traffic. That is worse than no video lane: it is a feature that demos perfectly and fails in
the one condition nobody tests in.

The two paths are also scoped to BnB and property specifically, not to listings in general.
Making video a listing capability means a Storage rules change — a new path, or a read
contract reconciled with public listings. That is an owner decision, not a UI addition.

### 360° — nothing exists, and storage is not the hard part

There is no 360 path, and an invented one is denied by the catch-all. But the suite also
proves something more useful: **a 360° JPEG would physically fit `product-images` today** —
it is an ordinary image file.

So the gap is not storage. It is a viewer, a projection type, and a way to tell a spherical
photo from a flat one. Adding a lane that stores a panorama and renders it as a squashed
rectangle would be the worst of both: the bytes arrive, the feature does not.

### Documents — real, and deliberately private

`documents/{uid}` accepts PDFs, and is readable by **the owner or an admin only** — proven:
neither a signed-out visitor nor a different signed-in user can read one. A "Documents" lane
on a public listing would therefore be either a dead lane or, if someone "fixed" the read
rule to make it work, a leak of whatever merchants had filed there.

## Two pre-existing defects found while measuring

### 1. Every BnB and property video upload is denied

```
rule      match /bnb-videos/{uid}/{filename}        three segments, uid must match the caller
shipped   bnb-videos/${Date.now()}_${file.name}     two segments, no uid
          bnb-manage.html:414 · landlord.html:1463
```

Neither shipped path matches its rule, so both fall through to
`match /{allPaths=**} { allow read, write: if false }`. **Proven denied in the emulator, with
the inverting control**: the identical upload succeeds the moment a uid segment is added — so
the refusal is about the path shape, not the bytes, the type or the caller.

Both uploaders catch the failure and carry on:

> `"Video upload failed — listing saved without video"`

So it fails politely, the listing saves, and nobody investigates. This is **not repaired
here** — it is a fix to two other surfaces and belongs to whoever owns them. It is recorded
because "the UI has a lane" and "the bytes land" are different claims, and this is the repo's
own demonstration of the gap.

### 2. An absent `admin` claim raises an evaluation error rather than yielding false

`storage.rules:139` — `request.auth.token.admin == true` errors with *"Property admin is
undefined on object"* when the claim is absent. Here the error produces a **deny**, which is
the correct outcome, so nothing is broken. It is noted because it is the **same pattern** as
the `isActive()` finding recorded during Gate W: a missing key erroring rather than
evaluating false. The two should be assessed together if that finding is ever taken up.

## What would unblock each lane

| lane | blocked on |
|---|---|
| Video | a Storage rules decision: a listing-scoped video path, or reconciling the read contract with public listings. Then a player, a poster frame and a size budget |
| 360° | a viewer and projection metadata — storage already fits |
| Documents | a decision about whether listing documents are public at all; today's path is private by design |

Until then the Media Studio stays image-only and says so. The shot list already tells a
merchant which **photographs** to take, which is a real capability, delivered.

Related: [[project_stream_media_delivery]] · [[docs/SOKONI_IMAGE_API]]
