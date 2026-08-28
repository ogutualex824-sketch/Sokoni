# Slice 4 — Delivery Marketplace: BLOCKED, and why

**Date:** 2026-08-28 · **Base:** `58c4c07` on `rc/ui-integration` · **Source:** `feat/delivery-marketplace` (10 commits, `645670d` tip)

**No production code was ported in this slice.** The reason is not caution — it is that
the feature's central capability cannot function under this slice's constraints.

---

## The blocker: two callables that exist nowhere in production

Three of the five new client surfaces invoke the same two callables:

| client surface | callables invoked |
|---|---|
| `sokoni-delivery-panel.js` | `deliveryAssignRider`, `deliveryRiderOptions` |
| `sokoni-dispatch-board.js` | `deliveryAssignRider`, `deliveryRiderOptions` |
| `sokoni-buyer-delivery-card.js` | `deliveryAssignRider`, `deliveryRiderOptions` |
| `sokoni-shop-delivery-settings.js` | none |
| `sokoni-delivery-activity.js` | none |

Both are:

    exported in live functions/index.js   : NO  (0 occurrences)
    exported in the branch's index.js     : yes (1 each)
    present in the DEPLOYED function list : NO

They are implemented in `functions/delivery-marketplace.js` — a file that does not exist
on the live lineage at all.

**Porting the UI would ship a rider-assignment surface whose assign control calls a
function that is not there.** The integration brief requires "no dead buttons"; this
would be three surfaces of them.

## Rules are NOT the blocker

Worth stating precisely, because it was the likelier suspicion. Measured against the
ruleset **fetched from production** (`f1c4e35b`), the branch introduces **no new
delivery collections**:

    riderOffers · deliveryAssignments · riderProfiles · shopRiders · riderMarket
      -> absent from BOTH branch and production (they were never separate collections)
    deliveries
      -> 2 match blocks in the branch, 2 in production

The only branch-only match block is `userLocations`, which belongs to the separately
quarantined rules proposals and is not part of this feature. This matches the source
commits' own claims — `25cc1e0` and `107180d` both say "no new rules, no new Cloud
Function".

So the feature needs **Functions, not rules**. That is a narrower and more tractable
blocker, and it is a deployment authorisation this slice does not hold.

## What is technically portable, and why it was not taken

`sokoni-shop-delivery-settings.js` (16,874 B) and `sokoni-delivery-activity.js`
(7,933 B) invoke no callables. `sokoni-fulfilment-lifecycle.js` and
`sokoni-merchant-store-ui.js` supersede live and also invoke none.

They were **not** ported, because they are not independent improvements — every one of
them arrives from the same delivery-marketplace commits (`c162a70`, `9d00ebf`,
`107180d`, `25cc1e0`). Shipping settings and activity cards for a marketplace whose
assignment surface cannot mount is a partial feature that looks complete. That is the
shape of defect this whole integration exists to avoid.

`sokoni-fulfilment-lifecycle.js` also removes 93 lines live currently has while adding
138, so it is not a clean superset even though the branch has seen all of live's
history for it.

`functions/messages.js` supersedes live too, but it is a Functions file and out of
scope by instruction.

## The delivery-PIN defect — checked, and still separate

`86f1a3d` is **NOT** an ancestor of `feat/delivery-marketplace`. The branch's
`sokoni-delivery.js` carries the same 2 `_generatePIN` occurrences as live, so this
slice **neither introduces nor fixes** the browser-minted PIN. The defect remains
exactly where Slice 3 left it: open, in production, on its own remediation track.

## Verdict

| item | state |
|---|---|
| Rider marketplace / assignment | **BLOCKED** — requires `functions/delivery-marketplace.js` + 2 exports + a Functions deploy |
| Dispatch board, Track, buyer rider card | **BLOCKED** — same two callables |
| Shop delivery settings, activity cards | portable, **deliberately not taken** — incoherent without the above |
| Firestore rules | **not required** — measured against the served ruleset |
| Delivery PIN defect | **separate**, unchanged, still live |

**To unblock:** authorise a Functions deploy carrying `delivery-marketplace.js`,
`delivery-defaults.js`, `sokoni-delivery-pricing.js`, the three superseding Functions
files, and the two `index.js` exports — merged forward onto live's newer `index.js`,
never by taking the branch's copy. That is a production-change decision, not a UI slice.
