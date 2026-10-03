# AdminOS Orders — redesign to the owner's reference layout

**Status:** built on `hosting/aos-orders-redesign-on-28a3998`. Hosting only. **NOT deployed.**
**Owner request (2026-10-04):** "same for orders". Apply the [[Platform Health]] reference design to Marketplace → Orders.
**Related:** [[Orders]] · [[Payments]] · [[AdminOS]] · `docs/PLATFORM_HEALTH_HISTORY.md`

## Where it lives

- `sokoni-aos-orders.js` is a self-contained view module (`window.SokoniAOSOrders`). It has a scoped
  stylesheet (`.aoo-*`).
- It is mounted by `sokoni-aos.js` `_marketplaceTab('orders')` into `#mktBody`.
- Every Marketplace tab change calls `SokoniAOSOrders.unmount()`, so a late response cannot paint over
  another tab.
- Navigation is unchanged. Sidebar: Marketplace → Orders. Tab bar: Orders.

## Server contract (from the SERVING code)

Serving code checked:
- `adminOsDispatch`: traffic 100% → `adminosdispatch-00025-muh`, source generation `1788271885523075` (2026-09-09).
- `getOrderTrends`: → `getordertrends-00015-yuw`, generation `1787384443385861`.

The serving `admin-os.js` orders block is identical to this tree.

| Op | Gate | Returns | Used for |
|---|---|---|---|
| `adminGetOrders` (dispatch) | `admin` \|\| `superAdmin`, App Check | `{orders:[{id,...doc,createdAt:ISO}]}`. Limit ≤200. No total, counts or cursor | table, drawer |
| `adminGetExecutiveDashboard` (dispatch) | same | `totalOrders`, `activeOrders` (count of pending, processing, confirmed). **Each count is `.catch(()=>0)`** | KPI Total orders, KPI Active orders |
| `adminGetFinance` (dispatch) | same | `reconciliation.productRevenue`, window `30d`, at most 3,000 orders | KPI Gross revenue |
| `getOrderTrends` | `admin-claim.isAdmin` | `trends:[{date,orders,gmv,failed}]`, at most 2,000 orders | Total orders sparkline (`orders` only) |
| `adminUpdateOrderStatus` (dispatch) | same | `{success}`; the server writes `adminAudit` | drawer "Update status" (existing action, kept) |

## Mapping decisions (UI Data Integrity)

**KPIs**
- Total orders: server `count()`.
- Gross revenue: server 30-day product GMV.
- Active orders: the reference called this "Pending fulfilment". It is renamed because the server counts
  pending, processing and confirmed. Paid orders are not in that count.
- Average order value and Orders shipped show `—` with a reason. No server field exists for either.
- A server `0` is shown as **unconfirmed**, because the server turns a failed count into 0.

**Deltas, sparklines and counts**
- No deltas: no server comparison exists.
- One sparkline only: daily orders from `getOrderTrends`. It is **withheld** when the series sums to the
  server's 2,000 cap.
- Tab counts: none. The server returns none.

**Filters**
- Status tabs only. Each tab is an exact server equality value.
- Date, channel, carrier and payment-method filters are omitted. `hubType` is filtered in memory after the
  limit, so it would only ever filter a partial page.

**Pagination**
- The table pages through the rows it has loaded: "Showing a to b of N loaded".
- "Load more" asks the server again with a larger limit, in steps of 50 up to the server's cap of 200, and
  says when the cap is reached.
- No cursor exists.

**Drawer**
- Shows order-document fields only. Unknown fields show `—`.
- Amounts are labelled "as recorded at checkout", because the buyer's client writes them.
- "Payment verified on…" appears only when `paymentVerified === true` and `paidAt` is set. Clients cannot
  write either field.
- Method is shown "as recorded". The webhook records `mpesa` for everything until 5b `73c5e5e` deploys.
- There is no "Signed by" row: proof of delivery is stored on trips, not orders.
- "Open tracking page" (`track.html?order=`) appears only when delivery fields exist.
- "View profile" uses the existing AdminOS `viewUser` (`adminGetUser`).
- The customer chip shows initials only, and only when the server returns a name.

## Omitted, and why

- **Create Order, Duplicate Order:** admin order creation is not a canonical flow.
- **Export:** no order export service is live. The live exports are POS, FOS, subscriptions, audit and DSAR.
- **Request Refund:** no live request-for-approval operation exists for admins.
  - `refundRequestCases` (B9.31) is not on this line and not deployed.
  - `refundRequests` **credits a wallet on create** (`autoOnRefundRequest`), so no UI writes it.
  - The drawer says so.
- **Resend Receipt:** `transactionReceipts` (2f) is not deployed. `emailTrustReceipt` sends a `posReceipts`
  receipt to any recipient. `resendEmail` needs an `emailLogs` id and the claims `isAdmin`/`isSuperAdmin`,
  which are never set.
- **Row select / bulk menu:** no bulk operations exist.

## Server gaps (owners: functions)

1. `adminGetOrders` has no cursor, no total and no per-status counts.
   - The status filter needs a composite index (status ASC, createdAt DESC). The repo has only (status ASC,
     createdAt ASC); the deployed index state was not checked.
   - Documents without `createdAt` are never returned.
2. Executive-dashboard counts and finance sums turn read failures into `0`.
3. `getOrderTrends.gmv` sums `amount`, but marketplace orders write `total`. Its `.limit(2000)` has no
   orderBy, so truncation drops arbitrary days.
4. There is no server average order value and no shipped count.
5. `adminUpdateOrderStatus` accepts any status string. The UI offers only the rules vocabulary.

## Tests

`scripts/test-aos-orders.js` passes 80 rows with 0 failures. It runs in a VM with fake callables shaped
from the serving code. It has three negative controls:
- (a) a page-sum revenue KPI;
- (b) a refund button that writes `refundRequests`;
- (c) client-side status filtering.

## Security and performance

- Every server string is escaped.
- The module makes no Firestore access. It calls only the five operations above.
- Actions require a confirm. The server's refusal is shown verbatim. A success toast appears only after the
  server resolves.
- `adminGetFinance` reads up to about 15k documents. The KPI answers are cached in memory for 5 minutes
  across mounts, and errors are not cached.
