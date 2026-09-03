# ADR-018 — Legacy retirement graph: retire on zero callers AND zero production traffic, never on traffic alone

**Status:** ✅ **ACCEPTED** (2026-09-03) — 18b retired and committed. 18c is **specified, not built**.
**Date raised:** 2026-09-03 · **Accepted:** 2026-09-03
**Raised by:** the 18-series legacy-surface audit (`functions/index.js`, `functions/pos-retail.js`,
`functions/procurement.js`)

---

## The decision

> **AN ENDPOINT IS ELIGIBLE FOR RETIREMENT ONLY WHEN IT HAS ZERO CODE-LEVEL CALLERS *AND* ZERO
> PRODUCTION INVOCATIONS OVER THE FULLY OBSERVABLE LOGGING WINDOW.**
>
> Zero production traffic **alone** is never sufficient. An endpoint with real, wired UI callers
> that simply hasn't been exercised yet is a **lifecycle-use question**, not a retirement candidate
> — retiring it would delete a feature, not dead code.

This ADR exists to stop a specific mistake: two Cloud Functions both named for "sending a purchase
order" both showed zero invocations in the same measurement window, and only one of them was
actually dead. Retiring by traffic count alone would have deleted the live one.

---

## 18b — `posSendPurchaseOrder` retired; `procurement.sendPurchaseOrder` is not touched

### The two candidates

| | `posSendPurchaseOrder` | `sendPurchaseOrder` |
|---|---|---|
| source | `functions/pos-retail.js` → `sendPurchaseOrder()` | `functions/procurement.js` → `sendPurchaseOrder()` |
| Cloud Run service | `possendpurchaseorder` | `sendpurchaseorder` |
| created | 2026-07-11 | 2026-06-27 |
| surrounding lifecycle | none — a standalone "email an existing `purchaseOrders/{poId}` doc" callable with no `createPurchaseOrder`/`approvePurchaseOrder`/`receiveGoods` around it | full engine: `addSupplier` → `createPurchaseOrder` → `approvePurchaseOrder` → `sendPurchaseOrder` → `receiveGoods` → `createSupplierInvoice` → `approveAndPayInvoice`, all in one module |
| code-level callers (repo-wide grep) | **0** | **2** — `inventory.html:2969` (`call('sendPurchaseOrder')({ poId })`), `pos-suppliers.js:168` (`httpsCallable('sendPurchaseOrder')({ poId, method })`) |
| invocation log entries, observable window | **0** | **0** |
| disposition | **RETIRED** | **NOT RETIRED — separate open question** |

Both show zero production invocations in the same window. Only the code-caller axis
distinguishes them: `posSendPurchaseOrder` is unreachable from anywhere in the product, and
`sendPurchaseOrder` is wired into two live UI call sites. That is the entire basis for retiring
one and not the other — **do not re-open this by comparing traffic counts alone.**

### What "observable window" actually means here — a correction

The retirement was proposed on a claim of "90-day production caller evidence." That could not be
substantiated and should not be repeated. `gcloud logging buckets list --location=global` shows
the `_Default` log bucket — which is where Cloud Run/Cloud Functions request and execution logs
land — has **`retention_days=30`**, not 90. The `_Required` bucket goes back 400 days, but it
holds Admin Activity audit logs (deploys, IAM, config changes), not caller/request logs. So the
true, provable evidence window for "did anyone call this" is **~30 days**, and that is the number
recorded in `docs/cf-invocation-census.json` and this ADR. A future retirement citing "90-day"
evidence from this logging setup is citing a window that does not exist unless a log sink with
longer retention has since been added — check before trusting it.

**Control validation, so the zero counts are trusted rather than assumed:** the same query shape
was run against `posCompleteCheckout` (a known-busy live checkout function) over the same window
and returned 122 entries. The logging pipeline surfaces real traffic when it exists; the zero
counts for both purchase-order functions are not an artifact of an empty or broken query.

Full methodology, raw counts, and the control query are in `docs/cf-invocation-census.json`.

### What changed

