# Capability Engine (Slice 0)

**Date:** 2026-10-03 · **Owner:** sokoni-5b · **Branch:** `feat/capability-engine-on-c7e26b6`
**Base:** `95ff9e8` = the live `providerDispatch` lineage (`c7e26b6`, deployed), which already serves
`business-workspace.js` through the `workspaceHome` operation.
**Status:** built and tested. NOT deployed (`providerDispatch` is a live function; its release order is decided separately).

Related: [[Business Workspace]] · [[Food Hub]] · [[Tech Hub]] · [[AdminOS]] · [[Applications]]

## What it answers

"What may this business do, and which dashboard modules does that switch on?" The answer comes from server facts only.

```
application ──(AdminOS, admin account, not self)──► VALID approval      shared/approval-remediation.decisionValidity
        │                                                │
        ▼                                                ▼
 business id chosen (phone-repair, catering…)    capabilities (union over every VALID approval)   shared/service-capabilities
        │                                                │
        ▼                                                ▼
 category (stamped at approval)  ─► route        modules switched on per workspace                business-workspace.workspaceFor
```

## Rules

- **Approval comes first.** Only a VALID approval grants capabilities: status approved, decided by a resolvable admin account, never self-decided, approving this role. Pending, refused, self-decided or non-admin decisions grant nothing. Holding states (PENDING, REFUSED, REAPPLICATION_REQUIRED, CONFLICT, UNCLASSIFIED) carry `serviceCapabilities: []`.
- **Category drives capability; it never authorises.** A category on a record without a valid approval opens nothing.
- **Capabilities compose.** Phone repair + laptop repair + IT support gives ONE workspace with the union.
- **Never fake.** A capability module whose screen doesn't exist yet is `NOT_IMPLEMENTED` with its reason. A capability only switches on modules that are `NOT_APPLICABLE`; it never overrides a `LOCKED`, plan or Healthcare state.

## Contract (for Food Hub, Tech Hub and every vertical)

`functions/shared/service-capabilities.js` (pure, no firebase):

| Export | Meaning |
|---|---|
| `CAPABILITIES`, `KEYS`, `isCapability` | The vocabulary (see below) |
| `FROM_BUSINESS_ID` | hub-register business id → capabilities |
| `MODULES_OF` | capability → `{ provider: [moduleKey], merchant: [moduleKey] }` |
| `MERCHANT_MODULES` | merchant-v2 module keys with `implemented` / `why` |
| `businessIdsOf(app)`, `compose(approvals)`, `modulesFor(caps, kind)` | the engine |

**Capabilities.**
- **Tech:** `DEVICE_REPAIR`, `IT_SUPPORT`, `NETWORKING`, `CCTV_SECURITY`, `ELECTRONICS`, `POS_BUSINESS_TECH`, `SOFTWARE_DEV`.
- **Service mode:** `FIELD_SERVICE`, `ONSITE_SUPPORT`, `REMOTE_SUPPORT`, `WORKSHOP`, `PICKUP_DROP_OFF`, `QUOTE_REQUEST`, `DIRECT_BOOKING`.
- **Food:** `FOOD_MENU`, `KITCHEN`, `DRINKS`, `CATERING`, `BAKERY`.

`workspaceFor(db, uid, opts)` additionally returns:
- `serviceCapabilities: string[]`
- `capabilitySources: { CAPABILITY: [applicationId] }`
- **provider-dashboard:** the new module keys in `modules`:
  - `leads`, `repairs`, `diagnostics`, `supportedDevices`, `supportTickets`, `remoteSupport`, `siteVisits`, `networkProjects`, `cctvInstallations`, `posSupport`, `projects`, `pickupDropoff`;
  - all `implemented:false, why:'TECH_HUB_PENDING'` until their screens ship.
- **merchant-v2:** `merchantModules: { menu, kitchen, drinks, catering }`, in the same six-state vocabulary (`FOOD_HUB_PENDING`).

**To turn a module on** (the slice that ships its screen and server authority does this):
1. flip its `implemented` to `true`;
2. add the screen;
3. gate its server operations with `business-workspace.assertModule(db, uid, '<key>')`.

**To add a business type:**
1. register the id (hub-register.js and `business-category.FROM_BUSINESS_ID`);
2. map it in `service-capabilities.FROM_BUSINESS_ID`.

## Fixed in this slice

**Restaurant lane.** `ROUTE_OF.restaurant` is merchant-v2, and approval makes a food business a seller (PRODUCTS). But `laneOf` treated only the seven retail `SELLER_CATEGORIES` as products. So every approved food business got `CATEGORY_CAPABILITY_DISAGREEMENT` and no workspace (row B-6 fails on the live base). `laneOf` now treats any category this authority routes to merchant-v2 as products-lane.

## Evidence

| Test | Result |
|---|---|
| `scripts/test-service-capabilities.js` (A-1…A-7 pure, B-1…B-8 executing the real `workspaceFor` on an in-memory Firestore) | **15/0**; live base `95ff9e8` fails 7 |
| `scripts/sabotage-service-capabilities.js` | **7/7 caught** (+1 equivalent mutant recorded, not counted) |
| `test-business-capabilities` / `test-shell-gate-mutations` | 46/0 / 9/0 (unchanged) |
| `test-business-workspace`, `test-workspace-capability`, `test-candidate-shell-gate-compat`, `test-workspace-rules` | **NOT RUN**: emulator, memory below the 512 MB floor |

## Not in this slice

- **Writers:** none added. Capabilities are DERIVED from valid approvals on every read.
- **merchant-v2 consuming `merchantModules`:** Food Hub Slice 2.
- **The Tech Hub screens:** sokoni-b2.
- **Deploying `providerDispatch`:** it must be sequenced with the booking-PIN port (`port/booking-pin-on-shell-gate`) and the discovery fix, which change the same function.
