# SOKONI Release State

**Last updated:** 2026-08-18 07:50 UTC

The single authoritative record of what is shipped, what is implemented but unproven, what is
blocked, and exactly what evidence each remaining item still needs.

> **Implemented ≠ Proven.** Every row below separates the two. A green CODE column says the work
> exists and is internally coherent. It says nothing about whether it works in production. Only
> the DEVICE/E2E column can say that, and it is the only column that grants ACCEPTED.

Related: [[MERCHANT_ROUTE_MATRIX]] · [[NAVIGATION_CONTRACT]] · [[CANONICAL_COLLECTIONS]] · [[DEPLOYMENT_GUIDE]]

> **Supersedes** the `docs/RELEASE_STATE.md` written 2026-08-15 at `c6990e9`. That file is on a
> different lineage (not an ancestor of `rc/combined`) and its production figures — hosting
> `02faf36`, rules `e66d77a4` — are stale. Do not reconcile against it.

---

## Production — what is actually live

| Component | Live version | Verified how |
|---|---|---|
| **Hosting** | `cdfc8ab` · `sokoni-20260818060826-v523` | `version.json` read back cache-busted; page rendered |
| **Branch** | `rc/combined` | `version.json.branch` |
| **Firestore rules** | `53e1185c` | **INFERRED, not read back** — see note |
| **Functions — stock authority** | `merchantAdjustStock` ACTIVE | `functions:list`: v2 callable, us-central1, nodejs22, 256MiB |
| **Functions — POS checkout** | `posCompleteCheckout` ACTIVE | unchanged by this release |

> **Rules caveat.** `53e1185c` is *unchanged by construction*: the diff `8ce4ef8..96bce0b` touches
> no `firestore.rules*`/`storage.rules`, and every deploy has been `--only hosting` or
> `--only functions:merchantAdjustStock`. It has **not** been read back from the Rules API —
> `firestore:releases:list` is not a CLI command and the API needs an interactive token. Treat the
> ID as asserted, not measured, until someone reads it from the console.

---

## Workstream gates

The permanent shape. A workstream is READY only when every row above it is PASS.

```
MERCHANT WORKSTREAM
  implementation       COMPLETE         census: NOT BUILT = 0, all 14 areas exist
  static audit         PASS             14/14 areas located; 6-path POS chain reviewed
  hosting gates        PASS             11/11 at cdfc8ab, deployed 2026-08-18
  functions gates      PASS             4/4 at 96bce0b (merchantAdjustStock)
  device verification  PENDING          22-check run-sheet, never run
  production           NOT READY

POS WORKSTREAM
  architecture         6/6 STATICALLY REVIEWED
  authority runtime    0/3 NOT PROVEN
  client integration   PENDING          correctStock not in live hosting
  device E2E           BLOCKED
  acceptance           NOT READY
```

### Merchant completion census

Do not rebuild what is already live. Evidence column is what was actually measured, not assumed.

| Area | State | Evidence |
|---|---|---|
| Navigation (28 dests, grouped rail, bottom nav) | **EXISTS — verified on production** | rendered live: 4 headings, 28 items, bar `flex`, 45px clearance |
| Products form | **EXISTS — verified** | 29 controls, 0 black, 0 unlabelled, no h-overflow @390px |
| Dashboard / Analytics / Finance | **EXISTS** | one `AnalyticsEngine.compute()` over OrderService; Dashboard = Reports = Finance = Analytics |
| Orders | **EXISTS** | OrderService reads `posRetailSales`, de-dupes the local twin |
| Inventory authority | **EXISTS — deployed** | `merchantAdjustStock`, 39/39, us-central1 |
| Sell / POS chain | **EXISTS — statically reviewed** | 6 paths audited; client wiring not live |
| Role switching | **EXISTS — green** | role-switch-routing 50/0, provisioning 57/0, acting-role 36/0 |
| Shop identity | **EXISTS** | canonical `activeShopId` resolver (`8ce4ef8`) |
| Finance surface | **BUILT / NOT PROVEN** | `revenue` → `renderAnalytics()`; same AnalyticsEngine as Dashboard/Reports |
| Shop settings | **BUILT / NOT PROVEN** | `shop` → seller.html `store` section (3 matches) |
| Fulfilment (orders → rider) | **BUILT / NOT PROVEN** | `seller-fulfilment.html` 24KB + `seller-delivery.html#riders` 35KB |
| Subscriptions / entitlements | **BUILT / NOT PROVEN** | `plans.html` 24KB + `renderPlan()` |
| Start Selling routing | **BUILT / NOT PROVEN** | `sokoni-merchant-entry.js` — ONE resolver, so the seven scattered CTAs cannot drift; 3 branches unverified at runtime |
| Add Role wizard | **BUILT / NOT PROVEN** | `sokoni-profile-switcher.js`; scroll / background-lock / Cancel are DEVICE-only checks |