- `functions/index.js` — the `exports.posSendPurchaseOrder = posRetail.sendPurchaseOrder;` line is
  removed and replaced with a dated retirement comment citing this ADR. The sibling exports
  (`posSyncToMarketplace`, `sendPOSReceipt`, `posLowStockAlert`, `posMarketplaceOrderSync`) are
  untouched. The canonical `exports.sendPurchaseOrder = procurement.sendPurchaseOrder;` wiring
  (a separate line, further down the file, under "Procurement Engine v1.0") is untouched.
- `functions/pos-retail.js` — the `sendPurchaseOrder` function body is removed and replaced with a
  dated retirement comment; the implementation remains in git history. The module's top-of-file
  header comment is updated from 5 functions to 4.
- `functions/index.js` top-level export count: **1509 → 1508**.
- Verified with `scripts/test-retire-18b.js` — every static check is paired with a synthetic-fixture
  self-check proving the detector actually flags the pattern it claims to catch, not just that it
  passes today.

### What this does NOT decide

- **`procurement.sendPurchaseOrder`'s own zero production traffic is not addressed here.** It has
  real callers wired in the product; whether the procurement flow itself is actually reachable
  end-to-end from the merchant UI, gated behind a flag, or simply unexercised so far, is a separate
  investigation. Do not retire it on the strength of this ADR.
- **This does not certify `functions/procurement.js` as production-proven.** Zero invocations in
  the observable window means "not observed calling," not "working" and not "broken."

---

## 18c — specified, not built

Two further legacy-graph candidates surfaced during this audit and are explicitly **out of scope**
for 18b — neither has the Cloud-Logging invocation evidence pass that 18b required before a
retirement decision:

- **`posPurchaseOrders`** — a real Firestore collection, not a Cloud Function export, so the
  invocation-log method used for 18b does not directly apply to it. It is written from
  `functions/pos-inventory-pro.js` (create/receive/update paths) and read back from
  `functions/pos-integrations-api.js`. Whether it currently carries live production traffic has
  **not** been measured in this pass — flagged here as blocking, not concluded.
- **`posBatches`** — the same shape: written by `functions/pos-inventory-pro.js`, read by
  `functions/pos-bi.js` and `functions/pos-intelligence.js` (BI/forecasting surfaces). The reader
  call graph has not been walked end-to-end.

Retiring either writer without first tracing every reader risks a silent-divergence defect of
exactly the shape this project has hit before (see `project_posretailsales_field_divergence` in the
standing project memory) — a producer removed while a consumer still reads stale data with no
error. 18c requires that full reader trace, done with the same rigor as 18b's caller-and-logging
evidence, before any code change. **No deployment authorized as part of this ADR** — 18b is a
functions-source change only; it has not been deployed.

---

## What this ADR forbids

- **No retiring an endpoint on production-traffic count alone.** Zero traffic plus real code
  callers is a lifecycle-use question for the product owner, not a retirement.
- **No citing a "90-day" evidence window from this project's Cloud Logging setup** without first
  re-verifying `_Default` bucket retention — it was 30 days at the time of this ADR.
- **No retiring `procurement.sendPurchaseOrder`** on the strength of this ADR. It survives 18b
  specifically and requires its own evidence pass if it is ever reconsidered.
- **No retiring `posPurchaseOrders` or its `posBatches` readers (18c)** before the reader call
  graph is traced. Live-traffic writers and unaudited readers are not retirement candidates.
- **No treating "zero code callers" as provable from a single grep pass on a fast-moving repo
  without also checking the logging evidence**, and vice versa — this ADR's method requires both
  axes to agree before retiring anything.

## Related

[[ADR-008-evidence-before-change]] · [[ADR-013-pos-write-authority]] ·
`docs/cf-invocation-census.json` · `scripts/test-retire-18b.js`

**Evidence pinning this ADR:** `docs/cf-invocation-census.json` (generated 2026-09-03, commit
`fa5082bc0cc1f541edba9b28950f3ca28fd4e6a6`). If the observable logging window or bucket retention
changes, or `functions/index.js`'s export wiring changes, refresh the census before relying on this
ADR.
