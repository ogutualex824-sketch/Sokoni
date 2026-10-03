# Slice B2 — WhatsApp only for OTP, invoices and marketing; everything else in SOKONI

**Status:** built, certified (static + browser rows), **NOT deployed**. Hosting only.
**Branch:** `hosting/slice-b2-on-chain` @ `C:/temp/sok-b2`, built on `hosting/chain-on-3e8dd53` @ `54b72cc` (owner of the
chain: sokoni-aa). Deploys **after** the chain, rebased onto its post-deploy tip.
Related: [[SLICE_B_SUPPORT_WHATSAPP_CERTIFICATION]] · [[Support]] · [[Messaging]] · [[Refunds]] · [[Bookings]]

## Owner decision (2026-09-30)

> "no WhatsApp book gate — all communications and bookings happen within SOKONI and a refund system must be in place
> … all was built, just implement everything in app … we only use WhatsApp for OTP and invoices and marketing."

WhatsApp has exactly **three** permitted uses. Every other `wa.me` / `api.whatsapp.com` link was a hand-off that took
the booking, the conversation or the money outside SOKONI — no record, no audit, no moderation.

| Permitted | Meaning | Marker |
|---|---|---|
| `otp` | sending a one-time code | `wa-allowed:otp` |
| `invoice` | an invoice / receipt / statement / purchase order sent to its recipient (POS receipts, rent/water/service-charge invoices, booking invoices) | `wa-allowed:invoice` |
| `marketing` | a share with **no recipient chosen** (`wa.me/?text=`), referral/group invites the user addresses themselves, campaigns, the brand's SEO `sameAs` profile | `wa-allowed:marketing` |

Every remaining line carries its marker **on the same line** (`/* wa-allowed:<class> */` in JS, `data-wa-allowed="<class>"`
in markup). `scripts/test-slice-b-support-whatsapp.js` W12/W13 enforce it over every tracked client file.

## What replaced the hand-offs — existing pieces only

| Hand-off class | In-app path | Authority |
|---|---|---|
| SOKONI's support/admin/legal numbers (footers, help, contact, chatbot, checkout, policies) | `support.html?topic=&ref=&desc=` | `SokoniSupportContact` → `adminOsDispatch {op:adminCreateSupportTicket}` → `supportTickets` (Slice B) |
| A counterparty on an existing **order / booking / parcel / consultation** | `chat.html?tx=<type>&txId=<id>` (**new entry point**) | `messagesDispatch.createConversation` — parties derived from the transaction; non-parties refused |
| A provider/professional **before** any transaction | `provider-profile.html?uid=` (in-app booking), the page's own booking/enquiry modal, or the shop/product page | `SokoniBookService`, hub booking modals |
| Registrations, applications, quotes, SOS, "respond", commission payment | drop the hop where a Firestore record is already written; otherwise a prefilled support ticket (`topic=request|quote|sos|payment|hire`) | `supportTickets` |
| Admin/merchant → user notices | removed (server notifications stay where they exist); `tel:` kept | — |

### `chat.html?tx=<type>&txId=<id>` (new, ~30 lines)

