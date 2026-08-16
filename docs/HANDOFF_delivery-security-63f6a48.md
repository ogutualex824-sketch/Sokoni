# Handoff — delivery security package, `release/delivery-security` @ `63f6a48`

**For:** the `rc/combined` release owner.
**Status:** ready, verified, **frozen, and NOT deployed.**
**Authored by:** the merchant-consolidation workstream (`fix/algolia-batch-poisoning`).

This branch is not deployed and must not be deployed from outside the `rc/combined` combined gate.
`docs/LAUNCH_TODO.md` says *"No deployment until the combined gate passes against one exact SHA"*,
and this branch contains 23 commits of `rc/combined`'s own unreleased candidate. Shipping it
directly would release that candidate without its gate.

---

## Production right now

```
LIVE  8290102
  ├── checkout P0                  🔴  fixed in the candidate, still live
  └── availableDeliveries exposure 🔴  fixed in THIS package, still live

CANDIDATE (rc/combined @ 352f22e)
  ├── checkout remediation         ✅
  ├── other release work           ✅
  └── combined gate                ⏳  not yet run

release/delivery-security @ 63f6a48
  └── candidate + delivery security ✅  ready, NOT deployed
```

## What the package contains

Five commits on top of `rc/combined` tip `352f22e`:

| commit | what |
|---|---|
| `d99ae7f` | Fulfilment/delivery authority census (docs) |
| `e44a6d7` | Close the PIN read paths — the P0 |
| `3583202` | Sweep report, `smsTemplates` repair, findings 5–7 |
| `0514176` | Full fulfilment regression record (docs) |
| `63f6a48` | Deploy guard: refuse diverged trees |

### The P0 it closes

`availableDeliveries` was `onRequest` with `invoker: "public"` and **no authentication of any
kind**, returning up to 80 pending deliveries with `buyerName`, `buyerPhone`, `deliveryAddress`,
`items`, `orderTotal` and the plaintext `proofPin`. The `cors` list is not an access control — CORS
constrains browsers; `curl` ignores it. Verified live: `HTTP 200` with no credentials.

It now requires a verified Firebase ID token **and** an approved, non-suspended `rideDrivers`
record, and returns a rider-safe projection for an unclaimed job (seller, pickup, coarse area, item
count, fee) — no buyer identity, no exact address, no PIN.

### Also closed

- **Plaintext delivery PIN reachable by the assigned rider.** The rules grant that rider a
  full-document read on `orders`, and Firestore cannot project fields on read, so the secret moved
  off the document into `deliveryPins/{orderId}` — which has **no rule** and is therefore
  deny-by-default. The buyer reads it through the new `getMyDeliveryPin`.
- The same secret one collection over: plaintext `proofPin` on `packageRequests`.
- `claimAvailableDelivery` no longer returns `proofPin` at claim time.
- `deliveryVerifyShadow` required no assignment (a PIN oracle) and burned the same attempt counter
  `completeDeliveryWithPin` locks on, so any account could force a legitimate rider into the support
  branch. Both fixed.
- Findings 5–7 (`dispatchDelivery`, `handleFailedDelivery`, `optimizeBatchRoute`) — all three took a
  client `deliveryRef` behind auth alone. Now on one shared actor primitive,
  `functions/delivery-authority.js`, which `fulfilment-scan.js` also consumes rather than keeping a
  second copy.

## Deployment requirements

**Functions and Hosting must ship together.** `getMyDeliveryPin` is a NEW callable and is
re-exported by name in `functions/index.js`. If Hosting ships first, `track.html` asks for a
function that does not exist and buyers see a dash instead of their PIN.

**Firestore rules do NOT need deploying.** `firestore.rules` on this branch is **byte-identical to
live**. The remediation deliberately added zero rules bytes — `deliveryPins` is protected by the
absence of a rule plus the absence of a permissive catch-all. This matters: the compiled ruleset
has roughly 72 bytes of headroom.

## After deployment, in this order