> **CENSUS RESULT (2026-08-18): NOT BUILT = 0.** All fourteen areas exist in source. There are no
> implementation gaps to fill. Every remaining item is BUILT / NOT PROVEN, so the outstanding work
> is VERIFICATION, not building. Do not "complete" what is already complete.
> evidenced; six are unaudited and may need nothing at all. Building across all fourteen without
> auditing first risks rebuilding working surfaces — the same trap avoided by not porting 2D-1C.

---

## Release status

| Workstream | Code | Deployed | Device/E2E | Status |
|---|---|---|---|---|
| Merchant product form | `cdfc8ab` | ✅ hosting | 4 checks | **PENDING** |
| Merchant shell / rail / bottom nav | `cdfc8ab` | ✅ hosting | 7 checks | **PENDING** |
| Role switching & authorization | `8ce4ef8` | ✅ hosting | 7 checks | **PENDING** |
| SW counter floor | `1ea4d35` | ⏸ rides next hosting deploy | n/a | READY |
| **Stock authority** (`merchantAdjustStock`) | `96bce0b` | ✅ functions | **REQUIRED** | **PENDING** |
| **POS phone-first UI** | `ce68078` | ❌ held | **REQUIRED** | **BLOCKED** |
| POS client → authority wiring | `96bce0b` (`correctStock`) | ❌ not in live hosting | **REQUIRED** | **BLOCKED** |
| Payments (M-PESA/STK) | pre-existing | ✅ | **REQUIRED** | UNPROVEN |
| Receipt / printer path | pre-existing | ✅ | **REQUIRED** | UNPROVEN |

---

## merchantAdjustStock — state detail

```
CODE        ✅  96bce0b
UNIT TEST   ✅  39/39  (scripts/test-merchant-adjust-stock.js)
STATIC REV  ✅  10-point pre-merge review; 1 finding found + fixed
DEPLOY      ✅  us-central1, v2 callable, nodejs22
REAL CALL   ⏳  never invoked by an authenticated merchant
DEVICE E2E  ⏳
ACCEPTED    ❌
```

**Reachability today: none.** Live hosting is `cdfc8ab`, which predates `correctStock` entirely. The
callable is deployed but has no client consumer, so no merchant's behaviour changed. Rollback is
`firebase functions:delete merchantAdjustStock` with zero blast radius.

**Proven (unit, against an in-memory Firestore double):** transactional stock change; wrong
seller and mismatched shop rejected with stock unchanged and no movement written; missing / zero /
non-integer / out-of-range delta rejected; invalid and missing reason rejected; below-zero
correction refused; duplicate `adjustmentId` idempotent with exactly one product write;
`inventoryVersion` advances exactly once; `sold` never written.

**Not proven:** real Firestore transaction semantics under contention; the deployed callable
answering an authenticated merchant; App Check attestation actually succeeding from the POS
client; rules interaction; the five authority checks below.

**Required before ACCEPTED** — each needs a real authenticated call:

- [ ] authorized merchant corrects their own product → `products.stock` changes
- [ ] wrong shop → rejected, stock unchanged
- [ ] duplicate `adjustmentId` → idempotent, no second mutation
- [ ] `inventoryVersion` advances exactly once
- [ ] `sold` remains unchanged

