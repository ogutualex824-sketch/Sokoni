# SOKONI Release Roadmap

**Governing rule:** nothing on this roadmap starts until **RC Exit is genuinely complete** — `darajaSTKPush` deployed, Kass Shop `deliveryConfig` applied, one real production order completed, `docs/CHECKOUT_GATE_ACCEPTANCE.md` signed, Release Baseline established. Until then the platform is a Release Candidate under freeze ([[feedback_rc_change_policy]] / `docs/CHECKOUT_GATE_ACCEPTANCE.md`).

---

## Release 1.0 — Day 0 (the moment the acceptance record is signed)

This is the transition from *candidate* to *operational baseline*. On signature:

1. **Tag the repository** — `v1.0.0` (annotated). This is the certified parent of every future release.
2. **Record in the Release Baseline** (`docs/CHECKOUT_GATE_ACCEPTANCE.md`):
   - Git commit (the tagged SHA)
   - Production function revision(s) — `darajaSTKPush` (+ any others changed)
   - Service Worker version (`cacheVersion`)
   - Acceptance document SHA
   - Reference transaction (Order ID)
3. **Archive** the signed acceptance record as the **permanent Release 1.0 baseline** — the authoritative reference for every future payment/checkout change (each must reference it + re-run `qa-dispatch-settlement-e2e` before deploy).

Only after v1.0.0 is tagged and archived does the freeze lift and the versioned roadmap below begin.

---

## Versioned sequence (each builds on the certified 1.0 baseline)

### Release 1.1 — Merchant Growth  ([[project_merchant_growth]])
Acquisition → Success → Growth → B2B. Activation milestone = **First Successful Sale** (onboarding progress tracker: profile → catalogue → payments → delivery → publish → first order). Reuse existing loyalty/analytics engines; extend, don't rebuild.

**First onboarding capability — Canonical MiniShop Provisioning** (surfaced 2026-08-04 during RC checkout diagnosis; deliberately deferred out of RC). The MiniShop *readers* are live — `/shop/**` + `/@**` route to the `minishopPage` CF, which reads `shopHandles → shops → minishopConfig` — but there is **no writer**: the `shops` collection is empty platform-wide and no code (client or server) creates a `shops` doc. Provisioning one merchant by hand during RC would establish an undocumented precedent future merchants can't reproduce, so it is R1.1 work, not a hotfix. Scope:
- Build a **seller → shop provisioning pipeline** (part of merchant onboarding) that atomically creates `shops`, `shopHandles`, and `minishopConfig` (normalized via `minishop-config-schema.js`) and allocates a unique handle.
- **Standardize the ownership field** across all readers — today the CF matches `shops.sellerUid` while the admin console (`minishop-admin.html`) matches `shops.ownerId`. Pick one; make every reader agree.
- **Attach `shopId` to products automatically** on creation (the console counts `products.where('shopId','==',shopId)`; current products carry only `uid`/`sellerUid`, so that count reads 0).
- **Backfill existing merchants safely** through the same pipeline — no handcrafted exceptions.
- Make MiniShop creation a step in the onboarding progress tracker above.

**Same root — Canonical seller product/inventory READ path** (also surfaced 08-04). The buyer catalogue + checkout read the canonical Firestore `products` (aligned to the correct `sellerUid`), but **no seller-facing product/inventory view reads it**: `inventory.html`'s list reads **device localStorage** (`SokoniInventory` / `inventory-manager.js`), its enterprise panels read an unprovisioned `tenants/{uid}/…` store (`SokoniInventoryV2`), and the MiniShop count reads the empty `shops` collection. Net effect: a seller whose products are live and buyable still sees an **empty inventory**. R1.1 must give seller inventory a **single canonical source** — read (and write/edit/stock) against Firestore `products where sellerUid == uid` — retiring the localStorage/tenant mirrors (or hydrating them from canonical, one-way) so list + stock + edit + modal all operate on real data. A list-only repoint would be a *healthy-looking failure* (list shows, but click/stock/edit break), so scope it as the full read+write path, not a display patch.

Note: this is a *storefront/growth + merchant-tooling* capability, **not** a checkout dependency — RC checkout flows through the normal catalogue → cart → `darajaSTKPush` path and does not touch MiniShop or the inventory page.

### Release 1.2 — Multi-wallet  ([[project_multiwallet_architecture]])
Personal · Shop · Service · Rider · Business/Branch wallets on the **existing frozen ledger engine**; internal transfers as balanced source→destination ledger movements. No changes to the proven money paths — additive wallet-scoping only.

### Release 1.3 — Infrastructure
Server-authoritative **road routing** (OSRM/Google/Mapbox) replacing client-supplied `distanceKm` (closes the manipulated-straight-line gap, [[project_delivery_pricing_authority]]) · delivery optimization · dispatch improvements.

### Release 1.4 — KRA eTIMS certification  ([[project_etims_certification]])
Begin **only** when the official `docs/kra-etims-spec-v2.0.pdf` is available. Validate the implementation *against* the specification (line-by-line audit vs the isolated adapter) — never adapt the specification to the implementation.

---

## Current Release Board (official status)

| Status | Workstream |
|---|---|
| ✅ Complete | Core engineering platform (Wallet Engine frozen · Provider OS · Admin OS · design system · validation harnesses · rollback · acceptance + RC governance) |
| ⏳ Pending | **RC Exit** (operational — owner-controlled) |
| 📋 Queued | Release 1.1 Merchant Growth |
| 📋 Queued | Release 1.2 Multi-wallet |
| 📋 Queued | Release 1.3 Server-authoritative road distance |
| ⏳ Waiting | Release 1.4 KRA eTIMS specification |
| 📋 Follow-up | Production payout limit (`maxPayoutsPerDay`) · SMS invite verification |

Engineering is complete; the only open critical-path item is the operational RC exit. Once v1.0.0 is tagged and the baseline archived, the platform moves from candidate to a certified foundation and the versioned roadmap proceeds in order.
