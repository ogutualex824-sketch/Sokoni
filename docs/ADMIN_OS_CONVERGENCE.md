# Admin OS Convergence — Audit & Programme

**Status:** Phase 0 (audit) complete · 2026-08-01
**Governance:** [[PLATFORM_CONSTITUTION]] Rule 8 — Administrative Authority
**Discipline:** extend, don't rebuild. Consolidate module by module; retire a surface only
when telemetry shows its replacement carrying the load.

---

## Why converge

Fragmented administration does not just duplicate UI — it **splits truth**. Three surfaces
read the same `applications` collection three different ways, and two were broken:

| Surface | How it read `applications` | State |
|---|---|---|
| `moderation.html` | `where(status in […])` + `orderBy('submittedAt')` | **Broken** — needed a `(status, submittedAt)` composite index that was never declared. Firestore rejected every call with `failed-precondition` into a bare `console.warn`, so the tab read *"No pending verifications."* forever. |
| `admin.html` | `orderBy('createdAt')` + merged `localStorage` | **Polluted** — `seedApps()` injected four fabricated applicants into a production queue whenever the real list was empty. |
| `super-admin.html` | — | **Absent** — no view of `applications` at all. |

Nobody could tell which console was right, because none was authoritative. Both defects are
now fixed and all three read the canonical `applicationList` server function.

---

## Phase 0 — Audit (complete)

**Measured 2026-08-01:** 61 admin-gated pages · **34 genuine admin consoles** · ~35,000 lines.

### Domain coverage

| # | Domain | Canonical engine exists? | Admin surface today | Verdict |
|---|---|---|---|---|
| 1 | Identity & Access | ✅ `applicationLifecycle`, `invitations-core` | `admin.html`, `super-admin.html`, `moderation.html`, `verification-admin.html` | **Converged (read/write)** — all three application queues now use `applicationList` / `applicationDecide`. KYC (`verificationRequests`) still separate. |
| 2 | Marketplace Ops | ✅ products/sellers registries | `admin.html` (primary), `admin-messages.html` | Mostly single-surface; moderation queue split with `moderation.html`. |
| 3 | Service Ops | ✅ booking engine, `providers` registry | `admin.html`, `availability-manager.html` | **Fragmented** — bookings/slots/no-shows have no admin view. |
| 4 | Delivery Ops | ✅ `sokoni-dispatch`, `rideDrivers` | `admin.html`, `fleet-monitor.html`, `dispatch.html` | **Fragmented** — 3 surfaces, no single dispatch monitor. |
| 5 | Financial Ops | ✅ settlement engine, FinOS | `finos-admin.html`, `commission-admin.html`, `commission-engine.html`, `sfos-monitor.html`, `fos-admin.html`, `sasos-admin.html`, `financial-os.html` | **Worst fragmentation — 7 surfaces.** Highest consolidation value. |
| 6 | Customer Support | ✅ tickets/disputes | `admin-os.html`, `messages-admin.html`, `admin-messages.html`, `dispute-portal.html`, `trust-safety.html` | **Fragmented — 5 surfaces.** |
| 7 | Compliance | ✅ ODPC records, audit logs | `security-center.html`, `security-compliance.html`, `security-zero-trust-dashboard.html`, `legal-admin.html` | **Fragmented — 4 surfaces.** |
| 8 | Analytics | ✅ `analyticsRollup`, `platformMetrics` | `executive-dashboard.html`, `growth-dashboard.html`, `launch-metrics.html`, `business-kpi.html` | **Fragmented — 4 surfaces.** |
| 9 | Notifications | ✅ `notify.js` (single entry point) | `admin.html` (broadcasts), `email-center.html` | Near-converged. |
| 10 | Monitoring | ✅ `systemHealth` | `monitor.html`, `observability.html`, `platform-health.html`, `redis-monitor.html`, `launch-readiness.html`, `uat-center.html` | **Fragmented — 6 surfaces.** |

### Cross-device readiness

All 22 primary consoles carry a `viewport` meta and register the service worker, so
self-update is correct platform-wide. Responsive depth is the gap:

| Console | `@media` blocks | Mobile risk |
|---|---|---|
| `admin.html` | 6 | Lowest — has `mobile.css` |
| `sasos-admin.html` | 5 | Low |
| `verification-admin.html`, `executive-dashboard.html`, `sfos-monitor.html` | 4 | Medium |
| **`moderation.html`** | **0** | **High** — wide tables overflow; regressed further by the new 6-column verifications table |
| **`trust-safety.html`** | **0** | **High** |

**Finding:** no admin console is desktop-*only* (no fixed-width layouts, no hover-only
actions), so Rule 8's cross-device clause is a **finishing** job, not a rewrite. The two
zero-media-query consoles are the immediate work.

---

## Phased programme

Each phase is independently shippable and leaves the platform working. No phase rebuilds a
functioning surface.

### Phase 1 — Financial convergence *(highest value: 7 → 1)*
Read-only first. One Financial Ops view reading the settlement engine's canonical records:
commission, platform revenue, seller/provider payouts, wallet balances, settlement history,
refunds, recovery debt, transactions. **The Admin OS must never calculate money** — it
displays what settlement recorded. Retire the six satellites only after telemetry shows the
converged view carrying the reads.

### Phase 2 — Delivery convergence *(3 → 1)*
Single dispatch monitor: online/offline riders, claimable and active deliveries, rider
locations, delivery timeline, failed dispatches. Reads `rideDrivers` + `dispatchQueue` +
`packageRequests` directly — these are already canonical.

### Phase 3 — Support convergence *(5 → 1)*
Chats, tickets, complaints, refund requests, disputes, booking issues, delivery issues in
one queue with one state machine.

### Phase 4 — Monitoring convergence *(6 → 1)*
One health view: Cloud Functions, Firestore, payments, dispatch, wallets, search, auth.

### Phase 5 — Service Ops *(fills a genuine gap)*
Bookings, availability, slots, reviews, cancellations, no-shows currently have **no** admin
view despite a canonical booking engine existing.

### Phase 6 — Compliance & Analytics *(4 → 1 each)*
Consent records, data-rights requests, erasure queue, audit logs, ODPC status, security
events. Then GMV/orders/bookings/actives/revenue/commission/growth/conversion.

### Phase 7 — Cross-device finishing
Responsive passes on every converged module; a mobile smoke test asserting each management
action completes at 390 px. Start with the two zero-media-query consoles.

---

## Compliance checklist (per module, per phase)

- [ ] One canonical **read** path (server function, not an ad-hoc client query)
- [ ] One canonical **write** path (server-authoritative, atomic, returns a receipt)
- [ ] Reads canonical records; recomputes nothing — especially money
- [ ] A read failure renders as a **failure**, never as an empty state
- [ ] No demo/seed data outside `_demoAllowed`
- [ ] Every action completable at 390 px width
- [ ] Retired surface removed only after telemetry shows zero traffic

---

## Precedent

Identity & Access (domain 1) is the worked example, delivered 2026-07-30 → 08-01:
one engine (`application-lifecycle.js`, `invitations-core.js`), one read (`applicationList`),
one write (`applicationDecide`), three consoles converged onto them, failures surfaced
instead of swallowed, demo data gated, and a state none of them could previously express —
*"approved but NOT published"* — made visible with one-click repair.

Related: [[PLATFORM_CONSTITUTION]] · [[PUBLICATION_CONTRACT]] · [[PROVIDER_LIFECYCLE_CONTRACT]]
