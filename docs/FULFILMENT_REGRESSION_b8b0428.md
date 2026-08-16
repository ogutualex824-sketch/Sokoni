# Full Fulfilment Regression — `b8b0428`

**Gate:** pre-deployment. Run against the working tree at `b8b0428`, baseline `1753b44`.
**Result: PASS.** No regression attributable to the delivery security work.

Scope was derived from the files changed since the census baseline, not from the module names:

```
driver.html                        functions/fulfilment-scan.js
track.html                         functions/index.js
functions/delivery-authority.js    functions/pos-marketplace-sync.js
functions/delivery-pin.js          functions/dispatch.js
```

`functions/index.js` is the reason tiers 2 and 3 exist: the same commit touched
`availableDeliveries`, `claimAvailableDelivery`, `smsTemplates`, `onOrderStatusChange` and the
IntaSend webhook's delivery creation. A regression limited to the delivery suites would not have
covered the order, notification or checkout paths those sit on.

---

## Tier 1 — delivery / fulfilment

| suite | result |
|---|---|
| `test-delivery-authorization` | **36 / 0** |
| `test-fulfilment-scan` | **69 / 0** |
| `test-delivery-sequence` | **33 / 0** |
| `test-delivery-tracking-rules` | **22 / 0** |
| `test-delivery-pin-unreachable` | **65 / 0** |
| `test-delivery-pin-buyer-path` | **20 / 0** |
| `test-delivery-dispatch-authority` | **45 / 0** |
| `test-rider-navigation` | **24 / 0** |
| `test-auth-dispatch` | pass (0 failed) |
| `verify-server-delivery-authority` | pass — server authoritative for delivery pricing |
| `verify-delivery-engine-sync` | pass — engine in sync (`5ed76ec286fc`) |

**314 assertions, zero failures.**

The load-bearing result is `test-fulfilment-scan` at **69/0, unchanged**. That suite predates this
work; holding steady after `fulfilment-scan.js` was refactored to consume
`delivery-authority.js` is what proves the shared primitive changed no behaviour. A new suite
passing would not have proven that.

## Tier 2 — order / notification / payment paths in `functions/index.js`

| suite | result |
|---|---|
| `test-order-advance-authority` | **47 / 0** |
| `test-notify` | pass |
| `test-sms` | pass |
| `test-payment-authority` | **22 / 0** |
| `test-payment-integrity` | pass |
| `test-b2c-webhook-classification` | **12 / 12** |
| `verify-webhook-authority webhookIntasend` | pass — reaches every payment-side capability |
| `test-cart-checkout` | ✗ 1 — **environmental, see below** |
| `test-checkout-fallback-total` | ✗ 1 of 58 — **environmental, see below** |

### The two failures are not regressions, and this was proven rather than assumed

Both assert working-tree cleanliness. Both obtain it with:

```
git diff --name-only HEAD
```

— **uncommitted** changes only. Every file this work touched is committed, so none of them can
appear in that list, and none does. The 24 files they flag are byte-for-byte the set that was
already dirty at session start, belonging to another process working this repo in parallel:

```
CHANGELOG.md  availability-manager.html  business-analytics.html  business.html
category.html  category.js  checkout-2-preview.html  community.html
customer-analytics.html  docs/RELEASE_ROADMAP.md  docs/release-gates/unknown.json
my-orders.html  profile.html  provider-profile.html  seller-analytics.html
seller-public.html  sfos-wallet.html  shared-header.js  sokoni-db.js
sokoni-minishop.js  sokoni-social.js  sokoni-ui.js  tests/rc/rc-runner.js  version.json
```

Set-intersection of that list with the files changed since `1753b44` is **empty**.

These two suites will keep failing for as long as the other process holds uncommitted work, and
they would have failed identically at `1753b44`. They are recorded, not suppressed — a gate that
reports green by ignoring a red suite is worse than one that explains it.

## Tier 3 — merchant surface

| suite | result | baseline |
|---|---|---|
| `test-merchant-routes` | **59 / 0** | 59 / 0 |
| `test-merchant-route-gate --all` | **512 / 10** | 512 / 10 |

Identical in count **and in composition**, which is the part that matters:

| failure | count | baseline |
|---|---|---|
| CORS on 127.0.0.1 | 6 | 6 |
| `Can't find variable: firebase` (seller-delivery.html) | 2 | 2 |
| `seller:products` deep-switch | 2 | 2 |

Standing caveat, unchanged: `--all` walks only the 17 `tier:'primary'` routes, so `fulfilment`,
`kra-tax`, `shop`, `marketing` and `devices` (`tier:'more'`) are never visited. The gate does not
exercise the fulfilment surface; the tier-1 suites do.

## Tier 4 — predeploy gates and rules integrity

| gate | result |
|---|---|
| `predeploy-syntax-gate` | pass — 1,515 JS files and 433 inline `<script>` blocks parse |
| `predeploy-payout-gate` | pass — 0 mismatches; every paid payout has a gateway reference |
| `firestore.rules` vs `1753b44` | **byte-identical** |

`firestore.rules` is 256,563 source bytes against a 256,000-byte **compiled** ceiling with roughly
72 bytes of headroom. The delivery remediation added none: `deliveryPins` is protected by the
absence of a rule plus the absence of a permissive catch-all, which is both stronger than a
client-readable rule and free.

---

## What this gate does and does not establish

**Established.** No behavioural regression in delivery, fulfilment, order advancement,
notification, payment authority or the merchant route surface. The rider-safe projection holds, the
buyer path works against the real captured handler, dispatch/fail/route are authorised per
delivery, and one actor primitive serves both `dispatch.js` and `fulfilment-scan.js`.

**Not established — and not claimable from here.**

- **Nothing is deployed.** Every result above is against the working tree. Engineering Complete is
  not Production Proven.
- **The historical sweep is reported, not applied.** One order (`SKN0SWYXPD`, `in_transit`, rider
  assigned) still carries a plaintext `deliveryPin`, and its linked `packageRequest`
  (`DELSKN0SWYXPD`) still carries a plaintext `proofPin`. Both remain readable by that rider until
  `--apply` is run. **The fix is in code; the exposure is still live for that order.**
- **The IntaSend dashboard registration is unverifiable from here.** `verify-webhook-authority`
  says so itself: code agreeing with itself is not code agreeing with the dashboard.
- **A second webhook handler remains deployed** (ADR-0014). Pre-existing, unrelated, still open.

## Release sequence from here

```
b8b0428
   ↓  full fulfilment regression        ← THIS DOCUMENT: PASS
   ↓  staged Functions + Hosting deploy
   ↓  A7 verification
   ↓  apply the historical PIN sweep
   ↓  only then: Fulfilment into native merchant.html
```

Functions and Hosting must ship **together**: `getMyDeliveryPin` has to be live before
`track.html`, or buyers see a dash where their PIN should be.

Sequencing note on the sweep: it is placed **after** deployment deliberately. Migrating the PIN into
`deliveryPins` before `getMyDeliveryPin` is live would leave that in-flight buyer unable to read
their own code from either location.
