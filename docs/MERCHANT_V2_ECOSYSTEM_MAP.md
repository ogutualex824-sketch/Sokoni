# Merchant V2 → SOKONI POS Ecosystem — the read-only map

**Status:** READ-ONLY TRACE, taken before any wiring. Method: trace the actual execution
path of each candidate route to the authority that owns its data, then classify. No route
is admitted to merchant navigation because it exists; it is admitted because an authority
was found behind it.

Related: [[MERCHANT_NAVIGATION_CONTRACT]] · [[POS_SALES_LIFECYCLE_AUDIT]] ·
[[CANONICAL_COLLECTIONS]] · [[PAYMENT_ARCHITECTURE_UNIFICATION]]

---

## 1. What already exists — and it is not nothing

`sokoni-merchant-routes.js` is **already** the single canonical registry of every merchant
destination, and the sidebar, mobile drawer, bottom nav and command palette are all
projections of it. It validates itself (`validate()`), and `scripts/test-merchant-routes.js`
cross-checks every declared target against the real file, the real `seller.js` section and
the real `pos.html` tab set.

**Consequence for this work:** the ecosystem is wired by adding rows to that contract and
nowhere else. A second navigation list — a "Merchant Ecosystem" array in the HTML, a
`sokoni-merchant-ecosystem.js` registry — would be the exact duplication the brief exists to
prevent, and `test-merchant-routes.js` already fails a shell that declares its own list.

The shell is `merchant-v2.html`, served at `/merchant-v2` (`sokoni-merchant-entry.js:62`).
`merchant.html` is the superseded v1.

---

## 2. Identity — the chain, and where it is honoured

The canonical chain, as the shell resolves it (`merchant-v2.html:1411`):

```
auth.uid → users/{uid} → sellerUid → activeShopId → shops/{shopId}
                      ↘ businesses/{merchantId}   (a DIFFERENT identifier space)
```

`S.activeShopId` (shops) and `S.merchantId` (businesses) **coincide only in the owner-uid
form and are never interchangeable** — the shell says so in its own comment and the Supply
route's `ctx` declares `sellerUid` alone for exactly that reason.

The till's identity contract is fixed by the server:

| | |
|---|---|
| Canonical sender | `sokoni-merchant-data.js:489` — `merchantId: scope.shopId` |
| Server enforcement | `functions/pos-zero-friction.js:444` — `resolveActor(cashierId, merchantId)`, then a **merchant-must-be-proven** block (businesses doc → `_resolveMerchantIdForOwner` → `_assertBusinessPermission(…, 'sales')`) |
| Verdict | `merchantId` **is the shopId**. The server proves it; a forged or unknown value is refused, not misattributed. |

**This is the finding that decides requirement 1.** `pos-checkout.html:1731` sets

```js
_s.merchantId = settings.merchantId || settings.businessName || 'merchant';
```

— from device IndexedDB (`PosDB.settings`), falling back to the *literal string* `'merchant'`.
It never resolves the canonical chain. `window._posMerchantId`, the other half of the same
idiom at `pos-checkout.html:3151`, `pos-manager-auth.js:263` and `pos-sales.js:417`, is **read
by three files and written by none** — it is always `undefined`.

Because the server proves the merchant, this is **not** money misattribution. It is worse in
a quieter way: on any device whose IndexedDB does not already hold the canonical shopId,
`posCompleteCheckout` **refuses the sale**. The till is not wrong, it is inoperable, and the
merchant sees a failure with no stated cause.

