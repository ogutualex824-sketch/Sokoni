# AdminOS Orders — server contract (adminOsDispatch)

**Status:** BUILT, NOT DEPLOYED (2026-10-04). Branch `feat/admin-orders-summary-on-18cfe7f`.
**Base:** `18cfe7f`. Its whole `functions/` tree is byte-identical to the serving archive of
`adminosdispatch-00025-muh` (source generation `1788271885523075`, 321/321 files). The branch also
carries `2de50e0`, the adminUpdateOrderStatus transition authority, which was built 10-03 on the same
base and has not been deployed. It is reused here, not rewritten.
**Related:** [[ADMINOS_ORDERS_REDESIGN]] (hosting page) · [[ADMINOS_CONVERGENCE_REPORT]] · [[Orders]] · [[Payments]] · [[Authentication]]

The semantics come from the Orders census (2026-10-04, §A). The owner accepted every default, O-1 to O-13.

## Ground rules

* **Dataset:** `orders/{id}` only. Mirrors (`clickAndCollect`, `posReceipts`, `packageRequests`, `paymentIntents`, bookings, `foodOrders`, POS) are never counted.
* **Paid:** `paymentVerified === true` (PV), the only server-only paid flag. `status`, `paymentStatus` and `paid` are client-writable or seller-writable, so they never count as paid.
* **Money:** `paidAmount` is the amount the provider confirmed, in KES. A pre-written `total` is **buyer-written** and is never revenue.
* **No fabricated zero:** every figure comes from a successful aggregate. When the aggregate fails, the figure is `null` and `errors[<field>]` holds the reason (a gRPC status name, never internals). A real `0` from a successful aggregate is still returned as `0`.

## `adminOrdersSummary` (dispatcher op only, with no standalone function)

Gate: `admin || superAdmin`, checked before any read, returning `permission-denied`. App Check comes from `adminOsDispatch`. The op takes no parameters, and any key other than `op` is refused with `invalid-argument`.

```json
{
  "asOf": "2026-10-04T05:30:00.000Z",
  "currency": "KES",
  "buckets": {
    "total": 10, "placed": 8,
    "awaitingPayment": 2, "paidStatusUnverified": 0, "outstanding": 2,
    "acceptedProcessing": 8, "paidNotYetAccepted": 1,
    "completed": 0, "cancelled": 0, "cancelledRefundDue": 0,
    "refundedLabelled": 0, "other": 0
  },
  "revenue": { "kes": 9999.5, "pricedCount": 7, "unpricedCount": 1, "basis": "…" },
  "scope": { "collection": "orders", "kind": "product", "rule": "kind ∈ {undefined, null, 'product'}", "foreignKindCount": 0 },
  "mapping": { "<bucket>": ["<predicate>", "<status>", "…"] },
  "errors": { "<bucket|revenue|revenueFallback|revenuePricedCount>": "UNREADABLE: status==cancelled:FAILED_PRECONDITION" }
}
```

### Status → bucket mapping

| Bucket | Rule | Statuses |
|---|---|---|
| total | every scoped doc (O-1) | — |
| placed | PV (headline) | — |
| awaitingPayment | !PV and status ∈ | pending_payment, pending, draft, awaiting_payment_attestation, payment_failed |
| paidStatusUnverified | !PV and status == paid (O-6, flagged) | paid |
| **outstanding** (Pending / unpaid tab) | !PV and not cancelled/refunded ⊇ the two above | any |
| acceptedProcessing | PV and status ∈ | paid, awaiting_confirmation, confirmed, processing, accepted, preparing, ready, packing, ready_for_pickup, awaiting_rider, rider_assigned, driver_assigned, assigned, rider_en_route, picked_up, in_transit, shipped, out_for_delivery, **delivered** (O-7), fulfilled |
| paidNotYetAccepted | ⊂ acceptedProcessing, PV and status ∈ | paid, awaiting_confirmation |
| completed | PV and status == completed (O-7) | completed |
| cancelled | status ∈ | cancelled, canceled |
| cancelledRefundDue | PV and status ∈ (O-3) | cancelled, canceled |
| refundedLabelled | status == refunded (label only, not netted, O-5) | refunded |
| other | PV and status not mapped above | — |

