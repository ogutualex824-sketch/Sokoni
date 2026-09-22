# Merchant V2 ↔ POS / Sales Ecosystem — authority map

**Date:** 2026-09-22 · **HEAD:** f937e5a · **Status:** READ-ONLY AUDIT. No wiring changed by
this document. **NOT DEPLOYED. f937e5a NOT ported.**

**Method:** every row traced to the callable, collection and writer that actually executes.
File names were not treated as evidence of authority. Where a claim is an absence ("nothing
calls this"), the detector was checked against something it must find.

Related: [[POS_SALES_LIFECYCLE_AUDIT]] · [[MERCHANT_V2_ECOSYSTEM_MAP]] ·
[[CANONICAL_COLLECTIONS]] · [[PROVENANCE_GAP_MERCHANT_IDENTITY]]

---

## 0. The headline — §22 answered

**`posSales` and `posRetailSales` are not a projection, and not an accidental duplication of a
document. They are two COMPLETE, INTERNALLY CONSISTENT LINEAGES of the same concept, and the
estate is split between them.**

Each has its own creator, its own reversal, and its own readers. **No writer touches both** —
measured: `pos-zero-friction.js` contains zero references to `posSales`, and
`pos-retail-engine.js` contains zero references to `posRetailSales`.

```
TILL LINEAGE  (the merchant's real sales)
  posCompleteCheckout        pos-zero-friction.js:960   ──►  posRetailSales/{server uid}
  mirrorPosTransactionToRetail  pos-retail-mirror.js:40 ──►  posRetailSales/{txnId}
  REVERSAL: posProcessRefund pos-zero-friction.js:1325  ──►  posRetailSales   ← HAS a caller
  READ BY:  Merchant V2 Orders (OrderService posProvider), pos-intelligence,
            commission-settlement-authority, payment-trust, pos-staff-ops
  OWNER KEY: merchantId AND sellerId, both = shopId

DISPATCH LINEAGE
  recordPOSSale              pos-retail-engine.js:278   ──►  posSales/{auto-id}
  REVERSAL: voidPOSSale      pos-retail-engine.js:520   ──►  posSales         ← NO caller
  READ BY:  pos-bi, pos-accounting, pos-ai-assistant, pos-hq, pos-crm-pro,
            pos-inventory-pro, pos-integrations, pos-intelligence
  OWNER KEY: sellerId + cashierUid
```

### The three facts that decide the Void question

1. **`voidPOSSale` has ZERO client callers.** Measured across every `.html` and `.js` outside
   `functions/` and `scripts/`: the only non-test occurrence in the repo is the exclusion
   reason written in `sokoni-merchant-routes.js` by f937e5a. It is a live, hardened,
   dispatch-reachable callable that **nothing invokes**.
2. **`recordPOSSale` has ONE real client caller: `pos-onboard.html`** — the POS onboarding
   flow, which is classified out of merchant navigation. So `posSales` is fed, in practice,
   by onboarding.
3. **The till's reversal already exists and is already wired.** `posProcessRefund` operates on
   `posRetailSales` and is called from `pos-checkout.html:3236`.

**Therefore the correct repair is NOT to wire a Void button around the split.** A merchant's
real sales are in `posRetailSales`; the reversal for that lineage is `posProcessRefund`, and it
is already connected. Exposing `voidPOSSale` in Merchant V2 would offer a control that operates
on a collection the merchant's own sales do not enter.

> **The gate stands, with its answer recorded:** the split is intentional at the code level and
> unresolved at the product level. Until an owner decides which lineage is the completed sale,
> **no Void button is exposed**, and `posProcessRefund` remains the only reversal a Merchant V2
> sale can actually use.

### The consequence f937e5a did not know about

f937e5a routed **pos-bi, pos-ai, pos-books (accounting), pos-hq and pos-crm** into merchant
navigation. **All five read `posSales` only** — measured:

| Module | `'posSales'` refs | `posRetailSales` refs |
|---|---|---|
| `pos-bi.js` | 3 | **0** |
| `pos-accounting.js` | 7 | **0** |
| `pos-ai-assistant.js` | 5 | **0** |
| `pos-hq.js` | 1 | **0** |
| `pos-crm-pro.js` | 1 | **0** |
| `pos-inventory-pro.js` | 1 | **0** |
| `pos-integrations.js` | 3 | **0** |

A merchant selling through the real till writes `posRetailSales`. **Those five surfaces will
show that merchant nothing** — a destination with no data, which is the "button with no
destination" defect inverted. This is a finding against my own previous commit and is
listed as blocker **B-2**.

---

## 1. What IS already converged — inventory

**The sales records are split. The stock consequence is not.** All four money paths write the
same canonical `products/{id}`:

| Path | Writes |
|---|---|
| `posCompleteCheckout` (TILL) | `stock -qty`, **`inventoryVersion +1`**, `sold +qty`, `lastSoldAt`, `totalUnitsSold`, `totalRevenue`, `updatedAt` |
| `posProcessRefund` (TILL reversal) | `stock +qty` |
| `recordPOSSale` (DISPATCH) | `stock -qty`, **`soldCount +qty`** |
| `voidPOSSale` (DISPATCH reversal) | `stock +qty`, `soldCount -qty` |
| `merchantAdjustStock` (corrections) | `stock`, `stockMovements` record with mandatory reason |

So Products and Inventory in Merchant V2 already see every POS sale from either lineage. That
is the ecosystem's existing shared spine, and it is `products/{id}` — not a sales collection.

**Two divergences inside that spine, both new findings:**

- **D-a `sold` vs `soldCount`.** TILL maintains `sold`; DISPATCH maintains `soldCount`. Two
  spellings of one counter, one per lineage. Any surface reading one sees half the sales.
- **D-b `inventoryVersion` is bumped by TILL only.** `recordPOSSale` decrements `stock` without
  bumping it. `inventoryVersion` is the cache-invalidation counter
  ([[reference_sokoni_ordering_authorities]]: *inventoryVersion = stock*), so a DISPATCH sale
  moves canonical stock **without invalidating client caches**. A device can therefore keep
  serving a stale stock figure after a real deduction.

---

## 2. The required table

Columns per §20. `—` means not applicable; **UNPROVEN** means not settled by this audit.

### SALES

| | |
|---|---|
| Existing authority | **TWO**: `posCompleteCheckout` → `posRetailSales` · `recordPOSSale` → `posSales` |
| Merchant V2 surface | `orders` (native) via OrderService `posProvider` → `posRetailSales` |
| POS surface | `pos-checkout.html` (till) → `posCompleteCheckout` |
| Online-order surface | separate domain — see ONLINE ORDERS |
| Realtime source | Firestore snapshot on `posRetailSales` **UNPROVEN** (not verified live) |
| Mutation authority | server callable only; both collections client-write-refused |
| Read authority | `posRetailSales`: `sellerId == auth.uid` (rules) |
| Shared identity key | `shopId` — written as **both** `merchantId` and `sellerId` |
| Security scope | shop |
| Status | **SPLIT — gate open** |
| Evidence | `pos-zero-friction.js:960`, `pos-retail-engine.js:278`; zero cross-references |
| Gated dependency | **B-1** — which lineage is the completed sale |

### VOID

| | |
|---|---|
| Existing authority | `voidPOSSale` — `pos-retail-engine.js:520`, via `smartPosDispatch` (`posRetailEngine._h`) |
| Merchant V2 surface | **NONE, deliberately** |
| Mutation authority | manager/supervisor/owner **claim** AND proven tenancy; one transaction for status + stock restore; `already-exists` on double void |
| Read/target | **`posSales`** |
| Status | **BLOCKED — not wired** |
| Evidence | **zero client callers** anywhere in the repo |
| Gated dependency | **B-1**. Also: `posRole` is minted by nothing, so only `sellerId == auth.uid` passes in practice |

### RETURNS / REFUNDS

| | |
|---|---|
| POS refund authority | `posProcessRefund` → **`posRetailSales`**, restores `stock +qty`; **called** from `pos-checkout.html:3236` |
| Marketplace returns | `submitReturn` / `getSellerReturns` / `reviewReturn` / `markReturnProcessed` / `adminForceReturn` (`returns-engine`), all exported |
| Merchant V2 surface | `returns` route → `returns.html?shell=merchant` |
| Status | **CONNECTED** (marketplace) · **CONNECTED but POS-only surface** (till refund lives in the till, not in Merchant V2) |
| Note | `refundRequests` is a *control plane*: **writing it IS the refund**. Never wire a UI to it. |

### PAYMENTS / TENDERS

| | |
|---|---|
| POS tender authority | `posSendMpesa`, `posCheckPaymentStatus`, tender legs inside `posCompleteCheckout` |
| Marketplace authority | `payment-orchestrator.js` — `createPayment` / `initiatePayment` / `confirmPayment` / `refundPayment` / `getPayment` / `paymentTimeoutSweep` |
| Rail | IntaSend. **Daraja outbound is deleted from prod and must not be resurrected** |
| Merchant V2 surface | `payments` (native) — payouts + accepted methods |
| Mutation authority | server only. Client never establishes paid state |
| Status | **CONNECTED** |
| UNPROVEN | that Merchant V2 surfaces `OUTCOME_UNKNOWN` distinctly from failure — not asserted by any gate |

### RECEIPTS

| | |
|---|---|
| Authority | `sendPOSReceipt` (posRetail) · `posReceipts` + `receipts` (**two collections**) · `generateTrustReceipt` / `verifyTrustReceipt` / `voidTrustReceipt` (payment-trust) · `etimsGenerateInvoice` (tax) |
| Merchant V2 surface | `receipts` route (`seller.html#receipts`) |
| Status | **CONNECTED, two stores** — `posReceipts` and `receipts` both exist (D-11 in the lifecycle audit); unchanged by this work |
| Rule preserved | issuance must not imply payment success. No Merchant V2 receipt generator was created |

### INVENTORY

| | |
|---|---|
| Authority | canonical `products/{id}.stock`; corrections via `merchantAdjustStock`; import via `inventoryImportPreview/AiMap/Commit` |
| Merchant V2 surface | `inventory` (native, corrections) · `products` · `pos-import` |
| Shared identity | `products/{id}`, `sellerUid` |
| Status | **CONVERGED** — see §1 |
| Divergences | **D-a** `sold` vs `soldCount` · **D-b** `inventoryVersion` not bumped by DISPATCH |

### CUSTOMERS

| | |
|---|---|
| Authority | `crmCustomerProfiles` (rules: `merchantId == auth.uid`, client writes refused) + `getCustomerProfile` / `getCRMDashboard` |
| POS value instruments | `pos-crm-pro` — wallet, gift cards, store credit, tiers; `_resolveSellerId` falls back to `auth.uid` (**account**-scoped, not shop-scoped) |
| Merchant V2 surface | `customers` (native) · `pos-crm` |
| NOT bound | `posLookupCustomer` — searches `posCustomers` platform-wide with **no merchant filter** (cross-tenant PII) |
| Excluded | `/pos-customers` — IndexedDB `sokoni_pos_customers_v2`, **0 callables** |
| Status | **CONNECTED** |

### SUPPLIERS

| | |
|---|---|
| Authority | `sokoni-merchant-supply.js` → 12 server ops: `listSuppliers`, `listPurchaseOrders`, `getInboundSupplyOrders`, `listGRNs`, `listSupplierInvoices`, `listWarehouseStock`, `findSuppliers`, `getSupplyCatalogue`, `listStockMovements`, … |
| Merchant V2 surface | `supply` (native) |
| Keyed on | `businesses/{merchantId}` — a **different identifier space** from `activeShopId` |
| Excluded | `/pos-suppliers` — IndexedDB `sokoni_pos_suppliers_v2`, **0 callables** |
| Receiving → inventory | **UNPROVEN.** `listGRNs` and `listWarehouseStock` exist; whether a GRN moves canonical `products.stock` was NOT traced to a writer in this pass. Stated rather than assumed. |
| Status | **CONNECTED (read)** · receiving→stock **UNPROVEN** |

### PRODUCTS

| | |
|---|---|
| Authority | `products/{id}`, `sellerUid`; rules gate writes on `sellerUid == auth.uid` |
| Merchant V2 surface | `products` (`seller.html#products`) |
| Status | **CONNECTED** — and it is the ecosystem's shared spine (§1) |
| Invariant | stock 0 = out of stock, **never deleted**; absent stock = unmetered, not zero |

### ORDERS / ONLINE ORDERS

| | |
|---|---|
| Authority | `orders/{id}` — writers `order-settlement.js:203`, `manual-till-orders.js:170` |
| Payment | IntaSend via `payment-orchestrator.js`. **POS/Daraja is a separate legacy path, not the marketplace authority** |
| Merchant V2 surface | `orders` (native, unified view) |
| Owner key | **`sellerUid`** — and `order.sellerUid` is **BUYER-written**; product ownership is authoritative via `products/{id}` |
| POS sales in `orders`? | **NO.** POS sales never land in `orders` |
| Status | **CONNECTED, distinct domain** — correctly not collapsed into the sales collections |
| Gated | analytics contract asks `sellerId` while orders carry `sellerUid` |

### DELIVERY / FULFILMENT

| | |
|---|---|
| Authority | `packageRequests` · `onDeliveryStatusChange` · `availableDeliveries` · `claimAvailableDelivery` |
| Merchant V2 surface | `deliveries` → `seller-delivery.html?shell=merchant` (scoped to `sellerUid`) · `fulfilment` · `riders` |
| Security | a non-admin may read only deliveries their uid is party to |
| Status | **CONNECTED** |
| Known open | rider self-mint (`dispatch.js` filters only `isOnline`; `rideDrivers` client-creatable) |

### COMMISSIONS

| | |
|---|---|
| Single source | `functions/commission-config.js`; generated snapshot `sokoni-commission-rates.js`; enforced by `verify-commission-single-source.js` |
| POS / till lane | **flat 5% on every plan** (`POS_PLAN_RATES`, owner ruling 2026-09-07) |
| Marketplace lane | `MARKETPLACE_PLAN_RATES` — **free 16 / professional 12 / business 8 / enterprise 4** (owner decision 2026-09-13), absolute, replaces the base |
| Category rate | `RATES.marketplace.pct = 5` — what `SokoniCommission.pct('marketplace')` returns |
| Minimum | `MIN_COMMISSION_KES = 10` |
| Merchant V2 surface | Settings → Commission, **display only** |
| Status | **CONFLICT — see C-1** |

### REPORTS / ANALYTICS

| | |
|---|---|
| Merchant authority | `AnalyticsEngine.compute()` — one engine behind Analytics, Revenue and Reports |
| POS BI | `pos-bi` (10 named CFs) — reads **`posSales` only** |
| Excluded | `/pos-reports` — *"works fully offline from IndexedDB — no Firestore reads required"* |
| Status | **CONNECTED (merchant)** · **B-2 (POS BI reads the wrong lineage)** |
| Known | `getCustomerGrowthMetrics` gated on a `sellerId` claim nothing mints |

### NOTIFICATIONS

| | |
|---|---|
| Authority | `notifications` collection + `functions/notify.js`; tokens union `fcmToken` + `fcmTokens` + `pushToken`, `sendEachForMulticast`, dead-token prune |
| Merchant V2 surface | `messages` (native, via `messagesDispatch`) |
| Status | **NOT WIRED to a Merchant V2 notification centre** |
| Constraint | `service-worker.js` is **foreign dirty work — not touched** |
| Boundary | 798a85b: **WIRED ≠ LIVE-PROVEN** |

### POS SETUP / ADVANCED POS SETTINGS

| | |
|---|---|
| Merchant V2 entry | `pos-setup` → `pos-printer-setup.html?shell=merchant` |
| Canonical advanced surface | **`pos-setup.html`** — 3,850+ lines, the full advanced configuration |
| Status | **GAP — see B-3.** Merchant V2's "POS Setup" points at the PRINTER page, not the advanced settings page |
| Note | `pos-setup.html` is **foreign dirty work** in this tree — not edited |

### HARDWARE

| | |
|---|---|
| Authority | shell-owned device state (`devices` route) so the GATT connection survives navigation; `print-station.html` (paper width, station), `pos-hardware-wizard.html` (pairing), `sokoni-universal-printer.js` / `sokoni-pos-print-service.js` |
| Status | **CONNECTED** |
| Legitimately device-local | which printer is on THIS counter is a fact about the device, not the business |

### ADMINOS

| | |
|---|---|
| Canonical file | **`admin-os.html`** (66,803 bytes, 2026-09-21), served at `/admin-os` via `cleanUrls` |
| **`adminos.html`** | **DOES NOT EXIST** — see C-2 |
| `admin.html` | superseded console (491,848 bytes, 2026-08-26). **Must never be a Merchant V2 target** |
| Merchant V2 surface | **NONE** — platform-operator console; a merchant row would be a privilege defect |
| Status | **BOUNDARY HELD** — asserted by `test-merchant-ecosystem.js` §5b |

---

## 3. Blockers and conflicts

**B-1 — SALES LINEAGE (the §22 gate).** Two complete lineages, no projection, no shared
writer. Answer recorded above; the product decision — *which record IS the completed sale* —
is still the owner's. **No Void button until it is taken.**

**B-2 — FIVE ROUTED SURFACES READ THE WRONG LINEAGE.** `pos-bi`, `pos-ai`, `pos-books`,
`pos-hq`, `pos-crm` read `posSales` only, while the merchant's real sales are in
`posRetailSales`. Introduced by f937e5a. Minimal repair: mark them in the contract as
DISPATCH-lineage surfaces and state on each that they do not reflect till sales, **or** withhold
them until B-1 is resolved. Not repaired in this audit pass — it is a wiring change and this
pass is read-only.

**B-3 — ADVANCED POS SETTINGS NOT REACHED.** Merchant V2's `pos-setup` route opens
`pos-printer-setup.html`. The canonical advanced surface is `pos-setup.html`. The brief says
these must not be lost and must not be recreated — so the repair is to point the route at the
canonical page, **but `pos-setup.html` is foreign dirty work in this tree**, so it was not
opened for a control-by-control comparison. The per-control audit the brief asks for is
**NOT RUN**, and no control list is asserted.

**C-1 — COMMISSION CONFLICT (money).** Instruction: *POS/till 5%, online orders 15%.* The
canonical config says till **5%** ✓ and marketplace **16/12/8/4 by plan** ✗. 15% matches the
**retired** `seller_free` rate, explicitly superseded on 2026-09-13. Three readings are
possible and they charge merchants differently. **Not changed.** Changing only the client
snapshot would make Merchant V2 display 15% while the server charges the ladder — a UI that
lies about money, which is the exact defect the commission guard exists to prevent. Making it
real requires `functions/commission-config.js` **and a functions deploy**, which is
independently blocked by the merchant-identity provenance gap.

**C-2 — ADMINOS FILENAME.** The instruction names `adminos.html`. That file does not exist;
the AdminOS surface is `admin-os.html`. The *boundary* is implemented exactly as intended
(AdminOS ≠ `admin.html`); the filename was not propagated, because writing it in would create
a dead route.

---

## 4. Realtime

Per §18, for each domain: authoritative write → event → transport → subscriber → other device.

| Domain | Authoritative write | Transport | Merchant V2 subscriber | Status |
|---|---|---|---|---|
| Sales (till) | `posCompleteCheckout` | Firestore snapshot on `posRetailSales` | OrderService `posProvider` | **UNPROVEN** |
| Sales (cross-device) | `posTransactions` → `mirrorPosTransactionToRetail` | Firestore trigger | as above | **UNPROVEN** |
| Inventory | `products/{id}` + `inventoryVersion` | Firestore snapshot | Products / Inventory | **UNPROVEN** |
| Floor | `posTillState`, `posTillEvents` | live Firestore listeners | `pos-floor` | WIRED |
| KDS | `kdsOrders` | Firestore | `pos-kds` | WIRED |
| Delivery | `onDeliveryStatusChange` | trigger → notification | `deliveries` | WIRED |
| Notifications | `notifications` + `notify.js` | FCM multicast | **none in Merchant V2** | NOT WIRED |

**No two-device evidence was produced.** Nothing here is claimed LIVE-PROVEN.

---

## 5. What this audit did NOT settle

- Whether a supplier GRN moves canonical `products.stock` (no writer traced).
- Whether Merchant V2 renders `OUTCOME_UNKNOWN` distinctly from a failed tender.
- The per-control comparison of `pos-setup.html` against Merchant V2 (**NOT RUN** — foreign file).
- Any realtime propagation (**no two-device run**).
- Whether `posRetailSales` reads succeed against the **served** ruleset (the lifecycle audit's
  D-12 flags the `.live` file as possibly skewed; `.live` is stale and must be re-fetched).
