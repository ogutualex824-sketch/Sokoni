# SOKONI — Launch Validation Evidence Log

> This is the **launch evidence**, not memory of testing. Fill a row per real transaction, on each
> device. Leave nothing to recall. Companion to [[LAUNCH_READINESS]].

**Exit rule:** *Any P0 or P1 defect discovered during real-world validation PAUSES merchant
onboarding until it is fixed AND re-tested.* Log defects in the register at the bottom.

**Four exit criteria per test:**
Functional (completes) · Consistent (all participants see the same state) · Auditable (expected
audit entry exists) · Recoverable (network loss / restart / reconnect leave no inconsistent data).

---

## Core transaction matrix

Run each on **Android**, **iPhone**, **Desktop**. Duplicate the row per device.

| Test | Device | Expected | Actual | Pass/Fail | Evidence (Order ID / screenshot) | Audit check |
|---|---|---|---|---|---|---|
| Retail sale (cash) | | Receipt prints (centered, no "?"), stock drops, KPI updates | | | Order/Sale ID + photo | — |
| Retail sale (M-Pesa) | | STK prompt → paid → receipt | | | Order ID | — |
| Delivery order | | Merchant sees order in seconds | | | screenshot | — |
| → Ready for Dispatch | | Rider job created, buyer notified | | | order id | `pos.dispatch.status` |
| → Rider accepts | | Order shows rider assigned | | | screenshot | — |
| → Delivery completes | | Timeline → Delivered, all parties agree | | | photos | — |
| Pickup order | | Merchant prepares, marks Ready | | | screenshot | `pos.dispatch.status` |
| → Customer notified | | Pickup notification received | | | screenshot | — |
| → Collected | | Timeline → Collected | | | order id | — |
| Refund | | Stock returns, sale=refunded | | | sale id | `pos.refund` |
| Stock adjustment | | Level changes correctly | | | product id | `inventory.stock_adjust` |
| Price change | | New price everywhere | | | product id | `product.price_change` |
| Receipt reprint | | Prints again, count increments | | | order id | `pos.receipt_reprint` |
| Role change | | Access changes after re-login | | | uid | `role.change` |
| Offline cash sale | | Completes offline, syncs ONCE on reconnect | | | order id (one, not two) | — |
| Cross-device sync | | Android ↔ iPhone ↔ Desktop within seconds | | | video | — |

## Device & resilience checks (from LAUNCH_READINESS Phase 3)

| Check | Android | iPhone | Desktop | Evidence |
|---|---|---|---|---|
| Login persistence | | | | |
| Session sync (A↔B) | | | | |
| Printer reconnect after app restart | | **N/A (no iOS Web BT)** | | |
| Printer reconnect after Bluetooth off/on | | **N/A** | | |
| Network loss + recovery | | | | |
| Background/foreground resume | | | | |
| Camera barcode scanning | | | | |
| Long receipt | | | | |
| Safe-area layout | — | | — | |

## Alert trigger-tests (manual acceptance)

| Alert | Triggered? | Email received? | Auto-resolved? | Notes |
|---|---|---|---|---|
| Auth Failure Spike (>10/5min) | | | | |
| Dispatch Failure (>3/5min) | | | | |

---

## Verifying "Auditable" on the spot

After a refund / stock-adjust / price-change / reprint / role-change, confirm the audit entry
landed: **`node scripts/qa/tail-audit.js [action]`** — prints the most recent `auditLogs` entries
(optionally filtered by action, e.g. `pos.refund`). Paste the entry into the Evidence column.

---

## P0 / P1 Defect Register (blocks onboarding until fixed + re-tested)

| # | Severity | Device | Flow | Symptom | Status | Fixed in | Re-tested |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

---

## Go decision

Onboard merchants only when: the core matrix passes on all three devices, both alert
trigger-tests pass, the restore drill is demonstrated (done — see LAUNCH_READINESS), and the P0/P1
register is empty. Otherwise: pause, fix, re-test.