`total = outstanding + cancelled + refundedLabelled + acceptedProcessing + completed + other` holds exactly.
The live statuses on 2026-10-04 map as the owner specified: `pending_payment` goes to awaitingPayment ⊂ outstanding, and `paid`, `confirmed`, `in_transit` and `delivered` go to acceptedProcessing.

**Known limit:** the `refunded: true` flag is not counted, because the census found no live writer for it.

### Revenue (O-4)

`kes` = `sum('paidAmount')` over PV, plus the server-written `total` of server-created orders. These are VIP orders: PV, a non-empty `sessionId`, and no numeric `paidAmount`. They are read in a bounded query of at most 500 docs, and above that cap the fallback is withheld with a reason. Every status is included and refunds are not netted.

`pricedCount` = the number of PV docs with a numeric `paidAmount`. It is derived as `sum / average` from the same aggregate, because an "exists" filter needs an index. If `average == 0` the count cannot be determined, so it is returned as `null` with a reason. `unpricedCount = placed − pricedCount`, and the UI renders it as "—".

### Scope (O-2)

Foreign kinds = `count(orderBy kind) − count(kind=='product') − count(kind==null)`. If this is above 0, or cannot be read, **every** figure is withheld with `SCOPE_FOREIGN_KIND` or `SCOPE_UNREADABLE`, because excluding those docs per bucket would need composite indexes. No live writer sets `kind` today. The booking-PIN and manual-till lines must write `kind` before they ship.

### Cost

Each call runs 43 aggregation queries: total; the PV aggregate (count, sum and average); 3 scope counts; 9 `status==` counts; and 29 `PV && status==` counts. Each is billed at least 1 read, plus 1 per 1,000 index entries. The bounded fallback read adds up to 500 reads. Only equality filters are used, plus single-field `orderBy` and range filters, so **no new index** is needed. Multi-status buckets run one count per status and add the results. Different counts can see slightly different moments of the database, and a negative difference returns `null` with `INCONSISTENT_SNAPSHOT`.

## `adminGetOrders`

* **Input:** `{ status?, limit? (1..200, default 50, >200 clamped), cursor? }`.
* **Output:** `{ orders, nextCursor, scope }`.
* **Back-compat:** callers that send no cursor get the first page, and `orders` keeps the same shape (`createdAt` as ISO).
* **Ordering:** `createdAt desc, __name__ desc`. The query uses `startAfter(<cursor doc snapshot>)`, which keeps full timestamp precision and orders ties by id. The query fetches `limit+1` docs, so `nextCursor` is set only when another page exists. If the cursor's order has been deleted, the op returns `failed-precondition` `CURSOR_STALE`.
* **Status filter:** checked against the canonical vocabulary, with `invalid-argument` for unknown values. It **needs the composite index `orders (status ASC, createdAt DESC)`, which is MISSING in production** (confirmed 2026-10-04). Until the index exists, the op returns `failed-precondition` with `details.reason = 'INDEX_REQUIRED'` and the index named. The unfiltered list works without it.
* **hubType: removed.** It was filtered in memory after the limit, so it returned a partial page that looked complete, and no live writer sets `hubType`. A caller that sends it gets `invalid-argument`.
* **Other read failures:** these return `unavailable`, never an empty list.
* **Known limit:** orders that have no `createdAt` are not listed, although the summary counts them. Production showed a gap of 0 on 2026-10-04.

## `adminUpdateOrderStatus`

These rules come from the 2de50e0 transition authority, plus the 10-04 changes:

* **O-13:** the status must be in the canonical vocabulary. Otherwise the op returns `invalid-argument` with `details.allowed`, which is the list an administrator may set. This check runs before the order is read, and the refusal is audited.
* **`paid`:** refused with `PAYMENT_AUTHORITY_ONLY`. Only the webhook and verifyIntasendPayment write it.
* **`refunded`:** refused with `REFUND_AUTHORITY_ONLY`, **even when refund evidence exists** (changed 10-04). Only the refund authority, request → approve, writes it.
* **Paid check:** paid means `paymentVerified === true` only (changed 10-04). `paymentStatus` and `paid` are buyer-writable, so they no longer unlock fulfilment or completion.
* **Statuses owned elsewhere:** a known status that another authority writes returns `NOT_ADMIN_SETTABLE`.
* **Error codes:** malformed input returns `invalid-argument` and a non-admin gets `permission-denied`.
* **Audit:** unchanged (`order_status_updated` and `order_status_refused`).

## Fail-to-0 removed

| Op | Field(s) | Before | Now |
|---|---|---|---|
| adminGetExecutiveDashboard | ordersToday, activeOrders, activeDeliveries, totalOrders | `.catch → count 0` | `null` + `errors[field]` |
| adminGetFinance | reconciliation.productRevenue, grossRevenue, refunds, netPlatformRevenue; capped.orders | `.catch → docs []` (KES 0) | `null` + `errors.orders` |

`activeOrders` keeps its legacy definition (`pending|processing|confirmed`, O-8). It must not appear on the Orders page.

The other catch-to-0 reads in these two ops are still there: users, tickets and payments, among others. They are recorded as a separate defect.

## Hosting callers that must change (not edited here)

| File (live hosting line) | Change |
|---|---|
| `sokoni-aos-orders.js` | KPIs come from `adminOrdersSummary` (with "—" when a value is null and the reason shown). The list uses `nextCursor` paging. Tab counts come from buckets. Remove `refunded` and `pending` from `STATUS_CHOICES`. Show the `INDEX_REQUIRED` message for status tabs until the index ships. |
| `admin.html` (Overview `_ccKpi(... d.totalOrders\|\|0 ...)`, `d.activeDeliveries\|\|0`) | Render `null` as "—", not `\|\|0`. |
| `sokoni-aos.js` (Command Center, from `adminGetExecutiveDashboard`) | Any order field that is `null` renders "—". Read `errors`. |
| `admin-os.html` / `sokoni-aos.js` finance panes (`reconciliation.productRevenue`, `grossRevenue`, `netPlatformRevenue`) | `null` renders "—". |
| `admin-api.js` `orders()` | Already passes data through. No hubType caller exists. |

## Deploy (owner decision; not done)

1. **Index first, on its own:** `orders (status ASC, createdAt DESC)`. Do **not** run `firebase deploy --only firestore:indexes` from this tree. Its `firestore.indexes.json` is the 18cfe7f vintage and is not a full mirror of production. Create the single index (for example `gcloud firestore indexes composite create --collection-group=orders --field-config=field-path=status,order=ascending --field-config=field-path=createdAt,order=descending`). After that, wait for READY.
2. **Function:** `firebase deploy --only functions:adminOsDispatch`, run from this branch. Before deploying, re-download the serving archive and re-check it against `18cfe7f`. The merchant-identity provenance gap note and the predeploy hook rules apply.
3. **Hosting:** ship the callers above together with step 2, or after it. Do not ship them before it.

## Tests

* `scripts/test-admin-orders-summary.js`: 63/0. This is the owner matrix.
* `scripts/test-admin-order-status-authority.js`: 21/0. It was ported to the hermetic harness, with A-16 inverted and A-20 added.
* `scripts/sabotage-admin-orders-summary.js`: 9/9, including breaks (a) authz, (b) non-PV revenue, (c) fail→0, (d) accepts paid. Sabotage runs on a temporary copy, never on admin-os.js in place.
* `scripts/sabotage-admin-order-status-authority.js`: 10/10.

All four run hermetically through `scripts/lib/aos-harness.js` and the extended `scripts/lib/fake-firestore.js`, under `block-admin.js` and `block-browser.js`.
