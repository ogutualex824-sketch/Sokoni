# Merchant V2 ↔ POS Ecosystem — release batch design & readiness

**Date:** 2026-09-22 · **HEAD:** `6a4704d` · **Status:** DESIGN + AUDIT. **NOT BUILT. NOT
DEPLOYED. f937e5a NOT ported.** Live remains `111dbd7` / v636.

This is the §27 release artifact. It records what the convergence release must contain, what is
already built, and the three findings that mean the batch **cannot be assembled today** —
stated up front rather than discovered at the end.

Related: [[MERCHANT_V2_POS_ECOSYSTEM_MAP_2026-09-22]] · [[POS_SALES_LIFECYCLE_AUDIT]] ·
[[MERCHANT_V2_ECOSYSTEM_MAP]]

---

## 0. STOP CONDITIONS — read before building anything

### SC-1 — Half this release is ALREADY IN FLIGHT, uncommitted, by another agent

The working tree carries 19 untracked files that are not mine. Their own headers state that
they implement **exactly** what §3, §4, §5 and §7 ask for:

| File | Its own header says | Brief section it implements |
|---|---|---|
| `sokoni-pos-tender.js` | *"MULTI-TENDER ENGINE — One sale, N tenders. Cash + M-PESA + card + anything else the IntaSend account has enabled, in the same transaction, in any combination."* | **§5** manual/mixed tender, **§4** |
| `sokoni-catalogue-model.js` | *"One catalogue, two commerce types… A service is a `posProducts` row with `trackStock: false`, a `unit`, and optionally `variablePrice: true`. There is no `posServices` collection"* | **§3**, **§7** services in the cart |
| `functions/shared/pos-service-pricing.js` | *"A till should not care whether it is selling a phone charger, ten printed pages, a haircut, a car wash or a government application. They are all a priced line on one sale."* | **§3** cyber/printing/photocopying |
| `sokoni-pos-pay-console.js` | *"The cashier's payment surface. One sale, any number of tenders, in any combination the customer asks for"* | **§5**, **§6** PDQ optionality |
| `functions/shared/intasend-checkout.js`, `scripts/probe-intasend-capability.js` | provider tender capability | **§4**, **§6** |
| `functions/shared/business-scope.js`, `sokoni-provider-application.js`, `business-apply.html` | provider/service identity and approval | **§3** service-provider identity |
| `sokoni-merchant-nav.js` | products vs services workspaces, *"A SUBSCRIPTION NEVER CREATES A WORKSPACE"* | **§3** |
| `catalogue.html` | the catalogue surface | **§7** |

Plus eight matching `scripts/test-*.js` suites.

**Building §3–§7 now would produce a second, competing implementation of the cart, the service
model and the tender engine** — the precise outcome this brief's CORE PRINCIPLE forbids
("DO NOT CREATE PARALLEL AUTHORITIES… No duplicate payment authority"). It would also be
unmergeable: two service models, two tender engines, one `posProducts` collection.

**Required before §3–§7 can start:** that workstream commits, or its owner hands it over. Until
then those sections are **NOT RUN**, not "pending".

### SC-2 — §12 INVERTS the commission lanes

§12 of the brief states:

```
Marketplace:  5%, minimum KES 10
Till/POS:     15% according to the latest approved decision
```

Both prior instructions said the opposite:

> *"pos commission and till is 5% per sale then 15% commission per sale for online orders"*

and the decision taken on the direct question was **"Flat 15%, retire the ladder"** for the
**online/marketplace** lane.

`e1e35e3` implements **marketplace/online 15%, till 5%, minimum KES 10**. That matches the two
explicit instructions and contradicts §12. **The implemented state has been left as-is and NOT
inverted on the strength of an ambiguous line**, because inverting it silently would reprice
every till sale threefold. This needs one word of confirmation.

§12 is also right about one thing and it is preserved: `resolvePosRate → POS_PLAN_RATES` is
independent of the marketplace table, and `RATES.marketplace.pct` was deliberately left at 5
because `ALIASES.pos = 'marketplace'` would otherwise carry any change into the till.

### SC-3 — "Premium Roster" has a backend and NO front end

§16 says *"Everything already built for Premium Roster must be preserved and connected… Do NOT
rebuild Premium Roster."*