---

## POS — required acceptance

```
Sell → Stock → Checkout → Payment Prompt → Payment Result
     → Receipt → Inventory Sync → Dashboard Sync
```

```
UI foundation         ce68078    COMMITTED / UNACCEPTED
Stock authority       96bce0b    IMPLEMENTED / DEPLOYED / UNVERIFIED
Client integration               PENDING  (correctStock not in live hosting)
Device verification              BLOCKED
Production acceptance            NOT READY
```

### Not yet proven

- Real phone checkout
- M-PESA / STK prompt lifecycle
- Payment result handling (`pending` → `completed` / `failed` / `cancelled`)
- Receipt generation and merchant identity on it
- Native printer / Bluetooth / scanner path
- Inventory convergence — sale and correction reaching the same `products/{id}.stock`
- Dashboard convergence
- Offline / network recovery and delayed-payment reconciliation

### Why it cannot be verified from here

POS does not mount in a headless browser: App Check refuses attestation and the module graph
aborts (measured: **103 aborted requests**, tab bar `0×0`). Every element measured during the
`ce68078` layout work returned `h=0`. That change proved the CSS **resolves**; it did not prove the
surface **renders**, and no link of the chain above has been exercised.

### POS prerequisite status

```
STATIC ARCHITECTURE
  Checkout path              STATICALLY REVIEWED
  Payment prompt             STATICALLY REVIEWED
  Payment result             STATICALLY REVIEWED
  Receipt                    STATICALLY REVIEWED
  Inventory synchronization  STATICALLY REVIEWED
  Dashboard synchronization  STATICALLY REVIEWED

PRODUCTION AUTHORITY (authenticated calls)
  merchant correction        NOT PROVEN
  wrong-shop rejection       NOT PROVEN
  idempotency                NOT PROVEN

CLIENT
  POS client integration     PENDING
  ce68078 merge              PENDING

DEVICE
  Device E2E                 BLOCKED

ACCEPTANCE
  Production acceptance      NOT READY
```

> **What STATICALLY REVIEWED means, and does not.**
> Static review establishes that the intended authority chain exists in source. It does **not**
> establish that production runtime behavior, Firestore transactions, App Check, Safaricom
> callbacks, device behavior, Bluetooth/printing, or cross-surface convergence work.

**Audited chain** (source reading, 2026-08-18):

```
Sell → canonical stock → checkout → payment request
     → server callback/result → receipt → Orders/Analytics → Dashboard
```

| Path | Authority | Failure states | Duplicate / retry | Writes | Next consumer |
|---|---|---|---|---|---|
| Checkout | `posCompleteCheckout` | insufficient-stock pre-check in tx; all-or-nothing | `idempotencyKey` claimed in `posIdempotency` **inside** the tx | `products.stock`↓, `inventoryVersion`↑, `sold`↑, `posRetailSales`, `posDaily`, `posCheckoutMetrics` | OrderService |
| Payment prompt | `darajaSTKPush`, seller creds from `shopSettings` | Daraja auth failure throws before any prompt | caller `orderId`; Safaricom returns `CheckoutRequestID` | `posPayments/{CheckoutRequestID}` | `darajaSTKCallback` |
| Payment result | `darajaSTKCallback` (onRequest) + `posCheckPaymentStatus` | explicit `pending` / `completed` / `failed` / `cancelled` | poll is read-only; falls back to `posIdempotency` | `posPayments`, `posPaymentStatus` | POS realtime listener |
| Receipt | created by `posCompleteCheckout`; `posLogReprint` counts reprints | — | reprint counter transactional (`posReprintCounters`) | receipt doc + counter | `sokoni-pos-print-service.js` → Bluetooth / label / network |
| Inventory sync | `posCompleteCheckout` (sale) / `merchantAdjustStock` (correction) | below-zero refused on both | both idempotent, different keys | canonical `products/{id}.stock` — **one field** | catalogue, POS cache |
| Dashboard sync | `AnalyticsEngine.compute()` over OrderService | — | read-only | none | Dashboard = Reports = Finance = Analytics |