Types accepted = exactly the server's `PARTY_FIELDS` keys (`order, service_booking, food_order, legal_consultation,
logistics_request, support_ticket, property_inquiry, job_application`) — W14 asserts equality with
`functions/messages.js`, which is **byte-identical to the live `messagesDispatch` archive** (gen 1787384541218290).
`txId` must match `^[A-Za-z0-9_-]{1,128}$`. The page shows nothing until the server returns the conversation id, then
replaces the URL with `chat.html?id=`. A refusal says so and returns to Messages. Callers used it only where the id was
verified to be a document id in the mapped collection (`orders`, `bookings`, `packageRequests`).

## Refunds

**My Orders** (`my-orders.html`) gains two in-app actions per server order (`_fsId` only — a cache-only order has no
server record):

- **💬 Message seller** → `chat.html?tx=order&txId=` (not on cancelled orders).
- **↩ Request refund** → `support.html?topic=payment&ref=<orderId>` — a support ticket a person reviews in AdminOS.
  Only for paid → completed states. The button never moves money and never claims a refund happened.

Refund/returns policy pages and the dispute portal point at `dispute-portal.html` / `support.html?topic=payment`.

### Why not the dispute portal from My Orders — FINDING, owner decision required

1. **Live `createDispute` refuses every checkout order.** It accepts the caller as buyer only via
   `buyerId|userId|customerId`; `checkout.html` writes `uid` + `buyerUid`. Verified: live archive == chain.
2. **Widening it would switch on unapproved automatic refunds.** `autoOnDisputeCreate` auto-resolves **buyer_wins** for
   disputes ≤ `autoResolveBelow || 1000` KES with a paid payment, feeding `refundRequests`, whose `autoOnRefundRequest`
   **credits the wallet on create**. That contradicts the owner rule *refund = request, owner/manager approves*.
3. The canonical request/approve authority (B9.31 `refundRequestCases`, cannot move money) is built on
   `slice/realtime-control-plane` and **not deployed**; B9.32 fee policy is unsettled.

W19 forbids any client write to `refundRequests`.

## Enumerated and deliberately NOT changed

- `index.html` footer WhatsApp links — converted by sokoni-70's hosting candidate (deploys first); named in W12's
  `PEER_OWNED` until the rebase.
- `opportunity.html` `applyNow()` — claimed by sokoni-27's in-app application slice; named in `PEER_OWNED`.
- `bookNow` and its malformed callers (construction, healthcare) — separate contract repair (Slice B).
- Non-link copy mentioning WhatsApp (form labels, `storeWhatsApp` inputs, the RFQ "WhatsApp me a quote" option,
  legal-hub "notified via WhatsApp" promise) — copy follow-up.

## Findings recorded during B2 (not fixed here — each its own slice)

| # | Finding | Where |
|---|---|---|
| F1 | createDispute buyer-field mismatch + ≤1000 auto-refund (above) | functions/disputes.js, automation-engine.js |
| F2 | Landlord invoices tell tenants to pay the landlord's **personal M-Pesa** (6 paths) — conflicts with IntaSend-only | landlord.html `sendWaterBillWA`, `sendRentInvoiceWA`, `_buildInvoiceText`, service charges |
| F3 | Raw tenant fields interpolated into HTML / inline handlers (XSS) | landlord.html (worst: service-charge send) |
| F4 | product.js in-app contact modal writes `contactRequests` without `buyerUid` → rules deny every submit | product.js |
| F5 | Success copy before/without a server write: hub `_*FireWrite` helpers swallow errors; car-hub "SOS ALERT SENT", roadside "Dispatched! ETA"; business-os "broadcast to N"; landlord "sent via WhatsApp" | car-hub, sokoni-carhub-pro, business-os, landlord |
| F6 | Admin approvals for lawyer / law firm / healthcare facility / property no longer message the applicant and have no server notification | admin.html |
| F7 | `home-services` provider registration writes no `uid` (rules require it) | home-services.html |
| F8 | services.html bookings are localStorage `BK…` ids, never linked to their Firestore doc — no in-app thread possible | services.html |
| F9 | food-rider "Call Customer" is a hard-coded placeholder number | food-rider.html |
| F10 | pos-ios-print-test.html inline script already unparseable (sw-register injected into a JS string) | pos-ios-print-test.html |

## Closure repair set (owner 2026-10-01) — on top of the frozen reference `63dc9b0`

Owner decisions: refunds stay **ticket → human review** (no auto wallet refund, B9.31 not deployed yet); **rent is the
landlord's/agency's money** — SOKONI earns from the Property Hub subscription, not rent; notifications may say *sent*
only when a transport accepted the message; `index.html` footer + `opportunity.html` stay with their owning agents.

| Finding | Resolution | Proof |
|---|---|---|
| F1 refund authority | Unchanged by decision: Request refund = support ticket with order reference + reason; no money path | `test-b2-inapp-e2e.js` R0–R4 on the emulator with the REAL adminOsDispatch: ticket written, `refundRequests`/`walletTransactions`/`wallets` untouched, balance unchanged |
| F2 landlord payments | **Rent is external.** The browser payment paths are retired: Daraja `SokoniMpesa.pay`, the IntaSend inline SDK (+ `sokoni-mpesa.js`, unpkg SDK tag) and the **3-second fake "Payment Confirmed"**. Replaced by **Record rent received** → `paymentSource: EXTERNAL`, `verification: LANDLORD_RECORDED`, channel + sanitised reference; never labelled SOKONI-verified. Every payment instruction states *paid directly to the landlord/agency — not processed or verified by SOKONI*. The hidden browser-side **2% "commission on rent" → SOKONI ledger** hook is removed (rent is never SOKONI revenue). Invoice WhatsApp sends keep `wa-allowed:invoice`. | `test-landlord-external-rent.js` 19/0 |
| F3 landlord XSS | Every tenant/landlord/property value escaped with the page's `_esc`; inline handlers take only `_jsId`-validated ids (the service-charge IIFE that spliced raw tenant data into JS is now `sendServiceChargeWA(id)`); tel: digits-only | parse 3/3; enumerated in the repair commit |
| F4 contact seller | `buildContactRequest` (pure): signed-in only, `buyerUid`, `sellerUid` from the Firestore product doc (not cache), own-product refused, message capped → passes the SERVED rule. Premium and non-premium sellers use the same request (the store.html bounce loop is gone). **Seller Enquiries** sheet in merchant-v2 (Dashboard → 💬 Buyer enquiries): list, Call, Mark responded (`status`/`respondedAt` only). store.html chip → "Ask about a product". | `test-contact-requests.js` 48/0 |
| F5 false success | Hub write helpers resolve true only when the Firestore write resolves; "recorded on SOKONI" shown only then (Saving… / honest failure + Support link otherwise). car-hub SOS no longer claims "alert sent"; roadside no longer "Dispatched! ETA" (stored status `pending`, invented ETA removed); theft mode no longer "authorities alerted"; tracker test no longer fabricates signal; business-os broadcast copy honest; landlord "sent via WhatsApp" → "WhatsApp opened — tap Send". | parse checks; manual list in the repair commit |
| F6 approval notices | Lawyer / firm / healthcare facility approve **and reject** → live `applicationDecide` (healthcare now from the server applications record; local-only items cannot be approved). Property → live `notifySend` to the host. One status function renders **Notified** only for a channel exactly `'sent'`; otherwise *Notification pending* / *Delivery failed*. Also fixed: property ✅/❌ acted on the wrong listing under a filter; error toasts vanished at 0 ms. | `test-admin-approval-notify.js` 50/0 |
| Security sabotage | 13 mutations across the five suites (chat type widening, id validation, hostile id, refund→money route, unmarked wa.me, WhatsApp support link, fake confirmation, SOKONI-verified rent, channel check, rent commission, missing buyerUid, queued-as-sent, WhatsApp order chase) | **13/13 CAUGHT**, byte-identical restore |

**Server gaps handed to their owners (no functions change in this slice):** `applyDecision` drops the `notify()` result and
never notifies rejections (sokoni-27, next lifecycle slice after K13); `notifySend` checks `users.roles`, not the admin
claim; no trigger notifies a seller of a new `contactRequests` doc; `(sellerUid, createdAt)` index absent (Enquiries
sorts client-side, cap 200); rules do not bind `contactRequests.sellerUid` to the product doc.

**Property Hub subscription programme** (owner 2026-10-01) is a separate slice: census first — existing subscription
authority, `property_agent` plan + entitlement resolver, landlord collections, AdminOS property operations — then
subscription-first monetisation with rent kept as a separate financial domain.

## Certification

`node scripts/test-slice-b-support-whatsapp.js --static` → **32/0** (S1–S6, W1–W19, N1–N3, B1–B4 in Chromium with every
non-local origin aborted). Emulator rows R1–R4 exercise the Slice B server path, which B2 does not touch.
`scripts/predeploy-syntax-gate.js` → 1823 JS files + 455 inline blocks parse. Parent-vs-candidate regression over every
suite that reads a changed file: see CHANGELOG entry.
