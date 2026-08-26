# userLocations — the whole surface is denied in production

**Status:** OPEN · **Kind:** live production defect · **Found:** 2026-08-26
**Raised by:** the merchant-v2 Stories rules audit — **unrelated to Stories**, and deliberately
recorded on its own so attribution and rollback stay clean.

Related: [[project_delivery_destination_divergence]] · [[reference_deployed_ruleset_authority]] ·
[[POS_RETAIL_SALES_OWNERSHIP]]

---

## The defect

**`userLocations/{uid}/places/{placeId}` has no rule in the served ruleset.** In Firestore a
collection with no matching rule is DENIED — so every read, create, update and delete on a
buyer's saved locations is refused in production, for everyone, today.

Verified against the **served** ruleset, not the repo:

| | |
|---|---|
| served ruleset | `f1c4e35b-bcc2-418b-b7a3-8990c1c8dad0` |
| release updated | 2026-08-23 |
| fetched from | `firebaserules.googleapis.com` |
| `match /userLocations` in served | **ABSENT** |
| `match /userLocations` in repo | present |

The repository already contains the intended authority, written owner-scoped with type
validation on the coordinates:

```
match /userLocations/{uid}/places/{placeId} {
  function mine() { return isAuthed() && request.auth.uid == uid; }
  allow read, delete: if mine();
  allow create, update: if mine()
    && request.resource.data.label is string
    && (!('lat' in request.resource.data) || request.resource.data.lat is number)
    && (!('lng' in request.resource.data) || request.resource.data.lng is number);
}
```

Landed in `edcf477 feat(commerce): buyer saved locations — authority first, 35/0`. It was
never deployed. `132e258` even measured it as "the 716th block … it does not ride along",
which is consistent: it was kept out of a rules release on purpose and then not shipped in
one of its own.

## What it costs

`sokoni-buyer-locations.js` is the consumer. A buyer saving a delivery address gets a denied
write — and if that denial is swallowed, the address appears to save and is gone on the next
visit. This is the same shape as the `posRetailSales` divergence: a working client over an
authority that refuses it, where nothing errors loudly enough to notice.

**Not verified:** whether the client surfaces the denial or swallows it. Worth checking before
estimating buyer impact — a visible error is a bad experience, a swallowed one is lost data.

## The fix

Deploy the existing repo block. No new rule needs writing and nothing needs weakening; the
authority is already correct and already has a 35/0 suite behind it
(`scripts/test-buyer-locations.js`).

It is **not** blocked by the ruleset ceiling: the served ruleset is 252,449 bytes against a
256,000 limit, leaving 3,551 bytes, and this block costs a few hundred.

## Why it is recorded separately

It was found while assembling a rules baseline for Stories, and it would have been easy to let
it ride along in that deployment. It must not:

- Stories rules are a **new** authority; this is an **already-written** one that was never
  shipped. Different risk, different reviewer, different rollback.
- If a future rules release changes something unexpectedly, attribution has to be
  unambiguous — Stories, or this.

Same reasoning as [[POS_RETAIL_SALES_OWNERSHIP]], which is also a live authority defect kept
out of the surface work that discovered it.

## One more divergence found in the same audit

Not a defect, but it belongs to whoever next deploys rules: **production is BROADER than the
repo on `posDevices`.** Served allows a business owner in through `ownsBiz(merchantId)`:

```
allow create: if claimsPosOwner() || ownsBiz(request.resource.data.merchantId);
allow read:   if isPosOwner() || isAdmin() || ownsBiz(resource.data.merchantId);
allow update: if isPosOwner() || isAdmin() || ownsBiz(resource.data.merchantId);
```

The repo has only `isPosOwner() || isAdmin()` and does not define `ownsBiz` at all. Deploying
the repo as-is would silently NARROW production and could break a business owner's access to
their own POS devices. Restore `ownsBiz` before any rules release from this lineage.
