# Admin OS — Phase 1 Canonical Synchronization (Reconciliation Report)

**Date:** 2026-08-02
**Scope:** Make every Admin Console dashboard/pane read live production data from the
**canonical** backend collection (docs/[[CANONICAL_COLLECTIONS]]), replacing localStorage
mirrors — **without** touching the concurrent `showPane()`/`renderPane()`/routing/CSS/layout
refactor owned by another agent. **Additive backend + data-binding changes only.**

Related: [[project_admin_console_integrity]] · [[reference_canonical_collections]] · [[feedback_registry_projection_traps]]

---

## The reconciliation principle

Before this phase, panes and the dashboard **diverged**: the dashboard read (mostly)
canonical collections while panes read stale `localStorage` caches. A "successful" write
landed in Firestore but the pane kept showing an old local mirror → the admin saw `0` or
stale rows while real data sat elsewhere.

After this phase, each metric derives from **ONE canonical collection, read identically**
by both the dashboard KPI and the pane. They therefore **cannot diverge** — reconciliation
is guaranteed *by construction*, not by a periodic sync job.

```
Firestore (canonical)  ──►  dashboard KPI  (adminGetExecutiveDashboard / adminGetFinance)
        │                        ▲
        └──►  pane listener  ─────┘   (SokoniDB.listen* → same collection)
```

---

## Module-by-module

| # | Module | Was (wrong source) | Now (canonical) | Read path |
|---|---|---|---|---|
| **P1** | **Providers** | `localStorage('sokoniServiceProviders')` | `providers` (status ∈ active/approved) | `SokoniDB.listenProviders` → `D.providers` → `renderProviders` |
| **P2** | **Finance** | `localStorage` ledgers (`sokoniCommissionLedger`, `sokoniBookingFees`, `sokoniPhoneLeads`, `sokoniPlatformBookings`) | `payments` + `commissionLedger` + `providerPayouts` + `payoutRequests` + `wallets` | `adminGetFinance()` → live `#finKpis` strip |
| **P3** | **Products** | `localStorage('sellerProducts')` (+ demo seed) | `products` (newest-200) | `SokoniDB.listenProducts` → `D.products` → `renderProducts` |
| **P5a** | **Reports → Revenue** | `transactions` (empty) | `payments` | `renderReport()` colMap |
| **Dashboard** | Overview KPIs | (already canonical, extended) | `users`/`providers`/`orders`/`providerBookings`/`payoutRequests` | `adminGetExecutiveDashboard` → `renderOverview()` |

### Backend: `adminGetFinance()` (new, canonical aggregate)

Aggregates all five finance streams per the [[CANONICAL_COLLECTIONS]] reporting rule
(*aggregate, don't pick one*):

- **Platform revenue** = product commission (`commissionLedger.sokoniCut`) + service
  commission (`providerPayouts.commission`, settled). **Never** `transactions` alone.
- **Service revenue (GMV)** = `providerPayouts.gross` (settled).
- **Gateway fees** = `payments.amount − payments.netAmount` (COMPLETE). Platform-absorbed
  (Option 1) → **Net margin = totalCommission − gatewayFees**.
- **Wallet liability** = Σ `wallets.balance`.
- **Payouts** = `payoutRequests`: pending|approved|processing (in-flight) vs paid|completed.

Index-safe: single-field `createdAt >=` ranges, in-memory `today/7d/30d` buckets. Reads are
**capped and the cap is reported** (`capped.*`) so a truncated total can never masquerade
as complete.

### Product actions made honest + canonical (P3)

The old local-splice "delete" was **dangerous** — the admin saw the row vanish while the
product stayed **live for customers**. Now:

- `deleteProduct` → canonical unpublish (`adminUpdateProductStatus` → `status:'removed'`);
  the listener hides `removed`/`unpublished`/`deleted`.
- `toggleFeature` → `adminUpdateProductStatus` (preserves status, flips `featured`), with
  optimistic rollback on write failure.
- `approve`/`reject` keep their existing canonical `_syncListingApproval` path.
- All dead `localStorage.setItem('sellerProducts', …)` writes removed.

---

## Deferred (boundary-respecting)

| # | Module | Why deferred |
|---|---|---|
| **P4** | **Services (`providerServices`)** | admin.html's Services pane is a **category browser** (sub-tabs), with **no** localStorage services cache to remove. A `providerServices` *catalog table* does not exist — adding one is **new pane DOM**, which collides with the active `showPane()`/`renderPane()` refactor. A backend `adminGetServices()` can be added for reconciliation once pane ownership is settled. |
| **P5b** | **Provider Analytics (`providerAnalytics`)** | No analytics pane exists in admin.html; wiring the daily rollups needs a **new pane** — same collision risk. The one in-scope canonical bug (Reports revenue source) is fixed. |

These are **not** localStorage-source defects — they are *missing panes*. They belong to a
future "Admin Analytics/Services pane" story owned jointly with the pane refactor, not to
this data-binding phase.

---

## Verification procedure (run in the live console)

Reconciliation holds by construction; confirm the numbers agree in production:

1. Open `https://mysokoni.co.ke/admin` (hard refresh).
2. **Overview** KPIs (Providers, Product Orders, Service Bookings, Pending Payouts, Payout
   Liability) come from `adminGetExecutiveDashboard`.
3. **Providers** pane count must equal Overview *Providers*.
4. **Products** pane count reflects live `products` (no demo rows in production —
   `_demoAllowed` is false).
5. **Finance** pane: the canonical strip (Platform Revenue / Product / Service Commission /
   Gateway Fees / Net Margin / Wallet Liability / Pending / Paid Out) is Firestore-sourced;
   the P&L above it is the admin's own hand-entered cost/tax bookkeeping (legitimately local).

**PASS** = Firestore == Dashboard == Pane for each metric. Because both sides read the same
canonical collection, a mismatch can only mean a propagation delay or a read error — not two
sources of truth.

---

## Enforcement

`docs/CANONICAL_COLLECTIONS.md` + `scripts/test-canonical-collections.js` (deploy gate) keep
this from regressing: a new backend file reaching for a non-canonical collection fails the
gate. Extend the guard's rules per-domain as later modules land.

*Part of the 2026-08 Admin data-layer audit. Update alongside any new admin data binding.*
