# SOKONI SmartPOS Enterprise v2.0 — Spec & Staged Roadmap

Owner-authored spec (18 subsystems). This is a **staged product build**, not one implementation.
Each stage ships and verifies independently on the `pos-v2.html` foundation. Reuse proven logic
(shared-app auth, `updateClickAndCollectStatus` dispatch, printer stack, `/api/available-deliveries`).

## Where it stands

| Stage | Subsystems | Status |
|---|---|---|
| **1 — Foundation** (`/pos-v2`) | §1 header + status chips · §2 search/scan bar · §9 **Dispatch Center** (Ready for Dispatch / Pickup) · §11 pickup · §14 Printer panel (status/test/reconnect) · §15 quick actions · §16 bottom nav · §18 safe-area + 48px | ✅ **BUILT** |
| **2 — Dashboard & links** | §3 Smart Dashboard KPI cards (Sales/Orders/Pending Dispatch/Stock/Cash) · deep-links to §12 Inventory + §13 Analytics | ⏳ |
| **3 — Selling flow** | §4 Product grid (live `/api/catalogue`, stock/price) · §5 Cart (qty ±) · §7 Payment: **Cash LIVE** via `posCompleteCheckout` (canonical `products`), **M-Pesa** hands cart to proven `/pos-checkout` STK · auto-print receipt | ✅ **Cash BUILT** · M-Pesa handoff · split/card ⏳ |
| **4 — Customer & receipts** | §6 Customer panel (wallet/points/history/credit) · §8 Receipt center (Print/Reprint/Email/SMS/WhatsApp/PDF) | ⏳ |
| **5 — Rider assignment** | §10 assign specific rider (distance/ETA/vehicle/rating) + live track — extends the current pull-accept | ⏳ |
| **6 — Governance** | §17 **RBAC** (cashier/store-mgr/branch-mgr/owner/admin) + **audit log** on every sensitive action (refund/discount/stock-adj/dispatch-override/price) | ⏳ (do LAST — backend-enforced) |

## Stage 1 — what's live now (`/pos-v2`)

The parts you were *actually blocked on*:
- **Dispatch decoupled from printing** — "🚚 Ready for Dispatch" (delivery) / "🏪 Ready for Pickup": server creates the rider job + notifies the buyer; printing is a separate optional action.
- **First-class actions always visible** — Printer / Scan / Dispatch / Add / New Sale in a scrollable bar that never hides behind the nav.
- **Printer panel** — slide-up status / paper / Test Print / Reconnect (no longer buried).
- **Order tabs** — New · Awaiting Rider · Ready/Pickup · Done, live via `sellers/{uid}/clickAndCollect`.
- **Safe-area correct** — `env(safe-area-inset-bottom)` on the bottom nav + toasts + printer panel; 48px touch targets; nothing under the iPhone home indicator.
- **Auth fixed** — shares the one logged-in session (no named-app "Verifying credentials" hang).

## Build order rationale
1. Foundation first (done) — the workflow spine everything hangs off.
2. Selling flow (Stage 3) is the biggest slice; today it lives in `/pos-checkout` — fold it in incrementally, don't rewrite payment logic (it's money-critical, proven).
3. **RBAC + audit (Stage 6) last and backend-enforced** — never a client-only gate; every privileged action verified server-side + logged ([[feedback_security_layers]]).

## Completion criteria (owner's E2E)
search/scan → cart → customer → payment → receipt → order in Merchant Orders → Ready for Dispatch/Pickup → rider job in Rider Hub (delivery) / pickup code + notify (pickup) → inventory + analytics + customer history + finance all update consistently.

Related: [[project_smartpos40_polish]], [[project_smartpos_checkout_v2]], `pos-marketplace.html` (current), `pos-checkout.html` (till).