1. Verify `getMyDeliveryPin` is live before relying on it from `track.html`.
2. Verify `/api/available-deliveries` returns **401** without a token and **403** for a
   non-approved account.
3. Verify an approved rider gets the board, and that the payload contains no `proofPin`,
   `buyerPhone` or exact `deliveryAddress`.
4. Verify a buyer can retrieve their PIN, and that the assigned rider cannot.
5. Verify delivery completion still works end to end.
6. **Only then** run the historical sweep — see below.

### The historical sweep is sequenced AFTER deployment, deliberately

`scripts/sweep-order-delivery-pins.js` — **report-only by default**, `--apply` to write.

Last report (read-only, against production):

```
orders with a plaintext deliveryPin: 1
  READABLE BY A RIDER RIGHT NOW:     1
  SKN0SWYXPD   in_transit   rider assigned: YES

linked packageRequests carrying a plaintext proofPin: 1
  DELSKN0SWYXPD   driver_accepted   hash present
```

`--apply` **migrates before it deletes**: copy the plaintext into `deliveryPins/{orderId}`, set
`deliveryPinIssued`, and only then remove the field. Step 3 never runs unless 1–2 succeeded.

Running it **before** `getMyDeliveryPin` is live would leave that in-flight buyer unable to read
their own code from either location — the order field would be gone and the callable that replaces
it would not yet exist.

## Evidence

Full fulfilment regression on the release branch:

```
delivery-authorization  36/0    fulfilment-scan       69/0
delivery-sequence       33/0    tracking-rules        22/0
pin-unreachable         65/0    pin-buyer-path        20/0
dispatch-authority      45/0    rider-navigation      24/0
merchant-routes         64/0    syntax + payout gates pass
firestore.rules  byte-identical to live 8290102
```

`test-fulfilment-scan` at **69/0 unchanged** is the load-bearing result: that suite predates this
work, so holding steady after `fulfilment-scan.js` was refactored onto the shared primitive is what
proves the refactor changed no behaviour.

### Two results that are NOT this package's doing

- **`test-payment-authority` fails on `rc/combined`** with
  `ReferenceError: _availability is not defined`. Verified pre-existing: it fails identically at
  `352f22e`, **before** these cherry-picks. Recorded here so it is not mistaken for fallout from the
  delivery work, and not silently "fixed" by it.
- `test-order-advance-authority` does not exist on `rc/combined` — it belongs to the merchant
  consolidation track and is correctly out of scope for this release.

## Conflict resolution worth knowing about

One real conflict, `driver.html`. **`rc/combined` had already fixed that defect, and more
thoroughly** — it removed the client-side `proofPin` comparison *and* rewired to
`completeDeliveryWithPin`, validates the PIN format, resolves the `deliveryRef`, and cites the same
live order `SKN0SWYXPD`. The `rc/combined` version was kept and the duplicate change dropped.

`CHANGELOG.md` and `docs/MERCHANT_2D2_QUEUE.md` conflicted trivially (both sides prepend; the queue
file is new from the consolidation track).

## One thing still open, and it is not on this branch alone

`scripts/deploy/guard-no-rollback.js` blocked only the case where local HEAD is an **ancestor** of
live. A diverged branch is neither behind nor ahead, and the guard allowed it explicitly. It printed

```
[rollback-guard] local c40d882 is not behind live 8290102 — allowing deploy.
```

for a tree that would have reverted **110 files**, including `settlement-engine.js`,
`settlement-executor.js` and `order-settlement.js`.

`63f6a48` fixes it — it now requires the live commit to be **contained** in the tree. Verified both
directions: diverged tree → exit 1, release branch → exit 0.

**The fix currently exists only on `release/delivery-security`.** Every other branch, including
`rc/combined` itself, still carries the permissive guard. Worth landing early regardless of what
happens to the rest of this package.

## Artifact location

The verified worktree is at `C:/temp/sokoni-release` (branch `release/delivery-security`, clean).
`node_modules` and `functions/node_modules` are junctions to the main checkout so the suites run.
Left in place deliberately; it costs nothing and is the thing that was actually tested.