**Money never confirms from a request response.** `darajaSTKPush` only *sends*; Safaricom calls
`darajaSTKCallback` server-side; the client polls `posCheckPaymentStatus`. Prompt and result are
separated by a server boundary.

### Stock convergence invariant

```
sale:        stock ↓     inventoryVersion ↑     sold ↑
correction:  stock ↑/↓   inventoryVersion ↑     sold UNCHANGED
```

Two authorities, one canonical field, and **no server-side reconciliation between them**. Each is
individually safe; nothing cross-checks them. `inventoryVersion` is the tell — if a device run ever
shows `stock` moving without `inventoryVersion` advancing, or `sold` moving on a correction, that is
this seam failing.

### Orders observability — required on device

`posCompleteCheckout` writes **`posRetailSales`, not `orders`**. That is correct by design —
OrderService unifies both and de-duplicates the local twin ("same sale, two stores → one row") —
but it means anything reading `collection('orders')` directly will not see a POS sale.

The device run must therefore prove the merchant's **Orders surface actually exposes the POS sale
through OrderService**, not merely that a `posRetailSales` record was created. A written record is
not observability.

### Device acceptance command

**DO NOT run until every prerequisite is green:**

- [x] `merchantAdjustStock` deployed
- [x] callable verified present in `us-central1`
- [x] App Check enforcement declared in source
- [ ] authenticated merchant correction verified
- [ ] wrong-shop rejection verified
- [ ] adjustment idempotency verified
- [ ] `ce68078` merged into `rc/combined`
- [ ] POS client wired to the authoritative correction path **and deployed to hosting**
- [x] checkout / payment-prompt / payment-result / receipt / inventory / dashboard paths reviewed statically
- [ ] hosting gates green
- [ ] no unrelated production changes
- [ ] this file updated

**When ready, the single acceptance test:**

> Test POS end-to-end on the real merchant phone: Sell → Stock → Checkout → Payment Prompt →
> Payment Result → Receipt → Inventory/Dashboard Sync. Do not stop at UI success. Confirm the
> actual production records and displayed state after each transition. Verify native phone
> behaviour, payment prompt, receipt/printer path, stock decrement, order creation, and live
> dashboard convergence. Report every failure with exact step, screenshot, timestamp,
> order/reference ID, and expected vs actual result. **Do not retry a financial operation blindly.**
>
> Include explicitly: **the merchant's Orders surface must show the sale** (via OrderService, since
> `posCompleteCheckout` writes `posRetailSales` and not `orders`), and `inventoryVersion` /
> `sold` must move per the convergence invariant above.

### The convergence check that matters most

Manual correction and sale reach the same canonical field through **different authorities**:

```
correction   correctStock → merchantAdjustStock → products.stock, inventoryVersion+1, stockMovements
sale         checkout     → posCompleteCheckout → products.stock, inventoryVersion+1, sold+1
```

A correction advances `inventoryVersion` and leaves `sold` alone; a sale advances both. If the two
ever disagree about the same shelf, that is where it will surface.

---

## Untested / pending work

### Merchant onboarding — 22 device checks

- **Scope** — seller workspace (7), product form (4), role switching (5), Start Selling + Add Role (4), buyer-only negative control (2)
- **Current commit** — `cdfc8ab`
- **Production state** — LIVE
- **Already proven** — 29 form controls with 0 black and 0 unlabelled; no horizontal overflow at 390px; 16px inputs; 48px targets; rail renders Main/Growth/Operations/Marketplace with 28 destinations; bottom nav present with 45px clearance (content bottom 855 = bar top 855); all measured on production
- **Unproven** — every authenticated behaviour: real shop-name resolution, live dashboard values, touch scrolling in the Add Role wizard, background scroll-lock, buyer-only `/merchant` refusal
- **Required evidence** — the 22-check run-sheet on a real phone
- **Blocker** — no credentials; no device
- **Owner** — founder
- **Acceptance** — 22/22, or triaged failures