So requirement 4 ("do not create a second merchant context") and requirement 1 ("POS button →
/pos-checkout") are not in tension: making `/pos-checkout` resolve the canonical shopId is
what makes requirement 1 *work at all*. It removes an identity, it does not add one.

---

## 3. Route classification — evidence, not taste

Classified by tracing the data source. `callables` counts `httpsCallable` occurrences.

### 3.1 CANONICAL — server-backed, already owned by an authority

| Route | Authority | In nav |
|---|---|---|
| `/pos` | `pos.html` — the unified SmartPOS app, shell-aware, `SokoniPosContext` server-resolved device pairing | ✅ preserved, unchanged |
| `/pos-checkout` | `posCompleteCheckout` (the ONE till authority), `posSendMpesa`, `posCheckPaymentStatus` | ✅ POS entry, after the identity repair |
| `/pos-inventory` | 3 callables | ✅ |
| `/pos-inventory-intelligence` | server-backed | ✅ |
| `/pos-bi` | 10 callables (`getExecutiveDashboard`, `getRevenueDrilldown`, …) | ✅ |
| `/pos-ai` | 3 callables (`askPOSAssistant`, …) | ✅ |
| `/pos-accounting` | 3 callables | ✅ |
| `/pos-hq` | 2 callables | ✅ |
| `/pos-crm-pro` | 2 callables | ✅ |
| `/pos-staff-ops` | 2 callables | ✅ |
| `/pos-cash-manager` | 1 callable + `cmRecordCashEvent` rail | ✅ |
| `/pos-till-manager` | 1 callable | ✅ |
| `/pos-marketplace` | `pos-marketplace-sync` CFs | ✅ |

### 3.2 OPERATIONAL — server-backed, but a *floor/device* surface, not a data authority

| Route | Source | In nav |
|---|---|---|
| `/pos-live-floor` | `posTillState`, `posTillEvents` (live Firestore) | ✅ Operations |
| `/pos-display` | `posCustomerDisplays` | ✅ Operations |
| `/pos-kds`, `/kitchen-display` | 1 callable + BroadcastChannel | ✅ Operations |
| `/print-station`, `/pos-printer-setup`, `/pos-hardware-wizard` | device pairing | ✅ Hardware |
| `/manager-auth` | `pos-manager-auth.js` elevation | ✅ Hardware/staff |

### 3.3 DEVICE-LOCAL DUPLICATES — **excluded from merchant navigation**

These are the three that matter, and the reason is the brief's own:

| Route | What actually backs it |
|---|---|
| `/pos-suppliers` | `pos-suppliers.js` → IndexedDB `sokoni_pos_suppliers_v2`. **0 callables.** |
| `/pos-customers` | `pos-customers.js` → IndexedDB `sokoni_pos_customers_v2`. **0 callables.** |
| `/pos-reports` | `pos-reports.js` — its own header: *"Works fully offline from IndexedDB — no Firestore reads required"*. **0 callables.** |

Each already has a canonical counterpart **already registered in the merchant contract**:

| Device-local page | Canonical route that owns the same concept |
|---|---|
| `/pos-suppliers` | `supply` — `sokoni-merchant-supply.js`, 12 server ops (`listSuppliers`, `listPurchaseOrders`, `listGRNs`, `listSupplierInvoices`, `listWarehouseStock`, `findSuppliers`, …) |
| `/pos-customers` | `customers` — `crmCustomerProfiles` scoped by rules on `merchantId == auth.uid`, plus `getCustomerProfile` / `getCRMDashboard` |
| `/pos-reports` | `reports` — `AnalyticsEngine.compute()`, the same engine as Analytics and Revenue |

Putting the device-local page in the merchant sidebar would give the merchant **two supplier
lists, two customer lists and two revenue figures that disagree**, with the per-device one
looking equally authoritative. That is precisely the outcome the brief's closing paragraph
names. They are excluded **with the reason recorded in the contract**, not silently dropped;
they remain reachable at their own URLs and nothing about them changes.

### 3.4 DIAGNOSTIC / PREVIEW — excluded, as the brief asks explicitly

| Route | Class | Why |
|---|---|---|
| `/pos-v2` | **preview** | Hands its cart to `/pos-checkout` (`pos-v2.html:737`) — a second front end over the same money path |
| `/checkout-2-preview` | **preview** | Named a preview |
| `/pos-printer-hardware-test` | diagnostic | Hardware bring-up |
| `/pos-ios-print-test` | diagnostic | Opens `/pos-checkout.html` in a **new tab** — forbidden in-shell |
| `/pos-certification` | diagnostic | Certification evidence |
| `/pos-completeness` | diagnostic | Completion matrix |
| `/pos-launch-report` | diagnostic | Release artefact |
| `/pos-observability` | diagnostic | Ops telemetry |

### 3.5 Deliberately NOT routed — dependency, not classification

| Route | Why not |
|---|---|
| `/catalogue` | `catalogue.html` is **untracked** in this worktree — another agent's in-flight work. A contract row pointing at it would pass `fs.existsSync` here and 404 in a clean checkout. |
| `/business-apply` | same — untracked. |

Both are admitted the moment their owning workstream commits them; the row is one line.

---

## 4. Authority ownership — what Merchant V2 must READ, never re-own

Requirement 6, made concrete. Merchant V2 is the control surface; each authority stays where
it is.

| Domain | Authority | Merchant V2's role |
|---|---|---|
| Commission | `functions/commission-config.js` → generated `sokoni-commission-rates.js`; enforced by `scripts/verify-commission-single-source.js` | **display only** — `SokoniCommission.posPct()` = 5, `MIN_COMMISSION_KES` = 10. Never computes. |
| Products | `products/{id}` via `seller.js#products` | route, not re-implement |
| Stock corrections | `merchantAdjustStock` (native `inventory`) | already canonical |
| Sales (till) | `posCompleteCheckout` → `posRetailSales` | route |
| Void | `voidPOSSale` (`pos-retail-engine.js:520`) via `smartPosDispatch` → **`posSales`** | see §5 |
| Payments | `payoutRequests` + frozen wallet engine | already canonical |
| Suppliers | `sokoni-merchant-supply.js` (12 server ops) | already canonical |
| Customers | `crmCustomerProfiles` + `getCRMDashboard` | already canonical |
| Delivery | `seller-delivery.html` scoped to `sellerUid` | already canonical |
| KRA / eTIMS | `etims*` (8 callables), keyed `etimsProfiles/{auth.uid}` | already canonical |
| Staff | `shopEmployees` contract (`listShopEmployees`, …) | already canonical |
| Printer / devices | shell-owned so the GATT connection survives navigation | already canonical |

---

## 5. Void / sales control — traced, and **BLOCKED** with a stated reason

`voidPOSSale` is a mature, hardened authority: manager/supervisor/owner claim **and** proven
tenancy, one transaction for status + stock restore, `already-exists` on a double void. It is
reachable — not re-exported by name in `functions/index.js`, but live through
`smartPosDispatch` via `posRetailEngine._h`.

It cannot be surfaced in Merchant V2 yet, for two independent reasons:

1. **It voids a sale the merchant's own Orders view cannot see.** `voidPOSSale` operates on
   **`posSales`** (the DISPATCH path). Merchant V2's Orders reads **`posRetailSales`**
   (TILL + MIRROR). `docs/POS_SALES_LIFECYCLE_AUDIT.md` §2 measures these as **disjoint**: *"A
   sale is visible to one or the other by entry path, never both."* A Void button in Merchant
   V2 would therefore list sales that do not appear in Orders, and would be unable to void any
   sale that does. That is not a wiring gap — §5 of that audit states the authority decision
   (*which record is the authoritative completed sale*) is the thing that **gates any fix**,
   and it has not been taken.

2. **`posRole` is minted by nothing.** The claim gate admits `posRole ∈ {manager, supervisor,
   owner}`; no path mints that claim. In practice only the owner (`sellerId === auth.uid`)
   passes — so the surface would be owner-only, which is defensible, but it does not rescue
   reason 1.

**Therefore:** Void is registered in the ecosystem map as `blocked`, with this reason carried
in the contract itself, and **no button is rendered**. A void control that voids from a
collection the merchant cannot see is worse than none — it is the "button with no destination"
defect inverted. Refunds are unaffected and stay on their own path: a cashier *requests*, the
owner *approves*, and `refundRequests` is never wired to a UI because **writing it IS the
refund**.

---

## 6. Deploy state — blocked, and not by this work

`firebase deploy --only hosting` ships the **working directory**, not the commit. This tree
currently carries another workstream's uncommitted work — modified `checkout.html`,
`pos.html`, `functions/payment-orchestrator.js`, `functions/.env`, and untracked
`catalogue.html`, `business-apply.html`, `sokoni-pos-tender.js`, `sokoni-provider-application.js`
and others. Deploying from here would publish all of it to `mysokoni.co.ke` under cover of this
change.

That is a repo-discipline stop, not a defect in this work. Evidence and gate results are
reported; the deploy is not run.

---

## 7. Gate evidence (post-implementation)

Recorded here because the map is where the next reader looks. Full table in
`CHANGELOG.md` (149).

| Gate | Result |
|---|---|
| `test-merchant-ecosystem` (new) | **114 / 0** |
| `test-merchant-v2-ecosystem-runtime` (new) | **115 / 0**, 2 stated UNPROVEN |
| `test-inshell-chrome` | **29 / 0** (was 23 / 4) |
| `test-merchant-routes` | 77 / 2 — both pre-existing, baseline 58 / 2 |

### The gate-rot finding

`test-merchant-route-gate.js` and `test-merchant-visual-gate.js` both load
**`merchant.html`** — the superseded v1 shell. Production serves `/merchant-v2`. They pass
168 / 0 while measuring a document no merchant opens, so their result is **not** evidence for
any change to v2. `scripts/test-merchant-v2-ecosystem-runtime.js` exists for that reason.

The v1 gates were left alone: re-pointing them is a larger claim than this change earns, and
a wrong re-point would silently stop covering v1 while appearing to cover v2.

### The related repair

`sokoni-inshell.js` matches `/merchant(-v\d+)?(\.html)?$/`, but seven shipped pages carried an
inline detector that knew `"merchant"` and `"merchant.html"` only — so inside merchant-v2 the
class landed solely through the `SokoniShell` global, racing it. All seven now match by path,
and the gate's substring proxy was replaced by **executing** each detector against the shell
name derived from the routes contract, with the global forced absent.
