# Merchant OS — Founder Device Certification (Acceptance Gate)

**Build under test:** v454 (`/merchant`, `mysokoni.co.ke`) · commit `0ba2f34`
**Run on:** the real production device (founder iPhone + laptop), signed in as the merchant.
**Rule:** `/merchant` does NOT become the default entry, and NO old architecture is retired,
until every box below is checked on the actual device. Eng-complete ≠ production-proven.

> Mark each: ✅ pass · ❌ fail (note what happened) · ➖ n/a. A single ❌ blocks the gate.

---

## 1. Printer (continuity is the point)
- [ ] Connect once (Devices → Connect).
- [ ] Reload `/merchant` → auto-connect / status returns to 🟢 without manual action.
- [ ] Navigate Cashier → Orders → Reports → Finance → Analytics → Dashboard — chip **stays** 🟢.
- [ ] Test Print (Devices) prints.
- [ ] Cashier: complete a sale → receipt prints.
- [ ] Orders: open an order → reprint prints.
- [ ] Forget → status goes 🔴 disconnected.
- [ ] Reconnect → status returns 🟢 connected.

## 2. Orders (one unified view, no dupes, live)
- [ ] Historical POS orders appear.
- [ ] Today's POS orders appear.
- [ ] Live online (marketplace) orders appear.
- [ ] Delivery and pickup orders appear.
- [ ] **No duplicate** records (same order shown once).
- [ ] Search / tab filter / date range all work.
- [ ] Open detail → event timeline renders.
- [ ] Print from detail works.
- [ ] Change a live order's status elsewhere → native Orders updates **without a `/merchant` reload**.

## 2b. Live-chain proof (strongest evidence — do this deliberately)
During the Orders + Analytics checks, **create or change ONE online order** and watch it flow the
whole chain **without a page reload**:

```
Marketplace → Seller authenticated feed → OrderService → UnifiedOrderView
           → AnalyticsEngine → Dashboard / Reports / Finance / Analytics
```
- [ ] The new/changed online order appears in native Orders **without reload**.
- [ ] It is **not** duplicated.
- [ ] Dashboard / Reports / Finance / Analytics figures move consistently for it (same delta everywhere).

## 3. Analytics parity (same source, identical numbers)
Pick ONE date range, read all four, and record the numbers:

| Metric | Dashboard | Reports | Finance | Shop Analytics |
|---|---|---|---|---|
| Revenue |  |  |  |  |
| Orders  |  |  |  |  |
| AOV     |  |  |  |  |
| POS     |  |  |  |  |
| Online  |  |  |  |  |
| Refunds |  |  |  |  |

- [ ] All four columns match per row.
- [ ] Cross-check those figures against the actual Orders list for the same range.

## 4. Navigation
For **every** sidebar item:
- [ ] One click → the **correct** module (no "Loading POS", no wrong screen).
- [ ] No full page reload.
- [ ] No double sidebar.
- [ ] Content scrolls; primary action reachable.
- [ ] (Phone) bottom nav Home/Orders/Sell/More works; "More" opens the drawer; tap-outside closes it.
- [ ] (Phone) ⌘K/🔍 palette opens, filters, and jumps to the right module.

## 5. Stress
Repeatedly switch Dashboard → Orders → Reports → Finance → Analytics → Shop → Customers → Cashier
while the printer is connected and live data is updating:
- [ ] No freezes.
- [ ] No growing load times.
- [ ] No duplicated orders.
- [ ] No stale numbers.
- [ ] Printer never drops.
- [ ] Scrolling never breaks.

---

## Sign-off
- Result: ☐ PASS (all ✅) ☐ FAIL (list ❌ items below)
- Notes:
- Signed / date:

**On PASS →** flip `/merchant` to default entry, then retire old architecture incrementally
(rollback point after each removal). **On FAIL →** fix the specific ❌ items first; re-run this sweep.