Measured: `functions/pos-shift-scheduler.js` exports **12 roster CFs**, all re-exported by name
in `functions/index.js` — `createShiftTemplate`, `publishWeeklyRoster`, `assignShift`,
`swapShiftRequest`, `approveShiftSwap`, `setStaffAvailability`, `getRoster`, `getRosterGaps`,
`getStaffRoster`, `acknowledgeShift`, `schedulerWeeklyDigest`.

**None of them has a client caller.** Scanned every `.html`; the detector found the control
(`openShift`, present in `pos-staff-ops.html`, `pos-hq.html`, `pos-checkout.html`) and found
**zero** occurrences of any roster CF.

`pos-staff-ops.html` — which Merchant V2's "Shifts & rosters" card opens — calls 16 CFs, all of
them **shift and attendance**: `openShift`, `closeShift`, `clockIn`, `clockOut`, `getAttendance`,
`getAttendanceSummary`, `getCurrentShift`, `getShiftHistory`, `getCashReconciliation`,
`getPendingApprovals`, `checkApproval`, `reviewApproval`, `getStaffPerformanceDashboard`,
`calculateMonthlyCommission`, `approveCommission`, `getCommissionsSummary`. **No roster.**

So there is nothing built to preserve on the UI side. **"Connecting" Premium Roster means
BUILDING its surface** — new work against an existing authority, not wiring. That is a
different decision from the one §16 assumes, and it is the owner's to take.

Same shape as `voidPOSSale`: a complete, deployed, hardened authority that nothing invokes.

---

## 1. Architecture — the target, unchanged from the brief

```
                 MERCHANT V2
                     │
              SALES CONTROL CENTRE
                     │
                CANONICAL CART
                 /         \
          PRODUCT             SERVICE          <- posProducts, trackStock:false
             │                  │
             └──────┬───────────┘
                    │
                 TENDER
          ┌─────────┼─────────┐
        CASH     MANUAL    PROVIDER            <- no PDQ required
                    │
                 SALE                          <- posCompleteCheckout
                    │
       ┌────────────┼────────────┐
   INVENTORY      RECEIPT     REPORTING
                    │
              NOTIFICATIONS

BUYER -> ONLINE ORDER -> SOKONI/IntaSend -> MERCHANT -> FULFILMENT/DELIVERY
```

The two transaction domains connect at the ecosystem level (catalogue, inventory, customers,
payments, notifications, reporting) and **never become one transaction authority**.

---

## 2. Authority map — what already exists

| Domain | Canonical authority | Merchant V2 entry | Status |
|---|---|---|---|
| POS sale (till) | `posCompleteCheckout` → `posRetailSales` | `pos` → pos-checkout, `orders` | CONNECTED |
| POS sale (dispatch) | `recordPOSSale` → `posSales` | five `lineage:'dispatch'` routes | SPLIT (B-1) |
| Void | `voidPOSSale` → `posSales` | none, deliberately | BLOCKED |
| Refund (till) | `posProcessRefund` → `posRetailSales` | in the till | CONNECTED |
| Returns (marketplace) | `returns-engine`, 6 CFs | `returns` | CONNECTED |
| Payments (marketplace) | `payment-orchestrator`, IntaSend | `payments` | CONNECTED |
| Tender (POS) | `posSendMpesa`, `posCheckPaymentStatus`, in-checkout legs | the till | CONNECTED |
| **Multi-tender / manual** | **`sokoni-pos-tender.js` — UNCOMMITTED (SC-1)** | — | **NOT RUN** |
| **Service pricing** | **`pos-service-pricing.js` — UNCOMMITTED (SC-1)** | — | **NOT RUN** |
| Receipts | `sendPOSReceipt`, `posReceipts` + `receipts`, trust receipts, eTIMS | `receipts` | CONNECTED, two stores |
| Inventory | `products/{id}.stock`; `merchantAdjustStock`; import CFs | `inventory`, `products`, `pos-import` | CONVERGED (D-a, D-b open) |
| Suppliers | `sokoni-merchant-supply.js`, 12 ops | `supply` | CONNECTED; GRN→stock UNPROVEN |
| Customers | `crmCustomerProfiles`, `getCRMDashboard` | `customers`, `pos-crm` | CONNECTED |
| Online orders | `orders/{id}`, `order-settlement` | `orders` | CONNECTED, distinct |
| Delivery | `packageRequests`, `onDeliveryStatusChange` | `deliveries`, `fulfilment`, `riders` | CONNECTED |
| Commission | `commission-config.js` (single source) | Settings, display-only | CONNECTED (SC-2) |
| Staff | `shopEmployees` contract | `staff` | CONNECTED |
| Shifts / attendance | `openShift`/`closeShift`/`clockIn`/… | `pos-staff-ops` | CONNECTED |
| **Roster** | **`pos-shift-scheduler.js`, 12 CFs** | **none** | **NO UI (SC-3)** |
| Notifications | `notifications` + `notify.js` + `sokoni-device-bus.js` | none | NOT WIRED |
| Realtime | `sokoni-device-bus.js`, proven in `4b7e3af` run-2 | partial | PARTLY PROVEN |
| Advanced POS settings | `pos-setup.html` | `pos-printer-setup.html` | **GAP (B-3)** |
| AdminOS | `admin-os.html` | none, deliberately | BOUNDARY HELD |

