# Firestore Composite Index Audit — 2026-07-17

**Bug class:** a query that requires a composite index which is not deployed throws
`FAILED_PRECONDITION` at runtime. As the legal-hub incident showed, a client-side fallback can
mask it so the feature merely looks *empty* rather than broken.

**Method:** parsed every `collection(...).where/orderBy` chain in `functions/**`, encoded
Firestore's index rules, and cross-referenced against the **live** deployed index set
(`firebase firestore:indexes` → 336 composite indexes). Read-only.

---

## ⚠️ A correction I had to make mid-audit — recorded because it matters

My first pass applied the rule *"two or more equality filters require a composite index."*
**That is wrong.** Firestore serves multiple equality filters with a **zigzag merge join** over
automatic single-field indexes; no composite is needed.

A composite index is required only when an equality/array clause is combined with a **range
(`<`, `<=`, `>`, `>=`, `!=`) or an `orderBy` on a *different* field**.

The wrong rule produced **394** candidates and would have had me report
`posProducts.where(merchantId).where(status)` — the POS bootstrap query in `_buildBundle` — as a
**pilot blocker**. It is not: two equality filters, no ordering, served by merge join.

Corrected rule → **262 candidates**. This is exactly the class of error the
[Security Audit Standard](SECURITY_AUDIT_STANDARD.md) exists to prevent: *validate the rule itself,
not just the code.*

## ⚠️ The Firestore emulator does NOT enforce composite indexes

**This is the important methodological finding.** Every emulator test run this session passed —
including the Phase 12 suite — because the emulator serves any query regardless of index
requirements. **Emulator testing structurally cannot catch this bug class.** Missing indexes only
appear against real Firestore.

Consequence: "18/18 PASS on the emulator" is *not* evidence that a query works in production.
Index coverage must be verified separately, against the deployed index set.

---

## CONFIRMED — pilot-critical

These sit on the merchant trading path and are verified missing (the collection has **zero**
composite indexes deployed).

### I-1 · `getWalletBalance` — customer wallet is unreadable

`functions/pos-crm-pro.js:131`

```js
db.collection('posWalletTransactions')
  .where('sellerId', '==', sellerId)
  .where('phone',    '==', normPhone)
  .orderBy('createdAt', 'desc')          // <- orderBy on a THIRD field => composite required
  .limit(10)
```

`posWalletTransactions`: **0 composite indexes deployed.**

**This chains directly into today's RC1 work.** The `sellerId` contract fix (`cbade53`) made the
CRM wallet reachable — but the very next step, reading the balance, would still fail in
production. The fix was necessary and not sufficient.

**Required index:** `posWalletTransactions` → `sellerId` ASC, `phone` ASC, `createdAt` DESC.

### I-2 · POS sales reporting — `posSales` / `posRetailSales`

`posSales`: 0 composite indexes; `posRetailSales`: 0. Affected shapes include:

| Query | Site | Feature |
|---|---|---|
| `sellerId` + `customerPhone` + `createdAt` | `pos-crm-pro.js:1123` | customer purchase history |
| `sellerId` + `status` + `createdAt` | `pos-retail-engine.js:620` | sales listing |
| `sellerId` + `createdAt` + `status` | `pos-accounting.js:621` | **accounting reports** (the 11 ops just restored) |
| `sellerId` + `status` + `saleDate` | `pos-bi.js:178` | business intelligence |
| `sellerId` + `branchId` + `status` + `saleDate` | `pos-hq.js:1123` | HQ multi-branch |
| `cashierUid` + `status` + `createdAt` | `pos-retail-engine.js:962` | cashier performance |
| `sellerId` + `cashierUid` + `createdAt` | `pos-staff-ops.js:573` | shift reports |

Note the irony: the accounting routing fix (`5773607`) restored the *call path* to those 11
operations, but `pos-accounting.js:621` still needs an index to return data.

### I-3 · Incremental sync + bootstrap

| Query | Site | Impact |
|---|---|---|
| `posProducts` `merchantId`+`status`+`updatedAt` | `business-bootstrap.js:482` | incremental catalogue sync |
| `posStaff` `branchId`+`status`+`updatedAt` | `business-bootstrap.js:488` | incremental staff sync |
| `branches` `merchantId`+`status`+`name` | `business-bootstrap.js:677` | branch picker |

`getIncrementalSync` is how a POS device stays current after first bootstrap. **Initial
`bootstrapDevice` is unaffected** — its `posProducts` query is two equality filters (merge join,
no composite needed), which is precisely the case my first rule got wrong.

### I-4 · Subscriptions

`subscriptions` `uid`+`updatedAt` (`sub-billing.js:219`) and `uid`+`hubType`+`updatedAt`
(`sub-engine.js:445`). Relevant to the trial-expiry work shipped today — the sweep itself filters
on `status` only (single field, fine), but these adjacent reads need indexes.

---

## UNVERIFIED candidates — 262 total shapes

The full run reports **262 distinct query shapes across 375 call sites** lacking a deployed index,
spanning vehicle listings, workspace/org services, analytics, alerting, webhooks and more. **Only
the pilot-critical subset above has been manually verified.** The remainder are candidates, not
confirmed defects — many belong to features that may never have been exercised in production,
which is likely why the gap went unnoticed.

They are **not** reported as defects here. Confirming them requires either exercising each query
against real Firestore or reviewing each call site individually.

---

## Recommendation

**No index changes made** — index deployment is an infrastructure action and the propagation hold
is in force. Additionally, per the standing index rule: **only ever add indexes, never drop**, and
deploy without `--force` so nothing can be removed.

Priority when authorized:

1. **I-1** — one index; unblocks the wallet feature fixed today. Highest value per unit of effort.
2. **I-2** — `posSales`/`posRetailSales`; unblocks accounting and sales reporting for the pilot.
3. **I-3** — incremental sync; the POS bootstraps without it but will not stay current.
4. **I-4** — subscriptions.
5. Triage the remaining 262 by feature priority; most are outside the pilot path.

**Verification method after deploying:** re-run this audit, and — because the emulator cannot
prove index coverage — exercise each affected query against real Firestore.
