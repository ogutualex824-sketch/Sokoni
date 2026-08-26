# posDevices — `isPosOwner()` checks a field no real device has

**Status:** OPEN · **Kind:** live rules inconsistency (not currently harmful) · **Found:** 2026-08-26
**Raised by:** the printer-host audit. Recorded on its own so the printer work is not built
around an undocumented inconsistency.

Related: [[POS_RETAIL_SALES_OWNERSHIP]] · [[USER_LOCATIONS_PRODUCTION_DENIAL]] ·
[[reference_deployed_ruleset_authority]]

---

## The two behaviours

**Production data.** Every `posDevices` document is written by a Cloud Function, and the
ownership field is `merchantId`. Measured against the live collection, 2026-08-26 (20 sampled,
more exist):

| field | present |
|---|---|
| `merchantId` | **20/20** |
| `cashierId` | 20/20 |
| `branchId`, `status`, `lastSeenAt`, `connectivity` | 20/20 |
| **`sellerId`** | **0/20** |

Both writers agree and neither has ever emitted `sellerId`:
`functions/business-bootstrap.js` (`bootstrapDevice`) and `functions/device-manager.js`
(`registerDevice`, `deviceHeartbeat`, …) write `{ deviceId, merchantId, branchId, cashierId,
lastSeenAt, lastSyncAt, status }` with `{ merge: true }`.

**The served rule.**

```
match /posDevices/{deviceId} {
  allow create: if claimsPosOwner() || ownsBiz(request.resource.data.merchantId);
  allow read:   if isPosOwner() || isAdmin() || ownsBiz(resource.data.merchantId);
  allow update: if isPosOwner() || isAdmin() || ownsBiz(resource.data.merchantId);
  allow delete: if isAdmin();
}

function isPosOwner()     { return isAuthed() && resource.data.sellerId == request.auth.uid; }
function claimsPosOwner() { return isAuthed() && request.resource.data.sellerId == request.auth.uid; }
```

`isPosOwner()` resolves against `sellerId` — **a field 0 of 20 production devices carry.** The
disjunct is dead for every real device.

## Effective access today

`ownsBiz(resource.data.merchantId)` is the ONLY working merchant path, with `isAdmin()`
alongside it. It is certified behaviourally at 26/0 (`scripts/test-posdevices-rules.js`).

## Why this matters more than it looks

The repository lineage had **dropped `ownsBiz` entirely**, leaving `isPosOwner() || isAdmin()`.
A rules release from that lineage would have left **no merchant able to read any of their own
POS devices** — every device denied, silently, because the only surviving disjunct matches
nothing in production.

That was earlier characterised as "could narrow production and break a flow". With the live
data measured, it is stronger: it would have broken **all** POS device access for merchants.
Preserving `ownsBiz` in the frozen proposal (`242fb58`) is what prevents that.

## Deliberately NOT fixed

**Do not add `sellerId` to devices.** There is no demonstrated need: `merchantId` already
carries ownership, `ownsBiz` already enforces it, and a second identity field on a collection
that already has `merchantId`, `cashierId` and a client-supplied `deviceId` is how the
`posRetailSales` divergence happened — a rule checking one spelling while the writer emits
another.

The options, for whoever takes it:

1. **Leave it.** The dead disjunct is inert: it can never *grant* access, only fail to. Zero
   risk, some confusion for the next reader.
2. **Remove `isPosOwner()`/`claimsPosOwner()` from this block.** Simplifies the rule and
   reclaims bytes in a ruleset with 510 free. Must first confirm no OTHER collection's devices
   rely on them — `claimsPosOwner()` is used by `posTransactions` and `posCashFloats` too, so
   only the `posDevices` references can be considered.

Either is a deliberate decision. Neither should ride along inside the printer-host slice.

## One more thing the audit surfaced

`mergedFrom` / `mergedAt` are present on **5/20** devices — devices are already being
re-identified and merged in production. Any `printerHost` declaration must survive or
explicitly transfer across a merge, or a merchant silently loses their print destination when
a device is re-identified.