---

## 3. AdminOS — verified from the repository AND live (§20)

Requested: verify rather than assume. Done, three ways:

| Evidence | Result |
|---|---|
| File on disk | `admin-os.html`, 66,803 bytes, last committed 2026-09-21. `adminos.html` **does not exist** |
| Its identity | `<title>Admin OS — SOKONI Mission Control</title>`, loads `/sokoni-admin-guard.js` as its first script |
| Service-worker precache | `"/admin-os"` is precached; `"/adminos"` is not |
| **Live** | `GET https://mysokoni.co.ke/admin-os` → **HTTP 200**, 61,160 B · `GET /adminos` → **HTTP 404** |

`admin.html` (491,848 B, 2026-08-26, `<title>SOKONI — Admin Panel</title>`) is the superseded
console and carries no guard script at the head.

**Canonical AdminOS = `admin-os.html`, route `/admin-os`.** Merchant V2 links to neither, by
design — it is the platform-operator console and a merchant row would be a privilege defect.
Asserted by `test-merchant-ecosystem.js` §5b, including a control proving the detector does not
mistake `minishop-admin.html` (the merchant's own MiniShop editor) for an admin console.

---

## 4. Projection safety contract (§25) — designed, not built

```
posRetailSales/{saleId}          (TILL, authoritative)
        │  idempotent trigger, deterministic id
        ▼
posSales/{same saleId}           (projection, NOT authoritative)
        sourceLineage: 'till'
        sourceRecord:  '<posRetailSales id>'
        projection:    true
```

The projection writes **a document and nothing else**: no stock write, no payment, **no
commission liability**. `recordPOSSale` posts a liability via `recordSaleLiability`; the
projection must not, or every till sale is billed twice.

**The guard is part of the same unit, not a follow-up.** `voidPOSSale` restores stock
(`stock +qty`, `soldCount -qty`). Without a guard, voiding a projected document returns stock the
TILL lineage already owns — and if the sale were also refunded through `posProcessRefund`, stock
is returned **twice**. So:

1. `voidPOSSale` **refuses**, server-side, any document carrying `projection: true`, naming
   `posProcessRefund` as the reversal for that sale. Fail closed.
2. Deterministic doc id = source `saleId`, so replay is a no-op and the lineages cannot collide
   on an auto-id.
3. Tests: *till sale → projection → intelligence visibility → dispatch void attempted → REFUSED*;
   and separately *dispatch sale → posSales → legitimate void → succeeds*; plus a stock-count
   assertion proving exactly one restoration in each case.

**Shipping the trigger without the guard creates the double-restore.** They deploy together or
not at all.

**Why it is not written yet:** it is a Cloud Function plus a money-path change, functions deploys
are blocked from this branch by the merchant-identity provenance gap, and the in-flight tender
work (SC-1) changes what a completed sale looks like. Writing it against a sale shape that is
about to change would have to be redone.

---

## 5. Inventory convergence (§9) — the two divergences

Both are real and neither is a rename.

**D-a — `sold` vs `soldCount`.** TILL writes `sold` (plus `lastSoldAt`, `totalUnitsSold`,
`totalRevenue`); DISPATCH writes `soldCount`. Before any repair, the consumers of each must be
enumerated — a rename breaks whichever surface reads the other spelling. **Not attempted here.**

**D-b — `inventoryVersion`.** TILL bumps it; DISPATCH does not. It is the cache-invalidation
counter, so a DISPATCH sale moves canonical stock **without invalidating client caches**.
This one has an obvious minimal repair (bump it in `recordPOSSale`'s existing transaction) and
no consumer-enumeration problem — but it is a money-path file edit requiring a functions deploy,
so it belongs in the same batch as §4.

**Service items must not decrement physical stock.** The mechanism already exists and is already
honoured by the till: `posCompleteCheckout` skips the stock write when `trackInventory !== false`
is false (`pos-zero-friction.js:778`). The in-flight catalogue model uses `trackStock: false` for
services. **These two flags are spelled differently and that must be reconciled when SC-1 lands
— it is exactly the D-a defect in the making.** Flagged now, before it ships.

---

## 6. What this release must contain (§24 A–Q), with real status

| | Item | Status |
|---|---|---|
| A | Sales projection | DESIGNED (§4) · blocked on SC-1 + deploy |
| B | Provenance marker | DESIGNED |
| C | Void guard | DESIGNED |
| D | Inventory convergence | D-b has a minimal repair; D-a needs consumer enumeration |
| E | Quick Pay service/product cart | **NOT RUN — SC-1** |
| F | Manual cart tender | **NOT RUN — SC-1** |
| G | Supplier connection | CONNECTED; GRN→stock UNPROVEN |
| H | Online-order integration | CONNECTED |
| I | Commission alignment | DONE (`e1e35e3`) · **SC-2 confirmation needed** |
| J | Staff/employee integration | CONNECTED |
| K | Shift integration | CONNECTED (shifts + attendance) |
| L | Premium Roster | **NO UI EXISTS — SC-3** |
| M | Advanced POS settings | GAP B-3 · audit blocked while `pos-setup.html` is dirty |
| N | Notification integration | NOT WIRED |
| O | Sales Control Centre | NOT BUILT — depends on A–F |
| P | Realtime connections | primitive proven (`4b7e3af`); Merchant V2 subscribers UNPROVEN |
| Q | Regression/security tests | 4 suites owned, 393 assertions, 0 failing |

**Four of seventeen are blocked on other people's work or on a decision.** The batch cannot be
declared ready, and assembling a partial one would violate §24's own requirement that these
changes cannot deploy in an unsafe partial state.

---

## 7. Tests owned today

| Suite | Result |
|---|---|
| `test-merchant-ecosystem.js` | 118 / 0 |
| `test-merchant-ecosystem-convergence.js` | 64 / 0, 6 UNPROVEN, 2 NOT RUN |
| `test-merchant-v2-ecosystem-runtime.js` | 115 / 0, 2 UNPROVEN |
| `test-inshell-chrome.js` | 29 / 0 |
| `test-pos-sale-commission.js` | 78 / 0 |
| `test-pos-commission-lane.js` | 92 / 0 |

Verdicts never collapse: **PASS / FAIL / UNPROVEN / NOT RUN**. An unavailable runtime dependency
yields UNPROVEN. The master matrix of §26 is **NOT RUN** — most of its rows exercise code that
does not exist yet (E, F, L, O).

---

## 8. Deployment prerequisites

1. SC-1 resolved — the in-flight cart/tender/service workstream committed or handed over.
2. SC-2 confirmed — which lane is 15%.
3. SC-3 decided — whether to build the roster surface.
4. B-3 audited — once `pos-setup.html` is quiescent.
5. Projection + guard written, deployed **together**, with the double-restore test green.
6. Realtime proven two-device per claimed domain, or marked UNPROVEN in the release notes.
7. A clean live-lineage worktree: this branch is **579 commits behind live**, and the
   `guard-no-rollback.js` in this tree is the **pre-`2cac28f`** copy that only refuses strict
   ancestors — it printed "allowing deploy" for a diverged tree. **Its green light is not
   evidence.**

**No deploy. No port. Live remains `111dbd7` / v636.**
