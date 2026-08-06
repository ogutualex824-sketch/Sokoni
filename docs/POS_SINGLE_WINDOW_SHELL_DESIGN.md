# POS Single-Window Shell — Design

**Status:** DRAFT for approval · **Author:** AI engineering · **Date:** 2026-08-07
**Milestone:** R1.1 (Merchant Experience) · **RC impact:** Phase 1 is a defect fix; Phases 2–4 are R1.1 enhancements (flag & confirm)
**Related:** [[Platform Constitution]] (extend don't rebuild) · [[SmartPOS]] · [[project_smartpos_checkout_v2]]

---

## 1. Key finding — the shell already exists

`pos.html` + `pos.js` are **already a single-window shell with a working in-page view router**. We do **not** build a new shell from scratch — we extend the one that ships.

- Router: `pos.js:356 SPos.ui.switchTab(tab)` — sets `state.currentTab`, toggles `.pos-tab.active`, hides all `.pos-panel` and shows `#panel-${tab}`, then lazy-invokes each module's loader on switch (`inv.showTab`, `customers.loadTable`, `reports.setRange`, `PosFinance.renderHub` guarded by `el.dataset.loaded`, `PosRepair.renderHub`, `PosAudit.renderHub`) and emits `PosPlugins.emit('tab:switch',…)`.
- Existing in-shell views (panels): **Checkout, Inventory, Reports, Customers, BOS, Finance, Repairs, Audit, Settings** (`pos.html:304-312`).
- The whole ~65-script POS stack (Firebase + App Check, print stack ×11, `PosSync`/`PosDB` outbox, feature modules) loads **once** in `pos.html`. Switching panels re-uses it — no re-parse.

**The actual problem:** several in-shell buttons `window.open('pos-<module>.html','_blank')` the **standalone duplicate pages** instead of calling `switchTab` to the panel that already exists — spawning tabs, re-loading the 65-script stack, and forking the cashier session. The standalone `pos-reports/customers/inventory.html` pages largely duplicate panels already present in `pos.html`.

**Design principle:** route into the existing shell; never open a sibling POS page in a new tab.

---

## 2. Current state (evidence)

### 2.1 Multi-tab offenders (to converge) — ~11 `window.open`
| Button (in `pos.html`) | Currently opens | Has an in-shell panel? |
|---|---|---|
| 📊 Full Dashboard (`:466`) | `pos-reports.html` `_blank` | ✅ `reports` |
| 👥 Full Manager (`:481`) | `pos-customers.html` `_blank` | ✅ `customers` |
| 📦 Full Inventory (`:1967`) | `pos-inventory.html` `_blank` | ✅ `inventory` |
| 📊 Full Reports (`:1970`) | `pos-reports.html` `_blank` | ✅ `reports` |
| 🧠 Inventory Intelligence (`:1968`) | `pos-inventory-intelligence.html` `_blank` | ⚠️ advanced — new view or stays separate |
| 🏭 Suppliers & POs (`:1969`) | `pos-suppliers.html` `_blank` | ❌ no panel — **new view** |
| ⚙️ Printer Setup (`:284,537`) | `pos-printer-setup.html` popup | 🚫 stays a popup (see §6) |
| Open Kiosk (`:616`) | `pos-kiosk.html` `_blank` | 🚫 separate display (see §6) |
| 📡 workspace (`:277`) | `pos-workspace.html` `_self` | already same-tab (device pairing) |

Plus a few `window.open` in `pos-checkout.html` (2), `pos-setup.html` (1), `pos-ios-print-test.html` (test page).

### 2.2 Cart & session (the "persistent cashier session")
- **Cart:** `pos.js:18 state.cartItems: []` (in-memory on the module `state`). Survives panel switches (single page) but is **lost on reload** — no `localStorage`/`sessionStorage` persistence exists. Held/parked sales already durable in IndexedDB (`pos-sales.js:250 parkSale` → `S.PARKED`).
- **Session:** Firebase auth (warm app in `firebase.js`) + `sokoniUser` localStorage cache (`shared-header.js`), already **surviving across pages**. Manager step-up is separate and server-verified (`pos-manager-auth.js` — PIN/QR/NFC/Mobile/Biometric against `posStaff`). Keys that already persist: `sokoniUser`, `sokoni_merchant_id`, `sokoni_pos_branch`, `pos_shop_id`, `pos_terminal_id`.
- **Offline outbox:** main terminal uses `PosSync.enqueue(type,payload)` → `PosDB` (IndexedDB). Idempotent replay via `posCompleteCheckout`. (The lightweight `pos-v2.html` uses a separate `localStorage.posOfflineQueue`.)

### 2.3 Not shell views (stay separate)
Customer-facing/physical displays: `pos-display.html`, `pos-kiosk.html`, `pos-kds.html`, `pos-live-floor.html`. Setup/hardware/QA: `pos-setup`, `pos-onboard`, `pos-*-hardware-*`, `pos-printer-setup`, `pos-certification`, `pos-observability`. Multi-branch owner tools: `pos-hq.html`, `pos-workspace.html`. Alternate lightweight till `pos-v2.html` (hands off to `pos-checkout`).

---

## 3. Target architecture

```
┌──────────────────────────────────────────────────────────┐
│  pos.html  (THE shell — loads the stack once)            │
│  ┌────────────┬───────────────────────────────────────┐  │
│  │  SIDEBAR   │  CONTENT REGION (#panel-<view>)        │  │
│  │  (tabs)    │                                         │  │
│  │  Checkout  │   one .pos-panel.active at a time,      │  │
│  │  Inventory │   swapped by SPos.ui.switchTab(view)    │  │
│  │  Customers │   — no navigation, no window.open       │  │
│  │  Reports   │                                         │  │
│  │  Suppliers │   heavy views lazy-render on first      │  │
│  │  Cash/Till │   switch (dataset.loaded guard)         │  │
│  │  Daily Ops │                                         │  │
│  │  Settings  │                                         │  │
│  └────────────┴───────────────────────────────────────┘  │
│  Persistent: cart (state.cartItems, now reload-durable),  │
│  cashier/session (Firebase + sokoniUser), manager step-up │
└──────────────────────────────────────────────────────────┘
   Separate windows ONLY: printer-setup, kiosk/display/kds, live-floor, hq
```

- **Router:** keep `SPos.ui.switchTab`. Extend it to (a) lazy-render newly-added views with the existing `dataset.loaded` guard, and (b) update the URL hash (`pos.html#reports`) so views are deep-linkable and back/forward works. Deep-linking already partly exists (`pos-daily.html:673` → `pos.html#refund`).
- **Views = panels.** Convert every in-shell popout to `switchTab`. Add the missing cashier views (Suppliers, Cash/Till, Daily Ops) as new `.pos-panel` sections that lazy-load their module on first switch — mirroring how Finance/Repair/Audit already load.
- **Standalone pages become deep-link entries,** not in-shell destinations: external launchers (`ecc.html`, `admin-os.html`, setup redirects) keep working; a thin standalone page redirects into `pos.html#<view>` so everyone lands in the shell (one session). Kept reachable for direct URLs but never opened *from within* the shell.

---

## 4. Persistent cart + cashier session

The session already persists across pages (§2.2) — the missing piece is **cart durability across reload/crash**, which is what makes it feel like "one continuous till."

- **Persist `state.cartItems`** (and `state.currentTab`) to `sessionStorage` (per-tab till) on every mutation, throttled; restore on boot. Rationale: `sessionStorage` scopes to the terminal tab so two tills on one machine don't cross-contaminate; survives reload/crash within the session. Cross-reboot durability already covered by IndexedDB parked sales.
- **Single active cart guard:** on boot, if a restored cart exists, resume it; expose the existing "hold/park" (`pos-sales.js`) for switching customers. No new cart engine — reuse `SPos.cart.*`.
- **No fabricated state** ([[feedback_no_fabricated_metrics]]): a restored cart shows exactly what was saved; if restore fails, start empty and say so — never reconstruct a plausible cart.

---

## 5. Phased, reversible rollout

Each phase is independently shippable, browser-verified before the next, and revertable (mostly `onclick`/redirect changes).

| Phase | Scope | Risk | RC status |
|---|---|---|---|
| **0. Map** | Enumerate every `window.open`/`_blank`/cross-`pos-*` link; map each to an existing panel, a new view, or a kept-popup. (Design artifact — done here.) | none | RC-safe |
| **1. Converge popouts with existing panels** | Reports, Customers, Inventory, Full Reports → replace `window.open('pos-X.html','_blank')` with `SPos.ui.switchTab('X')`. Immediate single-window win, no new code paths. | LOW (revert onclick) | **Defect fix** — eliminates tab-sprawl/duplicate sessions; RC-appropriate |
| **2. Add missing cashier views** | Suppliers, Cash/Till, Daily Ops as new `.pos-panel`s, lazy-loaded on first `switchTab` (Finance pattern). Standalone pages become the module source or a redirect. | MED | R1.1 (flag & confirm) |
| **3. Persistent cart/session** | sessionStorage save/restore of `cartItems` + `currentTab`; resume-on-boot; hash-based deep-link + back/forward. | MED | R1.1 |
| **4. Standalone → deep-link redirects** | `pos-reports/customers/inventory/suppliers.html` become thin redirects to `pos.html#<view>` so external launchers land in the shell. | LOW–MED | R1.1 |

**Per-phase verification** (browser-automation): after Phase 1, tapping "Full Reports/Manager/Inventory" opens **no new tab** and shows the correct panel; after Phase 3, a reload mid-sale restores the cart; no console errors; `test-seller-dashboard`-style gate for POS routes if added.

---

## 6. Stays a separate window (by design)
- **Printer setup** (`pos-printer-setup.html`) — a focused settings popup; fine as a small window, not a cashier view.
- **Customer-facing displays** — `pos-kiosk.html`, `pos-display.html`, `pos-kds.html`, `pos-live-floor.html` run on **separate physical screens**; they must be their own windows.
- **Owner/multi-branch** — `pos-hq.html`, `pos-workspace.html` are distinct surfaces (multi-branch analytics, device pairing), not part of the cashier loop.

---

## 7. Non-goals / risks
- **Non-goal:** rewriting modules as a JS framework SPA, or iframing modules (the user explicitly ruled out iframes; the panel router avoids them).
- **Risk — heavy first paint:** `pos.html` already eager-loads ~65 scripts. The shell doesn't add to this, but Phase 2 should lazy-load new view modules (defer their `<script>` and load on first switch) to avoid growing first paint. Track against `perf-guard` baselines.
- **Risk — deep-link consumers:** many pages/launchers point at standalone `pos-*.html`. Phase 4 redirects (not deletions) preserve them. Do **not** delete standalone pages until redirects are proven.
- **Risk — two tills one machine:** `sessionStorage` cart scoping (not `localStorage`) prevents cross-tab cart bleed.

---

## 8. Acceptance criteria
1. No cashier action inside the shell opens a new browser tab (`window.open`/`_blank`) except the §6 exceptions.
2. Reports, Customers, Inventory, Suppliers, Cash/Till, Daily Ops are reachable as in-page views with instant switching (no full reload, stack loaded once).
3. A reload or crash mid-sale restores the active cart and view.
4. External launchers (`ecc.html`, `admin-os.html`, setup) land inside the shell at the intended view.
5. Session + manager step-up continue to work unchanged; no regression in `posCompleteCheckout` or the offline outbox.
6. No fabricated state anywhere in the flow.

---

## 9. Recommended first step
Approve **Phase 1** (converge the popouts that already have panels — Reports/Customers/Inventory). It is low-risk, reversible, RC-appropriate (kills tab-sprawl and duplicate sessions), and delivers the most visible single-window improvement immediately, while Phases 2–4 proceed as R1.1 with per-phase verification.