### POS device acceptance

- **Scope** — the full chain above
- **Current commit** — `ce68078` (UI) + `96bce0b` (authority)
- **Production state** — authority deployed, UI held, client wiring not live
- **Already proven** — CSS resolves at 390px; 39/39 authority unit tests; 10-point static review
- **Unproven** — everything functional
- **Required evidence** — the device acceptance command above
- **Blocker** — prerequisites not green
- **Owner** — founder + engineering
- **Acceptance** — every chain link confirmed against production records, not UI state

---

## Known pre-existing debt

Reproduced on clean `rc/combined` **before** this release. Not regressions; do not chase them
during device runs.

| Item | Evidence | In hosting deploy path? |
|---|---|---|
| `verify-receipt-naming` fails (117 deprecated uses, "109 → 117") | identical with and without `cdfc8ab` | **No** — npm `predeploy` only, not `firebase.json` |
| `test-role-authority` 147/1 ("…and was not repurposed for roles") | identical on clean baseline | No |
| `test-role-vocabulary` MODULE_NOT_FOUND | env — `functions/` deps not installed | No |
| `test-merchant-deep-switch` 13/2 (`messages`, `customers`) | identical at unmodified `HEAD` in a throwaway worktree | No |
| 90 duplicate element ids | audit baseline, no regression | Gate passes |
| SW counter shipped v523 after v530 | committed SW lagged production; floor raised in `1ea4d35` | Fixed forward |

### Open security finding — not fixed here

`analytics-engine._assertShop()` grants access when `shopEmployees/{shopId}_{uid}` merely **exists**,
and `firestore.rules` lets *any authenticated client* create a `shopEmployees` document naming
itself (`shopOwnerId == request.auth.uid`). That is a privilege-escalation path on read-only
analytics. `merchantAdjustStock` deliberately does **not** reuse that helper — see the ownership
block in `functions/merchant-inventory.js`. **Do not add an employee branch to any stock-write
surface until a verified employee contract exists.**

### Architectural gap — open

`PosDB.products.adjustStock()` remains IndexedDB-first with best-effort canonical sync. That is
**correct** for the sale, rollback and purchase-order paths, where canonical stock is owned by
`posCompleteCheckout` — routing those through the correction authority would deduct the same units
twice. Only manual corrections moved to `correctStock()`.

---

## Explicitly deferred

- **POS phone-first acceptance** — device verification required; `ce68078` held out of `rc/combined`
- **2D-1C port** (`sell` / `inventory` routes, `sokoni-merchant-sell.js`) — absent from `rc/combined`
  client *and* server. **Not required** for the POS chain: `posCompleteCheckout` already covers
  sell → stock → checkout → inventory → dashboard, and the client stock-writer
  (`updateProductStock`) was retired here independently.
- **`stockMovements` client-read rules** — no rules block exists, so client reads are denied and
  server writes are unaffected. A merchant-facing stock-history screen would need one. That is a
  **separate authorization decision** and must not be added for convenience.
- **`activeShopName` receipt semantics** — `_merchantPrint()` reads it as a receipt's
  `businessName`. Fiscal, not UI. The dashboard greeting only ever **reads** it.
- **Employee stock authority** — blocked pending a verified `shopEmployees` contract.

---

## Forbidden during this release

- Custom-claims changes
- Seller migration
- Firestore rules or index changes
- Payment-engine changes
- Deploying `ce68078` to hosting before device verification
- Exposing a partially verified financial workflow to a client
- Fixing unrelated hygiene debt inside a release commit
- Blind `git stash pop` — the stash stack is **repo-wide** across all worktrees

---

## The standing rule

> A backend capability may be deployed before its client consumer. A client must **never** expose a
> partially verified financial workflow.

`merchantAdjustStock` is deployed with no client consumer, and that is deliberate. It becomes
reachable only when POS ships — which is gated behind the device run above.
