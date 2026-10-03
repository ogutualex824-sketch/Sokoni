# SOKONI Delivery Hub — rider dashboard (2026-10-03)

**Status:** built and certified locally; **NOT deployed.** Branch `hosting/delivery-hub-dashboard-on-14ef233`, built on
sokoni-e3's `hosting/chain-on-3e8dd53` @ `14ef233` (which contains live `72dca56`). It also carries sokoni-4d's
payout-safety fix `6f0a576` (cherry-picked as `f2d5f81`).
Related: [[Delivery Hub programme]] · [[Rider Drive]] · [[Completion PIN]] · [[Payments]] · [[merchant-v2]]

## What changed

`driver.html` (same URL, same role guard) is now a merchant-v2-style workspace: a sidebar on desktop, and a drawer
plus bottom navigation on phones. It has one module (`sokoni-rider-hub.js`) and one stylesheet
(`sokoni-rider-hub.css`). The old page ran four delivery pipelines on one long scroll; the new one has 16 sections:

| Group | Section | Data authority (unchanged) |
|---|---|---|
| — | Overview | rider profile, presence, ledger, board, wallet |
| Operations | Rider Drive | `packageRequests` (assignedDriverId) + `orders` (assignedDriverUid) listeners; PIN → `completeDeliveryWithPin` / `completeParcelWithPin` |
| | Available Deliveries | `/api/available-deliveries` (Bearer) + `claimAvailableDelivery` |
| | My Deliveries | `packageRequests` / `orders` assigned to the rider (tabs: active, upcoming, completed, cancelled, returned, disputed) |
| | Live Map | last GPS fix (or "Location unavailable") + `rider-nav.html` turn-by-turn |
| Business | Earnings | `walletTransactions` type `delivery_earning` (the exactly-once ledger credit) |
| | Wallet & Settlements | `wallets/{uid}` (read), `payouts` (entityId); withdrawals stay in the Financial Center |
| | Performance | the rider's own records + `csatRatings`; tiers and bonuses "Not available yet" |
| | Fuel (EPRA) | `sysConfig/fuelPrices` + `triggerEPRAFuelFetch` |
| Rider | Delivery Categories | `SokoniDelivery.CATEGORY_CONFIG` (the only category authority) + live board counts |
| | Application | `applications` (uid, type driver), read only; applying goes to `onboarding-driver.html` (the one wizard) |
| | Documents & Verification | rider profile + server presence (coarse; the server never names the failing check) |
| Account | Notifications · Messages · Support · Settings | existing pages: `notifications.html`, `messages.html`/`chat.html`, `support.html`, `profile.html` |

Presence is **server-decided** (`riderPresence`): status, online, offline, and a 60 s heartbeat. Riders only
see rider sections; a non-rider deep link falls back to Application once the profile has answered.
`#earnings` and `#/earnings` both work, because rider emails already link `driver.html#documents` / `#earnings`.

