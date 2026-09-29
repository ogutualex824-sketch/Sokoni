# Disputes and Reports — who writes, who reads

**Status:** implemented on `slice/c4-category-matrix` on 2026-09-29. **Not deployed.**

Related: [[SHOP_AVAILABILITY_AUTHORITY]], [[Orders]], [[Payments]], [[AdminOS]], [[Messages]]

---

## Disputes (buyer ↔ seller about an order)

### The one authority: `functions/disputes.js`

- A dispute's id is `dp_<orderId>`, so there is one dispute per order.
- The buyer must own the order. The seller (`sellerId`) is taken from the order and never supplied by the client.
- `description`, `evidence[]` and `timeline[]` form the case record that both parties and SOKONI read.

**Statuses:**

| Group | Statuses |
|---|---|
| Open (either party can act) | `open`, `investigating`, `seller_responded`, `under_review` (legacy, see below) |
| Final | `resolved`, `closed` |

`under_review` is **legacy**. Until 2026-09-29, `automation-engine.autoOnDisputeCreate` wrote it onto **every** new dispute. Because it was in no open list, this happened:
- the seller could not respond;
- neither party could add evidence;
- the buyer could not withdraw;
- AdminOS, which listed only `open`, showed an empty queue.

The trigger now only marks itself processed. When its rule is enabled, it moves an `open` dispute to `investigating`. Existing `under_review` disputes are honoured as open, so **no data migration is needed**.

### Who uses what

| Side | Surface | Calls |
|---|---|---|
| Buyer | `dispute-portal.html` (`dispute.html` routes here and carries `?order=`) | `createDispute`, `getMyDisputes`, `addDisputeEvidence`, `cancelDispute` |
| Seller | merchant-v2 › Disputes (`sokoni-merchant-disputes*.js`) | `getSellerDisputes`, `getDisputeDetail`, `sellerRespondToDispute`, `addDisputeEvidence` |
| Admin | AdminOS › Financial › Disputes; super-admin › Disputes | `adminOsDispatch` ops `adminGetDisputes`, `adminGetDisputeDetail`, `aosResolveDispute` |
| Admin (older page) | trust-safety.html | `adminGetAllDisputes`, `adminResolveDispute` |

All admin paths run the **same core** in `disputes.js`:
- **List:** includes the parties' names; filters are `active`, `final`, `all` or a single status.
- **Detail:** includes the timeline, evidence and the seller's response.
- **Resolve:** requires a note. Resolving also records the side it favours (`favorBuyer`), adds a timeline entry, syncs `orders.disputeStatus`, and writes to `adminAudit`.

The copies in `functions/admin-os.js` now delegate to this core. Before, they listed only `open`, swallowed query errors as an empty list, and stored "buyer" or "seller" as the resolution *text*.

`SokoniDispute` (in `sokoni-trust.js`) calls the same callables. It no longer writes Firestore directly.

## Reports (someone flags content)

| What | Store | Writer | Admin reader | Owner reader |
|---|---|---|---|---|
| Product, listing, user, business, message or review | `reports` | `tsReportContent` (product page Report button, `SokoniReport.submit`) | `tsGetReports` / `tsReviewReport` | **`tsGetReports({scope:'mine'})`**: the seller's own listings only |
| Conversation | `moderationQueue` | `reportConversation` (messagesDispatch) | messagesDispatch `adminGetReports` / `adminReviewReport` | — |
| Review flags | `reviews/{id}/flags` | `flagReview` | AdminOS › Reputation | — |

**The seller's view (`scope:'mine'`):**
- The server filters on the server-captured `context.sellerUid`.
- It returns the listing, the reason category, the status and, once a report is decided, the administrator's outcome note.
- It never returns the reporter or their free text.
- When an admin takes a product down, `productHidden: true` is recorded on the report, so the seller sees why.

### Admin surface: one module

`sokoni-trust-queues.js` is mounted by:
- `admin-os.html` (the Disputes tab and the Reports Queue);
- `super-admin.html` (the **Disputes** and **Trust reports** sections);
- the legacy `superadmin.html` console.

Every figure it shows comes from the callables above. A failed read shows an error, never an empty queue.

## Removed as dishonest

- **dispute.html:** the client-only form. It read orders from localStorage, invented a "DSP…" reference, showed "submitted" regardless of the outcome, and kept its history in localStorage.
- **unboxing.html:** the Report button, which said "Thank you for the report" and sent nothing. Those posts live in the browser's localStorage, so no one could review them.
- **superadmin.html:** the moderation table. It queried `status=='open'`, a value nothing writes, and resolved reports with a direct client write.

## Known limits (UNPROVEN or not done)

- **Firestore rules** for `disputes` still gate reads on `uid` / `buyerUid` / `sellerUid`, while the callables write `buyerId` / `sellerId`. Direct client reads therefore only work for moderators. This is harmless because every reader uses a callable. It is a stage 3 (rules) item.
- **Dispute text is HTML-escaped at write time** (`_san`), so an apostrophe shows as `&#x27;` in some readers. This is pre-existing.
- **Marketplace product cards** have no Report button. The product page has one.
- **`impact.js` and `analytics-engine.js`** query dispute fields that disputes do not have (`sellerUid`, `shopId`). This is not changed here.
- **Not deployed.** It needs the functions (`disputes`, `admin-os` via `adminOsDispatch`, `trust-safety`, `automation-engine`) plus hosting.
