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

**Profile V2 — canonical identity record** (owner spec 08-04; schedule immediately after v1.0.0, alongside canonical inventory + MiniShop provisioning). Treat Profile as a **core platform capability**, not a settings page: `users/{uid}` becomes the ONE identity record every workspace (Customer/Seller/Provider/Rider/Admin) reads; role-specific collections (`sellers`, `providers`, `rideDrivers`/`drivers`) hold ONLY role data — **no duplicated name/email/phone**. Scope:
- **All fields editable** (edit/save/cancel) except immutable identity: name, display name, business name, email, phone (verified flow), DOB, gender, bio, address, city/county, country, photo, cover, language, notification prefs. No hidden fields.
- **Email add/change/verify** (real bug today — can't add/verify email): enter → send verification → verify → becomes primary; show "pending verification" until verified.
- **Legal-doc gating fix:** signing must require ONLY verified phone + verified email + legal name (not unrelated profile fields) — today profile completion never reaches the threshold so users can't accept Terms/Privacy/Merchant/Provider/Rider agreements. Each acceptance stores {doc version, timestamp, user, device/IP where appropriate, acceptance hash} = audit trail. Ties to [[project_legal_release_gate]].
- **Transparent profile completion** (weighted, itemised "missing" list) — not a mystery %.
- **Independent verification stages** (phone / email / identity / business / payment) — one incomplete stage must not block the others.
- **Roles always visible as badges** + **tap-to-switch workspace** (no disappearing Rider role, no hidden nav) — reads canonical `users/{uid}.roles`.
- **Server-enforced rate limits** on profile updates (e.g. name 5/day, email 2/day + 24h cooldown, phone 2/day + cooldown, address/bio/photos 20/day) — email/phone cooldowns reduce account-takeover risk. Enforce server-side, not client.
- **Premium UX** consistent with the platform: cards, skeletons, live sync, instant-save feedback, security section (device sessions, login history), legal agreements, privacy controls, notification settings, mobile-first. Part of the platform-wide premium-theme + unified-nav pass.
This **extends** the existing profile toward the canonical model — not a rewrite. See [[project_identity_integrity]] · [[feedback_provider_roles_login]] · [[reference_shopname_and_analytics_gates]] (role array-vs-string bugs).

**Admin OS — premium mobile-first refactor** (owner brief 08-04; deferred out of RC as a UI redesign, not a bug fix — Admin OS is otherwise complete/frozen). Current mobile admin reads like a compressed desktop dashboard (~6.5/10): tall single-column cards, excessive vertical scroll, ungrouped metrics. Goal: premium mobile-first executive interface, **no business-logic / data-binding changes**. Requirements: mobile-first responsive (360–430px); **KPI cards in a 2-col grid** (~80–100px tall, 16px padding, small icon + concise label); **grouped metrics** (e.g. Pipeline as label+count rows) to cut height ~50%; **sticky top app bar** + **sticky secondary tab nav** (Overview / Orders / Merchants / Finance / System); **Platform Health as status chips** (🟢/⚪) not a vertical list; typography (section 18–20px, card title 13–14px, KPI value 28–36px, labels 12px); spacing (16px between cards, 12px internal, 8px between related metrics); restructure into Wallet/Revenue/Orders/Users → Pipeline → Platform Health → Recent Orders → Merchant Activity → System Status → Launch Readiness; CSS Grid/Flexbox only (no JS layout math); light/dark; **no horizontal scroll**; WCAG AA contrast; ≥44×44px touch targets; **preserve all existing functionality + data bindings**. Pairs with the premium-theme + Navigation Framework pass.

**Subscription activation — webhook authoritative** (owner directive 08-04; R1.1, NOT a checkout-gate item — separate payment path, new server-side business logic; no real subscription customers pre-launch). Bug: `activateSubscription` is client-driven, so a customer can pay (e.g. KES 499 IntaSend/M-Pesa) and receive nothing if the browser never calls it. Fix: **IntaSend webhook becomes the authoritative activation path** — verify payment authenticity → enforce idempotency (same txn can't activate twice) → activate plan → create/update the ONE canonical `subscriptions/{...}` doc → record payment + invoice + ledger + receipt → update user entitlement. Browser may still poll/listen for UI, but **never grants the entitlement**. One lifecycle: `pending_payment → paid → active → renewing → expired` (no competing states); one subscription doc, one payment history, one entitlement source. **Exactly-once**: one payment / one activation / one invoice / one ledger / one entitlement / one receipt. Subscription page must render the active plan on activation (name/price/period/start/expiry/status/remaining-days) and never hang on "Waiting for payment confirmation…" — handle success/pending/failed/duplicate/cancelled. Reuse the frozen wallet/ledger idempotency patterns.

**Receipt system — webhook-authoritative, print + digital** (owner design 08-04; R1.1 POS; SAME principle as the subscription webhook — the receipt is *proof of payment*, generated ONLY after the payment webhook verifies, never on "order placed"). Flow: place → server creates PENDING order → STK → PIN → **webhook verifies → status PAID → reserve inventory → create receipt record + assign receipt number → print + save digital**. **Idempotent** (`if !receiptPrinted { generate+print+mark } else noop`) so a retried webhook can't double-print/double-receipt — reuse the wallet/settlement exactly-once discipline. **Printer-agnostic** `printReceipt(orderId)` over the existing Universal Printer v3 transports (P58E BT / 58mm / 80mm ESC-POS / USB / network — the printing layer picks the connected device). **Digital receipt** saved to Firestore, viewable on the buyer's Orders page + seller Order History, **reprintable without minting a new receipt** — one record that prints/views/emails, always matching the verified payment. Contents: SOKONI + Bravilex International Co. Ltd (MoR), merchant + KRA PIN (eTIMS), receipt# / order# / datetime, line items (qty/unit/subtotal), delivery fee, total paid, M-PESA + gateway ref, QR to the digital receipt, refund policy. Ties to [[project_universal_printer_v3]] · [[project_settlement_engine]] (Bravilex MoR) · [[project_etims_certification]].

**Inventory visibility + editability — reader-first migration** (owner directive 08-04; R1.1; the localStorage↔Firestore canonical-inventory work). Strategy (in order, never canonical-writes before readers): (1) **audit** production product docs; (2) **dual-read** the seller key `merchantId || sellerId || uid || sellerUid || ownerId`; (3) deploy readers; (4) update writers to always populate the ONE canonical field; (5) **backfill** existing products; (6) remove legacy support ONLY after production verification. **Status compatibility:** readers treat missing `status` AND `active` as visible (preserving moderation), require explicit status only after migration. **Editable products:** every inventory product editable (images/title/description/category/stock/price/status) and Save **updates the existing doc — never duplicates** — preserving analytics/reviews/sales/inventory history. Every change idempotent, reversible, evidence-backed before dropping legacy compat. NOTE: also fix the localStorage→Firestore product sync that overwrites `sellerUid` (the 08-04 KASS revert; see [[project_merchant_growth]]).

**Seller product-upload form — premium mobile refactor** (owner spec 08-04; R1.1 UI, no schema/logic change). Top 6 in owner priority: (1) **option selectors as horizontal chips** — Colours/Sizes/Materials/Patterns become a scroll-snapping `overflow-x:auto` flex of `.option-chip` (min 90px×44px, pill, no-wrap, hidden scrollbar, no horizontal PAGE overflow) instead of full-width vertical buttons — keep existing selection/validation logic + 44px touch targets; (2) **progressive/collapsible sections** (Basic Info → Variants → Inventory → Delivery → Advanced) instead of 40 fields at once; (3) **sticky bottom action bar** (Save Draft / Publish); (4) **dynamic fields by category** (Clothing→sizes/colours/fabric; Electronics→brand/warranty/model); (5) **live product-preview** (side-by-side desktop, tab on mobile); (6) **auto-save drafts** ("✓ Saved Ns ago" — survive Safari refresh). Plus: floating image carousel uploader, AI quick-actions (generate description/improve title/SEO/translate), step progress indicator, rounded section cards. Shopify/Jumia-Seller-Center feel; existing upload logic + Firestore schema intact. Inherits the premium design system + Navigation Framework.

**Platform Navigation Framework** (owner spec 08-04; the premium *redesign* is R1.1, but a subset of *correctness* fixes is owner-approved for before-RC-exit — see split below). ONE navigation system every workspace shares:
- **Top bar:** ☰ menu · Search · Notifications · Messages · Profile. **Bottom nav (never changes):** Home · Explore · Orders · Wallet · Profile.
- **Workspace switcher lives in Profile** (tap-once instant switch): Customer / Seller / Provider / Rider / Admin — reads canonical `users/{uid}.roles`. Profile becomes the navigation hub (identity + verification % + switch-workspace + My Businesses + Wallets + Legal/Security/Devices/Settings).
- **Per-workspace sidebar** (only that workspace's tools): Seller = Dashboard/Products/Inventory/Orders/Customers/Wallet/Analytics/Settings · Provider = Dashboard/Services/Calendar/Bookings/Customers/Wallet/Reviews/Analytics/Settings · Rider = Dashboard/Available Jobs/Current Delivery/History/Wallet/Vehicle/Settings · Admin = Executive Dashboard/Merchants/Providers/Riders/Users/Finance/Reports/Settings.
- **Every page:** working Back, breadcrumb where apt, current-page highlight, consistent icons, desktop keyboard shortcuts, mobile swipe, safe-area, persistent nav state. Premium-consistent (cards/spacing/type/shadows/transitions/skeletons/empty-states/retry).

**Owner-approved split (RC governance):**
- **Before RC exit (correctness only, owner-authorized 08-04):** fix broken navigation + **dead ends** · guarantee a working **Back** action on every page · Rider (and every real role) appears correctly in Profile [✅ Rider role fix already landed] · all **workspace switches** actually work. These are usability/correctness bugs, NOT the redesign. NOTE: not gate-blocking — confirm scope before a broad sweep (a "every page" audit is large); keep each fix small + isolated, do NOT deploy on a dirty tree.
- **After RC (R1.1):** the full premium navigation redesign + unified components + workspace-switcher polish + premium refresh of MiniShop/Inventory/Profile/remaining pages. Pairs with the Profile V2 + premium-theme pass. See [[project_nav_engine]] · [[project_mobile_drawer_ux]] · [[reference_design_system]].

### Release 1.1 — Checkout fulfillment methods (owner design 08-04)
Delivery is a *choice*, not a mandatory charge. After the cart, require a fulfillment method BEFORE any delivery pricing: **Pickup (KES 0)** · **Meet Seller / Hand-over (KES 0)** · **SOKONI Delivery (distance-priced)** · **Seller Delivery (if `deliveryConfig` enabled)** · **Scheduled Pickup** · digital = 0. Only **SOKONI/Seller Delivery** invokes the server delivery-pricing service; Pickup/Meet skip distance calc AND **bypass rider allocation + dispatch**. Store the chosen `fulfillmentMethod` on the order and branch the lifecycle: pickup = `paid → ready_for_pickup → collected → completed`; delivery = `paid → awaiting_rider → picked_up → in_transit → delivered → completed`. Reuse the existing authoritative delivery pricing ([[project_delivery_pricing_authority]]) + dispatch pipeline for the delivery branch only. Solves same-room / same-building / collect-later / market-stall cases and removes needless delivery charges. (RC test workaround: `sellers/{uid}.deliveryConfig.freeAbove` lowered so a small order ships free — replace with real fulfillment choice in R1.1.)

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
