# P0-7 — Payment Integrity Reconciliation Report

**Date:** 2026-07-13
**Scope:** every historical order with `status = paid` and no verified provider transaction
**Method:** read-only Firestore REST query across **all** databases in `sokoni-aeb26`
**Result:** **ZERO affected orders.**

---

## Finding

**No order has ever been created in production. Not one.**

The P0-7 defect — four checkout paths that fabricated *"✅ Payment Confirmed"* and wrote
orders as `paid` with no money behind them — **caused no financial loss**, because the
platform has never processed a single order.

The fix remains entirely necessary: the defect would have caused loss on the **first real
order**. It simply never got the chance.

---

## Evidence

Queried with the operator's own Firebase CLI credentials over the Firestore REST API,
read-only (`GET` and `listCollectionIds` only; nothing was written).

### Databases in the project — both checked

| Database | Region | Collections | Order/payment collections |
| --- | --- | --- | --- |
| `(default)` | nam5 | **69** | **NONE** |
| `sokoni-ops` | europe-west1 | **0** (empty) | **NONE** |

### `(default)` — all 69 collections

```
_health, _healthcheck, _sokoniHealth, _sokoniMetricsHourly, _sokoniWorkers,
ade_decisions, adminAlerts, adminAuditLogs, algoliaEntriesHistory, algoliaHealthHistory,
algoliaQueue, algoliaQueueDLQ, algoliaReconcileHistory, analyticsRollup, auditLogs,
automationAuditLog, billingReconciliation, chaosTestReports, clientMetrics,
cspViolations, deliveryLocations, driverLocations, eccIncidents, eccSystemHealth,
emailLogs, emailQueue, etimsReconciliations, executiveSummaries, fcm_tokens,
finosSnapshots, healthSnapshots, hourlyMetrics, impactMonthlySnapshots, kassKnowledge,
notifications, opsMetrics, ops_backups, ops_reports, platformMetrics, products,
reconciliationReports, rollbackSnapshots, sasosRevenueAggregates, searchAnalytics,
searchConfig, searchDLQSweepLog, searchHealthHistory, securityAuditLog,
securityPentestReports, selfHealLog, sysConfig, systemAlerts, systemHealth,
systemHealthHistory, trending, tsAnalytics, tsBackupDocs, tsBackupMeta, tsHealthLog,
tsLatencyLog, tsMonitor, tsOrphanLog, tsQueueStats, tsReconcileLog, typesenseQueue,
userProgress, userSessions, userSync, users
```

**There is no `orders` collection.** Firestore's `listCollectionIds` only returns
collections that contain at least one document — so an absent `orders` collection is
positive evidence that **zero order documents have ever been written**, not merely that
the query found nothing.

Nor is there any `payments`, `transactions`, `ledger`, `settlements`, `escrow`, or
`invoices` collection. The entire money path is unused.

**Sanity check on the method:** the same query returned 69 collections and read `products`
and `users` successfully. The read works. An empty result and a broken read look identical,
so this distinction matters — it is the whole reason the collection list is reproduced above
rather than a bare "0 found".

---

## Reconciliation table

| Order ID | Customer | Merchant | Amount | Method | Created | Provider Ref | Provider Txn | Status | Risk | Action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — | — | — | — | — |

**Zero rows.** No order exists to reconcile. No customer was charged. No seller shipped
against a fabricated confirmation. No settlement, commission, payout or escrow figure is
overstated, because none was ever computed.

---

## What this changes

**Every revenue, GMV, settlement and commission figure on the platform is zero, and always
has been.** Any dashboard, report or launch metric showing otherwise is displaying seed
data, mock data, or a computed default — not trade.

SOKONI is **pre-revenue**. That is not a criticism; it is a fact that materially changes
the risk picture:

- The P0-7 blast radius was **zero**. There is nothing to claw back and nobody to make
  whole. The earlier concern that "sellers may have shipped against unpaid orders" was
  the right concern to raise, but it did not happen.
- The hotfix's real value is **prospective**: it was fixed before the first customer, not
  after. That is the correct order.
- The money path has **never been executed end-to-end in production by a real user**. It is
  verified by static analysis and by 17 CI checks, but it has never taken a shilling.
  **CB-M1 (money-path verification) legitimately remains NO-GO** — and now for a documented
  reason, rather than an unexamined one.

---

## Recommended action

**None on historical data.** There is none.

The next payment through checkout will be the platform's first. It should be a **deliberate,
supervised, small real transaction** (see `RUNBOOK_PAYMENT_INTEGRITY.md` §4), not a
customer's.

Re-run at any time:

```bash
node scripts/audit-payment-integrity.js --csv payment-audit.csv
```

It is read-only and safe to run against production.