## Kept from the old portal (real features)
- Go online/offline and the heartbeat.
- The available board (with sokoni-e3's parcel projection) and claim.
- Dispatch offers (`dispatchQueue` + `respondToDispatch`).
- The packageRequest and order lifecycles through the existing writers (`SokoniDB.updatePackageRequest`, `SokoniOrders.rider*`).
- PIN completion through the server, with no fallback, plus the shadow verification call.
- Proof-photo upload to `deliveryProofs/`.
- "Report a problem".
- Navigation to Google Maps (destination per card, per stage, with an address fallback).
- EPRA fuel prices.
- The `users/{uid}.driverProfile.shiftStatus` mirror of the server's answer.

## Added (existing authorities, newly reachable)
- **Failed delivery** → `handleFailedDelivery`. The rider picks one of customer unavailable, wrong address, refused,
  breakdown, or seller delay. The server decides retry, reassign, return, refund or support, and the UI states the
  consequence before sending.
- **In-app chat** with the customer: `chat.html?tx=logistics_request|order`. There is no WhatsApp hand-off.

## Removed (owner decisions 2026-10-03)
- **The legacy DeliveryHub `deliveries` pipeline.** It showed the delivery PIN to the rider and accepted a wrong
  PIN as "Delivered!". Its documents stay in the database untouched.
- **Insurance claims, the KES 500 referral, and the "8 PM daily payout" copy.**
- **The localStorage driver record**, which held the PIN and ID photos as base64.
- **The browser "claimable orders" list.** The rules refuse it; the Available board is the authority.
- **`Math.random` distances and the hard-coded 88% share.**
- **Tiers and bonuses are KEPT** (owner) and shown as "Not available yet" until a real bonus programme exists.

## Honest-state rules
- **Unknown values:** shown as "—" or "Not available yet", never 0. A failed read says "Could not load" with Retry.
- **Success copy:** "Delivery confirmed" appears only after the server returns `ok`. A wrong PIN keeps the delivery
  active.
- **Escaping:** every server value is HTML-escaped. The old cards inserted addresses and names raw.
- **EPRA fuel:** prices appear exactly as received, with no fallback prices or invented trends. A failed scrape shows
  "EPRA prices unavailable". The scraper itself is broken: EPRA moved to `/pump-prices`, and that fix is a separate
  functions slice.

## Tests
- `scripts/test-delivery-hub-browser.js`: **51/0**, in real Chromium with every dependency stubbed. It covers the
  gates, presence, board, Rider Drive, PIN, failure, earnings, wallet, performance, fuel, all 16 routes, mobile and
  deep links, plus static security checks. **Sabotage 8/8.**
- **Retargeted suites.** These had pinned old `driver.html` function names. Every label and contract is kept; the
  checks now point at the new module, and they still run unchanged against a legacy tree:
  - `test-delivery-completion-path` 33/0 (legacy 31/2, the same pre-existing 2)
  - `test-delivery-pin-unreachable` 66/0 (legacy 65/0)
  - `test-rider-navigation` 25/0 (legacy 24/0)
  - `test-slice-b-support-whatsapp` W8 (same 18/2 environmental result as the parent)
- **Unchanged vs parent:** role-authority 155/0, role-switch 50/0, map ratchet 6/2 (pre-existing), auth-post-login 29/0.
- **Hosting gates:** the syntax gate is clean (1,833 JS files / 449 inline blocks) and the CSP test passes.
- **Not run:** a live production browser test (nothing is deployed). The approved-rider positive path in production
  stays UNPROVEN under the D2 owner rules: no IAM-minted test identity, and nobody presses Go Online on the
  uncleared rider.

## Deploy prerequisites (separate authorization)
1. Merge whatever hosting is live at the time, plus sokoni-4d's `admin-failures-on-chain` and my B2/register unit.
   Then re-run this suite, the retargeted suites, and `test-admin-payout-approvals.js`.
2. Functions this page expects that are not live yet: `completeParcelWithPin` (sokoni-e3's parcel unit). Until then
   a parcel job's completion fails honestly. Everything else it calls is live.
3. One hosting deploy at a time, then verify `/driver` live with a cache-buster and `version.json`.

## Known limitations / follow-ups
- Pending wallet balance, document expiry, acceptance rate and on-time rate have no server source yet.
- `rider-dashboard.html` (a second online toggle that bypasses `riderPresence`) and `food-rider.html` (entirely
  localStorage) are untouched. They should be folded in or retired in a follow-up slice.
- The EPRA scraper fix (functions) is not built yet.
- The profile dropdown (`sokoni-profile-menu.js`) mounts on this page once the register unit's `autoMountOwnChrome`
  is merged.

## Closure round 2026-10-03 (later)

**One rider workspace.**
- `rider-dashboard.html` was a second online toggle: it wrote `riderLocations/{uid}.status` from the browser and
  bypassed `riderPresence`. It is now a redirect to `/driver`.
- `food-rider.html` was a fake portal (localStorage orders, Math.random location and fees, a hard-coded rider). It
  now redirects to `/driver#/available`.
- `driver-dashboard.html` and `courier-dashboard.html` returned **404 on live** while `profile.html`, the profile
  switcher and onboarding linked to them. They are now redirects too, mapping `#nav` to `#/map`, `#earnings`,
  `#stats` to `#/performance`, and so on.
- Entry links are repointed to `driver.html`: the profile switcher (rider, driver, courier), onboarding,
  services.html (2) and the home page (1).

**Honest states.**
- If `completeParcelWithPin` cannot be reached, the rider sees "Parcel completion is temporarily unavailable".
  There is no fallback.
- Failed delivery: the confirmation states SOKONI's published policy. Afterwards the modal shows the decision
  `handleFailedDelivery` actually returned (`{action, attemptsLeft}`).

**Rules-compliant rider writes.** The served `packageRequests` rules let the assigned rider change only `status`,
`acceptedAt`, `arrivedAtSellerAt`, `pickedUpAt`, `driverNote` and a few location/timeline fields. The old portal's
Accept (`driverName`), Pass (`assignedDriverId: null`) and problem report (`deliveryIssue*`) were all refused
silently.
- **Accept:** now writes only `status` and `acceptedAt`.
- **Pass:** removed; declining goes through the dispatch offer, or Problem → breakdown, which the server reassigns.
- **Problem report:** now writes `driverNote`.
- **Proof photo:** Storage has no `deliveryProofs/` rule (default deny), so it shows "not available yet".

**Security matrix (D-01…D-12).** Where each row stands today:

| Row | Authority | Evidence | Status |
|---|---|---|---|
| D-01 unauthorized rider online | `riderPresence` eligibility | D2 emulator 37/0 (09-30); browser P1 shows the refusal | PASS (emulator 09-30) / UI PASS |
| D-02 claim an already-claimed job | `claimAvailableDelivery` (`job_assigned` / `order_assigned` refusal) | dispatch-authority 45/0 (unit); browser B4 | code PASS; **two-rider race UNPROVEN** (emulator, blocked on RAM) |
| D-03 wrong PIN | `completeDeliveryWithPin` (HMAC, attempts lock) | pin-unreachable 2.23–2.25; browser D6/D9 | PASS |
| D-04 rider fabricates delivered | **served rules: the rider branch allows ANY status + `deliveredAt`/`payoutDue`** | rules read 10-03 | **FAIL — OPEN (rules slice; D2 owner gate)** |
| D-05/06 another rider's / customer's data | `packageRequests` read = `assignedDriverId`; board shows the area only | pin-unreachable 3.5/3.6; delivery-authorization (emulator) | static PASS; emulator BLOCKED |
| D-07 browser changes earnings | `walletTransactions` read-only, wallets admin-only | rules read; browser E1 | PASS (static) |
| D-08 browser changes payout | `f2d5f81`; payout gate | payout-idempotency 11/11; browser X4 | PASS |
| D-09 browser creates a delivery | `packageRequests` create = `claimsOwner` (any fields) | D1 finding | **OPEN** (same rules slice) |
| D-10 browser changes failed-delivery outcome | `handleFailedDelivery` | browser D10c/D10d | PASS (client); rules allow the rider to write any status (see D-04) |
| D-11 fake location | `_validGPS` on rider lat/lng; presence server-side | rules read | PARTIAL (format-validated, not authenticated) |
| D-12 fake application approval | applications: no decision fields (`appNoDecision`) | rules candidate | PASS in candidate; served = K13-A/B |

**Release preconditions (hosting, separate authorization):**
- Merge live, sokoni-4d's `admin-failures-on-chain`, my B2/register unit, and **sokoni-5b's Food Hub containment
  `2e5e33b`** (or the paying fake restaurants come back).
- Re-run this suite, the retargeted suites and `test-admin-payout-approvals.js`.
- Memory ≥ 512 MB and the deploy slot are free.
